// Checkout → Paystack → order → delivery. A customer saying "I've paid" changes nothing: only a
// Paystack verify whose status, amount, currency, reference and order all match marks an order paid.
import { randomInt } from 'node:crypto';
import { nextRef } from '../db/client.js';
import type { Deps } from '../deps.js';
import { DomainError, fail } from '../lib/errors.js';
import { naira } from '../lib/money.js';
import { dayLabel, isoDay, lagosDateTime, minutesFrom } from '../lib/time.js';
import { emit, queueNotification } from './outbox.js';
import { heldQty, lockProduct, slotsFree } from './products.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OPEN_ORDER = ['PENDING_PAYMENT', 'PAYMENT_FAILED'];
const PAID_ORDER = ['PAID', 'FULFILLMENT_PENDING', 'DELIVERY_BOOKED', 'DELIVERED'];
const MAX_DELIVERY_ATTEMPTS = 8;

/** Order refs carry a random suffix so they can't be enumerated (SR-1042-K7QX). */
async function newOrderRef(deps: Deps) {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const suffix = Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join('');
  return `${await nextRef(deps.sql, 'SR')}-${suffix}`;
}

/**
 * Records are addressed by references, and Chord gives tools no caller identity,
 * so every customer-facing lookup also requires the matching customer_ref. It is spoofable, but it
 * stops blind enumeration of someone else's order or hold by reference alone.
 */
function assertOwner(row: Record<string, any>, customerRef: string | undefined, notFound: () => never) {
  if (customerRef !== undefined && row.customer_ref !== customerRef.trim()) notFound();
}

async function liveHold(deps: Deps, reservationId: string, customerRef?: string) {
  const [r] = await deps.sql`select r.*, p.name from reservations r join products p on p.sku = r.sku where r.id = ${reservationId}`;
  const notFound = () => fail('reservation_not_found', `No hold with id ${reservationId} for this customer. Reserve the product first.`);
  if (!r) notFound();
  assertOwner(r, customerRef, notFound);
  if (r.status !== 'HELD' || new Date(r.expires_at) <= deps.now()) {
    fail('hold_expired', `The hold on ${r.name} has ended. Check availability and reserve again.`, { status: r.status });
  }
  return r;
}

/** Delivery quote + total. Deliberately does not create a payment: the customer confirms first. */
export async function prepareCheckout(
  deps: Deps,
  input: { customer_ref?: string; reservation_id: string; zone: string; email: string; address?: string },
) {
  if (!EMAIL.test(input.email ?? '')) fail('invalid_email', 'Paystack needs an email address for the receipt. Ask the customer for one.');
  const r = await liveHold(deps, input.reservation_id, input.customer_ref);

  // One payable order per hold: re-quoting after a link was sent would let the customer pay twice.
  const [open] = await deps.sql`
    select o.ref, o.status, p.authorization_url from orders o
    left join payments p on p.order_ref = o.ref and p.status in ('INITIALIZED', 'PENDING', 'ABANDONED') and p.authorization_url is not null
    where o.reservation_id = ${r.id} and o.status <> 'CANCELLED' order by p.attempt desc nulls last limit 1`;
  if (open) {
    fail(
      PAID_ORDER.includes(open.status) ? 'already_paid' : 'checkout_in_progress',
      PAID_ORDER.includes(open.status)
        ? `This hold already became order ${open.ref}. Use confirm_payment or track_order.`
        : `A payment link was already sent for this hold (order ${open.ref}). Ask the customer to use it. Changing delivery details now needs the owner.`,
      { order_ref: open.ref, payment_url: open.authorization_url ?? null },
    );
  }

  const lq = await deps.logistics.quote(input.zone);
  const forDate = isoDay(r.for_date);
  // Made-to-order: delivered on the booked date, not "next business day".
  const etaText = forDate ? `on ${dayLabel(forDate)}` : lq.eta_text;
  const itemsTotal = BigInt(r.unit_price_kobo) * BigInt(r.qty);
  const fee = BigInt(lq.fee_kobo);
  const id = await nextRef(deps.sql, 'QTE');
  await deps.sql.begin(async (tx) => {
    await tx`insert into quotes (id, reservation_id, zone, address, email, logistics_quote_id, delivery_service, delivery_eta_text,
                                 items_total_kobo, delivery_fee_kobo, total_kobo)
             values (${id}, ${r.id}, ${lq.zone}, ${input.address?.slice(0, 300) ?? null}, ${input.email}, ${lq.quote_id}, ${lq.service}, ${etaText},
                     ${itemsTotal.toString()}, ${fee.toString()}, ${(itemsTotal + fee).toString()})`;
    // Don't let a checkout overwrite an email already on file (it would redirect receipts).
    await tx`update customers set email = coalesce(email, ${input.email}) where ref = ${r.customer_ref}`;
    if (r.opportunity_id) {
      await tx`update opportunities set status = 'CHECKOUT', next_action = 'Customer to confirm total and pay', next_action_owner = 'customer'
               where id = ${r.opportunity_id} and status in ('OFFERED', 'CHECKOUT')`;
    }
  });
  return {
    quote_id: id,
    product: r.name,
    qty: r.qty,
    unit_price: naira(r.unit_price_kobo),
    items_total: naira(itemsTotal),
    delivery: { zone: lq.zone, fee: naira(fee), service: lq.service, estimate: etaText },
    ...(forDate ? { for_date: forDate, for_date_label: dayLabel(forDate) } : {}),
    ...(r.notes ? { notes: r.notes } : {}),
    total: naira(itemsTotal + fee),
    total_kobo: Number(itemsTotal + fee),
    hold_expires_local: lagosDateTime(new Date(r.expires_at)),
    next_step: 'Tell the customer the full total and ask them to confirm. Only after they agree, call create_payment_link.',
  };
}

