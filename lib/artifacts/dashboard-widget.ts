import type { Actor, Branch, Reader, VizWidget } from '../contracts';
import { createSemanticCatalog } from '../dynamic/catalog/semantic';
import { queryPlanSchema } from '../dynamic/plan/schemas';
import { authority as queryAuthority } from '../dynamic/runtime';
import { digest } from '../dynamic/shared';
import { TABLE_TOOL } from '../router/executors/table-query';
import { artifactLabelsFromDataset, visualTraitsFromDataset } from '../router/executors/artifact';
import { bindWidgetPlan, type BindableWidgetPlan } from '../visualization/dashboard-bind';
import { resolveVizWidget, type FamilyContext } from '../visualization/dashboard-family';
import { loadStoredArtifact } from './store';
import type { ArtifactVersion } from './contracts';

/**
 * Turns an owner's stored Result into DYNAMIC Dashboard widgets (never a screenshot or stored rows): the widget is derived from the Result's
 * trusted source QueryPlan, dataset/catalog ids, visualization expression and evidence/claim digests, then bound exactly like an AI-created
 * widget (catalog-validated, query-bound, declarative). On open it is re-queried under the CURRENT viewer, so permission loss fails closed.
 * If the Result cannot become a widget that draws from current evidence, the answer is a Thai explanation, never a fallback image.
 */
/** `note` (Thai) discloses a visual conversion the owner should know about (e.g. a metric that became a table because it is not a single value). */
export type ResultWidgetOutcome = { outcome: 'ok'; title: string; widgets: VizWidget[]; note?: string } | { outcome: 'denied'; code: string; text: string };
const denied = (code: string, text: string): ResultWidgetOutcome => ({ outcome: 'denied', code, text });
const RETAIL_TOOL = 'retail.dynamic_query';
/** A Dashboard holds 12 widgets; one Result may add up to that many (one per measure), never silently fewer than the Result carries. */
const MAX_RESULT_WIDGETS = 12;
const trim = (text: string, max: number): string => { const chars = [...text]; return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text; };

/** The user message that carried the Result's query spans (needed to re-validate the stored plan on every open). Owner's own turn only. */
async function sourceMessage(reader: Reader, artifact: ArtifactVersion): Promise<string | null> {
  const records = (await reader.list<{ name: string; actorId: string; turnId: string; plan: unknown; createdAt?: string }>('tool_executions', { actorId: artifact.ownerId, status: 'completed' }))
    .filter(r => (r.name === RETAIL_TOOL || r.name === TABLE_TOOL) && r.actorId === artifact.ownerId)
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
  const want = digest(artifact.query);
  for (const record of records) {
    const plan = queryPlanSchema.safeParse(record.plan);
    if (!plan.success || digest(plan.data) !== want) continue;
    const message = await reader.get<{ text: string; actorId: string; role: string }>('conversation_messages', record.turnId);
    if (message && message.actorId === artifact.ownerId && message.role === 'user' && message.text.length > 0 && message.text.length <= 2000) return message.text;
  }
  return null;
}

