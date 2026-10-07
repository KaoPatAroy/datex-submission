import { z } from 'zod';
import type { ReceiptView, TurnArtifact, TurnResponse } from './contracts';
import { pendingActionRevisionDiffSchema, pendingActionStaleReasonSchema } from './contracts';
import { actionPayloadSchema } from './core/action-schema';
import { analysisSchema, evidenceSchema, pendingActionSchema, sourceRefSchema } from './packs/shared';
import { directoryIdentitySchema, MAX_WORKFLOW_TARGETS } from './workflows/contracts';
import { catalogEntryIdPattern, showcaseIdPattern } from './demo/ids';
import { workflowChatRequestV2Schema, workflowChatResponseV2Schema } from './workflows/api-contracts';

/** Transport version is independent of request-key and business-action versions. */
export const CHAT_STREAM_VERSION = 1 as const;
export const MAX_CHAT_STREAM_TEXT_BYTES = 6_000;
export const MAX_CHAT_STREAM_EVENT_BYTES = 2_000_000;

const identifier = directoryIdentitySchema.shape.id;
const mode = z.enum(['live_ai', 'scripted_demo']);
const instant = z.string().datetime({ offset: true });
const bytes = (value: string): number => new TextEncoder().encode(value).byteLength;
const finalText = z.string().min(1).max(MAX_CHAT_STREAM_TEXT_BYTES)
  .refine(value => value.trim().length > 0, 'Final text cannot be blank')
  .refine(value => bytes(value) <= MAX_CHAT_STREAM_TEXT_BYTES, 'Final text exceeds the byte limit');

/** Structured clarification pick (chip click): choice id + the turn that offered it. Both or neither. */
export const clarificationSelectionFields = {
  clarificationChoiceId: z.string().min(1).max(160).optional(),
  clarifiedTurnId: z.string().min(1).max(100).optional(),
};
export const clarificationFieldsPaired = (body: { clarificationChoiceId?: string; clarifiedTurnId?: string }) =>
  (body.clarificationChoiceId === undefined) === (body.clarifiedTurnId === undefined);
/** UI-selected owned resources (exact ids). The server verifies each before the planner sees it; never parsed from text. */
export const turnTargetsFields = {
  targets: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('artifact'), id: z.string().min(1).max(200), revision: z.number().int().positive().max(100).optional() }).strict(),
    z.object({ kind: z.literal('dashboard'), id: z.string().min(1).max(200) }).strict(),
    z.object({ kind: z.literal('monitor'), id: z.string().min(1).max(200) }).strict(),
  ])).max(3).optional(),
};
const clarificationPairMessage = 'clarificationChoiceId and clarifiedTurnId must be sent together';

export const legacyChatStreamRequestSchema = z.object({
  streamVersion: z.literal(CHAT_STREAM_VERSION),
  actionContractVersion: z.literal(1).optional(),
  contractVersion: z.literal(2),
  requestKey: workflowChatRequestV2Schema.shape.requestKey,
  message: workflowChatRequestV2Schema.shape.message,
  conversationId: identifier.optional(),
  demoShowcaseId: z.string().regex(showcaseIdPattern).optional(),
  catalogEntryId: z.string().regex(catalogEntryIdPattern).optional(),
  ...clarificationSelectionFields,
  ...turnTargetsFields,
}).strict().refine(clarificationFieldsPaired, clarificationPairMessage);
export const workflowChatStreamRequestSchema = workflowChatRequestV2Schema.extend({
  streamVersion: z.literal(CHAT_STREAM_VERSION),
  demoShowcaseId: z.string().regex(showcaseIdPattern).optional(),
  catalogEntryId: z.string().regex(catalogEntryIdPattern).optional(),
  ...clarificationSelectionFields,
  ...turnTargetsFields,
}).strict().refine(clarificationFieldsPaired, clarificationPairMessage);
export const chatStreamRequestSchema = z.union([legacyChatStreamRequestSchema, workflowChatStreamRequestSchema]);
export type ChatStreamRequest = z.infer<typeof chatStreamRequestSchema>;

