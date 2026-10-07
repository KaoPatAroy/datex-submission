import { z } from 'zod';
import type { Reader, Transaction } from '../contracts';
import { DomainError } from '../core/errors';
import { createArtifactReader, isArtifactSaved, type ArtifactHeadRow } from './store';
import { filterResults, RESULTS_PAGE_LIMIT, type ResultFilter, type ResultItem, type ResultKind, type ResultsPage } from './library-view';

/**
 * The owner's Results library: display metadata (title, pin, archive) kept SEPARATELY from the immutable artifact versions.
 * One small row per artifact in the existing `tool_executions` table (no migration):
 *   `artifact-library:<artifactId>`  status `artifact_library`  owner-scoped by `actorId`.
 * Renaming, pinning and archiving never read or write a version row, so the evidence payload, its digests, shares, receipts,
 * Dashboard lineage and audit are untouched; archive is a visibility flag and there is no hard delete.
 */
export const ARTIFACT_LIBRARY_TOOL = 'router.artifact_library' as const;
const LIBRARY_STATUS = 'artifact_library' as const;
export const artifactLibraryRowId = (artifactId: string): string => `artifact-library:${artifactId}`;
/** Heads scanned for one listing (bounded). The library shows pages of the filtered set; it never claims a truncated scan is the complete total. */
const SCAN_LIMIT = 2000;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

export const libraryRowSchema = z.object({
  id: z.string().min(1).max(300), name: z.literal(ARTIFACT_LIBRARY_TOOL), status: z.literal(LIBRARY_STATUS), actorId: z.string().min(1).max(200),
  artifactId: z.string().min(1).max(200), displayTitle: z.string().min(1).max(140).nullable(), pinned: z.boolean(), pinnedAt: z.string().nullable(),
  archivedAt: z.string().nullable(), revision: z.number().int().nonnegative(), updatedAt: z.string(),
}).strict();
export type LibraryRow = z.infer<typeof libraryRowSchema>;

export const resultOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('rename'), title: z.string().trim().min(1, 'โปรดระบุชื่อผลลัพธ์').max(140, 'ชื่อยาวเกิน 140 ตัวอักษร').refine(t => !CONTROL_CHARS.test(t), 'ชื่อมีอักขระที่ไม่รองรับ') }).strict(),
  z.object({ op: z.literal('clear_title') }).strict(),
  z.object({ op: z.literal('pin') }).strict(), z.object({ op: z.literal('unpin') }).strict(),
  z.object({ op: z.literal('archive') }).strict(), z.object({ op: z.literal('unarchive') }).strict(),
]);
export type ResultOp = z.infer<typeof resultOpSchema>;

type Row = Pick<Reader, 'get' | 'list'>;
const invalid = (): never => { throw new DomainError('ARTIFACT_LIBRARY_INVALID', 'ข้อมูลคลังผลลัพธ์ไม่ผ่านการตรวจความถูกต้อง', 500); };

async function readLibraryRow(reader: Pick<Reader, 'get'>, actorId: string, artifactId: string): Promise<LibraryRow | null> {
  const raw = await reader.get<unknown>('tool_executions', artifactLibraryRowId(artifactId));
  if (raw === undefined || raw === null) return null;
  const owner = (raw as { actorId?: unknown }).actorId;
  if (owner !== actorId) return null; // another owner's metadata is indistinguishable from absent
  const parsed = libraryRowSchema.safeParse(raw);
  return parsed.success && parsed.data.artifactId === artifactId ? parsed.data : invalid();
}

async function libraryRows(reader: Row, actorId: string): Promise<Map<string, LibraryRow>> {
  const rows = await reader.list<unknown>('tool_executions', { actorId, status: LIBRARY_STATUS });
  const out = new Map<string, LibraryRow>();
  for (const raw of rows) {
    const parsed = libraryRowSchema.safeParse(raw);
    if (parsed.success && parsed.data.actorId === actorId) out.set(parsed.data.artifactId, parsed.data);
  }
  return out;
}

/** The owner's CURRENT display titles (library rename) by artifact id; absent = never renamed (the version's own title applies). */
export async function displayTitles(reader: Row, actorId: string): Promise<Map<string, string>> {
  return new Map([...(await libraryRows(reader, actorId)).values()].flatMap(row => row.displayTitle ? [[row.artifactId, row.displayTitle] as const] : []));
}

/** Artifact ids the owner archived (used so archived Results are not offered to the planner as active references). */
export async function archivedArtifactIds(reader: Row, actorId: string): Promise<Set<string>> {
  return new Set([...(await libraryRows(reader, actorId)).values()].filter(row => row.archivedAt !== null).map(row => row.artifactId));
}

async function originTitle(reader: Pick<Reader, 'get'>, actorId: string, conversationId: string): Promise<string | null> {
  const conversation = await reader.get<{ actorId?: string; title?: unknown }>('conversations', conversationId);
  if (!conversation || conversation.actorId !== actorId || typeof conversation.title !== 'string' || !conversation.title.trim()) return null;
  return conversation.title.trim().slice(0, 120);
}

function toItem(head: ArtifactHeadRow, row: LibraryRow | null, origin: string | null): ResultItem {
  const archived = row?.archivedAt != null, saved = !!head.savedRef;
  return {
    id: head.artifactId, title: row?.displayTitle ?? head.title, originalTitle: head.title, renamed: row?.displayTitle != null, kind: head.kind as ResultKind,
    latestRevision: head.revision, revisions: Array.from({ length: Math.min(head.revision, 100) }, (_, i) => i + 1),
    savedRevision: head.savedRef?.version ?? null, savedAt: head.savedAt ?? null, saved, latestSaved: isArtifactSaved(head), pinned: row?.pinned === true, archived, updatedAt: head.updatedAt, origin, originConversationId: origin ? head.conversationId : null,
    section: archived ? 'archived' : saved ? 'saved' : 'recent',
  };
}

