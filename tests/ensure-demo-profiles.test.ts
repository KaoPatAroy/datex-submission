import { describe, expect, it, vi } from 'vitest';
import type { Profile } from '../lib/contracts';
import { createSeedData } from '../lib/seed/generate';
import { demoProfileRepairEnabled, ensureMissingDemoProfiles } from '../lib/seed/ensure-demo-profiles';
import { createWorkflowSqliteFixture } from './helpers/workflow-storage';
import { itSqliteBound } from './helpers/local-pg';

vi.mock('server-only', () => ({}));

describe('ensure missing demo profiles (additive hosted readiness)', () => {
  itSqliteBound('inserts only the missing Director profile, is idempotent, and never rewrites an existing row', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const seed = createSeedData('2026-10-01');
      const withoutDirector = seed.profiles.filter(profile => profile.id !== 'director');
      await fixture.store.transaction(async tx => { for (const profile of withoutDirector) await tx.put('profiles', profile); });
      expect(await fixture.store.get('profiles', 'director')).toBeUndefined();

      expect(await ensureMissingDemoProfiles(fixture.store, seed)).toEqual({ inserted: ['director'], present: [] });
      const director = await fixture.store.get<Profile>('profiles', 'director');
      expect(director).toMatchObject({ role: 'hr_director', permissions: ['hr.onboarding.director_read', 'hr.onboarding.director_approve', 'hr.onboarding.return'] });
      expect((await fixture.store.list('profiles')).length).toBe(seed.profiles.length);

      // An existing (even edited) row is left exactly as it is.
      await fixture.store.transaction(tx => tx.put('profiles', { ...director!, name: 'Edited Director' }));
      expect(await ensureMissingDemoProfiles(fixture.store, seed)).toEqual({ inserted: [], present: ['director'] });
      expect((await fixture.store.get<Profile>('profiles', 'director'))?.name).toBe('Edited Director');
    } finally {
      await fixture.dispose();
    }
  });

  it('a persisted local demo DB without the Director profile gets it at startup (additive, V1 boot)', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { createSqliteStore } = await import('../lib/storage/sqlite');
    const directory = mkdtempSync(join(tmpdir(), 'biztania-ensure-'));
    const path = join(directory, 'demo.sqlite');
    const saved = { ...process.env };
    try {
      const seed = createSeedData('2026-10-01');
      const legacy = createSqliteStore(path);
      // Batched like the real seed (one transaction per 500 rows); a transaction per row made this ~25k commits.
      for (const [table, rows] of Object.entries(seed) as [string, { id: string }[]][]) {
        for (let offset = 0; offset < rows.length; offset += 500) {
          await legacy.transaction(async tx => { for (const row of rows.slice(offset, offset + 500)) await tx.put(table as never, row); });
        }
      }
      await legacy.transaction(tx => tx.remove('profiles', 'director'));
      legacy.close?.();
      Object.assign(process.env, { USE_LOCAL_DEMO_DATA: 'true', DB_PATH: path, DEMO_BUSINESS_DATE: '2026-10-01', WORKFLOW_V2_ENABLED: 'false' });
      delete process.env.VERCEL;
      vi.resetModules();
      const { getStore } = await import('../lib/storage');
      const store = await getStore();
      expect(await store.get<Profile>('profiles', 'director')).toMatchObject({ role: 'hr_director' });
      store.close?.();
    } finally {
      process.env = saved;
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);

  it('runs at startup only for local demo data or the explicit hosted opt-in', () => {
    expect(demoProfileRepairEnabled({ USE_LOCAL_DEMO_DATA: 'true' })).toBe(true);
    expect(demoProfileRepairEnabled({ BIZTANIA_ENSURE_DEMO_PROFILES: 'true' })).toBe(true);
    expect(demoProfileRepairEnabled({})).toBe(false);
  });
});
