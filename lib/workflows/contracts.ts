import { z } from 'zod';
import { dashboardSpecSchema, scopeSchema } from '../contracts';
import { analysisSchema, evidenceSchema, pendingActionSchema, sourceRefSchema } from '../packs/shared';
import type {
  Analysis,
  Actor,
  DashboardSpec,
  Evidence,
  Mode,
  PackPin,
  PendingAction,
  Reader,
  RowFilter,
  Scope,
  SourceRef,
  Store,
  Table,
  Transaction
} from '../contracts';
import type { PackReadContext } from '../core/runtime-contracts';

/**
 * V2 contracts remain separate from the exhaustive V1 role/action unions.
 * These schemas validate shape and cross-field consistency only; every caller
 * still needs current server authorization and guarded storage/CAS enforcement.
 */
export const MAX_WORKFLOW_TARGETS = 100;
export const MAX_WORKFLOW_REASON_CHARS = 500;

const identifierSchema = z.string().min(1).max(160).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
  'Identifier contains unsupported characters'
);
const shortTextSchema = z.string().min(1).max(500).refine(value => value.trim().length > 0, 'Text cannot be blank');
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/i, 'Expected a SHA-256 hex digest');
const positiveIntegerSchema = z.number().int().min(1);
const nonnegativeIntegerSchema = z.number().int().min(0);

function addUniqueIssue<T>(
  values: readonly T[],
  context: z.RefinementCtx,
  keyOf: (value: T) => string,
  label: string
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    const key = keyOf(value);
    if (seen.has(key)) {
      context.addIssue({ code: 'custom', path: [index], message: `Duplicate ${label}` });
    }
    seen.add(key);
  });
}

function uniqueIdArray(maximum = MAX_WORKFLOW_TARGETS, minimum = 0) {
  return z.array(identifierSchema).min(minimum).max(maximum).superRefine((values, context) => {
    addUniqueIssue(values, context, value => value, 'identifier');
  });
}

function uniqueTargetArray<T>(
  itemSchema: z.ZodType<T>,
  identityOf: (item: T) => string,
  minimum = 1
) {
  return z.array(itemSchema).min(minimum).max(MAX_WORKFLOW_TARGETS).superRefine((items, context) => {
    addUniqueIssue(items, context, identityOf, 'target');
  });
}

export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  if (value.startsWith('0000-')) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, 'Expected a valid ISO calendar date');
export type ISODate = z.infer<typeof isoDateSchema>;

export const instantSchema = z.string().datetime({ offset: true }).refine(value => Number.isFinite(Date.parse(value)), 'Expected an ISO instant with an offset');
export type Instant = z.infer<typeof instantSchema>;

export const rowVersionSchema = positiveIntegerSchema;
export type RowVersion = z.infer<typeof rowVersionSchema>;

export const roleV2Schema = z.enum(['executive', 'east_manager', 'hr_admin', 'hr_director']);
export type RoleV2 = z.infer<typeof roleV2Schema>;

export const deliveryChannelSchema = z.enum(['simulated_email', 'simulated_slack']);
export type DeliveryChannel = z.infer<typeof deliveryChannelSchema>;

export const workflowOutcomeSchema = z.enum([
  'pending',
  'verified_success',
  'already_completed',
  'denied',
  'stale',
  'failed'
]);
export type WorkflowOutcome = z.infer<typeof workflowOutcomeSchema>;

export const executionModeSchema = z.enum(['per_target', 'atomic_local']);
export type ExecutionMode = z.infer<typeof executionModeSchema>;

export const policyPinSchema = z.object({
  id: z.literal('demo-workflow'),
  version: z.literal(1),
  digest: digestSchema
}).strict();
export type PolicyPin = z.infer<typeof policyPinSchema>;

const deliveryChannelArraySchema = z.array(deliveryChannelSchema).max(2).superRefine((values, context) => {
  addUniqueIssue(values, context, value => value, 'delivery channel');
});

export const directoryIdentitySchema = z.object({
  id: identifierSchema,
  profileId: identifierSchema,
  displayName: shortTextSchema.max(160),
  active: z.boolean(),
  role: roleV2Schema,
  department: z.enum(['sales_operations', 'hr']),
  orgUnitId: identifierSchema,
  managerIdentityId: identifierSchema.nullable(),
  verifiedDemoEmail: z.email().max(254),
  slackIdentity: identifierSchema.nullable(),
  allowedChannels: deliveryChannelArraySchema,
  classificationCeiling: z.literal('internal'),
  rowVersion: rowVersionSchema
}).strict();
export type DirectoryIdentity = z.infer<typeof directoryIdentitySchema>;

export const responsibilitySchema = z.object({
  id: identifierSchema,
  identityId: identifierSchema,
  orgUnitId: identifierSchema,
  purpose: z.enum(['sales_operations', 'manager_onboarding', 'director_onboarding', 'hr_operations']),
  branchIds: uniqueIdArray(),
  active: z.boolean(),
  rowVersion: rowVersionSchema
}).strict();
export type Responsibility = z.infer<typeof responsibilitySchema>;

