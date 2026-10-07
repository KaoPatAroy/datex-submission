import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Dashboard, Store } from '../lib/contracts';
import type { TrustedWorkflowRuntimeOptions } from '../lib/core/workflow-runtime';
import type { ProjectedRow, WorkflowProjectionReader, WorkflowStorageQuery, WorkflowStoreCapability } from '../lib/storage/workflow-projections';
import type { WorkflowV2ServerRuntime } from '../lib/server/workflow';

const BUSINESS_DATE = '2026-10-04';
const READY_BOOTSTRAP = {
  state: 'source_ready',
  sourcePhasesComplete: true,
  bootstrapReady: true,
  seedVersion: 2,
  seed: 1,
  businessDate: BUSINESS_DATE,
  inputDigest: 'a'.repeat(64),
};
const environmentKeys = [
  'WORKFLOW_V2_ENABLED',
  'DASHBOARD_SHARE_SIGNING_KEY_V1',
  'DASHBOARD_SHARE_SIGNING_KEY',
  'NEXT_PUBLIC_APP_URL',
  'APP_URL',
  'VERCEL_URL',
] as const;

const state = vi.hoisted(() => ({
  enabled: false,
  bootstrap: null as unknown,
  store: null as unknown,
  bootstrapCalls: 0,
  storeCalls: 0,
  runtimeOptions: [] as unknown[],
}));

vi.mock('server-only', () => ({}));
vi.mock('../lib/storage', () => ({
  isWorkflowV2Enabled: () => state.enabled,
  getWorkflowV2BootstrapResult: async () => {
    state.bootstrapCalls += 1;
    return state.bootstrap;
  },
  getStore: async () => {
    state.storeCalls += 1;
    return state.store;
  },
}));
vi.mock('../lib/core/workflow-runtime', async importOriginal => {
  const actual = await importOriginal<typeof import('../lib/core/workflow-runtime')>();
  return {
    ...actual,
    createTrustedWorkflowRuntime: (options: TrustedWorkflowRuntimeOptions) => {
      state.runtimeOptions.push(options);
      return actual.createTrustedWorkflowRuntime(options);
    },
  };
});

let savedEnvironment = new Map<string, string | undefined>();

beforeEach(() => {
  savedEnvironment = new Map(environmentKeys.map(key => [key, process.env[key]]));
  state.enabled = false;
  state.bootstrap = READY_BOOTSTRAP;
  state.store = makeControlledStore();
  state.bootstrapCalls = 0;
  state.storeCalls = 0;
  state.runtimeOptions.length = 0;
  delete process.env.DASHBOARD_SHARE_SIGNING_KEY_V1;
  delete process.env.DASHBOARD_SHARE_SIGNING_KEY;
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.APP_URL;
  delete process.env.VERCEL_URL;
});

