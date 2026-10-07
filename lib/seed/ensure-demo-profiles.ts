import type { Profile, SeedData, Store } from '../contracts';

/**
 * Seeding is skipped once any profile exists, so a store seeded before a demo login profile was introduced (a persisted local
 * SQLite file, or the hosted DB) lacks it. This is the additive, idempotent repair: insert-if-absent of the named profiles only.
 * Existing rows are never read-modify-written, so a store that already has the profile (or an edited one) is left untouched.
 */
export const ENSURABLE_DEMO_PROFILE_IDS = ['director'] as const;

export interface EnsureDemoProfilesResult { readonly inserted: readonly string[]; readonly present: readonly string[] }

export async function ensureMissingDemoProfiles(store: Store, seedData: Pick<SeedData, 'profiles'>): Promise<EnsureDemoProfilesResult> {
  const inserted: string[] = [];
  const present: string[] = [];
  for (const id of ENSURABLE_DEMO_PROFILE_IDS) {
    const profile = seedData.profiles.find((candidate: Profile) => candidate.id === id);
    if (!profile) continue;
    const wasInserted = await store.transaction(async tx => {
      if (await tx.get<Profile>('profiles', id)) return false;
      await tx.put('profiles', profile);
      return true;
    });
    (wasInserted ? inserted : present).push(id);
  }
  return { inserted, present };
}

/** True when the process may repair demo profiles automatically at startup (local demo data, or the explicit hosted release opt-in). */
export function demoProfileRepairEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.USE_LOCAL_DEMO_DATA === 'true' || env.BIZTANIA_ENSURE_DEMO_PROFILES === 'true';
}
