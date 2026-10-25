import type { Deps } from '../deps.js';
import { naira } from '../lib/money.js';
import { dayLabel, isoDay, lagosDateTime, lagosDay } from '../lib/time.js';
import { requireOwner } from './owner.js';

/** Owner view of outstanding demand and the recovery metrics (spec §10), all from stored records. */
export async function getDemandSummary(deps: Deps, input: { owner_token?: string; pin?: string; sku?: string }) {
  await requireOwner(deps, input.owner_token, input.pin);
  const now = deps.now();
  const sku = input.sku ?? null;

  const demand = await deps.sql`
    select p.sku, p.name, p.price_kobo, p.qty_on_hand, p.status as product_status, o.for_date,
           count(*) filter (where o.status = 'WAITING_RESTOCK')::int as waiting,
           coalesce(sum(o.qty) filter (where o.status = 'WAITING_RESTOCK'), 0)::int as units_waiting,
           count(*) filter (where o.status in ('OFFERED', 'CHECKOUT'))::int as offered_or_checking_out,
           min(o.created_at) filter (where o.status = 'WAITING_RESTOCK') as oldest,
           array_remove(array_agg(coalesce(c.display_name, c.ref) order by o.created_at) filter (where o.status = 'WAITING_RESTOCK'), null) as names,
           r.expected_date, r.confirmed
    from opportunities o
    join products p on p.sku = o.sku
    join customers c on c.ref = o.customer_ref
    left join restocks r on r.sku = p.sku and r.status = 'OPEN'
    where o.status in ('WAITING_RESTOCK', 'OFFERED', 'CHECKOUT') and (${sku}::text is null or upper(p.sku) = upper(${sku ?? ''}))
    group by p.sku, o.for_date, r.expected_date, r.confirmed
    order by units_waiting desc, p.sku`;

  const [m] = await deps.sql`
    select
      (select count(*)::int from opportunities) as unavailable_enquiries,
      (select count(*)::int from opportunities where consent) as opportunities_captured,
      (select count(*)::int from orders where recovery_type = 'alternative' and paid_at is not null) as alternative_sales,
      (select count(*)::int from orders where recovery_type = 'restock' and paid_at is not null) as restock_sales,
      (select coalesce(sum(total_kobo), 0) from orders where recovery_type in ('alternative', 'restock') and paid_at is not null) as recovered_kobo,
      (select count(*)::int from opportunities where status in ('WAITING_RESTOCK', 'OFFERED', 'CHECKOUT')) as open_opportunities,
      (select count(*)::int from orders where status = 'DELIVERED' and recovery_type in ('alternative', 'restock')) as recovered_delivered`;

  const issues =
    await deps.sql`select ref, status, issue from orders where issue is not null or status = 'FULFILLMENT_PENDING' order by created_at desc limit 10`;
  const reminders = await deps.sql`
    select rm.id, rm.kind, rm.due_at, p.name from reminders rm join restocks r on r.id = rm.restock_id join products p on p.sku = r.sku
    where rm.status = 'ACTIVE' order by rm.due_at`;
  const unread = await deps.sql`
    update notifications set read_at = ${now}
    where recipient_type = 'owner' and read_at is null and status <> 'SKIPPED'
    returning id, reason, body, status, created_at`;

  return {
    demand: demand.map((d) => ({
      sku: d.sku,
      product: d.name,
      ...(d.for_date ? { wanted_for_date: dayLabel(isoDay(d.for_date)!), date_fully_booked: true } : { in_stock: d.qty_on_hand }),
      customers_waiting: d.waiting,
      units_requested: d.units_waiting,
      potential_sales_value: naira(BigInt(d.units_waiting) * BigInt(d.price_kobo)),
      offers_out: d.offered_or_checking_out,
      waiting_since: d.oldest ? lagosDay(new Date(d.oldest)) : null,
      waiting_customers: d.names?.slice(0, 5) ?? [],
      restock: d.expected_date
        ? { expected: new Date(d.expected_date).toISOString().slice(0, 10), confirmed: d.confirmed }
        : 'no restock date recorded',
    })),
    metrics: {
      unavailable_product_enquiries: m.unavailable_enquiries,
      opportunities_captured: m.opportunities_captured,
      alternative_sales: m.alternative_sales,
      restock_recoveries: m.restock_sales,
      recovered_revenue: naira(m.recovered_kobo),
      open_opportunities: m.open_opportunities,
      recovered_orders_delivered: m.recovered_delivered,
    },
    fulfilment_issues: issues.map((i) => ({ order_ref: i.ref, status: i.status, issue: i.issue })),
    upcoming_reminders: reminders.map((r) => ({
      reminder_id: r.id,
      product: r.name,
      kind: r.kind,
      due: lagosDateTime(new Date(r.due_at)),
    })),
    unread_alerts: unread
      .sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at))
      .map((n) => ({ ref: n.id, reason: n.reason, text: n.body })),
  };
}
