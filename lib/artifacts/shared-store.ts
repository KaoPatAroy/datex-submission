import { z } from 'zod';
import type { Actor, Reader, Store, Transaction } from '../contracts';
import { DomainError } from '../core/errors';
import { refSchema, type Ref } from '../dynamic/plan/schemas';
import { digest } from '../dynamic/shared';

/**
 * Durable artifact shares on the EXISTING tables (no migration): one immutable share row per (operation, recipient) in
 * `tool_executions` (status `artifact_share`, owner-scoped by `actorId`) plus the recipient's inbox message in
 * `mock_messages` that carries the artifact reference. The recipient never gets a copy of the artifact: opening the message
 * reloads the owner's exact version and re-authorizes the recipient for its whole stored scope (see openSharedArtifact).
 */
export const ARTIFACT_SHARE_TOOL = 'router.artifact_share' as const;
export const ARTIFACT_SHARE_STATUS = 'artifact_share' as const;

export const artifactShareRowSchema = z.object({
  id: z.string().min(1).max(200), name: z.literal(ARTIFACT_SHARE_TOOL), status: z.literal(ARTIFACT_SHARE_STATUS),
  /** sender (owner of the artifact) */
  actorId: z.string().min(1).max(200), recipientId: z.string().min(1).max(200),
  artifactId: z.string().min(1).max(200), revision: z.number().int().positive(), ref: refSchema,
  operationKey: z.string().min(1).max(200), proposalId: z.string().min(1).max(200), messageId: z.string().min(1).max(200),
  title: z.string().max(200), kind: z.string().max(40), bindingDigest: z.string().min(1).max(200), createdAt: z.string(),
}).strict();
export type ArtifactShareRow = z.infer<typeof artifactShareRowSchema>;

export const shareRowId = (operationKey: string, recipientId: string): string => `artifact-share:${digest({ operationKey, recipientId }).slice(0, 40)}`;
/**
 * The operationKey STORED on one recipient's message row (shares and router inbox messages alike). PostgreSQL enforces one mock_messages
 * row per operationKey (mock_message_operation_unique; SQLite has no such index), so every copy of a multi-recipient operation carries its
 * own deterministic key: base key + recipient. Idempotency is unchanged (row ids still derive from base key + recipient), and a retry derives
 * the same key. An over-long recipient id is replaced by its digest so the key stays within the 200-character schema bound.
 */
export const recipientOperationKey = (operationKey: string, recipientId: string): string => {
  const key = `${operationKey}:${recipientId}`;
  return key.length <= 200 ? key : `${operationKey}:${digest({ recipientId }).slice(0, 40)}`;
};
export const shareMessageId = (operationKey: string, recipientId: string): string => `inbox_${digest({ operationKey, recipientId, kind: 'artifact_share' }).slice(0, 40)}`;
const parseShare = (raw: unknown): ArtifactShareRow | undefined => { const r = artifactShareRowSchema.safeParse(raw); return r.success ? r.data : undefined; };

export interface ShareDelivery { recipientId: string; recipientName: string; messageId: string; shareId: string }
export interface CommitSharesInput {
  sender: Actor; senderName: string; operationKey: string; proposalId: string; bindingDigest: string;
  artifact: { id: string; revision: number; ref: Ref; title: string; kind: string };
  recipients: readonly { id: string; name: string }[];
  now: Date;
  /** Runs INSIDE the writing transaction before the first new row (re-authorization of sender, recipients and the artifact). Throwing aborts with no write. */
  guard?: (tx: Transaction) => Promise<void>;
  /** Builds the inbox row the recipient will see (the caller owns the message schema). */
  inboxRow: (input: { id: string; recipientId: string; operationKey: string; planDigest: string; target: Ref }) => { id: string } & Record<string, unknown>;
  recipientRef: (recipientId: string) => Promise<Ref>;
}

