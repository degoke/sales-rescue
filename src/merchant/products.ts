import type { Db } from '../db/client.js';
import type { Deps } from '../deps.js';
import { fail } from '../lib/errors.js';
import { naira } from '../lib/money.js';
import { addDays, dayLabel, isIsoDate, lagosToday } from '../lib/time.js';
import { productImageUrl } from './product-image.js';

export type ProductRow = {
  sku: string;
  name: string;
  category: string;
  colour: string;
  style: string;
  description: string;
  price_kobo: bigint;
  qty_on_hand: number;
  status: 'ACTIVE' | 'DISCONTINUED';
  image_url: string | null;
  fulfilment: 'stock' | 'made_to_order';
  capacity_group: string | null;
  lead_time_days: number;
  updated_at?: Date;
};

/** Units held for customers right now. Expired holds are ignored even before the sweeper closes them. */
export async function heldQty(db: Db, sku: string, now: Date) {
  const [{ held }] = await db<{ held: number }[]>`
    select coalesce(sum(qty), 0)::int as held from reservations
    where sku = ${sku} and status = 'HELD' and expires_at > ${now}`;
  return held;
}

export async function lockProduct(db: Db, sku: string): Promise<ProductRow> {
  const [p] = await db<ProductRow[]>`select * from products where upper(sku) = upper(${sku}) for update`;
  if (!p) fail('unknown_product', `No product with SKU "${sku}". Use search_products to find the right one.`);
  return p;
}

// ── Made-to-order: daily production capacity ───────────────────────────────────────────────────

/** Booked = converted holds (paid orders) plus live holds, for every product sharing the group. */
export async function slotsFree(db: Db, group: string, day: string, now: Date) {
  const [g] = await db<{ slots: number }[]>`
    select coalesce(o.slots, g.daily_slots) as slots from capacity_groups g
    left join capacity_overrides o on o.group_code = g.code and o.day = ${day}
    where g.code = ${group}`;
  if (!g) return 0;
  const [{ booked }] = await db<{ booked: number }[]>`
    select coalesce(sum(r.qty), 0)::int as booked from reservations r join products p on p.sku = r.sku
    where p.capacity_group = ${group} and r.for_date = ${day}
      and (r.status = 'CONVERTED' or (r.status = 'HELD' and r.expires_at > ${now}))`;
  return Math.max(0, g.slots - booked);
}

/** Earliest date the bakery can make this (today in Lagos + lead time). */
export const earliestDay = (p: Pick<ProductRow, 'lead_time_days'>, now: Date) => addDays(lagosToday(now), p.lead_time_days);

/** The next dates with at least `qty` free slots, from `from` (default: earliest) over three weeks. */
export async function nextFreeDays(db: Db, p: ProductRow, now: Date, opts: { from?: string; qty?: number; count?: number } = {}) {
  const earliest = earliestDay(p, now);
  let day = opts.from && opts.from > earliest ? opts.from : earliest;
  const out: { date: string; label: string; slots_free: number }[] = [];
  for (let i = 0; i < 21 && out.length < (opts.count ?? 4); i++, day = addDays(day, 1)) {
    const free = await slotsFree(db, p.capacity_group!, day, now);
    if (free >= (opts.qty ?? 1)) out.push({ date: day, label: dayLabel(day), slots_free: free });
  }
  return out;
}

/**
 * Free dates closest to the one the customer asked for, on either side of it (never before the
 * earliest bookable day), in date order. One list, so the agent never has to stitch together
 * "before" and "after" results and can't leave a gap.
 */
export async function datesNear(db: Db, p: ProductRow, now: Date, day: string, opts: { qty?: number; count?: number } = {}) {
  const earliest = earliestDay(p, now);
  const start = [addDays(day, -3), earliest].sort()[1]; // the later of the two ISO dates
  const free: FreeDay[] = [];
  for (let i = 0, d = start; i < 21; i++, d = addDays(d, 1)) {
    if (d === day) continue;
    const n = await slotsFree(db, p.capacity_group!, d, now);
    if (n >= (opts.qty ?? 1)) free.push({ date: d, label: dayLabel(d), slots_free: n });
  }
  const gap = (d: string) => Math.abs(Date.parse(d) - Date.parse(day));
  return free
    .sort((x, y) => gap(x.date) - gap(y.date) || x.date.localeCompare(y.date))
    .slice(0, opts.count ?? 5)
    .sort((x, y) => x.date.localeCompare(y.date));
}