export const versionedDemoWorkflowPolicySchema = z.object({
  id: z.literal('demo-workflow'),
  version: z.literal(1),
  timezone: z.literal('Asia/Bangkok'),
  classification: z.literal('internal'),
  pendingTtlSeconds: positiveIntegerSchema,
  shareTtlSeconds: positiveIntegerSchema,
  shareSigning: z.object({
    purpose: z.literal('nexus/share-url/v1'),
    keyVersion: positiveIntegerSchema
  }).strict(),
  requiredOnboardingDocuments: z.array(z.enum(['identity_document', 'signed_offer', 'signed_contract']))
    .length(3)
    .superRefine((values, context) => addUniqueIssue(values, context, value => value, 'required document'))
    .readonly(),
  restock: z.object({
    targetMinimumMultiplier: positiveIntegerSchema,
    maxQuantity: positiveIntegerSchema,
    maxEvidenceAgeHours: positiveIntegerSchema
  }).strict(),
  crmInactiveDays: positiveIntegerSchema,
  tasks: z.object({
    normalDueDays: positiveIntegerSchema,
    highDueDays: positiveIntegerSchema,
    defaultPriority: z.enum(['normal', 'high'])
  }).strict(),
  contractReminderDays: positiveIntegerSchema,
  incident: z.object({
    from: z.literal('un_escalated'),
    to: z.literal('team_requested'),
    targetTeam: z.literal('demo_operations')
  }).strict(),
  discount: z.object({
    minBasisPoints: positiveIntegerSchema,
    maxBasisPoints: positiveIntegerSchema,
    initialStage: z.literal('manager_review_pending')
  }).strict(),
  onboardingTaskTemplates: z.array(z.enum(['hr_welcome', 'it_setup_request', 'policy_acknowledgement']))
    .length(3)
    .superRefine((values, context) => addUniqueIssue(values, context, value => value, 'onboarding template'))
    .readonly(),
  offboardingTaskTemplates: z.array(z.enum(['it_disable_request', 'asset_return', 'badge_review']))
    .length(3)
    .superRefine((values, context) => addUniqueIssue(values, context, value => value, 'offboarding template'))
    .readonly(),
  policyAcknowledgementVersion: z.string().min(1).max(100),
  maxBatchTargets: positiveIntegerSchema.max(MAX_WORKFLOW_TARGETS),
  maxReasonChars: positiveIntegerSchema.max(2_000),
  connectorMode: z.literal('simulated_only')
}).strict().superRefine((policy, context) => {
  if (policy.discount.maxBasisPoints < policy.discount.minBasisPoints) {
    context.addIssue({ code: 'custom', path: ['discount', 'maxBasisPoints'], message: 'Maximum basis points must be at least the minimum' });
  }
  if (policy.tasks.highDueDays > policy.tasks.normalDueDays) {
    context.addIssue({ code: 'custom', path: ['tasks', 'highDueDays'], message: 'High-priority due days cannot exceed normal-priority due days' });
  }
});
export type VersionedDemoWorkflowPolicy = z.infer<typeof versionedDemoWorkflowPolicySchema>;

export const defaultDemoWorkflowPolicy = Object.freeze({
  id: 'demo-workflow',
  version: 1,
  timezone: 'Asia/Bangkok',
  classification: 'internal',
  pendingTtlSeconds: 600,
  shareTtlSeconds: 86_400,
  shareSigning: Object.freeze({ purpose: 'nexus/share-url/v1', keyVersion: 1 }),
  requiredOnboardingDocuments: Object.freeze(['identity_document', 'signed_offer', 'signed_contract']),
  restock: Object.freeze({ targetMinimumMultiplier: 2, maxQuantity: 1_000, maxEvidenceAgeHours: 24 }),
  crmInactiveDays: 14,
  tasks: Object.freeze({ normalDueDays: 3, highDueDays: 1, defaultPriority: 'normal' }),
  contractReminderDays: 30,
  incident: Object.freeze({ from: 'un_escalated', to: 'team_requested', targetTeam: 'demo_operations' }),
  discount: Object.freeze({ minBasisPoints: 1, maxBasisPoints: 10_000, initialStage: 'manager_review_pending' }),
  onboardingTaskTemplates: Object.freeze(['hr_welcome', 'it_setup_request', 'policy_acknowledgement']),
  offboardingTaskTemplates: Object.freeze(['it_disable_request', 'asset_return', 'badge_review']),
  policyAcknowledgementVersion: '1.0',
  maxBatchTargets: 100,
  maxReasonChars: MAX_WORKFLOW_REASON_CHARS,
  connectorMode: 'simulated_only'
} as const satisfies VersionedDemoWorkflowPolicy);

/** Compatibility name used by the V2 design document. */
export const demoWorkflowPolicyV1 = defaultDemoWorkflowPolicy;

export const workflowEntityTables = [
  'branches',
  'products',
  'sales_orders',
  'sales_targets',
  'inventory_snapshots',
  'incidents',
  'staffing_summaries',
  'employees',
  'mock_badges',
  'mock_tickets',
  'conversations',
  'dashboards',
  'dashboard_versions',
  'dashboard_shares',
  'dashboard_share_revoke_events',
  'share_scope_branches',
  'simulated_deliveries',
  'share_access_events',
  'org_units',
  'directory_identities',
  'responsibilities',
  'reporting_relationships',
  'workflow_policies',
  'review_snapshots',
  'review_snapshot_targets',
  'pending_actions',
  'action_confirmations',
  'action_idempotency_roots',
  'action_executions',
  'action_targets',
  'semantic_effects',
  'investigation_cases',
  'investigation_tasks',
  'branch_review_assignments',
  'restock_requests',
  'crm_customers',
  'crm_opportunities',
  'crm_activities',
  'crm_followups',
  'discount_requests',
  'workflow_teams',
  'incident_escalation_events',
  'onboarding_requests',
  'onboarding_documents',
  'onboarding_approval_events',
  'onboarding_checklists',
  'onboarding_tasks',
  'offboarding_cases',
  'offboarding_plans',
  'planned_actions',
  'it_disable_requests',
  'assets',
  'asset_assignments',
  'asset_return_tasks',
  'employment_contracts',
  'contract_reminders',
  'policy_documents',
  'policy_acknowledgement_tasks',
  'badge_effect_events',
  'audit_events'
] as const;
export const workflowEntityTableSchema = z.enum(workflowEntityTables);
export type WorkflowEntityTable = z.infer<typeof workflowEntityTableSchema>;
export type WorkflowStorageTable = Table | WorkflowEntityTable;

export const refSchema = z.object({ table: workflowEntityTableSchema, id: identifierSchema }).strict();
export type Ref = z.infer<typeof refSchema>;

