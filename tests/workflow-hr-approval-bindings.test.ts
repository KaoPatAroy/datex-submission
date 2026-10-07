import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Profile } from '../lib/contracts';
import { digest } from '../lib/core/utils';
import { createHrApprovalWorkflowBindings } from '../lib/packs/hr-approval-workflows';
import { createWorkflowActionRunner } from '../lib/workflows/action-runner';
import { createWorkflowActionRuntime } from '../lib/workflows/action-runtime';
import type {
  OnboardingRequest,
  WorkflowPayloadV2,
  WorkflowReceiptV2,
} from '../lib/workflows/contracts';
import { createOnboardingQueryService } from '../lib/workflows/onboarding-queries';
import { demoWorkflowPolicyV1, getDemoWorkflowPolicyV1Pin } from '../lib/workflows/policy';
import { createWorkflowSqliteFixture } from './helpers/workflow-storage';

const NOW = '2026-10-04T04:00:00.000Z';
const BUSINESS_DATE = '2026-10-04';
const CHECKLIST_TEMPLATE_ID = 'hr_onboarding';

type ActorKey = 'manager' | 'director' | 'admin';
type DirectoryRole = 'east_manager' | 'hr_director' | 'hr_admin';
type ReviewKind = 'onboarding_manager_approve' | 'onboarding_director_approve' | 'onboarding_return';
type DocumentType = typeof demoWorkflowPolicyV1.requiredOnboardingDocuments[number];

interface TestActor {
  profileId: string;
  sessionId: string;
  identityId: string;
  responsibilityId: string;
  conversationId: string;
}

interface RequestOptions {
  branchId?: string;
  orgUnitId?: string;
  missingDocument?: DocumentType;
  oldPolicyDocument?: DocumentType;
  wrongClassificationDocument?: DocumentType;
}

interface AddedRequest {
  requestId: string;
  employeeId: string;
  documentIds: string[];
}

interface Harness {
  fixture: Awaited<ReturnType<typeof createWorkflowSqliteFixture>>;
  runtime: ReturnType<typeof createWorkflowActionRuntime>;
  runner: ReturnType<typeof createWorkflowActionRunner>;
  queries: ReturnType<typeof createOnboardingQueryService>;
  actors: Record<ActorKey, TestActor>;
  orgUnitId: string;
  otherOrgUnitId: string;
  branchId: string;
  otherBranchId: string;
  otherUnitBranchId: string;
  addRequest(label: string, options?: RequestOptions): Promise<AddedRequest>;
  dispose(): Promise<void>;
}

interface ApprovalEvent {
  id: string;
  requestId: string;
  actorIdentityId: string;
  stage: 'manager' | 'director' | 'return';
  lifecycleId: string;
  executionId: string;
  decision: 'approved' | 'returned_for_revision';
  reason?: string;
  createdAt: string;
}

function operationContextFor(action: { conversationId: string; turnId: string }) {
  return { conversationId: action.conversationId, turnId: action.turnId };
}

function reviewPayload(kind: ReviewKind, snapshotId: string, requestIds: string[]): WorkflowPayloadV2 {
  if (kind === 'onboarding_return') {
    return {
      kind,
      snapshotId,
      requestIds,
      reason: 'Please recheck the signed offer before proceeding.',
    };
  }
  return { kind, snapshotId, requestIds };
}

