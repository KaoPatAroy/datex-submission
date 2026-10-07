import { beforeEach, describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => ({
  getStore: vi.fn(),
  actorSession: vi.fn(),
  checkCsrf: vi.fn(),
  rateLimit: vi.fn(),
  trustedClientIp: vi.fn(),
  turn: vi.fn(),
  recoverTurn: vi.fn(),
  serviceConstructor: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/storage', () => ({ getStore: dependencies.getStore }));
vi.mock('@/lib/server/session', () => ({
  actorSession: dependencies.actorSession,
  checkCsrf: dependencies.checkCsrf,
  rateLimit: dependencies.rateLimit,
  trustedClientIp: dependencies.trustedClientIp,
}));
vi.mock('@/lib/core/service', () => ({ ConciergeService: dependencies.serviceConstructor }));

import { NextRequest } from 'next/server';
import { AIRuntimeError } from '@/lib/ai/errors';
import { DomainError } from '@/lib/core/errors';
import type { Actor, Store } from '@/lib/contracts';
import type { SessionRow } from '@/lib/core/auth';
import { decodeChatStreamFrame, type ChatStreamEvent } from '@/lib/chat-stream-contracts';
import { POST } from '@/app/api/chat/stream/route';

const store = { name: 'chat-stream-route-test-store' } as unknown as Store;
const actor = { id: 'route-test-actor', sessionId: 'route-test-session', mode: 'live_ai', modeRevision: 1 } as Actor;
const session = { id: 'route-test-session', csrfToken: 'route-test-csrf' } as SessionRow;
const requestKey = 'route-request-key-123456';
const started = {
  conversationId: 'conversation-1',
  turnId: 'turn-1',
  assistantMessageId: 'assistant-1',
  mode: 'live_ai',
  replayed: false,
} as const;
const durableResponse = {
  ...started,
  message: 'The canonical persisted answer.',
  contractVersion: 2,
} as const;

function validStreamBody() {
  return {
    streamVersion: 1,
    contractVersion: 2,
    requestKey,
    message: 'Review this policy.',
  };
}

function makeRequest(body: unknown, signal?: AbortSignal): NextRequest {
  return new NextRequest('http://localhost/api/chat/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function eventReader(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffer = '';

  return {
    async next(): Promise<ChatStreamEvent> {
      while (!buffer.includes('\n\n')) {
        const { value, done } = await reader.read();
        if (done) throw new Error('The SSE stream ended before its next event.');
        buffer += decoder.decode(value, { stream: true });
      }
      const boundary = buffer.indexOf('\n\n');
      const frame = buffer.slice(0, boundary + 2);
      buffer = buffer.slice(boundary + 2);
      const event = decodeChatStreamFrame(frame);
      if (!event) throw new Error('Expected a data-bearing SSE event.');
      return event;
    },
  };
}

function parseEvents(body: string): ChatStreamEvent[] {
  return body.split(/\n\n/).filter(frame => frame.trim().length > 0)
    .map(frame => decodeChatStreamFrame(`${frame}\n\n`))
    .filter((event): event is ChatStreamEvent => event !== null);
}

function configureRequestDependencies() {
  dependencies.getStore.mockResolvedValue(store);
  dependencies.actorSession.mockResolvedValue({ actor, session });
  dependencies.checkCsrf.mockReturnValue(undefined);
  dependencies.rateLimit.mockResolvedValue(undefined);
  dependencies.trustedClientIp.mockReturnValue('203.0.113.8');
  dependencies.serviceConstructor.mockImplementation(function () {
    return { turn: dependencies.turn, recoverTurn: dependencies.recoverTurn };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.turn.mockReset();
  dependencies.recoverTurn.mockReset();
  configureRequestDependencies();
});

describe('POST /api/chat/stream', () => {
  it.each([
    ['authentication', () => {
      dependencies.actorSession.mockRejectedValue(new DomainError('UNAUTHENTICATED', 'session rejected', 401));
      return validStreamBody();
    }, 401],
    ['CSRF', () => {
      dependencies.checkCsrf.mockImplementation(() => { throw new DomainError('CSRF', 'origin rejected', 403); });
      return validStreamBody();
    }, 403],
    ['rate limit', () => {
      dependencies.rateLimit.mockRejectedValue(new DomainError('RATE_LIMIT', 'request limit reached', 429));
      return validStreamBody();
    }, 429],
    ['body validation', () => ({ ...validStreamBody(), requestKey: 'short' }), 400],
  ])('returns a no-store JSON failure before SSE admission when %s fails', async (_label, setup, status) => {
    const body = setup();

    const response = await POST(makeRequest(body));

    expect(response.status).toBe(status);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).not.toContain('text/event-stream');
    expect(dependencies.serviceConstructor).not.toHaveBeenCalled();
    expect(dependencies.turn).not.toHaveBeenCalled();
  });

  it('rejects an action-contract V2 body before constructing or invoking the turn service', async () => {
    const response = await POST(makeRequest({ ...validStreamBody(), actionContractVersion: 2 }));

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(dependencies.serviceConstructor).not.toHaveBeenCalled();
    expect(dependencies.turn).not.toHaveBeenCalled();
  });

  it('admits before safe progress and deltas, then emits one canonical terminal after turn return', async () => {
    const releaseDurableResult = deferred<void>();
    let durableResultReturned = false;
    dependencies.turn.mockImplementation(async (_actor, _message, _conversationId, _recoveryOfTurnId, _identity, options) => {
      await options.onStarted(started);
      await options.onStatus('validating');
      await options.onStatus('tool.arguments.SECRET_FROM_PROVIDER');
      await options.onTextDelta('Provisional wording ');
      await options.onTextDelta('before the turn is durable.');
      await releaseDurableResult.promise;
      durableResultReturned = true;
      return durableResponse;
    });

    const response = await POST(makeRequest(validStreamBody()));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-cache, no-store, no-transform');
    expect(response.headers.get('x-accel-buffering')).toBe('no');

    const reader = eventReader(response.body!.getReader());
    const observed: ChatStreamEvent[] = [];
    observed.push(await reader.next());
    observed.push(await reader.next());
    observed.push(await reader.next());
    observed.push(await reader.next());
    const pendingTerminal = reader.next();
    expect(durableResultReturned).toBe(false);
    releaseDurableResult.resolve();
    observed.push(await pendingTerminal);

    expect(observed.map(event => event.type)).toEqual([
      'turn.started', 'status', 'text.delta', 'text.delta', 'turn.completed',
    ]);
    expect(observed.map(event => event.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(observed[0]).toMatchObject({ ...started, type: 'turn.started', requestKey });
    expect(observed[1]).toMatchObject({ type: 'status', code: 'validating' });
    expect(observed[2]).toMatchObject({ type: 'text.delta', text: 'Provisional wording ' });
    expect(observed[3]).toMatchObject({ type: 'text.delta', text: 'before the turn is durable.' });
    expect(observed[4]).toMatchObject({ type: 'turn.completed', response: durableResponse });
    expect(observed.filter(event => event.type === 'turn.completed' || event.type === 'turn.failed')).toHaveLength(1);
    expect(JSON.stringify(observed)).not.toContain('SECRET_FROM_PROVIDER');
    expect(durableResultReturned).toBe(true);
    expect(dependencies.turn).toHaveBeenCalledTimes(1);
    expect(dependencies.turn.mock.calls[0]?.[4]).toEqual({ contractVersion: 2, requestKey });
  });

  it.each([
    ['provider failure', () => new AIRuntimeError(
      'provider_unavailable', 'UPSTREAM_SECRET=private TOOL_ARGS={"target":"hidden"}', 502,
    ), 'provider_unavailable'],
    ['unknown transport result', () => Object.assign(
      new Error('TRANSPORT_SECRET=private TOOL_ARGS={"target":"hidden"}'),
      { code: 'TRANSPORT_OUTCOME_UNKNOWN' },
    ), 'outcome_unknown'],
  ])('emits one sanitized terminal for an admitted %s', async (_label, makeError, code) => {
    dependencies.turn.mockImplementation(async (_actor, _message, _conversationId, _recoveryOfTurnId, _identity, options) => {
      await options.onStarted(started);
      await options.onTextDelta('A safe partial.');
      throw makeError();
    });

    const response = await POST(makeRequest(validStreamBody()));
    const body = await response.text();
    const events = parseEvents(body);

    expect(events.map(event => event.type)).toEqual(['turn.started', 'text.delta', 'turn.failed']);
    expect(events.at(-1)).toMatchObject({
      type: 'turn.failed', code, outcome: 'unknown', recovery: 'check_original_request',
    });
    expect(events.filter(event => event.type === 'turn.completed' || event.type === 'turn.failed')).toHaveLength(1);
    expect(body).not.toContain('UPSTREAM_SECRET');
    expect(body).not.toContain('TRANSPORT_SECRET');
    expect(body).not.toContain('TOOL_ARGS');
  });

  it('aborts the service and releases a blocked write when an admitted reader cancels', async () => {
    const statusAttempted = deferred<void>();
    const statusReturned = deferred<void>();
    let statusDidReturn = false;
    let operationSignal: AbortSignal | undefined;
    dependencies.turn.mockImplementation(async (_actor, _message, _conversationId, _recoveryOfTurnId, _identity, options) => {
      operationSignal = options.signal;
      await options.onStarted(started);
      const blockedWrite = options.onStatus('validating');
      statusAttempted.resolve();
      await blockedWrite;
      statusDidReturn = true;
      statusReturned.resolve();
      return durableResponse;
    });

    const response = await POST(makeRequest(validStreamBody()));
    const reader = response.body!.getReader();
    await statusAttempted.promise;
    expect(statusDidReturn).toBe(false);
    await reader.cancel();
    await statusReturned.promise;

    expect(statusDidReturn).toBe(true);
    expect(operationSignal?.aborted).toBe(true);
    expect(dependencies.turn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a refused read tool', () => new AIRuntimeError('tool_execution_failed', 'x', undefined, 400), 'request_failed', 'failed'],
    ['a 4xx domain rule', () => new DomainError('EVIDENCE_SCOPE_CONFLICT', 'x', 400), 'request_failed', 'failed'],
    ['a permission denial', () => new DomainError('FORBIDDEN', 'x', 403), 'forbidden', 'failed'],
    ['a provider outage', () => new AIRuntimeError('provider_unavailable', 'x'), 'provider_unavailable', 'unknown'],
  ])('classifies %s without leaking text and logs metadata only', async (_label, makeError, code, outcome) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    dependencies.turn.mockImplementation(async (_actor, _message, _conversationId, _recoveryOfTurnId, _identity, options) => {
      await options.onStarted(started);
      throw makeError();
    });
    const response = await POST(makeRequest(validStreamBody()));
    const events = parseEvents(await response.text());
    expect(events.at(-1)).toMatchObject({ type: 'turn.failed', code, outcome });
    expect(JSON.stringify(log.mock.calls)).not.toContain('Review this policy');
    log.mockRestore();
  });

  it('does not open SSE when the request is already aborted before admission', async () => {
    const controller = new AbortController();
    controller.abort(new Error('client stopped before admission'));

    const response = await POST(makeRequest(validStreamBody(), controller.signal));

    expect(response.status).not.toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(dependencies.turn).not.toHaveBeenCalled();
  });
});
