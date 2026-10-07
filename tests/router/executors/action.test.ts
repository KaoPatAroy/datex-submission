import { describe, expect, it } from 'vitest';
import { actionRegistry } from '@/lib/router/action-registry';
import { confirmProposal, executeActionStep, type ActionExecutorInput } from '@/lib/router/executors/action';
import { CONVERSATION, eastActor, fakePorts, grounded, NOW, TURN, wave4Fixture } from './action-fixtures';

const base = (over: Partial<ActionExecutorInput> & Pick<ActionExecutorInput, 'step'>, ports = fakePorts()) => ({
  ports: ports.ports, actor: eastActor(), conversationId: CONVERSATION, turnId: TURN, now: NOW, ...over,
});
const dashParams = { regionIds: ['east'], date: '2026-10-06' };

describe('direct-tier actions', () => {
  it('dashboard.create executes immediately, audited, with undo info and labeled defaults', async () => {
    const f = fakePorts();
    const r = await executeActionStep(base({ step: grounded('dashboard.create', { ...dashParams, title: 'Mine' }, ['regionIds', 'date']) }, f));
    expect(r.outcome).toBe('created');
    if (r.outcome !== 'created') return;
    expect(r.ids.dashboardId).toBe('DASH-PA-1');
    expect(r.undo).toEqual({ kind: 'delete_dashboard', dashboardId: 'DASH-PA-1' });
    expect(r.text).toContain('สร้าง Dashboard “Mine” แล้ว');
    expect(r.text).toContain('ใช้ค่าเริ่มต้นของระบบ');
    expect(r.labels).toEqual(['default:regionIds', 'default:date']);
    expect(f.state.audits).toEqual(['router_direct_create']);
    expect(f.state.prepared[0].tool).toBe('dashboard.prepare_create');
    expect(f.state.prepared[0].args).toMatchObject({ spec: { title: 'Mine', scope: { region: 'east', date: '2026-10-06' } } });
  });

  it('dashboard.create reports failure instead of success when the receipt is unverified', async () => {
    const f = fakePorts({}, { receiptStatus: 'failed' });
    const r = await executeActionStep(base({ step: grounded('dashboard.create', dashParams) }, f));
    expect(r.outcome).toBe('failed');
    expect(f.state.audits).toEqual([]);
  });

  it('dashboard.create clarifies a region set it cannot represent', async () => {
    const f = fakePorts();
    const many = await executeActionStep(base({ actor: eastActor({ regions: ['east', 'west', 'south'] }), step: grounded('dashboard.create', { regionIds: ['east', 'west'], date: '2026-10-06' }) }, f));
    expect(many.outcome).toBe('clarify');
    const all = await executeActionStep(base({ actor: eastActor({ regions: ['east', 'west'] }), step: grounded('dashboard.create', { regionIds: ['east', 'west'], date: '2026-10-06' }) }, f));
    expect(all.outcome).toBe('created');
    expect(f.state.prepared[0].args).toMatchObject({ spec: { scope: { region: 'all' } } });
  });

  it('dashboard.rename applies directly for an owned dashboard and returns undo', async () => {
    const f = fakePorts();
    const r = await executeActionStep(base({ step: grounded('dashboard.rename', { dashboard: 'D1', title: 'New name' }) }, f));
    expect(r).toMatchObject({ outcome: 'updated', ids: { dashboardId: 'D1' }, undo: { kind: 'rename_dashboard', title: 'Bangkok dashboard' } });
    expect(f.state.dashboards.get('D1')?.title).toBe('New name');
  });

  it('dashboard.rename denies a dashboard the actor does not own', async () => {
    const f = fakePorts({}, { dashboards: new Map([['D9', { id: 'D9', ownerId: 'someone', title: 'X', shared: false, deleted: false }]]) });
    const r = await executeActionStep(base({ step: grounded('dashboard.rename', { dashboard: 'D9', title: 'Hijack' }) }, f));
    expect(r).toMatchObject({ outcome: 'denied', code: 'dashboard_denied' });
    expect(f.state.calls).toEqual([]);
  });
});

