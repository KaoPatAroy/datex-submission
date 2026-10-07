import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/core/turn-completion-gate', () => ({ readCompletedTurn: async () => ({ kind: 'completed' }) }));

import type { Actor, Branch } from '@/lib/contracts';
import { createSemanticCatalog } from '@/lib/dynamic/catalog/semantic';
import { TABLE_DATASET_IDS } from '@/lib/dynamic/catalog/tables';
import { CAPABILITY_AREAS } from '@/lib/dynamic/response/conversational';
import { defaultRuntimes } from '@/lib/core/runtime-catalog';
import { showcase, roleShowcase } from '@/lib/demo/showcase';
import { bindWorkCatalogEntry } from '@/lib/router/demo-plans';
import { buildWorkspaceActionCatalog } from '@/lib/core/action-catalog';
import { ACTION_COPY } from '@/lib/router/action-copy';
import { actionRegistry, holdsActionPermissions } from '@/lib/router/action-registry';
import { createPolicyAckEffects } from '@/lib/router/ports/policy-ack';
import { prepareTableArtifact } from '@/lib/artifacts/table-prepare';
import { authority as queryAuthority } from '@/lib/dynamic/runtime';
import { buildDashboardSpecFromTablePlan } from '@/lib/visualization/dashboard-table';
import { bindServerSelectors } from '@/lib/core/router-turn';
import { buildPlannerContext } from '@/lib/router/context/build-context';
import { executeHrQueryStep } from '@/lib/router/executors/hr';
import { executePolicyReadStep } from '@/lib/router/executors/policy';
import { executeActionStep } from '@/lib/router/executors/action';
import { fakePorts, grounded } from '../router/executors/action-fixtures';
import { executeQueryStep } from '@/lib/router/executors/query';
import { executeTableQueryStep } from '@/lib/router/executors/table-query';
import { capabilityText } from '@/lib/router/render';
import { validateTurnPlan } from '@/lib/router/validate';
import { proposal } from '../dynamic/fixtures';
import { hrPlan } from '../dynamic/wave2/fixtures';
import { read } from '../router/executors/fixtures';
import { actors, BUSINESS_DATE, FIXED_NOW, seedTables, tableFixtureCleanup, tableFixtures, tableBase, tDimension, tMeasure, tablePlan, type TableFixture } from '../router/executors/table-fixtures';

/**
 * PARITY-001: every capability the product ADVERTISES to an actor (datasets in the planner catalog, registered actions, work-catalog
 * entries, demo showcase cards, capability text, policies) has an authorized, working registered backend path for that role, and
 * nothing is advertised without one. The matrix of what each advertised item maps to is docs/REQUIREMENT_GAP_AUDIT.md.
 * Artifact / visualization / action-effect / communication / monitor rows are lane C and are only checked for registration here.
 */
let fixture: TableFixture;
beforeEach(async () => {
  fixture = await tableFixtures(await seedTables({ incidents: 3 }));
  await fixture.store.transaction(async tx => {
    await tx.put('policy_documents', { id: 'POL-OPS-001', title: 'Incident handling', version: '1.0', text: 'Document the branch.', updatedAt: '2026-10-01T10:00:00+07:00' });
    await tx.put('policy_documents', { id: 'POL-HR-001', title: 'Badge revocation', version: '1.0', text: 'Needs a reason.', updatedAt: '2026-10-01T10:00:00+07:00' });
    const east = await tx.get<Record<string, unknown> & { id: string }>('profiles', 'east');
    await tx.put('profiles', { ...east!, permissions: [...(east!.permissions as string[]), 'hr.read'] });
  });
});
afterEach(async () => { await tableFixtureCleanup(); });

const ROLES = [['executive', actors.executive], ['east', actors.east], ['hr', actors.hr]] as const;

async function contextFor(actor: Actor) {
  const live = await fixture.store.get<Actor & { permissions: string[] }>('profiles', actor.id);
  const current = { ...actor, permissions: live!.permissions };
  const catalog = createSemanticCatalog(await fixture.store.list<Branch>('branches'));
  const context = await buildPlannerContext({ store: fixture.store, actor: current, conversationId: 'parity', businessDate: BUSINESS_DATE, catalog,
    registry: actionRegistry, recipientAllowed: async () => true, now: () => FIXED_NOW.getTime() });
  return { actor: current, catalog, context };
}

