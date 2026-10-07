import 'server-only';

import { DomainError, invariant } from '../core/errors';
import { canonical, digest, pendingActionApprovalHash } from '../core/utils';
import { createSeedData } from './generate';
import { type Branch, type Employee, type Profile, type SeedData, type Store, type PendingAction, type Receipt, type Inventory, type Incident } from '../contracts';
import { actionPayloadSchema } from '../core/action-schema';
import { expectedInventory, expectedIncident, verifyDemo } from '../packs/operations-runtime';
import {
  addBangkokCalendarDays,
  demoWorkflowPolicyV1,
  demoWorkflowPolicyV1Digest,
  getBangkokCalendarDate,
} from '../workflows/policy';
import {
  instantSchema,
  isoDateSchema,
  onboardingRequestSchema,
  workflowReceiptV2Schema,
  type ISODate,
  type OnboardingRequest,
  type WorkflowReceiptV2,
  type WorkflowStorageTable,
} from '../workflows/contracts';
import type {
  WorkflowProjectionReader,
  ProjectedRow,
  WorkflowStoreCapability,
  WorkflowTransactionContext,
} from '../storage/workflow-projections';
import { getWorkflowProjection, validateWorkflowProjectionBody } from '../storage/workflow-projections';
import { getStorageFailureMetadata, type StorageFailureMetadata } from '../storage/read-error';
import { withReadSnapshot } from '../storage/read-snapshot';

const WORKFLOW_V2_SEED_VERSION = 2;
const ACTION_DEMO_TARGET_COUNT = 20;
const ONBOARDING_DEMO_REQUEST_COUNT = 2;
const ONBOARDING_READY_REQUEST_INDEX = 0;
const SYNTHETIC_SEED_NAMESPACE = 'biztania.workflow-v2.synthetic-seed';
const SYNTHETIC_SEED_GENERATOR = 'lib/seed/generate.ts:createSeedData';
const SEED_CHUNK_SIZE = 250;
// Completed phase certificates bind initial population; V1 operational rows remain live.
/** The HR Director login profile (lib/seed/generate.ts) that the seeded Director directory identity is bound to. */
export const DEMO_DIRECTOR_PROFILE_ID = 'director';
const DIRECTOR_PERMISSIONS = ['hr.onboarding.director_read', 'hr.onboarding.director_approve', 'hr.onboarding.return'] as const;
const SALES_OPERATIONS_ACTION_PERMISSIONS = [
  'sales.read', 'operations.read', 'ticket.create', 'branch.review.assign', 'restock.create', 'incident.escalate',
] as const;

type WorkflowV2SeedStore = Store & WorkflowStoreCapability;
export type WorkflowV2SeedBody = { id: string; [field: string]: unknown };
type SeedBody = WorkflowV2SeedBody;
export interface WorkflowV2SeedUniqueKey { readonly constraint: string; readonly values: Readonly<Record<string, string | number>> }
type InsertKey = { constraint: string; values: Record<string, string | number> };
export interface WorkflowV2SeedPlannedRow {
  table: WorkflowStorageTable;
  body: SeedBody;
  key?: WorkflowV2SeedUniqueKey;
}
type PlannedRow = WorkflowV2SeedPlannedRow;

export type WorkflowV2SeedPhase = string;
type SourceSeedPhase = WorkflowV2SeedPhase;

export interface WorkflowV2ManagerAdvanceRequest {
  readonly requestIds: readonly string[];
  readonly managerIdentityId: string;
  readonly managerProfileId: string;
  readonly businessDate: ISODate;
}

/**
 * Server integration must implement this through the registered V2 manager
 * action runtime (prepare, confirm, execute, and verify). The seed initializer
 * never writes a manager event, receipt, reservation, or approval transition.
 */
export type WorkflowV2ManagerApprovalAdvancer = (input: WorkflowV2ManagerAdvanceRequest) => Promise<void>;

export interface WorkflowV2SeedServerOptions {
  readonly store: WorkflowV2SeedStore;
  readonly advanceManagerApprovals?: WorkflowV2ManagerApprovalAdvancer;
}

export interface WorkflowV2SeedOptions {
  readonly seed: number;
  readonly businessDate: string;
  /** Exact synthetic request IDs to advance with the injected real manager runtime. */
  readonly advanceManagerRequestIds?: readonly string[];
}

export interface WorkflowV2SeedPhaseSummary {
  readonly phase: SourceSeedPhase;
  readonly digest: string;
  readonly rows: number;
  readonly inserted: number;
  readonly alreadyCurrent: number;
  readonly byTable: Readonly<Record<string, { inserted: number; alreadyCurrent: number }>>;
  readonly ledgerId: string;
  readonly ledgerInserted: boolean;
}

export interface WorkflowV2SeedResult {
  readonly seedVersion: number;
  readonly seed: number;
  readonly businessDate: ISODate;
  readonly seedTag: string;
  readonly inputDigest: string;
  readonly seedBeginMarkerId: string;
  readonly seedBeginMarkerState: 'inserted' | 'current' | 'blocked' | 'conflict';
  readonly state: 'source_ready' | 'legacy_base_requires_seed_plan' | 'seed_plan_conflict' | 'source_phase_incomplete';
  readonly sourcePhasesComplete: boolean;
  readonly bootstrapReady: boolean;
  readonly blockedTables: readonly string[];
  readonly failedPhase?: string;
  readonly failureCode?: string;
  readonly failureMetadata?: StorageFailureMetadata;
  readonly sourcePhases: readonly WorkflowV2SeedPhaseSummary[];
  readonly plannedOnboardingRequestIds: readonly string[];
  readonly managerAdvancement: {
    readonly state: 'not_requested' | 'verified' | 'runtime_unverified' | 'already_present';
    readonly selectedRequestIds: readonly string[];
    readonly managerReadyRequestIds: readonly string[];
    readonly directorQueueRequestIds: readonly string[];
  };
  readonly directorQueueReady: boolean;
}

export interface WorkflowV2SeedIdentitySet {
  readonly salesProfile: Profile;
  readonly eastOperationsProfile: Profile;
  readonly managerProfile: Profile;
  readonly hrProfile: Profile;
  readonly directorProfile: Profile;
  readonly ledgerProfile: Profile;
  readonly salesIdentityId: string;
  readonly eastOperationsIdentityId: string;
  readonly managerIdentityId: string;
  readonly hrIdentityId: string;
  readonly directorIdentityId: string;
  readonly ledgerProfileId: string;
  readonly rootOrgUnitId: string;
  readonly salesOrgUnitId: string;
  readonly hrOrgUnitId: string;
  readonly onboardingBranchIds: string[];
  readonly onboardingRequestIds: string[];
}
type SeedIdentitySet = WorkflowV2SeedIdentitySet;

export interface WorkflowV2SeedPlan {
  readonly seed: number;
  readonly seedVersion: number;
  readonly seedTag: string;
  readonly businessDate: ISODate;
  readonly createdAt: string;
  readonly sourceDigest: string;
  readonly inputDigest: string;
  readonly seedData: SeedData;
  readonly identities: SeedIdentitySet;
  readonly phases: readonly { phase: WorkflowV2SeedPhase; rows: readonly WorkflowV2SeedPlannedRow[] }[];
}

type PreparedSeed = WorkflowV2SeedPlan;

function seedTag(seed: number): string {
  return digest({ namespace: SYNTHETIC_SEED_NAMESPACE, seed }).slice(0, 20);
}

function seededId(seed: number, namespace: string, ordinal = 0): string {
  return `demo-v${WORKFLOW_V2_SEED_VERSION}:${digest({ namespace: SYNTHETIC_SEED_NAMESPACE, seed, seedVersion: WORKFLOW_V2_SEED_VERSION, entity: namespace, ordinal }).slice(0, 32)}`;
}

function policyRowId(): string {
  return `demo-v2-policy:${digest({ id: demoWorkflowPolicyV1.id, version: demoWorkflowPolicyV1.version, digest: demoWorkflowPolicyV1Digest }).slice(0, 32)}`;
}

function bangkokInstant(date: ISODate, hour = 12): string {
  const instant = `${date}T${String(hour).padStart(2, '0')}:00:00+07:00`;
  return instantSchema.parse(instant);
}

function rotated<T>(items: readonly T[], offset: number): T[] {
  if (items.length === 0) return [];
  const start = ((offset % items.length) + items.length) % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}

function compareId<T extends { id: string }>(left: T, right: T): number {
  return left.id.localeCompare(right.id);
}

function profileAnchor(
  id: string,
  name: string,
  role: Profile['role'],
  permissions: string[],
  regions: string[],
  active = true,
): Profile {
  return { id, name, role, active, permissions, regions };
}

function plannedRow<T extends SeedBody>(table: WorkflowStorageTable, body: T, extra: Omit<PlannedRow, 'table' | 'body'> = {}): PlannedRow {
  return { table, body, ...extra };
}

function rowsFromSeed<T extends { id: string }>(table: WorkflowStorageTable, rows: readonly T[]): PlannedRow[] {
  invariant(new Set(rows.map(row => row.id)).size === rows.length,
    'WORKFLOW_INVALID_INPUT', `SeedData contains duplicate ${table} IDs`);
  return [...rows].sort(compareId).map(row => {
    const body = structuredClone(row) as unknown as SeedBody;
    if (table === 'sales_targets' || table === 'staffing_summaries') {
      return plannedRow(table, body, {
        key: {
          constraint: `${table}_branch_date_unique`,
          values: { branchId: String(body.branchId), date: String(body.date) },
        },
      });
    }
    return plannedRow(table, body);
  });
}

function chunkPhase(name: string, rows: readonly PlannedRow[], size = SEED_CHUNK_SIZE): { phase: SourceSeedPhase; rows: PlannedRow[] }[] {
  const chunks: { phase: SourceSeedPhase; rows: PlannedRow[] }[] = [];
  for (let offset = 0, chunk = 0; offset < rows.length; offset += size, chunk += 1) {
    chunks.push({ phase: `${name}:${String(chunk).padStart(4, '0')}`, rows: rows.slice(offset, offset + size) });
  }
  return chunks;
}

function primaryKey(row: PlannedRow): InsertKey {
  return row.key ?? { constraint: `${row.table}_primary_key`, values: { id: row.body.id } };
}

function sameSeedRecord(expected: SeedBody, current: unknown): boolean {
  if (typeof current !== 'object' || current === null || Array.isArray(current)) return false;
  return canonical(current) === canonical(expected);
}

/**
 * Shared legacy writes advance the native storage version even without a payload rowVersion.
 * Shared rows may change only fields written by known evolutions, never arbitrary content or authority.
 * V2-only rows still require matching body/native versions. Same-version differences conflict.
 */
const SHARED_EVOLVABLE_FIELDS: Partial<Record<WorkflowStorageTable, readonly string[]>> = {
  inventory_snapshots: ['operationKey', 'updatedAt'],
  incidents: ['operationKey', 'updatedAt'],
  mock_badges: ['state', 'version', 'operationKey', 'updatedAt', 'rowVersion'],
};
type DemoScenario = Extract<ReturnType<typeof actionPayloadSchema.parse>, { kind: 'demo_update' }>['scenario'];

