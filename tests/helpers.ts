import { config as loadDotenv } from 'dotenv';

loadDotenv({ quiet: true });
import { createDb, resetSchema, type Sql } from '../src/db/client.js';
import { seed } from '../src/db/seed.js';
import type { Deps } from '../src/deps.js';
import { createLogisticsApp } from '../src/logistics/routes.js';
import { createLogisticsClient } from '../src/logistics/client.js';
import type { PaystackClient, PaystackTransaction } from '../src/payments/paystack.js';
import type { ChordClient } from '../src/chord/client.js';
import { verifyOwner } from '../src/merchant/owner.js';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is not set (see .env.example)');
export const TEST_DB = process.env.TEST_DATABASE_URL;
export const PIN = '482913';

/** Paystack stand-in: a transaction exists as "abandoned" from initialize until the test pays it. */
export function fakePaystack() {
  const txs = new Map<string, PaystackTransaction>();
  let initCalls = 0;
  const client: PaystackClient = {
    async initialize({ amount_kobo, reference, order_ref }) {
      initCalls++;
      txs.set(reference, { status: 'abandoned', reference, amount: Number(amount_kobo), currency: 'NGN', metadata: { order_ref } });
      return { authorization_url: `https://checkout.paystack.test/${reference}`, reference };
    },
    async verify(reference) {
      return txs.get(reference) ? { ...txs.get(reference)! } : null;
    },
  };
  return {
    client,
    pay: (ref: string, patch: Partial<PaystackTransaction> = {}) =>
      Object.assign(txs.get(ref)!, { status: 'success', gateway_response: 'Successful', ...patch }),
    set: (ref: string, patch: Partial<PaystackTransaction>) => Object.assign(txs.get(ref)!, patch),
    get initCalls() {
      return initCalls;
    },
  };
}

export function fakeChord() {
  const scheduled: { taskId: string; conversationId: string; body: string; at: Date }[] = [];
  const cancelled: string[] = [];
  let n = 0;
  const client: ChordClient = {
    async scheduleMessage(input) {
      const taskId = `task_${++n}`;
      scheduled.push({ taskId, ...input });
      return { taskId };
    },
    async getTask() {
      return { status: 'COMPLETED', last_error: null };
    },
    async cancelTask(id) {
      cancelled.push(id);
    },
    async findThread(participant) {
      return `thread-${participant}`;
    },
  };
  return { client, scheduled, cancelled };
}

export type TestEnv = Awaited<ReturnType<typeof setup>>;

// Generic-mechanics tests use a small bag catalogue (tests/fixtures); made-to-order tests use the
// real Flavorburst catalogue (fixtures/).
export const TEST_FIXTURES = new URL('./fixtures', import.meta.url).pathname;
export const REAL_FIXTURES = new URL('../fixtures', import.meta.url).pathname;

export async function setup(opts: { chord?: boolean; fixturesDir?: string } = {}) {
  const sql: Sql = createDb(TEST_DB);
  await resetSchema(sql);
  let t = new Date();
  await seed(sql, { ownerPin: PIN, now: t, fixturesDir: opts.fixturesDir ?? TEST_FIXTURES });
  const logisticsApp = createLogisticsApp(sql, 'test-key', () => t);
  const logistics = createLogisticsClient({
    baseUrl: 'http://logistics.test',
    apiKey: 'test-key',
    fetch: (url, init) => Promise.resolve(logisticsApp.request(url.replace('http://logistics.test', ''), init)),
  });
  const paystack = fakePaystack();
  const chord = opts.chord ? fakeChord() : null;
  const deps: Deps = {
    sql,
    now: () => t,
    logistics,
    paystack: paystack.client,
    chord: chord?.client ?? null,
    publicBaseUrl: 'https://example.test',
  };
  return {
    sql,
    deps,
    paystack,
    chord,
    logisticsApp,
    advance: (minutes: number) => {
      t = new Date(t.getTime() + minutes * 60_000);
    },
    ownerToken: async () => (await verifyOwner(deps, { pin: PIN, sender_id: '+2348000000099' })).owner_token,
    close: () => sql.end(),
  };
}

export async function expectDomainError(p: Promise<unknown>, code: string) {
  try {
    await p;
  } catch (e: any) {
    if (e?.code === code) return e;
    throw new Error(`expected DomainError ${code}, got ${e?.code ?? e}`);
  }
  throw new Error(`expected DomainError ${code}, but it resolved`);
}
