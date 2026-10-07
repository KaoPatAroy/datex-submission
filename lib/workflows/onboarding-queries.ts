import { z } from 'zod';
import { invariant } from '../core/errors';
import {
  directoryIdentitySchema,
  expectedRowSchema,
  onboardingRequestSchema,
  responsibilitySchema,
  reviewSnapshotSchema,
  workflowReceiptV2Schema,
  type DirectoryIdentity,
  type ExpectedRow,
  type OnboardingRequest,
  type Ref,
  type ReviewSnapshot,
  type WorkflowReceiptV2,
} from './contracts';
import { authorizeWorkflowScope, type WorkflowPrincipal, type WorkflowScopeGrant } from './authority';
import { freezeWorkflowValue, mergeExpectedRows, workflowRowState, workflowSnapshotDigest, type WorkflowActionRuntime, type RuntimeReadContext } from './action-runtime';
import { demoWorkflowPolicyV1, getDemoWorkflowPolicyV1Pin, pendingActionExpiresAt } from './policy';
import type { ProjectedRow } from '../storage/workflow-projections';

const MAX_ONBOARDING_QUEUE_PAGE_SIZE = 80;
// A Director target can freeze ten rows: request, employee, branch, three documents,
// and the manager event, identity, responsibility and verified execution.
const MAX_DIRECTOR_QUEUE_PAGE_SIZE = 50;
const MAX_ONBOARDING_QUEUE_SCOPE_UNITS = 100;
const MAX_ONBOARDING_QUEUE_SCAN_ROWS = 10_000;
const STORAGE_QUERY_PAGE_SIZE = 100;

const identifierSchema = onboardingRequestSchema.shape.id;
const pageInputSchema = z.object({
  cursor: identifierSchema.optional(),
  limit: z.number().int().min(1).max(MAX_ONBOARDING_QUEUE_PAGE_SIZE).default(25),
}).strict();

const employeeViewSchema = z.object({
  id: identifierSchema,
  name: z.string().min(1),
  active: z.boolean(),
  branchId: identifierSchema.nullable().optional(),
});

const onboardingDocumentSchema = z.object({
  id: identifierSchema,
  requestId: identifierSchema,
  employeeId: identifierSchema,
  documentType: z.string().min(1),
  status: z.string().min(1),
  policyVersion: z.string().optional(),
  classification: z.string().optional(),
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  withdrawnAt: z.string().nullable().optional(),
});

const approvalEventSchema = z.object({
  id: identifierSchema,
  requestId: identifierSchema,
  actorIdentityId: identifierSchema,
  stage: z.enum(['manager', 'director']),
  lifecycleId: identifierSchema,
  executionId: identifierSchema,
  decision: z.enum(['approved', 'returned_for_revision']),
  createdAt: z.string().datetime({ offset: true }),
});

export interface OnboardingQueuePageInput {
  cursor?: string;
  limit?: number;
}

export interface OnboardingQueueItem {
  request: Pick<OnboardingRequest, 'id' | 'employeeId' | 'orgUnitId' | 'startDate' | 'state' | 'rowVersion' | 'lifecycleId' | 'createdAt' | 'updatedAt'>;
  employee: { id: string; name: string; active: boolean; branchId: string };
  documents: { id: string; documentType: string; status: 'accepted' }[];
}

export interface OnboardingApprovalTodayItem {
  request: OnboardingQueueItem['request'];
  employee: OnboardingQueueItem['employee'];
  approval: { eventId: string; actorIdentityId: string; actorName: string; approvedAt: string };
}

export interface OnboardingReadyForStartItem extends OnboardingQueueItem {
  approvals: {
    manager: { eventId: string; actorIdentityId: string; approvedAt: string };
    director: { eventId: string; actorIdentityId: string; approvedAt: string };
  };
}

export interface OnboardingReadModelPage<T> {
  asOf: string;
  items: T[];
  nextCursor: string | null;
}

export interface ReviewSnapshotTargetV2 {
  id: string;
  snapshotId: string;
  entityType: Ref['table'];
  targetId: string;
  ref: Ref;
  expectedRowVersion: number;
  expectedState: string | null;
}

export interface OnboardingQueuePage {
  snapshot: ReviewSnapshot;
  items: OnboardingQueueItem[];
  snapshotTargets: ReviewSnapshotTargetV2[];
  nextCursor: string | null;
}

interface EligibleRequest {
  item: OnboardingQueueItem;
  expectedRows: ExpectedRow[];
}

