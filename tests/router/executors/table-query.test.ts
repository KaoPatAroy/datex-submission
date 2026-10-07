import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/core/turn-completion-gate', () => ({ readCompletedTurn: async () => ({ kind: 'completed' }) }));

import type { Store, Table } from '@/lib/contracts';
import { executeTableQueryStep, TABLE_TOOL } from '@/lib/router/executors/table-query';
import { createSemanticCatalog } from '@/lib/dynamic/catalog/semantic';
import { decodeTableCursor, tableBindingDigest } from '@/lib/dynamic/table/engine';
import { actors, seedTables, tableBase, tableFixtureCleanup, tableFixtures, tDimension, tFilter, tMeasure, tablePlan, type TableFixture } from './table-fixtures';

afterEach(async () => { await tableFixtureCleanup(); });

const run = (fixture: TableFixture, message: string, plan = tablePlan('inventory_items'), actor = actors.executive, extra: Record<string, unknown> = {}) =>
  executeTableQueryStep({ ...tableBase(fixture, actor, message), step: { kind: 'query', continuation: false, plan }, ...extra } as Parameters<typeof executeTableQueryStep>[0]);

const lowStockByBranch = () => tablePlan('inventory_items', {
  measures: [tMeasure('low_stock_items', 'sum', 'low stock')], dimensions: [tDimension('branch', 'by branch')], group: { fieldIds: ['branch'] },
  sort: [{ fieldId: 'low_stock_items', direction: 'desc' }],
} as never);

describe('table dataset catalog registration', () => {
  it('registers every synthetic table dataset with grain, sources, permissions and joins in the SemanticDatasetCatalog', () => {
    const catalog = createSemanticCatalog([{ id: 'E01', name: 'East', region: 'east' }]);
    const ids = catalog.datasets.map(d => d.id);
    expect(ids).toEqual(['branch_performance', 'inventory_items', 'incident_log', 'support_tickets']);
    for (const dataset of catalog.datasets.slice(1)) {
      expect(dataset.readerId).toBe('table_rows');
      expect(dataset.requiredPermissions).toEqual(['operations.read']);
      expect(dataset.grain.length).toBeGreaterThan(0);
      expect(dataset.table?.sourceSystem).toBeTruthy();
      expect(dataset.table?.joins.every(join => ids.includes(join.to))).toBe(true);
      expect(dataset.fields.every(field => field.sourceSystems.length === 1 && field.requiredPermissions.length === 1)).toBe(true);
    }
  });
});

