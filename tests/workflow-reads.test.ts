import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Profile } from '../lib/contracts';
import { createTrustedWorkflowRuntime } from '../lib/core/workflow-runtime';
import { assistantMessageId as canonicalAssistantMessageId } from '../lib/core/conversation-actions';
import { digest } from '../lib/core/utils';
import {
  finalAssistantContentDigest,
  normalizedFinalActionIds,
  turnCompletionId,
  turnCompletionRecordSchema,
  type TurnCompletionRecord,
} from '../lib/core/turn-completion-gate';
import { demoWorkflowPolicyV1, getDemoWorkflowPolicyV1Pin } from '../lib/workflows/policy';
import {
  pendingActionV2Schema,
  persistedConversationMessageSchema,
  type PendingActionV2,
  type PersistedConversationMessage,
  type Responsibility,
  type WorkflowPayloadV2,
} from '../lib/workflows/contracts';
import {
  workflowActionViewV2Schema,
  workflowPublicActionV2Schema,
} from '../lib/workflows/api-contracts';
import {
  getWorkflowV2ActionView,
  listWorkflowV2ActionViews,
  readWorkflowV2Conversation,
  readWorkflowV2Suggestions,
  type WorkflowV2ReadRuntime,
} from '../lib/core/workflow-reads';
import { createWorkflowSqliteFixture } from './helpers/workflow-storage';
import type {
  ProjectedRow,
  WorkflowStorageQuery,
  WorkflowStoreCapability,
  WorkflowTransactionContext,
} from '../lib/storage/workflow-projections';

const NOW = '2026-10-04T04:00:00.000Z';
const BUSINESS_DATE = '2026-10-04';
const RELEASE = 'workflow-reads-test-release-r1';
const ACTION_CREATED_AT = '2026-10-04T03:00:00.000Z';
const EXPIRED = '2026-10-04T03:59:00.000Z';
const FUTURE = '2099-01-01T00:00:00.000Z';

type Fixture = Awaited<ReturnType<typeof createWorkflowSqliteFixture>>;
type Store = Fixture['store'];
type ProjectionQueryOverride = (query: WorkflowStorageQuery, rows: ProjectedRow<unknown>[]) => ProjectedRow<unknown>[] | undefined;

interface ProjectionQueryObservation {
  table: string;
  cursor?: string;
  limit: number;
  returnedCount: number;
}

interface ActorSeed {
  profileId: string;
  sessionId: string;
  identityId: string;
  responsibilityId: string;
  conversationId: string;
}

interface Harness {
  fixture: Fixture;
  store: Store;
  trusted: ReturnType<typeof createTrustedWorkflowRuntime>;
  readRuntime: WorkflowV2ReadRuntime;
  forbiddenRunnerCalls(): string[];
  setProjectionQueryOverride(override: ProjectionQueryOverride | undefined): void;
  clearProjectionQueryObservations(): void;
  projectionQueryObservations(): ProjectionQueryObservation[];
  actor: ActorSeed;
  oldSessionId: string;
  foreign: ActorSeed;
  orgUnitId: string;
  branchId: string;
  insertAction(action: PendingActionV2): Promise<void>;
  insertMessage(message: PersistedConversationMessage, completion?: TurnCompletionRecord | null): Promise<void>;
  setMode(mode: 'live_ai' | 'scripted_demo', modeRevision: number): Promise<void>;
  setBranchResponsibility(branchIds: string[]): Promise<void>;
  dispose(): Promise<void>;
}

function profile(id: string): Profile {
  return {
    id,
    name: 'Workflow read fixture actor',
    role: 'executive',
    active: true,
    permissions: ['branch.review.assign', 'dashboard.create', 'sales.read', 'operations.read'],
    regions: ['east'],
  };
}