function seedEvolutionChecker(reader: Pick<Store, 'get' | 'list'>, businessDate?: string) {
  const scenarios = new Map<string, Promise<DemoScenario | undefined>>();
  const scenarioFor = (operationKey: string) => {
    let cached = scenarios.get(operationKey);
    if (!cached) {
      cached = (async () => {
        if (!operationKey.endsWith(':artifact')) return undefined;
        const receiptId = operationKey.slice(0, -':artifact'.length);
        // Legacy receipts are intentionally absent from the V2 mixed-table projection.
        const receipt = await reader.get<Receipt>('action_executions', receiptId);
        if (!receipt || receipt.id !== receiptId || receipt.kind !== 'demo_update'
          || !Array.isArray(receipt.results) || receipt.results.length !== 1
          || receiptId !== `execution_${receipt.actionId}`) return undefined;
        const action = await reader.get<PendingAction>('pending_actions', receipt.actionId);
        const payload = actionPayloadSchema.safeParse(action?.payload);
        const result = receipt.results[0];
        if (!action || action.id !== receipt.actionId || action.actorId !== receipt.actorId
          || action.payloadHash !== pendingActionApprovalHash(action)
          || result.targetId !== 'artifact' || result.id !== `effect_${digest(operationKey).slice(0, 24)}`) return undefined;
        const verified = receipt.status === 'verified_success' && result.status === 'verified_success'
          && action.status === 'completed' && instantSchema.safeParse(receipt.verifiedAt).success;
        // A pending effect ID alone cannot prove the entire source write survived later writers.
        // Reuse execution readback inside this recovery revision envelope before accepting evolution.
        const committedInFlight = receipt.status === 'pending' && receipt.verifiedAt === null
          && result.status === 'pending' && action.status === 'claimed';
        if (!(verified || committedInFlight) || !payload.success || payload.data.kind !== 'demo_update') return undefined;
        if (committedInFlight && (!businessDate || !await verifyDemo({ reader, businessDate, operationKey, executedAt: result.executedAt }, payload.data))) return undefined;
        return payload.data.scenario;
      })();
      scenarios.set(operationKey, cached);
    }
    return cached;
  };
  return (planned: PlannedRow, current: ProjectedRow<unknown>) => isEvolvedSeedRow(planned, current, scenarioFor, businessDate);
}

async function isEvolvedSeedRow(planned: PlannedRow, current: ProjectedRow<unknown>, scenarioFor: (key: string) => Promise<DemoScenario | undefined>, businessDate?: string): Promise<boolean> {
  const expected = planned.body;
  const definition = getWorkflowProjection(planned.table);
  const expectedVersion = expected.rowVersion ?? 1;
  if (!Number.isSafeInteger(expectedVersion) || (expectedVersion as number) < 1 ||
    current.id !== expected.id || current.rowVersion <= (expectedVersion as number)) return false;
  let row: SeedBody;
  try {
    row = validateWorkflowProjectionBody<SeedBody>(planned.table, current.id, current.rowVersion, current.body).body;
  } catch { return false; }
  const fieldValue = (body: unknown, path: string): unknown => path.split('.').reduce<unknown>((value, field) =>
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[field] : undefined, body);
  if (!definition.immutableFields.every(field =>
    canonical({ value: fieldValue(expected, field) }) === canonical({ value: fieldValue(row, field) }))) return false;
  if (definition.storage !== 'shared') return Number.isSafeInteger(expected.rowVersion) && row.rowVersion === current.rowVersion;
  const allowed = SHARED_EVOLVABLE_FIELDS[planned.table];
  if (!allowed) return false;
  let canonicalExpected = expected;
  if (planned.table === 'inventory_snapshots' || planned.table === 'incidents') {
    if (expected.date !== businessDate) return false;
    if (typeof row.operationKey !== 'string' || !instantSchema.safeParse(row.updatedAt).success) return false;
    const scenario = await scenarioFor(row.operationKey);
    if (!scenario) return false;
    canonicalExpected = (planned.table === 'inventory_snapshots'
      ? expectedInventory(expected as unknown as Inventory, scenario)
      : expectedIncident(expected as unknown as Incident, scenario, String(row.updatedAt))) as unknown as SeedBody;
  }
  const unchanged = (body: SeedBody) => Object.fromEntries(Object.entries(body).filter(([field]) => !allowed.includes(field)));
  return canonical(unchanged(canonicalExpected)) === canonical(unchanged(row));
}

function phaseDigest(seed: number, businessDate: ISODate, sourceDigest: string, phase: SourceSeedPhase, rows: readonly PlannedRow[]): string {
  return digest({
    namespace: SYNTHETIC_SEED_NAMESPACE,
    seedVersion: WORKFLOW_V2_SEED_VERSION,
    seed,
    businessDate,
    sourceDigest,
    phase,
    rows: [...rows].sort((left, right) => `${left.table}:${left.body.id}`.localeCompare(`${right.table}:${right.body.id}`)),
  });
}

function planInputDigest(
  seed: number,
  businessDate: ISODate,
  sourceDigest: string,
  phases: readonly { phase: SourceSeedPhase; rows: readonly PlannedRow[] }[],
): string {
  return digest({
    namespace: SYNTHETIC_SEED_NAMESPACE,
    seedVersion: WORKFLOW_V2_SEED_VERSION,
    seed,
    businessDate,
    sourceDigest,
    phaseDigests: phases.map(({ phase, rows }) => ({
      phase,
      digest: phaseDigest(seed, businessDate, sourceDigest, phase, rows),
    })),
  });
}

function freezeTree<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

function assertPlanIntegrity(plan: WorkflowV2SeedPlan): void {
  let rebuilt: PreparedSeed;
  try {
    rebuilt = prepareSeed(plan.seedData, { seed: plan.seed, businessDate: plan.businessDate });
  } catch {
    throw new DomainError('CONFLICT', 'The prepared workflow V2 seed plan cannot be rebuilt from its synthetic input', 409);
  }
  invariant(canonical(plan) === canonical(rebuilt),
    'WORKFLOW_CONFLICT', 'The prepared workflow V2 seed plan differs from its canonical reconstruction', 409);
}

function validateManagerSelection(plan: WorkflowV2SeedPlan, options: Pick<WorkflowV2SeedOptions, 'advanceManagerRequestIds'>): void {
  const selected = options.advanceManagerRequestIds;
  if (selected === undefined) return;
  invariant(selected.length > 0 && new Set(selected).size === selected.length,
    'WORKFLOW_INVALID_INPUT', 'Manager advancement requires a nonempty, unique request selection');
  const readyRequestId = seededId(plan.seed, 'v2-onboarding-request', ONBOARDING_READY_REQUEST_INDEX);
  invariant(selected.every(id => id === readyRequestId),
    'WORKFLOW_INVALID_INPUT', 'Only the exact complete synthetic onboarding request may be selected for manager advancement');
}

function buildProfileAnchors(seed: number, regions: string[], loginDirector: Profile): Omit<SeedIdentitySet, 'salesIdentityId' | 'eastOperationsIdentityId' | 'managerIdentityId' | 'hrIdentityId' | 'directorIdentityId' | 'ledgerProfileId' | 'rootOrgUnitId' | 'salesOrgUnitId' | 'hrOrgUnitId' | 'onboardingBranchIds' | 'onboardingRequestIds'> & {
  salesIdentityId: string;
  eastOperationsIdentityId: string;
  managerIdentityId: string;
  hrIdentityId: string;
  directorIdentityId: string;
  ledgerProfileId: string;
  rootOrgUnitId: string;
  salesOrgUnitId: string;
  hrOrgUnitId: string;
} {
  const salesProfile = profileAnchor(seededId(seed, 'profile-sales'), 'Demo Sales Operator V2 Profile Anchor', 'executive',
    [...SALES_OPERATIONS_ACTION_PERMISSIONS, 'crm.read', 'crm.followup.create', 'discount.request.create'], regions);
  const eastOperationsProfile = profileAnchor(seededId(seed, 'profile-east-operations'), 'Demo East Operations Manager V2 Profile Anchor', 'east_manager',
    [...SALES_OPERATIONS_ACTION_PERMISSIONS], ['east']);
  const managerProfile = profileAnchor(seededId(seed, 'profile-manager'), 'Demo East Onboarding Manager V2 Profile Anchor', 'east_manager',
    ['hr.onboarding.manager_read', 'hr.onboarding.manager_approve'], ['east']);
  const hrProfile = profileAnchor(seededId(seed, 'profile-hr-operations'), 'Demo HR Operations V2 Profile Anchor', 'hr_admin',
    ['hr.read', 'hr.onboarding.start', 'hr.onboarding.tasks', 'hr.offboarding.plan', 'hr.it_disable.request',
      'hr.asset_return.create', 'hr.contract.reminder', 'hr.policy.assign', 'badge.revoke'], regions);
  // The HR Director is the real login profile (createSeedData 'director', role hr_director): its directory identity below binds
  // to it, so the login session IS the Workflow V2 Director principal. Not an anchor row: the profile comes from SeedData.
  const directorProfile = loginDirector;
  const ledgerProfile = profileAnchor(seededId(seed, 'profile-seed-ledger'), 'Synthetic Workflow V2 Seed Ledger', 'executive', [], [], false);

  return {
    salesProfile,
    eastOperationsProfile,
    managerProfile,
    hrProfile,
    directorProfile,
    ledgerProfile,
    salesIdentityId: seededId(seed, 'directory-sales'),
    eastOperationsIdentityId: seededId(seed, 'directory-east-operations'),
    managerIdentityId: seededId(seed, 'directory-manager'),
    hrIdentityId: seededId(seed, 'directory-hr-operations'),
    directorIdentityId: seededId(seed, 'directory-director'),
    ledgerProfileId: ledgerProfile.id,
    rootOrgUnitId: seededId(seed, 'org-root'),
    salesOrgUnitId: seededId(seed, 'org-sales'),
    hrOrgUnitId: seededId(seed, 'org-hr'),
  };
}

