import { describe, expect, it } from 'vitest';
import type { DashboardSpec } from '@/lib/contracts';
import { confirmProposal } from '@/lib/router/executors/action';
import { executeRefineStep, type RefineExecutorInput } from '@/lib/router/executors/refine';
import { applyDashboardCreatePatch } from '@/lib/core/pending-action-lifecycle';
import { CONVERSATION, eastActor, fakePorts, groundedRefine, NOW, TURN } from './action-fixtures';

const baseSpec = (): DashboardSpec => ({ title: 'Base', description: 'd', scope: { region: 'east', date: '2026-10-01' },
  widgets: [{ type: 'metric', title: 'Net sales', metric: 'net_sales' } as never] });
const viz = { version: 1, title: 'ใหม่', description: 'd', widgets: [{ kind: 'kpi', title: 'ยอด', measure: 'net_sales', dimension: null, sort: null, topN: null }] };
const h = 'a'.repeat(64);
const newWidget = { type: 'viz', title: 'ยอด', kind: 'kpi', measure: 'net_sales', binding: { datasetId: 'branch_performance', evidenceDigest: h, claimGraphDigest: h, catalogDigest: h, queryDigest: h, message: 'm', query: {} } } as never;
const refineDashboardSpec: NonNullable<RefineExecutorInput['refineDashboardSpec']> = async ({ base }) =>
  ({ outcome: 'accepted', spec: { ...base, widgets: [...base.widgets, newWidget] } });
const step = (id: string, over: Record<string, unknown> = {}) => groundedRefine(id, { op: 'revise_dashboard', visualization: viz, sourceStateId: 'ST1', ...over });
const run = (f: ReturnType<typeof fakePorts>, s: ReturnType<typeof step>, extra: Partial<RefineExecutorInput> = {}) =>
  executeRefineStep({ ports: f.ports, actor: eastActor(), step: s, conversationId: CONVERSATION, turnId: TURN, now: NOW, refineDashboardSpec, ...extra });

describe('refine with a visualization plan', () => {
  it('updates a private saved dashboard directly (append keeps existing widgets)', async () => {
    let saved: DashboardSpec | undefined;
    const f = fakePorts({ updateDashboardSpec: async (_a, id, spec) => { saved = spec; return { id, title: spec.title }; } });
    f.state.dashboards.set('D1', { ...f.state.dashboards.get('D1')!, spec: baseSpec() });
    const r = await run(f, step('D1'));
    expect(r.outcome).toBe('updated');
    expect(saved?.widgets).toHaveLength(2);
    expect(f.state.audits).toContain('router_direct_refine');
  });

  it('stages a confirm-tier proposal for a shared dashboard, then applies it only on confirm', async () => {
    let saved: DashboardSpec | undefined;
    const f = fakePorts({ updateDashboardSpec: async (_a, id, spec) => { saved = spec; f.state.dashboards.set(id, { ...f.state.dashboards.get(id)!, spec }); return { id, title: spec.title }; } });
    f.state.dashboards.set('D1', { ...f.state.dashboards.get('D1')!, shared: true, spec: baseSpec() });
    const r = await run(f, step('D1'));
    expect(r).toMatchObject({ outcome: 'proposed' });
    expect(saved).toBeUndefined();
    if (r.outcome !== 'proposed') return;
    const confirmed = await confirmProposal({ ports: f.ports, actor: eastActor(), proposalId: r.ids.pendingActionId!, now: NOW });
    expect(confirmed).toMatchObject({ outcome: 'executed' });
    expect(saved?.widgets).toHaveLength(2);
  });

  it('turns a pending draft refine into a strict add / set patch that the lifecycle applies', async () => {
    const f = fakePorts();
    f.state.pending.set('PD1', { id: 'PD1', actorId: 'east_manager', conversationId: CONVERSATION, status: 'pending', payload: { kind: 'dashboard_create', spec: baseSpec() },
      payloadHash: 'h', preview: 'p', createdAt: 'x', expiresAt: 'y' } as never);
    await run(f, step('PD1'));
    expect(f.state.revisions[0].patch).toMatchObject({ widgetChange: { operation: 'add', index: 1 } });
    expect(applyDashboardCreatePatch(baseSpec(), f.state.revisions[0].patch).spec.widgets).toHaveLength(2);
    await run(f, step('PD1', { visualizationMode: 'replace' }));
    expect(f.state.revisions[1].patch).toMatchObject({ widgetChange: { operation: 'set' } });
    expect(applyDashboardCreatePatch(baseSpec(), f.state.revisions[1].patch).spec.widgets).toHaveLength(1);
  });

  it('denies truthfully when the evidence cannot be bound and never changes anything', async () => {
    const f = fakePorts({ updateDashboardSpec: async () => { throw new Error('must not run'); } });
    f.state.dashboards.set('D1', { ...f.state.dashboards.get('D1')!, spec: baseSpec() });
    const r = await run(f, step('D1'), { refineDashboardSpec: async () => ({ outcome: 'rejected', code: 'source_unavailable', text: 'ไม่มีหลักฐาน' }) });
    expect(r).toMatchObject({ outcome: 'denied', code: 'source_unavailable' });
  });
});
