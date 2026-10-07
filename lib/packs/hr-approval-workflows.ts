import { z } from 'zod';
import { invariant } from '../core/errors';
import { digest } from '../core/utils';
import type { ProjectedRow, WorkflowProjectionReader } from '../storage/workflow-projections';
import { authorizeWorkflowScope, type WorkflowAuthorityBranchBody } from '../workflows/authority';
import {
  defineWorkflowBinding,
  mergeExpectedRows,
  workflowSnapshotDigest,
  type RuntimeReadContext,
  type WorkflowRuntimeBinding,
} from '../workflows/action-runtime';
import type { ExpectedField, ExpectedPostcondition } from '../workflows/action-results';
import {
  directoryIdentitySchema,
  expectedRowSchema,
  instantSchema,
  onboardingRequestSchema,
  refSchema,
  responsibilitySchema,
  reviewSnapshotSchema,
  workflowEntityTableSchema,
  type CurrentState,
  type DirectoryIdentity,
  type ExpectedRow,
  type OnboardingRequest,
  type PendingActionV2,
  type Ref,
  type ReviewSnapshot,
  type TargetProof,
  type WorkflowActionKind,
  type WorkflowEntityTable,
  type WorkflowPayloadV2,
  type WorkflowPackReadContext,
  type WorkflowReceiptV2,
  type WorkflowStorageTable,
  workflowReceiptV2Schema,
} from '../workflows/contracts';
import { demoWorkflowPolicyV1, getDemoWorkflowPolicyV1Pin } from '../workflows/policy';

type ReviewKind = 'onboarding_manager_approve' | 'onboarding_director_approve' | 'onboarding_return';
type ReviewPayload = Extract<WorkflowPayloadV2, { kind: ReviewKind }>;
type StartPayload = Extract<WorkflowPayloadV2, { kind: 'onboarding_start' }>;
type RequestProjection = ProjectedRow<OnboardingRequest>;
type ApprovalStage = 'manager' | 'director' | 'return';
type ApprovalDecision = 'approved' | 'returned_for_revision';

interface OnboardingDocument extends Record<string, unknown> {
  id: string;
  requestId: string;
  employeeId: string;
  documentType: 'identity_document' | 'signed_offer' | 'signed_contract';
  status: 'accepted' | 'withdrawn' | 'replaced';
  policyVersion?: string;
  classification?: string;
  contentDigest?: string;
  withdrawnAt?: string | null;
}

interface ApprovalEvent extends Record<string, unknown> {
  id: string;
  rowVersion?: number;
  requestId: string;
  actorIdentityId: string;
  stage: ApprovalStage;
  lifecycleId: string;
  executionId: string;
  decision: ApprovalDecision;
  reason?: string;
  createdAt: string;
}

interface ReviewSnapshotTarget extends Record<string, unknown> {
  id: string;
  snapshotId: string;
  entityType: string;
  targetId: string;
  ref: Ref;
  expectedRowVersion: number;
  expectedState?: string | null;
}

interface RequestSources {
  requestRow: RequestProjection;
  request: OnboardingRequest;
  employeeRow: ProjectedRow<{ id: string; active: boolean; branchId?: string | null }>;
  branchRow: ProjectedRow<WorkflowAuthorityBranchBody>;
  documents: ProjectedRow<OnboardingDocument>[];
  managerProof: ApprovalProof | null;
  directorProof: ApprovalProof | null;
  expectedRows: ExpectedRow[];
}

interface HrTargetSpec {
  targetId: string;
  ref: Ref;
  semanticKey: string;
  ownerIdentityId: string;
  expectedRows: ExpectedRow[];
  expectedEffectRef: Ref;
  expectedEffectVersion: 1;
}

interface ApprovalProof {
  eventRow: ProjectedRow<ApprovalEvent>;
  event: ApprovalEvent;
  identityRow: ProjectedRow<DirectoryIdentity>;
  responsibilityRow: ProjectedRow<ReturnType<typeof responsibilitySchema.parse>>;
  executionRow: ProjectedRow<WorkflowReceiptV2>;
}

interface ReviewFlow {
  kind: ReviewKind;
  readPermission: string;
  permission: string;
  role: 'east_manager' | 'hr_director';
  purpose: 'manager_onboarding' | 'director_onboarding';
  snapshotPurpose: 'manager_queue' | 'director_queue';
  stage: ApprovalStage;
  decision: ApprovalDecision;
  sourceState: OnboardingRequest['state'];
  nextState: OnboardingRequest['state'];
  requiresManagerProof: boolean;
  requiresCompleteDocuments: boolean;
}

const identifier = directoryIdentitySchema.shape.id;
const documentType = z.enum(['identity_document', 'signed_offer', 'signed_contract']);
const approvalEventSchema = z.object({
  id: identifier,
  requestId: identifier,
  actorIdentityId: identifier,
  stage: z.enum(['manager', 'director', 'return']),
  lifecycleId: identifier,
  executionId: identifier,
  decision: z.enum(['approved', 'returned_for_revision']),
  reason: z.string().max(500).optional(),
  createdAt: instantSchema,
}).passthrough();
const onboardingDocumentSchema = z.object({
  id: identifier,
  requestId: identifier,
  employeeId: identifier,
  documentType,
  status: z.enum(['accepted', 'withdrawn', 'replaced']),
  policyVersion: z.string().optional(),
  classification: z.string().optional(),
  contentDigest: z.string().optional(),
  withdrawnAt: instantSchema.nullable().optional(),
}).passthrough();
const snapshotTargetSchema = z.object({
  id: identifier,
  snapshotId: identifier,
  entityType: workflowEntityTableSchema,
  targetId: identifier,
  ref: refSchema,
  expectedRowVersion: z.number().int().positive(),
  expectedState: z.string().nullable().optional(),
}).passthrough();

const CHECKLIST_TEMPLATE_ID = 'hr_onboarding';
const CHECKLIST_TITLE = 'Onboarding checklist';
const REVIEW_FLOWS: readonly ReviewFlow[] = [
  {
    kind: 'onboarding_manager_approve',
    readPermission: 'hr.onboarding.manager_read',
    permission: 'hr.onboarding.manager_approve',
    role: 'east_manager',
    purpose: 'manager_onboarding',
    snapshotPurpose: 'manager_queue',
    stage: 'manager',
    decision: 'approved',
    sourceState: 'manager_review_pending',
    nextState: 'director_approval_pending',
    requiresManagerProof: false,
    requiresCompleteDocuments: true,
  },
  {
    kind: 'onboarding_director_approve',
    readPermission: 'hr.onboarding.director_read',
    permission: 'hr.onboarding.director_approve',
    role: 'hr_director',
    purpose: 'director_onboarding',
    snapshotPurpose: 'director_queue',
    stage: 'director',
    decision: 'approved',
    sourceState: 'director_approval_pending',
    nextState: 'director_approved',
    requiresManagerProof: true,
    requiresCompleteDocuments: true,
  },
  {
    kind: 'onboarding_return',
    readPermission: 'hr.onboarding.director_read',
    permission: 'hr.onboarding.return',
    role: 'hr_director',
    purpose: 'director_onboarding',
    snapshotPurpose: 'director_queue',
    stage: 'return',
    decision: 'returned_for_revision',
    sourceState: 'director_approval_pending',
    nextState: 'returned_for_revision',
    requiresManagerProof: true,
    requiresCompleteDocuments: true,
  },
];

function runtimeContext(context: WorkflowPackReadContext): RuntimeReadContext {
  const candidate = context as Partial<RuntimeReadContext>;
  invariant(candidate.principal && candidate.projections, 'WORKFLOW_UNAVAILABLE', 'The V2 workflow read context is unavailable', 503);
  return candidate as RuntimeReadContext;
}

function expectedRow(ref: Ref, rowVersion: number, state: string | null): ExpectedRow {
  return expectedRowSchema.parse({ ref, rowVersion, state });
}

function requestGuard(row: RequestProjection): ExpectedRow {
  return expectedRow({ table: 'onboarding_requests', id: row.id }, row.rowVersion, row.body.state);
}

function projectionState(table: WorkflowStorageTable, body: Record<string, unknown>): string | null {
  if (table === 'onboarding_documents') return typeof body.status === 'string' ? body.status : null;
  if (table === 'directory_identities' || table === 'responsibilities') {
    return body.active === true ? 'active' : body.active === false ? 'inactive' : null;
  }
  if (table === 'action_executions') return typeof body.outcome === 'string' ? body.outcome : null;
  return null;
}

function guardForProjection<T extends { id: string }>(
  table: WorkflowEntityTable,
  row: ProjectedRow<T>,
): ExpectedRow {
  return expectedRow({ table, id: row.id }, row.rowVersion, projectionState(table, row.body as Record<string, unknown>));
}

function stableTargetId(request: OnboardingRequest): string {
  const value = request.id + ':' + request.lifecycleId;
  invariant(value.length <= 160, 'WORKFLOW_INVALID_INPUT', 'The onboarding request and lifecycle IDs exceed the target identity limit');
  return value;
}

