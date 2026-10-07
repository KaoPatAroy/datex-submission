import type { Freshness } from '../../contracts';
import type { AcceptedPlan } from '../validate/query-plan';
import { acceptedContext } from '../validate/query-plan';
import type { Ref } from '../plan/schemas';
import { digest, freeze, unique } from '../shared';
import { sourceDisplayName } from '../../presentation/source-names';
import { displayBranchNames } from '../../presentation/branch-names';

export interface EvidenceRow {
  rowId: string; branchId: string; region: string; date: string;
  values: Readonly<Record<string, string | number | null>>; sourceRefs: readonly string[];
}
export interface BundleSource {
  id: string; system: string; observedAt: string; retrievedAt: string; freshness: Freshness;
}
export interface EvidenceBundle {
  version: 1; ref: Ref; query: Ref; dataset: Ref; authorityDigest: string;
  scope: { regions: readonly string[]; branchIds: readonly string[] };
  grain: readonly string[]; rows: readonly EvidenceRow[]; sources: readonly BundleSource[];
  provenance: { sourceNames: readonly string[]; dates: readonly string[]; readAt: string };
  coverage: { expected: number; read: number; complete: boolean; omittedReasons: readonly string[] };
  limitations: readonly string[]; interpretationLabels: readonly string[];
}
const bundles = new WeakMap<EvidenceBundle, AcceptedPlan>();

