// Validates the named environment variables with the same rules the service applies at startup.
//   tsx scripts/check-env.ts MCP_TOKEN OWNER_PIN …
import { type EnvKey, envSchema, loadEnv } from '../src/config.js';

const names = process.argv.slice(2);
const unknown = names.filter((n) => !(n in envSchema));
if (unknown.length) {
  console.error(`Unknown variables: ${unknown.join(', ')}`);
  process.exit(1);
}
try {
  loadEnv(names as EnvKey[]);
  console.log(`  ✓ ${names.length} variables valid`);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
