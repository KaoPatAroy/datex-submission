import type { Actor, Analysis, SourceRef, Transaction } from '../../contracts';
import type { RejectedPlan } from '../../dynamic/validate/query-plan';
import { modelTextSafe } from '../render/safety';

export interface ExecutorChoice { id: string; label: string }
export type PersistFn = (tx: Transaction, actor: Actor, conversationId: string) => Promise<void>;

export interface InterpretedScope {
  datasetId: string; dates: string[]; regions: string[]; branchIds: string[]; measures: string[];
}
export interface ExecutorAccepted {
  outcome: 'accepted'; kind: 'query' | 'hr_query'; text: string; sources: SourceRef[]; analysis: Analysis;
  interpretedScope: InterpretedScope;
  /** Writes the accepted state (CAS-checked) inside the turn transaction; follow-ups read it back. */
  persist: PersistFn;
}
/** Typed clarification: the choices come from server-authorized data, never from user text. */
export interface ExecutorClarify {
  outcome: 'clarify'; kind: 'query' | 'hr_query'; code: string; slot: string; text: string; choices: ExecutorChoice[];
  /** true when the question text was authored by the AI (and passed the safety hook). */
  aiAsked: boolean;
}
export interface ExecutorDenied { outcome: 'denied'; kind: 'query' | 'hr_query'; code: string; text: string }
export type ExecutorResult = ExecutorAccepted | ExecutorClarify | ExecutorDenied;

const CLARIFY_OUTCOMES = new Set<RejectedPlan['outcome']>(['clarification_required', 'semantic_uncertainty']);

/** Typed shape of a validator/reader rejection. Never inspects user language. */
export function classifyRejection(kind: 'query' | 'hr_query', result: RejectedPlan, text: string): ExecutorClarify | ExecutorDenied {
  const timeBound = !!result.dateAvailability || result.clarification?.slotId === 'time';
  if (CLARIFY_OUTCOMES.has(result.outcome) || timeBound) {
    return { outcome: 'clarify', kind, code: result.code, slot: result.clarification?.slotId ?? 'interpretation',
      text, choices: result.clarification?.choices.map(c => ({ id: c.id, label: c.label })) ?? [], aiAsked: false };
  }
  return { outcome: 'denied', kind, code: result.code, text };
}

/**
 * Output-safety check on AI-authored question text (model output only). The shared model-text gate (G6) always applies; the caller's hook
 * can only add checks, never replace it.
 */
export function isSafeQuestion(text: string | null | undefined, hook?: (text: string) => boolean): text is string {
  return typeof text === 'string' && text.trim().length > 0 && text.length <= 300 && modelTextSafe('clarify', text) && hook?.(text) !== false;
}
