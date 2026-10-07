import { z } from 'zod';
import type { Store } from '../contracts';
import { RuntimeCatalog, defaultRuntimes } from './runtime-catalog';
import type { TrustedPackRuntime, WorkflowToolBinding } from './runtime-contracts';
import { DomainError, invariant } from './errors';
import { digest } from './utils';
import { releaseRevision } from './release';
import { createSalesWorkflowBindings, createSalesWorkflowBindingsWithoutShare } from '../packs/sales-workflows';
import { createOperationsWorkflowBindings } from '../packs/operations-workflows';
import { createHrApprovalWorkflowBindings } from '../packs/hr-approval-workflows';
import { createHrOperationsWorkflowBindings, getHrOperationsWorkflowAvailability } from '../packs/hr-operations-workflows';
import { readWorkflowEvidence } from '../packs/retail/workflow-evidence';
import { createWorkflowActionRuntime, type WorkflowPreparationModePin, type WorkflowRuntimeOptions } from '../workflows/action-runtime';
import { createWorkflowActionRunner } from '../workflows/action-runner';
import { getWorkflowActionAuthority } from '../workflows/action-authority';
import { reloadWorkflowPrincipal } from '../workflows/authority';
import { createOnboardingQueryService } from '../workflows/onboarding-queries';
import { createDashboardAccess, type DashboardShareSigningOptions } from '../workflows/dashboard-access';
import { getDemoWorkflowPolicyV1Pin } from '../workflows/policy';
import type { WorkflowStoreCapability } from '../storage/workflow-projections';
import {
  directoryIdentitySchema, instantSchema, onboardingRequestSchema, refSchema, workflowEntityTableSchema,
  pendingActionV2Schema, preparationResultSchema, reviewSnapshotSchema, workflowActionKinds, workflowActionPayloadSchema, policyPinSchema,
  type PolicyPin,
} from '../workflows/contracts';
import { projectWorkflowCapabilities, projectWorkflowSuggestions, workflowActionPresentation, directorStartDatesInputSchema,
  directorStartDatesResultSchema, directorRequestDocumentsInputSchema, directorRequestDocumentsResultSchema,
  readDirectorStartDates, readDirectorRequestDocuments, type WorkflowBindingAvailability, type WorkflowCapabilitySelection, type WorkflowSuggestionContext } from './workflow-capabilities';

export interface TrustedWorkflowRuntimeOptions {
  readonly store: Store & WorkflowStoreCapability;
  readonly businessDate: string;
  /** Evidence is supplied by the transaction-bound retail adapter; the service supplies dashboard selection only. */
  readonly contextFactory: (...args: Parameters<WorkflowRuntimeOptions['contextFactory']>) => Pick<ReturnType<WorkflowRuntimeOptions['contextFactory']>, 'latestDashboard'>;
  readonly dashboardShareSigning?: DashboardShareSigningOptions;
  readonly catalog?: RuntimeCatalog;
  readonly runtimes?: TrustedPackRuntime[];
  readonly getReleaseRevision?: () => string;
  readonly policyPin?: PolicyPin;
  readonly now?: () => Date;
  readonly makeId?: (prefix: string) => string;
}
export interface WorkflowBrokerRequest extends WorkflowPreparationModePin {
  readonly conversationId: string;
  readonly turnId: string;
}

const identifier = directoryIdentitySchema.shape.id;
const brokerRequestSchema = z.object({
  conversationId: identifier,
  turnId: identifier,
  expectedMode: pendingActionV2Schema.shape.mode,
  expectedModeRevision: pendingActionV2Schema.shape.modeRevision,
}).strict();
const queueInputSchema = z.object({ cursor: identifier.optional(), limit: z.number().int().min(1).max(100).optional() }).strict();
const employeeViewSchema = z.object({ id: identifier, name: z.string().min(1), active: z.boolean(), branchId: identifier }).strict();
const requestViewSchema = onboardingRequestSchema.pick({ id: true, employeeId: true, orgUnitId: true, startDate: true,
  state: true, rowVersion: true, lifecycleId: true, createdAt: true, updatedAt: true });
