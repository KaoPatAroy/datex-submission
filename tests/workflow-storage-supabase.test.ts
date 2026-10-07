import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseStoreFromClient } from '../lib/storage/supabase';
import { DomainError } from '../lib/core/errors';
import { ConciergeService } from '../lib/core/service';
import { actors, dashboardPayload } from './helpers/workspace';
import type { Branch } from '../lib/contracts';
import type { ConversationMetadata, GuardedTransaction, PersistedConversation, PersistedConversationMessage, WorkflowReceiptV2, WorkflowStore, WorkflowStorageTable } from '../lib/workflows/contracts';
import { getWorkflowProjection, type WorkflowStorageQuery } from '../lib/storage/workflow-projections';

import { ControlledSupabaseClient, type DatabaseRow } from './helpers/controlled-supabase';

type ProjectedRow<T> = { id: string; rowVersion: number; body: T };
type WorkflowProjectionReader = {
  get<T>(table: WorkflowStorageTable, id: string): Promise<ProjectedRow<T> | undefined>;
  query<T>(query: WorkflowStorageQuery): Promise<ProjectedRow<T>[]>;
};
type WorkflowTransactionContext = GuardedTransaction & { workflowProjectionReader: WorkflowProjectionReader };

type ControlledWorkflowStore = WorkflowStore & { workflowProjectionReader: WorkflowProjectionReader };

function makeStore(client: ControlledSupabaseClient): ControlledWorkflowStore {
  return createSupabaseStoreFromClient(client as unknown as SupabaseClient) as ControlledWorkflowStore;
}

function branchRow(id: string, name: string, rowVersion: number): DatabaseRow {
  const body: Branch = { id, name, region: 'east' };
  return {
    id,
    payload: body,
    row_version: rowVersion,
    name: body.name,
    region: body.region,
    org_unit_id: null
  };
}

function crmActivityRow(
  id: string,
  opportunityId: string,
  ownerIdentityId: string | null,
  status: string | null,
  occurredAt: string,
  summary = `Activity ${id}`
): DatabaseRow {
  const body = {
    id,
    rowVersion: 1,
    opportunityId,
    ownerIdentityId,
    status,
    occurredAt,
    kind: 'note',
    summary,
    createdAt: '2026-10-01T00:00:00.000Z'
  };
  return {
    id,
    body,
    row_version: 1,
    opportunity_id: opportunityId,
    owner_identity_id: ownerIdentityId,
    status,
    occurred_at: occurredAt
  };
}

function conversationAnalysis(evidenceVersion = 'conversation-evidence-v2') {
  return {
    facts: [],
    relationships: [],
    hypotheses: [],
    missingEvidence: [],
    generatedAt: '2026-10-04T03:00:00.000Z',
    evidenceVersion
  };
}

function conversationMessageStorageRow(body: Record<string, unknown>): DatabaseRow {
  return {
    id: String(body.id),
    payload: body,
    row_version: typeof body.rowVersion === 'number' ? body.rowVersion : 1,
    actor_id: body.actorId,
    conversation_id: body.conversationId,
    created_at: body.createdAt,
    ...(typeof body.turnId === 'string' ? { turn_id: body.turnId } : {}),
    ...(typeof body.sessionId === 'string' ? { session_id: body.sessionId } : {})
  };
}

function conversationStorageRow(body: Record<string, unknown>): DatabaseRow {
  return {
    id: String(body.id),
    payload: body,
    row_version: typeof body.rowVersion === 'number' ? body.rowVersion : 1,
    actor_id: body.actorId
  };
}

function snapshotTargetStorageRow(body: Record<string, unknown>): DatabaseRow {
  return {
    id: String(body.id),
    body,
    row_version: typeof body.rowVersion === 'number' ? body.rowVersion : 1,
    snapshot_id: body.snapshotId,
    entity_type: body.entityType,
    target_id: body.targetId
  };
}

