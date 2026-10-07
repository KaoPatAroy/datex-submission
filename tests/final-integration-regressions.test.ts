import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ActionKind,
  ActionPayload,
  Actor,
  Employee,
  Profile,
  PendingAction,
  Receipt,
  ReceiptView,
  RowFilter,
  Store,
  Table,
  Ticket,
  Transaction,
} from '../lib/contracts';
import { ConciergeService } from '../lib/core/service';
import { digest } from '../lib/core/utils';
import {
  defineAction,
  type ActionBinding,
  type TargetContext,
  type TrustedPackRuntime,
  type TypedActionBinding,
} from '../lib/core/runtime-contracts';
import { hrRuntime } from '../lib/packs/hr-runtime';
import { operationsRuntime } from '../lib/packs/operations-runtime';
import { salesRuntime } from '../lib/packs/sales-runtime';
import { createSeedData } from '../lib/seed/generate';
import { createSqliteStore } from '../lib/storage/sqlite';
import {
  actors,
  BUSINESS_DATE,
  CLOSED_BUSINESS_DATE,
  createWorkspaceFixture,
  dashboardPayload,
  FIXED_NOW,
  loseOneTicketCommitResponse,
} from './helpers/workspace';
import { conversationStep, plan, planner } from './helpers/turn-planner';

vi.mock('@/lib/router/planner/provider', async importOriginal =>
  (await import('./helpers/turn-planner')).plannerProviderModule(await importOriginal<object>()));

type WorkspaceFixture = Awaited<ReturnType<typeof createWorkspaceFixture>>;
type TicketPayload = Extract<ActionPayload, { kind: 'ticket_create' }>;

function serviceFor(
  store: Store,
  options: {
    runtimes?: TrustedPackRuntime[];
  } = {},
): ConciergeService {
  return new ConciergeService(store, {
    businessDate: BUSINESS_DATE,
    now: () => new Date(FIXED_NOW),
    ...options,
  });
}

function fullReceipt(view: ReceiptView): Receipt {
  if (view.visibility !== 'full') throw new Error('Expected a full receipt view.');
  return view;
}

async function ticketPayload(
  service: ConciergeService,
  actor: Actor,
  unansweredQuestion: string,
): Promise<TicketPayload> {
  const evidence = await service.queryEvidence(actor, {
    region: 'east',
    date: CLOSED_BUSINESS_DATE,
    branchIds: ['E02'],
  });
  const branch = evidence.branches.find((candidate) => candidate.branchId === 'E02');
  if (!branch) throw new Error('The East ticket fixture branch is missing.');
  return {
    kind: 'ticket_create',
    scope: evidence.scope,
    targets: [{
      branchId: branch.branchId,
      assigneeId: 'E024',
      title: 'Review the East Two sales gap',
      reason: 'The available synthetic evidence does not prove a cause.',
      sourceIds: [...branch.sourceIds],
      unansweredQuestion,
    }],
  };
}

function observeTransaction(
  tx: Transaction,
  onPut: (table: Table, row: { id: string }) => void | Promise<void>,
): Transaction {
  return {
    list: <T>(table: Table, filters?: RowFilter) => tx.list<T>(table, filters),
    get: <T>(table: Table, id: string) => tx.get<T>(table, id),
    put: async <T extends { id: string }>(table: Table, row: T) => {
      await tx.put(table, row);
      await onPut(table, row);
    },
    remove: (table: Table, id: string) => tx.remove(table, id),
  };
}

function loseTargetResponseAfterCommit(
  base: Store,
  targetTable: Table,
  afterCommit: () => Promise<void>,
) {
  let armed = true;
  let targetWriteCount = 0;
  let lostResponseCount = 0;
  const store: Store = {
    adapter: base.adapter,
    list: <T>(table: Table, filters?: RowFilter) => base.list<T>(table, filters),
    get: <T>(table: Table, id: string) => base.get<T>(table, id),
    async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
      let wroteTarget = false;
      const result = await base.transaction((tx) => work(observeTransaction(tx, (table) => {
        if (table === targetTable) {
          wroteTarget = true;
          targetWriteCount += 1;
        }
      })));
      if (wroteTarget && armed) {
        armed = false;
        lostResponseCount += 1;
        await afterCommit();
        throw new Error('Simulated response loss after the target transaction committed.');
      }
      return result;
    },
    close: () => base.close?.(),
  };
  return {
    store,
    targetWriteCount: () => targetWriteCount,
    lostResponseCount: () => lostResponseCount,
  };
}

function crossReleaseDashboardStore(
  base: Store,
  faults: { loseResponseActionIds: string[]; releaseChangeActionId?: string },
  afterCommit: () => Promise<void>,
) {
  let lostResponseCount = 0;
  let dashboardWriteCount = 0;
  const store: Store = {
    adapter: base.adapter,
    list: <T>(table: Table, filters?: RowFilter) => base.list<T>(table, filters),
    get: <T>(table: Table, id: string) => base.get<T>(table, id),
    async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
      let committedDashboardWrites = 0;
      const committedDashboardActionIds = new Set<string>();
      const result = await base.transaction((tx) => work({
        list: <R>(table: Table, filters?: RowFilter) => tx.list<R>(table, filters),
        get: <R>(table: Table, id: string) => tx.get<R>(table, id),
        put: async <R extends { id: string }>(table: Table, row: R) => {
          const rawOperationKey = (row as { operationKey?: unknown }).operationKey;
          const operationKey = typeof rawOperationKey === 'string' ? rawOperationKey : '';
          const actionId = operationKey.split(':', 1)[0].replace(/^execution_/, '');
          await tx.put(table, row);
          if (table === 'dashboards') {
            committedDashboardWrites += 1;
            committedDashboardActionIds.add(actionId);
          }
        },
        remove: (table: Table, id: string) => tx.remove(table, id),
      }));
      dashboardWriteCount += committedDashboardWrites;
      const lostResponseActionIds = [...committedDashboardActionIds]
        .filter((actionId) => faults.loseResponseActionIds.includes(actionId));
      // Inject the transport loss only after the adapter transaction has committed.
      if (lostResponseActionIds.length > 0) {
        lostResponseCount += 1;
        if (lostResponseActionIds.includes(faults.releaseChangeActionId ?? '')) {
          await afterCommit();
        }
        throw new Error('Lost response after the dashboard target transaction committed.');
      }
      return result;
    },
    close: () => base.close?.(),
  };
  return {
    store,
    dashboardWriteCount: () => dashboardWriteCount,
    lostResponseCount: () => lostResponseCount,
  };
}