/**
 * Creates (or returns the existing open) Paystack test checkout for a quote. The attempt row is
 * reserved in our DB *before* calling Paystack, under a row lock, so concurrent calls can't pick the
 * same reference and a crash mid-call never leaves a reference we don't know about.
 */
export async function createPaymentLink(deps: Deps, input: { customer_ref?: string; quote_id: string }) {
  if (!deps.paystack)
    fail(
      'payments_not_configured',
      'Payments are not set up yet (no Paystack test key). Tell the customer the shop will send a payment link shortly.',
    );
  const [q] =
    await deps.sql`select q.*, r.customer_ref from quotes q join reservations r on r.id = q.reservation_id where q.id = ${input.quote_id}`;
  const notFound = () => fail('quote_not_found', `No quote ${input.quote_id} for this customer. Run prepare_checkout first.`);
  if (!q) notFound();
  assertOwner(q, input.customer_ref, notFound);
  const r = await liveHold(deps, q.reservation_id);

  for (let round = 0; round < 2; round++) {
    const step = await deps.sql.begin(async (tx) => {
      let [order] = await tx`select * from orders where quote_id = ${q.id} for update`;
      if (!order) {
        const [other] = await tx`select ref from orders where reservation_id = ${r.id} and status <> 'CANCELLED'`;
        if (other)
          fail('checkout_in_progress', `This hold already has order ${other.ref}. Use that payment link.`, { order_ref: other.ref });
        const [opp] = r.opportunity_id ? await tx`select alternative_sku from opportunities where id = ${r.opportunity_id}` : [null];
        const recovery = opp?.alternative_sku ? 'alternative' : opp ? 'restock' : 'direct';
        [order] = await tx`
          insert into orders (ref, quote_id, reservation_id, customer_ref, opportunity_id, sku, qty, unit_price_kobo, items_total_kobo,
                              delivery_fee_kobo, total_kobo, recovery_type, status, for_date, notes)
          values (${await newOrderRef(deps)}, ${q.id}, ${r.id}, ${r.customer_ref}, ${r.opportunity_id}, ${r.sku}, ${r.qty}, ${r.unit_price_kobo.toString()},
                  ${q.items_total_kobo.toString()}, ${q.delivery_fee_kobo.toString()}, ${q.total_kobo.toString()}, ${recovery}, 'PENDING_PAYMENT', ${r.for_date}, ${r.notes})
          returning *`;
      }
      if (!OPEN_ORDER.includes(order.status)) {
        fail('already_paid', `Order ${order.ref} is already ${order.status}. Use confirm_payment or track_order.`, {
          order_ref: order.ref,
          status: order.status,
        });
      }
      const [open] = await tx`select * from payments where order_ref = ${order.ref} and status in ('INITIALIZED', 'PENDING', 'ABANDONED')
                              order by attempt desc limit 1`;
      if (open?.authorization_url) return { order, payment: open, reused: true };
      if (open) fail('payment_link_pending', 'A payment link is being created right now. Try again in a moment.');
      const [{ max }] = await tx`select coalesce(max(attempt), 0)::int as max from payments where order_ref = ${order.ref}`;
      const [payment] = await tx`
        insert into payments (reference, order_ref, attempt, amount_kobo, status)
        values (${`${order.ref}-${max + 1}`}, ${order.ref}, ${max + 1}, ${order.total_kobo.toString()}, 'INITIALIZED') returning *`;
      return { order, payment, reused: false };
    });
    if (step.reused) return paymentLinkView(step.order, step.payment, r, true);

    try {
      const init = await deps.paystack!.initialize({
        email: q.email,
        amount_kobo: BigInt(step.order.total_kobo),
        reference: step.payment.reference,
        order_ref: step.order.ref,
        callback_url: `${deps.publicBaseUrl}/paystack/callback`,
      });
      const [pay] =
        await deps.sql`update payments set authorization_url = ${init.authorization_url} where reference = ${step.payment.reference} returning *`;
      await deps.sql`update orders set status = 'PENDING_PAYMENT' where ref = ${step.order.ref} and status = 'PAYMENT_FAILED'`;
      return paymentLinkView(step.order, pay, r, false);
    } catch (e) {
      const duplicate = e instanceof DomainError && /duplicate/i.test(String(e.internal.message ?? ''));
      await deps.sql`update payments set status = 'FAILED', failure_reason = ${duplicate ? 'duplicate_reference' : 'init_failed'}
                     where reference = ${step.payment.reference} and authorization_url is null`;
      if (!duplicate) throw e; // a duplicate means Paystack already has this reference: move on to the next attempt
    }
  }
  return fail('payment_init_failed', 'Paystack did not create a checkout link. Apologise and offer to try again shortly.');
}

