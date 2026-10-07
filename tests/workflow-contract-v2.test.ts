import { describe, expect, it } from 'vitest';
import type { ReceiptView } from '../lib/contracts';
import {
  allowedCapabilitySchema,
  defaultDemoWorkflowPolicy,
  directoryIdentitySchema,
  entityStateSchema,
  isoDateSchema,
  pendingActionV2Schema,
  policyPinSchema,
  recipientDashboardViewSchema,
  reviewSnapshotSchema,
  rowVersionSchema,
  safeWorkflowErrorSchema,
  targetProofSchema,
  targetSpecSchema,
  versionedDemoWorkflowPolicySchema,
  workflowActionPayloadSchema,
  workflowReceiptV2Schema,
} from '../lib/workflows/contracts';
import type { GuardedTransaction } from '../lib/workflows/contracts';

const digest = 'a'.repeat(64);
const createdAt = '2026-10-01T09:00:00.000Z';
const expiresAt = '2026-10-01T09:10:00.000Z';
const checkedAt = '2026-10-01T09:05:00.000Z';

// `tsc --noEmit` checks this compile-only callback contract; Vitest does not call it.
function guardedTransactionV2TypeContract(tx: GuardedTransaction): void {
  void tx.insertUnique('branches', { id: 'branch-typecheck-01' }, {
    constraint: 'branches_primary_key',
    values: { id: 'branch-typecheck-01' },
  });
  void tx.compareAndSwap(
    'branches',
    'branch-typecheck-01',
    { rowVersion: 1, state: null },
    { id: 'branch-typecheck-01', rowVersion: 2 },
  );

  // @ts-expect-error V2 guarded callbacks cannot use the inherited unchecked V1 writer.
  void tx.put('branches', { id: 'branch-typecheck-01' });
  // @ts-expect-error V2 guarded callbacks cannot delete through the inherited V1 transaction API.
  void tx.remove('branches', 'branch-typecheck-01');
}

void guardedTransactionV2TypeContract;

// The existing V1 restricted view remains a distinct redacted shape; there is
// intentionally no invented V2 restricted-receipt parser here.
const existingRestrictedV1ReceiptView: ReceiptView = {
  visibility: 'restricted',
  id: 'legacy-restricted-receipt-01',
  actionId: 'legacy-action-01',
  status: 'pending',
  results: [],
  createdAt,
  verifiedAt: null,
  detail: 'Current access does not allow disclosure of the stored receipt.',
};

void existingRestrictedV1ReceiptView;

const dashboardCreatePayload = {
  kind: 'dashboard_create',
  spec: {
    title: 'East sales overview',
    description: 'Current East sales against target.',
    scope: { region: 'East', date: '2026-10-01', branchIds: ['east-01'] },
    widgets: [{ type: 'metric', title: 'Net sales', metric: 'net_sales' }],
  },
};

const dashboardSharePayload = {
  kind: 'dashboard_share',
  dashboardId: 'dashboard-east',
  recipientIdentityId: 'synthetic-director',
  channel: 'simulated_email',
  subject: 'East sales overview',
  body: 'Here is the reviewed East sales summary.',
};

const dashboardShareRevokePayload = {
  kind: 'dashboard_share_revoke',
  shareId: 'share-east-01',
};

const investigationCreatePayload = {
  kind: 'investigation_create',
  businessDate: '2026-10-01',
  targets: [{
    ownerIdentityId: 'ops-owner-east',
    reason: 'Review the stock discrepancy.',
    dueDate: '2026-10-04',
    priority: 'normal',
    branchId: 'east-01',
    caseId: 'case-east-stock-01',
    sourceIds: ['inventory-source-01'],
    unansweredQuestion: 'Which inventory movement explains the difference?',
  }],
};

const restockCreatePayload = {
  kind: 'restock_create',
  targets: [{
    ownerIdentityId: 'ops-owner-east',
    reason: 'Restore stock to the reviewed minimum.',
    dueDate: '2026-10-04',
    priority: 'normal',
    inventorySnapshotId: 'inventory-snapshot-east-01',
    branchId: 'east-01',
    productId: 'product-01',
    quantity: 12,
  }],
};

