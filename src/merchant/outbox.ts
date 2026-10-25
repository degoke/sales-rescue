import type { Db } from '../db/client.js';
import { nextRef } from '../db/client.js';

/** Written in the same transaction as the change it describes; the worker reacts later. */
export async function emit(db: Db, type: string, payload: Record<string, unknown>) {
  await db`insert into events (type, payload) values (${type}, ${db.json(payload as any)})`;
}

export type NotificationInput = {
  recipient_type: 'customer' | 'owner';
  recipient_ref: string;
  reason: string;
  body: string;
  dedupe_key: string;
};

/**
 * Queue a message. The body gets a trailing "(ref NTF-…)" so the agent can look the message up
 * later; the agent can't see its own earlier tool calls, only message text.
 */
export async function queueNotification(db: Db, n: NotificationInput) {
  const id = await nextRef(db, 'NTF');
  const [row] = await db`
    insert into notifications (id, recipient_type, recipient_ref, reason, body, dedupe_key, status)
    values (${id}, ${n.recipient_type}, ${n.recipient_ref}, ${n.reason}, ${`${n.body}\n\n(ref ${id})`}, ${n.dedupe_key}, 'QUEUED')
    on conflict (dedupe_key) do nothing
    returning id`;
  return row?.id as string | undefined;
}
