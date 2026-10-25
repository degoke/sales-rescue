// Mock Lagos courier. Runs inside the same deployment but behaves like an external carrier:
// its own routes, its own API key, its own tables, and the merchant backend only reaches it over HTTP.
import { Hono } from 'hono';
import type { Sql } from '../db/client.js';
import { nextRef } from '../db/client.js';
import { safeEqual } from '../lib/security.js';

export const ZONES: Record<string, { fee_kobo: bigint; service: string; eta_text: string }> = {
  'victoria-island': { fee_kobo: 300000n, service: 'same_day', eta_text: 'same day if booked before 12pm, otherwise next morning' },
  ikoyi: { fee_kobo: 300000n, service: 'same_day', eta_text: 'same day if booked before 12pm, otherwise next morning' },
  lekki: { fee_kobo: 350000n, service: 'same_day', eta_text: 'same day if booked before 12pm, otherwise next morning' },
  ajah: { fee_kobo: 450000n, service: 'next_day', eta_text: 'next business day' },
  yaba: { fee_kobo: 250000n, service: 'next_day', eta_text: 'next business day' },
  surulere: { fee_kobo: 250000n, service: 'next_day', eta_text: 'next business day' },
  ikeja: { fee_kobo: 300000n, service: 'next_day', eta_text: 'next business day' },
  festac: { fee_kobo: 400000n, service: 'standard', eta_text: '1–2 business days' },
};
const ALIASES: Record<string, string> = {
  vi: 'victoria-island',
  'v.i': 'victoria-island',
  'victoria island': 'victoria-island',
  'lekki phase 1': 'lekki',
};

export const normalizeZone = (zone: string) => {
  const z = zone.trim().toLowerCase();
  return ALIASES[z] ?? z.replace(/\s+/g, '-');
};

const NEXT: Record<string, string[]> = {
  BOOKED: ['PICKED_UP'],
  PICKED_UP: ['IN_TRANSIT'],
  IN_TRANSIT: ['DELIVERED', 'FAILED_ATTEMPT'],
  FAILED_ATTEMPT: ['IN_TRANSIT'],
  DELIVERED: [],
};
const STATUS_ETA: Record<string, string> = {
  PICKED_UP: 'today between 2pm and 5pm',
  IN_TRANSIT: 'today between 2pm and 5pm',
  FAILED_ATTEMPT: 'rider will retry next business day; the customer will be called first',
  DELIVERED: 'delivered',
};

export function createLogisticsApp(sql: Sql, apiKey: string, now: () => Date = () => new Date()) {
  const app = new Hono();

  app.use('*', async (c, next) => {
    if (!safeEqual(c.req.header('x-api-key'), apiKey)) return c.json({ error: 'unauthorized' }, 401);
    await next();
  });

  app.post('/delivery/quote', async (c) => {
    const { zone } = await c.req.json<{ zone?: string }>();
    const key = normalizeZone(zone ?? '');
    const z = ZONES[key];
    if (!z) return c.json({ error: 'unsupported_zone', zone, supported_zones: Object.keys(ZONES) }, 422);
    const id = await nextRef(sql, 'LQ');
    const expires = new Date(now().getTime() + 2 * 3600_000);
    await sql`insert into logistics_quotes (id, zone, fee_kobo, service, eta_text, expires_at)
              values (${id}, ${key}, ${z.fee_kobo.toString()}, ${z.service}, ${z.eta_text}, ${expires})`;
    return c.json({
      quote_id: id,
      zone: key,
      fee_kobo: Number(z.fee_kobo),
      service: z.service,
      eta_text: z.eta_text,
      expires_at: expires.toISOString(),
    });
  });

  app.post('/deliveries', async (c) => {
    const body = await c.req.json<{ quote_id: string; order_ref: string; recipient_name?: string; address?: string }>();
    const [existing] = await sql`select * from deliveries where order_ref = ${body.order_ref}`;
    if (existing) return c.json(serialize(existing)); // idempotent per order

    const [flag] = await sql`delete from logistics_flags where name = 'fail_next_booking' returning value`;
    if (flag) return c.json({ error: 'carrier_unavailable', message: 'Simulated carrier outage' }, 503);

    const [q] = await sql`select * from logistics_quotes where id = ${body.quote_id}`;
    if (!q) return c.json({ error: 'unknown_quote' }, 404);
    const id = await nextRef(sql, 'DEL');
    const history = [{ status: 'BOOKED', at: now().toISOString() }];
    const [d] = await sql`
      insert into deliveries (id, order_ref, quote_id, zone, recipient_name, address, status, eta_text, history)
      values (${id}, ${body.order_ref}, ${q.id}, ${q.zone}, ${body.recipient_name ?? null}, ${body.address ?? null},
              'BOOKED', ${q.eta_text}, ${sql.json(history)})
      on conflict (order_ref) do nothing
      returning *`;
    if (!d) return c.json(serialize((await sql`select * from deliveries where order_ref = ${body.order_ref}`)[0])); // lost a race: same booking
    return c.json(serialize(d), 201);
  });

  app.get('/deliveries/:id', async (c) => {
    const [d] = await sql`select * from deliveries where id = ${c.req.param('id')}`;
    if (!d) return c.json({ error: 'not_found' }, 404);
    return c.json(serialize(d));
  });

  // Simulation hooks used in demos and tests: move a parcel along, or make the next booking fail.
  app.post('/deliveries/:id/status', async (c) => {
    const { status, eta_text } = await c.req.json<{ status: string; eta_text?: string }>();
    const [d] = await sql`select * from deliveries where id = ${c.req.param('id')}`;
    if (!d) return c.json({ error: 'not_found' }, 404);
    if (!NEXT[d.status]?.includes(status)) {
      return c.json({ error: 'invalid_transition', from: d.status, to: status, allowed: NEXT[d.status] }, 409);
    }
    const history = [...d.history, { status, at: now().toISOString() }];
    const [u] = await sql`
      update deliveries set status = ${status}, eta_text = ${eta_text ?? STATUS_ETA[status] ?? d.eta_text},
             history = ${sql.json(history)}, updated_at = ${now()}
      where id = ${d.id} returning *`;
    return c.json(serialize(u));
  });

  app.post('/_simulate/fail-next-booking', async (c) => {
    await sql`insert into logistics_flags (name, value) values ('fail_next_booking', '1')
              on conflict (name) do update set value = '1'`;
    return c.json({ ok: true });
  });

  return app;
}

const serialize = (d: any) => ({
  id: d.id,
  tracking_ref: d.id,
  order_ref: d.order_ref,
  zone: d.zone,
  status: d.status,
  eta_text: d.eta_text,
  history: d.history,
  updated_at: new Date(d.updated_at).toISOString(),
});
