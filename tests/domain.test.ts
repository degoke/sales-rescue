import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectDomainError, PIN, setup, type TestEnv } from './helpers.js';
import { searchProducts } from '../src/merchant/products.js';
import { allocateStock, getMyUpdates, registerInterest, withdrawInterest } from '../src/merchant/opportunities.js';
import { reserveProduct } from '../src/merchant/reservations.js';
import { updateInventory } from '../src/merchant/inventory.js';
import { manageRestock } from '../src/merchant/restock.js';
import { verifyOwner } from '../src/merchant/owner.js';
import { confirmPayment, createPaymentLink, prepareCheckout, trackOrder } from '../src/merchant/orders.js';
import { getDemandSummary } from '../src/merchant/metrics.js';
import { runWorkerOnce } from '../src/events/worker.js';

const DEMO = '+2348000000001';
let env: TestEnv;
afterEach(async () => env?.close());

/** Reserve → quote → link → pay → confirm. Returns the order ref. */
async function buy(customer: string, sku: string, extra: { alternative_to_sku?: string } = {}) {
  const hold = await reserveProduct(env.deps, { customer_ref: customer, sku, ...extra });
  const quote = await prepareCheckout(env.deps, {
    customer_ref: customer,
    reservation_id: hold.reservation_id,
    zone: 'Lekki',
    email: 'demo@example.com',
  });
  const link = await createPaymentLink(env.deps, { customer_ref: customer, quote_id: quote.quote_id });
  env.paystack.pay(link.payment_reference);
  const result: any = await confirmPayment(env.deps, { customer_ref: customer, order_ref: link.order_ref });
  return { hold, quote, link, result };
}

describe('catalogue lookup', () => {
  beforeEach(async () => {
    env = await setup();
  });

  it('finds the sold-out brown bag and offers real in-stock alternatives, closest first', async () => {
    const r = await searchProducts(env.deps, { query: 'brown shoulder bag from your instagram post' });
    expect(r.matches[0]).toMatchObject({ sku: 'KB-001', status: 'sold_out', available: 0 });
    expect(r.alternatives[0].sku).toBe('KB-002'); // same category, close price
    expect(r.alternatives.every((a) => a.available > 0)).toBe(true);
  });
});

describe('waitlist', () => {
  beforeEach(async () => {
    env = await setup();
  });

  it('needs explicit consent and refuses a waitlist for an item that is in stock', async () => {
    await expectDomainError(registerInterest(env.deps, { customer_ref: DEMO, sku: 'KB-001', consent: false }), 'consent_required');
    await expectDomainError(registerInterest(env.deps, { customer_ref: DEMO, sku: 'KB-002', consent: true }), 'in_stock');
  });

  it('joins the queue behind the two seeded customers, is idempotent, and creates no payment', async () => {
    const a = await registerInterest(env.deps, { customer_ref: DEMO, sku: 'KB-001', consent: true, display_name: 'Ada' });
    expect(a).toMatchObject({ status: 'WAITING_RESTOCK', position_in_queue: 3, payment_required_now: false, already_on_list: false });
    const b = await registerInterest(env.deps, { customer_ref: DEMO, sku: 'KB-001', consent: true });
    expect(b).toMatchObject({ opportunity_id: a.opportunity_id, already_on_list: true });
    const [{ n }] = await env.sql`select count(*)::int as n from payments`;
    expect(n).toBe(0);
  });

  it('alerts the owner when the third customer joins (demand threshold)', async () => {
    await registerInterest(env.deps, { customer_ref: DEMO, sku: 'KB-001', consent: true });
    await runWorkerOnce(env.deps);
    const notes = await env.sql`select reason, body from notifications where recipient_type = 'owner'`;
    expect(notes.map((n) => n.reason)).toContain('demand_threshold');
    expect(notes.find((n) => n.reason === 'demand_threshold')!.body).toMatch(/3 customers are waiting.*Brown Leather Shoulder Bag/);
  });
});

