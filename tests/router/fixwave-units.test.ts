import { describe, expect, it, vi } from 'vitest';
import { DomainError } from '@/lib/core/errors';
import { createSqliteStore } from '@/lib/storage/sqlite';
import { confirmProposal, DASHBOARD_CHANGED_CODE, DASHBOARD_SHARED_CODE, executeActionStep, type ActionExecutorInput } from '@/lib/router/executors/action';
import { executeRefineStep } from '@/lib/router/executors/refine';
import { STAGED_CLAIM_LEASE_MS, createStagedStore } from '@/lib/router/storage/staged-store';
import { hasVagueQuantity, isUngroundedSafeProse } from '@/lib/dynamic/response/conversational';
import { isSafeConversationProse } from '@/lib/router/render/safety';
import { CONVERSATION, eastActor, fakePorts, grounded, groundedRefine, NOW, TURN } from './executors/action-fixtures';

const base = (over: Partial<ActionExecutorInput> & Pick<ActionExecutorInput, 'step'>, ports = fakePorts()) => ({
  ports: ports.ports, actor: eastActor(), conversationId: CONVERSATION, turnId: TURN, now: NOW, ...over,
});
const shared = { id: 'D1', ownerId: 'east_manager', title: 'Bangkok dashboard', shared: true, deleted: false, revision: 'rev-1' };
const proposalIdOf = (r: { outcome: string; ids?: { pendingActionId?: string } }) => (r.outcome === 'proposed' ? r.ids!.pendingActionId! : '');

describe('F1 + F7 executors (dashboard rename/refine of shared or changed dashboards)', () => {
  it('F1: a shared dashboard rename is staged (confirm tier) and never written directly', async () => {
    const f = fakePorts({}, { dashboards: new Map([['D1', shared]]) });
    const r = await executeActionStep(base({ step: grounded('dashboard.rename', { dashboard: 'D1', title: 'New' }) }, f));
    expect(r).toMatchObject({ outcome: 'proposed' });
    expect(f.state.calls.filter(call => call.startsWith('rename:'))).toEqual([]);
    expect([...f.state.staged.values()][0]).toMatchObject({ actionId: 'dashboard.rename', data: { params: { dashboardId: 'D1', title: 'New' }, baseRevision: 'rev-1' } });
  });

  it('F1: a share created between the check and the write falls back to staging (in-transaction recheck signals DASHBOARD_SHARED)', async () => {
    const f = fakePorts({ renameDashboard: async () => { throw new DomainError(DASHBOARD_SHARED_CODE, 'shared', 409); } },
      { dashboards: new Map([['D1', { ...shared, shared: false }]]) });
    const r = await executeActionStep(base({ step: grounded('dashboard.rename', { dashboard: 'D1', title: 'New' }) }, f));
    expect(r.outcome).toBe('proposed');
    expect(f.state.staged.size).toBe(1);
  });

  it('F7: a concurrent edit makes the direct rename a clarify (no write) with the Thai retry text', async () => {
    const f = fakePorts({ renameDashboard: async () => { throw new DomainError(DASHBOARD_CHANGED_CODE, 'changed', 409); } },
      { dashboards: new Map([['D1', { ...shared, shared: false }]]) });
    const r = await executeActionStep(base({ step: grounded('dashboard.rename', { dashboard: 'D1', title: 'New' }) }, f));
    expect(r).toMatchObject({ outcome: 'clarify', text: 'Dashboard ถูกแก้ไขไปแล้ว กรุณาลองใหม่' });
  });

  it('F7: the direct rename passes the base revision; a refine through the shared path is staged with its base revision', async () => {
    const calls: unknown[] = [];
    const f = fakePorts({ renameDashboard: async (_a, id, input, guard) => { calls.push(guard); return { id, title: input.title }; } },
      { dashboards: new Map([['D1', { ...shared, shared: false }]]) });
    await executeActionStep(base({ step: grounded('dashboard.rename', { dashboard: 'D1', title: 'New' }) }, f));
    expect(calls).toEqual([{ expectedRevision: 'rev-1' }]);

    const g = fakePorts({}, { dashboards: new Map([['D1', shared]]) });
    const refined = await executeRefineStep({ ports: g.ports, actor: eastActor(), step: groundedRefine('D1', { op: 'revise_dashboard', title: null }, { title: 'Renamed' }),
      conversationId: CONVERSATION, now: NOW, turnId: TURN });
    expect(refined).toMatchObject({ outcome: 'proposed' });
    expect([...g.state.staged.values()][0]).toMatchObject({ actionId: 'dashboard.rename', data: { baseRevision: 'rev-1' } });
  });

  it('F7: a staged proposal confirm is denied (stale) when the dashboard changed since the preview', async () => {
    const f = fakePorts({ renameDashboard: async () => { throw new DomainError(DASHBOARD_CHANGED_CODE, 'changed', 409); } }, { dashboards: new Map([['D1', shared]]) });
    const staged = await executeActionStep(base({ step: grounded('dashboard.rename', { dashboard: 'D1', title: 'New' }) }, f));
    const done = await confirmProposal({ ports: f.ports, actor: eastActor(), proposalId: proposalIdOf(staged), now: NOW });
    expect(done).toMatchObject({ outcome: 'denied', code: 'dashboard_changed' });
    expect(f.state.staged.get(proposalIdOf(staged))?.status).toBe('stale');
  });
});

