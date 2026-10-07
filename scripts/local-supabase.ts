/**
 * Local-only Supabase/PostgreSQL profile runner (Track B Wave 5).
 *
 * Every CLI call uses the pinned `npx supabase@2.119.0`, an explicit `--workdir` that
 * holds only the selected migration profile, and `--local` where the command accepts a
 * target. It never links, logs in, pushes, or reads hosted credentials: hosted-looking
 * variables are stripped from child environments, a linked workdir is refused, and
 * every URL must be loopback. Local keys are written only to the git-ignored
 * `.local/supabase-local.env` and are never printed. Every `docker`/CLI child is pinned
 * to the verified local Docker daemon endpoint (see localDockerEnvironment).
 */
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SUPABASE_CLI_PACKAGE = 'supabase@2.119.0';
export const LOCAL_PROJECT_ID = 'biztania-local';
export const LOCAL_DB_CONTAINER = `supabase_db_${LOCAL_PROJECT_ID}`;
export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const LOCAL_ENV_FILE = join(REPOSITORY_ROOT, '.local', 'supabase-local.env');
const PROFILE_ROOT = join(REPOSITORY_ROOT, '.local', 'supabase-profiles');
const MIGRATIONS_DIRECTORY = join(REPOSITORY_ROOT, 'supabase', 'migrations');
const PARITY_DIRECTORY = join(REPOSITORY_ROOT, 'supabase', 'local-parity');

/** SHA-256 of each file with CRLF normalized to LF (the committed blob bytes). */
export const MIGRATION_MANIFEST = [
  { id: '202610010001_concierge', sha256: 'b8dda960508c3dc5dff3a6cc1f390409b1126f4d014caa0d85821a4ceed3d018' },
  { id: '202610010002_workflow_pending_action_v1_guard', sha256: '893aac7de121ab816f5f154d88cad212041d200cd4126aa6ced30a9243e132c0' },
  { id: '202610020002_workflow_v2', sha256: '5e32e12e4fc274bda514445bd2fadbcbeaec5e320208c1a59151b51c7acba815' },
  { id: '202610020003_workflow_v1_guard_bridge_fence', sha256: '5fdf438ef6fdbbf47384ddfdde2615371c4d18f3cf64c9ddb36cf8889dd8edab' },
  { id: '202610030002_workflow_projection_completeness', sha256: '2904ca6ae57252c5648d87ed58c9906fa0adcb23b6bfc77803772c51fe1a898c' },
  { id: '202610030003_workflow_v1_guard_bridge_seal', sha256: 'ad43fb6ebdb344aef3c340d96c1907da5a64739f50dc7312079f8b3224c9458e' },
  { id: '202610040001_workflow_conversation_persistence', sha256: 'c3a2da42a7873c96fed5e5b4e8346370ca8ce5c289ee5731bbb8cb1d65d6a0af' },
  { id: '202610040002_workflow_snapshot_proof_references', sha256: '3fdc491792d1141dfe40b18e8fed7ef673e5e797668467d4601f37c2be1dd60a' },
  { id: '202610040003_workflow_action_target_provenance', sha256: '68a25f9dcf4a5b1a1a016a1f3794a04bd1698cb7a23b53745319dba11d8f6bd5' },
  { id: '202610060001_workflow_v1_guard_bridge_activate', sha256: '179f470e6ddecb2f1cae0531dc979f8e61e5aac0a4752986641e0deedb02fdfa' },
  { id: '202610060002_workflow_commit_typed_unique_lookup', sha256: '550859a490c98c30360caa065c5938b350effdc802ab8bf66cac9a7e3b876535' },
  // Copied verbatim from branch claude/biztania-router-int-20261006 (router-staged proposals table).
  { id: '202610060900_router_proposals', sha256: 'f3ac889fa8d67adb22b6db422332d102e028cf30a97d7e80b2319899439c3fe1' },
  { id: '202610070001_nexus_commit_update_first', sha256: 'e48aef8cde6087b06e533a1c323cd86c8ccd556fbda55f804f31fce2075bdea1' },
  { id: '202610070002_pending_action_v1_status_projection_check', sha256: '07d9d311919a8e417889492dd66fe5e90403de295366647f95ea89897ea6dcee' },
] as const;

