import { z } from 'zod';
import type { Actor, Store } from '../../contracts';
import { DomainError } from '../../core/errors';
import { digest } from '../../core/utils';
import { workflowExecutionConversationId } from '../../core/conversations';
import {
  projectWorkflowCapabilities, readDirectorRequestDocuments, readDirectorStartDates, type WorkflowBindingAvailability,
} from '../../core/workflow-capabilities';
import type { WorkflowActionRuntime } from '../../workflows/action-runtime';
import type { WorkflowActionRunner } from '../../workflows/action-runner';
import type { createOnboardingQueryService } from '../../workflows/onboarding-queries';
import { authorizeWorkflowScope } from '../../workflows/authority';
import {
  directoryIdentitySchema, onboardingRequestSchema, reviewSnapshotSchema, workflowActionPayloadSchema, workflowReceiptV2Schema,
  type OnboardingRequest, type WorkflowPayloadV2, type WorkflowReceiptV2,
} from '../../workflows/contracts';
import type { EffectFence } from '../executors/action-ports';
import { WORKFLOW_READ_IDS } from '../turn-plan';

/**
 * HR Director bridge between the Unified Router and the EXISTING Workflow V2 onboarding approval engine. Nothing here decides
 * who may approve what: every read, eligibility check, preparation, execution and verification is the trusted V2 runtime
 * (`onboarding.directorQueue`, `readDirectorStartDates`, `readDirectorRequestDocuments`, `projectWorkflowCapabilities`,
 * `runtime.prepare`, `runner.confirm`). This port only (a) maps V2 results into planner-safe/display data, (b) binds a router
 * proposal to the exact V2 snapshot, request ids, row versions and Director identity, and (c) reads the committed rows back
 * independently before the router may say "approved". No user text is read here.
 */
export interface DirectorWorkflowRuntime {
  runtime: WorkflowActionRuntime;
  runner: WorkflowActionRunner;
  onboarding: ReturnType<typeof createOnboardingQueryService>;
  availability: readonly WorkflowBindingAvailability[];
}

export const DIRECTOR_READ_IDS = WORKFLOW_READ_IDS;
export type DirectorReadId = typeof DIRECTOR_READ_IDS[number];
export const DIRECTOR_DECISION_KINDS = ['onboarding_director_approve', 'onboarding_return'] as const;
export type DirectorDecisionKind = typeof DIRECTOR_DECISION_KINDS[number];
/** Reads/decisions the V2 projection grants this actor now (empty for every non-Director principal). */
export interface DirectorCapabilities { reads: DirectorReadId[]; decisions: DirectorDecisionKind[] }

export interface QueueRequestView { requestId: string; employeeName: string; startDate: string; documents: string[] }
/** One exact immutable V2 reviewed snapshot (displayed order) still valid for this actor/session. */
export interface ReviewedQueueView { snapshotId: string; digest: string; createdAt: string; expiresAt: string; requests: QueueRequestView[];
  /** Set by a fresh read only: more waiting requests exist beyond this page (this queue is ONE bounded page, never the total). */
  hasMore?: boolean;
  /** Set by a fresh read only: this page continues after an earlier reviewed queue. */
  continued?: boolean }
export type DirectorRead =
  | { readId: 'director_queue'; queue: ReviewedQueueView }
  | { readId: 'director_start_dates'; queue: ReviewedQueueView }
  | { readId: 'director_request_documents'; snapshotId: string; request: QueueRequestView }
  | { readId: 'director_approvals_today'; asOf: string; items: { requestId: string; employeeName: string; startDate: string; approvedAt: string }[]; /** more verified approvals exist beyond this bounded list */ hasMore?: boolean };
export type DirectorReadResult = { ok: true; read: DirectorRead } | { ok: false; code: string };

