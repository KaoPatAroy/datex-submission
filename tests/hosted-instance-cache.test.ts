import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowStoreCapability } from '../lib/storage/workflow-projections';
const harness = vi.hoisted(() => ({ persist: vi.fn(), factory: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('../lib/storage/supabase', async original => ({ ...await original<typeof import('../lib/storage/supabase')>(), createSupabaseStore: harness.factory }));
vi.mock('../lib/seed/workflow-v2', async original => ({ ...await original<typeof import('../lib/seed/workflow-v2')>(), persistWorkflowV2SeedPlan: harness.persist }));
const ready = { state: 'source_ready', sourcePhasesComplete: true, bootstrapReady: true, seedVersion: 2, businessDate: '2026-10-01', seed: 1, inputDigest: 'ready' };
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-07T04:00:00Z'));
  vi.stubEnv('USE_LOCAL_DEMO_DATA', 'false');
  vi.stubEnv('WORKFLOW_V2_ENABLED', 'true');
  vi.stubEnv('WORKFLOW_V2_DEMO_QUEUE', 'false');
  vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'fake-service-role');
  harness.factory.mockReset().mockImplementation(() => ({ adapter: 'supabase', list: vi.fn(async () => [{ id: 'executive' }]), get: vi.fn(), transaction: vi.fn(),
    workflowContractVersion: 2, workflowProjectionReader: { get: vi.fn(), query: vi.fn() }, workflowTransaction: vi.fn() }));
  harness.persist.mockReset().mockResolvedValue(ready);
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); vi.resetModules(); });
describe('per-instance bootstrap readiness cache', () => {
  it.each(['failed get', 'empty get', 'empty list', 'failed snapshot', 'empty projection'] as const)(
    'evicts warm initialization after %s', async failure => {
      const { getStore } = await import('../lib/storage');
      const first = await getStore();
      const raw = harness.factory.mock.results[0]!.value;
      if (failure === 'failed get') {
        raw.get.mockRejectedValueOnce(new Error('database read failed'));
        await expect(first.get('profiles', 'executive')).rejects.toThrow('database read failed');
      } else if (failure === 'empty get') {
        raw.get.mockResolvedValueOnce(undefined);
        await expect(first.get('profiles', 'executive')).resolves.toBeUndefined();
      } else if (failure === 'empty list') {
        raw.list.mockResolvedValueOnce([]);
        await expect(first.list('profiles')).resolves.toEqual([]);
      } else if (failure === 'failed snapshot') {
        const { markStorageFailure } = await import('../lib/storage/read-error');
        raw.readSnapshot = vi.fn(async () => { throw markStorageFailure(new Error('unstable database read'), { table: 'appmeta', databaseCode: '57014' }); });
        await expect(first.readSnapshot!(() => Promise.resolve())).rejects.toThrow('unstable database read');
      } else {
        raw.workflowProjectionReader.query.mockResolvedValueOnce([]);
        await expect((first as typeof first & WorkflowStoreCapability).workflowProjectionReader.query({ kind: 'ids', table: 'profiles', ids: ['executive'] })).resolves.toEqual([]);
      }
      expect(await getStore()).not.toBe(first);
      expect(harness.persist).toHaveBeenCalledTimes(2);
    }
  );
  it('retains warm readiness for legitimate empty scoped reads and ordinary domain failures', async () => {
    const { getStore } = await import('../lib/storage');
    const { DomainError } = await import('../lib/core/errors');
    const first = await getStore();
    const raw = harness.factory.mock.results[0]!.value;
    raw.list.mockResolvedValueOnce([]);
    raw.get.mockResolvedValueOnce(undefined);
    raw.workflowProjectionReader.query.mockResolvedValueOnce([]);
    await expect(first.list('mock_messages', { recipientId: 'executive' })).resolves.toEqual([]);
    await expect(first.get('dashboards', 'absent-optional-dashboard')).resolves.toBeUndefined();
    await expect((first as typeof first & WorkflowStoreCapability).workflowProjectionReader.query({ kind: 'scoped', table: 'responsibilities', ownerId: 'executive', limit: 10 })).resolves.toEqual([]);
    raw.transaction.mockImplementation(async (work: (tx: object) => Promise<unknown>) => work({}));
    await expect(first.transaction(async () => { throw new DomainError('FORBIDDEN', 'denied', 403); })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    raw.readSnapshot = vi.fn(async (work: () => Promise<unknown>) => work());
    await expect(first.readSnapshot!(async () => { throw new DomainError('NOT_FOUND', 'absent', 404); })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await getStore()).toBe(first);
    expect(harness.persist).toHaveBeenCalledTimes(1);
  });
  it('coalesces concurrent initialization, serves warm requests, then revalidates after five minutes', async () => {
    const { getStore } = await import('../lib/storage');
    const stores = await Promise.all([getStore(), getStore(), getStore()]);
    expect(stores[0]).toBe(stores[1]);
    await getStore();
    expect(harness.persist).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date('2026-10-07T04:05:01Z'));
    expect(await getStore()).not.toBe(stores[0]);
    expect(harness.persist).toHaveBeenCalledTimes(2);
  });
  it('invalidates readiness when the business date or feature configuration changes', async () => {
    const { getStore } = await import('../lib/storage');
    const first = await getStore();
    vi.stubEnv('DEMO_BUSINESS_DATE', '2026-10-02');
    expect(await getStore()).not.toBe(first);
    expect(harness.persist).toHaveBeenCalledTimes(2);
  });
  it('evicts rejected initialization so a subsequent request can initialize', async () => {
    const { getStore } = await import('../lib/storage');
    harness.persist.mockRejectedValueOnce(new Error('transient bootstrap failure'));
    await expect(getStore()).rejects.toThrow('transient bootstrap failure');
    await expect(getStore()).resolves.toHaveProperty('adapter', 'supabase');
    expect(harness.persist).toHaveBeenCalledTimes(2);
  });
  it('evicts readiness on a transaction read failure even if the callback catches it', async () => {
    const { getStore } = await import('../lib/storage');
    const first = await getStore();
    harness.factory.mock.results[0]!.value.transaction.mockImplementation(async (work: (tx: object) => Promise<unknown>) =>
      work({ get: vi.fn().mockRejectedValue(new Error('database unavailable')) }));
    await first.transaction(async tx => { await tx.get('profiles', 'executive').catch(() => undefined); });
    expect(await getStore()).not.toBe(first);
    expect(harness.persist).toHaveBeenCalledTimes(2);
  });
  it('does not let a stale instance read failure evict newer readiness', async () => {
    const { getStore } = await import('../lib/storage');
    const first = await getStore();
    const old = harness.factory.mock.results[0]!.value;
    vi.setSystemTime(new Date('2026-10-07T04:05:01Z'));
    const second = await getStore();
    old.get.mockRejectedValueOnce(new Error('old database read failed'));
    await expect(first.get('profiles', 'executive')).rejects.toThrow('old database read failed');
    expect(await getStore()).toBe(second);
    expect(harness.persist).toHaveBeenCalledTimes(2);
  });
});
