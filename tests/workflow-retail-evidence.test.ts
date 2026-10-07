import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Actor, Branch, Incident, Profile, SalesOrder, SalesTarget, Inventory, Staffing, Scope } from '../lib/contracts';
import { readEvidence } from '../lib/packs/retail/evidence';
import { readWorkflowEvidence } from '../lib/packs/retail/workflow-evidence';
import { reloadWorkflowPrincipal } from '../lib/workflows/authority';
import type { GuardedTransaction, Responsibility } from '../lib/workflows/contracts';
import type { ProjectedRow, WorkflowProjectionReader, WorkflowStorageQuery, WorkflowTransactionContext } from '../lib/storage/workflow-projections';
import { createWorkflowSqliteFixture } from './helpers/workflow-storage';

const NOW = new Date('2026-10-04T16:55:00.000Z');
const NOW_ISO = NOW.toISOString();
const BUSINESS_DATE = '2026-10-04';
const PRIOR_DATE = '2026-10-03';
const OBSERVED_AT = new Date(NOW.getTime() - 2 * 60_000).toISOString();
const FACT_TABLES = [
  'sales_orders',
  'sales_targets',
  'inventory_snapshots',
  'incidents',
  'staffing_summaries',
] as const;

type Fixture = Awaited<ReturnType<typeof createWorkflowSqliteFixture>>;
type Store = Fixture['store'];
type FactTable = typeof FACT_TABLES[number];
type FactQuery = Extract<WorkflowStorageQuery, { kind: 'scoped' }> & { table: FactTable };
type QueryTransform = (
  query: WorkflowStorageQuery,
  page: ProjectedRow<unknown>[],
  base: WorkflowProjectionReader,
) => Promise<ProjectedRow<unknown>[] | null | undefined> | ProjectedRow<unknown>[] | null | undefined;

interface PrincipalHandle {
  actor: Actor;
  sessionId: string;
}

interface PrincipalOptions {
  role?: Profile['role'];
  department?: 'sales_operations' | 'hr';
  purpose?: Responsibility['purpose'];
  permissions?: string[];
  regions?: string[];
  branchIds?: string[];
}

interface RetailEvidenceHarness {
  fixture: Fixture;
  store: Store;
  suffix: string;
  orgUnitId: string;
  branchId: string;
  otherBranchId: string;
  salesOrderIds: string[];
  productId: string;
  otherProductId: string;
  actor: PrincipalHandle;
  addPrincipal(options?: PrincipalOptions): Promise<PrincipalHandle>;
  dispose(): Promise<void>;
}

function isFactQuery(query: WorkflowStorageQuery): query is FactQuery {
  return query.kind === 'scoped' && FACT_TABLES.includes(query.table as FactTable);
}

function trackedReader(
  base: WorkflowProjectionReader,
  calls: WorkflowStorageQuery[],
  transform?: QueryTransform,
): WorkflowProjectionReader {
  return {
    get: <T>(table: WorkflowStorageQuery['table'], id: string) => base.get<T>(table, id),
    query: async <T>(query: WorkflowStorageQuery) => {
      calls.push(structuredClone(query));
      const page = await base.query<T>(query);
      const replacement = await transform?.(query, page as ProjectedRow<unknown>[], base);
      if (replacement === null) return undefined as unknown as ProjectedRow<T>[];
      return (replacement ?? page) as ProjectedRow<T>[];
    },
  };
}

type SalesOrderQuery = Extract<WorkflowStorageQuery, { kind: 'scoped' }> & { table: 'sales_orders' };

function isSalesOrderQuery(query: WorkflowStorageQuery): query is SalesOrderQuery {
  return query.kind === 'scoped' && query.table === 'sales_orders';
}

function rankFor(id: string, ranks: ReadonlyMap<string, number>): number {
  const rank = ranks.get(id);
  if (rank === undefined) throw new Error('The controlled database order received an unknown sale ID');
  return rank;
}

