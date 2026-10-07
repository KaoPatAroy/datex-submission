import { describe, expect, it } from 'vitest';
import { digest } from '../lib/core/utils';
import { ConciergeService } from '../lib/core/service';
import type { Actor, Badge } from '../lib/contracts';
import { createSeedData } from '../lib/seed/generate';
import {
  persistWorkflowV2SeedPlan,
  prepareWorkflowV2SeedPlan,
  type WorkflowV2ManagerAdvanceRequest,
  type WorkflowV2SeedPlan,
  type WorkflowV2SeedServerOptions,
} from '../lib/seed/workflow-v2';
import { localPsql } from '../scripts/local-supabase';
import { pgTestsEnabled } from './helpers/local-pg';
import { createWorkflowSqliteFixture } from './helpers/workflow-storage';
import { createHrApprovalWorkflowBindings } from '../lib/packs/hr-approval-workflows';
import { createWorkflowActionRunner } from '../lib/workflows/action-runner';
import { createWorkflowActionRuntime } from '../lib/workflows/action-runtime';
import { createOnboardingQueryService } from '../lib/workflows/onboarding-queries';
import { demoWorkflowPolicyV1 } from '../lib/workflows/policy';
import type { OnboardingRequest, WorkflowReceiptV2 } from '../lib/workflows/contracts';
import type { WorkflowTransactionContext } from '../lib/storage/workflow-projections';

const BUSINESS_DATE = '2026-10-04';
const SEED = 1;

function preparePlan(seed = SEED, businessDate = BUSINESS_DATE): WorkflowV2SeedPlan {
  return prepareWorkflowV2SeedPlan(createSeedData(businessDate, seed), { seed, businessDate });
}

type PlannedBody = Record<string, unknown> & { id: string };

function plannedBodies(plan: WorkflowV2SeedPlan, table: string): PlannedBody[] {
  return plan.phases.flatMap(phase => phase.rows
    .filter(row => row.table === table)
    .map(row => row.body as PlannedBody));
}

function expectedInvestigationSources(plan: WorkflowV2SeedPlan, branchId: string): string[] {
  const date = plan.businessDate;
  const openIncidents = plan.seedData.incidents.filter(incident =>
    incident.branchId === branchId && incident.date === date && incident.status === 'open');
  const belowMinimumInventory = plan.seedData.inventory_snapshots.filter(inventory =>
    inventory.branchId === branchId && inventory.date === date && inventory.onHand < inventory.minimum);
  const paidSalesSatang = plan.seedData.sales_orders
    .filter(order => order.branchId === branchId && order.date === date && order.status === 'paid')
    .reduce((total, order) => total + order.amountSatang, 0);
  const target = plan.seedData.sales_targets.find(row => row.branchId === branchId && row.date === date);
  if (!target) throw new Error(`Expected canonical sales target for ${branchId}/${date}`);
  const belowSalesTarget = paidSalesSatang < target.amountSatang;
  return [
    ...(openIncidents.length > 0 ? [`incidents:${branchId}:${date}`] : []),
    ...(belowMinimumInventory.length > 0 ? [`inventory:${branchId}:${date}`] : []),
    ...(belowSalesTarget ? [`sales:${branchId}:${date}`, `targets:${branchId}:${date}`] : []),
  ].sort();
}

function expectedInvestigationId(plan: WorkflowV2SeedPlan, branchId: string): string {
  return `demo-v${plan.seedVersion}:${digest({
    namespace: 'biztania.workflow-v2.synthetic-seed',
    seed: plan.seed,
    seedVersion: plan.seedVersion,
    entity: `v2-operations-investigation-case:${branchId}`,
    ordinal: 0,
  }).slice(0, 32)}`;
}

async function seedBeginMarkerCount(fixture: Awaited<ReturnType<typeof createWorkflowSqliteFixture>>): Promise<number> {
  const rows = await fixture.store.workflowProjectionReader.query<{ category: string }>({
    kind: 'scoped',
    table: 'audit_events',
    equals: { category: 'synthetic_workflow_v2_seed_begin' },
    limit: 10,
  });
  return rows.length;
}