describe('confirm-tier actions', () => {
  it('dashboard.share proposes (never executes) and dedupes an identical second request', async () => {
    const f = fakePorts();
    const step = grounded('dashboard.share', { dashboard: 'D1', recipientId: 'team_east' });
    const first = await executeActionStep(base({ step }, f));
    expect(first).toMatchObject({ outcome: 'proposed', deduped: false, ids: { pendingActionId: 'PA-1', dashboardId: 'D1' } });
    const second = await executeActionStep(base({ step }, f));
    expect(second).toMatchObject({ outcome: 'proposed', deduped: true, ids: { pendingActionId: 'PA-1' } });
    expect(f.state.calls).toContain('cancel:PA-2');
    expect(f.state.calls.some(c => c.startsWith('confirm:'))).toBe(false);
    expect(first.outcome === 'proposed' && first.text).toContain('ยังไม่ได้ดำเนินการ');
  });

  it('dashboard.share denies a disallowed recipient or a foreign dashboard before preparing', async () => {
    const f = fakePorts();
    expect(await executeActionStep(base({ step: grounded('dashboard.share', { dashboard: 'D1', recipientId: 'stranger' }) }, f)))
      .toMatchObject({ outcome: 'denied', code: 'recipient_denied' });
    expect(await executeActionStep(base({ step: grounded('dashboard.share', { dashboard: 'NOPE', recipientId: 'team_east' }) }, f)))
      .toMatchObject({ outcome: 'denied', code: 'dashboard_denied' });
    expect(f.state.prepared).toEqual([]);
  });

  it('ticket.create proposes with the branch ids and scope; out-of-scope branches are denied', async () => {
    const f = fakePorts();
    const r = await executeActionStep(base({ step: grounded('ticket.create', { regionIds: ['east'], date: '2026-10-06', branchIds: ['E01'] }, ['regionIds', 'date']) }, f));
    expect(r).toMatchObject({ outcome: 'proposed', ids: { branchIds: ['E01'] } });
    expect(f.state.prepared[0]).toEqual({ tool: 'ticket.prepare_create', args: { scope: { region: 'east', date: '2026-10-06' }, branchIds: ['E01'] } });
    const g = fakePorts({}, { branchesOk: false });
    expect(await executeActionStep(base({ step: grounded('ticket.create', { regionIds: ['east'], date: '2026-10-06', branchIds: ['S01'] }) }, g)))
      .toMatchObject({ outcome: 'denied', code: 'scope_denied' });
    expect(g.state.prepared).toEqual([]);
  });

  it('badge.revoke proposes with the verbatim reason', async () => {
    const f = fakePorts();
    const r = await executeActionStep(base({ step: grounded('badge.revoke', { badgeId: 'B1', employeeId: 'E1', reason: 'lost badge' }) }, f));
    expect(r.outcome).toBe('proposed');
    expect(f.state.prepared[0].args).toEqual({ badgeId: 'B1', employeeId: 'E1', reason: 'lost badge' });
  });

  it('dashboard.delete stages a deduped proposal; confirm deletes and verifies; shared dashboards are denied', async () => {
    const f = fakePorts();
    const step = grounded('dashboard.delete', { dashboard: 'D1' });
    const a = await executeActionStep(base({ step }, f));
    const b = await executeActionStep(base({ step }, f));
    expect(a).toMatchObject({ outcome: 'proposed', deduped: false });
    expect(b).toMatchObject({ outcome: 'proposed', deduped: true });
    expect(f.state.staged.size).toBe(1);
    expect(f.state.dashboards.get('D1')?.deleted).toBe(false);
    const id = a.outcome === 'proposed' ? a.ids.pendingActionId! : '';
    const done = await confirmProposal({ ports: f.ports, actor: eastActor(), proposalId: id, now: NOW });
    expect(done.outcome).toBe('executed');
    expect(f.state.dashboards.get('D1')?.deleted).toBe(true);
    expect(f.state.staged.get(id)?.status).toBe('completed');
    expect(await confirmProposal({ ports: f.ports, actor: eastActor(), proposalId: id, now: NOW })).toMatchObject({ outcome: 'executed', text: expect.stringContaining('ลบ Dashboard') }); // retry returns the stored result (F9)
    const g = fakePorts({}, { dashboards: new Map([['D1', { id: 'D1', ownerId: 'east_manager', title: 'T', shared: true, deleted: false }]]) });
    expect(await executeActionStep(base({ step }, g))).toMatchObject({ outcome: 'denied', code: 'dashboard_shared' });
  });

  it('confirms a built-in pending action through the existing confirm path', async () => {
    const f = fakePorts();
    const p = await executeActionStep(base({ step: grounded('dashboard.share', { dashboard: 'D1', recipientId: 'team_east' }) }, f));
    const id = p.outcome === 'proposed' ? p.ids.pendingActionId! : '';
    expect(await confirmProposal({ ports: f.ports, actor: eastActor(), proposalId: id, now: NOW })).toMatchObject({ outcome: 'executed', ids: { pendingActionId: id } });
  });
});