async function createHarness(): Promise<Harness> {
  const fixture = await createWorkflowSqliteFixture();
  const suffix = randomUUID().replaceAll('-', '');
  const makeId = (prefix: string) => `${prefix}-${suffix}`;
  const orgUnitId = makeId('hr-org');
  const otherOrgUnitId = makeId('hr-other-org');
  const branchId = makeId('hr-east-branch');
  const otherBranchId = makeId('hr-ungranted-branch');
  const otherUnitBranchId = makeId('hr-other-unit-branch');
  const actors: Record<ActorKey, TestActor> = {
    manager: {
      profileId: makeId('hr-manager-profile'),
      sessionId: makeId('hr-manager-session'),
      identityId: makeId('hr-manager-identity'),
      responsibilityId: makeId('hr-manager-responsibility'),
      conversationId: makeId('hr-manager-conversation'),
    },
    director: {
      profileId: makeId('hr-director-profile'),
      sessionId: makeId('hr-director-session'),
      identityId: makeId('hr-director-identity'),
      responsibilityId: makeId('hr-director-responsibility'),
      conversationId: makeId('hr-director-conversation'),
    },
    admin: {
      profileId: makeId('hr-admin-profile'),
      sessionId: makeId('hr-admin-session'),
      identityId: makeId('hr-admin-identity'),
      responsibilityId: makeId('hr-admin-responsibility'),
      conversationId: makeId('hr-admin-conversation'),
    },
  };

  const actorDefinitions: Array<{
    key: ActorKey;
    role: DirectoryRole;
    permissions: string[];
    purpose: 'manager_onboarding' | 'director_onboarding' | 'hr_operations';
    displayName: string;
  }> = [
    {
      key: 'manager', role: 'east_manager',
      permissions: ['hr.onboarding.manager_read', 'hr.onboarding.manager_approve'],
      purpose: 'manager_onboarding', displayName: 'Synthetic East Manager',
    },
    {
      key: 'director', role: 'hr_director',
      permissions: ['hr.onboarding.director_read', 'hr.onboarding.director_approve', 'hr.onboarding.return'],
      purpose: 'director_onboarding', displayName: 'Synthetic HR Director',
    },
    {
      key: 'admin', role: 'hr_admin',
      permissions: ['hr.read', 'hr.onboarding.start'],
      purpose: 'hr_operations', displayName: 'Synthetic HR Admin',
    },
  ];

  try {
    await fixture.store.transaction(async (tx) => {
      await tx.put('branches', { id: branchId, name: 'Synthetic East Branch', region: 'east' });
      await tx.put('branches', { id: otherBranchId, name: 'Synthetic Unassigned Branch', region: 'east' });
      await tx.put('branches', { id: otherUnitBranchId, name: 'Synthetic Other Unit Branch', region: 'east' });
      for (const definition of actorDefinitions) {
        const actor = actors[definition.key];
        const profile: Profile = {
          id: actor.profileId,
          name: definition.displayName,
          role: 'hr_admin',
          active: true,
          permissions: definition.permissions,
          regions: ['east'],
        };
        await tx.put('profiles', profile);
        await tx.put('sessions', {
          id: actor.sessionId,
          profileId: actor.profileId,
          mode: 'scripted_demo',
          modeRevision: 1,
          csrfToken: makeId(`${definition.key}-csrf`),
          expiresAt: '2099-01-01T00:00:00.000Z',
        });
      }
    });

    const policyPin = getDemoWorkflowPolicyV1Pin();
    const policyRow = {
      id: makeId('hr-policy-row'),
      version: policyPin.version,
      digest: policyPin.digest,
      policy: demoWorkflowPolicyV1,
    };
    await fixture.store.workflowTransaction(async (tx) => {
      for (const unit of [
        { id: orgUnitId, name: 'Synthetic East HR Unit' },
        { id: otherOrgUnitId, name: 'Synthetic Unassigned HR Unit' },
      ]) {
        await tx.insertUnique('org_units', {
          id: unit.id, name: unit.name, parentOrgUnitId: null, active: true,
        }, { constraint: 'org_units_primary_key', values: { id: unit.id } });
      }

      for (const definition of actorDefinitions) {
        const actor = actors[definition.key];
        await tx.insertUnique('directory_identities', {
          id: actor.identityId,
          profileId: actor.profileId,
          displayName: definition.displayName,
          active: true,
          role: definition.role,
          department: 'hr',
          orgUnitId,
          managerIdentityId: null,
          verifiedDemoEmail: `hr-${definition.key}-${suffix}@example.invalid`,
          slackIdentity: null,
          allowedChannels: ['simulated_email'],
          classificationCeiling: 'internal',
          rowVersion: 1,
        }, { constraint: 'directory_identities_primary_key', values: { id: actor.identityId } });

        await tx.insertUnique('responsibilities', {
          id: actor.responsibilityId,
          identityId: actor.identityId,
          orgUnitId,
          purpose: definition.purpose,
          branchIds: [branchId],
          active: true,
          rowVersion: 1,
        }, {
          constraint: 'responsibilities_open_identity_purpose_unique',
          values: { identityId: actor.identityId, purpose: definition.purpose, orgUnitId },
        });

        await tx.insertUnique('conversations', {
          id: actor.conversationId,
          actorId: actor.profileId,
          title: `${definition.displayName} workflow test`,
          pinned: false,
          archivedAt: null,
          rowVersion: 1,
          createdAt: NOW,
          updatedAt: NOW,
          lastScope: null,
          lastDashboardId: null,
        }, { constraint: 'conversations_primary_key', values: { id: actor.conversationId } });
      }

      await tx.insertUnique('workflow_policies', policyRow, {
        constraint: 'workflow_policies_primary_key', values: { id: policyRow.id },
      });
    });

    const runtime = createWorkflowActionRuntime({
      store: fixture.store,
      bindings: createHrApprovalWorkflowBindings(),
      businessDate: BUSINESS_DATE,
      getReleaseRevision: () => 'workflow-hr-approval-bindings-test-r1',
      getPackPins: (packIds) => packIds.map((id) => ({
        id,
        version: '1.0',
        schemaDigest: 'a'.repeat(64),
        implementationRevision: 'workflow-hr-approval-bindings-test-r1',
      })),
      contextFactory: () => ({
        evidence: async () => ({
          scope: { region: 'east', date: BUSINESS_DATE, branchIds: [branchId] },
          asOf: NOW,
          version: 'workflow-hr-approval-bindings-test-evidence-v1',
          branches: [],
          totals: { netSales: 0, target: 0, gap: 0, achievement: null },
          sources: [],
          warnings: [],
        }),
        latestDashboard: async () => undefined,
      }),
      now: () => new Date(NOW),
    });

    return {
      fixture,
      runtime,
      runner: createWorkflowActionRunner(runtime),
      queries: createOnboardingQueryService(runtime),
      actors,
      orgUnitId,
      otherOrgUnitId,
      branchId,
      otherBranchId,
      otherUnitBranchId,
      async addRequest(label, options = {}) {
        const requestId = makeId(`hr-request-${label}`);
        const employeeId = makeId(`hr-employee-${label}`);
        const lifecycleId = makeId(`hr-lifecycle-${label}`);
        const branch = options.branchId ?? branchId;
        const unit = options.orgUnitId ?? orgUnitId;
        await fixture.store.transaction((tx) => tx.put('employees', {
          id: employeeId,
          name: `Synthetic employee ${label}`,
          branchId: branch,
          active: true,
        }));

        const request: OnboardingRequest = {
          id: requestId,
          employeeId,
          orgUnitId: unit,
          managerIdentityId: actors.manager.identityId,
          directorIdentityId: actors.director.identityId,
          startDate: '2026-10-15',
          state: 'manager_review_pending',
          rowVersion: 1,
          lifecycleId,
          managerApprovalEventId: null,
          managerApprovedBy: null,
          managerApprovedAt: null,
          directorApprovalEventId: null,
          directorApprovedBy: null,
          directorApprovedAt: null,
          createdAt: NOW,
          updatedAt: NOW,
        };
        const documentIds: string[] = [];
        await fixture.store.workflowTransaction(async (tx) => {
          await tx.insertUnique('onboarding_requests', request, {
            constraint: 'onboarding_requests_primary_key', values: { id: requestId },
          });
          for (const documentType of demoWorkflowPolicyV1.requiredOnboardingDocuments) {
            if (options.missingDocument === documentType) continue;
            const document = {
              id: makeId(`hr-document-${label}-${documentType}`),
              rowVersion: 1,
              requestId,
              employeeId,
              documentType,
              status: 'accepted',
              policyVersion: options.oldPolicyDocument === documentType
                ? '0.9'
                : demoWorkflowPolicyV1.policyAcknowledgementVersion,
              classification: options.wrongClassificationDocument === documentType
                ? 'confidential'
                : demoWorkflowPolicyV1.classification,
              contentDigest: digest({ purpose: 'synthetic-onboarding-document', requestId, documentType }),
              createdAt: NOW,
              withdrawnAt: null,
            };
            await tx.insertUnique('onboarding_documents', document, {
              constraint: 'onboarding_documents_request_type_unique',
              values: { requestId, documentType },
            });
            documentIds.push(document.id);
          }
        });
        return { requestId, employeeId, documentIds };
      },
      async dispose() { await fixture.dispose(); },
    };
  } catch (error) {
    await fixture.dispose();
    throw error;
  }
}

