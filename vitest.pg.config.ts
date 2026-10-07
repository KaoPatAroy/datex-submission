import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

/**
 * Opt-in local PostgreSQL run (`npm run test:pg`, which sets BIZTANIA_PG_TESTS=1).
 * One shared local database, so files run serially. Default `vitest run` never uses this.
 */
export default defineConfig({
  resolve: {
    alias: { '@': root },
  },
  ssr: {
    resolve: { conditions: ['react-server'] },
  },
  test: {
    environment: 'node',
    // Cursor signing and sessions require the configured secret (fail closed without it); tests use a fixed local test value.
    env: { DEMO_SESSION_SECRET: 'example-vitest-session-secret-0123456789abcdef' },
    include: [
      'tests/local-pg-*.test.ts',
      'tests/*storage*.test.ts',
      'tests/workflow-*.test.ts',
      'tests/pending-action-revision-storage.test.ts',
      'tests/session-history-supabase.test.ts',
      // Router-era service tests run against the PostgreSQL adapter through the PG-aware workspace fixture.
      'tests/router/ports/effects.test.ts',
      'tests/router/cross-session-proposals.test.ts',
      'tests/router/finish-b2-service.test.ts',
      'tests/router/release-blockers.test.ts',
      'tests/router/fixwave-service.test.ts',
      'tests/router/live-preparation.test.ts',
    ],
    exclude: ['tests/e2e/**', 'node_modules/**'],
    fileParallelism: false,
    clearMocks: true,
    restoreMocks: true,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
