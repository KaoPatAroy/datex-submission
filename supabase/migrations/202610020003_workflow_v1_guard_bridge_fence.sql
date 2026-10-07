-- Guarded V1 -> Workflow V2 bridge, step 1 of 3: FENCE.
-- Runs after 202610020002_workflow_v2 and before 202610030002_workflow_projection_completeness.
--
-- Why: 202610010002 (hosted) installs standalone_pending_action_v1_guard, which rejects
-- every pending_actions write once 202610020002 adds V2 columns, and 202610030002
-- refuses to install while that unknown trigger exists. This step retires the two
-- standalone triggers and, in the same transaction:
--   * validates the pending_actions ACL against the exact V1 allowlist accepted by
--     202610010002 (owner default privileges plus service_role holding either the source
--     grant {SELECT,INSERT,UPDATE,DELETE} or the hosted all-table-privileges grant; no
--     other grantee, grantor or grant option, no column ACL);
--   * revokes every non-owner write privilege and then proves, over every role in
--     pg_roles that is neither a superuser nor a member of the owner, that no effective
--     INSERT/UPDATE/DELETE/TRUNCATE (table or column level) remains, including through
--     pg_write_all_data;
--   * installs a reject-all fence for the owner too: the 202610030003 seal function as a
--     statement-level BEFORE INSERT/UPDATE/DELETE/TRUNCATE trigger, ENABLE ALWAYS (so it
--     fires under session_replication_role=replica as well). It is named
--     workflow_children on purpose: that is the only name the frozen 202610030002 both
--     tolerates on a manifest table and suspends/restores around its own backfill (any
--     other enabled trigger makes it refuse to install). 202610030003 replaces it with
--     the named seal triggers right after 202610030002;
--   * records the saved ACL and a full-row fingerprint over every pending_actions column
--     present now (id, payload, row_version, workflow_contract_version, ...), which the
--     seal and activation re-verify, so a change made in the fence -> seal gap by a
--     superuser or by an owner who first disabled the fence fails closed.
-- Step 3 (202610060001_workflow_v1_guard_bridge_activate) restores the exact saved ACL
-- together with an equivalent V1 guard that coexists with Workflow V2.
--
-- Lineages:
--   * No standalone ledger, function or trigger (Workflow V2 proof chain): no-op.
--   * Exact 202610010002 install (ledger digest a6b602b989af97760e2311cbbe79f78a, three
--     frozen function sources, both triggers, V1-allowlisted ACL, no completeness
--     ledger yet): fence.
--   * Already fenced (bridge ledger row 'fence', no standalone triggers, fence trigger
--     present until the seal replaces it): no-op.
--   * Anything else: raise 23514 and change nothing (fail closed).
--
-- Lock bounds: lock_timeout=5s (fail closed instead of queueing behind live traffic),
-- statement_timeout=120s, idle_in_transaction_session_timeout=60s and, where the server
-- supports it (PostgreSQL 17+), transaction_timeout=180s for the whole transaction.
-- Treat the bridge as maintenance-window downtime with writers paused (measured
-- durations: docs/BIZTANIA_WAVE5_LOCAL_PG.md).
--
-- Rollback notes: this is forward-only once 202610020002 is installed, because the
-- standalone guard rejects any table with more than two columns. Before activation,
-- PostgreSQL rejects every pending_actions write (fail closed). Pause writers and take a
-- backup/PITR point first. To abort the hosted rollout before step 3, restore the
-- pre-rollout backup/PITR snapshot; do not re-create the standalone triggers on the V2
-- table. The saved ACL is kept in nexus_private.workflow_v1_bridge_migrations.detail
-- for audit and for step 3.
begin;
set local lock_timeout='5s';
set local statement_timeout='120s';
set local idle_in_transaction_session_timeout='60s';
select pg_catalog.set_config('transaction_timeout','180s',true)
  from pg_catalog.pg_settings where name='transaction_timeout';
select pg_catalog.pg_advisory_xact_lock(20261006,1);
do $fence$
declare
  standalone_ledger oid:=to_regclass('nexus_private.pending_action_v1_migrations');
  bridge_ledger oid:=to_regclass('nexus_private.workflow_v1_bridge_migrations');
  guard_function oid:=to_regprocedure('nexus_private.standalone_pending_action_v1_guard()');
  seal_function oid:=to_regprocedure('nexus_private.workflow_pending_action_v1_bridge_seal()');
  seal_source constant text:='begin raise exception ''Pending actions are sealed until the V1 guard bridge activates'' using errcode=''23514''; end';
  fence_digest constant text:=md5('workflow-v1-guard-bridge-fence:v2:a6b602b989af97760e2311cbbe79f78a');
  owner_oid oid; owner_name text; service_oid oid; installed_digest text; trigger_count integer; ledger_count integer;
  saved_acl text; legacy_md5 text; legacy_count bigint; after_md5 text; after_count bigint;
  fence_columns text[]; rows_md5 text; row_count bigint; after_rows_md5 text; after_row_count bigint;
  fenced boolean:=false; sealed boolean:=false; activated boolean:=false; bridge_rows bigint;
