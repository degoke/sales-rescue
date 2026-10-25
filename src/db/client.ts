import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;
/** Anything that can run a query: the pool or an open transaction. */
export type Db = Sql | Tx;

export function createDb(url: string): Sql {
  return postgres(url, {
    max: 10,
    onnotice: () => {},
    types: { bigint: postgres.BigInt },
    transform: { undefined: null },
  });
}

const schemaPath = fileURLToPath(new URL('./schema.sql', import.meta.url));

export async function migrate(sql: Sql) {
  await sql.unsafe(readFileSync(schemaPath, 'utf8'));
}

/** Drops everything and recreates the schema. Used by tests and `pnpm db:reset`. */
export async function resetSchema(sql: Sql) {
  await sql.unsafe('drop schema public cascade; create schema public;');
  await migrate(sql);
}

export async function nextRef(db: Db, prefix: string): Promise<string> {
  const [{ n }] = await db<{ n: string }[]>`select nextval('ref_seq')::text as n`;
  return `${prefix}-${n}`;
}
