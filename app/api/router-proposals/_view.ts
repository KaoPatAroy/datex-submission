import type { Actor, Profile, Store } from '@/lib/contracts';
import { ConciergeService } from '@/lib/core/service';
import { DomainError } from '@/lib/core/errors';
import { sameModeFence, stagedRequiredPermissions, type ConfirmResult, type StagedReceipt } from '@/lib/router/executors/action';
import { loadAcceptedEvidence } from '@/lib/router/ports/effect-bindings';
import { createArtifactShareEffects } from '@/lib/router/ports/artifact-share';
import { createRecipientPolicy } from '@/lib/router/ports/recipient-policy';
import { personLabel } from '@/lib/router/context/display';
import { createStagedStore, stagedRowSchema, type StagedRow } from '@/lib/router/storage/staged-store';
import { isMissingTableError } from '@/lib/storage/read-error';
import { paginate, type Page, type PageInput } from '@/lib/pagination';

/** Client-safe view of a router-staged proposal. Never carries workflow preview tokens or other server state. */
export interface RouterProposalView {
  id: string;
  conversationId: string;
  turnId: string;
  actionId: StagedRow['actionId'];
  status: StagedRow['status'];
  /** epoch ms */
  expiresAt: number;
  createdAt: number;
  /** Thai preview authored by the server. */
  preview: string;
  /** The exact parameters the confirmation acts on (ids only; primitives and string lists). */
  details: Record<string, string | number | boolean | string[]>;
  /** false when the CURRENT actor no longer holds the authority the proposal needs: the preview is redacted and confirm is disabled. */
  confirmable: boolean;
}

export const NOT_CONFIRMABLE_PREVIEW = 'รายการนี้ไม่อยู่ในสิทธิ์หรือขอบเขตของคุณแล้ว จึงยืนยันไม่ได้ — โปรดยกเลิกแล้วขอใหม่';

const MAX_DETAIL_ITEMS = 50;

/** Whitelist of user-reviewable params: primitives and string lists only; everything else stays server-side. */
export function proposalDetails(data: Record<string, unknown>): RouterProposalView['details'] {
  const params = data.params && typeof data.params === 'object' && !Array.isArray(data.params) ? data.params as Record<string, unknown> : {};
  const out: RouterProposalView['details'] = {};
  for (const [key, value] of Object.entries(params).slice(0, MAX_DETAIL_ITEMS)) {
    if (typeof value === 'string') out[key] = value.slice(0, 500);
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
    else if (Array.isArray(value) && value.every(item => typeof item === 'string')) out[key] = (value as string[]).slice(0, MAX_DETAIL_ITEMS).map(item => item.slice(0, 200));
  }
  return out;
}

export function toProposalView(row: StagedRow, confirmable = true, details?: RouterProposalView['details']): RouterProposalView {
  return { id: row.id, conversationId: row.conversationId, turnId: row.turnId, actionId: row.actionId, status: row.status === 'claimed' ? 'pending' : row.status, expiresAt: row.expiresAt,
    createdAt: row.createdAt, preview: confirmable ? row.preview : NOT_CONFIRMABLE_PREVIEW, details: confirmable ? details ?? proposalDetails(row.data) : {}, confirmable };
}

/**
 * User-visible details: server-owned Thai display values for the whitelisted params (people by Thai role name, the answer
 * by description, dashboards/monitors by title, thresholds as a percentage). Raw ids and internal param names never reach
 * the screen; unknown params are not shown.
 */