/** The executor path each dataset id is served by. A new dataset without an entry here fails the parity test. */
async function runDataset(datasetId: string, actor: Actor, catalog: ReturnType<typeof createSemanticCatalog>) {
  const message = 'parity probe';
  if (datasetId === 'branch_performance') return executeQueryStep({ ...tableBase(fixture, actor, message), read, step: { kind: 'query', continuation: false, plan: proposal(message) } } as never);
  if (datasetId === 'hr_employees') return executeHrQueryStep({ ...tableBase(fixture, actor, message), step: { kind: 'hr_query', plan: hrPlan(message) } } as never);
  if (TABLE_DATASET_IDS.includes(datasetId)) {
    const dataset = catalog.datasets.find(d => d.id === datasetId)!;
    const measure = dataset.fields.find(f => f.id === dataset.defaultMeasure)!;
    const plan = tablePlan(datasetId, { measures: [tMeasure(measure.id, measure.aggregations[0])], dimensions: dataset.defaultDimensions.map(id => tDimension(id)),
      group: { fieldIds: [...dataset.defaultDimensions] } } as never);
    return executeTableQueryStep({ ...tableBase(fixture, actor, message), step: { kind: 'query', continuation: false, plan } } as never);
  }
  throw new Error(`Dataset ${datasetId} is advertised but has no registered executor in the parity matrix`);
}

