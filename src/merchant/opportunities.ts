// Purchase opportunities: the durable record of "this customer wants this item", which outlives
// the conversation, supplier estimates and several stock changes.
import type { Db, Tx } from '../db/client.js';
import { nextRef } from '../db/client.js';
import type { Deps } from '../deps.js';
import { fail } from '../lib/errors.js';
import { naira } from '../lib/money.js';
import { dayLabel, isIsoDate, isoDay, lagosDateTime, lagosDay, minutesFrom } from '../lib/time.js';
import { upsertCustomer } from './customers.js';
import { emit, queueNotification } from './outbox.js';
import { earliestDay, heldQty, lockCapacityGroup, lockProduct, slotsFree } from './products.js';

export const OPEN = ['WAITING_RESTOCK', 'OFFERED', 'CHECKOUT'] as const;

export async function openRestock(db: Db, sku: string) {
  const [r] = await db`select * from restocks where sku = ${sku} and status = 'OPEN'`;
  return r ?? null;
}

/** Customer-facing restock info. The owner's free-text note is never included: it's owner-only data. */
export const restockView = (r: any) =>
  r ? { expected_date: r.expected_date ? new Date(r.expected_date).toISOString().slice(0, 10) : null, confirmed: r.confirmed } : null;

export const MAX_QTY = 5;

/** Waitlist sign-up. A waitlist is not a preorder: nothing is charged and nothing is promised. */
export async function registerInterest(
  deps: Deps,
  input: { customer_ref: string; sku: string; qty?: number; consent: boolean; display_name?: string; for_date?: string },
) {
  const qty = input.qty ?? 1;
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) fail('invalid_qty', `qty must be 1–${MAX_QTY}. Larger orders go to the owner.`);
  if (input.consent !== true) {
    fail('consent_required', 'Ask the customer if they want to be messaged when it is available, and only call this after they say yes.');
  }
  const now = deps.now();
  return deps.sql.begin(async (tx) => {
    const p = await lockProduct(tx, input.sku);
    if (p.status === 'DISCONTINUED') fail('discontinued', `${p.name} is no longer sold. Offer alternatives instead.`);

    // Stock items wait for a restock; made-to-order items wait for a slot on a fully booked date.
    let forDate: string | null = null;
    if (p.fulfilment === 'made_to_order') {
      if (!input.for_date || !isIsoDate(input.for_date))
        fail('date_required', `Which date do they want ${p.name} for? Pass it as YYYY-MM-DD.`);
      forDate = input.for_date!;
      if (forDate < earliestDay(p, now))
        fail('too_soon', `${p.name} needs ${p.lead_time_days} day(s) notice, so that date can't be waited for.`);
      const free = await slotsFree(tx, p.capacity_group!, forDate, now);
      if (free >= qty)
        fail('date_available', `${dayLabel(forDate)} still has room. Reserve it instead of a waitlist.`, { slots_free: free });
    } else {
      const available = p.qty_on_hand - (await heldQty(tx, p.sku, now));
      if (available >= qty) {
        fail('in_stock', `${p.name} is available right now (${available}). Offer to reserve it instead of a waitlist.`, { available });
      }
    }
    await upsertCustomer(tx, { ref: input.customer_ref, display_name: input.display_name, consent: true });
    const restock = forDate ? null : await openRestock(tx, p.sku);

    const id = await nextRef(tx, 'OPP');
    const [inserted] = await tx`
      insert into opportunities (id, customer_ref, sku, qty, status, consent, for_date, next_action, next_action_owner, next_action_due_at, created_at, updated_at)
      values (${id}, ${input.customer_ref.trim()}, ${p.sku}, ${qty}, 'WAITING_RESTOCK', true, ${forDate},
              ${forDate ? 'Offer a slot if one opens on that date' : 'Restock, then offer to this customer'},
              ${forDate ? 'system' : 'owner'}, ${forDate ?? restock?.expected_date ?? null}, ${now}, ${now})
      on conflict (customer_ref, sku, coalesce(for_date, '1970-01-01'::date)) where status in ('WAITING_RESTOCK', 'OFFERED', 'CHECKOUT') do nothing
      returning *`;
    let opp = inserted;
    let already = false;
    if (!opp) {
      already = true;
      [opp] = await tx`select * from opportunities where customer_ref = ${input.customer_ref.trim()} and sku = ${p.sku}
                       and for_date is not distinct from ${forDate}::date and status in ('WAITING_RESTOCK', 'OFFERED', 'CHECKOUT')`;
    } else {
      await emit(tx, 'interest.created', { opportunity_id: opp.id, sku: p.sku, for_date: forDate });
    }
    const [{ ahead }] = await tx`
      select count(*)::int as ahead from opportunities
      where sku = ${p.sku} and status = 'WAITING_RESTOCK' and for_date is not distinct from ${forDate}::date and created_at < ${opp.created_at}`;
    return {
      opportunity_id: opp.id,
      status: opp.status,
      already_on_list: already,
      product: { sku: p.sku, name: p.name, price: naira(p.price_kobo) },
      qty: opp.qty,
      ...(forDate ? { waiting_for_date: { date: forDate, label: dayLabel(forDate) } } : {}),
      position_in_queue: ahead + 1,
      ...(forDate
        ? { note: 'If a slot opens on that date (a cancellation or the owner adds capacity), it is offered to the queue in order.' }
        : {
            restock: restockView(restock) ?? { expected_date: null, confirmed: false, note: 'The shop has not given a restock date yet.' },
          }),
      payment_required_now: false,
    };
  });
}

