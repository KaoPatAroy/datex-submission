import { z } from 'zod';
import { DomainError, invariant } from './errors';
import { digest } from './utils';
import { authorizeWorkflowScope, type WorkflowScopeRequest } from '../workflows/authority';
import { getWorkflowActionAuthority } from '../workflows/action-authority';
import { mergeExpectedRows, workflowSemanticRoot, workflowSnapshotDigest, type RuntimeReadContext, type WorkflowActionRuntime } from '../workflows/action-runtime';
import type { WorkflowTransactionContext } from '../storage/workflow-projections';
import { getDemoWorkflowPolicyV1Pin } from '../workflows/policy';
import {
  allowedCapabilitySchema, directoryIdentitySchema, MAX_WORKFLOW_TARGETS, reviewSnapshotSchema, workflowActionKinds,
  workflowActionPayloadSchema, workflowValidationSchema, pendingActionV2Schema, onboardingRequestSchema, isoDateSchema,
  type AllowedCapability, type Ref, type ReviewSnapshot, type WorkflowActionKind, type WorkflowPayloadV2, type WorkflowValidation,
} from '../workflows/contracts';

export interface WorkflowBindingAvailability {
  readonly kind: WorkflowActionKind;
  readonly available: boolean;
  readonly reason: string | null;
  readonly code?: 'WORKFLOW_SCHEMA_UNAVAILABLE' | 'WORKFLOW_CONFIGURATION_UNAVAILABLE';
}
/** Counts describe this explicit selection, never an invented organization-wide population. */
export interface WorkflowCapabilitySelection {
  readonly candidatePayloads?: readonly WorkflowPayloadV2[];
  readonly queueSnapshots?: readonly ReviewSnapshot[];
}
export interface WorkflowSuggestionContext {
  readonly phase: 'empty_chat' | 'follow_up';
  readonly conversationId?: string;
  readonly dashboardId?: string;
  readonly branchIds?: readonly string[];
  readonly employeeId?: string;
  readonly snapshotId?: string;
  readonly requestId?: string;
  readonly pendingActionId?: string;
  readonly completedActionIds?: readonly string[];
}
/** Public wire boundary: only an opaque ID and user-facing prompt text may be serialized. */
export interface WorkflowSuggestedPrompt {
  readonly id: string;
  readonly prompt: string;
}
interface WorkflowSuggestionPlan extends WorkflowSuggestedPrompt {
  readonly kind: 'read' | 'prepare';
  readonly capabilityId: string;
  readonly targetRefs: readonly Ref[];
  readonly snapshotRef: AllowedCapability['snapshotRef'];
}

const actionPresentation: Readonly<Record<WorkflowActionKind, Pick<AllowedCapability, 'title' | 'department' | 'risk' | 'simulatedConnector'>>> = {
  dashboard_create: { title: 'Create dashboard', department: 'sales', risk: 'creates_record', simulatedConnector: false },
  dashboard_share: { title: 'Share dashboard', department: 'sales', risk: 'creates_record', simulatedConnector: true },
  dashboard_share_revoke: { title: 'Revoke dashboard share', department: 'sales', risk: 'high_impact', simulatedConnector: false },
  investigation_create: { title: 'Create investigation tasks', department: 'operations', risk: 'creates_record', simulatedConnector: false },
  restock_create: { title: 'Request restock', department: 'operations', risk: 'creates_record', simulatedConnector: false },
  crm_followup_create: { title: 'Create CRM follow-up', department: 'sales', risk: 'creates_record', simulatedConnector: false },
  incident_escalate: { title: 'Escalate incident', department: 'operations', risk: 'creates_record', simulatedConnector: false },
  discount_request_create: { title: 'Request discount approval', department: 'sales', risk: 'creates_record', simulatedConnector: false },
  branch_review_assign: { title: 'Assign branch review', department: 'operations', risk: 'creates_record', simulatedConnector: false },
  onboarding_manager_approve: { title: 'Approve manager onboarding review', department: 'hr', risk: 'high_impact', simulatedConnector: false },
  onboarding_director_approve: { title: 'Approve Director onboarding review', department: 'hr', risk: 'high_impact', simulatedConnector: false },
  onboarding_return: { title: 'Return onboarding for revision', department: 'hr', risk: 'high_impact', simulatedConnector: false },
  onboarding_start: { title: 'Start approved onboarding', department: 'hr', risk: 'creates_record', simulatedConnector: false },
  onboarding_tasks_create: { title: 'Create onboarding tasks', department: 'hr', risk: 'creates_record', simulatedConnector: false },
  offboarding_plan_create: { title: 'Prepare offboarding plan', department: 'hr', risk: 'creates_record', simulatedConnector: false },
  it_disable_request: { title: 'Request simulated IT disable', department: 'hr', risk: 'high_impact', simulatedConnector: true },
  asset_return_create: { title: 'Create asset return tasks', department: 'hr', risk: 'creates_record', simulatedConnector: false },
  badge_revoke: { title: 'Revoke mock badge', department: 'hr', risk: 'high_impact', simulatedConnector: true },
  contract_reminder_create: { title: 'Create contract reminders', department: 'hr', risk: 'creates_record', simulatedConnector: false },
  policy_acknowledgement_assign: { title: 'Assign policy acknowledgement', department: 'hr', risk: 'creates_record', simulatedConnector: false },
};

