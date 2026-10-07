import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Dashboard, Profile } from '../lib/contracts';
import { projectWorkflowSuggestions, type WorkflowBindingAvailability, type WorkflowSuggestionContext } from '../lib/core/workflow-capabilities';
import { digest } from '../lib/core/utils';
import { createHrApprovalWorkflowBindings } from '../lib/packs/hr-approval-workflows';
import { createSalesWorkflowBindings } from '../lib/packs/sales-workflows';
import { createWorkflowActionRunner } from '../lib/workflows/action-runner';
import { createWorkflowActionRuntime } from '../lib/workflows/action-runtime';
import { dashboardVersionDigest, type DashboardShareSigningOptions } from '../lib/workflows/dashboard-access';
import { createOnboardingQueryService } from '../lib/workflows/onboarding-queries';
import { demoWorkflowPolicyV1, getDemoWorkflowPolicyV1Pin } from '../lib/workflows/policy';
import type { DashboardShareV2, OnboardingRequest, WorkflowPayloadV2 } from '../lib/workflows/contracts';
import { createWorkflowSqliteFixture } from './helpers/workflow-storage';

const NOW = '2026-10-04T04:00:00.000Z';
const BUSINESS_DATE = '2026-10-04';
const DIRECTOR_APPROVE_PROMPT = 'เตรียมอนุมัติรายการรับพนักงานที่เลือก';
const DASHBOARD_REVOKE_PROMPT = 'เตรียมยกเลิกการแชร์ Dashboard ที่เลือก';

type Fixture = Awaited<ReturnType<typeof createWorkflowSqliteFixture>>;
type ActorKey = 'executive' | 'recipient' | 'manager' | 'director';
type ActorSeed = {
  profileId: string;
  sessionId: string;
  identityId: string;
  responsibilityId: string;
  conversationId: string;
};
type AddedRequest = { requestId: string; employeeId: string };

interface Harness {
  fixture: Fixture;
  runtime: ReturnType<typeof createWorkflowActionRuntime>;
  runner: ReturnType<typeof createWorkflowActionRunner>;
  queries: ReturnType<typeof createOnboardingQueryService>;
  availability: WorkflowBindingAvailability[];
  actors: Record<ActorKey, ActorSeed>;
  branchAId: string;
  branchBId: string;
  dashboardAId: string;
  dashboardBId: string;
  requests: AddedRequest[];
  setNow(value: string): void;
  addRequest(label: string): Promise<AddedRequest>;
  createShare(dashboardId: string, label: string): Promise<DashboardShareV2>;
  dispose(): Promise<void>;
}

function dashboardSpec(title: string, branchId: string) {
  return {
    title,
    description: 'Private SQLite suggestion fixture.',
    scope: { region: 'east', date: BUSINESS_DATE, branchIds: [branchId] },
    widgets: [{ type: 'metric' as const, title: 'Net sales', metric: 'net_sales' as const }],
  };
}

