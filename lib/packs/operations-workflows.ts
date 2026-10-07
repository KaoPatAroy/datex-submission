import { invariant } from '../core/errors';
import { digest } from '../core/utils';
import type { ProjectedRow, WorkflowStorageQuery } from '../storage/workflow-projections';
import { checkPostconditions, type ExpectedPostcondition, type ExpectedField } from '../workflows/action-results';
import {
  defineWorkflowBinding,
  mergeExpectedRows,
  workflowRowState,
  type RuntimeReadContext,
  type SemanticTarget,
  type WorkflowRuntimeBinding,
} from '../workflows/action-runtime';
import {
  directoryIdentitySchema,
  instantSchema,
  isoDateSchema,
  responsibilitySchema,
  type CommittedTarget,
  type CurrentState,
  type ExpectedRow,
  type Instant,
  type PendingActionV2,
  type Ref,
  type TargetProof,
  type WorkflowActionKind,
  type WorkflowPayloadV2,
  type WorkflowValidation,
  type GuardedTransaction,
} from '../workflows/contracts';
import {
  demoWorkflowPolicyV1,
  getBangkokCalendarDate,
  getDemoWorkflowPolicyV1Pin,
  isConfiguredClosedBusinessDate,
  getTaskDueDate,
} from '../workflows/policy';
import { incidentSchema, inventorySchema, sourceRefSchema } from './shared';

type InvestigationPayload = Extract<WorkflowPayloadV2, { kind: 'investigation_create' }>;
type RestockPayload = Extract<WorkflowPayloadV2, { kind: 'restock_create' }>;
type EscalationPayload = Extract<WorkflowPayloadV2, { kind: 'incident_escalate' }>;
type BranchReviewPayload = Extract<WorkflowPayloadV2, { kind: 'branch_review_assign' }>;
type Body = Record<string, unknown> & { id: string };
type ScopedQuery = Extract<WorkflowStorageQuery, { kind: 'scoped' }> & {
  equals?: Readonly<Record<string, string | number | boolean | null>>;
};

const MAX_SCOPED_HISTORY_ROWS = 500;
const QUERY_PAGE_SIZE = 100;
const operationsAndSalesPacks = ['operations', 'sales'];
const operationsPack = ['operations'];
const evidenceSourceTables: Readonly<Record<string, Ref['table']>> = Object.freeze({
  sales: 'sales_orders',
  targets: 'sales_targets',
  inventory: 'inventory_snapshots',
  incidents: 'incidents',
  staffing: 'staffing_summaries',
});

interface BranchAuthorityRows {
  branchRow: ProjectedRow<Body>;
  branchId: string;
  region: string;
  orgUnitId: string;
  orgUnitRow: ProjectedRow<Body>;
  responsibilityRow: RuntimeReadContext['principal']['responsibilities'][number];
}

interface OwnerAuthorityRows {
  identityId: string;
  identityRow: ProjectedRow<Body>;
  responsibilityRows: ProjectedRow<Body>[];
}

interface EvidenceRows {
  expectedRows: ExpectedRow[];
}

type OperationsReadbackStatus = 'fresh' | 'authority_stale' | 'evidence_stale';

interface ResolvedTarget {
  semantic: SemanticTarget;
  expectedEffectRef: Ref;
  expectedRows: ExpectedRow[];
  branch: BranchAuthorityRows;
}

function objectBody<T extends Body>(row: ProjectedRow<T> | undefined, table: Ref['table'], id: string): ProjectedRow<T> {
  invariant(row && row.id === id && row.body.id === id && Number.isSafeInteger(row.rowVersion) && row.rowVersion > 0,
    'WORKFLOW_STALE', `The selected ${table} record is unavailable or inconsistent`, 409);
  return row;
}

function asString(value: unknown, code: string, message: string): string {
  invariant(typeof value === 'string' && value.length > 0, code, message, code === 'WORKFLOW_STALE' ? 409 : 400);
  return value;
}

function stableTargetId(kind: WorkflowActionKind, businessKey: unknown): string {
  return `target_${digest({ purpose: 'nexus/workflow-target/v2', kind, businessKey })}`;
}

function semanticKey(kind: WorkflowActionKind, businessKey: unknown): string {
  return digest({ purpose: 'nexus/workflow-semantic-target/v2', kind, businessKey });
}

function effectRef(table: Ref['table'], semantic: string): Ref {
  const prefixes: Partial<Record<Ref['table'], string>> = {
    investigation_tasks: 'investigation_task',
    restock_requests: 'restock',
    incident_escalation_events: 'incident_escalation',
    branch_review_assignments: 'branch_review',
  };
  const prefix = prefixes[table];
  invariant(prefix, 'WORKFLOW_INVALID_BINDING', 'The operations effect table is unsupported');
  return { table, id: `${prefix}_${semantic}` };
}

function expectedRow(table: Ref['table'], row: { readonly id: string; readonly rowVersion: number; readonly body: unknown }): ExpectedRow {
  return { ref: { table, id: row.id }, rowVersion: row.rowVersion, state: workflowRowState(table, row.body) };
}

function field(path: string, expected: unknown): ExpectedField {
  return { path, expected };
}

function targetForSource(
  action: PendingActionV2,
  table: Ref['table'],
  id: string,
) {
  const matches = action.targets.filter(target => target.expectedRows.some(row => row.ref.table === table && row.ref.id === id));
  invariant(matches.length === 1, 'WORKFLOW_CALLBACK_CONTRACT', 'The frozen action does not bind one exact source target');
  const target = matches[0];
  const sourceGuards = target.expectedRows.filter(row => row.ref.table === table && row.ref.id === id);
  invariant(target.ref.table === table && target.ref.id === id && sourceGuards.length === 1,
    'WORKFLOW_CALLBACK_CONTRACT', 'The frozen target reference does not identify its exact persisted source');
  return target;
}

async function readScopedRows<T extends Body>(
  context: RuntimeReadContext,
  query: Omit<ScopedQuery, 'kind' | 'cursor' | 'limit'>,
): Promise<ProjectedRow<T>[]> {
  const result: ProjectedRow<T>[] = [];
  let cursor: string | undefined;
  while (true) {
    const page = await context.projections.query<T>({
      ...query,
      kind: 'scoped',
      limit: QUERY_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    } as WorkflowStorageQuery);
    result.push(...page);
    invariant(result.length <= MAX_SCOPED_HISTORY_ROWS,
      'WORKFLOW_STALE', 'The scoped history exceeds the bounded lifecycle review', 409);
    if (page.length < QUERY_PAGE_SIZE) return result;
    const nextCursor = page.at(-1)?.id;
    invariant(nextCursor && nextCursor !== cursor, 'WORKFLOW_CALLBACK_CONTRACT', 'The scoped query cursor did not advance');
    cursor = nextCursor;
  }
}

async function loadBranchAuthority(context: RuntimeReadContext, branchId: string): Promise<BranchAuthorityRows> {
  const branchRow = objectBody(await context.projections.get<Body>('branches', branchId), 'branches', branchId);
  const region = asString(branchRow.body.region, 'WORKFLOW_STALE', 'The selected branch has no current region');
  invariant(branchRow.body.active !== false, 'WORKFLOW_SCOPE_DENIED', 'The selected branch is inactive', 403);

  const explicitOrgUnit = branchRow.body.orgUnitId;
  const orgUnitId = explicitOrgUnit === undefined || explicitOrgUnit === null
    ? undefined
    : asString(explicitOrgUnit, 'WORKFLOW_STALE', 'The selected branch organization link is invalid');
  const principalIdentityId = context.principal.directory.body.id;
  const matchingResponsibilities = context.principal.responsibilities.filter(row => {
    const parsed = responsibilitySchema.safeParse(row.body);
    return parsed.success && parsed.data.id === row.id && parsed.data.rowVersion === row.rowVersion &&
      parsed.data.identityId === principalIdentityId && parsed.data.active &&
      parsed.data.purpose === 'sales_operations' && parsed.data.branchIds.includes(branchId) &&
      (orgUnitId === undefined || parsed.data.orgUnitId === orgUnitId);
  });
  invariant(matchingResponsibilities.length === 1,
    'WORKFLOW_SCOPE_DENIED', 'The authenticated operations principal must have exactly one active responsibility for the target branch and organization', 403);
  const responsibilityRow = matchingResponsibilities[0];
  const resolvedOrgUnitId = orgUnitId ?? responsibilityRow.body.orgUnitId;
  const orgUnitRow = objectBody(await context.projections.get<Body>('org_units', resolvedOrgUnitId), 'org_units', resolvedOrgUnitId);
  invariant(orgUnitRow.body.active === true, 'WORKFLOW_SCOPE_DENIED', 'The selected branch organization unit is inactive', 403);
  return { branchRow, branchId, region, orgUnitId: resolvedOrgUnitId, orgUnitRow, responsibilityRow };
}

