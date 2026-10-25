import type { Db } from '../db/client.js';
import { fail } from '../lib/errors.js';
import { cleanDisplayName } from '../lib/security.js';

export async function upsertCustomer(db: Db, input: { ref: string; display_name?: string; email?: string; consent?: boolean }) {
  const ref = input.ref?.trim();
  if (ref && ref.length > 128) fail('customer_ref_invalid', 'customer_ref is too long.');
  if (!ref) fail('customer_ref_required', 'customer_ref is required: use the sender id of the person you are talking to.');
  const [c] = await db`
    insert into customers (ref, display_name, email, notify_consent)
    values (${ref}, ${cleanDisplayName(input.display_name) ?? null}, ${input.email ?? null}, ${input.consent ?? false})
    on conflict (ref) do update set
      display_name   = coalesce(excluded.display_name, customers.display_name),
      email          = coalesce(excluded.email, customers.email),
      notify_consent = customers.notify_consent or excluded.notify_consent,
      opted_out_at   = case when excluded.notify_consent then null else customers.opted_out_at end
    returning *`;
  return c;
}
