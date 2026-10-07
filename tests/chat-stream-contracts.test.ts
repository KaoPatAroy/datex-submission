import { describe, expect, it } from 'vitest';
import { pendingActionSchema } from '../lib/packs/shared';
import {
  CHAT_STREAM_VERSION,
  MAX_CHAT_STREAM_EVENT_BYTES,
  MAX_CHAT_STREAM_TEXT_BYTES,
  advanceChatStreamSequence,
  assertChatStreamFinished,
  canonicalChatStreamResponseSchema,
  chatStreamErrorCodeSchema,
  chatStreamEventSchema,
  chatStreamRequestSchema,
  chatStreamStatusCodeSchema,
  decodeChatStreamFrame,
  encodeChatStreamEvent,
  initialChatStreamSequenceState,
  legacyChatStreamRequestSchema,
  legacyTurnResponseSchema,
  workflowChatStreamRequestSchema,
  type ChatStreamEvent,
} from '../lib/chat-stream-contracts';

const CONVERSATION_ID = 'stream-contract-conversation';
const TURN_ID = 'stream-contract-turn';
const ASSISTANT_MESSAGE_ID = 'stream-contract-assistant';
const REQUEST_KEY = 'stream-contract-request-001';
const LEGACY_ACTION_ID = 'stream-contract-legacy-action';
const LEGACY_RECEIPT_ID = 'stream-contract-legacy-receipt';
const CREATED_AT = '2026-10-04T04:00:00.000Z';
const utf8Length = (value: string): number => new TextEncoder().encode(value).byteLength;

function legacyResponse(message = 'V1 completed response') {
  return {
    conversationId: CONVERSATION_ID,
    turnId: TURN_ID,
    assistantMessageId: ASSISTANT_MESSAGE_ID,
    message,
    mode: 'live_ai' as const,
  };
}

function workflowResponse(overrides: Partial<{
  conversationId: string;
  turnId: string;
  assistantMessageId: string;
  mode: 'live_ai' | 'scripted_demo';
  replayed: boolean;
  message: string;
}> = {}) {
  return {
    conversationId: CONVERSATION_ID,
    turnId: TURN_ID,
    assistantMessageId: ASSISTANT_MESSAGE_ID,
    actionContractVersion: 2 as const,
    contractVersion: 2 as const,
    replayed: false,
    mode: 'live_ai' as const,
    message: 'V2 completed response',
    pendingActionIds: [],
    preparations: [],
    ...overrides,
  };
}

function legacyAction() {
  return pendingActionSchema.parse({
    id: LEGACY_ACTION_ID,
    actorId: 'stream-contract-legacy-actor',
    sessionId: 'stream-contract-legacy-session',
    conversationId: CONVERSATION_ID,
    turnId: TURN_ID,
    mode: 'live_ai',
    modeRevision: 0,
    payload: { kind: 'demo_update', scenario: 'baseline' },
    payloadHash: 'stream-contract-payload-hash',
    evidenceVersion: null,
    packs: [],
    createdAt: CREATED_AT,
    expiresAt: '2026-10-04T04:10:00.000Z',
    status: 'pending',
    preview: 'Review this demo update.',
  });
}

function legacyReceipt(actionId: string) {
  return {
    id: LEGACY_RECEIPT_ID,
    actionId,
    actorId: 'stream-contract-legacy-actor',
    kind: 'demo_update' as const,
    status: 'failed' as const,
    results: [{ targetId: 'stream-contract-target', id: null, status: 'failed' as const, detail: 'The update failed.' }],
    createdAt: CREATED_AT,
    verifiedAt: null,
  };
}

function startedEvent(sequence = 1) {
  return chatStreamEventSchema.parse({
    streamVersion: CHAT_STREAM_VERSION,
    sequence,
    type: 'turn.started',
    requestKey: REQUEST_KEY,
    conversationId: CONVERSATION_ID,
    turnId: TURN_ID,
    assistantMessageId: ASSISTANT_MESSAGE_ID,
    mode: 'live_ai',
    replayed: false,
  });
}

function statusEvent(sequence: number, code: 'validating' | 'reading' | 'analyzing' | 'preparing' | 'saving' = 'reading') {
  return chatStreamEventSchema.parse({
    streamVersion: CHAT_STREAM_VERSION,
    sequence,
    type: 'status',
    code,
  });
}

function textDeltaEvent(sequence: number, text: string) {
  return chatStreamEventSchema.parse({
    streamVersion: CHAT_STREAM_VERSION,
    sequence,
    type: 'text.delta',
    text,
  });
}

function completedEvent(sequence: number, response: unknown = workflowResponse()): ChatStreamEvent {
  return chatStreamEventSchema.parse({
    streamVersion: CHAT_STREAM_VERSION,
    sequence,
    type: 'turn.completed',
    response,
  });
}