describe('owner authentication', () => {
  beforeEach(async () => {
    env = await setup();
  });

  it('rejects owner tools without a PIN session, even if the model claims to be the owner', async () => {
    await expectDomainError(
      updateInventory(env.deps, { owner_token: '', sku: 'KB-004', op: 'increment', value: 5 }),
      'owner_auth_required',
    );
    await expectDomainError(
      updateInventory(env.deps, { owner_token: 'i-am-the-owner', sku: 'KB-004', op: 'increment', value: 5 }),
      'owner_auth_required',
    );
    await expectDomainError(getDemandSummary(env.deps, { owner_token: '+2348000000099' }), 'owner_auth_required');
  });

  it('counts wrong PINs and locks after five', async () => {
    const e = await expectDomainError(verifyOwner(env.deps, { pin: '000000' }), 'invalid_pin');
    expect(e.details.attempts_left).toBe(4);
    for (let i = 0; i < 4; i++) await expectDomainError(verifyOwner(env.deps, { pin: '000000' }), 'invalid_pin');
    await expectDomainError(verifyOwner(env.deps, { pin: PIN }), 'owner_locked');
    env.advance(16);
    expect((await verifyOwner(env.deps, { pin: PIN })).owner_token).toHaveLength(48);
  });

  it('owner tools accept the PIN directly (no token needed across turns), and wrong PINs still count', async () => {
    const r: any = await updateInventory(env.deps, { pin: PIN, sku: 'KB-004', op: 'increment', value: 1 });
    expect(r.after.qty).toBe(6);
    const e = await expectDomainError(getDemandSummary(env.deps, { pin: '111111' }), 'invalid_pin');
    expect(e.details.attempts_left).toBe(4);
  });

  it('expires owner sessions after two hours', async () => {
    const token = await env.ownerToken();
    env.advance(121);
    await expectDomainError(getDemandSummary(env.deps, { owner_token: token }), 'owner_auth_required');
  });
});

describe('inventory by chat', () => {
  beforeEach(async () => {
    env = await setup();
  });

  it('treats "add 3" and "we have 3" differently', async () => {
    const token = await env.ownerToken();
    const inc: any = await updateInventory(env.deps, { owner_token: token, sku: 'KB-004', op: 'increment', value: 3 });
    expect(inc.after.qty).toBe(8);
    const set: any = await updateInventory(env.deps, { owner_token: token, sku: 'KB-004', op: 'set', value: 3 });
    expect(set.after.qty).toBe(3);
  });

  it('asks for confirmation on large changes and only applies a matching confirmation', async () => {
    const token = await env.ownerToken();
    const preview: any = await updateInventory(env.deps, { owner_token: token, sku: 'KB-004', op: 'increment', value: 50 });
    expect(preview).toMatchObject({ applied: false, needs_confirmation: true, after: { qty: 55 } });
    const [{ qty_on_hand }] = await env.sql`select qty_on_hand from products where sku = 'KB-004'`;
    expect(qty_on_hand).toBe(5);
    await expectDomainError(
      updateInventory(env.deps, { owner_token: token, sku: 'KB-004', op: 'increment', value: 5, confirmation_id: preview.confirmation_id }),
      'invalid_confirmation',
    );
    const done: any = await updateInventory(env.deps, {
      owner_token: token,
      sku: 'KB-004',
      op: 'increment',
      value: 50,
      confirmation_id: preview.confirmation_id,
    });
    expect(done).toMatchObject({ applied: true, after: { qty: 55 } });
  });

  it('will not drop stock below what is held for customers', async () => {
    const token = await env.ownerToken();
    await reserveProduct(env.deps, { customer_ref: DEMO, sku: 'KB-008' }); // the only unit
    await expectDomainError(updateInventory(env.deps, { owner_token: token, sku: 'KB-008', op: 'sold_out' }), 'below_reserved');
  });
});