describe('workflow V2 synthetic seed plan', () => {
  it('preserves a confirmed legacy badge revocation across a native SQLite reopen and seed re-initialization', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const plan = preparePlan();
      expect(await persistWorkflowV2SeedPlan({ store: fixture.store }, plan)).toMatchObject({ state: 'source_ready' });
      const profile = plan.seedData.profiles.find(row => row.id === 'hr')!;
      const actor: Actor = { ...profile, sessionId: 'cluster-f-sqlite-hr', mode: 'scripted_demo', modeRevision: 1 };
      await fixture.store.transaction(async tx => {
        await tx.put('sessions', { id: actor.sessionId, profileId: actor.id, mode: actor.mode, modeRevision: 1, csrfToken: 'synthetic-csrf', expiresAt: '2099-01-01T00:00:00.000Z' });
      });
      const badge = plan.seedData.mock_badges.find(row => row.state === 'active' && plan.seedData.employees.some(employee => employee.id === row.employeeId && employee.active))!;
      const service = new ConciergeService(fixture.store, { businessDate: BUSINESS_DATE, now: () => new Date('2026-10-07T05:00:00.000Z') });
      const pending = await service.prepare(actor, { kind: 'badge_revoke', employeeId: badge.employeeId, badgeId: badge.id, reason: 'Synthetic acceptance revocation' });
      expect((await service.confirm(actor, pending.id)).status).toBe('verified_success');
      const reopened = fixture.reopen();
      const revoked = await reopened.workflowProjectionReader.get<Badge>('mock_badges', badge.id);
      expect(revoked).toMatchObject({ rowVersion: 2, body: { state: 'revoked', version: badge.version + 1 } });
      expect(revoked?.body).not.toHaveProperty('rowVersion');
      expect(await persistWorkflowV2SeedPlan({ store: reopened }, plan)).toMatchObject({ state: 'source_ready', bootstrapReady: true });
      expect(await reopened.get('mock_badges', badge.id)).toEqual(revoked?.body);
    } finally { await fixture.dispose(); }
  });

  it('builds a deterministic plan from the canonical synthetic Thai retail fixture', () => {
    const first = preparePlan();
    const repeated = preparePlan();

    expect(first).toMatchObject({ seed: SEED, seedVersion: 2, businessDate: BUSINESS_DATE });
    expect(first.inputDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.inputDigest).toBe(repeated.inputDigest);
    expect(first.sourceDigest).toBe(repeated.sourceDigest);
    expect(first.phases.map(({ phase, rows }) => [phase, rows.length]))
      .toEqual(repeated.phases.map(({ phase, rows }) => [phase, rows.length]));
    expect(first.inputDigest).not.toBe(preparePlan(SEED + 1).inputDigest);

    expect(first.seedData.branches).toHaveLength(12);
    expect(new Set(first.seedData.branches.map(branch => branch.region))).toEqual(new Set(['east', 'central', 'south']));
    expect(first.seedData.branches.find(branch => branch.region === 'east')?.name).toBe('Demo East Branch 1');
    expect(first.seedData.products).toHaveLength(40);
    expect(first.seedData.products[0].name).toBe('Demo Jasmine Rice 5kg');
    expect(first.seedData.sales_orders).toHaveLength(10_000);
    expect(first.seedData.inventory_snapshots).toHaveLength(14_400);
    expect(first.seedData.employees).toHaveLength(80);
    expect(first.createdAt).toBe('2026-10-04T12:00:00+07:00');
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.phases[0].rows[0].body)).toBe(true);
  });

  it('plans stable evidence-backed open investigation cases and keeps East operations authority separate from HR', () => {
    const plan = preparePlan(1, BUSINESS_DATE);
    const repeated = preparePlan(1, BUSINESS_DATE);
    const cases = plannedBodies(plan, 'investigation_cases');
    const repeatedCases = plannedBodies(repeated, 'investigation_cases');
    const branchById = new Map(plan.seedData.branches.map(branch => [branch.id, branch]));

    expect(cases).toHaveLength(9);
    expect(new Set(cases.map(row => row.branchId)).size).toBe(9);
    expect(cases.map(row => ({ branchId: row.branchId, id: row.id })).sort((a, b) =>
      String(a.branchId).localeCompare(String(b.branchId))
    )).toEqual(repeatedCases.map(row => ({ branchId: row.branchId, id: row.id })).sort((a, b) =>
      String(a.branchId).localeCompare(String(b.branchId))
    ));

    const candidatesByRegion = cases.reduce<Record<string, number>>((counts, row) => {
      const branch = branchById.get(String(row.branchId));
      if (!branch) throw new Error(`Investigation seed row references an unseeded branch: ${String(row.branchId)}`);
      counts[branch.region] = (counts[branch.region] ?? 0) + 1;
      return counts;
    }, {});
    expect(candidatesByRegion).toEqual({ east: 4, central: 3, south: 2 });

    for (const candidate of cases) {
      const branchId = String(candidate.branchId);
      const branch = branchById.get(branchId)!;
      expect(candidate).toMatchObject({
        id: expectedInvestigationId(plan, branchId),
        ownerIdentityId: plan.identities.salesIdentityId,
        branchId,
        businessDate: BUSINESS_DATE,
        status: 'open',
      });
      expect(candidate.sourceIds).toEqual(expectedInvestigationSources(plan, branchId));
      expect(candidate.unansweredQuestion).toContain(branch.name);
      expect(Object.hasOwn(candidate, 'createdAt')).toBe(false);
      expect(Object.hasOwn(candidate, 'updatedAt')).toBe(false);
    }
    expect(plannedBodies(plan, 'investigation_tasks')).toEqual([]);
    expect(plannedBodies(plan, 'branch_review_assignments')).toEqual([]);

    const operationsPermissions = ['ticket.create', 'restock.create', 'incident.escalate', 'branch.review.assign'];
    expect(plan.identities.salesProfile.role).toBe('executive');
    expect(plan.identities.salesProfile.permissions).toEqual(expect.arrayContaining([
      'sales.read', 'operations.read', ...operationsPermissions,
    ]));
    expect(plan.identities.eastOperationsProfile).toMatchObject({
      role: 'east_manager',
      active: true,
      regions: ['east'],
    });
    expect([...plan.identities.eastOperationsProfile.permissions].sort()).toEqual([
      'sales.read', 'operations.read', ...operationsPermissions,
    ].sort());
    expect(plan.identities.eastOperationsProfile.id).not.toBe(plan.identities.managerProfile.id);
    expect(plan.identities.eastOperationsIdentityId).not.toBe(plan.identities.managerIdentityId);

    const identities = plannedBodies(plan, 'directory_identities');
    const operationsIdentity = identities.find(row => row.id === plan.identities.eastOperationsIdentityId);
    expect(operationsIdentity).toMatchObject({
      profileId: plan.identities.eastOperationsProfile.id,
      role: 'east_manager',
      department: 'sales_operations',
      orgUnitId: plan.identities.salesOrgUnitId,
      active: true,
    });
    const responsibilities = plannedBodies(plan, 'responsibilities');
    const operationsResponsibilities = responsibilities.filter(row => row.identityId === plan.identities.eastOperationsIdentityId);
    const eastBranchIds = plan.seedData.branches.filter(branch => branch.region === 'east').map(branch => branch.id).sort();
    expect(operationsResponsibilities).toHaveLength(1);
    expect(operationsResponsibilities[0]).toMatchObject({
      purpose: 'sales_operations',
      orgUnitId: plan.identities.salesOrgUnitId,
      branchIds: eastBranchIds,
      active: true,
    });

    expect(plan.identities.managerProfile).toMatchObject({
      role: 'east_manager',
      regions: ['east'],
      permissions: ['hr.onboarding.manager_read', 'hr.onboarding.manager_approve'],
    });
    expect(plan.identities.directorProfile).toMatchObject({
      id: 'director',
      role: 'hr_director',
      regions: ['east'],
      permissions: ['hr.onboarding.director_read', 'hr.onboarding.director_approve', 'hr.onboarding.return'],
    });
    expect(identities.find(row => row.id === plan.identities.managerIdentityId)).toMatchObject({
      department: 'hr', role: 'east_manager', orgUnitId: plan.identities.hrOrgUnitId,
    });
    expect(identities.find(row => row.id === plan.identities.directorIdentityId)).toMatchObject({
      department: 'hr', role: 'hr_director', orgUnitId: plan.identities.hrOrgUnitId,
    });
    expect(responsibilities.find(row => row.identityId === plan.identities.managerIdentityId)?.purpose).toBe('manager_onboarding');
    expect(responsibilities.find(row => row.identityId === plan.identities.directorIdentityId)?.purpose).toBe('director_onboarding');
  });

  it('rejects a tampered canonical plan and legacy conflict before writing a seed marker', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const plan = preparePlan();
      const tampered = structuredClone(plan);
      tampered.phases[0].rows[0].body.name = 'Edited after canonical planning';

      await expect(persistWorkflowV2SeedPlan({ store: fixture.store }, tampered))
        .rejects.toMatchObject({ code: 'WORKFLOW_CONFLICT' });
      expect(await seedBeginMarkerCount(fixture)).toBe(0);
      expect(await fixture.store.workflowProjectionReader.get('profiles', plan.identities.ledgerProfile.id)).toBeUndefined();

      const branch = plan.seedData.branches[0];
      await fixture.store.transaction(tx => tx.put('branches', {
        ...branch,
        name: 'Conflicting pre-existing legacy branch',
      }));
      const blocked = await persistWorkflowV2SeedPlan({ store: fixture.store }, plan);

      expect(blocked.state).toBe('legacy_base_requires_seed_plan');
      expect(blocked.seedBeginMarkerState).toBe('blocked');
      expect(blocked.blockedTables).toContain('branches');
      expect(await seedBeginMarkerCount(fixture)).toBe(0);
      expect(await fixture.store.workflowProjectionReader.get('profiles', plan.identities.ledgerProfile.id)).toBeUndefined();
    } finally {
      await fixture.dispose();
    }
  });

  it('fails closed when an existing seed marker carries an older plan version', async () => {
    const plan = preparePlan();
    const markerFixture = await createWorkflowSqliteFixture();
    try {
      let transactionCalls = 0;
      const interruptedStore = Object.create(markerFixture.store) as typeof markerFixture.store;
      interruptedStore.workflowTransaction = async <T>(work: (tx: WorkflowTransactionContext) => Promise<T>): Promise<T> => {
        transactionCalls += 1;
        if (transactionCalls === 2) throw new Error('Controlled stop after the seed-begin marker.');
        return markerFixture.store.workflowTransaction(work);
      };
      const markerOnly = await persistWorkflowV2SeedPlan({ store: interruptedStore }, plan);
      expect(markerOnly).toMatchObject({
        state: 'source_phase_incomplete',
        failedPhase: 'foundation',
        seedBeginMarkerState: 'inserted',
      });
      const markerRow = await markerFixture.store.workflowProjectionReader.get<Record<string, unknown>>(
        'audit_events', markerOnly.seedBeginMarkerId,
      );
      expect(markerRow).toBeDefined();

      const conflictFixture = await createWorkflowSqliteFixture();
      try {
        const ledgerProfile = plannedBodies(plan, 'profiles').find(row => row.id === plan.identities.ledgerProfile.id);
        if (!ledgerProfile || typeof markerRow?.body.summary !== 'string') {
          throw new Error('The canonical seed ledger profile or marker summary was missing.');
        }
        const priorSummary = JSON.parse(markerRow.body.summary) as Record<string, unknown>;
        const oldMarker = {
          ...markerRow.body,
          id: markerOnly.seedBeginMarkerId,
          summary: JSON.stringify({ ...priorSummary, seedVersion: plan.seedVersion - 1 }),
        };
        await conflictFixture.store.workflowTransaction(async tx => {
          await tx.insertUnique('profiles', ledgerProfile, {
            constraint: 'profiles_primary_key', values: { id: ledgerProfile.id },
          });
          await tx.insertUnique('audit_events', oldMarker, {
            constraint: 'audit_events_primary_key', values: { id: markerOnly.seedBeginMarkerId },
          });
        });

        const conflicted = await persistWorkflowV2SeedPlan({ store: conflictFixture.store }, plan);
        expect(conflicted).toMatchObject({
          state: 'seed_plan_conflict',
          seedBeginMarkerState: 'conflict',
          seedBeginMarkerId: markerOnly.seedBeginMarkerId,
          sourcePhases: [],
          sourcePhasesComplete: false,
          bootstrapReady: false,
          blockedTables: [],
        });
        expect(await seedBeginMarkerCount(conflictFixture)).toBe(1);
        expect((await conflictFixture.store.workflowProjectionReader.get('audit_events', markerOnly.seedBeginMarkerId))?.body)
          .toEqual(oldMarker);
        expect(await conflictFixture.store.workflowProjectionReader.get('branches', plan.seedData.branches[0].id))
          .toBeUndefined();
        expect(await conflictFixture.store.workflowProjectionReader.query({
          kind: 'scoped', table: 'investigation_cases', limit: 10,
        })).toEqual([]);
      } finally {
        await conflictFixture.dispose();
      }
    } finally {
      await markerFixture.dispose();
    }
  });

  it('resumes partial source writes idempotently and only exposes Director work after a verified manager event', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const plan = preparePlan();
      const baseDimensions = plan.phases.filter(phase => phase.phase.startsWith('base_dimensions:'));
      expect(baseDimensions).toHaveLength(1);

      let transactionCalls = 0;
      const interruptedStore = Object.create(fixture.store) as typeof fixture.store;
      interruptedStore.workflowTransaction = async <T>(work: (tx: WorkflowTransactionContext) => Promise<T>): Promise<T> => {
        transactionCalls += 1;
        // Call 1 persists the begin marker; call 2 writes foundation; call 3 writes base dimensions.
        // Fail before the authority phase begins so a later invocation must resume committed phases.
        if (transactionCalls === 4) throw new Error('Controlled interruption before authority phase');
        return fixture.store.workflowTransaction(work);
      };
      const interrupted = await persistWorkflowV2SeedPlan({ store: interruptedStore }, plan);

      expect(interrupted.state).toBe('source_phase_incomplete');
      expect(interrupted.seedBeginMarkerState).toBe('inserted');
      expect(interrupted.failedPhase).toBe('authority');
      expect(interrupted.sourcePhases.map(phase => phase.phase)).toEqual(['foundation', 'base_dimensions:0000']);

      const resumed = await persistWorkflowV2SeedPlan({ store: fixture.store }, plan);
      expect(resumed.state).toBe('source_ready');
      expect(resumed.sourcePhasesComplete).toBe(true);
      expect(resumed.bootstrapReady).toBe(true);
      expect(resumed.seedBeginMarkerState).toBe('current');
      for (const priorPhase of interrupted.sourcePhases) {
        const current = resumed.sourcePhases.find(phase => phase.phase === priorPhase.phase);
        expect(current).toMatchObject({ inserted: 0, alreadyCurrent: priorPhase.rows, ledgerInserted: false });
      }
      expect(resumed.managerAdvancement).toMatchObject({
        state: 'not_requested',
        selectedRequestIds: [],
        managerReadyRequestIds: [plan.identities.onboardingRequestIds[0]],
        directorQueueRequestIds: [],
      });
      expect(resumed.directorQueueReady).toBe(false);

      const repeated = await persistWorkflowV2SeedPlan({ store: fixture.store }, plan);
      expect(repeated.state).toBe('source_ready');
      expect(repeated.seedBeginMarkerState).toBe('current');
      expect(repeated.sourcePhases.every(phase => phase.inserted === 0 && phase.alreadyCurrent === phase.rows && !phase.ledgerInserted)).toBe(true);

      const plannedCases = plannedBodies(plan, 'investigation_cases');
      const persistedCases = await fixture.store.workflowProjectionReader.query<Record<string, unknown>>({
        kind: 'scoped', table: 'investigation_cases', limit: 100,
      });
      expect(persistedCases.map(row => row.id).sort()).toEqual(plannedCases.map(row => row.id).sort());
      expect(persistedCases).toHaveLength(9);
      for (const persisted of persistedCases) {
        const planned = plannedCases.find(row => row.id === persisted.id)!;
        expect(persisted.body).toEqual(planned);
        expect(persisted.body.status).toBe('open');
        expect(persisted.body.sourceIds).toEqual(expectedInvestigationSources(plan, String(persisted.body.branchId)));
        expect(Object.hasOwn(persisted.body, 'createdAt')).toBe(false);
        expect(Object.hasOwn(persisted.body, 'updatedAt')).toBe(false);
      }
      expect(await fixture.store.workflowProjectionReader.query({
        kind: 'scoped', table: 'investigation_tasks', limit: 100,
      })).toEqual([]);
      expect(await fixture.store.workflowProjectionReader.query({
        kind: 'scoped', table: 'branch_review_assignments', limit: 100,
      })).toEqual([]);

      const readyRequestId = plan.identities.onboardingRequestIds[0];
      const incompleteRequestId = plan.identities.onboardingRequestIds[1];
      const requestRows = await Promise.all([
        fixture.store.workflowProjectionReader.get<OnboardingRequest>('onboarding_requests', readyRequestId),
        fixture.store.workflowProjectionReader.get<OnboardingRequest>('onboarding_requests', incompleteRequestId),
      ]);
      expect(requestRows.map(row => row?.body.state)).toEqual(['manager_review_pending', 'manager_review_pending']);

      const documentTypesByRequest = new Map<string, string[]>();
      for (const requestId of plan.identities.onboardingRequestIds) {
        const documentTypes: string[] = [];
        for (const documentType of demoWorkflowPolicyV1.requiredOnboardingDocuments) {
          const rows = await fixture.store.workflowProjectionReader.query<{
            requestId: string;
            employeeId: string;
            documentType: string;
            status: string;
            policyVersion: string;
            classification: string;
            contentDigest: string;
            withdrawnAt: string | null;
          }>({
            kind: 'unique',
            table: 'onboarding_documents',
            constraint: 'onboarding_documents_request_type_unique',
            values: { requestId, documentType },
          });
          if (rows.length > 0) {
            expect(rows).toHaveLength(1);
            const request = requestRows[plan.identities.onboardingRequestIds.indexOf(requestId)]?.body;
            expect(rows[0].body).toMatchObject({
              requestId,
              employeeId: request?.employeeId,
              documentType,
              status: 'accepted',
              policyVersion: demoWorkflowPolicyV1.policyAcknowledgementVersion,
              classification: demoWorkflowPolicyV1.classification,
              withdrawnAt: null,
            });
            expect(rows[0].body.contentDigest).toMatch(/^[a-f0-9]{64}$/i);
            documentTypes.push(rows[0].body.documentType);
          }
        }
        documentTypesByRequest.set(requestId, documentTypes);
      }
      expect(documentTypesByRequest.get(readyRequestId)).toEqual([...demoWorkflowPolicyV1.requiredOnboardingDocuments]);
      expect(documentTypesByRequest.get(incompleteRequestId)).toHaveLength(demoWorkflowPolicyV1.requiredOnboardingDocuments.length - 1);

      const seedWithManagerRuntime: WorkflowV2SeedServerOptions = {
        store: fixture.store,
        advanceManagerApprovals: async input => {
          await approveThroughRealManagerRuntime(fixture.store, plan, input, readyRequestId);
        },
      };
      const advanced = await persistWorkflowV2SeedPlan(seedWithManagerRuntime, plan, {
        advanceManagerRequestIds: [readyRequestId],
      });

      expect(advanced.state).toBe('source_ready');
      expect(advanced.managerAdvancement).toMatchObject({
        state: 'verified',
        selectedRequestIds: [readyRequestId],
        managerReadyRequestIds: [],
        directorQueueRequestIds: [readyRequestId],
      });
      expect(advanced.directorQueueReady).toBe(true);

      const approvedRequest = await fixture.store.workflowProjectionReader.get<OnboardingRequest>('onboarding_requests', readyRequestId);
      expect(approvedRequest?.body.state).toBe('director_approval_pending');
      const eventId = approvedRequest?.body.managerApprovalEventId;
      expect(eventId).toEqual(expect.any(String));
      const eventRow = await fixture.store.workflowProjectionReader.get<{
        id: string;
        requestId: string;
        actorIdentityId: string;
        stage: string;
        lifecycleId: string;
        executionId: string;
        decision: string;
      }>('onboarding_approval_events', eventId!);
      expect(eventRow).toBeDefined();
      expect(eventRow?.body).toMatchObject({
        id: eventId,
        requestId: readyRequestId,
        actorIdentityId: plan.identities.managerIdentityId,
        stage: 'manager',
        lifecycleId: approvedRequest?.body.lifecycleId,
        decision: 'approved',
      });
      const receiptRow = await fixture.store.workflowProjectionReader.get<WorkflowReceiptV2>(
        'action_executions',
        eventRow!.body.executionId,
      );
      expect(receiptRow?.body).toMatchObject({
        id: eventRow?.body.executionId,
        actorId: plan.identities.managerProfile.id,
        kind: 'onboarding_manager_approve',
        outcome: 'verified_success',
      });
      const targetProofs = receiptRow!.body.proofs.filter(proof =>
        proof.targetId === readyRequestId + ':' + approvedRequest!.body.lifecycleId);
      expect(targetProofs).toHaveLength(1);
      expect(targetProofs[0]).toMatchObject({
        ref: { table: 'onboarding_approval_events', id: eventId },
        executionId: receiptRow!.body.id,
        outcome: 'verified_success',
        observedRowVersion: eventRow?.rowVersion,
      });
      expect(receiptRow!.body.proofs.some(proof =>
        proof.ref.table === 'onboarding_requests' && proof.ref.id === readyRequestId)).toBe(false);

      const directoryIdentities = [
        { id: plan.identities.salesIdentityId, profileId: plan.identities.salesProfile.id, role: 'executive', orgUnitId: plan.identities.salesOrgUnitId },
        { id: plan.identities.managerIdentityId, profileId: plan.identities.managerProfile.id, role: 'east_manager', orgUnitId: plan.identities.hrOrgUnitId },
        { id: plan.identities.hrIdentityId, profileId: plan.identities.hrProfile.id, role: 'hr_admin', orgUnitId: plan.identities.hrOrgUnitId },
        { id: plan.identities.directorIdentityId, profileId: plan.identities.directorProfile.id, role: 'hr_director', orgUnitId: plan.identities.hrOrgUnitId },
      ];
      for (const expected of directoryIdentities) {
        const identity = await fixture.store.workflowProjectionReader.get<Record<string, unknown>>('directory_identities', expected.id);
        expect(identity).toMatchObject({
          id: expected.id,
          rowVersion: 1,
          body: {
            id: expected.id,
            profileId: expected.profileId,
            role: expected.role,
            orgUnitId: expected.orgUnitId,
            active: true,
          },
        });
      }

      const rootOrg = await fixture.store.workflowProjectionReader.get<Record<string, unknown>>('org_units', plan.identities.rootOrgUnitId);
      const salesOrg = await fixture.store.workflowProjectionReader.get<Record<string, unknown>>('org_units', plan.identities.salesOrgUnitId);
      const hrOrg = await fixture.store.workflowProjectionReader.get<Record<string, unknown>>('org_units', plan.identities.hrOrgUnitId);
      expect(rootOrg?.body.parentOrgUnitId).toBeNull();
      expect(salesOrg?.body.parentOrgUnitId).toBe(plan.identities.rootOrgUnitId);
      expect(hrOrg?.body.parentOrgUnitId).toBe(plan.identities.rootOrgUnitId);

      const foundationRows = plan.phases.find(phase => phase.phase === 'foundation')!.rows;
      const authorityRows = plan.phases.find(phase => phase.phase === 'authority')!.rows;
      const indexOfRow = (rows: WorkflowV2SeedPlan['phases'][number]['rows'], table: string, id: string) =>
        rows.findIndex(row => row.table === table && row.body.id === id);
      const rootIndex = indexOfRow(foundationRows, 'org_units', plan.identities.rootOrgUnitId);
      const salesIndex = indexOfRow(foundationRows, 'org_units', plan.identities.salesOrgUnitId);
      const hrIndex = indexOfRow(foundationRows, 'org_units', plan.identities.hrOrgUnitId);
      const directorIndex = indexOfRow(authorityRows, 'directory_identities', plan.identities.directorIdentityId);
      const managerIndex = indexOfRow(authorityRows, 'directory_identities', plan.identities.managerIdentityId);
      expect([rootIndex, salesIndex, hrIndex, directorIndex, managerIndex].every(index => index >= 0)).toBe(true);
      expect(rootIndex).toBeLessThan(salesIndex);
      expect(rootIndex).toBeLessThan(hrIndex);
      expect(directorIndex).toBeLessThan(managerIndex);
      expect(plan.phases.findIndex(phase => phase.phase === 'foundation'))
        .toBeLessThan(plan.phases.findIndex(phase => phase.phase === 'authority'));
      expect(plan.phases.findIndex(phase => phase.phase.startsWith('base_dimensions:')))
        .toBeLessThan(plan.phases.findIndex(phase => phase.phase === 'authority'));

      if (pgTestsEnabled) {
        // PostgreSQL enforces foreign keys on every commit; prove none is unvalidated or deferred-and-violated.
        expect(localPsql("select count(*) from pg_constraint where contype='f' and connamespace='public'::regnamespace and not convalidated")).toBe('0');
      } else {
        const db = fixture.openDatabase();
        try {
          db.pragma('foreign_keys = ON');
          expect(db.pragma('foreign_key_check')).toEqual([]);
        } finally {
          db.close();
        }
      }
    } finally {
      await fixture.dispose();
    }
  }, 180_000);
});