describe('authorization is re-checked server-side', () => {
  it.each([
    ['missing permission', eastActor({ permissions: ['sales.read'] })],
    ['inactive actor', eastActor({ active: false })],
  ])('denies %s', async (_n, actor) => {
    const f = fakePorts();
    const r = await executeActionStep(base({ actor, step: grounded('dashboard.share', { dashboard: 'D1', recipientId: 'team_east' }) }, f));
    expect(r).toMatchObject({ outcome: 'denied', code: 'permission_denied' });
    expect(f.state.prepared).toEqual([]);
  });

  it('denies regions outside the reloaded actor scope', async () => {
    const f = fakePorts();
    const r = await executeActionStep(base({ step: grounded('dashboard.create', { regionIds: ['south'], date: '2026-10-06' }) }, f));
    expect(r).toMatchObject({ outcome: 'denied', code: 'scope_denied' });
    expect(f.state.prepared).toEqual([]);
  });

  it('uses the reloaded actor, not the stale one', async () => {
    const f = fakePorts({ reloadActor: async a => ({ ...a, permissions: [] }) });
    expect((await executeActionStep(base({ step: grounded('dashboard.rename', { dashboard: 'D1', title: 'x' }) }, f))).outcome).toBe('denied');
  });

  it('rejects unknown actions and the registry tiers match the runtime contracts', async () => {
    expect(await executeActionStep(base({ step: grounded('nope.nope', {}) }))).toMatchObject({ outcome: 'denied', code: 'unknown_action' });
    expect(actionRegistry.definitions.filter(d => d.riskTier === 'direct').map(d => d.actionId)).toEqual(['dashboard.create', 'monitor.manage', 'result.manage', 'result.unarchive', 'dashboard.rename', 'dashboard.manage']);
  });
});

describe('Wave 4 communication.send', () => {
  const params = { recipientIds: ['team_east'], content: 'ST1' };
  it('previews, dedupes, then confirm -> execute -> verify writes the simulated inbox once', async () => {
    const f = fakePorts();
    const step = grounded('communication.send', params, []);
    const a = await executeActionStep(base({ step }, f));
    expect(a.outcome).toBe('proposed');
    if (a.outcome !== 'proposed') return;
    expect(a.preview).toContain('East Team');
    expect(a.preview).toContain('E03 sales: 800');
    expect(a.ids.recipientIds).toEqual(['team_east']);
    expect(await executeActionStep(base({ step }, f))).toMatchObject({ outcome: 'proposed', deduped: true, ids: { pendingActionId: a.ids.pendingActionId } });
    expect(f.state.inbox).toEqual([]);
    const done = await confirmProposal({ ports: f.ports, actor: eastActor(), proposalId: a.ids.pendingActionId!, now: NOW });
    expect(done).toMatchObject({ outcome: 'executed', verified: true });
    expect(f.state.inbox).toHaveLength(1);
    expect(f.state.inbox[0]).toMatchObject({ kind: 'simulated_inbox', content: 'E03 sales: 800; target: 1000.' });
    expect(f.state.staged.get(a.ids.pendingActionId!)?.status).toBe('completed');
  });

  it('denies recipients outside server policy, missing consent, and disabled effects', async () => {
    const f = fakePorts();
    expect(await executeActionStep(base({ step: grounded('communication.send', { recipientIds: ['stranger'], content: 'ST1' }) }, f)))
      .toMatchObject({ outcome: 'denied', code: 'recipient_denied' });
    const w = wave4Fixture();
    const noConsent = fakePorts({ effects: { ...fakePorts().ports.effects!, communication: async () => ({ context: { ...w.context, consents: [] }, consent: w.communication.consent, contentClaimIds: ['sales_claim'], inbox: [] }) } });
    expect(await executeActionStep(base({ step: grounded('communication.send', params) }, noConsent)))
      .toMatchObject({ outcome: 'denied', code: expect.stringContaining('permission_denied') });
    const off = fakePorts({ effects: undefined });
    expect(await executeActionStep(base({ step: grounded('communication.send', params) }, off))).toMatchObject({ outcome: 'denied', code: 'effects_disabled' });
  });

  it('clarifies when the content cannot be bound to a verified answer', async () => {
    const f = fakePorts({ effects: { ...fakePorts().ports.effects!, communication: async () => undefined } });
    expect(await executeActionStep(base({ step: grounded('communication.send', params) }, f))).toMatchObject({ outcome: 'clarify', code: 'content_unbound' });
  });

  it('refuses to confirm when the preview expired or recipient policy changed', async () => {
    const f = fakePorts();
    const a = await executeActionStep(base({ step: grounded('communication.send', params) }, f));
    const id = a.outcome === 'proposed' ? a.ids.pendingActionId! : '';
    const late = await confirmProposal({ ports: f.ports, actor: eastActor(), proposalId: id, now: () => new Date(NOW().getTime() + 25 * 3_600_000) });
    expect(late).toMatchObject({ outcome: 'denied', code: 'expired' });
    expect(f.state.inbox).toEqual([]);
    const b = await executeActionStep(base({ step: grounded('communication.send', { recipientIds: ['team_east'], content: 'ST2' }) }, f));
    const id2 = b.outcome === 'proposed' ? b.ids.pendingActionId! : '';
    f.state.allowedRecipients.clear();
    expect(await confirmProposal({ ports: f.ports, actor: eastActor(), proposalId: id2, now: NOW })).toMatchObject({ outcome: 'denied', code: 'recipient_denied' });
    expect(f.state.inbox).toEqual([]);
  });

  it('re-previews when only the 10 min preview token lapsed (proposal still within 24 h)', async () => {
    const f = fakePorts();
    const a = await executeActionStep(base({ step: grounded('communication.send', params) }, f));
    const id = a.outcome === 'proposed' ? a.ids.pendingActionId! : '';
    const staged = f.state.staged.get(id)!;
    expect(staged.expiresAt).toBe(NOW().getTime() + 24 * 3_600_000);
    const soon = await confirmProposal({ ports: f.ports, actor: eastActor(), proposalId: id, now: () => new Date(NOW().getTime() + 11 * 60_000) });
    expect(soon).toMatchObject({ outcome: 'executed', verified: true });
  });

  it('only the owner can confirm', async () => {
    const f = fakePorts();
    const a = await executeActionStep(base({ step: grounded('communication.send', params) }, f));
    const id = a.outcome === 'proposed' ? a.ids.pendingActionId! : '';
    expect(await confirmProposal({ ports: f.ports, actor: eastActor({ id: 'other' }), proposalId: id, now: NOW })).toMatchObject({ outcome: 'denied', code: 'not_owner' });
  });
});

