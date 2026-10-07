import { z } from 'zod';
import type { Actor, Store } from '../../contracts';
import { DomainError } from '../../core/errors';
import type { StagedActionId, StagedPorts, StagedProposal, TurnRef } from '../executors/action-ports';

/**
 * Router-staged proposals (dashboard.delete, communication.send, monitor.create) live in the `router_proposals`
 * table of BOTH stores (SQLite creates it from `tables`; Supabase needs migration 202610060900_router_proposals.sql).
 *
 * Lifetime: the PROPOSAL is valid for 24 h (same as built-in PendingActions). The Wave 4 preview TOKEN inside
 * `data.workflow.preview` / `data.state.workflow.preview` keeps its own 10 min TTL; confirmProposal re-previews
 * the stored plan when only the token expired, so a still-pending proposal stays confirmable.
 *
 * Concurrency: rows carry a monotonically increasing `revision`. Every transition reads the row inside a store
 * transaction and writes revision+1; callers may pass `expectedRevision` for an explicit CAS. Terminal states are final.
 */
export const STAGED_PROPOSAL_TTL_MS = 24 * 3_600_000;
/** A claim is a lease: a confirmer that crashed mid-execution leaves a row the next confirm may reclaim after this long. */
export const STAGED_CLAIM_LEASE_MS = 2 * 60_000;
const MAX_DATA_BYTES = 256 * 1024;
const idSchema = z.string().min(1).max(200);

export const stagedRowSchema = z.object({
  id: idSchema, schemaVersion: z.literal(1),
  actorId: idSchema, conversationId: idSchema, turnId: idSchema,
  actionId: z.enum(['dashboard.delete', 'dashboard.revoke_share', 'dashboard.refine', 'dashboard.rename', 'monitor.delete', 'communication.send', 'monitor.create', 'artifact.share', 'task.create', 'policy.acknowledge',
    'onboarding.director_approve', 'onboarding.return', 'onboarding.notify_email']),
  sessionId: idSchema.optional(), mode: z.enum(['scripted_demo', 'live_ai']).optional(), modeRevision: z.number().int().min(0).optional(),
  claimExpiresAt: z.number().int().positive().optional(), claimToken: z.string().min(8).max(200).optional(),
  digest: z.string().min(1).max(200),
  status: z.enum(['pending', 'claimed', 'completed', 'cancelled', 'stale']),
  expiresAt: z.number().int().positive(), createdAt: z.number().int().positive(), updatedAt: z.number().int().positive(),
  revision: z.number().int().min(1),
  preview: z.string().max(4000),
  data: z.record(z.string(), z.unknown()),
}).strict().superRefine((row, ctx) => {
  if (JSON.stringify(row.data).length > MAX_DATA_BYTES) ctx.addIssue({ code: 'custom', message: 'data too large', path: ['data'] });
});
export type StagedRow = z.infer<typeof stagedRowSchema>;
const TABLE = 'router_proposals' as const;

/** What an effect write must still hold, checked INSIDE the transaction that writes the effect (Luna F10). */
export interface StagedFence { proposalId: string; actorId: string; claimToken?: string; currentSessionId: string }
export const STAGED_MODE_CHANGED_CODE = 'STAGED_MODE_CHANGED';

/**
 * Atomic pre-effect fence: (1) the proposal is still claimed by THIS confirm (claim token), (2) the session that created
 * it still has the mode + mode revision it was made under (a mode switch there stales it), and (3) the confirming
 * session (which may be another login of the same actor) is in that same mode. Throws inside the transaction, so a mode
 * change that commits after the confirm's earlier checks can never be followed by the effect write.
 */
export async function assertStagedFence(tx: Pick<Store, 'get'>, fence: StagedFence): Promise<void> {
  const parsed = stagedRowSchema.safeParse(await tx.get<unknown>(TABLE, fence.proposalId));
  if (!parsed.success || parsed.data.actorId !== fence.actorId || parsed.data.status !== 'claimed'
    || (fence.claimToken !== undefined && parsed.data.claimToken !== fence.claimToken)) {
    throw new DomainError('STAGED_CLAIM_LOST', 'The proposal is no longer claimed by this confirmation', 409);
  }
  const row = parsed.data;
  if (row.mode === undefined) return;
  const changed = (): never => { throw new DomainError(STAGED_MODE_CHANGED_CODE, 'The session mode changed before the effect was written', 409); };
  if (row.sessionId !== undefined) {
    const creating = await tx.get<{ mode?: string; modeRevision?: number }>('sessions', row.sessionId);
    // Fail closed: a creating session that cannot be read can no longer vouch for the mode the proposal was made under.
    if (!creating || (creating.mode !== row.mode || (row.modeRevision !== undefined && creating.modeRevision !== row.modeRevision))) changed();
  }
  const current = await tx.get<{ mode?: string; modeRevision?: number }>('sessions', fence.currentSessionId);
  if (!current || current.mode !== row.mode) changed();
}

