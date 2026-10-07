import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor, Profile } from '@/lib/contracts';
import { conversationStateRef } from '@/lib/dynamic/planner/planner';
import { conversationStateSchema } from '@/lib/dynamic/state/conversation';
import { confirmProposal, executeActionStep } from '@/lib/router/executors/action';
import type { ActionPorts } from '@/lib/router/executors/action-ports';
import { createActionPorts } from '@/lib/router/ports/service-ports';
import { createEffectBindings } from '@/lib/router/ports/effect-bindings';
import { listOwnedMonitors } from '@/lib/router/ports/effect-store';
import { createMonitorRunner } from '@/lib/router/ports/monitor-runner';
import { createRecipientPolicy } from '@/lib/router/ports/recipient-policy';
import { createStagedStore } from '@/lib/router/storage/staged-store';
import { applyMonitorOp, monitorOpSchema, monitorRenameSchema, renameMonitor } from '@/lib/monitors/direct';
import { actors, createWorkspaceFixture, BUSINESS_DATE, FIXED_NOW } from '../helpers/workspace';
import { grounded } from '../router/executors/action-fixtures';

type Fixture = Awaited<ReturnType<typeof createWorkspaceFixture>>;
let fixture: Fixture;
const now = new Date(FIXED_NOW);
const clock = () => new Date(now);

beforeEach(async () => {
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('NEXUS_E2E_RUNNER', ''); vi.stubEnv('AI_PROVIDER', 'scripted');
  vi.stubEnv('USE_LOCAL_DEMO_DATA', 'true'); vi.stubEnv('VERCEL', ''); vi.stubEnv('BIZTANIA_DEPLOYMENT_ENV', 'development'); vi.stubEnv('BIZTANIA_DYNAMIC_QUERY', '');
  fixture = await createWorkspaceFixture();
});
afterEach(async () => { vi.unstubAllEnvs(); await fixture.dispose(); });

const refuse = async (): Promise<never> => { throw new Error('not available in this test'); };

async function install() {
  const { store } = fixture;
  await fixture.patchSession(actors.executive.sessionId, { mode: 'live_ai', modeRevision: 1 });
  const owner: Actor = { ...actors.executive, mode: 'live_ai', modeRevision: 1 };
  const recipientAllowed = createRecipientPolicy(store);
  const effects = createEffectBindings({ store, now: clock, businessDate: BUSINESS_DATE, recipientAllowed });
  const ports: ActionPorts = createActionPorts({
    reloadActor: async a => ({ ...(await store.get<Profile>('profiles', a.id))!, sessionId: a.sessionId, mode: a.mode, modeRevision: a.modeRevision }), prepareTool: refuse, confirmPending: refuse, cancelPending: refuse, revisePending: refuse,
    listPending: async () => [], getDashboard: async () => undefined, renameDashboard: refuse, deleteDashboard: refuse,
    recipientAllowed, staged: createStagedStore(store, { now: () => now.getTime() }), effects,
  });
  const runner = createMonitorRunner({ store, now: clock, businessDate: BUSINESS_DATE, recipientAllowed });
  const turn = await fixture.service.turn(owner, 'Show East sales totals for 2026-10-01.');
  const record = await store.get<{ state: unknown }>('tool_executions', `dynamic:${turn.turnId}`);
  const query = conversationStateRef(conversationStateSchema.parse(record?.state)).id;
  const run = (actionId: string, params: Record<string, string | number | string[]>) =>
    executeActionStep({ ports, actor: owner, step: grounded(actionId, params as never), conversationId: 'conv-direct', turnId: 'turn-direct', now: clock });
  const preview = await run('monitor.create', { query, threshold: 0.8, recipientIds: ['east'] });
  if (preview.outcome !== 'proposed') throw new Error('monitor.create was not proposed');
  expect(await confirmProposal({ ports, actor: owner, proposalId: preview.ids.pendingActionId!, now: clock })).toMatchObject({ outcome: 'executed' });
  const [row] = await listOwnedMonitors(store, owner);
  return { owner, runner, store, row: row!, run };
}