interface VerifiedApproval {
  eventRow: ProjectedRow<unknown>;
  event: z.infer<typeof approvalEventSchema>;
  identityRow: ProjectedRow<DirectoryIdentity>;
  identity: DirectoryIdentity;
  responsibilityRow?: ProjectedRow<ReturnType<typeof responsibilitySchema.parse>>;
  receiptRow: ProjectedRow<WorkflowReceiptV2>;
}

interface QueueDefinition {
  purpose: ReviewSnapshot['purpose'];
  responsibilityPurpose: 'manager_onboarding' | 'director_onboarding';
  role: 'east_manager' | 'hr_director';
  permission: 'hr.onboarding.manager_read' | 'hr.onboarding.director_read';
  state: 'manager_review_pending' | 'director_approval_pending';
  assignmentField: 'managerIdentityId' | 'directorIdentityId';
}

const queueDefinitions = {
  manager: {
    purpose: 'manager_queue',
    responsibilityPurpose: 'manager_onboarding',
    role: 'east_manager',
    permission: 'hr.onboarding.manager_read',
    state: 'manager_review_pending',
    assignmentField: 'managerIdentityId',
  },
  director: {
    purpose: 'director_queue',
    responsibilityPurpose: 'director_onboarding',
    role: 'hr_director',
    permission: 'hr.onboarding.director_read',
    state: 'director_approval_pending',
    assignmentField: 'directorIdentityId',
  },
} as const satisfies Record<'manager' | 'director', QueueDefinition>;

function parsePageInput(input: OnboardingQueuePageInput | undefined, kind: 'manager' | 'director'): z.infer<typeof pageInputSchema> {
  const parsed = pageInputSchema.safeParse(input ?? {});
  invariant(parsed.success, 'WORKFLOW_INVALID_INPUT', 'The onboarding queue request was invalid');
  invariant(parsed.data.limit <= (kind === 'director' ? MAX_DIRECTOR_QUEUE_PAGE_SIZE : MAX_ONBOARDING_QUEUE_PAGE_SIZE),
    'WORKFLOW_INVALID_INPUT', 'The onboarding queue page exceeds the supported limit');
  return parsed.data;
}

function parseReadModelPageInput(input: OnboardingQueuePageInput | undefined): z.infer<typeof pageInputSchema> {
  const parsed = pageInputSchema.safeParse(input ?? {});
  invariant(parsed.success, 'WORKFLOW_INVALID_INPUT', 'The onboarding read request was invalid');
  return parsed.data;
}

function assertProjected<T extends { id: string }>(
  row: ProjectedRow<unknown> | undefined,
  schema: z.ZodType<T>,
  label: string,
): { row: ProjectedRow<unknown>; body: T } | undefined {
  if (!row) return undefined;
  const parsed = schema.safeParse(row.body);
  invariant(parsed.success && row.id === parsed.data.id && Number.isSafeInteger(row.rowVersion) && row.rowVersion > 0,
    'WORKFLOW_AUTHORITY_INVALID', `The ${label} projection was invalid`, 409);
  if ('rowVersion' in parsed.data && parsed.data.rowVersion !== undefined) {
    invariant(parsed.data.rowVersion === row.rowVersion, 'WORKFLOW_AUTHORITY_INVALID', `The ${label} projection version was inconsistent`, 409);
  }
  return { row, body: parsed.data };
}

function expectedRow(table: Ref['table'], row: ProjectedRow<unknown>, state: string | null): ExpectedRow {
  return expectedRowSchema.parse({ ref: { table, id: row.id }, rowVersion: row.rowVersion, state });
}

function exactBranchGrant(
  grants: readonly WorkflowScopeGrant[],
  principal: WorkflowPrincipal,
  orgUnitId: string,
  branchId: string,
): ProjectedRow<unknown> | undefined {
  const branch = principal.branches.find(candidate => candidate.id === branchId);
  if (!branch || branch.body.active === false ||
    (branch.body.orgUnitId !== undefined && branch.body.orgUnitId !== null && branch.body.orgUnitId !== orgUnitId)) return undefined;
  return grants.some(grant => grant.orgUnitId === orgUnitId && grant.branchIds.includes(branchId))
    ? branch
    : undefined;
}

function requestSummary(request: OnboardingRequest): OnboardingQueueItem['request'] {
  return {
      id: request.id,
      employeeId: request.employeeId,
      orgUnitId: request.orgUnitId,
      startDate: request.startDate,
      state: request.state,
      rowVersion: request.rowVersion,
      lifecycleId: request.lifecycleId,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
  };
}