function authorized(context: RuntimeReadContext, kind: WorkflowActionKind): boolean {
  const authority = getWorkflowActionAuthority(kind);
  if (!authority.readPermissions.every(permission => context.actor.permissions.includes(permission))) return false;
  try { authorizeWorkflowScope(context.principal, { permission: authority.permission, roles: authority.roles, purpose: authority.purpose, targets: [] }); return true; }
  catch (error) { if (error instanceof DomainError && error.status === 403) return false; throw error; }
}

async function checkedSnapshot(runtime: WorkflowActionRuntime, context: RuntimeReadContext, tx: WorkflowTransactionContext, input: ReviewSnapshot): Promise<ReviewSnapshot> {
  const snapshot = reviewSnapshotSchema.parse(input);
  const stored = await context.projections.get('review_snapshots', snapshot.id);
  invariant(stored && digest(stored.body) === digest(snapshot) && snapshot.actorId === context.actor.id &&
    snapshot.actorSessionId === context.actor.sessionId && Date.parse(snapshot.expiresAt) > runtime.now().getTime() &&
    snapshot.digest === workflowSnapshotDigest(snapshot) && digest(snapshot.policy) === digest(getDemoWorkflowPolicyV1Pin()),
  'WORKFLOW_STALE', 'The reviewed queue snapshot is unavailable', 409);
  await runtime.assertExpectedRows(tx, snapshot.expectedRows);
  return snapshot;
}

const identifier = directoryIdentitySchema.shape.id;
const reviewedSnapshotRefSchema = allowedCapabilitySchema.shape.snapshotRef.unwrap();
const reviewedRequestSchema = onboardingRequestSchema.pick({ id: true, employeeId: true, orgUnitId: true, startDate: true,
  state: true, rowVersion: true, lifecycleId: true, createdAt: true, updatedAt: true });
const reviewedEmployeeSchema = z.object({ id: identifier, name: z.string().min(1).max(160), active: z.boolean(), branchId: identifier }).strict();
const reviewedDocumentSchema = z.object({ id: identifier, documentType: z.string().min(1).max(100), status: z.literal('accepted') }).strict();
const reviewedQueueItemSchema = z.object({ request: reviewedRequestSchema, employee: reviewedEmployeeSchema,
  documents: z.array(reviewedDocumentSchema).max(MAX_WORKFLOW_TARGETS) }).strict();
export const directorStartDatesInputSchema = z.object({ snapshotId: identifier }).strict();
export const directorStartDatesResultSchema = z.object({ snapshotRef: reviewedSnapshotRefSchema,
  items: z.array(z.object({ requestId: identifier, employeeId: identifier, employeeName: z.string().min(1).max(160),
    orgUnitId: identifier, branchId: identifier, startDate: isoDateSchema }).strict()).min(1).max(MAX_WORKFLOW_TARGETS) }).strict();
export const directorRequestDocumentsInputSchema = z.object({ snapshotId: identifier, requestId: identifier }).strict();
export const directorRequestDocumentsResultSchema = z.object({ snapshotRef: reviewedSnapshotRefSchema, item: reviewedQueueItemSchema }).strict();