async function createHarness(): Promise<Harness> {
  const fixture = await createWorkflowSqliteFixture();
  const store = fixture.store;
  const suffix = randomUUID().replaceAll('-', '');
  const actor: ActorSeed = {
    profileId: `reads-profile-${suffix}`,
    sessionId: `reads-session-${suffix}`,
    identityId: `reads-identity-${suffix}`,
    responsibilityId: `reads-responsibility-${suffix}`,
    conversationId: `reads-conversation-${suffix}`,
  };
  const foreign: ActorSeed = {
    profileId: `reads-foreign-profile-${suffix}`,
    sessionId: `reads-foreign-session-${suffix}`,
    identityId: `reads-foreign-identity-${suffix}`,
    responsibilityId: `reads-foreign-responsibility-${suffix}`,
    conversationId: `reads-foreign-conversation-${suffix}`,
  };
  const oldSessionId = `reads-old-session-${suffix}`;
  const orgUnitId = `reads-org-${suffix}`;
  const branchId = `reads-branch-${suffix}`;
  const policyPin = getDemoWorkflowPolicyV1Pin();
  let generated = 0;
  const runnerCalls: string[] = [];
  const queryObservations: ProjectionQueryObservation[] = [];
  let projectionQueryOverride: ProjectionQueryOverride | undefined;

  try {
    await store.workflowTransaction(async tx => {
      await tx.insertUnique('org_units', {
        id: orgUnitId,
        name: 'Workflow read fixture organization',
        parentOrgUnitId: null,
        active: true,
      }, { constraint: 'org_units_primary_key', values: { id: orgUnitId } });
    });

    await store.transaction(async tx => {
      for (const seed of [actor, foreign]) {
        await tx.put('profiles', profile(seed.profileId));
        await tx.put('sessions', {
          id: seed.sessionId,
          profileId: seed.profileId,
          mode: 'scripted_demo',
          modeRevision: 1,
          csrfToken: `csrf-${seed.sessionId}`,
          expiresAt: FUTURE,
        });
      }
      await tx.put('sessions', {
        id: oldSessionId,
        profileId: actor.profileId,
        mode: 'scripted_demo',
        modeRevision: 1,
        csrfToken: `csrf-${oldSessionId}`,
        expiresAt: FUTURE,
      });
      await tx.put('branches', {
        id: branchId,
        name: 'Workflow read fixture branch',
        region: 'east',
        orgUnitId,
        active: true,
      });
      await tx.put('sales_orders', {
        id: `reads-order-${suffix}`,
        branchId,
        date: BUSINESS_DATE,
        amountSatang: 10_000,
        status: 'paid',
        updatedAt: NOW,
      });
      await tx.put('sales_targets', {
        id: `reads-target-${suffix}`,
        branchId,
        date: BUSINESS_DATE,
        amountSatang: 12_000,
        updatedAt: NOW,
      });
    });

    await store.workflowTransaction(async tx => {
      for (const seed of [actor, foreign]) {
        await tx.insertUnique('directory_identities', {
          id: seed.identityId,
          profileId: seed.profileId,
          displayName: 'Workflow read fixture actor',
          active: true,
          role: 'executive',
          department: 'sales_operations',
          orgUnitId,
          managerIdentityId: null,
          verifiedDemoEmail: `${seed.sessionId}@example.invalid`,
          slackIdentity: null,
          allowedChannels: ['simulated_email'],
          classificationCeiling: 'internal',
          rowVersion: 1,
        }, { constraint: 'directory_identities_primary_key', values: { id: seed.identityId } });
        await tx.insertUnique('responsibilities', {
          id: seed.responsibilityId,
          identityId: seed.identityId,
          orgUnitId,
          purpose: 'sales_operations',
          branchIds: [branchId],
          active: true,
          rowVersion: 1,
        }, { constraint: 'responsibilities_open_identity_purpose_unique', values: {
          identityId: seed.identityId,
          purpose: 'sales_operations',
          orgUnitId,
        } });
        await tx.insertUnique('conversations', {
          id: seed.conversationId,
          actorId: seed.profileId,
          title: 'Workflow read fixture conversation',
          pinned: false,
          archivedAt: null,
          rowVersion: 1,
          createdAt: NOW,
          updatedAt: NOW,
          lastScope: null,
          lastDashboardId: null,
        }, { constraint: 'conversations_primary_key', values: { id: seed.conversationId } });
      }
      await tx.insertUnique('workflow_policies', {
        id: policyPin.id,
        version: policyPin.version,
        digest: policyPin.digest,
        policy: demoWorkflowPolicyV1,
      }, { constraint: 'workflow_policies_primary_key', values: { id: policyPin.id } });
    });

    const originalWorkflowTransaction = store.workflowTransaction.bind(store) as unknown as WorkflowStoreCapability['workflowTransaction'];
    const runtimeStore: Store = new Proxy(store, {
      get(target, property, receiver) {
        if (property === 'workflowTransaction') {
          return async <T>(work: (tx: WorkflowTransactionContext) => Promise<T>) => originalWorkflowTransaction(async tx => {
            const projections = new Proxy(tx.workflowProjectionReader, {
              get(reader, key, readerReceiver) {
                if (key === 'query') {
                  return async <Row>(query: WorkflowStorageQuery): Promise<ProjectedRow<Row>[]> => {
                    const rows = await reader.query<Row>(query);
                    queryObservations.push({
                      table: query.table,
                      ...(query.kind === 'scoped' && query.cursor !== undefined ? { cursor: query.cursor } : {}),
                      limit: query.kind === 'scoped' ? query.limit ?? 25 : query.kind === 'ids' ? query.ids.length : 0,
                      returnedCount: rows.length,
                    });
                    const overridden = projectionQueryOverride?.(query, rows as unknown as ProjectedRow<unknown>[]);
                    return (overridden ?? rows) as ProjectedRow<Row>[];
                  };
                }
                const value = Reflect.get(reader, key, readerReceiver) as unknown;
                return typeof value === 'function' ? value.bind(reader) : value;
              },
            });
            const wrappedTransaction = new Proxy(tx, {
              get(transaction, key, transactionReceiver) {
                if (key === 'workflowProjectionReader') return projections;
                const value = Reflect.get(transaction, key, transactionReceiver) as unknown;
                return typeof value === 'function' ? value.bind(transaction) : value;
              },
            }) as WorkflowTransactionContext;
            return work(wrappedTransaction);
          });
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const trusted = createTrustedWorkflowRuntime({
      store: runtimeStore,
      businessDate: BUSINESS_DATE,
      contextFactory: () => ({ latestDashboard: async () => undefined }),
      getReleaseRevision: () => RELEASE,
      now: () => new Date(NOW),
      makeId: prefix => `reads-${prefix}-${suffix}-${++generated}`,
    });
    const runner = new Proxy(trusted.runner, {
      get(target, property, receiver) {
        if (property === 'confirm' || property === 'reconcile') {
          return async () => {
            runnerCalls.push(String(property));
            throw new Error(`A read operation called runner.${String(property)}.`);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const readRuntime: WorkflowV2ReadRuntime = { runner, suggestions: trusted.suggestions };

    return {
      fixture,
      store,
      trusted,
      readRuntime,
      forbiddenRunnerCalls: () => [...runnerCalls],
      setProjectionQueryOverride(override) { projectionQueryOverride = override; },
      clearProjectionQueryObservations() { queryObservations.length = 0; },
      projectionQueryObservations() { return [...queryObservations]; },
      actor,
      oldSessionId,
      foreign,
      orgUnitId,
      branchId,
      async insertAction(action) {
        if (action.status !== 'completed') throw new Error('The completed action fixture must use its terminal transition.');
        await store.workflowTransaction(async tx => {
          const initial = { ...action, status: 'pending' as const };
          await tx.insertUnique('pending_actions', initial, {
            constraint: 'pending_actions_primary_key', values: { id: action.id },
          });
          const claimed = await tx.compareAndSwap('pending_actions', action.id,
            { rowVersion: 1, state: 'pending' }, { ...initial, status: 'claimed', rowVersion: 2 });
          if (!claimed.updated) throw new Error('The completed action fixture did not enter claimed state.');
          const completed = await tx.compareAndSwap('pending_actions', action.id,
            { rowVersion: 2, state: 'claimed' }, { ...initial, status: 'completed', rowVersion: 3 });
          if (!completed.updated) throw new Error('The completed action fixture did not reach completed state.');
        });
      },
      async insertMessage(message, completion) {
        await store.workflowTransaction(tx => tx.insertUnique('conversation_messages', message, {
          constraint: 'conversation_messages_primary_key', values: { id: message.id },
        }).then(() => undefined));
        if (completion === null || message.role !== 'assistant') return;
        const proof = completion ?? completedTurnProof(message);
        await store.transaction(tx => tx.put('tool_executions', proof));
      },
      async setMode(mode, modeRevision) {
        await store.transaction(async tx => {
          const current = await tx.get<{
            id: string; profileId: string; mode: 'live_ai' | 'scripted_demo'; modeRevision: number;
            csrfToken: string; expiresAt: string;
          }>('sessions', actor.sessionId);
          if (!current) throw new Error('The workflow read fixture session is missing.');
          await tx.put('sessions', { ...current, mode, modeRevision });
        });
      },
      async setBranchResponsibility(branchIds) {
        await store.workflowTransaction(async tx => {
          const current = await tx.get<Responsibility>('responsibilities', actor.responsibilityId);
          if (!current) throw new Error('The workflow read fixture responsibility is missing.');
          const changed = await tx.compareAndSwap('responsibilities', current.id,
            { rowVersion: current.rowVersion, state: current.active ? 'active' : 'inactive' },
            { ...current, branchIds, rowVersion: current.rowVersion + 1 });
          if (!changed.updated) throw new Error('The workflow read fixture responsibility changed unexpectedly.');
        });
      },
      async dispose() { await fixture.dispose(); },
    };
  } catch (error) {
    await fixture.dispose();
    throw error;
  }
}

async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const harness = await createHarness();
  try {
    await run(harness);
  } finally {
    await harness.dispose();
  }
}

function completedBranchAction(input: {
  id: string;
  actorId: string;
  sessionId: string;
  conversationId: string;
  turnId: string;
  identityId: string;
  branchId: string;
  orgUnitId: string;
  expiresAt?: string;
}): PendingActionV2 {
  const caseId = `${input.id}-case`;
  const payload: WorkflowPayloadV2 = {
    kind: 'branch_review_assign',
    businessDate: BUSINESS_DATE,
    targets: [{
      ownerIdentityId: input.identityId,
      reason: 'Review the selected synthetic branch case.',
      dueDate: '2026-10-08',
      priority: 'normal',
      branchId: input.branchId,
      caseId,
    }],
  };
  const semanticKey = digest({ action: input.id, target: caseId });
  return pendingActionV2Schema.parse({
    id: input.id,
    contractVersion: 2,
    actorId: input.actorId,
    sessionId: input.sessionId,
    conversationId: input.conversationId,
    turnId: input.turnId,
    mode: 'scripted_demo',
    modeRevision: 1,
    payload,
    payloadHash: digest({ payload, id: input.id }),
    idempotencyKey: digest({ root: input.id }),
    targets: [{
      targetId: `${input.id}-target`,
      ref: { table: 'investigation_cases', id: caseId },
      semanticKey,
      expectedRows: [],
      ownerIdentityId: input.identityId,
      expectedEffectRef: { table: 'branch_review_assignments', id: `${input.id}-assignment` },
      expectedEffectVersion: 1,
    }],
    targetCount: 1,
    expectedRows: [],
    approvedBranchIds: [input.branchId],
    approvedOrgUnitIds: [input.orgUnitId],
    reviewedSnapshotId: null,
    policy: getDemoWorkflowPolicyV1Pin(),
    packs: [],
    releaseRevision: RELEASE,
    executionMode: 'atomic_local',
    createdAt: ACTION_CREATED_AT,
    expiresAt: input.expiresAt ?? EXPIRED,
    status: 'completed',
  });
}

function assistantMessage(input: {
  actorId: string;
  sessionId: string;
  conversationId: string;
  turnId: string;
  text: string;
  pendingActionIds?: string[];
  analysis?: PersistedConversationMessage['analysis'];
  evidence?: PersistedConversationMessage['evidence'];
  sources?: PersistedConversationMessage['sources'];
  receiptId?: string;
}): PersistedConversationMessage {
  return persistedConversationMessageSchema.parse({
    id: canonicalAssistantMessageId(input.actorId, { conversationId: input.conversationId, turnId: input.turnId }),
    actorId: input.actorId,
    sessionId: input.sessionId,
    conversationId: input.conversationId,
    turnId: input.turnId,
    role: 'assistant',
    text: input.text,
    mode: 'scripted_demo',
    modeRevision: 1,
    createdAt: NOW,
    ...(input.pendingActionIds ? { pendingActionIds: input.pendingActionIds } : {}),
    ...(input.analysis ? { analysis: input.analysis } : {}),
    ...(input.evidence ? { evidence: input.evidence } : {}),
    ...(input.sources ? { sources: input.sources } : {}),
    ...(input.receiptId ? { receiptId: input.receiptId } : {}),
  });
}

function completedTurnProof(message: PersistedConversationMessage): TurnCompletionRecord {
  if (!message.turnId || !message.sessionId) throw new Error('A completion fixture needs explicit turn and session IDs.');
  const tuple = {
    actorId: message.actorId,
    sessionId: message.sessionId,
    conversationId: message.conversationId,
    turnId: message.turnId,
    mode: message.mode,
    modeRevision: message.modeRevision,
  };
  const actionIds = normalizedFinalActionIds(message);
  return turnCompletionRecordSchema.parse({
    id: turnCompletionId(tuple),
    name: 'chat.turn_completion',
    schemaVersion: 1,
    origin: 'standalone_prepare',
    requestLedgerId: null,
    ...tuple,
    status: 'completed',
    createdAt: message.createdAt,
    assistantMessageId: message.id,
    finalContentDigest: finalAssistantContentDigest({
      text: message.text,
      analysis: message.analysis,
      evidence: message.evidence,
      sources: message.sources,
      receiptId: message.receiptId,
    }, actionIds),
    finalActionIds: actionIds,
  });
}

function startedTurnProof(message: PersistedConversationMessage): TurnCompletionRecord {
  if (!message.turnId || !message.sessionId) throw new Error('An incomplete completion fixture needs explicit turn and session IDs.');
  const tuple = {
    actorId: message.actorId,
    sessionId: message.sessionId,
    conversationId: message.conversationId,
    turnId: message.turnId,
    mode: message.mode,
    modeRevision: message.modeRevision,
  };
  return turnCompletionRecordSchema.parse({
    id: turnCompletionId(tuple),
    name: 'chat.turn_completion',
    schemaVersion: 1,
    origin: 'chat',
    requestLedgerId: `reads-started-ledger-${message.turnId}`,
    ...tuple,
    status: 'started',
    createdAt: NOW,
  });
}

function actionViewRefs(action: PendingActionV2, assistantMessageId: string) {
  return {
    conversationId: action.conversationId,
    turnId: action.turnId,
    assistantMessageId,
    actionId: action.id,
  };
}

function objectKeysDeep(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(objectKeysDeep);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, nested]) => [key, ...objectKeysDeep(nested)]);
}

function expectPublicReadShape(value: unknown): void {
  const forbidden = [
    'actorId', 'sessionId', 'actionId', 'payloadHash', 'idempotencyKey', 'policy', 'packs', 'releaseRevision',
    'semanticKey', 'expectedRows', 'expectedEffectVersion', 'analysis', 'evidence', 'sources', 'receiptId',
  ];
  expect(objectKeysDeep(value).filter(key => forbidden.includes(key))).toEqual([]);
}

function storageSnapshot(fixture: Fixture) {
  const db = fixture.openDatabase();
  try {
    const revision = (db.prepare('SELECT revision FROM appmeta WHERE singleton = 1').get() as { revision: number }).revision;
    const tableNames = ['pending_actions', 'action_executions', 'audit_events', 'tool_executions', 'conversations', 'conversation_messages',
      'dashboards', 'dashboard_versions', 'mock_badges'] as const;
    const counts = Object.fromEntries(tableNames.map(table => [table,
      (db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as { count: number }).count,
    ]));
    return { revision, counts };
  } finally {
    db.close();
  }
}

function dashboardCreatePayload(branchId: string): WorkflowPayloadV2 {
  return {
    kind: 'dashboard_create',
    spec: {
      title: 'Workflow read stale-state dashboard',
      description: 'A synthetic action used to prove display-only stale status.',
      scope: { region: 'east', date: BUSINESS_DATE, branchIds: [branchId] },
      widgets: [{ type: 'metric', title: 'Net sales', metric: 'net_sales' }],
    },
  };
}

describe('V2 workflow read projections', () => {
  it('requires exact actor, session, conversation, turn, and assistant action membership before exposing a public action', async () => withHarness(async harness => {
    const valid = completedBranchAction({
      id: 'reads-exact-action', actorId: harness.actor.profileId, sessionId: harness.actor.sessionId,
      conversationId: harness.actor.conversationId, turnId: 'reads-exact-turn', identityId: harness.actor.identityId,
      branchId: harness.branchId, orgUnitId: harness.orgUnitId,
    });
    const wrongTurn = completedBranchAction({
      id: 'reads-wrong-turn-action', actorId: harness.actor.profileId, sessionId: harness.actor.sessionId,
      conversationId: harness.actor.conversationId, turnId: 'reads-other-turn', identityId: harness.actor.identityId,
      branchId: harness.branchId, orgUnitId: harness.orgUnitId,
    });
    const oldSession = completedBranchAction({
      id: 'reads-old-session-action', actorId: harness.actor.profileId, sessionId: harness.oldSessionId,
      conversationId: harness.actor.conversationId, turnId: 'reads-exact-turn', identityId: harness.actor.identityId,
      branchId: harness.branchId, orgUnitId: harness.orgUnitId,
    });
    const foreign = completedBranchAction({
      id: 'reads-foreign-action', actorId: harness.foreign.profileId, sessionId: harness.foreign.sessionId,
      conversationId: harness.foreign.conversationId, turnId: 'reads-exact-turn', identityId: harness.foreign.identityId,
      branchId: harness.branchId, orgUnitId: harness.orgUnitId,
    });
    for (const action of [valid, wrongTurn, oldSession, foreign]) await harness.insertAction(action);
    const message = assistantMessage({
      actorId: harness.actor.profileId,
      sessionId: harness.actor.sessionId,
      conversationId: harness.actor.conversationId,
      turnId: valid.turnId,
      text: 'Private proposal prose linked to multiple action references.',
      pendingActionIds: [valid.id, wrongTurn.id, oldSession.id, foreign.id],
    });
    const messageId = message.id;
    await harness.insertMessage(message);
    const analysisMessage = assistantMessage({
      actorId: harness.actor.profileId, sessionId: harness.actor.sessionId,
      conversationId: harness.actor.conversationId, turnId: 'reads-analysis-turn',
      text: 'This assistant text includes analysis and must be conservatively redacted.',
      analysis: { facts: [{ text: 'Secret fact', sourceIds: ['source-private'] }], relationships: [], hypotheses: [],
        missingEvidence: [], generatedAt: NOW, evidenceVersion: 'reads-evidence-v1' },
    });
    await harness.insertMessage(analysisMessage);

    const snapshot = storageSnapshot(harness.fixture);
    const view = await getWorkflowV2ActionView(harness.readRuntime, harness.actor.sessionId,
      actionViewRefs(valid, messageId));
    expect(view.action.id).toBe(valid.id);
    expect(view.displayStatus).toBe('completed');
    expect(view.assistantMessageId).toBe(messageId);
    expect(Object.keys(view).sort()).toEqual([
      'action', 'actionContractVersion', 'assistantMessageId', 'conversationId', 'displayStatus', 'turnId',
    ]);
    expectPublicReadShape(view);
    expect(Object.keys(view.action).sort()).toEqual([
      'approvedBranchIds', 'approvedOrgUnitIds', 'contractVersion', 'conversationId', 'createdAt', 'executionMode',
      'expiresAt', 'id', 'mode', 'payload', 'reviewedSnapshotId', 'status', 'targetCount', 'targets', 'turnId',
    ]);
    expect(Object.keys(view.action.targets[0] ?? {}).sort()).toEqual([
      'expectedEffectRef', 'ownerIdentityId', 'ref', 'targetId',
    ]);
    expect(workflowActionViewV2Schema.safeParse({ ...view, action: valid }).success).toBe(false);
    expect(workflowPublicActionV2Schema.safeParse(valid).success).toBe(false);

    await expect(getWorkflowV2ActionView(harness.readRuntime, harness.actor.sessionId,
      { ...actionViewRefs(valid, messageId), assistantMessageId: 'reads-wrong-assistant-message' }))
      .rejects.toMatchObject({ status: 404 });
    await expect(getWorkflowV2ActionView(harness.readRuntime, harness.actor.sessionId,
      { ...actionViewRefs(valid, messageId), turnId: 'reads-wrong-turn' }))
      .rejects.toMatchObject({ status: 404 });
    await expect(getWorkflowV2ActionView(harness.readRuntime, harness.actor.sessionId,
      actionViewRefs(oldSession, messageId)))
      .rejects.toMatchObject({ status: 404 });
    await expect(getWorkflowV2ActionView(harness.readRuntime, harness.actor.sessionId,
      actionViewRefs(foreign, messageId)))
      .rejects.toMatchObject({ status: 404 });

    const history = await readWorkflowV2Conversation(harness.readRuntime, harness.actor.sessionId,
      { conversationId: harness.actor.conversationId, limit: 100 });
    const exactMessage = history.messages.find(item => item.id === messageId);
    const analysisMessageView = history.messages.find(item => item.id === analysisMessage.id);
    expect(exactMessage).toMatchObject({ redacted: true, pendingActionIds: [valid.id] });
    expect(exactMessage?.text).not.toContain('Private proposal prose');
    expect(analysisMessageView).toMatchObject({ redacted: true, pendingActionIds: [] });
    expect(analysisMessageView?.text).not.toContain('Secret fact');
    expect(history.actionViews.map(item => item.action.id)).toEqual([valid.id]);
    expectPublicReadShape(history);
    expect(JSON.stringify(history)).not.toContain(harness.actor.sessionId);
    expect(harness.forbiddenRunnerCalls()).toEqual([]);
    expect(storageSnapshot(harness.fixture)).toEqual(snapshot);
  }));

  it('hides completed action refs immediately after current branch responsibility shrinks', async () => withHarness(async harness => {
    const action = completedBranchAction({
      id: 'reads-scope-shrink-action', actorId: harness.actor.profileId, sessionId: harness.actor.sessionId,
      conversationId: harness.actor.conversationId, turnId: 'reads-scope-shrink-turn', identityId: harness.actor.identityId,
      branchId: harness.branchId, orgUnitId: harness.orgUnitId,
    });
    await harness.insertAction(action);
    const message = assistantMessage({
      actorId: harness.actor.profileId, sessionId: harness.actor.sessionId,
      conversationId: harness.actor.conversationId, turnId: action.turnId,
      text: 'Sensitive completed action details for the formerly authorized branch.',
      pendingActionIds: [action.id],
    });
    const messageId = message.id;
    await harness.insertMessage(message);

    const authorized = await readWorkflowV2Conversation(harness.readRuntime, harness.actor.sessionId,
      { conversationId: harness.actor.conversationId });
    expect(authorized.messages[0]).toMatchObject({ redacted: true, pendingActionIds: [action.id] });
    expect(authorized.actionViews.map(item => item.action.id)).toEqual([action.id]);
    expect(authorized.messages[0]?.text).not.toContain('Sensitive completed action details');
    await expect(getWorkflowV2ActionView(harness.readRuntime, harness.actor.sessionId,
      actionViewRefs(action, messageId))).resolves.toMatchObject({ displayStatus: 'completed' });

    await harness.setBranchResponsibility([]);
    const afterScopeShrink = await readWorkflowV2Conversation(harness.readRuntime, harness.actor.sessionId,
      { conversationId: harness.actor.conversationId });
    expect(afterScopeShrink.messages[0]).toMatchObject({ redacted: true, pendingActionIds: [] });
    expect(afterScopeShrink.messages[0]?.text).not.toContain('Sensitive completed action details');
    expect(afterScopeShrink.actionViews).toEqual([]);
    await expect(getWorkflowV2ActionView(harness.readRuntime, harness.actor.sessionId,
      actionViewRefs(action, messageId))).rejects.toMatchObject({ status: 404 });
    expectPublicReadShape(afterScopeShrink);
    expect(harness.forbiddenRunnerCalls()).toEqual([]);
  }));

  it('redacts old or incomplete assistant text and exposes completed actions only with a matching completion proof', async () => withHarness(async harness => {
    const oldText = assistantMessage({
      actorId: harness.actor.profileId, sessionId: harness.actor.sessionId,
      conversationId: harness.actor.conversationId, turnId: 'reads-old-source-free-turn',
      text: 'Historical assistant prose has no persisted completion proof.',
    });
    await harness.insertMessage(oldText, null);

    const incompleteText = assistantMessage({
      actorId: harness.actor.profileId, sessionId: harness.actor.sessionId,
      conversationId: harness.actor.conversationId, turnId: 'reads-incomplete-turn',
      text: 'This turn still has a started completion record.',
    });
    await harness.insertMessage(incompleteText, startedTurnProof(incompleteText));

    const tamperedDigestText = assistantMessage({
      actorId: harness.actor.profileId, sessionId: harness.actor.sessionId,
      conversationId: harness.actor.conversationId, turnId: 'reads-tampered-digest-turn',
      text: 'The assistant body no longer matches its canonical digest.',
    });
    const tamperedDigestProof = completedTurnProof(tamperedDigestText);
    await harness.insertMessage(tamperedDigestText, {
      ...tamperedDigestProof,
      finalContentDigest: digest('different canonical body'),
    });

    const tamperedRefsAction = completedBranchAction({
      id: 'reads-tampered-refs-action', actorId: harness.actor.profileId, sessionId: harness.actor.sessionId,
      conversationId: harness.actor.conversationId, turnId: 'reads-tampered-refs-turn',
      identityId: harness.actor.identityId, branchId: harness.branchId, orgUnitId: harness.orgUnitId,
    });
    await harness.insertAction(tamperedRefsAction);
    const tamperedRefsText = assistantMessage({
      actorId: harness.actor.profileId, sessionId: harness.actor.sessionId,
      conversationId: harness.actor.conversationId, turnId: tamperedRefsAction.turnId,
      text: 'The completion action set does not match this assistant message.',
      pendingActionIds: [tamperedRefsAction.id],
    });
    const tamperedRefsProof = completedTurnProof(tamperedRefsText);
    await harness.insertMessage(tamperedRefsText, { ...tamperedRefsProof, finalActionIds: [] });

    const verifiedAction = completedBranchAction({
      id: 'reads-verified-completed-action', actorId: harness.actor.profileId, sessionId: harness.actor.sessionId,
      conversationId: harness.actor.conversationId, turnId: 'reads-verified-completed-turn',
      identityId: harness.actor.identityId, branchId: harness.branchId, orgUnitId: harness.orgUnitId,
    });
    await harness.insertAction(verifiedAction);
    const verifiedText = assistantMessage({
      actorId: harness.actor.profileId, sessionId: harness.actor.sessionId,
      conversationId: harness.actor.conversationId, turnId: verifiedAction.turnId,
      text: 'This completed action is backed by its canonical completion pair.',
      pendingActionIds: [verifiedAction.id],
    });
    await harness.insertMessage(verifiedText);

    const beforeRead = storageSnapshot(harness.fixture);
    const history = await readWorkflowV2Conversation(harness.readRuntime, harness.actor.sessionId,
      { conversationId: harness.actor.conversationId, limit: 100 });
    const messageById = new Map(history.messages.map(message => [message.id, message]));
    for (const message of [oldText, incompleteText, tamperedDigestText, tamperedRefsText]) {
      expect(messageById.get(message.id)).toMatchObject({ redacted: true, pendingActionIds: [] });
      expect(messageById.get(message.id)?.text).not.toContain(message.text);
    }
    expect(messageById.get(verifiedText.id)).toMatchObject({ redacted: true, pendingActionIds: [verifiedAction.id] });
    expect(messageById.get(verifiedText.id)?.text).not.toContain('canonical completion pair');
    expect(history.actionViews.map(view => view.action.id)).toEqual([verifiedAction.id]);
    expect(history.actionViews[0]).toMatchObject({ displayStatus: 'completed', action: { id: verifiedAction.id } });
    expectPublicReadShape(history);
    expect(storageSnapshot(harness.fixture)).toEqual(beforeRead);
    expect(harness.forbiddenRunnerCalls()).toEqual([]);
  }));

  it.each([
    ['evidence', {
      evidence: {
        scope: { region: 'all', date: BUSINESS_DATE, branchIds: [] },
        asOf: NOW,
        version: 'unverified-evidence-token',
        branches: [],
        totals: { netSales: 0, target: 0, gap: 0, achievement: null },
        sources: [],
        warnings: [],
      },
    }, 'unverified-evidence-token'],
    ['sources', {
      sources: [{
        id: 'private-source-ref-927',
        system: 'synthetic',
        observedAt: NOW,
        retrievedAt: NOW,
        freshness: 'fresh' as const,
        detail: 'private-source-detail-927',
      }],
    }, 'private-source-ref-927'],
    ['receiptId', { receiptId: 'private-receipt-927' }, 'private-receipt-927'],
  ] satisfies ReadonlyArray<[string, Pick<PersistedConversationMessage, 'evidence' | 'sources' | 'receiptId'>, string]>)
  ('redacts assistant history carrying unverified %s metadata', async (field, metadata, privateMarker) => withHarness(async harness => {
    const message = assistantMessage({
      actorId: harness.actor.profileId,
      sessionId: harness.actor.sessionId,
      conversationId: harness.actor.conversationId,
      turnId: `reads-unverified-${field}-turn`,
      text: `Assistant prose relying on unverified ${field} data.`,
      ...metadata,
    });
    await harness.insertMessage(message);

    const beforeRead = storageSnapshot(harness.fixture);
    const history = await readWorkflowV2Conversation(harness.readRuntime, harness.actor.sessionId,
      { conversationId: harness.actor.conversationId });
    const projected = history.messages.find(row => row.id === message.id);
    expect(projected).toMatchObject({ redacted: true, pendingActionIds: [] });
    expect(projected?.text).not.toContain('Assistant prose relying');
    expectPublicReadShape(history);
    expect(JSON.stringify(history)).not.toContain(privateMarker);
    expect(storageSnapshot(harness.fixture)).toEqual(beforeRead);
    expect(harness.forbiddenRunnerCalls()).toEqual([]);
  }));

  it('preserves user text exactly while redacting completed source-free assistant prose', async () => withHarness(async harness => {
    const userText = 'ช่วยตรวจยอดขายสาขาอีสต์ให้หน่อย';
    const userTurnId = 'reads-visible-user-turn';
    const user = persistedConversationMessageSchema.parse({
      id: userTurnId,
      actorId: harness.actor.profileId,
      sessionId: harness.actor.sessionId,
      conversationId: harness.actor.conversationId,
      turnId: userTurnId,
      role: 'user',
      text: userText,
      mode: 'scripted_demo',
      modeRevision: 1,
      createdAt: NOW,
    });
    const assistant = assistantMessage({
      actorId: harness.actor.profileId,
      sessionId: harness.actor.sessionId,
      conversationId: harness.actor.conversationId,
      turnId: 'reads-neutral-assistant-turn',
      text: 'Synthetic sensitive assistant prose without a provenance proof.',
    });
    await harness.insertMessage(user);
    await harness.insertMessage(assistant);

    const beforeRead = storageSnapshot(harness.fixture);
    const history = await readWorkflowV2Conversation(harness.readRuntime, harness.actor.sessionId,
      { conversationId: harness.actor.conversationId });
    const userView = history.messages.find(message => message.id === user.id);
    const assistantView = history.messages.find(message => message.id === assistant.id);
    expect(userView).toMatchObject({ role: 'user', text: userText, redacted: false, pendingActionIds: [] });
    expect(userView?.text).toBe(userText);
    expect(assistantView).toMatchObject({ role: 'assistant', redacted: true, pendingActionIds: [] });
    expect(assistantView?.text).not.toContain('Synthetic sensitive assistant prose');
    expectPublicReadShape(history);
    expect(storageSnapshot(harness.fixture)).toEqual(beforeRead);
    expect(harness.forbiddenRunnerCalls()).toEqual([]);
  }));

  it('computes pending-to-stale as a read-only display overlay', async () => withHarness(async harness => {
    const turnId = 'reads-pending-stale-turn';
    const prepared = await harness.trusted.runtime.prepare(harness.actor.sessionId,
      dashboardCreatePayload(harness.branchId),
      { conversationId: harness.actor.conversationId, turnId });
    expect(prepared.outcome).toBe('pending');
    const action = prepared.pendingAction;
    if (!action) throw new Error('The stale-status fixture did not prepare its action.');
    const anchorRows = await harness.store.workflowProjectionReader.query<PersistedConversationMessage>({
      kind: 'scoped', table: 'conversation_messages',
      equals: { actorId: harness.actor.profileId, sessionId: harness.actor.sessionId,
        conversationId: harness.actor.conversationId, turnId },
      limit: 10,
    });
    const anchor = anchorRows.find(row => row.body.role === 'assistant');
    if (!anchor) throw new Error('The stale-status fixture did not persist its assistant anchor.');
    await harness.store.transaction(tx => tx.put('tool_executions', completedTurnProof(anchor.body)));

    await harness.setMode('live_ai', 2);
    const storedBefore = await harness.store.workflowProjectionReader.get<PendingActionV2>('pending_actions', action.id);
    const snapshot = storageSnapshot(harness.fixture);
    const view = await getWorkflowV2ActionView(harness.readRuntime, harness.actor.sessionId,
      actionViewRefs(action, anchor.id));
    expect(view).toMatchObject({ displayStatus: 'stale', action: { id: action.id, status: 'pending' } });
    expectPublicReadShape(view);
    const history = await readWorkflowV2Conversation(harness.readRuntime, harness.actor.sessionId,
      { conversationId: harness.actor.conversationId });
    expect(history.actionViews).toMatchObject([{ action: { id: action.id, status: 'pending' }, displayStatus: 'stale' }]);
    const storedAfter = await harness.store.workflowProjectionReader.get<PendingActionV2>('pending_actions', action.id);
    expect(storedAfter?.rowVersion).toBe(storedBefore?.rowVersion);
    expect(storedAfter?.body).toEqual(storedBefore?.body);
    expect(storedAfter?.body.status).toBe('pending');
    expect(storageSnapshot(harness.fixture)).toEqual(snapshot);
    expect(harness.forbiddenRunnerCalls()).toEqual([]);
  }));

  it('pages global actions and conversation history through full bounded pages without repeats or truncation', async () => withHarness(async harness => {
    const actions: PendingActionV2[] = [];
    const messageIds: string[] = [];
    const total = 101;
    for (let index = 0; index < total; index += 1) {
      const number = String(index).padStart(3, '0');
      const action = completedBranchAction({
        id: `reads-page-action-${number}`, actorId: harness.actor.profileId, sessionId: harness.actor.sessionId,
        conversationId: harness.actor.conversationId, turnId: `reads-page-turn-${number}`,
        identityId: harness.actor.identityId, branchId: harness.branchId, orgUnitId: harness.orgUnitId,
      });
      actions.push(action);
      await harness.insertAction(action);
      const message = assistantMessage({
        actorId: harness.actor.profileId, sessionId: harness.actor.sessionId,
        conversationId: harness.actor.conversationId, turnId: action.turnId,
        text: `Completed action ${number}.`, pendingActionIds: [action.id],
      });
      messageIds.push(message.id);
      await harness.insertMessage(message);
    }
    const extraConversationId = 'reads-page-z-conversation';
    await harness.store.workflowTransaction(tx => tx.insertUnique('conversations', {
      id: extraConversationId,
      actorId: harness.actor.profileId,
      title: 'Additional global action conversation',
      pinned: false,
      archivedAt: null,
      rowVersion: 1,
      createdAt: NOW,
      updatedAt: NOW,
      lastScope: null,
      lastDashboardId: null,
    }, { constraint: 'conversations_primary_key', values: { id: extraConversationId } }).then(() => undefined));
    const extraActions: PendingActionV2[] = [];
    for (let index = 0; index < 2; index += 1) {
      const number = String(index).padStart(3, '0');
      const action = completedBranchAction({
        id: `reads-page-z-action-${number}`, actorId: harness.actor.profileId, sessionId: harness.actor.sessionId,
        conversationId: extraConversationId, turnId: `reads-page-z-turn-${number}`,
        identityId: harness.actor.identityId, branchId: harness.branchId, orgUnitId: harness.orgUnitId,
      });
      extraActions.push(action);
      await harness.insertAction(action);
      await harness.insertMessage(assistantMessage({
        actorId: harness.actor.profileId, sessionId: harness.actor.sessionId,
        conversationId: extraConversationId, turnId: action.turnId,
        text: `Completed global action ${number}.`, pendingActionIds: [action.id],
      }));
    }

    harness.clearProjectionQueryObservations();
    const firstActions = await listWorkflowV2ActionViews(harness.readRuntime, harness.actor.sessionId, { limit: 100 });
    expect(firstActions.actionViews).toHaveLength(100);
    expect(firstActions.nextCursor).toBe(actions[99]?.id);
    expect(harness.projectionQueryObservations()).toContainEqual({
      table: 'pending_actions', cursor: actions[99]?.id, limit: 1, returnedCount: 1,
    });
    harness.clearProjectionQueryObservations();
    const secondActions = await listWorkflowV2ActionViews(harness.readRuntime, harness.actor.sessionId,
      { cursor: firstActions.nextCursor ?? undefined, limit: 100 });
    expect(secondActions.actionViews).toHaveLength(3);
    expect(secondActions.nextCursor).toBeNull();
    expect(harness.projectionQueryObservations()).toContainEqual({
      table: 'pending_actions', cursor: extraActions[1]?.id, limit: 1, returnedCount: 0,
    });
    const actionIds = [...firstActions.actionViews, ...secondActions.actionViews].map(item => item.action.id);
    expect(new Set(actionIds).size).toBe(total + extraActions.length);
    expect(actionIds).toEqual([...actions, ...extraActions].map(action => action.id));

    harness.clearProjectionQueryObservations();
    const firstHistory = await readWorkflowV2Conversation(harness.readRuntime, harness.actor.sessionId,
      { conversationId: harness.actor.conversationId, limit: 100 });
    expect(firstHistory.messages).toHaveLength(100);
    expect(firstHistory.actionViews).toHaveLength(100);
    const orderedMessageIds = [...messageIds].sort();
    expect(firstHistory.nextCursor).toBe(orderedMessageIds[99]);
    expect(harness.projectionQueryObservations()).toContainEqual({
      table: 'conversation_messages', cursor: orderedMessageIds[99], limit: 1, returnedCount: 1,
    });
    harness.clearProjectionQueryObservations();
    const secondHistory = await readWorkflowV2Conversation(harness.readRuntime, harness.actor.sessionId,
      { conversationId: harness.actor.conversationId, cursor: firstHistory.nextCursor ?? undefined, limit: 100 });
    expect(secondHistory.messages).toHaveLength(1);
    expect(secondHistory.actionViews).toHaveLength(1);
    expect(secondHistory.nextCursor).toBeNull();
    const finalMessageId = orderedMessageIds[100];
    expect(harness.projectionQueryObservations()).toContainEqual({
      table: 'conversation_messages', cursor: finalMessageId, limit: 1, returnedCount: 0,
    });
    expect(new Set([...firstHistory.messages, ...secondHistory.messages].map(item => item.id)).size).toBe(total);
    expect([...firstHistory.messages, ...secondHistory.messages].map(item => item.id))
      .toEqual(orderedMessageIds);
    expectPublicReadShape(firstHistory);
    expectPublicReadShape(secondHistory);
    await expect(listWorkflowV2ActionViews(harness.readRuntime, harness.actor.sessionId, { limit: 101 })).rejects.toThrow();
    await expect(readWorkflowV2Conversation(harness.readRuntime, harness.actor.sessionId,
      { conversationId: harness.actor.conversationId, limit: 101 })).rejects.toThrow();
    expect(harness.forbiddenRunnerCalls()).toEqual([]);
  }));

  it('probes empty and short page tails and rejects duplicate, repeated-cursor, or truncated rows', async () => withHarness(async harness => {
    const actionOne = completedBranchAction({
      id: 'reads-cursor-action-a', actorId: harness.actor.profileId, sessionId: harness.actor.sessionId,
      conversationId: harness.actor.conversationId, turnId: 'reads-cursor-turn-a', identityId: harness.actor.identityId,
      branchId: harness.branchId, orgUnitId: harness.orgUnitId,
    });
    const actionTwo = completedBranchAction({
      id: 'reads-cursor-action-b', actorId: harness.actor.profileId, sessionId: harness.actor.sessionId,
      conversationId: harness.actor.conversationId, turnId: 'reads-cursor-turn-b', identityId: harness.actor.identityId,
      branchId: harness.branchId, orgUnitId: harness.orgUnitId,
    });
    await harness.insertAction(actionOne);
    await harness.insertAction(actionTwo);
    const messageOne = assistantMessage({
      actorId: harness.actor.profileId, sessionId: harness.actor.sessionId,
      conversationId: harness.actor.conversationId, turnId: actionOne.turnId, text: 'First cursor row.',
      pendingActionIds: [actionOne.id],
    });
    const messageTwo = assistantMessage({
      actorId: harness.actor.profileId, sessionId: harness.actor.sessionId,
      conversationId: harness.actor.conversationId, turnId: actionTwo.turnId, text: 'Second cursor row.',
      pendingActionIds: [actionTwo.id],
    });
    await harness.insertMessage(messageOne);
    await harness.insertMessage(messageTwo);

    const emptyConversationId = 'reads-empty-page-conversation';
    await harness.store.workflowTransaction(tx => tx.insertUnique('conversations', {
      id: emptyConversationId,
      actorId: harness.actor.profileId,
      title: 'Empty workflow read conversation',
      pinned: false,
      archivedAt: null,
      rowVersion: 1,
      createdAt: NOW,
      updatedAt: NOW,
      lastScope: null,
      lastDashboardId: null,
    }, { constraint: 'conversations_primary_key', values: { id: emptyConversationId } }).then(() => undefined));

    harness.clearProjectionQueryObservations();
    const emptyHistory = await readWorkflowV2Conversation(harness.readRuntime, harness.actor.sessionId,
      { conversationId: emptyConversationId, limit: 2 });
    expect(emptyHistory.messages).toEqual([]);
    expect(emptyHistory.nextCursor).toBeNull();
    expect(harness.projectionQueryObservations()).toContainEqual({
      table: 'conversation_messages', limit: 1, returnedCount: 0,
    });

    harness.clearProjectionQueryObservations();
    const shortActions = await listWorkflowV2ActionViews(harness.readRuntime, harness.actor.sessionId,
      { conversationId: harness.actor.conversationId, limit: 10 });
    expect(shortActions.actionViews.map(view => view.action.id)).toEqual([actionOne.id, actionTwo.id]);
    expect(shortActions.nextCursor).toBeNull();
    expect(harness.projectionQueryObservations()).toContainEqual({
      table: 'pending_actions', cursor: actionTwo.id, limit: 1, returnedCount: 0,
    });

    harness.clearProjectionQueryObservations();
    const shortHistory = await readWorkflowV2Conversation(harness.readRuntime, harness.actor.sessionId,
      { conversationId: harness.actor.conversationId, limit: 10 });
    const orderedMessages = [messageOne.id, messageTwo.id].sort();
    expect(shortHistory.messages.map(message => message.id)).toEqual(orderedMessages);
    expect(shortHistory.nextCursor).toBeNull();
    expect(harness.projectionQueryObservations()).toContainEqual({
      table: 'conversation_messages', cursor: orderedMessages[1], limit: 1, returnedCount: 0,
    });

    const firstActionRow = await harness.store.workflowProjectionReader.get<PendingActionV2>('pending_actions', actionOne.id);
    if (!firstActionRow) throw new Error('The cursor fixture action was not persisted.');
    const expectCursorConflict = async (override: ProjectionQueryOverride, read: () => Promise<unknown>) => {
      harness.setProjectionQueryOverride(override);
      try {
        await expect(read()).rejects.toMatchObject({ status: 409 });
      } finally {
        harness.setProjectionQueryOverride(undefined);
      }
    };

    await expectCursorConflict((query, rows) =>
      query.kind === 'scoped' && query.table === 'pending_actions' && query.cursor === undefined && query.limit === 2
        ? [rows[0]!, rows[0]!] : undefined,
    () => listWorkflowV2ActionViews(harness.readRuntime, harness.actor.sessionId, { limit: 2 }));
    await expectCursorConflict((query) =>
      query.kind === 'scoped' && query.table === 'pending_actions' && query.cursor === actionOne.id && query.limit === 1
        ? [firstActionRow] : undefined,
    () => listWorkflowV2ActionViews(harness.readRuntime, harness.actor.sessionId,
      { cursor: actionOne.id, limit: 1 }));
    await expectCursorConflict((query, rows) =>
      query.kind === 'scoped' && query.table === 'pending_actions' && query.cursor === undefined && query.limit === 2
        ? rows.slice(0, 1) : undefined,
    () => listWorkflowV2ActionViews(harness.readRuntime, harness.actor.sessionId, { limit: 2 }));
    await expectCursorConflict(query =>
      query.kind === 'scoped' && query.table === 'pending_actions' && query.cursor === undefined && query.limit === 2
        ? [] : undefined,
    () => listWorkflowV2ActionViews(harness.readRuntime, harness.actor.sessionId, { limit: 2 }));
    await expectCursorConflict((query, rows) =>
      query.kind === 'scoped' && query.table === 'conversation_messages' && query.cursor === undefined && query.limit === 2
        ? rows.slice(0, 1) : undefined,
    () => readWorkflowV2Conversation(harness.readRuntime, harness.actor.sessionId,
      { conversationId: harness.actor.conversationId, limit: 2 }));
    expect(harness.forbiddenRunnerCalls()).toEqual([]);
  }));

  it('returns exact prompt-only suggestions without persisting anything or invoking execution paths', async () => withHarness(async harness => {
    const snapshot = storageSnapshot(harness.fixture);
    const empty = await readWorkflowV2Suggestions(harness.readRuntime, harness.actor.sessionId);
    const contextual = await readWorkflowV2Suggestions(harness.readRuntime, harness.actor.sessionId, harness.actor.conversationId);
    for (const response of [empty, contextual]) {
      expect(response.actionContractVersion).toBe(2);
      expect(response.suggestions.length).toBeLessThanOrEqual(6);
      expect(response.suggestions.every(item => Object.keys(item).sort().join(',') === 'id,prompt')).toBe(true);
      expect(response.suggestions.every(item => item.id.length > 0 && item.prompt.trim().length > 0)).toBe(true);
      expectPublicReadShape(response);
    }
    expect(storageSnapshot(harness.fixture)).toEqual(snapshot);
    expect(harness.forbiddenRunnerCalls()).toEqual([]);
  }));
});
