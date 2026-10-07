import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Profile, Store } from '../lib/contracts';
import { DomainError } from '../lib/core/errors';
import type { WorkflowTransactionContext } from '../lib/storage/workflow-projections';
import { digest } from '../lib/core/utils';
import type { WorkflowOperationContext } from '../lib/workflows/action-results';
import { createWorkflowActionRunner } from '../lib/workflows/action-runner';
import { createWorkflowActionRuntime, defineWorkflowBinding, type RuntimeReadContext, type WorkflowRootRow } from '../lib/workflows/action-runtime';
import { demoWorkflowPolicyV1, getDemoWorkflowPolicyV1Pin } from '../lib/workflows/policy';
import type {
  CurrentState,
  ExpectedRow,
  OnboardingRequest,
  PendingActionV2,
  Ref,
  TargetProof,
  WorkflowPayloadV2,
  PreparationResult,
  WorkflowReceiptV2,
  WorkflowStorageTable,
} from '../lib/workflows/contracts';
import { createWorkflowSqliteFixture } from './helpers/workflow-storage';

// These controlled callbacks exercise generic execution guarantees only; they do not claim real workflow catalog coverage.
const NOW = '2026-10-03T04:00:00.000Z';
const PERMISSION = 'hr.onboarding.tasks';
const PACK_ID = 'hr';
const PACK_DIGEST = 'b'.repeat(64);

type Fixture = Awaited<ReturnType<typeof createWorkflowSqliteFixture>>;
type TaskPayload = Extract<WorkflowPayloadV2, { kind: 'onboarding_tasks_create' }>;
type TaskTemplate = TaskPayload['targets'][number]['templateId'];
const taskTemplates = ['hr_welcome', 'it_setup_request', 'policy_acknowledgement'] as const satisfies readonly TaskTemplate[];
type TaskRow = {
  id: string;
  rowVersion: number;
  requestId: string;
  employeeId: string;
  ownerIdentityId: string;
  templateId: string;
  reason: string;
  priority: TaskPayload['targets'][number]['priority'];
  status: string;
  dueDate: string;
  title: string;
  executionId: string;
  createdAt: string;
};
type Fault = 'none' | 'wrong_due_date' | 'wrong_employee' | 'throw_after_first_write' | 'missing' | 'extra' | 'duplicate' | 'wrong_ref' | 'wrong_execution' | 'wrong_version';

function operationContextFor(action: Pick<PendingActionV2, 'conversationId' | 'turnId'>): WorkflowOperationContext {
  return { conversationId: action.conversationId, turnId: action.turnId };
}

interface Harness {
  fixture: Fixture;
  runtime: ReturnType<typeof createWorkflowActionRuntime>;
  runner: ReturnType<typeof createWorkflowActionRunner>;
  store: Fixture['store'];
  profile: Profile;
  profileId: string;
  sessionId: string;
  conversationId: string;
  identityId: string;
  orgUnitId: string;
  responsibilityId: string;
  requestId: string;
  employeeId: string;
  otherEmployeeId: string;
  addOwnedContext(): Promise<{ sessionId: string; conversationId: string }>;
  addForeignActorContext(): Promise<{ sessionId: string; conversationId: string }>;
  executeReader: unknown;
  verificationReaders: unknown[];
  workflowTransactionFailures: Array<{ call: number; phase: string; name: string; code: string | null; message: string }>;
  taskIds(templates: TaskTemplate[]): string[];
  payload(templates?: TaskTemplate[]): TaskPayload;
  prepare(templates?: TaskTemplate[]): Promise<PreparationResult>;
  setDiagnosticPhase(value: string): void;
  counters: { identify: number; validate: number; execute: number; stagedWrites: number; verify: number; currentStates: number };
  setFault(fault: Fault): void;
  setNow(value: string): void;
  setPackVersion(value: string): void;
  setReleaseRevision(value: string): void;
  setBaseImplementationRevision(value: string): void;
  setValidationPolicyDigest(value: string): void;
  setLoseClaimCommitResponse(value: boolean): void;
  setLoseEffectCommitResponse(value: boolean): void;
  setFailTransactionCall(value: number | null, error?: unknown): void;
  setWorkflowTransactionBarrier(phase: 'before' | 'after', call: number): { entered: Promise<void>; release(): void };
  dispose(): Promise<void>;
}

function taskTitle(templateId: TaskTemplate): string {
  return `Controlled ${templateId} task`;
}

function taskRowId(requestId: string, templateId: TaskTemplate): string {
  return `workflow-test-task-${requestId}-${templateId}`;
}

function taskTargetId(requestId: string, employeeId: string, templateId: TaskTemplate): string {
  return `${requestId}:${employeeId}:${templateId}`;
}

function splitTaskTargetId(value: string): { requestId: string; employeeId: string; templateId: string } {
  const [requestId, employeeId, templateId, extra] = value.split(':');
  if (!requestId || !employeeId || !templateId || extra !== undefined) throw new Error('Malformed controlled task target identity');
  return { requestId, employeeId, templateId };
}