describe('F2 monitor deletion is staged', () => {
  const monitors = [{ id: 'monitor:m1', title: 'เฝ้าติดตามยอดขาย', status: 'monitor_active' }];
  const withManage = (calls: string[]) => {
    const f = fakePorts();
    f.ports.effects = { ...f.ports.effects!, listMonitors: async () => monitors,
      manageMonitor: async (_a, input) => { calls.push(`${input.op}:${input.monitorId}`); return { ok: true, text: `done ${input.op}` }; } };
    return f;
  };
  it('delete -> staged proposal, nothing is deleted until confirm; pause/resume stay direct', async () => {
    const calls: string[] = [];
    const f = withManage(calls);
    const step = (operation: string) => grounded('monitor.manage', { monitor: 'monitor:m1', operation });
    const del = await executeActionStep(base({ step: step('delete') }, f));
    expect(del).toMatchObject({ outcome: 'proposed' });
    expect(calls).toEqual([]);
    expect([...f.state.staged.values()][0]).toMatchObject({ actionId: 'monitor.delete', data: { params: { monitorId: 'monitor:m1' } } });
    expect(await executeActionStep(base({ step: step('pause') }, f))).toMatchObject({ outcome: 'updated' });
    expect(calls).toEqual(['pause:monitor:m1']);
    const done = await confirmProposal({ ports: f.ports, actor: eastActor(), proposalId: proposalIdOf(del), now: NOW });
    expect(done).toMatchObject({ outcome: 'executed', actionId: 'monitor.delete' });
    expect(calls).toEqual(['pause:monitor:m1', 'delete:monitor:m1']);
  });
  it('delete of an unknown monitor is denied without staging', async () => {
    const f = withManage([]);
    expect(await executeActionStep(base({ step: grounded('monitor.manage', { monitor: 'monitor:nope', operation: 'delete' }) }, f))).toMatchObject({ outcome: 'denied', code: 'monitor_not_found' });
    expect(f.state.staged.size).toBe(0);
  });
});

