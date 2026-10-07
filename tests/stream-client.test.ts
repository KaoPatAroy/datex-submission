import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_CHAT_STREAM_EVENT_BYTES,
  chatStreamEventSchema,
  encodeChatStreamEvent,
  type ChatStreamEvent,
} from '../lib/chat-stream-contracts';
import {
  consumeChatStream,
  recoverChatStream,
  requestChatStream,
} from '../components/biztania/stream-client';

const REQUEST_KEY = 'stream-client-request-001';
const CONVERSATION_ID = 'stream-client-conversation';
const TURN_ID = 'stream-client-turn';
const ASSISTANT_MESSAGE_ID = 'stream-client-assistant';

function startedEvent(overrides: { requestKey?: string; sequence?: number } = {}): ChatStreamEvent {
  return chatStreamEventSchema.parse({
    streamVersion: 1,
    sequence: overrides.sequence ?? 1,
    type: 'turn.started',
    requestKey: overrides.requestKey ?? REQUEST_KEY,
    conversationId: CONVERSATION_ID,
    turnId: TURN_ID,
    assistantMessageId: ASSISTANT_MESSAGE_ID,
    mode: 'live_ai',
    replayed: false,
  });
}

function statusEvent(sequence: number): ChatStreamEvent {
  return chatStreamEventSchema.parse({
    streamVersion: 1,
    sequence,
    type: 'status',
    code: 'analyzing',
  });
}

function textDeltaEvent(sequence: number, text: string): ChatStreamEvent {
  return chatStreamEventSchema.parse({
    streamVersion: 1,
    sequence,
    type: 'text.delta',
    text,
  });
}

function completedEvent(sequence: number, overrides: Partial<{
  conversationId: string;
  turnId: string;
  assistantMessageId: string;
  mode: 'live_ai' | 'scripted_demo';
  replayed: boolean;
}> = {}): ChatStreamEvent {
  return chatStreamEventSchema.parse({
    streamVersion: 1,
    sequence,
    type: 'turn.completed',
    response: {
      conversationId: overrides.conversationId ?? CONVERSATION_ID,
      turnId: overrides.turnId ?? TURN_ID,
      assistantMessageId: overrides.assistantMessageId ?? ASSISTANT_MESSAGE_ID,
      message: 'คำตอบสุดท้าย',
      mode: overrides.mode ?? 'live_ai',
      replayed: overrides.replayed ?? false,
    },
  });
}

function failedEvent(sequence: number): ChatStreamEvent {
  return chatStreamEventSchema.parse({
    streamVersion: 1,
    sequence,
    type: 'turn.failed',
    code: 'provider_unavailable',
    outcome: 'failed',
    recovery: 'check_original_request',
  });
}

function frame(event: ChatStreamEvent, lineEnding = '\n'): string {
  return encodeChatStreamEvent(event).replaceAll('\n', lineEnding);
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function closedStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function openStream(chunks: Uint8Array[]): {
  body: ReadableStream<Uint8Array>;
  close: () => void;
} {
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      for (const chunk of chunks) controller.enqueue(chunk);
    },
  });
  return {
    body,
    close() {
      if (!closed) {
        closed = true;
        controllerRef?.close();
      }
    },
  };
}

function splitAt(value: Uint8Array, cuts: number[]): Uint8Array[] {
  const boundaries = [0, ...new Set(cuts)].sort((left, right) => left - right);
  const validBoundaries = boundaries.filter(boundary => boundary > 0 && boundary < value.length);
  const points = [0, ...validBoundaries, value.length];
  return points.slice(1).map((end, index) => value.slice(points[index], end));
}