async function createHarness(): Promise<Harness> {
  const fixture = await createWorkflowSqliteFixture();
  const suffix = randomUUID().replaceAll('-', '');
  const id = (name: string) => `suggestion-${name}-${suffix}`;
  const orgUnitId = id('org');
  const branchAId = id('branch-a');
  const branchBId = id('branch-b');
  const dashboardAId = id('dashboard-a');
  const dashboardBId = id('dashboard-b');
  let now = new Date(NOW);
  let nextRuntimeId = 0;
  const actors: Record<ActorKey, ActorSeed> = {
    executive: { profileId: id('exec-profile'), sessionId: id('exec-session'), identityId: id('exec-identity'),
      responsibilityId: id('exec-responsibility'), conversationId: id('exec-conversation') },
    recipient: { profileId: id('recipient-profile'), sessionId: id('recipient-session'), identityId: id('recipient-identity'),
      responsibilityId: id('recipient-responsibility'), conversationId: id('recipient-conversation') },
    manager: { profileId: id('manager-profile'), sessionId: id('manager-session'), identityId: id('manager-identity'),
      responsibilityId: id('manager-responsibility'), conversationId: id('manager-conversation') },
    director: { profileId: id('director-profile'), sessionId: id('director-session'), identityId: id('director-identity'),
      responsibilityId: id('director-responsibility'), conversationId: id('director-conversation') },
  };
  const actorConfig = [
    { key: 'executive' as const, profileRole: 'executive' as const, directoryRole: 'executive' as const,
      department: 'sales_operations' as const, purpose: 'sales_operations' as const, name: 'Suggestion fixture Executive',
      permissions: ['sales.read', 'operations.read', 'dashboard.share'] },
    { key: 'recipient' as const, profileRole: 'east_manager' as const, directoryRole: 'east_manager' as const,
      department: 'sales_operations' as const, purpose: 'sales_operations' as const, name: 'Suggestion fixture recipient',
      permissions: ['sales.read', 'operations.read'] },
    { key: 'manager' as const, profileRole: 'east_manager' as const, directoryRole: 'east_manager' as const,
      department: 'hr' as const, purpose: 'manager_onboarding' as const, name: 'Suggestion fixture HR manager',
      permissions: ['hr.onboarding.manager_read', 'hr.onboarding.manager_approve'] },
    { key: 'director' as const, profileRole: 'hr_admin' as const, directoryRole: 'hr_director' as const,
      department: 'hr' as const, purpose: 'director_onboarding' as const, name: 'Suggestion fixture HR Director',
      permissions: ['hr.onboarding.director_read', 'hr.onboarding.director_approve', 'hr.onboarding.return'] },
  ];
  const signing: DashboardShareSigningOptions = {
    applicationOrigin: 'https://suggestions.example',
    sessionSigningSecrets: new Map([[demoWorkflowPolicyV1.shareSigning.keyVersion, new Uint8Array(32).fill(71)]]),
    allowedKeyVersions: [demoWorkflowPolicyV1.shareSigning.keyVersion],
  };
  const policyPin = getDemoWorkflowPolicyV1Pin();

  try {
    await fixture.store.transaction(async tx => {
      await tx.put('branches', { id: branchAId, name: 'Suggestion branch A', region: 'east' });
      await tx.put('branches', { id: branchBId, name: 'Suggestion branch B', region: 'east' });
      for (const config of actorConfig) {
        const actor = actors[config.key];
        const profile: Profile = { id: actor.profileId, name: config.name, role: config.profileRole,
          active: true, permissions: [...config.permissions], regions: ['east'] };
        await tx.put('profiles', profile);
        await tx.put('sessions', { id: actor.sessionId, profileId: actor.profileId, mode: 'scripted_demo',
          modeRevision: 1, csrfToken: id(`${config.key}-csrf`), expiresAt: '2099-01-01T00:00:00.000Z' });
      }
    });

    await fixture.store.workflowTransaction(async tx => {
      await tx.insertUnique('org_units', { id: orgUnitId, name: 'Suggestion test org', parentOrgUnitId: null, active: true },
        { constraint: 'org_units_primary_key', values: { id: orgUnitId } });
      for (const config of actorConfig) {
        const actor = actors[config.key];
        await tx.insertUnique('directory_identities', {
          id: actor.identityId,
          profileId: actor.profileId,
          displayName: config.name,
          active: true,
          role: config.directoryRole,
          department: config.department,
          orgUnitId,
          managerIdentityId: null,
          verifiedDemoEmail: `${config.key}-${suffix}@example.invalid`,
          slackIdentity: null,
          allowedChannels: ['simulated_email'],
          classificationCeiling: 'internal',
          rowVersion: 1,
        }, { constraint: 'directory_identities_primary_key', values: { id: actor.identityId } });
        await tx.insertUnique('responsibilities', {
          id: actor.responsibilityId,
          identityId: actor.identityId,
          orgUnitId,
          purpose: config.purpose,
          branchIds: [branchAId, branchBId],
          active: true,
          rowVersion: 1,
        }, { constraint: 'responsibilities_open_identity_purpose_unique', values: {
          identityId: actor.identityId, purpose: config.purpose, orgUnitId,
        } });
        await tx.insertUnique('conversations', {
          id: actor.conversationId, actorId: actor.profileId, title: `${config.name} suggestion fixture`,
          pinned: false, archivedAt: null, rowVersion: 1, createdAt: NOW, updatedAt: NOW,
          lastScope: null, lastDashboardId: null,
        }, { constraint: 'conversations_primary_key', values: { id: actor.conversationId } });
      }
      await tx.insertUnique('workflow_policies', {
        id: id('policy-row'), version: policyPin.version, digest: policyPin.digest, policy: demoWorkflowPolicyV1,
      }, { constraint: 'workflow_policies_primary_key', values: { id: id('policy-row') } });
    });

    const dashboardRows: Dashboard[] = [];
    const dashboardVersions: Array<{
      id: string; dashboardId: string; version: number; ownerId: string; createdAt: string;
      spec: Dashboard['spec']; packs: Dashboard['packs']; sourceMetadata: Dashboard['sourceMetadata'];
      analysis: Dashboard['analysis']; evidenceVersion: string; digest: string;
    }> = [];
    for (const [dashboardId, branchId, label] of [
      [dashboardAId, branchAId, 'A'], [dashboardBId, branchBId, 'B'],
    ] as const) {
      const spec = dashboardSpec(`Suggestion dashboard ${label}`, branchId);
      const evidenceVersion = 'suggestion-evidence-v1';
      const analysis = { facts: [], relationships: [], hypotheses: [], missingEvidence: [], generatedAt: NOW, evidenceVersion };
      const dashboard: Dashboard = {
        id: dashboardId, ownerId: actors.executive.profileId, createdAt: NOW, updatedAt: NOW,
        lastRefreshAt: NOW, spec, packs: [], sourceMetadata: [], analysis, evidenceVersion,
      };
      dashboardRows.push(dashboard);
      const versionBase = {
        id: id(`dashboard-version-${label}`), dashboardId, version: 1, ownerId: actors.executive.profileId,
        createdAt: NOW, spec, packs: [], sourceMetadata: [], analysis, evidenceVersion,
      };
      const version = { ...versionBase, digest: dashboardVersionDigest(versionBase) };
      dashboardVersions.push(version);
    }
    await fixture.store.transaction(async tx => {
      for (const dashboard of dashboardRows) await tx.put('dashboards', dashboard);
    });
    await fixture.store.workflowTransaction(async tx => {
      for (const version of dashboardVersions) await tx.insertUnique('dashboard_versions', version, {
        constraint: 'dashboard_versions_primary_key', values: { id: version.id },
      });
    });

    const bindings = [
      ...createSalesWorkflowBindings({ dashboardShareSigning: signing }),
      ...createHrApprovalWorkflowBindings(),
    ];
    const runtime = createWorkflowActionRuntime({
      store: fixture.store,
      bindings,
      businessDate: BUSINESS_DATE,
      getReleaseRevision: () => 'workflow-suggestion-context-test-r1',
      getPackPins: packIds => packIds.map(packId => ({ id: packId, version: '1.0', schemaDigest: 'a'.repeat(64),
        implementationRevision: 'workflow-suggestion-context-test-base-r1' })),
      contextFactory: () => ({
        evidence: async scope => ({ scope, asOf: NOW, version: 'workflow-suggestion-empty-evidence-v1', branches: [],
          totals: { netSales: 0, target: 0, gap: 0, achievement: null }, sources: [], warnings: [] }),
        latestDashboard: async () => undefined,
      }),
      now: () => new Date(now),
      makeId: prefix => `${id(`runtime-${prefix}`)}-${nextRuntimeId++}`,
    });
    const runner = createWorkflowActionRunner(runtime);
    const queries = createOnboardingQueryService(runtime);
    const availability: WorkflowBindingAvailability[] = runtime.availableKinds().map(kind => ({ kind, available: true, reason: null }));

    const requests: AddedRequest[] = [];
    const harness: Harness = {
      fixture, runtime, runner, queries, availability, actors, branchAId, branchBId, dashboardAId, dashboardBId, requests,
      setNow(value) { now = new Date(value); },
      async addRequest(label) {
        const requestId = id(`request-${label}`), employeeId = id(`employee-${label}`), lifecycleId = id(`lifecycle-${label}`);
        await fixture.store.transaction(tx => tx.put('employees', {
          id: employeeId, name: `Suggestion employee ${label}`, branchId: branchAId, active: true,
        }));
        const request: OnboardingRequest = {
          id: requestId, employeeId, orgUnitId, managerIdentityId: actors.manager.identityId,
          directorIdentityId: actors.director.identityId, startDate: '2026-10-15', state: 'manager_review_pending',
          rowVersion: 1, lifecycleId, managerApprovalEventId: null, managerApprovedBy: null, managerApprovedAt: null,
          directorApprovalEventId: null, directorApprovedBy: null, directorApprovedAt: null, createdAt: NOW, updatedAt: NOW,
        };
        await fixture.store.workflowTransaction(async tx => {
          await tx.insertUnique('onboarding_requests', request, {
            constraint: 'onboarding_requests_primary_key', values: { id: requestId },
          });
          for (const documentType of demoWorkflowPolicyV1.requiredOnboardingDocuments) {
            await tx.insertUnique('onboarding_documents', {
              id: id(`document-${label}-${documentType}`), rowVersion: 1, requestId, employeeId, documentType,
              status: 'accepted', policyVersion: demoWorkflowPolicyV1.policyAcknowledgementVersion,
              classification: demoWorkflowPolicyV1.classification,
              contentDigest: digest({ purpose: 'suggestion-fixture-document', requestId, documentType }),
              createdAt: NOW, withdrawnAt: null,
            }, { constraint: 'onboarding_documents_request_type_unique', values: { requestId, documentType } });
          }
        });
        const added = { requestId, employeeId };
        requests.push(added);
        return added;
      },
      async createShare(dashboardId, label) {
        const turnId = id(`share-turn-${label}`);
        const prepared = await runtime.prepare(actors.executive.sessionId, {
          kind: 'dashboard_share', dashboardId, recipientIdentityId: actors.recipient.identityId,
          channel: 'simulated_email', subject: `Suggestion fixture ${label}`, body: `Share ${label} for a bounded test.`,
        }, { conversationId: actors.executive.conversationId, turnId });
        const action = prepared.pendingAction;
        if (!action) throw new Error(`Expected a real pending share for dashboard ${dashboardId}; outcome=${prepared.outcome}; reasons=${JSON.stringify(prepared.reasons)}`);
        const confirmed = await runner.confirm(actors.executive.sessionId, action.id, id(`share-confirm-${label}`), {
          conversationId: action.conversationId, turnId: action.turnId,
        });
        if (confirmed.error || !confirmed.receipt || confirmed.receipt.outcome !== 'verified_success') {
          throw new Error(`Expected a verified share fixture for dashboard ${dashboardId}`);
        }
        const rows = await fixture.store.workflowProjectionReader.query<DashboardShareV2>({
          kind: 'scoped', table: 'dashboard_shares', equals: { dashboardId }, limit: 20,
        });
        const share = rows.find(row => row.body.senderIdentityId === actors.executive.identityId &&
          row.body.recipientIdentityId === actors.recipient.identityId);
        if (!share) throw new Error(`Expected a persisted share for dashboard ${dashboardId}`);
        return share.body;
      },
      async dispose() { await fixture.dispose(); },
    };
    return harness;
  } catch (error) {
    await fixture.dispose();
    throw error;
  }
}