describe('restock allocation (first come, first served)', () => {
  beforeEach(async () => {
    env = await setup();
  });

  it('offers 2 units to the first 2 of 3 waiters; when an offer lapses the unit moves to the next', async () => {
    await registerInterest(env.deps, { customer_ref: DEMO, sku: 'KB-001', consent: true }); // 3rd in queue
    const token = await env.ownerToken();
    const res: any = await updateInventory(env.deps, { owner_token: token, sku: 'KB-001', op: 'increment', value: 2 });
    expect(res.restock_offers_triggered).toBe(true);
    await runWorkerOnce(env.deps);

    const opps = await env.sql`select customer_ref, status from opportunities where sku = 'KB-001' order by created_at`;
    expect(opps.map((o) => o.status)).toEqual(['OFFERED', 'OFFERED', 'WAITING_RESTOCK']);
    const offers = await env.sql`select recipient_ref, body from notifications where reason = 'restock_offer' order by recipient_ref`;
    expect(offers).toHaveLength(2);
    expect(offers[0].body).toMatch(/back in stock.*Reply "yes"/s);
    expect(offers[0].body).toMatch(/\(ref NTF-\d+\)$/);

    // Tolu (first) never replies; the offer lapses and the demo customer is offered the unit.
    env.advance(61);
    await runWorkerOnce(env.deps);
    const after = await env.sql`select customer_ref, status from opportunities where sku = 'KB-001' order by created_at`;
    expect(after.map((o) => o.status)).toEqual(['EXPIRED', 'EXPIRED', 'OFFERED']);
    const updates = await getMyUpdates(env.deps, { customer_ref: DEMO });
    expect(updates.open_requests[0]).toMatchObject({ status: 'OFFERED', hold: expect.any(Object) });
    expect(updates.messages_from_shop.map((m) => m.reason)).toContain('restock_offer');
  });

  it('a decline releases the unit to the next person in the queue', async () => {
    await registerInterest(env.deps, { customer_ref: DEMO, sku: 'KB-001', consent: true });
    await env.sql`update products set qty_on_hand = 1 where sku = 'KB-001'`;
    await allocateStock(env.deps, 'KB-001'); // Tolu gets it
    await withdrawInterest(env.deps, { customer_ref: '+2348000000011', sku: 'KB-001' });
    await runWorkerOnce(env.deps);
    const [ifeoma] = await env.sql`select status from opportunities where customer_ref = '+2348000000012'`;
    expect(ifeoma.status).toBe('OFFERED');
  });

  it('opt-out stops queued messages', async () => {
    await registerInterest(env.deps, { customer_ref: DEMO, sku: 'KB-001', consent: true });
    await env.sql`update products set qty_on_hand = 3 where sku = 'KB-001'`;
    await allocateStock(env.deps, 'KB-001');
    await withdrawInterest(env.deps, { customer_ref: DEMO, opt_out: true });
    const [n] = await env.sql`select status from notifications where recipient_ref = ${DEMO} and reason = 'restock_offer'`;
    expect(n.status).toBe('SKIPPED');
  });
});