describe('direct Monitor operations (UI)', { timeout: 60_000 }, () => {
  it('pause -> resume works and keeps the evaluation history intact', async () => {
    const { owner, runner, row } = await install();
    expect((await runner.tick()).alerts).toBe(1);
    const before = (await runner.history(owner))[0]!.evaluations;
    expect(before).toHaveLength(1);
    expect((await applyMonitorOp(runner, owner, row.id, { op: 'pause' })).text).toContain('หยุด');
    expect((await runner.history(owner))[0]).toMatchObject({ lifecycle: 'paused', evaluations: before });
    await applyMonitorOp(runner, owner, row.id, { op: 'resume' });
    expect((await runner.history(owner))[0]).toMatchObject({ lifecycle: 'active', evaluations: before });
  });

  it('every lifecycle change writes a metadata-only audit event (kind, monitor id, operation; no user text); no-ops and refusals write none', async () => {
    const { owner, runner, store, row } = await install();
    const events = async () => (await store.list<{ category: string; summary: string; actionId?: string; actorId: string }>('audit_events')).filter(e => e.category === 'monitor_manage');
    expect(await events()).toHaveLength(0);
    await applyMonitorOp(runner, owner, row.id, { op: 'pause' });
    await applyMonitorOp(runner, owner, row.id, { op: 'pause' }); // already paused: nothing changed, nothing audited
    await applyMonitorOp(runner, owner, row.id, { op: 'resume' });
    await expect(applyMonitorOp(runner, owner, row.id, { op: 'delete' })).rejects.toMatchObject({ status: 400 });
    await expect(applyMonitorOp(runner, actors.east, row.id, { op: 'pause' })).rejects.toMatchObject({ status: 404 });
    await applyMonitorOp(runner, owner, row.id, { op: 'delete', confirmDelete: true });
    const written = await events();
    expect(written.map(e => e.summary)).toEqual(['monitor.pause', 'monitor.resume', 'monitor.delete']);
    for (const event of written) {
      expect(event).toMatchObject({ actorId: owner.id, actionId: row.id });
      expect(Object.keys(event).sort()).toEqual(['actionId', 'actorId', 'category', 'createdAt', 'id', 'summary']);
    }
  });

  it('the AI path (monitor.manage) and the staged delete confirm write the same audit events as the UI', async () => {
    const { owner, store, row, run } = await install();
    const events = async () => (await store.list<{ category: string; summary: string; actionId?: string }>('audit_events')).filter(e => e.category === 'monitor_manage').map(e => `${e.summary}:${e.actionId}`);
    expect(await run('monitor.manage', { monitor: row.id, operation: 'pause' })).toMatchObject({ outcome: 'updated' });
    expect(await run('monitor.manage', { monitor: row.id, operation: 'resume' })).toMatchObject({ outcome: 'updated' });
    expect(await events()).toEqual([`monitor.pause:${row.id}`, `monitor.resume:${row.id}`]);
    void owner;
  });

  it('delete is refused without an explicit confirmDelete, then soft-deletes: not listed, evaluations/row remain', async () => {
    const { owner, runner, store, row } = await install();
    await runner.tick();
    expect(monitorOpSchema.safeParse({ op: 'delete', extra: 1 }).success).toBe(false);
    await expect(applyMonitorOp(runner, owner, row.id, { op: 'delete' })).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED', status: 400 });
    await expect(applyMonitorOp(runner, owner, row.id, { op: 'delete', confirmDelete: false })).rejects.toMatchObject({ status: 400 });
    expect(await listOwnedMonitors(store, owner)).toHaveLength(1);
    await applyMonitorOp(runner, owner, row.id, { op: 'delete', confirmDelete: true });
    expect(await runner.history(owner)).toHaveLength(0);
    const kept = await store.get<{ status: string; evaluations: unknown[] }>('tool_executions', row.id);
    expect(kept).toMatchObject({ status: 'monitor_deleted' });
    expect(kept!.evaluations).toHaveLength(1);
    await expect(applyMonitorOp(runner, owner, row.id, { op: 'resume' })).rejects.toMatchObject({ status: 404 });
  });

  it('another owner and an unknown id fail closed with the same 404', async () => {
    const { owner, runner, store, row } = await install();
    const other = await applyMonitorOp(runner, actors.east, row.id, { op: 'pause' }).catch(e => e);
    const unknown = await applyMonitorOp(runner, owner, 'monitor:nope', { op: 'pause' }).catch(e => e);
    expect(other).toMatchObject({ status: 404, code: 'MONITOR_NOT_FOUND' });
    expect({ code: other.code, status: other.status, message: other.message }).toEqual({ code: unknown.code, status: unknown.status, message: unknown.message });
    await expect(applyMonitorOp(runner, actors.east, row.id, { op: 'delete', confirmDelete: true })).rejects.toMatchObject({ status: 404 });
    expect(await listOwnedMonitors(store, owner)).toHaveLength(1);
    expect((await listOwnedMonitors(store, owner))[0]).toMatchObject({ status: 'monitor_active' });
  });
});

