import type { Actor, DashboardSpec, PendingAction, PendingActionRevisionResult, Reader, ReceiptView, Transaction } from '../../contracts';
import type { MonitorContext, MonitorState } from '../../monitors';
import type { AcceptedEvidence } from '../ports/effect-bindings';
import { digest, type EffectRecord, type PlanContext, type Ref } from '../../effects/shared';

/**
 * Ports the router action/refine executors run over. U9 binds them to ConciergeService + the tool broker
 * (prepare tools, confirm, cancel, revise, renameDashboard, deleteDashboard) and to the Wave 4 snapshot loaders.
 * Everything behind a port is server-owned; nothing here is read from the AI plan or the client.
 */
export type PrepareToolName = 'dashboard.prepare_create' | 'dashboard.prepare_share' | 'ticket.prepare_create' | 'badge.prepare_revoke';
export interface TurnRef { conversationId: string; turnId: string }

export type StagedActionId = 'dashboard.delete' | 'dashboard.revoke_share' | 'dashboard.refine' | 'dashboard.rename' | 'monitor.delete' | 'communication.send' | 'monitor.create' | 'artifact.share' | 'task.create' | 'policy.acknowledge'
  | 'onboarding.director_approve' | 'onboarding.return' | 'onboarding.notify_email';
export interface StagedProposal {
  id: string; actorId: string; conversationId: string; actionId: StagedActionId;
  /** Turn that created the proposal; confirm requires that turn's completion proof. */
  turnId?: string;
  /** Session + mode revision the proposal was created under; confirm requires the same mode. */
  sessionId?: string; mode?: Actor['mode']; modeRevision?: number;
  /** Lease of a `claimed` row (epoch ms). An expired lease is reclaimable by the next confirm. */
  claimExpiresAt?: number;
  /** Random per-claim token; every write of a claimed row is a CAS on it (a superseded claimant is fenced out). */
  claimToken?: string;
  /** Canonical-payload digest used for dedupe. */
  digest: string;
  /** claimed = one confirmer won the CAS and is executing; only it may move the row to a terminal state. */
  status: 'pending' | 'claimed' | 'completed' | 'cancelled' | 'stale';
  /** epoch ms */
  expiresAt: number;
  /** Thai preview shown to the user. */
  preview: string;
  /** Server-owned state (workflow / monitor state / params). Opaque to the UI. */
  data: Record<string, unknown>;
}
export interface SavedDashboardInfo {
  id: string; ownerId: string; title: string;
  /** Any ACTIVE share grant (legacy `active` or V2 `status: 'active'`). */
  shared: boolean; deleted: boolean;
  /** Stored spec (owner-only use: refine base). */
  spec?: DashboardSpec;
  /** Digest of the stored spec; direct writes and staged proposals are bound to it (CAS at write/confirm). */
  revision?: string;
}
/** Revision token of a saved dashboard spec (what staged proposals and direct writes are bound to). */
export const specRevision = (spec: DashboardSpec): string => digest(spec);
/** Optional guards a dashboard write re-checks INSIDE its own transaction. */
export interface DashboardWriteGuard { expectedRevision?: string; allowShared?: boolean; /** Runs inside the write transaction (staged claim + session-mode fence). */ fence?: EffectFence }

/** Runs INSIDE the transaction that writes an effect; throwing aborts the write (claim + session-mode fence of a staged confirm). */
export type EffectFence = (tx: Transaction) => Promise<void>;
export interface CommunicationBinding { context: PlanContext; consent: Ref; contentClaimIds: string[]; inbox: EffectRecord[] }
export interface MonitorBinding { context: MonitorContext; query: Ref; consent: Ref; contentClaimIds: string[] }

/** What an artifact share is bound to at preview: the exact version, the exact recipients and the authority both sides held. */
export interface ArtifactShareBinding {
  artifact: { id: string; revision: number; kind: string; title: string; digest: string };
  recipients: { id: string; name: string }[];
  scope: { regions: string[]; branchIds: string[] };
  /** Digest over the artifact ref, the sender/recipient authorization refs and the server policy; re-derived (fresh reads) at confirm and inside the effect transaction. */
  bindingDigest: string;
}
export type ArtifactShareBindResult = { ok: true; binding: ArtifactShareBinding } | { ok: false; code: string; text: string };
export interface ArtifactShareDelivered { recipientId: string; recipientName: string; messageId: string }
export interface ArtifactShareEffects {
  /** Fresh authorization of sender and EACH recipient for the artifact's WHOLE stored scope (authorizeArtifactShare per recipient). `reader` = the transaction the check runs in. */
  bind(actor: Actor, input: { artifactId: string; recipientIds: string[]; revision?: number }, reader?: Reader): Promise<ArtifactShareBindResult>;
  /** Re-binds inside the writing transaction (digest must equal `bindingDigest`), writes share rows + recipient inbox messages, reads every one back. */
  deliver(actor: Actor, input: { artifactId: string; revision: number; recipientIds: string[]; bindingDigest: string; proposalId: string; fence?: EffectFence }):
    Promise<{ ok: true; delivered: ArtifactShareDelivered[]; artifact: ArtifactShareBinding['artifact'] } | { ok: false; code: string; text: string }>;
}

