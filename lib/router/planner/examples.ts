/**
 * Planner prompt examples: complete TurnPlans (not prose) so the model sees the exact canonical shape, and so every
 * example is VALIDATED end-to-end by tests/router/planner/examples.test.ts against EXAMPLE_CONTEXT (validateTurnPlan,
 * query/HR plan validation, dashboard widget binding rules). The ids and dates are illustrative: the prompt says the
 * model must take ids from SERVER_CONTEXT and dates from BUSINESS_CONTEXT. Inert data; nothing here reads user text.
 */

export const EXAMPLE_BUSINESS_DATE = '2030-03-14'; // Thursday
export const EXAMPLE_WINDOW = { from: '2030-02-13', to: '2030-03-14' } as const;

export interface PlannerExample {
  id: string;
  /** The user message of the example (Thai, like real traffic). */
  say: string;
  /** Context the example assumes (shown to the model in the prompt). */
  given?: string;
  /** The prior accepted plan of a continuation example (test fixture only; never shown). */
  priorDates?: string[];
  plan: { steps?: unknown[] } & Record<string, unknown>;
}

/** Evidence spans are shown text-only: offsets are server-owned (the server locates the text and fills them). */
const span = (say: string, text: string) => {
  if (!say.includes(text)) throw new Error(`example span not in message: ${text}`);
  return { text };
};
const interpretation = (value: string, say?: string, text?: string, source: 'explicit' | 'default' | 'inherited' = text ? 'explicit' : 'default') =>
  ({ value, source, ...(say && text ? { sourceText: span(say, text) } : {}), confidence: 0.95 });
/** A default choice (no user text) omits its interpretation: the server canonicalizer writes the default interpretation of that field. */
const interpreted = (fieldId: string, say?: string, text?: string, source?: 'explicit' | 'default' | 'inherited') =>
  (source ?? (text ? 'explicit' : 'default')) === 'default' && !text ? {} : { interpretation: interpretation(fieldId, say, text, source) };
const measure = (fieldId: string, aggregation: string, say?: string, text?: string, source?: 'explicit' | 'default' | 'inherited') =>
  ({ fieldId, aggregation, ...interpreted(fieldId, say, text, source) });
const dimension = (fieldId: string, say?: string, text?: string, source?: 'explicit' | 'default' | 'inherited') =>
  ({ fieldId, ...interpreted(fieldId, say, text, source) });
const regionFilter = (value: string | string[], evidenceText: string) =>
  ({ fieldId: 'region', op: Array.isArray(value) ? 'in' : 'eq', value, source: 'explicit', evidenceText, confidence: 0.95 });
const time = (dates: string[], evidenceText?: string, source: 'explicit' | 'inherited' = 'explicit') =>
  ({ fieldId: 'date', timezone: 'Asia/Bangkok', source, dates, ...(evidenceText && source === 'explicit' ? { evidenceText } : {}) });
/**
 * Prompt size: an example omits exactly the query fields the server canonicalizer fills identically (null scope/time/multiDateGrain/compare/topN,
 * empty dimensions/filters/sort/clarificationNeeds/group, requestedUses ["answer"], null sourceText, the requested-scope completeness, the
 * interpretation of a default field choice), as the prompt's plan-shape rule asks.
 */
function elideDefaults(plan: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...plan };
  for (const key of ['scope', 'time', 'multiDateGrain', 'compare', 'topN']) if (out[key] === null) delete out[key];
  for (const key of ['dimensions', 'filters', 'sort', 'clarificationNeeds']) if (Array.isArray(out[key]) && !(out[key] as unknown[]).length) delete out[key];
  if ((out.group as { fieldIds?: unknown[] } | undefined)?.fieldIds?.length === 0) delete out.group;
  if (JSON.stringify(out.requestedUses) === '["answer"]') delete out.requestedUses;
  if (JSON.stringify(out.completeness) === JSON.stringify(DEFAULT_COMPLETENESS)) delete out.completeness;
  return out;
}
const DEFAULT_COMPLETENESS = { expectation: 'requested_scope', requireFullPopulation: false, requiredSourceIds: [], minimumCoverage: 0 };
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/**
 * Prompt view of a stored query plan (PREVIOUS_STATE_DATA): the same canonical-default elision as the examples, plus planVersion 1, the
 * server plan id, null source texts and default interpretations. Every omitted field is one the server canonicalizer fills identically.
 */
