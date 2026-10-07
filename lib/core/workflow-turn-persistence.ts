import 'server-only';
import { z } from 'zod';
import type { Profile, Store, Transaction } from '../contracts';
import type { WorkflowStoreCapability, WorkflowTransactionContext } from '../storage/workflow-projections';
import { reloadWorkflowPrincipal, authorizeWorkflowScope, type WorkflowPrincipal } from '../workflows/authority';
import { getWorkflowActionAuthority } from '../workflows/action-authority';
import { workflowApprovalHash } from '../workflows/action-runtime';
import { definitelyNotCommitted } from '../workflows/action-results';
import {
  directoryIdentitySchema, instantSchema, pendingActionV2Schema, persistedConversationMessageSchema,
  persistedConversationSchema, type PendingActionV2, type PersistedConversationMessage,
} from '../workflows/contracts';
import { workflowChatRequestV2Schema, type WorkflowChatRequestV2 } from '../workflows/api-contracts';
import type { WorkflowBrokerRequest } from './workflow-runtime';
import { reloadActor } from './auth';
import { DEFAULT_CONVERSATION_TITLE, getOwnedConversation, isDefaultConversationTitle, titleFromFirstMessage } from './conversations';
import { assistantMessageId, guardedAssistantAnchorAdapter, linkAssistantMessage, type AssistantAnchorContent } from './conversation-actions';
import { DomainError, invariant } from './errors';
import { digest, id } from './utils';
import {
  finalAssistantContentDigest, normalizedFinalActionIds, readCompletedTurn, turnCompletionId,
  turnCompletionRecordSchema, type TurnCompletionRecord,
} from './turn-completion-gate';

export interface WorkflowTurnPersistenceOptions {
  readonly store: Store & WorkflowStoreCapability;
  readonly now?: () => Date;
  readonly makeId?: (prefix: string) => string;
}

const identifier = directoryIdentitySchema.shape.id;
const recordSchema = z.object({
  id: identifier, name: z.literal('chat.turn_request'), actionContractVersion: z.literal(2),
  actorId: identifier, sessionId: identifier, conversationId: identifier, turnId: identifier,
  intentHash: z.string().regex(/^[a-f0-9]{64}$/), status: z.enum(['started', 'completed', 'failed']),
  mode: pendingActionV2Schema.shape.mode, modeRevision: pendingActionV2Schema.shape.modeRevision,
  createdAt: instantSchema,
  finalContentDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  finalActionIds: persistedConversationMessageSchema.shape.pendingActionIds.unwrap().optional(),
}).strict();
export type WorkflowTurnRecord = z.infer<typeof recordSchema>;

export type WorkflowTurnRecovery =
  | { readonly kind: 'recoverable'; readonly record: WorkflowTurnRecord; readonly userTurn: PersistedConversationMessage;
      readonly assistant: PersistedConversationMessage; readonly actions: readonly PendingActionV2[]; readonly principal: WorkflowPrincipal;
      readonly completion: TurnCompletionRecord | null; readonly publicCompleted: boolean }
  | { readonly kind: 'in_progress'; readonly record: WorkflowTurnRecord; readonly completion: TurnCompletionRecord | null }
  | { readonly kind: 'unavailable'; readonly record: WorkflowTurnRecord | null;
      readonly reason: 'request_not_found' | 'response_not_found' | 'references_unavailable' | 'final_content_unverified' | 'completion_unverified' };

export type WorkflowTurnAdmission =
  | { readonly kind: 'admitted'; readonly record: WorkflowTurnRecord; readonly userTurn: PersistedConversationMessage;
      readonly principal: WorkflowPrincipal; readonly brokerRequest: WorkflowBrokerRequest }
  | { readonly kind: 'recorded'; readonly recovery: WorkflowTurnRecovery };

export type WorkflowTurnFinalization = {
  readonly kind: 'finalized' | 'readback_required';
  readonly recovery: WorkflowTurnRecovery;
};

