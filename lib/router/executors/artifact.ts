import { parseArtifactRef } from '../../artifacts/ref';
import 'server-only';

import type { Actor, Branch, Store } from '../../contracts';
import { reloadActor } from '../../core/auth';
import {
  artifactPlanSchema, createArtifactResponse, prepareArtifact, type ArtifactPreview, type ArtifactStore, type ArtifactVersion,
} from '../../artifacts';
import { graphRef } from '../../artifacts/prepare';
import { createSemanticCatalog, type SemanticDataset } from '../../dynamic/catalog/semantic';
import type { EvidenceBundle } from '../../dynamic/evidence/bundle';
import type { ClaimGraph } from '../../dynamic/evidence/claim-graph';
import { authority } from '../../dynamic/runtime';
import type { AcceptedPlan, RejectedPlan } from '../../dynamic/validate/query-plan';
import {
  compileArtifactRenderer, type ArtifactLabels, type ArtifactRendererSpec, type VisualExpression, type VisualTraits,
} from '../../visualization';
import { attachPreviewVisual } from '../../artifacts/store';
import type { GroundedStep } from '../validate';
import type { TableAcceptedPlan, TableClaims, TableEvidenceBundle } from '../../dynamic/table/engine';
import { prepareTableArtifact } from '../../artifacts/table-prepare';
import type { ArtifactStep } from '../turn-plan';

/** The accepted answer an artifact is made from: the runtime-bound objects of an executed `query` step (same turn or re-executed). */
export interface RetailArtifactSource { stateId: string; plan: AcceptedPlan; bundle: EvidenceBundle; claims: ClaimGraph }
/** The accepted answer over a registered TABLE dataset (inventory_items, incident_log, support_tickets). */
export interface TableArtifactSource { table: true; stateId: string; accepted: TableAcceptedPlan; bundle: TableEvidenceBundle; claims: TableClaims }
export type ArtifactSource = RetailArtifactSource | TableArtifactSource;
export const isTableSource = (source: ArtifactSource): source is TableArtifactSource => 'table' in source;

export interface ArtifactExecutorInput {
  store: Store; actor: Actor; now: () => Date; signal?: AbortSignal;
  /** Validated artifact step (title already grounded; `params.title.value` is the title). */
  step: GroundedStep & { step: ArtifactStep };
  /** Server-resolved accepted answer for `step.sourceStateId` (or `$step0`). Missing source is the caller's clarify, never a fallback. */
  source: ArtifactSource;
  /** Transaction-scoped artifact store. Lookup failure must throw; null means confirmed absent. */
  artifacts: Pick<ArtifactStore, 'latest'>;
  /** Server-allocated artifact id for operation=create (ignored for revise, which keeps the base id). */
  newArtifactId: string;
}
export type ArtifactExecutorResult =
  | {
    outcome: 'accepted'; kind: 'artifact'; text: string;
    /** Ids the UI/conversation keeps for follow-ups ("revise that chart"). */
    artifactIds: string[]; artifact: { id: string; revision: number; kind: ArtifactStep['artifactTypeId']; title: string };
    spec: ArtifactRendererSpec; preview: ArtifactPreview;
  }
  | { outcome: 'denied'; kind: 'artifact'; code: string; text: string;
    /** Server-built next steps (labels from the catalog), e.g. the trend query a line chart needs. */
    followUps?: string[] };

const KIND_LABEL: Record<ArtifactStep['artifactTypeId'], string> = {
  table: 'ตาราง', ranking: 'ตารางอันดับ', chart: 'กราฟ', executive_brief: 'สรุปสำหรับผู้บริหาร', csv_export: 'ไฟล์ CSV',
};
const DENIED_TEXT: Record<string, string> = {
  artifact_permission: 'บัญชีนี้ยังไม่มีสิทธิ์สร้างผลลัพธ์ประเภทนี้',
  artifact_retained_field_permission: 'สิทธิ์ปัจจุบันไม่ครอบคลุมทุกฟิลด์ในหลักฐานนี้ จึงยังไม่สร้างผลลัพธ์',
  artifact_catalog_changed: 'แคตตาล็อกข้อมูลเปลี่ยนไปแล้ว โปรดค้นข้อมูลใหม่ก่อนสร้างผลลัพธ์',
  artifact_coverage: 'หลักฐานยังไม่ครบ จึงยังไม่สร้างผลลัพธ์',
  ranking_unavailable: 'หลักฐานนี้ไม่มีอันดับที่ตรวจครบทั้งกลุ่ม จึงยังไม่สร้างตารางอันดับ',
  artifact_base_mismatch: 'ผลลัพธ์เดิมไม่ตรงกับหลักฐานนี้ ปรับต่อได้เฉพาะจากหลักฐานเดิม หรือสร้างผลลัพธ์ใหม่',
  artifact_trust: 'ข้อมูลบางส่วนยังไม่ได้รับรองสำหรับสร้างผลลัพธ์',
  artifact_not_found: 'ไม่พบผลลัพธ์เดิมที่ต้องการปรับ',
  base_not_latest: 'ปรับต่อได้เฉพาะจากฉบับล่าสุดของผลลัพธ์ — ฉบับเก่าเก็บไว้ตามเดิมและไม่ถูกแก้',
  artifact_exists: 'รหัสผลลัพธ์นี้ถูกใช้แล้ว โปรดลองอีกครั้ง',
  visual_mixed_units: 'กราฟนี้รวมหน่วยที่ต่างกัน จึงยังสร้างไม่ได้',
  visual_mark_budget: 'กราฟนี้มีจุดข้อมูลมากเกินไป',
  visual_series_budget: 'กราฟนี้มีชุดข้อมูลมากเกินไป',
};
const DEFAULT_DENIED = 'ไม่สามารถสร้างผลลัพธ์นี้ได้ภายใต้สิทธิ์และหลักฐานปัจจุบัน';
const deniedResult = (code: string): ArtifactExecutorResult => ({ outcome: 'denied', kind: 'artifact', code, text: DENIED_TEXT[code] ?? DEFAULT_DENIED });
const rejection = (result: RejectedPlan) => deniedResult(result.code);

