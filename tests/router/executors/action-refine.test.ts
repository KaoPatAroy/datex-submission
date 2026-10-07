import { describe, expect, it } from 'vitest';
import { executeActionStep } from '@/lib/router/executors/action';
import { executeRefineStep, type RefineExecutorInput } from '@/lib/router/executors/refine';
import { validateTurnPlan } from '@/lib/router/validate';
import { CONVERSATION, eastActor, fakePorts, grounded, groundedRefine, NOW, TURN } from './action-fixtures';
import { inputFor, plan } from '../fixtures';

const refine = (f: ReturnType<typeof fakePorts>, step: RefineExecutorInput['step'], over: Partial<RefineExecutorInput> = {}) =>
  executeRefineStep({ ports: f.ports, actor: eastActor(), step, conversationId: CONVERSATION, now: NOW, ...over });

async function pendingShare(f: ReturnType<typeof fakePorts>) {
  const r = await executeActionStep({ ports: f.ports, actor: eastActor(), conversationId: CONVERSATION, turnId: TURN, now: NOW,
    step: grounded('dashboard.share', { dashboard: 'D1', recipientId: 'team_east' }) });
  return r.outcome === 'proposed' ? r.ids.pendingActionId! : '';
}
function draft(f: ReturnType<typeof fakePorts>, id = 'PD1', conversationId = CONVERSATION) {
  f.state.pending.set(id, { id, actorId: 'east_manager', conversationId, status: 'pending', payload: { kind: 'dashboard_create', spec: {} }, payloadHash: id, preview: 'p', createdAt: 'x', expiresAt: 'y' } as never);
  return id;
}

describe('refine: pending dashboard proposals', () => {
  it('renames a pending draft through the revise path with a deterministic request key', async () => {
    const f = fakePorts(); const id = draft(f);
    const step = groundedRefine(id, { op: 'revise_dashboard' }, { title: 'ใหม่' });
    const r = await refine(f, step);
    expect(r).toMatchObject({ outcome: 'updated', ids: { pendingActionId: 'PD1-r' } });
    expect(f.state.revisions[0]).toMatchObject({ id, patch: { title: 'ใหม่' } });
    await refine(f, step);
    expect(f.state.revisions[1].key).toBe(f.state.revisions[0].key);
  });

  it('removes widgets via a strict widgetChange patch', async () => {
    const f = fakePorts(); const id = draft(f);
    await refine(f, groundedRefine(id, { op: 'revise_dashboard' }, { removeWidgetIndexes: [1, 2] }));
    expect(f.state.revisions[0].patch).toEqual({ widgetChange: { operation: 'remove', indexes: [1, 2] } });
  });

  it('reports a failed revision truthfully and leaves the original pending', async () => {
    const f = fakePorts({}, { reviseFails: true }); const id = draft(f);
    const r = await refine(f, groundedRefine(id, { op: 'revise_dashboard' }, { title: 'x' }));
    expect(r).toMatchObject({ outcome: 'failed', code: 'revise_failed' });
    expect(f.state.pending.get(id)?.status).toBe('pending');
  });

  it('cancels a pending proposal', async () => {
    const f = fakePorts(); const id = await pendingShare(f);
    const r = await refine(f, groundedRefine(id, { op: 'cancel' }));
    expect(r).toMatchObject({ outcome: 'cancelled', ids: { pendingActionId: id } });
    expect(f.state.pending.get(id)?.status).toBe('stale');
  });

  it('cancels a staged (effect) proposal and refuses to revise it', async () => {
    const f = fakePorts();
    const a = await executeActionStep({ ports: f.ports, actor: eastActor(), conversationId: CONVERSATION, turnId: TURN, now: NOW, step: grounded('dashboard.delete', { dashboard: 'D1' }) });
    const id = a.outcome === 'proposed' ? a.ids.pendingActionId! : '';
    expect(await refine(f, groundedRefine(id, { op: 'revise_dashboard' }, { title: 'x' }))).toMatchObject({ outcome: 'denied', code: 'not_revisable' });
    expect(await refine(f, groundedRefine(id, { op: 'cancel' }))).toMatchObject({ outcome: 'cancelled' });
    expect(f.state.staged.get(id)?.status).toBe('cancelled');
    expect(await refine(f, groundedRefine(id, { op: 'cancel' }))).toMatchObject({ outcome: 'denied', code: 'not_pending' });
  });

  it('only dashboard drafts are revisable; other conversations and actors are denied', async () => {
    const f = fakePorts(); const share = await pendingShare(f);
    expect(await refine(f, groundedRefine(share, { op: 'revise_dashboard' }, { title: 'x' }))).toMatchObject({ outcome: 'denied', code: 'not_revisable' });
    const other = draft(f, 'PX', 'other-conv');
    expect(await refine(f, groundedRefine(other, { op: 'cancel' }))).toMatchObject({ outcome: 'denied', code: 'target_not_found' });
    const mine = draft(f, 'PY');
    expect((await refine(f, groundedRefine(mine, { op: 'cancel' }), { actor: eastActor({ id: 'intruder' }) })).outcome).toBe('denied');
    expect(f.state.calls.filter(c => c.startsWith('cancel:'))).toEqual([]);
  });
});

