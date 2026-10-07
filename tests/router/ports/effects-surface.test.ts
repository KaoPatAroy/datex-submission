import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { Store } from '@/lib/contracts';
import { actionRegistry } from '@/lib/router/action-registry';
import { executeActionStep } from '@/lib/router/executors/action';
import type { EffectBindings } from '@/lib/router/executors/action-ports';
import { baseOperationKey, commitInboxRecords, listInbox, recipientOperationKey, sentInboxRecords } from '@/lib/router/ports/effect-store';
import { createSqliteStore } from '@/lib/storage/sqlite';
import { validateTurnPlan } from '@/lib/router/validate';
import { snapshotRef } from '@/lib/effects/shared';
import { actors } from '../../helpers/workspace';
import { contextFor, inputFor, plan } from '../fixtures';
import { eastActor, fakePorts, grounded, NOW } from '../executors/action-fixtures';

afterEach(() => vi.unstubAllEnvs());

describe('GET /api/cron/monitors protection', () => {
  const call = async (headers: Record<string, string>) => {
    const { GET } = await import('@/app/api/cron/monitors/route');
    return GET(new NextRequest('http://localhost/api/cron/monitors', { headers }));
  };
  it('fails closed without a configured secret and rejects missing or wrong credentials', async () => {
    vi.stubEnv('CRON_SECRET', '');
    expect((await call({ authorization: 'Bearer anything-at-all-123' })).status).toBe(503);
    vi.stubEnv('CRON_SECRET', 'x'.repeat(32));
    expect((await call({})).status).toBe(401);
    expect((await call({ authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await call({ 'x-cron-secret': 'y'.repeat(32) })).status).toBe(401);
  });
});

describe('simulated inbox storage', () => {
  const stores: Store[] = [];
  afterEach(() => { while (stores.length) stores.pop()?.close?.(); });
  const record = (content: string) => ({ operationKey: 'op1', planDigest: 'pd', target: snapshotRef('east', 1, {}), content, kind: 'simulated_inbox' });

  it('is idempotent per operation + recipient, rejects a conflicting replay, and is actor-scoped on read', async () => {
    const store = createSqliteStore(':memory:'); stores.push(store);
    const actor = { ...actors.executive };
    await commitInboxRecords(store, actor, [record('hello 1')], { now: new Date(1), title: 't' });
    await commitInboxRecords(store, actor, [record('hello 1')], { now: new Date(2), title: 't' });
    expect(await listInbox(store, actors.east)).toHaveLength(1);
    await expect(commitInboxRecords(store, actor, [record('different')], { now: new Date(3), title: 't' })).rejects.toMatchObject({ code: 'INBOX_CONFLICT' });
    expect(await listInbox(store, actors.executive)).toHaveLength(0);
    expect(await listInbox(store, actors.hr)).toHaveLength(0);
  });

  it('stores a distinct per-recipient operationKey (PostgreSQL mock_message_operation_unique) and maps it back to the base key', async () => {
    const store = createSqliteStore(':memory:'); stores.push(store);
    const actor = { ...actors.executive };
    const both = [record('hello'), { ...record('hello'), target: snapshotRef('hr', 1, {}) }];
    await commitInboxRecords(store, actor, both, { now: new Date(1), title: 't' });
    await commitInboxRecords(store, actor, both, { now: new Date(2), title: 't' });
    const keys = (await store.list<{ operationKey: string }>('mock_messages')).map(m => m.operationKey);
    expect(keys.sort()).toEqual(['op1:east', 'op1:hr']);
    expect((await sentInboxRecords(store, actor)).map(r => r.operationKey)).toEqual(['op1', 'op1']);
    // Rows written before the per-recipient key keep their bare key; an over-long recipient id is digested and still round-trips.
    expect(baseOperationKey({ operationKey: 'op1', recipientId: 'east' })).toBe('op1');
    const longId = 'r'.repeat(190), longKey = recipientOperationKey('op1', longId);
    expect(longKey.length).toBeLessThanOrEqual(200);
    expect(baseOperationKey({ operationKey: longKey, recipientId: longId })).toBe('op1');
  });
});

describe('monitor.manage (registered, direct, owner-private)', () => {
  const effects = (manage: EffectBindings['manageMonitor']): EffectBindings =>
    ({ communication: async () => undefined, monitor: async () => undefined, commitInbox: async () => undefined, commitMonitor: async () => undefined, manageMonitor: manage });
  const run = (ports: ReturnType<typeof fakePorts>['ports'], operation: string) =>
    executeActionStep({ ports, actor: eastActor(), step: grounded('monitor.manage', { monitor: 'monitor:M1', operation }), conversationId: 'c', turnId: 't', now: NOW });

  it('is a direct-tier action requiring monitor grants and applies the owner operation', async () => {
    expect(actionRegistry.get('monitor.manage')).toMatchObject({ riskTier: 'direct', requiredPermissions: ['sales.read', 'dashboard.create'] });
    const manage = vi.fn(async (_a, input) => ({ ok: true as const, text: `ok ${input.op}` }));
    const f = fakePorts({ effects: effects(manage) });
    expect(await run(f.ports, 'pause')).toMatchObject({ outcome: 'updated', text: 'ok pause', undo: null });
    expect(manage).toHaveBeenCalledWith(expect.objectContaining({ id: 'east_manager' }), { monitorId: 'monitor:M1', op: 'pause' });
    expect(await run(f.ports, 'explode')).toMatchObject({ outcome: 'clarify', code: 'operation_missing' });
  });
  it('reports a denial from the owner check and is disabled without the effects layer', async () => {
    const f = fakePorts({ effects: effects(async () => ({ ok: false, code: 'monitor_not_found', text: 'ไม่พบ' })) });
    expect(await run(f.ports, 'delete')).toMatchObject({ outcome: 'denied', code: 'monitor_not_found' });
    const off = fakePorts();
    expect(await run({ ...off.ports, effects: undefined }, 'pause')).toMatchObject({ outcome: 'denied', code: 'effects_disabled' });
  });
  it('the validator only accepts monitor ids present in the planner context', () => {
    const permissions = ['sales.read', 'operations.read', 'dashboard.create', 'dashboard.share'];
    const raw = plan({ kind: 'action', actionId: 'monitor.manage', params: {
      monitor: { value: 'monitor:M1', source: 'context_id' }, operation: { value: 'pause', source: 'generated' } } });
    const withMonitor = inputFor(raw, 'executive');
    withMonitor.context = contextFor('executive', { actions: actionRegistry.describeFor({ permissions }), monitors: [{ id: 'monitor:M1', title: 'm', status: 'monitor_active' }] });
    expect(validateTurnPlan(withMonitor).outcome).toBe('accepted');
    const without = inputFor(raw, 'executive');
    without.context = contextFor('executive', { actions: actionRegistry.describeFor({ permissions }) });
    expect(validateTurnPlan(without).outcome).not.toBe('accepted');
  });
});