function now(options: WorkflowTurnPersistenceOptions): Date {
  const value = new Date((options.now ?? (() => new Date()))().getTime());
  instantSchema.parse(value.toISOString());
  return value;
}
function makeId(options: WorkflowTurnPersistenceOptions, prefix: string): string {
  return identifier.parse((options.makeId ?? id)(prefix));
}
function mustRethrow(error: unknown): boolean {
  return error instanceof z.ZodError || definitelyNotCommitted(error) ||
    (error instanceof DomainError && error.code !== 'TRANSPORT_OUTCOME_UNKNOWN');
}
function identity(actorId: string, sessionId: string, request: WorkflowChatRequestV2) {
  return {
    id: 'turnrequest_' + digest({ actorId, sessionId, key: request.requestKey }),
    intentHash: digest({ actorId, sessionId, conversationId: request.conversationId ?? null,
      message: request.message, actionContractVersion: request.actionContractVersion }),
  };
}
function parseRecord(raw: unknown, actorId: string, sessionId: string, request: WorkflowChatRequestV2): WorkflowTurnRecord {
  const parsed = recordSchema.safeParse(raw), expected = identity(actorId, sessionId, request);
  invariant(parsed.success && parsed.data.id === expected.id && parsed.data.actorId === actorId &&
    parsed.data.sessionId === sessionId && parsed.data.intentHash === expected.intentHash,
  'IDEMPOTENCY_CONFLICT', 'The request key belongs to different input or an incompatible turn protocol', 409);
  return parsed.data;
}
function exactUser(raw: unknown, record: WorkflowTurnRecord, request: WorkflowChatRequestV2): PersistedConversationMessage {
  const user = persistedConversationMessageSchema.parse(raw);
  invariant(user.id === record.turnId && user.role === 'user' && user.actorId === record.actorId &&
    user.sessionId === record.sessionId && user.conversationId === record.conversationId && user.turnId === record.turnId &&
    user.mode === record.mode && user.modeRevision === record.modeRevision && user.createdAt === record.createdAt &&
    user.text === request.message, 'CONFLICT', 'The recorded user turn does not establish this exact request', 409);
  return user;
}
function exactAssistant(raw: unknown, record: WorkflowTurnRecord): PersistedConversationMessage {
  const message = persistedConversationMessageSchema.parse(raw);
  invariant(message.id === assistantMessageId(record.actorId, record) && message.role === 'assistant' &&
    message.actorId === record.actorId && message.sessionId === record.sessionId && message.conversationId === record.conversationId &&
    message.turnId === record.turnId && message.mode === record.mode && message.modeRevision === record.modeRevision,
  'CONFLICT', 'The assistant anchor does not belong to the recorded turn', 409);
  return message;
}
function completionForRecord(raw: unknown, record: WorkflowTurnRecord): TurnCompletionRecord {
  const parsed = turnCompletionRecordSchema.safeParse(raw);
  invariant(parsed.success && parsed.data.id === turnCompletionId(record) && parsed.data.origin === 'chat' &&
    parsed.data.requestLedgerId === record.id && parsed.data.actorId === record.actorId && parsed.data.sessionId === record.sessionId &&
    parsed.data.conversationId === record.conversationId && parsed.data.turnId === record.turnId && parsed.data.mode === record.mode &&
    parsed.data.modeRevision === record.modeRevision && parsed.data.createdAt === record.createdAt && parsed.data.status === record.status,
  'TURN_COMPLETION_INVALID', 'The completion record does not establish this exact chat request', 409);
  const completion = parsed.data;
  invariant(completion.finalContentDigest === record.finalContentDigest &&
    (completion.finalActionIds === undefined) === (record.finalActionIds === undefined) &&
    (completion.finalActionIds === undefined || record.finalActionIds === undefined ||
      digest(normalizedActionIds(completion.finalActionIds)) === digest(normalizedActionIds(record.finalActionIds))),
  'TURN_COMPLETION_INVALID', 'The request and completion reservations conflict', 409);
  return completion;
}