function failedEvent(sequence: number): ChatStreamEvent {
  return chatStreamEventSchema.parse({
    streamVersion: CHAT_STREAM_VERSION,
    sequence,
    type: 'turn.failed',
    code: 'provider_unavailable',
    outcome: 'failed',
    recovery: 'check_original_request',
  });
}

describe('chat stream wire contracts', () => {
  it('accepts strict V1 and V2 stream requests and canonical completion responses', () => {
    expect(CHAT_STREAM_VERSION).toBe(1);
    const legacyRequest = {
      streamVersion: 1,
      contractVersion: 2,
      requestKey: REQUEST_KEY,
      message: 'Review this policy.',
      conversationId: CONVERSATION_ID,
      catalogEntryId: 'retail.sales-analysis',
    };
    expect(legacyChatStreamRequestSchema.parse(legacyRequest)).toEqual(legacyRequest);
    expect(legacyChatStreamRequestSchema.parse({ ...legacyRequest, actionContractVersion: 1 })).toMatchObject({
      streamVersion: 1,
      actionContractVersion: 1,
    });

    const v2Request = {
      ...legacyRequest,
      actionContractVersion: 2,
      demoShowcaseId: 'executive-overview',
    };
    expect(workflowChatStreamRequestSchema.parse(v2Request)).toEqual(v2Request);
    expect(chatStreamRequestSchema.parse(legacyRequest)).toEqual(legacyRequest);
    expect(chatStreamRequestSchema.parse(v2Request)).toEqual(v2Request);
    expect(chatStreamRequestSchema.safeParse({ ...v2Request, streamVersion: 2 }).success).toBe(false);
    expect(legacyChatStreamRequestSchema.safeParse({ ...legacyRequest, actionContractVersion: 2 }).success).toBe(false);
    expect(workflowChatStreamRequestSchema.safeParse({ ...v2Request, sessionId: 'private-session' }).success).toBe(false);
    expect(legacyChatStreamRequestSchema.safeParse({ ...legacyRequest, catalogEntryId: '../retail' }).success).toBe(false);

    const v1Response = legacyResponse();
    const v2Response = workflowResponse();
    expect(legacyTurnResponseSchema.parse(v1Response)).toEqual(v1Response);
    expect(canonicalChatStreamResponseSchema.parse(v1Response)).toEqual(v1Response);
    expect(canonicalChatStreamResponseSchema.parse(v2Response)).toEqual(v2Response);
    expect(canonicalChatStreamResponseSchema.safeParse({ ...v1Response, reasoning: 'private chain of thought' }).success).toBe(false);
    expect(canonicalChatStreamResponseSchema.safeParse({ ...v2Response, tool_calls: [{ name: 'internal_tool' }] }).success).toBe(false);
  });

  it('preserves V1 revision and supersession metadata in canonical responses', () => {
    const replacement = { ...legacyAction(), predecessorActionId: 'proposal-A',
      revisionDiff: ['Changed title', 'Kept 2 views'] };
    const revised = { ...legacyResponse(), pendingAction: replacement, pendingActions: [replacement] };
    expect(legacyTurnResponseSchema.parse(revised)).toEqual(revised);
    expect(canonicalChatStreamResponseSchema.parse(revised)).toEqual(revised);
    const predecessor = { ...legacyAction(), status: 'stale', staleReason: 'superseded',
      supersededByActionId: 'proposal-B' };
    const superseded = { ...legacyResponse(), pendingAction: predecessor, pendingActions: [predecessor] };
    expect(canonicalChatStreamResponseSchema.parse(superseded)).toEqual(superseded);
  });

  it.each([
    { predecessorActionId: 'unsafe/id' },
    { supersededByActionId: '' },
    { staleReason: 'unknown_reason' },
    { revisionDiff: [] },
    { revisionDiff: [' '] },
    { revisionDiff: ['x'.repeat(601)] },
    { revisionDiff: Array.from({ length: 33 }, () => 'Change') },
    { revisionDiff: [123] },
    { unexpectedRevisionField: 'private' },
  ])('rejects malformed or unknown V1 revision metadata: %j', metadata => {
    const action = { ...legacyAction(), ...metadata };
    expect(legacyTurnResponseSchema.safeParse({ ...legacyResponse(), pendingAction: action }).success).toBe(false);
    expect(canonicalChatStreamResponseSchema.safeParse({ ...legacyResponse(), pendingActions: [action] }).success).toBe(false);
  });

  it('accepts exact duplicated V1 action and receipt references in singular and plural fields', () => {
    const action = legacyAction();
    const receipt = legacyReceipt(action.id);
    const response = {
      ...legacyResponse(),
      pendingAction: action,
      pendingActions: [structuredClone(action)],
      receipt,
      receipts: [structuredClone(receipt)],
    };

    expect(legacyTurnResponseSchema.parse(response)).toEqual(response);
    expect(canonicalChatStreamResponseSchema.parse(response)).toEqual(response);
  });

  it('rejects a duplicate V1 action ID with a different payload', () => {
    const action = legacyAction();
    const changedAction = {
      ...action,
      payload: { kind: 'demo_update' as const, scenario: 'stock_recovered' as const },
    };
    const response = {
      ...legacyResponse(),
      pendingAction: action,
      pendingActions: [changedAction],
    };

    expect(legacyTurnResponseSchema.safeParse(response).success).toBe(false);
  });

  it('rejects a duplicate V1 action ID with a different status', () => {
    const action = legacyAction();
    const changedAction = { ...action, status: 'stale' as const };
    const response = {
      ...legacyResponse(),
      pendingAction: action,
      pendingActions: [changedAction],
    };

    expect(legacyTurnResponseSchema.safeParse(response).success).toBe(false);
  });

  it('rejects a duplicate V1 receipt ID with different target results', () => {
    const action = legacyAction();
    const receipt = legacyReceipt(action.id);
    const changedReceipt = {
      ...receipt,
      results: [{ ...receipt.results[0], detail: 'A contradictory result for the same receipt.' }],
    };
    const response = {
      ...legacyResponse(),
      receipt,
      receipts: [changedReceipt],
    };

    expect(legacyTurnResponseSchema.safeParse(response).success).toBe(false);
  });

  it('allows only declared progress and error codes and rejects raw private event fields', () => {
    for (const code of ['validating', 'reading', 'analyzing', 'preparing', 'saving'] as const) {
      expect(chatStreamStatusCodeSchema.safeParse(code).success).toBe(true);
      expect(chatStreamEventSchema.safeParse({
        streamVersion: CHAT_STREAM_VERSION,
        sequence: 1,
        type: 'status',
        code,
      }).success).toBe(true);
    }
    expect(chatStreamStatusCodeSchema.safeParse('debugging').success).toBe(false);

    for (const code of [
      'cancelled', 'in_progress', 'provider_unavailable', 'deadline_exceeded', 'invalid_response',
      'persistence_failed', 'outcome_unknown', 'unauthenticated', 'forbidden', 'request_failed',
    ] as const) {
      expect(chatStreamErrorCodeSchema.safeParse(code).success).toBe(true);
    }
    expect(chatStreamErrorCodeSchema.safeParse('provider_raw_error').success).toBe(false);

    expect(chatStreamEventSchema.safeParse({ ...startedEvent(), reasoning: 'private chain of thought' }).success).toBe(false);
    expect(chatStreamEventSchema.safeParse({ ...textDeltaEvent(1, 'Hello'), tool_calls: [{ name: 'internal_tool' }] }).success).toBe(false);
    expect(chatStreamEventSchema.safeParse({ ...failedEvent(1), apiKey: 'not-for-the-client' }).success).toBe(false);
  });

  it('enforces 6,000-byte text limits and the 2 MB complete-frame limit', () => {
    const asciiAtLimit = 'x'.repeat(MAX_CHAT_STREAM_TEXT_BYTES);
    const asciiOverLimit = 'x'.repeat(MAX_CHAT_STREAM_TEXT_BYTES + 1);
    expect(utf8Length(asciiAtLimit)).toBe(MAX_CHAT_STREAM_TEXT_BYTES);
    expect(canonicalChatStreamResponseSchema.safeParse(legacyResponse(asciiAtLimit)).success).toBe(true);
    expect(canonicalChatStreamResponseSchema.safeParse(legacyResponse(asciiOverLimit)).success).toBe(false);
    expect(chatStreamEventSchema.safeParse({
      streamVersion: CHAT_STREAM_VERSION,
      sequence: 1,
      type: 'text.delta',
      text: asciiAtLimit,
    }).success).toBe(true);
    expect(chatStreamEventSchema.safeParse({
      streamVersion: CHAT_STREAM_VERSION,
      sequence: 1,
      type: 'text.delta',
      text: asciiOverLimit,
    }).success).toBe(false);

    const thaiAtLimit = 'ก'.repeat(MAX_CHAT_STREAM_TEXT_BYTES / 3);
    const thaiOverLimit = 'ก'.repeat(MAX_CHAT_STREAM_TEXT_BYTES / 3 + 1);
    expect(utf8Length(thaiAtLimit)).toBe(MAX_CHAT_STREAM_TEXT_BYTES);
    expect(canonicalChatStreamResponseSchema.safeParse(workflowResponse({ message: thaiAtLimit })).success).toBe(true);
    expect(canonicalChatStreamResponseSchema.safeParse(workflowResponse({ message: thaiOverLimit })).success).toBe(false);
    expect(chatStreamEventSchema.safeParse({
      streamVersion: CHAT_STREAM_VERSION,
      sequence: 1,
      type: 'text.delta',
      text: thaiAtLimit,
    }).success).toBe(true);
    expect(chatStreamEventSchema.safeParse({
      streamVersion: CHAT_STREAM_VERSION,
      sequence: 1,
      type: 'text.delta',
      text: thaiOverLimit,
    }).success).toBe(false);

    const frameAtLimit = ':' + 'x'.repeat(MAX_CHAT_STREAM_EVENT_BYTES - 3) + '\n\n';
    const frameOverLimit = ':' + 'x'.repeat(MAX_CHAT_STREAM_EVENT_BYTES - 2) + '\n\n';
    expect(utf8Length(frameAtLimit)).toBe(MAX_CHAT_STREAM_EVENT_BYTES);
    expect(decodeChatStreamFrame(frameAtLimit)).toBeNull();
    expect(utf8Length(frameOverLimit)).toBe(MAX_CHAT_STREAM_EVENT_BYTES + 1);
    expect(() => decodeChatStreamFrame(frameOverLimit)).toThrow('Stream event exceeds the byte limit');
  });

  it('enforces sequence 1, contiguous events, matching turn references, and one terminal event', () => {
    const initial = initialChatStreamSequenceState();
    expect(initial).toEqual({ nextSequence: 1, started: null, terminal: false, textBytes: 0 });
    expect(() => advanceChatStreamSequence(initial, startedEvent(2))).toThrow('Invalid stream event sequence');
    expect(() => advanceChatStreamSequence(initial, statusEvent(1))).toThrow('A stream must start exactly once');

    let state = advanceChatStreamSequence(initial, startedEvent());
    expect(state.nextSequence).toBe(2);
    expect(() => advanceChatStreamSequence(state, statusEvent(3))).toThrow('Invalid stream event sequence');
    expect(() => advanceChatStreamSequence(state, startedEvent(2))).toThrow('A stream must start exactly once');

    const thaiDelta = 'สวัสดี';
    state = advanceChatStreamSequence(state, statusEvent(2, 'reading'));
    state = advanceChatStreamSequence(state, textDeltaEvent(3, thaiDelta));
    expect(state.textBytes).toBe(utf8Length(thaiDelta));
    state = advanceChatStreamSequence(state, completedEvent(4));
    expect(state).toMatchObject({ nextSequence: 5, terminal: true });
    expect(() => assertChatStreamFinished(state)).not.toThrow();
    expect(() => advanceChatStreamSequence(state, failedEvent(5))).toThrow('Invalid stream event sequence');

    const started = advanceChatStreamSequence(initialChatStreamSequenceState(), startedEvent());
    expect(() => advanceChatStreamSequence(started, completedEvent(2, workflowResponse({
      assistantMessageId: 'another-assistant-message',
    })))).toThrow('Completion does not match the admitted turn');

    const failed = advanceChatStreamSequence(started, failedEvent(2));
    expect(failed.terminal).toBe(true);
    expect(() => assertChatStreamFinished(failed)).not.toThrow();
    expect(() => assertChatStreamFinished(initialChatStreamSequenceState())).toThrow('The stream ended without a terminal event');
    expect(() => assertChatStreamFinished(started)).toThrow('The stream ended without a terminal event');
  });

  it('encodes and decodes complete SSE frames with CRLF, multiline data, and Thai text', () => {
    const delta = textDeltaEvent(1, 'สวัสดีจากร้าน');
    const frame = encodeChatStreamEvent(delta);
    expect(frame).toBe(`event: text.delta\ndata: ${JSON.stringify(delta)}\n\n`);
    expect(decodeChatStreamFrame(frame)).toEqual(delta);
    expect(decodeChatStreamFrame(frame.replace(/\n/g, '\r\n'))).toEqual(delta);

    const status = statusEvent(2, 'preparing');
    const statusJson = JSON.stringify(status);
    const comma = statusJson.indexOf(',');
    const multilineFrame = `event: status\r\ndata: ${statusJson.slice(0, comma + 1)}\r\ndata: ${statusJson.slice(comma + 1)}\r\n\r\n`;
    expect(decodeChatStreamFrame(multilineFrame)).toEqual(status);
    expect(decodeChatStreamFrame(': keep-alive\r\n\r\n')).toBeNull();

    expect(() => decodeChatStreamFrame('event: status\ndata: {"streamVersion":1}\n')).toThrow('Incomplete SSE frame');
    expect(() => decodeChatStreamFrame(`event: status\ndata: ${JSON.stringify(delta)}\n\n`)).toThrow('SSE event name does not match its data');
    expect(() => decodeChatStreamFrame('id: untrusted\nevent: status\ndata: {}\n\n')).toThrow('Unsupported SSE field');
  });
});