function refKey(ref: Ref): string {
  return JSON.stringify([ref.table, ref.id]);
}

export const expectedRowSchema = z.object({
  ref: refSchema,
  rowVersion: rowVersionSchema,
  state: z.string().min(1).max(100).nullable()
}).strict();
export type ExpectedRow = z.infer<typeof expectedRowSchema>;

const expectedRowsSchema = z.array(expectedRowSchema).max(500).superRefine((rows, context) => {
  addUniqueIssue(rows, context, row => refKey(row.ref), 'expected row reference');
});

export const targetSpecSchema = z.object({
  targetId: identifierSchema,
  ref: refSchema,
  semanticKey: identifierSchema,
  expectedRows: expectedRowsSchema,
  ownerIdentityId: identifierSchema.nullable(),
  expectedEffectRef: refSchema,
  expectedEffectVersion: rowVersionSchema
}).strict().superRefine((target, context) => {
  const effectRefKey = refKey(target.expectedEffectRef);
  const matchingRows = target.expectedRows.filter(row => refKey(row.ref) === effectRefKey);

  if (matchingRows.length > 1) {
    context.addIssue({
      code: 'custom',
      path: ['expectedRows'],
      message: 'Expected effect reference matches more than one precondition row'
    });
    return;
  }

  const expectedVersion = matchingRows.length === 0 ? 1 : matchingRows[0].rowVersion + 1;
  if (target.expectedEffectVersion !== expectedVersion) {
    context.addIssue({
      code: 'custom',
      path: ['expectedEffectVersion'],
      message: matchingRows.length === 0
        ? 'An inserted effect must start at row version 1'
        : 'A transitioned effect must increment its expected row version by 1'
    });
  }
});
export type TargetSpec = z.infer<typeof targetSpecSchema>;

const targetSpecsSchema = z.array(targetSpecSchema).min(1).max(MAX_WORKFLOW_TARGETS).superRefine((targets, context) => {
  addUniqueIssue(targets, context, target => target.targetId, 'target ID');
  addUniqueIssue(targets, context, target => refKey(target.expectedEffectRef), 'expected effect reference');
});

const taskFieldsShape = {
  ownerIdentityId: identifierSchema,
  reason: z.string().min(1).max(MAX_WORKFLOW_REASON_CHARS).refine(value => value.trim().length > 0, 'Reason cannot be blank'),
  dueDate: isoDateSchema,
  priority: z.enum(['normal', 'high'])
};

const investigationTargetSchema = z.object({
  ...taskFieldsShape,
  branchId: identifierSchema,
  caseId: identifierSchema,
  sourceIds: uniqueIdArray(100, 1),
  unansweredQuestion: z.string().min(1).max(1_000).refine(value => value.trim().length > 0, 'Question cannot be blank')
}).strict();

const restockTargetSchema = z.object({
  ...taskFieldsShape,
  inventorySnapshotId: identifierSchema,
  branchId: identifierSchema,
  productId: identifierSchema,
  quantity: z.number().int().min(1).max(defaultDemoWorkflowPolicy.restock.maxQuantity)
}).strict();

const crmFollowupTargetSchema = z.object({ ...taskFieldsShape, opportunityId: identifierSchema }).strict();
const incidentEscalationTargetSchema = z.object({
  incidentId: identifierSchema,
  targetTeamId: z.literal('demo_operations'),
  evidenceIds: uniqueIdArray(100, 1),
  reason: z.string().min(1).max(MAX_WORKFLOW_REASON_CHARS).refine(value => value.trim().length > 0, 'Reason cannot be blank')
}).strict();
const branchReviewTargetSchema = z.object({ ...taskFieldsShape, branchId: identifierSchema, caseId: identifierSchema }).strict();
const onboardingTaskTargetSchema = z.object({
  ...taskFieldsShape,
  templateId: z.enum(['hr_welcome', 'it_setup_request', 'policy_acknowledgement'])
}).strict();
const assetReturnTargetSchema = z.object({ ...taskFieldsShape, assetAssignmentId: identifierSchema }).strict();
const contractReminderTargetSchema = z.object({ ...taskFieldsShape, contractId: identifierSchema }).strict();
const policyAcknowledgementTargetSchema = z.object({ ...taskFieldsShape, employeeId: identifierSchema }).strict();

const requestIdsSchema = uniqueIdArray(defaultDemoWorkflowPolicy.maxBatchTargets, 1);
const safeShareTextSchema = (maximum: number) => z.string().min(1).max(maximum).refine(
  value => value.trim().length > 0 && !/(?:https?:\/\/|(?:^|[?&\s])sig=|\/shared\/[A-Za-z0-9._-]+\?)/i.test(value),
  'Share text cannot supply a URL or signature'
);

export const workflowActionKinds = [
  'dashboard_create',
  'dashboard_share',
  'dashboard_share_revoke',
  'investigation_create',
  'restock_create',
  'crm_followup_create',
  'incident_escalate',
  'discount_request_create',
  'branch_review_assign',
  'onboarding_manager_approve',
  'onboarding_director_approve',
  'onboarding_return',
  'onboarding_start',
  'onboarding_tasks_create',
  'offboarding_plan_create',
  'it_disable_request',
  'asset_return_create',
  'badge_revoke',
  'contract_reminder_create',
  'policy_acknowledgement_assign'
] as const;

