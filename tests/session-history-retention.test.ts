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

import type { Profile } from '../lib/contracts';
import { type SessionRow } from '../lib/core/auth';
import { digest } from '../lib/core/utils';
import { changeMode, actorSession, login, logout } from '../lib/server/session';
import { getDemoWorkflowPolicyV1Pin, demoWorkflowPolicyV1 } from '../lib/workflows/policy';
import {
  createWorkflowActionRuntime,
  defineWorkflowBinding,
  workflowApprovalHash,
  workflowSemanticRoot,
  type RuntimeReadContext,
} from '../lib/workflows/action-runtime';
import { createWorkflowActionRunner } from '../lib/workflows/action-runner';
import { getWorkflowActionAuthority } from '../lib/workflows/action-authority';
import { pendingActionV2Schema, type PendingActionV2 } from '../lib/workflows/contracts';
import { createWorkflowSqliteFixture } from './helpers/workflow-storage';

const COOKIE_NAME = 'biztania_session';
const ACCESS_CODE = 'session-history-test-access';
const SECRET = 'session-history-test-signing-secret-which-is-long-enough';
const NOW = '2026-10-04T04:00:00.000Z';
const PROFILE_ID = 'session-history-profile';
const IDENTITY_ID = 'session-history-identity';
const ORG_UNIT_ID = 'session-history-org';
const CONVERSATION_ID = 'session-history-conversation';
const ACTION_ID = 'session-history-v2-action';
const TURN_ID = 'session-history-turn';

function profile(): Profile {
  return {
    id: PROFILE_ID,
    name: 'Session history test profile',
    role: 'hr_admin',
    active: true,
    permissions: ['hr.policy.assign', 'hr.read'],
    regions: [],
  };
}

async function seedProfile(store: Awaited<ReturnType<typeof createWorkflowSqliteFixture>>['store']): Promise<void> {
  await store.transaction((tx) => tx.put('profiles', profile()));
}

function pendingV2Action(sessionId: string, pack: PendingActionV2['packs'][number]): PendingActionV2 {
  const payload = {
    kind: 'policy_acknowledgement_assign' as const,
    policyDocumentId: 'session-history-policy-document',
    policyVersion: 'r1',
    targets: [{
      employeeId: 'session-history-employee',
      ownerIdentityId: IDENTITY_ID,
      reason: 'Review the current policy.',
      dueDate: '2026-10-10',
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
      targetId: 'session-history-target',
      ref: { table: 'employees', id: payload.targets[0].employeeId },
      semanticKey,
      expectedRows: [],
      ownerIdentityId: IDENTITY_ID,
      expectedEffectRef: { table: 'policy_acknowledgement_tasks', id: 'session-history-effect' },
      expectedEffectVersion: 1,
    }],
    targetCount: 1,
    expectedRows: [],
    approvedBranchIds: [],
    approvedOrgUnitIds: [ORG_UNIT_ID],
    reviewedSnapshotId: null,
    policy: getDemoWorkflowPolicyV1Pin(),
    packs: [pack],
    releaseRevision: 'session-history-test-release-r1',
    executionMode: 'atomic_local',
    createdAt: NOW,
    expiresAt: '2026-10-04T04:10:00.000Z',
    status: 'pending',
  });
  action.payloadHash = workflowApprovalHash(action);
  return action;
}

async function seedV2Action(
  store: Awaited<ReturnType<typeof createWorkflowSqliteFixture>>['store'],
  sessionId: string,
  action: PendingActionV2,
): Promise<void> {
  const policyPin = getDemoWorkflowPolicyV1Pin();
  await store.workflowTransaction(async (tx) => {
    await tx.insertUnique('conversations', {
      id: CONVERSATION_ID,
      actorId: PROFILE_ID,
      title: 'Session history test conversation',
      pinned: false,
      archivedAt: null,
      rowVersion: 1,
      createdAt: NOW,
      updatedAt: NOW,
      lastScope: null,
      lastDashboardId: null,
    }, { constraint: 'conversations_primary_key', values: { id: CONVERSATION_ID } });
    await tx.insertUnique('workflow_policies', {
      id: 'session-history-policy-row',
      version: policyPin.version,
      digest: policyPin.digest,
      policy: demoWorkflowPolicyV1,
    }, { constraint: 'workflow_policies_policy_version_unique', values: {
      'policy.id': policyPin.id,
      version: policyPin.version,
    } });
    await tx.insertUnique('pending_actions', action, {
      constraint: 'pending_actions_primary_key', values: { id: ACTION_ID },
    });
  });
  expect(action.sessionId).toBe(sessionId);
}

