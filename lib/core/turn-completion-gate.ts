import 'server-only';
import { z } from 'zod';
import {
  directoryIdentitySchema, instantSchema, persistedConversationMessageSchema,
  type PersistedConversationMessage,
} from '../workflows/contracts';
import { turnFailureReasonSchema, type Reader } from '../contracts';
import { assistantMessageId, type AssistantAnchorContent } from './conversation-actions';
import { invariant } from './errors';
import { digest } from './utils';
import { listByIds } from '../storage/batch';

const identifier = directoryIdentitySchema.shape.id;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const actionIdsSchema = persistedConversationMessageSchema.shape.pendingActionIds.unwrap();
const status = z.enum(['started', 'completed', 'failed']);

export const turnCompletionTupleSchema = z.object({
  actorId: identifier,
  sessionId: identifier,
  conversationId: identifier,
  turnId: identifier,
  mode: persistedConversationMessageSchema.shape.mode,
  modeRevision: persistedConversationMessageSchema.shape.modeRevision,
}).strict();
export type TurnCompletionTuple = z.infer<typeof turnCompletionTupleSchema>;

export function turnCompletionId(tuple: Pick<TurnCompletionTuple, 'actorId' | 'sessionId' | 'conversationId' | 'turnId'>): string {
  const identity = turnCompletionTupleSchema.pick({ actorId: true, sessionId: true, conversationId: true, turnId: true }).parse({
    actorId: tuple.actorId, sessionId: tuple.sessionId, conversationId: tuple.conversationId, turnId: tuple.turnId,
  });
  return 'turncompletion_' + digest(identity);
}

export const turnCompletionRecordSchema = turnCompletionTupleSchema.extend({
  id: identifier,
  name: z.literal('chat.turn_completion'),
  schemaVersion: z.literal(1),
  origin: z.enum(['chat', 'standalone_prepare']),
  requestLedgerId: identifier.nullable(),
  status,
  failureReason: turnFailureReasonSchema.optional(),
  createdAt: instantSchema.optional(),
  assistantMessageId: identifier.optional(),
  finalContentDigest: digestSchema.optional(),
  finalActionIds: actionIdsSchema.optional(),
}).strict().superRefine((record, context) => {
  if (record.id !== turnCompletionId({ actorId: record.actorId, sessionId: record.sessionId,
    conversationId: record.conversationId, turnId: record.turnId })) {
    context.addIssue({ code: 'custom', path: ['id'], message: 'The completion identity does not match its turn' });
  }
  if (record.origin === 'standalone_prepare' && (record.requestLedgerId !== null || record.status !== 'completed')) {
    context.addIssue({ code: 'custom', path: ['origin'], message: 'Standalone preparation requires its own completed disposition' });
  }
  if (record.origin === 'chat' && record.requestLedgerId === null) {
    context.addIssue({ code: 'custom', path: ['requestLedgerId'], message: 'Chat completion requires its keyed request ledger' });
  }
  if (record.status === 'completed' && (record.assistantMessageId === undefined ||
    record.finalContentDigest === undefined || record.finalActionIds === undefined)) {
    context.addIssue({ code: 'custom', path: ['status'], message: 'Completed turns require finalized content and references' });
  }
  if (record.failureReason !== undefined && record.status !== 'failed') {
    context.addIssue({ code: 'custom', path: ['failureReason'], message: 'Failure reasons apply only to failed turns' });
  }
  if (record.assistantMessageId !== undefined && record.assistantMessageId !== assistantMessageId(record.actorId, record)) {
    context.addIssue({ code: 'custom', path: ['assistantMessageId'], message: 'The completion requires the canonical assistant identity' });
  }
});
export type TurnCompletionRecord = z.infer<typeof turnCompletionRecordSchema>;

/** New keyed V1 and V2 ledgers share completion proof; old incomplete metadata is not grandfathered. */
export const turnRequestCompletionProofSchema = turnCompletionTupleSchema.extend({
  id: identifier,
  name: z.literal('chat.turn_request'),
  actionContractVersion: z.union([z.literal(1), z.literal(2)]).optional(),
  intentHash: digestSchema,
  /** A structured clarification pick is part of the request intent (the user message is only the choice label). */
  clarification: z.object({ choiceId: z.string().min(1).max(160), clarifiedTurnId: z.string().min(1).max(160) }).strict().optional(),
  status,
  failureReason: turnFailureReasonSchema.optional(),
  createdAt: instantSchema,
  finalContentDigest: digestSchema.optional(),
  finalActionIds: actionIdsSchema.optional(),
}).strict().superRefine((request, context) => {
  if (request.failureReason !== undefined && request.status !== 'failed') {
    context.addIssue({ code: 'custom', path: ['failureReason'], message: 'Failure reasons apply only to failed turns' });
  }
});
export type TurnRequestCompletionProof = z.infer<typeof turnRequestCompletionProofSchema>;