export interface DecisionInput { kind: DirectorDecisionKind; snapshotId: string; requestIds: string[]; reason?: string }
export interface DecisionBinding {
  kind: DirectorDecisionKind; snapshotId: string; snapshotDigest: string; expiresAt: string; requestIds: string[]; reason?: string;
  directorIdentityId: string;
  requests: { requestId: string; rowVersion: number; employeeName: string; startDate: string }[];
}
export type DecisionBindResult = { ok: true; binding: DecisionBinding; bindingDigest: string } | { ok: false; code: string };
export interface DecisionReceipt {
  kind: DirectorDecisionKind; executionIds: string[]; verifiedAt: string; already: boolean;
  requests: { requestId: string; employeeName: string; startDate: string; state: string }[];
}
export type DecisionExecuteResult = { ok: true; receipt: DecisionReceipt } | { ok: false; code: string };

export interface EmailRecipient { identityId: string; name: string; destination: string }
export interface EmailInput { approvalId: string; requestIds: string[]; executionIds: string[]; subject: string; body: string }
export interface EmailBinding {
  approvalId: string; requestIds: string[]; executionIds: string[]; recipients: EmailRecipient[]; subject: string; body: string;
  requests: { requestId: string; employeeName: string; startDate: string; state: string }[]; directorIdentityId: string;
}
export type EmailBindResult = { ok: true; binding: EmailBinding; bindingDigest: string } | { ok: false; code: string };
export type EmailDeliverResult = { ok: true; delivered: { name: string; destination: string }[]; already: boolean; deliveredAt: string } | { ok: false; code: string };

export interface DirectorWorkflowPort {
  capabilities(actor: Actor): Promise<DirectorCapabilities>;
  /** `director_queue` + `snapshotId` = the NEXT page after that earlier reviewed queue (same actor + session); other reads use it as before. */
  read(actor: Actor, input: { readId: DirectorReadId; snapshotId?: string; requestId?: string }): Promise<DirectorReadResult>;
  /** The reviewed snapshot as V2 validates it NOW (any changed reviewed row, expiry or authority loss => undefined). */
  reviewedQueue(actor: Actor, snapshotId: string): Promise<ReviewedQueueView | undefined>;
  bindDecision(actor: Actor, input: DecisionInput): Promise<DecisionBindResult>;
  executeDecision(actor: Actor, input: DecisionInput & { bindingDigest: string; proposalId: string; reclaimed: boolean; fence?: EffectFence }): Promise<DecisionExecuteResult>;
  bindEmail(actor: Actor, input: EmailInput): Promise<EmailBindResult>;
  deliverEmail(actor: Actor, input: EmailInput & { bindingDigest: string; proposalId: string; fence?: EffectFence }): Promise<EmailDeliverResult>;
}

export const SIMULATED_EMAIL_TOOL = 'router.simulated_email' as const;
export const SIMULATED_EMAIL_STATUS = 'simulated_completed' as const;
const APPROVED_STATES = new Set<OnboardingRequest['state']>(['director_approved', 'onboarding_in_progress', 'completed']);
const EMPTY: DirectorCapabilities = Object.freeze({ reads: [], decisions: [] }) as DirectorCapabilities;
const QUEUE_LIMIT = 20;
/** Approvals-today list bound (the V2 read-model page maximum); a longer list is reported as truncated, never as a total. */
const APPROVALS_LIMIT = 80;
const APPROVALS_MAX_PAGES = 5;
const identifier = directoryIdentitySchema.shape.id;

export const simulatedEmailRowSchema = z.object({
  id: z.string().min(1).max(200), name: z.literal(SIMULATED_EMAIL_TOOL), status: z.literal(SIMULATED_EMAIL_STATUS), actorId: identifier,
  proposalId: z.string().min(1).max(200), approvalId: z.string().min(1).max(200), channel: z.literal('simulated_email'),
  recipientIdentityId: identifier, recipientName: z.string().min(1).max(160), destinationIdentity: z.string().min(1).max(254),
  subject: z.string().min(1).max(200), body: z.string().min(1).max(2_000), requestIds: z.array(identifier).min(1).max(100),
  executionIds: z.array(identifier).min(1).max(100), createdAt: z.string(),
}).strict();
export type SimulatedEmailRow = z.infer<typeof simulatedEmailRowSchema>;
export const simulatedEmailRowId = (proposalId: string, recipientIdentityId: string): string =>
  `sim-email:${digest({ proposalId, recipientIdentityId }).slice(0, 40)}`;

