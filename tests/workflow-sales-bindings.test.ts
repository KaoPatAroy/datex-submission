import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { DashboardSpec, Profile } from '../lib/contracts';
import { readWorkflowEvidence } from '../lib/packs/retail/workflow-evidence';
import { createSalesWorkflowBindings } from '../lib/packs/sales-workflows';
import { createWorkflowSqliteFixture } from './helpers/workflow-storage';
import { createWorkflowActionRunner } from '../lib/workflows/action-runner';
import { createWorkflowActionRuntime } from '../lib/workflows/action-runtime';
import { createDashboardAccess, type DashboardShareOpenInput, type DashboardShareSigningOptions } from '../lib/workflows/dashboard-access';
import { demoWorkflowPolicyV1, getDemoWorkflowPolicyV1Pin } from '../lib/workflows/policy';
import type {
  GuardedTransaction,
  PreparationResult,
  WorkflowPayloadV2,
} from '../lib/workflows/contracts';
import type { WorkflowTransactionContext } from '../lib/storage/workflow-projections';

const NOW = '2026-10-03T00:00:00.000Z';
const BUSINESS_DATE = NOW.slice(0, 10);
const SALES_PERMISSIONS = [
  'sales.read', 'operations.read', 'dashboard.create', 'dashboard.share',
  'crm.read', 'crm.followup.create', 'discount.request.create'
];
const PACKS = {
  sales: { id: 'sales', version: '1.0', schemaDigest: 'a'.repeat(64), implementationRevision: 'sales-test-r1' },
  operations: { id: 'operations', version: '1.0', schemaDigest: 'b'.repeat(64), implementationRevision: 'operations-test-r1' }
} as const;
const signing: DashboardShareSigningOptions = {
  applicationOrigin: 'https://share-test.biztania.example',
  sessionSigningSecrets: new Map([[1, new Uint8Array(32).fill(0x5a)]]),
  allowedKeyVersions: [1]
};

type Fixture = Awaited<ReturnType<typeof createWorkflowSqliteFixture>>;
type Prepared = { result: PreparationResult; operation: { conversationId: string; turnId: string } };
type DiscountRequestBody = {
  id: string; opportunityId: string; ownerIdentityId: string; status: string;
  discountBasisPoints: number; baseAmountSatang: number; reason: string; executionId: string;
};
type Harness = Awaited<ReturnType<typeof createSalesHarness>>;

function assertWorkflowTransactionContext(tx: GuardedTransaction): asserts tx is WorkflowTransactionContext {
  if (!('workflowProjectionReader' in tx)) throw new Error('The SQLite workflow transaction omitted its projected reader.');
  const reader = tx.workflowProjectionReader;
  if (typeof reader !== 'object' || reader === null ||
    typeof Reflect.get(reader, 'get') !== 'function' || typeof Reflect.get(reader, 'query') !== 'function') {
    throw new Error('The SQLite workflow transaction projected reader is invalid.');
  }
}

function expectPending(
  prepared: Prepared,
  diagnosticLabel = 'Sales action',
  diagnosticTrace?: unknown
): NonNullable<PreparationResult['pendingAction']> {
  const diagnostic = {
    label: diagnosticLabel,
    outcome: prepared.result.outcome,
    reasons: prepared.result.reasons.map(({ code, targetId }) => ({ code, targetId })),
    ...(diagnosticTrace === undefined ? {} : { trace: diagnosticTrace })
  };
  expect(prepared.result.outcome, JSON.stringify(diagnostic)).toBe('pending');
  if (!prepared.result.pendingAction) throw new Error('Expected an immutable pending Sales action.');
  return prepared.result.pendingAction;
}

function signedOpenInput(recovery: { shareId: string; url: string }, sessionId: string): DashboardShareOpenInput {
  const url = new URL(recovery.url);
  const version = url.searchParams.get('v');
  const signature = url.searchParams.get('sig');
  if (!version || !signature) throw new Error('The recovered share URL did not contain its signed grant fields.');
  return { sessionId, grantId: recovery.shareId, keyVersion: Number(version), signature };
}

