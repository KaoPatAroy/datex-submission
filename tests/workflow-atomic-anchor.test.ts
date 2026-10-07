import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Profile } from '../lib/contracts';
import {
  assistantMessageId,
  guardedAssistantAnchorAdapter,
  linkAssistantMessage,
  type AssistantAnchorActor,
  type AssistantAnchorContext,
} from '../lib/core/conversation-actions';
import { digest } from '../lib/core/utils';
import { createWorkflowActionRuntime, defineWorkflowBinding, type RuntimeReadContext } from '../lib/workflows/action-runtime';
import { getWorkflowActionAuthority } from '../lib/workflows/action-authority';
import { WorkflowOperationError } from '../lib/workflows/action-results';
import { demoWorkflowPolicyV1, getDemoWorkflowPolicyV1Pin } from '../lib/workflows/policy';
import type {
  ExpectedRow,
  PendingActionV2,
  PersistedConversationMessage,
  PreparationResult,
  WorkflowPayloadV2,
  WorkflowStorageTable,
} from '../lib/workflows/contracts';
import type { WorkflowTransactionContext } from '../lib/storage/workflow-projections';
import { createWorkflowSqliteFixture } from './helpers/workflow-storage';
import { itSqliteBound } from './helpers/local-pg';

const NOW = '2026-10-03T04:00:00.000Z';
const KIND = 'onboarding_start' as const;
const AUTHORITY = getWorkflowActionAuthority(KIND);
const PACK_ID = 'hr';
const PACK_DIGEST = 'a'.repeat(64);
const RELEASE = 'workflow-atomic-anchor-test-r1';

type Payload = Extract<WorkflowPayloadV2, { kind: typeof KIND }>;
type Fixture = Awaited<ReturnType<typeof createWorkflowSqliteFixture>>;
type Store = Fixture['store'];

interface Harness {
  fixture: Fixture;
  store: Store;
  runtime: ReturnType<typeof createWorkflowActionRuntime>;
  profileId: string;
  sessionId: string;
  identityId: string;
  orgUnitId: string;
  sourceId: string;
  conversationId: string;
  turnId: string;
  validationCalls(): number;
  prepare(requestId: string): Promise<PreparationResult>;
}

function conversationRow(id: string, actorId: string) {
  return {
    id,
    actorId,
    title: 'Atomic anchor test conversation',
    pinned: false,
    archivedAt: null,
    rowVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
    lastScope: null,
    lastDashboardId: null,
  };
}