async function loadOwnerAuthority(
  context: RuntimeReadContext,
  ownerIdentityId: string,
  branch: BranchAuthorityRows,
): Promise<OwnerAuthorityRows> {
  const identityRow = objectBody(
    await context.projections.get<Body>('directory_identities', ownerIdentityId),
    'directory_identities',
    ownerIdentityId,
  );
  const identity = directoryIdentitySchema.safeParse(identityRow.body);
  invariant(identity.success && identity.data.rowVersion === identityRow.rowVersion,
    'WORKFLOW_AUTHORITY_INVALID', 'The selected owner identity is inconsistent', 409);
  invariant(identity.data.active && identity.data.department === 'sales_operations',
    'WORKFLOW_SCOPE_DENIED', 'The selected owner is not an active operations identity', 403);
  invariant(identity.data.orgUnitId === branch.orgUnitId,
    'WORKFLOW_SCOPE_DENIED', 'The selected owner is not in the target branch organization unit', 403);

  const responsibilityRows = await readScopedRows<Body>(context, {
    table: 'responsibilities',
    ownerId: ownerIdentityId,
    orgUnitId: branch.orgUnitId,
    branchIds: [branch.branchId],
    status: 'active',
  });
  const matches = responsibilityRows.filter(row => {
    const parsed = responsibilitySchema.safeParse(row.body);
    return parsed.success && parsed.data.rowVersion === row.rowVersion && parsed.data.active &&
      parsed.data.identityId === ownerIdentityId && parsed.data.orgUnitId === branch.orgUnitId &&
      parsed.data.purpose === 'sales_operations' && parsed.data.branchIds.includes(branch.branchId);
  });
  invariant(matches.length > 0,
    'WORKFLOW_SCOPE_DENIED', 'The selected owner has no current active responsibility for the target branch', 403);
  return { identityId: ownerIdentityId, identityRow, responsibilityRows: matches };
}

function authorityExpectedRows(branch: BranchAuthorityRows, owner?: OwnerAuthorityRows): ExpectedRow[] {
  const rows = [
    expectedRow('branches', branch.branchRow),
    expectedRow('org_units', branch.orgUnitRow),
    expectedRow('responsibilities', branch.responsibilityRow),
    ...(owner ? [expectedRow('directory_identities', owner.identityRow)] : []),
    ...(owner ? owner.responsibilityRows.map(row => expectedRow('responsibilities', row)) : []),
  ];
  return mergeExpectedRows(rows);
}

function taskDateMatches(context: RuntimeReadContext, dueDate: string, priority: 'normal' | 'high'): boolean {
  return dueDate === getTaskDueDate(context.now(), priority);
}

async function loadCase(
  context: RuntimeReadContext,
  branchId: string,
  caseId: string,
  businessDate: string,
): Promise<{ caseRow: ProjectedRow<Body>; branch: BranchAuthorityRows; lifecycleId: string }> {
  const branch = await loadBranchAuthority(context, branchId);
  const caseRow = objectBody(await context.projections.get<Body>('investigation_cases', caseId), 'investigation_cases', caseId);
  const body = caseRow.body;
  invariant(body.branchId === branchId && body.businessDate === businessDate,
    'WORKFLOW_SCOPE_DENIED', 'The persisted case does not match the requested branch and business date', 403);
  const lifecycleId = asString(body.lifecycleId, 'WORKFLOW_STALE', 'The persisted case has no provable lifecycle identity');
  return { caseRow, branch, lifecycleId };
}

function persistedCaseSourceIds(caseRow: ProjectedRow<Body>): string[] {
  const rawSourceIds = caseRow.body.sourceIds;
  invariant(Array.isArray(rawSourceIds),
    'WORKFLOW_STALE', 'The persisted case has no current evidence references', 409);
  const sourceIds = rawSourceIds.filter((sourceId): sourceId is string =>
    typeof sourceId === 'string' && sourceId.length > 0);
  invariant(sourceIds.length === rawSourceIds.length && sourceIds.length > 0,
    'WORKFLOW_STALE', 'The persisted case has no current evidence references', 409);
  return sourceIds;
}

async function readBranchEvidence(
  context: RuntimeReadContext,
  branch: BranchAuthorityRows,
  businessDate: string,
  requestedSourceIds: readonly string[],
): Promise<EvidenceRows> {
  const evidence = await context.evidence({ region: branch.region, date: businessDate, branchIds: [branch.branchId] });
  invariant(evidence.scope.date === businessDate && evidence.scope.branchIds?.length === 1 &&
    evidence.scope.branchIds[0] === branch.branchId && evidence.branches.length === 1 &&
    evidence.branches[0].branchId === branch.branchId,
  'WORKFLOW_SCOPE_DENIED', 'The current evidence does not cover the exact requested branch and date', 403);
  const branchEvidence = evidence.branches[0];
  const sourceById = new Map(evidence.sources.map(source => [source.id, sourceRefSchema.parse(source)]));
  const allowedIds = new Set(branchEvidence.sourceIds);
  const now = context.now().getTime();
  invariant(requestedSourceIds.length > 0 && requestedSourceIds.every(sourceId => allowedIds.has(sourceId)),
    'WORKFLOW_INVALID_INPUT', 'Every requested evidence reference must belong to the selected branch');

  const selectedSources = requestedSourceIds.map(sourceId => {
    const source = sourceById.get(sourceId);
    invariant(source && source.freshness === 'fresh' && source.observedAt !== '' && Date.parse(source.observedAt) <= now,
      'WORKFLOW_STALE', 'Every selected evidence source must be current and fresh', 409);
    return source;
  });
  const guarded = new Map<string, ExpectedRow>();
  for (const source of selectedSources) {
    const table = evidenceSourceTables[source.system];
    invariant(table, 'WORKFLOW_INVALID_INPUT', 'The evidence source system is not supported for this operation');
    const rows = await readScopedRows<Body>(context, {
      table,
      branchIds: [branch.branchId],
      fromDate: businessDate,
      throughDate: businessDate,
    });
    const exactRows = rows.filter(row => row.body.branchId === branch.branchId && row.body.date === businessDate);
    invariant(exactRows.length > 0, 'WORKFLOW_STALE', 'A selected evidence source has no current backing rows', 409);
    for (const row of exactRows) guarded.set(digest({ table, id: row.id }), expectedRow(table, row));
  }
  return { expectedRows: mergeExpectedRows([...guarded.values()]) };
}

async function semanticEffect(
  context: RuntimeReadContext,
  key: string,
): Promise<ProjectedRow<Body> | undefined> {
  const rows = await context.projections.query<Body>({
    kind: 'unique',
    table: 'semantic_effects',
    constraint: 'semantic_effects_key_unique',
    values: { semanticKey: key },
  });
  invariant(rows.length <= 1, 'WORKFLOW_STALE', 'A semantic reservation is ambiguous', 409);
  return rows[0];
}

async function establishedEffectRef(
  context: RuntimeReadContext,
  key: string,
  expectedTable: Ref['table'],
  isCompatible: (body: Body) => boolean = () => true,
): Promise<Ref | undefined> {
  const reservation = await semanticEffect(context, key);
  if (!reservation) return undefined;
  const body = reservation.body;
  invariant(body.semanticKey === key && body.status === 'committed' && body.effectType === expectedTable,
    'WORKFLOW_STALE', 'The existing semantic reservation is not a compatible committed effect', 409);
  const id = asString(body.effectId, 'WORKFLOW_STALE', 'The existing semantic reservation has no effect reference');
  const effect = await context.projections.get<Body>(expectedTable, id);
  invariant(effect && effect.id === id && effect.body.id === id && effect.body.executionId === body.executionId,
    'WORKFLOW_STALE', 'The existing semantic effect cannot be established', 409);
  invariant(isCompatible(effect.body), 'WORKFLOW_STALE', 'The existing effect does not match the selected business target', 409);
  return { table: expectedTable, id };
}

async function assertNoUnreservedCaseEffect(
  context: RuntimeReadContext,
  table: 'investigation_tasks' | 'branch_review_assignments',
  branchId: string,
  caseId: string,
): Promise<void> {
  const rows = await readScopedRows<Body>(context, { table, branchIds: [branchId], equals: { caseId } });
  const matching = rows.filter(row => row.body.caseId === caseId);
  invariant(matching.length === 0,
    'WORKFLOW_STALE', 'A persisted case effect without a matching semantic reservation cannot be safely reused', 409);
}