function reviewItem(request: OnboardingRequest, employee: z.infer<typeof employeeViewSchema>, documents: z.infer<typeof onboardingDocumentSchema>[]): OnboardingQueueItem {
  return {
    request: requestSummary(request),
    employee: { id: employee.id, name: employee.name, active: employee.active, branchId: employee.branchId! },
    documents: documents.map(document => ({ id: document.id, documentType: document.documentType, status: 'accepted' })),
  };
}

async function readyDocuments(
  context: RuntimeReadContext,
  request: OnboardingRequest,
): Promise<{ rows: ProjectedRow<unknown>[]; bodies: z.infer<typeof onboardingDocumentSchema>[] } | undefined> {
  const rows: ProjectedRow<unknown>[] = [];
  const bodies: z.infer<typeof onboardingDocumentSchema>[] = [];
  for (const documentType of demoWorkflowPolicyV1.requiredOnboardingDocuments) {
    const matches = await context.projections.query<unknown>({
      kind: 'unique',
      table: 'onboarding_documents',
      constraint: 'onboarding_documents_request_type_unique',
      values: { requestId: request.id, documentType },
    });
    invariant(matches.length <= 1, 'WORKFLOW_AUTHORITY_INVALID', 'An onboarding document identity was ambiguous', 409);
    const projected = assertProjected(matches[0], onboardingDocumentSchema, 'onboarding document');
    if (!projected) return undefined;
    const { body, row } = projected;
    // Legacy received rows stay readable, but only the contract's accepted state is queue-ready.
    if (body.requestId !== request.id || body.employeeId !== request.employeeId || body.documentType !== documentType ||
      body.status !== 'accepted' || body.policyVersion !== demoWorkflowPolicyV1.policyAcknowledgementVersion ||
      body.classification !== demoWorkflowPolicyV1.classification || !body.contentDigest || body.withdrawnAt !== null) {
      return undefined;
    }
    rows.push(row);
    bodies.push(body);
  }
  return { rows, bodies };
}

async function readVerifiedApproval(
  context: RuntimeReadContext,
  request: OnboardingRequest,
  stage: 'manager' | 'director',
  branchId: string,
  options: { allowClearedPointer?: boolean; requireResponsibility?: boolean } = {},
): Promise<VerifiedApproval | undefined> {
  const eventId = stage === 'manager' ? request.managerApprovalEventId : request.directorApprovalEventId;
  const approvedBy = stage === 'manager' ? request.managerApprovedBy : request.directorApprovedBy;
  const approvedAt = stage === 'manager' ? request.managerApprovedAt : request.directorApprovedAt;
  const identityId = stage === 'manager' ? request.managerIdentityId : request.directorIdentityId;
  const allPointersClear = eventId === null && approvedBy === null && approvedAt === null;
  if (eventId !== null && (!approvedBy || !approvedAt)) return undefined;
  if (!eventId && (!options.allowClearedPointer || !allPointersClear)) return undefined;
  let matching: ProjectedRow<unknown> | undefined;
  if (eventId) {
    matching = await context.projections.get<unknown>('onboarding_approval_events', eventId);
  } else {
    const matches = await context.projections.query<unknown>({
      kind: 'unique',
      table: 'onboarding_approval_events',
      constraint: 'onboarding_approval_lifecycle_stage_unique',
      values: { requestId: request.id, lifecycleId: request.lifecycleId, stage },
    });
    invariant(matches.length <= 1, 'WORKFLOW_AUTHORITY_INVALID', 'An onboarding approval event identity was ambiguous', 409);
    matching = matches[0];
  }
  const projected = assertProjected(matching, approvalEventSchema, 'onboarding approval event');
  if (!projected) return undefined;
  const event = projected.body;
  if (event.requestId !== request.id || event.stage !== stage || event.lifecycleId !== request.lifecycleId ||
    event.actorIdentityId !== identityId || event.decision !== 'approved' ||
    (eventId !== null && event.id !== eventId) ||
    (approvedBy !== null && approvedBy !== event.actorIdentityId) ||
    (approvedAt !== null && event.createdAt !== approvedAt)) return undefined;

  const identityProjection = assertProjected(
    await context.projections.get<unknown>('directory_identities', identityId),
    directoryIdentitySchema,
    'onboarding approver identity',
  );
  if (!identityProjection) return undefined;
  const identity = identityProjection.body;
  const expectedRole = stage === 'manager' ? 'east_manager' : 'hr_director';
  if (!identity.active || identity.department !== 'hr' || identity.role !== expectedRole) return undefined;

  let responsibilityRow: ProjectedRow<ReturnType<typeof responsibilitySchema.parse>> | undefined;
  if (options.requireResponsibility !== false) {
    const responsibilities = await context.projections.query<unknown>({
      kind: 'unique',
      table: 'responsibilities',
      constraint: 'responsibilities_open_identity_purpose_unique',
      values: {
        identityId,
        purpose: stage === 'manager' ? 'manager_onboarding' : 'director_onboarding',
        orgUnitId: request.orgUnitId,
      },
    });
    if (responsibilities.length !== 1) return undefined;
    const parsedResponsibility = assertProjected(responsibilities[0], responsibilitySchema, 'onboarding approver responsibility');
    if (!parsedResponsibility) return undefined;
    if (!parsedResponsibility.body.active || parsedResponsibility.body.identityId !== identityId ||
      parsedResponsibility.body.orgUnitId !== request.orgUnitId ||
      parsedResponsibility.body.purpose !== (stage === 'manager' ? 'manager_onboarding' : 'director_onboarding') ||
      !parsedResponsibility.body.branchIds.includes(branchId)) return undefined;
    responsibilityRow = parsedResponsibility.row as ProjectedRow<ReturnType<typeof responsibilitySchema.parse>>;
  }

  const receiptProjection = assertProjected(
    await context.projections.get<unknown>('action_executions', event.executionId),
    workflowReceiptV2Schema,
    'onboarding approval execution',
  );
  if (!receiptProjection) return undefined;
  const receipt = receiptProjection.body;
  const expectedKind = stage === 'manager' ? 'onboarding_manager_approve' : 'onboarding_director_approve';
  if (receipt.id !== event.executionId || receipt.actorId !== identity.profileId || receipt.kind !== expectedKind ||
    receipt.outcome !== 'verified_success' || !receipt.proofs.some(proof =>
      proof.ref.table === 'onboarding_approval_events' && proof.ref.id === event.id &&
      proof.executionId === event.executionId && proof.outcome === 'verified_success')) return undefined;

  return {
    eventRow: projected.row,
    event,
    identityRow: identityProjection.row as ProjectedRow<DirectoryIdentity>,
    identity,
    ...(responsibilityRow ? { responsibilityRow } : {}),
    receiptRow: receiptProjection.row as ProjectedRow<WorkflowReceiptV2>,
  };
}

