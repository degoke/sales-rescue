// Made-to-order (date capacity) against the real Flavorburst catalogue (fixtures/): cakes share
// 3 slots a day, and the seed books next Saturday's three cake slots.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectDomainError, PIN, REAL_FIXTURES, setup, type TestEnv } from './helpers.js';
import { nextSaturday } from '../src/db/seed.js';
import { addDays, lagosToday } from '../src/lib/time.js';
import { checkDates, searchProducts } from '../src/merchant/products.js';
import { registerInterest, withdrawInterest } from '../src/merchant/opportunities.js';
import { reserveProduct } from '../src/merchant/reservations.js';
import { manageCapacity } from '../src/merchant/capacity.js';
import { updateInventory } from '../src/merchant/inventory.js';
import { confirmPayment, createPaymentLink, prepareCheckout } from '../src/merchant/orders.js';
import { runWorkerOnce } from '../src/events/worker.js';

const ADA = '+2348000000001';
const BAYO = '+2348000000002';
let env: TestEnv;
let saturday: string;
afterEach(async () => env?.close());
beforeEach(async () => {
  env = await setup({ fixturesDir: REAL_FIXTURES });
  saturday = nextSaturday(env.deps.now());
});

describe('checking dates', () => {
  it('reports a fully booked date and offers the next free ones', async () => {
    const r: any = await checkDates(env.deps, { sku: 'FB-CUSTOM-CAKE', date: saturday });
    expect(r.requested).toMatchObject({ date: saturday, bookable: false, reason: 'fully_booked', slots_free: 0 });
    // The closest free dates on both sides of Saturday, in date order, with no gaps between them.
    const dates = r.available_dates.map((d: any) => d.date);
    expect(dates).toContain(addDays(saturday, 1));
    const friday = addDays(saturday, -1);
    if (friday >= r.earliest_date.date) expect(dates).toContain(friday);
    expect(dates.every((d: string) => d >= r.earliest_date.date)).toBe(true);
    expect(dates).not.toContain(saturday);
    expect([...dates].sort()).toEqual(dates);
  });

  it('the seed keeps Saturdays full for weeks, so a database seeded once still shows a full date', async () => {
    for (const week of [1, 5]) {
      const r: any = await checkDates(env.deps, { sku: 'FB-CAKE-8-3L', date: addDays(saturday, 7 * week) });
      expect(r.requested).toMatchObject({ bookable: false, reason: 'fully_booked' });
    }
    const after: any = await checkDates(env.deps, { sku: 'FB-CAKE-8-3L', date: addDays(saturday, 7 * 6) });
    expect(after.requested.bookable).toBe(true);
  });

  it('enforces lead time (custom cakes need 3 days)', async () => {
    const r: any = await checkDates(env.deps, { sku: 'FB-CUSTOM-CAKE', date: lagosToday(env.deps.now()) });
    expect(r.requested).toMatchObject({ bookable: false, reason: 'too_soon' });
    expect(r.earliest_date.date).toBe(addDays(lagosToday(env.deps.now()), 3));
  });

  it('bentos share a different oven slot pool, so Saturday is still open for them', async () => {
    const r: any = await checkDates(env.deps, { sku: 'FB-BENTO-4', date: saturday });
    expect(r.requested).toMatchObject({ bookable: true, slots_free: 8 });
  });

  it('search shows made-to-order items with their next dates, not a stock count', async () => {
    const r = await searchProducts(env.deps, { query: 'custom cake' });
    expect(r.matches[0]).toMatchObject({ sku: 'FB-CUSTOM-CAKE', fulfilment: 'made_to_order', status: 'made_to_order', lead_time_days: 3 });
    expect((r.matches[0] as any).next_available_dates.length).toBeGreaterThan(0);
  });

  it('a sold-out stock item still gets real alternatives (mini banana bread → midi)', async () => {
    const r = await searchProducts(env.deps, { query: 'mini banana bread' });
    expect(r.matches[0]).toMatchObject({ sku: 'FB-BANANA-MINI', status: 'sold_out' });
    expect(r.alternatives[0].sku).toBe('FB-BANANA-MIDI');
  });
});

