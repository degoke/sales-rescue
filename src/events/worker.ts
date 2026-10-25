// The part of Sales Rescue that keeps working after conversations end: it reacts to outbox events,
// expires holds, retries deliveries, fires reminders and pushes messages into Chord conversations.
import type { Deps } from '../deps.js';
import { naira } from '../lib/money.js';
import { dayLabel } from '../lib/time.js';
import { allocateSlots, allocateStock } from '../merchant/opportunities.js';
import { expireHolds } from '../merchant/reservations.js';
import { retryPendingFulfillment } from '../merchant/orders.js';
import { queueNotification } from '../merchant/outbox.js';
import { ownerThreadId, processDueReminders } from '../merchant/restock.js';

const MAX_EVENT_ATTEMPTS = 5;
const MAX_SEND_ATTEMPTS = 5;

type Handler = (deps: Deps, payload: any, eventId: number) => Promise<void>;

const handlers: Record<string, Handler> = {
  'interest.created': async (deps, { sku, opportunity_id, for_date }) => {
    const [p] = await deps.sql`select name, price_kobo, capacity_group from products where sku = ${sku}`;
    if (for_date) {
      // Someone wants a fully booked date: the owner may be able to squeeze in another slot.
      const [{ waiting }] = await deps.sql`
        select count(*)::int as waiting from opportunities o join products p on p.sku = o.sku
        where p.capacity_group = ${p.capacity_group} and o.for_date = ${for_date} and o.status = 'WAITING_RESTOCK'`;
      await queueNotification(deps.sql, {
        recipient_type: 'owner',
        recipient_ref: 'owner',
        reason: 'date_demand',
        dedupe_key: `date_demand:${opportunity_id}`,
        body: `${dayLabel(for_date)} is fully booked, and a customer is waiting for a ${p.name} that day (${waiting} waiting for that date in total). If you can fit another one in, tell me and I'll offer the slot to them.`,
      });
      return;
    }
    const [{ waiting, units }] = await deps.sql`
      select count(*)::int as waiting, coalesce(sum(qty), 0)::int as units from opportunities where sku = ${sku} and status = 'WAITING_RESTOCK'`;
    const [{ demand_threshold }] = await deps.sql`select demand_threshold from merchant where id = 1`;
    const [r] = await deps.sql`select expected_date, confirmed from restocks where sku = ${sku} and status = 'OPEN'`;
    const eta = r?.expected_date
      ? `${new Date(r.expected_date).toISOString().slice(0, 10)}${r.confirmed ? ' (confirmed)' : ' (not confirmed)'}`
      : 'none';
    if (waiting === 1) {
      await queueNotification(deps.sql, {
        recipient_type: 'owner',
        recipient_ref: 'owner',
        reason: 'first_waiter',
        dedupe_key: `first:${opportunity_id}`,
        body: `A customer asked for the ${p.name}, which is sold out, and joined the restock list. Confirmed restock date: ${eta}. Do you expect to restock it?`,
      });
    } else if (waiting === demand_threshold) {
      await queueNotification(deps.sql, {
        recipient_type: 'owner',
        recipient_ref: 'owner',
        reason: 'demand_threshold',
        dedupe_key: `threshold:${sku}:${waiting}`,
        body: `Restock attention needed: ${waiting} customers are waiting for the ${p.name} (${units} units, potential sales ${naira(BigInt(units) * BigInt(p.price_kobo))}). Confirmed restock date: ${eta}. Do you expect to restock this product?`,
      });
    }
  },
  'inventory.restocked': async (deps, { sku }) => void (await allocateStock(deps, sku)),
  'stock.released': async (deps, { sku, for_date }) => void (await allocateStock(deps, sku, for_date)),
  'capacity.opened': async (deps, { group, day }) => void (await allocateSlots(deps, group, day)),
  'payment.verified': async (deps, { order_ref, source }) => {
    const [o] = await deps.sql`select o.*, p.name from orders o join products p on p.sku = o.sku where o.ref = ${order_ref}`;
    if (source && source !== 'chat') {
      // Confirmed in the background (customer paid but didn't come back to say so): tell them.
      await queueNotification(deps.sql, {
        recipient_type: 'customer',
        recipient_ref: o.customer_ref,
        reason: 'payment_confirmed',
        dedupe_key: `paid:${order_ref}`,
        body: `Payment received for order ${o.ref} (${naira(o.total_kobo)}), verified with Paystack. ${o.tracking_ref ? `Your ${o.name} is booked with the courier, tracking ${o.tracking_ref}.` : `We're booking delivery for your ${o.name} now.`}`,
      });
    }
    const how =
      o.recovery_type === 'restock'
        ? 'Recovered from the restock list.'
        : o.recovery_type === 'alternative'
          ? 'Recovered with an alternative to a sold-out item.'
          : '';
    await queueNotification(deps.sql, {
      recipient_type: 'owner',
      recipient_ref: 'owner',
      reason: 'sale',
      dedupe_key: `sale:${order_ref}`,
      body: `New paid order ${o.ref}: ${o.qty} × ${o.name}, ${naira(o.total_kobo)} (verified with Paystack). ${how}`.trim(),
    });
  },
  'fulfillment.failed': async (deps, { order_ref, reason, permanent }) => {
    await queueNotification(deps.sql, {
      recipient_type: 'owner',
      recipient_ref: 'owner',
      reason: 'fulfilment_failed',
      dedupe_key: `fulfilment:${order_ref}:${permanent ? 'final' : 'first'}`,
      body: `Delivery booking failed for paid order ${order_ref} (${reason}). The customer has paid; I'll keep retrying the courier. You may want to arrange delivery manually.`,
    });
  },
};

