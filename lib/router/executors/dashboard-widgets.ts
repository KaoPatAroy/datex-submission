import 'server-only';

import type { Actor, Branch, DashboardSpec, VizWidget } from '../../contracts';
import { queryPlanSchema } from '../../dynamic/plan/schemas';
import { digest } from '../../dynamic/shared';
import { createSemanticCatalog } from '../../dynamic/catalog/semantic';
import type { VizWidgetResult } from '../../visualization/dashboard-data';
import { resolveVizWidget, type FamilyContext } from '../../visualization/dashboard-family';
import { artifactLabelsFromDataset, visualTraitsFromDataset } from './artifact';
import { TABLE_DATASET_IDS } from '../../dynamic/catalog/tables';
import { tableVizClaims } from '../../visualization/dashboard-table';
import { executeQueryStep, type QueryExecutorInput } from './query';
import { executeTableQueryStep } from './table-query';

type VizEntry = { index: number; widget: VizWidget };

export interface DashboardVizInput {
  store: QueryExecutorInput['store']; viewer: Actor; now: () => Date; businessDate: string; read: QueryExecutorInput['read'];
  diagnosticId: string; signal?: AbortSignal; spec: DashboardSpec;
  /** Approved-scope ceiling (the server-approved share scope, or a Dashboard's own header scope when validating an add/edit). Every widget read must stay inside it. */
  ceiling?: WidgetScopeCeiling;
}

/**
 * The scope a widget's evidence may cover: region ('all' = any), optional explicit branch ids, and the latest business date.
 * `sourceIds` (PC-01, an approved SHARE ceiling): the exact approved source set. When present, every evidence source and row
 * must cite only those sources and every date must equal the approved date (no earlier dates, no other source systems).
 */
export interface WidgetScopeCeiling { region: string; date: string; branchIds?: readonly string[]; sourceIds?: readonly string[] }
const CEILING_DENIED = 'Widget นี้ขอข้อมูลนอกขอบเขตที่ได้รับอนุมัติให้แชร์ Dashboard จึงไม่แสดง';
export const WIDGET_CEILING_TEXT = CEILING_DENIED;

/** The branches, regions and dates an accepted evidence bundle (branch or table dataset) actually covers. */
interface BundleCoverage { scope: { regions: readonly string[]; branchIds: readonly string[]; dates?: readonly string[] }; rows: readonly unknown[]; provenance?: { dates: readonly string[] }; sources?: readonly { id: string }[] }
/** True only when the bundle's declared population AND every evidence row sit inside the ceiling (branch, region, date). */
export function bundleWithinCeiling(bundle: BundleCoverage, ceiling: WidgetScopeCeiling): boolean {
  const ids = ceiling.branchIds ? new Set(ceiling.branchIds) : undefined;
  const region = ceiling.region.toLowerCase();
  const regionOk = (value: string) => region === 'all' || value.toLowerCase() === region;
  const rows = bundle.rows as readonly { branchId?: string; region?: string; date?: string; sourceRefs?: readonly string[] }[];
  const dates = [...(bundle.scope.dates ?? []), ...(bundle.provenance?.dates ?? []), ...rows.flatMap(row => row.date ? [row.date] : [])];
  const approved = ceiling.sourceIds ? new Set(ceiling.sourceIds) : undefined;
  const sourcesOk = !approved || ((bundle.sources ?? []).every(source => approved.has(source.id))
    && rows.every(row => (row.sourceRefs ?? []).every(ref => approved.has(ref))));
  return bundle.scope.branchIds.every(id => !ids || ids.has(id)) && bundle.scope.regions.every(regionOk)
    && rows.every(row => (row.branchId === undefined || !ids || ids.has(row.branchId)) && (row.region === undefined || regionOk(row.region)))
    && dates.every(date => approved ? date === ceiling.date : date <= ceiling.date) && sourcesOk;
}

/**
 * PC-01: the approved source set of a Dashboard share. Source ids are `system:branchId:date`; only the Dashboard's own header
 * sources on an APPROVED branch at the EXACT approved date qualify (the approval scope is bound by the approval hash, so a
 * later change to the Dashboard can only narrow this set, never widen it).
 */