export const workflowActionPayloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('dashboard_create'), spec: dashboardSpecSchema }).strict(),
  z.object({
    kind: z.literal('dashboard_share'),
    dashboardId: identifierSchema,
    recipientIdentityId: identifierSchema,
    channel: deliveryChannelSchema,
    subject: safeShareTextSchema(200),
    body: safeShareTextSchema(2_000)
  }).strict(),
  z.object({ kind: z.literal('dashboard_share_revoke'), shareId: identifierSchema }).strict(),
  z.object({
    kind: z.literal('investigation_create'),
    businessDate: isoDateSchema,
    targets: uniqueTargetArray(investigationTargetSchema, target => JSON.stringify([target.branchId, target.caseId]))
  }).strict(),
  z.object({
    kind: z.literal('restock_create'),
    targets: uniqueTargetArray(restockTargetSchema, target => JSON.stringify([target.branchId, target.productId]))
  }).strict(),
  z.object({
    kind: z.literal('crm_followup_create'),
    targets: uniqueTargetArray(crmFollowupTargetSchema, target => target.opportunityId)
  }).strict(),
  z.object({
    kind: z.literal('incident_escalate'),
    targets: uniqueTargetArray(incidentEscalationTargetSchema, target => target.incidentId)
  }).strict(),
  z.object({
    kind: z.literal('discount_request_create'),
    opportunityId: identifierSchema,
    requestedBasisPoints: z.number().int()
      .min(defaultDemoWorkflowPolicy.discount.minBasisPoints)
      .max(defaultDemoWorkflowPolicy.discount.maxBasisPoints),
    baseAmountSatang: nonnegativeIntegerSchema,
    reason: z.string().min(1).max(MAX_WORKFLOW_REASON_CHARS).refine(value => value.trim().length > 0, 'Reason cannot be blank'),
    ownerIdentityId: identifierSchema
  }).strict(),
  z.object({
    kind: z.literal('branch_review_assign'),
    businessDate: isoDateSchema,
    targets: uniqueTargetArray(branchReviewTargetSchema, target => JSON.stringify([target.branchId, target.caseId]))
  }).strict(),
  z.object({ kind: z.literal('onboarding_manager_approve'), snapshotId: identifierSchema, requestIds: requestIdsSchema }).strict(),
  z.object({ kind: z.literal('onboarding_director_approve'), snapshotId: identifierSchema, requestIds: requestIdsSchema }).strict(),
  z.object({
    kind: z.literal('onboarding_return'),
    snapshotId: identifierSchema,
    requestIds: requestIdsSchema,
    reason: z.string().min(1).max(MAX_WORKFLOW_REASON_CHARS).refine(value => value.trim().length > 0, 'Reason cannot be blank')
  }).strict(),
  z.object({ kind: z.literal('onboarding_start'), requestId: identifierSchema }).strict(),
  z.object({
    kind: z.literal('onboarding_tasks_create'),
    requestId: identifierSchema,
    targets: uniqueTargetArray(onboardingTaskTargetSchema, target => target.templateId)
  }).strict(),
  z.object({ kind: z.literal('offboarding_plan_create'), caseId: identifierSchema }).strict(),
  z.object({
    kind: z.literal('it_disable_request'),
    caseId: identifierSchema,
    planId: identifierSchema,
    effectiveDate: isoDateSchema,
    reason: z.string().min(1).max(MAX_WORKFLOW_REASON_CHARS).refine(value => value.trim().length > 0, 'Reason cannot be blank')
  }).strict(),
  z.object({
    kind: z.literal('asset_return_create'),
    caseId: identifierSchema,
    planId: identifierSchema,
    targets: uniqueTargetArray(assetReturnTargetSchema, target => target.assetAssignmentId)
  }).strict(),
  z.object({
    kind: z.literal('badge_revoke'),
    badgeId: identifierSchema,
    employeeId: identifierSchema,
    reason: z.string().min(1).max(MAX_WORKFLOW_REASON_CHARS).refine(value => value.trim().length > 0, 'Reason cannot be blank')
  }).strict(),
  z.object({
    kind: z.literal('contract_reminder_create'),
    targets: uniqueTargetArray(contractReminderTargetSchema, target => target.contractId)
  }).strict(),
  z.object({
    kind: z.literal('policy_acknowledgement_assign'),
    policyDocumentId: identifierSchema,
    policyVersion: z.string().min(1).max(100),
    targets: uniqueTargetArray(policyAcknowledgementTargetSchema, target => target.employeeId)
  }).strict()
]);
export type WorkflowPayloadV2 = z.infer<typeof workflowActionPayloadSchema>;
export type WorkflowActionKind = WorkflowPayloadV2['kind'];

export const reviewSnapshotSchema = z.object({
  id: identifierSchema,
  actorId: identifierSchema,
  actorSessionId: identifierSchema,
  purpose: z.enum(['manager_queue', 'director_queue']),
  orgUnitIds: uniqueIdArray(),
  displayedIds: uniqueIdArray(MAX_WORKFLOW_TARGETS),
  count: nonnegativeIntegerSchema,
  expectedRows: expectedRowsSchema,
  policy: policyPinSchema,
  createdAt: instantSchema,
  expiresAt: instantSchema,
  digest: digestSchema
}).strict().superRefine((snapshot, context) => {
  if (snapshot.count !== snapshot.displayedIds.length) {
    context.addIssue({ code: 'custom', path: ['count'], message: 'Snapshot count must equal displayed ID count' });
  }
  if (Date.parse(snapshot.expiresAt) <= Date.parse(snapshot.createdAt)) {
    context.addIssue({ code: 'custom', path: ['expiresAt'], message: 'Snapshot expiry must follow creation time' });
  }
});
export type ReviewSnapshot = z.infer<typeof reviewSnapshotSchema>;
export type ReviewedSnapshot = ReviewSnapshot;

export const onboardingStateSchema = z.enum([
  'draft',
  'manager_review_pending',
  'director_approval_pending',
  'director_approved',
  'onboarding_in_progress',
  'completed',
  'returned_for_revision',
  'rejected',
  'cancelled'
]);
export type OnboardingState = z.infer<typeof onboardingStateSchema>;

