import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Actor, Badge, Employee, Store, Table, Transaction, Workspace } from '../lib/contracts';
import { buildWorkspaceActionCatalog, ACTION_CATALOG_BADGE_REASON_PLACEHOLDER, type WorkspaceActionCatalogInput } from '../lib/core/action-catalog';
import { ConciergeService } from '../lib/core/service';
import { DomainError } from '../lib/core/errors';
import { WorkflowStorageError } from '../lib/storage/sqlite';
import { createSupabaseStoreFromClient } from '../lib/storage/supabase';
import { StorageReadUnavailableError } from '../lib/storage/read-error';
import { actors, BUSINESS_DATE, createWorkspaceFixture, FIXED_NOW, profiles } from './helpers/workspace';
import { createWorkflowSqliteFixture } from './helpers/workflow-storage';
import { bindWorkCatalogEntry } from '../lib/router/demo-plans';
import { badgeRevokeStep, plan, planner } from './helpers/turn-planner';

vi.mock('@/lib/router/planner/provider', async importOriginal =>
  (await import('./helpers/turn-planner')).plannerProviderModule(await importOriginal<object>()));

type Fixture = Awaited<ReturnType<typeof createWorkspaceFixture>>;
const EFFECT_TABLES: Table[] = [
  'pending_actions', 'dashboards', 'dashboard_shares', 'mock_tickets', 'mock_badges',
  'mock_messages', 'action_executions', 'audit_events', 'tool_executions',
];

function failingReadStore(base: Store, failedTable: Table, error: unknown): Store {
  return {
    adapter: base.adapter,
    get: <T>(table: Table, id: string) => base.get<T>(table, id),
    list: <T>(table: Table, filters?: Record<string, string | string[]>) => {
      if (table === failedTable) throw error;
      return base.list<T>(table, filters);
    },
    transaction: <T>(work: (tx: Transaction) => Promise<T>) => base.transaction(work),
    close: () => base.close?.(),
  };
}

async function effectSnapshot(store: Store) {
  return Promise.all(EFFECT_TABLES.map(async table => [table, await store.list(table)] as const));
}

type SupabaseReadResult = { data: unknown; error: unknown };