const crmFollowupCreatePayload = {
  kind: 'crm_followup_create',
  targets: [{
    ownerIdentityId: 'sales-owner-east',
    reason: 'Follow up after the inactivity threshold.',
    dueDate: '2026-10-04',
    priority: 'normal',
    opportunityId: 'opportunity-east-01',
  }],
};

const incidentEscalatePayload = {
  kind: 'incident_escalate',
  targets: [{
    incidentId: 'incident-east-01',
    targetTeamId: 'demo_operations',
    evidenceIds: ['incident-evidence-01'],
    reason: 'The reviewed incident needs operations follow-up.',
  }],
};

const discountRequestCreatePayload = {
  kind: 'discount_request_create',
  opportunityId: 'opportunity-east-01',
  requestedBasisPoints: 500,
  baseAmountSatang: 250_000,
  reason: 'Request a reviewed discount for this opportunity.',
  ownerIdentityId: 'sales-owner-east',
};

const branchReviewAssignPayload = {
  kind: 'branch_review_assign',
  businessDate: '2026-10-01',
  targets: [{
    ownerIdentityId: 'ops-owner-east',
    reason: 'Review the branch variance.',
    dueDate: '2026-10-04',
    priority: 'normal',
    branchId: 'east-01',
    caseId: 'branch-review-east-01',
  }],
};

const onboardingManagerApprovePayload = {
  kind: 'onboarding_manager_approve',
  snapshotId: 'manager-snapshot-01',
  requestIds: ['onboarding-request-01'],
};

const onboardingDirectorApprovePayload = {
  kind: 'onboarding_director_approve',
  snapshotId: 'director-snapshot-01',
  requestIds: ['onboarding-request-01'],
};

const onboardingReturnPayload = {
  kind: 'onboarding_return',
  snapshotId: 'director-snapshot-01',
  requestIds: ['onboarding-request-01'],
  reason: 'The reviewed request needs a corrected start date.',
};

const onboardingStartPayload = {
  kind: 'onboarding_start',
  requestId: 'onboarding-request-01',
};

const onboardingTasksCreatePayload = {
  kind: 'onboarding_tasks_create',
  requestId: 'onboarding-request-01',
  targets: [{
    ownerIdentityId: 'hr-owner-east',
    reason: 'Complete the welcome checklist.',
    dueDate: '2026-10-04',
    priority: 'normal',
    templateId: 'hr_welcome',
  }],
};

const offboardingPlanCreatePayload = {
  kind: 'offboarding_plan_create',
  caseId: 'offboarding-case-01',
};

const itDisableRequestPayload = {
  kind: 'it_disable_request',
  caseId: 'offboarding-case-01',
  planId: 'offboarding-plan-01',
  effectiveDate: '2026-10-10',
  reason: 'Record the reviewed simulated IT-disable request.',
};

const assetReturnCreatePayload = {
  kind: 'asset_return_create',
  caseId: 'offboarding-case-01',
  planId: 'offboarding-plan-01',
  targets: [{
    ownerIdentityId: 'hr-owner-east',
    reason: 'Return the assigned laptop.',
    dueDate: '2026-10-10',
    priority: 'normal',
    assetAssignmentId: 'asset-assignment-01',
  }],
};

const badgeRevokePayload = {
  kind: 'badge_revoke',
  badgeId: 'badge-01',
  employeeId: 'employee-01',
  reason: 'Record the reviewed badge revocation.',
};

const contractReminderCreatePayload = {
  kind: 'contract_reminder_create',
  targets: [{
    ownerIdentityId: 'hr-owner-east',
    reason: 'Review the upcoming contract expiry.',
    dueDate: '2026-10-04',
    priority: 'normal',
    contractId: 'employment-contract-01',
  }],
};

const policyAcknowledgementAssignPayload = {
  kind: 'policy_acknowledgement_assign',
  policyDocumentId: 'policy-document-01',
  policyVersion: '1.0',
  targets: [{
    ownerIdentityId: 'hr-owner-east',
    reason: 'Assign the current policy acknowledgement.',
    dueDate: '2026-10-04',
    priority: 'normal',
    employeeId: 'employee-01',
  }],
};