function operationsCaseRows(
  seed: number,
  seedData: SeedData,
  ownerIdentityId: string,
  businessDate: ISODate,
): PlannedRow[] {
  return [...seedData.branches].sort(compareId).flatMap(branch => {
    const openIncidents = seedData.incidents.filter(incident =>
      incident.branchId === branch.id && incident.date === businessDate && incident.status === 'open');
    const belowMinimumInventory = seedData.inventory_snapshots.filter(inventory =>
      inventory.branchId === branch.id && inventory.date === businessDate && inventory.onHand < inventory.minimum);
    const paidSalesSatang = seedData.sales_orders
      .filter(order => order.branchId === branch.id && order.date === businessDate && order.status === 'paid')
      .reduce((total, order) => total + order.amountSatang, 0);
    const target = seedData.sales_targets.find(row => row.branchId === branch.id && row.date === businessDate);
    invariant(target !== undefined, 'WORKFLOW_INVALID_INPUT', `Workflow V2 investigation cases require a sales target for ${branch.id}/${businessDate}`);
    const belowSalesTarget = paidSalesSatang < target.amountSatang;
    if (openIncidents.length === 0 && belowMinimumInventory.length === 0 && !belowSalesTarget) return [];

    const signals = [
      ...(openIncidents.length > 0 ? [`${openIncidents.length} open incident${openIncidents.length === 1 ? '' : 's'}`] : []),
      ...(belowMinimumInventory.length > 0 ? [`${belowMinimumInventory.length} below-minimum inventory item${belowMinimumInventory.length === 1 ? '' : 's'}`] : []),
      ...(belowSalesTarget ? ['paid sales below target'] : []),
    ];
    const sourceSystems = [
      ...(openIncidents.length > 0 ? ['incidents'] : []),
      ...(belowMinimumInventory.length > 0 ? ['inventory'] : []),
      ...(belowSalesTarget ? ['sales', 'targets'] : []),
    ];
    const sourceIds = sourceSystems.map(system => `${system}:${branch.id}:${businessDate}`).sort();
    const id = seededId(seed, `v2-operations-investigation-case:${branch.id}`);
    const lifecycleId = seededId(seed, `v2-operations-investigation-lifecycle:${branch.id}`);
    const signalSummary = signals.join(', ');
    return [plannedRow('investigation_cases', {
      id,
      rowVersion: 1,
      branchId: branch.id,
      ownerIdentityId,
      status: 'open',
      businessDate,
      lifecycleId,
      reason: `Synthetic demo investigation derived from ${signalSummary} on ${businessDate}.`,
      priority: openIncidents.length > 0 || belowMinimumInventory.length > 0 ? 'high' : 'normal',
      sourceIds,
      unansweredQuestion: `What follow-up is justified by ${signalSummary} at ${branch.name}?`,
    }, {
      key: {
        constraint: 'investigation_cases_open_equivalent_unique',
        values: { branchId: branch.id, ownerIdentityId, businessDate },
      },
    })];
  });
}