function approvalProofExpectedRows(proof: VerifiedApproval): ExpectedRow[] {
  return [
    expectedRow('onboarding_approval_events', proof.eventRow, null),
    expectedRow('directory_identities', proof.identityRow, 'active'),
    ...(proof.responsibilityRow ? [expectedRow('responsibilities', proof.responsibilityRow, 'active')] : []),
    expectedRow('action_executions', proof.receiptRow, workflowRowState('action_executions', proof.receiptRow.body)),
  ];
}

async function eligibleRequest(
  context: RuntimeReadContext,
  definition: QueueDefinition,
  grants: readonly WorkflowScopeGrant[],
  orgUnitId: string,
  row: ProjectedRow<unknown>,
): Promise<EligibleRequest | undefined> {
  const parsedRequest = assertProjected(row, onboardingRequestSchema, 'onboarding request');
  invariant(parsedRequest, 'WORKFLOW_AUTHORITY_INVALID', 'The onboarding request projection was unavailable', 409);
  const request = parsedRequest.body;
  invariant(request.orgUnitId === orgUnitId && request.state === definition.state,
    'WORKFLOW_AUTHORITY_INVALID', 'The onboarding queue projection was inconsistent', 409);
  const identityId = context.principal.directory.body.id;
  if (request[definition.assignmentField] !== identityId) return undefined;

  const employeeProjection = assertProjected(
    await context.projections.get<unknown>('employees', request.employeeId), employeeViewSchema, 'employee',
  );
  if (!employeeProjection || !employeeProjection.body.active || !employeeProjection.body.branchId) return undefined;
  const branchRow = exactBranchGrant(grants, context.principal, request.orgUnitId, employeeProjection.body.branchId);
  if (!branchRow) return undefined;

  const documents = await readyDocuments(context, request);
  if (!documents) return undefined;

  const expectedRows = [expectedRow('onboarding_requests', row, request.state),
    expectedRow('employees', employeeProjection.row, null),
    expectedRow('branches', branchRow, null),
    ...documents.rows.map(document => expectedRow('onboarding_documents', document, 'accepted'))];
  if (definition.purpose === 'director_queue') {
    const proof = await readVerifiedApproval(context, request, 'manager', employeeProjection.body.branchId);
    if (!proof) return undefined;
    expectedRows.push(...approvalProofExpectedRows(proof));
  }

  return {
    item: reviewItem(request, employeeProjection.body, documents.bodies),
    expectedRows,
  };
}

