import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Profile } from '../lib/contracts';
import { digest } from '../lib/core/utils';
import { createHrApprovalWorkflowBindings } from '../lib/packs/hr-approval-workflows';
import { createHrOperationsWorkflowBindings } from '../lib/packs/hr-operations-workflows';
import { createWorkflowSqliteFixture } from './helpers/workflow-storage';
import { createWorkflowActionRunner } from '../lib/workflows/action-runner';
import {
  createWorkflowActionRuntime,
  workflowRowState,
  workflowSnapshotDigest,
  type WorkflowRuntimeOptions,
  type RuntimeReadContext,
} from '../lib/workflows/action-runtime';
import { demoWorkflowPolicyV1, getDemoWorkflowPolicyV1Pin, getTaskDueDate } from '../lib/workflows/policy';
import type {
  ExpectedRow,
  PendingActionV2,
  Ref,
  ReviewSnapshot,
  WorkflowPayloadV2,
  WorkflowStorageTable,
} from '../lib/workflows/contracts';

const NOW = new Date('2026-10-04T03:00:00.000Z'); // 10:00 in Asia/Bangkok
const NOW_ISO = NOW.toISOString();
const BUSINESS_DATE = '2026-10-04';
const ONBOARDING_DOCUMENTS = ['identity_document', 'signed_offer', 'signed_contract'] as const;
const OFFBOARDING_PURPOSES = ['it_disable_request', 'asset_return', 'badge_review'] as const;
type ActorKey = 'hr' | 'manager' | 'director';

interface ActorFixture {
  profileId: string;
  identityId: string;
  responsibilityId: string;
  sessionId: string;
  conversationId: string;
}

interface HrHarness {
  fixture: Awaited<ReturnType<typeof createWorkflowSqliteFixture>>;
  runtime: ReturnType<typeof createWorkflowActionRuntime>;
  runner: ReturnType<typeof createWorkflowActionRunner>;
  actors: Record<ActorKey, ActorFixture>;
  ids: {
    suffix: string;
    orgUnitId: string;
    foreignOrgUnitId: string;
    branchId: string;
    foreignBranchId: string;
    onboardingEmployeeId: string;
    offboardingEmployeeId: string;
    contractEmployeeId: string;
    foreignEmployeeId: string;
    onboardingRequestId: string;
    onboardingLifecycleId: string;
    offboardingCaseId: string;
    offboardingLifecycleId: string;
    assetIds: string[];
    assignmentIds: string[];
    badgeId: string;
    contractId: string;
    policyDocumentId: string;
    onboardingDocumentIds: string[];
  };
  prepareAction(actor: ActorKey, payload: WorkflowPayloadV2): ReturnType<HrHarness['runtime']['prepare']>;
  confirmAction(action: PendingActionV2): ReturnType<HrHarness['runner']['confirm']>;
  dispose(): Promise<void>;
}