describe.each(ROLES)('capability parity: %s', (_name, baseActor) => {
  it('every advertised dataset runs through its registered executor for this role', async () => {
    const { actor, catalog, context } = await contextFor(baseActor);
    expect(context.catalog.datasets.length).toBeGreaterThan(0);
    for (const dataset of context.catalog.datasets) {
      const result = await runDataset(dataset.id, actor, catalog);
      expect(result.outcome, `${dataset.id} -> ${JSON.stringify((result as { code?: string }).code)}`).toBe('accepted');
      expect(dataset.suggestions?.length, `${dataset.id} has derived suggestions`).toBeGreaterThan(0);
    }
  });

  it('datasets the role may not read are not advertised (no advertising without authority)', async () => {
    const { actor, catalog, context } = await contextFor(baseActor);
    const advertised = new Set(context.catalog.datasets.map(d => d.id));
    for (const dataset of catalog.datasets) {
      const allowed = dataset.requiredPermissions.every(p => actor.permissions.includes(p));
      expect(advertised.has(dataset.id), dataset.id).toBe(allowed);
    }
    expect(advertised.has('hr_employees')).toBe(actor.permissions.includes('hr.read'));
  });

  it('every advertised action is registered, has product copy, and is permitted for this role', async () => {
    const { actor, context } = await contextFor(baseActor);
    for (const action of context.actions) {
      const definition = actionRegistry.get(action.actionId);
      expect(definition, action.actionId).toBeTruthy();
      expect(holdsActionPermissions(definition!, actor.permissions)).toBe(true);
      expect(ACTION_COPY[action.actionId], `copy for ${action.actionId}`).toBeTruthy();
    }
  });

  it('every work-catalog entry shown to this role binds to a server plan that the TurnPlan validator accepts or clarifies', async () => {
    const { actor, context } = await contextFor(baseActor);
    const workspace = await fixture.service.getWorkspace(actor);
    for (const entry of workspace.actionCatalog ?? []) {
      const bound = bindWorkCatalogEntry(entry);
      expect(bound, `catalog entry ${entry.id} has a registered plan`).toBeTruthy();
      const checked = validateTurnPlan({ raw: bindServerSelectors(bound!.plan, { latestOwnedDashboardId: 'DB_X' }), messages: { current: entry.prompt }, context: { ...context, dashboards: [{ id: 'DB_X', title: 'x' }] }, registry: actionRegistry,
        hooks: { permitAction: () => true } });
      // '@latest_owned_dashboard' is a server selector bound at routing time; it is the only placeholder allowed here.
      if (checked.outcome === 'denied') expect(checked.code, entry.id).not.toMatch(/unknown_action|permission_denied|dataset_unavailable|invalid_plan/);
    }
  });

  it('every demo showcase card of this role has a plan the validator accepts or clarifies', async () => {
    const { context } = await contextFor(baseActor);
    for (const card of roleShowcase(baseActor.role)) {
      const checked = validateTurnPlan({ raw: bindServerSelectors(card.plan, { latestOwnedDashboardId: 'DB_X' }), messages: { current: card.prompt }, context: { ...context, dashboards: [{ id: 'DB_X', title: 'x' }] }, registry: actionRegistry });
      if (checked.outcome === 'denied') expect(['unknown_clarify_target']).not.toContain(checked.code);
      expect(checked.outcome, `${card.id} ${JSON.stringify(checked)}`).not.toBe('denied');
    }
  });

  it('the capability text names exactly the datasets and actions this role holds', async () => {
    const { catalog, context } = await contextFor(baseActor);
    const text = capabilityText(context, { greeting: false });
    for (const dataset of context.catalog.datasets) expect(text).toContain(dataset.label);
    for (const dataset of catalog.datasets) if (!context.catalog.datasets.some(d => d.id === dataset.id) && dataset.label) expect(text).not.toContain(dataset.label);
    for (const action of context.actions) expect(text).toContain(ACTION_COPY[action.actionId].capability);
    for (const [id, copy] of Object.entries(ACTION_COPY)) if (!context.actions.some(a => a.actionId === id)) {
      const duplicated = context.actions.some(a => ACTION_COPY[a.actionId].capability === copy.capability);
      if (!duplicated) expect(text).not.toContain(copy.capability);
    }
  });

  it('policy.acknowledge is advertised exactly when the role can read a policy, and every advertised policy id+version is acknowledgeable', async () => {
    const { actor, context } = await contextFor(baseActor);
    const advertised = context.actions.some(a => a.actionId === 'policy.acknowledge');
    expect(advertised).toBe((context.policies ?? []).length > 0);
    const effects = createPolicyAckEffects({ store: fixture.store, now: () => FIXED_NOW });
    for (const policy of context.policies ?? []) expect((await effects.check(actor, { policyId: policy.id, version: policy.version })).ok, policy.id).toBe(true);
  });

  it('every advertised table dataset answer is an accepted state a later step can use: artifact table, Dashboard widgets (and no monitor threshold is advertised for them)', async () => {
    const { actor, catalog, context } = await contextFor(baseActor);
    for (const dataset of context.catalog.datasets.filter(d => TABLE_DATASET_IDS.includes(d.id))) {
      const result = await runDataset(dataset.id, actor, catalog);
      expect(result.outcome).toBe('accepted');
      if (result.outcome !== 'accepted' || !('table' in result)) continue;
      const auth = { ...queryAuthority(actor), catalogDigest: catalog.digest };
      const prepared = prepareTableArtifact({ request: { artifactTypeId: 'table', operation: 'create', title: 'probe', baseRevision: null, outputFormat: 'preview' }, artifactId: `art-${dataset.id}`,
        evidence: { accepted: result.plan, bundle: result.bundle, claims: result.claims }, authority: auth, catalog, latest: { kind: 'absent' }, now: FIXED_NOW.toISOString() });
      expect(prepared.outcome, `${dataset.id} artifact -> ${JSON.stringify((prepared as { code?: string }).code)}`).toBe('accepted');
      const measure = result.plan.plan.measures[0].fieldId, dimension = result.plan.plan.dimensions[0]?.fieldId ?? null;
      const built = buildDashboardSpecFromTablePlan({ version: 1, title: 'probe', description: '', widgets: [{ kind: dimension ? 'bar' : 'kpi', title: 'w', measure, dimension, sort: null, topN: null }] },
        { accepted: result.plan, bundle: result.bundle, claims: result.claims, message: 'parity probe' }, catalog, actor);
      expect(built.outcome, `${dataset.id} dashboard`).toBe('accepted');
    }
    // The registered monitor condition is sales below target: nothing in the monitor action's registry mentions a table dataset.
    expect(JSON.stringify(actionRegistry.get('monitor.create')!.params.conditionId)).not.toMatch(/stock|incident|ticket/);
  });

  it('Results library actions are advertised exactly with dashboard.create, are direct tier with product copy, and run through the executor on the shared results port', async () => {
    const { actor, context } = await contextFor(baseActor);
    const advertised = context.actions.filter(a => a.actionId === 'result.manage' || a.actionId === 'result.unarchive');
    expect(advertised.length > 0).toBe(actor.permissions.includes('dashboard.create'));
    for (const action of advertised) {
      expect(actionRegistry.get(action.actionId)?.riskTier).toBe('direct');
      expect(ACTION_COPY[action.actionId].capability).toBeTruthy();
    }
    if (!advertised.length) return;
    const calls: string[] = [];
    const { ports } = fakePorts({ results: { apply: async (_a, input) => { calls.push(`${input.op}:${input.artifactId}:${input.title ?? ''}`); return { ok: true, text: 'ok' }; } } });
    const run = (actionId: string, params: Record<string, never>) => executeActionStep({ ports, actor, step: grounded(actionId, params), conversationId: 'conv-1', turnId: 'turn-1', now: () => FIXED_NOW });
    expect(await run('result.manage', { artifact: 'A1', operation: 'pin' } as never)).toMatchObject({ outcome: 'updated' });
    expect(await run('result.manage', { artifact: 'A1', operation: 'rename', title: 'ชื่อใหม่' } as never)).toMatchObject({ outcome: 'updated' });
    expect(await run('result.manage', { artifact: 'A1', operation: 'rename' } as never)).toMatchObject({ outcome: 'clarify', code: 'missing_param' });
    expect(await run('result.unarchive', { artifact: 'A2' } as never)).toMatchObject({ outcome: 'updated' });
    expect(calls).toEqual(['pin:A1:', 'rename:A1:ชื่อใหม่', 'unarchive:A2:']);
  });

  it('advertised policies are readable with a cited source and version', async () => {
    const { actor, context } = await contextFor(baseActor);
    for (const policy of context.policies ?? []) {
      const result = await executePolicyReadStep({ store: fixture.store, actor, now: () => FIXED_NOW, step: { kind: 'policy_read', policyIds: [policy.id] } });
      expect(result.outcome).toBe('accepted');
      if (result.outcome === 'accepted') expect(result.sources[0].id).toBe(`policy:${policy.id}:${policy.version}`);
    }
  });
});

