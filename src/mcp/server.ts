// The tool surface Chord's teammate sees. Each tool is a thin, validated call into the domain;
// every business rule lives in src/merchant so it holds no matter what the model asks for.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { DomainError } from '../lib/errors.js';
import { checkDates, searchProducts } from '../merchant/products.js';
import { manageCapacity } from '../merchant/capacity.js';
import { getMyUpdates, registerInterest, withdrawInterest } from '../merchant/opportunities.js';
import { reserveProduct } from '../merchant/reservations.js';
import { confirmPayment, createPaymentLink, prepareCheckout, trackOrder } from '../merchant/orders.js';
import { verifyOwner } from '../merchant/owner.js';
import { updateInventory } from '../merchant/inventory.js';
import { getDemandSummary } from '../merchant/metrics.js';
import { manageRestock } from '../merchant/restock.js';

// Every string is bounded and ids are shape-checked: arguments are model-supplied and some flow
// back into other people's tool results.
const customerRef = z
  .string()
  .regex(/^[A-Za-z0-9+_.-]{3,128}$/, 'customer_ref must be the sender id exactly as shown')
  .describe('The sender id of the person you are talking to, exactly as you see it (e.g. "+2348012345678" or "customer_…").');
const sku = z
  .string()
  .regex(/^[A-Za-z0-9-]{2,20}$/)
  .describe('Product SKU from search_products, e.g. "FB-CHIN-JAR".');
const orderRef = z
  .string()
  .regex(/^[A-Za-z0-9-]{3,40}$/)
  .describe('Order reference, e.g. "SR-1042-K7QX"');
const id = z.string().regex(/^[A-Za-z0-9-]{3,40}$/);
const qty = z.number().int().min(1).max(5).optional().describe('1–5; larger orders go to the owner');
const displayName = z.string().max(60).optional();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const ownerToken = z.string().max(100).optional().describe('Token from verify_owner, if you still have it.');
const ownerPin = z
  .string()
  .max(12)
  .optional()
  .describe("The owner's PIN exactly as they typed it in this conversation. Required unless you have a valid owner_token.");

export function log(event: string, data: Record<string, unknown>) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
}

