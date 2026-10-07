import type { Actor, Branch, Employee } from '@/lib/contracts';
import { actors, BUSINESS_DATE, createWorkspaceFixture, FIXED_NOW } from '../../helpers/workspace';
import { branches, fakeEvidence } from '../../dynamic/fixtures';

export { actors, BUSINESS_DATE, FIXED_NOW };
export type Fixture = Awaited<ReturnType<typeof createWorkspaceFixture>>;

export const PRIVATE = { salary: 987654, phone: '081-private-phone', nationalId: '1-2345-67890-12-3' };
export const employees: (Employee & Record<string, unknown>)[] = [
  { id: 'EMP-E1', name: 'Ada Lovelace', branchId: 'E01', active: true, ...PRIVATE },
  { id: 'EMP-E2', name: 'Bea Brown', branchId: 'E01', active: false, ...PRIVATE },
  { id: 'EMP-E3', name: 'Cara Chen', branchId: 'E02', active: true, ...PRIVATE },
  { id: 'EMP-D1', name: 'Dana Dup', branchId: 'E01', active: true, ...PRIVATE },
  { id: 'EMP-D2', name: 'Dana Dup', branchId: 'E02', active: true, ...PRIVATE },
  { id: 'EMP-S1', name: 'South Secret', branchId: 'S01', active: true, ...PRIVATE },
  { id: 'EMP-G1', name: 'Global Person', branchId: null, active: true, ...PRIVATE },
];

export async function seed(): Promise<Fixture> {
  const fixture = await createWorkspaceFixture();
  await fixture.store.transaction(async tx => {
    for (const branch of branches as Branch[]) await tx.put('branches', branch);
    for (const employee of employees) await tx.put('employees', employee);
    // East manager that may also read HR (region-bound), to prove scope is enforced for non-admins.
    const east = await tx.get<Record<string, unknown> & { id: string; permissions: string[] }>('profiles', 'east');
    await tx.put('profiles', { ...east!, id: 'east', permissions: [...east!.permissions, 'hr.read'] });
  });
  return fixture;
}

export const read = async (scope: Parameters<typeof fakeEvidence>[0]) => fakeEvidence(scope, branches as Branch[]);
export const base = (fixture: Fixture, actor: Actor, message: string, diagnosticId = 'turn:1') => ({
  store: fixture.store, actor, message, businessDate: BUSINESS_DATE, diagnosticId, now: () => FIXED_NOW,
});
