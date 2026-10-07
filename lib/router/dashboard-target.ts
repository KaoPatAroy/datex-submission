import type { PlannerContext } from './planner-context';

/**
 * Server-built Dashboard target choices for a request that names "a Dashboard" without one the server can resolve (G3-5):
 * the actor's own listed Dashboards (server ids, current titles) plus a create-new option when a new Dashboard can be built
 * from an accepted answer of this conversation. Never a search for a literal title; nothing here reads user text.
 */
export const NEW_DASHBOARD_CHOICE_ID = 'dashboard-target:new';
export const NEW_DASHBOARD_CHOICE_LABEL = 'สร้าง Dashboard ใหม่จากคำตอบนี้';
const MAX_CHOICES = 8;

export interface DashboardTargetOffer { text: string; choices: { id: string; label: string }[] }

const MAX_LABEL = 150;
const UPDATED_AT = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' });
/**
 * G5: server-built chip labels for the actor's Dashboards. A title shared by several Dashboards gets the server facts that tell them apart (last
 * update time, widget count, "ล่าสุดในแชทนี้" for the conversation's current one); a unique title stays as it is. Never model text.
 */
export function dashboardChoiceLabels(dashboards: PlannerContext['dashboards']): Map<string, string> {
  const counts = new Map<string, number>();
  for (const d of dashboards) counts.set(d.title, (counts.get(d.title) ?? 0) + 1);
  const labels = new Map<string, string>();
  for (const d of dashboards) {
    if ((counts.get(d.title) ?? 0) < 2) { labels.set(d.id, d.title); continue; }
    const at = d.updatedAt && Number.isFinite(Date.parse(d.updatedAt)) ? `อัปเดต ${UPDATED_AT.format(new Date(d.updatedAt))}` : '';
    const facts = [d.current ? 'ล่าสุดในแชทนี้' : '', at, d.widgetCount !== undefined ? `${d.widgetCount} Widget` : ''].filter(Boolean);
    const suffix = facts.length ? ` · ${facts.join(' · ')}` : '';
    // Chip labels are bounded (160 in the stream contract): the server facts stay whole, a long title is shortened.
    const room = MAX_LABEL - [...suffix].length - 6;
    labels.set(d.id, `${[...d.title].length > room ? `${[...d.title].slice(0, room).join('')}…` : d.title}${suffix}`);
  }
  // Still identical (same minute, same widget count): number them so no two chips read the same.
  const seen = new Map<string, number>();
  for (const [id, label] of labels) {
    const n = (seen.get(label) ?? 0) + 1; seen.set(label, n);
    if (n > 1) labels.set(id, `${label} (${n})`);
  }
  return labels;
}
/** Number of the actor's listed Dashboards titled exactly `title` (create-new must say when it adds another one). */
export function sameTitleDashboards(context: PlannerContext, title: string): number {
  return context.dashboards.filter(d => d.title === title).length;
}

/**
 * The offer, or undefined when there is nothing to pick (no Dashboard and no answer to build one from). `validated` are choices
 * the validator already resolved against the context (server labels); otherwise the listed DASHBOARDS are offered.
 */
export function dashboardTargetOffer(context: PlannerContext, validated: readonly { id: string; label: string }[] = []): DashboardTargetOffer | undefined {
  const canCreate = context.actions.some(action => action.actionId === 'dashboard.create')
    && (!!context.previousState || context.acceptedStates.length > 0);
  const listed = new Set(context.dashboards.map(d => d.id));
  const labels = dashboardChoiceLabels(context.dashboards);
  const base = (validated.length ? validated.filter(c => listed.has(c.id)) : context.dashboards).map(d => ({ id: d.id, label: labels.get(d.id) ?? ('label' in d ? d.label : d.title) }));
  const existing = base.slice(0, canCreate ? MAX_CHOICES - 1 : MAX_CHOICES).map(d => ({ id: d.id, label: d.label }));
  const choices = [...existing, ...(canCreate ? [{ id: NEW_DASHBOARD_CHOICE_ID, label: NEW_DASHBOARD_CHOICE_LABEL }] : [])];
  if (!choices.length) return undefined;
  const text = existing.length && canCreate ? 'ต้องการใช้ Dashboard ไหนครับ เลือก Dashboard ที่มีอยู่ หรือสร้าง Dashboard ใหม่จากคำตอบนี้'
    : existing.length ? 'ต้องการใช้ Dashboard ไหนครับ เลือกจาก Dashboard ที่มีอยู่ด้านล่าง'
      : 'ยังไม่มี Dashboard ที่บันทึกไว้ — สร้าง Dashboard ใหม่จากคำตอบนี้ได้เลย';
  return { text, choices };
}

/**
 * A MODEL lookup query that is only the generic resource noun ("Dashboard", "แดชบอร์ด", optionally with a demonstrative such as
 * "นั้น"/"นี้"): it names no title, so the server offers the target choices instead of searching for that literal text.
 */
const GENERIC_DASHBOARD = /^(?:the\s+|that\s+|this\s+|my\s+)?(?:dashboards?|แดชบอร์ด|แดชบอด)(?:\s*(?:นั้น|นี้|นี่|ของฉัน|ของผม|ของคุณ|ใหม่|ล่าสุด))?$/iu;
export function isGenericDashboardQuery(query: string): boolean {
  return GENERIC_DASHBOARD.test(query.trim());
}

/** A clarify slot that asks for the Dashboard target: an action's params.dashboard, or the target of a Dashboard refine. */
export function isDashboardTargetSlot(about: { kind: string; actionId?: string }, slot: string): boolean {
  return slot === 'params.dashboard' || (about.kind === 'refine' && slot === 'pendingActionId')
    // G5 (live v6: "เพิ่มเข้า Dashboard" -> clarify dashboard.create params.title, no choices): adding an answer to "a Dashboard" is the target
    // question (a listed Dashboard or a new one); a new Dashboard's title is generated, never a blocking question.
    || (about.kind === 'action' && about.actionId === 'dashboard.create' && (slot === 'params.title' || slot === 'params.source'));
}