// These fixtures are written from the frozen V2 contract, rather than generated
// from the schema's discriminants or object shapes.
const documentedPayloads = [
  dashboardCreatePayload,
  dashboardSharePayload,
  dashboardShareRevokePayload,
  investigationCreatePayload,
  restockCreatePayload,
  crmFollowupCreatePayload,
  incidentEscalatePayload,
  discountRequestCreatePayload,
  branchReviewAssignPayload,
  onboardingManagerApprovePayload,
  onboardingDirectorApprovePayload,
  onboardingReturnPayload,
  onboardingStartPayload,
  onboardingTasksCreatePayload,
  offboardingPlanCreatePayload,
  itDisableRequestPayload,
  assetReturnCreatePayload,
  badgeRevokePayload,
  contractReminderCreatePayload,
  policyAcknowledgementAssignPayload,
];

const validPolicyPin = { id: 'demo-workflow', version: 1, digest };

const validInsertTarget = {
  targetId: 'target-investigation-01',
  ref: { table: 'investigation_cases', id: 'case-east-stock-01' },
  semanticKey: 'investigation:case-east-stock-01',
  expectedRows: [{
    ref: { table: 'branches', id: 'east-01' },
    rowVersion: 2,
    state: null,
  }],
  ownerIdentityId: 'ops-owner-east',
  expectedEffectRef: { table: 'investigation_tasks', id: 'task-preallocated-01' },
  expectedEffectVersion: 1,
};

const validPendingAction = {
  id: 'pending-action-01',
  contractVersion: 2,
  actorId: 'actor-01',
  sessionId: 'session-01',
  conversationId: 'conversation-01',
  turnId: 'turn-01',
  mode: 'scripted_demo',
  modeRevision: 0,
  payload: investigationCreatePayload,
  payloadHash: digest,
  idempotencyKey: 'b'.repeat(64),
  targets: [validInsertTarget],
  targetCount: 1,
  expectedRows: validInsertTarget.expectedRows,
  approvedBranchIds: ['east-01'],
  approvedOrgUnitIds: ['org-east'],
  reviewedSnapshotId: null,
  policy: validPolicyPin,
  packs: [{
    id: 'workflow-operations',
    version: '1.0',
    schemaDigest: 'c'.repeat(64),
    implementationRevision: 'operations-r1',
  }],
  releaseRevision: 'release-r1',
  executionMode: 'atomic_local',
  createdAt,
  expiresAt,
  status: 'pending',
};

const validReviewSnapshot = {
  id: 'director-snapshot-01',
  actorId: 'director-identity-01',
  actorSessionId: 'director-session-01',
  purpose: 'director_queue',
  orgUnitIds: ['org-east'],
  displayedIds: ['onboarding-request-01'],
  count: 1,
  expectedRows: [{
    ref: { table: 'onboarding_requests', id: 'onboarding-request-01' },
    rowVersion: 3,
    state: 'director_approval_pending',
  }],
  policy: validPolicyPin,
  createdAt,
  expiresAt,
  digest,
};

const validHrDirectorIdentity = {
  id: 'synthetic-director',
  profileId: 'profile-synthetic-director',
  displayName: 'Synthetic HR Director',
  active: true,
  role: 'hr_director',
  department: 'hr',
  orgUnitId: 'org-east',
  managerIdentityId: null,
  verifiedDemoEmail: 'director@biztania.example',
  slackIdentity: 'SYNTHETIC_DIRECTOR',
  allowedChannels: ['simulated_email', 'simulated_slack'],
  classificationCeiling: 'internal',
  rowVersion: 1,
};

const validCurrentState = {
  ref: { table: 'onboarding_requests', id: 'onboarding-request-01' },
  state: 'onboarding_in_progress',
  rowVersion: 4,
  allowedNextActions: ['onboarding_tasks_create'],
  completedActions: [{
    kind: 'onboarding_manager_approve',
    executionId: 'execution-manager-01',
    completedAt: checkedAt,
  }],
};

const validHistoricalReceipt = {
  id: 'receipt-manager-01',
  actionId: 'pending-action-manager-01',
  contractVersion: 2,
  actorId: 'manager-identity-01',
  kind: 'onboarding_manager_approve',
  outcome: 'verified_success',
  proofs: [{
    targetId: 'target-onboarding-01',
    ref: { table: 'onboarding_requests', id: 'onboarding-request-01' },
    outcome: 'verified_success',
    executionId: 'execution-manager-01',
    observedRowVersion: 3,
    checkedAt,
    mismatchCodes: [],
  }],
  createdAt,
  verifiedAt: checkedAt,
  // Current state can legitimately advance after the immutable proof was recorded.
  currentStates: [validCurrentState],
};