begin
  if to_regclass('public.pending_actions') is null or to_regclass('public.appmeta') is null
    or to_regclass('nexus_private.workflow_manifest') is null
    or to_regprocedure('public.nexus_workflow_commit(bigint,jsonb)') is null
    or to_regprocedure('nexus_private.workflow_guard()') is null then
    raise exception 'V1 guard bridge requires 202610020002_workflow_v2' using errcode='23514';
  end if;
  select c.relowner,r.rolname into owner_oid,owner_name from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid=c.relowner where c.oid='public.pending_actions'::regclass;
  select oid into service_oid from pg_catalog.pg_roles where rolname='service_role';
  if not pg_catalog.pg_has_role(current_user,owner_oid,'USAGE')
    and not (select rolsuper from pg_catalog.pg_roles where rolname=current_user) then
    raise exception 'V1 guard bridge requires table ownership' using errcode='42501';
  end if;
  -- Serialize with nexus_commit (appmeta first) and with direct pending-action writers.
  lock table public.appmeta in access exclusive mode;
  lock table public.pending_actions in access exclusive mode;
  select count(*) into trigger_count from pg_catalog.pg_trigger
    where tgrelid='public.pending_actions'::regclass and not tgisinternal
      and tgname in('standalone_pending_action_v1_guard','standalone_pending_action_v1_truncate_guard');

  if bridge_ledger is not null then
    if not exists(select 1 from pg_catalog.pg_class where oid=bridge_ledger and relowner=owner_oid
        and relkind='r' and relpersistence='p' and relrowsecurity)
      or (select count(*) from pg_catalog.pg_attribute where attrelid=bridge_ledger and attnum>0 and not attisdropped)<>3
      or exists(select 1 from pg_catalog.pg_trigger where tgrelid=bridge_ledger and not tgisinternal)
      or exists(select 1 from pg_catalog.pg_class c,
          lateral pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
          where c.oid=bridge_ledger and a.grantee<>owner_oid) then
      raise exception 'V1 guard bridge ledger is incompatible' using errcode='23514';
    end if;
    execute 'select count(*) filter(where id=''fence'' and definition_digest=$1)=1,count(*) filter(where id=''seal'')=1,
        count(*) filter(where id=''activate'')=1,count(*) from nexus_private.workflow_v1_bridge_migrations'
      into fenced,sealed,activated,bridge_rows using fence_digest;
    if bridge_rows<>fenced::int+sealed::int+activated::int or (sealed and not fenced) or (activated and not sealed) then
      raise exception 'V1 guard bridge ledger contains unexpected entries' using errcode='23514';
    end if;
  end if;

  if standalone_ledger is null then
    if guard_function is not null or trigger_count<>0 or bridge_ledger is not null or seal_function is not null
      or to_regprocedure('nexus_private.standalone_pending_action_v1_body_valid(jsonb)') is not null then
      raise exception 'V1 guard bridge found a partial standalone installation' using errcode='23514';
    end if;
    return; -- Workflow V2 lineage without the standalone guard: nothing to bridge.
  end if;

  -- Exact 202610010002 ledger: one row with the hosted-verified digest.
  execute 'select count(*),max(definition_digest) from nexus_private.pending_action_v1_migrations'
    into ledger_count,installed_digest;
  if ledger_count<>1 or installed_digest is distinct from 'a6b602b989af97760e2311cbbe79f78a'
    or not exists(select 1 from nexus_private.pending_action_v1_migrations
      where id='202610010002_workflow_pending_action_v1_guard') then
    raise exception 'V1 guard bridge requires the exact 202610010002 ledger' using errcode='23514';
  end if;
  -- The three frozen standalone functions keep their reviewed sources (CRLF-normalized
  -- at install time by 202610010002). Step 2 reuses body_valid and utf16_length.
  if exists(select 1 from (values
      ('nexus_private.standalone_pending_action_v1_utf16_length(text)','26c2d85ed6325a491d2782a5b9e1ccdc'),
      ('nexus_private.standalone_pending_action_v1_body_valid(jsonb)','85c140aee92820ba0373ac6be36c7504'),
      ('nexus_private.standalone_pending_action_v1_guard()','291d294c3536abc223d2aba370de8183')
    ) expected(signature,source_md5)
    left join pg_catalog.pg_proc p on p.oid=to_regprocedure(expected.signature)
    where p.oid is null or md5(p.prosrc)<>expected.source_md5 or p.proowner<>owner_oid
      or p.proconfig is distinct from array['search_path=""']) then
    raise exception 'V1 guard bridge found modified standalone functions' using errcode='23514';
  end if;

  if fenced then
    -- Until the seal replaces it, the exact reject-all fence trigger must still be in place.
    if trigger_count<>0 or activated and not exists(select 1 from pg_catalog.pg_trigger
        where tgrelid='public.pending_actions'::regclass and tgname='workflow_pending_action_v1_bridge_guard')
      or sealed and exists(select 1 from pg_catalog.pg_trigger
        where tgrelid='public.pending_actions'::regclass and tgname='workflow_children')
      or not sealed and (not exists(select 1 from pg_catalog.pg_proc where oid=seal_function and prosrc=seal_source
          and proowner=owner_oid and not prosecdef and proconfig=array['search_path=""'])
        or not exists(select 1 from pg_catalog.pg_trigger t where t.tgrelid='public.pending_actions'::regclass
          and t.tgname='workflow_children' and t.tgfoid=seal_function and t.tgtype=62 and t.tgenabled='A'
          and t.tgnargs=0 and t.tgqual is null and t.tgattr=''::int2vector and t.tgconstraint=0)) then
      raise exception 'V1 guard bridge fence ledger does not match installed triggers' using errcode='23514';
    end if;
    return; -- Idempotent re-run.
  end if;
  if activated or sealed then
    raise exception 'V1 guard bridge seal or activation is ledgered without its fence' using errcode='23514';
  end if;

  -- First application on the exact guarded V1 + V2 base state.
  if to_regclass('nexus_private.workflow_projection_migrations') is not null then
    raise exception 'V1 guard bridge fence must run before 202610030002' using errcode='23514';
  end if;
  if exists(select 1 from (values('standalone_pending_action_v1_guard',31),('standalone_pending_action_v1_truncate_guard',34)) expected(name,kind)
      left join pg_catalog.pg_trigger t on t.tgrelid='public.pending_actions'::regclass and t.tgname=expected.name
      where t.oid is null or t.tgfoid<>guard_function or t.tgtype<>expected.kind or t.tgenabled not in('O','A')
        or t.tgnargs<>0 or t.tgqual is not null or t.tgattr<>''::int2vector or t.tgconstraint<>0) then
    raise exception 'V1 guard bridge requires both exact standalone triggers' using errcode='23514';
  end if;
  if exists(select 1 from pg_catalog.pg_trigger t where t.tgrelid='public.pending_actions'::regclass
      and not t.tgisinternal and t.tgname not in('standalone_pending_action_v1_guard',
        'standalone_pending_action_v1_truncate_guard','workflow_guard','nexus_revision')) then
    raise exception 'V1 guard bridge found an unknown pending action trigger' using errcode='23514';
  end if;
  if seal_function is not null then
    raise exception 'V1 guard bridge found a preexisting seal function' using errcode='23514';
  end if;
  if exists(select 1 from public.pending_actions where workflow_contract_version is not null) then
    raise exception 'V1 guard bridge found protected rows before activation' using errcode='23514';
  end if;
  if (select workflow_adapter_write from public.appmeta where singleton=1) is distinct from 0 then
    raise exception 'V1 guard bridge metadata is busy' using errcode='23514';
  end if;

  -- The ACL must still be exactly a V1 shape accepted by 202610010002: owner default
  -- privileges, service_role with the source grant or the hosted all-table-privileges
  -- grant, nothing else (no other grantee, grantor or grant option, no column ACL).
  if service_oid is null or exists(select 1 from pg_catalog.pg_class c,
        lateral pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
        where c.oid='public.pending_actions'::regclass
          and (a.grantee not in(owner_oid,service_oid) or a.grantor<>owner_oid or a.is_grantable))
    or array(select a.privilege_type from pg_catalog.pg_class c,
        lateral pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
        where c.oid='public.pending_actions'::regclass and a.grantee=owner_oid order by a.privilege_type)
      is distinct from array(select a.privilege_type from pg_catalog.aclexplode(pg_catalog.acldefault('r',owner_oid)) a
        where a.grantee=owner_oid order by a.privilege_type)
    or array(select a.privilege_type from pg_catalog.pg_class c,
        lateral pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
        where c.oid='public.pending_actions'::regclass and a.grantee=service_oid order by a.privilege_type)
      not in(array['DELETE','INSERT','SELECT','UPDATE'],
        array(select a.privilege_type from pg_catalog.aclexplode(pg_catalog.acldefault('r',owner_oid)) a
          where a.grantee=owner_oid order by a.privilege_type))
    or exists(select 1 from pg_catalog.pg_attribute where attrelid='public.pending_actions'::regclass
      and attnum>0 and not attisdropped and attacl is not null) then
    raise exception 'V1 guard bridge found a pending action ACL outside the V1 allowlist' using errcode='23514';
  end if;

  select relacl::text into saved_acl from pg_catalog.pg_class where oid='public.pending_actions'::regclass;
  select md5(coalesce(string_agg(id||E'\t'||payload::text,E'\n' order by id),'')),count(*)
    into legacy_md5,legacy_count from public.pending_actions;
  -- Full-row fingerprint over every column present now (row_version and the V2 marker
  -- included); later steps compare exactly these columns.
  select array_agg(attname::text order by attnum) into fence_columns from pg_catalog.pg_attribute
    where attrelid='public.pending_actions'::regclass and attnum>0 and not attisdropped;
  select md5(coalesce(string_agg(r.body::text,E'\n' order by r.id),'')),count(*) into rows_md5,row_count
    from (select t.id,(select jsonb_object_agg(e.key,e.value) from jsonb_each(to_jsonb(t)) e
      where e.key=any(fence_columns)) body from public.pending_actions t) r;

  if bridge_ledger is null then
    create table nexus_private.workflow_v1_bridge_migrations(
      id text primary key, definition_digest text not null, detail jsonb not null);
    alter table nexus_private.workflow_v1_bridge_migrations enable row level security;
    revoke all on nexus_private.workflow_v1_bridge_migrations from public,anon,authenticated,service_role;
  end if;

  revoke insert,update,delete,truncate on public.pending_actions from public,anon,authenticated,service_role;
  -- Effective write privileges: no role other than a superuser or a member of the owner
  -- may write, directly, through membership, through column grants or through
  -- pg_write_all_data (whose own membership is checked because SET ROLE reaches it).
  if exists(select 1 from pg_catalog.pg_roles r
      where not r.rolsuper and not pg_catalog.pg_has_role(r.oid,owner_oid,'MEMBER')
        and case when r.rolname='pg_write_all_data' then exists(select 1 from pg_catalog.pg_auth_members m
            join pg_catalog.pg_roles x on x.oid=m.member
            where m.roleid=r.oid and not x.rolsuper and not pg_catalog.pg_has_role(x.oid,owner_oid,'MEMBER'))
          else pg_catalog.has_table_privilege(r.oid,'public.pending_actions'::regclass,'INSERT,UPDATE,DELETE,TRUNCATE')
            or pg_catalog.has_any_column_privilege(r.oid,'public.pending_actions'::regclass,'INSERT,UPDATE') end) then
    raise exception 'V1 guard bridge fence left a non-owner write path' using errcode='23514';
  end if;
  drop trigger standalone_pending_action_v1_guard on public.pending_actions;
  drop trigger standalone_pending_action_v1_truncate_guard on public.pending_actions;
  -- Reject-all fence for the owner and replica mode (see the header for the name).
  execute format('create function nexus_private.workflow_pending_action_v1_bridge_seal() returns trigger '
    'language plpgsql volatile security invoker set search_path='''' as %L',seal_source);
  execute format('alter function nexus_private.workflow_pending_action_v1_bridge_seal() owner to %I',owner_name);
  revoke all on function nexus_private.workflow_pending_action_v1_bridge_seal() from public,anon,authenticated,service_role;
  create trigger workflow_children before insert or update or delete or truncate on public.pending_actions
    for each statement execute function nexus_private.workflow_pending_action_v1_bridge_seal();
  alter table public.pending_actions enable always trigger workflow_children;

  select md5(coalesce(string_agg(id||E'\t'||payload::text,E'\n' order by id),'')),count(*)
    into after_md5,after_count from public.pending_actions;
  select md5(coalesce(string_agg(r.body::text,E'\n' order by r.id),'')),count(*) into after_rows_md5,after_row_count
    from (select t.id,(select jsonb_object_agg(e.key,e.value) from jsonb_each(to_jsonb(t)) e
      where e.key=any(fence_columns)) body from public.pending_actions t) r;
  if after_md5 is distinct from legacy_md5 or after_count<>legacy_count
    or after_rows_md5 is distinct from rows_md5 or after_row_count<>row_count then
    raise exception 'V1 guard bridge fence changed pending action data' using errcode='23514';
  end if;
  insert into nexus_private.workflow_v1_bridge_migrations values('fence',fence_digest,
    jsonb_build_object('acl',saved_acl,'legacyRowsMd5',legacy_md5,'legacyRowCount',legacy_count,
      'columns',to_jsonb(fence_columns),'rowsMd5',rows_md5,'rowCount',row_count));
end $fence$;
commit;
