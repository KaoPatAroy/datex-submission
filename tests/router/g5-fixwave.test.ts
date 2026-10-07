/** G5 live-eval fix wave: model-output canonicalization, Dashboard target labels and registry semantics (model output only, never user text). */
import { describe, expect, it } from 'vitest';
import { canonicalizeModelPlan } from '@/lib/router/planner/canonicalize';
import { actionRegistry } from '@/lib/router/action-registry';
import { dashboardChoiceLabels, isDashboardTargetSlot, sameTitleDashboards } from '@/lib/router/dashboard-target';
import type { PlannerContext } from '@/lib/router/planner-context';

const query = { kind: 'query', continuation: false, plan: { datasetId: 'branch_performance', measures: [{ fieldId: 'net_sales', aggregation: 'sum' }] } };
const clarify = { kind: 'clarify', about: { kind: 'action', actionId: 'monitor.create' }, missing: [{ slot: 'params.recipientIds', reason: 'absent' }], question: 'ส่งถึงใครครับ', choices: [] };
const steps = (plan: unknown) => (plan as { steps: Record<string, unknown>[] }).steps;

describe('G5 model-output canonicalization', () => {
  it('[query, clarify] (v6 monitor shape, an illegal envelope) keeps the clarify alone; other envelopes are untouched', () => {
    expect(steps(canonicalizeModelPlan({ turnPlanVersion: 1, steps: [query, clarify] })).map(s => s.kind)).toEqual(['clarify']);
    const action = { kind: 'action', actionId: 'monitor.create', params: {} };
    expect(steps(canonicalizeModelPlan({ turnPlanVersion: 1, steps: [query, action] })).map(s => s.kind)).toEqual(['query', 'action']);
  });

  it('a Result title the model labels inherited/context_id is its own generated text; user_quoted is never invented; a line drops groupFieldId', () => {
    const artifact = (title: unknown, primitiveId = 'line') => steps(canonicalizeModelPlan({ turnPlanVersion: 1, steps: [{ kind: 'artifact', sourceStateId: 'S',
      artifactTypeId: 'chart', operation: 'revise', baseArtifactId: 'A', title, outputFormat: 'preview',
      visual: { primitiveId, xFieldId: 'date', yFieldIds: ['net_sales'], groupFieldId: 'region', interactionIds: ['tooltip'], animation: 'none' } }] }))[0]!;
    expect(artifact({ value: 'ยอดขายรายภาค', source: 'inherited' }).title).toEqual({ value: 'ยอดขายรายภาค', source: 'generated' });
    expect(artifact({ value: 'ยอดขายรายภาค', source: 'context_id' }).title).toEqual({ value: 'ยอดขายรายภาค', source: 'generated' });
    expect(artifact({ value: 'ยอดขาย', source: 'user_quoted', evidenceText: 'ยอดขาย' }).title).toEqual({ value: 'ยอดขาย', source: 'user_quoted', evidenceText: 'ยอดขาย' });
    // A line's series split is every non-x dimension (compiler-derived): a model-named groupFieldId is dropped, and kept for a heatmap.
    expect((artifact({ value: 'x', source: 'generated' }).visual as Record<string, unknown>).groupFieldId).toBeUndefined();
    expect((artifact({ value: 'x', source: 'generated' }, 'heatmap').visual as Record<string, unknown>).groupFieldId).toBe('region');
  });

  it('monitor.create recipients are optional: the owner always gets the alert, so "notify me" needs no recipient question', () => {
    expect(actionRegistry.get('monitor.create')!.params.recipientIds!.required).toBe(false);
  });
});

describe('G5 Dashboard target', () => {
  const dashboards: PlannerContext['dashboards'] = [
    { id: 'D1', title: 'ยอดขายรายภาค', current: true, updatedAt: '2026-10-02T05:00:00.000Z', widgetCount: 1 },
    { id: 'D2', title: 'ยอดขายรายภาค', updatedAt: '2026-10-01T03:00:00.000Z', widgetCount: 3 },
    { id: 'D3', title: 'ยอดขายรายภาค', updatedAt: '2026-10-01T03:00:00.000Z', widgetCount: 3 },
    { id: 'D4', title: 'สต็อก', updatedAt: '2026-10-01T03:00:00.000Z', widgetCount: 2 },
    { id: 'D5', title: 'ก'.repeat(140), updatedAt: '2026-10-01T03:00:00.000Z', widgetCount: 2 },
    { id: 'D6', title: 'ก'.repeat(140), updatedAt: '2026-10-01T04:00:00.000Z', widgetCount: 2 },
  ];
  it('same-title chips carry server facts and never read the same; unique titles stay plain; labels fit the chip bound', () => {
    const labels = dashboardChoiceLabels(dashboards);
    expect(labels.get('D4')).toBe('สต็อก');
    expect(labels.get('D1')).toMatch(/^ยอดขายรายภาค · ล่าสุดในแชทนี้ · อัปเดต .+ · 1 Widget$/u);
    expect(labels.get('D2')).toContain('3 Widget');
    expect(new Set(labels.values()).size).toBe(dashboards.length);
    for (const label of labels.values()) expect([...label].length).toBeLessThanOrEqual(160);
    expect(sameTitleDashboards({ dashboards } as PlannerContext, 'ยอดขายรายภาค')).toBe(3);
  });
  it('a dashboard.create title/source question is the Dashboard target question (create-new or a listed Dashboard)', () => {
    expect(isDashboardTargetSlot({ kind: 'action', actionId: 'dashboard.create' }, 'params.title')).toBe(true);
    expect(isDashboardTargetSlot({ kind: 'action', actionId: 'dashboard.create' }, 'params.source')).toBe(true);
    expect(isDashboardTargetSlot({ kind: 'action', actionId: 'dashboard.create' }, 'params.regionIds')).toBe(false);
    expect(isDashboardTargetSlot({ kind: 'action', actionId: 'monitor.create' }, 'params.title')).toBe(false);
  });
});
