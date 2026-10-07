import { hasActionClaim, hasNumberWord, hasVagueQuantity, isUngroundedSafeProse } from '../../dynamic/response/conversational';
import { hasMalformedThai } from '../thai-orthography';

/**
 * Claim-gate fallback accounting: every time MODEL text (conversation prose, clarify question, follow-up chip, title) is
 * replaced by server copy, one bounded log line with a reason code and a running count per surface+reason. The line never
 * carries the text itself (no prompt, prose or user text), only codes and counters.
 */
export type GateSurface = import('./safety').ModelTextSurface;
export type GateReason = 'empty' | 'malformed_thai' | 'too_long' | 'number' | 'vague_quantity' | 'action_claim' | 'entity_label' | 'other';

const MAX_KEYS = 64;
const counts = new Map<string, number>();

/** Which gate rejected the MODEL text (first failing check, same order as the gate). Never applied to user text. */
export function gateReason(text: string | null | undefined, entityLabels: readonly string[] = [], maxChars = 600): GateReason {
  const value = (text ?? '').trim();
  if (!value) return 'empty';
  if (hasMalformedThai(value)) return 'malformed_thai';
  if (value.length > maxChars) return 'too_long';
  if (/\p{N}/u.test(value) || hasNumberWord(value)) return 'number';
  if (hasVagueQuantity(value)) return 'vague_quantity';
  if (hasActionClaim(value)) return 'action_claim';
  if (!isUngroundedSafeProse(value, entityLabels)) return 'entity_label';
  return 'other';
}

/** Records one fallback and logs it (codes and counts only). Returns the running count for this surface+reason. */
export function recordGateFallback(surface: GateSurface, reason: GateReason, detail?: { topic?: string; dropped?: number }): number {
  const key = `${surface}:${reason}`;
  if (!counts.has(key) && counts.size >= MAX_KEYS) return 0;
  const count = (counts.get(key) ?? 0) + 1;
  counts.set(key, count);
  console.info('BIZTANIA_CLAIM_GATE', JSON.stringify({ surface, reason, count,
    ...(detail?.topic && /^[a-z_]{1,40}$/u.test(detail.topic) ? { topic: detail.topic } : {}),
    ...(detail?.dropped ? { dropped: Math.min(detail.dropped, 99) } : {}) }));
  return count;
}

/** Test/diagnostic view of the counters. */
export function gateFallbackCounts(): Record<string, number> { return Object.fromEntries(counts); }
export function resetGateFallbackCounts(): void { counts.clear(); }