const receiptStatus = z.enum(['verified_success', 'pending', 'failed', 'denied']);
const legacyReceiptResultSchema = z.object({
  targetId: identifier,
  id: identifier.nullable(),
  status: receiptStatus,
  detail: z.string().max(1_000),
}).strict();
const legacyFullReceiptSchema = z.object({
  visibility: z.literal('full').optional(),
  readbackRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  id: identifier,
  actionId: identifier,
  actorId: identifier,
  kind: z.enum(['dashboard_create', 'dashboard_share', 'ticket_create', 'badge_revoke', 'demo_update']),
  status: receiptStatus,
  results: z.array(legacyReceiptResultSchema).max(MAX_WORKFLOW_TARGETS),
  createdAt: instant,
  verifiedAt: instant.nullable(),
  dashboardId: identifier.optional(),
}).strict();
const legacyRestrictedReceiptSchema = z.object({
  visibility: z.literal('restricted'),
  id: identifier,
  actionId: identifier,
  status: receiptStatus,
  results: z.tuple([]),
  createdAt: instant,
  verifiedAt: z.null(),
  detail: z.string().min(1).max(1_000),
}).strict();
export const legacyReceiptViewSchema: z.ZodType<ReceiptView> = z.union([
  legacyFullReceiptSchema, legacyRestrictedReceiptSchema,
]);

// Shared tool-result validation has narrower V1 payload limits than the canonical
// service input. Reuse its metadata and the real service payload schema together.
const legacyStreamActionSchema = pendingActionSchema.extend({
  id: identifier,
  actorId: identifier,
  sessionId: identifier,
  conversationId: identifier,
  turnId: identifier,
  predecessorActionId: identifier.optional(),
  supersededByActionId: identifier.optional(),
  staleReason: pendingActionStaleReasonSchema.optional(),
  revisionDiff: pendingActionRevisionDiffSchema.optional(),
  payload: actionPayloadSchema,
  preview: z.string().min(1).max(MAX_CHAT_STREAM_EVENT_BYTES),
}).strict();

function sameValidatedValue(left: object, right: object): boolean {
  const canonical = (value: object) => JSON.stringify(value, (_key, nested: unknown) => {
    if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
      return Object.fromEntries(Object.entries(nested).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    }
    return nested;
  });
  return canonical(left) === canonical(right);
}

export const legacyTurnResponseSchema: z.ZodType<TurnResponse> = z.object({
  conversationId: identifier,
  turnId: identifier,
  assistantMessageId: identifier,
  message: finalText,
  mode,
  contractVersion: z.literal(2).optional(),
  replayed: z.boolean().optional(),
  analysis: analysisSchema.optional(),
  evidence: evidenceSchema.optional(),
  sources: z.array(sourceRefSchema).max(500).optional(),
  pendingAction: legacyStreamActionSchema.optional(),
  pendingActions: z.array(legacyStreamActionSchema).max(MAX_WORKFLOW_TARGETS).optional(),
  receipt: legacyReceiptViewSchema.optional(),
  receipts: z.array(legacyReceiptViewSchema).max(MAX_WORKFLOW_TARGETS).optional(),
  clarification: z.boolean().optional(),
  choices: z.array(z.object({ id: z.string().min(1).max(160), label: z.string().min(1).max(160) }).strict()).max(12).optional(),
  // Artifact renderer specs are produced server-side from verified claims; the transport only bounds their size.
  artifacts: z.array(z.object({ id: identifier, revision: z.number().int().min(1), kind: z.enum(['table', 'ranking', 'chart', 'executive_brief', 'csv_export']),
    title: z.string().min(1).max(200), spec: z.custom<TurnArtifact['spec']>(value => value !== null && typeof value === 'object') }).strict()).max(5).optional(),
  hint: z.literal('switch_to_demo').optional(),
  receiptCards: z.array(z.object({ kind: z.literal('dashboard_organize'), title: z.string().min(1).max(200), headline: z.string().min(1).max(600),
    fields: z.array(z.object({ label: z.string().min(1).max(80), value: z.string().min(1).max(200) }).strict()).max(6), verifiedAt: z.string().min(1).max(40) }).strict()).max(4).optional(),
}).strict().superRefine((response, context) => {
  const actions = response.pendingActions ?? (response.pendingAction ? [response.pendingAction] : []);
  const ids = new Set<string>();
  for (const [index, action] of actions.entries()) {
    if (ids.has(action.id) || action.conversationId !== response.conversationId ||
      action.turnId !== response.turnId || action.mode !== response.mode) {
      context.addIssue({ code: 'custom', path: ['pendingActions', index], message: 'Action references do not match the turn' });
    }
    ids.add(action.id);
  }
  if (response.pendingActions && response.pendingAction) {
    const selected = response.pendingActions.find(action => action.id === response.pendingAction?.id);
    if (!selected) {
      context.addIssue({ code: 'custom', path: ['pendingAction'], message: 'The selected action is absent from the action list' });
    } else if (!sameValidatedValue(response.pendingAction, selected)) {
      context.addIssue({ code: 'custom', path: ['pendingAction'], message: 'The selected action contradicts its action list entry' });
    }
  }
  if (response.pendingAction && (response.pendingAction.conversationId !== response.conversationId ||
    response.pendingAction.turnId !== response.turnId || response.pendingAction.mode !== response.mode)) {
    context.addIssue({ code: 'custom', path: ['pendingAction'], message: 'The selected action belongs to another turn' });
  }
  const receipts = response.receipts ?? (response.receipt ? [response.receipt] : []);
  const receiptIds = new Set<string>();
  for (const [index, receipt] of receipts.entries()) {
    if (receiptIds.has(receipt.id)) {
      context.addIssue({ code: 'custom', path: ['receipts', index], message: 'Receipt references repeat' });
    }
    receiptIds.add(receipt.id);
  }
  if (response.receipts && response.receipt) {
    const selected = response.receipts.find(receipt => receipt.id === response.receipt?.id);
    if (!selected) {
      context.addIssue({ code: 'custom', path: ['receipt'], message: 'The selected receipt is absent from the receipt list' });
    } else if (!sameValidatedValue(response.receipt, selected)) {
      context.addIssue({ code: 'custom', path: ['receipt'], message: 'The selected receipt contradicts its receipt list entry' });
    }
  }
});