async function legacyBookkeeping<T>(options: WorkflowTurnPersistenceOptions, work: (tx: Transaction) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await options.store.transaction(work); }
    catch (error) {
      const conflict = typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'CONFLICT';
      if (attempt >= 1 || !conflict || !definitelyNotCommitted(error)) throw error;
    }
  }
}
async function principal(options: WorkflowTurnPersistenceOptions, sessionId: string): Promise<WorkflowPrincipal> {
  return options.store.workflowTransaction(tx => reloadWorkflowPrincipal(tx, identifier.parse(sessionId), now(options).toISOString()));
}

function publicRecovery(recovery: WorkflowTurnRecovery): WorkflowTurnRecovery {
  if (recovery.kind === 'recoverable' && (recovery.principal.actor.mode !== recovery.record.mode ||
      recovery.principal.actor.modeRevision !== recovery.record.modeRevision || recovery.assistant.analysis !== undefined ||
      recovery.assistant.evidence !== undefined || recovery.assistant.sources !== undefined || recovery.assistant.receiptId !== undefined)) {
    // Completion proves persistence, not current citation authority. No broad historical proof exists here.
    return { kind: 'unavailable', record: recovery.record, reason: 'references_unavailable' };
  }
  return recovery;
}

/** A recorded key returns only authorized recovery metadata; it never grants permission to run an engine. */
export async function recoverRecordedTurn(options: WorkflowTurnPersistenceOptions, sessionId: string,
  input: WorkflowChatRequestV2): Promise<WorkflowTurnRecovery> {
  return publicRecovery(await recoverTurnState(options, sessionId, input));
}

/** Private integrity readback is never returned directly by an exported lifecycle operation. */
async function recoverTurnState(options: WorkflowTurnPersistenceOptions, sessionId: string,
  input: WorkflowChatRequestV2): Promise<WorkflowTurnRecovery> {
  const request = workflowChatRequestV2Schema.parse(input);
  return options.store.workflowTransaction(async tx => {
    const current = await reloadWorkflowPrincipal(tx, identifier.parse(sessionId), now(options).toISOString());
    const rawRecord = await tx.get('tool_executions', identity(current.actor.id, sessionId, request).id);
    if (!rawRecord) return { kind: 'unavailable', record: null, reason: 'request_not_found' };
    const record = parseRecord(rawRecord, current.actor.id, sessionId, request);
    const rawCompletion = await tx.get('tool_executions', turnCompletionId(record));
    let completion: TurnCompletionRecord | null = null;
    if (rawCompletion !== undefined) {
      try { completion = completionForRecord(rawCompletion, record); }
      catch (error) {
        if (!(error instanceof DomainError) || error.code !== 'TURN_COMPLETION_INVALID') throw error;
        return { kind: 'unavailable', record, reason: 'completion_unverified' };
      }
    }
    const conversation = persistedConversationSchema.parse(await getOwnedConversation(tx, current.actor.id, record.conversationId));
    invariant(!conversation.archivedAt, 'ARCHIVED_CONVERSATION', 'The conversation is archived', 409);
    const userTurn = exactUser(await tx.get('conversation_messages', record.turnId), record, request);
    const rawAnchor = await tx.get('conversation_messages', assistantMessageId(record.actorId, record));
    if (!rawAnchor) return record.status === 'started'
      ? { kind: 'in_progress', record, completion }
      : { kind: 'unavailable', record, reason: 'response_not_found' };
    const assistant = exactAssistant(rawAnchor, record);
    const references = messageActionIds(assistant);
    if (record.finalContentDigest !== undefined && (record.finalActionIds === undefined ||
        digest(normalizedActionIds(record.finalActionIds)) !== digest(references))) {
      return { kind: 'unavailable', record, reason: 'final_content_unverified' };
    }
    if (record.status === 'completed' && record.finalContentDigest !== undefined &&
        finalContentDigest(assistant, references) !== record.finalContentDigest) {
      return { kind: 'unavailable', record, reason: 'final_content_unverified' };
    }
    const actions: PendingActionV2[] = [];
    for (const actionId of references) {
      const row = await tx.workflowProjectionReader.get('pending_actions', actionId);
      if (!row) return { kind: 'unavailable', record, reason: 'references_unavailable' };
      const action = pendingActionV2Schema.parse(row.body);
      invariant(action.id === actionId && action.actorId === record.actorId && action.sessionId === record.sessionId &&
        action.conversationId === record.conversationId && action.turnId === record.turnId && action.mode === record.mode &&
        action.modeRevision === record.modeRevision && action.payloadHash === workflowApprovalHash(action),
      'CONFLICT', 'An assistant action reference does not belong to this exact recorded turn', 409);
      const authority = getWorkflowActionAuthority(action.payload.kind);
      try {
        invariant(authority.readPermissions.every(permission => current.actor.permissions.includes(permission)),
          'WORKFLOW_PERMISSION_DENIED', 'A required current read permission is absent', 403);
        authorizeWorkflowScope(current, { permission: authority.permission, roles: authority.roles, purpose: authority.purpose, targets: [
          ...action.approvedBranchIds.map(branchId => ({ branchId })),
          ...action.approvedOrgUnitIds.map(orgUnitId => ({ orgUnitId })),
        ] });
      } catch (error) {
        if (!(error instanceof DomainError) || error.status !== 403) throw error;
        return { kind: 'unavailable', record, reason: 'references_unavailable' };
      }
      actions.push(action);
    }
    const completed = completion === null ? undefined : await readCompletedTurn(tx, {
      actorId: record.actorId, sessionId: record.sessionId, conversationId: record.conversationId, turnId: record.turnId,
      mode: record.mode, modeRevision: record.modeRevision,
    });
    return { kind: 'recoverable', record, userTurn, assistant, actions, principal: current, completion,
      publicCompleted: completed?.kind === 'completed' && completed.record.origin === 'chat' && completed.record.requestLedgerId === record.id };
  });
}