async function withHarness<T>(run: (harness: Harness) => Promise<T>): Promise<T> {
  const harness = await createHarness();
  try {
    return await run(harness);
  } finally {
    await harness.dispose();
  }
}

async function prepareReview(
  harness: Harness,
  actor: 'manager' | 'director',
  kind: ReviewKind,
  snapshotId: string,
  requestIds: string[],
) {
  const owner = harness.actors[actor];
  return harness.runtime.prepare(owner.sessionId, reviewPayload(kind, snapshotId, requestIds), {
    conversationId: owner.conversationId,
    turnId: `hr-turn-${randomUUID()}`,
  });
}

async function prepareStart(harness: Harness, requestId: string) {
  const admin = harness.actors.admin;
  return harness.runtime.prepare(admin.sessionId, { kind: 'onboarding_start', requestId }, {
    conversationId: admin.conversationId,
    turnId: `hr-start-turn-${randomUUID()}`,
  });
}

async function confirmPrepared(
  harness: Harness,
  actor: ActorKey,
  prepared: { pendingAction: { id: string; conversationId: string; turnId: string } | null },
): Promise<WorkflowReceiptV2> {
  const action = prepared.pendingAction;
  if (!action) throw new Error('The real workflow runtime did not prepare an action');
  const result = await harness.runner.confirm(
    harness.actors[actor].sessionId,
    action.id,
    `hr-correlation-${randomUUID()}`,
    operationContextFor(action),
  );
  expect(result.error).toBeNull();
  expect(result.receipt?.outcome).toBe('verified_success');
  if (!result.receipt) throw new Error('The real workflow runtime did not return its verified receipt');
  return result.receipt;
}

