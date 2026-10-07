import type { Actor, DashboardSpec } from '../../contracts';
import { digest } from '../../effects/shared';
import type { DashboardVisualizationPlan } from '../../visualization/dashboard-data';
import type { GroundedStep } from '../validate';
import type { ActionPorts, StagedProposal, TurnRef } from './action-ports';
import { DASHBOARD_CHANGED_CODE, DASHBOARD_SHARED_CODE, STAGED_UNAVAILABLE_CODE, type ActionExecResult, type VisualizationSpecResult } from './action';

export interface RefineExecutorInput {
  ports: ActionPorts; actor: Actor; step: GroundedStep; conversationId: string; now: () => Date; signal?: AbortSignal;
  /** Turn id of the staged proposal reference (shared-dashboard refine). */
  turnId?: string;
  /**
   * Server binding of an AI visualization plan to accepted evidence, extending `base` (buildDashboardSpecFromPlan with `base`):
   * the result spec is `[...base.widgets, ...new widgets]`. Absent => visualization refines are unavailable.
   */
  refineDashboardSpec?: (input: { visualization: DashboardVisualizationPlan; sourceId: string; base: DashboardSpec }) => Promise<VisualizationSpecResult>;
}

const ACTION_ID = 'refine';
const denied = (code: string, text: string): ActionExecResult => ({ outcome: 'denied', actionId: ACTION_ID, code, text, labels: [] });
const STAGED_TTL_MS = 24 * 3_600_000;
const VIZ_UNAVAILABLE = 'ยังเพิ่มแผนภาพข้อมูลลง Dashboard ไม่ได้ในตอนนี้ จึงไม่ได้เปลี่ยนแปลงใด ๆ';
const stagedUnavailable = (error: unknown): boolean =>
  !!error && typeof error === 'object' && 'code' in error && (error as { code: unknown }).code === STAGED_UNAVAILABLE_CODE;

/** Widgets the plan adds on top of `base` (append) or in place of it (replace). */
async function bindVisualization(input: RefineExecutorInput, base: DashboardSpec, mode: 'append' | 'replace'):
  Promise<{ ok: true; widgets: DashboardSpec['widgets']; spec: DashboardSpec } | { ok: false; result: ActionExecResult }> {
  const step = input.step.step;
  if (step.kind !== 'refine' || step.operation.op !== 'revise_dashboard' || !step.operation.visualization) return { ok: false, result: denied('invalid_plan', 'แผนภาพข้อมูลไม่ถูกต้อง') };
  const sourceId = step.operation.sourceStateId;
  if (!input.refineDashboardSpec || !sourceId) return { ok: false, result: denied('visualization_unavailable', VIZ_UNAVAILABLE) };
  const kept = mode === 'append' ? base : { ...base, widgets: [] };
  const built = await input.refineDashboardSpec({ visualization: step.operation.visualization, sourceId, base: kept });
  if (built.outcome !== 'accepted') return { ok: false, result: denied(built.code, built.text) };
  const widgets = built.spec.widgets.slice(kept.widgets.length);
  if (!widgets.length) return { ok: false, result: denied('widget_unavailable', 'Widget นี้สร้างจากหลักฐานที่มีอยู่ไม่ได้') };
  return { ok: true, widgets, spec: { ...base, widgets: mode === 'append' ? [...base.widgets, ...widgets] : widgets } };
}

/**
 * Executes one accepted `refine` step against a context id: a pending proposal (revise / cancel) or a saved dashboard
 * (rename). Ownership, conversation binding and permissions are re-checked server-side; the model only names the id.
 */
