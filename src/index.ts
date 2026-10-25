// Sales Rescue service: MCP tools for the Chord teammate, the mock courier, the Paystack return
// page, and the background worker, in one deployable process.
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { safeEqual } from './lib/security.js';
import { serve } from '@hono/node-server';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { type Config, loadConfig } from './config.js';
import { createDb, migrate } from './db/client.js';
import { seed } from './db/seed.js';
import type { Deps } from './deps.js';
import { createLogisticsApp } from './logistics/routes.js';
import { createLogisticsClient } from './logistics/client.js';
import { createPaystackClient } from './payments/paystack.js';
import { createChordClient } from './chord/client.js';
import { buildMcpServer, log } from './mcp/server.js';
import { startWorker } from './events/worker.js';
import { createHmac } from 'node:crypto';
import { handlePaystackEvent } from './merchant/orders.js';
import { syncOwnerPin } from './merchant/owner.js';
import { renderProductCard } from './merchant/product-image.js';

// Validate every environment variable before touching anything else.
let config: Config;
try {
  config = loadConfig();
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

const sql = createDb(config.databaseUrl);
await migrate(sql);

// First boot on an empty database (e.g. a fresh Railway Postgres): load the merchant,
// catalogue, baking capacity, bookings and waiting customers from fixtures/. Never runs once a merchant exists.
const [{ merchants }] = await sql<{ merchants: number }[]>`select count(*)::int as merchants from merchant`;
if (merchants === 0) {
  await seed(sql, { ownerPin: config.ownerPin });
  log('seeded', { fixtures: 'fixtures/' });
}
if (await syncOwnerPin(sql, config.ownerPin)) log('owner_pin_updated', {});

const deps: Deps = {
  sql,
  now: () => new Date(),
  logistics: createLogisticsClient(config.logistics),
  paystack: createPaystackClient(config.paystack),
  chord: createChordClient(config.chord),
  publicBaseUrl: config.publicBaseUrl,
};

const app = new Hono();
app.use('*', secureHeaders());
app.use('*', bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: 'body_too_large' }, 413) }));

// Public liveness only; which integrations are configured is logged at startup, not exposed.
app.get('/healthz', async (c) => {
  await sql`select 1`;
  return c.json({ ok: true });
});

app.route('/logistics', createLogisticsApp(sql, config.logistics.apiKey));

app.all('/mcp', async (c) => {
  if (!safeEqual(c.req.header('authorization'), `Bearer ${config.mcpToken}`)) {
    log('mcp_auth_rejected', { method: c.req.method });
    return c.json({ error: 'unauthorized' }, 401);
  }
  // Stateless: a fresh server and transport per request.
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await buildMcpServer(deps).connect(transport);
  return transport.handleRequest(c.req.raw);
});

// Paystack webhook (configure https://<public>/paystack/webhook in the Paystack test dashboard).
// Signature: HMAC-SHA512 of the raw body with the secret key. The event only triggers a
// server-side verify; its contents are never trusted directly.
app.post('/paystack/webhook', async (c) => {
  const raw = await c.req.text();
  const secret = config.paystack.secretKey;
  const sig = c.req.header('x-paystack-signature') ?? '';
  if (!safeEqual(sig, createHmac('sha512', secret).update(raw).digest('hex'))) {
    log('paystack_webhook_rejected', {});
    return c.json({ error: 'invalid_signature' }, 401);
  }
  let event: any = {};
  try {
    event = JSON.parse(raw);
  } catch {
    return c.json({ error: 'bad_json' }, 400);
  }
  const r = await handlePaystackEvent(deps, event).catch((e) => ({ handled: false, error: String(e) }));
  log('paystack_webhook', { event: event.event, reference: event.data?.reference, ...r });
  return c.json({ ok: true });
});

// Product images the agent shares as links (chat channels here carry text only).
// Rendered from the live product row, so name and price are always current.
app.get('/products/:file', async (c) => {
  const m = /^([A-Za-z0-9-]{2,20})\.svg$/.exec(c.req.param('file'));
  if (!m) return c.json({ error: 'not_found' }, 404);
  const [p] = await sql`select sku, name, colour, category, price_kobo from products where upper(sku) = upper(${m[1]})`;
  if (!p) return c.json({ error: 'not_found' }, 404);
  const [merchant] = await sql`select name from merchant where id = 1`;
  c.header('content-type', 'image/svg+xml; charset=utf-8');
  c.header('cache-control', 'public, max-age=300');
  return c.body(renderProductCard({ ...(p as any), merchant: merchant?.name }));
});

// Where Paystack sends the customer after checkout. Payment is only trusted after confirm_payment
// verifies it server-side, so this page just sends them back to the chat.
app.get('/paystack/callback', (c) =>
  c.html(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Payment received</title>
<body style="font-family:system-ui;max-width:28rem;margin:3rem auto;padding:0 1rem;line-height:1.5">
<h1 style="font-size:1.3rem">Thanks, you can go back to WhatsApp</h1>
<p>Tell us "I've paid" in the chat and we'll confirm your order once Paystack verifies the payment.</p>
<p style="color:#666;font-size:.9rem">Reference: ${String(c.req.query('reference') ?? '').replace(/[^A-Za-z0-9-]/g, '')}</p></body>`),
);

serve({ fetch: app.fetch, port: config.port });
startWorker(deps, config.workerIntervalMs);
log('started', { port: config.port, paystack: !!deps.paystack, chord_delivery: !!deps.chord, public: config.publicBaseUrl });
