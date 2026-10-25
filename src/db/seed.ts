import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Sql } from './client.js';
import { nextRef } from './client.js';
import { hashPin } from '../merchant/owner.js';
import { insertProduct } from '../merchant/products.js';
import { addDays, lagosToday } from '../lib/time.js';

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  for (const line of text.trim().split(/\r?\n/)) {
    const cells: string[] = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"' && line[i + 1] === '"' && quoted) {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = !quoted;
      else if (ch === ',' && !quoted) {
        cells.push(cur);
        cur = '';
      } else cur += ch;
    }
    cells.push(cur);
    rows.push(cells);
  }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

/** Loads the demo merchant: catalogue, owner (PIN from env, never from the repo) and waiting customers. */
export async function seed(sql: Sql, opts: { ownerPin: string; fixturesDir?: string; now?: Date }) {
  // Resolved from this module (src/db or dist/db), not the working directory.
  const dir = opts.fixturesDir ?? fileURLToPath(new URL('../../fixtures', import.meta.url));
  const now = opts.now ?? new Date();
  const m = JSON.parse(readFileSync(`${dir}/merchant.json`, 'utf8'));
  await sql`insert into merchant (id, name, owner_name, owner_phone, owner_pin_hash, timezone, hold_minutes, offer_hold_minutes,
                                  demand_threshold, large_qty_change, large_price_change_pct)
            values (1, ${m.name}, ${m.owner_name}, ${m.owner_phone}, ${hashPin(opts.ownerPin)}, ${m.timezone}, ${m.hold_minutes},
                    ${m.offer_hold_minutes}, ${m.demand_threshold}, ${m.large_qty_change}, ${m.large_price_change_pct})`;

  // Made-to-order baking capacity (optional: a stock-only catalogue has none).
  if (existsSync(`${dir}/capacity.json`)) {
    for (const g of JSON.parse(readFileSync(`${dir}/capacity.json`, 'utf8'))) {
      await sql`insert into capacity_groups (code, name, daily_slots) values (${g.code}, ${g.name}, ${g.daily_slots})`;
    }
  }

  for (const p of parseCsv(readFileSync(`${dir}/catalogue.csv`, 'utf8'))) {
    const added = await insertProduct(sql, {
      sku: p.sku,
      name: p.name,
      category: p.category,
      colour: p.colour,
      style: p.style,
      description: p.description,
      price_kobo: BigInt(Math.round(Number(p.price_ngn) * 100)),
      qty_on_hand: Number(p.quantity),
      image_url: p.image_url || null,
      fulfilment: (p.fulfilment || 'stock') as 'stock' | 'made_to_order',
      capacity_group: p.capacity_group || null,
      lead_time_days: Number(p.lead_time_days || 0),
    });
    if (!added) throw new Error(`Duplicate SKU in catalogue.csv: ${p.sku}`);
  }

  const customers = JSON.parse(readFileSync(`${dir}/customers.json`, 'utf8'));
  for (const c of customers) {
    const at = new Date(now.getTime() - c.days_ago * 86_400_000);
    await sql`insert into customers (ref, display_name, notify_consent, created_at) values (${c.ref}, ${c.display_name}, true, ${at})`;
    if (c.waiting_for) {
      const id = await nextRef(sql, 'OPP');
      await sql`insert into opportunities (id, customer_ref, sku, qty, status, consent, next_action, next_action_owner, created_at, updated_at)
                values (${id}, ${c.ref}, ${c.waiting_for}, 1, 'WAITING_RESTOCK', true, 'Restock, then offer to this customer', 'owner', ${at}, ${at})`;
    }
  }

  // Existing paid made-to-order bookings (e.g. fully booked Saturdays), as converted holds.
  // "saturdays" books the next `weeks` Saturdays, so a database seeded once (as on Railway) still
  // has a full Saturday ahead weeks later.
  if (existsSync(`${dir}/bookings.json`)) {
    for (const b of JSON.parse(readFileSync(`${dir}/bookings.json`, 'utf8'))) {
      const days: string[] =
        b.date === 'saturdays'
          ? Array.from({ length: b.weeks ?? 1 }, (_, i) => addDays(nextSaturday(now), 7 * i))
          : [b.date === 'next_saturday' ? nextSaturday(now) : b.date];
      await sql`insert into customers (ref, display_name, notify_consent) values (${b.ref}, ${b.display_name}, false)
                on conflict (ref) do nothing`;
      const [p] = await sql`select price_kobo from products where sku = ${b.sku}`;
      for (const day of days) {
        const id = await nextRef(sql, 'RSV');
        await sql`insert into reservations (id, sku, customer_ref, qty, unit_price_kobo, kind, status, expires_at, closed_at, for_date, notes)
                  values (${id}, ${b.sku}, ${b.ref}, ${b.qty}, ${p.price_kobo.toString()}, 'customer', 'CONVERTED', ${now}, ${now}, ${day}, ${b.notes ?? null})`;
      }
    }
  }
}

/** The first Saturday at least 3 days away (the longest lead time), so it's always past every lead time. */
export function nextSaturday(now: Date) {
  let day = addDays(lagosToday(now), 3);
  while (new Date(`${day}T12:00:00Z`).getUTCDay() !== 6) day = addDays(day, 1);
  return day;
}
