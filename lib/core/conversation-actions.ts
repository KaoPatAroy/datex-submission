import { z } from 'zod';
import type { Actor, Transaction } from '../contracts';
import type { WorkflowTransactionContext } from '../storage/workflow-projections';
import {
  MAX_WORKFLOW_TARGETS, persistedConversationSchema, persistedConversationMessageSchema,
  type PersistedConversationMessage,
} from '../workflows/contracts';
import { invariant } from './errors';
import { digest } from './utils';

export type AssistantAnchorActor = Pick<Actor, 'id' | 'sessionId' | 'mode' | 'modeRevision'>;
export interface AssistantAnchorContext { readonly conversationId: string; readonly turnId: string }
export type AssistantAnchorContent = Partial<Pick<PersistedConversationMessage, 'text' | 'analysis' | 'evidence' | 'sources' | 'receiptId'>>;
export type AssistantAnchorAdapter =
  | { readonly kind: 'legacy'; readonly tx: Transaction }
  | { readonly kind: 'guarded'; readonly tx: WorkflowTransactionContext };
export interface AssistantAnchorOptions {
  readonly appendActionIds?: readonly string[];
  readonly content?: AssistantAnchorContent;
  readonly now: Date;
  /** An explicitly recovered legacy anchor; its persisted action references must prove the exact turn. */
  readonly existingMessageId?: string;
}
export interface AssistantAnchorResult {
  readonly message: PersistedConversationMessage;
  readonly actionIds: string[];
}

const identifier = persistedConversationMessageSchema.shape.id;
const actionIdentitySchema = z.object({
  id: identifier, actorId: identifier, sessionId: identifier, conversationId: identifier, turnId: identifier,
});
const contentSchema = persistedConversationMessageSchema.pick({
  text: true, analysis: true, evidence: true, sources: true, receiptId: true,
}).partial().strict();
const fallbackText = 'เตรียมคำขอแล้ว ยังไม่ได้ดำเนินการ — โปรดตรวจตัวอย่างและยืนยัน';

/** These adapters use the caller's active transaction; neither opens or commits another transaction. */
export function legacyAssistantAnchorAdapter(tx: Transaction): AssistantAnchorAdapter { return { kind: 'legacy', tx }; }
export function guardedAssistantAnchorAdapter(tx: WorkflowTransactionContext): AssistantAnchorAdapter { return { kind: 'guarded', tx }; }

export function assistantMessageId(actorId: string, context: AssistantAnchorContext): string {
  identifier.parse(actorId); identifier.parse(context.conversationId); identifier.parse(context.turnId);
  return 'message_' + digest({ actorId, conversationId: context.conversationId, turnId: context.turnId, role: 'assistant' });
}

function actionReferences(message: PersistedConversationMessage): string[] {
  return [...new Set([...(message.pendingActionIds ?? []), ...(message.pendingActionId ? [message.pendingActionId] : [])])];
}

/**
 * Link after action insertion, before the caller's transaction returns. Pass newly persisted IDs,
 * not an outside-transaction snapshot. All old and new references are read back in this transaction.
 * Explicit content updates final prose; preparation alone preserves existing prose and attribution.
 */