async function supabaseAdapterListError(result: SupabaseReadResult): Promise<unknown> {
  const query = {
    select() { return this; },
    eq() { return this; },
    in() { return this; },
    is() { return this; },
    order() { return this; },
    range() { return this; },
    maybeSingle() { return Promise.resolve(result); },
    single() { return Promise.resolve(result); },
    then<TResult1 = SupabaseReadResult, TResult2 = never>(
      onfulfilled?: ((value: SupabaseReadResult) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      return Promise.resolve(result).then(onfulfilled, onrejected);
    },
  };
  const client = {
    from: () => query,
    async rpc() { return { data: null, error: null }; },
  } as unknown as SupabaseClient;
  const store = createSupabaseStoreFromClient(client);
  try {
    await store.list('sales_orders');
  } catch (error) {
    return error;
  }
  throw new Error('Expected the Supabase adapter read to fail.');
}

async function sqliteBusyListError(): Promise<unknown> {
  const fixture = await createWorkflowSqliteFixture();
  let blocker: ReturnType<typeof fixture.openDatabase> | undefined;
  try {
    blocker = fixture.openDatabase();
    blocker.exec('BEGIN EXCLUSIVE');
    try {
      await fixture.store.list('profiles');
    } catch (error) {
      return error;
    }
  } finally {
    if (blocker) {
      try { blocker.exec('ROLLBACK'); } catch { /* The blocker may have left its transaction. */ }
      blocker.close();
    }
    await fixture.dispose();
  }
  throw new Error('Expected the SQLite adapter read to fail while locked.');
}

function catalogInput(region: string): WorkspaceActionCatalogInput {
  return {
    actor: { role: 'executive' },
    scope: { region, date: BUSINESS_DATE },
    salesAnalysisAvailable: true,
    dashboardCreateAvailable: true,
    employeeIds: [],
    badgeTargets: [],
    authorizedFlowCount: 2,
    dataUnavailable: false,
    targetUnavailable: false,
  };
}

describe('server-owned workspace action catalog', () => {
  let fixture: Fixture;

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

  let requestSeq = 0;
  /** A work-catalog turn: the server owns the plan; the typed prompt is only the display/grounding text. */
  const catalogIdentity = (catalogEntryId: string) => ({ contractVersion: 2 as const, requestKey: `catalog-turn-request-${++requestSeq}`, catalogEntryId });

  function service(store: Store = fixture.store): ConciergeService {
    return new ConciergeService(store, { businessDate: BUSINESS_DATE, now: () => new Date(FIXED_NOW) });
  }

  async function patchProfile(actor: Actor, permissions: string[]): Promise<void> {
    await fixture.store.transaction(async tx => {
      const profile = await tx.get<Record<string, unknown> & { id: string }>('profiles', actor.id);
      if (!profile) throw new Error('The synthetic profile is missing.');
      await tx.put('profiles', { ...profile, permissions });
    });
  }

  it('returns role-distinct authorized prompts from current data without writing business state', async () => {
    const before = await Promise.all(EFFECT_TABLES.map(async table => [table, await fixture.store.list(table)] as const));
    const serviceUnderTest = service();
    const executive: Workspace = await serviceUnderTest.getWorkspace(actors.executive);
    const east: Workspace = await serviceUnderTest.getWorkspace(actors.east);
    const hr: Workspace = await serviceUnderTest.getWorkspace(actors.hr);
    const after = await Promise.all(EFFECT_TABLES.map(async table => [table, await fixture.store.list(table)] as const));

    expect(executive.actionCatalogStatus).toBe('ready');
    // Catalog, greeting and starters derive from the same authorized tool list: tickets and sharing are included.
    expect(executive.actionCatalog).toHaveLength(6);
    expect(executive.actionCatalog?.map(entry => entry.actionKind).filter(Boolean)).toEqual(expect.arrayContaining(['dashboard_create', 'ticket_create', 'dashboard_share']));
    const executiveSales = executive.actionCatalog?.find(entry => entry.id === 'retail.sales-analysis');
    const executiveBelowTarget = executive.actionCatalog?.find(entry => entry.id === 'retail.sales-below-target');
    const executiveAchievement = executive.actionCatalog?.find(entry => entry.id === 'retail.sales-achievement');
    const executiveDashboard = executive.actionCatalog?.find(entry => entry.actionKind === 'dashboard_create');
    expect(executiveSales).toMatchObject({
      consequence: 'analyze', prompt: 'วิเคราะห์ภาพรวมยอดขายและเป้าหมายในทุกภูมิภาคที่คุณมีสิทธิ์',
    });
    expect(executiveBelowTarget?.prompt).toContain('พร้อมส่วนต่างจากเป้า');
    expect(executiveAchievement?.prompt).toContain('ทำได้กี่เปอร์เซ็นต์ของเป้า');
    expect(executiveDashboard).toMatchObject({
      section: 'prepare_review', consequence: 'review_required', actionKind: 'dashboard_create',
    });
    expect(executiveDashboard?.prompt).toContain('สร้าง');

    expect(east.actionCatalogStatus).toBe('ready');
    expect(east.actionCatalog?.some(entry => entry.actionKind === 'ticket_create')).toBe(true);
    expect(east.actionCatalog).toHaveLength(6);
    expect(east.actionCatalog?.filter(entry => entry.consequence === 'analyze').map(entry => entry.id)).toEqual([
      'retail.sales-analysis', 'retail.sales-below-target', 'retail.sales-achievement',
    ]);
    expect(east.actionCatalog?.find(entry => entry.id === 'retail.sales-analysis')?.prompt)
      .toBe('วิเคราะห์ภาพรวมยอดขายและเป้าหมายในภาคตะวันออก');
    expect(east.actionCatalog?.find(entry => entry.actionKind === 'dashboard_create')).toBeDefined();

    expect(hr.actionCatalogStatus).toBe('ready');
    expect(hr.actionCatalog).toHaveLength(4);
    expect(hr.actionCatalog?.filter(entry => entry.consequence === 'read').map(entry => entry.prompt))
      .toEqual(['ค้นหาพนักงาน E024', 'ค้นหาพนักงาน E025']);
    const badgeEntries = hr.actionCatalog?.filter(entry => entry.actionKind === 'badge_revoke') ?? [];
    expect(badgeEntries.map(entry => entry.prompt)).toEqual([
      `เตรียมเพิกถอนบัตรพนักงาน C102 ของ E024 เนื่องจาก ${ACTION_CATALOG_BADGE_REASON_PLACEHOLDER}`,
      `เตรียมเพิกถอนบัตรพนักงาน C104 ของ E025 เนื่องจาก ${ACTION_CATALOG_BADGE_REASON_PLACEHOLDER}`,
    ]);
    for (const entry of [...(executive.actionCatalog ?? []), ...(east.actionCatalog ?? []), ...(hr.actionCatalog ?? [])]) {
      expect(JSON.stringify(entry)).not.toMatch(/sales\.query_metrics|dashboard\.prepare_create|hr\.find_employee|badge\.prepare_revoke/);
      expect(JSON.stringify(entry)).not.toContain('เตรียมงานจากหลักฐาน');
      expect(JSON.stringify(entry)).not.toMatch(/stakeholder|trend|แนวโน้ม|ผู้เกี่ยวข้อง/iu);
    }
    for (const entry of [...(executive.actionCatalog ?? []), ...(east.actionCatalog ?? [])]
      .filter(candidate => candidate.consequence === 'analyze')) {
      expect(JSON.stringify(entry)).not.toMatch(/stock|inventory|incident|staffing|สต็อก|เหตุการณ์|กำลังคน/iu);
    }
    expect(after).toEqual(before);
  });

  it('omits flows that the current profile cannot use and reports authorization separately from missing targets', async () => {
    const serviceUnderTest = service();
    await patchProfile(actors.executive, ['sales.read', 'operations.read']);
    const readOnlySales = await serviceUnderTest.getWorkspace(actors.executive);
    expect(readOnlySales.actionCatalog?.some(entry => entry.actionKind === 'dashboard_create')).toBe(false);
    expect(readOnlySales.actionCatalog?.some(entry => entry.section === 'ask_analyze')).toBe(true);
    expect(readOnlySales.actionCatalog?.filter(entry => entry.consequence === 'analyze')).toHaveLength(3);
    expect(readOnlySales.actionCatalogStatus).toBe('ready');

    await patchProfile(actors.hr, []);
    const deniedHr = await serviceUnderTest.getWorkspace(actors.hr);
    expect(deniedHr.actionCatalog).toEqual([]);
    expect(deniedHr.actionCatalogStatus).toBe('no_authorized_flows');

    await patchProfile(actors.hr, profiles[2].permissions);
    await fixture.store.transaction(async tx => {
      for (const badgeId of ['C102', 'C104']) {
        const badge = await tx.get<Badge>('mock_badges', badgeId);
        if (badge) await tx.put('mock_badges', { ...badge, state: 'revoked', version: badge.version + 1 });
      }
    });
    const hrWithoutBadgeTargets = await serviceUnderTest.getWorkspace(actors.hr);
    expect(hrWithoutBadgeTargets.actionCatalog?.filter(entry => entry.section === 'ask_analyze')).toHaveLength(2);
    expect(hrWithoutBadgeTargets.actionCatalog?.some(entry => entry.actionKind === 'badge_revoke')).toBe(false);
    expect(hrWithoutBadgeTargets.actionCatalogStatus).toBe('limited');

    await fixture.store.transaction(async tx => {
      for (const employeeId of ['E024', 'E025']) {
        const employee = await tx.get<Employee>('employees', employeeId);
        if (employee) await tx.put('employees', { ...employee, active: false });
      }
    });
    const hrWithoutEmployeeTargets = await serviceUnderTest.getWorkspace(actors.hr);
    expect(hrWithoutEmployeeTargets.actionCatalog).toEqual([]);
    expect(hrWithoutEmployeeTargets.actionCatalogStatus).toBe('no_current_targets');
  });

  it('reports source unavailability explicitly instead of returning an empty catalog that looks unauthorized', async () => {
    const base = fixture.store;
    const unavailableSales: Store = {
      adapter: base.adapter,
      get: <T>(table: Table, id: string) => base.get<T>(table, id),
      list: <T>(table: Table, filters?: Record<string, string | string[]>) => {
        if (table === 'sales_orders') throw new DomainError('SOURCE_UNAVAILABLE', 'Synthetic sales source outage.', 503);
        return base.list<T>(table, filters);
      },
      transaction: <T>(work: (tx: Transaction) => Promise<T>) => base.transaction(work),
      close: () => base.close?.(),
    };
    const before = await effectSnapshot(fixture.store);
    const workspace = await service(unavailableSales).getWorkspace(actors.executive);

    expect(workspace.actionCatalog).toEqual([]);
    expect(workspace.actionCatalogStatus).toBe('data_unavailable');
    expect(await effectSnapshot(fixture.store)).toEqual(before);
  });

  it('reports actual typed SQLite busy read failures without business writes', async () => {
    const sqliteError = await sqliteBusyListError();
    expect(sqliteError).toBeInstanceOf(StorageReadUnavailableError);
    expect(sqliteError).toMatchObject({ adapter: 'sqlite', operation: 'list', reason: 'database_busy' });
    const cases: Array<{ actor: Actor; table: Table }> = [
      { actor: actors.executive, table: 'sales_orders' },
      { actor: actors.hr, table: 'employees' },
      { actor: actors.hr, table: 'mock_badges' },
    ];

    for (const testCase of cases) {
      const before = await effectSnapshot(fixture.store);
      const brokenStore = failingReadStore(fixture.store, testCase.table, sqliteError);
      const workspace = await service(brokenStore).getWorkspace(testCase.actor);
      const after = await effectSnapshot(fixture.store);

      expect(workspace.actionCatalogStatus, testCase.table).toBe('data_unavailable');
      expect(after, testCase.table).toEqual(before);
    }
  }, 60_000);

  it('classifies actual Supabase availability errors but propagates permission, schema, and malformed-row failures', async () => {
    const outage = await supabaseAdapterListError({ data: null, error: { code: '08006', message: 'database detail' } });
    expect(outage).toBeInstanceOf(StorageReadUnavailableError);
    expect(outage).toMatchObject({ adapter: 'supabase', operation: 'list', reason: 'connection_unavailable' });
    const before = await effectSnapshot(fixture.store);
    const workspace = await service(failingReadStore(fixture.store, 'sales_orders', outage)).getWorkspace(actors.executive);
    expect(workspace.actionCatalogStatus).toBe('data_unavailable');
    expect(await effectSnapshot(fixture.store)).toEqual(before);

    const defects: Array<{ label: string; result: SupabaseReadResult }> = [
      { label: 'permission denied', result: { data: null, error: { code: '42501', message: 'database detail' } } },
      { label: 'missing table', result: { data: null, error: { code: '42P01', message: 'database detail' } } },
      { label: 'malformed row', result: { data: [{ id: 'SO-1', payload: { id: 'different-id' } }], error: null } },
    ];
    for (const defect of defects) {
      const error = await supabaseAdapterListError(defect.result);
      expect(error, defect.label).not.toBeInstanceOf(StorageReadUnavailableError);
      expect(error, defect.label).toMatchObject({ name: 'SupabaseStoreError', code: 'STORAGE' });
      expect((error as Error).message, defect.label).not.toContain('database detail');
      const snapshot = await effectSnapshot(fixture.store);
      await expect(service(failingReadStore(fixture.store, 'sales_orders', error)).getWorkspace(actors.executive))
        .rejects.toMatchObject({ name: 'SupabaseStoreError', code: 'STORAGE' });
      expect(await effectSnapshot(fixture.store), defect.label).toEqual(snapshot);
    }
  });

  it('does not treat generic adapter STORAGE or CONFLICT codes as source unavailability', async () => {
    const errors: Array<{ error: unknown; expected: { name: string; code: string } }> = [
      { error: new WorkflowStorageError('STORAGE', 'Synthetic projection query defect.'), expected: { name: 'WorkflowStorageError', code: 'STORAGE' } },
      { error: Object.assign(new Error('Synthetic Supabase storage defect.'), {
        name: 'SupabaseStoreError', code: 'STORAGE', definitelyNotCommitted: true,
      }), expected: { name: 'SupabaseStoreError', code: 'STORAGE' } },
      { error: Object.assign(new Error('Synthetic Supabase conflict.'), {
        name: 'SupabaseStoreError', code: 'CONFLICT', definitelyNotCommitted: true,
      }), expected: { name: 'SupabaseStoreError', code: 'CONFLICT' } },
      { error: new DomainError('WORKFLOW_UNAVAILABLE', 'Synthetic workflow query failure.', 503), expected: { name: 'DomainError', code: 'WORKFLOW_UNAVAILABLE' } },
      { error: new DomainError('WORKFLOW_PROJECTION_UNAVAILABLE', 'Synthetic projection query failure.', 503), expected: { name: 'DomainError', code: 'WORKFLOW_PROJECTION_UNAVAILABLE' } },
    ];
    for (const testCase of errors) {
      const snapshot = await effectSnapshot(fixture.store);
      await expect(service(failingReadStore(fixture.store, 'sales_orders', testCase.error)).getWorkspace(actors.executive))
        .rejects.toMatchObject(testCase.expected);
      expect(await effectSnapshot(fixture.store)).toEqual(snapshot);
    }
  });

  it('does not convert permission or programmer errors into data-unavailable status', async () => {
    const deniedStore = failingReadStore(
      fixture.store,
      'sales_orders',
      new DomainError('FORBIDDEN', 'Synthetic source permission failure.', 403),
    );
    await expect(service(deniedStore).getWorkspace(actors.executive))
      .rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });

    const brokenStore = failingReadStore(fixture.store, 'employees', new Error('Synthetic programmer failure.'));
    await expect(service(brokenStore).getWorkspace(actors.hr)).rejects.toThrow('Synthetic programmer failure.');
  });

  it('preparing the catalog dashboard prompt creates only a pending action, not a dashboard or receipt', async () => {
    const serviceUnderTest = service();
    const workspace = await serviceUnderTest.getWorkspace(actors.executive);
    const entry = workspace.actionCatalog?.find(candidate => candidate.actionKind === 'dashboard_create');
    if (!entry) throw new Error('The executive dashboard proposal is not currently valid.');
    expect(entry.prompt).toContain('สร้าง');

    const response = await serviceUnderTest.turn(actors.executive, entry.prompt, undefined, undefined, catalogIdentity(entry.id));
    expect(response.pendingAction?.payload.kind).toBe('dashboard_create');
    expect(response.pendingAction?.status).toBe('pending');
    expect(await fixture.store.list('dashboards')).toEqual([]);
    expect(await fixture.store.list('action_executions')).toEqual([]);
    expect((await serviceUnderTest.getWorkspace(actors.executive)).dashboards).toEqual([]);
    expect((await serviceUnderTest.getWorkspace(actors.executive)).receipts).toEqual([]);
    expect(await fixture.store.list('pending_actions', { actorId: actors.executive.id })).toHaveLength(1);
  });

  it('requires a real user reason for a catalog badge entry: the server-owned plan clarifies and revokes nothing', async () => {
    const serviceUnderTest = service();
    const workspace = await serviceUnderTest.getWorkspace(actors.hr);
    const entry = workspace.actionCatalog?.find(candidate => candidate.actionKind === 'badge_revoke');
    if (!entry) throw new Error('The synthetic active badge target is not currently valid.');
    expect(entry.prompt).toContain(ACTION_CATALOG_BADGE_REASON_PLACEHOLDER);
    expect(bindWorkCatalogEntry(entry)?.plan.steps).toMatchObject([
      { kind: 'clarify', about: { kind: 'action', actionId: 'badge.revoke' }, missing: [{ slot: 'params.reason' }] },
    ]);

    const clarification = await serviceUnderTest.turn(actors.hr, entry.prompt, undefined, undefined, catalogIdentity(entry.id));
    expect(clarification.clarification).toBe(true);
    expect(clarification.pendingAction).toBeUndefined();
    expect(await fixture.store.list('pending_actions', { actorId: actors.hr.id })).toEqual([]);
    expect(await fixture.store.list('action_executions')).toEqual([]);
    expect(await fixture.store.get<{ state: string }>('mock_badges', 'C102')).toMatchObject({ state: 'active' });

    // STRUCTURED REPLACEMENT for the deleted "[enter a reason]" text gate: typed text is never interpreted in demo mode,
    // so the bracketed wording prepares nothing (it only offers showcase chips).
    const typed = await serviceUnderTest.turn(
      actors.hr,
      entry.prompt.replace(ACTION_CATALOG_BADGE_REASON_PLACEHOLDER, '[enter a reason]'),
      clarification.conversationId,
    );
    expect(typed.clarification).toBe(true);
    expect(typed.pendingAction).toBeUndefined();
    expect(await fixture.store.list('pending_actions', { actorId: actors.hr.id })).toEqual([]);
    expect(await fixture.store.list('action_executions')).toEqual([]);
  });

  it('prepares a catalog badge proposal only when the live planner quotes the user-supplied reason verbatim', async () => {
    await fixture.patchSession(actors.hr.sessionId, { mode: 'live_ai', modeRevision: 1 });
    const hr = { ...actors.hr, mode: 'live_ai' as const, modeRevision: 1 };
    const serviceUnderTest = service();
    const entry = (await serviceUnderTest.getWorkspace(hr)).actionCatalog?.find(candidate => candidate.actionKind === 'badge_revoke');
    if (!entry) throw new Error('The synthetic active badge target is not currently valid.');

    // A reason the user never typed (planner invented it) is refused: evidence must be an exact substring of the message.
    planner.reply(plan(badgeRevokeStep('C102', 'E024', 'invented reason that was never typed')));
    const fabricated = await serviceUnderTest.turn(hr, entry.prompt);
    expect(fabricated.pendingAction).toBeUndefined();
    expect(await fixture.store.list('pending_actions', { actorId: hr.id })).toEqual([]);

    const suppliedReason = 'พนักงานพ้นสภาพและต้องปิดสิทธิ์ตามคำขอ';
    planner.reply(plan(badgeRevokeStep('C102', 'E024', suppliedReason)));
    const prepared = await serviceUnderTest.turn(
      hr,
      entry.prompt.replace(ACTION_CATALOG_BADGE_REASON_PLACEHOLDER, suppliedReason),
      fabricated.conversationId,
    );
    expect(prepared.pendingAction).toMatchObject({
      status: 'pending',
      payload: { kind: 'badge_revoke', badgeId: 'C102', employeeId: 'E024' },
    });
    const preparedAction = prepared.pendingAction;
    if (!preparedAction || preparedAction.payload.kind !== 'badge_revoke') throw new Error('The revised badge action is missing.');
    expect(preparedAction.payload.reason.normalize('NFKC')).toContain(suppliedReason.normalize('NFKC'));
    expect(preparedAction.payload.reason).not.toContain(ACTION_CATALOG_BADGE_REASON_PLACEHOLDER);
    expect(await fixture.store.get<{ state: string }>('mock_badges', 'C102')).toMatchObject({ state: 'active' });
    expect(await fixture.store.list('action_executions')).toEqual([]);
  });

  describe('server-owned analyze entries answer from verified evidence', () => {
    async function runEntry(actor: Actor, id: string) {
      const serviceUnderTest = service();
      const entry = (await serviceUnderTest.getWorkspace(actor)).actionCatalog?.find(candidate => candidate.id === id);
      if (!entry) throw new Error(`Catalog entry ${id} is missing.`);
      return serviceUnderTest.turn(actor, entry.prompt, undefined, undefined, catalogIdentity(id));
    }

    it('sales overview answers for the actor scope with sales sources only inside it', async () => {
      const east = await runEntry(actors.east, 'retail.sales-analysis');
      expect(east.clarification).toBeUndefined();
      expect(east.sources?.map(source => source.id)).toEqual([`sales:E02:${BUSINESS_DATE}`, `targets:E02:${BUSINESS_DATE}`]);
      const executive = await runEntry(actors.executive, 'retail.sales-analysis');
      expect(executive.clarification).toBeUndefined();
      expect(executive.sources?.map(source => source.id))
        .toEqual(expect.arrayContaining([`sales:E02:${BUSINESS_DATE}`, `sales:C01:${BUSINESS_DATE}`]));
    });

    it('sales overview cites the target evidence it promises', async () => {
      const executive = await runEntry(actors.executive, 'retail.sales-analysis');
      expect(executive.sources?.some(source => source.id.startsWith('targets:'))).toBe(true);
    });

    it.each([
      { id: 'retail.sales-below-target', actor: actors.executive },
      { id: 'retail.sales-achievement', actor: actors.executive },
      { id: 'retail.sales-achievement', actor: actors.east },
    ])('$id answers with sales and target sources for $actor.role', async ({ id, actor }) => {
      const response = await runEntry(actor, id);
      expect(response.clarification).toBeUndefined();
      const sourceIds = response.sources?.map(source => source.id) ?? [];
      expect(sourceIds.some(sourceId => sourceId.startsWith('sales:'))).toBe(true);
      expect(sourceIds.some(sourceId => sourceId.startsWith('targets:'))).toBe(true);
    });
  });
});