export function normalizedFinalActionIds(message: Pick<PersistedConversationMessage, 'pendingActionId' | 'pendingActionIds'>): string[] {
  const plural = message.pendingActionIds === undefined ? undefined : actionIdsSchema.parse(message.pendingActionIds);
  const singular = message.pendingActionId === undefined ? undefined : identifier.parse(message.pendingActionId);
  invariant(plural === undefined || singular === undefined || plural.includes(singular),
    'TURN_COMPLETION_INVALID', 'The assistant action references disagree', 409);
  return [...new Set([...(plural ?? []), ...(singular === undefined ? [] : [singular])])].sort();
}

const finalContentSchema = persistedConversationMessageSchema.pick({
  text: true, analysis: true, evidence: true, sources: true, receiptId: true,
}).extend({ text: persistedConversationMessageSchema.shape.text.min(1)
  .refine(value => value.trim().length > 0, 'Final text cannot be blank') }).strict();

/** Must be identical to the reservation writer: optional fields normalize to null, references sort once. */
export function finalAssistantContentDigest(content: AssistantAnchorContent, actionIds: readonly string[] = []): string {
  const parsed = finalContentSchema.parse({ text: content.text, analysis: content.analysis,
    evidence: content.evidence, sources: content.sources, receiptId: content.receiptId });
  const refs = actionIdsSchema.parse([...actionIds]).sort();
  return digest({ text: parsed.text, analysis: parsed.analysis ?? null, evidence: parsed.evidence ?? null,
    sources: parsed.sources ?? null, receiptId: parsed.receiptId ?? null, pendingActionIds: refs });
}

/** The caller supplies an already-active transaction; this helper creates no transaction or authority. */
export interface TurnCompletionReader {
  get<T>(table: 'tool_executions' | 'conversation_messages' | 'pending_actions', id: string): Promise<T | undefined>;
}
export type CompletedTurnRead =
  | { readonly kind: 'completed'; readonly record: TurnCompletionRecord;
      readonly request: TurnRequestCompletionProof | null; readonly user: PersistedConversationMessage | null;
      readonly assistant: PersistedConversationMessage }
  | { readonly kind: 'unavailable'; readonly reason: 'completion_missing' | 'completion_invalid' | 'turn_incomplete' |
      'request_unverified' | 'user_unverified' | 'assistant_unverified' | 'references_unverified' };

function sameTuple(row: TurnCompletionTuple, tuple: TurnCompletionTuple): boolean {
  return row.actorId === tuple.actorId && row.sessionId === tuple.sessionId &&
    row.conversationId === tuple.conversationId && row.turnId === tuple.turnId &&
    row.mode === tuple.mode && row.modeRevision === tuple.modeRevision;
}
function exactMessage(message: PersistedConversationMessage, tuple: TurnCompletionTuple, role: 'user' | 'assistant'): boolean {
  return message.role === role && message.actorId === tuple.actorId && message.sessionId === tuple.sessionId &&
    message.conversationId === tuple.conversationId && message.turnId === tuple.turnId &&
    message.mode === tuple.mode && message.modeRevision === tuple.modeRevision;
}
function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return digest([...left].sort()) === digest([...right].sort());
}

/** Prime request-local caches without changing any completed-turn validation/redaction. */
export async function prefetchCompletedTurns(reader: Reader, tuples: readonly TurnCompletionTuple[]): Promise<void> {
  const batches = (table: 'tool_executions' | 'conversation_messages', ids: readonly string[]) => listByIds<unknown>(reader, table, ids);
  if (!tuples.length) return;
  const completions = await batches('tool_executions', tuples.map(tuple => turnCompletionId(tuple)));
  const records = completions.flatMap(row => { const parsed = turnCompletionRecordSchema.safeParse(row); return parsed.success ? [parsed.data] : []; });
  await Promise.all([
    batches('tool_executions', records.flatMap(row => row.requestLedgerId ? [row.requestLedgerId] : [])),
    batches('conversation_messages', records.flatMap(row => [...(row.assistantMessageId ? [row.assistantMessageId] : []), ...(row.origin === 'chat' ? [row.turnId] : [])])),
  ]);
}

