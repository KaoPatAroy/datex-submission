/**
 * Server-owned Thai copy of every registered action (what the capability text, the "I understood you want to ..." prefix and the
 * next-step suggestions say). The registry id is the key; `tests/parity/capability-parity.test.ts` fails when a registered action has
 * no entry here, so an action cannot be added without its copy and nothing is advertised for an unregistered id. What is OFFERED to an
 * actor is always derived at request time from the actions that actor currently holds (context.actions), never from this table.
 */
export interface ActionCopy { capability: string; intent: string; suggestion?: string }

export const ACTION_COPY: Readonly<Record<string, ActionCopy>> = Object.freeze({
  'dashboard.create': { capability: 'เตรียม Dashboard', intent: 'สร้าง Dashboard', suggestion: 'สร้าง Dashboard ยอดขายของฉัน' },
  'dashboard.share': { capability: 'เตรียมการแชร์ Dashboard', intent: 'แชร์ Dashboard' },
  'dashboard.revoke_share': { capability: 'เตรียมเพิกถอนการแชร์ Dashboard', intent: 'เพิกถอนการแชร์ Dashboard' },
  'ticket.create': { capability: 'เตรียม Ticket สำหรับสาขา', intent: 'เปิด Ticket ติดตามสาขา', suggestion: 'เปิด Ticket ติดตามสาขา ที่ยอดขายต่ำกว่าเป้า' },
  'badge.revoke': { capability: 'เตรียมคำขอเพิกถอนบัตร', intent: 'เพิกถอนบัตรพนักงาน', suggestion: 'เพิกถอนบัตรพนักงานพร้อมระบุเหตุผล' },
  'communication.send': { capability: 'เตรียมข้อความในกล่องข้อความจำลอง', intent: 'ส่งสรุปเข้ากล่องข้อความ' },
  'monitor.create': { capability: 'เตรียม Monitor ผลลัพธ์', intent: 'ตั้งการแจ้งเตือน' },
  'monitor.manage': { capability: 'พัก เปลี่ยนชื่อ หรือลบ Monitor ของคุณ', intent: 'จัดการ Monitor' },
  'result.manage': { capability: 'เปลี่ยนชื่อ ปักหมุด เก็บถาวร หรือบันทึกผลลัพธ์ของคุณ', intent: 'จัดการผลลัพธ์' },
  'result.unarchive': { capability: 'นำผลลัพธ์ที่เก็บถาวรกลับมา', intent: 'นำผลลัพธ์กลับมา' },
  'dashboard.rename': { capability: 'เปลี่ยนชื่อ Dashboard ของคุณ', intent: 'เปลี่ยนชื่อ Dashboard' },
  'artifact.share': { capability: 'เตรียมการแชร์ผลลัพธ์แบบอ่านอย่างเดียว', intent: 'แชร์ผลลัพธ์' },
  'policy.acknowledge': { capability: 'เตรียมการรับทราบ Policy ตามเวอร์ชัน', intent: 'รับทราบ Policy', suggestion: 'รับทราบ Policy ล่าสุดที่ฉันอ่านได้' },
  'task.create': { capability: 'เตรียมงานติดตามพร้อมผู้รับผิดชอบ', intent: 'สร้างงานติดตาม' },
  'dashboard.delete': { capability: 'เตรียมลบ Dashboard ของคุณ', intent: 'ลบ Dashboard' },
  'onboarding.director_approve': { capability: 'เตรียมอนุมัติคำขอ Onboarding ในคิวที่ตรวจแล้ว', intent: 'อนุมัติคำขอ Onboarding' },
  'onboarding.return': { capability: 'เตรียมส่งคำขอ Onboarding กลับไปแก้ไข', intent: 'ส่งคำขอ Onboarding กลับไปแก้ไข' },
  'onboarding.notify_email': { capability: 'เตรียม Email จำลองแจ้งผลการอนุมัติ', intent: 'ส่ง Email แจ้งผลการอนุมัติ' },
  'dashboard.manage': { capability: 'ปักหมุด เก็บถาวร นำกลับมา หรือทำสำเนา Dashboard ของคุณ', intent: 'จัดระเบียบ Dashboard' },
});
export const GENERIC_ACTION_CAPABILITY = 'ดำเนินการที่ลงทะเบียนไว้';
