-- Guarded V1 -> Workflow V2 bridge, step 3 of 3: ACTIVATE.
-- Runs after 202610040003_workflow_action_target_provenance (the end of the V2 chain).
--
-- Re-establishes the 202610010002 pending-action integrity contract inside the V2
-- schema, then restores the exact pending_actions ACL saved by step 1
-- (202610020003_workflow_v1_guard_bridge_fence) and removes the reject-all seal installed
-- by step 2 (202610030003_workflow_v1_guard_bridge_seal). Legacy rows
-- (workflow_contract_version IS NULL) keep the reviewed V1 rules: fresh rows start
-- pending and pass the frozen standalone_pending_action_v1_body_valid(), only
-- pending->claimed|stale and claimed->completed|stale transitions, an immutable approval
-- envelope, and no DELETE or TRUNCATE. Protected V2 rows stay governed by workflow_guard;
-- legacy rows can be neither promoted nor demoted. The guard sorts after workflow_guard,
-- so it validates the final NEW row, and on every write it requires the EXACT trigger
-- set (nexus_revision, workflow_guard and both bridge triggers, each present and firing,
-- nothing else): a missing or disabled Workflow V2 guard rejects the write.
--
-- Preflight (first activation): exact bridge ledger (fence + seal ids and digests), exact
-- Workflow V2 projection ledger (four ids and digests, nothing else), sealed trigger set
-- exactly {nexus_revision, workflow_guard, both seal triggers ENABLE ALWAYS}, frozen
-- standalone helper sources, legacy rows equal to the fence fingerprints (id+payload and
-- the full-row fingerprint over every column the fence saw), all rows equal to the seal
-- fingerprint, and no effective non-owner write privilege (every role in pg_roles that is
-- neither a superuser nor a member of the owner, pg_write_all_data membership included).
--
-- Lineages:
--   * No standalone ledger and no bridge ledger (Workflow V2 proof chain): no-op.
--   * Fence and seal ledgered, activation absent, V2 chain ledgers exact: activate.
--   * Activation ledgered with the exact guard source, owner, triggers and ACL: no-op.
--   * Anything else: raise 23514 and change nothing (fail closed).
--
-- Rollback notes: activation is one transaction; any failure leaves the sealed state
-- (every pending_actions write rejected). A deliberate post-activation rollback is a new
-- forward migration that drops the two bridge triggers and revokes writes again
-- (returning to the fenced state); never delete ledger rows by hand.
--
-- Lock bounds: lock_timeout=5s, statement_timeout=120s,
-- idle_in_transaction_session_timeout=60s and, on PostgreSQL 17+, transaction_timeout=180s.
begin;
set local lock_timeout='5s';
set local statement_timeout='120s';
set local idle_in_transaction_session_timeout='60s';
select pg_catalog.set_config('transaction_timeout','180s',true)
  from pg_catalog.pg_settings where name='transaction_timeout';
