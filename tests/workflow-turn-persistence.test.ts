import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Profile, Transaction } from '../lib/contracts';
import {
  assistantMessageId,
  guardedAssistantAnchorAdapter,
  linkAssistantMessage,
  type AssistantAnchorContent,
} from '../lib/core/conversation-actions';
import {
  admitTurn,
  failTurn,
  finalizeTurn,
  recoverRecordedTurn,
  type WorkflowTurnPersistenceOptions,
  type WorkflowTurnRecord,
} from '../lib/core/workflow-turn-persistence';
import { digest } from '../lib/core/utils';
import { WorkflowStorageError } from '../lib/storage/sqlite';
import type { WorkflowStoreCapability } from '../lib/storage/workflow-projections';
import { readCompletedTurn, turnCompletionId, type TurnCompletionRecord } from '../lib/core/turn-completion-gate';
import {
  pendingActionV2Schema,
  type PendingActionV2,
  type PersistedConversation,
} from '../lib/workflows/contracts';
import type { WorkflowChatRequestV2 } from '../lib/workflows/api-contracts';
import { workflowApprovalHash } from '../lib/workflows/action-runtime';
import { demoWorkflowPolicyV1, getDemoWorkflowPolicyV1Pin } from '../lib/workflows/policy';
import { createWorkflowSqliteFixture } from './helpers/workflow-storage';

const NOW = '2026-10-04T04:00:00.000Z';
const FUTURE = '2099-01-01T00:00:00.000Z';
const PAST = '2026-10-04T03:59:00.000Z';
const FINAL_CONTENT = { text: 'The synthetic workflow answer is ready.' };

type Fixture = Awaited<ReturnType<typeof createWorkflowSqliteFixture>>;
type Store = WorkflowTurnPersistenceOptions['store'];

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
  options: WorkflowTurnPersistenceOptions;
  actor: ActorSeed;
  foreign: ActorSeed;
  expiredSessionId: string;
  orgUnitId: string;
  close(): Promise<void>;
}

function profile(id: string): Profile {
  return {
    id,
    name: 'Workflow turn persistence test actor',
    role: 'hr_admin',
    active: true,
    permissions: ['badge.revoke', 'hr.read'],
    regions: [],
  };
}