async function queryInControlledDatabaseOrder(
  base: WorkflowProjectionReader,
  query: SalesOrderQuery,
  ranks: ReadonlyMap<string, number>,
): Promise<ProjectedRow<unknown>[]> {
  // The controlled server rank models both exclusive gt filtering and ORDER BY.
  // It intentionally differs from JavaScript lexical order for case and punctuation.
  const allRows: ProjectedRow<unknown>[] = [];
  let storageCursor: string | undefined;
  while (true) {
    const storagePage = await base.query<unknown>({ ...query, cursor: storageCursor, limit: 100 });
    allRows.push(...storagePage);
    if (storagePage.length < 100) break;
    const nextCursor = storagePage.at(-1)?.id;
    if (!nextCursor || nextCursor === storageCursor) throw new Error('The native SQLite collection cursor did not advance');
    storageCursor = nextCursor;
  }

  const cursorRank = query.cursor === undefined ? -1 : rankFor(query.cursor, ranks);
  const ordered = allRows.sort((left, right) => rankFor(left.id, ranks) - rankFor(right.id, ranks));
  return ordered
    .filter((row) => rankFor(row.id, ranks) > cursorRank)
    .slice(0, query.limit ?? 100);
}

async function createHarness(): Promise<RetailEvidenceHarness> {
  const fixture = await createWorkflowSqliteFixture();
  const store = fixture.store;
  const suffix = randomUUID().replaceAll('-', '');
  const orgUnitId = 'retail-org-' + suffix;
  const branchId = 'retail-east-' + suffix;
  const otherBranchId = 'retail-west-' + suffix;
  const productId = 'retail-product-a-' + suffix;
  const otherProductId = 'retail-product-b-' + suffix;

  try {
    await store.workflowTransaction((tx) => tx.insertUnique('org_units', {
      id: orgUnitId,
      name: 'Synthetic Retail Evidence Unit ' + suffix,
      parentOrgUnitId: null,
      active: true,
    }, { constraint: 'org_units_primary_key', values: { id: orgUnitId } }));

    const branch: Branch & { orgUnitId: string } = {
      id: branchId,
      name: 'Synthetic East Retail Branch ' + suffix,
      region: 'East',
      orgUnitId,
    };
    const otherBranch: Branch & { orgUnitId: string } = {
      id: otherBranchId,
      name: 'Synthetic West Retail Branch ' + suffix,
      region: 'West',
      orgUnitId,
    };
    const orderIds = [
      'a.000',
      ...Array.from({ length: 98 }, (_, index) => 'A_' + String(index + 1).padStart(3, '0')),
      'a_099',
      'B.000',
      'B_001',
    ];
    const salesOrders: SalesOrder[] = orderIds.map((id, index) => ({
      id,
      branchId,
      date: BUSINESS_DATE,
      amountSatang: 100 + index,
      status: (index === 99 ? 'refunded' : index === 100 ? 'cancelled' : 'paid') as SalesOrder['status'],
      updatedAt: OBSERVED_AT,
    }));
    const salesTargets: SalesTarget[] = [
      { id: 'target-' + suffix, branchId, date: BUSINESS_DATE, amountSatang: 25_000, updatedAt: OBSERVED_AT },
      { id: 'target-outside-' + suffix, branchId: otherBranchId, date: BUSINESS_DATE, amountSatang: 9_000, updatedAt: OBSERVED_AT },
    ];
    const inventory: Inventory[] = [
      { id: 'inventory-current-' + suffix, branchId, productId, date: BUSINESS_DATE, onHand: 2, minimum: 10,
        observedAt: OBSERVED_AT, updatedAt: OBSERVED_AT },
      { id: 'inventory-old-' + suffix, branchId, productId, date: PRIOR_DATE, onHand: 20, minimum: 10,
        observedAt: OBSERVED_AT, updatedAt: OBSERVED_AT },
      { id: 'inventory-other-branch-' + suffix, branchId: otherBranchId, productId: otherProductId,
        date: BUSINESS_DATE, onHand: 1, minimum: 8, observedAt: OBSERVED_AT, updatedAt: OBSERVED_AT },
    ];
    const incident: Incident & {
      escalationStage: 'un_escalated';
      escalationLifecycleId: string;
      escalationEventId: null;
    } = {
      id: 'incident-current-' + suffix,
      branchId,
      date: BUSINESS_DATE,
      title: 'Synthetic open stock discrepancy',
      kind: 'stock',
      status: 'open',
      startedAt: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
      endedAt: null,
      updatedAt: OBSERVED_AT,
      escalationStage: 'un_escalated',
      escalationLifecycleId: 'incident-life-' + suffix,
      escalationEventId: null,
    };
    const incidents: Incident[] = [
      incident,
      {
        id: 'incident-old-' + suffix,
        branchId,
        date: PRIOR_DATE,
        title: 'Synthetic historical incident',
        kind: 'operations',
        status: 'open',
        startedAt: new Date(NOW.getTime() - 24 * 60 * 60_000).toISOString(),
        endedAt: null,
        updatedAt: OBSERVED_AT,
      },
      {
        id: 'incident-other-branch-' + suffix,
        branchId: otherBranchId,
        date: BUSINESS_DATE,
        title: 'Synthetic other-region incident',
        kind: 'payment',
        status: 'open',
        startedAt: OBSERVED_AT,
        endedAt: null,
        updatedAt: OBSERVED_AT,
      },
    ];
    const staffing: Staffing[] = [
      { id: 'staffing-current-' + suffix, branchId, date: BUSINESS_DATE, planned: 5, actual: 4,
        observedAt: OBSERVED_AT, updatedAt: OBSERVED_AT },
      { id: 'staffing-old-' + suffix, branchId, date: PRIOR_DATE, planned: 7, actual: 6,
        observedAt: OBSERVED_AT, updatedAt: OBSERVED_AT },
      { id: 'staffing-other-branch-' + suffix, branchId: otherBranchId, date: BUSINESS_DATE, planned: 10, actual: 9,
        observedAt: OBSERVED_AT, updatedAt: OBSERVED_AT },
    ];

    await store.transaction(async (tx) => {
      await tx.put('branches', branch);
      await tx.put('branches', otherBranch);
      await tx.put('products', { id: productId, name: 'Synthetic Retail Product A', category: 'grocery' });
      await tx.put('products', { id: otherProductId, name: 'Synthetic Retail Product B', category: 'grocery' });
      for (const row of salesOrders) await tx.put('sales_orders', row);
      await tx.put('sales_orders', {
        id: 'order-outside-branch-' + suffix, branchId: otherBranchId, date: BUSINESS_DATE,
        amountSatang: 50_000, status: 'paid', updatedAt: OBSERVED_AT,
      });
      await tx.put('sales_orders', {
        id: 'order-old-date-' + suffix, branchId, date: PRIOR_DATE,
        amountSatang: 40_000, status: 'paid', updatedAt: OBSERVED_AT,
      });
      for (const row of salesTargets) await tx.put('sales_targets', row);
      for (const row of inventory) await tx.put('inventory_snapshots', row);
      for (const row of incidents) await tx.put('incidents', row);
      for (const row of staffing) await tx.put('staffing_summaries', row);
    });

    const addPrincipal = async (options: PrincipalOptions = {}): Promise<PrincipalHandle> => {
      const principalSuffix = randomUUID().replaceAll('-', '');
      const profileId = 'retail-profile-' + principalSuffix;
      const sessionId = 'retail-session-' + principalSuffix;
      const identityId = 'retail-identity-' + principalSuffix;
      const responsibilityId = 'retail-responsibility-' + principalSuffix;
      const role = options.role ?? 'executive';
      const purpose = options.purpose ?? 'sales_operations';
      const permissions = options.permissions ?? ['sales.read', 'operations.read'];
      const regions = options.regions ?? ['East'];
      const profile: Profile = {
        id: profileId,
        name: 'Synthetic Retail Evidence Actor ' + principalSuffix,
        role,
        active: true,
        permissions,
        regions,
      };
      const actor: Actor = { ...profile, sessionId, mode: 'scripted_demo', modeRevision: 1 };

      await store.transaction(async (tx) => {
        await tx.put('profiles', profile);
        await tx.put('sessions', {
          id: sessionId,
          profileId,
          mode: 'scripted_demo',
          modeRevision: 1,
          csrfToken: 'csrf-' + principalSuffix,
          expiresAt: '2099-01-01T00:00:00.000Z',
        });
      });
      await store.workflowTransaction(async (tx) => {
        await tx.insertUnique('directory_identities', {
          id: identityId,
          profileId,
          displayName: 'Synthetic Retail Evidence Actor ' + principalSuffix,
          active: true,
          department: options.department ?? 'sales_operations',
          role,
          orgUnitId,
          managerIdentityId: null,
          verifiedDemoEmail: identityId + '@example.invalid',
          slackIdentity: null,
          allowedChannels: ['simulated_email'],
          classificationCeiling: 'internal',
          rowVersion: 1,
        }, { constraint: 'directory_identities_profile_unique', values: { profileId } });
        await tx.insertUnique('responsibilities', {
          id: responsibilityId,
          identityId,
          orgUnitId,
          purpose,
          branchIds: options.branchIds ?? [branchId],
          active: true,
          rowVersion: 1,
        }, { constraint: 'responsibilities_open_identity_purpose_unique', values: {
          identityId,
          purpose,
          orgUnitId,
        } });
      });
      return { actor, sessionId };
    };

    const actor = await addPrincipal();
    return {
      fixture,
      store,
      suffix,
      orgUnitId,
      branchId,
      otherBranchId,
      salesOrderIds: orderIds,
      productId,
      otherProductId,
      actor,
      addPrincipal,
      dispose: () => fixture.dispose(),
    };
  } catch (error) {
    await fixture.dispose();
    throw error;
  }
}

