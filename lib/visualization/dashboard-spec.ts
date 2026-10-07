import type { Actor, DashboardSpec, VizWidget } from '../contracts';
import type { SemanticDatasetCatalog } from '../dynamic/catalog/semantic';
import { bundlePlan, type EvidenceBundle } from '../dynamic/evidence/bundle';
import { isBoundClaimGraph, type ClaimGraph } from '../dynamic/evidence/claim-graph';
import { authority } from '../dynamic/runtime';
import { digest } from '../dynamic/shared';
import { acceptedContext, revalidate, type AcceptedPlan } from '../dynamic/validate/query-plan';
import { dashboardVisualizationPlanSchema, type DashboardVisualizationPlan, type VizWidgetData } from './dashboard-data';
import { bindWidgetPlan } from './dashboard-bind';
import { resolveVizWidget, type FamilyContext } from './dashboard-family';
import { artifactLabelsFromDataset, visualTraitsFromDataset } from '../router/executors/artifact';
import { modelTextSafe } from '../router/render/safety';

/** Accepted, evidence-bound query result (the `query` executor output plus the user message that carried its source spans). */
export interface DashboardEvidence { plan: AcceptedPlan; bundle: EvidenceBundle; claims: ClaimGraph; message: string }
export interface DashboardPlanOptions {
  /** dashboard.refine: keep these widgets and append the plan's widgets (total <= 12). Scope/title come from the base unless the plan replaces them. */
  base?: DashboardSpec;
  /** Output-safety gate for AI-authored text (titles/description). */
  isSafeText?: (text: string) => boolean;
}
export type DashboardFromPlanResult =
  | { outcome: 'accepted'; spec: DashboardSpec; widgets: VizWidgetData[]; evidence: { id: string; version: number; digest: string };
    /** Titles of planned widgets that cannot be drawn from this evidence (left out, never faked); the answer names them. */
    omitted: string[] }
  | { outcome: 'rejected'; code: string; widgetIndex: number | null; text: string };

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const TEXT: Record<string, string> = {
  invalid_plan: 'แผน Dashboard ไม่ถูกต้อง จึงยังไม่ได้เตรียม Dashboard',
  unsafe_text: 'ชื่อหรือคำอธิบาย Dashboard ไม่ผ่านการตรวจความปลอดภัยของข้อความ',
  evidence_unbound: 'หลักฐานที่ใช้สร้าง Dashboard ไม่ได้มาจากการค้นข้อมูลที่ผ่านการตรวจ',
  permission_denied: 'สิทธิ์ปัจจุบันไม่พอสำหรับสร้าง Dashboard จากหลักฐานนี้',
  catalog_changed: 'แคตตาล็อกข้อมูลเปลี่ยนไปแล้ว โปรดค้นข้อมูลใหม่ก่อนสร้าง Dashboard',
  untrusted_field: 'ตัวชี้วัดหรือมิตินี้ยังไม่ได้รับรองสำหรับใช้ใน Dashboard',
  unknown_measure: 'ตัวชี้วัดที่ขอไม่อยู่ในหลักฐานของคำถามนี้',
  unknown_dimension: 'มิติที่ขอไม่อยู่ในหลักฐานของคำถามนี้',
  too_many_widgets: 'Dashboard มี Widget ได้ไม่เกิน 12 รายการ',
  topn_budget: 'จำนวนอันดับที่ขอเกินขีดจำกัดของชุดข้อมูล',
  message_too_long: 'ข้อความต้นทางยาวเกินกว่าจะผูกเป็นหลักฐานของ Dashboard ได้',
  widget_unavailable: 'Widget นี้สร้างจากหลักฐานที่มีอยู่ไม่ได้',
};
/**
 * G6: Dashboard title, description and widget titles are MODEL text. Each passes the shared model-text gate; a blocked one is replaced by server
 * copy (never a rejection): the Dashboard title by the base Dashboard's title (refine) or "Dashboard <dataset label>", the description by '',
 * a widget title by the server label of its measure. Shared by both builders (dashboard-table.ts).
 */
export function gateVisualizationText(plan: DashboardVisualizationPlan, server: { title: string; fieldLabels: Readonly<Record<string, string>> }): DashboardVisualizationPlan {
  const fit = (text: string, max: number) => [...text].slice(0, max).join('');
  return {
    ...plan,
    title: modelTextSafe('dashboard_title', plan.title) ? plan.title : fit(server.title, 120),
    description: !plan.description || modelTextSafe('visualization_text', plan.description) ? plan.description : '',
    widgets: plan.widgets.map(widget => modelTextSafe('visualization_text', widget.title) ? widget
      : { ...widget, title: fit(server.fieldLabels[widget.measure] ?? server.title, 100) }),
  };
}

// Internal reason codes are never shown to the user (they stay in `code`).
const reject = (code: string, widgetIndex: number | null = null): DashboardFromPlanResult =>
  ({ outcome: 'rejected', code, widgetIndex, text: TEXT[code] ?? TEXT.invalid_plan });