async function seedWorkflowAuthority(
  store: Awaited<ReturnType<typeof createWorkflowSqliteFixture>>['store'],
): Promise<void> {
  await store.workflowTransaction(async (tx) => {
    await tx.insertUnique('org_units', {
      id: ORG_UNIT_ID,
      name: 'Session history test organization',
      parentOrgUnitId: null,
      active: true,
    }, { constraint: 'org_units_primary_key', values: { id: ORG_UNIT_ID } });
    await tx.insertUnique('directory_identities', {
      id: IDENTITY_ID,
      profileId: PROFILE_ID,
      displayName: 'Session history test identity',
      active: true,
      role: 'hr_admin',
      department: 'hr',
      orgUnitId: ORG_UNIT_ID,
      managerIdentityId: null,
      verifiedDemoEmail: 'session-history@example.invalid',
      slackIdentity: null,
      allowedChannels: ['simulated_email'],
      classificationCeiling: 'internal',
      rowVersion: 1,
    }, { constraint: 'directory_identities_primary_key', values: { id: IDENTITY_ID } });
    await tx.insertUnique('responsibilities', {
      id: 'session-history-responsibility',
      identityId: IDENTITY_ID,
      orgUnitId: ORG_UNIT_ID,
      purpose: 'hr_operations',
      branchIds: [],
      active: true,
      rowVersion: 1,
    }, { constraint: 'responsibilities_open_identity_purpose_unique', values: {
      identityId: IDENTITY_ID,
      purpose: 'hr_operations',
      orgUnitId: ORG_UNIT_ID,
    } });
  });
}

async function insertLegacyPendingAction(
  store: Awaited<ReturnType<typeof createWorkflowSqliteFixture>>['store'],
  sessionId: string,
): Promise<void> {
  await store.transaction((tx) => tx.put('pending_actions', {
    id: 'session-history-v1-action',
    actorId: PROFILE_ID,
    sessionId,
    conversationId: CONVERSATION_ID,
    turnId: 'session-history-v1-turn',
    mode: 'live_ai',
    modeRevision: 0,
    payload: { kind: 'create_dashboard', title: 'Legacy action' },
    payloadHash: 'legacy-hash',
    evidenceVersion: null,
    packs: [],
    createdAt: NOW,
    expiresAt: '2026-10-04T04:10:00.000Z',
    status: 'pending',
    preview: 'Legacy pending action',
  }));
}

async function newSession(store: Awaited<ReturnType<typeof createWorkflowSqliteFixture>>['store']): Promise<SessionRow> {
  await login(store, PROFILE_ID, ACCESS_CODE);
  return (await actorSession(store)).session;
}