describe('pure workspace action-catalog helpers', () => {
  it('adds supported sales-read intents and binds each one to a server-owned plan over its promised measure', () => {
    const result = buildWorkspaceActionCatalog(catalogInput('east'));
    const salesEntries = result.entries.filter(entry => entry.consequence === 'analyze');

    expect(result.status).toBe('ready');
    expect(result.entries).toHaveLength(4);
    expect(salesEntries.map(entry => entry.id)).toEqual([
      'retail.sales-analysis', 'retail.sales-below-target', 'retail.sales-achievement',
    ]);
    const promisedMeasure: Record<string, string> = {
      'retail.sales-analysis': 'net_sales+target', 'retail.sales-below-target': 'gap', 'retail.sales-achievement': 'achievement',
    };
    for (const entry of salesEntries) {
      const bound = bindWorkCatalogEntry(entry);
      const [step] = bound?.plan.steps ?? [];
      expect(step?.kind, entry.id).toBe('query');
      if (step?.kind !== 'query') continue;
      expect(step.plan.datasetId, entry.id).toBe('branch_performance');
      expect(step.plan.measures.map(measure => measure.fieldId).join('+'), entry.id).toBe(promisedMeasure[entry.id]);
      expect(JSON.stringify(step.plan), entry.id).not.toMatch(/stock_issues|incident_count|staffing/);
    }
  });

  it('describes all-region sales scope as limited to the actor’s authorized regions', () => {
    const result = buildWorkspaceActionCatalog(catalogInput('all'));
    const overview = result.entries.find(entry => entry.id === 'retail.sales-analysis');
    const salesEntries = result.entries.filter(entry => entry.consequence === 'analyze');

    expect(salesEntries).toHaveLength(3);
    for (const entry of salesEntries) {
      expect(JSON.stringify(entry)).toContain('ทุกภูมิภาคที่คุณมีสิทธิ์');
    }
    expect(overview?.title).toContain('ทุกภูมิภาคที่คุณมีสิทธิ์');
    expect(overview?.description).toContain('ทุกภูมิภาคที่คุณมีสิทธิ์');
    expect(overview?.prompt).toContain('ทุกภูมิภาคที่คุณมีสิทธิ์');
    expect(overview?.title).not.toBe('ภาพรวมยอดขายทุกภูมิภาค');
    expect(bindWorkCatalogEntry(overview!)?.plan.steps[0]?.kind).toBe('query');
  });

  it('binds badge and employee entries from the entry id without assuming C/E identifier formats', () => {
    const badgePrompt = `เตรียมเพิกถอนบัตรพนักงาน BADGE-7 ของ EMP-42 เนื่องจาก ${ACTION_CATALOG_BADGE_REASON_PLACEHOLDER}`;
    // STRUCTURED REPLACEMENT for the deleted hasUnfilledCatalogBadgeReason text matcher: a badge entry always binds to a
    // reason clarification (never to a revoke), whatever the id format; an unsafe id binds to nothing.
    expect(bindWorkCatalogEntry({ id: 'hr.badge-revoke.BADGE-7', prompt: badgePrompt })?.plan.steps)
      .toMatchObject([{ kind: 'clarify', about: { kind: 'action', actionId: 'badge.revoke' } }]);
    expect(bindWorkCatalogEntry({ id: 'catalog.badge_reason_required', prompt: 'x' })?.plan.steps[0]?.kind).toBe('clarify');
    expect(bindWorkCatalogEntry({ id: 'hr.employee-search.EMP-42', prompt: 'ค้นหาพนักงาน EMP-42' })?.plan.steps[0]?.kind).toBe('hr_query');
    expect(bindWorkCatalogEntry({ id: 'hr.employee-search.../EMP', prompt: 'ค้นหาพนักงาน EMP' })).toBeUndefined();
    expect(bindWorkCatalogEntry({ id: 'hr.badge-revoke.../x', prompt: badgePrompt })).toBeUndefined();
  });
});
