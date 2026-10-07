import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { ConciergeService } from '../../lib/core/service';
import { withCommitConflictRetry } from '../../lib/storage/conflict-retry';
import { createSqliteStore } from '../../lib/storage/sqlite';
import type { Actor, Profile, StoredRow, Store, Table, Transaction } from '../../lib/contracts';

export const BUSINESS_DATE = '2026-10-01';
export const CLOSED_BUSINESS_DATE = '2026-10-01';
export const FIXED_NOW = new Date('2026-10-02T05:00:00.000Z');

export const profiles: Profile[] = [
  {
    id: 'executive', name: 'Operations Executive', role: 'executive', active: true,
    permissions: ['sales.read', 'operations.read', 'dashboard.create', 'dashboard.share', 'ticket.create', 'demo.update'],
    regions: ['east', 'central', 'south'],
  },
  {
    id: 'east', name: 'East Manager', role: 'east_manager', active: true,
    permissions: ['sales.read', 'operations.read', 'dashboard.create', 'dashboard.share', 'ticket.create'],
    regions: ['east'],
  },
  {
    id: 'hr', name: 'HR Administrator', role: 'hr_admin', active: true,
    permissions: ['hr.read', 'badge.revoke'],
    regions: [],
  },
];

export const actors: Record<'executive' | 'east' | 'hr', Actor> = {
  executive: { ...profiles[0], sessionId: 'test-session-executive', mode: 'scripted_demo', modeRevision: 0 },
  east: { ...profiles[1], sessionId: 'test-session-east', mode: 'scripted_demo', modeRevision: 0 },
  hr: { ...profiles[2], sessionId: 'test-session-hr', mode: 'scripted_demo', modeRevision: 0 },
};

const sourceRows: Array<[Table, StoredRow[]]> = [
  ['profiles', profiles.map((profile) => ({ ...profile }))],
  ['branches', [
    { id: 'E02', name: 'East Two', region: 'east' },
    { id: 'C01', name: 'Central Confidential Branch', region: 'central' },
  ]],
  ['products', [{ id: 'P001', name: 'Synthetic Coffee', category: 'beverage' }]],
  ['sales_orders', [
    { id: 'SO-E02-PAID', branchId: 'E02', date: CLOSED_BUSINESS_DATE, amountSatang: 150_000, status: 'paid', updatedAt: '2026-10-01T16:59:55.000Z' },
    { id: 'SO-E02-REFUNDED', branchId: 'E02', date: CLOSED_BUSINESS_DATE, amountSatang: 25_000, status: 'refunded', updatedAt: '2026-10-01T16:59:55.000Z' },
    { id: 'SO-E02-CANCELLED', branchId: 'E02', date: CLOSED_BUSINESS_DATE, amountSatang: 30_000, status: 'cancelled', updatedAt: '2026-10-01T16:59:55.000Z' },
    { id: 'SO-C01-PAID', branchId: 'C01', date: CLOSED_BUSINESS_DATE, amountSatang: 70_000, status: 'paid', updatedAt: '2026-10-01T16:59:55.000Z' },
  ]],
  ['sales_targets', [
    { id: 'TGT-E02-2026-10-01', branchId: 'E02', date: CLOSED_BUSINESS_DATE, amountSatang: 200_000, updatedAt: '2026-10-01T16:59:55.000Z' },
    { id: 'TGT-C01-2026-10-01', branchId: 'C01', date: CLOSED_BUSINESS_DATE, amountSatang: 100_000, updatedAt: '2026-10-01T16:59:55.000Z' },
  ]],
  ['inventory_snapshots', [
    { id: 'INV-E02-P001-2026-10-01', branchId: 'E02', productId: 'P001', date: CLOSED_BUSINESS_DATE, onHand: 2, minimum: 5, observedAt: '2026-10-01T16:59:55.000Z', updatedAt: '2026-10-01T16:59:55.000Z' },
  ]],
  ['incidents', [
    { id: 'INC-E02-PAYMENT', branchId: 'E02', date: CLOSED_BUSINESS_DATE, title: 'Payment terminal outage', kind: 'payment', status: 'open', startedAt: '2026-10-01T09:00:00.000Z', endedAt: null, updatedAt: '2026-10-01T16:59:55.000Z' },
  ]],
  ['staffing_summaries', [
    { id: 'STF-E02-2026-10-01', branchId: 'E02', date: CLOSED_BUSINESS_DATE, planned: 5, actual: 3, observedAt: '2026-10-01T16:59:55.000Z', updatedAt: '2026-10-01T16:59:55.000Z' },
  ]],
  ['employees', [
    { id: 'E024', name: 'Synthetic Employee E024', branchId: 'E02', active: true },
    { id: 'E025', name: 'Synthetic Employee E025', branchId: 'E02', active: true },
  ]],
  ['policy_documents', []],
  ['mock_badges', [
    { id: 'C102', employeeId: 'E024', state: 'active', version: 1, updatedAt: '2026-10-01T06:00:00.000Z', operationKey: 'badge-seed-C102' },
    { id: 'C103', employeeId: 'E025', state: 'revoked', version: 2, updatedAt: '2026-10-01T06:00:00.000Z', operationKey: 'badge-seed-C103' },
    { id: 'C104', employeeId: 'E025', state: 'active', version: 1, updatedAt: '2026-10-01T06:00:00.000Z', operationKey: 'badge-seed-C104' },
  ]],
  ['sessions', Object.values(actors).map((actor) => ({
    id: actor.sessionId,
    profileId: actor.id,
    mode: actor.mode,
    modeRevision: actor.modeRevision,
    csrfToken: 'test-csrf-token',
    expiresAt: '2099-01-01T00:00:00.000Z',
  }))],
];

