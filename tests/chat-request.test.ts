import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const dependencies = vi.hoisted(() => ({
  getStore: vi.fn(),
  actorSession: vi.fn(),
  checkCsrf: vi.fn(),
  rateLimit: vi.fn(),
  trustedClientIp: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/storage', () => ({ getStore: dependencies.getStore }));
vi.mock('@/lib/server/session', () => ({
  actorSession: dependencies.actorSession,
  checkCsrf: dependencies.checkCsrf,
  rateLimit: dependencies.rateLimit,
  trustedClientIp: dependencies.trustedClientIp,
}));

import type { NextRequest } from 'next/server';
import type { Actor, Store } from '@/lib/contracts';
import type { SessionRow } from '@/lib/core/auth';
import { DomainError } from '@/lib/core/errors';
import { failure } from '@/lib/server/http';
import {
  chatTurnRequestSchema,
  prepareChatRequest,
} from '@/lib/server/chat-request';

const store = { name: 'test-store' } as unknown as Store;
const actor = { id: 'test-actor' } as Actor;
const session = { id: 'test-session', csrfToken: 'test-token' } as SessionRow;
const events: string[] = [];

type TestRequestOptions = {
  rawBody?: string;
  chunks?: Uint8Array[];
  contentLength?: number;
  holdBodyOpen?: boolean;
  jsonError?: Error;
};

type TestRequest = NextRequest & {
  json: ReturnType<typeof vi.fn>;
  wasBodyCancelled: () => boolean;
  closeBody: () => void;
};

function makeRequest(body: unknown, options: TestRequestOptions = {}): TestRequest {
  const bytes = new TextEncoder().encode(options.rawBody ?? JSON.stringify(body));
  const chunks = options.chunks ?? [bytes];
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let cancelled = false;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const bodyStream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      for (const chunk of chunks) streamController.enqueue(chunk);
      if (options.holdBodyOpen) {
        closeTimer = setTimeout(() => {
          try { streamController.close(); } catch { /* The request body was already cancelled. */ }
        }, 250);
      } else streamController.close();
    },
    cancel() {
      cancelled = true;
      if (closeTimer) clearTimeout(closeTimer);
    },
  });
  const headers = new Headers();
  if (options.contentLength !== undefined) headers.set('content-length', String(options.contentLength));
  const json = vi.fn().mockImplementation(async () => {
    if (options.jsonError) throw options.jsonError;
    return body;
  });
  return {
    body: bodyStream,
    headers,
    json,
    wasBodyCancelled: () => cancelled,
    closeBody: () => {
      if (closeTimer) clearTimeout(closeTimer);
      try { controller?.close(); } catch { /* The request body was already cancelled. */ }
    },
  } as unknown as TestRequest;
}

function splitBytes(bytes: Uint8Array, sizes: number[]): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (const size of sizes) {
    if (offset >= bytes.length) break;
    chunks.push(bytes.slice(offset, offset + size));
    offset += size;
  }
  if (offset < bytes.length) chunks.push(bytes.slice(offset));
  return chunks;
}

async function expectInvalidInputResponse(request: TestRequest) {
  let error: unknown;
  try {
    await prepareChatRequest(request);
  } catch (caught) {
    error = caught;
  }

  expect(error).toBeInstanceOf(DomainError);
  if (!(error instanceof DomainError)) throw new Error('Expected a chat input DomainError');
  expect(error.code).toBe('INVALID_INPUT');
  expect(error.status).toBe(400);

  const response = failure(error);
  const existingInvalidInputResponse = failure(new z.ZodError([]));
  expect(response.status).toBe(existingInvalidInputResponse.status);
  expect(await response.json()).toEqual(await existingInvalidInputResponse.json());
}