async function createHarness(options: { policyMode?: 'valid' | 'missing' | 'wrong_digest' } = {}): Promise<Harness> {
  const fixture = await createWorkflowSqliteFixture();
  const suffix = randomUUID().replaceAll('-', '');
  const profileId = `runner-profile-${suffix}`;
  const sessionId = `runner-session-${suffix}`;
  const conversationId = `runner-conversation-${suffix}`;
  const identityId = `runner-identity-${suffix}`;
  const orgUnitId = `runner-org-${suffix}`;
  const branchId = `runner-branch-${suffix}`;
  const responsibilityId = `runner-responsibility-${suffix}`;
  const employeeId = `runner-employee-${suffix}`;
  const otherEmployeeId = `runner-other-employee-${suffix}`;
  const requestId = `runner-request-${suffix}`;
  const profile: Profile = {
    id: profileId, name: 'Workflow runner test profile', role: 'hr_admin', active: true,
    permissions: [PERMISSION, 'hr.read'], regions: ['east'],
  };
  const policyPin = getDemoWorkflowPolicyV1Pin();
  const policyRow = {
    id: `runner-policy-row-${suffix}`, version: policyPin.version,
    digest: options.policyMode === 'wrong_digest' ? 'f'.repeat(64) : policyPin.digest,
    policy: demoWorkflowPolicyV1,
  };
  let now = new Date(NOW);
  let packVersion = '1.0';
  let baseImplementationRevision = 'hr-runner-test-base-r1';
  let validationPolicyDigest = policyPin.digest;
  let releaseRevision = 'workflow-runner-test-release-r1';
  let fault: Fault = 'none';
  let loseClaimCommitResponse = false;
  let lostClaimCommitResponse = false;
  let loseEffectCommitResponse = false;
  let lostCommitResponse = false;
  let failTransactionCall: number | null = null;
  let failTransactionError: unknown = new Error('Injected workflow transaction failure before delegation');
  let workflowTransactionCalls = 0;
  let transactionBarrier: { call: number; phase: 'before' | 'after'; entered(): void; waiting: Promise<void> } | null = null;
  let diagnosticPhase = 'setup';
  let generatedId = 0;
  const counters = { identify: 0, validate: 0, execute: 0, stagedWrites: 0, verify: 0, currentStates: 0 };
  let executeReader: unknown;
  const verificationReaders: unknown[] = [];
  const workflowTransactionFailures: Array<{ call: number; phase: string; name: string; code: string | null; message: string }> = [];

  const waitAtTransactionBarrier = async (phase: 'before' | 'after'): Promise<void> => {
    const barrier = transactionBarrier;
    if (barrier?.call !== workflowTransactionCalls || barrier.phase !== phase) return;
    transactionBarrier = null;
    barrier.entered();
    await barrier.waiting;
  };

  try {
    await fixture.store.transaction(async (tx) => {
      await tx.put('profiles', profile);
      await tx.put('branches', { id: branchId, name: 'Workflow runner branch', region: 'east' });
      await tx.put('employees', { id: employeeId, name: 'Workflow runner employee', branchId, active: true });
      await tx.put('employees', { id: otherEmployeeId, name: 'Workflow runner alternate employee', branchId, active: true });
      await tx.put('sessions', {
        id: sessionId, profileId, mode: 'scripted_demo', modeRevision: 4,
        csrfToken: `runner-csrf-${suffix}`, expiresAt: '2099-01-01T00:00:00.000Z',
      });
    });

    await fixture.store.workflowTransaction(async (tx) => {
      await tx.insertUnique('org_units', {
        id: orgUnitId, name: 'Workflow runner org', parentOrgUnitId: null, active: true,
      }, { constraint: 'org_units_primary_key', values: { id: orgUnitId } });
      await tx.insertUnique('directory_identities', {
        id: identityId, profileId, displayName: 'Workflow runner HR Admin', active: true,
        role: 'hr_admin', department: 'hr', orgUnitId, managerIdentityId: null,
        verifiedDemoEmail: `runner-${suffix}@example.invalid`, slackIdentity: null,
        allowedChannels: ['simulated_email'], classificationCeiling: 'internal', rowVersion: 1,
      }, { constraint: 'directory_identities_primary_key', values: { id: identityId } });
      await tx.insertUnique('responsibilities', {
        id: responsibilityId, identityId, orgUnitId, purpose: 'hr_operations', branchIds: [branchId], active: true, rowVersion: 1,
      }, { constraint: 'responsibilities_open_identity_purpose_unique', values: { identityId, purpose: 'hr_operations', orgUnitId } });
      await tx.insertUnique('conversations', {
        id: conversationId, actorId: profileId, title: 'Workflow runner conversation', pinned: false, archivedAt: null,
        rowVersion: 1, createdAt: NOW, updatedAt: NOW, lastScope: null, lastDashboardId: null,
      }, { constraint: 'conversations_primary_key', values: { id: conversationId } });
      if (options.policyMode !== 'missing') {
        await tx.insertUnique('workflow_policies', policyRow, {
          constraint: 'workflow_policies_primary_key', values: { id: policyRow.id },
        });
      }
      const request: OnboardingRequest = {
        id: requestId,
        employeeId,
        orgUnitId,
        managerIdentityId: identityId,
        directorIdentityId: identityId,
        startDate: '2026-10-15',
        state: 'draft',
        rowVersion: 1,
        lifecycleId: `runner-lifecycle-${suffix}`,
        managerApprovalEventId: null,
        managerApprovedBy: null,
        managerApprovedAt: null,
        directorApprovalEventId: null,
        directorApprovedBy: null,
        directorApprovedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      };
      await tx.insertUnique('onboarding_requests', request, {
        constraint: 'onboarding_requests_primary_key', values: { id: requestId },
      });
    });

    const taskTargets = (templates: readonly TaskTemplate[]) => templates.map((templateId) => ({
      templateId,
      ownerIdentityId: identityId,
      reason: `Controlled runtime test for ${templateId}.`,
      dueDate: '2026-10-06',
      priority: 'normal' as const,
    }));

    const binding = defineWorkflowBinding({
      kind: 'onboarding_tasks_create',
      contractVersion: 2,
      packIds: [PACK_ID],
      executionMode: 'atomic_local',
      authority: { permission: PERMISSION, roles: ['hr_admin'], purpose: 'hr_operations' },
      async identify(context: RuntimeReadContext, payload: TaskPayload) {
        counters.identify += 1;
        const request = await context.projections.get<OnboardingRequest>('onboarding_requests', payload.requestId);
        if (!request) throw new Error(`Missing controlled request ${payload.requestId}`);
        return { targets: payload.targets.map((input) => {
          return {
            targetId: taskTargetId(payload.requestId, request.body.employeeId, input.templateId),
            ref: { table: 'onboarding_requests' as const, id: payload.requestId },
            semanticKey: digest({ kind: payload.kind, requestId: payload.requestId, lifecycleId: request.body.lifecycleId, templateId: input.templateId }),
            scope: { orgUnitId: request.body.orgUnitId },
          };
        }) };
      },
      expectedPostconditions(action: PendingActionV2, executionId: string, confirmedAt: string) {
        if (action.payload.kind !== 'onboarding_tasks_create') throw new Error('Unexpected controlled payload kind');
        const payload = action.payload;
        return action.targets.map((target) => {
          const identity = splitTaskTargetId(target.targetId);
          const input = payload.targets.find((candidate) => candidate.templateId === identity.templateId);
          if (!input) throw new Error(`Missing approved task input for ${target.targetId}`);
          return {
            targetId: target.targetId,
            ref: target.expectedEffectRef,
            rowVersion: target.expectedEffectVersion,
            executionId,
            fields: [
              { path: 'requestId', expected: identity.requestId },
              { path: 'employeeId', expected: identity.employeeId },
              { path: 'templateId', expected: input.templateId },
              { path: 'ownerIdentityId', expected: input.ownerIdentityId },
              { path: 'status', expected: 'open' },
              { path: 'dueDate', expected: input.dueDate },
              { path: 'title', expected: taskTitle(input.templateId) },
              { path: 'executionId', expected: executionId },
              { path: 'createdAt', expected: confirmedAt },
            ],
            attributionRefs: [],
          };
        });
      },
      async validate(context, payload: TaskPayload) {
        counters.validate += 1;
        const request = await context.reader.get<OnboardingRequest>('onboarding_requests', payload.requestId);
        if (!request) throw new Error(`Missing controlled request ${payload.requestId}`);
        const expectedRequest: ExpectedRow = {
          ref: { table: 'onboarding_requests', id: request.id }, rowVersion: request.rowVersion, state: request.state,
        };
        return {
          targets: payload.targets.map((input) => {
            const ref = { table: 'onboarding_requests' as const, id: payload.requestId };
            const effectRef = { table: 'onboarding_tasks' as const, id: taskRowId(payload.requestId, input.templateId) };
            return {
              targetId: taskTargetId(payload.requestId, request.employeeId, input.templateId),
              ref,
              semanticKey: digest({ kind: payload.kind, requestId: payload.requestId, lifecycleId: request.lifecycleId, templateId: input.templateId }),
              expectedRows: [expectedRequest],
              ownerIdentityId: input.ownerIdentityId,
              expectedEffectRef: effectRef,
              expectedEffectVersion: 1,
            };
          }),
          expectedRows: [expectedRequest],
          approvedBranchIds: [],
          approvedOrgUnitIds: [orgUnitId],
          policy: { ...policyPin, digest: validationPolicyDigest },
          reviewedSnapshotId: null,
        };
      },
      async executeAtomic(context, payload: TaskPayload) {
        counters.execute += 1;
        executeReader = context.reader;
        const request = await context.tx.get<OnboardingRequest>('onboarding_requests', payload.requestId);
        if (!request || request.state !== 'draft') throw new Error('The controlled task request changed');
        const committed = [];
        for (let index = 0; index < context.action.targets.length; index += 1) {
          const target = context.action.targets[index];
          const input = payload.targets.find((candidate) => taskTargetId(payload.requestId, request.employeeId, candidate.templateId) === target.targetId);
          if (!input) throw new Error(`Missing callback input for ${target.targetId}`);
          const row: TaskRow = {
            id: target.expectedEffectRef.id,
            rowVersion: 1,
            requestId: payload.requestId,
            employeeId: fault === 'wrong_employee' && index === 1 ? otherEmployeeId : request.employeeId,
            ownerIdentityId: input.ownerIdentityId,
            templateId: input.templateId,
            reason: input.reason,
            priority: input.priority,
            status: 'open',
            dueDate: fault === 'wrong_due_date' && index === 1 ? '2026-10-07' : input.dueDate,
            title: taskTitle(input.templateId),
            executionId: context.executionId,
            createdAt: context.now().toISOString(),
          };
          const inserted = await context.tx.insertUnique('onboarding_tasks', row, {
            constraint: 'onboarding_tasks_request_template_unique',
            values: { requestId: payload.requestId, templateId: input.templateId },
          });
          if (!inserted.inserted) throw new Error(`The controlled task ${input.templateId} already exists`);
          counters.stagedWrites += 1;
          if (fault === 'throw_after_first_write' && index === 0) throw new Error('Injected throw after the first staged task row');
          committed.push({ targetId: target.targetId, ref: target.expectedEffectRef, executionId: context.executionId, rowVersion: 1 });
        }
        switch (fault) {
          case 'missing': return committed.slice(1);
          case 'extra': return [...committed, { ...committed[0], targetId: 'unprepared-extra-target' }];
          case 'duplicate': return [committed[0], committed[0]];
          case 'wrong_ref': return committed.map((result, index) => index === 0
            ? { ...result, ref: { ...result.ref, id: `${result.ref.id}-wrong` } } : result);
          case 'wrong_execution': return committed.map((result, index) => index === 0
            ? { ...result, executionId: 'unrelated-execution' } : result);
          case 'wrong_version': return committed.map((result, index) => index === 0
            ? { ...result, rowVersion: result.rowVersion + 1 } : result);
          default: return committed;
        }
      },
      async verify(context, committed): Promise<TargetProof[]> {
        counters.verify += 1;
        verificationReaders.push(context.reader);
        return Promise.all(committed.map(async (result) => {
          const prepared = context.action.targets.find((candidate) => candidate.targetId === result.targetId);
          if (!prepared) throw new Error(`Missing prepared target ${result.targetId}`);
          const payload = context.action.payload;
          const identity = splitTaskTargetId(prepared.targetId);
          const input = payload.kind === 'onboarding_tasks_create'
            ? payload.targets.find((candidate) => candidate.templateId === identity.templateId)
            : undefined;
          const row = await context.reader.get<TaskRow>(result.ref.table as WorkflowStorageTable, result.ref.id);
          const valid = payload.kind === 'onboarding_tasks_create' && !!input && row?.requestId === identity.requestId &&
            row.employeeId === identity.employeeId && row.templateId === input.templateId && row.ownerIdentityId === input.ownerIdentityId &&
            row.status === 'open' && row.dueDate === input.dueDate && row.title === taskTitle(input.templateId) &&
            row.executionId === context.executionId && row.rowVersion === result.rowVersion;
          return {
            targetId: result.targetId,
            ref: prepared.expectedEffectRef,
            outcome: valid ? 'verified_success' : 'pending',
            executionId: context.executionId,
            observedRowVersion: row?.rowVersion ?? null,
            checkedAt: valid ? context.now().toISOString() : null,
            mismatchCodes: valid ? [] : ['INDEPENDENT_READBACK_MISMATCH'],
          };
        }));
      },
      async currentStates(context, refs: Ref[]): Promise<CurrentState[]> {
        counters.currentStates += 1;
        const current: CurrentState[] = [];
        const seen = new Set<string>();
        for (const ref of refs) {
          const key = JSON.stringify([ref.table, ref.id]);
          if (seen.has(key)) continue;
          seen.add(key);
          if (ref.table !== 'onboarding_requests') throw new Error(`Unexpected controlled source reference ${ref.table}`);
          const request = await context.reader.get<OnboardingRequest>('onboarding_requests', ref.id);
          if (!request) continue;
          const completedActionsByExecution = new Map<string, string>();
          for (const templateId of taskTemplates) {
            const task = await context.projections.query<TaskRow>({
              kind: 'unique',
              table: 'onboarding_tasks',
              constraint: 'onboarding_tasks_request_template_unique',
              values: { requestId: request.id, templateId },
            });
            const row = task[0]?.body;
            if (row?.executionId) completedActionsByExecution.set(row.executionId, row.createdAt);
          }
          current.push({
            ref,
            state: request.state,
            rowVersion: request.rowVersion,
            allowedNextActions: [],
            completedActions: [...completedActionsByExecution].map(([executionId, completedAt]) => ({
              kind: 'onboarding_tasks_create', executionId, completedAt,
            })),
          });
        }
        return current;
      },
    });

    const wrappedStore = new Proxy(fixture.store, {
      get(target, property, receiver) {
        if (property === 'workflowTransaction') {
          return async <T>(work: (tx: WorkflowTransactionContext) => Promise<T>): Promise<T> => {
            workflowTransactionCalls += 1;
            if (failTransactionCall === workflowTransactionCalls) throw failTransactionError;
            await waitAtTransactionBarrier('before');
            let result: T;
            try {
              result = await target.workflowTransaction(work);
            } catch (error) {
              const diagnostic = typeof error === 'object' && error !== null ? error as {
                name?: unknown; code?: unknown; message?: unknown;
              } : undefined;
              workflowTransactionFailures.push({
                call: workflowTransactionCalls,
                phase: diagnosticPhase,
                name: typeof diagnostic?.name === 'string' ? diagnostic.name : typeof error,
                code: typeof diagnostic?.code === 'string' ? diagnostic.code : null,
                message: typeof diagnostic?.message === 'string' ? diagnostic.message : String(error),
              });
              throw error;
            }
            if (loseClaimCommitResponse && !lostClaimCommitResponse) {
              lostClaimCommitResponse = true;
              throw new Error('Injected lost response after the real claim transaction committed');
            }
            if (loseEffectCommitResponse && !lostCommitResponse && counters.execute > 0) {
              lostCommitResponse = true;
              throw new Error('Injected lost response after the real effect transaction committed');
            }
            await waitAtTransactionBarrier('after');
            return result;
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Fixture['store'];

    const runtime = createWorkflowActionRuntime({
      store: wrappedStore as Store & typeof fixture.store,
      bindings: [binding],
      businessDate: '2026-10-03',
      getReleaseRevision: () => releaseRevision,
      getPackPins: (packIds) => packIds.map((id) => ({
        id, version: packVersion, schemaDigest: PACK_DIGEST, implementationRevision: baseImplementationRevision,
      })),
      contextFactory: () => ({
        evidence: async () => ({
          scope: { region: 'east', date: '2026-10-03', branchIds: [] }, asOf: NOW, version: 'runner-test-evidence-v1',
          branches: [], totals: { netSales: 0, target: 0, gap: 0, achievement: null }, sources: [], warnings: [],
        }),
        latestDashboard: async () => undefined,
      }),
      now: () => new Date(now),
      makeId: (prefix) => `runner-${prefix}-${suffix}-${++generatedId}`,
    });

    const taskIdList = (templates: TaskTemplate[]) => templates.map((templateId) => taskRowId(requestId, templateId));
    const payloadFor = (templates: TaskTemplate[] = ['hr_welcome']) => ({
      kind: 'onboarding_tasks_create' as const,
      requestId,
      targets: taskTargets(templates),
    });
    const runner = createWorkflowActionRunner(runtime);
    return {
      fixture, runtime, runner, store: fixture.store, profile, profileId, sessionId, conversationId, identityId, orgUnitId,
      responsibilityId, requestId, employeeId, taskIds: taskIdList, payload: payloadFor,
      prepare: async (templates = ['hr_welcome']) => runtime.prepare(sessionId, payloadFor(templates), {
        conversationId, turnId: `runner-turn-${suffix}-${++generatedId}`,
      }),
      setDiagnosticPhase(value) { diagnosticPhase = value; },
      async addOwnedContext() {
        const alternateSessionId = `runner-session-alt-${suffix}`;
        const alternateConversationId = `runner-conversation-alt-${suffix}`;
        await fixture.store.transaction((tx) => tx.put('sessions', {
          id: alternateSessionId, profileId, mode: 'scripted_demo', modeRevision: 4,
          csrfToken: `runner-csrf-alt-${suffix}`, expiresAt: '2099-01-01T00:00:00.000Z',
        }));
        await fixture.store.workflowTransaction((tx) => tx.insertUnique('conversations', {
          id: alternateConversationId, actorId: profileId, title: 'Another owned conversation', pinned: false,
          archivedAt: null, rowVersion: 1, createdAt: NOW, updatedAt: NOW, lastScope: null, lastDashboardId: null,
        }, { constraint: 'conversations_primary_key', values: { id: alternateConversationId } }));
        return { sessionId: alternateSessionId, conversationId: alternateConversationId };
      },
      async addForeignActorContext() {
        const foreignProfileId = `runner-foreign-profile-${suffix}`;
        const foreignSessionId = `runner-foreign-session-${suffix}`;
        const foreignIdentityId = `runner-foreign-identity-${suffix}`;
        const foreignResponsibilityId = `runner-foreign-responsibility-${suffix}`;
        const foreignConversationId = `runner-foreign-conversation-${suffix}`;
        await fixture.store.transaction(async (tx) => {
          await tx.put('profiles', { ...profile, id: foreignProfileId, name: 'Workflow runner foreign actor' });
          await tx.put('sessions', {
            id: foreignSessionId, profileId: foreignProfileId, mode: 'scripted_demo', modeRevision: 4,
            csrfToken: `runner-csrf-foreign-${suffix}`, expiresAt: '2099-01-01T00:00:00.000Z',
          });
        });
        await fixture.store.workflowTransaction(async (tx) => {
          await tx.insertUnique('directory_identities', {
            id: foreignIdentityId, profileId: foreignProfileId, displayName: 'Workflow runner foreign HR Admin', active: true,
            role: 'hr_admin', department: 'hr', orgUnitId, managerIdentityId: null,
            verifiedDemoEmail: `runner-foreign-${suffix}@example.invalid`, slackIdentity: null,
            allowedChannels: ['simulated_email'], classificationCeiling: 'internal', rowVersion: 1,
          }, { constraint: 'directory_identities_primary_key', values: { id: foreignIdentityId } });
          await tx.insertUnique('responsibilities', {
            id: foreignResponsibilityId, identityId: foreignIdentityId, orgUnitId, purpose: 'hr_operations',
            branchIds: [branchId], active: true, rowVersion: 1,
          }, { constraint: 'responsibilities_open_identity_purpose_unique',
            values: { identityId: foreignIdentityId, purpose: 'hr_operations', orgUnitId } });
          await tx.insertUnique('conversations', {
            id: foreignConversationId, actorId: foreignProfileId, title: 'Foreign actor conversation', pinned: false,
            archivedAt: null, rowVersion: 1, createdAt: NOW, updatedAt: NOW, lastScope: null, lastDashboardId: null,
          }, { constraint: 'conversations_primary_key', values: { id: foreignConversationId } });
        });
        return { sessionId: foreignSessionId, conversationId: foreignConversationId };
      },
      counters,
      workflowTransactionFailures,
      setFault(value) { fault = value; },
      setNow(value) { now = new Date(value); },
      setPackVersion(value) { packVersion = value; },
      setReleaseRevision(value) { releaseRevision = value; },
      setBaseImplementationRevision(value) { baseImplementationRevision = value; },
      setValidationPolicyDigest(value) { validationPolicyDigest = value; },
      setLoseClaimCommitResponse(value) { loseClaimCommitResponse = value; },
      setLoseEffectCommitResponse(value) { loseEffectCommitResponse = value; },
      setFailTransactionCall(value, error = new Error('Injected workflow transaction failure before delegation')) {
        failTransactionCall = value; failTransactionError = error; workflowTransactionCalls = 0;
      },
      setWorkflowTransactionBarrier(phase, call) {
        let notifyEntered!: () => void;
        let releaseWaiting!: () => void;
        const entered = new Promise<void>((resolve) => { notifyEntered = resolve; });
        const waiting = new Promise<void>((resolve) => { releaseWaiting = resolve; });
        workflowTransactionCalls = 0;
        transactionBarrier = { call, phase, entered: notifyEntered, waiting };
        return { entered, release: releaseWaiting };
      },
      dispose: async () => fixture.dispose(),
      get executeReader() { return executeReader; },
      get verificationReaders() { return verificationReaders; },
    } as Harness;
  } catch (error) {
    await fixture.dispose();
    throw error;
  }
}

async function withHarness<T>(run: (harness: Awaited<ReturnType<typeof createHarness>>) => Promise<T>): Promise<T> {
  const harness = await createHarness();
  try {
    return await run(harness);
  } finally {
    await harness.dispose();
  }
}

async function rawCount(fixture: Fixture, sql: string, ...values: string[]): Promise<number> {
  const database = fixture.openDatabase();
  try {
    return Number((database.prepare(sql).get(...values) as { count: number }).count);
  } finally {
    database.close();
  }
}

async function disableProfilePermission(store: Fixture['store'], profileId: string): Promise<void> {
  await store.transaction(async (tx) => {
    const profile = await tx.get<Profile>('profiles', profileId);
    if (!profile) throw new Error(`Missing profile ${profileId}`);
    await tx.put('profiles', { ...profile, permissions: [] });
  });
}

async function patchSessionMode(store: Fixture['store'], sessionId: string): Promise<void> {
  await store.transaction(async (tx) => {
    const session = await tx.get<{ id: string; profileId: string; mode: string; modeRevision: number; csrfToken: string; expiresAt: string }>('sessions', sessionId);
    if (!session) throw new Error(`Missing session ${sessionId}`);
    await tx.put('sessions', { ...session, modeRevision: session.modeRevision + 1 });
  });
}

async function disableResponsibility(store: Fixture['store'], responsibilityId: string): Promise<void> {
  await store.workflowTransaction(async (tx) => {
    const responsibility = await tx.get<{ id: string; identityId: string; orgUnitId: string; purpose: 'hr_operations'; branchIds: string[]; active: boolean; rowVersion: number }>('responsibilities', responsibilityId);
    if (!responsibility) throw new Error(`Missing responsibility ${responsibilityId}`);
    const changed = await tx.compareAndSwap('responsibilities', responsibilityId,
      { rowVersion: responsibility.rowVersion, state: 'active' }, {
        ...responsibility, rowVersion: responsibility.rowVersion + 1, active: false,
      });
    if (!changed.updated) throw new Error(`Could not revoke responsibility ${responsibilityId}`);
  });
}

describe('workflow action runner', () => {
  it('uses a new committed reader for verification and preserves historical proof separately from current state', async () => {
    await withHarness(async (harness) => {
      harness.setDiagnosticPhase('prepare');
      const prepared = await harness.prepare().catch((error: unknown) => {
        const cause = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        throw new Error(`Controlled prepare failed (${cause}); private SQLite transaction failures: ${JSON.stringify(harness.workflowTransactionFailures)}; callback counters: ${JSON.stringify(harness.counters)}`);
      });
      const action = prepared.pendingAction;
      expect(action === null).toBe(false);
      harness.setNow('2026-10-03T04:02:00.000Z');
      harness.setDiagnosticPhase('confirm');
      const confirmed = await harness.runner.confirm(harness.sessionId, action!.id, 'runner-confirm-success', operationContextFor(action!));
      expect(confirmed.error, `Private SQLite transaction failures: ${JSON.stringify(harness.workflowTransactionFailures)}; callback counters: ${JSON.stringify(harness.counters)}`).toBeNull();
      expect(confirmed.receipt?.outcome).toBe('verified_success');
      expect(confirmed.receipt?.proofs).toHaveLength(1);
      expect(harness.counters.execute).toBe(1);
      expect(harness.counters.verify).toBe(1);
      expect(harness.verificationReaders).toHaveLength(1);
      expect(harness.verificationReaders[0] === harness.executeReader).toBe(false);
      const task = await harness.store.workflowProjectionReader.get<TaskRow>('onboarding_tasks', harness.taskIds(['hr_welcome'])[0]);
      expect(task?.body).toMatchObject({ status: 'open', executionId: confirmed.receipt?.id, createdAt: '2026-10-03T04:02:00.000Z' });
      expect(confirmed.receipt?.proofs).toMatchObject([{
        ref: { table: 'onboarding_tasks', id: task!.id }, outcome: 'verified_success', observedRowVersion: 1,
      }]);
      expect(confirmed.receipt?.currentStates).toMatchObject([{
        ref: { table: 'onboarding_requests', id: harness.requestId }, state: 'draft', rowVersion: 1,
        completedActions: [{ kind: 'onboarding_tasks_create', executionId: confirmed.receipt?.id }],
      }]);

      await harness.store.workflowTransaction(async (tx) => {
        const current = await tx.get<OnboardingRequest>('onboarding_requests', harness.requestId);
        if (!current) throw new Error('Missing controlled source request');
        const changed = await tx.compareAndSwap('onboarding_requests', current.id,
          { rowVersion: current.rowVersion, state: 'draft' }, {
            ...current, rowVersion: current.rowVersion + 1, state: 'manager_review_pending', updatedAt: '2026-10-03T04:03:00.000Z',
          });
        if (!changed.updated) throw new Error('Could not advance the controlled source request');
      });
      const reconciled = await harness.runner.reconcile(harness.sessionId, confirmed.receipt!.id, 'runner-reconcile-current', operationContextFor(action!));
      expect(reconciled.error).toBeNull();
      expect(reconciled.receipt?.outcome).toBe('verified_success');
      expect(reconciled.receipt?.proofs).toEqual(confirmed.receipt?.proofs);
      expect(reconciled.receipt?.currentStates).toMatchObject([{
        ref: { table: 'onboarding_requests', id: harness.requestId }, state: 'manager_review_pending', rowVersion: 2,
        completedActions: [{ kind: 'onboarding_tasks_create', executionId: confirmed.receipt?.id }],
      }]);
      const unchangedTask = await harness.store.workflowProjectionReader.get<TaskRow>('onboarding_tasks', task!.id);
      expect(unchangedTask?.body).toMatchObject({ status: 'open', rowVersion: 1, executionId: confirmed.receipt?.id });
      const persistedReceipt = await harness.store.workflowProjectionReader.get<WorkflowReceiptV2>('action_executions', confirmed.receipt!.id);
      expect(persistedReceipt?.body.proofs).toEqual(confirmed.receipt?.proofs);
      expect(harness.counters.execute).toBe(1);
    });
  });

  it('reports an unknown post-dispatch commit response as pending and reconciles by readback without replay', async () => {
    await withHarness(async (harness) => {
      const prepared = await harness.prepare();
      harness.setLoseEffectCommitResponse(true);
      const attempted = await harness.runner.confirm(harness.sessionId, prepared.pendingAction!.id, 'runner-lost-response', operationContextFor(prepared.pendingAction!));
      expect(attempted.receipt).toBeNull();
      expect(attempted.error).toMatchObject({
        outcome: 'pending',
        commitCertainty: 'unknown',
        domainEffect: 'unknown',
        retryBusinessWrite: false,
        auditStatus: 'recorded',
      });
      const executionId = attempted.error?.executionId;
      expect(executionId).toBeTruthy();
      expect(harness.counters.execute).toBe(1);
      expect(harness.counters.verify).toBe(0);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM onboarding_tasks WHERE id = ?', harness.taskIds(['hr_welcome'])[0])).toBe(1);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM semantic_effects')).toBe(1);

      const reconciled = await harness.runner.reconcile(harness.sessionId, executionId!, 'runner-readback-existing', operationContextFor(prepared.pendingAction!));
      expect(reconciled.error).toBeNull();
      expect(reconciled.receipt?.outcome).toBe('verified_success');
      expect(reconciled.receipt?.id).toBe(executionId);
      expect(harness.counters.execute).toBe(1);
      expect(harness.counters.verify).toBe(1);
      expect(harness.verificationReaders[0] === harness.executeReader).toBe(false);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM onboarding_tasks WHERE id = ?', harness.taskIds(['hr_welcome'])[0])).toBe(1);
    });
  });

  it('resolves a lost claim response by authorized read only before business execution', async () => {
    await withHarness(async (harness) => {
      const prepared = await harness.prepare();
      const action = prepared.pendingAction!;
      harness.setLoseClaimCommitResponse(true);
      const attempted = await harness.runner.confirm(harness.sessionId, action.id, 'runner-lost-claim-response', operationContextFor(action));
      expect(attempted.receipt).toBeNull();
      expect(attempted.error).toMatchObject({
        outcome: 'pending', operationPhase: 'claim', commitCertainty: 'unknown', domainEffect: 'none', retryBusinessWrite: false,
      });
      expect(attempted.error?.executionId).toEqual(expect.any(String));
      expect(attempted.claimRecovery).toMatchObject({
        actionId: action.id,
        existingExecutionId: attempted.error?.executionId,
        claimCommitCertainty: 'committed',
        retryBusinessWrite: false,
        error: null,
      });
      expect(harness.counters.execute).toBe(0);
      expect(harness.counters.verify).toBe(0);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM onboarding_tasks')).toBe(0);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM semantic_effects')).toBe(0);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM action_confirmations WHERE action_id = ?', action.id)).toBe(1);

      const beforeAuditCount = await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM audit_events');
      const recovered = attempted.claimRecovery!;
      expect(recovered.existingExecutionId).toBe(attempted.error?.executionId);
      const persistedRequest = await harness.store.workflowProjectionReader.get<OnboardingRequest>('onboarding_requests', harness.requestId);
      if (!persistedRequest) throw new Error('Missing controlled request during lost claim recovery');
      expect(persistedRequest.body).toMatchObject({ state: 'draft', rowVersion: 1 });
      expect(recovered.currentStates).toMatchObject([{
        ref: { table: 'onboarding_requests', id: harness.requestId },
        state: persistedRequest.body.state,
        rowVersion: persistedRequest.rowVersion,
      }]);
      expect(recovered.currentStates[0]?.completedActions).toEqual([]);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM audit_events')).toBe(beforeAuditCount);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM onboarding_tasks')).toBe(0);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM semantic_effects')).toBe(0);
      expect(harness.counters.execute).toBe(0);
    });
  });

  it('keeps a lost claim unknown without replay when authorized read only recovery cannot establish it', async () => {
    await withHarness(async (harness) => {
      const prepared = await harness.prepare();
      const action = prepared.pendingAction!;
      harness.setLoseClaimCommitResponse(true);
      harness.setFailTransactionCall(2, new Error('Injected read-only claim recovery failure'));

      const attempted = await harness.runner.confirm(harness.sessionId, action.id,
        'runner-lost-claim-recovery-unavailable', operationContextFor(action));

      expect(attempted.receipt).toBeNull();
      expect(attempted.error).toMatchObject({
        outcome: 'pending', operationPhase: 'claim', commitCertainty: 'unknown', domainEffect: 'none',
        executionId: null, retryBusinessWrite: false,
      });
      expect(attempted.claimRecovery).toMatchObject({
        actionId: action.id,
        existingExecutionId: null,
        claimCommitCertainty: 'unknown',
        currentStates: [],
        retryBusinessWrite: false,
        error: { operationPhase: 'claim', commitCertainty: 'unknown', domainEffect: 'none' },
      });
      expect(harness.counters.execute).toBe(0);
      expect(harness.counters.verify).toBe(0);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM action_confirmations WHERE action_id = ?', action.id)).toBe(1);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM action_executions')).toBe(1);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM onboarding_tasks')).toBe(0);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM semantic_effects')).toBe(0);
    });
  });

  it('closes a recovered unexecuted claim once and requires a fresh explicit review to retry', async () => {
    await withHarness(async (harness) => {
      const original = await harness.prepare();
      const action = original.pendingAction!;
      const earlierSibling = (await harness.prepare()).pendingAction!;
      const sourceBefore = await harness.store.workflowProjectionReader.get<OnboardingRequest>('onboarding_requests', harness.requestId);
      harness.setLoseClaimCommitResponse(true);
      const lost = await harness.runner.confirm(harness.sessionId, action.id, 'runner-close-lost-claim', operationContextFor(action));
      expect(lost.receipt).toBeNull();
      expect(lost.error).toMatchObject({
        outcome: 'pending', operationPhase: 'claim', commitCertainty: 'unknown', domainEffect: 'none',
        executionId: expect.any(String), retryBusinessWrite: false,
      });
      expect(lost.claimRecovery).toMatchObject({
        actionId: action.id, existingExecutionId: lost.error?.executionId, claimCommitCertainty: 'committed',
        retryBusinessWrite: false, error: null,
      });
      expect(harness.counters.execute).toBe(0);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM onboarding_tasks')).toBe(0);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM semantic_effects')).toBe(0);

      const rootsBeforeRecovery = await harness.store.workflowProjectionReader.query<WorkflowRootRow>({
        kind: 'unique', table: 'action_idempotency_roots', constraint: 'action_idempotency_roots_key_unique',
        values: { idempotencyKey: action.idempotencyKey },
      });
      expect(rootsBeforeRecovery).toHaveLength(1);
      const executionId = rootsBeforeRecovery[0].body.activeExecutionId!;
      const actionBeforeRecovery = await harness.store.workflowProjectionReader.get<PendingActionV2>('pending_actions', action.id);
      const receiptBeforeRecovery = await harness.store.workflowProjectionReader.get<WorkflowReceiptV2>('action_executions', executionId);
      const rootBeforeRecovery = rootsBeforeRecovery[0];
      const auditCountBeforeRecovery = await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM audit_events');
      const recovered = await harness.runner.recoverClaim(harness.sessionId, action.id,
        'runner-close-read-only-recovery', operationContextFor(action));
      expect(recovered).toMatchObject({
        actionId: action.id, existingExecutionId: executionId, claimCommitCertainty: 'committed',
        retryBusinessWrite: false, error: null,
      });
      expect(recovered.currentStates).toMatchObject([{
        ref: { table: 'onboarding_requests', id: harness.requestId }, state: 'draft', rowVersion: 1, completedActions: [],
      }]);
      expect(await harness.store.workflowProjectionReader.get<PendingActionV2>('pending_actions', action.id)).toEqual(actionBeforeRecovery);
      expect(await harness.store.workflowProjectionReader.get<WorkflowReceiptV2>('action_executions', executionId)).toEqual(receiptBeforeRecovery);
      expect((await harness.store.workflowProjectionReader.query<WorkflowRootRow>({
        kind: 'unique', table: 'action_idempotency_roots', constraint: 'action_idempotency_roots_key_unique',
        values: { idempotencyKey: action.idempotencyKey },
      }))[0]).toEqual(rootBeforeRecovery);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM audit_events')).toBe(auditCountBeforeRecovery);
      expect(harness.counters.execute).toBe(0);
      expect(harness.counters.verify).toBe(0);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM onboarding_tasks')).toBe(0);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM semantic_effects')).toBe(0);

      const closed = await harness.runner.closeUnexecutedClaim(harness.sessionId, action.id,
        'runner-close-unexecuted-claim', operationContextFor(action));
      expect(closed.receipt).toMatchObject({ id: executionId, actionId: action.id, outcome: 'failed' });
      expect(closed.error).toMatchObject({
        code: 'WORKFLOW_STALE', outcome: 'stale', actionId: action.id, executionId,
        commitCertainty: 'definitely_not_committed', domainEffect: 'none', auditStatus: 'recorded',
        nextStep: 'refresh_review', retryBusinessWrite: false,
      });
      const closedAction = await harness.store.workflowProjectionReader.get<PendingActionV2>('pending_actions', action.id);
      expect(closedAction?.body.status).toBe('stale');
      const closedReceipt = await harness.store.workflowProjectionReader.get<WorkflowReceiptV2>('action_executions', executionId);
      expect(closedReceipt?.body.outcome).toBe('failed');
      const closedRoot = (await harness.store.workflowProjectionReader.query<WorkflowRootRow>({
        kind: 'unique', table: 'action_idempotency_roots', constraint: 'action_idempotency_roots_key_unique',
        values: { idempotencyKey: action.idempotencyKey },
      }))[0];
      expect(closedRoot.body).toMatchObject({ status: 'open', activeExecutionId: executionId });
      expect(closedRoot.rowVersion).toBe(rootBeforeRecovery.rowVersion + 1);
      expect(await rawCount(harness.fixture,
        'SELECT COUNT(*) AS count FROM audit_events WHERE category = ? AND action_id = ?', 'workflow_claim_close', action.id)).toBe(1);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM onboarding_tasks')).toBe(0);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM semantic_effects')).toBe(0);
      expect(await harness.store.workflowProjectionReader.get<OnboardingRequest>('onboarding_requests', harness.requestId)).toEqual(sourceBefore);

      const actionVersionBeforeDuplicateClose = closedAction?.rowVersion;
      const receiptVersionBeforeDuplicateClose = closedReceipt?.rowVersion;
      const duplicateClose = await harness.runner.closeUnexecutedClaim(harness.sessionId, action.id,
        'runner-close-unexecuted-claim-duplicate', operationContextFor(action));
      expect(duplicateClose.receipt).toMatchObject({ id: executionId, outcome: 'failed' });
      expect(await harness.store.workflowProjectionReader.get<PendingActionV2>('pending_actions', action.id)).toMatchObject({
        rowVersion: actionVersionBeforeDuplicateClose,
      });
      expect(await harness.store.workflowProjectionReader.get<WorkflowReceiptV2>('action_executions', executionId)).toMatchObject({
        rowVersion: receiptVersionBeforeDuplicateClose,
      });
      expect(await rawCount(harness.fixture,
        'SELECT COUNT(*) AS count FROM audit_events WHERE category = ? AND action_id = ?', 'workflow_claim_close', action.id)).toBe(1);
      const historical = await harness.runner.reconcile(harness.sessionId, executionId,
        'runner-close-historical-readback', operationContextFor(action));
      expect(historical.error).toBeNull();
      expect(historical.receipt).toMatchObject({ id: executionId, outcome: 'failed' });

      const staleSibling = await harness.runner.confirm(harness.sessionId, earlierSibling.id,
        'runner-close-earlier-sibling', operationContextFor(earlierSibling));
      expect(staleSibling.receipt).toBeNull();
      expect(staleSibling.error).toMatchObject({ outcome: 'stale', domainEffect: 'none', retryBusinessWrite: false });
      expect(harness.counters.execute).toBe(0);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM onboarding_tasks')).toBe(0);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM semantic_effects')).toBe(0);

      const fresh = await harness.prepare();
      expect(fresh.outcome).toBe('pending');
      expect(fresh.pendingAction?.id).not.toBe(action.id);
      expect(fresh.pendingAction?.id).not.toBe(earlierSibling.id);
      expect(fresh.pendingAction?.createdAt).toBe(action.createdAt);
      const second = await harness.runner.confirm(harness.sessionId, fresh.pendingAction!.id,
        'runner-close-fresh-explicit-confirm', operationContextFor(fresh.pendingAction!));
      expect(second.receipt?.outcome).toBe('verified_success');
      expect(second.receipt?.id).not.toBe(executionId);
      expect(harness.counters.execute).toBe(1);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM onboarding_tasks')).toBe(1);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM semantic_effects')).toBe(1);
      expect(await harness.store.workflowProjectionReader.get<OnboardingRequest>('onboarding_requests', harness.requestId)).toEqual(sourceBefore);
      const db = harness.fixture.openDatabase();
      try {
        const attempts = db.prepare('SELECT attempt FROM action_executions WHERE root_id = ? ORDER BY attempt')
          .all(closedRoot.id) as Array<{ attempt: number }>;
        expect(attempts).toHaveLength(2);
        expect(attempts.every(({ attempt }) => Number.isInteger(attempt) && attempt > 0)).toBe(true);
        expect(new Set(attempts.map(({ attempt }) => attempt)).size).toBe(2);
        expect(attempts[1].attempt).toBeGreaterThan(attempts[0].attempt);
      } finally {
        db.close();
      }
    });
  });

  it('denies close recovery from another actor, session, conversation, or turn without revealing the execution id', async () => {
    await withHarness(async (harness) => {
      const prepared = await harness.prepare();
      const action = prepared.pendingAction!;
      harness.setLoseClaimCommitResponse(true);
      const lost = await harness.runner.confirm(harness.sessionId, action.id,
        'runner-close-auth-lost-claim', operationContextFor(action));
      expect(lost.error?.outcome).toBe('pending');
      const recovered = await harness.runner.recoverClaim(harness.sessionId, action.id,
        'runner-close-auth-readback', operationContextFor(action));
      expect(recovered.existingExecutionId).toBeTruthy();
      const alternate = await harness.addOwnedContext();
      const foreign = await harness.addForeignActorContext();
      const operation = operationContextFor(action);
      const deniedCalls = [
        { sessionId: foreign.sessionId, context: { conversationId: foreign.conversationId, turnId: action.turnId }, name: 'actor' },
        { sessionId: alternate.sessionId, context: operation, name: 'session' },
        { sessionId: harness.sessionId, context: { ...operation, conversationId: alternate.conversationId }, name: 'conversation' },
        { sessionId: harness.sessionId, context: { ...operation, turnId: `${action.turnId}-different` }, name: 'turn' },
      ];

      for (const attempt of deniedCalls) {
        const denied = await harness.runner.closeUnexecutedClaim(attempt.sessionId, action.id,
          `runner-close-wrong-${attempt.name}`, attempt.context);
        expect(denied.receipt).toBeNull();
        expect(denied.error).toMatchObject({
          code: 'WORKFLOW_NOT_FOUND', outcome: 'denied', executionId: null, currentStates: [], retryBusinessWrite: false,
        });
        expect(denied.error?.executionId).toBeNull();
        expect(await rawCount(harness.fixture,
          'SELECT COUNT(*) AS count FROM audit_events WHERE category = ? AND action_id = ?', 'workflow_claim_close', action.id)).toBe(0);
      }

      const stillClaimed = await harness.store.workflowProjectionReader.get<PendingActionV2>('pending_actions', action.id);
      const stillPending = await harness.store.workflowProjectionReader.get<WorkflowReceiptV2>('action_executions', recovered.existingExecutionId!);
      expect(stillClaimed?.body.status).toBe('claimed');
      expect(stillPending?.body.outcome).toBe('pending');
      expect(harness.counters.execute).toBe(0);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM onboarding_tasks')).toBe(0);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM semantic_effects')).toBe(0);
    });
  });

  it('lets a close CAS win before the effect transaction and fences the in-flight confirmation', async () => {
    await withHarness(async (harness) => {
      const prepared = await harness.prepare();
      const action = prepared.pendingAction!;
      const sourceBefore = await harness.store.workflowProjectionReader.get<OnboardingRequest>('onboarding_requests', harness.requestId);
      const barrier = harness.setWorkflowTransactionBarrier('before', 2);
      const confirming = harness.runner.confirm(harness.sessionId, action.id,
        'runner-close-wins-confirm', operationContextFor(action));
      await barrier.entered;
      const closed = await harness.runner.closeUnexecutedClaim(harness.sessionId, action.id,
        'runner-close-wins-cas', operationContextFor(action));
      expect(closed.receipt).toMatchObject({ actionId: action.id, outcome: 'failed' });
      expect(closed.error).toMatchObject({ outcome: 'stale', domainEffect: 'none', commitCertainty: 'definitely_not_committed' });
      expect(harness.counters.execute).toBe(0);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM onboarding_tasks')).toBe(0);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM semantic_effects')).toBe(0);

      barrier.release();
      const fenced = await confirming;
      expect(fenced.receipt).toBeNull();
      expect(fenced.error).toMatchObject({ outcome: 'stale', operationPhase: 'effect', domainEffect: 'none', retryBusinessWrite: false });
      const deniedAudits = await harness.store.workflowProjectionReader.query<{ category: string; targetRefs?: Ref[] }>({
        kind: 'scoped', table: 'audit_events',
        equals: { category: 'workflow_denied', correlationId: 'runner-close-wins-confirm' },
      });
      expect(deniedAudits).toHaveLength(1);
      expect(deniedAudits[0].body.targetRefs).toEqual(action.targets.map((target) => target.ref));
      const currentAction = await harness.store.workflowProjectionReader.get<PendingActionV2>('pending_actions', action.id);
      expect(currentAction?.body.status).toBe('stale');
      const root = (await harness.store.workflowProjectionReader.query<WorkflowRootRow>({
        kind: 'unique', table: 'action_idempotency_roots', constraint: 'action_idempotency_roots_key_unique',
        values: { idempotencyKey: action.idempotencyKey },
      }))[0];
      expect(root.body).toMatchObject({ status: 'open', activeExecutionId: closed.receipt?.id });
      expect(await rawCount(harness.fixture,
        'SELECT COUNT(*) AS count FROM audit_events WHERE category = ? AND action_id = ?', 'workflow_claim_close', action.id)).toBe(1);
      expect(await harness.store.workflowProjectionReader.get<OnboardingRequest>('onboarding_requests', harness.requestId)).toEqual(sourceBefore);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM onboarding_tasks')).toBe(0);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM semantic_effects')).toBe(0);
    });
  });

  it('does not let a close mark failure after the effect transaction has committed', async () => {
    await withHarness(async (harness) => {
      const prepared = await harness.prepare();
      const action = prepared.pendingAction!;
      const barrier = harness.setWorkflowTransactionBarrier('after', 2);
      const confirming = harness.runner.confirm(harness.sessionId, action.id,
        'runner-effect-wins-confirm', operationContextFor(action));
      await barrier.entered;
      expect(harness.counters.execute).toBe(1);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM onboarding_tasks')).toBe(1);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM semantic_effects')).toBe(1);

      const closeAttempt = await harness.runner.closeUnexecutedClaim(harness.sessionId, action.id,
        'runner-effect-wins-close', operationContextFor(action));
      expect(closeAttempt.receipt?.outcome).not.toBe('failed');
      if (closeAttempt.error) {
        expect(closeAttempt.error.commitCertainty).not.toBe('definitely_not_committed');
        expect(closeAttempt.error.domainEffect).not.toBe('none');
      }
      const root = (await harness.store.workflowProjectionReader.query<WorkflowRootRow>({
        kind: 'unique', table: 'action_idempotency_roots', constraint: 'action_idempotency_roots_key_unique',
        values: { idempotencyKey: action.idempotencyKey },
      }))[0];
      expect(root.body.status).toBe('completed');
      const pendingReceipt = await harness.store.workflowProjectionReader.get<WorkflowReceiptV2>(
        'action_executions', root.body.activeExecutionId!);
      expect(pendingReceipt?.body.outcome).not.toBe('failed');
      expect(pendingReceipt?.body.outcome).not.toBe('stale');
      const currentAction = await harness.store.workflowProjectionReader.get<PendingActionV2>('pending_actions', action.id);
      expect(currentAction?.body.status).not.toBe('stale');
      expect(await rawCount(harness.fixture,
        'SELECT COUNT(*) AS count FROM audit_events WHERE category = ? AND action_id = ?', 'workflow_claim_close', action.id)).toBe(0);

      barrier.release();
      const confirmed = await confirming;
      expect(confirmed.error).toBeNull();
      expect(confirmed.receipt).toMatchObject({ id: root.body.activeExecutionId, outcome: 'verified_success' });
      expect(harness.counters.execute).toBe(1);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM onboarding_tasks')).toBe(1);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM semantic_effects')).toBe(1);
    });
  });

  it('rejects same-profile requests with a different session, conversation, or turn without disclosing state', async () => {
    await withHarness(async (harness) => {
      const prepared = await harness.prepare();
      const action = prepared.pendingAction!;
      const ownedAlternate = await harness.addOwnedContext();
      const originalContext = operationContextFor(action);
      const invalidConfirmations = [
        { sessionId: harness.sessionId, context: { ...originalContext, conversationId: ownedAlternate.conversationId }, tag: 'conversation' },
        { sessionId: harness.sessionId, context: { ...originalContext, turnId: `${action.turnId}-other` }, tag: 'turn' },
        { sessionId: ownedAlternate.sessionId, context: originalContext, tag: 'session' },
      ];
      for (const attempt of invalidConfirmations) {
        const denied = await harness.runner.confirm(attempt.sessionId,
          action.id, `runner-context-confirm-${attempt.tag}`, attempt.context);
        expect(denied.receipt).toBeNull();
        expect(denied.error).toMatchObject({ code: 'WORKFLOW_NOT_FOUND', domainEffect: 'none', executionId: null, currentStates: [] });
        expect(harness.counters.execute).toBe(0);
        expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM action_executions')).toBe(0);
        expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM onboarding_tasks')).toBe(0);
      }
      const currentAction = await harness.store.workflowProjectionReader.get<PendingActionV2>('pending_actions', action.id);
      expect(currentAction?.body.status).toBe('pending');
      const deniedRecovery = await harness.runner.recoverClaim(
        ownedAlternate.sessionId, action.id, 'runner-context-recover-session', originalContext,
      );
      expect(deniedRecovery).toMatchObject({ existingExecutionId: null, currentStates: [], retryBusinessWrite: false });
      expect(deniedRecovery.error?.code).toBe('WORKFLOW_NOT_FOUND');

      const confirmed = await harness.runner.confirm(harness.sessionId, action.id, 'runner-context-correct-confirm', originalContext);
      expect(confirmed.receipt?.outcome).toBe('verified_success');
      const wrongTurnReadback = await harness.runner.reconcile(harness.sessionId, confirmed.receipt!.id,
        'runner-context-wrong-turn-read', { ...originalContext, turnId: `${action.turnId}-other` });
      expect(wrongTurnReadback.receipt).toBeNull();
      expect(wrongTurnReadback.error?.code).toBe('WORKFLOW_NOT_FOUND');
      expect(wrongTurnReadback.error?.currentStates).toEqual([]);
      const wrongSessionReadback = await harness.runner.reconcile(ownedAlternate.sessionId, confirmed.receipt!.id,
        'runner-context-wrong-session-read', originalContext);
      expect(wrongSessionReadback.receipt).toBeNull();
      expect(wrongSessionReadback.error?.code).toBe('WORKFLOW_NOT_FOUND');
      expect(wrongSessionReadback.error?.currentStates).toEqual([]);
      const correctReadback = await harness.runner.reconcile(harness.sessionId, confirmed.receipt!.id,
        'runner-context-correct-read', originalContext);
      expect(correctReadback.receipt?.outcome).toBe('verified_success');
      expect(harness.counters.execute).toBe(1);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM onboarding_tasks')).toBe(1);
    });
  });

  it('does not disclose or claim an operation under the same actor’s different session, conversation, or turn', async () => {
    await withHarness(async (harness) => {
      const prepared = await harness.prepare();
      const action = prepared.pendingAction!;
      const alternate = await harness.addOwnedContext();
      const operation = operationContextFor(action);
      const invalidCalls = [
        { sessionId: harness.sessionId, context: { ...operation, conversationId: alternate.conversationId }, correlationId: 'runner-wrong-conversation' },
        { sessionId: harness.sessionId, context: { ...operation, turnId: 'runner-different-turn' }, correlationId: 'runner-wrong-turn' },
        { sessionId: alternate.sessionId, context: operation, correlationId: 'runner-wrong-session' },
      ];
      for (const attempt of invalidCalls) {
        const denied = await harness.runner.confirm(attempt.sessionId, action.id, attempt.correlationId, attempt.context);
        expect(denied.receipt).toBeNull();
        expect(denied.error).toMatchObject({ code: 'WORKFLOW_NOT_FOUND', domainEffect: 'none', executionId: null, currentStates: [] });
        expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM action_executions')).toBe(0);
        expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM onboarding_tasks')).toBe(0);
        expect(harness.counters.execute).toBe(0);
      }
      const wrongContextRecovery = await harness.runner.recoverClaim(
        alternate.sessionId, action.id, 'runner-wrong-session-recovery', operation,
      );
      expect(wrongContextRecovery.existingExecutionId).toBeNull();
      expect(wrongContextRecovery.currentStates).toEqual([]);
      expect(wrongContextRecovery.error?.code).toBe('WORKFLOW_NOT_FOUND');

      const confirmed = await harness.runner.confirm(harness.sessionId, action.id, 'runner-correct-operation', operation);
      expect(confirmed.receipt?.outcome).toBe('verified_success');
      const wrongTurnReadback = await harness.runner.reconcile(harness.sessionId, confirmed.receipt!.id,
        'runner-wrong-turn-readback', { ...operation, turnId: 'runner-different-turn' });
      expect(wrongTurnReadback.receipt).toBeNull();
      expect(wrongTurnReadback.error?.code).toBe('WORKFLOW_NOT_FOUND');
      expect(wrongTurnReadback.error?.currentStates).toEqual([]);
      const wrongSessionReadback = await harness.runner.reconcile(alternate.sessionId, confirmed.receipt!.id,
        'runner-wrong-session-readback', operation);
      expect(wrongSessionReadback.receipt).toBeNull();
      expect(wrongSessionReadback.error?.code).toBe('WORKFLOW_NOT_FOUND');
      expect(wrongSessionReadback.error?.currentStates).toEqual([]);
      const correctReadback = await harness.runner.reconcile(harness.sessionId, confirmed.receipt!.id,
        'runner-correct-readback', operation);
      expect(correctReadback.receipt?.outcome).toBe('verified_success');
      expect(harness.counters.execute).toBe(1);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM onboarding_tasks')).toBe(1);
    });
  });

  it('converges duplicate confirmations on one semantic winner', async () => {
    await withHarness(async (harness) => {
      const prepared = await harness.prepare();
      const actionId = prepared.pendingAction!.id;
      const action = prepared.pendingAction!;
      const results = await Promise.all([
        harness.runner.confirm(harness.sessionId, actionId, 'runner-duplicate-one', operationContextFor(action)),
        harness.runner.confirm(harness.sessionId, actionId, 'runner-duplicate-two', operationContextFor(action)),
      ]);
      expect(harness.counters.execute).toBe(1);
      const executionIds = results.flatMap((result) => result.receipt ? [result.receipt.id] : result.error?.executionId ? [result.error.executionId] : []);
      expect(new Set(executionIds).size).toBe(1);
      const reconciled = await harness.runner.reconcile(harness.sessionId, executionIds[0], 'runner-duplicate-final-read', operationContextFor(action));
      expect(reconciled.receipt?.outcome).toBe('verified_success');
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM onboarding_tasks WHERE id = ?', harness.taskIds(['hr_welcome'])[0])).toBe(1);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM semantic_effects')).toBe(1);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM action_executions')).toBe(1);
    });
  });

  it('resolves a concurrent first-claim conflict to the winning execution with no second effect', async () => {
    await withHarness(async (harness) => {
      const firstPreview = await harness.prepare(['hr_welcome']);
      const secondPreview = await harness.prepare(['hr_welcome']);
      const firstAction = firstPreview.pendingAction!;
      const secondAction = secondPreview.pendingAction!;
      expect(firstAction.id !== secondAction.id).toBe(true);
      const results = await Promise.all([
        harness.runner.confirm(harness.sessionId, firstAction.id, 'runner-first-root-claim-one', operationContextFor(firstAction)),
        harness.runner.confirm(harness.sessionId, secondAction.id, 'runner-first-root-claim-two', operationContextFor(secondAction)),
      ]);
      expect(harness.counters.execute).toBe(1);
      const executionIds = results.flatMap((result) => [
        ...(result.receipt ? [result.receipt.id] : []),
        ...(result.claimRecovery?.existingExecutionId ? [result.claimRecovery.existingExecutionId] : []),
      ]);
      expect(executionIds.length).toBeGreaterThan(0);
      expect(new Set(executionIds).size).toBe(1);
      const winnerId = executionIds[0];
      expect(results.some((result) => result.claimRecovery?.existingExecutionId === winnerId)).toBe(true);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM action_executions')).toBe(1);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM semantic_effects')).toBe(1);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM onboarding_tasks')).toBe(1);
    });
  });

  it('resolves a definite first-claim conflict by reading the real winning root without replay', async () => {
    await withHarness(async (harness) => {
      const firstPreview = await harness.prepare(['hr_welcome']);
      const losingPreview = await harness.prepare(['hr_welcome']);
      const winnerAction = firstPreview.pendingAction!;
      const losingAction = losingPreview.pendingAction!;
      const winner = await harness.runner.confirm(harness.sessionId, winnerAction.id,
        'runner-root-winner', operationContextFor(winnerAction));
      expect(winner.receipt?.outcome).toBe('verified_success');
      harness.setFault('none');

      const conflict = Object.assign(new DomainError('WORKFLOW_CONFLICT', 'Injected definite claim conflict', 409), {
        definitelyNotCommitted: true,
      });
      harness.setFailTransactionCall(1, conflict);
      const loser = await harness.runner.confirm(harness.sessionId, losingAction.id,
        'runner-root-conflict-loser', operationContextFor(losingAction));
      expect(loser.receipt).toBeNull();
      expect(loser.error).toMatchObject({
        operationPhase: 'claim', commitCertainty: 'definitely_not_committed', domainEffect: 'none', retryBusinessWrite: false,
      });
      expect(loser.claimRecovery).toMatchObject({
        actionId: losingAction.id,
        existingExecutionId: winner.receipt?.id,
        retryBusinessWrite: false,
        error: null,
      });
      expect(harness.counters.execute).toBe(1);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM action_executions')).toBe(1);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM semantic_effects')).toBe(1);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM onboarding_tasks')).toBe(1);
    });
  });

  it('keeps an overlapping semantic target single-winner across separately prepared batches', async () => {
    await withHarness(async (harness) => {
      const narrow = await harness.prepare(['hr_welcome']);
      const wider = await harness.prepare(['hr_welcome', 'it_setup_request']);
      const narrowAction = narrow.pendingAction!;
      const widerAction = wider.pendingAction!;
      const results = await Promise.all([
        harness.runner.confirm(harness.sessionId, narrowAction.id, 'runner-overlap-narrow', operationContextFor(narrowAction)),
        harness.runner.confirm(harness.sessionId, widerAction.id, 'runner-overlap-wide', operationContextFor(widerAction)),
      ]);
      expect(harness.counters.execute).toBe(1);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM onboarding_tasks WHERE id = ?', harness.taskIds(['hr_welcome'])[0])).toBe(1);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM onboarding_tasks WHERE id = ?', harness.taskIds(['it_setup_request'])[0])).toBeLessThanOrEqual(1);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM semantic_effects')).toBeGreaterThan(0);
      const db = harness.fixture.openDatabase();
      try {
        const duplicateSemanticKeys = db.prepare(
          'SELECT semantic_key, COUNT(*) AS count FROM semantic_effects GROUP BY semantic_key HAVING COUNT(*) > 1',
        ).all();
        expect(duplicateSemanticKeys).toEqual([]);
        const verified = db.prepare('SELECT id FROM action_executions WHERE outcome = ?').all('verified_success') as Array<{ id: string }>;
        expect(verified).toHaveLength(1);
      } finally {
        db.close();
      }
      const executionIds = results.flatMap((result) => result.receipt ? [result.receipt.id] : result.error?.executionId ? [result.error.executionId] : []);
      expect(executionIds.length).toBeGreaterThan(0);
    });
  });

  it('rejects missing, corrupt, or callback-substituted current policy pins before creating an action', async () => {
    for (const policyMode of ['missing', 'wrong_digest'] as const) {
      const harness = await createHarness({ policyMode });
      try {
        const prepared = await harness.prepare();
        expect(prepared.outcome).toBe('stale');
        expect(prepared.pendingAction).toBeNull();
        expect(harness.counters.validate).toBe(0);
        expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM pending_actions')).toBe(0);
      } finally {
        await harness.dispose();
      }
    }

    await withHarness(async (harness) => {
      harness.setValidationPolicyDigest('c'.repeat(64));
      const prepared = await harness.prepare();
      expect(prepared.outcome).toBe('stale');
      expect(prepared.pendingAction).toBeNull();
      expect(harness.counters.validate).toBe(1);
      expect(harness.counters.execute).toBe(0);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM pending_actions')).toBe(0);
    });
  });

  it('allows a new unique root attempt only after a known rollback and refreshed approval', async () => {
    await withHarness(async (harness) => {
      harness.setFault('throw_after_first_write');
      const first = await harness.prepare();
      const failed = await harness.runner.confirm(harness.sessionId, first.pendingAction!.id, 'runner-known-rollback', operationContextFor(first.pendingAction!));
      expect(failed.receipt).toBeNull();
      expect(failed.error).toMatchObject({
        outcome: 'failed', commitCertainty: 'definitely_not_committed', domainEffect: 'none', retryBusinessWrite: false,
      });
      expect(harness.counters.execute).toBe(1);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM onboarding_tasks')).toBe(0);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM semantic_effects')).toBe(0);

      harness.setFault('none');
      const refreshed = await harness.prepare();
      expect(refreshed.outcome).toBe('pending');
      const succeeded = await harness.runner.confirm(harness.sessionId, refreshed.pendingAction!.id, 'runner-retry-new-preview', operationContextFor(refreshed.pendingAction!));
      expect(succeeded.receipt?.outcome).toBe('verified_success');
      const roots = await harness.store.workflowProjectionReader.query<{ id: string; idempotencyKey: string; status: string }>({
        kind: 'unique', table: 'action_idempotency_roots', constraint: 'action_idempotency_roots_key_unique',
        values: { idempotencyKey: refreshed.pendingAction!.idempotencyKey },
      });
      expect(roots).toHaveLength(1);
      expect(roots[0].rowVersion).toBe(3);
      const db = harness.fixture.openDatabase();
      try {
        const attempts = db.prepare('SELECT attempt FROM action_executions WHERE root_id = ? ORDER BY attempt').all(roots[0].id) as Array<{ attempt: number }>;
        expect(attempts.map((row) => row.attempt)).toEqual([1, 2]);
      } finally {
        db.close();
      }
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM action_executions')).toBe(2);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM onboarding_tasks')).toBe(1);
    });
  });

  it('commits both staged siblings for a valid callback result', async () => {
    await withHarness(async (harness) => {
      const prepared = await harness.prepare(['hr_welcome', 'it_setup_request']);
      const confirmed = await harness.runner.confirm(harness.sessionId, prepared.pendingAction!.id, 'runner-valid-baseline', operationContextFor(prepared.pendingAction!));
      expect(confirmed.error).toBeNull();
      expect(confirmed.receipt?.outcome).toBe('verified_success');
      expect(harness.counters.execute).toBe(1);
      expect(harness.counters.stagedWrites).toBe(2);
      for (const templateId of ['hr_welcome', 'it_setup_request'] as const) {
        const task = await harness.store.workflowProjectionReader.get<TaskRow>('onboarding_tasks', harness.taskIds([templateId])[0]);
        expect(task?.body).toMatchObject({
          requestId: harness.requestId,
          employeeId: harness.employeeId,
          ownerIdentityId: harness.identityId,
          templateId,
          status: 'open',
          dueDate: '2026-10-06',
          title: taskTitle(templateId),
          executionId: confirmed.receipt?.id,
          createdAt: NOW,
        });
      }
    });
  });

  const callbackResultFaults: Fault[] = [
    'missing', 'extra', 'duplicate', 'wrong_ref', 'wrong_execution', 'wrong_version', 'wrong_due_date', 'wrong_employee', 'throw_after_first_write',
  ];

  it.each(callbackResultFaults)('rolls back every staged sibling and runtime record for %s callback violation', async (fault) => {
    await withHarness(async (harness) => {
      harness.setFault(fault);
      const prepared = await harness.prepare(['hr_welcome', 'it_setup_request']);
      const action = prepared.pendingAction!;
      const result = await harness.runner.confirm(harness.sessionId, action.id, `runner-fault-${fault}`, operationContextFor(action));
      expect(result.receipt).toBeNull();
      expect(result.error?.outcome).toBe('failed');
      expect(['WORKFLOW_CALLBACK_CONTRACT', 'WORKFLOW_FAILED']).toContain(result.error?.code);
      expect(result.error?.commitCertainty).toBe('definitely_not_committed');
      expect(harness.counters.execute).toBe(1);
      expect(harness.counters.stagedWrites, fault).toBe(fault === 'throw_after_first_write' ? 1 : 2);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM onboarding_tasks')).toBe(0);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM semantic_effects')).toBe(0);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM action_targets')).toBe(0);
      expect(await rawCount(harness.fixture,
        'SELECT COUNT(*) AS count FROM audit_events WHERE category = ? AND execution_id = ?', 'workflow_execute', result.error!.executionId!)).toBe(0);
      const request = await harness.store.workflowProjectionReader.get<OnboardingRequest>('onboarding_requests', harness.requestId);
      expect(request?.body).toMatchObject({ state: 'draft', rowVersion: 1, directorApprovalEventId: null });
    });
  });

  it('rechecks current authority, mode, pins, release revision, and exact expiry before claiming', async () => {
    const scenarios: Array<{
      name: string;
      expectedOutcome: 'denied' | 'stale';
      mutate(harness: Awaited<ReturnType<typeof createHarness>>, action: PendingActionV2): Promise<void> | void;
    }> = [
      { name: 'profile permission', expectedOutcome: 'denied', mutate: (h) => disableProfilePermission(h.store, h.profileId) },
      { name: 'responsibility scope', expectedOutcome: 'denied', mutate: (h) => disableResponsibility(h.store, h.responsibilityId) },
      { name: 'session mode revision', expectedOutcome: 'stale', mutate: (h) => patchSessionMode(h.store, h.sessionId) },
      { name: 'pack pin', expectedOutcome: 'stale', mutate: (h) => h.setPackVersion('2.0') },
      { name: 'workflow-v2 base implementation pin', expectedOutcome: 'stale', mutate: (h) => h.setBaseImplementationRevision('runner-test-base-r2') },
      { name: 'release revision', expectedOutcome: 'stale', mutate: (h) => h.setReleaseRevision('workflow-runner-test-release-r2') },
      { name: 'action expiry boundary', expectedOutcome: 'stale', mutate: (h, action) => h.setNow(action.expiresAt) },
    ];
    for (const scenario of scenarios) {
      await withHarness(async (harness) => {
        const prepared = await harness.prepare();
        await scenario.mutate(harness, prepared.pendingAction!);
        const result = await harness.runner.confirm(harness.sessionId, prepared.pendingAction!.id, `runner-stale-${scenario.name.replaceAll(' ', '-')}`, operationContextFor(prepared.pendingAction!));
        expect(result.receipt, scenario.name).toBeNull();
        expect(result.error?.outcome, scenario.name).toBe(scenario.expectedOutcome);
        expect(result.error?.retryBusinessWrite, scenario.name).toBe(false);
        expect(harness.counters.execute, scenario.name).toBe(0);
        expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM action_executions'), scenario.name).toBe(0);
        expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM onboarding_tasks'), scenario.name).toBe(0);
      });
    }
  });

  it('records authorization denial outside the failed claim and returns unverified audit status when that audit fails', async () => {
    await withHarness(async (harness) => {
      const prepared = await harness.prepare();
      await disableProfilePermission(harness.store, harness.profileId);
      const result = await harness.runner.confirm(harness.sessionId, prepared.pendingAction!.id, 'runner-denial-audit-recorded', operationContextFor(prepared.pendingAction!));
      expect(result.receipt).toBeNull();
      expect(result.error).toMatchObject({ outcome: 'denied', auditStatus: 'recorded', retryBusinessWrite: false });
      expect(harness.counters.execute).toBe(0);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM action_executions')).toBe(0);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM semantic_effects')).toBe(0);
      expect(await rawCount(harness.fixture,
        'SELECT COUNT(*) AS count FROM audit_events WHERE category = ? AND actor_id = ?', 'workflow_denied', harness.profileId)).toBe(1);
      const deniedAudits = await harness.store.workflowProjectionReader.query<{ category: string; targetRefs?: Ref[] }>({
        kind: 'scoped', table: 'audit_events',
        equals: { category: 'workflow_denied', correlationId: 'runner-denial-audit-recorded' },
      });
      expect(deniedAudits).toHaveLength(1);
      expect(Object.hasOwn(deniedAudits[0].body, 'targetRefs')).toBe(false);
      const action = await harness.store.workflowProjectionReader.get<PendingActionV2>('pending_actions', prepared.pendingAction!.id);
      expect(action?.body.status).toBe('pending');
    });

    await withHarness(async (harness) => {
      const prepared = await harness.prepare();
      await disableProfilePermission(harness.store, harness.profileId);
      harness.setFailTransactionCall(2);
      const result = await harness.runner.confirm(harness.sessionId, prepared.pendingAction!.id, 'runner-denial-audit-failure', operationContextFor(prepared.pendingAction!));
      expect(result.receipt).toBeNull();
      expect(result.error).toMatchObject({ outcome: 'denied', auditStatus: 'unverified', retryBusinessWrite: false });
      expect(harness.counters.execute).toBe(0);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM action_executions')).toBe(0);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM semantic_effects')).toBe(0);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM audit_events WHERE category = ?', 'workflow_denied')).toBe(0);
      const action = await harness.store.workflowProjectionReader.get<PendingActionV2>('pending_actions', prepared.pendingAction!.id);
      expect(action?.body.status).toBe('pending');
    });
  });
});
