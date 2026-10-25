import { nextRef } from '../db/client.js';
import type { Deps } from '../deps.js';
import { fail } from '../lib/errors.js';
import { naira } from '../lib/money.js';
import { dayLabel, isIsoDate, isoDay, lagosDateTime, minutesFrom } from '../lib/time.js';
import { cleanText } from '../lib/security.js';
import { upsertCustomer } from './customers.js';
import { emit, queueNotification } from './outbox.js';
import { earliestDay, heldQty, lockCapacityGroup, lockProduct, datesNear, slotsFree } from './products.js';
import { MAX_QTY } from './opportunities.js';

const MAX_LIVE_HOLDS_PER_CUSTOMER = 3;

const holdView = (r: any, name: string) => ({
  reservation_id: r.id,
  sku: r.sku,
  product: name,
  qty: r.qty,
  unit_price: naira(r.unit_price_kobo),
  expires_at: new Date(r.expires_at).toISOString(),
  expires_local: lagosDateTime(new Date(r.expires_at)),
  ...(r.for_date ? { for_date: isoDay(r.for_date), for_date_label: dayLabel(isoDay(r.for_date)!) } : {}),
  ...(r.notes ? { notes: r.notes } : {}),
});

/**
 * Hold stock for a customer for a limited time. Accepting a restock offer reuses the hold that was
 * created for them; otherwise availability is checked under a row lock so two customers can't take
 * the last unit. Made-to-order items hold a baking slot on `for_date` instead of a unit of stock.
 */
export async function reserveProduct(
  deps: Deps,
  input: {
    customer_ref: string;
    sku: string;
    qty?: number;
    display_name?: string;
    alternative_to_sku?: string;
    for_date?: string;
    notes?: string;
  },
) {
  const qty = input.qty ?? 1;
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) fail('invalid_qty', `qty must be 1–${MAX_QTY}. Larger orders go to the owner.`);
  const now = deps.now();
  const ref = input.customer_ref?.trim();

  return deps.sql.begin(async (tx) => {
    await upsertCustomer(tx, { ref, display_name: input.display_name });
    const p = await lockProduct(tx, input.sku);
    const madeToOrder = p.fulfilment === 'made_to_order';
    const forDate = madeToOrder ? (input.for_date ?? null) : null;
    if (forDate && !isIsoDate(forDate)) fail('invalid_date', 'Give the date as YYYY-MM-DD.');

    // 1. Accepting a restock offer: the unit is already held for them.
    const [offer] = await tx`
      select r.*, o.id as opp_id from opportunities o
      join reservations r on r.opportunity_id = o.id and r.status = 'HELD' and r.expires_at > ${now}
      where o.customer_ref = ${ref} and o.sku = ${p.sku} and o.status in ('OFFERED', 'CHECKOUT')
        and (${forDate}::date is null or o.for_date = ${forDate}::date)`;
    if (offer) {
      await tx`update opportunities set status = 'CHECKOUT', next_action = 'Customer to complete checkout and payment',
               next_action_owner = 'customer', next_action_due_at = ${offer.expires_at}, updated_at = ${now} where id = ${offer.opp_id}`;
      return { ...holdView(offer, p.name), accepted_offer: true, already_held: true };
    }

    // 2. Idempotent retry: same customer, same item, live hold.
    const [existing] = await tx`
      select * from reservations where customer_ref = ${ref} and sku = ${p.sku} and status = 'HELD'
      and expires_at > ${now} and for_date is not distinct from ${forDate}::date order by created_at desc limit 1`;
    if (existing) return { ...holdView(existing, p.name), already_held: true };

    if (p.status !== 'ACTIVE') fail('discontinued', `${p.name} is discontinued.`);
    // Hold-griefing guard: one person can't tie up the shop's stock across many items.
    const [{ live }] =
      await tx`select count(*)::int as live from reservations where customer_ref = ${ref} and status = 'HELD' and expires_at > ${now} and kind = 'customer'`;
    if (live >= MAX_LIVE_HOLDS_PER_CUSTOMER) fail('too_many_holds', 'This customer already has items held. Finish or release those first.');
    if (madeToOrder) {
      if (!forDate) fail('date_required', `${p.name} is made to order. Ask which date they need and call check_dates first.`);
      const earliest = earliestDay(p, now);
      if (forDate! < earliest) {
        fail('too_soon', `${p.name} needs ${p.lead_time_days} day(s) notice; the earliest is ${dayLabel(earliest)}.`, {
          earliest_date: earliest,
        });
      }
      await lockCapacityGroup(tx, p.capacity_group!);
      const free = await slotsFree(tx, p.capacity_group!, forDate!, now);
      if (free < qty) {
        fail('date_full', `${dayLabel(forDate!)} is fully booked for ${p.name}.`, {
          available_dates: await datesNear(tx, p, now, forDate!, { qty }),
        });
      }
    } else {
      const available = p.qty_on_hand - (await heldQty(tx, p.sku, now));
      if (available < qty) {
        fail('insufficient_stock', `Only ${Math.max(0, available)} of ${p.name} available right now.`, {
          available: Math.max(0, available),
          requested: qty,
        });
      }
    }

    // Link to the opportunity this purchase settles, so recovered sales are counted.
    let oppId: string | null = null;
    if (input.alternative_to_sku) {
      const orig = await lockProduct(tx, input.alternative_to_sku);
      const [o] = await tx`
        update opportunities set status = 'CHECKOUT', alternative_sku = ${p.sku}, next_action = 'Customer to complete checkout and payment',
               next_action_owner = 'customer', updated_at = ${now}
        where customer_ref = ${ref} and sku = ${orig.sku} and status in ('WAITING_RESTOCK', 'CHECKOUT')
        returning id`;
      if (o) oppId = o.id;
      else {
        oppId = await nextRef(tx, 'OPP');
        await tx`insert into opportunities (id, customer_ref, sku, qty, status, consent, alternative_sku, next_action, next_action_owner)
                 values (${oppId}, ${ref}, ${orig.sku}, ${qty}, 'CHECKOUT', false, ${p.sku}, 'Customer to complete checkout and payment', 'customer')`;
      }
    } else {
      // A waiting customer who comes back after a restock but before being offered.
      const [o] = await tx`
        update opportunities set status = 'CHECKOUT', next_action = 'Customer to complete checkout and payment',
               next_action_owner = 'customer', updated_at = ${now}
        where customer_ref = ${ref} and sku = ${p.sku} and status = 'WAITING_RESTOCK'
          and for_date is not distinct from ${forDate}::date returning id`;
      oppId = o?.id ?? null;
    }

    const [m] = await tx`select hold_minutes from merchant where id = 1`;
    const id = await nextRef(tx, 'RSV');
    const [r] = await tx`
      insert into reservations (id, sku, customer_ref, opportunity_id, qty, unit_price_kobo, kind, status, expires_at, for_date, notes)
      values (${id}, ${p.sku}, ${ref}, ${oppId}, ${qty}, ${p.price_kobo.toString()}, 'customer', 'HELD', ${minutesFrom(now, m.hold_minutes)},
              ${forDate}, ${cleanText(input.notes, 280) ?? null})
      returning *`;
    if (oppId) {
      await tx`update opportunities set next_action_due_at = ${r.expires_at} where id = ${oppId}`;
    }
    return { ...holdView(r, p.name), already_held: false };
  });
}