function prepareSeed(seedData: SeedData, options: Pick<WorkflowV2SeedOptions, 'seed' | 'businessDate'>): PreparedSeed {
  invariant(Number.isSafeInteger(options.seed), 'WORKFLOW_INVALID_INPUT', 'The workflow seed must be a safe integer');
  const businessDate = isoDateSchema.parse(options.businessDate);
  const seed = options.seed;
  const generatedSeedData = createSeedData(businessDate, seed);
  invariant(canonical(seedData) === canonical(generatedSeedData),
    'WORKFLOW_INVALID_INPUT', 'Workflow V2 accepts only the canonical synthetic Thai retail fixture for this seed and business date');
  const tag = seedTag(seed);
  const branches = [...seedData.branches].sort(compareId);
  invariant(branches.length > 0, 'WORKFLOW_INVALID_INPUT', 'Workflow V2 seeding requires at least one seeded branch');
  invariant(new Set(branches.map(branch => branch.id)).size === branches.length,
    'WORKFLOW_INVALID_INPUT', 'SeedData contains duplicate branch IDs');
  invariant(seedData.policy_documents.length > 0 &&
    seedData.policy_documents.some(document => document.version === demoWorkflowPolicyV1.policyAcknowledgementVersion),
  'WORKFLOW_INVALID_INPUT', 'Workflow V2 seeding requires a synthetic policy document at the current acknowledgement version');
  invariant(new Set(seedData.policy_documents.map(document => document.id)).size === seedData.policy_documents.length,
    'WORKFLOW_INVALID_INPUT', 'SeedData contains duplicate policy document IDs');

  const branchesById = new Map(branches.map(branch => [branch.id, branch]));
  const activeEmployees = [...seedData.employees]
    .filter((employee): employee is Employee & { branchId: string } => employee.active && employee.branchId !== null && branchesById.has(employee.branchId))
    .sort(compareId);
  invariant(new Set(seedData.employees.map(employee => employee.id)).size === seedData.employees.length,
    'WORKFLOW_INVALID_INPUT', 'SeedData contains duplicate employee IDs');
  invariant(activeEmployees.length >= ACTION_DEMO_TARGET_COUNT * 2 + ONBOARDING_DEMO_REQUEST_COUNT,
    'WORKFLOW_INVALID_INPUT', `Workflow V2 seeding needs at least ${ACTION_DEMO_TARGET_COUNT * 2 + ONBOARDING_DEMO_REQUEST_COUNT} active employees with branches`);

  const eastBranchIds = branches.filter(branch => branch.region === 'east').map(branch => branch.id).sort();
  invariant(eastBranchIds.length > 0, 'WORKFLOW_INVALID_INPUT', 'Workflow V2 onboarding requires an East branch for the scoped manager');
  const eastBranchSet = new Set(eastBranchIds);
  const eastEmployees = rotated(activeEmployees.filter(employee => eastBranchSet.has(employee.branchId)), seed);
  invariant(eastEmployees.length >= ONBOARDING_DEMO_REQUEST_COUNT,
    'WORKFLOW_INVALID_INPUT', 'Workflow V2 onboarding requires two active East employees with branches');

  const onboardingEmployees = eastEmployees.slice(0, ONBOARDING_DEMO_REQUEST_COUNT);
  const onboardingIds = new Set(onboardingEmployees.map(employee => employee.id));
  const remainingEmployees = rotated(activeEmployees.filter(employee => !onboardingIds.has(employee.id)),
    (seed % activeEmployees.length) + ONBOARDING_DEMO_REQUEST_COUNT);
  const contractEmployees = remainingEmployees.slice(0, ACTION_DEMO_TARGET_COUNT);
  const offboardingEmployees = remainingEmployees.slice(ACTION_DEMO_TARGET_COUNT, ACTION_DEMO_TARGET_COUNT * 2);
  invariant(contractEmployees.length === ACTION_DEMO_TARGET_COUNT && offboardingEmployees.length === ACTION_DEMO_TARGET_COUNT,
    'WORKFLOW_INVALID_INPUT', 'Workflow V2 seeding could not select disjoint contract and offboarding employees');

  const regions = [...new Set(branches.map(branch => branch.region))].sort();
  const loginDirector = seedData.profiles.find(profile => profile.id === DEMO_DIRECTOR_PROFILE_ID);
  invariant(loginDirector?.role === 'hr_director' && loginDirector.active && canonical(loginDirector.permissions) === canonical(DIRECTOR_PERMISSIONS),
    'WORKFLOW_INVALID_INPUT', 'Workflow V2 seeding requires the HR Director login profile with exactly the Director permissions');
  const profileSet = buildProfileAnchors(seed, regions, loginDirector);
  const onboardingBranchIds = [...new Set(onboardingEmployees.map(employee => employee.branchId))].sort();
  const onboardingRequestIds = Array.from({ length: ONBOARDING_DEMO_REQUEST_COUNT }, (_, index) => seededId(seed, 'v2-onboarding-request', index));
  const identities: SeedIdentitySet = { ...profileSet, onboardingBranchIds, onboardingRequestIds };
  const createdAt = bangkokInstant(businessDate);
  const sourceDigest = digest({
    namespace: SYNTHETIC_SEED_NAMESPACE,
    generator: SYNTHETIC_SEED_GENERATOR,
    seedVersion: WORKFLOW_V2_SEED_VERSION,
    seed,
    businessDate,
    seedData,
  });

  const profileRows: PlannedRow[] = [
    identities.salesProfile,
    identities.eastOperationsProfile,
    identities.managerProfile,
    identities.hrProfile,
    identities.ledgerProfile,
  ].map(profile => plannedRow('profiles', {
    id: profile.id,
    name: profile.name,
    role: profile.role,
    active: profile.active,
    permissions: [...profile.permissions],
    regions: [...profile.regions],
  }));

  const orgUnitRows: PlannedRow[] = [
    { id: identities.rootOrgUnitId, parentOrgUnitId: null, name: `Synthetic Demo Organization ${tag}`, active: true, kind: 'synthetic_demo_org', createdAt },
    { id: identities.salesOrgUnitId, parentOrgUnitId: identities.rootOrgUnitId, name: `Synthetic Demo Sales ${tag}`, active: true, kind: 'synthetic_demo_org', createdAt },
    { id: identities.hrOrgUnitId, parentOrgUnitId: identities.rootOrgUnitId, name: `Synthetic Demo HR ${tag}`, active: true, kind: 'synthetic_demo_org', createdAt },
  ].map(body => plannedRow('org_units', { ...body, rowVersion: 1 }));

  const policyRow = plannedRow('workflow_policies', {
    id: policyRowId(),
    policy: demoWorkflowPolicyV1,
    version: demoWorkflowPolicyV1.version,
    digest: demoWorkflowPolicyV1Digest,
  }, {
    key: {
      constraint: 'workflow_policies_policy_version_unique',
      values: { 'policy.id': demoWorkflowPolicyV1.id, version: demoWorkflowPolicyV1.version },
    },
  });
  const demoOperationsTeam = plannedRow('workflow_teams', {
    id: 'demo_operations',
    rowVersion: 1,
    name: 'Demo Operations',
    active: true,
    department: 'operations',
    createdAt,
  }, { key: { constraint: 'workflow_teams_name_unique', values: { name: 'Demo Operations' } } });

  const createdAtDate = getBangkokCalendarDate(new Date(createdAt));
  // The .invalid addresses meet the directory schema but cannot receive mail; all allowed channels are simulation-only.
  const identityRows: PlannedRow[] = [
    {
      id: identities.directorIdentityId,
      profileId: identities.directorProfile.id,
      displayName: identities.directorProfile.name,
      active: true,
      role: 'hr_director',
      department: 'hr',
      orgUnitId: identities.hrOrgUnitId,
      managerIdentityId: null,
      verifiedDemoEmail: `synthetic+director-${tag}@example.invalid`,
      slackIdentity: null,
      allowedChannels: ['simulated_email', 'simulated_slack'],
      classificationCeiling: 'internal',
      rowVersion: 1,
    },
    {
      id: identities.salesIdentityId,
      profileId: identities.salesProfile.id,
      displayName: identities.salesProfile.name,
      active: true,
      role: 'executive',
      department: 'sales_operations',
      orgUnitId: identities.salesOrgUnitId,
      managerIdentityId: null,
      verifiedDemoEmail: `synthetic+sales-${tag}@example.invalid`,
      slackIdentity: null,
      allowedChannels: ['simulated_email', 'simulated_slack'],
      classificationCeiling: 'internal',
      rowVersion: 1,
    },
    {
      id: identities.eastOperationsIdentityId,
      profileId: identities.eastOperationsProfile.id,
      displayName: identities.eastOperationsProfile.name,
      active: true,
      role: 'east_manager',
      department: 'sales_operations',
      orgUnitId: identities.salesOrgUnitId,
      managerIdentityId: null,
      verifiedDemoEmail: `synthetic+east-operations-${tag}@example.invalid`,
      slackIdentity: null,
      allowedChannels: ['simulated_email', 'simulated_slack'],
      classificationCeiling: 'internal',
      rowVersion: 1,
    },
    {
      id: identities.managerIdentityId,
      profileId: identities.managerProfile.id,
      displayName: identities.managerProfile.name,
      active: true,
      role: 'east_manager',
      department: 'hr',
      orgUnitId: identities.hrOrgUnitId,
      managerIdentityId: identities.directorIdentityId,
      verifiedDemoEmail: `synthetic+manager-${tag}@example.invalid`,
      slackIdentity: null,
      allowedChannels: ['simulated_email', 'simulated_slack'],
      classificationCeiling: 'internal',
      rowVersion: 1,
    },
    {
      id: identities.hrIdentityId,
      profileId: identities.hrProfile.id,
      displayName: identities.hrProfile.name,
      active: true,
      role: 'hr_admin',
      department: 'hr',
      orgUnitId: identities.hrOrgUnitId,
      managerIdentityId: identities.directorIdentityId,
      verifiedDemoEmail: `synthetic+hr-${tag}@example.invalid`,
      slackIdentity: null,
      allowedChannels: ['simulated_email', 'simulated_slack'],
      classificationCeiling: 'internal',
      rowVersion: 1,
    },
  ].map(body => plannedRow('directory_identities', body, {
    key: { constraint: 'directory_identities_profile_unique', values: { profileId: String(body.profileId) } },
  }));

  const responsibilityRows: PlannedRow[] = [
    { id: seededId(seed, 'responsibility-sales'), identityId: identities.salesIdentityId, orgUnitId: identities.salesOrgUnitId, purpose: 'sales_operations', branchIds: branches.map(branch => branch.id).sort(), active: true, rowVersion: 1 },
    { id: seededId(seed, 'responsibility-east-operations'), identityId: identities.eastOperationsIdentityId, orgUnitId: identities.salesOrgUnitId, purpose: 'sales_operations', branchIds: eastBranchIds, active: true, rowVersion: 1 },
    { id: seededId(seed, 'responsibility-manager-onboarding'), identityId: identities.managerIdentityId, orgUnitId: identities.hrOrgUnitId, purpose: 'manager_onboarding', branchIds: onboardingBranchIds, active: true, rowVersion: 1 },
    { id: seededId(seed, 'responsibility-director-onboarding'), identityId: identities.directorIdentityId, orgUnitId: identities.hrOrgUnitId, purpose: 'director_onboarding', branchIds: onboardingBranchIds, active: true, rowVersion: 1 },
    { id: seededId(seed, 'responsibility-hr-operations'), identityId: identities.hrIdentityId, orgUnitId: identities.hrOrgUnitId, purpose: 'hr_operations', branchIds: [...new Set([...contractEmployees, ...offboardingEmployees].map(employee => employee.branchId))].sort(), active: true, rowVersion: 1 },
  ].map(body => plannedRow('responsibilities', body, {
    key: {
      constraint: 'responsibilities_open_identity_purpose_unique',
      values: { identityId: String(body.identityId), purpose: String(body.purpose), orgUnitId: String(body.orgUnitId) },
    },
  }));

  const reportingRows: PlannedRow[] = [
    { id: seededId(seed, 'reporting-manager-to-director'), managerIdentityId: identities.directorIdentityId, reportIdentityId: identities.managerIdentityId, orgUnitId: identities.hrOrgUnitId, active: true, createdAt, rowVersion: 1 },
    { id: seededId(seed, 'reporting-hr-to-director'), managerIdentityId: identities.directorIdentityId, reportIdentityId: identities.hrIdentityId, orgUnitId: identities.hrOrgUnitId, active: true, createdAt, rowVersion: 1 },
  ].map(body => plannedRow('reporting_relationships', body));

  const crmRows: PlannedRow[] = [];
  const priorActivityDate = addBangkokCalendarDays(createdAtDate, -(demoWorkflowPolicyV1.crmInactiveDays + 1));
  const expectedCloseDate = addBangkokCalendarDays(createdAtDate, demoWorkflowPolicyV1.contractReminderDays);
  for (let index = 0; index < ACTION_DEMO_TARGET_COUNT; index += 1) {
    const branch = branches[index % branches.length];
    const customerId = seededId(seed, 'crm-customer', index);
    const opportunityId = seededId(seed, 'crm-opportunity', index);
    const activityId = seededId(seed, 'crm-activity', index);
    crmRows.push(plannedRow('crm_customers', {
      id: customerId,
      rowVersion: 1,
      name: `Synthetic Demo Customer ${String(index + 1).padStart(2, '0')}`,
      region: branch.region,
      status: 'active',
      createdAt,
    }));
    const opportunityTitle = `Synthetic demo follow-up ${digest({ seed, index, namespace: 'opportunity-title' }).slice(0, 12)}`;
    crmRows.push(plannedRow('crm_opportunities', {
      id: opportunityId,
      rowVersion: 1,
      customerId,
      ownerIdentityId: identities.salesIdentityId,
      title: opportunityTitle,
      stage: 'prospecting',
      amountSatang: 250_000 + index * 25_000 + Math.abs(seed % 10_000),
      expectedCloseDate,
      createdAt,
      updatedAt: createdAt,
    }, {
      key: { constraint: 'crm_opportunities_open_equivalent_unique', values: { customerId, title: opportunityTitle } },
    }));
    const activityAt = bangkokInstant(priorActivityDate, 15);
    crmRows.push(plannedRow('crm_activities', {
      id: activityId,
      rowVersion: 1,
      opportunityId,
      ownerIdentityId: identities.salesIdentityId,
      kind: 'synthetic_demo_activity',
      summary: 'Synthetic fixture activity; no real customer interaction occurred.',
      occurredAt: activityAt,
      createdAt: activityAt,
    }));
  }

  const contractStartDate = addBangkokCalendarDays(createdAtDate, -365);
  const contractEndDate = addBangkokCalendarDays(createdAtDate, Math.min(demoWorkflowPolicyV1.contractReminderDays, 21));
  const contractsAndAssets: PlannedRow[] = [];
  for (let index = 0; index < contractEmployees.length; index += 1) {
    const employee = contractEmployees[index];
    const contractId = seededId(seed, 'employment-contract', index);
    contractsAndAssets.push(plannedRow('employment_contracts', {
      id: contractId,
      rowVersion: 1,
      employeeId: employee.id,
      status: 'active',
      startDate: contractStartDate,
      endDate: contractEndDate,
      contractType: 'synthetic_demo_employment',
      policyVersion: demoWorkflowPolicyV1.policyAcknowledgementVersion,
      createdAt: bangkokInstant(contractStartDate),
    }, {
      key: { constraint: 'employment_contracts_open_employee_unique', values: { employeeId: employee.id } },
    }));
  }
  const assignmentAt = bangkokInstant(addBangkokCalendarDays(createdAtDate, -90));
  for (let index = 0; index < offboardingEmployees.length; index += 1) {
    const employee = offboardingEmployees[index];
    const assetId = seededId(seed, 'asset', index);
    const assignmentId = seededId(seed, 'asset-assignment', index);
    const assetTag = `DEMO-${tag}-${String(index + 1).padStart(2, '0')}`;
    contractsAndAssets.push(plannedRow('assets', {
      id: assetId,
      rowVersion: 1,
      assetTag,
      status: 'assigned',
      kind: 'laptop',
      model: 'Synthetic Demo Computer',
      createdAt: bangkokInstant(addBangkokCalendarDays(createdAtDate, -180)),
    }, { key: { constraint: 'assets_tag_unique', values: { assetTag } } }));
    contractsAndAssets.push(plannedRow('asset_assignments', {
      id: assignmentId,
      rowVersion: 1,
      assetId,
      employeeId: employee.id,
      status: 'assigned',
      assignedAt: assignmentAt,
      createdAt: assignmentAt,
    }, { key: { constraint: 'asset_assignments_open_asset_unique', values: { assetId } } }));
  }

  const onboardingRows: PlannedRow[] = [];
  for (let index = 0; index < ONBOARDING_DEMO_REQUEST_COUNT; index += 1) {
    const employee = onboardingEmployees[index];
    const requestId = identities.onboardingRequestIds[index];
    const lifecycleId = seededId(seed, 'onboarding-lifecycle', index);
    onboardingRows.push(plannedRow('onboarding_requests', {
      id: requestId,
      rowVersion: 1,
      employeeId: employee.id,
      orgUnitId: identities.hrOrgUnitId,
      managerIdentityId: identities.managerIdentityId,
      directorIdentityId: identities.directorIdentityId,
      startDate: addBangkokCalendarDays(createdAtDate, 14),
      state: 'manager_review_pending',
      lifecycleId,
      managerApprovalEventId: null,
      managerApprovedBy: null,
      managerApprovedAt: null,
      directorApprovalEventId: null,
      directorApprovedBy: null,
      directorApprovedAt: null,
      createdAt,
      updatedAt: createdAt,
    }, {
      key: {
        constraint: 'onboarding_requests_open_employee_lifecycle_unique',
        values: { employeeId: employee.id, lifecycleId },
      },
    }));

    for (const [documentIndex, documentType] of demoWorkflowPolicyV1.requiredOnboardingDocuments.entries()) {
      const accepted = index === ONBOARDING_READY_REQUEST_INDEX || documentIndex < demoWorkflowPolicyV1.requiredOnboardingDocuments.length - 1;
      if (!accepted) continue;
      const documentId = seededId(seed, 'v2-onboarding-document', index * demoWorkflowPolicyV1.requiredOnboardingDocuments.length + documentIndex);
      onboardingRows.push(plannedRow('onboarding_documents', {
        id: documentId,
        rowVersion: 1,
        requestId,
        employeeId: employee.id,
        documentType,
        status: 'accepted',
        policyVersion: demoWorkflowPolicyV1.policyAcknowledgementVersion,
        classification: demoWorkflowPolicyV1.classification,
        contentDigest: digest({
          namespace: SYNTHETIC_SEED_NAMESPACE,
          seed,
          seedVersion: WORKFLOW_V2_SEED_VERSION,
          requestId,
          documentType,
          provenance: 'synthetic_demo_document_fixture',
        }),
        createdAt,
        withdrawnAt: null,
      }, {
        key: { constraint: 'onboarding_documents_request_type_unique', values: { requestId, documentType } },
      }));
    }
  }

  const offboardingRows: PlannedRow[] = offboardingEmployees.map((employee, index) => {
    const lifecycleId = seededId(seed, 'offboarding-lifecycle', index);
    return plannedRow('offboarding_cases', {
      id: seededId(seed, 'offboarding-case', index),
      rowVersion: 1,
      employeeId: employee.id,
      ownerIdentityId: identities.hrIdentityId,
      status: 'active',
      lifecycleId,
      lastDay: addBangkokCalendarDays(createdAtDate, 7),
      reason: 'Synthetic demo case for review; no external account or physical access is changed.',
      createdAt,
      updatedAt: createdAt,
    }, { key: { constraint: 'offboarding_cases_open_employee_unique', values: { employeeId: employee.id } } });
  });

  const seedProfiles = rowsFromSeed('profiles', seedData.profiles);
  const baseDimensionRows = [
    ...rowsFromSeed('branches', seedData.branches),
    ...rowsFromSeed('products', seedData.products),
    ...rowsFromSeed('employees', seedData.employees),
    ...rowsFromSeed('policy_documents', seedData.policy_documents),
  ];
  invariant(new Set(seedData.incidents.map(incident => incident.id)).size === seedData.incidents.length,
    'WORKFLOW_INVALID_INPUT', 'SeedData contains duplicate incident IDs');
  const incidentRows = rowsFromSeed('incidents', seedData.incidents);
  const baseFactRows = [
    ...rowsFromSeed('sales_orders', seedData.sales_orders),
    ...rowsFromSeed('sales_targets', seedData.sales_targets),
    ...rowsFromSeed('inventory_snapshots', seedData.inventory_snapshots),
    ...incidentRows,
    ...rowsFromSeed('staffing_summaries', seedData.staffing_summaries),
    ...rowsFromSeed('mock_badges', seedData.mock_badges),
  ];
  const investigationRows = operationsCaseRows(seed, seedData, identities.salesIdentityId, businessDate);
  // V1 owns its mock ticket fixtures. Keep those unmarked legacy rows outside the V2 insert ledger.
  const foundationRows = [...seedProfiles, ...profileRows, ...orgUnitRows, policyRow, demoOperationsTeam];
  const authorityRows: PlannedRow[] = [...identityRows, ...responsibilityRows, ...reportingRows];
  const phases = [
    { phase: 'foundation', rows: foundationRows },
    ...chunkPhase('base_dimensions', baseDimensionRows),
    { phase: 'authority', rows: authorityRows },
    ...chunkPhase('base_facts', baseFactRows),
    { phase: 'operations_cases', rows: investigationRows },
    ...chunkPhase('crm_sources', crmRows),
    ...chunkPhase('hr_sources', contractsAndAssets),
    ...chunkPhase('onboarding_sources', onboardingRows),
    ...chunkPhase('offboarding_sources', offboardingRows),
  ];
  const plannedRefs = new Set<string>();
  for (const phase of phases) {
    for (const row of phase.rows) {
      const key = `${row.table}:${row.body.id}`;
      invariant(!plannedRefs.has(key), 'WORKFLOW_INVALID_INPUT', `The seed plan repeats ${key}`);
      plannedRefs.add(key);
    }
  }
  const inputDigest = planInputDigest(seed, businessDate, sourceDigest, phases);

  return freezeTree({
    seed,
    seedVersion: WORKFLOW_V2_SEED_VERSION,
    seedTag: tag,
    businessDate,
    createdAt,
    sourceDigest,
    inputDigest,
    seedData: structuredClone(seedData),
    identities,
    phases,
  });
}