function assertWorkflowTransactionContext(tx: GuardedTransaction): asserts tx is WorkflowTransactionContext {
  if (!('workflowProjectionReader' in tx)) throw new Error('The private SQLite transaction has no workflow projection reader');
  const reader = tx.workflowProjectionReader;
  if (typeof reader !== 'object' || reader === null ||
    !('get' in reader) || typeof reader.get !== 'function' ||
    !('query' in reader) || typeof reader.query !== 'function') {
    throw new Error('The private SQLite workflow projection reader is malformed');
  }
}
async function readInSameTransaction(
  harness: RetailEvidenceHarness,
  principal: PrincipalHandle,
  scope: Scope,
  calls: WorkflowStorageQuery[],
  transform?: QueryTransform,
) {
  return harness.store.workflowTransaction(async (tx) => {
    assertWorkflowTransactionContext(tx);
    const currentPrincipal = await reloadWorkflowPrincipal(tx, principal.sessionId, NOW_ISO);
    const projections = trackedReader(tx.workflowProjectionReader, calls, transform);
    return readWorkflowEvidence({ projections, principal: currentPrincipal, now: NOW }, scope);
  });
}

async function withHarness(work: (harness: RetailEvidenceHarness) => Promise<void>): Promise<void> {
  const harness = await createHarness();
  try {
    await work(harness);
  } finally {
    await harness.dispose();
  }
}