/**
 * Close holds whose time is up and hand the units back. A restock offer that lapses closes that
 * opportunity (and tells the customer) so the next person in the queue can be offered the unit.
 * A customer who was buying a substitute goes back onto the waitlist they consented to.
 */
export async function expireHolds(deps: Deps) {
  const now = deps.now();
  return deps.sql.begin(async (tx) => {
    const expired = await tx`
      update reservations set status = 'EXPIRED', closed_at = ${now}
      where status = 'HELD' and expires_at <= ${now}
      returning *`;
    for (const r of expired) {
      if (r.opportunity_id) {
        const [o] = await tx`select o.*, p.name from opportunities o join products p on p.sku = o.sku where o.id = ${r.opportunity_id}`;
        if (o && ['OFFERED', 'CHECKOUT'].includes(o.status)) {
          if (o.alternative_sku && o.consent) {
            await tx`update opportunities set status = 'WAITING_RESTOCK', alternative_sku = null,
                     next_action = 'Restock, then offer to this customer', next_action_owner = 'owner', updated_at = ${now} where id = ${o.id}`;
          } else {
            await tx`update opportunities set status = 'EXPIRED', next_action = null, next_action_owner = null,
                     closed_at = ${now}, updated_at = ${now} where id = ${o.id}`;
            if (r.kind === 'offer' || o.status === 'CHECKOUT') {
              await queueNotification(tx, {
                recipient_type: 'customer',
                recipient_ref: r.customer_ref,
                reason: 'hold_expired',
                dedupe_key: `expired:${r.id}`,
                body: `The ${o.name} I was holding for you has been released because the hold time ran out. If you still want it, just reply and I'll check what's in stock now.`,
              });
            }
          }
        }
      }
      await emit(tx, 'stock.released', { sku: r.sku, for_date: isoDay(r.for_date) });
    }
    return { expired: expired.length };
  });
}