async function queryEligiblePage(
  context: RuntimeReadContext,
  definition: QueueDefinition,
  input: z.infer<typeof pageInputSchema>,
): Promise<EligibleRequest[]> {
  const scope = authorizeWorkflowScope(context.principal, {
    permission: definition.permission,
    roles: [definition.role],
    purpose: definition.responsibilityPurpose,
    targets: [],
  });
  const grants = scope.grants.filter(grant => grant.branchIds.some(branchId => {
    const branch = context.principal.branches.find(candidate => candidate.id === branchId);
    return branch !== undefined && branch.body.active !== false;
  }));
  const orgUnitIds = [...new Set(grants.map(grant => grant.orgUnitId))].sort();
  invariant(orgUnitIds.length <= MAX_ONBOARDING_QUEUE_SCOPE_UNITS,
    'WORKFLOW_QUEUE_LIMIT_EXCEEDED', 'The authorized onboarding scope exceeds the supported queue limit', 409);

  const eligible: EligibleRequest[] = [];
  let scannedRows = 0;
  for (const orgUnitId of orgUnitIds) {
    let cursor = input.cursor;
    let unitCount = 0;
    while (unitCount < input.limit + 1) {
      const remaining = MAX_ONBOARDING_QUEUE_SCAN_ROWS - scannedRows;
      const queryLimit = Math.min(STORAGE_QUERY_PAGE_SIZE, Math.max(1, remaining));
      const rows = await context.projections.query<unknown>({
        kind: 'scoped',
        table: 'onboarding_requests',
        orgUnitId,
        status: definition.state,
        ...(cursor ? { cursor } : {}),
        limit: queryLimit,
      });
      if (rows.length === 0) break;
      if (rows.length > remaining) {
        invariant(false, 'WORKFLOW_QUEUE_LIMIT_EXCEEDED', 'The onboarding queue scan exceeds the supported limit', 409);
      }
      scannedRows += rows.length;
      for (const row of rows) {
        const candidate = await eligibleRequest(context, definition, grants, orgUnitId, row);
        if (candidate) {
          eligible.push(candidate);
          unitCount += 1;
          if (unitCount >= input.limit + 1) break;
        }
      }
      cursor = rows[rows.length - 1].id;
      if (rows.length < queryLimit || unitCount >= input.limit + 1) break;
    }
  }

  eligible.sort((left, right) => left.item.request.id < right.item.request.id ? -1 : left.item.request.id > right.item.request.id ? 1 : 0);
  return eligible.slice(0, input.limit + 1);
}

interface ScopedRequestCandidate<T> {
  requestId: string;
  value: T;
}

async function queryScopedEligiblePage<T>(
  context: RuntimeReadContext,
  grants: readonly WorkflowScopeGrant[],
  states: readonly OnboardingRequest['state'][],
  input: z.infer<typeof pageInputSchema>,
  select: (orgUnitId: string, row: ProjectedRow<unknown>) => Promise<ScopedRequestCandidate<T> | undefined>,
): Promise<T[]> {
  const orgUnitIds = [...new Set(grants.map(grant => grant.orgUnitId))].sort();
  invariant(orgUnitIds.length <= MAX_ONBOARDING_QUEUE_SCOPE_UNITS,
    'WORKFLOW_QUEUE_LIMIT_EXCEEDED', 'The authorized onboarding scope exceeds the supported queue limit', 409);

  const eligible: ScopedRequestCandidate<T>[] = [];
  let scannedRows = 0;
  for (const orgUnitId of orgUnitIds) {
    for (const state of states) {
      let cursor = input.cursor;
      let eligibleForPartition = 0;
      while (eligibleForPartition < input.limit + 1) {
        const remaining = MAX_ONBOARDING_QUEUE_SCAN_ROWS - scannedRows;
        const queryLimit = Math.min(STORAGE_QUERY_PAGE_SIZE, Math.max(1, remaining));
        const rows = await context.projections.query<unknown>({
          kind: 'scoped',
          table: 'onboarding_requests',
          orgUnitId,
          status: state,
          ...(cursor ? { cursor } : {}),
          limit: queryLimit,
        });
        if (rows.length === 0) break;
        if (rows.length > remaining) {
          invariant(false, 'WORKFLOW_QUEUE_LIMIT_EXCEEDED', 'The onboarding read scan exceeds the supported limit', 409);
        }
        scannedRows += rows.length;
        for (const row of rows) {
          const projectedRequest = assertProjected(row, onboardingRequestSchema, 'onboarding request');
          invariant(projectedRequest && projectedRequest.body.orgUnitId === orgUnitId && projectedRequest.body.state === state,
            'WORKFLOW_AUTHORITY_INVALID', 'The onboarding read query returned an inconsistent request', 409);
          const candidate = await select(orgUnitId, row);
          if (candidate) {
            eligible.push(candidate);
            eligibleForPartition += 1;
            if (eligibleForPartition >= input.limit + 1) break;
          }
        }
        cursor = rows[rows.length - 1].id;
        if (rows.length < queryLimit || eligibleForPartition >= input.limit + 1) break;
      }
    }
  }

  eligible.sort((left, right) => left.requestId.localeCompare(right.requestId));
  return eligible.slice(0, input.limit + 1).map(candidate => candidate.value);
}