export async function displayDetails(store: Store, row: StagedRow): Promise<RouterProposalView['details']> {
  const raw = proposalDetails(row.data);
  const out: RouterProposalView['details'] = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'recipientIds' && Array.isArray(value)) {
      const names: string[] = [];
      for (const id of value) {
        const profile = await store.get<Profile>('profiles', id).catch(() => undefined);
        names.push(profile ? personLabel(profile) : 'ผู้รับที่ไม่พบในระบบ');
      }
      out[key] = names;
    } else if (key === 'contentStateId' || key === 'queryStateId') out[key] = 'คำตอบที่ตรวจสอบแล้วในบทสนทนานี้ (ตามตัวอย่างด้านบน)';
    else if (key === 'dashboardId' && typeof value === 'string') {
      const dashboard = await store.get<{ spec?: { title?: string } }>('dashboards', value).catch(() => undefined);
      out[key] = dashboard?.spec?.title ?? 'Dashboard ของคุณ';
    } else if (key === 'artifactId' && typeof value === 'string') {
      const head = await store.get<{ actorId?: string; title?: string }>('tool_executions', `artifact-head:${value}`).catch(() => undefined);
      out[key] = head?.actorId === row.actorId && head.title ? `“${head.title}”` : 'ผลลัพธ์ของคุณ';
    } else if (key === 'assigneeId' && typeof value === 'string') {
      const profile = await store.get<Profile>('profiles', value).catch(() => undefined);
      // Keep the prepared directory label: formatting one profile alone loses purpose/account distinctions.
      out[key] = profile && row.actionId === 'task.create' && typeof row.data.assigneeLabel === 'string' && row.data.assigneeLabel.trim()
        ? row.data.assigneeLabel : profile ? personLabel(profile) : 'ผู้รับผิดชอบที่ไม่พบในระบบ';
    } else if (key === 'priority' && typeof value === 'string') out[key] = ({ low: 'ต่ำ', normal: 'ปกติ', high: 'สูง', urgent: 'ด่วน' } as Record<string, string>)[value] ?? value;
    else if (key === 'grouping' && typeof value === 'string') out[key] = value === 'per_branch' ? 'แยกเป็นรายสาขา' : 'งานเดียว';
    else if ((key === 'dueDate' || key === 'note') && typeof value === 'string') { if (value) out[key] = value; }
    else if (key === 'checklist' && Array.isArray(value)) out[key] = value;
    else if (key === 'branchIds' && Array.isArray(value)) out[key] = value;
    else if (key === 'revision' && typeof value === 'number') out[key] = value;
    else if (key === 'monitorId') out[key] = typeof row.data.title === 'string' ? row.data.title : 'Monitor ของคุณ';
    else if (key === 'threshold' && typeof value === 'number') out[key] = `ต่ำกว่า ${Math.round(value * 10000) / 100}% ของเป้า`;
    else if (key === 'title' && typeof value === 'string') out[key] = value;
    // HR Director proposals: server-built display labels (employee name + start date, recipient display names), subject and reason.
    else if ((key === 'requestLabels' || key === 'recipientLabels') && Array.isArray(value)) out[key] = value;
    else if ((key === 'subject' || key === 'reason') && typeof value === 'string') out[key] = value;
  }
  return out;
}

/**
 * Re-validates one stored proposal against the CURRENT actor (fresh profile, permissions, mode, recipients, evidence scope,
 * dashboard ownership). Confirm re-checks everything again; this keeps a stale preview from being shown after authority shrank.
 */
