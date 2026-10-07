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
import type { Actor, Store } from '@/lib/contracts';
import type { SessionRow } from '@/lib/core/auth';
import { POST } from '@/app/api/chat/recovery/route';

const store = { name: 'chat-recovery-route-test-store' } as unknown as Store;
const actor = { id: 'route-test-actor', sessionId: 'route-test-session', mode: 'live_ai', modeRevision: 1 } as Actor;
const session = { id: 'route-test-session', csrfToken: 'route-test-csrf' } as SessionRow;
const requestKey = 'recovery-request-key-123456';
const completedResponse = {
  conversationId: 'conversation-recovered',
  turnId: 'turn-recovered',
  assistantMessageId: 'assistant-recovered',
  mode: 'live_ai',
  message: 'Recovered canonical answer.',
  contractVersion: 2,
  replayed: true,
} as const;

function validRecoveryBody() {
  return {
    contractVersion: 2,
    actionContractVersion: 1,
    requestKey,
    message: 'Resume the original request.',
    conversationId: 'conversation-original',
  };
}

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/chat/recovery', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
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

describe('POST /api/chat/recovery', () => {
  it('calls only read-only recoverTurn with the original key and returns no-store JSON', async () => {
    dependencies.recoverTurn.mockResolvedValue({ status: 'completed', response: completedResponse });
    const body = validRecoveryBody();

    const response = await POST(makeRequest(body));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ status: 'completed', response: completedResponse });
    expect(dependencies.serviceConstructor).toHaveBeenCalledTimes(1);
    expect(dependencies.serviceConstructor).toHaveBeenCalledWith(store);
    expect(dependencies.recoverTurn).toHaveBeenCalledTimes(1);
    expect(dependencies.recoverTurn).toHaveBeenCalledWith(actor, {
      contractVersion: 2,
      actionContractVersion: 1,
      requestKey,
      message: body.message,
      conversationId: body.conversationId,
    });
    expect(dependencies.turn).not.toHaveBeenCalled();
  });

  it('keeps an absent prior key unavailable and never starts a new turn', async () => {
    dependencies.recoverTurn.mockResolvedValue({ status: 'unavailable' });

    const response = await POST(makeRequest(validRecoveryBody()));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ status: 'unavailable' });
    expect(dependencies.recoverTurn).toHaveBeenCalledTimes(1);
    expect(dependencies.recoverTurn.mock.calls[0]?.[1].requestKey).toBe(requestKey);
    expect(dependencies.turn).not.toHaveBeenCalled();
  });

  it('rejects an action-contract V2 body before recovery or turn invocation', async () => {
    const response = await POST(makeRequest({ ...validRecoveryBody(), actionContractVersion: 2 }));

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(dependencies.serviceConstructor).not.toHaveBeenCalled();
    expect(dependencies.recoverTurn).not.toHaveBeenCalled();
    expect(dependencies.turn).not.toHaveBeenCalled();
  });
});