function authorizedOrgUnitScope(
  context: RuntimeReadContext,
  permission: string,
  role: 'east_manager' | 'hr_director' | 'hr_admin',
  purpose: 'manager_onboarding' | 'director_onboarding' | 'hr_operations',
): { grants: WorkflowScopeGrant[]; orgUnitIds: string[] } {
  const scope = authorizeWorkflowScope(context.principal, { permission, roles: [role], purpose, targets: [] });
  const grants = scope.grants.filter(grant => grant.branchIds.some(branchId => {
    const branch = context.principal.branches.find(candidate => candidate.id === branchId);
    return branch !== undefined && branch.body.active !== false &&
      (branch.body.orgUnitId === undefined || branch.body.orgUnitId === null || branch.body.orgUnitId === grant.orgUnitId);
  }));
  const orgUnitIds = [...new Set(grants.map(grant => grant.orgUnitId))].sort();
  invariant(orgUnitIds.length <= MAX_ONBOARDING_QUEUE_SCOPE_UNITS,
    'WORKFLOW_QUEUE_LIMIT_EXCEEDED', 'The authorized onboarding scope exceeds the supported queue limit', 409);
  return { grants, orgUnitIds };
}

const bangkokDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: demoWorkflowPolicyV1.timezone,
  calendar: 'iso8601',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function bangkokBusinessDate(date: Date): string {
  const parts = new Map(bangkokDateFormatter.formatToParts(date).map(part => [part.type, part.value]));
  const year = parts.get('year');
  const month = parts.get('month');
  const day = parts.get('day');
  invariant(year && month && day, 'WORKFLOW_UNAVAILABLE', 'The current business date is unavailable', 503);
  return `${year}-${month}-${day}`;
}

async function readDirectorApprovalsToday(
  runtime: Readonly<WorkflowActionRuntime>,
  sessionId: string,
  input: OnboardingQueuePageInput | undefined,
): Promise<OnboardingReadModelPage<OnboardingApprovalTodayItem>> {
  const parsedSessionId = identifierSchema.safeParse(sessionId);
  invariant(parsedSessionId.success, 'WORKFLOW_AUTHENTICATION_REQUIRED', 'A current workflow session is required', 401);
  const page = parseReadModelPageInput(input);
  return runtime.store.workflowTransaction(async tx => {
    const context = await runtime.context(tx, parsedSessionId.data);
    await runtime.assertPolicy(tx, getDemoWorkflowPolicyV1Pin());
    const identity = directoryIdentitySchema.parse(context.principal.directory.body);
    const { grants } = authorizedOrgUnitScope(context, 'hr.onboarding.director_read', 'hr_director', 'director_onboarding');
    const asOf = runtime.now();
    const today = bangkokBusinessDate(asOf);
    const historyStates: OnboardingRequest['state'][] = [
      'director_approved', 'onboarding_in_progress', 'completed', 'returned_for_revision', 'manager_review_pending', 'cancelled',
    ];
    const candidates = await queryScopedEligiblePage(context, grants, historyStates, page, async (orgUnitId, row) => {
      const projectedRequest = assertProjected(row, onboardingRequestSchema, 'onboarding request');
      invariant(projectedRequest, 'WORKFLOW_AUTHORITY_INVALID', 'The onboarding request projection was unavailable', 409);
      const request = projectedRequest.body;
      invariant(request.orgUnitId === orgUnitId, 'WORKFLOW_AUTHORITY_INVALID', 'The onboarding request organization unit was inconsistent', 409);
      if (request.directorIdentityId !== identity.id) return undefined;
      const employeeProjection = assertProjected(
        await context.projections.get<unknown>('employees', request.employeeId), employeeViewSchema, 'employee',
      );
      if (!employeeProjection || !employeeProjection.body.branchId) return undefined;
      const branchRow = exactBranchGrant(grants, context.principal, request.orgUnitId, employeeProjection.body.branchId);
      if (!branchRow) return undefined;
      const approval = await readVerifiedApproval(context, request, 'director', employeeProjection.body.branchId, {
        allowClearedPointer: true,
        requireResponsibility: false,
      });
      if (!approval || bangkokBusinessDate(new Date(Date.parse(approval.event.createdAt))) !== today) return undefined;
      return {
        requestId: request.id,
        value: {
          request: requestSummary(request),
          employee: {
            id: employeeProjection.body.id,
            name: employeeProjection.body.name,
            active: employeeProjection.body.active,
            branchId: employeeProjection.body.branchId,
          },
          approval: {
            eventId: approval.event.id,
            actorIdentityId: approval.event.actorIdentityId,
            actorName: approval.identity.displayName,
            approvedAt: approval.event.createdAt,
          },
        },
      };
    });
    const hasNext = candidates.length > page.limit;
    const items = candidates.slice(0, page.limit);
    return freezeWorkflowValue({
      asOf: asOf.toISOString(),
      items,
      nextCursor: hasNext ? items[items.length - 1]?.request.id ?? null : null,
    });
  });
}

