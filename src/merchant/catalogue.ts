// Owner adds a new product by chat ("add my new red velvet bento, ₦12,000"). Two calls: the first
// returns a preview to read back; the second, with confirm: true, writes it. No stored state is
// needed, because the product does not exist until the second call.
import type { Deps } from '../deps.js';
import { fail } from '../lib/errors.js';
import { naira, nairaToKobo } from '../lib/money.js';
import { cleanText } from '../lib/security.js';
import { requireOwner } from './owner.js';
import { productImageUrl } from './product-image.js';

const MAX_PRICE_NGN = 10_000_000;

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
  confirm?: boolean;
};

/** A SKU from the shop's prefix and the product name, e.g. "FB-RED-VELVET-BENTO" (max 20 chars). */
async function newSku(db: Deps['sql'], name: string) {
  const [first] = await db<{ sku: string }[]>`select sku from products order by sku limit 1`;
  const prefix = first?.sku.includes('-') ? first.sku.split('-')[0] : 'SKU';
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
    return sku === prefix ? `${prefix}-${(words[0] ?? 'ITEM').slice(0, max - prefix.length - 1)}` : sku;
  };
  for (let n = 1; n < 100; n++) {
    const candidate = n === 1 ? skuWithin(20) : `${skuWithin(20 - String(n).length - 1)}-${n}`;
    const [taken] = await db`select 1 from products where upper(sku) = ${candidate}`;
    if (!taken) return candidate;
  }
  return fail('sku_unavailable', 'Could not make a unique SKU for this name. Use a more specific name.');
}

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

  const [dupe] = await deps.sql<{ sku: string }[]>`select sku from products where lower(name) = lower(${name!})`;
  if (dupe)
    fail('product_exists', `"${name}" is already on the menu as ${dupe.sku}. Use update_inventory to change it.`, { sku: dupe.sku });

  const row = {
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

  if (!input.confirm) {
    return {
      needs_confirmation: true,
      preview,
      message: 'Read these details back to the owner. If they agree, call add_product again with the same details and confirm: true.',
    };
  }

  const inserted = await deps.sql`
    insert into products (sku, name, category, colour, style, description, price_kobo, qty_on_hand, image_url,
                          fulfilment, capacity_group, lead_time_days)
    values (${row.sku}, ${row.name}, ${row.category}, ${row.colour}, ${row.style}, ${row.description},
            ${row.price_kobo.toString()}, ${row.qty_on_hand}, ${row.image_url}, ${row.fulfilment}, ${row.capacity_group},
            ${row.lead_time_days})
    on conflict (sku) do nothing
    returning sku`;
  if (!inserted.length) fail('product_exists', 'That product was just added. Search for it before you add it again.');
  return { added: true, product: preview, message: `${row.name} is on the menu now. Customers can find and order it.` };
}
