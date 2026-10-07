import type { Branch, Store } from '@/lib/contracts';
import type { QueryPlan } from '@/lib/dynamic/plan/schemas';
import { actors, BUSINESS_DATE, createWorkspaceFixture } from '../../helpers/workspace';
import { FIXED_NOW } from '../../helpers/workspace';

export { actors, BUSINESS_DATE, FIXED_NOW };
export type TableFixture = Awaited<ReturnType<typeof createWorkspaceFixture>>;

const STAMP = '2026-10-01T16:59:55.000Z';

/** The shared workspace fixture plus more rows for the registered table datasets (inventory, incidents, tickets). */
export async function seedTables(extra: { incidents?: number } = {}): Promise<TableFixture> {
  const fixture = await createWorkspaceFixture();
  await fixture.store.transaction(async tx => {
    await tx.put('branches', { id: 'E01', name: 'East One', region: 'east' } satisfies Branch);
    await tx.put('products', { id: 'P002', name: 'Synthetic Tea', category: 'beverage' });
    await tx.put('products', { id: 'P003', name: 'Synthetic Rice', category: 'pantry' });
    const inventory: [string, string, number, number][] = [
      ['E02', 'P002', 9, 5], ['E02', 'P003', 1, 4], ['C01', 'P001', 1, 5], ['C01', 'P002', 7, 5], ['E01', 'P001', 0, 3],
    ];
    for (const [branchId, productId, onHand, minimum] of inventory) {
      await tx.put('inventory_snapshots', { id: `INV-${branchId}-${productId}-${BUSINESS_DATE}`, branchId, productId, date: BUSINESS_DATE, onHand, minimum, observedAt: STAMP, updatedAt: STAMP });
    }
    for (let index = 0; index < (extra.incidents ?? 0); index += 1) {
      await tx.put('incidents', { id: `INC-X-${String(index).padStart(3, '0')}`, branchId: 'E02', date: BUSINESS_DATE, title: `Synthetic incident ${index}`,
        kind: index % 2 ? 'stock' : 'operations', status: index % 3 ? 'resolved' : 'open', startedAt: '2026-10-01T03:00:00.000Z',
        endedAt: index % 3 ? '2026-10-01T05:30:00.000Z' : null, updatedAt: STAMP });
    }
    await tx.put('incidents', { id: 'INC-C01-1', branchId: 'C01', date: BUSINESS_DATE, title: 'Central scanner', kind: 'operations', status: 'resolved',
      startedAt: '2026-10-01T02:00:00.000Z', endedAt: '2026-10-01T04:00:00.000Z', updatedAt: STAMP });
    for (const [id, branchId] of [['TCK-1', 'E02'], ['TCK-2', 'E02'], ['TCK-3', 'C01']] as const) {
      await tx.put('mock_tickets', { id, branchId, assigneeId: 'E024', title: 'Review demo', reason: 'r', unansweredQuestion: 'q', sourceIds: [], status: 'open',
        operationKey: `seed:${id}`, createdAt: '2026-10-01T10:00:00+07:00' });
    }
    // The east manager may also read operations in these tests (profile already holds operations.read).
  });
  return fixture;
}

const interpretation = (value: string, source: 'default' | 'explicit' = 'default', text?: string) =>
  ({ value, source, sourceText: source === 'explicit' && text ? { start: 0, end: text.length, text } : null, confidence: 1 });
export const tMeasure = (fieldId: string, aggregation: string, explicit?: string) => ({ fieldId, aggregation, interpretation: interpretation(fieldId, explicit ? 'explicit' : 'default', explicit) });
export const tDimension = (fieldId: string, explicit?: string) => ({ fieldId, interpretation: interpretation(fieldId, explicit ? 'explicit' : 'default', explicit) });
export const tFilter = (fieldId: string, value: string | string[], evidenceText: string, op: 'eq' | 'in' = Array.isArray(value) ? 'in' : 'eq') =>
  ({ fieldId, op, value, source: 'explicit' as const, evidenceText, sourceText: null, confidence: 1 });

export function tablePlan(datasetId: string, over: Partial<QueryPlan> = {}): QueryPlan {
  return {
    planVersion: 1, planId: 'plan:table', datasetId, measures: [], dimensions: [], filters: [], scope: null, time: null,
    grain: ['branch'], aggregation: 'registered', multiDateGrain: null, group: { fieldIds: [] }, compare: null, sort: [], topN: null,
    completeness: { expectation: 'requested_scope', requireFullPopulation: false, requiredSourceIds: [], minimumCoverage: 0 },
    clarificationNeeds: [], confidence: 1, requestedUses: ['answer'], ...over,
  } as QueryPlan;
}

export const tableBase = (fixture: TableFixture, actor = actors.executive, message = 'query', diagnosticId = 'turn:t1', store: Store = fixture.store) => ({
  store, actor, message, businessDate: BUSINESS_DATE, diagnosticId, now: () => FIXED_NOW,
  read: async () => { throw new Error('table datasets never use the branch evidence reader'); },
});

const live: TableFixture[] = [];
/** Registers a fixture for disposal by `tableFixtureCleanup` (afterEach). */
export async function tableFixtures(fixture: TableFixture): Promise<TableFixture> { live.push(fixture); return fixture; }
export async function tableFixtureCleanup(): Promise<void> { while (live.length) await live.pop()!.dispose(); }