async function resolveInvestigationTargets(
  context: RuntimeReadContext,
  payload: InvestigationPayload,
): Promise<ResolvedTarget[]> {
  const resolved: ResolvedTarget[] = [];
  for (const target of payload.targets) {
    const { caseRow, branch, lifecycleId } = await loadCase(context, target.branchId, target.caseId, payload.businessDate);
    const key = semanticKey('investigation_create', {
      branchId: target.branchId,
      businessDate: payload.businessDate,
      caseId: target.caseId,
      lifecycleId,
      taskPurpose: 'investigation_task',
    });
    const existing = await establishedEffectRef(context, key, 'investigation_tasks', body =>
      body.caseId === target.caseId && body.branchId === target.branchId);
    if (!existing) await assertNoUnreservedCaseEffect(context, 'investigation_tasks', target.branchId, target.caseId);
    const expectedEffectRef = existing ?? effectRef('investigation_tasks', key);
    resolved.push({
      semantic: { targetId: stableTargetId('investigation_create', [target.branchId, payload.businessDate, target.caseId]),
        ref: { table: 'investigation_cases', id: target.caseId },
        semanticKey: key, scope: { branchId: target.branchId, orgUnitId: branch.orgUnitId } },
      expectedEffectRef,
      expectedRows: mergeExpectedRows([expectedRow('investigation_cases', caseRow), ...authorityExpectedRows(branch)]),
      branch,
    });
  }
  invariant(resolved.length === payload.targets.length, 'WORKFLOW_CALLBACK_CONTRACT', 'An investigation target was omitted');
  return resolved;
}

interface RestockLifecycle {
  lifecycleId: string;
  historyRows: ProjectedRow<Body>[];
  openRow?: ProjectedRow<Body>;
}

async function loadRestockLifecycle(
  context: RuntimeReadContext,
  branchId: string,
  productId: string,
): Promise<RestockLifecycle> {
  const openRows = await context.projections.query<Body>({
    kind: 'unique',
    table: 'restock_requests',
    constraint: 'restock_requests_open_product_unique',
    values: { branchId, productId },
  });
  invariant(openRows.length <= 1, 'WORKFLOW_STALE', 'More than one open restock lifecycle exists for this branch and product', 409);
  const openRow = openRows[0];
  if (openRow) {
    invariant(openRow.body.branchId === branchId && openRow.body.productId === productId &&
      (openRow.body.status === 'open' || openRow.body.status === 'approved'),
    'WORKFLOW_STALE', 'The existing open restock lifecycle is inconsistent', 409);
    const lifecycleId = asString(openRow.body.replenishmentLifecycleId, 'WORKFLOW_STALE', 'The open restock lifecycle identity is missing');
    instantSchema.parse(openRow.body.createdAt);
    return { lifecycleId, historyRows: [openRow], openRow };
  }

  const branchRows = await readScopedRows<Body>(context, {
    table: 'restock_requests',
    branchIds: [branchId],
    equals: { productId },
  });
  const historyRows = branchRows.filter(row => row.body.productId === productId);
  const closed = historyRows.map(row => {
    const body = row.body;
    invariant(body.branchId === branchId && body.productId === productId,
      'WORKFLOW_STALE', 'A restock history row has inconsistent business identity', 409);
    invariant(body.status === 'completed' || body.status === 'cancelled',
      'WORKFLOW_STALE', 'A legacy restock lifecycle cannot be proven closed', 409);
    const lifecycleId = asString(body.replenishmentLifecycleId, 'WORKFLOW_STALE', 'A closed restock lifecycle identity is missing');
    const createdAt = instantSchema.parse(body.createdAt);
    return { id: row.id, lifecycleId, createdAt, row };
  }).sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id));
  const predecessor = closed.at(-1);
  const lifecycleId = `replenishment_${digest({
    purpose: 'nexus/restock-lifecycle/v1',
    branchId,
    productId,
    predecessor: predecessor ? { id: predecessor.id, lifecycleId: predecessor.lifecycleId } : null,
  })}`;
  return { lifecycleId, historyRows: predecessor ? [predecessor.row] : [] };
}

async function currentInventorySnapshots(
  context: RuntimeReadContext,
  branchId: string,
  productId: string,
): Promise<Array<{ row: ProjectedRow<Body>; inventory: ReturnType<typeof inventorySchema.parse> }>> {
  const rows = await readScopedRows<Body>(context, {
    table: 'inventory_snapshots',
    branchIds: [branchId],
    throughDate: getBangkokCalendarDate(context.now()),
    equals: { productId },
  });
  return rows
    .filter(row => row.body.branchId === branchId && row.body.productId === productId)
    .map(row => ({
      row,
      inventory: inventorySchema.parse(Object.fromEntries(Object.entries(row.body).filter(([key]) => key !== 'rowVersion'))),
    }));
}

function latestInventorySnapshot(
  snapshots: Array<{ row: ProjectedRow<Body>; inventory: ReturnType<typeof inventorySchema.parse> }>,
): ProjectedRow<Body> {
  invariant(snapshots.length > 0, 'WORKFLOW_STALE', 'No current scoped inventory snapshot exists for the selected product', 409);
  const newestDate = snapshots.reduce((latest, item) => item.inventory.date > latest ? item.inventory.date : latest, '');
  const newestObservation = snapshots
    .filter(item => item.inventory.date === newestDate)
    .reduce((latest, item) => {
      const observedAt = Date.parse(item.inventory.observedAt);
      return observedAt > latest ? observedAt : latest;
    }, Number.NEGATIVE_INFINITY);
  const newest = snapshots.filter(item => item.inventory.date === newestDate && Date.parse(item.inventory.observedAt) === newestObservation);
  invariant(newest.length === 1, 'WORKFLOW_STALE', 'The current inventory snapshot is ambiguous', 409);
  return newest[0].row;
}

async function resolveRestockTargets(
  context: RuntimeReadContext,
  payload: RestockPayload,
): Promise<Array<ResolvedTarget & { inventoryRow: ProjectedRow<Body>; inventory: ReturnType<typeof inventorySchema.parse>; lifecycleId: string }>> {
  const resolved = [] as Array<ResolvedTarget & { inventoryRow: ProjectedRow<Body>; inventory: ReturnType<typeof inventorySchema.parse>; lifecycleId: string }>;
  for (const target of payload.targets) {
    const branch = await loadBranchAuthority(context, target.branchId);
    const inventoryRow = objectBody(await context.projections.get<Body>('inventory_snapshots', target.inventorySnapshotId),
      'inventory_snapshots', target.inventorySnapshotId);
    const inventory = inventorySchema.parse(Object.fromEntries(Object.entries(inventoryRow.body).filter(([key]) => key !== 'rowVersion')));
    invariant(inventory.branchId === target.branchId && inventory.productId === target.productId,
      'WORKFLOW_SCOPE_DENIED', 'The inventory snapshot does not match the requested branch and product', 403);
    const currentSnapshots = await currentInventorySnapshots(context, target.branchId, target.productId);
    invariant(latestInventorySnapshot(currentSnapshots).id === inventoryRow.id,
      'WORKFLOW_STALE', 'The selected inventory snapshot is not the current scoped stock evidence', 409);
    const productRow = objectBody(await context.projections.get<Body>('products', target.productId), 'products', target.productId);
    invariant(productRow.body.active !== false, 'WORKFLOW_SCOPE_DENIED', 'The requested product is inactive', 403);
    const lifecycle = await loadRestockLifecycle(context, target.branchId, target.productId);
    const key = semanticKey('restock_create', {
      branchId: target.branchId,
      productId: target.productId,
      replenishmentLifecycleId: lifecycle.lifecycleId,
    });
    const established = await establishedEffectRef(context, key, 'restock_requests', body =>
      body.branchId === target.branchId && body.productId === target.productId && body.replenishmentLifecycleId === lifecycle.lifecycleId);
    if (lifecycle.openRow) {
      invariant(established && established.id === lifecycle.openRow.id,
        'WORKFLOW_STALE', 'An open legacy restock match has no provable semantic reservation', 409);
    }
    const expectedEffectRef = established ?? effectRef('restock_requests', key);
    const historyGuards = lifecycle.historyRows.map(row => expectedRow('restock_requests', row));
    resolved.push({
      semantic: { targetId: `restock_${lifecycle.lifecycleId}`, ref: { table: 'inventory_snapshots', id: inventoryRow.id }, semanticKey: key,
        scope: { branchId: target.branchId, orgUnitId: branch.orgUnitId } },
      expectedEffectRef,
      expectedRows: mergeExpectedRows([expectedRow('inventory_snapshots', inventoryRow), expectedRow('products', productRow),
        ...authorityExpectedRows(branch), ...historyGuards]),
      branch,
      inventoryRow,
      inventory,
      lifecycleId: lifecycle.lifecycleId,
    });
  }
  invariant(resolved.length === payload.targets.length, 'WORKFLOW_CALLBACK_CONTRACT', 'A restock target was omitted');
  return resolved;
}

