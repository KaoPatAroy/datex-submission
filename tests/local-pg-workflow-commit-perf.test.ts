import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localPsql, migrationPath, parityFixturePath } from '../scripts/local-supabase';
import { pgTestsEnabled } from './helpers/local-pg';

/**
 * Local PostgreSQL proof for 202610060002_workflow_commit_typed_unique_lookup: the typed
 * unique-key predicates keep nexus_workflow_commit semantics (insert, idempotent re-insert,
 * unique conflict, CAS update/conflict, JSON-type mismatches, JSON null) and replace the
 * per-row to_jsonb(t) sequential scan with an index scan. Two scratch databases run the
 * same V2 chain; only the second gets the typed migration. Opt-in: BIZTANIA_PG_TESTS=1.
 */
const V2_CHAIN = [
  '202610010001_concierge',
  '202610020002_workflow_v2',
  '202610030002_workflow_projection_completeness',
  '202610040001_workflow_conversation_persistence',
  '202610040002_workflow_snapshot_proof_references',
  '202610040003_workflow_action_target_provenance',
];
const TYPED = '202610060002_workflow_commit_typed_unique_lookup';
const ORIGINAL_SOURCE_MD5 = 'f5ef58318e3472dd712f8abe2d54184c';

const created: string[] = [];
let legacyDatabase = '';
let typedDatabase = '';

function createDatabase(label: string, ids: string[]): string {
  const name = `bz_w5_${label}_${process.pid}_${created.length}`;
  localPsql(`drop database if exists ${name} with (force); create database ${name} template template0 encoding 'UTF8';`);
  created.push(name);
  localPsql(readFileSync(parityFixturePath(), 'utf8'), name);
  for (const id of ids) localPsql(readFileSync(migrationPath(id), 'utf8'), name);
  return name;
}

function errorLine(error: unknown): string {
  const text = String((error as { stderr?: string }).stderr ?? (error as Error).message);
  return /ERROR:\s+(.*)/.exec(text)?.[1] ?? text;
}

/** Runs one nexus_workflow_commit batch as service_role; returns the new revision or the error. */
function commit(database: string, operations: unknown[], expectedRevision?: number): string {
  const json = JSON.stringify(operations);
  if (json.includes('$ops$')) throw new Error('unexpected delimiter');
  const revision = expectedRevision === undefined ? '(select revision from public.appmeta)' : String(expectedRevision);
  try {
    return `ok:${localPsql(`set role service_role; select public.nexus_workflow_commit(${revision},$ops$${json}$ops$::jsonb);`, database)}`;
  } catch (error) {
    return `error:${errorLine(error)}`;
  }
}

const createdAt = '2026-10-06T00:00:00.000Z';
function team(id: string, name: unknown, rowVersion = 1, department = 'ops') {
  return { id, rowVersion, body: { id, rowVersion, name, active: true, department, createdAt } };
}
function insertTeam(id: string, name: unknown, constraint = 'workflow_teams_name_unique', department = 'ops') {
  const row = team(id, name, 1, department);
  const values = constraint === 'workflow_teams_primary_key' ? { id } : { name };
  return { kind: 'insert_unique', table: 'workflow_teams', constraint, values, row };
}
function insertPolicy(id: string, policyId: string, version: unknown, digest: unknown = 'd1', constraint = 'workflow_policies_policy_version_unique') {
  const body = { id, version, digest, policy: { id: policyId, version, digest } };
  const values: Record<string, unknown> = { 'policy.id': policyId, version };
  if (constraint === 'workflow_policies_policy_version_digest_unique') values.digest = digest;
  return { kind: 'insert_unique', table: 'workflow_policies', constraint, values, row: { id, rowVersion: 1, body } };
}
function casTeam(id: string, expectedRowVersion: number, department: string) {
  return { kind: 'cas', table: 'workflow_teams', id, expected: { rowVersion: expectedRowVersion, state: 'active' }, next: team(id, 'Ops', expectedRowVersion + 1, department) };
}

function tableDump(database: string): string {
  return [
    localPsql(`select coalesce(string_agg(id||'|'||row_version||'|'||body::text||'|'||coalesce(name,'<null>')||'|'||coalesce(active::text,'<null>'),E'\\n' order by id),'') from public.workflow_teams`, database),
    localPsql(`select coalesce(string_agg(id||'|'||row_version||'|'||body::text||'|'||coalesce(policy_id,'<null>')||'|'||coalesce(version::text,'<null>')||'|'||coalesce(digest,'<null>'),E'\\n' order by id),'') from public.workflow_policies`, database),
    localPsql('select revision||\'|\'||workflow_adapter_write from public.appmeta', database),
  ].join('\n--\n');
}