function afterLostTicketResponse(
  base: Store,
  afterCommit: () => Promise<void>,
): Store & { targetCommitCount(): number; targetDispatchCount(): number } {
  const lossy = loseOneTicketCommitResponse(base);
  let changed = false;
  const store: Store & { targetCommitCount(): number; targetDispatchCount(): number } = {
    adapter: lossy.adapter,
    list: <T>(table: Table, filters?: RowFilter) => lossy.list<T>(table, filters),
    get: <T>(table: Table, id: string) => lossy.get<T>(table, id),
    async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
      try {
        return await lossy.transaction(work);
      } catch (error) {
        if (!changed && lossy.targetCommitCount() === 1) {
          changed = true;
          await afterCommit();
        }
        throw error;
      }
    },
    close: () => base.close?.(),
    targetCommitCount: () => lossy.targetCommitCount(),
    targetDispatchCount: () => lossy.targetDispatchCount(),
  };
  return store;
}

function withPendingActionReadOverlay(
  base: Store & { targetCommitCount(): number; targetDispatchCount(): number },
  overlay: () => PendingAction | undefined,
): Store & { targetCommitCount(): number; targetDispatchCount(): number } {
  const readOne = async <T>(table: Table, id: string, read: () => Promise<T | undefined>): Promise<T | undefined> => {
    const candidate = overlay();
    if (table === 'pending_actions' && candidate?.id === id) return candidate as T;
    return read();
  };
  const readMany = async <T>(table: Table, read: () => Promise<T[]>): Promise<T[]> => {
    const rows = await read();
    const candidate = table === 'pending_actions' ? overlay() : undefined;
    if (!candidate) return rows;
    return rows.map((row) => (row as { id?: unknown }).id === candidate.id ? candidate as T : row);
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
    targetCommitCount: () => base.targetCommitCount(),
    targetDispatchCount: () => base.targetDispatchCount(),
  };
}
function withTicketVerifyCounter(
  runtime: TrustedPackRuntime,
  counter: { value: number },
): TrustedPackRuntime {
  return withActionVerifyCounter(runtime, 'ticket_create', counter);
}

function withActionVerifyCounter(
  runtime: TrustedPackRuntime,
  kind: ActionKind,
  counter: { value: number },
): TrustedPackRuntime {
  return {
    ...runtime,
    actions: runtime.actions.map((action) => {
      if (action.kind !== kind) return action;
      const verify = action.verify;
      return {
        ...action,
        verify: async (context: TargetContext, payload: ActionPayload) => {
          counter.value += 1;
          return verify(context, payload);
        },
      } as ActionBinding;
    }),
  };
}

async function removeGeneratedFixtureDirectory(directory: string): Promise<void> {
  const tempRoot = resolve(tmpdir());
  const target = resolve(directory);
  const relativePath = relative(tempRoot, target);
  if (relativePath === '' || relativePath === '..' || relativePath.startsWith('..' + sep)
    || relativePath.includes(sep) || !basename(target).startsWith('nexus-tests-final-demo-')) {
    throw new Error('Refusing to remove a test database outside its generated temporary directory.');
  }
  await rm(target, { recursive: true, force: true });
}

async function createFullSeedStore() {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-tests-final-demo-'));
  let store: Store | undefined;
  try {
    const databasePath = join(directory, 'private.sqlite');
    const activeStore = createSqliteStore(databasePath);
    store = activeStore;
    const seed = createSeedData(BUSINESS_DATE);
    const currentDate = <T extends { date: string }>(rows: T[]) =>
      rows.filter((row) => row.date === BUSINESS_DATE);
    const rows: Array<[Table, Array<{ id: string }>]> = [
      ['profiles', seed.profiles],
      ['branches', seed.branches],
      ['products', seed.products],
      ['sales_orders', currentDate(seed.sales_orders)],
      ['sales_targets', currentDate(seed.sales_targets)],
      ['inventory_snapshots', currentDate(seed.inventory_snapshots)],
      ['incidents', currentDate(seed.incidents)],
      ['staffing_summaries', currentDate(seed.staffing_summaries)],
      ['employees', seed.employees],
      ['policy_documents', seed.policy_documents],
      ['mock_badges', seed.mock_badges],
      ['sessions', Object.values(actors).map((actor) => ({
        id: actor.sessionId,
        profileId: actor.id,
        mode: actor.mode,
        modeRevision: actor.modeRevision,
        csrfToken: 'private-final-regression-csrf',
        expiresAt: '2099-01-01T00:00:00.000Z',
      }))],
    ];
    await activeStore.transaction(async (tx) => {
      for (const [table, values] of rows) {
        for (const value of values) await tx.put(table, value);
      }
    });
    return {
      store: activeStore,
      async dispose() {
        try {
          activeStore.close?.();
        } finally {
          await removeGeneratedFixtureDirectory(directory);
        }
      },
    };
  } catch (error) {
    store?.close?.();
    await removeGeneratedFixtureDirectory(directory);
    throw error;
  }
}

