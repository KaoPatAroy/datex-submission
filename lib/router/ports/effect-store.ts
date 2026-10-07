import { z } from 'zod';
import type { Actor, Profile, Store, Transaction } from '../../contracts';
import { DomainError } from '../../core/errors';
import { digest, refSchema, sameRef, type EffectRecord, type Ref } from '../../effects/shared';
import type { MonitorState } from '../../monitors';
import type { ContentClaim, Consent, EvidenceSnapshot } from '../../effects/shared';
import type { MonitorQuery } from '../../monitors';
import { paginate, sortKey, type Page, type PageInput } from '../../pagination';
import { artifactShareRowSchema, ARTIFACT_SHARE_STATUS, ARTIFACT_SHARE_TOOL, recipientOperationKey, shareRowId } from '../../artifacts/shared-store';

/**
 * Storage for the two Wave 4 effects, on EXISTING tables (no migration, no new capability probe):
 *  - simulated inbox messages  -> `mock_messages` rows with kind 'router_message' (never carry a dashboardId, so the legacy
 *    dashboard-share inbox projection ignores them). `actorId` = sender, `recipientId` = recipient (both are store filter keys).
 *  - installed monitors        -> `tool_executions` rows named 'router.monitor' with a monitor-specific `status`, so every
 *    existing `status: 'completed'` ledger scan skips them.
 * Everything here is server-written; nothing is read from the AI plan or the client.
 */
export const INBOX_KIND = 'router_message' as const;
export const MONITOR_NAME = 'router.monitor' as const;
export const MONITOR_ACTIVE_STATUSES = ['monitor_active'] as const;
export type MonitorStatus = 'monitor_active' | 'monitor_paused' | 'monitor_needs_renewal' | 'monitor_deleted';
export const MONITOR_STATUS_BY_LIFECYCLE: Record<MonitorState['lifecycle'], MonitorStatus> = {
  active: 'monitor_active', paused: 'monitor_paused', needs_renewal: 'monitor_needs_renewal',
};

const fail = (code: string, message: string, status = 409): never => { throw new DomainError(code, message, status); };

// ----------------------------------------------------------------------------------------------------------- inbox

export const inboxRowSchema = z.object({
  id: z.string().min(1).max(200), kind: z.literal(INBOX_KIND),
  actorId: z.string().min(1).max(200), senderName: z.string().max(200),
  recipientId: z.string().min(1).max(200),
  source: z.enum(['communication', 'monitor_alert', 'artifact_share', 'task_assigned']), title: z.string().min(1).max(200), content: z.string().min(1).max(4000),
  channelId: z.literal('simulated_inbox'), operationKey: z.string().min(1).max(200), planDigest: z.string().min(1).max(200),
  target: refSchema, createdAt: z.string(), readAt: z.string().nullable(), monitorId: z.string().max(200).optional(),
  /** artifact_share: the exact owner version this message points to (the recipient re-authorizes on every open). */
  artifact: z.object({ id: z.string().min(1).max(200), revision: z.number().int().positive(), digest: z.string().min(1).max(200), kind: z.string().max(40) }).strict().optional(),
  /** communication: the exact artifact version the message was bound to (content stays the evidence-rendered text). */
  boundArtifact: z.object({ id: z.string().min(1).max(200), revision: z.number().int().positive(), title: z.string().max(200) }).strict().optional(),
  /** task_assigned: the exact work item the recipient may open (current-assignee authorization is rechecked on open). */
  workItemId: z.string().min(1).max(200).optional(),
}).strict();
export type InboxRow = z.infer<typeof inboxRowSchema>;

