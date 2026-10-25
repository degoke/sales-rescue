import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Deps } from '../deps.js';
import { fail } from '../lib/errors.js';
import { minutesFrom } from '../lib/time.js';

const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;
const SESSION_MINUTES = 120;

export function hashPin(pin: string) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scryptSync(pin, salt, 32).toString('hex')}`;
}

function pinMatches(pin: string, stored: string) {
  const [, salt, hash] = stored.split('$');
  const candidate = scryptSync(pin, salt, 32);
  return timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}

/**
 * OWNER_PIN in the environment is the source of truth. The seed stores its hash only once, so at each
 * startup a changed PIN replaces the stored hash (and clears any lock-out).
 */
export async function syncOwnerPin(sql: Deps['sql'], pin: string) {
  const [m] = await sql<{ owner_pin_hash: string }[]>`select owner_pin_hash from merchant where id = 1`;
  if (!m || pinMatches(pin, m.owner_pin_hash)) return false;
  await sql`update merchant set owner_pin_hash = ${hashPin(pin)}, pin_failures = 0, pin_locked_until = null where id = 1`;
  return true;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Chord sends the MCP server no sender identity, so the owner proves who they are
 * with a PIN, exchanged once per conversation for a short-lived token. `sender_id` is only used to
 * route reminders to the owner's conversation, never to authorize anything.
 */
async function checkPin(deps: Deps, pin: string) {
  const now = deps.now();
  const [m] = await deps.sql`select * from merchant where id = 1`;
  if (m.pin_locked_until && new Date(m.pin_locked_until) > now) {
    fail('owner_locked', 'Too many wrong PINs. Owner tools are locked for a few minutes.');
  }
  if (!pinMatches(String(pin ?? '').trim(), m.owner_pin_hash)) {
    // Atomic increment, so parallel guesses can't all read the same counter value.
    const [{ pin_failures: failures }] =
      await deps.sql`update merchant set pin_failures = pin_failures + 1 where id = 1 returning pin_failures`;
    if (failures >= MAX_FAILURES) {
      await deps.sql`update merchant set pin_failures = 0, pin_locked_until = ${minutesFrom(now, LOCK_MINUTES)} where id = 1`;
    }
    fail('invalid_pin', 'That PIN is not correct.', { attempts_left: Math.max(0, MAX_FAILURES - failures) });
  }
  await deps.sql`update merchant set pin_failures = 0, pin_locked_until = null where id = 1`;
  return m;
}

export async function verifyOwner(deps: Deps, input: { pin: string; sender_id?: string }) {
  const now = deps.now();
  const m = await checkPin(deps, input.pin);
  const token = randomBytes(24).toString('hex');
  const expires = minutesFrom(now, SESSION_MINUTES);
  await deps.sql`insert into owner_sessions (token_hash, sender_id, expires_at) values (${sha256(token)}, ${input.sender_id ?? null}, ${expires})`;
  await deps.sql`update merchant set owner_sender_id = coalesce(${input.sender_id ?? null}, owner_sender_id) where id = 1`;
  return { owner_token: token, expires_at: expires.toISOString(), owner_name: m.owner_name };
}

/**
 * Owner tools accept a session token or the PIN itself. The PIN path exists because the agent
 * can't see tool results from earlier turns: a token returned in turn 1 is gone
 * by turn 2, but the owner's own message with the PIN stays in the conversation history.
 * The PIN path shares the failure counter and lock-out with verify_owner.
 */
export async function requireOwner(deps: Deps, token: string | undefined, pin?: string) {
  if (token) {
    const [s] = await deps.sql`select * from owner_sessions where token_hash = ${sha256(token)} and expires_at > ${deps.now()}`;
    if (s) return { via: 'token' as const };
  }
  if (pin) {
    await checkPin(deps, pin);
    return { via: 'pin' as const };
  }
  fail('owner_auth_required', 'This needs the shop owner. Ask for the owner PIN and pass it as `pin` (or call verify_owner first).');
}