/** Internal execution boundary: only coverage-checked rows may become a claimable bundle. */
export function createEvidenceBundle(accepted: AcceptedPlan, rows: EvidenceRow[], sources: BundleSource[], readAt: string): EvidenceBundle {
  const context = acceptedContext(accepted);
  const branchName = (id: string) => {
    const branch = context.branches.find(candidate => candidate.id === id);
    const name = displayBranchNames(branch?.name ?? '');
    if (!name || name.toLocaleLowerCase().includes(id.toLocaleLowerCase())) {
      const region = context.dataset.fields.find(field => field.id === 'region')?.canonicalValues?.find(value => value.id === branch?.region);
      const label = region?.labels?.find(item => item !== branch?.region && /[^\x00-\x7f]/u.test(item)) ?? region?.label;
      return label ?? 'ที่เกี่ยวข้อง';
    }
    return name.replace(/^สาขา\s*/u, '');
  };
  const dates = [...new Set([...accepted.dates, ...accepted.baselineDates])];
  const expectedPairs = accepted.scope.branchIds.flatMap(branchId => dates.map(date => ({ branchId, date })));
  const availableBranchDates = context.available.branchDates ? new Set(context.available.branchDates.map(pair => `${pair.branchId}\u0000${pair.date}`)) : null;
  const pairAvailable = (branchId: string, date: string) => context.available.branchIds.includes(branchId) && context.available.dates.includes(date) &&
    (availableBranchDates === null || availableBranchDates.has(`${branchId}\u0000${date}`));
  const readablePairs = expectedPairs.filter(pair => pairAvailable(pair.branchId, pair.date));
  const readablePairKeys = new Set(readablePairs.map(pair => `${pair.branchId}\u0000${pair.date}`));
  const rowKeys = new Set(rows.map(row => `${row.branchId}\u0000${row.date}`));
  const rowsByKey = new Map<string, EvidenceRow>(), rowsBySource = new Map<string, EvidenceRow>();
  for (const row of rows) {
    rowsByKey.set(`${row.branchId}\u0000${row.date}`, row);
    for (const sourceRef of row.sourceRefs) rowsBySource.set(sourceRef, row);
  }
  if (rowKeys.size !== rows.length || rows.some(row => !readablePairKeys.has(`${row.branchId}\u0000${row.date}`) ||
    !context.branches.some(b => b.id === row.branchId && b.region === row.region) ||
    !dates.includes(row.date) || row.rowId !== `row:${row.branchId}:${row.date}` ||
    row.values.branch !== row.branchId || row.values.region !== row.region || row.values.date !== row.date)) throw new Error('Evidence population mismatch.');
  const sourceIds = new Set(sources.map(s => s.id));
  const expectedSources = unique(rows.flatMap(row => row.sourceRefs));
  if (sourceIds.size !== sources.length || sources.length !== expectedSources.length || expectedSources.some(id => !sourceIds.has(id)) ||
    rows.some(row => !row.sourceRefs.length || new Set(row.sourceRefs).size !== row.sourceRefs.length ||
      row.sourceRefs.some(id => !context.sourceSystems.some(system => id === `${system}:${row.branchId}:${row.date}`)))) throw new Error('Evidence source mismatch.');
  if (sources.some(source => {
    const row = rowsBySource.get(source.id)!;
    const observed = Date.parse(source.observedAt), cutoff = Date.parse(`${row.date}T23:59:59+07:00`);
    return source.id !== `${source.system}:${row.branchId}:${row.date}` || source.freshness !== 'fresh' ||
      !Number.isFinite(observed) || observed > cutoff || cutoff - observed > 86_400_000 ||
      !Number.isFinite(Date.parse(source.retrievedAt)) || Date.parse(source.retrievedAt) < observed;
  })) throw new Error('Evidence freshness mismatch.');
  const omittedPairs = expectedPairs.filter(pair => !rowKeys.has(`${pair.branchId}\u0000${pair.date}`));
  const omittedRows = omittedPairs
    .map(pair => `Missing evidence for branch ${pair.branchId} on ${pair.date}.`);
  const missingRowReasons = omittedPairs.map(pair => `ไม่พบหลักฐานของสาขา ${branchName(pair.branchId)} วันที่ ${pair.date}.`);
  const missingSourceReasons = expectedPairs.flatMap(pair => {
    const row = rowsByKey.get(`${pair.branchId}\u0000${pair.date}`);
    if (!row) return [];
    return context.sourceSystems.filter(system => !row.sourceRefs.includes(`${system}:${pair.branchId}:${pair.date}`))
      .map(system => `ไม่พบหลักฐานจากแหล่ง ${sourceDisplayName(system)} ของสาขา ${branchName(pair.branchId)} วันที่ ${pair.date}.`);
  });
  const omittedSources = expectedPairs.flatMap(pair => {
    const row = rowsByKey.get(`${pair.branchId}\u0000${pair.date}`);
    if (!row) return [];
    return context.sourceSystems.filter(system => !row.sourceRefs.includes(`${system}:${pair.branchId}:${pair.date}`))
      .map(system => `Missing evidence for ${system} at branch ${pair.branchId} on ${pair.date}.`);
  });
  const omittedReasons = [...omittedRows, ...omittedSources];
  const limitations = [
    ...accepted.interpretationLabels.filter(label => label.startsWith('จำกัดขอบเขตตามสิทธิ์ของคุณ:')),
    ...accepted.interpretationLabels.filter(label => label.startsWith('ข้อมูลที่มีครอบคลุม ')),
    ...missingSourceReasons,
    ...missingRowReasons,
  ];
  const expected = expectedPairs.length;
  const payload = {
    version: 1 as const, query: { id: accepted.plan.planId, version: 1, digest: accepted.planDigest },
    dataset: { id: context.dataset.id, version: 1, digest: digest(context.dataset) }, authorityDigest: accepted.authorityDigest,
    scope: accepted.scope, grain: context.dataset.grain, rows, sources,
    provenance: { sourceNames: context.sourceSystems, dates: [...new Set([...accepted.dates, ...accepted.baselineDates])].sort(), readAt },
    coverage: { expected, read: rows.length, complete: rows.length === expected && missingSourceReasons.length === 0, omittedReasons },
    limitations, interpretationLabels: accepted.interpretationLabels,
  };
  const fingerprint = digest(payload);
  const bundle = freeze({ ...payload, ref: { id: `evidence:${fingerprint}`, version: 1, digest: fingerprint } });
  bundles.set(bundle, accepted);
  return bundle;
}
export function bundlePlan(bundle: EvidenceBundle): AcceptedPlan {
  const plan = bundles.get(bundle);
  if (!plan) throw new Error('A verified execution bundle is required.');
  return plan;
}