async function withHarness<T>(run: (harness: Harness) => Promise<T>): Promise<T> {
  const harness = await createHarness();
  try { return await run(harness); }
  finally { await harness.dispose(); }
}

async function approveManagerQueue(harness: Harness, requests: readonly AddedRequest[]) {
  const manager = harness.actors.manager;
  const page = await harness.queries.managerQueue(manager.sessionId);
  expect(page.items.map(item => item.request.id).sort()).toEqual(requests.map(item => item.requestId).sort());
  const turnId = `suggestion-manager-turn-${randomUUID()}`;
  const prepared = await harness.runtime.prepare(manager.sessionId, {
    kind: 'onboarding_manager_approve', snapshotId: page.snapshot.id, requestIds: requests.map(item => item.requestId),
  }, { conversationId: manager.conversationId, turnId });
  const action = prepared.pendingAction;
  if (!action) throw new Error('Expected a real manager approval action for the queue fixture');
  const confirmed = await harness.runner.confirm(manager.sessionId, action.id, `suggestion-manager-confirm-${randomUUID()}`, {
    conversationId: action.conversationId, turnId: action.turnId,
  });
  expect(confirmed.error).toBeNull();
  expect(confirmed.receipt?.outcome).toBe('verified_success');
}

async function approveDirectorQueue(harness: Harness, snapshotId: string, requests: readonly AddedRequest[]) {
  const director = harness.actors.director;
  const turnId = `suggestion-director-turn-${randomUUID()}`;
  const prepared = await harness.runtime.prepare(director.sessionId, {
    kind: 'onboarding_director_approve', snapshotId, requestIds: requests.map(item => item.requestId),
  }, { conversationId: director.conversationId, turnId });
  const action = prepared.pendingAction;
  if (!action) throw new Error('Expected a real Director approval action for the queue fixture');
  const confirmed = await harness.runner.confirm(director.sessionId, action.id, `suggestion-director-confirm-${randomUUID()}`, {
    conversationId: action.conversationId, turnId: action.turnId,
  });
  expect(confirmed.error).toBeNull();
  expect(confirmed.receipt?.outcome).toBe('verified_success');
}