/** Project only the unchanged source rows frozen by the existing authorized Director queue service. */
async function readReviewedDirectorQueue(runtime: WorkflowActionRuntime, context: RuntimeReadContext, tx: WorkflowTransactionContext, snapshotId: string, selectedRequestId?: string) {
  const stored = await context.projections.get('review_snapshots', identifier.parse(snapshotId));
  const snapshot = await checkedSnapshot(runtime, context, tx, reviewSnapshotSchema.parse(stored?.body));
  invariant(snapshot.purpose === 'director_queue' && snapshot.displayedIds.length > 0, 'WORKFLOW_NOT_FOUND', 'The reviewed Director queue is unavailable', 404);
  invariant(selectedRequestId === undefined || snapshot.displayedIds.includes(selectedRequestId),
    'WORKFLOW_NOT_FOUND', 'The selected reviewed request is unavailable', 404);
  authorizeWorkflowScope(context.principal, { permission: 'hr.onboarding.director_read', roles: ['hr_director'], purpose: 'director_onboarding',
    targets: snapshot.orgUnitIds.map(orgUnitId => ({ orgUnitId })) });
  const items: z.infer<typeof reviewedQueueItemSchema>[] = [];
  for (const requestId of selectedRequestId ? [selectedRequestId] : snapshot.displayedIds) {
    const row = await context.projections.get('onboarding_requests', requestId), request = onboardingRequestSchema.parse(row?.body);
    invariant(row && snapshot.expectedRows.some(expected => expected.ref.table === 'onboarding_requests' && expected.ref.id === request.id && expected.rowVersion === row.rowVersion) &&
      request.state === 'director_approval_pending' && request.directorIdentityId === context.principal.directory.id && snapshot.orgUnitIds.includes(request.orgUnitId),
    'WORKFLOW_STALE', 'The reviewed Director request changed', 409);
    const employeeRow = await context.projections.get('employees', request.employeeId);
    invariant(employeeRow && snapshot.expectedRows.some(expected => expected.ref.table === 'employees' && expected.ref.id === request.employeeId && expected.rowVersion === employeeRow.rowVersion),
      'WORKFLOW_STALE', 'The reviewed employee changed', 409);
    const employee = reviewedEmployeeSchema.strip().parse(employeeRow.body);
    invariant(employee.id === request.employeeId && employee.active, 'WORKFLOW_STALE', 'The reviewed employee changed', 409);
    authorizeWorkflowScope(context.principal, { permission: 'hr.onboarding.director_read', roles: ['hr_director'], purpose: 'director_onboarding',
      targets: [{ orgUnitId: request.orgUnitId, branchId: employee.branchId }] });
    const documents: z.infer<typeof reviewedDocumentSchema>[] = [];
    for (const expected of snapshot.expectedRows.filter(expected => expected.ref.table === 'onboarding_documents')) {
      const row = await context.projections.get<{ id: string; requestId: string; employeeId: string; documentType: string; status: string }>('onboarding_documents', expected.ref.id);
      invariant(row, 'WORKFLOW_STALE', 'A reviewed document changed', 409);
      if (row.body.requestId !== request.id) continue;
      invariant(row.body.employeeId === employee.id, 'WORKFLOW_STALE', 'A reviewed document changed', 409);
      documents.push(reviewedDocumentSchema.parse({ id: row.body.id, documentType: row.body.documentType, status: row.body.status }));
    }
    items.push(reviewedQueueItemSchema.parse({ request: reviewedRequestSchema.strip().parse(request), employee, documents }));
  }
  return { snapshot, items };
}

export async function readDirectorStartDates(runtime: WorkflowActionRuntime, sessionId: string, input: z.infer<typeof directorStartDatesInputSchema>) {
  const args = directorStartDatesInputSchema.parse(input);
  return runtime.store.workflowTransaction(async tx => {
    const context = await runtime.context(tx, sessionId); await runtime.assertPolicy(tx);
    const { snapshot, items } = await readReviewedDirectorQueue(runtime, context, tx, args.snapshotId);
    return directorStartDatesResultSchema.parse({ snapshotRef: { id: snapshot.id, digest: snapshot.digest, expiresAt: snapshot.expiresAt },
      items: items.map(({ request, employee }) => ({ requestId: request.id, employeeId: employee.id, employeeName: employee.name,
        orgUnitId: request.orgUnitId, branchId: employee.branchId, startDate: request.startDate })).sort((a, b) => a.startDate.localeCompare(b.startDate) || a.requestId.localeCompare(b.requestId)) });
  });
}

export async function readDirectorRequestDocuments(runtime: WorkflowActionRuntime, sessionId: string, input: z.infer<typeof directorRequestDocumentsInputSchema>) {
  const args = directorRequestDocumentsInputSchema.parse(input);
  return runtime.store.workflowTransaction(async tx => {
    const context = await runtime.context(tx, sessionId); await runtime.assertPolicy(tx);
    const { snapshot, items } = await readReviewedDirectorQueue(runtime, context, tx, args.snapshotId, args.requestId);
    const item = items.find(item => item.request.id === args.requestId);
    invariant(item, 'WORKFLOW_NOT_FOUND', 'The selected reviewed request is unavailable', 404);
    return directorRequestDocumentsResultSchema.parse({ snapshotRef: { id: snapshot.id, digest: snapshot.digest, expiresAt: snapshot.expiresAt }, item });
  });
}

export function workflowActionPresentation(kind: WorkflowActionKind) { return actionPresentation[kind]; }

/** Internal reservation metadata only: no other actor's envelope or identity leaves this function. */
async function claimedSemanticKeys(context: RuntimeReadContext): Promise<ReadonlySet<string>> {
  const keys = new Set<string>(), seen = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const rows = await context.projections.query<unknown>({ kind: 'scoped', table: 'pending_actions', status: 'claimed', cursor, limit: 100 });
    invariant(rows.length <= 100 && rows.every(row => !seen.has(row.id)),
      'WORKFLOW_METADATA_UNAVAILABLE', 'Current operation eligibility could not be established', 503);
    for (const row of rows) {
      seen.add(row.id);
      if (row.body === null || typeof row.body !== 'object' || !('contractVersion' in row.body) || row.body.contractVersion !== 2) continue;
      const action = pendingActionV2Schema.safeParse(row.body);
      invariant(action.success && action.data.id === row.id && action.data.status === 'claimed',
        'WORKFLOW_METADATA_UNAVAILABLE', 'Current operation eligibility could not be established', 503);
      for (const target of action.data.targets) keys.add(target.semanticKey);
    }
    if (rows.length < 100) return keys;
    // A full final page cannot establish completeness within the hard metadata budget.
    invariant(seen.size < 1_000, 'WORKFLOW_METADATA_UNAVAILABLE', 'Current operation eligibility exceeds the supported metadata bound', 503);
    cursor = rows[rows.length - 1].id;
  }
}

