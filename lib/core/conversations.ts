import type { Reader, Store, StoredRow } from '../contracts';
import { DomainError } from './errors';
import { id } from './utils';

export const DEFAULT_CONVERSATION_TITLE = 'New conversation';
export const MAX_CONVERSATION_TITLE_LENGTH = 120;

/** Pure string handling only: collapse whitespace, truncate by code points (never splitting a pair), add an ellipsis. */
export function titleFromFirstMessage(message: string): string | undefined {
  const clean = message.replace(/\s+/g, ' ').trim();
  if (!clean) return undefined;
  const points = [...clean];
  if (points.length <= MAX_CONVERSATION_TITLE_LENGTH && clean.length <= MAX_CONVERSATION_TITLE_LENGTH) return clean;
  let out = '';
  let count = 0;
  for (const point of points) {
    if (count + 1 > MAX_CONVERSATION_TITLE_LENGTH - 1 || out.length + point.length > MAX_CONVERSATION_TITLE_LENGTH - 1) break;
    out += point;
    count += 1;
  }
  return `${out.trimEnd()}…`;
}

/** Only an unset/default title is replaced; a user-chosen title is never overwritten. */
export function isDefaultConversationTitle(title: string | undefined | null): boolean {
  return !title || !title.trim() || title === DEFAULT_CONVERSATION_TITLE;
}
/**
 * Workflow V2 decisions (HR Director approvals) are prepared and confirmed by the V2 runtime, which anchors every operation in a
 * conversation turn. The router runs them in ONE per-actor system conversation (never a user chat), so a V2 action reference never
 * lands on a user-visible message. It is hidden from conversation lists.
 */
export const WORKFLOW_EXECUTION_CONVERSATION_PREFIX = 'wfx-';
export function workflowExecutionConversationId(actorId: string): string {
  let hash = 0x811c9dc5;
  for (const char of actorId) { hash ^= char.codePointAt(0)!; hash = Math.imul(hash, 0x01000193) >>> 0; }
  return `${WORKFLOW_EXECUTION_CONVERSATION_PREFIX}${actorId.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 100)}-${hash.toString(16)}`;
}
export const isWorkflowExecutionConversationId = (conversationId: string): boolean => conversationId.startsWith(WORKFLOW_EXECUTION_CONVERSATION_PREFIX);
export const MAX_CONVERSATION_SEARCH_LENGTH = 200;
export const MAX_CONVERSATION_PAGE_SIZE = 100;
export const DEFAULT_CONVERSATION_PAGE_SIZE = 25;
export const MAX_CONVERSATION_MESSAGE_OFFSET = 50_000;

/** Metadata stays optional so rows created by the V1 chat flow remain valid. */
export interface ConversationRecord extends StoredRow {
  actorId: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  rowVersion?: number;
  pinned?: boolean;
  pinnedAt?: string | null;
  archivedAt?: string | null;
}

export interface ConversationView {
  id: string;
  title: string;
  createdAt?: string;
  updatedAt?: string;
  rowVersion: number;
  pinned: boolean;
  archived: boolean;
}

export interface ConversationListOptions {
  query: string;
  cursor?: string;
  limit: number;
  includeArchived: boolean;
}

export interface ConversationListResult {
  conversations: ConversationView[];
  pagination: { limit: number; total: number; hasMore: boolean; nextCursor?: string };
}

type ConversationCursor = { pinned: boolean; updatedAt: number; id: string };