function lifecycleFromTargetId(targetId: string, requestId: string): string {
  const prefix = requestId + ':';
  invariant(targetId.startsWith(prefix) && targetId.length > prefix.length,
  'WORKFLOW_CALLBACK_CONTRACT', 'The prepared onboarding request or lifecycle identity changed');
  return identifier.parse(targetId.slice(prefix.length));
}

function stableSemanticKey(kind: WorkflowActionKind, request: OnboardingRequest, transition: string): string {
  return digest({ kind, requestId: request.id, lifecycleId: request.lifecycleId, transition });
}

function stableEventId(request: Pick<OnboardingRequest, 'id' | 'lifecycleId'>, stage: ApprovalStage): string {
  return 'onboarding-event-' + digest({ requestId: request.id, lifecycleId: request.lifecycleId, stage });
}

function stableChecklistId(request: OnboardingRequest): string {
  return 'onboarding-checklist-' + digest({ requestId: request.id, lifecycleId: request.lifecycleId, templateId: CHECKLIST_TEMPLATE_ID });
}

function assertActorAuthority(
  context: RuntimeReadContext,
  input: {
    permission: string;
    readPermission?: string;
    role: ReviewFlow['role'] | 'hr_admin';
    purpose: ReviewFlow['purpose'] | 'hr_operations';
  },
  orgUnitIds: readonly string[] = [],
): DirectoryIdentity {
  const identity = directoryIdentitySchema.parse(context.principal.directory.body);
  invariant(context.actor.active && identity.active && context.actor.id === identity.profileId &&
    context.actor.role === identity.role && identity.department === 'hr',
  'WORKFLOW_AUTHORITY_INVALID', 'The current HR identity is unavailable', 403);
  authorizeWorkflowScope(context.principal, {
    permission: input.permission,
    roles: [input.role],
    purpose: input.purpose,
    targets: orgUnitIds.map(orgUnitId => ({ orgUnitId })),
  });
  if (input.readPermission) invariant(context.actor.permissions.includes(input.readPermission),
    'WORKFLOW_PERMISSION_DENIED', 'A required onboarding read permission is absent', 403);
  return identity;
}

function assertAssignedActor(
  context: RuntimeReadContext,
  identity: DirectoryIdentity,
  request: OnboardingRequest,
  flow: ReviewFlow,
): void {
  invariant(identity.role === flow.role && identity.id === (
    flow.stage === 'manager' ? request.managerIdentityId : request.directorIdentityId
  ), 'WORKFLOW_SCOPE_DENIED', 'The request is assigned to another reviewer', 403);
  authorizeWorkflowScope(context.principal, {
    permission: flow.permission,
    roles: [flow.role],
    purpose: flow.purpose,
    targets: [{ orgUnitId: request.orgUnitId }],
  });
}

async function readRequest(
  projections: WorkflowProjectionReader,
  requestId: string,
): Promise<RequestProjection> {
  const row = await projections.get<OnboardingRequest>('onboarding_requests', requestId);
  invariant(row && row.id === requestId && row.body.id === requestId &&
    row.body.rowVersion === row.rowVersion,
  'WORKFLOW_STALE', 'The onboarding request is unavailable or inconsistent', 409);
  return { ...row, body: onboardingRequestSchema.parse(row.body) };
}

async function readEmployee(
  projections: WorkflowProjectionReader,
  employeeId: string,
): Promise<ProjectedRow<{ id: string; active: boolean; branchId?: string | null }>> {
  const row = await projections.get<{ id: string; active: boolean; branchId?: string | null }>('employees', employeeId);
  invariant(row && row.id === employeeId && row.body.id === employeeId && row.body.active === true &&
    typeof row.body.branchId === 'string' && row.body.branchId.length > 0,
    'WORKFLOW_STALE', 'The onboarding employee is inactive or its branch reference is unavailable', 409);
  return row;
}

function branchForEmployee(
  context: RuntimeReadContext,
  request: OnboardingRequest,
  employee: ProjectedRow<{ id: string; active: boolean; branchId?: string | null }>,
): ProjectedRow<WorkflowAuthorityBranchBody> {
  const branchId = employee.body.branchId;
  const branch = typeof branchId === 'string'
    ? context.principal.branches.find(candidate => candidate.id === branchId)
    : undefined;
  invariant(branch && branch.body.id === branchId && branch.body.active !== false &&
    (branch.body.orgUnitId === undefined || branch.body.orgUnitId === null || branch.body.orgUnitId === request.orgUnitId),
  'WORKFLOW_STALE', 'The onboarding branch is inactive or no longer paired with its organization unit', 409);
  return branch;
}

function employeeBranchAuthorized(
  context: RuntimeReadContext,
  request: OnboardingRequest,
  branchId: string,
  authority: { permission: string; role: ReviewFlow['role'] | 'hr_admin'; purpose: ReviewFlow['purpose'] | 'hr_operations' },
): boolean {
  const branch = context.principal.branches.find(candidate => candidate.id === branchId);
  if (!branch || branch.body.active === false ||
    (branch.body.orgUnitId !== undefined && branch.body.orgUnitId !== null && branch.body.orgUnitId !== request.orgUnitId)) return false;
  try {
    const scope = authorizeWorkflowScope(context.principal, {
      permission: authority.permission,
      roles: [authority.role],
      purpose: authority.purpose,
      targets: [{ orgUnitId: request.orgUnitId, branchId }],
    });
    return scope.grants.some(grant => grant.orgUnitId === request.orgUnitId && grant.branchIds.includes(branchId)) &&
      context.actor.regions.includes(branch.body.region);
  } catch {
    return false;
  }
}

function assertEmployeeBranchScope(
  context: RuntimeReadContext,
  request: OnboardingRequest,
  employee: ProjectedRow<{ id: string; active: boolean; branchId?: string | null }>,
  authority: { permission: string; role: ReviewFlow['role'] | 'hr_admin'; purpose: ReviewFlow['purpose'] | 'hr_operations' },
): ProjectedRow<WorkflowAuthorityBranchBody> {
  const branchId = employee.body.branchId;
  const branch = branchForEmployee(context, request, employee);
  invariant(typeof branchId === 'string' && employeeBranchAuthorized(context, request, branchId, authority),
    'WORKFLOW_SCOPE_DENIED', 'The employee is outside the current onboarding responsibility scope', 403);
  return branch;
}

async function readDocuments(
  projections: WorkflowProjectionReader,
  request: OnboardingRequest,
): Promise<ProjectedRow<OnboardingDocument>[]> {
  const documents: ProjectedRow<OnboardingDocument>[] = [];
  for (const type of demoWorkflowPolicyV1.requiredOnboardingDocuments) {
    const rows = await projections.query<OnboardingDocument>({
      kind: 'unique',
      table: 'onboarding_documents',
      constraint: 'onboarding_documents_request_type_unique',
      values: { requestId: request.id, documentType: type },
    });
    invariant(rows.length <= 1, 'WORKFLOW_STALE', 'An onboarding document identity is ambiguous', 409);
    if (!rows[0]) continue;
    const row = rows[0];
    const parsed = onboardingDocumentSchema.parse(row.body);
    invariant(parsed.id === row.id && parsed.requestId === request.id &&
      parsed.employeeId === request.employeeId && parsed.documentType === type &&
      parsed.status === 'accepted' && parsed.policyVersion === demoWorkflowPolicyV1.policyAcknowledgementVersion &&
      parsed.classification === demoWorkflowPolicyV1.classification &&
      typeof parsed.contentDigest === 'string' && /^[a-f0-9]{64}$/i.test(parsed.contentDigest) &&
      parsed.withdrawnAt === null,
    'WORKFLOW_STALE', 'An onboarding document no longer belongs to this request', 409);
    documents.push({ ...row, body: parsed });
  }
  return documents;
}

function assertDocumentsComplete(documents: readonly ProjectedRow<OnboardingDocument>[]): void {
  const byType = new Map(documents.map(row => [row.body.documentType, row.body]));
  invariant(demoWorkflowPolicyV1.requiredOnboardingDocuments.every(type => {
    const row = byType.get(type);
    return row !== undefined && row.status === 'accepted';
  }), 'WORKFLOW_STALE', 'The required onboarding documents are incomplete', 409);
}

