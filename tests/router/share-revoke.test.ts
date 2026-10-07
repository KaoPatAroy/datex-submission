import { describe, expect, it, vi } from 'vitest';
import { actionRegistry } from '@/lib/router/action-registry';
import { confirmProposal, executeActionStep, type ActionExecutorInput } from '@/lib/router/executors/action';
import { buildPlannerContext } from '@/lib/router/context/build-context';
import { createSemanticCatalog } from '@/lib/dynamic/catalog/semantic';
import { actors } from '../helpers/workspace';
import { eastActor, fakePorts, grounded, NOW, CONVERSATION, TURN } from './executors/action-fixtures';
import { contextFor, fromContext, inputFor, plan } from './fixtures';
import { validateTurnPlan } from '@/lib/router/validate';
import type { Actor, Store } from '@/lib/contracts';
import { matchesRowFilter } from '@/lib/storage/filters';
import { createActionPorts } from '@/lib/router/ports/service-ports';
import type { EffectFence } from '@/lib/router/executors/action-ports';

const actor = eastActor();
const base = (step: ActionExecutorInput['step'], ports = fakePorts()) => ({ ports: ports.ports, actor, conversationId: CONVERSATION, turnId: TURN, now: NOW, step });
const grants = [{ dashboardId: 'D1', shareId: 'SH1', recipientId: 'east', recipientName: 'East Manager', createdAt: '2026-10-06T00:00:00.000Z' }];