export async function executeRefineStep(input: RefineExecutorInput): Promise<ActionExecResult> {
  input.signal?.throwIfAborted();
  const step = input.step.step;
  if (step.kind !== 'refine') return denied('wrong_step_kind', 'ขั้นตอนนี้ไม่ใช่การแก้ไขรายการ');
  const { ports } = input;
  const actor = await ports.reloadActor(input.actor);
  if (!actor.active) return denied('permission_denied', 'บัญชีนี้ยังไม่มีสิทธิ์ทำรายการนี้ จึงไม่ได้ดำเนินการ');
  const id = step.pendingActionId;
  const op = step.operation;
  const title = typeof input.step.params.title?.value === 'string' ? input.step.params.title.value : undefined;
  const visualization = op.op === 'revise_dashboard' ? op.visualization ?? null : null;
  const mode: 'append' | 'replace' = op.op === 'revise_dashboard' && op.visualizationMode === 'replace' ? 'replace' : 'append';
  const removeIndexes = Array.isArray(input.step.params.removeWidgetIndexes?.value)
    ? input.step.params.removeWidgetIndexes.value.map(Number) : undefined;

  const staged = await ports.staged.get(actor, id);
  if (staged) {
    if (staged.actorId !== actor.id || staged.conversationId !== input.conversationId) return denied('target_not_found', 'ไม่พบรายการที่ระบุในบทสนทนานี้');
    if (op.op !== 'cancel') return denied('not_revisable', 'รายการประเภทนี้แก้ไขไม่ได้ — ยกเลิกแล้วขอใหม่ได้');
    if (staged.status !== 'pending') return denied('not_pending', 'รายการนี้ไม่อยู่ในสถานะรอยืนยันแล้ว');
    await ports.staged.save(actor, id, { status: 'cancelled' });
    return { outcome: 'cancelled', actionId: ACTION_ID, labels: [], ids: { pendingActionId: id }, text: 'ยกเลิกรายการที่รอยืนยันแล้ว — ไม่มีการดำเนินการใด ๆ' };
  }

  const pending = (await ports.listPending(actor, input.conversationId)).find(p => p.id === id);
  if (pending) {
    if (pending.actorId !== actor.id || pending.conversationId !== input.conversationId) return denied('target_not_found', 'ไม่พบรายการที่ระบุในบทสนทนานี้');
    if (pending.status !== 'pending') return denied('not_pending', 'รายการนี้ไม่อยู่ในสถานะรอยืนยันแล้ว');
    if (ports.proposalBound && !(await ports.proposalBound(actor, pending))) return denied('target_not_found', 'ไม่พบรายการที่ระบุในบทสนทนานี้');
    if (op.op === 'cancel') {
      const cancelled = await ports.cancelPending(actor, id);
      return { outcome: 'cancelled', actionId: ACTION_ID, labels: [], ids: { pendingActionId: cancelled.id }, text: 'ยกเลิกรายการที่รอยืนยันแล้ว — ไม่มีการดำเนินการใด ๆ' };
    }
    if (pending.payload.kind !== 'dashboard_create') return denied('not_revisable', 'แก้ไขได้เฉพาะตัวอย่าง Dashboard — ยกเลิกแล้วขอใหม่ได้');
    const patch: Record<string, unknown> = {};
    if (title !== undefined) patch.title = title;
    if (removeIndexes?.length) patch.widgetChange = { operation: 'remove', indexes: removeIndexes };
    if (visualization) {
      if (removeIndexes?.length) return denied('operation_conflict', 'โปรดทำทีละอย่าง — เพิ่มแผนภาพหรือเอาส่วนใดออก');
      const base = pending.payload.spec;
      const bound = await bindVisualization(input, base, mode);
      if (!bound.ok) return bound.result;
      patch.widgetChange = mode === 'append'
        ? { operation: 'add', index: base.widgets.length, widgets: bound.widgets }
        : { operation: 'set', widgets: bound.widgets };
    }
    if (!Object.keys(patch).length) return { outcome: 'clarify', actionId: ACTION_ID, code: 'missing_param', slot: 'operation', labels: [], text: 'โปรดระบุว่าจะแก้ชื่อหรือเอาส่วนใดออก' };
    const requestKey = `rev_${digest({ actorId: actor.id, id, patch }).slice(0, 40)}`;
    try {
      const revised = await ports.revisePending(actor, id, patch, requestKey);
      return { outcome: 'updated', actionId: ACTION_ID, labels: [], ids: { pendingActionId: revised.replacement.id }, undo: null,
        text: `แก้ไขตัวอย่าง Dashboard แล้ว (${revised.diff.join(', ') || 'อัปเดตแล้ว'}) — ยังไม่ได้สร้าง โปรดตรวจตัวอย่างและยืนยัน` };
    } catch {
      return { outcome: 'failed', actionId: ACTION_ID, code: 'revise_failed', labels: [], text: 'แก้ไขตัวอย่างไม่สำเร็จ ตัวอย่างเดิมยังไม่เปลี่ยน — ลองใหม่อีกครั้ง' };
    }
  }

  const dashboard = await ports.getDashboard(actor, id);
  if (!dashboard || dashboard.ownerId !== actor.id || dashboard.deleted) return denied('target_not_found', 'ไม่พบรายการหรือ Dashboard ที่ระบุ');
  if (op.op === 'cancel') return denied('cancel_not_applicable', 'Dashboard นี้สร้างแล้ว หากยังไม่ได้แชร์ คุณสามารถลบ Dashboard ได้');
  if (!actor.permissions.includes('sales.read')) return denied('permission_denied', 'บัญชีนี้ยังไม่มีสิทธิ์ทำรายการนี้ จึงไม่ได้ดำเนินการ');
  // Shared dashboards are never edited silently: a confirm-tier proposal bound to the base revision (CAS at confirm).
  const stageShared = async (stagedActionId: 'dashboard.refine' | 'dashboard.rename', canonical: unknown, preview: string, data: Record<string, unknown>, doneText: string): Promise<ActionExecResult> => {
    const key = digest({ actionId: stagedActionId, actorId: actor.id, canonical });
    const turn: TurnRef = { conversationId: input.conversationId, turnId: input.turnId ?? 'turn' };
    try {
      const existing = await ports.staged.findPending(actor, input.conversationId, key);
      const proposal: StagedProposal = existing ?? await ports.staged.create(actor, turn, { actionId: stagedActionId, digest: key, preview,
        data: { ...data, ...(dashboard.revision ? { baseRevision: dashboard.revision } : {}) }, expiresAt: input.now().getTime() + STAGED_TTL_MS });
      return { outcome: 'proposed', actionId: ACTION_ID, labels: [], ids: { dashboardId: id, pendingActionId: proposal.id }, preview: proposal.preview,
        deduped: !!existing, expiresAt: proposal.expiresAt,
        text: `${existing ? 'มีรายการเดียวกันรออยู่แล้ว — ' : 'เตรียมรายการแล้ว '}ยังไม่ได้ดำเนินการ — Dashboard นี้ถูกแชร์ให้ผู้อื่น โปรดตรวจตัวอย่างและยืนยัน${doneText}` };
    } catch (error) {
      if (stagedUnavailable(error)) return denied('staged_unavailable', 'รายการประเภทนี้ยังไม่เปิดให้ใช้งานในระบบนี้ จึงยังไม่ได้เตรียมรายการ');
      throw error;
    }
  };
  const hasCode = (error: unknown, code: string): boolean => !!error && typeof error === 'object' && 'code' in error && (error as { code: unknown }).code === code;
  const changed = (): ActionExecResult => ({ outcome: 'clarify', actionId: ACTION_ID, code: 'dashboard_changed', slot: 'dashboard', labels: [], text: 'Dashboard ถูกแก้ไขไปแล้ว กรุณาลองใหม่' });

  if (visualization) {
    if (removeIndexes?.length) return denied('operation_conflict', 'โปรดทำทีละอย่าง — เพิ่มแผนภาพหรือเอาส่วนใดออก');
    if (!dashboard.spec || !ports.updateDashboardSpec) return denied('visualization_unavailable', VIZ_UNAVAILABLE);
    const bound = await bindVisualization(input, dashboard.spec, mode);
    if (!bound.ok) return bound.result;
    const added = bound.widgets.length, label = mode === 'append' ? `เพิ่ม ${added} Widget` : `เปลี่ยน Widget ทั้งหมดเป็น ${added} รายการ`;
    const finalSpec = title === undefined ? bound.spec : { ...bound.spec, title };
    const stageRefine = () => stageShared('dashboard.refine', { dashboardId: id, spec: finalSpec },
      `${label}ใน Dashboard ที่แชร์แล้ว “${dashboard.title}” (ผู้ที่ได้รับแชร์จะเห็นการเปลี่ยนแปลงหลังยืนยัน)`,
      { params: { dashboardId: id }, title: dashboard.title, spec: finalSpec }, '');
    if (!dashboard.shared) {
      // Private + owner-only: applied directly. Sharing and the base revision are re-checked INSIDE the write transaction.
      try {
        const updated = await ports.updateDashboardSpec(actor, id, finalSpec, { ...(dashboard.revision ? { expectedRevision: dashboard.revision } : {}) });
        await ports.audit?.(actor, { kind: 'router_direct_refine', detail: 'ปรับ Widget  Dashboard ส่วนตัว', refId: id });
        return { outcome: 'updated', actionId: ACTION_ID, labels: [], ids: { dashboardId: id }, undo: null,
          text: `${label}ใน Dashboard “${updated.title}” แล้ว — ค่าทุกตัวมาจากหลักฐานที่ตรวจแล้ว` };
      } catch (error) {
        if (hasCode(error, DASHBOARD_SHARED_CODE)) return stageRefine(); // a share appeared between the check and the write
        if (hasCode(error, DASHBOARD_CHANGED_CODE)) return changed();
        if (hasCode(error, 'WIDGET_SCOPE_MISMATCH')) return denied('widget_scope_mismatch', (error as { message: string }).message);
        throw error;
      }
    }
    return stageRefine();
  }
  if (removeIndexes?.length) return denied('saved_dashboard_widgets_unsupported', 'ยังลบ Widget ผ่านแชตไม่ได้ ให้ลบจากหน้า Dashboard โดยตรง หรือขอเพิ่ม Widget หรือเปลี่ยนชุด Widget ทั้งหมดในแชตได้');
  if (title === undefined) return { outcome: 'clarify', actionId: ACTION_ID, code: 'missing_param', slot: 'title', labels: [], text: 'โปรดระบุชื่อใหม่ของ Dashboard' };
  const stageRename = () => stageShared('dashboard.rename', { dashboardId: id, title },
    `เปลี่ยนชื่อ Dashboard ที่แชร์แล้ว “${dashboard.title}” เป็น “${title}” (ผู้ที่ได้รับแชร์จะเห็นชื่อใหม่หลังยืนยัน)`,
    { params: { dashboardId: id, title }, title: dashboard.title }, '');
  if (dashboard.shared) return stageRename();
  try {
    const updated = await ports.renameDashboard(actor, id, { title }, { ...(dashboard.revision ? { expectedRevision: dashboard.revision } : {}) });
    await ports.audit?.(actor, { kind: 'router_direct_rename', detail: 'เปลี่ยนชื่อ Dashboard ส่วนตัว', refId: id });
    return { outcome: 'updated', actionId: ACTION_ID, labels: [], ids: { dashboardId: id }, text: `เปลี่ยนชื่อ Dashboard เป็น “${updated.title}” แล้ว`,
      undo: { kind: 'rename_dashboard', dashboardId: id, title: dashboard.title } };
  } catch (error) {
    if (hasCode(error, DASHBOARD_SHARED_CODE)) return stageRename();
    if (hasCode(error, DASHBOARD_CHANGED_CODE)) return changed();
    throw error;
  }
}