/** Customer declines or opts out: stop follow-ups and release anything held for them. */
export async function withdrawInterest(deps: Deps, input: { customer_ref: string; sku?: string; opt_out?: boolean }) {
  const now = deps.now();
  return deps.sql.begin(async (tx) => {
    const opps = await tx`
      update opportunities set status = 'DECLINED', next_action = null, next_action_owner = null, closed_at = ${now}, updated_at = ${now}
      where customer_ref = ${input.customer_ref.trim()} and status in ('WAITING_RESTOCK', 'OFFERED', 'CHECKOUT')
        and (${input.sku ?? null}::text is null or upper(sku) = upper(${input.sku ?? ''}))
      returning id, sku`;
    const released = await tx`
      update reservations set status = 'RELEASED', closed_at = ${now}
      where status = 'HELD' and opportunity_id in ${tx(opps.length ? opps.map((o) => o.id) : ['-'])}
      returning sku, for_date`;
    for (const r of released) await emit(tx, 'stock.released', { sku: r.sku, for_date: isoDay(r.for_date) });
    if (input.opt_out) {
      await tx`update customers set notify_consent = false, opted_out_at = ${now} where ref = ${input.customer_ref.trim()}`;
      await tx`update notifications set status = 'SKIPPED', last_error = 'customer opted out'
               where recipient_type = 'customer' and recipient_ref = ${input.customer_ref.trim()} and status = 'QUEUED'`;
    }
    return { closed_opportunities: opps.map((o) => o.id), released_holds: released.length, opted_out: !!input.opt_out };
  });
}

type Offered = { opportunity_id: string; customer_ref: string; reservation_id: string; expires_at: string };

/**
 * First-come-first-served allocation after stock rises, a hold is released, or a date gains a
 * free baking slot. Each waiter that fits gets a time-limited hold and a message; the rest keep
 * waiting. Never promises more than is actually free.
 */
