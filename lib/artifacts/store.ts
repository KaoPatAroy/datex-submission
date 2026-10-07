import type { Reader, Transaction } from '../contracts';
import { DomainError } from '../core/errors';
import type { Ref } from '../dynamic/plan/schemas';
import type { ArtifactAuthority, ArtifactPreview, ArtifactVersion } from './contracts';
import { prepareArtifactWrite, verifyArtifactWrite } from './persistence';
import { loadArtifact, loadSharedArtifact, sameRef, validArtifactRecord } from './prepare';
import type { ArtifactShareGrant } from './grant';
import { visualExpressionSchema, type VisualExpression } from '../visualization/contracts';
import { digest } from '../dynamic/shared';

/**
 * The chart expression an artifact preview was compiled from. It travels beside the preview (same object identity) from the
 * executor to the persistence step, so the immutable version row keeps exactly what the preview rendered and a reload compiles
 * the identical spec ("preview equals persisted version").
 */
const previewVisuals = new WeakMap<ArtifactPreview, VisualExpression | null>();
export function attachPreviewVisual(preview: ArtifactPreview, expression: VisualExpression | null): void { previewVisuals.set(preview, expression); }
export function previewVisual(preview: ArtifactPreview): VisualExpression | null { return previewVisuals.get(preview) ?? null; }

/**
 * Artifact persistence over the existing `tool_executions` table (no new hosted table / migration needed).
 *
 * Rows (all owner-scoped by `actorId`; `status` keeps them out of the 'completed' ledger scans used by other readers):
 *  - `artifact-version:<id>:<revision>`  status `artifact_version`  immutable, append-only full ArtifactVersion record
 *  - `artifact-head:<id>`                status `artifact_head`     small pointer: latest ref, conversation, kind, title, saved ref
 *
 * The store never trusts stored JSON: every read re-validates the record (schema + all digests) and the pointer
 * (`validArtifactRecord`), and a pointer without its version is an error, never "absent". Uniqueness of
 * (artifactId, revision) is the deterministic row id; the CAS on the latest pointer is the head's ref compared inside
 * the same store transaction as the append (SQLite serializes transactions; Supabase commits with a revision CAS).
 */
export const ARTIFACT_VERSION_TOOL = 'router.artifact_version';
export const ARTIFACT_HEAD_TOOL = 'router.artifact_head';
const VERSION_STATUS = 'artifact_version';
const HEAD_STATUS = 'artifact_head';

export const artifactVersionRowId = (artifactId: string, revision: number): string => `artifact-version:${artifactId}:${revision}`;
export const artifactHeadRowId = (artifactId: string): string => `artifact-head:${artifactId}`;

export interface ArtifactHeadRow {
  id: string; name: typeof ARTIFACT_HEAD_TOOL; status: typeof HEAD_STATUS;
  actorId: string; conversationId: string; artifactId: string; revision: number; ref: Ref;
  kind: ArtifactVersion['plan']['artifactTypeId']; title: string; createdAt: string; updatedAt: string;
  /** Ref of the version the owner explicitly saved (private save). */
  savedRef?: Ref; savedAt?: string;
}
interface ArtifactVersionRow {
  id: string; name: typeof ARTIFACT_VERSION_TOOL; status: typeof VERSION_STATUS;
  actorId: string; conversationId: string; turnId: string; artifactId: string; revision: number; ref: Ref; record: ArtifactVersion; createdAt: string;
  /** Chart expression of a chart version (immutable with the version; absent for other kinds). */
  visual?: VisualExpression;
}

const invalid = (): never => { throw new DomainError('ARTIFACT_STORE_INVALID', 'ผลลัพธ์ที่เก็บไว้ไม่ผ่านการตรวจความถูกต้อง', 500); };
const isRef = (value: unknown): value is Ref => !!value && typeof value === 'object' &&
  typeof (value as Ref).id === 'string' && Number.isInteger((value as Ref).version) && typeof (value as Ref).digest === 'string';