async function createHarness(): Promise<Harness> {
  const fixture = await createWorkflowSqliteFixture();
  const store = fixture.store;
  const suffix = randomUUID().replaceAll('-', '');
  const profileId = `anchor-profile-${suffix}`;
  const sessionId = `anchor-session-${suffix}`;
  const identityId = `anchor-identity-${suffix}`;
  const orgUnitId = `anchor-org-${suffix}`;
  const sourceId = `anchor-source-${suffix}`;
  const conversationId = `anchor-conversation-${suffix}`;
  const turnId = `anchor-turn-${suffix}`;
  const profile: Profile = {
    id: profileId,
    name: 'Atomic anchor test profile',
    role: 'hr_admin',
    active: true,
    permissions: [AUTHORITY.permission, ...AUTHORITY.readPermissions],
    regions: ['east'],
  };
  let generatedId = 0;
  let validationCount = 0;

  try {
    await store.transaction(async (tx) => {
      await tx.put('profiles', profile);
      await tx.put('sessions', {
        id: sessionId,
        profileId,
        mode: 'scripted_demo',
        modeRevision: 1,
        csrfToken: `anchor-csrf-${suffix}`,
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      await tx.put('branches', { id: sourceId, name: 'Atomic anchor source', region: 'east' });
    });

    const policyPin = getDemoWorkflowPolicyV1Pin();
    await store.workflowTransaction(async (tx) => {
      await tx.insertUnique('org_units', {
        id: orgUnitId,
        name: 'Atomic anchor test organization',
        parentOrgUnitId: null,
        active: true,
      }, { constraint: 'org_units_primary_key', values: { id: orgUnitId } });
      await tx.insertUnique('directory_identities', {
        id: identityId,
        profileId,
        displayName: 'Atomic anchor test actor',
        active: true,
        role: 'hr_admin',
        department: 'hr',
        orgUnitId,
        managerIdentityId: null,
        verifiedDemoEmail: `anchor-${suffix}@example.invalid`,
        slackIdentity: null,
        allowedChannels: ['simulated_email'],
        classificationCeiling: 'internal',
        rowVersion: 1,
      }, { constraint: 'directory_identities_primary_key', values: { id: identityId } });
      await tx.insertUnique('responsibilities', {
        id: `anchor-responsibility-${suffix}`,
        identityId,
        orgUnitId,
        purpose: 'hr_operations',
        branchIds: [],
        active: true,
        rowVersion: 1,
      }, {
        constraint: 'responsibilities_open_identity_purpose_unique',
        values: { identityId, purpose: 'hr_operations', orgUnitId },
      });
      await tx.insertUnique('conversations', conversationRow(conversationId, profileId), {
        constraint: 'conversations_primary_key', values: { id: conversationId },
      });
      await tx.insertUnique('workflow_policies', {
        id: `anchor-policy-${suffix}`,
        version: policyPin.version,
        digest: policyPin.digest,
        policy: demoWorkflowPolicyV1,
      }, { constraint: 'workflow_policies_primary_key', values: { id: `anchor-policy-${suffix}` } });
    });

    const binding = defineWorkflowBinding({
      kind: KIND,
      contractVersion: 2,
      packIds: [PACK_ID],
      executionMode: 'atomic_local',
      authority: {
        permission: AUTHORITY.permission,
        roles: [...AUTHORITY.roles],
        purpose: AUTHORITY.purpose,
      },
      async identify(_context: RuntimeReadContext, payload: Payload) {
        if (!await _context.projections.get('branches', sourceId)) {
          throw new Error('The atomic anchor source row is unavailable.');
        }
        const semanticKey = digest({ kind: payload.kind, requestId: payload.requestId });
        return {
          targets: [{
            targetId: payload.requestId,
            ref: { table: 'branches', id: sourceId },
            semanticKey,
            scope: { orgUnitId },
          }],
        };
      },
      expectedPostconditions() {
        return [];
      },
      async validate(_context: RuntimeReadContext, payload: Payload) {
        validationCount += 1;
        const source = await _context.projections.get('branches', sourceId);
        if (!source) throw new Error('The atomic anchor source row is unavailable.');
        const sourceGuard: ExpectedRow = {
          ref: { table: 'branches', id: sourceId },
          rowVersion: source.rowVersion,
          state: null,
        };
        const semanticKey = digest({ kind: payload.kind, requestId: payload.requestId });
        const targets = [{
          targetId: payload.requestId,
          ref: { table: 'branches' as const, id: sourceId },
          semanticKey,
          expectedRows: [sourceGuard],
          ownerIdentityId: identityId,
          expectedEffectRef: { table: 'onboarding_tasks' as const, id: `anchor-task-${payload.requestId}` },
          expectedEffectVersion: 1,
        }];
        return {
          targets,
          expectedRows: [sourceGuard],
          approvedBranchIds: [],
          approvedOrgUnitIds: [orgUnitId],
          policy: getDemoWorkflowPolicyV1Pin(),
          reviewedSnapshotId: null,
        };
      },
      async executeAtomic() {
        return [];
      },
      async verify() {
        return [];
      },
      async currentStates() {
        return [];
      },
    });

    const runtime = createWorkflowActionRuntime({
      store,
      bindings: [binding],
      businessDate: '2026-10-03',
      getReleaseRevision: () => RELEASE,
      getPackPins: (packIds) => packIds.map((id) => ({
        id,
        version: '1.0',
        schemaDigest: PACK_DIGEST,
        implementationRevision: 'atomic-anchor-test-implementation-r1',
      })),
      contextFactory: () => ({
        evidence: async () => { throw new Error('The atomic anchor binding does not read external evidence.'); },
        latestDashboard: async () => undefined,
      }),
      now: () => new Date(NOW),
      makeId: (prefix) => `anchor-${prefix}-${suffix}-${++generatedId}`,
    });

    return {
      fixture,
      store,
      runtime,
      profileId,
      sessionId,
      identityId,
      orgUnitId,
      sourceId,
      conversationId,
      turnId,
      validationCalls: () => validationCount,
      prepare: (requestId) => runtime.prepare(sessionId, { kind: KIND, requestId }, { conversationId, turnId }),
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
    await harness.fixture.dispose();
  }
}

function requirePendingAction(result: PreparationResult): PendingActionV2 {
  if (!result.pendingAction) throw new Error(`Expected a persisted pending action, received ${result.outcome}.`);
  return result.pendingAction;
}

async function readActions(store: Store, actorId: string): Promise<Array<{ id: string; actorId: string }>> {
  const rows = await store.workflowProjectionReader.query<{ id: string; actorId: string }>({
    kind: 'scoped', table: 'pending_actions', equals: { actorId }, limit: 100,
  });
  return rows.map((row) => row.body);
}

async function readAudits(store: Store, actorId: string): Promise<Array<{ id: string; actionId?: string; category: string }>> {
  const rows = await store.workflowProjectionReader.query<{ id: string; actionId?: string; category: string }>({
    kind: 'scoped', table: 'audit_events', equals: { actorId }, limit: 100,
  });
  return rows.map((row) => row.body);
}

async function expectRejectedAnchor(
  harness: Harness,
  actor: AssistantAnchorActor,
  context: AssistantAnchorContext,
  actionId: string,
): Promise<void> {
  await expect(harness.store.workflowTransaction((tx) => linkAssistantMessage(
    guardedAssistantAnchorAdapter(tx as WorkflowTransactionContext), actor, context,
    { appendActionIds: [actionId], now: new Date(NOW) },
  ))).rejects.toMatchObject({ code: 'CONFLICT' });
}

function installArchivedConversationRead(store: Store, conversationId: string): void {
  const original = store.workflowTransaction.bind(store);
  let archiveReadArmed = false;
  store.workflowTransaction = <T>(work: (tx: WorkflowTransactionContext) => Promise<T>): Promise<T> => original(async (tx) => {
    const intercepted = new Proxy(tx, {
      get(target, property, receiver) {
        if (property === 'insertUnique') {
          return async <Row extends { id: string }>(
            table: WorkflowStorageTable,
            row: Row,
            key: { constraint: string; values: Record<string, string | number> },
          ) => {
            const result = await target.insertUnique(table, row, key);
            if (!archiveReadArmed && table === 'pending_actions') archiveReadArmed = true;
            return result;
          };
        }
        if (property === 'get') {
          return async <Row>(table: WorkflowStorageTable, id: string): Promise<Row | undefined> => {
            const row = await target.get<Row>(table, id);
            if (archiveReadArmed && table === 'conversations' && id === conversationId &&
              typeof row === 'object' && row !== null) {
              archiveReadArmed = false;
              return { ...row, archivedAt: NOW } as Row;
            }
            return row;
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as WorkflowTransactionContext;
    return work(intercepted);
  });
}

function installLostCommitResponse(store: Store, failReadback: boolean): () => number {
  const original = store.workflowTransaction.bind(store);
  let calls = 0;
  store.workflowTransaction = async <T>(work: (tx: WorkflowTransactionContext) => Promise<T>): Promise<T> => {
    calls += 1;
    if (failReadback && calls === 2) throw new Error('Injected readback transport failure.');
    const result = await original(work);
    if (calls === 1) throw new Error('Injected lost response after SQLite committed.');
    return result;
  };
  return () => calls;
}

describe('V2 assistant action anchors', () => {
  it('persists the prepared action ID on the exact assistant turn before returning', async () => withHarness(async (harness) => {
    const result = await harness.prepare('anchor-request-first');
    const action = requirePendingAction(result);
    const messageId = assistantMessageId(harness.profileId, {
      conversationId: harness.conversationId,
      turnId: harness.turnId,
    });
    const message = await harness.store.get<PersistedConversationMessage>('conversation_messages', messageId);

    expect(result.outcome).toBe('pending');
    expect(message).toMatchObject({
      id: messageId,
      actorId: harness.profileId,
      sessionId: harness.sessionId,
      conversationId: harness.conversationId,
      turnId: harness.turnId,
      role: 'assistant',
      pendingActionId: action.id,
      pendingActionIds: [action.id],
    });
    expect(await readAudits(harness.store, harness.profileId)).toContainEqual(expect.objectContaining({
      actionId: action.id,
      category: 'workflow_prepare',
    }));
  }));

  it('accumulates two distinct prepares on one turn once each and in prepare order', async () => withHarness(async (harness) => {
    const first = requirePendingAction(await harness.prepare('anchor-request-first'));
    const second = requirePendingAction(await harness.prepare('anchor-request-second'));
    const messageId = assistantMessageId(harness.profileId, {
      conversationId: harness.conversationId,
      turnId: harness.turnId,
    });
    const message = await harness.store.get<PersistedConversationMessage>('conversation_messages', messageId);

    expect(second.id).not.toBe(first.id);
    expect(message?.pendingActionIds).toEqual([first.id, second.id]);
    expect(message?.pendingActionId).toBe(second.id);
    expect(new Set(message?.pendingActionIds).size).toBe(2);
  }));

  it('reuses one action, audit, and anchor for an identical prepare on the same turn', async () => withHarness(async (harness) => {
    const first = requirePendingAction(await harness.prepare('anchor-request-identical'));
    const repeated = requirePendingAction(await harness.prepare('anchor-request-identical'));
    const messageId = assistantMessageId(harness.profileId, {
      conversationId: harness.conversationId,
      turnId: harness.turnId,
    });
    const message = await harness.store.get<PersistedConversationMessage>('conversation_messages', messageId);
    const prepareAudits = (await readAudits(harness.store, harness.profileId))
      .filter((audit) => audit.category === 'workflow_prepare');

    expect(repeated.id).toBe(first.id);
    expect(await readActions(harness.store, harness.profileId)).toHaveLength(1);
    expect(prepareAudits).toHaveLength(1);
    expect(message?.pendingActionIds).toEqual([first.id]);
    expect(message?.pendingActionId).toBe(first.id);
  }));

  it('requires a fresh turn when the reviewed source guard changes before identical reprepare', async () => withHarness(async (harness) => {
    const first = requirePendingAction(await harness.prepare('anchor-request-source-change'));
    await harness.store.workflowTransaction(async (tx) => {
      const workflowTx = tx as WorkflowTransactionContext;
      const source = await workflowTx.workflowProjectionReader.get<{ id: string; name: string; region: string }>(
        'branches', harness.sourceId,
      );
      if (!source) throw new Error('The source row disappeared before the controlled source change.');
      const changed = await workflowTx.compareAndSwap('branches', harness.sourceId,
        { rowVersion: source.rowVersion, state: null },
        { ...source.body, rowVersion: source.rowVersion + 1, name: 'Changed atomic anchor source' });
      if (!changed.updated) throw new Error('The controlled source row did not change.');
    });

    const repeated = await harness.prepare('anchor-request-source-change');
    const messageId = assistantMessageId(harness.profileId, {
      conversationId: harness.conversationId,
      turnId: harness.turnId,
    });
    const message = await harness.store.get<PersistedConversationMessage>('conversation_messages', messageId);
    const prepareAudits = (await readAudits(harness.store, harness.profileId))
      .filter((audit) => audit.category === 'workflow_prepare');

    expect(repeated).toMatchObject({ outcome: 'stale', pendingAction: null });
    expect((await readActions(harness.store, harness.profileId)).map((action) => action.id)).toEqual([first.id]);
    expect(prepareAudits).toHaveLength(1);
    expect(message?.pendingActionIds).toEqual([first.id]);
    expect(message?.pendingActionId).toBe(first.id);
  }));

  itSqliteBound('rolls back the action and prepare audit when the SQLite assistant-anchor insert fails', async () => withHarness(async (harness) => {
    const messageId = assistantMessageId(harness.profileId, {
      conversationId: harness.conversationId,
      turnId: harness.turnId,
    });
    const database = harness.fixture.openDatabase();
    try {
      database.exec(`CREATE TRIGGER fail_atomic_anchor BEFORE INSERT ON conversation_messages
        WHEN NEW.id = '${messageId}' BEGIN SELECT RAISE(ABORT, 'injected assistant-anchor insert failure'); END;`);
      await expect(harness.prepare('anchor-request-insert-failure')).rejects.toBeInstanceOf(WorkflowOperationError);

      expect(await readActions(harness.store, harness.profileId)).toEqual([]);
      expect((await readAudits(harness.store, harness.profileId)).filter((audit) => audit.category === 'workflow_prepare')).toEqual([]);
      expect(await harness.store.get('conversation_messages', messageId)).toBeUndefined();
    } finally {
      database.close();
    }
  }));

  it('linker rejects an archived conversation and rolls back the prepared action and audit', async () => withHarness(async (harness) => {
    installArchivedConversationRead(harness.store, harness.conversationId);
    await expect(harness.prepare('anchor-request-archive-check')).rejects.toMatchObject({
      details: {
        code: 'ARCHIVED_CONVERSATION',
        commitCertainty: 'definitely_not_committed',
        domainEffect: 'none',
        retryBusinessWrite: false,
      },
    });
    const messageId = assistantMessageId(harness.profileId, {
      conversationId: harness.conversationId,
      turnId: harness.turnId,
    });
    const conversation = await harness.store.get<{ archivedAt: string | null }>('conversations', harness.conversationId);

    expect(await readActions(harness.store, harness.profileId)).toEqual([]);
    expect((await readAudits(harness.store, harness.profileId)).filter((audit) => audit.category === 'workflow_prepare')).toEqual([]);
    expect(conversation?.archivedAt).toBeNull();
    expect(await harness.store.get('conversation_messages', messageId)).toBeUndefined();
  }));

  it('rejects an action reference whose actor does not match the prepared action', async () => withHarness(async (harness) => {
    const action = requirePendingAction(await harness.prepare('anchor-request-actor-mismatch'));
    const otherProfileId = `anchor-other-profile-${randomUUID().replaceAll('-', '')}`;
    const otherSessionId = `anchor-other-session-${randomUUID().replaceAll('-', '')}`;
    const otherConversationId = `anchor-other-conversation-${randomUUID().replaceAll('-', '')}`;
    await harness.store.transaction(async (tx) => {
      await tx.put('profiles', {
        id: otherProfileId,
        name: 'Other anchor actor',
        role: 'hr_admin',
        active: true,
        permissions: [],
        regions: ['east'],
      });
      await tx.put('sessions', {
        id: otherSessionId,
        profileId: otherProfileId,
        mode: 'scripted_demo',
        modeRevision: 1,
        csrfToken: `csrf-${otherSessionId}`,
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
    });
    await harness.store.workflowTransaction((tx) => tx.insertUnique('conversations',
      conversationRow(otherConversationId, otherProfileId),
      { constraint: 'conversations_primary_key', values: { id: otherConversationId } }));

    await expectRejectedAnchor(harness, {
      id: otherProfileId,
      sessionId: otherSessionId,
      mode: 'scripted_demo',
      modeRevision: 1,
    }, { conversationId: otherConversationId, turnId: harness.turnId }, action.id);
  }));

  it('rejects an action reference whose session does not match the prepared action', async () => withHarness(async (harness) => {
    const action = requirePendingAction(await harness.prepare('anchor-request-session-mismatch'));
    await expectRejectedAnchor(harness, {
      id: harness.profileId,
      sessionId: `anchor-other-session-${randomUUID().replaceAll('-', '')}`,
      mode: 'scripted_demo',
      modeRevision: 1,
    }, { conversationId: harness.conversationId, turnId: harness.turnId }, action.id);
  }));

  it('rejects an action reference whose conversation does not match the prepared action', async () => withHarness(async (harness) => {
    const action = requirePendingAction(await harness.prepare('anchor-request-conversation-mismatch'));
    const otherConversationId = `anchor-second-conversation-${randomUUID().replaceAll('-', '')}`;
    await harness.store.workflowTransaction((tx) => tx.insertUnique('conversations',
      conversationRow(otherConversationId, harness.profileId),
      { constraint: 'conversations_primary_key', values: { id: otherConversationId } }));

    await expectRejectedAnchor(harness, {
      id: harness.profileId,
      sessionId: harness.sessionId,
      mode: 'scripted_demo',
      modeRevision: 1,
    }, { conversationId: otherConversationId, turnId: harness.turnId }, action.id);
  }));

  it('rejects an action reference whose turn does not match the prepared action', async () => withHarness(async (harness) => {
    const action = requirePendingAction(await harness.prepare('anchor-request-turn-mismatch'));
    await expectRejectedAnchor(harness, {
      id: harness.profileId,
      sessionId: harness.sessionId,
      mode: 'scripted_demo',
      modeRevision: 1,
    }, { conversationId: harness.conversationId, turnId: `anchor-other-turn-${randomUUID().replaceAll('-', '')}` }, action.id);
  }));

  it('keeps the persisted anchor readable after a later final-summary failure', async () => withHarness(async (harness) => {
    const action = requirePendingAction(await harness.prepare('anchor-request-summary-failure'));
    const messageId = assistantMessageId(harness.profileId, {
      conversationId: harness.conversationId,
      turnId: harness.turnId,
    });
    const summarizeFinalResponse = async (): Promise<string> => {
      throw new Error('Injected final AI summary failure.');
    };

    await expect(summarizeFinalResponse()).rejects.toThrow('Injected final AI summary failure.');
    const database = harness.fixture.openDatabase();
    try {
      const persisted = database.prepare('SELECT payload FROM conversation_messages WHERE id = ?').get(messageId) as
        { payload: string } | undefined;
      expect(persisted).toBeDefined();
      const body = JSON.parse(persisted!.payload) as PersistedConversationMessage;
      expect(body.pendingActionIds).toEqual([action.id]);
      expect(body.pendingActionId).toBe(action.id);
      expect(await harness.store.workflowProjectionReader.get<PendingActionV2>('pending_actions', action.id))
        .toMatchObject({ body: { id: action.id } });
    } finally {
      database.close();
    }
  }));

  it('returns the same prepared action after SQLite committed but its response was lost', async () => withHarness(async (harness) => {
    const transactionCalls = installLostCommitResponse(harness.store, false);
    const result = await harness.prepare('anchor-request-response-lost');
    const action = requirePendingAction(result);
    const messageId = assistantMessageId(harness.profileId, {
      conversationId: harness.conversationId,
      turnId: harness.turnId,
    });
    const message = await harness.store.get<PersistedConversationMessage>('conversation_messages', messageId);

    expect(result.outcome).toBe('pending');
    expect((await readActions(harness.store, harness.profileId)).map((row) => row.id)).toEqual([action.id]);
    expect(message?.pendingActionIds).toEqual([action.id]);
    expect((await readAudits(harness.store, harness.profileId)).filter((audit) => audit.category === 'workflow_prepare'))
      .toHaveLength(1);
    expect(transactionCalls()).toBe(2);
    expect(harness.validationCalls()).toBe(1);
  }));

  it('requires explicit readback after a lost commit response and never retries preparation automatically', async () => withHarness(async (harness) => {
    const transactionCalls = installLostCommitResponse(harness.store, true);
    await expect(harness.prepare('anchor-request-unknown-response')).rejects.toMatchObject({
      details: {
        outcome: 'pending',
        commitCertainty: 'unknown',
        domainEffect: 'unknown',
        nextStep: 'readback_existing',
        retryBusinessWrite: false,
      },
    });

    const actions = await readActions(harness.store, harness.profileId);
    expect(actions).toHaveLength(1);
    expect(transactionCalls()).toBe(3);
    expect(harness.validationCalls()).toBe(1);
  }));
});
