import { DomainError, invariant } from '../core/errors';
import { digest } from '../core/utils';
import { getWorkflowProjection, type ProjectedRow, type WorkflowProjectionReader } from '../storage/workflow-projections';
import {
  directoryIdentitySchema,
  expectedRowSchema,
  instantSchema,
  isoDateSchema,
  MAX_WORKFLOW_TARGETS,
  onboardingRequestSchema,
  responsibilitySchema,
  refSchema,
  workflowReceiptV2Schema,
  type CurrentState,
  type CommittedTarget,
  type DirectoryIdentity,
  type ExpectedRow,
  type GuardedTransaction,
  type PendingActionV2,
  type Ref,
  type TargetProof,
  type TargetSpec,
  type WorkflowActionKind,
  type WorkflowPayloadV2,
  type WorkflowValidation,
} from '../workflows/contracts';
import {
  defineWorkflowBinding,
  mergeExpectedRows,
  workflowRowState,
  type RuntimeReadContext,
  type SemanticTarget,
  type WorkflowRuntimeBinding,
} from '../workflows/action-runtime';
import { checkPostconditions, type ExpectedPostcondition } from '../workflows/action-results';
import { demoWorkflowPolicyV1, getDemoWorkflowPolicyV1Pin, getTaskDueDate, isContractReminderEligible } from '../workflows/policy';

type RowBody = Record<string, unknown> & { id: string; rowVersion?: number };
type Projected<T extends RowBody> = ProjectedRow<T>;
type BadgePayload = Extract<WorkflowPayloadV2, { kind: 'badge_revoke' }>;
type BadgeBody = RowBody & {
  employeeId: string;
  state: 'active' | 'revoked';
  version: number;
  updatedAt: string;
  operationKey?: string;
};
type EmployeeBody = RowBody & { name: string; branchId: string | null; active: boolean };
type BranchBody = RowBody & { name: string; region: string; orgUnitId?: string | null; active?: boolean };
type OrgUnitBody = RowBody & { name: string; active: boolean };
type ResponsibilityBody = ReturnType<typeof responsibilitySchema.parse> & RowBody;
type OnboardingRequestBody = ReturnType<typeof onboardingRequestSchema.parse> & RowBody;
type DirectoryIdentityBody = DirectoryIdentity & RowBody;
type OffboardingCaseBody = RowBody & {
  employeeId: string;
  ownerIdentityId: string;
  status: 'active' | 'closed';
  lifecycleId: string;
  lastDay?: string | null;
  reason?: string;
};
type OffboardingPlanBody = RowBody & {
  caseId: string;
  purpose: string;
  status: 'prepared';
  executionId?: string;
  employeeSnapshot: { id: string; name: string; branchId: string | null; active: boolean; rowVersion: number };
  assetAssignmentIds: string[];
};
type AssetAssignmentBody = RowBody & {
  assetId: string;
  employeeId: string;
  status: 'assigned' | 'returned' | 'lost';
  assignedAt: string;
};
type AssetBody = RowBody & { assetTag: string; status: 'available' | 'assigned' | 'retired' };
type EmploymentContractBody = RowBody & {
  employeeId: string;
  status: 'draft' | 'active' | 'expired' | 'terminated' | 'cancelled';
  startDate: string;
  endDate: string | null;
};
type PolicyDocumentBody = RowBody & { title: string; version: string };
type PlannedActionBody = RowBody & {
  planId: string;
  purpose: string;
  status: 'planned' | 'requested' | 'completed' | 'cancelled';
  executionId?: string;
  dueDate?: string | null;
  description?: string;
};
type TaskOwner = {
  identity: Projected<DirectoryIdentityBody>;
  responsibility: Projected<ResponsibilityBody>;
};
interface ResolvedFlowTarget {
  target: SemanticTarget;
  spec: TargetSpec;
  orgUnitId: string;
}
interface OffboardingSources {
  offboardingCase: Projected<OffboardingCaseBody>;
  employee: Projected<EmployeeBody>;
  caseOwner: TaskOwner;
  scope: EmployeeScope;
  assignments: Projected<AssetAssignmentBody>[];
  assets: Projected<AssetBody>[];
  plan: Projected<OffboardingPlanBody> | null;
  expectedRows: ExpectedRow[];
  employeeSnapshot: OffboardingPlanBody['employeeSnapshot'];
  assetAssignmentIds: string[];
}
interface EmployeeScope {
  orgUnitId: string;
  expectedRows: ExpectedRow[];
}
interface BadgeResolution {
  target: SemanticTarget;
  spec: TargetSpec;
  badge: Projected<BadgeBody>;
  employee: Projected<EmployeeBody>;
  scope: EmployeeScope;
}

const hrRoles = ['hr_admin'] as const;
const hrPurpose = 'hr_operations' as const;

function taskDateMatches(context: RuntimeReadContext, dueDate: string, priority: 'normal' | 'high'): boolean {
  return dueDate === getTaskDueDate(context.now(), priority);
}

function requireTaskDate(context: RuntimeReadContext, dueDate: string, priority: 'normal' | 'high'): void {
  invariant(taskDateMatches(context, dueDate, priority), 'WORKFLOW_INVALID_INPUT',
    'The HR task due date does not match the shared Bangkok priority policy');
}

async function projected<T extends RowBody>(
  reader: WorkflowProjectionReader,
  table: Ref['table'],
  rowId: string,
): Promise<Projected<T>> {
  const row = await reader.get<T>(table, rowId);
  invariant(row && row.id === rowId && row.body.id === rowId && Number.isSafeInteger(row.rowVersion) && row.rowVersion > 0,
    'WORKFLOW_STALE', 'A required HR workflow row is unavailable or inconsistent', 409);
  if (row.body.rowVersion !== undefined) invariant(row.body.rowVersion === row.rowVersion,
    'WORKFLOW_STALE', 'An HR workflow projection version is inconsistent', 409);
  return row;
}

function expected(table: Ref['table'], row: Projected<RowBody>): ExpectedRow {
  return expectedRowSchema.parse({
    ref: { table, id: row.id },
    rowVersion: row.rowVersion,
    state: workflowRowState(table, row.body),
  });
}

function deterministicId(prefix: string, semanticKey: string): string {
  return directoryIdentitySchema.shape.id.parse(prefix + '.' + semanticKey);
}

function semanticKey(kind: WorkflowActionKind, identity: unknown): string {
  return digest({ purpose: 'biztania/workflow-semantic/v2', kind, identity });
}

function makeTarget(input: {
  kind: WorkflowActionKind;
  targetId: string;
  ref: Ref;
  identity: unknown;
  scope: { orgUnitId: string };
  ownerIdentityId: string | null;
  expectedRows: ExpectedRow[];
  effectRef: Ref;
  effectVersion: number;
}): { target: SemanticTarget; spec: TargetSpec } {
  const key = semanticKey(input.kind, input.identity);
  const target = {
    targetId: directoryIdentitySchema.shape.id.parse(input.targetId),
    ref: refSchema.parse(input.ref),
    semanticKey: key,
    scope: { orgUnitId: directoryIdentitySchema.shape.id.parse(input.scope.orgUnitId) },
  } satisfies SemanticTarget;
  const spec: TargetSpec = {
    targetId: target.targetId,
    ref: target.ref,
    semanticKey: target.semanticKey,
    expectedRows: mergeExpectedRows(input.expectedRows),
    ownerIdentityId: input.ownerIdentityId,
    expectedEffectRef: refSchema.parse(input.effectRef),
    expectedEffectVersion: input.effectVersion,
  };
  return { target, spec };
}

function makeValidation(targets: TargetSpec[], approvedOrgUnitIds: string[]): WorkflowValidation {
  const ordered = [...targets].sort((left, right) => left.targetId.localeCompare(right.targetId));
  invariant(ordered.length > 0 && ordered.length <= 100, 'WORKFLOW_INVALID_INPUT', 'The HR workflow target count is unsupported');
  invariant(new Set(ordered.map(target => target.targetId)).size === ordered.length &&
    new Set(ordered.map(target => target.semanticKey)).size === ordered.length,
  'WORKFLOW_INVALID_INPUT', 'The HR workflow targets are repeated');
  return {
    targets: ordered,
    expectedRows: mergeExpectedRows(...ordered.map(target => target.expectedRows)),
    approvedBranchIds: [],
    approvedOrgUnitIds: [...new Set(approvedOrgUnitIds)].sort(),
    policy: getDemoWorkflowPolicyV1Pin(),
    reviewedSnapshotId: null,
  };
}

async function resolveEmployeeScope(
  reader: WorkflowProjectionReader,
  employee: Projected<EmployeeBody>,
  requireActive: boolean,
): Promise<EmployeeScope> {
  if (requireActive) invariant(employee.body.active, 'WORKFLOW_STALE', 'The employee is not active', 409);
  invariant(employee.body.branchId, 'WORKFLOW_STALE', 'The employee has no branch scope for this HR workflow', 409);
  const branch = await projected<BranchBody>(reader, 'branches', employee.body.branchId);
  invariant(branch.body.active === true && typeof branch.body.orgUnitId === 'string' && branch.body.orgUnitId.length > 0,
    'WORKFLOW_STALE', 'The employee branch has no current active organization scope', 409);
  const orgUnit = await projected<OrgUnitBody>(reader, 'org_units', branch.body.orgUnitId);
  invariant(orgUnit.body.active, 'WORKFLOW_STALE', 'The employee organization unit is inactive', 409);
  return {
    orgUnitId: orgUnit.id,
    expectedRows: [expected('branches', branch), expected('org_units', orgUnit)],
  };
}