function configureDependencies() {
  dependencies.getStore.mockImplementation(async () => {
    events.push('getStore');
    return store;
  });
  dependencies.actorSession.mockImplementation(async () => {
    events.push('actorSession');
    return { actor, session };
  });
  dependencies.checkCsrf.mockImplementation(() => {
    events.push('checkCsrf');
  });
  dependencies.rateLimit.mockImplementation(async (_store: Store, key: string) => {
    events.push(`rateLimit:${key}`);
  });
  dependencies.trustedClientIp.mockReturnValue('203.0.113.8');
}

beforeEach(() => {
  vi.clearAllMocks();
  events.length = 0;
  configureDependencies();
});

describe('chat request preparation', () => {
  it('keeps the turn body strict and couples V2 versioning to a valid request key', () => {
    const legacy = { message: 'Review this policy.' };
    const v2 = {
      message: 'Review this policy.',
      contractVersion: 2,
      requestKey: 'request-key-123456',
    };

    expect(chatTurnRequestSchema.parse(legacy)).toEqual(legacy);
    expect(chatTurnRequestSchema.parse(v2)).toEqual(v2);
    const catalogRequest = { ...v2, catalogEntryId: 'retail.sales-analysis' };
    expect(chatTurnRequestSchema.parse(catalogRequest)).toEqual(catalogRequest);
    expect(chatTurnRequestSchema.safeParse({ ...legacy, private: 'field' }).success).toBe(false);
    expect(chatTurnRequestSchema.safeParse({ message: '' }).success).toBe(false);
    expect(chatTurnRequestSchema.safeParse({ message: 'Valid message', contractVersion: 2 }).success).toBe(false);
    expect(chatTurnRequestSchema.safeParse({ ...legacy, requestKey: 'request-key-123456' }).success).toBe(false);
    expect(chatTurnRequestSchema.safeParse({ ...legacy, catalogEntryId: 'retail.sales-analysis' }).success).toBe(false);
    expect(chatTurnRequestSchema.safeParse({ ...catalogRequest, catalogEntryId: '../retail' }).success).toBe(false);
    expect(chatTurnRequestSchema.safeParse({
      ...v2,
      recoveryOfTurnId: 'recovery-turn',
    }).success).toBe(false);
  });

  it('checks session and IP limits before parsing the request body', async () => {
    const body = { message: 'Review this policy.' };
    const request = makeRequest(body);

    const prepared = await prepareChatRequest(request);

    expect(prepared).toEqual({ store, actor, body });
    expect(events).toEqual([
      'getStore',
      'actorSession',
      'checkCsrf',
      'rateLimit:session:test-session',
      'rateLimit:ip:203.0.113.8',
    ]);
    expect(request.json).not.toHaveBeenCalled();
    expect(dependencies.rateLimit.mock.calls).toEqual([
      [store, 'session:test-session', 20],
      [store, 'ip:203.0.113.8', 60],
    ]);
  });

  it('applies the shared preparation path to a route-specific strict body schema', async () => {
    const streamRequestSchema = z.object({
      message: z.string().min(1),
      streamVersion: z.literal(1),
    }).strict();
    const body = { message: 'Review this policy.', streamVersion: 1 };
    const request = makeRequest(body);

    const prepared = await prepareChatRequest(request, streamRequestSchema);

    expect(prepared.body).toEqual(body);
    expect(events).toEqual([
      'getStore',
      'actorSession',
      'checkCsrf',
      'rateLimit:session:test-session',
      'rateLimit:ip:203.0.113.8',
    ]);
    expect(request.json).not.toHaveBeenCalled();
  });

  it('stops before rate limiting and body parsing when CSRF validation fails', async () => {
    const csrfError = new Error('origin or CSRF token rejected');
    dependencies.checkCsrf.mockImplementation(() => {
      events.push('checkCsrf');
      throw csrfError;
    });
    const request = makeRequest({ message: 'Review this policy.' });

    await expect(prepareChatRequest(request)).rejects.toBe(csrfError);

    expect(events).toEqual(['getStore', 'actorSession', 'checkCsrf']);
    expect(dependencies.rateLimit).not.toHaveBeenCalled();
    expect(request.json).not.toHaveBeenCalled();
  });

  it('maps malformed JSON to the existing deterministic 400 invalid-input response', async () => {
    const request = makeRequest(undefined, {
      rawBody: '{"message":',
      jsonError: new SyntaxError('Unexpected end of JSON input'),
    });

    await expectInvalidInputResponse(request);

    expect(request.json).not.toHaveBeenCalled();
  });

  it('rejects invalid UTF-8 with the same fixed 400 invalid-input response', async () => {
    const encoder = new TextEncoder();
    const request = makeRequest({ message: '\uFFFD' }, {
      rawBody: '',
      chunks: [
        encoder.encode('{"message":"'),
        new Uint8Array([0xff]),
        encoder.encode('"}'),
      ],
    });

    await expectInvalidInputResponse(request);

    expect(request.json).not.toHaveBeenCalled();
  });

  it('rejects an oversized declared length before parsing and cancels the body', async () => {
    const request = makeRequest({ message: 'Valid message.' }, {
      contentLength: 64 * 1024 + 1,
      holdBodyOpen: true,
    });

    try {
      await expectInvalidInputResponse(request);
      expect(request.wasBodyCancelled()).toBe(true);
      expect(request.json).not.toHaveBeenCalled();
    } finally {
      request.closeBody();
    }
  });

  it('rejects chunked bodies over the combined UTF-8 byte limit and cancels the body', async () => {
    const body = { message: 'Valid message.' };
    const rawBody = JSON.stringify(body) + ' '.repeat(64 * 1024);
    const bytes = new TextEncoder().encode(rawBody);
    const request = makeRequest(body, {
      rawBody,
      chunks: splitBytes(bytes, [32_000, 32_000]),
      holdBodyOpen: true,
    });

    try {
      await expectInvalidInputResponse(request);
      expect(bytes.byteLength).toBeGreaterThan(64 * 1024);
      expect(request.wasBodyCancelled()).toBe(true);
      expect(request.json).not.toHaveBeenCalled();
    } finally {
      request.closeBody();
    }
  });

  it('accepts the maximum escaped request and preserves UTF-8 split across chunks', async () => {
    const maximumEscapedBody = {
      message: '\0'.repeat(8_000),
      conversationId: '\0'.repeat(100),
      recoveryOfTurnId: '\0'.repeat(100),
    };
    const maximumEscapedBytes = new TextEncoder().encode(JSON.stringify(maximumEscapedBody));
    expect(maximumEscapedBytes.byteLength).toBeLessThanOrEqual(64 * 1024);
    const maximumEscapedRequest = makeRequest(maximumEscapedBody, {
      rawBody: JSON.stringify(maximumEscapedBody),
      chunks: splitBytes(maximumEscapedBytes, [8_191, 16_383, 24_577]),
    });
    expect((await prepareChatRequest(maximumEscapedRequest)).body).toEqual(maximumEscapedBody);
    expect(maximumEscapedRequest.json).not.toHaveBeenCalled();

    const body = {
      message: '\0'.repeat(7_800) + 'ก😀'.repeat(66) + '\0\0',
      conversationId: '\0'.repeat(100),
      recoveryOfTurnId: '\0'.repeat(100),
    };
    expect(body.message.length).toBe(8_000);
    const rawBody = JSON.stringify(body);
    const bytes = new TextEncoder().encode(rawBody);
    expect(bytes.byteLength).toBeLessThanOrEqual(64 * 1024);
    const request = makeRequest(body, {
      rawBody,
      chunks: splitBytes(bytes, [1_024, 2_049, 4_093, 8_191]),
    });

    const prepared = await prepareChatRequest(request);

    expect(prepared.body).toEqual(body);
    expect(request.json).not.toHaveBeenCalled();
  });
});