export async function allocateStock(deps: Deps, sku: string, forDate?: string | null) {
  const [p] = await deps.sql`select fulfilment, capacity_group from products where upper(sku) = upper(${sku})`;
  if (p?.fulfilment === 'made_to_order') {
    return forDate ? allocateSlots(deps, p.capacity_group, forDate) : { offered: [], still_waiting: 0 };
  }
  const now = deps.now();
  return deps.sql.begin(async (tx: Tx) => {
    const p = await lockProduct(tx, sku);
    if (p.status !== 'ACTIVE') return { offered: [], still_waiting: 0 };
    const [m] = await tx`select offer_hold_minutes from merchant where id = 1`;
    let available = p.qty_on_hand - (await heldQty(tx, p.sku, now));
    const waiters = await tx`
      select o.* from opportunities o join customers c on c.ref = o.customer_ref
      where o.sku = ${p.sku} and o.status = 'WAITING_RESTOCK' and o.for_date is null and o.consent and c.opted_out_at is null
      order by o.created_at, o.id
      for update of o skip locked`;
    const offered: Offered[] = [];
    for (const w of waiters) {
      if (available < w.qty) break; // strict FCFS: don't let a later, smaller request jump the queue
      const rid = await nextRef(tx, 'RSV');
      const expires = minutesFrom(now, m.offer_hold_minutes);
      await tx`insert into reservations (id, sku, customer_ref, opportunity_id, qty, unit_price_kobo, kind, status, expires_at)
               values (${rid}, ${p.sku}, ${w.customer_ref}, ${w.id}, ${w.qty}, ${p.price_kobo.toString()}, 'offer', 'HELD', ${expires})`;
      await tx`update opportunities set status = 'OFFERED', next_action = 'Customer to accept or decline the offer',
               next_action_owner = 'customer', next_action_due_at = ${expires}, updated_at = ${now} where id = ${w.id}`;
      await queueNotification(tx, {
        recipient_type: 'customer',
        recipient_ref: w.customer_ref,
        reason: 'restock_offer',
        dedupe_key: `offer:${rid}`,
        // No customer-typed text in outgoing bodies: names are attacker-controllable.
        body: `Good news: the ${p.name} you asked about is back in stock. I've set ${w.qty === 1 ? 'one' : w.qty} aside for you until ${lagosDateTime(expires)} (${naira(p.price_kobo)} each, plus delivery). Reply "yes" to buy, or "no" and I'll release it to the next person.`,
      });
      available -= w.qty;
      offered.push({ opportunity_id: w.id, customer_ref: w.customer_ref, reservation_id: rid, expires_at: expires.toISOString() });
    }
    const stillWaiting = waiters.length - offered.length;
    if (offered.length > 0) {
      await queueNotification(tx, {
        recipient_type: 'owner',
        recipient_ref: 'owner',
        reason: 'restock_allocated',
        dedupe_key: `alloc:${offered.map((o) => o.reservation_id).join(',')}`,
        body: `Restock of ${p.name}: offered to ${offered.length} waiting customer${offered.length === 1 ? '' : 's'} (held until ${lagosDateTime(new Date(offered[0].expires_at))}). ${stillWaiting > 0 ? `${stillWaiting} still waiting for more stock.` : 'Nobody else is waiting.'}`,
      });
    }
    return { offered, still_waiting: stillWaiting };
  });
}

/**
 * A baking slot opened on `day` for a capacity group (cancellation, expired hold, owner added
 * capacity). Offer it to whoever has waited longest for that date, across every product sharing
 * the group's oven time.
 */
export async function allocateSlots(deps: Deps, group: string, day: string) {
  const now = deps.now();
  return deps.sql.begin(async (tx: Tx) => {
    await lockCapacityGroup(tx, group);
    const [m] = await tx`select offer_hold_minutes from merchant where id = 1`;
    let free = await slotsFree(tx, group, day, now);
    const waiters = await tx`
      select o.*, p.name, p.price_kobo from opportunities o
      join products p on p.sku = o.sku join customers c on c.ref = o.customer_ref
      where p.capacity_group = ${group} and o.for_date = ${day} and o.status = 'WAITING_RESTOCK'
        and o.consent and c.opted_out_at is null and p.status = 'ACTIVE'
      order by o.created_at, o.id
      for update of o skip locked`;
    const offered: Offered[] = [];
    for (const w of waiters) {
      if (free < w.qty) break; // strict FCFS
      const rid = await nextRef(tx, 'RSV');
      const expires = minutesFrom(now, m.offer_hold_minutes);
      await tx`insert into reservations (id, sku, customer_ref, opportunity_id, qty, unit_price_kobo, kind, status, expires_at, for_date)
               values (${rid}, ${w.sku}, ${w.customer_ref}, ${w.id}, ${w.qty}, ${w.price_kobo.toString()}, 'offer', 'HELD', ${expires}, ${day})`;
      await tx`update opportunities set status = 'OFFERED', next_action = 'Customer to accept or decline the slot',
               next_action_owner = 'customer', next_action_due_at = ${expires}, updated_at = ${now} where id = ${w.id}`;
      await queueNotification(tx, {
        recipient_type: 'customer',
        recipient_ref: w.customer_ref,
        reason: 'slot_offer',
        dedupe_key: `offer:${rid}`,
        body: `Good news: a slot opened on ${dayLabel(day)} for your ${w.name}. I'm holding it for you until ${lagosDateTime(expires)} (${naira(w.price_kobo)}, plus delivery). Reply "yes" to book it, or "no" and I'll offer it to the next person.`,
      });
      free -= w.qty;
      offered.push({ opportunity_id: w.id, customer_ref: w.customer_ref, reservation_id: rid, expires_at: expires.toISOString() });
    }
    const stillWaiting = waiters.length - offered.length;
    if (offered.length > 0) {
      await queueNotification(tx, {
        recipient_type: 'owner',
        recipient_ref: 'owner',
        reason: 'slot_allocated',
        dedupe_key: `alloc:${offered.map((o) => o.reservation_id).join(',')}`,
        body: `A slot opened on ${dayLabel(day)}: offered to ${offered.length} waiting customer${offered.length === 1 ? '' : 's'} (held until ${lagosDateTime(new Date(offered[0].expires_at))}). ${stillWaiting > 0 ? `${stillWaiting} still waiting for that date.` : 'Nobody else is waiting for that date.'}`,
      });
    }
    return { offered, still_waiting: stillWaiting };
  });
}