async function createHarness(): Promise<HrHarness> {
  const fixture = await createWorkflowSqliteFixture();
  const suffix = randomUUID().replaceAll('-', '');
  const ids = {
    suffix,
    orgUnitId: `hrops-org-${suffix}`,
    foreignOrgUnitId: `hrops-foreign-org-${suffix}`,
    branchId: `hrops-branch-${suffix}`,
    foreignBranchId: `hrops-foreign-branch-${suffix}`,
    onboardingEmployeeId: `hrops-new-employee-${suffix}`,
    offboardingEmployeeId: `hrops-exit-employee-${suffix}`,
    contractEmployeeId: `hrops-contract-employee-${suffix}`,
    foreignEmployeeId: `hrops-foreign-employee-${suffix}`,
    onboardingRequestId: `hrops-onboarding-request-${suffix}`,
    onboardingLifecycleId: `hrops-onboarding-life-${suffix}`,
    offboardingCaseId: `hrops-offboarding-case-${suffix}`,
    offboardingLifecycleId: `hrops-offboarding-life-${suffix}`,
    assetIds: [`hrops-asset-a-${suffix}`, `hrops-asset-b-${suffix}`],
    assignmentIds: [`hrops-assignment-a-${suffix}`, `hrops-assignment-b-${suffix}`],
    badgeId: `hrops-badge-${suffix}`,
    contractId: `hrops-contract-${suffix}`,
    policyDocumentId: `hrops-policy-document-${suffix}`,
    onboardingDocumentIds: ONBOARDING_DOCUMENTS.map((_, index) => `hrops-onboarding-document-${index}-${suffix}`),
  };
  const actors: Record<ActorKey, ActorFixture> = {
    hr: {
      profileId: `hrops-profile-hr-${suffix}`,
      identityId: `hrops-identity-hr-${suffix}`,
      responsibilityId: `hrops-responsibility-hr-${suffix}`,
      sessionId: `hrops-session-hr-${suffix}`,
      conversationId: `hrops-conversation-hr-${suffix}`,
    },
    manager: {
      profileId: `hrops-profile-manager-${suffix}`,
      identityId: `hrops-identity-manager-${suffix}`,
      responsibilityId: `hrops-responsibility-manager-${suffix}`,
      sessionId: `hrops-session-manager-${suffix}`,
      conversationId: `hrops-conversation-manager-${suffix}`,
    },
    director: {
      profileId: `hrops-profile-director-${suffix}`,
      identityId: `hrops-identity-director-${suffix}`,
      responsibilityId: `hrops-responsibility-director-${suffix}`,
      sessionId: `hrops-session-director-${suffix}`,
      conversationId: `hrops-conversation-director-${suffix}`,
    },
  };
  const profiles: Record<ActorKey, Profile> = {
    hr: {
      id: actors.hr.profileId,
      name: 'Synthetic HR Operations Admin',
      role: 'hr_admin',
      active: true,
      permissions: [
        'hr.read', 'hr.onboarding.start', 'hr.onboarding.tasks', 'hr.offboarding.plan',
        'hr.it_disable.request', 'hr.asset_return.create', 'badge.revoke',
        'hr.contract.reminder', 'hr.policy.assign',
      ],
      regions: ['east'],
    },
    manager: {
      id: actors.manager.profileId,
      name: 'Synthetic East Onboarding Manager',
      role: 'east_manager',
      active: true,
      permissions: ['hr.onboarding.manager_read', 'hr.onboarding.manager_approve'],
      regions: ['east'],
    },
    director: {
      id: actors.director.profileId,
      name: 'Synthetic HR Director',
      role: 'hr_admin',
      active: true,
      permissions: ['hr.onboarding.director_read', 'hr.onboarding.director_approve'],
      regions: ['east'],
    },
  };
  const policyPin = getDemoWorkflowPolicyV1Pin();
  let generatedId = 0;
  let generatedTurn = 0;
  let generatedCorrelation = 0;

  try {
    await fixture.store.workflowTransaction(async (tx) => {
      for (const [id, name] of [
        [ids.orgUnitId, 'Synthetic HR Operations Unit'],
        [ids.foreignOrgUnitId, 'Synthetic Unassigned HR Unit'],
      ] as const) {
        await tx.insertUnique('org_units', { id, name, parentOrgUnitId: null, active: true }, {
          constraint: 'org_units_primary_key', values: { id },
        });
      }
    });

    await fixture.store.transaction(async (tx) => {
      for (const profile of Object.values(profiles)) await tx.put('profiles', profile);
      for (const actor of Object.values(actors)) {
        await tx.put('sessions', {
          id: actor.sessionId,
          profileId: actor.profileId,
          mode: 'scripted_demo',
          modeRevision: 0,
          csrfToken: `csrf-${actor.sessionId}`,
          expiresAt: '2099-01-01T00:00:00.000Z',
        });
      }
    });

    await fixture.store.workflowTransaction(async (tx) => {
      for (const [id, orgUnitId] of [
        [ids.branchId, ids.orgUnitId],
        [ids.foreignBranchId, ids.foreignOrgUnitId],
      ] as const) {
        await tx.insertUnique('branches', {
          id, rowVersion: 1, name: id === ids.branchId ? 'Synthetic East HR Branch' : 'Synthetic Foreign HR Branch',
          region: 'east', orgUnitId, active: true,
        }, { constraint: 'branches_primary_key', values: { id } });
      }

      const employees = [
        { id: ids.onboardingEmployeeId, name: 'Synthetic New Hire', branchId: ids.branchId, active: true },
        { id: ids.offboardingEmployeeId, name: 'Synthetic Exiting Employee', branchId: ids.branchId, active: true },
        { id: ids.contractEmployeeId, name: 'Synthetic Contract Employee', branchId: ids.branchId, active: true },
        { id: ids.foreignEmployeeId, name: 'Synthetic Out-of-Scope Employee', branchId: ids.foreignBranchId, active: true },
      ];
      for (const employee of employees) {
        await tx.insertUnique('employees', { ...employee, rowVersion: 1 }, {
          constraint: 'employees_primary_key', values: { id: employee.id },
        });
      }

      const identityRows = [
        {
          id: actors.hr.identityId, profileId: actors.hr.profileId,
          displayName: profiles.hr.name, active: true, role: 'hr_admin', department: 'hr',
          orgUnitId: ids.orgUnitId, managerIdentityId: null, verifiedDemoEmail: `hr-${suffix}@example.invalid`,
          slackIdentity: null, allowedChannels: ['simulated_email'], classificationCeiling: 'internal', rowVersion: 1,
        },
        {
          id: actors.manager.identityId, profileId: actors.manager.profileId,
          displayName: profiles.manager.name, active: true, role: 'east_manager', department: 'hr',
          orgUnitId: ids.orgUnitId, managerIdentityId: actors.director.identityId, verifiedDemoEmail: `manager-${suffix}@example.invalid`,
          slackIdentity: null, allowedChannels: ['simulated_email'], classificationCeiling: 'internal', rowVersion: 1,
        },
        {
          id: actors.director.identityId, profileId: actors.director.profileId,
          displayName: profiles.director.name, active: true, role: 'hr_director', department: 'hr',
          orgUnitId: ids.orgUnitId, managerIdentityId: null, verifiedDemoEmail: `director-${suffix}@example.invalid`,
          slackIdentity: null, allowedChannels: ['simulated_email'], classificationCeiling: 'internal', rowVersion: 1,
        },
      ];
      for (const identity of identityRows) {
        await tx.insertUnique('directory_identities', identity, {
          constraint: 'directory_identities_profile_unique', values: { profileId: identity.profileId },
        });
      }

      const responsibilities = [
        { actor: actors.hr, purpose: 'hr_operations', branchIds: [ids.branchId] },
        { actor: actors.manager, purpose: 'manager_onboarding', branchIds: [ids.branchId] },
        { actor: actors.director, purpose: 'director_onboarding', branchIds: [ids.branchId] },
      ] as const;
      for (const { actor, purpose, branchIds } of responsibilities) {
        await tx.insertUnique('responsibilities', {
          id: actor.responsibilityId, rowVersion: 1, identityId: actor.identityId, orgUnitId: ids.orgUnitId,
          purpose, branchIds: [...branchIds], active: true,
        }, {
          constraint: 'responsibilities_open_identity_purpose_unique',
          values: { identityId: actor.identityId, purpose, orgUnitId: ids.orgUnitId },
        });
      }

      await tx.insertUnique('workflow_policies', {
        id: `hrops-policy-row-${suffix}`, version: policyPin.version, digest: policyPin.digest, policy: demoWorkflowPolicyV1,
      }, { constraint: 'workflow_policies_primary_key', values: { id: `hrops-policy-row-${suffix}` } });

      for (const actor of Object.values(actors)) {
        await tx.insertUnique('conversations', {
          id: actor.conversationId, actorId: actor.profileId, title: 'Synthetic HR workflow test', pinned: false,
          archivedAt: null, rowVersion: 1, createdAt: NOW_ISO, updatedAt: NOW_ISO, lastScope: null, lastDashboardId: null,
        }, { constraint: 'conversations_primary_key', values: { id: actor.conversationId } });
      }

      await tx.insertUnique('policy_documents', {
        id: ids.policyDocumentId, rowVersion: 1, title: 'Synthetic Employee Policy', version: demoWorkflowPolicyV1.policyAcknowledgementVersion,
        text: 'Synthetic policy content for guarded workflow tests.', updatedAt: NOW_ISO,
      }, {
        constraint: 'policy_documents_id_version_unique',
        values: { id: ids.policyDocumentId, version: demoWorkflowPolicyV1.policyAcknowledgementVersion },
      });

      const onboardingRequest = {
        id: ids.onboardingRequestId,
        rowVersion: 1,
        employeeId: ids.onboardingEmployeeId,
        orgUnitId: ids.orgUnitId,
        managerIdentityId: actors.manager.identityId,
        directorIdentityId: actors.director.identityId,
        startDate: '2026-10-15',
        state: 'manager_review_pending',
        lifecycleId: ids.onboardingLifecycleId,
        managerApprovalEventId: null,
        managerApprovedBy: null,
        managerApprovedAt: null,
        directorApprovalEventId: null,
        directorApprovedBy: null,
        directorApprovedAt: null,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      };
      await tx.insertUnique('onboarding_requests', onboardingRequest, {
        constraint: 'onboarding_requests_open_employee_lifecycle_unique',
        values: { employeeId: ids.onboardingEmployeeId, lifecycleId: ids.onboardingLifecycleId },
      });
      for (const [index, documentType] of ONBOARDING_DOCUMENTS.entries()) {
        await tx.insertUnique('onboarding_documents', {
          id: ids.onboardingDocumentIds[index], rowVersion: 1, requestId: ids.onboardingRequestId,
          employeeId: ids.onboardingEmployeeId, documentType, status: 'accepted',
          policyVersion: demoWorkflowPolicyV1.policyAcknowledgementVersion, classification: demoWorkflowPolicyV1.classification,
          contentDigest: digest({ suffix, documentType, requestId: ids.onboardingRequestId }),
          createdAt: NOW_ISO, withdrawnAt: null,
        }, {
          constraint: 'onboarding_documents_request_type_unique',
          values: { requestId: ids.onboardingRequestId, documentType },
        });
      }

      const offboardingReason = 'Synthetic separation review; no external account or physical access changes.';
      await tx.insertUnique('offboarding_cases', {
        id: ids.offboardingCaseId, rowVersion: 1, employeeId: ids.offboardingEmployeeId,
        ownerIdentityId: actors.hr.identityId, status: 'active', lifecycleId: ids.offboardingLifecycleId,
        lastDay: '2026-10-10', reason: offboardingReason, createdAt: NOW_ISO, updatedAt: NOW_ISO,
      }, {
        constraint: 'offboarding_cases_open_employee_unique', values: { employeeId: ids.offboardingEmployeeId },
      });

      for (const [index, assetId] of ids.assetIds.entries()) {
        const assetTag = `HR-DEMO-${suffix}-${index}`;
        await tx.insertUnique('assets', {
          id: assetId, rowVersion: 1, assetTag, status: 'assigned', kind: 'laptop', model: 'Synthetic Test Laptop', createdAt: NOW_ISO,
        }, { constraint: 'assets_tag_unique', values: { assetTag } });
        await tx.insertUnique('asset_assignments', {
          id: ids.assignmentIds[index], rowVersion: 1, assetId, employeeId: ids.offboardingEmployeeId,
          status: 'assigned', assignedAt: NOW_ISO, createdAt: NOW_ISO,
        }, { constraint: 'asset_assignments_open_asset_unique', values: { assetId } });
      }

      await tx.insertUnique('employment_contracts', {
        id: ids.contractId, rowVersion: 1, employeeId: ids.contractEmployeeId, status: 'active',
        startDate: '2025-10-04', endDate: '2026-10-25', contractType: 'synthetic_demo_employment',
        policyVersion: demoWorkflowPolicyV1.policyAcknowledgementVersion, createdAt: NOW_ISO,
      }, {
        constraint: 'employment_contracts_open_employee_unique', values: { employeeId: ids.contractEmployeeId },
      });

      await tx.insertUnique('mock_badges', {
        id: ids.badgeId, rowVersion: 1, employeeId: ids.offboardingEmployeeId, state: 'active', version: 1, updatedAt: NOW_ISO,
      }, { constraint: 'mock_badges_primary_key', values: { id: ids.badgeId } });
    });

    const runtimeOptions: WorkflowRuntimeOptions = {
      store: fixture.store,
      bindings: [...createHrApprovalWorkflowBindings(), ...createHrOperationsWorkflowBindings()],
      businessDate: BUSINESS_DATE,
      now: () => new Date(NOW),
      makeId: (prefix) => `${prefix}-${suffix}-${++generatedId}`,
      getReleaseRevision: () => 'hr-operations-bindings-test-release-r1',
      getPackPins: (packIds) => packIds.map((id) => ({
        id, version: '1.0.0', schemaDigest: 'a'.repeat(64), implementationRevision: 'hr-operations-bindings-test-base-r1',
      })),
      contextFactory: () => ({
        evidence: async () => { throw new Error('HR Operations bindings must not load Sales/Operations evidence'); },
        latestDashboard: async () => undefined,
      }),
    };
    const runtime = createWorkflowActionRuntime(runtimeOptions);
    const runner = createWorkflowActionRunner(runtime);
    const harness: HrHarness = {
      fixture,
      runtime,
      runner,
      actors,
      ids,
      async prepareAction(actor, payload) {
        const principal = actors[actor];
        return runtime.prepare(principal.sessionId, payload, {
          conversationId: principal.conversationId,
          turnId: `hrops-turn-${suffix}-${++generatedTurn}`,
        });
      },
      async confirmAction(action) {
        return runner.confirm(action.sessionId, action.id, `hrops-correlation-${suffix}-${++generatedCorrelation}`, {
          conversationId: action.conversationId,
          turnId: action.turnId,
        });
      },
      async dispose() { await fixture.dispose(); },
    };
    return harness;
  } catch (error) {
    await fixture.dispose();
    throw error;
  }
}