function factQueries(calls: WorkflowStorageQuery[]): FactQuery[] {
  return calls.filter(isFactQuery);
}

describe('transaction-bound retail evidence', () => {
  it('matches the unchanged calculator for a controlled 102-row mixed-case and punctuated Supabase cursor order', async () => {
    await withHarness(async (harness) => {
      const scope: Scope = { region: 'East', date: BUSINESS_DATE, branchIds: [harness.branchId] };
      const expected = await readEvidence(harness.store, harness.actor.actor, scope, NOW);
      const calls: WorkflowStorageQuery[] = [];
      const ranks = new Map<string, number>();
      harness.salesOrderIds.forEach((id, index) => ranks.set(id, index));
      expect(harness.salesOrderIds).toHaveLength(102);
      expect(harness.salesOrderIds.slice(0, 2)).toEqual(['a.000', 'A_001']);
      expect(harness.salesOrderIds.slice(99)).toEqual(['a_099', 'B.000', 'B_001']);
      const controlledOrder: QueryTransform = (query, page, base) => {
        if (!isSalesOrderQuery(query)) return page;
        return queryInControlledDatabaseOrder(base, query, ranks);
      };
      const actual = await readInSameTransaction(harness, harness.actor, scope, calls, controlledOrder);

      expect(actual).toEqual(expected);
      expect(actual.branches[0]?.incidents).toContainEqual(expect.objectContaining({
        escalationStage: 'un_escalated',
        escalationLifecycleId: expect.stringMatching(/^incident-life-/),
      }));
      const scopedFacts = factQueries(calls);
      expect(new Set(scopedFacts.map((query) => query.table))).toEqual(new Set(FACT_TABLES));
      for (const query of scopedFacts) {
        expect(query.branchIds).toEqual([harness.branchId]);
        expect(query.fromDate).toBe(BUSINESS_DATE);
        expect(query.throughDate).toBe(BUSINESS_DATE);
      }

      const salesPages = scopedFacts.filter((query) => query.table === 'sales_orders');
      expect(salesPages.map(({ cursor, limit }) => ({ cursor, limit }))).toEqual([
        { cursor: undefined, limit: 100 },
        { cursor: 'a_099', limit: 100 },
        { cursor: 'B_001', limit: 1 },
      ]);
    });
  });

  it('rejects unauthorized branch, region, role, purpose, and empty scope before branch or fact scans', async () => {
    await withHarness(async (harness) => {
      const cases: Array<{
        label: string;
        options?: PrincipalOptions;
        scope: Scope;
      }> = [
        {
          label: 'branch',
          scope: { region: 'East', date: BUSINESS_DATE, branchIds: [harness.otherBranchId] },
        },
        {
          label: 'region',
          scope: { region: 'West', date: BUSINESS_DATE, branchIds: [harness.branchId] },
        },
        {
          label: 'role',
          options: { role: 'hr_admin', department: 'hr' },
          scope: { region: 'East', date: BUSINESS_DATE, branchIds: [harness.branchId] },
        },
        {
          label: 'purpose',
          options: { purpose: 'manager_onboarding' },
          scope: { region: 'East', date: BUSINESS_DATE, branchIds: [harness.branchId] },
        },
        {
          label: 'empty branch scope',
          scope: { region: 'East', date: BUSINESS_DATE, branchIds: [] },
        },
      ];

      for (const testCase of cases) {
        const principal = testCase.options ? await harness.addPrincipal(testCase.options) : harness.actor;
        const calls: WorkflowStorageQuery[] = [];
        await expect(readInSameTransaction(harness, principal, testCase.scope, calls), testCase.label).rejects.toThrow();
        expect(factQueries(calls), testCase.label).toHaveLength(0);
        expect(calls.filter((query) => query.kind === 'ids' && query.table === 'branches'), testCase.label).toHaveLength(0);
      }
    });
  });

  it.each([
    'wrong branch row',
    'wrong date row',
    'duplicate ID',
    'repeated cursor row',
    'non-advancing cursor',
    'malformed row',
    'missing page response',
    'short page with a remaining row',
    'oversized page',
  ] as const)('fails closed without returning partial evidence for %s', async (fault) => {
    await withHarness(async (harness) => {
      const calls: WorkflowStorageQuery[] = [];
      let injected = false;
      const transform: QueryTransform = async (query, page, base) => {
        if (query.kind !== 'scoped' || query.table !== 'sales_orders') return undefined;
        if (fault === 'repeated cursor row' && query.cursor !== undefined && !injected) {
          injected = true;
          const repeatedCursor = query.cursor;
          const previousPage = await base.query<unknown>({ ...query, cursor: undefined, limit: 100 });
          const repeated = previousPage.find((row) => row.id === repeatedCursor);
          if (!repeated) throw new Error('The synthetic page cursor is missing from its prior page');
          return [repeated];
        }
        if (fault === 'non-advancing cursor' && query.cursor !== undefined) {
          return base.query<unknown>({ ...query, cursor: undefined });
        }
        if (fault === 'missing page response' && query.cursor !== undefined) return null;
        if (fault === 'short page with a remaining row' && query.cursor === undefined && !injected) {
          injected = true;
          return page.slice(0, -1);
        }
        if (fault === 'oversized page' && query.cursor === undefined && !injected) {
          injected = true;
          const lastId = page.at(-1)?.id;
          if (!lastId) throw new Error('The synthetic first page was empty');
          const next = await base.query<unknown>({
            ...query,
            cursor: lastId,
            limit: 1,
          });
          return [...page, ...next];
        }
        if (fault === 'duplicate ID' && query.cursor === undefined && !injected) {
          injected = true;
          return page.map((row, index) => index === 1 ? page[0]! : row);
        }
        if (fault === 'malformed row' && query.cursor === undefined && !injected) {
          injected = true;
          return page.map((row, index) => index === 0
            ? { ...row, body: { ...(row.body as Record<string, unknown>), updatedAt: 'not-an-instant' } }
            : row);
        }
        if ((fault === 'wrong branch row' || fault === 'wrong date row') && query.cursor === undefined && !injected) {
          injected = true;
          const outside = await base.query<unknown>({
            kind: 'scoped',
            table: 'sales_orders',
            branchIds: [fault === 'wrong branch row' ? harness.otherBranchId : harness.branchId],
            fromDate: fault === 'wrong date row' ? PRIOR_DATE : BUSINESS_DATE,
            throughDate: fault === 'wrong date row' ? PRIOR_DATE : BUSINESS_DATE,
            limit: 1,
          });
          const outsideRow = outside[0]; if (!outsideRow) throw new Error('The synthetic out-of-scope order is missing');
          return [outsideRow, ...page.slice(1)];
        }
        return undefined;
      };
      const scope: Scope = { region: 'East', date: BUSINESS_DATE, branchIds: [harness.branchId] };

      await expect(readInSameTransaction(harness, harness.actor, scope, calls, transform))
        .rejects.toMatchObject({ code: 'WORKFLOW_EVIDENCE_INVALID' });
      expect(factQueries(calls).length).toBeGreaterThan(0);
    });
  });
});