/** Internal recovery may read provisional anchors separately; public callers use only this completed proof. */
export async function readCompletedTurn(reader: TurnCompletionReader, input: TurnCompletionTuple,
  requestedActionId?: string): Promise<CompletedTurnRead> {
  const tuple = turnCompletionTupleSchema.parse(input);
  const requestedId = requestedActionId === undefined ? undefined : identifier.parse(requestedActionId);
  const raw = await reader.get('tool_executions', turnCompletionId({ actorId: tuple.actorId,
    sessionId: tuple.sessionId, conversationId: tuple.conversationId, turnId: tuple.turnId }));
  if (raw === undefined) return { kind: 'unavailable', reason: 'completion_missing' };
  const parsed = turnCompletionRecordSchema.safeParse(raw);
  if (!parsed.success || !sameTuple(parsed.data, tuple)) return { kind: 'unavailable', reason: 'completion_invalid' };
  const record = parsed.data;
  if (record.status !== 'completed') return { kind: 'unavailable', reason: 'turn_incomplete' };
  if (record.origin === 'chat' && record.requestLedgerId === null) return { kind: 'unavailable', reason: 'request_unverified' };
  // The strict completed-record refinement establishes these fields at runtime.
  if (record.assistantMessageId === undefined || record.finalContentDigest === undefined || record.finalActionIds === undefined) {
    return { kind: 'unavailable', reason: 'completion_invalid' };
  }
  let request: TurnRequestCompletionProof | null = null;
  if (record.requestLedgerId !== null) {
    const original = turnRequestCompletionProofSchema.safeParse(await reader.get('tool_executions', record.requestLedgerId));
    if (!original.success || original.data.id !== record.requestLedgerId || !sameTuple(original.data, tuple) ||
      original.data.status !== 'completed' || original.data.finalContentDigest !== record.finalContentDigest ||
      original.data.finalActionIds === undefined || !sameIds(original.data.finalActionIds, record.finalActionIds)) {
      return { kind: 'unavailable', reason: 'request_unverified' };
    }
    request = original.data;
  }
  let user: PersistedConversationMessage | null = null;
  if (record.origin === 'chat') {
    const original = persistedConversationMessageSchema.safeParse(await reader.get('conversation_messages', tuple.turnId));
    if (!original.success || original.data.id !== tuple.turnId || !exactMessage(original.data, tuple, 'user')) {
      return { kind: 'unavailable', reason: 'user_unverified' };
    }
    user = original.data;
    if (request) {
      // A newly allocated conversation was absent from the original request; an existing one used its exact ID.
      const matchesIntent = [null, tuple.conversationId].some(conversationId => request.intentHash === digest({
        actorId: tuple.actorId, sessionId: tuple.sessionId, conversationId, message: original.data.text,
        ...(request.actionContractVersion === 2 ? { actionContractVersion: 2 } : {}),
        ...(request.clarification ? { clarification: request.clarification } : {}),
      }));
      if (!matchesIntent) return { kind: 'unavailable', reason: 'user_unverified' };
    }
  }
  const final = persistedConversationMessageSchema.safeParse(await reader.get('conversation_messages', record.assistantMessageId));
  if (!final.success || final.data.id !== record.assistantMessageId || !exactMessage(final.data, tuple, 'assistant')) {
    return { kind: 'unavailable', reason: 'assistant_unverified' };
  }
  try {
    const refs = normalizedFinalActionIds(final.data);
    if (!sameIds(refs, record.finalActionIds) || finalAssistantContentDigest(final.data, refs) !== record.finalContentDigest ||
      (requestedId !== undefined && !refs.includes(requestedId))) {
      return { kind: 'unavailable', reason: 'references_unverified' };
    }
  } catch {
    return { kind: 'unavailable', reason: 'references_unverified' };
  }
  return { kind: 'completed', record, request, user, assistant: final.data };
}

export type CompletionGatedAction = TurnCompletionTuple & { readonly id: string };

/** Re-read identity inside the claim transaction. Payload/scope/hash authorization stays with the action engine. */
export async function assertCompletedActionTurn(reader: TurnCompletionReader, input: CompletionGatedAction):
Promise<Extract<CompletedTurnRead, { kind: 'completed' }>> {
  const actionId = identifier.parse(input.id);
  const tuple = turnCompletionTupleSchema.parse({ actorId: input.actorId, sessionId: input.sessionId,
    conversationId: input.conversationId, turnId: input.turnId, mode: input.mode, modeRevision: input.modeRevision });
  const raw = await reader.get('pending_actions', actionId);
  invariant(typeof raw === 'object' && raw !== null, 'TURN_NOT_COMPLETED', 'The action has no verified completed turn', 409);
  const identity = turnCompletionTupleSchema.extend({ id: identifier }).safeParse({
    id: Reflect.get(raw, 'id'), actorId: Reflect.get(raw, 'actorId'), sessionId: Reflect.get(raw, 'sessionId'),
    conversationId: Reflect.get(raw, 'conversationId'), turnId: Reflect.get(raw, 'turnId'),
    mode: Reflect.get(raw, 'mode'), modeRevision: Reflect.get(raw, 'modeRevision'),
  });
  invariant(identity.success && identity.data.id === actionId && sameTuple(identity.data, tuple),
    'TURN_NOT_COMPLETED', 'The action has no verified completed turn', 409);
  const result = await readCompletedTurn(reader, tuple, actionId);
  invariant(result.kind === 'completed', 'TURN_NOT_COMPLETED', 'The action has no verified completed turn', 409);
  return result;
}
