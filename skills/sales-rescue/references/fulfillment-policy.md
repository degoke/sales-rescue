# Checkout, payment and delivery

Follow these steps in order. Each step's facts come from the tool you just called. Pass the
customer's `customer_ref` on every call: the tools only find records that belong to this customer.

## 1. Hold the item (or the date)
`reserve_product(customer_ref, sku, qty)` (with `alternative_to_sku` if it's a substitute).
For made-to-order items, also pass `for_date` (YYYY-MM-DD) and `notes` (flavour, colours,
inscription; short and factual).
- `insufficient_stock` → tell them how many are actually available. Offer alternatives or the waiting list.
- `date_required` → ask which date they need, then `check_dates`.
- `too_soon` / `date_full` → offer the dates the error returned (see `sales-policy.md`).
- `too_many_holds` → they already have items held; finish or drop one first.
- Tell them it's held until `expires_local`, and for cakes read back the date and notes.

## 2. Delivery area and email
Ask, in one message, for the Lagos area for delivery (and street address if they offer it) and an
email for the Paystack receipt.

## 3. Quote
`prepare_checkout(customer_ref, reservation_id, zone, email, address?)`
- `unsupported_zone` → list the `supported_zones` from the result and ask which works.
- `hold_expired` → explain the hold ran out, check again (`search_products` or `check_dates`), and
  re-reserve if it's still available.
- `checkout_in_progress` → a payment link was already sent for this hold. Resend that link
  (`payment_url`). Changing the delivery area after that needs Favour.
- Tell them: item price × qty, delivery fee and estimate (for cakes: the booked date), **total**.
  Ask: "Shall I send the payment link?"

## 4. Payment link (only after they agree to the total)
`create_payment_link(customer_ref, quote_id)` → send `payment_url` and say it's a secure Paystack
page. Mention the hold time (`pay_before`). Calling it again returns the same link, so don't worry
about duplicates.

## 5. Confirming payment
When they say they've paid: `confirm_payment(customer_ref, order_ref)`. (Paystack also notifies the
shop directly, so a customer who paid and went quiet still gets confirmed.)
- `paid: true` → confirm the order: order ref, amount paid, the date for cakes, and the delivery
  tracking ref and estimate.
- `paid: false`, `payment_status` ABANDONED / PENDING / NOT_STARTED → "Paystack hasn't confirmed your
  payment yet." Ask them to complete it on the same link (resend `payment_url`) and tell you when done.
  Do **not** say the order is confirmed.
- `payment_status: FAILED` → the payment didn't go through. Offer a fresh link (`create_payment_link`
  again) while the hold lasts.
- `payment_status: MISMATCH` → say the payment couldn't be matched to their order and Favour has
  been alerted. Hand over.
- `delivery.tracking_ref` is null with a message → payment is confirmed but delivery isn't booked
  yet. Say exactly that, and that the shop is sorting delivery. Never invent a tracking number.

## 6. Tracking
`track_order(customer_ref, order_ref)`: repeat `delivery.status` in plain words (BOOKED = booked
with the courier, PICKED_UP = collected, IN_TRANSIT = on the way, DELIVERED, FAILED_ATTEMPT = the
rider couldn't deliver) and the `estimate` exactly as given. For FAILED_ATTEMPT, apologise and share
the estimate; don't invent a new time. Order refs look like `SR-1042-K7QX`. If they can't find
theirs, `get_my_updates` lists their orders.
