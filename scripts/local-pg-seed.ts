/**
 * Deterministic local demo seed (LOCAL stack only; reads .local/supabase-local.env, never hosted env).
 * Run through `node --conditions=react-server --import tsx` (npm run db:local:seed).
 */
import { readFileSync } from 'node:fs';
import { assertLoopbackUrl, LOCAL_ENV_FILE, parseEnvOutput } from './local-supabase';

export const LOCAL_SEED_BUSINESS_DATE = '2026-10-01';

export async function seedLocalDemoData(): Promise<number> {
  const file = parseEnvOutput(readFileSync(LOCAL_ENV_FILE, 'utf8'));
  const url = file.BIZTANIA_PG_SUPABASE_URL;
  const key = file.BIZTANIA_PG_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Run `npm run db:local:reset` first; .local/supabase-local.env is incomplete.');
  assertLoopbackUrl(url, 'BIZTANIA_PG_SUPABASE_URL');
  const [{ createSupabaseStore }, { seedStore }, { createSeedData }] = await Promise.all([
    import('../lib/storage/supabase'), import('../lib/storage'), import('../lib/seed/generate'),
  ]);
  const store = createSupabaseStore(url, key);
  const seed = createSeedData(LOCAL_SEED_BUSINESS_DATE);
  await seedStore(store, LOCAL_SEED_BUSINESS_DATE, seed);
  const profiles = (await store.list('profiles')).length;
  if (profiles !== seed.profiles.length) throw new Error('Local seed did not complete.');
  return Object.values(seed).reduce((sum, rows) => sum + rows.length, 0);
}

const entry = process.argv[1]?.replace(/\\/g, '/') ?? '';
if (entry.endsWith('scripts/local-pg-seed.ts')) {
  seedLocalDemoData().then((rows) => console.log(`Seeded ${rows} synthetic rows (business date ${LOCAL_SEED_BUSINESS_DATE}).`))
    .catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