type OnboardingTasksPayload = Extract<WorkflowPayloadV2, { kind: 'onboarding_tasks_create' }>;
type OffboardingPlanPayload = Extract<WorkflowPayloadV2, { kind: 'offboarding_plan_create' }>;
type ItDisablePayload = Extract<WorkflowPayloadV2, { kind: 'it_disable_request' }>;
type AssetReturnPayload = Extract<WorkflowPayloadV2, { kind: 'asset_return_create' }>;
type ContractReminderPayload = Extract<WorkflowPayloadV2, { kind: 'contract_reminder_create' }>;
type PolicyAcknowledgementPayload = Extract<WorkflowPayloadV2, { kind: 'policy_acknowledgement_assign' }>;

const OFFBOARDING_PLAN_PURPOSE = 'offboarding';
const OFFBOARDING_ACTIONS = [
  { purpose: 'it_disable_request', description: 'Prepare a simulated IT disable request.' },
  { purpose: 'asset_return', description: 'Prepare return tasks for the frozen asset assignments.' },
  { purpose: 'badge_review', description: 'Review the employee badge for separate revocation approval.' },
] as const;
const ONBOARDING_TASK_TITLES: Record<OnboardingTasksPayload['targets'][number]['templateId'], string> = {
  hr_welcome: 'Welcome and first-day preparation',
  it_setup_request: 'Request employee IT setup',
  policy_acknowledgement: 'Assign required policy acknowledgement',
};

function expectedRowsOf(...groups: readonly (readonly ExpectedRow[])[]): ExpectedRow[] {
  return mergeExpectedRows(...groups);
}

function targetForEffect(input: {
  kind: WorkflowActionKind;
  targetId: string;
  sourceRef: Ref;
  identity: unknown;
  orgUnitId: string;
  ownerIdentityId: string | null;
  expectedRows: ExpectedRow[];
  effectTable: Ref['table'];
}): ResolvedFlowTarget {
  const key = semanticKey(input.kind, input.identity);
  const made = makeTarget({
    kind: input.kind,
    targetId: input.targetId,
    ref: input.sourceRef,
    identity: input.identity,
    scope: { orgUnitId: input.orgUnitId },
    ownerIdentityId: input.ownerIdentityId,
    expectedRows: input.expectedRows,
    effectRef: { table: input.effectTable, id: deterministicId(input.effectTable, key) },
    effectVersion: 1,
  });
  return { ...made, orgUnitId: input.orgUnitId };
}

function sortedSpecs(targets: readonly ResolvedFlowTarget[]): TargetSpec[] {
  return targets.map(target => target.spec).sort((left, right) => left.targetId.localeCompare(right.targetId));
}

function assertActionTargets(action: PendingActionV2, specs: readonly TargetSpec[]): void {
  const ordered = [...specs].sort((left, right) => left.targetId.localeCompare(right.targetId));
  invariant(action.targets.length === ordered.length && digest(action.targets) === digest(ordered),
    'WORKFLOW_STALE', 'The reviewed HR source rows or effect identities changed', 409);
}

function actionTarget(action: PendingActionV2, kind: WorkflowActionKind, identity: unknown): TargetSpec {
  const key = semanticKey(kind, identity);
  const target = action.targets.find(candidate => candidate.semanticKey === key);
  invariant(target, 'WORKFLOW_CALLBACK_CONTRACT', 'The reviewed HR target is missing');
  return target;
}

async function taskOwner(
  reader: WorkflowProjectionReader,
  identityId: string,
  orgUnitId: string,
): Promise<TaskOwner> {
  const identityRow = await projected<DirectoryIdentityBody>(reader, 'directory_identities', identityId);
  const identity = directoryIdentitySchema.parse(identityRow.body);
  invariant(identity.active && identity.rowVersion === identityRow.rowVersion,
    'WORKFLOW_STALE', 'The selected HR task owner is inactive or inconsistent', 409);

  const rows = await reader.query<ResponsibilityBody>({
    kind: 'scoped', table: 'responsibilities', ownerId: identityId, limit: MAX_WORKFLOW_TARGETS,
  });
  invariant(rows.length < MAX_WORKFLOW_TARGETS,
    'WORKFLOW_UNAVAILABLE', 'The HR task owner has too many responsibility rows to resolve safely', 503);
  const responsibilities = rows.map(row => {
    const body = responsibilitySchema.parse(row.body);
    invariant(body.id === row.id && body.identityId === identityId && body.rowVersion === row.rowVersion,
      'WORKFLOW_STALE', 'The HR task owner responsibility is inconsistent', 409);
    return { ...row, body };
  });
  const matching = responsibilities.filter(row => row.body.active && row.body.purpose === hrPurpose && row.body.orgUnitId === orgUnitId);
  invariant(matching.length === 1,
    'WORKFLOW_SCOPE_DENIED', 'The selected owner has no unique active HR responsibility for this organization unit', 403);
  const responsibility = matching[0];
  return {
    identity: identityRow,
    responsibility,
  };
}

function ownerExpectedRows(owner: TaskOwner): ExpectedRow[] {
  return [expected('directory_identities', owner.identity), expected('responsibilities', owner.responsibility)];
}

function contextExpectedRows(employee: Projected<EmployeeBody>, scope: EmployeeScope): ExpectedRow[] {
  return [expected('employees', employee), ...scope.expectedRows];
}

function buildEmployeeSnapshot(employee: Projected<EmployeeBody>): OffboardingPlanBody['employeeSnapshot'] {
  invariant(typeof employee.body.name === 'string' && employee.body.name.length > 0 &&
    (employee.body.branchId === null || typeof employee.body.branchId === 'string') && typeof employee.body.active === 'boolean',
  'WORKFLOW_STALE', 'The employee snapshot is incomplete', 409);
  return {
    id: employee.id,
    name: employee.body.name,
    branchId: employee.body.branchId,
    active: employee.body.active,
    rowVersion: employee.rowVersion,
  };
}

type ScopedQuery = Extract<Parameters<WorkflowProjectionReader['query']>[0], { kind: 'scoped' }>;

function assignmentsForEmployeeQuery(employeeId: string, cursor?: string): ScopedQuery {
  // The current schema stream adds the exact equality filter. The cast keeps this file compilable
  // against the action worktree while that projection integration is being finalized.
  return {
    kind: 'scoped', table: 'asset_assignments', status: 'assigned', equals: { employeeId },
    ...(cursor ? { cursor } : {}), limit: MAX_WORKFLOW_TARGETS,
  } as unknown as ScopedQuery;
}