async function countRows(
  harness: Harness,
  sql: string,
  ...values: string[]
): Promise<number> {
  const database = harness.fixture.openDatabase();
  try {
    const result = database.prepare(sql).get(...values) as { count: number };
    return Number(result.count);
  } finally {
    database.close();
  }
}

async function approvalEvent(
  harness: Harness,
  requestId: string,
  lifecycleId: string,
  stage: ApprovalEvent['stage'],
) {
  return harness.fixture.store.workflowProjectionReader.query<ApprovalEvent>({
    kind: 'unique',
    table: 'onboarding_approval_events',
    constraint: 'onboarding_approval_lifecycle_stage_unique',
    values: { requestId, lifecycleId, stage },
  });
}

async function expectApprovalReadback(
  harness: Harness,
  requestId: string,
  stage: 'manager' | 'director',
  state: OnboardingRequest['state'],
  actorIdentityId: string,
) {
  const requestRow = await harness.fixture.store.workflowProjectionReader.get<OnboardingRequest>('onboarding_requests', requestId);
  expect(requestRow?.body.state).toBe(state);
  expect(requestRow?.body.rowVersion).toBe(requestRow?.rowVersion);
  if (!requestRow) throw new Error(`Expected request ${requestId} to be independently readable`);
  const eventId = stage === 'manager' ? requestRow.body.managerApprovalEventId : requestRow.body.directorApprovalEventId;
  expect(eventId).toBeTruthy();
  if (!eventId) throw new Error(`Expected ${stage} approval event pointer for ${requestId}`);
  const eventRow = await harness.fixture.store.workflowProjectionReader.get<ApprovalEvent>('onboarding_approval_events', eventId);
  expect(eventRow?.body).toMatchObject({
    requestId,
    actorIdentityId,
    stage,
    lifecycleId: requestRow.body.lifecycleId,
    decision: 'approved',
  });
  if (!eventRow) throw new Error(`Expected ${stage} event ${eventId} to be independently readable`);
  const receiptRow = await harness.fixture.store.workflowProjectionReader.get<WorkflowReceiptV2>(
    'action_executions', eventRow.body.executionId,
  );
  expect(receiptRow?.body).toMatchObject({
    id: eventRow.body.executionId,
    kind: stage === 'manager' ? 'onboarding_manager_approve' : 'onboarding_director_approve',
    outcome: 'verified_success',
  });
  expect(receiptRow?.body.proofs).toEqual(expect.arrayContaining([
    expect.objectContaining({
      ref: { table: 'onboarding_approval_events', id: eventId },
      executionId: eventRow.body.executionId,
      outcome: 'verified_success',
    }),
  ]));
  if (!receiptRow) throw new Error(`Expected approval execution ${eventRow.body.executionId} to be independently readable`);
  return { request: requestRow, event: eventRow, receipt: receiptRow };
}

