import { businessDateSchema, type Workspace } from '@/lib/contracts';

export type DashboardTaskOptions = { assigneeId?: string; dueDate?: string };
export type DashboardIntent = {
  dashboardId: string;
  title?: string;
  actionKind: 'dashboard_share' | 'ticket_create';
  prompt: string;
  taskOptions?: DashboardTaskOptions;
};

export function validDashboardTaskOptions(value: unknown): value is DashboardTaskOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const options = value as DashboardTaskOptions;
  return (options.assigneeId === undefined || typeof options.assigneeId === 'string' && options.assigneeId.length > 0 && options.assigneeId.length <= 200)
    && (options.dueDate === undefined || businessDateSchema.safeParse(options.dueDate).success);
}

/** Keep the selected Dashboard outside editable composer text; the AI resolves the human request into a prepared proposal. */
export function dashboardIntentRequest(intent: DashboardIntent, workspace: Pick<Workspace, 'taskAssigneeOptions'>, actorId: string) {
  const name = intent.title?.trim() ? `Dashboard “${intent.title.trim().slice(0, 120)}”` : 'Dashboard ที่เลือกไว้';
  let prompt = intent.actionKind === 'dashboard_share' ? `ช่วยเตรียมแชร์ ${name} ให้ผู้ร่วมงาน` : `${intent.prompt} จาก ${name}`;
  if (intent.actionKind === 'ticket_create' && intent.taskOptions !== undefined) {
    if (!validDashboardTaskOptions(intent.taskOptions)) return null;
    // Keep the intent's wording and resolve the selected account by id without adding internal ids to composer text.
    const { assigneeId, dueDate } = intent.taskOptions;
    if (assigneeId && assigneeId !== actorId) {
      const person = workspace.taskAssigneeOptions?.find(option => option.id === assigneeId);
      if (!person) return null;
      prompt += ` มอบหมายให้ ${person.label}`;
    }
    if (dueDate) prompt += ` กำหนดส่งวันที่ ${dueDate}`;
  }
  return { prompt, targets: [{ kind: 'dashboard' as const, id: intent.dashboardId }] };
}
