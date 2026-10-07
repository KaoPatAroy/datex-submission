import { afterEach, describe, expect, it, vi } from 'vitest';

/** G2 / P2-2: cursors are signed ONLY with the configured DEMO_SESSION_SECRET (same rule as sessions); no per-process random key. */
const items = Array.from({ length: 25 }, (_, i) => ({ k: `2026-10-01|${String(i).padStart(3, '0')}` }));
const SECRET = 'g2-pagination-test-secret-at-least-32-characters';
async function freshModule() { vi.resetModules(); return import('@/lib/pagination'); }
afterEach(() => vi.unstubAllEnvs());

describe('pagination cursor signing key', () => {
  it.each([['missing', ''], ['short', 'too-short-secret']])('fails closed with the session configuration error when the secret is %s', async (_label, value) => {
    vi.stubEnv('DEMO_SESSION_SECRET', value);
    const { paginate } = await freshModule();
    const error = (() => { try { paginate(items, i => i.k, { bind: 's' }, { limit: 10 }); } catch (caught) { return caught; } return null; })();
    expect(error).toMatchObject({ code: 'CONFIGURATION', status: 503, message: 'ยังไม่พร้อมให้เข้าสู่ระบบ กรุณาติดต่อผู้ดูแล' });
    // A single page needs no cursor, so it still answers.
    expect(paginate(items.slice(0, 5), i => i.k, { bind: 's' }, { limit: 10 }).items).toHaveLength(5);
  });

  it('a cursor minted by one instance continues on another instance with the same configured secret, and dies under another secret', async () => {
    vi.stubEnv('DEMO_SESSION_SECRET', SECRET);
    const cursor = (await freshModule()).paginate(items, i => i.k, { bind: 's' }, { limit: 10 }).nextCursor!;
    const other = await freshModule();
    expect(other.paginate(items, i => i.k, { cursor, bind: 's' }, { limit: 10 }).items).toHaveLength(10);
    vi.stubEnv('DEMO_SESSION_SECRET', `${SECRET}-rotated`);
    expect(() => other.paginate(items, i => i.k, { cursor, bind: 's' }, { limit: 10 })).toThrowError(expect.objectContaining({ code: 'INVALID_CURSOR' }));
  });
});