function conversation(id: string, actorId: string, archivedAt: string | null = null): PersistedConversation {
  return {
    id,
    actorId,
    title: 'Turn persistence fixture conversation',
    pinned: false,
    pinnedAt: null,
    archivedAt,
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
  const orgUnitId = `turn-persist-org-${suffix}`;
  const actor: ActorSeed = {
    profileId: `turn-persist-profile-${suffix}`,
    sessionId: `turn-persist-session-${suffix}`,
    identityId: `turn-persist-identity-${suffix}`,
    responsibilityId: `turn-persist-responsibility-${suffix}`,
    conversationId: `turn-persist-conversation-${suffix}`,
  };
  const foreign: ActorSeed = {
    profileId: `turn-persist-foreign-profile-${suffix}`,
    sessionId: `turn-persist-foreign-session-${suffix}`,
    identityId: `turn-persist-foreign-identity-${suffix}`,
    responsibilityId: `turn-persist-foreign-responsibility-${suffix}`,
    conversationId: `turn-persist-foreign-conversation-${suffix}`,
  };
  const expiredSessionId = `turn-persist-expired-session-${suffix}`;
  let generatedId = 0;

  try {
    await store.transaction(async (tx) => {
      for (const seed of [actor, foreign]) {
        await tx.put('profiles', profile(seed.profileId));
        await tx.put('sessions', {
          id: seed.sessionId,
          profileId: seed.profileId,
          mode: 'scripted_demo',
          modeRevision: 7,
          csrfToken: `csrf-${seed.sessionId}`,
          expiresAt: FUTURE,
        });
      }
      await tx.put('sessions', {
        id: expiredSessionId,
        profileId: actor.profileId,
        mode: 'scripted_demo',
        modeRevision: 7,
        csrfToken: `csrf-${expiredSessionId}`,
        expiresAt: PAST,
      });
    });

    const policyPin = getDemoWorkflowPolicyV1Pin();
    await store.workflowTransaction(async (tx) => {
      await tx.insertUnique('org_units', {
        id: orgUnitId,
        name: 'Turn persistence test organization',
        parentOrgUnitId: null,
        active: true,
      }, { constraint: 'org_units_primary_key', values: { id: orgUnitId } });
      for (const seed of [actor, foreign]) {
        await tx.insertUnique('directory_identities', {
          id: seed.identityId,
          profileId: seed.profileId,
          displayName: 'Turn persistence test actor',
          active: true,
          role: 'hr_admin',
          department: 'hr',
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
          purpose: 'hr_operations',
          branchIds: [],
          active: true,
          rowVersion: 1,
        }, { constraint: 'responsibilities_open_identity_purpose_unique', values: {
          identityId: seed.identityId,
          purpose: 'hr_operations',
          orgUnitId,
        } });
        await tx.insertUnique('conversations', conversation(seed.conversationId, seed.profileId), {
          constraint: 'conversations_primary_key', values: { id: seed.conversationId },
        });
      }
      await tx.insertUnique('conversations', conversation(`turn-persist-archived-${suffix}`, actor.profileId, NOW), {
        constraint: 'conversations_primary_key', values: { id: `turn-persist-archived-${suffix}` },
      });
      await tx.insertUnique('workflow_policies', {
        id: policyPin.id,
        version: policyPin.version,
        digest: policyPin.digest,
        policy: demoWorkflowPolicyV1,
      }, { constraint: 'workflow_policies_primary_key', values: { id: policyPin.id } });
    });

    const options: WorkflowTurnPersistenceOptions = {
      store,
      now: () => new Date(NOW),
      makeId: (prefix) => `turn-persist-${prefix}-${suffix}-${++generatedId}`,
    };
    return { fixture, store, options, actor, foreign, expiredSessionId, orgUnitId, close: () => fixture.dispose() };
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
    await harness.close();
  }
}

function request(requestKey: string, overrides: Partial<WorkflowChatRequestV2> = {}): WorkflowChatRequestV2 {
  return {
    actionContractVersion: 2,
    contractVersion: 2,
    requestKey,
    message: 'Summarize the current synthetic workflow state.',
    ...overrides,
  };
}

function actionForTurn(input: {
  id: string;
  actorId: string;
  sessionId: string;
  conversationId: string;
  turnId: string;
  mode: 'live_ai' | 'scripted_demo';
  modeRevision: number;
  identityId: string;
  orgUnitId: string;
}): PendingActionV2 {
  const badgeId = `${input.id}-badge`;
  const expected = { ref: { table: 'mock_badges' as const, id: badgeId }, rowVersion: 1, state: 'active' };
  const action = pendingActionV2Schema.parse({
    id: input.id,
    contractVersion: 2,
    actorId: input.actorId,
    sessionId: input.sessionId,
    conversationId: input.conversationId,
    turnId: input.turnId,
    mode: input.mode,
    modeRevision: input.modeRevision,
    payload: { kind: 'badge_revoke', badgeId, employeeId: `${input.id}-employee`, reason: 'Synthetic test action.' },
    payloadHash: '0'.repeat(64),
    idempotencyKey: digest({ purpose: 'turn-persistence-action', id: input.id }),
    targets: [{
      targetId: `${input.id}-target`,
      ref: expected.ref,
      semanticKey: digest({ purpose: 'turn-persistence-semantic', id: input.id }),
      expectedRows: [expected],
      ownerIdentityId: input.identityId,
      expectedEffectRef: expected.ref,
      expectedEffectVersion: 2,
    }],
    targetCount: 1,
    expectedRows: [expected],
    approvedBranchIds: [],
    approvedOrgUnitIds: [input.orgUnitId],
    reviewedSnapshotId: null,
    policy: getDemoWorkflowPolicyV1Pin(),
    packs: [],
    releaseRevision: 'turn-persistence-test-r1',
    executionMode: 'atomic_local',
    createdAt: NOW,
    expiresAt: FUTURE,
    status: 'pending',
  });
  return pendingActionV2Schema.parse({ ...action, payloadHash: workflowApprovalHash(action) });
}

async function seedPreparedActionAnchor(harness: Harness, record: {
  actorId: string;
  sessionId: string;
  conversationId: string;
  turnId: string;
  mode: 'live_ai' | 'scripted_demo';
  modeRevision: number;
}, actionId: string): Promise<void> {
  const action = actionForTurn({
    ...record,
    id: actionId,
    identityId: harness.actor.identityId,
    orgUnitId: harness.orgUnitId,
  });
  await harness.store.workflowTransaction(async (tx) => {
    await tx.insertUnique('pending_actions', action, {
      constraint: 'pending_actions_primary_key', values: { id: action.id },
    });
    await linkAssistantMessage(guardedAssistantAnchorAdapter(tx), {
      id: record.actorId,
      sessionId: record.sessionId,
      mode: record.mode,
      modeRevision: record.modeRevision,
    }, { conversationId: record.conversationId, turnId: record.turnId },
    { appendActionIds: [action.id], now: new Date(NOW) });
  });
}

function interceptTransaction(
  store: Store & WorkflowStoreCapability,
  behavior: 'fail_before_commit' | 'lose_commit_ack',
  callNumber = 1,
) {
  let intercepted = false;
  let calls = 0;
  const interceptedStore = new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'transaction') {
        return async <T>(work: (tx: Transaction) => Promise<T>): Promise<T> => {
          calls += 1;
          if (!intercepted && calls === callNumber) {
            intercepted = true;
            if (behavior === 'fail_before_commit') {
              throw new WorkflowStorageError('STORAGE', 'Synthetic definite pre-commit failure.', true);
            }
            await target.transaction(work);
            throw new Error('Synthetic lost acknowledgement after commit.');
          }
          return target.transaction(work);
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const options: WorkflowTurnPersistenceOptions = { store: interceptedStore, now: () => new Date(NOW) };
  return { options, intercepted: () => intercepted };
}

describe('workflow turn persistence', () => {
  it('withholds a prepared review after mode changes and does not revive it when the mode changes back', async () => withHarness(async (harness) => {
    const input = request('turn-persist-recovery-mode-drift-0001');
    const admitted = await admitTurn(harness.options, harness.actor.sessionId, input);
    if (admitted.kind !== 'admitted') throw new Error('The mode-drift fixture was not admitted.');
    const actionId = `turn-persist-mode-action-${randomUUID().replaceAll('-', '')}`;
    await seedPreparedActionAnchor(harness, admitted.record, actionId);
    const before = await recoverRecordedTurn(harness.options, harness.actor.sessionId, input);
    expect(before).toMatchObject({ kind: 'recoverable', actions: [{ id: actionId, status: 'pending' }] });
    const storedBefore = await harness.store.workflowProjectionReader.get('pending_actions', actionId);
    for (const mode of ['live_ai', 'scripted_demo'] as const) {
      await harness.store.transaction(async tx => {
        const session = await tx.get<{ id: string; modeRevision: number }>('sessions', harness.actor.sessionId);
        if (!session) throw new Error('The mode-drift fixture session disappeared.');
        await tx.put('sessions', { ...session, mode, modeRevision: session.modeRevision + 1 });
      });
      const recovery = await recoverRecordedTurn(harness.options, harness.actor.sessionId, input);
      expect(recovery).toMatchObject({ kind: 'unavailable', reason: 'references_unavailable' });
      expect(recovery).not.toHaveProperty('assistant');
      expect(recovery).not.toHaveProperty('actions');
      expect(await admitTurn(harness.options, harness.actor.sessionId, input))
        .toMatchObject({ kind: 'recorded', recovery: { kind: 'unavailable', reason: 'references_unavailable' } });
      expect(await harness.store.workflowProjectionReader.get('pending_actions', actionId)).toEqual(storedBefore);
    }
  }));

  it('titles a new conversation from the first message and keeps a renamed title on later turns', async () => withHarness(async (harness) => {
    const first = await admitTurn(harness.options, harness.actor.sessionId,
      request('turn-persist-title-first-0001', { message: '  ยอดขาย\n  ภาคตะวันออก  ' }));
    if (first.kind !== 'admitted') throw new Error('The title fixture was not admitted.');
    const conversationId = first.record.conversationId;
    expect(await harness.store.get<PersistedConversation>('conversations', conversationId)).toMatchObject({ title: 'ยอดขาย ภาคตะวันออก' });
    const stored = await harness.store.get<PersistedConversation>('conversations', conversationId);
    await harness.store.transaction(async tx => { await tx.put('conversations', { ...stored!, title: 'ชื่อที่ตั้งเอง', rowVersion: (stored!.rowVersion ?? 1) + 1 }); });
    const second = await admitTurn(harness.options, harness.actor.sessionId,
      request('turn-persist-title-second-0001', { message: 'คำถามถัดไป', conversationId }));
    if (second.kind !== 'admitted') throw new Error('The second title turn was not admitted.');
    expect(await harness.store.get<PersistedConversation>('conversations', conversationId)).toMatchObject({ title: 'ชื่อที่ตั้งเอง' });
  }));

  it('never grants fresh dispatch after losing the first admission acknowledgement', async () => withHarness(async (harness) => {
    const input = request('turn-persist-admission-lost-ack-0001');
    const beforeMessages = await harness.store.list('conversation_messages', { actorId: harness.actor.profileId });
    const beforeConversations = await harness.store.list('conversations', { actorId: harness.actor.profileId });
    const beforeLedgers = await harness.store.list('tool_executions', { actorId: harness.actor.profileId });
    const intercepted = interceptTransaction(harness.store, 'lose_commit_ack');
    let dispatches = 0;
    const uncertain = await admitTurn(intercepted.options, harness.actor.sessionId, input);
    if (uncertain.kind === 'admitted') dispatches += 1;
    expect(intercepted.intercepted()).toBe(true);
    expect(uncertain).toMatchObject({ kind: 'recorded', recovery: { kind: 'in_progress', record: { status: 'started' } } });
    const replayed = await admitTurn(harness.options, harness.actor.sessionId, input);
    if (replayed.kind === 'admitted') dispatches += 1;
    expect(replayed).toMatchObject({ kind: 'recorded', recovery: { kind: 'in_progress', record: { status: 'started' } } });
    expect(dispatches).toBe(0);
    if (uncertain.kind !== 'recorded' || replayed.kind !== 'recorded') throw new Error('An uncertain admission was redispatched.');
    expect(replayed.recovery.record?.id).toBe(uncertain.recovery.record?.id);
    expect(await harness.store.list('conversation_messages', { actorId: harness.actor.profileId })).toHaveLength(beforeMessages.length + 1);
    expect(await harness.store.list('conversations', { actorId: harness.actor.profileId })).toHaveLength(beforeConversations.length + 1);
    expect(await harness.store.list('tool_executions', { actorId: harness.actor.profileId })).toHaveLength(beforeLedgers.length + 2);
  }));

  const unprovedMetadata = [
    ['analysis', { analysis: { facts: [{ text: 'Synthetic private fact outside the new responsibility', sourceIds: ['hr:employees:prior-scope'] }],
      relationships: [], hypotheses: [], missingEvidence: [], generatedAt: NOW, evidenceVersion: 'synthetic-private-evidence' } }],
    ['evidence', { evidence: { scope: { region: 'all', date: '2026-10-04', branchIds: [] }, asOf: NOW,
      version: 'synthetic-private-evidence', branches: [], totals: { netSales: 0, target: 0, gap: 0, achievement: null }, sources: [], warnings: [] } }],
    ['sources', { sources: [{ id: 'hr:employees:prior-scope', system: 'hr', observedAt: NOW, retrievedAt: NOW,
      freshness: 'fresh', detail: 'Synthetic private fact outside the new responsibility' }] }],
    ['receiptId', { receiptId: 'synthetic-prior-scope-receipt' }],
  ] satisfies Array<[string, AssistantAnchorContent]>;

  it.each(unprovedMetadata)('withholds unproved %s on finalized, replayed, and scope-reduced recovery', async (_kind, metadata) => withHarness(async (harness) => {
    const input = request('turn-persist-source-privacy-0001');
    const admitted = await admitTurn(harness.options, harness.actor.sessionId, input);
    if (admitted.kind !== 'admitted') throw new Error('The privacy fixture was not admitted.');
    const finalized = await finalizeTurn(harness.options, harness.actor.sessionId, input, { ...FINAL_CONTENT, ...metadata });
    expect(finalized).toMatchObject({ kind: 'finalized', recovery: { kind: 'unavailable', reason: 'references_unavailable' } });
    expect(await readCompletedTurn(harness.store, {
      actorId: admitted.record.actorId, sessionId: admitted.record.sessionId, conversationId: admitted.record.conversationId,
      turnId: admitted.record.turnId, mode: admitted.record.mode, modeRevision: admitted.record.modeRevision,
    })).toMatchObject({ kind: 'completed' });
    const beforeRevocation = await recoverRecordedTurn(harness.options, harness.actor.sessionId, input);
    expect(beforeRevocation).toMatchObject({ kind: 'unavailable', reason: 'references_unavailable' });
    expect(beforeRevocation).not.toHaveProperty('assistant');
    expect(beforeRevocation).not.toHaveProperty('actions');
    expect(await admitTurn(harness.options, harness.actor.sessionId, input))
      .toMatchObject({ kind: 'recorded', recovery: { kind: 'unavailable', reason: 'references_unavailable' } });
    await harness.store.workflowTransaction(async tx => {
      const responsibility = await tx.workflowProjectionReader.get<{ id: string; active: boolean; rowVersion: number }>('responsibilities', harness.actor.responsibilityId);
      if (!responsibility) throw new Error('The privacy fixture responsibility disappeared.');
      const updated = await tx.compareAndSwap('responsibilities', responsibility.id,
        { rowVersion: responsibility.rowVersion, state: 'active' },
        { ...responsibility.body, rowVersion: responsibility.rowVersion + 1, active: false });
      expect(updated.updated).toBe(true);
    });
    const reduced = await recoverRecordedTurn(harness.options, harness.actor.sessionId, input);
    expect(reduced).toMatchObject({ kind: 'unavailable', reason: 'references_unavailable' });
    expect(reduced).not.toHaveProperty('assistant');
    expect(JSON.stringify(reduced)).not.toContain('Synthetic private fact');
  }));

  it('does not use an authorized action anchor to expose provisional source prose', async () => withHarness(async (harness) => {
    const input = request('turn-persist-provisional-privacy-0001');
    const admitted = await admitTurn(harness.options, harness.actor.sessionId, input);
    if (admitted.kind !== 'admitted') throw new Error('The provisional privacy fixture was not admitted.');
    const actionId = `turn-persist-privacy-action-${randomUUID().replaceAll('-', '')}`;
    await seedPreparedActionAnchor(harness, admitted.record, actionId);
    await harness.store.workflowTransaction(tx => linkAssistantMessage(guardedAssistantAnchorAdapter(tx), {
      id: admitted.record.actorId, sessionId: admitted.record.sessionId, mode: admitted.record.mode, modeRevision: admitted.record.modeRevision,
    }, { conversationId: admitted.record.conversationId, turnId: admitted.record.turnId }, {
      content: { text: 'Synthetic private fact from a prior scope', sources: [] }, now: new Date(NOW),
    }));
    const recovery = await recoverRecordedTurn(harness.options, harness.actor.sessionId, input);
    expect(recovery).toMatchObject({ kind: 'unavailable', record: { status: 'started' }, reason: 'references_unavailable' });
    expect(recovery).not.toHaveProperty('assistant');
    expect(recovery).not.toHaveProperty('actions');
  }));

  it('persists one exact turn for a request key and replays its assistant anchor without a second dispatch', async () => withHarness(async (harness) => {
    const input = request('turn-persist-request-key-0001');
    let engineCalls = 0;
    const admitted = await admitTurn(harness.options, harness.actor.sessionId, input);
    if (admitted.kind !== 'admitted') throw new Error('The first request did not obtain fresh admission.');
    engineCalls += 1;
    expect(admitted.record).toMatchObject({
      actorId: harness.actor.profileId,
      sessionId: harness.actor.sessionId,
      conversationId: admitted.brokerRequest.conversationId,
      turnId: admitted.userTurn.id,
      status: 'started',
      mode: 'scripted_demo',
      modeRevision: 7,
    });
    expect(await harness.store.get<TurnCompletionRecord>('tool_executions', turnCompletionId(admitted.record)))
      .toMatchObject({
        id: turnCompletionId(admitted.record),
        origin: 'chat',
        requestLedgerId: admitted.record.id,
        status: 'started',
      });
    expect(admitted.brokerRequest).toEqual({
      conversationId: admitted.record.conversationId,
      turnId: admitted.record.turnId,
      expectedMode: 'scripted_demo',
      expectedModeRevision: 7,
    });
    expect(admitted.userTurn).toMatchObject({
      id: admitted.record.turnId,
      actorId: harness.actor.profileId,
      sessionId: harness.actor.sessionId,
      conversationId: admitted.record.conversationId,
      turnId: admitted.record.turnId,
      role: 'user',
      text: input.message,
    });
    const finalized = await finalizeTurn(harness.options, harness.actor.sessionId, input, FINAL_CONTENT);
    expect(finalized).toMatchObject({ kind: 'finalized', recovery: {
      kind: 'recoverable', publicCompleted: true,
      record: { status: 'completed', finalActionIds: [], finalContentDigest: expect.any(String) },
      completion: { status: 'completed', finalActionIds: [], finalContentDigest: expect.any(String) },
    } });
    const completion = await harness.store.get<TurnCompletionRecord>('tool_executions', turnCompletionId(admitted.record));
    expect(completion).toMatchObject({
      status: 'completed',
      requestLedgerId: admitted.record.id,
      assistantMessageId: assistantMessageId(harness.actor.profileId, admitted.record),
      finalActionIds: [],
    });
    const failedAfterCompletion = await failTurn(harness.options, harness.actor.sessionId, input);
    expect(failedAfterCompletion).toMatchObject({
      kind: 'recoverable', publicCompleted: true,
      record: { status: 'completed' }, completion: { status: 'completed' },
    });
    expect(await harness.store.get<WorkflowTurnRecord>('tool_executions', admitted.record.id))
      .toMatchObject({ status: 'completed', finalActionIds: [], finalContentDigest: completion?.finalContentDigest });
    expect(await harness.store.get<TurnCompletionRecord>('tool_executions', turnCompletionId(admitted.record)))
      .toMatchObject({ status: 'completed', finalActionIds: [], finalContentDigest: completion?.finalContentDigest });

    const replay = await admitTurn(harness.options, harness.actor.sessionId, input);
    expect(replay.kind).toBe('recorded');
    if (replay.kind !== 'recorded' || replay.recovery.kind !== 'recoverable') {
      throw new Error('The completed request key did not recover its exact turn.');
    }
    expect(replay.recovery.record).toMatchObject({ id: admitted.record.id, turnId: admitted.record.turnId, status: 'completed' });
    expect(replay.recovery.userTurn.id).toBe(admitted.userTurn.id);
    expect(replay.recovery.assistant.id).toBe(assistantMessageId(harness.actor.profileId, admitted.record));
    expect(replay.recovery.assistant).toMatchObject({
      actorId: harness.actor.profileId,
      sessionId: harness.actor.sessionId,
      conversationId: admitted.record.conversationId,
      turnId: admitted.record.turnId,
      text: FINAL_CONTENT.text,
    });
    expect(replay.recovery.actions.map((action) => action.id)).toEqual([]);
    expect(engineCalls).toBe(1);
  }));

  it('conflicts on changed request content or conversation and rejects a different action contract version', async () => withHarness(async (harness) => {
    const original = request('turn-persist-request-key-0002');
    const admitted = await admitTurn(harness.options, harness.actor.sessionId, original);
    if (admitted.kind !== 'admitted') throw new Error('The original request did not obtain fresh admission.');

    await expect(admitTurn(harness.options, harness.actor.sessionId, request(original.requestKey, {
      message: 'A different message under the same key.',
    }))).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(admitTurn(harness.options, harness.actor.sessionId, request(original.requestKey, {
      conversationId: harness.actor.conversationId,
    }))).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(admitTurn(harness.options, harness.actor.sessionId, request(original.requestKey, {
      actionContractVersion: 1 as unknown as 2,
    }))).rejects.toThrow();

    expect(await harness.store.get('tool_executions', admitted.record.id)).toMatchObject({
      id: admitted.record.id,
      turnId: admitted.record.turnId,
      status: 'started',
    });
  }));

  it('recovers a prepared atomic action anchor by persisted turn identity and redacts it after scope shrink', async () => withHarness(async (harness) => {
    const input = request('turn-persist-request-key-0003');
    let engineCalls = 0;
    const admitAndDispatchOnlyFresh = async () => {
      const result = await admitTurn(harness.options, harness.actor.sessionId, input);
      if (result.kind === 'admitted') engineCalls += 1;
      return result;
    };
    const admitted = await admitAndDispatchOnlyFresh();
    if (admitted.kind !== 'admitted') throw new Error('The request did not obtain fresh admission.');

    const startedReplay = await admitAndDispatchOnlyFresh();
    expect(startedReplay).toMatchObject({ kind: 'recorded', recovery: { kind: 'in_progress', record: { id: admitted.record.id } } });

    const actionId = `turn-persist-action-${randomUUID().replaceAll('-', '')}`;
    await seedPreparedActionAnchor(harness, admitted.record, actionId);
    const actionReplay = await admitAndDispatchOnlyFresh();
    expect(actionReplay.kind).toBe('recorded');
    if (actionReplay.kind !== 'recorded') throw new Error('The prepared request unexpectedly received fresh admission.');
    const recovered = actionReplay.recovery;
    expect(recovered.kind).toBe('recoverable');
    if (recovered.kind !== 'recoverable') throw new Error('The prepared action anchor was not recoverable.');
    expect(recovered.record.id).toBe(admitted.record.id);
    expect(recovered.userTurn.id).toBe(admitted.userTurn.id);
    expect(recovered.assistant.id).toBe(assistantMessageId(harness.actor.profileId, admitted.record));
    expect(recovered.assistant.pendingActionIds).toEqual([actionId]);
    expect(recovered.actions.map((action) => action.id)).toEqual([actionId]);
    expect(recovered.actions[0]).toMatchObject({ turnId: admitted.record.turnId, sessionId: harness.actor.sessionId });
    expect(engineCalls).toBe(1);
    const finalized = await finalizeTurn(harness.options, harness.actor.sessionId, input, FINAL_CONTENT);
    expect(finalized).toMatchObject({ kind: 'finalized', recovery: {
      kind: 'recoverable', publicCompleted: true,
      record: { finalActionIds: [actionId] }, completion: { finalActionIds: [actionId], status: 'completed' },
    } });

    await harness.store.workflowTransaction(async (tx) => {
      const current = await tx.workflowProjectionReader.get<{ id: string; identityId: string; orgUnitId: string; purpose: string; branchIds: string[]; active: boolean; rowVersion: number }>(
        'responsibilities', harness.actor.responsibilityId,
      );
      if (!current) throw new Error('The test responsibility disappeared before scope-shrink verification.');
      const result = await tx.compareAndSwap('responsibilities', current.id,
        { rowVersion: current.rowVersion, state: 'active' },
        { ...current.body, active: false, rowVersion: current.rowVersion + 1 });
      if (!result.updated) throw new Error('The test responsibility changed unexpectedly.');
    });
    expect(await recoverRecordedTurn(harness.options, harness.actor.sessionId, input)).toMatchObject({
      kind: 'unavailable',
      record: { id: admitted.record.id },
      reason: 'references_unavailable',
    });
  }));

  it('reserves the final body before anchoring and rejects changed text or analysis after a completion-write failure', async () => withHarness(async (harness) => {
    let engineCalls = 0;
    const input = request('turn-persist-request-key-0004');
    const admitted = await admitTurn(harness.options, harness.actor.sessionId, input);
    if (admitted.kind !== 'admitted') throw new Error('The request did not obtain fresh admission.');
    engineCalls += 1;
    expect(await recoverRecordedTurn(harness.options, harness.actor.sessionId, input)).toMatchObject({
      kind: 'in_progress', record: { id: admitted.record.id, status: 'started' },
    });
    const startedCompletion = await harness.store.get<TurnCompletionRecord>('tool_executions', turnCompletionId(admitted.record));
    expect(startedCompletion).toMatchObject({ status: 'started' });
    expect(startedCompletion).not.toHaveProperty('finalActionIds');
    expect(startedCompletion).not.toHaveProperty('finalContentDigest');

    const definitelyFailed = interceptTransaction(harness.store, 'fail_before_commit', 2);
    await expect(finalizeTurn(definitelyFailed.options, harness.actor.sessionId, input, FINAL_CONTENT))
      .rejects.toMatchObject({ code: 'STORAGE', definitelyNotCommitted: true });
    expect(definitelyFailed.intercepted()).toBe(true);
    const recordAfterCrash = await harness.store.get('tool_executions', admitted.record.id);
    const completionAfterCrash = await harness.store.get<TurnCompletionRecord>('tool_executions', turnCompletionId(admitted.record));
    expect(recordAfterCrash).toMatchObject({
      status: 'started', finalActionIds: [], finalContentDigest: expect.any(String),
    });
    expect(completionAfterCrash).toMatchObject({
      status: 'started', finalActionIds: [], finalContentDigest: expect.any(String),
    });
    const assistantId = assistantMessageId(harness.actor.profileId, admitted.record);
    const assistantAfterCrash = await harness.store.get('conversation_messages', assistantId);
    expect(assistantAfterCrash).toMatchObject({ id: assistantId, role: 'assistant', text: FINAL_CONTENT.text });
    const anchored = await admitTurn(harness.options, harness.actor.sessionId, input);
    expect(anchored).toMatchObject({ kind: 'recorded', recovery: {
      kind: 'recoverable', publicCompleted: false,
      record: { id: admitted.record.id, status: 'started' },
      completion: { status: 'started' }, assistant: { text: FINAL_CONTENT.text },
    } });
    expect(engineCalls).toBe(1);
    const alternativeAnalysis = {
      facts: [], relationships: [], hypotheses: [], missingEvidence: [],
      generatedAt: NOW, evidenceVersion: 'turn-persistence-alternative-analysis',
    };
    await expect(finalizeTurn(harness.options, harness.actor.sessionId, input, { text: 'Changed final text.' }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(finalizeTurn(harness.options, harness.actor.sessionId, input, { ...FINAL_CONTENT, analysis: alternativeAnalysis }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await harness.store.get('conversation_messages', assistantId)).toEqual(assistantAfterCrash);
    expect(await harness.store.get('tool_executions', admitted.record.id)).toEqual(recordAfterCrash);
    expect(await harness.store.get('tool_executions', turnCompletionId(admitted.record))).toEqual(completionAfterCrash);
    expect((await finalizeTurn(harness.options, harness.actor.sessionId, input, FINAL_CONTENT)).kind).toBe('finalized');
    expect(await recoverRecordedTurn(harness.options, harness.actor.sessionId, input)).toMatchObject({
      kind: 'recoverable', publicCompleted: true,
      record: { status: 'completed', finalActionIds: [] }, completion: { status: 'completed', finalActionIds: [] },
    });

    const lostAckInput = request('turn-persist-request-key-0005');
    const second = await admitTurn(harness.options, harness.actor.sessionId, lostAckInput);
    if (second.kind !== 'admitted') throw new Error('The lost-ack request did not obtain fresh admission.');
    engineCalls += 1;
    const lostAck = interceptTransaction(harness.store, 'lose_commit_ack', 2);
    const readback = await finalizeTurn(lostAck.options, harness.actor.sessionId, lostAckInput, FINAL_CONTENT);
    expect(lostAck.intercepted()).toBe(true);
    expect(readback).toMatchObject({ kind: 'finalized', recovery: {
      kind: 'recoverable', publicCompleted: true,
      record: { status: 'completed', finalActionIds: [] }, completion: { status: 'completed', finalActionIds: [] },
    } });
    expect(readback.recovery.kind === 'recoverable' && readback.recovery.assistant.text).toBe(FINAL_CONTENT.text);
    const lostAckReplay = await admitTurn(harness.options, harness.actor.sessionId, lostAckInput);
    expect(lostAckReplay).toMatchObject({ kind: 'recorded', recovery: {
      kind: 'recoverable', record: { id: second.record.id, turnId: second.record.turnId, status: 'completed' },
      publicCompleted: true,
      completion: { status: 'completed', assistantMessageId: assistantMessageId(harness.actor.profileId, second.record) },
      assistant: { id: assistantMessageId(harness.actor.profileId, second.record), text: FINAL_CONTENT.text },
    } });
    expect(engineCalls).toBe(2);
  }));

  it('fails a started pair atomically, handles a lost failure acknowledgement, and never promotes late anchors', async () => withHarness(async (harness) => {
    const input = request('turn-persist-request-key-0007');
    const admitted = await admitTurn(harness.options, harness.actor.sessionId, input);
    if (admitted.kind !== 'admitted') throw new Error('The request did not obtain fresh admission.');
    const lostFailureAck = interceptTransaction(harness.store, 'lose_commit_ack');
    const failedReadback = await failTurn(lostFailureAck.options, harness.actor.sessionId, input);
    expect(lostFailureAck.intercepted()).toBe(true);
    expect(failedReadback).toMatchObject({ kind: 'unavailable', reason: 'response_not_found', record: { status: 'failed' } });
    expect(await harness.store.get('tool_executions', admitted.record.id)).toMatchObject({ status: 'failed' });
    expect(await harness.store.get<TurnCompletionRecord>('tool_executions', turnCompletionId(admitted.record)))
      .toMatchObject({ status: 'failed', requestLedgerId: admitted.record.id });

    const actionId = `turn-persist-late-action-${randomUUID().replaceAll('-', '')}`;
    await seedPreparedActionAnchor(harness, admitted.record, actionId);
    const lateAnchor = await recoverRecordedTurn(harness.options, harness.actor.sessionId, input);
    expect(lateAnchor).toMatchObject({
      kind: 'recoverable', publicCompleted: false,
      record: { status: 'failed' }, completion: { status: 'failed' },
      assistant: { pendingActionIds: [actionId] },
    });
    await expect(finalizeTurn(harness.options, harness.actor.sessionId, input, FINAL_CONTENT))
      .rejects.toMatchObject({ code: 'TURN_REQUEST_FAILED' });
    const repeatedFailure = await failTurn(harness.options, harness.actor.sessionId, input);
    expect(repeatedFailure).toMatchObject({ kind: 'recoverable', publicCompleted: false, record: { status: 'failed' }, completion: { status: 'failed' } });
    expect(await harness.store.get('tool_executions', admitted.record.id)).toMatchObject({ status: 'failed' });
    expect(await harness.store.get<TurnCompletionRecord>('tool_executions', turnCompletionId(admitted.record)))
      .toMatchObject({ status: 'failed' });
  }));

  it('keeps the public completion gate closed when the marker is missing or malformed', async () => withHarness(async (harness) => {
    const input = request('turn-persist-request-key-0008');
    const admitted = await admitTurn(harness.options, harness.actor.sessionId, input);
    if (admitted.kind !== 'admitted') throw new Error('The request did not obtain fresh admission.');
    await finalizeTurn(harness.options, harness.actor.sessionId, input, FINAL_CONTENT);
    const markerId = turnCompletionId(admitted.record);
    const completion = await harness.store.get<TurnCompletionRecord>('tool_executions', markerId);
    if (!completion) throw new Error('The completed turn marker is missing before tamper checks.');
    const requestLedger = await harness.store.get<WorkflowTurnRecord>('tool_executions', admitted.record.id);
    if (!requestLedger) throw new Error('The completed request ledger is missing before tamper checks.');
    const tuple = {
      actorId: admitted.record.actorId,
      sessionId: admitted.record.sessionId,
      conversationId: admitted.record.conversationId,
      turnId: admitted.record.turnId,
      mode: admitted.record.mode,
      modeRevision: admitted.record.modeRevision,
    };
    expect(await harness.store.workflowTransaction((tx) => readCompletedTurn(tx, tuple))).toMatchObject({ kind: 'completed' });

    await harness.store.transaction((tx) => tx.put('tool_executions', { ...requestLedger, status: 'started' }));
    expect(await harness.store.workflowTransaction((tx) => readCompletedTurn(tx, tuple)))
      .toMatchObject({ kind: 'unavailable', reason: 'request_unverified' });
    expect(await recoverRecordedTurn(harness.options, harness.actor.sessionId, input)).toMatchObject({
      kind: 'unavailable', reason: 'completion_unverified', record: { status: 'started' },
    });
    await harness.store.transaction((tx) => tx.put('tool_executions', requestLedger));

    await harness.store.transaction((tx) => tx.remove('tool_executions', markerId));
    expect(await harness.store.workflowTransaction((tx) => readCompletedTurn(tx, tuple)))
      .toMatchObject({ kind: 'unavailable', reason: 'completion_missing' });
    expect(await recoverRecordedTurn(harness.options, harness.actor.sessionId, input)).toMatchObject({
      kind: 'recoverable', publicCompleted: false, completion: null,
    });

    await harness.store.transaction((tx) => tx.put('tool_executions', { ...completion, unexpected: true }));
    expect(await harness.store.workflowTransaction((tx) => readCompletedTurn(tx, tuple)))
      .toMatchObject({ kind: 'unavailable', reason: 'completion_invalid' });
    expect(await recoverRecordedTurn(harness.options, harness.actor.sessionId, input)).toMatchObject({
      kind: 'unavailable', reason: 'completion_unverified', record: { status: 'completed' },
    });

    await harness.store.transaction((tx) => tx.put('tool_executions', completion));
    const invalidDigest = completion.finalContentDigest === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
    await harness.store.transaction(async (tx) => {
      await tx.put('tool_executions', { ...requestLedger, finalContentDigest: invalidDigest });
      await tx.put('tool_executions', { ...completion, finalContentDigest: invalidDigest });
    });
    expect(await harness.store.workflowTransaction((tx) => readCompletedTurn(tx, tuple)))
      .toMatchObject({ kind: 'unavailable', reason: 'references_unverified' });
    expect(await recoverRecordedTurn(harness.options, harness.actor.sessionId, input)).toMatchObject({
      kind: 'unavailable', reason: 'final_content_unverified', record: { status: 'completed' },
    });

    await harness.store.transaction(async (tx) => {
      await tx.put('tool_executions', requestLedger);
      await tx.put('tool_executions', completion);
    });
    const invalidActionId = `${admitted.record.turnId}-forged-action`;
    await harness.store.transaction(async (tx) => {
      await tx.put('tool_executions', { ...requestLedger, finalActionIds: [invalidActionId] });
      await tx.put('tool_executions', { ...completion, finalActionIds: [invalidActionId] });
    });
    expect(await harness.store.workflowTransaction((tx) => readCompletedTurn(tx, tuple)))
      .toMatchObject({ kind: 'unavailable', reason: 'references_unverified' });
    expect(await recoverRecordedTurn(harness.options, harness.actor.sessionId, input)).toMatchObject({
      kind: 'unavailable', reason: 'final_content_unverified', record: { status: 'completed' },
    });
  }));

  it('pins mode and revision at admission and denies archived, foreign, and expired sessions before recording', async () => withHarness(async (harness) => {
    const input = request('turn-persist-request-key-0006');
    const admitted = await admitTurn(harness.options, harness.actor.sessionId, input);
    if (admitted.kind !== 'admitted') throw new Error('The request did not obtain fresh admission.');
    expect(admitted.record).toMatchObject({ mode: 'scripted_demo', modeRevision: 7 });
    expect(admitted.brokerRequest).toMatchObject({ expectedMode: 'scripted_demo', expectedModeRevision: 7 });

    await harness.store.transaction(async (tx) => {
      const current = await tx.get<{ id: string; profileId: string; mode: 'live_ai' | 'scripted_demo'; modeRevision: number; csrfToken: string; expiresAt: string }>(
        'sessions', harness.actor.sessionId,
      );
      if (!current) throw new Error('The test session disappeared before mode-switch verification.');
      await tx.put('sessions', { ...current, mode: 'live_ai', modeRevision: 8 });
    });
    await expect(finalizeTurn(harness.options, harness.actor.sessionId, input, FINAL_CONTENT))
      .rejects.toMatchObject({ code: 'WORKFLOW_STALE' });
    expect(await harness.store.get('conversation_messages', assistantMessageId(harness.actor.profileId, admitted.record))).toBeUndefined();

    const archivedId = (await harness.store.list<PersistedConversation>('conversations', { actorId: harness.actor.profileId }))
      .find((row) => row.archivedAt === NOW)?.id;
    if (!archivedId) throw new Error('The archived fixture conversation was not seeded.');
    const before = await harness.store.list('tool_executions');
    await expect(admitTurn(harness.options, harness.expiredSessionId, request('turn-persist-expired-key-0001')))
      .rejects.toMatchObject({ code: 'WORKFLOW_AUTHENTICATION_REQUIRED' });
    await expect(admitTurn(harness.options, harness.actor.sessionId, request('turn-persist-archived-key-0001', {
      conversationId: archivedId,
    }))).rejects.toMatchObject({ code: 'ARCHIVED_CONVERSATION' });
    await expect(admitTurn(harness.options, harness.foreign.sessionId, request('turn-persist-foreign-key-0001', {
      conversationId: harness.actor.conversationId,
    }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await harness.store.list('tool_executions')).toHaveLength(before.length);
  }));
});
