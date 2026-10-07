import type { ActionCatalogEntry, ActionCatalogStatus, Actor, Scope } from '../contracts';

export const ACTION_CATALOG_BADGE_REASON_PLACEHOLDER = '[กรุณาระบุเหตุผลของคุณ]';

export interface WorkspaceActionCatalogInput {
  actor: Pick<Actor, 'role'>;
  scope?: Scope;
  salesAnalysisAvailable: boolean;
  dashboardCreateAvailable: boolean;
  ticketCreateAvailable?: boolean;
  dashboardShareAvailable?: boolean;
  employeeIds: string[];
  badgeTargets: Array<{ badgeId: string; employeeId: string }>;
  authorizedFlowCount: number;
  dataUnavailable: boolean;
  targetUnavailable: boolean;
  /**
   * HR Director (Workflow V2): the projection's own runtime grant for this actor. Onboarding reads/decisions are not pack tools,
   * so the Director's entries come from this grant (never from a role list); absent or empty grant = no entries.
   */
  director?: { reads: readonly string[]; decisions: readonly string[] };
}

/** Director entries the catalog can offer, each keyed by the V2 grant item that makes it work. */
export const DIRECTOR_CATALOG_ENTRY_IDS = { queue: 'workflow.director-queue', approvalsToday: 'workflow.director-approvals-today', approve: 'workflow.director-approve' } as const;
/** The approve entry's prompt doubles as the quoted evidence for its `all_reviewed` selection. */
export const DIRECTOR_APPROVE_REVIEWED_PROMPT = 'อนุมัติทุกรายการที่ฉันเพิ่งตรวจ';

function directorEntries(grant: WorkspaceActionCatalogInput['director']): ActionCatalogEntry[] {
  if (!grant) return [];
  const entries: ActionCatalogEntry[] = [];
  if (grant.reads.includes('director_queue')) entries.push({
    id: DIRECTOR_CATALOG_ENTRY_IDS.queue, section: 'ask_analyze', title: 'คำขอ Onboarding ที่รอฉันอนุมัติ',
    description: 'อ่านคิวคำขอและเอกสารที่ผ่านการอนุมัติจากผู้จัดการแล้ว โดยไม่เปลี่ยนสถานะ', prompt: 'ดูคำขอ Onboarding ที่รอฉันอนุมัติ', consequence: 'read',
  });
  if (grant.reads.includes('director_approvals_today')) entries.push({
    id: DIRECTOR_CATALOG_ENTRY_IDS.approvalsToday, section: 'ask_analyze', title: 'รายการที่ฉันอนุมัติวันนี้',
    description: 'ดูคำขอ Onboarding ที่คุณอนุมัติแล้ววันนี้ พร้อมผลที่ตรวจสอบจากระบบ', prompt: 'วันนี้ฉันอนุมัติคำขอ Onboarding ไปแล้วกี่รายการ', consequence: 'read',
  });
  // Approval acts only on a queue the Director has already reviewed in this conversation; without one the turn fails closed.
  if (grant.decisions.includes('onboarding_director_approve') && grant.reads.includes('director_queue')) entries.push({
    id: DIRECTOR_CATALOG_ENTRY_IDS.approve, section: 'prepare_review', title: 'อนุมัติรายการที่เพิ่งตรวจ',
    description: 'หลังดูคิวคำขอแล้ว เตรียมอนุมัติเฉพาะรายการในคิวที่ตรวจ ตรวจรายละเอียดและยืนยันก่อนดำเนินการ', prompt: DIRECTOR_APPROVE_REVIEWED_PROMPT, consequence: 'review_required',
  });
  return entries;
}

const regionLabels: Record<string, string> = {
  east: 'ภาคตะวันออก',
  central: 'ภาคกลาง',
  south: 'ภาคใต้',
};

