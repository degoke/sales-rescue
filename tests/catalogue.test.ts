// The owner adds a new product by chat, against the real Flavorburst catalogue (fixtures/).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectDomainError, PIN, REAL_FIXTURES, setup, type TestEnv } from './helpers.js';
import { nextSaturday } from '../src/db/seed.js';
import { addProduct } from '../src/merchant/catalogue.js';
import { checkDates, searchProducts } from '../src/merchant/products.js';
import { reserveProduct } from '../src/merchant/reservations.js';

let env: TestEnv;
afterEach(async () => env?.close());
beforeEach(async () => {
  env = await setup({ fixturesDir: REAL_FIXTURES });
});

const bento = {
  name: 'Red Velvet Bento',
  price: 12000,
  category: 'Bento cakes',
  fulfilment: 'made_to_order' as const,
  capacity_group: 'bentos',
  lead_time_days: 1,
  colour: 'Red',
};

describe('add_product', () => {
  it('needs the owner PIN', async () => {
    await expectDomainError(addProduct(env.deps, { ...bento, confirm: true }), 'owner_auth_required');
  });

  it('previews first and writes nothing; confirm adds it, and customers can find and reserve it', async () => {
    const preview: any = await addProduct(env.deps, { pin: PIN, ...bento });
    expect(preview).toMatchObject({ needs_confirmation: true, preview: { sku: 'FB-RED-VELVET-BENTO', price: '₦12,000' } });
    expect((await env.sql`select count(*)::int as n from products where name = 'Red Velvet Bento'`)[0].n).toBe(0);

    const added: any = await addProduct(env.deps, { pin: PIN, ...bento, confirm: true });
    expect(added).toMatchObject({ added: true, product: { sku: 'FB-RED-VELVET-BENTO' } });
    expect(added.product.image_url).toMatch(/\/products\/FB-RED-VELVET-BENTO\.svg$/);

    const found = await searchProducts(env.deps, { query: 'red velvet bento' });
    expect(found.matches[0]).toMatchObject({ sku: 'FB-RED-VELVET-BENTO', fulfilment: 'made_to_order', status: 'made_to_order' });
    const day = (found.matches[0] as any).next_available_dates[0].date;
    const hold = await reserveProduct(env.deps, { customer_ref: '+2348000000001', sku: 'FB-RED-VELVET-BENTO', for_date: day });
    expect(hold).toMatchObject({ for_date: day });
  });

  it('a new cake shares the daily cake limit, so a full Saturday is full for it too', async () => {
    await addProduct(env.deps, {
      pin: PIN,
      name: 'Coconut Dream Cake',
      price: 40000,
      category: 'Celebration cakes',
      fulfilment: 'made_to_order',
      capacity_group: 'cakes',
      lead_time_days: 2,
      confirm: true,
    });
    const r: any = await checkDates(env.deps, { sku: 'FB-COCONUT-DREAM', date: nextSaturday(env.deps.now()) });
    expect(r.requested).toMatchObject({ bookable: false, reason: 'fully_booked' });
  });

  it('a stock item needs a quantity and goes on sale at once', async () => {
    const base = { pin: PIN, name: 'Coconut Chin-Chin Jar', price: 7000, category: 'Chin-chin', fulfilment: 'stock' as const };
    await expectDomainError(addProduct(env.deps, { ...base, confirm: true }), 'qty_required');
    await addProduct(env.deps, { ...base, qty: 10, confirm: true });
    const found = await searchProducts(env.deps, { query: 'coconut chin-chin jar' });
    expect(found.matches[0]).toMatchObject({ name: 'Coconut Chin-Chin Jar', available: 10, status: 'in_stock' });
  });

  it('refuses duplicates, unknown groups and non-https photo links', async () => {
    await expectDomainError(addProduct(env.deps, { ...bento, pin: PIN, name: 'bento delights (4 inch)', confirm: true }), 'product_exists');
    const unknown = await expectDomainError(
      addProduct(env.deps, { ...bento, pin: PIN, capacity_group: 'pies', confirm: true }),
      'unknown_group',
    );
    expect(unknown.details.groups.map((g: any) => g.group)).toContain('bentos');
    await expectDomainError(
      addProduct(env.deps, { ...bento, pin: PIN, image_url: 'http://example.com/a.jpg', confirm: true }),
      'invalid_image_url',
    );
  });
});
