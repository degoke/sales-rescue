// The owner adds a new product by chat, against the real Flavorburst catalogue (fixtures/).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectDomainError, PIN, REAL_FIXTURES, setup, type TestEnv } from './helpers.js';
import { nextSaturday } from '../src/db/seed.js';
import { type AddProductInput, addProduct } from '../src/merchant/catalogue.js';
import { updateInventory } from '../src/merchant/inventory.js';
import { checkDates, searchProducts } from '../src/merchant/products.js';
import { reserveProduct } from '../src/merchant/reservations.js';

let env: TestEnv;
afterEach(async () => env?.close());
beforeEach(async () => {
  env = await setup({ fixturesDir: REAL_FIXTURES });
});

const bento = {
  pin: PIN,
  name: 'Red Velvet Bento',
  price: 12000,
  category: 'Bento cakes',
  fulfilment: 'made_to_order' as const,
  capacity_group: 'bentos',
  lead_time_days: 1,
  colour: 'Red',
};

/** Preview, then confirm with the confirmation_id from the preview (what the agent does). */
async function addConfirmed(input: AddProductInput) {
  const preview: any = await addProduct(env.deps, input);
  return addProduct(env.deps, { ...input, confirmation_id: preview.confirmation_id });
}

describe('add_product', () => {
  it('needs the owner PIN', async () => {
    await expectDomainError(addProduct(env.deps, { ...bento, pin: undefined }), 'owner_auth_required');
  });

  it('previews first and writes nothing; confirm adds it, and customers can find and reserve it', async () => {
    const preview: any = await addProduct(env.deps, bento);
    expect(preview).toMatchObject({ needs_confirmation: true, preview: { sku: 'FB-RED-VELVET-BENTO', price: '₦12,000' } });
    expect(preview.confirmation_id).toMatch(/^ADD-[0-9a-f]{16}$/);
    expect((await env.sql`select count(*)::int as n from products where name = 'Red Velvet Bento'`)[0].n).toBe(0);

    const added: any = await addProduct(env.deps, { ...bento, confirmation_id: preview.confirmation_id });
    expect(added).toMatchObject({ added: true, product: { sku: 'FB-RED-VELVET-BENTO' } });
    expect(added.product.image_url).toMatch(/\/products\/FB-RED-VELVET-BENTO\.svg$/);
    const [audit] = await env.sql`select op, after_price_kobo, status from inventory_changes where sku = 'FB-RED-VELVET-BENTO'`;
    expect(audit).toMatchObject({ op: 'add', after_price_kobo: 1200000n, status: 'APPLIED' });

    const found = await searchProducts(env.deps, { query: 'red velvet bento' });
    expect(found.matches[0]).toMatchObject({ sku: 'FB-RED-VELVET-BENTO', fulfilment: 'made_to_order', status: 'made_to_order' });
    const day = (found.matches[0] as any).next_available_dates[0].date;
    const hold = await reserveProduct(env.deps, { customer_ref: '+2348000000001', sku: 'FB-RED-VELVET-BENTO', for_date: day });
    expect(hold).toMatchObject({ for_date: day });
  });

  it('refuses a confirmation that does not match the previewed details', async () => {
    const preview: any = await addProduct(env.deps, bento);
    await expectDomainError(addProduct(env.deps, { ...bento, confirmation_id: 'ADD-0000000000000000' }), 'invalid_confirmation');
    await expectDomainError(
      addProduct(env.deps, { ...bento, price: 15000, confirmation_id: preview.confirmation_id }),
      'invalid_confirmation',
    );
    expect((await env.sql`select count(*)::int as n from products where name = 'Red Velvet Bento'`)[0].n).toBe(0);
  });

  it('a new cake shares the daily cake limit, so a full Saturday is full for it too', async () => {
    await addConfirmed({
      pin: PIN,
      name: 'Coconut Dream Cake',
      price: 40000,
      category: 'Celebration cakes',
      fulfilment: 'made_to_order',
      capacity_group: 'cakes',
      lead_time_days: 2,
    });
    const r: any = await checkDates(env.deps, { sku: 'FB-COCONUT-DREAM', date: nextSaturday(env.deps.now()) });
    expect(r.requested).toMatchObject({ bookable: false, reason: 'fully_booked' });
  });

  it('a stock item needs a quantity and goes on sale at once', async () => {
    const base = { pin: PIN, name: 'Coconut Chin-Chin Jar', price: 7000, category: 'Chin-chin', fulfilment: 'stock' as const };
    await expectDomainError(addProduct(env.deps, base), 'qty_required');
    await addConfirmed({ ...base, qty: 10 });
    const found = await searchProducts(env.deps, { query: 'coconut chin-chin jar' });
    expect(found.matches[0]).toMatchObject({ name: 'Coconut Chin-Chin Jar', available: 10, status: 'in_stock' });
  });

  it('refuses duplicates, unknown groups and non-https photo links', async () => {
    await expectDomainError(addProduct(env.deps, { ...bento, name: 'bento delights (4 inch)' }), 'product_exists');
    const unknown = await expectDomainError(addProduct(env.deps, { ...bento, capacity_group: 'pies' }), 'unknown_group');
    expect(unknown.details.groups.map((g: any) => g.group)).toContain('bentos');
    await expectDomainError(addProduct(env.deps, { ...bento, image_url: 'http://example.com/a.jpg' }), 'invalid_image_url');
  });

  it('a discontinued product points to reactivate, which puts it back on sale', async () => {
    // Two chat turns: the agent cannot see the first confirmation_id, so asking again must return the same one.
    const first: any = await updateInventory(env.deps, { pin: PIN, sku: 'FB-CAKE-BOMB', op: 'discontinue' });
    const second: any = await updateInventory(env.deps, { pin: PIN, sku: 'FB-CAKE-BOMB', op: 'discontinue' });
    expect(first.needs_confirmation).toBe(true);
    expect(second.confirmation_id).toBe(first.confirmation_id);
    await updateInventory(env.deps, { pin: PIN, sku: 'FB-CAKE-BOMB', op: 'discontinue', confirmation_id: second.confirmation_id });

    const again = await expectDomainError(
      addProduct(env.deps, { pin: PIN, name: 'Lux Cake Bomb', price: 4000, category: 'Cake tubs', fulfilment: 'stock', qty: 4 }),
      'product_discontinued',
    );
    expect(again.details.sku).toBe('FB-CAKE-BOMB');

    await updateInventory(env.deps, { pin: PIN, sku: 'FB-CAKE-BOMB', op: 'reactivate' });
    const found = await searchProducts(env.deps, { query: 'lux cake bomb' });
    expect(found.matches[0]).toMatchObject({ sku: 'FB-CAKE-BOMB', status: 'in_stock' });
    await expectDomainError(updateInventory(env.deps, { pin: PIN, sku: 'FB-CAKE-BOMB', op: 'reactivate' }), 'already_active');
  });
});