async function approveThroughRealManagerRuntime(
  store: WorkflowV2SeedServerOptions['store'],
  plan: WorkflowV2SeedPlan,
  input: WorkflowV2ManagerAdvanceRequest,
  expectedRequestId: string,
): Promise<void> {
  expect(input.requestIds).toEqual([expectedRequestId]);
  expect(input.managerIdentityId).toBe(plan.identities.managerIdentityId);
  expect(input.managerProfileId).toBe(plan.identities.managerProfile.id);
  expect(input.businessDate).toBe(plan.businessDate);

  const managerSessionId = 'seed-v2-manager-session-' + plan.seed;
  const directorSessionId = 'seed-v2-director-session-' + plan.seed;
  const managerConversationId = 'seed-v2-manager-conversation-' + plan.seed;
  const directorConversationId = 'seed-v2-director-conversation-' + plan.seed;
  const sessionExpiresAt = '2099-01-01T00:00:00.000Z';
  const createdAt = '2026-10-04T08:00:00.000Z';

  await store.transaction(async tx => {
    await tx.put('sessions', {
      id: managerSessionId,
      profileId: plan.identities.managerProfile.id,
      mode: 'scripted_demo',
      modeRevision: 1,
      csrfToken: 'csrf-' + plan.seed + '-manager',
      expiresAt: sessionExpiresAt,
    });
    await tx.put('sessions', {
      id: directorSessionId,
      profileId: plan.identities.directorProfile.id,
      mode: 'scripted_demo',
      modeRevision: 1,
      csrfToken: 'csrf-' + plan.seed + '-director',
      expiresAt: sessionExpiresAt,
    });
  });
  await store.workflowTransaction(async tx => {
    for (const [id, actorId, title] of [
      [managerConversationId, plan.identities.managerProfile.id, 'Synthetic seed manager approval test'],
      [directorConversationId, plan.identities.directorProfile.id, 'Synthetic seed Director queue test'],
    ] as const) {
      await tx.insertUnique('conversations', {
        id,
        actorId,
        title,
        pinned: false,
        archivedAt: null,
        rowVersion: 1,
        createdAt,
        updatedAt: createdAt,
        lastScope: null,
        lastDashboardId: null,
      }, { constraint: 'conversations_primary_key', values: { id } });
    }
  });

  let generatedId = 0;
  const runtime = createWorkflowActionRuntime({
    store,
    bindings: createHrApprovalWorkflowBindings(),
    businessDate: plan.businessDate,
    getReleaseRevision: () => 'workflow-v2-seed-manager-runtime-test-r1',
    getPackPins: packIds => packIds.map(id => ({
      id,
      version: '1.0',
      schemaDigest: 'a'.repeat(64),
      implementationRevision: 'workflow-v2-seed-manager-runtime-test-base-r1',
    })),
    contextFactory: () => ({
      evidence: async () => { throw new Error('The HR approval runtime must not load Sales/Operations evidence'); },
      latestDashboard: async () => { throw new Error('The HR approval runtime must not load dashboards'); },
    }),
    now: () => new Date('2026-10-04T08:00:00.000Z'),
    makeId: prefix => 'seed-v2-runtime-' + prefix + '-' + generatedId++,
  });
  const queries = createOnboardingQueryService(runtime);
  const directorQueueBefore = await queries.directorQueue(directorSessionId);
  expect(directorQueueBefore.items).toHaveLength(0);

  const managerQueue = await queries.managerQueue(managerSessionId);
  expect(managerQueue.snapshot.displayedIds).toEqual([expectedRequestId]);
  expect(managerQueue.items).toHaveLength(1);

  const prepared = await runtime.prepare(managerSessionId, {
    kind: 'onboarding_manager_approve',
    snapshotId: managerQueue.snapshot.id,
    requestIds: [expectedRequestId],
  }, { conversationId: managerConversationId, turnId: 'seed-v2-manager-turn-' + plan.seed });
  expect(prepared.outcome).toBe('pending');
  expect(prepared.pendingAction).not.toBeNull();
  const action = prepared.pendingAction!;

  const confirmed = await createWorkflowActionRunner(runtime).confirm(
    managerSessionId,
    action.id,
    'seed-v2-manager-confirm-' + plan.seed,
    { conversationId: managerConversationId, turnId: 'seed-v2-manager-turn-' + plan.seed },
  );
  expect(confirmed.error).toBeNull();
  expect(confirmed.receipt?.outcome).toBe('verified_success');

  const directorQueueAfter = await queries.directorQueue(directorSessionId);
  expect(directorQueueAfter.items.map(item => item.request.id)).toEqual([expectedRequestId]);
}
