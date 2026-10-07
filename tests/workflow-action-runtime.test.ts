import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Profile } from '../lib/contracts';
import { digest } from '../lib/core/utils';
import { createWorkflowActionRunner } from '../lib/workflows/action-runner';
import { createWorkflowActionRuntime, defineWorkflowBinding, type RuntimeReadContext, type WorkflowRuntimeBinding, type WorkflowRuntimeOptions, workflowApprovalHash } from '../lib/workflows/action-runtime';
import { getWorkflowActionAuthority } from '../lib/workflows/action-authority';
import { WorkflowOperationError, type WorkflowOperationContext } from '../lib/workflows/action-results';
import { getDemoWorkflowPolicyV1Pin, demoWorkflowPolicyV1 } from '../lib/workflows/policy';
import type {
  CurrentState,
  ExpectedRow,
  GuardedTransaction,
  OnboardingRequest,
  PendingActionV2,
  PreparationResult,
  Ref,
  ReviewSnapshot,
  TargetProof,
  WorkflowPayloadV2,
  WorkflowStorageTable,
} from '../lib/workflows/contracts';
import { workflowSnapshotDigest } from '../lib/workflows/action-runtime';
import { createWorkflowSqliteFixture } from './helpers/workflow-storage';

// These controlled callbacks exercise the generic runtime boundary against real SQLite rows; they do not prove catalog business coverage.
const NOW = '2026-10-03T04:00:00.000Z';
const PERMISSION = 'hr.onboarding.director_approve';
const PACK_ID = 'hr';
const PACK_DIGEST = 'a'.repeat(64);
const RELEASE = 'workflow-runtime-test-release-r1';

type Fixture = Awaited<ReturnType<typeof createWorkflowSqliteFixture>>;
type SqliteStore = Fixture['store'];
type ApprovalPayload = Extract<WorkflowPayloadV2, { kind: 'onboarding_director_approve' }>;
type ApprovalEvent = {
  id: string;
  rowVersion: number;
  requestId: string;
  actorIdentityId: string;
  stage: string;
  lifecycleId: string;
  executionId?: string;
  decision: string;
  reason?: string;
  createdAt: string;
};
type RequestRow = OnboardingRequest;
type CallbackRegistration = 'direct' | 'wrapped' | 'rewrapped';
type ReceiverSensitiveCallback = 'identify' | 'validate' | 'executeAtomic';
type WorkflowCallbackName = 'identify' | 'expectedPostconditions' | 'validate' | 'executeAtomic' | 'verify' | 'currentStates';
type ReceiverBindingThis = { receiverConfig: Map<string, string> };

interface ReceiverDependentRuntime {
  runtime: ReturnType<typeof createWorkflowActionRuntime>;
  runner: ReturnType<typeof createWorkflowActionRunner>;
  externalBinding: { receiverConfig: Map<string, string> };
  calls: { identify: number; validate: number; executeAtomic: number };
}

function operationContextFor(action: Pick<PendingActionV2, 'conversationId' | 'turnId'>): WorkflowOperationContext {
  return { conversationId: action.conversationId, turnId: action.turnId };
}

interface Harness {
  fixture: Fixture;
  store: SqliteStore;
  runtime: ReturnType<typeof createWorkflowActionRuntime>;
  runner: ReturnType<typeof createWorkflowActionRunner>;
  profileId: string;
  managerProfileId: string;
  sessionId: string;
  identityId: string;
  managerIdentityId: string;
  responsibilityId: string;
  orgUnitId: string;
  branchId: string;
  conversationId: string;
  requestIds: string[];
  counters: { identify: number; validate: number; execute: number; verify: number; currentStates: number };
  setNow(value: string): void;
  setPackVersion(value: string): void;
  setReleaseRevision(value: string): void;
  setBaseImplementationRevision(value: string): void;
  getBaseImplementationRevision(): string;
  changedCallbackRevision(): string;
  changedOriginalCallbackRevision(callback: WorkflowCallbackName): string;
  createRuntimeWithConfigurationRevision(revision: string, registration: CallbackRegistration): ReturnType<typeof createWorkflowActionRuntime>;
  createReceiverDependentRuntime(callback: ReceiverSensitiveCallback, registration: CallbackRegistration): ReceiverDependentRuntime;
  createRunnerWithChangedCallback(callback: 'identify' | 'validate' | 'executeAtomic'): ReturnType<typeof createWorkflowActionRunner>;
  setCallbackFault(value: CallbackFault): void;
  addRequest(label: string): Promise<string>;
  addForeignConversation(): Promise<string>;
  addSnapshot(requestIds: string[]): Promise<ReviewSnapshot>;
  prepare(requestIds: string[], snapshot?: ReviewSnapshot): Promise<PreparationResult>;
  dispose(): Promise<void>;
}

type CallbackFault = 'none' | 'wrong_business_field' | 'throw_after_first_write' | 'missing' | 'extra' | 'duplicate' | 'wrong_ref' | 'wrong_execution' | 'wrong_version';

function taskId(requestId: string, lifecycleId: string): string {
  return `director-event-${requestId}-${lifecycleId}`;
}

function targetId(requestId: string, lifecycleId: string): string {
  return `${requestId}:${lifecycleId}`;
}

function splitTargetId(value: string): { requestId: string; lifecycleId: string } {
  const separator = value.indexOf(':');
  if (separator < 1 || separator === value.length - 1) throw new Error('Malformed controlled workflow target identity');
  return { requestId: value.slice(0, separator), lifecycleId: value.slice(separator + 1) };
}

