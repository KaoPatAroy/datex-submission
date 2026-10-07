import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { groupFor, groups, seconds, specName } from './spec-map.mjs';

export function parseArgs(args) {
  const options = { mode: 'full', list: false, shards: 4, flagProfile: 'on', specs: [] };
  let selected;
  const select = mode => {
    if (selected && !(selected === 'spec' && mode === 'spec')) throw new Error('Choose exactly one of --full, --changed-from, --group, --spec.');
    options.mode = selected = mode;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = () => {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${arg}.`);
      return args[++i];
    };
    if (arg === '--list') options.list = true;
    else if (arg === '--full') select('full');
    else if (arg === '--changed-from') { select('changed'); options.ref = value(); }
    else if (arg === '--group') { select('group'); options.group = value().toUpperCase(); }
    else if (arg === '--spec') { select('spec'); options.specs.push(value().replaceAll('\\', '/').replace(/^\.\//, '')); }
    else if (arg === '--shards') options.shards = Number(value());
    else if (arg === '--flag-profile') options.flagProfile = value();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.shards) || options.shards < 1 || options.shards > 16) throw new Error('--shards must be an integer from 1 to 16.');
  if (!['on', 'off', 'shadow'].includes(options.flagProfile)) throw new Error('--flag-profile must be on, off or shadow.');
  if (options.mode === 'group' && !groups[options.group]) throw new Error('Unknown group; choose A, B, C or D.');
  return options;
}

export function matchImpact(rawPath, inventory) {
  const path = rawPath.replaceAll('\\', '/');
  const result = (rule, selectedGroups = [], full = false, specs = []) => ({ path, rule, groups: selectedGroups, full, specs });
  if (path.startsWith('docs/') || /\.md$/i.test(path)) return result('documentation: no E2E impact');
  if (/^(lib\/core\/service\.ts|lib\/contracts\.ts|app\/globals\.css|app\/layout\.tsx|playwright\.config\.ts|scripts\/run-e2e-isolated\.mjs|package(?:-lock)?\.json)$/.test(path)
    || /^(lib\/(server|storage)\/|supabase\/|migrations(?:\/|$)|scripts\/e2e\/|next\.config\.|(?:middleware|proxy)(?:\.|\/|$))/.test(path)) return result('shared runtime/infrastructure: FULL', [], true);
  if (path.startsWith('tests/e2e/')) return inventory.includes(path)
    ? result('changed E2E spec', [], false, [path]) : result('shared/deleted E2E helper or spec: FULL', [], true);
  if (path.startsWith('lib/dynamic/')) return result('dynamic: B+D', ['B', 'D']);
  if (path.startsWith('lib/ai/')) return result('AI: B+D', ['B', 'D']);
  if (path.startsWith('lib/demo/')) return result('demo: D+C', ['D', 'C']);
  if (path.startsWith('components/')) return result('components: C (+D for demo-guide)', /(?:^|\/)demo-guide[^/]*(?:\/|$)/i.test(path) ? ['C', 'D'] : ['C']);
  if (/^lib\/core\/(pending-action|action-revision)/.test(path)) return result('action mutations: A', ['A']);
  return result('unknown non-documentation path: FULL (fail safe)', [], true);
}

export function createPlan(options, inventory, { changedPaths = [], root = '.', tempRoot = '.', runId = 'plan', basePort = 43000 } = {}) {
  inventory = [...new Set(inventory)].sort();
  const impacts = options.mode === 'changed' ? [...new Set(changedPaths)].sort().map(path => matchImpact(path, inventory)) : [];
  for (const path of options.specs) if (!inventory.includes(path)) throw new Error(`Unknown spec: ${path}; use its tests/e2e/*.spec.ts path.`);
  const full = options.mode === 'full' || impacts.some(impact => impact.full);
  const selected = inventory.filter(path => full
    || (options.mode === 'spec' && options.specs.includes(path))
    || (options.mode === 'group' && groupFor(path) === options.group)
    || impacts.some(impact => impact.specs.includes(path) || impact.groups.includes(groupFor(path))));
  const skipReason = impacts.length && impacts.every(impact => impact.rule.startsWith('documentation:'))
    ? 'docs-only diff: no E2E impact' : options.mode === 'changed' && !impacts.length ? 'no changed paths' : `outside ${options.mode} selection`;
  const skipped = inventory.filter(path => !selected.includes(path)).map(path => ({ path, reason: skipReason }));
  const warnings = inventory.filter(path => !groupFor(path)).map(path => `WARNING: unmapped spec ${path}; FULL/unknown impact includes it; deterministic hash fallback shard. Add it to spec-map.mjs.`);
  const count = Math.min(options.shards, selected.length);
  const shards = Array.from({ length: count }, (_, index) => {
    const id = `shard-${index + 1}`;
    const dir = resolve(root, 'test-results/e2e-shards', runId, id);
    const uuid = createHash('sha256').update(`${runId}/${id}`).digest('hex').slice(0, 32).replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
    return { id, specs: [], estimatedSeconds: 0, port: basePort + index,
      dbPath: join(tempRoot, `nexus-playwright-${uuid}.sqlite`), outputDir: join(dir, 'output'),
      traceDir: join(dir, 'traces'), reportDir: join(dir, 'report'), logDir: join(dir, 'logs'),
      jsonPath: join(dir, 'report/results.json'), serverStatePath: join(dir, 'report/server.json') };
  });
  for (const path of [...selected].sort((a, b) => (seconds[specName(b)] ?? 30) - (seconds[specName(a)] ?? 30) || a.localeCompare(b))) {
    const shard = groupFor(path)
      ? [...shards].sort((a, b) => a.estimatedSeconds - b.estimatedSeconds || a.id.localeCompare(b.id))[0]
      : shards[parseInt(createHash('sha256').update(path).digest('hex').slice(0, 8), 16) % count];
    shard.specs.push(path);
    shard.estimatedSeconds += seconds[specName(path)] ?? 30;
  }
  return { authority: options.mode === 'full' ? 'release-authoritative' : 'focused', flagProfile: options.flagProfile,
    selected, skipped, impacts, warnings, shards: shards.filter(shard => shard.specs.length) };
}

export function playwrightInvocation(cli, shard) {
  return [cli, 'test', '--workers=1', '--retries=0', ...shard.specs];
}

export function formatPlan(plan) {
  return [`${plan.authority}; flag profile=${plan.flagProfile}; ${plan.selected.length} specs; ${plan.shards.length} shards; build once, next start; per-spec fresh DB+server`,
    ...plan.warnings, ...plan.impacts.map(impact => `IMPACT ${impact.path}: ${impact.rule}`),
    ...plan.selected.map(path => `SELECT ${path}`), ...plan.skipped.map(item => `SKIP ${item.path}: ${item.reason}`),
    ...plan.shards.flatMap(shard => [`${shard.id} (~${shard.estimatedSeconds.toFixed(1)}s): ${shard.specs.join(', ')}`,
      `  ${shard.portAllocated ? `ports=${shard.port}(+inner ${shard.innerPort})` : 'ports=allocated at run time (free ephemeral ports, not shown in plan)'} db=fresh UUID temp DB per spec file, created at run time`, `  output=${shard.outputDir}`, `  traces=${shard.traceDir}`,
      `  report=${shard.reportDir} logs=${shard.logDir}`])].join('\n');
}