/** Owner bulk seed with triggers bypassed for this session only (synthetic rows). */
function seedTeams(database: string, count: number): void {
  localPsql(`begin; set local session_replication_role=replica;
    insert into public.workflow_teams(id,row_version,body,name,active)
      select 'seed-'||g,1,jsonb_build_object('id','seed-'||g,'rowVersion',1,'name','Seed '||g,'active',true,'department','ops','createdAt','${createdAt}'),'Seed '||g,true
      from generate_series(1,${count}) g;
    commit; analyze public.workflow_teams;`, database);
}

function scanCounts(database: string, operations: unknown[]): { seq: number; idx: number } {
  const row = localPsql(`begin; set local role service_role;
    select public.nexus_workflow_commit((select revision from public.appmeta),$ops$${JSON.stringify(operations)}$ops$::jsonb);
    reset role;
    select seq_scan||','||coalesce(idx_scan,0) from pg_stat_xact_user_tables where relid='public.workflow_teams'::regclass;
    rollback;`, database).split(/\r?\n/).at(-1) ?? '';
  const [seq, idx] = row.split(',').map(Number);
  return { seq, idx };
}

beforeAll(() => {
  if (!pgTestsEnabled) return;
  legacyDatabase = createDatabase('commit_legacy', V2_CHAIN);
  typedDatabase = createDatabase('commit_typed', [...V2_CHAIN, TYPED]);
}, 120_000);

afterAll(() => {
  if (!pgTestsEnabled) return;
  for (const name of created.splice(0)) {
    try { localPsql(`drop database if exists ${name} with (force);`); } catch { /* best-effort scratch cleanup */ }
  }
});

