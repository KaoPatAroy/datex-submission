import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => ({
  getStore: vi.fn(),
  actorSession: vi.fn(),
  login: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/storage', () => ({ getStore: dependencies.getStore }));
vi.mock('@/lib/server/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/session')>();
  return {
    ...actual,
    actorSession: dependencies.actorSession,
    login: dependencies.login,
  };
});

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/session/route';
import type { Store } from '@/lib/contracts';
import type { SessionRow } from '@/lib/core/auth';
import { createWorkspaceFixture } from './helpers/workspace';

describe('session login request budget', () => {
  let fixture: Awaited<ReturnType<typeof createWorkspaceFixture>>;
  let initialLimit: string | undefined;

  beforeEach(async () => {
    initialLimit = process.env.DEMO_LOGIN_REQUEST_LIMIT;
    delete process.env.DEMO_LOGIN_REQUEST_LIMIT;
    fixture = await createWorkspaceFixture();
    dependencies.getStore.mockResolvedValue(fixture.store as Store);
    dependencies.actorSession.mockResolvedValue({
      actor: { id: 'executive' },
      session: { csrfToken: 'test-csrf-token' } as SessionRow,
    });
    dependencies.login.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    if (initialLimit === undefined) delete process.env.DEMO_LOGIN_REQUEST_LIMIT;
    else process.env.DEMO_LOGIN_REQUEST_LIMIT = initialLimit;
    await fixture.dispose();
  });

  it('keeps the default at 20 login attempts per five-minute bucket', async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect((await POST(makeRequest())).status).toBe(200);
    }

    const limited = await POST(makeRequest());
    expect(limited.status).toBe(429);
    expect(await fixture.store.list('rate_limits')).toEqual([
      expect.objectContaining({ count: 20 }),
    ]);
  });

  it('rejects a malformed configured budget before recording a login attempt', async () => {
    process.env.DEMO_LOGIN_REQUEST_LIMIT = 'twenty';

    const response = await POST(makeRequest());

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'CONFIGURATION' } });
    expect(await fixture.store.list('rate_limits')).toHaveLength(0);
    expect(dependencies.login).not.toHaveBeenCalled();
  });
});

function makeRequest(): NextRequest {
  const origin = 'http://127.0.0.1:41000';
  return new NextRequest(`${origin}/api/session`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      host: '127.0.0.1:41000',
      origin,
    },
    body: JSON.stringify({ profileId: 'executive', accessCode: 'test-access-code' }),
  });
}