async function readAssignedIdentity(
  projections: WorkflowProjectionReader,
  identityId: string,
  role: 'east_manager' | 'hr_director',
  orgUnitId: string,
  branchId: string,
  purpose: 'manager_onboarding' | 'director_onboarding',
): Promise<{ identity: ProjectedRow<DirectoryIdentity>; responsibility: ProjectedRow<ReturnType<typeof responsibilitySchema.parse>> }> {
  const identityRow = await projections.get<DirectoryIdentity>('directory_identities', identityId);
  invariant(identityRow, 'WORKFLOW_STALE', 'An assigned reviewer identity is unavailable', 409);
  const identity = directoryIdentitySchema.parse(identityRow.body);
  invariant(identity.id === identityId && identity.active && identity.department === 'hr' && identity.role === role &&
    identity.rowVersion === identityRow.rowVersion,
    'WORKFLOW_STALE', 'An assigned reviewer is no longer active in the required role', 409);
  const responsibilityRows = await projections.query<ReturnType<typeof responsibilitySchema.parse>>({
    kind: 'unique',
    table: 'responsibilities',
    constraint: 'responsibilities_open_identity_purpose_unique',
    values: { identityId, purpose, orgUnitId },
  });
  invariant(responsibilityRows.length === 1, 'WORKFLOW_STALE', 'An assigned reviewer responsibility is no longer active', 409);
  const responsibility = responsibilityRows[0];
  const parsedResponsibility = responsibilitySchema.parse(responsibility.body);
  invariant(parsedResponsibility.active && parsedResponsibility.identityId === identityId &&
    parsedResponsibility.orgUnitId === orgUnitId && parsedResponsibility.purpose === purpose &&
    parsedResponsibility.branchIds.includes(branchId) && parsedResponsibility.rowVersion === responsibility.rowVersion,
  'WORKFLOW_STALE', 'An assigned reviewer responsibility changed', 409);
  return {
    identity: { ...identityRow, body: identity },
    responsibility: { ...responsibility, body: parsedResponsibility },
  };
}

async function readApprovalProof(
  projections: WorkflowProjectionReader,
  request: OnboardingRequest,
  stage: 'manager' | 'director',
  branchId: string,
): Promise<ApprovalProof> {
  const eventId = stage === 'manager' ? request.managerApprovalEventId : request.directorApprovalEventId;
  const approvedBy = stage === 'manager' ? request.managerApprovedBy : request.directorApprovedBy;
  const approvedAt = stage === 'manager' ? request.managerApprovedAt : request.directorApprovedAt;
  const identityId = stage === 'manager' ? request.managerIdentityId : request.directorIdentityId;
  invariant(eventId && approvedBy && approvedAt, 'WORKFLOW_STALE', 'The current approval proof is incomplete', 409);
  const eventRow = await projections.get<ApprovalEvent>('onboarding_approval_events', eventId);
  invariant(eventRow, 'WORKFLOW_STALE', 'The current approval event is unavailable', 409);
  const event = approvalEventSchema.parse(eventRow.body);
  invariant(event.id === eventId && event.requestId === request.id && event.actorIdentityId === identityId &&
    event.stage === stage && event.lifecycleId === request.lifecycleId && event.decision === 'approved' &&
    event.createdAt === approvedAt,
  'WORKFLOW_STALE', 'The current-lifecycle approval proof is invalid', 409);
  const reviewerRole = stage === 'manager' ? 'east_manager' : 'hr_director';
  const reviewerPurpose = stage === 'manager' ? 'manager_onboarding' : 'director_onboarding';
  const reviewer = await readAssignedIdentity(projections, identityId, reviewerRole, request.orgUnitId, branchId, reviewerPurpose);
  invariant(reviewer.identity.id === approvedBy && reviewer.identity.id === event.actorIdentityId,
    'WORKFLOW_STALE', 'The approval actor no longer matches the assigned reviewer', 409);
  const executionRow = await projections.get<WorkflowReceiptV2>('action_executions', event.executionId);
  invariant(executionRow, 'WORKFLOW_STALE', 'The approval execution receipt is unavailable', 409);
  const receipt = workflowReceiptV2Schema.parse(executionRow.body);
  const expectedKind = stage === 'manager' ? 'onboarding_manager_approve' : 'onboarding_director_approve';
  invariant(receipt.id === event.executionId && receipt.actorId === reviewer.identity.body.profileId &&
    receipt.kind === expectedKind && receipt.outcome === 'verified_success' &&
    receipt.proofs.some(proof => proof.ref.table === 'onboarding_approval_events' &&
      proof.ref.id === event.id && proof.executionId === event.executionId &&
      proof.outcome === 'verified_success'),
  'WORKFLOW_STALE', 'The current approval execution is not independently verified', 409);
  return {
    eventRow: { ...eventRow, body: event },
    event,
    identityRow: reviewer.identity,
    responsibilityRow: reviewer.responsibility,
    executionRow,
  };
}

function proofExpectedRows(proof: ApprovalProof | null): ExpectedRow[] {
  if (!proof) return [];
  return [
    guardForProjection('onboarding_approval_events', proof.eventRow),
    guardForProjection('directory_identities', proof.identityRow),
    guardForProjection('responsibilities', proof.responsibilityRow),
    guardForProjection('action_executions', proof.executionRow),
  ];
}

function sourceExpectedRows(sources: RequestSources): ExpectedRow[] {
  return mergeExpectedRows([
    requestGuard(sources.requestRow),
    guardForProjection('employees', sources.employeeRow),
    guardForProjection('branches', sources.branchRow),
    ...sources.documents.map(row => guardForProjection('onboarding_documents', row)),
    ...proofExpectedRows(sources.managerProof),
    ...proofExpectedRows(sources.directorProof),
  ]);
}

async function readSources(
  context: RuntimeReadContext,
  requestRow: RequestProjection,
  options: { managerProof: boolean; directorProof: boolean },
): Promise<RequestSources> {
  const request = requestRow.body;
  const [employeeRow, documents] = await Promise.all([
    readEmployee(context.projections, request.employeeId),
    readDocuments(context.projections, request),
  ]);
  const branchRow = branchForEmployee(context, request, employeeRow);
  const managerProof = options.managerProof
    ? await readApprovalProof(context.projections, request, 'manager', branchRow.id)
    : null;
  const directorProof = options.directorProof
    ? await readApprovalProof(context.projections, request, 'director', branchRow.id)
    : null;
  const sources = { requestRow, request, employeeRow, branchRow, documents, managerProof, directorProof, expectedRows: [] as ExpectedRow[] };
  sources.expectedRows = sourceExpectedRows(sources);
  return sources;
}

function requestIdsFrom(payload: ReviewPayload): string[] {
  return [...payload.requestIds].sort((left, right) => left.localeCompare(right));
}

function semanticTarget(
  request: OnboardingRequest,
  identityId: string,
  kind: WorkflowActionKind,
  transition: string,
  expectedRows: ExpectedRow[],
  effectRef: Ref,
): HrTargetSpec {
  return {
    targetId: stableTargetId(request),
    ref: { table: 'onboarding_requests', id: request.id },
    semanticKey: stableSemanticKey(kind, request, transition),
    ownerIdentityId: identityId,
    expectedRows,
    expectedEffectRef: effectRef,
    expectedEffectVersion: 1,
  };
}

async function loadReviewedSnapshot(
  context: RuntimeReadContext,
  payload: ReviewPayload,
  flow: ReviewFlow,
): Promise<ReviewSnapshot> {
  const projection = await context.projections.get<ReviewSnapshot>('review_snapshots', payload.snapshotId);
  invariant(projection && projection.id === payload.snapshotId && projection.rowVersion === 1,
    'WORKFLOW_STALE', 'The reviewed onboarding snapshot is unavailable or changed', 409);
  const snapshot = reviewSnapshotSchema.parse(projection.body);
  const policy = getDemoWorkflowPolicyV1Pin();
  invariant(snapshot.actorId === context.actor.id && snapshot.actorSessionId === context.actor.sessionId &&
    snapshot.purpose === flow.snapshotPurpose && Date.parse(snapshot.expiresAt) > context.now().getTime() &&
    snapshot.digest === workflowSnapshotDigest(snapshot) && digest(snapshot.policy) === digest(policy),
  'WORKFLOW_STALE', 'The reviewed onboarding snapshot no longer matches this session or policy', 409);
  invariant(payload.requestIds.length > 0 && new Set(payload.requestIds).size === payload.requestIds.length &&
    payload.requestIds.every(id => snapshot.displayedIds.includes(id)),
  'WORKFLOW_STALE', 'The selected requests are outside the reviewed snapshot', 409);
  invariant(payload.requestIds.every(id => snapshot.expectedRows.some(row =>
    row.ref.table === 'onboarding_requests' && row.ref.id === id,
  )), 'WORKFLOW_STALE', 'The reviewed snapshot lacks a selected request version', 409);
  await assertSnapshotTargetRows(context.projections, snapshot);
  return snapshot;
}

