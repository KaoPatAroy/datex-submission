import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * Lane A acceptance: getStore never falls back to SQLite on its own. SQLite is selected only
 * by the explicit USE_LOCAL_DEMO_DATA=true flag; an unconfigured or unreachable Supabase fails loudly.
 */
describe('getStore has no silent SQLite fallback', () => {
  let directory = '';
  const saved = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    directory = mkdtempSync(join(tmpdir(), 'biztania-no-fallback-'));
    for (const key of ['USE_LOCAL_DEMO_DATA', 'SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'VERCEL', 'WORKFLOW_V2_ENABLED']) delete process.env[key];
    process.env.DB_PATH = join(directory, 'must-not-exist.sqlite');
  });

  afterEach(() => {
    process.env = { ...saved };
    rmSync(directory, { recursive: true, force: true });
  });

  it('fails with CONFIGURATION when Supabase is not configured and the SQLite flag is absent', async () => {
    const { getStore } = await import('../lib/storage');
    await expect(getStore()).rejects.toMatchObject({ code: 'CONFIGURATION' });
    expect(existsSync(process.env.DB_PATH!)).toBe(false);
  });

  it('fails loudly (no SQLite file) when a configured PostgreSQL endpoint is unreachable', async () => {
    process.env.SUPABASE_URL = 'http://127.0.0.1:9';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'example-local-test-key';
    const { getStore } = await import('../lib/storage');
    await expect(getStore()).rejects.toThrow();
    expect(existsSync(process.env.DB_PATH!)).toBe(false);
  }, 30_000);

  it('uses SQLite only when USE_LOCAL_DEMO_DATA=true is set explicitly', async () => {
    process.env.USE_LOCAL_DEMO_DATA = 'true';
    const { getStore } = await import('../lib/storage');
    const store = await getStore();
    expect(store.adapter).toBe('sqlite');
    store.close?.();
  }, 30_000);

  it('refuses the SQLite flag on Vercel', async () => {
    process.env.USE_LOCAL_DEMO_DATA = 'true';
    process.env.VERCEL = '1';
    const { getStore } = await import('../lib/storage');
    await expect(getStore()).rejects.toMatchObject({ code: 'CONFIGURATION' });
  });
});
