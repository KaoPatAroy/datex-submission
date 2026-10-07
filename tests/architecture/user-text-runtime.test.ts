import { describe, expect, it } from 'vitest';
import { actionRegistry } from '@/lib/router/action-registry';
import { renderClarify, renderConversation } from '@/lib/router/render/respond';
import { validateTurnPlan } from '@/lib/router/validate';
import { contextFor, MESSAGE, plan, queryStep, revokeStep, shareStep } from '../router/fixtures';
import { canaryViolations, installCanary, newCanary, parseFrames, withCanary } from './canary';
import { assertWordingInvariant } from './wording-variants';

const hooks = { isSafeText: (text: string) => text.length > 0 };
const clarify = { kind: 'clarify', about: { kind: 'action', actionId: 'dashboard.share' }, missing: [{ slot: 'params.recipientId', reason: 'ambiguous' }], question: 'จะส่งให้ใครครับ', choices: [{ id: 'U_SOMCHAI', label: 'x' }] };
const conversation = { kind: 'conversation', topic: 'greeting', prose: 'ยินดีครับ' };
const refine = { kind: 'refine', pendingActionId: 'PA1', operation: { op: 'cancel' } };
const artifact = { kind: 'artifact', sourceStateId: 'ST1', artifactTypeId: 'table', operation: 'create', baseArtifactId: null, title: { value: 'Sales table', source: 'generated' }, outputFormat: 'preview', visual: null };

const STEP_KINDS: Array<[string, unknown, 'executive' | 'hr_admin']> = [
  ['query', queryStep(true), 'executive'], ['action:share', shareStep(), 'executive'], ['action:revoke', revokeStep(), 'hr_admin'],
  ['refine', refine, 'executive'], ['artifact', artifact, 'executive'], ['clarify', clarify, 'executive'], ['conversation', conversation, 'executive'],
];

describe('runtime canary (user text is only span-located, never interpreted)', () => {
  it('records string/regex hits on the canary and parses frames (instrumentation positive control)', () => {
    const canary = newCanary();
    const { hits } = withCanary(canary, () => `${canary} X`.toLowerCase());
    expect(hits.map(h => h.method)).toEqual(['toLowerCase']);
    expect(parseFrames(hits[0].stack).length).toBeGreaterThan(0);
    expect(canaryViolations(hits)).toEqual([]); // tests/ frames are not guarded
  });

  it('restores prototypes after use', () => {
    const before = String.prototype.includes;
    const probe = installCanary(newCanary());
    expect(String.prototype.includes).not.toBe(before);
    probe.restore();
    expect(String.prototype.includes).toBe(before);
  });

  it.each(STEP_KINDS)('routing a %s step never interprets the message', (_name, step, role) => {
    const canary = newCanary();
    const message = `${MESSAGE} ${canary}`;
    const context = contextFor(role);
    const { result: validation, hits } = withCanary(canary, () => {
      const out = validateTurnPlan({ raw: plan(step), messages: { current: message }, context, registry: actionRegistry, hooks });
      if (out.outcome === 'accepted') for (const g of out.steps) {
        if (g.step.kind === 'clarify') renderClarify(g, context);
        if (g.step.kind === 'conversation') renderConversation(g, context);
      }
      return out;
    });
    expect(validation.outcome).toBe('accepted');
    const violations = canaryViolations(hits);
    expect(violations.map(v => `${v.method}\n${v.stack}`), 'string method touched user text outside the span resolver').toEqual([]);
  });

  it('only the evidence-span resolver touches the message for user_quoted params', () => {
    const canary = newCanary();
    const { hits } = withCanary(canary, () => validateTurnPlan({
      raw: plan(shareStep()), messages: { current: `${MESSAGE} ${canary}` }, context: contextFor(), registry: actionRegistry,
    }));
    expect(hits.length).toBeGreaterThan(0); // the resolver does read it...
    expect(canaryViolations(hits)).toEqual([]); // ...and nothing else does
  });

  it('flags a gate that is not allowlisted (negative control for the stack check)', () => {
    const canary = newCanary();
    const fake = { method: 'test', stack: `Error\n    at keywordGate (C:\\repo\\lib\\core\\intents.ts:10:5)\n    at run (C:\\repo\\tests\\x.test.ts:1:1)` };
    expect(canaryViolations([fake])).toHaveLength(1);
    const ok = { method: 'indexOf', stack: `Error\n    at indexOf (<anonymous>)\n    at findAt (C:\\repo\\lib\\dynamic\\plan\\normalize.ts:40:3)\n    at resolveSpan (C:\\repo\\lib\\dynamic\\plan\\normalize.ts:60:3)` };
    expect(canaryViolations([ok])).toEqual([]);
    expect(canary).toContain('cnry-');
  });
});

describe('wording-variant invariance (same TurnPlan, different surrounding wording, identical outcome)', () => {
  const base = MESSAGE; // contains Somchai, badge B1, lost badge
  it.each(STEP_KINDS)('%s', (_name, step, role) => {
    const signature = assertWordingInvariant({ raw: plan(step), base, context: contextFor(role), hooks });
    expect(signature).toContain('"outcome":"accepted"');
  });

  it('two-step plan', () => {
    assertWordingInvariant({ raw: plan(queryStep(true), shareStep()), base, context: contextFor(), hooks });
  });

  it('a clarify outcome is identical across variants too (not only acceptance)', () => {
    const missingSpan = plan(shareStep({ recipientId: { value: 'U_SOMCHAI', source: 'user_quoted', evidenceText: 'not in any variant' } }));
    const signature = assertWordingInvariant({ raw: missingSpan, base, context: contextFor(), hooks });
    expect(signature).toContain('evidence_not_found');
  });

  it('the harness detects an outcome that depends on wording', () => {
    // Evidence only present in one variant => outcomes diverge => the harness must fail.
    const raw = plan(shareStep());
    expect(() => assertWordingInvariant({
      raw, base: MESSAGE, context: contextFor(), hooks,
      noise: [{ before: '', after: '' }, { before: 'Somchai', after: '' }],
    })).not.toThrow(); // both contain the span: identical
    expect(() => assertWordingInvariant({
      raw: plan(shareStep({ recipientId: { value: 'U_SOMCHAI', source: 'user_quoted', evidenceText: 'NOISEWORD' } })), base: MESSAGE, context: contextFor(), hooks,
      noise: [{ before: '', after: '' }, { before: 'NOISEWORD ', after: '' }],
    })).toThrow();
  });
});