/** Widget-level evidence fit problems: the widget is left out when other widgets bind. Authority/trust failures reject all. */
const OMITTABLE = new Set(['unknown_measure', 'unknown_dimension', 'widget_unavailable', 'topn_budget']);

/**
 * Validates an AI VisualizationPlan against the server catalog + actor scope and binds every widget to the accepted
 * evidence (EvidenceBundle digest). The result is a plain DashboardSpec whose `viz` widgets carry their query binding so
 * they can be re-queried on open under the viewer's authority (see executeDashboardVizWidgets).
 * Dashboard titles/descriptions/widget titles are generated text: only length/charset/output-safety is checked.
 */
export function buildDashboardSpecFromPlan(
  planInput: unknown, evidence: DashboardEvidence, catalog: SemanticDatasetCatalog, actor: Actor, options: DashboardPlanOptions = {},
): DashboardFromPlanResult {
  const parsed = dashboardVisualizationPlanSchema.safeParse(planInput);
  if (!parsed.success) return reject('invalid_plan');
  const modelPlan = parsed.data;
  const texts = [modelPlan.title, modelPlan.description, ...modelPlan.widgets.map(w => w.title)];
  if (texts.some(t => CONTROL_CHARS.test(t) || options.isSafeText?.(t) === false)) return reject('unsafe_text');
  const base = options.base?.widgets ?? [];
  if (base.length + modelPlan.widgets.length > 12) return reject('too_many_widgets');
  if (!evidence.message.length || evidence.message.length > 2000) return reject('message_too_long');

  let accepted: AcceptedPlan;
  try {
    accepted = bundlePlan(evidence.bundle);
    if (accepted !== evidence.plan || !isBoundClaimGraph(evidence.claims, evidence.bundle)) return reject('evidence_unbound');
  } catch { return reject('evidence_unbound'); }
  const fresh = revalidate(accepted, authority(actor));
  if (fresh.outcome !== 'accepted') return reject('permission_denied');
  if (catalog.digest !== accepted.catalogDigest) return reject('catalog_changed');
  if (!actor.permissions.includes('dashboard.create')) return reject('permission_denied');
  const { dataset } = acceptedContext(accepted);
  if (!['internal', 'public_business'].includes(dataset.sensitivity) || dataset.trust !== 'certified') return reject('untrusted_field');

  const queryPlan = accepted.plan;
  const evidenceRef = evidence.bundle.ref;
  const widgets: VizWidget[] = [];
  const data: VizWidgetData[] = [];
  const omitted: { title: string; failure: DashboardFromPlanResult }[] = [];
  const labels = artifactLabelsFromDataset(dataset), traits = visualTraitsFromDataset(dataset);
  const plan = gateVisualizationText(modelPlan, { title: options.base?.title ?? `Dashboard ${dataset.label ?? dataset.id}`, fieldLabels: labels.fields });
  const family: FamilyContext = { query: queryPlan, labels, traits };
  for (const [index, widget] of plan.widgets.entries()) {
    const skip = (code: string) => { omitted.push({ title: widget.title, failure: reject(code, index) }); };
    const binding = { datasetId: queryPlan.datasetId, evidenceDigest: evidenceRef.digest, claimGraphDigest: evidence.claims.digest,
      catalogDigest: accepted.catalogDigest, queryDigest: digest(queryPlan), message: evidence.message,
      query: JSON.parse(JSON.stringify(queryPlan)) as Record<string, unknown> };
    const bound = bindWidgetPlan(widget, { dataset, query: queryPlan, actor, binding });
    if (!bound.ok) { if (bound.mode === 'reject') return reject(bound.code, index); skip(bound.code); continue; }
    const resolved = resolveVizWidget(bound.widget, evidence.claims, dataset, evidenceRef, family);
    if (resolved.outcome !== 'ready') { skip('widget_unavailable'); continue; }
    widgets.push(bound.widget);
    data.push(resolved.data);
  }
  if (!widgets.length) return omitted[0]?.failure.outcome === 'rejected' && OMITTABLE.has(omitted[0].failure.code) ? omitted[0].failure : reject('invalid_plan');

  const region = accepted.scope.regions.length === 1 ? accepted.scope.regions[0] : 'all';
  const date = accepted.dates.at(-1)!;
  const scope = options.base?.scope ?? { region, date, ...(accepted.scope.source === 'explicit' && accepted.scope.branchIds.length > 0 && accepted.scope.branchIds.length <= 12
    ? { branchIds: [...accepted.scope.branchIds] } : {}) };
  const spec: DashboardSpec = { title: plan.title, description: plan.description, scope, widgets: [...base, ...widgets] };
  return { outcome: 'accepted', spec, widgets: data, evidence: { ...evidenceRef }, omitted: omitted.map(item => item.title) };
}