export async function processEvents(deps: Deps, limit = 25) {
  const events = await deps.sql`select * from events where status = 'PENDING' order by id limit ${limit}`;
  for (const e of events) {
    try {
      await handlers[e.type]?.(deps, e.payload, Number(e.id));
      await deps.sql`update events set status = 'DONE', processed_at = ${deps.now()}, attempts = attempts + 1 where id = ${e.id}`;
    } catch (err) {
      const attempts = e.attempts + 1;
      await deps.sql`update events set attempts = ${attempts}, last_error = ${String(err).slice(0, 500)},
                     status = ${attempts >= MAX_EVENT_ATTEMPTS ? 'FAILED' : 'PENDING'} where id = ${e.id}`;
    }
  }
  return { processed: events.length };
}

async function customerThreadId(deps: Deps, ref: string) {
  const [c] = await deps.sql`select chord_thread_id from customers where ref = ${ref}`;
  if (c?.chord_thread_id) return c.chord_thread_id as string;
  const id = await deps.chord!.findThread(ref); // throws on API errors: the caller backs off
  if (id) await deps.sql`update customers set chord_thread_id = ${id} where ref = ${ref}`;
  return id;
}

/**
 * Push queued messages into the recipient's Chord conversation as a scheduled MESSAGE task.
 * With no Chord client or no known thread, the message stays available through
 * get_my_updates / get_demand_summary ("pull"), so nothing is lost. A message the recipient has
 * already been shown through pull (read_at set) is never pushed afterwards.
 */
export async function deliverNotifications(deps: Deps, limit = 25) {
  const now = deps.now();
  const queued = await deps.sql`
    select * from notifications where status = 'QUEUED' and read_at is null and next_attempt_at <= ${now}
    order by created_at limit ${limit}`;
  const [m] = await deps.sql`select owner_phone, owner_sender_id, owner_chord_thread_id from merchant where id = 1`;
  let submitted = 0;
  for (const n of queued) {
    const later = (minutes: number) => new Date(now.getTime() + minutes * 60_000);
    if (!deps.chord) {
      await deps.sql`update notifications set channel = 'pull', last_error = 'Chord not configured', next_attempt_at = ${later(60)} where id = ${n.id}`;
      continue;
    }
    if (n.recipient_type === 'customer') {
      const [c] = await deps.sql`select opted_out_at from customers where ref = ${n.recipient_ref}`;
      if (c?.opted_out_at) {
        await deps.sql`update notifications set status = 'SKIPPED', last_error = 'customer opted out' where id = ${n.id}`;
        continue;
      }
      // customer_ref is model-supplied (no caller identity in MCP), so a customer record can claim the
      // owner's number. Never let customer-facing text land in the owner's conversation.
      if ([m.owner_phone, m.owner_sender_id].includes(n.recipient_ref)) {
        await deps.sql`update notifications set status = 'SKIPPED', last_error = 'recipient matches the owner identity' where id = ${n.id}`;
        continue;
      }
    }
    let thread: string | null;
    try {
      thread = n.recipient_type === 'owner' ? await ownerThreadId(deps) : await customerThreadId(deps, n.recipient_ref);
    } catch (err) {
      await backoff(deps, n, err, now);
      continue;
    }
    if (thread && n.recipient_type === 'customer' && thread === m.owner_chord_thread_id) {
      await deps.sql`update notifications set status = 'SKIPPED', last_error = 'resolved to the owner thread' where id = ${n.id}`;
      continue;
    }
    if (!thread) {
      // Not reachable by push yet (e.g. the simulator, where the agent's id differs from the thread's):
      // available by pull now; look for a thread again in 10 minutes.
      await deps.sql`update notifications set channel = 'pull', last_error = 'no Chord thread for recipient', next_attempt_at = ${later(10)} where id = ${n.id}`;
      continue;
    }
    try {
      const { taskId } = await deps.chord.scheduleMessage({ conversationId: thread, body: n.body, at: new Date(now.getTime() + 70_000) });
      await deps.sql`update notifications set status = 'SUBMITTED', channel = 'chord_message', chord_task_id = ${taskId},
                     submitted_at = ${now}, attempts = attempts + 1 where id = ${n.id}`;
      submitted++;
    } catch (err) {
      await backoff(deps, n, err, now);
    }
  }
  return { submitted };
}