describe('capability parity: registries', () => {
  it('every registered action has copy and every copy entry is a registered action (nothing advertised without a path)', () => {
    expect(Object.keys(ACTION_COPY).sort()).toEqual(actionRegistry.ids().sort());
  });

  it('every legacy capability area names only registered pack tools', () => {
    const tools = new Set(defaultRuntimes.flatMap(runtime => runtime.manifest.tools.map(tool => tool.name)));
    for (const area of CAPABILITY_AREAS) for (const tool of area.tools) {
      // Workflow tools are registered by the workflow broker, not the pack manifests.
      if (!tool.startsWith('workflow.')) expect(tools.has(tool), tool).toBe(true);
    }
  });

  it('every showcase card maps to a registered capability id and a role', () => {
    for (const card of showcase) {
      expect(['executive', 'east_manager', 'hr_admin', 'hr_director']).toContain(card.role);
      expect(card.plan.steps.length).toBeGreaterThan(0);
    }
  });
});

describe('capability parity: HR Director (Workflow V2 bridge)', () => {
  const director: Actor = { id: 'director', name: 'Demo HR Director', role: 'hr_director', active: true,
    permissions: ['hr.onboarding.director_read', 'hr.onboarding.director_approve', 'hr.onboarding.return'], regions: ['east'], sessionId: 's-director', mode: 'live_ai', modeRevision: 1 };
  const reads = ['director_queue', 'director_start_dates', 'director_request_documents', 'director_approvals_today'].map(readId => ({ readId, description: readId }));
  const queue = { id: 'RQ_1', expiresAt: '2099-01-01T00:00:00.000Z', requests: [{ id: 'REQ_1', label: 'Employee REQ_1', startDate: '2026-10-15' }] };
  const build = async (workflow: Parameters<typeof buildPlannerContext>[0]['workflow']) => buildPlannerContext({ store: fixture.store, actor: director, conversationId: 'parity',
    businessDate: BUSINESS_DATE, catalog: createSemanticCatalog(await fixture.store.list<Branch>('branches')), registry: actionRegistry, recipientAllowed: async () => true,
    now: () => FIXED_NOW.getTime(), ...(workflow ? { workflow } : {}) });

  it('no Workflow V2 projection => no Director read or decision is advertised (and no dataset)', async () => {
    const context = await build(undefined);
    expect(context.workflow).toBeUndefined();
    expect(context.actions.map(a => a.actionId)).toEqual([]);
    expect(context.catalog.datasets).toEqual([]);
  });

  it('decisions are advertised only with a reviewed queue, Email only with a verified approval; copy covers each, text names the reads', async () => {
    const readsOnly = await build(async () => ({ reads, reviewedQueues: [], verifiedApprovals: [] }));
    expect(readsOnly.actions.map(a => a.actionId)).toEqual([]);
    expect(capabilityText(readsOnly, { greeting: false })).toContain('คิวคำขอ Onboarding');
    const withQueue = await build(async () => ({ reads, reviewedQueues: [queue], verifiedApprovals: [] }));
    expect(withQueue.actions.map(a => a.actionId)).toEqual(['onboarding.director_approve', 'onboarding.return']);
    const withApproval = await build(async () => ({ reads, reviewedQueues: [queue], verifiedApprovals: [{ id: 'APR_1', label: 'อนุมัติแล้ว', requestIds: ['REQ_1'] }] }));
    expect(withApproval.actions.map(a => a.actionId)).toEqual(['onboarding.director_approve', 'onboarding.return', 'onboarding.notify_email']);
    for (const action of withApproval.actions) expect(capabilityText(withApproval, { greeting: false })).toContain(ACTION_COPY[action.actionId].capability);
    const approveAll = validateTurnPlan({ raw: { turnPlanVersion: 1, steps: [{ kind: 'action', actionId: 'onboarding.director_approve',
      params: { queue: { value: 'RQ_1', source: 'context_id' }, selection: { value: 'all_reviewed', source: 'user_quoted', evidenceText: 'ทั้งหมด' } } }] },
    messages: { current: 'อนุมัติทั้งหมด' }, context: withApproval, registry: actionRegistry });
    expect(approveAll.outcome).toBe('accepted');
    const foreignQueue = validateTurnPlan({ raw: { turnPlanVersion: 1, steps: [{ kind: 'workflow_read', readId: 'director_start_dates', snapshotId: 'RQ_OTHER' }] },
      messages: { current: 'x' }, context: withApproval, registry: actionRegistry });
    expect(foreignQueue.outcome).toBe('clarify');
  });

  it('every Director showcase card binds its server selectors from the projection and validates; unresolved selectors fail closed', async () => {
    const cards = roleShowcase('hr_director');
    expect(cards.map(card => card.id)).toEqual(['director-queue', 'director-start-dates', 'director-approve-reviewed', 'director-email']);
    const approval = { id: 'APR_1', label: 'อนุมัติแล้ว', requestIds: ['REQ_1'] };
    const context = await build(async () => ({ reads, reviewedQueues: [queue], verifiedApprovals: [approval] }));
    const selectors = { newestReviewedQueueId: queue.id, latestVerifiedApprovalId: approval.id };
    for (const card of cards) {
      const checked = validateTurnPlan({ raw: bindServerSelectors(card.plan, selectors), messages: { current: card.prompt }, context, registry: actionRegistry });
      expect(checked.outcome, `${card.id} ${JSON.stringify(checked)}`).toBe('accepted');
    }
    // Without a reviewed queue / verified approval in this conversation the literal selector is never a valid id.
    const noProjection = await build(async () => ({ reads, reviewedQueues: [], verifiedApprovals: [] }));
    for (const card of cards.filter(item => item.id !== 'director-queue')) {
      const checked = validateTurnPlan({ raw: bindServerSelectors(card.plan, {}), messages: { current: card.prompt }, context: noProjection, registry: actionRegistry });
      expect(checked.outcome, card.id).not.toBe('accepted');
    }
  });

  it('the Director work catalog comes from the V2 grant (not the role): each entry binds to a plan that validates; no grant => no entries', async () => {
    const base = { actor: director, salesAnalysisAvailable: false, dashboardCreateAvailable: false, employeeIds: [], badgeTargets: [], authorizedFlowCount: 0, dataUnavailable: false, targetUnavailable: false };
    expect(buildWorkspaceActionCatalog(base)).toEqual({ entries: [], status: 'no_authorized_flows' });
    expect(buildWorkspaceActionCatalog({ ...base, director: { reads: [], decisions: [] } }).status).toBe('no_authorized_flows');
    const granted = buildWorkspaceActionCatalog({ ...base, director: { reads: reads.map(r => r.readId), decisions: ['onboarding_director_approve', 'onboarding_return'] } });
    expect(granted.status).toBe('ready');
    expect(granted.entries.map(entry => [entry.id, entry.section])).toEqual([
      ['workflow.director-queue', 'ask_analyze'], ['workflow.director-approvals-today', 'ask_analyze'], ['workflow.director-approve', 'prepare_review']]);
    // Reads only (decision not granted) => no approve entry.
    expect(buildWorkspaceActionCatalog({ ...base, director: { reads: ['director_queue'], decisions: [] } }).entries.map(entry => entry.id)).toEqual(['workflow.director-queue']);
    const context = await build(async () => ({ reads, reviewedQueues: [queue], verifiedApprovals: [] }));
    for (const entry of granted.entries) {
      const bound = bindWorkCatalogEntry(entry);
      expect(bound, entry.id).toBeTruthy();
      const checked = validateTurnPlan({ raw: bindServerSelectors(bound!.plan, { newestReviewedQueueId: queue.id }), messages: { current: entry.prompt }, context, registry: actionRegistry });
      expect(checked.outcome, `${entry.id} ${JSON.stringify(checked)}`).toBe('accepted');
    }
    // The approve entry acts only on a queue reviewed in this conversation: without one it fails closed.
    const approve = bindWorkCatalogEntry(granted.entries.find(entry => entry.id === 'workflow.director-approve')!)!;
    const none = await build(async () => ({ reads, reviewedQueues: [], verifiedApprovals: [] }));
    expect(validateTurnPlan({ raw: bindServerSelectors(approve.plan, {}), messages: { current: approve.prompt }, context: none, registry: actionRegistry }).outcome).not.toBe('accepted');
  });

  it('the existing roles never receive the Director projection or onboarding actions', async () => {
    for (const [, actor] of ROLES) {
      const { context } = await contextFor(actor);
      expect(context.workflow).toBeUndefined();
      expect(context.actions.some(a => a.actionId.startsWith('onboarding.'))).toBe(false);
      const read = validateTurnPlan({ raw: { turnPlanVersion: 1, steps: [{ kind: 'workflow_read', readId: 'director_queue' }] }, messages: { current: 'x' }, context, registry: actionRegistry });
      expect(read.outcome).toBe('denied');
    }
  });
});