/** Build the immutable plan while SeedData is still in the fresh bootstrap call path. */
export function prepareWorkflowV2SeedPlan(
  seedData: SeedData,
  options: Pick<WorkflowV2SeedOptions, 'seed' | 'businessDate'>,
): WorkflowV2SeedPlan {
  return prepareSeed(seedData, options);
}

type BootstrapDecision =
  | { state: 'started' | 'resumed'; blockedTables: [] }
  | { state: 'legacy_base_requires_seed_plan' | 'seed_plan_conflict'; blockedTables: string[] };

function seedBeginRecord(plan: WorkflowV2SeedPlan): SeedBody {
  return {
    id: seededId(plan.seed, 'seed-begin'),
    actorId: plan.identities.ledgerProfileId,
    category: 'synthetic_workflow_v2_seed_begin',
    summary: canonical({
      provenance: 'synthetic_demo_seed',
      generator: SYNTHETIC_SEED_GENERATOR,
      seedVersion: plan.seedVersion,
      inputDigest: plan.inputDigest,
      businessDate: plan.businessDate,
      seed: plan.seed,
    }),
    createdAt: plan.createdAt,
    correlationId: seededId(plan.seed, 'seed-begin-correlation'),
    outcome: 'seed_started',
  };
}

async function tableHoldsOnlyPlannedRows(
  reader: Pick<WorkflowProjectionReader, 'query'>,
  table: WorkflowStorageTable,
  plannedIds: ReadonlySet<string>,
): Promise<boolean> {
  const pageSize = 100;
  let cursor: string | undefined;
  for (let page = 0; page <= plannedIds.size / pageSize + 1; page += 1) {
    const rows = await reader.query<SeedBody>({
      kind: 'scoped', table, limit: pageSize, ...(cursor === undefined ? {} : { cursor }),
    });
    if (rows.some(row => !plannedIds.has(row.id))) return false;
    if (rows.length < pageSize) return true;
    cursor = rows[rows.length - 1].id;
  }
  return false;
}

async function hasSeedNaturalKeyConflict(
  reader: Pick<WorkflowProjectionReader, 'query'>, table: WorkflowStorageTable, rows: readonly PlannedRow[],
  evolved: ReturnType<typeof seedEvolutionChecker>,
): Promise<boolean> {
  const naturalRows = rows.filter(row => primaryKey(row).constraint !== `${table}_primary_key`);
  if (!naturalRows.length || await tableHoldsOnlyPlannedRows(reader, table, new Set(rows.map(row => row.body.id)))) return false;
  for (const row of naturalRows) {
    const key = primaryKey(row);
    const matches = await reader.query<SeedBody>({ kind: 'unique', table, constraint: key.constraint, values: key.values });
    for (const match of matches) {
      if (match.id !== row.body.id || (!sameSeedRecord(row.body, match.body) && !await evolved(row, match))) return true;
    }
  }
  return false;
}

async function preflightSeedPlan(tx: WorkflowTransactionContext, plan: WorkflowV2SeedPlan, legacyReader: Pick<Store, 'get' | 'list'>): Promise<string[]> {
  const evolved = seedEvolutionChecker(legacyReader, plan.businessDate);
  const rowsByTable = new Map<WorkflowStorageTable, PlannedRow[]>();
  for (const phase of plan.phases) {
    for (const row of phase.rows) {
      const rows = rowsByTable.get(row.table) ?? [];
      rows.push(row);
      rowsByTable.set(row.table, rows);
    }
  }

  const conflictingTables = new Set<string>();
  for (const [table, rows] of rowsByTable) {
    const existingById = new Map<string, ProjectedRow<SeedBody>>();
    for (let offset = 0; offset < rows.length; offset += 500) {
      const batch = rows.slice(offset, offset + 500);
      const existing = await tx.workflowProjectionReader.query<SeedBody>({
        kind: 'ids',
        table,
        ids: batch.map(row => row.body.id),
      });
      for (const current of existing) existingById.set(current.id, current);
    }

    for (const row of rows) {
      const current = existingById.get(row.body.id);
      if (current && !sameSeedRecord(row.body, current.body) && !await evolved(row, current)) conflictingTables.add(table);
    }
    if (await hasSeedNaturalKeyConflict(tx.workflowProjectionReader, table, rows, evolved)) conflictingTables.add(table);
  }
  return [...conflictingTables].sort();
}

function ledgerProfileBody(plan: WorkflowV2SeedPlan): SeedBody {
  const profile = plan.identities.ledgerProfile;
  return {
    id: profile.id,
    name: profile.name,
    role: profile.role,
    active: profile.active,
    permissions: [...profile.permissions],
    regions: [...profile.regions],
  };
}

async function persistSeedBeginMarker(store: WorkflowV2SeedStore, plan: WorkflowV2SeedPlan): Promise<BootstrapDecision> {
  const marker = seedBeginRecord(plan);
  const actor = ledgerProfileBody(plan);
  return store.workflowTransaction(async tx => {
    const existingMarker = await tx.workflowProjectionReader.get<unknown>('audit_events', marker.id);
    const existingActor = await tx.workflowProjectionReader.get<unknown>('profiles', actor.id);
    if (existingMarker) {
      if (sameSeedRecord(marker, existingMarker.body) && existingActor && sameSeedRecord(actor, existingActor.body)) {
        const conflictingTables = await preflightSeedPlan(tx, plan, store);
        if (conflictingTables.length > 0) return { state: 'seed_plan_conflict', blockedTables: conflictingTables };
        return { state: 'resumed', blockedTables: [] };
      }
      return { state: 'seed_plan_conflict', blockedTables: [] };
    }

    const conflictingTables = await preflightSeedPlan(tx, plan, store);
    if (conflictingTables.length > 0) return { state: 'legacy_base_requires_seed_plan', blockedTables: conflictingTables };

    const insertedActor = await tx.insertUnique('profiles', actor, {
      constraint: 'profiles_primary_key',
      values: { id: actor.id },
    });
    const currentActor = insertedActor.inserted ? insertedActor.row : insertedActor.existing;
    if (!sameSeedRecord(actor, currentActor)) return { state: 'seed_plan_conflict', blockedTables: [] };

    const insertedMarker = await tx.insertUnique('audit_events', marker, {
      constraint: 'audit_events_primary_key',
      values: { id: marker.id },
    });
    const currentMarker = insertedMarker.inserted ? insertedMarker.row : insertedMarker.existing;
    if (!sameSeedRecord(marker, currentMarker)) return { state: 'seed_plan_conflict', blockedTables: [] };
    return { state: 'started', blockedTables: [] };
  });
}

async function insertPlanRow(tx: WorkflowTransactionContext, row: PlannedRow, evolved = seedEvolutionChecker(tx)): Promise<boolean> {
  // insertPhase has already prefetched these IDs into the adapter's transaction cache.
  const existing = await tx.workflowProjectionReader.get<unknown>(row.table, row.body.id);
  if (existing) {
    if (!sameSeedRecord(row.body, existing.body) && !await evolved(row, existing)) {
      throw new DomainError('CONFLICT', `Existing ${row.table}/${row.body.id} differs from the immutable seed plan`, 409);
    }
    return false;
  }

  const result = await tx.insertUnique(row.table, row.body, primaryKey(row));
  const current = result.inserted ? result.row : result.existing;
  if (!sameSeedRecord(row.body, current)) {
    // Validate the winner with its unique-probe native version. An ID reread may still hold stale absence.
    // Older adapters without that metadata must provide matching projected evidence or conflict safely.
    const concurrent = !result.inserted && result.existingRowVersion !== undefined
      ? { id: current.id, rowVersion: result.existingRowVersion, body: current }
      : await tx.workflowProjectionReader.get<unknown>(row.table, row.body.id);
    if (!concurrent || !sameSeedRecord(concurrent.body as SeedBody, current) || !await evolved(row, concurrent)) {
      throw new DomainError('CONFLICT', `Existing ${row.table}/${row.body.id} differs from the immutable seed plan`, 409);
    }
  }
  return result.inserted;
}

function phaseLedgerBody(plan: WorkflowV2SeedPlan, phase: SourceSeedPhase, rows: readonly PlannedRow[]): SeedBody {
  const plannedCounts: Record<string, number> = {};
  for (const row of rows) plannedCounts[row.table] = (plannedCounts[row.table] ?? 0) + 1;
  return {
    id: seededId(plan.seed, `phase-ledger:${phase}`), actorId: plan.identities.ledgerProfileId,
    category: 'synthetic_workflow_v2_seed_phase',
    summary: canonical({ provenance: 'synthetic_demo_seed', generator: SYNTHETIC_SEED_GENERATOR,
      seedVersion: plan.seedVersion, seedTag: plan.seedTag, inputDigest: plan.inputDigest,
      phaseDigest: phaseDigest(plan.seed, plan.businessDate, plan.sourceDigest, phase, rows),
      sourceDigest: plan.sourceDigest, phase, plannedCounts }),
    createdAt: plan.createdAt, correlationId: seededId(plan.seed, `phase-correlation:${phase}`),
    targetRefs: rows.map(row => ({ table: row.table, id: row.body.id })), outcome: 'seeded_synthetic_source',
  };
}