/** Everything the agent needs to pick up a returning customer, including messages the shop sent. */
export async function getMyUpdates(deps: Deps, input: { customer_ref: string }) {
  const ref = input.customer_ref.trim();
  const now = deps.now();
  const opps = await deps.sql`
    select o.id, o.status, o.qty, o.sku, p.name, p.price_kobo, o.next_action, o.created_at, o.for_date,
           r.id as reservation_id, r.expires_at as hold_expires_at
    from opportunities o join products p on p.sku = o.sku
    left join reservations r on r.opportunity_id = o.id and r.status = 'HELD' and r.expires_at > ${now}
    where o.customer_ref = ${ref} and o.status in ('WAITING_RESTOCK', 'OFFERED', 'CHECKOUT')
    order by o.created_at`;
  const orders = await deps.sql`
    select o.ref, o.status, o.for_date, p.name from orders o join products p on p.sku = o.sku
    where o.customer_ref = ${ref} order by o.created_at desc limit 5`;
  // Recent shop messages are returned every time (not only unread ones), so someone calling this
  // with another customer's ref can't make that customer's messages disappear. Marking them read
  // only stops them being pushed again later.
  const notes = await deps.sql`
    select id, reason, body, status, channel, created_at from notifications
    where recipient_type = 'customer' and recipient_ref = ${ref} and status <> 'SKIPPED'
      and created_at > ${new Date(now.getTime() - 72 * 3600_000)}
    order by created_at desc limit 5`;
  if (notes.length)
    await deps.sql`update notifications set read_at = ${now} where id in ${deps.sql(notes.map((n) => n.id))} and read_at is null`;
  return {
    customer_ref: ref,
    open_requests: opps.map((o) => ({
      opportunity_id: o.id,
      status: o.status,
      product: { sku: o.sku, name: o.name, price: naira(o.price_kobo) },
      qty: o.qty,
      next_action: o.next_action,
      ...(o.for_date ? { for_date: isoDay(o.for_date), for_date_label: dayLabel(isoDay(o.for_date)!) } : {}),
      hold: o.reservation_id
        ? {
            reservation_id: o.reservation_id,
            expires_at: new Date(o.hold_expires_at).toISOString(),
            expires_local: lagosDateTime(new Date(o.hold_expires_at)),
          }
        : null,
      waiting_since: lagosDay(new Date(o.created_at)),
    })),
    orders: orders.map((o) => ({
      order_ref: o.ref,
      product: o.name,
      status: o.status,
      ...(o.for_date ? { for_date_label: dayLabel(isoDay(o.for_date)!) } : {}),
      details: 'use track_order for delivery status',
    })),
    messages_from_shop: notes
      .sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at))
      .map((n) => ({ ref: n.id, reason: n.reason, text: n.body, delivered_in_chat: n.status === 'SENT' })),
  };
}
