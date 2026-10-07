import { defineConfig } from '@playwright/test';
import { selectDatabasePath, validateDatabasePath } from './tests/e2e/database-path';

const defaultPort = 41_000 + (process.pid % 8_000);
const port = Number(process.env.NEXUS_E2E_PORT ?? defaultPort);
process.env.NEXUS_E2E_PORT = String(port);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('NEXUS_E2E_PORT must be an available TCP port from 1024 through 65535.');
}

const databasePath = process.env.NEXUS_E2E_RUNNER === '1' && process.env.TEST_WORKER_INDEX === undefined
  ? validateDatabasePath(process.env.NEXUS_E2E_DB_PATH ?? '')
  : selectDatabasePath(process.env.NEXUS_E2E_DB_PATH,process.env.TEST_WORKER_INDEX,typeof process.send==='function');
process.env.NEXUS_E2E_DB_PATH = databasePath;
process.env.DB_PATH = databasePath;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: process.env.NEXUS_E2E_JSON_PATH
    ? [['list'], ['json', { outputFile: process.env.NEXUS_E2E_JSON_PATH }], ['./tests/e2e/cleanup-reporter.ts']]
    : [['list'], ['./tests/e2e/cleanup-reporter.ts']],
  outputDir: process.env.NEXUS_E2E_OUTPUT_DIR ?? 'test-results/e2e',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: 'chromium',
    channel: 'chrome',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: process.env.NEXUS_E2E_SERVER_COMMAND ?? `npm run dev -- --hostname 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      DEMO_ACCESS_CODE: 'nexus-test-access',
      DEMO_SESSION_SECRET: 'nexus-local-playwright-session-secret-2026',
      DEMO_LOGIN_REQUEST_LIMIT: '256',
      DEMO_BUSINESS_DATE: '2026-10-01',
      USE_LOCAL_DEMO_DATA: 'true',
      AI_PROVIDER: 'scripted',
      BIZTANIA_DYNAMIC_QUERY: process.env.BIZTANIA_DYNAMIC_QUERY ?? 'off',
      DB_PATH: databasePath,
      NEXUS_E2E_DB_PATH: databasePath,
    },
  },
});