export interface StagedStoreOptions { now?: () => number; newId?: () => string }
export interface StagedSavePatch { status: StagedProposal['status']; data?: Record<string, unknown>; expectedRevision?: number; /** Required to finish a claimed row: only the CURRENT claimant (token CAS) may write it. */ claimToken?: string }
export interface StagedStore extends StagedPorts {
  /** Proposals of this actor+conversation, newest first. Other actors/conversations are never returned. */
  list(actor: Actor, conversationId: string, filter?: { status?: StagedProposal['status']; includeExpired?: boolean }): Promise<StagedProposal[]>;
  /** Like get, but additionally requires the conversation to match. */
  getInConversation(actor: Actor, conversationId: string, id: string): Promise<StagedProposal | undefined>;
  revisionOf(actor: Actor, id: string): Promise<number | undefined>;
  save(actor: Actor, id: string, patch: StagedSavePatch): Promise<StagedProposal>;
  /** Marks every still-pending proposal created by this turn stale (failed/cancelled turn cleanup). Returns the count. */
  staleForTurn(actor: Actor, conversationId: string, turnId: string): Promise<number>;
}

const toProposal = (row: StagedRow): StagedProposal => ({
  id: row.id, actorId: row.actorId, conversationId: row.conversationId, turnId: row.turnId, actionId: row.actionId as StagedActionId, digest: row.digest,
  status: row.status, expiresAt: row.expiresAt, preview: row.preview, data: row.data,
  ...(row.sessionId !== undefined ? { sessionId: row.sessionId } : {}), ...(row.mode !== undefined ? { mode: row.mode } : {}),
  ...(row.modeRevision !== undefined ? { modeRevision: row.modeRevision } : {}), ...(row.claimExpiresAt !== undefined ? { claimExpiresAt: row.claimExpiresAt } : {}),
  ...(row.claimToken !== undefined ? { claimToken: row.claimToken } : {}),
});
const fail = (code: string, message: string, status = 409): never => { throw new DomainError(code, message, status); };

function parseRow(raw: unknown): StagedRow {
  const parsed = stagedRowSchema.safeParse(raw);
  if (!parsed.success) return fail('STAGED_INVALID', 'Staged proposal row failed validation', 500);
  return parsed.data;
}