/** Idempotent per (operationKey, recipient): a retry returns the stored rows; a differing row for the same key is a conflict. */
export async function commitArtifactShares(store: Store, input: CommitSharesInput): Promise<ShareDelivery[]> {
  const planDigest = digest({ operationKey: input.operationKey, artifact: input.artifact.ref, bindingDigest: input.bindingDigest });
  const targets = new Map<string, Ref>();
  for (const recipient of input.recipients) targets.set(recipient.id, await input.recipientRef(recipient.id));
  const delivered = await store.transaction(async tx => {
    const out: ShareDelivery[] = [];
    let guarded = false;
    for (const recipient of input.recipients) {
      const id = shareRowId(input.operationKey, recipient.id), messageId = shareMessageId(input.operationKey, recipient.id);
      const prior = await tx.get<unknown>('tool_executions', id);
      if (prior !== undefined) {
        const row = parseShare(prior);
        if (!row || row.actorId !== input.sender.id || row.recipientId !== recipient.id || row.ref.digest !== input.artifact.ref.digest || row.messageId !== messageId) {
          throw new DomainError('ARTIFACT_SHARE_CONFLICT', 'A share with this operation key already exists with a different target', 409);
        }
        out.push({ recipientId: recipient.id, recipientName: recipient.name, messageId, shareId: id });
        continue;
      }
      if (!guarded) { await input.guard?.(tx); guarded = true; }
      const row: ArtifactShareRow = artifactShareRowSchema.parse({ id, name: ARTIFACT_SHARE_TOOL, status: ARTIFACT_SHARE_STATUS, actorId: input.sender.id,
        recipientId: recipient.id, artifactId: input.artifact.id, revision: input.artifact.revision, ref: input.artifact.ref, operationKey: input.operationKey,
        proposalId: input.proposalId, messageId, title: input.artifact.title, kind: input.artifact.kind, bindingDigest: input.bindingDigest, createdAt: input.now.toISOString() });
      await tx.put('tool_executions', row);
      // The message carries a per-recipient key (PostgreSQL's mock_message_operation_unique allows one message row per operationKey); the share row keeps the base key.
      await tx.put('mock_messages', input.inboxRow({ id: messageId, recipientId: recipient.id, operationKey: recipientOperationKey(input.operationKey, recipient.id), planDigest, target: targets.get(recipient.id)! }));
      out.push({ recipientId: recipient.id, recipientName: recipient.name, messageId, shareId: id });
    }
    return out;
  });
  // Independent readback of what each recipient will find: the share row AND the inbox message.
  for (const item of delivered) {
    const row = parseShare(await store.get<unknown>('tool_executions', item.shareId));
    const message = await store.get<{ recipientId?: string; artifact?: { id?: string; revision?: number; digest?: string } }>('mock_messages', item.messageId);
    if (!row || row.recipientId !== item.recipientId || row.ref.digest !== input.artifact.ref.digest || message?.recipientId !== item.recipientId ||
      message.artifact?.digest !== input.artifact.ref.digest) throw new DomainError('ARTIFACT_SHARE_READBACK', 'Shared artifact delivery could not be verified', 500);
  }
  return delivered;
}

export interface SharedLink { share: ArtifactShareRow; message: { id: string; senderName: string; createdAt: string } }

/**
 * The share a recipient may open through ONE of their own inbox messages. The caller then reloads the sender's artifact and
 * re-authorizes the recipient (this lookup alone proves nothing about current authority).
 */
export async function findSharedLink(reader: Reader, recipientId: string, messageId: string): Promise<SharedLink | undefined> {
  const message = await reader.get<{ id: string; recipientId: string; actorId: string; senderName?: string; createdAt: string; artifact?: { id: string; revision: number; digest: string } }>('mock_messages', messageId);
  if (!message || message.recipientId !== recipientId || !message.artifact) return undefined;
  const shares = await reader.list<unknown>('tool_executions', { actorId: message.actorId, status: ARTIFACT_SHARE_STATUS });
  const share = shares.map(parseShare).find((row): row is ArtifactShareRow => !!row && row.messageId === messageId && row.recipientId === recipientId &&
    row.actorId === message.actorId && row.artifactId === message.artifact!.id && row.revision === message.artifact!.revision && row.ref.digest === message.artifact!.digest);
  return share ? { share, message: { id: message.id, senderName: message.senderName ?? '', createdAt: message.createdAt } } : undefined;
}