export function elideQueryDefaults(plan: unknown): unknown {
  if (!isRecord(plan)) return plan;
  const out = elideDefaults(plan);
  if (out.planVersion === 1) delete out.planVersion;
  delete out.planId;
  const lean = (item: unknown): unknown => {
    if (!isRecord(item)) return item;
    const next: Record<string, unknown> = { ...item };
    if (next.sourceText === null) delete next.sourceText;
    if (isRecord(next.interpretation)) {
      const interpretation: Record<string, unknown> = { ...next.interpretation };
      if (interpretation.sourceText === null || interpretation.sourceText === undefined) delete interpretation.sourceText;
      if (interpretation.source === 'default' && interpretation.sourceText === undefined && interpretation.value === next.fieldId) delete next.interpretation;
      else next.interpretation = interpretation;
    }
    return next;
  };
  for (const key of ['measures', 'dimensions', 'filters']) if (Array.isArray(out[key])) out[key] = (out[key] as unknown[]).map(lean);
  return out;
}
const query = (over: Record<string, unknown>, datasetId = 'branch_performance') => elideDefaults({
  datasetId, measures: [measure('net_sales', 'sum')], dimensions: [], filters: [], scope: null, time: null,
  grain: ['branch', 'date'], aggregation: 'registered', multiDateGrain: null, group: { fieldIds: [] }, compare: null, sort: [], topN: null,
  completeness: DEFAULT_COMPLETENESS, clarificationNeeds: [], confidence: 0.9, requestedUses: ['answer'], ...over,
});
/** turnPlanVersion (always 1), query planVersion/planId and continuation false are canonical defaults the server fills: omitted here. */
const plan = (...steps: Record<string, unknown>[]) => ({ steps });
const quoted = (value: unknown, evidenceText: string) => ({ value, source: 'user_quoted', evidenceText });
const ctx = (value: unknown) => ({ value, source: 'context_id' });