describe('Monitor lists beyond one page and retained history of deleted Monitors (PC-03 / PC-11)', { timeout: 60_000 }, () => {
  it('11 monitors: the 11th (oldest) is reachable by cursor, total is exact, search narrows before paging', async () => {
    const { owner, runner, store, row } = await install();
    await store.transaction(async tx => {
      for (let i = 1; i <= 10; i++) await tx.put('tool_executions', { ...row, id: `monitor:copy-${i}`, title: `Copy ${String(i).padStart(2, '0')}`, createdAt: new Date(now.getTime() + i * 60_000).toISOString() });
    });
    const first = await runner.historyPage(owner);
    expect(first.items).toHaveLength(10);
    expect(first.total).toBe(11);
    expect(first.items.map(m => m.id)).not.toContain(row.id); // the oldest is the 11th
    expect(first.nextCursor).not.toBeNull();
    const second = await runner.historyPage(owner, { cursor: first.nextCursor });
    expect(second.items.map(m => m.id)).toEqual([row.id]);
    expect(second.nextCursor).toBeNull();
    expect((await runner.historyPage(owner, { needle: 'copy 03' })).items.map(m => m.id)).toEqual(['monitor:copy-3']);
    expect((await runner.historyPage(owner, { needle: 'copy 03' })).total).toBe(1);
    // another owner sees none of them
    expect((await runner.historyPage(actors.east)).total).toBe(0);
  });

  it('the retained evaluations of a deleted Monitor stay readable through the deleted history (owner only), and it leaves the active list', async () => {
    const { owner, runner, row } = await install();
    await runner.tick();
    await applyMonitorOp(runner, owner, row.id, { op: 'delete', confirmDelete: true });
    expect((await runner.historyPage(owner)).total).toBe(0);
    const deleted = await runner.historyPage(owner, { deleted: true });
    expect(deleted.total).toBe(1);
    expect(deleted.items[0]).toMatchObject({ id: row.id, status: 'monitor_deleted' });
    expect(deleted.items[0]!.evaluations).toHaveLength(1);
    expect(deleted.items[0]!.evaluations[0]).toMatchObject({ outcome: 'alerted' });
    expect((await runner.historyPage(actors.east, { deleted: true })).total).toBe(0);
  });
});

