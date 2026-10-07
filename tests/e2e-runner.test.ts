import { ChildProcess, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createPlan, formatPlan, parseArgs, playwrightInvocation, type Shard } from '../scripts/e2e/plan.mjs';
import { aggregateShard, executeShards, type ChildResult } from '../scripts/e2e/aggregate.mjs';
import { groups, specEnvironment, workflowV2Specs } from '../scripts/e2e/spec-map.mjs';
import { runProcess } from '../scripts/e2e/process.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const inventory = readdirSync(new URL('e2e/', import.meta.url)).filter(name => name.endsWith('.spec.ts')).sort().map(name => `tests/e2e/${name}`);
const plan = (args = ['--full'], paths: string[] = [], specs = inventory) => createPlan(parseArgs(args), specs, { changedPaths: paths, root, tempRoot: root });
const healthy: ChildResult = { code: 0, startupOk: true, cleanup: { ok: true } };
const reportFor = (shard: Shard, status = 'passed', outcome = 'expected') => JSON.stringify({
  errors: [], stats: { duration: 120, expected: outcome === 'expected' ? shard.specs.length : 0,
    unexpected: outcome === 'unexpected' ? shard.specs.length : 0, skipped: outcome === 'skipped' ? shard.specs.length : 0, flaky: 0 },
  suites: [{ title: 'file suite', specs: shard.specs.map(file => ({ file: file.replace('tests/e2e/', ''), title: `test ${file}`,
    tests: [{ status: outcome, results: [{ status, attachments: status === 'passed' ? [] : [{ name: 'trace', path: 'shard/trace.zip' }] }] }] })) }],
});
const focused = () => plan(['--group', 'A', '--shards', '1']);
const impact = (path: string) => plan(['--changed-from', 'base'], [path]);

