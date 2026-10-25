// Owner stock and price changes by chat. The op is explicit ("add 10" = increment, "we have 10" =
// set), and big changes are read back for confirmation before they are written.
import { createHash } from 'node:crypto';
import { nextRef } from '../db/client.js';
import type { Deps } from '../deps.js';
import { fail } from '../lib/errors.js';
import { naira, nairaToKobo } from '../lib/money.js';
import { minutesFrom } from '../lib/time.js';
import { emit, queueNotification } from './outbox.js';
import { requireOwner } from './owner.js';
import { heldQty, lockProduct } from './products.js';
import { cancelChordTasks, closeRestockReminders } from './restock.js';

export type InventoryOp = 'increment' | 'set' | 'price' | 'sold_out' | 'discontinue' | 'reactivate';

export async function updateInventory(
  deps: Deps,
  input: { owner_token?: string; pin?: string; sku: string; op: InventoryOp; value?: number; confirmation_id?: string },
) {
  await requireOwner(deps, input.owner_token, input.pin);
  const now = deps.now();
  const cancelTasks: string[] = [];

  const result = await deps.sql.begin(async (tx) => {
    const p = await lockProduct(tx, input.sku);
    if (p.fulfilment === 'made_to_order' && ['increment', 'set', 'sold_out'].includes(input.op)) {
      fail(
        'made_to_order',
        `${p.name} is made to order: it has daily baking slots, not stock. Use manage_capacity to open, reduce or close dates.`,
      );
    }
    const [m] = await tx`select large_qty_change, large_price_change_pct from merchant where id = 1`;
    const held = await heldQty(tx, p.sku, now);

    let afterQty = p.qty_on_hand;
    let afterPrice = p.price_kobo;
    let afterStatus = p.status;
    const v = input.value;
    switch (input.op) {
      case 'increment':
        if (!Number.isInteger(v) || v! <= 0) fail('invalid_value', 'increment needs a positive whole number of units to ADD.');
        afterQty = p.qty_on_hand + v!;
        break;
      case 'set':
        if (!Number.isInteger(v) || v! < 0) fail('invalid_value', 'set needs the new TOTAL number of units (0 or more).');
        afterQty = v!;
        break;
      case 'price':
        if (typeof v !== 'number' || !(v > 0)) fail('invalid_value', 'price needs the new price in naira, e.g. 32000.');
        afterPrice = nairaToKobo(v!);
        break;
      case 'sold_out':
        afterQty = 0;
        break;
      case 'discontinue':
        afterStatus = 'DISCONTINUED';
        break;
      case 'reactivate':
        if (p.status === 'ACTIVE') fail('already_active', `${p.name} is already on sale.`);
        afterStatus = 'ACTIVE';
        break;
      default:
        fail('invalid_op', `Unknown op "${input.op}".`);
    }
    if (afterQty < held) {
      fail('below_reserved', `${held} unit(s) of ${p.name} are held for customers right now, so stock can't go below ${held}.`, { held });
    }

    const qtyDelta = afterQty - p.qty_on_hand;
    const pricePct = (Math.abs(Number(afterPrice - p.price_kobo)) / Number(p.price_kobo)) * 100;
    const large = Math.abs(qtyDelta) > m.large_qty_change || pricePct > m.large_price_change_pct || input.op === 'discontinue';
    const preview = {
      sku: p.sku,
      product: p.name,
      before: { qty: p.qty_on_hand, price: naira(p.price_kobo), status: p.status },
      after: { qty: afterQty, price: naira(afterPrice), status: afterStatus },
    };

    if (input.confirmation_id) {
      const [chg] = await tx`
        select * from inventory_changes where id = ${input.confirmation_id} and status = 'PENDING_CONFIRMATION'
        and sku = ${p.sku} and op = ${input.op} and expires_at > ${now}
        and before_qty = ${p.qty_on_hand} and after_qty = ${afterQty} and after_price_kobo = ${afterPrice.toString()}`;
      if (!chg) fail('invalid_confirmation', 'That confirmation has expired or no longer matches current stock. Preview the change again.');
      await tx`update inventory_changes set status = 'APPLIED', applied_at = ${now} where id = ${chg.id}`;
    } else if (large) {
      // The agent cannot see this tool result on its next turn, so the confirmation ID must be the same
      // each time the same change is asked for. It is a hash of the change and the product's current
      // state (updated_at changes on every write, so an ID never matches a change that was applied).
      const id = `CHG-${createHash('sha256')
        .update(JSON.stringify([p.sku, input.op, v ?? null, p.qty_on_hand, p.price_kobo.toString(), p.status, p.updated_at]))
        .digest('hex')
        .slice(0, 16)}`;
      await tx`insert into inventory_changes (id, sku, op, value, before_qty, after_qty, before_price_kobo, after_price_kobo, status, expires_at)
               values (${id}, ${p.sku}, ${input.op}, ${v ?? null}, ${p.qty_on_hand}, ${afterQty}, ${p.price_kobo.toString()},
                       ${afterPrice.toString()}, 'PENDING_CONFIRMATION', ${minutesFrom(now, 10)})
               on conflict (id) do update set expires_at = excluded.expires_at
               where inventory_changes.status = 'PENDING_CONFIRMATION'`;
      return {
        applied: false,
        needs_confirmation: true,
        confirmation_id: id,
        ...preview,
        message: `This is a large change. Read the "after" values back to the owner. When they confirm, call update_inventory with the same op/value and confirmation_id ${id}. Asking for the same change again returns the same confirmation_id.`,
      };
    } else {
      const id = await nextRef(tx, 'CHG');
      await tx`insert into inventory_changes (id, sku, op, value, before_qty, after_qty, before_price_kobo, after_price_kobo, status, applied_at)
               values (${id}, ${p.sku}, ${input.op}, ${v ?? null}, ${p.qty_on_hand}, ${afterQty}, ${p.price_kobo.toString()},
                       ${afterPrice.toString()}, 'APPLIED', ${now})`;
    }

    await tx`update products set qty_on_hand = ${afterQty}, price_kobo = ${afterPrice.toString()}, status = ${afterStatus}, updated_at = ${now}
             where sku = ${p.sku}`;

    const [{ waiting }] = await tx`select count(*)::int as waiting from opportunities where sku = ${p.sku} and status = 'WAITING_RESTOCK'`;
    let restockEvent = false;
    if (afterStatus === 'ACTIVE' && qtyDelta > 0) {
      // Stock physically arrived: close the restock obligation and its reminders.
      await tx`update restocks set status = 'RECEIVED', updated_at = ${now} where sku = ${p.sku} and status = 'OPEN'`;
      cancelTasks.push(...(await closeRestockReminders(tx, p.sku, 'DONE', now)));
      if (waiting > 0 && afterQty - held > 0) {
        await emit(tx, 'inventory.restocked', { sku: p.sku, before: p.qty_on_hand, after: afterQty });
        restockEvent = true;
      }
    }
    if (afterStatus === 'DISCONTINUED' && p.status !== 'DISCONTINUED') {
      await tx`update restocks set status = 'NOT_RESTOCKING', updated_at = ${now} where sku = ${p.sku} and status = 'OPEN'`;
      cancelTasks.push(...(await closeRestockReminders(tx, p.sku, 'CANCELLED', now)));
      const closed = await tx`
        update opportunities set status = 'NOT_RESTOCKING', next_action = null, next_action_owner = null, closed_at = ${now}, updated_at = ${now}
        where sku = ${p.sku} and status = 'WAITING_RESTOCK' returning id, customer_ref`;
      for (const o of closed) {
        await queueNotification(tx, {
          recipient_type: 'customer',
          recipient_ref: o.customer_ref,
          reason: 'not_restocking',
          dedupe_key: `discontinued:${o.id}`,
          body: `An update on the ${p.name} you were waiting for: the shop has stopped selling it, so it won't be coming back. Reply if you'd like me to suggest similar products that are in stock.`,
        });
      }
    }
    return {
      applied: true,
      ...preview,
      waiting_customers: waiting,
      restock_offers_triggered: restockEvent,
      message: restockEvent ? `Saved. ${waiting} waiting customer(s) will be offered the new stock in queue order.` : 'Saved.',
    };
  });

  await cancelChordTasks(deps, cancelTasks);
  return result;
}
