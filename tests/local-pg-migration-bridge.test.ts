import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { localPsql, migrationPath, parityFixturePath } from '../scripts/local-supabase';
import { pgTestsEnabled } from './helpers/local-pg';

/**
 * Local PostgreSQL proof for the guarded V1 -> Workflow V2 bridge
 * (202610020003 fence + 202610030003 seal + 202610060001 activate). Each case uses its own scratch
 * database in the local Supabase container, so the shared `postgres` database used by
 * the adapter tests is untouched. Opt-in: BIZTANIA_PG_TESTS=1 (`npm run test:pg`).
 */
const HOSTED_V1 = ['202610010001_concierge', '202610010002_workflow_pending_action_v1_guard'];
const V2_BASE = ['202610020002_workflow_v2'];
const FENCE = '202610020003_workflow_v1_guard_bridge_fence';
const COMPLETENESS = '202610030002_workflow_projection_completeness';
const SEAL = '202610030003_workflow_v1_guard_bridge_seal';
const V2_TAIL = [
  '202610040001_workflow_conversation_persistence',
  '202610040002_workflow_snapshot_proof_references',
  '202610040003_workflow_action_target_provenance',
];
const V2_REST = [COMPLETENESS, SEAL, ...V2_TAIL];
const ACTIVATE = '202610060001_workflow_v1_guard_bridge_activate';

const created: string[] = [];
let sequence = 0;

function sqlFile(path: string): string {
  return readFileSync(path, 'utf8');
}

function createScratchDatabase(label: string): string {
  const name = `bz_w5_${label}_${process.pid}_${sequence++}`;
  localPsql(`drop database if exists ${name} with (force); create database ${name} template template0 encoding 'UTF8';`);
  created.push(name);
  localPsql(sqlFile(parityFixturePath()), name);
  return name;
}

function apply(database: string, ids: string[]): void {
  for (const id of ids) localPsql(sqlFile(migrationPath(id)), database);
}

/**
 * The two pending_actions ACL shapes 202610010002 accepts. A scratch database has no
 * Supabase default privileges, so 202610010001's explicit grants leave the source shape
 * (service_role SELECT/INSERT/UPDATE/DELETE). The hosted fixture reproduces the hosted
 * project's default-privilege result: service_role holds every table privilege on
 * pending_actions and every one except INSERT/DELETE on appmeta.
 */
type AclVariant = 'source' | 'hosted';
const HOSTED_ACL_FIXTURE = `grant all on table public.pending_actions to service_role;
  grant all on table public.appmeta to service_role; revoke insert, delete on table public.appmeta from service_role;`;

function applyHostedV1(database: string, variant: AclVariant = 'source'): void {
  apply(database, [HOSTED_V1[0]]);
  if (variant === 'hosted') localPsql(HOSTED_ACL_FIXTURE, database);
  apply(database, [HOSTED_V1[1]]);
}

function failureOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return String((error as { stderr?: string }).stderr ?? (error as Error).message);
  }
  throw new Error('Expected the SQL to fail');
}

function asServiceRole(database: string, sql: string): string {
  return localPsql(`set role service_role;\n${sql}`, database);
}

function v1Body(id: string, status: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id, actorId: 'w5-actor', sessionId: 'w5-session', conversationId: 'w5-conversation', turnId: `turn-${id}`,
    mode: 'live_ai', modeRevision: 0, payload: { kind: 'dashboard_create' }, payloadHash: `hash-${id}`,
    packs: [], actionContractVersion: 1, createdAt: '2026-10-04T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z',
    status, preview: `Synthetic V1 action ${id}`, ...extra,
  }).replace(/'/g, "''");
}

/** Historical rows enter as pending (the V1 guard's rule) and advance through allowed transitions. */
function seedHistoricalV1(database: string): void {
  const statements: string[] = ['begin;'];
  for (let index = 1; index <= 9; index++) {
    const id = `w5-historical-${String(index).padStart(2, '0')}`;
    statements.push(`insert into public.pending_actions(id,payload) values('${id}','${v1Body(id, 'pending')}'::jsonb);`);
    if (index <= 8) {
      statements.push(`update public.pending_actions set payload=jsonb_set(payload,'{status}','"claimed"') where id='${id}';`);
      statements.push(`update public.pending_actions set payload=jsonb_set(payload,'{status}','"completed"') where id='${id}';`);
    }
  }
  statements.push(`insert into public.pending_actions(id,payload) values('w5-claimed','${v1Body('w5-claimed', 'pending')}'::jsonb);`);
  statements.push(`update public.pending_actions set payload=jsonb_set(payload,'{status}','"claimed"') where id='w5-claimed';`);
  statements.push('commit;');
  asServiceRole(database, statements.join('\n'));
}