const validAllowedCapability = {
  id: 'director-approval-queue',
  kind: 'director_queue',
  title: 'Director approval queue',
  department: 'hr',
  behavior: 'read',
  risk: 'read_only',
  permitted: true,
  eligibleCount: 1,
  available: true,
  disabledReason: null,
  requiresConfirmation: false,
  simulatedConnector: true,
  snapshotRef: { id: 'director-snapshot-01', digest, expiresAt },
  targetRefs: [{ table: 'onboarding_requests', id: 'onboarding-request-01' }],
  promptTemplate: null,
};

const validSource = {
  id: 'source-east-sales-01',
  system: 'sales_orders',
  observedAt: '2026-10-01T02:00:00.000Z',
  retrievedAt: '2026-10-01T02:05:00.000Z',
  freshness: 'fresh',
  detail: 'Sales summary for the permitted East branch.',
};

const validRecipientView = {
  id: 'dashboard-east-01',
  title: 'Dashboard in your permitted scope',
  ownerLabel: 'East Operations',
  currentScope: { region: 'East', date: '2026-10-01', branchIds: ['east-01'] },
  widgets: [{ type: 'metric', title: 'Net sales', metric: 'net_sales' }],
  branches: [{
    branchId: 'east-01',
    branchName: 'East Branch 01',
    region: 'East',
    netSales: 100_000,
    target: 120_000,
    gap: -20_000,
    achievement: 0.8333,
    stockIssues: 1,
    incidentCount: 0,
    staffingPlanned: 4,
    staffingActual: 4,
    sourceIds: ['source-east-sales-01'],
    incidents: [],
  }],
  totals: { netSales: 100_000, target: 120_000, gap: -20_000, achievement: 0.8333 },
  sources: [validSource],
  analysis: {
    facts: [{ text: 'East sales are below target.', sourceIds: ['source-east-sales-01'] }],
    relationships: [],
    hypotheses: [],
    missingEvidence: [],
    generatedAt: checkedAt,
    evidenceVersion: 'projected-evidence-01',
  },
  asOf: checkedAt,
};

const validDefiniteNoEffectError = {
  code: 'AUTHORIZATION_DENIED',
  outcome: 'denied',
  message: 'The request is not authorized.',
  correlationId: 'correlation-01',
  actionId: null,
  executionId: null,
  commitCertainty: 'definitely_not_committed',
  domainEffect: 'none',
  auditStatus: 'recorded',
  nextStep: 'none',
  retryBusinessWrite: false,
  reasons: [{ code: 'NOT_AUTHORIZED', targetId: null, message: 'The request is not authorized.' }],
  currentStates: [],
};

const validUnknownTransportError = {
  code: 'TRANSPORT_OUTCOME_UNKNOWN',
  outcome: 'pending',
  message: 'The result is being checked against current state.',
  correlationId: 'correlation-02',
  actionId: 'pending-action-01',
  executionId: 'execution-01',
  commitCertainty: 'unknown',
  domainEffect: 'unknown',
  auditStatus: 'unverified',
  nextStep: 'readback_existing',
  retryBusinessWrite: false,
  reasons: [],
  currentStates: [],
};

describe('Workflow V2 documented action payloads', () => {
  it.each(documentedPayloads)('accepts the minimal documented $kind payload', payload => {
    expect(workflowActionPayloadSchema.parse(payload)).toEqual(payload);
  });

  it('rejects unknown kinds and model supplied SQL, code, URL, or actor override properties', () => {
    expect(workflowActionPayloadSchema.safeParse({ kind: 'unknown_action' }).success).toBe(false);

    for (const injectedProperty of [
      { sql: 'SELECT * FROM directory_identities' },
      { code: 'process.env.SECRET' },
      { url: 'https://example.invalid/execute' },
      { actorId: 'another-actor' },
    ]) {
      expect(workflowActionPayloadSchema.safeParse({
        ...investigationCreatePayload,
        ...injectedProperty,
      }).success).toBe(false);
    }

    expect(workflowActionPayloadSchema.safeParse({
      ...dashboardSharePayload,
      body: 'Open https://example.invalid/shared/grant?sig=secret',
    }).success).toBe(false);
  });

  it('rejects duplicate identities in a target batch', () => {
    expect(workflowActionPayloadSchema.safeParse({
      ...restockCreatePayload,
      targets: [restockCreatePayload.targets[0], restockCreatePayload.targets[0]],
    }).success).toBe(false);
  });
});