/** The owner's Results (one entry per artifact with its revisions grouped), bounded to the newest SCAN_LIMIT heads. Never lists another owner's. */
export async function listResultItems(reader: Row, actorId: string): Promise<ResultItem[]> {
  return (await scanResultItems(reader, actorId)).items;
}

/**
 * `everyHead`: build an item for EVERY retained head (the heads are already read in one list call; items are pure). Origin titles (one read per
 * conversation) stay bounded to the newest SCAN_LIMIT heads; older heads carry their origin only when that conversation was already read.
 */
async function scanResultItems(reader: Row, actorId: string, options: { everyHead?: boolean } = {}): Promise<{ items: ResultItem[]; truncated: boolean }> {
  const all = await createArtifactReader(reader as Reader, actorId).listAll();
  const heads = options.everyHead ? all : all.slice(0, SCAN_LIMIT);
  const library = await libraryRows(reader, actorId);
  const origins = new Map<string, string | null>();
  const items: ResultItem[] = [];
  for (const [index, head] of heads.entries()) {
    if (!origins.has(head.conversationId) && index < SCAN_LIMIT) origins.set(head.conversationId, await originTitle(reader, actorId, head.conversationId));
    items.push(toItem(head, library.get(head.artifactId) ?? null, origins.get(head.conversationId) ?? null));
  }
  return { items, truncated: all.length > heads.length };
}

/**
 * PC-03 resource lookup: EVERY retained, non-archived Result matching the query (library order). G2: the title / type match covers every retained
 * head (no 2,000-head cap), so a continuation never runs past the scan into an empty page; `truncated` is kept for the port contract (always false).
 */
export async function searchActiveResults(reader: Row, actorId: string, query: string): Promise<{ items: ResultItem[]; truncated: boolean }> {
  const { items, truncated } = await scanResultItems(reader, actorId, { everyHead: true });
  return { items: filterResults(items, { query, section: 'all' }).filter(item => !item.archived), truncated };
}

const cursorOffset = (cursor: string | null | undefined): number => {
  if (!cursor) return 0;
  const match = /^o:(\d{1,6})$/.exec(cursor);
  if (!match) throw new DomainError('INVALID_INPUT', 'ตัวชี้หน้าไม่ถูกต้อง', 400);
  return Number(match[1]);
};

/**
 * One bounded page of the owner's Results. Search / type / status (including archived) and the pinned-first ordering are applied to the whole
 * retained set BEFORE the page boundary, so a saved, pinned or archived older Result is always reachable and `total` is the matching count.
 */
export async function listResultsPage(reader: Row, actorId: string, input: ResultFilter & { cursor?: string | null; limit?: number } = {}): Promise<ResultsPage> {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? RESULTS_PAGE_LIMIT), 1), 100);
  const offset = cursorOffset(input.cursor);
  const { items, truncated } = await scanResultItems(reader, actorId);
  const matching = filterResults(items, { query: input.query, kind: input.kind, section: input.section, sort: input.sort });
  const page = matching.slice(offset, offset + limit);
  return { items: page, total: matching.length, limit, nextCursor: offset + limit < matching.length ? `o:${offset + limit}` : null, truncated };
}

/**
 * One library operation inside the caller's transaction. The artifact must be this owner's (a missing or foreign artifact is a 404
 * that does not reveal which). Operations are idempotent; only display metadata is written.
 */
export async function applyResultOp(tx: Transaction, actorId: string, artifactId: string, input: unknown, now: string): Promise<ResultItem> {
  const op = resultOpSchema.parse(input);
  const head = await createArtifactReader(tx, actorId).head(artifactId);
  if (!head) throw new DomainError('NOT_FOUND', 'ไม่พบผลลัพธ์ที่ระบุ', 404);
  const current = await readLibraryRow(tx, actorId, artifactId);
  const base: LibraryRow = current ?? { id: artifactLibraryRowId(artifactId), name: ARTIFACT_LIBRARY_TOOL, status: LIBRARY_STATUS, actorId, artifactId,
    displayTitle: null, pinned: false, pinnedAt: null, archivedAt: null, revision: 0, updatedAt: now };
  let next: LibraryRow = base;
  switch (op.op) {
    case 'rename': next = { ...base, displayTitle: op.title === head.title ? null : op.title }; break;
    case 'clear_title': next = { ...base, displayTitle: null }; break;
    case 'pin': next = base.pinned ? base : { ...base, pinned: true, pinnedAt: now }; break;
    case 'unpin': next = !base.pinned ? base : { ...base, pinned: false, pinnedAt: null }; break;
    case 'archive': next = base.archivedAt ? base : { ...base, archivedAt: now }; break;
    case 'unarchive': next = !base.archivedAt ? base : { ...base, archivedAt: null }; break;
  }
  if (next !== base) await tx.put('tool_executions', libraryRowSchema.parse({ ...next, revision: base.revision + 1, updatedAt: now }));
  const readback = await readLibraryRow(tx, actorId, artifactId);
  const origin = await originTitle(tx, actorId, head.conversationId);
  return toItem(head, readback, origin);
}
