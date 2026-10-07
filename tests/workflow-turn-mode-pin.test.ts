import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Mode, Profile } from '../lib/contracts';
import { assistantMessageId } from '../lib/core/conversation-actions';
import { createTrustedWorkflowRuntime } from '../lib/core/workflow-runtime';
import type { SessionRow } from '../lib/core/auth';
import { getWorkflowActionAuthority } from '../lib/workflows/action-authority';
import { demoWorkflowPolicyV1, getDemoWorkflowPolicyV1Pin } from '../lib/workflows/policy';
import {
  preparationResultSchema,
  type PendingActionV2,
  type PersistedConversationMessage,
  type PreparationResult,
  type WorkflowPayloadV2,
} from '../lib/workflows/contracts';
import { createWorkflowSqliteFixture } from './helpers/workflow-storage';

const NOW = '2026-10-04T03:00:00.000Z';
const BUSINESS_DATE = '2026-10-04';
const KIND = 'badge_revoke' as const;
const TOOL_NAME = 'workflow.prepare_badge_revoke';
const AUTHORITY = getWorkflowActionAuthority(KIND);
const RELEASE = 'workflow-turn-mode-pin-test-r1';

type Fixture = Awaited<ReturnType<typeof createWorkflowSqliteFixture>>;
type Store = Fixture['store'];
type Payload = Extract<WorkflowPayloadV2, { kind: typeof KIND }>;

interface Harness {
  fixture: Fixture;
  store: Store;
  trusted: ReturnType<typeof createTrustedWorkflowRuntime>;
  profileId: string;
  sessionId: string;
  badgeId: string;
  employeeId: string;
  conversationId: string;
  payload: Payload;
  session(): Promise<SessionRow>;
  setMode(mode: Mode): Promise<SessionRow>;
  broker(turnId: string): ReturnType<Harness['trusted']['broker']>;
}