describe('F9 claim lease + idempotent retry; F10 mode fence and turn proof', () => {
  /** Real staged store over SQLite with a controllable clock, behind the fake action ports. */
  async function setup() {
    const clock = { ms: NOW().getTime() };
    const store = createSqliteStore(':memory:');
    const staged = createStagedStore(store, { now: () => clock.ms });
    await store.transaction(tx => tx.put('profiles', { id: 'p', name: 'p', role: 'executive', active: true, regions: ['east'], permissions: [] } as never));
    await store.transaction(tx => tx.put('sessions', { id: 's', profileId: 'p', mode: 'live_ai', modeRevision: 1, csrfToken: 'test-csrf-token', expiresAt: '2099-01-01T00:00:00.000Z' } as never));
    await store.transaction(tx => tx.put('sessions', { id: 's1', profileId: 'p', mode: 'live_ai', modeRevision: 1, csrfToken: 'test-csrf-token', expiresAt: '2099-01-01T00:00:00.000Z' } as never));
    const f = fakePorts();
    f.ports.staged = staged;
    f.ports.getDashboard = async (_a, id) => f.state.dashboards.get(id);
    const created = await executeActionStep(base({ step: grounded('dashboard.delete', { dashboard: 'D1' }), now: () => new Date(clock.ms) }, f));
    return { clock, store, staged, f, id: proposalIdOf(created) };
  }
  const confirmAt = (env: Awaited<ReturnType<typeof setup>>, ms: number, actor = eastActor()) =>
    confirmProposal({ ports: env.f.ports, actor, proposalId: env.id, now: () => new Date(ms) });

  it('F9: a crashed claimant is reclaimable only after the lease; the retry reconciles the committed effect and returns the stored result', async () => {
    const env = await setup();
    expect(await env.staged.claim(eastActor(), env.id)).toMatchObject({ status: 'claimed' });
    env.f.state.dashboards.set('D1', { ...env.f.state.dashboards.get('D1')!, deleted: true }); // the effect committed, then the process died
    expect(await confirmAt(env, env.clock.ms + 1_000)).toMatchObject({ outcome: 'denied', code: 'not_pending' }); // live lease is never stolen
    env.clock.ms += STAGED_CLAIM_LEASE_MS + 1;
    const done = await confirmAt(env, env.clock.ms);
    expect(done).toMatchObject({ outcome: 'executed', verified: true });
    expect(env.f.state.calls.filter(call => call.startsWith('delete:'))).toEqual([]); // not executed twice
    expect((await env.staged.get(eastActor(), env.id))?.status).toBe('completed');
    expect(await confirmAt(env, env.clock.ms)).toMatchObject({ outcome: 'executed', text: (done as { text: string }).text });
  });

  it('F9: an expired lease whose effect did NOT commit executes it once on retry', async () => {
    const env = await setup();
    await env.staged.claim(eastActor(), env.id);
    env.clock.ms += STAGED_CLAIM_LEASE_MS + 1;
    expect(await confirmAt(env, env.clock.ms)).toMatchObject({ outcome: 'executed' });
    expect(env.f.state.calls.filter(call => call.startsWith('delete:'))).toEqual(['delete:D1']);
  });

  it('F10: a proposal made under another mode revision is stale and never executes', async () => {
    const env = await setup();
    const row = (await env.store.get<Record<string, unknown>>('router_proposals', env.id))!;
    await env.store.transaction(tx => tx.put('router_proposals', { ...row, mode: 'live_ai', modeRevision: 0 } as never));
    expect(await confirmAt(env, env.clock.ms)).toMatchObject({ outcome: 'denied', code: 'mode_changed' });
    expect((await env.staged.get(eastActor(), env.id))?.status).toBe('stale');
    expect(env.f.state.calls.filter(call => call.startsWith('delete:'))).toEqual([]);
  });

  it('F10: confirm requires the completed-turn proof when the port is present', async () => {
    const env = await setup();
    env.f.ports.stagedTurnCompleted = vi.fn(async () => false);
    expect(await confirmAt(env, env.clock.ms)).toMatchObject({ outcome: 'denied', code: 'turn_not_completed' });
    expect(env.f.state.dashboards.get('D1')?.deleted).toBe(false);
    env.f.ports.stagedTurnCompleted = vi.fn(async () => true);
    expect(await confirmAt(env, env.clock.ms)).toMatchObject({ outcome: 'executed' });
  });

  it('F10: staleForTurn stales only the pending proposals of that turn', async () => {
    const env = await setup();
    const other = await env.staged.create(eastActor(), { conversationId: CONVERSATION, turnId: 'other-turn' },
      { actionId: 'dashboard.delete', digest: 'other', preview: 'x', data: {}, expiresAt: env.clock.ms + 10_000 });
    expect(await env.staged.staleForTurn(eastActor(), CONVERSATION, TURN)).toBe(1);
    expect((await env.staged.get(eastActor(), env.id))?.status).toBe('stale');
    expect((await env.staged.get(eastActor(), other.id))?.status).toBe('pending');
  });
});

describe('F15 vague quantity claims in model conversation prose', () => {
  it.each([
    'ลูกค้าหลายคนซื้อสินค้านี้', 'บางสาขายอดขายต่ำกว่าเป้า', 'พนักงานส่วนใหญ่มาทำงานตรงเวลา', 'สาขาทั้งหมดทำยอดได้ดี', 'มีรายการทั้งหมดที่ต้องตรวจ',
    'Several branches are below target.', 'Most stores performed well.', 'Many employees are on leave.', 'A few items are missing.', 'All branches improved.',
  ])('rejects %s', prose => {
    expect(hasVagueQuantity(prose)).toBe(true);
    expect(isSafeConversationProse(prose, [])).toBe(false);
  });
  it.each(['สวัสดีครับ ยินดีให้ความช่วยเหลือ', 'ต้องการให้ผมช่วยเรื่องอะไรครับ', 'Hello, how can I help you today?', 'ได้ครับ รับทราบ'])('keeps harmless prose %s', prose => {
    expect(hasVagueQuantity(prose)).toBe(false);
    expect(isSafeConversationProse(prose, [])).toBe(true);
    expect(isUngroundedSafeProse(prose, [])).toBe(true);
  });
});
