// Wipes the database and reloads the seed in fixtures/. Usage: pnpm db:reset
import { loadEnv } from '../src/config.js';
import { createDb, resetSchema } from '../src/db/client.js';
import { seed } from '../src/db/seed.js';

const env = loadEnv(['DATABASE_URL', 'OWNER_PIN']);
const sql = createDb(env.DATABASE_URL);
await resetSchema(sql);
await seed(sql, { ownerPin: env.OWNER_PIN });
const [{ n }] = await sql`select count(*)::int as n from products`;
const [{ w }] = await sql`select count(*)::int as w from opportunities`;
console.log(`database reset: ${n} products, ${w} customers already waiting`);
await sql.end();