export const onboardingRequestSchema = z.object({
  id: identifierSchema,
  employeeId: identifierSchema,
  orgUnitId: identifierSchema,
  managerIdentityId: identifierSchema,
  directorIdentityId: identifierSchema,
  startDate: isoDateSchema,
  state: onboardingStateSchema,
  rowVersion: rowVersionSchema,
  lifecycleId: identifierSchema,
  managerApprovalEventId: identifierSchema.nullable(),
  managerApprovedBy: identifierSchema.nullable(),
  managerApprovedAt: instantSchema.nullable(),
  directorApprovalEventId: identifierSchema.nullable(),
  directorApprovedBy: identifierSchema.nullable(),
  directorApprovedAt: instantSchema.nullable(),
  createdAt: instantSchema,
  updatedAt: instantSchema
}).strict();
export type OnboardingRequest = z.infer<typeof onboardingRequestSchema>;

export const pendingActionV2Schema = z.object({
  id: identifierSchema,
  contractVersion: z.literal(2),
  actorId: identifierSchema,
  sessionId: identifierSchema,
  conversationId: identifierSchema,
  turnId: identifierSchema,
  mode: z.enum(['live_ai', 'scripted_demo']),
  modeRevision: nonnegativeIntegerSchema,
  payload: workflowActionPayloadSchema,
  payloadHash: digestSchema,
  idempotencyKey: digestSchema,
  targets: targetSpecsSchema,
  targetCount: positiveIntegerSchema.max(MAX_WORKFLOW_TARGETS),
  expectedRows: expectedRowsSchema,
  approvedBranchIds: uniqueIdArray(),
  approvedOrgUnitIds: uniqueIdArray(),
  reviewedSnapshotId: identifierSchema.nullable(),
  policy: policyPinSchema,
  packs: z.array(z.object({
    id: identifierSchema,
    version: z.string().min(1).max(100),
    schemaDigest: digestSchema,
    implementationRevision: z.string().min(1).max(300)
  }).strict()).max(50),
  releaseRevision: z.string().min(1).max(200),
  executionMode: executionModeSchema,
  createdAt: instantSchema,
  expiresAt: instantSchema,
  status: z.enum(['pending', 'claimed', 'completed', 'stale'])
}).strict().superRefine((action, context) => {
  if (
    action.payload.kind === 'onboarding_manager_approve' ||
    action.payload.kind === 'onboarding_director_approve' ||
    action.payload.kind === 'onboarding_return'
  ) {
    if (action.reviewedSnapshotId === null || action.reviewedSnapshotId !== action.payload.snapshotId) {
      context.addIssue({
        code: 'custom',
        path: ['reviewedSnapshotId'],
        message: 'Approval and return actions must bind to their exact reviewed snapshot'
      });
    }
  }

  if (action.targetCount !== action.targets.length) {
    context.addIssue({ code: 'custom', path: ['targetCount'], message: 'Target count must equal target list length' });
  }
  if (action.payload.kind === 'onboarding_tasks_create') {
    const requestId = action.payload.requestId;
    action.targets.forEach((target, index) => {
      if (target.ref.table !== 'onboarding_requests' || target.ref.id !== requestId) {
        context.addIssue({ code: 'custom', path: ['targets', index, 'ref'], message: 'Onboarding task targets must reference their payload request' });
      }
      if (target.expectedEffectRef.table !== 'onboarding_tasks') {
        context.addIssue({ code: 'custom', path: ['targets', index, 'expectedEffectRef'], message: 'Onboarding task effects must reference distinct task rows' });
      }
    });
    if (action.targetCount !== action.payload.targets.length) {
      context.addIssue({ code: 'custom', path: ['targetCount'], message: 'Onboarding task target count must equal the reviewed template count' });
    }
  } else {
    const sourceRefs = new Set<string>();
    action.targets.forEach((target, index) => {
      const key = refKey(target.ref);
      if (sourceRefs.has(key)) {
        context.addIssue({ code: 'custom', path: ['targets', index, 'ref'], message: 'Duplicate target reference' });
      }
      sourceRefs.add(key);
    });
  }
  if (Date.parse(action.expiresAt) <= Date.parse(action.createdAt)) {
    context.addIssue({ code: 'custom', path: ['expiresAt'], message: 'Action expiry must follow creation time' });
  }
});
export type PendingActionV2 = z.infer<typeof pendingActionV2Schema>;
export type PendingEnvelopeV2 = PendingActionV2;

export const entityStateSchema = z.object({
  ref: refSchema,
  state: z.string().min(1).max(100),
  rowVersion: rowVersionSchema,
  allowedNextActions: z.array(z.enum(workflowActionKinds)).max(workflowActionKinds.length),
  completedActions: z.array(z.object({
    kind: z.string().min(1).max(100),
    executionId: identifierSchema,
    completedAt: instantSchema
  }).strict()).max(500)
}).strict();
export type CurrentState = z.infer<typeof entityStateSchema>;
export type EntityState = CurrentState;

export const preparationResultSchema = z.object({
  outcome: z.enum(['pending', 'already_completed', 'denied', 'stale']),
  pendingAction: pendingActionV2Schema.nullable(),
  existingExecutionId: identifierSchema.nullable(),
  currentStates: z.array(entityStateSchema).max(500),
  reasons: z.array(z.object({
    code: identifierSchema,
    targetId: identifierSchema.nullable(),
    message: shortTextSchema
  }).strict()).max(500)
}).strict();
export type PreparationResult = z.infer<typeof preparationResultSchema>;

export const targetProofSchema = z.object({
  targetId: identifierSchema,
  ref: refSchema,
  outcome: workflowOutcomeSchema,
  executionId: identifierSchema,
  observedRowVersion: rowVersionSchema.nullable(),
  checkedAt: instantSchema.nullable(),
  mismatchCodes: uniqueIdArray(100)
}).strict().superRefine((proof, context) => {
  if (proof.outcome === 'verified_success') {
    if (proof.observedRowVersion === null) {
      context.addIssue({
        code: 'custom',
        path: ['observedRowVersion'],
        message: 'Verified proof requires an observed positive row version'
      });
    }
    if (proof.checkedAt === null) {
      context.addIssue({
        code: 'custom',
        path: ['checkedAt'],
        message: 'Verified proof requires a committed readback time'
      });
    }
    if (proof.mismatchCodes.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['mismatchCodes'],
        message: 'Verified proof cannot retain mismatch codes'
      });
    }
  }
});
export type TargetProof = z.infer<typeof targetProofSchema>;