/** Context narrows an already authorized, guarded candidate; it never invents or partially changes a target batch. */
async function matchesSuggestionContext(context: RuntimeReadContext, payload: WorkflowPayloadV2, validation: WorkflowValidation,
  selected: WorkflowSuggestionContext): Promise<boolean> {
  const guards = mergeExpectedRows(validation.expectedRows, ...validation.targets.map(target => target.expectedRows));
  if (payload.kind === 'dashboard_share') {
    if (!selected.dashboardId || payload.dashboardId !== selected.dashboardId) return false;
  }
  if (payload.kind === 'dashboard_share_revoke') {
    if (!selected.dashboardId || !guards.some(row => row.ref.table === 'dashboard_shares' && row.ref.id === payload.shareId)) return false;
    const grant = await context.projections.get<{ dashboardId: string }>('dashboard_shares', payload.shareId);
    if (grant?.body.dashboardId !== selected.dashboardId) return false;
  }
  if (selected.employeeId) {
    const employees = guards.filter(row => row.ref.table === 'employees');
    if (!employees.length || !employees.every(row => row.ref.id === selected.employeeId)) return false;
  }
  if (selected.requestId) {
    const requests = validation.targets.filter(target => target.ref.table === 'onboarding_requests');
    if (!requests.length || !requests.every(target => target.ref.id === selected.requestId)) return false;
  }
  if (selected.branchIds !== undefined) {
    const branches = new Set([...validation.approvedBranchIds, ...guards.filter(row => row.ref.table === 'branches').map(row => row.ref.id)]);
    if (!branches.size || ![...branches].every(id => selected.branchIds?.includes(id))) return false;
  }
  if ('snapshotId' in payload && (!selected.snapshotId || payload.snapshotId !== selected.snapshotId || validation.reviewedSnapshotId !== selected.snapshotId)) return false;
  return true;
}