describe('Workflow V2 scalar and policy contracts', () => {
  it('accepts leap-day dates and rejects impossible calendar dates', () => {
    expect(isoDateSchema.parse('2024-02-29')).toBe('2024-02-29');
    expect(isoDateSchema.safeParse('2026-02-29').success).toBe(false);
    expect(isoDateSchema.safeParse('2024-02-30').success).toBe(false);
    expect(isoDateSchema.safeParse('2026-13-01').success).toBe(false);
  });

  it('requires positive integer row versions', () => {
    expect(rowVersionSchema.parse(1)).toBe(1);
    for (const invalidVersion of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(rowVersionSchema.safeParse(invalidVersion).success).toBe(false);
    }
  });

  it('matches the documented version 1 synthetic demo policy and policy pin', () => {
    const documentedPolicy = {
      id: 'demo-workflow',
      version: 1,
      timezone: 'Asia/Bangkok',
      classification: 'internal',
      pendingTtlSeconds: 600,
      shareTtlSeconds: 86_400,
      shareSigning: { purpose: 'nexus/share-url/v1', keyVersion: 1 },
      requiredOnboardingDocuments: ['identity_document', 'signed_offer', 'signed_contract'],
      restock: { targetMinimumMultiplier: 2, maxQuantity: 1_000, maxEvidenceAgeHours: 24 },
      crmInactiveDays: 14,
      tasks: { normalDueDays: 3, highDueDays: 1, defaultPriority: 'normal' },
      contractReminderDays: 30,
      incident: { from: 'un_escalated', to: 'team_requested', targetTeam: 'demo_operations' },
      discount: { minBasisPoints: 1, maxBasisPoints: 10_000, initialStage: 'manager_review_pending' },
      onboardingTaskTemplates: ['hr_welcome', 'it_setup_request', 'policy_acknowledgement'],
      offboardingTaskTemplates: ['it_disable_request', 'asset_return', 'badge_review'],
      policyAcknowledgementVersion: '1.0',
      maxBatchTargets: 100,
      maxReasonChars: 500,
      connectorMode: 'simulated_only',
    };

    expect(defaultDemoWorkflowPolicy).toEqual(documentedPolicy);
    expect(versionedDemoWorkflowPolicySchema.parse(defaultDemoWorkflowPolicy)).toEqual(documentedPolicy);
    expect(policyPinSchema.parse(validPolicyPin)).toEqual(validPolicyPin);
    expect(policyPinSchema.safeParse({ ...validPolicyPin, version: 2 }).success).toBe(false);
    expect(policyPinSchema.safeParse({ ...validPolicyPin, digest: 'not-a-digest' }).success).toBe(false);
  });
});