async function readHead(reader: Pick<Reader, 'get'>, actorId: string, artifactId: string): Promise<ArtifactHeadRow | null> {
  const row = await reader.get<ArtifactHeadRow>('tool_executions', artifactHeadRowId(artifactId));
  if (!row) return null;
  if (row.actorId !== actorId) return null; // another owner's artifact is indistinguishable from absent
  if (row.name !== ARTIFACT_HEAD_TOOL || row.artifactId !== artifactId || !isRef(row.ref) ||
    !Number.isInteger(row.revision) || row.ref.version !== row.revision) return invalid();
  return row;
}
async function readVersionRow(reader: Pick<Reader, 'get'>, actorId: string, artifactId: string, revision: number): Promise<ArtifactVersionRow | null> {
  const row = await reader.get<ArtifactVersionRow>('tool_executions', artifactVersionRowId(artifactId, revision));
  if (!row) return null;
  if (row.actorId !== actorId) return null;
  if (row.name !== ARTIFACT_VERSION_TOOL || row.artifactId !== artifactId || row.revision !== revision ||
    !validArtifactRecord(row.record) || row.record.ownerId !== actorId || row.record.artifactId !== artifactId ||
    row.record.revision !== revision || !isRef(row.ref) || !sameRef(row.ref, row.record.ref)) return invalid();
  return row;
}

/** Owner-scoped read view over a store or transaction. Lookup failure throws; null means confirmed absent. */
export interface ArtifactReadStore {
  head(artifactId: string): Promise<ArtifactHeadRow | null>;
  latest(artifactId: string): Promise<ArtifactVersion | null>;
  read(ref: Ref): Promise<ArtifactVersion | null>;
  /** Heads of this owner's artifacts in one conversation, newest first. */
  listHeads(conversationId: string): Promise<ArtifactHeadRow[]>;
  /** Heads of all of this owner's artifacts (every conversation), newest first. */
  listAll(): Promise<ArtifactHeadRow[]>;
}