const paymentLinkView = (order: any, payment: any, r: any, existing: boolean) => ({
  order_ref: order.ref,
  amount: naira(order.total_kobo),
  payment_url: payment.authorization_url,
  payment_reference: payment.reference,
  reused_existing_link: existing,
  pay_before: lagosDateTime(new Date(r.expires_at)),
  next_step: 'Send the link. When the customer says they have paid, call confirm_payment. Do not tell them it is confirmed before that.',
});

const statusFor = (paystackStatus: string) =>
  paystackStatus === 'abandoned' ? 'ABANDONED' : paystackStatus === 'failed' || paystackStatus === 'reversed' ? 'FAILED' : 'PENDING';

/**
 * Verify with Paystack and, only if everything matches, mark the order paid, take the stock and
 * book delivery. Every unpaid attempt is checked, newest first, so a customer who completes an
 * older link is still recognised. Safe to call repeatedly.
 */
export async function confirmPayment(
  deps: Deps,
  input: { order_ref: string; customer_ref?: string; source?: 'chat' | 'reconcile' | 'webhook' },
) {
  const ref = input.order_ref.trim().toUpperCase();
  const [order] = await deps.sql`select * from orders where ref = ${ref}`;
  const notFound = () => fail('order_not_found', `No order ${input.order_ref} for this customer.`);
  if (!order) notFound();
  assertOwner(order, input.customer_ref, notFound);

  if (PAID_ORDER.includes(order.status)) {
    if (!order.delivery_id) await bookDelivery(deps, order.ref); // recover a paid order whose booking never ran
    return orderSummary(deps, order.ref, { paid: true, already_confirmed: true });
  }
  if (!deps.paystack) fail('payments_not_configured', 'Payments are not set up yet.');

  const attempts = await deps.sql`select * from payments where order_ref = ${order.ref} and status <> 'SUCCESS'
                                  and authorization_url is not null order by attempt desc`;
  if (!attempts.length) fail('no_payment_link', 'No payment link has been created for this order yet. Call create_payment_link.');
  const now = deps.now();

  let latest: { payment: any; tx: Awaited<ReturnType<NonNullable<Deps['paystack']>['verify']>> } | null = null;
  for (const payment of attempts) {
    const tx = await deps.paystack!.verify(payment.reference);
    await deps.sql`update payments set last_checked_at = ${now} where reference = ${payment.reference}`;
    if (!latest) latest = { payment, tx };
    if (tx?.status === 'success') return settle(deps, order, payment, tx, input.source ?? 'chat');
    if (tx) {
      await deps.sql`update payments set status = ${statusFor(tx.status)}, gateway_status = ${tx.status}, failure_reason = ${tx.gateway_response ?? null}
                     where reference = ${payment.reference}`;
    }
  }

  const { payment, tx } = latest!;
  if (!tx) {
    return {
      paid: false,
      order_ref: order.ref,
      payment_status: 'NOT_STARTED',
      message: 'Paystack has no payment on this link yet. The customer may not have completed checkout.',
      payment_url: payment.authorization_url,
    };
  }
  const status = statusFor(tx.status);
  if (status === 'FAILED')
    await deps.sql`update orders set status = 'PAYMENT_FAILED' where ref = ${order.ref} and status = 'PENDING_PAYMENT'`;
  return {
    paid: false,
    order_ref: order.ref,
    payment_status: status,
    paystack_status: tx.status,
    gateway_message: tx.gateway_response ?? null,
    message:
      status === 'FAILED'
        ? 'Paystack says this payment failed. Nothing was charged as paid. Offer a fresh payment link (create_payment_link) while the hold lasts.'
        : 'Paystack has not confirmed this payment. Do NOT tell the customer it is confirmed. Ask them to finish checkout on the link, then check again.',
    payment_url: status === 'FAILED' ? null : payment.authorization_url,
  };
}