beforeEach(() => {
  cookieHarness.value = undefined;
  cookieHarness.setCalls.length = 0;
  cookieHarness.deleteCalls.length = 0;
  vi.stubEnv('DEMO_SESSION_SECRET', SECRET);
  vi.stubEnv('DEMO_ACCESS_CODE', ACCESS_CODE);
  vi.stubEnv('NODE_ENV', 'test');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('session history retention', () => {
  it('expires a valid prior session on login rotation while preserving its V2 action reference', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      await seedProfile(fixture.store);
      const oldSession = await newSession(fixture.store);
      const firstCookie = cookieHarness.value;
      expect(firstCookie).toBeDefined();

      const retainedAction = pendingV2Action(oldSession.id, {
        id: 'session-history-test-pack',
        version: '1.0',
        schemaDigest: 'a'.repeat(64),
        implementationRevision: 'session-history-test-r1',
      });
      await seedV2Action(fixture.store, oldSession.id, retainedAction);

      await login(fixture.store, PROFILE_ID, ACCESS_CODE);

      const retainedSession = await fixture.store.get<SessionRow>('sessions', oldSession.id);
      const fresh = await actorSession(fixture.store);
      const retainedProjection = await fixture.store.workflowProjectionReader.get<PendingActionV2>('pending_actions', ACTION_ID);
      expect(retainedSession).toMatchObject({ id: oldSession.id, profileId: PROFILE_ID });
      expect(Date.parse(retainedSession!.expiresAt)).toBeLessThanOrEqual(Date.now());
      expect(retainedProjection?.body).toMatchObject({ id: ACTION_ID, sessionId: oldSession.id, status: 'pending' });
      expect(fresh.session.id).not.toBe(oldSession.id);
      expect(cookieHarness.value).not.toBe(firstCookie);
      expect(cookieHarness.setCalls.at(-1)).toMatchObject({ name: COOKIE_NAME, value: cookieHarness.value });

      cookieHarness.value = firstCookie;
      await expect(actorSession(fixture.store)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    } finally {
      await fixture.dispose();
    }
  });

  it('ignores an invalid prior signature instead of expiring the session whose ID was guessed', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      await seedProfile(fixture.store);
      const victim: SessionRow = {
        id: 'session-history-victim-session',
        profileId: PROFILE_ID,
        mode: 'live_ai',
        modeRevision: 4,
        csrfToken: 'victim-csrf-token',
        expiresAt: '2099-01-01T00:00:00.000Z',
      };
      await fixture.store.transaction((tx) => tx.put('sessions', victim));
      cookieHarness.value = `${victim.id}.forged-signature`;

      await login(fixture.store, PROFILE_ID, ACCESS_CODE);

      expect(await fixture.store.get<SessionRow>('sessions', victim.id)).toEqual(victim);
      expect((await actorSession(fixture.store)).session.id).not.toBe(victim.id);
      expect(cookieHarness.value).not.toBe(`${victim.id}.forged-signature`);
    } finally {
      await fixture.dispose();
    }
  });

  it('expires and retains a logged-out session row while rejecting its old signed cookie', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      await seedProfile(fixture.store);
      const current = await newSession(fixture.store);
      const oldCookie = cookieHarness.value;

      await logout(fixture.store, current);

      const retained = await fixture.store.get<SessionRow>('sessions', current.id);
      expect(retained).toMatchObject({ id: current.id, profileId: PROFILE_ID });
      expect(Date.parse(retained!.expiresAt)).toBeLessThanOrEqual(Date.now());
      expect(cookieHarness.value).toBeUndefined();
      expect(cookieHarness.deleteCalls).toContain(COOKIE_NAME);

      cookieHarness.value = oldCookie;
      await expect(actorSession(fixture.store)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    } finally {
      await fixture.dispose();
    }
  });

  it('bumps the shared mode revision, stales only V1 rows, and rejects V2 confirmation after switching back', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      await seedProfile(fixture.store);
      const session = await newSession(fixture.store);
      await seedWorkflowAuthority(fixture.store);
      const pack = {
        id: 'session-history-test-pack',
        version: '1.0',
        schemaDigest: 'b'.repeat(64),
        implementationRevision: 'session-history-test-r1',
      };
      const action = pendingV2Action(session.id, pack);
      await seedV2Action(fixture.store, session.id, action);
      await insertLegacyPendingAction(fixture.store, session.id);

      const authority = getWorkflowActionAuthority('policy_acknowledgement_assign');
      const binding = defineWorkflowBinding({
        kind: 'policy_acknowledgement_assign',
        contractVersion: 2,
        packIds: [pack.id],
        executionMode: 'atomic_local',
        authority: { permission: authority.permission, roles: [...authority.roles], purpose: authority.purpose },
        async identify(_context: RuntimeReadContext, payload) {
          return { targets: payload.targets.map((target) => ({
            targetId: 'session-history-target',
            ref: { table: 'employees' as const, id: target.employeeId },
            semanticKey: digest({ kind: payload.kind, employeeId: target.employeeId, ownerIdentityId: target.ownerIdentityId }),
            scope: { orgUnitId: ORG_UNIT_ID },
          })) };
        },
        expectedPostconditions: () => [],
        async validate() { throw new Error('Mode-revision check should deny before validation.'); },
        async executeAtomic() { throw new Error('Mode-revision check should deny before execution.'); },
        async verify() { throw new Error('Mode-revision check should deny before verification.'); },
        async currentStates() { return []; },
      });
      const runtime = createWorkflowActionRuntime({
        store: fixture.store,
        bindings: [binding],
        businessDate: '2026-10-04',
        getReleaseRevision: () => 'session-history-test-release-r1',
        getPackPins: (packIds) => packIds.map((id) => ({
          id,
          version: '1.0',
          schemaDigest: 'b'.repeat(64),
          implementationRevision: 'session-history-test-r1',
        })),
        contextFactory: () => ({
          evidence: async () => { throw new Error('Evidence is not read by this stale confirmation.'); },
          latestDashboard: async () => undefined,
        }),
        now: () => new Date(NOW),
      });
      const runner = createWorkflowActionRunner(runtime);

      await changeMode(fixture.store, session, 'scripted_demo');
      const afterFirstSwitch = await fixture.store.get<SessionRow>('sessions', session.id);
      expect(afterFirstSwitch?.modeRevision).toBe(1);
      expect(await fixture.store.get<{ id: string; status: string }>('pending_actions', 'session-history-v1-action'))
        .toMatchObject({ id: 'session-history-v1-action', status: 'stale' });
      expect((await fixture.store.workflowProjectionReader.get<PendingActionV2>('pending_actions', ACTION_ID))?.body.status)
        .toBe('pending');

      await changeMode(fixture.store, session, 'live_ai');
      const afterSwitchBack = await fixture.store.get<SessionRow>('sessions', session.id);
      expect(afterSwitchBack?.mode).toBe('live_ai');
      expect(afterSwitchBack?.modeRevision).toBe(2);
      const attempt = await runner.confirm(session.id, ACTION_ID, 'session-history-confirm-after-switch-back', {
        conversationId: CONVERSATION_ID,
        turnId: TURN_ID,
      });
      expect(attempt.receipt).toBeNull();
      expect(attempt.error).toMatchObject({ code: 'WORKFLOW_STALE', outcome: 'stale' });
      expect((await fixture.store.workflowProjectionReader.get<PendingActionV2>('pending_actions', ACTION_ID))?.body.status)
        .toBe('pending');
    } finally {
      await fixture.dispose();
    }
  });
});