async function stillAuthorized(store: Store, actor: Actor, row: StagedRow): Promise<boolean> {
  try {
    const profile = await store.get<Profile>('profiles', actor.id);
    if (!profile?.active || profile.id !== actor.id) return false;
    const fresh: Actor = { ...profile, sessionId: actor.sessionId, mode: actor.mode, modeRevision: actor.modeRevision };
    const required = stagedRequiredPermissions(row.actionId);
    if (!required || !required.every(permission => fresh.permissions.includes(permission))) return false;
    // Same actor + same mode from any of their sessions (sameModeFence); the creating session must still be in its mode.
    if (!sameModeFence(row, actor)) return false;
    if (row.sessionId !== undefined && row.mode !== undefined) {
      const creating = await store.get<{ mode?: string; modeRevision?: number }>('sessions', row.sessionId);
      // Fail closed: an unverifiable creating session means the proposal is not confirmable.
      if (!creating || (creating.mode !== row.mode || (row.modeRevision !== undefined && creating.modeRevision !== row.modeRevision))) return false;
    }
    const params = row.data.params && typeof row.data.params === 'object' ? row.data.params as Record<string, unknown> : {};
    if (Array.isArray(params.recipientIds) && params.recipientIds.length) {
      const allowed = createRecipientPolicy(store);
      for (const id of params.recipientIds) if (!(await allowed(fresh, String(id)))) return false;
    }
    const stateId = typeof params.contentStateId === 'string' ? params.contentStateId : typeof params.queryStateId === 'string' ? params.queryStateId : undefined;
    // The evidence ledger is session-bound: look the state up under the session that created the proposal.
    const evidenceActor: Actor = row.sessionId ? { ...fresh, sessionId: row.sessionId, ...(row.mode && row.modeRevision !== undefined ? { mode: row.mode, modeRevision: row.modeRevision } : {}) } : fresh;
    if (stateId && !(await loadAcceptedEvidence(store, evidenceActor, stateId))) return false;
    if (row.actionId === 'artifact.share' && typeof params.artifactId === 'string') {
      // Fresh authorization of the sender AND every recipient for the artifact's whole scope; any drift hides the confirm.
      const share = createArtifactShareEffects({ store, now: () => new Date(), recipientAllowed: createRecipientPolicy(store) });
      const bound = await share.bind(fresh, { artifactId: params.artifactId, recipientIds: Array.isArray(params.recipientIds) ? params.recipientIds.map(String) : [],
        ...(typeof params.revision === 'number' ? { revision: params.revision } : {}) });
      if (!bound.ok || bound.binding.bindingDigest !== row.data.bindingDigest) return false;
    }
    if (typeof params.dashboardId === 'string') {
      const dashboard = await store.get<{ ownerId: string; deletedAt?: unknown }>('dashboards', params.dashboardId);
      if (!dashboard || dashboard.ownerId !== actor.id || typeof dashboard.deletedAt === 'string') return false;
    }
    return true;
  } catch { return false; }
}

/**
 * This actor's still-pending, unexpired proposals. A transient store outage is a typed 503 (PROPOSALS_UNAVAILABLE), never an
 * empty list: the client shows a retry banner. A store without the router_proposals table yields []: the feature is off. A row that fails validation is skipped.
 */
export async function listPendingProposals(store: Store, actor: Actor, now = Date.now()): Promise<RouterProposalView[]> {
  let rows: unknown[];
  try {
    // A claim is a lease: a crashed confirmer's row with an expired lease is shown (and reclaimable) like a pending one.
    rows = [...await store.list<unknown>('router_proposals', { actorId: actor.id, status: 'pending' }), ...await store.list<unknown>('router_proposals', { actorId: actor.id, status: 'claimed' })];
  } catch (error) {
    // ONLY a positively identified missing router_proposals table (hosted migration not applied) means "feature off":
    // nothing can be pending. Every other failure (transport, timeout, unknown) is a typed 503 so the client shows its
    // retry banner — never an empty list that would hide pending proposals.
    if (isMissingTableError(error)) return [];
    throw new DomainError('PROPOSALS_UNAVAILABLE', 'โหลดรายการที่รอยืนยันไม่สำเร็จ — ลองอีกครั้ง', 503);
  }
  const views: RouterProposalView[] = [];
  for (const raw of rows) {
    const parsed = stagedRowSchema.safeParse(raw);
    if (!parsed.success) continue;
    const row = parsed.data;
    const live = row.status === 'pending' || (row.status === 'claimed' && (row.claimExpiresAt ?? 0) <= now);
    if (row.actorId === actor.id && live && row.expiresAt > now) {
      const confirmable = await stillAuthorized(store, actor, row);
      views.push(toProposalView(row, confirmable, confirmable ? await displayDetails(store, row) : {}));
    }
  }
  return views.sort((a, b) => b.createdAt - a.createdAt).slice(0, 50);
}

export interface CancelProposalResult { id: string; status: 'cancelled'; text: string }