describe('Wave 4 monitor.create', () => {
  const params = { query: 'ST1', threshold: 0.9, recipientIds: ['team_east'], conditionId: 'sales_below_target', cadenceId: 'daily' };
  it('previews and installs a daily monitor after confirm -> execute -> verify', async () => {
    const f = fakePorts();
    const a = await executeActionStep(base({ step: grounded('monitor.create', params, ['conditionId', 'cadenceId']) }, f));
    expect(a.outcome).toBe('proposed');
    if (a.outcome !== 'proposed') return;
    expect(a.preview).toContain('90%');
    expect(a.labels).toEqual(['default:conditionId', 'default:cadenceId']);
    expect(await executeActionStep(base({ step: grounded('monitor.create', params, ['conditionId', 'cadenceId']) }, f))).toMatchObject({ deduped: true });
    const done = await confirmProposal({ ports: f.ports, actor: eastActor(), proposalId: a.ids.pendingActionId!, now: NOW });
    expect(done).toMatchObject({ outcome: 'executed', verified: true });
    expect(f.state.monitors).toHaveLength(1);
    expect(f.state.monitors[0]).toMatchObject({ lifecycle: 'active', workflow: { status: 'verified' } });
  });

  it('denies a recipient outside policy and an authority snapshot without monitor.manage', async () => {
    const f = fakePorts();
    expect(await executeActionStep(base({ step: grounded('monitor.create', { ...params, recipientIds: ['stranger'] }) }, f)))
      .toMatchObject({ outcome: 'denied', code: 'recipient_denied' });
    const w = wave4Fixture();
    const ctx = { ...w.context, authority: { ...w.context.authority, actor: { ...w.context.authority.actor, permissions: ['sales.read'] } } };
    const g = fakePorts({ effects: { ...fakePorts().ports.effects!, monitor: async () => ({ context: ctx, query: w.monitor.queryPlan, consent: w.monitor.consent, contentClaimIds: ['sales_claim'] }) } });
    expect(await executeActionStep(base({ step: grounded('monitor.create', params) }, g))).toMatchObject({ outcome: 'denied' });
    expect(g.state.staged.size).toBe(0);
  });
});

