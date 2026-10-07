import { describe, expect, it } from 'vitest';
import { actionRegistry } from '@/lib/router/action-registry';
import { canonicalizeModelPlan } from '@/lib/router/planner/canonicalize';
import { validateTurnPlan } from '@/lib/router/validate';
import { contextFor } from '../fixtures';

const canonical = (raw: unknown) => canonicalizeModelPlan(raw, { context: contextFor('executive'), registry: actionRegistry }) as { turnPlanVersion: number; steps: Record<string, unknown>[] };

describe('model-output canonicalization for the K2 shapes (model output only; never user text)', () => {
  it('dashboard.manage / monitor.manage operation tokens: trimmed, lower-cased, registered synonyms, generated provenance', () => {
    const plan = canonical({ steps: [{ kind: 'action', actionId: 'dashboard.manage', params: {
      dashboard: { value: 'D1', source: 'context_id' }, operation: { value: ' Unarchive ', source: 'user_quoted', evidenceText: 'เอากลับมา' } } }] });
    expect(plan.turnPlanVersion).toBe(1);
    expect((plan.steps[0]!.params as Record<string, unknown>).operation).toEqual({ value: 'restore', source: 'generated' });
    const copy = canonical({ turnPlanVersion: 1, steps: [{ kind: 'action', actionId: 'dashboard.manage', params: { dashboard: { value: 'D1', source: 'context_id' }, operation: { value: 'copy', source: 'generated' } } }] });
    expect((copy.steps[0]!.params as Record<string, unknown>).operation).toEqual({ value: 'duplicate', source: 'generated' });
    const rename = canonical({ turnPlanVersion: 1, steps: [{ kind: 'action', actionId: 'monitor.manage', params: { monitor: { value: 'M1', source: 'context_id' }, operation: { value: 'Rename', source: 'generated' } } }] });
    expect((rename.steps[0]!.params as Record<string, unknown>).operation).toEqual({ value: 'rename', source: 'generated' });
    // Other actions are untouched.
    const other = canonical({ turnPlanVersion: 1, steps: [{ kind: 'action', actionId: 'result.manage', params: { artifact: { value: 'A1', source: 'context_id' }, operation: { value: 'Pin', source: 'generated' } } }] });
    expect((other.steps[0]!.params as Record<string, unknown>).operation).toEqual({ value: 'Pin', source: 'generated' });
  });

  it('an unregistered operation is still refused by the validator (the enum decides)', () => {
    const result = validateTurnPlan({ raw: { steps: [{ kind: 'action', actionId: 'dashboard.manage', params: { dashboard: { value: 'D1', source: 'context_id' }, operation: { value: 'share', source: 'generated' } } }] },
      messages: { current: 'x' }, context: contextFor('executive'), registry: actionRegistry });
    expect(result.outcome).not.toBe('accepted');
  });

  it('omitted query defaults are filled exactly as the examples elide them (version, plan id, nulls, empty lists, default interpretation, completeness)', () => {
    const plan = canonical({ steps: [{ kind: 'query', plan: { datasetId: 'branch_performance', measures: [{ fieldId: 'net_sales', aggregation: 'sum' }],
      grain: ['branch', 'date'], aggregation: 'registered', confidence: 0.9 } }] });
    expect(plan.steps[0]).toMatchObject({ continuation: false, plan: {
      planVersion: 1, planId: 'planner', dimensions: [], filters: [], sort: [], clarificationNeeds: [], scope: null, time: null, multiDateGrain: null, compare: null, topN: null,
      group: { fieldIds: [] }, requestedUses: ['answer'], completeness: { expectation: 'requested_scope', requireFullPopulation: false, requiredSourceIds: [], minimumCoverage: 0 },
      measures: [{ fieldId: 'net_sales', aggregation: 'sum', interpretation: { value: 'net_sales', source: 'default', sourceText: null, confidence: 1 } }] } });
  });
});