interface IncidentEscalationState {
  stage: string;
  lifecycleId: string;
  eventId: string | null;
}

function incidentEscalationState(row: ProjectedRow<Body>): IncidentEscalationState {
  const stage = asString(row.body.escalationStage, 'WORKFLOW_STALE', 'The incident has no persisted escalation stage');
  invariant(stage === demoWorkflowPolicyV1.incident.from || stage === demoWorkflowPolicyV1.incident.to,
    'WORKFLOW_STALE', 'The incident escalation stage is outside the current policy lifecycle', 409);
  const lifecycleId = asString(row.body.escalationLifecycleId,
    'WORKFLOW_STALE', 'The incident has no persisted escalation lifecycle identity');
  const rawEventId = row.body.escalationEventId;
  invariant(rawEventId === undefined || rawEventId === null || (typeof rawEventId === 'string' && rawEventId.length > 0),
    'WORKFLOW_STALE', 'The incident escalation event pointer is invalid', 409);
  const eventId = typeof rawEventId === 'string' ? rawEventId : null;
  invariant(stage === demoWorkflowPolicyV1.incident.from ? eventId === null : eventId !== null,
    'WORKFLOW_STALE', 'The incident escalation stage and event pointer are inconsistent', 409);
  return { stage, lifecycleId, eventId };
}

function parseIncident(row: ProjectedRow<Body>): ReturnType<typeof incidentSchema.parse> {
  const body = Object.fromEntries(Object.entries(row.body).filter(([key]) =>
    key !== 'rowVersion' && key !== 'escalationStage' && key !== 'escalationLifecycleId' && key !== 'escalationEventId'));
  return incidentSchema.parse(body);
}

async function resolveIncidentTargets(
  context: RuntimeReadContext,
  payload: EscalationPayload,
): Promise<Array<ResolvedTarget & { incidentRow: ProjectedRow<Body>; incident: ReturnType<typeof incidentSchema.parse>; escalation: IncidentEscalationState; teamRow: ProjectedRow<Body> }>> {
  const resolved = [] as Array<ResolvedTarget & { incidentRow: ProjectedRow<Body>; incident: ReturnType<typeof incidentSchema.parse>; escalation: IncidentEscalationState; teamRow: ProjectedRow<Body> }>;
  for (const target of payload.targets) {
    const incidentRow = objectBody(await context.projections.get<Body>('incidents', target.incidentId), 'incidents', target.incidentId);
    const incident = parseIncident(incidentRow);
    const escalation = incidentEscalationState(incidentRow);
    const branch = await loadBranchAuthority(context, incident.branchId);
    const teamRow = objectBody(await context.projections.get<Body>('workflow_teams', target.targetTeamId), 'workflow_teams', target.targetTeamId);
    invariant(target.targetTeamId === demoWorkflowPolicyV1.incident.targetTeam,
      'WORKFLOW_INVALID_INPUT', 'The requested escalation team differs from current policy');
    const lifecycleId = escalation.lifecycleId;
    const key = semanticKey('incident_escalate', { incidentId: incident.id, lifecycleId, desiredStage: demoWorkflowPolicyV1.incident.to });
    const priorEvents = await context.projections.query<Body>({
      kind: 'unique',
      table: 'incident_escalation_events',
      constraint: 'incident_escalation_lifecycle_stage_unique',
      values: { incidentId: incident.id, lifecycleId, stage: demoWorkflowPolicyV1.incident.to },
    });
    invariant(priorEvents.length <= 1, 'WORKFLOW_STALE', 'The incident escalation stage is ambiguous', 409);
    const established = await establishedEffectRef(context, key, 'incident_escalation_events', body =>
      body.incidentId === incident.id && body.lifecycleId === lifecycleId && body.stage === demoWorkflowPolicyV1.incident.to &&
      body.teamId === target.targetTeamId);
    if (escalation.stage === demoWorkflowPolicyV1.incident.from) {
      invariant(priorEvents.length === 0 && !established,
        'WORKFLOW_STALE', 'An un-escalated incident already has an escalation event', 409);
    } else {
      invariant(escalation.eventId !== null && priorEvents.length === 1 && priorEvents[0].id === escalation.eventId &&
        established?.id === escalation.eventId,
      'WORKFLOW_STALE', 'The incident escalation pointer has no matching committed event', 409);
    }
    const expectedEffectRef = established ?? effectRef('incident_escalation_events', key);
    resolved.push({
      semantic: { targetId: stableTargetId('incident_escalate', incident.id),
        ref: { table: 'incidents', id: incident.id }, semanticKey: key,
        scope: { branchId: incident.branchId, orgUnitId: branch.orgUnitId } },
      expectedEffectRef,
      expectedRows: mergeExpectedRows([expectedRow('incidents', incidentRow), expectedRow('workflow_teams', teamRow),
        ...authorityExpectedRows(branch)]),
      branch,
      incidentRow,
      incident,
      escalation,
      teamRow,
    });
  }
  invariant(resolved.length === payload.targets.length, 'WORKFLOW_CALLBACK_CONTRACT', 'An incident target was omitted');
  return resolved;
}

async function resolveBranchReviewTargets(
  context: RuntimeReadContext,
  payload: BranchReviewPayload,
): Promise<Array<ResolvedTarget & { caseRow: ProjectedRow<Body>; lifecycleId: string }>> {
  const resolved = [] as Array<ResolvedTarget & { caseRow: ProjectedRow<Body>; lifecycleId: string }>;
  for (const target of payload.targets) {
    const { caseRow, branch, lifecycleId } = await loadCase(context, target.branchId, target.caseId, payload.businessDate);
    const key = semanticKey('branch_review_assign', {
      branchId: target.branchId,
      businessDate: payload.businessDate,
      caseId: target.caseId,
      lifecycleId,
      taskPurpose: 'branch_review',
    });
    const established = await establishedEffectRef(context, key, 'branch_review_assignments', body =>
      body.caseId === target.caseId && body.branchId === target.branchId);
    if (!established) await assertNoUnreservedCaseEffect(context, 'branch_review_assignments', target.branchId, target.caseId);
    const expectedEffectRef = established ?? effectRef('branch_review_assignments', key);
    resolved.push({
      semantic: { targetId: stableTargetId('branch_review_assign', [target.branchId, payload.businessDate, target.caseId]),
        ref: { table: 'investigation_cases', id: target.caseId },
        semanticKey: key, scope: { branchId: target.branchId, orgUnitId: branch.orgUnitId } },
      expectedEffectRef,
      expectedRows: mergeExpectedRows([expectedRow('investigation_cases', caseRow), ...authorityExpectedRows(branch)]),
      branch,
      caseRow,
      lifecycleId,
    });
  }
  invariant(resolved.length === payload.targets.length, 'WORKFLOW_CALLBACK_CONTRACT', 'A branch review target was omitted');
  return resolved;
}

function validation(
  targets: Array<{ semantic: SemanticTarget; expectedEffectRef: Ref; expectedRows: ExpectedRow[]; ownerIdentityId?: string | null }>,
  policy = getDemoWorkflowPolicyV1Pin(),
) {
  const expectedRows = mergeExpectedRows(...targets.map(target => target.expectedRows));
  const approvedBranchIds = [...new Set(targets.flatMap(target => target.semantic.scope.branchId ? [target.semantic.scope.branchId] : []))].sort();
  const approvedOrgUnitIds = [...new Set(targets.flatMap(target => target.semantic.scope.orgUnitId ? [target.semantic.scope.orgUnitId] : []))].sort();
  return {
    targets: targets.map(target => ({ targetId: target.semantic.targetId, ref: target.semantic.ref,
      semanticKey: target.semantic.semanticKey, expectedRows: target.expectedRows, ownerIdentityId: target.ownerIdentityId ?? null,
      expectedEffectRef: target.expectedEffectRef, expectedEffectVersion: 1 })),
    expectedRows,
    approvedBranchIds,
    approvedOrgUnitIds,
    policy,
    reviewedSnapshotId: null,
  };
}