export function approvedShareSourceIds(scope: { date: string; branchIds?: readonly string[] }, headerSourceIds: readonly string[]): string[] {
  const branches = new Set(scope.branchIds ?? []);
  return [...new Set(headerSourceIds)].filter(id => {
    const parts = id.split(':');
    return parts.length === 3 && parts[0].length > 0 && branches.has(parts[1]) && parts[2] === scope.date;
  }).sort();
}

const DENIED = 'ไม่มีสิทธิ์ดู Widget นี้ในขอบเขตข้อมูลของคุณ';
const UNAVAILABLE = 'ยังโหลด Widget นี้จากหลักฐานปัจจุบันไม่ได้';

/**
 * Re-queries every `viz` widget of a dashboard on open, under the VIEWER's fresh authority (never the owner's).
 * Widgets sharing one stored query reuse a single evidence read. The stored plan is the share ceiling: the viewer can only
 * see the widget's original scope, intersected with what their own authority allows (otherwise the widget is `denied`).
 * Legacy widgets are ignored; call this only for dashboards with `viz` widgets and pass the result as DashboardDetail `vizData`.
 */
export async function executeDashboardVizWidgets(input: DashboardVizInput): Promise<VizWidgetResult[]> {
  const entries: VizEntry[] = input.spec.widgets.flatMap((widget, index) => widget.type === 'viz' ? [{ index, widget }] : []);
  const groups = new Map<string, VizEntry[]>();
  for (const entry of entries) {
    const key = digest({ q: entry.widget.binding.queryDigest, m: entry.widget.binding.message, c: entry.widget.binding.catalogDigest });
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const results: VizWidgetResult[] = [];
  let groupIndex = 0;
  for (const group of groups.values()) {
    const { binding } = group[0].widget;
    const fail = (status: 'denied' | 'unavailable', text: string) => group.map(({ index }) => ({ index, status, text }) as VizWidgetResult);
    const plan = queryPlanSchema.safeParse(binding.query);
    if (!plan.success || digest(plan.data) !== binding.queryDigest) { results.push(...fail('unavailable', UNAVAILABLE)); continue; }
    const diagnosticId = `${input.diagnosticId}:viz${groupIndex++}`;
    const isTable = TABLE_DATASET_IDS.includes(binding.datasetId);
    const executorInput = { store: input.store, actor: input.viewer, message: binding.message, businessDate: input.businessDate,
      diagnosticId, now: input.now, read: input.read, signal: input.signal, step: { kind: 'query' as const, continuation: false, plan: plan.data } };
    // A table-dataset widget is re-read through the registered table path under the viewer's fresh authority, exactly like a branch widget.
    const result = isTable ? await executeTableQueryStep(executorInput) : await executeQueryStep({ ...executorInput, inheritedPlan: plan.data });
    if (result.outcome === 'accepted' && input.ceiling && !bundleWithinCeiling(result.bundle, input.ceiling)) {
      results.push(...group.map(({ index }) => ({ index, status: 'denied', text: CEILING_DENIED, code: 'scope_ceiling' }) as VizWidgetResult));
      continue;
    }
    if (result.outcome !== 'accepted') { results.push(...fail(result.outcome === 'denied' ? 'denied' : 'unavailable', result.outcome === 'denied' ? DENIED : UNAVAILABLE)); continue; }
    const dataset = createSemanticCatalog(await input.store.list<Branch>('branches')).datasets.find(d => d.id === binding.datasetId);
    if (!dataset) { results.push(...fail('unavailable', UNAVAILABLE)); continue; }
    const graph = 'table' in result ? tableVizClaims({ accepted: result.plan, bundle: result.bundle, claims: result.claims }) : result.claims;
    const evidenceRef = 'table' in result ? result.bundle.ref : result.bundle.ref;
    const family: FamilyContext = { query: plan.data, labels: artifactLabelsFromDataset(dataset), traits: visualTraitsFromDataset(dataset) };
    for (const { index, widget } of group) {
      const resolved = resolveVizWidget(widget, graph, dataset, evidenceRef, family);
      results.push(resolved.outcome === 'ready' ? { index, status: 'ready', data: resolved.data } : { index, status: 'unavailable', text: UNAVAILABLE });
    }
  }
  return results.sort((a, b) => a.index - b.index);
}
