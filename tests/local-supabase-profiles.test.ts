import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertLoopbackUrl,
  isLocalDockerEndpoint,
  LOCAL_PARITY_FIXTURE,
  localDockerEnvironment,
  MIGRATION_MANIFEST,
  migrationPath,
  parseEnvOutput,
  PROFILES,
  redact,
  REPOSITORY_ROOT,
  sanitizedEnvironment,
  SUPABASE_CLI_PACKAGE,
  verifyMigrationManifest,
} from '../scripts/local-supabase';

// DB-free: runs in the default suite and proves the local profile contract statically.
describe('local Supabase profile contract', () => {
  it('pins the CLI and keeps every migration file equal to its manifest digest', () => {
    expect(SUPABASE_CLI_PACKAGE).toBe('supabase@2.119.0');
    expect(() => verifyMigrationManifest()).not.toThrow();
    const pinned = Object.fromEntries(MIGRATION_MANIFEST.map((entry) => [entry.id, entry.sha256]));
    // Historical files keep the digests recorded by the reviewed PostgreSQL harness and hosted check.
    expect(pinned['202610010002_workflow_pending_action_v1_guard']).toBe('893aac7de121ab816f5f154d88cad212041d200cd4126aa6ced30a9243e132c0');
    expect(pinned['202610040001_workflow_conversation_persistence']).toBe('c3a2da42a7873c96fed5e5b4e8346370ca8ce5c289ee5731bbb8cb1d65d6a0af');
    expect(pinned['202610040002_workflow_snapshot_proof_references']).toBe('3fdc491792d1141dfe40b18e8fed7ef673e5e797668467d4601f37c2be1dd60a');
    expect(pinned['202610040003_workflow_action_target_provenance']).toBe('68a25f9dcf4a5b1a1a016a1f3794a04bd1698cb7a23b53745319dba11d8f6bd5');
  });

  it('defines explicit ordered profiles and keeps the parity fixture out of supabase/migrations', () => {
    const ids = MIGRATION_MANIFEST.map((entry) => entry.id);
    expect([...ids].sort()).toEqual(ids);
    expect(PROFILES['hosted-v1']).toEqual(['202610010001_concierge', '202610010002_workflow_pending_action_v1_guard']);
    expect(PROFILES.fresh).toEqual(ids);
    expect(PROFILES['v2-proof']).toEqual(ids.filter((id) => id !== '202610010002_workflow_pending_action_v1_guard'));
    expect(ids.indexOf('202610020003_workflow_v1_guard_bridge_fence')).toBe(ids.indexOf('202610020002_workflow_v2') + 1);
    expect(ids.indexOf('202610030002_workflow_projection_completeness')).toBe(ids.indexOf('202610020003_workflow_v1_guard_bridge_fence') + 1);
    expect(ids.indexOf('202610030003_workflow_v1_guard_bridge_seal')).toBe(ids.indexOf('202610030002_workflow_projection_completeness') + 1);
    expect(ids.indexOf('202610040001_workflow_conversation_persistence')).toBe(ids.indexOf('202610030003_workflow_v1_guard_bridge_seal') + 1);
    expect(ids.indexOf('202610060001_workflow_v1_guard_bridge_activate')).toBe(ids.indexOf('202610040003_workflow_action_target_provenance') + 1);
    expect(ids.indexOf('202610060002_workflow_commit_typed_unique_lookup')).toBe(ids.length - 4);
    expect(ids.at(-3)).toBe('202610060900_router_proposals');
    expect(ids.at(-2)).toBe('202610070001_nexus_commit_update_first');
    expect(ids.at(-1)).toBe('202610070002_pending_action_v1_status_projection_check');
    expect(LOCAL_PARITY_FIXTURE.id < ids[0]).toBe(true);
    expect(ids).not.toContain(LOCAL_PARITY_FIXTURE.id);
    const config = readFileSync(join(REPOSITORY_ROOT, 'supabase', 'config.toml'), 'utf8');
    expect(config).toContain('project_id = "biztania-local"');
  });

  it('keeps every bridge step transactional, serialized, bounded, fail-closed and free of data rewrites', () => {
    for (const id of ['202610020003_workflow_v1_guard_bridge_fence', '202610030003_workflow_v1_guard_bridge_seal', '202610060001_workflow_v1_guard_bridge_activate']) {
      const sql = readFileSync(migrationPath(id), 'utf8').replace(/\r\n/g, '\n');
      const code = sql.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n').trim();
      // Transaction-wide bounds (P2-3): lock, statement and idle-in-transaction timeouts, plus
      // transaction_timeout where the server has it (PostgreSQL 17+; a no-op select elsewhere).
      expect(code.startsWith("begin;\nset local lock_timeout='5s';\nset local statement_timeout='120s';\n"
        + "set local idle_in_transaction_session_timeout='60s';\n"
        + "select pg_catalog.set_config('transaction_timeout','180s',true)\n  from pg_catalog.pg_settings where name='transaction_timeout';\n"
        + 'select pg_catalog.pg_advisory_xact_lock(20261006,1);')).toBe(true);
      expect(code.endsWith('commit;')).toBe(true);
      expect(code).toContain('pg_advisory_xact_lock(20261006,1)');
      // The fence/seal/activate checks share one effective-privilege rule over all roles (P1-2).
      expect(code).toContain("pg_catalog.has_table_privilege(r.oid,'public.pending_actions'::regclass,'INSERT,UPDATE,DELETE,TRUNCATE')");
      expect(code).toContain("r.rolname='pg_write_all_data'");
      expect(code).toMatch(/lock table public\.pending_actions in access exclusive mode/);
      expect(code).toMatch(/errcode='23514'/);
      expect(code).not.toMatch(/\b(update|delete from|insert into)\s+public\.pending_actions\b/i);
      expect(code).not.toMatch(/\bdrop\s+(table|function|schema)\b/i);
      expect(code).not.toMatch(/pending_action_v1_migrations\s+(set|values)|update\s+nexus_private\.pending_action_v1_migrations/i);
    }
  });

  it('keeps the typed commit step transactional, bounded and limited to replacing nexus_workflow_commit', () => {
    const sql = readFileSync(migrationPath('202610060002_workflow_commit_typed_unique_lookup'), 'utf8').replace(/\r\n/g, '\n');
    const code = sql.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n').trim();
    expect(code.startsWith("begin;\nset local lock_timeout='5s';\nset local statement_timeout='60s';")).toBe(true);
    expect(code.endsWith('commit;')).toBe(true);
    expect(code).toContain("installed_md5 is distinct from 'f5ef58318e3472dd712f8abe2d54184c'");
    expect(code).not.toContain("format('to_jsonb(t)->%L = $1->%L'");
    // Outside the embedded function source the step only replaces the function (the
    // temp-table update normalizes line endings of that source).
    const outer = code.slice(code.indexOf('$commit$);'));
    expect(outer).not.toMatch(/\b(update|delete from|insert into|truncate)\s+public\./i);
    expect(code).not.toMatch(/\bdrop\s+(table|function|schema|trigger)\b/i);
  });

  it('pins Docker to the local daemon and refuses remote endpoints or contexts', () => {
    expect(isLocalDockerEndpoint('npipe:////./pipe/docker_engine', 'win32')).toBe(true);
    expect(isLocalDockerEndpoint('npipe:////./pipe/dockerDesktopLinuxEngine', 'win32')).toBe(true);
    expect(isLocalDockerEndpoint('npipe:////remote-host/pipe/docker_engine', 'win32')).toBe(false);
    expect(isLocalDockerEndpoint('tcp://10.0.0.5:2376', 'win32')).toBe(false);
    expect(isLocalDockerEndpoint('unix:///var/run/docker.sock', 'linux')).toBe(true);
    expect(isLocalDockerEndpoint('unix:///Users/me/.docker/run/docker.sock', 'darwin')).toBe(true);
    expect(isLocalDockerEndpoint('unix:///var/run/../tmp/docker.sock', 'linux')).toBe(false);
    for (const remote of ['tcp://docker.example.com:2376', 'ssh://user@host', 'unix:///var/run/other.sock', 'npipe:////./pipe/docker_engine', '']) {
      expect(isLocalDockerEndpoint(remote, 'linux')).toBe(false);
    }

    const seen: NodeJS.ProcessEnv[] = [];
    const probe = (endpoint: string) => (env: NodeJS.ProcessEnv) => {
      seen.push(env);
      return { status: 0, stdout: `${endpoint}\n`, stderr: '' };
    };
    const source = {
      PATH: '/bin', DOCKER_HOST: 'tcp://docker.example.com:2376', DOCKER_CONTEXT: 'remote', DOCKER_CONFIG: '/tmp/cfg',
      DOCKER_TLS_VERIFY: '1', DOCKER_CERT_PATH: '/tmp/certs', SUPABASE_ACCESS_TOKEN: 'dummy',
    };
    const pinned = localDockerEnvironment(source, probe('npipe:////./pipe/dockerDesktopLinuxEngine'), 'win32');
    // The probe never sees a redirecting variable; the child gets only the verified local endpoint.
    expect(seen[0]).toEqual({ PATH: '/bin' });
    expect(pinned).toEqual({ PATH: '/bin', DOCKER_HOST: 'npipe:////./pipe/dockerDesktopLinuxEngine' });
    expect(() => localDockerEnvironment(source, probe('tcp://docker.example.com:2376'), 'win32')).toThrow(/not the local Docker daemon/);
    expect(() => localDockerEnvironment(source, probe('ssh://user@host'), 'linux')).toThrow(/not the local Docker daemon/);
    expect(() => localDockerEnvironment(source, () => ({ status: 1, stdout: '', stderr: 'context not found' }), 'win32')).toThrow(/could not resolve/);
  });

  it('strips hosted credentials from child processes and redacts local secrets', () => {
    const environment = sanitizedEnvironment({
      PATH: '/bin', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'example-dummy',
      NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ACCESS_TOKEN: 'dummy', DATABASE_URL: 'postgres://x',
      PGPASSWORD: 'dummy', PGHOST: 'remote', BIZTANIA_PG_SERVICE_ROLE_KEY: 'dummy',
    });
    expect(environment).toEqual({ PATH: '/bin' });
    const jwt = `eyJ${'a'.repeat(12)}.${'b'.repeat(12)}.${'c'.repeat(12)}`;
    const text = redact(`SERVICE_ROLE_KEY="${jwt}"\nkey ${jwt}\nsb_secret_abc123\npostgresql://postgres:pw@127.0.0.1:54322/postgres\n{"JWT_SECRET":"local-jwt-secret-value","S3_PROTOCOL_ACCESS_KEY_SECRET":"s3secret"}`);
    expect(text).not.toContain('local-jwt-secret-value');
    expect(text).not.toContain('s3secret');
    expect(text).not.toContain(jwt);
    expect(text).not.toContain('sb_secret_abc123');
    expect(text).not.toContain(':pw@');
  });

  it('accepts only loopback endpoints from local status output', () => {
    expect(parseEnvOutput('API_URL="http://127.0.0.1:54321"\nFOO=bar').API_URL).toBe('http://127.0.0.1:54321');
    expect(() => assertLoopbackUrl('http://127.0.0.1:54321', 'API_URL')).not.toThrow();
    expect(() => assertLoopbackUrl('https://project.supabase.co', 'API_URL')).toThrow(/loopback/);
  });
});