async function assertSnapshotTargetRows(
  projections: WorkflowProjectionReader,
  snapshot: ReviewSnapshot,
): Promise<void> {
  for (const expected of snapshot.expectedRows) {
    const rows = await projections.query<ReviewSnapshotTarget>({
      kind: 'unique',
      table: 'review_snapshot_targets',
      constraint: 'review_snapshot_targets_snapshot_target_unique',
      values: { snapshotId: snapshot.id, entityType: expected.ref.table, targetId: expected.ref.id },
    });
    invariant(rows.length === 1, 'WORKFLOW_STALE', 'The reviewed snapshot target references are incomplete', 409);
    const target = snapshotTargetSchema.parse(rows[0].body);
    invariant(target.snapshotId === snapshot.id && target.entityType === expected.ref.table &&
      target.targetId === expected.ref.id && digest(target.ref) === digest(expected.ref) &&
      target.expectedRowVersion === expected.rowVersion && (target.expectedState ?? null) === expected.state,
    'WORKFLOW_STALE', 'The reviewed snapshot target references changed', 409);
  }
}

function assertSnapshotGuards(
  snapshot: ReviewSnapshot,
  guards: readonly ExpectedRow[],
): void {
  for (const guard of guards) {
    const reviewed = snapshot.expectedRows.find(row => digest(row.ref) === digest(guard.ref));
    invariant(reviewed && digest(reviewed) === digest(guard),
      'WORKFLOW_STALE', 'A selected onboarding source differs from the reviewed snapshot', 409);
  }
}

function expectedDocumentRefs(snapshot: ReviewSnapshot): Set<string> {
  return new Set(snapshot.expectedRows
    .filter(row => row.ref.table === 'onboarding_documents')
    .map(row => row.ref.id));
}

async function assertSelectedDocumentsMatchSnapshot(
  context: RuntimeReadContext,
  snapshot: ReviewSnapshot,
  selected: readonly RequestSources[],
): Promise<void> {
  const selectedIds = new Set(selected.map(sources => sources.request.id));
  const expectedRefIds = expectedDocumentRefs(snapshot);
  const actualRefIds = new Set(selected.flatMap(sources => sources.documents.map(row => row.id)));
  for (const id of actualRefIds) {
    invariant(expectedRefIds.has(id), 'WORKFLOW_STALE', 'A selected onboarding document was not in the reviewed snapshot', 409);
  }
  for (const expected of snapshot.expectedRows.filter(row => row.ref.table === 'onboarding_documents')) {
    const row = await context.projections.get<OnboardingDocument>('onboarding_documents', expected.ref.id);
    invariant(row, 'WORKFLOW_STALE', 'A reviewed onboarding document is no longer available', 409);
    const document = onboardingDocumentSchema.parse(row.body);
    if (selectedIds.has(document.requestId)) {
      invariant(actualRefIds.has(document.id) && row.rowVersion === expected.rowVersion &&
        document.status === expected.state,
      'WORKFLOW_STALE', 'A selected onboarding document changed after review', 409);
    }
  }
  for (const sources of selected) {
    const requestExpectedIds = new Set(snapshot.expectedRows
      .filter(row => row.ref.table === 'onboarding_documents')
      .flatMap(expected => {
        const current = selected.find(item => item.request.id === sources.request.id);
        return current?.documents.some(document => document.id === expected.ref.id) ? [expected.ref.id] : [];
      }));
    invariant(digest([...requestExpectedIds].sort()) === digest(sources.documents.map(row => row.id).sort()),
      'WORKFLOW_STALE', 'The selected document set differs from the reviewed snapshot', 409);
  }
}

async function prepareReviewFlow(
  context: RuntimeReadContext,
  payload: ReviewPayload,
  flow: ReviewFlow,
): Promise<{ targets: ReturnType<typeof semanticTarget>[]; expectedRows: ExpectedRow[]; approvedBranchIds: string[]; approvedOrgUnitIds: string[]; snapshot: ReviewSnapshot }> {
  const identity = assertActorAuthority(context, flow);
  const snapshot = await loadReviewedSnapshot(context, payload, flow);
  const selectedSources: RequestSources[] = [];
  const targets: ReturnType<typeof semanticTarget>[] = [];
  const approvedBranchIds: string[] = [];
  for (const requestId of requestIdsFrom(payload)) {
    const requestRow = await readRequest(context.projections, requestId);
    const request = requestRow.body;
    assertAssignedActor(context, identity, request, flow);
    invariant(request.state === flow.sourceState, 'WORKFLOW_STALE', 'A selected request is not eligible for this transition', 409);
    if (flow.stage === 'manager') {
      invariant(request.managerApprovalEventId === null && request.managerApprovedBy === null &&
        request.managerApprovedAt === null && request.directorApprovalEventId === null &&
        request.directorApprovedBy === null && request.directorApprovedAt === null,
      'WORKFLOW_STALE', 'The manager review pointers are not clear', 409);
    } else {
      invariant(request.directorApprovalEventId === null && request.directorApprovedBy === null &&
        request.directorApprovedAt === null,
      'WORKFLOW_STALE', 'The Director review pointers are not clear', 409);
    }
    const sources = await readSources(context, requestRow, {
      managerProof: flow.requiresManagerProof,
      directorProof: false,
    });
    const branchRow = assertEmployeeBranchScope(context, request, sources.employeeRow, flow);
    invariant(branchRow.id === sources.branchRow.id, 'WORKFLOW_STALE', 'The onboarding branch changed during review preparation', 409);
    if (flow.requiresCompleteDocuments) assertDocumentsComplete(sources.documents);
    selectedSources.push(sources);
  }
  await assertSelectedDocumentsMatchSnapshot(context, snapshot, selectedSources);
  for (const sources of selectedSources) {
    assertSnapshotGuards(snapshot, sources.expectedRows);
    invariant(snapshot.orgUnitIds.includes(sources.request.orgUnitId),
      'WORKFLOW_STALE', 'The reviewed snapshot does not include the selected organization unit', 409);
    const effectRef = { table: 'onboarding_approval_events' as const, id: stableEventId(sources.request, flow.stage) };
    targets.push(semanticTarget(
      sources.request,
      identity.id,
      flow.kind,
      flow.stage,
      sources.expectedRows,
      effectRef,
    ));
    approvedBranchIds.push(sources.branchRow.id);
  }
  const approvedOrgUnitIds = [...new Set(selectedSources.map(sources => sources.request.orgUnitId))].sort();
  authorizeWorkflowScope(context.principal, {
    permission: flow.permission,
    roles: [flow.role],
    purpose: flow.purpose,
    targets: approvedOrgUnitIds.map(orgUnitId => ({ orgUnitId })),
  });
  return {
    targets,
    expectedRows: mergeExpectedRows(...targets.map(target => target.expectedRows)),
    approvedBranchIds: [...new Set(approvedBranchIds)].sort(),
    approvedOrgUnitIds,
    snapshot,
  };
}

function actionTargetForRequest(action: PendingActionV2, requestId: string) {
  const target = action.targets.find(candidate =>
    candidate.ref.table === 'onboarding_requests' && candidate.ref.id === requestId,
  );
  invariant(target, 'WORKFLOW_CALLBACK_CONTRACT', 'A prepared onboarding target is unavailable');
  return target;
}

function actionTargetForTargetId(action: PendingActionV2, targetId: string) {
  const target = action.targets.find(candidate => candidate.targetId === targetId);
  invariant(target, 'WORKFLOW_CALLBACK_CONTRACT', 'A prepared onboarding target is unavailable');
  return target;
}

function requestSourceVersion(target: PendingActionV2['targets'][number]): number {
  const expected = target.expectedRows.find(row =>
    row.ref.table === 'onboarding_requests' && row.ref.id === target.ref.id,
  );
  invariant(expected, 'WORKFLOW_CALLBACK_CONTRACT', 'A prepared onboarding request version is unavailable');
  return expected.rowVersion;
}

function transitionAttribution(
  target: PendingActionV2['targets'][number],
  lifecycleId: string,
  state: OnboardingRequest['state'],
  fields: readonly ExpectedField[],
): ExpectedPostcondition['attributionRefs'] {
  const sourceVersion = requestSourceVersion(target);
  return [{
    ref: target.ref,
    rowVersion: sourceVersion + 1,
    fields: [
      { path: 'state', expected: state },
      { path: 'lifecycleId', expected: lifecycleId },
      ...fields,
    ],
  }];
}