/** Paystack says success: check it is the payment we expected, then commit the sale atomically. */
async function settle(
  deps: Deps,
  order: any,
  payment: any,
  tx: NonNullable<Awaited<ReturnType<NonNullable<Deps['paystack']>['verify']>>>,
  source: string,
) {
  const now = deps.now();
  let meta = tx.metadata;
  if (typeof meta === 'string') {
    try {
      meta = JSON.parse(meta);
    } catch {
      meta = {};
    }
  }
  const problems: string[] = [];
  if (tx.reference !== payment.reference) problems.push(`reference ${tx.reference} ≠ ${payment.reference}`);
  if (tx.amount !== Number(payment.amount_kobo)) problems.push(`amount ${tx.amount} ≠ ${payment.amount_kobo}`);
  if ((tx.currency ?? '').toUpperCase() !== 'NGN') problems.push(`currency ${tx.currency}`);
  if (meta?.order_ref !== order.ref) problems.push(`order ${meta?.order_ref} ≠ ${order.ref}`);
  if (problems.length) {
    await deps.sql.begin(async (t) => {
      await t`update payments set status = 'FAILED', gateway_status = ${tx.status}, failure_reason = ${`mismatch: ${problems.join('; ')}`} where reference = ${payment.reference}`;
      await t`update orders set issue = 'amount_mismatch' where ref = ${order.ref}`;
      await queueNotification(t, {
        recipient_type: 'owner',
        recipient_ref: 'owner',
        reason: 'payment_mismatch',
        dedupe_key: `mismatch:${payment.reference}`,
        body: `Payment check failed for order ${order.ref}: Paystack reported a successful payment that doesn't match the order (${problems.join('; ')}). The order is NOT marked paid. Please review.`,
      });
    });
    return {
      paid: false,
      order_ref: order.ref,
      payment_status: 'MISMATCH',
      message: 'The payment does not match this order, so it is not confirmed. The shop owner has been alerted.',
    };
  }

  let stockConflict = false;
  await deps.sql.begin(async (t) => {
    const [o] = await t`select * from orders where ref = ${order.ref} for update`;
    if (!OPEN_ORDER.includes(o.status)) return; // a concurrent call won
    const p = await lockProduct(t, o.sku);
    const madeToOrder = p.fulfilment === 'made_to_order';
    const [r] = await t`select * from reservations where id = ${o.reservation_id} for update`;
    if (r.status === 'HELD') {
      // The hold becomes the booking: for made-to-order, a CONVERTED hold keeps the date's slot.
      await t`update reservations set status = 'CONVERTED', closed_at = ${now} where id = ${r.id}`;
      if (!madeToOrder && p.qty_on_hand < o.qty) stockConflict = true;
    } else if (madeToOrder) {
      // The hold lapsed before payment landed: only book if the date still has room.
      const free = await slotsFree(t, p.capacity_group!, isoDay(r.for_date)!, now);
      if (free < o.qty) stockConflict = true;
      else await t`update reservations set status = 'CONVERTED', closed_at = ${now} where id = ${r.id}`;
    } else {
      // The hold lapsed before payment landed: only sell if a unit is still genuinely free.
      const free = p.qty_on_hand - (await heldQty(t, p.sku, now));
      if (free < o.qty) stockConflict = true;
    }
    await t`update payments set status = 'SUCCESS', gateway_status = 'success', verified_at = ${now} where reference = ${payment.reference}`;
    if (stockConflict) {
      await t`update orders set status = 'PAID', paid_at = ${now}, issue = 'stock_conflict' where ref = ${o.ref}`;
      await queueNotification(t, {
        recipient_type: 'owner',
        recipient_ref: 'owner',
        reason: 'stock_conflict',
        dedupe_key: `conflict:${o.ref}`,
        body: madeToOrder
          ? `Urgent: order ${o.ref} (${p.name} for ${dayLabel(isoDay(o.for_date)!)}) was paid ${naira(o.total_kobo)}, but that date is now fully booked. Please fit it in, agree another date, or refund.`
          : `Urgent: order ${o.ref} (${p.name}) was paid ${naira(o.total_kobo)}, but there's no free stock left for it. Please source one or arrange a refund.`,
      });
    } else {
      if (!madeToOrder) await t`update products set qty_on_hand = qty_on_hand - ${o.qty}, updated_at = ${now} where sku = ${p.sku}`;
      await t`update orders set status = 'PAID', paid_at = ${now} where ref = ${o.ref}`;
    }
    if (o.opportunity_id) {
      await t`update opportunities set status = 'WON', next_action = null, next_action_owner = null, closed_at = ${now}, updated_at = ${now}
              where id = ${o.opportunity_id}`;
    }
    await emit(t, 'payment.verified', { order_ref: o.ref, source });
  });

  if (!stockConflict) await bookDelivery(deps, order.ref);
  return orderSummary(deps, order.ref, { paid: true, already_confirmed: false });
}

