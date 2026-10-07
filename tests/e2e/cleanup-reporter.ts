import type { Reporter } from '@playwright/test/reporter';
import cleanupDatabase from './global-teardown';

/** Reporter exit runs after webServer teardown, when SQLite has released its files. */
export default class CleanupReporter implements Reporter {
  async onExit() { cleanupDatabase(); }
}
