import { dashboardSpecSchema, scopeSchema, type Dashboard, type DashboardSpec } from '../contracts';
import { deterministicAnalysis } from '../core/evidence';
import { invariant } from '../core/errors';
import { digest, id } from '../core/utils';
import {
  createDashboardGrantId,
  dashboardVersionDigest,
  resolveDashboardShareScope,
  signDashboardShare,
  type DashboardShareSigningOptions
} from '../workflows/dashboard-access';
import {
  authorizeWorkflowScope,
  type WorkflowPrincipal
} from '../workflows/authority';
import {
  dashboardShareRevokeEventIdV1,
  SHARE_REVOKE_EVENT_ID_REVISION
} from '../workflows/share-revoke-id';
import {
  defineWorkflowBinding,
  mergeExpectedRows,
  workflowRowState,
  type RuntimeReadContext,
  type WorkflowRuntimeBinding
} from '../workflows/action-runtime';
import type {
  CurrentState,
  ExpectedRow,
  Ref,
  TargetSpec,
  WorkflowActor,
  WorkflowPackReadContext,
  WorkflowPayloadV2
} from '../workflows/contracts';
import {
  dashboardShareV2Schema,
  dashboardShareRevokeEventSchema,
  directoryIdentitySchema,
  expectedRowSchema,
  instantSchema,
  workflowValidationSchema,
  type DashboardShareRevokeEvent,
  type DashboardShareV2,
  type DirectoryIdentity,
  type PolicyPin,
  type SimulatedDelivery
} from '../workflows/contracts';
import {
  demoWorkflowPolicyV1,
  dashboardShareExpiresAt,
  getDemoWorkflowPolicyV1Pin,
} from '../workflows/policy';
import type {
  ExpectedPostcondition,
  ExpectedField,
  AttributionPostcondition
} from '../workflows/action-results';
import type {
  ProjectedRow,
  WorkflowProjectionReader,
  WorkflowStorageQuery
} from '../storage/workflow-projections';

const salesRoles = ['executive', 'east_manager'] as const;
const dashboardPackIds = ['sales', 'operations'];
const salesPackIds = ['sales'];
const discountRequestPurpose = 'sales_discount_request';
const crmFollowupPurpose = 'sales_crm_followup';
const shareRevokePurpose = 'dashboard_share_revoke';
const shareBodyMarkerPrefix = '[[dashboard-share:';

interface BranchBody extends Record<string, unknown> {
  id: string;
  name: string;
  region: string;
  orgUnitId?: string | null;
  active?: boolean;
}

interface CrmCustomerBody extends Record<string, unknown> {
  id: string;
  ownerIdentityId?: string;
  status?: string;
  name?: string;
  region?: string;
}