async function removeFixtureDirectory(directory: string) {
  const root = resolve(tmpdir());
  const target = resolve(directory);
  const relativePath = relative(root, target);
  if (relativePath === '' || relativePath === '..' || relativePath.startsWith(`..${sep}`)
    || relativePath.includes(sep) || !basename(target).startsWith('nexus-tests-')) {
    throw new Error('Refusing to remove a test database outside its generated temporary directory.');
  }
  await rm(target, { recursive: true, force: true });
}

async function createLocalPgStore(): Promise<Store> {
  const [{ createSupabaseStore }, { localPgConfig, resetLocalPgData }] = await Promise.all([
    import('../../lib/storage/supabase'),
    import('./local-pg'),
  ]);
  const config = localPgConfig();
  resetLocalPgData();
  return withCommitConflictRetry(createSupabaseStore(config.url, config.serviceRoleKey));
}

export async function createWorkspaceFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-tests-'));
  const databasePath = join(directory, 'private.sqlite');
  let store: Store | undefined;
  try {
    // BIZTANIA_PG_TESTS=1: the same fixture over the local Supabase/PostgreSQL stack (data tables emptied first).
    const activeStore = process.env.BIZTANIA_PG_TESTS === '1' ? await createLocalPgStore() : createSqliteStore(databasePath);
    store = activeStore;
    await activeStore.transaction(async (tx) => {
      for (const [table, rows] of sourceRows) {
        for (const row of rows) await tx.put(table, row);
      }
    });

    let now = new Date(FIXED_NOW);
    const service = new ConciergeService(activeStore, {
      businessDate: BUSINESS_DATE,
      now: () => new Date(now),
    });

    return {
      store: activeStore,
      service,
      async setNow(next: Date) { now = new Date(next); },
      async patchSession(sessionId: string, patch: Record<string, unknown>) {
        await activeStore.transaction(async (tx) => {
          const session = await tx.get<Record<string, unknown> & { id: string }>('sessions', sessionId);
          if (!session) throw new Error(`Missing fixture session ${sessionId}`);
          await tx.put('sessions', { ...session, ...patch, id: sessionId });
        });
      },
      async dispose() {
        try {
          store?.close?.();
        } finally {
          await removeFixtureDirectory(directory);
        }
      },
    };
  } catch (error) {
    store?.close?.();
    await removeFixtureDirectory(directory);
    throw error;
  }
}

export function dashboardPayload(region = 'east') {
  const branchIds = region === 'all' ? ['E02', 'C01'] : ['E02'];
  return {
    kind: 'dashboard_create' as const,
    spec: {
      title: `${region} sales overview`,
      description: 'Synthetic sales and operating evidence for one closed business date.',
      scope: { region, date: CLOSED_BUSINESS_DATE, branchIds },
      widgets: [
        { type: 'metric' as const, title: 'Net sales', metric: 'net_sales' as const },
        { type: 'table' as const, title: 'Branch metrics', dataset: 'branch_metrics' as const },
      ],
    },
  };
}

export function loseOneTicketCommitResponse(base: Store): Store & { targetCommitCount(): number; targetDispatchCount(): number } {
  let armed = true;
  let committedTargets = 0;
  let targetDispatches = 0;
  return {
    adapter: base.adapter,
    list: <T>(table: Table) => base.list<T>(table),
    get: <T>(table: Table, id: string) => base.get<T>(table, id),
    async transaction<T>(work: (tx: Transaction) => Promise<T>) {
      let wroteTarget = false;
      const result = await base.transaction(async (tx) => {
        const observed: Transaction = {
          list: <R>(table: Table) => tx.list<R>(table),
          get: <R>(table: Table, id: string) => {
            return tx.get<R>(table, id);
          },
          put: async <R extends { id: string }>(table: Table, row: R) => {
            await tx.put(table, row);
            if (table === 'mock_tickets') {wroteTarget = true;targetDispatches += 1;}
          },
          remove: (table: Table, id: string) => tx.remove(table, id),
        };
        return work(observed);
      });
      if (wroteTarget) {
        committedTargets += 1;
        if (armed) {
          armed = false;
          throw new Error('simulated response loss after the mock target transaction committed');
        }
      }
      return result;
    },
    close: () => base.close?.(),
    targetCommitCount: () => committedTargets,
    targetDispatchCount: () => targetDispatches,
  };
}
