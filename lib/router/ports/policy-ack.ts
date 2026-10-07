import { z } from 'zod';
import type { Actor, PolicyDocument, Profile, Reader, Store } from '../../contracts';
import { DomainError } from '../../core/errors';
import { canReadPolicy } from '../../dynamic/catalog/policy';
import { digest } from '../../dynamic/shared';
import type { EffectFence } from '../executors/action-ports';

/**
 * POLICY-001: an actor's acknowledgement of ONE exact policy document id + version. Stored on the existing `tool_executions` table (status
 * `policy_ack`, owner-scoped by `actorId`); created only through a confirmed, claimed router proposal inside one transaction that
 * re-authorizes the actor against the document and re-reads its current version. Idempotent per actor + policy + version (deterministic id).
 */
export const POLICY_ACK_TOOL = 'router.policy_ack' as const;
export const POLICY_ACK_STATUS = 'policy_ack' as const;
export const POLICY_CHANGED_CODE = 'POLICY_CHANGED';

export const policyAckRowSchema = z.object({
  id: z.string().min(1).max(200), name: z.literal(POLICY_ACK_TOOL), status: z.literal(POLICY_ACK_STATUS), actorId: z.string().min(1).max(200),
  policyId: z.string().min(1).max(100), policyVersion: z.string().min(1).max(100), policyTitle: z.string().max(300),
  /** Digest of the exact document text the actor acknowledged (proof of what was read, not the text itself). */
  textDigest: z.string().regex(/^[a-f0-9]{64}$/), proposalId: z.string().min(1).max(200), acknowledgedAt: z.string(),
}).strict();
export type PolicyAckRow = z.infer<typeof policyAckRowSchema>;
export const policyAckRowId = (actorId: string, policyId: string, version: string): string => `policy-ack:${digest({ actorId, policyId, version }).slice(0, 32)}`;
const parse = (raw: unknown): PolicyAckRow | undefined => { const r = policyAckRowSchema.safeParse(raw); return r.success ? r.data : undefined; };

export type PolicyAckCheck =
  | { ok: true; doc: PolicyDocument; existing: PolicyAckRow | undefined }
  | { ok: false; code: 'permission_denied' | 'policy_unavailable' | 'policy_changed'; current?: string };

export interface PolicyAckEffects {
  /** Prepare/confirm check: the actor is active, may read the document under CURRENT permissions, and the exact version is still current. */
  check(actor: Actor, input: { policyId: string; version: string }, reader?: Reader): Promise<PolicyAckCheck>;
  acknowledge(actor: Actor, input: { policyId: string; version: string; proposalId: string; fence?: EffectFence }):
    Promise<{ row: PolicyAckRow; already: boolean }>;
}

export function createPolicyAckEffects(deps: { store: Store; now: () => Date }): PolicyAckEffects {
  const { store } = deps;
  async function check(actor: Actor, input: { policyId: string; version: string }, reader: Reader = store): Promise<PolicyAckCheck> {
    const profile = await reader.get<Profile>('profiles', actor.id);
    if (!profile?.active || profile.id !== actor.id) return { ok: false, code: 'permission_denied' };
    const doc = await reader.get<PolicyDocument>('policy_documents', input.policyId);
    // Missing and forbidden documents are indistinguishable.
    if (!doc || !canReadPolicy(profile.permissions, doc.id)) return { ok: false, code: 'policy_unavailable' };
    if (doc.version !== input.version) return { ok: false, code: 'policy_changed', current: doc.version };
    const existing = parse(await reader.get<unknown>('tool_executions', policyAckRowId(actor.id, doc.id, doc.version)));
    return { ok: true, doc, existing: existing?.actorId === actor.id ? existing : undefined };
  }
  return {
    check,
    async acknowledge(actor, input) {
      const outcome = await store.transaction(async tx => {
        await input.fence?.(tx);
        const checked = await check(actor, input, tx);
        if (!checked.ok) {
          const changed = checked.code === 'policy_changed';
          throw new DomainError(changed ? POLICY_CHANGED_CODE : 'AUTHORITY_CHANGED', 'Policy authority or version changed before the acknowledgement was recorded', changed ? 409 : 403);
        }
        if (checked.existing) return { row: checked.existing, already: true };
        const id = policyAckRowId(actor.id, checked.doc.id, checked.doc.version);
        if (await tx.get('tool_executions', id) !== undefined) throw new DomainError('POLICY_ACK_CONFLICT', 'Acknowledgement id conflict', 409);
        const created: PolicyAckRow = policyAckRowSchema.parse({ id, name: POLICY_ACK_TOOL, status: POLICY_ACK_STATUS, actorId: actor.id, policyId: checked.doc.id,
          policyVersion: checked.doc.version, policyTitle: checked.doc.title, textDigest: digest(checked.doc.text), proposalId: input.proposalId, acknowledgedAt: deps.now().toISOString() });
        await tx.put('tool_executions', created);
        return { row: created, already: false };
      });
      // Independent readback of the stored acknowledgement.
      const back = parse(await store.get<unknown>('tool_executions', outcome.row.id));
      if (!back || back.actorId !== actor.id || back.policyId !== input.policyId || back.policyVersion !== input.version) throw new DomainError('POLICY_ACK_READBACK', 'ยังยืนยันผลการรับทราบเอกสารไม่ได้ กรุณาตรวจสถานะก่อนส่งคำขอใหม่', 500);
      return { row: back, already: outcome.already };
    },
  };
}

/** The actor's own acknowledgements, newest first. */
export async function listPolicyAcknowledgements(store: Pick<Store, 'list'>, actor: Pick<Actor, 'id'>): Promise<PolicyAckRow[]> {
  return (await store.list<unknown>('tool_executions', { actorId: actor.id, status: POLICY_ACK_STATUS })).map(parse)
    .filter((r): r is PolicyAckRow => !!r && r.actorId === actor.id).sort((a, b) => b.acknowledgedAt.localeCompare(a.acknowledgedAt)).slice(0, 100);
}