function expectedPostconditions(
  action: PendingActionV2,
  executionId: string,
  confirmedAt: string,
): ExpectedPostcondition[] {
  instantSchema.parse(confirmedAt);
  const payload = action.payload;
  invariant(payload.kind === 'onboarding_manager_approve' || payload.kind === 'onboarding_director_approve' ||
    payload.kind === 'onboarding_return' || payload.kind === 'onboarding_start',
  'WORKFLOW_CALLBACK_CONTRACT', 'The approved payload is not an HR onboarding transition');
  return action.targets.map(target => {
    const requestId = target.ref.id;
    const lifecycle = target.expectedRows.find(row =>
      row.ref.table === 'onboarding_requests' && row.ref.id === requestId,
    );
    invariant(lifecycle, 'WORKFLOW_CALLBACK_CONTRACT', 'The prepared request guard is absent');
    const lifecycleId = lifecycleFromTargetId(target.targetId, requestId);
    if (payload.kind === 'onboarding_start') {
      invariant(target.expectedEffectRef.table === 'onboarding_checklists',
        'WORKFLOW_CALLBACK_CONTRACT', 'The start effect is not a checklist');
      return {
        targetId: target.targetId,
        ref: target.expectedEffectRef,
        rowVersion: target.expectedEffectVersion,
        executionId,
        fields: [
          { path: 'requestId', expected: requestId },
          { path: 'templateId', expected: CHECKLIST_TEMPLATE_ID },
          { path: 'status', expected: 'open' },
          { path: 'executionId', expected: executionId },
          { path: 'createdAt', expected: confirmedAt },
        ],
        attributionRefs: transitionAttribution(target, lifecycleId, 'onboarding_in_progress', [
          { path: 'updatedAt', expected: confirmedAt },
          { path: 'managerApprovalEventId', expected: stableEventId({ id: requestId, lifecycleId }, 'manager') },
          { path: 'directorApprovalEventId', expected: stableEventId({ id: requestId, lifecycleId }, 'director') },
        ]),
      };
    }
    const flow = REVIEW_FLOWS.find(candidate => candidate.kind === payload.kind);
    invariant(flow && target.expectedEffectRef.table === 'onboarding_approval_events',
      'WORKFLOW_CALLBACK_CONTRACT', 'The approval event reference is invalid');
    const actorIdentityId = target.ownerIdentityId;
    const fields: ExpectedField[] = [
      { path: 'requestId', expected: requestId },
      { path: 'actorIdentityId', expected: actorIdentityId },
      { path: 'stage', expected: flow.stage },
      { path: 'lifecycleId', expected: lifecycleId },
      { path: 'executionId', expected: executionId },
      { path: 'decision', expected: flow.decision },
      { path: 'createdAt', expected: confirmedAt },
    ];
    if (payload.kind === 'onboarding_return') fields.push({ path: 'reason', expected: payload.reason });
    const requestFields: ExpectedField[] = [{ path: 'updatedAt', expected: confirmedAt }];
    if (payload.kind === 'onboarding_manager_approve') requestFields.push(
      { path: 'managerApprovalEventId', expected: target.expectedEffectRef.id },
      { path: 'managerApprovedBy', expected: target.ownerIdentityId },
      { path: 'managerApprovedAt', expected: confirmedAt },
    );
    if (payload.kind === 'onboarding_director_approve') requestFields.push(
      { path: 'directorApprovalEventId', expected: target.expectedEffectRef.id },
      { path: 'directorApprovedBy', expected: target.ownerIdentityId },
      { path: 'directorApprovedAt', expected: confirmedAt },
    );
    if (payload.kind === 'onboarding_return') requestFields.push(
      { path: 'managerApprovalEventId', expected: null },
      { path: 'managerApprovedBy', expected: null },
      { path: 'managerApprovedAt', expected: null },
      { path: 'directorApprovalEventId', expected: null },
      { path: 'directorApprovedBy', expected: null },
      { path: 'directorApprovedAt', expected: null },
    );
    return {
      targetId: target.targetId,
      ref: target.expectedEffectRef,
      rowVersion: target.expectedEffectVersion,
      executionId,
      fields,
      attributionRefs: transitionAttribution(target, lifecycleId, flow.nextState, requestFields),
    };
  });
}

function assertTargetSetMatches(
  action: PendingActionV2,
  requestIds: readonly string[],
): void {
  const targets = action.targets.filter(target => target.ref.table === 'onboarding_requests');
  const actualIds = targets.map(target => target.ref.id).sort();
  invariant(targets.length === action.targets.length && digest(actualIds) === digest([...requestIds].sort()),
    'WORKFLOW_STALE', 'The approved target set changed', 409);
}

function assertFrozenTarget(
  target: PendingActionV2['targets'][number],
  request: OnboardingRequest,
  identityId: string,
  kind: WorkflowActionKind,
  transition: string,
  stage: ApprovalStage | 'start',
  effectTable: 'onboarding_approval_events' | 'onboarding_checklists',
): void {
  const expectedId = stage === 'start'
    ? stableChecklistId(request)
    : stableEventId(request, stage);
  invariant(target.targetId === stableTargetId(request) &&
    target.semanticKey === stableSemanticKey(kind, request, transition) &&
    digest(target.ref) === digest({ table: 'onboarding_requests', id: request.id }) &&
    target.ownerIdentityId === identityId &&
    digest(target.expectedEffectRef) === digest({ table: effectTable, id: expectedId }) &&
    target.expectedEffectVersion === 1,
  'WORKFLOW_STALE', 'The prepared onboarding identity or effect reference changed', 409);
}

async function executeReviewFlow(
  context: WorkflowPackReadContext & { tx: import('../workflows/contracts').GuardedTransaction; action: PendingActionV2; executionId: string },
  payload: ReviewPayload,
  flow: ReviewFlow,
): Promise<import('../workflows/contracts').CommittedTarget[]> {
  const runtime = runtimeContext(context);
  const identity = assertActorAuthority(runtime, flow);
  const requestIds = requestIdsFrom(payload);
  assertTargetSetMatches(context.action, requestIds);
  const prepared: { target: PendingActionV2['targets'][number]; sources: RequestSources }[] = [];
  for (const requestId of requestIds) {
    const requestRow = await readRequest(runtime.projections, requestId);
    const request = requestRow.body;
    assertAssignedActor(runtime, identity, request, flow);
    invariant(request.state === flow.sourceState, 'WORKFLOW_STALE', 'A selected request changed before execution', 409);
    if (flow.stage === 'manager') {
      invariant(request.managerApprovalEventId === null && request.managerApprovedBy === null &&
        request.managerApprovedAt === null && request.directorApprovalEventId === null &&
        request.directorApprovedBy === null && request.directorApprovedAt === null,
      'WORKFLOW_STALE', 'The manager review pointers changed before execution', 409);
    } else {
      invariant(request.directorApprovalEventId === null && request.directorApprovedBy === null &&
        request.directorApprovedAt === null,
      'WORKFLOW_STALE', 'The Director review pointers changed before execution', 409);
    }
    const sources = await readSources(runtime, requestRow, {
      managerProof: flow.requiresManagerProof,
      directorProof: false,
    });
    assertEmployeeBranchScope(runtime, request, sources.employeeRow, flow);
    if (flow.requiresCompleteDocuments) assertDocumentsComplete(sources.documents);
    const target = actionTargetForRequest(context.action, requestId);
    assertFrozenTarget(target, request, identity.id, flow.kind, flow.stage, flow.stage, 'onboarding_approval_events');
    invariant(digest(mergeExpectedRows(target.expectedRows)) === digest(mergeExpectedRows(sources.expectedRows)),
      'WORKFLOW_STALE', 'A selected onboarding source changed before execution', 409);
    prepared.push({ target, sources });
  }
  for (const { target, sources } of prepared) {
    const request = sources.request;
    const event: ApprovalEvent = {
      id: target.expectedEffectRef.id,
      rowVersion: 1,
      requestId: request.id,
      actorIdentityId: identity.id,
      stage: flow.stage,
      lifecycleId: request.lifecycleId,
      executionId: context.executionId,
      decision: flow.decision,
      ...(flow.kind === 'onboarding_return' && payload.kind === 'onboarding_return' ? { reason: payload.reason } : {}),
      createdAt: context.now().toISOString(),
    };
    const inserted = await context.tx.insertUnique('onboarding_approval_events', event, {
      constraint: 'onboarding_approval_lifecycle_stage_unique',
      values: { requestId: request.id, lifecycleId: request.lifecycleId, stage: flow.stage },
    });
    invariant(inserted.inserted, 'WORKFLOW_STALE', 'An onboarding decision already exists for this lifecycle', 409);
    const next: OnboardingRequest = {
      ...request,
      rowVersion: request.rowVersion + 1,
      state: flow.nextState,
      updatedAt: context.now().toISOString(),
      ...(flow.kind === 'onboarding_manager_approve' ? {
        managerApprovalEventId: event.id,
        managerApprovedBy: identity.id,
        managerApprovedAt: event.createdAt,
      } : {}),
      ...(flow.kind === 'onboarding_director_approve' ? {
        directorApprovalEventId: event.id,
        directorApprovedBy: identity.id,
        directorApprovedAt: event.createdAt,
      } : {}),
      ...(flow.kind === 'onboarding_return' ? {
        managerApprovalEventId: null,
        managerApprovedBy: null,
        managerApprovedAt: null,
        directorApprovalEventId: null,
        directorApprovedBy: null,
        directorApprovedAt: null,
      } : {}),
    };
    const changed = await context.tx.compareAndSwap('onboarding_requests', request.id,
      { rowVersion: request.rowVersion, state: flow.sourceState }, next);
    invariant(changed.updated, 'WORKFLOW_STALE', 'The onboarding request changed during execution', 409);
  }
  return prepared.map(({ target }) => ({
    targetId: target.targetId,
    ref: target.expectedEffectRef,
    executionId: context.executionId,
    rowVersion: target.expectedEffectVersion,
  }));
}