describe('Workflow V2 directory and reviewed snapshot contracts', () => {
  it('accepts a synthetic HR Director identity with only verified demo delivery channels', () => {
    expect(directoryIdentitySchema.parse(validHrDirectorIdentity)).toEqual(validHrDirectorIdentity);
    expect(directoryIdentitySchema.safeParse({
      ...validHrDirectorIdentity,
      allowedChannels: ['email'],
    }).success).toBe(false);
    expect(directoryIdentitySchema.safeParse({
      ...validHrDirectorIdentity,
      allowedChannels: ['simulated_email', 'simulated_email'],
    }).success).toBe(false);
    expect(directoryIdentitySchema.safeParse({
      ...validHrDirectorIdentity,
      verifiedDemoEmail: 'not-an-email',
    }).success).toBe(false);
    expect(directoryIdentitySchema.safeParse({
      ...validHrDirectorIdentity,
      role: 'director',
    }).success).toBe(false);
  });

  it('accepts a reviewed queue snapshot and rejects duplicate members or a mismatched count', () => {
    expect(reviewSnapshotSchema.parse(validReviewSnapshot)).toEqual(validReviewSnapshot);
    expect(reviewSnapshotSchema.safeParse({
      ...validReviewSnapshot,
      displayedIds: ['onboarding-request-01', 'onboarding-request-01'],
      count: 2,
    }).success).toBe(false);
    expect(reviewSnapshotSchema.safeParse({
      ...validReviewSnapshot,
      orgUnitIds: ['org-east', 'org-east'],
    }).success).toBe(false);
    expect(reviewSnapshotSchema.safeParse({ ...validReviewSnapshot, count: 0 }).success).toBe(false);
  });

  it('requires snapshot and pending action expiry to follow creation time', () => {
    expect(reviewSnapshotSchema.safeParse({ ...validReviewSnapshot, expiresAt: createdAt }).success).toBe(false);
    expect(reviewSnapshotSchema.safeParse({
      ...validReviewSnapshot,
      expiresAt: '2026-10-01T08:59:59.999Z',
    }).success).toBe(false);
    expect(pendingActionV2Schema.parse(validPendingAction)).toEqual(validPendingAction);
    expect(pendingActionV2Schema.safeParse({ ...validPendingAction, expiresAt: createdAt }).success).toBe(false);
    expect(pendingActionV2Schema.safeParse({ ...validPendingAction, targetCount: 2 }).success).toBe(false);
  });

  it('rejects duplicate source and expected-effect references across pending targets', () => {
    const secondTargetWithDuplicateSourceRef = {
      ...validInsertTarget,
      targetId: 'target-investigation-02',
      semanticKey: 'investigation:case-east-stock-02',
      expectedEffectRef: { table: 'investigation_tasks', id: 'task-preallocated-02' },
    };
    const secondTargetWithDuplicateEffectRef = {
      ...validInsertTarget,
      targetId: 'target-investigation-03',
      semanticKey: 'investigation:case-east-stock-03',
      ref: { table: 'investigation_cases', id: 'case-east-stock-03' },
    };

    expect(pendingActionV2Schema.safeParse({
      ...validPendingAction,
      targets: [validInsertTarget, secondTargetWithDuplicateSourceRef],
      targetCount: 2,
    }).success).toBe(false);
    expect(pendingActionV2Schema.safeParse({
      ...validPendingAction,
      targets: [validInsertTarget, secondTargetWithDuplicateEffectRef],
      targetCount: 2,
    }).success).toBe(false);
  });

  it('requires insertion and transition effect versions to match their frozen references', () => {
    const validTransitionTarget = {
      ...validInsertTarget,
      targetId: 'target-share-revoke-01',
      ref: { table: 'dashboard_shares', id: 'share-east-01' },
      semanticKey: 'dashboard-share:share-east-01:revoke',
      expectedRows: [{
        ref: { table: 'dashboard_shares', id: 'share-east-01' },
        rowVersion: 3,
        state: 'active',
      }],
      expectedEffectRef: { table: 'dashboard_shares', id: 'share-east-01' },
      expectedEffectVersion: 4,
    };

    expect(targetSpecSchema.parse(validInsertTarget)).toEqual(validInsertTarget);
    expect(targetSpecSchema.parse(validTransitionTarget)).toEqual(validTransitionTarget);
    expect(targetSpecSchema.safeParse({ ...validInsertTarget, expectedEffectVersion: 2 }).success).toBe(false);
    expect(targetSpecSchema.safeParse({ ...validTransitionTarget, expectedEffectVersion: 1 }).success).toBe(false);
  });
});

describe('Workflow V2 pending action snapshot binding', () => {
  it.each([
    onboardingManagerApprovePayload,
    onboardingDirectorApprovePayload,
    onboardingReturnPayload,
  ])('binds $kind to the exact reviewed snapshot', payload => {
    const actionWithMatchingSnapshot = {
      ...validPendingAction,
      payload,
      reviewedSnapshotId: payload.snapshotId,
    };

    expect(pendingActionV2Schema.parse(actionWithMatchingSnapshot)).toEqual(actionWithMatchingSnapshot);
    expect(pendingActionV2Schema.safeParse({
      ...actionWithMatchingSnapshot,
      reviewedSnapshotId: null,
    }).success).toBe(false);
    expect(pendingActionV2Schema.safeParse({
      ...actionWithMatchingSnapshot,
      reviewedSnapshotId: 'another-reviewed-snapshot',
    }).success).toBe(false);
  });

  it('allows an ordinary action envelope with no reviewed snapshot', () => {
    expect(validPendingAction.reviewedSnapshotId).toBeNull();
    expect(pendingActionV2Schema.parse(validPendingAction)).toEqual(validPendingAction);
  });
});