function legacyRows(database: string): string {
  const hasMarker = localPsql(`select count(*) from pg_attribute where attrelid='public.pending_actions'::regclass and attname='workflow_contract_version' and not attisdropped`, database) === '1';
  return localPsql(`select coalesce(string_agg(id||E'\\t'||payload::text,E'\\n' order by id),'') from public.pending_actions${hasMarker ? ' where workflow_contract_version is null' : ''}`, database);
}

function catalogState(database: string): string {
  const triggers = localPsql(`select coalesce(string_agg(tgname||':'||tgenabled::text||':'||tgfoid::regprocedure::text||':'||tgtype,',' order by tgname),'') from pg_trigger where tgrelid='public.pending_actions'::regclass and not tgisinternal`, database);
  const acl = localPsql(`select relacl::text from pg_class where oid='public.pending_actions'::regclass`, database);
  const functions = localPsql(`select coalesce(string_agg(p.oid::regprocedure::text||':'||md5(p.prosrc),',' order by 1),'') from pg_proc p where p.pronamespace='nexus_private'::regnamespace and p.proname like '%pending_action%'`, database);
  const bridgeLedger = localPsql(`select to_regclass('nexus_private.workflow_v1_bridge_migrations') is not null`, database) === 't'
    ? localPsql(`select coalesce(string_agg(id||'='||definition_digest||'='||detail::text,',' order by id),'') from nexus_private.workflow_v1_bridge_migrations`, database)
    : '<no bridge ledger>';
  const projectionLedger = localPsql(`select to_regclass('nexus_private.workflow_projection_migrations') is not null`, database) === 't'
    ? localPsql(`select coalesce(string_agg(id||'='||definition_digest,',' order by id),'') from nexus_private.workflow_projection_migrations`, database)
    : '<no projection ledger>';
  return [triggers, acl, functions, bridgeLedger, projectionLedger].join('\n');
}

function preFenceState(label: string, variant: AclVariant = 'source'): string {
  const database = createScratchDatabase(label);
  applyHostedV1(database, variant);
  seedHistoricalV1(database);
  apply(database, V2_BASE);
  return database;
}

/** Fenced, V2 completeness applied and sealed, rest of the V2 chain applied: ready to activate. */
function sealedState(label: string): string {
  const database = preFenceState(label);
  apply(database, [FENCE, ...V2_REST]);
  return database;
}

const SEALED = 'Pending actions are sealed until the V1 guard bridge activates';
const roles: string[] = [];

function scratchRole(label: string): string {
  const role = `bz_w5_${label}_${process.pid}`;
  localPsql(`drop role if exists ${role}; create role ${role} nologin;`);
  roles.push(role);
  return role;
}

/** Owner writes that must be rejected while the fence (then the seal) is in place. */
function ownerWrites(): string[] {
  return [
    `update public.pending_actions set payload=jsonb_set(payload,'{preview}','"owner edit"') where id='w5-historical-01';`,
    `update public.pending_actions set row_version=7 where id='w5-historical-01';`,
    `insert into public.pending_actions(id,payload) values('w5-owner','${v1Body('w5-owner', 'pending')}'::jsonb);`,
    `delete from public.pending_actions where id='w5-historical-09';`,
    'truncate public.pending_actions cascade;',
    `begin; set local session_replication_role=replica; update public.pending_actions set payload=payload where id='w5-claimed'; commit;`,
    `begin; set local session_replication_role=replica; update public.pending_actions set row_version=coalesce(row_version,0)+1 where id='w5-claimed'; commit;`,
    `begin; set local session_replication_role=replica; truncate public.pending_actions cascade; commit;`,
    `select public.nexus_commit((select revision from public.appmeta),jsonb_build_array(jsonb_build_object('table','pending_actions','id','w5-new','payload','${v1Body('w5-new', 'pending')}'::jsonb)));`,
  ];
}

function fullRows(database: string): string {
  return localPsql(`select coalesce(string_agg(id||E'\\t'||payload::text||E'\\t'||coalesce(row_version::text,'')||E'\\t'||coalesce(workflow_contract_version::text,''),E'\\n' order by id),'') from public.pending_actions`, database);
}

afterAll(() => {
  if (!pgTestsEnabled) return;
  for (const name of created.splice(0)) {
    try { localPsql(`drop database if exists ${name} with (force);`); } catch { /* best-effort scratch cleanup */ }
  }
  for (const role of roles.splice(0)) {
    try { localPsql(`drop role if exists ${role};`); } catch { /* best-effort scratch cleanup */ }
  }
});