select pg_catalog.pg_advisory_xact_lock(20261006,1);
create temporary table workflow_v1_bridge_guard_source(source text not null) on commit drop;
insert into pg_temp.workflow_v1_bridge_guard_source values($guard$
declare prior public.pending_actions%rowtype; old_state text; new_state text;
begin
  -- Exact active inventory: the two Workflow V2 guards and both bridge triggers must be
  -- present and firing, and nothing else may exist. A later BEFORE trigger could rewrite
  -- NEW after validation, and a missing or disabled workflow_guard would leave protected
  -- rows unchecked; both reject every write (the 202610010002 posture).
  if (select count(*) from pg_catalog.pg_trigger t where t.tgrelid=tg_relid and not t.tgisinternal)<>4
    or (select count(*) from pg_catalog.pg_trigger t join (values
        ('nexus_revision',to_regprocedure('nexus_private.workflow_revision()')::oid,62),
        ('workflow_guard',to_regprocedure('nexus_private.workflow_guard()')::oid,31),
        ('workflow_pending_action_v1_bridge_guard',to_regprocedure('nexus_private.workflow_pending_action_v1_bridge_guard()')::oid,31),
        ('workflow_pending_action_v1_bridge_truncate_guard',to_regprocedure('nexus_private.workflow_pending_action_v1_bridge_guard()')::oid,34)
      ) expected(name,function_oid,kind) on t.tgname=expected.name and t.tgfoid=expected.function_oid and t.tgtype=expected.kind
      where t.tgrelid=tg_relid and not t.tgisinternal
        and (t.tgenabled='A' or (t.tgenabled='O' and current_setting('session_replication_role')<>'replica'))
        and t.tgnargs=0 and t.tgqual is null and t.tgattr=''::int2vector and t.tgconstraint=0)<>4 then
    raise exception 'Pending action active trigger inventory is incompatible' using errcode='23514';
  end if;
  if tg_op='TRUNCATE' then
    raise exception 'Pending action history cannot be truncated' using errcode='23514';
  end if;
  if tg_op='DELETE' then
    if old.workflow_contract_version is null then
      raise exception 'Legacy pending action history cannot be deleted' using errcode='23514';
    end if;
    return old;
  end if;
  if tg_op='UPDATE' and old.workflow_contract_version is distinct from new.workflow_contract_version then
    raise exception 'Legacy pending action marker cannot change' using errcode='23514';
  end if;
  if new.workflow_contract_version is not null then
    return new;
  end if;
  if new.payload->>'id' is distinct from new.id then
    raise exception 'Invalid legacy pending action identity' using errcode='23514';
  end if;
  if not nexus_private.standalone_pending_action_v1_body_valid(new.payload) then
    raise exception 'Invalid legacy pending action body' using errcode='23514';
  end if;
  if tg_op='INSERT' then
    -- BEFORE INSERT runs before an ON CONFLICT UPDATE; lock the existing key so a
    -- concurrent deletion cannot turn a terminal candidate into a fresh row.
    select * into prior from public.pending_actions where id=new.id for key share;
    if not found then
      if new.payload->>'status'<>'pending' then
        raise exception 'Legacy pending action must be prepared as pending' using errcode='23514';
      end if;
      return new;
    end if;
    if prior.workflow_contract_version is not null then
      raise exception 'Legacy pending action cannot replace a protected row' using errcode='23514';
    end if;
  else
    prior:=old;
    if new.id is distinct from old.id then
      raise exception 'Immutable legacy pending action identity' using errcode='23514';
    end if;
  end if;
  if not nexus_private.standalone_pending_action_v1_body_valid(prior.payload) then
    raise exception 'Invalid legacy pending action body' using errcode='23514';
  end if;
  old_state:=prior.payload->>'status'; new_state:=new.payload->>'status';
  if not (old_state=new_state or (old_state='pending' and new_state in('claimed','stale'))
    or (old_state='claimed' and new_state in('completed','stale'))) then
    raise exception 'Invalid legacy pending action transition' using errcode='23514';
  end if;
  if old_state='pending' and new_state='stale' then
    if (new.payload-array['status','rowVersion','supersededByActionId','staleReason'])
      is distinct from (prior.payload-array['status','rowVersion','supersededByActionId','staleReason']) then
      raise exception 'Immutable legacy pending action approval' using errcode='23514';
    end if;
  elsif (new.payload-array['status','rowVersion']) is distinct from (prior.payload-array['status','rowVersion']) then
    raise exception 'Immutable legacy pending action approval' using errcode='23514';
  end if;
  return new;
end
$guard$);
update pg_temp.workflow_v1_bridge_guard_source set source=replace(source,E'\r\n',E'\n');

do $activate$
declare
  standalone_ledger oid:=to_regclass('nexus_private.pending_action_v1_migrations');
  bridge_ledger oid:=to_regclass('nexus_private.workflow_v1_bridge_migrations');
  guard_function oid:=to_regprocedure('nexus_private.workflow_pending_action_v1_bridge_guard()');
  seal_function oid:=to_regprocedure('nexus_private.workflow_pending_action_v1_bridge_seal()');
  fence_digest constant text:=md5('workflow-v1-guard-bridge-fence:v2:a6b602b989af97760e2311cbbe79f78a');
  seal_source constant text:='begin raise exception ''Pending actions are sealed until the V1 guard bridge activates'' using errcode=''23514''; end';
  guard_source text; step_digest text; seal_digest text; owner_oid oid; owner_name text; service_oid oid;
  fence jsonb; seal jsonb; bridge_rows bigint; bridge_exact bigint; activation_digest text;
  legacy_md5 text; legacy_count bigint; rows_md5 text; row_count bigint; item record;
  fence_columns text[]; fence_rows_md5 text; fence_row_count bigint;