const queueItemSchema = z.object({ request: requestViewSchema, employee: employeeViewSchema,
  documents: z.array(z.object({ id: identifier, documentType: z.string().min(1), status: z.literal('accepted') }).strict()) }).strict();
const queueResultSchema = z.object({ snapshot: reviewSnapshotSchema, items: z.array(queueItemSchema).max(100),
  snapshotTargets: z.array(z.object({ id: identifier, snapshotId: identifier, entityType: workflowEntityTableSchema, targetId: identifier,
    ref: refSchema, expectedRowVersion: z.number().int().positive(), expectedState: z.string().nullable() }).strict()),
  nextCursor: identifier.nullable() }).strict();
const approvalViewSchema = z.object({ eventId: identifier, actorIdentityId: identifier, approvedAt: instantSchema }).strict();
const readyResultSchema = z.object({ asOf: instantSchema, items: z.array(queueItemSchema.extend({
  approvals: z.object({ manager: approvalViewSchema, director: approvalViewSchema }).strict() }).strict()).max(100), nextCursor: identifier.nullable() }).strict();
const approvalsTodaySchema = z.object({ asOf: instantSchema, items: z.array(z.object({ request: requestViewSchema, employee: employeeViewSchema,
  approval: approvalViewSchema.extend({ actorName: z.string().min(1) }).strict() }).strict()).max(100), nextCursor: identifier.nullable() }).strict();