const S = {
  total: 'ยอดขายรวมวันนี้เท่าไหร่',
  ranking: 'สาขาไหนต่ำกว่าเป้ามากที่สุด 3 อันดับ',
  central: 'แล้วภาคกลางล่ะ',
  vsTarget: 'ยอดขายภาคตะวันออกเทียบเป้า',
  headcount: 'มีพนักงานที่ยังทำงานอยู่กี่คน',
  lookup: 'ขอข้อมูลพนักงาน EMP_7',
  share: 'แชร์ Dashboard นี้ให้ผู้จัดการภาคตะวันออก',
  ticket: 'เปิด Ticket ติดตามสาขา BR_A และ BR_B ด่วน ครบกำหนด 2030-03-20',
  ticketDerived: 'เปิด Ticket ติดตามสาขาที่ยอดต่ำกว่าเป้า priority สูง',
  revoke: 'เพิกถอนบัตร CARD_7 ของ EMP_7 เพราะพ้นสภาพพนักงาน',
  send: 'ส่งสรุปนี้ให้ผู้จัดการภาคตะวันออก',
  donut: 'ทำกราฟโดนัทสัดส่วนยอดขายรายสาขา',
  dashboardFamilies: 'สร้าง Dashboard สัดส่วนยอดขาย ยอดขายเทียบเป้า และกราฟผสมรายสาขาภาคตะวันออก',
  shareArtifact: 'แชร์กราฟนี้ให้ผู้จัดการภาคตะวันออก',
  task: 'สร้างงานติดตาม BR_A ด่วน ครบกำหนด 2030-03-20 พร้อมรายการตรวจ',
  monitorOwner: 'แจ้งฉันเมื่อสาขาไหนยอดขายต่ำกว่า 85% ของเป้า',
  pause: 'หยุดการแจ้งเตือนนี้ชั่วคราว',
  cancel: 'ยกเลิกรายการนี้',
  rename: 'เปลี่ยนชื่อ Dashboard เป็น ภาพรวมขายตะวันออก',
  lookupOld: 'เปลี่ยนชื่อ Dashboard “ยอดขายปีที่แล้ว” เป็นข้อมูลเก่า',
  addToSaved: 'เพิ่มยอดขายภาคตะวันออกรายสาขาเข้า Dashboard ยอดขายภาคตะวันออก',
  deleteAmbiguous: 'ลบ Dashboard นี้',
  stockDashboard: 'ทำ Dashboard สต็อกต่ำกว่าขั้นต่ำแยกตามสาขา',
  stockTable: 'ทำตารางจากคำตอบสต็อกนี้',
  moreIncidents: 'แสดงเหตุการณ์ที่ยังเปิดอยู่วันนี้ต่ออีก',
  stockVsIncidents: 'เทียบสต็อกที่ขาดกับเหตุการณ์แยกตามสาขา',
  policy: 'ขอดู Policy การจัดการ Incident ล่าสุด',
  policyAck: 'ขอรับทราบ Policy การจัดการ Incident',
  directorQueue: 'มีคำขอ Onboarding ใดรอฉันอนุมัติบ้าง',
  directorMore: 'ขอดูรายการรออนุมัติถัดไปอีก',
  directorDates: 'เรียงตามวันเริ่มงาน',
  directorDocs: 'ขอดูเอกสารของรายการนี้',
  directorApproveAll: 'approve ทั้งหมดที่ฉันเพิ่งตรวจ',
  directorApproveTwo: 'approve สองรายการนี้',
  directorReturn: 'ส่งรายการนี้กลับไปแก้ เพราะสัญญาจ้างยังไม่ถูกต้อง',
  directorEmail: 'ส่ง Email แจ้งผลให้คนที่เกี่ยวข้อง',
  resultRename: 'เปลี่ยนชื่อผลลัพธ์นี้เป็น ยอดขายสาขาภาคตะวันออก',
  resultUnarchive: 'เอาผลลัพธ์ที่เก็บไว้กลับมา',
  dashboardArchive: 'เก็บถาวร Dashboard นี้',
  monitorRename: 'เปลี่ยนชื่อ Monitor นี้เป็น เฝ้ายอดขายตะวันออก',
  productHelp: 'Dashboard กับ Result ต่างกันยังไง',
} as const;

const D = EXAMPLE_BUSINESS_DATE;