export type NewProduct = Pick<
  ProductRow,
  | 'sku'
  | 'name'
  | 'category'
  | 'colour'
  | 'style'
  | 'description'
  | 'price_kobo'
  | 'qty_on_hand'
  | 'image_url'
  | 'fulfilment'
  | 'capacity_group'
  | 'lead_time_days'
>;

/** The one place that inserts a product (seed and add_product). Returns false when the SKU exists. */
export async function insertProduct(db: Db, p: NewProduct) {
  const rows = await db`
    insert into products (sku, name, category, colour, style, description, price_kobo, qty_on_hand, image_url,
                          fulfilment, capacity_group, lead_time_days)
    values (${p.sku}, ${p.name}, ${p.category}, ${p.colour}, ${p.style}, ${p.description}, ${p.price_kobo.toString()},
            ${p.qty_on_hand}, ${p.image_url}, ${p.fulfilment}, ${p.capacity_group}, ${p.lead_time_days})
    on conflict (sku) do nothing
    returning sku`;
  return rows.length > 0;
}

export async function lockCapacityGroup(db: Db, group: string) {
  await db`select code from capacity_groups where code = ${group} for update`;
}

type FreeDay = { date: string; label: string; slots_free: number };

/**
 * What the agent sees for a product. Stock items report units available now; made-to-order items
 * report their lead time and the next dates with free baking slots instead.
 */
export function productView(p: ProductRow, available: number, publicBaseUrl: string, nextDays: FreeDay[] = []) {
  const base = {
    sku: p.sku,
    name: p.name,
    category: p.category,
    colour: p.colour,
    style: p.style,
    description: p.description,
    price: naira(p.price_kobo),
    price_kobo: Number(p.price_kobo),
    image_url: productImageUrl(publicBaseUrl, p),
    fulfilment: p.fulfilment,
  };
  if (p.fulfilment === 'made_to_order') {
    return {
      ...base,
      available: nextDays[0]?.slots_free ?? 0,
      status: p.status === 'DISCONTINUED' ? 'discontinued' : nextDays.length ? 'made_to_order' : 'fully_booked',
      lead_time_days: p.lead_time_days,
      next_available_dates: nextDays,
    };
  }
  return {
    ...base,
    available,
    status: p.status === 'DISCONTINUED' ? 'discontinued' : available <= 0 ? 'sold_out' : available <= 2 ? 'low_stock' : 'in_stock',
  };
}

const words = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
const STOP = new Set([
  'the',
  'and',
  'from',
  'your',
  'you',
  'have',
  'do',
  'any',
  'one',
  'for',
  'with',
  'in',
  'of',
  'a',
  'my',
  'post',
  'instagram',
]);

/**
 * Lookup plus real alternatives. When the best match can't be sold right now, rank in-stock
 * products by similarity: category > colour > price band > style.
 */
