import type { Role } from '../contracts';
import { demoShowcasePlan } from '../router/demo-plans';
import type { TurnPlan } from '../router/turn-plan';

export { showcaseIdPattern } from './ids';

/** Server-authored demo cards; the client submits only the selected id. */
export type ShowcaseItem = {
  id: string;
  role: Role;
  title: string;
  description: string;
  prompt: string;
  kind: 'answer' | 'action' | 'denial' | 'scenario';
  expectedCapability: string;
  plan: TurnPlan;
};

// Showcase prompts are deliberately bound to the seeded 1 October 2026 data snapshot.
const showcaseCards: Omit<ShowcaseItem, 'plan'>[] = [
  { id: 'executive-overview', role: 'executive', title: 'ภาพรวมยอดขายทุกภูมิภาค', description: 'ดูยอดขายทุกภูมิภาคพร้อมแหล่งข้อมูลอ้างอิง', prompt: 'ภาพรวมยอดขายทุกภูมิภาค วันที่ 1 ตุลาคม 2569', kind: 'answer', expectedCapability: 'sales.query_metrics' },
  { id: 'executive-e01', role: 'executive', title: 'ยอดขายสาขา E01', description: 'เจาะสาขาเดียวพร้อมตัวเลขและแหล่งข้อมูล', prompt: 'ยอดขายสาขา E01', kind: 'answer', expectedCapability: 'sales.query_metrics' },
  { id: 'executive-ranking', role: 'executive', title: 'จัดอันดับ 3 สาขาที่ต่ำกว่าเป้า', description: 'จัดอันดับตามส่วนต่างจากเป้า จากหลักฐานครบทุกภูมิภาค', prompt: 'จัดอันดับ 3 สาขาที่ต่ำกว่าเป้าหมายมากที่สุดในวันที่ 1 ตุลาคม 2569', kind: 'answer', expectedCapability: 'sales.query_metrics' },
  { id: 'executive-dashboard', role: 'executive', title: 'สร้าง Dashboard ยอดขาย', description: 'เตรียม Dashboard ทุกภูมิภาคที่คุณมีสิทธิ์ แล้วตรวจรายละเอียดและยืนยันก่อนบันทึก', prompt: 'สร้าง Dashboard ยอดขาย', kind: 'action', expectedCapability: 'dashboard.prepare_create' },
  { id: 'executive-share', role: 'executive', title: 'แชร์ Dashboard ให้ผู้จัดการภาคตะวันออก', description: 'สร้างและยืนยัน Dashboard ก่อน แล้วตรวจผู้รับและสิทธิ์ก่อนแชร์', prompt: 'แชร์ Dashboard ให้ผู้จัดการภาคตะวันออก', kind: 'action', expectedCapability: 'dashboard.prepare_share' },
  { id: 'stock_recovered', role: 'executive', title: 'จำลองว่าสต็อกเพียงพอ', description: 'ดูข้อมูลยอดขายทุกภูมิภาค แล้วเปิดตัวเลือกปรับข้อมูลสต็อกตัวอย่างเพื่อตรวจและยืนยัน', prompt: 'ดูข้อมูลยอดขายทุกภูมิภาคก่อนจำลองว่าสต็อกเพียงพอ', kind: 'scenario', expectedCapability: 'demo.update' },
  { id: 'east-overview', role: 'east_manager', title: 'ภาพรวมยอดขายภาคตะวันออก', description: 'วิเคราะห์เฉพาะภูมิภาคที่บัญชีมีสิทธิ์อ่าน', prompt: 'ภาพรวมยอดขายภาคตะวันออก', kind: 'answer', expectedCapability: 'sales.query_metrics' },
  { id: 'east-ticket', role: 'east_manager', title: 'เปิด Ticket ติดตามสาขา E02', description: 'เตรียม Ticket จากข้อมูลอ้างอิง: ตรวจรายละเอียด → ยืนยัน → ตรวจผลการดำเนินการ', prompt: 'เปิด Ticket ติดตามสาขา E02', kind: 'action', expectedCapability: 'ticket.prepare_create' },
  { id: 'east-denial', role: 'east_manager', title: 'ขอดูยอดขายภาคใต้', description: 'ดูข้อความแจ้งเมื่อขอข้อมูลที่บัญชีนี้ไม่มีสิทธิ์อ่าน', prompt: 'ขอดูยอดขายภาคใต้', kind: 'denial', expectedCapability: 'sales.query_metrics' },
  { id: 'hr-employee', role: 'hr_admin', title: 'ค้นหาพนักงาน E024', description: 'ดูข้อมูลพนักงานตัวอย่างและบัตรพนักงานที่เกี่ยวข้อง', prompt: 'ค้นหาพนักงาน E024', kind: 'answer', expectedCapability: 'hr.find_employee' },
  { id: 'hr-badge', role: 'hr_admin', title: 'เพิกถอนบัตร C102 ของ E024', description: 'เพิกถอนบัตรพนักงานจำลองพร้อมเหตุผล: ตรวจรายละเอียด → ยืนยัน → ตรวจผลการดำเนินการ', prompt: 'เพิกถอนบัตร C102 ของ E024 เนื่องจากพ้นสภาพพนักงาน', kind: 'action', expectedCapability: 'badge.prepare_revoke' },
  // HR Director (Workflow V2): queue -> approve exactly what was reviewed -> separate simulated Email. Needs the Workflow V2 server.
  { id: 'director-queue', role: 'hr_director', title: 'คำขอ Onboarding ที่รอฉันอนุมัติ', description: 'อ่านคิวและเอกสารที่ผ่านการอนุมัติจากผู้จัดการแล้ว พร้อมบันทึกรายการที่ตรวจ', prompt: 'ดูคำขอ Onboarding ที่รอฉันอนุมัติ', kind: 'answer', expectedCapability: 'workflow.director_queue' },
  { id: 'director-start-dates', role: 'hr_director', title: 'เรียงตามวันเริ่มงาน', description: 'ดูวันเริ่มงานของรายการที่เพิ่งตรวจ', prompt: 'เรียงรายการที่เพิ่งตรวจตามวันเริ่มงาน', kind: 'answer', expectedCapability: 'workflow.director_start_dates' },
  { id: 'director-approve-reviewed', role: 'hr_director', title: 'อนุมัติทุกรายการที่เพิ่งตรวจ', description: 'ตรวจรายละเอียด → ยืนยัน → ตรวจผลการดำเนินการ เฉพาะรายการในคิวที่เพิ่งตรวจ ไม่รวมรายการที่เข้ามาภายหลัง', prompt: 'อนุมัติทุกรายการที่ฉันเพิ่งตรวจ', kind: 'action', expectedCapability: 'onboarding.director_approve' },
  { id: 'director-email', role: 'hr_director', title: 'ส่ง Email จำลองแจ้งผลการอนุมัติ', description: 'ส่ง Email จำลองเป็นขั้นตอนแยก หลังอนุมัติและตรวจผลแล้ว: ตรวจรายละเอียด → ยืนยัน → ตรวจผลการส่ง', prompt: 'ส่ง Email จำลองแจ้งผลการอนุมัติ', kind: 'action', expectedCapability: 'onboarding.notify_email' },
];

export const showcase: readonly ShowcaseItem[] = showcaseCards.map(card => ({
  ...card,
  plan: demoShowcasePlan(card.id, card.prompt),
}));

export function roleShowcase(role: Role): readonly ShowcaseItem[] {
  return showcase.filter(item => item.role === role);
}

/** Resolve a prepared showcase for the signed-in role by card id. */
export function showcaseById(role: Role, id: string | undefined): ShowcaseItem | undefined {
  return id === undefined ? undefined : roleShowcase(role).find(item => item.id === id);
}

export const unsupportedDemoHeading = 'นี่คือโหมดสาธิต ซึ่งตอบด้วยข้อมูลตัวอย่างตามชุดคำถามที่เตรียมไว้';
export function unsupportedDemoReply(role: Role = 'executive'): string {
  return `${unsupportedDemoHeading}\nเลือกตัวอย่างของบัญชีนี้จากปุ่มด้านล่าง: ${roleShowcase(role).map(item => item.title).join(' / ')}\nหากต้องการพิมพ์คำถามเอง ให้สลับเป็น Live AI โหมดสาธิตใช้ข้อมูลตัวอย่าง และรายการที่เปลี่ยนข้อมูลต้องตรวจรายละเอียดและยืนยันก่อน`;
}