export const inboxRowId = (operationKey: string, recipientId: string): string => `inbox_${digest({ operationKey, recipientId }).slice(0, 40)}`;
export { recipientOperationKey };
/** The operation's base key for a stored row: strips the per-recipient suffix (rows written before the suffix keep their bare key). */
export const baseOperationKey = (row: { operationKey: string; recipientId: string }): string => {
  for (const suffix of [`:${row.recipientId}`, `:${digest({ recipientId: row.recipientId }).slice(0, 40)}`])
    if (row.operationKey.length > suffix.length && row.operationKey.endsWith(suffix)) return row.operationKey.slice(0, -suffix.length);
  return row.operationKey;
};
const parseInbox = (raw: unknown): InboxRow | undefined => { const r = inboxRowSchema.safeParse(raw); return r.success ? r.data : undefined; };

/** Delivered messages the sender previously committed (idempotency ledger for the pure communication reducer). */
export async function sentInboxRecords(store: Store, actor: Actor): Promise<EffectRecord[]> {
  const rows = (await store.list<unknown>('mock_messages', { actorId: actor.id })).map(parseInbox);
  return rows.filter((r): r is InboxRow => !!r && r.actorId === actor.id && r.source === 'communication')
    .map(r => ({ operationKey: baseOperationKey(r), planDigest: r.planDigest, target: r.target, content: r.content, kind: 'simulated_inbox' }));
}

/**
 * Commit NEW delivery records (idempotent per operationKey + recipient) and independently read every one back.
 * A pre-existing row with different content is an idempotency conflict; a readback mismatch throws (the proposal goes stale).
 */
export async function commitInboxRecords(store: Store, actor: Actor, records: readonly EffectRecord[],
  meta: { now: Date; title: string; source?: InboxRow['source']; monitorId?: string; senderName?: string; boundArtifact?: InboxRow['boundArtifact'];
    /** Runs INSIDE the writing transaction, right before the first NEW row is written (authority re-check). Throwing aborts with no write. */
    guard?: (tx: Transaction) => Promise<void>;
    /** communication + Result: the verified exact version (digest + kind) the message opens; a share row is written in the SAME transaction. */
    openArtifact?: { digest: string; kind: string; bindingDigest: string } }): Promise<InboxRow[]> {
  const source = meta.source ?? 'communication';
  const wanted = records.filter(r => r.kind === 'simulated_inbox').map(r => ({ id: inboxRowId(r.operationKey, r.target.id), record: r }));
  if (!wanted.length) return [];
  const stored = await store.transaction(async tx => {
    const out: InboxRow[] = [];
    let guarded = false;
    for (const { id, record } of wanted) {
      const prior = await tx.get<unknown>('mock_messages', id);
      if (prior !== undefined) {
        const row = parseInbox(prior);
        if (!row || row.actorId !== actor.id || row.content !== record.content || row.planDigest !== record.planDigest || !sameRef(row.target, record.target))
          return fail('INBOX_CONFLICT', 'A delivery with this operation key already exists with different content');
        if (meta.boundArtifact && meta.openArtifact) await ensureAttachmentShare(tx, actor, row, record.operationKey, meta.boundArtifact, meta.openArtifact, meta.now);
        out.push(row);
        continue;
      }
      if (!guarded) { await meta.guard?.(tx); guarded = true; }
      const row: InboxRow = inboxRowSchema.parse({ id, kind: INBOX_KIND, actorId: actor.id, senderName: meta.senderName ?? actor.name, recipientId: record.target.id,
        source, title: meta.title, content: record.content, channelId: 'simulated_inbox', operationKey: recipientOperationKey(record.operationKey, record.target.id),
        planDigest: record.planDigest, target: record.target, createdAt: meta.now.toISOString(), readAt: null,
        ...(meta.monitorId ? { monitorId: meta.monitorId } : {}), ...(meta.boundArtifact ? { boundArtifact: meta.boundArtifact } : {}),
        // The message itself carries the open capability (`artifact`), so the recipient opens it through the existing share/open path.
        ...(meta.boundArtifact && meta.openArtifact ? { artifact: { id: meta.boundArtifact.id, revision: meta.boundArtifact.revision, digest: meta.openArtifact.digest, kind: meta.openArtifact.kind } } : {}) });
      await tx.put('mock_messages', row);
      if (meta.boundArtifact && meta.openArtifact) await ensureAttachmentShare(tx, actor, row, record.operationKey, meta.boundArtifact, meta.openArtifact, meta.now);
      out.push(row);
    }
    return out;
  });
  // Receipt verification: independent readback of what the recipient will see.
  for (const { id, record } of wanted) {
    const row = parseInbox(await store.get<unknown>('mock_messages', id));
    if (!row || row.recipientId !== record.target.id || row.content !== record.content || baseOperationKey(row) !== record.operationKey || row.planDigest !== record.planDigest)
      return fail('INBOX_READBACK', 'Delivered message could not be verified', 500);
  }
  return stored;
}

