#!/usr/bin/env bash
# Deploy Sales Rescue to Railway with your local Railway CLI. Safe to re-run.
#
#   1. links (or creates) the Railway project
#   2. `railway config apply` → Postgres + the app service + variables from .railway/railway.ts
#   3. sets the secrets from your local .env (they never go in the repo)
#   4. creates the public *.up.railway.app domain (once)
#   5. uploads and deploys the code (`railway up`)
#
# Usage: pnpm deploy:railway
set -euo pipefail
cd "$(dirname "$0")/.."

SERVICE="sales-rescue"
PROJECT="sales-rescue"
PORT="8787"
SECRETS=(MCP_TOKEN OWNER_PIN LOGISTICS_API_KEY PAYSTACK_SECRET_KEY CHORD_API_KEY CHORD_WORKSPACE_ID CHORD_TEAMMATE_ID)

say() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
die() { printf '\n\033[31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

command -v railway >/dev/null || die "Railway CLI not found: https://docs.railway.com/cli"
railway whoami >/dev/null 2>&1 || die "Not logged in: run 'railway login'"
[ -f .env ] || die ".env not found (cp .env.example .env and fill it in)"

# Secrets come from .env and are validated with the same rules the service uses at startup.
say "Validating secrets in .env"
pnpm exec tsx scripts/check-env.ts "${SECRETS[@]}"

say "Linking the Railway project"
# Always link this folder to the "$PROJECT" project by name. Never trust an existing link: the
# Railway CLI also applies links from parent folders (for example a link on your home folder), and
# `railway config apply` deletes every resource in the linked project that railway.ts does not list.
project_id="$(railway list --json | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const found = [];
    const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") {
      if (v.name === process.argv[1] && typeof v.id === "string") found.push(v.id); Object.values(v).forEach(walk); } };
    walk(JSON.parse(s || "[]"));
    process.stdout.write(found[0] ?? "");
  });' "$PROJECT")"
if [ -n "$project_id" ]; then railway link --project "$project_id"; else railway init --name "$PROJECT"; fi

linked="$(railway status --json | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>process.stdout.write(JSON.parse(s).name ?? ""))')"
[ "$linked" = "$PROJECT" ] || die "This folder is linked to the project \"$linked\", not \"$PROJECT\". Stopped before any change."
railway status

say "Applying .railway/railway.ts (Postgres, $SERVICE, variables)"
plan="$(railway config plan 2>&1)" || { echo "$plan"; die "railway config plan failed"; }
echo "$plan"
# Refuse to delete anything. A delete means the project holds resources that railway.ts does not list.
destroy="$(printf '%s\n' "$plan" | grep -oE '[0-9]+ to destroy' | grep -oE '^[0-9]+' || true)"
if [ -n "$destroy" ] && [ "$destroy" != "0" ]; then
  die "The plan deletes $destroy resource(s) in \"$linked\". Stopped before any change."
fi
railway config apply --yes

say "Setting secrets from .env"
for name in "${SECRETS[@]}"; do
  node -e "require('dotenv').config({ quiet: true }); process.stdout.write(process.env[process.argv[1]] ?? '')" "$name" \
    | railway variable set "$name" --stdin --service "$SERVICE" --skip-deploys >/dev/null
  echo "  ✓ $name"
done

say "Public domain"
domain="$(railway domain list --service "$SERVICE" --json 2>/dev/null | grep -oE '[a-z0-9.-]+\.up\.railway\.app' | head -1 || true)"
if [ -z "$domain" ]; then
  domain="$(railway domain --service "$SERVICE" --port "$PORT" --json | grep -oE '[a-z0-9.-]+\.up\.railway\.app' | head -1)"
fi
[ -n "$domain" ] || die "Could not read the service domain (check 'railway domain list --service $SERVICE')"
echo "  https://$domain"

say "Deploying the code"
railway up --service "$SERVICE" --ci

say "Health check"
for _ in $(seq 1 30); do
  if curl -fsS "https://$domain/healthz" >/dev/null 2>&1; then echo "  ✓ https://$domain/healthz"; break; fi
  sleep 5
done

cat <<EOF

Deployed: https://$domain

Next:
  1. Point Chord at it:     PUBLIC_BASE_URL=https://$domain pnpm chord:setup
  2. Paystack test webhook: https://$domain/paystack/webhook
     (Paystack → Settings → API Keys & Webhooks → Test Webhook URL)
EOF
