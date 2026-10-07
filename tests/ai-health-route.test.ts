import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const dependencies = vi.hoisted(() => ({ getStore: vi.fn(), actorSession: vi.fn() }));
vi.mock('@/lib/storage', () => ({ getStore: dependencies.getStore }));
vi.mock('@/lib/server/session', () => ({ actorSession: dependencies.actorSession }));
import { GET } from '../app/api/ai/health/route';
import { DomainError } from '../lib/core/errors';

describe('GET /api/ai/health', () => {
  beforeEach(() => {
    dependencies.getStore.mockResolvedValue({ adapter: 'sqlite' });
    dependencies.actorSession.mockResolvedValue({ actor: { id: 'fixture-actor' } });
    vi.stubEnv('NINEARM_API_KEY', 'private-fixture-health-key');
    vi.stubEnv('AI_PROVIDER', 'ninearm');
    vi.stubEnv('NINEARM_BASE_URL', 'https://private-provider.example.test/v1');
    vi.stubEnv('NINEARM_MODEL', 'private-fixture-model');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('requires an authenticated session and disables response caching', async () => {
    dependencies.actorSession.mockRejectedValue(new DomainError('UNAUTHENTICATED', 'กรุณาเข้าสู่ระบบ', 401));
    const response = await GET();
    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
  });

  it('returns only safe status, reason, timestamp with no configuration or credentials', async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(['checkedAt', 'reason', 'status']);
    expect(Number.isFinite(Date.parse(body.checkedAt))).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/private-|apiKey|baseURL|model|fixture-actor/);
    expect(dependencies.actorSession).toHaveBeenCalledOnce();
  });
});
