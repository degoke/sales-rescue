import { createHash, timingSafeEqual } from 'node:crypto';

/** Constant-time comparison for bearer tokens and API keys (hash first so lengths always match). */
export function safeEqual(a: string | undefined | null, b: string | undefined | null) {
  if (!a || !b) return false;
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Customer-typed names flow back into tool results the OWNER's session reads (get_demand_summary),
 * where the owner PIN is present. Keep them short, single-line and free of control characters so a
 * name can't smuggle instructions into that context.
 */
export function cleanDisplayName(name: string | undefined | null) {
  return cleanText(name, 40);
}

/** Single-line, control-character-free, bracket-free text capped at `max` characters. */
export function cleanText(text: string | undefined | null, max: number) {
  if (!text) return undefined;
  const cleaned = text
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/[<>{}[\]`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
  return cleaned || undefined;
}

/** Outbound HTTP calls must not hang a tool call (Chord waits on our reply). */
export const OUTBOUND_TIMEOUT_MS = 10_000;