/** Local-only hosted ACL parity fixture; staged ahead of 202610010001, never hosted. */
export const LOCAL_PARITY_FIXTURE = {
  id: '202609300001_local_hosted_service_role_acl_parity',
  sha256: '4370e646d178f18b535d5831b157be926c5f516f2ead2fdc8b949856a1f84210',
} as const;

type MigrationId = (typeof MIGRATION_MANIFEST)[number]['id'];
export type ProfileName = 'fresh' | 'hosted-v1' | 'v2-proof';

const ALL_MIGRATIONS = MIGRATION_MANIFEST.map((entry) => entry.id);
export const PROFILES: Record<ProfileName, readonly MigrationId[]> = {
  /** Every repository migration in order: the canonical chain hosted would reach. */
  fresh: ALL_MIGRATIONS,
  /** The hosted Production state: concierge plus the standalone V1 guard. */
  'hosted-v1': ['202610010001_concierge', '202610010002_workflow_pending_action_v1_guard'],
  /** Isolated Workflow V2 proof without the standalone guard (bridge steps are no-ops). */
  'v2-proof': ALL_MIGRATIONS.filter((id) => id !== '202610010002_workflow_pending_action_v1_guard'),
};

export function isProfileName(value: string): value is ProfileName {
  return Object.prototype.hasOwnProperty.call(PROFILES, value);
}

export function sha256Lf(path: string): string {
  const text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function migrationPath(id: string): string {
  return join(MIGRATIONS_DIRECTORY, `${id}.sql`);
}

export function parityFixturePath(): string {
  return join(PARITY_DIRECTORY, `${LOCAL_PARITY_FIXTURE.id}.sql`);
}

/** Fails closed when the migration directory and the pinned manifest disagree. */
export function verifyMigrationManifest(): void {
  const actual = readdirSync(MIGRATIONS_DIRECTORY).filter((name) => name.endsWith('.sql')).sort();
  const expected = MIGRATION_MANIFEST.map((entry) => `${entry.id}.sql`);
  if (actual.join('\n') !== expected.join('\n')) {
    throw new Error(`Migration directory does not match the pinned manifest.\nexpected: ${expected.join(', ')}\nactual: ${actual.join(', ')}`);
  }
  for (const entry of MIGRATION_MANIFEST) {
    const digest = sha256Lf(migrationPath(entry.id));
    if (digest !== entry.sha256) throw new Error(`Migration ${entry.id} SHA-256 ${digest} does not match the pinned ${entry.sha256}`);
  }
  const parity = sha256Lf(parityFixturePath());
  if (parity !== LOCAL_PARITY_FIXTURE.sha256) throw new Error(`Local parity fixture SHA-256 ${parity} does not match the pinned value`);
}

function assertNotLinked(workdir: string): void {
  for (const candidate of [join(workdir, 'supabase', '.temp', 'project-ref'), join(REPOSITORY_ROOT, 'supabase', '.temp', 'project-ref')]) {
    if (existsSync(candidate)) throw new Error(`Refusing to run: ${candidate} links a hosted project. Local profiles must never be linked.`);
  }
}

/** Builds `.local/supabase-profiles/<profile>` holding config.toml and only that profile's files. */
export function stageProfile(profile: ProfileName): string {
  verifyMigrationManifest();
  const workdir = join(PROFILE_ROOT, profile);
  rmSync(workdir, { recursive: true, force: true });
  const migrations = join(workdir, 'supabase', 'migrations');
  mkdirSync(migrations, { recursive: true });
  const config = readFileSync(join(REPOSITORY_ROOT, 'supabase', 'config.toml'), 'utf8');
  if (!config.includes(`project_id = "${LOCAL_PROJECT_ID}"`)) throw new Error('supabase/config.toml must keep the local project_id');
  writeFileSync(join(workdir, 'supabase', 'config.toml'), config);
  copyFileSync(parityFixturePath(), join(migrations, `${LOCAL_PARITY_FIXTURE.id}.sql`));
  for (const id of PROFILES[profile]) copyFileSync(migrationPath(id), join(migrations, `${id}.sql`));
  return workdir;
}

const HOSTED_ENVIRONMENT = /^(SUPABASE_|NEXT_PUBLIC_SUPABASE_|DATABASE_URL$|POSTGRES_|PG[A-Z]+$|BIZTANIA_PG_)/;

/** Child environment without hosted Supabase/PostgreSQL credentials or targets. */
export function sanitizedEnvironment(source: Record<string, string | undefined> = process.env): NodeJS.ProcessEnv {
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(source)) if (!HOSTED_ENVIRONMENT.test(key)) result[key] = value;
  return result as NodeJS.ProcessEnv;
}

