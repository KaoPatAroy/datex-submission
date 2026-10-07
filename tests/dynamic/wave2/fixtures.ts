import { proposal, branches } from '../fixtures';
import type { CatalogAuthority } from '../../../lib/dynamic/catalog/authority';
import { createWave2Catalog, validateHrQueryPlan, compileHrQuery, executeHrRead, type HrSnapshot, type HrEvidenceBundle } from '../../../lib/dynamic/catalog/hr';
import type { QueryPlan } from '../../../lib/dynamic/plan/schemas';

export const catalog = createWave2Catalog(branches);
export const now = '2026-10-06T05:00:00Z';
export const manager: CatalogAuthority = { id: 'east_manager', role: 'east_manager', active: true, revision: 1,
  permissions: ['hr.read'], regions: ['east'], branchIds: null, recipientIds: ['east_peer'] };
export const admin: CatalogAuthority = { ...manager, id: 'hr_admin', role: 'hr_admin', regions: ['*'] };
export const snapshot: HrSnapshot = {
  elapsedMs: 1,
  rows: [
    { id: 'EMP-E1', name: 'Ada', branchId: 'E01', active: true, salary: 999999, phone: 'private-phone' },
    { id: 'EMP-E2', name: 'Bea', branchId: 'E01', active: false },
    { id: 'EMP-E3', name: 'Cara', branchId: 'E02', active: true },
    { id: 'EMP-S1', name: 'South Secret', branchId: 'S01', active: true },
    { id: 'EMP-C1', name: 'Central Secret', branchId: 'C01', active: true },
    { id: 'EMP-G1', name: 'Global HR', branchId: null, active: true },
  ],
  populations: [
    { branchId: 'E01', employeeIds: ['EMP-E1', 'EMP-E2'], observedAt: now, retrievedAt: now },
    { branchId: 'E02', employeeIds: ['EMP-E3'], observedAt: now, retrievedAt: now },
    { branchId: 'S01', employeeIds: ['EMP-S1'], observedAt: now, retrievedAt: now },
    { branchId: 'C01', employeeIds: ['EMP-C1'], observedAt: now, retrievedAt: now },
    { branchId: null, employeeIds: ['EMP-G1'], observedAt: now, retrievedAt: now },
  ],
};
export function hrPlan(text = 'Find employee'): QueryPlan {
  const plan = proposal(text);
  return { ...plan, datasetId: 'hr_employees', grain: ['employee_id'], aggregation: 'rows', group: { fieldIds: [] },
    measures: [{ fieldId: 'headcount', aggregation: 'count', interpretation: { value: 'headcount', source: 'default', sourceText: null, confidence: 1 } }] };
}
export function headcountPlan(text = 'Headcount by East branch'): QueryPlan {
  const plan = hrPlan(text);
  return { ...plan, aggregation: 'registered', group: { fieldIds: ['branch'] },
    measures: [{ ...plan.measures[0], interpretation: { value: 'headcount', source: 'explicit',
      sourceText: { start: 0, end: 9, text: text.slice(0, 9) }, confidence: 1 } }] };
}
export function validate(plan = hrPlan(), sourceText = 'Find employee', actor = manager) {
  return validateHrQueryPlan({ proposal: plan, sourceText, actor, catalog });
}
export function execute(plan = hrPlan(), sourceText = 'Find employee', actor = manager, data = snapshot, currentCatalog = catalog) {
  const accepted = validate(plan, sourceText, actor);
  if (accepted.outcome !== 'accepted') return accepted;
  return executeHrRead({ request: compileHrQuery(accepted), snapshot: data, freshAuthority: actor, currentCatalog, now });
}
export function bundle(plan = hrPlan(), text = 'Find employee'): HrEvidenceBundle {
  const result = execute(plan, text);
  if (result.outcome !== 'accepted') throw new Error(`Fixture failed: ${result.code}`);
  return result.bundle;
}

export const businessFixtures = [
  { prompt: 'Headcount by East branch', kind: 'headcount', outcome: 'accepted' },
  { prompt: 'Who is on leave tomorrow?', kind: 'leave', outcome: 'unsupported_concept' },
  { prompt: 'Find employee EMP-E1', kind: 'id', outcome: 'accepted' },
  { prompt: 'Find employee Ada', kind: 'name', outcome: 'accepted' },
  { prompt: 'Headcount by South branch', kind: 'south', outcome: 'permission_denied' },
  { prompt: 'Are all required sources complete?', kind: 'sources_complete', outcome: 'accepted' },
  { prompt: 'Are all required sources complete?', kind: 'sources_partial', outcome: 'incomplete_evidence' },
] as const;