describe('E2E planning', () => {
  it('actual --list --full CLI gate prints the inventory and creates no artifacts', async () => {
    const directory = join(root, 'test-results/e2e-shards/plan'), existed = existsSync(directory);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const runner = await import(new URL('../scripts/run-e2e-isolated.mjs', import.meta.url).href);
    expect(await runner.main(['--list', '--full'])).toBe(0);
    expect(log.mock.calls[0][0].split('\n').filter((line: string) => line.startsWith('SELECT '))).toEqual(inventory.map(path => `SELECT ${path}`));
    expect(existsSync(directory)).toBe(existed);
  });
  it('--list --full selects every real spec exactly once', () => {
    const result = plan(['--list', '--full']);
    expect(result.selected).toEqual(inventory);
    expect(formatPlan(result).split('\n').filter(line => line.startsWith('SELECT '))).toEqual(inventory.map(path => `SELECT ${path}`));
    expect(result.skipped).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.authority).toBe('release-authoritative');
    expect(result.flagProfile).toBe('on');
  });
  it('each current spec belongs to exactly one group and one execution shard', () => {
    expect(Object.values(groups).flat().sort()).toEqual(inventory.map(path => path.replace('tests/e2e/', '').replace('.spec.ts', '')).sort());
    const assigned = plan().shards.flatMap(shard => shard.specs).sort();
    expect(assigned).toEqual(inventory);
    expect(new Set(assigned).size).toBe(inventory.length);
  });
  it('only the Director spec runs on a Workflow V2 server (explicit per spec, never inherited); every other spec stays on V1', () => {
    expect(workflowV2Specs).toEqual(['director-flows']);
    for (const path of inventory) expect(specEnvironment(path)).toEqual({ WORKFLOW_V2_ENABLED: path.endsWith('/director-flows.spec.ts') ? 'true' : 'false' });
    // The runner layers this over each unit's env (after the shared env), so the flag cannot leak from the caller's shell.
    expect(readFileSync(`${root}/scripts/run-e2e-isolated.mjs`, 'utf8')).toContain('...specEnvironment(spec)');
  });
  it('plan-only output does not claim run-time ports or a shared DB', () => {
    const text = formatPlan(createPlan(parseArgs(['--full']), inventory, { root, tempRoot: root }));
    expect(text).toContain('ports=allocated at run time');
    expect(text).not.toContain('43000');
  });
  it('four shards have distinct ports, DBs, outputs, trace, report and log paths', () => {
    const result = plan();
    expect(result.shards).toHaveLength(4);
    for (const key of ['port', 'dbPath', 'outputDir', 'traceDir', 'reportDir', 'logDir', 'jsonPath'] as const) expect(new Set(result.shards.map(shard => shard[key])).size).toBe(4);
    expect(Math.max(...result.shards.map(shard => shard.estimatedSeconds)) - Math.min(...result.shards.map(shard => shard.estimatedSeconds))).toBeLessThan(15);
  });
  it('one shard creates one Playwright argv with multiple spec paths', async () => {
    const selected = focused(), calls: string[][] = [];
    const result = await executeShards(selected, {
      runChild: async shard => { calls.push(playwrightInvocation('playwright-cli', shard)); return healthy; },
      readResult: reportFor,
    });
    expect(calls).toEqual([['playwright-cli', 'test', '--workers=1', '--retries=0', ...selected.shards[0].specs]]);
    expect(calls[0].length).toBeGreaterThan(5);
    expect(result.exitCode).toBe(0);
  });
  it('docs-only diff selects zero specs and explains every skipped spec', () => {
    const result = plan(['--changed-from', 'base'], ['docs/architecture.ts', 'README.md']);
    expect(result.selected).toEqual([]); expect(result.shards).toEqual([]);
    expect(result.skipped).toHaveLength(inventory.length);
    expect(result.skipped.every(item => item.reason === 'docs-only diff: no E2E impact')).toBe(true);
  });
  it('dynamic changes select B+D', () => expect(impact('lib/dynamic/runtime.ts').selected).toEqual([...plan(['--group', 'B']).selected, ...plan(['--group', 'D']).selected].sort()));
  it('demo changes select D+C', () => expect(impact('lib/demo/showcase.ts').selected).toEqual([...plan(['--group', 'D']).selected, ...plan(['--group', 'C']).selected].sort()));
  it('core service changes select FULL but remain focused authority', () => {
    expect(impact('lib/core/service.ts').selected).toEqual(inventory);
    expect(impact('lib/core/service.ts').authority).toBe('focused');
  });
  it('unknown source selects FULL rather than silently zero', () => expect(impact('lib/new-module.ts').selected).toEqual(inventory));
  it.each(['lib/ai/run.ts', 'components/demo-guide.tsx', 'lib/core/pending-action-policy.ts', 'lib/core/action-revision.ts'])('selects the declared groups for %s', path => {
    const expected = path.startsWith('lib/ai/') ? ['B', 'D'] : path.startsWith('components/') ? ['C', 'D'] : ['A'];
    expect(impact(path).selected).toEqual(expected.flatMap(group => plan(['--group', group]).selected).sort());
  });
  it.each(['lib/contracts.ts', 'lib/server/runtime.ts', 'lib/storage/db.ts', 'supabase/schema.sql', 'migrations/001.sql', 'app/globals.css', 'app/layout.tsx', 'middleware.ts', 'proxy.ts', 'playwright.config.ts', 'scripts/run-e2e-isolated.mjs', 'scripts/e2e/plan.mjs', 'package.json', 'package-lock.json', 'next.config.ts', 'tests/e2e/database-path.ts'])('fail-safe shared path %s selects FULL', path => expect(impact(path).selected).toEqual(inventory));
  it('spec changes select that spec and explicit repeat specs deduplicate', () => {
    expect(impact(inventory[0]).selected).toEqual([inventory[0]]);
    expect(plan(['--spec', inventory[0], '--spec', inventory[1], '--spec', inventory[0]]).selected).toEqual(inventory.slice(0, 2));
  });
  it('unmapped specs warn loudly and get a deterministic fallback shard', () => {
    const extra = 'tests/e2e/future.spec.ts', all = [...inventory, extra];
    const result = plan(['--full'], [], all);
    expect(result.warnings[0]).toContain(`WARNING: unmapped spec ${extra}`);
    expect(result.shards.flatMap(shard => shard.specs).filter(path => path === extra)).toEqual([extra]);
    expect(result).toEqual(plan(['--full'], [], all.reverse()));
  });
  it('rejects invalid CLI selections, unknown specs, profiles and shard counts', () => {
    for (const args of [['--full', '--group', 'A'], ['--shards', '0'], ['--shards', '2.5'], ['--flag-profile', 'yes'], ['--group', 'X'], ['--wat'], ['--spec']]) expect(() => plan(args)).toThrow();
    expect(() => plan(['--spec', 'tests/e2e/absent.spec.ts'])).toThrow('Unknown spec');
    expect(plan(['--list', '--group', 'A', '--flag-profile', 'shadow']).flagProfile).toBe('shadow');
  });
  it('contains no temporary scratch-file references in runner infrastructure', () => {
    const paths = ['scripts/run-e2e-isolated.mjs', 'playwright.config.ts', ...readdirSync(`${root}/scripts/e2e`).filter(name => !name.endsWith('.md')).map(name => `scripts/e2e/${name}`)];
    for (const path of paths) expect(readFileSync(`${root}/${path}`, 'utf8')).not.toMatch(/zz-[\w.-]+/);
  });
});