async function validateOperationsPayload(
  context: RuntimeReadContext,
  payload: WorkflowPayloadV2,
): Promise<WorkflowValidation> {
  switch (payload.kind) {
    case 'investigation_create': {
      const resolved = await resolveInvestigationTargets(context, payload);
      invariant(isConfiguredClosedBusinessDate(payload.businessDate, isoDateSchema.parse(context.businessDate), context.now()),
        'WORKFLOW_STALE', 'Investigation business date must match the configured closed reporting date', 409);
      const targets: Array<{ semantic: SemanticTarget; expectedEffectRef: Ref; expectedRows: ExpectedRow[]; ownerIdentityId?: string | null }> = [];
      for (const [index, item] of resolved.entries()) {
        const input = payload.targets[index];
        const caseRow = await context.projections.get<Body>('investigation_cases', input.caseId);
        invariant(caseRow && (caseRow.body.status === 'open' || caseRow.body.status === 'in_progress'),
          'WORKFLOW_STALE', 'The persisted case is no longer open for operations work', 409);
        invariant(taskDateMatches(context, input.dueDate, input.priority),
          'WORKFLOW_INVALID_INPUT', 'Investigation due date does not match the shared priority policy');
        const owner = await loadOwnerAuthority(context, input.ownerIdentityId, item.branch);
        const evidence = await readBranchEvidence(context, item.branch, payload.businessDate, input.sourceIds);
        targets.push({ semantic: item.semantic, expectedEffectRef: item.expectedEffectRef,
          expectedRows: mergeExpectedRows(item.expectedRows, authorityExpectedRows(item.branch, owner), evidence.expectedRows),
          ownerIdentityId: owner.identityId });
      }
      return validation(targets);
    }
    case 'restock_create': {
      const resolved = await resolveRestockTargets(context, payload);
      const targets: Array<{ semantic: SemanticTarget; expectedEffectRef: Ref; expectedRows: ExpectedRow[]; ownerIdentityId?: string | null }> = [];
      for (const [index, item] of resolved.entries()) {
        const input = payload.targets[index];
        const observedAt = Date.parse(item.inventory.observedAt);
        const now = context.now().getTime();
        const ageLimit = demoWorkflowPolicyV1.restock.maxEvidenceAgeHours * 60 * 60_000;
        invariant(Number.isFinite(observedAt) && observedAt <= now && now - observedAt <= ageLimit,
          'WORKFLOW_STALE', 'The selected inventory snapshot is not fresh enough for restock review', 409);
        invariant(item.inventory.date <= getBangkokCalendarDate(context.now()),
          'WORKFLOW_STALE', 'The inventory snapshot is dated in the future', 409);
        invariant(taskDateMatches(context, input.dueDate, input.priority),
          'WORKFLOW_INVALID_INPUT', 'Restock due date does not match the shared priority policy');
        invariant(Number.isSafeInteger(item.inventory.onHand) && Number.isSafeInteger(item.inventory.minimum) &&
          item.inventory.minimum > 0 && item.inventory.onHand < item.inventory.minimum,
        'WORKFLOW_INVALID_INPUT', 'Restock requires a positive minimum and current stock below that minimum');
        const targetLevel = item.inventory.minimum * demoWorkflowPolicyV1.restock.targetMinimumMultiplier;
        const expectedQuantity = targetLevel - item.inventory.onHand;
        invariant(Number.isSafeInteger(targetLevel) && Number.isSafeInteger(expectedQuantity) && expectedQuantity > 0 &&
          expectedQuantity <= demoWorkflowPolicyV1.restock.maxQuantity && input.quantity === expectedQuantity,
        'WORKFLOW_INVALID_INPUT', 'Restock quantity does not match the shared replenishment policy');
        const owner = await loadOwnerAuthority(context, input.ownerIdentityId, item.branch);
        targets.push({ semantic: item.semantic, expectedEffectRef: item.expectedEffectRef,
          expectedRows: mergeExpectedRows(item.expectedRows, authorityExpectedRows(item.branch, owner)), ownerIdentityId: owner.identityId });
      }
      return validation(targets);
    }
    case 'incident_escalate': {
      const resolved = await resolveIncidentTargets(context, payload);
      const targets: Array<{ semantic: SemanticTarget; expectedEffectRef: Ref; expectedRows: ExpectedRow[] }> = [];
      for (const [index, item] of resolved.entries()) {
        const input = payload.targets[index];
        invariant(item.incident.status === 'open', 'WORKFLOW_STALE', 'Only an open incident can be escalated', 409);
        invariant(item.escalation.stage === demoWorkflowPolicyV1.incident.from && item.escalation.eventId === null,
          'WORKFLOW_STALE', 'The incident is no longer at the current policy escalation stage', 409);
        invariant(item.teamRow.body.active === true,
          'WORKFLOW_STALE', 'The configured operations escalation team is not active', 409);
        const evidence = await readBranchEvidence(context, item.branch, item.incident.date, input.evidenceIds);
        targets.push({ semantic: item.semantic, expectedEffectRef: item.expectedEffectRef,
          expectedRows: mergeExpectedRows(item.expectedRows, evidence.expectedRows) });
      }
      return validation(targets);
    }
    case 'branch_review_assign': {
      const resolved = await resolveBranchReviewTargets(context, payload);
      invariant(isConfiguredClosedBusinessDate(payload.businessDate, isoDateSchema.parse(context.businessDate), context.now()),
        'WORKFLOW_STALE', 'Branch review business date must match the configured closed reporting date', 409);
      const targets: Array<{ semantic: SemanticTarget; expectedEffectRef: Ref; expectedRows: ExpectedRow[]; ownerIdentityId?: string | null }> = [];
      for (const [index, item] of resolved.entries()) {
        const input = payload.targets[index];
        const currentCase = await context.projections.get<Body>('investigation_cases', input.caseId);
        invariant(currentCase && (currentCase.body.status === 'open' || currentCase.body.status === 'in_progress'),
          'WORKFLOW_STALE', 'The persisted case is no longer open for branch review', 409);
        invariant(taskDateMatches(context, input.dueDate, input.priority),
          'WORKFLOW_INVALID_INPUT', 'Branch review due date does not match the shared priority policy');
        const owner = await loadOwnerAuthority(context, input.ownerIdentityId, item.branch);
        const evidence = await readBranchEvidence(context, item.branch, payload.businessDate, persistedCaseSourceIds(item.caseRow));
        targets.push({ semantic: item.semantic, expectedEffectRef: item.expectedEffectRef,
          expectedRows: mergeExpectedRows(item.expectedRows, authorityExpectedRows(item.branch, owner), evidence.expectedRows),
          ownerIdentityId: owner.identityId });
      }
      return validation(targets);
    }
    default:
      invariant(false, 'WORKFLOW_CALLBACK_CONTRACT', 'The operations binding received an unsupported action kind');
      return validation([]);
  }
}

function executionAttribution(action: PendingActionV2, executionId: string) {
  return {
    ref: { table: 'action_executions' as const, id: executionId },
    rowVersion: 1,
    fields: [field('actorId', action.actorId), field('actionId', action.id), field('kind', action.payload.kind)],
  };
}

function semanticAttribution(target: PendingActionV2['targets'][number], executionId: string) {
  return {
    ref: { table: 'semantic_effects' as const, id: `semantic_${target.semanticKey}` },
    rowVersion: 1,
    fields: [field('semanticKey', target.semanticKey), field('executionId', executionId),
      field('effectType', target.expectedEffectRef.table), field('effectId', target.expectedEffectRef.id), field('status', 'committed')],
  };
}

function expectedPostcondition(
  action: PendingActionV2,
  target: PendingActionV2['targets'][number],
  executionId: string,
  fields: ExpectedField[],
): ExpectedPostcondition {
  return {
    targetId: target.targetId,
    ref: target.expectedEffectRef,
    rowVersion: target.expectedEffectVersion,
    executionId,
    fields: [...fields, field('executionId', executionId)],
    attributionRefs: [semanticAttribution(target, executionId), executionAttribution(action, executionId)],
  };
}