describe('Workflow V2 capability and receipt read models', () => {
  it('accepts a capability and rejects duplicate target references', () => {
    expect(allowedCapabilitySchema.parse(validAllowedCapability)).toEqual(validAllowedCapability);
    expect(allowedCapabilitySchema.safeParse({
      ...validAllowedCapability,
      targetRefs: [
        validAllowedCapability.targetRefs[0],
        validAllowedCapability.targetRefs[0],
      ],
    }).success).toBe(false);
  });

  it('keeps the current state projection separate from immutable receipt proof', () => {
    expect(entityStateSchema.parse(validCurrentState)).toEqual(validCurrentState);
    expect(workflowReceiptV2Schema.parse(validHistoricalReceipt)).toEqual(validHistoricalReceipt);
    expect(entityStateSchema.safeParse(validHistoricalReceipt).success).toBe(false);
    expect(workflowReceiptV2Schema.safeParse(validCurrentState).success).toBe(false);

    const parsedReceipt = workflowReceiptV2Schema.parse(validHistoricalReceipt);
    expect(parsedReceipt.proofs[0].observedRowVersion).toBe(3);
    expect(parsedReceipt.currentStates[0].rowVersion).toBe(4);
  });

  it('requires independent evidence only for verified-success proofs and receipts', () => {
    const verifiedProof = validHistoricalReceipt.proofs[0];
    const pendingProof = {
      ...verifiedProof,
      outcome: 'pending',
      observedRowVersion: null,
      checkedAt: null,
      mismatchCodes: ['READBACK_PENDING'],
    };
    const failedProof = {
      ...verifiedProof,
      outcome: 'failed',
      observedRowVersion: null,
      checkedAt: null,
      mismatchCodes: ['READBACK_FAILED'],
    };

    expect(targetProofSchema.parse(verifiedProof)).toEqual(verifiedProof);
    expect(targetProofSchema.safeParse({ ...verifiedProof, observedRowVersion: null }).success).toBe(false);
    expect(targetProofSchema.safeParse({ ...verifiedProof, checkedAt: null }).success).toBe(false);
    expect(targetProofSchema.safeParse({ ...verifiedProof, mismatchCodes: ['READBACK_MISMATCH'] }).success).toBe(false);

    expect(targetProofSchema.parse(pendingProof)).toEqual(pendingProof);
    expect(targetProofSchema.parse(failedProof)).toEqual(failedProof);

    expect(workflowReceiptV2Schema.parse(validHistoricalReceipt)).toEqual(validHistoricalReceipt);
    expect(workflowReceiptV2Schema.safeParse({ ...validHistoricalReceipt, verifiedAt: null }).success).toBe(false);
    expect(workflowReceiptV2Schema.safeParse({ ...validHistoricalReceipt, proofs: [] }).success).toBe(false);
    expect(workflowReceiptV2Schema.safeParse({ ...validHistoricalReceipt, proofs: [pendingProof] }).success).toBe(false);
    expect(workflowReceiptV2Schema.safeParse({ ...validHistoricalReceipt, proofs: [failedProof] }).success).toBe(false);

    const pendingReceipt = {
      ...validHistoricalReceipt,
      outcome: 'pending',
      proofs: [pendingProof],
      verifiedAt: null,
    };
    const failedReceipt = {
      ...validHistoricalReceipt,
      outcome: 'failed',
      proofs: [failedProof],
      verifiedAt: null,
    };
    expect(workflowReceiptV2Schema.parse(pendingReceipt)).toEqual(pendingReceipt);
    expect(workflowReceiptV2Schema.parse(failedReceipt)).toEqual(failedReceipt);
  });

  it('rejects non-finite recipient dashboard metrics', () => {
    expect(recipientDashboardViewSchema.safeParse({
      ...validRecipientView,
      branches: [{ ...validRecipientView.branches[0], netSales: Number.POSITIVE_INFINITY }],
    }).success).toBe(false);
    expect(recipientDashboardViewSchema.safeParse({
      ...validRecipientView,
      totals: { ...validRecipientView.totals, gap: Number.NaN },
    }).success).toBe(false);
  });

  it('keeps recipient views within the projected serialization whitelist', () => {
    expect(recipientDashboardViewSchema.parse(validRecipientView)).toEqual(validRecipientView);

    for (const [field, value] of [
      ['senderConversationId', 'conversation-sender-01'],
      ['conversationId', 'conversation-sender-01'],
      ['messages', []],
      ['originalScope', { region: 'All', date: '2026-10-01' }],
      ['originalSources', [{ id: 'unfiltered-source' }]],
      ['originalAnalysis', { facts: ['owner-only analysis'] }],
      ['rawOwnerAnalysis', { hypotheses: ['unfiltered hypothesis'] }],
      ['ownerApprovalPayload', { approvedBranchIds: ['all-branches'] }],
      ['share', { token: 'private-share-token' }],
      ['delivery', { destinationIdentity: 'private-recipient@example.invalid' }],
      ['destinationIdentity', 'private-recipient@example.invalid'],
      ['signature', 'private-signature'],
      ['evidence', { scope: { region: 'All', date: '2026-10-01' } }],
    ] as const) {
      expect(recipientDashboardViewSchema.safeParse({ ...validRecipientView, [field]: value }).success).toBe(false);
    }

    expect(recipientDashboardViewSchema.safeParse({
      ...validRecipientView,
      sources: [{ ...validSource, signature: 'private-signature' }],
    }).success).toBe(false);
    expect(recipientDashboardViewSchema.safeParse({
      ...validRecipientView,
      analysis: {
        ...validRecipientView.analysis,
        facts: [{ ...validRecipientView.analysis.facts[0], rawEvidence: { ownerNotes: 'private' } }],
      },
    }).success).toBe(false);
  });
});

