import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store, Table } from '@/lib/contracts';
import { executeHrQueryStep, type HrExecutorInput } from '@/lib/router/executors/hr';
import { filter } from '../../dynamic/fixtures';
import { headcountPlan, hrPlan } from '../../dynamic/wave2/fixtures';
import { actors, base, seed, type Fixture } from './fixtures';

let fixture: Fixture;
beforeEach(async () => { fixture = await seed(); });
afterEach(async () => { await fixture.dispose(); });

type Call = { table: Table; filters?: Record<string, string | string[]>; options?: { limit?: number } };
function spy(store: Store, calls: Call[], rewrite?: (call: Call, rows: unknown[]) => unknown[]): Store {
  return new Proxy(store, { get(target, prop, receiver) {
    if (prop !== 'list') return Reflect.get(target, prop, receiver);
    return async (table: Table, filters?: Call['filters'], options?: Call['options']) => {
      const call = { table, filters, options };
      calls.push(call);
      const rows = await (target.list as (t: Table, f?: unknown, o?: unknown) => Promise<unknown[]>)(table, filters, options);
      return rewrite ? rewrite(call, rows) : rows;
    };
  } });
}
const run = (store: Store, message: string, plan = hrPlan(message), extra: Partial<HrExecutorInput> = {}) =>
  executeHrQueryStep({ ...base(fixture, actors.hr, message), store, step: { kind: 'hr_query', plan }, ...extra });

describe('HRSEARCH-001 bounded scan at the storage boundary', () => {
  it('pushes an employee id lookup into the store read as an id filter with a row bound', async () => {
    const calls: Call[] = [];
    const message = 'Find employee EMP-E1';
    const plan = filter(hrPlan(message), message, 'employee_id', 'EMP-E1', 'EMP-E1');
    const result = await run(spy(fixture.store, calls), message, plan);
    expect(result.outcome).toBe('accepted');
    const employeeReads = calls.filter(call => call.table === 'employees');
    expect(employeeReads.length).toBeGreaterThan(0);
    for (const call of employeeReads) {
      expect(call.filters?.id).toEqual(['EMP-E1']);
      expect(call.options?.limit).toBe(2001);
    }
  });

  it('bounds every employee scan with limit = maxRows + 1 even without an id filter', async () => {
    const calls: Call[] = [];
    const message = 'Headcount by East branch';
    const plan = filter(headcountPlan(message), message, 'region', 'east', 'East');
    const result = await run(spy(fixture.store, calls), message, plan);
    expect(result.outcome).toBe('accepted');
    const employeeReads = calls.filter(call => call.table === 'employees');
    expect(employeeReads.length).toBeGreaterThan(0);
    expect(employeeReads.every(call => call.options?.limit === 2001 && call.filters?.branchId !== undefined)).toBe(true);
  });

  it('reads badges only for the readable employees, never the whole badge table', async () => {
    const calls: Call[] = [];
    const message = 'Badge status of EMP-E1';
    const plan = filter(hrPlan(message), message, 'employee_id', 'EMP-E1', 'EMP-E1');
    plan.measures = [...plan.measures];
    plan.dimensions = [{ fieldId: 'badge_status', interpretation: { value: 'badge_status', source: 'default', sourceText: null, confidence: 1 } }];
    await run(spy(fixture.store, calls), message, plan);
    const badgeReads = calls.filter(call => call.table === 'mock_badges');
    for (const call of badgeReads) expect(call.filters?.employeeId).toEqual(['EMP-E1']);
  });

  it('the store itself honors the read bound (limit is applied by the storage query, not after loading)', async () => {
    const all = await fixture.store.list('employees');
    expect(all.length).toBeGreaterThan(2);
    expect(await fixture.store.list('employees', undefined, { limit: 2 })).toHaveLength(2);
    expect(await fixture.store.list('employees', { branchId: 'E01' }, { limit: 1 })).toHaveLength(1);
  });

  it('a store read that hits the bound is a clarification with authorized branch choices, not a partial answer', async () => {
    const calls: Call[] = [];
    // Simulate a store holding more rows than the bound for the first branch read.
    const store = spy(fixture.store, calls, (call, rows) => call.table === 'employees' && call.filters?.branchId !== undefined
      ? Array.from({ length: (call.options?.limit ?? 0) }, (_, index) => ({ id: `X${index}`, name: 'Bulk', branchId: call.filters!.branchId, active: true })) : rows);
    const message = 'Find employee';
    const result = await run(store, message, hrPlan(message));
    expect(result).toMatchObject({ outcome: 'clarify', kind: 'hr_query', code: 'hr_scan_bounded' });
    if (result.outcome === 'clarify') {
      expect(result.choices.length).toBeGreaterThan(0);
      expect(JSON.stringify(result)).not.toContain('Bulk');
    }
  });
});