function postconditionsFor(action: PendingActionV2, executionId: string, confirmedAt: Instant): ExpectedPostcondition[] {
  switch (action.payload.kind) {
    case 'investigation_create':
      return action.payload.targets.map(input => {
        const target = targetForSource(action, 'investigation_cases', input.caseId);
        return expectedPostcondition(action, target, executionId, [
          field('caseId', input.caseId), field('ownerIdentityId', input.ownerIdentityId), field('branchId', input.branchId),
          field('status', 'open'), field('dueDate', input.dueDate), field('priority', input.priority),
          field('reason', input.reason), field('sourceIds', [...input.sourceIds].sort()),
          field('unansweredQuestion', input.unansweredQuestion), field('createdAt', confirmedAt),
        ]);
      });
    case 'restock_create':
      return action.payload.targets.map(input => {
        const target = targetForSource(action, 'inventory_snapshots', input.inventorySnapshotId);
        invariant(target.targetId.startsWith('restock_replenishment_'), 'WORKFLOW_CALLBACK_CONTRACT', 'A restock lifecycle was not frozen in the target identity');
        const replenishmentLifecycleId = target.targetId.slice('restock_'.length);
        return expectedPostcondition(action, target, executionId, [
          field('branchId', input.branchId), field('productId', input.productId), field('inventorySnapshotId', input.inventorySnapshotId),
          field('ownerIdentityId', input.ownerIdentityId), field('replenishmentLifecycleId', replenishmentLifecycleId),
          field('quantity', input.quantity), field('status', 'open'), field('dueDate', input.dueDate),
          field('priority', input.priority), field('reason', input.reason), field('createdAt', confirmedAt),
        ]);
      });
    case 'incident_escalate':
      return action.payload.targets.map(input => {
        const target = targetForSource(action, 'incidents', input.incidentId);
        const source = target.expectedRows.find(row => row.ref.table === 'incidents' && row.ref.id === input.incidentId);
        invariant(source, 'WORKFLOW_CALLBACK_CONTRACT', 'The escalation target has no reviewed incident version');
        const effect = expectedPostcondition(action, target, executionId, [
          field('incidentId', input.incidentId), field('teamId', input.targetTeamId), field('actorId', action.actorId),
          field('stage', demoWorkflowPolicyV1.incident.to),
          field('reason', input.reason), field('evidenceIds', [...input.evidenceIds].sort()), field('createdAt', confirmedAt),
        ]);
        return {
          ...effect,
          attributionRefs: [...effect.attributionRefs, {
            ref: { table: 'incidents', id: input.incidentId },
            rowVersion: source.rowVersion + 1,
            fields: [field('status', 'open'), field('escalationStage', demoWorkflowPolicyV1.incident.to),
              field('escalationEventId', target.expectedEffectRef.id)],
          }],
        };
      });
    case 'branch_review_assign':
      return action.payload.targets.map(input => {
        const target = targetForSource(action, 'investigation_cases', input.caseId);
        return expectedPostcondition(action, target, executionId, [
          field('branchId', input.branchId), field('caseId', input.caseId), field('ownerIdentityId', input.ownerIdentityId),
          field('status', 'open'), field('reason', input.reason), field('dueDate', input.dueDate),
          field('priority', input.priority), field('createdAt', confirmedAt),
        ]);
      });
    default:
      invariant(false, 'WORKFLOW_CALLBACK_CONTRACT', 'The operations binding received an unsupported action kind');
      return [];
  }
}

async function insertEffect(
  context: RuntimeReadContext & { tx: GuardedTransaction; action: PendingActionV2; executionId: string },
  target: PendingActionV2['targets'][number],
  source: Ref,
  table: Ref['table'],
  row: Body,
  constraint: string,
  values: Record<string, string | number>,
): Promise<CommittedTarget> {
  const sourceGuards = target.expectedRows.filter(expected => expected.ref.table === source.table && expected.ref.id === source.id);
  invariant(target.ref.table === source.table && target.ref.id === source.id && sourceGuards.length === 1 &&
    target.expectedEffectRef.table === table && row.id === target.expectedEffectRef.id && row.rowVersion === target.expectedEffectVersion,
  'WORKFLOW_CALLBACK_CONTRACT', 'The payload source or frozen effect reference does not match the atomic write');
  const inserted = await context.tx.insertUnique(table, row, { constraint, values });
  invariant(inserted.inserted, 'WORKFLOW_CONFLICT', 'An equivalent operations effect already exists', 409);
  return { targetId: target.targetId, ref: target.expectedEffectRef, executionId: context.executionId, rowVersion: target.expectedEffectVersion };
}

async function executeOperationsAction(
  context: RuntimeReadContext & { tx: GuardedTransaction; action: PendingActionV2; executionId: string },
  payload: WorkflowPayloadV2,
): Promise<CommittedTarget[]> {
  const action = context.action;
  const current = await validateOperationsPayload(context, payload);
  const frozenTargetRows = mergeExpectedRows(...action.targets.map(target => target.expectedRows));
  invariant(digest(current.targets) === digest(action.targets) && digest(current.expectedRows) === digest(frozenTargetRows) &&
    digest(current.approvedBranchIds) === digest(action.approvedBranchIds) &&
    digest(current.approvedOrgUnitIds) === digest(action.approvedOrgUnitIds) &&
    digest(current.policy) === digest(action.policy) && current.reviewedSnapshotId === action.reviewedSnapshotId,
  'WORKFLOW_STALE', 'The exact operations review changed before the atomic effect transaction', 409);
  const confirmedAt = context.now().toISOString();
  const committed: CommittedTarget[] = [];
  switch (payload.kind) {
    case 'investigation_create':
      for (const input of payload.targets) {
        const target = targetForSource(action, 'investigation_cases', input.caseId);
        committed.push(await insertEffect(context, target, { table: 'investigation_cases', id: input.caseId }, 'investigation_tasks', {
          id: target.expectedEffectRef.id, rowVersion: target.expectedEffectVersion, caseId: input.caseId,
          ownerIdentityId: input.ownerIdentityId, branchId: input.branchId, status: 'open', dueDate: input.dueDate,
          priority: input.priority, reason: input.reason, sourceIds: [...input.sourceIds].sort(),
          unansweredQuestion: input.unansweredQuestion, executionId: context.executionId, createdAt: confirmedAt,
        }, 'investigation_tasks_open_case_owner_unique', { caseId: input.caseId, ownerIdentityId: input.ownerIdentityId }));
      }
      break;
    case 'restock_create':
      for (const input of payload.targets) {
        const target = targetForSource(action, 'inventory_snapshots', input.inventorySnapshotId);
        invariant(target.targetId.startsWith('restock_replenishment_'), 'WORKFLOW_CALLBACK_CONTRACT', 'A restock lifecycle was not frozen in the target identity');
        const replenishmentLifecycleId = target.targetId.slice('restock_'.length);
        committed.push(await insertEffect(context, target, { table: 'inventory_snapshots', id: input.inventorySnapshotId }, 'restock_requests', {
          id: target.expectedEffectRef.id, rowVersion: target.expectedEffectVersion, branchId: input.branchId,
          productId: input.productId, inventorySnapshotId: input.inventorySnapshotId, ownerIdentityId: input.ownerIdentityId,
          replenishmentLifecycleId, quantity: input.quantity, status: 'open', dueDate: input.dueDate,
          priority: input.priority, reason: input.reason, executionId: context.executionId, createdAt: confirmedAt,
        }, 'restock_requests_open_product_unique', { branchId: input.branchId, productId: input.productId }));
      }
      break;
    case 'incident_escalate':
      for (const input of payload.targets) {
        const target = targetForSource(action, 'incidents', input.incidentId);
        const source = target.expectedRows.find(row => row.ref.table === 'incidents' && row.ref.id === input.incidentId);
        invariant(source, 'WORKFLOW_CALLBACK_CONTRACT', 'The escalation target has no reviewed incident version');
        const incidentRow = objectBody(await context.projections.get<Body>('incidents', input.incidentId), 'incidents', input.incidentId);
        const escalation = incidentEscalationState(incidentRow);
        invariant(incidentRow.rowVersion === source.rowVersion && escalation.stage === demoWorkflowPolicyV1.incident.from &&
          escalation.eventId === null,
        'WORKFLOW_STALE', 'The incident escalation state changed after review', 409);
        committed.push(await insertEffect(context, target, { table: 'incidents', id: input.incidentId }, 'incident_escalation_events', {
          id: target.expectedEffectRef.id, rowVersion: target.expectedEffectVersion, incidentId: input.incidentId,
          teamId: input.targetTeamId, actorId: action.actorId, stage: demoWorkflowPolicyV1.incident.to,
          lifecycleId: escalation.lifecycleId, executionId: context.executionId,
          reason: input.reason, evidenceIds: [...input.evidenceIds].sort(), createdAt: confirmedAt,
        }, 'incident_escalation_lifecycle_stage_unique', {
          incidentId: input.incidentId, lifecycleId: escalation.lifecycleId, stage: demoWorkflowPolicyV1.incident.to,
        }));
        const changed = await context.tx.compareAndSwap('incidents', input.incidentId,
          { rowVersion: incidentRow.rowVersion, state: workflowRowState('incidents', incidentRow.body) },
          { ...incidentRow.body, rowVersion: incidentRow.rowVersion + 1, escalationStage: demoWorkflowPolicyV1.incident.to,
            escalationLifecycleId: escalation.lifecycleId, escalationEventId: target.expectedEffectRef.id, updatedAt: confirmedAt });
        invariant(changed.updated, 'WORKFLOW_CONFLICT', 'The incident changed before its escalation event could be linked', 409);
        const persistedIncident = await context.projections.get<Body>('incidents', input.incidentId);
        const persistedEvent = await context.projections.get<Body>('incident_escalation_events', target.expectedEffectRef.id);
        invariant(persistedIncident?.rowVersion === incidentRow.rowVersion + 1 &&
          persistedIncident.body.escalationStage === demoWorkflowPolicyV1.incident.to &&
          persistedIncident.body.escalationLifecycleId === escalation.lifecycleId &&
          persistedIncident.body.escalationEventId === target.expectedEffectRef.id &&
          persistedEvent?.body.incidentId === input.incidentId && persistedEvent.body.lifecycleId === escalation.lifecycleId &&
          persistedEvent.body.stage === demoWorkflowPolicyV1.incident.to,
        'WORKFLOW_CALLBACK_CONTRACT', 'The incident escalation source and event pointer did not persist together');
      }
      break;
    case 'branch_review_assign':
      for (const input of payload.targets) {
        const target = targetForSource(action, 'investigation_cases', input.caseId);
        committed.push(await insertEffect(context, target, { table: 'investigation_cases', id: input.caseId }, 'branch_review_assignments', {
          id: target.expectedEffectRef.id, rowVersion: target.expectedEffectVersion, branchId: input.branchId,
          caseId: input.caseId, ownerIdentityId: input.ownerIdentityId, status: 'open', reason: input.reason,
          dueDate: input.dueDate, priority: input.priority, executionId: context.executionId, createdAt: confirmedAt,
        }, 'branch_review_assignments_open_case_unique', { caseId: input.caseId }));
      }
      break;
  }
  invariant(committed.length === action.targetCount, 'WORKFLOW_CALLBACK_CONTRACT', 'The operations effect count did not match the frozen action');
  return committed;
}