/** Only an acknowledged new ledger/user-turn commit can return an admitted turn. */
export async function admitTurn(options: WorkflowTurnPersistenceOptions, sessionId: string,
  input: WorkflowChatRequestV2): Promise<WorkflowTurnAdmission> {
  const request = workflowChatRequestV2Schema.parse(input), initial = await principal(options, sessionId);
  const expected = identity(initial.actor.id, sessionId, request);
  let admitted: { record: WorkflowTurnRecord; userTurn: PersistedConversationMessage } | undefined;
  let recorded = false;
  try {
    await legacyBookkeeping(options, async tx => {
      const profile = await tx.get<Profile>('profiles', initial.actor.id);
      invariant(profile, 'UNAUTHENTICATED', 'The session profile is unavailable', 401);
      const current = await reloadActor(tx, { ...profile, sessionId, mode: initial.actor.mode, modeRevision: initial.actor.modeRevision }, now(options));
      const previous = await tx.get('tool_executions', expected.id);
      if (previous) { parseRecord(previous, current.id, sessionId, request); recorded = true; return; }
      const existing = request.conversationId ? await getOwnedConversation(tx, current.id, request.conversationId) : undefined;
      invariant(!existing?.archivedAt, 'ARCHIVED_CONVERSATION', 'The conversation is archived', 409);
      const conversationId = existing?.id ?? makeId(options, 'conversation'), turnId = makeId(options, 'turn');
      invariant(!await tx.get('conversation_messages', turnId) && (existing || !await tx.get('conversations', conversationId)),
        'CONFLICT', 'The new turn identity is already in use', 409);
      const timestamp = now(options).toISOString();
      const version = existing && Number.isSafeInteger(existing.rowVersion) && (existing.rowVersion ?? 0) >= 1 ? existing.rowVersion! : 1;
      const conversation = persistedConversationSchema.parse({ title: DEFAULT_CONVERSATION_TITLE, pinned: false, pinnedAt: null,
        archivedAt: null, lastScope: null, lastDashboardId: null, ...existing,
        ...(isDefaultConversationTitle(existing?.title) ? { title: titleFromFirstMessage(request.message) ?? DEFAULT_CONVERSATION_TITLE } : {}), id: conversationId, actorId: current.id,
        createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp, rowVersion: existing ? version + 1 : 1 });
      const record = recordSchema.parse({ ...expected, name: 'chat.turn_request', actionContractVersion: 2,
        actorId: current.id, sessionId, conversationId, turnId, status: 'started', mode: current.mode,
        modeRevision: current.modeRevision, createdAt: timestamp });
      const userTurn = persistedConversationMessageSchema.parse({ id: turnId, actorId: current.id, sessionId, conversationId,
        turnId, role: 'user', text: request.message, mode: current.mode, modeRevision: current.modeRevision, createdAt: timestamp });
      const completion = turnCompletionRecordSchema.parse({ id: turnCompletionId(record), name: 'chat.turn_completion', schemaVersion: 1,
        origin: 'chat', requestLedgerId: record.id, actorId: record.actorId, sessionId, conversationId, turnId,
        mode: record.mode, modeRevision: record.modeRevision, status: 'started', createdAt: timestamp });
      invariant(!await tx.get('tool_executions', completion.id), 'TURN_COMPLETION_INVALID', 'The new completion identity is already in use', 409);
      await tx.put('conversations', conversation);
      await tx.put('conversation_messages', userTurn);
      await tx.put('tool_executions', record);
      await tx.put('tool_executions', completion);
      admitted = { record, userTurn };
    });
  } catch (error) {
    if (mustRethrow(error)) throw error;
    // Readback after an unacknowledged admission never reclassifies it as a fresh dispatch.
    return { kind: 'recorded', recovery: await recoverRecordedTurn(options, sessionId, request) };
  }
  if (recorded) return { kind: 'recorded', recovery: await recoverRecordedTurn(options, sessionId, request) };
  invariant(admitted, 'CONFLICT', 'A fresh turn admission was not established', 409);
  const current = await principal(options, sessionId);
  invariant(current.actor.id === admitted.record.actorId && current.actor.mode === admitted.record.mode &&
    current.actor.modeRevision === admitted.record.modeRevision, 'WORKFLOW_STALE', 'The admitted turn mode changed', 409);
  return { kind: 'admitted', record: Object.freeze(admitted.record), userTurn: Object.freeze(admitted.userTurn), principal: current,
    brokerRequest: Object.freeze({ conversationId: admitted.record.conversationId, turnId: admitted.record.turnId,
      expectedMode: admitted.record.mode, expectedModeRevision: admitted.record.modeRevision }) };
}

