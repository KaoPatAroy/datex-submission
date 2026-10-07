import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cookieHarness = vi.hoisted(() => ({
  value: undefined as string | undefined,
  setCalls: [] as Array<{ name: string; value: string; options?: Record<string, unknown> }>,
  deleteCalls: [] as string[],
}));

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get(name: string) {
      return name === 'biztania_session' && cookieHarness.value !== undefined
        ? { name, value: cookieHarness.value }
        : undefined;
    },
    set(name: string, value: string, options?: Record<string, unknown>) {
      cookieHarness.value = value;
      cookieHarness.setCalls.push({ name, value, options });
    },
    delete(name: string) {
      cookieHarness.deleteCalls.push(name);
      if (name === 'biztania_session') cookieHarness.value = undefined;
    },
  }),
}));

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Profile } from '../lib/contracts';
import { type SessionRow } from '../lib/core/auth';
import { digest } from '../lib/core/utils';
import { getWorkflowProjection } from '../lib/storage/workflow-projections';
import { createSupabaseStoreFromClient } from '../lib/storage/supabase';
import {
  actorSession,
  changeMode,
  login,
  logout,
} from '../lib/server/session';
import { getWorkflowActionAuthority } from '../lib/workflows/action-authority';
import {
  createWorkflowActionRuntime,
  defineWorkflowBinding,
  workflowApprovalHash,
  workflowSemanticRoot,
  type RuntimeReadContext,
} from '../lib/workflows/action-runtime';
import { createWorkflowActionRunner } from '../lib/workflows/action-runner';
import {
  pendingActionV2Schema,
  type PendingActionV2,
  type WorkflowStorageTable,
} from '../lib/workflows/contracts';
import { getDemoWorkflowPolicyV1Pin } from '../lib/workflows/policy';

const COOKIE_NAME = 'biztania_session';
const ACCESS_CODE = 'supabase-session-test-access-code';
const SESSION_SECRET = 'supabase-session-test-secret-long-enough-for-hmac';
const PROFILE_ID = 'session-supa-profile';
const CONVERSATION_ID = 'session-supa-conversation';
const ORG_UNIT_ID = 'session-supa-org-unit';
const IDENTITY_ID = 'session-supa-identity';
const ACTION_ID = 'session-supa-v2-action';
const TURN_ID = 'session-supa-turn';
const PACK = {
  id: 'session-supa-test-pack',
  version: '1.0',
  schemaDigest: 'b'.repeat(64),
  implementationRevision: 'session-supa-test-r1',
};

type Filter = { kind: 'eq' | 'in' | 'is' | 'gt' | 'gte' | 'lte'; column: string; value: unknown };
type DatabaseRow = Record<string, unknown> & { id: string };
type ReadCall = { table: string; filters: Filter[]; columns: string };
type QueryResult = { data: unknown; error: unknown };