/** Display labels (Thai) from the server catalog. Display only; never alters ids, values or claims. */
export function artifactLabelsFromDataset(dataset: Pick<SemanticDataset, 'fields'>): ArtifactLabels {
  const fields: Record<string, string> = {}, units: Record<string, string> = {}, values: Record<string, Record<string, string>> = {};
  for (const field of dataset.fields) {
    if (field.displayLabel) fields[field.id] = field.displayLabel;
    if (field.unit && field.displayUnit) units[field.unit] = field.displayUnit;
    if (field.canonicalValues?.length) values[field.id] = Object.fromEntries(field.canonicalValues.map(v => [v.id, v.label]));
  }
  return { fields, units, values };
}

const FALLBACK_REASON: Record<string, string> = {
  visual_unsuitable_time: 'กราฟตามเวลาต้องมีข้อมูลเรียงตามวันที่จริงอย่างน้อยสองวัน',
  visual_unsuitable_scatter: 'แผนภาพกระจายต้องมีสองตัวชี้วัดครบทุกกลุ่มอย่างน้อยสามกลุ่ม',
  visual_unsuitable_heatmap: 'แผนที่ความร้อนต้องมีสองมิติและหนึ่งตัวชี้วัดอย่างน้อยสองคูณสองช่อง',
  visual_unsuitable_part_to_whole: 'กราฟสัดส่วนต้องเป็นตัวชี้วัดที่รวมกันได้ ค่าไม่ติดลบ และมีหลายกลุ่ม',
  visual_unsuitable_combo: 'กราฟผสมต้องมีตัวชี้วัดแท่งและเส้นที่หน่วยเข้ากันได้',
};
const DURATION: Record<string, number> = { fade: 150, interpolate: 300, reorder: 300 };

/**
 * Real-model tolerance for a scatter written "measure vs measure": the model puts one MEASURE in xFieldId (x = target, y = net_sales). The registered
 * scatter is entity (dimension) on x with BOTH measures in yFieldIds [horizontal, vertical]; rewrite to that canonical shape using only ids of the
 * artifact's own query (plan data, never user text). Anything else is left untouched for the compiler to judge.
 */
export function canonicalScatterVisual(visual: NonNullable<ArtifactStep['visual']>, artifact: Pick<ArtifactVersion, 'query'>): NonNullable<ArtifactStep['visual']> {
  if (visual.primitiveId !== 'scatter') return visual;
  const { measures, dimensions } = artifact.query;
  const isMeasure = (id: string) => measures.some(m => m.fieldId === id), isDimension = (id: string) => dimensions.some(d => d.fieldId === id);
  if (isDimension(visual.xFieldId) || !isMeasure(visual.xFieldId)) return visual;
  const entities = dimensions.map(d => d.fieldId).filter(id => id !== 'date');
  const entity = entities.length === 1 ? entities[0] : entities.includes('branch') ? 'branch' : undefined;
  const y = [visual.xFieldId, ...visual.yFieldIds.filter(id => id !== visual.xFieldId && isMeasure(id))];
  if (!entity || y.length !== 2) return visual;
  return { ...visual, xFieldId: entity, yFieldIds: y };
}