describe('refine: saved dashboards', () => {
  it('renames a saved dashboard directly with undo info', async () => {
    const f = fakePorts();
    const r = await refine(f, groundedRefine('D1', { op: 'revise_dashboard' }, { title: 'ชื่อใหม่' }));
    expect(r).toMatchObject({ outcome: 'updated', ids: { dashboardId: 'D1' }, undo: { kind: 'rename_dashboard', title: 'Bangkok dashboard' } });
    expect(r.text).toContain('ชื่อใหม่');
    expect(f.state.audits).toEqual(['router_direct_rename']);
  });

  it('denies cancel, widget edits, foreign and deleted dashboards; needs permission', async () => {
    const f = fakePorts({}, { dashboards: new Map([
      ['D1', { id: 'D1', ownerId: 'east_manager', title: 'T', shared: false, deleted: false }],
      ['D2', { id: 'D2', ownerId: 'other', title: 'T', shared: false, deleted: false }],
      ['D3', { id: 'D3', ownerId: 'east_manager', title: 'T', shared: false, deleted: true }]]) });
    expect(await refine(f, groundedRefine('D1', { op: 'cancel' }))).toMatchObject({ code: 'cancel_not_applicable' });
    expect(await refine(f, groundedRefine('D1', { op: 'revise_dashboard' }, { removeWidgetIndexes: [0] }))).toMatchObject({ code: 'saved_dashboard_widgets_unsupported' });
    expect(await refine(f, groundedRefine('D2', { op: 'revise_dashboard' }, { title: 'x' }))).toMatchObject({ code: 'target_not_found' });
    expect(await refine(f, groundedRefine('D3', { op: 'revise_dashboard' }, { title: 'x' }))).toMatchObject({ code: 'target_not_found' });
    expect(await refine(f, groundedRefine('D1', { op: 'revise_dashboard' }, { title: 'x' }), { actor: eastActor({ permissions: [] }) })).toMatchObject({ code: 'permission_denied' });
    expect(f.state.calls).toEqual([]);
  });
});

describe('validator accepts a saved dashboard id as a refine target', () => {
  it('grounds title on a context dashboard and still rejects unknown ids', () => {
    const op = { op: 'revise_dashboard', title: { value: 'ชื่อใหม่', source: 'generated' } };
    expect(validateTurnPlan(inputFor(plan({ kind: 'refine', pendingActionId: 'D1', operation: op }))).outcome).toBe('accepted');
    expect(validateTurnPlan(inputFor(plan({ kind: 'refine', pendingActionId: 'ZZ', operation: op }))).outcome).toBe('clarify');
  });
});
