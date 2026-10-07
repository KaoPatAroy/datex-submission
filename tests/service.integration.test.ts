import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConciergeService } from '../lib/core/service';
import type { PendingAction, RowFilter, Store, Table, Ticket, Transaction } from '../lib/contracts';
import { actors, BUSINESS_DATE, CLOSED_BUSINESS_DATE, dashboardPayload, createWorkspaceFixture, FIXED_NOW, loseOneTicketCommitResponse } from './helpers/workspace';
import { baseQueryPlan, plan, planner, regionQueryStep } from './helpers/turn-planner';
import type { TurnPlannerInput } from '@/lib/router/planner/input';

vi.mock('@/lib/router/planner/provider', async importOriginal =>
  (await import('./helpers/turn-planner')).plannerProviderModule(await importOriginal<object>()));

type Planned = Parameters<typeof regionQueryStep>[0];
const MEASURE_AGGREGATION: Record<string, string> = { gap: 'gap' };
/** Measures whose interpretation spans are located in `message` (the shared helper emits span-less text). */
function measuresFor(message: string, measures: Array<[fieldId: string, text: string]>) {
  const span = (text: string) => ({ start: message.indexOf(text), end: message.indexOf(text) + text.length, text });
  return measures.map(([fieldId, text]) => ({ fieldId, aggregation: MEASURE_AGGREGATION[fieldId] ?? 'sum',
    interpretation: { value: fieldId, source: 'explicit', sourceText: span(text), confidence: 1 } }));
}
/** Region query on 2026-10-01 over the requested measures; every span is located in `message`. */
function regionQuery(input: Planned, message: string, regionId: string, regionText: string, measures: Array<[string, string]> = []) {
  const step = regionQueryStep(input, regionId, regionText, '2026-10-01', '2026-10-01');
  const query = step.plan as { dimensions: Array<{ interpretation: { sourceText: unknown } }>; measures: unknown[] };
  const start = message.indexOf(regionText);
  query.dimensions[0]!.interpretation.sourceText = { start, end: start + regionText.length, text: regionText };
  if (measures.length) query.measures = measuresFor(message, measures);
  return step;
}