function followUpContext(conversationId: string, overrides: Partial<WorkflowSuggestionContext> = {}): WorkflowSuggestionContext {
  return { phase: 'follow_up', conversationId, ...overrides };
}

function hasPrompt(suggestions: readonly { prompt: string }[], prompt: string): boolean {
  return suggestions.some(suggestion => suggestion.prompt === prompt);
}

async function expectNoSuggestionsOrClosedSnapshotError(operation: Promise<readonly { id: string; prompt: string }[]>): Promise<void> {
  try {
    expect(await operation).toEqual([]);
  } catch (error) {
    expect(error).toMatchObject({ code: expect.stringMatching(/^WORKFLOW_(STALE|NOT_FOUND)$/), status: expect.any(Number) });
  }
}

describe('context-bound workflow suggestions', () => {
  it('returns four real Director read suggestions for a live reviewed queue and none for expired or empty snapshots', async () => {
    await withHarness(async harness => {
      const requests = await Promise.all(['one', 'two', 'three', 'four'].map(label => harness.addRequest(label)));
      await approveManagerQueue(harness, requests);
      const director = harness.actors.director;
      const live = await harness.queries.directorQueue(director.sessionId);
      expect(live.items).toHaveLength(4);

      const liveSuggestions = await projectWorkflowSuggestions(harness.runtime, director.sessionId, harness.availability,
        followUpContext(director.conversationId, { snapshotId: live.snapshot.id }));
      expect(liveSuggestions).toHaveLength(4);
      expect(liveSuggestions.map(item => item.prompt)).toEqual(expect.arrayContaining([
        'มีรายการรับพนักงานใดรอฉันอนุมัติ',
        'ช่วยจัดลำดับรายการรออนุมัติตามวันเริ่มงาน',
        'ดูประวัติการอนุมัติของฉันวันนี้',
      ]));
      for (const item of liveSuggestions) {
        expect(Object.keys(item).sort()).toEqual(['id', 'prompt']);
        expect(item.id).toMatch(/^suggestion_[a-f0-9]+$/);
        expect(item.prompt.length).toBeGreaterThan(0);
      }

      harness.setNow(new Date(Date.parse(live.snapshot.expiresAt) + 1).toISOString());
      await expectNoSuggestionsOrClosedSnapshotError(projectWorkflowSuggestions(harness.runtime, director.sessionId, harness.availability,
        followUpContext(director.conversationId, { snapshotId: live.snapshot.id })));
      harness.setNow(NOW);

      await approveDirectorQueue(harness, live.snapshot.id, requests);
      const empty = await harness.queries.directorQueue(director.sessionId);
      expect(empty.items).toHaveLength(0);
      await expectNoSuggestionsOrClosedSnapshotError(projectWorkflowSuggestions(harness.runtime, director.sessionId, harness.availability,
        followUpContext(director.conversationId, { snapshotId: empty.snapshot.id })));
    });
  });

  it('keeps an approved dashboard follow-up on its exact dashboard and branch and excludes unauthorized or completed actions', async () => {
    await withHarness(async harness => {
      const shareA = await harness.createShare(harness.dashboardAId, 'dashboard-a');
      const shareB = await harness.createShare(harness.dashboardBId, 'dashboard-b');
      const executive = harness.actors.executive;
      const payload: WorkflowPayloadV2 = { kind: 'dashboard_share_revoke', shareId: shareA.id };
      const selection = { candidatePayloads: [payload] };
      const dashboardAContext = followUpContext(executive.conversationId, {
        dashboardId: harness.dashboardAId, branchIds: [harness.branchAId],
      });

      const matched = await projectWorkflowSuggestions(harness.runtime, executive.sessionId, harness.availability,
        dashboardAContext, selection);
      expect(hasPrompt(matched, DASHBOARD_REVOKE_PROMPT)).toBe(true);
      expect(matched.every(item => Object.keys(item).sort().join(',') === 'id,prompt')).toBe(true);

      const otherDashboard = await projectWorkflowSuggestions(harness.runtime, executive.sessionId, harness.availability,
        followUpContext(executive.conversationId, { dashboardId: harness.dashboardBId, branchIds: [harness.branchBId] }), selection);
      expect(hasPrompt(otherDashboard, DASHBOARD_REVOKE_PROMPT)).toBe(false);

      const revokeTurn = `suggestion-complete-revoke-${randomUUID()}`;
      const prepared = await harness.runtime.prepare(executive.sessionId,
        { kind: 'dashboard_share_revoke', shareId: shareB.id },
        { conversationId: executive.conversationId, turnId: revokeTurn });
      const action = prepared.pendingAction;
      if (!action) throw new Error('Expected a real revoke action for the completed-action exclusion fixture');
      const completed = await harness.runner.confirm(executive.sessionId, action.id, `suggestion-complete-${randomUUID()}`, {
        conversationId: action.conversationId, turnId: action.turnId,
      });
      expect(completed.error).toBeNull();
      expect(completed.receipt?.outcome).toBe('verified_success');

      const completedSuggestions = await projectWorkflowSuggestions(harness.runtime, executive.sessionId, harness.availability,
        { ...dashboardAContext, completedActionIds: [action.id] }, selection);
      expect(hasPrompt(completedSuggestions, DASHBOARD_REVOKE_PROMPT)).toBe(false);

      const invalidTarget = await projectWorkflowSuggestions(harness.runtime, executive.sessionId, harness.availability,
        followUpContext(executive.conversationId, { dashboardId: harness.dashboardBId, branchIds: [harness.branchBId] }),
        { candidatePayloads: [{ kind: 'dashboard_share_revoke', shareId: shareB.id }] });
      expect(hasPrompt(invalidTarget, DASHBOARD_REVOKE_PROMPT)).toBe(false);

      const profile = await harness.fixture.store.get<Profile>('profiles', executive.profileId);
      if (!profile) throw new Error('Expected the executive profile to remain readable');
      await harness.fixture.store.transaction(tx => tx.put('profiles', {
        ...profile, permissions: profile.permissions.filter(permission => permission !== 'dashboard.share'),
      }));
      const unauthorized = await projectWorkflowSuggestions(harness.runtime, executive.sessionId, harness.availability,
        dashboardAContext, selection);
      expect(hasPrompt(unauthorized, DASHBOARD_REVOKE_PROMPT)).toBe(false);
    });
  });

  it('matches a Director prepare hint to the selected snapshot, request, employee, and branch', async () => {
    await withHarness(async harness => {
      const requests = await Promise.all(['one', 'two', 'three', 'four'].map(label => harness.addRequest(label)));
      await approveManagerQueue(harness, requests);
      const director = harness.actors.director;
      const snapshotA = await harness.queries.directorQueue(director.sessionId);
      const snapshotB = await harness.queries.directorQueue(director.sessionId);
      const target = requests[0];
      const other = requests[1];
      const payload: WorkflowPayloadV2 = {
        kind: 'onboarding_director_approve', snapshotId: snapshotA.snapshot.id, requestIds: [target.requestId],
      };
      const selection = { candidatePayloads: [payload] };
      const targetContext = followUpContext(director.conversationId, {
        snapshotId: snapshotA.snapshot.id, requestId: target.requestId, employeeId: target.employeeId,
        branchIds: [harness.branchAId],
      });
      const matched = await projectWorkflowSuggestions(harness.runtime, director.sessionId, harness.availability,
        targetContext, selection);
      expect(hasPrompt(matched, DIRECTOR_APPROVE_PROMPT)).toBe(true);

      const requestMismatch = await projectWorkflowSuggestions(harness.runtime, director.sessionId, harness.availability,
        followUpContext(director.conversationId, { snapshotId: snapshotA.snapshot.id, requestId: other.requestId,
          employeeId: other.employeeId, branchIds: [harness.branchAId] }), selection);
      expect(hasPrompt(requestMismatch, DIRECTOR_APPROVE_PROMPT)).toBe(false);

      const employeeMismatch = await projectWorkflowSuggestions(harness.runtime, director.sessionId, harness.availability,
        followUpContext(director.conversationId, { snapshotId: snapshotA.snapshot.id, employeeId: other.employeeId,
          branchIds: [harness.branchAId] }), selection);
      expect(hasPrompt(employeeMismatch, DIRECTOR_APPROVE_PROMPT)).toBe(false);

      const branchMismatch = await projectWorkflowSuggestions(harness.runtime, director.sessionId, harness.availability,
        followUpContext(director.conversationId, { snapshotId: snapshotA.snapshot.id, requestId: target.requestId,
          employeeId: target.employeeId, branchIds: [harness.branchBId] }), selection);
      expect(hasPrompt(branchMismatch, DIRECTOR_APPROVE_PROMPT)).toBe(false);

      const snapshotMismatch = await projectWorkflowSuggestions(harness.runtime, director.sessionId, harness.availability,
        followUpContext(director.conversationId, { snapshotId: snapshotB.snapshot.id, requestId: target.requestId,
          employeeId: target.employeeId, branchIds: [harness.branchAId] }), selection);
      expect(hasPrompt(snapshotMismatch, DIRECTOR_APPROVE_PROMPT)).toBe(false);
    });
  });
});