async function insertPhase(
  tx: WorkflowTransactionContext,
  plan: WorkflowV2SeedPlan,
  phase: SourceSeedPhase,
  rows: readonly PlannedRow[],
  legacyReader: Pick<Store, 'get' | 'list'> = tx,
): Promise<WorkflowV2SeedPhaseSummary> {
  let inserted = 0;
  let alreadyCurrent = 0;
  const phaseHash = phaseDigest(plan.seed, plan.businessDate, plan.sourceDigest, phase, rows);
  const byTable: Record<string, { inserted: number; alreadyCurrent: number }> = {};
  const evolved = seedEvolutionChecker(legacyReader, plan.businessDate);

  // One ids read per table batch instead of one probe per row (the adapter remembers presence and absence).
  const idsByTable = new Map<WorkflowStorageTable, string[]>();
  for (const row of rows) idsByTable.set(row.table, [...(idsByTable.get(row.table) ?? []), row.body.id]);
  for (const [table, ids] of idsByTable) {
    for (let offset = 0; offset < ids.length; offset += 100) {
      await tx.workflowProjectionReader.query<SeedBody>({ kind: 'ids', table, ids: ids.slice(offset, offset + 100) });
    }
  }

  for (const row of rows) {
    const wasInserted = await insertPlanRow(tx, row, evolved);
    const counts = byTable[row.table] ?? { inserted: 0, alreadyCurrent: 0 };
    if (wasInserted) {
      inserted += 1;
      counts.inserted += 1;
    } else {
      alreadyCurrent += 1;
      counts.alreadyCurrent += 1;
    }
    byTable[row.table] = counts;
  }

  const ledgerId = seededId(plan.seed, `phase-ledger:${phase}`);
  const auditBody = phaseLedgerBody(plan, phase, rows);
  const ledger = await insertPlanRow(tx, plannedRow('audit_events', auditBody, {
    key: { constraint: 'audit_events_primary_key', values: { id: ledgerId } },
  }));

  return {
    phase,
    digest: phaseHash,
    rows: rows.length,
    inserted,
    alreadyCurrent,
    byTable,
    ledgerId,
    ledgerInserted: ledger,
  };
}

/** Cold instances validate all sources and phase certificates once, in one revision envelope.
 * Missing/conflicting rows fall back to the original guarded bootstrap/resume path. */
async function currentSeedPhases(store: WorkflowV2SeedStore, plan: WorkflowV2SeedPlan, includeManagerSummary: boolean): Promise<{ phases: WorkflowV2SeedPhaseSummary[]; managerAdvancement: WorkflowV2SeedResult['managerAdvancement'] | null } | null> {
  // Read through the snapshot-scoped reader, not a workflowTransaction: the seed write path then keeps its original
  // transaction sequence (marker, then phases) when this precheck finds the plan incomplete.
  return withReadSnapshot(store, async () => {
    const reader = store.workflowProjectionReader;
    const marker = seedBeginRecord(plan), actor = ledgerProfileBody(plan);
    const [storedMarker, storedActor] = await Promise.all([
      reader.get<unknown>('audit_events', marker.id),
      reader.get<unknown>('profiles', actor.id),
    ]);
    if (!storedMarker || !storedActor || !sameSeedRecord(marker, storedMarker.body) || !sameSeedRecord(actor, storedActor.body)) return null;
    const planned = [...plan.phases.flatMap(phase => phase.rows), ...plan.phases.map(phase => plannedRow('audit_events', phaseLedgerBody(plan, phase.phase, phase.rows)))];
    const byTable = new Map<WorkflowStorageTable, PlannedRow[]>();
    for (const row of planned) { const rows = byTable.get(row.table) ?? []; rows.push(row); byTable.set(row.table, rows); }
    // Scope scans both enforce off-plan natural keys and prime these tables' native row cache.
    // Validate their planned IDs through get below instead of refetching the same projected rows.
    const naturalTables = new Set([...byTable].filter(([table, rows]) => rows.some(row => primaryKey(row).constraint !== `${table}_primary_key`)).map(([table]) => table));
    const naturalSources = [...byTable].filter(([table]) => naturalTables.has(table));
    const evolved = seedEvolutionChecker(store, plan.businessDate);
    for (let offset = 0; offset < naturalSources.length; offset += 8) {
      const conflicts = await Promise.all(naturalSources.slice(offset, offset + 8).map(([table, rows]) => hasSeedNaturalKeyConflict(reader, table, rows, evolved)));
      if (conflicts.some(Boolean)) return null;
    }
    const batches: { table: WorkflowStorageTable; rows: PlannedRow[] }[] = [];
    for (const [table, rows] of byTable) for (let offset = 0; offset < rows.length; offset += 100) batches.push({ table, rows: rows.slice(offset, offset + 100) });
    let ready = true;
    // Bound simultaneous HTTPS calls while allowing independent source batches to overlap.
    for (let offset = 0; offset < batches.length; offset += 8) await Promise.all(batches.slice(offset, offset + 8).map(async batch => {
      const rows: ProjectedRow<SeedBody>[] = [];
      if (naturalTables.has(batch.table)) {
        // Keep cache misses sequential within a batch so a partial DB still has at most eight reads in flight.
        for (const row of batch.rows) {
          const current = await reader.get<SeedBody>(batch.table, row.body.id);
          if (current) rows.push(current);
        }
      } else rows.push(...await reader.query<SeedBody>({ kind: 'ids', table: batch.table, ids: batch.rows.map(row => row.body.id) }));
      const existing = new Map(rows.map(row => [row.id, row]));
      for (const row of batch.rows) {
        const current = existing.get(row.body.id);
        if (!current || (!sameSeedRecord(row.body, current.body) && !await evolved(row, current))) ready = false;
      }
    }));
    if (!ready) return null;
    const phases = plan.phases.map(({ phase, rows }) => {
      const byTable: Record<string, { inserted: number; alreadyCurrent: number }> = {};
      for (const row of rows) { const counts = byTable[row.table] ?? { inserted: 0, alreadyCurrent: 0 }; counts.alreadyCurrent++; byTable[row.table] = counts; }
      return { phase, digest: phaseDigest(plan.seed, plan.businessDate, plan.sourceDigest, phase, rows), rows: rows.length,
        inserted: 0, alreadyCurrent: rows.length, byTable, ledgerId: seededId(plan.seed, `phase-ledger:${phase}`), ledgerInserted: false };
    });
    const managerAdvancement = includeManagerSummary ? await managerAdvancementSummary({ store }, plan,
    { seed: plan.seed, businessDate: plan.businessDate }) : null;
    return { phases, managerAdvancement };
  });
}

async function commitPhase(store: WorkflowV2SeedStore, plan: WorkflowV2SeedPlan, phase: WorkflowV2SeedPlan['phases'][number]): Promise<WorkflowV2SeedPhaseSummary> {
  return store.workflowTransaction(tx => insertPhase(tx, plan, phase.phase, phase.rows, store));
}

async function currentOnboardingRequest(
  reader: WorkflowProjectionReader,
  requestId: string,
): Promise<{ rowVersion: number; body: OnboardingRequest } | undefined> {
  const row = await reader.get<unknown>('onboarding_requests', requestId);
  if (!row) return undefined;
  const parsed = onboardingRequestSchema.safeParse(row.body);
  if (!parsed.success || parsed.data.id !== requestId || parsed.data.rowVersion !== row.rowVersion) return undefined;
  return { rowVersion: row.rowVersion, body: parsed.data };
}

async function hasCurrentSyntheticDocuments(
  reader: WorkflowProjectionReader,
  request: OnboardingRequest,
): Promise<boolean> {
  for (const documentType of demoWorkflowPolicyV1.requiredOnboardingDocuments) {
    const rows = await reader.query<Record<string, unknown>>({
      kind: 'unique',
      table: 'onboarding_documents',
      constraint: 'onboarding_documents_request_type_unique',
      values: { requestId: request.id, documentType },
    });
    if (rows.length !== 1) return false;
    const document = rows[0].body;
    if (document.requestId !== request.id || document.employeeId !== request.employeeId || document.documentType !== documentType ||
      document.status !== 'accepted' || document.policyVersion !== demoWorkflowPolicyV1.policyAcknowledgementVersion ||
      document.classification !== demoWorkflowPolicyV1.classification || typeof document.contentDigest !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(document.contentDigest) || document.withdrawnAt !== null) return false;
  }
  return true;
}

async function hasSeededOnboardingScope(
  reader: WorkflowProjectionReader,
  prepared: PreparedSeed,
  request: OnboardingRequest,
  queue: 'manager' | 'director',
): Promise<boolean> {
  const identities = prepared.identities;
  const identityId = queue === 'manager' ? identities.managerIdentityId : identities.directorIdentityId;
  const profileId = queue === 'manager' ? identities.managerProfile.id : identities.directorProfile.id;
  const role = queue === 'manager' ? 'east_manager' : 'hr_director';
  const purpose = queue === 'manager' ? 'manager_onboarding' : 'director_onboarding';
  const permissions = queue === 'manager'
    ? ['hr.onboarding.manager_read', 'hr.onboarding.manager_approve']
    : ['hr.onboarding.director_read', 'hr.onboarding.director_approve', 'hr.onboarding.return'];
  if (request.orgUnitId !== identities.hrOrgUnitId || request.managerIdentityId !== identities.managerIdentityId ||
    request.directorIdentityId !== identities.directorIdentityId) return false;

  const employee = await reader.get<Employee>('employees', request.employeeId);
  const branchId = employee?.body.branchId;
  if (!employee || !employee.body.active || !branchId || !identities.onboardingBranchIds.includes(branchId)) return false;
  const branch = await reader.get<Branch & { active?: boolean; orgUnitId?: string | null }>('branches', branchId);
  if (!branch || branch.body.region !== 'east' || branch.body.active === false) return false;
  if (branch.body.orgUnitId) {
    const linkedOrgUnit = await reader.get<Record<string, unknown>>('org_units', branch.body.orgUnitId);
    if (linkedOrgUnit?.body.active !== true) return false;
  }

  const profile = await reader.get<Profile>('profiles', profileId);
  const identity = await reader.get<Record<string, unknown>>('directory_identities', identityId);
  const orgUnit = await reader.get<Record<string, unknown>>('org_units', identities.hrOrgUnitId);
  if (!profile?.body.active || permissions.some(permission => !profile.body.permissions.includes(permission)) || !identity || !orgUnit || orgUnit.body.active !== true ||
    identity.body.profileId !== profileId || identity.body.role !== role || identity.body.active !== true || identity.body.orgUnitId !== identities.hrOrgUnitId) {
    return false;
  }

  const responsibilities = await reader.query<Record<string, unknown>>({
    kind: 'unique',
    table: 'responsibilities',
    constraint: 'responsibilities_open_identity_purpose_unique',
    values: { identityId, purpose, orgUnitId: identities.hrOrgUnitId },
  });
  if (responsibilities.length !== 1 || responsibilities[0].body.active !== true ||
    !Array.isArray(responsibilities[0].body.branchIds) || !(responsibilities[0].body.branchIds as unknown[]).includes(branchId)) return false;
  return hasCurrentSyntheticDocuments(reader, request);
}