describe('real HR onboarding approval bindings with private SQLite', () => {
  it('keeps manager approval, Director approval, and HR Admin start separate with independent readback', async () => {
    await withHarness(async (harness) => {
      const request = await harness.addRequest('lifecycle');
      const { manager, director, admin } = harness.actors;

      expect(harness.runtime.availableKinds()).toEqual(expect.arrayContaining([
        'onboarding_manager_approve', 'onboarding_director_approve', 'onboarding_return', 'onboarding_start',
      ]));
      const managerProfile = await harness.fixture.store.get<Profile>('profiles', manager.profileId);
      expect(managerProfile?.permissions).not.toContain('hr.read');
      const managerPage = await harness.queries.managerQueue(manager.sessionId);
      expect(managerPage.items.map((item) => item.request.id)).toEqual([request.requestId]);
      expect(managerPage.snapshot.purpose).toBe('manager_queue');

      const directorBeforeManagerProof = await harness.queries.directorQueue(director.sessionId);
      expect(directorBeforeManagerProof.items).toEqual([]);
      expect((await harness.queries.directorApprovalsToday(director.sessionId)).items).toEqual([]);
      expect((await harness.queries.readyForStart(admin.sessionId)).items).toEqual([]);
      expect(await countRows(harness, 'SELECT COUNT(*) AS count FROM onboarding_approval_events')).toBe(0);
      expect(await countRows(harness, 'SELECT COUNT(*) AS count FROM onboarding_checklists')).toBe(0);
      expect(await countRows(harness, 'SELECT COUNT(*) AS count FROM action_executions')).toBe(0);
      expect(await countRows(harness, 'SELECT COUNT(*) AS count FROM semantic_effects')).toBe(0);

      const managerPrepared = await prepareReview(
        harness, 'manager', 'onboarding_manager_approve', managerPage.snapshot.id, [request.requestId],
      );
      expect(managerPrepared.outcome).toBe('pending');
      const managerReceipt = await confirmPrepared(harness, 'manager', managerPrepared);
      const managerReadback = await expectApprovalReadback(
        harness, request.requestId, 'manager', 'director_approval_pending', manager.identityId,
      );
      expect(managerReadback.event.body.executionId).toBe(managerReceipt.id);
      expect(managerReadback.request.body.managerApprovedBy).toBe(manager.identityId);
      expect(managerReadback.request.body.managerApprovalEventId).toBe(managerReadback.event.id);
      expect(managerReadback.event.body.lifecycleId).toBe(managerReadback.request.body.lifecycleId);
      expect(await countRows(harness, 'SELECT COUNT(*) AS count FROM onboarding_checklists')).toBe(0);

      const directorPage = await harness.queries.directorQueue(director.sessionId);
      expect(directorPage.items.map((item) => item.request.id)).toEqual([request.requestId]);
      expect(directorPage.snapshot.purpose).toBe('director_queue');
      expect(directorPage.snapshot.expectedRows).toContainEqual(expect.objectContaining({
        ref: { table: 'onboarding_approval_events', id: managerReadback.event.id },
      }));
      expect((await harness.queries.directorApprovalsToday(director.sessionId)).items).toEqual([]);
      expect((await harness.queries.readyForStart(admin.sessionId)).items).toEqual([]);

      const directorPrepared = await prepareReview(
        harness, 'director', 'onboarding_director_approve', directorPage.snapshot.id, [request.requestId],
      );
      expect(directorPrepared.outcome).toBe('pending');
      const directorReceipt = await confirmPrepared(harness, 'director', directorPrepared);
      const directorReadback = await expectApprovalReadback(
        harness, request.requestId, 'director', 'director_approved', director.identityId,
      );
      expect(directorReadback.event.body.executionId).toBe(directorReceipt.id);
      expect(directorReadback.request.body.directorApprovedBy).toBe(director.identityId);
      expect(directorReadback.request.body.directorApprovalEventId).toBe(directorReadback.event.id);
      expect(await countRows(harness, 'SELECT COUNT(*) AS count FROM onboarding_checklists')).toBe(0);

      const today = await harness.queries.directorApprovalsToday(director.sessionId);
      expect(today.items.map((item) => item.request.id)).toEqual([request.requestId]);
      expect(today.items[0].approval).toMatchObject({
        eventId: directorReadback.event.id,
        actorIdentityId: director.identityId,
        approvedAt: directorReadback.event.body.createdAt,
      });
      const ready = await harness.queries.readyForStart(admin.sessionId);
      expect(ready.items.map((item) => item.request.id)).toEqual([request.requestId]);
      expect(ready.items[0].approvals.manager.eventId).toBe(managerReadback.event.id);
      expect(ready.items[0].approvals.director.eventId).toBe(directorReadback.event.id);

      const duplicateDirector = await prepareReview(
        harness, 'director', 'onboarding_director_approve', directorPage.snapshot.id, [request.requestId],
      );
      expect(duplicateDirector.outcome).toBe('already_completed');
      expect(duplicateDirector.existingExecutionId).toBe(directorReceipt.id);
      expect(await countRows(harness,
        'SELECT COUNT(*) AS count FROM onboarding_approval_events WHERE request_id = ? AND stage = ?',
        request.requestId, 'director')).toBe(1);
      expect(await countRows(harness, 'SELECT COUNT(*) AS count FROM onboarding_checklists')).toBe(0);

      const startPrepared = await prepareStart(harness, request.requestId);
      expect(startPrepared.outcome).toBe('pending');
      const startReceipt = await confirmPrepared(harness, 'admin', startPrepared);
      const started = await harness.fixture.store.workflowProjectionReader.get<OnboardingRequest>(
        'onboarding_requests', request.requestId,
      );
      expect(started?.body).toMatchObject({ state: 'onboarding_in_progress' });
      const checklists = await harness.fixture.store.workflowProjectionReader.query<{
        id: string; requestId: string; templateId: string; status: string; executionId: string;
      }>({
        kind: 'unique',
        table: 'onboarding_checklists',
        constraint: 'onboarding_checklists_request_template_unique',
        values: { requestId: request.requestId, templateId: CHECKLIST_TEMPLATE_ID },
      });
      expect(checklists).toHaveLength(1);
      expect(checklists[0].body).toMatchObject({
        requestId: request.requestId,
        templateId: CHECKLIST_TEMPLATE_ID,
        status: 'open',
        executionId: startReceipt.id,
      });
      expect((await harness.queries.readyForStart(admin.sessionId)).items).toEqual([]);
      expect((await harness.queries.directorApprovalsToday(director.sessionId)).items.map((item) => item.request.id))
        .toEqual([request.requestId]);

      const duplicateStart = await prepareStart(harness, request.requestId);
      expect(duplicateStart.outcome).toBe('already_completed');
      expect(duplicateStart.existingExecutionId).toBe(startReceipt.id);
      expect(await countRows(harness,
        'SELECT COUNT(*) AS count FROM onboarding_checklists WHERE request_id = ? AND template_id = ?',
        request.requestId, CHECKLIST_TEMPLATE_ID)).toBe(1);
      expect(await countRows(harness, 'SELECT COUNT(*) AS count FROM onboarding_approval_events')).toBe(2);
    });
  });

  it('requires exact current-policy accepted documents and the paired organization-unit and branch responsibility', async () => {
    await withHarness(async (harness) => {
      const valid = await harness.addRequest('scope-valid');
      await harness.addRequest('old-policy', { oldPolicyDocument: 'signed_offer' });
      await harness.addRequest('wrong-classification', { wrongClassificationDocument: 'signed_contract' });
      await harness.addRequest('missing-contract', { missingDocument: 'signed_contract' });
      await harness.addRequest('ungranted-branch', { branchId: harness.otherBranchId });
      await harness.addRequest('ungranted-unit', {
        orgUnitId: harness.otherOrgUnitId,
        branchId: harness.otherUnitBranchId,
      });

      const managerPage = await harness.queries.managerQueue(harness.actors.manager.sessionId);
      expect(managerPage.items.map((item) => item.request.id)).toEqual([valid.requestId]);
      expect(managerPage.snapshot.count).toBe(1);
      expect(managerPage.items[0].documents.map((document) => document.documentType).sort()).toEqual(
        [...demoWorkflowPolicyV1.requiredOnboardingDocuments].sort(),
      );
      expect(managerPage.snapshot.expectedRows
        .filter((row) => row.ref.table === 'onboarding_documents')
        .map((row) => row.ref.id).sort()).toEqual([...valid.documentIds].sort());

      expect((await harness.queries.directorQueue(harness.actors.director.sessionId)).items).toEqual([]);
      expect((await harness.queries.directorApprovalsToday(harness.actors.director.sessionId)).items).toEqual([]);
      expect((await harness.queries.readyForStart(harness.actors.admin.sessionId)).items).toEqual([]);
      expect(await countRows(harness, 'SELECT COUNT(*) AS count FROM onboarding_approval_events')).toBe(0);
      expect(await countRows(harness, 'SELECT COUNT(*) AS count FROM action_executions')).toBe(0);

      const prepared = await prepareReview(
        harness, 'manager', 'onboarding_manager_approve', managerPage.snapshot.id, [valid.requestId],
      );
      expect(prepared.outcome).toBe('pending');
      await confirmPrepared(harness, 'manager', prepared);
      const readback = await expectApprovalReadback(
        harness, valid.requestId, 'manager', 'director_approval_pending', harness.actors.manager.identityId,
      );
      const directorPage = await harness.queries.directorQueue(harness.actors.director.sessionId);
      expect(directorPage.items.map((item) => item.request.id)).toEqual([valid.requestId]);
      expect(directorPage.snapshot.expectedRows).toContainEqual(expect.objectContaining({
        ref: { table: 'onboarding_approval_events', id: readback.event.id },
      }));
    });
  });

  it('selects only displayed snapshot members, excludes late arrivals, and leaves an atomic batch unapplied when one member goes stale', async () => {
    await withHarness(async (harness) => {
      const first = await harness.addRequest('batch-alpha');
      const second = await harness.addRequest('batch-beta');
      const managerPage = await harness.queries.managerQueue(harness.actors.manager.sessionId, { limit: 2 });
      expect(managerPage.snapshot.displayedIds).toEqual([first.requestId, second.requestId]);
      expect(managerPage.snapshot.count).toBe(2);

      const late = await harness.addRequest('batch-late');
      const lateIncluded = await prepareReview(
        harness, 'manager', 'onboarding_manager_approve', managerPage.snapshot.id,
        [...managerPage.snapshot.displayedIds, late.requestId],
      );
      expect(lateIncluded.outcome).toBe('stale');
      expect(lateIncluded.pendingAction).toBeNull();
      expect(await countRows(harness, 'SELECT COUNT(*) AS count FROM onboarding_approval_events')).toBe(0);

      const managerPrepared = await prepareReview(
        harness, 'manager', 'onboarding_manager_approve', managerPage.snapshot.id, managerPage.snapshot.displayedIds,
      );
      expect(managerPrepared.outcome).toBe('pending');
      expect(managerPrepared.pendingAction?.targets.map((target) => target.ref.id)).toEqual(managerPage.snapshot.displayedIds);
      const afterPrepare = await harness.addRequest('batch-after-prepare');
      await confirmPrepared(harness, 'manager', managerPrepared);
      for (const selected of [first, second]) {
        const row = await harness.fixture.store.workflowProjectionReader.get<OnboardingRequest>(
          'onboarding_requests', selected.requestId,
        );
        expect(row?.body.state).toBe('director_approval_pending');
        expect((await approvalEvent(harness, selected.requestId, row!.body.lifecycleId, 'manager'))).toHaveLength(1);
      }
      const lateRow = await harness.fixture.store.workflowProjectionReader.get<OnboardingRequest>(
        'onboarding_requests', late.requestId,
      );
      expect(lateRow?.body).toMatchObject({ state: 'manager_review_pending', managerApprovalEventId: null });
      expect(await approvalEvent(harness, late.requestId, lateRow!.body.lifecycleId, 'manager')).toHaveLength(0);
      const afterPrepareRow = await harness.fixture.store.workflowProjectionReader.get<OnboardingRequest>(
        'onboarding_requests', afterPrepare.requestId,
      );
      expect(afterPrepareRow?.body).toMatchObject({ state: 'manager_review_pending', managerApprovalEventId: null });
      expect((await harness.queries.managerQueue(harness.actors.manager.sessionId)).items.map((item) => item.request.id))
        .toEqual([afterPrepare.requestId, late.requestId]);

      const directorPage = await harness.queries.directorQueue(harness.actors.director.sessionId, { limit: 2 });
      expect(directorPage.items.map((item) => item.request.id)).toEqual([first.requestId, second.requestId]);
      const batchPrepared = await prepareReview(
        harness, 'director', 'onboarding_director_approve', directorPage.snapshot.id, directorPage.snapshot.displayedIds,
      );
      expect(batchPrepared.outcome).toBe('pending');
      expect(batchPrepared.pendingAction?.targets.map((target) => target.ref.id)).toEqual(directorPage.snapshot.displayedIds);

      const returnPrepared = await prepareReview(
        harness, 'director', 'onboarding_return', directorPage.snapshot.id, [second.requestId],
      );
      expect(returnPrepared.outcome).toBe('pending');
      await confirmPrepared(harness, 'director', returnPrepared);

      const staleBatch = await harness.runner.confirm(
        harness.actors.director.sessionId,
        batchPrepared.pendingAction!.id,
        `hr-stale-batch-${randomUUID()}`,
        operationContextFor(batchPrepared.pendingAction!),
      );
      expect(staleBatch.receipt).toBeNull();
      expect(staleBatch.error?.outcome).toBe('stale');
      expect(staleBatch.error?.retryBusinessWrite).toBe(false);
      const unchangedSibling = await harness.fixture.store.workflowProjectionReader.get<OnboardingRequest>(
        'onboarding_requests', first.requestId,
      );
      const returnedMember = await harness.fixture.store.workflowProjectionReader.get<OnboardingRequest>(
        'onboarding_requests', second.requestId,
      );
      expect(unchangedSibling?.body).toMatchObject({
        state: 'director_approval_pending', directorApprovalEventId: null,
      });
      expect(returnedMember?.body).toMatchObject({
        state: 'returned_for_revision',
        managerApprovalEventId: null,
        managerApprovedBy: null,
        managerApprovedAt: null,
        directorApprovalEventId: null,
        directorApprovedBy: null,
        directorApprovedAt: null,
      });
      expect(await countRows(harness,
        'SELECT COUNT(*) AS count FROM onboarding_approval_events WHERE stage = ?', 'director')).toBe(0);
      expect(await countRows(harness,
        'SELECT COUNT(*) AS count FROM onboarding_approval_events WHERE stage = ?', 'return')).toBe(1);
      expect(await countRows(harness,
        'SELECT COUNT(*) AS count FROM onboarding_approval_events WHERE stage = ?', 'manager')).toBe(2);
      expect(await countRows(harness,
        'SELECT COUNT(*) AS count FROM semantic_effects'))
        .toBe(3);
    });
  });

  it('makes return terminal for the current lifecycle and prevents same-lifecycle approval replay', async () => {
    await withHarness(async (harness) => {
      const request = await harness.addRequest('return-terminal');
      const managerPage = await harness.queries.managerQueue(harness.actors.manager.sessionId);
      const managerPrepared = await prepareReview(
        harness, 'manager', 'onboarding_manager_approve', managerPage.snapshot.id, [request.requestId],
      );
      const managerReceipt = await confirmPrepared(harness, 'manager', managerPrepared);
      const managerReadback = await expectApprovalReadback(
        harness, request.requestId, 'manager', 'director_approval_pending', harness.actors.manager.identityId,
      );
      expect(managerReadback.event.body.executionId).toBe(managerReceipt.id);

      const directorPage = await harness.queries.directorQueue(harness.actors.director.sessionId);
      expect(directorPage.items.map((item) => item.request.id)).toEqual([request.requestId]);
      const returnPrepared = await prepareReview(
        harness, 'director', 'onboarding_return', directorPage.snapshot.id, [request.requestId],
      );
      const returnReceipt = await confirmPrepared(harness, 'director', returnPrepared);
      const returned = await harness.fixture.store.workflowProjectionReader.get<OnboardingRequest>(
        'onboarding_requests', request.requestId,
      );
      expect(returned?.body).toMatchObject({
        state: 'returned_for_revision',
        managerApprovalEventId: null,
        managerApprovedBy: null,
        managerApprovedAt: null,
        directorApprovalEventId: null,
        directorApprovedBy: null,
        directorApprovedAt: null,
      });
      if (!returned) throw new Error('The returned request was not independently readable');
      const returnEvents = await approvalEvent(harness, request.requestId, returned.body.lifecycleId, 'return');
      expect(returnEvents).toHaveLength(1);
      expect(returnEvents[0].body).toMatchObject({
        requestId: request.requestId,
        actorIdentityId: harness.actors.director.identityId,
        stage: 'return',
        lifecycleId: returned.body.lifecycleId,
        decision: 'returned_for_revision',
        reason: 'Please recheck the signed offer before proceeding.',
        executionId: returnReceipt.id,
      });
      const persistedReturnReceipt = await harness.fixture.store.workflowProjectionReader.get<WorkflowReceiptV2>(
        'action_executions', returnReceipt.id,
      );
      expect(persistedReturnReceipt?.body).toMatchObject({
        id: returnReceipt.id,
        kind: 'onboarding_return',
        outcome: 'verified_success',
      });

      expect((await approvalEvent(harness, request.requestId, returned.body.lifecycleId, 'manager'))[0].body.id)
        .toBe(managerReadback.event.id);
      expect((await harness.queries.managerQueue(harness.actors.manager.sessionId)).items).toEqual([]);
      expect((await harness.queries.directorQueue(harness.actors.director.sessionId)).items).toEqual([]);
      expect((await harness.queries.directorApprovalsToday(harness.actors.director.sessionId)).items).toEqual([]);
      expect((await harness.queries.readyForStart(harness.actors.admin.sessionId)).items).toEqual([]);

      const sameLifecycleApproval = await prepareReview(
        harness, 'director', 'onboarding_director_approve', directorPage.snapshot.id, [request.requestId],
      );
      expect(sameLifecycleApproval.outcome).toBe('stale');
      expect(sameLifecycleApproval.pendingAction).toBeNull();
      const repeatedReturn = await prepareReview(
        harness, 'director', 'onboarding_return', directorPage.snapshot.id, [request.requestId],
      );
      expect(repeatedReturn.outcome).toBe('already_completed');
      expect(repeatedReturn.existingExecutionId).toBe(returnReceipt.id);
      const repeatedManagerApproval = await prepareReview(
        harness, 'manager', 'onboarding_manager_approve', managerPage.snapshot.id, [request.requestId],
      );
      expect(repeatedManagerApproval.outcome).toBe('already_completed');
      expect(repeatedManagerApproval.existingExecutionId).toBe(managerReceipt.id);
      expect(await countRows(harness, 'SELECT COUNT(*) AS count FROM onboarding_approval_events')).toBe(2);
      expect(await countRows(harness,
        'SELECT COUNT(*) AS count FROM onboarding_approval_events WHERE stage = ?', 'director')).toBe(0);
      expect(await countRows(harness, 'SELECT COUNT(*) AS count FROM onboarding_checklists')).toBe(0);
    });
  });
});
