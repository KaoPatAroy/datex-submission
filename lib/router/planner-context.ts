import type { ContextKind } from './action-registry';
import type { ParamValue } from './turn-plan';

/** Everything the server hands the planner. All of it is inert data; ids are what the plan may reference. */
export interface ActionParamDescriptor {
  name: string; required: boolean; sources: string[]; verbatim: boolean;
  contextKind: ContextKind | null; scope: 'region' | 'branch' | null; hasDefault: boolean; jsonType: unknown;
}
export interface ActorActionDescriptor {
  actionId: string; description: string; riskTier: 'direct' | 'confirm'; requiresConfirm: boolean; params: ActionParamDescriptor[];
}
export interface ContextLabel { id: string; label: string }

/**
 * CONTEXT-001: the ONE exact reference set a follow-up may use. Everything a later turn can point at (accepted query/HR/table
 * states, the table cursor on offer, the drill path, artifact versions, pending proposals and their revision chain, recipients)
 * is listed here with the server's exact ids; validators and executors resolve follow-ups against it (never against model text).
 */
export interface ReferenceSet {
  version: 1;
  /** Accepted answers of THIS conversation still valid under current authority and catalog, newest first. */
  queryStates: { stateId: string; family: 'retail' | 'hr' | 'table'; datasetId: string; revision: number; label: string }[];
  /** The exact state `continuation: true` binds to, per dataset family (null = none: a continuation validates as a fresh query). */
  continuation: { retail: string | null; hr: string | null; table: string | null };
  /** The page the newest table answer offers next. `nextCursor` is the only cursor a follow-up may present. */
  pagination: { stateId: string; datasetId: string; offset: number; limit: number; total: number; nextCursor: string | null } | null;
  /** How the newest answer is narrowed (scope filters, grouping): the drill path a "drill into / go back" follow-up extends. */
  drillPath: { stateId: string; datasetId: string; filters: { fieldId: string; values: string[] }[]; groupBy: string[] } | null;
  /** Artifact heads of this conversation with their exact revision. */
  artifacts: { id: string; typeId: string; title: string; revision: number | null }[];
  /** Pending proposals (built-in and staged) with the proposal they replace (revision chain). */
  pendingProposals: { id: string; kind: string; title: string; revises: string | null }[];
  recipients: { id: string; name: string; role: string }[];
  /** Digest of the whole set: two contexts with the same digest offer exactly the same references. */
  digest: string;
}

export interface PlannerContext {
  business: { date: string; weekday: string; timezone: string; availability: { from: string; to: string } | null };
  scope: { actorId: string; role: string; regionIds: string[]; branchIds: string[]; permissions: string[] };
  /**
   * `descriptors` are the authorized dataset/field descriptors (ids, kinds, canonical values) the planner needs to write a
   * QueryPlan; inert catalog data, never matched against user text.
   */
  catalog: { datasets: { id: string; label: string; /** Next-step questions derived from the registered dataset. */ suggestions?: string[] }[]; measureIds: string[]; choices: ContextLabel[]; descriptors?: unknown[] };
  /** Actions the actor may use, with param schemas (built by `describeActionsFor`). */
  actions: ActorActionDescriptor[];
  recipients: { id: string; name: string; role: string }[];
  pendingActions: { id: string; kind: string; title: string; widgetIndexes: number[]; values: Record<string, ParamValue> }[];
  /**
   * `current` (G5): the Dashboard THIS conversation created or organized last (server-built from its receipts / turn records, never from wording):
   * what "this Dashboard" refers to. `updatedAt` / `widgetCount` are server facts for disambiguating same-title chips (not sent to the planner).
   */
  dashboards: { id: string; title: string; current?: true; updatedAt?: string; widgetCount?: number }[];
  /** Active outgoing grants from these owned dashboards; server-resolved exact ids, absent when the provider is unavailable. */
  dashboardShares?: { dashboardId: string; shareId: string; recipientId: string; recipientName: string; createdAt: string }[];
  /** Only these dashboards were inspected; failures are explicit rather than an empty-list assertion. */
  dashboardSharesFor?: string[];
  dashboardSharesUnavailable?: string[];
  /** The actor's own installed monitors (ids addressable by monitor.pause/resume/delete). Absent = none/unavailable. */
  monitors?: { id: string; title: string; status: string }[];
  /** `label`: server-built Thai description of the answer (scope + dates), used for clarify chips; never AI text. */
  acceptedStates: { stateId: string; datasetId: string; label?: string }[];
  artifacts: { id: string; typeId: string; title: string; revision?: number }[];
  /** The owner's ARCHIVED Results (newest first, bounded): addressable ONLY by result.unarchive; never offered as a source/share/base reference. Absent = none. */
  archivedArtifacts?: { id: string; typeId: string; title: string }[];
  /** Policy documents this actor may read (ids/titles/versions only; text is read by the policy_read step). */
  policies?: { id: string; title: string; version: string }[];
  /** Exact id+version of policies an accepted policy_read already SHOWN to this actor in this conversation (what policy.acknowledge may reference). */
  shownPolicies?: { id: string; version: string }[];
  /**
   * HR Director (Workflow V2): read capabilities the V2 runtime grants this actor now, the reviewed queues (immutable V2 snapshots of
   * THIS conversation + session, still valid) and verified approvals of this conversation. Absent = no V2 Director capability.
   */
  workflow?: {
    reads: { readId: string; description: string }[];
    reviewedQueues: { id: string; expiresAt: string; requests: { id: string; label: string; startDate: string }[] }[];
    verifiedApprovals: { id: string; label: string; requestIds: string[] }[];
  };
  /**
   * Owned resources the user explicitly SELECTED this turn (UI target or a tapped lookup choice), already server-verified (owner + current
   * permission) and listed FIRST in DASHBOARDS / ARTIFACTS / MONITORS even when older than the bounded recent window. Ids only.
   */
  selectedTargets?: { artifacts: string[]; dashboards: string[]; monitors: string[] };
  /** resource_lookup is available for these kinds (the actor may use them): the planner can search ITS OWN older resources by name. */
  lookup?: { resources: ('dashboard' | 'result' | 'monitor')[] };
  /** The exact reference set of this turn (absent only in hand-built test contexts). */
  references?: ReferenceSet;
  /** `selection` = the user's tap on one of the choices the server saved for that clarify turn (id + server label); complete the clarified turn with it. */
  pendingClarification: { about: string; missing: string[]; selection?: { id: string; label: string } } | null;
  /** Bounded recent conversation (inert data). */
  conversation: { role: 'user' | 'assistant'; text: string }[];
  /** Prior accepted state; `values` are the canonical values an `inherited` param may repeat. */
  previousState: { stateId: string; values: Record<string, ParamValue>; plan?: unknown } | null;
}

/** Exact server-verified user messages in the pending clarification chain, never general conversation history. */
export interface TurnMessages { current: string; clarifiedTurn?: string; clarifiedTurns?: string[] }
export const CLARIFICATION_CHAIN_MAX_TURNS = 4;
export const CLARIFICATION_REQUEST_MAX_BYTES = 24 * 1024;