export async function searchProducts(deps: Deps, input: { query: string; colour?: string; category?: string; max_price?: number }) {
  const now = deps.now();
  const rows = await deps.sql<(ProductRow & { held: number })[]>`
    select p.*, coalesce((select sum(qty) from reservations r
                          where r.sku = p.sku and r.status = 'HELD' and r.expires_at > ${now}), 0)::int as held
    from products p order by p.sku`;
  const items = await Promise.all(
    rows.map(async (r) => ({
      row: r,
      view: productView(
        r,
        Math.max(0, r.qty_on_hand - r.held),
        deps.publicBaseUrl,
        r.fulfilment === 'made_to_order' && r.status === 'ACTIVE' ? await nextFreeDays(deps.sql, r, now, { count: 3 }) : [],
      ),
    })),
  );

  const q = words(`${input.query} ${input.colour ?? ''} ${input.category ?? ''}`);
  const scored = items
    .map((it) => {
      const hay = `${it.row.sku} ${it.row.name} ${it.row.category} ${it.row.colour} ${it.row.style} ${it.row.description}`.toLowerCase();
      const nameHits = q.filter((w) => `${it.row.sku} ${it.row.name}`.toLowerCase().includes(w)).length;
      const anyHits = q.filter((w) => hay.includes(w)).length;
      return { ...it, score: nameHits * 2 + anyHits };
    })
    .filter((it) => it.score > 0)
    .filter((it) => (input.max_price ? it.view.price_kobo <= input.max_price * 100 : true))
    .sort((a, b) => b.score - a.score);

  const matches = scored.slice(0, 3).map((s) => s.view);
  const best = scored[0];

  let alternatives: ReturnType<typeof productView>[] = [];
  if (!best || best.view.available <= 0 || best.row.status !== 'ACTIVE') {
    const ref = best?.row;
    alternatives = items
      .filter((it) => it.row.status === 'ACTIVE' && it.view.available > 0 && it.row.sku !== ref?.sku)
      .map((it) => {
        let s = 0;
        if (ref) {
          if (it.row.category === ref.category) s += 3;
          if (it.row.colour === ref.colour) s += 2;
          if (Math.abs(Number(it.row.price_kobo - ref.price_kobo)) <= Number(ref.price_kobo) * 0.25) s += 1;
          if (it.row.style === ref.style) s += 1;
        } else {
          s = q.filter((w) => `${it.row.name} ${it.row.category} ${it.row.colour}`.toLowerCase().includes(w)).length;
        }
        return { s, view: it.view };
      })
      .filter((a) => a.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 3)
      .map((a) => a.view);
  }

  return {
    matches,
    alternatives,
    note:
      matches.length === 0
        ? 'No product matched. Ask the customer to describe it differently (colour, style, or the post it was in).'
        : best && best.view.available <= 0
          ? 'Best match is not available. Offer the alternatives (they are available now), or offer to add the customer to the restock list with their consent.'
          : best?.row.fulfilment === 'made_to_order'
            ? 'Made to order: ask which date they need, then call check_dates. Never promise a date the tool did not return.'
            : undefined,
  };
}

/**
 * "Can you make it for Saturday?" Checks the lead time and the free baking slots on the requested
 * date, and always returns the next dates that do have room.
 */
export async function checkDates(deps: Deps, input: { sku: string; date?: string; qty?: number }) {
  const now = deps.now();
  const qty = input.qty ?? 1;
  const [p] = await deps.sql<ProductRow[]>`select * from products where upper(sku) = upper(${input.sku})`;
  if (!p) fail('unknown_product', `No product with SKU "${input.sku}". Use search_products to find the right one.`);
  if (p.fulfilment !== 'made_to_order') fail('not_made_to_order', `${p.name} is sold from stock; use search_products for availability.`);
  if (p.status !== 'ACTIVE') fail('discontinued', `${p.name} is no longer available.`);
  const earliest = earliestDay(p, now);

  let requested: Record<string, unknown> | null = null;
  if (input.date) {
    if (!isIsoDate(input.date)) fail('invalid_date', 'Give the date as YYYY-MM-DD (work it out from today in Lagos).');
    if (input.date < earliest) {
      requested = { date: input.date, label: dayLabel(input.date), bookable: false, reason: 'too_soon' };
    } else {
      const free = await slotsFree(deps.sql, p.capacity_group!, input.date, now);
      requested = {
        date: input.date,
        label: dayLabel(input.date),
        slots_free: free,
        bookable: free >= qty,
        reason: free >= qty ? null : 'fully_booked',
      };
    }
  }
  const available =
    requested && !requested.bookable
      ? await datesNear(deps.sql, p, now, input.date!, { qty })
      : await nextFreeDays(deps.sql, p, now, { qty, count: 4 });
  return {
    sku: p.sku,
    product: p.name,
    price: naira(p.price_kobo),
    lead_time_days: p.lead_time_days,
    earliest_date: { date: earliest, label: dayLabel(earliest) },
    requested,
    available_dates: available,
    note:
      requested?.reason === 'too_soon'
        ? `${p.name} needs ${p.lead_time_days} day(s) notice. Offer the earliest date (available_dates lists the next free ones), or a ready-made treat (search_products) for sooner.`
        : requested?.reason === 'fully_booked'
          ? 'That date is fully booked. available_dates are the free dates closest to it (before and after). Offer those, a ready-made treat for that day, or the waiting list for that date (with consent) in case a slot opens.'
          : requested?.bookable
            ? 'Free: hold it now with reserve_product (for_date, notes), then read the details back.'
            : undefined,
  };
}