describe('dashboard.revoke_share', () => {
  it('is a registered confirm action grounded in a server-listed active grant', () => {
    expect(actionRegistry.get('dashboard.revoke_share')).toMatchObject({ riskTier: 'confirm', requiredPermissions: ['sales.read'] });
    expect(actionRegistry.describeFor({ permissions: actor.permissions }).some(a => a.actionId === 'dashboard.revoke_share')).toBe(true);
  });

  it('previews the exact selected grant, revokes only after confirmation, and remains idempotent', async () => {
    const revoked: string[] = [];
    const passedOptions: { fence?: EffectFence }[] = [];
    const f = fakePorts();
    const ports = createActionPorts({ ...f.ports,
      dashboardShares: async (_actor, id) => id === 'D1' ? grants : [],
      revokeDashboardShare: async (_actor, dashboardId, shareId, options) => { revoked.push(`${dashboardId}:${shareId}`); passedOptions.push(options ?? {}); return { shareId, alreadyRevoked: revoked.length > 1 }; },
    });
    const step = grounded('dashboard.revoke_share', { dashboard: 'D1', shareId: 'SH1' });
    const preview = await executeActionStep(base(step, { ports, state: f.state }));
    expect(preview).toMatchObject({ outcome: 'proposed', actionId: 'dashboard.revoke_share' });
    if (preview.outcome !== 'proposed') return;
    expect(preview.preview).toContain('East Manager');
    expect(revoked).toEqual([]);
    expect(await confirmProposal({ ports, actor, proposalId: preview.ids.pendingActionId!, now: NOW })).toMatchObject({ outcome: 'executed', verified: true });
    expect(revoked).toEqual(['D1:SH1']);
    expect(passedOptions[0]?.fence).toEqual(expect.any(Function));
  });

  it('reports a grant that was already revoked between preview and confirmation', async () => {
    const f = fakePorts({ dashboardShares: async () => grants,
      revokeDashboardShare: async (_actor, _dashboardId, shareId) => ({ shareId, alreadyRevoked: true }) });
    const preview = await executeActionStep(base(grounded('dashboard.revoke_share', { dashboard: 'D1', shareId: 'SH1' }), f));
    if (preview.outcome !== 'proposed') throw new Error('expected proposal');
    expect(await confirmProposal({ ports: f.ports, actor, proposalId: preview.ids.pendingActionId!, now: NOW }))
      .toMatchObject({ outcome: 'executed', verified: true, text: expect.stringContaining('ถูกเพิกถอนไปแล้ว') });
  });

  it('fails truthfully when share lookup fails; never turns a read error into no shares', async () => {
    const f = fakePorts({ dashboardShares: async () => { throw new Error('projection unavailable'); }, revokeDashboardShare: async () => ({ shareId: 'SH1', alreadyRevoked: false }) });
    await expect(executeActionStep(base(grounded('dashboard.revoke_share', { dashboard: 'D1', shareId: 'SH1' }), f))).rejects.toThrow('projection unavailable');
    expect(f.state.staged.size).toBe(0);
  });

  it('rejects a share id outside the server-resolved active shares for that Dashboard', async () => {
    const f = fakePorts({ dashboardShares: async () => grants, revokeDashboardShare: async () => ({ shareId: 'OTHER', alreadyRevoked: false }) });
    const result = await executeActionStep(base(grounded('dashboard.revoke_share', { dashboard: 'D1', shareId: 'OTHER' }), f));
    expect(result).toMatchObject({ outcome: 'denied', code: 'share_not_active' });
    expect(f.state.staged.size).toBe(0);
  });

  it('accepts the canonical server-listed ids through plan validation and stages that exact grant', async () => {
    const context = contextFor('east_manager', { dashboardShares: grants });
    const raw = plan({ kind: 'action', actionId: 'dashboard.revoke_share', params: { dashboard: fromContext('D1'), shareId: fromContext('SH1') } });
    const validated = validateTurnPlan(inputFor(raw, 'east_manager', { context }));
    expect(validated.outcome).toBe('accepted');
    if (validated.outcome !== 'accepted') return;
    const f = fakePorts({ dashboardShares: async (_actor, id) => id === 'D1' ? grants : [], revokeDashboardShare: async (_actor, _id, shareId) => ({ shareId, alreadyRevoked: false }) });
    expect(await executeActionStep(base(validated.steps[0]!, f)).then(result => result.outcome)).toBe('proposed');
  });

  it('asks for a canonical grant when the planner invents an id or pairs it with another Dashboard', () => {
    for (const dashboardShares of [grants, [{ ...grants[0]!, dashboardId: 'OTHER' }]]) {
      const shareId = dashboardShares === grants ? 'INVENTED' : 'SH1';
      const context = contextFor('east_manager', { dashboardShares });
      const raw = plan({ kind: 'action', actionId: 'dashboard.revoke_share', params: { dashboard: fromContext('D1'), shareId: fromContext(shareId) } });
      expect(validateTurnPlan(inputFor(raw, 'east_manager', { context }))).toMatchObject({ outcome: 'clarify', code: 'unknown_context_id' });
    }
  });

  it('createActionPorts forwards the share read and the transactional confirmation fence', async () => {
    const f = fakePorts();
    const calls: unknown[] = [];
    const ports = createActionPorts({ ...f.ports,
      dashboardShares: async () => grants,
      revokeDashboardShare: async (_actor, _dashboardId, shareId, options) => { calls.push(options); return { shareId, alreadyRevoked: false }; },
    });
    const fence: EffectFence = async () => {};
    expect(await ports.dashboardShares?.(actor, 'D1')).toEqual(grants);
    await ports.revokeDashboardShare?.(actor, 'D1', 'SH1', { fence });
    expect(calls).toEqual([{ fence }]);
  });
});

const NOW_MS = Date.parse('2026-10-06T05:00:00.000Z');
function memoryStore(): Store {
  const tables = new Map<string, Map<string, unknown>>();
  const t = (name: string) => tables.get(name) ?? tables.set(name, new Map()).get(name)!;
  const reader = {
    list: async (table: string, filter?: unknown) => [...t(table).values()].filter(r => matchesRowFilter(r, filter)),
    get: async (table: string, id: string) => t(table).get(id),
  };
  return { adapter: 'sqlite', ...reader,
    transaction: async (work: (tx: never) => Promise<unknown>) => work({ ...reader, put: async (table: string, row: { id: string }) => { t(table).set(row.id, structuredClone(row)); }, remove: async (table: string, id: string) => { t(table).delete(id); } } as never),
  } as unknown as Store;
}