function timestamp(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isPinned(conversation: ConversationRecord): boolean {
  return typeof conversation.pinned === 'boolean' ? conversation.pinned : Boolean(conversation.pinnedAt);
}

function isArchived(conversation: ConversationRecord): boolean { return Boolean(conversation.archivedAt); }

function titleOf(conversation: ConversationRecord): string {
  return typeof conversation.title === 'string' && conversation.title.trim()
    ? conversation.title.trim()
    : DEFAULT_CONVERSATION_TITLE;
}

function rowVersion(conversation: ConversationRecord): number {
  return Number.isSafeInteger(conversation.rowVersion) && (conversation.rowVersion ?? 0) >= 1
    ? conversation.rowVersion!
    : 1;
}

function sortUpdatedAt(conversation: ConversationRecord): number {
  return timestamp(conversation.updatedAt) || timestamp(conversation.createdAt);
}

function sortKey(conversation: ConversationRecord): ConversationCursor {
  return { pinned: isPinned(conversation), updatedAt: sortUpdatedAt(conversation), id: conversation.id };
}

function compareSortKeys(left: ConversationCursor, right: ConversationCursor): number {
  const pinOrder = Number(right.pinned) - Number(left.pinned);
  if (pinOrder) return pinOrder;
  const updatedOrder = right.updatedAt - left.updatedAt;
  if (updatedOrder) return updatedOrder;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function encodeCursor(conversation: ConversationRecord): string {
  return Buffer.from(JSON.stringify(sortKey(conversation)), 'utf8').toString('base64url');
}

function decodeCursor(value: string | undefined): ConversationCursor | undefined {
  if (value === undefined) return undefined;
  if (value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new DomainError('INVALID_INPUT', 'ตำแหน่งการแบ่งหน้าไม่ถูกต้อง', 400);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
    const cursor = parsed as Record<string, unknown>;
    if (Object.keys(cursor).sort().join(',') !== 'id,pinned,updatedAt' ||
        typeof cursor.id !== 'string' || cursor.id.length < 1 || cursor.id.length > 100 ||
        typeof cursor.pinned !== 'boolean' || !Number.isSafeInteger(cursor.updatedAt)) throw new Error();
    const result = { id: cursor.id, pinned: cursor.pinned, updatedAt: cursor.updatedAt as number };
    if (encodeCursor({ id: result.id, actorId: '', pinned: result.pinned, updatedAt: new Date(result.updatedAt).toISOString() }) !== value) throw new Error();
    return result;
  } catch {
    throw new DomainError('INVALID_INPUT', 'ตำแหน่งการแบ่งหน้าไม่ถูกต้อง', 400);
  }
}

export function toConversationView(conversation: ConversationRecord): ConversationView {
  return {
    id: conversation.id,
    title: titleOf(conversation),
    ...(typeof conversation.createdAt === 'string' ? { createdAt: conversation.createdAt } : {}),
    ...(typeof conversation.updatedAt === 'string' ? { updatedAt: conversation.updatedAt } : {}),
    rowVersion: rowVersion(conversation),
    pinned: isPinned(conversation),
    archived: isArchived(conversation)
  };
}

function newestFirst(left: ConversationRecord, right: ConversationRecord): number {
  return compareSortKeys(sortKey(left), sortKey(right));
}

function notFound(): never {
  throw new DomainError('NOT_FOUND', 'ไม่พบการสนทนา', 404);
}

export async function getOwnedConversation(
  reader: Reader,
  actorId: string,
  conversationId: string
): Promise<ConversationRecord> {
  const conversation = await reader.get<ConversationRecord>('conversations', conversationId);
  if (!conversation || conversation.actorId !== actorId) notFound();
  return conversation;
}

export async function listConversations(
  reader: Reader,
  actorId: string,
  options: ConversationListOptions
): Promise<ConversationListResult> {
  const query = options.query.trim().toLowerCase();
  const rows = (await reader.list<ConversationRecord>('conversations', { actorId }))
    .filter((row) => row.actorId === actorId && !isWorkflowExecutionConversationId(row.id))
    .filter((row) => options.includeArchived || !isArchived(row))
    .filter((row) => !query || titleOf(row).toLowerCase().includes(query))
    .sort(newestFirst);
  const total = rows.length;
  const cursor = decodeCursor(options.cursor);
  const afterCursor = cursor ? rows.filter((row) => compareSortKeys(sortKey(row), cursor) > 0) : rows;
  const page = afterCursor.slice(0, options.limit);
  const hasMore = afterCursor.length > page.length;
  const conversations = page.map(toConversationView);
  return {
    conversations,
    pagination: {
      limit: options.limit,
      total,
      hasMore,
      ...(hasMore && page.length ? { nextCursor: encodeCursor(page[page.length - 1]) } : {})
    }
  };
}

export async function createConversation(
  store: Store,
  actorId: string,
  title: string | undefined,
  now = new Date()
): Promise<ConversationView> {
  const createdAt = now.toISOString();
  const conversation: ConversationRecord = {
    id: id('conversation'),
    actorId,
    title: title?.trim() || DEFAULT_CONVERSATION_TITLE,
    createdAt,
    updatedAt: createdAt,
    rowVersion: 1,
    pinned: false,
    lastScope: null,
    lastDashboardId: null,
    archivedAt: null
  };
  await store.transaction(async (tx) => {
    await tx.put('conversations', conversation);
    await tx.put('audit_events', {
      id: id('audit'), actorId, category: 'conversation_metadata',
      summary: `Created conversation ${conversation.id}`, createdAt
    });
  });
  return toConversationView(conversation);
}

export type ConversationMutation =
  | { type: 'rename'; title: string }
  | { type: 'pin'; pinned: boolean }
  | { type: 'archive'; archived: boolean };

export async function updateConversation(
  store: Store,
  actorId: string,
  conversationId: string,
  expectedVersion: number,
  mutation: ConversationMutation,
  now = new Date()
): Promise<ConversationView> {
  return store.transaction(async (tx) => {
    const current = await getOwnedConversation(tx, actorId, conversationId);
    const currentVersion = rowVersion(current);
    if (expectedVersion !== currentVersion) {
      throw new DomainError('STALE_CONVERSATION', 'ข้อมูลการสนทนาเปลี่ยนแล้ว กรุณาโหลดใหม่', 409);
    }
    const updatedAt = now.toISOString();
    const next: ConversationRecord = {
      ...current,
      ...(mutation.type === 'rename' ? { title: mutation.title.trim() } : {}),
      ...(mutation.type === 'pin' ? { pinned: mutation.pinned } : {}),
      ...(mutation.type === 'archive' ? { archivedAt: mutation.archived ? updatedAt : null } : {}),
      updatedAt,
      rowVersion: currentVersion + 1
    };
    await tx.put('conversations', next);
    await tx.put('audit_events', {
      id: id('audit'), actorId, category: 'conversation_metadata',
      summary: `${mutation.type} conversation ${conversationId}${mutation.type === 'archive' ? ` (${mutation.archived ? 'archived' : 'unarchived'})` : ''}`,
      createdAt: updatedAt
    });
    return toConversationView(next);
  });
}