export function buildWorkspaceActionCatalog(input: WorkspaceActionCatalogInput): {
  entries: ActionCatalogEntry[];
  status: ActionCatalogStatus;
} {
  const entries: ActionCatalogEntry[] = [];
  let truncatedTargets = false;

  if (input.scope && input.salesAnalysisAvailable) {
    const allRegions = input.scope.region.toLowerCase() === 'all';
    const region = allRegions ? 'ทุกภูมิภาคที่คุณมีสิทธิ์' : regionLabels[input.scope.region.toLowerCase()] ?? input.scope.region;
    const inRegion = `ใน${region}`;
    entries.push({
      id: 'retail.sales-analysis',
      section: 'ask_analyze',
      title: `ภาพรวมยอดขาย${region}`,
      description: `วิเคราะห์ภาพรวมยอดขายและเป้าหมาย${inRegion} ณ วันที่ ${input.scope.date}`,
      prompt: `วิเคราะห์ภาพรวมยอดขายและเป้าหมาย${inRegion}`,
      consequence: 'analyze',
    });
    entries.push({
      id: 'retail.sales-below-target',
      section: 'ask_analyze',
      title: `ส่วนต่างยอดขายเทียบเป้า${region}`,
      description: `ตรวจยอดขายเทียบกับเป้าหมาย${inRegion} พร้อมส่วนต่างจากเป้า`,
      prompt: `วิเคราะห์ยอดขายที่ต่ำกว่าเป้าหมาย${inRegion} พร้อมส่วนต่างจากเป้า`,
      consequence: 'analyze',
    });
    entries.push({
      id: 'retail.sales-achievement',
      section: 'ask_analyze',
      title: `สัดส่วนยอดขายเทียบเป้า${region}`,
      description: `คำนวณสัดส่วนยอดขายรวมเทียบเป้าหมายรวม${inRegion}`,
      prompt: `ยอดขายรวมทำได้กี่เปอร์เซ็นต์ของเป้า${inRegion}`,
      consequence: 'analyze',
    });
  }

  if (input.dashboardCreateAvailable) {
    entries.push({
      id: 'retail.dashboard-create',
      section: 'prepare_review',
      title: 'สร้าง Dashboard',
      description: 'สร้าง Dashboard ส่วนตัวจากข้อมูลที่ตรวจสอบได้ เป็นของคุณคนเดียว และลบได้ภายหลัง',
      prompt: 'ช่วยสร้าง Dashboard จากข้อมูลล่าสุด',
      consequence: 'review_required',
      actionKind: 'dashboard_create',
    });
  }

  if (input.ticketCreateAvailable) {
    entries.push({
      id: 'ops.ticket-create',
      section: 'prepare_review',
      title: 'สร้าง Ticket ติดตามสาขา',
      description: 'เตรียมงานติดตามให้ผู้รับผิดชอบของสาขา ตรวจและยืนยันก่อนส่งงาน',
      prompt: 'ช่วยเตรียมงานติดตามสำหรับสาขาที่ยอดขายต่ำกว่าเป้าในขอบเขตของฉัน',
      consequence: 'review_required',
      actionKind: 'ticket_create',
    });
  }

  if (input.dashboardShareAvailable) {
    entries.push({
      id: 'retail.dashboard-share',
      section: 'prepare_review',
      title: 'แชร์ Dashboard',
      description: 'เตรียมการแชร์ Dashboard ของคุณให้ผู้ร่วมงาน ตรวจและยืนยันก่อนส่ง',
      prompt: 'ช่วยเตรียมแชร์ Dashboard ล่าสุดของฉันให้ผู้ร่วมงาน',
      consequence: 'review_required',
      actionKind: 'dashboard_share',
    });
  }

  const employeeIds = [...new Set(input.employeeIds)].sort().slice(0, 2);
  truncatedTargets ||= new Set(input.employeeIds).size > employeeIds.length;
  for (const employeeId of employeeIds) {
    entries.push({
      id: `hr.employee-search.${employeeId}`,
      section: 'ask_analyze',
      title: `ค้นหาระเบียนพนักงาน ${employeeId}`,
      description: 'อ่านระเบียนพนักงานที่มีสิทธิ์ดู โดยไม่เปลี่ยนสถานะ',
      prompt: `ค้นหาพนักงาน ${employeeId}`,
      consequence: 'read',
    });
  }

  const badgeTargets = [...new Map(input.badgeTargets.map(target => [target.badgeId, target])).values()]
    .sort((left, right) => left.badgeId.localeCompare(right.badgeId))
    .slice(0, 2);
  truncatedTargets ||= new Set(input.badgeTargets.map(target => target.badgeId)).size > badgeTargets.length;
  for (const target of badgeTargets) {
    entries.push({
      id: `hr.badge-revoke.${target.badgeId}`,
      section: 'prepare_review',
      title: `เพิกถอนบัตรพนักงาน ${target.badgeId}`,
      description: `เตรียมข้อเสนอสำหรับ ${target.employeeId}; โปรดแทนที่ข้อความในวงเล็บด้วยเหตุผลจริงของคุณ`,
      prompt: `เตรียมเพิกถอนบัตรพนักงาน ${target.badgeId} ของ ${target.employeeId} เนื่องจาก ${ACTION_CATALOG_BADGE_REASON_PLACEHOLDER}`,
      consequence: 'review_required',
      actionKind: 'badge_revoke',
    });
  }

  const director = directorEntries(input.director);
  entries.push(...director);

  const status: ActionCatalogStatus = input.dataUnavailable
    ? 'data_unavailable'
    : entries.length > 0
      ? input.targetUnavailable || truncatedTargets ? 'limited' : 'ready'
      : input.authorizedFlowCount + director.length === 0 ? 'no_authorized_flows' : 'no_current_targets';
  return { entries, status };
}
