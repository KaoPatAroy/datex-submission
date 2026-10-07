import type { ActionKind, Actor, ConversationMessage, PendingAction, ReceiptView, Role, Scope } from '@/lib/contracts';

export function messageTextWithLinkedReceiptOutcome(message: ConversationMessage, actions: PendingAction[], receipts: ReceiptView[]): string {
  if (message.role !== 'assistant') return message.text;
  const actionIds = [...new Set([...(message.pendingActionIds ?? []), ...(message.pendingActionId ? [message.pendingActionId] : [])])];
  if (actionIds.length !== 1) return message.text;
  const action = actions.find(item => item.id === actionIds[0] && item.actorId === message.actorId);
  // Historical messages outlive their login session; a full exact receipt supplies the server-validated action kind.
  const linked = [...new Map(receipts.filter(receipt => receipt.visibility !== 'restricted' && receipt.actorId === message.actorId
    && (!action || receipt.kind === action.payload.kind) && receipt.actionId === actionIds[0]
    && (!message.receiptId || message.receiptId === receipt.id)).map(receipt => [receipt.id, receipt])).values()];
  if (linked.length !== 1) return message.text;
  const outcomeLabels: Partial<Record<ReceiptView['status'], string>> = { verified_success: 'สำเร็จแล้ว', failed: 'ไม่สำเร็จ', denied: 'ถูกปฏิเสธ' };
  const outcome = outcomeLabels[linked[0].status];
  if (!outcome) return message.text;
  return `สถานะล่าสุด: ${outcome}\nข้อความเมื่อเตรียมรายการ:\n${message.text}`;
}

export const roleName = (role: Role) => ({ executive: 'ผู้บริหาร', east_manager: 'ผู้จัดการภาคตะวันออก', hr_admin: 'ผู้ดูแลฝ่ายบุคคล', hr_director: 'ผู้อำนวยการฝ่ายบุคคล' })[role];
export const regionName = (region: string) => ({ all: 'ทุกภูมิภาค', east: 'ภาคตะวันออก', central: 'ภาคกลาง', south: 'ภาคใต้' } as Record<string, string>)[region] ?? region;
export const actionName = (kind: ActionKind) => ({ dashboard_create: 'สร้าง Dashboard', dashboard_share: 'แชร์ Dashboard', ticket_create: 'สร้าง Ticket ติดตามสาขา', badge_revoke: 'เพิกถอนบัตรพนักงาน', demo_update: 'เปลี่ยนข้อมูลตัวอย่าง' })[kind];
export const actorScope = (actor: Actor) => actor.regions.map(regionName).join(' · ');
export const scopeName = (scope: Scope) => `${regionName(scope.region)} · ${scope.date}${scope.branchIds?.length ? ` · ${scope.branchIds.length} สาขา` : ' · สาขาที่ได้รับอนุญาต'}`;
export function displayPerson(name: string) {
  return ({ 'Demo Executive': 'ผู้บริหารสาธิต', 'Demo East Manager': 'ผู้จัดการภาคตะวันออกสาธิต', 'Demo HR Admin': 'ผู้ดูแลฝ่ายบุคคลสาธิต', 'Demo HR Administrator': 'ผู้ดูแลฝ่ายบุคคลสาธิต', 'Demo HR Director': 'ผู้อำนวยการฝ่ายบุคคลสาธิต' } as Record<string, string>)[name] ?? name;
}
/** Neutral fallback title: the first message with collapsed whitespace, truncated by grapheme. No keyword inspection or intent inference; the AI-authored title (server-validated) replaces it. */
export function conciseTitle(prompt: string) {
  const clean = prompt.replace(/\s+/g, ' ').trim();
  const graphemes = [...new Intl.Segmenter('th', { granularity: 'grapheme' }).segment(clean)].map(item => item.segment);
  return graphemes.length > 36 ? `${graphemes.slice(0, 35).join('')}…` : clean || 'บทสนทนาใหม่';
}
export type LifecycleAction = PendingAction & { predecessorActionId?: string; supersededByActionId?: string; staleReason?: 'superseded' | 'user_cancelled' | 'expired' | 'mode_changed' | 'release_changed' | 'evidence_changed' | 'source_turn_failed' | 'source_turn_cancelled'; revisionDiff?: string[] };
export function actionState(action: PendingAction, now: number) {
  if (action.status === 'completed') return { key: 'completed', label: 'ดำเนินการแล้ว', tone: 'badge-success' };
  if (action.status === 'claimed') return { key: 'claimed', label: 'กำลังดำเนินการ', tone: 'badge-info' };
  if (action.status === 'stale') {
    const reason = (action as LifecycleAction).staleReason;
    if (reason === 'superseded') return { key: 'superseded', label: 'ถูกแทนที่', tone: 'badge-muted' };
    if (reason === 'user_cancelled') return { key: 'cancelled', label: 'ยกเลิกแล้ว', tone: 'badge-muted' };
    if (reason === 'expired') return { key: 'expired', label: 'หมดอายุ', tone: 'badge-muted' };
    if (reason === 'source_turn_failed') return { key: 'failed', label: 'เตรียมไม่สำเร็จ', tone: 'badge-danger' };
    if (reason === 'source_turn_cancelled') return { key: 'cancelled', label: 'คำขอต้นทางถูกยกเลิก', tone: 'badge-muted' };
    return { key: 'stale', label: 'ข้อมูลหรือโหมดเปลี่ยน', tone: 'badge-muted' };
  }
  const expiry = Date.parse(action.expiresAt);
  if (!Number.isFinite(expiry)) return { key: 'invalid', label: 'ตรวจวันหมดอายุไม่ได้', tone: 'badge-warning' };
  if (now > 0 && expiry <= now) return { key: 'expired', label: 'หมดอายุ', tone: 'badge-muted' };
  return { key: 'pending', label: 'รอตรวจและยืนยัน', tone: 'badge-warning' };
}
export function retryActionPrompt(action: PendingAction) {
  const payload = action.payload;
  if (payload.kind === 'dashboard_create') return `ช่วยเตรียมข้อเสนอสร้าง Dashboard ใหม่ เรื่อง ${payload.spec.title} ขอบเขต ${scopeName(payload.spec.scope)} โดยตรวจข้อมูลปัจจุบันและถามข้อมูลที่ยังขาดก่อนเสนอให้ยืนยัน`;
  if (payload.kind === 'dashboard_share') return `ช่วยตรวจข้อมูลปัจจุบันและเตรียมข้อเสนอแชร์ Dashboard ${payload.dashboardId} ให้ ${payload.recipientId} ใหม่ โดยตรวจสิทธิ์และขอบเขตก่อนเสนอให้ยืนยัน`;
  if (payload.kind === 'ticket_create') return `ช่วยเตรียม Ticket ติดตามสาขา ใหม่ ขอบเขต ${scopeName(payload.scope)} โดยถามสาขาและข้อมูลที่ยังจำเป็น และตรวจผู้รับผิดชอบที่มีสิทธิ์ก่อนเสนอให้ยืนยัน`;
  if (payload.kind === 'badge_revoke') return `ช่วยตรวจข้อมูลปัจจุบันและเตรียมข้อเสนอเพิกถอนบัตร ${payload.badgeId} ของพนักงาน ${payload.employeeId} ใหม่ เหตุผล ${payload.reason} โดยให้ฉันตรวจสอบก่อนยืนยัน`;
  return 'ช่วยตรวจสถานการณ์ข้อมูลตัวอย่างปัจจุบันก่อนเตรียมข้อเสนอเปลี่ยนข้อมูลใหม่';
}

