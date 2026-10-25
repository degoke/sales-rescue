// Owner adds a new product by chat ("add my new red velvet bento, ₦12,000"). Two calls: the first
// returns a preview and a confirmation_id; the second, with that confirmation_id, writes it. The ID is
// a hash of the exact details (SKU included), so the write is always what the owner heard read back.
import { createHash } from 'node:crypto';
import { nextRef } from '../db/client.js';
import type { Deps } from '../deps.js';
import { fail } from '../lib/errors.js';
import { naira, nairaToKobo } from '../lib/money.js';
import { cleanText } from '../lib/security.js';
import { requireOwner } from './owner.js';
import { productImageUrl } from './product-image.js';
import { insertProduct, type NewProduct } from './products.js';

const MAX_PRICE_NGN = 10_000_000;
const MAX_SKU = 20; // the /products/:file image route accepts SKUs of up to 20 characters

export type AddProductInput = {
  owner_token?: string;
  pin?: string;
  name: string;
  price: number;
  category: string;
  fulfilment: 'stock' | 'made_to_order';
  qty?: number;
  capacity_group?: string;
  lead_time_days?: number;
  colour?: string;
  description?: string;
  image_url?: string;
  confirmation_id?: string;
};

/** A SKU from the shop's prefix and the product name, e.g. "FB-RED-VELVET-BENTO" (max 20 chars). */
async function newSku(db: Deps['sql'], name: string) {
  const [first] = await db<{ sku: string }[]>`select sku from products order by sku limit 1`;
  const prefix = (first?.sku.includes('-') ? first.sku.split('-')[0] : 'SKU').slice(0, 8);
  const words = name
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  // Whole words only, so a SKU never ends in a cut word ("FB-COCONUT-DREAM", not "FB-COCONUT-DREAM-CAK").
  const skuWithin = (max: number) => {
    let sku = prefix;
    for (const w of words.length ? words : ['ITEM']) {
      if (`${sku}-${w}`.length > max) break;
      sku = `${sku}-${w}`;
    }
    return sku === prefix ? `${prefix}-${(words[0] ?? 'ITEM').slice(0, Math.max(1, max - prefix.length - 1))}` : sku;
  };
  // One query for the SKUs already taken under this prefix, then find a free suffix in memory.
  const taken = new Set(
    (await db<{ sku: string }[]>`select upper(sku) as sku from products where starts_with(upper(sku), ${`${prefix.toUpperCase()}-`})`).map(
      (r) => r.sku,
    ),
  );
  for (let n = 1; n < 100; n++) {
    const candidate = n === 1 ? skuWithin(MAX_SKU) : `${skuWithin(MAX_SKU - String(n).length - 1)}-${n}`;
    if (!taken.has(candidate.toUpperCase())) return candidate;
  }
  return fail('sku_unavailable', 'Could not make a unique SKU for this name. Use a more specific name.');
}

const confirmationFor = (row: NewProduct) =>
  `ADD-${createHash('sha256')
    .update(JSON.stringify({ ...row, price_kobo: row.price_kobo.toString() }))
    .digest('hex')
    .slice(0, 16)}`;

export async function addProduct(deps: Deps, input: AddProductInput) {
  await requireOwner(deps, input.owner_token, input.pin);

  const name = cleanText(input.name, 60);
  const category = cleanText(input.category, 40);
  if (!name || name.length < 2) fail('invalid_name', 'Give the product a name of at least 2 characters.');
  if (!category || category.length < 2) fail('invalid_category', 'Give a category, for example "Bento cakes" or "Chin-chin".');
  if (!(input.price > 0) || input.price > MAX_PRICE_NGN) fail('invalid_price', 'Give the price in naira, for example 12000.');
  if (input.image_url && !/^https:\/\/\S{4,290}$/.test(input.image_url)) {
    fail('invalid_image_url', 'The photo link must start with https://.');
  }

  let qty = 0;
  let group: string | null = null;
  let leadTime = 0;
  if (input.fulfilment === 'stock') {
    if (input.capacity_group) fail('invalid_fulfilment', 'A stock item has a quantity, not a capacity group.');
    if (!Number.isInteger(input.qty) || input.qty! < 0) fail('qty_required', 'How many are there now? Give qty as 0 or more.');
    qty = input.qty!;
  } else {
    const groups = await deps.sql<{ code: string; name: string }[]>`select code, name from capacity_groups order by code`;
    group =
      groups.find((g) => g.code === input.capacity_group)?.code ??
      fail('unknown_group', 'Which daily limit does it share? Pick a capacity group.', {
        groups: groups.map((g) => ({ group: g.code, name: g.name })),
      });
    leadTime = input.lead_time_days ?? 1;
    if (!Number.isInteger(leadTime) || leadTime < 0 || leadTime > 30) fail('invalid_lead_time', 'Notice must be 0 to 30 days.');
  }

  const [dupe] = await deps.sql<{ sku: string; status: string }[]>`select sku, status from products where lower(name) = lower(${name!})`;
  if (dupe?.status === 'DISCONTINUED') {
    fail(
      'product_discontinued',
      `"${name}" is on the menu as ${dupe.sku}, but it is discontinued. Use update_inventory with op "reactivate" to sell it again.`,
      { sku: dupe.sku },
    );
  }
  if (dupe)
    fail('product_exists', `"${name}" is already on the menu as ${dupe.sku}. Use update_inventory to change it.`, { sku: dupe.sku });

  const row: NewProduct = {
    sku: await newSku(deps.sql, name!),
    name: name!,
    category: category!,
    colour: cleanText(input.colour, 20) ?? 'Mixed',
    style: category!,
    description: cleanText(input.description, 200) ?? '',
    price_kobo: nairaToKobo(input.price),
    qty_on_hand: qty,
    image_url: input.image_url ?? null,
    fulfilment: input.fulfilment,
    capacity_group: group,
    lead_time_days: leadTime,
  };
  const preview = {
    sku: row.sku,
    name: row.name,
    category: row.category,
    price: naira(row.price_kobo),
    fulfilment: row.fulfilment,
    ...(row.fulfilment === 'stock' ? { qty: row.qty_on_hand } : { capacity_group: group, lead_time_days: leadTime }),
    image_url: productImageUrl(deps.publicBaseUrl, row),
  };
  const confirmationId = confirmationFor(row);

  if (!input.confirmation_id) {
    return {
      needs_confirmation: true,
      confirmation_id: confirmationId,
      preview,
      message: `Read these details back to the owner. If they agree, call add_product again with the same details and confirmation_id ${confirmationId}.`,
    };
  }
  if (input.confirmation_id !== confirmationId) {
    fail('invalid_confirmation', 'The details or the SKU changed since the preview. Preview again and read the new details back.', {
      preview,
    });
  }

  await deps.sql.begin(async (tx) => {
    if (!(await insertProduct(tx, row))) fail('product_exists', 'That product was just added. Search for it before you add it again.');
    // Same audit trail as update_inventory: every owner change to the menu has a row.
    await tx`insert into inventory_changes (id, sku, op, value, before_qty, after_qty, before_price_kobo, after_price_kobo, status, applied_at)
             values (${await nextRef(tx, 'CHG')}, ${row.sku}, 'add', ${row.qty_on_hand}, 0, ${row.qty_on_hand}, 0,
                     ${row.price_kobo.toString()}, 'APPLIED', ${deps.now()})`;
  });
  return { added: true, product: preview, message: `${row.name} is on the menu now. Customers can find and order it.` };
}
