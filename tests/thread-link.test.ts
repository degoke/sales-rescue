// Simulator customers have a pseudonym (customer_…) that matches no thread participant (partner_…).
// The backend links them to the thread that is waiting for a reply while their tool call runs.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PIN, REAL_FIXTURES, setup, type TestEnv } from './helpers.js';
import { linkCustomerThread, linkOwnerThread } from '../src/merchant/thread-link.js';
import { registerInterest } from '../src/merchant/opportunities.js';
import { updateInventory } from '../src/merchant/inventory.js';
import { verifyOwner } from '../src/merchant/owner.js';
import { runWorkerOnce } from '../src/events/worker.js';

const ADA = 'customer_AdaPseudonym0000000000000000000000000';
const BAYO = 'customer_BayoPseudonym000000000000000000000000';
let env: TestEnv;
afterEach(async () => env?.close());
beforeEach(async () => {
  env = await setup({ chord: true, fixturesDir: REAL_FIXTURES });
});

const waiting = (...threads: { id: string; participant: string }[]) => {
  env.chord!.waiting.length = 0;
  env.chord!.waiting.push(...threads);
};

describe('linking a simulator customer to their thread', () => {
  it('links to the one simulator thread waiting for a reply, and the restock offer goes into it', async () => {
    waiting({ id: 'thread-ada', participant: 'partner_ada' });
    await registerInterest(env.deps, { customer_ref: ADA, sku: 'FB-BANANA-MINI', consent: true });
    expect(await linkCustomerThread(env.deps, ADA)).toEqual({ thread: 'thread-ada', isNew: true });

    waiting(); // later, nobody is mid-turn
    await updateInventory(env.deps, { pin: PIN, sku: 'FB-BANANA-MINI', op: 'increment', value: 3 });
    await runWorkerOnce(env.deps);
    await runWorkerOnce(env.deps);
    const toAda = env.chord!.scheduled.filter((s) => s.conversationId === 'thread-ada');
    expect(toAda.length).toBe(1);
    expect(toAda[0].body).toMatch(/back in stock|set one aside|held/i);
  });

  it('links nothing when two simulator threads are waiting at the same moment', async () => {
    waiting({ id: 'thread-1', participant: 'partner_a' }, { id: 'thread-2', participant: 'partner_b' });
    expect(await linkCustomerThread(env.deps, ADA)).toBeNull();
  });

  it('never reuses a thread that another customer is linked to', async () => {
    waiting({ id: 'thread-ada', participant: 'partner_ada' });
    await linkCustomerThread(env.deps, ADA);
    waiting({ id: 'thread-ada', participant: 'partner_ada' }, { id: 'thread-bayo', participant: 'partner_bayo' });
    expect(await linkCustomerThread(env.deps, BAYO)).toEqual({ thread: 'thread-bayo', isNew: true });
  });

  it('keeps a link once made', async () => {
    waiting({ id: 'thread-ada', participant: 'partner_ada' });
    await linkCustomerThread(env.deps, ADA);
    waiting({ id: 'thread-other', participant: 'partner_other' });
    expect(await linkCustomerThread(env.deps, ADA)).toEqual({ thread: 'thread-ada', isNew: false });
  });

  it('leaves real channels alone: phone numbers and non-simulator threads are not linked this way', async () => {
    waiting({ id: 'thread-x', participant: 'partner_x' });
    expect(await linkCustomerThread(env.deps, '+2348000000001')).toBeNull();
    waiting({ id: 'thread-wa', participant: '+2348000000009' });
    expect(await linkCustomerThread(env.deps, ADA)).toBeNull();
  });

  it("links the owner's thread when she verifies, and a customer is never linked to it", async () => {
    const FAVOUR = 'customer_FavourPseudonym0000000000000000000000';
    waiting({ id: 'thread-favour', participant: 'partner_favour' });
    await verifyOwner(env.deps, { pin: PIN, sender_id: FAVOUR });
    expect(await linkOwnerThread(env.deps, FAVOUR)).toEqual({ thread: 'thread-favour', isNew: true });
    const [m] = await env.sql`select owner_chord_thread_id from merchant where id = 1`;
    expect(m.owner_chord_thread_id).toBe('thread-favour');

    waiting({ id: 'thread-favour', participant: 'partner_favour' });
    expect(await linkCustomerThread(env.deps, ADA)).toBeNull();
  });
});