async function createHarness(options: {
  requestCount?: number;
  authorityOverride?: { permission: string; roles: Array<'hr_director' | 'hr_admin'>; purpose: 'director_onboarding' | 'hr_operations' };
} = {}): Promise<Harness> {
  const fixture = await createWorkflowSqliteFixture();
  const suffix = randomUUID().replaceAll('-', '');
  const profileId = `runtime-profile-${suffix}`;
  const managerProfileId = `runtime-manager-profile-${suffix}`;
  const sessionId = `runtime-session-${suffix}`;
  const identityId = `runtime-identity-${suffix}`;
  const managerIdentityId = `runtime-manager-identity-${suffix}`;
  const responsibilityId = `runtime-responsibility-${suffix}`;
  const orgUnitId = `runtime-org-${suffix}`;
  const branchId = `runtime-branch-${suffix}`;
  const conversationId = `runtime-conversation-${suffix}`;
  const requestIds: string[] = [];
  let now = new Date(NOW);
  let packVersion = '1.0';
  let baseImplementationRevision = 'hr-runtime-test-base-r1';
  let releaseRevision = RELEASE;
  let callbackFault: CallbackFault = 'none';
  let generatedId = 0;
  const counters = { identify: 0, validate: 0, execute: 0, verify: 0, currentStates: 0 };
  const profile: Profile = {
    id: profileId,
    name: 'Workflow runtime test profile',
    role: 'hr_admin',
    active: true,
    permissions: [PERMISSION, 'hr.onboarding.director_read'],
    regions: ['east'],
  };
  const policyPin = getDemoWorkflowPolicyV1Pin();
  const policyRow = {
    id: `runtime-policy-row-${suffix}`,
    version: policyPin.version,
    digest: policyPin.digest,
    policy: demoWorkflowPolicyV1,
  };

  try {
    await fixture.store.transaction(async (tx) => {
      await tx.put('profiles', profile);
      await tx.put('profiles', {
        id: managerProfileId, name: 'Workflow runtime test Manager', role: 'hr_admin', active: true,
        permissions: [], regions: ['east'],
      });
      await tx.put('branches', { id: branchId, name: 'Runtime test branch', region: 'east' });
      await tx.put('sessions', {
        id: sessionId,
        profileId,
        mode: 'scripted_demo',
        modeRevision: 3,
        csrfToken: `csrf-${suffix}`,
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
    });

    await fixture.store.workflowTransaction(async (tx) => {
      await tx.insertUnique('org_units', {
        id: orgUnitId, name: `Runtime test org ${suffix}`, parentOrgUnitId: null, active: true,
      }, { constraint: 'org_units_primary_key', values: { id: orgUnitId } });
      await tx.insertUnique('directory_identities', {
        id: identityId,
        profileId,
        displayName: 'Workflow runtime test Director',
        active: true,
        role: 'hr_director',
        department: 'hr',
        orgUnitId,
        managerIdentityId: null,
        verifiedDemoEmail: `runtime-${suffix}@example.invalid`,
        slackIdentity: null,
        allowedChannels: ['simulated_email'],
        classificationCeiling: 'internal',
        rowVersion: 1,
      }, { constraint: 'directory_identities_primary_key', values: { id: identityId } });
      await tx.insertUnique('directory_identities', {
        id: managerIdentityId,
        profileId: managerProfileId,
        displayName: 'Workflow runtime test Manager',
        active: true,
        role: 'hr_admin',
        department: 'hr',
        orgUnitId,
        managerIdentityId: null,
        verifiedDemoEmail: `runtime-manager-${suffix}@example.invalid`,
        slackIdentity: null,
        allowedChannels: ['simulated_email'],
        classificationCeiling: 'internal',
        rowVersion: 1,
      }, { constraint: 'directory_identities_primary_key', values: { id: managerIdentityId } });
      await tx.insertUnique('responsibilities', {
        id: responsibilityId,
        identityId,
        orgUnitId,
        purpose: 'director_onboarding',
        branchIds: [branchId],
        active: true,
        rowVersion: 1,
      }, {
        constraint: 'responsibilities_open_identity_purpose_unique',
        values: { identityId, purpose: 'director_onboarding', orgUnitId },
      });
      await tx.insertUnique('conversations', {
        id: conversationId,
        actorId: profileId,
        title: 'Workflow runtime test conversation',
        pinned: false,
        archivedAt: null,
        rowVersion: 1,
        createdAt: NOW,
        updatedAt: NOW,
        lastScope: null,
        lastDashboardId: null,
      }, { constraint: 'conversations_primary_key', values: { id: conversationId } });
      await tx.insertUnique('workflow_policies', policyRow, {
        constraint: 'workflow_policies_primary_key', values: { id: policyRow.id },
      });
    });

    const insertRequest = async (label: string): Promise<string> => {
      const requestId = `runtime-request-${label}-${suffix}`;
      const employeeId = `runtime-employee-${label}-${suffix}`;
      const lifecycleId = `runtime-lifecycle-${label}-${suffix}`;
      const managerEventId = `runtime-manager-event-${label}-${suffix}`;
      await fixture.store.transaction((tx) => tx.put('employees', {
        id: employeeId, name: `Runtime test employee ${label}`, branchId, active: true,
      }));
      const request: RequestRow = {
        id: requestId,
        employeeId,
        orgUnitId,
        managerIdentityId,
        directorIdentityId: identityId,
        startDate: '2026-10-15',
        state: 'draft',
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
      const managerEvent: ApprovalEvent = {
        id: managerEventId,
        rowVersion: 1,
        requestId,
        actorIdentityId: managerIdentityId,
        stage: 'manager',
        lifecycleId,
        decision: 'approved',
        reason: 'Controlled setup row for runtime tests.',
        createdAt: NOW,
      };
      await fixture.store.workflowTransaction(async (tx) => {
        await tx.insertUnique('onboarding_requests', request, {
          constraint: 'onboarding_requests_primary_key', values: { id: requestId },
        });
        await tx.insertUnique('onboarding_approval_events', managerEvent, {
          constraint: 'onboarding_approval_lifecycle_stage_unique',
          values: { requestId, lifecycleId, stage: 'manager' },
        });
        const created = await tx.get<RequestRow>('onboarding_requests', requestId);
        if (!created) throw new Error(`Could not reread controlled request ${requestId}`);
        const managerReviewed = await tx.compareAndSwap('onboarding_requests', requestId,
          { rowVersion: created.rowVersion, state: 'draft' }, {
            ...created, rowVersion: created.rowVersion + 1, state: 'manager_review_pending',
            managerApprovalEventId: managerEventId, managerApprovedBy: managerProfileId, managerApprovedAt: NOW, updatedAt: NOW,
          });
        if (!managerReviewed.updated) throw new Error(`Could not record controlled manager approval ${requestId}`);
        const managerProjection = await tx.get<RequestRow>('onboarding_requests', requestId);
        if (!managerProjection) throw new Error(`Could not reread manager-reviewed request ${requestId}`);
        const directorQueued = await tx.compareAndSwap('onboarding_requests', requestId,
          { rowVersion: managerProjection.rowVersion, state: 'manager_review_pending' }, {
            ...managerProjection, rowVersion: managerProjection.rowVersion + 1,
            state: 'director_approval_pending', updatedAt: NOW,
          });
        if (!directorQueued.updated) throw new Error(`Could not queue controlled Director approval ${requestId}`);
      });
      requestIds.push(requestId);
      return requestId;
    };

    for (let index = 0; index < (options.requestCount ?? 3); index += 1) {
      await insertRequest(`seed-${index + 1}`);
    }

    const binding = defineWorkflowBinding({
      kind: 'onboarding_director_approve',
      contractVersion: 2,
      packIds: [PACK_ID],
      executionMode: 'atomic_local',
      authority: options.authorityOverride ?? (() => {
        const policy = getWorkflowActionAuthority('onboarding_director_approve');
        return { permission: policy.permission, roles: [...policy.roles], purpose: policy.purpose };
      })(),
      async identify(context: RuntimeReadContext, payload: ApprovalPayload) {
        counters.identify += 1;
        const targets = [];
        for (const requestId of payload.requestIds) {
          const projection = await context.projections.get<RequestRow>('onboarding_requests', requestId);
          if (!projection) throw new Error(`Missing controlled request ${requestId}`);
          targets.push({
            targetId: targetId(requestId, projection.body.lifecycleId),
            ref: { table: 'onboarding_requests' as const, id: requestId },
            semanticKey: digest({ kind: payload.kind, requestId, lifecycleId: projection.body.lifecycleId, transition: 'director_approve' }),
            scope: { orgUnitId: projection.body.orgUnitId },
          });
        }
        return { targets };
      },
      expectedPostconditions(action: PendingActionV2, executionId: string, confirmedAt: string) {
        if (action.payload.kind !== 'onboarding_director_approve') throw new Error('Unexpected controlled payload kind');
        return action.targets.map((target) => {
          const { requestId, lifecycleId } = splitTargetId(target.targetId);
          const eventRef = target.expectedEffectRef;
          const requestVersion = action.expectedRows.find((row) => row.ref.table === 'onboarding_requests' && row.ref.id === requestId)?.rowVersion;
          if (requestVersion === undefined) throw new Error('The prepared request version was absent');
          return {
            targetId: target.targetId,
            ref: eventRef,
            rowVersion: target.expectedEffectVersion,
            executionId,
            fields: [
              { path: 'requestId', expected: requestId },
              { path: 'actorIdentityId', expected: target.ownerIdentityId },
              { path: 'stage', expected: 'director' },
              { path: 'lifecycleId', expected: lifecycleId },
              { path: 'executionId', expected: executionId },
              { path: 'decision', expected: 'approved' },
              { path: 'reason', expected: 'Controlled callback; it verifies the runtime boundary only.' },
              { path: 'createdAt', expected: confirmedAt },
            ],
            attributionRefs: [{
              ref: target.ref,
              rowVersion: requestVersion + 1,
              fields: [
                { path: 'state', expected: 'director_approved' },
                { path: 'directorApprovalEventId', expected: eventRef.id },
                { path: 'directorApprovedBy', expected: action.actorId },
                { path: 'directorApprovedAt', expected: confirmedAt },
                { path: 'updatedAt', expected: confirmedAt },
              ],
            }],
          };
        });
      },
      async validate(context, payload: ApprovalPayload) {
        counters.validate += 1;
        const snapshot = await context.reader.get<ReviewSnapshot>('review_snapshots', payload.snapshotId);
        if (!snapshot) throw new Error(`Missing controlled snapshot ${payload.snapshotId}`);
        const targets = [];
        const expectedRows: ExpectedRow[] = [];
        for (const requestId of payload.requestIds) {
          const request = await context.reader.get<RequestRow>('onboarding_requests', requestId);
          if (!request || request.state !== 'director_approval_pending' || request.directorIdentityId !== identityId) {
            throw new Error(`The controlled request ${requestId} is not eligible`);
          }
          const managerEventId = request.managerApprovalEventId;
          if (!managerEventId) throw new Error(`The controlled request ${requestId} lacks manager proof`);
          const managerEvent = await context.reader.get<ApprovalEvent>('onboarding_approval_events', managerEventId);
          if (!managerEvent || managerEvent.stage !== 'manager' || managerEvent.lifecycleId !== request.lifecycleId) {
            throw new Error(`The controlled request ${requestId} manager proof is invalid`);
          }
          const requestExpected: ExpectedRow = {
            ref: { table: 'onboarding_requests', id: requestId }, rowVersion: request.rowVersion, state: request.state,
          };
          const managerExpected: ExpectedRow = {
            ref: { table: 'onboarding_approval_events', id: managerEventId }, rowVersion: managerEvent.rowVersion, state: null,
          };
          expectedRows.push(requestExpected, managerExpected);
          const ref = { table: 'onboarding_requests' as const, id: requestId };
          const eventRef = { table: 'onboarding_approval_events' as const, id: taskId(requestId, request.lifecycleId) };
          targets.push({
            targetId: targetId(requestId, request.lifecycleId),
            ref,
            semanticKey: digest({ kind: payload.kind, requestId, lifecycleId: request.lifecycleId, transition: 'director_approve' }),
            expectedRows: [requestExpected, managerExpected],
            ownerIdentityId: identityId,
            expectedEffectRef: eventRef,
            expectedEffectVersion: 1,
          });
        }
        if (snapshot.id !== payload.snapshotId || payload.requestIds.some((id) => !snapshot.displayedIds.includes(id))) {
          throw new Error('The controlled selection is outside the reviewed snapshot');
        }
        return {
          targets,
          expectedRows,
          approvedBranchIds: [],
          approvedOrgUnitIds: [orgUnitId],
          policy: getDemoWorkflowPolicyV1Pin(),
          reviewedSnapshotId: snapshot.id,
        };
      },
      async executeAtomic(context) {
        counters.execute += 1;
        const confirmedAt = context.now().toISOString();
        const results = [];
        for (let index = 0; index < context.action.targets.length; index += 1) {
          const target = context.action.targets[index];
          const { requestId, lifecycleId } = splitTargetId(target.targetId);
          const request = await context.tx.get<RequestRow>('onboarding_requests', requestId);
          if (!request || request.state !== 'director_approval_pending' || request.lifecycleId !== lifecycleId) {
            throw new Error(`Controlled request ${requestId} changed during execution`);
          }
          const event: ApprovalEvent = {
            id: target.expectedEffectRef.id,
            rowVersion: 1,
            requestId,
            actorIdentityId: identityId,
            stage: 'director',
            lifecycleId,
            executionId: context.executionId,
            decision: 'approved',
            reason: callbackFault === 'wrong_business_field' && index === 1
              ? 'Unapproved callback reason.' : 'Controlled callback; it verifies the runtime boundary only.',
            createdAt: confirmedAt,
          };
          const inserted = await context.tx.insertUnique('onboarding_approval_events', event, {
            constraint: 'onboarding_approval_lifecycle_stage_unique',
            values: { requestId, lifecycleId, stage: 'director' },
          });
          if (!inserted.inserted) throw new Error('The controlled approval event already exists');
          if (callbackFault === 'throw_after_first_write' && index === 0) throw new Error('Injected throw after the first staged business write');
          const updatedRequest: RequestRow = {
            ...request,
            rowVersion: request.rowVersion + 1,
            state: 'director_approved',
            directorApprovalEventId: event.id,
            directorApprovedBy: context.action.actorId,
            directorApprovedAt: confirmedAt,
            updatedAt: confirmedAt,
          };
          const changed = await context.tx.compareAndSwap('onboarding_requests', requestId,
            { rowVersion: request.rowVersion, state: 'director_approval_pending' }, updatedRequest);
          if (!changed.updated) throw new Error(`Controlled compare-and-swap failed for ${requestId}`);
          results.push({ targetId: target.targetId, ref: target.expectedEffectRef, executionId: context.executionId, rowVersion: 1 });
        }
        switch (callbackFault) {
          case 'missing': return results.slice(1);
          case 'extra': return [...results, { ...results[0], targetId: 'extra-target' }];
          case 'duplicate': return [results[0], results[0]];
          case 'wrong_ref': return results.map((result, index) => index === 0 ? { ...result, ref: { ...result.ref, id: `${result.ref.id}-wrong` } } : result);
          case 'wrong_execution': return results.map((result, index) => index === 0 ? { ...result, executionId: 'different-execution' } : result);
          case 'wrong_version': return results.map((result, index) => index === 0 ? { ...result, rowVersion: result.rowVersion + 1 } : result);
          default: return results;
        }
      },
      async verify(context, committed): Promise<TargetProof[]> {
        counters.verify += 1;
        return Promise.all(committed.map(async (target) => {
          const prepared = context.action.targets.find((candidate) => candidate.targetId === target.targetId);
          if (!prepared) throw new Error(`No prepared target ${target.targetId}`);
          const { requestId, lifecycleId } = splitTargetId(prepared.targetId);
          const event = await context.reader.get<ApprovalEvent>(target.ref.table as WorkflowStorageTable, target.ref.id);
          const request = await context.reader.get<RequestRow>('onboarding_requests', requestId);
          const valid = event?.executionId === context.executionId && event.requestId === requestId &&
            event.actorIdentityId === identityId && event.stage === 'director' &&
            event.lifecycleId === lifecycleId && event.decision === 'approved' &&
            request?.state === 'director_approved' && request.directorApprovalEventId === event.id;
          return {
            targetId: target.targetId,
            ref: target.ref,
            outcome: valid ? 'verified_success' : 'pending',
            executionId: context.executionId,
            observedRowVersion: event?.rowVersion ?? null,
            checkedAt: valid ? context.now().toISOString() : null,
            mismatchCodes: valid ? [] : ['INDEPENDENT_READBACK_MISMATCH'],
          };
        }));
      },
      async currentStates(context, refs: Ref[]): Promise<CurrentState[]> {
        counters.currentStates += 1;
        const states: CurrentState[] = [];
        for (const ref of refs) {
          const request = await context.reader.get<RequestRow>(ref.table as WorkflowStorageTable, ref.id);
          if (!request) continue;
          const completedActions = [];
          if (request.directorApprovalEventId) {
            const event = await context.reader.get<ApprovalEvent>('onboarding_approval_events', request.directorApprovalEventId);
            if (event?.executionId) completedActions.push({
              kind: 'onboarding_director_approve', executionId: event.executionId, completedAt: event.createdAt,
            });
          }
          states.push({
            ref,
            state: request.state,
            rowVersion: request.rowVersion,
            allowedNextActions: request.state === 'director_approval_pending' ? ['onboarding_director_approve'] :
              request.state === 'director_approved' ? ['onboarding_start'] : [],
            completedActions,
          });
        }
        return states;
      },
    });

    const runtimeOptions: WorkflowRuntimeOptions = {
      store: fixture.store,
      bindings: [binding],
      businessDate: '2026-10-03',
      getReleaseRevision: () => releaseRevision,
      getPackPins: (packIds) => packIds.map((id) => ({
        id, version: packVersion, schemaDigest: PACK_DIGEST, implementationRevision: baseImplementationRevision,
      })),
      contextFactory: () => ({
        evidence: async () => ({
          scope: { region: 'east', date: '2026-10-03', branchIds: [] },
          asOf: NOW,
          version: 'runtime-test-evidence-v1',
          branches: [],
          totals: { netSales: 0, target: 0, gap: 0, achievement: null },
          sources: [],
          warnings: [],
        }),
        latestDashboard: async () => undefined,
      }),
      now: () => new Date(now),
      makeId: (prefix) => `runtime-${prefix}-${suffix}-${++generatedId}`,
    };
    const runtime = createWorkflowActionRuntime(runtimeOptions);

    const harness: Harness = {
      fixture,
      store: fixture.store,
      runtime,
      runner: createWorkflowActionRunner(runtime),
      profileId,
      managerProfileId,
      sessionId,
      identityId,
      managerIdentityId,
      responsibilityId,
      orgUnitId,
      branchId,
      conversationId,
      requestIds,
      counters,
      setNow(value) { now = new Date(value); },
      setPackVersion(value) { packVersion = value; },
      setReleaseRevision(value) { releaseRevision = value; },
      setBaseImplementationRevision(value) { baseImplementationRevision = value; },
      getBaseImplementationRevision() { return baseImplementationRevision; },
      changedCallbackRevision() {
        const changedBinding = defineWorkflowBinding({
          ...binding,
          async verify(context, committed) { return binding.verify(context, committed); },
        });
        return createWorkflowActionRuntime({ ...runtimeOptions, bindings: [changedBinding] }).pins([PACK_ID])[0].implementationRevision;
      },
      createRuntimeWithConfigurationRevision(revision, registration) {
        const configuredBinding = { ...binding, configurationRevision: revision };
        const registeredBinding = registration === 'direct' ? configuredBinding : registration === 'wrapped'
          ? defineWorkflowBinding(configuredBinding)
          : defineWorkflowBinding(defineWorkflowBinding(configuredBinding));
        return createWorkflowActionRuntime({ ...runtimeOptions, bindings: [registeredBinding] });
      },
      changedOriginalCallbackRevision(callback) {
        let changedBinding: WorkflowRuntimeBinding;
        switch (callback) {
          case 'identify':
            changedBinding = {
              ...binding,
              async identify(context: RuntimeReadContext, payload: ApprovalPayload) {
                const intent = await binding.identify(context, payload);
                return { targets: intent.targets.map((target) => ({ ...target, scope: { ...target.scope } })) };
              },
            };
            break;
          case 'expectedPostconditions':
            changedBinding = {
              ...binding,
              expectedPostconditions(action, executionId, confirmedAt) {
                return binding.expectedPostconditions(action, executionId, confirmedAt)
                  .map((postcondition) => ({ ...postcondition, fields: [...postcondition.fields] }));
              },
            };
            break;
          case 'validate':
            changedBinding = {
              ...binding,
              async validate(context, payload: ApprovalPayload) {
                const validation = await binding.validate(context, payload);
                return { ...validation, targets: validation.targets.map((target) => ({ ...target, expectedRows: [...target.expectedRows] })) };
              },
            };
            break;
          case 'executeAtomic':
            changedBinding = {
              ...binding,
              async executeAtomic(context, payload: ApprovalPayload) {
                const committed = await binding.executeAtomic(context, payload);
                return committed.map((target) => ({ ...target, ref: { ...target.ref } }));
              },
            };
            break;
          case 'verify':
            changedBinding = {
              ...binding,
              async verify(context, committed) {
                const proofs = await binding.verify(context, committed);
                return proofs.map((proof) => ({ ...proof, mismatchCodes: [...proof.mismatchCodes] }));
              },
            };
            break;
          case 'currentStates':
            changedBinding = {
              ...binding,
              async currentStates(context, refs) {
                const states = await binding.currentStates(context, refs);
                return states.map((state) => ({ ...state, allowedNextActions: [...state.allowedNextActions] }));
              },
            };
            break;
        }
        const rewrapped = defineWorkflowBinding(defineWorkflowBinding(changedBinding));
        return createWorkflowActionRuntime({ ...runtimeOptions, bindings: [rewrapped] }).pins([PACK_ID])[0].implementationRevision;
      },
      createReceiverDependentRuntime(callback, registration) {
        const externalBinding = {
          receiverConfig: new Map<string, string>([
            ['identity-revision', 'receiver-r1'],
            ['approved-org-unit-id', orgUnitId],
            ['effect-reason', 'Controlled callback; it verifies the runtime boundary only.'],
          ]),
        };
        const calls = { identify: 0, validate: 0, executeAtomic: 0 };
        const receiverBinding = {
          ...binding,
          ...externalBinding,
          ...(callback === 'identify' ? {
            async identify(this: ReceiverBindingThis, context: RuntimeReadContext, payload: ApprovalPayload) {
              const revision = this.receiverConfig.get('identity-revision');
              calls.identify += 1;
              if (!revision) throw new Error('Receiver identity revision was unavailable');
              const intent = await binding.identify(context, payload);
              return { targets: intent.targets.map((target) => ({
                ...target,
                semanticKey: digest({ base: target.semanticKey, revision }),
              })) };
            },
            async validate(context: RuntimeReadContext, payload: ApprovalPayload) {
              const validation = await binding.validate(context, payload);
              return { ...validation, targets: validation.targets.map((target) => ({
                ...target,
                semanticKey: digest({ base: target.semanticKey, revision: 'receiver-r1' }),
              })) };
            },
          } : callback === 'validate' ? {
            async validate(this: ReceiverBindingThis, context: RuntimeReadContext, payload: ApprovalPayload) {
              const approvedOrgUnitId = this.receiverConfig.get('approved-org-unit-id');
              calls.validate += 1;
              if (!approvedOrgUnitId) throw new Error('Receiver validation scope was unavailable');
              return { ...await binding.validate(context, payload), approvedOrgUnitIds: [approvedOrgUnitId] };
            },
          } : {
            async executeAtomic(this: ReceiverBindingThis, context: RuntimeReadContext & { tx: GuardedTransaction; action: PendingActionV2; executionId: string }, payload: ApprovalPayload) {
              calls.executeAtomic += 1;
              const reason = this.receiverConfig.get('effect-reason');
              if (!reason) throw new Error('Receiver effect reason was unavailable');
              const tx: GuardedTransaction = {
                get: context.tx.get,
                list: context.tx.list,
                insertUnique: async (table, row, key) => context.tx.insertUnique(table,
                  table === 'onboarding_approval_events' ? { ...row, reason } : row, key),
                compareAndSwap: context.tx.compareAndSwap,
              };
              return binding.executeAtomic({ ...context, tx }, payload);
            },
          }),
        } as unknown as WorkflowRuntimeBinding;
        const registeredBinding = registration === 'direct' ? receiverBinding : registration === 'wrapped'
          ? defineWorkflowBinding(receiverBinding)
          : defineWorkflowBinding(defineWorkflowBinding(receiverBinding));
        const receiverRuntime = createWorkflowActionRuntime({ ...runtimeOptions, bindings: [registeredBinding] });
        return {
          runtime: receiverRuntime,
          runner: createWorkflowActionRunner(receiverRuntime),
          externalBinding,
          calls,
        };
      },
      createRunnerWithChangedCallback(callback) {
        if (callback === 'identify') {
          const changedBinding = defineWorkflowBinding({
            ...binding,
            async identify(context: RuntimeReadContext, payload: ApprovalPayload) {
              const intent = await binding.identify(context, payload);
              return { targets: intent.targets.map((target) => ({ ...target, scope: { ...target.scope } })) };
            },
          });
          return createWorkflowActionRunner(createWorkflowActionRuntime({ ...runtimeOptions, bindings: [changedBinding] }));
        }
        if (callback === 'validate') {
          const changedBinding = defineWorkflowBinding({
            ...binding,
            async validate(context, payload: ApprovalPayload) {
              const validation = await binding.validate(context, payload);
              return { ...validation, targets: validation.targets.map((target) => ({ ...target, expectedRows: [...target.expectedRows] })) };
            },
          });
          return createWorkflowActionRunner(createWorkflowActionRuntime({ ...runtimeOptions, bindings: [changedBinding] }));
        }
        const changedBinding = defineWorkflowBinding({
          ...binding,
          async executeAtomic(context, payload: ApprovalPayload) {
            const committed = await binding.executeAtomic(context, payload);
            return committed.map((target) => ({ ...target, ref: { ...target.ref } }));
          },
        });
        return createWorkflowActionRunner(createWorkflowActionRuntime({ ...runtimeOptions, bindings: [changedBinding] }));
      },
      setCallbackFault(value) { callbackFault = value; },
      async addRequest(label) { return insertRequest(label); },
      async addForeignConversation() {
        const otherProfileId = `runtime-other-profile-${suffix}`;
        const otherConversationId = `runtime-other-conversation-${suffix}`;
        const otherProfile: Profile = { ...profile, id: otherProfileId, name: 'Other profile', permissions: [] };
        await fixture.store.transaction(async (tx) => {
          await tx.put('profiles', otherProfile);
          await tx.put('sessions', {
            id: `runtime-other-session-${suffix}`, profileId: otherProfileId, mode: 'scripted_demo', modeRevision: 0,
            csrfToken: `csrf-other-${suffix}`, expiresAt: '2099-01-01T00:00:00.000Z',
          });
        });
        await fixture.store.workflowTransaction((tx) => tx.insertUnique('conversations', {
          id: otherConversationId, actorId: otherProfileId, title: 'Other owned conversation', pinned: false,
          archivedAt: null, rowVersion: 1, createdAt: NOW, updatedAt: NOW, lastScope: null, lastDashboardId: null,
        }, { constraint: 'conversations_primary_key', values: { id: otherConversationId } }));
        return otherConversationId;
      },
      async addSnapshot(selectedIds) {
        const expectedRows: ExpectedRow[] = [];
        for (const requestId of selectedIds) {
          const request = await fixture.store.workflowProjectionReader.get<RequestRow>('onboarding_requests', requestId);
          if (!request?.body.managerApprovalEventId) throw new Error(`Missing request or manager proof for ${requestId}`);
          const managerEvent = await fixture.store.workflowProjectionReader.get<ApprovalEvent>('onboarding_approval_events', request.body.managerApprovalEventId);
          if (!managerEvent) throw new Error(`Missing manager event ${request.body.managerApprovalEventId}`);
          expectedRows.push(
            { ref: { table: 'onboarding_requests', id: requestId }, rowVersion: request.rowVersion, state: request.body.state },
            { ref: { table: 'onboarding_approval_events', id: managerEvent.id }, rowVersion: managerEvent.rowVersion, state: null },
          );
        }
        const body: ReviewSnapshot = {
          id: `runtime-snapshot-${suffix}-${++generatedId}`,
          actorId: profileId,
          actorSessionId: sessionId,
          purpose: 'director_queue',
          orgUnitIds: [orgUnitId],
          displayedIds: [...selectedIds],
          count: selectedIds.length,
          expectedRows,
          policy: policyPin,
          createdAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
          digest: '0'.repeat(64),
        };
        const snapshot = { ...body, digest: workflowSnapshotDigest(body) };
        await fixture.store.workflowTransaction(async (tx) => {
          await tx.insertUnique('review_snapshots', snapshot, {
            constraint: 'review_snapshots_primary_key', values: { id: snapshot.id },
          });
          for (const [index, expected] of expectedRows.entries()) {
            const row = {
              id: `runtime-snapshot-target-${suffix}-${generatedId}-${index}`,
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
      },
      async prepare(selectedIds, snapshot) {
        const reviewed = snapshot ?? await this.addSnapshot(selectedIds);
        return runtime.prepare(sessionId, {
          kind: 'onboarding_director_approve', snapshotId: reviewed.id, requestIds: selectedIds,
        }, { conversationId, turnId: `runtime-turn-${suffix}-${++generatedId}` });
      },
      async dispose() { await fixture.dispose(); },
    };
    return harness;
  } catch (error) {
    await fixture.dispose();
    throw error;
  }
}

async function withHarness<T>(
  options: Parameters<typeof createHarness>[0],
  run: (harness: Harness) => Promise<T>,
): Promise<T> {
  const harness = await createHarness(options);
  try {
    return await run(harness);
  } finally {
    await harness.dispose();
  }
}

async function changeConversationArchive(store: SqliteStore, conversationId: string): Promise<void> {
  await store.workflowTransaction(async (tx) => {
    const row = await tx.get<{ id: string; actorId: string; archivedAt: string | null; rowVersion: number }>('conversations', conversationId);
    if (!row) throw new Error(`Missing conversation ${conversationId}`);
    const updated = await tx.compareAndSwap('conversations', conversationId, { rowVersion: row.rowVersion, state: null }, {
      ...row, rowVersion: row.rowVersion + 1, archivedAt: NOW, updatedAt: NOW,
    });
    if (!updated.updated) throw new Error('The controlled conversation CAS failed');
  });
}

async function returnRequestForStaleBatch(store: SqliteStore, requestId: string): Promise<void> {
  await store.workflowTransaction(async (tx) => {
    const row = await tx.get<RequestRow>('onboarding_requests', requestId);
    if (!row) throw new Error(`Missing request ${requestId}`);
    const changed = await tx.compareAndSwap('onboarding_requests', requestId,
      { rowVersion: row.rowVersion, state: 'director_approval_pending' }, {
        ...row,
        rowVersion: row.rowVersion + 1,
        state: 'returned_for_revision',
        managerApprovalEventId: null,
        managerApprovedBy: null,
        managerApprovedAt: null,
        directorApprovalEventId: null,
        directorApprovedBy: null,
        directorApprovedAt: null,
        updatedAt: NOW,
      });
    if (!changed.updated) throw new Error(`Could not mark ${requestId} stale for the controlled batch test`);
  });
}

async function rawCount(fixture: Fixture, sql: string, ...values: string[]): Promise<number> {
  const database = fixture.openDatabase();
  try {
    const result = database.prepare(sql).get(...values) as { count: number };
    return Number(result.count);
  } finally {
    database.close();
  }
}

describe('workflow action runtime', () => {
  it('prepares a frozen actor-owned approval without executing any business effect', async () => {
    await withHarness({}, async (harness) => {
      const selected = [harness.requestIds[0]];
      const snapshot = await harness.addSnapshot(selected);
      const result = await harness.prepare(selected, snapshot);
      expect(result.outcome).toBe('pending');
      expect(result.pendingAction === null).toBe(false);
      const action = result.pendingAction as PendingActionV2;
      expect(action).toMatchObject({
        contractVersion: 2,
        actorId: harness.profileId,
        sessionId: harness.sessionId,
        conversationId: harness.conversationId,
        mode: 'scripted_demo',
        modeRevision: 3,
        reviewedSnapshotId: snapshot.id,
        policy: getDemoWorkflowPolicyV1Pin(),
        releaseRevision: RELEASE,
        executionMode: 'atomic_local',
        status: 'pending',
      });
      expect(action.payloadHash).toBe(workflowApprovalHash(action));
      expect(action.approvedBranchIds).toEqual([]);
      expect(action.approvedOrgUnitIds).toEqual([harness.orgUnitId]);
      expect(action.packs).toHaveLength(1);
      expect(action.packs[0]).toMatchObject({ id: PACK_ID, version: '1.0', schemaDigest: PACK_DIGEST });
      expect(action.packs[0].implementationRevision).toMatch(/^workflow-v2:[a-f0-9]{64}$/);
      expect(action.packs[0].implementationRevision === 'hr-runtime-test-base-r1').toBe(false);
      expect(harness.changedCallbackRevision() === action.packs[0].implementationRevision).toBe(false);
      harness.setBaseImplementationRevision('hr-runtime-test-base-r2');
      expect(harness.runtime.pins([PACK_ID])[0].implementationRevision === action.packs[0].implementationRevision).toBe(false);
      expect(Date.parse(action.expiresAt) - Date.parse(action.createdAt)).toBe(600_000);
      expect(action.expectedRows).toEqual(expect.arrayContaining([
        expect.objectContaining({ ref: { table: 'directory_identities', id: harness.identityId } }),
        expect.objectContaining({ ref: { table: 'responsibilities', id: harness.responsibilityId } }),
        expect.objectContaining({ ref: { table: 'onboarding_requests', id: selected[0] }, rowVersion: 3, state: 'director_approval_pending' }),
      ]));
      expect(action.targets.map((target) => target.ref.id)).toEqual(selected);
      expect(harness.counters.execute).toBe(0);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM onboarding_approval_events WHERE stage = ?', 'director')).toBe(0);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM action_executions')).toBe(0);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM semantic_effects')).toBe(0);
    });
  });

  it('pins changed original sources for all six callbacks after repeated binding wrappers', async () => {
    await withHarness({}, async (harness) => {
      const baseline = harness.runtime.pins([PACK_ID])[0].implementationRevision;
      for (const callback of [
        'identify', 'expectedPostconditions', 'validate', 'executeAtomic', 'verify', 'currentStates',
      ] as const) {
        expect(harness.changedOriginalCallbackRevision(callback), callback).not.toBe(baseline);
      }
    });
  });

  it('stales each pending review when one wrapped identify, validate, or execute callback changes', async () => {
    for (const callback of ['identify', 'validate', 'executeAtomic'] as const) {
      await withHarness({}, async (harness) => {
        const prepared = await harness.prepare([harness.requestIds[0]]);
        const action = prepared.pendingAction!;
        const originalPin = action.packs[0];
        const changedRunner = harness.createRunnerWithChangedCallback(callback);
        const changedPin = changedRunner.runtime.pins([PACK_ID])[0];

        expect(harness.getBaseImplementationRevision()).toBe('hr-runtime-test-base-r1');
        expect(harness.runtime.releaseRevision()).toBe(RELEASE);
        expect(changedRunner.runtime.releaseRevision()).toBe(action.releaseRevision);
        expect(changedPin).toMatchObject({ id: PACK_ID, version: '1.0', schemaDigest: PACK_DIGEST });
        expect(changedPin.implementationRevision).not.toBe(originalPin.implementationRevision);

        const rejected = await changedRunner.confirm(harness.sessionId, action.id,
          `runtime-changed-${callback}`, operationContextFor(action));
        expect(rejected.receipt).toBeNull();
        expect(rejected.error).toMatchObject({
          outcome: 'stale', operationPhase: 'claim', executionId: null,
          commitCertainty: 'definitely_not_committed', domainEffect: 'none', retryBusinessWrite: false,
        });
        const storedAction = await harness.store.workflowProjectionReader.get<PendingActionV2>('pending_actions', action.id);
        expect(storedAction?.body.status).toBe('pending');
        expect(harness.counters.execute).toBe(0);
        expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM action_executions')).toBe(0);
        expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM action_targets')).toBe(0);
        expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM semantic_effects')).toBe(0);
        expect(await rawCount(harness.fixture,
          'SELECT COUNT(*) AS count FROM onboarding_approval_events WHERE stage = ?', 'director')).toBe(0);
      });
    }
  });

  it('pins callback configuration revisions and only stales previews when the revision changes', async () => {
    await withHarness({}, async (harness) => {
      const stableRuntime = harness.createRuntimeWithConfigurationRevision('runtime-config-r1', 'direct');
      const sameRevisionRewrapped = harness.createRuntimeWithConfigurationRevision('runtime-config-r1', 'rewrapped');
      const changedRevisionWrapped = harness.createRuntimeWithConfigurationRevision('runtime-config-r2', 'wrapped');
      const stablePin = stableRuntime.pins([PACK_ID])[0];
      const sameRevisionPin = sameRevisionRewrapped.pins([PACK_ID])[0];
      const changedRevisionPin = changedRevisionWrapped.pins([PACK_ID])[0];

      expect(sameRevisionPin).toEqual(stablePin);
      expect(changedRevisionPin).toMatchObject({ id: PACK_ID, version: '1.0', schemaDigest: PACK_DIGEST });
      expect(changedRevisionPin.implementationRevision).not.toBe(stablePin.implementationRevision);
      expect(harness.getBaseImplementationRevision()).toBe('hr-runtime-test-base-r1');
      expect(stableRuntime.releaseRevision()).toBe(RELEASE);
      expect(changedRevisionWrapped.releaseRevision()).toBe(RELEASE);

      const selected = [harness.requestIds[0]];
      const snapshot = await harness.addSnapshot(selected);
      const prepared = await stableRuntime.prepare(harness.sessionId, {
        kind: 'onboarding_director_approve', snapshotId: snapshot.id, requestIds: selected,
      }, { conversationId: harness.conversationId, turnId: 'runtime-config-revision' });
      const action = prepared.pendingAction;
      expect(prepared.outcome).toBe('pending');
      expect(action).not.toBeNull();
      expect(action!.packs[0]).toEqual(stablePin);

      const staleAttempt = await createWorkflowActionRunner(changedRevisionWrapped).confirm(harness.sessionId, action!.id,
        'runtime-config-revision-changed', operationContextFor(action!));
      expect(staleAttempt.receipt).toBeNull();
      expect(staleAttempt.error).toMatchObject({
        outcome: 'stale', operationPhase: 'claim', executionId: null,
        commitCertainty: 'definitely_not_committed', domainEffect: 'none', retryBusinessWrite: false,
      });
      const stillPending = await harness.store.workflowProjectionReader.get<PendingActionV2>('pending_actions', action!.id);
      expect(stillPending?.body.status).toBe('pending');
      expect(harness.counters.execute).toBe(0);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM action_executions')).toBe(0);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM action_targets')).toBe(0);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM semantic_effects')).toBe(0);
      expect(await rawCount(harness.fixture,
        'SELECT COUNT(*) AS count FROM onboarding_approval_events WHERE stage = ?', 'director')).toBe(0);

      const unchangedRevision = await createWorkflowActionRunner(sameRevisionRewrapped).confirm(harness.sessionId, action!.id,
        'runtime-config-revision-unchanged', operationContextFor(action!));
      expect(unchangedRevision.error).toBeNull();
      expect(unchangedRevision.receipt?.outcome).toBe('verified_success');
      expect(harness.counters.execute).toBe(1);
      expect(await rawCount(harness.fixture,
        'SELECT COUNT(*) AS count FROM onboarding_approval_events WHERE stage = ?', 'director')).toBe(1);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM action_executions')).toBe(1);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM semantic_effects')).toBe(1);
    });
  });

  for (const registration of ['direct', 'wrapped', 'rewrapped'] as const) {
    it(`fails closed on receiver-dependent identify and validate callbacks registered ${registration}`, async () => {
      await withHarness({}, async (harness) => {
        for (const callback of ['identify', 'validate'] as const) {
          const index = callback === 'identify' ? 0 : 1;
          const dependent = harness.createReceiverDependentRuntime(callback, registration);
          const requestId = harness.requestIds[index];
          const snapshot = await harness.addSnapshot([requestId]);
          const attempted = await dependent.runtime.prepare(harness.sessionId, {
            kind: 'onboarding_director_approve', snapshotId: snapshot.id, requestIds: [requestId],
          }, { conversationId: harness.conversationId, turnId: `receiver-${registration}-${callback}` }).catch((error: unknown) => error);

          expect(attempted, callback).toBeInstanceOf(WorkflowOperationError);
          expect((attempted as WorkflowOperationError).details, callback).toMatchObject({
            outcome: 'failed', code: 'WORKFLOW_FAILED', commitCertainty: 'definitely_not_committed',
            domainEffect: 'none', retryBusinessWrite: false,
          });
          expect(dependent.calls[callback], callback).toBe(0);
          expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM pending_actions'), callback).toBe(0);
          expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM action_executions'), callback).toBe(0);
          expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM semantic_effects'), callback).toBe(0);
          expect(await rawCount(harness.fixture,
            'SELECT COUNT(*) AS count FROM onboarding_approval_events WHERE stage = ?', 'director'), callback).toBe(0);
        }
      });
    });

    it(`rejects a receiver-mutated execute callback after preparation without replay when registered ${registration}`, async () => {
      await withHarness({}, async (harness) => {
        const dependent = harness.createReceiverDependentRuntime('executeAtomic', registration);
        const selected = [harness.requestIds[0]];
        const snapshot = await harness.addSnapshot(selected);
        const prepared = await dependent.runtime.prepare(harness.sessionId, {
          kind: 'onboarding_director_approve', snapshotId: snapshot.id, requestIds: selected,
        }, { conversationId: harness.conversationId, turnId: `receiver-execute-${registration}` });
        const action = prepared.pendingAction;
        expect(prepared.outcome).toBe('pending');
        expect(action).not.toBeNull();
        const originalPin = action!.packs[0].implementationRevision;
        const originalRelease = action!.releaseRevision;

        dependent.externalBinding.receiverConfig.set('effect-reason', 'Unapproved receiver-controlled effect reason.');
        expect(harness.getBaseImplementationRevision()).toBe('hr-runtime-test-base-r1');
        expect(dependent.runtime.releaseRevision()).toBe(originalRelease);
        expect(dependent.runtime.pins([PACK_ID])[0].implementationRevision).toBe(originalPin);

        const attempted = await dependent.runner.confirm(harness.sessionId, action!.id,
          `receiver-execute-${registration}-confirm`, operationContextFor(action!));
        expect(attempted.receipt).toBeNull();
        expect(attempted.error).toMatchObject({
          outcome: 'failed', operationPhase: 'effect', commitCertainty: 'definitely_not_committed',
          domainEffect: 'none', retryBusinessWrite: false,
        });
        expect(dependent.calls.executeAtomic).toBe(1);
        expect(harness.counters.execute).toBe(0);
        const unchangedRequest = await harness.store.workflowProjectionReader.get<RequestRow>('onboarding_requests', selected[0]);
        expect(unchangedRequest?.body).toMatchObject({
          state: 'director_approval_pending', rowVersion: 3, directorApprovalEventId: null,
        });
        expect(await rawCount(harness.fixture,
          'SELECT COUNT(*) AS count FROM onboarding_approval_events WHERE stage = ?', 'director')).toBe(0);
        expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM semantic_effects')).toBe(0);
        expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM action_targets')).toBe(0);

        const replay = await dependent.runner.confirm(harness.sessionId, action!.id,
          `receiver-execute-${registration}-replay`, operationContextFor(action!));
        expect(replay.error).toBeNull();
        expect(replay.receipt?.id).toBe(attempted.error?.executionId);
        expect(replay.receipt).toMatchObject({ actionId: action!.id, outcome: 'failed', proofs: [] });
        expect(replay.receipt?.currentStates).toMatchObject([{
          ref: { table: 'onboarding_requests', id: selected[0] }, state: 'director_approval_pending', rowVersion: 3,
        }]);
        expect(dependent.calls.executeAtomic).toBe(1);
        expect(harness.counters.execute).toBe(0);
        expect(await rawCount(harness.fixture,
          'SELECT COUNT(*) AS count FROM onboarding_approval_events WHERE stage = ?', 'director')).toBe(0);
        expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM semantic_effects')).toBe(0);
        expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM action_targets')).toBe(0);
      });
    });
  }

  it('denies a conversation owned by another actor and a conversation archived after creation', async () => {
    await withHarness({}, async (harness) => {
      const foreignConversationId = await harness.addForeignConversation();
      const foreign = await harness.runtime.prepare(harness.sessionId, {
        kind: 'onboarding_director_approve', snapshotId: 'unused-snapshot', requestIds: [harness.requestIds[0]],
      }, { conversationId: foreignConversationId, turnId: 'foreign-turn' });
      expect(foreign.outcome).toBe('denied');
      expect(foreign.pendingAction).toBeNull();

      await changeConversationArchive(harness.store, harness.conversationId);
      const archived = await harness.runtime.prepare(harness.sessionId, {
        kind: 'onboarding_director_approve', snapshotId: 'unused-snapshot', requestIds: [harness.requestIds[0]],
      }, { conversationId: harness.conversationId, turnId: 'archived-turn' });
      expect(archived.outcome).toBe('stale');
      expect(archived.pendingAction).toBeNull();
      expect(await rawCount(harness.fixture,
        'SELECT COUNT(*) AS count FROM audit_events WHERE category = ? AND actor_id = ?', 'workflow_denied', harness.profileId)).toBe(2);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM pending_actions')).toBe(0);
    });
  });

  it('keeps the exact reviewed snapshot when a new eligible request arrives before confirmation', async () => {
    await withHarness({}, async (harness) => {
      const selected = [harness.requestIds[0]];
      const snapshot = await harness.addSnapshot(selected);
      const prepared = await harness.prepare(selected, snapshot);
      const action = prepared.pendingAction;
      expect(action?.targets.map((target) => target.ref.id)).toEqual(selected);

      const lateRequestId = await harness.addRequest('late-arrival');
      const confirmed = await harness.runner.confirm(harness.sessionId, action!.id, 'runtime-late-arrival-confirm', operationContextFor(action!));
      expect(confirmed.error).toBeNull();
      expect(confirmed.receipt?.outcome).toBe('verified_success');
      expect(confirmed.receipt?.proofs.map((proof) => proof.ref)).toEqual(action!.targets.map((target) => target.expectedEffectRef));
      expect(confirmed.receipt?.currentStates.map((state) => state.ref.id)).toEqual(selected);
      const lateRequest = await harness.store.workflowProjectionReader.get<RequestRow>('onboarding_requests', lateRequestId);
      expect(lateRequest?.body).toMatchObject({ state: 'director_approval_pending', rowVersion: 3, directorApprovalEventId: null });
      expect(await rawCount(harness.fixture,
        'SELECT COUNT(*) AS count FROM onboarding_approval_events WHERE request_id = ? AND stage = ?', lateRequestId, 'director')).toBe(0);
    });
  });

  it('invalidates the full reviewed approval batch when one selected member goes stale', async () => {
    await withHarness({}, async (harness) => {
      const selected = harness.requestIds.slice(0, 2);
      const snapshot = await harness.addSnapshot(selected);
      const prepared = await harness.prepare(selected, snapshot);
      const action = prepared.pendingAction;
      expect(action?.targets.map((target) => target.ref.id)).toEqual(selected);
      await returnRequestForStaleBatch(harness.store, selected[1]);

      const confirmed = await harness.runner.confirm(harness.sessionId, action!.id, 'runtime-stale-batch-confirm', operationContextFor(action!));
      expect(confirmed.receipt).toBeNull();
      expect(confirmed.error?.outcome).toBe('stale');
      expect(confirmed.error?.retryBusinessWrite).toBe(false);
      expect(harness.counters.execute).toBe(0);
      const untouchedSibling = await harness.store.workflowProjectionReader.get<RequestRow>('onboarding_requests', selected[0]);
      const changedMember = await harness.store.workflowProjectionReader.get<RequestRow>('onboarding_requests', selected[1]);
      expect(untouchedSibling?.body).toMatchObject({ state: 'director_approval_pending', rowVersion: 3, directorApprovalEventId: null });
      expect(changedMember?.body).toMatchObject({ state: 'returned_for_revision', rowVersion: 4, directorApprovalEventId: null });
      expect(await rawCount(harness.fixture,
        'SELECT COUNT(*) AS count FROM onboarding_approval_events WHERE stage = ?', 'director')).toBe(0);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM action_executions')).toBe(0);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM semantic_effects')).toBe(0);
    });
  });

  const rollbackCallbackFaults: CallbackFault[] = [
    'missing', 'extra', 'duplicate', 'wrong_ref', 'wrong_execution', 'wrong_version', 'wrong_business_field', 'throw_after_first_write',
  ];

  it.each(rollbackCallbackFaults)('rolls back selected workflow writes for %s callback faults', async (fault) => {
    await withHarness({}, async (harness) => {
      const selected = harness.requestIds.slice(0, 2);
      const snapshot = await harness.addSnapshot(selected);
      const prepared = await harness.prepare(selected, snapshot);
      const action = prepared.pendingAction!;
      harness.setCallbackFault(fault);
      const attempted = await harness.runner.confirm(harness.sessionId, action.id, `runtime-atomic-fault-${fault}`, operationContextFor(action));
      expect(attempted.receipt, fault).toBeNull();
      expect(attempted.error?.outcome, fault).toBe('failed');
      expect(attempted.error?.commitCertainty, fault).toBe('definitely_not_committed');
      expect(['WORKFLOW_CALLBACK_CONTRACT', 'WORKFLOW_FAILED'], fault).toContain(attempted.error?.code);
      expect(harness.counters.execute, fault).toBe(1);
      for (const requestId of selected) {
        const request = await harness.store.workflowProjectionReader.get<RequestRow>('onboarding_requests', requestId);
        expect(request?.body, fault).toMatchObject({
          state: 'director_approval_pending', rowVersion: 3, directorApprovalEventId: null,
        });
      }
      expect(await rawCount(harness.fixture,
        'SELECT COUNT(*) AS count FROM onboarding_approval_events WHERE stage = ?', 'director'), fault).toBe(0);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM semantic_effects'), fault).toBe(0);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM action_targets'), fault).toBe(0);
      expect(await rawCount(harness.fixture,
        'SELECT COUNT(*) AS count FROM audit_events WHERE category = ? AND execution_id = ?',
        'workflow_execute', attempted.error!.executionId!), fault).toBe(0);
      expect(await rawCount(harness.fixture,
        'SELECT COUNT(*) AS count FROM audit_events WHERE category = ? AND action_id = ?',
        'workflow_confirm', action.id), fault).toBe(1);
    });
  });

  it('does not advertise or fabricate an unregistered workflow binding', async () => {
    await withHarness({}, async (harness) => {
      expect(harness.runtime.availableKinds()).toEqual(['onboarding_director_approve']);
      expect(harness.runtime.availableKinds().includes('dashboard_create')).toBe(false);
      const outcome = await harness.runtime.prepare(harness.sessionId, {
        kind: 'badge_revoke', badgeId: 'unsupported-badge', employeeId: 'unsupported-employee', reason: 'No registered binding.',
      }, { conversationId: harness.conversationId, turnId: 'unsupported-turn' }).catch((error: unknown) => error);
      // This namespace is deliberately one controlled approval binding; it does not prove catalog/business coverage.
      expect(outcome).toBeInstanceOf(WorkflowOperationError);
      expect((outcome as WorkflowOperationError).details).toMatchObject({ code: 'WORKFLOW_UNAVAILABLE', outcome: 'failed', auditStatus: 'recorded' });
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM pending_actions')).toBe(0);
    });
  });

  it('rejects a binding whose permission tuple disagrees with the closed core action authority', async () => {
    const result = await createHarness({
      authorityOverride: { permission: 'hr.onboarding.return', roles: ['hr_director'], purpose: 'director_onboarding' },
    }).catch((error: unknown) => error);
    expect(result).toMatchObject({ code: 'WORKFLOW_INVALID_BINDING' });
  });

  it('resolves an existing semantic effect before terminal-state validation', async () => {
    await withHarness({}, async (harness) => {
      const selected = [harness.requestIds[0]];
      const snapshot = await harness.addSnapshot(selected);
      const prepared = await harness.prepare(selected, snapshot);
      const action = prepared.pendingAction;
      expect(action === null).toBe(false);
      const confirmed = await harness.runner.confirm(harness.sessionId, action!.id, 'runtime-confirm-existing', operationContextFor(action!));
      expect(confirmed.error).toBeNull();
      expect(confirmed.receipt?.outcome).toBe('verified_success');
      const validationsBeforeRepeat = harness.counters.validate;
      const repeated = await harness.prepare(selected, snapshot);
      expect(repeated.outcome).toBe('already_completed');
      expect(repeated.existingExecutionId).toBe(confirmed.receipt?.id);
      expect(repeated.currentStates).toMatchObject([{ ref: { table: 'onboarding_requests', id: selected[0] }, state: 'director_approved', rowVersion: 4 }]);
      expect(harness.counters.validate).toBe(validationsBeforeRepeat);
      expect(harness.counters.execute).toBe(1);
      expect(await rawCount(harness.fixture,
        'SELECT COUNT(*) AS count FROM onboarding_approval_events WHERE request_id = ? AND stage = ?', selected[0], 'director')).toBe(1);
    });
  });

  it('fails closed on mixed or unprovable existing semantic effects before validation', async () => {
    await withHarness({}, async (harness) => {
      const firstId = harness.requestIds[0];
      const secondId = harness.requestIds[1];
      const firstSnapshot = await harness.addSnapshot([firstId]);
      const first = await harness.prepare([firstId], firstSnapshot);
      const confirmed = await harness.runner.confirm(harness.sessionId, first.pendingAction!.id, 'runtime-confirm-first', operationContextFor(first.pendingAction!));
      expect(confirmed.receipt?.outcome).toBe('verified_success');
      const validationsAfterFirst = harness.counters.validate;

      const mixed = await harness.prepare([firstId, secondId]);
      expect(mixed.outcome).toBe('stale');
      expect(mixed.pendingAction).toBeNull();
      expect(harness.counters.validate).toBe(validationsAfterFirst);

      const secondRequest = await harness.store.workflowProjectionReader.get<RequestRow>('onboarding_requests', secondId);
      if (!secondRequest) throw new Error('Missing second controlled request');
      const actualSemanticKey = digest({
        kind: 'onboarding_director_approve', requestId: secondId,
        lifecycleId: secondRequest.body.lifecycleId, transition: 'director_approve',
      });
      await harness.store.workflowTransaction((tx) => tx.insertUnique('semantic_effects', {
        id: `unprovable-${actualSemanticKey}`,
        rowVersion: 1,
        semanticKey: actualSemanticKey,
        executionId: confirmed.receipt!.id,
        effectType: 'onboarding_approval_events',
        effectId: `missing-director-event-${randomUUID().replaceAll('-', '')}`,
        status: 'committed',
        createdAt: NOW,
      }, { constraint: 'semantic_effects_key_unique', values: { semanticKey: actualSemanticKey } }));
      const validationsBeforeUnprovable = harness.counters.validate;
      const unprovable = await harness.prepare([secondId]);
      expect(unprovable.outcome).toBe('stale');
      expect(unprovable.pendingAction).toBeNull();
      expect(harness.counters.validate).toBe(validationsBeforeUnprovable);
      expect(await rawCount(harness.fixture, 'SELECT COUNT(*) AS count FROM pending_actions')).toBe(1);
    });
  });

});