export type DemoScenarioId = 'stock_recovered' | 'payment_resolved' | 'baseline';
/** Display names for the finite demo scenario ids (ids themselves are unchanged). */
export const demoScenarioLabel: Record<DemoScenarioId, string> = {
  stock_recovered: 'จำลองว่าสต็อกเพียงพอ',
  payment_resolved: 'จำลองว่าปิด Incident ทั้งหมดแล้ว',
  baseline: 'รีเซ็ตสต็อกและ Incident ของ Demo',
};
/** What each scenario writes to the seeded Demo business date (stock and Incident snapshots). */
export const demoScenarioImpact: Record<DemoScenarioId, string> = {
  stock_recovered: 'หลังยืนยัน ระบบจะคืนข้อมูลสต็อกและ Incident ของชุด Demo สำหรับวันข้อมูลนี้เป็นค่าตั้งต้น แล้วปรับสต็อกให้สูงกว่าระดับขั้นต่ำ',
  payment_resolved: 'หลังยืนยัน ระบบจะปิด Incident ทุกประเภทของชุด Demo สำหรับวันข้อมูลนี้ และคืนข้อมูลสต็อกเป็นค่าตั้งต้น',
  baseline: 'หลังยืนยัน ระบบจะคืนข้อมูลสต็อกและ Incident ของชุด Demo สำหรับวันข้อมูลนี้เป็นค่าตั้งต้น',
};

/** Finite display map for artifact fact operation codes (codes stay unchanged in stored artifacts and exports). */
const OPERATION_LABELS: Record<string, string> = {
  value: 'ค่ารายการนี้', sum: 'ผลรวม', avg: 'ค่าเฉลี่ย', latest: 'ค่าจากช่วงเวลาล่าสุด', max: 'ค่าสูงสุด', gap: 'ส่วนต่างจากเป้าหมาย',
  weighted_ratio: 'สัดส่วนจากยอดรวม', difference: 'ผลต่าง', rank: 'อันดับ',
};
export const operationLabel = (operation: string) => OPERATION_LABELS[operation] ?? operation;