describe('table query executor', () => {
  it('answers a grouped stock query from registered evidence with sources, claims and a persisted state', async () => {
    const fixture = await tableFixtures(await seedTables());
    const result = await run(fixture, 'low stock by branch', lowStockByBranch());
    expect(result.outcome).toBe('accepted');
    if (result.outcome !== 'accepted') return;
    expect(result.text).toContain('ขอบเขตที่ตีความ');
    const byBranch = Object.fromEntries(result.claims.claims.map(c => [c.dimensions.branch, c.value]));
    expect(byBranch).toMatchObject({ E02: 2, C01: 1, E01: 1 }); // E02: P001(2<5) + P003(1<4); C01: P001; E01: P001
    expect(result.sources.every(s => s.system === 'inventory')).toBe(true);
    expect(result.bundle.sourceCompleteness.sources.every(s => s.freshness === 'fresh')).toBe(true);
    expect(result.claims.claims.every(claim => claim.sourceRefs.length > 0)).toBe(true);
    await fixture.store.transaction(tx => result.persist(tx, actors.executive, 'conv-t'));
    const saved = await fixture.store.get<{ name: string; state: { revision: number; datasetId: string } }>('tool_executions', 'dynamic-table:turn:t1');
    expect(saved?.name).toBe(TABLE_TOOL);
    expect(saved?.state).toMatchObject({ revision: 1, datasetId: 'inventory_items' });
  });

  it('pushes branch/date filters and a row bound into every store read (bounded scan at the storage boundary)', async () => {
    const fixture = await tableFixtures(await seedTables());
    const reads: { table: Table; filters?: Record<string, unknown>; options?: { limit?: number } }[] = [];
    const store = new Proxy(fixture.store, { get(target, prop, receiver) {
      if (prop !== 'list') return Reflect.get(target, prop, receiver);
      return (table: Table, filters?: Record<string, unknown>, options?: { limit?: number }) => { reads.push({ table, filters, options }); return (target.list as (...a: unknown[]) => Promise<unknown>)(table, filters, options); };
    } }) as Store;
    const result = await executeTableQueryStep({ ...tableBase(fixture, actors.executive, 'low stock by branch', 'turn:t2', store),
      step: { kind: 'query', continuation: false, plan: lowStockByBranch() } } as never);
    expect(result.outcome).toBe('accepted');
    const inventoryReads = reads.filter(r => r.table === 'inventory_snapshots' && r.filters?.date);
    expect(inventoryReads).toHaveLength(1);
    // The availability probe is bounded too.
    expect(reads.filter(r => r.table === 'inventory_snapshots' && !r.filters?.date).every(r => r.options?.limit === 50_000 && !!r.filters?.branchId)).toBe(true);
    expect(inventoryReads[0].filters).toMatchObject({ branchId: ['C01', 'E01', 'E02'], date: ['2026-10-01'] });
    expect(inventoryReads[0].options?.limit).toBe(20_001);
  });

  it('refuses (budget) when the bounded store read fills its bound instead of answering from a partial population', async () => {
    const fixture = await tableFixtures(await seedTables());
    const store = new Proxy(fixture.store, { get(target, prop, receiver) {
      if (prop !== 'list') return Reflect.get(target, prop, receiver);
      return async (table: Table, filters?: unknown, options?: { limit?: number }) => table === 'inventory_snapshots' && options?.limit
        ? Array.from({ length: options?.limit ?? 3 }, (_, i) => ({ id: `X${i}`, branchId: 'E02', productId: 'P001', date: '2026-10-01', onHand: 1, minimum: 2, observedAt: '2026-10-01T16:59:55.000Z' }))
        : (target.list as (...a: unknown[]) => Promise<unknown>)(table, filters, options);
    } }) as Store;
    const result = await executeTableQueryStep({ ...tableBase(fixture, actors.executive, 'low stock by branch', 'turn:t3', store),
      step: { kind: 'query', continuation: false, plan: lowStockByBranch() } } as never);
    expect(result.outcome).toBe('clarify');
    if (result.outcome === 'clarify') expect(result.code).toBe('query_budget');
  });

  it('keeps the east manager inside the authorized region and denies an explicit out-of-scope branch', async () => {
    const fixture = await tableFixtures(await seedTables());
    const own = await run(fixture, 'low stock by branch', lowStockByBranch(), actors.east);
    expect(own.outcome).toBe('accepted');
    if (own.outcome === 'accepted') {
      expect(own.claims.claims.map(c => c.dimensions.branch).sort()).toEqual(['E01', 'E02']);
      expect(JSON.stringify(own.claims)).not.toContain('C01');
    }
    const message = 'low stock by branch at C01';
    const plan = { ...lowStockByBranch(), filters: [tFilter('branch', 'C01', 'C01')] };
    const denied = await run(fixture, message, plan, actors.east);
    expect(denied.outcome).toBe('denied');
    expect(JSON.stringify(denied)).not.toContain('Central Confidential');
  });

  it('denies a role without operations.read', async () => {
    const fixture = await tableFixtures(await seedTables());
    const result = await run(fixture, 'low stock by branch', lowStockByBranch(), actors.hr);
    expect(result).toMatchObject({ outcome: 'denied', code: 'dataset_permission' });
  });

  it('answers an incident listing with a bounded page and an opaque cursor that returns the next page', async () => {
    const fixture = await tableFixtures(await seedTables({ incidents: 25 }));
    const message = 'list incidents of east';
    const listing = (page?: { limit: number; cursor: string | null }) => tablePlan('incident_log', {
      measures: [tMeasure('incident_records', 'count')], dimensions: [tDimension('branch'), tDimension('kind'), tDimension('status')],
      filters: [tFilter('region', 'east', 'east')], aggregation: 'rows', sort: [{ fieldId: 'branch', direction: 'asc' }],
      ...(page ? { page } : {}),
    } as never);
    const first = await run(fixture, message, listing({ limit: 10, cursor: null }));
    expect(first.outcome).toBe('accepted');
    if (first.outcome !== 'accepted') return;
    expect(first.bundle.rows).toHaveLength(10);
    expect(first.bundle.page).toMatchObject({ offset: 0, limit: 10, total: 26 });
    const cursor = first.bundle.page.nextCursor;
    expect(cursor).toBeTruthy();
    expect(cursor).not.toMatch(/\d{2}/); // opaque: the offset is not a readable number
    expect(first.text).toContain('จากทั้งหมด');

    const second = await run(fixture, message, listing({ limit: 10, cursor }));
    expect(second.outcome).toBe('accepted');
    if (second.outcome !== 'accepted') return;
    expect(second.bundle.page).toMatchObject({ offset: 10, total: 26 });
    const ids = new Set([...first.bundle.rows, ...second.bundle.rows].map(r => r.rowId));
    expect(ids.size).toBe(20);
    expect(first.bundle.page.total).toBe(26); // 25 seeded + the shared fixture's open E02 incident

    const last = await run(fixture, message, listing({ limit: 10, cursor: second.bundle.page.nextCursor }));
    expect(last.outcome === 'accepted' && last.bundle.rows.length).toBe(6);
    if (last.outcome === 'accepted') expect(last.bundle.page.nextCursor).toBeNull();
  });

  // G3-2 (v5 D5): "how many open incidents" answered "จำนวน Incident 1 รายการ" (one per-record count, deduplicated) next to
  // "showing 1–2 of 2". The headline count is the evidence total.
  it('G3-2: a record listing with a count leads with the evidence total over every page, never a per-record 1', async () => {
    const fixture = await tableFixtures(await seedTables({ incidents: 25 }));
    const listing = tablePlan('incident_log', {
      measures: [tMeasure('incident_records', 'count')], dimensions: [tDimension('branch'), tDimension('kind')],
      filters: [tFilter('region', 'east', 'east')], aggregation: 'rows', page: { limit: 10, cursor: null },
    } as never);
    const result = await run(fixture, 'list incidents of east', listing);
    expect(result.outcome).toBe('accepted');
    if (result.outcome !== 'accepted') return;
    expect(result.claims.claims[0]).toMatchObject({ fieldId: 'incident_records', value: 26, dimensions: {} });
    expect(result.claims.claims[0]!.sourceRefs.length).toBeGreaterThan(0);
    expect(result.text).toContain('รวมจำนวน Incident 26 รายการ.');
    expect(result.text).not.toContain('จำนวน Incident 1 รายการ');
    expect(result.text).toContain('จากทั้งหมด 26 รายการ');
    expect(result.analysis.facts[0]?.text).toBe('รวมจำนวน Incident 26 รายการ.');
  });

  it('G3-2: a count planned as a record listing with nothing to list by is one ungrouped total (no "1–1 of 1" line)', async () => {
    const fixture = await tableFixtures(await seedTables({ incidents: 25 }));
    // The v5 model shape: aggregation "rows", count measure, no dimensions.
    const count = tablePlan('incident_log', { measures: [tMeasure('incident_records', 'count')], filters: [tFilter('region', 'east', 'east')], aggregation: 'rows' } as never);
    const result = await run(fixture, 'how many incidents in east', count);
    expect(result.outcome).toBe('accepted');
    if (result.outcome !== 'accepted') return;
    expect(result.plan.mode).toBe('groups');
    expect(result.claims.claims.map(claim => claim.value)).toEqual([26]);
    expect(result.text).toContain('รวมจำนวน Incident 26 รายการ.');
    expect(result.text).not.toContain('แสดงรายการที่');
  });

  it('rejects a tampered or foreign cursor and a cursor from a different plan shape', async () => {
    const fixture = await tableFixtures(await seedTables({ incidents: 25 }));
    const message = 'list incidents';
    const make = (cursor: string | null, kinds = ['branch']) => tablePlan('incident_log', {
      measures: [tMeasure('incident_records', 'count')], dimensions: kinds.map(k => tDimension(k)), aggregation: 'rows', page: { limit: 10, cursor },
    } as never);
    const first = await run(fixture, message, make(null));
    if (first.outcome !== 'accepted') throw new Error('expected accepted');
    const cursor = first.bundle.page.nextCursor!;
    expect(decodeTableCursor('not-the-binding', cursor)).toBeNull();
    for (const bad of [`${cursor}x`, Buffer.from(JSON.stringify({ v: 1, o: 99, k: 'forged' })).toString('base64url'), 'garbage']) {
      const result = await run(fixture, message, make(bad));
      expect(result).toMatchObject({ outcome: 'clarify', code: 'cursor_invalid' });
    }
    const otherShape = await run(fixture, message, make(cursor, ['branch', 'kind']));
    expect(otherShape).toMatchObject({ outcome: 'clarify', code: 'cursor_invalid' });
    expect(tableBindingDigest(make(null), 'a', 'b')).not.toBe(tableBindingDigest(make(null, ['kind']), 'a', 'b'));
  });

  it('joins two registered datasets on the declared keys and returns both measures per group', async () => {
    const fixture = await tableFixtures(await seedTables({ incidents: 4 }));
    const plan = tablePlan('inventory_items', {
      measures: [tMeasure('stock_shortfall', 'sum', 'shortfall'), tMeasure('incident_log.incident_records', 'count', 'incidents')],
      dimensions: [tDimension('branch', 'branch')], group: { fieldIds: ['branch'] }, joins: [{ datasetId: 'incident_log' }],
    } as never);
    const result = await run(fixture, 'shortfall and incidents by branch', plan);
    expect(result.outcome).toBe('accepted');
    if (result.outcome !== 'accepted') return;
    const rows = Object.fromEntries(result.bundle.rows.map(r => [r.values.branch, r.values]));
    expect(rows.E02).toMatchObject({ stock_shortfall: 6, 'incident_log.incident_records': 5 }); // P001 3 + P003 3; four seeded + the shared fixture's incident
    expect(rows.C01).toMatchObject({ stock_shortfall: 4, 'incident_log.incident_records': 1 });
    expect(rows.E01).toMatchObject({ stock_shortfall: 3, 'incident_log.incident_records': 0 });
    expect(result.bundle.joins).toEqual([{ datasetId: 'incident_log', keys: ['branch', 'date'] }]);
    expect(result.bundle.sources.map(s => s.system)).toEqual(expect.arrayContaining(['inventory', 'incidents']));
  });

  it('refuses joins that are not registered, plans that author keys elsewhere, and groups outside the declared keys', async () => {
    const fixture = await tableFixtures(await seedTables());
    const base = (over: Record<string, unknown>) => tablePlan('inventory_items', {
      measures: [tMeasure('stock_shortfall', 'sum'), tMeasure('incident_log.incident_records', 'count')], dimensions: [tDimension('branch')],
      group: { fieldIds: ['branch'] }, joins: [{ datasetId: 'incident_log' }], ...over } as never);
    expect(await run(fixture, 'q', base({ joins: [{ datasetId: 'branch_performance' }] }))).toMatchObject({ outcome: 'denied', code: 'unregistered_join' });
    expect(await run(fixture, 'q', base({ joins: undefined }))).toMatchObject({ outcome: 'denied', code: 'unknown_field' });
    const byProduct = base({ dimensions: [tDimension('product')], group: { fieldIds: ['product'] } });
    expect(await run(fixture, 'q', byProduct)).toMatchObject({ outcome: 'denied', code: 'join_group_not_on_keys' });
  });

  it('rejects multi-date snapshot sums with a server-owned date choice and unknown enum values with the registered values', async () => {
    const fixture = await tableFixtures(await seedTables());
    const multi = { ...lowStockByBranch(), time: { fieldId: 'date', timezone: 'Asia/Bangkok', source: 'explicit', dates: ['2026-09-30', '2026-10-01'], evidenceText: 'two days' } } as never;
    const dateResult = await run(fixture, 'low stock over two days', multi);
    expect(dateResult.outcome).toBe('clarify');
    const bogus = tablePlan('incident_log', { measures: [tMeasure('incident_records', 'count')], filters: [tFilter('kind', 'bogus', 'bogus')] } as never);
    const clarified = await run(fixture, 'incident of kind bogus', bogus);
    expect(clarified).toMatchObject({ outcome: 'clarify', code: 'unknown_value' });
    if (clarified.outcome === 'clarify') expect(clarified.choices.map(c => c.id)).toEqual(['payment', 'stock', 'operations']);
  });

  it('counts tickets per branch with true zeros for branches without tickets', async () => {
    const fixture = await tableFixtures(await seedTables());
    const plan = tablePlan('support_tickets', { measures: [tMeasure('ticket_records', 'count', 'tickets')], dimensions: [tDimension('branch', 'branch')],
      group: { fieldIds: ['branch'] }, sort: [{ fieldId: 'ticket_records', direction: 'desc' }] } as never);
    const result = await run(fixture, 'tickets per branch', plan);
    expect(result.outcome).toBe('accepted');
    if (result.outcome !== 'accepted') return;
    expect(Object.fromEntries(result.claims.claims.map(c => [c.dimensions.branch, c.value]))).toEqual({ E02: 2, C01: 1, E01: 0 });
  });

  it('L3: a branch with NO inventory snapshot is missing evidence, never a numeric zero claim without sources', async () => {
    const fixture = await tableFixtures(await seedTables());
    await fixture.store.transaction(async tx => { for (const row of await tx.list<{ id: string; branchId: string }>('inventory_snapshots')) if (row.branchId === 'E01') await tx.remove('inventory_snapshots', row.id); });
    const result = await run(fixture, 'low stock by branch', lowStockByBranch());
    expect(result.outcome).toBe('accepted');
    if (result.outcome !== 'accepted') return;
    expect(result.claims.claims.map(c => c.dimensions.branch)).not.toContain('E01');
    expect(result.claims.claims.every(claim => claim.sourceRefs.length > 0)).toBe(true);
    expect(result.bundle.coverage.omittedReasons.join(' ')).toContain('E01');
    // A branch whose snapshot exists but whose rows are filtered out stays a sourced zero.
    const filtered = tablePlan('inventory_items', { measures: [tMeasure('low_stock_items', 'sum', 'low')], dimensions: [tDimension('branch', 'by branch')], group: { fieldIds: ['branch'] },
      filters: [tFilter('product', 'P003', 'rice')] } as never);
    const f = await run(fixture, 'rice low stock by branch', filtered);
    if (f.outcome === 'accepted') for (const claim of f.claims.claims) expect(claim.sourceRefs.length).toBeGreaterThan(0);
  });

  it('S4: an ungrouped count over a successfully read scope that matches nothing is a sourced zero, not "no data"', async () => {
    const fixture = await tableFixtures(await seedTables());
    const plan = tablePlan('support_tickets', { measures: [tMeasure('ticket_records', 'count', 'tickets')], filters: [tFilter('branch', 'E01', 'East One')] } as never);
    const result = await run(fixture, 'how many tickets at East One', plan);
    expect(result.outcome).toBe('accepted');
    if (result.outcome !== 'accepted') return;
    expect(result.claims.claims).toHaveLength(1);
    expect(result.claims.claims[0]).toMatchObject({ value: 0 });
    expect(result.claims.claims[0]!.sourceRefs.length).toBeGreaterThan(0);
  });

  it('a stale authority or catalog at persistence time refuses to save the answer', async () => {
    const fixture = await tableFixtures(await seedTables());
    const result = await run(fixture, 'low stock by branch', lowStockByBranch());
    if (result.outcome !== 'accepted') throw new Error('expected accepted');
    await expect(fixture.store.transaction(tx => result.persist(tx, { ...actors.executive, permissions: ['sales.read'] }, 'conv-x'))).rejects.toThrow();
    await expect(fixture.store.transaction(async tx => { await tx.put('branches', { id: 'N01', name: 'New', region: 'east' }); await result.persist(tx, actors.executive, 'conv-x'); })).rejects.toThrow();
  });
});
