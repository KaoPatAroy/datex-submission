import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

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
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
    clearMocks: true,
    restoreMocks: true,
    testTimeout: 30_000,
    // Hooks (fixture setup/teardown) starve under parallel load; the per-test budget above is unchanged.
    hookTimeout: 60_000,
    teardownTimeout: 60_000,
  },
});
