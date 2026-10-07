-- Guarded V1 -> Workflow V2 bridge, step 2 of 3: SEAL.
-- Runs after 202610030002_workflow_projection_completeness and before
-- 202610040001_workflow_conversation_persistence.
--
-- Why: the fence (202610020003) revokes every non-owner write on public.pending_actions
-- and installs a reject-all statement trigger under the one name the frozen
-- 202610030002 suspends and restores (workflow_children), because 202610030002 refuses
-- to run while any other trigger is enabled on a manifest table. This step runs as soon
-- as 202610030002 has finished and replaces that temporary fence trigger with the named
-- reject-all seal (same function, created by the fence):
--   * workflow_pending_action_v1_bridge_seal          BEFORE INSERT/UPDATE/DELETE, row
--   * workflow_pending_action_v1_bridge_truncate_seal BEFORE TRUNCATE, statement
-- both ENABLE ALWAYS (they also fire under session_replication_role=replica). Every
-- pending_actions write (owner, service_role, nexus_commit, nexus_workflow_commit) is
-- rejected until 202610060001_workflow_v1_guard_bridge_activate verifies the sealed state
-- and replaces the seal with the V1 bridge guard. Before sealing, this step proves that
-- the fence trigger is still exactly in place, that no non-owner role regained a write
-- path, and that every row still equals the fence's full-row fingerprint (every column
-- the fence saw: id, payload, row_version, workflow_contract_version), so a change made
-- in the fence -> seal gap by a superuser, or by an owner who disabled the fence trigger,
-- fails closed instead of becoming the baseline. It then records the seal fingerprint
-- (id, payload, row_version, workflow_contract_version) that activation re-checks.
--
-- Lineages:
--   * No standalone ledger and no bridge ledger (Workflow V2 proof chain): no-op.
--   * Fence ledgered, seal absent, exact 202610030002 ledger: seal.
--   * Seal ledgered with the exact function, triggers and digest: no-op.
--   * Anything else: raise 23514 and change nothing (fail closed).
--
-- Lock bounds: lock_timeout=5s, statement_timeout=120s,
-- idle_in_transaction_session_timeout=60s and, on PostgreSQL 17+, transaction_timeout=180s.
--
-- Rollback notes: forward-only. While sealed, every pending_actions write fails closed.
-- To abort before activation, restore the pre-rollout backup/PITR snapshot.
begin;
set local lock_timeout='5s';
set local statement_timeout='120s';
set local idle_in_transaction_session_timeout='60s';
select pg_catalog.set_config('transaction_timeout','180s',true)
  from pg_catalog.pg_settings where name='transaction_timeout';
select pg_catalog.pg_advisory_xact_lock(20261006,1);
do $seal$
declare
  standalone_ledger oid:=to_regclass('nexus_private.pending_action_v1_migrations');
  bridge_ledger oid:=to_regclass('nexus_private.workflow_v1_bridge_migrations');
  seal_function oid:=to_regprocedure('nexus_private.workflow_pending_action_v1_bridge_seal()');
  seal_source constant text:='begin raise exception ''Pending actions are sealed until the V1 guard bridge activates'' using errcode=''23514''; end';
  seal_digest text; fence_digest constant text:=md5('workflow-v1-guard-bridge-fence:v2:a6b602b989af97760e2311cbbe79f78a');
  owner_oid oid; fence jsonb; fence_columns text[]; fence_rows_md5 text; fence_row_count bigint; fenced boolean; sealed boolean; activated boolean; bridge_rows bigint;
  ledger_fence_digest text; ledger_seal_digest text; legacy_md5 text; legacy_count bigint; rows_md5 text; row_count bigint;
