import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rateLimit, sameOrigin, trustedClientIp } from '../lib/server/session';
import { createWorkspaceFixture } from './helpers/workspace';

describe('server request boundary helpers', () => {
  it('uses exact HTTP authority for origin checks despite NextURL loopback normalization', () => {
    const request = (origin: string) => new NextRequest('http://127.0.0.1:41000/api/session', {
      headers: { host: '127.0.0.1:41000', origin },
    });
    expect(() => sameOrigin(request('http://127.0.0.1:41000'))).not.toThrow();
    expect(() => sameOrigin(request('http://localhost:41000'))).toThrow();
    expect(() => sameOrigin(request('http://127.0.0.1:41001'))).toThrow();
    expect(() => sameOrigin(request('https://attacker.invalid'))).toThrow();
  });
  let fixture!: Awaited<ReturnType<typeof createWorkspaceFixture>>;

  beforeEach(async () => {
    fixture = await createWorkspaceFixture();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fixture.dispose();
  });

  it.each([Number.NaN, 0])('fails closed for malformed rate limits such as %s', async (limit) => {
    await expect(rateLimit(fixture.store, 'malformed-limit', limit))
      .rejects.toMatchObject({ code: 'CONFIGURATION', status: 503 });
    expect(await fixture.store.list('rate_limits')).toHaveLength(0);
  });

  it('prunes expired rate-limit buckets before writing the current bucket', async () => {
    const currentBucket = Math.floor(Date.now() / 300_000);
    const expiredId = 'expired-review-bucket';
    await fixture.store.transaction(async (tx) => {
      await tx.put('rate_limits', { id: expiredId, count: 5, bucket: currentBucket - 3 });
    });

    await rateLimit(fixture.store, 'session:review', 10);

    expect(await fixture.store.get('rate_limits', expiredId)).toBeUndefined();
    expect(await fixture.store.list('rate_limits')).toEqual([
      expect.objectContaining({ id: expect.any(String), bucket: currentBucket }),
    ]);
  });

  it('ignores caller-supplied forwarded IPs outside Vercel so they cannot evade the login limit', async () => {
    vi.stubEnv('VERCEL', '0');
    const first = new NextRequest('http://localhost/api/session', {
      headers: { 'x-forwarded-for': '198.51.100.11' },
    });
    const second = new NextRequest('http://localhost/api/session', {
      headers: { 'x-forwarded-for': '203.0.113.99' },
    });

    expect(trustedClientIp(first)).toBe('local-or-untrusted-proxy');
    expect(trustedClientIp(second)).toBe(trustedClientIp(first));
    await rateLimit(fixture.store, 'login:' + trustedClientIp(first), 1);
    await expect(rateLimit(fixture.store, 'login:' + trustedClientIp(second), 1))
      .rejects.toMatchObject({ code: 'RATE_LIMIT', status: 429 });
  });
});
