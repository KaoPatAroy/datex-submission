import { expect } from 'vitest';
import { actionRegistry } from '@/lib/router/action-registry';
import type { PlannerContext } from '@/lib/router/planner-context';
import { renderClarify, renderConversation } from '@/lib/router/render/respond';
import { validateTurnPlan, type ValidationHooks } from '@/lib/router/validate';

/** Wording noise that must never change an outcome: negations, other regions/branches, punctuation, language swaps. */
export const ADVERSARIAL_NOISE: readonly { before: string; after: string }[] = [
  { before: '', after: '' },
  { before: 'ห้าม ', after: ' ?' },
  { before: "don't cancel, actually ", after: ' - please do not stop' },
  { before: 'ภาคเหนือ BR02 ', after: ' ยกเลิกทั้งหมด' },
  { before: 'ช่วยหน่อยครับ\n', after: '\nthanks / ขอบคุณ' },
];

export interface WordingCase {
  /** The raw planner output (a TurnPlan). Same for every variant. */
  raw: unknown;
  /** Base message that contains every evidence span of the plan. */
  base: string;
  context: PlannerContext;
  hooks?: ValidationHooks;
  noise?: readonly { before: string; after: string }[];
}

/** Everything observable about a turn's outcome, minus span offsets (they legitimately move with surrounding wording). */
export function outcomeSignature(raw: unknown, message: string, context: PlannerContext, hooks?: ValidationHooks): string {
  const result = validateTurnPlan({ raw, messages: { current: message }, context, registry: actionRegistry, hooks });
  const rendered = result.outcome !== 'accepted' ? null : result.steps.map(step => {
    if (step.step.kind === 'clarify') return renderClarify(step, context);
    if (step.step.kind === 'conversation') return renderConversation(step, context);
    return null;
  });
  // Evidence spans (offsets + located text) legitimately depend on the surrounding wording; everything else must not.
  return JSON.stringify({ result, rendered }, (key, value) => key === 'span' ? undefined : value);
}

/** Same TurnPlan + different surrounding wording => byte-identical outcome. Returns the shared signature. */
export function assertWordingInvariant(testCase: WordingCase): string {
  const variants = (testCase.noise ?? ADVERSARIAL_NOISE).map(n => `${n.before}${testCase.base}${n.after}`);
  expect(new Set(variants).size, 'variants must differ').toBe(variants.length);
  const signatures = variants.map(message => outcomeSignature(testCase.raw, message, testCase.context, testCase.hooks));
  signatures.forEach((signature, i) => expect(signature, `variant ${i}: ${JSON.stringify(variants[i])}`).toBe(signatures[0]));
  return signatures[0];
}
