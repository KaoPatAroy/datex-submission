import { AIRuntimeError } from '../../ai/errors';

/**
 * Bounded planner diagnostics: validator reject codes as `path:code` with every path segment reduced to a safe identifier
 * (array indices and schema keys only; anything else — e.g. a model-invented record key — becomes `*`). Never prompt text,
 * model prose or user text.
 */
export const REJECT_CODES_MAX = 8;
const SEGMENT = /^[A-Za-z0-9_$()]{1,40}$/u;
const CODE = /^[a-z_]{1,40}$/u;

export function safeRejectCodes(issuePaths: readonly string[]): string[] {
  const out: string[] = [];
  for (const issue of issuePaths) {
    const at = issue.lastIndexOf(':');
    const path = at < 0 ? issue : issue.slice(0, at), code = at < 0 ? 'unknown' : issue.slice(at + 1);
    const segments = path.split('.').slice(0, 8).map(segment => SEGMENT.test(segment) ? segment : '*');
    const entry = `${segments.join('.')}:${CODE.test(code) ? code : 'unknown'}`;
    if (!out.includes(entry)) out.push(entry);
    if (out.length >= REJECT_CODES_MAX) break;
  }
  return out;
}

export type PlannerFailureCode = 'truncated' | 'malformed_model_json' | 'invalid_model_plan' | 'deadline_exceeded' | 'step_limit' | 'provider_error' | 'aborted';

/** Failure class of one planner request (codes only). */
export function plannerFailureCode(error: unknown): PlannerFailureCode {
  if (error instanceof AIRuntimeError) {
    if (error.finishReason === 'length') return 'truncated';
    if (error.code === 'deadline_exceeded') return 'deadline_exceeded';
    if (error.diagnosticReason === 'model_step_limit') return 'step_limit';
    if (error.code === 'invalid_model_response') return 'invalid_model_plan';
  }
  if (error instanceof Error && error.name === 'AbortError') return 'aborted';
  return 'provider_error';
}

/** A response cut off at max_tokens (the gateway sometimes loops on Thai prose until the cap): retry with a compact-output instruction. */
export function isTruncation(error: unknown): boolean {
  return error instanceof AIRuntimeError && error.finishReason === 'length';
}

export const TRUNCATION_REPAIR_PROMPT = 'The previous response was cut off before the JSON ended (it was too long or repeated itself). '
  + 'Return only one compact JSON TurnPlan for the same request. Keep prose, question and title to one short sentence each and never repeat text.';
