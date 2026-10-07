import { describe, expect, it } from 'vitest';
import { createSeedData } from '../lib/seed/generate';

describe('synthetic demo seed', () => {
  it('populates the final completed business day for every East branch with the intended sales-gap pattern', () => {
    const seed = createSeedData('2026-10-01', 1);
    const closedDate = '2026-10-01';

    for (const branchId of ['E01', 'E02', 'E03', 'E04']) {
      const orders = seed.sales_orders.filter((row) => row.branchId === branchId && row.date === closedDate && row.status === 'paid');
      const targets = seed.sales_targets.filter((row) => row.branchId === branchId && row.date === closedDate);
      const paidSalesSatang = orders.reduce((total, row) => total + row.amountSatang, 0);
      const targetSatang = targets.reduce((total, row) => total + row.amountSatang, 0);

      expect(orders.length, `${branchId} must have paid sales on the last completed day`).toBeGreaterThan(0);
      expect(targets.length, `${branchId} must have a target on the last completed day`).toBeGreaterThan(0);
      expect(targetSatang).toBeGreaterThan(0);
      if (branchId === 'E04') expect(paidSalesSatang).toBeGreaterThan(targetSatang);
      else expect(paidSalesSatang, `${branchId} is an under-target example`).toBeLessThan(targetSatang);
    }

    expect(seed.incidents.some((row) => row.branchId === 'E04' && row.date === closedDate && row.status === 'open'))
      .toBe(true);
  });

  it('includes the seeded HR badge and employee association used by the approval walkthrough', () => {
    const seed = createSeedData('2026-10-01', 1);
    const employee = seed.employees.find((row) => row.id === 'E024');
    const badge = seed.mock_badges.find((row) => row.id === 'C102');

    expect(employee).toMatchObject({ id: 'E024', branchId: 'E02', active: true });
    expect(badge).toMatchObject({ id: 'C102', employeeId: 'E024', state: 'active' });
  });
});
