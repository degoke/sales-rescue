// Supplier ETAs and the owner reminders tied to them. A reminder belongs to an unresolved restock
// obligation: rescheduling replaces it (old Chord task cancelled), and resolving the restock closes it.
import type { Db, Tx } from '../db/client.js';
import { nextRef } from '../db/client.js';
import type { Deps } from '../deps.js';
import { fail } from '../lib/errors.js';
import { lagosAt, lagosDateTime, lagosDay, minutesFrom } from '../lib/time.js';
import { queueNotification } from './outbox.js';
import { openRestock, restockView } from './opportunities.js';
import { requireOwner } from './owner.js';
import { lockProduct } from './products.js';

export async function closeRestockReminders(db: Db, sku: string, status: 'DONE' | 'CANCELLED' | 'SUPERSEDED', now: Date) {
  const rows = await db`
    update reminders set status = ${status}, closed_at = ${now}
    where status = 'ACTIVE' and restock_id in (select id from restocks where sku = ${sku})
    returning chord_task_id`;
  return rows.map((r) => r.chord_task_id).filter(Boolean) as string[];
}

export async function cancelChordTasks(deps: Deps, taskIds: string[]) {
  if (!deps.chord) return;
  for (const id of taskIds) await deps.chord.cancelTask(id);
}

export type RestockAction = 'record_eta' | 'confirm_eta' | 'snooze' | 'not_restocking';

export async function manageRestock(
  deps: Deps,
  input: {
    owner_token?: string;
    pin?: string;
    sku: string;
    action: RestockAction;
    expected_date?: string; // YYYY-MM-DD
    confirmed?: boolean;
    remind_at?: string; // ISO datetime, or YYYY-MM-DD (10am Lagos)
    qty_expected?: number;
    note?: string;
  },
) {
  await requireOwner(deps, input.owner_token, input.pin);
  const now = deps.now();
  const cancelTasks: string[] = [];
  let newReminderId: string | null = null;

  const parseWhen = (s: string) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? lagosAt(s) : new Date(s));
  const atLeastSoon = (d: Date) => (d.getTime() < now.getTime() + 2 * 60_000 ? minutesFrom(now, 2) : d);

  const result = await deps.sql.begin(async (tx: Tx) => {
    const p = await lockProduct(tx, input.sku);
    let r = await openRestock(tx, p.sku);
    const [{ waiting }] = await tx`select count(*)::int as waiting from opportunities where sku = ${p.sku} and status = 'WAITING_RESTOCK'`;

    const replaceReminder = async (kind: 'eta_check' | 'arrival_check', due: Date) => {
      cancelTasks.push(...(await closeRestockReminders(tx, p.sku, 'SUPERSEDED', now)));
      const date = r.expected_date ? lagosDay(new Date(r.expected_date)) : 'no date yet';
      const body =
        kind === 'eta_check'
          ? `Reminder: you were expecting your supplier to confirm the ${p.name} restock (expected ${date}, ${r.confirmed ? 'confirmed' : 'not confirmed'}). ${waiting} customer(s) are waiting for it. Has the supplier confirmed?`
          : `Reminder: the ${p.name} restock was due ${date}. ${waiting} customer(s) are waiting. Has it arrived? Tell me how many units came in and I'll update stock and offer it to them.`;
      const id = await nextRef(tx, 'REM');
      await tx`insert into reminders (id, restock_id, kind, due_at, body, status) values (${id}, ${r.id}, ${kind}, ${due}, ${body}, 'ACTIVE')`;
      newReminderId = id;
      return { reminder_id: id, kind, due_at: due.toISOString(), due_local: lagosDateTime(due) };
    };

    let reminder: unknown = null;
    switch (input.action) {
      case 'record_eta': {
        if (!input.expected_date) fail('expected_date_required', 'Ask the owner for the expected date (YYYY-MM-DD).');
        lagosAt(input.expected_date!); // validates the format
        if (r) {
          [r] = await tx`update restocks set expected_date = ${input.expected_date!}, confirmed = ${!!input.confirmed},
                         qty_expected = ${input.qty_expected ?? r.qty_expected}, note = ${input.note ?? r.note}, updated_at = ${now}
                         where id = ${r.id} returning *`;
        } else {
          const id = await nextRef(tx, 'RST');
          [r] = await tx`insert into restocks (id, sku, expected_date, confirmed, qty_expected, note, status)
                         values (${id}, ${p.sku}, ${input.expected_date!}, ${!!input.confirmed}, ${input.qty_expected ?? null}, ${input.note ?? null}, 'OPEN')
                         returning *`;
        }
        const eta = lagosAt(input.expected_date!);
        const due = input.remind_at ? parseWhen(input.remind_at) : input.confirmed ? eta : new Date(eta.getTime() - 24 * 3600_000);
        reminder = await replaceReminder(input.confirmed ? 'arrival_check' : 'eta_check', atLeastSoon(due));
        await tx`update opportunities set next_action_due_at = ${eta}, updated_at = ${now} where sku = ${p.sku} and status = 'WAITING_RESTOCK'`;
        break;
      }
      case 'confirm_eta': {
        if (!r) fail('no_open_restock', 'There is no expected restock recorded for this product. Use record_eta first.');
        const date = input.expected_date ?? (r.expected_date ? new Date(r.expected_date).toISOString().slice(0, 10) : null);
        if (!date) fail('expected_date_required', 'Ask the owner for the confirmed date (YYYY-MM-DD).');
        [r] = await tx`update restocks set confirmed = true, expected_date = ${date}, updated_at = ${now} where id = ${r.id} returning *`;
        reminder = await replaceReminder('arrival_check', atLeastSoon(input.remind_at ? parseWhen(input.remind_at) : lagosAt(date!)));
        break;
      }
      case 'snooze': {
        if (!r) fail('no_open_restock', 'There is no open restock to remind about.');
        if (!input.remind_at) fail('remind_at_required', 'Ask the owner when to remind them (date or date and time).');
        const [active] = await tx`select kind from reminders where restock_id = ${r.id} and status = 'ACTIVE'`;
        reminder = await replaceReminder(active?.kind ?? 'eta_check', atLeastSoon(parseWhen(input.remind_at!)));
        break;
      }
      case 'not_restocking': {
        if (r) {
          [r] =
            await tx`update restocks set status = 'NOT_RESTOCKING', note = ${input.note ?? r.note}, updated_at = ${now} where id = ${r.id} returning *`;
        } else {
          const id = await nextRef(tx, 'RST');
          [r] =
            await tx`insert into restocks (id, sku, note, status) values (${id}, ${p.sku}, ${input.note ?? null}, 'NOT_RESTOCKING') returning *`;
        }
        cancelTasks.push(...(await closeRestockReminders(tx, p.sku, 'CANCELLED', now)));
        const closed = await tx`
          update opportunities set status = 'NOT_RESTOCKING', next_action = null, next_action_owner = null, closed_at = ${now}, updated_at = ${now}
          where sku = ${p.sku} and status = 'WAITING_RESTOCK' returning id, customer_ref`;
        for (const o of closed) {
          await queueNotification(tx, {
            recipient_type: 'customer',
            recipient_ref: o.customer_ref,
            reason: 'not_restocking',
            dedupe_key: `not_restocking:${o.id}`,
            body: `An update on the ${p.name} you were waiting for: the shop isn't expecting to restock it. Sorry about that. Reply if you'd like me to suggest similar products that are in stock now.`,
          });
        }
        return { sku: p.sku, product: p.name, status: 'NOT_RESTOCKING', customers_told: closed.length, reminders_cancelled: true };
      }
      default:
        fail('invalid_action', `Unknown action "${input.action}".`);
    }
    return { sku: p.sku, product: p.name, restock: restockView(r), waiting_customers: waiting, reminder };
  });

  await cancelChordTasks(deps, cancelTasks).catch((e) => console.error(JSON.stringify({ event: 'chord_cancel_failed', error: String(e) })));
  if (newReminderId) {
    // The ETA and reminder are saved either way; if Chord is down the worker delivers it by pull when due.
    await scheduleReminder(deps, newReminderId).catch((e) =>
      console.error(JSON.stringify({ event: 'reminder_schedule_failed', reminder: newReminderId, error: String(e) })),
    );
  }
  return result;
}