export const workflowReceiptV2Schema = z.object({
  id: identifierSchema,
  actionId: identifierSchema,
  contractVersion: z.literal(2),
  actorId: identifierSchema,
  kind: z.enum(workflowActionKinds),
  outcome: workflowOutcomeSchema,
  proofs: z.array(targetProofSchema).max(MAX_WORKFLOW_TARGETS),
  createdAt: instantSchema,
  verifiedAt: instantSchema.nullable(),
  currentStates: z.array(entityStateSchema).max(500)
}).strict().superRefine((receipt, context) => {
  if (receipt.outcome === 'verified_success') {
    if (receipt.verifiedAt === null) {
      context.addIssue({
        code: 'custom',
        path: ['verifiedAt'],
        message: 'Verified receipt requires an independent verification time'
      });
    }
    if (receipt.proofs.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['proofs'],
        message: 'Verified receipt requires at least one successful target proof'
      });
    }
    receipt.proofs.forEach((proof, index) => {
      if (proof.outcome !== 'verified_success') {
        context.addIssue({
          code: 'custom',
          path: ['proofs', index, 'outcome'],
          message: 'Every proof in a verified receipt must be verified_success'
        });
      }
    });
  }
});
export type WorkflowReceiptV2 = z.infer<typeof workflowReceiptV2Schema>;
export type V2Receipt = WorkflowReceiptV2;

export const workflowValidationSchema = z.object({
  targets: targetSpecsSchema,
  expectedRows: expectedRowsSchema,
  approvedBranchIds: uniqueIdArray(),
  approvedOrgUnitIds: uniqueIdArray(),
  policy: policyPinSchema,
  reviewedSnapshotId: identifierSchema.nullable()
}).strict();
export type WorkflowValidation = z.infer<typeof workflowValidationSchema>;

export const committedTargetSchema = z.object({
  targetId: identifierSchema,
  ref: refSchema,
  executionId: identifierSchema,
  rowVersion: rowVersionSchema
}).strict();
export type CommittedTarget = z.infer<typeof committedTargetSchema>;

export type WorkflowActor = Omit<Actor, 'role'> & { role: RoleV2 };

export type WorkflowReader = Reader & {
  list<T>(table: WorkflowStorageTable, filters?: RowFilter): Promise<T[]>;
  get<T>(table: WorkflowStorageTable, id: string): Promise<T | undefined>;
};

export interface WorkflowPackReadContext extends Omit<PackReadContext, 'actor' | 'reader'> {
  actor: WorkflowActor;
  reader: WorkflowReader;
}

export interface WorkflowActionBinding<K extends WorkflowActionKind> {
  kind: K;
  contractVersion: 2;
  packIds: string[];
  executionMode: ExecutionMode;
  validate(
    context: WorkflowPackReadContext,
    payload: Extract<WorkflowPayloadV2, { kind: K }>
  ): Promise<WorkflowValidation>;
  executeAtomic(
    context: WorkflowPackReadContext & { tx: GuardedTransaction; action: PendingActionV2; executionId: string },
    payload: Extract<WorkflowPayloadV2, { kind: K }>
  ): Promise<CommittedTarget[]>;
  verify(
    context: WorkflowPackReadContext & { action: PendingActionV2; executionId: string },
    committed: CommittedTarget[]
  ): Promise<TargetProof[]>;
  currentStates(context: WorkflowPackReadContext, refs: Ref[]): Promise<CurrentState[]>;
}

export type UniqueInsert<T> = { inserted: true; row: T } | { inserted: false; existing: T };
export type CasBody<T> = Omit<T, 'rowVersion'> & { rowVersion?: RowVersion };
export type CasResult<T> = { updated: true; row: T } | { updated: false; current: T | null };

/**
 * Compile-time V2 callback surface. Storage adapters must also hide/reject the
 * inherited V1 mutators at runtime; this type alone is not an enforcement gate.
 */
export type GuardedTransaction = Omit<Transaction, 'put' | 'remove'> & WorkflowReader & {
  insertUnique<T extends { id: string }>(
    table: WorkflowStorageTable,
    row: T,
    key: { constraint: string; values: Record<string, string | number> }
  ): Promise<UniqueInsert<T>>;
  compareAndSwap<T extends { id: string; rowVersion: RowVersion }>(
    table: WorkflowStorageTable,
    id: string,
    expected: { rowVersion: RowVersion; state: string | null },
    next: T
  ): Promise<CasResult<CasBody<T>>>;
};

export type WorkflowStore = Store & WorkflowReader & {
  workflowContractVersion: 2;
  workflowTransaction<T>(work: (tx: GuardedTransaction) => Promise<T>): Promise<T>;
};

export const dashboardShareV2Schema = z.object({
  id: identifierSchema,
  dashboardId: identifierSchema,
  dashboardVersionId: identifierSchema,
  senderIdentityId: identifierSchema,
  recipientIdentityId: identifierSchema,
  approvedBranchIds: uniqueIdArray(),
  classification: z.literal('internal'),
  verificationDigest: digestSchema,
  keyVersion: positiveIntegerSchema,
  channel: deliveryChannelSchema,
  policy: policyPinSchema,
  status: z.enum(['active', 'revoked']),
  expiresAt: instantSchema,
  rowVersion: rowVersionSchema,
  semanticKey: identifierSchema,
  executionId: identifierSchema,
  createdAt: instantSchema,
  revokedAt: instantSchema.nullable()
}).strict();
export type DashboardShareV2 = z.infer<typeof dashboardShareV2Schema>;