/** Uses department validation and semantic reservations; no effect callback or queue creation is invoked. */
async function projectCapabilitiesInTransaction(
  runtime: WorkflowActionRuntime,
  sessionId: string,
  availability: readonly WorkflowBindingAvailability[],
  selection: WorkflowCapabilitySelection,
  tx: WorkflowTransactionContext,
  suggestionContext?: WorkflowSuggestionContext,
): Promise<AllowedCapability[]> {
  const candidates = z.array(workflowActionPayloadSchema).max(MAX_WORKFLOW_TARGETS).parse(selection.candidatePayloads ?? []);
  const snapshotInputs = z.array(reviewSnapshotSchema).max(2).parse(selection.queueSnapshots ?? []);
    const context = await runtime.context(tx, sessionId);
    await runtime.assertPolicy(tx);
    const capabilities: AllowedCapability[] = [], snapshots = new Map<string, ReviewSnapshot>();
    for (const input of snapshotInputs) {
      const snapshot = await checkedSnapshot(runtime, context, tx, input);
      invariant(![...snapshots.values()].some(row => row.purpose === snapshot.purpose),
        'WORKFLOW_INVALID_INPUT', 'Only one exact snapshot per queue may be selected');
      snapshots.set(snapshot.id, snapshot);
      const manager = snapshot.purpose === 'manager_queue';
      const request = { permission: manager ? 'hr.onboarding.manager_read' : 'hr.onboarding.director_read',
        roles: manager ? ['east_manager'] as const : ['hr_director'] as const,
        purpose: manager ? 'manager_onboarding' as const : 'director_onboarding' as const,
        targets: snapshot.orgUnitIds.map(orgUnitId => ({ orgUnitId })) };
      authorizeWorkflowScope(context.principal, request);
      capabilities.push(allowedCapabilitySchema.parse({ id: snapshot.purpose, kind: snapshot.purpose,
        title: manager ? 'Manager onboarding review queue' : 'Director onboarding approval queue', department: 'hr', behavior: 'read', risk: 'read_only',
        permitted: true, eligibleCount: snapshot.count, available: snapshot.count > 0,
        disabledReason: snapshot.count ? null : { code: 'NO_ELIGIBLE_TARGETS', message: 'No eligible requests are in this reviewed queue.' },
        requiresConfirmation: false, simulatedConnector: false,
        snapshotRef: { id: snapshot.id, digest: snapshot.digest, expiresAt: snapshot.expiresAt },
        targetRefs: snapshot.displayedIds.map(id => ({ table: 'onboarding_requests', id })), promptTemplate: null }));
      if (snapshot.displayedIds.length) candidates.push(manager
        ? { kind: 'onboarding_manager_approve', snapshotId: snapshot.id, requestIds: [...snapshot.displayedIds] }
        : { kind: 'onboarding_director_approve', snapshotId: snapshot.id, requestIds: [...snapshot.displayedIds] });
    }
    const claimed = candidates.length ? await claimedSemanticKeys(context) : new Set<string>();
    for (const kind of workflowActionKinds) {
      // Omit denied actions altogether; a role label or registry entry grants no capability.
      if (!authorized(context, kind)) continue;
      const registered = runtime.availableKinds().includes(kind), readiness = availability.find(item => item.kind === kind);
      let disabledReason: AllowedCapability['disabledReason'] = null;
      const refs = new Map<string, Ref>(), selected = candidates.filter(payload => payload.kind === kind);
      let snapshotRef: AllowedCapability['snapshotRef'] = null;
      if (!registered || readiness?.available !== true) disabledReason = {
        code: readiness?.code ?? 'WORKFLOW_SCHEMA_UNAVAILABLE', message: (readiness?.reason ?? 'The trusted action binding is unavailable.').slice(0, 500) };
      else if (!selected.length) disabledReason = { code: 'SELECTION_REQUIRED', message: 'Choose exact current targets to determine eligibility.' };
      else {
        for (const payload of selected) {
          try {
            const binding = runtime.binding(kind), intent = await runtime.identify(context, binding, payload);
            if (intent.targets.some(target => claimed.has(target.semanticKey))) continue;
            if (await runtime.existing(context, intent, kind)) continue;
            const roots = await context.projections.query<{ activeExecutionId: string | null }>({ kind: 'unique', table: 'action_idempotency_roots',
              constraint: 'action_idempotency_roots_key_unique', values: { idempotencyKey: workflowSemanticRoot(kind, intent.targets) } });
            if (roots[0]?.body.activeExecutionId) {
              const execution = await context.projections.get<{ outcome: string }>('action_executions', roots[0].body.activeExecutionId);
              if (!execution || !['failed', 'stale', 'denied'].includes(execution.body.outcome)) continue;
            }
            const validation = workflowValidationSchema.parse(await binding.validate(context, payload));
            invariant(digest(validation.targets.map(target => [target.targetId, target.ref, target.semanticKey]).sort((a, b) => digest(a).localeCompare(digest(b)))) ===
              digest(intent.targets.map(target => [target.targetId, target.ref, target.semanticKey]).sort((a, b) => digest(a).localeCompare(digest(b)))),
            'WORKFLOW_CALLBACK_CONTRACT', 'Capability validation changed the identified targets');
            await runtime.assertPolicy(tx, validation.policy);
            authorizeWorkflowScope(context.principal, { ...binding.authority,
              targets: [...validation.approvedOrgUnitIds.map(orgUnitId => ({ orgUnitId })), ...validation.approvedBranchIds.map(branchId => ({ branchId }))] });
            await runtime.assertExpectedRows(tx, mergeExpectedRows(validation.expectedRows, ...validation.targets.map(target => target.expectedRows)));
            await runtime.assertSnapshot(context, { payload, ...validation });
            if (suggestionContext && !await matchesSuggestionContext(context, payload, validation, suggestionContext)) continue;
            if (validation.reviewedSnapshotId !== null) {
              const row = snapshots.get(validation.reviewedSnapshotId) ?? reviewSnapshotSchema.parse((await context.projections.get('review_snapshots', validation.reviewedSnapshotId))?.body);
              invariant(snapshotRef === null || snapshotRef.id === row.id, 'WORKFLOW_INVALID_INPUT', 'An approval capability must refer to one exact reviewed snapshot');
              snapshotRef = { id: row.id, digest: row.digest, expiresAt: row.expiresAt };
            }
            // Already-revoked badges are deliberately excluded from action hints.
            if (kind === 'badge_revoke' && validation.targets.some(target => target.expectedRows.some(row => row.ref.table === 'mock_badges' && row.state === 'revoked'))) continue;
            for (const target of validation.targets) refs.set(digest(target.ref), target.ref);
          } catch (error) {
            if (!(error instanceof DomainError) && !(error instanceof z.ZodError)) throw error;
            disabledReason = { code: error instanceof DomainError ? error.code : 'WORKFLOW_INVALID_INPUT',
              message: 'The selected targets are unavailable, stale, or ineligible. Refresh the selection.' };
          }
        }
      }
      invariant(refs.size <= MAX_WORKFLOW_TARGETS, 'WORKFLOW_INVALID_INPUT', 'The capability selection exceeds the supported target count');
      capabilities.push(allowedCapabilitySchema.parse({ id: kind, kind, ...actionPresentation[kind], behavior: 'prepare', permitted: true,
        eligibleCount: refs.size, available: refs.size > 0, disabledReason: refs.size ? null : disabledReason ?? {
          code: 'NO_ELIGIBLE_TARGETS', message: 'The selection has no eligible targets without an existing effect or active operation.' },
        requiresConfirmation: true, snapshotRef: refs.size ? snapshotRef : null, targetRefs: [...refs.values()], promptTemplate: null }));
    }
    return capabilities;
}

