/**
 * E2E helper: adds ONE later-arriving onboarding request to the shard's private SQLite DB through the real Workflow V2 path
 * (complete documents inserted, then approved as the seeded East manager through prepare -> confirm -> verify), so the Director spec
 * can prove a request that arrives after the review snapshot is never swept in by "approve all I reviewed".
 *
 *   node --conditions=react-server --import tsx scripts/e2e/add-onboarding-arrival.ts <ordinal>
 *
 * Refuses to run outside the isolated E2E runner or on any database that is not the runner's private temporary UUID file.
 */
import { validateDatabasePath } from '../../tests/e2e/database-path';

async function main(): Promise<void> {
  if (process.env.NEXUS_E2E_RUNNER !== '1') throw new Error('Refusing to run outside the isolated E2E runner.');
  const databasePath = validateDatabasePath(process.env.NEXUS_E2E_DB_PATH ?? '');
  const ordinal = Number(process.argv[2]);
  const businessDate = process.env.DEMO_BUSINESS_DATE ?? '2026-10-01';
  const [{ createSqliteStore }, { createSeedData }, workflowV2, { createSeedManagerApprovalAdvancer }] = await Promise.all([
    import('../../lib/storage/sqlite'), import('../../lib/seed/generate'), import('../../lib/seed/workflow-v2'), import('../../lib/seed/workflow-v2-manager-advance'),
  ]);
  const store = createSqliteStore(databasePath);
  try {
    const plan = workflowV2.prepareWorkflowV2SeedPlan(createSeedData(businessDate), { seed: 1, businessDate });
    const result = await workflowV2.persistWorkflowV2LateArrival({ store, advanceManagerApprovals: createSeedManagerApprovalAdvancer(store) }, plan, ordinal);
    if (!result.directorPending) throw new Error('The arrival did not reach Director approval through the real manager path.');
    console.log(`arrival ${ordinal} ready for Director`);
  } finally {
    store.close?.();
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
