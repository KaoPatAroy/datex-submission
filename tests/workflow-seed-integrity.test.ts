import { beforeAll, describe, expect, it } from 'vitest';
import { createSeedData } from '@/lib/seed/generate';
import { persistWorkflowV2SeedPlan, prepareWorkflowV2SeedPlan, type WorkflowV2SeedPlan } from '@/lib/seed/workflow-v2';
import { createWorkflowSqliteFixture } from './helpers/workflow-storage';
import type { WorkflowTransactionContext, ProjectedRow } from '@/lib/storage/workflow-projections';
import type { WorkflowStorageTable } from '@/lib/workflows/contracts';

let plan: WorkflowV2SeedPlan;
beforeAll(() => { plan = prepareWorkflowV2SeedPlan(createSeedData('2026-10-01'), { seed: 1, businessDate: '2026-10-01' }); });

describe('higher native seed versions preserve canonical content', () => {
  it('accepts a legitimate evolved badge returned by insertUnique after a stale absence read', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const badge = plan.seedData.mock_badges.find(row => row.state === 'active')!;
      const employee = plan.seedData.employees.find(row => row.id === badge.employeeId)!;
      const evolved = { ...badge, state: 'revoked', version: badge.version + 1, operationKey: 'confirmed-badge-write', updatedAt: '2026-10-07T05:00:00.000Z' };
      await fixture.store.transaction(async tx => {
        if (employee.branchId) await tx.put('branches', plan.seedData.branches.find(branch => branch.id === employee.branchId)!);
        await tx.put('employees', employee); await tx.put('mock_badges', badge); await tx.put('mock_badges', evolved);
      });
      let masked = false;
      const racingStore = { ...fixture.store,
        workflowTransaction: <T>(work: (tx: WorkflowTransactionContext) => Promise<T>) => fixture.store.workflowTransaction((tx: WorkflowTransactionContext) => work({ ...tx,
          workflowProjectionReader: { ...tx.workflowProjectionReader,
            get: async <U>(table: WorkflowStorageTable, id: string): Promise<ProjectedRow<U> | undefined> => {
              if (!masked && table === 'mock_badges' && id === badge.id) { masked = true; return undefined; }
              return tx.workflowProjectionReader.get<U>(table, id);
            },
          },
        })),
      };
      expect(await persistWorkflowV2SeedPlan({ store: racingStore }, plan)).toMatchObject({ state: 'source_ready', bootstrapReady: true });
      expect(masked).toBe(true);
      expect(await fixture.store.workflowProjectionReader.get('mock_badges', badge.id)).toMatchObject({ rowVersion: 2, body: evolved });
    } finally { await fixture.dispose(); }
  });
  it.each(['inventory_snapshots', 'sales_targets', 'profiles'] as const)('rejects tampered measures or authority in %s', async table => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const row = plan.phases.flatMap(phase => phase.rows).find(row => row.table === table)!;
      const tampered = table === 'profiles' ? { ...row.body, role: 'hr_admin', permissions: ['badge.revoke'] }
        : table === 'inventory_snapshots' ? { ...row.body, onHand: Number(row.body.onHand) + 1 }
          : { ...row.body, amountSatang: Number(row.body.amountSatang) + 1 };
      await fixture.store.transaction(async tx => {
        if (table !== 'profiles') await tx.put('branches', plan.seedData.branches.find(branch => branch.id === row.body.branchId)!);
        if (table === 'inventory_snapshots') await tx.put('products', plan.seedData.products.find(product => product.id === row.body.productId)!);
        await tx.put(table, row.body); await tx.put(table, tampered);
      });
      const result = await persistWorkflowV2SeedPlan({ store: fixture.store }, plan);
      expect(result.bootstrapReady).toBe(false);
      expect(result.state).toBe('legacy_base_requires_seed_plan');
      expect(result.blockedTables).toContain(table);
    } finally { await fixture.dispose(); }
  });
});