export type DashboardOrganizeOp = 'pin' | 'unpin' | 'archive' | 'restore' | 'duplicate';

export interface EffectBindings {
  /** task.create: absent = the registered action reports effects_disabled. */
  workItems?: import('../ports/work-items').WorkItemEffects;
  /** artifact.share: absent = the registered action reports effects_disabled. */
  artifactShare?: ArtifactShareEffects;
  /** policy.acknowledge: absent = the registered action reports effects_disabled. */
  policyAck?: import('../ports/policy-ack').PolicyAckEffects;
  /** An accepted answer (branch or table) of THIS actor re-loaded under the CURRENT authority and catalog (derived branch sets). */
  acceptedEvidence?(actor: Actor, stateId: string): Promise<AcceptedEvidence | import('../ports/table-evidence').TableAcceptedEvidence | undefined>;
  /** HR Director Workflow V2 bridge (onboarding.*): absent = Workflow V2 is not composed here, the actions report workflow_unavailable. */
  directorWorkflow?: import('../ports/director-workflow').DirectorWorkflowPort;
  /** Trusted snapshots for a communication plan. undefined = the content/recipients cannot be bound to evidence. */
  communication(actor: Actor, input: { recipientIds: string[]; contentStateId: string; inTurn?: AcceptedEvidence | import('../ports/table-evidence').TableAcceptedEvidence }): Promise<CommunicationBinding | undefined>;
  monitor(actor: Actor, input: { queryStateId: string; recipientIds: string[]; inTurn?: AcceptedEvidence | import('../ports/table-evidence').TableAcceptedEvidence }): Promise<MonitorBinding | undefined>;
  /**
   * Persist the simulated inbox after a verified delivery (CAS owned by the adapter). The adapter re-reads the sender and every
   * recipient INSIDE the writing transaction and refuses (no write) when authority changed since `expected` was bound.
   */
  commitInbox(actor: Actor, inbox: EffectRecord[], expected?: { authority?: PlanContext['authority']; recipients?: PlanContext['recipients']; fence?: EffectFence; boundArtifact?: { id: string; revision: number; title: string };
    /** The freshly verified exact version the attachment opens (digest/kind) + the approved binding digest: written as an open grant with the message. */
    openArtifact?: { digest: string; kind: string; bindingDigest: string } }): Promise<void>;
  /** Persist the installed monitor state; `fence` runs inside the installing transaction. */
  commitMonitor(actor: Actor, proposalId: string, state: MonitorState, fence?: EffectFence): Promise<void>;
  /** Owner-private monitor lifecycle (direct tier). Absent = the registered lifecycle actions report effects_disabled. */
  manageMonitor?(actor: Actor, input: { monitorId: string; op: 'pause' | 'resume' | 'delete' }, options?: { defer?: DeferredWrites; fence?: EffectFence }): Promise<{ ok: true; text: string } | { ok: false; code: string; text: string }>;
  /** Owner-only display-title rename (monitor.manage rename): the SAME lib/monitors/direct.ts rule (owner + row-version CAS) as the UI route. */
  renameMonitor?(actor: Actor, input: { monitorId: string; title: string }, options?: { defer?: DeferredWrites }): Promise<{ ok: true; text: string } | { ok: false; code: string; text: string }>;
  /** The actor's own monitors (ids the planner may reference in monitor.pause/resume/delete). */
  listMonitors?(actor: Actor): Promise<{ id: string; title: string; status: string }[]>;
  /** PC-03/B-P1: owner-scoped title search over ALL retained monitors (exact total, offset window, newest first). */
  searchMonitors?(actor: Actor, opts: { needle: string; offset: number; limit: number }): Promise<{ items: { id: string; title: string; status: string; createdAt: string }[]; total: number }>;
  /** One exact retained monitor of this owner, whatever its age. */
  findMonitor?(actor: Actor, monitorId: string): Promise<{ id: string; title: string; status: string } | undefined>;
}

/** Direct private writes queued to run inside the turn's completion transaction (never before durable completion). */
export type DeferredWrite = (tx: Transaction, finalActor: Actor) => Promise<void>;
export interface DeferredWrites { push(write: DeferredWrite): void }

export interface StagedPorts {
  /** A still-pending proposal of this actor+conversation with the same canonical digest. */
  findPending(actor: Actor, conversationId: string, digest: string): Promise<StagedProposal | undefined>;
  create(actor: Actor, ref: TurnRef, input: Pick<StagedProposal, 'actionId' | 'digest' | 'preview' | 'data' | 'expiresAt'>): Promise<StagedProposal>;
  get(actor: Actor, id: string): Promise<StagedProposal | undefined>;
  save(actor: Actor, id: string, patch: { status: StagedProposal['status']; data?: Record<string, unknown>; claimToken?: string }): Promise<StagedProposal>;
  /** Atomic pending -> claimed (CAS on revision). Returns the claimed row, or undefined when another confirmer won / not pending / expired. */
  claim(actor: Actor, id: string): Promise<StagedProposal | undefined>;
}