export const canonicalChatStreamResponseSchema = z.union([
  legacyTurnResponseSchema,
  workflowChatResponseV2Schema.refine(response => finalText.safeParse(response.message).success,
    'Final text is blank or exceeds the byte limit'),
]).refine(response => bytes(JSON.stringify(response)) <= MAX_CHAT_STREAM_EVENT_BYTES, 'Final response exceeds the byte limit');
export type CanonicalChatStreamResponse = z.infer<typeof canonicalChatStreamResponseSchema>;

export const chatStreamStatusCodeSchema = z.enum(['validating', 'reading', 'analyzing', 'preparing', 'saving']);
export type ChatStreamStatusCode = z.infer<typeof chatStreamStatusCodeSchema>;
export const chatStreamErrorCodeSchema = z.enum([
  'cancelled', 'in_progress', 'provider_unavailable', 'deadline_exceeded',
  'invalid_response', 'persistence_failed', 'outcome_unknown', 'unauthenticated',
  'forbidden', 'request_failed',
]);
export type ChatStreamErrorCode = z.infer<typeof chatStreamErrorCodeSchema>;

const envelope = {
  streamVersion: z.literal(CHAT_STREAM_VERSION),
  sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
};
export const chatStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ ...envelope, type: z.literal('turn.started'),
    requestKey: workflowChatRequestV2Schema.shape.requestKey,
    conversationId: identifier, turnId: identifier, assistantMessageId: identifier,
    mode, replayed: z.boolean(),
  }).strict(),
  z.object({ ...envelope, type: z.literal('status'), code: chatStreamStatusCodeSchema }).strict(),
  z.object({ ...envelope, type: z.literal('text.delta'),
    text: z.string().min(1).max(MAX_CHAT_STREAM_TEXT_BYTES)
      .refine(value => bytes(value) <= MAX_CHAT_STREAM_TEXT_BYTES, 'Delta exceeds the byte limit'),
  }).strict(),
  z.object({ ...envelope, type: z.literal('turn.completed'), response: canonicalChatStreamResponseSchema }).strict(),
  z.object({ ...envelope, type: z.literal('turn.failed'), code: chatStreamErrorCodeSchema,
    outcome: z.enum(['failed', 'cancelled', 'in_progress', 'unknown']),
    recovery: z.literal('check_original_request'),
  }).strict(),
]).refine(event => bytes(JSON.stringify(event)) <= MAX_CHAT_STREAM_EVENT_BYTES, 'Stream event exceeds the byte limit');
export type ChatStreamEvent = z.infer<typeof chatStreamEventSchema>;
export type ChatStreamStartedEvent = Extract<ChatStreamEvent, { type: 'turn.started' }>;