/** Idempotent share row that makes a communication's attached Result openable by that recipient (same row the artifact.share path writes). */
async function ensureAttachmentShare(tx: Transaction, actor: Actor, row: InboxRow, operationKey: string, bound: NonNullable<InboxRow['boundArtifact']>,
  open: { digest: string; kind: string; bindingDigest: string }, now: Date): Promise<void> {
  // The share row keeps the operation's BASE key (tool_executions has no per-key unique index), so its id is unchanged by the message key.
  const id = shareRowId(operationKey, row.recipientId);
  const prior = await tx.get<unknown>('tool_executions', id);
  if (prior !== undefined) {
    const existing = artifactShareRowSchema.safeParse(prior);
    if (!existing.success || existing.data.actorId !== actor.id || existing.data.recipientId !== row.recipientId || existing.data.messageId !== row.id || existing.data.ref.digest !== open.digest)
      return fail('ARTIFACT_SHARE_CONFLICT', 'A share with this operation key already exists with a different target');
    return;
  }
  await tx.put('tool_executions', artifactShareRowSchema.parse({ id, name: ARTIFACT_SHARE_TOOL, status: ARTIFACT_SHARE_STATUS, actorId: actor.id, recipientId: row.recipientId,
    artifactId: bound.id, revision: bound.revision, ref: { id: bound.id, version: bound.revision, digest: open.digest }, operationKey, proposalId: operationKey,
    messageId: row.id, title: bound.title, kind: open.kind, bindingDigest: open.bindingDigest, createdAt: now.toISOString() }));
}

export interface InboxMessageView {
  id: string; title: string; content: string; createdAt: string; readAt: string | null; senderName: string; source: InboxRow['source'];
  /** Present for a shared artifact: the recipient opens it through this message (authorization is rechecked on open). */
  artifact?: { revision: number; kind: string };
  boundArtifact?: { revision: number; title: string };
  /** task_assigned: open this exact work item (the server rechecks that the viewer is its current assignee). */
  workItemId?: string;
}
export const toInboxView = (row: InboxRow): InboxMessageView =>
  ({ id: row.id, title: row.title, content: row.content, createdAt: row.createdAt, readAt: row.readAt, senderName: row.senderName, source: row.source,
    ...(row.artifact ? { artifact: { revision: row.artifact.revision, kind: row.artifact.kind } } : {}),
    ...(row.boundArtifact ? { boundArtifact: { revision: row.boundArtifact.revision, title: row.boundArtifact.title } } : {}),
    ...(row.workItemId ? { workItemId: row.workItemId } : {}) });

export interface InboxPage extends Page<InboxMessageView> { /** authoritative number of unread messages addressed to this actor (all pages) */ unreadTotal: number }
/** One bounded page of the recipient's own messages, newest first (actor-scoped). `total`/`unreadTotal` are exact; `nextCursor` reaches older messages. */
export async function listInboxPage(store: Store, actor: Actor, input: PageInput & { unreadOnly?: boolean } = {}): Promise<InboxPage> {
  const rows = (await store.list<unknown>('mock_messages', { recipientId: actor.id })).map(parseInbox).filter((r): r is InboxRow => !!r && r.recipientId === actor.id);
  const page = paginate(input.unreadOnly ? rows.filter(r => r.readAt === null) : rows, r => sortKey(r.createdAt, r.id), input, { limit: 50 });
  return { items: page.items.map(toInboxView), total: page.total, nextCursor: page.nextCursor, unreadTotal: rows.filter(r => r.readAt === null).length };
}
/** The newest page of the recipient's own messages (compat helper). */
export async function listInbox(store: Store, actor: Actor, limit = 50): Promise<InboxMessageView[]> {
  return (await listInboxPage(store, actor, { limit })).items;
}