export async function deriveResultWidgets(reader: Reader, actor: Actor, input: { artifactId: string; revision?: number; title?: string }): Promise<ResultWidgetOutcome> {
  const catalog = createSemanticCatalog(await reader.list<Branch>('branches'));
  const { artifact, visual } = await loadStoredArtifact(reader, { ...queryAuthority(actor), catalogDigest: catalog.digest }, input.artifactId, input.revision);
  const kind = artifact.plan.artifactTypeId;
  if (kind !== 'chart' && kind !== 'table' && kind !== 'ranking') return denied('result_kind_unsupported', 'ผลลัพธ์ประเภทนี้เพิ่มเข้า Dashboard ไม่ได้ — เลือกกราฟ ตาราง หรือตารางอันดับ');
  const dataset = catalog.datasets.find(d => d.id === artifact.query.datasetId);
  if (!dataset) return denied('dataset_unavailable', 'แหล่งข้อมูลของผลลัพธ์นี้ไม่อยู่ในแคตตาล็อกปัจจุบัน จึงเพิ่มเข้า Dashboard ไม่ได้');
  const message = await sourceMessage(reader, artifact);
  if (!message) return denied('source_unavailable', 'ยังหาคำถามต้นทางของผลลัพธ์นี้ไม่พบ จึงผูกกับข้อมูลสดของ Dashboard ไม่ได้ — ขอให้ผู้ช่วยทำผลลัพธ์ใหม่แล้วเพิ่มอีกครั้ง');
  const title = trim(input.title?.trim() || artifact.plan.title, 100);
  const dims = artifact.query.dimensions.map(d => d.fieldId);

  const binding: VizWidget['binding'] = { datasetId: artifact.query.datasetId, evidenceDigest: artifact.bundle.ref.digest, claimGraphDigest: artifact.graph.digest,
    catalogDigest: catalog.digest, queryDigest: digest(artifact.query), message, query: JSON.parse(JSON.stringify(artifact.query)) as Record<string, unknown> };
  const family: FamilyContext = { query: artifact.query, labels: artifactLabelsFromDataset(dataset), traits: visualTraitsFromDataset(dataset) };
  const plans: BindableWidgetPlan[] = [];
  const kpiDrawable = (plan: BindableWidgetPlan): boolean => {
    const bound = bindWidgetPlan(plan, { dataset, query: artifact.query, actor, binding });
    return bound.ok && resolveVizWidget(bound.widget, artifact.graph, dataset, artifact.bundle.ref, family).outcome === 'ready';
  };
  /** Metric measures whose KPI form cannot be drawn from the evidence (not a single value): they become exact tables, and the owner is told. */
  const metricAsTable: string[] = [];
  if (kind === 'chart') {
    if (!visual) return denied('visual_unavailable', 'ผลลัพธ์กราฟเก่านี้ไม่มีรูปแบบที่บันทึกไว้ จึงเพิ่มเข้า Dashboard ไม่ได้ — ขอให้ผู้ช่วยทำกราฟใหม่');
    const plan = visual.visualization;
    const ys = plan.yFieldIds;
    const interactions = visual.interaction.interactionIds.filter(id => id !== 'drilldown');
    if (plan.primitiveId === 'metric') {
      // A metric tile keeps its KPI widget (one per measure) when the measure is one verified value in the stored evidence; otherwise it becomes an exact table and the conversion is disclosed.
      for (const measure of ys) {
        const metricTitle = trim(ys.length > 1 ? `${title} · ${measure}` : title, 100);
        const kpiPlan: BindableWidgetPlan = { kind: 'kpi', title: metricTitle, measure, dimension: null, sort: null, topN: null };
        if (kpiDrawable(kpiPlan)) plans.push(kpiPlan);
        else { metricAsTable.push(metricTitle); plans.push({ kind: 'table', title: metricTitle, measure, dimension: plan.xFieldId, sort: null, topN: null }); }
      }
    } else {
      plans.push({ kind: plan.primitiveId, title, measure: ys[0], dimension: plan.xFieldId, sort: null, topN: null,
        ...(ys.length > 1 ? { measures: ys.slice(1) } : {}), ...(plan.groupFieldId ? { groupDimension: plan.groupFieldId } : {}),
        ...(plan.lineFieldIds ? { lineMeasures: plan.lineFieldIds } : {}), interactions, animation: visual.animation.modeId });
    }
  } else {
    if (dims.length > 1) return denied('table_multi_dimension', 'ตารางนี้จัดกลุ่มหลายมิติ จึงเพิ่มเป็นตารางใน Dashboard ไม่ได้ — เพิ่มเป็นกราฟแทนได้');
    const measures = artifact.query.measures.map(m => m.fieldId);
    const topN = artifact.query.topN;
    // The stored ranking query already bounds the entities (its top-N); each measure widget lists exactly those rows, ordered/limited by the same direction and count.
    for (const measure of measures) {
      plans.push({ kind: 'table', title: trim(measures.length > 1 ? `${title} · ${measure}` : title, 100), measure, dimension: dims[0] ?? null,
        sort: topN ? (topN.direction === 'highest' ? 'desc' : 'asc') : null, topN: topN ? Math.min(topN.count, 50) : null });
    }
  }
  if (plans.length > MAX_RESULT_WIDGETS) return denied('too_many_measures', `ผลลัพธ์นี้มี ${plans.length} ตัวชี้วัด แต่ Dashboard มี Widget ได้ไม่เกิน ${MAX_RESULT_WIDGETS} รายการ จึงไม่ได้เพิ่มบางส่วนแบบเงียบ ๆ — ลดตัวชี้วัดของผลลัพธ์แล้วลองใหม่`);

  const widgets: VizWidget[] = [];
  for (const plan of plans) {
    const bound = bindWidgetPlan(plan, { dataset, query: artifact.query, actor, binding });
    if (!bound.ok) {
      return bound.mode === 'reject'
        ? denied(bound.code, 'สิทธิ์ปัจจุบันไม่ครอบคลุมข้อมูลของผลลัพธ์นี้ จึงเพิ่มเข้า Dashboard ไม่ได้')
        : denied('widget_unavailable', 'ผลลัพธ์นี้สร้างเป็น Widget จากหลักฐานที่มีอยู่ไม่ได้');
    }
    // It must draw from the stored evidence right now (suitability, budgets) — otherwise nothing is added.
    const resolved = resolveVizWidget(bound.widget, artifact.graph, dataset, artifact.bundle.ref, family);
    if (resolved.outcome !== 'ready') return denied('widget_unavailable', 'ผลลัพธ์นี้สร้างเป็น Widget จากหลักฐานที่มีอยู่ไม่ได้ จึงไม่ได้เพิ่ม');
    widgets.push(bound.widget);
  }
  return { outcome: 'ok', title, widgets, ...(metricAsTable.length ? { note: 'ตัวชี้วัดนี้ไม่ใช่ค่าเดียว จึงเพิ่มเป็นตารางแทนการ์ดตัวเลขสำคัญ' } : {}) };
}
