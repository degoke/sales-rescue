// Railway infrastructure as code for Sales Rescue. Applied with your Railway CLI:
//   railway config plan     preview changes
//   railway config apply    create/update Postgres, the app service and its variables
// `pnpm deploy:railway` (scripts/deploy-railway.sh) runs apply, sets the secrets, creates the
// domain and deploys the code. See docs/DEPLOY.md.
import { defineRailway, postgres, preserve, project, service } from 'railway/iac';

const PORT = '8787';

export default defineRailway(() => {
  const db = postgres('postgres');

  const app = service('sales-rescue', {
    build: {
      builder: 'DOCKERFILE',
      dockerfilePath: 'Dockerfile',
      watchPatterns: ['src/**', 'fixtures/**', 'package.json', 'pnpm-lock.yaml', 'Dockerfile'],
    },
    deploy: {
      numReplicas: 1, // the background worker must not run twice
      healthcheckPath: '/healthz',
      healthcheckTimeout: 60,
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 10,
    },
    env: {
      // Every variable src/config.ts requires. Non-secret values live here.
      PORT,
      DATABASE_URL: db.env.DATABASE_URL,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Railway reference syntax, resolved by Railway at runtime
      PUBLIC_BASE_URL: 'https://${{RAILWAY_PUBLIC_DOMAIN}}',
      WORKER_INTERVAL_MS: '15000',
      LOGISTICS_BASE_URL: `http://127.0.0.1:${PORT}/logistics`,
      PAYSTACK_BASE_URL: 'https://api.paystack.co',
      CHORD_BASE_URL: 'https://api.chordhq.xyz',
      // Secrets are set from your local .env by scripts/deploy-railway.sh and never stored in the
      // repo; preserve() keeps the value already in Railway on every apply.
      MCP_TOKEN: preserve(),
      OWNER_PIN: preserve(),
      LOGISTICS_API_KEY: preserve(),
      PAYSTACK_SECRET_KEY: preserve(),
      CHORD_API_KEY: preserve(),
      CHORD_WORKSPACE_ID: preserve(),
      CHORD_TEAMMATE_ID: preserve(),
    },
  });

  return project('sales-rescue', { resources: [db, app] });
});
