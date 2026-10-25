# Sales Rescue

Sales Rescue is a Chord teammate on WhatsApp. It keeps sales for a small business when an item is sold out or a date is full.

The agent is built and runs on Chord:

- **Teammate:** **Flavorburst · Sales Rescue** (`869ac045-a7af-4eb2-9d0b-52b1b60983ad`). You can talk to it in the Chord WhatsApp simulator.
- **Skill files:** [`skills/sales-rescue/`](skills/sales-rescue/). The setup script publishes them to the teammate on Chord.
- **Tool code:** [`src/`](src/). It is an MCP server with 15 tools ([`src/mcp/server.ts`](src/mcp/server.ts)). Chord calls it over HTTPS. The tools use a Postgres database, Paystack in test mode and a mock courier API.

## How it works

```
Customer or owner (WhatsApp)
        │
        ▼
Chord teammate + skill ──── MCP over HTTPS (bearer token) ────► Sales Rescue service (Node, Hono)
        ▲                                                        ├─ Postgres: products, daily slots, waitlists, holds, orders
        │                                                        ├─ Paystack (test mode): payment links, verification, webhook
        │                                                        ├─ Courier API (/logistics): quotes, bookings, tracking
        └──── Chord MESSAGE tasks (offers and owner alerts) ──── └─ Background worker
```

The agent talks to the customer and decides which tool to call. The service holds all the business rules. The agent cannot change stock, mark a payment as paid or promise a delivery. Only the service can do these things.

### MCP tools

The service exposes 15 tools on `POST /mcp`. Each tool validates its input with zod.

| For | Tools |
|---|---|
| Customers | `search_products`, `check_dates`, `reserve_product`, `register_interest`, `withdraw_interest`, `get_my_updates`, `prepare_checkout`, `create_payment_link`, `confirm_payment`, `track_order` |
| Owner (PIN required) | `verify_owner`, `update_inventory`, `manage_capacity`, `manage_restock`, `get_demand_summary` |

### Stock, dates and waitlists

- **Stock items** (for example chin-chin and banana bread) have a quantity. When an item is sold out, `search_products` returns similar items that are available.
- **Made-to-order items** (for example cakes) have a minimum notice and a daily limit for each group: cakes, bentos, bouquets and platters. `check_dates` returns the nearest free dates.
- **Holds:** `reserve_product` holds an item or a date for 30 minutes while the customer pays. A row lock (`SELECT … FOR UPDATE`) makes sure that two customers cannot get the last unit or the last slot.
- **Waitlists:** a customer joins only after they agree, and pays nothing. When the owner adds stock or a slot, the service offers it to the waitlist in order. Each offer is a hold for 60 minutes.

### Payments (Paystack)

1. `create_payment_link` starts a Paystack transaction and returns the checkout link.
2. Paystack calls `POST /paystack/webhook`. The service checks the HMAC-SHA512 signature, then verifies the transaction with the Paystack API.
3. The order is paid only when the reference, the amount, the currency and the order reference all agree.
4. If they do not agree, the order stays unpaid and the owner gets an alert. If the customer says "I've paid", `confirm_payment` does the same verification.

The service refuses Paystack keys that do not start with `sk_test_`.

### Delivery (courier API)

The service includes a mock courier API at `/logistics`, with its own API key. It works like a real courier API:

- `POST /logistics/delivery/quote` returns a fee and a delivery estimate for each Lagos zone, for example Lekki, Yaba and Ikeja.
- `POST /logistics/deliveries` books a delivery and returns a tracking reference.
- `GET /logistics/deliveries/:id` returns the delivery status. `track_order` uses it.
- `POST /logistics/_simulate/fail-next-booking` makes the next booking fail, so that you can test the failure path.

After payment, the service books the delivery. If the courier fails, the order status changes to `FULFILLMENT_PENDING`, the owner gets an alert, and the worker tries again with backoff.

### Background worker

The worker runs in the service on a timer. Each step runs separately, so one failure does not stop the other steps:

1. Expire holds that the customer did not pay for, and give the item to the next customer on the waitlist.
2. Process events from the outbox table, for example "stock added", and make offers.
3. Retry delivery bookings that failed.
4. Send restock reminders to the owner.
5. Send messages to customers and to the owner as Chord `MESSAGE` tasks.

### Safety

- **Idempotency:** unique indexes stop duplicate holds, orders, payments, deliveries and messages. A repeated tool call returns the same record.
- **Owner PIN:** Chord does not tell tools who sent a message, so owner tools require a PIN. The service stores only a scrypt hash. After 5 incorrect PINs, owner tools lock for 15 minutes.
- **Untrusted input:** the model writes tool arguments, so the service checks them. Each string has a maximum length, each ID has a fixed format, and order lookups require the correct customer ID. Text from customers never goes into outbound messages.
- **Configuration:** the service validates all environment variables at startup. No variable has a default value.

### Repository

```
skills/sales-rescue/      Skill: SKILL.md and reference files (business, sales policy, owner tasks, checkout)
src/mcp/server.ts         The 15 MCP tools
src/merchant/             Business logic: products, daily slots, holds, waitlists, orders, owner PIN
src/payments/             Paystack client
src/logistics/            Mock courier API and its client
src/events/worker.ts      Background worker
src/db/schema.sql         Postgres schema
fixtures/                 Flavorburst products, daily limits and sample customers
scripts/chord-setup.ts    Sets up the teammate, MCP server and skill on Chord
.railway/railway.ts       Railway infrastructure as code
tests/                    65 tests (Vitest with Postgres)
```

## Run it

You need these items:

- Node 22, pnpm and Docker
- A Chord API key from the account owner
- A Paystack test secret key (it starts with `sk_test_`)
- A public HTTPS URL for the service. Chord calls only public HTTPS URLs.

### Deploy to Railway

1. Install the [Railway CLI](https://docs.railway.com/cli), and sign in with `railway login`.
2. Copy `.env.example` to `.env`, and give a value to each variable.
3. Deploy the service and its database:

   ```bash
   pnpm install
   pnpm deploy:railway
   ```

4. Run the `pnpm chord:setup` command that the deploy script prints. This command makes or updates the teammate, connects the tools and publishes the skill.
5. In the Paystack dashboard, set the **Test Webhook URL** to `https://<your-domain>/paystack/webhook`.

For more information, see [`docs/DEPLOY.md`](docs/DEPLOY.md).

### Run on your computer

1. Copy `.env.example` to `.env`, and give a value to each variable.
2. Start Postgres, run the checks and start the service on port 8787:

   ```bash
   pnpm install
   docker compose up -d
   pnpm check
   pnpm dev
   ```

3. In a different terminal, start a tunnel. Put the tunnel URL in `PUBLIC_BASE_URL` in `.env`.

   ```bash
   cloudflared tunnel --url http://localhost:8787
   ```

4. Set up the teammate on Chord. Then restart `pnpm dev`.

   ```bash
   pnpm chord:setup
   ```

To load the sample data in `fixtures/` again, run `pnpm db:reset`.

## Try it

Open the WhatsApp simulator at https://chat.tsglabs.dev, and select **Flavorburst · Sales Rescue**.

1. As a customer, ask "Do you have the mini banana bread?" It is sold out. Say no to the alternative, and join the waitlist.
2. In a new chat, say "This is Favour, the owner." Send the PIN (`OWNER_PIN` in `.env`). Then say "I just baked 4 more."
3. Go back to the customer chat and send "hi". The agent offers the loaf that it holds for you. Accept it, give "Lekki" and an email, and pay with a Paystack test card.
4. Ask "Can you make a custom cake this Saturday?" Saturday is full, so the agent offers other dates or the waitlist.

## How AI was used

I chose the problem and the business, made the design decisions and tested the agent in the Chord simulator and dashboard. I used Claude Code as an assistant to write code. It wrote drafts of the code, tests, skill text and documents from my instructions, and I examined and corrected its output.