async function currentExpectedRow(harness: HrHarness, ref: Ref): Promise<ExpectedRow> {
  const row = await harness.fixture.store.workflowProjectionReader.get<Record<string, unknown>>(ref.table, ref.id);
  if (!row) throw new Error(`Missing fixture row ${ref.table}:${ref.id}`);
  return { ref, rowVersion: row.rowVersion, state: workflowRowState(ref.table, row.body) };
}

async function makeReviewSnapshot(
  harness: HrHarness,
  actorKey: 'manager' | 'director',
  purpose: 'manager_queue' | 'director_queue',
): Promise<ReviewSnapshot> {
  const requestRow = await harness.fixture.store.workflowProjectionReader.get<Record<string, unknown>>(
    'onboarding_requests', harness.ids.onboardingRequestId,
  );
  if (!requestRow) throw new Error('The onboarding request is unavailable for a reviewed snapshot');
  const refs: Ref[] = [
    { table: 'onboarding_requests', id: harness.ids.onboardingRequestId },
    { table: 'employees', id: harness.ids.onboardingEmployeeId },
    { table: 'branches', id: harness.ids.branchId },
    ...harness.ids.onboardingDocumentIds.map((id) => ({ table: 'onboarding_documents' as const, id })),
  ];

  if (purpose === 'director_queue') {
    const managerEventId = requestRow.body.managerApprovalEventId;
    if (typeof managerEventId !== 'string') throw new Error('The manager approval event is not available');
    const eventRow = await harness.fixture.store.workflowProjectionReader.get<Record<string, unknown>>('onboarding_approval_events', managerEventId);
    if (!eventRow || typeof eventRow.body.executionId !== 'string') throw new Error('The manager approval proof is incomplete');
    refs.push(
      { table: 'onboarding_approval_events', id: managerEventId },
      { table: 'directory_identities', id: harness.actors.manager.identityId },
      { table: 'responsibilities', id: harness.actors.manager.responsibilityId },
      { table: 'action_executions', id: eventRow.body.executionId },
    );
  }

  const uniqueRefs = [...new Map(refs.map((ref) => [digest(ref), ref] as const)).values()];
  const expectedRows = await Promise.all(uniqueRefs.map((ref) => currentExpectedRow(harness, ref)));
  const actor = harness.actors[actorKey];
  const base: ReviewSnapshot = {
    id: `hrops-snapshot-${purpose}-${harness.ids.suffix}-${actorKey}`,
    actorId: actor.profileId,
    actorSessionId: actor.sessionId,
    purpose,
    orgUnitIds: [harness.ids.orgUnitId],
    displayedIds: [harness.ids.onboardingRequestId],
    count: 1,
    expectedRows,
    policy: getDemoWorkflowPolicyV1Pin(),
    createdAt: NOW_ISO,
    expiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
    digest: '0'.repeat(64),
  };
  const snapshot = { ...base, digest: workflowSnapshotDigest(base) };
  await harness.fixture.store.workflowTransaction(async (tx) => {
    await tx.insertUnique('review_snapshots', snapshot, {
      constraint: 'review_snapshots_primary_key', values: { id: snapshot.id },
    });
    for (const [index, expected] of expectedRows.entries()) {
      const row = {
        id: `hrops-snapshot-target-${harness.ids.suffix}-${actorKey}-${index}`,
        snapshotId: snapshot.id,
        entityType: expected.ref.table,
        targetId: expected.ref.id,
        ref: expected.ref,
        expectedRowVersion: expected.rowVersion,
        expectedState: expected.state,
      };
      await tx.insertUnique('review_snapshot_targets', row, {
        constraint: 'review_snapshot_targets_snapshot_target_unique',
        values: { snapshotId: snapshot.id, entityType: expected.ref.table, targetId: expected.ref.id },
      });
    }
  });
  return snapshot;
}