/** Actor-scoped cancel: only the owner's still-pending proposal can be cancelled; claimed/terminal rows are untouched. */
export async function cancelProposal(store: Store, actor: Actor, id: string): Promise<CancelProposalResult> {
  const staged = createStagedStore(store);
  const found = await staged.get(actor, id);
  if (!found || found.actorId !== actor.id) throw new DomainError('NOT_FOUND', 'ไม่พบรายการที่ยกเลิกได้', 404);
  if (found.status === 'cancelled') return { id, status: 'cancelled', text: 'ยกเลิกรายการนี้แล้ว' };
  if (found.status !== 'pending') throw new DomainError('NOT_PENDING', 'รายการนี้ไม่อยู่ในสถานะรอยืนยันแล้ว', 409);
  const revision = await staged.revisionOf(actor, id);
  await staged.save(actor, id, { status: 'cancelled', ...(revision !== undefined ? { expectedRevision: revision } : {}) });
  return { id, status: 'cancelled', text: 'ยกเลิกรายการแล้ว ยังไม่มีการดำเนินการใด ๆ' };
}

export async function confirmProposal(store: Store, actor: Actor, id: string): Promise<ConfirmResult> {
  return new ConciergeService(store).confirmStagedProposal(actor, id);
}


// ---------------------------------------------------------------- persisted, verified receipts (sender view)

/** A verified staged effect, as the sender may read it later. Whitelisted fields only: no workflow, tokens or other recipients' details. */
export interface RouterReceiptView { id: string; actionId: StagedRow['actionId']; completedAt: number; conversationId: string; turnId: string; receipt: StagedReceipt }
const receiptShape = (raw: unknown): StagedReceipt | undefined => {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, max: number): string | undefined => typeof v === 'string' ? v.slice(0, max) : undefined;
  const kind = str(r.kind, 60), title = str(r.title, 120), headline = str(r.headline, 500), verifiedAt = str(r.verifiedAt, 40);
  if (!kind || !title || !headline || !verifiedAt) return undefined;
  const list = <T>(v: unknown, map: (item: Record<string, unknown>) => T | undefined, max = 50): T[] | undefined =>
    Array.isArray(v) ? v.slice(0, max).flatMap(item => item && typeof item === 'object' ? [map(item as Record<string, unknown>)].filter((x): x is T => x !== undefined) : []) : undefined;
  const recipients = list(r.recipients, item => { const name = str(item.name, 120); return name && item.status === 'delivered' ? { name, status: 'delivered' as const } : undefined; });
  const artifact = r.artifact && typeof r.artifact === 'object' ? (() => { const a = r.artifact as Record<string, unknown>; const t = str(a.title, 200); const k = str(a.kind, 40);
    return t && k && typeof a.revision === 'number' ? { title: t, revision: a.revision, kind: k } : undefined; })() : undefined;
  const textLines = Array.isArray(r.lines) ? r.lines.filter((l): l is string => typeof l === 'string').slice(0, 20).map(l => l.slice(0, 300)) : undefined;
  const fields = list(r.fields, item => { const label = str(item.label, 80), value = str(item.value, 300); return label && value !== undefined ? { label, value } : undefined; }, 30);
  const content = str(r.content, 4000);
  return { kind, title, headline, verifiedAt, ...(recipients?.length ? { recipients } : {}), ...(artifact ? { artifact } : {}),
    ...(textLines?.length ? { lines: textLines } : {}), ...(fields?.length ? { fields } : {}), ...(content ? { content } : {}) };
};

/** One bounded page of this actor's completed (verified) staged effects, newest first (exact `total`; `nextCursor` reaches older receipts). A store without router_proposals simply has none. */
export async function listReceiptsPage(store: Store, actor: Actor, input: PageInput = {}, conversationId?: string): Promise<Page<RouterReceiptView>> {
  let rows: unknown[];
  try { rows = await store.list<unknown>('router_proposals', { actorId: actor.id, status: 'completed' }); }
  catch (error) {
    if (isMissingTableError(error)) return { items: [], total: 0, nextCursor: null };
    throw new DomainError('RECEIPTS_UNAVAILABLE', 'โหลดผลการดำเนินการไม่สำเร็จ — ลองอีกครั้ง', 503);
  }
  const out: RouterReceiptView[] = [];
  for (const raw of rows) {
    const parsed = stagedRowSchema.safeParse(raw);
    if (!parsed.success || parsed.data.actorId !== actor.id || parsed.data.status !== 'completed') continue;
    const row = parsed.data;
    if (conversationId && row.conversationId !== conversationId) continue;
    const stored = receiptShape(row.data.receipt);
    const result = row.data.result as { text?: unknown } | undefined;
    const receipt = stored ?? (typeof result?.text === 'string'
      ? { kind: row.actionId, title: 'ดำเนินการและตรวจผลแล้ว', headline: result.text.slice(0, 500), verifiedAt: new Date(row.updatedAt).toISOString() } : undefined);
    if (receipt) out.push({ id: row.id, actionId: row.actionId, completedAt: row.updatedAt, conversationId: row.conversationId, turnId: row.turnId, receipt });
  }
  return paginate(out, r => `${String(r.completedAt).padStart(16, '0')}|${r.id}`, input, { limit: 30 });
}
/** The newest page (compat). */
export async function listReceipts(store: Store, actor: Actor): Promise<RouterReceiptView[]> { return (await listReceiptsPage(store, actor)).items; }