async function assignedAssets(
  reader: WorkflowProjectionReader,
  employeeId: string,
): Promise<{ assignments: Projected<AssetAssignmentBody>[]; assets: Projected<AssetBody>[] }> {
  const assignments: Projected<AssetAssignmentBody>[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  while (true) {
    const page = await reader.query<AssetAssignmentBody>(assignmentsForEmployeeQuery(employeeId, cursor));
    invariant(page.every(row => row.body.employeeId === employeeId && row.body.status === 'assigned'),
      'WORKFLOW_UNAVAILABLE', 'The asset-assignment query was not restricted to the selected employee', 503);
    for (const row of page) {
      invariant(!seen.has(row.id), 'WORKFLOW_CALLBACK_CONTRACT', 'The assigned-asset query repeated a row');
      seen.add(row.id);
      assignments.push(row);
    }
    invariant(assignments.length <= MAX_WORKFLOW_TARGETS,
      'WORKFLOW_INVALID_INPUT', 'The offboarding asset set exceeds the configured target limit');
    if (page.length < MAX_WORKFLOW_TARGETS) break;
    const nextCursor = page[page.length - 1]?.id;
    invariant(nextCursor && nextCursor !== cursor, 'WORKFLOW_CALLBACK_CONTRACT', 'The assigned-asset query did not advance');
    cursor = nextCursor;
  }
  assignments.sort((left, right) => left.id.localeCompare(right.id));
  const assets: Projected<AssetBody>[] = [];
  for (const assignment of assignments) {
    invariant(assignment.body.employeeId === employeeId && assignment.body.status === 'assigned',
      'WORKFLOW_STALE', 'An asset assignment is no longer assigned to the selected employee', 409);
    const asset = await projected<AssetBody>(reader, 'assets', assignment.body.assetId);
    invariant(asset.body.status === 'assigned', 'WORKFLOW_STALE', 'An assigned asset is not currently assigned', 409);
    assets.push(asset);
  }
  return { assignments, assets };
}

function offboardingPlanIdentity(offboardingCase: OffboardingCaseBody): { caseId: string; purpose: string } {
  return { caseId: offboardingCase.id, purpose: OFFBOARDING_PLAN_PURPOSE };
}

function offboardingPlanId(offboardingCase: OffboardingCaseBody): string {
  return deterministicId('offboarding_plans', semanticKey('offboarding_plan_create', offboardingPlanIdentity(offboardingCase)));
}

function offboardingPlanExpectedRows(sources: OffboardingSources): ExpectedRow[] {
  return expectedRowsOf(
    [expected('offboarding_cases', sources.offboardingCase), ...contextExpectedRows(sources.employee, sources.scope), ...ownerExpectedRows(sources.caseOwner)],
    sources.assignments.map(row => expected('asset_assignments', row)),
    sources.assets.map(row => expected('assets', row)),
    sources.plan ? [expected('offboarding_plans', sources.plan)] : [],
  );
}

async function resolveOffboardingSources(
  context: RuntimeReadContext,
  caseId: string,
  planId?: string,
): Promise<OffboardingSources> {
  const offboardingCase = await projected<OffboardingCaseBody>(context.projections, 'offboarding_cases', caseId);
  invariant(offboardingCase.body.status === 'active', 'WORKFLOW_STALE', 'The offboarding case is not active', 409);
  invariant(typeof offboardingCase.body.reason === 'string' && offboardingCase.body.reason.trim().length > 0,
    'WORKFLOW_STALE', 'The active offboarding case has no reviewed reason', 409);
  invariant(typeof offboardingCase.body.lastDay === 'string', 'WORKFLOW_STALE', 'The offboarding case has no effective date', 409);
  const lastDay = isoDateSchema.safeParse(offboardingCase.body.lastDay);
  invariant(lastDay.success, 'WORKFLOW_STALE', 'The offboarding case effective date is invalid', 409);
  const employee = await projected<EmployeeBody>(context.projections, 'employees', offboardingCase.body.employeeId);
  const scope = await resolveEmployeeScope(context.projections, employee, true);
  const caseOwner = await taskOwner(context.projections, offboardingCase.body.ownerIdentityId, scope.orgUnitId);
  const { assignments, assets } = await assignedAssets(context.projections, employee.id);
  const expectedRows = expectedRowsOf(
    [expected('offboarding_cases', offboardingCase), ...contextExpectedRows(employee, scope), ...ownerExpectedRows(caseOwner)],
    assignments.map(row => expected('asset_assignments', row)),
    assets.map(row => expected('assets', row)),
  );
  const result: OffboardingSources = {
    offboardingCase, employee, caseOwner, scope, assignments, assets, plan: null,
    expectedRows, employeeSnapshot: buildEmployeeSnapshot(employee), assetAssignmentIds: assignments.map(row => row.id).sort(),
  };
  if (planId !== undefined) {
    invariant(planId === offboardingPlanId(offboardingCase.body), 'WORKFLOW_STALE', 'The selected plan does not match this offboarding lifecycle', 409);
    const plan = await projected<OffboardingPlanBody>(context.projections, 'offboarding_plans', planId);
    invariant(plan.body.caseId === caseId && plan.body.purpose === OFFBOARDING_PLAN_PURPOSE && plan.body.status === 'prepared',
      'WORKFLOW_STALE', 'The offboarding plan is not prepared for this case', 409);
    invariant(digest(plan.body.employeeSnapshot) === digest(result.employeeSnapshot) &&
      digest([...plan.body.assetAssignmentIds].sort()) === digest(result.assetAssignmentIds),
    'WORKFLOW_STALE', 'The employee or asset assignment snapshot no longer matches the prepared plan', 409);
    result.plan = plan;
    result.expectedRows = expectedRowsOf(result.expectedRows, [expected('offboarding_plans', plan)]);
  }
  return result;
}

async function currentStatesFor(context: RuntimeReadContext, refs: Ref[]): Promise<CurrentState[]> {
  const uniqueRefs = [...new Map(refs.map(ref => [digest(ref), ref])).values()];
  const states: CurrentState[] = [];
  for (const ref of uniqueRefs) {
    const row = await context.projections.get<RowBody>(ref.table, ref.id);
    invariant(row && row.id === ref.id && row.body.id === ref.id,
      'WORKFLOW_STALE', 'A current HR workflow source row is unavailable', 409);
    const rawState = row.body.status ?? row.body.state;
    const state = typeof rawState === 'string' && rawState.length > 0 ? rawState : 'present';
    states.push({ ref, state, rowVersion: row.rowVersion, allowedNextActions: [], completedActions: [] });
  }
  return states;
}

function onboardingTaskIdentity(request: OnboardingRequestBody, templateId: OnboardingTasksPayload['targets'][number]['templateId']): unknown {
  return { requestId: request.id, templateId };
}

async function resolveOnboardingTaskTargets(
  context: RuntimeReadContext,
  payload: OnboardingTasksPayload,
): Promise<ResolvedFlowTarget[]> {
  const requestRow = await projected<OnboardingRequestBody>(context.projections, 'onboarding_requests', payload.requestId);
  const request = onboardingRequestSchema.parse(requestRow.body);
  invariant(request.state === 'onboarding_in_progress',
    'WORKFLOW_STALE', 'Onboarding tasks require a currently started onboarding request', 409);
  const employee = await projected<EmployeeBody>(context.projections, 'employees', request.employeeId);
  const scope = await resolveEmployeeScope(context.projections, employee, true);
  invariant(scope.orgUnitId === request.orgUnitId, 'WORKFLOW_STALE', 'The onboarding request organization differs from its employee scope', 409);
  const results: ResolvedFlowTarget[] = [];
  for (const input of payload.targets) {
    requireTaskDate(context, input.dueDate, input.priority);
    invariant((demoWorkflowPolicyV1.onboardingTaskTemplates as readonly string[]).includes(input.templateId),
      'WORKFLOW_INVALID_INPUT', 'The onboarding task template is not enabled by the current policy');
    const owner = await taskOwner(context.projections, input.ownerIdentityId, scope.orgUnitId);
    const identity = onboardingTaskIdentity(request, input.templateId);
    const key = semanticKey('onboarding_tasks_create', identity);
    results.push(targetForEffect({
      kind: 'onboarding_tasks_create',
      targetId: deterministicId('onboarding-task-target', key),
      sourceRef: { table: 'onboarding_requests', id: request.id },
      identity,
      orgUnitId: scope.orgUnitId,
      ownerIdentityId: owner.identity.id,
      expectedRows: expectedRowsOf(
        [expected('onboarding_requests', requestRow), ...contextExpectedRows(employee, scope)],
        ownerExpectedRows(owner),
      ),
      effectTable: 'onboarding_tasks',
    }));
  }
  return results;
}

async function resolveOffboardingPlanTargets(
  context: RuntimeReadContext,
  payload: OffboardingPlanPayload,
): Promise<ResolvedFlowTarget[]> {
  const sources = await resolveOffboardingSources(context, payload.caseId);
  const identity = offboardingPlanIdentity(sources.offboardingCase.body);
  const key = semanticKey('offboarding_plan_create', identity);
  return [targetForEffect({
    kind: 'offboarding_plan_create',
    targetId: deterministicId('offboarding-plan-target', key),
    sourceRef: { table: 'offboarding_cases', id: sources.offboardingCase.id },
    identity,
    orgUnitId: sources.scope.orgUnitId,
    ownerIdentityId: sources.caseOwner.identity.id,
    expectedRows: offboardingPlanExpectedRows(sources),
    effectTable: 'offboarding_plans',
  })];
}

async function plannedAction(
  reader: WorkflowProjectionReader,
  planId: string,
  purpose: typeof OFFBOARDING_ACTIONS[number]['purpose'],
  statuses: readonly PlannedActionBody['status'][],
): Promise<Projected<PlannedActionBody>> {
  const rows = await reader.query<PlannedActionBody>({
    kind: 'unique', table: 'planned_actions', constraint: 'planned_actions_plan_purpose_unique', values: { planId, purpose },
  });
  const details = OFFBOARDING_ACTIONS.find(candidate => candidate.purpose === purpose)!;
  invariant(rows.length === 1 && rows[0].body.planId === planId && rows[0].body.purpose === purpose &&
    statuses.includes(rows[0].body.status) && rows[0].body.description === details.description,
    'WORKFLOW_STALE', 'The corresponding offboarding plan action is missing or in the wrong state', 409);
  return rows[0];
}

function exactCaseActionDetails(sources: OffboardingSources, reason: string, effectiveDate?: string): void {
  invariant((effectiveDate === undefined || effectiveDate === sources.offboardingCase.body.lastDay) &&
    reason === sources.offboardingCase.body.reason,
  'WORKFLOW_STALE', 'The reviewed effective date or reason does not match the active offboarding case', 409);
}

async function resolveItDisableTargets(
  context: RuntimeReadContext,
  payload: ItDisablePayload,
): Promise<{ targets: ResolvedFlowTarget[]; planAction: Projected<PlannedActionBody>; sources: OffboardingSources }> {
  const sources = await resolveOffboardingSources(context, payload.caseId, payload.planId);
  exactCaseActionDetails(sources, payload.reason, payload.effectiveDate);
  const planAction = await plannedAction(context.projections, payload.planId, 'it_disable_request', ['planned', 'requested']);
  const identity = {
    caseId: sources.offboardingCase.id,
    planId: payload.planId,
    purpose: 'it_disable_request',
  };
  const key = semanticKey('it_disable_request', identity);
  const sourceRows = expectedRowsOf(sources.expectedRows, [expected('planned_actions', planAction)]);
  const target = targetForEffect({
    kind: 'it_disable_request',
    targetId: deterministicId('it-disable-target', key),
    sourceRef: { table: 'offboarding_cases', id: sources.offboardingCase.id },
    identity,
    orgUnitId: sources.scope.orgUnitId,
    ownerIdentityId: sources.caseOwner.identity.id,
    expectedRows: sourceRows,
    effectTable: 'it_disable_requests',
  });
  return { targets: [target], planAction, sources };
}

async function resolveAssetReturnTargets(
  context: RuntimeReadContext,
  payload: AssetReturnPayload,
): Promise<{ targets: ResolvedFlowTarget[]; planAction: Projected<PlannedActionBody>; sources: OffboardingSources }> {
  const sources = await resolveOffboardingSources(context, payload.caseId, payload.planId);
  const planAction = await plannedAction(context.projections, payload.planId, 'asset_return', ['planned', 'requested']);
  const sourceRows = expectedRowsOf(sources.expectedRows, [expected('planned_actions', planAction)]);
  const targets: ResolvedFlowTarget[] = [];
  for (const input of payload.targets) {
    const assignmentIndex = sources.assignments.findIndex(row => row.id === input.assetAssignmentId);
    invariant(assignmentIndex >= 0, 'WORKFLOW_STALE', 'The selected asset assignment is absent from the prepared offboarding plan', 409);
    exactCaseActionDetails(sources, input.reason);
    requireTaskDate(context, input.dueDate, input.priority);
    const assignment = sources.assignments[assignmentIndex];
    const asset = sources.assets[assignmentIndex];
    const owner = await taskOwner(context.projections, input.ownerIdentityId, sources.scope.orgUnitId);
    const identity = {
      caseId: sources.offboardingCase.id,
      planId: payload.planId,
      assetAssignmentId: assignment.id,
      purpose: 'asset_return',
    };
    const key = semanticKey('asset_return_create', identity);
    targets.push(targetForEffect({
      kind: 'asset_return_create',
      targetId: deterministicId('asset-return-target', key),
      sourceRef: { table: 'asset_assignments', id: assignment.id },
      identity,
      orgUnitId: sources.scope.orgUnitId,
      ownerIdentityId: owner.identity.id,
      expectedRows: expectedRowsOf(sourceRows, ownerExpectedRows(owner), [
        expected('asset_assignments', assignment), expected('assets', asset),
      ]),
      effectTable: 'asset_return_tasks',
    }));
  }
  return { targets, planAction, sources };
}

function contractReminderIdentity(contract: EmploymentContractBody): unknown {
  invariant(typeof contract.endDate === 'string', 'WORKFLOW_STALE', 'The contract has no current expiry date', 409);
  return { contractId: contract.id, expiresAt: contract.endDate, milestone: 'contract_expiry' };
}

function dateTaggedTargetId(prefix: string, date: string, key: string): string {
  return directoryIdentitySchema.shape.id.parse(`${prefix}.${date}.${key.slice(0, 32)}`);
}

function dateFromTargetId(prefix: string, targetId: string): string {
  const matched = new RegExp(`^${prefix}\\.(\\d{4}-\\d{2}-\\d{2})\\.[a-f0-9]{32}$`).exec(targetId);
  invariant(matched, 'WORKFLOW_CALLBACK_CONTRACT', 'The reviewed HR target date could not be established');
  return isoDateSchema.parse(matched[1]);
}

async function resolveContractReminderTargets(
  context: RuntimeReadContext,
  payload: ContractReminderPayload,
): Promise<ResolvedFlowTarget[]> {
  const targets: ResolvedFlowTarget[] = [];
  for (const input of payload.targets) {
    requireTaskDate(context, input.dueDate, input.priority);
    const contract = await projected<EmploymentContractBody>(context.projections, 'employment_contracts', input.contractId);
    invariant(contract.body.status === 'active' && typeof contract.body.endDate === 'string' &&
      isoDateSchema.safeParse(contract.body.endDate).success && isContractReminderEligible(contract.body.endDate, context.now()),
    'WORKFLOW_STALE', 'The contract is not currently eligible for an expiry reminder', 409);
    const employee = await projected<EmployeeBody>(context.projections, 'employees', contract.body.employeeId);
    const scope = await resolveEmployeeScope(context.projections, employee, true);
    const owner = await taskOwner(context.projections, input.ownerIdentityId, scope.orgUnitId);
    const identity = contractReminderIdentity(contract.body);
    const key = semanticKey('contract_reminder_create', identity);
    targets.push(targetForEffect({
      kind: 'contract_reminder_create',
      targetId: dateTaggedTargetId('contract-reminder-target', contract.body.endDate, key),
      sourceRef: { table: 'employment_contracts', id: contract.id },
      identity,
      orgUnitId: scope.orgUnitId,
      ownerIdentityId: owner.identity.id,
      expectedRows: expectedRowsOf(
        [expected('employment_contracts', contract), ...contextExpectedRows(employee, scope)],
        ownerExpectedRows(owner),
      ),
      effectTable: 'contract_reminders',
    }));
  }
  return targets;
}

async function resolvePolicyAcknowledgementTargets(
  context: RuntimeReadContext,
  payload: PolicyAcknowledgementPayload,
): Promise<ResolvedFlowTarget[]> {
  const policyDocument = await projected<PolicyDocumentBody>(context.projections, 'policy_documents', payload.policyDocumentId);
  invariant(policyDocument.body.version === payload.policyVersion,
    'WORKFLOW_STALE', 'The selected policy version is not the current document version', 409);
  const targets: ResolvedFlowTarget[] = [];
  for (const input of payload.targets) {
    requireTaskDate(context, input.dueDate, input.priority);
    const employee = await projected<EmployeeBody>(context.projections, 'employees', input.employeeId);
    const scope = await resolveEmployeeScope(context.projections, employee, true);
    const owner = await taskOwner(context.projections, input.ownerIdentityId, scope.orgUnitId);
    const identity = {
      employeeId: employee.id,
      policyDocumentId: policyDocument.id,
      policyVersion: policyDocument.body.version,
    };
    const key = semanticKey('policy_acknowledgement_assign', identity);
    targets.push(targetForEffect({
      kind: 'policy_acknowledgement_assign',
      targetId: deterministicId('policy-acknowledgement-target', key),
      sourceRef: { table: 'employees', id: employee.id },
      identity,
      orgUnitId: scope.orgUnitId,
      ownerIdentityId: owner.identity.id,
      expectedRows: expectedRowsOf(
        [expected('policy_documents', policyDocument), ...contextExpectedRows(employee, scope)],
        ownerExpectedRows(owner),
      ),
      effectTable: 'policy_acknowledgement_tasks',
    }));
  }
  return targets;
}

async function resolveBadge(
  context: RuntimeReadContext,
  payload: BadgePayload,
  requireActive: boolean,
): Promise<BadgeResolution> {
  const reader = context.projections;
  const badge = await projected<BadgeBody>(reader, 'mock_badges', payload.badgeId);
  const employee = await projected<EmployeeBody>(reader, 'employees', payload.employeeId);
  invariant(badge.body.employeeId === employee.id, 'WORKFLOW_STALE', 'The badge does not belong to the selected employee', 409);
  invariant((badge.body.state === 'active' || badge.body.state === 'revoked') && Number.isSafeInteger(badge.body.version) && badge.body.version > 0,
    'WORKFLOW_STALE', 'The badge state or version is invalid', 409);
  invariant(badge.body.version === badge.rowVersion, 'WORKFLOW_UNAVAILABLE', 'The badge body and guarded row versions cannot be reconciled', 503);
  if (requireActive) invariant(badge.body.state === 'active' && employee.body.active,
    'WORKFLOW_STALE', 'Badge revocation requires the linked active employee badge', 409);
  const scope = await resolveEmployeeScope(reader, employee, requireActive);
  const ref = { table: 'mock_badges' as const, id: badge.id };
  const rows = [expected('mock_badges', badge), expected('employees', employee), ...scope.expectedRows];
  const targetAndSpec = makeTarget({
    kind: 'badge_revoke',
    targetId: badge.id,
    ref,
    identity: { badgeId: badge.id, employeeId: employee.id, transition: 'revoke' },
    scope: { orgUnitId: scope.orgUnitId },
    ownerIdentityId: null,
    expectedRows: rows,
    effectRef: ref,
    effectVersion: badge.rowVersion + 1,
  });
  return { ...targetAndSpec, badge, employee, scope };
}

function badgePostconditions(
  action: PendingActionV2,
  executionId: string,
  confirmedAt: string,
): ExpectedPostcondition[] {
  invariant(action.payload.kind === 'badge_revoke' && action.targets.length === 1,
    'WORKFLOW_CALLBACK_CONTRACT', 'The badge revoke approval is malformed');
  const target = action.targets[0];
  const payload = action.payload;
  const eventRef = { table: 'badge_effect_events' as const, id: deterministicId('badge-event', target.semanticKey) };
  return [{
    targetId: target.targetId,
    ref: target.expectedEffectRef,
    rowVersion: target.expectedEffectVersion,
    executionId,
    fields: [
      { path: 'state', expected: 'revoked' },
      { path: 'employeeId', expected: payload.employeeId },
      { path: 'version', expected: target.expectedEffectVersion },
      { path: 'operationKey', expected: executionId },
      { path: 'updatedAt', expected: confirmedAt },
    ],
    attributionRefs: [{
      ref: eventRef,
      rowVersion: 1,
      fields: [
        { path: 'badgeId', expected: payload.badgeId },
        { path: 'employeeId', expected: payload.employeeId },
        { path: 'actorId', expected: action.actorId },
        { path: 'executionId', expected: executionId },
        { path: 'effect', expected: 'revoked' },
        { path: 'reason', expected: payload.reason },
        { path: 'createdAt', expected: confirmedAt },
      ],
    }],
  }];
}

async function currentBadgeStates(context: RuntimeReadContext, refs: Ref[]): Promise<CurrentState[]> {
  const rows: CurrentState[] = [];
  for (const ref of refs) {
    invariant(ref.table === 'mock_badges', 'WORKFLOW_CALLBACK_CONTRACT', 'The badge binding received a non-badge state reference');
    const row = await projected<BadgeBody>(context.projections, 'mock_badges', ref.id);
    rows.push({
      ref,
      state: row.body.state,
      rowVersion: row.rowVersion,
      allowedNextActions: row.body.state === 'active' ? ['badge_revoke'] as WorkflowActionKind[] : [],
      completedActions: [],
    });
  }
  return rows;
}

function unavailable(message: string): never {
  throw new DomainError('WORKFLOW_UNAVAILABLE', message, 503);
}

function blockedBinding(
  kind: WorkflowActionKind,
  permission: string,
  reason: string,
): WorkflowRuntimeBinding {
  const message = kind + ' is unavailable: ' + reason;
  return defineWorkflowBinding({
    kind,
    contractVersion: 2,
    packIds: ['hr'],
    executionMode: 'atomic_local',
    authority: { permission, roles: hrRoles, purpose: hrPurpose },
    identify: async () => unavailable(message),
    expectedPostconditions: () => unavailable(message),
    validate: async () => unavailable(message),
    executeAtomic: async () => unavailable(message),
    verify: async () => unavailable(message),
    currentStates: async () => [],
  });
}

function badgeRevocationBinding(): WorkflowRuntimeBinding {
  return defineWorkflowBinding({
    kind: 'badge_revoke',
    contractVersion: 2,
    packIds: ['hr'],
    executionMode: 'atomic_local',
    authority: { permission: 'badge.revoke', roles: hrRoles, purpose: hrPurpose },
    identify: async (context, payload) => {
      invariant(context.actor.permissions.includes('hr.read'), 'WORKFLOW_PERMISSION_DENIED', 'A scoped HR read permission is required', 403);
      const resolved = await resolveBadge(context, payload, false);
      return { targets: [resolved.target] };
    },
    expectedPostconditions: badgePostconditions,
    validate: async (context, payload) => {
      const resolved = await resolveBadge(context as RuntimeReadContext, payload, true);
      return makeValidation([resolved.spec], [resolved.scope.orgUnitId]);
    },
    executeAtomic: async (context, payload) => {
      const runtimeContext = context as typeof context & RuntimeReadContext;
      invariant(runtimeContext.actor.id === context.action.actorId && context.action.payload.kind === 'badge_revoke',
        'WORKFLOW_NOT_FOUND', 'The badge revocation approval is unavailable', 404);
      const resolved = await resolveBadge(runtimeContext, payload, true);
      invariant(context.action.targets.length === 1 && digest([resolved.spec]) === digest(context.action.targets),
        'WORKFLOW_STALE', 'The badge or employee changed after review', 409);
      const expectedPostconditions = badgePostconditions(context.action, context.executionId, context.now().toISOString());
      const witness = expectedPostconditions[0];
      const badgeNext = {
        ...resolved.badge.body,
        rowVersion: resolved.badge.rowVersion + 1,
        state: 'revoked',
        version: resolved.badge.body.version + 1,
        operationKey: context.executionId,
        updatedAt: context.now().toISOString(),
      } satisfies BadgeBody & { rowVersion: number };
      const changed = await context.tx.compareAndSwap('mock_badges', resolved.badge.id,
        { rowVersion: resolved.badge.rowVersion, state: 'active' }, badgeNext);
      invariant(changed.updated, 'WORKFLOW_CONFLICT', 'The badge changed during revocation', 409);

      const event = {
        id: witness.attributionRefs[0].ref.id,
        rowVersion: 1,
        badgeId: payload.badgeId,
        employeeId: payload.employeeId,
        actorId: context.actor.id,
        executionId: context.executionId,
        effect: 'revoked',
        reason: payload.reason,
        createdAt: context.now().toISOString(),
      };
      const inserted = await context.tx.insertUnique('badge_effect_events', event, {
        constraint: 'badge_effect_events_execution_unique',
        values: { executionId: context.executionId },
      });
      invariant(inserted.inserted, 'WORKFLOW_CONFLICT', 'A badge revocation event already exists for this execution', 409);
      return [{
        targetId: resolved.spec.targetId,
        ref: resolved.spec.expectedEffectRef,
        executionId: context.executionId,
        rowVersion: resolved.spec.expectedEffectVersion,
      }];
    },
    verify: async (context, committed) => {
      const runtimeContext = context as typeof context & RuntimeReadContext;
      const receiptRow = await runtimeContext.projections.get('action_executions', context.executionId);
      invariant(receiptRow, 'WORKFLOW_CALLBACK_CONTRACT', 'The badge revocation execution is unavailable for readback');
      const receipt = workflowReceiptV2Schema.parse(receiptRow.body);
      invariant(receipt.id === context.executionId && receipt.kind === 'badge_revoke' && receipt.actorId === context.action.actorId,
        'WORKFLOW_CALLBACK_CONTRACT', 'The badge revocation execution attribution did not match');
      await checkPostconditions(runtimeContext.projections,
        badgePostconditions(context.action, context.executionId, receipt.createdAt));
      const proofs: TargetProof[] = [];
      for (const target of committed) {
        const row = await projected<BadgeBody>(runtimeContext.projections, 'mock_badges', target.ref.id);
        invariant(row.rowVersion === target.rowVersion && row.body.state === 'revoked' && row.body.operationKey === context.executionId,
          'WORKFLOW_CALLBACK_CONTRACT', 'The committed badge state did not match its execution');
        proofs.push({
          targetId: target.targetId,
          ref: target.ref,
          outcome: 'verified_success',
          executionId: context.executionId,
          observedRowVersion: row.rowVersion,
          checkedAt: context.now().toISOString(),
          mismatchCodes: [],
        });
      }
      return proofs;
    },
    currentStates: async (context, refs) => currentBadgeStates(context as RuntimeReadContext, refs),
  });
}

type AtomicFlowContext = RuntimeReadContext & { tx: GuardedTransaction; action: PendingActionV2; executionId: string };
type VerifyFlowContext = RuntimeReadContext & { action: PendingActionV2; executionId: string };

function offboardingActionId(planId: string, purpose: string): string {
  return deterministicId('planned_actions', digest({ planId, purpose }));
}

function expectedVersion(action: PendingActionV2, ref: Ref): number {
  const row = action.expectedRows.find(candidate => digest(candidate.ref) === digest(ref));
  invariant(row, 'WORKFLOW_CALLBACK_CONTRACT', 'A reviewed HR source version is unavailable');
  return row.rowVersion;
}

function expectedState(action: PendingActionV2, ref: Ref): string | null {
  const row = action.expectedRows.find(candidate => digest(candidate.ref) === digest(ref));
  invariant(row, 'WORKFLOW_CALLBACK_CONTRACT', 'A reviewed HR source state is unavailable');
  return row.state;
}

function targetWitness(
  action: PendingActionV2,
  kind: WorkflowActionKind,
  identity: unknown,
  executionId: string,
  fields: ExpectedPostcondition['fields'],
  attributionRefs: ExpectedPostcondition['attributionRefs'] = [],
): ExpectedPostcondition {
  const target = actionTarget(action, kind, identity);
  return {
    targetId: target.targetId,
    ref: target.expectedEffectRef,
    rowVersion: target.expectedEffectVersion,
    executionId,
    fields,
    attributionRefs,
  };
}

function planActionWitness(action: PendingActionV2, input: {
  planId: string;
  purpose: typeof OFFBOARDING_ACTIONS[number]['purpose'];
  executionId: string;
  afterPlannedTransition?: boolean;
  newlyCreated?: boolean;
}): ExpectedPostcondition['attributionRefs'][number] {
  const ref = { table: 'planned_actions' as const, id: offboardingActionId(input.planId, input.purpose) };
  const version = input.newlyCreated ? 1 : expectedVersion(action, ref) + (input.afterPlannedTransition ? 1 : 0);
  const details = OFFBOARDING_ACTIONS.find(candidate => candidate.purpose === input.purpose)!;
  return {
    ref,
    rowVersion: version,
    fields: [
      { path: 'id', expected: ref.id },
      { path: 'planId', expected: input.planId },
      { path: 'purpose', expected: input.purpose },
      { path: 'status', expected: input.afterPlannedTransition ? 'requested' : 'planned' },
      { path: 'description', expected: details.description },
      { path: 'executionId', expected: input.executionId },
    ],
  };
}

function expectedPostconditionsFor(action: PendingActionV2, executionId: string, confirmedAt: string): ExpectedPostcondition[] {
  const timestamp = instantSchema.parse(confirmedAt);
  switch (action.payload.kind) {
    case 'onboarding_tasks_create': {
      const payload = action.payload;
      const employeeId = action.expectedRows.find(row => row.ref.table === 'employees')?.ref.id;
      invariant(employeeId, 'WORKFLOW_CALLBACK_CONTRACT', 'The reviewed onboarding employee is unavailable');
      return payload.targets.map(input => targetWitness(action, payload.kind,
        { requestId: payload.requestId, templateId: input.templateId }, executionId, [
          { path: 'requestId', expected: payload.requestId },
          { path: 'employeeId', expected: employeeId },
          { path: 'ownerIdentityId', expected: input.ownerIdentityId },
          { path: 'templateId', expected: input.templateId },
          { path: 'title', expected: ONBOARDING_TASK_TITLES[input.templateId] },
          { path: 'status', expected: 'open' },
          { path: 'dueDate', expected: input.dueDate },
          { path: 'reason', expected: input.reason },
          { path: 'priority', expected: input.priority },
          { path: 'executionId', expected: executionId },
          { path: 'createdAt', expected: timestamp },
        ]));
    }
    case 'offboarding_plan_create': {
      const payload = action.payload;
      const planIdentity = { caseId: payload.caseId, purpose: OFFBOARDING_PLAN_PURPOSE };
      const target = actionTarget(action, payload.kind, planIdentity);
      const employeeSource = action.expectedRows.find(row => row.ref.table === 'employees');
      invariant(employeeSource, 'WORKFLOW_CALLBACK_CONTRACT', 'The reviewed employee version is unavailable');
      const assignmentIds = action.expectedRows.filter(row => row.ref.table === 'asset_assignments')
        .map(row => row.ref.id).sort();
      // The frozen envelope retains source refs and versions, but not source bodies. The precommit
      // witness therefore checks employee id/version and the exact assignment ID set; verifyHrOperation
      // independently compares the full employee snapshot and current assignment set after commit.
      return [targetWitness(action, payload.kind, planIdentity, executionId, [
        { path: 'caseId', expected: payload.caseId },
        { path: 'purpose', expected: OFFBOARDING_PLAN_PURPOSE },
        { path: 'status', expected: 'prepared' },
        { path: 'executionId', expected: executionId },
        { path: 'createdAt', expected: timestamp },
        { path: 'employeeSnapshot.id', expected: employeeSource.ref.id },
        { path: 'employeeSnapshot.rowVersion', expected: employeeSource.rowVersion },
        { path: 'assetAssignmentIds', expected: assignmentIds },
      ], OFFBOARDING_ACTIONS.map(item => planActionWitness(action, {
        planId: target.expectedEffectRef.id, purpose: item.purpose, executionId, newlyCreated: true,
      })))];
    }
    case 'it_disable_request': {
      const payload = action.payload;
      const employeeId = action.expectedRows.find(row => row.ref.table === 'employees')?.ref.id;
      invariant(employeeId, 'WORKFLOW_CALLBACK_CONTRACT', 'The reviewed offboarding employee is unavailable');
      const identity = { caseId: payload.caseId, planId: payload.planId, purpose: 'it_disable_request' };
      return [targetWitness(action, payload.kind, identity, executionId, [
        { path: 'caseId', expected: payload.caseId },
        { path: 'planId', expected: payload.planId },
        { path: 'employeeId', expected: employeeId },
        { path: 'status', expected: 'requested' },
        { path: 'effectiveDate', expected: payload.effectiveDate },
        { path: 'reason', expected: payload.reason },
        { path: 'executionId', expected: executionId },
        { path: 'requestedAt', expected: timestamp },
      ], [planActionWitness(action, {
        planId: payload.planId, purpose: 'it_disable_request', executionId,
        afterPlannedTransition: true,
      })])];
    }
    case 'asset_return_create': {
      const payload = action.payload;
      const planActionRef = { table: 'planned_actions' as const, id: offboardingActionId(payload.planId, 'asset_return') };
      const transition = expectedState(action, planActionRef) === 'planned';
      return payload.targets.map((input, index) => {
        const identity = {
          caseId: payload.caseId, planId: payload.planId,
          assetAssignmentId: input.assetAssignmentId, purpose: 'asset_return',
        };
        return targetWitness(action, payload.kind, identity, executionId, [
          { path: 'assignmentId', expected: input.assetAssignmentId },
          { path: 'caseId', expected: payload.caseId },
          { path: 'planId', expected: payload.planId },
          { path: 'ownerIdentityId', expected: input.ownerIdentityId },
          { path: 'status', expected: 'open' },
          { path: 'dueDate', expected: input.dueDate },
          { path: 'reason', expected: input.reason },
          { path: 'priority', expected: input.priority },
          { path: 'executionId', expected: executionId },
          { path: 'createdAt', expected: timestamp },
        ], transition && index === 0 ? [planActionWitness(action, {
          planId: payload.planId, purpose: 'asset_return', executionId,
          afterPlannedTransition: true,
        })] : []);
      });
    }
    case 'contract_reminder_create': {
      const payload = action.payload;
      return payload.targets.map(input => {
        const target = action.targets.find(candidate => candidate.ref.table === 'employment_contracts' && candidate.ref.id === input.contractId);
        invariant(target, 'WORKFLOW_CALLBACK_CONTRACT', 'The reviewed contract reminder target is unavailable');
        const expiresAt = dateFromTargetId('contract-reminder-target', target.targetId);
        const identity = { contractId: input.contractId, expiresAt, milestone: 'contract_expiry' };
        return targetWitness(action, payload.kind, identity, executionId, [
          { path: 'contractId', expected: input.contractId },
          { path: 'milestone', expected: 'contract_expiry' },
          { path: 'expiresAt', expected: expiresAt },
          { path: 'status', expected: 'pending' },
          { path: 'ownerIdentityId', expected: input.ownerIdentityId },
          { path: 'dueDate', expected: input.dueDate },
          { path: 'priority', expected: input.priority },
          { path: 'reason', expected: input.reason },
          { path: 'executionId', expected: executionId },
          { path: 'createdAt', expected: timestamp },
        ]);
      });
    }
    case 'policy_acknowledgement_assign': {
      const payload = action.payload;
      return payload.targets.map(input => targetWitness(action, payload.kind, {
        employeeId: input.employeeId,
        policyDocumentId: payload.policyDocumentId,
        policyVersion: payload.policyVersion,
      }, executionId, [
        { path: 'employeeId', expected: input.employeeId },
        { path: 'policyDocumentId', expected: payload.policyDocumentId },
        { path: 'policyVersion', expected: payload.policyVersion },
        { path: 'status', expected: 'pending' },
        { path: 'ownerIdentityId', expected: input.ownerIdentityId },
        { path: 'dueDate', expected: input.dueDate },
        { path: 'priority', expected: input.priority },
        { path: 'reason', expected: input.reason },
        { path: 'executionId', expected: executionId },
        { path: 'createdAt', expected: timestamp },
      ]));
    }
    default:
      return unavailable('No HR operation postcondition is defined for this action kind');
  }
}

function committedTarget(target: TargetSpec, executionId: string): CommittedTarget {
  return {
    targetId: target.targetId,
    ref: target.expectedEffectRef,
    executionId,
    rowVersion: target.expectedEffectVersion,
  };
}

function assertActorOwnsAction(context: AtomicFlowContext): void {
  invariant(context.actor.id === context.action.actorId && context.actor.sessionId === context.action.sessionId,
    'WORKFLOW_NOT_FOUND', 'The HR approval is unavailable', 404);
}

async function transitionPlannedAction(
  context: AtomicFlowContext,
  row: Projected<PlannedActionBody>,
): Promise<PlannedActionBody & { rowVersion: number }> {
  if (row.body.status === 'requested') {
    return { ...row.body, rowVersion: row.rowVersion };
  }
  invariant(row.body.status === 'planned', 'WORKFLOW_STALE', 'The plan action is not available for request', 409);
  const next = {
    ...row.body,
    rowVersion: row.rowVersion + 1,
    status: 'requested' as const,
    executionId: context.executionId,
  };
  const changed = await context.tx.compareAndSwap('planned_actions', row.id,
    { rowVersion: row.rowVersion, state: 'planned' }, next);
  invariant(changed.updated, 'WORKFLOW_CONFLICT', 'The offboarding plan action changed during request', 409);
  return { ...changed.row, rowVersion: row.rowVersion + 1 };
}

async function executeOnboardingTasks(context: AtomicFlowContext, payload: OnboardingTasksPayload): Promise<CommittedTarget[]> {
  assertActorOwnsAction(context);
  const targets = await resolveOnboardingTaskTargets(context, payload);
  assertActionTargets(context.action, sortedSpecs(targets));
  const request = await projected<OnboardingRequestBody>(context.projections, 'onboarding_requests', payload.requestId);
  const createdAt = instantSchema.parse(context.now().toISOString());
  const committed: CommittedTarget[] = [];
  for (const input of payload.targets) {
    const identity = { requestId: payload.requestId, templateId: input.templateId };
    const target = actionTarget(context.action, payload.kind, identity);
    const inserted = await context.tx.insertUnique('onboarding_tasks', {
      id: target.expectedEffectRef.id,
      rowVersion: target.expectedEffectVersion,
      requestId: request.id,
      employeeId: request.body.employeeId,
      ownerIdentityId: input.ownerIdentityId,
      templateId: input.templateId,
      title: ONBOARDING_TASK_TITLES[input.templateId],
      status: 'open',
      dueDate: input.dueDate,
      reason: input.reason,
      priority: input.priority,
      executionId: context.executionId,
      createdAt,
    }, { constraint: 'onboarding_tasks_request_template_unique', values: { requestId: request.id, templateId: input.templateId } });
    invariant(inserted.inserted, 'WORKFLOW_CONFLICT', 'An onboarding task already exists for this request template', 409);
    committed.push(committedTarget(target, context.executionId));
  }
  invariant(committed.length === context.action.targetCount, 'WORKFLOW_CALLBACK_CONTRACT', 'The onboarding task count did not match the reviewed action');
  return committed;
}

async function executeOffboardingPlan(context: AtomicFlowContext, payload: OffboardingPlanPayload): Promise<CommittedTarget[]> {
  assertActorOwnsAction(context);
  const sources = await resolveOffboardingSources(context, payload.caseId);
  const resolved = await resolveOffboardingPlanTargets(context, payload);
  assertActionTargets(context.action, sortedSpecs(resolved));
  const target = resolved[0].spec;
  const planId = target.expectedEffectRef.id;
  const createdAt = instantSchema.parse(context.now().toISOString());
  const plan = await context.tx.insertUnique('offboarding_plans', {
    id: planId,
    rowVersion: target.expectedEffectVersion,
    caseId: sources.offboardingCase.id,
    purpose: OFFBOARDING_PLAN_PURPOSE,
    status: 'prepared',
    executionId: context.executionId,
    employeeSnapshot: sources.employeeSnapshot,
    assetAssignmentIds: sources.assetAssignmentIds,
    createdAt,
  }, { constraint: 'offboarding_plans_case_purpose_unique', values: { caseId: sources.offboardingCase.id, purpose: OFFBOARDING_PLAN_PURPOSE } });
  invariant(plan.inserted, 'WORKFLOW_CONFLICT', 'An offboarding plan already exists for this case', 409);
  for (const item of OFFBOARDING_ACTIONS) {
    const inserted = await context.tx.insertUnique('planned_actions', {
      id: offboardingActionId(planId, item.purpose),
      rowVersion: 1,
      planId,
      purpose: item.purpose,
      status: 'planned',
      description: item.description,
      executionId: context.executionId,
      createdAt,
    }, { constraint: 'planned_actions_plan_purpose_unique', values: { planId, purpose: item.purpose } });
    invariant(inserted.inserted, 'WORKFLOW_CONFLICT', 'An offboarding plan action already exists', 409);
  }
  return [committedTarget(target, context.executionId)];
}

async function executeItDisableRequest(context: AtomicFlowContext, payload: ItDisablePayload): Promise<CommittedTarget[]> {
  assertActorOwnsAction(context);
  const resolved = await resolveItDisableTargets(context, payload);
  assertActionTargets(context.action, sortedSpecs(resolved.targets));
  const target = resolved.targets[0].spec;
  await transitionPlannedAction(context, resolved.planAction);
  const requestedAt = instantSchema.parse(context.now().toISOString());
  const inserted = await context.tx.insertUnique('it_disable_requests', {
    id: target.expectedEffectRef.id,
    rowVersion: target.expectedEffectVersion,
    caseId: payload.caseId,
    planId: payload.planId,
    employeeId: resolved.sources.employee.id,
    status: 'requested',
    effectiveDate: payload.effectiveDate,
    reason: payload.reason,
    executionId: context.executionId,
    requestedAt,
  }, { constraint: 'it_disable_requests_case_plan_unique', values: { caseId: payload.caseId, planId: payload.planId } });
  invariant(inserted.inserted, 'WORKFLOW_CONFLICT', 'A simulated IT disable request already exists for this plan', 409);
  return [committedTarget(target, context.executionId)];
}

async function executeAssetReturn(context: AtomicFlowContext, payload: AssetReturnPayload): Promise<CommittedTarget[]> {
  assertActorOwnsAction(context);
  const resolved = await resolveAssetReturnTargets(context, payload);
  assertActionTargets(context.action, sortedSpecs(resolved.targets));
  await transitionPlannedAction(context, resolved.planAction);
  const createdAt = instantSchema.parse(context.now().toISOString());
  const committed: CommittedTarget[] = [];
  for (const input of payload.targets) {
    const identity = {
      caseId: payload.caseId, planId: payload.planId,
      assetAssignmentId: input.assetAssignmentId, purpose: 'asset_return',
    };
    const target = actionTarget(context.action, payload.kind, identity);
    const inserted = await context.tx.insertUnique('asset_return_tasks', {
      id: target.expectedEffectRef.id,
      rowVersion: target.expectedEffectVersion,
      assignmentId: input.assetAssignmentId,
      caseId: payload.caseId,
      planId: payload.planId,
      ownerIdentityId: input.ownerIdentityId,
      status: 'open',
      dueDate: input.dueDate,
      reason: input.reason,
      priority: input.priority,
      executionId: context.executionId,
      createdAt,
    }, { constraint: 'asset_return_tasks_open_assignment_unique', values: { assignmentId: input.assetAssignmentId } });
    invariant(inserted.inserted, 'WORKFLOW_CONFLICT', 'An open asset return task already exists for this assignment', 409);
    committed.push(committedTarget(target, context.executionId));
  }
  invariant(committed.length === context.action.targetCount, 'WORKFLOW_CALLBACK_CONTRACT', 'The asset return task count did not match the reviewed action');
  return committed;
}

async function executeContractReminders(context: AtomicFlowContext, payload: ContractReminderPayload): Promise<CommittedTarget[]> {
  assertActorOwnsAction(context);
  const targets = await resolveContractReminderTargets(context, payload);
  assertActionTargets(context.action, sortedSpecs(targets));
  const createdAt = instantSchema.parse(context.now().toISOString());
  const committed: CommittedTarget[] = [];
  for (const input of payload.targets) {
    const contract = await projected<EmploymentContractBody>(context.projections, 'employment_contracts', input.contractId);
    const identity = contractReminderIdentity(contract.body);
    const target = actionTarget(context.action, payload.kind, identity);
    const expiresAt = dateFromTargetId('contract-reminder-target', target.targetId);
    invariant(contract.body.endDate === expiresAt, 'WORKFLOW_STALE', 'The contract expiry differs from the reviewed reminder target', 409);
    const inserted = await context.tx.insertUnique('contract_reminders', {
      id: target.expectedEffectRef.id,
      rowVersion: target.expectedEffectVersion,
      contractId: contract.id,
      milestone: 'contract_expiry',
      expiresAt,
      status: 'pending',
      ownerIdentityId: input.ownerIdentityId,
      dueDate: input.dueDate,
      priority: input.priority,
      reason: input.reason,
      executionId: context.executionId,
      createdAt,
    }, { constraint: 'contract_reminders_contract_milestone_unique', values: {
      contractId: contract.id, expiresAt, milestone: 'contract_expiry',
    } });
    invariant(inserted.inserted, 'WORKFLOW_CONFLICT', 'A contract expiry reminder already exists', 409);
    committed.push(committedTarget(target, context.executionId));
  }
  invariant(committed.length === context.action.targetCount, 'WORKFLOW_CALLBACK_CONTRACT', 'The contract reminder count did not match the reviewed action');
  return committed;
}

async function executePolicyAcknowledgements(context: AtomicFlowContext, payload: PolicyAcknowledgementPayload): Promise<CommittedTarget[]> {
  assertActorOwnsAction(context);
  const targets = await resolvePolicyAcknowledgementTargets(context, payload);
  assertActionTargets(context.action, sortedSpecs(targets));
  const createdAt = instantSchema.parse(context.now().toISOString());
  const committed: CommittedTarget[] = [];
  for (const input of payload.targets) {
    const identity = {
      employeeId: input.employeeId,
      policyDocumentId: payload.policyDocumentId,
      policyVersion: payload.policyVersion,
    };
    const target = actionTarget(context.action, payload.kind, identity);
    const inserted = await context.tx.insertUnique('policy_acknowledgement_tasks', {
      id: target.expectedEffectRef.id,
      rowVersion: target.expectedEffectVersion,
      employeeId: input.employeeId,
      policyDocumentId: payload.policyDocumentId,
      policyVersion: payload.policyVersion,
      status: 'pending',
      ownerIdentityId: input.ownerIdentityId,
      dueDate: input.dueDate,
      priority: input.priority,
      reason: input.reason,
      executionId: context.executionId,
      createdAt,
    }, { constraint: 'policy_ack_employee_version_unique', values: {
      employeeId: input.employeeId, policyDocumentId: payload.policyDocumentId, policyVersion: payload.policyVersion,
    } });
    invariant(inserted.inserted, 'WORKFLOW_CONFLICT', 'This employee already has an acknowledgement task for the policy version', 409);
    committed.push(committedTarget(target, context.executionId));
  }
  invariant(committed.length === context.action.targetCount, 'WORKFLOW_CALLBACK_CONTRACT', 'The policy acknowledgement count did not match the reviewed action');
  return committed;
}

function mutatedPlanActionRef(action: PendingActionV2): Ref | null {
  if (action.payload.kind === 'it_disable_request') {
    return { table: 'planned_actions', id: offboardingActionId(action.payload.planId, 'it_disable_request') };
  }
  if (action.payload.kind === 'asset_return_create') {
    return { table: 'planned_actions', id: offboardingActionId(action.payload.planId, 'asset_return') };
  }
  return null;
}

async function sourceRowsStillMatch(context: VerifyFlowContext): Promise<boolean> {
  try {
    const transitionRef = mutatedPlanActionRef(context.action);
    for (const source of context.action.expectedRows) {
      if (transitionRef && digest(source.ref) === digest(transitionRef) && source.state === 'planned') continue;
      const row = await context.projections.get<RowBody>(source.ref.table, source.ref.id);
      if (!row || row.rowVersion !== source.rowVersion || workflowRowState(source.ref.table, row.body) !== source.state) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function extraReadback(context: VerifyFlowContext, target: CommittedTarget): Promise<boolean> {
  try {
    const action = context.action;
    if (action.payload.kind === 'offboarding_plan_create') {
      const sources = await resolveOffboardingSources(context, action.payload.caseId);
      const plan = await projected<OffboardingPlanBody>(context.projections, 'offboarding_plans', target.ref.id);
      const expectedAssignmentIds = action.expectedRows.filter(row => row.ref.table === 'asset_assignments').map(row => row.ref.id).sort();
      return digest(plan.body.employeeSnapshot) === digest(sources.employeeSnapshot) &&
        digest([...plan.body.assetAssignmentIds].sort()) === digest(expectedAssignmentIds) &&
        digest(sources.assetAssignmentIds) === digest(expectedAssignmentIds);
    }
    if (action.payload.kind === 'it_disable_request') {
      const planAction = await projected<PlannedActionBody>(context.projections, 'planned_actions',
        offboardingActionId(action.payload.planId, 'it_disable_request'));
      return planAction.body.status === 'requested' &&
        (expectedState(action, { table: 'planned_actions', id: planAction.id }) !== 'planned' || planAction.body.executionId === context.executionId);
    }
    if (action.payload.kind === 'asset_return_create') {
      const sources = await resolveOffboardingSources(context, action.payload.caseId, action.payload.planId);
      const assignmentId = (target.ref.table === 'asset_return_tasks'
        ? (await projected<Record<string, unknown> & { id: string }>(context.projections, 'asset_return_tasks', target.ref.id)).body.assignmentId
        : null);
      const planActionRef = { table: 'planned_actions' as const, id: offboardingActionId(action.payload.planId, 'asset_return') };
      const planAction = await projected<PlannedActionBody>(context.projections, 'planned_actions', planActionRef.id);
      const matchingInput = action.payload.targets.find(input => input.assetAssignmentId === assignmentId);
      const wasPlanned = expectedState(action, planActionRef) === 'planned';
      return !!matchingInput && sources.assetAssignmentIds.includes(matchingInput.assetAssignmentId) &&
        planAction.body.status === 'requested' &&
        (!wasPlanned || planAction.body.executionId === context.executionId);
    }
    if (action.payload.kind === 'contract_reminder_create') {
      const reminder = await projected<RowBody & { contractId: string; expiresAt: string }>(context.projections, 'contract_reminders', target.ref.id);
      const contract = await projected<EmploymentContractBody>(context.projections, 'employment_contracts', reminder.body.contractId);
      return contract.body.status === 'active' && contract.body.endDate === reminder.body.expiresAt &&
        dateFromTargetId('contract-reminder-target', target.targetId) === reminder.body.expiresAt;
    }
    if (action.payload.kind === 'policy_acknowledgement_assign') {
      const document = await projected<PolicyDocumentBody>(context.projections, 'policy_documents', action.payload.policyDocumentId);
      return document.body.version === action.payload.policyVersion;
    }
    if (action.payload.kind === 'onboarding_tasks_create') {
      const request = await projected<OnboardingRequestBody>(context.projections, 'onboarding_requests', action.payload.requestId);
      return request.body.state === 'onboarding_in_progress' && request.body.employeeId ===
        action.expectedRows.find(row => row.ref.table === 'employees')?.ref.id;
    }
    return false;
  } catch {
    return false;
  }
}

async function verifyHrOperation(context: VerifyFlowContext, committed: CommittedTarget[]): Promise<TargetProof[]> {
  const receiptRow = await context.projections.get('action_executions', context.executionId);
  invariant(receiptRow, 'WORKFLOW_CALLBACK_CONTRACT', 'The HR operation execution is unavailable for readback');
  const receipt = workflowReceiptV2Schema.parse(receiptRow.body);
  invariant(receipt.id === context.executionId && receipt.kind === context.action.payload.kind && receipt.actorId === context.action.actorId,
    'WORKFLOW_CALLBACK_CONTRACT', 'The HR operation execution attribution did not match');
  const plans = expectedPostconditionsFor(context.action, context.executionId, receipt.createdAt);
  const sourceStable = await sourceRowsStillMatch(context);
  const proofs: TargetProof[] = [];
  for (const target of committed) {
    let matches = sourceStable;
    try {
      const plan = plans.find(candidate => candidate.targetId === target.targetId);
      invariant(plan, 'WORKFLOW_CALLBACK_CONTRACT', 'The HR operation readback plan is missing');
      await checkPostconditions(context.projections, [plan]);
      const row = await context.projections.get<RowBody>(target.ref.table, target.ref.id);
      invariant(row && row.rowVersion === target.rowVersion && row.body.id === target.ref.id,
        'WORKFLOW_CALLBACK_CONTRACT', 'The HR operation effect version did not match');
      matches = matches && await extraReadback(context, target);
    } catch {
      matches = false;
    }
    proofs.push({
      targetId: target.targetId,
      ref: target.ref,
      outcome: matches ? 'verified_success' : 'pending',
      executionId: context.executionId,
      observedRowVersion: (await context.projections.get<RowBody>(target.ref.table, target.ref.id))?.rowVersion ?? null,
      checkedAt: context.now().toISOString(),
      mismatchCodes: matches ? [] : ['postcondition_mismatch'],
    });
  }
  return proofs;
}

function hrOperationBinding<K extends WorkflowActionKind>(input: {
  kind: K;
  permission: string;
  resolve(context: RuntimeReadContext, payload: Extract<WorkflowPayloadV2, { kind: K }>): Promise<ResolvedFlowTarget[]>;
  execute(context: AtomicFlowContext, payload: Extract<WorkflowPayloadV2, { kind: K }>): Promise<CommittedTarget[]>;
}): WorkflowRuntimeBinding {
  return defineWorkflowBinding<K>({
    kind: input.kind,
    contractVersion: 2,
    packIds: ['hr'],
    executionMode: 'atomic_local',
    authority: { permission: input.permission, roles: hrRoles, purpose: hrPurpose },
    identify: async (context, payload) => ({ targets: (await input.resolve(context, payload)).map(item => item.target) }),
    expectedPostconditions: expectedPostconditionsFor,
    validate: async (context, payload) => {
      const targets = await input.resolve(context, payload);
      return makeValidation(sortedSpecs(targets), targets.map(target => target.orgUnitId));
    },
    executeAtomic: input.execute,
    verify: verifyHrOperation,
    currentStates: currentStatesFor,
  });
}

function onboardingTasksBinding(): WorkflowRuntimeBinding {
  return hrOperationBinding({
    kind: 'onboarding_tasks_create', permission: 'hr.onboarding.tasks',
    resolve: resolveOnboardingTaskTargets, execute: executeOnboardingTasks,
  });
}

function offboardingPlanBinding(): WorkflowRuntimeBinding {
  return hrOperationBinding({
    kind: 'offboarding_plan_create', permission: 'hr.offboarding.plan',
    resolve: resolveOffboardingPlanTargets, execute: executeOffboardingPlan,
  });
}

function itDisableBinding(): WorkflowRuntimeBinding {
  return hrOperationBinding({
    kind: 'it_disable_request', permission: 'hr.it_disable.request',
    resolve: async (context, payload) => (await resolveItDisableTargets(context, payload)).targets,
    execute: executeItDisableRequest,
  });
}

function assetReturnBinding(): WorkflowRuntimeBinding {
  return hrOperationBinding({
    kind: 'asset_return_create', permission: 'hr.asset_return.create',
    resolve: async (context, payload) => (await resolveAssetReturnTargets(context, payload)).targets,
    execute: executeAssetReturn,
  });
}

function contractReminderBinding(): WorkflowRuntimeBinding {
  return hrOperationBinding({
    kind: 'contract_reminder_create', permission: 'hr.contract.reminder',
    resolve: resolveContractReminderTargets, execute: executeContractReminders,
  });
}

function policyAcknowledgementBinding(): WorkflowRuntimeBinding {
  return hrOperationBinding({
    kind: 'policy_acknowledgement_assign', permission: 'hr.policy.assign',
    resolve: resolvePolicyAcknowledgementTargets, execute: executePolicyAcknowledgements,
  });
}

export type HrOperationsWorkflowKind = Extract<WorkflowActionKind,
  | 'onboarding_tasks_create'
  | 'offboarding_plan_create'
  | 'it_disable_request'
  | 'asset_return_create'
  | 'badge_revoke'
  | 'contract_reminder_create'
  | 'policy_acknowledgement_assign'>;

export interface HrOperationsWorkflowAvailability {
  readonly kind: HrOperationsWorkflowKind;
  readonly available: boolean;
  readonly reason: string | null;
}

function computeHrOperationsWorkflowAvailability(): readonly HrOperationsWorkflowAvailability[] {
  const persistedFields = (table: Ref['table']): Set<string> => {
    const shape = Reflect.get(getWorkflowProjection(table).bodySchema, 'shape');
    return new Set(shape && typeof shape === 'object' ? Object.keys(shape) : []);
  };
  const missing = (table: Ref['table'], fields: string[]): string[] => {
    const supported = persistedFields(table);
    return fields.filter(field => !supported.has(field));
  };
  const gap = (table: Ref['table'], fields: string[]): string => {
    const absent = missing(table, fields);
    return absent.length ? table + ' does not persist/read back ' + absent.join(', ') : '';
  };

  const planGap = [
    gap('offboarding_plans', ['employeeSnapshot', 'assetAssignmentIds', 'executionId']),
    gap('planned_actions', ['description', 'executionId']),
  ].filter(Boolean).join('; ');
  const assetPlanGap = gap('offboarding_plans', ['employeeSnapshot', 'assetAssignmentIds', 'executionId']);
  const onboardingGap = gap('onboarding_tasks', ['reason', 'priority', 'executionId']);
  const itDisableGap = gap('it_disable_requests', ['effectiveDate', 'reason', 'executionId']);
  const assetReturnGap = [gap('asset_return_tasks', ['priority', 'reason', 'dueDate', 'ownerIdentityId', 'executionId']), assetPlanGap]
    .filter(Boolean).join('; ');
  const contractGap = gap('contract_reminders', ['ownerIdentityId', 'reason', 'dueDate', 'priority', 'executionId', 'expiresAt']);
  const policyAckGap = gap('policy_acknowledgement_tasks', ['ownerIdentityId', 'reason', 'dueDate', 'priority', 'executionId']);

  const describe = (kind: HrOperationsWorkflowKind, reason: string): HrOperationsWorkflowAvailability => ({
    kind,
    available: reason.length === 0,
    reason: reason.length === 0 ? null : reason,
  });
  return Object.freeze([
    describe('onboarding_tasks_create', onboardingGap),
    describe('offboarding_plan_create', planGap),
    describe('it_disable_request', itDisableGap),
    describe('asset_return_create', assetReturnGap),
    describe('badge_revoke', ''),
    describe('contract_reminder_create', contractGap),
    describe('policy_acknowledgement_assign', policyAckGap),
  ]);
}

const hrOperationsWorkflowAvailability = computeHrOperationsWorkflowAvailability();

/** Exposes the same projection readiness decisions used to choose runtime bindings. */
export function getHrOperationsWorkflowAvailability(): readonly HrOperationsWorkflowAvailability[] {
  return hrOperationsWorkflowAvailability;
}

/** Keep actions unavailable until their strict readback schemas expose every reviewed field. */
export function createHrOperationsWorkflowBindings(): readonly WorkflowRuntimeBinding[] {
  const bindingWhenAvailable = (
    kind: HrOperationsWorkflowKind,
    permission: string,
    create: () => WorkflowRuntimeBinding,
  ): WorkflowRuntimeBinding => {
    const readiness = hrOperationsWorkflowAvailability.find(item => item.kind === kind);
    invariant(readiness, 'WORKFLOW_INVALID_BINDING', 'HR workflow availability metadata is incomplete');
    if (readiness.available) {
      invariant(readiness.reason === null, 'WORKFLOW_INVALID_BINDING', 'Available HR workflow metadata has a blocker reason');
      return create();
    }
    invariant(readiness.reason !== null, 'WORKFLOW_INVALID_BINDING', 'Unavailable HR workflow metadata lacks a blocker reason');
    return blockedBinding(kind, permission, readiness.reason);
  };

  return Object.freeze([
    bindingWhenAvailable('onboarding_tasks_create', 'hr.onboarding.tasks', onboardingTasksBinding),
    bindingWhenAvailable('offboarding_plan_create', 'hr.offboarding.plan', offboardingPlanBinding),
    bindingWhenAvailable('it_disable_request', 'hr.it_disable.request', itDisableBinding),
    bindingWhenAvailable('asset_return_create', 'hr.asset_return.create', assetReturnBinding),
    bindingWhenAvailable('badge_revoke', 'badge.revoke', badgeRevocationBinding),
    bindingWhenAvailable('contract_reminder_create', 'hr.contract.reminder', contractReminderBinding),
    bindingWhenAvailable('policy_acknowledgement_assign', 'hr.policy.assign', policyAcknowledgementBinding),
  ]);
}