async function backoff(deps: Deps, n: any, err: unknown, now: Date) {
  const attempts = n.attempts + 1;
  await deps.sql`update notifications set attempts = ${attempts}, last_error = ${String(err).slice(0, 500)},
                 status = ${attempts >= MAX_SEND_ATTEMPTS ? 'FAILED' : 'QUEUED'},
                 next_attempt_at = ${new Date(now.getTime() + 2 ** attempts * 60_000)} where id = ${n.id}`;
}

/** A submitted task is only "sent" once Chord reports it COMPLETED; lost or stuck tasks are retried. */
export async function syncSubmittedNotifications(deps: Deps) {
  if (!deps.chord) return { synced: 0 };
  const now = deps.now();
  const rows =
    await deps.sql`select id, chord_task_id, attempts, submitted_at from notifications where status = 'SUBMITTED' order by submitted_at nulls first limit 25`;
  for (const n of rows) {
    const t = await deps.chord.getTask(n.chord_task_id);
    const stuck = n.submitted_at && now.getTime() - new Date(n.submitted_at).getTime() > 15 * 60_000;
    if (t?.status === 'COMPLETED') {
      await deps.sql`update notifications set status = 'SENT', sent_at = ${now} where id = ${n.id}`;
    } else if (t?.status === 'FAILED' || t?.status === 'CANCELLED' || t?.status === 'NOT_FOUND' || (stuck && t?.status !== 'PENDING')) {
      await deps.sql`update notifications set status = ${n.attempts >= MAX_SEND_ATTEMPTS ? 'FAILED' : 'QUEUED'},
                     last_error = ${t?.last_error ?? t?.status ?? 'no task status after 15 min'}, next_attempt_at = ${now} where id = ${n.id}`;
    }
  }
  return { synced: rows.length };
}

/** Each step is isolated so one failing step can't stop the others (expiry, payments, delivery…). */
export async function runWorkerOnce(deps: Deps) {
  const steps: [string, () => Promise<unknown>][] = [
    ['holds', () => expireHolds(deps)],
    ['events', () => processEvents(deps)],
    ['fulfilment', () => retryPendingFulfillment(deps)],
    ['reminders', () => processDueReminders(deps)],
    ['events2', () => processEvents(deps)], // events raised by the steps above (e.g. released holds)
    ['delivered', () => deliverNotifications(deps)],
    ['synced', () => syncSubmittedNotifications(deps)],
  ];
  const out: Record<string, unknown> = {};
  for (const [name, run] of steps) {
    try {
      out[name] = await run();
    } catch (err) {
      out[name] = { error: String(err) };
      console.error(JSON.stringify({ at: new Date().toISOString(), event: 'worker_step_error', step: name, error: String(err) }));
    }
  }
  return out;
}

export function startWorker(deps: Deps, intervalMs: number) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runWorkerOnce(deps);
    } catch (err) {
      console.error(JSON.stringify({ at: new Date().toISOString(), event: 'worker_error', error: String(err) }));
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  void tick();
  return () => clearInterval(timer);
}