begin
  select source into strict guard_source from pg_temp.workflow_v1_bridge_guard_source;
  step_digest:=md5('workflow-v1-guard-bridge-activate:v2:row-before-31:statement-before-truncate-34:exact-inventory:'||guard_source);
  seal_digest:=md5('workflow-v1-guard-bridge-seal:v2:row-before-31-always:statement-before-truncate-34-always:'||seal_source);
  if to_regclass('public.pending_actions') is null or to_regclass('public.appmeta') is null then
    raise exception 'V1 guard bridge requires the concierge schema' using errcode='23514';
  end if;
  select c.relowner,r.rolname into owner_oid,owner_name from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid=c.relowner where c.oid='public.pending_actions'::regclass;
  select oid into service_oid from pg_catalog.pg_roles where rolname='service_role';
  if not pg_catalog.pg_has_role(current_user,owner_oid,'USAGE')
    and not (select rolsuper from pg_catalog.pg_roles where rolname=current_user) then
    raise exception 'V1 guard bridge requires table ownership' using errcode='42501';
  end if;
  lock table public.appmeta in access exclusive mode;
  lock table public.pending_actions in access exclusive mode;

  if standalone_ledger is null then
    if bridge_ledger is not null or guard_function is not null or seal_function is not null
      or exists(select 1 from pg_catalog.pg_trigger where tgrelid='public.pending_actions'::regclass
        and tgname in('workflow_pending_action_v1_bridge_guard','workflow_pending_action_v1_bridge_truncate_guard',
          'workflow_pending_action_v1_bridge_seal','workflow_pending_action_v1_bridge_truncate_seal',
          'standalone_pending_action_v1_guard','standalone_pending_action_v1_truncate_guard')) then
      raise exception 'V1 guard bridge found a partial installation without the standalone ledger' using errcode='23514';
    end if;
    return; -- Workflow V2 lineage without the standalone guard: nothing to activate.
  end if;
  if bridge_ledger is null then
    raise exception 'V1 guard bridge activation requires 202610020003 fence' using errcode='23514';
  end if;
  -- Exact bridge ledger: fence and seal with their digests, plus activation only if ours.
  execute 'select count(*),count(*) filter(where (id=''fence'' and definition_digest=$1) or (id=''seal'' and definition_digest=$2)),
      (select detail from nexus_private.workflow_v1_bridge_migrations where id=''fence''),
      (select detail from nexus_private.workflow_v1_bridge_migrations where id=''seal''),
      (select definition_digest from nexus_private.workflow_v1_bridge_migrations where id=''activate'')
    from nexus_private.workflow_v1_bridge_migrations'
    into bridge_rows,bridge_exact,fence,seal,activation_digest using fence_digest,seal_digest;
  if bridge_exact<>2 or bridge_rows<>(case when activation_digest is null then 2 else 3 end)
    or jsonb_typeof(fence->'acl') is distinct from 'string'
    or jsonb_typeof(fence->'legacyRowsMd5') is distinct from 'string'
    or jsonb_typeof(fence->'rowsMd5') is distinct from 'string'
    or jsonb_typeof(fence->'columns') is distinct from 'array'
    or jsonb_typeof(seal->'rowsMd5') is distinct from 'string' then
    raise exception 'V1 guard bridge ledger is incompatible' using errcode='23514';
  end if;
  if exists(select 1 from pg_catalog.pg_trigger where tgrelid='public.pending_actions'::regclass
      and tgname in('standalone_pending_action_v1_guard','standalone_pending_action_v1_truncate_guard')) then
    raise exception 'V1 guard bridge found standalone triggers after the fence' using errcode='23514';
  end if;
  -- The complete Workflow V2 chain, exactly: four reviewed ids and digests, nothing else.
  if to_regclass('nexus_private.workflow_projection_migrations') is null then
    raise exception 'V1 guard bridge activation requires the complete Workflow V2 chain' using errcode='23514';
  end if;
  if (select count(*) from nexus_private.workflow_projection_migrations)<>4
    or (select count(*) from nexus_private.workflow_projection_migrations m join (values
        ('202610030002_workflow_projection_completeness','a928d5ccae0697ec196ef75f828ea715'),
        ('202610040001_workflow_conversation_persistence','b34a44677e3760829a89eb2be87215a0'),
        ('202610040002_workflow_snapshot_proof_references','df4a9601ecddcda9a46fd74c447cf841'),
        ('202610040003_workflow_action_target_provenance','a442c7a76e4b04549875a604ab75605c')
      ) expected(id,digest) on m.id=expected.id and m.definition_digest=expected.digest)<>4 then
    raise exception 'V1 guard bridge activation requires the complete Workflow V2 chain' using errcode='23514';
  end if;
  if exists(select 1 from (values
      ('nexus_private.standalone_pending_action_v1_utf16_length(text)','26c2d85ed6325a491d2782a5b9e1ccdc'),
      ('nexus_private.standalone_pending_action_v1_body_valid(jsonb)','85c140aee92820ba0373ac6be36c7504')
    ) expected(signature,source_md5)
    left join pg_catalog.pg_proc p on p.oid=to_regprocedure(expected.signature)
    where p.oid is null or md5(p.prosrc)<>expected.source_md5 or p.proowner<>owner_oid
      or p.proconfig is distinct from array['search_path=""']) then
    raise exception 'V1 guard bridge found modified standalone functions' using errcode='23514';
  end if;
  if not exists(select 1 from pg_catalog.pg_proc where oid=seal_function and prosrc=seal_source
      and proowner=owner_oid and not prosecdef and proconfig=array['search_path=""']) then
    raise exception 'V1 guard bridge activation requires the 202610030003 seal function' using errcode='23514';
  end if;
  -- Legacy V1 rows must be byte-for-byte the rows the fence observed.
  select md5(coalesce(string_agg(id||E'\t'||payload::text,E'\n' order by id),'')),count(*)
    into legacy_md5,legacy_count from public.pending_actions where workflow_contract_version is null;

  if activation_digest is not null then
    if activation_digest is distinct from step_digest
      or not exists(select 1 from pg_catalog.pg_proc where oid=guard_function and prosrc=guard_source and prosecdef
        and proowner=owner_oid and proconfig=array['search_path=""'])
      or (select count(*) from pg_catalog.pg_trigger t where t.tgrelid='public.pending_actions'::regclass and not t.tgisinternal)<>4
      or (select count(*) from pg_catalog.pg_trigger t join (values
          ('nexus_revision',to_regprocedure('nexus_private.workflow_revision()')::oid,62),
          ('workflow_guard',to_regprocedure('nexus_private.workflow_guard()')::oid,31),
          ('workflow_pending_action_v1_bridge_guard',guard_function,31),
          ('workflow_pending_action_v1_bridge_truncate_guard',guard_function,34)
        ) expected(name,function_oid,kind) on t.tgname=expected.name and t.tgfoid=expected.function_oid and t.tgtype=expected.kind
        where t.tgrelid='public.pending_actions'::regclass and t.tgenabled in('O','A')
          and t.tgnargs=0 and t.tgqual is null and t.tgattr=''::int2vector and t.tgconstraint=0)<>4 then
      raise exception 'V1 guard bridge activation does not match its ledger' using errcode='23514';
    end if;
    return; -- Idempotent re-run.
  end if;

  fence_columns:=array(select jsonb_array_elements_text(fence->'columns'));
  select md5(coalesce(string_agg(r.body::text,E'\n' order by r.id),'')),count(*) into fence_rows_md5,fence_row_count
    from (select t.id,(select jsonb_object_agg(e.key,e.value) from jsonb_each(to_jsonb(t)) e
      where e.key=any(fence_columns)) body from public.pending_actions t) r;
  if legacy_md5 is distinct from fence->>'legacyRowsMd5' or legacy_count<>(fence->>'legacyRowCount')::bigint
    or fence_rows_md5 is distinct from fence->>'rowsMd5' or fence_row_count<>(fence->>'rowCount')::bigint then
    raise exception 'V1 guard bridge found changed legacy pending actions' using errcode='23514';
  end if;
  select md5(coalesce(string_agg(id||E'\t'||payload::text||E'\t'||coalesce(row_version::text,'')||E'\t'
      ||coalesce(workflow_contract_version::text,''),E'\n' order by id),'')),count(*)
    into rows_md5,row_count from public.pending_actions;
  if rows_md5 is distinct from seal->>'rowsMd5' or row_count<>(seal->>'rowCount')::bigint then
    raise exception 'V1 guard bridge found pending actions changed after the seal' using errcode='23514';
  end if;
  -- Exact sealed inventory: both Workflow V2 guards enabled, both seal triggers ENABLE ALWAYS.
  if guard_function is not null
    or (select count(*) from pg_catalog.pg_trigger t where t.tgrelid='public.pending_actions'::regclass and not t.tgisinternal)<>4
    or (select count(*) from pg_catalog.pg_trigger t join (values
        ('nexus_revision',to_regprocedure('nexus_private.workflow_revision()')::oid,62,'{O,A}'::"char"[]),
        ('workflow_guard',to_regprocedure('nexus_private.workflow_guard()')::oid,31,'{O,A}'::"char"[]),
        ('workflow_pending_action_v1_bridge_seal',seal_function,31,'{A}'::"char"[]),
        ('workflow_pending_action_v1_bridge_truncate_seal',seal_function,34,'{A}'::"char"[])
      ) expected(name,function_oid,kind,enabled) on t.tgname=expected.name and t.tgfoid=expected.function_oid
        and t.tgtype=expected.kind and t.tgenabled=any(expected.enabled)
      where t.tgrelid='public.pending_actions'::regclass
        and t.tgnargs=0 and t.tgqual is null and t.tgattr=''::int2vector and t.tgconstraint=0)<>4 then
    raise exception 'V1 guard bridge activation requires the exact sealed trigger set' using errcode='23514';
  end if;
  if exists(select 1 from pg_catalog.pg_roles r
      where not r.rolsuper and not pg_catalog.pg_has_role(r.oid,owner_oid,'MEMBER')
        and case when r.rolname='pg_write_all_data' then exists(select 1 from pg_catalog.pg_auth_members m
            join pg_catalog.pg_roles x on x.oid=m.member
            where m.roleid=r.oid and not x.rolsuper and not pg_catalog.pg_has_role(x.oid,owner_oid,'MEMBER'))
          else pg_catalog.has_table_privilege(r.oid,'public.pending_actions'::regclass,'INSERT,UPDATE,DELETE,TRUNCATE')
            or pg_catalog.has_any_column_privilege(r.oid,'public.pending_actions'::regclass,'INSERT,UPDATE') end) then
    raise exception 'V1 guard bridge fence was lifted before activation' using errcode='23514';
  end if;

  drop trigger workflow_pending_action_v1_bridge_seal on public.pending_actions;
  drop trigger workflow_pending_action_v1_bridge_truncate_seal on public.pending_actions;
  execute format('create function nexus_private.workflow_pending_action_v1_bridge_guard() returns trigger '
    'language plpgsql volatile security definer set search_path='''' as %L',guard_source);
  guard_function:=to_regprocedure('nexus_private.workflow_pending_action_v1_bridge_guard()');
  -- SECURITY DEFINER runs as its owner: pin it to the table owner, whoever runs this step.
  execute format('alter function nexus_private.workflow_pending_action_v1_bridge_guard() owner to %I',owner_name);
  revoke all on function nexus_private.workflow_pending_action_v1_bridge_guard() from public,anon,authenticated,service_role;
  create trigger workflow_pending_action_v1_bridge_guard before insert or update or delete on public.pending_actions
    for each row execute function nexus_private.workflow_pending_action_v1_bridge_guard();
  create trigger workflow_pending_action_v1_bridge_truncate_guard before truncate on public.pending_actions
    for each statement execute function nexus_private.workflow_pending_action_v1_bridge_guard();

  -- Restore exactly the write privileges the fence removed, granted by the owner.
  for item in select a.grantee,a.privilege_type
      from pg_catalog.aclexplode((fence->>'acl')::aclitem[]) a
      where a.privilege_type in('INSERT','UPDATE','DELETE','TRUNCATE') and a.grantee<>owner_oid loop
    if item.grantee<>service_oid then
      raise exception 'V1 guard bridge saved ACL grants writes to an unexpected role' using errcode='23514';
    end if;
    execute format('grant %s on public.pending_actions to service_role',item.privilege_type);
  end loop;
  if (select array_agg(row(a.grantor,a.grantee,a.privilege_type,a.is_grantable)::text order by a.grantee,a.privilege_type)
      from pg_catalog.pg_class c,lateral pg_catalog.aclexplode(c.relacl) a where c.oid='public.pending_actions'::regclass)
    is distinct from (select array_agg(row(a.grantor,a.grantee,a.privilege_type,a.is_grantable)::text order by a.grantee,a.privilege_type)
      from pg_catalog.aclexplode((fence->>'acl')::aclitem[]) a) then
    raise exception 'V1 guard bridge could not restore the saved pending action ACL' using errcode='23514';
  end if;
  if not exists(select 1 from pg_catalog.pg_proc where oid=guard_function and proowner=owner_oid and prosecdef)
    or (select count(*) from pg_catalog.pg_trigger t where t.tgrelid='public.pending_actions'::regclass
      and not t.tgisinternal and t.tgenabled in('O','A'))<>4 then
    raise exception 'V1 guard bridge activation could not install the exact guard set' using errcode='23514';
  end if;
  insert into nexus_private.workflow_v1_bridge_migrations values('activate',step_digest,
    jsonb_build_object('legacyRowsMd5',legacy_md5,'legacyRowCount',legacy_count,'rowsMd5',rows_md5,'rowCount',row_count));
end $activate$;
commit;