function withPendingActionReadOverlay(base: Store, overlay: PendingAction): Store {
  const readOne = async <T>(table: Table, id: string, read: () => Promise<T | undefined>): Promise<T | undefined> =>
    table === 'pending_actions' && id === overlay.id ? overlay as T : read();
  const readMany = async <T>(table: Table, read: () => Promise<T[]>): Promise<T[]> => {
    const rows = await read();
    if (table !== 'pending_actions') return rows;
    return rows.map((row) => (row as { id?: unknown }).id === overlay.id ? overlay as T : row);
  };
  const decorateTransaction = (tx: Transaction): Transaction => ({
    list: <T>(table: Table, filters?: RowFilter) => readMany(table, () => tx.list<T>(table, filters)),
    get: <T>(table: Table, id: string) => readOne(table, id, () => tx.get<T>(table, id)),
    put: <T extends { id: string }>(table: Table, row: T) => tx.put(table, row),
    remove: (table: Table, id: string) => tx.remove(table, id),
  });

  return {
    adapter: base.adapter,
    list: <T>(table: Table, filters?: RowFilter) => readMany(table, () => base.list<T>(table, filters)),
    get: <T>(table: Table, id: string) => readOne(table, id, () => base.get<T>(table, id)),
    transaction: <T>(work: (tx: Transaction) => Promise<T>) => base.transaction((tx) => work(decorateTransaction(tx))),
    close: () => base.close?.(),
  };
}
describe('ConciergeService approval and authorization boundaries', () => {
  let fixture!: Awaited<ReturnType<typeof createWorkspaceFixture>>;

  beforeEach(async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('USE_LOCAL_DEMO_DATA', 'true');
    vi.stubEnv('BIZTANIA_DYNAMIC_QUERY', '');
    planner.reset();
    fixture = await createWorkspaceFixture();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fixture.dispose();
  });

  async function live(actor: typeof actors.east): Promise<typeof actors.east> {
    await fixture.patchSession(actor.sessionId, { mode: 'live_ai', modeRevision: 1 });
    return { ...actor, mode: 'live_ai', modeRevision: 1 };
  }

  it('reloads permissions and regions from the seeded profile instead of trusting the supplied actor', async () => {
    const forgedEastActor = {
      ...actors.east,
      regions: ['east', 'central', 'south'],
      permissions: [...actors.east.permissions, 'hr.read', 'badge.revoke'],
    };

    const workspace = await fixture!.service.getWorkspace(forgedEastActor);

    expect(workspace.actor.id).toBe('east');
    expect(workspace.actor.regions).toEqual(['east']);
    expect(workspace.actor.permissions).not.toContain('hr.read');
    expect(workspace.actor.permissions).not.toContain('badge.revoke');
  });

  it('denies cross-region and HR Sales proposals before creating pending actions', async () => {
    await expect(fixture!.service.prepare(actors.east, dashboardPayload('central')))
      .rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(fixture!.service.prepare(actors.hr, dashboardPayload('east')))
      .rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    // Structured equivalent of the typed cross-region read: the planner asks for Central as the East manager.
    const liveEast = await live(actors.east);
    const centralMessage = 'Show Central sales totals for 2026-10-01.';
    planner.reply((input: TurnPlannerInput) => plan(regionQuery(input, centralMessage, 'central', 'Central')));
    const centralRead = await fixture!.service.turn(liveEast, centralMessage);
    expect(centralRead.clarification).toBe(true);
    expect(centralRead.message).toContain('อยู่นอกสิทธิ์ของบัญชีนี้');
    expect(centralRead.sources).toBeUndefined();
    expect(await fixture!.store.list('tool_executions', { actorId: 'east' })
      .then(rows => (rows as { name?: string }[]).filter(row => row.name === 'retail.dynamic_query'))).toEqual([]);

    expect(await fixture!.store.list('pending_actions')).toHaveLength(0);
    expect(await fixture!.store.list('dashboards')).toHaveLength(0);
    const eastWorkspace = await fixture!.service.getWorkspace(actors.east);
    expect(JSON.stringify(eastWorkspace)).not.toContain('Central Confidential Branch');
  });

  it('records an audit denied event when the planner asks for a region outside the actor authority', async () => {
    const liveEast = await live(actors.east);
    const centralMessage = 'Show Central sales totals for 2026-10-01.';
    planner.reply((input: TurnPlannerInput) => plan(regionQuery(input, centralMessage, 'central', 'Central')));
    await fixture!.service.turn(liveEast, centralMessage);
    const eastWorkspace = await fixture!.service.getWorkspace(actors.east);
    expect(eastWorkspace.audit.some((event) => event.category === 'denied')).toBe(true);
  });

  it('returns scoped evidence with paid-only net sales and source-bound claims', async () => {
    const liveExecutive = await live(actors.executive);
    const message = 'Compare sales against target and check stock and incidents in East on 2026-10-01.';
    planner.reply((input: TurnPlannerInput) => plan(regionQuery(input, message, 'east', 'East', [
      ['net_sales', 'sales'], ['target', 'target'], ['gap', 'target'], ['stock_issues', 'stock'], ['incident_count', 'incidents'],
      ['staffing_actual', 'sales'], ['staffing_planned', 'sales'],
    ])));
    const response = await fixture!.service.turn(liveExecutive, message);
    // The reader (single evidence boundary) still produces the scoped, paid-only evidence the answer is bound to.
    const evidence = await fixture!.service.queryEvidence(liveExecutive, { region: 'east', date: CLOSED_BUSINESS_DATE });

    expect(evidence.scope).toMatchObject({ region: 'east', date: CLOSED_BUSINESS_DATE });
    expect(evidence.asOf).toBe('2026-10-01T16:59:59.000Z');
    expect(evidence.branches).toHaveLength(1);
    expect(evidence.branches[0]).toMatchObject({
      branchId: 'E02',
      netSales: 1_500,
      target: 2_000,
      gap: -500,
      stockIssues: 1,
      incidentCount: 1,
      staffingPlanned: 5,
      staffingActual: 3,
    });
    expect(await fixture!.store.list('sales_orders')).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'SO-E02-PAID', amountSatang: 150_000, status: 'paid' }),
      expect.objectContaining({ id: 'SO-E02-REFUNDED', amountSatang: 25_000, status: 'refunded' }),
      expect.objectContaining({ id: 'SO-E02-CANCELLED', amountSatang: 30_000, status: 'cancelled' }),
    ]));
    // The answer text carries exactly the paid-only figures (refunded/cancelled orders excluded) from verified evidence.
    for (const figure of ['1,500.00', '2,000.00', '-500.00']) expect(response.message).toContain(figure);
    expect(response.clarification).toBeUndefined();
    expect(response.sources?.map((source) => source.id).sort()).toEqual(evidence.sources.map((source) => source.id).sort());
    expect(response.analysis?.facts.length).toBeGreaterThan(0);

    const validSourceIds = new Set(response.sources?.map((source) => source.id));
    for (const claim of [
      ...(response.analysis?.facts ?? []),
      ...(response.analysis?.relationships ?? []),
      ...(response.analysis?.hypotheses ?? []),
      ...(response.analysis?.missingEvidence ?? []),
    ]) {
      expect(claim.sourceIds.length).toBeGreaterThan(0);
      for (const sourceId of claim.sourceIds) expect(validSourceIds.has(sourceId)).toBe(true);
    }
  });

  it('lets the Executive ask for all regions and returns each authorized region in the evidence', async () => {
    const liveExecutive = await live(actors.executive);
    const message = 'Compare sales across all regions on 2026-10-01.';
    const allRegions = { start: message.indexOf('all regions'), end: message.indexOf('all regions') + 'all regions'.length, text: 'all regions' };
    planner.reply((input: TurnPlannerInput) => plan({ kind: 'query', continuation: false, plan: baseQueryPlan(input.context, {
      measures: measuresFor(message, [['net_sales', 'sales'], ['target', 'sales'], ['gap', 'sales']]),
      scope: { kind: 'all', sourceText: allRegions, confidence: 1 },
      time: { fieldId: 'date', timezone: input.context.business.timezone, source: 'explicit', dates: ['2026-10-01'],
        evidenceText: '2026-10-01' },
      dimensions: [{ fieldId: 'branch', interpretation: { value: 'branch', source: 'default', sourceText: null, confidence: 1 } }],
      group: { fieldIds: ['branch'] },
    }) }));
    const response = await fixture!.service.turn(liveExecutive, message);
    const evidence = await fixture!.service.queryEvidence(liveExecutive, { region: 'all', date: CLOSED_BUSINESS_DATE });

    expect(evidence.scope.region).toBe('all');
    expect(evidence.branches.map((branch) => branch.branchId)).toEqual(['E02', 'C01']);
    expect(evidence.totals).toMatchObject({ netSales: 2_200, target: 3_000, gap: -800 });
    expect(response.clarification).toBeUndefined();
    expect(response.sources?.map((source) => source.id)).toEqual(expect.arrayContaining([
      'sales:E02:2026-10-01', 'sales:C01:2026-10-01', 'targets:E02:2026-10-01', 'targets:C01:2026-10-01',
    ]));
    for (const figure of ['1,500.00', '700.00', '2,000.00', '1,000.00', '-500.00', '-300.00']) expect(response.message).toContain(figure);
  });

  it('stores the exact preview and writes a dashboard only after confirmation', async () => {
    const originalPayload = dashboardPayload('east');
    const proposal = await fixture!.service.prepare(actors.executive, originalPayload);

    expect(await fixture!.store.list('dashboards')).toHaveLength(0);
    expect(proposal.actorId).toBe('executive');
    expect(proposal.sessionId).toBe(actors.executive.sessionId);
    expect(proposal.mode).toBe('scripted_demo');
    expect(proposal.modeRevision).toBe(0);
    expect(proposal.payloadHash.length).toBeGreaterThan(0);
    expect(proposal.evidenceVersion).toEqual(expect.any(String));
    expect(proposal.expiresAt).toEqual(expect.any(String));
    expect(proposal.payload).toEqual(originalPayload);

    const storedBeforeConfirm = await fixture!.store.get<typeof proposal>('pending_actions', proposal.id);
    expect(storedBeforeConfirm?.payload).toEqual(originalPayload);

    if (proposal.payload.kind !== 'dashboard_create') throw new Error('Expected dashboard proposal.');
    proposal.payload.spec.title = 'tampered after preview';
    const storedAfterTamper = await fixture!.store.get<typeof proposal>('pending_actions', proposal.id);
    expect(storedAfterTamper?.payload).toEqual(originalPayload);

    const receipt = await fixture!.service.confirm(actors.executive, proposal.id);
    expect(receipt.status).toBe('verified_success');
    const dashboardId = receipt.dashboardId ?? receipt.results[0]?.id;
    expect(dashboardId).toEqual(expect.any(String));

    const persisted = await fixture!.store.get<Record<string, unknown> & { id: string }>('dashboards', dashboardId!);
    expect(persisted).toMatchObject({
      id: dashboardId,
      ownerId: 'executive',
      spec: originalPayload.spec,
    });
  });

  it('requires the same actor (any of their sessions) to confirm; another actor cannot', async () => {
    const proposal = await fixture!.service.prepare(actors.executive, dashboardPayload('east'));

    await fixture!.store.transaction(async (tx) => {
      await tx.put('sessions', {
        id: 'test-session-executive-second',
        profileId: 'executive',
        mode: 'scripted_demo',
        modeRevision: 0,
        csrfToken: 'another-test-csrf-token',
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
    });

    await expect(fixture!.service.confirm(actors.east, proposal.id))
      .rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    // Proposals belong to the user, not the login session: a new session of the same actor still owns it.
    expect(await fixture!.store.list('dashboards')).toHaveLength(0);

    const receipt = await fixture!.service.confirm({ ...actors.executive, sessionId: 'test-session-executive-second' }, proposal.id);
    expect(receipt.status).toBe('verified_success');
    expect(await fixture!.store.list('dashboards')).toHaveLength(1);
  });

  it('rejects a persisted payload change that no longer matches the preview hash', async () => {
    const proposal = await fixture!.service.prepare(actors.executive, dashboardPayload('east'));
    const stored = await fixture!.store.get<typeof proposal>('pending_actions', proposal.id);
    if (!stored) throw new Error('Expected persisted dashboard proposal.');
    const storedPayload = stored.payload;
    if (storedPayload.kind !== 'dashboard_create') throw new Error('Expected persisted dashboard proposal.');
    const tampered = {
      ...stored,
      payload: { ...storedPayload, spec: { ...storedPayload.spec, title: 'forged after persistence' } },
    };

    const tamperedReader = new ConciergeService(withPendingActionReadOverlay(fixture!.store, tampered), {
      businessDate: BUSINESS_DATE,
      now: () => new Date(FIXED_NOW),
    });
    await expect(tamperedReader.confirm(actors.executive, proposal.id))
      .rejects.toMatchObject({ code: 'STALE_ACTION', status: 409 });
    expect(await fixture!.store.get<PendingAction>('pending_actions', proposal.id)).toEqual(stored);
    expect(await fixture!.store.list('dashboards')).toHaveLength(0);
  });

  it('invalidates a proposal after its session mode revision changes', async () => {
    const proposal = await fixture!.service.prepare(actors.executive, dashboardPayload('east'));
    await fixture!.patchSession(actors.executive.sessionId, { mode: 'live_ai', modeRevision: 1 });

    await expect(fixture!.service.confirm(actors.executive, proposal.id))
      .rejects.toMatchObject({ code: 'STALE_ACTION', status: 409 });
    expect(await fixture!.store.list('dashboards')).toHaveLength(0);
  });

  it('invalidates an approval when its bound source evidence changes before confirmation', async () => {
    const proposal = await fixture!.service.prepare(actors.executive, dashboardPayload('east'));
    await fixture!.store.transaction(async (tx) => {
      const order = await tx.get<Record<string, unknown> & { id: string }>('sales_orders', 'SO-E02-PAID');
      if (!order) throw new Error('Missing sales fixture row.');
      await tx.put('sales_orders', {
        ...order,
        amountSatang: 125_000,
        updatedAt: '2026-10-01T13:00:00.000Z',
      });
    });

    await expect(fixture!.service.confirm(actors.executive, proposal.id))
      .rejects.toMatchObject({ code: 'STALE_ACTION', status: 409 });
    expect(await fixture!.store.list('dashboards')).toHaveLength(0);
  });

  it('rejects an expired proposal without a target write', async () => {
    const proposal = await fixture!.service.prepare(actors.executive, dashboardPayload('east'));
    await fixture!.setNow(new Date(new Date(proposal.expiresAt).getTime() + 1));

    await expect(fixture!.service.confirm(actors.executive, proposal.id))
      .rejects.toMatchObject({ code: 'EXPIRED_ACTION', status: 409 });
    expect(await fixture!.store.list('dashboards')).toHaveLength(0);
  });

  it('confirms the HR badge preview and verifies the changed badge by reading the target row back', async () => {
    const before = await fixture!.store.get<Record<string, unknown> & { id: string }>('mock_badges', 'C102');
    expect(before?.state).toBe('active');

    const proposal = await fixture!.service.prepare(actors.hr, {
      kind: 'badge_revoke',
      badgeId: 'C102',
      employeeId: 'E024',
      reason: 'Synthetic test revocation after verifying the badge holder.',
    });
    expect(await fixture!.store.get<Record<string, unknown> & { id: string }>('mock_badges', 'C102'))
      .toMatchObject({ state: 'active', version: 1 });

    const receipt = await fixture!.service.confirm(actors.hr, proposal.id);
    expect(receipt.status).toBe('verified_success');
    expect(await fixture!.store.get<Record<string, unknown> & { id: string }>('mock_badges', 'C102'))
      .toMatchObject({ state: 'revoked', version: 2 });

    const otherBadgeBefore = await fixture!.store.get<Record<string, unknown> & { id: string }>('mock_badges', 'C103');
    await expect(fixture!.service.prepare(actors.hr, {
      kind: 'badge_revoke', badgeId: 'C103', employeeId: 'E025', reason: 'Already revoked.',
    })).rejects.toMatchObject({ code: 'INVALID_INPUT', status: 400 });
    expect(await fixture!.store.get('mock_badges', 'C103')).toEqual(otherBadgeBefore);

    const mismatchedBadgeBefore = await fixture!.store.get<Record<string, unknown> & { id: string }>('mock_badges', 'C104');
    await expect(fixture!.service.prepare(actors.hr, {
      kind: 'badge_revoke', badgeId: 'C104', employeeId: 'E024', reason: 'Attempt with the wrong badge holder.',
    })).rejects.toMatchObject({ code: 'INVALID_INPUT', status: 400 });
    expect(await fixture!.store.get('mock_badges', 'C104')).toEqual(mismatchedBadgeBefore);
  });

  it('refreshes dashboard evidence after a same-source row changes while preserving the stored artifact identity', async () => {
    const proposal = await fixture!.service.prepare(actors.executive, dashboardPayload('east'));
    const receipt = await fixture!.service.confirm(actors.executive, proposal.id);
    const dashboardId = receipt.dashboardId ?? receipt.results[0]?.id;
    expect(dashboardId).toEqual(expect.any(String));
    const before = await fixture!.service.dashboard(actors.executive, dashboardId!);

    await fixture!.store.transaction(async (tx) => {
      const order = await tx.get<Record<string, unknown> & { id: string }>('sales_orders', 'SO-E02-PAID');
      if (!order) throw new Error('Missing sales fixture row.');
      await tx.put('sales_orders', {
        ...order,
        amountSatang: 125_000,
        updatedAt: '2026-10-01T16:59:58.000Z',
      });
    });

    const after = await fixture!.service.dashboard(actors.executive, dashboardId!);
    expect(after.dashboard.id).toBe(before.dashboard.id);
    expect(after.evidence.version).not.toBe(before.evidence.version);
    expect(after.evidence.branches.find((branch) => branch.branchId === 'E02')?.netSales).toBe(1_250);
    expect(after.evidence.sources.map((source) => source.id)).toEqual(before.evidence.sources.map((source) => source.id));
    expect(after.evidence.sources.some((source) => source.observedAt === '2026-10-01T16:59:58.000Z')).toBe(true);
  });

  it('reconciles a committed ticket after the response is lost without retrying the target write', async () => {
    const liveExecutive = await live(actors.executive);
    const message = 'Compare sales against target in East on 2026-10-01.';
    planner.reply((input: TurnPlannerInput) => plan(regionQuery(input, message, 'east', 'East', [['net_sales', 'sales'], ['target', 'target'], ['gap', 'target']])));
    const turn = await fixture!.service.turn(liveExecutive, message);
    expect(turn.sources?.length).toBeGreaterThan(0);
    const lossyStore = loseOneTicketCommitResponse(fixture!.store);
    const service = new ConciergeService(lossyStore, {
      businessDate: BUSINESS_DATE,
      now: () => new Date(FIXED_NOW),
    });
    const proposal = await service.prepare(liveExecutive, {
      kind: 'ticket_create',
      scope: { region: 'east', date: CLOSED_BUSINESS_DATE, branchIds: ['E02'] },
      targets: [{
        branchId: 'E02',
        assigneeId: 'E024',
        title: 'Investigate the East Two sales gap',
        reason: 'Sales are below target; available evidence does not prove the cause.',
        sourceIds: turn.sources!.map((source) => source.id),
        unansweredQuestion: 'What lost demand or conversion evidence explains the gap?',
      }],
    }, { conversationId: turn.conversationId });

    const firstResult = await service.confirm(liveExecutive, proposal.id);
    expect(firstResult.status).toBe('verified_success');
    expect(firstResult.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetId: 'E02', status: 'verified_success' }),
    ]));
    expect(await fixture!.store.list<Ticket>('mock_tickets')).toHaveLength(1);
    expect(lossyStore.targetCommitCount()).toBe(1);
    expect(lossyStore.targetDispatchCount()).toBe(1);

    const reconciled = await service.reconcile(liveExecutive, firstResult.id);
    expect(reconciled.status).toBe('verified_success');
    expect(await fixture!.store.list<Ticket>('mock_tickets')).toHaveLength(1);
    expect(lossyStore.targetCommitCount()).toBe(1);
    expect(lossyStore.targetDispatchCount()).toBe(1);
  });

  it('converges concurrent duplicate confirmations on one dashboard effect', async () => {
    const proposal = await fixture!.service.prepare(actors.executive, dashboardPayload('east'));

    const [first, second] = await Promise.all([
      fixture!.service.confirm(actors.executive, proposal.id),
      fixture!.service.confirm(actors.executive, proposal.id),
    ]);

    expect(first.id).toBe(second.id);
    expect(first.status).toBe('verified_success');
    expect(await fixture!.store.list('dashboards')).toHaveLength(1);
    expect(await fixture!.service.reconcile(actors.executive, first.id)).toMatchObject({
      id: first.id,
      actionId: proposal.id,
      status: 'verified_success',
    });
    expect(await fixture!.store.list('dashboards')).toHaveLength(1);
  });

  it('creates a recipient-scoped East view without leaking excluded-region records', async () => {
    const dashboardAction = await fixture!.service.prepare(actors.executive, dashboardPayload('all'));
    const dashboardReceipt = await fixture!.service.confirm(actors.executive, dashboardAction.id);
    const dashboardId = dashboardReceipt.dashboardId ?? dashboardReceipt.results[0]?.id;
    expect(dashboardId).toEqual(expect.any(String));

    const shareAction = await fixture!.service.prepare(actors.executive, {
      kind: 'dashboard_share',
      dashboardId: dashboardId!,
      recipientId: 'east',
    });
    const shareReceipt = await fixture!.service.confirm(actors.executive, shareAction.id);
    expect(shareReceipt.status).toBe('verified_success');

    const recipientView = await fixture!.service.dashboard(actors.east, dashboardId!);
    const serialized = JSON.stringify(recipientView);
    expect(serialized).toContain('E02');
    expect(serialized).not.toContain('C01');
    expect(serialized).not.toContain('Central Confidential Branch');
    expect(recipientView.dashboard.spec.scope.region.toLowerCase()).toContain('east');

    const recipientWorkspace = await fixture!.service.getWorkspace(actors.east);
    expect(recipientWorkspace.inbox).toEqual(expect.arrayContaining([
      expect.objectContaining({ dashboardId }),
    ]));
  });
  async function createAndShareToEast(region: 'east' | 'all') {
    const created = await fixture!.service.confirm(actors.executive, (await fixture!.service.prepare(actors.executive, dashboardPayload(region))).id);
    const dashboardId = (created.dashboardId ?? created.results[0]?.id)!;
    const shared = await fixture!.service.confirm(actors.executive, (await fixture!.service.prepare(actors.executive, { kind: 'dashboard_share', dashboardId, recipientId: 'east' })).id);
    expect(shared.status).toBe('verified_success');
    return dashboardId;
  }

  it('keeps the sender title and names the sender when the recipient scope matches the dashboard', async () => {
    const dashboardId = await createAndShareToEast('east');
    const view = await fixture!.service.dashboard(actors.east, dashboardId);
    expect(view.dashboard.spec.title).toBe('east sales overview');
    expect(view.dashboard.spec.widgets.map((widget) => widget.title)).toEqual(['Net sales', 'Branch metrics']);
    expect(view.sharedBy?.name).toBeTruthy();
    const workspace = await fixture!.service.getWorkspace(actors.east);
    expect(workspace.inbox.find((item) => item.dashboardId === dashboardId)).toMatchObject({ title: 'east sales overview', sharedBy: view.sharedBy?.name });
  });

  it('falls back to a scope-safe Thai title when the recipient sees a narrower scope', async () => {
    const dashboardId = await createAndShareToEast('all');
    const view = await fixture!.service.dashboard(actors.east, dashboardId);
    expect(view.dashboard.spec.title).toBe('Dashboard ตามสิทธิ์ปัจจุบันของคุณ');
    expect(view.sharedBy?.name).toBeTruthy();
  });

  it('lets only the owner rename an UNSHARED saved dashboard, without a confirmation step (F1: a shared one is refused here)', async () => {
    const dashboardId = await createAndShareToEast('east');
    await expect(fixture!.service.renameDashboard(actors.executive, dashboardId, { title: 'แก้ตรง ๆ' })).rejects.toMatchObject({ status: 409, code: 'DASHBOARD_SHARED' });
    for (const grant of await fixture!.store.list<{ id: string; dashboardId: string; active?: boolean }>('dashboard_shares')) {
      if (grant.dashboardId === dashboardId) await fixture!.store.transaction(tx => tx.put('dashboard_shares', { ...grant, active: false } as never));
    }
    const renamed = await fixture!.service.renameDashboard(actors.executive, dashboardId, { title: '  ยอดขายประจำวัน  ' });
    expect(renamed.dashboard.spec.title).toBe('ยอดขายประจำวัน');
    expect((await fixture!.service.getWorkspace(actors.executive)).dashboards.find((item) => item.id === dashboardId)?.spec.title).toBe('ยอดขายประจำวัน');
    await expect(fixture!.service.renameDashboard(actors.east, dashboardId, { title: 'ไม่ใช่ของฉัน' })).rejects.toMatchObject({ status: 404 });
    await expect(fixture!.service.renameDashboard(actors.executive, dashboardId, { title: '   ' })).rejects.toThrow();
    expect((await fixture!.service.dashboard(actors.executive, dashboardId)).dashboard.spec.title).toBe('ยอดขายประจำวัน');
  });
});