describe('Supabase workflow adapter contract (controlled client; not PostgreSQL proof)', () => {
  it('revokes an active legacy chat share with V2 enabled through the real service and Supabase adapter', async () => {
    vi.stubEnv('WORKFLOW_V2_ENABLED', 'true');
    vi.stubEnv('WORKFLOW_V2_DEMO_QUEUE', 'true');
    try {
      const client = new ControlledSupabaseClient();
      const owner = actors.executive;
      const grant = { id: 'hosted-share', dashboardId: 'hosted-dashboard', recipientId: 'east', actorId: owner.id, active: true, operationKey: 'execution_hosted-action:east', createdAt: '2026-10-02T05:00:00.000Z' };
      const put = (table: string, body: { id: string }) => client.rows.set(table, [...(client.rows.get(table) ?? []).filter(r => r.id !== body.id), { id: body.id, payload: body, workflow_contract_version: null }]);
      put('profiles', owner);
      put('profiles', actors.east);
      put('sessions', { id: owner.sessionId, profileId: owner.id, mode: owner.mode, modeRevision: owner.modeRevision, expiresAt: '2099-01-01T00:00:00.000Z' } as { id: string });
      put('dashboards', { id: grant.dashboardId, ownerId: owner.id, spec: dashboardPayload().spec } as { id: string });
      put('dashboard_shares', grant);
      // Model the existing legacy commit wire contract, including readback of committed payloads.
      const rpc = client.rpc.bind(client);
      client.rpc = async (name, args) => {
        const result = await rpc(name, args);
        if (result.error) return result;
        expect(name).toBe('nexus_commit');
        for (const change of args.changes as { table: string; payload: { id: string } }[]) put(change.table, change.payload);
        client.revision += 1;
        return result;
      };
      const service = new ConciergeService(makeStore(client), { now: () => new Date('2026-10-02T05:00:00.000Z') });
      expect(await service.dashboardShares(owner, grant.dashboardId)).toHaveLength(1);
      expect(await service.revokeDashboardShare(owner, grant.dashboardId, grant.id)).toEqual({ shareId: grant.id, alreadyRevoked: false });
      expect(await service.revokeDashboardShare(owner, grant.dashboardId, grant.id)).toEqual({ shareId: grant.id, alreadyRevoked: true });
      expect(await service.dashboardShares(owner, grant.dashboardId)).toEqual([]);
      expect(client.rpcCalls).toHaveLength(1);
      expect(client.rows.get('audit_events')).toHaveLength(1);
      client.readFailure = call => call.table === 'dashboard_shares' ? { code: '08006', message: 'database unavailable' } : undefined;
      await expect(service.dashboardShares(owner, grant.dashboardId)).rejects.toThrow();
    } finally { vi.unstubAllEnvs(); }
  });

  it('reads and guards legacy mixed tables when the V2 marker column is absent, without masking other failures', async () => {
    vi.stubEnv('WORKFLOW_V2_ENABLED', 'false');
    try {
      const client = new ControlledSupabaseClient();
      const legacy = { id: 'legacy-share', dashboardId: 'dashboard-1', recipientId: 'east', active: true };
      client.rows.set('dashboard_shares', [{ id: legacy.id, payload: legacy }]);
      client.readFailure = (call) => call.table === 'dashboard_shares' &&
        (call.filters.some((filter) => filter.column === 'workflow_contract_version') || call.columns.includes('workflow_contract_version'))
        ? { code: '42703', message: 'column dashboard_shares.workflow_contract_version does not exist' }
        : null;
      const store = makeStore(client);
      expect(await store.list('dashboard_shares')).toEqual([legacy]);
      expect(await store.get('dashboard_shares', legacy.id)).toEqual(legacy);
      await store.transaction(async (tx) => tx.put('dashboard_shares', legacy));
      expect(client.rpcCalls).toHaveLength(1);
      expect(client.reads.some((call) => call.table === 'dashboard_shares' && call.filters.some((filter) => filter.column === 'workflow_contract_version'))).toBe(true);
      expect(client.reads.some((call) => call.table === 'dashboard_shares' && call.filters.every((filter) => filter.column !== 'workflow_contract_version'))).toBe(true);

      client.rows.set('dashboard_shares', [{ id: 'v2-shaped', payload: { ...legacy, id: 'v2-shaped', senderIdentityId: 'sender-1' } }]);
      await expect(store.list('dashboard_shares')).rejects.toMatchObject({ code: 'STORAGE' });

      client.readFailure = (call) => call.table === 'dashboard_shares'
        ? { code: '42703', message: 'column dashboard_shares.some_other_column does not exist' }
        : null;
      const readsBefore = client.reads.length;
      await expect(store.list('dashboard_shares')).rejects.toMatchObject({ code: 'STORAGE' });
      expect(client.reads.length - readsBefore).toBe(1);

      vi.stubEnv('WORKFLOW_V2_ENABLED', 'true');
      client.readFailure = (call) => call.table === 'dashboard_shares' && call.filters.some((filter) => filter.column === 'workflow_contract_version')
        ? { code: '42703', message: 'column dashboard_shares.workflow_contract_version does not exist' }
        : null;
      const enabledReadsBefore = client.reads.length;
      await expect(store.list('dashboard_shares')).rejects.toMatchObject({ code: 'STORAGE' });
      expect(client.reads.length - enabledReadsBefore).toBe(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('uses targeted reads, caches rows per callback, and retries one unstable read snapshot as a whole', async () => {
    const client = new ControlledSupabaseClient();
    const firstA = branchRow('supabase-branch-a', 'A version 1', 1);
    const firstB = branchRow('supabase-branch-b', 'B version 1', 1);
    const nextA = branchRow('supabase-branch-a', 'A version 2', 2);
    const nextB = branchRow('supabase-branch-b', 'B version 2', 2);
    client.rows.set('branches', [firstA, firstB]);
    let interleaved = false;
    client.onRead = (call) => {
      if (!interleaved && call.table === 'branches'
        && call.filters.some((filter) => filter.column === 'id' && filter.value === firstA.id)) {
        interleaved = true;
        client.rows.set('branches', [nextA, nextB]);
        client.revision += 1;
      }
    };
    const store = makeStore(client);
    let callbackCount = 0;

    const result = await store.workflowTransaction(async (tx) => {
      callbackCount += 1;
      const a = await tx.get<Branch>('branches', firstA.id);
      const cachedAgain = await tx.get<Branch>('branches', firstA.id);
      const b = await tx.get<Branch>('branches', firstB.id);
      expect(cachedAgain).toEqual(a);
      return [a, b];
    });

    expect(callbackCount).toBe(2);
    expect(result).toEqual([
      { id: nextA.id, name: 'A version 2', region: 'east' },
      { id: nextB.id, name: 'B version 2', region: 'east' }
    ]);
    expect(client.rpcCalls).toHaveLength(0);
    const branchReads = client.reads.filter((read) => read.table === 'branches');
    expect(branchReads).toHaveLength(4);
    expect(branchReads.every((read) => read.filters.some((filter) => filter.column === 'id'))).toBe(true);
    expect(client.reads.some((read) => read.table !== 'appmeta' && read.table !== 'branches')).toBe(false);
  });

  it('preserves guarded intent order in one RPC and never replays after a commit conflict', async () => {
    const client = new ControlledSupabaseClient();
    client.rpcResult = { data: null, error: { code: '40001', message: 'revision conflict' } };
    const store = makeStore(client);
    const first: Branch = { id: 'supabase-insert-first', name: 'First', region: 'east' };
    const second: Branch = { id: 'supabase-insert-second', name: 'Second', region: 'east' };
    let callbackCount = 0;

    await expect(store.workflowTransaction(async (tx) => {
      callbackCount += 1;
      await tx.insertUnique('branches', first, {
        constraint: 'branches_primary_key', values: { id: first.id }
      });
      await tx.insertUnique('branches', second, {
        constraint: 'branches_primary_key', values: { id: second.id }
      });
      return 'must not escape a failed commit';
    })).rejects.toThrow();

    expect(callbackCount).toBe(1);
    expect(client.rpcCalls).toHaveLength(1);
    expect(client.rpcCalls[0].name).toBe('nexus_workflow_commit');
    const args = client.rpcCalls[0].args;
    expect(String(args.expected_revision)).toBe('10');
    expect(args.operations).toEqual([
      { kind: 'insert_unique', table: 'branches', constraint: 'branches_primary_key', values: { id: first.id }, row: { id: first.id, rowVersion: 1, body: first } },
      { kind: 'insert_unique', table: 'branches', constraint: 'branches_primary_key', values: { id: second.id }, row: { id: second.id, rowVersion: 1, body: second } }
    ]);
  });

  it('does not dispatch a second guarded write when the commit response is lost', async () => {
    const client = new ControlledSupabaseClient();
    client.rpcFailure = new Error('connection ended after dispatch');
    const store = makeStore(client);
    const branch: Branch = { id: 'supabase-lost-response-branch', name: 'Lost response', region: 'east' };
    let callbackCount = 0;

    const failure = await store.workflowTransaction(async (tx) => {
      callbackCount += 1;
      return tx.insertUnique('branches', branch, {
        constraint: 'branches_primary_key', values: { id: branch.id }
      });
    }).then(() => undefined, (error: unknown) => error);

    expect(failure).toMatchObject({ code: 'STORAGE', definitelyNotCommitted: false });
    expect((failure as Error).message).not.toContain('connection ended after dispatch');
    expect(callbackCount).toBe(1);
    expect(client.rpcCalls).toHaveLength(1);
    expect(client.rpcCalls[0].name).toBe('nexus_workflow_commit');
  });

  it('promotes an unannotated pre-dispatch DomainError after a staged CAS', async () => {
    const client = new ControlledSupabaseClient();
    const beforeBody: Branch = { id: 'supabase-domain-error-branch', name: 'Original branch', region: 'east' };
    const before = branchRow(beforeBody.id, beforeBody.name, 1);
    client.rows.set('branches', [before]);
    const store = makeStore(client);
    const domainError = new DomainError('STALE_ACTION', 'The reviewed source version is stale.', 409);
    const next = { ...beforeBody, rowVersion: 2, name: 'Staged branch update' };
    let callbackCount = 0;

    const failure = await store.workflowTransaction(async (tx) => {
      callbackCount += 1;
      await tx.compareAndSwap('branches', beforeBody.id,
        { rowVersion: 1, state: null }, next);
      throw domainError;
    }).then(() => undefined, (error: unknown) => error);

    expect(failure).toBeInstanceOf(DomainError);
    expect(failure).toMatchObject({ code: 'STALE_ACTION', status: 409, definitelyNotCommitted: true });
    expect(callbackCount).toBe(1);
    expect(client.rpcCalls).toHaveLength(0);
    expect(client.rows.get('branches')).toEqual([before]);
    const current = await store.workflowTransaction(async (tx) =>
      (tx as WorkflowTransactionContext).workflowProjectionReader.get<Branch>(
        'branches', beforeBody.id
      )
    );
    expect(current).toEqual({ id: beforeBody.id, rowVersion: 1, body: beforeBody });
  });

  it('sanitizes RPC errors and preserves commit certainty without replaying intents', async () => {
    const scenarios = [
      {
        label: 'serialization conflict',
        kind: 'result' as const,
        error: { code: '40001', message: 'PRIVATE_SQL_FRAGMENT_97 SERVICE_SECRET_97' },
        expected: { code: 'CONFLICT', definitelyNotCommitted: true }
      },
      {
        label: 'foreign-key rejection',
        kind: 'result' as const,
        error: { code: '23503', message: 'PRIVATE_SQL_FRAGMENT_97 SERVICE_SECRET_97' },
        expected: { code: 'STORAGE', definitelyNotCommitted: true }
      },
      {
        label: 'unknown post-dispatch result',
        kind: 'throw' as const,
        error: new Error('PRIVATE_SQL_FRAGMENT_97 SERVICE_SECRET_97'),
        expected: { code: 'STORAGE', definitelyNotCommitted: false }
      }
    ];

    for (const [index, scenario] of scenarios.entries()) {
      const client = new ControlledSupabaseClient();
      if (scenario.kind === 'result') client.rpcResult = { data: null, error: scenario.error };
      else client.rpcFailure = scenario.error;
      const store = makeStore(client);
      const branch: Branch = {
        id: `supabase-sanitized-error-branch-${index}`,
        name: `Sanitized error fixture ${index}`,
        region: 'east'
      };
      let callbackCount = 0;
      const failure = await store.workflowTransaction(async (tx) => {
        callbackCount += 1;
        return tx.insertUnique('branches', branch, {
          constraint: 'branches_primary_key', values: { id: branch.id }
        });
      }).then(() => undefined, (error: unknown) => error);

      expect(failure, scenario.label).toMatchObject(scenario.expected);
      expect((failure as Error).message).not.toContain('PRIVATE_SQL_FRAGMENT_97');
      expect((failure as Error).message).not.toContain('SERVICE_SECRET_97');
      expect(callbackCount).toBe(1);
      expect(client.rpcCalls).toHaveLength(1);
      expect(client.rpcCalls[0].name).toBe('nexus_workflow_commit');
    }
  });

  it('retains body and external unique-key metadata after staged CAS re-queries', async () => {
    const client = new ControlledSupabaseClient();
    const actionId = 'supabase-cas-action-01';
    const rootId = 'supabase-cas-root-01';
    const executionId = 'supabase-cas-execution-01';
    const idempotencyKey = 'd'.repeat(64);
    const root = {
      id: rootId,
      actionId,
      actorId: 'supabase-cas-actor-01',
      idempotencyKey,
      activeExecutionId: executionId,
      rowVersion: 1,
      status: 'open',
      createdAt: '2026-10-02T05:00:00.000Z'
    };
    const receipt: WorkflowReceiptV2 = {
      id: executionId,
      actionId,
      contractVersion: 2,
      actorId: root.actorId,
      kind: 'investigation_create',
      outcome: 'pending',
      proofs: [],
      createdAt: '2026-10-02T05:00:00.000Z',
      verifiedAt: null,
      currentStates: []
    };
    client.rows.set('action_idempotency_roots', [{
      id: rootId, body: root, row_version: 1, actor_id: root.actorId,
      idempotency_key: idempotencyKey, active_execution_id: executionId, status: 'open'
    }]);
    client.rows.set('action_executions', [{
      id: executionId, payload: receipt, row_version: 1, workflow_contract_version: 2,
      action_id: actionId, root_id: rootId, attempt: 1, outcome: 'pending', execution_id: executionId
    }]);
    const store = makeStore(client);
    const rootKey = {
      kind: 'unique' as const,
      table: 'action_idempotency_roots' as const,
      constraint: 'action_idempotency_roots_key_unique',
      values: { idempotencyKey }
    };
    const executionKey = {
      kind: 'unique' as const,
      table: 'action_executions' as const,
      constraint: 'action_executions_root_attempt_unique',
      values: { rootId, attempt: 1 }
    };
    const rootRowsBefore = JSON.stringify(client.rows.get('action_idempotency_roots'));
    const executionRowsBefore = JSON.stringify(client.rows.get('action_executions'));
    const malformedKeys = [
      { label: 'string attempt', values: { rootId, attempt: '1' } },
      { label: 'numeric root ID', values: { rootId: 17, attempt: 1 } }
    ];

    for (const [index, malformed] of malformedKeys.entries()) {
      client.reads.length = 0;
      const candidate = { ...receipt, id: `supabase-cas-invalid-external-${index}` };
      const failure = await store.workflowTransaction((tx) => tx.insertUnique(
        'action_executions', candidate,
        { constraint: executionKey.constraint, values: malformed.values }
      )).then(() => undefined, (error: unknown) => error);
      expect(failure, malformed.label).toMatchObject({ code: 'STORAGE', definitelyNotCommitted: true });
      expect(client.reads.some((read) => read.table === 'action_executions')).toBe(false);
      expect(client.reads.some((read) => read.table === 'action_idempotency_roots')).toBe(false);
      expect(client.rpcCalls).toHaveLength(0);
      expect(JSON.stringify(client.rows.get('action_idempotency_roots'))).toBe(rootRowsBefore);
      expect(JSON.stringify(client.rows.get('action_executions'))).toBe(executionRowsBefore);
    }

    client.reads.length = 0;
    const retryReceipt = { ...receipt, id: 'supabase-cas-valid-external-retry' };
    expect(await store.workflowTransaction((tx) => tx.insertUnique(
      'action_executions', retryReceipt, executionKey
    ))).toEqual({ inserted: false, existing: receipt });
    expect(client.reads.filter((read) => read.table === 'action_executions')).toHaveLength(1);
    expect(client.rpcCalls).toHaveLength(0);
    expect(JSON.stringify(client.rows.get('action_idempotency_roots'))).toBe(rootRowsBefore);
    expect(JSON.stringify(client.rows.get('action_executions'))).toBe(executionRowsBefore);

    const observed = await store.workflowTransaction(async (tx) => {
      const projectionReader = (tx as WorkflowTransactionContext).workflowProjectionReader;
      const rootBefore = await projectionReader.query<typeof root>(rootKey);
      const executionBefore = await projectionReader.query<WorkflowReceiptV2>(executionKey);
      const nextRoot = { ...root, rowVersion: 2, status: 'completed' };
      const nextReceipt = { ...receipt, rowVersion: 2, outcome: 'failed' as const };
      const rootCas = await tx.compareAndSwap('action_idempotency_roots', rootId,
        { rowVersion: 1, state: 'open' }, nextRoot);
      const executionCas = await tx.compareAndSwap('action_executions', executionId,
        { rowVersion: 1, state: 'pending' }, nextReceipt);
      const rootAfter = await projectionReader.query<typeof nextRoot>(rootKey);
      const executionAfter = await projectionReader.query<WorkflowReceiptV2>(executionKey);
      return { rootBefore, executionBefore, rootCas, executionCas, rootAfter, executionAfter };
    });

    expect(observed.rootBefore).toEqual([{ id: rootId, rowVersion: 1, body: root }]);
    expect(observed.executionBefore).toEqual([{ id: executionId, rowVersion: 1, body: receipt }]);
    expect(observed.rootCas).toMatchObject({ updated: true });
    expect(observed.executionCas).toMatchObject({ updated: true });
    expect(observed.rootAfter).toEqual([{
      id: rootId, rowVersion: 2, body: { ...root, rowVersion: 2, status: 'completed' }
    }]);
    expect(observed.rootAfter[0].body.idempotencyKey).toBe(idempotencyKey);
    expect(observed.executionAfter).toEqual([{
      id: executionId, rowVersion: 2, body: { ...receipt, outcome: 'failed' }
    }]);
    expect(client.rpcCalls).toHaveLength(1);
    expect(client.rpcCalls[0].name).toBe('nexus_workflow_commit');
  });

  it('rejects extra strict-receipt fields and mismatched CAS versions without a commit', async () => {
    const client = new ControlledSupabaseClient();
    const actionId = 'supabase-strict-cas-action-01';
    const rootId = 'supabase-strict-cas-root-01';
    const executionId = 'supabase-strict-cas-execution-01';
    const receipt: WorkflowReceiptV2 = {
      id: executionId,
      actionId,
      contractVersion: 2,
      actorId: 'supabase-strict-cas-actor-01',
      kind: 'investigation_create',
      outcome: 'pending',
      proofs: [],
      createdAt: '2026-10-02T05:00:00.000Z',
      verifiedAt: null,
      currentStates: []
    };
    const executionRow = {
      id: executionId,
      payload: receipt,
      row_version: 1,
      workflow_contract_version: 2,
      action_id: actionId,
      root_id: rootId,
      attempt: 1,
      outcome: 'pending',
      execution_id: executionId
    };
    client.rows.set('action_executions', [executionRow]);
    const store = makeStore(client);
    const assertUnchanged = async (): Promise<void> => {
      expect(client.rpcCalls).toHaveLength(0);
      expect(client.rows.get('action_executions')).toEqual([executionRow]);
      const current = await store.workflowTransaction(async (tx) =>
        (tx as WorkflowTransactionContext).workflowProjectionReader.get<WorkflowReceiptV2>(
          'action_executions', executionId
        )
      );
      expect(current).toEqual({ id: executionId, rowVersion: 1, body: receipt });
    };

    const withUnknownBodyField = {
      ...receipt,
      rowVersion: 2,
      outcome: 'failed' as const,
      unexpectedBodyField: 'not part of WorkflowReceiptV2'
    };
    await expect(store.workflowTransaction((tx) => tx.compareAndSwap(
      'action_executions', executionId,
      { rowVersion: 1, state: 'pending' },
      withUnknownBodyField
    ))).rejects.toMatchObject({ code: 'STORAGE', definitelyNotCommitted: true });
    await assertUnchanged();

    const withMismatchedVersion = { ...receipt, rowVersion: 3, outcome: 'failed' as const };
    await expect(store.workflowTransaction((tx) => tx.compareAndSwap(
      'action_executions', executionId,
      { rowVersion: 1, state: 'pending' },
      withMismatchedVersion
    ))).rejects.toMatchObject({ code: 'STORAGE', definitelyNotCommitted: true });
    await assertUnchanged();
  });

  it('stages all new snapshot proof tags with a V2 execution CAS and isolates cache/revision conflicts', async () => {
    const actorId = 'supabase-proof-reference-actor';
    const snapshotId = 'supabase-proof-reference-snapshot';
    const actionId = 'supabase-proof-reference-action';
    const rootId = 'supabase-proof-reference-root';
    const executionId = 'supabase-proof-reference-execution';
    const receipt: WorkflowReceiptV2 = {
      id: executionId,
      actionId,
      contractVersion: 2,
      actorId,
      kind: 'investigation_create',
      outcome: 'pending',
      proofs: [],
      createdAt: '2026-10-04T03:00:00.000Z',
      verifiedAt: null,
      currentStates: []
    };
    const executionRow = {
      id: executionId,
      payload: receipt,
      row_version: 1,
      workflow_contract_version: 2,
      action_id: actionId,
      root_id: rootId,
      attempt: 1,
      outcome: 'pending',
      execution_id: executionId
    };
    const targets = [
      {
        id: 'supabase-proof-target-a-directory', snapshotId, entityType: 'directory_identities',
        targetId: 'supabase-proof-directory-identity', expectedRowVersion: 3, expectedState: 'active',
        ref: { table: 'directory_identities' as const, id: 'supabase-proof-directory-identity' }
      },
      {
        id: 'supabase-proof-target-b-responsibility', snapshotId, entityType: 'responsibilities',
        targetId: 'supabase-proof-responsibility', expectedRowVersion: 4, expectedState: 'active',
        ref: { table: 'responsibilities' as const, id: 'supabase-proof-responsibility' }
      },
      {
        id: 'supabase-proof-target-c-execution', snapshotId, entityType: 'action_executions',
        targetId: executionId, expectedRowVersion: 1, expectedState: 'pending',
        ref: { table: 'action_executions' as const, id: executionId }
      }
    ];
    const targetQuery: WorkflowStorageQuery = {
      kind: 'scoped', table: 'review_snapshot_targets', equals: { snapshotId }, limit: 10
    };
    const runCommit = (client: ControlledSupabaseClient) => {
      client.rows.set('action_executions', [executionRow]);
      const store = makeStore(client);
      return store.workflowTransaction(async (tx) => {
        const projectionReader = (tx as WorkflowTransactionContext).workflowProjectionReader;
        for (const target of targets) {
          await tx.insertUnique('review_snapshot_targets', target, {
            constraint: 'review_snapshot_targets_snapshot_target_unique',
            values: { snapshotId, entityType: target.entityType, targetId: target.targetId }
          });
        }
        const firstTargets = await projectionReader.query<typeof targets[number]>(targetQuery);
        const cloneToMutate = firstTargets.find((row) => row.id === targets[0].id);
        if (!cloneToMutate) throw new Error('Expected staged directory-identity proof target');
        cloneToMutate.body.ref.id = 'supabase-proof-caller-mutation';
        const cachedTargets = await projectionReader.query<typeof targets[number]>(targetQuery);
        const nextReceipt = { ...receipt, rowVersion: 2, outcome: 'failed' as const };
        const executionCas = await tx.compareAndSwap('action_executions', executionId,
          { rowVersion: 1, state: 'pending' }, nextReceipt);
        const afterExecution = await projectionReader.get<WorkflowReceiptV2>('action_executions', executionId);
        return { cachedTargets, executionCas, afterExecution };
      });
    };

    const successClient = new ControlledSupabaseClient();
    const success = await runCommit(successClient);
    expect(success.cachedTargets).toEqual(targets.map((body) => ({ id: body.id, rowVersion: 1, body })));
    for (const row of success.cachedTargets) {
      expect(row.body.entityType).toBe(row.body.ref.table);
      expect(row.body.targetId).toBe(row.body.ref.id);
    }
    expect(success.executionCas).toMatchObject({ updated: true });
    expect(success.afterExecution).toEqual({
      id: executionId,
      rowVersion: 2,
      body: { ...receipt, outcome: 'failed' }
    });
    expect(successClient.rpcCalls).toHaveLength(1);
    const successOperations = successClient.rpcCalls[0].args.operations as Array<Record<string, unknown>>;
    expect(successOperations.map(({ kind, table }) => ({ kind, table }))).toEqual([
      { kind: 'insert_unique', table: 'review_snapshot_targets' },
      { kind: 'insert_unique', table: 'review_snapshot_targets' },
      { kind: 'insert_unique', table: 'review_snapshot_targets' },
      { kind: 'cas', table: 'action_executions' }
    ]);
    expect(successOperations.slice(0, 3).map((operation) =>
      (operation.row as { body: unknown }).body
    )).toEqual(targets);
    expect((successOperations[3].next as { body: WorkflowReceiptV2 }).body).toMatchObject({
      id: executionId, contractVersion: 2, outcome: 'failed'
    });
    // The controlled client checks staged JSON and certainty only; native FK provenance is SQL-side.

    const conflictClient = new ControlledSupabaseClient();
    conflictClient.rpcResult = { data: null, error: { code: '40001', message: 'revision conflict' } };
    const conflict = await runCommit(conflictClient).then(() => undefined, (error: unknown) => error);
    expect(conflict).toMatchObject({ code: 'CONFLICT', definitelyNotCommitted: true });
    expect(conflictClient.rpcCalls).toHaveLength(1);
    expect(conflictClient.rows.get('review_snapshot_targets')).toBeUndefined();
    expect(conflictClient.rows.get('action_executions')).toEqual([executionRow]);
    const postConflictStore = makeStore(conflictClient);
    expect(await postConflictStore.workflowProjectionReader.query<typeof targets[number]>(targetQuery)).toEqual([]);
    expect(await postConflictStore.workflowProjectionReader.get<WorkflowReceiptV2>('action_executions', executionId))
      .toEqual({ id: executionId, rowVersion: 1, body: receipt });
  });

  it('requires one recognized snapshot target tag, maps SQL tag violations, and reads legacy refs', async () => {
    const snapshotId = 'supabase-proof-tag-snapshot';
    const untaggedTarget = {
      id: 'supabase-proof-target-untagged', snapshotId, entityType: 'profiles',
      targetId: 'supabase-proof-profile', expectedRowVersion: 1, expectedState: 'active',
      ref: { table: 'profiles' as const, id: 'supabase-proof-profile' }
    };
    const untaggedClient = new ControlledSupabaseClient();
    const untaggedStore = makeStore(untaggedClient);
    await expect(untaggedStore.workflowTransaction((tx) => tx.insertUnique('review_snapshot_targets', untaggedTarget, {
      constraint: 'review_snapshot_targets_snapshot_target_unique',
      values: { snapshotId, entityType: untaggedTarget.entityType, targetId: untaggedTarget.targetId }
    }))).rejects.toMatchObject({ code: 'STORAGE', definitelyNotCommitted: true });
    expect(untaggedClient.reads.some((read) => read.table === 'review_snapshot_targets')).toBe(false);
    expect(untaggedClient.rpcCalls).toHaveLength(0);

    const tagMismatch = {
      ...untaggedTarget,
      id: 'supabase-proof-target-tag-mismatch',
      entityType: 'responsibilities',
      targetId: 'supabase-proof-directory-identity',
      ref: { table: 'directory_identities' as const, id: 'supabase-proof-directory-identity' }
    };
    const mismatchClient = new ControlledSupabaseClient();
    // This fake response verifies adapter mapping only; it does not execute the PostgreSQL tag guard.
    mismatchClient.rpcResult = { data: null, error: { code: '23514', message: 'tag mismatch' } };
    const mismatchStore = makeStore(mismatchClient);
    await expect(mismatchStore.workflowTransaction((tx) => tx.insertUnique('review_snapshot_targets', tagMismatch, {
      constraint: 'review_snapshot_targets_snapshot_target_unique',
      values: { snapshotId, entityType: tagMismatch.entityType, targetId: tagMismatch.targetId }
    }))).rejects.toMatchObject({ code: 'STORAGE', definitelyNotCommitted: true });
    expect(mismatchClient.rpcCalls).toHaveLength(1);
    const mismatchOperations = mismatchClient.rpcCalls[0].args.operations as Array<{ row: { body: Record<string, unknown> } }>;
    expect(mismatchOperations[0].row.body).toMatchObject({
      entityType: 'responsibilities',
      targetId: 'supabase-proof-directory-identity',
      ref: { table: 'directory_identities', id: 'supabase-proof-directory-identity' }
    });

    const legacyTarget = {
      id: 'supabase-proof-target-legacy-branch',
      snapshotId: 'supabase-proof-legacy-snapshot',
      entityType: 'branches',
      targetId: 'supabase-proof-legacy-branch',
      expectedRowVersion: 2,
      expectedState: 'active',
      ref: { table: 'branches' as const, id: 'supabase-proof-legacy-branch' }
    };
    const legacyClient = new ControlledSupabaseClient();
    legacyClient.rows.set('review_snapshot_targets', [snapshotTargetStorageRow(legacyTarget)]);
    const legacyStore = makeStore(legacyClient);
    expect(await legacyStore.workflowProjectionReader.get<typeof legacyTarget>('review_snapshot_targets', legacyTarget.id))
      .toEqual({ id: legacyTarget.id, rowVersion: 1, body: legacyTarget });
    expect(Object.hasOwn(legacyClient.rows.get('review_snapshot_targets')?.[0] ?? {}, 'directory_identity_id')).toBe(false);
    expect(Object.hasOwn(legacyClient.rows.get('review_snapshot_targets')?.[0] ?? {}, 'responsibility_id')).toBe(false);
    expect(Object.hasOwn(legacyClient.rows.get('review_snapshot_targets')?.[0] ?? {}, 'action_execution_id')).toBe(false);
  });

  it('stages investigation-case and V2 dashboard-share refs through the action-target descriptor', async () => {
    const descriptor = getWorkflowProjection('action_targets');
    expect(descriptor.foreignKeys).toEqual(expect.arrayContaining([
      expect.objectContaining({
        column: 'investigation_case_id', target: 'investigation_cases',
        bodyField: 'ref.id', tagField: 'ref.table', tagValue: 'investigation_cases'
      }),
      expect.objectContaining({
        column: 'dashboard_share_id', target: 'dashboard_shares',
        bodyField: 'ref.id', tagField: 'ref.table', tagValue: 'dashboard_shares',
        requiredContractVersion: 2
      })
    ]));

    const executionId = 'supabase-action-target-source-execution';
    const targets = [
      {
        id: 'supabase-action-target-case', executionId, targetId: 'supabase-investigation-case',
        entityType: 'investigation_cases' as const,
        ref: { table: 'investigation_cases' as const, id: 'supabase-investigation-case' },
        expectedRowVersion: 3, expectedState: 'open', targetStatus: 'pending' as const
      },
      {
        id: 'supabase-action-target-share', executionId, targetId: 'supabase-dashboard-share',
        entityType: 'dashboard_shares' as const,
        ref: { table: 'dashboard_shares' as const, id: 'supabase-dashboard-share' },
        expectedRowVersion: 4, expectedState: 'active', targetStatus: 'pending' as const
      }
    ];
    const client = new ControlledSupabaseClient();
    const store = makeStore(client);

    await store.workflowTransaction(async (tx) => {
      for (const target of targets) {
        await tx.insertUnique('action_targets', target, {
          constraint: 'action_targets_execution_target_unique',
          values: { executionId, entityType: target.entityType, targetId: target.targetId }
        });
      }
    });

    expect(client.rpcCalls).toHaveLength(1);
    const operations = client.rpcCalls[0].args.operations as Array<{
      kind: string;
      table: string;
      row: { id: string; rowVersion: number; body: Record<string, unknown> };
    }>;
    expect(operations.map(({ kind, table }) => ({ kind, table }))).toEqual([
      { kind: 'insert_unique', table: 'action_targets' },
      { kind: 'insert_unique', table: 'action_targets' }
    ]);
    expect(operations.map((operation) => operation.row.body)).toEqual(targets);
    expect(operations.map((operation) => operation.row.body.ref)).toEqual(targets.map(({ ref }) => ref));
  });

  it('stages a dashboard-share revoke CAS and its event in one RPC without retrying uncertain commits', async () => {
    const eventDescriptor = getWorkflowProjection('dashboard_share_revoke_events');
    expect(eventDescriptor.storage).toBe('new');
    expect(eventDescriptor.foreignKeys).toEqual(expect.arrayContaining([
      expect.objectContaining({ column: 'share_id', target: 'dashboard_shares', requiredContractVersion: 2 }),
      expect.objectContaining({ column: 'actor_id', target: 'profiles' }),
      expect.objectContaining({ column: 'execution_id', target: 'action_executions' }),
      expect.objectContaining({ column: 'share_creation_execution_id', target: 'action_executions' })
    ]));
    expect(eventDescriptor.compositeForeignKeys).toEqual(expect.arrayContaining([
      expect.objectContaining({
        columns: ['share_id', 'revoked_share_row_version', 'share_creation_execution_id'],
        target: 'dashboard_shares', targetColumns: ['id', 'row_version', 'execution_id'], deferred: true
      })
    ]));

    const shareId = 'supabase-revoke-share';
    const actorId = 'supabase-revoke-actor';
    const shareCreationExecutionId = 'supabase-share-creation-execution';
    const revokeExecutionId = 'supabase-share-revoke-execution';
    const priorShareRowVersion = 7;
    const revokedAt = '2026-10-04T04:00:00.000Z';
    const share = {
      id: shareId,
      dashboardId: 'supabase-revoke-dashboard',
      dashboardVersionId: 'supabase-revoke-dashboard-version',
      senderIdentityId: 'supabase-revoke-sender-identity',
      recipientIdentityId: 'supabase-revoke-recipient-identity',
      approvedBranchIds: ['supabase-revoke-branch'],
      classification: 'internal',
      verificationDigest: 'a'.repeat(64),
      keyVersion: 1,
      channel: 'simulated_email',
      policy: { id: 'demo-workflow', version: 1, digest: 'b'.repeat(64) },
      status: 'active',
      expiresAt: '2026-10-05T00:00:00.000Z',
      rowVersion: priorShareRowVersion,
      semanticKey: 'c'.repeat(64),
      executionId: shareCreationExecutionId,
      createdAt: '2026-10-04T03:00:00.000Z',
      revokedAt: null
    };
    const revokedShare = { ...share, status: 'revoked', rowVersion: priorShareRowVersion + 1, revokedAt };
    const event = {
      id: 'supabase-revoke-event',
      shareId,
      actorId,
      executionId: revokeExecutionId,
      shareCreationExecutionId,
      priorShareRowVersion,
      revokedShareRowVersion: priorShareRowVersion + 1,
      createdAt: revokedAt,
      rowVersion: 1
    };

    const run = async (outcome: 'success' | 'conflict' | 'unknown') => {
      const client = new ControlledSupabaseClient();
      if (outcome === 'conflict') {
        client.rpcResult = { data: null, error: { code: '40001', message: 'revision conflict' } };
      } else if (outcome === 'unknown') {
        client.rpcFailure = new Error('connection ended after dispatch');
      }
      const storedShare: DatabaseRow = {
        id: shareId,
        payload: share,
        row_version: priorShareRowVersion,
        workflow_contract_version: 2,
        pre_migration_revoke_quarantined: 0
      };
      client.rows.set('dashboard_shares', [storedShare]);
      const store = makeStore(client);
      let callbackCount = 0;
      const settled = await store.workflowTransaction(async (tx) => {
        callbackCount += 1;
        const shareCas = await tx.compareAndSwap(
          'dashboard_shares', shareId,
          { rowVersion: priorShareRowVersion, state: 'active' },
          revokedShare
        );
        const eventInsert = await tx.insertUnique('dashboard_share_revoke_events', event, {
          constraint: 'dashboard_share_revoke_events_share_unique',
          values: { shareId }
        });
        return { shareCas, eventInsert };
      }).then(
        (value) => ({ value }),
        (error: unknown) => ({ error })
      );

      expect(callbackCount).toBe(1);
      expect(client.rpcCalls).toHaveLength(1);
      expect(client.rpcCalls[0].name).toBe('nexus_workflow_commit');
      const operations = client.rpcCalls[0].args.operations as Array<Record<string, unknown>>;
      expect(operations.map(({ kind, table }) => ({ kind, table }))).toEqual([
        { kind: 'cas', table: 'dashboard_shares' },
        { kind: 'insert_unique', table: 'dashboard_share_revoke_events' }
      ]);
      expect(operations[0]).toMatchObject({
        id: shareId,
        expected: { rowVersion: priorShareRowVersion, state: 'active' },
        next: { id: shareId, rowVersion: priorShareRowVersion + 1, body: revokedShare }
      });
      expect(operations[1]).toMatchObject({
        constraint: 'dashboard_share_revoke_events_share_unique',
        values: { shareId },
        row: { id: event.id, rowVersion: 1, body: event }
      });
      // The fake verifies one batched RPC envelope; it does not execute backend SQL atomicity.
      expect(client.rows.get('dashboard_shares')).toEqual([storedShare]);
      expect(client.rows.get('dashboard_share_revoke_events')).toBeUndefined();

      if (outcome === 'success') {
        expect('value' in settled).toBe(true);
      } else if (outcome === 'conflict') {
        expect(settled).toMatchObject({ error: { code: 'CONFLICT', definitelyNotCommitted: true } });
      } else {
        expect(settled).toMatchObject({ error: { code: 'STORAGE', definitelyNotCommitted: false } });
      }
    };

    await run('success');
    await run('conflict');
    await run('unknown');
  });

  it('reapplies an open-only unique filter after a staged CAS closes the current row', async () => {
    const client = new ControlledSupabaseClient();
    const request = {
      id: 'supabase-restock-open-filter',
      branchId: 'supabase-restock-branch',
      productId: 'supabase-restock-product',
      inventorySnapshotId: 'supabase-restock-snapshot',
      ownerIdentityId: 'supabase-restock-owner',
      replenishmentLifecycleId: 'supabase-restock-lifecycle-01',
      quantity: 8,
      status: 'open',
      rowVersion: 1,
      dueDate: '2026-10-10',
      priority: 'normal',
      reason: 'Restore the synthetic stock minimum.',
      createdAt: '2026-10-02T05:00:00.000Z'
    };
    client.rows.set('restock_requests', [{
      id: request.id,
      body: request,
      row_version: 1,
      branch_id: request.branchId,
      product_id: request.productId,
      inventory_snapshot_id: request.inventorySnapshotId,
      owner_identity_id: request.ownerIdentityId,
      replenishment_lifecycle_id: request.replenishmentLifecycleId,
      quantity: request.quantity,
      status: request.status,
      due_date: request.dueDate
    }]);
    const store = makeStore(client);
    const openKey = {
      kind: 'unique' as const,
      table: 'restock_requests' as const,
      constraint: 'restock_requests_open_product_unique',
      values: { branchId: request.branchId, productId: request.productId }
    };

    const observed = await store.workflowTransaction(async (tx) => {
      const projectionReader = (tx as WorkflowTransactionContext).workflowProjectionReader;
      const before = await projectionReader.query<typeof request>(openKey);
      const next = { ...request, rowVersion: 2, status: 'cancelled' };
      const cas = await tx.compareAndSwap('restock_requests', request.id,
        { rowVersion: 1, state: 'open' }, next);
      const after = await projectionReader.query<typeof request>(openKey);
      return { before, cas, after };
    });

    expect(observed.before).toEqual([{ id: request.id, rowVersion: 1, body: request }]);
    expect(observed.cas).toMatchObject({ updated: true });
    expect(observed.after).toEqual([]);
    expect(client.rpcCalls).toHaveLength(1);
    expect(client.rpcCalls[0].name).toBe('nexus_workflow_commit');
  });

  it('combines exact CRM activity equality with owner, status, date, and cursor filters across stable pages', async () => {
    const client = new ControlledSupabaseClient();
    const opportunityId = 'supabase-activity-opportunity-current';
    const ownerIdentityId = 'supabase-activity-owner-current';
    client.rows.set('crm_activities', [
      crmActivityRow('activity-102', opportunityId, ownerIdentityId, 'open', '2026-10-03T09:00:00.000Z'),
      crmActivityRow('activity-104', 'supabase-activity-other-opportunity', ownerIdentityId, 'open', '2026-10-03T09:00:00.000Z'),
      crmActivityRow('activity-101', opportunityId, ownerIdentityId, 'open', '2026-10-02T09:00:00.000Z'),
      crmActivityRow('activity-105', opportunityId, 'supabase-activity-other-owner', 'open', '2026-10-03T09:00:00.000Z'),
      crmActivityRow('activity-106', opportunityId, ownerIdentityId, 'closed', '2026-10-03T09:00:00.000Z'),
      crmActivityRow('activity-107', opportunityId, ownerIdentityId, 'open', '2026-09-30T09:00:00.000Z'),
      crmActivityRow('activity-108', opportunityId, ownerIdentityId, 'open', '2026-10-06T09:00:00.000Z'),
      crmActivityRow('activity-099', opportunityId, ownerIdentityId, 'open', '2026-10-02T08:00:00.000Z')
    ]);
    const store = makeStore(client);
    const firstQuery: WorkflowStorageQuery = {
      kind: 'scoped',
      table: 'crm_activities',
      equals: { opportunityId },
      ownerId: ownerIdentityId,
      status: 'open',
      fromDate: '2026-10-01T00:00:00.000Z',
      throughDate: '2026-10-05T23:59:59.999Z',
      cursor: 'activity-100',
      limit: 1
    };

    const firstPage = await store.workflowProjectionReader.query(firstQuery);
    const secondPage = await store.workflowProjectionReader.query({ ...firstQuery, cursor: firstPage[0].id });

    expect(firstPage.map((row) => row.id)).toEqual(['activity-101']);
    expect(secondPage.map((row) => row.id)).toEqual(['activity-102']);
    const activityReads = client.reads.filter((read) => read.table === 'crm_activities');
    const filters = [
      { kind: 'eq', column: 'owner_identity_id', value: ownerIdentityId },
      { kind: 'eq', column: 'status', value: 'open' },
      { kind: 'gte', column: 'occurred_at', value: '2026-10-01T00:00:00.000Z' },
      { kind: 'lte', column: 'occurred_at', value: '2026-10-05T23:59:59.999Z' },
      { kind: 'gt', column: 'id', value: 'activity-100' },
      { kind: 'eq', column: 'opportunity_id', value: opportunityId }
    ];
    expect(activityReads.map((read) => read.filters)).toEqual([
      filters,
      filters.map((filter) => filter.column === 'id' ? { ...filter, value: 'activity-101' } : filter)
    ]);
    expect(activityReads.map((read) => read.columns)).toEqual(['id,row_version,body', 'id,row_version,body']);
    expect(client.reads.filter((read) => read.table === 'appmeta')).toHaveLength(4);
    expect(client.reads.every((read) => read.table === 'appmeta' || read.table === 'crm_activities')).toBe(true);
  });

  it('rejects a staged cursor row when the transaction cannot prove its backend page position', async () => {
    const client = new ControlledSupabaseClient();
    const opportunityId = 'supabase-collation-opportunity';
    const ownerIdentityId = 'supabase-collation-owner';
    const firstId = 'a-proof-cursor:00';
    const stagedId = 'A-proof-next:01';
    const lastId = 'z-proof-last:99';
    const firstActivity = crmActivityRow(firstId, opportunityId, ownerIdentityId, 'open', '2026-10-04T03:00:00.000Z');
    const lastActivity = crmActivityRow(lastId, opportunityId, ownerIdentityId, 'open', '2026-10-04T03:02:00.000Z');
    client.rows.set('crm_activities', [lastActivity, firstActivity]);
    const store = makeStore(client);
    const firstQuery: WorkflowStorageQuery = {
      kind: 'scoped', table: 'crm_activities', ownerId: ownerIdentityId,
      equals: { opportunityId }, limit: 1
    };
    const stagedActivity = {
      id: stagedId,
      rowVersion: 1,
      opportunityId,
      ownerIdentityId,
      status: 'open',
      occurredAt: '2026-10-04T03:01:00.000Z',
      kind: 'note',
      summary: 'Staged evidence between the page cursors.',
      createdAt: '2026-10-04T03:01:00.000Z'
    };
    const rowsBefore = JSON.stringify(client.rows.get('crm_activities'));
    let firstPage: ProjectedRow<typeof stagedActivity>[] | undefined;
    let secondPage: ProjectedRow<typeof stagedActivity>[] | undefined;
    let callbackCount = 0;

    const failure = await store.workflowTransaction(async (tx) => {
      callbackCount += 1;
      const reader = (tx as WorkflowTransactionContext).workflowProjectionReader;
      const databaseFirstPage = await reader.query<typeof stagedActivity>(firstQuery);
      firstPage = databaseFirstPage;
      await tx.insertUnique('crm_activities', stagedActivity, {
        constraint: 'crm_activities_primary_key', values: { id: stagedId }
      });
      const secondQuery = { ...firstQuery, cursor: databaseFirstPage[0].id };
      secondPage = await reader.query<typeof stagedActivity>(secondQuery);
    }).then(() => undefined, (error: unknown) => error);

    expect(failure).toMatchObject({ code: 'STORAGE', definitelyNotCommitted: true });
    expect(callbackCount).toBe(1);
    expect(firstPage?.map((row) => row.id)).toEqual([firstId]);
    expect(secondPage).toBeUndefined();
    expect(client.rpcCalls).toHaveLength(0);
    expect(JSON.stringify(client.rows.get('crm_activities'))).toBe(rowsBefore);

    const pageReads = client.reads.filter((read) => read.table === 'crm_activities'
      && read.filters.some((filter) => filter.column === 'opportunity_id' && filter.value === opportunityId));
    expect(pageReads.map((read) => read.filters)).toEqual([
      [
        { kind: 'eq', column: 'owner_identity_id', value: ownerIdentityId },
        { kind: 'eq', column: 'opportunity_id', value: opportunityId }
      ],
      [
        { kind: 'eq', column: 'owner_identity_id', value: ownerIdentityId },
        { kind: 'gt', column: 'id', value: firstId },
        { kind: 'eq', column: 'opportunity_id', value: opportunityId }
      ]
    ]);
    expect(pageReads.map((read) => read.order)).toEqual(Array.from({ length: 2 }, () => ({ column: 'id', ascending: true })));
    expect(pageReads.map((read) => read.range)).toEqual([[0, 0], [0, 0]]);
  });

  it('paginates backend-only mixed-case and punctuated IDs under the fake gt/order collation', async () => {
    const client = new ControlledSupabaseClient();
    const opportunityId = 'supabase-backend-pages-opportunity';
    const ownerIdentityId = 'supabase-backend-pages-owner';
    const firstId = 'a-proof-cursor:00';
    const middleId = 'A-proof-next:01';
    const lastId = 'z-proof-last:99';
    client.rows.set('crm_activities', [
      crmActivityRow(lastId, opportunityId, ownerIdentityId, 'open', '2026-10-04T03:02:00.000Z'),
      crmActivityRow(middleId, opportunityId, ownerIdentityId, 'open', '2026-10-04T03:01:00.000Z'),
      crmActivityRow(firstId, opportunityId, ownerIdentityId, 'open', '2026-10-04T03:00:00.000Z')
    ]);
    const store = makeStore(client);
    const firstQuery: WorkflowStorageQuery = {
      kind: 'scoped', table: 'crm_activities', ownerId: ownerIdentityId,
      equals: { opportunityId }, limit: 1
    };

    const pages = await store.workflowTransaction(async (tx) => {
      const reader = (tx as WorkflowTransactionContext).workflowProjectionReader;
      const firstPage = await reader.query<Record<string, unknown>>(firstQuery);
      const secondQuery = { ...firstQuery, cursor: firstPage[0].id };
      const secondPage = await reader.query<Record<string, unknown>>(secondQuery);
      const repeatedSecondPage = await reader.query<Record<string, unknown>>(secondQuery);
      const thirdPage = await reader.query<Record<string, unknown>>({ ...firstQuery, cursor: secondPage[0].id });
      return {
        first: firstPage.map((row) => row.id),
        second: secondPage.map((row) => row.id),
        repeatedSecond: repeatedSecondPage.map((row) => row.id),
        third: thirdPage.map((row) => row.id)
      };
    });

    expect(pages).toEqual({
      first: [firstId],
      second: [middleId],
      repeatedSecond: [middleId],
      third: [lastId]
    });
    expect(client.rpcCalls).toHaveLength(0);
    const pageReads = client.reads.filter((read) => read.table === 'crm_activities'
      && read.filters.some((filter) => filter.column === 'opportunity_id' && filter.value === opportunityId));
    expect(pageReads.map((read) => read.filters)).toEqual([
      [
        { kind: 'eq', column: 'owner_identity_id', value: ownerIdentityId },
        { kind: 'eq', column: 'opportunity_id', value: opportunityId }
      ],
      [
        { kind: 'eq', column: 'owner_identity_id', value: ownerIdentityId },
        { kind: 'gt', column: 'id', value: firstId },
        { kind: 'eq', column: 'opportunity_id', value: opportunityId }
      ],
      [
        { kind: 'eq', column: 'owner_identity_id', value: ownerIdentityId },
        { kind: 'gt', column: 'id', value: middleId },
        { kind: 'eq', column: 'opportunity_id', value: opportunityId }
      ]
    ]);
    expect(pageReads.map((read) => read.order)).toEqual(Array.from({ length: 3 }, () => ({ column: 'id', ascending: true })));
    expect(pageReads.map((read) => read.range)).toEqual([[0, 0], [0, 0], [0, 0]]);
  });

  it('fails closed when a transaction-bound scoped read observes revision changes on both attempts', async () => {
    const client = new ControlledSupabaseClient();
    const opportunityId = 'supabase-revision-interleave-opportunity';
    const ownerIdentityId = 'supabase-revision-interleave-owner';
    client.rows.set('crm_activities', [crmActivityRow(
      'supabase-revision-interleave-activity', opportunityId, ownerIdentityId, 'open', '2026-10-04T03:00:00.000Z'
    )]);
    client.onRead = (call) => {
      if (call.table === 'crm_activities') client.revision += 1;
    };
    const store = makeStore(client);
    let callbackCount = 0;
    const query: WorkflowStorageQuery = {
      kind: 'scoped', table: 'crm_activities', ownerId: ownerIdentityId,
      equals: { opportunityId }, limit: 10
    };

    await expect(store.workflowTransaction(async (tx) => {
      callbackCount += 1;
      return (tx as WorkflowTransactionContext).workflowProjectionReader.query(query);
    })).rejects.toMatchObject({ code: 'CONFLICT', definitelyNotCommitted: true });

    expect(callbackCount).toBe(2);
    expect(client.reads.filter((read) => read.table === 'crm_activities')).toHaveLength(2);
    expect(client.rpcCalls).toHaveLength(0);
  });

  it('rejects unsupported CRM, JSON, external equality, and org scopes before reading their data tables', async () => {
    const client = new ControlledSupabaseClient();
    const store = makeStore(client);
    const invalidQueries: Array<{ table: string; query: unknown }> = [
      {
        table: 'crm_activities',
        query: { kind: 'scoped', table: 'crm_activities', equals: { opportunityId: null } }
      },
      {
        table: 'crm_activities',
        query: { kind: 'scoped', table: 'crm_activities', equals: { unknownColumn: 'unexpected' } }
      },
      {
        table: 'conversations',
        query: { kind: 'scoped', table: 'conversations', equals: { lastScope: { region: 'east' } } }
      },
      {
        table: 'action_executions',
        query: { kind: 'scoped', table: 'action_executions', equals: { rootId: 'external-root-id' } }
      },
      {
        table: 'crm_activities',
        query: { kind: 'scoped', table: 'crm_activities', orgUnitId: 'unprojected-org-unit' }
      }
    ];

    for (const invalid of invalidQueries) {
      client.reads.length = 0;
      await expect(store.workflowProjectionReader.query(
        invalid.query as WorkflowStorageQuery
      )).rejects.toThrow();
      expect(client.reads.some((read) => read.table === invalid.table)).toBe(false);
    }
  });

  it('uses a native IS NULL filter for nullable conversation archivedAt', async () => {
    const client = new ControlledSupabaseClient();
    const actorId = 'supabase-conversation-actor';
    const openConversation: ConversationMetadata = {
      id: 'supabase-conversation-open',
      actorId,
      title: 'Open conversation',
      pinned: false,
      archivedAt: null,
      rowVersion: 1,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-02T00:00:00.000Z',
      lastScope: null,
      lastDashboardId: null
    };
    const archivedConversation: ConversationMetadata = {
      ...openConversation,
      id: 'supabase-conversation-archived',
      title: 'Archived conversation',
      archivedAt: '2026-10-02T01:00:00.000Z'
    };
    client.rows.set('conversations', [
      {
        id: openConversation.id, payload: openConversation, row_version: 1, actor_id: actorId,
        title: openConversation.title, pinned: false, archived_at: null,
        updated_at: openConversation.updatedAt, last_dashboard_id: null
      },
      {
        id: archivedConversation.id, payload: archivedConversation, row_version: 1, actor_id: actorId,
        title: archivedConversation.title, pinned: false, archived_at: archivedConversation.archivedAt,
        updated_at: archivedConversation.updatedAt, last_dashboard_id: null
      }
    ]);
    const store = makeStore(client);

    const rows = await store.workflowProjectionReader.query<ConversationMetadata>({
      kind: 'scoped', table: 'conversations', ownerId: actorId,
      equals: { archivedAt: null }, limit: 10
    });

    expect(rows).toEqual([{ id: openConversation.id, rowVersion: 1, body: openConversation }]);
    expect(client.reads.find((read) => read.table === 'conversations')?.filters).toEqual([
      { kind: 'eq', column: 'actor_id', value: actorId },
      { kind: 'is', column: 'archived_at', value: null }
    ]);
  });

  it('uses native actor, conversation, turn, and session equality filters for conversation messages', async () => {
    const client = new ControlledSupabaseClient();
    const actorId = 'supabase-message-actor';
    const conversationId = 'supabase-message-conversation';
    const turnId = 'supabase-message-turn';
    const sessionId = 'supabase-message-session';
    const matching: PersistedConversationMessage = {
      id: 'supabase-message-matching',
      conversationId,
      actorId,
      role: 'assistant',
      text: 'Prepared two proposals.',
      mode: 'scripted_demo',
      modeRevision: 2,
      createdAt: '2026-10-04T03:00:00.000Z',
      turnId,
      sessionId,
      pendingActionId: 'supabase-message-action-01',
      pendingActionIds: ['supabase-message-action-01', 'supabase-message-action-02']
    };
    const rows = [
      matching,
      { ...matching, id: 'supabase-message-wrong-actor', actorId: 'supabase-message-other-actor' },
      { ...matching, id: 'supabase-message-wrong-conversation', conversationId: 'supabase-message-other-conversation' },
      { ...matching, id: 'supabase-message-wrong-turn', turnId: 'supabase-message-other-turn' },
      { ...matching, id: 'supabase-message-wrong-session', sessionId: 'supabase-message-other-session' }
    ];
    client.rows.set('conversation_messages', rows.map((row) =>
      conversationMessageStorageRow(row as unknown as Record<string, unknown>)
    ));
    const store = makeStore(client);

    const found = await store.workflowProjectionReader.query<PersistedConversationMessage>({
      kind: 'scoped',
      table: 'conversation_messages',
      ownerId: actorId,
      equals: { conversationId, turnId, sessionId },
      limit: 20
    });

    expect(found).toEqual([{ id: matching.id, rowVersion: 1, body: matching }]);
    expect(client.reads.find((read) => read.table === 'conversation_messages')?.filters).toEqual([
      { kind: 'eq', column: 'actor_id', value: actorId },
      { kind: 'eq', column: 'conversation_id', value: conversationId },
      { kind: 'eq', column: 'turn_id', value: turnId },
      { kind: 'eq', column: 'session_id', value: sessionId }
    ]);
  });

  it('stages an assistant message with multiple action links and a conversation CAS without leaking cached clones', async () => {
    const client = new ControlledSupabaseClient();
    const actorId = 'supabase-staged-conversation-actor';
    const conversationId = 'supabase-staged-conversation';
    const turnId = 'supabase-staged-turn';
    const sessionId = 'supabase-staged-session';
    const originalAnalysis = conversationAnalysis('conversation-original-evidence');
    const currentConversation: PersistedConversation = {
      id: conversationId,
      actorId,
      title: 'Action review',
      pinned: false,
      pinnedAt: null,
      archivedAt: null,
      rowVersion: 1,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-03T00:00:00.000Z',
      lastScope: null,
      lastDashboardId: null,
      lastAnalysis: originalAnalysis
    };
    const assistantMessage: PersistedConversationMessage = {
      id: 'supabase-staged-assistant-message',
      conversationId,
      actorId,
      role: 'assistant',
      text: 'I prepared both proposals for review.',
      mode: 'scripted_demo',
      modeRevision: 2,
      createdAt: '2026-10-04T03:01:00.000Z',
      analysis: conversationAnalysis('assistant-message-evidence'),
      turnId,
      sessionId,
      pendingActionId: 'supabase-staged-action-01',
      pendingActionIds: ['supabase-staged-action-01', 'supabase-staged-action-02'],
      rowVersion: 1
    };
    const updatedConversation: PersistedConversation & { rowVersion: number } = {
      ...currentConversation,
      pinned: true,
      pinnedAt: '2026-10-04T03:02:00.000Z',
      updatedAt: '2026-10-04T03:02:00.000Z',
      lastAnalysis: {
        ...conversationAnalysis('conversation-updated-evidence'),
        facts: [{ text: 'Two proposals were prepared.', sourceIds: ['conversation:action-review'] }]
      },
      rowVersion: 2
    };
    client.rows.set('conversations', [conversationStorageRow(currentConversation as Record<string, unknown>)]);
    const store = makeStore(client);
    const messageQuery: WorkflowStorageQuery = {
      kind: 'scoped',
      table: 'conversation_messages',
      ownerId: actorId,
      equals: { conversationId, turnId, sessionId },
      limit: 20
    };

    const observed = await store.workflowTransaction(async (tx) => {
      const projectionReader = (tx as WorkflowTransactionContext).workflowProjectionReader;
      const inserted = await tx.insertUnique('conversation_messages', assistantMessage, {
        constraint: 'conversation_messages_primary_key',
        values: { id: assistantMessage.id }
      });
      const firstMessageQuery = await projectionReader.query<PersistedConversationMessage>(messageQuery);
      firstMessageQuery[0].body.pendingActionIds?.push('supabase-staged-caller-mutation');
      const cachedMessageQuery = await projectionReader.query<PersistedConversationMessage>(messageQuery);

      const firstConversation = await projectionReader.get<PersistedConversation>('conversations', conversationId);
      if (!firstConversation) throw new Error('Expected seeded conversation projection');
      firstConversation.body.lastAnalysis?.facts.push({ text: 'Caller mutation.', sourceIds: [] });
      const cachedConversation = await projectionReader.get<PersistedConversation>('conversations', conversationId);
      if (!cachedConversation) throw new Error('Expected cached conversation projection');
      const cas = await tx.compareAndSwap('conversations', conversationId,
        { rowVersion: 1, state: null }, updatedConversation);
      const afterConversation = await projectionReader.get<PersistedConversation>('conversations', conversationId);
      const afterMessages = await projectionReader.query<PersistedConversationMessage>(messageQuery);
      return { inserted, cachedMessageQuery, cachedConversation, cas, afterConversation, afterMessages };
    });

    expect(observed.inserted).toMatchObject({ inserted: true, row: assistantMessage });
    expect(observed.cachedMessageQuery).toEqual([{ id: assistantMessage.id, rowVersion: 1, body: assistantMessage }]);
    expect(observed.cachedConversation.body.lastAnalysis).toEqual(originalAnalysis);
    expect(observed.cas).toMatchObject({ updated: true });
    expect(observed.afterConversation).toEqual({
      id: conversationId,
      rowVersion: 2,
      body: updatedConversation
    });
    expect(observed.afterMessages).toEqual([{ id: assistantMessage.id, rowVersion: 1, body: assistantMessage }]);
    expect(client.rpcCalls).toHaveLength(1);
    expect(client.rpcCalls[0].name).toBe('nexus_workflow_commit');
    const operations = client.rpcCalls[0].args.operations as Array<Record<string, unknown>>;
    expect(operations.map(({ kind, table }) => ({ kind, table }))).toEqual([
      { kind: 'insert_unique', table: 'conversation_messages' },
      { kind: 'cas', table: 'conversations' }
    ]);
    expect(operations[0].row).toEqual({ id: assistantMessage.id, rowVersion: 1, body: assistantMessage });
    expect(operations[1]).toMatchObject({
      id: conversationId,
      expected: { rowVersion: 1, state: null },
      next: { id: conversationId, rowVersion: 2, body: updatedConversation }
    });
  });

  it('rejects malformed conversation message IDs, action arrays, and strict analysis before the commit RPC', async () => {
    const baseMessage: PersistedConversationMessage = {
      id: 'supabase-invalid-message-base',
      conversationId: 'supabase-invalid-conversation',
      actorId: 'supabase-invalid-actor',
      role: 'assistant',
      text: 'A proposal is ready.',
      mode: 'scripted_demo',
      modeRevision: 2,
      createdAt: '2026-10-04T03:00:00.000Z',
      analysis: conversationAnalysis(),
      turnId: 'supabase-invalid-turn',
      sessionId: 'supabase-invalid-session',
      pendingActionId: 'supabase-invalid-action-01',
      pendingActionIds: ['supabase-invalid-action-01']
    };
    const invalidMessages: Array<{ label: string; body: Record<string, unknown> }> = [
      { label: 'invalid turn ID', body: { ...baseMessage, turnId: 'turn id with spaces' } },
      { label: 'invalid session ID', body: { ...baseMessage, sessionId: 'session id with spaces' } },
      { label: 'duplicate action IDs', body: { ...baseMessage, pendingActionIds: ['supabase-invalid-action-01', 'supabase-invalid-action-01'] } },
      { label: 'oversized action ID array', body: { ...baseMessage, pendingActionIds: Array.from({ length: 101 }, (_, index) => `supabase-invalid-action-${index}`) } },
      { label: 'extra strict analysis field', body: { ...baseMessage, analysis: { ...conversationAnalysis(), privateExtra: 'reject-me' } } }
    ];
    expect(invalidMessages).toHaveLength(5);

    for (const invalid of invalidMessages) {
      const client = new ControlledSupabaseClient();
      const store = makeStore(client);
      const failure = await store.workflowTransaction((tx) => tx.insertUnique(
        'conversation_messages', invalid.body as { id: string },
        { constraint: 'conversation_messages_primary_key', values: { id: baseMessage.id } }
      )).then(() => undefined, (error: unknown) => error);

      expect(failure, invalid.label).toMatchObject({ code: 'STORAGE', definitelyNotCommitted: true });
      expect(client.reads.some((read) => read.table === 'conversation_messages')).toBe(false);
      expect(client.rpcCalls).toHaveLength(0);
    }

    const client = new ControlledSupabaseClient();
    const currentConversation: PersistedConversation = {
      id: 'supabase-invalid-analysis-conversation',
      actorId: 'supabase-invalid-analysis-actor',
      title: 'Analysis validation',
      pinned: false,
      archivedAt: null,
      rowVersion: 1,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-03T00:00:00.000Z',
      lastScope: null,
      lastDashboardId: null,
      lastAnalysis: conversationAnalysis()
    };
    client.rows.set('conversations', [conversationStorageRow(currentConversation as Record<string, unknown>)]);
    const store = makeStore(client);
    const badAnalysisConversation = {
      ...currentConversation,
      lastAnalysis: { ...conversationAnalysis(), privateExtra: 'reject-me' },
      rowVersion: 2
    };

    await expect(store.workflowTransaction((tx) => tx.compareAndSwap('conversations', currentConversation.id,
      { rowVersion: 1, state: null }, badAnalysisConversation
    ))).rejects.toMatchObject({ code: 'STORAGE', definitelyNotCommitted: true });
    expect(client.rpcCalls).toHaveLength(0);
    expect(client.rows.get('conversations')).toEqual([conversationStorageRow(currentConversation as Record<string, unknown>)]);
  });

  it('keeps conversation commit conflicts definite and dispatched failures unknown without replay', async () => {
    const actorId = 'supabase-conversation-commit-actor';
    const conversationId = 'supabase-conversation-commit-row';
    const currentConversation: PersistedConversation = {
      id: conversationId,
      actorId,
      title: 'Commit outcome',
      pinned: false,
      archivedAt: null,
      rowVersion: 1,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-03T00:00:00.000Z',
      lastScope: null,
      lastDashboardId: null
    };
    const assistantMessage: PersistedConversationMessage = {
      id: 'supabase-conversation-commit-message',
      conversationId,
      actorId,
      role: 'assistant',
      text: 'Proposal stored.',
      mode: 'scripted_demo',
      modeRevision: 2,
      createdAt: '2026-10-04T03:00:00.000Z',
      turnId: 'supabase-conversation-commit-turn',
      sessionId: 'supabase-conversation-commit-session',
      pendingActionId: 'supabase-conversation-commit-action-01',
      pendingActionIds: ['supabase-conversation-commit-action-01', 'supabase-conversation-commit-action-02']
    };
    const nextConversation = {
      ...currentConversation,
      pinned: true,
      pinnedAt: '2026-10-04T03:01:00.000Z',
      rowVersion: 2
    };
    const commit = (client: ControlledSupabaseClient) => {
      client.rows.set('conversations', [conversationStorageRow(currentConversation as Record<string, unknown>)]);
      const store = makeStore(client);
      return store.workflowTransaction(async (tx) => {
        await tx.insertUnique('conversation_messages', assistantMessage, {
          constraint: 'conversation_messages_primary_key',
          values: { id: assistantMessage.id }
        });
        await tx.compareAndSwap('conversations', conversationId,
          { rowVersion: 1, state: null }, nextConversation);
      });
    };

    const conflictClient = new ControlledSupabaseClient();
    conflictClient.rpcResult = { data: null, error: { code: '40001', message: 'revision conflict' } };
    const conflict = await commit(conflictClient).then(() => undefined, (error: unknown) => error);
    expect(conflict).toMatchObject({ code: 'CONFLICT', definitelyNotCommitted: true });
    expect(conflictClient.rpcCalls).toHaveLength(1);
    expect(conflictClient.rows.get('conversations')).toEqual([conversationStorageRow(currentConversation as Record<string, unknown>)]);

    const unknownClient = new ControlledSupabaseClient();
    unknownClient.rpcFailure = new Error('connection ended after dispatch');
    const unknown = await commit(unknownClient).then(() => undefined, (error: unknown) => error);
    expect(unknown).toMatchObject({ code: 'STORAGE', definitelyNotCommitted: false });
    expect((unknown as Error).message).not.toContain('connection ended after dispatch');
    expect(unknownClient.rpcCalls).toHaveLength(1);
    expect(unknownClient.rows.get('conversations')).toEqual([conversationStorageRow(currentConversation as Record<string, unknown>)]);
  });

  it('reads legacy conversation rows without inventing newer conversation or message metadata', async () => {
    const client = new ControlledSupabaseClient();
    const actorId = 'supabase-legacy-conversation-actor';
    const legacyConversation: PersistedConversation = {
      id: 'supabase-legacy-conversation',
      actorId,
      title: 'Historical chat',
      pinned: false,
      archivedAt: null,
      rowVersion: 4,
      createdAt: '2026-09-20T00:00:00.000Z',
      updatedAt: '2026-09-21T00:00:00.000Z',
      lastScope: null,
      lastDashboardId: null
    };
    const legacyMessage: PersistedConversationMessage = {
      id: 'supabase-legacy-message',
      conversationId: legacyConversation.id,
      actorId,
      role: 'assistant',
      text: 'Historical assistant response.',
      mode: 'scripted_demo',
      modeRevision: 1,
      createdAt: '2026-09-20T00:01:00.000Z',
      pendingActionId: 'supabase-legacy-action'
    };
    client.rows.set('conversations', [conversationStorageRow(legacyConversation as Record<string, unknown>)]);
    client.rows.set('conversation_messages', [conversationMessageStorageRow(legacyMessage as Record<string, unknown>)]);
    const store = makeStore(client);

    const conversation = await store.workflowProjectionReader.get<PersistedConversation>('conversations', legacyConversation.id);
    const messages = await store.workflowProjectionReader.query<PersistedConversationMessage>({
      kind: 'scoped', table: 'conversation_messages', ownerId: actorId,
      equals: { conversationId: legacyConversation.id }, limit: 10
    });

    expect(conversation?.body).toEqual(legacyConversation);
    expect(Object.hasOwn(conversation?.body ?? {}, 'pinnedAt')).toBe(false);
    expect(Object.hasOwn(conversation?.body ?? {}, 'lastAnalysis')).toBe(false);
    expect(messages).toEqual([{ id: legacyMessage.id, rowVersion: 1, body: legacyMessage }]);
    for (const field of ['turnId', 'sessionId', 'pendingActionIds']) {
      expect(Object.hasOwn(messages[0].body, field), field).toBe(false);
    }
  });

  it('keeps a scoped query and returned clones isolated while a matching activity is staged through CAS', async () => {
    const client = new ControlledSupabaseClient();
    const opportunityId = 'supabase-cas-activity-opportunity';
    const current = crmActivityRow(
      'supabase-cas-activity-current', opportunityId, 'supabase-cas-activity-owner', 'open',
      '2026-10-02T09:00:00.000Z', 'Original activity summary'
    );
    const nonmatching = crmActivityRow(
      'supabase-cas-activity-other', 'supabase-cas-activity-other-opportunity',
      'supabase-cas-activity-owner', 'open', '2026-10-02T09:00:00.000Z', 'Other activity summary'
    );
    client.rows.set('crm_activities', [nonmatching, current]);
    const store = makeStore(client);
    const query: WorkflowStorageQuery = {
      kind: 'scoped', table: 'crm_activities', equals: { opportunityId }, limit: 10
    };

    const observed = await store.workflowTransaction(async (tx) => {
      const projectionReader = (tx as WorkflowTransactionContext).workflowProjectionReader;
      const before = await projectionReader.query<{
        id: string; rowVersion: number; opportunityId: string; ownerIdentityId: string | null;
        status: string | null; occurredAt: string; kind: string; summary: string; createdAt: string;
      }>(query);
      before[0].body.summary = 'Caller changed its returned clone';
      const cachedClone = await projectionReader.query<typeof before[number]['body']>(query);
      const next = { ...cachedClone[0].body, rowVersion: 2, summary: 'Staged activity summary' };
      const cas = await tx.compareAndSwap('crm_activities', next.id,
        { rowVersion: 1, state: 'open' }, next);
      const after = await projectionReader.query<typeof next>(query);
      return { cachedClone, cas, after };
    });

    expect(observed.cachedClone[0].body.summary).toBe('Original activity summary');
    expect(observed.cas).toMatchObject({ updated: true });
    expect(observed.after).toEqual([{
      id: 'supabase-cas-activity-current',
      rowVersion: 2,
      body: { ...(current.body as Record<string, unknown>), rowVersion: 2, summary: 'Staged activity summary' }
    }]);
    expect(observed.after.some((row) => row.id === 'supabase-cas-activity-other')).toBe(false);
    const activityReads = client.reads.filter((read) => read.table === 'crm_activities');
    expect(activityReads).toHaveLength(2);
    for (const read of activityReads) {
      expect(read.filters).toContainEqual({ kind: 'eq', column: 'opportunity_id', value: opportunityId });
    }
    expect(client.rpcCalls).toHaveLength(1);
    expect(client.rpcCalls[0].name).toBe('nexus_workflow_commit');
  });

  it('quarantines flagged or missing legacy ticket projections while V1 get and list still read historical rows', async () => {
    const client = new ControlledSupabaseClient();
    const legacyBody = (id: string) => ({ id, title: `Historical ${id}`, status: 'open' });
    client.rows.set('mock_tickets', [
      {
        id: 'supabase-ticket-v2-flagged', payload: legacyBody('supabase-ticket-v2-flagged'),
        row_version: 1, workflow_contract_version: 2, legacy_assignee_quarantined: 1
      },
      {
        id: 'supabase-ticket-v2-missing-flag', payload: legacyBody('supabase-ticket-v2-missing-flag'),
        row_version: 1, workflow_contract_version: 2
      },
      {
        id: 'supabase-ticket-v1-flagged', payload: legacyBody('supabase-ticket-v1-flagged'),
        workflow_contract_version: null, legacy_assignee_quarantined: 1
      },
      {
        id: 'supabase-ticket-v1-missing-flag', payload: legacyBody('supabase-ticket-v1-missing-flag'),
        workflow_contract_version: null
      }
    ]);
    const store = makeStore(client);

    for (const id of ['supabase-ticket-v2-flagged', 'supabase-ticket-v2-missing-flag']) {
      await expect(store.workflowProjectionReader.get('mock_tickets', id)).rejects.toThrow();
    }
    expect(await store.get('mock_tickets', 'supabase-ticket-v1-flagged')).toEqual(
      legacyBody('supabase-ticket-v1-flagged')
    );
    expect(await store.get('mock_tickets', 'supabase-ticket-v1-missing-flag')).toEqual(
      legacyBody('supabase-ticket-v1-missing-flag')
    );
    expect(await store.list('mock_tickets')).toEqual([
      legacyBody('supabase-ticket-v1-flagged'),
      legacyBody('supabase-ticket-v1-missing-flag')
    ]);
    expect(client.reads.filter((read) => read.table === 'mock_tickets').some((read) =>
      read.filters.some((filter) => filter.kind === 'is' && filter.column === 'workflow_contract_version' && filter.value === null)
    )).toBe(true);
  });

  it('rejects non-accepted and incomplete new documents before RPC with definite no-commit certainty', async () => {
    const client = new ControlledSupabaseClient();
    const store = makeStore(client);
    const acceptedDocument = {
      id: 'supabase-document-valid-shape',
      rowVersion: 1,
      requestId: 'supabase-document-request',
      employeeId: 'supabase-document-employee',
      documentType: 'identity_document',
      status: 'accepted',
      policyVersion: '1.0',
      classification: 'internal',
      contentDigest: 'a'.repeat(64),
      createdAt: '2026-10-01T00:00:00.000Z',
      withdrawnAt: null
    };
    const withoutEmployee = { ...acceptedDocument } as Record<string, unknown>;
    delete withoutEmployee.employeeId;
    const candidates = [
      { label: 'non-accepted initial state', row: { ...acceptedDocument, id: 'supabase-document-received', documentType: 'received_document', status: 'received' } },
      { label: 'missing required employeeId', row: { ...withoutEmployee, id: 'supabase-document-incomplete', documentType: 'incomplete_document' } }
    ];

    for (const candidate of candidates) {
      client.reads.length = 0;
      const failure = await store.workflowTransaction((tx) => tx.insertUnique(
        'onboarding_documents', candidate.row as { id: string },
        {
          constraint: 'onboarding_documents_request_type_unique',
          values: { requestId: acceptedDocument.requestId, documentType: candidate.row.documentType as string }
        }
      )).then(() => undefined, (error: unknown) => error);

      expect(failure, candidate.label).toMatchObject({ code: 'STORAGE', definitelyNotCommitted: true });
      expect(client.reads.some((read) => read.table === 'onboarding_documents')).toBe(false);
      expect(client.rpcCalls).toHaveLength(0);
    }
  });
});
