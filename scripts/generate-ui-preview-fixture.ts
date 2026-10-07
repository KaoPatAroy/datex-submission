import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Actor, Reader, RowFilter, SeedData, Scope, Table } from '../lib/contracts';
import { deterministicAnalysis, readEvidence } from '../lib/core/evidence';
import { digest } from '../lib/core/utils';
import { createSeedData } from '../lib/seed/generate';
import { matchesRowFilter } from '../lib/storage/filters';
import {
  defaultDemoWorkflowPolicy,
  directoryIdentitySchema,
  entityStateSchema,
  isoDateSchema,
  onboardingRequestSchema,
  policyPinSchema,
  preparationResultSchema,
  recipientDashboardViewSchema,
  responsibilitySchema,
  reviewSnapshotSchema,
  workflowActionKinds,
  workflowActionPayloadSchema,
  workflowEntityTables,
  workflowReceiptV2Schema,
  versionedDemoWorkflowPolicySchema,
  allowedCapabilitySchema,
  conversationContextViewSchema,
  conversationMetadataSchema,
  type AllowedCapability,
  type DirectoryIdentity,
  type WorkflowActionKind,
  type WorkflowEntityTable
} from '../lib/workflows/contracts';

const DEFAULT_BUSINESS_DATE = '2026-10-01';
const DEFAULT_SEED = 1;
const OUTPUT_RELATIVE_PATH = 'prototypes/biztania-workspace/demo-data.json';
const ORG_HQ = 'ORG-DEMO-HQ';
const ORG_EAST = 'ORG-DEMO-EAST';
const ORG_EAST_HR = 'ORG-DEMO-EAST-HR';
const ORG_WEST_HR = 'ORG-DEMO-WEST-HR';
const IDENTITY = {
  executive: 'DIR-EXECUTIVE',
  east: 'DIR-EAST-MANAGER',
  hr: 'DIR-HR-ADMIN',
  director: 'DIR-HR-DIRECTOR'
} as const;
const SAMPLE = {
  dashboard: 'DASH-DEMO-001',
  share: 'SHARE-DEMO-001',
  eastCase: 'CASE-E01-DEMO-001',
  opportunity: 'CRM-OPP-DEMO-001',
  eastOpenIncident: 'INC-E01-DEMO-OPEN',
  restockRequest: 'RST-DEMO-EXISTING',
  branchAssignment: 'BRA-DEMO-EXISTING',
  offboardingCase: 'OFF-DEMO-001',
  offboardingPlan: 'PLAN-DEMO-001',
  assetAssignment: 'ASG-DEMO-E024-LAPTOP',
  contract: 'CON-DEMO-001',
  policyDocument: 'POL-HR-DEMO-001'
} as const;

type ProfileId = 'executive' | 'east' | 'hr' | 'hr_director';
type ExampleCaseType = 'eligible' | 'denied' | 'already_completed' | 'stale';
type PreviewProfile = {
  id: ProfileId;
  name: string;
  role: 'executive' | 'east_manager' | 'hr_admin' | 'hr_director';
  active: true;
  permissions: string[];
  regions: string[];
  directoryIdentityId: string;
};
type ExampleInput = Record<string, unknown> & { kind: WorkflowActionKind };
type ExampleRef = { table: WorkflowEntityTable; id: string };
type ScenarioStateOverrides = {
  previewOnly: true;
  existingExecutionId: string;
  workflowEntities: Partial<Record<WorkflowEntityTable, Record<string, unknown>[]>>;
};
type CompletedScenario = {
  actorProfileId: ProfileId;
  actionId: string;
  input: ExampleInput;
  ref: ExampleRef;
  currentState: ReturnType<typeof entityStateSchema.parse>;
  queueSnapshot: ReturnType<typeof makeQueueSnapshot> | null;
  stateOverrides: ScenarioStateOverrides;
};

const ACTION_PERMISSION: Record<WorkflowActionKind, string> = {
  dashboard_create: 'dashboard.create',
  dashboard_share: 'dashboard.share',
  dashboard_share_revoke: 'dashboard.share',
  investigation_create: 'ticket.create',
  restock_create: 'restock.create',
  crm_followup_create: 'crm.followup.create',
  incident_escalate: 'incident.escalate',
  discount_request_create: 'discount.request.create',
  branch_review_assign: 'branch.review.assign',
  onboarding_manager_approve: 'hr.onboarding.manager_approve',
  onboarding_director_approve: 'hr.onboarding.director_approve',
  onboarding_return: 'hr.onboarding.return',
  onboarding_start: 'hr.onboarding.start',
  onboarding_tasks_create: 'hr.onboarding.tasks',
  offboarding_plan_create: 'hr.offboarding.plan',
  it_disable_request: 'hr.it_disable.request',
  asset_return_create: 'hr.asset_return.create',
  badge_revoke: 'badge.revoke',
  contract_reminder_create: 'hr.contract.reminder',
  policy_acknowledgement_assign: 'hr.policy.assign'
};

const ACTION_DEPARTMENT: Record<WorkflowActionKind, 'sales' | 'operations' | 'hr'> = {
  dashboard_create: 'sales',
  dashboard_share: 'sales',
  dashboard_share_revoke: 'sales',
  investigation_create: 'operations',
  restock_create: 'operations',
  crm_followup_create: 'sales',
  incident_escalate: 'operations',
  discount_request_create: 'sales',
  branch_review_assign: 'operations',
  onboarding_manager_approve: 'hr',
  onboarding_director_approve: 'hr',
  onboarding_return: 'hr',
  onboarding_start: 'hr',
  onboarding_tasks_create: 'hr',
  offboarding_plan_create: 'hr',
  it_disable_request: 'hr',
  asset_return_create: 'hr',
  badge_revoke: 'hr',
  contract_reminder_create: 'hr',
  policy_acknowledgement_assign: 'hr'
};

const ACTION_REFS: Record<WorkflowActionKind, ExampleRef> = {
  dashboard_create: { table: 'dashboard_versions', id: 'DASHVER-DEMO-001' },
  dashboard_share: { table: 'dashboard_shares', id: SAMPLE.share },
  dashboard_share_revoke: { table: 'dashboard_shares', id: SAMPLE.share },
  investigation_create: { table: 'investigation_cases', id: SAMPLE.eastCase },
  restock_create: { table: 'restock_requests', id: SAMPLE.restockRequest },
  crm_followup_create: { table: 'crm_opportunities', id: SAMPLE.opportunity },
  incident_escalate: { table: 'incidents', id: 'INC-005' },
  discount_request_create: { table: 'crm_opportunities', id: SAMPLE.opportunity },
  branch_review_assign: { table: 'branch_review_assignments', id: SAMPLE.branchAssignment },
  onboarding_manager_approve: { table: 'onboarding_requests', id: 'ONB-DEMO-001' },
  onboarding_director_approve: { table: 'onboarding_requests', id: 'ONB-DEMO-002' },
  onboarding_return: { table: 'onboarding_requests', id: 'ONB-DEMO-002' },
  onboarding_start: { table: 'onboarding_requests', id: 'ONB-DEMO-007' },
  onboarding_tasks_create: { table: 'onboarding_requests', id: 'ONB-DEMO-011' },
  offboarding_plan_create: { table: 'offboarding_cases', id: SAMPLE.offboardingCase },
  it_disable_request: { table: 'offboarding_cases', id: SAMPLE.offboardingCase },
  asset_return_create: { table: 'asset_assignments', id: SAMPLE.assetAssignment },
  badge_revoke: { table: 'mock_badges', id: 'C102' },
  contract_reminder_create: { table: 'employment_contracts', id: SAMPLE.contract },
  policy_acknowledgement_assign: { table: 'policy_documents', id: SAMPLE.policyDocument }
};

const INITIAL_STATE: Record<WorkflowActionKind, string> = {
  dashboard_create: 'not_created',
  dashboard_share: 'not_shared',
  dashboard_share_revoke: 'active',
  investigation_create: 'not_assigned',
  restock_create: 'eligible',
  crm_followup_create: 'eligible',
  incident_escalate: 'un_escalated',
  discount_request_create: 'eligible',
  branch_review_assign: 'not_assigned',
  onboarding_manager_approve: 'manager_review_pending',
  onboarding_director_approve: 'director_approval_pending',
  onboarding_return: 'director_approval_pending',
  onboarding_start: 'director_approved',
  onboarding_tasks_create: 'onboarding_in_progress',
  offboarding_plan_create: 'active',
  it_disable_request: 'planned',
  asset_return_create: 'assigned',
  badge_revoke: 'active',
  contract_reminder_create: 'eligible',
  policy_acknowledgement_assign: 'eligible'
};

const EXPECTED_STATE: Record<WorkflowActionKind, string> = {
  dashboard_create: 'created',
  dashboard_share: 'active',
  dashboard_share_revoke: 'revoked',
  investigation_create: 'open',
  restock_create: 'open',
  crm_followup_create: 'open',
  incident_escalate: 'team_requested',
  discount_request_create: 'manager_review_pending',
  branch_review_assign: 'open',
  onboarding_manager_approve: 'director_approval_pending',
  onboarding_director_approve: 'director_approved',
  onboarding_return: 'returned_for_revision',
  onboarding_start: 'onboarding_in_progress',
  onboarding_tasks_create: 'created',
  offboarding_plan_create: 'prepared',
  it_disable_request: 'requested',
  asset_return_create: 'open',
  badge_revoke: 'revoked',
  contract_reminder_create: 'open',
  policy_acknowledgement_assign: 'pending'
};