const contentSchema = persistedConversationMessageSchema.pick({ analysis: true, evidence: true, sources: true, receiptId: true }).partial().extend({
  text: persistedConversationMessageSchema.shape.text.min(1).refine(value => value.trim().length > 0, 'Final text cannot be blank').optional(),
}).strict();
function normalizedActionIds(actionIds: readonly string[]): string[] { return [...new Set(actionIds)].sort(); }
function messageActionIds(message?: PersistedConversationMessage): string[] {
  return normalizedFinalActionIds(message ?? {});
}
function finalContentDigest(content: AssistantAnchorContent, actionIds: readonly string[]): string {
  return finalAssistantContentDigest(content, normalizedActionIds(actionIds));
}
function finalContent(message: PersistedConversationMessage | undefined, patch: AssistantAnchorContent): AssistantAnchorContent {
  const merged = { ...message, ...patch, text: patch.text ?? message?.text };
  invariant(merged.text !== undefined, 'INVALID_INPUT', 'A new assistant reply requires explicit final text', 400);
  return contentSchema.parse({ text: merged.text, analysis: merged.analysis, evidence: merged.evidence,
    sources: merged.sources, receiptId: merged.receiptId });
}
function completedContent(recovery: WorkflowTurnRecovery, expectedDigest: string): boolean {
  return recovery.kind === 'recoverable' && recovery.record.finalContentDigest === expectedDigest &&
    recovery.completion?.finalContentDigest === expectedDigest && recovery.completion.finalActionIds !== undefined &&
    recovery.record.finalActionIds !== undefined &&
    digest(normalizedActionIds(recovery.completion.finalActionIds)) === digest(normalizedActionIds(recovery.record.finalActionIds)) &&
    digest(normalizedActionIds(recovery.record.finalActionIds)) === digest(messageActionIds(recovery.assistant)) &&
    finalContentDigest(recovery.assistant, messageActionIds(recovery.assistant)) === expectedDigest;
}
async function finalizationRecord(tx: WorkflowTransactionContext, sessionId: string, request: WorkflowChatRequestV2,
  timestamp: string): Promise<{ current: WorkflowPrincipal; record: WorkflowTurnRecord }> {
  const current = await reloadWorkflowPrincipal(tx, sessionId, timestamp);
  const record = parseRecord(await tx.get('tool_executions', identity(current.actor.id, sessionId, request).id), current.actor.id, sessionId, request);
  exactUser(await tx.get('conversation_messages', record.turnId), record, request);
  return { current, record };
}

