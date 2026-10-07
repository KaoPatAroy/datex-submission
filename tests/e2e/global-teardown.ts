import { rmSync } from 'node:fs';
import { validateDatabasePath } from './database-path';

export default function globalTeardown() {
  const rawPath = process.env.NEXUS_E2E_DB_PATH;
  if (!rawPath) return;

  const path = validateDatabasePath(rawPath);

  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${path}${suffix}`, { force: true });
  }
}
