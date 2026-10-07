import type { Actor, DashboardSpec, VizWidget } from '../contracts';
import type { SemanticDatasetCatalog } from '../dynamic/catalog/semantic';
import { authority } from '../dynamic/runtime';
import { digest } from '../dynamic/shared';
import { isBoundTableClaims, revalidateTablePlan, tableBundlePlan, type TableAcceptedPlan, type TableClaims, type TableEvidenceBundle } from '../dynamic/table/engine';
import { tableFacts } from '../artifacts/table-prepare';
import type { NumericClaim } from '../dynamic/evidence/claim-graph';
import { dashboardVisualizationPlanSchema, type VizWidgetData } from './dashboard-data';
import { bindWidgetPlan } from './dashboard-bind';
import { resolveVizWidget, type FamilyContext } from './dashboard-family';
import { artifactLabelsFromTable, visualTraitsFromDataset } from '../router/executors/artifact';
import { gateVisualizationText, type DashboardFromPlanResult, type DashboardPlanOptions } from './dashboard-spec';

/** Accepted, evidence-bound answer over a registered table dataset (the table executor output plus the message that carried its source spans). */
export interface TableDashboardEvidence { accepted: TableAcceptedPlan; bundle: TableEvidenceBundle; claims: TableClaims; message: string }

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
const reject = (code: string, widgetIndex: number | null = null): DashboardFromPlanResult => ({ outcome: 'rejected', code, widgetIndex, text: TEXT[code] ?? TEXT.invalid_plan });
const OMITTABLE = new Set(['unknown_measure', 'unknown_dimension', 'widget_unavailable', 'topn_budget']);
const TRUSTED = ['internal', 'public_business'];

/** The numeric facts of a table answer in the claim-graph shape the viz resolver reads (numbers copied from the verified table claims). */
export function tableVizClaims(evidence: Pick<TableDashboardEvidence, 'accepted' | 'bundle' | 'claims'>): { claims: NumericClaim[]; limitations: string[] } {
  return { claims: tableFacts(evidence) as unknown as NumericClaim[], limitations: [...evidence.bundle.limitations] };
}

/**
 * Same contract as buildDashboardSpecFromPlan for a registered table dataset: validates the AI VisualizationPlan against the server catalog
 * and actor scope, binds every widget to the accepted table evidence, and stores the plan so each widget is re-read on open under the viewer's
 * own fresh authority (executeDashboardVizWidgets). Joined (qualified) measures are not widgets; they are left out and named.
 */
export function buildDashboardSpecFromTablePlan(
  planInput: unknown, evidence: TableDashboardEvidence, catalog: SemanticDatasetCatalog, actor: Actor, options: DashboardPlanOptions = {},
): DashboardFromPlanResult {
  const parsed = dashboardVisualizationPlanSchema.safeParse(planInput);
  if (!parsed.success) return reject('invalid_plan');
  const modelPlan = parsed.data;
  const texts = [modelPlan.title, modelPlan.description, ...modelPlan.widgets.map(w => w.title)];
  if (texts.some(t => CONTROL_CHARS.test(t) || options.isSafeText?.(t) === false)) return reject('unsafe_text');
  const base = options.base?.widgets ?? [];
  if (base.length + modelPlan.widgets.length > 12) return reject('too_many_widgets');
  if (!evidence.message.length || evidence.message.length > 2000) return reject('message_too_long');

  const { accepted } = evidence;
  try {
    if (tableBundlePlan(evidence.bundle) !== accepted || !isBoundTableClaims(evidence.claims, evidence.bundle)) return reject('evidence_unbound');
  } catch { return reject('evidence_unbound'); }
  const fresh = revalidateTablePlan(accepted, authority(actor), catalog);
  if (fresh.outcome !== 'accepted') return reject(fresh.outcome === 'semantic_uncertainty' && fresh.code === 'catalog_changed' ? 'catalog_changed' : 'permission_denied');
  if (!actor.permissions.includes('dashboard.create')) return reject('permission_denied');
  const dataset = accepted.dataset;
  if (!TRUSTED.includes(dataset.sensitivity) || dataset.trust !== 'certified') return reject('untrusted_field');

  const queryPlan = accepted.plan;
  const evidenceRef = evidence.bundle.ref;
  const claimsRef = evidence.claims.ref;
  const graph = tableVizClaims(evidence);
  const widgets: VizWidget[] = [];
  const data: VizWidgetData[] = [];
  const omitted: { title: string; failure: DashboardFromPlanResult }[] = [];
  const labels = artifactLabelsFromTable(accepted), traits = visualTraitsFromDataset(dataset);
  // G6: model-written Dashboard text passes the shared model-text gate; blocked text becomes server copy.
  const plan = gateVisualizationText(modelPlan, { title: options.base?.title ?? `Dashboard ${dataset.label ?? dataset.id}`, fieldLabels: labels.fields });
  const family: FamilyContext = { query: queryPlan, labels, traits };
  for (const [index, widget] of plan.widgets.entries()) {
    const skip = (code: string) => { omitted.push({ title: widget.title, failure: reject(code, index) }); };
    const binding = { datasetId: queryPlan.datasetId, evidenceDigest: evidenceRef.digest, claimGraphDigest: claimsRef.digest,
      catalogDigest: accepted.catalogDigest, queryDigest: digest(queryPlan), message: evidence.message,
      query: JSON.parse(JSON.stringify(queryPlan)) as Record<string, unknown> };
    const bound = bindWidgetPlan(widget, { dataset, query: queryPlan, actor, binding });
    if (!bound.ok) { if (bound.mode === 'reject') return reject(bound.code, index); skip(bound.code); continue; }
    const resolved = resolveVizWidget(bound.widget, graph, dataset, evidenceRef, family);
    if (resolved.outcome !== 'ready') { skip('widget_unavailable'); continue; }
    widgets.push(bound.widget);
    data.push(resolved.data);
  }
  if (!widgets.length) return omitted[0]?.failure.outcome === 'rejected' && OMITTABLE.has(omitted[0].failure.code) ? omitted[0].failure : reject('invalid_plan');

  const region = accepted.scope.regions.length === 1 ? accepted.scope.regions[0] : 'all';
  const date = accepted.dates.at(-1)!;
  const spec: DashboardSpec = { title: plan.title, description: plan.description, scope: options.base?.scope ?? { region, date }, widgets: [...base, ...widgets] };
  return { outcome: 'accepted', spec, widgets: data, evidence: { ...evidenceRef }, omitted: omitted.map(item => item.title) };
}
