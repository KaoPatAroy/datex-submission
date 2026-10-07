import 'server-only';

import type { ZodTypeAny } from 'zod';
import { preparePlannerSpans } from '../../dynamic/plan/normalize';
import { actionRegistry } from '../action-registry';
import type { PlannerContext } from '../planner-context';
import { turnPlanSchema, type TurnPlan } from '../turn-plan';
import { canonicalizeModelPlan } from './canonicalize';
import { normalizeModelPlanThai } from '../thai-orthography';

export type TurnPlanParseResult =
  | { success: true; plan: TurnPlan }
  | { success: false; code: 'malformed_model_json' | 'invalid_model_plan'; issuePaths: string[] };

function extractSingleObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const source = fenced?.[1] ?? trimmed;
  const candidates: string[] = [];
  let start = -1, depth = 0, inString = false, escaped = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === '{') {
      if (depth === 0) start = index;
      depth++;
    } else if (char === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        candidates.push(source.slice(start, index + 1));
        start = -1;
      }
    }
  }
  if (depth !== 0 || candidates.length !== 1) throw new Error('malformed_model_json');
  return JSON.parse(candidates[0]!);
}

/** Extract one JSON object, repair Thai mark order in MODEL strings (never the copied user-text spans), canonicalize the model's output shape, materialize only server-owned span offsets, then validate the TurnPlan. */
export function parseTurnPlan(output: unknown, validator: ZodTypeAny = turnPlanSchema, context?: PlannerContext): TurnPlanParseResult {
  let candidate: unknown;
  try {
    candidate = typeof output === 'string' ? extractSingleObject(output) : output;
  } catch {
    return { success: false, code: 'malformed_model_json', issuePaths: ['(root):malformed_json'] };
  }
  const prepared = preparePlannerSpans(canonicalizeModelPlan(normalizeModelPlanThai(candidate), { context, registry: actionRegistry }), true);
  const parsed = validator.safeParse(prepared);
  if (!parsed.success) {
    return {
      success: false,
      code: 'invalid_model_plan',
      issuePaths: parsed.error.issues.map(issue => `${issue.path.length ? issue.path.map(String).join('.') : '(root)'}:${issue.code}`),
    };
  }
  return { success: true, plan: parsed.data as TurnPlan };
}