/** Docker variables that could redirect `docker`/Supabase CLI calls to another daemon. */
const DOCKER_TARGET_ENVIRONMENT = /^DOCKER_(HOST|CONTEXT|CONFIG|TLS|TLS_VERIFY|CERT_PATH|API_VERSION)$/;
const LOCAL_WINDOWS_PIPES = ['npipe:////./pipe/docker_engine', 'npipe:////./pipe/dockerDesktopLinuxEngine'];

/** True only for this machine's Docker Desktop named pipe or a local unix socket. */
export function isLocalDockerEndpoint(endpoint: string, platform: NodeJS.Platform = process.platform): boolean {
  const value = endpoint.trim();
  if (platform === 'win32') return LOCAL_WINDOWS_PIPES.includes(value);
  return /^unix:\/\/\/(?:[A-Za-z0-9._-]+\/)*docker\.sock$/.test(value) && !value.includes('/../');
}

type DockerProbe = (env: NodeJS.ProcessEnv) => { status: number | null; stdout: string; stderr: string; error?: Error };

const defaultDockerProbe: DockerProbe = (env) => {
  const result = spawnSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { encoding: 'utf8', windowsHide: true, env });
  return { status: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? ''), error: result.error };
};

/**
 * Child environment pinned to the local Docker daemon: hosted variables and every
 * Docker redirection variable are dropped, the effective endpoint of the current
 * Docker context is resolved, and anything but a local named pipe/unix socket is
 * refused. The verified endpoint is then set explicitly as DOCKER_HOST.
 */
export function localDockerEnvironment(
  source: Record<string, string | undefined> = process.env,
  probe: DockerProbe = defaultDockerProbe,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const environment: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(sanitizedEnvironment(source))) {
    if (!DOCKER_TARGET_ENVIRONMENT.test(key)) environment[key] = value;
  }
  const result = probe({ ...environment } as NodeJS.ProcessEnv);
  if (result.error || result.status !== 0) throw new Error('Refusing to run: could not resolve the local Docker context endpoint');
  const endpoint = result.stdout.trim();
  if (!isLocalDockerEndpoint(endpoint, platform)) {
    throw new Error(`Refusing to run: Docker endpoint ${JSON.stringify(endpoint)} is not the local Docker daemon`);
  }
  environment.DOCKER_HOST = endpoint;
  return environment as NodeJS.ProcessEnv;
}

let pinnedDockerEnvironment: NodeJS.ProcessEnv | undefined;
function dockerEnvironment(): NodeJS.ProcessEnv {
  pinnedDockerEnvironment ??= localDockerEnvironment();
  return pinnedDockerEnvironment;
}

