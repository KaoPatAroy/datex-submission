import type { PlannerContext } from './planner-context';

/**
 * PRODUCT MODEL v1: the server-owned, versioned, bounded manifest of what DaTex IS (static concept semantics only).
 *
 * Three things stay separate:
 *  A. PRODUCT_MODEL (this constant): identity, concepts, relationships, freshness, lifecycle, confirmation and the AI/server
 *     boundary. It holds NO dynamic facts: no ids, recipients, pending actions, numbers, datasets, action ids or role permissions.
 *  B. Current account capability (`accountCapability`): derived per turn from the runtime planner context (the actor's authorized
 *     catalog, the registered actions the runtime grants, the Workflow V2 projection). Never a hardcoded per-role list.
 *  C. The current conversation: the bounded, conversation-scoped excerpt the planner input already carries.
 * This is not memory: nothing here reads other conversations, profiles or chat prose.
 */
export const PRODUCT_MODEL_VERSION = 1 as const;

/** Canonical product concept ids (the only values a product_help step may name). */
export const PRODUCT_CONCEPT_IDS = [
  'chat', 'result', 'dashboard', 'widget', 'action', 'message', 'history', 'monitor', 'task', 'ticket', 'onboarding_request',
] as const;
export type ProductConceptId = typeof PRODUCT_CONCEPT_IDS[number];

export const PRODUCT_MODEL = {
  productModelVersion: PRODUCT_MODEL_VERSION,
  identity: 'AI business concierge: ask, analyze, build, share, act, verify',
  concepts: {
    chat: 'ask, analyze, build, refine, request work',
    result: 'chart/table/ranking/brief/CSV of one verified answer; SNAPSHOT, never silently refreshed; edit = new version',
    dashboard: 'Widgets keep query/scope/visual, not values; re-query permitted data on open/reload; no realtime',
    widget: 'Dashboard visual from the safe registry',
    action: 'registered; shared/irreversible: prepare, preview, confirm, execute, verify, receipt; private reversible may run directly',
    message: 'messages, share notices, Monitor/task alerts; not Results',
    history: 'immutable audit of receipts and lifecycle',
    monitor: 'saved query condition on a registered cadence; authority rechecked each run',
    task: 'Work Item: follow-up with creator and assignee',
    ticket: 'integrated follow-up record',
    onboarding_request: 'HR onboarding item: review, approve, return; no recruitment',
  } satisfies Record<ProductConceptId, string>,
  relationships: 'Result to Dashboard reuses the query binding, not the snapshot. Shares are read-only',
  boundary: 'server alone decides permissions, scope, resources, recipients, action success, evidence, state, numbers',
} as const;

/** Upper bound of the serialized PRODUCT_MODEL planner block (asserted by tests; the planner input fails closed above it). */
export const PRODUCT_MODEL_MAX_BYTES = 1280;

/**
 * Concept -> registered action family. Static binding between product vocabulary and the action REGISTRY (never roles):
 * a concept is usable by an account exactly when the runtime grants it an action of that family. `null` = no action family
 * (availability comes from the catalog / runtime projection instead, see `accountCapability`).
 */
const ACTION_FAMILY: Readonly<Record<ProductConceptId, readonly string[] | null>> = {
  chat: null, result: null, history: null, message: null, action: null,
  dashboard: ['dashboard.'], widget: ['dashboard.'], monitor: ['monitor.'], task: ['task.'], ticket: ['ticket.'], onboarding_request: ['onboarding.'],
};

export interface AccountCapability {
  /** Concepts this account can use now (derived from the runtime context of this turn). */
  available: ProductConceptId[];
  /** Concepts this account cannot use now: the planner never presents them as usable for this account. */
  unavailable: ProductConceptId[];
}