begin
  seal_digest:=md5('workflow-v1-guard-bridge-seal:v2:row-before-31-always:statement-before-truncate-34-always:'||seal_source);
  if to_regclass('public.pending_actions') is null or to_regclass('public.appmeta') is null then
    raise exception 'V1 guard bridge requires the concierge schema' using errcode='23514';
  end if;
  select relowner into owner_oid from pg_catalog.pg_class where oid='public.pending_actions'::regclass;
  if not pg_catalog.pg_has_role(current_user,owner_oid,'USAGE')
    and not (select rolsuper from pg_catalog.pg_roles where rolname=current_user) then
    raise exception 'V1 guard bridge requires table ownership' using errcode='42501';
  end if;
  lock table public.appmeta in access exclusive mode;
  lock table public.pending_actions in access exclusive mode;

  if standalone_ledger is null then
    if bridge_ledger is not null or seal_function is not null
      or exists(select 1 from pg_catalog.pg_trigger where tgrelid='public.pending_actions'::regclass
        and tgname in('workflow_pending_action_v1_bridge_seal','workflow_pending_action_v1_bridge_truncate_seal')) then
      raise exception 'V1 guard bridge found a partial seal without the standalone ledger' using errcode='23514';
    end if;
    return; -- Workflow V2 lineage without the standalone guard: nothing to seal.
  end if;
  if bridge_ledger is null then
    raise exception 'V1 guard bridge seal requires 202610020003 fence' using errcode='23514';
  end if;
  execute 'select count(*) filter(where id=''fence'')=1,count(*) filter(where id=''seal'')=1,
      count(*) filter(where id=''activate'')=1,count(*),
      (select detail from nexus_private.workflow_v1_bridge_migrations where id=''fence''),
      (select definition_digest from nexus_private.workflow_v1_bridge_migrations where id=''fence''),
      (select definition_digest from nexus_private.workflow_v1_bridge_migrations where id=''seal'')
    from nexus_private.workflow_v1_bridge_migrations'
    into fenced,sealed,activated,bridge_rows,fence,ledger_fence_digest,ledger_seal_digest;
  if not fenced or ledger_fence_digest is distinct from fence_digest
    or (activated and not sealed) or bridge_rows<>1+sealed::int+activated::int
    or (sealed and ledger_seal_digest is distinct from seal_digest)
    or jsonb_typeof(fence->'legacyRowsMd5') is distinct from 'string'
    or jsonb_typeof(fence->'rowsMd5') is distinct from 'string'
    or jsonb_typeof(fence->'columns') is distinct from 'array' then
    raise exception 'V1 guard bridge ledger is incompatible' using errcode='23514';
  end if;

  if sealed then
    if not exists(select 1 from pg_catalog.pg_proc where oid=seal_function and prosrc=seal_source
        and proowner=owner_oid and not prosecdef and proconfig=array['search_path=""'])
      or (not activated and (select count(*) from pg_catalog.pg_trigger t where t.tgrelid='public.pending_actions'::regclass
        and t.tgfoid=seal_function and t.tgenabled='A' and t.tgnargs=0 and t.tgqual is null and t.tgattr=''::int2vector
        and ((t.tgname='workflow_pending_action_v1_bridge_seal' and t.tgtype=31)
          or (t.tgname='workflow_pending_action_v1_bridge_truncate_seal' and t.tgtype=34)))<>2)
      or (activated and exists(select 1 from pg_catalog.pg_trigger t where t.tgrelid='public.pending_actions'::regclass
        and t.tgfoid=seal_function))
      or exists(select 1 from pg_catalog.pg_trigger t where t.tgrelid='public.pending_actions'::regclass
        and t.tgname='workflow_children') then
      raise exception 'V1 guard bridge seal does not match its ledger' using errcode='23514';
    end if;
    return; -- Idempotent re-run.
  end if;

  -- First application: the exact fenced state right after 202610030002.
  if to_regclass('nexus_private.workflow_projection_migrations') is null then
    raise exception 'V1 guard bridge seal requires 202610030002_workflow_projection_completeness' using errcode='23514';
  end if;
  if (select count(*) from nexus_private.workflow_projection_migrations
      where id='202610030002_workflow_projection_completeness' and definition_digest='a928d5ccae0697ec196ef75f828ea715')<>1 then
    raise exception 'V1 guard bridge seal requires 202610030002_workflow_projection_completeness' using errcode='23514';
  end if;
  -- The fence's reject-all trigger must have survived 202610030002 exactly (restored to
  -- ENABLE ALWAYS), with the exact fence-created function, and nothing else may exist.
  if not exists(select 1 from pg_catalog.pg_proc where oid=seal_function and prosrc=seal_source
        and proowner=owner_oid and not prosecdef and proconfig=array['search_path=""'])
    or not exists(select 1 from pg_catalog.pg_trigger t where t.tgrelid='public.pending_actions'::regclass
        and t.tgname='workflow_children' and t.tgfoid=seal_function and t.tgtype=62 and t.tgenabled='A'
        and t.tgnargs=0 and t.tgqual is null and t.tgattr=''::int2vector and t.tgconstraint=0) then
    raise exception 'V1 guard bridge seal requires the intact 202610020003 fence trigger' using errcode='23514';
  end if;
  if exists(select 1 from pg_catalog.pg_trigger t where t.tgrelid='public.pending_actions'::regclass
      and not t.tgisinternal and t.tgname not in('workflow_guard','nexus_revision','workflow_children')) then
    raise exception 'V1 guard bridge found an unknown pending action trigger or function' using errcode='23514';
  end if;
  if (select count(*) from (values
      ('workflow_guard',to_regprocedure('nexus_private.workflow_guard()')::oid,31),
      ('nexus_revision',to_regprocedure('nexus_private.workflow_revision()')::oid,62)) expected(name,function_oid,kind)
    join pg_catalog.pg_trigger t on t.tgrelid='public.pending_actions'::regclass and t.tgname=expected.name
      and t.tgfoid=expected.function_oid and t.tgtype=expected.kind and t.tgenabled in('O','A')
      and t.tgnargs=0 and t.tgqual is null and t.tgattr=''::int2vector and t.tgconstraint=0)<>2 then
    raise exception 'V1 guard bridge seal requires the enabled Workflow V2 guards' using errcode='23514';
  end if;
  if exists(select 1 from pg_catalog.pg_roles r
      where not r.rolsuper and not pg_catalog.pg_has_role(r.oid,owner_oid,'MEMBER')
        and case when r.rolname='pg_write_all_data' then exists(select 1 from pg_catalog.pg_auth_members m
            join pg_catalog.pg_roles x on x.oid=m.member
            where m.roleid=r.oid and not x.rolsuper and not pg_catalog.pg_has_role(x.oid,owner_oid,'MEMBER'))
          else pg_catalog.has_table_privilege(r.oid,'public.pending_actions'::regclass,'INSERT,UPDATE,DELETE,TRUNCATE')
            or pg_catalog.has_any_column_privilege(r.oid,'public.pending_actions'::regclass,'INSERT,UPDATE') end) then
    raise exception 'V1 guard bridge fence was lifted before the seal' using errcode='23514';
  end if;
  if exists(select 1 from public.pending_actions where workflow_contract_version is not null) then
    raise exception 'V1 guard bridge found protected rows before activation' using errcode='23514';
  end if;
  select md5(coalesce(string_agg(id||E'\t'||payload::text,E'\n' order by id),'')),count(*)
    into legacy_md5,legacy_count from public.pending_actions;
  fence_columns:=array(select jsonb_array_elements_text(fence->'columns'));
  select md5(coalesce(string_agg(r.body::text,E'\n' order by r.id),'')),count(*) into fence_rows_md5,fence_row_count
    from (select t.id,(select jsonb_object_agg(e.key,e.value) from jsonb_each(to_jsonb(t)) e
      where e.key=any(fence_columns)) body from public.pending_actions t) r;
  if legacy_md5 is distinct from fence->>'legacyRowsMd5' or legacy_count<>(fence->>'legacyRowCount')::bigint
    or fence_rows_md5 is distinct from fence->>'rowsMd5' or fence_row_count<>(fence->>'rowCount')::bigint then
    raise exception 'V1 guard bridge found changed legacy pending actions' using errcode='23514';
  end if;

  drop trigger workflow_children on public.pending_actions;
  create trigger workflow_pending_action_v1_bridge_seal before insert or update or delete on public.pending_actions
    for each row execute function nexus_private.workflow_pending_action_v1_bridge_seal();
  create trigger workflow_pending_action_v1_bridge_truncate_seal before truncate on public.pending_actions
    for each statement execute function nexus_private.workflow_pending_action_v1_bridge_seal();
  alter table public.pending_actions enable always trigger workflow_pending_action_v1_bridge_seal;
  alter table public.pending_actions enable always trigger workflow_pending_action_v1_bridge_truncate_seal;

  select md5(coalesce(string_agg(id||E'\t'||payload::text||E'\t'||coalesce(row_version::text,'')||E'\t'
      ||coalesce(workflow_contract_version::text,''),E'\n' order by id),'')),count(*)
    into rows_md5,row_count from public.pending_actions;
  insert into nexus_private.workflow_v1_bridge_migrations values('seal',seal_digest,
    jsonb_build_object('rowsMd5',rows_md5,'rowCount',row_count));
end $seal$;
commit;