async function readEvidenceForPayload(
  context: RuntimeReadContext,
  action: PendingActionV2,
  targetRows: ReadonlyMap<string, ProjectedRow<Body> | null>,
): Promise<OperationsReadbackStatus> {
  const descriptors: Array<{
    branchId: string;
    target: PendingActionV2['targets'][number];
    evidence?: { businessDate: string; sourceIds: readonly string[]; compareExpectedRows?: boolean };
  }> = [];
  try {
    switch (action.payload.kind) {
      case 'investigation_create':
        for (const input of action.payload.targets) descriptors.push({
          branchId: input.branchId,
          target: targetForSource(action, 'investigation_cases', input.caseId),
          evidence: { businessDate: action.payload.businessDate, sourceIds: input.sourceIds },
        });
        break;
      case 'restock_create':
        for (const input of action.payload.targets) descriptors.push({
          branchId: input.branchId,
          target: targetForSource(action, 'inventory_snapshots', input.inventorySnapshotId),
        });
        break;
      case 'incident_escalate':
        for (const input of action.payload.targets) {
          const incident = targetRows.get(digest({ table: 'incidents', id: input.incidentId }));
          invariant(incident && typeof incident.body.date === 'string',
            'WORKFLOW_STALE', 'The guarded incident is unavailable for authority readback', 409);
          descriptors.push({
            branchId: asString(incident.body.branchId, 'WORKFLOW_STALE', 'The guarded incident has no current branch'),
            target: targetForSource(action, 'incidents', input.incidentId),
            evidence: { businessDate: incident.body.date, sourceIds: input.evidenceIds },
          });
        }
        break;
      case 'branch_review_assign':
        for (const input of action.payload.targets) {
          const target = targetForSource(action, 'investigation_cases', input.caseId);
          const caseRow = targetRows.get(digest({ table: 'investigation_cases', id: input.caseId }));
          const frozenCase = target.expectedRows.find(row => row.ref.table === 'investigation_cases' && row.ref.id === input.caseId);
          invariant(caseRow && frozenCase && caseRow.rowVersion === frozenCase.rowVersion &&
            workflowRowState('investigation_cases', caseRow.body) === frozenCase.state &&
            caseRow.body.branchId === input.branchId && caseRow.body.businessDate === action.payload.businessDate,
          'WORKFLOW_STALE', 'The guarded branch review case differs from the frozen review', 409);
          let sourceIds: string[];
          try {
            sourceIds = persistedCaseSourceIds(caseRow);
          } catch {
            return 'evidence_stale';
          }
          descriptors.push({
            branchId: input.branchId,
            target,
            evidence: { businessDate: action.payload.businessDate, sourceIds, compareExpectedRows: true },
          });
        }
        break;
    }
  } catch {
    return 'authority_stale';
  }

  const branchCache = new Map<string, BranchAuthorityRows>();
  const resolvedBranches: BranchAuthorityRows[] = [];
  try {
    for (const descriptor of descriptors) {
      let branch = branchCache.get(descriptor.branchId);
      if (!branch) {
        branch = await loadBranchAuthority(context, descriptor.branchId);
        branchCache.set(descriptor.branchId, branch);
      }
      const frozenRows = new Map(descriptor.target.expectedRows.map(row => [digest(row.ref), row]));
      for (const current of authorityExpectedRows(branch)) {
        const frozen = frozenRows.get(digest(current.ref));
        const observed = targetRows.get(digest(current.ref));
        invariant(frozen && digest(frozen) === digest(current) && observed &&
          observed.rowVersion === frozen.rowVersion && workflowRowState(current.ref.table, observed.body) === frozen.state,
        'WORKFLOW_STALE', 'The current branch organization authority differs from the frozen review', 409);
      }
      resolvedBranches.push(branch);
    }
  } catch {
    return 'authority_stale';
  }

  const evidenceCache = new Map<string, Promise<EvidenceRows>>();
  try {
    for (const [index, descriptor] of descriptors.entries()) {
      if (!descriptor.evidence) continue;
      const { businessDate, sourceIds } = descriptor.evidence;
      const key = digest({ branchId: descriptor.branchId, businessDate, sourceIds: [...sourceIds].sort() });
      let request = evidenceCache.get(key);
      if (!request) {
        request = readBranchEvidence(context, resolvedBranches[index], businessDate, sourceIds);
        evidenceCache.set(key, request);
      }
      const evidence = await request;
      if (descriptor.evidence.compareExpectedRows) {
        const evidenceTables = new Set(Object.values(evidenceSourceTables));
        const frozenEvidenceRows = descriptor.target.expectedRows.filter(row => evidenceTables.has(row.ref.table));
        invariant(digest(frozenEvidenceRows) === digest(evidence.expectedRows),
          'WORKFLOW_STALE', 'The branch review evidence rows changed after preparation', 409);
      }
    }
    return 'fresh';
  } catch {
    return 'evidence_stale';
  }
}

async function currentStates(context: RuntimeReadContext, refs: Ref[]): Promise<CurrentState[]> {
  const states: CurrentState[] = [];
  for (const ref of refs) {
    const row = await context.projections.get<Body>(ref.table, ref.id);
    if (!row) continue;
    const rawState = row.body.status ?? row.body.stage;
    const state = typeof rawState === 'string' && rawState.length > 0 ? rawState : 'present';
    states.push({ ref, state, rowVersion: row.rowVersion, allowedNextActions: [], completedActions: [] });
  }
  return states;
}

function verifyHandler(action: PendingActionV2, executionId: string, confirmedAt: Instant, committed: CommittedTarget[]) {
  const plan = postconditionsFor(action, executionId, confirmedAt);
  invariant(committed.length === plan.length, 'WORKFLOW_CALLBACK_CONTRACT', 'The committed operation and postcondition counts differ');
  return { plan, committed };
}

