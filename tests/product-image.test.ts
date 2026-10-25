import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setup, type TestEnv } from './helpers.js';
import { searchProducts } from '../src/merchant/products.js';
import { productImageUrl, renderProductCard } from '../src/merchant/product-image.js';

let env: TestEnv;
afterEach(async () => env?.close());

describe('product images as links (the chat channels are text-only)', () => {
  beforeEach(async () => {
    env = await setup();
  });

  it('every search result carries an image_url, and alternatives too', async () => {
    const r = await searchProducts(env.deps, { query: 'brown shoulder bag' });
    expect(r.matches[0].image_url).toBe('https://example.test/products/KB-001.svg');
    expect(r.alternatives.every((a) => a.image_url.startsWith('https://example.test/products/'))).toBe(true);
  });

  it("a merchant's own photo URL takes priority over the generated card", async () => {
    await env.sql`update products set image_url = 'https://cdn.example.com/kb-002.jpg' where sku = 'KB-002'`;
    const r = await searchProducts(env.deps, { query: 'tan leather shoulder bag' });
    expect(r.matches[0]).toMatchObject({ sku: 'KB-002', image_url: 'https://cdn.example.com/kb-002.jpg' });
  });
});

describe('generated product card', () => {
  it('renders name, price and SKU, escaping markup', () => {
    const svg = renderProductCard({
      sku: 'KB-001',
      name: 'Brown <Bag> & "Co"',
      colour: 'Brown',
      category: 'Shoulder bag',
      price_kobo: 3000000n,
    });
    expect(svg).toMatch(/^<svg /);
    expect(svg).toContain('Brown &lt;Bag&gt; &amp; &quot;Co&quot;');
    expect(svg).toContain('₦30,000');
    expect(svg).not.toContain('<Bag>');
  });

  it('builds a stable URL from the public base', () => {
    expect(productImageUrl('https://x.up.railway.app', { sku: 'KB-003' })).toBe('https://x.up.railway.app/products/KB-003.svg');
  });
});