describe('Workflow V2 safe error outcomes', () => {
  it('preserves definite no-effect denial and unknown transport as distinct typed outcomes', () => {
    expect(safeWorkflowErrorSchema.parse(validDefiniteNoEffectError)).toEqual(validDefiniteNoEffectError);
    expect(safeWorkflowErrorSchema.parse(validUnknownTransportError)).toEqual(validUnknownTransportError);
    expect(validDefiniteNoEffectError.commitCertainty).not.toBe(validUnknownTransportError.commitCertainty);
    expect(validDefiniteNoEffectError.domainEffect).not.toBe(validUnknownTransportError.domainEffect);

    expect(safeWorkflowErrorSchema.safeParse({
      ...validUnknownTransportError,
      outcome: 'denied',
      commitCertainty: 'definitely_not_committed',
      domainEffect: 'none',
      nextStep: 'none',
    }).success).toBe(false);
    expect(safeWorkflowErrorSchema.safeParse({
      ...validUnknownTransportError,
      retryBusinessWrite: true,
    }).success).toBe(false);
  });

  it('requires at least one existing lookup reference for unknown readback outcomes', () => {
    expect(safeWorkflowErrorSchema.safeParse({
      ...validUnknownTransportError,
      actionId: null,
      executionId: null,
    }).success).toBe(false);

    const actionOnlyLookup = {
      ...validUnknownTransportError,
      actionId: 'pending-action-01',
      executionId: null,
    };
    const executionOnlyLookup = {
      ...validUnknownTransportError,
      actionId: null,
      executionId: 'execution-01',
    };

    expect(safeWorkflowErrorSchema.parse(actionOnlyLookup)).toEqual(actionOnlyLookup);
    expect(safeWorkflowErrorSchema.parse(executionOnlyLookup)).toEqual(executionOnlyLookup);
    expect(actionOnlyLookup.nextStep).toBe('readback_existing');
    expect(executionOnlyLookup.nextStep).toBe('readback_existing');
    expect(actionOnlyLookup.retryBusinessWrite).toBe(false);
    expect(executionOnlyLookup.retryBusinessWrite).toBe(false);
  });
});