describe('truthful aggregation through injected children', () => {
  const run = (child: ChildResult, result?: (shard: Shard) => string | undefined) => executeShards(focused(), {
    runChild: async () => child, readResult: result ?? reportFor,
  });
  it('failing child yields nonzero overall even with a passing report', async () => expect((await run({ ...healthy, code: 1 })).exitCode).toBe(1));
  it('missing JSON yields nonzero overall even when child exits zero', async () => expect((await run(healthy, () => undefined)).exitCode).toBe(1));
  it('corrupt JSON fails', async () => expect((await run(healthy, () => '{broken')).exitCode).toBe(1));
  it('interrupted JSON fails', async () => {
    const result = await run(healthy, shard => reportFor(shard, 'interrupted', 'unexpected'));
    expect(result.exitCode).toBe(1); expect(result.interrupted).toBe(4);
  });
  it('interrupted stats fail even if leaf results look passed', async () => {
    const result = await run(healthy, shard => {
      const report = JSON.parse(reportFor(shard)); report.stats.interrupted = 1; return JSON.stringify(report);
    });
    expect(result.exitCode).toBe(1);
  });
  it.each(['SIGINT', 'SIGTERM', 'SIGKILL'])('signal termination %s fails', async signal => expect((await run({ ...healthy, signal })).exitCode).toBe(1));
  it('unverified cleanup and startup fail', async () => {
    expect((await run({ ...healthy, cleanup: { ok: false } })).exitCode).toBe(1);
    expect((await run({ ...healthy, startupOk: false })).exitCode).toBe(1);
  });
  it('failed and timedOut results fail and include test titles with trace paths', async () => {
    for (const status of ['failed', 'timedOut']) {
      const result = await run(healthy, shard => reportFor(shard, status, 'unexpected'));
      expect(result.exitCode).toBe(1); expect(result.failed).toBe(4);
      expect(result.shards[0].failures[0].title).toContain('test tests/e2e/');
      expect(result.shards[0].failures[0].traces).toEqual(['shard/trace.zip']);
    }
  });
  it('missing spec or global reporter error fails', () => {
    const shard = focused().shards[0], report = JSON.parse(reportFor(shard));
    report.suites[0].specs.pop(); report.stats.expected--;
    expect(aggregateShard(shard, healthy, JSON.stringify(report)).ok).toBe(false);
    report.errors = [{ message: 'server error' }];
    expect(aggregateShard(shard, healthy, JSON.stringify(report)).ok).toBe(false);
  });
  it('runs shards concurrently and waits for every child before success', async () => {
    const selected = plan(), started: string[] = [], release: (() => void)[] = [];
    const promise = executeShards(selected, { runChild: shard => {
      started.push(shard.id); return new Promise(resolve => release.push(() => resolve(healthy)));
    }, readResult: reportFor });
    expect(started).toHaveLength(4);
    release.forEach(done => done());
    const result = await promise;
    expect(result.exitCode).toBe(0); expect(result.specs).toBe(inventory.length); expect(result.passed).toBe(inventory.length);
  });
});

describe('spawn boundary without launching processes', () => {
  it.each([{ code: 1, signal: null }, { code: null, signal: 'SIGTERM' }])('observes real close-event failure $code/$signal', async outcome => {
    mkdirSync(join(root, 'test-results'), { recursive: true });
    const directory = mkdtempSync(join(root, 'test-results/e2e-runner-unit-'));
    try {
      const fake = new ChildProcess();
      const shard = focused().shards[0];
      const args = playwrightInvocation('playwright-cli', shard);
      let observedArgs: readonly string[] | undefined;
      const resultPromise = runProcess(args, { cwd: root, env: { NODE_ENV: 'test' }, logPath: join(directory, 'child.log'),
        spawnChild: (_file, argv) => { observedArgs = argv; return fake; },
      });
      fake.emit('close', outcome.code, outcome.signal);
      const child = await resultPromise;
      expect(observedArgs).toEqual(args);
      expect(aggregateShard(shard, { ...child, startupOk: true }, reportFor(shard)).ok).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('a spawn error fails aggregation even if JSON falsely says passed', async () => {
    mkdirSync(join(root, 'test-results'), { recursive: true });
    const directory = mkdtempSync(join(root, 'test-results/e2e-runner-unit-'));
    try {
      const fake = new ChildProcess(), shard = focused().shards[0];
      const resultPromise = runProcess(playwrightInvocation('cli', shard), { cwd: root, env: { NODE_ENV: 'test' }, logPath: join(directory, 'child.log'), spawnChild: () => fake });
      fake.emit('error', new Error('spawn denied'));
      const child = await resultPromise;
      expect(child.error).toBe('spawn denied');
      expect(aggregateShard(shard, { ...child, startupOk: true }, reportFor(shard)).ok).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

describe('template seed shutdown', () => {
  // Regression: the seed script force-kills its healthy server once the template DB is seeded. On Windows that kill
  // exits with code 1, and when the wrapper records it first the runner rejected a fully seeded template as a crash.
  it('a server stopped on purpose after a ready warm-up is not reported as a crashed startup', async () => {
    mkdirSync(join(root, 'test-results'), { recursive: true });
    const directory = mkdtempSync(join(root, 'test-results/e2e-seed-stop-'));
    try {
      const exitedPid = () => spawnSync(process.execPath, ['-e', '']).pid!;
      const serverStatePath = join(directory, 'server.json');
      writeFileSync(serverStatePath, JSON.stringify({ pid: exitedPid(), wrapperPid: exitedPid(), startupOk: true, closed: true, code: 1, signal: null }));
      const runner = await import(new URL('../scripts/run-e2e-isolated.mjs', import.meta.url).href);
      const stopped = await runner.cleanupServer({ serverStatePath }, { stoppedOnPurpose: true });
      expect(stopped.startupOk).toBe(true);
      expect(stopped.cleanup.ok).toBe(true);
      // Without that knowledge the same recorded exit still counts as a crash (spec servers that die mid-run).
      expect((await runner.cleanupServer({ serverStatePath })).startupOk).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
