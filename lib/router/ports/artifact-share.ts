import type { Actor, Branch, Profile, Reader, Store } from '../../contracts';
import { DomainError } from '../../core/errors';
import { loadStoredArtifact } from '../../artifacts/store';
import { authorizeArtifactShare, type ArtifactSharePolicy, type ShareAuthority } from '../../artifacts/share';
import { commitArtifactShares } from '../../artifacts/shared-store';
import { createSemanticCatalog } from '../../dynamic/catalog/semantic';
import { authority as queryAuthority } from '../../dynamic/runtime';
import { digest, unique } from '../../dynamic/shared';
import { personLabel } from '../context/display';
import type { ArtifactShareBindResult, ArtifactShareEffects } from '../executors/action-ports';
import { INBOX_KIND, inboxRowSchema } from './effect-store';
import { recipientSnapshot } from './effect-snapshots';

export interface ArtifactShareDeps {
  store: Store; now: () => Date;
  /** Same server recipient policy the other effects use; `reader` = the transaction an in-transaction re-check runs in. */
  recipientAllowed: (actor: Actor, recipientId: string, reader?: Reader) => Promise<boolean>;
}

const TEXT = {
  sender: 'บัญชีนี้ยังไม่มีสิทธิ์แชร์ผลลัพธ์ จึงไม่ได้เตรียมรายการ',
  artifact: 'ไม่พบผลลัพธ์ของคุณตามที่ระบุ หรือสิทธิ์ปัจจุบันไม่ครอบคลุมผลลัพธ์นี้ จึงไม่ได้เตรียมการแชร์',
  recipient: 'ผู้รับรายนี้ไม่อยู่ในรายชื่อที่บัญชีนี้ส่งถึงได้ จึงไม่ได้ดำเนินการ',
  scope: 'ผู้รับบางรายยังไม่มีสิทธิ์ดูข้อมูลครบทุกส่วนของผลลัพธ์นี้ จึงไม่ได้แชร์ — ระบบไม่แชร์เฉพาะบางส่วนหรือตัดข้อมูลให้',
  policy: 'นโยบายการแชร์ไม่อนุญาตให้ส่งผลลัพธ์นี้ให้ผู้รับที่ระบุ จึงไม่ได้ดำเนินการ',
} as const;
export const SHARE_AUTHORITY_CHANGED = 'AUTHORITY_CHANGED';

