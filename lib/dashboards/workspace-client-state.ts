import type { ConversationReceipt } from '@/components/biztania/conversation-ui';
import type { StagedReceipt } from '@/lib/router/executors/action';

export interface DashboardTaskTarget {
  dashboardId: string;
  title: string;
  actorId: string;
  sessionId: string;
}

export function reconcileDashboardTaskTarget<T extends DashboardTaskTarget>(
  target: T | null,
  actor: { id: string; sessionId: string } | null,
  ownedDashboardIds: readonly string[] | null,
): T | null {
  if (!target || !actor || target.actorId !== actor.id || target.sessionId !== actor.sessionId) return null;
  if (ownedDashboardIds && !ownedDashboardIds.includes(target.dashboardId)) return null;
  return target;
}

export interface RouterReceiptItem extends Omit<ConversationReceipt, 'conversationId' | 'turnId'> {
  conversationId?: string;
  turnId?: string;
  receipt: StagedReceipt;
}
export interface RouterReceiptPage {
  items: Array<RouterReceiptItem & Required<Pick<ConversationReceipt, 'conversationId' | 'turnId'>>>;
  total: number;
  nextCursor: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function requiredString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function parseReceipt(value: unknown): StagedReceipt | null {
  const raw = record(value);
  if (!raw || !requiredString(raw.kind, 60) || !requiredString(raw.title, 120) || !requiredString(raw.headline, 500) || !requiredString(raw.verifiedAt, 40)) return null;

  let recipients: StagedReceipt['recipients'];
  if (raw.recipients !== undefined) {
    if (!Array.isArray(raw.recipients)) return null;
    recipients = [];
    for (const value of raw.recipients) {
      const item = record(value);
      if (!item || !requiredString(item.name, 120) || item.status !== 'delivered') return null;
      recipients.push({ name: item.name, status: 'delivered' });
    }
  }

  let artifact: StagedReceipt['artifact'];
  if (raw.artifact !== undefined && raw.artifact !== null) {
    const item = record(raw.artifact);
    if (!item || !requiredString(item.title, 200) || !requiredString(item.kind, 40) || typeof item.revision !== 'number' || !Number.isFinite(item.revision)) return null;
    artifact = { title: item.title, kind: item.kind, revision: item.revision };
  }

  let lines: string[] | undefined;
  if (raw.lines !== undefined) {
    if (!Array.isArray(raw.lines) || !raw.lines.every((line): line is string => typeof line === 'string')) return null;
    lines = raw.lines.slice(0, 20).map(line => line.slice(0, 300));
  }

  let fields: StagedReceipt['fields'];
  if (raw.fields !== undefined) {
    if (!Array.isArray(raw.fields)) return null;
    fields = [];
    for (const value of raw.fields) {
      const item = record(value);
      if (!item || !requiredString(item.label, 80) || typeof item.value !== 'string' || item.value.length > 300) return null;
      fields.push({ label: item.label, value: item.value });
    }
    fields = fields.slice(0, 30);
  }

  if (raw.content !== undefined && (typeof raw.content !== 'string' || raw.content.length > 4000)) return null;
  return {
    kind: raw.kind, title: raw.title, headline: raw.headline, verifiedAt: raw.verifiedAt,
    ...(recipients?.length ? { recipients: recipients.slice(0, 50) } : {}), ...(artifact ? { artifact } : {}),
    ...(lines?.length ? { lines } : {}), ...(fields?.length ? { fields } : {}), ...(raw.content ? { content: raw.content } : {}),
  };
}

/** Validates the same bounded receipt page used by the persisted receipts panel. */
export function parseRouterReceiptPage(value: unknown): RouterReceiptPage | null {
  const body = record(value);
  if (!body || !Array.isArray(body.receipts)) return null;
  const items: RouterReceiptPage['items'] = [];
  for (const value of body.receipts) {
    const raw = record(value);
    const receipt = parseReceipt(raw?.receipt);
    if (!raw || !requiredString(raw.id, 200) || !requiredString(raw.actionId, 200) || typeof raw.completedAt !== 'number' || !Number.isFinite(raw.completedAt) ||
      !requiredString(raw.conversationId, 200) || !requiredString(raw.turnId, 200) || !receipt) return null;
    items.push({ id: raw.id, actionId: raw.actionId, completedAt: raw.completedAt, conversationId: raw.conversationId, turnId: raw.turnId, receipt });
  }
  if (body.nextCursor !== undefined && body.nextCursor !== null && typeof body.nextCursor !== 'string') return null;
  const total = typeof body.total === 'number' && Number.isFinite(body.total) && body.total >= 0 ? body.total : items.length;
  return { items, total, nextCursor: typeof body.nextCursor === 'string' ? body.nextCursor : null };
}

export interface ConversationReceiptLoadState {
  scopeKey: string | null;
  requestId: number;
  items: ConversationReceipt[];
  hasOlder: boolean;
  error: boolean;
}

export function beginConversationReceiptLoad(state: ConversationReceiptLoadState, scopeKey: string | null, requestId: number): ConversationReceiptLoadState {
  const sameScope = scopeKey !== null && state.scopeKey === scopeKey;
  return {
    scopeKey, requestId, items: sameScope ? state.items : [], hasOlder: sameScope ? state.hasOlder : false, error: false,
  };
}

export function finishConversationReceiptLoad(
  state: ConversationReceiptLoadState,
  scopeKey: string,
  requestId: number,
  page: { items: ConversationReceipt[]; nextCursor: string | null } | null,
): ConversationReceiptLoadState {
  if (state.scopeKey !== scopeKey || state.requestId !== requestId) return state;
  return page
    ? { ...state, items: page.items, hasOlder: page.nextCursor !== null, error: false }
    : { ...state, error: true };
}