describe('holds', () => {
  beforeEach(async () => {
    env = await setup();
  });

  it('only one of two simultaneous customers gets the last unit', async () => {
    const results = await Promise.allSettled([
      reserveProduct(env.deps, { customer_ref: 'cust-a', sku: 'KB-008' }),
      reserveProduct(env.deps, { customer_ref: 'cust-b', sku: 'KB-008' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason.code).toBe('insufficient_stock');
  });

  it('a repeated reserve returns the same hold', async () => {
    const a = await reserveProduct(env.deps, { customer_ref: DEMO, sku: 'KB-002' });
    const b = await reserveProduct(env.deps, { customer_ref: DEMO, sku: 'KB-002' });
    expect(b).toMatchObject({ reservation_id: a.reservation_id, already_held: true });
  });
});

describe('checkout, payment and delivery', () => {
  beforeEach(async () => {
    env = await setup();
  });

  it('happy path: verified payment takes stock, books delivery, and tracking reads the courier', async () => {
    const { quote, link, result } = await buy(DEMO, 'KB-002');
    expect(quote).toMatchObject({ items_total: '₦28,500', delivery: { zone: 'lekki', fee: '₦3,500' }, total: '₦32,000' });
    expect(result).toMatchObject({ paid: true, order_status: 'DELIVERY_BOOKED', total_paid: '₦32,000' });
    expect(result.delivery.tracking_ref).toMatch(/^DEL-/);
    const [{ qty_on_hand }] = await env.sql`select qty_on_hand from products where sku = 'KB-002'`;
    expect(qty_on_hand).toBe(2);

    await env.logisticsApp.request(`/deliveries/${result.delivery.tracking_ref}/status`, {
      method: 'POST',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'PICKED_UP' }),
    });
    const t = await trackOrder(env.deps, { order_ref: link.order_ref });
    expect(t.delivery).toMatchObject({ status: 'PICKED_UP', estimate: 'today between 2pm and 5pm' });

    // Idempotent: confirming again changes nothing.
    const again: any = await confirmPayment(env.deps, { order_ref: link.order_ref });
    expect(again).toMatchObject({ paid: true, already_confirmed: true });
    const [{ n }] = await env.sql`select count(*)::int as n from deliveries`;
    expect(n).toBe(1);
  });

  it('"I have paid" without paying: not confirmed, order stays pending, same link reused', async () => {
    const hold = await reserveProduct(env.deps, { customer_ref: DEMO, sku: 'KB-002' });
    const quote = await prepareCheckout(env.deps, { reservation_id: hold.reservation_id, zone: 'yaba', email: 'demo@example.com' });
    const link = await createPaymentLink(env.deps, { quote_id: quote.quote_id });
    const r: any = await confirmPayment(env.deps, { order_ref: link.order_ref });
    expect(r).toMatchObject({ paid: false, payment_status: 'ABANDONED' });
    const [o] = await env.sql`select status from orders where ref = ${link.order_ref}`;
    expect(o.status).toBe('PENDING_PAYMENT');
    const link2 = await createPaymentLink(env.deps, { quote_id: quote.quote_id });
    expect(link2).toMatchObject({ payment_url: link.payment_url, reused_existing_link: true });
    expect(env.paystack.initCalls).toBe(1);
  });

  it('a failed card allows a fresh link (new attempt) while the hold lasts', async () => {
    const hold = await reserveProduct(env.deps, { customer_ref: DEMO, sku: 'KB-002' });
    const quote = await prepareCheckout(env.deps, { reservation_id: hold.reservation_id, zone: 'yaba', email: 'demo@example.com' });
    const link = await createPaymentLink(env.deps, { quote_id: quote.quote_id });
    env.paystack.set(link.payment_reference, { status: 'failed', gateway_response: 'Declined' });
    expect(await confirmPayment(env.deps, { order_ref: link.order_ref })).toMatchObject({ paid: false, payment_status: 'FAILED' });
    const link2 = await createPaymentLink(env.deps, { quote_id: quote.quote_id });
    expect(link2.payment_reference).toBe(`${link.order_ref}-2`);
  });

  it('a "successful" payment for the wrong amount is not accepted, and the owner is alerted', async () => {
    const hold = await reserveProduct(env.deps, { customer_ref: DEMO, sku: 'KB-002' });
    const quote = await prepareCheckout(env.deps, { reservation_id: hold.reservation_id, zone: 'yaba', email: 'demo@example.com' });
    const link = await createPaymentLink(env.deps, { quote_id: quote.quote_id });
    env.paystack.pay(link.payment_reference, { amount: 100 });
    expect(await confirmPayment(env.deps, { order_ref: link.order_ref })).toMatchObject({ paid: false, payment_status: 'MISMATCH' });
    const [o] = await env.sql`select status from orders where ref = ${link.order_ref}`;
    expect(o.status).toBe('PENDING_PAYMENT');
    const [n] = await env.sql`select reason from notifications where reason = 'payment_mismatch'`;
    expect(n).toBeTruthy();
  });

  it('courier outage after payment: order stays paid as FULFILLMENT_PENDING, owner alerted, retry books once', async () => {
    await env.logisticsApp.request('/_simulate/fail-next-booking', { method: 'POST', headers: { 'x-api-key': 'test-key' } });
    const { link, result } = await buy(DEMO, 'KB-002');
    expect(result).toMatchObject({ paid: true, order_status: 'FULFILLMENT_PENDING', delivery: { tracking_ref: null } });
    await runWorkerOnce(env.deps); // alerts the owner; the retry waits for its backoff
    const [waiting] = await env.sql`select status, delivery_attempts from orders where ref = ${link.order_ref}`;
    expect(waiting).toMatchObject({ status: 'FULFILLMENT_PENDING', delivery_attempts: 1 });
    env.advance(3);
    await runWorkerOnce(env.deps);
    const [o] = await env.sql`select status, tracking_ref from orders where ref = ${link.order_ref}`;
    expect(o.status).toBe('DELIVERY_BOOKED');
    const [n] = await env.sql`select reason from notifications where reason = 'fulfilment_failed'`;
    expect(n).toBeTruthy();
  });

  it('rejects unsupported delivery zones with the list of supported ones', async () => {
    const hold = await reserveProduct(env.deps, { customer_ref: DEMO, sku: 'KB-002' });
    const e = await expectDomainError(
      prepareCheckout(env.deps, { reservation_id: hold.reservation_id, zone: 'Abuja', email: 'a@b.co' }),
      'unsupported_zone',
    );
    expect(e.details.supported_zones).toContain('lekki');
  });
});

describe('recovered sales', () => {
  beforeEach(async () => {
    env = await setup();
  });

  it('a restock offer that is paid counts as a restock recovery', async () => {
    await env.sql`update products set qty_on_hand = 1 where sku = 'KB-001'`;
    await allocateStock(env.deps, 'KB-001'); // offered to Tolu
    const { result } = await buy('+2348000000011', 'KB-001');
    expect(result.order_status).toBe('DELIVERY_BOOKED');
    const [opp] = await env.sql`select status from opportunities where customer_ref = '+2348000000011'`;
    expect(opp.status).toBe('WON');
    const s = await getDemandSummary(env.deps, { owner_token: await env.ownerToken() });
    expect(s.metrics).toMatchObject({ restock_recoveries: 1, recovered_revenue: '₦33,500' });
  });

  it('buying a substitute closes the waitlist entry as an alternative sale', async () => {
    await registerInterest(env.deps, { customer_ref: DEMO, sku: 'KB-001', consent: true });
    await buy(DEMO, 'KB-002', { alternative_to_sku: 'KB-001' });
    const [opp] = await env.sql`select status, alternative_sku from opportunities where customer_ref = ${DEMO}`;
    expect(opp).toMatchObject({ status: 'WON', alternative_sku: 'KB-002' });
    const [o] = await env.sql`select recovery_type from orders`;
    expect(o.recovery_type).toBe('alternative');
  });
});

describe('restock reminders', () => {
  beforeEach(async () => {
    env = await setup({ chord: true });
  });

  it('snoozing twice leaves exactly one active reminder and cancels the old Chord tasks', async () => {
    const token = await env.ownerToken();
    await manageRestock(env.deps, { owner_token: token, sku: 'KB-001', action: 'record_eta', expected_date: '2030-01-10' });
    await manageRestock(env.deps, { owner_token: token, sku: 'KB-001', action: 'snooze', remind_at: '2030-01-06' });
    await manageRestock(env.deps, { owner_token: token, sku: 'KB-001', action: 'snooze', remind_at: '2030-01-08' });
    const active = await env.sql`select * from reminders where status = 'ACTIVE'`;
    expect(active).toHaveLength(1);
    expect(new Date(active[0].due_at).toISOString()).toBe('2030-01-08T09:00:00.000Z');
    expect(env.chord!.scheduled).toHaveLength(3);
    expect(env.chord!.cancelled).toEqual(['task_1', 'task_2']);
    expect(env.chord!.scheduled[0].conversationId).toBe('thread-+2348000000099');
  });

  it('stock arriving closes the restock and its reminder', async () => {
    const token = await env.ownerToken();
    await manageRestock(env.deps, { owner_token: token, sku: 'KB-001', action: 'record_eta', expected_date: '2030-01-10' });
    await updateInventory(env.deps, { owner_token: token, sku: 'KB-001', op: 'increment', value: 4 });
    const [r] = await env.sql`select status from restocks where sku = 'KB-001'`;
    expect(r.status).toBe('RECEIVED');
    expect(await env.sql`select * from reminders where status = 'ACTIVE'`).toHaveLength(0);
    expect(env.chord!.cancelled).toEqual(['task_1']);
  });

  it('"not restocking" closes the waitlist and tells each waiting customer', async () => {
    const token = await env.ownerToken();
    const r: any = await manageRestock(env.deps, { owner_token: token, sku: 'KB-001', action: 'not_restocking' });
    expect(r.customers_told).toBe(2);
    const opps = await env.sql`select status from opportunities where sku = 'KB-001'`;
    expect(opps.every((o) => o.status === 'NOT_RESTOCKING')).toBe(true);
  });

  it('delivers queued notifications into the recipient thread as Chord MESSAGE tasks', async () => {
    await registerInterest(env.deps, { customer_ref: DEMO, sku: 'KB-001', consent: true });
    await env.ownerToken();
    await runWorkerOnce(env.deps);
    const toOwner = env.chord!.scheduled.find((s) => s.conversationId === 'thread-+2348000000099');
    expect(toOwner?.body).toMatch(/3 customers are waiting/);
    await runWorkerOnce(env.deps);
    const [n] = await env.sql`select status from notifications where reason = 'demand_threshold'`;
    expect(n.status).toBe('SENT');
  });
});