export interface ChatStreamSequenceState {
  readonly nextSequence: number;
  readonly started: ChatStreamStartedEvent | null;
  readonly terminal: boolean;
  readonly textBytes: number;
}
export function initialChatStreamSequenceState(): ChatStreamSequenceState {
  return { nextSequence: 1, started: null, terminal: false, textBytes: 0 };
}

/** Parsing proves wire shape/order only; persistence and authorization remain server-owned. */
export function advanceChatStreamSequence(state: ChatStreamSequenceState, input: ChatStreamEvent): ChatStreamSequenceState {
  const event = chatStreamEventSchema.parse(input);
  if (state.terminal || event.sequence !== state.nextSequence) throw new Error('Invalid stream event sequence');
  if ((!state.started && event.type !== 'turn.started') || (state.started && event.type === 'turn.started')) {
    throw new Error('A stream must start exactly once');
  }
  if (event.type === 'turn.completed' && state.started) {
    const response = event.response;
    if (response.conversationId !== state.started.conversationId || response.turnId !== state.started.turnId ||
      response.assistantMessageId !== state.started.assistantMessageId || response.mode !== state.started.mode ||
      (response.replayed !== undefined && response.replayed !== state.started.replayed)) {
      throw new Error('Completion does not match the admitted turn');
    }
  }
  const textBytes = state.textBytes + (event.type === 'text.delta' ? bytes(event.text) : 0);
  if (textBytes > MAX_CHAT_STREAM_TEXT_BYTES) throw new Error('Stream text exceeds the byte limit');
  return {
    nextSequence: event.sequence + 1,
    started: event.type === 'turn.started' ? event : state.started,
    terminal: event.type === 'turn.completed' || event.type === 'turn.failed',
    textBytes,
  };
}
export function assertChatStreamFinished(state: ChatStreamSequenceState): void {
  if (!state.started || !state.terminal) throw new Error('The stream ended without a terminal event');
}

export function encodeChatStreamEvent(input: ChatStreamEvent): string {
  const event = chatStreamEventSchema.parse(input);
  const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  if (bytes(frame) > MAX_CHAT_STREAM_EVENT_BYTES) throw new Error('Stream event exceeds the byte limit');
  return frame;
}

/** Decode one complete SSE frame. The browser owns UTF-8 decoding and chunk buffering. */
export function decodeChatStreamFrame(frame: string): ChatStreamEvent | null {
  if (bytes(frame) > MAX_CHAT_STREAM_EVENT_BYTES) throw new Error('Stream event exceeds the byte limit');
  const normalized = frame.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!normalized.endsWith('\n\n')) throw new Error('Incomplete SSE frame');
  const lines = normalized.split('\n');
  let eventName: string | undefined;
  const data: string[] = [];
  let ended = false;
  for (const line of lines) {
    if (line === '') { ended = true; continue; }
    if (ended) throw new Error('Multiple or incomplete SSE frames');
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const raw = colon === -1 ? '' : line.slice(colon + 1);
    const value = raw.startsWith(' ') ? raw.slice(1) : raw;
    if (field === 'event' && eventName === undefined) eventName = value;
    else if (field === 'data') data.push(value);
    else throw new Error('Unsupported SSE field');
  }
  if (!ended) throw new Error('Incomplete SSE frame');
  if (eventName === undefined && data.length === 0) return null;
  if (eventName === undefined || data.length === 0) throw new Error('Missing SSE event or data');
  let decoded: unknown;
  try { decoded = JSON.parse(data.join('\n')); }
  catch { throw new Error('Invalid SSE JSON data'); }
  const event = chatStreamEventSchema.parse(decoded);
  if (event.type !== eventName) throw new Error('SSE event name does not match its data');
  return event;
}