function hashStoredAction(action: PendingAction, actionContractVersion: number): PendingAction {
  const changed = { ...action, actionContractVersion: actionContractVersion as 1 };
  const {
    actorId,
    sessionId,
    mode,
    modeRevision,
    payload,
    evidenceVersion,
    packs,
    expiresAt,
    receiptAccess,
    releaseRevision,
    actionContractVersion: storedContractVersion,
    approvalScope,
  } = changed;
  return {
    ...changed,
    payloadHash: digest({
      actorId,
      sessionId,
      mode,
      modeRevision,
      payload,
      evidenceVersion,
      packs,
      expiresAt,
      receiptAccess,
      releaseRevision,
      actionContractVersion: storedContractVersion,
      approvalScope,
      approvalDisplay: action.approvalDisplay,
    }),
  };
}

async function updateProfile(
  store: Store,
  profileId: string,
  update: (profile: Profile) => Profile,
): Promise<void> {
  await store.transaction(async (tx) => {
    const profile = await tx.get<Profile>('profiles', profileId);
    if (!profile) throw new Error('Profile fixture is missing: ' + profileId);
    await tx.put('profiles', update(profile));
  });
}

async function revokeOperationsRead(store: Store, profileId: string): Promise<void> {
  await updateProfile(store, profileId, (profile) => ({
    ...profile,
    permissions: profile.permissions.filter((permission) => permission !== 'operations.read'),
  }));
}

async function restoreOperationsRead(store: Store, profileId: string): Promise<void> {
  await updateProfile(store, profileId, (profile) => ({
    ...profile,
    permissions: profile.permissions.includes('operations.read')
      ? profile.permissions
      : [...profile.permissions, 'operations.read'],
  }));
}

async function deactivateProfile(store: Store, profileId: string): Promise<void> {
  await updateProfile(store, profileId, (profile) => ({ ...profile, active: false }));
}

async function deleteEastEvidence(store: Store): Promise<void> {
  const sourceTables: Table[] = [
    'sales_orders',
    'sales_targets',
    'inventory_snapshots',
    'incidents',
    'staffing_summaries',
  ];
  await store.transaction(async (tx) => {
    for (const table of sourceTables) {
      const rows = await tx.list<{ id: string; branchId: string }>(table);
      for (const row of rows) {
        if (row.branchId === 'E02') await tx.remove(table, row.id);
      }
    }
    const employees = await tx.list<Employee>('employees');
    for (const employee of employees) {
      if (employee.branchId === 'E02') {
        await tx.put('employees', { ...employee, branchId: null });
      }
    }
    await tx.remove('branches', 'E02');
  });
}

function createSerializationLoserStore(base: Store, operationId: string) {
  let initialReceiptReads = 0;
  let claimTransactions = 0;
  let serializationFailures = 0;
  let targetWriteCount = 0;
  let releaseReceiptReads!: () => void;
  let releaseClaimCommitted!: () => void;
  let releaseLoser!: () => void;
  const receiptReadBarrier = new Promise<void>((resolve) => { releaseReceiptReads = resolve; });
  const claimCommitted = new Promise<void>((resolve) => { releaseClaimCommitted = resolve; });
  const loserGate = new Promise<void>((resolve) => { releaseLoser = resolve; });

  const store: Store = {
    adapter: base.adapter,
    list: <T>(table: Table, filters?: RowFilter) => base.list<T>(table, filters),
    async get<T>(table: Table, id: string): Promise<T | undefined> {
      const value = await base.get<T>(table, id);
      if (table === 'action_executions' && id === operationId && initialReceiptReads < 2) {
        initialReceiptReads += 1;
        if (initialReceiptReads === 2) releaseReceiptReads();
        await receiptReadBarrier;
      }
      return value;
    },
    async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
      claimTransactions += 1;
      const attempt = claimTransactions;
      if (attempt === 2) {
        await claimCommitted;
        await loserGate;
        serializationFailures += 1;
        throw Object.assign(new Error('Supabase serialization loser.'), {
          code: 'CONFLICT',
          sqlState: '40001',
          definitelyNotCommitted: true,
        });
      }
      const result = await base.transaction((tx) => work(observeTransaction(tx, (table) => {
        if (table === 'mock_tickets') targetWriteCount += 1;
      })));
      if (attempt === 1) releaseClaimCommitted();
      return result;
    },
    close: () => base.close?.(),
  };
  return {
    store,
    releaseLoserConflict() {
      releaseReceiptReads();
      releaseClaimCommitted();
      releaseLoser();
    },
    serializationFailureCount: () => serializationFailures,
    targetWriteCount: () => targetWriteCount,
  };
}

