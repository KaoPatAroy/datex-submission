import { execFileSync } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, constants } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPlan, formatPlan, parseArgs, playwrightInvocation } from './e2e/plan.mjs';
import { executeShards } from './e2e/aggregate.mjs';
import { specEnvironment } from './e2e/spec-map.mjs';

// Per-run session signing secret: local servers only, never a committed literal.
const RUN_SESSION_SECRET = randomBytes(32).toString('hex');
// Per-run proof for the scripted planner under a production build (NODE_ENV=production + NEXUS_E2E_RUNNER alone is not enough).
const RUN_E2E_TOKEN = randomBytes(24).toString('hex');
import { isAlive, killTree, runProcess } from './e2e/process.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const git = args => execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8', windowsHide: true });

export function toPlaywrightSpecArgument(path) { return relative(projectRoot, path).split(sep).join('/'); }
export function discoverSpecFiles() {
  return readdirSync(join(projectRoot, 'tests/e2e'), { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.spec.ts'))
    .map(entry => `tests/e2e/${entry.name}`).sort();
}
export function findAvailablePort(port = 0) {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const selected = server.address().port;
      server.close(error => error ? reject(error) : resolvePort(selected));
    });
  });
}
export async function allocateDistinctPort(usedPorts, discoverPort = findAvailablePort) {
  for (let i = 0; i < 64; i++) {
    const port = await discoverPort();
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`Invalid allocated E2E port: ${port}`);
    if (!usedPorts.has(port)) { usedPorts.add(port); return port; }
  }
  throw new Error('Unable to allocate a distinct E2E port.');
}
export function changedPaths(ref) {
  const commit = git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim();
  return [...new Set([
    ...git(['diff', '--name-only', '-z', `${commit}...HEAD`, '--']).split('\0'),
    ...git(['diff', '--name-only', '-z', 'HEAD', '--']).split('\0'),
    ...git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0'),
  ].filter(Boolean))];
}
function snapshot() {
  const paths = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean).sort();
  const digest = createHash('sha256');
  for (const path of paths) {
    digest.update(path).update('\0');
    digest.update(existsSync(join(projectRoot, path)) ? readFileSync(join(projectRoot, path)) : '<deleted>');
    digest.update('\0');
  }
  return { sha: git(['rev-parse', 'HEAD']).trim(), tree: git(['rev-parse', 'HEAD^{tree}']).trim(),
    dirty: git(['status', '--porcelain']).trim().length > 0, workingTreeDigest: digest.digest('hex') };
}
function readJSON(path) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; } }
function runnerEnv(plan, shard) {
  const env = { ...process.env };
  delete env.TEST_WORKER_INDEX;
  return { ...env, NODE_ENV: 'production', NEXUS_E2E_RUNNER: '1', NEXUS_E2E_RUN_TOKEN: RUN_E2E_TOKEN, NEXUS_E2E_PORT: String(shard.port), NEXUS_E2E_INNER_PORT: String(shard.innerPort ?? ''),
    NEXUS_E2E_DB_PATH: shard.dbPath, DB_PATH: shard.dbPath, AI_PROVIDER: 'scripted',
    DEMO_ACCESS_CODE: 'nexus-test-access', DEMO_SESSION_SECRET: RUN_SESSION_SECRET,
    DEMO_LOGIN_REQUEST_LIMIT: '256', DEMO_BUSINESS_DATE: '2026-10-01', USE_LOCAL_DEMO_DATA: 'true',
    BIZTANIA_DYNAMIC_QUERY: plan.flagProfile, NEXUS_E2E_JSON_PATH: shard.jsonPath,
    NEXUS_E2E_OUTPUT_DIR: shard.outputDir, NEXUS_E2E_SERVER_STATE: shard.serverStatePath,
    NEXUS_E2E_SERVER_COMMAND: `"${process.execPath}" "${join(projectRoot, 'scripts/e2e/server.mjs')}"` };
}
// stoppedOnPurpose: the caller killed a healthy server itself (the template seed). A forced kill exits with code 1
// on Windows (taskkill /F), and the wrapper records it whenever the child dies first, so that code is not a crash.
export async function cleanupServer(shard, { stoppedOnPurpose = false } = {}) {
  const state = readJSON(shard.serverStatePath), statuses = [];
  let ok = Boolean(state?.pid && state?.wrapperPid);
  for (const pid of [state?.pid, state?.wrapperPid].filter(Boolean)) {
    const status = await killTree(pid).catch(error => ({ ok: false, status: error.message }));
    statuses.push({ pid, ...status }); ok &&= status.ok;
  }
  for (const port of [shard.port, shard.innerPort].filter(Boolean)) try { await findAvailablePort(port); } catch { ok = false; }
  for (const pid of [state?.pid, state?.wrapperPid].filter(Boolean)) if (isAlive(pid)) ok = false;
  return { startupOk: state?.startupOk === true && !state.error && (stoppedOnPurpose || !(typeof state.code === 'number' && state.code !== 0)), cleanup: { ok, statuses,
    status: ok ? 'server PIDs gone; port free' : 'server tree cleanup unverified' } };
}
function archiveTraces(shard) {
  const report = readJSON(shard.jsonPath);
  if (!report) return;
  let index = 0;
  const visit = suites => {
    for (const suite of suites ?? []) {
      for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) for (const result of test.results ?? []) {
        for (const attachment of result.attachments ?? []) if (attachment.name === 'trace' && attachment.path) {
          const source = resolve(attachment.path), rel = relative(shard.outputDir, source);
          if (rel.startsWith('..') || resolve(shard.outputDir, rel) !== source) throw new Error('Trace path outside shard output.');
          const target = join(shard.traceDir, `${basename(shard.outputDir)}-trace-${++index}.zip`);
          copyFileSync(source, target); attachment.path = target;
        }
      }
      visit(suite.suites);
    }
  };
  visit(report.suites);
  writeFileSync(shard.jsonPath, JSON.stringify(report, null, 2));
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  const plan = createPlan(options, discoverSpecFiles(), { root: projectRoot, tempRoot: tmpdir(),
    runId: options.list ? 'plan' : randomUUID(), changedPaths: options.mode === 'changed' ? changedPaths(options.ref) : [] });
  console.log(formatPlan(plan));
  if (options.list) return 0;
  if (!plan.selected.length) { console.log('Focused run: no impacted specs.'); return 0; }
  const metadata = snapshot(); // Fail before claiming any resource if Git is unavailable.
  const runRoot = dirname(dirname(plan.shards[0].outputDir));
  const lockPath = join(projectRoot, 'test-results/e2e-runner.lock');
  mkdirSync(dirname(lockPath), { recursive: true });
  const lock = openSync(lockPath, 'wx');
  writeFileSync(lock, JSON.stringify({ pid: process.pid, runRoot }));
  const controller = new AbortController();
  const onInt = () => controller.abort('SIGINT'), onTerm = () => controller.abort('SIGTERM');
  process.once('SIGINT', onInt); process.once('SIGTERM', onTerm);
  const ownedDatabases = [];
  let report;
  try {
    mkdirSync(runRoot, { recursive: true });
    const usedPorts = new Set();
    for (const shard of plan.shards) {
      shard.port = await allocateDistinctPort(usedPorts);
      shard.innerPort = await allocateDistinctPort(usedPorts); shard.portAllocated = true;
      for (const path of [shard.outputDir, shard.traceDir, shard.reportDir, shard.logDir]) mkdirSync(path, { recursive: true });
      closeSync(openSync(shard.dbPath, 'wx')); ownedDatabases.push(shard.dbPath);
    }
    const buildDB = join(tmpdir(), `nexus-playwright-${randomUUID()}.sqlite`);
    closeSync(openSync(buildDB, 'wx')); ownedDatabases.push(buildDB);
    console.log(`Building once; logs: ${join(runRoot, 'build.log')}`);
    const build = await runProcess([require.resolve('next/dist/bin/next'), 'build'], { cwd: projectRoot,
      env: runnerEnv(plan, { ...plan.shards[0], dbPath: buildDB }), logPath: join(runRoot, 'build.log'),
      signal: controller.signal, timeoutMs: 300_000 });
    if (build.code !== 0 || build.signal || build.terminationSignal || build.timedOut || !build.cleanup.ok) throw new Error('Next build failed/interrupted; see build.log.');
    const buildID = readFileSync(join(projectRoot, '.next/BUILD_ID'), 'utf8').trim();
    if (!buildID || JSON.stringify(metadata) !== JSON.stringify(snapshot())) throw new Error('Source snapshot changed during build; rebuild on a stable tree.');
    writeFileSync(join(runRoot, 'build.json'), JSON.stringify({ ...metadata, buildID, flagProfile: plan.flagProfile }, null, 2));
    // Seed once: the first store access takes ~15 s; per-spec DBs are byte copies of this seeded template.
    const seedDir = join(runRoot, 'seed'); mkdirSync(seedDir, { recursive: true });
    const templateDB = join(tmpdir(), `nexus-playwright-${randomUUID()}.sqlite`);
    closeSync(openSync(templateDB, 'wx')); ownedDatabases.push(templateDB);
    const seed = { ...plan.shards[0], dbPath: templateDB, serverStatePath: join(seedDir, 'server.json') };
    const seeded = await runProcess([join(projectRoot, 'scripts/e2e/seed-template.mjs')], { cwd: projectRoot,
      env: runnerEnv(plan, seed), logPath: join(seedDir, 'seed.log'), signal: controller.signal, timeoutMs: 240_000 });
    const seedServer = await cleanupServer(seed, { stoppedOnPurpose: true });
    if (seeded.code !== 0 || !seedServer.startupOk || !seedServer.cleanup.ok || statSync(templateDB).size === 0) throw new Error('Template DB seeding failed; see seed/seed.log.');
    console.log(formatPlan(plan));
    report = await executeShards(plan, {
      // Each spec file gets its own fresh DB, `next start` server and Playwright process (specs assume a fresh seeded DB);
      // specs of one shard run sequentially on the shard's two ports, shards run concurrently.
      runChild: async shard => {
        const merged = { code: 0, startupOk: true, cleanup: { ok: true, statuses: [] }, durationMs: 0 };
        shard.units = [];
        for (const [index, spec] of shard.specs.entries()) {
          const unit = { ...shard, specs: [spec], dbPath: join(tmpdir(), `nexus-playwright-${randomUUID()}.sqlite`),
            outputDir: join(shard.outputDir, `spec-${index + 1}`), jsonPath: join(shard.reportDir, `spec-${index + 1}.json`),
            serverStatePath: join(shard.reportDir, `server-${index + 1}.json`), logPath: join(shard.logDir, `spec-${index + 1}.log`) };
          shard.units.push(unit);
          let child;
          try {
            if (controller.signal.aborted) throw new Error(`aborted: ${String(controller.signal.reason)}`);
            mkdirSync(unit.outputDir, { recursive: true });
            ownedDatabases.push(unit.dbPath);
            for (const suffix of ['', '-wal']) if (existsSync(`${templateDB}${suffix}`)) copyFileSync(`${templateDB}${suffix}`, `${unit.dbPath}${suffix}`, constants.COPYFILE_EXCL);
            await findAvailablePort(unit.port); await findAvailablePort(unit.innerPort);
            child = await runProcess(playwrightInvocation(require.resolve('@playwright/test/cli'), unit), {
              cwd: projectRoot, env: { ...runnerEnv(plan, unit), ...specEnvironment(spec) }, logPath: unit.logPath, signal: controller.signal,
            });
          } catch (error) { child = { error: error.message, cleanup: { ok: false } }; }
          const server = await cleanupServer(unit);
          merged.code ||= child.code ?? 1;
          for (const key of ['error', 'signal', 'terminationSignal', 'timedOut']) if (child[key]) merged[key] ||= child[key];
          merged.startupOk &&= server.startupOk;
          merged.cleanup.ok &&= Boolean(child.cleanup?.ok) && server.cleanup.ok;
          merged.cleanup.statuses.push(...server.cleanup.statuses);
        }
        merged.cleanup.status = merged.cleanup.ok ? 'server PIDs gone; ports free' : 'server tree cleanup unverified';
        return merged;
      },
      readResult: shard => {
        const reports = shard.units.map(unit => { archiveTraces(unit); return JSON.parse(readFileSync(unit.jsonPath, 'utf8')); });
        const stats = { expected: 0, unexpected: 0, flaky: 0, skipped: 0, duration: 0 };
        for (const report of reports) for (const key of Object.keys(stats)) stats[key] += report.stats[key];
        if (reports.length !== shard.specs.length) throw new Error('missing per-spec report');
        // archiveTraces rewrote attachment paths to this shard's trace dir per unit; renumber would collide, so copy names are per unit.
        const combined = { ...reports[0], suites: reports.flatMap(r => r.suites), errors: reports.flatMap(r => r.errors), stats };
        writeFileSync(shard.jsonPath, JSON.stringify(combined, null, 2));
        return JSON.stringify(combined);
      },
    });
    report.git = metadata; report.buildID = buildID;
    if (controller.signal.aborted) { report.ok = false; report.exitCode = 1; report.terminationSignal = String(controller.signal.reason); }
    if (JSON.stringify(metadata) !== JSON.stringify(snapshot()) || readFileSync(join(projectRoot, '.next/BUILD_ID'), 'utf8').trim() !== buildID) {
      report.ok = false; report.exitCode = 1; report.snapshotError = 'Source/build changed during run.';
    }
  } catch (error) {
    report = { authority: plan.authority, flagProfile: plan.flagProfile,
      specs: plan.selected.length, tests: 0, passed: 0, failed: 0, flaky: 0, skipped: 0, interrupted: 0, timedOut: 0,
      shards: [], ...report, ok: false, exitCode: 1, error: error.message, git: metadata };
  } finally {
    const cleanup = [];
    for (const shard of plan.shards) for (const unit of shard.units ?? []) if (existsSync(unit.serverStatePath)) cleanup.push({ id: shard.id, ...await cleanupServer(unit) });
    for (const path of ownedDatabases) {
      try { for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true }); }
      catch (error) { cleanup.push({ database: path, cleanup: { ok: false, status: error.message } }); }
    }
    if (cleanup.some(item => !item.cleanup.ok)) { report.ok = false; report.exitCode = 1; }
    report.finalCleanup = cleanup;
    process.off('SIGINT', onInt); process.off('SIGTERM', onTerm);
    closeSync(lock); rmSync(lockPath);
  }
  writeFileSync(join(runRoot, 'summary.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  return report.exitCode;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