export function visualExpression(step: ArtifactStep, artifact: ArtifactVersion): VisualExpression | null {
  const visual = step.visual ? canonicalScatterVisual(step.visual, artifact) : step.visual;
  if (!visual) return null;
  const family = visual.primitiveId, timeAxis = visual.xFieldId === 'date';
  const ids = [...new Set(['inspect_data' as const, ...visual.interactionIds])];
  const linked = ids.some(id => id === 'select_point' || id === 'cross_filter' || id === 'drilldown');
  return {
    visualization: { version: 1, artifact: artifact.ref, primitiveId: family, xFieldId: visual.xFieldId, yFieldIds: visual.yFieldIds,
      ...(visual.groupFieldId ? { groupFieldId: visual.groupFieldId } : {}), ...(visual.lineFieldIds ? { lineFieldIds: visual.lineFieldIds } : {}),
      encodings: { x: family === 'line' || family === 'area' || (family === 'combo' && timeAxis) ? 'time' : 'category', y: 'value' }, maxMarks: 500 },
    interaction: { version: 1, interactionIds: ids, selectionFields: linked ? [visual.xFieldId] : [] },
    animation: visual.animation === 'none' ? { version: 1, modeId: 'none', durationMs: 0, reducedMotion: 'respect' }
      : { version: 1, modeId: visual.animation, durationMs: DURATION[visual.animation], reducedMotion: 'respect' },
  };
}

/** The line/area request a single-date answer cannot carry, as a server-built next question: the same measure by the same dimension over recent dates. */
function trendSuggestion(code: string, step: ArtifactStep, artifact: ArtifactVersion, labels: ArtifactLabels): { followUps?: string[] } {
  if (code !== 'visual_unsuitable_time' || !step.visual) return {};
  const measure = labels.fields[step.visual.yFieldIds[0]!];
  const dimension = artifact.query.dimensions.map(d => d.fieldId).find(id => id !== 'date');
  const by = dimension ? labels.fields[dimension] : undefined;
  if (!measure) return {};
  const family = step.visual.primitiveId === 'area' ? 'กราฟพื้นที่' : 'กราฟเส้น';
  return { followUps: [`ทำ${family}${measure}${by ? `แยกตาม${by}` : ''} ย้อนหลัง 7 วัน`] };
}

/** Labels for a table answer: base fields by id, joined fields by qualified id (<datasetId>.<fieldId>). */
export function artifactLabelsFromTable(accepted: Pick<TableAcceptedPlan, 'dataset' | 'joined'>): ArtifactLabels {
  const base = artifactLabelsFromDataset(accepted.dataset);
  const fields: Record<string, string> = { ...base.fields }, units: Record<string, string> = { ...base.units };
  for (const joined of accepted.joined) {
    for (const field of joined.fields) {
      if (field.displayLabel) fields[`${joined.id}.${field.id}`] = field.displayLabel;
      if (field.unit && field.displayUnit) units[field.unit] = field.displayUnit;
    }
  }
  return { fields, units, values: base.values };
}

/** Measures a part-to-whole family may use: additive in the catalog and not a ratio. */
export function visualTraitsFromDataset(dataset: Pick<SemanticDataset, 'fields'>): VisualTraits {
  return { partToWhole: dataset.fields.filter(f => f.kind === 'measure' && f.additivity === 'additive' && f.unit !== 'percent').map(f => f.id) };
}

/**
 * Executes an accepted `artifact` step: chart / table / ranking / executive brief / CSV preview of an accepted answer.
 * Every value comes from the verified ClaimGraph; chart expressions are strict registered primitives (bar/line); CSV text
 * cells are formula-neutralized by the Wave 3 compiler. The result is a preview: persistence/download is a separately
 * confirmed effect (prepareArtifactWrite after user confirmation, owned by the service shell).
 */