it('buildPlannerContext scopes outgoing shares and degrades provider errors without claiming none', async () => {
  const store = memoryStore();
  await store.transaction(async tx => {
    await tx.put('profiles', { ...actors.east, sessionId: actor.sessionId });
    await tx.put('profiles', actors.executive);
    await tx.put('dashboards', { id: 'D1', ownerId: 'east', spec: { title: 'East dashboard' }, createdAt: 'x', updatedAt: '2026-10-05T00:00:00Z' });
  });
  const args = {
    store, actor: { ...actors.east, sessionId: actor.sessionId } as Actor, conversationId: 'c1', businessDate: '2026-10-06',
    catalog: createSemanticCatalog([{ id: 'E02', name: 'East Two', region: 'east' }]), registry: actionRegistry,
    recipientAllowed: async () => true, now: () => NOW_MS,
  };
  const selected = { dashboards: [{ id: 'D1', title: 'East dashboard' }] };
  const ctx = await buildPlannerContext({ ...args, selected, dashboardShares: async () => grants });
  expect(ctx.dashboardShares).toEqual(grants);
  const { buildTurnPlannerInput } = await import('@/lib/router/planner/input');
  const plannerInput = buildTurnPlannerInput(contextFor('east_manager', { dashboardShares: grants }), { current: 'revoke the active share' });
  expect(plannerInput.prompt).toContain('DASHBOARD_SHARES=[{"dashboardId":"D1","shareId":"SH1"');
  expect(plannerInput.prompt).toContain('PENDING_ACTIONS are unconfirmed proposals, never active shares');
  const failed = await buildPlannerContext({ ...args, selected, dashboardShares: async () => { throw new Error('projection unavailable'); } });
  expect(failed.dashboardSharesUnavailable).toEqual(['D1']);
  expect(buildTurnPlannerInput(failed, { current: 'unrelated sales question' }).prompt).toContain('shares unavailable for');
  const irrelevant = vi.fn(async () => grants);
  await buildPlannerContext({ ...args, dashboardShares: irrelevant });
  expect(irrelevant).not.toHaveBeenCalled();
  const selectedIds: string[] = [];
  await buildPlannerContext({ ...args, selected: { dashboards: [{ id: 'D99', title: 'Older selected dashboard' }] }, dashboardShares: async (_actor, id) => { selectedIds.push(id); return []; } });
  expect(selectedIds).toContain('D99');
  const batch = vi.fn(async () => ({ shares: grants, unavailableDashboardIds: ['D99'] }));
  const grouped = await buildPlannerContext({ ...args, selected: { dashboards: [{ id: 'D1', title: 'East' }, { id: 'D99', title: 'Deleted' }] }, dashboardShareGroups: batch });
  expect(batch).toHaveBeenCalledTimes(1);
  expect(batch).toHaveBeenCalledWith(args.actor, ['D1', 'D99']);
  expect(grouped.dashboardShares).toEqual(grants);
  expect(grouped.dashboardSharesUnavailable).toEqual(['D99']);
});

it('marks oversized active share context as truncated instead of rejecting the planner turn', async () => {
  const { buildTurnPlannerInput } = await import('@/lib/router/planner/input');
  const many = Array.from({ length: 25 }, (_, i) => ({ ...grants[0]!, shareId: `SH${i}`, recipientId: `recipient${i}`, recipientName: 'A long human directory label '.repeat(12) }));
  const input = buildTurnPlannerInput(contextFor('east_manager', { dashboardShares: many }), { current: 'show sales' });
  expect(input.prompt).toContain('"truncated":true');
  expect(input.prompt).toContain('SH0');
  expect(input.inputBytes).toBeLessThan(76_000);
});

it('metadata-only share truncation stays unavailable and never claims more grants exist', async () => {
  const { buildTurnPlannerInput } = await import('@/lib/router/planner/input');
  const ids = Array.from({ length: 20 }, (_, i) => `D${i}`.padEnd(160, 'x'));
  const input = buildTurnPlannerInput(contextFor('east_manager', { dashboardShares: [], dashboardSharesFor: ids, dashboardSharesUnavailable: ids }), { current: 'show sales' });
  const line = input.prompt.split('\n').find(line => line.startsWith('DASHBOARD_SHARES='))!;
  const block = JSON.parse(line.slice('DASHBOARD_SHARES='.length));
  expect(block).toMatchObject({ shares: [], unavailableDashboardCount: 20, truncated: true });
  expect(block['shares unavailable for']).toEqual(ids);
  expect(Buffer.byteLength(line.slice('DASHBOARD_SHARES='.length))).toBeLessThanOrEqual(4096);
  expect(input.prompt).toContain('context is incomplete');
  expect(input.prompt.includes('grant existence unknown')).toBe(true);
  expect(input.prompt).not.toContain('means more grants exist');
});