async function prepareStart(
  context: RuntimeReadContext,
  payload: StartPayload,
): Promise<{ target: ReturnType<typeof semanticTarget>; expectedRows: ExpectedRow[]; approvedBranchIds: string[]; approvedOrgUnitIds: string[] }> {
  const identity = assertActorAuthority(context, {
    permission: 'hr.onboarding.start',
    readPermission: 'hr.read',
    role: 'hr_admin',
    purpose: 'hr_operations',
  });
  const requestRow = await readRequest(context.projections, payload.requestId);
  const request = requestRow.body;
  authorizeWorkflowScope(context.principal, {
    permission: 'hr.onboarding.start',
    roles: ['hr_admin'],
    purpose: 'hr_operations',
    targets: [{ orgUnitId: request.orgUnitId }],
  });
  invariant(request.state === 'director_approved', 'WORKFLOW_STALE', 'Only Director-approved onboarding can start', 409);
  invariant(request.directorApprovalEventId && request.directorApprovedBy && request.directorApprovedAt,
    'WORKFLOW_STALE', 'The current Director approval proof is incomplete', 409);
  const sources = await readSources(context, requestRow, { managerProof: true, directorProof: true });
  const branchRow = assertEmployeeBranchScope(context, request, sources.employeeRow, {
    permission: 'hr.onboarding.start',
    role: 'hr_admin',
    purpose: 'hr_operations',
  });
  invariant(branchRow.id === sources.branchRow.id, 'WORKFLOW_STALE', 'The onboarding branch changed during start preparation', 409);
  assertDocumentsComplete(sources.documents);
  const checklists = await context.projections.query<{ id: string; requestId: string; templateId: string } & Record<string, unknown>>({
    kind: 'unique',
    table: 'onboarding_checklists',
    constraint: 'onboarding_checklists_request_template_unique',
    values: { requestId: request.id, templateId: CHECKLIST_TEMPLATE_ID },
  });
  invariant(checklists.length === 0, 'WORKFLOW_STALE', 'An onboarding checklist already exists for this request', 409);
  const target = semanticTarget(
    request,
    identity.id,
    'onboarding_start',
    'start',
    sources.expectedRows,
    { table: 'onboarding_checklists', id: stableChecklistId(request) },
  );
  return {
    target,
    expectedRows: sources.expectedRows,
    approvedBranchIds: [branchRow.id],
    approvedOrgUnitIds: [request.orgUnitId],
  };
}

async function executeStart(
  context: WorkflowPackReadContext & { tx: import('../workflows/contracts').GuardedTransaction; action: PendingActionV2; executionId: string },
  payload: StartPayload,
): Promise<import('../workflows/contracts').CommittedTarget[]> {
  const runtime = runtimeContext(context);
  const identity = assertActorAuthority(runtime, {
    permission: 'hr.onboarding.start',
    readPermission: 'hr.read',
    role: 'hr_admin',
    purpose: 'hr_operations',
  });
  assertTargetSetMatches(context.action, [payload.requestId]);
  const target = actionTargetForRequest(context.action, payload.requestId);
  const requestRow = await readRequest(runtime.projections, payload.requestId);
  const request = requestRow.body;
  authorizeWorkflowScope(runtime.principal, {
    permission: 'hr.onboarding.start',
    roles: ['hr_admin'],
    purpose: 'hr_operations',
    targets: [{ orgUnitId: request.orgUnitId }],
  });
  invariant(request.state === 'director_approved' && request.directorApprovalEventId &&
    request.directorApprovedBy && request.directorApprovedAt,
  'WORKFLOW_STALE', 'Only currently approved onboarding can start', 409);
  const sources = await readSources(runtime, requestRow, { managerProof: true, directorProof: true });
  assertEmployeeBranchScope(runtime, request, sources.employeeRow, {
    permission: 'hr.onboarding.start',
    role: 'hr_admin',
    purpose: 'hr_operations',
  });
  assertDocumentsComplete(sources.documents);
  assertFrozenTarget(target, request, identity.id, 'onboarding_start', 'start', 'start', 'onboarding_checklists');
  invariant(digest(mergeExpectedRows(target.expectedRows)) === digest(mergeExpectedRows(sources.expectedRows)),
    'WORKFLOW_STALE', 'An onboarding source changed before start', 409);
  const existing = await runtime.projections.query<{ id: string; requestId: string; templateId: string } & Record<string, unknown>>({
    kind: 'unique',
    table: 'onboarding_checklists',
    constraint: 'onboarding_checklists_request_template_unique',
    values: { requestId: request.id, templateId: CHECKLIST_TEMPLATE_ID },
  });
  invariant(existing.length === 0, 'WORKFLOW_STALE', 'An onboarding checklist already exists for this request', 409);
  const confirmedAt = context.now().toISOString();
  const checklist = {
    id: target.expectedEffectRef.id,
    rowVersion: 1,
    requestId: request.id,
    templateId: CHECKLIST_TEMPLATE_ID,
    status: 'open' as const,
    title: CHECKLIST_TITLE,
    executionId: context.executionId,
    createdAt: confirmedAt,
  };
  const inserted = await context.tx.insertUnique('onboarding_checklists', checklist, {
    constraint: 'onboarding_checklists_request_template_unique',
    values: { requestId: request.id, templateId: CHECKLIST_TEMPLATE_ID },
  });
  invariant(inserted.inserted, 'WORKFLOW_STALE', 'An onboarding checklist was concurrently created', 409);
  const next: OnboardingRequest = {
    ...request,
    rowVersion: request.rowVersion + 1,
    state: 'onboarding_in_progress',
    updatedAt: confirmedAt,
  };
  const changed = await context.tx.compareAndSwap('onboarding_requests', request.id,
    { rowVersion: request.rowVersion, state: 'director_approved' }, next);
  invariant(changed.updated, 'WORKFLOW_STALE', 'The onboarding request changed during start', 409);
  return [{
    targetId: target.targetId,
    ref: target.expectedEffectRef,
    executionId: context.executionId,
    rowVersion: target.expectedEffectVersion,
  }];
}

async function confirmTime(context: RuntimeReadContext, actionId: string): Promise<string | null> {
  const rows = await context.projections.query<{ id: string; actionId: string; confirmedAt: string }>({
    kind: 'unique',
    table: 'action_confirmations',
    constraint: 'action_confirmations_action_unique',
    values: { actionId },
  });
  if (rows.length !== 1) return null;
  const confirmedAt = rows[0].body.confirmedAt;
  return instantSchema.safeParse(confirmedAt).success ? confirmedAt : null;
}

async function verifiedExecutionProof(
  context: RuntimeReadContext,
  executionId: string,
  kind: WorkflowActionKind,
  ref: Ref,
): Promise<WorkflowReceiptV2 | null> {
  const row = await context.projections.get<WorkflowReceiptV2>('action_executions', executionId);
  if (!row) return null;
  const receipt = workflowReceiptV2Schema.safeParse(row.body);
  if (!receipt.success || receipt.data.id !== executionId || receipt.data.kind !== kind ||
    receipt.data.outcome !== 'verified_success') return null;
  return receipt.data.proofs.some(proof => proof.executionId === executionId &&
    proof.outcome === 'verified_success' && digest(proof.ref) === digest(ref))
    ? receipt.data
    : null;
}

function proofResult(
  targetId: string,
  ref: Ref,
  executionId: string,
  rowVersion: number | null,
  checkedAt: string | null,
  valid: boolean,
): TargetProof {
  return {
    targetId,
    ref,
    executionId,
    outcome: valid ? 'verified_success' : 'pending',
    observedRowVersion: valid ? rowVersion : null,
    checkedAt: valid ? checkedAt : null,
    mismatchCodes: valid ? [] : ['INDEPENDENT_READBACK_MISMATCH'],
  };
}

async function unchangedPreconditionsMatch(
  context: RuntimeReadContext,
  target: PendingActionV2['targets'][number],
): Promise<boolean> {
  for (const expected of target.expectedRows) {
    if (digest(expected.ref) === digest(target.ref) || digest(expected.ref) === digest(target.expectedEffectRef)) continue;
    const current = await context.projections.get<Record<string, unknown>>(expected.ref.table, expected.ref.id);
    if (!current || current.rowVersion !== expected.rowVersion ||
      projectionState(expected.ref.table, current.body) !== expected.state) return false;
  }
  return true;
}