describe('P2: Monitor explanation data and metadata edit', { timeout: 60_000 }, () => {
  it('the history carries the configured condition (threshold, cooldown) and expiry the UI explains', async () => {
    const { owner, runner } = await install();
    const [item] = await runner.history(owner);
    expect(item).toMatchObject({ threshold: 0.8, cooldown: 'one_day', lifecycle: 'active' });
    expect(Number.isNaN(Date.parse(item!.expiresAt))).toBe(false);
  });

  it('rename changes only the display title: CAS-guarded, owner-only, audited, state and history untouched', async () => {
    const { owner, runner, store, row } = await install();
    await runner.tick();
    const before = await store.get<{ state: unknown; evaluations: unknown[]; rowVersion: number }>('tool_executions', row.id);
    expect((await renameMonitor(store, clock, owner, row.id, { op: 'rename', title: '  ยอดขายภาคตะวันออก  ' })).text).toContain('ยอดขายภาคตะวันออก');
    const after = await store.get<{ title: string; state: unknown; evaluations: unknown[]; rowVersion: number; status: string }>('tool_executions', row.id);
    expect(after).toMatchObject({ title: 'ยอดขายภาคตะวันออก', status: 'monitor_active', rowVersion: before!.rowVersion + 1 });
    expect(after!.state).toEqual(before!.state);
    expect(after!.evaluations).toEqual(before!.evaluations);
    expect((await runner.history(owner))[0]!.title).toBe('ยอดขายภาคตะวันออก');
    const audit = (await store.list<{ category: string; summary: string; actionId?: string }>('audit_events')).filter(e => e.category === 'monitor_manage');
    expect(audit.map(e => `${e.summary}:${e.actionId}`)).toEqual([`monitor.rename:${row.id}`]);
    // still pausable afterwards (the lifecycle rules are unchanged)
    await applyMonitorOp(runner, owner, row.id, { op: 'pause' });
  });

  it('AI parity: monitor.manage rename (executor and chat turn) is the same owner + row-version CAS rule as the UI route', async () => {
    const { owner, store, row, run } = await install();
    const titleOf = async () => (await store.get<{ title: string; rowVersion: number }>('tool_executions', row.id))!;
    const v0 = (await titleOf()).rowVersion;
    expect(await run('monitor.manage', { monitor: row.id, operation: 'rename', title: 'ยอดขายตะวันออก' })).toMatchObject({ outcome: 'updated' });
    expect(await titleOf()).toMatchObject({ title: 'ยอดขายตะวันออก', rowVersion: v0 + 1 });
    // From chat (scripted fixture with the MONITORS server id): the write lands with the turn's completion transaction.
    const reply = await fixture.service.turn(owner, 'Rename my monitor to East watch.');
    expect(reply.message).toContain('East watch');
    expect(await titleOf()).toMatchObject({ title: 'East watch', rowVersion: v0 + 2 });
    const audit = (await store.list<{ category: string; summary: string; actionId?: string }>('audit_events')).filter(e => e.category === 'monitor_manage');
    expect(audit.map(e => `${e.summary}:${e.actionId}`)).toEqual([`monitor.rename:${row.id}`, `monitor.rename:${row.id}`]);
    // An unknown id is refused by the same rule (nothing changes).
    expect(await run('monitor.manage', { monitor: 'monitor:nope', operation: 'rename', title: 'x' })).toMatchObject({ outcome: 'denied', code: 'monitor_not_found' });
    expect((await titleOf()).title).toBe('East watch');
  });

  it('rename refuses another owner, a deleted or unknown Monitor (404) and an empty or oversized title; the schema is strict', async () => {
    const { owner, runner, store, row } = await install();
    await expect(renameMonitor(store, clock, actors.east, row.id, { op: 'rename', title: 'ของฉัน' })).rejects.toMatchObject({ status: 404 });
    await expect(renameMonitor(store, clock, owner, 'monitor:nope', { op: 'rename', title: 'x' })).rejects.toMatchObject({ status: 404 });
    await expect(renameMonitor(store, clock, owner, row.id, { op: 'rename', title: '   ' })).rejects.toBeTruthy();
    await expect(renameMonitor(store, clock, owner, row.id, { op: 'rename', title: 'x'.repeat(121) })).rejects.toBeTruthy();
    expect(monitorRenameSchema.safeParse({ op: 'rename', title: 'a', extra: 1 }).success).toBe(false);
    expect((await listOwnedMonitors(store, owner))[0]!.title).toBe(row.title);
    await applyMonitorOp(runner, owner, row.id, { op: 'delete', confirmDelete: true });
    await expect(renameMonitor(store, clock, owner, row.id, { op: 'rename', title: 'หลังลบ' })).rejects.toMatchObject({ status: 404 });
  });
});