afterEach(() => {
  for (const [key, value] of savedEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function emptyProjectionReader(): WorkflowProjectionReader {
  return {
    get: async () => undefined,
    query: async () => [],
  };
}

function makeControlledStore(projections = emptyProjectionReader()): Store & WorkflowStoreCapability {
  return {
    adapter: 'sqlite',
    workflowContractVersion: 2,
    workflowProjectionReader: projections,
    workflowTransaction: async () => { throw new Error('No workflow transaction is expected in a server-factory test'); },
  } as unknown as Store & WorkflowStoreCapability;
}

function configureReadyBootstrap(): void {
  state.enabled = true;
  process.env.WORKFLOW_V2_ENABLED = 'true';
}

async function loadServerFactory() {
  vi.resetModules();
  return import('../lib/server/workflow');
}

function shareAvailability(runtime: WorkflowV2ServerRuntime) {
  return runtime.availability.find(item => item.kind === 'dashboard_share');
}

function expectNonShareSalesActionsAvailable(runtime: WorkflowV2ServerRuntime) {
  for (const kind of ['dashboard_create', 'dashboard_share_revoke', 'crm_followup_create', 'discount_request_create'] as const) {
    expect(runtime.availability.find(item => item.kind === kind)?.available, `${kind} remains available`).toBe(true);
  }
}

describe('Workflow V2 server runtime factory', () => {
  it('rejects when the feature flag is off before loading bootstrap or storage', async () => {
    process.env.WORKFLOW_V2_ENABLED = 'false';
    const server = await loadServerFactory();

    await expect(server.getWorkflowV2ServerRuntime()).rejects.toMatchObject({ code: 'WORKFLOW_UNAVAILABLE' });
    expect(state.bootstrapCalls).toBe(0);
    expect(state.storeCalls).toBe(0);
    expect(state.runtimeOptions).toHaveLength(0);
  });

  it.each([
    ['state', { ...READY_BOOTSTRAP, state: 'source_phase_incomplete' }],
    ['source phases', { ...READY_BOOTSTRAP, sourcePhasesComplete: false }],
    ['bootstrap readiness', { ...READY_BOOTSTRAP, bootstrapReady: false }],
  ])('rejects a bootstrap that fails the %s readiness condition', async (_condition, bootstrap) => {
    configureReadyBootstrap();
    state.bootstrap = bootstrap;
    const server = await loadServerFactory();

    await expect(server.getWorkflowV2ServerRuntime()).rejects.toMatchObject({ code: 'WORKFLOW_UNAVAILABLE' });
    expect(state.bootstrapCalls).toBe(1);
    expect(state.storeCalls).toBe(0);
    expect(state.runtimeOptions).toHaveLength(0);
  });

  it('disables dashboard sharing without a dedicated key while keeping other Sales actions available', async () => {
    configureReadyBootstrap();
    process.env.NEXT_PUBLIC_APP_URL = 'https://biztania.example';
    const server = await loadServerFactory();
    const runtime = await server.getWorkflowV2ServerRuntime();

    expect(shareAvailability(runtime)).toMatchObject({ available: false, code: 'WORKFLOW_CONFIGURATION_UNAVAILABLE' });
    expectNonShareSalesActionsAvailable(runtime);
  });

  it('enables dashboard sharing with a valid dedicated key and canonical HTTPS origin', async () => {
    configureReadyBootstrap();
    process.env.DASHBOARD_SHARE_SIGNING_KEY_V1 = 'workflow-share-signing-key-'.padEnd(40, 'x');
    process.env.NEXT_PUBLIC_APP_URL = 'https://biztania.example';
    const server = await loadServerFactory();
    const runtime = await server.getWorkflowV2ServerRuntime();

    expect(shareAvailability(runtime)).toMatchObject({ available: true, reason: null });
    expectNonShareSalesActionsAvailable(runtime);
  });

  it.each([
    {
      name: 'missing versioned key does not use an unversioned key fallback',
      key: undefined,
      origin: 'https://biztania.example',
      fallbackKey: 'fallback-signing-key-that-is-long-enough-to-use',
      fallbackOrigin: undefined,
    },
    {
      name: 'short versioned key does not use an unversioned key fallback',
      key: 'short',
      origin: 'https://biztania.example',
      fallbackKey: 'fallback-signing-key-that-is-long-enough-to-use',
      fallbackOrigin: undefined,
    },
    {
      name: 'malformed origin does not use a generic application URL fallback',
      key: 'workflow-share-signing-key-'.padEnd(40, 'x'),
      origin: 'https://biztania.example/unexpected-path',
      fallbackKey: undefined,
      fallbackOrigin: 'https://fallback.example',
    },
  ])('keeps sharing disabled when $name', async ({ key, origin, fallbackKey, fallbackOrigin }) => {
    configureReadyBootstrap();
    if (key === undefined) delete process.env.DASHBOARD_SHARE_SIGNING_KEY_V1;
    else process.env.DASHBOARD_SHARE_SIGNING_KEY_V1 = key;
    if (origin === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = origin;
    if (fallbackKey !== undefined) process.env.DASHBOARD_SHARE_SIGNING_KEY = fallbackKey;
    if (fallbackOrigin !== undefined) process.env.APP_URL = fallbackOrigin;
    const server = await loadServerFactory();
    const runtime = await server.getWorkflowV2ServerRuntime();

    expect(shareAvailability(runtime)).toMatchObject({ available: false, code: 'WORKFLOW_CONFIGURATION_UNAVAILABLE' });
    expectNonShareSalesActionsAvailable(runtime);
  });

  it('uses the current principal owner and cursor-pages before choosing the latest dashboard', async () => {
    configureReadyBootstrap();
    const server = await loadServerFactory();
    await server.getWorkflowV2ServerRuntime();
    const options = state.runtimeOptions.at(-1) as TrustedWorkflowRuntimeOptions | undefined;
    expect(options).toBeDefined();

    const ownerAFirstPage = Array.from({ length: 100 }, (_, index) => dashboardRow(
      `dashboard-${String(index).padStart(3, '0')}`,
      'owner-alpha',
      index === 50 ? '2026-10-04T11:00:00.000Z' : '2026-10-03T10:00:00.000Z',
    ));
    const ownerAPageTwo = [
      dashboardRow('dashboard-100', 'owner-alpha', '2026-10-04T12:00:00.000Z'),
      dashboardRow('dashboard-101', 'owner-alpha', '2026-10-04T11:30:00.000Z'),
    ];
    const ownerBPage = [dashboardRow('dashboard-beta', 'owner-beta', '2026-10-04T13:00:00.000Z')];
    const calls: WorkflowStorageQuery[] = [];
    const projections = dashboardProjectionReader(new Map([
      ['owner-alpha', [ownerAFirstPage, ownerAPageTwo, []]],
      ['owner-beta', [ownerBPage, []]],
    ]), calls);
    const contextFactory = options!.contextFactory;
    const readLatest = (ownerId: string) => contextFactory(
      {} as Parameters<typeof contextFactory>[0],
      { actor: { id: ownerId } } as unknown as Parameters<typeof contextFactory>[1],
      { projections, now: () => new Date('2026-10-04T14:00:00.000Z') } as Parameters<typeof contextFactory>[2],
    ).latestDashboard();

    expect((await readLatest('owner-alpha'))?.id).toBe('dashboard-100');
    expect((await readLatest('owner-beta'))?.id).toBe('dashboard-beta');
    expect(calls).toEqual([
      { kind: 'scoped', table: 'dashboards', ownerId: 'owner-alpha', limit: 100 },
      { kind: 'scoped', table: 'dashboards', ownerId: 'owner-alpha', cursor: 'dashboard-099', limit: 100 },
      { kind: 'scoped', table: 'dashboards', ownerId: 'owner-alpha', cursor: 'dashboard-101', limit: 1 },
      { kind: 'scoped', table: 'dashboards', ownerId: 'owner-beta', limit: 100 },
      { kind: 'scoped', table: 'dashboards', ownerId: 'owner-beta', cursor: 'dashboard-beta', limit: 1 },
    ]);
  });

  it('accepts backend cursor order without imposing JavaScript locale order', async () => {
    configureReadyBootstrap();
    const server = await loadServerFactory();
    await server.getWorkflowV2ServerRuntime();
    const options = state.runtimeOptions.at(-1) as TrustedWorkflowRuntimeOptions;
    const page = [
      dashboardRow('Z-dashboard', 'owner-alpha', '2026-10-04T11:00:00.000Z'),
      dashboardRow('a-dashboard', 'owner-alpha', '2026-10-04T12:00:00.000Z'),
    ];
    const calls: WorkflowStorageQuery[] = [];
    const projections = dashboardProjectionReader(new Map([['owner-alpha', [page, []]]]), calls);
    const latestDashboard = contextFactoryFor(options, projections, 'owner-alpha');

    expect('Z-dashboard'.localeCompare('a-dashboard')).toBeGreaterThan(0);
    expect((await latestDashboard())?.id).toBe('a-dashboard');
    expect(calls).toEqual([
      { kind: 'scoped', table: 'dashboards', ownerId: 'owner-alpha', limit: 100 },
      { kind: 'scoped', table: 'dashboards', ownerId: 'owner-alpha', cursor: 'a-dashboard', limit: 1 },
    ]);
  });

  it('uses a one-row tail query after an empty first page and fails closed if that tail is nonempty', async () => {
    configureReadyBootstrap();
    const server = await loadServerFactory();
    await server.getWorkflowV2ServerRuntime();
    const options = state.runtimeOptions.at(-1) as TrustedWorkflowRuntimeOptions;
    const calls: WorkflowStorageQuery[] = [];
    const projections = dashboardProjectionReader(new Map([[
      'owner-alpha', [[], [dashboardRow('dashboard-hidden-tail', 'owner-alpha', '2026-10-04T12:00:00.000Z')]],
    ]]), calls);
    const latestDashboard = contextFactoryFor(options, projections, 'owner-alpha');

    await expect(latestDashboard()).rejects.toMatchObject({ code: 'WORKFLOW_METADATA_UNAVAILABLE' });
    expect(calls).toEqual([
      { kind: 'scoped', table: 'dashboards', ownerId: 'owner-alpha', limit: 100 },
      { kind: 'scoped', table: 'dashboards', ownerId: 'owner-alpha', limit: 1 },
    ]);
  });

  it('fails closed when cursor paging repeats dashboard rows', async () => {
    configureReadyBootstrap();
    const server = await loadServerFactory();
    await server.getWorkflowV2ServerRuntime();
    const options = state.runtimeOptions.at(-1) as TrustedWorkflowRuntimeOptions;
    const page = Array.from({ length: 100 }, (_, index) => dashboardRow(
      `dashboard-${String(index).padStart(3, '0')}`,
      'owner-alpha',
      '2026-10-04T10:00:00.000Z',
    ));
    const calls: WorkflowStorageQuery[] = [];
    const projections = dashboardProjectionReader(new Map([['owner-alpha', [page, page]]]), calls);
    const latestDashboard = contextFactoryFor(options, projections, 'owner-alpha');

    await expect(latestDashboard()).rejects.toMatchObject({ code: 'WORKFLOW_METADATA_UNAVAILABLE' });
    expect(page).toHaveLength(100);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ cursor: 'dashboard-099', limit: 100 });
  });

  it('fails closed when cursor paging exceeds the owned-dashboard limit', async () => {
    configureReadyBootstrap();
    const server = await loadServerFactory();
    await server.getWorkflowV2ServerRuntime();
    const options = state.runtimeOptions.at(-1) as TrustedWorkflowRuntimeOptions;
    const rows = Array.from({ length: 1_001 }, (_, index) => dashboardRow(
      `dashboard-${String(index).padStart(4, '0')}`,
      'owner-alpha',
      '2026-10-04T10:00:00.000Z',
    ));
    const pages = Array.from({ length: 11 }, (_, page) => rows.slice(page * 100, (page + 1) * 100));
    const calls: WorkflowStorageQuery[] = [];
    const projections = dashboardProjectionReader(new Map([['owner-alpha', pages]]), calls);
    const latestDashboard = contextFactoryFor(options, projections, 'owner-alpha');

    await expect(latestDashboard()).rejects.toMatchObject({ code: 'WORKFLOW_METADATA_UNAVAILABLE' });
    expect(rows).toHaveLength(1_001);
    expect(calls).toHaveLength(11);
  });

  it('fails closed when a scoped dashboard row belongs to another owner', async () => {
    configureReadyBootstrap();
    const server = await loadServerFactory();
    await server.getWorkflowV2ServerRuntime();
    const options = state.runtimeOptions.at(-1) as TrustedWorkflowRuntimeOptions;
    const calls: WorkflowStorageQuery[] = [];
    const projections = dashboardProjectionReader(new Map([[
      'owner-alpha', [[dashboardRow('dashboard-foreign', 'owner-beta', '2026-10-04T12:00:00.000Z')]],
    ]]), calls);
    const latestDashboard = contextFactoryFor(options, projections, 'owner-alpha');

    await expect(latestDashboard()).rejects.toMatchObject({ code: 'WORKFLOW_METADATA_UNAVAILABLE' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: 'scoped', table: 'dashboards', ownerId: 'owner-alpha' });
  });
});

type DashboardPage = ProjectedRow<Dashboard>[];

function dashboardProjectionReader(
  pagesByOwner: ReadonlyMap<string, readonly DashboardPage[]>,
  calls: WorkflowStorageQuery[],
): WorkflowProjectionReader {
  const pageIndexes = new Map<string, number>();
  return {
    get: async () => undefined,
    query: async <T>(query: WorkflowStorageQuery): Promise<ProjectedRow<T>[]> => {
      calls.push(query);
      if (query.kind !== 'scoped' || query.ownerId === undefined) {
        throw new Error('Dashboard context must issue an owner-scoped query');
      }
      const index = pageIndexes.get(query.ownerId) ?? 0;
      pageIndexes.set(query.ownerId, index + 1);
      return (pagesByOwner.get(query.ownerId)?.[index] ?? []).map(row => row as ProjectedRow<T>);
    },
  };
}

function dashboardRow(id: string, ownerId: string, createdAt: string): ProjectedRow<Dashboard> {
  return {
    id,
    rowVersion: 1,
    body: {
      id,
      ownerId,
      spec: {
        title: 'Fixture dashboard',
        description: '',
        scope: { region: 'east', date: BUSINESS_DATE },
        widgets: [{ type: 'text_summary', title: 'Summary' }],
      },
      packs: [],
      createdAt,
      updatedAt: createdAt,
      lastRefreshAt: createdAt,
      sourceMetadata: [],
      analysis: null,
      evidenceVersion: 'fixture-v1',
    },
  };
}

function contextFactoryFor(options: TrustedWorkflowRuntimeOptions, projections: WorkflowProjectionReader, ownerId: string) {
  const contextFactory = options.contextFactory;
  return () => contextFactory(
    {} as Parameters<typeof contextFactory>[0],
    { actor: { id: ownerId } } as unknown as Parameters<typeof contextFactory>[1],
    { projections, now: () => new Date('2026-10-04T14:00:00.000Z') } as Parameters<typeof contextFactory>[2],
  ).latestDashboard();
}
