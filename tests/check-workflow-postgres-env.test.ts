import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { safeChildEnvironment } from '../scripts/check-workflow-postgres';

it('passes only the psql runtime allowlist and omits a dummy secret sentinel from the child', () => {
  const sentinelKey = 'WORKFLOW_PSQL_CHILD_ENV_SENTINEL';
  const sourceEnvironment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SYSTEMROOT: process.env.SYSTEMROOT,
    WINDIR: process.env.WINDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    USERPROFILE: process.env.USERPROFILE,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    LC_CTYPE: process.env.LC_CTYPE,
    NODE_ENV: 'test',
    [sentinelKey]: 'dummy-provider-secret',
    PGHOST: 'dummy-untrusted-host',
    PGPASSWORD: 'dummy-untrusted-password',
    PGPASSFILE: 'C:\\private\\wrong-pgpass.conf',
    PGOPTIONS: '-c application_name=untrusted-parent-value',
    PGCONNECT_TIMEOUT: '999',
    SUPABASE_ACCESS_TOKEN: 'dummy-supabase-secret',
    OPENAI_API_KEY: 'dummy-provider-secret'
  };
  const passfile = 'C:\\private\\pgpass.conf';
  const childEnvironment = safeChildEnvironment(passfile, 2_500, 5, sourceEnvironment);

  expect(childEnvironment.PGPASSFILE).toBe(passfile);
  expect(childEnvironment.PGOPTIONS).toContain('statement_timeout=2500');
  expect(childEnvironment.PGOPTIONS).not.toContain('untrusted-parent-value');
  expect(childEnvironment.PGCONNECT_TIMEOUT).toBe('5');
  expect(childEnvironment.NODE_ENV).toBe('test');
  expect(childEnvironment.PGHOST).toBeUndefined();
  expect(childEnvironment.PGPASSWORD).toBeUndefined();
  expect(childEnvironment.SUPABASE_ACCESS_TOKEN).toBeUndefined();
  expect(childEnvironment.OPENAI_API_KEY).toBeUndefined();

  const child = spawnSync(process.execPath, [
    '-e',
    `process.stdout.write(process.env.${sentinelKey} ?? 'absent')`
  ], { env: childEnvironment, encoding: 'utf8', windowsHide: true });
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  expect(child.stdout).toBe('absent');
});
