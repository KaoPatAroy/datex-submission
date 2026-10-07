import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Badge } from '../lib/contracts';
vi.mock('server-only', () => ({}));
import { createSeedData } from '../lib/seed/generate';
import { persistWorkflowV2DemoQueue, persistWorkflowV2SeedPlan, prepareWorkflowV2SeedPlan } from '../lib/seed/workflow-v2';
import { createSupabaseStoreFromClient } from '../lib/storage/supabase';
import { getWorkflowProjection } from '../lib/storage/workflow-projections';
import { CountingSupabaseClient, asSupabaseClient } from './helpers/counting-supabase';

describe('hosted V2 cold-instance readiness budget', () => {
  const plan = prepareWorkflowV2SeedPlan(createSeedData('2026-10-01'), { seed: 1, businessDate: '2026-10-01' });
  let canonical: CountingSupabaseClient;
  let client: CountingSupabaseClient;
  beforeAll(async () => {
    canonical = new CountingSupabaseClient();
    const store = createSupabaseStoreFromClient(asSupabaseClient(canonical));
    expect((await persistWorkflowV2SeedPlan({ store }, plan)).state).toBe('source_ready');
  });
  beforeEach(() => {
    client = new CountingSupabaseClient();
    client.revision = canonical.revision;
    for (const [table, rows] of canonical.rows) client.rows.set(table, structuredClone(rows));
  });
  it('validates an already seeded database in batches instead of re-probing each natural key', async () => {
    const store = createSupabaseStoreFromClient(asSupabaseClient(client));
    const second = await persistWorkflowV2SeedPlan({ store }, plan);
    expect(second.state, JSON.stringify(second)).toBe('source_ready');
    expect(second.sourcePhases.every(phase => phase.inserted === 0)).toBe(true);
    console.info(`HTTP bootstrap ready: ${client.reads.length}`);
    // The fixture contains tens of thousands of source rows; the adapter's bounded
    // 100-ID HTTPS chunks still apply. One validation pass and one revision pair.
    expect(client.reads.length).toBeLessThanOrEqual(300);
    expect(client.reads.filter(read => read.table === 'appmeta')).toHaveLength(2);
    expect(client.rpcCalls).toHaveLength(0);
  });
  it('does not treat a conflicting persisted source as ready or overwrite it', async () => {
    const row = client.rows.get('branches')![0]!;
    row.payload = { ...row.payload as object, name: 'conflicting branch' };
    const store = createSupabaseStoreFromClient(asSupabaseClient(client));
    const result = await persistWorkflowV2SeedPlan({ store }, plan);
    expect(result.state).toBe('seed_plan_conflict');
    expect(result.bootstrapReady).toBe(false);
    expect(client.rpcCalls).toHaveLength(0);
  });
  it('rejects an off-plan natural-key conflict even when all planned rows and certificates are current', async () => {
    const rows = client.rows.get('workflow_teams')!;
    const bodyColumn = getWorkflowProjection('workflow_teams').bodyColumn;
    const foreign = structuredClone(rows[0]);
    foreign.id = 'foreign-team-same-seed-name';
    foreign[bodyColumn] = { ...foreign[bodyColumn] as object, id: foreign.id };
    rows.push(foreign);
    const store = createSupabaseStoreFromClient(asSupabaseClient(client));
    const result = await persistWorkflowV2SeedPlan({ store }, plan);
    expect(result).toMatchObject({ state: 'seed_plan_conflict', bootstrapReady: false, blockedTables: ['workflow_teams'] });
    expect(client.rpcCalls).toHaveLength(0);
    expect(client.rows.get('workflow_teams')!.some(row => row.id === foreign.id)).toBe(true);
  });
  it('resumes an incomplete phase certificate through the guarded path while preserving evolved native badge versions', async () => {
    const store = createSupabaseStoreFromClient(asSupabaseClient(client));
    const badge = (await store.list<Badge>('mock_badges')).find(row => row.state === 'active')!;
    const evolved = { ...badge, state: 'revoked', version: badge.version + 1, operationKey: 'confirmed-badge-write', updatedAt: '2026-10-07T05:00:00.000Z' };
    await store.transaction(tx => tx.put('mock_badges', evolved));
    const ledgers = client.rows.get('audit_events')!;
    const ledger = ledgers.find(row => (row.payload as { targetRefs?: { table: string }[] }).targetRefs?.some(ref => ref.table === 'mock_badges'))!;
    client.rows.set('audit_events', ledgers.filter(row => row.id !== ledger.id));
    const commits = client.rpcCalls.length;
    const result = await persistWorkflowV2SeedPlan({ store }, plan);
    expect(result.state).toBe('source_ready');
    expect(result.sourcePhases.some(phase => phase.ledgerInserted)).toBe(true);
    expect(client.rows.get('audit_events')!.some(row => row.id === ledger.id)).toBe(true);
    expect(await store.workflowProjectionReader.get('mock_badges', badge.id)).toMatchObject({ rowVersion: 2, body: evolved });
    expect(client.rpcCalls.slice(commits).flatMap(call => (call.args.operations ?? []) as { table: string }[]).some(op => op.table === 'mock_badges')).toBe(false);
  });
  it('rejects authority and unbound source drift despite higher native versions and completed certificates', async () => {
    const store = createSupabaseStoreFromClient(asSupabaseClient(client));
    const profile = client.rows.get('profiles')!.find(row => row.id === 'executive')!.payload as { id: string; active: boolean; permissions: string[] };
    const inventory = client.rows.get('inventory_snapshots')![0]!.payload as { id: string; onHand: number };
    await store.transaction(async tx => {
      await tx.put('profiles', { ...profile, active: false, permissions: [] });
      await tx.put('inventory_snapshots', { ...inventory, onHand: 999, updatedAt: '2026-10-07T04:00:00Z', operationKey: 'authorized-demo-operation' });
    });
    client.rpcCalls.length = 0;
    const result = await persistWorkflowV2SeedPlan({ store }, plan);
    expect(result).toMatchObject({ state: 'seed_plan_conflict', bootstrapReady: false });
    expect(result.blockedTables).toEqual(expect.arrayContaining(['profiles', 'inventory_snapshots']));
    expect((await store.get<{ active: boolean }>('profiles', 'executive'))!.active).toBe(false);
    expect((await store.get<{ onHand: number }>('inventory_snapshots', inventory.id))!.onHand).toBe(999);
    expect(client.rpcCalls).toHaveLength(0);
  });
  it('fails closed on a present profile with malformed authority fields', async () => {
    const profile = client.rows.get('profiles')!.find(row => row.id === 'executive')!;
    profile.payload = { ...profile.payload as object, active: 'false', permissions: 'sales.read', regions: '*' };
    const store = createSupabaseStoreFromClient(asSupabaseClient(client));
    await expect(persistWorkflowV2SeedPlan({ store }, plan)).rejects.toHaveProperty('code', 'STORAGE');
    expect(client.rpcCalls).toHaveLength(0);
  });
  it('keeps demo queue revalidation bounded without claiming an unverified advancement succeeded', async () => {
    const store = createSupabaseStoreFromClient(asSupabaseClient(client));
    await persistWorkflowV2DemoQueue({ store }, plan, { advance: false });
    client.reads.length = 0;
    client.rpcCalls.length = 0;
    const result = await persistWorkflowV2DemoQueue({ store }, plan, { advance: true });
    expect(result.state).toBe('runtime_unverified');
    expect(result.directorQueueRequestIds).toHaveLength(0);
    expect(client.reads.length).toBeLessThanOrEqual(12);
    expect(client.rpcCalls).toHaveLength(0);
  });
});
