# Deploy Sales Rescue to Railway

This guide tells you how to deploy Sales Rescue to Railway and how to operate it after the deploy.

## What the infrastructure includes

The file [`.railway/railway.ts`](../.railway/railway.ts) defines the infrastructure as code. It uses the Railway IaC format, and the Railway CLI applies it. It defines these items:

- **`postgres`**: A Postgres database that Railway manages.
- **`sales-rescue`**: The app service. Railway builds it from the [`Dockerfile`](../Dockerfile). It has a health check on `/healthz`, it restarts after a failure, and it has 1 replica. Use only 1 replica, because the background worker must not run twice.
- **Environment variables**: All the variables that [`src/config.ts`](../src/config.ts) requires. `DATABASE_URL` refers to the Postgres service. `PUBLIC_BASE_URL` comes from the Railway domain of the service. The secrets are marked `preserve()`. Thus, the deploy script sets them from your `.env` file, and the repository never contains them.

At the first start, the app makes the database schema and loads the data in `fixtures/` (Flavorburst Bakes and Treats). If the database already has a merchant, the app does not load the data again.

## Deploy

Before you start, make sure that you have these items:

- The [Railway CLI](https://docs.railway.com/cli). Sign in with `railway login`.
- A complete `.env` file. See `.env.example`. The deploy script checks each variable.

Run this command:

```bash
pnpm deploy:railway
```

The script [`scripts/deploy-railway.sh`](../scripts/deploy-railway.sh) does these steps. You can run it again safely.

1. It checks the secrets in `.env` with the same rules that the service uses at startup.
2. It links the `sales-rescue` project. If the project does not exist, it makes the project.
3. It runs `railway config plan` and `railway config apply`. These commands make or update the database, the app service and the variables.
4. It sets the secrets from `.env`: `MCP_TOKEN`, `OWNER_PIN`, `LOGISTICS_API_KEY`, `PAYSTACK_SECRET_KEY` and the `CHORD_*` variables.
5. It makes the public `*.up.railway.app` domain on port 8787, one time only. Railway keeps generated domains outside the IaC file.
6. It uploads and deploys the code with `railway up`. Then it waits until `/healthz` replies.

At the end, the script prints the URL of the service. Then do these two steps:

1. Connect the Chord teammate to the new URL:

   ```bash
   PUBLIC_BASE_URL=https://<domain> pnpm chord:setup
   ```

2. In the Paystack dashboard, open **Settings > API Keys & Webhooks**. Set the **Test Webhook URL** to `https://<domain>/paystack/webhook`. Paystack uses this webhook to confirm payments that the customer does not tell the agent about.

## Daily operation

| Task | Command or action |
|---|---|
| Deploy new code | `pnpm deploy:railway`, or `railway up --service sales-rescue` |
| Change the infrastructure | Edit `.railway/railway.ts`. Then run `railway config plan` and `railway config apply`. |
| Change a secret | Update `.env`, then run `pnpm deploy:railway`. You can also run `railway variable set NAME --service sales-rescue`. |
| Read the logs | `railway logs --service sales-rescue`. Each log line is JSON. Important events are `tool_call`, `paystack_webhook` and `worker_step_error`. |
| Pause the agent | `pnpm chord:setup --pause` |

## Before real customers use the service

- Turn on Postgres backups.
- Add an uptime monitor on `/healthz`. Payments use webhooks. If the service is down, Paystack events can be lost.

## Two workers during a deploy

During a deploy, Railway runs the old container and the new container together for some seconds. Thus, two workers can run at the same time. This does not cause problems, because each worker action is idempotent. Unique keys, row locks and duplicate checks on messages prevent duplicate records.