async function verifyReviewFlow(
  context: WorkflowPackReadContext & { action: PendingActionV2; executionId: string },
  flow: ReviewFlow,
  committed: import('../workflows/contracts').CommittedTarget[],
): Promise<TargetProof[]> {
  const runtime = runtimeContext(context);
  const identity = assertActorAuthority(runtime, flow);
  const payload = context.action.payload;
  invariant(payload.kind === flow.kind, 'WORKFLOW_CALLBACK_CONTRACT', 'The confirmed action kind changed');
  const confirmedAt = await confirmTime(runtime, context.action.id);
  return Promise.all(committed.map(async result => {
    const target = actionTargetForTargetId(context.action, result.targetId);
    invariant(target.ref.table === 'onboarding_requests', 'WORKFLOW_CALLBACK_CONTRACT', 'The prepared onboarding request reference is invalid');
    const requestRow = await readRequest(runtime.projections, target.ref.id);
    const request = requestRow.body;
    assertAssignedActor(runtime, identity, request, flow);
    const employeeRow = await readEmployee(runtime.projections, request.employeeId);
    assertEmployeeBranchScope(runtime, request, employeeRow, flow);
    const sourceGuardsMatch = await unchangedPreconditionsMatch(runtime, target);
    let managerProofStillValid = flow.kind !== 'onboarding_director_approve';
    if (flow.kind === 'onboarding_director_approve') {
      const sources = await readSources(runtime, requestRow, { managerProof: true, directorProof: false });
      assertDocumentsComplete(sources.documents);
      managerProofStillValid = sources.managerProof !== null;
    }
    const eventRow = await runtime.projections.get<ApprovalEvent>('onboarding_approval_events', result.ref.id);
    if (!eventRow) return proofResult(result.targetId, result.ref, context.executionId, null, null, false);
    const event = approvalEventSchema.parse(eventRow.body);
    const expectedReason = payload.kind === 'onboarding_return' ? payload.reason : undefined;
    const validEvent = event.id === target.expectedEffectRef.id && event.requestId === request.id &&
      event.actorIdentityId === identity.id && event.stage === flow.stage &&
      event.lifecycleId === request.lifecycleId && event.executionId === context.executionId &&
      event.decision === flow.decision && event.createdAt === confirmedAt &&
      event.reason === expectedReason;
    let validRequest = false;
    if (flow.kind === 'onboarding_manager_approve') {
      validRequest = request.state === 'director_approval_pending' &&
        request.managerApprovalEventId === event.id && request.managerApprovedBy === identity.id &&
        request.managerApprovedAt === event.createdAt && request.directorApprovalEventId === null;
    } else if (flow.kind === 'onboarding_director_approve') {
      validRequest = request.state === 'director_approved' &&
        request.directorApprovalEventId === event.id && request.directorApprovedBy === identity.id &&
        request.directorApprovedAt === event.createdAt;
    } else {
      validRequest = request.state === 'returned_for_revision' &&
        request.managerApprovalEventId === null && request.managerApprovedBy === null &&
        request.managerApprovedAt === null && request.directorApprovalEventId === null &&
        request.directorApprovedBy === null && request.directorApprovedAt === null;
    }
    const expectedRequestVersion = requestSourceVersion(target) + 1;
    const valid = validEvent && validRequest && sourceGuardsMatch && managerProofStillValid &&
      request.rowVersion === expectedRequestVersion &&
      eventRow.rowVersion === result.rowVersion && result.ref.id === target.expectedEffectRef.id &&
      result.rowVersion === target.expectedEffectVersion && confirmedAt !== null;
    return proofResult(result.targetId, result.ref, context.executionId, eventRow.rowVersion,
      confirmedAt, valid);
  }));
}

async function verifyStart(
  context: WorkflowPackReadContext & { action: PendingActionV2; executionId: string },
  committed: import('../workflows/contracts').CommittedTarget[],
): Promise<TargetProof[]> {
  const runtime = runtimeContext(context);
  assertActorAuthority(runtime, {
    permission: 'hr.onboarding.start',
    readPermission: 'hr.read',
    role: 'hr_admin',
    purpose: 'hr_operations',
  });
  const confirmedAt = await confirmTime(runtime, context.action.id);
  return Promise.all(committed.map(async result => {
    const target = actionTargetForTargetId(context.action, result.targetId);
    invariant(target.ref.table === 'onboarding_requests', 'WORKFLOW_CALLBACK_CONTRACT', 'The prepared onboarding request reference is invalid');
    const requestRow = await readRequest(runtime.projections, target.ref.id);
    const request = requestRow.body;
    authorizeWorkflowScope(runtime.principal, {
      permission: 'hr.onboarding.start',
      roles: ['hr_admin'],
      purpose: 'hr_operations',
      targets: [{ orgUnitId: request.orgUnitId }],
    });
    const employeeRow = await readEmployee(runtime.projections, request.employeeId);
    assertEmployeeBranchScope(runtime, request, employeeRow, {
      permission: 'hr.onboarding.start',
      role: 'hr_admin',
      purpose: 'hr_operations',
    });
    const sourceGuardsMatch = await unchangedPreconditionsMatch(runtime, target);
    const sources = await readSources(runtime, requestRow, { managerProof: true, directorProof: true });
    assertDocumentsComplete(sources.documents);
    const checklistRow = await runtime.projections.get<Record<string, unknown>>('onboarding_checklists', result.ref.id);
    const valid = !!checklistRow && checklistRow.body.id === target.expectedEffectRef.id &&
      checklistRow.body.requestId === request.id && checklistRow.body.templateId === CHECKLIST_TEMPLATE_ID &&
      checklistRow.body.status === 'open' && checklistRow.body.executionId === context.executionId &&
      checklistRow.body.createdAt === confirmedAt && request.state === 'onboarding_in_progress' &&
      request.rowVersion === requestSourceVersion(target) + 1 && sourceGuardsMatch &&
      request.managerApprovalEventId !== null && request.directorApprovalEventId !== null &&
      result.ref.id === target.expectedEffectRef.id && result.rowVersion === target.expectedEffectVersion &&
      checklistRow.rowVersion === result.rowVersion && confirmedAt !== null;
    return proofResult(result.targetId, result.ref, context.executionId,
      checklistRow?.rowVersion ?? null, confirmedAt, valid);
  }));
}