/** Final prose and legacy ledger completion are sequential; no engine or preparation is retried. */
export async function finalizeTurn(options: WorkflowTurnPersistenceOptions, sessionId: string, input: WorkflowChatRequestV2,
  inputContent: AssistantAnchorContent): Promise<WorkflowTurnFinalization> {
  const request = workflowChatRequestV2Schema.parse(input), content = contentSchema.parse(inputContent);
  const initial = await principal(options, sessionId);
  let reservedDigest: string | undefined;
  let reservedActionIds: string[] | undefined;
  try {
    await legacyBookkeeping(options, async tx => {
      const profile = await tx.get<Profile>('profiles', initial.actor.id);
      invariant(profile, 'UNAUTHENTICATED', 'The session profile is unavailable', 401);
      const current = await reloadActor(tx, { ...profile, sessionId, mode: initial.actor.mode, modeRevision: initial.actor.modeRevision }, now(options));
      const record = parseRecord(await tx.get('tool_executions', identity(current.id, sessionId, request).id), current.id, sessionId, request);
      const completion = completionForRecord(await tx.get('tool_executions', turnCompletionId(record)), record);
      exactUser(await tx.get('conversation_messages', record.turnId), record, request);
      const conversation = await getOwnedConversation(tx, current.id, record.conversationId);
      invariant(!conversation.archivedAt, 'ARCHIVED_CONVERSATION', 'The conversation is archived', 409);
      invariant(record.status !== 'failed', 'TURN_REQUEST_FAILED', 'A failed turn may only be recovered read-only', 409);
      invariant(current.mode === record.mode && current.modeRevision === record.modeRevision,
        'WORKFLOW_STALE', 'The turn mode changed before final content reservation', 409);
      const rawAnchor = await tx.get('conversation_messages', assistantMessageId(record.actorId, record));
      const anchor = rawAnchor === undefined ? undefined : exactAssistant(rawAnchor, record);
      const actionIds = messageActionIds(anchor);
      const proposedDigest = finalContentDigest(finalContent(anchor, content), actionIds);
      invariant(record.finalContentDigest === undefined || record.finalContentDigest === proposedDigest,
        'IDEMPOTENCY_CONFLICT', 'The turn already reserved different final content', 409);
      invariant(record.finalContentDigest === undefined || (record.finalActionIds !== undefined &&
        digest(normalizedActionIds(record.finalActionIds)) === digest(actionIds)),
      'IDEMPOTENCY_CONFLICT', 'The turn already reserved a different action set', 409);
      if (record.status === 'completed') invariant(anchor && finalContentDigest(anchor, actionIds) === proposedDigest,
        'IDEMPOTENCY_CONFLICT', 'The completed turn has different final content', 409);
      reservedDigest = proposedDigest;
      reservedActionIds = actionIds;
      if (record.finalContentDigest === undefined) await tx.put('tool_executions', {
        ...record, finalContentDigest: proposedDigest, finalActionIds: actionIds,
      });
      if (completion.finalContentDigest === undefined) await tx.put('tool_executions', turnCompletionRecordSchema.parse({
        ...completion, assistantMessageId: assistantMessageId(record.actorId, record), finalContentDigest: proposedDigest, finalActionIds: actionIds,
      }));
    });
  } catch (error) {
    if (mustRethrow(error)) throw error;
    const recovery = await recoverTurnState(options, sessionId, request);
    const completion = recovery.kind === 'unavailable' ? undefined : recovery.completion;
    if (reservedDigest === undefined || reservedActionIds === undefined || recovery.record?.finalContentDigest !== reservedDigest ||
        recovery.record.finalActionIds === undefined || digest(normalizedActionIds(recovery.record.finalActionIds)) !== digest(reservedActionIds) ||
        completion?.finalContentDigest !== reservedDigest || completion.finalActionIds === undefined ||
        digest(normalizedActionIds(completion.finalActionIds)) !== digest(reservedActionIds)) {
      return { kind: 'readback_required', recovery: publicRecovery(recovery) };
    }
  }
  invariant(reservedDigest && reservedActionIds !== undefined, 'CONFLICT', 'The final content reservation was not established', 409);
  const expectedDigest = reservedDigest;
  const expectedActionIds = reservedActionIds;
  try {
    await options.store.workflowTransaction(async tx => {
      const timestamp = now(options), { current, record } = await finalizationRecord(tx, sessionId, request, timestamp.toISOString());
      completionForRecord(await tx.get('tool_executions', turnCompletionId(record)), record);
      invariant(record.status !== 'failed', 'TURN_REQUEST_FAILED', 'A failed turn may only be recovered read-only', 409);
      invariant(current.actor.mode === record.mode && current.actor.modeRevision === record.modeRevision,
        'WORKFLOW_STALE', 'The turn mode changed before finalization', 409);
      invariant(record.finalContentDigest === expectedDigest, 'IDEMPOTENCY_CONFLICT', 'The final content reservation changed', 409);
      invariant(record.finalActionIds !== undefined && digest(normalizedActionIds(record.finalActionIds)) === digest(expectedActionIds),
        'IDEMPOTENCY_CONFLICT', 'The final action reservation changed', 409);
      const anchorId = assistantMessageId(record.actorId, record), rawAnchor = await tx.get('conversation_messages', anchorId);
      const anchor = rawAnchor === undefined ? undefined : exactAssistant(rawAnchor, record);
      const proposedContent = finalContent(anchor, content);
      invariant(digest(messageActionIds(anchor)) === digest(expectedActionIds),
        'IDEMPOTENCY_CONFLICT', 'The assistant action set changed after final content reservation', 409);
      invariant(finalContentDigest(proposedContent, expectedActionIds) === expectedDigest,
        'IDEMPOTENCY_CONFLICT', 'The assistant no longer matches the reserved final content', 409);
      if (record.status === 'completed') {
        invariant(anchor && finalContentDigest(anchor, messageActionIds(anchor)) === expectedDigest,
          'IDEMPOTENCY_CONFLICT', 'The completed turn has different final content', 409);
        return;
      }
      const linked = await linkAssistantMessage(guardedAssistantAnchorAdapter(tx), current.actor,
        { conversationId: record.conversationId, turnId: record.turnId }, { content: proposedContent, now: timestamp });
      invariant(linked.message.id === anchorId, 'CONFLICT', 'The assistant message identity is not deterministic', 409);
      exactAssistant(linked.message, record);
      invariant(finalContentDigest(linked.message, messageActionIds(linked.message)) === expectedDigest,
        'CONFLICT', 'The persisted final content or action set does not match its reservation', 409);
    });
  } catch (error) {
    if (error instanceof z.ZodError || (error instanceof DomainError && error.code !== 'TRANSPORT_OUTCOME_UNKNOWN')) throw error;
    const recovery = await recoverTurnState(options, sessionId, request);
    if (!completedContent(recovery, expectedDigest)) return { kind: 'readback_required', recovery: publicRecovery(recovery) };
  }
  const anchored = await recoverTurnState(options, sessionId, request);
  if (anchored.kind !== 'recoverable' || !completedContent(anchored, expectedDigest)) {
    return { kind: 'readback_required', recovery: publicRecovery(anchored) };
  }
  try {
    await legacyBookkeeping(options, async tx => {
      const profile = await tx.get<Profile>('profiles', anchored.record.actorId);
      invariant(profile, 'UNAUTHENTICATED', 'The session profile is unavailable', 401);
      const current = await reloadActor(tx, { ...profile, sessionId, mode: anchored.record.mode, modeRevision: anchored.record.modeRevision }, now(options));
      invariant(current.mode === anchored.record.mode && current.modeRevision === anchored.record.modeRevision,
        'WORKFLOW_STALE', 'The turn mode changed before ledger completion', 409);
      const record = parseRecord(await tx.get('tool_executions', anchored.record.id), anchored.record.actorId, sessionId, request);
      const completion = completionForRecord(await tx.get('tool_executions', turnCompletionId(record)), record);
      exactUser(await tx.get('conversation_messages', record.turnId), record, request);
      const assistant = exactAssistant(await tx.get('conversation_messages', assistantMessageId(record.actorId, record)), record);
      invariant(record.finalContentDigest === expectedDigest && record.finalActionIds !== undefined &&
        digest(normalizedActionIds(record.finalActionIds)) === digest(expectedActionIds) &&
        finalContentDigest(assistant, messageActionIds(assistant)) === expectedDigest,
        'CONFLICT', 'The finalized assistant content no longer matches its reservation', 409);
      invariant(record.status !== 'failed', 'TURN_REQUEST_FAILED', 'The turn was marked failed before completion', 409);
      if (record.status !== 'completed') await tx.put('tool_executions', { ...record, status: 'completed' });
      if (completion.status !== 'completed') await tx.put('tool_executions', turnCompletionRecordSchema.parse({
        ...completion, status: 'completed', assistantMessageId: assistant.id,
      }));
    });
  } catch (error) {
    if (mustRethrow(error)) throw error;
    const recovery = await recoverTurnState(options, sessionId, request);
    return { kind: recovery.kind === 'recoverable' && recovery.publicCompleted && completedContent(recovery, expectedDigest)
      ? 'finalized' : 'readback_required', recovery: publicRecovery(recovery) };
  }
  const recovery = await recoverTurnState(options, sessionId, request);
  return { kind: recovery.kind === 'recoverable' && recovery.publicCompleted && completedContent(recovery, expectedDigest)
    ? 'finalized' : 'readback_required', recovery: publicRecovery(recovery) };
}