async function expectDeniedWithoutView(access: ReturnType<typeof createDashboardAccess>, input: DashboardShareOpenInput): Promise<void> {
  const result = await access.open(input).then(
    value => ({ ok: true as const, value }),
    error => ({ ok: false as const, error })
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('A denied share open returned a dashboard view.');
  expect(result.error).toMatchObject({ status: 403 });
  expect('value' in result).toBe(false);
}

async function createSalesHarness(): Promise<{
  fixture: Fixture;
  sessionId: string;
  recipientSessionId: string;
  outsiderSessionId: string;
  ownerProfileId: string;
  ownerIdentityId: string;
  ownerResponsibilityId: string;
  orgUnitId: string;
  recipientIdentityId: string;
  recipientResponsibilityId: string;
  recipientBranchId: string;
  otherBranchId: string;
  dashboardSpec: DashboardSpec;
  opportunityId: string;
  signing: DashboardShareSigningOptions;
  runtime: ReturnType<typeof createWorkflowActionRuntime>;
  runner: ReturnType<typeof createWorkflowActionRunner>;
  loss: { armAfterTransactions(count: number): void; lostResponses(): number };
  lastEvidenceDiagnostic(): unknown;
  now(): Date;
  setNow(value: string): void;
  prepare(payload: WorkflowPayloadV2): Promise<Prepared>;
  confirm(prepared: Prepared): ReturnType<ReturnType<typeof createWorkflowActionRunner>['confirm']>;
  dispose(): Promise<void>;
}> {
  const fixture = await createWorkflowSqliteFixture();
  const suffix = randomUUID().replaceAll('-', '');
  const ownerProfileId = `sales-owner-profile-${suffix}`;
  const ownerIdentityId = `sales-owner-identity-${suffix}`;
  const ownerSessionId = `sales-owner-session-${suffix}`;
  const ownerResponsibilityId = `sales-owner-responsibility-${suffix}`;
  const recipientProfileId = `sales-recipient-profile-${suffix}`;
  const recipientIdentityId = `sales-recipient-identity-${suffix}`;
  const recipientSessionId = `sales-recipient-session-${suffix}`;
  const recipientResponsibilityId = `sales-recipient-responsibility-${suffix}`;
  const outsiderProfileId = `sales-outsider-profile-${suffix}`;
  const outsiderIdentityId = `sales-outsider-identity-${suffix}`;
  const outsiderSessionId = `sales-outsider-session-${suffix}`;
  const outsiderResponsibilityId = `sales-outsider-responsibility-${suffix}`;
  const orgUnitId = `sales-org-${suffix}`;
  const recipientBranchId = `sales-branch-east-${suffix}`;
  const otherBranchId = `sales-branch-west-${suffix}`;
  const conversationId = `sales-conversation-${suffix}`;
  const opportunityId = `sales-opportunity-${suffix}`;
  let currentTime = new Date(NOW);
  let lastEvidenceDiagnostic: unknown;
  let turn = 0;
  let correlation = 0;
  let generatedId = 0;
  let transactionsBeforeLostResponse: number | null = null;
  let lostResponseCount = 0;

  try {
    const policyPin = getDemoWorkflowPolicyV1Pin();
    await fixture.store.workflowTransaction(tx => tx.insertUnique('org_units', {
      id: orgUnitId, name: `Synthetic sales org ${suffix}`, parentOrgUnitId: null, active: true
    }, { constraint: 'org_units_primary_key', values: { id: orgUnitId } }).then(() => undefined));

    const owner: Profile = {
      id: ownerProfileId, name: 'Synthetic Executive', role: 'executive', active: true,
      permissions: [...SALES_PERMISSIONS], regions: ['east']
    };
    const recipient: Profile = {
      id: recipientProfileId, name: 'Synthetic East Manager', role: 'east_manager', active: true,
      permissions: ['sales.read', 'operations.read'], regions: ['east']
    };
    const outsider: Profile = {
      id: outsiderProfileId, name: 'Synthetic Other Manager', role: 'east_manager', active: true,
      permissions: ['sales.read', 'operations.read'], regions: ['east']
    };
    await fixture.store.transaction(async tx => {
      for (const profile of [owner, recipient, outsider]) await tx.put('profiles', profile);
      await tx.put('sessions', {
        id: ownerSessionId, profileId: ownerProfileId, mode: 'scripted_demo', modeRevision: 1,
        csrfToken: `csrf-owner-${suffix}`, expiresAt: '2099-01-01T00:00:00.000Z'
      });
      await tx.put('sessions', {
        id: recipientSessionId, profileId: recipientProfileId, mode: 'scripted_demo', modeRevision: 1,
        csrfToken: `csrf-recipient-${suffix}`, expiresAt: '2099-01-01T00:00:00.000Z'
      });
      await tx.put('sessions', {
        id: outsiderSessionId, profileId: outsiderProfileId, mode: 'scripted_demo', modeRevision: 1,
        csrfToken: `csrf-outsider-${suffix}`, expiresAt: '2099-01-01T00:00:00.000Z'
      });
      await tx.put('branches', { id: recipientBranchId, name: 'East branch A', region: 'east', orgUnitId, active: true });
      await tx.put('branches', { id: otherBranchId, name: 'East branch B', region: 'east', orgUnitId, active: true });
      await tx.put('sales_orders', {
        id: `sales-order-recipient-${suffix}`, branchId: recipientBranchId, date: BUSINESS_DATE,
        amountSatang: 10_000, status: 'paid', updatedAt: NOW
      });
      await tx.put('sales_targets', {
        id: `sales-target-recipient-${suffix}`, branchId: recipientBranchId, date: BUSINESS_DATE,
        amountSatang: 12_000, updatedAt: NOW
      });
      await tx.put('sales_orders', {
        id: `sales-order-outside-${suffix}`, branchId: otherBranchId, date: BUSINESS_DATE,
        amountSatang: 999_999, status: 'paid', updatedAt: NOW
      });
      await tx.put('sales_targets', {
        id: `sales-target-outside-${suffix}`, branchId: otherBranchId, date: BUSINESS_DATE,
        amountSatang: 999_999, updatedAt: NOW
      });
    });

    await fixture.store.workflowTransaction(async tx => {
      const insertIdentity = async (input: {
        id: string; profileId: string; displayName: string; role: 'executive' | 'east_manager'; email: string
      }) => tx.insertUnique('directory_identities', {
        id: input.id, profileId: input.profileId, displayName: input.displayName, active: true,
        role: input.role, department: 'sales_operations', orgUnitId, managerIdentityId: null,
        verifiedDemoEmail: input.email, slackIdentity: `synthetic-${input.id}`,
        allowedChannels: ['simulated_email', 'simulated_slack'], classificationCeiling: 'internal', rowVersion: 1
      }, { constraint: 'directory_identities_primary_key', values: { id: input.id } });
      const insertResponsibility = async (id: string, identityId: string, branchIds: string[]) =>
        tx.insertUnique('responsibilities', {
          id, identityId, orgUnitId, purpose: 'sales_operations', branchIds, active: true, rowVersion: 1
        }, { constraint: 'responsibilities_open_identity_purpose_unique', values: { identityId, purpose: 'sales_operations', orgUnitId } });

      await insertIdentity({ id: ownerIdentityId, profileId: ownerProfileId, displayName: owner.name,
        role: 'executive', email: `owner-${suffix}@example.invalid` });
      await insertIdentity({ id: recipientIdentityId, profileId: recipientProfileId, displayName: recipient.name,
        role: 'east_manager', email: `recipient-${suffix}@example.invalid` });
      await insertIdentity({ id: outsiderIdentityId, profileId: outsiderProfileId, displayName: outsider.name,
        role: 'east_manager', email: `outsider-${suffix}@example.invalid` });
      await insertResponsibility(ownerResponsibilityId, ownerIdentityId, [recipientBranchId, otherBranchId]);
      await insertResponsibility(recipientResponsibilityId, recipientIdentityId, [recipientBranchId]);
      await insertResponsibility(outsiderResponsibilityId, outsiderIdentityId, [otherBranchId]);
      await tx.insertUnique('workflow_policies', {
        id: policyPin.id, version: policyPin.version, digest: policyPin.digest, policy: demoWorkflowPolicyV1
      }, { constraint: 'workflow_policies_primary_key', values: { id: policyPin.id } });
      await tx.insertUnique('conversations', {
        id: conversationId, actorId: ownerProfileId, title: 'Synthetic Sales action test', pinned: false,
        archivedAt: null, rowVersion: 1, createdAt: NOW, updatedAt: NOW, lastScope: null, lastDashboardId: null
      }, { constraint: 'conversations_primary_key', values: { id: conversationId } });
      await tx.insertUnique('crm_customers', {
        id: `sales-customer-${suffix}`, rowVersion: 1, ownerIdentityId, status: 'active',
        name: 'Synthetic customer', region: 'east', createdAt: NOW
      }, { constraint: 'crm_customers_primary_key', values: { id: `sales-customer-${suffix}` } });
      await tx.insertUnique('crm_opportunities', {
        id: opportunityId, rowVersion: 1, customerId: `sales-customer-${suffix}`, ownerIdentityId,
        title: 'Synthetic opportunity', stage: 'proposal', amountSatang: 123_456,
        expectedCloseDate: '2026-11-01', createdAt: NOW, updatedAt: NOW
      }, { constraint: 'crm_opportunities_primary_key', values: { id: opportunityId } });
    });

    const loss = {
      armAfterTransactions(count: number) { transactionsBeforeLostResponse = count; },
      lostResponses() { return lostResponseCount; }
    };
    const runtimeStore = new Proxy(fixture.store, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (property !== 'workflowTransaction' || typeof value !== 'function') {
          return typeof value === 'function' ? value.bind(target) : value;
        }
        const original = value.bind(target) as (work: (tx: WorkflowTransactionContext) => Promise<unknown>) => Promise<unknown>;
        return async (work: (tx: WorkflowTransactionContext) => Promise<unknown>) => {
          const result = await original(work);
          if (transactionsBeforeLostResponse !== null) {
            transactionsBeforeLostResponse -= 1;
            if (transactionsBeforeLostResponse === 0) {
              transactionsBeforeLostResponse = null;
              lostResponseCount += 1;
              throw new Error('Synthetic lost response after the committed workflow transaction.');
            }
          }
          return result;
        };
      }
    }) as Fixture['store'];

    const runtime = createWorkflowActionRuntime({
      store: runtimeStore,
      bindings: createSalesWorkflowBindings({ dashboardShareSigning: signing }),
      businessDate: BUSINESS_DATE,
      getReleaseRevision: () => 'sales-bindings-test-release-r1',
      getPackPins: ids => ids.map(id => {
        const pin = PACKS[id as keyof typeof PACKS];
        if (!pin) throw new Error(`Unexpected Sales test pack ${id}`);
        return pin;
      }),
      contextFactory: (_reader, principal, view) => ({
        evidence: async scope => {
          const evidence = await readWorkflowEvidence({ projections: view.projections, principal, now: view.now() }, scope);
          lastEvidenceDiagnostic = {
            requestedScope: structuredClone(scope),
            evidenceScope: structuredClone(evidence.scope),
            branchIds: evidence.branches.map(branch => branch.branchId).sort(),
            version: evidence.version
          };
          return evidence;
        },
        latestDashboard: async () => undefined
      }),
      now: () => new Date(currentTime),
      makeId: prefix => `sales-${prefix}-${suffix}-${++generatedId}`
    });
    const runner = createWorkflowActionRunner(runtime);
    const dashboardSpec: DashboardSpec = {
      title: 'Synthetic East dashboard',
      description: 'Reviewed synthetic branch comparison.',
      scope: { region: 'east', date: BUSINESS_DATE, branchIds: [recipientBranchId, otherBranchId] },
      widgets: [{ type: 'metric', title: 'Net sales', metric: 'net_sales' }]
    };
    const prepare = async (payload: WorkflowPayloadV2): Promise<Prepared> => {
      const operation = { conversationId, turnId: `sales-turn-${suffix}-${++turn}` };
      return { result: await runtime.prepare(ownerSessionId, payload, operation), operation };
    };
    const confirm = (prepared: Prepared) => {
      const action = expectPending(prepared);
      return runner.confirm(ownerSessionId, action.id, `sales-correlation-${suffix}-${++correlation}`, prepared.operation);
    };
    return {
      fixture,
      sessionId: ownerSessionId,
      recipientSessionId,
      outsiderSessionId,
      ownerProfileId,
      ownerIdentityId,
      ownerResponsibilityId,
      orgUnitId,
      recipientIdentityId,
      recipientResponsibilityId,
      recipientBranchId,
      otherBranchId,
      dashboardSpec,
      opportunityId,
      signing,
      runtime,
      runner,
      loss,
      lastEvidenceDiagnostic: () => lastEvidenceDiagnostic,
      now: () => new Date(currentTime),
      setNow(value: string) { currentTime = new Date(value); },
      prepare,
      confirm,
      async dispose() { await fixture.dispose(); }
    };
  } catch (error) {
    await fixture.dispose();
    throw error;
  }
}

