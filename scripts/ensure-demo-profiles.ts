/**
 * Additive, idempotent "ensure missing demo identities" release step (HR Director login profile + its V2 directory identity).
 * Seeding is skipped once profiles exist, so a store seeded before the Director profile existed lacks it; this repairs ONLY that,
 * insert-if-absent, never rewriting an existing row.
 *
 *   node --conditions=react-server --import tsx scripts/ensure-demo-profiles.ts            # dry run (default): reports, writes nothing
 *   node --conditions=react-server --import tsx scripts/ensure-demo-profiles.ts --apply    # performs the additive inserts
 *
 * Target: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) + SUPABASE_SERVICE_ROLE_KEY from the environment; the key is never printed.
 * See docs/BIZTANIA_WAVE5_LOCAL_PG.md "Hosted release requirements for the HR Director demo".
 */
import { ensureMissingDemoProfiles, ENSURABLE_DEMO_PROFILE_IDS } from '../lib/seed/ensure-demo-profiles';
import type { Profile, Store } from '../lib/contracts';
import type { WorkflowStoreCapability } from '../lib/storage/workflow-projections';

const BUSINESS_DATE = process.env.DEMO_BUSINESS_DATE ?? '2026-10-01';

export async function runEnsureDemoProfiles(store: Store, apply: boolean): Promise<string[]> {
  const report: string[] = [];
  const { createSeedData } = await import('../lib/seed/generate');
  const seed = createSeedData(BUSINESS_DATE);
  for (const id of ENSURABLE_DEMO_PROFILE_IDS) report.push(`profile ${id}: ${await store.get<Profile>('profiles', id) ? 'present' : 'MISSING'}`);
  if (apply) {
    const result = await ensureMissingDemoProfiles(store, seed);
    report.push(`profiles inserted: [${result.inserted.join(', ')}] already present: [${result.present.join(', ')}]`);
  }
  const workflowStore = store as Partial<WorkflowStoreCapability> & Store;
  if (workflowStore.workflowContractVersion === 2 && workflowStore.workflowProjectionReader && typeof workflowStore.workflowTransaction === 'function') {
    const { prepareWorkflowV2SeedPlan, ensureWorkflowV2DirectorIdentity } = await import('../lib/seed/workflow-v2');
    const plan = prepareWorkflowV2SeedPlan(seed, { seed: 1, businessDate: BUSINESS_DATE });
    const markers = await workflowStore.workflowProjectionReader.query<{ summary?: string }>({
      kind: 'scoped', table: 'audit_events', equals: { category: 'synthetic_workflow_v2_seed_begin' }, limit: 5 });
    if (markers.length === 0) report.push('V2 seed marker: absent (the V2 bootstrap will create the full plan, including the Director identity)');
    else {
      const current = markers.some(marker => typeof marker.body.summary === 'string' && marker.body.summary.includes(plan.inputDigest));
      report.push(`V2 seed marker: present, ${current ? 'matches the current plan digest' : 'DIFFERS from the current plan digest (bootstrap would fail closed: see the hosted release notes)'}`);
    }
    if (apply) report.push(`director directory identity: ${await ensureWorkflowV2DirectorIdentity(workflowStore as Store & WorkflowStoreCapability, plan)}`);
  } else report.push('store has no Workflow V2 capability: directory identity step skipped');
  return report;
}

const entry = process.argv[1]?.replace(/\\/g, '/') ?? '';
if (entry.endsWith('scripts/ensure-demo-profiles.ts')) {
  (async () => {
    const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
    const apply = process.argv.includes('--apply');
    const { createSupabaseStore } = await import('../lib/storage/supabase');
    console.log(`${apply ? 'APPLY' : 'DRY RUN'} against ${new URL(url).host}`);
    for (const line of await runEnsureDemoProfiles(createSupabaseStore(url, key), apply)) console.log(line);
  })().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
