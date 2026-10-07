import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Branch, Incident, Inventory, Profile } from '../lib/contracts';
import { readWorkflowEvidence } from '../lib/packs/retail/workflow-evidence';
import { createOperationsWorkflowBindings } from '../lib/packs/operations-workflows';
import { createWorkflowActionRunner } from '../lib/workflows/action-runner';
import { createWorkflowActionRuntime } from '../lib/workflows/action-runtime';
import {
  addBangkokCalendarDays,
  demoWorkflowPolicyV1,
  getBangkokCalendarDate,
  getDemoWorkflowPolicyV1Pin,
  getTaskDueDate,
} from '../lib/workflows/policy';
import type { PendingActionV2, Responsibility, WorkflowPayloadV2 } from '../lib/workflows/contracts';
import { createWorkflowSqliteFixture } from './helpers/workflow-storage';
import { itSqliteBound } from './helpers/local-pg';

const NOW = new Date('2026-10-04T15:55:00.000Z');
const NOW_ISO = NOW.toISOString();
const CURRENT_BANGKOK_DATE = getBangkokCalendarDate(NOW);
const BUSINESS_DATE = addBangkokCalendarDays(CURRENT_BANGKOK_DATE, -1);
const OBSERVED_AT = new Date(NOW.getTime() - (23 * 60 + 55) * 60_000).toISOString();
const PERMISSIONS = [
  'sales.read',
  'operations.read',
  'ticket.create',
  'restock.create',
  'incident.escalate',
  'branch.review.assign',
];

type Fixture = Awaited<ReturnType<typeof createWorkflowSqliteFixture>>;
type Store = Fixture['store'];
type InvestigationPayload = Extract<WorkflowPayloadV2, { kind: 'investigation_create' }>;
type RestockPayload = Extract<WorkflowPayloadV2, { kind: 'restock_create' }>;
type IncidentPayload = Extract<WorkflowPayloadV2, { kind: 'incident_escalate' }>;
type BranchReviewPayload = Extract<WorkflowPayloadV2, { kind: 'branch_review_assign' }>;

interface IncidentRow extends Incident {
  escalationStage: 'un_escalated' | 'team_requested';
  escalationLifecycleId: string;
  escalationEventId: string | null;
}

interface InvestigationCaseRow {
  id: string;
  rowVersion: number;
  branchId: string;
  ownerIdentityId: string;
  status: 'open' | 'in_progress' | 'resolved' | 'cancelled';
  businessDate: string;
  sourceIds?: string[];
  lifecycleId: string;
}

interface EffectRow {
  id: string;
  rowVersion: number;
  [field: string]: unknown;
}

type GrantOrganization = 'primary' | 'alternate';
type GrantBranch = 'a' | 'b';

interface ActorGrantSeed {
  org: GrantOrganization;
  branches: readonly GrantBranch[];
}

interface OperationsHarnessSetup {
  branchAOrg: 'primary' | 'unlinked' | 'alternate';
  actorGrants: readonly ActorGrantSeed[];
  alternateOrgActive: boolean;
  businessDate: string;
}

interface AddCaseOptions {
  businessDate?: string;
  sourceIds?: string[];
  omitSourceIds?: boolean;
}

interface OperationsHarness {
  fixture: Fixture;
  store: Store;
  runtime: ReturnType<typeof createWorkflowActionRuntime>;
  runner: ReturnType<typeof createWorkflowActionRunner>;
  suffix: string;
  profileId: string;
  sessionId: string;
  conversationId: string;
  orgUnitId: string;
  alternateOrgUnitId: string;
  actorIdentityId: string;
  actorResponsibilityId: string;
  ownerIdentityId: string;
  ownerResponsibilityId: string;
  secondOwnerIdentityId: string;
  branchAId: string;
  branchBId: string;
  productAId: string;
  productBId: string;
  oldInventoryId: string;
  latestInventoryId: string;
  oversizedInventoryId: string;
  secondBranchInventoryId: string;
  incidentId: string;
  addCase(branchId: string, ownerIdentityId: string, label: string, options?: AddCaseOptions): Promise<string>;
  addIncident(label: string): Promise<string>;
  dispose(): Promise<void>;
}

function operationContextFor(action: Pick<PendingActionV2, 'conversationId' | 'turnId'>) {
  return { conversationId: action.conversationId, turnId: action.turnId };
}

function inventorySourceId(branchId: string): string {
  return inventorySourceIdForDate(branchId, BUSINESS_DATE);
}

function inventorySourceIdForDate(branchId: string, businessDate: string): string {
  return `inventory:${branchId}:${businessDate}`;
}

function taskDueDate(priority: 'normal' | 'high' = 'normal'): string {
  return getTaskDueDate(new Date(NOW), priority);
}