describe('advertised work-catalog starters clarify with the actor own authorized choices', () => {
  it('the ticket starter offers exactly the branches this role may use; the share starter offers allowed recipients', async () => {
    const { actor, context } = await contextFor(actors.east);
    const entry = (await fixture.service.getWorkspace(actor)).actionCatalog?.find(item => item.id === 'ops.ticket-create');
    expect(entry).toBeTruthy();
    const checked = validateTurnPlan({ raw: bindServerSelectors(bindWorkCatalogEntry(entry!)!.plan, {}), messages: { current: entry!.prompt }, context, registry: actionRegistry });
    expect(checked.outcome).toBe('accepted');
    if (checked.outcome !== 'accepted' || checked.steps[0].step.kind !== 'clarify') throw new Error('expected a clarify step');
    const ids = checked.steps[0].step.choices.map(choice => choice.id);
    expect(ids).toEqual(expect.arrayContaining(['E02']));
    expect(ids).not.toContain('C01');
    const share = validateTurnPlan({ raw: bindWorkCatalogEntry({ id: 'retail.dashboard-share', prompt: 'x' })!.plan, messages: { current: 'x' }, context, registry: actionRegistry });
    expect(share.outcome).toBe('accepted');
    if (share.outcome === 'accepted' && share.steps[0].step.kind === 'clarify') expect(share.steps[0].step.choices.map(c => c.id)).toEqual(context.recipients.map(r => r.id));
  });
});