export function buildMcpServer(deps: Deps) {
  const server = new McpServer({ name: 'sales-rescue', version: '1.0.0' });

  function tool<S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    run: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
  ) {
    server.registerTool(name, { description, inputSchema: shape }, (async (args: z.infer<z.ZodObject<S>>) => {
      const started = Date.now();
      try {
        const result = await run(args);
        log('tool_call', { tool: name, ok: true, ms: Date.now() - started, customer_ref: (args as any)?.customer_ref });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 1) }] };
      } catch (e) {
        if (e instanceof DomainError) {
          log('tool_call', { tool: name, ok: false, code: e.code, ms: Date.now() - started });
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify({ error: e.code, message: e.message, ...e.details }) }],
          };
        }
        log('tool_error', { tool: name, error: String(e), stack: (e as Error)?.stack?.split('\n').slice(0, 4).join(' | ') });
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: 'internal_error',
                message: 'Something went wrong on our side. Apologise, do not guess, and offer to have the shop follow up.',
              }),
            },
          ],
        };
      }
    }) as any);
  }

  // ── Customer journey ──────────────────────────────────────────────────────────────
  tool(
    'search_products',
    'Find products and their LIVE availability and price. Use before saying anything about stock or price. If the best match is sold out, the result includes real in-stock alternatives to offer. Each product has an image_url: share it as a link so the customer can see it (this chat cannot send pictures).',
    {
      query: z.string().min(1).max(200).describe('What the customer asked for, in their words.'),
      colour: z.string().max(30).optional(),
      category: z.string().max(30).optional(),
      max_price: z.number().positive().optional().describe('Naira'),
    },
    (a) => searchProducts(deps, a),
  );

  tool(
    'register_interest',
    'Add the customer to the waiting list: for a sold-out stock item (until it is restocked), or for a FULLY BOOKED date of a made-to-order item (pass for_date; offered if a slot opens). ONLY after they explicitly agreed to be messaged. No payment is taken; this is not a preorder.',
    {
      customer_ref: customerRef,
      sku,
      qty,
      consent: z.boolean().describe('true only if the customer said yes to being notified'),
      display_name: displayName,
      for_date: isoDate.optional().describe('Made-to-order only: the fully booked date they want (YYYY-MM-DD)'),
    },
    (a) => registerInterest(deps, a),
  );

  tool(
    'withdraw_interest',
    'The customer no longer wants a product (declines an offer or the waitlist), or asks to stop messages (opt_out=true). Releases anything held for them.',
    { customer_ref: customerRef, sku: sku.optional(), opt_out: z.boolean().optional() },
    (a) => withdrawInterest(deps, a),
  );

  tool(
    'get_my_updates',
    'Call at the START of every conversation, and whenever a message ends with "(ref NTF-…)" or "(ref REM-…)". Returns the customer\'s open requests, holds set aside for them, orders, and messages the shop has sent them.',
    { customer_ref: customerRef },
    (a) => getMyUpdates(deps, a),
  );

  tool(
    'reserve_product',
    'Hold stock for the customer for a limited time before checkout. Also used to accept a restock offer. Pass alternative_to_sku when they are buying a substitute for a sold-out item. Made-to-order items need for_date (from check_dates) and optional notes; this holds a baking slot on that date.',
    {
      customer_ref: customerRef,
      sku,
      qty,
      display_name: displayName,
      alternative_to_sku: sku.optional(),
      for_date: isoDate.optional().describe('Required for made-to-order items: the delivery date (YYYY-MM-DD) from check_dates'),
      notes: z.string().max(280).optional().describe('Made-to-order customisation: flavour, colours, inscription, theme'),
    },
    (a) => reserveProduct(deps, a),
  );

  tool(
    'prepare_checkout',
    'Get the delivery fee and full total for a held item. Does NOT charge anything. Tell the customer the total and get their agreement before create_payment_link.',
    {
      customer_ref: customerRef,
      reservation_id: id,
      zone: z.string().min(1).max(60).describe('Lagos delivery area, e.g. "Lekki", "Yaba", "Ikeja"'),
      email: z.string().min(3).max(254).describe("Customer's email for the Paystack receipt"),
      address: z.string().max(300).optional(),
    },
    (a) => prepareCheckout(deps, a),
  );

  tool(
    'create_payment_link',
    'Create the Paystack checkout link for an agreed quote. Safe to call again: it returns the existing open link.',
    { customer_ref: customerRef, quote_id: id },
    (a) => createPaymentLink(deps, a),
  );

  tool(
    'confirm_payment',
    'Verify payment with Paystack and, only if verified, confirm the order and book delivery. Call when the customer says they paid. Never tell them it is confirmed unless this returns paid=true.',
    { customer_ref: customerRef, order_ref: orderRef },
    (a) => confirmPayment(deps, { ...a, source: 'chat' }),
  );

  tool(
    'track_order',
    "Current delivery status from the courier. Use the result's status and estimate exactly; never invent a time.",
    { customer_ref: customerRef, order_ref: orderRef },
    (a) => trackOrder(deps, a),
  );

  tool(
    'check_dates',
    'For MADE-TO-ORDER items (cakes, bentos, bouquets, platters): can it be made for a date? Checks lead time and free baking slots, and returns the next available dates. Use before promising any date; work out dates from today in Lagos.',
    { sku, date: isoDate.optional().describe('The date the customer wants (YYYY-MM-DD)'), qty },
    (a) => checkDates(deps, a),
  );

  // ── Owner (PIN-protected) ────────────────────────────────────────────────────────
  tool(
    'verify_owner',
    'When someone says they are the shop owner, ask for the owner PIN and pass it here. Owner tools only work with the token this returns. A claimed name or phone number is NOT proof.',
    {
      pin: z.string().min(1).max(12),
      sender_id: customerRef.optional().describe('Your view of the sender id, used only to route reminders'),
    },
    (a) => verifyOwner(deps, a),
  );

  tool(
    'update_inventory',
    'OWNER ONLY. Change stock or price. op: "increment" = units ADDED ("add 10", "received 6"); "set" = new TOTAL ("we have 10 now"); "price" = new price in naira; "sold_out"; "discontinue". If unsure which the owner means, ask. Large changes return needs_confirmation: read the after-values back and resend with confirmation_id.',
    {
      owner_token: ownerToken,
      pin: ownerPin,
      sku,
      op: z.enum(['increment', 'set', 'price', 'sold_out', 'discontinue']),
      value: z.number().optional(),
      confirmation_id: id.optional(),
    },
    (a) => updateInventory(deps, a),
  );

  tool(
    'get_demand_summary',
    'OWNER ONLY. Who is waiting for what, potential sales value, restock dates, recovered revenue and other metrics, fulfilment problems, upcoming reminders, and unread alerts for the owner.',
    { owner_token: ownerToken, pin: ownerPin, sku: sku.optional() },
    (a) => getDemandSummary(deps, a),
  );

  tool(
    'manage_capacity',
    'OWNER ONLY. Made-to-order baking capacity. action: "view" (next 7 days: capacity, booked, free, waiting), "set_date" (slots for one date, e.g. "I can do 4 cakes on Saturday"), "close_date" (no orders that day), "set_default" (normal slots per day). Pass a made-to-order sku or group. Opening room on a date with a waiting list offers it to them automatically.',
    {
      owner_token: ownerToken,
      pin: ownerPin,
      sku: sku.optional(),
      group: z.string().max(30).optional(),
      action: z.enum(['view', 'set_date', 'close_date', 'set_default']),
      date: isoDate.optional(),
      slots: z.number().int().min(0).max(100).optional(),
    },
    (a) => manageCapacity(deps, a),
  );

  tool(
    'manage_restock',
    'OWNER ONLY. Record what the supplier said. record_eta (expected_date YYYY-MM-DD, confirmed?), confirm_eta, snooze (remind_at: YYYY-MM-DD or ISO time, "remind me Monday"), not_restocking (closes the waitlist and tells customers). Replaces any existing reminder rather than adding another.',
    {
      owner_token: ownerToken,
      pin: ownerPin,
      sku,
      action: z.enum(['record_eta', 'confirm_eta', 'snooze', 'not_restocking']),
      expected_date: z.string().max(10).optional(),
      confirmed: z.boolean().optional(),
      remind_at: z.string().max(30).optional(),
      qty_expected: z.number().int().positive().max(10000).optional(),
      note: z.string().max(280).optional().describe('Owner-only note; never shown to customers'),
    },
    (a) => manageRestock(deps, a),
  );

  return server;
}