async function currentStates(
  context: WorkflowPackReadContext,
  refs: Ref[],
): Promise<CurrentState[]> {
  const runtime = runtimeContext(context);
  const states: CurrentState[] = [];
  for (const ref of refs) {
    if (ref.table !== 'onboarding_requests') continue;
    const projection = await runtime.projections.get<OnboardingRequest>('onboarding_requests', ref.id);
    if (!projection) continue;
    const request = onboardingRequestSchema.parse(projection.body);
    const identity = directoryIdentitySchema.parse(runtime.principal.directory.body);
    const allowedNextActions: WorkflowActionKind[] = [];
    if (request.state === 'manager_review_pending' && identity.role === 'east_manager' &&
      identity.id === request.managerIdentityId && identity.active &&
      runtime.actor.permissions.includes('hr.onboarding.manager_read') &&
      runtime.actor.permissions.includes('hr.onboarding.manager_approve') &&
      hasResponsibility(runtime, identity.id, request.orgUnitId, 'manager_onboarding')) {
      const sources = await readSources(runtime, { ...projection, body: request }, { managerProof: false, directorProof: false });
      assertEmployeeBranchScope(runtime, request, sources.employeeRow, {
        permission: 'hr.onboarding.manager_approve',
        role: 'east_manager',
        purpose: 'manager_onboarding',
      });
      if (request.managerApprovalEventId === null && request.managerApprovedBy === null &&
        request.managerApprovedAt === null && request.directorApprovalEventId === null &&
        request.directorApprovedBy === null && request.directorApprovedAt === null &&
        demoWorkflowPolicyV1.requiredOnboardingDocuments.every(type =>
          sources.documents.some(row => row.body.documentType === type && row.body.status === 'accepted'),
        )) {
        allowedNextActions.push('onboarding_manager_approve');
      }
    }
    if (request.state === 'director_approval_pending' && identity.role === 'hr_director' &&
      identity.id === request.directorIdentityId && identity.active &&
      hasResponsibility(runtime, identity.id, request.orgUnitId, 'director_onboarding') &&
      runtime.actor.permissions.includes('hr.onboarding.director_read') &&
      (runtime.actor.permissions.includes('hr.onboarding.director_approve') || runtime.actor.permissions.includes('hr.onboarding.return'))) {
      const sources = await readSources(runtime, { ...projection, body: request }, { managerProof: true, directorProof: false });
      assertEmployeeBranchScope(runtime, request, sources.employeeRow, {
        permission: runtime.actor.permissions.includes('hr.onboarding.director_approve')
          ? 'hr.onboarding.director_approve'
          : 'hr.onboarding.return',
        role: 'hr_director',
        purpose: 'director_onboarding',
      });
      if (sources.managerProof && demoWorkflowPolicyV1.requiredOnboardingDocuments.every(type =>
        sources.documents.some(row => row.body.documentType === type &&
          row.body.status === 'accepted'),
      )) {
        if (runtime.actor.permissions.includes('hr.onboarding.director_approve')) allowedNextActions.push('onboarding_director_approve');
        if (runtime.actor.permissions.includes('hr.onboarding.return')) allowedNextActions.push('onboarding_return');
      }
    }
    if (request.state === 'director_approved' && identity.role === 'hr_admin' && identity.active &&
      runtime.actor.permissions.includes('hr.read') &&
      runtime.actor.permissions.includes('hr.onboarding.start') &&
      hasResponsibility(runtime, identity.id, request.orgUnitId, 'hr_operations')) {
      const sources = await readSources(runtime, { ...projection, body: request }, { managerProof: true, directorProof: true });
      assertEmployeeBranchScope(runtime, request, sources.employeeRow, {
        permission: 'hr.onboarding.start',
        role: 'hr_admin',
        purpose: 'hr_operations',
      });
      assertDocumentsComplete(sources.documents);
      const checklists = await runtime.projections.query<{ id: string; requestId: string; templateId: string } & Record<string, unknown>>({
        kind: 'unique',
        table: 'onboarding_checklists',
        constraint: 'onboarding_checklists_request_template_unique',
        values: { requestId: request.id, templateId: CHECKLIST_TEMPLATE_ID },
      });
      if (checklists.length === 0) allowedNextActions.push('onboarding_start');
    }
    const completedActions: CurrentState['completedActions'] = [];
    if (request.managerApprovalEventId) {
      const event = await runtime.projections.get<ApprovalEvent>('onboarding_approval_events', request.managerApprovalEventId);
      const parsed = event && approvalEventSchema.safeParse(event.body);
      if (event && parsed?.success && parsed.data.executionId && parsed.data.stage === 'manager' &&
        parsed.data.lifecycleId === request.lifecycleId && parsed.data.decision === 'approved' &&
        await verifiedExecutionProof(runtime, parsed.data.executionId, 'onboarding_manager_approve', {
          table: 'onboarding_approval_events', id: event.id,
        })) {
        completedActions.push({ kind: 'onboarding_manager_approve', executionId: event.body.executionId, completedAt: event.body.createdAt });
      }
    }
    if (request.directorApprovalEventId) {
      const event = await runtime.projections.get<ApprovalEvent>('onboarding_approval_events', request.directorApprovalEventId);
      const parsed = event && approvalEventSchema.safeParse(event.body);
      if (event && parsed?.success && parsed.data.executionId && parsed.data.stage === 'director' &&
        parsed.data.lifecycleId === request.lifecycleId && parsed.data.decision === 'approved' &&
        await verifiedExecutionProof(runtime, parsed.data.executionId, 'onboarding_director_approve', {
          table: 'onboarding_approval_events', id: event.id,
        })) {
        completedActions.push({ kind: 'onboarding_director_approve', executionId: event.body.executionId, completedAt: event.body.createdAt });
      }
    }
    if (request.state === 'returned_for_revision') {
      const event = await runtime.projections.get<ApprovalEvent>('onboarding_approval_events', stableEventId(request, 'return'));
      const parsed = event && approvalEventSchema.safeParse(event.body);
      if (event && parsed?.success && parsed.data.executionId && parsed.data.stage === 'return' &&
        parsed.data.lifecycleId === request.lifecycleId && parsed.data.decision === 'returned_for_revision' &&
        await verifiedExecutionProof(runtime, parsed.data.executionId, 'onboarding_return', {
          table: 'onboarding_approval_events', id: event.id,
        })) {
        completedActions.push({ kind: 'onboarding_return', executionId: event.body.executionId, completedAt: event.body.createdAt });
      }
    }
    if (request.state === 'onboarding_in_progress') {
      const rows = await runtime.projections.query<Record<string, unknown>>({
        kind: 'unique',
        table: 'onboarding_checklists',
        constraint: 'onboarding_checklists_request_template_unique',
        values: { requestId: request.id, templateId: CHECKLIST_TEMPLATE_ID },
      });
      const checklist = rows[0]?.body;
      if (checklist?.executionId && typeof checklist.executionId === 'string' &&
        typeof checklist.createdAt === 'string' && await verifiedExecutionProof(runtime, checklist.executionId,
          'onboarding_start', { table: 'onboarding_checklists', id: rows[0].id })) {
        completedActions.push({ kind: 'onboarding_start', executionId: checklist.executionId, completedAt: checklist.createdAt });
      }
    }
    states.push({
      ref,
      state: request.state,
      rowVersion: projection.rowVersion,
      allowedNextActions,
      completedActions,
    });
  }
  return states;
}

function hasResponsibility(
  context: RuntimeReadContext,
  identityId: string,
  orgUnitId: string,
  purpose: 'manager_onboarding' | 'director_onboarding' | 'hr_operations',
): boolean {
  return context.principal.responsibilities.some(row => row.body.active &&
    row.body.identityId === identityId && row.body.orgUnitId === orgUnitId && row.body.purpose === purpose);
}

function currentStateCallback(context: WorkflowPackReadContext, refs: Ref[]): Promise<CurrentState[]> {
  return currentStates(context, refs);
}

function createReviewBinding(flow: ReviewFlow): WorkflowRuntimeBinding {
  return defineWorkflowBinding({
    kind: flow.kind,
    contractVersion: 2,
    packIds: ['hr'],
    executionMode: 'atomic_local',
    authority: { permission: flow.permission, roles: [flow.role], purpose: flow.purpose },
    async identify(context, payload) {
      const identity = assertActorAuthority(context, flow);
      await loadReviewedSnapshot(context, payload as ReviewPayload, flow);
      const targets = [];
      for (const requestId of requestIdsFrom(payload as ReviewPayload)) {
        const row = await readRequest(context.projections, requestId);
        assertAssignedActor(context, identity, row.body, flow);
        const employee = await readEmployee(context.projections, row.body.employeeId);
        const branch = assertEmployeeBranchScope(context, row.body, employee, flow);
        targets.push({
          targetId: stableTargetId(row.body),
          ref: { table: 'onboarding_requests' as const, id: row.id },
          semanticKey: stableSemanticKey(flow.kind, row.body, flow.stage),
          scope: { orgUnitId: row.body.orgUnitId, branchId: branch.id },
        });
      }
      return { targets };
    },
    expectedPostconditions,
    async validate(context, payload) {
      const runtime = runtimeContext(context);
      const prepared = await prepareReviewFlow(runtime, payload as ReviewPayload, flow);
      return {
        targets: prepared.targets,
        expectedRows: prepared.expectedRows,
        approvedBranchIds: prepared.approvedBranchIds,
        approvedOrgUnitIds: prepared.approvedOrgUnitIds,
        policy: getDemoWorkflowPolicyV1Pin(),
        reviewedSnapshotId: prepared.snapshot.id,
      };
    },
    executeAtomic: (context, payload) => executeReviewFlow(context, payload as ReviewPayload, flow),
    async verify(context, committed) {
      return verifyReviewFlow(context, flow, committed);
    },
    currentStates: currentStateCallback,
  });
}

function createStartBinding(): WorkflowRuntimeBinding {
  return defineWorkflowBinding({
    kind: 'onboarding_start',
    contractVersion: 2,
    packIds: ['hr'],
    executionMode: 'atomic_local',
    authority: { permission: 'hr.onboarding.start', roles: ['hr_admin'], purpose: 'hr_operations' },
    async identify(context, payload) {
      assertActorAuthority(context, {
        permission: 'hr.onboarding.start',
        readPermission: 'hr.read',
        role: 'hr_admin',
        purpose: 'hr_operations',
      });
      const row = await readRequest(context.projections, payload.requestId);
      const employee = await readEmployee(context.projections, row.body.employeeId);
      const branch = assertEmployeeBranchScope(context, row.body, employee, {
        permission: 'hr.onboarding.start',
        role: 'hr_admin',
        purpose: 'hr_operations',
      });
      return { targets: [{
        targetId: stableTargetId(row.body),
        ref: { table: 'onboarding_requests', id: row.id },
        semanticKey: stableSemanticKey('onboarding_start', row.body, 'start'),
        scope: { orgUnitId: row.body.orgUnitId, branchId: branch.id },
      }] };
    },
    expectedPostconditions,
    async validate(context, payload) {
      const runtime = runtimeContext(context);
      const prepared = await prepareStart(runtime, payload as StartPayload);
      return {
        targets: [prepared.target],
        expectedRows: prepared.expectedRows,
        approvedBranchIds: prepared.approvedBranchIds,
        approvedOrgUnitIds: prepared.approvedOrgUnitIds,
        policy: getDemoWorkflowPolicyV1Pin(),
        reviewedSnapshotId: null,
      };
    },
    executeAtomic: (context, payload) => executeStart(context, payload as StartPayload),
    async verify(context, committed) {
      return verifyStart(context, committed);
    },
    currentStates: currentStateCallback,
  });
}

export function createHrApprovalWorkflowBindings(): WorkflowRuntimeBinding[] {
  return [
    ...REVIEW_FLOWS.map(createReviewBinding),
    createStartBinding(),
  ];
}