/** Replaces JWTs, Supabase API keys and connection-string passwords. */
export function redact(text: string): string {
  return text
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<redacted-jwt>')
    .replace(/sb_(secret|publishable)_[A-Za-z0-9_-]+/g, '<redacted-key>')
    .replace(/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+@/g, '$1<redacted>@')
    .replace(/^(\s*[│|]?\s*(?:Secret|Publishable|anon key|service_role key|JWT secret|S3 Access Key|S3 Secret Key|Access Key|Secret Key)\b[^\n]*?[:│|]\s*)\S+/gim, '$1<redacted>')
    .replace(/^((?:[A-Z0-9_]*(?:KEY|SECRET)[A-Z0-9_]*)=).*$/gm, '$1<redacted>')
    .replace(/("[A-Z0-9_]*(?:KEY|SECRET)[A-Z0-9_]*"\s*:\s*)"(?:[^"\\]|\\.)*"/g,'$1"<redacted>"');
}

function runSupabase(args: string[], workdir: string, options: { capture?: boolean } = {}): { status: number; stdout: string; stderr: string } {
  assertNotLinked(workdir);
  if (args.some((arg) => /^--(linked|db-url|project-ref)/.test(arg) || arg === 'link' || arg === 'login' || arg === 'push')) {
    throw new Error('Refusing a hosted-target Supabase command');
  }
  const command = ['npx', '--yes', SUPABASE_CLI_PACKAGE, ...args, '--workdir', `"${workdir}"`].join(' ');
  const spawnOptions: SpawnSyncOptions = { cwd: REPOSITORY_ROOT, env: dockerEnvironment(), encoding: 'utf8', shell: true, windowsHide: true, maxBuffer: 64 * 1024 * 1024 };
  const result = spawnSync(command, spawnOptions);
  const stdout = String(result.stdout ?? '');
  const stderr = String(result.stderr ?? '');
  if (!options.capture) {
    if (stdout) process.stdout.write(redact(stdout));
    if (stderr) process.stderr.write(redact(stderr));
  }
  return { status: result.status ?? 1, stdout, stderr };
}

export function parseEnvOutput(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(?:"(.*)"|(.*))$/.exec(line.trim());
    if (match) values[match[1]] = match[2] ?? match[3] ?? '';
  }
  return values;
}

export function assertLoopbackUrl(value: string, label: string): URL {
  const url = new URL(value);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error(`${label} must be a loopback URL`);
  return url;
}

/** Records the local stack's own URL/keys in the git-ignored env file; prints nothing secret. */
export function writeLocalEnvironment(profile: ProfileName): void {
  const workdir = join(PROFILE_ROOT, profile);
  const status = runSupabase(['status', '-o', 'env'], existsSync(workdir) ? workdir : stageProfile(profile), { capture: true });
  if (status.status !== 0) throw new Error(`supabase status failed: ${redact(status.stderr).trim()}`);
  const values = parseEnvOutput(status.stdout);
  const apiUrl = values.API_URL;
  const serviceKey = values.SERVICE_ROLE_KEY || values.SECRET_KEY;
  if (!apiUrl || !serviceKey) throw new Error('supabase status did not report a local API URL and service key');
  assertLoopbackUrl(apiUrl, 'API_URL');
  mkdirSync(dirname(LOCAL_ENV_FILE), { recursive: true });
  writeFileSync(LOCAL_ENV_FILE, [
    '# Generated by scripts/local-supabase.ts for the LOCAL stack only. Never commit.',
    `BIZTANIA_PG_PROFILE=${profile}`,
    `BIZTANIA_PG_SUPABASE_URL=${apiUrl}`,
    `BIZTANIA_PG_SERVICE_ROLE_KEY=${serviceKey}`,
    `BIZTANIA_PG_DB_CONTAINER=${LOCAL_DB_CONTAINER}`,
    '',
  ].join('\n'), { mode: 0o600 });
  console.log(`Local environment written to .local/supabase-local.env (API ${apiUrl}; key redacted).`);
}