async function verifyBinding(
  context: RuntimeReadContext & { action: PendingActionV2; executionId: string },
  committed: CommittedTarget[],
): Promise<TargetProof[]> {
  const execution = await context.projections.get<Body>('action_executions', context.executionId);
  invariant(execution && execution.body.id === context.executionId,
    'WORKFLOW_CALLBACK_CONTRACT', 'The execution attribution is unavailable for verification');
  const confirmedAt = instantSchema.parse(execution.body.createdAt);
  const { plan } = verifyHandler(context.action, context.executionId, confirmedAt, committed);
  // The shared postcondition reader remains the exact persistent-reference and attribution contract.
  const results: TargetProof[] = [];
  for (const target of context.action.targets) {
    const itemPlan = plan.filter(item => item.targetId === target.targetId);
    let mismatch = false;
    try { await checkPostconditions(context.projections, itemPlan); } catch { mismatch = true; }
    const projected = await context.projections.get<Body>(target.expectedEffectRef.table, target.expectedEffectRef.id);
    const checkedAt = context.now().toISOString();
    const outcome = mismatch || !projected || projected.rowVersion !== target.expectedEffectVersion ? 'pending' : 'verified_success';
    results.push({ targetId: target.targetId, ref: target.expectedEffectRef, outcome, executionId: context.executionId,
      observedRowVersion: projected?.rowVersion ?? null, checkedAt, mismatchCodes: outcome === 'verified_success' ? [] : ['postcondition_mismatch'] });
  }

  const guarded = new Map<string, ProjectedRow<Body> | null>();
  for (const expected of mergeExpectedRows(context.action.expectedRows, ...context.action.targets.map(target => target.expectedRows))) {
    guarded.set(digest(expected.ref), (await context.projections.get<Body>(expected.ref.table, expected.ref.id)) ?? null);
  }
  const readbackStatus = await readEvidenceForPayload(context, context.action, guarded);
  if (readbackStatus === 'authority_stale') for (const proof of results) {
    proof.outcome = 'pending';
    proof.mismatchCodes = [...new Set([...proof.mismatchCodes, 'authority_stale'])];
  }
  if (readbackStatus === 'evidence_stale') for (const proof of results) {
    if (context.action.payload.kind === 'investigation_create' || context.action.payload.kind === 'incident_escalate' ||
      context.action.payload.kind === 'branch_review_assign') {
      proof.outcome = 'pending';
      proof.mismatchCodes = ['evidence_stale'];
    }
  }
  if (context.action.payload.kind === 'restock_create') {
    for (const input of context.action.payload.targets) {
      const target = targetForSource(context.action, 'inventory_snapshots', input.inventorySnapshotId);
      const proof = results.find(result => result.targetId === target.targetId);
      try {
        const selected = objectBody(await context.projections.get<Body>('inventory_snapshots', input.inventorySnapshotId),
          'inventory_snapshots', input.inventorySnapshotId);
        const currentSnapshots = await currentInventorySnapshots(context, input.branchId, input.productId);
        const inventory = inventorySchema.parse(Object.fromEntries(Object.entries(selected.body).filter(([key]) => key !== 'rowVersion')));
        const latest = latestInventorySnapshot(currentSnapshots);
        const ageLimit = demoWorkflowPolicyV1.restock.maxEvidenceAgeHours * 60 * 60_000;
        const age = context.now().getTime() - Date.parse(inventory.observedAt);
        const requiredQuantity = inventory.minimum * demoWorkflowPolicyV1.restock.targetMinimumMultiplier - inventory.onHand;
        invariant(latest.id === selected.id && Number.isSafeInteger(inventory.onHand) && Number.isSafeInteger(inventory.minimum) &&
          inventory.minimum > 0 && inventory.onHand < inventory.minimum && age >= 0 && age <= ageLimit &&
          inventory.date <= getBangkokCalendarDate(context.now()) && Number.isSafeInteger(requiredQuantity) &&
          requiredQuantity === input.quantity,
        'WORKFLOW_STALE', 'The current restock stock evidence changed after commit', 409);
      } catch {
        if (proof) {
          proof.outcome = 'pending';
          proof.mismatchCodes = [...new Set([...proof.mismatchCodes, 'stock_evidence_stale'])];
        }
      }
    }
  }
  const transitionedIncidentRefs = new Set(context.action.payload.kind === 'incident_escalate'
    ? context.action.payload.targets.map(input => digest({ table: 'incidents', id: input.incidentId }))
    : []);
  for (const expected of mergeExpectedRows(context.action.expectedRows, ...context.action.targets.map(target => target.expectedRows))) {
    if (transitionedIncidentRefs.has(digest(expected.ref))) continue;
    const row = guarded.get(digest(expected.ref));
    if (!row || row.rowVersion !== expected.rowVersion || workflowRowState(expected.ref.table, row.body) !== expected.state) {
      for (const proof of results) {
        proof.outcome = 'pending';
        proof.mismatchCodes = [...new Set([...proof.mismatchCodes, 'source_version_mismatch'])];
      }
      break;
    }
  }
  if (context.action.payload.kind === 'incident_escalate') {
    for (const input of context.action.payload.targets) {
      const target = targetForSource(context.action, 'incidents', input.incidentId);
      const expectedSource = target.expectedRows.find(row => row.ref.table === 'incidents' && row.ref.id === input.incidentId);
      const incident = guarded.get(digest({ table: 'incidents', id: input.incidentId }));
      const event = await context.projections.get<Body>('incident_escalation_events', target.expectedEffectRef.id);
      const lifecycleId = incident?.body.escalationLifecycleId;
      const matches = expectedSource !== undefined && incident !== null && incident !== undefined &&
        incident.rowVersion === expectedSource.rowVersion + 1 && incident.body.status === 'open' &&
        incident.body.escalationStage === demoWorkflowPolicyV1.incident.to &&
        incident.body.escalationEventId === target.expectedEffectRef.id && typeof lifecycleId === 'string' &&
        event?.body.incidentId === input.incidentId && event.body.lifecycleId === lifecycleId &&
        event.body.stage === demoWorkflowPolicyV1.incident.to && event.body.teamId === input.targetTeamId &&
        event.body.executionId === context.executionId;
      if (!matches) {
        const proof = results.find(result => result.targetId === target.targetId);
        if (proof) {
          proof.outcome = 'pending';
          proof.mismatchCodes = [...new Set([...proof.mismatchCodes, 'incident_escalation_source_mismatch'])];
        }
      }
    }
  }
  return results;
}

function investigationBinding(): WorkflowRuntimeBinding {
  return defineWorkflowBinding<'investigation_create'>({
    kind: 'investigation_create', contractVersion: 2, packIds: operationsAndSalesPacks, executionMode: 'atomic_local',
    authority: { permission: 'ticket.create', roles: ['executive', 'east_manager'], purpose: 'sales_operations' },
    identify: async (context, payload) => ({ targets: (await resolveInvestigationTargets(context, payload)).map(row => row.semantic) }),
    expectedPostconditions: postconditionsFor,
    validate: async (context, payload) => validateOperationsPayload(context, payload),
    executeAtomic: executeOperationsAction,
    verify: async (context, committed) => verifyBinding(context, committed),
    currentStates,
  });
}

function restockBinding(): WorkflowRuntimeBinding {
  return defineWorkflowBinding<'restock_create'>({
    kind: 'restock_create', contractVersion: 2, packIds: operationsPack, executionMode: 'atomic_local',
    authority: { permission: 'restock.create', roles: ['executive', 'east_manager'], purpose: 'sales_operations' },
    identify: async (context, payload) => ({ targets: (await resolveRestockTargets(context, payload)).map(row => row.semantic) }),
    expectedPostconditions: postconditionsFor,
    validate: async (context, payload) => validateOperationsPayload(context, payload),
    executeAtomic: executeOperationsAction,
    verify: async (context, committed) => verifyBinding(context, committed),
    currentStates,
  });
}

function incidentEscalationBinding(): WorkflowRuntimeBinding {
  return defineWorkflowBinding<'incident_escalate'>({
    kind: 'incident_escalate', contractVersion: 2, packIds: operationsAndSalesPacks, executionMode: 'atomic_local',
    authority: { permission: 'incident.escalate', roles: ['executive', 'east_manager'], purpose: 'sales_operations' },
    identify: async (context, payload) => ({ targets: (await resolveIncidentTargets(context, payload)).map(row => row.semantic) }),
    expectedPostconditions: postconditionsFor,
    validate: async (context, payload) => validateOperationsPayload(context, payload),
    executeAtomic: executeOperationsAction,
    verify: async (context, committed) => verifyBinding(context, committed),
    currentStates,
  });
}

function branchReviewBinding(): WorkflowRuntimeBinding {
  return defineWorkflowBinding<'branch_review_assign'>({
    kind: 'branch_review_assign', contractVersion: 2, packIds: operationsAndSalesPacks, executionMode: 'atomic_local',
    authority: { permission: 'branch.review.assign', roles: ['executive', 'east_manager'], purpose: 'sales_operations' },
    identify: async (context, payload) => ({ targets: (await resolveBranchReviewTargets(context, payload)).map(row => row.semantic) }),
    expectedPostconditions: postconditionsFor,
    validate: async (context, payload) => validateOperationsPayload(context, payload),
    executeAtomic: executeOperationsAction,
    verify: async (context, committed) => verifyBinding(context, committed),
    currentStates,
  });
}

/** Create the four operations V2 callbacks; the shared runner retains all auth, claim, and receipt ownership. */
export function createOperationsWorkflowBindings(): WorkflowRuntimeBinding[] {
  return [investigationBinding(), restockBinding(), incidentEscalationBinding(), branchReviewBinding()];
}