export async function executeArtifactStep(input: ArtifactExecutorInput): Promise<ArtifactExecutorResult> {
  const signal = input.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  const { step } = input.step;
  const title = input.step.params.title?.value;
  if (typeof title !== 'string' || !title.trim()) return deniedResult('invalid_artifact_plan');
  const actor = await reloadActor(input.store, input.actor, input.now());
  const catalog = createSemanticCatalog(await input.store.list<Branch>('branches'));
  const artifactAuthority = { ...authority(actor), catalogDigest: catalog.digest };
  const source = input.source;
  const dataset = catalog.datasets.find(d => d.id === (isTableSource(source) ? source.accepted.dataset.id : source.plan.plan.datasetId));
  if (!dataset) return deniedResult('dataset_unavailable');

  let artifactId = input.newArtifactId, latest: { kind: 'absent' } | { kind: 'version'; artifact: ArtifactVersion } = { kind: 'absent' };
  if (step.operation === 'revise') {
    const baseRef = parseArtifactRef(step.baseArtifactId!);
    const base = await input.artifacts.latest(baseRef.artifactId);
    if (!base) return deniedResult('artifact_not_found');
    // A revision is made from the LATEST version only (immutable history is never rewritten): a pinned older version is refused, not silently replaced.
    if (baseRef.revision !== undefined && baseRef.revision !== base.revision) return deniedResult('base_not_latest');
    artifactId = base.artifactId; latest = { kind: 'version', artifact: base };
  } else if (await input.artifacts.latest(artifactId)) return deniedResult('artifact_exists');
  signal.throwIfAborted();

  /** One preparation entry for either evidence family; the table family builds its own plan/response from the same request. */
  const prepareAs = (typeId: ArtifactStep['artifactTypeId'], outputFormat: ArtifactStep['outputFormat']) => {
    if (isTableSource(source)) {
      return prepareTableArtifact({ request: { artifactTypeId: typeId, operation: step.operation, title: title.trim(), outputFormat,
        baseRevision: latest.kind === 'version' ? latest.artifact.ref : null }, artifactId,
      evidence: { accepted: source.accepted, bundle: source.bundle, claims: source.claims }, authority: artifactAuthority, catalog, latest, now: input.now().toISOString() });
    }
    const response = createArtifactResponse(source.claims);
    const proposal = artifactPlanSchema.safeParse({ version: 1, artifactTypeId: typeId, operation: step.operation, title: title.trim(),
      baseRevision: latest.kind === 'version' ? latest.artifact.ref : null, queryPlan: source.bundle.query, responsePlan: response.ref,
      evidence: source.bundle.ref, claimGraph: graphRef(source.claims), outputFormat });
    if (!proposal.success) return null;
    return prepareArtifact({ proposal: proposal.data, artifactId, bundle: source.bundle, graph: source.claims, response, authority: artifactAuthority,
      latest, now: input.now().toISOString() });
  };
  const prepared = prepareAs(step.artifactTypeId, step.outputFormat);
  if (!prepared) return deniedResult('invalid_artifact_plan');
  if (prepared.outcome !== 'accepted') return rejection(prepared);

  let preview = prepared.preview;
  let artifact = preview.artifact;
  const labels = isTableSource(source) ? artifactLabelsFromTable(source.accepted) : artifactLabelsFromDataset(dataset), traits = visualTraitsFromDataset(dataset);
  const expression = visualExpression(step, artifact);
  let compiled = compileArtifactRenderer({ artifact, authority: artifactAuthority, visualExpression: expression, labels, traits });
  let fallbackText = '';
  let kind = step.artifactTypeId;
  let resultTitle = artifact.plan.title;
  if (compiled.outcome !== 'accepted' && compiled.code in FALLBACK_REASON && latest.kind === 'version') {
    // G5: a REVISE to a family the data cannot carry ("make the latest chart a line" over one day by region) keeps the current version as it is
    // (no table replaces the chart) and says why, with the server-built next step that does fit (the same measure over recent dates).
    return { outcome: 'denied', kind: 'artifact', code: compiled.code,
      text: `ยังไม่ได้แก้ Result “${latest.artifact.plan.title}” — ชนิดกราฟที่ขอไม่เหมาะกับข้อมูลนี้ (${FALLBACK_REASON[compiled.code]}) ฉบับที่ ${latest.artifact.revision} ยังอยู่ตามเดิม`,
      ...trendSuggestion(compiled.code, step, artifact, labels) };
  }
  if (compiled.outcome !== 'accepted' && compiled.code in FALLBACK_REASON) {
    // Truthful fallback: the requested family does not fit this data shape, so the exact table is prepared instead and says why.
    const reason = FALLBACK_REASON[compiled.code];
    const table = prepareAs('table', 'preview');
    if (table?.outcome === 'accepted') {
      preview = table.preview; artifact = preview.artifact; kind = 'table'; resultTitle = artifact.plan.title;
      compiled = compileArtifactRenderer({ artifact, authority: artifactAuthority, visualExpression: null, labels, traits });
      fallbackText = ` · ชนิดกราฟที่ขอไม่เหมาะกับข้อมูลนี้ (${reason}) จึงแสดงเป็นตารางที่ตรวจสอบได้แทน`;
    }
  }
  if (compiled.outcome !== 'accepted') return rejection(compiled);
  if (kind === 'chart') attachPreviewVisual(preview, expression);
  signal.throwIfAborted();
  return {
    outcome: 'accepted', kind: 'artifact',
    text: `เตรียม${KIND_LABEL[kind]}ให้แล้ว (ฉบับที่ ${artifact.revision}) · ค่าทั้งหมดมาจากหลักฐานที่ตรวจแล้ว ตรวจดูก่อนบันทึกหรือส่งออก${fallbackText}`,
    artifactIds: [artifact.artifactId], artifact: { id: artifact.artifactId, revision: artifact.revision, kind, title: resultTitle },
    spec: compiled.spec, preview,
  };
}