async function updateRecipientBranchScope(harness: Harness, branchIds: string[]): Promise<void> {
  const row = await harness.fixture.store.workflowProjectionReader.get<{
    id: string; identityId: string; orgUnitId: string; purpose: string; branchIds: string[]; active: boolean; rowVersion: number
  }>('responsibilities', harness.recipientResponsibilityId);
  if (!row) throw new Error('The synthetic recipient responsibility was not persisted.');
  await harness.fixture.store.workflowTransaction(tx => tx.compareAndSwap('responsibilities', row.id,
    { rowVersion: row.rowVersion, state: 'active' }, { ...row.body, rowVersion: row.rowVersion + 1, branchIds })
    .then(result => {
      if (!result.updated) throw new Error('The synthetic recipient responsibility changed unexpectedly.');
    }));
}

async function changeOpportunityAmount(harness: Harness, amountSatang: number): Promise<void> {
  const row = await harness.fixture.store.workflowProjectionReader.get<{
    id: string; customerId: string; ownerIdentityId: string; title: string; stage: string; amountSatang: number;
    expectedCloseDate?: string | null; createdAt?: string; updatedAt?: string
  }>('crm_opportunities', harness.opportunityId);
  if (!row) throw new Error('The synthetic CRM opportunity was not persisted.');
  await harness.fixture.store.workflowTransaction(tx => tx.compareAndSwap('crm_opportunities', row.id,
    { rowVersion: row.rowVersion, state: row.body.stage }, { ...row.body, rowVersion: row.rowVersion + 1, amountSatang })
    .then(result => {
      if (!result.updated) throw new Error('The synthetic CRM opportunity changed unexpectedly.');
    }));
}

