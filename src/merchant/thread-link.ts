// Links a WhatsApp-simulator customer to their Chord thread (FIELD-NOTES problem 3).
//
// In the simulator, the model sees a pseudonym (`customer_…`) while the thread stores a different
// participant id (`partner_…`), and nothing links the two. But while a tool call runs, the caller's
// thread is waiting for the agent's reply: its last turn is the inbound message from seconds ago. So
// at a tool call we link the pseudonym to that thread, and only when exactly one unlinked simulator
// thread is waiting. With two or more, we link nothing and the customer gets the news when they next
// write (get_my_updates). Real channels, where the ids match, never use this path.
import type { Deps } from '../deps.js';

const WAITING_WITHIN_MS = 90_000;
const isPseudonym = (ref: string) => ref.startsWith('customer_');

/** Simulator threads waiting for a reply that no other customer (or the owner) is linked to. */
async function freeWaitingThreads(deps: Deps, ref: string) {
  const waiting = (await deps.chord!.threadsAwaitingReply(WAITING_WITHIN_MS)).filter((t) => t.participant.startsWith('partner_'));
  if (waiting.length === 0) return [];
  const taken = new Set<string>();
  for (const r of await deps.sql`select chord_thread_id from customers where chord_thread_id is not null and ref <> ${ref}`)
    taken.add(r.chord_thread_id);
  const [m] = await deps.sql`select owner_chord_thread_id, owner_sender_id from merchant where id = 1`;
  if (m?.owner_chord_thread_id && m.owner_sender_id !== ref) taken.add(m.owner_chord_thread_id);
  return waiting.filter((t) => !taken.has(t.id));
}

/** Call at a customer tool call. Returns the linked thread (isNew: linked by this call), or null when it is not safe to link. */
export async function linkCustomerThread(deps: Deps, ref: string | undefined) {
  if (!deps.chord || !ref || !isPseudonym(ref)) return null;
  const [c] = await deps.sql`select chord_thread_id from customers where ref = ${ref}`;
  if (c?.chord_thread_id) return { thread: c.chord_thread_id as string, isNew: false };
  const free = await freeWaitingThreads(deps, ref);
  if (free.length !== 1) return null;
  await deps.sql`insert into customers (ref, chord_thread_id) values (${ref}, ${free[0].id})
                 on conflict (ref) do update set chord_thread_id = excluded.chord_thread_id where customers.chord_thread_id is null`;
  return { thread: free[0].id, isNew: true };
}

/** Call when the owner verifies with their sender id. Links (or re-links) the owner's thread. */
export async function linkOwnerThread(deps: Deps, senderId: string | undefined) {
  if (!deps.chord || !senderId || !isPseudonym(senderId)) return null;
  const free = await freeWaitingThreads(deps, senderId);
  if (free.length !== 1) return null;
  await deps.sql`update merchant set owner_chord_thread_id = ${free[0].id} where id = 1`;
  return { thread: free[0].id, isNew: true };
}