describe('dashboard.manage and monitor.manage rename (AI parity with the Dashboard / Monitor pages)', () => {
  it('dashboard.manage runs the injected organization rules by server id and reports the operation truthfully', async () => {
    const calls: unknown[] = [];
    const f = fakePorts({ organizeDashboard: async (_a, dashboardId, op) => { calls.push([dashboardId, op]); return { dashboardId: op === 'duplicate' ? 'D1-copy' : dashboardId, title: 'Bangkok dashboard' }; } });
    for (const op of ['pin', 'unpin', 'archive', 'restore', 'duplicate'] as const) {
      const r = await executeActionStep(base({ step: grounded('dashboard.manage', { dashboard: 'D1', operation: op }) }, f));
      expect(r, op).toMatchObject({ outcome: 'updated', actionId: 'dashboard.manage', ids: { dashboardId: op === 'duplicate' ? 'D1-copy' : 'D1' } });
      if (r.outcome === 'updated') expect(r.text).toContain('Bangkok dashboard');
    }
    expect(calls).toEqual([['D1', 'pin'], ['D1', 'unpin'], ['D1', 'archive'], ['D1', 'restore'], ['D1', 'duplicate']]);
  });

  it('dashboard.manage: a rule refusal is a truthful no-effect denial; no port = effects_disabled; an unknown operation clarifies', async () => {
    const { DomainError } = await import('@/lib/core/errors');
    const refused = fakePorts({ organizeDashboard: async () => { throw new DomainError('CONFLICT', 'นำ Dashboard ที่เก็บถาวรกลับมาก่อนจึงจะปักหมุดได้', 409); } });
    const r = await executeActionStep(base({ step: grounded('dashboard.manage', { dashboard: 'D1', operation: 'pin' }) }, refused));
    expect(r).toMatchObject({ outcome: 'denied', code: 'conflict' });
    if (r.outcome === 'denied') expect(r.text).toContain('ยังไม่ได้ดำเนินการ');
    expect(await executeActionStep(base({ step: grounded('dashboard.manage', { dashboard: 'D1', operation: 'pin' }) }))).toMatchObject({ outcome: 'denied', code: 'effects_disabled' });
    const any = fakePorts({ organizeDashboard: async () => ({ dashboardId: 'D1', title: 'x' }) });
    expect(await executeActionStep(base({ step: grounded('dashboard.manage', { dashboard: 'D1', operation: 'share' }) }, any))).toMatchObject({ outcome: 'clarify', code: 'operation_missing' });
  });

  it('monitor.manage rename needs a title and uses the injected owner + CAS rule; no rename port = effects_disabled', async () => {
    const renamed: unknown[] = [];
    const f = fakePorts();
    const effects = { ...f.ports.effects!, manageMonitor: async () => ({ ok: true as const, text: 'x' }),
      renameMonitor: async (_a: unknown, input: { monitorId: string; title: string }) => { renamed.push(input); return { ok: true as const, text: `เปลี่ยนชื่อ Monitor เป็น “${input.title}” แล้ว` }; } };
    const ports = { ...f, ports: { ...f.ports, effects } };
    expect(await executeActionStep(base({ step: grounded('monitor.manage', { monitor: 'M1', operation: 'rename', title: 'East watch' }) }, ports)))
      .toMatchObject({ outcome: 'updated', text: 'เปลี่ยนชื่อ Monitor เป็น “East watch” แล้ว' });
    expect(renamed).toEqual([{ monitorId: 'M1', title: 'East watch' }]);
    expect(await executeActionStep(base({ step: grounded('monitor.manage', { monitor: 'M1', operation: 'rename' }) }, ports))).toMatchObject({ outcome: 'clarify', code: 'missing_param' });
    const refused = { ...f, ports: { ...f.ports, effects: { ...effects, renameMonitor: async () => ({ ok: false as const, code: 'monitor_not_found', text: 'ไม่พบ Monitor ของคุณตามที่ระบุ' }) } } };
    expect(await executeActionStep(base({ step: grounded('monitor.manage', { monitor: 'M9', operation: 'rename', title: 'x' }) }, refused))).toMatchObject({ outcome: 'denied', code: 'monitor_not_found' });
    const without = { ...f, ports: { ...f.ports, effects: { ...effects, renameMonitor: undefined } } };
    expect(await executeActionStep(base({ step: grounded('monitor.manage', { monitor: 'M1', operation: 'rename', title: 'x' }) }, without))).toMatchObject({ outcome: 'denied', code: 'effects_disabled' });
  });
});