export const dashboardShareRevokeEventSchema = z.object({
  id: identifierSchema,
  shareId: identifierSchema,
  actorId: identifierSchema,
  executionId: identifierSchema,
  shareCreationExecutionId: identifierSchema,
  priorShareRowVersion: rowVersionSchema,
  revokedShareRowVersion: rowVersionSchema,
  createdAt: instantSchema,
  rowVersion: rowVersionSchema
}).strict().refine(event => event.revokedShareRowVersion === event.priorShareRowVersion + 1,
  'Revoked share version must immediately follow the prior version');
export type DashboardShareRevokeEvent = z.infer<typeof dashboardShareRevokeEventSchema>;

export const simulatedDeliverySchema = z.object({
  id: identifierSchema,
  shareId: identifierSchema,
  recipientIdentityId: identifierSchema,
  channel: deliveryChannelSchema,
  destinationIdentity: z.string().min(1).max(254),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(2_000),
  status: z.literal('simulated_completed'),
  executionId: identifierSchema,
  createdAt: instantSchema
}).strict();
export type SimulatedDelivery = z.infer<typeof simulatedDeliverySchema>;

const recipientIncidentSchema = z.object({
  id: identifierSchema,
  kind: z.enum(['payment', 'stock', 'operations']),
  status: z.enum(['open', 'resolved']),
  startedAt: instantSchema,
  endedAt: instantSchema.nullable(),
  title: shortTextSchema.max(160)
}).strict();

export const recipientBranchViewSchema = z.object({
  branchId: identifierSchema,
  branchName: shortTextSchema.max(160),
  region: shortTextSchema.max(120),
  netSales: z.number().finite(),
  target: z.number().finite().nonnegative(),
  gap: z.number().finite(),
  achievement: z.number().finite().nonnegative().nullable(),
  stockIssues: nonnegativeIntegerSchema,
  incidentCount: nonnegativeIntegerSchema,
  staffingPlanned: nonnegativeIntegerSchema,
  staffingActual: nonnegativeIntegerSchema,
  sourceIds: uniqueIdArray(100),
  incidents: z.array(recipientIncidentSchema).max(200)
}).strict();
export type RecipientBranchView = z.infer<typeof recipientBranchViewSchema>;

const recipientTotalsSchema = z.object({
  netSales: z.number().finite(),
  target: z.number().finite().nonnegative(),
  gap: z.number().finite(),
  achievement: z.number().finite().nonnegative().nullable()
}).strict();

export const recipientDashboardViewSchema = z.object({
  id: identifierSchema,
  title: z.literal('Dashboard in your permitted scope'),
  ownerLabel: shortTextSchema.max(160).nullable(),
  currentScope: scopeSchema,
  widgets: dashboardSpecSchema.shape.widgets,
  branches: z.array(recipientBranchViewSchema).max(100),
  totals: recipientTotalsSchema,
  sources: z.array(sourceRefSchema).max(500),
  analysis: analysisSchema,
  asOf: instantSchema
}).strict();
export type RecipientDashboardView = z.infer<typeof recipientDashboardViewSchema>;

export const allowedCapabilitySchema = z.object({
  id: identifierSchema,
  kind: z.enum([...workflowActionKinds, 'director_queue', 'manager_queue']),
  title: shortTextSchema.max(200),
  department: z.enum(['sales', 'operations', 'hr']),
  behavior: z.enum(['read', 'prepare']),
  risk: z.enum(['read_only', 'creates_record', 'high_impact']),
  permitted: z.boolean(),
  eligibleCount: nonnegativeIntegerSchema,
  available: z.boolean(),
  disabledReason: z.object({ code: identifierSchema, message: shortTextSchema }).strict().nullable(),
  requiresConfirmation: z.boolean(),
  simulatedConnector: z.boolean(),
  snapshotRef: z.object({ id: identifierSchema, digest: digestSchema, expiresAt: instantSchema }).strict().nullable(),
  targetRefs: z.array(refSchema).max(MAX_WORKFLOW_TARGETS).superRefine((refs, context) => {
    addUniqueIssue(refs, context, refKey, 'target reference');
  }),
  promptTemplate: z.string().max(2_000).nullable()
}).strict();
export type AllowedCapability = z.infer<typeof allowedCapabilitySchema>;

export const conversationMetadataSchema = z.object({
  id: identifierSchema,
  actorId: identifierSchema,
  title: z.string().min(1).max(120).refine(value => value === value.trim(), 'Conversation title must be trimmed'),
  pinned: z.boolean(),
  archivedAt: instantSchema.nullable(),
  rowVersion: rowVersionSchema,
  createdAt: instantSchema,
  updatedAt: instantSchema,
  lastScope: scopeSchema.nullable(),
  lastDashboardId: identifierSchema.nullable()
}).strict();
export type ConversationMetadata = z.infer<typeof conversationMetadataSchema>;
export type ConversationV2 = ConversationMetadata;

export const conversationListInputSchema = z.object({
  query: z.string().max(200).optional(),
  includeArchived: z.boolean(),
  cursor: z.string().min(1).max(512).refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'Cursor cannot contain control characters').optional(),
  limit: z.number().int().min(1).max(100).default(25)
}).strict();
export type ConversationListInput = z.infer<typeof conversationListInputSchema>;

export const conversationMutationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('rename'), title: z.string().trim().min(1).max(120) }).strict(),
  z.object({ type: z.literal('pin'), pinned: z.boolean() }).strict(),
  z.object({ type: z.literal('archive'), archived: z.boolean() }).strict()
]);
export type ConversationMutation = z.infer<typeof conversationMutationSchema>;

export const conversationMetadataRequestSchema = z.object({
  conversationId: identifierSchema,
  expectedVersion: rowVersionSchema,
  mutation: conversationMutationSchema
}).strict();
export type ConversationMetadataRequest = z.infer<typeof conversationMetadataRequestSchema>;

