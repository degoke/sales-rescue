// Owner control of made-to-order baking capacity: how many slots a group (cakes, bentos…) has per
// day, per-date overrides ("I can do 2 more cakes on Saturday", "close Sunday"), and a week view.
import type { Tx } from '../db/client.js';
import type { Deps } from '../deps.js';
import { fail } from '../lib/errors.js';
import { addDays, dayLabel, isIsoDate, lagosToday } from '../lib/time.js';
import { emit } from './outbox.js';
import { requireOwner } from './owner.js';
import { lockCapacityGroup } from './products.js';

export type CapacityAction = 'view' | 'set_date' | 'close_date' | 'set_default';

async function dayStats(db: Tx | Deps['sql'], group: string, day: string, now: Date) {
  const [row] = await db`
    select g.daily_slots, o.slots as override,
      (select coalesce(sum(r.qty), 0)::int from reservations r join products p on p.sku = r.sku
        where p.capacity_group = g.code and r.for_date = ${day}
          and (r.status = 'CONVERTED' or (r.status = 'HELD' and r.expires_at > ${now}))) as booked,
      (select count(*)::int from opportunities op join products p on p.sku = op.sku
        where p.capacity_group = g.code and op.for_date = ${day} and op.status = 'WAITING_RESTOCK') as waiting
    from capacity_groups g left join capacity_overrides o on o.group_code = g.code and o.day = ${day}
    where g.code = ${group}`;
  const capacity = row.override ?? row.daily_slots;
  return { date: day, label: dayLabel(day), capacity, booked: row.booked, free: Math.max(0, capacity - row.booked), waiting: row.waiting };
}

export async function manageCapacity(
  deps: Deps,
  input: { owner_token?: string; pin?: string; group?: string; sku?: string; action: CapacityAction; date?: string; slots?: number },
) {
  await requireOwner(deps, input.owner_token, input.pin);
  const now = deps.now();

  let group = input.group;
  if (!group && input.sku) {
    const [p] = await deps.sql`select capacity_group, name from products where upper(sku) = upper(${input.sku})`;
    if (!p?.capacity_group) fail('not_made_to_order', 'That product is sold from stock; use update_inventory for it.');
    group = p.capacity_group;
  }
  const groups = await deps.sql`select code, name, daily_slots from capacity_groups order by code`;
  const g =
    groups.find((x) => x.code === group) ??
    fail('unknown_group', 'Which kind of order? Pass a made-to-order product SKU or a group.', {
      groups: groups.map((x) => ({ group: x.code, name: x.name })),
    });

  const today = lagosToday(now);
  if (input.action !== 'view' && input.action !== 'set_default') {
    if (!input.date || !isIsoDate(input.date) || input.date < today) fail('invalid_date', 'Give a date from today onwards as YYYY-MM-DD.');
  }
  const slots = input.slots;
  if ((input.action === 'set_date' || input.action === 'set_default') && (!Number.isInteger(slots) || slots! < 0 || slots! > 100)) {
    fail('invalid_slots', 'slots must be a whole number from 0 to 100.');
  }

  if (input.action === 'view') {
    const week = [];
    for (let i = 0; i < 7; i++)
      week.push(await dayStats(deps.sql, g.code, addDays(input.date && isIsoDate(input.date) ? input.date : today, i), now));
    return { group: g.code, name: g.name, default_daily_slots: g.daily_slots, days: week };
  }

  const opened: string[] = [];
  const result = await deps.sql.begin(async (tx) => {
    await lockCapacityGroup(tx, g.code);
    if (input.action === 'set_default') {
      await tx`update capacity_groups set daily_slots = ${slots!} where code = ${g.code}`;
      // Any upcoming date with waiters may now have room.
      const dates = await tx`
        select distinct op.for_date from opportunities op join products p on p.sku = op.sku
        where p.capacity_group = ${g.code} and op.status = 'WAITING_RESTOCK' and op.for_date >= ${today}`;
      for (const d of dates) {
        const day = (d.for_date as Date).toISOString().slice(0, 10);
        if ((await dayStats(tx, g.code, day, now)).free > 0) {
          await emit(tx, 'capacity.opened', { group: g.code, day });
          opened.push(day);
        }
      }
      return { group: g.code, name: g.name, default_daily_slots: slots };
    }
    const day = input.date!;
    const before = await dayStats(tx, g.code, day, now);
    const target = input.action === 'close_date' ? 0 : slots!;
    if (target < before.booked) {
      fail('below_booked', `${before.booked} order(s) are already booked for ${before.label}; capacity can't go below that.`, {
        booked: before.booked,
      });
    }
    await tx`insert into capacity_overrides (group_code, day, slots) values (${g.code}, ${day}, ${target})
             on conflict (group_code, day) do update set slots = excluded.slots, updated_at = now()`;
    const after = await dayStats(tx, g.code, day, now);
    if (after.free > before.free && after.waiting > 0) {
      await emit(tx, 'capacity.opened', { group: g.code, day });
      opened.push(day);
    }
    return { group: g.code, name: g.name, before, after };
  });
  return {
    ...result,
    slots_offered_to_waiting_customers_on: opened.map(dayLabel),
    message: opened.length ? 'Saved. Customers waiting for those dates will be offered the new slots in queue order.' : 'Saved.',
  };
}
