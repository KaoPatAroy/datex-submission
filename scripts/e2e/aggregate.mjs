const emptyCounts = () => ({ tests: 0, passed: 0, failed: 0, flaky: 0, skipped: 0, interrupted: 0, timedOut: 0 });
const integer = value => Number.isInteger(value) && value >= 0;

// Only structured reporter data and observed child/cleanup state can establish success.
export function aggregateShard(shard, child, jsonText) {
  const counts = emptyCounts(), problems = [], failures = [], files = new Set();
  if (child.code !== 0 || child.error || child.signal || child.terminationSignal || child.timedOut) problems.push('child did not exit cleanly with code 0');
  if (child.startupOk !== true) problems.push('server startup unverified/failed');
  if (child.cleanup?.ok !== true) problems.push('process cleanup unverified/failed');
  let report;
  try {
    if (typeof jsonText !== 'string') throw new Error('missing JSON');
    report = JSON.parse(jsonText);
    if (!report || !Array.isArray(report.suites) || !Array.isArray(report.errors)
      || !report.stats || !['expected', 'unexpected', 'flaky', 'skipped'].every(key => integer(report.stats[key]))
      || !Number.isFinite(report.stats.duration) || report.stats.duration < 0) throw new Error('invalid JSON schema');
    if (report.errors.length) problems.push(`reporter errors: ${report.errors.length}`);
    for (const key of ['interrupted', 'timedOut', 'failed']) {
      if (report.stats[key] !== undefined && (!integer(report.stats[key]) || report.stats[key] > 0)) problems.push(`reporter stats ${key}=${report.stats[key]}`);
    }
    const visit = (suites, titles = []) => {
      for (const suite of suites) {
        if (!suite || (suite.suites !== undefined && !Array.isArray(suite.suites)) || !Array.isArray(suite.specs)) throw new Error('invalid suite');
        for (const spec of suite.specs) {
          if (!Array.isArray(spec.tests) || !spec.tests.length || typeof spec.file !== 'string') throw new Error('invalid spec');
          files.add(spec.file.replaceAll('\\', '/').replace(/^.*tests\/e2e\//, ''));
          for (const test of spec.tests) {
            const countKey = { expected: 'passed', unexpected: 'failed', flaky: 'flaky', skipped: 'skipped' }[test.status];
            if (!countKey || !Array.isArray(test.results) || (!test.results.length && test.status !== 'skipped')) throw new Error('invalid test result');
            counts.tests++;
            counts[countKey]++;
            let bad = test.status === 'unexpected';
            for (const result of test.results) {
              if (!['passed', 'failed', 'skipped', 'timedOut', 'interrupted'].includes(result.status)) throw new Error('invalid result status');
              if (result.status === 'interrupted') counts.interrupted++;
              if (result.status === 'timedOut') counts.timedOut++;
              if (['failed', 'timedOut', 'interrupted'].includes(result.status)) bad = true;
            }
            if (bad) failures.push({ title: [...titles, suite.title, spec.title, test.projectName].filter(Boolean).join(' > '),
              traces: test.results.flatMap(result => (result.attachments ?? []).filter(item => item.name === 'trace' && item.path).map(item => item.path)) });
          }
        }
        visit(suite.suites ?? [], [...titles, suite.title].filter(Boolean));
      }
    };
    visit(report.suites);
    if (!counts.tests) problems.push('report contains zero tests');
    if (counts.passed !== report.stats.expected || counts.failed !== report.stats.unexpected
      || counts.flaky !== report.stats.flaky || counts.skipped !== report.stats.skipped) problems.push('report stats disagree with test results');
    for (const path of shard.specs) if (!files.has(path.replace(/^tests\/e2e\//, ''))) problems.push(`spec missing from report: ${path}`);
    for (const file of files) if (!shard.specs.some(path => path.replace(/^tests\/e2e\//, '') === file)) problems.push(`unexpected spec in report: ${file}`);
    if (failures.length || counts.failed || counts.interrupted || counts.timedOut) problems.push('failed, interrupted or timed-out tests');
  } catch (error) { problems.push(`results JSON missing/corrupt: ${error.message}`); }
  return { id: shard.id, ok: problems.length === 0, code: child.code ?? null, signal: child.signal ?? null,
    durationMs: report?.stats?.duration ?? child.durationMs ?? 0, counts, failures, problems,
    cleanup: child.cleanup ?? { ok: false }, jsonPath: shard.jsonPath };
}

export function aggregateRun(plan, results) {
  const counts = emptyCounts();
  for (const result of results) for (const key of Object.keys(counts)) counts[key] += result.counts[key];
  const ok = results.length === plan.shards.length && plan.shards.every(shard => results.filter(result => result.id === shard.id && result.ok).length === 1);
  return { ok, exitCode: ok ? 0 : 1, authority: plan.authority, flagProfile: plan.flagProfile,
    specs: plan.selected.length, ...counts, shards: results };
}

export async function executeShards(plan, { runChild, readResult }) {
  const results = await Promise.all(plan.shards.map(async shard => {
    let child;
    try { child = await runChild(shard); }
    catch (error) { child = { error: String(error), cleanup: { ok: false } }; }
    let json;
    try { json = await readResult(shard); } catch { /* Missing result must fail aggregation. */ }
    return aggregateShard(shard, child, json);
  }));
  return aggregateRun(plan, results);
}