/**
 * Runs SQL in the local database container, as `postgres` by default. `supabase_admin`
 * (the local cluster superuser) is accepted only for test setup that needs it, such as
 * granting a predefined role.
 */
export function localPsql(sql: string, database = 'postgres', user: 'postgres' | 'supabase_admin' = 'postgres'): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(database)) throw new Error('Invalid local database name');
  if (user !== 'postgres' && user !== 'supabase_admin') throw new Error('Invalid local database user');
  const result = spawnSync('docker', [
    'exec', '-i', '-e', 'PGOPTIONS=--client-min-messages=warning', LOCAL_DB_CONTAINER,
    'psql', '-U', user, '-d', database, '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-A', '-t',
  ], { input: sql, encoding: 'utf8', windowsHide: true, env: dockerEnvironment(), maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(`psql failed: ${redact(String(result.stderr)).trim()}`);
    Object.assign(error, { stderr: String(result.stderr) });
    throw error;
  }
  return String(result.stdout).trim();
}

/** Ledger check: the applied Supabase migration versions equal the profile exactly. */
export function verifyAppliedProfile(profile: ProfileName): string[] {
  const expected = [LOCAL_PARITY_FIXTURE.id, ...PROFILES[profile]].map((id) => id.split('_')[0]);
  const applied = localPsql('select version from supabase_migrations.schema_migrations order by version').split(/\r?\n/).filter(Boolean);
  if (applied.join(',') !== expected.join(',')) {
    throw new Error(`Profile ${profile} is not fully applied: expected ${expected.join(',')}, found ${applied.join(',')}`);
  }
  return applied;
}

/** Per-table md5 over canonical row JSON (sorted), for every public table; proves seed determinism. */
export function localDataDigests(): Record<string, string> {
  const out = localPsql(`
    create temp table _digest(t text, h text);
    do $d$ declare r record; h text; begin
      for r in select c.relname from pg_class c where c.relnamespace='public'::regnamespace and c.relkind='r' order by 1 loop
        execute format('select coalesce(md5(string_agg(x::text, ''|'' order by x::text)), ''empty'') from (select to_jsonb(t) as x from public.%I t) s', r.relname) into h;
        insert into _digest values (r.relname, h);
      end loop;
    end $d$;
    select t || '=' || h from _digest order by t;
  `);
  const digests: Record<string, string> = {};
  for (const line of out.split(/\r?\n/).filter(Boolean)) {
    const [table, digest] = line.split('=');
    digests[table] = digest;
  }
  return digests;
}

function seedLocal(): number {
  const result = spawnSync(process.execPath, ['--conditions=react-server', '--import', 'tsx', join(REPOSITORY_ROOT, 'scripts', 'local-pg-seed.ts')], {
    cwd: REPOSITORY_ROOT, stdio: 'inherit', windowsHide: true, env: sanitizedEnvironment(),
  });
  return result.status ?? 1;
}

function parseProfile(argv: string[]): ProfileName {
  const index = argv.indexOf('--profile');
  const value = index >= 0 ? argv[index + 1] : 'fresh';
  if (!value || !isProfileName(value)) throw new Error(`Unknown profile ${value ?? ''}; use one of ${Object.keys(PROFILES).join(', ')}`);
  return value;
}