/**
 * Marks inbox rows addressed to this actor as read (owner-scoped; content is never changed). `ids` = exactly the messages the recipient
 * was shown (unknown/foreign ids are ignored); `all: true` is the explicit mark-all. Returns how many rows changed.
 */
export async function markInboxRead(store: Store, actor: Actor, now: Date, scope: { ids: readonly string[] } | { all: true } = { all: true }): Promise<number> {
  const wanted = 'ids' in scope ? new Set(scope.ids) : undefined;
  return store.transaction(async tx => {
    let marked = 0;
    for (const raw of await tx.list<unknown>('mock_messages', { recipientId: actor.id })) {
      const row = parseInbox(raw);
      if (!row || row.recipientId !== actor.id || row.readAt !== null || (wanted && !wanted.has(row.id))) continue;
      await tx.put('mock_messages', inboxRowSchema.parse({ ...row, readAt: now.toISOString() }));
      marked++;
    }
    return marked;
  });
}

// --------------------------------------------------------------------------------------------------------- monitors

/** Immutable server snapshot the monitor was approved against; replayed into the pure reducer on every tick. */
export interface MonitorBound {
  query: MonitorQuery; claims: ContentClaim[]; evidence: EvidenceSnapshot[]; consent: Consent;
  dataset: { id: string; permissions: string[] };
}
/** One persisted evaluation of an installed monitor (readable history; never carries business numbers beyond counts). */
export interface MonitorEvaluation {
  at: string; observedAt: string | null; date: string; checked: number; breached: number;
  outcome: 'ok' | 'breach_cooldown' | 'alerted' | 'held'; notified: number; reason?: string;
}
export interface MonitorRow {
  id: string; name: typeof MONITOR_NAME; status: MonitorStatus; actorId: string; sessionId: string; mode: Actor['mode']; modeRevision: number;
  conversationId: string | null; proposalId: string; title: string;
  /** Own optimistic-concurrency version (bumped by every write). */
  rowVersion: number; createdAt: string; updatedAt: string; expiresAt: number;
  state: MonitorState; bound: MonitorBound;
  lastEvaluatedAt: number | null; lastError: string | null; lastAlertId: string | null;
  /** Persisted evaluation history (bounded, newest last). Absent on monitors installed before history existed. */
  evaluations?: MonitorEvaluation[];
}
/** A Store view over an open transaction: lets a store-level helper (CAS writers) run inside a larger transaction. */
export function transactionAsStore(tx: Transaction, base: Pick<Store, 'adapter'>): Store {
  return { get: (table, id) => tx.get(table, id), list: (table, filter) => tx.list(table, filter), transaction: work => work(tx), adapter: base.adapter } as Store;
}
export const monitorRowId = (proposalId: string): string => `monitor:${proposalId}`;
const isMonitorRow = (raw: unknown, actorId?: string): raw is MonitorRow => {
  const r = raw as Partial<MonitorRow> | undefined;
  return !!r && r.name === MONITOR_NAME && typeof r.rowVersion === 'number' && !!r.state && !!r.bound && (actorId === undefined || r.actorId === actorId);
};

export async function getMonitor(reader: Pick<Store, 'get'>, id: string): Promise<MonitorRow | undefined> {
  const raw = await reader.get<unknown>('tool_executions', id);
  return isMonitorRow(raw) ? raw : undefined;
}
/**
 * Final-actor authorization INSIDE the mutation transaction for every owner Monitor change (rename / pause / resume / delete): the owner's CURRENT profile must still
 * be active and hold BOTH monitor.manage grants (sales.read + dashboard.create). Throws FORBIDDEN, which rolls the whole write back.
 */