interface CrmOpportunityBody extends Record<string, unknown> {
  id: string;
  customerId: string;
  ownerIdentityId: string;
  title: string;
  stage: string;
  amountSatang: number;
  expectedCloseDate?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

interface DiscountRequestBody extends Record<string, unknown> {
  id: string;
  opportunityId: string;
  ownerIdentityId: string;
  status: 'manager_review_pending' | 'approved' | 'rejected' | 'cancelled';
  discountBasisPoints: number;
  baseAmountSatang: number;
  reason: string;
  executionId: string;
  createdAt: string;
  expiresAt?: string;
}

interface CrmFollowupBody extends Record<string, unknown> {
  id: string;
  opportunityId: string;
  ownerIdentityId: string;
  status: 'open' | 'completed' | 'cancelled';
  dueDate: string;
  reason: string;
  priority: 'normal' | 'high';
  executionId: string;
  createdAt: string;
}

interface DashboardVersionBody extends Record<string, unknown> {
  id: string;
  dashboardId: string;
  version: number;
  ownerId: string;
  createdAt: string;
  spec: DashboardSpec;
  packs: Dashboard['packs'];
  sourceMetadata: Dashboard['sourceMetadata'];
  analysis: Dashboard['analysis'];
  evidenceVersion: string;
  digest: string;
}

export interface SalesWorkflowBindingOptions {
  dashboardShareSigning: DashboardShareSigningOptions;
}

interface DashboardShareSigningSnapshot extends DashboardShareSigningOptions {
  readonly keyVersion: number;
}

function snapshotDashboardShareSigning(signing: DashboardShareSigningOptions): DashboardShareSigningSnapshot {
  const secrets = new Map<number, string | Uint8Array>();
  for (const [version, secret] of signing.sessionSigningSecrets) {
    secrets.set(version, typeof secret === 'string' ? secret : Uint8Array.from(secret));
  }
  return Object.freeze({
    applicationOrigin: signing.applicationOrigin,
    sessionSigningSecrets: secrets,
    allowedKeyVersions: Object.freeze([...signing.allowedKeyVersions]),
    keyVersion: demoWorkflowPolicyV1.shareSigning.keyVersion
  });
}

function dashboardShareConfigurationRevision(signing: DashboardShareSigningSnapshot): string {
  const signingKeys = [...signing.sessionSigningSecrets.entries()]
    .map(([version, secret]) => {
      const bytes = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : Buffer.from(secret);
      return { version, digest: digest(Array.from(bytes)) };
    })
    .sort((left, right) => left.version - right.version);
  return 'sales-dashboard-share:v1:' + digest({
    applicationOrigin: signing.applicationOrigin,
    activeKeyVersion: signing.keyVersion,
    allowedKeyVersions: [...signing.allowedKeyVersions].sort((left, right) => left - right),
    signingKeys
  });
}

function runtimeContext(context: WorkflowPackReadContext): RuntimeReadContext {
  return context as RuntimeReadContext;
}

function requirePermissions(actor: WorkflowActor, permissions: readonly string[]): void {
  invariant(permissions.every(permission => actor.permissions.includes(permission)),
    'WORKFLOW_PERMISSION_DENIED', 'A required workflow permission is absent', 403);
}

function projectionRow<T extends { id: string }>(
  row: ProjectedRow<T> | undefined,
  idValue: string,
  label: string
): ProjectedRow<T> {
  invariant(row && row.id === idValue && row.body.id === idValue && Number.isSafeInteger(row.rowVersion) && row.rowVersion > 0,
    'WORKFLOW_STALE', label + ' is unavailable or has an invalid version', 409);
  if ('rowVersion' in row.body && row.body.rowVersion !== undefined) {
    invariant(row.body.rowVersion === row.rowVersion, 'WORKFLOW_STALE', label + ' body and projection versions disagree', 409);
  }
  return row;
}

function toExpectedRow(table: Ref['table'], row: ProjectedRow<{ id: string }>): ExpectedRow {
  return expectedRowSchema.parse({
    ref: { table, id: row.id },
    rowVersion: row.rowVersion,
    state: workflowRowState(table, row.body)
  });
}

function targetId(semanticKey: string): string {
  return 'target_' + semanticKey.slice(0, 40);
}

function requireSalesScope(
  principal: WorkflowPrincipal,
  permission: string,
  targets: readonly { branchId?: string; orgUnitId?: string }[]
): void {
  authorizeWorkflowScope(principal, {
    permission,
    roles: [...salesRoles],
    purpose: 'sales_operations',
    targets
  });
}

async function normalizedDashboardScope(
  context: RuntimeReadContext,
  payloadSpec: DashboardSpec,
  permission: 'dashboard.create' | 'dashboard.share'
): Promise<{ spec: DashboardSpec; branches: ProjectedRow<BranchBody>[] }> {
  const parsed = dashboardSpecSchema.parse(payloadSpec);
  const explicitIds = parsed.scope.branchIds;
  const principalBranches = context.principal.branches
    .filter(row => row.body.region === parsed.scope.region && row.body.active !== false)
    .map(row => row.id);
  const branchIds = [...new Set(explicitIds ?? principalBranches)].sort();
  invariant(branchIds.length > 0 && branchIds.length <= 12,
    'WORKFLOW_INVALID_INPUT', 'The dashboard scope must resolve to a bounded nonempty branch set');

  const branches = await Promise.all(branchIds.map(async branchId => projectionRow(
    await context.projections.get<BranchBody>('branches', branchId),
    branchId,
    'Dashboard branch'
  )));
  invariant(branches.every(row => row.body.region === parsed.scope.region && row.body.active !== false),
    'WORKFLOW_FORBIDDEN', 'The dashboard scope contains an inactive or out-of-region branch', 403);
  for (const row of branches) {
    requireSalesScope(context.principal, permission, [{
      branchId: row.id,
      ...(row.body.orgUnitId ? { orgUnitId: row.body.orgUnitId } : {})
    }]);
  }

  const spec = dashboardSpecSchema.parse({
    ...parsed,
    scope: scopeSchema.parse({ ...parsed.scope, branchIds })
  });
  return { spec, branches };
}

function scopeTargets(branches: readonly ProjectedRow<BranchBody>[]): { branchId: string; orgUnitId?: string }[] {
  return branches.map(row => ({
    branchId: row.id,
    ...(row.body.orgUnitId ? { orgUnitId: row.body.orgUnitId } : {})
  }));
}

function currentPolicy(): PolicyPin {
  return getDemoWorkflowPolicyV1Pin();
}

function makeValidation(
  targets: TargetSpec[],
  expectedRows: ExpectedRow[],
  approvedBranchIds: string[] = [],
  approvedOrgUnitIds: string[] = []
) {
  return workflowValidationSchema.parse({
    targets,
    expectedRows: mergeExpectedRows(expectedRows),
    approvedBranchIds: [...new Set(approvedBranchIds)].sort(),
    approvedOrgUnitIds: [...new Set(approvedOrgUnitIds)].sort(),
    policy: currentPolicy(),
    reviewedSnapshotId: null
  });
}

function fields(values: Record<string, unknown>): ExpectedField[] {
  return Object.entries(values).map(([path, expected]) => ({ path, expected }));
}

function commonCoreAttributions(
  action: Parameters<WorkflowRuntimeBinding['expectedPostconditions']>[0],
  executionId: string,
  effectRef: Ref,
  semanticKey: string,
  confirmedAt: string
): AttributionPostcondition[] {
  return [
    {
      ref: { table: 'semantic_effects', id: 'semantic_' + semanticKey },
      rowVersion: 1,
      fields: fields({
        id: 'semantic_' + semanticKey,
        semanticKey,
        executionId,
        effectType: effectRef.table,
        effectId: effectRef.id,
        status: 'committed'
      })
    },
    {
      ref: { table: 'action_executions', id: executionId },
      rowVersion: 1,
      fields: fields({
        id: executionId,
        actorId: action.actorId,
        actionId: action.id,
        kind: action.payload.kind,
        contractVersion: 2,
        outcome: 'pending',
        createdAt: instantSchema.parse(confirmedAt)
      })
    }
  ];
}

function expectedPostcondition(
  action: Parameters<WorkflowRuntimeBinding['expectedPostconditions']>[0],
  executionId: string,
  target: TargetSpec,
  businessFields: Record<string, unknown>,
  confirmedAt: string,
  attributionRefs: AttributionPostcondition[] = []
): ExpectedPostcondition {
  instantSchema.parse(confirmedAt);
  return {
    targetId: target.targetId,
    ref: target.expectedEffectRef,
    rowVersion: target.expectedEffectVersion,
    executionId,
    fields: fields(businessFields),
    attributionRefs: [
      ...attributionRefs,
      ...commonCoreAttributions(action, executionId, target.expectedEffectRef, target.semanticKey, confirmedAt)
    ]
  };
}

function stateOf(table: Ref['table'], body: unknown): string {
  return workflowRowState(table, body) ?? 'present';
}

async function currentStates(
  context: WorkflowPackReadContext,
  refs: Ref[]
): Promise<CurrentState[]> {
  const read = runtimeContext(context);
  const output: CurrentState[] = [];
  for (const ref of refs) {
    const row = await read.projections.get<Record<string, unknown>>(ref.table, ref.id);
    if (!row || row.body.id !== ref.id) continue;
    output.push({
      ref,
      state: stateOf(ref.table, row.body),
      rowVersion: row.rowVersion,
      allowedNextActions: [],
      completedActions: []
    });
  }
  return output;
}

async function pagedScopedRows<T>(
  reader: WorkflowProjectionReader,
  query: Omit<Extract<WorkflowStorageQuery, { kind: 'scoped' }>, 'cursor'>,
  maximum: number
): Promise<ProjectedRow<T>[]> {
  const rows: ProjectedRow<T>[] = [];
  let cursor: string | undefined;
  while (true) {
    const page = await reader.query<T>({ ...query, ...(cursor === undefined ? {} : { cursor }) });
    invariant(page.length <= (query.limit ?? 100), 'WORKFLOW_CALLBACK_CONTRACT', 'A scoped query exceeded its page bound');
    rows.push(...page);
    invariant(rows.length <= maximum, 'WORKFLOW_INVALID_INPUT', 'A scoped review exceeds its configured bound');
    if (page.length < (query.limit ?? 100)) break;
    const next = page[page.length - 1]?.id;
    invariant(next !== undefined && next !== cursor, 'WORKFLOW_CALLBACK_CONTRACT', 'A scoped query did not advance');
    cursor = next;
  }
  return rows;
}

const dashboardEvidenceTables = [
  'sales_orders',
  'sales_targets',
  'inventory_snapshots',
  'incidents',
  'staffing_summaries'
] as const;

async function dashboardSourceRows(
  context: RuntimeReadContext,
  spec: DashboardSpec,
  branches: readonly ProjectedRow<BranchBody>[]
): Promise<ExpectedRow[]> {
  const branchIds = branches.map(row => row.id);
  const tableRows = await Promise.all(dashboardEvidenceTables.map(table => pagedScopedRows<Record<string, unknown>>(
    context.projections,
    { kind: 'scoped', table, branchIds, fromDate: spec.scope.date, throughDate: spec.scope.date, limit: 100 },
    500
  )));
  const expected = [
    ...branches.map(row => toExpectedRow('branches', row)),
    ...tableRows.flatMap((rows, index) => rows.map(row => toExpectedRow(dashboardEvidenceTables[index], row as ProjectedRow<{ id: string }>)))
  ];
  invariant(expected.length <= 500, 'WORKFLOW_INVALID_INPUT', 'Dashboard source guards exceed the reviewed row limit');
  return mergeExpectedRows(expected);
}

function expectedRowsFor(
  target: TargetSpec,
  table: Ref['table']
): ExpectedRow[] {
  return target.expectedRows.filter(row => row.ref.table === table);
}

function dashboardIdFrom(target: TargetSpec): string {
  return target.expectedEffectRef.id;
}

function dashboardVersionIdFor(dashboardId: string): string {
  return 'version_' + digest({ purpose: 'biztania.dashboard-version-id/v2', dashboardId, version: 1 });
}

function normalizedSpecFromAction(action: Parameters<WorkflowRuntimeBinding['expectedPostconditions']>[0], target: TargetSpec): DashboardSpec {
  invariant(action.payload.kind === 'dashboard_create', 'WORKFLOW_CALLBACK_CONTRACT', 'Dashboard create payload did not match');
  const branchIds = expectedRowsFor(target, 'branches').map(row => row.ref.id).sort();
  invariant(branchIds.length > 0, 'WORKFLOW_CALLBACK_CONTRACT', 'Dashboard preparation omitted exact scope branches');
  return dashboardSpecSchema.parse({
    ...action.payload.spec,
    scope: scopeSchema.parse({ ...action.payload.spec.scope, branchIds })
  });
}

function versionDigest(row: DashboardVersionBody): string {
  return dashboardVersionDigest({
    id: row.id,
    dashboardId: row.dashboardId,
    version: row.version,
    ownerId: row.ownerId,
    createdAt: row.createdAt,
    spec: row.spec,
    packs: row.packs,
    sourceMetadata: row.sourceMetadata,
    analysis: row.analysis,
    evidenceVersion: row.evidenceVersion
  });
}

async function evidenceForDashboard(
  context: RuntimeReadContext,
  spec: DashboardSpec,
  branches: readonly ProjectedRow<BranchBody>[]
) {
  const evidence = await context.evidence(spec.scope);
  const branchIds = branches.map(row => row.id).sort();
  invariant(evidence.scope.region === spec.scope.region && evidence.scope.date === spec.scope.date &&
    digest([...(evidence.scope.branchIds ?? [])].sort()) === digest(branchIds) &&
    digest(evidence.branches.map(row => row.branchId).sort()) === digest(branchIds) &&
    evidence.version.length > 0,
  'WORKFLOW_STALE', 'Dashboard evidence no longer covers the exact reviewed scope', 409);
  return evidence;
}

const dashboardCreateBinding = defineWorkflowBinding({
  kind: 'dashboard_create',
  contractVersion: 2,
  packIds: dashboardPackIds,
  executionMode: 'atomic_local',
  authority: { permission: 'dashboard.create', roles: [...salesRoles], purpose: 'sales_operations' },
  identify: async (context, payload) => {
    requirePermissions(context.actor, ['sales.read', 'operations.read']);
    const { spec, branches } = await normalizedDashboardScope(context, payload.spec, 'dashboard.create');
    const semanticKey = digest({
      kind: 'dashboard_create',
      ownerId: context.actor.id,
      spec
    });
    return {
      targets: [{
        targetId: targetId(semanticKey),
        ref: { table: 'branches', id: branches[0].id },
        semanticKey,
        scope: {
          branchId: branches[0].id,
          ...(branches[0].body.orgUnitId ? { orgUnitId: branches[0].body.orgUnitId } : {})
        }
      }]
    };
  },
  expectedPostconditions: (action, executionId, confirmedAt) => action.targets.map(target => {
    invariant(action.payload.kind === 'dashboard_create', 'WORKFLOW_CALLBACK_CONTRACT', 'Dashboard create payload did not match');
    const spec = normalizedSpecFromAction(action, target);
    const dashboardId = dashboardIdFrom(target);
    const versionId = dashboardVersionIdFor(dashboardId);
    const timestamp = instantSchema.parse(confirmedAt);
    const versionAttribution: AttributionPostcondition[] = [{
      ref: { table: 'dashboard_versions', id: versionId },
      rowVersion: 1,
      fields: fields({
        id: versionId,
        dashboardId,
        version: 1,
        ownerId: action.actorId,
        createdAt: timestamp,
        spec,
        packs: action.packs
      })
    }];
    return expectedPostcondition(action, executionId, target, {
      id: dashboardId,
      ownerId: action.actorId,
      spec,
      packs: action.packs,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastRefreshAt: timestamp
    }, confirmedAt, versionAttribution);
  }),
  validate: async (baseContext, payload) => {
    const context = runtimeContext(baseContext);
    invariant(payload.kind === 'dashboard_create', 'WORKFLOW_CALLBACK_CONTRACT', 'Dashboard create payload did not match');
    requirePermissions(context.actor, ['sales.read', 'operations.read']);
    const { spec, branches } = await normalizedDashboardScope(context, payload.spec, 'dashboard.create');
    await evidenceForDashboard(context, spec, branches);
    const sourceRows = await dashboardSourceRows(context, spec, branches);
    const semanticKey = digest({ kind: 'dashboard_create', ownerId: context.actor.id, spec });
    const target: TargetSpec = {
      targetId: targetId(semanticKey),
      ref: { table: 'branches', id: branches[0].id },
      semanticKey,
      expectedRows: sourceRows,
      ownerIdentityId: context.principal.directory.id,
      expectedEffectRef: { table: 'dashboards', id: id('dashboard') },
      expectedEffectVersion: 1
    };
    return makeValidation([target], [], branches.map(row => row.id),
      branches.flatMap(row => row.body.orgUnitId ? [row.body.orgUnitId] : []));
  },
  executeAtomic: async (baseContext, payload) => {
    const context = baseContext;
    invariant(payload.kind === 'dashboard_create', 'WORKFLOW_CALLBACK_CONTRACT', 'Dashboard create payload did not match');
    const target = targetById(context.action, context.action.targets[0]?.targetId ?? '');
    const spec = normalizedSpecFromAction(context.action, target);
    const branchIds = spec.scope.branchIds ?? [];
    const branches = await Promise.all(branchIds.map(async branchId =>
      projectionRow(await context.projections.get<BranchBody>('branches', branchId), branchId, 'Dashboard branch')
    ));
    requirePermissions(context.actor, ['sales.read', 'operations.read']);
    for (const branch of branches) requireSalesScope(context.principal, 'dashboard.create', scopeTargets([branch]));
    const evidence = await evidenceForDashboard(context, spec, branches);
    const createdAt = context.now().toISOString();
    const analysis = deterministicAnalysis(evidence, new Date(createdAt));
    const dashboardId = target.expectedEffectRef.id;
    const versionId = dashboardVersionIdFor(dashboardId);
    const dashboard: Dashboard & { rowVersion: number } = {
      id: dashboardId,
      rowVersion: target.expectedEffectVersion,
      ownerId: context.actor.id,
      spec,
      packs: context.action.packs,
      createdAt,
      updatedAt: createdAt,
      lastRefreshAt: createdAt,
      sourceMetadata: evidence.sources,
      analysis,
      evidenceVersion: evidence.version
    };
    const versionBody: DashboardVersionBody & { rowVersion: number } = {
      id: versionId,
      rowVersion: 1,
      dashboardId,
      version: 1,
      ownerId: context.actor.id,
      createdAt,
      spec,
      packs: context.action.packs,
      sourceMetadata: evidence.sources,
      analysis,
      evidenceVersion: evidence.version,
      digest: ''
    };
    versionBody.digest = versionDigest(versionBody);
    const dashboardInsert = await context.tx.insertUnique('dashboards', dashboard, {
      constraint: 'dashboards_primary_key',
      values: { id: dashboard.id }
    });
    invariant(dashboardInsert.inserted, 'WORKFLOW_CONFLICT', 'The dashboard identity already exists', 409);
    const versionInsert = await context.tx.insertUnique('dashboard_versions', versionBody, {
      constraint: 'dashboard_versions_dashboard_version_unique',
      values: { dashboardId, version: 1 }
    });
    invariant(versionInsert.inserted, 'WORKFLOW_CONFLICT', 'The immutable dashboard version already exists', 409);
    return [{
      targetId: target.targetId,
      ref: target.expectedEffectRef,
      executionId: context.executionId,
      rowVersion: target.expectedEffectVersion
    }];
  },
  verify: async (baseContext, committed) => {
    const context = baseContext;
    const output = [];
    for (const result of committed) {
      const target = context.action.targets.find(item => item.targetId === result.targetId);
      const action = context.action;
      if (!target || action.payload.kind !== 'dashboard_create') {
        output.push(proof(result.targetId, result.ref, context.executionId, null,
          context.now().toISOString(), 'failed', ['DASHBOARD_APPROVAL_MISMATCH']));
        continue;
      }
      const expectedSpec = normalizedSpecFromAction(action, target);
      const dashboardRow = await context.projections.get<Dashboard>('dashboards', result.ref.id);
      const versionId = dashboardVersionIdFor(result.ref.id);
      const versionRow = await context.projections.get<DashboardVersionBody>('dashboard_versions', versionId);
      const execution = await context.projections.get<{ createdAt: string }>('action_executions', context.executionId);
      const checkedAt = context.now().toISOString();
      const branches = expectedSpec.scope.branchIds ?? [];
      const dashboardEvidence = await evidenceForDashboard(context, expectedSpec, await Promise.all(branches.map(async branchId =>
        projectionRow(await context.projections.get<BranchBody>('branches', branchId), branchId, 'Dashboard branch')
      )));
      const expectedAnalysis = deterministicAnalysis(dashboardEvidence, new Date(execution?.body.createdAt ?? ''));
      if (!dashboardRow || !versionRow || !execution ||
        dashboardRow.rowVersion !== result.rowVersion || dashboardRow.body.id !== result.ref.id ||
        dashboardRow.body.ownerId !== action.actorId || digest(dashboardRow.body.spec) !== digest(expectedSpec) ||
        digest(dashboardRow.body.packs) !== digest(action.packs) ||
        dashboardRow.body.createdAt !== execution.body.createdAt ||
        dashboardRow.body.updatedAt !== execution.body.createdAt ||
        dashboardRow.body.lastRefreshAt !== execution.body.createdAt ||
        dashboardRow.body.evidenceVersion !== dashboardEvidence.version ||
        digest(dashboardRow.body.sourceMetadata) !== digest(dashboardEvidence.sources) ||
        digest(dashboardRow.body.analysis) !== digest(expectedAnalysis) ||
        versionRow.rowVersion !== 1 || versionRow.body.id !== versionId ||
        versionRow.body.dashboardId !== result.ref.id || versionRow.body.version !== 1 ||
        versionRow.body.ownerId !== action.actorId || versionRow.body.createdAt !== execution.body.createdAt ||
        digest(versionRow.body.spec) !== digest(expectedSpec) ||
        digest(versionRow.body.packs) !== digest(action.packs) ||
        versionRow.body.evidenceVersion !== dashboardEvidence.version ||
        digest(versionRow.body.sourceMetadata) !== digest(dashboardEvidence.sources) ||
        digest(versionRow.body.analysis) !== digest(expectedAnalysis) ||
        versionRow.body.digest !== versionDigest(versionRow.body)) {
        output.push(proof(result.targetId, result.ref, context.executionId, dashboardRow?.rowVersion ?? null,
          checkedAt, 'stale', ['DASHBOARD_READBACK_MISMATCH']));
        continue;
      }
      output.push(proof(result.targetId, result.ref, context.executionId, dashboardRow.rowVersion,
        checkedAt, 'verified_success'));
    }
    return output;
  },
  currentStates: async (baseContext, refs) => currentStates(baseContext, refs)
}) as WorkflowRuntimeBinding<'dashboard_create'>;

async function loadDashboardVersion(
  context: RuntimeReadContext,
  dashboardId: string,
  ownerId: string
): Promise<ProjectedRow<DashboardVersionBody>> {
  const rows = await pagedScopedRows<DashboardVersionBody>(
    context.projections,
    { kind: 'scoped', table: 'dashboard_versions', ownerId, limit: 100 },
    10_000
  );
  const versions = rows.filter(row => row.body.dashboardId === dashboardId && row.body.ownerId === ownerId);
  invariant(versions.length > 0, 'WORKFLOW_FORBIDDEN',
    'Only an immutable V2 dashboard version owned by this actor can be shared', 403);
  const newestVersion = Math.max(...versions.map(row => row.body.version));
  const newest = versions.filter(row => row.body.version === newestVersion);
  invariant(newest.length === 1, 'WORKFLOW_CALLBACK_CONTRACT', 'The current dashboard version is ambiguous');
  const version = projectionRow(newest[0], newest[0].id, 'Dashboard version');
  dashboardSpecSchema.parse(version.body.spec);
  invariant(version.body.analysis && version.body.evidenceVersion.length > 0,
    'WORKFLOW_STALE', 'The immutable dashboard version is incomplete', 409);
  return version;
}

interface OpportunitySources {
  opportunity: ProjectedRow<CrmOpportunityBody>;
  customer: ProjectedRow<CrmCustomerBody>;
  owner: ProjectedRow<DirectoryIdentity>;
  ownerOrgUnit: ProjectedRow<{ id: string; name: string; active: boolean }>;
  ownerResponsibilities: ProjectedRow<{ id: string; identityId: string; orgUnitId: string; purpose: string; branchIds: string[]; active: boolean; rowVersion: number }>[];
  expectedRows: ExpectedRow[];
  orgUnitId: string;
}

async function loadOpportunitySources(
  context: RuntimeReadContext,
  opportunityId: string,
  readPermission = 'crm.read'
): Promise<OpportunitySources> {
  requirePermissions(context.actor, [readPermission]);
  const opportunity = projectionRow(
    await context.projections.get<CrmOpportunityBody>('crm_opportunities', opportunityId),
    opportunityId,
    'CRM opportunity'
  );
  const customer = projectionRow(
    await context.projections.get<CrmCustomerBody>('crm_customers', opportunity.body.customerId),
    opportunity.body.customerId,
    'CRM customer'
  );
  invariant(customer.body.status === 'active' && typeof customer.body.region === 'string' &&
    context.actor.regions.includes(customer.body.region),
  'WORKFLOW_FORBIDDEN', 'The CRM customer is not active in the actor region', 403);
  invariant(!customer.body.ownerIdentityId || customer.body.ownerIdentityId === opportunity.body.ownerIdentityId,
    'WORKFLOW_STALE', 'The opportunity owner no longer matches the customer owner', 409);

  const ownerIdentity = await context.projections.get<DirectoryIdentity>('directory_identities', opportunity.body.ownerIdentityId);
  invariant(ownerIdentity, 'WORKFLOW_FORBIDDEN', 'The current CRM owner is unavailable', 403);
  const owner = projectionRow(
    { ...ownerIdentity, body: directoryIdentitySchema.parse(ownerIdentity.body) },
    opportunity.body.ownerIdentityId,
    'CRM owner identity'
  );
  invariant(owner.body.active && (salesRoles as readonly string[]).includes(owner.body.role),
    'WORKFLOW_FORBIDDEN', 'The current CRM owner is not an active sales identity', 403);
  const orgUnitId = owner.body.orgUnitId;
  const ownerOrgUnit = projectionRow(
    await context.projections.get<{ id: string; name: string; active: boolean }>('org_units', orgUnitId),
    orgUnitId,
    'CRM owner organization'
  );
  invariant(ownerOrgUnit.body.active, 'WORKFLOW_FORBIDDEN', 'The CRM owner organization is inactive', 403);

  const ownerResponsibilities = await pagedScopedRows<{
    id: string; identityId: string; orgUnitId: string; purpose: string;
    branchIds: string[]; active: boolean; rowVersion: number;
  }>(
    context.projections,
    { kind: 'scoped', table: 'responsibilities', ownerId: owner.id, limit: 100 },
    500
  );
  invariant(ownerResponsibilities.some(row => row.body.identityId === owner.id && row.body.orgUnitId === orgUnitId &&
    row.body.purpose === 'sales_operations' && row.body.active),
  'WORKFLOW_FORBIDDEN', 'The current CRM owner has no active Sales responsibility', 403);
  requireSalesScope(context.principal, readPermission, [{ orgUnitId }]);

  const expectedRows = mergeExpectedRows([
    toExpectedRow('crm_opportunities', opportunity),
    toExpectedRow('crm_customers', customer),
    toExpectedRow('directory_identities', owner),
    toExpectedRow('org_units', ownerOrgUnit),
    ...ownerResponsibilities.map(row => toExpectedRow('responsibilities', row))
  ]);
  return { opportunity, customer, owner, ownerOrgUnit, ownerResponsibilities, expectedRows, orgUnitId };
}

function discountSemantic(
  opportunity: CrmOpportunityBody,
  requestedBasisPoints: number,
  baseAmountSatang: number
): string {
  return digest({
    kind: 'discount_request_create',
    opportunityId: opportunity.id,
    lifecycle: opportunity.stage,
    requestedBasisPoints,
    baseAmountSatang,
    purpose: discountRequestPurpose
  });
}

function crmFollowupSemantic(opportunity: CrmOpportunityBody): string {
  return digest({
    kind: 'crm_followup_create',
    opportunityId: opportunity.id,
    lifecycle: opportunity.stage,
    purpose: crmFollowupPurpose
  });
}

async function crmFollowupsForOpportunity(
  context: RuntimeReadContext,
  opportunityId: string
): Promise<ProjectedRow<CrmFollowupBody>[]> {
  return pagedScopedRows<CrmFollowupBody>(context.projections, {
    kind: 'scoped',
    table: 'crm_followups',
    equals: { opportunityId },
    limit: 100
  }, 500);
}

function proof(
  targetIdValue: string,
  ref: Ref,
  executionId: string,
  rowVersion: number | null,
  checkedAt: string,
  outcome: 'verified_success' | 'stale' | 'failed',
  mismatchCodes: string[] = []
) {
  return {
    targetId: targetIdValue,
    ref,
    outcome,
    executionId,
    observedRowVersion: rowVersion,
    checkedAt,
    mismatchCodes
  };
}

function targetById(action: Parameters<WorkflowRuntimeBinding['expectedPostconditions']>[0], targetIdValue: string): TargetSpec {
  const target = action.targets.find(row => row.targetId === targetIdValue);
  invariant(target, 'WORKFLOW_CALLBACK_CONTRACT', 'The approved target was unavailable');
  return target;
}

function semanticKeyForShareRevoke(shareId: string): string {
  return digest({ kind: 'dashboard_share_revoke', shareId, purpose: shareRevokePurpose });
}

function semanticKeyForShare(
  versionId: string,
  recipientIdentityId: string,
  branchIds: readonly string[],
  channel: string,
  lifecycle: number
): string {
  return digest({
    kind: 'dashboard_share',
    dashboardVersionId: versionId,
    recipientIdentityId,
    approvedBranchIds: [...branchIds].sort(),
    channel,
    lifecycle: 'active-share-' + lifecycle
  });
}

async function loadShare(
  context: RuntimeReadContext,
  shareId: string
): Promise<ProjectedRow<DashboardShareV2>> {
  const row = await context.projections.get<Record<string, unknown>>('dashboard_shares', shareId);
  const parsed = dashboardShareV2Schema.safeParse(row?.body);
  invariant(row && parsed.success && parsed.data.id === shareId,
    'WORKFLOW_NOT_FOUND', 'The dashboard share is unavailable', 404);
  return { ...row, body: parsed.data };
}

async function shareRevokeCurrentStates(
  baseContext: WorkflowPackReadContext,
  refs: Ref[]
): Promise<CurrentState[]> {
  const context = runtimeContext(baseContext);
  const output: CurrentState[] = [];
  for (const ref of refs) {
    if (ref.table !== 'dashboard_shares') continue;
    const row = await context.projections.get<Record<string, unknown>>('dashboard_shares', ref.id);
    const parsed = dashboardShareV2Schema.safeParse(row?.body);
    if (!row || !parsed.success || parsed.data.id !== ref.id) continue;
    const canRevoke = parsed.data.status === 'active' &&
      parsed.data.senderIdentityId === context.principal.directory.id &&
      context.actor.permissions.includes('dashboard.share');
    const completedActions: CurrentState['completedActions'] = [];
    if (parsed.data.status === 'revoked' && parsed.data.senderIdentityId === context.principal.directory.id) {
      const effect = await context.projections.query<{ executionId: string }>({
        kind: 'unique',
        table: 'semantic_effects',
        constraint: 'semantic_effects_key_unique',
        values: { semanticKey: semanticKeyForShareRevoke(parsed.data.id) }
      });
      const executionId = effect[0]?.body.executionId;
      if (executionId) {
        const receipt = await context.projections.get<{ actorId: string; kind: string; outcome: string; createdAt: string }>(
          'action_executions', executionId
        );
        if (receipt?.body.actorId === context.actor.id && receipt.body.kind === 'dashboard_share_revoke' &&
          receipt.body.outcome === 'verified_success') {
          completedActions.push({ kind: 'dashboard_share_revoke', executionId, completedAt: receipt.body.createdAt });
        }
      }
    }
    output.push({
      ref,
      state: parsed.data.status,
      rowVersion: row.rowVersion,
      allowedNextActions: canRevoke ? ['dashboard_share_revoke'] : [],
      completedActions
    });
  }
  return output;
}

interface ShareIdentity {
  dashboard: ProjectedRow<Dashboard>;
  version: ProjectedRow<DashboardVersionBody>;
  branchIds: string[];
  branches: ProjectedRow<BranchBody>[];
  expectedRows: ExpectedRow[];
  sender: DirectoryIdentity;
  recipient: DirectoryIdentity;
  semanticKey: string;
  activeExisting: boolean;
}

async function resolveShareIdentity(
  context: RuntimeReadContext,
  payload: Extract<WorkflowPayloadV2, { kind: 'dashboard_share' }>
): Promise<ShareIdentity> {
  requirePermissions(context.actor, ['sales.read', 'operations.read']);
  const dashboard = projectionRow(
    await context.projections.get<Dashboard>('dashboards', payload.dashboardId),
    payload.dashboardId,
    'Dashboard'
  );
  invariant(dashboard.body.ownerId === context.actor.id,
    'WORKFLOW_FORBIDDEN', 'Only the dashboard owner may share it', 403);
  context.assertPins(dashboard.body.packs);
  const version = await loadDashboardVersion(context, dashboard.id, context.actor.id);
  const versionSpec = dashboardSpecSchema.parse(version.body.spec);
  invariant(versionSpec.scope.branchIds && versionSpec.scope.branchIds.length > 0,
    'WORKFLOW_STALE', 'The immutable dashboard version has no explicit branch ceiling', 409);
  invariant(version.body.digest === versionDigest(version.body),
    'WORKFLOW_STALE', 'The immutable dashboard version digest is invalid', 409);
  const resolved = await resolveDashboardShareScope(context.projections, {
    senderIdentityId: context.principal.directory.id,
    recipientIdentityId: payload.recipientIdentityId,
    spec: versionSpec,
    channel: payload.channel
  });
  const branchIds = [...new Set(resolved.branchIds)].sort();
  invariant(branchIds.length > 0 && branchIds.every(branchId => versionSpec.scope.branchIds!.includes(branchId)),
    'WORKFLOW_FORBIDDEN', 'The recipient has no eligible branch in the immutable dashboard version', 403);
  const branches = await Promise.all(branchIds.map(async branchId =>
    projectionRow(await context.projections.get<BranchBody>('branches', branchId), branchId, 'Shared branch')
  ));
  requireSalesScope(context.principal, 'dashboard.share', scopeTargets(branches));
  invariant(resolved.sender.id === context.principal.directory.id && resolved.recipient.id === payload.recipientIdentityId,
    'WORKFLOW_FORBIDDEN', 'The current sender or recipient identity changed', 403);

  const history = await pagedScopedRows<Record<string, unknown>>(
    context.projections,
    { kind: 'scoped', table: 'dashboard_shares', ownerId: resolved.sender.id, limit: 100 },
    5_000
  );
  const matching = history.flatMap(row => {
    const parsed = dashboardShareV2Schema.safeParse(row.body);
    if (!parsed.success) return [];
    const share = parsed.data;
    return share.dashboardVersionId === version.id &&
      share.recipientIdentityId === resolved.recipient.id &&
      share.channel === payload.channel &&
      digest([...share.approvedBranchIds].sort()) === digest(branchIds)
      ? [{ row, share }]
      : [];
  });
  const active = matching.filter(item => item.share.status === 'active' &&
    Date.parse(item.share.expiresAt) > context.now().getTime());
  invariant(active.length <= 1, 'WORKFLOW_CALLBACK_CONTRACT', 'The share lifecycle is ambiguous');
  const semanticKey = active[0]?.share.semanticKey ?? semanticKeyForShare(
    version.id,
    resolved.recipient.id,
    branchIds,
    payload.channel,
    matching.length + 1
  );
  return {
    dashboard,
    version,
    branchIds,
    branches,
    expectedRows: mergeExpectedRows(resolved.expectedRows),
    sender: resolved.sender,
    recipient: resolved.recipient,
    semanticKey,
    activeExisting: active.length === 1
  };
}

function requireShareSigningKey(signing: DashboardShareSigningSnapshot): DashboardShareSigningSnapshot {
  const everyKeyMeetsMinimumLength = [...signing.sessionSigningSecrets.values()].every(secret =>
    (typeof secret === 'string' ? Buffer.byteLength(secret, 'utf8') : secret.byteLength) >= 32);
  // This is a minimum byte-length contract; it does not prove key entropy.
  invariant(signing.allowedKeyVersions.includes(signing.keyVersion) &&
    signing.sessionSigningSecrets.has(signing.keyVersion) && everyKeyMeetsMinimumLength,
  'WORKFLOW_UNAVAILABLE', 'Dashboard share signing configuration is unavailable', 503);
  return signing;
}

function shareBranchIds(target: TargetSpec): string[] {
  const ids = target.expectedRows.filter(row => row.ref.table === 'branches').map(row => row.ref.id);
  invariant(ids.length > 0 && new Set(ids).size === ids.length,
    'WORKFLOW_CALLBACK_CONTRACT', 'The approved share ceiling is missing or repeated');
  return ids.sort();
}

function shareVersionId(target: TargetSpec): string {
  const versions = target.expectedRows.filter(row => row.ref.table === 'dashboard_versions');
  invariant(versions.length === 1, 'WORKFLOW_CALLBACK_CONTRACT', 'The immutable dashboard version reference is missing');
  return versions[0].ref.id;
}

function shareDeliveryId(shareId: string): string {
  return 'delivery_' + shareId;
}

function shareScopeBranchId(shareId: string, branchId: string): string {
  return 'scope_' + digest({ purpose: 'dashboard-share-scope-branch/v1', shareId, branchId });
}

function shareDeliveryBody(body: string, shareId: string): string {
  return body + '\n\n' + shareBodyMarkerPrefix + shareId + ']]';
}

function approvedShareBody(
  action: Parameters<WorkflowRuntimeBinding['expectedPostconditions']>[0],
  target: TargetSpec,
  executionId: string,
  confirmedAt: string,
  signing: DashboardShareSigningSnapshot
): DashboardShareV2 {
  invariant(action.payload.kind === 'dashboard_share', 'WORKFLOW_CALLBACK_CONTRACT', 'Dashboard share payload did not match');
  const senderIdentityId = target.ownerIdentityId;
  invariant(senderIdentityId, 'WORKFLOW_CALLBACK_CONTRACT', 'The share sender identity was not frozen');
  const unsigned = {
    id: target.expectedEffectRef.id,
    dashboardId: action.payload.dashboardId,
    dashboardVersionId: shareVersionId(target),
    senderIdentityId,
    recipientIdentityId: action.payload.recipientIdentityId,
    approvedBranchIds: shareBranchIds(target),
    classification: 'internal' as const,
    keyVersion: signing.keyVersion,
    channel: action.payload.channel,
    policy: action.policy,
    status: 'active' as const,
    expiresAt: dashboardShareExpiresAt(new Date(instantSchema.parse(confirmedAt))),
    rowVersion: target.expectedEffectVersion,
    semanticKey: target.semanticKey,
    executionId,
    createdAt: instantSchema.parse(confirmedAt),
    revokedAt: null
  };
  const signed = signDashboardShare(unsigned, requireShareSigningKey(signing));
  return dashboardShareV2Schema.parse({ ...unsigned, verificationDigest: signed.verificationDigest });
}

function dashboardShareBinding(signing: DashboardShareSigningSnapshot): WorkflowRuntimeBinding<'dashboard_share'> {
  return defineWorkflowBinding({
    kind: 'dashboard_share',
    contractVersion: 2,
    packIds: dashboardPackIds,
    configurationRevision: dashboardShareConfigurationRevision(signing),
    executionMode: 'atomic_local',
    authority: { permission: 'dashboard.share', roles: [...salesRoles], purpose: 'sales_operations' },
    identify: async (context, payload) => {
      const identity = await resolveShareIdentity(context, payload);
      return {
        targets: [{
          targetId: targetId(identity.semanticKey),
          ref: { table: 'dashboard_versions', id: identity.version.id },
          semanticKey: identity.semanticKey,
          scope: { branchId: identity.branches[0].id }
        }]
      };
    },
    expectedPostconditions: (action, executionId, confirmedAt) => action.targets.map(target => {
      invariant(action.payload.kind === 'dashboard_share', 'WORKFLOW_CALLBACK_CONTRACT', 'Dashboard share payload did not match');
      const grant = approvedShareBody(action, target, executionId, confirmedAt, signing);
      const markerBody = shareDeliveryBody(action.payload.body, grant.id);
      const deliveryId = shareDeliveryId(grant.id);
      const branchRows: AttributionPostcondition[] = grant.approvedBranchIds.map(branchId => {
        const childId = shareScopeBranchId(grant.id, branchId);
        return {
          ref: { table: 'share_scope_branches', id: childId },
          rowVersion: 1,
          fields: fields({ id: childId, shareId: grant.id, branchId })
        };
      });
      const versionGuard = target.expectedRows.find(row =>
        row.ref.table === 'dashboard_versions' && row.ref.id === grant.dashboardVersionId);
      invariant(versionGuard, 'WORKFLOW_CALLBACK_CONTRACT', 'The immutable dashboard version guard was not prepared');
      branchRows.push({
        ref: versionGuard.ref,
        rowVersion: versionGuard.rowVersion,
        fields: fields({ id: grant.dashboardVersionId, dashboardId: grant.dashboardId, version: 1, ownerId: action.actorId })
      });
      branchRows.push({
        ref: { table: 'simulated_deliveries', id: deliveryId },
        rowVersion: 1,
        fields: fields({
          id: deliveryId,
          shareId: grant.id,
          recipientIdentityId: grant.recipientIdentityId,
          channel: grant.channel,
          subject: action.payload.subject,
          body: markerBody,
          status: 'simulated_completed',
          executionId,
          createdAt: grant.createdAt
        })
      });
      return expectedPostcondition(action, executionId, target, {
        id: grant.id,
        dashboardId: grant.dashboardId,
        dashboardVersionId: grant.dashboardVersionId,
        senderIdentityId: grant.senderIdentityId,
        recipientIdentityId: grant.recipientIdentityId,
        approvedBranchIds: grant.approvedBranchIds,
        classification: grant.classification,
        verificationDigest: grant.verificationDigest,
        keyVersion: grant.keyVersion,
        channel: grant.channel,
        policy: grant.policy,
        status: grant.status,
        expiresAt: grant.expiresAt,
        rowVersion: grant.rowVersion,
        semanticKey: grant.semanticKey,
        executionId: grant.executionId,
        createdAt: grant.createdAt,
        revokedAt: grant.revokedAt
      }, confirmedAt, branchRows);
    }),
    validate: async (baseContext, payload) => {
      const context = runtimeContext(baseContext);
      invariant(payload.kind === 'dashboard_share', 'WORKFLOW_CALLBACK_CONTRACT', 'Dashboard share payload did not match');
      requireShareSigningKey(signing);
      const identity = await resolveShareIdentity(context, payload);
      invariant(!identity.expectedRows.some(row => row.ref.table === 'dashboard_shares' && row.ref.id === payload.dashboardId),
        'WORKFLOW_CALLBACK_CONTRACT', 'A dashboard share guard is malformed');
      invariant(!payload.body.toLowerCase().includes(shareBodyMarkerPrefix.toLowerCase()),
        'WORKFLOW_INVALID_INPUT', 'The share body cannot supply a grant marker');
      invariant(/^[a-f0-9]{64}$/.test(identity.semanticKey),
        'WORKFLOW_CALLBACK_CONTRACT', 'The share semantic key was invalid');
      invariant(!identity.activeExisting, 'WORKFLOW_CONFLICT', 'An active equivalent dashboard share already exists', 409);
      const grantId = directoryIdentitySchema.shape.id.parse(createDashboardGrantId());
      invariant(shareDeliveryBody(payload.body, grantId).length <= 2_000,
        'WORKFLOW_INVALID_INPUT', 'The reviewed share body leaves no room for its share reference');
      const versionExpected = toExpectedRow('dashboard_versions', identity.version);
      const branchExpected = identity.branches.map(row => toExpectedRow('branches', row));
      const target: TargetSpec = {
        targetId: targetId(identity.semanticKey),
        ref: { table: 'dashboard_versions', id: identity.version.id },
        semanticKey: identity.semanticKey,
        expectedRows: mergeExpectedRows([versionExpected, ...branchExpected]),
        ownerIdentityId: identity.sender.id,
        expectedEffectRef: { table: 'dashboard_shares', id: grantId },
        expectedEffectVersion: 1
      };
      return makeValidation([target], [
        ...identity.expectedRows,
        toExpectedRow('dashboards', identity.dashboard),
        versionExpected,
        ...branchExpected
      ], identity.branchIds, identity.branches.flatMap(row => row.body.orgUnitId ? [row.body.orgUnitId] : []));
    },
    executeAtomic: async (baseContext, payload) => {
      const context = baseContext;
      invariant(payload.kind === 'dashboard_share', 'WORKFLOW_CALLBACK_CONTRACT', 'Dashboard share payload did not match');
      const target = targetById(context.action, context.action.targets[0]?.targetId ?? '');
      const identity = await resolveShareIdentity(context, payload);
      invariant(identity.semanticKey === target.semanticKey && target.expectedEffectRef.table === 'dashboard_shares' &&
        target.ownerIdentityId === identity.sender.id &&
        digest(shareBranchIds(target)) === digest(identity.branchIds),
      'WORKFLOW_STALE', 'The reviewed dashboard share ceiling changed', 409);
      context.assertPins(identity.version.body.packs);
      const grant = approvedShareBody(context.action, target, context.executionId,
        context.now().toISOString(), signing);
      const destinationIdentity = grant.channel === 'simulated_email'
        ? identity.recipient.verifiedDemoEmail
        : identity.recipient.slackIdentity;
      invariant(destinationIdentity, 'WORKFLOW_FORBIDDEN', 'The recipient has no verified destination for this channel', 403);
      const markerBody = shareDeliveryBody(payload.body, grant.id);
      invariant(markerBody.length <= 2_000, 'WORKFLOW_INVALID_INPUT', 'The share body exceeds the delivery limit');
      const shareInsert = await context.tx.insertUnique('dashboard_shares', grant, {
        constraint: 'dashboard_shares_semantic_unique',
        values: { semanticKey: grant.semanticKey }
      });
      invariant(shareInsert.inserted, 'WORKFLOW_CONFLICT', 'This dashboard share lifecycle already exists', 409);
      for (const branchId of grant.approvedBranchIds) {
        const childId = shareScopeBranchId(grant.id, branchId);
        const child = { id: childId, rowVersion: 1, shareId: grant.id, branchId };
        const inserted = await context.tx.insertUnique('share_scope_branches', child, {
          constraint: 'share_scope_branches_share_branch_unique',
          values: { shareId: grant.id, branchId }
        });
        invariant(inserted.inserted, 'WORKFLOW_CONFLICT', 'A share ceiling row already exists', 409);
      }
      const delivery: SimulatedDelivery = {
        id: shareDeliveryId(grant.id),
        shareId: grant.id,
        recipientIdentityId: grant.recipientIdentityId,
        channel: grant.channel,
        destinationIdentity,
        subject: payload.subject,
        body: markerBody,
        status: 'simulated_completed',
        executionId: context.executionId,
        createdAt: grant.createdAt
      };
      const deliveryInsert = await context.tx.insertUnique('simulated_deliveries', delivery, {
        constraint: 'simulated_deliveries_execution_unique',
        values: { executionId: context.executionId }
      });
      invariant(deliveryInsert.inserted, 'WORKFLOW_CONFLICT', 'The simulated delivery already exists', 409);
      return [{
        targetId: target.targetId,
        ref: target.expectedEffectRef,
        executionId: context.executionId,
        rowVersion: target.expectedEffectVersion
      }];
    },
    verify: async (baseContext, committed) => {
      const context = baseContext;
      const output = [];
      for (const result of committed) {
        const target = context.action.targets.find(item => item.targetId === result.targetId);
        const action = context.action;
        const execution = await context.projections.get<{ createdAt: string }>('action_executions', context.executionId);
        if (!target || action.payload.kind !== 'dashboard_share' || !execution) {
          output.push(proof(result.targetId, result.ref, context.executionId, null,
            context.now().toISOString(), 'failed', ['DASHBOARD_SHARE_APPROVAL_MISMATCH']));
          continue;
        }
        const expected = approvedShareBody(action, target, context.executionId, execution.body.createdAt, signing);
        const observed = await context.projections.get<Record<string, unknown>>('dashboard_shares', result.ref.id);
        const parsed = dashboardShareV2Schema.safeParse(observed?.body);
        const delivery = await context.projections.get<SimulatedDelivery>('simulated_deliveries', shareDeliveryId(expected.id));
        const versionRow = await context.projections.get<DashboardVersionBody>('dashboard_versions', expected.dashboardVersionId);
        if (!versionRow) {
          output.push(proof(result.targetId, result.ref, context.executionId, observed?.rowVersion ?? null,
            context.now().toISOString(), 'stale', ['DASHBOARD_VERSION_UNAVAILABLE']));
          continue;
        }
        const resolved = await resolveDashboardShareScope(context.projections, {
          senderIdentityId: expected.senderIdentityId,
          recipientIdentityId: expected.recipientIdentityId,
          spec: versionRow.body.spec,
          channel: expected.channel
        });
        const destination = expected.channel === 'simulated_email'
          ? resolved.recipient.verifiedDemoEmail
          : resolved.recipient.slackIdentity;
        let childrenValid = true;
        for (const branchId of expected.approvedBranchIds) {
          const childId = shareScopeBranchId(expected.id, branchId);
          const child = await context.projections.get<{ id: string; shareId: string; branchId: string }>('share_scope_branches', childId);
          if (!child || child.body.shareId !== expected.id || child.body.branchId !== branchId) childrenValid = false;
        }
        const checkedAt = context.now().toISOString();
        if (!parsed.success || !observed || observed.rowVersion !== result.rowVersion ||
          digest(parsed.data) !== digest(expected) ||
          versionRow.body.id !== expected.dashboardVersionId ||
          versionRow.body.dashboardId !== expected.dashboardId || versionRow.body.digest !== versionDigest(versionRow.body) ||
          digest(resolved.branchIds.slice().sort()) !== digest(expected.approvedBranchIds) ||
          !childrenValid || !delivery || delivery.rowVersion !== 1 ||
          delivery.body.shareId !== expected.id || delivery.body.recipientIdentityId !== expected.recipientIdentityId ||
          delivery.body.channel !== expected.channel || delivery.body.subject !== action.payload.subject ||
          delivery.body.body !== shareDeliveryBody(action.payload.body, expected.id) ||
          delivery.body.destinationIdentity !== destination || delivery.body.status !== 'simulated_completed' ||
          delivery.body.executionId !== context.executionId || delivery.body.createdAt !== expected.createdAt) {
          output.push(proof(result.targetId, result.ref, context.executionId, observed?.rowVersion ?? null,
            checkedAt, 'stale', ['DASHBOARD_SHARE_READBACK_MISMATCH']));
          continue;
        }
        output.push(proof(result.targetId, result.ref, context.executionId, observed.rowVersion,
          checkedAt, 'verified_success'));
      }
      return output;
    },
    currentStates: async (baseContext, refs) => currentStates(baseContext, refs)
  }) as WorkflowRuntimeBinding<'dashboard_share'>;
}

const dashboardShareRevokeBinding = defineWorkflowBinding({
  kind: 'dashboard_share_revoke',
  contractVersion: 2,
  packIds: dashboardPackIds,
  executionMode: 'atomic_local',
  configurationRevision: SHARE_REVOKE_EVENT_ID_REVISION,
  authority: { permission: 'dashboard.share', roles: [...salesRoles], purpose: 'sales_operations' },
  identify: async (context, payload) => {
    requirePermissions(context.actor, ['sales.read', 'operations.read']);
    const share = await loadShare(context, payload.shareId);
    invariant(share.body.senderIdentityId === context.principal.directory.id && share.body.recipientIdentityId !== '',
      'WORKFLOW_FORBIDDEN', 'Only the current grant sender may revoke it', 403);
    invariant(share.body.approvedBranchIds.length > 0,
      'WORKFLOW_STALE', 'The dashboard share has no approved branch ceiling', 409);
    const branchRows = await Promise.all(share.body.approvedBranchIds.map(async branchId =>
      projectionRow(await context.projections.get<BranchBody>('branches', branchId), branchId, 'Share branch')
    ));
    requireSalesScope(context.principal, 'dashboard.share', scopeTargets(branchRows));
    const dashboard = await context.projections.get<Dashboard>('dashboards', share.body.dashboardId);
    invariant(dashboard && dashboard.id === share.body.dashboardId && dashboard.body.ownerId === context.actor.id,
      'WORKFLOW_FORBIDDEN', 'Only the current dashboard owner may revoke this grant', 403);
    const semanticKey = semanticKeyForShareRevoke(share.id);
    return {
      targets: [{
        targetId: targetId(semanticKey),
        ref: { table: 'dashboard_shares', id: share.id },
        semanticKey,
        scope: { branchId: branchRows[0].id }
      }]
    };
  },
  expectedPostconditions: (action, executionId, confirmedAt) => action.targets.map(target => {
    invariant(action.payload.kind === 'dashboard_share_revoke', 'WORKFLOW_CALLBACK_CONTRACT', 'Share revoke payload did not match');
    const revokedAt = instantSchema.parse(confirmedAt);
    const shareId = target.expectedEffectRef.id;
    const priorShare = target.expectedRows.find(row => row.ref.table === 'dashboard_shares' && row.ref.id === shareId);
    invariant(target.expectedEffectRef.table === 'dashboard_shares' && priorShare &&
      target.expectedEffectVersion === priorShare.rowVersion + 1,
    'WORKFLOW_CALLBACK_CONTRACT', 'The reviewed share version is unavailable');
    const eventId = dashboardShareRevokeEventIdV1(executionId, shareId);
    return expectedPostcondition(action, executionId, target, {
      id: shareId,
      status: 'revoked',
      revokedAt
    }, confirmedAt, [{
      ref: { table: 'dashboard_share_revoke_events', id: eventId },
      rowVersion: 1,
      fields: fields({
        shareId,
        actorId: action.actorId,
        executionId,
        priorShareRowVersion: priorShare.rowVersion,
        revokedShareRowVersion: target.expectedEffectVersion,
        createdAt: revokedAt,
        rowVersion: 1
      })
    }]);
  }),
  validate: async (baseContext, payload) => {
    const context = runtimeContext(baseContext);
    requirePermissions(context.actor, ['sales.read', 'operations.read']);
    const share = await loadShare(context, payload.shareId);
    invariant(share.body.status === 'active' && share.body.senderIdentityId === context.principal.directory.id,
      'WORKFLOW_STALE', 'Only an owned active share can be revoked', 409);
    const branchRows = await Promise.all(share.body.approvedBranchIds.map(async branchId =>
      projectionRow(await context.projections.get<BranchBody>('branches', branchId), branchId, 'Share branch')
    ));
    requireSalesScope(context.principal, 'dashboard.share', scopeTargets(branchRows));
    const dashboardRow = projectionRow(
      await context.projections.get<Dashboard>('dashboards', share.body.dashboardId),
      share.body.dashboardId,
      'Shared dashboard'
    );
    invariant(dashboardRow.body.ownerId === context.actor.id, 'WORKFLOW_FORBIDDEN', 'The dashboard owner changed', 403);
    const semanticKey = semanticKeyForShareRevoke(share.id);
    const target: TargetSpec = {
      targetId: targetId(semanticKey),
      ref: { table: 'dashboard_shares', id: share.id },
      semanticKey,
      expectedRows: mergeExpectedRows([
        toExpectedRow('dashboard_shares', share),
        toExpectedRow('dashboards', dashboardRow),
        ...branchRows.map(row => toExpectedRow('branches', row))
      ]),
      ownerIdentityId: context.principal.directory.id,
      expectedEffectRef: { table: 'dashboard_shares', id: share.id },
      expectedEffectVersion: share.rowVersion + 1
    };
    return makeValidation([target], [], branchRows.map(row => row.id));
  },
  executeAtomic: async (baseContext, payload) => {
    const context = baseContext;
    invariant(payload.kind === 'dashboard_share_revoke', 'WORKFLOW_CALLBACK_CONTRACT', 'Share revoke payload did not match');
    const target = targetById(context.action, context.action.targets[0]?.targetId ?? '');
    const share = await loadShare(context, payload.shareId);
    invariant(target.expectedEffectRef.id === share.id && share.body.status === 'active' &&
      share.body.senderIdentityId === context.principal.directory.id && context.actor.id === context.action.actorId,
    'WORKFLOW_STALE', 'The share is no longer eligible for revocation', 409);
    const branchRows = await Promise.all(share.body.approvedBranchIds.map(async branchId =>
      projectionRow(await context.projections.get<BranchBody>('branches', branchId), branchId, 'Share branch')
    ));
    requirePermissions(context.actor, ['sales.read', 'operations.read']);
    requireSalesScope(context.principal, 'dashboard.share', scopeTargets(branchRows));
    const dashboard = projectionRow(
      await context.projections.get<Dashboard>('dashboards', share.body.dashboardId),
      share.body.dashboardId,
      'Shared dashboard'
    );
    invariant(dashboard.body.ownerId === context.actor.id, 'WORKFLOW_FORBIDDEN', 'The dashboard owner changed', 403);
    const revokedAt = context.now().toISOString();
    const changed = await context.tx.compareAndSwap('dashboard_shares', share.id,
      { rowVersion: share.rowVersion, state: 'active' },
      { ...share.body, rowVersion: share.rowVersion + 1, status: 'revoked', revokedAt });
    invariant(changed.updated && changed.row.rowVersion === target.expectedEffectVersion,
      'WORKFLOW_STALE', 'The owned active share changed before revocation', 409);
    const revokeEvent: DashboardShareRevokeEvent = dashboardShareRevokeEventSchema.parse({
      id: dashboardShareRevokeEventIdV1(context.executionId, share.id),
      shareId: share.id,
      actorId: context.actor.id,
      executionId: context.executionId,
      shareCreationExecutionId: share.body.executionId,
      priorShareRowVersion: share.rowVersion,
      revokedShareRowVersion: changed.row.rowVersion,
      createdAt: revokedAt,
      rowVersion: 1
    });
    const eventInsert = await context.tx.insertUnique('dashboard_share_revoke_events', revokeEvent, {
      constraint: 'dashboard_share_revoke_events_primary_key',
      values: { id: revokeEvent.id }
    });
    invariant(eventInsert.inserted, 'WORKFLOW_CONFLICT', 'The dashboard share revoke event already exists', 409);
    return [{ targetId: target.targetId, ref: target.expectedEffectRef, executionId: context.executionId, rowVersion: changed.row.rowVersion }];
  },
  verify: async (baseContext, committed) => {
    const context = baseContext;
    const proofs = [];
    for (const result of committed) {
      const target = context.action.targets.find(item => item.targetId === result.targetId);
      const row = await context.projections.get<Record<string, unknown>>('dashboard_shares', result.ref.id);
      const parsed = dashboardShareV2Schema.safeParse(row?.body);
      const execution = await context.projections.get<{ createdAt: string }>('action_executions', context.executionId);
      const priorShare = target?.expectedRows.find(expected =>
        expected.ref.table === 'dashboard_shares' && expected.ref.id === result.ref.id);
      const eventId = dashboardShareRevokeEventIdV1(context.executionId, result.ref.id);
      const eventRow = await context.projections.get<Record<string, unknown>>('dashboard_share_revoke_events', eventId);
      const event = dashboardShareRevokeEventSchema.safeParse(eventRow?.body);
      if (!row || !parsed.success || parsed.data.status !== 'revoked' ||
        parsed.data.senderIdentityId !== context.principal.directory.id ||
        parsed.data.revokedAt !== execution?.body.createdAt ||
        row.rowVersion !== result.rowVersion || result.executionId !== context.executionId ||
        context.actor.id !== context.action.actorId || !target || !priorShare ||
        target.expectedEffectRef.table !== 'dashboard_shares' || target.expectedEffectRef.id !== result.ref.id ||
        target.expectedEffectVersion !== result.rowVersion ||
        !eventRow || !event.success || eventRow.rowVersion !== 1 ||
        event.data.id !== eventId || event.data.shareId !== result.ref.id ||
        event.data.actorId !== context.action.actorId || event.data.executionId !== context.executionId ||
        event.data.shareCreationExecutionId !== parsed.data.executionId ||
        event.data.priorShareRowVersion !== priorShare.rowVersion ||
        event.data.revokedShareRowVersion !== result.rowVersion ||
        event.data.createdAt !== execution?.body.createdAt || event.data.rowVersion !== 1) {
        proofs.push(proof(result.targetId, result.ref, context.executionId, row?.rowVersion ?? null,
          context.now().toISOString(), 'stale', ['SHARE_REVOKE_READBACK_MISMATCH']));
        continue;
      }
      proofs.push(proof(result.targetId, result.ref, context.executionId, row.rowVersion,
        context.now().toISOString(), 'verified_success'));
    }
    return proofs;
  },
  currentStates: async (baseContext, refs) => shareRevokeCurrentStates(baseContext, refs)
}) as WorkflowRuntimeBinding<'dashboard_share_revoke'>;

const crmFollowupBinding = defineWorkflowBinding({
  kind: 'crm_followup_create',
  contractVersion: 2,
  packIds: salesPackIds,
  executionMode: 'atomic_local',
  authority: { permission: 'crm.followup.create', roles: [...salesRoles], purpose: 'sales_operations' },
  identify: async (baseContext, payload) => {
    invariant(payload.kind === 'crm_followup_create', 'WORKFLOW_CALLBACK_CONTRACT', 'CRM follow-up payload did not match');
    const context = runtimeContext(baseContext);
    requirePermissions(context.actor, ['crm.read', 'crm.followup.create']);
    const sources = await Promise.all(payload.targets.map(item => loadOpportunitySources(context, item.opportunityId)));
    return {
      targets: payload.targets.map((item, index) => {
        const source = sources[index];
        invariant(source, 'WORKFLOW_CALLBACK_CONTRACT', 'An identified CRM opportunity was unavailable');
        const semanticKey = crmFollowupSemantic(source.opportunity.body);
        requireSalesScope(context.principal, 'crm.followup.create', [{ orgUnitId: source.orgUnitId }]);
        return {
          targetId: targetId(semanticKey),
          ref: { table: 'crm_opportunities', id: source.opportunity.id },
          semanticKey,
          scope: { orgUnitId: source.orgUnitId }
        };
      })
    };
  },
  expectedPostconditions: (action, executionId, confirmedAt) => {
    const payload = action.payload;
    invariant(payload.kind === 'crm_followup_create', 'WORKFLOW_CALLBACK_CONTRACT', 'CRM follow-up payload did not match');
    return action.targets.map(target => {
      const item = payload.targets.find(value => value.opportunityId === target.ref.id);
      invariant(item, 'WORKFLOW_CALLBACK_CONTRACT', 'The reviewed CRM follow-up target was unavailable');
      const source = target.expectedRows.find(row =>
        row.ref.table === 'crm_opportunities' && row.ref.id === item.opportunityId);
      invariant(source && source.state !== null, 'WORKFLOW_CALLBACK_CONTRACT', 'The reviewed CRM opportunity guard was not frozen');
      const sourceGuard: AttributionPostcondition = {
        ref: source.ref,
        rowVersion: source.rowVersion,
        fields: fields({ id: item.opportunityId, ownerIdentityId: item.ownerIdentityId, stage: source.state })
      };
      return expectedPostcondition(action, executionId, target, {
        id: target.expectedEffectRef.id,
        opportunityId: item.opportunityId,
        ownerIdentityId: item.ownerIdentityId,
        status: 'open',
        dueDate: item.dueDate,
        reason: item.reason,
        priority: item.priority,
        executionId,
        createdAt: instantSchema.parse(confirmedAt)
      }, confirmedAt, [sourceGuard]);
    });
  },
  validate: async (baseContext, payload) => {
    const context = runtimeContext(baseContext);
    invariant(payload.kind === 'crm_followup_create', 'WORKFLOW_CALLBACK_CONTRACT', 'CRM follow-up payload did not match');
    requirePermissions(context.actor, ['crm.read', 'crm.followup.create']);
    const sources = await Promise.all(payload.targets.map(item => loadOpportunitySources(context, item.opportunityId)));
    const targets: TargetSpec[] = [];
    const allExpectedRows: ExpectedRow[] = [];
    const approvedOrgUnitIds: string[] = [];
    for (let index = 0; index < payload.targets.length; index += 1) {
      const item = payload.targets[index];
      const source = sources[index];
      invariant(item && source, 'WORKFLOW_CALLBACK_CONTRACT', 'A CRM follow-up target was unavailable');
      const opportunity = source.opportunity.body;
      requireSalesScope(context.principal, 'crm.followup.create', [{ orgUnitId: source.orgUnitId }]);
      invariant(['prospecting', 'qualified', 'proposal', 'negotiation'].includes(opportunity.stage),
        'WORKFLOW_STALE', 'CRM follow-ups require an open opportunity', 409);
      invariant(item.ownerIdentityId === opportunity.ownerIdentityId,
        'WORKFLOW_STALE', 'The follow-up owner must be the current sales owner', 409);
      const existingRows = await crmFollowupsForOpportunity(context, opportunity.id);
      invariant(!existingRows.some(row => row.body.status === 'open'),
        'WORKFLOW_CONFLICT', 'The opportunity already has an open follow-up', 409);
      const semanticKey = crmFollowupSemantic(opportunity);
      const expectedRows = mergeExpectedRows(source.expectedRows,
        existingRows.map(row => toExpectedRow('crm_followups', row)));
      targets.push({
        targetId: targetId(semanticKey),
        ref: { table: 'crm_opportunities', id: opportunity.id },
        semanticKey,
        expectedRows,
        ownerIdentityId: source.owner.id,
        expectedEffectRef: { table: 'crm_followups', id: id('crm_followup') },
        expectedEffectVersion: 1
      });
      allExpectedRows.push(...expectedRows);
      approvedOrgUnitIds.push(source.orgUnitId);
    }
    return makeValidation(targets, allExpectedRows, [], approvedOrgUnitIds);
  },
  executeAtomic: async (baseContext, payload) => {
    const context = baseContext;
    invariant(payload.kind === 'crm_followup_create', 'WORKFLOW_CALLBACK_CONTRACT', 'CRM follow-up payload did not match');
    requirePermissions(context.actor, ['crm.read', 'crm.followup.create']);
    invariant(context.actor.id === context.action.actorId,
      'WORKFLOW_FORBIDDEN', 'The current actor does not own this prepared follow-up', 403);
    const sources = await Promise.all(payload.targets.map(item => loadOpportunitySources(context, item.opportunityId)));
    const prepared: { item: typeof payload.targets[number]; source: OpportunitySources; target: TargetSpec }[] = [];
    for (let index = 0; index < payload.targets.length; index += 1) {
      const item = payload.targets[index];
      const source = sources[index];
      invariant(item && source, 'WORKFLOW_CALLBACK_CONTRACT', 'A CRM follow-up target was unavailable');
      const opportunity = source.opportunity.body;
      requireSalesScope(context.principal, 'crm.followup.create', [{ orgUnitId: source.orgUnitId }]);
      invariant(['prospecting', 'qualified', 'proposal', 'negotiation'].includes(opportunity.stage) &&
        item.ownerIdentityId === opportunity.ownerIdentityId,
      'WORKFLOW_STALE', 'The opportunity or current follow-up owner changed', 409);
      const semanticKey = crmFollowupSemantic(opportunity);
      const target = targetById(context.action, targetId(semanticKey));
      invariant(target.expectedEffectRef.table === 'crm_followups' && target.expectedEffectVersion === 1 &&
        target.ref.table === 'crm_opportunities' && target.ref.id === opportunity.id,
      'WORKFLOW_STALE', 'The reviewed follow-up target changed', 409);
      const existingRows = await crmFollowupsForOpportunity(context, opportunity.id);
      invariant(!existingRows.some(row => row.body.status === 'open'),
        'WORKFLOW_CONFLICT', 'The opportunity already has an open follow-up', 409);
      prepared.push({ item, source, target });
    }
    const createdAt = context.now().toISOString();
    const committed = [];
    for (const { item, source, target } of prepared) {
      const row: CrmFollowupBody & { rowVersion: number } = {
        id: target.expectedEffectRef.id,
        rowVersion: target.expectedEffectVersion,
        opportunityId: item.opportunityId,
        ownerIdentityId: item.ownerIdentityId,
        status: 'open',
        dueDate: item.dueDate,
        reason: item.reason,
        priority: item.priority,
        executionId: context.executionId,
        createdAt
      };
      const inserted = await context.tx.insertUnique('crm_followups', row, {
        constraint: 'crm_followups_open_equivalent_unique',
        values: { opportunityId: source.opportunity.id, ownerIdentityId: item.ownerIdentityId, dueDate: item.dueDate }
      });
      invariant(inserted.inserted, 'WORKFLOW_CONFLICT', 'An equivalent open CRM follow-up already exists', 409);
      committed.push({ targetId: target.targetId, ref: target.expectedEffectRef,
        executionId: context.executionId, rowVersion: target.expectedEffectVersion });
    }
    return committed;
  },
  verify: async (baseContext, committed) => {
    const context = baseContext;
    const proofs = [];
    for (const result of committed) {
      const row = await context.projections.get<CrmFollowupBody>('crm_followups', result.ref.id);
      const target = context.action.targets.find(item => item.targetId === result.targetId);
      const payload = context.action.payload;
      const item = payload.kind === 'crm_followup_create' ?
        payload.targets.find(value => value.opportunityId === target?.ref.id) : undefined;
      const execution = await context.projections.get<{ createdAt: string }>('action_executions', context.executionId);
      const sourceGuard = item && target?.expectedRows.find(expected =>
        expected.ref.table === 'crm_opportunities' && expected.ref.id === item.opportunityId);
      if (!row || !target || !item || !sourceGuard || payload.kind !== 'crm_followup_create' ||
        row.rowVersion !== result.rowVersion || result.rowVersion !== target.expectedEffectVersion ||
        target.expectedEffectRef.table !== result.ref.table || target.expectedEffectRef.id !== result.ref.id ||
        row.body.id !== result.ref.id || row.body.opportunityId !== item.opportunityId ||
        row.body.ownerIdentityId !== item.ownerIdentityId || row.body.status !== 'open' ||
        row.body.dueDate !== item.dueDate || row.body.reason !== item.reason || row.body.priority !== item.priority ||
        row.body.executionId !== context.executionId || !execution || row.body.createdAt !== execution.body.createdAt ||
        context.actor.id !== context.action.actorId || result.executionId !== context.executionId ||
        sourceGuard.state === null) {
        proofs.push(proof(result.targetId, result.ref, context.executionId, row?.rowVersion ?? null,
          context.now().toISOString(), 'stale', ['CRM_FOLLOWUP_READBACK_MISMATCH']));
        continue;
      }
      proofs.push(proof(result.targetId, result.ref, context.executionId, row.rowVersion,
        context.now().toISOString(), 'verified_success'));
    }
    return proofs;
  },
  currentStates: async (baseContext, refs) => currentStates(baseContext, refs)
}) as WorkflowRuntimeBinding<'crm_followup_create'>;

const discountRequestBinding = defineWorkflowBinding({
  kind: 'discount_request_create',
  contractVersion: 2,
  packIds: salesPackIds,
  executionMode: 'atomic_local',
  authority: { permission: 'discount.request.create', roles: [...salesRoles], purpose: 'sales_operations' },
  identify: async (context, payload) => {
    requirePermissions(context.actor, ['crm.read', 'discount.request.create']);
    const source = await loadOpportunitySources(context, payload.opportunityId);
    requireSalesScope(context.principal, 'discount.request.create', [{ orgUnitId: source.orgUnitId }]);
    const semanticKey = discountSemantic(source.opportunity.body, payload.requestedBasisPoints, payload.baseAmountSatang);
    return {
      targets: [{
        targetId: targetId(semanticKey),
        ref: { table: 'crm_opportunities', id: source.opportunity.id },
        semanticKey,
        scope: { orgUnitId: source.orgUnitId }
      }]
    };
  },
  expectedPostconditions: (action, executionId, confirmedAt) => action.targets.map(target => {
    const payload = action.payload;
    invariant(payload.kind === 'discount_request_create', 'WORKFLOW_CALLBACK_CONTRACT', 'Discount payload did not match');
    const source = target.expectedRows.find(row =>
      row.ref.table === 'crm_opportunities' && row.ref.id === payload.opportunityId);
    invariant(source, 'WORKFLOW_CALLBACK_CONTRACT', 'The reviewed opportunity guard was not frozen');
    invariant(source.state !== null, 'WORKFLOW_CALLBACK_CONTRACT', 'The reviewed opportunity state was not frozen');
    const opportunityGuard: AttributionPostcondition = {
      ref: source.ref,
      rowVersion: source.rowVersion,
      fields: fields({
        id: payload.opportunityId,
        ownerIdentityId: payload.ownerIdentityId,
        amountSatang: payload.baseAmountSatang,
        stage: source.state
      })
    };
    return expectedPostcondition(action, executionId, target, {
      id: target.expectedEffectRef.id,
      opportunityId: payload.opportunityId,
      ownerIdentityId: payload.ownerIdentityId,
      status: demoWorkflowPolicyV1.discount.initialStage,
      discountBasisPoints: payload.requestedBasisPoints,
      baseAmountSatang: payload.baseAmountSatang,
      reason: payload.reason,
      executionId,
      createdAt: instantSchema.parse(confirmedAt)
    }, confirmedAt, [opportunityGuard]);
  }),
  validate: async (baseContext, payload) => {
    const context = runtimeContext(baseContext);
    invariant(payload.kind === 'discount_request_create', 'WORKFLOW_CALLBACK_CONTRACT', 'Discount payload did not match');
    requirePermissions(context.actor, ['crm.read', 'discount.request.create']);
    const source = await loadOpportunitySources(context, payload.opportunityId);
    const opportunity = source.opportunity.body;
    requireSalesScope(context.principal, 'discount.request.create', [{ orgUnitId: source.orgUnitId }]);
    invariant(['prospecting', 'qualified', 'proposal', 'negotiation'].includes(opportunity.stage),
      'WORKFLOW_STALE', 'Discount requests require an open opportunity', 409);
    invariant(payload.ownerIdentityId === opportunity.ownerIdentityId,
      'WORKFLOW_STALE', 'The discount owner must be the current sales owner', 409);
    invariant(Number.isSafeInteger(opportunity.amountSatang) && payload.baseAmountSatang === opportunity.amountSatang,
      'WORKFLOW_STALE', 'The reviewed base amount no longer matches the opportunity', 409);
    invariant(payload.requestedBasisPoints >= demoWorkflowPolicyV1.discount.minBasisPoints &&
      payload.requestedBasisPoints <= demoWorkflowPolicyV1.discount.maxBasisPoints,
    'WORKFLOW_INVALID_INPUT', 'The requested discount is outside the current policy');
    const pending = await context.projections.query<DiscountRequestBody>({
      kind: 'unique',
      table: 'discount_requests',
      constraint: 'discount_requests_open_opportunity_unique',
      values: { opportunityId: opportunity.id }
    });
    invariant(pending.length === 0, 'WORKFLOW_CONFLICT', 'The opportunity already has a pending discount request', 409);
    const semanticKey = discountSemantic(opportunity, payload.requestedBasisPoints, payload.baseAmountSatang);
    const target: TargetSpec = {
      targetId: targetId(semanticKey),
      ref: { table: 'crm_opportunities', id: opportunity.id },
      semanticKey,
      expectedRows: source.expectedRows,
      ownerIdentityId: source.owner.id,
      expectedEffectRef: { table: 'discount_requests', id: id('discount_request') },
      expectedEffectVersion: 1
    };
    return makeValidation([target], [], [], [source.orgUnitId]);
  },
  executeAtomic: async (baseContext, payload) => {
    const context = baseContext;
    invariant(payload.kind === 'discount_request_create', 'WORKFLOW_CALLBACK_CONTRACT', 'Discount payload did not match');
    requirePermissions(context.actor, ['crm.read', 'discount.request.create']);
    const target = targetById(context.action, context.action.targets[0]?.targetId ?? '');
    const source = await loadOpportunitySources(context, payload.opportunityId);
    const opportunity = source.opportunity.body;
    invariant(context.actor.id === context.action.actorId && target.expectedEffectRef.table === 'discount_requests' &&
      target.expectedEffectVersion === 1 &&
      payload.ownerIdentityId === opportunity.ownerIdentityId &&
      Number.isSafeInteger(opportunity.amountSatang) && payload.baseAmountSatang === opportunity.amountSatang &&
      ['prospecting', 'qualified', 'proposal', 'negotiation'].includes(opportunity.stage),
    'WORKFLOW_STALE', 'The opportunity or reviewed discount basis changed', 409);
    requirePermissions(context.actor, ['crm.read', 'discount.request.create']);
    requireSalesScope(context.principal, 'discount.request.create', [{ orgUnitId: source.orgUnitId }]);
    const pending = await context.projections.query<DiscountRequestBody>({
      kind: 'unique',
      table: 'discount_requests',
      constraint: 'discount_requests_open_opportunity_unique',
      values: { opportunityId: opportunity.id }
    });
    invariant(pending.length === 0, 'WORKFLOW_CONFLICT', 'The opportunity already has a pending discount request', 409);
    const createdAt = context.now().toISOString();
    const row: DiscountRequestBody & { rowVersion: number } = {
      id: target.expectedEffectRef.id,
      rowVersion: target.expectedEffectVersion,
      opportunityId: opportunity.id,
      ownerIdentityId: opportunity.ownerIdentityId,
      status: demoWorkflowPolicyV1.discount.initialStage,
      discountBasisPoints: payload.requestedBasisPoints,
      baseAmountSatang: payload.baseAmountSatang,
      reason: payload.reason,
      executionId: context.executionId,
      createdAt
    };
    const inserted = await context.tx.insertUnique('discount_requests', row, {
      constraint: 'discount_requests_open_opportunity_unique',
      values: { opportunityId: opportunity.id }
    });
    invariant(inserted.inserted, 'WORKFLOW_CONFLICT', 'A pending discount request already exists', 409);
    return [{ targetId: target.targetId, ref: target.expectedEffectRef, executionId: context.executionId, rowVersion: 1 }];
  },
  verify: async (baseContext, committed) => {
    const context = baseContext;
    const proofs = [];
    for (const result of committed) {
      const row = await context.projections.get<DiscountRequestBody>('discount_requests', result.ref.id);
      const target = context.action.targets.find(item => item.targetId === result.targetId);
      const payload = context.action.payload;
      if (!row || !target || payload.kind !== 'discount_request_create' ||
        row.rowVersion !== result.rowVersion || row.body.id !== result.ref.id ||
        result.ref.table !== target.expectedEffectRef.table || result.ref.id !== target.expectedEffectRef.id ||
        result.rowVersion !== target.expectedEffectVersion ||
        row.body.status !== demoWorkflowPolicyV1.discount.initialStage ||
        row.body.opportunityId !== payload.opportunityId ||
        row.body.ownerIdentityId !== payload.ownerIdentityId ||
        row.body.discountBasisPoints !== payload.requestedBasisPoints ||
        row.body.baseAmountSatang !== payload.baseAmountSatang ||
        row.body.reason !== payload.reason || row.body.executionId !== context.executionId ||
        context.actor.id !== context.action.actorId ||
        sourceRowVersion(context.action.targets, payload.opportunityId) === undefined) {
        proofs.push(proof(result.targetId, result.ref, context.executionId, row?.rowVersion ?? null,
          context.now().toISOString(), 'stale', ['DISCOUNT_REQUEST_READBACK_MISMATCH']));
        continue;
      }
      proofs.push(proof(result.targetId, result.ref, context.executionId, row.rowVersion,
        context.now().toISOString(), 'verified_success'));
    }
    return proofs;
  },
  currentStates: async (baseContext, refs) => currentStates(baseContext, refs)
}) as WorkflowRuntimeBinding<'discount_request_create'>;

function sourceRowVersion(targets: readonly TargetSpec[], opportunityId: string): number | undefined {
  return targets.flatMap(target => target.expectedRows).find(row =>
    row.ref.table === 'crm_opportunities' && row.ref.id === opportunityId)?.rowVersion;
}

export function createSalesWorkflowBindings(options: SalesWorkflowBindingOptions): WorkflowRuntimeBinding[] {
  const signing = snapshotDashboardShareSigning(options.dashboardShareSigning);
  requireShareSigningKey(signing);
  return [
    dashboardCreateBinding as WorkflowRuntimeBinding,
    dashboardShareBinding(signing) as WorkflowRuntimeBinding,
    dashboardShareRevokeBinding as WorkflowRuntimeBinding,
    crmFollowupBinding as WorkflowRuntimeBinding,
    discountRequestBinding as WorkflowRuntimeBinding
  ];
}

export function createSalesWorkflowBindingsWithoutShare(): WorkflowRuntimeBinding[] {
  return [
    dashboardCreateBinding as WorkflowRuntimeBinding,
    dashboardShareRevokeBinding as WorkflowRuntimeBinding,
    crmFollowupBinding as WorkflowRuntimeBinding,
    discountRequestBinding as WorkflowRuntimeBinding
  ];
}