// ---------------------------------------------------------------- history of proposals that did NOT take effect

/**
 * A proposal that ended without an effect. `cancelled`: the owner cancelled it; `expired`: its 24 h window ran out unconfirmed;
 * `not_completed`: the confirmation did not finish (a check failed, authority/mode changed, or it was replaced). The server stores no
 * finer reason, so none is invented. The review text is shown only while the viewer is STILL authorized to see what it was about.
 */
export interface ClosedProposalView { id: string; actionId: StagedRow['actionId']; outcome: 'cancelled' | 'expired' | 'not_completed'; closedAt: number; createdAt: number; preview: string | null }

export function closedOutcome(row: StagedRow, now: number): ClosedProposalView['outcome'] | null {
  if (row.status === 'cancelled') return 'cancelled';
  if (row.status === 'stale') return row.expiresAt <= row.updatedAt ? 'expired' : 'not_completed';
  const live = row.status === 'pending' || (row.status === 'claimed' && (row.claimExpiresAt ?? 0) <= now);
  return live && row.expiresAt <= now ? 'expired' : null;
}

/** One bounded page (newest first, exact `total`) of this actor's cancelled / expired / not-completed staged proposals. Owner-scoped; a store without router_proposals has none. */
export async function listClosedProposalsPage(store: Store, actor: Actor, input: PageInput = {}, now = Date.now(), onlyOutcome?: ClosedProposalView['outcome']): Promise<Page<ClosedProposalView>> {
  const rows: unknown[] = [];
  try { for (const status of ['cancelled', 'stale', 'pending', 'claimed']) rows.push(...await store.list<unknown>('router_proposals', { actorId: actor.id, status })); }
  catch (error) {
    if (isMissingTableError(error)) return { items: [], total: 0, nextCursor: null };
    throw new DomainError('PROPOSALS_UNAVAILABLE', 'โหลดประวัติรายการที่ไม่ได้ดำเนินการไม่สำเร็จ — ลองอีกครั้ง', 503);
  }
  const closed: { row: StagedRow; outcome: ClosedProposalView['outcome'] }[] = [];
  for (const raw of rows) {
    const parsed = stagedRowSchema.safeParse(raw);
    if (!parsed.success || parsed.data.actorId !== actor.id) continue;
    const outcome = closedOutcome(parsed.data, now);
    if (outcome && (!onlyOutcome || outcome === onlyOutcome)) closed.push({ row: parsed.data, outcome });
  }
  const closedAt = (row: StagedRow, outcome: ClosedProposalView['outcome']) => outcome === 'expired' && row.status !== 'stale' ? row.expiresAt : row.updatedAt;
  const page = paginate(closed, ({ row, outcome }) => `${String(closedAt(row, outcome)).padStart(16, '0')}|${row.id}`, input, { limit: 30 });
  const items: ClosedProposalView[] = [];
  for (const { row, outcome } of page.items) {
    const visible = await stillAuthorized(store, actor, row);
    items.push({ id: row.id, actionId: row.actionId, outcome, closedAt: closedAt(row, outcome), createdAt: row.createdAt, preview: visible ? row.preview.slice(0, 500) : null });
  }
  return { ...page, items };
}
