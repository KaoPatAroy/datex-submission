import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ActionPayload, Actor, Badge } from '../lib/contracts';
import { ConciergeService } from '../lib/core/service';
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

describe('Supabase V2 bootstrap after legitimate legacy mutations', () => {
  it('pins the hosted 76e18fd seed plan digest', () => {
    const plan = prepareWorkflowV2SeedPlan(createSeedData(BUSINESS_DATE), { seed: 1, businessDate: BUSINESS_DATE });
    expect(plan.inputDigest).toBe('658556149259b9c556fa39f32c98a1ff8108bdb443e3af76deff990c0c3294c6');
  });

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