function firstIndexOf(value: Uint8Array, needle: Uint8Array): number {
  outer: for (let index = 0; index <= value.length - needle.length; index++) {
    for (let offset = 0; offset < needle.length; offset++) {
      if (value[index + offset] !== needle[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out waiting for ' + label)), 1_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function legacyResponse() {
  return {
    conversationId: CONVERSATION_ID,
    turnId: TURN_ID,
    assistantMessageId: ASSISTANT_MESSAGE_ID,
    message: 'Legacy response',
    mode: 'live_ai' as const,
  };
}

function requestOptions(signal = new AbortController().signal) {
  return {
    message: 'Review this policy.',
    conversationId: CONVERSATION_ID,
    requestKey: REQUEST_KEY,
    csrfToken: 'csrf-test-token',
    signal,
    onEvent: vi.fn(),
  };
}

function recoveryOptions(conversationId: string | null = CONVERSATION_ID) {
  return {
    requestKey: REQUEST_KEY,
    message: 'Review this policy.',
    ...(conversationId === null ? {} : { conversationId }),
    csrfToken: 'csrf-test-token',
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('chat stream client', () => {
  it('decodes Thai split inside a UTF-8 code point across CRLF and SSE-frame boundaries', async () => {
    const observedDelta = deferred<void>();
    const published: ChatStreamEvent[] = [];
    const response = {
      conversationId: CONVERSATION_ID,
      turnId: TURN_ID,
      assistantMessageId: ASSISTANT_MESSAGE_ID,
      message: 'คำตอบสุดท้าย',
      mode: 'live_ai' as const,
      replayed: false,
    };
    const wire = [
      ': heartbeat\r\n\r\n\r\n\r\n',
      frame(startedEvent(), '\r\n'),
      frame(statusEvent(2), '\r\n'),
      frame(textDeltaEvent(3, 'สรุปภาษาไทย: ยืนยันข้อมูล'), '\r\n'),
      frame(completedEvent(4), '\r\n'),
    ].join('');
    const encoded = bytes(wire);
    const crlf = firstIndexOf(encoded, bytes('\r\n'));
    const thai = firstIndexOf(encoded, bytes('สรุปภาษาไทย'));
    expect(crlf).toBeGreaterThanOrEqual(0);
    expect(thai).toBeGreaterThanOrEqual(0);
    const thaiLead = thai;
    expect(encoded[thaiLead]).toBeGreaterThanOrEqual(0xe0);
    const stream = openStream(splitAt(encoded, [crlf + 1, thaiLead + 1]));
    let settled = false;

    const result = consumeChatStream(stream.body, REQUEST_KEY, event => {
      published.push(event);
      if (event.type === 'text.delta') observedDelta.resolve();
    });
    void result.then(() => { settled = true; }, () => { settled = true; });

    try {
      await within(observedDelta.promise, 'the Thai text delta');
      expect(published.map(event => event.type)).toEqual(['turn.started', 'status', 'text.delta']);
      expect(published[0]).toMatchObject({
        type: 'turn.started',
        requestKey: REQUEST_KEY,
        conversationId: CONVERSATION_ID,
        turnId: TURN_ID,
        assistantMessageId: ASSISTANT_MESSAGE_ID,
      });
      expect(published[2]).toMatchObject({ type: 'text.delta', text: 'สรุปภาษาไทย: ยืนยันข้อมูล' });
      expect(settled).toBe(false);
      expect(published.some(event => event.type === 'turn.completed')).toBe(false);

      stream.close();
      await expect(result).resolves.toEqual(response);
      expect(published.map(event => event.type)).toEqual([
        'turn.started',
        'status',
        'text.delta',
        'turn.completed',
      ]);
      expect(published[published.length - 1]).toMatchObject({
        type: 'turn.completed',
        response,
      });
    } finally {
      stream.close();
    }
  });

  it('ignores comment and empty frames without consuming sequence numbers', async () => {
    const published: ChatStreamEvent[] = [];
    const wire = [
      ': keepalive\n\n\n\n',
      frame(startedEvent()),
      frame(statusEvent(2)),
      frame(completedEvent(3)),
    ].join('');

    await expect(consumeChatStream(closedStream([bytes(wire)]), REQUEST_KEY, event => published.push(event)))
      .resolves.toMatchObject({ message: 'คำตอบสุดท้าย' });

    expect(published.map(event => event.type)).toEqual(['turn.started', 'status', 'turn.completed']);
    expect(published.map(event => event.sequence)).toEqual([1, 2, 3]);
  });

  it('rejects a started event whose request key does not exactly match the request', async () => {
    const published: ChatStreamEvent[] = [];
    const body = closedStream([bytes(frame(startedEvent({ requestKey: REQUEST_KEY + '-other' })))]);

    await expect(consumeChatStream(body, REQUEST_KEY, event => published.push(event)))
      .rejects.toMatchObject({ name: 'ChatStreamError', code: 'invalid_response', admitted: false });
    expect(published).toEqual([]);
  });

  it('rejects sequence gaps before publishing later events', async () => {
    const published: ChatStreamEvent[] = [];
    const wire = frame(startedEvent()) + frame(statusEvent(3));

    await expect(consumeChatStream(closedStream([bytes(wire)]), REQUEST_KEY, event => published.push(event)))
      .rejects.toMatchObject({ name: 'ChatStreamError', code: 'invalid_response', admitted: true });
    expect(published.map(event => event.type)).toEqual(['turn.started']);
  });

  it('rejects a completion that changes the admitted turn identity', async () => {
    const published: ChatStreamEvent[] = [];
    const wire = frame(startedEvent()) + frame(completedEvent(2, { turnId: 'another-turn' }));

    await expect(consumeChatStream(closedStream([bytes(wire)]), REQUEST_KEY, event => published.push(event)))
      .rejects.toMatchObject({ name: 'ChatStreamError', code: 'invalid_response', admitted: true });
    expect(published.some(event => event.type === 'turn.completed')).toBe(false);
  });

  it('rejects a stream that reaches EOF without a terminal event', async () => {
    const wire = frame(startedEvent()) + frame(statusEvent(2));

    await expect(consumeChatStream(closedStream([bytes(wire)]), REQUEST_KEY, vi.fn()))
      .rejects.toMatchObject({ name: 'ChatStreamError', code: 'invalid_response', admitted: true });
  });

  it('rejects a second terminal event instead of publishing the first completion', async () => {
    const published: ChatStreamEvent[] = [];
    const wire = frame(startedEvent()) + frame(completedEvent(2)) + frame(completedEvent(3));

    await expect(consumeChatStream(closedStream([bytes(wire)]), REQUEST_KEY, event => published.push(event)))
      .rejects.toMatchObject({ name: 'ChatStreamError', code: 'invalid_response', admitted: true });
    expect(published.map(event => event.type)).toEqual(['turn.started']);
  });

  it('rejects an incomplete event buffer after it exceeds the byte limit', async () => {
    const wire = 'event: text.delta\ndata: ' + 'x'.repeat(MAX_CHAT_STREAM_EVENT_BYTES + 1) + '\n';

    await expect(consumeChatStream(closedStream([bytes(wire)]), REQUEST_KEY, vi.fn()))
      .rejects.toMatchObject({ name: 'ChatStreamError', code: 'invalid_response', admitted: false });
  });

  it('cancels a stalled reader when its abort signal fires', async () => {
    const observedStart = deferred<void>();
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes(frame(startedEvent()) + frame(statusEvent(2))));
      },
      cancel: cancelled,
    });
    const abortController = new AbortController();
    const result = consumeChatStream(body, REQUEST_KEY, event => {
      if (event.type === 'turn.started') observedStart.resolve();
    }, abortController.signal);

    try {
      await within(observedStart.promise, 'turn.started before the stream stalls');
      abortController.abort();

      await expect(result).rejects.toMatchObject({
        name: 'ChatStreamError',
        code: 'cancelled',
        admitted: true,
      });
      expect(cancelled).toHaveBeenCalledTimes(1);
    } finally {
      abortController.abort();
      await result.catch(() => undefined);
    }
  });

  it.each([404, 405, 501])(
    'falls back only for pre-admission HTTP %s and preserves the exact request key',
    async status => {
      const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init });
        if (calls.length === 1) return new Response(null, {
          status,
          headers: { 'x-biztania-chat-stream': 'unavailable' },
        });
        return new Response(JSON.stringify(legacyResponse()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });
      vi.stubGlobal('fetch', fetchMock);

      await expect(requestChatStream(requestOptions())).resolves.toEqual(legacyResponse());

      expect(calls.map(call => call.input)).toEqual(['/api/chat/stream', '/api/chat']);
      const streamPayload = JSON.parse(String(calls[0].init?.body));
      const fallbackPayload = JSON.parse(String(calls[1].init?.body));
      expect(streamPayload).toMatchObject({
        streamVersion: 1,
        actionContractVersion: 1,
        contractVersion: 2,
        requestKey: REQUEST_KEY,
      });
      expect(fallbackPayload).toEqual({
        contractVersion: 2,
        requestKey: REQUEST_KEY,
        message: 'Review this policy.',
        conversationId: CONVERSATION_ID,
      });
      expect(fallbackPayload.requestKey).toBe(streamPayload.requestKey);
    },
  );

  it('preserves the catalog entry id in the structured stream and fallback payloads', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      if (calls.length === 1) return new Response(null, {
        status: 404,
        headers: { 'x-biztania-chat-stream': 'unavailable' },
      });
      return new Response(JSON.stringify(legacyResponse()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(requestChatStream({ ...requestOptions(), catalogEntryId: 'retail.sales-analysis' }))
      .resolves.toEqual(legacyResponse());

    const streamPayload = JSON.parse(String(calls[0].init?.body));
    const fallbackPayload = JSON.parse(String(calls[1].init?.body));
    expect(streamPayload).toMatchObject({ message: 'Review this policy.', catalogEntryId: 'retail.sales-analysis' });
    expect(fallbackPayload).toMatchObject({ message: 'Review this policy.', catalogEntryId: 'retail.sales-analysis' });
  });

  it.each([404, 405, 501])(
    'does not retry bare HTTP %s as a legacy request without the unavailable marker',
    async status => {
      const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init });
        return new Response(null, { status });
      });
      vi.stubGlobal('fetch', fetchMock);

      await expect(requestChatStream(requestOptions())).rejects.toMatchObject({
        name: 'ChatStreamError',
        status,
        admitted: false,
      });
      expect(calls.map(call => call.input)).toEqual(['/api/chat/stream']);
    },
  );

  it('requires the exact unavailable marker value before using legacy fallback', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return new Response(null, {
        status: 404,
        headers: { 'x-biztania-chat-stream': 'maybe-unavailable' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(requestChatStream(requestOptions())).rejects.toMatchObject({
      name: 'ChatStreamError',
      status: 404,
      admitted: false,
    });
    expect(calls.map(call => call.input)).toEqual(['/api/chat/stream']);
  });

  it('does not fall back after an admitted stream ends without its terminal event', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return new Response(frame(startedEvent()), {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(requestChatStream(requestOptions())).rejects.toMatchObject({
      name: 'ChatStreamError',
      code: 'invalid_response',
      admitted: true,
    });
    expect(calls.map(call => call.input)).toEqual(['/api/chat/stream']);
  });

  it('does not fall back when the stream request fails with an uncertain network error', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      throw new TypeError('connection reset after dispatch');
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(requestChatStream(requestOptions())).rejects.toMatchObject({
      name: 'ChatStreamError',
      code: 'request_failed',
      admitted: false,
    });
    expect(calls.map(call => call.input)).toEqual(['/api/chat/stream']);
  });

  it('does not fall back for stream HTTP errors outside the pre-admission allowlist', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return new Response(null, { status: 503 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(requestChatStream(requestOptions())).rejects.toMatchObject({
      name: 'ChatStreamError',
      status: 503,
      admitted: false,
    });
    expect(calls.map(call => call.input)).toEqual(['/api/chat/stream']);
  });

  it('posts the original recovery tuple and returns in-progress without starting another turn', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const recoveryResult = {
      status: 'in_progress',
      conversationId: CONVERSATION_ID,
      turnId: TURN_ID,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return new Response(JSON.stringify(recoveryResult), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(recoverChatStream(recoveryOptions())).resolves.toEqual(recoveryResult);

    expect(calls).toHaveLength(1);
    expect(calls[0].input).toBe('/api/chat/recovery');
    expect(calls[0].init).toMatchObject({ method: 'POST', credentials: 'include', cache: 'no-store' });
    expect(calls[0].init?.headers).toEqual({
      'Content-Type': 'application/json',
      'x-csrf-token': 'csrf-test-token',
    });
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      contractVersion: 2,
      actionContractVersion: 1,
      requestKey: REQUEST_KEY,
      message: 'Review this policy.',
      conversationId: CONVERSATION_ID,
    });
    expect(calls.some(call => call.input === '/api/chat' || call.input === '/api/chat/stream')).toBe(false);
  });

  it.each([
    {
      status: 'in_progress',
      body: { status: 'in_progress', conversationId: CONVERSATION_ID, turnId: TURN_ID },
      conversationId: CONVERSATION_ID,
    },
    {
      status: 'unavailable',
      body: { status: 'unavailable' },
      conversationId: null,
    },
  ])('returns $status on reload without a new stream or JSON turn POST', async ({ body, conversationId }) => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(recoverChatStream(recoveryOptions(conversationId))).resolves.toEqual(body);

    expect(calls.map(call => call.input)).toEqual(['/api/chat/recovery']);
    const payload = JSON.parse(String(calls[0].init?.body));
    expect(payload).toMatchObject({
      contractVersion: 2,
      actionContractVersion: 1,
      requestKey: REQUEST_KEY,
      message: 'Review this policy.',
    });
    expect(Object.hasOwn(payload, 'conversationId')).toBe(conversationId !== null);
    if (conversationId !== null) expect(payload.conversationId).toBe(conversationId);
  });

  it('returns failed recovery only as status and does not resend the failed turn', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const failedResult = { status: 'failed', conversationId: CONVERSATION_ID, turnId: TURN_ID };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return new Response(JSON.stringify(failedResult), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(recoverChatStream(recoveryOptions())).resolves.toEqual(failedResult);

    expect(calls.map(call => call.input)).toEqual(['/api/chat/recovery']);
  });

  it('does not resend after a failed terminal stream event', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return new Response(frame(startedEvent()) + frame(failedEvent(2)), {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const options = requestOptions();

    await expect(requestChatStream(options)).rejects.toMatchObject({
      name: 'ChatStreamError',
      code: 'provider_unavailable',
      admitted: true,
    });
    expect(calls.map(call => call.input)).toEqual(['/api/chat/stream']);
    expect(options.onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'turn.failed' }));
  });

  it('recovers a lost final response after reload with the exact original request key', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const completedResult = { status: 'completed', response: legacyResponse() };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      if (input === '/api/chat/stream') {
        return new Response(frame(startedEvent()), {
          status: 200,
          headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        });
      }
      return new Response(JSON.stringify(completedResult), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const original = {
      message: 'Review this policy.',
      requestKey: REQUEST_KEY,
      csrfToken: 'csrf-test-token',
      signal: new AbortController().signal,
      onEvent: vi.fn(),
    };

    await expect(requestChatStream(original)).rejects.toMatchObject({
      name: 'ChatStreamError',
      code: 'invalid_response',
      admitted: true,
    });
    await expect(recoverChatStream({
      requestKey: original.requestKey,
      message: original.message,
      csrfToken: original.csrfToken,
    })).resolves.toEqual(completedResult);

    expect(calls.map(call => call.input)).toEqual(['/api/chat/stream', '/api/chat/recovery']);
    const sent = JSON.parse(String(calls[0].init?.body));
    const recovered = JSON.parse(String(calls[1].init?.body));
    expect(sent.requestKey).toBe(recovered.requestKey);
    expect(sent.message).toBe(recovered.message);
    expect(Object.hasOwn(sent, 'conversationId')).toBe(false);
    expect(Object.hasOwn(recovered, 'conversationId')).toBe(false);
  });

  it('accepts completed recovery only with canonical response identifiers', async () => {
    const completedResult = { status: 'completed', response: legacyResponse() };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(completedResult), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(recoverChatStream(recoveryOptions())).resolves.toEqual(completedResult);
  });

  it.each(['conversationId', 'turnId', 'assistantMessageId'] as const)(
    'rejects a completed recovery with a malformed canonical %s',
    async field => {
      const forgedResponse = { ...legacyResponse(), [field]: 'invalid/id' };
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'completed', response: forgedResponse }), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(recoverChatStream(recoveryOptions())).rejects.toMatchObject({
        name: 'ChatStreamError',
        code: 'outcome_unknown',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects a forged completed response with fields outside the canonical schema', async () => {
    const forgedResponse = { ...legacyResponse(), privileged: true };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'completed', response: forgedResponse }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(recoverChatStream(recoveryOptions())).rejects.toMatchObject({
      name: 'ChatStreamError',
      code: 'outcome_unknown',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