export async function linkAssistantMessage(
  adapter: AssistantAnchorAdapter, actor: AssistantAnchorActor, context: AssistantAnchorContext, options: AssistantAnchorOptions,
): Promise<AssistantAnchorResult> {
  const deterministicId = assistantMessageId(actor.id, context);
  identifier.parse(actor.sessionId);
  const appendIds = [...new Set((options.appendActionIds ?? []).map(actionId => identifier.parse(actionId)))];
  invariant(appendIds.length <= MAX_WORKFLOW_TARGETS, 'CONFLICT', 'Too many assistant action references', 409);
  const content = contentSchema.parse(options.content ?? {});
  const storedConversation = await adapter.tx.get('conversations', context.conversationId);
  invariant(storedConversation, 'NOT_FOUND', 'The conversation is unavailable', 404);
  const conversation = persistedConversationSchema.parse(storedConversation);
  invariant(conversation.id === context.conversationId && conversation.actorId === actor.id,
    'NOT_FOUND', 'The conversation is unavailable', 404);
  invariant(!conversation.archivedAt, 'ARCHIVED_CONVERSATION', 'The conversation is archived', 409);

  const readAction = async (actionId: string): Promise<void> => {
    const parsed = actionIdentitySchema.safeParse(await adapter.tx.get('pending_actions', actionId));
    invariant(parsed.success && parsed.data.id === actionId && parsed.data.actorId === actor.id &&
      parsed.data.sessionId === actor.sessionId && parsed.data.conversationId === context.conversationId && parsed.data.turnId === context.turnId,
    'CONFLICT', 'An assistant action reference does not belong to this exact turn', 409);
  };
  for (const actionId of appendIds) await readAction(actionId);

  let candidates: PersistedConversationMessage[];
  if (adapter.kind === 'legacy') {
    const appendSet = new Set(appendIds);
    candidates = (await adapter.tx.list<unknown>('conversation_messages', { actorId: actor.id }))
      .map(row => persistedConversationMessageSchema.parse(row))
      .filter(message => message.conversationId === context.conversationId && message.role === 'assistant' &&
        ((message.turnId === context.turnId && message.sessionId === actor.sessionId) ||
          actionReferences(message).some(actionId => appendSet.has(actionId))));
  } else {
    // Projection pages allow at most 100 rows; a full page cannot establish uniqueness.
    const limit = 100;
    const rows = await adapter.tx.workflowProjectionReader.query<unknown>({ kind: 'scoped', table: 'conversation_messages',
      equals: { actorId: actor.id, sessionId: actor.sessionId, conversationId: context.conversationId, turnId: context.turnId }, limit });
    invariant(rows.length < limit, 'CONFLICT', 'The assistant message identity set cannot be established', 409);
    candidates = rows.map(row => persistedConversationMessageSchema.parse(row.body)).filter(message => message.role === 'assistant');
  }
  invariant(candidates.length <= 1, 'CONFLICT', 'The turn has conflicting assistant messages', 409);
  const selectedId = options.existingMessageId === undefined ? candidates[0]?.id ?? deterministicId : identifier.parse(options.existingMessageId);
  invariant(!candidates[0] || candidates[0].id === selectedId, 'CONFLICT', 'The recovered assistant message identity conflicts', 409);
  if (selectedId !== deterministicId) {
    invariant(!await adapter.tx.get('conversation_messages', deterministicId), 'CONFLICT', 'The turn has conflicting assistant messages', 409);
  }
  const projected = adapter.kind === 'guarded'
    ? await adapter.tx.workflowProjectionReader.get<unknown>('conversation_messages', selectedId) : undefined;
  const raw = adapter.kind === 'guarded' ? projected?.body : await adapter.tx.get('conversation_messages', selectedId);
  const existing = raw === undefined ? undefined : persistedConversationMessageSchema.parse(raw);
  invariant(options.existingMessageId === undefined || existing, 'NOT_FOUND', 'The recovered assistant message is unavailable', 404);
  if (existing) {
    invariant(existing.id === selectedId && existing.actorId === actor.id && existing.conversationId === context.conversationId &&
      existing.role === 'assistant' && (existing.turnId === undefined || existing.turnId === context.turnId) &&
      (existing.sessionId === undefined || existing.sessionId === actor.sessionId),
    'CONFLICT', 'The assistant message does not belong to this exact turn', 409);
    invariant((existing.turnId === context.turnId && existing.sessionId === actor.sessionId) || actionReferences(existing).length > 0,
      'CONFLICT', 'The legacy assistant message lacks an exact action anchor', 409);
  }
  const previousIds = existing ? actionReferences(existing) : [];
  for (const actionId of previousIds) await readAction(actionId);
  const actionIds = [...new Set([...previousIds, ...appendIds])];
  invariant(actionIds.length <= MAX_WORKFLOW_TARGETS, 'CONFLICT', 'Too many assistant action references', 409);
  let message = persistedConversationMessageSchema.parse({
    ...existing, ...content, id: selectedId, ...context, actorId: actor.id, sessionId: actor.sessionId, role: 'assistant',
    text: content.text ?? existing?.text ?? fallbackText, mode: existing?.mode ?? actor.mode,
    modeRevision: existing?.modeRevision ?? actor.modeRevision, createdAt: existing?.createdAt ?? options.now.toISOString(),
    ...(actionIds.length ? { pendingActionIds: actionIds, pendingActionId: actionIds[actionIds.length - 1] } : {}),
  });
  if (existing && digest(message) === digest(existing)) return { message: existing, actionIds };
  if (adapter.kind === 'legacy') {
    if (existing?.rowVersion !== undefined) message = { ...message, rowVersion: existing.rowVersion + 1 };
    await adapter.tx.put('conversation_messages', message);
  } else if (projected) {
    const updated = await adapter.tx.compareAndSwap('conversation_messages', selectedId,
      { rowVersion: projected.rowVersion, state: null }, { ...message, rowVersion: projected.rowVersion + 1 });
    invariant(updated.updated, 'CONFLICT', 'The assistant message changed before linking', 409);
    message = updated.row;
  } else {
    const inserted = await adapter.tx.insertUnique('conversation_messages', { ...message, rowVersion: 1 },
      { constraint: 'conversation_messages_primary_key', values: { id: selectedId } });
    invariant(inserted.inserted, 'CONFLICT', 'The assistant message identity already exists', 409);
    message = inserted.row;
  }
  return { message, actionIds };
}