/** Explicit engine failure/cancellation closes only a still-started pair; finalization retries do not call this. */
export async function failTurn(options: WorkflowTurnPersistenceOptions, sessionId: string,
  input: WorkflowChatRequestV2): Promise<WorkflowTurnRecovery> {
  const request = workflowChatRequestV2Schema.parse(input), initial = await principal(options, sessionId);
  try {
    await legacyBookkeeping(options, async tx => {
      const profile = await tx.get<Profile>('profiles', initial.actor.id);
      invariant(profile, 'UNAUTHENTICATED', 'The session profile is unavailable', 401);
      const current = await reloadActor(tx, { ...profile, sessionId, mode: initial.actor.mode, modeRevision: initial.actor.modeRevision }, now(options));
      const record = parseRecord(await tx.get('tool_executions', identity(current.id, sessionId, request).id), current.id, sessionId, request);
      const completion = completionForRecord(await tx.get('tool_executions', turnCompletionId(record)), record);
      exactUser(await tx.get('conversation_messages', record.turnId), record, request);
      await getOwnedConversation(tx, current.id, record.conversationId);
      if (record.status !== 'started' || completion.status !== 'started') return;
      await tx.put('tool_executions', { ...record, status: 'failed' });
      await tx.put('tool_executions', turnCompletionRecordSchema.parse({ ...completion, status: 'failed' }));
    });
  } catch (error) {
    if (mustRethrow(error)) throw error;
    // An unacknowledged close is observed by readback, never inferred or changed to completed.
  }
  return recoverRecordedTurn(options, sessionId, request);
}