export async function assertMonitorManager(tx: Pick<Transaction, 'get'>, actorId: string): Promise<void> {
  const profile = await tx.get<Profile>('profiles', actorId);
  if (!profile?.active || profile.id !== actorId || !profile.permissions.includes('sales.read') || !profile.permissions.includes('dashboard.create'))
    throw new DomainError('FORBIDDEN', 'บัญชีนี้ไม่มีสิทธิ์จัดการ Monitor แล้ว จึงไม่ได้ดำเนินการ', 403);
}
export async function getOwnedMonitor(store: Pick<Store, 'get'>, actor: Actor, id: string): Promise<MonitorRow | undefined> {
  const row = await getMonitor(store, id);
  return row && row.actorId === actor.id ? row : undefined;
}
export async function listOwnedMonitors(store: Store, actor: Actor, statuses: readonly MonitorStatus[] = ['monitor_active', 'monitor_paused', 'monitor_needs_renewal']): Promise<MonitorRow[]> {
  const rows = await store.list<unknown>('tool_executions', { actorId: actor.id, status: [...statuses] });
  return rows.filter((r): r is MonitorRow => isMonitorRow(r, actor.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
/** Cross-owner scan for the scheduler (status filter keeps it to monitor rows only). */
export async function listActiveMonitors(store: Store): Promise<MonitorRow[]> {
  const rows = await store.list<unknown>('tool_executions', { status: 'monitor_active' });
  return rows.filter((r): r is MonitorRow => isMonitorRow(r));
}

/** Insert a freshly installed monitor (idempotent on proposal id; a differing row is a conflict). */
export async function installMonitor(store: Store, row: MonitorRow, guard?: (tx: Transaction) => Promise<void>): Promise<MonitorRow> {
  return store.transaction(async tx => {
    await guard?.(tx);
    const prior = await tx.get<unknown>('tool_executions', row.id);
    if (prior !== undefined) {
      if (!isMonitorRow(prior) || prior.actorId !== row.actorId || digest(prior.state.workflow.preview.digest) !== digest(row.state.workflow.preview.digest))
        return fail('MONITOR_CONFLICT', 'A monitor with this id already exists');
      return prior;
    }
    await tx.put('tool_executions', row);
    return row;
  });
}

/**
 * CAS write: runs `change` against the freshly read row inside one store transaction; throws MONITOR_CONFLICT when the row
 * version moved since `expectedRowVersion`. `extra` runs in the same transaction (e.g. the alert outbox write), so state
 * advance and alert delivery commit together or not at all.
 */
export async function casMonitor(store: Store, id: string, expectedRowVersion: number, now: Date,
  change: (row: MonitorRow) => Partial<MonitorRow>, extra?: (tx: Parameters<Parameters<Store['transaction']>[0]>[0], next: MonitorRow) => Promise<void>): Promise<MonitorRow> {
  return store.transaction(async tx => {
    const raw = await tx.get<unknown>('tool_executions', id);
    if (!isMonitorRow(raw)) return fail('MONITOR_NOT_FOUND', 'Monitor not found', 404);
    if (raw.rowVersion !== expectedRowVersion) return fail('MONITOR_CONFLICT', 'Monitor changed concurrently');
    if (raw.status === 'monitor_deleted') return fail('MONITOR_NOT_FOUND', 'Monitor not found', 404);
    const next: MonitorRow = { ...raw, ...change(raw), rowVersion: raw.rowVersion + 1, updatedAt: now.toISOString() };
    await tx.put('tool_executions', next);
    if (extra) await extra(tx, next);
    return next;
  });
}

export const monitorTitle = (threshold: number, branchCount: number): string =>
  `เฝ้าติดตามยอดขายต่ำกว่า ${Math.round(threshold * 10000) / 100}% ของเป้า (${branchCount} สาขา)`;

export type { Ref };