async function readReadyForStart(
  runtime: Readonly<WorkflowActionRuntime>,
  sessionId: string,
  input: OnboardingQueuePageInput | undefined,
): Promise<OnboardingReadModelPage<OnboardingReadyForStartItem>> {
  const parsedSessionId = identifierSchema.safeParse(sessionId);
  invariant(parsedSessionId.success, 'WORKFLOW_AUTHENTICATION_REQUIRED', 'A current workflow session is required', 401);
  const page = parseReadModelPageInput(input);
  return runtime.store.workflowTransaction(async tx => {
    const context = await runtime.context(tx, parsedSessionId.data);
    await runtime.assertPolicy(tx, getDemoWorkflowPolicyV1Pin());
    invariant(context.actor.permissions.includes('hr.read'), 'WORKFLOW_PERMISSION_DENIED', 'A required onboarding read permission is absent', 403);
    const { grants } = authorizedOrgUnitScope(context, 'hr.onboarding.start', 'hr_admin', 'hr_operations');
    const asOf = runtime.now();
    const candidates = await queryScopedEligiblePage(context, grants, ['director_approved'], page, async (orgUnitId, row) => {
      const projectedRequest = assertProjected(row, onboardingRequestSchema, 'onboarding request');
      invariant(projectedRequest, 'WORKFLOW_AUTHORITY_INVALID', 'The onboarding request projection was unavailable', 409);
      const request = projectedRequest.body;
      invariant(request.orgUnitId === orgUnitId && request.state === 'director_approved',
        'WORKFLOW_AUTHORITY_INVALID', 'The ready-for-start request projection was inconsistent', 409);
      const employeeProjection = assertProjected(
        await context.projections.get<unknown>('employees', request.employeeId), employeeViewSchema, 'employee',
      );
      if (!employeeProjection || !employeeProjection.body.active || !employeeProjection.body.branchId) return undefined;
      const branchRow = exactBranchGrant(grants, context.principal, request.orgUnitId, employeeProjection.body.branchId);
      if (!branchRow) return undefined;
      const documents = await readyDocuments(context, request);
      if (!documents) return undefined;
      const [managerApproval, directorApproval] = await Promise.all([
        readVerifiedApproval(context, request, 'manager', employeeProjection.body.branchId),
        readVerifiedApproval(context, request, 'director', employeeProjection.body.branchId),
      ]);
      if (!managerApproval || !directorApproval) return undefined;
      const checklists = await context.projections.query<unknown>({
        kind: 'unique',
        table: 'onboarding_checklists',
        constraint: 'onboarding_checklists_request_template_unique',
        values: { requestId: request.id, templateId: 'hr_onboarding' },
      });
      invariant(checklists.length <= 1, 'WORKFLOW_AUTHORITY_INVALID', 'The onboarding checklist identity was ambiguous', 409);
      if (checklists.length > 0) return undefined;
      return {
        requestId: request.id,
        value: {
          ...reviewItem(request, employeeProjection.body, documents.bodies),
          approvals: {
            manager: {
              eventId: managerApproval.event.id,
              actorIdentityId: managerApproval.event.actorIdentityId,
              approvedAt: managerApproval.event.createdAt,
            },
            director: {
              eventId: directorApproval.event.id,
              actorIdentityId: directorApproval.event.actorIdentityId,
              approvedAt: directorApproval.event.createdAt,
            },
          },
        },
      };
    });
    const hasNext = candidates.length > page.limit;
    const items = candidates.slice(0, page.limit);
    return freezeWorkflowValue({
      asOf: asOf.toISOString(),
      items,
      nextCursor: hasNext ? items[items.length - 1]?.request.id ?? null : null,
    });
  });
}

