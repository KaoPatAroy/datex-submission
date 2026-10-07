import { describe, expect, it } from 'vitest';
import hostileModalMay from './live-fixtures/modal-may-hostile.json';
import { parsePlannerJSON } from '../../lib/dynamic/planner/planner';
import { resolveSpan } from '../../lib/dynamic/plan/normalize';
import { validateQueryPlan } from '../../lib/dynamic/validate/query-plan';
import { available, catalog, executive, filter, proposal } from './fixtures';

describe('AI-first review regressions', () => {
  it('requires useful evidence locations and ASCII token boundaries while allowing Thai substrings', () => {
    expect(resolveSpan('E', 'E')).toBeNull();
    expect(resolveSpan('E012 sales', 'E01')).toBeNull();
    expect(resolveSpan('store ภาคตะวันออก sales', 'ภาคตะวัน')).not.toBeNull();
  });
  it('clarifies hostile model dates lacking current-message evidence', () => {
    expect(parsePlannerJSON(hostileModalMay.raw, undefined, { sourceText: hostileModalMay.message, businessDate: '2026-10-06' }))
      .toMatchObject({ outcome: 'clarification_required', code: 'unsupported_time_text', clarification: { slotId: 'time' } });
  });
  it('validates canonical filter codes and evidence presence without interpreting their relationship', () => {
    const text = 'E01 sales', plan = filter(proposal(text), text, 'branch', 'E02', 'E01');
    expect(validateQueryPlan(plan, catalog, executive, available(text))).toMatchObject({ outcome: 'accepted', scope: { branchIds: ['E02'] } });
  });
});