describe.skipIf(!pgTestsEnabled)('typed nexus_workflow_commit unique lookups on local PostgreSQL', () => {
  it('replaces only the reviewed 202610020002 source and keeps identity, owner and grants', () => {
    const identity = `select p.oid::regprocedure||'|'||l.lanname||'|'||p.prosecdef||'|'||p.provolatile::text||'|'||p.proconfig::text||'|'||p.proowner::regrole||'|'||coalesce(p.proacl::text,'')||'|'||pg_get_function_result(p.oid)
      from pg_proc p join pg_language l on l.oid=p.prolang where p.oid='public.nexus_workflow_commit(bigint,jsonb)'::regprocedure`;
    expect(localPsql(identity, typedDatabase)).toBe(localPsql(identity, legacyDatabase));
    const sourceMd5 = `select md5(replace(prosrc,E'\\r\\n',E'\\n')) from pg_proc where oid='public.nexus_workflow_commit(bigint,jsonb)'::regprocedure`;
    expect(localPsql(sourceMd5, legacyDatabase)).toBe(ORIGINAL_SOURCE_MD5);
    const typedMd5 = localPsql(sourceMd5, typedDatabase);
    expect(typedMd5).not.toBe(ORIGINAL_SOURCE_MD5);
    // Idempotent re-run.
    localPsql(readFileSync(migrationPath(TYPED), 'utf8'), typedDatabase);
    expect(localPsql(sourceMd5, typedDatabase)).toBe(typedMd5);
  });

  it('keeps insert, re-insert, conflict, type-mismatch, JSON-null and CAS semantics identical', () => {
    // A historical row whose unique column is SQL NULL: JSON null must still match it.
    for (const database of [legacyDatabase, typedDatabase]) {
      localPsql(`begin; set local session_replication_role=replica;
        insert into public.workflow_policies(id,row_version,body,policy_id,version,digest)
          values('wp-null',1,'{"id":"wp-null","version":9,"digest":null,"policy":{"id":"pol-9","version":9,"digest":null}}','pol-9',9,null);
        commit;`, database);
    }
    const steps: Array<[string, unknown[], number?]> = [
      ['insert', [insertTeam('team-1', 'Ops')]],
      ['identical re-insert is a no-op', [insertTeam('team-1', 'Ops')]],
      ['same key, other row: unique conflict', [insertTeam('team-2', 'Ops')]],
      ['same key, same id, other body: unique conflict', [insertTeam('team-1', 'Ops', 'workflow_teams_name_unique', 'finance')]],
      ['primary-key constraint re-insert', [insertTeam('team-1', 'Ops', 'workflow_teams_primary_key')]],
      ['text key that looks numeric', [insertTeam('team-3', '5')]],
      ['number value against a text column never matches', [insertTeam('team-4', 5)]],
      ['boolean value against a text column never matches', [insertTeam('team-5', true)]],
      ['policy insert', [insertPolicy('wp-1', 'pol-1', 1)]],
      ['integer column matched by an equal decimal', [insertPolicy('wp-1', 'pol-1', 1.0)]],
      ['integer column, decimal with a fraction', [insertPolicy('wp-2', 'pol-1', 1.5)]],
      ['integer column, out-of-range number', [insertPolicy('wp-3', 'pol-1', 1e20)]],
      ['string value against an integer column', [insertPolicy('wp-4', 'pol-1', '1')]],
      ['JSON null key value', [insertPolicy('wp-5', 'pol-2', 2, null, 'workflow_policies_policy_version_digest_unique')]],
      ['JSON null key value again', [insertPolicy('wp-6', 'pol-2', 2, null, 'workflow_policies_policy_version_digest_unique')]],
      ['JSON null matches a SQL NULL column (identical body: no-op)', [insertPolicy('wp-null', 'pol-9', 9, null, 'workflow_policies_policy_version_digest_unique')]],
      ['JSON null matches a SQL NULL column (other row: conflict)', [insertPolicy('wp-null-2', 'pol-9', 9, null, 'workflow_policies_policy_version_digest_unique')]],
      ['dotted body field key', [insertPolicy('wp-7', 'pol-3', 3, 'd3', 'workflow_policies_policy_version_digest_unique')]],
      ['CAS update', [casTeam('team-1', 1, 'finance')]],
      ['stale CAS conflict', [casTeam('team-1', 1, 'legal')]],
      ['batch: insert then conflicting insert rolls back both', [insertTeam('team-8', 'Batch'), insertTeam('team-9', 'Batch')]],
      ['batch: insert then same-batch re-insert', [insertTeam('team-10', 'Batch 2'), insertTeam('team-10', 'Batch 2')]],
      ['revision conflict', [insertTeam('team-11', 'Late')], 0],
    ];
    const legacy = steps.map(([name, operations, revision]) => `${name}: ${commit(legacyDatabase, operations, revision)}`);
    const typed = steps.map(([name, operations, revision]) => `${name}: ${commit(typedDatabase, operations, revision)}`);
    console.info(legacy.join('\n'));
    expect(typed).toEqual(legacy);
    expect(tableDump(typedDatabase)).toBe(tableDump(legacyDatabase));
    // The sequence exercised every path: success, no-op, 23505 conflict and 40001 conflicts.
    expect(legacy.join('\n')).toContain('Workflow unique operation conflict');
    expect(legacy.join('\n')).toContain('CAS update: ok:');
    expect(legacy.join('\n')).toContain('(identical body: no-op): ok:');
    expect(legacy.join('\n')).toContain('(other row: conflict): error:Workflow unique operation conflict');
    expect(legacy.join('\n')).toContain('Workflow conditional conflict');
    expect(legacy.join('\n')).toContain('Workflow revision conflict');
    expect(legacy.filter((line) => line.includes(': ok:')).length).toBeGreaterThanOrEqual(6);
  });

  it('uses an index scan instead of a per-row to_jsonb sequential scan', () => {
    seedTeams(legacyDatabase, 10_000);
    seedTeams(typedDatabase, 10_000);
    const lookup = [insertTeam('team-probe', 'Probe 10001')];
    // Within one transaction: the typed function never sequentially scans the table.
    expect(scanCounts(typedDatabase, lookup).seq).toBe(0);
    expect(scanCounts(typedDatabase, lookup).idx).toBeGreaterThan(0);
    expect(scanCounts(legacyDatabase, lookup).seq).toBeGreaterThan(0);
    // The generated typed predicate plans as an index scan on the unique index.
    const typedPlan = localPsql(`explain select t.body from public.workflow_teams t where t.name=('{"name":"Seed 9999"}'::jsonb->>'name')::text limit 1`, typedDatabase);
    expect(typedPlan).toMatch(/Index (Only )?Scan/);
    const legacyPlan = localPsql(`explain select t.body from public.workflow_teams t where to_jsonb(t)->'name' = '{"name":"Seed 9999"}'::jsonb->'name' limit 1`, legacyDatabase);
    expect(legacyPlan).toContain('Seq Scan');
  });

  it('commits a 200-operation unique batch over 10,000 rows far inside the 8 s statement timeout', () => {
    const batch = Array.from({ length: 200 }, (_, index) => insertTeam(`team-batch-${index}`, `Batch member ${index}`));
    const time = (database: string) => {
      const started = performance.now();
      const result = commit(database, batch);
      return { result, ms: performance.now() - started };
    };
    const typed = time(typedDatabase);
    const legacy = time(legacyDatabase);
    expect(typed.result).toMatch(/^ok:/);
    expect(legacy.result).toMatch(/^ok:/);
    expect(tableDump(typedDatabase)).toBe(tableDump(legacyDatabase));
    console.info(`200-op insert_unique batch over 10k rows: legacy ${legacy.ms.toFixed(0)} ms, typed ${typed.ms.toFixed(0)} ms`);
    expect(typed.ms).toBeLessThan(2_000);
    expect(typed.ms * 5).toBeLessThan(legacy.ms);
  });
});
