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
import { applyMonitorOp, renameMonitor } from '@/lib/monitors/direct';
import type { DeferredWrite } from '@/lib/router/executors/action-ports';
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
  return { owner, runner, store, row: row!, run, effects };
}


const revoke = (store: Fixture['store'], permission: string) => store.transaction(async tx => {
  const profile = (await tx.get<Profile>('profiles', 'executive'))!;
  await tx.put('profiles', { ...profile, permissions: profile.permissions.filter(p => p !== permission) });
});
const titleOf = async (store: Fixture['store'], owner: Actor) => (await listOwnedMonitors(store, owner))[0]!.title;

/** FW-B: monitor.manage needs sales.read + dashboard.create; the FINAL actor is reauthorized inside the mutation transaction (route and chat). */
describe('Monitor rename / pause / resume reauthorize the final actor', { timeout: 60_000 }, () => {
  it.each(['sales.read', 'dashboard.create'])('direct route rename is refused (403) once %s is revoked, and the title is untouched', async permission => {
    const { owner, store, row } = await install();
    await revoke(store, permission);
    await expect(renameMonitor(store, clock, owner, row.id, { op: 'rename', title: 'ชื่อใหม่' })).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(await titleOf(store, owner)).toBe(row.title);
  });

  it.each(['pause', 'resume'] as const)('direct route %s is refused (403) once dashboard.create is revoked, and nothing changes', async op => {
    const { owner, runner, store, row } = await install();
    if (op === 'resume') await applyMonitorOp(runner, owner, row.id, { op: 'pause' });
    const before = (await listOwnedMonitors(store, owner))[0]!;
    await revoke(store, 'dashboard.create');
    await expect(applyMonitorOp(runner, owner, row.id, { op })).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect((await listOwnedMonitors(store, owner))[0]).toMatchObject({ rowVersion: before.rowVersion, status: before.status });
  });

  it('chat rename: a permission revoked between the precheck and the deferred completion write rolls the write back', async () => {
    const { owner, store, row, effects } = await install();
    const writes: DeferredWrite[] = [];
    expect(await effects.renameMonitor!(owner, { monitorId: row.id, title: 'ชื่อจากแชท' }, { defer: { push: w => { writes.push(w); } } })).toMatchObject({ ok: true });
    await revoke(store, 'sales.read');
    await expect(store.transaction(async tx => { for (const w of writes) await w(tx, owner); })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await titleOf(store, owner)).toBe(row.title);
  });

  it.each(['pause', 'resume'] as const)('chat %s: a permission revoked before the deferred completion write rolls the write back', async op => {
    const { owner, runner, store, row, effects } = await install();
    if (op === 'resume') await applyMonitorOp(runner, owner, row.id, { op: 'pause' });
    const before = (await listOwnedMonitors(store, owner))[0]!;
    const writes: DeferredWrite[] = [];
    expect(await effects.manageMonitor!(owner, { monitorId: row.id, op }, { defer: { push: w => { writes.push(w); } } })).toMatchObject({ ok: true });
    await revoke(store, 'dashboard.create');
    await expect(store.transaction(async tx => { for (const w of writes) await w(tx, owner); })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await listOwnedMonitors(store, owner))[0]).toMatchObject({ rowVersion: before.rowVersion, status: before.status });
  });

  it('chat pause with the grant already gone is refused up front (forbidden), and an owner can still delete their own Monitor', async () => {
    const { owner, runner, store, row, effects } = await install();
    await revoke(store, 'dashboard.create');
    expect(await effects.manageMonitor!(owner, { monitorId: row.id, op: 'pause' })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await runner.manage(owner, { monitorId: row.id, op: 'delete' })).toMatchObject({ ok: true });
  });
});
