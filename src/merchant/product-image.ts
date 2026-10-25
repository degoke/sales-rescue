// Product images as links. Chord's chat channels in this build carry
// text only, so the agent shares an image *URL*. A merchant's own photo (products.image_url) wins;
// otherwise we serve a generated product card so every product has something to show.
import { naira } from '../lib/money.js';

const COLOURS: Record<string, string> = {
  pink: '#e8879f',
  red: '#b8232f',
  golden: '#d9a441',
  brown: '#7b4b2a',
  chocolate: '#4a2c20',
  white: '#efe7dc',
  cream: '#efe4cc',
  tan: '#c8a27a',
  black: '#222222',
  burgundy: '#6d1a36',
};
const LIGHT = new Set(['white', 'cream', 'tan', 'golden']);

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function productImageUrl(publicBaseUrl: string, p: { sku: string; image_url?: string | null }) {
  return p.image_url || `${publicBaseUrl}/products/${encodeURIComponent(p.sku)}.svg`;
}

/** A 600×600 product card: a two-tier cake in the product's colour, name, price, category and SKU. */
export function renderProductCard(p: {
  sku: string;
  name: string;
  colour: string;
  category: string;
  price_kobo: bigint | number;
  merchant?: string;
}) {
  const fill = COLOURS[p.colour.toLowerCase()] ?? '#8a8a8a';
  const light = LIGHT.has(p.colour.toLowerCase());
  const ink = light ? '#3b2a1a' : '#ffffff';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600" role="img" aria-label="${esc(p.name)}">
  <rect width="600" height="600" fill="#f6f1ea"/>
  <g transform="translate(150 110)">
    <ellipse cx="150" cy="318" rx="170" ry="18" fill="#000" opacity=".06"/>
    <rect x="40" y="170" width="220" height="140" rx="18" fill="${fill}"/>
    <rect x="80" y="80" width="140" height="100" rx="16" fill="${fill}" opacity=".85"/>
    <path d="M40 200 q27 22 55 0 q27 22 55 0 q27 22 55 0 q27 22 55 0" fill="none" stroke="#fff" stroke-width="10" stroke-linecap="round" opacity=".7"/>
    <path d="M80 108 q23 18 47 0 q23 18 46 0 q23 18 47 0" fill="none" stroke="#fff" stroke-width="8" stroke-linecap="round" opacity=".7"/>
    <rect x="144" y="40" width="12" height="40" rx="4" fill="#f4d58d"/>
    <path d="M150 18 q10 12 0 22 q-10 -10 0 -22z" fill="#f29b38"/>
  </g>
  <rect x="0" y="460" width="600" height="140" fill="${fill}"/>
  <text x="300" y="515" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="30" font-weight="700" fill="${ink}">${esc(p.name)}</text>
  <text x="300" y="560" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="24" fill="${ink}">${esc(naira(p.price_kobo))} · ${esc(p.category)} · ${esc(p.sku)}</text>
  <text x="300" y="60" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="20" letter-spacing="3" fill="#7a6a5a">${esc((p.merchant ?? 'Flavorburst Bakes and Treats').toUpperCase())}</text>
</svg>`;
}