async function hasVerifiedManagerExecution(
  reader: WorkflowProjectionReader,
  request: OnboardingRequest,
  managerProfileId: string,
  managerIdentityId: string,
): Promise<boolean> {
  if (request.state !== 'director_approval_pending' || request.rowVersion < 2 || !request.managerApprovalEventId ||
    request.managerApprovedBy !== managerIdentityId || !request.managerApprovedAt) return false;
  const eventRow = await reader.get<Record<string, unknown>>('onboarding_approval_events', request.managerApprovalEventId);
  if (!eventRow) return false;
  const event = eventRow.body;
  if (!Number.isSafeInteger(eventRow.rowVersion) || eventRow.rowVersion < 1 || event.id !== request.managerApprovalEventId ||
    event.requestId !== request.id || event.stage !== 'manager' || event.lifecycleId !== request.lifecycleId ||
    event.actorIdentityId !== managerIdentityId || event.decision !== 'approved' ||
    typeof event.executionId !== 'string' || event.createdAt !== request.managerApprovedAt) return false;

  const executionRow = await reader.get<unknown>('action_executions', event.executionId);
  if (!executionRow) return false;
  const parsedReceipt = workflowReceiptV2Schema.safeParse(executionRow.body);
  if (!parsedReceipt.success) return false;
  const receipt: WorkflowReceiptV2 = parsedReceipt.data;
  const targetId = `${request.id}:${request.lifecycleId}`;
  const targetProofs = receipt.proofs.filter(proof => proof.targetId === targetId);
  return receipt.id === event.executionId && receipt.actorId === managerProfileId && receipt.kind === 'onboarding_manager_approve' &&
    receipt.outcome === 'verified_success' && receipt.verifiedAt !== null && targetProofs.length === 1 &&
    targetProofs[0].ref.table === 'onboarding_approval_events' && targetProofs[0].ref.id === event.id &&
    targetProofs[0].outcome === 'verified_success' && targetProofs[0].executionId === receipt.id &&
    targetProofs[0].observedRowVersion === eventRow.rowVersion;
}

async function managerAdvancementSummary(
  server: WorkflowV2SeedServerOptions,
  prepared: PreparedSeed,
  options: WorkflowV2SeedOptions,
): Promise<WorkflowV2SeedResult['managerAdvancement']> {
  const requested = options.advanceManagerRequestIds;
  const selectedRequestIds = requested === undefined ? [] : [...requested];
  if (requested !== undefined) {
    invariant(selectedRequestIds.length > 0, 'WORKFLOW_INVALID_INPUT', 'Select at least one manager-ready synthetic request to advance');
    invariant(new Set(selectedRequestIds).size === selectedRequestIds.length,
      'WORKFLOW_INVALID_INPUT', 'Manager advancement request IDs must be unique');
    invariant(selectedRequestIds.every(id => prepared.identities.onboardingRequestIds.includes(id)),
      'WORKFLOW_INVALID_INPUT', 'Only this seed version’s exact synthetic onboarding request IDs may be selected');

    const pendingForRuntime = await server.store.workflowTransaction(async tx => {
    const reader=tx.workflowProjectionReader;
    let selectedRequestsReady = true;
    for (const requestId of selectedRequestIds) {
      const current = await currentOnboardingRequest(reader, requestId);
      if (!current) {
        selectedRequestsReady = false;
        break;
      }
      if (current.body.state === 'director_approval_pending' && await hasVerifiedManagerExecution(
        reader, current.body, prepared.identities.managerProfile.id, prepared.identities.managerIdentityId,
      ) && await hasSeededOnboardingScope(reader, prepared, current.body, 'director')) continue;
      if (current.body.state !== 'manager_review_pending' || current.body.managerIdentityId !== prepared.identities.managerIdentityId ||
        !(await hasSeededOnboardingScope(reader, prepared, current.body, 'manager'))) {
        selectedRequestsReady = false;
        break;
      }
    }

    const needsRuntime = selectedRequestsReady ? selectedRequestIds : [];
    const pendingForRuntime: string[] = [];
    for (const requestId of needsRuntime) {
      const current = await currentOnboardingRequest(reader, requestId);
      if (current?.body.state === 'manager_review_pending') pendingForRuntime.push(requestId);
    }
    return pendingForRuntime;
    });
    if (pendingForRuntime.length > 0 && server.advanceManagerApprovals) {
      try {
        await server.advanceManagerApprovals({
          requestIds: pendingForRuntime,
          managerIdentityId: prepared.identities.managerIdentityId,
          managerProfileId: prepared.identities.managerProfile.id,
          businessDate: prepared.businessDate,
        });
      } catch {
        // The persisted V2 receipt/event readback below determines whether any request advanced.
      }
    }
  }

  return server.store.workflowTransaction(async tx => {
  const reader=tx.workflowProjectionReader;
  const directorQueueRequestIds: string[] = [];
  const managerReadyRequestIds: string[] = [];
  for (const requestId of prepared.identities.onboardingRequestIds) {
    const current = await currentOnboardingRequest(reader, requestId);
    if (!current) continue;
    if (current.body.state === 'manager_review_pending' && current.body.managerIdentityId === prepared.identities.managerIdentityId &&
      await hasSeededOnboardingScope(reader, prepared, current.body, 'manager')) {
      managerReadyRequestIds.push(requestId);
    }
    if (await hasVerifiedManagerExecution(
      reader, current.body, prepared.identities.managerProfile.id, prepared.identities.managerIdentityId,
    ) && await hasSeededOnboardingScope(reader, prepared, current.body, 'director')) {
      directorQueueRequestIds.push(requestId);
    }
  }

  const allSelectedVerified = selectedRequestIds.length > 0 && selectedRequestIds.every(id => directorQueueRequestIds.includes(id));
  const state = selectedRequestIds.length === 0
    ? directorQueueRequestIds.length > 0 ? 'already_present' : 'not_requested'
    : allSelectedVerified ? 'verified' : 'runtime_unverified';
  return { state, selectedRequestIds, managerReadyRequestIds, directorQueueRequestIds };
  });
}

function assertSeedServer(server: WorkflowV2SeedServerOptions): void {
  invariant(server.store?.workflowContractVersion === 2 && typeof server.store.workflowTransaction === 'function' &&
    server.store.workflowProjectionReader !== undefined,
  'WORKFLOW_UNAVAILABLE', 'Workflow V2 seed initialization requires the guarded V2 storage capability', 503);
  invariant(server.advanceManagerApprovals === undefined || typeof server.advanceManagerApprovals === 'function',
    'WORKFLOW_UNAVAILABLE', 'The injected manager advancement dependency is invalid', 503);
}

function emptyManagerAdvancement(): WorkflowV2SeedResult['managerAdvancement'] {
  return { state: 'not_requested', selectedRequestIds: [], managerReadyRequestIds: [], directorQueueRequestIds: [] };
}

function bootstrapResult(
  plan: WorkflowV2SeedPlan,
  state: WorkflowV2SeedResult['state'],
  blockedTables: readonly string[],
  sourcePhases: readonly WorkflowV2SeedPhaseSummary[] = [],
  failedPhase?: string,
  failureCode?: string,
  seedBeginMarkerState: WorkflowV2SeedResult['seedBeginMarkerState'] = state === 'legacy_base_requires_seed_plan' ? 'blocked' :
    state === 'seed_plan_conflict' ? 'conflict' : 'current',
  failureMetadata?: StorageFailureMetadata,
): WorkflowV2SeedResult {
  return {
    seedVersion: plan.seedVersion,
    seed: plan.seed,
    businessDate: plan.businessDate,
    seedTag: plan.seedTag,
    inputDigest: plan.inputDigest,
    seedBeginMarkerId: seededId(plan.seed, 'seed-begin'),
    seedBeginMarkerState,
    state,
    sourcePhasesComplete: state === 'source_ready' && sourcePhases.length === plan.phases.length,
    bootstrapReady: state === 'source_ready' && sourcePhases.length === plan.phases.length,
    blockedTables,
    ...(failedPhase === undefined ? {} : { failedPhase }),
    ...(failureCode === undefined ? {} : { failureCode }),
    ...(failureMetadata === undefined ? {} : { failureMetadata }),
    sourcePhases,
    plannedOnboardingRequestIds: plan.identities.onboardingRequestIds,
    managerAdvancement: emptyManagerAdvancement(),
    directorQueueReady: false,
  };
}

/** Persist the immutable plan after its caller has created it from fresh SeedData. */
export async function persistWorkflowV2SeedPlan(
  server: WorkflowV2SeedServerOptions,
  plan: WorkflowV2SeedPlan,
  options: Pick<WorkflowV2SeedOptions, 'advanceManagerRequestIds'> = {},
): Promise<WorkflowV2SeedResult> {
  assertSeedServer(server);
  assertPlanIntegrity(plan);
  validateManagerSelection(plan, options);
  // SQLite has no HTTPS cost and retains its existing observable write-phase boundaries.
  const current = server.store.adapter === 'supabase'
    ? await currentSeedPhases(server.store, plan, options.advanceManagerRequestIds === undefined) : null;
  if (current) {
    const managerAdvancement = current.managerAdvancement ?? await managerAdvancementSummary(server, plan, { seed: plan.seed, businessDate: plan.businessDate,
      ...(options.advanceManagerRequestIds === undefined ? {} : { advanceManagerRequestIds: options.advanceManagerRequestIds }) });
    return { ...bootstrapResult(plan, 'source_ready', [], current.phases), managerAdvancement,
      directorQueueReady: managerAdvancement.directorQueueRequestIds.length > 0 };
  }
  const bootstrap = await persistSeedBeginMarker(server.store, plan);
  if (bootstrap.state === 'legacy_base_requires_seed_plan' || bootstrap.state === 'seed_plan_conflict') {
    return bootstrapResult(plan, bootstrap.state, bootstrap.blockedTables);
  }
  const seedBeginMarkerState = bootstrap.state === 'started' ? 'inserted' : 'current';

  const sourcePhases: WorkflowV2SeedPhaseSummary[] = [];
  for (const phase of plan.phases) {
    try {
      sourcePhases.push(await commitPhase(server.store, plan, phase));
    } catch (error) {
      const failureCode = error instanceof DomainError ? error.code : 'STORAGE';
      return bootstrapResult(plan, 'source_phase_incomplete', [], sourcePhases, phase.phase, failureCode, seedBeginMarkerState, getStorageFailureMetadata(error));
    }
  }

  const managerAdvancement = await managerAdvancementSummary(server, plan, {
    seed: plan.seed,
    businessDate: plan.businessDate,
    ...(options.advanceManagerRequestIds === undefined ? {} : { advanceManagerRequestIds: options.advanceManagerRequestIds }),
  });
  return {
    seedVersion: plan.seedVersion,
    seed: plan.seed,
    businessDate: plan.businessDate,
    seedTag: plan.seedTag,
    inputDigest: plan.inputDigest,
    seedBeginMarkerId: seededId(plan.seed, 'seed-begin'),
    seedBeginMarkerState,
    state: 'source_ready',
    sourcePhasesComplete: true,
    bootstrapReady: true,
    blockedTables: [],
    sourcePhases,
    plannedOnboardingRequestIds: plan.identities.onboardingRequestIds,
    managerAdvancement,
    directorQueueReady: managerAdvancement.directorQueueRequestIds.length > 0,
  };
}