async function createHarness(setup: Partial<OperationsHarnessSetup> = {}): Promise<OperationsHarness> {
  const fixture = await createWorkflowSqliteFixture();
  const store = fixture.store;
  const suffix = randomUUID().replaceAll('-', '');
  const profileId = `ops-profile-${suffix}`;
  const ownerProfileId = `ops-owner-profile-${suffix}`;
  const secondOwnerProfileId = `ops-second-owner-profile-${suffix}`;
  const sessionId = `ops-session-${suffix}`;
  const conversationId = `ops-conversation-${suffix}`;
  const orgUnitId = `ops-org-${suffix}`;
  const alternateOrgUnitId = `ops-org-alternate-${suffix}`;
  const branchAId = `ops-east-a-${suffix}`;
  const branchBId = `ops-east-b-${suffix}`;
  const actorIdentityId = `ops-actor-identity-${suffix}`;
  const ownerIdentityId = `ops-owner-identity-${suffix}`;
  const secondOwnerIdentityId = `ops-second-owner-identity-${suffix}`;
  const actorResponsibilityId = `ops-actor-responsibility-${suffix}`;
  const ownerResponsibilityId = `ops-owner-responsibility-${suffix}`;
  const secondOwnerResponsibilityId = `ops-second-owner-responsibility-${suffix}`;
  const productAId = `ops-product-a-${suffix}`;
  const productBId = `ops-product-b-${suffix}`;
  const oldInventoryId = `ops-inventory-old-${suffix}`;
  const latestInventoryId = `ops-inventory-latest-${suffix}`;
  const oversizedInventoryId = `ops-inventory-oversized-${suffix}`;
  const secondBranchInventoryId = `ops-inventory-branch-b-${suffix}`;
  const incidentId = `ops-incident-primary-${suffix}`;
  const branchAOrg = setup.branchAOrg ?? 'primary';
  const actorGrants = setup.actorGrants ?? [{ org: 'primary', branches: ['a', 'b'] }];
  const alternateOrgActive = setup.alternateOrgActive ?? true;
  const configuredBusinessDate = setup.businessDate ?? BUSINESS_DATE;
  const needsAlternateOrg = branchAOrg === 'alternate' || actorGrants.some(grant => grant.org === 'alternate');
  const now = new Date(NOW);
  let generatedId = 0;

  try {
    const actorProfile: Profile = {
      id: profileId,
      name: 'Synthetic Operations Runtime Actor',
      role: 'executive',
      active: true,
      permissions: PERMISSIONS,
      regions: ['East'],
    };
    const ownerProfile: Profile = {
      id: ownerProfileId,
      name: 'Synthetic Operations Owner',
      role: 'east_manager',
      active: true,
      permissions: [],
      regions: ['East'],
    };
    const secondOwnerProfile: Profile = {
      id: secondOwnerProfileId,
      name: 'Synthetic Second Operations Owner',
      role: 'east_manager',
      active: true,
      permissions: [],
      regions: ['East'],
    };

    await store.transaction(async (tx) => {
      await tx.put('profiles', actorProfile);
      await tx.put('profiles', ownerProfile);
      await tx.put('profiles', secondOwnerProfile);
      await tx.put('sessions', {
        id: sessionId,
        profileId,
        mode: 'scripted_demo',
        modeRevision: 1,
        csrfToken: `csrf-${suffix}`,
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
    });

    const branchAResolvedOrg = branchAOrg === 'unlinked' ? null
      : branchAOrg === 'alternate' ? alternateOrgUnitId : orgUnitId;
    const branchA: Branch & { orgUnitId: string | null } = {
      id: branchAId, name: `Synthetic East Branch A ${suffix}`, region: 'East', orgUnitId: branchAResolvedOrg,
    };
    const branchB: Branch & { orgUnitId: string } = {
      id: branchBId, name: `Synthetic East Branch B ${suffix}`, region: 'East', orgUnitId,
    };
    const policyPin = getDemoWorkflowPolicyV1Pin();
    await store.workflowTransaction(async (tx) => {
      const orgUnits = [
        { id: orgUnitId, name: `Synthetic Operations Unit ${suffix}`, active: true },
        ...(needsAlternateOrg ? [{ id: alternateOrgUnitId, name: `Synthetic Alternate Operations Unit ${suffix}`, active: alternateOrgActive }] : []),
      ];
      for (const orgUnit of orgUnits) {
        await tx.insertUnique('org_units', {
          ...orgUnit,
          parentOrgUnitId: null,
        }, { constraint: 'org_units_primary_key', values: { id: orgUnit.id } });
      }
    });

    await store.transaction(async (tx) => {
      await tx.put('branches', branchA);
      await tx.put('branches', branchB);
    });

    await store.workflowTransaction(async (tx) => {
      const identities = [
        { id: actorIdentityId, profileId, displayName: 'Synthetic Operations Actor', role: 'executive' as const },
        { id: ownerIdentityId, profileId: ownerProfileId, displayName: 'Synthetic Operations Owner', role: 'east_manager' as const },
        { id: secondOwnerIdentityId, profileId: secondOwnerProfileId, displayName: 'Synthetic Second Owner', role: 'east_manager' as const },
      ];
      for (const identity of identities) {
        await tx.insertUnique('directory_identities', {
          ...identity,
          active: true,
          department: 'sales_operations',
          orgUnitId,
          managerIdentityId: null,
          verifiedDemoEmail: `${identity.id}@example.invalid`,
          slackIdentity: null,
          allowedChannels: ['simulated_email'],
          classificationCeiling: 'internal',
          rowVersion: 1,
        }, { constraint: 'directory_identities_primary_key', values: { id: identity.id } });
      }
      const actorResponsibilities = actorGrants.map(grant => ({
        id: grant.org === 'primary' ? actorResponsibilityId : `ops-actor-alternate-responsibility-${suffix}`,
        identityId: actorIdentityId,
        orgUnitId: grant.org === 'primary' ? orgUnitId : alternateOrgUnitId,
        branchIds: grant.branches.map(branch => branch === 'a' ? branchAId : branchBId),
      }));
      const responsibilities = [
        ...actorResponsibilities,
        { id: ownerResponsibilityId, identityId: ownerIdentityId, orgUnitId, branchIds: [branchAId] },
        { id: secondOwnerResponsibilityId, identityId: secondOwnerIdentityId, orgUnitId, branchIds: [branchBId] },
      ];
      for (const responsibility of responsibilities) {
        await tx.insertUnique('responsibilities', {
          ...responsibility,
          purpose: 'sales_operations',
          active: true,
          rowVersion: 1,
        }, { constraint: 'responsibilities_open_identity_purpose_unique', values: {
          identityId: responsibility.identityId,
          purpose: 'sales_operations',
          orgUnitId: responsibility.orgUnitId,
        } });
      }
      await tx.insertUnique('conversations', {
        id: conversationId,
        actorId: profileId,
        title: 'Synthetic Operations Runtime Conversation',
        pinned: false,
        archivedAt: null,
        rowVersion: 1,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        lastScope: null,
        lastDashboardId: null,
      }, { constraint: 'conversations_primary_key', values: { id: conversationId } });
      await tx.insertUnique('workflow_policies', {
        id: `ops-policy-row-${suffix}`,
        version: policyPin.version,
        digest: policyPin.digest,
        policy: demoWorkflowPolicyV1,
      }, { constraint: 'workflow_policies_policy_version_unique', values: {
        'policy.id': policyPin.id,
        version: policyPin.version,
      } });
      await tx.insertUnique('workflow_teams', {
        id: 'demo_operations',
        name: 'Demo Operations',
        active: true,
      }, { constraint: 'workflow_teams_primary_key', values: { id: 'demo_operations' } });
    });

    const inventoryRows: Inventory[] = [
      {
        id: oldInventoryId, branchId: branchAId, productId: productAId,
        date: addBangkokCalendarDays(configuredBusinessDate, -1), onHand: 5, minimum: 10,
        observedAt: '2026-10-02T16:00:00.000Z', updatedAt: '2026-10-02T16:00:00.000Z',
      },
      {
        id: latestInventoryId, branchId: branchAId, productId: productAId,
        date: configuredBusinessDate, onHand: 3, minimum: 20,
        observedAt: OBSERVED_AT, updatedAt: OBSERVED_AT,
      },
      {
        id: oversizedInventoryId, branchId: branchAId, productId: productBId,
        date: configuredBusinessDate, onHand: 1, minimum: 700,
        observedAt: OBSERVED_AT, updatedAt: OBSERVED_AT,
      },
      {
        id: secondBranchInventoryId, branchId: branchBId, productId: productAId,
        date: configuredBusinessDate, onHand: 2, minimum: 15,
        observedAt: OBSERVED_AT, updatedAt: OBSERVED_AT,
      },
    ];
    const incident: IncidentRow = {
      id: incidentId,
      branchId: branchAId,
      date: configuredBusinessDate,
      title: 'Synthetic stock discrepancy',
      kind: 'stock',
      status: 'open',
      startedAt: new Date(Date.parse(OBSERVED_AT) - 10 * 60_000).toISOString(),
      endedAt: null,
      updatedAt: OBSERVED_AT,
      escalationStage: 'un_escalated',
      escalationLifecycleId: `ops-incident-lifecycle-${suffix}`,
      escalationEventId: null,
    };

    await store.transaction(async (tx) => {
      await tx.put('products', { id: productAId, name: 'Synthetic Tea', category: 'beverage' });
      await tx.put('products', { id: productBId, name: 'Synthetic Rice', category: 'grocery' });
      for (const row of inventoryRows) await tx.put('inventory_snapshots', row);
      await tx.put('incidents', incident);
    });

    const runtime = createWorkflowActionRuntime({
      store,
      bindings: createOperationsWorkflowBindings(),
      businessDate: configuredBusinessDate,
      getReleaseRevision: () => 'operations-bindings-test-release-r1',
      getPackPins: (packIds) => packIds.map((id) => ({
        id,
        version: '1.0',
        schemaDigest: 'c'.repeat(64),
        implementationRevision: 'operations-bindings-test-implementation-r1',
      })),
      contextFactory: (_reader, principal, view) => ({
        evidence: (scope) => readWorkflowEvidence({ projections: view.projections, principal, now: view.now() }, scope),
        latestDashboard: async () => undefined,
      }),
      now: () => new Date(now),
      makeId: (prefix) => `ops-${prefix}-${suffix}-${++generatedId}`,
    });

    const addCase = async (branchId: string, ownerId: string, label: string, options: AddCaseOptions = {}): Promise<string> => {
      const id = `ops-case-${label}-${suffix}`;
      const caseBusinessDate = options.businessDate ?? configuredBusinessDate;
      const row: InvestigationCaseRow = {
        id,
        rowVersion: 1,
        branchId,
        ownerIdentityId: ownerId,
        status: 'open',
        businessDate: caseBusinessDate,
        lifecycleId: `ops-case-lifecycle-${label}-${suffix}`,
        ...(options.omitSourceIds ? {} : { sourceIds: options.sourceIds ?? [inventorySourceIdForDate(branchId, caseBusinessDate)] }),
      };
      const inserted = await store.workflowTransaction((tx) => tx.insertUnique('investigation_cases', row, {
        constraint: 'investigation_cases_open_equivalent_unique',
        values: { branchId, ownerIdentityId: ownerId, businessDate: caseBusinessDate },
      }));
      if (!inserted.inserted) throw new Error(`The synthetic case ${label} unexpectedly conflicted`);
      return id;
    };

    const addIncident = async (label: string): Promise<string> => {
      const id = `ops-incident-${label}-${suffix}`;
      const row: IncidentRow = {
        ...incident,
        id,
        escalationLifecycleId: `ops-incident-lifecycle-${label}-${suffix}`,
      };
      await store.transaction((tx) => tx.put('incidents', row));
      return id;
    };

    return {
      fixture,
      store,
      runtime,
      runner: createWorkflowActionRunner(runtime),
      suffix,
      profileId,
      sessionId,
      conversationId,
      orgUnitId,
      alternateOrgUnitId,
      actorIdentityId,
      actorResponsibilityId,
      ownerIdentityId,
      ownerResponsibilityId,
      secondOwnerIdentityId,
      branchAId,
      branchBId,
      productAId,
      productBId,
      oldInventoryId,
      latestInventoryId,
      oversizedInventoryId,
      secondBranchInventoryId,
      incidentId,
      addCase,
      addIncident,
      dispose: () => fixture.dispose(),
    };
  } catch (error) {
    await fixture.dispose();
    throw error;
  }
}

async function withHarness(
  work: (harness: OperationsHarness) => Promise<void>,
  setup: Partial<OperationsHarnessSetup> = {},
): Promise<void> {
  const harness = await createHarness(setup);
  try {
    await work(harness);
  } finally {
    await harness.dispose();
  }
}

async function prepare(
  harness: OperationsHarness,
  payload: WorkflowPayloadV2,
  turn: string,
) {
  return harness.runtime.prepare(harness.sessionId, payload, {
    conversationId: harness.conversationId,
    turnId: `ops-turn-${harness.suffix}-${turn}`,
  });
}

async function confirm(harness: OperationsHarness, action: PendingActionV2) {
  return harness.runner.confirm(
    harness.sessionId,
    action.id,
    `ops-confirm-${harness.suffix}-${action.turnId}`,
    operationContextFor(action),
  );
}

async function rowsForCase<T>(
  harness: OperationsHarness,
  table: 'investigation_tasks' | 'branch_review_assignments',
  branchId: string,
  caseId: string,
) {
  return harness.store.workflowProjectionReader.query<T>({
    kind: 'scoped', table, branchIds: [branchId], equals: { caseId }, limit: 50,
  });
}

async function expectActorAuthorityPinned(
  harness: OperationsHarness,
  action: PendingActionV2,
  branchId: string,
  orgUnitId: string,
  responsibilityId: string,
): Promise<void> {
  const target = action.targets[0];
  const branch = await harness.store.workflowProjectionReader.get<{ id: string }>('branches', branchId);
  const orgUnit = await harness.store.workflowProjectionReader.get<{ active: boolean }>('org_units', orgUnitId);
  const responsibility = await harness.store.workflowProjectionReader.get<Responsibility>('responsibilities', responsibilityId);
  if (!branch || !orgUnit || !responsibility) throw new Error('A pinned actor authority row disappeared');
  expect(target.expectedRows).toContainEqual({
    ref: { table: 'branches', id: branchId }, rowVersion: branch.rowVersion, state: null,
  });
  expect(target.expectedRows).toContainEqual({
    ref: { table: 'org_units', id: orgUnitId }, rowVersion: orgUnit.rowVersion, state: 'active',
  });
  expect(target.expectedRows).toContainEqual({
    ref: { table: 'responsibilities', id: responsibilityId }, rowVersion: responsibility.rowVersion, state: 'active',
  });
  expect(action.approvedOrgUnitIds).toContain(orgUnitId);
}

async function updateResponsibility(
  harness: OperationsHarness,
  responsibilityId: string,
  update: Partial<Responsibility>,
): Promise<void> {
  await harness.store.workflowTransaction(async (tx) => {
    const current = await tx.get<Responsibility>('responsibilities', responsibilityId);
    if (!current) throw new Error(`The synthetic responsibility ${responsibilityId} disappeared`);
    const next = { ...current, ...update, rowVersion: current.rowVersion + 1 };
    const changed = await tx.compareAndSwap('responsibilities', responsibilityId,
      { rowVersion: current.rowVersion, state: current.active ? 'active' : 'inactive' }, next);
    if (!changed.updated) throw new Error(`Could not update the synthetic responsibility ${responsibilityId}`);
  });
}

async function expectCaseEvidencePinned(
  harness: OperationsHarness,
  action: PendingActionV2,
  caseId: string,
  branchId: string,
  businessDate: string,
  sourceIds: readonly string[],
): Promise<void> {
  const target = action.targets[0];
  const caseRow = await harness.store.workflowProjectionReader.get<InvestigationCaseRow>('investigation_cases', caseId);
  if (!caseRow) throw new Error(`The synthetic case ${caseId} disappeared`);
  expect(caseRow.body).toMatchObject({ branchId, businessDate, sourceIds: [...sourceIds] });
  expect(target.expectedRows).toContainEqual({
    ref: { table: 'investigation_cases', id: caseId }, rowVersion: caseRow.rowVersion, state: caseRow.body.status,
  });

  const evidenceRows = await harness.store.workflowProjectionReader.query<Inventory>({
    kind: 'scoped', table: 'inventory_snapshots', branchIds: [branchId],
    fromDate: businessDate, throughDate: businessDate, limit: 50,
  });
  const frozenEvidenceRows = target.expectedRows.filter(row => row.ref.table === 'inventory_snapshots');
  expect(frozenEvidenceRows.map(row => row.ref.id).sort()).toEqual(evidenceRows.map(row => row.id).sort());
  expect(evidenceRows.length).toBeGreaterThan(0);
  for (const row of evidenceRows) {
    expect(row.body).toMatchObject({ branchId, date: businessDate });
    expect(Date.parse(row.body.observedAt)).toBeLessThanOrEqual(NOW.getTime());
    expect(frozenEvidenceRows).toContainEqual({
      ref: { table: 'inventory_snapshots', id: row.id }, rowVersion: row.rowVersion, state: null,
    });
  }
}

async function replaceCaseSourceIds(harness: OperationsHarness, caseId: string, sourceIds: string[]): Promise<void> {
  await harness.store.workflowTransaction(async (tx) => {
    const current = await tx.get<InvestigationCaseRow>('investigation_cases', caseId);
    if (!current) throw new Error(`The synthetic case ${caseId} disappeared`);
    const next = { ...current, rowVersion: current.rowVersion + 1, sourceIds };
    const changed = await tx.compareAndSwap('investigation_cases', caseId,
      { rowVersion: current.rowVersion, state: current.status }, next);
    if (!changed.updated) throw new Error(`Could not change evidence references for ${caseId}`);
  });
}

async function updateInventory(harness: OperationsHarness, inventoryId: string, update: Partial<Inventory>): Promise<void> {
  await harness.store.transaction(async (tx) => {
    const current = await tx.get<Inventory>('inventory_snapshots', inventoryId);
    if (!current) throw new Error(`The synthetic inventory row ${inventoryId} disappeared`);
    await tx.put('inventory_snapshots', { ...current, ...update });
  });
}

function sqlQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function createFixtureTrigger(harness: OperationsHarness, name: string, body: string): void {
  const database = harness.fixture.openDatabase();
  try {
    database.exec(`CREATE TRIGGER ${name} ${body}`);
  } finally {
    database.close();
  }
}

describe('Operations guarded runtime bindings', () => {
  it('creates an investigation task from the configured closed date and persists exact case evidence', async () => {
    await withHarness(async (harness) => {
      const caseId = await harness.addCase(harness.branchAId, harness.ownerIdentityId, 'investigation-success');
      const payload: InvestigationPayload = {
        kind: 'investigation_create',
        businessDate: BUSINESS_DATE,
        targets: [{
          ownerIdentityId: harness.ownerIdentityId,
          reason: 'Review the synthetic stock discrepancy.',
          dueDate: taskDueDate('normal'),
          priority: 'normal',
          branchId: harness.branchAId,
          caseId,
          sourceIds: [inventorySourceId(harness.branchAId)],
          unansweredQuestion: 'Which movement explains the reviewed variance?',
        }],
      };

      const prepared = await prepare(harness, payload, 'investigation-success');
      expect(prepared.outcome).toBe('pending');
      const action = prepared.pendingAction!;
      expect(action.payload).toEqual(payload);
      const target = action.targets[0];
      expect(target.expectedEffectRef.table).toBe('investigation_tasks');
      expect(BUSINESS_DATE < CURRENT_BANGKOK_DATE).toBe(true);
      await expectCaseEvidencePinned(harness, action, caseId, harness.branchAId,
        BUSINESS_DATE, payload.targets[0].sourceIds);

      const result = await confirm(harness, action);
      expect(result.error).toBeNull();
      expect(result.receipt?.outcome).toBe('verified_success');
      expect(result.receipt?.proofs).toEqual([
        expect.objectContaining({
          ref: target.expectedEffectRef,
          outcome: 'verified_success',
          observedRowVersion: 1,
        }),
      ]);

      const task = await harness.store.workflowProjectionReader.get<EffectRow>(
        target.expectedEffectRef.table,
        target.expectedEffectRef.id,
      );
      expect(task?.body).toMatchObject({
        id: target.expectedEffectRef.id,
        rowVersion: 1,
        caseId,
        branchId: harness.branchAId,
        ownerIdentityId: harness.ownerIdentityId,
        reason: payload.targets[0].reason,
        dueDate: payload.targets[0].dueDate,
        priority: payload.targets[0].priority,
        sourceIds: payload.targets[0].sourceIds,
        unansweredQuestion: payload.targets[0].unansweredQuestion,
        status: 'open',
        executionId: result.receipt?.id,
      });

      const repeated = await prepare(harness, {
        ...payload,
        targets: [{ ...payload.targets[0], reason: 'Use different reviewed wording.' }],
      }, 'investigation-semantic-repeat');
      expect(repeated.outcome).toBe('already_completed');
      expect(repeated.existingExecutionId).toBe(result.receipt?.id);
      expect(await rowsForCase(harness, 'investigation_tasks', harness.branchAId, caseId)).toHaveLength(1);
    });
  });

  it('rechecks current owner responsibility when confirming an investigation', async () => {
    await withHarness(async (harness) => {
      const caseId = await harness.addCase(harness.branchAId, harness.ownerIdentityId, 'investigation-stale-owner');
      const payload: InvestigationPayload = {
        kind: 'investigation_create',
        businessDate: BUSINESS_DATE,
        targets: [{
          ownerIdentityId: harness.ownerIdentityId,
          reason: 'Review the current scoped evidence.',
          dueDate: taskDueDate('high'),
          priority: 'high',
          branchId: harness.branchAId,
          caseId,
          sourceIds: [inventorySourceId(harness.branchAId)],
          unansweredQuestion: 'Which source movement changed the count?',
        }],
      };
      const prepared = await prepare(harness, payload, 'investigation-stale-owner');
      expect(prepared.outcome).toBe('pending');
      const action = prepared.pendingAction!;

      await harness.store.workflowTransaction(async (tx) => {
        const responsibility = await tx.get<Responsibility>('responsibilities', harness.ownerResponsibilityId);
        if (!responsibility) throw new Error('The synthetic owner responsibility disappeared');
        const changed = await tx.compareAndSwap('responsibilities', responsibility.id,
          { rowVersion: responsibility.rowVersion, state: 'active' },
          { ...responsibility, rowVersion: responsibility.rowVersion + 1, active: false });
        if (!changed.updated) throw new Error('Could not revoke the synthetic owner responsibility');
      });

      const result = await confirm(harness, action);
      expect(result.receipt).toBeNull();
      expect(result.error).toMatchObject({ outcome: 'stale', domainEffect: 'none', retryBusinessWrite: false });
      expect(await harness.store.workflowProjectionReader.get('investigation_tasks', action.targets[0].expectedEffectRef.id)).toBeUndefined();
    });
  });

  itSqliteBound('rolls back the first investigation target when a later SQLite insert fails', async () => {
    await withHarness(async (harness) => {
      const firstCaseId = await harness.addCase(harness.branchAId, harness.ownerIdentityId, 'rollback-first');
      const secondCaseId = await harness.addCase(harness.branchBId, harness.secondOwnerIdentityId, 'rollback-second');
      const payload: InvestigationPayload = {
        kind: 'investigation_create',
        businessDate: BUSINESS_DATE,
        targets: [
          {
            ownerIdentityId: harness.ownerIdentityId,
            reason: 'Review the first branch discrepancy.',
            dueDate: taskDueDate('normal'),
            priority: 'normal',
            branchId: harness.branchAId,
            caseId: firstCaseId,
            sourceIds: [inventorySourceId(harness.branchAId)],
            unansweredQuestion: 'What changed in branch A?',
          },
          {
            ownerIdentityId: harness.secondOwnerIdentityId,
            reason: 'Review the second branch discrepancy.',
            dueDate: taskDueDate('normal'),
            priority: 'normal',
            branchId: harness.branchBId,
            caseId: secondCaseId,
            sourceIds: [inventorySourceId(harness.branchBId)],
            unansweredQuestion: 'What changed in branch B?',
          },
        ],
      };
      const prepared = await prepare(harness, payload, 'investigation-batch-rollback');
      expect(prepared.outcome).toBe('pending');
      const action = prepared.pendingAction!;
      const triggerName = `fail_second_investigation_${harness.suffix}`;
      createFixtureTrigger(harness, triggerName,
        `BEFORE INSERT ON investigation_tasks WHEN NEW.case_id = ${sqlQuote(secondCaseId)} ` +
        `BEGIN SELECT RAISE(ABORT, 'injected second target failure'); END`);

      const result = await confirm(harness, action);
      expect(result.receipt).toBeNull();
      expect(result.error).toMatchObject({
        outcome: 'failed',
        commitCertainty: 'definitely_not_committed',
        domainEffect: 'none',
        retryBusinessWrite: false,
      });
      for (const target of action.targets) {
        expect(target.expectedEffectRef.table).toBe('investigation_tasks');
        expect(await harness.store.workflowProjectionReader.get(
          target.expectedEffectRef.table,
          target.expectedEffectRef.id,
        )).toBeUndefined();
        expect(await harness.store.workflowProjectionReader.query({
          kind: 'unique', table: 'semantic_effects', constraint: 'semantic_effects_key_unique',
          values: { semanticKey: target.semanticKey },
        })).toHaveLength(0);
      }
      expect(await rowsForCase(harness, 'investigation_tasks', harness.branchAId, firstCaseId)).toHaveLength(0);
      expect(await rowsForCase(harness, 'investigation_tasks', harness.branchBId, secondCaseId)).toHaveLength(0);
    });
  });

  it('uses the latest scoped stock and rejects stale or silently clipped restock quantities', async () => {
    await withHarness(async (harness) => {
      const payload: RestockPayload = {
        kind: 'restock_create',
        targets: [{
          ownerIdentityId: harness.ownerIdentityId,
          reason: 'Restore stock to twice the current minimum.',
          dueDate: taskDueDate('normal'),
          priority: 'normal',
          inventorySnapshotId: harness.latestInventoryId,
          branchId: harness.branchAId,
          productId: harness.productAId,
          quantity: 37,
        }],
      };
      const prepared = await prepare(harness, payload, 'restock-latest');
      expect(prepared.outcome).toBe('pending');
      const action = prepared.pendingAction!;
      expect(action.createdAt).toBe(NOW_ISO);
      expect(action.expiresAt).toBe(new Date(NOW.getTime() + demoWorkflowPolicyV1.pendingTtlSeconds * 1_000).toISOString());
      expect(payload.targets[0].dueDate).toBe(taskDueDate('normal'));
      const result = await confirm(harness, action);
      expect(result.error).toBeNull();
      expect(result.receipt?.outcome).toBe('verified_success');
      const request = await harness.store.workflowProjectionReader.get<EffectRow>(
        action.targets[0].expectedEffectRef.table,
        action.targets[0].expectedEffectRef.id,
      );
      expect(request?.body).toMatchObject({
        id: action.targets[0].expectedEffectRef.id,
        rowVersion: 1,
        branchId: harness.branchAId,
        productId: harness.productAId,
        inventorySnapshotId: harness.latestInventoryId,
        ownerIdentityId: harness.ownerIdentityId,
        quantity: 2 * 20 - 3,
        reason: payload.targets[0].reason,
        dueDate: payload.targets[0].dueDate,
        priority: payload.targets[0].priority,
        createdAt: NOW_ISO,
        status: 'open',
        executionId: result.receipt?.id,
      });

      const repeated = await prepare(harness, {
        ...payload,
        targets: [{ ...payload.targets[0], reason: 'Updated human wording for the same restock.' }],
      }, 'restock-semantic-repeat');
      expect(repeated.outcome).toBe('already_completed');
      expect(repeated.existingExecutionId).toBe(result.receipt?.id);

      const stale = await prepare(harness, {
        ...payload,
        targets: [{ ...payload.targets[0], inventorySnapshotId: harness.oldInventoryId, quantity: 15 }],
      }, 'restock-stale-snapshot');
      expect(stale.outcome).toBe('stale');
      expect(stale.pendingAction).toBeNull();

      await expect(prepare(harness, {
        ...payload,
        targets: [{
          ...payload.targets[0],
          inventorySnapshotId: harness.oversizedInventoryId,
          productId: harness.productBId,
          quantity: 1_000,
        }],
      }, 'restock-clipped-quantity')).rejects.toMatchObject({
        details: {
          code: 'WORKFLOW_INVALID_INPUT',
          outcome: 'failed',
          domainEffect: 'none',
          retryBusinessWrite: false,
        },
      });
      const oversizedRows = await harness.store.workflowProjectionReader.query({
        kind: 'scoped', table: 'restock_requests', branchIds: [harness.branchAId],
        equals: { productId: harness.productBId }, limit: 50,
      });
      expect(oversizedRows).toHaveLength(0);

      const beyondRestockAge = new Date(NOW.getTime() -
        demoWorkflowPolicyV1.restock.maxEvidenceAgeHours * 60 * 60_000 - 60_000).toISOString();
      await updateInventory(harness, harness.secondBranchInventoryId, {
        observedAt: beyondRestockAge,
        updatedAt: beyondRestockAge,
      });
      const expiredEvidence = await prepare(harness, {
        ...payload,
        targets: [{
          ...payload.targets[0],
          branchId: harness.branchBId,
          ownerIdentityId: harness.secondOwnerIdentityId,
          inventorySnapshotId: harness.secondBranchInventoryId,
          productId: harness.productAId,
          quantity: 2 * 15 - 2,
        }],
      }, 'restock-beyond-24-hours');
      expect(expiredEvidence.outcome).toBe('stale');
      expect(expiredEvidence.pendingAction).toBeNull();
      expect(await harness.store.workflowProjectionReader.query({
        kind: 'scoped', table: 'restock_requests', branchIds: [harness.branchBId],
        equals: { productId: harness.productAId }, limit: 50,
      })).toHaveLength(0);
    });
  });

  itSqliteBound('links each incident event to a CAS-updated source and rolls both back if the source CAS fails', async () => {
    await withHarness(async (harness) => {
      const makePayload = (incidentId: string, reason: string): IncidentPayload => ({
        kind: 'incident_escalate',
        targets: [{
          incidentId,
          targetTeamId: 'demo_operations',
          evidenceIds: [inventorySourceId(harness.branchAId)],
          reason,
        }],
      });
      const payload = makePayload(harness.incidentId, 'The reviewed incident needs operations follow-up.');
      const prepared = await prepare(harness, payload, 'incident-success');
      expect(prepared.outcome).toBe('pending');
      const action = prepared.pendingAction!;
      const result = await confirm(harness, action);
      expect(result.error).toBeNull();
      expect(result.receipt?.outcome).toBe('verified_success');

      const eventRef = action.targets[0].expectedEffectRef;
      expect(eventRef.table).toBe('incident_escalation_events');
      const event = await harness.store.workflowProjectionReader.get<EffectRow>(eventRef.table, eventRef.id);
      const incident = await harness.store.workflowProjectionReader.get<IncidentRow>('incidents', harness.incidentId);
      expect(event?.body).toMatchObject({
        id: eventRef.id,
        rowVersion: 1,
        incidentId: harness.incidentId,
        teamId: 'demo_operations',
        actorId: harness.profileId,
        stage: 'team_requested',
        lifecycleId: incident?.body.escalationLifecycleId,
        reason: payload.targets[0].reason,
        evidenceIds: payload.targets[0].evidenceIds,
        executionId: result.receipt?.id,
      });
      expect(incident).toMatchObject({
        rowVersion: 2,
        body: {
          escalationStage: 'team_requested',
          escalationEventId: eventRef.id,
          escalationLifecycleId: event?.body.lifecycleId,
        },
      });

      const repeated = await prepare(harness, makePayload(harness.incidentId, 'Different reviewed explanation.'),
        'incident-semantic-repeat');
      expect(repeated.outcome).toBe('already_completed');
      expect(repeated.existingExecutionId).toBe(result.receipt?.id);
      const eventRows = await harness.store.workflowProjectionReader.query({
        kind: 'unique', table: 'incident_escalation_events', constraint: 'incident_escalation_lifecycle_stage_unique',
        values: { incidentId: harness.incidentId, lifecycleId: String(event?.body.lifecycleId), stage: 'team_requested' },
      });
      expect(eventRows).toHaveLength(1);

      const failedIncidentId = await harness.addIncident('cas-failure');
      const failedPrepared = await prepare(harness,
        makePayload(failedIncidentId, 'This source CAS is rejected by the private test database.'),
        'incident-source-cas-rollback');
      expect(failedPrepared.outcome).toBe('pending');
      const failedAction = failedPrepared.pendingAction!;
      const triggerName = `fail_incident_cas_${harness.suffix}`;
      createFixtureTrigger(harness, triggerName,
        `BEFORE UPDATE ON incidents WHEN NEW.id = ${sqlQuote(failedIncidentId)} ` +
        `BEGIN SELECT RAISE(ABORT, 'injected incident CAS failure'); END`);

      const failed = await confirm(harness, failedAction);
      expect(failed.receipt).toBeNull();
      expect(failed.error).toMatchObject({
        outcome: 'failed',
        commitCertainty: 'definitely_not_committed',
        domainEffect: 'none',
        retryBusinessWrite: false,
      });
      const unchangedIncident = await harness.store.workflowProjectionReader.get<IncidentRow>('incidents', failedIncidentId);
      expect(unchangedIncident).toMatchObject({
        rowVersion: 1,
        body: { escalationStage: 'un_escalated', escalationEventId: null },
      });
      const failedEventRef = failedAction.targets[0].expectedEffectRef;
      expect(await harness.store.workflowProjectionReader.get(failedEventRef.table, failedEventRef.id)).toBeUndefined();
      expect(await harness.store.workflowProjectionReader.query({
        kind: 'unique', table: 'incident_escalation_events', constraint: 'incident_escalation_lifecycle_stage_unique',
        values: {
          incidentId: failedIncidentId,
          lifecycleId: unchangedIncident?.body.escalationLifecycleId as string,
          stage: 'team_requested',
        },
      })).toHaveLength(0);
      expect(await harness.store.workflowProjectionReader.query({
        kind: 'unique', table: 'semantic_effects', constraint: 'semantic_effects_key_unique',
        values: { semanticKey: failedAction.targets[0].semanticKey },
      })).toHaveLength(0);
    });
  });

  it('deduplicates branch-review repeats while pinning the configured closed case evidence', async () => {
    await withHarness(async (harness) => {
      const caseId = await harness.addCase(harness.branchAId, harness.ownerIdentityId, 'branch-review-success');
      const payload: BranchReviewPayload = {
        kind: 'branch_review_assign',
        businessDate: BUSINESS_DATE,
        targets: [{
          ownerIdentityId: harness.ownerIdentityId,
          reason: 'Review the synthetic branch variance.',
          dueDate: taskDueDate('high'),
          priority: 'high',
          branchId: harness.branchAId,
          caseId,
        }],
      };
      const prepared = await prepare(harness, payload, 'branch-review-success');
      expect(prepared.outcome).toBe('pending');
      const action = prepared.pendingAction!;
      await expectCaseEvidencePinned(harness, action, caseId, harness.branchAId,
        BUSINESS_DATE, [inventorySourceId(harness.branchAId)]);
      const result = await confirm(harness, action);
      expect(result.error).toBeNull();
      expect(result.receipt?.outcome).toBe('verified_success');
      const assignment = await harness.store.workflowProjectionReader.get<EffectRow>(
        action.targets[0].expectedEffectRef.table,
        action.targets[0].expectedEffectRef.id,
      );
      expect(assignment?.body).toMatchObject({
        id: action.targets[0].expectedEffectRef.id,
        rowVersion: 1,
        branchId: harness.branchAId,
        caseId,
        ownerIdentityId: harness.ownerIdentityId,
        status: 'open',
        reason: payload.targets[0].reason,
        dueDate: payload.targets[0].dueDate,
        priority: payload.targets[0].priority,
        executionId: result.receipt?.id,
      });

      const repeated = await prepare(harness, {
        ...payload,
        targets: [{ ...payload.targets[0], reason: 'Different words for the same branch review.' }],
      }, 'branch-review-semantic-repeat');
      expect(repeated.outcome).toBe('already_completed');
      expect(repeated.existingExecutionId).toBe(result.receipt?.id);
      expect(repeated.pendingAction).toBeNull();

      const assignmentRows = await rowsForCase<EffectRow>(
        harness, 'branch_review_assignments', harness.branchAId, caseId,
      );
      expect(assignmentRows).toHaveLength(1);
      expect(assignmentRows[0]).toMatchObject({ id: action.targets[0].expectedEffectRef.id });

      const semanticEffects = await harness.store.workflowProjectionReader.query<{
        semanticKey: string;
        executionId: string;
        effectType: string;
        effectId: string;
        status: string;
      }>({
        kind: 'unique',
        table: 'semantic_effects',
        constraint: 'semantic_effects_key_unique',
        values: { semanticKey: action.targets[0].semanticKey },
      });
      expect(semanticEffects).toHaveLength(1);
      expect(semanticEffects[0]).toMatchObject({
        id: `semantic_${action.targets[0].semanticKey}`,
        body: {
          semanticKey: action.targets[0].semanticKey,
          executionId: result.receipt?.id,
          effectType: 'branch_review_assignments',
          effectId: action.targets[0].expectedEffectRef.id,
          status: 'committed',
        },
      });

      const roots = await harness.store.workflowProjectionReader.query<{ activeExecutionId: string }>({
        kind: 'unique',
        table: 'action_idempotency_roots',
        constraint: 'action_idempotency_roots_key_unique',
        values: { idempotencyKey: action.idempotencyKey },
      });
      expect(roots).toHaveLength(1);
      expect(roots[0].body.activeExecutionId).toBe(result.receipt?.id);
      const receipts = await harness.store.workflowProjectionReader.query<{ outcome: string; actionId: string }>({
        kind: 'unique',
        table: 'action_executions',
        constraint: 'action_executions_root_attempt_unique',
        values: { rootId: roots[0].id, attempt: 1 },
      });
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({
        id: result.receipt?.id,
        body: { outcome: 'verified_success', actionId: action.id },
      });
    });
  });

  it('resolves an unlinked branch from the scoped actor grant across all four bindings and readback', async () => {
    await withHarness(async (harness) => {
      const investigationCaseId = await harness.addCase(harness.branchAId, harness.ownerIdentityId, 'unlinked-investigation');
      const payloads: WorkflowPayloadV2[] = [
        {
          kind: 'investigation_create',
          businessDate: BUSINESS_DATE,
          targets: [{
            ownerIdentityId: harness.ownerIdentityId,
            reason: 'Review the unlinked branch stock discrepancy.',
            dueDate: taskDueDate('normal'),
            priority: 'normal',
            branchId: harness.branchAId,
            caseId: investigationCaseId,
            sourceIds: [inventorySourceId(harness.branchAId)],
            unansweredQuestion: 'Which movement explains the reviewed variance?',
          }],
        },
        {
          kind: 'restock_create',
          targets: [{
            branchId: harness.branchAId,
            productId: harness.productAId,
            inventorySnapshotId: harness.latestInventoryId,
            quantity: 37,
            ownerIdentityId: harness.ownerIdentityId,
            reason: 'Replenish from the latest unlinked-branch snapshot.',
            dueDate: taskDueDate('high'),
            priority: 'high',
          }],
        },
        {
          kind: 'incident_escalate',
          targets: [{
            incidentId: harness.incidentId,
            targetTeamId: 'demo_operations',
            evidenceIds: [inventorySourceId(harness.branchAId)],
            reason: 'Escalate the unlinked branch incident to operations.',
          }],
        },
        {
          kind: 'branch_review_assign',
          businessDate: BUSINESS_DATE,
          targets: [{
            ownerIdentityId: harness.ownerIdentityId,
            reason: 'Review the unlinked branch variance.',
            dueDate: taskDueDate('high'),
            priority: 'high',
            branchId: harness.branchAId,
            caseId: investigationCaseId,
          }],
        },
      ];

      const branch = await harness.store.workflowProjectionReader.get<{ orgUnitId: string | null }>('branches', harness.branchAId);
      expect(branch?.body.orgUnitId).toBeNull();

      for (const [index, payload] of payloads.entries()) {
        const prepared = await prepare(harness, payload, `unlinked-${index}-${payload.kind}`);
        expect(prepared.outcome).toBe('pending');
        const action = prepared.pendingAction!;
        const target = action.targets[0];
        await expectActorAuthorityPinned(harness, action, harness.branchAId,
          harness.orgUnitId, harness.actorResponsibilityId);
        if (payload.kind === 'investigation_create') {
          await expectCaseEvidencePinned(harness, action, investigationCaseId, harness.branchAId,
            BUSINESS_DATE, payload.targets[0].sourceIds);
        } else if (payload.kind === 'branch_review_assign') {
          await expectCaseEvidencePinned(harness, action, investigationCaseId, harness.branchAId,
            BUSINESS_DATE, [inventorySourceId(harness.branchAId)]);
        }

        const result = await confirm(harness, action);
        expect(result.error).toBeNull();
        expect(result.receipt?.outcome).toBe('verified_success');
        expect(result.receipt?.proofs).toContainEqual(expect.objectContaining({
          ref: target.expectedEffectRef,
          outcome: 'verified_success',
        }));
        const effect = await harness.store.workflowProjectionReader.get<EffectRow>(
          target.expectedEffectRef.table,
          target.expectedEffectRef.id,
        );
        expect(effect).toMatchObject({
          id: target.expectedEffectRef.id,
          body: { id: target.expectedEffectRef.id, executionId: result.receipt?.id },
        });
      }
    }, { branchAOrg: 'unlinked' });
  });

  it.each([
    {
      label: 'missing',
      setup: { branchAOrg: 'unlinked' as const, actorGrants: [{ org: 'primary' as const, branches: ['b'] as const }] },
    },
    {
      label: 'ambiguous',
      setup: {
        branchAOrg: 'unlinked' as const,
        actorGrants: [
          { org: 'primary' as const, branches: ['a', 'b'] as const },
          { org: 'alternate' as const, branches: ['a'] as const },
        ],
      },
    },
  ])('denies an unlinked branch with a $label actor grant without creating an action', async ({ setup }) => {
    await withHarness(async (harness) => {
      const caseId = await harness.addCase(harness.branchAId, harness.ownerIdentityId, `grant-${setup.actorGrants.length}`);
      const payload: InvestigationPayload = {
        kind: 'investigation_create',
        businessDate: BUSINESS_DATE,
        targets: [{
          ownerIdentityId: harness.ownerIdentityId,
          reason: 'Confirm the actor grant before preparing this investigation.',
          dueDate: taskDueDate('normal'),
          priority: 'normal',
          branchId: harness.branchAId,
          caseId,
          sourceIds: [inventorySourceId(harness.branchAId)],
          unansweredQuestion: 'Which source movement changed the count?',
        }],
      };

      const prepared = await prepare(harness, payload, `unlinked-grant-${setup.actorGrants.length}`);
      expect(prepared.outcome).toBe('denied');
      expect(prepared.pendingAction).toBeNull();
      expect(await rowsForCase(harness, 'investigation_tasks', harness.branchAId, caseId)).toHaveLength(0);
      expect(await harness.store.workflowProjectionReader.query<PendingActionV2>({
        kind: 'scoped', table: 'pending_actions', equals: { actorId: harness.profileId }, limit: 20,
      })).toHaveLength(0);
    }, setup);
  });

  it.each([
    {
      label: 'explicit branch organization mismatch',
      setup: {
        branchAOrg: 'alternate' as const,
        actorGrants: [{ org: 'primary' as const, branches: ['a', 'b'] as const }],
      },
    },
    {
      label: 'inactive linked organization',
      setup: {
        branchAOrg: 'alternate' as const,
        actorGrants: [
          { org: 'primary' as const, branches: ['b'] as const },
          { org: 'alternate' as const, branches: ['a'] as const },
        ],
        alternateOrgActive: false,
      },
    },
  ])('fails closed for an $label', async ({ setup }) => {
    await withHarness(async (harness) => {
      const caseId = await harness.addCase(harness.branchAId, harness.ownerIdentityId, `org-denial-${setup.actorGrants.length}`);
      const payload: InvestigationPayload = {
        kind: 'investigation_create',
        businessDate: BUSINESS_DATE,
        targets: [{
          ownerIdentityId: harness.ownerIdentityId,
          reason: 'Use only the explicitly authorized active branch organization.',
          dueDate: taskDueDate('normal'),
          priority: 'normal',
          branchId: harness.branchAId,
          caseId,
          sourceIds: [inventorySourceId(harness.branchAId)],
          unansweredQuestion: 'Which current source explains this variance?',
        }],
      };

      const prepared = await prepare(harness, payload, `org-denial-${setup.actorGrants.length}`);
      expect(prepared.outcome).toBe('denied');
      expect(prepared.pendingAction).toBeNull();
      expect(await rowsForCase(harness, 'investigation_tasks', harness.branchAId, caseId)).toHaveLength(0);
    }, setup);
  });

  it('marks an unlinked-branch action stale when the actor responsibility changes after prepare', async () => {
    await withHarness(async (harness) => {
      const caseId = await harness.addCase(harness.branchAId, harness.ownerIdentityId, 'unlinked-actor-responsibility-stale');
      const payload: InvestigationPayload = {
        kind: 'investigation_create',
        businessDate: BUSINESS_DATE,
        targets: [{
          ownerIdentityId: harness.ownerIdentityId,
          reason: 'Review the branch under the current actor grant.',
          dueDate: taskDueDate('high'),
          priority: 'high',
          branchId: harness.branchAId,
          caseId,
          sourceIds: [inventorySourceId(harness.branchAId)],
          unansweredQuestion: 'Which movement changed the reviewed count?',
        }],
      };
      const prepared = await prepare(harness, payload, 'unlinked-actor-responsibility-stale');
      expect(prepared.outcome).toBe('pending');
      const action = prepared.pendingAction!;
      await expectActorAuthorityPinned(harness, action, harness.branchAId,
        harness.orgUnitId, harness.actorResponsibilityId);

      await updateResponsibility(harness, harness.actorResponsibilityId, { branchIds: [harness.branchAId] });
      const result = await confirm(harness, action);
      expect(result.receipt).toBeNull();
      expect(result.error).toMatchObject({ outcome: 'stale', domainEffect: 'none', retryBusinessWrite: false });
      expect(await harness.store.workflowProjectionReader.get('investigation_tasks', action.targets[0].expectedEffectRef.id))
        .toBeUndefined();
      expect(await harness.store.workflowProjectionReader.query({
        kind: 'unique', table: 'semantic_effects', constraint: 'semantic_effects_key_unique',
        values: { semanticKey: action.targets[0].semanticKey },
      })).toHaveLength(0);
    }, { branchAOrg: 'unlinked' });
  });

  it('denies confirmation without effects when an unlinked-branch actor grant is revoked after prepare', async () => {
    await withHarness(async (harness) => {
      const caseId = await harness.addCase(harness.branchAId, harness.ownerIdentityId, 'unlinked-actor-grant-revoked');
      const payload: InvestigationPayload = {
        kind: 'investigation_create',
        businessDate: BUSINESS_DATE,
        targets: [{
          ownerIdentityId: harness.ownerIdentityId,
          reason: 'Review this branch only while the actor grant is active.',
          dueDate: taskDueDate('normal'),
          priority: 'normal',
          branchId: harness.branchAId,
          caseId,
          sourceIds: [inventorySourceId(harness.branchAId)],
          unansweredQuestion: 'Which source movement changed the count?',
        }],
      };
      const prepared = await prepare(harness, payload, 'unlinked-actor-grant-revoked');
      expect(prepared.outcome).toBe('pending');
      const action = prepared.pendingAction!;
      await expectActorAuthorityPinned(harness, action, harness.branchAId,
        harness.orgUnitId, harness.actorResponsibilityId);

      await updateResponsibility(harness, harness.actorResponsibilityId, { active: false });
      const result = await confirm(harness, action);
      expect(result.receipt).toBeNull();
      expect(result.error).toMatchObject({ outcome: 'denied', domainEffect: 'none', retryBusinessWrite: false });
      expect(await harness.store.workflowProjectionReader.get('investigation_tasks', action.targets[0].expectedEffectRef.id))
        .toBeUndefined();
      expect(await harness.store.workflowProjectionReader.query({
        kind: 'unique', table: 'semantic_effects', constraint: 'semantic_effects_key_unique',
        values: { semanticKey: action.targets[0].semanticKey },
      })).toHaveLength(0);
    }, { branchAOrg: 'unlinked' });
  });

  it('does not disclose a verified receipt on readback after an unlinked-branch actor grant is revoked', async () => {
    await withHarness(async (harness) => {
      const caseId = await harness.addCase(harness.branchAId, harness.ownerIdentityId, 'unlinked-readback-revoked');
      const payload: InvestigationPayload = {
        kind: 'investigation_create',
        businessDate: BUSINESS_DATE,
        targets: [{
          ownerIdentityId: harness.ownerIdentityId,
          reason: 'Create a reviewed task before revoking actor readback scope.',
          dueDate: taskDueDate('normal'),
          priority: 'normal',
          branchId: harness.branchAId,
          caseId,
          sourceIds: [inventorySourceId(harness.branchAId)],
          unansweredQuestion: 'Which movement explains this current variance?',
        }],
      };
      const prepared = await prepare(harness, payload, 'unlinked-readback-revoked');
      expect(prepared.outcome).toBe('pending');
      const action = prepared.pendingAction!;
      await expectActorAuthorityPinned(harness, action, harness.branchAId,
        harness.orgUnitId, harness.actorResponsibilityId);

      const confirmed = await confirm(harness, action);
      expect(confirmed.error).toBeNull();
      expect(confirmed.receipt?.outcome).toBe('verified_success');
      const executionId = confirmed.receipt!.id;
      expect(await harness.store.workflowProjectionReader.get('investigation_tasks', action.targets[0].expectedEffectRef.id))
        .toMatchObject({ body: { executionId } });

      await updateResponsibility(harness, harness.actorResponsibilityId, { active: false });
      const readback = await harness.runner.reconcile(harness.sessionId, executionId,
        `ops-readback-${harness.suffix}`, operationContextFor(action));
      expect(readback.receipt).toBeNull();
      expect(readback.error).toMatchObject({ outcome: 'denied', operationPhase: 'readback', retryBusinessWrite: false });
      expect(await harness.store.workflowProjectionReader.get<{ outcome: string }>('action_executions', executionId))
        .toMatchObject({ body: { outcome: 'verified_success' } });
    }, { branchAOrg: 'unlinked' });
  });

  it.each([
    { kind: 'investigation' as const, label: 'today', payloadDate: CURRENT_BANGKOK_DATE, configuredDate: BUSINESS_DATE },
    { kind: 'branch_review' as const, label: 'today', payloadDate: CURRENT_BANGKOK_DATE, configuredDate: BUSINESS_DATE },
    {
      kind: 'investigation' as const,
      label: 'future',
      payloadDate: addBangkokCalendarDays(CURRENT_BANGKOK_DATE, 1),
      configuredDate: BUSINESS_DATE,
    },
    {
      kind: 'branch_review' as const,
      label: 'future',
      payloadDate: addBangkokCalendarDays(CURRENT_BANGKOK_DATE, 1),
      configuredDate: BUSINESS_DATE,
    },
    {
      kind: 'investigation' as const,
      label: 'different from the configured date',
      payloadDate: BUSINESS_DATE,
      configuredDate: addBangkokCalendarDays(BUSINESS_DATE, -1),
    },
    {
      kind: 'branch_review' as const,
      label: 'different from the configured date',
      payloadDate: BUSINESS_DATE,
      configuredDate: addBangkokCalendarDays(BUSINESS_DATE, -1),
    },
  ])('rejects $kind work for a $label reporting date', async ({ kind, payloadDate, configuredDate }) => {
    await withHarness(async (harness) => {
      const sourceIds = [inventorySourceIdForDate(harness.branchAId, payloadDate)];
      const caseId = await harness.addCase(harness.branchAId, harness.ownerIdentityId,
        `date-${kind}-${payloadDate}`, { businessDate: payloadDate, sourceIds });
      const payload: WorkflowPayloadV2 = kind === 'investigation'
        ? {
            kind: 'investigation_create',
            businessDate: payloadDate,
            targets: [{
              ownerIdentityId: harness.ownerIdentityId,
              reason: 'Investigate only the configured closed reporting period.',
              dueDate: taskDueDate('normal'),
              priority: 'normal',
              branchId: harness.branchAId,
              caseId,
              sourceIds,
              unansweredQuestion: 'Which reviewed source explains the variance?',
            }],
          }
        : {
            kind: 'branch_review_assign',
            businessDate: payloadDate,
            targets: [{
              ownerIdentityId: harness.ownerIdentityId,
              reason: 'Review only the configured closed reporting period.',
              dueDate: taskDueDate('normal'),
              priority: 'normal',
              branchId: harness.branchAId,
              caseId,
            }],
          };

      const prepared = await prepare(harness, payload, `reject-date-${kind}-${payloadDate}`);
      expect(prepared.outcome).toBe('stale');
      expect(prepared.pendingAction).toBeNull();
      expect(await harness.store.workflowProjectionReader.query<PendingActionV2>({
        kind: 'scoped', table: 'pending_actions', equals: { actorId: harness.profileId }, limit: 20,
      })).toHaveLength(0);
      expect(await rowsForCase(harness,
        kind === 'investigation' ? 'investigation_tasks' : 'branch_review_assignments',
        harness.branchAId, caseId)).toHaveLength(0);
    }, { businessDate: configuredDate });
  });

  it.each(['investigation', 'branch_review'] as const)(
    'rejects a future-dated evidence source for %s work',
    async (kind) => {
      await withHarness(async (harness) => {
        const caseId = await harness.addCase(harness.branchAId, harness.ownerIdentityId, `future-source-${kind}`);
        const futureObservedAt = new Date(NOW.getTime() + 60_000).toISOString();
        await updateInventory(harness, harness.latestInventoryId, {
          observedAt: futureObservedAt,
          updatedAt: futureObservedAt,
        });
        const sourceIds = [inventorySourceId(harness.branchAId)];
        const payload: WorkflowPayloadV2 = kind === 'investigation'
          ? {
              kind: 'investigation_create',
              businessDate: BUSINESS_DATE,
              targets: [{
                ownerIdentityId: harness.ownerIdentityId,
                reason: 'Reject evidence observed after the wall clock.',
                dueDate: taskDueDate('normal'),
                priority: 'normal',
                branchId: harness.branchAId,
                caseId,
                sourceIds,
                unansweredQuestion: 'Which current source explains this variance?',
              }],
            }
          : {
              kind: 'branch_review_assign',
              businessDate: BUSINESS_DATE,
              targets: [{
                ownerIdentityId: harness.ownerIdentityId,
                reason: 'Reject evidence observed after the wall clock.',
                dueDate: taskDueDate('normal'),
                priority: 'normal',
                branchId: harness.branchAId,
                caseId,
              }],
            };

        expect(Date.parse(futureObservedAt)).toBeGreaterThan(NOW.getTime());
        const prepared = await prepare(harness, payload, `future-source-${kind}`);
        expect(prepared.outcome).toBe('stale');
        expect(prepared.pendingAction).toBeNull();
        expect(await rowsForCase(harness,
          kind === 'investigation' ? 'investigation_tasks' : 'branch_review_assignments',
          harness.branchAId, caseId)).toHaveLength(0);
      });
    },
  );

  it('requires persisted branch-review sources and stales when the case source set changes after prepare', async () => {
    await withHarness(async (harness) => {
      const caseId = await harness.addCase(harness.branchAId, harness.ownerIdentityId,
        'branch-review-case-sources', { omitSourceIds: true });
      const payload: BranchReviewPayload = {
        kind: 'branch_review_assign',
        businessDate: BUSINESS_DATE,
        targets: [{
          ownerIdentityId: harness.ownerIdentityId,
          reason: 'Review only the source references persisted on the case.',
          dueDate: taskDueDate('normal'),
          priority: 'normal',
          branchId: harness.branchAId,
          caseId,
        }],
      };
      const missingSources = await prepare(harness, payload, 'branch-review-missing-case-sources');
      expect(missingSources.outcome).toBe('stale');
      expect(missingSources.pendingAction).toBeNull();

      const sourceIds = [inventorySourceId(harness.branchAId)];
      await replaceCaseSourceIds(harness, caseId, sourceIds);
      const prepared = await prepare(harness, payload, 'branch-review-case-source-change');
      expect(prepared.outcome).toBe('pending');
      const action = prepared.pendingAction!;
      await expectCaseEvidencePinned(harness, action, caseId, harness.branchAId, BUSINESS_DATE, sourceIds);

      await replaceCaseSourceIds(harness, caseId, []);
      const result = await confirm(harness, action);
      expect(result.receipt).toBeNull();
      expect(result.error).toMatchObject({ outcome: 'stale', domainEffect: 'none', retryBusinessWrite: false });
      expect(await harness.store.workflowProjectionReader.get('branch_review_assignments', action.targets[0].expectedEffectRef.id))
        .toBeUndefined();
    });
  });

  it('freezes branch-review evidence rows and rejects a changed source before confirmation', async () => {
    await withHarness(async (harness) => {
      const caseId = await harness.addCase(harness.branchAId, harness.ownerIdentityId, 'branch-review-evidence-cas');
      const sourceIds = [inventorySourceId(harness.branchAId)];
      const prepared = await prepare(harness, {
        kind: 'branch_review_assign',
        businessDate: BUSINESS_DATE,
        targets: [{
          ownerIdentityId: harness.ownerIdentityId,
          reason: 'Review the pinned source snapshot.',
          dueDate: taskDueDate('high'),
          priority: 'high',
          branchId: harness.branchAId,
          caseId,
        }],
      }, 'branch-review-evidence-cas');
      expect(prepared.outcome).toBe('pending');
      const action = prepared.pendingAction!;
      await expectCaseEvidencePinned(harness, action, caseId, harness.branchAId, BUSINESS_DATE, sourceIds);

      await updateInventory(harness, harness.latestInventoryId, { onHand: 4 });
      const result = await confirm(harness, action);
      expect(result.receipt).toBeNull();
      expect(result.error).toMatchObject({ outcome: 'stale', domainEffect: 'none', retryBusinessWrite: false });
      expect(await harness.store.workflowProjectionReader.get('branch_review_assignments', action.targets[0].expectedEffectRef.id))
        .toBeUndefined();
    });
  });

  itSqliteBound('keeps branch-review readback pending when the backing evidence changes with the effect transaction', async () => {
    await withHarness(async (harness) => {
      const caseId = await harness.addCase(harness.branchAId, harness.ownerIdentityId, 'branch-review-evidence-readback');
      const sourceIds = [inventorySourceId(harness.branchAId)];
      const prepared = await prepare(harness, {
        kind: 'branch_review_assign',
        businessDate: BUSINESS_DATE,
        targets: [{
          ownerIdentityId: harness.ownerIdentityId,
          reason: 'Read back the exact evidence used for branch review.',
          dueDate: taskDueDate('normal'),
          priority: 'normal',
          branchId: harness.branchAId,
          caseId,
        }],
      }, 'branch-review-evidence-readback');
      expect(prepared.outcome).toBe('pending');
      const action = prepared.pendingAction!;
      const target = action.targets[0];
      await expectCaseEvidencePinned(harness, action, caseId, harness.branchAId, BUSINESS_DATE, sourceIds);
      const triggerName = `change_review_evidence_${harness.suffix}`;
      createFixtureTrigger(harness, triggerName,
        `AFTER INSERT ON branch_review_assignments WHEN NEW.id = ${sqlQuote(target.expectedEffectRef.id)} ` +
        `BEGIN UPDATE inventory_snapshots ` +
        `SET payload=json_set(payload, '$.onHand', on_hand + 1), row_version=row_version + 1, on_hand=on_hand + 1 ` +
        `WHERE id=${sqlQuote(harness.latestInventoryId)}; END`);

      const result = await confirm(harness, action);
      expect(result.error).toBeNull();
      expect(result.receipt?.outcome).toBe('pending');
      expect(result.receipt?.proofs.every(proof => proof.outcome !== 'verified_success')).toBe(true);
      const assignment = await harness.store.workflowProjectionReader.get<EffectRow>(
        target.expectedEffectRef.table, target.expectedEffectRef.id,
      );
      expect(assignment).toMatchObject({ body: { executionId: result.receipt?.id, status: 'open' } });
      expect(await harness.store.workflowProjectionReader.get<{ outcome: string }>('action_executions', result.receipt!.id))
        .toMatchObject({ body: { outcome: 'pending' } });
    });
  });
});
