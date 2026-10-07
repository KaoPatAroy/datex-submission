import { ticketPlanSchema, type TicketPlan } from '../contracts';

const PRIORITY: Record<TicketPlan['priority'], string> = { low: 'ต่ำ', normal: 'ปกติ', high: 'สูง', urgent: 'ด่วน' };

/** Thai one-liners of a ticket plan's stated fields (server-owned wording; values are the validated plan fields). */
export function ticketPlanLines(plan: TicketPlan | undefined): string[] {
  if (!plan) return [];
  return [
    `ความสำคัญ ${PRIORITY[plan.priority]}${plan.dueDate ? ` · ครบกำหนด ${plan.dueDate}` : ''}`,
    plan.grouping === 'single' ? (plan.coveredBranchIds?.length ? `เป็น Ticket เดียวครอบคลุม ${plan.coveredBranchIds.length} สาขา` : 'เป็น Ticket เดียว') : 'แยก Ticket รายสาขา',
    ...(plan.checklist.length ? [`รายการตรวจ ${plan.checklist.length} ข้อ: ${plan.checklist.join(' / ')}`] : []),
    ...(plan.note ? [`หมายเหตุ: ${plan.note}`] : []),
  ];
}

/**
 * The legacy ticket row has a fixed, strictly validated shape that hosted storage enforces (and `priority`/`dueDate` keys would make a row look
 * like a workflow V2 ticket), so the plan travels inside the existing free-text `unansweredQuestion` field as a marked JSON suffix: no new column,
 * no hosted migration. The plan stays schema-validated on the way in (payload) and on the way out (extract).
 */
export const TICKET_PLAN_MARK = '\n[ticket-plan] ';
export function embedTicketPlan(question: string, plan: TicketPlan | undefined): string {
  return plan ? `${question}${TICKET_PLAN_MARK}${JSON.stringify(plan)}` : question;
}
export function extractTicketPlan(question: string): TicketPlan | undefined {
  const at = question.indexOf(TICKET_PLAN_MARK);
  if (at < 0) return undefined;
  try {
    const parsed = ticketPlanSchema.safeParse(JSON.parse(question.slice(at + TICKET_PLAN_MARK.length)));
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
}