/** Compatibility wrapper. Fresh bootstrap callers should prepare the plan before persistence. */
export function createWorkflowV2SeedInitializer(server: WorkflowV2SeedServerOptions) {
  assertSeedServer(server);
  return async function initializeWorkflowV2Seed(seedData: SeedData, options: WorkflowV2SeedOptions): Promise<WorkflowV2SeedResult> {
    const plan = prepareWorkflowV2SeedPlan(seedData, options);
    return persistWorkflowV2SeedPlan(server, plan, options);
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Additive demo Director queue. The base plan (and therefore its seed-begin digest, which a persisted store may already carry)
// is NOT changed: a few more COMPLETE onboarding requests are inserted as one extra, independently ledgered phase and then
// advanced to Director approval through the injected REAL manager runtime (never by writing director-pending rows).
// ---------------------------------------------------------------------------------------------------------------------
/** Employees already in an onboarding, contract or offboarding lifecycle are never reused for the extra demo requests. */
const EMPLOYEE_LIFECYCLE_TABLES: ReadonlySet<string> = new Set(['onboarding_requests', 'employment_contracts', 'offboarding_cases', 'asset_assignments']);
const DEMO_QUEUE_PHASE = 'demo_queue_extension:v1';
const DEMO_QUEUE_START_OFFSETS = [10, 17, 24] as const;
interface DemoQueueRowSpec { readonly namespace: string; readonly ordinal: number; readonly skip: number; readonly startOffsets: readonly number[] }
const DEMO_QUEUE_SPEC: DemoQueueRowSpec = { namespace: 'demo-queue', ordinal: 0, skip: 0, startOffsets: DEMO_QUEUE_START_OFFSETS };

export interface WorkflowV2DemoQueueResult {
  readonly state: 'not_requested' | 'verified' | 'runtime_unverified';
  readonly requestIds: readonly string[];
  readonly directorQueueRequestIds: readonly string[];
}

function demoQueueRows(plan: WorkflowV2SeedPlan, spec: DemoQueueRowSpec = DEMO_QUEUE_SPEC): { requestIds: string[]; rows: PlannedRow[] } {
  const used = new Set<string>();
  for (const phase of plan.phases) for (const row of phase.rows) {
    if (EMPLOYEE_LIFECYCLE_TABLES.has(row.table) && typeof row.body.employeeId === 'string') used.add(row.body.employeeId);
  }
  const branchIds = new Set(plan.identities.onboardingBranchIds);
  const candidates = rotated(plan.seedData.employees
    .filter((employee): employee is Employee & { branchId: string } => employee.active && employee.branchId !== null && branchIds.has(employee.branchId) && !used.has(employee.id))
    .sort(compareId), plan.seed).slice(spec.skip, spec.skip + spec.startOffsets.length);
  const createdAtDate = getBangkokCalendarDate(new Date(plan.createdAt));
  const requestIds: string[] = [];
  const rows: PlannedRow[] = [];
  for (const [index, employee] of candidates.entries()) {
    const requestId = seededId(plan.seed, `v2-onboarding-request-${spec.namespace}`, spec.ordinal + index);
    const lifecycleId = seededId(plan.seed, `onboarding-lifecycle-${spec.namespace}`, spec.ordinal + index);
    requestIds.push(requestId);
    rows.push(plannedRow('onboarding_requests', {
      id: requestId,
      rowVersion: 1,
      employeeId: employee.id,
      orgUnitId: plan.identities.hrOrgUnitId,
      managerIdentityId: plan.identities.managerIdentityId,
      directorIdentityId: plan.identities.directorIdentityId,
      startDate: addBangkokCalendarDays(createdAtDate, spec.startOffsets[index]),
      state: 'manager_review_pending',
      lifecycleId,
      managerApprovalEventId: null,
      managerApprovedBy: null,
      managerApprovedAt: null,
      directorApprovalEventId: null,
      directorApprovedBy: null,
      directorApprovedAt: null,
      createdAt: plan.createdAt,
      updatedAt: plan.createdAt,
    }, { key: { constraint: 'onboarding_requests_open_employee_lifecycle_unique', values: { employeeId: employee.id, lifecycleId } } }));
    for (const [documentIndex, documentType] of demoWorkflowPolicyV1.requiredOnboardingDocuments.entries()) {
      rows.push(plannedRow('onboarding_documents', {
        id: seededId(plan.seed, `v2-onboarding-document-${spec.namespace}`, (spec.ordinal + index) * demoWorkflowPolicyV1.requiredOnboardingDocuments.length + documentIndex),
        rowVersion: 1,
        requestId,
        employeeId: employee.id,
        documentType,
        status: 'accepted',
        policyVersion: demoWorkflowPolicyV1.policyAcknowledgementVersion,
        classification: demoWorkflowPolicyV1.classification,
        contentDigest: digest({ namespace: SYNTHETIC_SEED_NAMESPACE, seed: plan.seed, seedVersion: WORKFLOW_V2_SEED_VERSION, requestId, documentType, provenance: 'synthetic_demo_document_fixture' }),
        createdAt: plan.createdAt,
        withdrawnAt: null,
      }, { key: { constraint: 'onboarding_documents_request_type_unique', values: { requestId, documentType } } }));
    }
  }
  return { requestIds, rows };
}

/**
 * Inserts the demo-queue requests (idempotent, insert-if-absent) and, when `advance` is set, moves exactly the still-manager-stage
 * ones through the injected real manager runtime. Call only after the base plan reached `source_ready`.
 */
export async function persistWorkflowV2DemoQueue(
  server: WorkflowV2SeedServerOptions,
  plan: WorkflowV2SeedPlan,
  options: { readonly advance: boolean },
): Promise<WorkflowV2DemoQueueResult> {
  assertSeedServer(server);
  assertPlanIntegrity(plan);
  const { requestIds, rows } = demoQueueRows(plan);
  if (requestIds.length === 0) return { state: 'not_requested', requestIds, directorQueueRequestIds: [] };
  await commitPhase(server.store, plan, { phase: DEMO_QUEUE_PHASE, rows });
  if (options.advance && server.advanceManagerApprovals) {
    const pending = await server.store.workflowTransaction(async tx => {
    const reader = tx.workflowProjectionReader;
    const pending: string[] = [];
    for (const requestId of requestIds) {
      const current = await currentOnboardingRequest(reader, requestId);
      if (current?.body.state === 'manager_review_pending' && await hasSeededOnboardingScope(reader, plan, current.body, 'manager')) pending.push(requestId);
    }
    return pending;
    });
    if (pending.length > 0) {
      try {
        await server.advanceManagerApprovals({ requestIds: pending, managerIdentityId: plan.identities.managerIdentityId,
          managerProfileId: plan.identities.managerProfile.id, businessDate: plan.businessDate });
      } catch {
        // Verified by readback below; an unadvanced request simply stays at the manager stage.
      }
    }
  }
  return server.store.workflowTransaction(async tx => {
  const reader = tx.workflowProjectionReader;
  const directorQueueRequestIds: string[] = [];
  for (const requestId of requestIds) {
    const current = await currentOnboardingRequest(reader, requestId);
    if (current && await hasVerifiedManagerExecution(reader, current.body, plan.identities.managerProfile.id, plan.identities.managerIdentityId) &&
      await hasSeededOnboardingScope(reader, plan, current.body, 'director')) directorQueueRequestIds.push(requestId);
  }
  return { state: !options.advance ? 'not_requested' : directorQueueRequestIds.length === requestIds.length ? 'verified' : 'runtime_unverified', requestIds, directorQueueRequestIds };
  });
}

export type WorkflowV2DirectorIdentityEnsure = 'inserted' | 'present_bound' | 'present_mismatch' | 'deferred_to_v2_bootstrap';

/**
 * Hosted/legacy readiness: insert-if-absent of ONLY the HR Director directory identity, its Director responsibility and its reporting
 * lines from the canonical plan. Existing rows are never rewritten. `present_mismatch` means an older seed bound that identity to a
 * different profile; that needs an explicit, reviewed reconcile (see docs/BIZTANIA_WAVE5_LOCAL_PG.md), never an automatic rewrite.
 */
export async function ensureWorkflowV2DirectorIdentity(store: WorkflowV2SeedStore, plan: WorkflowV2SeedPlan): Promise<WorkflowV2DirectorIdentityEnsure> {
  assertPlanIntegrity(plan);
  const directorId = plan.identities.directorIdentityId;
  const authority = plan.phases.filter(phase => phase.phase === 'authority').flatMap(phase => phase.rows).filter(row =>
    (row.table === 'directory_identities' && row.body.id === directorId) ||
    (row.table === 'responsibilities' && row.body.identityId === directorId) ||
    (row.table === 'reporting_relationships' && (row.body.managerIdentityId === directorId || row.body.reportIdentityId === directorId)));
  invariant(authority.some(row => row.table === 'directory_identities'), 'WORKFLOW_INVALID_INPUT', 'The seed plan has no Director identity');
  return store.workflowTransaction(async tx => {
    const reader = tx.workflowProjectionReader;
    const orgUnits = await reader.get<Record<string, unknown>>('org_units', plan.identities.hrOrgUnitId);
    if (!orgUnits) return 'deferred_to_v2_bootstrap';
    const existing = await reader.get<Record<string, unknown>>('directory_identities', directorId);
    if (existing) return existing.body.profileId === plan.identities.directorProfile.id ? 'present_bound' : 'present_mismatch';
    for (const row of authority) await insertPlanRow(tx, row);
    return 'inserted';
  });
}

/**
 * A later-arriving request for tests/E2E: one more complete synthetic onboarding request (distinct id per `ordinal`, the earliest start
 * date) inserted AFTER a Director review and advanced to Director approval through the injected REAL manager runtime. It reuses the
 * demo-queue builder, so it is exactly as authentic as the seeded queue; the demo queue itself is never touched.
 */
export async function persistWorkflowV2LateArrival(
  server: WorkflowV2SeedServerOptions,
  plan: WorkflowV2SeedPlan,
  ordinal: number,
): Promise<{ requestId: string; directorPending: boolean }> {
  assertSeedServer(server);
  assertPlanIntegrity(plan);
  invariant(Number.isSafeInteger(ordinal) && ordinal >= 0 && ordinal < 100, 'WORKFLOW_INVALID_INPUT', 'Invalid arrival ordinal');
  // Candidates after the demo-queue employees, one distinct employee per ordinal.
  const { requestIds, rows } = demoQueueRows(plan, { namespace: 'late-arrival', ordinal, skip: DEMO_QUEUE_START_OFFSETS.length + ordinal, startOffsets: [3] });
  invariant(requestIds.length === 1, 'WORKFLOW_INVALID_INPUT', 'No free synthetic employee remains for another arrival');
  await commitPhase(server.store, plan, { phase: `late_arrival:${ordinal}`, rows });
  const reader = server.store.workflowProjectionReader;
  const current = await currentOnboardingRequest(reader, requestIds[0]);
  if (current?.body.state === 'manager_review_pending' && server.advanceManagerApprovals) {
    await server.advanceManagerApprovals({ requestIds, managerIdentityId: plan.identities.managerIdentityId,
      managerProfileId: plan.identities.managerProfile.id, businessDate: plan.businessDate });
  }
  const after = await currentOnboardingRequest(reader, requestIds[0]);
  return { requestId: requestIds[0], directorPending: !!after && await hasVerifiedManagerExecution(reader, after.body, plan.identities.managerProfile.id, plan.identities.managerIdentityId) &&
    await hasSeededOnboardingScope(reader, plan, after.body, 'director') };
}