function snapshotTarget(runtime: Readonly<WorkflowActionRuntime>, snapshotId: string, expected: ExpectedRow): ReviewSnapshotTargetV2 {
  return {
    id: runtime.makeId('snapshot-target'),
    snapshotId,
    entityType: expected.ref.table,
    targetId: expected.ref.id,
    ref: expected.ref,
    expectedRowVersion: expected.rowVersion,
    expectedState: expected.state,
  };
}

async function readQueue(
  runtime: Readonly<WorkflowActionRuntime>,
  kind: 'manager' | 'director',
  sessionId: string,
  input: OnboardingQueuePageInput | undefined,
): Promise<OnboardingQueuePage> {
  const definition = queueDefinitions[kind];
  const principalSessionId = identifierSchema.safeParse(sessionId);
  invariant(principalSessionId.success, 'WORKFLOW_AUTHENTICATION_REQUIRED', 'A current workflow session is required', 401);
  const page = parsePageInput(input, kind);

  return runtime.store.workflowTransaction(async tx => {
    const context = await runtime.context(tx, principalSessionId.data);
    const policy = getDemoWorkflowPolicyV1Pin();
    await runtime.assertPolicy(tx, policy);
    const candidates = await queryEligiblePage(context, definition, page);
    const hasNext = candidates.length > page.limit;
    const displayed = candidates.slice(0, page.limit);
    const expectedRows = mergeExpectedRows(...displayed.map(candidate => candidate.expectedRows));
    const created = runtime.now();
    const snapshotBody: ReviewSnapshot = {
      id: runtime.makeId('review-snapshot'),
      actorId: context.actor.id,
      actorSessionId: context.actor.sessionId,
      purpose: definition.purpose,
      orgUnitIds: [...new Set(displayed.map(candidate => candidate.item.request.orgUnitId))].sort(),
      displayedIds: displayed.map(candidate => candidate.item.request.id),
      count: displayed.length,
      expectedRows,
      policy,
      createdAt: created.toISOString(),
      expiresAt: pendingActionExpiresAt(created),
      digest: '0'.repeat(64),
    };
    const parsedSnapshot = reviewSnapshotSchema.safeParse({ ...snapshotBody, digest: workflowSnapshotDigest(snapshotBody) });
    invariant(parsedSnapshot.success, 'WORKFLOW_QUEUE_LIMIT_EXCEEDED', 'The exact onboarding review page exceeds supported snapshot capacity', 409);
    const snapshot = parsedSnapshot.data;
    const inserted = await tx.insertUnique('review_snapshots', snapshot, {
      constraint: 'review_snapshots_primary_key', values: { id: snapshot.id },
    });
    invariant(inserted.inserted, 'WORKFLOW_CONFLICT', 'The onboarding review snapshot could not be persisted', 409);

    const snapshotTargets = expectedRows.map(expected => snapshotTarget(runtime, snapshot.id, expected));
    for (const target of snapshotTargets) {
      const targetInsert = await tx.insertUnique('review_snapshot_targets', target, {
        constraint: 'review_snapshot_targets_snapshot_target_unique',
        values: { snapshotId: snapshot.id, entityType: target.entityType, targetId: target.targetId },
      });
      invariant(targetInsert.inserted, 'WORKFLOW_CONFLICT', 'The onboarding snapshot target could not be persisted', 409);
    }

    return freezeWorkflowValue({
      snapshot,
      items: displayed.map(candidate => candidate.item),
      snapshotTargets,
      nextCursor: hasNext ? displayed[displayed.length - 1]?.item.request.id ?? null : null,
    });
  });
}

export function createOnboardingQueryService(runtime: Readonly<WorkflowActionRuntime>) {
  return Object.freeze({
    managerQueue: (sessionId: string, input?: OnboardingQueuePageInput) => readQueue(runtime, 'manager', sessionId, input),
    directorQueue: (sessionId: string, input?: OnboardingQueuePageInput) => readQueue(runtime, 'director', sessionId, input),
    directorApprovalsToday: (sessionId: string, input?: OnboardingQueuePageInput) => readDirectorApprovalsToday(runtime, sessionId, input),
    readyForStart: (sessionId: string, input?: OnboardingQueuePageInput) => readReadyForStart(runtime, sessionId, input),
  });
}