function main(argv: string[]): number {
  const [command = 'help', ...rest] = argv;
  switch (command) {
    case 'manifest': {
      verifyMigrationManifest();
      for (const entry of MIGRATION_MANIFEST) console.log(`${entry.sha256}  ${entry.id}.sql`);
      console.log(`${LOCAL_PARITY_FIXTURE.sha256}  (local-only) ${LOCAL_PARITY_FIXTURE.id}.sql`);
      return 0;
    }
    case 'start': {
      const profile = parseProfile(rest);
      const result = runSupabase(['start'], stageProfile(profile));
      if (result.status !== 0) return result.status;
      verifyAppliedProfile(profile);
      writeLocalEnvironment(profile);
      return 0;
    }
    case 'reset': {
      const profile = parseProfile(rest);
      const result = runSupabase(['db', 'reset', '--local', '--no-seed'], stageProfile(profile));
      if (result.status !== 0) return result.status;
      console.log(`Applied profile ${profile}: ${verifyAppliedProfile(profile).join(', ')}`);
      writeLocalEnvironment(profile);
      return 0;
    }
    case 'seed':
      return seedLocal();
    case 'digest': {
      for (const [table, digest] of Object.entries(localDataDigests())) console.log(`${digest}  ${table}`);
      return 0;
    }
    case 'bootstrap': {
      // start (from stopped) -> reset to the canonical profile -> deterministic seed.
      const profile = parseProfile(rest);
      let status = runSupabase(['start'], stageProfile(profile)).status;
      if (status !== 0) return status;
      status = main(['reset', '--profile', profile]);
      if (status !== 0) return status;
      return seedLocal();
    }
    case 'acceptance': {
      // Normal storage acceptance path: start local stack -> reset + deterministic seed (digest-checked) -> full PG suite
      // (integration, concurrency, authority/permission, migration/bridge/reapply). Fails loudly; never touches hosted.
      const profile = parseProfile(rest);
      const started = runSupabase(['start'], stageProfile(profile)).status;
      if (started !== 0) return started;
      const checked = main(['seed-check', '--profile', profile]);
      if (checked !== 0) return checked;
      return main(['test', ...rest]);
    }
    case 'seed-check': {
      // Two resets + seeds must yield identical per-table row digests.
      const profile = parseProfile(rest);
      const runs: Record<string, string>[] = [];
      for (let i = 0; i < 2; i++) {
        let status = main(['reset', '--profile', profile]);
        if (status === 0) status = seedLocal();
        if (status !== 0) return status;
        runs.push(localDataDigests());
      }
      const keys = new Set([...Object.keys(runs[0]), ...Object.keys(runs[1])]);
      const diff = [...keys].filter((key) => runs[0][key] !== runs[1][key]);
      if (diff.length) { console.error(`Seed is NOT deterministic; differing tables: ${diff.join(', ')}`); return 1; }
      console.log(`Seed deterministic: ${keys.size} tables, identical digests across two resets.`);
      return 0;
    }
    case 'verify': {
      const profile = parseProfile(rest);
      console.log(`Profile ${profile} fully applied: ${verifyAppliedProfile(profile).join(', ')}`);
      return 0;
    }
    case 'env': {
      writeLocalEnvironment(parseProfile(rest));
      return 0;
    }
    case 'status':
      return runSupabase(['status'], stageProfile(parseProfile(rest))).status;
    case 'stop':
      return runSupabase(['stop'], stageProfile(parseProfile(rest))).status;
    case 'test': {
      if (!existsSync(LOCAL_ENV_FILE)) throw new Error('Run `npm run db:local:reset` first; .local/supabase-local.env is missing.');
      const vitestArgs = rest.filter((arg, index) => arg !== '--profile' && rest[index - 1] !== '--profile');
      const result = spawnSync(process.execPath, [join(REPOSITORY_ROOT, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--config', 'vitest.pg.config.ts', ...vitestArgs], {
        cwd: REPOSITORY_ROOT, stdio: 'inherit', windowsHide: true,
        env: { ...sanitizedEnvironment(), BIZTANIA_PG_TESTS: '1' },
      });
      return result.status ?? 1;
    }
    default:
      console.log('Usage: node --import tsx scripts/local-supabase.ts <manifest|start|reset|seed|digest|bootstrap|seed-check|acceptance|verify|env|status|stop|test> [--profile fresh|hosted-v1|v2-proof]');
      return command === 'help' ? 0 : 1;
  }
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invoked === import.meta.url) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(redact(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}