/** Results library operations (owner-private, reversible): the SAME lib/artifacts/library.ts / save functions the Results page calls. */
export type ResultOpName = 'rename' | 'pin' | 'unpin' | 'archive' | 'unarchive' | 'save';
export interface ResultPorts {
  /** Resolves the Result by server id (owner-only; active ops must belong to `conversationId`), then runs the shared library function. */
  apply(actor: Actor, input: { artifactId: string; revision?: number; op: ResultOpName; title?: string; conversationId?: string }): Promise<{ ok: true; text: string } | { ok: false; code: string; text: string }>;
}

export interface ActionPorts {
  reloadActor(actor: Actor): Promise<Actor>;
  /** Runs the existing broker prepare tool (validation, evidence pins, audit) and returns the stored PendingAction. */
  prepareTool(actor: Actor, tool: PrepareToolName, args: Record<string, unknown>, ref: TurnRef): Promise<PendingAction>;
  confirmPending(actor: Actor, actionId: string): Promise<ReceiptView>;
  cancelPending(actor: Actor, actionId: string): Promise<PendingAction>;
  revisePending(actor: Actor, actionId: string, patch: unknown, requestKey: string): Promise<PendingActionRevisionResult>;
  /**
   * true only for a proposal bound to a COMPLETED chat turn of this conversation (completion proof). Standalone-prepared
   * proposals have none and are never listed to the planner nor refined from chat. Absent => no extra proof (unit fakes).
   */
  proposalBound?(actor: Actor, action: PendingAction): Promise<boolean>;
  /** Pending (not yet confirmed) actions owned by the actor in this conversation. */
  listPending(actor: Actor, conversationId: string): Promise<PendingAction[]>;
  getDashboard(actor: Actor, dashboardId: string): Promise<SavedDashboardInfo | undefined>;
  /** Owner-only current outgoing grants. A read error must reject; [] means the server confirmed no active grants. */
  dashboardShares?(actor: Actor, dashboardId: string): Promise<{ shareId: string; recipientId: string; recipientName: string; createdAt: string }[]>;
  /** Owner-only revocation of one exact grant. */
  revokeDashboardShare?(actor: Actor, dashboardId: string, shareId: string, options?: { fence?: EffectFence }): Promise<{ shareId: string; alreadyRevoked: boolean }>;
  renameDashboard(actor: Actor, dashboardId: string, input: { title: string }, guard?: DashboardWriteGuard): Promise<{ id: string; title: string }>;
  deleteDashboard(actor: Actor, dashboardId: string, guard?: Pick<DashboardWriteGuard, 'fence'>): Promise<{ dashboardId: string; deletedAt: string }>;
  /** Owner-only replacement of a saved dashboard's widgets (scope/title unchanged); the spec was already bound to evidence by the builder. */
  updateDashboardSpec?(actor: Actor, dashboardId: string, spec: DashboardSpec, guard?: DashboardWriteGuard): Promise<{ id: string; title: string }>;
  /** true when the staged proposal's creating chat turn has a verified completed-turn proof (absent => no extra proof: unit fakes). */
  stagedTurnCompleted?(actor: Actor, proposal: StagedProposal): Promise<boolean>;
  /** Server-side recipient policy: the recipient exists, is active and may receive from this actor. */
  recipientAllowed(actor: Actor, recipientId: string): Promise<boolean>;
  /** Optional final scope intersection over branch ids (regions are always checked locally). */
  branchesAllowed?(actor: Actor, branchIds: string[]): Promise<boolean>;
  /** Optional router-level audit line for direct-tier executions. */
  audit?(actor: Actor, event: { kind: string; detail: string; refId?: string }): Promise<void>;
  staged: StagedPorts;
  effects?: EffectBindings;
  /** result.manage / result.unarchive: absent = the registered actions report effects_disabled. */
  results?: ResultPorts;
  /**
   * dashboard.manage (direct): the SAME ConciergeService organization rules as the Dashboard page (owner, permission, not deleted, no pin while
   * archived, duplicate quota and scope). Resolves the target by server id; absent = the registered action reports effects_disabled.
   */
  /** `unchanged` (G5): the Dashboard is already in the requested state (restore of a non-archived one, pin of a pinned one ...): nothing is written. */
  organizeDashboard?(actor: Actor, dashboardId: string, op: DashboardOrganizeOp): Promise<{ dashboardId: string; title: string; unchanged?: true }>;
  /**
   * Direct-tier creations inside a chat turn: the proposal is prepared now and the service creates it right after the
   * turn commits (the confirm path requires a completed turn). The executor then reports `proposed` with `direct: true`.
   */
  deferDirectConfirm?: boolean;
}