/**
 * Book the courier. Failure leaves the order paid but FULFILLMENT_PENDING with backoff; the owner is
 * alerted once. A 4xx from the courier won't fix itself, so it stops retrying and asks the owner.
 */
export async function bookDelivery(deps: Deps, orderRef: string) {
  const [o] = await deps.sql`
    select o.*, q.logistics_quote_id, q.address, c.display_name from orders o
    join quotes q on q.id = o.quote_id join customers c on c.ref = o.customer_ref where o.ref = ${orderRef}`;
  if (
    !o ||
    o.delivery_id ||
    !['PAID', 'FULFILLMENT_PENDING'].includes(o.status) ||
    o.issue === 'stock_conflict' ||
    o.issue === 'delivery_needs_owner'
  )
    return;
  try {
    const d = await deps.logistics.book({
      quote_id: o.logistics_quote_id,
      order_ref: o.ref,
      recipient_name: o.display_name ?? 'Customer',
      address: o.address ?? undefined,
    });
    await deps.sql`update orders set status = 'DELIVERY_BOOKED', issue = null, delivery_id = ${d.id}, tracking_ref = ${d.tracking_ref}
                   where ref = ${o.ref} and delivery_id is null`;
  } catch (e) {
    if (!(e instanceof DomainError)) throw e;
    const attempts = o.delivery_attempts + 1;
    const status = Number(e.details.status ?? 0);
    const permanent = (status >= 400 && status < 500 && status !== 429) || attempts >= MAX_DELIVERY_ATTEMPTS;
    await deps.sql.begin(async (t) => {
      const [u] = await t`
        update orders set status = 'FULFILLMENT_PENDING', issue = ${permanent ? 'delivery_needs_owner' : 'delivery_booking_failed'},
               delivery_attempts = ${attempts}, next_delivery_at = ${minutesFrom(deps.now(), 2 ** Math.min(attempts, 6))}
        where ref = ${o.ref} and delivery_id is null and status in ('PAID', 'FULFILLMENT_PENDING')
        returning ref`;
      if (u && (o.issue !== 'delivery_booking_failed' || permanent)) {
        await emit(t, 'fulfillment.failed', { order_ref: o.ref, reason: e.message, permanent });
      }
    });
  }
}