function localInstant(date: string, hour = 23, minute = 59, second = 0): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date}T${pad(hour)}:${pad(minute)}:${pad(second)}+07:00`;
}

function shiftDate(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function createSeedReader(seed: SeedData): Reader {
  const tables = seed as unknown as Record<string, unknown[]>;
  return {
    async list<T>(table: Table, filters?: RowFilter): Promise<T[]> {
      return (tables[table] ?? []).filter(row => matchesRowFilter(row, filters)) as T[];
    },
    async get<T>(table: Table, id: string): Promise<T | undefined> {
      return (tables[table] ?? []).find(row => typeof row === 'object' && row !== null && 'id' in row && row.id === id) as T | undefined;
    }
  };
}

function buildProfiles(seed: SeedData): PreviewProfile[] {
  const profile = (id: ProfileId, extra: string[], regions: string[], directoryIdentityId: string): PreviewProfile => {
    const source = seed.profiles.find(item => item.id === id);
    return {
      id,
      name: id === 'hr_director' ? 'Demo HR Director' : source?.name ?? 'Demo profile',
      role: id === 'hr_director' ? 'hr_director' : source!.role,
      active: true,
      permissions: [...new Set([...(source?.permissions ?? []), ...extra])].sort(),
      regions,
      directoryIdentityId
    };
  };
  return [
    profile('executive', [
      'crm.read', 'crm.followup.create', 'discount.request.create', 'restock.create', 'incident.escalate', 'branch.review.assign'
    ], ['east', 'central', 'south'], IDENTITY.executive),
    profile('east', [
      'restock.create', 'incident.escalate', 'branch.review.assign', 'hr.onboarding.manager_read', 'hr.onboarding.manager_approve'
    ], ['east'], IDENTITY.east),
    profile('hr', [
      'hr.onboarding.start', 'hr.onboarding.tasks', 'hr.offboarding.plan', 'hr.it_disable.request',
      'hr.asset_return.create', 'hr.contract.reminder', 'hr.policy.assign'
    ], ['east', 'central', 'south'], IDENTITY.hr),
    profile('hr_director', [
      'hr.onboarding.director_read', 'hr.onboarding.director_approve', 'hr.onboarding.return'
    ], [], IDENTITY.director)
  ];
}

function makeOrganization(date: string, branches: SeedData['branches'], profiles: PreviewProfile[]) {
  const eastBranches = branches.filter(branch => branch.region === 'east').map(branch => branch.id);
  const allBranches = branches.map(branch => branch.id);
  const orgUnits = [
    { id: ORG_HQ, name: 'Synthetic demonstration organization', active: true, rowVersion: 1 },
    { id: ORG_EAST, parentOrgUnitId: ORG_HQ, name: 'Synthetic East branch group', active: true, rowVersion: 1, branchIds: eastBranches },
    { id: ORG_EAST_HR, parentOrgUnitId: ORG_HQ, name: 'Synthetic East people unit', active: true, rowVersion: 1, branchIds: eastBranches },
    { id: ORG_WEST_HR, parentOrgUnitId: ORG_HQ, name: 'Synthetic out-of-scope people unit', active: true, rowVersion: 1, branchIds: ['C01', 'C02'] }
  ];
  const identities: DirectoryIdentity[] = profiles.map(profile => directoryIdentitySchema.parse({
    id: profile.directoryIdentityId,
    profileId: profile.id,
    displayName: profile.name,
    active: true,
    role: profile.role,
    department: profile.role === 'executive' || profile.role === 'east_manager' ? 'sales_operations' : 'hr',
    orgUnitId: profile.role === 'executive' ? ORG_HQ : profile.role === 'east_manager' ? ORG_EAST : ORG_EAST_HR,
    managerIdentityId: profile.role === 'hr_admin' ? IDENTITY.director : null,
    verifiedDemoEmail: `demo-${profile.id}@example.com`,
    slackIdentity: `demo-${profile.id}`,
    allowedChannels: ['simulated_email', 'simulated_slack'],
    classificationCeiling: 'internal',
    rowVersion: 1
  }));
  const responsibilities = [
    responsibility('RESP-EXEC-SALES', IDENTITY.executive, ORG_HQ, 'sales_operations', allBranches),
    responsibility('RESP-EAST-SALES', IDENTITY.east, ORG_EAST, 'sales_operations', eastBranches),
    responsibility('RESP-EAST-MANAGER-ONBOARDING', IDENTITY.east, ORG_EAST_HR, 'manager_onboarding', eastBranches),
    responsibility('RESP-HR-OPS', IDENTITY.hr, ORG_EAST_HR, 'hr_operations', allBranches),
    responsibility('RESP-HR-DIRECTOR', IDENTITY.director, ORG_EAST_HR, 'director_onboarding', eastBranches)
  ];
  const reportingRelationships = [
    { id: 'REPORT-DEMO-001', managerIdentityId: IDENTITY.director, reportIdentityId: IDENTITY.hr, active: true, rowVersion: 1 }
  ];
  return { orgUnits, identities, responsibilities, reportingRelationships, allBranches, eastBranches };
}

function responsibility(id: string, identityId: string, orgUnitId: string, purpose: 'sales_operations' | 'manager_onboarding' | 'director_onboarding' | 'hr_operations', branchIds: string[]) {
  return responsibilitySchema.parse({ id, identityId, orgUnitId, purpose, branchIds, active: true, rowVersion: 1 });
}

function addOnboardingRequest(input: {
  id: string;
  employeeId: string;
  orgUnitId: string;
  managerIdentityId?: string;
  directorIdentityId?: string;
  startDate: string;
  state: 'draft' | 'manager_review_pending' | 'director_approval_pending' | 'director_approved' | 'onboarding_in_progress' | 'completed' | 'returned_for_revision' | 'rejected' | 'cancelled';
  rowVersion?: number;
  managerApprovalEventId?: string | null;
  managerApprovedBy?: string | null;
  managerApprovedAt?: string | null;
  directorApprovalEventId?: string | null;
  directorApprovedBy?: string | null;
  directorApprovedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}) {
  return onboardingRequestSchema.parse({
    id: input.id,
    employeeId: input.employeeId,
    orgUnitId: input.orgUnitId,
    managerIdentityId: input.managerIdentityId ?? IDENTITY.east,
    directorIdentityId: input.directorIdentityId ?? IDENTITY.director,
    startDate: input.startDate,
    state: input.state,
    rowVersion: input.rowVersion ?? 1,
    lifecycleId: `LIFE-${input.id}`,
    managerApprovalEventId: input.managerApprovalEventId ?? null,
    managerApprovedBy: input.managerApprovedBy ?? null,
    managerApprovedAt: input.managerApprovedAt ?? null,
    directorApprovalEventId: input.directorApprovalEventId ?? null,
    directorApprovedBy: input.directorApprovedBy ?? null,
    directorApprovedAt: input.directorApprovedAt ?? null,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt
  });
}

function onboardingDocuments(requests: { id: string; employeeId: string }[], incompleteId: string, policyVersion: string, date: string) {
  const types = defaultDemoWorkflowPolicy.requiredOnboardingDocuments;
  return requests.flatMap(({ id: requestId, employeeId }) => types
    .filter((_, index) => requestId !== incompleteId || index < types.length - 1)
    .map((documentType, index) => ({
      id: `DOC-${requestId}-${index + 1}`,
      requestId,
      employeeId,
      lifecycleId: `LIFE-${requestId}`,
      documentType,
      policyVersion,
      state: 'accepted',
      uploadedAt: requestId === 'ONB-DEMO-006' || requestId === 'ONB-DEMO-012'
        ? localInstant(date, 23, 58, 45)
        : localInstant(date, 11, index + 1),
      rowVersion: 1,
      provenance: 'synthetic-fixture'
    })));
}

function makeQueueSnapshot(input: {
  id: string;
  actorId: string;
  purpose: 'manager_queue' | 'director_queue';
  requestId: string;
  rowVersion: number;
  simulatedClock: string;
  policyDigest: string;
  supportingRows?: { ref: ExampleRef; rowVersion: number; state: string | null }[];
}) {
  const createdAt = new Date(Date.parse(input.simulatedClock) - defaultDemoWorkflowPolicy.pendingTtlSeconds * 500).toISOString();
  const expiresAt = new Date(new Date(createdAt).valueOf() + defaultDemoWorkflowPolicy.pendingTtlSeconds * 1000).toISOString();
  const content = {
    id: input.id,
    actorId: input.actorId,
    actorSessionId: `SESSION-${input.actorId}`,
    purpose: input.purpose,
    orgUnitIds: [ORG_EAST_HR],
    displayedIds: [input.requestId],
    count: 1,
    expectedRows: [
      { ref: { table: 'onboarding_requests', id: input.requestId }, rowVersion: input.rowVersion, state: input.purpose === 'manager_queue' ? 'manager_review_pending' : 'director_approval_pending' },
      ...(input.supportingRows ?? [])
    ],
    policy: { id: 'demo-workflow', version: 1, digest: input.policyDigest },
    createdAt,
    expiresAt
  } as const;
  return reviewSnapshotSchema.parse({ ...content, digest: digest(content) });
}

function makeDirectorSnapshotScenarios(snapshot: ReturnType<typeof makeQueueSnapshot>, simulatedClock: string) {
  const expiredClock = new Date(Date.parse(simulatedClock) + defaultDemoWorkflowPolicy.pendingTtlSeconds * 1000).toISOString();
  if (Date.parse(snapshot.createdAt) > Date.parse(simulatedClock) || Date.parse(snapshot.expiresAt) <= Date.parse(simulatedClock)) {
    throw new Error('The normal Director scenario must have an active reviewed snapshot.');
  }
  if (Date.parse(snapshot.expiresAt) > Date.parse(expiredClock)) {
    throw new Error('The expired Director scenario must advance beyond the reviewed snapshot expiry.');
  }
  return {
    active: { simulatedClock, snapshot },
    expired: { simulatedClock: expiredClock, snapshot }
  };
}

function buildWorkflowEntities(seed: SeedData, businessDate: string, policyDigest: string, simulatedClock: string) {
  const entities = Object.fromEntries(workflowEntityTables.map(table => [table, [] as Record<string, unknown>[]])) as Record<WorkflowEntityTable, Record<string, unknown>[]>;
  const add = (table: WorkflowEntityTable, ...rows: Record<string, unknown>[]) => entities[table].push(...rows);

  add('branches', ...seed.branches as unknown as Record<string, unknown>[]);
  add('products', ...seed.products as unknown as Record<string, unknown>[]);
  add('employees', ...seed.employees as unknown as Record<string, unknown>[]);
  add('mock_badges', ...seed.mock_badges as unknown as Record<string, unknown>[]);
  add('mock_tickets', ...seed.mock_tickets as unknown as Record<string, unknown>[]);
  add('policy_documents', ...seed.policy_documents as unknown as Record<string, unknown>[]);
  add('incidents', ...seed.incidents as unknown as Record<string, unknown>[]);
  add('sales_orders', ...seed.sales_orders.slice(-20) as unknown as Record<string, unknown>[]);
  add('sales_targets', ...seed.sales_targets.slice(-12) as unknown as Record<string, unknown>[]);
  add('inventory_snapshots', ...seed.inventory_snapshots.filter(row => row.date === businessDate) as unknown as Record<string, unknown>[]);

  const policy = versionedDemoWorkflowPolicySchema.parse(defaultDemoWorkflowPolicy);
  add('workflow_policies', { ...policy, digest: policyDigest, source: 'synthetic-fixture' });
  add('org_units',
    { id: ORG_HQ, name: 'Synthetic demonstration organization', active: true, rowVersion: 1 },
    { id: ORG_EAST, parentOrgUnitId: ORG_HQ, name: 'Synthetic East branch group', active: true, rowVersion: 1 },
    { id: ORG_EAST_HR, parentOrgUnitId: ORG_HQ, name: 'Synthetic East people unit', active: true, rowVersion: 1 },
    { id: ORG_WEST_HR, parentOrgUnitId: ORG_HQ, name: 'Synthetic out-of-scope people unit', active: true, rowVersion: 1 }
  );

  const profiles = buildProfiles(seed);
  const organization = makeOrganization(businessDate, seed.branches, profiles);
  add('directory_identities', ...organization.identities as unknown as Record<string, unknown>[]);
  add('responsibilities', ...organization.responsibilities as unknown as Record<string, unknown>[]);
  add('reporting_relationships', ...organization.reportingRelationships);

  add('dashboards', {
    id: SAMPLE.dashboard,
    ownerIdentityId: IDENTITY.executive,
    title: 'Synthetic East performance dashboard',
    classification: 'internal',
    scope: { region: 'east', date: businessDate },
    currentVersionId: 'DASHVER-DEMO-001',
    rowVersion: 1,
    createdAt: localInstant(businessDate, 9, 0),
    provenance: 'synthetic-fixture'
  });
  add('dashboard_versions', {
    id: 'DASHVER-DEMO-001',
    dashboardId: SAMPLE.dashboard,
    version: 1,
    spec: {
      title: 'Synthetic East performance dashboard',
      description: 'Synthetic preview artifact derived from the seeded East evidence.',
      scope: { region: 'east', date: businessDate },
      widgets: [{ type: 'metric', metric: 'net_sales', title: 'net_sales' }]
    },
    sourceIds: [`sales:E01:${businessDate}`, `targets:E01:${businessDate}`],
    rowVersion: 1,
    createdAt: localInstant(businessDate, 9, 0)
  });
  add('dashboard_shares', {
    id: SAMPLE.share,
    dashboardId: SAMPLE.dashboard,
    dashboardVersionId: 'DASHVER-DEMO-001',
    senderIdentityId: IDENTITY.executive,
    recipientIdentityId: IDENTITY.east,
    channel: 'simulated_email',
    classification: 'internal',
    state: 'active',
    approvedBranchIds: organization.eastBranches,
    tokenHash: null,
    rowVersion: 1,
    expiresAt: localInstant(shiftDate(businessDate, 1), 9, 0),
    provenance: 'synthetic-fixture; no signed URL or share token'
  });
  add('share_scope_branches', ...organization.eastBranches.map((branchId, index) => ({ id: `SHSCOPE-DEMO-${index + 1}`, shareId: SAMPLE.share, branchId })));
  add('simulated_deliveries', { id: 'DELIVERY-DEMO-001', shareId: SAMPLE.share, channel: 'simulated_email', state: 'simulated', recipientIdentityId: IDENTITY.east, createdAt: localInstant(businessDate, 9, 1) });
  add('share_access_events');

  const openIncident = seed.incidents.find(row => row.branchId === 'E01' && row.date === businessDate && row.status === 'open');
  const inventory = seed.inventory_snapshots.find(row => row.branchId === 'E01' && row.productId === 'P001' && row.date === businessDate && row.onHand < row.minimum);
  if (!openIncident || !inventory) throw new Error('Seed did not produce the expected current-date East incident and below-minimum inventory fixture.');
  const sourceIds = [`sales:E01:${businessDate}`, `inventory:E01:${businessDate}`, `incidents:E01:${businessDate}`];
  add('investigation_cases', {
    id: SAMPLE.eastCase,
    branchId: 'E01',
    businessDate,
    status: 'open',
    incidentId: openIncident.id,
    sourceIds,
    ownerIdentityId: IDENTITY.east,
    rowVersion: 1,
    provenance: 'synthetic-fixture'
  });
  add('investigation_tasks', { id: 'INV-TASK-DEMO-001', caseId: SAMPLE.eastCase, branchId: 'E01', state: 'open', ownerIdentityId: IDENTITY.east, rowVersion: 1 });
  add('restock_requests', { id: SAMPLE.restockRequest, branchId: 'E01', productId: 'P002', inventorySnapshotId: `INV-E01-P002-${businessDate}`, quantity: 1, state: 'open', ownerIdentityId: IDENTITY.east, rowVersion: 1, operationKey: 'preview:existing-restock' });
  add('incident_escalation_events');
  add('workflow_teams', { id: 'demo_operations', name: 'Synthetic operations team', active: true, rowVersion: 1 });
  add('branch_review_assignments', { id: SAMPLE.branchAssignment, branchId: 'E02', caseId: 'CASE-E02-DEMO-001', ownerIdentityId: IDENTITY.east, state: 'open', rowVersion: 1, operationKey: 'preview:existing-review' });

  add('crm_customers', { id: 'CRM-CUSTOMER-DEMO-001', displayName: 'Demo customer Cedar Market', classification: 'internal', active: true, rowVersion: 1 });
  add('crm_opportunities', {
    id: SAMPLE.opportunity,
    customerId: 'CRM-CUSTOMER-DEMO-001',
    ownerIdentityId: IDENTITY.executive,
    branchId: 'E01',
    stage: 'qualified',
    baseAmountSatang: 1_250_000,
    lastActivityDate: shiftDate(businessDate, -21),
    state: 'open',
    rowVersion: 1
  });
  add('crm_activities', { id: 'CRM-ACT-DEMO-001', opportunityId: SAMPLE.opportunity, activityDate: shiftDate(businessDate, -21), kind: 'synthetic_note', rowVersion: 1 });
  add('crm_followups');
  add('discount_requests');

  const managerApprovedAt = localInstant(shiftDate(businessDate, -1), 15, 0);
  const directorApprovedAt = localInstant(shiftDate(businessDate, -1), 16, 0);
  const requests = [
    addOnboardingRequest({ id: 'ONB-DEMO-001', employeeId: 'E001', orgUnitId: ORG_EAST_HR, startDate: shiftDate(businessDate, 5), state: 'manager_review_pending', createdAt: localInstant(shiftDate(businessDate, -2), 10, 0), updatedAt: localInstant(businessDate, 8, 0) }),
    addOnboardingRequest({ id: 'ONB-DEMO-002', employeeId: 'E024', orgUnitId: ORG_EAST_HR, startDate: shiftDate(businessDate, 7), state: 'director_approval_pending', managerApprovalEventId: 'ONB-EVT-MGR-002', managerApprovedBy: IDENTITY.east, managerApprovedAt, createdAt: localInstant(shiftDate(businessDate, -3), 10, 0), updatedAt: localInstant(businessDate, 8, 5) }),
    addOnboardingRequest({ id: 'ONB-DEMO-003', employeeId: 'E002', orgUnitId: ORG_EAST_HR, startDate: shiftDate(businessDate, 8), state: 'manager_review_pending', createdAt: localInstant(shiftDate(businessDate, -2), 10, 2), updatedAt: localInstant(businessDate, 8, 2) }),
    addOnboardingRequest({ id: 'ONB-DEMO-004', employeeId: 'E003', orgUnitId: ORG_EAST_HR, startDate: shiftDate(businessDate, 8), state: 'cancelled', createdAt: localInstant(shiftDate(businessDate, -4), 10, 0), updatedAt: localInstant(businessDate, 8, 3) }),
    addOnboardingRequest({ id: 'ONB-DEMO-005', employeeId: 'E010', orgUnitId: ORG_WEST_HR, startDate: shiftDate(businessDate, 9), state: 'director_approval_pending', managerApprovalEventId: 'ONB-EVT-MGR-005', managerApprovedBy: IDENTITY.east, managerApprovedAt, createdAt: localInstant(shiftDate(businessDate, -4), 10, 0), updatedAt: localInstant(businessDate, 8, 4) }),
    addOnboardingRequest({ id: 'ONB-DEMO-006', employeeId: 'E005', orgUnitId: ORG_EAST_HR, startDate: shiftDate(businessDate, 10), state: 'director_approval_pending', managerApprovalEventId: 'ONB-EVT-MGR-006', managerApprovedBy: IDENTITY.east, managerApprovedAt: localInstant(businessDate, 23, 58, 30), createdAt: localInstant(businessDate, 23, 58), updatedAt: localInstant(businessDate, 23, 58, 30) }),
    addOnboardingRequest({ id: 'ONB-DEMO-007', employeeId: 'E006', orgUnitId: ORG_EAST_HR, startDate: shiftDate(businessDate, 1), state: 'director_approved', managerApprovalEventId: 'ONB-EVT-MGR-007', managerApprovedBy: IDENTITY.east, managerApprovedAt, directorApprovalEventId: 'ONB-EVT-DIR-007', directorApprovedBy: IDENTITY.director, directorApprovedAt, createdAt: localInstant(shiftDate(businessDate, -7), 10, 0), updatedAt: directorApprovedAt }),
    addOnboardingRequest({ id: 'ONB-DEMO-008', employeeId: 'E007', orgUnitId: ORG_EAST_HR, startDate: shiftDate(businessDate, -30), state: 'completed', managerApprovalEventId: 'ONB-EVT-MGR-008', managerApprovedBy: IDENTITY.east, managerApprovedAt, directorApprovalEventId: 'ONB-EVT-DIR-008', directorApprovedBy: IDENTITY.director, directorApprovedAt, createdAt: localInstant(shiftDate(businessDate, -40), 10, 0), updatedAt: localInstant(businessDate, 8, 8) }),
    addOnboardingRequest({ id: 'ONB-DEMO-009', employeeId: 'E008', orgUnitId: ORG_EAST_HR, startDate: shiftDate(businessDate, 11), state: 'returned_for_revision', createdAt: localInstant(shiftDate(businessDate, -6), 10, 0), updatedAt: localInstant(businessDate, 8, 9) }),
    addOnboardingRequest({ id: 'ONB-DEMO-010', employeeId: 'E009', orgUnitId: ORG_EAST_HR, startDate: shiftDate(businessDate, 12), state: 'draft', createdAt: localInstant(shiftDate(businessDate, -1), 10, 0), updatedAt: localInstant(businessDate, 8, 10) }),
    addOnboardingRequest({ id: 'ONB-DEMO-011', employeeId: 'E011', orgUnitId: ORG_EAST_HR, startDate: shiftDate(businessDate, -2), state: 'onboarding_in_progress', managerApprovalEventId: 'ONB-EVT-MGR-011', managerApprovedBy: IDENTITY.east, managerApprovedAt, directorApprovalEventId: 'ONB-EVT-DIR-011', directorApprovedBy: IDENTITY.director, directorApprovedAt, createdAt: localInstant(shiftDate(businessDate, -5), 10, 0), updatedAt: localInstant(businessDate, 8, 11) }),
    addOnboardingRequest({ id: 'ONB-DEMO-012', employeeId: 'E012', orgUnitId: ORG_EAST_HR, startDate: shiftDate(businessDate, 10), state: 'manager_review_pending', createdAt: localInstant(businessDate, 23, 58), updatedAt: localInstant(businessDate, 23, 58) })
  ];
  add('onboarding_requests', ...requests as unknown as Record<string, unknown>[]);
  const documents = onboardingDocuments(requests.filter(row => row.id !== 'ONB-DEMO-010').map(row => ({ id: row.id, employeeId: row.employeeId })), 'ONB-DEMO-003', policy.policyAcknowledgementVersion, businessDate);
  add('onboarding_documents', ...documents);
  const approvalEvents = [
    approvalEvent('ONB-EVT-MGR-002', 'ONB-DEMO-002', 'manager', IDENTITY.east, managerApprovedAt),
    approvalEvent('ONB-EVT-MGR-005', 'ONB-DEMO-005', 'manager', IDENTITY.east, managerApprovedAt),
    approvalEvent('ONB-EVT-MGR-006', 'ONB-DEMO-006', 'manager', IDENTITY.east, localInstant(businessDate, 23, 58, 30)),
    approvalEvent('ONB-EVT-MGR-007', 'ONB-DEMO-007', 'manager', IDENTITY.east, managerApprovedAt),
    approvalEvent('ONB-EVT-DIR-007', 'ONB-DEMO-007', 'director', IDENTITY.director, directorApprovedAt),
    approvalEvent('ONB-EVT-MGR-008', 'ONB-DEMO-008', 'manager', IDENTITY.east, managerApprovedAt),
    approvalEvent('ONB-EVT-DIR-008', 'ONB-DEMO-008', 'director', IDENTITY.director, directorApprovedAt),
    approvalEvent('ONB-EVT-MGR-011', 'ONB-DEMO-011', 'manager', IDENTITY.east, managerApprovedAt),
    approvalEvent('ONB-EVT-DIR-011', 'ONB-DEMO-011', 'director', IDENTITY.director, directorApprovedAt)
  ];
  add('onboarding_approval_events', ...approvalEvents);
  add('onboarding_checklists', { id: 'ONB-CHECKLIST-DEMO-011', requestId: 'ONB-DEMO-011', employeeId: 'E011', lifecycleId: 'LIFE-ONB-DEMO-011', state: 'in_progress', startedByIdentityId: IDENTITY.hr, startedAt: localInstant(shiftDate(businessDate, -1), 9, 0), rowVersion: 1 });

  const managerDocs = documents.filter(row => row.requestId === 'ONB-DEMO-001');
  const directorDocs = documents.filter(row => row.requestId === 'ONB-DEMO-002');
  const managerSnapshot = makeQueueSnapshot({
    id: 'SNAP-MANAGER-DEMO-001', actorId: 'east', purpose: 'manager_queue', requestId: 'ONB-DEMO-001', rowVersion: 1, simulatedClock, policyDigest,
    supportingRows: managerDocs.map(row => ({ ref: { table: 'onboarding_documents', id: row.id }, rowVersion: 1, state: 'accepted' }))
  });
  const directorSnapshot = makeQueueSnapshot({
    id: 'SNAP-DIRECTOR-DEMO-001', actorId: 'hr_director', purpose: 'director_queue', requestId: 'ONB-DEMO-002', rowVersion: 1, simulatedClock, policyDigest,
    supportingRows: [
      ...directorDocs.map(row => ({ ref: { table: 'onboarding_documents' as const, id: row.id }, rowVersion: 1, state: 'accepted' })),
      { ref: { table: 'onboarding_approval_events', id: 'ONB-EVT-MGR-002' }, rowVersion: 1, state: 'approved' }
    ]
  });
  add('review_snapshots', managerSnapshot as unknown as Record<string, unknown>, directorSnapshot as unknown as Record<string, unknown>);
  add('review_snapshot_targets',
    { id: 'SNAPTGT-MANAGER-DEMO-001', snapshotId: managerSnapshot.id, targetId: 'ONB-DEMO-001', ref: { table: 'onboarding_requests', id: 'ONB-DEMO-001' }, rowVersion: 1, state: 'manager_review_pending' },
    { id: 'SNAPTGT-DIRECTOR-DEMO-001', snapshotId: directorSnapshot.id, targetId: 'ONB-DEMO-002', ref: { table: 'onboarding_requests', id: 'ONB-DEMO-002' }, rowVersion: 1, state: 'director_approval_pending' }
  );

  add('offboarding_cases',
    { id: SAMPLE.offboardingCase, employeeId: 'E024', state: 'active', effectiveDate: shiftDate(businessDate, 30), reason: 'Synthetic preview case for lifecycle review', rowVersion: 1 },
    { id: 'OFF-DEMO-CLOSED', employeeId: 'E007', state: 'closed', effectiveDate: shiftDate(businessDate, -1), rowVersion: 2 }
  );
  add('offboarding_plans', { id: SAMPLE.offboardingPlan, caseId: SAMPLE.offboardingCase, state: 'prepared', createdByIdentityId: IDENTITY.hr, rowVersion: 1, createdAt: localInstant(businessDate, 9, 30) });
  add('planned_actions',
    { id: 'PLANNED-IT-DEMO-001', planId: SAMPLE.offboardingPlan, caseId: SAMPLE.offboardingCase, kind: 'it_disable_request', state: 'planned', rowVersion: 1 },
    { id: 'PLANNED-ASSET-DEMO-001', planId: SAMPLE.offboardingPlan, caseId: SAMPLE.offboardingCase, kind: 'asset_return', state: 'planned', rowVersion: 1 }
  );
  add('it_disable_requests', { id: 'IT-DISABLE-DEMO-EXISTING', caseId: SAMPLE.offboardingCase, planId: SAMPLE.offboardingPlan, effectiveDate: shiftDate(businessDate, 30), state: 'requested', connectorMode: 'simulated_only', rowVersion: 1 });
  add('assets', { id: 'ASSET-DEMO-LAPTOP-001', assetTag: 'DEMO-LT-001', type: 'laptop', classification: 'internal', state: 'assigned', rowVersion: 1 });
  add('asset_assignments', { id: SAMPLE.assetAssignment, assetId: 'ASSET-DEMO-LAPTOP-001', employeeId: 'E024', state: 'assigned', assignedAt: localInstant(shiftDate(businessDate, -180), 9, 0), rowVersion: 1 });
  add('asset_return_tasks');
  add('employment_contracts',
    { id: SAMPLE.contract, employeeId: 'E024', state: 'active', expiresOn: shiftDate(businessDate, Math.min(defaultDemoWorkflowPolicy.contractReminderDays, 10)), rowVersion: 1 },
    { id: 'CON-DEMO-OUTSIDE-WINDOW', employeeId: 'E001', state: 'active', expiresOn: shiftDate(businessDate, defaultDemoWorkflowPolicy.contractReminderDays + 20), rowVersion: 1 }
  );
  add('contract_reminders');
  add('policy_documents', { id: SAMPLE.policyDocument, title: 'Synthetic HR policy acknowledgement', version: defaultDemoWorkflowPolicy.policyAcknowledgementVersion, text: 'Synthetic preview policy document; not company policy.', updatedAt: localInstant(businessDate, 8, 0), classification: 'internal', state: 'active', rowVersion: 1 });
  add('policy_acknowledgement_tasks');
  add('badge_effect_events');

  return { entities, organization, profiles, managerSnapshot, directorSnapshot, openIncident, inventory, policyDigest, simulatedClock };
}

function approvalEvent(id: string, requestId: string, stage: 'manager' | 'director', actorIdentityId: string, createdAt: string) {
  return { id, requestId, lifecycleId: `LIFE-${requestId}`, stage, decision: 'approved', actorIdentityId, createdAt, executionId: `SYNTHETIC-${id}`, rowVersion: 1, provenance: 'synthetic-fixture; not backend execution proof' };
}

function makeActionInput(kind: WorkflowActionKind, date: string, data: ReturnType<typeof buildWorkflowEntities>): ExampleInput {
  const dueDate = shiftDate(date, defaultDemoWorkflowPolicy.tasks.normalDueDays);
  const taskFields = { ownerIdentityId: IDENTITY.east, reason: `Synthetic preview example for ${kind}.`, dueDate, priority: defaultDemoWorkflowPolicy.tasks.defaultPriority };
  const firstSourceIds = [`sales:E01:${date}`, `inventory:E01:${date}`];
  const quantity = defaultDemoWorkflowPolicy.restock.targetMinimumMultiplier * data.inventory.minimum - data.inventory.onHand;
  const payloads: Record<WorkflowActionKind, ExampleInput> = {
    dashboard_create: { kind, spec: { title: 'Synthetic East metric view', description: 'Preview-only dashboard spec from synthetic evidence.', scope: { region: 'east', date }, widgets: [{ type: 'metric', metric: 'net_sales', title: 'net_sales' }] } },
    dashboard_share: { kind, dashboardId: SAMPLE.dashboard, recipientIdentityId: IDENTITY.east, channel: 'simulated_email', subject: 'Synthetic preview share', body: 'Synthetic preview message; no external delivery is sent.' },
    dashboard_share_revoke: { kind, shareId: SAMPLE.share },
    investigation_create: { kind, businessDate: date, targets: [{ ...taskFields, branchId: 'E01', caseId: SAMPLE.eastCase, sourceIds: firstSourceIds, unansweredQuestion: 'Which additional synthetic evidence should be reviewed?' }] },
    restock_create: { kind, targets: [{ ...taskFields, inventorySnapshotId: data.inventory.id, branchId: 'E01', productId: data.inventory.productId, quantity }] },
    crm_followup_create: { kind, targets: [{ ...taskFields, ownerIdentityId: IDENTITY.executive, opportunityId: SAMPLE.opportunity }] },
    incident_escalate: { kind, targets: [{ incidentId: data.openIncident.id, targetTeamId: 'demo_operations', evidenceIds: [`incidents:E01:${date}`, `sales:E01:${date}`], reason: 'Synthetic preview escalation request.' }] },
    discount_request_create: { kind, opportunityId: SAMPLE.opportunity, requestedBasisPoints: 750, baseAmountSatang: 1_250_000, reason: 'Synthetic preview discount request for review.', ownerIdentityId: IDENTITY.executive },
    branch_review_assign: { kind, businessDate: date, targets: [{ ...taskFields, branchId: 'E01', caseId: SAMPLE.eastCase }] },
    onboarding_manager_approve: { kind, snapshotId: data.managerSnapshot.id, requestIds: ['ONB-DEMO-001'] },
    onboarding_director_approve: { kind, snapshotId: data.directorSnapshot.id, requestIds: ['ONB-DEMO-002'] },
    onboarding_return: { kind, snapshotId: data.directorSnapshot.id, requestIds: ['ONB-DEMO-002'], reason: 'Synthetic preview request for missing onboarding clarification.' },
    onboarding_start: { kind, requestId: 'ONB-DEMO-007' },
    onboarding_tasks_create: { kind, requestId: 'ONB-DEMO-011', targets: defaultDemoWorkflowPolicy.onboardingTaskTemplates.map(templateId => ({ ...taskFields, ownerIdentityId: IDENTITY.hr, templateId })) },
    offboarding_plan_create: { kind, caseId: SAMPLE.offboardingCase },
    it_disable_request: { kind, caseId: SAMPLE.offboardingCase, planId: SAMPLE.offboardingPlan, effectiveDate: shiftDate(date, 30), reason: 'Synthetic preview request; no IT account is disabled.' },
    asset_return_create: { kind, caseId: SAMPLE.offboardingCase, planId: SAMPLE.offboardingPlan, targets: [{ ...taskFields, ownerIdentityId: IDENTITY.hr, assetAssignmentId: SAMPLE.assetAssignment }] },
    badge_revoke: { kind, badgeId: 'C102', employeeId: 'E024', reason: 'Synthetic preview badge change example.' },
    contract_reminder_create: { kind, targets: [{ ...taskFields, ownerIdentityId: IDENTITY.hr, contractId: SAMPLE.contract }] },
    policy_acknowledgement_assign: { kind, policyDocumentId: SAMPLE.policyDocument, policyVersion: defaultDemoWorkflowPolicy.policyAcknowledgementVersion, targets: [{ ...taskFields, ownerIdentityId: IDENTITY.hr, employeeId: 'E024' }] }
  };
  return workflowActionPayloadSchema.parse(payloads[kind]) as ExampleInput;
}

function actionRef(kind: WorkflowActionKind, data: ReturnType<typeof buildWorkflowEntities>): ExampleRef {
  return kind === 'incident_escalate' ? { table: 'incidents', id: data.openIncident.id } : ACTION_REFS[kind];
}

function findEntity(data: ReturnType<typeof buildWorkflowEntities>, table: WorkflowEntityTable, id: string): Record<string, unknown> {
  const row = data.entities[table].find(candidate => candidate.id === id);
  if (!row) throw new Error(`Missing synthetic ${table}:${id}.`);
  return row;
}

function buildAlreadyCompletedScenario(kind: WorkflowActionKind, input: ExampleInput, date: string, data: ReturnType<typeof buildWorkflowEntities>): CompletedScenario | null {
  if (!['onboarding_manager_approve', 'onboarding_director_approve', 'onboarding_return', 'onboarding_start', 'onboarding_tasks_create'].includes(kind)) return null;
  const requestId = kind === 'onboarding_manager_approve'
    ? 'ONB-DEMO-002'
    : kind === 'onboarding_tasks_create'
      ? 'ONB-DEMO-011'
      : kind === 'onboarding_start'
        ? 'ONB-DEMO-007'
        : 'ONB-DEMO-002';
  const actorProfileId: ProfileId = kind === 'onboarding_manager_approve' ? 'east' : kind === 'onboarding_start' || kind === 'onboarding_tasks_create' ? 'hr' : 'hr_director';
  const existingExecutionId = `PREVIEW-EXEC-${kind.toUpperCase().replaceAll('_', '-')}-001`;
  const actionId = `PREVIEW-ACTION-${kind.toUpperCase().replaceAll('_', '-')}-001`;
  const actionTime = localInstant(date, 23, 56);
  const baseRequest = findEntity(data, 'onboarding_requests', requestId);
  const request = { ...baseRequest, rowVersion: 2, updatedAt: actionTime };
  const overlay: ScenarioStateOverrides['workflowEntities'] = {};
  let snapshot: ReturnType<typeof makeQueueSnapshot> | null = null;
  const approvalEvents: Record<string, unknown>[] = [];
  const checklists: Record<string, unknown>[] = [];
  const tasks: Record<string, unknown>[] = [];
  let inputForCase = input;
  let state = EXPECTED_STATE[kind];

  if (kind === 'onboarding_manager_approve') {
    const managerEventId = 'ONB-EVT-MGR-ALREADY-002';
    Object.assign(request, {
      state: 'director_approval_pending',
      managerApprovalEventId: managerEventId,
      managerApprovedBy: IDENTITY.east,
      managerApprovedAt: actionTime
    });
    approvalEvents.push({ ...approvalEvent(managerEventId, requestId, 'manager', IDENTITY.east, actionTime), executionId: existingExecutionId, provenance: 'synthetic-preview-only; not backend proof' });
    const documents = data.entities.onboarding_documents.filter(row => row.requestId === requestId);
    snapshot = makeQueueSnapshot({
      id: 'SNAP-MANAGER-ALREADY-002', actorId: 'east', purpose: 'manager_queue', requestId, rowVersion: 1, simulatedClock: data.simulatedClock, policyDigest: data.policyDigest,
      supportingRows: documents.map(row => ({ ref: { table: 'onboarding_documents', id: String(row.id) }, rowVersion: Number(row.rowVersion ?? 1), state: 'accepted' }))
    });
    inputForCase = workflowActionPayloadSchema.parse({ ...input, snapshotId: snapshot.id, requestIds: [requestId] }) as ExampleInput;
    state = 'director_approval_pending';
  } else if (kind === 'onboarding_director_approve') {
    const managerEventId = 'ONB-EVT-MGR-002';
    const directorEventId = 'ONB-EVT-DIR-ALREADY-002';
    Object.assign(request, {
      state: 'director_approved',
      managerApprovalEventId: managerEventId,
      managerApprovedBy: IDENTITY.east,
      managerApprovedAt: String(baseRequest.managerApprovedAt),
      directorApprovalEventId: directorEventId,
      directorApprovedBy: IDENTITY.director,
      directorApprovedAt: actionTime
    });
    approvalEvents.push(findEntity(data, 'onboarding_approval_events', managerEventId), { ...approvalEvent(directorEventId, requestId, 'director', IDENTITY.director, actionTime), executionId: existingExecutionId, provenance: 'synthetic-preview-only; not backend proof' });
    snapshot = data.directorSnapshot;
    inputForCase = workflowActionPayloadSchema.parse({ ...input, snapshotId: snapshot.id, requestIds: [requestId] }) as ExampleInput;
    state = 'director_approved';
  } else if (kind === 'onboarding_return') {
    Object.assign(request, {
      state: 'returned_for_revision',
      managerApprovalEventId: null,
      managerApprovedBy: null,
      managerApprovedAt: null,
      directorApprovalEventId: null,
      directorApprovedBy: null,
      directorApprovedAt: null
    });
    approvalEvents.push(
      findEntity(data, 'onboarding_approval_events', 'ONB-EVT-MGR-002'),
      { id: 'ONB-EVT-DIR-RETURN-ALREADY-002', requestId, lifecycleId: 'LIFE-ONB-DEMO-002', stage: 'director', decision: 'returned_for_revision', actorIdentityId: IDENTITY.director, createdAt: actionTime, executionId: existingExecutionId, rowVersion: 1, provenance: 'synthetic-preview-only; not backend proof' }
    );
    snapshot = data.directorSnapshot;
    inputForCase = workflowActionPayloadSchema.parse({ ...input, snapshotId: snapshot.id, requestIds: [requestId] }) as ExampleInput;
    state = 'returned_for_revision';
  } else if (kind === 'onboarding_start') {
    Object.assign(request, {
      state: 'onboarding_in_progress',
      directorApprovalEventId: 'ONB-EVT-DIR-007',
      directorApprovedBy: IDENTITY.director
    });
    approvalEvents.push(
      findEntity(data, 'onboarding_approval_events', 'ONB-EVT-MGR-007'),
      findEntity(data, 'onboarding_approval_events', 'ONB-EVT-DIR-007')
    );
    checklists.push({ id: 'ONB-CHECKLIST-PREVIEW-START-007', requestId, employeeId: 'E006', lifecycleId: 'LIFE-ONB-DEMO-007', state: 'in_progress', startedByIdentityId: IDENTITY.hr, startedAt: actionTime, rowVersion: 1, provenance: 'synthetic-preview-only' });
    inputForCase = workflowActionPayloadSchema.parse({ ...input, requestId }) as ExampleInput;
    state = 'onboarding_in_progress';
  } else {
    Object.assign(request, { state: 'onboarding_in_progress' });
    approvalEvents.push(
      findEntity(data, 'onboarding_approval_events', 'ONB-EVT-MGR-011'),
      findEntity(data, 'onboarding_approval_events', 'ONB-EVT-DIR-011')
    );
    checklists.push(findEntity(data, 'onboarding_checklists', 'ONB-CHECKLIST-DEMO-011'));
    tasks.push(...defaultDemoWorkflowPolicy.onboardingTaskTemplates.map((templateId, index) => ({ id: `ONB-TASK-PREVIEW-ALREADY-${index + 1}`, requestId, templateId, state: 'open', ownerIdentityId: IDENTITY.hr, dueDate: shiftDate(date, defaultDemoWorkflowPolicy.tasks.normalDueDays), rowVersion: 1, provenance: 'synthetic-preview-only' })));
    inputForCase = workflowActionPayloadSchema.parse({ ...input, requestId }) as ExampleInput;
    state = 'onboarding_in_progress';
  }

  const ref: ExampleRef = { table: 'onboarding_requests', id: requestId };
  const currentState = entityStateSchema.parse({
    ref,
    state,
    rowVersion: 2,
    allowedNextActions: [],
    completedActions: [{ kind, executionId: existingExecutionId, completedAt: actionTime }]
  });
  const targetIds = kind === 'onboarding_tasks_create' ? tasks.map(row => String(row.id)) : [requestId];
  const targetRefs = kind === 'onboarding_tasks_create'
    ? targetIds.map(id => ({ table: 'onboarding_tasks' as const, id }))
    : [ref];
  const execution = {
    id: existingExecutionId,
    actionId,
    contractVersion: 2,
    kind,
    actorId: actorProfileId,
    outcome: 'verified_success',
    targetCount: targetIds.length,
    createdAt: actionTime,
    verifiedAt: actionTime,
    provenance: 'synthetic-preview-only; not backend execution or proof'
  };
  const actionTargets = targetIds.map((targetId, index) => ({
    id: `PREVIEW-TARGET-${kind.toUpperCase().replaceAll('_', '-')}-${index + 1}`,
    executionId: existingExecutionId,
    targetId,
    ref: targetRefs[index],
    outcome: 'verified_success',
    observedRowVersion: kind === 'onboarding_tasks_create' ? 1 : 2,
    checkedAt: actionTime,
    mismatchCodes: [],
    provenance: 'synthetic-preview-only; not backend proof'
  }));
  overlay.onboarding_requests = [request];
  if (approvalEvents.length) overlay.onboarding_approval_events = deduplicateById(approvalEvents);
  if (snapshot) {
    overlay.review_snapshots = [snapshot as unknown as Record<string, unknown>];
    const priorMembership = data.entities.review_snapshot_targets.find(row => row.snapshotId === snapshot.id && row.targetId === requestId);
    overlay.review_snapshot_targets = [{
      ...(priorMembership ?? {}),
      id: priorMembership?.id ?? `SNAPTGT-${snapshot.id}`,
      snapshotId: snapshot.id,
      targetId: requestId,
      ref,
      rowVersion: 1,
      state: kind === 'onboarding_manager_approve' ? 'manager_review_pending' : 'director_approval_pending'
    }];
  }
  if (checklists.length) overlay.onboarding_checklists = deduplicateById(checklists);
  if (tasks.length) overlay.onboarding_tasks = tasks;
  overlay.action_executions = [execution];
  overlay.action_targets = actionTargets;

  const overrides: ScenarioStateOverrides = { previewOnly: true, existingExecutionId, workflowEntities: overlay };
  return { actorProfileId, actionId, input: inputForCase, ref, currentState, queueSnapshot: snapshot, stateOverrides: overrides };
}

function deduplicateById(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return [...new Map(rows.map(row => [String(row.id), row])).values()];
}

function previewCurrentState(kind: WorkflowActionKind, caseType: ExampleCaseType, ref = ACTION_REFS[kind]) {
  const state = caseType === 'already_completed' ? EXPECTED_STATE[kind] : INITIAL_STATE[kind];
  const completedActions: [] = [];
  return entityStateSchema.parse({
    ref,
    state,
    rowVersion: caseType === 'stale' ? 2 : 1,
    allowedNextActions: caseType === 'eligible' ? [kind] : [],
    completedActions
  });
}

function queueSnapshotForKind(kind: WorkflowActionKind, data: ReturnType<typeof buildWorkflowEntities>) {
  if (kind === 'onboarding_manager_approve') return data.managerSnapshot;
  if (kind === 'onboarding_director_approve' || kind === 'onboarding_return') return data.directorSnapshot;
  return null;
}

function isApprovalQueueAction(kind: WorkflowActionKind): boolean {
  return kind === 'onboarding_manager_approve' || kind === 'onboarding_director_approve' || kind === 'onboarding_return';
}

function makeDeniedActionInput(kind: WorkflowActionKind, input: ExampleInput): ExampleInput {
  if (!isApprovalQueueAction(kind)) return input;
  return workflowActionPayloadSchema.parse({
    ...input,
    snapshotId: 'SNAP-UNRESOLVED-DENIED',
    requestIds: ['ONB-UNRESOLVED-DENIED']
  }) as ExampleInput;
}

function expectedReceipt(
  kind: WorkflowActionKind,
  caseType: ExampleCaseType,
  actorProfileId: ProfileId,
  ref: ExampleRef | null,
  readbackState: ReturnType<typeof entityStateSchema.parse> | null,
  date: string,
  completed: CompletedScenario | null
) {
  const outcome = caseType === 'eligible' ? 'verified_success' : caseType === 'already_completed' ? 'already_completed' : caseType;
  const executionId = completed?.stateOverrides.existingExecutionId ?? `PREVIEW-EXPECTED-${kind.toUpperCase().replaceAll('_', '-')}`;
  const proof = outcome === 'verified_success' && ref && readbackState
    ? [{
        targetId: `PREVIEW-TARGET-${kind.toUpperCase().replaceAll('_', '-')}`,
        ref,
        outcome: 'verified_success' as const,
        executionId,
        observedRowVersion: readbackState.rowVersion,
        checkedAt: localInstant(date, 23, 59, 59),
        mismatchCodes: []
      }]
    : [];
  return workflowReceiptV2Schema.parse({
    id: `PREVIEW-RECEIPT-${kind.toUpperCase().replaceAll('_', '-')}-${caseType}`,
    actionId: completed?.actionId ?? `PREVIEW-ACTION-${kind.toUpperCase().replaceAll('_', '-')}-${caseType}`,
    contractVersion: 2,
    actorId: actorProfileId,
    kind,
    outcome,
    proofs: proof,
    createdAt: localInstant(date, 23, 58, 50),
    verifiedAt: outcome === 'verified_success' ? localInstant(date, 23, 59, 59) : null,
    currentStates: readbackState ? [readbackState] : []
  });
}

function makeActionExamples(date: string, data: ReturnType<typeof buildWorkflowEntities>) {
  const caseTypes: ExampleCaseType[] = ['eligible', 'denied', 'already_completed', 'stale'];
  const examples = workflowActionKinds.flatMap(kind => {
    const action = kind as WorkflowActionKind;
    const baseInput = makeActionInput(action, date, data);
    const eligibleProfiles = data.profiles.filter(profile => profile.permissions.includes(ACTION_PERMISSION[action]) && profileScopeAllows(profile, action));
    return caseTypes.map(caseType => {
      const protectedDenial = caseType === 'denied' && isApprovalQueueAction(action);
      const completed = caseType === 'already_completed' ? buildAlreadyCompletedScenario(action, baseInput, date, data) : null;
      const input = protectedDenial ? makeDeniedActionInput(action, baseInput) : completed?.input ?? baseInput;
      const ref = protectedDenial ? null : completed?.ref ?? actionRef(action, data);
      const actorProfileId: ProfileId = protectedDenial
        ? 'executive'
        : completed?.actorProfileId ?? (caseType === 'denied'
            ? data.profiles.find(profile => !profile.permissions.includes(ACTION_PERMISSION[action]) || !profileScopeAllows(profile, action))?.id ?? 'hr'
            : eligibleProfiles[0]?.id ?? 'executive');
      const currentState = completed?.currentState ?? (protectedDenial ? null : previewCurrentState(action, caseType, ref ?? undefined));
      const preparation = preparationResultSchema.parse({
        outcome: caseType === 'eligible' ? 'pending' : caseType === 'already_completed' ? 'already_completed' : caseType,
        pendingAction: null,
        existingExecutionId: completed?.stateOverrides.existingExecutionId ?? null,
        currentStates: currentState ? [currentState] : [],
        reasons: caseType === 'denied'
          ? [{ code: 'synthetic_actor_or_scope_denial', targetId: protectedDenial ? null : `TARGET-${action}`, message: 'The selected synthetic profile or responsibility does not permit this example.' }]
          : caseType === 'stale'
            ? [{ code: 'synthetic_review_stale', targetId: `TARGET-${action}`, message: 'The example row version changed after the synthetic review snapshot.' }]
            : []
      });
      const expectedState = caseType === 'eligible'
        ? entityStateSchema.parse({ ref: ref!, state: EXPECTED_STATE[action], rowVersion: 2, allowedNextActions: downstreamActions(action), completedActions: [] })
        : currentState;
      const receipt = expectedReceipt(action, caseType, actorProfileId, ref, expectedState, date, completed);
      return {
        id: `${action}:${caseType}`,
        kind: action,
        caseType,
        actorProfileId,
        eligibleProfileIds: caseType === 'denied' ? [] : eligibleProfiles.map(profile => profile.id),
        input,
        review: { preparation, queueSnapshot: protectedDenial ? null : completed?.queueSnapshot ?? queueSnapshotForKind(action, data) },
        expectedResult: { previewOnly: true, outcome: receipt.outcome, caseType, receipt, readbackState: expectedState },
        stateOverrides: completed?.stateOverrides ?? null,
        guardVariants: protectedDenial ? [{ variant: 'unauthorized_profile', outcome: 'denied', effects: 0 }] : guardVariants(action, date, data)
      };
    });
  });
  return examples;
}

function assertActionExampleReferences(
  examples: ReturnType<typeof makeActionExamples>,
  data: ReturnType<typeof buildWorkflowEntities>,
  views: Record<'all' | 'east', { scope: Scope; evidence: Awaited<ReturnType<typeof readEvidence>>; analysis: ReturnType<typeof deterministicAnalysis> }>
): void {
  const profileIds = new Set(data.profiles.map(profile => profile.id));
  const eastSourceIds = new Set(views.east.evidence.sources.map(source => source.id));
  for (const kind of workflowActionKinds) {
    const examplesForKind = examples.filter(example => example.kind === kind);
    if (examplesForKind.length !== 4 || examplesForKind.some(example => example.input.kind !== kind)) {
      throw new Error(`Expected four schema-validated preview cases for ${kind}.`);
    }
    const ref = actionRef(kind as WorkflowActionKind, data);
    if (!data.entities[ref.table].some(row => row.id === ref.id)) {
      throw new Error(`Preview example ${kind} refers to missing ${ref.table}:${ref.id}.`);
    }
    for (const example of examplesForKind) assertExampleGraph(example, profileIds, eastSourceIds, data);
  }
}

function assertExampleGraph(
  example: ReturnType<typeof makeActionExamples>[number],
  profileIds: Set<string>,
  eastSourceIds: Set<string>,
  data: ReturnType<typeof buildWorkflowEntities>
): void {
  const expectedReviewOutcome = { eligible: 'pending', denied: 'denied', already_completed: 'already_completed', stale: 'stale' }[example.caseType];
  const expectedReceiptOutcome = { eligible: 'verified_success', denied: 'denied', already_completed: 'already_completed', stale: 'stale' }[example.caseType];
  if (example.input.kind !== example.kind || !profileIds.has(example.actorProfileId)) throw new Error(`Invalid actor or payload kind in ${example.id}.`);
  if (example.review.preparation.outcome !== expectedReviewOutcome || example.expectedResult.receipt.kind !== example.kind || example.expectedResult.receipt.outcome !== expectedReceiptOutcome) {
    throw new Error(`Review and expected receipt outcomes disagree in ${example.id}.`);
  }
  const permittedProfiles = data.profiles.filter(profile => profile.permissions.includes(ACTION_PERMISSION[example.kind]) && profileScopeAllows(profile, example.kind)).map(profile => profile.id);
  if (example.eligibleProfileIds.some(id => !profileIds.has(id)) || JSON.stringify(example.eligibleProfileIds) !== JSON.stringify(example.caseType === 'denied' ? [] : permittedProfiles)) throw new Error(`Eligible profile hints disagree with the synthetic actor policy in ${example.id}.`);
  const protectedDenial = example.caseType === 'denied' && isApprovalQueueAction(example.kind);
  const override = example.stateOverrides?.workflowEntities;
  const currentStates = example.review.preparation.currentStates;
  if (protectedDenial) {
    const input = example.input as Record<string, unknown>;
    const reasons = example.review.preparation.reasons;
    if (example.actorProfileId !== 'executive' || example.review.queueSnapshot !== null || currentStates.length !== 0 || reasons.some(reason => reason.targetId !== null) || input.snapshotId !== 'SNAP-UNRESOLVED-DENIED' || JSON.stringify(input.requestIds) !== '["ONB-UNRESOLVED-DENIED"]') {
      throw new Error(`Denied approval case exposes foreign queue data: ${example.id}.`);
    }
    if (example.guardVariants.some(variant => JSON.stringify(variant).includes('ONB-DEMO'))) throw new Error(`Denied approval guards expose a queue target: ${example.id}.`);
  } else if (currentStates.length !== 1) {
    throw new Error(`Expected one reviewed state in ${example.id}.`);
  }

  const currentState = currentStates[0];
  const readbackState = example.expectedResult.readbackState;
  if (example.caseType !== 'eligible' && !protectedDenial && (!currentState || !readbackState || currentState.ref.table !== readbackState.ref.table || currentState.ref.id !== readbackState.ref.id || currentState.state !== readbackState.state || currentState.rowVersion !== readbackState.rowVersion)) {
    throw new Error(`Non-success readback does not match its reviewed state in ${example.id}.`);
  }
  if (currentState) {
    const expectedRef = override?.onboarding_requests?.[0]
      ? { table: 'onboarding_requests', id: String(override.onboarding_requests[0].id) }
      : actionRef(example.kind, data);
    if (currentState.ref.table !== expectedRef.table || currentState.ref.id !== expectedRef.id) throw new Error(`Reviewed state is detached from its case target in ${example.id}.`);
  }
  if (readbackState && (example.expectedResult.receipt.currentStates.length !== 1 || example.expectedResult.receipt.currentStates[0].ref.table !== readbackState.ref.table || example.expectedResult.receipt.currentStates[0].ref.id !== readbackState.ref.id || example.expectedResult.receipt.currentStates[0].rowVersion !== readbackState.rowVersion)) {
    throw new Error(`Receipt readback does not match the expected state in ${example.id}.`);
  }
  if (example.caseType === 'eligible') {
    const proof = example.expectedResult.receipt.proofs[0];
    const expectedExecutionId = `PREVIEW-EXPECTED-${example.kind.toUpperCase().replaceAll('_', '-')}`;
    if (!readbackState || example.expectedResult.receipt.proofs.length !== 1 || example.expectedResult.receipt.actionId !== `PREVIEW-ACTION-${example.kind.toUpperCase().replaceAll('_', '-')}-eligible` || proof.ref.table !== readbackState.ref.table || proof.ref.id !== readbackState.ref.id || proof.observedRowVersion !== readbackState.rowVersion || proof.executionId !== expectedExecutionId || proof.outcome !== 'verified_success') {
      throw new Error(`Expected-success receipt proof is detached from readback in ${example.id}.`);
    }
  } else if (example.expectedResult.receipt.proofs.length !== 0) {
    throw new Error(`Non-success example unexpectedly contains a success proof: ${example.id}.`);
  }

  assertExampleInputReferences(example, data, eastSourceIds);
  assertExampleSnapshot(example, data, currentState, override);
  if (override) assertOnboardingStateOverride(example, data, currentState, override);
  else if (example.caseType === 'already_completed' && example.kind.startsWith('onboarding_')) throw new Error(`Completed onboarding example lacks an overlay: ${example.id}.`);
}

function rowById(data: ReturnType<typeof buildWorkflowEntities>, table: WorkflowEntityTable, id: string, overlay?: ScenarioStateOverrides['workflowEntities']): Record<string, unknown> | undefined {
  return overlay?.[table]?.find(row => row.id === id) ?? data.entities[table].find(row => row.id === id);
}

function requireRow(data: ReturnType<typeof buildWorkflowEntities>, table: WorkflowEntityTable, id: string, overlay?: ScenarioStateOverrides['workflowEntities']): Record<string, unknown> {
  const row = rowById(data, table, id, overlay);
  if (!row) throw new Error(`Missing ${table}:${id} in a preview example graph.`);
  return row;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`Invalid ${label} in a preview example graph.`);
  return value as Record<string, unknown>;
}

function targetRecords(input: Record<string, unknown>, label: string): Record<string, unknown>[] {
  if (!Array.isArray(input.targets)) throw new Error(`Missing ${label} targets.`);
  return input.targets.map(target => asRecord(target, label));
}

function assertExampleInputReferences(
  example: ReturnType<typeof makeActionExamples>[number],
  data: ReturnType<typeof buildWorkflowEntities>,
  eastSourceIds: Set<string>
): void {
  const input = example.input as Record<string, unknown>;
  const overlay = example.stateOverrides?.workflowEntities;
  const has = (table: WorkflowEntityTable, id: unknown) => typeof id === 'string' && rowById(data, table, id, overlay) !== undefined;
  const requireRefs = (values: unknown[], table: WorkflowEntityTable, label: string) => {
    for (const id of values) if (!has(table, id)) throw new Error(`Missing ${label} reference in ${example.id}: ${String(id)}.`);
  };
  const requireTaskOwner = (target: Record<string, unknown>) => requireRefs([target.ownerIdentityId], 'directory_identities', 'task owner');
  switch (example.kind) {
    case 'dashboard_create': {
      const spec = asRecord(input.spec, 'dashboard spec');
      if (!data.organization.eastBranches.length || asRecord(spec.scope, 'dashboard scope').region !== 'east') throw new Error(`Dashboard scope mismatch in ${example.id}.`);
      break;
    }
    case 'dashboard_share':
      requireRefs([input.dashboardId], 'dashboards', 'dashboard');
      requireRefs([input.recipientIdentityId], 'directory_identities', 'recipient');
      break;
    case 'dashboard_share_revoke':
      requireRefs([input.shareId], 'dashboard_shares', 'share');
      break;
    case 'investigation_create':
      for (const target of targetRecords(input, example.id)) {
        requireRefs([target.caseId], 'investigation_cases', 'investigation case');
        requireRefs([target.branchId], 'branches', 'branch');
        requireTaskOwner(target);
        if (!Array.isArray(target.sourceIds) || target.sourceIds.some(id => typeof id !== 'string' || !eastSourceIds.has(id))) throw new Error(`Investigation evidence is not in the East evidence view: ${example.id}.`);
      }
      break;
    case 'restock_create':
      for (const target of targetRecords(input, example.id)) {
        requireRefs([target.inventorySnapshotId], 'inventory_snapshots', 'inventory snapshot');
        requireRefs([target.productId], 'products', 'product');
        requireRefs([target.branchId], 'branches', 'branch');
        requireTaskOwner(target);
        const inventory = requireRow(data, 'inventory_snapshots', String(target.inventorySnapshotId), overlay);
        const expectedQuantity = defaultDemoWorkflowPolicy.restock.targetMinimumMultiplier * Number(inventory.minimum) - Number(inventory.onHand);
        if (Number(inventory.onHand) >= Number(inventory.minimum) || target.quantity !== expectedQuantity || expectedQuantity <= 0 || expectedQuantity > defaultDemoWorkflowPolicy.restock.maxQuantity) {
          throw new Error(`Restock quantity does not match current below-minimum evidence in ${example.id}.`);
        }
      }
      break;
    case 'crm_followup_create':
      for (const target of targetRecords(input, example.id)) {
        requireRefs([target.opportunityId], 'crm_opportunities', 'opportunity');
        requireTaskOwner(target);
      }
      break;
    case 'incident_escalate':
      for (const target of targetRecords(input, example.id)) {
        requireRefs([target.incidentId], 'incidents', 'incident');
        requireRefs([target.targetTeamId], 'workflow_teams', 'team');
        if (!Array.isArray(target.evidenceIds) || target.evidenceIds.some(id => typeof id !== 'string' || !eastSourceIds.has(id))) throw new Error(`Incident evidence is not in the East evidence view: ${example.id}.`);
      }
      break;
    case 'discount_request_create':
      requireRefs([input.opportunityId], 'crm_opportunities', 'opportunity');
      requireRefs([input.ownerIdentityId], 'directory_identities', 'request owner');
      break;
    case 'branch_review_assign':
      for (const target of targetRecords(input, example.id)) {
        requireRefs([target.caseId], 'investigation_cases', 'branch review case');
        requireRefs([target.branchId], 'branches', 'branch');
        requireTaskOwner(target);
      }
      break;
    case 'onboarding_manager_approve':
    case 'onboarding_director_approve':
    case 'onboarding_return':
      if (example.caseType === 'denied' && example.actorProfileId === 'executive') break;
      requireRefs(Array.isArray(input.requestIds) ? input.requestIds : [], 'onboarding_requests', 'onboarding request');
      break;
    case 'onboarding_start':
      requireRefs([input.requestId], 'onboarding_requests', 'onboarding request');
      break;
    case 'onboarding_tasks_create':
      requireRefs([input.requestId], 'onboarding_requests', 'onboarding request');
      for (const target of targetRecords(input, example.id)) requireTaskOwner(target);
      break;
    case 'offboarding_plan_create':
      requireRefs([input.caseId], 'offboarding_cases', 'offboarding case');
      break;
    case 'it_disable_request':
      requireRefs([input.caseId], 'offboarding_cases', 'offboarding case');
      requireRefs([input.planId], 'offboarding_plans', 'offboarding plan');
      break;
    case 'asset_return_create':
      requireRefs([input.caseId], 'offboarding_cases', 'offboarding case');
      requireRefs([input.planId], 'offboarding_plans', 'offboarding plan');
      for (const target of targetRecords(input, example.id)) {
        requireRefs([target.assetAssignmentId], 'asset_assignments', 'asset assignment');
        requireTaskOwner(target);
      }
      break;
    case 'badge_revoke':
      requireRefs([input.badgeId], 'mock_badges', 'badge');
      requireRefs([input.employeeId], 'employees', 'employee');
      break;
    case 'contract_reminder_create':
      for (const target of targetRecords(input, example.id)) {
        requireRefs([target.contractId], 'employment_contracts', 'employment contract');
        requireTaskOwner(target);
      }
      break;
    case 'policy_acknowledgement_assign':
      requireRefs([input.policyDocumentId], 'policy_documents', 'policy document');
      for (const target of targetRecords(input, example.id)) {
        requireRefs([target.employeeId], 'employees', 'employee');
        requireTaskOwner(target);
      }
      break;
  }
}

function assertExampleSnapshot(
  example: ReturnType<typeof makeActionExamples>[number],
  data: ReturnType<typeof buildWorkflowEntities>,
  currentState: ReturnType<typeof entityStateSchema.parse> | undefined,
  overlay?: ScenarioStateOverrides['workflowEntities']
): void {
  const snapshot = example.review.queueSnapshot;
  if (!snapshot) return;
  if (!isApprovalQueueAction(example.kind) || example.caseType === 'denied') throw new Error(`Unexpected reviewed queue on ${example.id}.`);
  const input = example.input as Record<string, unknown>;
  const requestId = Array.isArray(input.requestIds) ? input.requestIds[0] : undefined;
  const expectedState = example.kind === 'onboarding_manager_approve' ? 'manager_review_pending' : 'director_approval_pending';
  if (typeof requestId !== 'string' || snapshot.id !== input.snapshotId || snapshot.actorId !== example.actorProfileId || snapshot.actorSessionId !== `SESSION-${example.actorProfileId}` || snapshot.count !== 1 || snapshot.displayedIds.length !== 1 || snapshot.displayedIds[0] !== requestId) {
    throw new Error(`Snapshot actor/target binding mismatch in ${example.id}.`);
  }
  const expectedRequest = snapshot.expectedRows.find(row => row.ref.table === 'onboarding_requests' && row.ref.id === requestId);
  const membership = [...(overlay?.review_snapshot_targets ?? []), ...data.entities.review_snapshot_targets].find(row => row.snapshotId === snapshot.id && row.targetId === requestId);
  if (!expectedRequest || expectedRequest.rowVersion !== membership?.rowVersion || expectedRequest.state !== expectedState || membership?.state !== expectedState || currentState?.ref.id !== requestId) {
    throw new Error(`Snapshot membership/version/state mismatch in ${example.id}.`);
  }
  if (example.caseType === 'eligible' && (currentState?.rowVersion !== expectedRequest.rowVersion || currentState.state !== expectedRequest.state)) throw new Error(`Eligible review is not fresh in ${example.id}.`);
  if ((example.caseType === 'stale' || example.caseType === 'already_completed') && currentState && currentState.rowVersion <= expectedRequest.rowVersion) throw new Error(`Stale/completed case did not advance beyond its snapshot in ${example.id}.`);
  for (const expected of snapshot.expectedRows) {
    if (expected.ref.table === 'onboarding_approval_events') {
      const event = rowById(data, 'onboarding_approval_events', expected.ref.id, overlay);
      if (!event || event.requestId !== requestId || event.lifecycleId !== `LIFE-${requestId}` || event.rowVersion !== expected.rowVersion || event.decision !== expected.state || event.stage !== 'manager') {
        throw new Error(`Snapshot manager proof does not match its request in ${example.id}.`);
      }
    } else if (expected.ref.table === 'onboarding_documents') {
      const document = rowById(data, 'onboarding_documents', expected.ref.id, overlay);
      if (!document || document.requestId !== requestId || document.lifecycleId !== `LIFE-${requestId}` || document.rowVersion !== expected.rowVersion || document.state !== expected.state) {
        throw new Error(`Snapshot document proof does not match its request in ${example.id}.`);
      }
    }
  }
}

function assertOnboardingStateOverride(
  example: ReturnType<typeof makeActionExamples>[number],
  data: ReturnType<typeof buildWorkflowEntities>,
  currentState: ReturnType<typeof entityStateSchema.parse> | undefined,
  overlay: ScenarioStateOverrides['workflowEntities']
): void {
  if (example.caseType !== 'already_completed' || !example.stateOverrides?.previewOnly) throw new Error(`Onboarding overlay is not preview-only or not a duplicate case: ${example.id}.`);
  const request = overlay.onboarding_requests?.[0];
  if (!request || !currentState || request.id !== currentState.ref.id || request.state !== currentState.state || request.rowVersion !== currentState.rowVersion || request.rowVersion !== 2) {
    throw new Error(`Onboarding request overlay and reviewed state disagree in ${example.id}.`);
  }
  const allEvents = new Map<string, Record<string, unknown>>();
  for (const event of [...data.entities.onboarding_approval_events, ...(overlay.onboarding_approval_events ?? [])]) allEvents.set(String(event.id), event);
  const checkPointer = (eventField: 'managerApprovalEventId' | 'directorApprovalEventId', byField: 'managerApprovedBy' | 'directorApprovedBy', atField: 'managerApprovedAt' | 'directorApprovedAt', stage: 'manager' | 'director', actorField: 'managerIdentityId' | 'directorIdentityId') => {
    const eventId = request[eventField];
    if (eventId === null) {
      if (request[byField] !== null || request[atField] !== null) throw new Error(`Cleared ${stage} proof retains approval fields in ${example.id}.`);
      return;
    }
    if (typeof eventId !== 'string') throw new Error(`Missing ${stage} event reference in ${example.id}.`);
    const event = allEvents.get(eventId);
    if (!event || event.requestId !== request.id || event.lifecycleId !== request.lifecycleId || event.stage !== stage || event.actorIdentityId !== request[actorField] || event.actorIdentityId !== request[byField] || event.createdAt !== request[atField] || event.decision !== 'approved' || typeof event.rowVersion !== 'number' || event.rowVersion < 1) {
      throw new Error(`Current ${stage} proof pointer is invalid in ${example.id}.`);
    }
  };
  checkPointer('managerApprovalEventId', 'managerApprovedBy', 'managerApprovedAt', 'manager', 'managerIdentityId');
  checkPointer('directorApprovalEventId', 'directorApprovedBy', 'directorApprovedAt', 'director', 'directorIdentityId');

  const executionId = example.stateOverrides.existingExecutionId;
  const execution = overlay.action_executions?.find(row => row.id === executionId);
  const targets = overlay.action_targets ?? [];
  if (example.review.preparation.existingExecutionId !== executionId || !execution || execution.actionId !== example.expectedResult.receipt.actionId || execution.kind !== example.kind || execution.actorId !== example.actorProfileId || execution.outcome !== 'verified_success' || execution.provenance !== 'synthetic-preview-only; not backend execution or proof' || execution.targetCount !== targets.length || targets.some(row => row.executionId !== executionId || row.outcome !== 'verified_success')) {
    throw new Error(`Existing execution overlay is inconsistent in ${example.id}.`);
  }
  for (const target of targets) {
    const targetRef = asRecord(target.ref, 'execution target reference');
    if (example.kind === 'onboarding_tasks_create') {
      if (targetRef.table !== 'onboarding_tasks' || targetRef.id !== target.targetId || !overlay.onboarding_tasks?.some(row => row.id === targetRef.id && row.requestId === request.id)) throw new Error(`Task execution target is detached in ${example.id}.`);
    } else if (targetRef.table !== 'onboarding_requests' || targetRef.id !== request.id || target.targetId !== request.id) {
      throw new Error(`Lifecycle execution target is detached in ${example.id}.`);
    }
  }
  if (!currentState?.completedActions.some(action => action.kind === example.kind && action.executionId === executionId)) throw new Error(`Completed action reference is missing in ${example.id}.`);

  if (example.kind === 'onboarding_return') {
    if (request.state !== 'returned_for_revision' || request.managerApprovalEventId !== null || request.directorApprovalEventId !== null || !overlay.onboarding_approval_events?.some(event => event.requestId === request.id && event.lifecycleId === request.lifecycleId && event.stage === 'director' && event.decision === 'returned_for_revision' && event.executionId === executionId)) {
      throw new Error(`Return transition/event mismatch in ${example.id}.`);
    }
  } else if (example.kind === 'onboarding_start') {
    if (request.state !== 'onboarding_in_progress' || !overlay.onboarding_checklists?.some(row => row.requestId === request.id && row.employeeId === request.employeeId && row.lifecycleId === request.lifecycleId)) throw new Error(`Start checklist mismatch in ${example.id}.`);
  } else if (example.kind === 'onboarding_tasks_create') {
    const templates = new Set((overlay.onboarding_tasks ?? []).filter(row => row.requestId === request.id).map(row => row.templateId));
    if (request.state !== 'onboarding_in_progress' || templates.size !== defaultDemoWorkflowPolicy.onboardingTaskTemplates.length || defaultDemoWorkflowPolicy.onboardingTaskTemplates.some(template => !templates.has(template))) throw new Error(`Task template overlay mismatch in ${example.id}.`);
  } else if (example.kind === 'onboarding_manager_approve') {
    if (request.state !== 'director_approval_pending' || request.managerApprovalEventId !== 'ONB-EVT-MGR-ALREADY-002') throw new Error(`Manager transition/proof mismatch in ${example.id}.`);
  } else if (example.kind === 'onboarding_director_approve') {
    if (request.id !== 'ONB-DEMO-002' || request.state !== 'director_approved' || request.managerApprovalEventId !== 'ONB-EVT-MGR-002' || request.directorApprovalEventId !== 'ONB-EVT-DIR-ALREADY-002') throw new Error(`Director transition/proof mismatch in ${example.id}.`);
  }
}

function profileScopeAllows(profile: PreviewProfile, kind: WorkflowActionKind): boolean {
  if (profile.role === 'east_manager' && ACTION_DEPARTMENT[kind] !== 'hr') return true;
  if (profile.role === 'east_manager' && kind === 'onboarding_manager_approve') return true;
  if (profile.role === 'hr_director') return ['onboarding_director_approve', 'onboarding_return'].includes(kind);
  if (profile.role === 'hr_admin') return ACTION_DEPARTMENT[kind] === 'hr' && kind !== 'onboarding_manager_approve' && kind !== 'onboarding_director_approve' && kind !== 'onboarding_return';
  if (profile.role === 'executive') return ACTION_DEPARTMENT[kind] !== 'hr';
  return false;
}

function downstreamActions(kind: WorkflowActionKind): WorkflowActionKind[] {
  if (kind === 'onboarding_manager_approve') return ['onboarding_director_approve', 'onboarding_return'];
  if (kind === 'onboarding_director_approve') return ['onboarding_start', 'onboarding_tasks_create', 'onboarding_return'];
  if (kind === 'onboarding_start') return ['onboarding_tasks_create'];
  return [];
}

function guardVariants(kind: WorkflowActionKind, date: string, data: ReturnType<typeof buildWorkflowEntities>) {
  const variants: Record<string, unknown>[] = [
    { variant: 'out_of_scope_or_wrong_profile', caseRef: actionRef(kind, data), outcome: 'denied' },
    { variant: 'duplicate_effect', caseRef: actionRef(kind, data), existingState: EXPECTED_STATE[kind], outcome: 'already_completed' },
    { variant: 'changed_row_version', caseRef: actionRef(kind, data), reviewedRowVersion: 1, currentRowVersion: 2, outcome: 'stale' }
  ];
  if (kind === 'onboarding_manager_approve') {
    variants.push(
      { variant: 'incomplete_documents', requestId: 'ONB-DEMO-003', acceptedDocumentCount: 2, requiredDocumentCount: defaultDemoWorkflowPolicy.requiredOnboardingDocuments.length },
      { variant: 'cancelled_request', requestId: 'ONB-DEMO-004', state: 'cancelled' },
      { variant: 'out_of_scope_request', requestId: 'ONB-DEMO-005', orgUnitId: ORG_WEST_HR },
      { variant: 'later_arrival_excluded_from_snapshot', requestId: 'ONB-DEMO-012', createdAt: localInstant(date, 23, 58), snapshotId: data.managerSnapshot.id }
    );
  }
  if (kind === 'onboarding_director_approve' || kind === 'onboarding_return') {
    variants.push(
      { variant: 'incomplete_documents', requestId: 'ONB-DEMO-003', acceptedDocumentCount: 2, requiredDocumentCount: defaultDemoWorkflowPolicy.requiredOnboardingDocuments.length },
      { variant: 'cancelled_request', requestId: 'ONB-DEMO-004', state: 'cancelled' },
      { variant: 'out_of_scope_request', requestId: 'ONB-DEMO-005', orgUnitId: ORG_WEST_HR },
      { variant: 'later_arrival_excluded_from_snapshot', requestId: 'ONB-DEMO-006', createdAt: localInstant(date, 23, 58), snapshotId: data.directorSnapshot.id }
    );
  }
  if (kind === 'onboarding_start' || kind === 'onboarding_tasks_create') {
    variants.push({ variant: 'manager_director_start_are_separate', managerApprovedRequestId: 'ONB-DEMO-002', directorApprovedRequestId: 'ONB-DEMO-007', startExampleRequestId: 'ONB-DEMO-007' });
  }
  return variants;
}

function buildCapabilities(profiles: PreviewProfile[], examples: ReturnType<typeof makeActionExamples>, data: ReturnType<typeof buildWorkflowEntities>) {
  return Object.fromEntries(profiles.map(profile => {
    const actionCapabilities: AllowedCapability[] = workflowActionKinds.map(kind => {
      const action = kind as WorkflowActionKind;
      const matchingExample = examples.find(example => example.kind === action && example.caseType === 'eligible')!;
      const permitted = profile.permissions.includes(ACTION_PERMISSION[action]) && profileScopeAllows(profile, action);
      const eligibleCount = permitted && matchingExample.eligibleProfileIds.includes(profile.id) ? 1 : 0;
      const snapshot = queueSnapshotForKind(action, data);
      const targetRef = permitted ? actionRef(action, data) : null;
      return allowedCapabilitySchema.parse({
        id: `CAP-${profile.id}-${action}`,
        kind: action,
        title: action,
        department: ACTION_DEPARTMENT[action],
        behavior: 'prepare',
        risk: ['onboarding_manager_approve', 'onboarding_director_approve', 'onboarding_return', 'onboarding_start', 'badge_revoke', 'dashboard_share_revoke', 'incident_escalate'].includes(action) ? 'high_impact' : 'creates_record',
        permitted,
        eligibleCount,
        available: permitted && eligibleCount > 0,
        disabledReason: !permitted ? { code: 'not_permitted_in_synthetic_preview', message: 'This synthetic profile does not have the example permission or scope.' } : eligibleCount === 0 ? { code: 'no_synthetic_eligible_example', message: 'No eligible synthetic example is available.' } : null,
        requiresConfirmation: true,
        simulatedConnector: action === 'dashboard_share' || action === 'it_disable_request',
        snapshotRef: snapshot && permitted ? { id: snapshot.id, digest: snapshot.digest, expiresAt: snapshot.expiresAt } : null,
        targetRefs: targetRef && eligibleCount > 0 ? [targetRef] : [],
        promptTemplate: null
      });
    });
    const managerSnapshot = data.managerSnapshot;
    const directorSnapshot = data.directorSnapshot;
    const queueCapabilities: AllowedCapability[] = [
      queueCapability(profile, 'manager_queue', profile.role === 'east_manager', managerSnapshot, ['ONB-DEMO-001']),
      queueCapability(profile, 'director_queue', profile.role === 'hr_director', directorSnapshot, ['ONB-DEMO-002'])
    ];
    return [profile.id, { source: 'synthetic-preview-model', capabilities: [...actionCapabilities, ...queueCapabilities] }];
  }));
}

function queueCapability(profile: PreviewProfile, kind: 'manager_queue' | 'director_queue', permitted: boolean, snapshot: ReturnType<typeof makeQueueSnapshot>, requestIds: string[]): AllowedCapability {
  const snapshotValue = snapshot!;
  return allowedCapabilitySchema.parse({
    id: `CAP-${profile.id}-${kind}`,
    kind,
    title: kind,
    department: 'hr',
    behavior: 'read',
    risk: 'read_only',
    permitted,
    eligibleCount: permitted ? snapshotValue.count : 0,
    available: permitted && snapshotValue.count > 0,
    disabledReason: permitted ? null : { code: 'not_permitted_in_synthetic_preview', message: 'This synthetic profile does not have the scoped queue responsibility.' },
    requiresConfirmation: false,
    simulatedConnector: false,
    snapshotRef: permitted ? { id: snapshotValue.id, digest: snapshotValue.digest, expiresAt: snapshotValue.expiresAt } : null,
    targetRefs: permitted ? requestIds.map(id => ({ table: 'onboarding_requests', id })) : [],
    promptTemplate: null
  });
}

function buildConversations(profiles: PreviewProfile[], views: Record<'all' | 'east', { scope: Scope; evidence: Awaited<ReturnType<typeof readEvidence>>; analysis: ReturnType<typeof deterministicAnalysis> }>, date: string, fixedClock: string) {
  return Object.fromEntries(profiles.map(profile => {
    const scopeKey = profile.role === 'east_manager' ? 'east' : 'all';
    const view = views[scopeKey];
    const conversationId = `CONV-DEMO-${profile.id.toUpperCase()}`;
    const conversation = conversationMetadataSchema.parse({
      id: conversationId,
      actorId: profile.id,
      title: profile.role === 'hr_admin' || profile.role === 'hr_director' ? 'Synthetic onboarding review' : `Synthetic ${scopeKey} evidence review`,
      pinned: true,
      archivedAt: null,
      rowVersion: 1,
      createdAt: localInstant(date, 8, 30),
      updatedAt: fixedClock,
      lastScope: profile.role === 'hr_admin' || profile.role === 'hr_director' ? null : view.scope,
      lastDashboardId: profile.role === 'executive' ? SAMPLE.dashboard : null
    });
    const messages = profile.role === 'hr_admin' || profile.role === 'hr_director'
      ? [
          { id: `MSG-${profile.id}-001`, conversationId, actorId: profile.id, role: 'user' as const, text: 'Show the synthetic onboarding review queue.', mode: 'scripted_demo' as const, modeRevision: 1, createdAt: localInstant(date, 8, 31) },
          { id: `MSG-${profile.id}-002`, conversationId, actorId: profile.id, role: 'assistant' as const, text: 'This preview includes synthetic onboarding records and does not call an approval service.', mode: 'scripted_demo' as const, modeRevision: 1, createdAt: localInstant(date, 8, 32) }
        ]
      : [
          { id: `MSG-${profile.id}-001`, conversationId, actorId: profile.id, role: 'user' as const, text: `Review the synthetic ${scopeKey} evidence for ${date}.`, mode: 'scripted_demo' as const, modeRevision: 1, createdAt: localInstant(date, 8, 31) },
          { id: `MSG-${profile.id}-002`, conversationId, actorId: profile.id, role: 'assistant' as const, text: view.analysis.facts[0]?.text ?? 'No synthetic evidence rows are available for this scope.', mode: 'scripted_demo' as const, modeRevision: 1, createdAt: localInstant(date, 8, 32), evidence: view.evidence, analysis: view.analysis, sources: view.evidence.sources }
        ];
    const context = conversationContextViewSchema.parse({ selectedConversationId: conversationId, conversation, messages, dashboardRefs: [], actions: [] });
    return [profile.id, context];
  }));
}

function buildRecipientDashboardView(
  eastView: { scope: Scope; evidence: Awaited<ReturnType<typeof readEvidence>>; analysis: ReturnType<typeof deterministicAnalysis> },
  data: ReturnType<typeof buildWorkflowEntities>
) {
  const version = data.entities.dashboard_versions.find(row => row.id === 'DASHVER-DEMO-001');
  if (!version || typeof version.spec !== 'object' || version.spec === null || !('widgets' in version.spec)) {
    throw new Error('Synthetic shared dashboard version is missing its widget projection.');
  }
  const widgets = (version.spec as { widgets: unknown[] }).widgets;
  return recipientDashboardViewSchema.parse({
    id: SAMPLE.dashboard,
    title: 'Dashboard in your permitted scope',
    ownerLabel: null,
    currentScope: eastView.scope,
    widgets,
    branches: eastView.evidence.branches.map(branch => ({
      branchId: branch.branchId,
      branchName: branch.branchName,
      region: branch.region,
      netSales: branch.netSales,
      target: branch.target,
      gap: branch.gap,
      achievement: branch.achievement,
      stockIssues: branch.stockIssues,
      incidentCount: branch.incidentCount,
      staffingPlanned: branch.staffingPlanned,
      staffingActual: branch.staffingActual,
      sourceIds: branch.sourceIds,
      incidents: branch.incidents.map(incident => ({
        id: incident.id,
        kind: incident.kind,
        status: incident.status,
        startedAt: incident.startedAt,
        endedAt: incident.endedAt,
        title: incident.title
      }))
    })),
    totals: eastView.evidence.totals,
    sources: eastView.evidence.sources,
    analysis: eastView.analysis,
    asOf: eastView.evidence.asOf
  });
}

function parseArgs(args: string[]) {
  let businessDate = DEFAULT_BUSINESS_DATE;
  let seed = DEFAULT_SEED;
  let out = resolve(process.cwd(), OUTPUT_RELATIVE_PATH);
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--business-date') {
      businessDate = args[++index] ?? '';
    } else if (option === '--seed') {
      const value = args[++index] ?? '';
      if (!/^-?\d+$/.test(value)) throw new Error('--seed must be a safe integer.');
      seed = Number(value);
    } else if (option === '--out') {
      const value = args[++index] ?? '';
      out = resolve(process.cwd(), value);
    } else {
      throw new Error(`Unsupported option: ${option}`);
    }
  }
  businessDate = isoDateSchema.parse(businessDate);
  if (!Number.isSafeInteger(seed)) throw new Error('--seed must be a safe integer.');
  const expected = resolve(process.cwd(), OUTPUT_RELATIVE_PATH);
  if (out !== expected) throw new Error(`--out is limited to ${OUTPUT_RELATIVE_PATH}.`);
  return { businessDate, seed, out };
}

export async function generateUiPreviewFixture(businessDate = DEFAULT_BUSINESS_DATE, seedValue = DEFAULT_SEED) {
  const date = isoDateSchema.parse(businessDate);
  if (!Number.isSafeInteger(seedValue)) throw new RangeError('seed must be a safe integer');
  const fixedClock = localInstant(date, 23, 59, 59);
  const now = new Date(fixedClock);
  const seed = createSeedData(date, seedValue);
  const profiles = buildProfiles(seed);
  const actor = (profile: PreviewProfile): Actor => ({
    id: profile.id,
    name: profile.name,
    role: profile.role === 'hr_director' ? 'hr_admin' : profile.role,
    active: profile.active,
    permissions: profile.permissions,
    regions: profile.regions,
    sessionId: `SESSION-${profile.id}`,
    mode: 'scripted_demo',
    modeRevision: 1
  });
  const reader = createSeedReader(seed);
  const [allEvidence, eastEvidence] = await Promise.all([
    readEvidence(reader, actor(profiles[0]), { region: 'all', date }, now),
    readEvidence(reader, actor(profiles[1]), { region: 'east', date }, now)
  ]);
  if (allEvidence.branches.length !== 12 || eastEvidence.branches.length !== 4) throw new Error('Authoritative evidence scopes did not produce 12 all-region and 4 East branches.');
  const views = {
    all: { scope: allEvidence.scope, evidence: allEvidence, analysis: deterministicAnalysis(allEvidence, now) },
    east: { scope: eastEvidence.scope, evidence: eastEvidence, analysis: deterministicAnalysis(eastEvidence, now) }
  };
  const parsedPolicy = versionedDemoWorkflowPolicySchema.parse(defaultDemoWorkflowPolicy);
  const policyDigest = digest(parsedPolicy);
  const policyPin = policyPinSchema.parse({ id: parsedPolicy.id, version: parsedPolicy.version, digest: policyDigest });
  const data = buildWorkflowEntities(seed, date, policyDigest, fixedClock);
  const actionExamples = makeActionExamples(date, data);
  assertActionExampleReferences(actionExamples, data, views);
  const recipientShareView = buildRecipientDashboardView(views.east, data);
  const previewViews = {
    ...views,
    recipientShare: { shareId: SAMPLE.share, recipientProfileId: 'east', view: recipientShareView }
  };
  const metadata = {
    previewOnly: true,
    brand: 'DaTex',
    businessDate: date,
    seed: seedValue,
    fixtureVersion: 4,
    generatedAt: fixedClock,
    fixedClock,
    seedDigest: digest(seed),
    capabilitySource: 'synthetic-preview-model'
  } as const;
  return {
    metadata,
    policy: { value: parsedPolicy, pin: policyPin },
    profiles,
    organization: {
      orgUnits: data.organization.orgUnits,
      directoryIdentities: data.organization.identities,
      responsibilities: data.organization.responsibilities,
      reportingRelationships: data.organization.reportingRelationships
    },
    branches: seed.branches,
    products: seed.products,
    employees: seed.employees,
    views: previewViews,
    workflowEntities: data.entities,
    capabilitiesByProfile: buildCapabilities(profiles, actionExamples, data),
    conversationsByProfile: buildConversations(profiles, views, date, fixedClock),
    actionExamples,
    scenarioIndex: {
      workflowKinds: [...workflowActionKinds],
      actionExampleCasesPerKind: ['eligible', 'denied', 'already_completed', 'stale'],
      directorSnapshotScenarios: makeDirectorSnapshotScenarios(data.directorSnapshot, fixedClock),
      branchScopes: { all: allEvidence.branches.map(branch => branch.branchId), east: eastEvidence.branches.map(branch => branch.branchId) },
      onboardingLifecycle: {
        managerApproval: { requestId: 'ONB-DEMO-001', actorProfileId: 'east', from: 'manager_review_pending', to: 'director_approval_pending', proofEventId: 'PREVIEW-ONLY-MANAGER-EVENT' },
        directorApproval: { requestId: 'ONB-DEMO-002', actorProfileId: 'hr_director', from: 'director_approval_pending', to: 'director_approved', proofEventId: 'PREVIEW-ONLY-DIRECTOR-EVENT' },
        start: { requestId: 'ONB-DEMO-007', actorProfileId: 'hr', from: 'director_approved', to: 'onboarding_in_progress', expectedChecklistId: 'PREVIEW-ONLY-CHECKLIST-ONB-DEMO-007' },
        onboardingTasks: { requestId: 'ONB-DEMO-011', actorProfileId: 'hr', from: 'onboarding_in_progress', templates: [...defaultDemoWorkflowPolicy.onboardingTaskTemplates] },
        queueExclusions: [
          { requestId: 'ONB-DEMO-003', reason: 'incomplete_required_documents' },
          { requestId: 'ONB-DEMO-004', reason: 'cancelled' },
          { requestId: 'ONB-DEMO-005', reason: 'outside_current_responsibility' },
          { requestId: 'ONB-DEMO-006', reason: 'arrived_after_director_snapshot' },
          { requestId: 'ONB-DEMO-012', reason: 'arrived_after_manager_snapshot' }
        ]
      },
      references: { currentEastIncidentId: data.openIncident.id, currentEastRestockSnapshotId: data.inventory.id, activePreviewBadgeId: 'C102', activePreviewBadgeEmployeeId: 'E024' }
    }
  };
}

async function main() {
  const { businessDate, seed, out } = parseArgs(process.argv.slice(2));
  const fixture = await generateUiPreviewFixture(businessDate, seed);
  await mkdir(dirname(out), { recursive: true });
  const contents = `${JSON.stringify(fixture, null, 2)}\n`;
  await writeFile(out, contents, 'utf8');
  process.stdout.write(`${JSON.stringify({ output: out, businessDate, seed, bytes: Buffer.byteLength(contents), actionExamples: fixture.actionExamples.length, allBranches: fixture.views.all.evidence.branches.length, eastBranches: fixture.views.east.evidence.branches.length, seedDigest: fixture.metadata.seedDigest }, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
