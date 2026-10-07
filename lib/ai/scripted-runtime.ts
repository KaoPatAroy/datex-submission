/**
 * Where the scripted (fixture) planners may run. Never in a hosted or self-hosted production server:
 *  - unit tests (NODE_ENV=test), or
 *  - the local E2E runner (NEXUS_E2E_RUNNER=1) outside production, or
 *  - the local E2E runner against a production build (`next start`), which must also present the per-run random token
 *    the runner generated (NEXUS_E2E_RUN_TOKEN, >= 32 hex chars). A merely set NEXUS_E2E_RUNNER flag is not enough.
 */
export function scriptedRuntimeAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === 'test') return true;
  if (env.NEXUS_E2E_RUNNER !== '1') return false;
  if (env.NODE_ENV !== 'production') return true;
  return /^[0-9a-f]{32,}$/i.test(env.NEXUS_E2E_RUN_TOKEN ?? '');
}