/** Paid orders without a booking: failed bookings (with backoff) and ones interrupted by a restart. */
export async function retryPendingFulfillment(deps: Deps) {
  const now = deps.now();
  const rows = await deps.sql`
    select ref from orders
    where status in ('PAID', 'FULFILLMENT_PENDING') and delivery_id is null
      and coalesce(issue, '') not in ('stock_conflict', 'delivery_needs_owner')
      and (next_delivery_at is null or next_delivery_at <= ${now})
      and paid_at < ${new Date(now.getTime() - 60_000)}
    limit 20`;
  for (const r of rows) await bookDelivery(deps, r.ref);
  return { retried: rows.length };
}

async function orderSummary(deps: Deps, ref: string, extra: Record<string, unknown>) {
  const [o] = await deps.sql`select o.*, p.name, q.delivery_eta_text from orders o join products p on p.sku = o.sku
                             join quotes q on q.id = o.quote_id where o.ref = ${ref}`;
  const [pay] = await deps.sql`select reference from payments where order_ref = ${ref} and status = 'SUCCESS' limit 1`;
  return {
    ...extra,
    order_ref: o.ref,
    product: o.name,
    qty: o.qty,
    total_paid: naira(o.total_kobo),
    payment_reference: pay?.reference ?? null,
    order_status: o.status,
    issue: o.issue,
    ...(o.for_date ? { for_date: isoDay(o.for_date), for_date_label: dayLabel(isoDay(o.for_date)!) } : {}),
    ...(o.notes ? { notes: o.notes } : {}),
    delivery: o.delivery_id
      ? { tracking_ref: o.tracking_ref, estimate: o.delivery_eta_text }
      : o.issue === 'delivery_booking_failed' || o.issue === 'delivery_needs_owner'
        ? {
            tracking_ref: null,
            message:
              'Payment is confirmed, but booking the courier failed. The shop has been alerted and is arranging delivery. Do not give the customer a tracking number.',
          }
        : o.issue === 'stock_conflict'
          ? {
              tracking_ref: null,
              message: 'Payment is confirmed, but the item had already gone. The shop owner has been alerted to source one or refund.',
            }
          : { tracking_ref: null, message: 'Payment is confirmed; delivery is being booked.' },
  };
}

/** Live delivery status from the courier; never an invented ETA. */
export async function trackOrder(deps: Deps, input: { order_ref: string; customer_ref?: string }) {
  const [o] =
    await deps.sql`select o.*, p.name from orders o join products p on p.sku = o.sku where o.ref = ${input.order_ref.trim().toUpperCase()}`;
  const notFound = () =>
    fail(
      'order_not_found',
      `No order ${input.order_ref} for this customer. Ask them to check the reference (it looks like SR-1234-ABCD), or use get_my_updates.`,
    );
  if (!o) notFound();
  assertOwner(o, input.customer_ref, notFound);
  if (!o.delivery_id) {
    return {
      order_ref: o.ref,
      product: o.name,
      order_status: o.status,
      issue: o.issue,
      delivery: null,
      message: o.status === 'PENDING_PAYMENT' ? 'Not paid yet, so no delivery has been booked.' : 'No delivery has been booked yet.',
    };
  }
  const d = await deps.logistics.get(o.delivery_id);
  if (d.status === 'DELIVERED' && o.status !== 'DELIVERED') await deps.sql`update orders set status = 'DELIVERED' where ref = ${o.ref}`;
  return {
    order_ref: o.ref,
    product: o.name,
    order_status: d.status === 'DELIVERED' ? 'DELIVERED' : o.status,
    delivery: { tracking_ref: d.tracking_ref, status: d.status, estimate: d.eta_text, last_update: d.updated_at, history: d.history },
  };
}

/**
 * Paystack webhook (charge.success): how a customer who pays but never says so still gets confirmed.
 * The body is only a hint to re-verify through the API; nothing in it is trusted.
 */
export async function handlePaystackEvent(deps: Deps, event: { event?: string; data?: { reference?: string } }) {
  if (event.event !== 'charge.success' || !event.data?.reference) return { handled: false };
  const [p] = await deps.sql`select order_ref from payments where reference = ${String(event.data.reference)}`;
  if (!p) return { handled: false };
  await confirmPayment(deps, { order_ref: p.order_ref, source: 'webhook' });
  return { handled: true };
}