function pathValue(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function makeStoredRow(
  table: string,
  body: Record<string, unknown>,
  rowVersion = 1,
): DatabaseRow {
  const definition = getWorkflowProjection(table as WorkflowStorageTable);
  const row: DatabaseRow = { id: String(body.id), row_version: rowVersion };
  row[definition.bodyColumn] = body;
  for (const column of definition.columns) {
    if (column.external || column.legacyOnly) continue;
    const value = pathValue(body, column.bodyField);
    if (value !== undefined) row[column.column] = value;
  }
  if (definition.storage === 'mixed') {
    row.workflow_contract_version = body.contractVersion === 2 || typeof body.correlationId === 'string' ? 2 : null;
  }
  return row;
}

class ControlledSessionSupabaseClient {
  revision = 10;
  readonly rows = new Map<string, DatabaseRow[]>();
  readonly reads: ReadCall[] = [];
  readonly rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

  from(table: string): ControlledSessionQuery {
    return new ControlledSessionQuery(this, table);
  }

  async read(call: ReadCall): Promise<QueryResult> {
    this.reads.push({ ...call, filters: [...call.filters] });
    if (call.table === 'appmeta') {
      const singleton = call.filters.find((filter) => filter.column === 'singleton')?.value;
      return { data: singleton === 1 ? { singleton: 1, revision: this.revision } : null, error: null };
    }

    const rows = [...(this.rows.get(call.table) ?? [])].filter((row) => call.filters.every((filter) => {
      const field = filter.column.startsWith('payload->>')
        ? filter.column.slice('payload->>'.length)
        : filter.column;
      const actual = field === 'payload'
        ? row.payload
        : Object.prototype.hasOwnProperty.call(row, field)
          ? row[field]
          : pathValue(row.payload ?? row.body, field);
      switch (filter.kind) {
        case 'eq': return actual === filter.value;
        case 'in': return Array.isArray(filter.value) && filter.value.includes(actual);
        case 'is': return filter.value === null && (actual === null || actual === undefined);
        case 'gt': return typeof actual === 'string' && typeof filter.value === 'string' && actual.localeCompare(filter.value, 'en-US') > 0;
        case 'gte': return typeof actual === 'string' && typeof filter.value === 'string' && actual.localeCompare(filter.value, 'en-US') >= 0;
        case 'lte': return typeof actual === 'string' && typeof filter.value === 'string' && actual.localeCompare(filter.value, 'en-US') <= 0;
      }
    }));
    return { data: rows, error: null };
  }

  async rpc(name: string, args: Record<string, unknown>): Promise<QueryResult> {
    this.rpcCalls.push({ name, args });
    if (name === 'nexus_commit') {
      const changes = args.changes as Array<{ table: string; id: string; payload: Record<string, unknown> | null }>;
      for (const change of changes) {
        if (change.payload === null) {
          this.rows.set(change.table, (this.rows.get(change.table) ?? []).filter((row) => row.id !== change.id));
          continue;
        }
        const previous = (this.rows.get(change.table) ?? []).find((row) => row.id === change.id);
        this.upsert(change.table, change.payload, Number(previous?.row_version ?? 0) + 1);
      }
      this.revision += 1;
    } else if (name === 'nexus_workflow_commit') {
      const operations = args.operations as Array<Record<string, unknown>>;
      for (const operation of operations) {
        const table = String(operation.table);
        if (operation.kind === 'insert_unique') {
          const row = operation.row as { id: string; rowVersion: number; body: Record<string, unknown> };
          this.upsert(table, row.body, row.rowVersion);
        } else if (operation.kind === 'cas') {
          const next = operation.next as { id: string; rowVersion: number; body: Record<string, unknown> };
          this.upsert(table, next.body, next.rowVersion);
        }
      }
      this.revision += 1;
    }
    return { data: null, error: null };
  }

  seed(table: string, body: Record<string, unknown>, rowVersion = 1): void {
    this.upsert(table, body, rowVersion);
  }

  private upsert(table: string, body: Record<string, unknown>, rowVersion: number): void {
    const row = makeStoredRow(table, body, rowVersion);
    this.rows.set(table, [...(this.rows.get(table) ?? []).filter((item) => item.id !== row.id), row]);
  }
}

class ControlledSessionQuery implements PromiseLike<QueryResult> {
  private filters: Filter[] = [];
  private columns = '*';
  private rangeValue: [number, number] | undefined;
  private orderValue: { column: string; ascending: boolean } | undefined;

  constructor(private readonly client: ControlledSessionSupabaseClient, private readonly table: string) {}

  select(columns = '*'): this { this.columns = columns; return this; }
  eq(column: string, value: unknown): this { this.filters.push({ kind: 'eq', column, value }); return this; }
  in(column: string, value: unknown[]): this { this.filters.push({ kind: 'in', column, value }); return this; }
  is(column: string, value: unknown): this { this.filters.push({ kind: 'is', column, value }); return this; }
  gt(column: string, value: unknown): this { this.filters.push({ kind: 'gt', column, value }); return this; }
  gte(column: string, value: unknown): this { this.filters.push({ kind: 'gte', column, value }); return this; }
  lte(column: string, value: unknown): this { this.filters.push({ kind: 'lte', column, value }); return this; }
  order(column = 'id', options: { ascending?: boolean } = {}): this {
    this.orderValue = { column, ascending: options.ascending ?? true };
    return this;
  }
  range(from: number, to: number): this { this.rangeValue = [from, to]; return this; }

  async single(): Promise<QueryResult> { return this.singleResult(); }
  async maybeSingle(): Promise<QueryResult> { return this.singleResult(); }
  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private async singleResult(): Promise<QueryResult> {
    const result = await this.execute();
    return { ...result, data: Array.isArray(result.data) ? result.data[0] ?? null : result.data };
  }

  private async execute(): Promise<QueryResult> {
    const result = await this.client.read({ table: this.table, filters: [...this.filters], columns: this.columns });
    if (!Array.isArray(result.data)) return result;
    let rows = [...result.data] as Array<Record<string, unknown>>;
    if (this.orderValue) {
      const { column, ascending } = this.orderValue;
      rows.sort((left, right) => {
        const comparison = String(left[column]).localeCompare(String(right[column]), 'en-US');
        return ascending ? comparison : -comparison;
      });
    }
    if (this.rangeValue) {
      const [start, end] = this.rangeValue;
      rows = rows.slice(start, end + 1);
    }
    return { ...result, data: rows };
  }
}

type SessionTestStore = ReturnType<typeof createSupabaseStoreFromClient>;

function makeStore(client: ControlledSessionSupabaseClient): SessionTestStore {
  return createSupabaseStoreFromClient(client as unknown as SupabaseClient);
}

function profile(): Profile {
  return {
    id: PROFILE_ID,
    name: 'Supabase session history test profile',
    role: 'hr_admin',
    active: true,
    permissions: ['hr.policy.assign', 'hr.read'],
    regions: [],
  };
}

async function seedProfile(client: ControlledSessionSupabaseClient): Promise<void> {
  client.seed('profiles', profile() as unknown as Record<string, unknown>);
}

async function newSession(store: SessionTestStore): Promise<SessionRow> {
  await login(store, PROFILE_ID, ACCESS_CODE);
  return (await actorSession(store)).session;
}

function pendingV2Action(sessionId: string, now: Date): PendingActionV2 {
  const payload = {
    kind: 'policy_acknowledgement_assign' as const,
    policyDocumentId: 'session-supa-policy-document',
    policyVersion: 'r1',
    targets: [{
      employeeId: 'session-supa-employee',
      ownerIdentityId: IDENTITY_ID,
      reason: 'Review the current policy.',
      dueDate: '2099-10-10',
      priority: 'normal' as const,
    }],
  };
  const semanticKey = digest({ kind: payload.kind, employeeId: payload.targets[0].employeeId, ownerIdentityId: IDENTITY_ID });
  const action = pendingActionV2Schema.parse({
    id: ACTION_ID,
    contractVersion: 2,
    actorId: PROFILE_ID,
    sessionId,
    conversationId: CONVERSATION_ID,
    turnId: TURN_ID,
    mode: 'live_ai',
    modeRevision: 0,
    payload,
    payloadHash: '0'.repeat(64),
    idempotencyKey: workflowSemanticRoot(payload.kind, [{ semanticKey }]),
    targets: [{
      targetId: 'session-supa-target',
      ref: { table: 'employees', id: payload.targets[0].employeeId },
      semanticKey,
      expectedRows: [],
      ownerIdentityId: IDENTITY_ID,
      expectedEffectRef: { table: 'policy_acknowledgement_tasks', id: 'session-supa-effect' },
      expectedEffectVersion: 1,
    }],
    targetCount: 1,
    expectedRows: [],
    approvedBranchIds: [],
    approvedOrgUnitIds: [ORG_UNIT_ID],
    reviewedSnapshotId: null,
    policy: getDemoWorkflowPolicyV1Pin(),
    packs: [PACK],
    releaseRevision: 'session-supa-test-release-r1',
    executionMode: 'atomic_local',
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
    status: 'pending',
  });
  action.payloadHash = workflowApprovalHash(action);
  return action;
}

function legacyPendingAction(sessionId: string, createdAt: string): Record<string, unknown> {
  return {
    id: 'session-supa-v1-action',
    actorId: PROFILE_ID,
    sessionId,
    conversationId: CONVERSATION_ID,
    turnId: 'session-supa-v1-turn',
    mode: 'live_ai',
    modeRevision: 0,
    payload: { kind: 'create_dashboard', title: 'Legacy action' },
    payloadHash: 'legacy-hash',
    evidenceVersion: null,
    packs: [],
    createdAt,
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    status: 'pending',
    preview: 'Legacy pending action',
  };
}

function seedWorkflowAuthority(client: ControlledSessionSupabaseClient, createdAt: string): void {
  client.seed('conversations', {
    id: CONVERSATION_ID,
    actorId: PROFILE_ID,
    title: 'Session history test conversation',
    pinned: false,
    archivedAt: null,
    rowVersion: 1,
    createdAt,
    updatedAt: createdAt,
    lastScope: null,
    lastDashboardId: null,
  });
  client.seed('org_units', {
    id: ORG_UNIT_ID,
    name: 'Session history test organization',
    parentOrgUnitId: null,
    active: true,
  });
  client.seed('directory_identities', {
    id: IDENTITY_ID,
    profileId: PROFILE_ID,
    displayName: 'Session history test identity',
    active: true,
    role: 'hr_admin',
    department: 'hr',
    orgUnitId: ORG_UNIT_ID,
    managerIdentityId: null,
    verifiedDemoEmail: 'session-supa@example.invalid',
    slackIdentity: null,
    allowedChannels: ['simulated_email'],
    classificationCeiling: 'internal',
    rowVersion: 1,
  });
  client.seed('responsibilities', {
    id: 'session-supa-responsibility',
    identityId: IDENTITY_ID,
    orgUnitId: ORG_UNIT_ID,
    purpose: 'hr_operations',
    branchIds: [],
    active: true,
    rowVersion: 1,
  });
}

function makeStaleConfirmRunner(store: SessionTestStore, action: PendingActionV2, now: Date) {
  const authority = getWorkflowActionAuthority('policy_acknowledgement_assign');
  const binding = defineWorkflowBinding({
    kind: 'policy_acknowledgement_assign',
    contractVersion: 2,
    packIds: [PACK.id],
    executionMode: 'atomic_local',
    authority: { permission: authority.permission, roles: [...authority.roles], purpose: authority.purpose },
    async identify(_context: RuntimeReadContext, payload) {
      return { targets: payload.targets.map((target) => ({
        targetId: 'session-supa-target',
        ref: { table: 'employees' as const, id: target.employeeId },
        semanticKey: digest({ kind: payload.kind, employeeId: target.employeeId, ownerIdentityId: IDENTITY_ID }),
        scope: { orgUnitId: ORG_UNIT_ID },
      })) };
    },
    expectedPostconditions: () => [],
    async validate() { throw new Error('Mode revision must deny before validation.'); },
    async executeAtomic() { throw new Error('Mode revision must deny before execution.'); },
    async verify() { throw new Error('Mode revision must deny before verification.'); },
    async currentStates() { return []; },
  });
  const runtime = createWorkflowActionRuntime({
    store,
    bindings: [binding],
    businessDate: now.toISOString().slice(0, 10),
    getReleaseRevision: () => action.releaseRevision,
    getPackPins: (packIds) => packIds.map(() => ({ ...PACK })),
    contextFactory: () => ({
      evidence: async () => { throw new Error('Evidence should not be read by stale confirmation.'); },
      latestDashboard: async () => undefined,
    }),
    now: () => new Date(now.getTime()),
  });
  return createWorkflowActionRunner(runtime);
}

beforeEach(() => {
  cookieHarness.value = undefined;
  cookieHarness.setCalls.length = 0;
  cookieHarness.deleteCalls.length = 0;
  vi.stubEnv('DEMO_SESSION_SECRET', SESSION_SECRET);
  vi.stubEnv('DEMO_ACCESS_CODE', ACCESS_CODE);
  vi.stubEnv('NODE_ENV', 'test');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('session history with the controlled Supabase adapter', () => {
  it('rotates a valid login cookie while retaining the expired session referenced by a V2 action', async () => {
    const client = new ControlledSessionSupabaseClient();
    await seedProfile(client);
    const store = makeStore(client);
    const oldSession = await newSession(store);
    const oldCookie = cookieHarness.value;
    expect(oldCookie).toBeDefined();
    const action = pendingV2Action(oldSession.id, new Date());
    client.seed('pending_actions', action as unknown as Record<string, unknown>);

    await login(store, PROFILE_ID, ACCESS_CODE);

    const retainedSession = await store.get<SessionRow>('sessions', oldSession.id);
    const fresh = await actorSession(store);
    const retainedAction = await store.workflowProjectionReader.get<PendingActionV2>('pending_actions', ACTION_ID);
    expect(retainedSession).toMatchObject({ id: oldSession.id, profileId: PROFILE_ID });
    expect(Date.parse(retainedSession!.expiresAt)).toBeLessThanOrEqual(Date.now());
    expect(retainedAction?.body).toEqual(action);
    expect(client.rows.get('pending_actions')?.find((row) => row.id === ACTION_ID)?.session_id).toBe(oldSession.id);
    expect(fresh.session.id).not.toBe(oldSession.id);
    expect(cookieHarness.value).not.toBe(oldCookie);
    expect(cookieHarness.setCalls).toHaveLength(2);
    expect(client.rpcCalls.filter((call) => call.name === 'nexus_commit')).toHaveLength(2);

    cookieHarness.value = oldCookie;
    await expect(actorSession(store)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('ignores a forged prior cookie instead of expiring the guessed session row', async () => {
    const client = new ControlledSessionSupabaseClient();
    await seedProfile(client);
    const store = makeStore(client);
    const victim: SessionRow = {
      id: 'session-supa-victim',
      profileId: PROFILE_ID,
      mode: 'live_ai',
      modeRevision: 4,
      csrfToken: 'victim-csrf-token',
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    };
    client.seed('sessions', victim as unknown as Record<string, unknown>);
    const victimRowBefore = JSON.stringify(client.rows.get('sessions')?.find((row) => row.id === victim.id));
    cookieHarness.value = `${victim.id}.forged-signature`;

    await login(store, PROFILE_ID, ACCESS_CODE);

    expect(await store.get<SessionRow>('sessions', victim.id)).toEqual(victim);
    expect((await actorSession(store)).session.id).not.toBe(victim.id);
    expect(cookieHarness.value).not.toBe(`${victim.id}.forged-signature`);
    expect(JSON.stringify(client.rows.get('sessions')?.find((row) => row.id === victim.id))).toBe(victimRowBefore);
    const changes = client.rpcCalls.find((call) => call.name === 'nexus_commit')?.args.changes as Array<{ id: string }>;
    expect(changes.some((change) => change.id === victim.id)).toBe(false);
  });

  it('logs out by expiring but retaining the session row referenced by a V2 action', async () => {
    const client = new ControlledSessionSupabaseClient();
    await seedProfile(client);
    const store = makeStore(client);
    const current = await newSession(store);
    const oldCookie = cookieHarness.value;
    const action = pendingV2Action(current.id, new Date());
    client.seed('pending_actions', action as unknown as Record<string, unknown>);

    await logout(store, current);

    const retainedSession = await store.get<SessionRow>('sessions', current.id);
    const retainedAction = await store.workflowProjectionReader.get<PendingActionV2>('pending_actions', ACTION_ID);
    expect(retainedSession).toMatchObject({ id: current.id, profileId: PROFILE_ID });
    expect(Date.parse(retainedSession!.expiresAt)).toBeLessThanOrEqual(Date.now());
    expect(retainedAction?.body).toEqual(action);
    expect(client.rows.get('pending_actions')?.find((row) => row.id === ACTION_ID)?.session_id).toBe(current.id);
    expect(cookieHarness.value).toBeUndefined();
    expect(cookieHarness.deleteCalls).toContain(COOKIE_NAME);

    cookieHarness.value = oldCookie;
    await expect(actorSession(store)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('stales only the V1 pending action and denies V2 confirmation by mode revision after switching back', async () => {
    const client = new ControlledSessionSupabaseClient();
    await seedProfile(client);
    const store = makeStore(client);
    const session = await newSession(store);
    const now = new Date();
    seedWorkflowAuthority(client, now.toISOString());
    const action = pendingV2Action(session.id, now);
    const legacyAction = legacyPendingAction(session.id, now.toISOString());
    client.rows.set('pending_actions', [
      makeStoredRow('pending_actions', action as unknown as Record<string, unknown>),
      makeStoredRow('pending_actions', legacyAction),
    ]);
    const runner = makeStaleConfirmRunner(store, action, now);

    await changeMode(store, session, 'scripted_demo');
    expect(await store.get<SessionRow>('sessions', session.id)).toMatchObject({ mode: 'scripted_demo', modeRevision: 1 });
    expect(await store.get<{ id: string; status: string }>('pending_actions', legacyAction.id as string))
      .toMatchObject({ id: legacyAction.id, status: 'stale' });
    expect((await store.workflowProjectionReader.get<PendingActionV2>('pending_actions', ACTION_ID))?.body.status)
      .toBe('pending');

    await changeMode(store, session, 'live_ai');
    expect(await store.get<SessionRow>('sessions', session.id)).toMatchObject({ mode: 'live_ai', modeRevision: 2 });
    const attempt = await runner.confirm(session.id, ACTION_ID, 'session-supa-confirm-after-switch-back', {
      conversationId: CONVERSATION_ID,
      turnId: TURN_ID,
    });

    expect(attempt.receipt).toBeNull();
    expect(attempt.error).toMatchObject({ code: 'WORKFLOW_STALE', outcome: 'stale' });
    expect((await store.workflowProjectionReader.get<PendingActionV2>('pending_actions', ACTION_ID))?.body.status)
      .toBe('pending');
    const workflowOperations = client.rpcCalls
      .filter((call) => call.name === 'nexus_workflow_commit')
      .flatMap((call) => call.args.operations as Array<{ table: string }>);
    expect(workflowOperations.some((operation) => operation.table !== 'audit_events')).toBe(false);
  });
});
