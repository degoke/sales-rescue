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
Chord teammate + skill ──── MCP over HTTPS ────► Sales Rescue service (Node, Hono)
        ▲                                         ├─ Postgres: products, waitlists, holds, orders
        │                                         ├─ Paystack (test mode): payments
        │                                         ├─ Courier API: delivery quotes, bookings, tracking
        └──── Chord messages (offers, alerts) ─── └─ Background worker
```

- **The agent** talks to customers and to the owner, and calls the tools. It cannot change stock, mark a payment as paid or promise a delivery. Only the service can.
- **The tools** let customers find items, check dates, join a waitlist, pay and track an order. Owner tools need a PIN.
- **Payments** are confirmed only after Paystack verifies them, through a signed webhook.
- **Delivery** uses a mock courier API in the same service. If a booking fails, the owner gets an alert and the service tries again.
- **The background worker** releases unpaid holds, offers new stock to the waitlist in order, and sends messages through Chord.

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