describe('booking a date', () => {
  it('needs a date, refuses a full one with alternatives, and books a free one with notes', async () => {
    await expectDomainError(reserveProduct(env.deps, { customer_ref: ADA, sku: 'FB-CUSTOM-CAKE' }), 'date_required');
    const full = await expectDomainError(
      reserveProduct(env.deps, { customer_ref: ADA, sku: 'FB-CUSTOM-CAKE', for_date: saturday }),
      'date_full',
    );
    expect(full.details.available_dates.map((d: any) => d.date)).toContain(addDays(saturday, 1));
    const sunday = addDays(saturday, 1);
    const hold: any = await reserveProduct(env.deps, {
      customer_ref: ADA,
      sku: 'FB-CUSTOM-CAKE',
      for_date: sunday,
      notes: 'Vanilla, blue and gold, "Happy 5th Tobi"\n',
    });
    expect(hold).toMatchObject({ for_date: sunday, notes: 'Vanilla, blue and gold, "Happy 5th Tobi"' });
    const after: any = await checkDates(env.deps, { sku: 'FB-LAMBETH', date: sunday });
    expect(after.requested.slots_free).toBe(2); // shared cake slots: 3 - 1
  });

  it('two customers racing for the last slot on a date: exactly one wins', async () => {
    const sunday = addDays(saturday, 1);
    await manageCapacity(env.deps, { pin: PIN, sku: 'FB-CUSTOM-CAKE', action: 'set_date', date: sunday, slots: 1 });
    const results = await Promise.allSettled([
      reserveProduct(env.deps, { customer_ref: ADA, sku: 'FB-CUSTOM-CAKE', for_date: sunday }),
      reserveProduct(env.deps, { customer_ref: BAYO, sku: 'FB-CAKE-8-2L', for_date: sunday }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.code).toBe('date_full');
  });

  it('paying for a made-to-order item keeps the slot booked and never touches stock counts', async () => {
    const sunday = addDays(saturday, 1);
    const hold = await reserveProduct(env.deps, { customer_ref: ADA, sku: 'FB-CAKE-8-2L', for_date: sunday });
    const quote: any = await prepareCheckout(env.deps, {
      customer_ref: ADA,
      reservation_id: hold.reservation_id,
      zone: 'lekki',
      email: 'a@example.com',
    });
    expect(quote.delivery.estimate).toMatch(/^on \w{3} \d{1,2} \w{3}$/);
    const link = await createPaymentLink(env.deps, { customer_ref: ADA, quote_id: quote.quote_id });
    env.paystack.pay(link.payment_reference);
    const r: any = await confirmPayment(env.deps, { customer_ref: ADA, order_ref: link.order_ref });
    expect(r).toMatchObject({ paid: true, order_status: 'DELIVERY_BOOKED', for_date: sunday });
    const [p] = await env.sql`select qty_on_hand from products where sku = 'FB-CAKE-8-2L'`;
    expect(p.qty_on_hand).toBe(0);
    expect(((await checkDates(env.deps, { sku: 'FB-CAKE-8-2L', date: sunday })) as any).requested.slots_free).toBe(2);
  });
});

describe('waiting for a full date', () => {
  it('only a full date can be waited for', async () => {
    await expectDomainError(
      registerInterest(env.deps, { customer_ref: ADA, sku: 'FB-CUSTOM-CAKE', consent: true, for_date: addDays(saturday, 1) }),
      'date_available',
    );
    const w: any = await registerInterest(env.deps, { customer_ref: ADA, sku: 'FB-CUSTOM-CAKE', consent: true, for_date: saturday });
    expect(w).toMatchObject({
      status: 'WAITING_RESTOCK',
      waiting_for_date: { date: saturday },
      position_in_queue: 1,
      payment_required_now: false,
    });
  });

  it('owner adds a slot to the full date → the first waiter is offered it; the owner is told', async () => {
    await registerInterest(env.deps, { customer_ref: ADA, sku: 'FB-CUSTOM-CAKE', consent: true, for_date: saturday });
    env.advance(1); // Bayo asks a minute later, so Ada is first in the queue
    await registerInterest(env.deps, { customer_ref: BAYO, sku: 'FB-LAMBETH', consent: true, for_date: saturday });
    const r: any = await manageCapacity(env.deps, { pin: PIN, sku: 'FB-CUSTOM-CAKE', action: 'set_date', date: saturday, slots: 4 });
    expect(r.slots_offered_to_waiting_customers_on).toHaveLength(1);
    await runWorkerOnce(env.deps);
    const opps = await env.sql`select customer_ref, status from opportunities where for_date is not null order by created_at, id`;
    expect(opps.map((o) => [o.customer_ref, o.status])).toEqual([
      [ADA, 'OFFERED'],
      [BAYO, 'WAITING_RESTOCK'],
    ]);
    const [n] = await env.sql`select body from notifications where reason = 'slot_offer'`;
    expect(n.body).toMatch(/a slot opened on .* for your Custom Cake/);
    // Accepting the offer reuses the held slot.
    const hold: any = await reserveProduct(env.deps, { customer_ref: ADA, sku: 'FB-CUSTOM-CAKE', for_date: saturday });
    expect(hold).toMatchObject({ accepted_offer: true, for_date: saturday });
  });

  it('a cancelled booking frees the slot for the next person waiting for that date', async () => {
    const sunday = addDays(saturday, 1);
    await manageCapacity(env.deps, { pin: PIN, sku: 'FB-CUSTOM-CAKE', action: 'set_date', date: sunday, slots: 1 });
    await reserveProduct(env.deps, { customer_ref: ADA, sku: 'FB-CUSTOM-CAKE', for_date: sunday, alternative_to_sku: 'FB-CUSTOM-CAKE' });
    await registerInterest(env.deps, { customer_ref: BAYO, sku: 'FB-CAKE-8-3L', consent: true, for_date: sunday });
    await withdrawInterest(env.deps, { customer_ref: ADA });
    await runWorkerOnce(env.deps);
    const [bayo] = await env.sql`select status from opportunities where customer_ref = ${BAYO}`;
    expect(bayo.status).toBe('OFFERED');
  });

  it('owner capacity changes are guarded', async () => {
    await expectDomainError(
      manageCapacity(env.deps, { pin: PIN, sku: 'FB-CUSTOM-CAKE', action: 'set_date', date: saturday, slots: 1 }),
      'below_booked',
    );
    await expectDomainError(manageCapacity(env.deps, { sku: 'FB-CUSTOM-CAKE', action: 'view' }), 'owner_auth_required');
    await expectDomainError(updateInventory(env.deps, { pin: PIN, sku: 'FB-CUSTOM-CAKE', op: 'increment', value: 2 }), 'made_to_order');
    const week: any = await manageCapacity(env.deps, { pin: PIN, sku: 'FB-CUSTOM-CAKE', action: 'view', date: saturday });
    expect(week.days[0]).toMatchObject({ date: saturday, capacity: 3, booked: 3, free: 0 });
  });
});