export function createStagedStore(store: Store, options: StagedStoreOptions = {}): StagedStore {
  const now = options.now ?? Date.now;
  const newId = options.newId ?? (() => `stg_${crypto.randomUUID()}`);
  const newToken = () => `clm_${crypto.randomUUID()}`;

  async function owned(reader: Pick<Store, 'get'>, actor: Actor, id: string): Promise<StagedRow | undefined> {
    const raw = await reader.get<unknown>(TABLE, id);
    if (raw === undefined) return undefined;
    const row = parseRow(raw);
    return row.actorId === actor.id ? row : undefined;
  }
  async function pendingByDigest(reader: Pick<Store, 'list'>, actor: Actor, conversationId: string, digest: string): Promise<StagedRow | undefined> {
    const rows = (await reader.list<unknown>(TABLE, { actorId: actor.id, status: 'pending' })).map(parseRow);
    return rows.filter(r => r.actorId === actor.id && r.conversationId === conversationId && r.digest === digest && r.status === 'pending' && r.expiresAt > now())
      .sort((a, b) => b.createdAt - a.createdAt)[0];
  }

  return {
    async findPending(actor, conversationId, digest) {
      const row = await pendingByDigest(store, actor, conversationId, digest);
      return row ? toProposal(row) : undefined;
    },
    async create(actor, ref: TurnRef, input) {
      const t = now();
      if (!Number.isFinite(input.expiresAt) || input.expiresAt <= t) return fail('STAGED_EXPIRY', 'Staged proposal expiry must be in the future', 400);
      const expiresAt = Math.min(Math.floor(input.expiresAt), t + STAGED_PROPOSAL_TTL_MS);
      return store.transaction(async tx => {
        const existing = await pendingByDigest(tx, actor, ref.conversationId, input.digest);
        if (existing) return toProposal(existing);
        const row = parseRow({ id: newId(), schemaVersion: 1, actorId: actor.id, conversationId: ref.conversationId, turnId: ref.turnId,
          actionId: input.actionId, digest: input.digest, status: 'pending', expiresAt, createdAt: t, updatedAt: t, revision: 1,
          sessionId: actor.sessionId, mode: actor.mode, modeRevision: actor.modeRevision,
          preview: input.preview, data: input.data });
        await tx.put(TABLE, row);
        return toProposal(row);
      });
    },
    async get(actor, id) {
      const row = await owned(store, actor, id);
      return row ? toProposal(row) : undefined;
    },
    async getInConversation(actor, conversationId, id) {
      const row = await owned(store, actor, id);
      return row && row.conversationId === conversationId ? toProposal(row) : undefined;
    },
    async revisionOf(actor, id) { return (await owned(store, actor, id))?.revision; },
    async list(actor, conversationId, filter = {}) {
      const t = now();
      const rows = (await store.list<unknown>(TABLE, { actorId: actor.id, ...(filter.status ? { status: filter.status } : {}) })).map(parseRow);
      return rows.filter(r => r.actorId === actor.id && r.conversationId === conversationId && (filter.includeExpired || filter.status !== 'pending' || r.expiresAt > t))
        .sort((a, b) => b.createdAt - a.createdAt).map(toProposal);
    },
    async claim(actor, id) {
      const t = now();
      return store.transaction(async tx => {
        const row = await owned(tx, actor, id);
        if (!row || row.expiresAt <= t) return undefined;
        // pending -> claimed, or an EXPIRED lease (crashed confirmer) -> re-claimed; a live lease is never stolen.
        const reclaimable = row.status === 'claimed' && (row.claimExpiresAt ?? 0) <= t;
        if (row.status !== 'pending' && !reclaimable) return undefined;
        // Mode fence inside the claim transaction: the session's CURRENT mode revision must still be the one the proposal was made under.
        if (row.sessionId !== undefined && row.modeRevision !== undefined) {
          const session = await tx.get<{ mode?: string; modeRevision?: number }>('sessions', row.sessionId);
          if (!session || (session.modeRevision !== row.modeRevision || (row.mode !== undefined && session.mode !== row.mode))) {
            await tx.put(TABLE, parseRow({ ...row, status: 'stale', claimToken: undefined, claimExpiresAt: undefined, updatedAt: t, revision: row.revision + 1 }));
            return undefined;
          }
        }
        // A fresh random token per claim: every later write is a CAS on it, so a superseded claimant can never overwrite a newer claim.
        const claimed = parseRow({ ...row, status: 'claimed', claimToken: newToken(), claimExpiresAt: t + STAGED_CLAIM_LEASE_MS, updatedAt: t, revision: row.revision + 1 });
        await tx.put(TABLE, claimed);
        return toProposal(claimed);
      });
    },
    async staleForTurn(actor, conversationId, turnId) {
      const t = now();
      return store.transaction(async tx => {
        const rows = (await tx.list<unknown>(TABLE, { actorId: actor.id, status: 'pending' })).map(parseRow)
          .filter(r => r.actorId === actor.id && r.conversationId === conversationId && r.turnId === turnId && r.status === 'pending');
        for (const row of rows) await tx.put(TABLE, parseRow({ ...row, status: 'stale', updatedAt: t, revision: row.revision + 1 }));
        return rows.length;
      });
    },
    async save(actor, id, patch) {
      const t = now();
      return store.transaction(async tx => {
        const row = await owned(tx, actor, id);
        if (!row) return fail('STAGED_NOT_FOUND', 'Staged proposal not found', 404);
        if (patch.expectedRevision !== undefined && patch.expectedRevision !== row.revision) return fail('STAGED_CONFLICT', 'Staged proposal changed concurrently');
        if (row.status === 'claimed') {
          // Only the CURRENT claimant (matching token) may finish the row, exactly once.
          if (row.claimToken !== undefined && patch.claimToken !== row.claimToken) return fail('STAGED_CLAIM_LOST', 'The claim on this proposal was superseded');
          if (patch.status !== 'completed' && patch.status !== 'stale') return fail('STAGED_CONFLICT', 'A claimed proposal can only complete or go stale');
          const done = parseRow({ ...row, claimToken: undefined, claimExpiresAt: undefined, status: patch.status, data: patch.data ?? row.data, updatedAt: t, revision: row.revision + 1 });
          await tx.put(TABLE, done);
          return toProposal(done);
        }
        if (row.status !== 'pending') {
          // Terminal states are final; an identical repeat is an idempotent no-op.
          if (row.status === patch.status && patch.data === undefined) return toProposal(row);
          return fail('STAGED_CONFLICT', 'Staged proposal is no longer pending');
        }
        if (patch.status === 'completed' && row.expiresAt <= t) return fail('STAGED_EXPIRED', 'Staged proposal expired');
        const next = parseRow({ ...row, status: patch.status, data: patch.data ?? row.data, updatedAt: t, revision: row.revision + 1 });
        await tx.put(TABLE, next);
        return toProposal(next);
      });
    },
  };
}