export const PLANNER_EXAMPLES: readonly PlannerExample[] = [
  { id: 'single_day_total', say: S.total, plan: { ...plan({ kind: 'query', continuation: false,
    plan: query({ time: time([D], 'วันนี้') }) }), suggestedConversationTitle: 'ยอดขายรวมวันนี้' } },
  { id: 'ranking_lowest_vs_target', say: S.ranking, plan: plan({ kind: 'query', continuation: false,
    plan: query({ measures: [measure('gap', 'gap', S.ranking, 'ต่ำกว่าเป้า')], dimensions: [dimension('branch', S.ranking, 'สาขา')],
      group: { fieldIds: ['branch'] }, sort: [{ fieldId: 'gap', direction: 'asc' }], topN: { count: 3, direction: 'lowest', completeScopeRequired: true },
      completeness: { expectation: 'complete_authorized_population', requireFullPopulation: true, requiredSourceIds: [], minimumCoverage: 1 } }) }) },
  { id: 'continuation_new_region', say: S.central, given: `PREVIOUS_STATE_DATA = net_sales on ${D}`, priorDates: [D], plan: plan({ kind: 'query', continuation: true,
    plan: query({ measures: [measure('net_sales', 'sum', undefined, undefined, 'inherited')], filters: [regionFilter('central', 'ภาคกลาง')],
      time: time([D], undefined, 'inherited') }) }) },
  { id: 'sales_vs_target', say: S.vsTarget, plan: plan({ kind: 'query', continuation: false,
    plan: query({ measures: [measure('net_sales', 'sum', S.vsTarget, 'ยอดขาย')], filters: [regionFilter('east', 'ภาคตะวันออก')],
      compare: { kind: 'vs_target', period: null, baseline: null, sourceText: span(S.vsTarget, 'เทียบเป้า'), confidence: 0.95 } }) }) },
  { id: 'hr_headcount', say: S.headcount, plan: plan({ kind: 'hr_query',
    plan: query({ measures: [measure('headcount', 'count', S.headcount, 'กี่คน')], grain: ['employee_id'] }, 'hr_employees') }) },
  { id: 'hr_lookup', say: S.lookup, plan: plan({ kind: 'hr_query',
    plan: query({ measures: [measure('headcount', 'count')], aggregation: 'rows', grain: ['employee_id'],
      filters: [{ fieldId: 'employee_id', op: 'eq', value: 'EMP_7', source: 'explicit', evidenceText: 'EMP_7', confidence: 0.95 }] }, 'hr_employees') }) },
  // Two-step Dashboard (query, then dashboard.create over $step0) with chart families: bar; pie/donut/treemap = part-to-whole of ONE additive
  // measure; scatter = two measures per group; combo = bars + line measures. (One example: a plain bar Dashboard has the same shape.)
  { id: 'dashboard_two_step', say: S.dashboardFamilies, plan: plan(
    { kind: 'query', plan: query({ measures: [measure('net_sales', 'sum'), measure('target', 'sum')], dimensions: [dimension('branch', S.dashboardFamilies, 'รายสาขา')],
      filters: [regionFilter('east', 'ภาคตะวันออก')], time: null, group: { fieldIds: ['branch'] } }) },
    { kind: 'action', actionId: 'dashboard.create', params: { title: { value: 'ยอดขายรายสาขาภาคตะวันออก', source: 'generated' }, source: ctx('$step0') },
      visualization: { version: 1, title: 'ยอดขายรายสาขาภาคตะวันออก', description: '', widgets: [
        { kind: 'bar', title: 'ยอดขายรายสาขา', measure: 'net_sales', dimension: 'branch', sort: 'desc', topN: null },
        { kind: 'pie', title: 'สัดส่วนยอดขาย', measure: 'net_sales', dimension: 'branch', sort: null, topN: null },
        { kind: 'combo', title: 'ยอดขายและเป้า', measure: 'net_sales', measures: ['target'], lineMeasures: ['target'], dimension: 'branch', sort: null, topN: null }] } }) },
  { id: 'share_saved_dashboard', say: S.share, given: 'DASHBOARDS has one dashboard DB_1; RECIPIENTS has east', plan: plan({ kind: 'action', actionId: 'dashboard.share',
    params: { dashboard: ctx('DB_1'), recipientId: quoted('east', 'ผู้จัดการภาคตะวันออก') } }) },
  { id: 'ticket', say: S.ticket, plan: plan({ kind: 'action', actionId: 'ticket.create', params: { branchIds: quoted(['BR_A', 'BR_B'], 'BR_A และ BR_B'),
    priority: quoted('urgent', 'ด่วน'), dueDate: quoted('2030-03-20', '2030-03-20') } }) },
  { id: 'ticket_derived_branches', say: S.ticketDerived, plan: plan(
    { kind: 'query', plan: query({ measures: [measure('net_sales', 'sum'), measure('target', 'sum')], dimensions: [dimension('branch')],
      group: { fieldIds: ['branch'] }, time: null }) },
    { kind: 'action', actionId: 'ticket.create', params: { branchesFrom: ctx('$step0'), branchesRule: { value: 'below_target', source: 'generated' },
      priority: quoted('high', 'priority สูง') } }) },
  { id: 'badge_revoke', say: S.revoke, plan: plan({ kind: 'action', actionId: 'badge.revoke',
    params: { badgeId: quoted('CARD_7', 'CARD_7'), employeeId: quoted('EMP_7', 'EMP_7'), reason: quoted('พ้นสภาพพนักงาน', 'พ้นสภาพพนักงาน') } }) },
  { id: 'send_answer', say: S.send, given: 'ACCEPTED_STATES / PREVIOUS_STATE_DATA has ACC_1', plan: plan({ kind: 'action', actionId: 'communication.send',
    params: { recipientIds: quoted(['east'], 'ผู้จัดการภาคตะวันออก'), content: ctx('ACC_1') } }) },
  // G5: no person named = the owner's own alert (recipientIds omitted); no accepted answer yet = query by branch first, then monitor.create over $step0.
  { id: 'monitor_create_owner', say: S.monitorOwner, plan: plan(
    { kind: 'query', plan: query({ measures: [measure('net_sales', 'sum'), measure('target', 'sum')], dimensions: [dimension('branch', S.monitorOwner, 'สาขา')],
      group: { fieldIds: ['branch'] } }) },
    { kind: 'action', actionId: 'monitor.create', params: { query: ctx('$step0'), threshold: quoted(0.85, '85%') } }) },
  // A chart of data not answered yet (G3-4): the query, then the chart artifact over $step0 — a chart request is never a query alone.
  { id: 'artifact_donut', say: S.donut, plan: plan({ kind: 'query', plan: query({ dimensions: [dimension('branch', S.donut, 'รายสาขา')], group: { fieldIds: ['branch'] }, time: null }) },
    { kind: 'artifact', sourceStateId: '$step0', artifactTypeId: 'chart', operation: 'create',
    baseArtifactId: null, title: { value: 'สัดส่วนยอดขายรายสาขา', source: 'generated' }, outputFormat: 'preview',
    visual: { primitiveId: 'donut', xFieldId: 'branch', yFieldIds: ['net_sales'], interactionIds: ['inspect_data', 'tooltip', 'select_point', 'cross_filter', 'reset'], animation: 'interpolate' } }) },
  { id: 'share_artifact', say: S.shareArtifact, given: 'ARTIFACTS has ART_1; RECIPIENTS has east', plan: plan({ kind: 'action', actionId: 'artifact.share',
    params: { artifact: ctx('ART_1'), recipientIds: quoted(['east'], 'ผู้จัดการภาคตะวันออก') } }) },
  { id: 'task_create', say: S.task, plan: plan({ kind: 'action', actionId: 'task.create', params: {
    title: { value: 'ติดตามสาขา BR_A', source: 'generated' }, priority: quoted('urgent', 'ด่วน'), dueDate: quoted('2030-03-20', '2030-03-20'),
    branchIds: quoted(['BR_A'], 'BR_A'), checklist: { value: ['ตรวจยอดขาย', 'ตรวจสต็อก'], source: 'generated' } } }) },
  { id: 'monitor_pause', say: S.pause, given: 'MONITORS has MON_1', plan: plan({ kind: 'action', actionId: 'monitor.manage',
    params: { monitor: ctx('MON_1'), operation: { value: 'pause', source: 'generated' } } }) },
  { id: 'result_rename', say: S.resultRename, given: 'ARTIFACTS has ART_1', plan: plan({ kind: 'action', actionId: 'result.manage',
    params: { artifact: ctx('ART_1'), operation: { value: 'rename', source: 'generated' }, title: quoted('ยอดขายสาขาภาคตะวันออก', 'ยอดขายสาขาภาคตะวันออก') } }) },
  { id: 'result_unarchive', say: S.resultUnarchive, given: 'ARCHIVED_ARTIFACTS has ART_9', plan: plan({ kind: 'action', actionId: 'result.unarchive', params: { artifact: ctx('ART_9') } }) },
  { id: 'cancel_pending', say: S.cancel, given: 'PENDING_ACTIONS has PEND_1', plan: plan({ kind: 'refine', pendingActionId: 'PEND_1', operation: { op: 'cancel' } }) },
  // G5: "this Dashboard" is the DASHBOARDS entry marked current, even when a Result has the same title; เก็บถาวร = archive (never result save).
  { id: 'dashboard_archive', say: S.dashboardArchive, given: 'DASHBOARDS has DB_1 current:true; ARTIFACTS has a Result with the same title', plan: plan({ kind: 'action', actionId: 'dashboard.manage',
    params: { dashboard: ctx('DB_1'), operation: { value: 'archive', source: 'generated' } } }) },
  { id: 'monitor_rename', say: S.monitorRename, given: 'MONITORS has MON_1', plan: plan({ kind: 'action', actionId: 'monitor.manage',
    params: { monitor: ctx('MON_1'), operation: { value: 'rename', source: 'generated' }, title: quoted('เฝ้ายอดขายตะวันออก', 'เฝ้ายอดขายตะวันออก') } }) },
  { id: 'rename_saved_dashboard', say: S.rename, given: 'DASHBOARDS has one dashboard DB_1', plan: plan({ kind: 'action', actionId: 'dashboard.rename',
    params: { dashboard: ctx('DB_1'), title: quoted('ภาพรวมขายตะวันออก', 'ภาพรวมขายตะวันออก') } }) },
  { id: 'delete_ambiguous', say: S.deleteAmbiguous, given: 'DASHBOARDS has DB_1 and DB_2', plan: plan({ kind: 'clarify',
    about: { kind: 'action', actionId: 'dashboard.delete' }, missing: [{ slot: 'params.dashboard', reason: 'ambiguous' }],
    question: 'ต้องการลบ Dashboard ใดครับ', choices: [{ id: 'DB_1', label: 'ยอดขายภาคตะวันออก' }, { id: 'DB_2', label: 'ภาพรวมขายตะวันออก' }] }) },
  // Registered table datasets (offered only to actors whose catalog lists them): grouped aggregate, paged listing, next page, bounded join.
  // A table answer is a first-class source: Dashboard widgets (two steps; step 0 is the plain grouped table query), an artifact over an accepted
  // table state, a message carrying it.
  { id: 'table_dashboard_two_step', say: S.stockDashboard, plan: plan(
    { kind: 'query', plan: query({ measures: [measure('low_stock_items', 'sum', S.stockDashboard, 'สต็อกต่ำกว่าขั้นต่ำ')],
      dimensions: [dimension('branch', S.stockDashboard, 'แยกตามสาขา')], group: { fieldIds: ['branch'] }, grain: ['branch'] }, 'inventory_items') },
    { kind: 'action', actionId: 'dashboard.create', params: { title: { value: 'สต็อกต่ำรายสาขา', source: 'generated' }, source: ctx('$step0') },
      visualization: { version: 1, title: 'สต็อกต่ำรายสาขา', description: '', widgets: [
        { kind: 'bar', title: 'รายการสต็อกต่ำ', measure: 'low_stock_items', dimension: 'branch', sort: 'desc', topN: null }] } }) },
  { id: 'table_artifact', say: S.stockTable, given: 'ACCEPTED_STATES has TAB_1 (low_stock_items by branch)', plan: plan({ kind: 'artifact', sourceStateId: 'TAB_1', artifactTypeId: 'table', operation: 'create',
    baseArtifactId: null, title: { value: 'สต็อกต่ำรายสาขา', source: 'generated' }, outputFormat: 'preview', visual: null }) },
  // Paged listing (one example): the first page is the same plan with page.cursor null.
  { id: 'table_next_page', say: S.moreIncidents, given: 'REFERENCE_SET.pagination offers nextCursor CUR_1 for the incident listing', plan: plan({ kind: 'query', continuation: true, plan: query({
    measures: [measure('incident_records', 'count')], dimensions: [dimension('branch'), dimension('kind'), dimension('status')],
    filters: [{ fieldId: 'status', op: 'eq', value: 'open', source: 'explicit', evidenceText: 'ที่ยังเปิดอยู่', confidence: 0.95 }],
    aggregation: 'rows', time: time([D], 'วันนี้'), grain: ['incident'], page: { limit: 10, cursor: 'CUR_1' } }, 'incident_log') }) },
  { id: 'table_join_stock_incidents', say: S.stockVsIncidents, plan: plan({ kind: 'query', plan: query({
    measures: [measure('stock_shortfall', 'sum', S.stockVsIncidents, 'สต็อกที่ขาด'), measure('incident_log.incident_records', 'count', S.stockVsIncidents, 'เหตุการณ์')],
    dimensions: [dimension('branch', S.stockVsIncidents, 'แยกตามสาขา')], group: { fieldIds: ['branch'] }, joins: [{ datasetId: 'incident_log' }],
    grain: ['branch'] }, 'inventory_items') }) },
  { id: 'policy_acknowledge', say: S.policyAck, given: 'POLICIES has POL_1 version 1.0, also in SHOWN_POLICIES (read in this conversation)', plan: plan({ kind: 'action', actionId: 'policy.acknowledge',
    params: { policy: ctx('POL_1'), version: ctx('1.0') } }) },
  { id: 'policy_read', say: S.policy, given: 'POLICIES lists POL_1', plan: plan({ kind: 'policy_read', policyIds: ['POL_1'] }) },
  // HR Director (Workflow V2): reads by registered readId; decisions bound to one WORKFLOW.reviewedQueues id; Email is a separate action.
  { id: 'director_queue', say: S.directorQueue, given: 'WORKFLOW.reads has director_queue', plan: plan({ kind: 'workflow_read', readId: 'director_queue' }) },
  { id: 'director_queue_next', say: S.directorMore, given: 'WORKFLOW.reviewedQueues has RQ_1 (a full page of 20)', plan: plan({ kind: 'workflow_read', readId: 'director_queue', snapshotId: 'RQ_1' }) },
  { id: 'director_start_dates', say: S.directorDates, given: 'WORKFLOW.reviewedQueues has RQ_1', plan: plan({ kind: 'workflow_read', readId: 'director_start_dates', snapshotId: 'RQ_1' }) },
  { id: 'director_documents', say: S.directorDocs, given: 'WORKFLOW.reviewedQueues RQ_1 has requests REQ_1, REQ_2; the user means REQ_1', plan: plan({ kind: 'workflow_read', readId: 'director_request_documents', snapshotId: 'RQ_1', requestId: 'REQ_1' }) },
  { id: 'director_approve_all', say: S.directorApproveAll, given: 'WORKFLOW.reviewedQueues has RQ_1', plan: plan({ kind: 'action', actionId: 'onboarding.director_approve',
    params: { queue: ctx('RQ_1'), selection: quoted('all_reviewed', 'ทั้งหมดที่ฉันเพิ่งตรวจ') } }) },
  { id: 'director_approve_subset', say: S.directorApproveTwo, given: 'WORKFLOW.reviewedQueues RQ_1 has REQ_1, REQ_2, REQ_3; the user means REQ_1 and REQ_2', plan: plan({ kind: 'action', actionId: 'onboarding.director_approve',
    params: { queue: ctx('RQ_1'), selection: quoted('subset', 'สองรายการนี้'), requestIds: ctx(['REQ_1', 'REQ_2']) } }) },
  { id: 'director_return', say: S.directorReturn, given: 'WORKFLOW.reviewedQueues RQ_1 has REQ_1', plan: plan({ kind: 'action', actionId: 'onboarding.return',
    params: { queue: ctx('RQ_1'), requestIds: ctx(['REQ_1']), reason: quoted('สัญญาจ้างยังไม่ถูกต้อง', 'สัญญาจ้างยังไม่ถูกต้อง') } }) },
  { id: 'director_email', say: S.directorEmail, given: 'WORKFLOW.verifiedApprovals has APR_1', plan: plan({ kind: 'action', actionId: 'onboarding.notify_email',
    params: { approval: ctx('APR_1'), subject: { value: 'แจ้งผลการอนุมัติคำขอ Onboarding', source: 'generated' },
      body: { value: 'เรียนผู้เกี่ยวข้อง ผู้อำนวยการฝ่ายบุคคลได้อนุมัติคำขอ Onboarding ตามรายการด้านล่างแล้ว', source: 'generated' } } }) },
  // Saved Dashboard changes through chat (the same refine executor the UI/AI share; a shared Dashboard stages the owner confirmation).
  { id: 'refine_saved_dashboard_add', say: S.addToSaved, given: 'DASHBOARDS has DB_1 (ยอดขายภาคตะวันออก) and DB_2', plan: plan(
    { kind: 'query', plan: query({ dimensions: [dimension('branch', S.addToSaved, 'รายสาขา')], filters: [regionFilter('east', 'ภาคตะวันออก')],
      time: null, group: { fieldIds: ['branch'] } }) },
    { kind: 'refine', pendingActionId: 'DB_1', operation: { op: 'revise_dashboard', sourceStateId: '$step0', visualizationMode: 'append',
      visualization: { version: 1, title: 'ยอดขายภาคตะวันออก', description: '', widgets: [
        { kind: 'bar', title: 'ยอดขายรายสาขา', measure: 'net_sales', dimension: 'branch', sort: 'desc', topN: null }] } } }) },
  // Older Dashboard / Result / Monitor outside the bounded lists: ONE lookup step, never a guessed id (the tapped choice completes the request).
  // PRODUCT MODEL self-help: a conversation step (topic product_help) naming PRODUCT_MODEL concepts, WITHOUT prose (G5: the server writes the
  // explanation and the account part; model prose here was long, slow and mostly replaced anyway).
  { id: 'product_help_result_vs_dashboard', say: S.productHelp, plan: plan({ kind: 'conversation', topic: 'product_help', concepts: ['result', 'dashboard'] }) },
  { id: 'lookup_older_dashboard', say: S.lookupOld, given: 'DASHBOARDS (newest few only) lists no dashboard by that name; lookup is available', plan: plan({ kind: 'resource_lookup', resource: 'dashboard', query: 'ยอดขายปีที่แล้ว' }) },
];