/** Current account capability over the product concepts, derived ONLY from the runtime planner context of this turn. */
export function accountCapability(context: Pick<PlannerContext, 'catalog' | 'actions' | 'workflow'>): AccountCapability {
  const actionIds = context.actions.map(action => action.actionId);
  const hasFamily = (prefixes: readonly string[]) => actionIds.some(id => prefixes.some(prefix => id.startsWith(prefix)));
  const hasData = context.catalog.datasets.length > 0;
  const hasWorkflow = !!context.workflow?.reads.length;
  const usable = (concept: ProductConceptId): boolean => {
    if (concept === 'chat') return hasData || hasWorkflow || actionIds.length > 0;
    if (concept === 'result') return hasData;
    if (concept === 'action') return actionIds.length > 0;
    // Messages and History are per-user surfaces of whatever the account can receive or did; they exist with any usable capability.
    if (concept === 'message' || concept === 'history') return hasData || hasWorkflow || actionIds.length > 0;
    if (concept === 'onboarding_request') return hasWorkflow || hasFamily(ACTION_FAMILY.onboarding_request ?? []);
    return hasFamily(ACTION_FAMILY[concept] ?? []);
  };
  return {
    available: PRODUCT_CONCEPT_IDS.filter(usable),
    unavailable: PRODUCT_CONCEPT_IDS.filter(concept => !usable(concept)),
  };
}

/**
 * Server-owned Thai product copy (static, versioned with PRODUCT_MODEL, no data). The overview names ONLY the concepts this account can use,
 * so a restricted account is never told about an operation it lacks. PRODUCT_OVERVIEW_TEXT is the full-capability rendering.
 */