describe('Sales workflow bindings on private SQLite', () => {
  it('creates, recipient-scopes, signs, revokes, expires, and deduplicates dashboard grants without returning denied data', async () => {
    const harness = await createSalesHarness();
    try {
      const dashboard = await harness.prepare({ kind: 'dashboard_create', spec: harness.dashboardSpec });
      const dashboardAction = expectPending(dashboard, 'dashboard_create prepare', {
        requestedScope: harness.dashboardSpec.scope,
        evidence: harness.lastEvidenceDiagnostic()
      });
      const dashboardId = dashboardAction.targets[0]?.expectedEffectRef.id;
      if (!dashboardId) throw new Error('Dashboard preparation omitted its reviewed artifact reference.');
      expect(dashboardAction.approvedBranchIds).toEqual([harness.otherBranchId, harness.recipientBranchId].sort());
      const dashboardResult = await harness.confirm(dashboard);
      expect(dashboardResult.error).toBeNull();
      expect(dashboardResult.receipt).toMatchObject({ kind: 'dashboard_create', outcome: 'verified_success' });
      expect(await harness.fixture.store.workflowProjectionReader.query({
        kind: 'scoped', table: 'dashboards', ownerId: harness.ownerProfileId, limit: 100
      })).toHaveLength(1);
      expect(await harness.fixture.store.workflowProjectionReader.query({
        kind: 'scoped', table: 'dashboard_versions', equals: { dashboardId }, limit: 100
      })).toHaveLength(1);

      const reversed = { ...harness.dashboardSpec, scope: { ...harness.dashboardSpec.scope,
        branchIds: [...harness.dashboardSpec.scope.branchIds!].reverse() } };
      const repeatedDashboard = await harness.prepare({ kind: 'dashboard_create', spec: reversed });
      expect(repeatedDashboard.result).toMatchObject({ outcome: 'already_completed', existingExecutionId: dashboardResult.receipt?.id, pendingAction: null });
      expect(await harness.fixture.store.workflowProjectionReader.query({
        kind: 'scoped', table: 'dashboards', ownerId: harness.ownerProfileId, limit: 100
      })).toHaveLength(1);

      const access = createDashboardAccess({ store: harness.fixture.store, signing: harness.signing,
        now: () => harness.now(), makeId: prefix => `sales-access-${prefix}-${randomUUID().replaceAll('-', '')}` });
      const firstShare = await harness.prepare({ kind: 'dashboard_share', dashboardId,
        recipientIdentityId: harness.recipientIdentityId, channel: 'simulated_email',
        subject: 'Synthetic dashboard review', body: 'Please review the East branch results.' });
      const shareAction = expectPending(firstShare);
      const shareId = shareAction.targets[0]?.expectedEffectRef.id;
      if (!shareId) throw new Error('Share preparation omitted its reviewed grant reference.');
      expect(shareAction.approvedBranchIds).toEqual([harness.recipientBranchId]);
      const shareResult = await harness.confirm(firstShare);
      expect(shareResult.error).toBeNull();
      expect(shareResult.receipt).toMatchObject({ kind: 'dashboard_share', outcome: 'verified_success' });
      const firstGrant = await harness.fixture.store.workflowProjectionReader.get<{
        id: string; status: string; recipientIdentityId: string; approvedBranchIds: string[]; verificationDigest: string
      }>('dashboard_shares', shareId);
      expect(firstGrant?.body).toMatchObject({ status: 'active', recipientIdentityId: harness.recipientIdentityId,
        approvedBranchIds: [harness.recipientBranchId] });
      expect(firstGrant?.body.verificationDigest).toMatch(/^[a-f0-9]{64}$/);
      const firstDelivery = await harness.fixture.store.workflowProjectionReader.query<{
        id: string; shareId: string; status: string; channel: string
      }>({ kind: 'scoped', table: 'simulated_deliveries', equals: { shareId }, limit: 100 });
      expect(firstDelivery.map(row => row.body)).toMatchObject([
        { shareId, status: 'simulated_completed', channel: 'simulated_email' }
      ]);

      const repeatedShare = await harness.prepare({ kind: 'dashboard_share', dashboardId,
        recipientIdentityId: harness.recipientIdentityId, channel: 'simulated_email',
        subject: 'Equivalent repeated request', body: 'A wording change does not resend the same active grant.' });
      expect(repeatedShare.result.outcome).toBe('already_completed');
      expect(await harness.fixture.store.workflowProjectionReader.query({
        kind: 'scoped', table: 'simulated_deliveries', equals: { shareId }, limit: 100
      })).toHaveLength(1);

      const recovered = await access.recover({ sessionId: harness.sessionId, grantId: shareId });
      const recipientInput = signedOpenInput(recovered, harness.recipientSessionId);
      const recipientView = await access.open(recipientInput);
      expect(recipientView.currentScope.branchIds).toEqual([harness.recipientBranchId]);
      expect(recipientView.branches.map(branch => branch.branchId)).toEqual([harness.recipientBranchId]);
      expect(recipientView.totals.netSales).toBe(100);
      expect(recipientView.totals.netSales).not.toBe(10_099.99);
      await expectDeniedWithoutView(access, signedOpenInput(recovered, harness.outsiderSessionId));

      await updateRecipientBranchScope(harness, [harness.otherBranchId]);
      await expectDeniedWithoutView(access, recipientInput);

      const revoke = await harness.prepare({ kind: 'dashboard_share_revoke', shareId });
      expectPending(revoke);
      const revokeResult = await harness.confirm(revoke);
      expect(revokeResult.error).toBeNull();
      expect(revokeResult.receipt).toMatchObject({ kind: 'dashboard_share_revoke', outcome: 'verified_success' });
      const revokedGrant = await harness.fixture.store.workflowProjectionReader.get<{ status: string; revokedAt: string | null }>(
        'dashboard_shares', shareId);
      expect(revokedGrant?.body).toMatchObject({ status: 'revoked', revokedAt: NOW });
      await expectDeniedWithoutView(access, recipientInput);

      const expiring = await harness.prepare({ kind: 'dashboard_share', dashboardId,
        recipientIdentityId: harness.recipientIdentityId, channel: 'simulated_slack',
        subject: 'Synthetic Slack preview', body: 'This is a persisted simulated delivery.' });
      const expiringAction = expectPending(expiring);
      const expiringShareId = expiringAction.targets[0]?.expectedEffectRef.id;
      if (!expiringShareId) throw new Error('The second share omitted its reviewed grant reference.');
      const expiringResult = await harness.confirm(expiring);
      expect(expiringResult.receipt).toMatchObject({ outcome: 'verified_success' });
      const expiringGrant = await harness.fixture.store.workflowProjectionReader.get<{ expiresAt: string }>(
        'dashboard_shares', expiringShareId);
      if (!expiringGrant) throw new Error('The expiring synthetic grant was not persisted.');
      const expiringInput = signedOpenInput(
        await access.recover({ sessionId: harness.sessionId, grantId: expiringShareId }), harness.recipientSessionId);
      harness.setNow(expiringGrant.body.expiresAt);
      await expectDeniedWithoutView(access, expiringInput);

      const events = await harness.fixture.store.workflowProjectionReader.query<{ event: string; outcome: string }>({
        kind: 'scoped', table: 'share_access_events', equals: { shareId }, limit: 100
      });
      expect(events.map(row => row.body.event)).toEqual(expect.arrayContaining(['opened', 'denied', 'revoked']));
      const expiryEvents = await harness.fixture.store.workflowProjectionReader.query<{ event: string }>({
        kind: 'scoped', table: 'share_access_events', equals: { shareId: expiringShareId }, limit: 100
      });
      expect(expiryEvents.map(row => row.body.event)).toContain('expired');
      expect(await harness.fixture.store.workflowProjectionReader.query({
        kind: 'scoped', table: 'simulated_deliveries', status: 'simulated_completed', limit: 100
      })).toHaveLength(2);
    } finally {
      await harness.dispose();
    }
  });

  it('rechecks CRM authority, rejects an equivalent open follow-up through scoped.equals, and reads back the approved discount basis once', async () => {
    const harness = await createSalesHarness();
    try {
      const followupPayload: Extract<WorkflowPayloadV2, { kind: 'crm_followup_create' }> = {
        kind: 'crm_followup_create', targets: [{ opportunityId: harness.opportunityId,
          ownerIdentityId: harness.ownerIdentityId, reason: 'Review the open synthetic proposal.',
          dueDate: '2026-10-06', priority: 'normal' }]
      };
      const followup = await harness.prepare(followupPayload);
      const followupAction = expectPending(followup);
      expect(followupAction.approvedOrgUnitIds).toEqual([harness.orgUnitId]);
      expect(followupAction.expectedRows).toEqual(expect.arrayContaining([
        expect.objectContaining({ ref: { table: 'crm_opportunities', id: harness.opportunityId }, rowVersion: 1, state: 'proposal' }),
        expect.objectContaining({ ref: { table: 'directory_identities', id: harness.ownerIdentityId }, rowVersion: 1 }),
        expect.objectContaining({ ref: { table: 'responsibilities', id: harness.ownerResponsibilityId }, rowVersion: 1, state: 'active' }),
        expect.objectContaining({ ref: { table: 'org_units', id: harness.orgUnitId }, rowVersion: 1, state: 'active' })
      ]));
      await harness.fixture.store.transaction(async tx => {
        const profile = await tx.get<Profile>('profiles', harness.ownerProfileId);
        if (!profile) throw new Error('The synthetic Sales actor profile disappeared.');
        await tx.put('profiles', { ...profile, permissions: profile.permissions.filter(permission => permission !== 'crm.followup.create') });
      });
      const deniedByCurrentAuthority = await harness.confirm(followup);
      expect(deniedByCurrentAuthority.receipt).toBeNull();
      expect(deniedByCurrentAuthority.error).toMatchObject({ outcome: 'denied', retryBusinessWrite: false });
      expect(await harness.fixture.store.workflowProjectionReader.query({
        kind: 'scoped', table: 'crm_followups', equals: { opportunityId: harness.opportunityId }, limit: 100
      })).toHaveLength(0);
      await harness.fixture.store.transaction(async tx => {
        const profile = await tx.get<Profile>('profiles', harness.ownerProfileId);
        if (!profile) throw new Error('The synthetic Sales actor profile disappeared.');
        await tx.put('profiles', { ...profile, permissions: [...SALES_PERMISSIONS] });
      });
      const followupResult = await harness.confirm(followup);
      expect(followupResult.error).toBeNull();
      expect(followupResult.receipt).toMatchObject({ kind: 'crm_followup_create', outcome: 'verified_success' });
      expect(followupResult.receipt?.proofs).toHaveLength(1);
      const opened = await harness.fixture.store.workflowProjectionReader.query<{
        id: string; opportunityId: string; status: string; ownerIdentityId: string
      }>({ kind: 'scoped', table: 'crm_followups', equals: { opportunityId: harness.opportunityId }, limit: 100 });
      expect(opened).toHaveLength(1);
      expect(opened[0]?.body).toMatchObject({ status: 'open', ownerIdentityId: harness.ownerIdentityId });
      const followupTarget = followupPayload.targets[0];
      if (!followupTarget) throw new Error('The CRM fixture omitted its reviewed follow-up target.');

      await expect(harness.fixture.store.workflowTransaction(async tx => {
        assertWorkflowTransactionContext(tx);
        const context = await harness.runtime.context(tx, harness.sessionId);
        return harness.runtime.binding('crm_followup_create').validate(context, {
          ...followupPayload,
          targets: [{ ...followupTarget, reason: 'A changed reason must still find the open equivalent.' }]
        });
      })).rejects.toMatchObject({ code: 'WORKFLOW_CONFLICT' });
      const equivalentFollowup = await harness.prepare({
        ...followupPayload,
        targets: [{ ...followupTarget, reason: 'A retry must not create another follow-up.' }]
      });
      expect(equivalentFollowup.result).toMatchObject({ outcome: 'already_completed', pendingAction: null,
        existingExecutionId: followupResult.receipt?.id });
      expect(await harness.fixture.store.workflowProjectionReader.query({
        kind: 'scoped', table: 'crm_followups', equals: { opportunityId: harness.opportunityId }, limit: 100
      })).toHaveLength(1);
      expect(followupAction.payload.kind).toBe('crm_followup_create');

      const staleDiscount = await harness.prepare({ kind: 'discount_request_create', opportunityId: harness.opportunityId,
        requestedBasisPoints: 800, baseAmountSatang: 123_456, reason: 'Synthetic manager approval request.',
        ownerIdentityId: harness.ownerIdentityId });
      const staleDiscountAction = expectPending(staleDiscount);
      expect(staleDiscountAction.payload).toMatchObject({ kind: 'discount_request_create', baseAmountSatang: 123_456 });
      const staleDiscountTarget = staleDiscountAction.targets.find(target =>
        target.ref.table === 'crm_opportunities' && target.ref.id === harness.opportunityId);
      if (!staleDiscountTarget) throw new Error('Discount review omitted its exact CRM opportunity target.');
      expect(staleDiscountTarget.expectedRows).toContainEqual(expect.objectContaining({
        ref: { table: 'crm_opportunities', id: harness.opportunityId }, rowVersion: 1, state: 'proposal'
      }));
      await changeOpportunityAmount(harness, 124_001);
      const staleResult = await harness.confirm(staleDiscount);
      expect(staleResult.receipt).toBeNull();
      expect(staleResult.error).toMatchObject({ outcome: 'stale', nextStep: 'refresh_review', retryBusinessWrite: false });
      expect(await harness.fixture.store.workflowProjectionReader.query({
        kind: 'scoped', table: 'discount_requests', equals: { opportunityId: harness.opportunityId }, limit: 100
      })).toHaveLength(0);

      const approvedBasis = 124_001;
      const discount = await harness.prepare({ kind: 'discount_request_create', opportunityId: harness.opportunityId,
        requestedBasisPoints: 800, baseAmountSatang: approvedBasis, reason: 'Request review against the refreshed amount.',
        ownerIdentityId: harness.ownerIdentityId });
      const discountAction = expectPending(discount);
      expect(discountAction.payload).toMatchObject({ baseAmountSatang: approvedBasis });
      harness.loss.armAfterTransactions(2);
      const unknown = await harness.confirm(discount);
      expect(harness.loss.lostResponses()).toBe(1);
      expect(unknown.receipt).toBeNull();
      expect(unknown.error).toMatchObject({ outcome: 'pending', commitCertainty: 'unknown',
        domainEffect: 'unknown', operationPhase: 'effect', nextStep: 'readback_existing', retryBusinessWrite: false });

      const recovered = await harness.confirm(discount);
      expect(recovered.error).toBeNull();
      expect(recovered.receipt).toMatchObject({ kind: 'discount_request_create', outcome: 'verified_success' });
      expect(recovered.receipt?.proofs).toHaveLength(1);
      const discounts = await harness.fixture.store.workflowProjectionReader.query<DiscountRequestBody>({
        kind: 'scoped', table: 'discount_requests', equals: { opportunityId: harness.opportunityId }, limit: 100
      });
      expect(discounts).toHaveLength(1);
      expect(discounts[0]?.body).toMatchObject({ status: 'manager_review_pending', baseAmountSatang: approvedBasis,
        discountBasisPoints: 800, executionId: recovered.receipt?.id });
      if (!discounts[0]) throw new Error('The independently read discount request disappeared.');
      await expect(harness.fixture.store.workflowTransaction(tx => tx.compareAndSwap('discount_requests', discounts[0].id,
        { rowVersion: discounts[0].rowVersion, state: 'manager_review_pending' },
        { ...discounts[0].body, rowVersion: discounts[0].rowVersion + 1, baseAmountSatang: approvedBasis + 1 })))
        .rejects.toMatchObject({ code: 'STORAGE' });
      const immutableDiscount = await harness.fixture.store.workflowProjectionReader.get<DiscountRequestBody>(
        'discount_requests', discounts[0].id);
      expect(immutableDiscount?.body.baseAmountSatang).toBe(approvedBasis);
      expect(await harness.fixture.store.workflowProjectionReader.query({
        kind: 'scoped', table: 'action_executions', equals: { actionId: discountAction.id }, limit: 100
      })).toHaveLength(1);
    } finally {
      await harness.dispose();
    }
  });
});