/**
 * Prompt text: one compact line per example the actor could actually use (only registered actions the actor holds and
 * datasets in its catalog), so the prompt never advertises an action or dataset outside the actor's authority.
 */
export function plannerExamplesText(usable?: { actionIds: ReadonlySet<string>; datasetIds: ReadonlySet<string>; policies?: boolean; workflowReads?: boolean; lookup?: boolean; productHelp?: boolean }): string {
  const fits = (example: PlannerExample) => !usable || ((example.plan.steps ?? []) as Record<string, unknown>[]).every(step =>
    step.kind === 'action' ? usable.actionIds.has(String(step.actionId))
      : step.kind === 'query' || step.kind === 'hr_query' ? usable.datasetIds.has(String((step.plan as { datasetId?: unknown }).datasetId))
        : step.kind === 'clarify' && (step.about as { kind?: string }).kind === 'action' ? usable.actionIds.has(String((step.about as { actionId?: unknown }).actionId))
          : step.kind === 'conversation' && step.topic === 'product_help' ? usable.productHelp !== false
          : step.kind === 'policy_read' ? usable.policies === true : step.kind === 'workflow_read' ? usable.workflowReads === true : step.kind === 'resource_lookup' ? usable.lookup === true : true);
  return PLANNER_EXAMPLES.filter(fits).map(example =>
    `“${example.say}”${example.given ? ` (${example.given})` : ''} → ${JSON.stringify(example.plan)}`).join('\n');
}
