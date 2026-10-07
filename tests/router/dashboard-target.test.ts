import { describe, expect, it } from 'vitest';
import { dashboardTargetOffer, isDashboardTargetSlot, isGenericDashboardQuery, NEW_DASHBOARD_CHOICE_ID } from '@/lib/router/dashboard-target';
import { contextFor } from './fixtures';

const answered = { previousState: { stateId: 'conversation_state:abc', values: {} } };
const unanswered = { previousState: null, acceptedStates: [] };

describe('G3-5 Dashboard target choices (server-built, never a literal-title search)', () => {
  it('treats the bare resource noun from the MODEL lookup as no title at all', () => {
    for (const query of ['Dashboard', 'dashboard', 'Dashboards', 'แดชบอร์ด', 'Dashboard นั้น', 'the dashboard']) expect(isGenericDashboardQuery(query)).toBe(true);
    for (const query of ['ยอดขายปีที่แล้ว', 'Dashboard ยอดขายภาคตะวันออก', 'Sales dashboard 2025']) expect(isGenericDashboardQuery(query)).toBe(false);
  });

  it('offers the listed Dashboards plus create-new when an answer exists; only create-new when there is no Dashboard yet', () => {
    const offer = dashboardTargetOffer(contextFor('executive', answered));
    expect(offer?.choices.map(c => c.id)).toEqual(['D1', NEW_DASHBOARD_CHOICE_ID]);
    expect(offer?.choices[0]?.label).toBe('Bangkok dashboard');
    const empty = dashboardTargetOffer(contextFor('executive', { ...answered, dashboards: [] }));
    expect(empty?.choices.map(c => c.id)).toEqual([NEW_DASHBOARD_CHOICE_ID]);
    expect(empty?.text).toContain('ยังไม่มี Dashboard');
  });

  it('never offers create-new without an answer to build from or without dashboard.create, and keeps validator-resolved choices', () => {
    expect(dashboardTargetOffer(contextFor('executive', unanswered))?.choices.map(c => c.id)).toEqual(['D1']);
    expect(dashboardTargetOffer(contextFor('executive', { ...unanswered, dashboards: [] }))).toBeUndefined();
    expect(dashboardTargetOffer(contextFor('executive', { ...answered, actions: [] }))?.choices.map(c => c.id)).toEqual(['D1']);
    // Validator-resolved choices keep their server labels; ids that are not listed Dashboards are never offered.
    expect(dashboardTargetOffer(contextFor('executive', answered), [{ id: 'D1', label: 'Bangkok dashboard' }, { id: 'X9', label: 'x' }])?.choices.map(c => c.id))
      .toEqual(['D1', NEW_DASHBOARD_CHOICE_ID]);
  });

  it('recognizes the Dashboard target slot of an action and of a refine', () => {
    expect(isDashboardTargetSlot({ kind: 'action' }, 'params.dashboard')).toBe(true);
    expect(isDashboardTargetSlot({ kind: 'refine' }, 'pendingActionId')).toBe(true);
    expect(isDashboardTargetSlot({ kind: 'action' }, 'params.title')).toBe(false);
  });
});