function salesRuntimeWithDashboardExecute(
  executeCalls: { value: number },
): { baseline: TrustedPackRuntime; changed: TrustedPackRuntime } {
  const existing = salesRuntime.actions.find((action) => action.kind === 'dashboard_create');
  if (!existing) throw new Error('Sales dashboard-create binding is missing.');
  const original = existing as TypedActionBinding<'dashboard_create'>;
  const bind = (
    execute: TypedActionBinding<'dashboard_create'>['execute'],
  ): ActionBinding => defineAction<'dashboard_create'>({
    kind: 'dashboard_create',
    packIds: [...original.packIds],
    validate: original.validate,
    targetIds: original.targetIds,
    overlaps: original.overlaps,
    execute,
    verify: original.verify,
    visible: original.visible,
  });
  const install = (action: ActionBinding): TrustedPackRuntime => ({
    ...salesRuntime,
    actions: salesRuntime.actions.map((candidate) =>
      candidate.kind === 'dashboard_create' ? action : candidate),
  });
  return {
    baseline: install(bind(original.execute)),
    changed: install(bind(async (context, payload) => {
      executeCalls.value += 1;
      return original.execute(context, payload);
    })),
  };
}

describe('final service integration regressions', () => {
  let fixture!: WorkspaceFixture;

  beforeEach(async () => {
    vi.stubEnv('VERCEL', '0');
    vi.stubEnv('BIZTANIA_RELEASE_REVISION', 'integration-test-release');
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('USE_LOCAL_DEMO_DATA', 'true');
    vi.stubEnv('BIZTANIA_DYNAMIC_QUERY', '');
    planner.reset();
    fixture = await createWorkspaceFixture();
  });

  afterEach(async () => {
    try {
      await fixture.dispose();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('stales an approval when an original trusted action callback changes', async () => {
    const executeCalls = { value: 0 };
    const runtimes = salesRuntimeWithDashboardExecute(executeCalls);
    const prepareService = serviceFor(fixture.store, {
      runtimes: [runtimes.baseline, operationsRuntime, hrRuntime],
    });
    const confirmService = serviceFor(fixture.store, {
      runtimes: [runtimes.changed, operationsRuntime, hrRuntime],
    });
    const pending = await prepareService.prepare(actors.executive, dashboardPayload('east'));

    await expect(confirmService.confirm(actors.executive, pending.id))
      .rejects.toMatchObject({ code: 'STALE_ACTION', status: 409 });

    expect(executeCalls.value).toBe(0);
    expect(await fixture.store.list('dashboards')).toHaveLength(0);
    expect(await fixture.store.get<typeof pending>('pending_actions', pending.id))
      .toMatchObject({ status: 'pending' });
  });

  it('converges a SQLSTATE 40001 claim loser on the committed receipt and one ticket', async () => {
    const setupService = serviceFor(fixture.store);
    const payload = await ticketPayload(setupService, actors.executive, 'Which demand was missed?');
    const pending = await setupService.prepare(actors.executive, payload);
    const race = createSerializationLoserStore(fixture.store, 'execution_' + pending.id);
    const service = serviceFor(race.store);
    const calls = [
      service.confirm(actors.executive, pending.id),
      service.confirm(actors.executive, pending.id),
    ];

    let firstCompleted: ReceiptView;
    try {
      firstCompleted = await Promise.race(calls);
      expect(fullReceipt(firstCompleted).status).toBe('verified_success');
    } finally {
      race.releaseLoserConflict();
      await Promise.allSettled(calls);
    }

    const [leftView, rightView] = await Promise.all(calls);
    const left = fullReceipt(leftView);
    const right = fullReceipt(rightView);
    expect(race.serializationFailureCount()).toBe(1);
    expect(left.id).toBe(right.id);
    expect(left.status).toBe('verified_success');
    expect(right.status).toBe('verified_success');
    expect(race.targetWriteCount()).toBe(1);
    expect(await fixture.store.list('mock_tickets')).toHaveLength(1);
    expect(await fixture.store.list('action_executions')).toHaveLength(1);
  });

  it('verifies a committed dashboard share after the recipient becomes inactive', async () => {
    const createService = serviceFor(fixture.store);
    const dashboardAction = await createService.prepare(actors.executive, dashboardPayload('east'));
    const dashboardReceipt = fullReceipt(await createService.confirm(actors.executive, dashboardAction.id));
    const dashboardId = dashboardReceipt.dashboardId ?? dashboardReceipt.results[0]?.id;
    if (!dashboardId) throw new Error('Dashboard creation returned no target ID.');

    const fault = loseTargetResponseAfterCommit(
      fixture.store,
      'dashboard_shares',
      () => deactivateProfile(fixture.store, 'east'),
    );
    const service = serviceFor(fault.store);
    const pending = await service.prepare(actors.executive, {
      kind: 'dashboard_share',
      dashboardId,
      recipientId: 'east',
    });
    const receipt = fullReceipt(await service.confirm(actors.executive, pending.id));

    expect(await fixture.store.get<Profile>('profiles', 'east')).toMatchObject({ active: false });
    expect(fault.lostResponseCount()).toBe(1);
    expect(fault.targetWriteCount()).toBe(1);
    expect(receipt.kind).toBe('dashboard_share');
    expect(receipt.status).toBe('verified_success');
    expect(receipt.results).toEqual([
      expect.objectContaining({ targetId: 'east', status: 'verified_success' }),
    ]);
    expect(await fixture.store.list('dashboard_shares')).toHaveLength(1);
    expect(await fixture.store.list('mock_messages')).toHaveLength(1);
  });

  it('verifies a committed dashboard after its East evidence rows and branch disappear', async () => {
    const fault = loseTargetResponseAfterCommit(
      fixture.store,
      'dashboards',
      () => deleteEastEvidence(fixture.store),
    );
    const service = serviceFor(fault.store);
    const pending = await service.prepare(actors.executive, dashboardPayload('east'));
    const receipt = fullReceipt(await service.confirm(actors.executive, pending.id));

    expect(fault.lostResponseCount()).toBe(1);
    expect(fault.targetWriteCount()).toBe(1);
    expect(receipt.status).toBe('verified_success');
    expect(await fixture.store.get('branches', 'E02')).toBeUndefined();
    for (const table of [
      'sales_orders',
      'sales_targets',
      'inventory_snapshots',
      'incidents',
      'staffing_summaries',
    ] as const) {
      const rows = await fixture.store.list<{ id: string; branchId: string }>(table);
      expect(rows.some((row) => row.branchId === 'E02')).toBe(false);
    }
    expect(await fixture.store.get('dashboards', receipt.dashboardId!)).toBeTruthy();
  });

  it('returns a restricted receipt without verifying while read access is revoked, then verifies the same effect after access returns', async () => {
    vi.stubEnv('BIZTANIA_RELEASE_REVISION', 'restricted-readback-before');
    const verifyCalls = { value: 0 };
    const operations = withTicketVerifyCounter(operationsRuntime, verifyCalls);
    const store = afterLostTicketResponse(fixture.store, async () => {
      await revokeOperationsRead(fixture.store, 'executive');
      vi.stubEnv('BIZTANIA_RELEASE_REVISION', 'restricted-readback-after');
    });
    const service = serviceFor(store, { runtimes: [salesRuntime, operations, hrRuntime] });
    const payload = await ticketPayload(service, actors.executive, 'Which demand was missed?');
    const pending = await service.prepare(actors.executive, payload);
    const restrictedView = await service.confirm(actors.executive, pending.id);

    expect(restrictedView.visibility).toBe('restricted');
    expect(restrictedView.status).toBe('pending');
    expect(restrictedView.results).toEqual([]);
    expect(Object.keys(restrictedView)).not.toContain('kind');
    expect(Object.keys(restrictedView)).not.toContain('actorId');
    expect(Object.keys(restrictedView)).not.toContain('dashboardId');
    expect(Object.keys(restrictedView)).not.toContain('readbackRevision');
    expect(verifyCalls.value).toBe(0);
    expect(store.targetDispatchCount()).toBe(1);

    const acknowledgedWhileRestricted = await service.reconcile(
      actors.executive,
      restrictedView.id,
      'f'.repeat(64),
    );
    expect(acknowledgedWhileRestricted.visibility).toBe('restricted');
    expect(acknowledgedWhileRestricted.results).toEqual([]);
    expect(verifyCalls.value).toBe(0);

    await restoreOperationsRead(fixture.store, 'executive');
    const afterRestart = serviceFor(store, { runtimes: [salesRuntime, operations, hrRuntime] });
    const pendingWithToken = fullReceipt(await afterRestart.reconcile(actors.executive, restrictedView.id));
    expect(pendingWithToken.status).toBe('pending');
    expect(pendingWithToken.readbackRevision).toMatch(/^[a-f0-9]{64}$/);
    const verified = fullReceipt(await afterRestart.reconcile(
      actors.executive,
      restrictedView.id,
      pendingWithToken.readbackRevision!,
    ));
    expect(verified.status).toBe('verified_success');
    expect(verifyCalls.value).toBe(1);
    expect(store.targetDispatchCount()).toBe(1);
    expect(await fixture.store.list('mock_tickets')).toHaveLength(1);
  });

  it('does not run a verifier from an old release when a read-accessible receipt is recovered', async () => {
    vi.stubEnv('BIZTANIA_RELEASE_REVISION', 'release-before-restart');
    const verifyCalls = { value: 0 };
    const operations = withTicketVerifyCounter(operationsRuntime, verifyCalls);
    const store = afterLostTicketResponse(fixture.store, async () => {
      await revokeOperationsRead(fixture.store, 'executive');
    });
    const beforeRestart = serviceFor(store, { runtimes: [salesRuntime, operations, hrRuntime] });
    const payload = await ticketPayload(beforeRestart, actors.executive, 'Which demand was missed?');
    const pending = await beforeRestart.prepare(actors.executive, payload);
    const restricted = await beforeRestart.confirm(actors.executive, pending.id);
    expect(restricted.visibility).toBe('restricted');
    expect(verifyCalls.value).toBe(0);

    await restoreOperationsRead(fixture.store, 'executive');
    vi.stubEnv('BIZTANIA_RELEASE_REVISION', 'release-after-restart');
    const afterRestart = serviceFor(store, { runtimes: [salesRuntime, operations, hrRuntime] });
    const receipt = fullReceipt(await afterRestart.reconcile(actors.executive, restricted.id));

    expect(receipt.status).toBe('pending');
    expect(receipt.results).toEqual([
      expect.objectContaining({ targetId: 'E02', status: 'pending' }),
    ]);
    expect(verifyCalls.value).toBe(0);
    expect(store.targetDispatchCount()).toBe(1);
    expect(await fixture.store.list('mock_tickets')).toHaveLength(1);
  });

  it('projects an old pending approval as stale before confirmation after the local release changes', async () => {
    vi.stubEnv('BIZTANIA_RELEASE_REVISION', 'pending-release-before');
    const beforeRestart = serviceFor(fixture.store);
    const pending = await beforeRestart.prepare(actors.executive, dashboardPayload('east'));

    vi.stubEnv('BIZTANIA_RELEASE_REVISION', 'pending-release-after');
    const afterRestart = serviceFor(fixture.store);
    const workspace = await afterRestart.getWorkspace(actors.executive);
    const projected = workspace.actions.find((action) => action.id === pending.id);

    expect(projected).toMatchObject({ id: pending.id, status: 'stale' });
    expect(await fixture.store.get<PendingAction>('pending_actions', pending.id))
      .toMatchObject({ status: 'pending' });
    await expect(afterRestart.confirm(actors.executive, pending.id))
      .rejects.toMatchObject({ code: 'STALE_ACTION', status: 409 });
    expect(await fixture.store.list('dashboards')).toHaveLength(0);
  });

  it('pins dashboard-share approval scope to the recipient branch IDs', async () => {
    const dashboardAction = await fixture.service.prepare(actors.executive, dashboardPayload('all'));
    const dashboardReceipt = fullReceipt(await fixture.service.confirm(actors.executive, dashboardAction.id));
    const dashboardId = dashboardReceipt.dashboardId ?? dashboardReceipt.results[0]?.id;
    if (!dashboardId) throw new Error('Dashboard creation returned no target ID.');

    const shareAction = await fixture.service.prepare(actors.executive, {
      kind: 'dashboard_share',
      dashboardId,
      recipientId: 'east',
    });
    expect(shareAction.approvalScope).toEqual({
      region: 'east',
      date: CLOSED_BUSINESS_DATE,
      branchIds: ['E02'],
    });
  });

  it('hides HR tools that require hr.read when that permission is absent', async () => {
    await updateProfile(fixture.store, 'hr', (profile) => ({
      ...profile,
      permissions: ['badge.revoke'],
    }));
    const hrWorkspace = await fixture.service.getWorkspace(actors.hr);
    const hrCapability = hrWorkspace.capabilities.find((capability) => capability.id === 'hr');
    expect(hrCapability?.allowed).toBe(false);
    expect(hrCapability?.tools).not.toContain('hr.find_employee');
    expect(hrCapability?.tools).not.toContain('badge.prepare_revoke');
  });

  it('requires a receipt-bound current-release token for compatible V1 readback', async () => {
    vi.stubEnv('BIZTANIA_RELEASE_REVISION', 'readback-release-before');
    const verifyCalls = { value: 0 };
    let withholdFirstDashboardReadback = true;
    const countedSales = withActionVerifyCounter(salesRuntime, 'dashboard_create', verifyCalls);
    const sales = {
      ...countedSales,
      actions: countedSales.actions.map((action) => {
        if (action.kind !== 'dashboard_create') return action;
        const verify = action.verify;
        return {
          ...action,
          verify: async (context: TargetContext, payload: ActionPayload) => {
            const matched = await verify(context, payload);
            if (withholdFirstDashboardReadback) {
              withholdFirstDashboardReadback = false;
              return false;
            }
            return matched;
          },
        } as ActionBinding;
      }),
    };
    const runtimes = [sales, operationsRuntime, hrRuntime];
    const faults: { loseResponseActionIds: string[]; releaseChangeActionId?: string } = {
      loseResponseActionIds: [],
    };
    const fault = crossReleaseDashboardStore(
      fixture.store,
      faults,
      async () => { vi.stubEnv('BIZTANIA_RELEASE_REVISION', 'readback-release-after'); },
    );
    const beforeRestart = serviceFor(fault.store, { runtimes });
    const firstPayload = dashboardPayload('east');
    const secondPayload = {
      ...firstPayload,
      spec: { ...firstPayload.spec, title: 'A separate East dashboard preview' },
    };
    const firstAction = await beforeRestart.prepare(actors.executive, firstPayload);
    const secondAction = await beforeRestart.prepare(actors.executive, secondPayload);
    faults.loseResponseActionIds.push(firstAction.id, secondAction.id);
    faults.releaseChangeActionId = firstAction.id;

    const secondUnknown = fullReceipt(await beforeRestart.confirm(actors.executive, secondAction.id));
    expect(secondUnknown.status).toBe('pending');
    expect(secondUnknown.results[0]?.status).toBe('pending');
    expect(secondUnknown.actionId).toBe(secondAction.id);
    expect(verifyCalls.value).toBe(1);
    expect(fault.lostResponseCount()).toBe(1);
    expect(fault.dashboardWriteCount()).toBe(1);
    const afterSecondCommit = await fixture.store.list<{ id: string; spec: { title: string } }>('dashboards');
    expect(afterSecondCommit).toHaveLength(1);
    expect(afterSecondCommit[0]?.spec.title).toBe(secondPayload.spec.title);
    expect(secondUnknown.dashboardId).toBe(afterSecondCommit[0]?.id);

    const firstUnknown = fullReceipt(await beforeRestart.confirm(actors.executive, firstAction.id));
    expect(firstUnknown.status).toBe('pending');
    expect(firstUnknown.readbackRevision).toBeUndefined();
    expect(firstUnknown.actionId).toBe(firstAction.id);
    expect(firstUnknown.dashboardId).not.toBe(secondUnknown.dashboardId);
    expect(verifyCalls.value).toBe(1);
    expect(fault.lostResponseCount()).toBe(2);
    expect(fault.dashboardWriteCount()).toBe(2);
    const committedDashboards = await fixture.store.list<{ id: string; spec: { title: string } }>('dashboards');
    expect(committedDashboards).toHaveLength(2);
    expect(committedDashboards.map((dashboard) => dashboard.spec.title)).toEqual(expect.arrayContaining([
      firstPayload.spec.title,
      secondPayload.spec.title,
    ]));
    expect(committedDashboards.map((dashboard) => dashboard.id)).toEqual(expect.arrayContaining([
      firstUnknown.dashboardId,
      secondUnknown.dashboardId,
    ]));

    const afterRestart = serviceFor(fault.store, { runtimes });
    const firstCurrent = fullReceipt(await afterRestart.reconcile(actors.executive, firstUnknown.id));
    const secondCurrent = fullReceipt(await afterRestart.reconcile(actors.executive, secondUnknown.id));
    const firstToken = firstCurrent.readbackRevision;
    const secondToken = secondCurrent.readbackRevision;
    expect(firstCurrent.status).toBe('pending');
    expect(secondCurrent.status).toBe('pending');
    expect(firstCurrent.actionId).toBe(firstAction.id);
    expect(secondCurrent.actionId).toBe(secondAction.id);
    expect(firstToken).toMatch(/^[a-f0-9]{64}$/);
    expect(secondToken).toMatch(/^[a-f0-9]{64}$/);
    expect(firstToken).not.toBe(secondToken);
    expect(verifyCalls.value).toBe(1);

    await expect(afterRestart.reconcile(actors.executive, firstCurrent.id, '0'.repeat(64)))
      .rejects.toMatchObject({ code: 'STALE_ACTION', status: 409 });
    await expect(afterRestart.reconcile(actors.executive, secondCurrent.id, firstToken!))
      .rejects.toMatchObject({ code: 'STALE_ACTION', status: 409 });
    expect(verifyCalls.value).toBe(1);

    const verified = fullReceipt(await afterRestart.reconcile(actors.executive, firstCurrent.id, firstToken!));
    expect(verified.status).toBe('verified_success');
    expect(verified.actionId).toBe(firstAction.id);
    const secondVerified = fullReceipt(await afterRestart.reconcile(actors.executive, secondCurrent.id, secondToken!));
    expect(secondVerified.status).toBe('verified_success');
    expect(secondVerified.actionId).toBe(secondAction.id);
    expect(verifyCalls.value).toBe(3);
    expect(fault.dashboardWriteCount()).toBe(2);
    expect(fault.lostResponseCount()).toBe(2);
    expect(await fixture.store.list('dashboards')).toHaveLength(2);
  });

  it('keeps an unknown action contract pending without issuing or accepting a readback revision', async () => {
    vi.stubEnv('BIZTANIA_RELEASE_REVISION', 'unknown-contract-before');
    const verifyCalls = { value: 0 };
    const operations = withTicketVerifyCounter(operationsRuntime, verifyCalls);
    let actionId = '';
    let unsupportedAction: PendingAction | undefined;
    const lostResponseStore = afterLostTicketResponse(fixture.store, async () => {
      vi.stubEnv('BIZTANIA_RELEASE_REVISION', 'unknown-contract-after');
      const action = await fixture.store.get<PendingAction>('pending_actions', actionId);
      if (!action) throw new Error('Committed ticket approval is missing.');
      unsupportedAction = hashStoredAction(action, 2);
    });
    const store = withPendingActionReadOverlay(lostResponseStore, () => unsupportedAction);
    const runtimes = [salesRuntime, operations, hrRuntime];
    const beforeRestart = serviceFor(store, { runtimes });
    const pending = await beforeRestart.prepare(
      actors.executive,
      await ticketPayload(beforeRestart, actors.executive, 'Which demand was missed?'),
    );
    actionId = pending.id;
    const initial = fullReceipt(await beforeRestart.confirm(actors.executive, pending.id));
    expect(initial.status).toBe('pending');
    expect(unsupportedAction?.actionContractVersion).toBe(2);
    const persistedAction = await fixture.store.get<PendingAction>('pending_actions', pending.id);
    expect(persistedAction?.actionContractVersion).toBe(1);
    expect(persistedAction?.payloadHash).toBe(pending.payloadHash);
    expect(verifyCalls.value).toBe(0);
    expect(store.targetDispatchCount()).toBe(1);

    const afterRestart = serviceFor(store, { runtimes });
    const view = fullReceipt(await afterRestart.reconcile(actors.executive, initial.id));
    expect(view.status).toBe('pending');
    expect(view.readbackRevision).toBeUndefined();
    const acknowledged = fullReceipt(await afterRestart.reconcile(actors.executive, view.id, 'a'.repeat(64)));
    expect(acknowledged.status).toBe('pending');
    expect(verifyCalls.value).toBe(0);
    expect(store.targetDispatchCount()).toBe(1);
  });

  it('preserves a terminal demo receipt after a later scenario changes its target rows', async () => {
    const seeded = await createFullSeedStore();
    try {
      const verifyCalls = { value: 0 };
      const operations = withActionVerifyCounter(operationsRuntime, 'demo_update', verifyCalls);
      const service = serviceFor(seeded.store, { runtimes: [salesRuntime, operations, hrRuntime] });
      const firstAction = await service.prepare(actors.executive, {
        kind: 'demo_update',
        scenario: 'stock_recovered',
      });
      const firstReceipt = fullReceipt(await service.confirm(actors.executive, firstAction.id));
      expect(firstReceipt.status).toBe('verified_success');
      expect(verifyCalls.value).toBe(1);

      const nextAction = await service.prepare(actors.executive, {
        kind: 'demo_update',
        scenario: 'baseline',
      });
      const nextReceipt = fullReceipt(await service.confirm(actors.executive, nextAction.id));
      expect(nextReceipt.status).toBe('verified_success');
      expect(verifyCalls.value).toBe(2);
      const currentInventory = await seeded.store.list('inventory_snapshots');
      const currentIncidents = await seeded.store.list('incidents');

      const historical = fullReceipt(await service.reconcile(actors.executive, firstReceipt.id));

      expect(historical.status).toBe('verified_success');
      expect(historical.results[0]?.status).toBe('verified_success');
      expect(verifyCalls.value).toBe(2);
      expect(await seeded.store.list('inventory_snapshots')).toEqual(currentInventory);
      expect(await seeded.store.list('incidents')).toEqual(currentIncidents);
    } finally {
      await seeded.dispose();
    }
  });

  it('persists and verifies the exact approved unanswered question on the ticket target', async () => {
    const question = 'Which customer demand was missed? ลูกค้าต้องการอะไรแต่ไม่มีสินค้า?';
    const payload = await ticketPayload(fixture.service, actors.executive, question);
    const pending = await fixture.service.prepare(actors.executive, payload);
    const receipt = fullReceipt(await fixture.service.confirm(actors.executive, pending.id));
    const ticketId = receipt.results[0]?.id;
    if (!ticketId) throw new Error('Verified ticket receipt returned no target ID.');
    const ticket = await fixture.store.get<Ticket>('mock_tickets', ticketId);

    expect(ticket?.unansweredQuestion).toBe(question);
    expect(receipt.status).toBe('verified_success');
    expect(receipt.results[0]).toMatchObject({ targetId: 'E02', status: 'verified_success' });
  });

  it('does not verify a ticket when its committed unanswered question differs from the approval', async () => {
    const approvedQuestion = 'Which customer demand was missed? ลูกค้าต้องการอะไรแต่ไม่มีสินค้า?';
    const tamperedQuestion = 'Tampered after approval: no demand question.';
    const store = afterLostTicketResponse(fixture.store, async () => {
      const ticket = (await fixture.store.list<Ticket>('mock_tickets'))[0];
      if (!ticket) throw new Error('Committed ticket fixture is missing before tampering.');
      await fixture.store.transaction(async (tx) => {
        await tx.put('mock_tickets', { ...ticket, unansweredQuestion: tamperedQuestion });
      });
    });
    const service = serviceFor(store);
    const payload = await ticketPayload(service, actors.executive, approvedQuestion);
    const pending = await service.prepare(actors.executive, payload);
    const receipt = fullReceipt(await service.confirm(actors.executive, pending.id));

    expect(receipt.status).toBe('pending');
    expect(receipt.results).toEqual([
      expect.objectContaining({ targetId: 'E02', status: 'pending' }),
    ]);
    expect((await fixture.store.list<Ticket>('mock_tickets'))[0]?.unansweredQuestion).toBe(tamperedQuestion);
    expect(store.targetDispatchCount()).toBe(1);
    expect((await service.reconcile(actors.executive, receipt.id)).status).toBe('pending');
    expect(store.targetDispatchCount()).toBe(1);
  });

  it('reuses the original pending preview when recovering its turn instead of creating another turn', async () => {
    // Typed text is never interpreted in demo mode: the server-owned showcase card is the structured intent.
    const prompt = 'สร้าง Dashboard ยอดขาย';
    const original = await fixture.service.turn(actors.executive, prompt, undefined, undefined,
      { contractVersion: 2, requestKey: 'final-integration-dashboard-recovery', demoShowcaseId: 'executive-dashboard' });
    expect(original.pendingAction?.status).toBe('pending');
    const beforeMessages = (await fixture.store.list<{ id: string; role: string }>('conversation_messages')).map((row) => row.id);
    const beforeTools = (await fixture.store.list<{ id: string }>('tool_executions')).map((row) => row.id);
    const beforeActions = (await fixture.store.list<{ id: string }>('pending_actions')).map((row) => row.id);

    const recovered = await fixture.service.turn(
      actors.executive,
      prompt,
      original.conversationId,
      original.turnId,
    );

    expect(recovered.turnId).toBe(original.turnId);
    expect(recovered.conversationId).toBe(original.conversationId);
    expect(recovered.pendingAction?.id).toBe(original.pendingAction?.id);
    expect(recovered.pendingAction?.status).toBe('pending');
    expect((await fixture.store.list<{ id: string; role: string }>('conversation_messages')).map((row) => row.id))
      .toEqual(beforeMessages);
    expect((await fixture.store.list<{ id: string }>('tool_executions')).map((row) => row.id))
      .toEqual(beforeTools);
    expect((await fixture.store.list<{ id: string }>('pending_actions')).map((row) => row.id))
      .toEqual(beforeActions);
    expect(await fixture.store.list('dashboards')).toHaveLength(0);
  });

  // Replaces the deleted runAI test that injected AI analysis hypotheses: AI-authored analysis no longer exists, the only
  // AI-authored prose is a conversation step, which must pass the output-safety gate (number words are numeric claims).
  it('keeps English and Thai number-word AI claims out of surfaced and stored text', async () => {
    await fixture.patchSession(actors.executive.sessionId, { mode: 'live_ai', modeRevision: 1 });
    const liveExecutive = { ...actors.executive, mode: 'live_ai' as const, modeRevision: 1 };
    for (const prose of ['Net sales reached two million baht.', 'ยอดขายสองล้านบาท']) {
      planner.reply(plan(conversationStep('advice', prose)));
      const answer = await fixture.service.turn(liveExecutive, 'Compare East sales on 2026-10-01.');
      const workspace = await fixture.service.getWorkspace(liveExecutive);
      const assistant = workspace.messages.filter((message) => message.role === 'assistant').at(-1);
      const surfaced = JSON.stringify({
        message: answer.message,
        analysis: answer.analysis,
        storedAssistant: assistant,
      }).toLowerCase();

      expect(answer.message.length).toBeGreaterThan(0);
      expect(answer.message).not.toBe(prose);
      expect(surfaced).not.toContain('two million');
      expect(surfaced).not.toContain('สองล้านบาท');
    }
  });
});
