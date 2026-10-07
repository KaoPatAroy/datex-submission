import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ActionPayload, Actor, Badge, PendingAction, Receipt } from '../lib/contracts';
import { ConciergeService } from '../lib/core/service';
import { digest } from '../lib/core/utils';
import { createSeedData } from '../lib/seed/generate';
import { prepareWorkflowV2SeedPlan } from '../lib/seed/workflow-v2';
import { workflowProjectionManifest } from '../lib/storage/workflow-projections';
import type { WorkflowStorageTable } from '../lib/workflows/contracts';
import { ControlledSupabaseClient, type DatabaseRow, type ReadCall } from './helpers/controlled-supabase';

const transport = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock('server-only', () => ({}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => transport.client }));

const BUSINESS_DATE = '2026-10-01';
const NOW = '2026-10-07T05:00:00.000Z';

function pathValue(body: unknown, path: string): unknown {
  let value = body;
  for (const field of path.split('.')) value = (value as Record<string, unknown> | undefined)?.[field];
  return value;
}

// Persist controlled RPC transport responses so a fresh REAL Supabase adapter rereads the same rows.
// This exercises adapter/boot/runtime integration, not PostgreSQL constraints or trigger semantics.
class PersistingSupabaseClient extends ControlledSupabaseClient {
  private readonly byId = new Map<string, Map<string, DatabaseRow>>();
  rpcErrorFor?: (name: string, args: Record<string, unknown>) => unknown;

  clone(): PersistingSupabaseClient {
    const clone = new PersistingSupabaseClient();
    clone.revision = this.revision;
    for (const [table, rows] of this.rows) {
      const clonedRows = structuredClone(rows);
      clone.rows.set(table, clonedRows);
      clone.byId.set(table, new Map(clonedRows.map(row => [row.id, row])));
    }
    return clone;
  }

  dropPhaseCertificate(id: string): void {
    this.rows.set('audit_events', this.rows.get('audit_events')!.filter(row => row.id !== id));
    this.byId.get('audit_events')!.delete(id);
    this.revision += 1;
  }

  protected override candidateRows(call: ReadCall): readonly DatabaseRow[] {
    const ids = call.filters.find(filter => filter.column === 'id' && (filter.kind === 'eq' || filter.kind === 'in'));
    if (!ids) return super.candidateRows(call);
    return (Array.isArray(ids.value) ? ids.value : [ids.value]).flatMap(id => {
      const row = this.byId.get(call.table)?.get(String(id));
      return row ? [row] : [];
    });
  }

  override async rpc(name: string, args: Record<string, unknown>) {
    const response = await super.rpc(name, args);
    const failure = this.rpcErrorFor?.(name, args);
    if (failure) return { data: null, error: failure };
    if (response.error) return response;
    expect(Number(args.expected_revision)).toBe(this.revision);
    if (name === 'nexus_commit') {
      for (const change of args.changes as { table: WorkflowStorageTable; id: string; payload: Record<string, unknown> | null }[]) {
        const old = this.byId.get(change.table)?.get(change.id);
        if (change.payload === null) {
          this.rows.set(change.table, (this.rows.get(change.table) ?? []).filter(row => row.id !== change.id));
          this.byId.get(change.table)?.delete(change.id);
        }
        else this.put(change.table, change.payload, Number(change.payload.rowVersion ?? Number(old?.row_version ?? 0) + 1));
      }
    } else if (name === 'nexus_workflow_commit') {
      for (const operation of args.operations as { table: WorkflowStorageTable; kind: string; row?: { body: Record<string, unknown>; rowVersion: number }; next?: { body: Record<string, unknown>; rowVersion: number }; values?: Record<string, unknown> }[]) {
        const row = operation.kind === 'insert_unique' ? operation.row! : operation.next!;
        this.put(operation.table, row.body, row.rowVersion, operation.values, true);
      }
    } else throw new Error(`Unexpected controlled RPC: ${name}`);
    this.revision += 1;
    return response;
  }