export function createArtifactShareEffects(deps: ArtifactShareDeps): ArtifactShareEffects {
  const { store } = deps;

  async function bind(actor: Actor, input: { artifactId: string; recipientIds: string[]; revision?: number }, reader: Reader = store): Promise<ArtifactShareBindResult> {
    const deny = (code: string, text: string): ArtifactShareBindResult => ({ ok: false, code, text });
    const profile = await reader.get<Profile>('profiles', actor.id);
    if (!profile || !profile.active || profile.id !== actor.id) return deny('permission_denied', TEXT.sender);
    const sender: Actor = { ...profile, sessionId: actor.sessionId, mode: actor.mode, modeRevision: actor.modeRevision };
    const catalog = createSemanticCatalog(await reader.list<Branch>('branches'));
    const senderAuthority: ShareAuthority = { ...queryAuthority(sender), catalogDigest: catalog.digest, role: sender.role };
    if (!senderAuthority.permissions.includes('dashboard.share')) return deny('permission_denied', TEXT.sender);
    const ids = unique(input.recipientIds);
    if (!ids.length || ids.length > 20 || ids.includes(sender.id)) return deny('recipient_denied', TEXT.recipient);

    let loaded;
    try { loaded = await loadStoredArtifact(reader, senderAuthority, input.artifactId, input.revision); }
    catch (error) { if (error instanceof DomainError && [403, 404].includes(error.status)) return deny('artifact_unavailable', TEXT.artifact); throw error; }

    const recipients: { profile: Profile; authority: ShareAuthority }[] = [];
    for (const id of ids) {
      const recipient = await reader.get<Profile>('profiles', id);
      // A recipient that does not exist, is inactive, or fails the server recipient policy is indistinguishable from any other denial.
      if (!recipient || recipient.id !== id || !(await deps.recipientAllowed(sender, id, reader))) return deny('recipient_denied', TEXT.recipient);
      recipients.push({ profile: recipient, authority: { id: recipient.id, active: recipient.active, permissions: [...recipient.permissions],
        regions: [...recipient.regions], revision: 1, catalogDigest: catalog.digest, role: recipient.role } });
    }
    const policy: ArtifactSharePolicy = { senderId: sender.id, recipientIds: recipients.map(r => r.profile.id),
      permittedRolePairs: unique(recipients.map(r => `${sender.role}>${r.profile.role}`)).map(pair => { const [s, r] = pair.split('>'); return { sender: s, recipient: r }; }) };
    const previews = [];
    for (const recipient of recipients) {
      const result = authorizeArtifactShare({ proposal: { version: 1, artifact: loaded.artifact.ref, recipientId: recipient.profile.id, channelId: 'in_app' },
        record: loaded.artifact, sender: senderAuthority, recipient: recipient.authority, policy, now: deps.now });
      if (result.outcome !== 'accepted') return deny(result.code, result.code === 'artifact_recipient_scope' ? TEXT.scope : result.code === 'artifact_share_authority' ? TEXT.policy : TEXT.artifact);
      previews.push(result.preview);
    }
    const bindingDigest = digest({ artifact: loaded.artifact.ref, sender: previews[0].sender, recipients: previews.map(p => p.recipient).sort((a, b) => a.id.localeCompare(b.id)),
      policy: previews[0].policyDigest, scope: previews[0].scope });
    return { ok: true, binding: {
      artifact: { id: loaded.artifact.artifactId, revision: loaded.artifact.revision, kind: loaded.artifact.plan.artifactTypeId, title: loaded.artifact.plan.title, digest: loaded.artifact.ref.digest },
      recipients: recipients.map(r => ({ id: r.profile.id, name: personLabel(r.profile) })),
      scope: { regions: [...loaded.artifact.bundle.scope.regions], branchIds: [...loaded.artifact.bundle.scope.branchIds] }, bindingDigest } };
  }

  return {
    bind,
    async deliver(actor, input) {
      const now = deps.now();
      const first = await bind(actor, input);
      if (!first.ok) return first;
      if (first.binding.bindingDigest !== input.bindingDigest || first.binding.artifact.revision !== input.revision) {
        return { ok: false, code: 'authority_changed', text: 'สิทธิ์ ผู้รับ หรือผลลัพธ์เปลี่ยนไปแล้ว จึงไม่ได้แชร์ — โปรดขอใหม่' };
      }
      const profile = (await store.get<Profile>('profiles', actor.id))!;
      const senderName = personLabel(profile);
      const operationKey = `ashare_${digest({ proposalId: input.proposalId, artifact: first.binding.artifact.digest }).slice(0, 32)}`;
      const refs = new Map<string, Awaited<ReturnType<typeof recipientRef>>>();
      async function recipientRef(id: string) { const p = await store.get<Profile>('profiles', id); if (!p) throw new DomainError('NOT_FOUND', 'Recipient missing', 404); return recipientSnapshot(p).ref; }
      for (const r of first.binding.recipients) refs.set(r.id, await recipientRef(r.id));
      const artifact = first.binding.artifact;
      const delivered = await commitArtifactShares(store, {
        sender: actor, senderName, operationKey, proposalId: input.proposalId, bindingDigest: input.bindingDigest,
        artifact: { id: artifact.id, revision: artifact.revision, ref: { id: artifact.id, version: artifact.revision, digest: artifact.digest }, title: artifact.title, kind: artifact.kind },
        recipients: first.binding.recipients, now,
        // Re-authorization INSIDE the writing transaction: sender, every recipient and the artifact scope must still bind to the approved digest.
        guard: async tx => {
          await input.fence?.(tx);
          const again = await bind(actor, input, tx);
          if (!again.ok || again.binding.bindingDigest !== input.bindingDigest) throw new DomainError(SHARE_AUTHORITY_CHANGED, 'Sender, recipient or artifact authority changed before delivery', 403);
        },
        recipientRef: async id => refs.get(id) ?? recipientRef(id),
        inboxRow: ({ id, recipientId, operationKey: key, planDigest, target }) => inboxRowSchema.parse({ id, kind: INBOX_KIND, actorId: actor.id, senderName,
          recipientId, source: 'artifact_share', title: `ผลลัพธ์ที่แชร์: ${artifact.title}`.slice(0, 200),
          content: `${senderName} แชร์ผลลัพธ์ “${artifact.title}” (ฉบับที่ ${artifact.revision}) ให้คุณ — เปิดดูได้อย่างเดียว ข้อมูลทั้งหมดอยู่ในขอบเขตที่คุณมีสิทธิ์`.slice(0, 4000),
          channelId: 'simulated_inbox', operationKey: key, planDigest, target, createdAt: now.toISOString(), readAt: null,
          artifact: { id: artifact.id, revision: artifact.revision, digest: artifact.digest, kind: artifact.kind } }),
      });
      return { ok: true, artifact, delivered: delivered.map(d => ({ recipientId: d.recipientId, recipientName: d.recipientName, messageId: d.messageId })) };
    },
  };
}