describe.skipIf(!pgTestsEnabled)('guarded V1 -> Workflow V2 bridge on local PostgreSQL', () => {
  it.each<[AclVariant, string]>([
    ['source', '{postgres=arwdDxtm/postgres,service_role=arwd/postgres}'],
    ['hosted', '{postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres}'],
  ])('bridges the hosted V1 state (%s ACL) through the full V2 chain without losing V1 rows, then re-runs idempotently', (variant, expectedAcl) => {
    const database = createScratchDatabase('bridge');
    applyHostedV1(database, variant);
    seedHistoricalV1(database);
    const seededRows = legacyRows(database);
    const hostedAcl = localPsql(`select relacl::text from pg_class where oid='public.pending_actions'::regclass`, database);
    expect(hostedAcl).toBe(expectedAcl);
    expect(seededRows.split('\n')).toHaveLength(10);
    expect(localPsql(`select definition_digest from nexus_private.pending_action_v1_migrations`, database)).toBe('a6b602b989af97760e2311cbbe79f78a');

    apply(database, V2_BASE);
    // Hosted V1 + V2 base, before the bridge: the standalone guard fails closed.
    expect(failureOf(() => asServiceRole(database, `update public.pending_actions set payload=jsonb_set(payload,'{status}','"completed"') where id='w5-claimed';`)))
      .toContain('Standalone pending action requires a reviewed V2 bridge');
    // And the completeness step refuses to run without the fence.
    expect(failureOf(() => apply(database, [COMPLETENESS])))
      .toContain('Workflow completeness cannot suspend an unknown application trigger');

    apply(database, [FENCE]);
    expect(localPsql(`select count(*) from pg_trigger where tgrelid='public.pending_actions'::regclass and tgname like 'standalone%'`, database)).toBe('0');
    expect(failureOf(() => asServiceRole(database, `update public.pending_actions set payload=jsonb_set(payload,'{status}','"completed"') where id='w5-claimed';`)))
      .toContain('permission denied for table pending_actions');
    expect(failureOf(() => asServiceRole(database, `select public.nexus_commit((select revision from public.appmeta),jsonb_build_array(jsonb_build_object('table','pending_actions','id','w5-new','payload','${v1Body('w5-new', 'pending')}'::jsonb)));`)))
      .toContain('permission denied for table pending_actions');
    // P1-1: the fence already rejects every owner write, replica mode included (row_version too).
    const fencedRows = fullRows(database);
    expect(localPsql(`select string_agg(tgname||':'||tgenabled::text||':'||tgtype,',' order by tgname) from pg_trigger where tgrelid='public.pending_actions'::regclass and not tgisinternal`, database))
      .toBe('nexus_revision:O:62,workflow_children:A:62,workflow_guard:O:31');
    for (const sql of ownerWrites()) expect(failureOf(() => localPsql(sql, database))).toContain(SEALED);

    // The frozen completeness step suspends and restores the fence trigger; the gap stays closed.
    apply(database, [COMPLETENESS]);
    for (const sql of ownerWrites()) expect(failureOf(() => localPsql(sql, database))).toContain(SEALED);
    expect(fullRows(database)).toBe(fencedRows);

    // Seal: from here until activation even the owner cannot write (P1-a), replica mode included.
    apply(database, [SEAL]);
    expect(localPsql(`select string_agg(tgname||':'||tgenabled::text,',' order by tgname) from pg_trigger where tgrelid='public.pending_actions'::regclass and not tgisinternal`, database))
      .toBe('nexus_revision:O,workflow_guard:O,workflow_pending_action_v1_bridge_seal:A,workflow_pending_action_v1_bridge_truncate_seal:A');
    for (const sql of ownerWrites()) expect(failureOf(() => localPsql(sql, database))).toContain(SEALED);
    expect(legacyRows(database)).toBe(seededRows);
    expect(fullRows(database)).toBe(fencedRows);

    apply(database, [...V2_TAIL, ACTIVATE]);
    expect(legacyRows(database)).toBe(seededRows);
    expect(localPsql(`select relacl::text from pg_class where oid='public.pending_actions'::regclass`, database)).toBe(hostedAcl);
    expect(localPsql(`select string_agg(tgname||':'||tgenabled::text,',' order by tgname) from pg_trigger where tgrelid='public.pending_actions'::regclass and not tgisinternal`, database))
      .toBe('nexus_revision:O,workflow_guard:O,workflow_pending_action_v1_bridge_guard:O,workflow_pending_action_v1_bridge_truncate_guard:O');
    expect(localPsql(`select string_agg(id,',' order by id) from nexus_private.workflow_v1_bridge_migrations`, database)).toBe('activate,fence,seal');
    // SECURITY DEFINER guard and seal function are owned by the table owner (P2-f).
    expect(localPsql(`select string_agg(proname||':'||(proowner=(select relowner from pg_class where oid='public.pending_actions'::regclass))::text||':'||prosecdef::text,',' order by proname) from pg_proc where proname like 'workflow_pending_action_v1_bridge_%'`, database))
      .toBe('workflow_pending_action_v1_bridge_guard:true:true,workflow_pending_action_v1_bridge_seal:true:false');
    // The 202610010002 ledger and frozen helper functions are retained, not rewritten.
    expect(localPsql(`select id||'='||definition_digest from nexus_private.pending_action_v1_migrations`, database))
      .toBe('202610010002_workflow_pending_action_v1_guard=a6b602b989af97760e2311cbbe79f78a');

    const activated = catalogState(database);
    const rowsAfterActivation = legacyRows(database);
    // Supabase never re-runs an applied version; the bridge itself must still be re-runnable.
    apply(database, [FENCE, SEAL, ACTIVATE]);
    apply(database, [FENCE, SEAL, ACTIVATE]);
    expect(catalogState(database)).toBe(activated);
    expect(legacyRows(database)).toBe(rowsAfterActivation);
  });

  it('keeps the V1 pending-action guard contract for legacy rows after activation', () => {
    const database = preFenceState('guard');
    apply(database, [FENCE, ...V2_REST, ACTIVATE]);

    // Allowed: fresh pending insert through the V1 RPC, then pending -> claimed -> completed.
    asServiceRole(database, `select public.nexus_commit((select revision from public.appmeta),jsonb_build_array(jsonb_build_object('table','pending_actions','id','w5-new','payload','${v1Body('w5-new', 'pending')}'::jsonb)));`);
    asServiceRole(database, `update public.pending_actions set payload=jsonb_set(payload,'{status}','"claimed"') where id='w5-new';`);
    asServiceRole(database, `update public.pending_actions set payload=jsonb_set(payload,'{status}','"completed"') where id='w5-claimed';`);
    expect(localPsql(`select string_agg(id||'='||(payload->>'status'),',' order by id) from public.pending_actions where id in('w5-new','w5-claimed')`, database))
      .toBe('w5-claimed=completed,w5-new=claimed');

    const rejected: Array<[string, string]> = [
      [`update public.pending_actions set payload=jsonb_set(payload,'{status}','"pending"') where id='w5-historical-01';`, 'Invalid legacy pending action transition'],
      [`update public.pending_actions set payload=jsonb_set(jsonb_set(payload,'{status}','"completed"'),'{preview}','"changed"') where id='w5-new';`, 'Immutable legacy pending action approval'],
      [`insert into public.pending_actions(id,payload) values('w5-fresh-claimed','${v1Body('w5-fresh-claimed', 'claimed')}'::jsonb);`, 'Legacy pending action must be prepared as pending'],
      [`insert into public.pending_actions(id,payload) values('w5-bad','{"id":"w5-bad","status":"pending"}'::jsonb);`, 'Invalid legacy pending action body'],
      [`delete from public.pending_actions where id='w5-historical-09';`, 'Legacy pending action history cannot be deleted'],
      [`update public.pending_actions set workflow_contract_version=2 where id='w5-historical-09';`, 'marker'],
    ];
    const before = legacyRows(database);
    for (const [sql, message] of rejected) expect(failureOf(() => asServiceRole(database, sql))).toContain(message);
    // TRUNCATE is refused even for the table owner (statement trigger, not an ACL).
    expect(failureOf(() => localPsql('truncate public.pending_actions cascade;', database))).toContain('Pending action history cannot be truncated');
    expect(legacyRows(database)).toBe(before);

    // P1-b: a missing, disabled or replica-only Workflow V2 guard disables every write.
    const probe = `update public.pending_actions set payload=payload where id='w5-historical-09';`;
    asServiceRole(database, probe);
    for (const [breakGuard, restore] of [
      ['alter table public.pending_actions disable trigger workflow_guard;', 'alter table public.pending_actions enable trigger workflow_guard;'],
      ['alter table public.pending_actions enable replica trigger workflow_guard;', 'alter table public.pending_actions enable trigger workflow_guard;'],
      ['alter table public.pending_actions disable trigger nexus_revision;', 'alter table public.pending_actions enable trigger nexus_revision;'],
      ['alter table public.pending_actions disable trigger workflow_pending_action_v1_bridge_truncate_guard;', 'alter table public.pending_actions enable trigger workflow_pending_action_v1_bridge_truncate_guard;'],
    ]) {
      localPsql(breakGuard, database);
      expect(failureOf(() => asServiceRole(database, probe))).toContain('Pending action active trigger inventory is incompatible');
      localPsql(restore, database);
      asServiceRole(database, probe);
    }
    expect(failureOf(() => localPsql(`begin; drop trigger workflow_guard on public.pending_actions;
      set role service_role; update public.pending_actions set payload=payload where id='w5-historical-09'; commit;`, database)))
      .toContain('Pending action active trigger inventory is incompatible');

    // An unknown later trigger disables every write until reviewed (inventory recheck).
    localPsql(`create function public.w5_rewrite() returns trigger language plpgsql as $$ begin return new; end $$;
      create trigger zz_w5_rewrite before update on public.pending_actions for each row execute function public.w5_rewrite();`, database);
    expect(failureOf(() => asServiceRole(database, probe))).toContain('Pending action active trigger inventory is incompatible');
  });

  it('re-runs the fence idempotently before and after 202610030002, keeping the fence trigger exact', () => {
    const database = preFenceState('rerun');
    apply(database, [FENCE]);
    const fenced = catalogState(database);
    apply(database, [FENCE]);
    expect(catalogState(database)).toBe(fenced);
    apply(database, [COMPLETENESS]);
    const completed = catalogState(database);
    apply(database, [FENCE]);
    expect(catalogState(database)).toBe(completed);
    localPsql('alter table public.pending_actions disable trigger workflow_children;', database);
    expect(failureOf(() => apply(database, [FENCE]))).toContain('V1 guard bridge fence ledger does not match installed triggers');
  });

  it('fails closed when a non-owner role can write through pg_write_all_data (P1-2)', () => {
    const database = preFenceState('writeall');
    const role = scratchRole('writeall');
    localPsql(`grant pg_write_all_data to ${role};`, 'postgres', 'supabase_admin');
    try {
      const state = catalogState(database);
      const rows = legacyRows(database);
      expect(failureOf(() => apply(database, [FENCE]))).toContain('V1 guard bridge fence left a non-owner write path');
      expect(catalogState(database)).toBe(state);
      expect(legacyRows(database)).toBe(rows);
    } finally {
      localPsql(`revoke pg_write_all_data from ${role};`, 'postgres', 'supabase_admin');
    }
    apply(database, [FENCE]);
  });

  it('is a no-op on the Workflow V2 proof lineage without the standalone guard', () => {
    const database = createScratchDatabase('v2proof');
    apply(database, ['202610010001_concierge', ...V2_BASE, FENCE, ...V2_REST, ACTIVATE]);
    expect(localPsql(`select to_regclass('nexus_private.workflow_v1_bridge_migrations') is null`, database)).toBe('t');
    expect(localPsql(`select to_regprocedure('nexus_private.workflow_pending_action_v1_bridge_seal()') is null`, database)).toBe('t');
    expect(localPsql(`select string_agg(tgname,',' order by tgname) from pg_trigger where tgrelid='public.pending_actions'::regclass and not tgisinternal`, database))
      .toBe('nexus_revision,workflow_guard');
    const state = catalogState(database);
    apply(database, [FENCE, SEAL, ACTIVATE]);
    expect(catalogState(database)).toBe(state);
  });

  it('pins the SECURITY DEFINER guard to the table owner, and re-runs reject an owner drift', () => {
    const database = sealedState('owner');
    apply(database, [ACTIVATE]);
    const role = `bz_w5_other_${process.pid}`;
    localPsql(`drop role if exists ${role}; create role ${role} nologin; grant ${role} to current_user;`);
    roles.push(role);
    localPsql(`grant usage, create on schema nexus_private to ${role};
      alter function nexus_private.workflow_pending_action_v1_bridge_guard() owner to ${role};`, database);
    expect(failureOf(() => apply(database, [ACTIVATE]))).toContain('V1 guard bridge activation does not match its ledger');
    localPsql(`alter function nexus_private.workflow_pending_action_v1_bridge_guard() owner to postgres;`, database);
    apply(database, [ACTIVATE]);
  });

  describe('fails closed and changes nothing on unexpected state', () => {
    type Base = 'hosted-v1' | 'pre-fence' | 'fenced' | 'completed' | 'sealed' | 'v2-proof';
    const cases: Array<{ name: string; prepare: (database: string) => void; run: string[]; message: string; base?: Base }> = [
      { name: 'fence before the V2 base', base: 'hosted-v1', prepare: () => {}, run: [FENCE], message: 'V1 guard bridge requires 202610020002_workflow_v2' },
      {
        name: 'fence with a modified frozen standalone function', base: 'pre-fence',
        prepare: (database) => localPsql(`create or replace function nexus_private.standalone_pending_action_v1_utf16_length(value text) returns integer language sql immutable strict set search_path='' as $$ select 0 $$;`, database),
        run: [FENCE], message: 'V1 guard bridge found modified standalone functions',
      },
      {
        name: 'fence with a mismatched 202610010002 ledger digest', base: 'pre-fence',
        prepare: (database) => localPsql(`update nexus_private.pending_action_v1_migrations set definition_digest=md5('tampered');`, database),
        run: [FENCE], message: 'V1 guard bridge requires the exact 202610010002 ledger',
      },
      {
        name: 'fence with an unknown pending_actions trigger', base: 'pre-fence',
        prepare: (database) => localPsql(`create function public.w5_noop() returns trigger language plpgsql as $$ begin return new; end $$;
          create trigger w5_unknown before update on public.pending_actions for each row execute function public.w5_noop();`, database),
        run: [FENCE], message: 'V1 guard bridge found an unknown pending action trigger',
      },
      {
        name: 'fence with a disabled standalone trigger', base: 'pre-fence',
        prepare: (database) => localPsql(`alter table public.pending_actions disable trigger standalone_pending_action_v1_guard;`, database),
        run: [FENCE], message: 'V1 guard bridge requires both exact standalone triggers',
      },
      {
        name: 'fence with an extra role granted write (P1-2)', base: 'pre-fence',
        prepare: (database) => localPsql(`grant insert, update on public.pending_actions to ${scratchRole('extra')};`, database),
        run: [FENCE], message: 'V1 guard bridge found a pending action ACL outside the V1 allowlist',
      },
      {
        name: 'fence with an extra read-only grantee (P1-2)', base: 'pre-fence',
        prepare: (database) => localPsql(`grant select on public.pending_actions to ${scratchRole('reader')};`, database),
        run: [FENCE], message: 'V1 guard bridge found a pending action ACL outside the V1 allowlist',
      },
      {
        name: 'fence with a column-level write grant (P1-2)', base: 'pre-fence',
        prepare: (database) => localPsql(`grant update (payload) on public.pending_actions to ${scratchRole('column')};`, database),
        run: [FENCE], message: 'V1 guard bridge found a pending action ACL outside the V1 allowlist',
      },
      {
        name: 'fence with a grantable service_role privilege (P1-2)', base: 'pre-fence',
        prepare: (database) => localPsql('grant select on public.pending_actions to service_role with grant option;', database),
        run: [FENCE], message: 'V1 guard bridge found a pending action ACL outside the V1 allowlist',
      },
      {
        name: 'fence with a partial service_role grant outside both V1 shapes (P1-2)', base: 'pre-fence',
        prepare: (database) => localPsql('grant truncate on public.pending_actions to service_role;', database),
        run: [FENCE], message: 'V1 guard bridge found a pending action ACL outside the V1 allowlist',
      },
      { name: 'seal before 202610030002', base: 'fenced', prepare: () => {}, run: [SEAL], message: 'V1 guard bridge seal requires 202610030002_workflow_projection_completeness' },
      {
        name: 'seal after an owner bypassed the fence to change a legacy payload in the gap', base: 'completed',
        prepare: (database) => localPsql(`alter table public.pending_actions disable trigger workflow_children;
          begin; set local session_replication_role=replica; update public.pending_actions set payload=jsonb_set(payload,'{preview}','"edited"') where id='w5-historical-01'; commit;
          alter table public.pending_actions enable always trigger workflow_children;`, database),
        run: [SEAL], message: 'V1 guard bridge found changed legacy pending actions',
      },
      {
        name: 'seal after an owner bypassed the fence to delete a legacy row in the gap', base: 'completed',
        prepare: (database) => localPsql(`alter table public.pending_actions disable trigger workflow_children;
          begin; set local session_replication_role=replica; delete from public.pending_actions where id='w5-historical-02'; commit;
          alter table public.pending_actions enable always trigger workflow_children;`, database),
        run: [SEAL], message: 'V1 guard bridge found changed legacy pending actions',
      },
      {
        name: 'seal after an owner bypassed the fence to change only a row_version in replica mode (P1-1)', base: 'completed',
        prepare: (database) => localPsql(`alter table public.pending_actions disable trigger workflow_children;
          begin; set local session_replication_role=replica; update public.pending_actions set row_version=coalesce(row_version,0)+5 where id='w5-historical-03'; commit;
          alter table public.pending_actions enable always trigger workflow_children;`, database),
        run: [SEAL], message: 'V1 guard bridge found changed legacy pending actions',
      },
      {
        name: 'seal after an owner bypassed the fence to change only a row_version before 202610030002 (P1-1)', base: 'fenced',
        prepare: (database) => {
          localPsql(`alter table public.pending_actions disable trigger workflow_children;
            begin; set local session_replication_role=replica; update public.pending_actions set row_version=coalesce(row_version,0)+1 where id='w5-claimed'; commit;
            alter table public.pending_actions enable always trigger workflow_children;`, database);
          apply(database, [COMPLETENESS]);
        },
        run: [SEAL], message: 'V1 guard bridge found changed legacy pending actions',
      },
      {
        name: 'seal after the fence trigger was disabled', base: 'completed',
        prepare: (database) => localPsql('alter table public.pending_actions disable trigger workflow_children;', database),
        run: [SEAL], message: 'V1 guard bridge seal requires the intact 202610020003 fence trigger',
      },
      {
        name: 'seal after the fence trigger was downgraded from ENABLE ALWAYS', base: 'completed',
        prepare: (database) => localPsql('alter table public.pending_actions enable trigger workflow_children;', database),
        run: [SEAL], message: 'V1 guard bridge seal requires the intact 202610020003 fence trigger',
      },
      {
        name: 'seal after an extra role was granted a write in the gap (P1-2)', base: 'completed',
        prepare: (database) => localPsql(`grant delete on public.pending_actions to ${scratchRole('gap')};`, database),
        run: [SEAL], message: 'V1 guard bridge fence was lifted before the seal',
      },
      {
        name: 'seal with a disabled Workflow V2 guard', base: 'completed',
        prepare: (database) => localPsql(`alter table public.pending_actions disable trigger workflow_guard;`, database),
        run: [SEAL], message: 'V1 guard bridge seal requires the enabled Workflow V2 guards',
      },
      {
        name: 'seal after the write fence was lifted', base: 'completed',
        prepare: (database) => localPsql(`grant update on public.pending_actions to service_role;`, database),
        run: [SEAL], message: 'V1 guard bridge fence was lifted before the seal',
      },
      {
        name: 'activation without the seal', base: 'fenced',
        prepare: (database) => apply(database, [COMPLETENESS, ...V2_TAIL]),
        run: [ACTIVATE], message: 'V1 guard bridge ledger is incompatible',
      },
      { name: 'activation before the V2 chain completes', base: 'completed', prepare: (database) => apply(database, [SEAL]), run: [ACTIVATE], message: 'V1 guard bridge activation requires the complete Workflow V2 chain' },
      {
        name: 'activation with an unexpected V2 projection ledger entry', base: 'sealed',
        prepare: (database) => localPsql(`insert into nexus_private.workflow_projection_migrations values('202610059999_unreviewed','x');`, database),
        run: [ACTIVATE], message: 'V1 guard bridge activation requires the complete Workflow V2 chain',
      },
      {
        name: 'activation with a drifted V2 projection ledger digest', base: 'sealed',
        prepare: (database) => localPsql(`update nexus_private.workflow_projection_migrations set definition_digest=md5('drift') where id='202610040002_workflow_snapshot_proof_references';`, database),
        run: [ACTIVATE], message: 'V1 guard bridge activation requires the complete Workflow V2 chain',
      },
      {
        name: 'activation with a drifted seal ledger digest', base: 'sealed',
        prepare: (database) => localPsql(`update nexus_private.workflow_v1_bridge_migrations set definition_digest=md5('drift') where id='seal';`, database),
        run: [ACTIVATE], message: 'V1 guard bridge ledger is incompatible',
      },
      {
        name: 'activation with an unexpected bridge ledger entry', base: 'sealed',
        prepare: (database) => localPsql(`insert into nexus_private.workflow_v1_bridge_migrations values('extra','x','{}');`, database),
        run: [ACTIVATE], message: 'V1 guard bridge ledger is incompatible',
      },
      {
        name: 'activation after an owner disabled the seal', base: 'sealed',
        prepare: (database) => localPsql(`alter table public.pending_actions disable trigger workflow_pending_action_v1_bridge_seal;`, database),
        run: [ACTIVATE], message: 'V1 guard bridge activation requires the exact sealed trigger set',
      },
      {
        name: 'activation after a seal trigger was downgraded from ENABLE ALWAYS', base: 'sealed',
        prepare: (database) => localPsql(`alter table public.pending_actions enable trigger workflow_pending_action_v1_bridge_truncate_seal;`, database),
        run: [ACTIVATE], message: 'V1 guard bridge activation requires the exact sealed trigger set',
      },
      {
        name: 'activation after an owner bypassed the seal to change a legacy payload', base: 'sealed',
        prepare: (database) => localPsql(`alter table public.pending_actions disable trigger workflow_pending_action_v1_bridge_seal;
          update public.pending_actions set payload=jsonb_set(payload,'{preview}','"edited"') where id='w5-historical-01';
          alter table public.pending_actions enable always trigger workflow_pending_action_v1_bridge_seal;`, database),
        run: [ACTIVATE], message: 'V1 guard bridge found changed legacy pending actions',
      },
      {
        name: 'activation after an owner bypassed the seal to change a row version', base: 'sealed',
        prepare: (database) => localPsql(`alter table public.pending_actions disable trigger workflow_pending_action_v1_bridge_seal;
          update public.pending_actions set row_version=42 where id='w5-historical-01';
          alter table public.pending_actions enable always trigger workflow_pending_action_v1_bridge_seal;`, database),
        // The fence's full-row fingerprint (row_version included) catches it first.
        run: [ACTIVATE], message: 'V1 guard bridge found changed legacy pending actions',
      },
      {
        name: 'activation with a disabled Workflow V2 guard', base: 'sealed',
        prepare: (database) => localPsql(`alter table public.pending_actions disable trigger workflow_guard;`, database),
        run: [ACTIVATE], message: 'V1 guard bridge activation requires the exact sealed trigger set',
      },
      {
        name: 'activation with a missing Workflow V2 guard', base: 'sealed',
        prepare: (database) => localPsql(`drop trigger workflow_guard on public.pending_actions;`, database),
        run: [ACTIVATE], message: 'V1 guard bridge activation requires the exact sealed trigger set',
      },
      {
        name: 'activation with an unknown pending_actions trigger', base: 'sealed',
        prepare: (database) => localPsql(`create function public.w5_noop() returns trigger language plpgsql as $$ begin return new; end $$;
          create trigger w5_unknown before update on public.pending_actions for each row execute function public.w5_noop();
          alter table public.pending_actions disable trigger w5_unknown;`, database),
        run: [ACTIVATE], message: 'V1 guard bridge activation requires the exact sealed trigger set',
      },
      {
        name: 'activation after the write fence was lifted', base: 'sealed',
        prepare: (database) => localPsql(`grant insert on public.pending_actions to service_role;`, database),
        run: [ACTIVATE], message: 'V1 guard bridge fence was lifted before activation',
      },
      {
        name: 'activation after an extra role was granted a column write (P1-2)', base: 'sealed',
        prepare: (database) => localPsql(`grant update (payload) on public.pending_actions to ${scratchRole('late')};`, database),
        run: [ACTIVATE], message: 'V1 guard bridge fence was lifted before activation',
      },
      {
        name: 'a partial standalone install on the V2 proof lineage', base: 'v2-proof',
        prepare: (database) => localPsql(`create function nexus_private.standalone_pending_action_v1_body_valid(body jsonb) returns boolean language sql immutable as $$ select true $$;`, database),
        run: [FENCE], message: 'V1 guard bridge found a partial standalone installation',
      },
    ];

    for (const testCase of cases) {
      it(testCase.name, () => {
        let database: string;
        if (testCase.base === 'hosted-v1') {
          database = createScratchDatabase('fail');
          applyHostedV1(database);
          seedHistoricalV1(database);
        } else if (testCase.base === 'v2-proof') {
          database = createScratchDatabase('fail');
          apply(database, ['202610010001_concierge', ...V2_BASE]);
        } else if (testCase.base === 'sealed') {
          database = sealedState('fail');
        } else {
          database = preFenceState('fail');
          if (testCase.base === 'fenced' || testCase.base === 'completed') apply(database, [FENCE]);
          if (testCase.base === 'completed') apply(database, [COMPLETENESS]);
        }
        testCase.prepare(database);
        const state = catalogState(database);
        const rows = legacyRows(database);
        expect(failureOf(() => apply(database, testCase.run))).toContain(testCase.message);
        expect(catalogState(database)).toBe(state);
        expect(legacyRows(database)).toBe(rows);
      });
    }
  });
});