const OVERVIEW_PART: Readonly<Partial<Record<ProductConceptId, string>>> = {
  chat: 'ถามคำถามใน Chat', result: 'วิเคราะห์และเก็บคำตอบเป็น Results', dashboard: 'สร้าง Dashboard', monitor: 'ตั้ง Monitor ให้ตรวจตามรอบ',
  task: 'มอบหมายและติดตามงานด้วย Task', ticket: 'เตรียม Ticket', onboarding_request: 'ดูแล Onboarding Request ตามสิทธิ์',
  action: 'ดำเนินการ Actions ที่ลงทะเบียนไว้', message: 'รับข้อความและการแจ้งเตือนใน Messages', history: 'ตรวจสอบย้อนหลังได้ใน History',
};
const OVERVIEW_ORDER: readonly ProductConceptId[] = ['chat', 'result', 'dashboard', 'monitor', 'task', 'ticket', 'onboarding_request', 'action', 'message', 'history'];
const OVERVIEW_LEAD = 'DaTex คือผู้ช่วย AI สำหรับข้อมูลธุรกิจภายในสิทธิ์ของคุณ';
function thaiSeries(items: readonly string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(' ')} และ${items[items.length - 1]}`;
}
export function productOverviewText(capability: Pick<AccountCapability, 'available'>): string {
  const parts = OVERVIEW_ORDER.filter(concept => capability.available.includes(concept)).flatMap(concept => OVERVIEW_PART[concept] ?? []);
  return parts.length ? `${OVERVIEW_LEAD}: ${thaiSeries(parts)}` : OVERVIEW_LEAD;
}
export const PRODUCT_OVERVIEW_TEXT = productOverviewText({ available: [...PRODUCT_CONCEPT_IDS] });
export const PRODUCT_CONCEPT_TEXT: Readonly<Record<ProductConceptId, string>> = {
  chat: 'Chat คือที่ถามคำถามเกี่ยวกับข้อมูลธุรกิจ วิเคราะห์ สร้างและปรับ Results หรือ Dashboard และขอให้เตรียมงาน',
  result: 'Result คือผลวิเคราะห์ที่บันทึกไว้ (กราฟ ตาราง การจัดอันดับ สรุปผู้บริหาร หรือ CSV) จากคำตอบที่ตรวจสอบแล้ว ข้อมูลเป็น snapshot ไม่อัปเดตเองโดยไม่บอก การแก้ไขจะสร้างเวอร์ชันใหม่',
  dashboard: 'Dashboard คือพื้นที่ทำงานถาวรที่รวม Widget ไว้ เก็บนิยามคำค้นและขอบเขตข้อมูล แล้วดึงข้อมูลตามสิทธิ์ปัจจุบันใหม่ทุกครั้งที่เปิดหรือรีโหลด ไม่ได้อัปเดตแบบเรียลไทม์',
  widget: 'Widget คือภาพข้อมูลหนึ่งชิ้นบน Dashboard รูปแบบมาจากชุดกราฟที่ระบบรองรับ',
  action: 'Action คือการดำเนินการที่ลงทะเบียนไว้ งานที่แชร์ถึงผู้อื่นหรือย้อนกลับไม่ได้ต้องเตรียม ให้ตรวจ และให้คุณยืนยันก่อนเสมอ แล้วระบบตรวจผลและบันทึกผลการดำเนินการ ส่วนงานส่วนตัวที่ย้อนกลับได้อาจทำได้ทันที',
  message: 'Messages คือที่รับข้อความ การแจ้งเตือนเมื่อมีคนแชร์ Result การแจ้งเตือนจาก Monitor และงานติดตาม ไม่ใช่คลัง Results',
  history: 'History คือบันทึกตรวจสอบที่แก้ไขไม่ได้ ทั้งผลการดำเนินการที่ตรวจแล้วและประวัติการเปลี่ยนสถานะ',
  monitor: 'Monitor คือเงื่อนไขที่บันทึกไว้และตรวจตามรอบที่ระบบกำหนด ทุกรอบตรวจสิทธิ์และสถานะใหม่ และแจ้งเตือนเข้า Messages',
  task: 'Task หรือ Work Item คืองานติดตามที่มีผู้สร้างและผู้รับผิดชอบ',
  ticket: 'Ticket คือรายการติดตามในระบบที่เชื่อมไว้ ไม่ใช่ระบบ ticketing ขององค์กรเต็มรูปแบบ',
  onboarding_request: 'คำขอ Onboarding คือคำขอในขั้นตอน Onboarding ของ HR ตรวจ อนุมัติ หรือส่งกลับไปแก้ได้ตามสิทธิ์',
};
const CONCEPT_NAME: Readonly<Record<ProductConceptId, string>> = {
  chat: 'Chat', result: 'Results', dashboard: 'Dashboard', widget: 'Widget', action: 'Actions', message: 'Messages', history: 'History',
  monitor: 'Monitor', task: 'Task', ticket: 'Ticket', onboarding_request: 'Onboarding Request',
};

/**
 * Concept copy for THIS account: concepts whose definition lists other concepts (Chat, Messages) name only the ones the account can use.
 * The asked concept itself is always explained (its availability line comes from `accountConceptLines`).
 */
export function productConceptText(concept: ProductConceptId, capability: Pick<AccountCapability, 'available'>): string {
  const has = (other: ProductConceptId) => capability.available.includes(other);
  if (PRODUCT_CONCEPT_IDS.every(has)) return PRODUCT_CONCEPT_TEXT[concept];
  if (concept === 'chat') {
    const build = (['result', 'dashboard'] as const).filter(has).map(other => CONCEPT_NAME[other]);
    return ['Chat คือที่ถามคำถามเกี่ยวกับข้อมูลธุรกิจ', has('result') ? 'วิเคราะห์' : '', build.length ? `สร้างและปรับ ${build.join(' หรือ ')}` : '',
      has('action') ? 'และขอให้เตรียมงาน' : ''].filter(Boolean).join(' ');
  }
  if (concept === 'message') {
    const kinds = ['ข้อความ', has('result') ? 'การแจ้งเตือนเมื่อมีคนแชร์ Result' : '', has('monitor') ? 'การแจ้งเตือนจาก Monitor' : '', has('task') ? 'งานติดตาม' : '']
      .filter(Boolean);
    return `Messages คือที่รับ${thaiSeries(kinds)}${has('result') ? ' ไม่ใช่คลัง Results' : ''}`;
  }
  return PRODUCT_CONCEPT_TEXT[concept];
}

/**
 * The account part of a product_help answer, server-owned: for the concepts the plan named, whether THIS account can use
 * each one now (from `accountCapability`). Never lists a concept as usable when the runtime does not grant it.
 */
export function accountConceptLines(capability: AccountCapability, concepts: readonly ProductConceptId[]): string {
  const asked = [...new Set(concepts)];
  const usable = asked.filter(concept => capability.available.includes(concept)).map(concept => CONCEPT_NAME[concept]);
  const blocked = asked.filter(concept => capability.unavailable.includes(concept)).map(concept => CONCEPT_NAME[concept]);
  const lines: string[] = [];
  if (usable.length) lines.push(`สำหรับบัญชีของคุณ: ใช้ ${usable.join(', ')} ได้`);
  if (blocked.length) lines.push(`สำหรับบัญชีของคุณ: ตอนนี้ยังไม่มีสิทธิ์ใช้ ${blocked.join(', ')}`);
  return lines.join('\n');
}