/** Put an ACTIVE reminder into the owner's Chord conversation at its due time, if we know the thread. */
export async function scheduleReminder(deps: Deps, reminderId: string) {
  if (!deps.chord) return;
  const [rem] = await deps.sql`select * from reminders where id = ${reminderId} and status = 'ACTIVE' and chord_task_id is null`;
  if (!rem) return;
  const threadId = await ownerThreadId(deps);
  if (!threadId) return; // the worker delivers it as a pull notification when due
  const at = new Date(Math.max(new Date(rem.due_at).getTime(), deps.now().getTime() + 70_000));
  const { taskId } = await deps.chord.scheduleMessage({ conversationId: threadId, body: `${rem.body}\n\n(ref ${rem.id})`, at });
  await deps.sql`update reminders set chord_task_id = ${taskId} where id = ${rem.id}`;
}

export async function ownerThreadId(deps: Deps): Promise<string | null> {
  const [m] = await deps.sql`select owner_chord_thread_id, owner_sender_id, owner_phone from merchant where id = 1`;
  if (m.owner_chord_thread_id) return m.owner_chord_thread_id;
  if (!deps.chord) return null;
  for (const participant of [m.owner_sender_id, m.owner_phone].filter(Boolean)) {
    const id = await deps.chord.findThread(participant).catch(() => null);
    if (id) {
      await deps.sql`update merchant set owner_chord_thread_id = ${id} where id = 1`;
      return id;
    }
  }
  return null;
}

/** Due reminders that couldn't go through Chord become owner notifications; fired ones are closed. */
export async function processDueReminders(deps: Deps) {
  const now = deps.now();
  const due = await deps.sql`select * from reminders where status = 'ACTIVE' and due_at <= ${now}`;
  for (const rem of due) {
    // A pushed reminder counts only if Chord actually delivered it; otherwise fall back to pull.
    const task = rem.chord_task_id && deps.chord ? await deps.chord.getTask(rem.chord_task_id) : null;
    if (task && task.status === 'PENDING') continue; // Chord's sweep hasn't fired it yet
    if (!rem.chord_task_id || (task && task.status !== 'COMPLETED')) {
      await queueNotification(deps.sql, {
        recipient_type: 'owner',
        recipient_ref: 'owner',
        reason: 'restock_reminder',
        dedupe_key: `reminder:${rem.id}`,
        body: rem.body,
      });
    }
    await deps.sql`update reminders set status = 'DONE', closed_at = ${now} where id = ${rem.id} and status = 'ACTIVE'`;
  }
  return { fired: due.length };
}