async function approveAndStartOnboarding(harness: HrHarness): Promise<PendingActionV2> {
  const managerSnapshot = await makeReviewSnapshot(harness, 'manager', 'manager_queue');
  const managerPrepared = await harness.prepareAction('manager', {
    kind: 'onboarding_manager_approve', snapshotId: managerSnapshot.id, requestIds: [harness.ids.onboardingRequestId],
  });
  expect(managerPrepared.outcome).toBe('pending');
  const managerAction = managerPrepared.pendingAction!;
  const managerConfirmed = await harness.confirmAction(managerAction);
  expect(managerConfirmed.error).toBeNull();
  expect(managerConfirmed.receipt?.outcome).toBe('verified_success');

  const directorSnapshot = await makeReviewSnapshot(harness, 'director', 'director_queue');
  const directorPrepared = await harness.prepareAction('director', {
    kind: 'onboarding_director_approve', snapshotId: directorSnapshot.id, requestIds: [harness.ids.onboardingRequestId],
  });
  expect(directorPrepared.outcome).toBe('pending');
  const directorConfirmed = await harness.confirmAction(directorPrepared.pendingAction!);
  expect(directorConfirmed.error).toBeNull();
  expect(directorConfirmed.receipt?.outcome).toBe('verified_success');

  const startPrepared = await harness.prepareAction('hr', {
    kind: 'onboarding_start', requestId: harness.ids.onboardingRequestId,
  });
  expect(startPrepared.outcome).toBe('pending');
  const startAction = startPrepared.pendingAction!;
  expect(startAction.expectedRows.filter((row) => row.ref.table === 'onboarding_documents').map((row) => row.ref.id).sort())
    .toEqual([...harness.ids.onboardingDocumentIds].sort());
  const startConfirmed = await harness.confirmAction(startAction);
  expect(startConfirmed.error).toBeNull();
  expect(startConfirmed.receipt?.outcome).toBe('verified_success');
  return startAction;
}