export function createArtifactReader(reader: Reader, actorId: string): ArtifactReadStore {
  const latest = async (artifactId: string): Promise<ArtifactVersion | null> => {
    const head = await readHead(reader, actorId, artifactId);
    if (!head) return null;
    const row = await readVersionRow(reader, actorId, artifactId, head.revision);
    if (!row || !sameRef(row.ref, head.ref)) return invalid();
    return row.record;
  };
  return {
    head: artifactId => readHead(reader, actorId, artifactId),
    latest,
    async read(ref) {
      const row = await readVersionRow(reader, actorId, ref.id, ref.version);
      return row && sameRef(row.ref, ref) ? row.record : null;
    },
    async listHeads(conversationId) {
      const rows = await reader.list<ArtifactHeadRow>('tool_executions', { actorId, status: HEAD_STATUS });
      return rows.filter(row => row.name === ARTIFACT_HEAD_TOOL && row.actorId === actorId && row.conversationId === conversationId &&
        isRef(row.ref) && typeof row.artifactId === 'string').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async listAll() {
      const rows = await reader.list<ArtifactHeadRow>('tool_executions', { actorId, status: HEAD_STATUS });
      return rows.filter(row => row.name === ARTIFACT_HEAD_TOOL && row.actorId === actorId && isRef(row.ref) && typeof row.artifactId === 'string' &&
        Number.isInteger(row.revision)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
  };
}

export interface ArtifactAppendContext { actorId: string; conversationId: string; turnId: string; now: string }

/** Transaction-scoped append-only writer. `append` is a compare-and-set on the latest pointer. */
export function createArtifactWriter(tx: Transaction, context: ArtifactAppendContext) {
  const reader = createArtifactReader(tx, context.actorId);
  return {
    ...reader,
    async append(record: ArtifactVersion, expectedLatest: Ref | null, visual?: VisualExpression | null): Promise<'written' | 'conflict'> {
      if (!validArtifactRecord(record) || record.ownerId !== context.actorId) return invalid();
      const head = await readHead(tx, context.actorId, record.artifactId);
      const current = head ? head.ref : null;
      if (expectedLatest === null ? current !== null : current === null || !sameRef(current, expectedLatest)) return 'conflict';
      if (record.revision !== (head ? head.revision + 1 : 1)) return 'conflict';
      if (await tx.get('tool_executions', artifactVersionRowId(record.artifactId, record.revision))) return 'conflict';
      const versionRow: ArtifactVersionRow = { id: artifactVersionRowId(record.artifactId, record.revision), name: ARTIFACT_VERSION_TOOL, status: VERSION_STATUS,
        actorId: context.actorId, conversationId: head?.conversationId ?? context.conversationId, turnId: context.turnId,
        artifactId: record.artifactId, revision: record.revision, ref: record.ref, record, createdAt: context.now, ...(visual ? { visual } : {}) };
      await tx.put('tool_executions', versionRow);
      const next: ArtifactHeadRow = { id: artifactHeadRowId(record.artifactId), name: ARTIFACT_HEAD_TOOL, status: HEAD_STATUS,
        actorId: context.actorId, conversationId: versionRow.conversationId, artifactId: record.artifactId, revision: record.revision, ref: record.ref,
        kind: record.plan.artifactTypeId, title: record.plan.title, createdAt: head?.createdAt ?? context.now, updatedAt: context.now,
        ...(head?.savedRef ? { savedRef: head.savedRef, ...(head.savedAt ? { savedAt: head.savedAt } : {}) } : {}) };
      await tx.put('tool_executions', next);
      return 'written';
    },
  };
}

/**
 * Persists a prepared preview as a new immutable version (draft until the owner saves it) inside the caller's
 * transaction: fresh authority + current catalog digest, `prepareArtifactWrite` CAS against the transaction's own latest
 * pointer, append, then an INDEPENDENT readback verified by `verifyArtifactWrite`.
 */
export async function persistArtifactPreview(tx: Transaction, input: {
  preview: ArtifactPreview; authority: ArtifactAuthority; conversationId: string; turnId: string; now: string;
}): Promise<{ ref: Ref }> {
  const { preview, authority } = input;
  const writer = createArtifactWriter(tx, { actorId: authority.id, conversationId: input.conversationId, turnId: input.turnId, now: input.now });
  const latest = await writer.latest(preview.artifact.artifactId);
  const prepared = prepareArtifactWrite({ preview, confirmedPreview: preview.ref, latestRef: latest?.ref ?? null, authority, now: input.now });
  if (prepared.outcome !== 'accepted') {
    const code = prepared.code === 'artifact_conflict' ? 'ARTIFACT_CONFLICT' : 'ARTIFACT_WRITE_REJECTED';
    throw new DomainError(code, 'ไม่สามารถบันทึกผลลัพธ์ได้ภายใต้สิทธิ์และหลักฐานปัจจุบัน', 409);
  }
  const visual = previewVisual(preview);
  if (preview.artifact.plan.artifactTypeId === 'chart' && !visual) throw new DomainError('ARTIFACT_WRITE_REJECTED', 'ไม่พบรูปแบบกราฟของผลลัพธ์นี้', 409);
  if (await writer.append(prepared.write.record, prepared.write.expectedLatest, visual) !== 'written') {
    throw new DomainError('ARTIFACT_CONFLICT', 'ผลลัพธ์นี้ถูกแก้ไขพร้อมกัน โปรดลองอีกครั้ง', 409);
  }
  const readback = await readVersionRow(tx, authority.id, prepared.write.record.artifactId, prepared.write.record.revision);
  const verified = verifyArtifactWrite({ write: prepared.write, readback: readback?.record, authority });
  if (verified.outcome !== 'accepted' || digest(readback?.visual ?? null) !== digest(visual ?? null)) throw new DomainError('ARTIFACT_READBACK_FAILED', 'ตรวจกลับผลลัพธ์ที่บันทึกไม่ผ่าน', 500);
  return { ref: verified.ref };
}

export type LoadedArtifact = { artifact: ArtifactVersion; head: ArtifactHeadRow; visual: VisualExpression | null };

/**
 * Loads an artifact (latest or an exact revision) from the server store as a runtime-trusted record under CURRENT authority.
 * The expected ref is the protected stored pointer, never client input; digests of the evidence/claims/plan are rechecked.
 */
export async function loadStoredArtifact(reader: Reader, authority: ArtifactAuthority, artifactId: string, revision?: number): Promise<LoadedArtifact> {
  const store = createArtifactReader(reader, authority.id);
  const head = await store.head(artifactId);
  if (!head) throw new DomainError('NOT_FOUND', 'ไม่พบผลลัพธ์ที่ระบุ', 404);
  const row = await readVersionRow(reader, authority.id, artifactId, revision ?? head.revision);
  if (!row) throw new DomainError('NOT_FOUND', 'ไม่พบเวอร์ชันของผลลัพธ์ที่ระบุ', 404);
  const loaded = loadArtifact({ record: row.record, expectedRef: row.ref, authority });
  if (loaded.outcome !== 'accepted') {
    throw new DomainError('FORBIDDEN', 'สิทธิ์หรือแคตตาล็อกปัจจุบันไม่ครอบคลุมผลลัพธ์นี้ โปรดสร้างผลลัพธ์ใหม่จากข้อมูลล่าสุด', 403);
  }
  const visual = row.visual === undefined ? null : visualExpressionSchema.safeParse(row.visual);
  if (visual && !visual.success) return invalid();
  return { artifact: loaded.artifact, head, visual: visual?.data ?? null };
}

/** Marks the head's CURRENT version as explicitly saved by its owner. Private and reversible, so no confirmation step. */
export async function markArtifactSaved(tx: Transaction, input: { head: ArtifactHeadRow; artifact: ArtifactVersion; now: string }): Promise<ArtifactHeadRow> {
  if (!sameRef(input.head.ref, input.artifact.ref)) throw new DomainError('ARTIFACT_CONFLICT', 'มีเวอร์ชันใหม่กว่านี้แล้ว โปรดเปิดเวอร์ชันล่าสุดก่อนบันทึก', 409);
  const current = await readHead(tx, input.head.actorId, input.head.artifactId);
  if (!current || !sameRef(current.ref, input.head.ref)) throw new DomainError('ARTIFACT_CONFLICT', 'มีเวอร์ชันใหม่กว่านี้แล้ว โปรดเปิดเวอร์ชันล่าสุดก่อนบันทึก', 409);
  if (current.savedRef && sameRef(current.savedRef, current.ref)) return current;
  const next: ArtifactHeadRow = { ...current, savedRef: current.ref, savedAt: input.now, updatedAt: input.now };
  await tx.put('tool_executions', next);
  return next;
}

export const isArtifactSaved = (head: Pick<ArtifactHeadRow, 'ref' | 'savedRef'>): boolean => !!head.savedRef && sameRef(head.savedRef, head.ref);

/**
 * Recipient-side reload of the OWNER's exact version through a server-issued share grant. The owner's row is read by the
 * owner's id (never the viewer's); the version must be the one the grant names, and current authority must cover its whole scope.
 */
export async function loadSharedStoredArtifact(reader: Reader, input: {
  ownerId: string; authority: ArtifactAuthority; grant: ArtifactShareGrant; artifactId: string; revision: number;
}): Promise<{ artifact: ArtifactVersion; visual: VisualExpression | null }> {
  const row = await readVersionRow(reader, input.ownerId, input.artifactId, input.revision);
  if (!row) throw new DomainError('NOT_FOUND', 'ไม่พบเวอร์ชันของผลลัพธ์ที่ระบุ', 404);
  const loaded = loadSharedArtifact({ record: row.record, expectedRef: row.ref, authority: input.authority, grant: input.grant });
  if (loaded.outcome !== 'accepted') {
    throw new DomainError('FORBIDDEN', 'สิทธิ์ปัจจุบันของคุณไม่ครอบคลุมขอบเขตข้อมูลทั้งหมดของผลลัพธ์นี้ จึงเปิดดูไม่ได้', 403);
  }
  const visual = row.visual === undefined ? null : visualExpressionSchema.safeParse(row.visual);
  if (visual && !visual.success) return invalid();
  return { artifact: loaded.artifact, visual: visual?.data ?? null };
}