async function createHarness(): Promise<Harness> {
  const fixture = await createWorkflowSqliteFixture();
  const store = fixture.store;
  const suffix = randomUUID().replaceAll('-', '');
  const profileId = `mode-pin-profile-${suffix}`;
  const sessionId = `mode-pin-session-${suffix}`;
  const identityId = `mode-pin-identity-${suffix}`;
  const responsibilityId = `mode-pin-responsibility-${suffix}`;
  const orgUnitId = `mode-pin-org-${suffix}`;
  const branchId = `mode-pin-branch-${suffix}`;
  const employeeId = `mode-pin-employee-${suffix}`;
  const badgeId = `mode-pin-badge-${suffix}`;
  const conversationId = `mode-pin-conversation-${suffix}`;
  let generatedId = 0;
  const profile: Profile = {
    id: profileId,
    name: 'Turn mode pin test actor',
    role: 'hr_admin',
    active: true,
    permissions: [AUTHORITY.permission, ...AUTHORITY.readPermissions],
    regions: ['east'],
  };

  try {
    await store.transaction(async (tx) => {
      await tx.put('profiles', profile);
      await tx.put('sessions', {
        id: sessionId,
        profileId,
        mode: 'scripted_demo',
        modeRevision: 0,
        csrfToken: `mode-pin-csrf-${suffix}`,
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
    });

    const policyPin = getDemoWorkflowPolicyV1Pin();
    await store.workflowTransaction(async (tx) => {
      await tx.insertUnique('org_units', {
        id: orgUnitId,
        name: 'Turn mode pin test organization',
        parentOrgUnitId: null,
        active: true,
      }, { constraint: 'org_units_primary_key', values: { id: orgUnitId } });
      await tx.insertUnique('branches', {
        id: branchId,
        rowVersion: 1,
        name: 'Turn mode pin test branch',
        region: 'east',
        orgUnitId,
        active: true,
      }, { constraint: 'branches_primary_key', values: { id: branchId } });
      await tx.insertUnique('directory_identities', {
        id: identityId,
        profileId,
        displayName: 'Turn mode pin test actor',
        active: true,
        role: 'hr_admin',
        department: 'hr',
        orgUnitId,
        managerIdentityId: null,
        verifiedDemoEmail: `mode-pin-${suffix}@example.invalid`,
        slackIdentity: null,
        allowedChannels: ['simulated_email'],
        classificationCeiling: 'internal',
        rowVersion: 1,
      }, { constraint: 'directory_identities_primary_key', values: { id: identityId } });
      await tx.insertUnique('responsibilities', {
        id: responsibilityId,
        identityId,
        orgUnitId,
        purpose: 'hr_operations',
        branchIds: [branchId],
        active: true,
        rowVersion: 1,
      }, {
        constraint: 'responsibilities_open_identity_purpose_unique',
        values: { identityId, purpose: 'hr_operations', orgUnitId },
      });
      await tx.insertUnique('employees', {
        id: employeeId,
        rowVersion: 1,
        name: 'Turn mode pin test employee',
        branchId,
        active: true,
      }, { constraint: 'employees_primary_key', values: { id: employeeId } });
      await tx.insertUnique('mock_badges', {
        id: badgeId,
        rowVersion: 1,
        employeeId,
        state: 'active',
        version: 1,
        updatedAt: NOW,
      }, { constraint: 'mock_badges_primary_key', values: { id: badgeId } });
      await tx.insertUnique('conversations', {
        id: conversationId,
        actorId: profileId,
        title: 'Turn mode pin test conversation',
        pinned: false,
        archivedAt: null,
        rowVersion: 1,
        createdAt: NOW,
        updatedAt: NOW,
        lastScope: null,
        lastDashboardId: null,
      }, { constraint: 'conversations_primary_key', values: { id: conversationId } });
      await tx.insertUnique('workflow_policies', {
        id: `mode-pin-policy-${suffix}`,
        version: policyPin.version,
        digest: policyPin.digest,
        policy: demoWorkflowPolicyV1,
      }, { constraint: 'workflow_policies_primary_key', values: { id: `mode-pin-policy-${suffix}` } });
    });

    const trusted = createTrustedWorkflowRuntime({
      store,
      businessDate: BUSINESS_DATE,
      contextFactory: () => ({ latestDashboard: async () => undefined }),
      getReleaseRevision: () => RELEASE,
      now: () => new Date(NOW),
      makeId: (prefix) => `mode-pin-${prefix}-${suffix}-${++generatedId}`,
    });

    return {
      fixture,
      store,
      trusted,
      profileId,
      sessionId,
      badgeId,
      employeeId,
      conversationId,
      payload: { kind: KIND, badgeId, employeeId, reason: 'Revoke the synthetic test badge.' },
      session: async () => {
        const row = await store.get<SessionRow>('sessions', sessionId);
        if (!row) throw new Error('The synthetic mode-pin session is missing.');
        return row;
      },
      async setMode(mode) {
        let updated: SessionRow | undefined;
        await store.transaction(async (tx) => {
          const current = await tx.get<SessionRow>('sessions', sessionId);
          if (!current) throw new Error('The synthetic mode-pin session is missing.');
          updated = { ...current, mode, modeRevision: current.modeRevision + 1 };
          await tx.put('sessions', updated);
        });
        if (!updated) throw new Error('The synthetic mode-pin session did not update.');
        return updated;
      },
      broker: async (turnId) => {
        const current = await store.get<SessionRow>('sessions', sessionId);
        if (!current) throw new Error('The synthetic mode-pin session is missing.');
        return trusted.broker(sessionId, {
          conversationId,
          turnId,
          expectedMode: current.mode,
          expectedModeRevision: current.modeRevision,
        });
      },
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

function requirePrepared(result: PreparationResult): PendingActionV2 {
  if (!result.pendingAction) throw new Error(`Expected a prepared action, received ${result.outcome}.`);
  return result.pendingAction;
}

async function pendingActions(harness: Harness): Promise<PendingActionV2[]> {
  const rows = await harness.store.workflowProjectionReader.query<PendingActionV2>({
    kind: 'scoped', table: 'pending_actions', equals: { actorId: harness.profileId }, limit: 100,
  });
  return rows.map((row) => row.body);
}

async function audits(harness: Harness): Promise<Array<{ id: string; category: string; actionId?: string }>> {
  const rows = await harness.store.workflowProjectionReader.query<{ id: string; category: string; actionId?: string }>({
    kind: 'scoped', table: 'audit_events', equals: { actorId: harness.profileId }, limit: 100,
  });
  return rows.map((row) => row.body);
}

async function expectNoPreparedReview(harness: Harness, turnId: string, deniedCount: number): Promise<void> {
  expect(await pendingActions(harness)).toEqual([]);
  const events = await audits(harness);
  expect(events.filter((event) => event.category === 'workflow_prepare')).toEqual([]);
  expect(events.filter((event) => event.category === 'workflow_denied')).toHaveLength(deniedCount);
  const messageId = assistantMessageId(harness.profileId, { conversationId: harness.conversationId, turnId });
  expect(await harness.store.get<PersistedConversationMessage>('conversation_messages', messageId)).toBeUndefined();
  const badge = await harness.store.workflowProjectionReader.get<{ id: string; state: string; version: number }>(
    'mock_badges', harness.badgeId,
  );
  expect(badge).toMatchObject({ rowVersion: 1, body: { id: harness.badgeId, state: 'active', version: 1 } });
}

async function expectPreparedAtPinnedMode(
  harness: Harness,
  result: PreparationResult,
  turnId: string,
  mode: Mode,
  modeRevision: number,
): Promise<void> {
  expect(result.outcome).toBe('pending');
  const action = requirePrepared(result);
  expect(action).toMatchObject({
    actorId: harness.profileId,
    sessionId: harness.sessionId,
    conversationId: harness.conversationId,
    turnId,
    mode,
    modeRevision,
  });
  expect((await pendingActions(harness)).map((row) => row.id)).toEqual([action.id]);
  expect((await audits(harness)).filter((event) => event.category === 'workflow_prepare')).toHaveLength(1);
  const messageId = assistantMessageId(harness.profileId, { conversationId: harness.conversationId, turnId });
  const message = await harness.store.get<PersistedConversationMessage>('conversation_messages', messageId);
  expect(message).toMatchObject({
    id: messageId,
    actorId: harness.profileId,
    sessionId: harness.sessionId,
    conversationId: harness.conversationId,
    turnId,
    mode,
    modeRevision,
    role: 'assistant',
    pendingActionId: action.id,
    pendingActionIds: [action.id],
  });
}

describe('trusted workflow turn mode pins', () => {
  it('rejects an old broker pin after a mode switch and after switching back, then accepts a fresh pin', async () => withHarness(async (harness) => {
    const turnId = 'mode-pin-switch-and-back-turn';
    const oldBroker = await harness.broker(turnId);

    await harness.setMode('live_ai');
    const switched = preparationResultSchema.parse(await oldBroker.execute(TOOL_NAME, harness.payload));
    expect(switched).toMatchObject({ outcome: 'stale', pendingAction: null });
    await expectNoPreparedReview(harness, turnId, 1);

    await harness.setMode('scripted_demo');
    expect(await harness.session()).toMatchObject({ mode: 'scripted_demo', modeRevision: 2 });
    const switchedBack = preparationResultSchema.parse(await oldBroker.execute(TOOL_NAME, harness.payload));
    expect(switchedBack).toMatchObject({ outcome: 'stale', pendingAction: null });
    await expectNoPreparedReview(harness, turnId, 2);

    const freshTurnId = 'mode-pin-fresh-turn';
    const freshBroker = await harness.broker(freshTurnId);
    const prepared = preparationResultSchema.parse(await freshBroker.execute(TOOL_NAME, harness.payload));
    await expectPreparedAtPinnedMode(harness, prepared, freshTurnId, 'scripted_demo', 2);
  }));

  it('does not let model tool arguments override the mode pin captured by the broker', async () => withHarness(async (harness) => {
    const turnId = 'mode-pin-model-args-turn';
    const broker = await harness.broker(turnId);
    await harness.setMode('live_ai');

    await expect(broker.execute(TOOL_NAME, {
      ...harness.payload,
      expectedMode: 'live_ai',
      expectedModeRevision: 1,
    })).rejects.toThrow();
    await expectNoPreparedReview(harness, turnId, 0);

    const cleanArgs = preparationResultSchema.parse(await broker.execute(TOOL_NAME, harness.payload));
    expect(cleanArgs).toMatchObject({ outcome: 'stale', pendingAction: null });
    await expectNoPreparedReview(harness, turnId, 1);
  }));

  it('allows the trusted low-level runtime to prepare without a broker pin and persists the current session mode', async () => withHarness(async (harness) => {
    await harness.setMode('live_ai');
    const current = await harness.session();
    const turnId = 'mode-pin-direct-low-level-turn';
    const result = preparationResultSchema.parse(await harness.trusted.runtime.prepare(
      harness.sessionId,
      harness.payload,
      { conversationId: harness.conversationId, turnId },
    ));

    await expectPreparedAtPinnedMode(harness, result, turnId, current.mode, current.modeRevision);
  }));
});