/** The sender's own outgoing shares of one artifact (for the receipt view). Owner-scoped. */
export async function listOutgoingShares(reader: Reader, senderId: string): Promise<ArtifactShareRow[]> {
  return (await reader.list<unknown>('tool_executions', { actorId: senderId, status: ARTIFACT_SHARE_STATUS })).map(parseShare)
    .filter((row): row is ArtifactShareRow => !!row && row.actorId === senderId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}


/**
 * Owner revocation of ONE artifact share (the exact share row). Shares are immutable rows, so a revoke is a separate tombstone row keyed by the
 * share id (idempotent: a second revoke finds it and writes nothing). Only the sender may revoke; no other grant is touched.
 */
export const ARTIFACT_SHARE_REVOKE_TOOL = 'router.artifact_share_revoke' as const;
export const ARTIFACT_SHARE_REVOKE_STATUS = 'artifact_share_revoke' as const;
export const shareRevokeRowId = (shareId: string): string => `artifact-share-revoke:${shareId}`;
export const artifactShareRevokeRowSchema = z.object({
  id: z.string().min(1).max(260), name: z.literal(ARTIFACT_SHARE_REVOKE_TOOL), status: z.literal(ARTIFACT_SHARE_REVOKE_STATUS),
  actorId: z.string().min(1).max(200), shareId: z.string().min(1).max(200), recipientId: z.string().min(1).max(200),
  artifactId: z.string().min(1).max(200), revision: z.number().int().positive(), revokedAt: z.string(),
}).strict();

export async function isShareRevoked(reader: Pick<Reader, 'get'>, share: Pick<ArtifactShareRow, 'id' | 'actorId'>): Promise<boolean> {
  const raw = await reader.get<unknown>('tool_executions', shareRevokeRowId(share.id));
  return !!raw && artifactShareRevokeRowSchema.safeParse(raw).success && (raw as { actorId?: string }).actorId === share.actorId;
}

/** The sender's CURRENT (not revoked) shares of one artifact, newest first. Owner-scoped. */
export async function listCurrentArtifactShares(reader: Reader, senderId: string, artifactId: string): Promise<ArtifactShareRow[]> {
  const shares = (await listOutgoingShares(reader, senderId)).filter(row => row.artifactId === artifactId);
  const live: ArtifactShareRow[] = [];
  for (const share of shares) if (!(await isShareRevoked(reader, share))) live.push(share);
  return live;
}

export async function revokeArtifactShareInTx(tx: Transaction, sender: Actor, artifactId: string, shareId: string, now: Date): Promise<{ share: ArtifactShareRow; alreadyRevoked: boolean }> {
  const share = parseShare(await tx.get<unknown>('tool_executions', shareId));
  if (!share || share.actorId !== sender.id || share.artifactId !== artifactId) throw new DomainError('NOT_FOUND', 'ไม่พบการแชร์ที่ระบุ', 404);
  if (await isShareRevoked(tx, share)) return { share, alreadyRevoked: true };
  await tx.put('tool_executions', artifactShareRevokeRowSchema.parse({ id: shareRevokeRowId(share.id), name: ARTIFACT_SHARE_REVOKE_TOOL, status: ARTIFACT_SHARE_REVOKE_STATUS,
    actorId: sender.id, shareId: share.id, recipientId: share.recipientId, artifactId: share.artifactId, revision: share.revision, revokedAt: now.toISOString() }));
  return { share, alreadyRevoked: false };
}

/**
 * THE one current-share resolver every shared read / drill path uses before a grant is issued: the recipient's own inbox link exists, the
 * share row is intact, it has NOT been revoked, and the sender is still an active profile. Throws a Thai DomainError otherwise.
 */
export async function resolveCurrentShare(reader: Reader, recipientId: string, messageId: string): Promise<SharedLink & { sender: { id: string; name: string; role: string } }> {
  const link = await findSharedLink(reader, recipientId, messageId);
  if (!link) throw new DomainError('NOT_FOUND', 'ไม่พบผลลัพธ์ที่แชร์', 404);
  if (await isShareRevoked(reader, link.share)) throw new DomainError('SHARE_REVOKED', 'ผู้แชร์เพิกถอนการแชร์ผลลัพธ์นี้แล้ว', 403);
  const sender = await reader.get<{ id: string; name: string; role: string; active: boolean }>('profiles', link.share.actorId);
  if (!sender || !sender.active || sender.id !== link.share.actorId) throw new DomainError('FORBIDDEN', 'ผู้แชร์ไม่อยู่ในสถานะที่แชร์ผลลัพธ์ได้แล้ว', 403);
  return { ...link, sender: { id: sender.id, name: sender.name, role: sender.role } };
}