/** Fail closed: a typed V2 refusal is reported by code, never thrown into the turn. */
function codeOf(error: unknown): string | undefined {
  if (error instanceof DomainError) return error.code;
  if (error instanceof z.ZodError) return 'WORKFLOW_INVALID_INPUT';
  return undefined;
}
const sameSet = (left: readonly string[], right: readonly string[]) => left.length === right.length && new Set(left).size === left.length
  && left.every(item => right.includes(item));

export function createDirectorWorkflowPort(deps: { workflow: DirectorWorkflowRuntime; store: Store; now: () => Date }): DirectorWorkflowPort {
  const { runtime, runner, onboarding, availability } = deps.workflow;
  const reader = () => runtime.store.workflowProjectionReader;

  async function employeeName(employeeId: string): Promise<string> {
    const row = await reader().get<{ name?: unknown }>('employees', employeeId);
    return typeof row?.body.name === 'string' && row.body.name.trim() ? row.body.name : employeeId;
  }

  /** Current Director principal (fresh V2 reload): directory identity id, or undefined when this session is not a V2 Director. */
  async function principalIdentity(actor: Actor): Promise<string | undefined> {
    try {
      return await runtime.store.workflowTransaction(async tx => {
        const context = await runtime.context(tx, actor.sessionId);
        authorizeWorkflowScope(context.principal, { permission: 'hr.onboarding.director_read', roles: ['hr_director'], purpose: 'director_onboarding', targets: [] });
        return context.principal.directory.id;
      });
    } catch (error) { if (codeOf(error)) return undefined; throw error; }
  }

  async function capabilities(actor: Actor): Promise<DirectorCapabilities> {
    // Cheap short-circuit for every other role; the V2 principal reload below is the authority.
    if (!actor.active || !actor.permissions.includes('hr.onboarding.director_read')) return EMPTY;
    if (!await principalIdentity(actor)) return EMPTY;
    let projected: Awaited<ReturnType<typeof projectWorkflowCapabilities>>;
    try { projected = await projectWorkflowCapabilities(runtime, actor.sessionId, availability); }
    catch (error) { if (codeOf(error)) return { reads: [...DIRECTOR_READ_IDS], decisions: [] }; throw error; }
    const unavailable = new Set(['WORKFLOW_SCHEMA_UNAVAILABLE', 'WORKFLOW_CONFIGURATION_UNAVAILABLE']);
    const decisions = DIRECTOR_DECISION_KINDS.filter(kind => projected.some(capability => capability.kind === kind && capability.behavior === 'prepare'
      && capability.permitted && !unavailable.has(capability.disabledReason?.code ?? '')));
    return { reads: [...DIRECTOR_READ_IDS], decisions };
  }

  async function storedSnapshot(snapshotId: string) {
    const row = await reader().get('review_snapshots', identifier.parse(snapshotId));
    return row ? reviewSnapshotSchema.parse(row.body) : undefined;
  }

  async function reviewedQueue(actor: Actor, snapshotId: string): Promise<ReviewedQueueView | undefined> {
    let dates: Awaited<ReturnType<typeof readDirectorStartDates>>;
    // V2's validated reviewed-queue read: same actor + session, unexpired, digest, policy, every reviewed row unchanged, authority.
    try { dates = await readDirectorStartDates(runtime, actor.sessionId, { snapshotId }); }
    catch (error) { if (codeOf(error)) return undefined; throw error; }
    const snapshot = await storedSnapshot(snapshotId);
    if (!snapshot || snapshot.digest !== dates.snapshotRef.digest || snapshot.purpose !== 'director_queue') return undefined;
    const byId = new Map(dates.items.map(item => [item.requestId, item]));
    const requests: QueueRequestView[] = [];
    for (const requestId of snapshot.displayedIds) {
      const item = byId.get(requestId);
      if (!item) return undefined;
      const documents = snapshot.expectedRows.filter(row => row.ref.table === 'onboarding_documents');
      const types: string[] = [];
      for (const document of documents) {
        const body = (await reader().get<{ requestId?: string; documentType?: string }>('onboarding_documents', document.ref.id))?.body;
        if (body?.requestId === requestId && typeof body.documentType === 'string') types.push(body.documentType);
      }
      requests.push({ requestId, employeeName: item.employeeName, startDate: item.startDate, documents: types.sort() });
    }
    return { snapshotId, digest: snapshot.digest, createdAt: snapshot.createdAt, expiresAt: snapshot.expiresAt, requests };
  }

  async function read(actor: Actor, input: { readId: DirectorReadId; snapshotId?: string; requestId?: string }): Promise<DirectorReadResult> {
    try {
      switch (input.readId) {
        case 'director_queue': {
          // A continuation resumes after the last request of an earlier reviewed queue of THIS actor + session (the cursor is derived server-side, never user-supplied).
          let cursor: string | undefined;
          if (input.snapshotId) {
            const previous = await storedSnapshot(input.snapshotId).catch(() => undefined);
            if (!previous || previous.actorId !== actor.id || previous.actorSessionId !== actor.sessionId || previous.purpose !== 'director_queue' || !previous.displayedIds.length) return { ok: false, code: 'queue_stale' };
            cursor = previous.displayedIds[previous.displayedIds.length - 1];
          }
          const page = await onboarding.directorQueue(actor.sessionId, { limit: QUEUE_LIMIT, ...(cursor ? { cursor } : {}) });
          return { ok: true, read: { readId: 'director_queue', queue: { snapshotId: page.snapshot.id, digest: page.snapshot.digest, createdAt: page.snapshot.createdAt,
            expiresAt: page.snapshot.expiresAt, hasMore: page.nextCursor !== null, ...(cursor ? { continued: true } : {}), requests: page.items.map(item => ({ requestId: item.request.id, employeeName: item.employee.name,
              startDate: item.request.startDate, documents: item.documents.map(document => document.documentType).sort() })) } } };
        }
        case 'director_start_dates': {
          if (!input.snapshotId) return { ok: false, code: 'snapshot_required' };
          const queue = await reviewedQueue(actor, input.snapshotId);
          if (!queue) return { ok: false, code: 'queue_stale' };
          const sorted = [...queue.requests].sort((a, b) => a.startDate.localeCompare(b.startDate) || a.requestId.localeCompare(b.requestId));
          return { ok: true, read: { readId: 'director_start_dates', queue: { ...queue, requests: sorted } } };
        }
        case 'director_request_documents': {
          if (!input.snapshotId || !input.requestId) return { ok: false, code: 'request_required' };
          const result = await readDirectorRequestDocuments(runtime, actor.sessionId, { snapshotId: input.snapshotId, requestId: input.requestId });
          return { ok: true, read: { readId: 'director_request_documents', snapshotId: input.snapshotId, request: { requestId: result.item.request.id,
            employeeName: result.item.employee.name, startDate: result.item.request.startDate, documents: result.item.documents.map(document => document.documentType).sort() } } };
        }
        case 'director_approvals_today': {
          // Bounded paging: follow the engine's own cursor for up to APPROVALS_MAX_PAGES pages (never user-supplied); `hasMore` is true only when still more remain beyond that cap.
          const items: Extract<DirectorRead, { readId: 'director_approvals_today' }>['items'] = [];
          let cursor: string | undefined, asOf = '', more = false;
          for (let pageNo = 0; pageNo < APPROVALS_MAX_PAGES; pageNo++) {
            const page = await onboarding.directorApprovalsToday(actor.sessionId, { limit: APPROVALS_LIMIT, ...(cursor ? { cursor } : {}) });
            asOf ||= page.asOf;
            for (const item of page.items) items.push({ requestId: item.request.id, employeeName: item.employee.name, startDate: item.request.startDate, approvedAt: item.approval.approvedAt });
            more = page.nextCursor !== null;
            if (!more || !page.nextCursor) break;
            cursor = page.nextCursor;
          }
          return { ok: true, read: { readId: 'director_approvals_today', asOf, hasMore: more, items } };
        }
      }
    } catch (error) {
      const code = codeOf(error);
      if (code) return { ok: false, code: code === 'WORKFLOW_STALE' ? 'queue_stale' : code };
      throw error;
    }
  }

  function payloadOf(input: DecisionInput): WorkflowPayloadV2 {
    return workflowActionPayloadSchema.parse(input.kind === 'onboarding_return'
      ? { kind: input.kind, snapshotId: input.snapshotId, requestIds: input.requestIds, reason: input.reason }
      : { kind: input.kind, snapshotId: input.snapshotId, requestIds: input.requestIds });
  }

  async function bindDecision(actor: Actor, input: DecisionInput): Promise<DecisionBindResult> {
    if (!input.requestIds.length || new Set(input.requestIds).size !== input.requestIds.length) return { ok: false, code: 'invalid_selection' };
    let payload: WorkflowPayloadV2;
    try { payload = payloadOf(input); } catch { return { ok: false, code: 'invalid_selection' }; }
    const directorIdentityId = await principalIdentity(actor);
    if (!directorIdentityId) return { ok: false, code: 'not_permitted' };
    // V2's preparation checks without any write: authority + scope, snapshot (same session, unexpired, digest, policy, selected guards),
    // expected rows (request version + state, documents, manager approval proof), semantic reservations and existing effects.
    let projected: Awaited<ReturnType<typeof projectWorkflowCapabilities>>;
    try { projected = await projectWorkflowCapabilities(runtime, actor.sessionId, availability, { candidatePayloads: [payload] }); }
    catch (error) { const code = codeOf(error); if (code) return { ok: false, code }; throw error; }
    const capability = projected.find(item => item.kind === input.kind && item.behavior === 'prepare');
    if (!capability) return { ok: false, code: 'not_permitted' };
    const refs = capability.targetRefs.filter(ref => ref.table === 'onboarding_requests').map(ref => ref.id);
    if (!capability.available || capability.snapshotRef?.id !== input.snapshotId || !sameSet(refs, input.requestIds) || capability.eligibleCount !== input.requestIds.length) {
      return { ok: false, code: capability.disabledReason?.code ?? 'NO_ELIGIBLE_TARGETS' };
    }
    const snapshot = await storedSnapshot(input.snapshotId);
    if (!snapshot || snapshot.digest !== capability.snapshotRef.digest) return { ok: false, code: 'queue_stale' };
    const requests: DecisionBinding['requests'] = [];
    for (const requestId of input.requestIds) {
      const row = await reader().get('onboarding_requests', requestId);
      const reviewed = snapshot.expectedRows.find(expected => expected.ref.table === 'onboarding_requests' && expected.ref.id === requestId);
      if (!row || !reviewed || row.rowVersion !== reviewed.rowVersion) return { ok: false, code: 'queue_stale' };
      const request = onboardingRequestSchema.parse(row.body);
      if (request.state !== 'director_approval_pending' || request.directorIdentityId !== directorIdentityId) return { ok: false, code: 'queue_stale' };
      requests.push({ requestId, rowVersion: row.rowVersion, employeeName: await employeeName(request.employeeId), startDate: request.startDate });
    }
    const binding: DecisionBinding = { kind: input.kind, snapshotId: snapshot.id, snapshotDigest: snapshot.digest, expiresAt: snapshot.expiresAt,
      requestIds: [...input.requestIds], ...(input.kind === 'onboarding_return' ? { reason: input.reason } : {}), directorIdentityId, requests };
    return { ok: true, binding, bindingDigest: decisionDigest(binding, snapshot.policy.digest) };
  }

  /** Independent readback of the committed V2 decision: receipt, approval events and the request rows themselves. */
  async function decisionReadback(actor: Actor, kind: DirectorDecisionKind, executionId: string, requestIds: readonly string[], directorIdentityId: string,
    states: ReadonlySet<string>): Promise<{ receipt: WorkflowReceiptV2; requests: DecisionReceipt['requests'] } | undefined> {
    const executionRow = await reader().get('action_executions', executionId);
    const parsed = workflowReceiptV2Schema.safeParse(executionRow?.body);
    if (!parsed.success || parsed.data.outcome !== 'verified_success' || parsed.data.kind !== kind || parsed.data.actorId !== actor.id || !parsed.data.verifiedAt) return undefined;
    const receipt = parsed.data;
    const stage = kind === 'onboarding_director_approve' ? 'director' : 'return';
    const decision = kind === 'onboarding_director_approve' ? 'approved' : 'returned_for_revision';
    const events = new Map<string, { id: string }>();
    for (const proof of receipt.proofs) {
      if (proof.ref.table !== 'onboarding_approval_events' || proof.outcome !== 'verified_success') continue;
      const event = (await reader().get<{ id: string; requestId: string; executionId: string; stage: string; decision: string; actorIdentityId: string }>('onboarding_approval_events', proof.ref.id))?.body;
      if (event && event.executionId === executionId && event.stage === stage && event.decision === decision && event.actorIdentityId === directorIdentityId) events.set(event.requestId, event);
    }
    const requests: DecisionReceipt['requests'] = [];
    for (const requestId of requestIds) {
      const event = events.get(requestId);
      const row = await reader().get('onboarding_requests', requestId);
      if (!event || !row) return undefined;
      const request = onboardingRequestSchema.parse(row.body);
      if (!states.has(request.state) || request.directorIdentityId !== directorIdentityId) return undefined;
      if (kind === 'onboarding_director_approve' && (request.directorApprovalEventId !== event.id || request.directorApprovedBy !== directorIdentityId)) return undefined;
      requests.push({ requestId, employeeName: await employeeName(request.employeeId), startDate: request.startDate, state: request.state });
    }
    return { receipt, requests };
  }

  async function ensureExecutionConversation(actor: Actor): Promise<string> {
    const conversationId = workflowExecutionConversationId(actor.id);
    await runtime.store.workflowTransaction(async tx => {
      const existing = await tx.workflowProjectionReader.get<{ actorId?: string; archivedAt?: string | null }>('conversations', conversationId);
      if (existing) {
        if (existing.body.actorId !== actor.id || existing.body.archivedAt) throw new DomainError('WORKFLOW_CONFLICT', 'The workflow execution log is unavailable', 409);
        return;
      }
      const at = deps.now().toISOString();
      const inserted = await tx.insertUnique('conversations', { id: conversationId, actorId: actor.id, title: 'บันทึกการดำเนินการ Workflow (ระบบ)', pinned: false,
        archivedAt: null, rowVersion: 1, createdAt: at, updatedAt: at, lastScope: null, lastDashboardId: null },
      { constraint: 'conversations_primary_key', values: { id: conversationId } });
      if (!inserted.inserted && inserted.existing.actorId !== actor.id) throw new DomainError('WORKFLOW_CONFLICT', 'The workflow execution log is unavailable', 409);
    });
    return conversationId;
  }

  async function executeDecision(actor: Actor, input: DecisionInput & { bindingDigest: string; proposalId: string; reclaimed: boolean; fence?: EffectFence }): Promise<DecisionExecuteResult> {
    const directorIdentityId = await principalIdentity(actor);
    if (!directorIdentityId) return { ok: false, code: 'not_permitted' };
    const states = new Set([input.kind === 'onboarding_director_approve' ? 'director_approved' : 'returned_for_revision']);
    const conversationId = workflowExecutionConversationId(actor.id);
    const operation = { conversationId, turnId: `wfx-turn-${input.proposalId}` };
    const finish = async (executionId: string, already: boolean): Promise<DecisionExecuteResult> => {
      const back = await decisionReadback(actor, input.kind, executionId, input.requestIds, directorIdentityId, states);
      if (!back) return { ok: false, code: 'unverified' };
      return { ok: true, receipt: { kind: input.kind, executionIds: [executionId], verifiedAt: back.receipt.verifiedAt!, already, requests: back.requests } };
    };
    // Crash recovery of THIS proposal (expired claim lease): the V2 action it already prepared is re-confirmed (V2 reconciles, never re-executes).
    if (input.reclaimed) {
      const prior = await reader().query<{ id: string; turnId: string; contractVersion?: number }>({ kind: 'scoped', table: 'pending_actions', ownerId: actor.id,
        equals: { conversationId, turnId: operation.turnId }, limit: 10 });
      const action = prior.find(row => row.body.contractVersion === 2 && row.body.turnId === operation.turnId);
      if (action) {
        const confirmed = await runner.confirm(actor.sessionId, action.id, `wfx-recover-${input.proposalId}`.slice(0, 160), operation);
        if (confirmed.receipt?.outcome === 'verified_success') return finish(confirmed.receipt.id, true);
        // The earlier attempt of THIS proposal may have committed: unless V2 PROVES nothing committed, never fall through to a fresh binding (it would
        // report the now-changed rows as stale / "no rows executed"); the outcome is unknown.
        if (!provenNotCommitted(confirmed)) return { ok: false, code: 'unverified' };
      }
    }
    // Fresh binding at confirm: exact snapshot, the SAME request ids/versions, Director identity, authority. Any change fails the whole batch.
    const fresh = await bindDecision(actor, input);
    if (!fresh.ok) return { ok: false, code: fresh.code };
    if (fresh.bindingDigest !== input.bindingDigest) return { ok: false, code: 'binding_changed' };
    await ensureExecutionConversation(actor);
    // Router claim + session-mode fence immediately before the V2 effect; V2 then re-pins the session mode inside its own transaction.
    if (input.fence) await deps.store.transaction(async tx => { await input.fence!(tx); });
    const prepared = await runtime.prepare(actor.sessionId, payloadOf(input), operation, { expectedMode: actor.mode, expectedModeRevision: actor.modeRevision });
    if (prepared.outcome === 'already_completed' && prepared.existingExecutionId) return finish(prepared.existingExecutionId, true);
    if (prepared.outcome !== 'pending' || !prepared.pendingAction) return { ok: false, code: prepared.reasons[0]?.code ?? (prepared.existingExecutionId ? 'in_progress' : prepared.outcome) };
    const confirmed = await runner.confirm(actor.sessionId, prepared.pendingAction.id, `wfx-confirm-${input.proposalId}`.slice(0, 160), operation);
    if (confirmed.error || confirmed.receipt?.outcome !== 'verified_success') return { ok: false, code: provenNotCommitted(confirmed) ? confirmed.error!.code : 'unverified' };
    return finish(confirmed.receipt.id, false);
  }

  /** Recipients: the requesting (manager-stage) directory identity of each approved request; never a free-form address. */
  async function bindEmail(actor: Actor, input: EmailInput): Promise<EmailBindResult> {
    if (!input.requestIds.length || !input.executionIds.length) return { ok: false, code: 'approval_unavailable' };
    const directorIdentityId = await principalIdentity(actor);
    if (!directorIdentityId) return { ok: false, code: 'not_permitted' };
    const requests: EmailBinding['requests'] = [];
    for (const executionId of input.executionIds) {
      const ids = input.requestIds.filter(requestId => !requests.some(item => item.requestId === requestId));
      const back = await decisionReadback(actor, 'onboarding_director_approve', executionId, ids, directorIdentityId, APPROVED_STATES).catch(() => undefined);
      if (back) requests.push(...back.requests);
    }
    // The approval claim is bound to the verified receipt: every request is still approved (or later) by this Director's verified decision.
    if (!sameSet(requests.map(item => item.requestId), input.requestIds)) return { ok: false, code: 'approval_changed' };
    const recipients: EmailRecipient[] = [], versions: Record<string, number> = {};
    for (const requestId of input.requestIds) {
      const request = onboardingRequestSchema.parse((await reader().get('onboarding_requests', requestId))?.body);
      const row = await reader().get('directory_identities', request.managerIdentityId);
      const identity = directoryIdentitySchema.safeParse(row?.body);
      if (!row || !identity.success || !identity.data.active || !identity.data.allowedChannels.includes('simulated_email') || identity.data.classificationCeiling !== 'internal') continue;
      if (recipients.some(recipient => recipient.identityId === identity.data.id)) continue;
      versions[identity.data.id] = row.rowVersion;
      recipients.push({ identityId: identity.data.id, name: identity.data.displayName, destination: identity.data.verifiedDemoEmail });
    }
    if (!recipients.length) return { ok: false, code: 'no_recipient' };
    const binding: EmailBinding = { approvalId: input.approvalId, requestIds: [...input.requestIds], executionIds: [...input.executionIds], recipients,
      subject: input.subject, body: input.body, requests, directorIdentityId };
    return { ok: true, binding, bindingDigest: digest({ ...binding, requests: requests.map(item => item.requestId), versions }) };
  }

  async function deliverEmail(actor: Actor, input: EmailInput & { bindingDigest: string; proposalId: string; fence?: EffectFence }): Promise<EmailDeliverResult> {
    // Fresh at delivery: the approval is still verified and every recipient still authorized; any change fails closed (nothing sent).
    const fresh = await bindEmail(actor, input);
    if (!fresh.ok) return { ok: false, code: fresh.code };
    if (fresh.bindingDigest !== input.bindingDigest) return { ok: false, code: 'binding_changed' };
    const at = deps.now().toISOString();
    const rows = fresh.binding.recipients.map(recipient => simulatedEmailRowSchema.parse({ id: simulatedEmailRowId(input.proposalId, recipient.identityId),
      name: SIMULATED_EMAIL_TOOL, status: SIMULATED_EMAIL_STATUS, actorId: actor.id, proposalId: input.proposalId, approvalId: input.approvalId,
      channel: 'simulated_email', recipientIdentityId: recipient.identityId, recipientName: recipient.name, destinationIdentity: recipient.destination,
      subject: input.subject, body: input.body, requestIds: input.requestIds, executionIds: input.executionIds, createdAt: at }));
    let already = true;
    await deps.store.transaction(async tx => {
      await input.fence?.(tx);
      for (const row of rows) {
        const existing = simulatedEmailRowSchema.safeParse(await tx.get('tool_executions', row.id));
        // Exactly once per proposal + recipient (deterministic id): a retry finds the stored delivery and writes nothing.
        if (existing.success) { if (existing.data.actorId !== actor.id || existing.data.proposalId !== input.proposalId) throw new DomainError('EMAIL_CONFLICT', 'Delivery id conflict', 409); continue; }
        already = false;
        await tx.put('tool_executions', row);
      }
    });
    // Delivery verification: every stored simulated delivery is read back; one missing row means NOT delivered (never reported as sent).
    const delivered: { name: string; destination: string }[] = [];
    let deliveredAt = at;
    for (const row of rows) {
      const back = simulatedEmailRowSchema.safeParse(await deps.store.get('tool_executions', row.id));
      if (!back.success || back.data.actorId !== actor.id || back.data.recipientIdentityId !== row.recipientIdentityId || back.data.subject !== row.subject || back.data.body !== row.body) {
        return { ok: false, code: 'delivery_unverified' };
      }
      delivered.push({ name: back.data.recipientName, destination: back.data.destinationIdentity });
      deliveredAt = back.data.createdAt;
    }
    return { ok: true, delivered, already, deliveredAt };
  }

  return { capabilities, read, reviewedQueue, bindDecision, executeDecision, bindEmail, deliverEmail };
}