export async function projectWorkflowCapabilities(runtime: WorkflowActionRuntime, sessionId: string,
  availability: readonly WorkflowBindingAvailability[], selection: WorkflowCapabilitySelection = {}): Promise<AllowedCapability[]> {
  return runtime.store.workflowTransaction(tx => projectCapabilitiesInTransaction(runtime, sessionId, availability, selection, tx));
}

const suggestedActions: Readonly<Record<WorkflowActionKind, string>> = {
  dashboard_create: 'สร้าง Dashboard จากข้อมูลที่ฉันกำลังดู',
  dashboard_share: 'เตรียมแชร์ Dashboard นี้ให้ผู้รับที่เลือก',
  dashboard_share_revoke: 'เตรียมยกเลิกการแชร์ Dashboard ที่เลือก',
  investigation_create: 'เตรียมงานตรวจสอบประเด็นของสาขาที่เลือก',
  restock_create: 'เตรียมคำขอเติมสต็อกสำหรับรายการที่เลือก',
  crm_followup_create: 'เตรียมงานติดตามลูกค้าสำหรับโอกาสการขายที่เลือก',
  incident_escalate: 'เตรียมส่งต่อเหตุการณ์ที่เลือกให้ทีมปฏิบัติการ',
  discount_request_create: 'เตรียมคำขออนุมัติส่วนลดสำหรับรายการที่เลือก',
  branch_review_assign: 'เตรียมมอบหมายงานทบทวนสาขาที่เลือก',
  onboarding_manager_approve: 'เตรียมอนุมัติรายการรับพนักงานที่ฉันเพิ่งตรวจในฐานะผู้จัดการ',
  onboarding_director_approve: 'อนุมัติทุกรายการที่ฉันเพิ่งตรวจ',
  onboarding_return: 'เตรียมส่งรายการรับพนักงานที่เลือกกลับไปแก้ไข',
  onboarding_start: 'เตรียมเริ่มกระบวนการรับพนักงานสำหรับรายการที่อนุมัติแล้ว',
  onboarding_tasks_create: 'เตรียมงานรับพนักงานสำหรับรายการที่เลือก',
  offboarding_plan_create: 'เตรียมแผนพนักงานออกสำหรับกรณีที่เลือก',
  it_disable_request: 'เตรียมคำขอจำลองระงับบัญชีไอทีสำหรับกรณีที่เลือก',
  asset_return_create: 'เตรียมงานคืนทรัพย์สินสำหรับรายการที่เลือก',
  badge_revoke: 'เตรียมยกเลิกบัตรพนักงานจำลองที่เลือก',
  contract_reminder_create: 'เตรียมงานเตือนสัญญาที่ใกล้ครบกำหนด',
  policy_acknowledgement_assign: 'เตรียมงานรับทราบนโยบายสำหรับพนักงานที่เลือก',
};
const suggestionContextSchema = z.object({
  phase: z.enum(['empty_chat', 'follow_up']), conversationId: directoryIdentitySchema.shape.id.optional(),
  dashboardId: directoryIdentitySchema.shape.id.optional(), branchIds: z.array(directoryIdentitySchema.shape.id).max(MAX_WORKFLOW_TARGETS).optional(),
  employeeId: directoryIdentitySchema.shape.id.optional(), snapshotId: directoryIdentitySchema.shape.id.optional(),
  requestId: directoryIdentitySchema.shape.id.optional(),
  pendingActionId: directoryIdentitySchema.shape.id.optional(), completedActionIds: z.array(directoryIdentitySchema.shape.id).max(MAX_WORKFLOW_TARGETS).optional(),
}).strict();