  put(table: WorkflowStorageTable, body: Record<string, unknown>, rowVersion: number, values: Record<string, unknown> = {}, workflowWrite = false) {
    const definition = workflowProjectionManifest.get(table);
    const stored: DatabaseRow = { id: String(body.id), row_version: rowVersion, [definition?.bodyColumn ?? 'payload']: structuredClone(body) };
    if (definition?.storage === 'mixed') stored.workflow_contract_version = workflowWrite ? 2 : null;
    if (definition?.legacyQuarantineColumn) stored[definition.legacyQuarantineColumn] = 0;
    for (const column of definition?.columns ?? []) {
      stored[column.column] = pathValue(column.external ? values : body, column.bodyField) ?? null;
    }
    const rows = this.rows.get(table) ?? [];
    const existing = this.byId.get(table)?.get(stored.id);
    const index = existing ? rows.indexOf(existing) : -1;
    if (index < 0) rows.push(stored);
    else rows[index] = stored;
    this.rows.set(table, rows);
    const indexById = this.byId.get(table) ?? new Map<string, DatabaseRow>();
    indexById.set(stored.id, stored);
    this.byId.set(table, indexById);
  }
}

afterEach(() => {
  transport.client = undefined;
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function coldStart(client: PersistingSupabaseClient) {
  transport.client = client as unknown as SupabaseClient;
  vi.stubEnv('USE_LOCAL_DEMO_DATA', 'false');
  vi.stubEnv('WORKFLOW_V2_ENABLED', 'true');
  vi.stubEnv('WORKFLOW_V2_DEMO_QUEUE', 'true');
  vi.stubEnv('DEMO_BUSINESS_DATE', BUSINESS_DATE);
  vi.stubEnv('SUPABASE_URL', 'https://controlled-supabase.example');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'synthetic-test-service-key');
  vi.resetModules();
  const storage = await import('../lib/storage/index');
  const store = await storage.getStore();
  expect(await storage.getWorkflowV2BootstrapResult()).toMatchObject({ state: 'source_ready', bootstrapReady: true });
  return store;
}

let bootstrappedTemplate: PersistingSupabaseClient;

beforeAll(async () => {
  bootstrappedTemplate = new PersistingSupabaseClient();
  await coldStart(bootstrappedTemplate);
});

function freshBootstrappedClient(): PersistingSupabaseClient {
  return bootstrappedTemplate.clone();
}

async function actorFor(store: Awaited<ReturnType<typeof coldStart>>, profileId: string): Promise<Actor> {
  const profile = await store.get<Actor>('profiles', profileId);
  expect(profile).toBeDefined();
  const actor: Actor = { ...profile!, sessionId: `cluster-f-${profileId}`, mode: 'scripted_demo', modeRevision: 1 };
  await store.transaction(async tx => {
    await tx.put('sessions', { id: actor.sessionId, profileId, mode: actor.mode, modeRevision: 1, csrfToken: 'synthetic-csrf', expiresAt: '2099-01-01T00:00:00.000Z' });
  });
  return actor;
}

async function interruptDemoReadback(client: PersistingSupabaseClient, scenario: Extract<ActionPayload, { kind: 'demo_update' }>['scenario'] = 'stock_recovered') {
  const store = await coldStart(client);
  const actor = await actorFor(store, 'executive');
  const service = new ConciergeService(store, { businessDate: BUSINESS_DATE, now: () => new Date(NOW) });
  const pending = await service.prepare(actor, { kind: 'demo_update', scenario });
  vi.spyOn(service, 'reconcile').mockRejectedValueOnce(new Error('readback interrupted after commit'));
  await expect(service.confirm(actor, pending.id)).rejects.toThrow('readback interrupted after commit');
  return { store, actor, pending, receiptId: `execution_${pending.id}` };
}

describe('Supabase V2 bootstrap after legitimate legacy mutations', () => {
  it('pins the hosted 76e18fd seed plan digest', () => {
    const plan = prepareWorkflowV2SeedPlan(createSeedData(BUSINESS_DATE), { seed: 1, businessDate: BUSINESS_DATE });
    expect(plan.inputDigest).toBe('658556149259b9c556fa39f32c98a1ff8108bdb443e3af76deff990c0c3294c6');
  });

  it.each(['baseline', 'stock_recovered', 'payment_resolved'] as const)('cold bootstraps and reconciles a committed %s demo update after interrupted readback without replaying source writes', async scenario => {
    const client = freshBootstrappedClient();
    const { store, actor, pending, receiptId } = await interruptDemoReadback(client, scenario);
    expect(await store.get<Receipt>('action_executions', receiptId)).toMatchObject({
      status: 'pending', results: [{ targetId: 'artifact', id: expect.stringMatching(/^effect_/), executedAt: NOW, status: 'pending' }],
    });
    expect(await store.get<PendingAction>('pending_actions', pending.id)).toMatchObject({ status: 'claimed' });
    const inventory = await store.list('inventory_snapshots', { date: BUSINESS_DATE });
    const incidents = await store.list('incidents', { date: BUSINESS_DATE });
    const commits = client.rpcCalls.length;
    const restarted = await coldStart(client);
    expect(client.rpcCalls).toHaveLength(commits);
    const reconciler = new ConciergeService(restarted, { businessDate: BUSINESS_DATE, now: () => new Date('2026-10-07T06:00:00.000Z') });
    expect((await reconciler.reconcile(actor, receiptId)).status).toBe('verified_success');
    expect(await restarted.get<PendingAction>('pending_actions', pending.id)).toMatchObject({ status: 'completed' });
    expect(await restarted.list('inventory_snapshots', { date: BUSINESS_DATE })).toEqual(inventory);
    expect(await restarted.list('incidents', { date: BUSINESS_DATE })).toEqual(incidents);
    const reconciliation = client.rpcCalls.slice(commits).flatMap(call => (call.args.changes ?? []) as { table: string }[]);
    expect(reconciliation.some(change => ['inventory_snapshots', 'incidents'].includes(change.table))).toBe(false);
  }, 60_000);

  it.each([
    ['present', 'forged single row'], ['missing', 'forged single row'],
    ['present', 'restored inventory row'], ['missing', 'restored inventory row'],
    ['present', 'mismatched write timestamp'], ['missing', 'mismatched write timestamp'],
    ['present', 'extra inventory source'], ['missing', 'extra inventory source'],
  ] as const)('rejects partial pending demo effects with %s phase certificates: %s', async (certificates, partial) => {
      const client = freshBootstrappedClient();
      let store: Awaited<ReturnType<typeof coldStart>>;
      let receiptId: string;
      if (partial === 'forged single row') {
        store = await coldStart(client);
        const actor = await actorFor(store, 'executive');
        const service = new ConciergeService(store, { businessDate: BUSINESS_DATE, now: () => new Date(NOW) });
        const pending = await service.prepare(actor, { kind: 'demo_update', scenario: 'stock_recovered' });
        receiptId = `execution_${pending.id}`;
        const operationKey = `${receiptId}:artifact`;
        const baseline = createSeedData(BUSINESS_DATE).inventory_snapshots.find(row => row.date === BUSINESS_DATE && row.onHand < row.minimum)!;
        await store.transaction(async tx => {
          await tx.put('pending_actions', { ...pending, status: 'claimed' });
          await tx.put<Receipt>('action_executions', { id: receiptId, actionId: pending.id, actorId: actor.id, kind: 'demo_update', status: 'pending',
            results: [{ targetId: 'artifact', id: `effect_${digest(operationKey).slice(0, 24)}`, executedAt: NOW, status: 'pending', detail: 'Awaiting readback' }], createdAt: NOW, verifiedAt: null });
          await tx.put('inventory_snapshots', { ...baseline, onHand: Math.max(baseline.onHand, baseline.minimum + 10), operationKey, updatedAt: NOW });
        });
      } else {
        const interrupted = await interruptDemoReadback(client);
        store = interrupted.store;
        receiptId = interrupted.receiptId;
        const baseline = createSeedData(BUSINESS_DATE).inventory_snapshots.find(row => row.date === BUSINESS_DATE && row.onHand < row.minimum)!;
        const current = (await store.get<Record<string, unknown> & { id: string }>('inventory_snapshots', baseline.id))!;
        // Separate writers can persist partial or mismatched effects before a cold recovery read.
        await store.transaction(tx => tx.put('inventory_snapshots', partial === 'restored inventory row' ? baseline
          : partial === 'mismatched write timestamp' ? { ...current, updatedAt: '2026-10-07T05:00:01.000Z' }
            : { ...current, id: 'extra-inventory-source' }));
      }
      if (certificates === 'missing') {
        const ledger = client.rows.get('audit_events')!.find(row => (row.payload as { category?: string }).category === 'synthetic_workflow_v2_seed_phase')!;
        expect(ledger).toBeDefined();
        client.dropPhaseCertificate(ledger.id);
      }
      const inventory = await store.list('inventory_snapshots', { date: BUSINESS_DATE });
      const incidents = await store.list('incidents', { date: BUSINESS_DATE });
      const commits = client.rpcCalls.length;
      vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(coldStart(client), partial).rejects.toMatchObject({ code: 'WORKFLOW_UNAVAILABLE' });
      if (certificates === 'present') expect(client.rpcCalls, partial).toHaveLength(commits);
      const recoveryWrites = client.rpcCalls.slice(commits).flatMap(call => (call.args.operations ?? call.args.changes ?? []) as { table: string }[]);
      // Missing phase certificates may be restored; incomplete source effects are never rewritten.
      expect(recoveryWrites.every(write => write.table === 'audit_events')).toBe(true);
      expect(await store.get<Receipt>('action_executions', receiptId)).toMatchObject({ status: 'pending' });
      expect(await store.list('inventory_snapshots', { date: BUSINESS_DATE })).toEqual(inventory);
      expect(await store.list('incidents', { date: BUSINESS_DATE })).toEqual(incidents);
  }, 60_000);

  it.each([
    ['present', 'baseline', '1900-01-01T00:00:00.000Z'], ['missing', 'baseline', '1900-01-01T00:00:00.000Z'],
    ['present', 'stock_recovered', '1900-01-01T00:00:00.000Z'], ['missing', 'stock_recovered', '1900-01-01T00:00:00.000Z'],
    ['present', 'payment_resolved', '1900-01-01T00:00:00.000Z'], ['missing', 'payment_resolved', '1900-01-01T00:00:00.000Z'],
    ['present', 'payment_resolved', '2026-10-07T05:00:00.0005Z'],
  ] as const)('rejects uniformly rewritten source timestamps for %s certificates and %s at %s without repairing effects', async (certificates, scenario, rewrittenAt) => {
    const client = freshBootstrappedClient();
    const { store, actor, pending, receiptId } = await interruptDemoReadback(client, scenario);
    const inventory = await store.list<Record<string, unknown> & { id: string }>('inventory_snapshots', { date: BUSINESS_DATE });
    const incidents = await store.list<Record<string, unknown> & { id: string }>('incidents', { date: BUSINESS_DATE });
    expect(inventory.length).toBeGreaterThan(0);
    expect(incidents.length).toBeGreaterThan(0);
    await store.transaction(async tx => {
      for (const row of inventory) await tx.put('inventory_snapshots', { ...row, updatedAt: rewrittenAt });
      for (const row of incidents) await tx.put('incidents', {
        ...row, updatedAt: rewrittenAt, ...(scenario === 'payment_resolved' ? { endedAt: rewrittenAt } : {}),
      });
    });
    if (certificates === 'missing') {
      const ledger = client.rows.get('audit_events')!.find(row => (row.payload as { category?: string }).category === 'synthetic_workflow_v2_seed_phase')!;
      expect(ledger).toBeDefined();
      client.dropPhaseCertificate(ledger.id);
    }
    const rewrittenInventory = await store.list('inventory_snapshots', { date: BUSINESS_DATE });
    const rewrittenIncidents = await store.list('incidents', { date: BUSINESS_DATE });
    const reconciler = new ConciergeService(store, { businessDate: BUSINESS_DATE, now: () => new Date(NOW) });
    expect((await reconciler.reconcile(actor, receiptId)).status).toBe('pending');
    const receipt = await store.get<Receipt>('action_executions', receiptId);
    const commits = client.rpcCalls.length;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(coldStart(client)).rejects.toMatchObject({ code: 'WORKFLOW_UNAVAILABLE' });
    if (certificates === 'present') expect(client.rpcCalls).toHaveLength(commits);
    const recoveryWrites = client.rpcCalls.slice(commits).flatMap(call => (call.args.operations ?? call.args.changes ?? []) as { table: string }[]);
    expect(recoveryWrites.every(write => write.table === 'audit_events')).toBe(true);
    expect(await store.get<Receipt>('action_executions', receiptId)).toEqual(receipt);
    expect(await store.get<PendingAction>('pending_actions', pending.id)).toMatchObject({ status: 'claimed' });
    expect(await store.list('inventory_snapshots', { date: BUSINESS_DATE })).toEqual(rewrittenInventory);
    expect(await store.list('incidents', { date: BUSINESS_DATE })).toEqual(rewrittenIncidents);
  }, 60_000);

  it.each(['missing effect ID', 'wrong effect ID', 'actor mismatch', 'source drift'] as const)(
    'rejects interrupted demo update evolution with %s', async drift => {
      const client = freshBootstrappedClient();
      const { store, receiptId } = await interruptDemoReadback(client);
      if (drift === 'source drift') {
        const row = (await store.list<Record<string, unknown>>('inventory_snapshots', { date: BUSINESS_DATE }))[0];
        const native = client.rows.get('inventory_snapshots')!.find(record => record.id === row.id)!;
        client.put('inventory_snapshots', { ...row, onHand: Number(row.onHand) + 1 }, Number(native.row_version) + 1);
      } else {
        const receipt = (await store.get<Receipt>('action_executions', receiptId))!;
        const changed = drift === 'actor mismatch' ? { ...receipt, actorId: 'east' }
          : { ...receipt, results: [{ ...receipt.results[0], id: drift === 'missing effect ID' ? null : 'effect_unrelated' }] };
        const native = client.rows.get('action_executions')!.find(record => record.id === receiptId)!;
        client.put('action_executions', changed, Number(native.row_version) + 1);
      }
      const commits = client.rpcCalls.length;
      vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(coldStart(client)).rejects.toMatchObject({ code: 'WORKFLOW_UNAVAILABLE' });
      expect(client.rpcCalls).toHaveLength(commits);
    }, 60_000
  );

  it.each(['pending', 'verified_success'] as const)('rejects a %s demo execution with a corrupted approval hash', async status => {
    const client = freshBootstrappedClient();
    let store: Awaited<ReturnType<typeof coldStart>>, actionId: string;
    if (status === 'pending') {
      const interrupted = await interruptDemoReadback(client);
      store = interrupted.store; actionId = interrupted.pending.id;
    } else {
      store = await coldStart(client);
      const actor = await actorFor(store, 'executive');
      const service = new ConciergeService(store, { businessDate: BUSINESS_DATE, now: () => new Date(NOW) });
      const pending = await service.prepare(actor, { kind: 'demo_update', scenario: 'stock_recovered' });
      expect((await service.confirm(actor, pending.id)).status).toBe('verified_success');
      actionId = pending.id;
    }
    const action = (await store.get<PendingAction>('pending_actions', actionId))!;
    const native = client.rows.get('pending_actions')!.find(record => record.id === actionId)!;
    client.put('pending_actions', { ...action, payloadHash: 'corrupted-approval-hash' }, Number(native.row_version) + 1);
    const commits = client.rpcCalls.length;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(coldStart(client)).rejects.toMatchObject({ code: 'WORKFLOW_UNAVAILABLE' });
    expect(client.rpcCalls).toHaveLength(commits);
  }, 60_000);

  it('rejects a verified demo execution without a verification timestamp', async () => {
    const client = freshBootstrappedClient();
    const store = await coldStart(client);
    const actor = await actorFor(store, 'executive');
    const service = new ConciergeService(store, { businessDate: BUSINESS_DATE, now: () => new Date(NOW) });
    const pending = await service.prepare(actor, { kind: 'demo_update', scenario: 'stock_recovered' });
    expect((await service.confirm(actor, pending.id)).status).toBe('verified_success');
    const receiptId = `execution_${pending.id}`;
    const receipt = (await store.get<Receipt>('action_executions', receiptId))!;
    const native = client.rows.get('action_executions')!.find(record => record.id === receiptId)!;
    client.put('action_executions', { ...receipt, verifiedAt: null }, Number(native.row_version) + 1);
    const commits = client.rpcCalls.length;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(coldStart(client)).rejects.toMatchObject({ code: 'WORKFLOW_UNAVAILABLE' });
    expect(client.rpcCalls).toHaveLength(commits);
  }, 60_000);

  it.each<Extract<ActionPayload, { kind: 'demo_update' }>['scenario']>(['baseline', 'stock_recovered', 'payment_resolved'])('reaches source_ready on cold start after confirming scenario %s', async scenario => {
    const client = freshBootstrappedClient();
    const store = await coldStart(client);
    const actor = await actorFor(store, 'executive');
    const service = new ConciergeService(store, { businessDate: BUSINESS_DATE, now: () => new Date(NOW) });
    const pending = await service.prepare(actor, { kind: 'demo_update', scenario });
    expect((await service.confirm(actor, pending.id)).status).toBe('verified_success');
    const mutated = await store.list<Record<string, unknown>>('inventory_snapshots', { date: BUSINESS_DATE });
    expect(mutated.every(row => typeof row.operationKey === 'string')).toBe(true);
    const commitsBeforeRestart = client.rpcCalls.length;
    const restarted = await coldStart(client);
    expect((await (await import('../lib/storage/index')).getWorkflowV2BootstrapResult())?.seedBeginMarkerState).toBe('current');
    expect(client.rpcCalls).toHaveLength(commitsBeforeRestart);
    expect(await restarted.list('inventory_snapshots', { date: BUSINESS_DATE })).toEqual(mutated);
  }, 60_000);

  it('reaches source_ready on cold start after confirming seeded badge revocation', async () => {
    const client = freshBootstrappedClient();
    const store = await coldStart(client);
    const actor = await actorFor(store, 'hr');
    const badge = (await store.list<Badge>('mock_badges')).find(row => row.state === 'active')!;
    const service = new ConciergeService(store, { businessDate: BUSINESS_DATE, now: () => new Date(NOW) });
    const pending = await service.prepare(actor, { kind: 'badge_revoke', employeeId: badge.employeeId, badgeId: badge.id, reason: 'Synthetic acceptance revocation' });
    expect((await service.confirm(actor, pending.id)).status).toBe('verified_success');
    const revoked = await store.get<Badge>('mock_badges', badge.id);
    expect(revoked).toMatchObject({ state: 'revoked', version: badge.version + 1 });
    const restarted = await coldStart(client);
    expect((await (await import('../lib/storage/index')).getWorkflowV2BootstrapResult())?.seedBeginMarkerState).toBe('current');
    expect(await restarted.get('mock_badges', badge.id)).toEqual(revoked);
  }, 60_000);

  it('logs sanitized phase, RPC, tables and codes before returning generic bootstrap failure', async () => {
    // This case needs an empty client so the injected RPC error interrupts the initial seed write.
    const client = new PersistingSupabaseClient();
    client.rpcErrorFor = (name, args) => name === 'nexus_workflow_commit' &&
      (args.operations as { table: string }[]).some(operation => operation.table === 'directory_identities')
      ? { code: '23503', message: 'secret-row-payload service-role-token', details: 'secret-detail', hint: 'secret-hint' }
      : undefined;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(coldStart(client)).rejects.toMatchObject({ code: 'WORKFLOW_UNAVAILABLE', message: 'Workflow V2 bootstrap is not ready' });
    expect(log).toHaveBeenCalledWith('Workflow V2 bootstrap failed', expect.objectContaining({
      state: 'source_phase_incomplete', phase: 'authority', code: 'STORAGE',
      rpc: 'nexus_workflow_commit', databaseCode: '23503',
      tables: expect.arrayContaining(['directory_identities', 'responsibilities', 'reporting_relationships']),
    }));
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain('secret-');
    expect(logged).not.toContain('service-role-token');
    expect(logged).not.toContain('synthetic-test-service-key');
  }, 60_000);

  it.each(['same native version', 'changed immutable employee'] as const)('still rejects seeded badge drift with %s', async drift => {
    const client = freshBootstrappedClient();
    const store = await coldStart(client);
    const badges = await store.list<Badge>('mock_badges');
    const badge = badges.find(row => row.state === 'active')!;
    const stored = client.rows.get('mock_badges')!.find(row => row.id === badge.id)!;
    client.put('mock_badges', {
      ...badge, state: 'revoked', version: badge.version + 1,
      ...(drift === 'changed immutable employee' ? { employeeId: badges.find(row => row.employeeId !== badge.employeeId)!.employeeId } : {}),
    }, Number(stored.row_version) + (drift === 'same native version' ? 0 : 1));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(coldStart(client)).rejects.toMatchObject({ code: 'WORKFLOW_UNAVAILABLE' });
    expect(log).toHaveBeenCalledWith('Workflow V2 bootstrap failed', expect.objectContaining({ state: 'seed_plan_conflict', tables: ['mock_badges'] }));
  }, 60_000);
});