export const conversationDashboardRefSchema = z.object({
  id: identifierSchema,
  conversationId: identifierSchema,
  title: shortTextSchema.max(200)
}).strict();
export type ConversationDashboardRef = z.infer<typeof conversationDashboardRefSchema>;

const conversationMessageSchema = z.object({
  id: identifierSchema,
  conversationId: identifierSchema,
  actorId: identifierSchema,
  role: z.enum(['user', 'assistant']),
  text: z.string().max(100_000),
  mode: z.enum(['live_ai', 'scripted_demo']),
  modeRevision: nonnegativeIntegerSchema,
  createdAt: instantSchema,
  turnId: identifierSchema.optional(),
  analysis: analysisSchema.optional(),
  evidence: evidenceSchema.optional(),
  sources: z.array(sourceRefSchema).max(500).optional(),
  pendingActionId: identifierSchema.optional(),
  pendingActionIds: z.array(identifierSchema).max(2_000).optional(),
  receiptId: identifierSchema.optional()
}).strict();

/** Shared chat storage accepts known V1 metadata without fabricating V2 fields. */
export const persistedConversationSchema = z.object({
  id: identifierSchema,
  actorId: identifierSchema,
  title: conversationMetadataSchema.shape.title.optional(),
  pinned: z.boolean().optional(),
  pinnedAt: instantSchema.nullable().optional(),
  archivedAt: instantSchema.nullable().optional(),
  rowVersion: rowVersionSchema.optional(),
  createdAt: instantSchema.nullable().optional(),
  updatedAt: instantSchema.optional(),
  lastScope: scopeSchema.nullable().optional(),
  lastDashboardId: identifierSchema.nullable().optional(),
  lastAnalysis: analysisSchema.optional()
}).strict();
export type PersistedConversation = z.infer<typeof persistedConversationSchema>;

// Keep the frozen V2 storage field order when shared UI chat adds these fields.
export const persistedConversationMessageSchema = conversationMessageSchema.omit({
  turnId: true,
  pendingActionIds: true
}).extend({
  rowVersion: rowVersionSchema.optional(),
  turnId: identifierSchema.optional(),
  sessionId: identifierSchema.optional(),
  pendingActionIds: z.array(identifierSchema).max(MAX_WORKFLOW_TARGETS).superRefine((ids, context) => {
    addUniqueIssue(ids, context, value => value, 'pending action reference');
  }).optional()
}).strict();
export type PersistedConversationMessage = z.infer<typeof persistedConversationMessageSchema>;

export const conversationContextViewSchema = z.object({
  selectedConversationId: identifierSchema,
  conversation: conversationMetadataSchema,
  messages: z.array(conversationMessageSchema).max(2_000),
  dashboardRefs: z.array(conversationDashboardRefSchema).max(500),
  actions: z.array(z.union([pendingActionSchema, pendingActionV2Schema])).max(2_000)
}).strict();
export type ConversationContextView = z.infer<typeof conversationContextViewSchema>;

export const safeWorkflowErrorSchema = z.object({
  code: identifierSchema,
  outcome: z.enum(['denied', 'stale', 'failed', 'pending']),
  message: shortTextSchema.max(1_000),
  correlationId: identifierSchema,
  actionId: identifierSchema.nullable(),
  executionId: identifierSchema.nullable(),
  commitCertainty: z.enum(['definitely_not_committed', 'committed', 'unknown']),
  domainEffect: z.enum(['none', 'persisted', 'unknown']),
  operationPhase: z.enum(['claim', 'effect', 'readback']).optional(),
  auditStatus: z.enum(['recorded', 'unverified']),
  nextStep: z.enum(['refresh_review', 'readback_existing', 'correct_input', 'none']),
  retryBusinessWrite: z.literal(false),
  reasons: z.array(z.object({
    code: identifierSchema,
    targetId: identifierSchema.nullable(),
    message: shortTextSchema.max(1_000)
  }).strict()).max(500),
  currentStates: z.array(entityStateSchema).max(500)
}).strict().superRefine((error, context) => {
  const addOutcomeIssue = (path: (string | number)[], message: string) => {
    context.addIssue({ code: 'custom', path, message });
  };

  if (error.commitCertainty === 'unknown') {
    if (error.outcome !== 'pending') {
      addOutcomeIssue(['outcome'], 'An unknown commit outcome must remain pending');
    }
    if (error.domainEffect !== 'unknown' && !(error.operationPhase === 'claim' && error.domainEffect === 'none')) {
      addOutcomeIssue(['domainEffect'], 'An unknown commit outcome cannot claim a known effect state');
    }
    if (error.nextStep !== 'readback_existing') {
      addOutcomeIssue(['nextStep'], 'An unknown commit outcome requires read-only readback of the existing effect');
    }
    if (error.actionId === null && error.executionId === null) {
      addOutcomeIssue(['actionId'], 'Unknown-outcome readback requires an action or execution lookup reference');
    }
  }

  if (error.code === 'TRANSPORT_OUTCOME_UNKNOWN' && error.commitCertainty !== 'unknown') {
    addOutcomeIssue(['commitCertainty'], 'Unknown transport outcomes must not claim commit certainty');
  }

  if ((error.outcome === 'denied' || error.outcome === 'stale') &&
      (error.commitCertainty !== 'definitely_not_committed' || error.domainEffect !== 'none')) {
    addOutcomeIssue(['outcome'], 'Denied and stale outcomes must guarantee no committed domain effect');
  }
});
export type SafeWorkflowError = z.infer<typeof safeWorkflowErrorSchema>;
export type WorkflowApiError = SafeWorkflowError;

/** Common V1 types are surfaced for consumers without widening or mutating their unions. */
export type { Analysis, DashboardSpec, Evidence, Mode, PackPin, PendingAction, Reader, Scope, SourceRef, Store, Table, Transaction };
