import { describe, expect, it } from 'vitest';
import {
  dashboardRefinementCandidateSchema,
  dashboardRefinementDecisionSchema,
} from '../lib/core/dashboard-refinement-contracts';

const baseActionId = 'action_pending_1';
const basePayloadHash = 'a'.repeat(64);

describe('dashboard chat refinement contract', () => {
  it('accepts an exact pending dashboard candidate and a bounded title/removal decision', () => {
    const candidate = dashboardRefinementCandidateSchema.parse({
      id: baseActionId,
      payloadHash: basePayloadHash,
      spec: {
        title: 'East sales',
        description: '',
        scope: { region: 'east', date: '2026-10-04' },
        widgets: [
          { type: 'metric', title: 'Sales', metric: 'net_sales' },
          { type: 'table', title: 'Staffing', dataset: 'staffing' },
        ],
      },
    });
    expect(candidate.id).toBe(baseActionId);
    expect(dashboardRefinementDecisionSchema.parse({
      kind: 'revise', baseActionId, basePayloadHash,
      patch: { title: 'East sales overview', widgetChange: { operation: 'remove', indexes: [1] } },
    })).toMatchObject({ patch: { title: 'East sales overview' } });
  });

  it('rejects invented recipients, scope changes, additions, duplicate indexes and model request keys', () => {
    const decision = { kind: 'revise', baseActionId, basePayloadHash };
    for (const patch of [
      { recipientId: 'person-1' },
      { scope: { region: 'all' } },
      { widgetChange: { operation: 'add', widgets: [{ type: 'text_summary', title: 'People' }], index: 0 } },
      { widgetChange: { operation: 'remove', indexes: [0, 0] } },
      {},
    ]) {
      expect(dashboardRefinementDecisionSchema.safeParse({ ...decision, patch }).success).toBe(false);
    }
    expect(dashboardRefinementDecisionSchema.safeParse({
      ...decision, patch: { title: 'New title' }, requestKey: 'model-chosen',
    }).success).toBe(false);
  });

  it('accepts only registered clarification reasons and no free-form model text', () => {
    expect(dashboardRefinementDecisionSchema.parse({
      kind: 'clarify', reason: 'participants_unspecified',
    })).toEqual({ kind: 'clarify', reason: 'participants_unspecified' });
    expect(dashboardRefinementDecisionSchema.safeParse({
      kind: 'clarify', reason: 'participants_unspecified', text: 'Call a manager',
    }).success).toBe(false);
    expect(dashboardRefinementDecisionSchema.safeParse({ kind: 'clarify', reason: 'other' }).success).toBe(false);
    expect(dashboardRefinementDecisionSchema.safeParse({ kind: 'continue', patch: { title: 'Hidden' } }).success).toBe(false);
  });
});