export async function projectWorkflowSuggestions(
  runtime: WorkflowActionRuntime, sessionId: string, availability: readonly WorkflowBindingAvailability[],
  input: WorkflowSuggestionContext, selection: WorkflowCapabilitySelection = {},
): Promise<WorkflowSuggestedPrompt[]> {
  const request = suggestionContextSchema.parse(input);
  invariant(request.phase !== 'follow_up' || request.conversationId, 'WORKFLOW_INVALID_INPUT', 'Follow-up suggestions need a selected conversation');
  return runtime.store.workflowTransaction(async tx => {
    const context = await runtime.context(tx, sessionId); await runtime.assertPolicy(tx);
    if (request.conversationId) await runtime.assertConversation(context, request.conversationId);
    const grantedBranches = new Set(context.principal.responsibilities.filter(row => row.body.active).flatMap(row => row.body.branchIds));
    let branchIds = request.branchIds ?? context.principal.branches.filter(row => grantedBranches.has(row.id) && row.body.active !== false).map(row => row.id);
    invariant(new Set(branchIds).size === branchIds.length && branchIds.every(id => grantedBranches.has(id)),
      'WORKFLOW_PERMISSION_DENIED', 'A selected branch is outside the current responsibility', 403);
    if (request.dashboardId) {
      const dashboard = await context.projections.get<{ ownerId: string; spec: { scope: { branchIds?: string[] } } }>('dashboards', request.dashboardId);
      invariant(dashboard?.body.ownerId === context.actor.id && dashboard.body.spec.scope.branchIds?.every(id => grantedBranches.has(id)),
        'WORKFLOW_PERMISSION_DENIED', 'The selected dashboard is unavailable in the current scope', 403);
      const dashboardBranches = z.array(identifier).min(1).max(MAX_WORKFLOW_TARGETS).parse(dashboard.body.spec.scope.branchIds);
      invariant(new Set(dashboardBranches).size === dashboardBranches.length &&
        (request.branchIds === undefined || request.branchIds.every(id => dashboardBranches.includes(id))),
      'WORKFLOW_PERMISSION_DENIED', 'The selected branches do not match the selected dashboard', 403);
      if (request.branchIds === undefined) branchIds = dashboardBranches;
    }
    let contextSnapshot: ReviewSnapshot | undefined;
    if (request.snapshotId) {
      const snapshot = await context.projections.get('review_snapshots', request.snapshotId);
      contextSnapshot = await checkedSnapshot(runtime, context, tx, reviewSnapshotSchema.parse(snapshot?.body));
    }
    const targetContext: WorkflowSuggestionContext = { ...request,
      ...(request.dashboardId && request.branchIds === undefined ? { branchIds } : {}) };
    const capabilities = await projectCapabilitiesInTransaction(runtime, sessionId, availability, selection, tx, targetContext);
    const excluded = new Set<string>();
    for (const id of [...(request.completedActionIds ?? []), ...(request.pendingActionId ? [request.pendingActionId] : [])]) {
      const action = pendingActionV2Schema.parse((await context.projections.get('pending_actions', id))?.body);
      invariant(action.actorId === context.actor.id && action.sessionId === context.actor.sessionId &&
        (!request.conversationId || action.conversationId === request.conversationId), 'WORKFLOW_NOT_FOUND', 'A contextual workflow is unavailable', 404);
      excluded.add(action.payload.kind);
    }
    if (request.conversationId) {
      const rows = await context.projections.query<unknown>({ kind: 'scoped', table: 'pending_actions', ownerId: context.actor.id,
        equals: { conversationId: request.conversationId }, limit: MAX_WORKFLOW_TARGETS });
      // A full page could hide additional completed/pending work. Suppress effect hints rather than infer completeness.
      if (rows.length === MAX_WORKFLOW_TARGETS) for (const kind of workflowActionKinds) excluded.add(kind);
      for (const row of rows) {
        const parsed = pendingActionV2Schema.safeParse(row.body);
        if (parsed.success && ['pending', 'claimed', 'completed'].includes(parsed.data.status)) excluded.add(parsed.data.payload.kind);
      }
    }
    const suggestions: WorkflowSuggestionPlan[] = [];
    const add = (capabilityId: string, prompt: string, refs: readonly Ref[], kind: 'read' | 'prepare' = 'read', snapshotRef: AllowedCapability['snapshotRef'] = null) => {
      if (refs.length && suggestions.length < 6 && !suggestions.some(item => item.prompt === prompt)) suggestions.push(Object.freeze({ id: `suggestion_${digest({ phase: request.phase, capabilityId, prompt, refs, snapshotRef })}`,
        kind, capabilityId, prompt, targetRefs: refs, snapshotRef }));
    };
    // Shared evidence is a real existing read surface; inspect the current scoped projection before offering these questions.
    if (branchIds.length && ['executive', 'east_manager'].includes(context.actor.role) &&
      ['sales.read', 'operations.read'].every(permission => context.actor.permissions.includes(permission))) {
      authorizeWorkflowScope(context.principal, { permission: 'sales.read', roles: ['executive', 'east_manager'], purpose: 'sales_operations', targets: branchIds.map(branchId => ({ branchId })) });
      const evidence = await context.evidence({ region: 'all', date: context.businessDate, branchIds: [...branchIds] });
      invariant(evidence.branches.every(branch => branchIds.includes(branch.branchId)), 'WORKFLOW_CALLBACK_CONTRACT', 'Evidence exceeded the selected scope');
      const refs: Ref[] = evidence.branches.map(branch => ({ table: 'branches', id: branch.branchId }));
      if (refs.length) {
        add('sales.evidence', 'วันนี้ยอดขายเป็นอย่างไร', refs);
        add('sales.evidence', 'สาขาที่ฉันดูแลมียอดขายเทียบเป้าหมายอย่างไร', refs);
        add('operations.inventory', 'สาขาที่เลือกมีสินค้าใดต่ำกว่าสต็อกขั้นต่ำ', refs);
        add('operations.incidents', 'สาขาที่เลือกมีเหตุการณ์ใดที่ยังไม่ปิด', refs);
        if (request.phase === 'empty_chat') add('operations.staffing', 'สาขาที่เลือกมีจำนวนพนักงานเทียบแผนอย่างไร', refs);
      }
    }
    // These questions invoke existing authorized read services. They make no count or approval claim before a review exists.
    const orgRefsFor = (authority: Pick<WorkflowScopeRequest, 'permission' | 'roles' | 'purpose'>): Ref[] => {
      const activeOrgIds = new Set(context.principal.orgUnits.filter(row => row.body.active).map(row => row.id));
      const targets = [...new Set(context.principal.responsibilities.filter(row => row.body.active &&
        row.body.identityId === context.principal.directory.id && row.body.purpose === authority.purpose && activeOrgIds.has(row.body.orgUnitId))
        .map(row => row.body.orgUnitId))].map(orgUnitId => ({ orgUnitId }));
      if (!targets.length) return [];
      const scope = authorizeWorkflowScope(context.principal, { ...authority, targets });
      return [...new Set(scope.targets.flatMap(target => target.orgUnitId ? [target.orgUnitId] : []))]
        .map(id => ({ table: 'org_units', id }));
    };
    if (context.actor.role === 'hr_director' && context.actor.permissions.includes('hr.onboarding.director_read')) {
      const snapshotId = request.snapshotId ?? selection.queueSnapshots?.find(snapshot => snapshot.purpose === 'director_queue')?.id;
      if (snapshotId) {
        const { snapshot, items } = await readReviewedDirectorQueue(runtime, context, tx, snapshotId);
        const selected = request.requestId ? items.find(item => item.request.id === request.requestId)
          : request.employeeId ? items.find(item => item.employee.id === request.employeeId) : items[0];
        invariant(selected, 'WORKFLOW_NOT_FOUND', 'The selected reviewed request is unavailable', 404);
        invariant(request.employeeId === undefined || selected.employee.id === request.employeeId,
          'WORKFLOW_NOT_FOUND', 'The selected reviewed request is unavailable', 404);
        const refs: Ref[] = items.map(item => ({ table: 'onboarding_requests', id: item.request.id }));
        const snapshotRef = { id: snapshot.id, digest: snapshot.digest, expiresAt: snapshot.expiresAt };
        add('director_queue', 'มีรายการรับพนักงานใดรอฉันอนุมัติ', refs, 'read', snapshotRef);
        add('director_start_dates', 'ช่วยจัดลำดับรายการรออนุมัติตามวันเริ่มงาน', refs, 'read', snapshotRef);
        add('director_request_documents', `ตรวจเอกสารของคำขอรับพนักงานของ ${selected.employee.name}`, [{ table: 'onboarding_requests', id: selected.request.id }], 'read', snapshotRef);
        const orgRefs = orgRefsFor({ permission: 'hr.onboarding.director_read', roles: ['hr_director'], purpose: 'director_onboarding' });
        add('director_approvals_today', 'ดูประวัติการอนุมัติของฉันวันนี้', orgRefs);
      }
    }
    if (context.actor.role === 'east_manager' && context.actor.permissions.includes('hr.onboarding.manager_read')) {
      const refs = orgRefsFor({ permission: 'hr.onboarding.manager_read', roles: ['east_manager'], purpose: 'manager_onboarding' });
      add('manager_queue', 'มีรายการรับพนักงานใดรอฉันตรวจในฐานะผู้จัดการ', refs);
    }
    if (context.actor.role === 'hr_admin' && context.actor.permissions.includes('hr.read') && context.actor.permissions.includes('hr.onboarding.start')) {
      const refs = orgRefsFor({ permission: 'hr.onboarding.start', roles: ['hr_admin'], purpose: 'hr_operations' });
      add('onboarding_ready_for_start', 'มีรายการรับพนักงานใดที่อนุมัติครบและพร้อมเริ่มกระบวนการ', refs);
    }
    for (const capability of capabilities) {
      if (capability.behavior === 'read') {
        if (capability.kind === 'manager_queue') add(capability.id, 'มีรายการรับพนักงานใดรอฉันตรวจในฐานะผู้จัดการ', capability.targetRefs, 'read', capability.snapshotRef);
        continue;
      }
      const kind = workflowActionKinds.find(item => item === capability.kind);
      if (!kind || !capability.available || !capability.targetRefs.length || excluded.has(kind)) continue;
      if (['dashboard_share', 'dashboard_share_revoke'].includes(kind) && !request.dashboardId) continue;
      if (kind === 'onboarding_director_approve' && (!request.snapshotId || capability.snapshotRef?.id !== request.snapshotId)) continue;
      if (['onboarding_manager_approve', 'onboarding_return'].includes(kind) && (!request.snapshotId || capability.snapshotRef?.id !== request.snapshotId)) continue;
      const prompt = kind === 'onboarding_director_approve' && contextSnapshot &&
        digest(capability.targetRefs.map(ref => ref.id).sort()) !== digest([...contextSnapshot.displayedIds].sort())
        ? 'เตรียมอนุมัติรายการรับพนักงานที่เลือก' : suggestedActions[kind];
      add(capability.id, prompt, capability.targetRefs, 'prepare', capability.snapshotRef);
    }
    return suggestions.map(({ id, prompt }) => Object.freeze({ id, prompt }));
  });
}