/** True only when V2 itself proves the confirm did not commit (typed, definite); every other failure after the confirm began is an UNKNOWN outcome. */
function provenNotCommitted(result: { receipt?: unknown; error?: { commitCertainty?: string; domainEffect?: string } | null }): boolean {
  const error = result.error;
  return !!error && !result.receipt && error.commitCertainty === 'definitely_not_committed' && error.domainEffect === 'none';
}

function decisionDigest(binding: DecisionBinding, policyDigest: string): string {
  return digest({ kind: binding.kind, snapshotId: binding.snapshotId, snapshotDigest: binding.snapshotDigest, requestIds: binding.requestIds,
    reason: binding.reason ?? null, directorIdentityId: binding.directorIdentityId, versions: binding.requests.map(item => [item.requestId, item.rowVersion]), policyDigest });
}

/** Simulated deliveries this actor sent for one email proposal (readback for receipts). */
export async function listSimulatedEmails(store: Pick<Store, 'list'>, actor: Pick<Actor, 'id'>): Promise<SimulatedEmailRow[]> {
  return (await store.list<unknown>('tool_executions', { actorId: actor.id, status: SIMULATED_EMAIL_STATUS })).map(row => simulatedEmailRowSchema.safeParse(row))
    .flatMap(parsed => parsed.success && parsed.data.actorId === actor.id ? [parsed.data] : []);
}