async function read<T>(harness: HrHarness, table: WorkflowStorageTable, id: string) {
  return harness.fixture.store.workflowProjectionReader.get<T>(table, id);
}

async function withoutHarness(run: (harness: HrHarness) => Promise<void>): Promise<void> {
  const harness = await createHarness();
  try {
    await run(harness);
  } finally {
    await harness.dispose();
  }
}

describe('HR Operations workflow bindings', () => {
  it('creates template-deduped onboarding tasks after the guarded flow verifies current documents', async () => {
    await withoutHarness(async (harness) => {
      const startAction = await approveAndStartOnboarding(harness);
      expect(startAction.expectedRows.filter((row) => row.ref.table === 'onboarding_documents')).toHaveLength(3);
      for (const documentId of harness.ids.onboardingDocumentIds) {
        const document = await read<{ status: string; policyVersion: string; withdrawnAt: string | null }>(harness, 'onboarding_documents', documentId);
        expect(document?.body).toMatchObject({
          status: 'accepted', policyVersion: demoWorkflowPolicyV1.policyAcknowledgementVersion, withdrawnAt: null,
        });
      }

      const taskPayload: WorkflowPayloadV2 = {
        kind: 'onboarding_tasks_create',
        requestId: harness.ids.onboardingRequestId,
        targets: [
          {
            templateId: 'hr_welcome', ownerIdentityId: harness.actors.hr.identityId,
            reason: 'Prepare the synthetic new hire first day.', dueDate: getTaskDueDate(NOW, 'normal'), priority: 'normal',
          },
          {
            templateId: 'policy_acknowledgement', ownerIdentityId: harness.actors.hr.identityId,
            reason: 'Assign the current onboarding policy acknowledgement.', dueDate: getTaskDueDate(NOW, 'high'), priority: 'high',
          },
        ],
      };
      const prepared = await harness.prepareAction('hr', taskPayload);
      expect(prepared.outcome).toBe('pending');
      const action = prepared.pendingAction!;
      expect(action.approvedOrgUnitIds).toEqual([harness.ids.orgUnitId]);
      expect(action.targets).toHaveLength(2);
      for (const target of action.targets) {
        expect(await read(harness, 'onboarding_tasks', target.expectedEffectRef.id)).toBeUndefined();
      }

      const confirmed = await harness.confirmAction(action);
      expect(confirmed.error).toBeNull();
      expect(confirmed.receipt?.outcome).toBe('verified_success');
      const tasks = await Promise.all(action.targets.map((target) => read<Record<string, unknown>>(
        harness, 'onboarding_tasks', target.expectedEffectRef.id,
      )));
      expect(tasks.every((task) => task !== undefined)).toBe(true);
      expect(tasks.map((task) => task?.body.templateId).sort()).toEqual(['hr_welcome', 'policy_acknowledgement']);
      for (const task of tasks) {
        expect(task?.body).toMatchObject({
          requestId: harness.ids.onboardingRequestId,
          employeeId: harness.ids.onboardingEmployeeId,
          ownerIdentityId: harness.actors.hr.identityId,
          status: 'open',
          executionId: confirmed.receipt?.id,
          createdAt: NOW_ISO,
        });
      }
      expect(tasks.find((task) => task?.body.templateId === 'hr_welcome')?.body).toMatchObject({
        reason: 'Prepare the synthetic new hire first day.', dueDate: getTaskDueDate(NOW, 'normal'), priority: 'normal',
      });
      expect(tasks.find((task) => task?.body.templateId === 'policy_acknowledgement')?.body).toMatchObject({
        reason: 'Assign the current onboarding policy acknowledgement.', dueDate: getTaskDueDate(NOW, 'high'), priority: 'high',
      });

      const duplicate = await harness.prepareAction('hr', taskPayload);
      expect(duplicate.outcome).toBe('already_completed');
      expect(duplicate.pendingAction).toBeNull();
      for (const templateId of ['hr_welcome', 'policy_acknowledgement']) {
        const rows = await harness.fixture.store.workflowProjectionReader.query({
          kind: 'unique', table: 'onboarding_tasks', constraint: 'onboarding_tasks_request_template_unique',
          values: { requestId: harness.ids.onboardingRequestId, templateId },
        });
        expect(rows).toHaveLength(1);
      }
    });
  });

  it('freezes offboarding sources and creates only simulated IT and assignment-linked return requests', async () => {
    await withoutHarness(async (harness) => {
      const offboardingCase = await read<{ employeeId: string; reason: string; lastDay: string }>(
        harness, 'offboarding_cases', harness.ids.offboardingCaseId,
      );
      const employee = await read<{ id: string; name: string; branchId: string; active: boolean }>(
        harness, 'employees', harness.ids.offboardingEmployeeId,
      );
      const planPrepared = await harness.prepareAction('hr', {
        kind: 'offboarding_plan_create', caseId: harness.ids.offboardingCaseId,
      });
      expect(planPrepared.outcome).toBe('pending');
      const planAction = planPrepared.pendingAction!;
      const planRef = planAction.targets[0].expectedEffectRef;
      expect(await read(harness, 'offboarding_plans', planRef.id)).toBeUndefined();
      for (const purpose of OFFBOARDING_PURPOSES) {
        expect(await harness.fixture.store.workflowProjectionReader.query({
          kind: 'unique', table: 'planned_actions', constraint: 'planned_actions_plan_purpose_unique',
          values: { planId: planRef.id, purpose },
        })).toHaveLength(0);
      }

      const planConfirmed = await harness.confirmAction(planAction);
      expect(planConfirmed.error).toBeNull();
      expect(planConfirmed.receipt?.outcome).toBe('verified_success');
      const plan = await read<Record<string, unknown>>(harness, 'offboarding_plans', planRef.id);
      expect(plan?.body).toMatchObject({
        caseId: harness.ids.offboardingCaseId, purpose: 'offboarding', status: 'prepared', executionId: planConfirmed.receipt?.id,
        employeeSnapshot: {
          id: harness.ids.offboardingEmployeeId, name: employee?.body.name,
          branchId: employee?.body.branchId, active: true, rowVersion: employee?.rowVersion,
        },
        assetAssignmentIds: [...harness.ids.assignmentIds].sort(),
      });
      for (const purpose of OFFBOARDING_PURPOSES) {
        const planned = await harness.fixture.store.workflowProjectionReader.query<Record<string, unknown>>({
          kind: 'unique', table: 'planned_actions', constraint: 'planned_actions_plan_purpose_unique',
          values: { planId: planRef.id, purpose },
        });
        expect(planned).toHaveLength(1);
        expect(planned[0].body).toMatchObject({ status: 'planned', description: expect.any(String), executionId: planConfirmed.receipt?.id });
      }

      const itDisablePayload: WorkflowPayloadV2 = {
        kind: 'it_disable_request',
        caseId: harness.ids.offboardingCaseId,
        planId: planRef.id,
        effectiveDate: offboardingCase!.body.lastDay,
        reason: offboardingCase!.body.reason,
      };
      const itPrepared = await harness.prepareAction('hr', itDisablePayload);
      expect(itPrepared.outcome).toBe('pending');
      const itAction = itPrepared.pendingAction!;
      const itEffectRef = itAction.targets[0].expectedEffectRef;
      expect(await read(harness, 'it_disable_requests', itEffectRef.id)).toBeUndefined();
      const itConfirmed = await harness.confirmAction(itAction);
      expect(itConfirmed.error).toBeNull();
      expect(itConfirmed.receipt?.outcome).toBe('verified_success');
      const itRequest = await read<Record<string, unknown>>(harness, 'it_disable_requests', itEffectRef.id);
      expect(itRequest?.body).toMatchObject({
        caseId: harness.ids.offboardingCaseId,
        planId: planRef.id,
        employeeId: harness.ids.offboardingEmployeeId,
        status: 'requested',
        effectiveDate: offboardingCase!.body.lastDay,
        reason: offboardingCase!.body.reason,
        executionId: itConfirmed.receipt?.id,
      });
      const duplicateItRequest = await harness.prepareAction('hr', itDisablePayload);
      expect(duplicateItRequest.outcome).toBe('already_completed');
      expect(duplicateItRequest.pendingAction).toBeNull();
      const persistedItRequests = await harness.fixture.store.workflowProjectionReader.query<Record<string, unknown>>({
        kind: 'unique', table: 'it_disable_requests', constraint: 'it_disable_requests_case_plan_unique',
        values: { caseId: harness.ids.offboardingCaseId, planId: planRef.id },
      });
      expect(persistedItRequests).toHaveLength(1);
      expect(persistedItRequests[0].body).toMatchObject({
        status: 'requested', executionId: itConfirmed.receipt?.id,
      });
      expect((await read<{ active: boolean }>(harness, 'employees', harness.ids.offboardingEmployeeId))?.body.active).toBe(true);

      const returnPayload = {
        kind: 'asset_return_create',
        caseId: harness.ids.offboardingCaseId,
        planId: planRef.id,
        targets: harness.ids.assignmentIds.map((assetAssignmentId, index) => ({
          assetAssignmentId,
          ownerIdentityId: harness.actors.hr.identityId,
          reason: offboardingCase!.body.reason,
          dueDate: getTaskDueDate(NOW, index === 0 ? 'high' : 'normal'),
          priority: index === 0 ? 'high' : 'normal',
        })),
      } satisfies WorkflowPayloadV2;
      const returnPrepared = await harness.prepareAction('hr', returnPayload);
      expect(returnPrepared.outcome).toBe('pending');
      const returnAction = returnPrepared.pendingAction!;
      for (const target of returnAction.targets) {
        expect(await read(harness, 'asset_return_tasks', target.expectedEffectRef.id)).toBeUndefined();
      }
      const returnConfirmed = await harness.confirmAction(returnAction);
      expect(returnConfirmed.error).toBeNull();
      expect(returnConfirmed.receipt?.outcome).toBe('verified_success');
      for (const target of returnAction.targets) {
        const task = await read<Record<string, unknown>>(harness, 'asset_return_tasks', target.expectedEffectRef.id);
        const input = returnPayload.targets.find((candidate) => candidate.assetAssignmentId === task?.body.assignmentId);
        expect(task?.body).toMatchObject({
          assignmentId: input?.assetAssignmentId,
          caseId: harness.ids.offboardingCaseId,
          planId: planRef.id,
          ownerIdentityId: harness.actors.hr.identityId,
          status: 'open',
          dueDate: input?.dueDate,
          priority: input?.priority,
          reason: offboardingCase!.body.reason,
          executionId: returnConfirmed.receipt?.id,
        });
      }
      for (const assignmentId of harness.ids.assignmentIds) {
        expect((await read<{ status: string }>(harness, 'asset_assignments', assignmentId))?.body.status).toBe('assigned');
      }
    });
  });

  it('rejects an IT request after the assignment set diverges from its frozen offboarding plan', async () => {
    await withoutHarness(async (harness) => {
      const planPrepared = await harness.prepareAction('hr', {
        kind: 'offboarding_plan_create', caseId: harness.ids.offboardingCaseId,
      });
      const planAction = planPrepared.pendingAction!;
      const planId = planAction.targets[0].expectedEffectRef.id;
      const confirmed = await harness.confirmAction(planAction);
      expect(confirmed.receipt?.outcome).toBe('verified_success');

      const assignment = await read<{ status: 'assigned' | 'returned'; rowVersion?: number }>(
        harness, 'asset_assignments', harness.ids.assignmentIds[1],
      );
      expect(assignment?.body.status).toBe('assigned');
      await harness.fixture.store.workflowTransaction(async (tx) => {
        const changed = await tx.compareAndSwap('asset_assignments', harness.ids.assignmentIds[1],
          { rowVersion: assignment!.rowVersion, state: 'assigned' },
          { ...assignment!.body, id: harness.ids.assignmentIds[1], rowVersion: assignment!.rowVersion + 1, status: 'returned' });
        expect(changed.updated).toBe(true);
      });

      const offboardingCase = await read<{ reason: string; lastDay: string }>(harness, 'offboarding_cases', harness.ids.offboardingCaseId);
      const stale = await harness.prepareAction('hr', {
        kind: 'it_disable_request', caseId: harness.ids.offboardingCaseId, planId,
        effectiveDate: offboardingCase!.body.lastDay, reason: offboardingCase!.body.reason,
      });
      expect(stale.outcome).toBe('stale');
      expect(stale.pendingAction).toBeNull();
      expect(await harness.fixture.store.workflowProjectionReader.query({
        kind: 'unique', table: 'it_disable_requests', constraint: 'it_disable_requests_case_plan_unique',
        values: { caseId: harness.ids.offboardingCaseId, planId },
      })).toHaveLength(0);
    });
  });

  it('pins exact contract expiry and current policy version while denying another organization scope', async () => {
    await withoutHarness(async (harness) => {
      const contract = await read<{ endDate: string; status: string }>(harness, 'employment_contracts', harness.ids.contractId);
      const reminderPayload: WorkflowPayloadV2 = {
        kind: 'contract_reminder_create',
        targets: [{
          contractId: harness.ids.contractId,
          ownerIdentityId: harness.actors.hr.identityId,
          reason: 'Review the exact synthetic contract expiry.',
          dueDate: getTaskDueDate(NOW, 'normal'),
          priority: 'normal',
        }],
      };
      const reminderPrepared = await harness.prepareAction('hr', reminderPayload);
      expect(reminderPrepared.outcome).toBe('pending');
      const reminderAction = reminderPrepared.pendingAction!;
      expect(reminderAction.approvedOrgUnitIds).toEqual([harness.ids.orgUnitId]);
      expect(reminderAction.targets[0].ref).toEqual({ table: 'employment_contracts', id: harness.ids.contractId });
      expect(reminderAction.targets[0].targetId).toContain(contract!.body.endDate);
      expect(await read(harness, 'contract_reminders', reminderAction.targets[0].expectedEffectRef.id)).toBeUndefined();
      const reminderConfirmed = await harness.confirmAction(reminderAction);
      expect(reminderConfirmed.error).toBeNull();
      expect(reminderConfirmed.receipt?.outcome).toBe('verified_success');
      const reminder = await read<Record<string, unknown>>(harness, 'contract_reminders', reminderAction.targets[0].expectedEffectRef.id);
      expect(reminder?.body).toMatchObject({
        contractId: harness.ids.contractId,
        expiresAt: contract?.body.endDate,
        milestone: 'contract_expiry',
        status: 'pending',
        ownerIdentityId: harness.actors.hr.identityId,
        reason: 'Review the exact synthetic contract expiry.',
        dueDate: getTaskDueDate(NOW, 'normal'),
        priority: 'normal',
        executionId: reminderConfirmed.receipt?.id,
      });
      const duplicateReminder = await harness.prepareAction('hr', reminderPayload);
      expect(duplicateReminder.outcome).toBe('already_completed');
      expect(await harness.fixture.store.workflowProjectionReader.query({
        kind: 'unique', table: 'contract_reminders', constraint: 'contract_reminders_contract_milestone_unique',
        values: { contractId: harness.ids.contractId, expiresAt: contract!.body.endDate, milestone: 'contract_expiry' },
      })).toHaveLength(1);

      const acknowledgementPayload = {
        kind: 'policy_acknowledgement_assign',
        policyDocumentId: harness.ids.policyDocumentId,
        policyVersion: demoWorkflowPolicyV1.policyAcknowledgementVersion,
        targets: [{
          employeeId: harness.ids.contractEmployeeId,
          ownerIdentityId: harness.actors.hr.identityId,
          reason: 'Assign the current synthetic policy for acknowledgement.',
          dueDate: getTaskDueDate(NOW, 'high'),
          priority: 'high',
        }],
      } satisfies WorkflowPayloadV2;
      const acknowledgementPrepared = await harness.prepareAction('hr', acknowledgementPayload);
      expect(acknowledgementPrepared.outcome).toBe('pending');
      const acknowledgementAction = acknowledgementPrepared.pendingAction!;
      expect(acknowledgementAction.approvedOrgUnitIds).toEqual([harness.ids.orgUnitId]);
      expect(await read(harness, 'policy_acknowledgement_tasks', acknowledgementAction.targets[0].expectedEffectRef.id)).toBeUndefined();
      const acknowledgementConfirmed = await harness.confirmAction(acknowledgementAction);
      expect(acknowledgementConfirmed.error).toBeNull();
      expect(acknowledgementConfirmed.receipt?.outcome).toBe('verified_success');
      const acknowledgement = await read<Record<string, unknown>>(
        harness, 'policy_acknowledgement_tasks', acknowledgementAction.targets[0].expectedEffectRef.id,
      );
      expect(acknowledgement?.body).toMatchObject({
        employeeId: harness.ids.contractEmployeeId,
        policyDocumentId: harness.ids.policyDocumentId,
        policyVersion: demoWorkflowPolicyV1.policyAcknowledgementVersion,
        status: 'pending',
        ownerIdentityId: harness.actors.hr.identityId,
        reason: 'Assign the current synthetic policy for acknowledgement.',
        dueDate: getTaskDueDate(NOW, 'high'),
        priority: 'high',
        executionId: acknowledgementConfirmed.receipt?.id,
      });

      const foreign = await harness.prepareAction('hr', {
        ...acknowledgementPayload,
        targets: [{ ...acknowledgementPayload.targets[0], employeeId: harness.ids.foreignEmployeeId }],
      });
      expect(foreign.outcome).toBe('denied');
      expect(foreign.pendingAction).toBeNull();
      expect(await harness.fixture.store.workflowProjectionReader.query({
        kind: 'unique', table: 'policy_acknowledgement_tasks', constraint: 'policy_ack_employee_version_unique',
        values: {
          employeeId: harness.ids.foreignEmployeeId,
          policyDocumentId: harness.ids.policyDocumentId,
          policyVersion: demoWorkflowPolicyV1.policyAcknowledgementVersion,
        },
      })).toHaveLength(0);
    });
  });

  it('rejects an HR task date outside the Bangkok priority policy without creating a pending action or effect', async () => {
    await withoutHarness(async (harness) => {
      const payload: WorkflowPayloadV2 = {
        kind: 'policy_acknowledgement_assign',
        policyDocumentId: harness.ids.policyDocumentId,
        policyVersion: demoWorkflowPolicyV1.policyAcknowledgementVersion,
        targets: [{
          employeeId: harness.ids.contractEmployeeId,
          ownerIdentityId: harness.actors.hr.identityId,
          reason: 'Reject an off-policy test date before review.',
          dueDate: '2026-10-06',
          priority: 'normal',
        }],
      };
      await expect(harness.prepareAction('hr', payload)).rejects.toMatchObject({ code: 'WORKFLOW_INVALID_INPUT' });
      expect(await harness.fixture.store.workflowProjectionReader.query({
        kind: 'scoped', table: 'pending_actions', equals: { actorId: harness.actors.hr.profileId }, limit: 25,
      })).toHaveLength(0);
      expect(await harness.fixture.store.workflowProjectionReader.query({
        kind: 'unique', table: 'policy_acknowledgement_tasks', constraint: 'policy_ack_employee_version_unique',
        values: {
          employeeId: harness.ids.contractEmployeeId,
          policyDocumentId: harness.ids.policyDocumentId,
          policyVersion: demoWorkflowPolicyV1.policyAcknowledgementVersion,
        },
      })).toHaveLength(0);
    });
  });

  it('revokes a matching badge once, increments its version, and returns the same receipt on duplicate confirmation', async () => {
    await withoutHarness(async (harness) => {
      const payload: WorkflowPayloadV2 = {
        kind: 'badge_revoke', badgeId: harness.ids.badgeId,
        employeeId: harness.ids.offboardingEmployeeId,
        reason: 'Synthetic test revocation after approved separation review.',
      };
      const prepared = await harness.prepareAction('hr', payload);
      expect(prepared.outcome).toBe('pending');
      const action = prepared.pendingAction!;
      expect(action.approvedOrgUnitIds).toEqual([harness.ids.orgUnitId]);
      const before = await read<{ state: string; version: number }>(harness, 'mock_badges', harness.ids.badgeId);
      expect(before?.body).toMatchObject({ state: 'active', version: 1 });
      const first = await harness.confirmAction(action);
      expect(first.error).toBeNull();
      expect(first.receipt?.outcome).toBe('verified_success');

      const badge = await read<{ employeeId: string; state: string; version: number; operationKey: string }>(
        harness, 'mock_badges', harness.ids.badgeId,
      );
      expect(badge).toMatchObject({ rowVersion: 2, body: {
        employeeId: harness.ids.offboardingEmployeeId, state: 'revoked', version: 2, operationKey: first.receipt?.id,
      } });
      const events = await harness.fixture.store.workflowProjectionReader.query<Record<string, unknown>>({
        kind: 'unique', table: 'badge_effect_events', constraint: 'badge_effect_events_execution_unique',
        values: { executionId: first.receipt!.id },
      });
      expect(events).toHaveLength(1);
      expect(events[0].body).toMatchObject({
        badgeId: harness.ids.badgeId,
        employeeId: harness.ids.offboardingEmployeeId,
        actorId: harness.actors.hr.profileId,
        executionId: first.receipt?.id,
        effect: 'revoked',
        reason: payload.reason,
      });

      const duplicate = await harness.confirmAction(action);
      expect(duplicate.error).toBeNull();
      expect(duplicate.receipt?.id).toBe(first.receipt?.id);
      expect((await read<{ version: number }>(harness, 'mock_badges', harness.ids.badgeId))?.body.version).toBe(2);
      expect(await harness.fixture.store.workflowProjectionReader.query({
        kind: 'unique', table: 'badge_effect_events', constraint: 'badge_effect_events_execution_unique',
        values: { executionId: first.receipt!.id },
      })).toHaveLength(1);
    });
  });

  it('keeps operations bindings unavailable when a required readback field is absent from the projection schema', async () => {
    vi.resetModules();
    vi.doMock('../lib/storage/workflow-projections', async () => {
      const actual = await vi.importActual<typeof import('../lib/storage/workflow-projections')>('../lib/storage/workflow-projections');
      return {
        ...actual,
        getWorkflowProjection(table: WorkflowStorageTable) {
          const definition = actual.getWorkflowProjection(table);
          if (table !== 'onboarding_tasks') return definition;
          const shape = { ...(Reflect.get(definition.bodySchema, 'shape') as Record<string, z.ZodTypeAny>) };
          delete shape.reason;
          return { ...definition, bodySchema: z.object(shape).strict() };
        },
      };
    });

    try {
      const workflows = await import('../lib/packs/hr-operations-workflows');
      const readiness = workflows.getHrOperationsWorkflowAvailability().find((row) => row.kind === 'onboarding_tasks_create');
      expect(readiness).toMatchObject({ available: false, reason: expect.stringContaining('onboarding_tasks does not persist/read back reason') });
      const binding = workflows.createHrOperationsWorkflowBindings().find((row) => row.kind === 'onboarding_tasks_create');
      expect(binding).toBeDefined();
      await expect(binding!.identify({} as unknown as RuntimeReadContext, {
        kind: 'onboarding_tasks_create',
        requestId: 'schema-gap-request',
        targets: [{
          templateId: 'hr_welcome', ownerIdentityId: 'schema-gap-owner', reason: 'Schema gate test',
          dueDate: '2026-10-07', priority: 'normal',
        }],
      })).rejects.toMatchObject({ code: 'WORKFLOW_UNAVAILABLE', status: 503 });
    } finally {
      vi.doUnmock('../lib/storage/workflow-projections');
      vi.resetModules();
    }
  });
});