/** Four department factories, one action engine, one trusted catalog, no provider or storage construction. */
export function createTrustedWorkflowRuntime(options: TrustedWorkflowRuntimeOptions) {
  invariant(!(options.catalog && options.runtimes), 'WORKFLOW_INVALID_BINDING', 'Supply either the trusted catalog or trusted runtimes');
  const catalog = options.catalog ?? new RuntimeCatalog(options.runtimes ?? defaultRuntimes);
  const policy = policyPinSchema.parse(options.policyPin ?? getDemoWorkflowPolicyV1Pin());
  invariant(digest(policy) === digest(getDemoWorkflowPolicyV1Pin()), 'WORKFLOW_CONFIGURATION_UNAVAILABLE', 'Only the current versioned demo policy is supported', 503);
  const bindings = [...createSalesWorkflowBindingsWithoutShare(), ...createOperationsWorkflowBindings(), ...createHrApprovalWorkflowBindings(), ...createHrOperationsWorkflowBindings()];
  let dashboardAccess: ReturnType<typeof createDashboardAccess> | null = null;
  let salesFailure: string | null = null;
  if (options.dashboardShareSigning) {
    try {
      // Both factories snapshot the same real server configuration; no generated fallback secret.
      const salesBindings = createSalesWorkflowBindings({ dashboardShareSigning: options.dashboardShareSigning });
      dashboardAccess = createDashboardAccess({ store: options.store, signing: options.dashboardShareSigning, now: options.now, makeId: options.makeId });
      const share = salesBindings.find(binding => binding.kind === 'dashboard_share');
      invariant(share, 'WORKFLOW_INVALID_BINDING', 'The trusted dashboard share binding is unavailable');
      bindings.push(share);
    } catch (error) {
      if (!(error instanceof DomainError) || !['WORKFLOW_UNAVAILABLE', 'SHARE_CONFIGURATION_INVALID', 'SHARE_KEY_UNAVAILABLE'].includes(error.code)) throw error;
      salesFailure = 'Sales action signing configuration is unavailable.';
    }
  } else salesFailure = 'Sales action signing configuration is required.';
  const hrReadiness = getHrOperationsWorkflowAvailability();
  const availability: readonly WorkflowBindingAvailability[] = Object.freeze(workflowActionKinds.map(kind => {
    const hr = hrReadiness.find(item => item.kind === kind), registered = bindings.some(binding => binding.kind === kind);
    if (!registered) return Object.freeze({ kind, available: false, reason: salesFailure ?? 'The trusted action binding is unavailable.', code: 'WORKFLOW_CONFIGURATION_UNAVAILABLE' as const });
    return Object.freeze({ kind, available: hr?.available ?? true, reason: hr?.reason ?? null, code: 'WORKFLOW_SCHEMA_UNAVAILABLE' as const });
  }));

  // Session/request closures are created only by broker(), after the runtime is fully composed.
  const toolDefinitions = (sessionId: string, request: WorkflowBrokerRequest): readonly WorkflowToolBinding[] => {
    identifier.parse(sessionId);
    // Snapshot server-owned turn state before closures are exposed; model arguments contain only the payload.
    const pinnedRequest = Object.freeze(brokerRequestSchema.parse(request));
    const tools: WorkflowToolBinding[] = [];
    for (const item of availability) {
      if (!item.available) continue;
      const authority = getWorkflowActionAuthority(item.kind), binding = bindings.find(candidate => candidate.kind === item.kind);
      invariant(binding, 'WORKFLOW_INVALID_BINDING', 'The trusted action registration disappeared');
      const inputSchema = workflowActionPayloadSchema.options.find(schema => schema.shape.kind.value === item.kind);
      invariant(inputSchema, 'WORKFLOW_INVALID_BINDING', 'The action input schema is unavailable');
      tools.push({ descriptor: { name: `workflow.prepare_${item.kind}`, description: `${workflowActionPresentation(item.kind).title}. Prepare an immutable review; business effects require explicit confirmation.`,
        permission: authority.permission, audit: 'prepare', timeoutMs: 20_000, inputSchema, resultSchema: preparationResultSchema },
        packIds: binding.packIds, authority: { permission: authority.permission, roles: authority.roles, purpose: authority.purpose }, readPermissions: authority.readPermissions,
        run: async args => runtime.prepare(sessionId, workflowActionPayloadSchema.parse(args),
          { conversationId: pinnedRequest.conversationId, turnId: pinnedRequest.turnId },
          { expectedMode: pinnedRequest.expectedMode, expectedModeRevision: pinnedRequest.expectedModeRevision }) });
    }
    tools.push({ descriptor: { name: 'workflow.manager_queue', description: 'Read the current authorized manager onboarding queue and its immutable reviewed snapshot.',
      permission: 'hr.onboarding.manager_read', audit: 'read', timeoutMs: 20_000, inputSchema: queueInputSchema, resultSchema: queueResultSchema },
      packIds: ['hr'], authority: { permission: 'hr.onboarding.manager_read', roles: ['east_manager'], purpose: 'manager_onboarding' }, readPermissions: [],
      run: args => createOnboardingQueryService(runtime).managerQueue(sessionId, queueInputSchema.parse(args)) });
    tools.push({ descriptor: { name: 'workflow.director_queue', description: 'Read the current authorized Director onboarding queue and its immutable reviewed snapshot.',
      permission: 'hr.onboarding.director_read', audit: 'read', timeoutMs: 20_000, inputSchema: queueInputSchema, resultSchema: queueResultSchema },
      packIds: ['hr'], authority: { permission: 'hr.onboarding.director_read', roles: ['hr_director'], purpose: 'director_onboarding' }, readPermissions: [],
      run: args => createOnboardingQueryService(runtime).directorQueue(sessionId, queueInputSchema.parse(args)) });
    tools.push({ descriptor: { name: 'workflow.director_approvals_today', description: 'Read independently verified Director approvals in the current Bangkok calendar day.',
      permission: 'hr.onboarding.director_read', audit: 'read', timeoutMs: 20_000, inputSchema: queueInputSchema, resultSchema: approvalsTodaySchema },
      packIds: ['hr'], authority: { permission: 'hr.onboarding.director_read', roles: ['hr_director'], purpose: 'director_onboarding' }, readPermissions: [],
      run: args => createOnboardingQueryService(runtime).directorApprovalsToday(sessionId, queueInputSchema.parse(args)) });
    tools.push({ descriptor: { name: 'workflow.director_start_dates', description: 'Read start dates for exact requests in a current authorized reviewed Director queue snapshot.',
      permission: 'hr.onboarding.director_read', audit: 'read', timeoutMs: 20_000, inputSchema: directorStartDatesInputSchema, resultSchema: directorStartDatesResultSchema },
      packIds: ['hr'], authority: { permission: 'hr.onboarding.director_read', roles: ['hr_director'], purpose: 'director_onboarding' }, readPermissions: [],
      run: args => readDirectorStartDates(runtime, sessionId, directorStartDatesInputSchema.parse(args)) });
    tools.push({ descriptor: { name: 'workflow.director_request_documents', description: 'Read accepted document references for one exact request in a current authorized reviewed Director queue snapshot.',
      permission: 'hr.onboarding.director_read', audit: 'read', timeoutMs: 20_000, inputSchema: directorRequestDocumentsInputSchema, resultSchema: directorRequestDocumentsResultSchema },
      packIds: ['hr'], authority: { permission: 'hr.onboarding.director_read', roles: ['hr_director'], purpose: 'director_onboarding' }, readPermissions: [],
      run: args => readDirectorRequestDocuments(runtime, sessionId, directorRequestDocumentsInputSchema.parse(args)) });
    tools.push({ descriptor: { name: 'workflow.onboarding_ready_for_start', description: 'Read scoped onboarding requests with verified manager and Director approval, ready for explicit start.',
      permission: 'hr.onboarding.start', audit: 'read', timeoutMs: 20_000, inputSchema: queueInputSchema, resultSchema: readyResultSchema },
      packIds: ['hr'], authority: { permission: 'hr.onboarding.start', roles: ['hr_admin'], purpose: 'hr_operations' }, readPermissions: ['hr.read'],
      run: args => createOnboardingQueryService(runtime).readyForStart(sessionId, queueInputSchema.parse(args)) });
    return Object.freeze(tools);
  };
  // Pin the closed descriptors/callbacks without capturing a live session or actor in pack identity.
  const pinTools = toolDefinitions('pin-session', { conversationId: 'pin-conversation', turnId: 'pin-turn',
    expectedMode: 'scripted_demo', expectedModeRevision: 0 });
  const runtime = createWorkflowActionRuntime({ store: options.store, bindings, businessDate: options.businessDate,
    contextFactory: (reader, principal, view) => ({
      latestDashboard: options.contextFactory(reader, principal, view).latestDashboard,
      evidence: scope => readWorkflowEvidence({ projections: view.projections, principal, now: view.now() }, scope),
    }), getReleaseRevision: options.getReleaseRevision ?? releaseRevision,
    getPackPins: ids => catalog.workflowPins(ids, pinTools),
    // V2's closed action authority declares its own exact reads; V1's broad pack read policy would wrongly require
    // general HR access for manager/Director approvals. Do not inherit those V1 source policies here.
    getReadPermissions: () => [], now: options.now, makeId: options.makeId });
  const runner = createWorkflowActionRunner(runtime), onboarding = createOnboardingQueryService(runtime);
  return Object.freeze({ catalog, runtime, runner, onboarding, dashboardAccess, availability, policy,
    capabilities: (sessionId: string, selection?: WorkflowCapabilitySelection) => projectWorkflowCapabilities(runtime, sessionId, availability, selection),
    suggestions: (sessionId: string, context: WorkflowSuggestionContext, selection?: WorkflowCapabilitySelection) => projectWorkflowSuggestions(runtime, sessionId, availability, context, selection),
    broker: async (sessionId: string, request: WorkflowBrokerRequest) => catalog.workflowBroker({
      bindings: toolDefinitions(sessionId, request),
      loadPrincipal: () => options.store.workflowTransaction(tx => reloadWorkflowPrincipal(tx, sessionId, runtime.now().toISOString())),
    }),
  });
}

export type TrustedWorkflowRuntime = ReturnType<typeof createTrustedWorkflowRuntime>;
