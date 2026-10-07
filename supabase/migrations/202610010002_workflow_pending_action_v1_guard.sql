-- Standalone V1 pending-action integrity guard. Apply this exact reviewed file
-- after 202610010001_concierge.sql; Track A does not install the V2 platform.
-- The SQLite contract twin is legacyPendingActionBodyCheck / pendingActionV1*
-- in lib/storage/workflow-sqlite-migrations.ts. Fresh rows must start pending;
-- DELETE/TRUNCATE are additionally fenced to prevent action-id resurrection.
begin;
create temporary table standalone_pending_v1_contract(
  signature text primary key, arguments text not null, result_type text not null,
  volatility text not null, language_name text not null, definer boolean not null,
  strict_args boolean not null, source text not null
) on commit drop;
insert into pg_temp.standalone_pending_v1_contract values
('nexus_private.standalone_pending_action_v1_utf16_length(text)','value text','integer','immutable','sql',false,true,$body$
select coalesce(sum(case when item='' then 0 when ascii(item)>65535 then 2 else 1 end),0)::integer
from regexp_split_to_table(value,'') chars(item)
$body$),
('nexus_private.standalone_pending_action_v1_guard()','','trigger','volatile','plpgsql',true,false,$body$
declare prior public.pending_actions%rowtype; new_row jsonb; old_row jsonb;
  old_state text; new_state text;
begin
  if tg_op='TRUNCATE' then
    raise exception 'Pending action history cannot be truncated' using errcode='23514';
  end if;
  if tg_op<>'INSERT' then old_row:=to_jsonb(old); end if;
  if tg_op<>'DELETE' then new_row:=to_jsonb(new); end if;
  -- Track A supports the original two-column V1 table only. V2 requires a
  -- separately reviewed atomic bridge; no other guard can bypass this one.
  if (old_row is not null and (select count(*) from jsonb_object_keys(old_row))<>2)
    or (new_row is not null and (select count(*) from jsonb_object_keys(new_row))<>2) then
    raise exception 'Standalone pending action requires a reviewed V2 bridge' using errcode='23514';
  end if;
  -- The hosted service role has TRIGGER privilege. Recheck composition on each
  -- write so a later application trigger cannot rewrite NEW after validation.
  if exists(select 1 from pg_catalog.pg_trigger t where t.tgrelid=tg_relid
    and not t.tgisinternal and t.tgenabled<>'D' and not exists(
      select 1 from (values
        ('nexus_revision',to_regprocedure('nexus_private.bump_revision()')::oid,60),
        ('standalone_pending_action_v1_guard',to_regprocedure('nexus_private.standalone_pending_action_v1_guard()')::oid,31),
        ('standalone_pending_action_v1_truncate_guard',to_regprocedure('nexus_private.standalone_pending_action_v1_guard()')::oid,34)
      ) expected(name,function_oid,kind)
      where t.tgname=expected.name and t.tgfoid=expected.function_oid and t.tgtype=expected.kind
        and (t.tgenabled='A' or (t.tgenabled='O' and current_setting('session_replication_role')<>'replica'))
        and t.tgnargs=0 and t.tgqual is null and t.tgattr=''::int2vector and t.tgconstraint=0
    )) then
    raise exception 'Standalone pending action active trigger inventory is incompatible' using errcode='23514';
  end if;
  if tg_op='DELETE' then
    raise exception 'Legacy pending action history cannot be deleted' using errcode='23514';
  end if;
  if new.payload->>'id' is distinct from new.id then
    raise exception 'Invalid legacy pending action identity' using errcode='23514';
  end if;
  if not nexus_private.standalone_pending_action_v1_body_valid(new.payload) then
    raise exception 'Invalid legacy pending action body' using errcode='23514';
  end if;
  if tg_op='INSERT' then
    -- PostgreSQL executes BEFORE INSERT before the conflict UPDATE. Lock the
    -- existing key so a concurrent deletion cannot turn a terminal candidate
    -- into a fresh row. The actual UPDATE revalidates its authoritative OLD.
    -- https://www.postgresql.org/docs/16/trigger-definition.html
    select * into prior from public.pending_actions where id=new.id for key share;
    if not found then
      if new.payload->>'status'<>'pending' then
        raise exception 'Legacy pending action must be prepared as pending' using errcode='23514';
      end if;
      return new;
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
$body$),
('nexus_private.standalone_pending_action_v1_body_valid(jsonb)','body jsonb','boolean','immutable','plpgsql',false,false,$body$
declare field text; line jsonb;
begin
  if jsonb_typeof(body) is distinct from 'object' then return false; end if;
  if exists(select 1 from jsonb_object_keys(body) k(key) where k.key <> all(array[
    'id','actorId','sessionId','conversationId','turnId','mode','modeRevision','payload',
    'payloadHash','evidenceVersion','packs','receiptAccess','releaseRevision','actionContractVersion',
    'approvalScope','approvalDisplay','predecessorActionId','supersededByActionId',
    'staleReason','revisionDiff','createdAt','expiresAt','status','preview'
  ])) then return false; end if;
  foreach field in array array['id','actorId','sessionId','conversationId','turnId'] loop
    if jsonb_typeof(body->field) is distinct from 'string'
      or nexus_private.standalone_pending_action_v1_utf16_length(body->>field) not between 1 and 300 then return false; end if;
  end loop;
  if jsonb_typeof(body->'mode') is distinct from 'string' or body->>'mode' not in('live_ai','scripted_demo')
    or jsonb_typeof(body->'modeRevision') is distinct from 'number' then return false; end if;
  if (body->>'modeRevision') !~ '^(0|[1-9][0-9]*)$'
    or (body->>'modeRevision')::numeric > 9007199254740991 then return false; end if;
  if jsonb_typeof(body->'payloadHash') is distinct from 'string'
    or nexus_private.standalone_pending_action_v1_utf16_length(body->>'payloadHash') < 1
    or jsonb_typeof(body->'packs') is distinct from 'array' then return false; end if;
  -- The ? operator preserves the distinction between absent and JSON null.
  if (body ? 'evidenceVersion' and jsonb_typeof(body->'evidenceVersion') not in('null','string'))
    or (body ? 'releaseRevision' and jsonb_typeof(body->'releaseRevision') is distinct from 'string')
    or (body ? 'actionContractVersion' and (jsonb_typeof(body->'actionContractVersion') is distinct from 'number'
      or body->>'actionContractVersion' is distinct from '1')) then return false; end if;
  foreach field in array array['predecessorActionId','supersededByActionId'] loop
    if body ? field and (jsonb_typeof(body->field) is distinct from 'string'
      or nexus_private.standalone_pending_action_v1_utf16_length(body->>field) not between 1 and 300) then return false; end if;
  end loop;
  if (body ? 'predecessorActionId') is distinct from (body ? 'revisionDiff') then return false; end if;
  if body ? 'revisionDiff' then
    if jsonb_typeof(body->'revisionDiff') is distinct from 'array' then return false; end if;
    if jsonb_array_length(body->'revisionDiff') not between 1 and 32 then return false; end if;
    for line in select value from jsonb_array_elements(body->'revisionDiff') loop
      if jsonb_typeof(line) is distinct from 'string'
        or nexus_private.standalone_pending_action_v1_utf16_length(line #>> '{}') not between 1 and 600
        or length(btrim(line #>> '{}',U&'\0009\000A\000B\000C\000D \00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'))=0 then return false; end if;
    end loop;
  end if;
  if body ? 'staleReason' then
    if jsonb_typeof(body->'staleReason') is distinct from 'string'
      or body->>'staleReason' not in('superseded','user_cancelled','expired','mode_changed',
        'release_changed','evidence_changed','source_turn_failed','source_turn_cancelled') then return false; end if;
  end if;
  if body ? 'supersededByActionId' then
    if body->>'staleReason' is distinct from 'superseded' then return false; end if;
  elsif body->>'staleReason'='superseded' then return false;
  end if;
  if jsonb_typeof(body->'status') is distinct from 'string'
    or body->>'status' not in('pending','claimed','completed','stale') then return false; end if;
  if body->>'status'<>'stale' and (body ? 'supersededByActionId' or body ? 'staleReason') then return false; end if;
  foreach field in array array['createdAt','expiresAt','preview'] loop
    if jsonb_typeof(body->field) is distinct from 'string' then return false; end if;
  end loop;
  return true;
exception when invalid_text_representation or numeric_value_out_of_range or invalid_parameter_value then return false;
end
$body$);
-- The exact same artifact has the same ledger digest on Windows and Unix.
update pg_temp.standalone_pending_v1_contract set source=replace(source,E'\r\n',E'\n');

-- Frozen source prerequisites from 010001. These are comparison data only;
-- this migration never replaces either application function.
create temporary table standalone_pending_v1_prerequisites(
  signature text primary key,result_type text not null,definer boolean not null,
  argument_names text[],source text not null
) on commit drop;
insert into pg_temp.standalone_pending_v1_prerequisites values
('public.nexus_commit(bigint,jsonb)','bigint',false,array['expected_revision','changes'],$v1_rpc$
declare actual bigint; entry jsonb; target text; row_id text; body jsonb;
begin
  if jsonb_typeof(changes)<>'array' or jsonb_array_length(changes)>50000 or octet_length(changes::text)>20971520 then raise exception 'Invalid commit batch' using errcode='22023'; end if;
  select revision into actual from public.appmeta where singleton=1 for update;
  if actual is distinct from expected_revision then raise exception 'Revision conflict' using errcode='40001'; end if;
  for entry in select value from jsonb_array_elements(changes) loop
    target:=entry->>'table'; row_id:=entry->>'id'; body:=entry->'payload';
    if target is null or target<>all(array['profiles','branches','products','sales_orders','sales_targets','inventory_snapshots','incidents','staffing_summaries','employees','policy_documents','sessions','conversations','conversation_messages','tool_executions','dashboards','dashboard_shares','pending_actions','action_executions','audit_events','mock_tickets','mock_badges','mock_messages','rate_limits']) or row_id is null or length(row_id)>300 then raise exception 'Invalid commit target' using errcode='22023'; end if;
    if body='null'::jsonb then execute format('delete from public.%I where id=$1',target) using row_id;
    else
      if jsonb_typeof(body)<>'object' or body->>'id' is distinct from row_id then raise exception 'Invalid record' using errcode='22023'; end if;
      execute format('insert into public.%I(id,payload) values($1,$2) on conflict(id) do update set payload=excluded.payload',target) using row_id,body;
    end if;
  end loop;
  select revision into actual from public.appmeta where singleton=1;
  return actual;
end $v1_rpc$),
('nexus_private.bump_revision()','trigger',true,null,$v1_revision$
begin update public.appmeta set revision=revision+1 where singleton=1; return null; end;
$v1_revision$);
update pg_temp.standalone_pending_v1_prerequisites set source=replace(source,E'\r\n',E'\n');
-- Pin two reviewed raw RPC variants (CRLF normalized only): original source
-- (1661 chars) and the hosted V1 spelling (1615 normalized chars). Both must additionally
-- match the canonical source text. No newly altered quoted text is admitted.
update pg_temp.standalone_pending_v1_prerequisites
  set source=btrim(regexp_replace(source,'[[:space:]]+',' ','g'))
  where signature='public.nexus_commit(bigint,jsonb)';
-- Deparse the exact original CHECK in this server, rather than normalizing
-- arbitrary SQL text (which could erase significant spaces inside JSON keys).
create temporary table standalone_pending_v1_check_probe(
  id text,payload jsonb,check(pg_catalog.jsonb_typeof(payload)='object' and payload->>'id'=id)
) on commit drop;

do $install$
declare item record; ledger_oid oid; installed_digest text; step_digest text; function_oid oid;
  saved_meta jsonb; saved_ledger jsonb; saved_rpc text; saved_revision text;
  revision_function oid; id_attribute smallint; saved_acl jsonb; baseline_owner oid; service_oid oid;
begin
  if to_regnamespace('nexus_private') is null or to_regclass('public.appmeta') is null
    or to_regclass('public.pending_actions') is null then
    raise exception 'Standalone pending action requires the original V1 schema' using errcode='23514';
  end if;
  -- Serialize against nexus_commit first, then direct pending-action writers.
  for item in select c.oid,c.relowner,n.nspname,c.relname from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where (n.nspname='public' and c.relname in('appmeta','pending_actions'))
      or (n.nspname='nexus_private' and c.relname='pending_action_v1_migrations')
    order by case when c.relname='appmeta' then 0 when c.relname='pending_actions' then 1 else 2 end loop
    if not pg_catalog.pg_has_role(current_user,item.relowner,'USAGE')
      and not (select rolsuper from pg_catalog.pg_roles where rolname=current_user) then
      raise exception 'Standalone pending action requires table ownership' using errcode='42501';
    end if;
    execute format('lock table %I.%I in access exclusive mode',item.nspname,item.relname);
  end loop;
  if exists(select 1 from pg_catalog.pg_class where oid in('public.appmeta'::regclass,'public.pending_actions'::regclass)
    and (relkind<>'r' or relpersistence<>'p' or not relrowsecurity)) then
    raise exception 'Standalone pending action requires protected ordinary tables' using errcode='23514';
  end if;
  if exists(select 1 from (values('pending_actions','id','text'),('pending_actions','payload','jsonb'),
    ('appmeta','singleton','integer'),('appmeta','revision','bigint')) expected(tbl,col,typ)
    left join pg_catalog.pg_attribute a on a.attrelid=format('public.%I',expected.tbl)::regclass
      and a.attname=expected.col and not a.attisdropped
    where a.attnum is null or a.atttypid<>expected.typ::regtype or not a.attnotnull or a.attgenerated<>'') then
    raise exception 'Standalone pending action native columns are incompatible' using errcode='23514';
  end if;
  select attnum into id_attribute from pg_catalog.pg_attribute where attrelid='public.pending_actions'::regclass and attname='id';
  if not exists(select 1 from pg_catalog.pg_constraint where conrelid='public.pending_actions'::regclass
    and contype='p' and conkey=array[id_attribute] and convalidated and not condeferrable) then
    raise exception 'Standalone pending action requires its native identity key' using errcode='23514';
  end if;
  if not exists(select 1 from pg_catalog.pg_constraint actual
    join pg_catalog.pg_constraint expected on expected.conrelid='pg_temp.standalone_pending_v1_check_probe'::regclass
      and expected.contype='c'
    where actual.conrelid='public.pending_actions'::regclass and actual.contype='c'
      and actual.convalidated and actual.conislocal and actual.coninhcount=0 and not actual.connoinherit
      and pg_catalog.pg_get_expr(actual.conbin,actual.conrelid,false)
        =pg_catalog.pg_get_expr(expected.conbin,expected.conrelid,false)) then
    raise exception 'Standalone pending action requires the original validated object and identity check' using errcode='23514';
  end if;
  if exists(select 1 from (values('public.pending_actions'::regclass),('public.appmeta'::regclass)) expected(table_oid)
    where (select count(*) from pg_catalog.pg_attribute where attrelid=expected.table_oid
      and attnum>0 and not attisdropped)<>2) then
    raise exception 'Standalone pending action requires a reviewed V2 bridge' using errcode='23514';
  end if;
  revision_function:=to_regprocedure('nexus_private.bump_revision()');
  select relowner into baseline_owner from pg_catalog.pg_class where oid='public.pending_actions'::regclass;
  select oid into service_oid from pg_catalog.pg_roles where rolname='service_role';
  if not exists(select 1 from pg_catalog.pg_trigger where tgrelid='public.pending_actions'::regclass
    and tgname='nexus_revision' and tgfoid=revision_function and tgenabled in('O','A')
    and tgtype=60 and tgnargs=0 and tgqual is null and tgattr=''::int2vector) then
    raise exception 'Standalone pending action requires its active revision trigger' using errcode='23514';
  end if;
  if not exists(select 1 from pg_catalog.pg_proc where oid=to_regprocedure('public.nexus_commit(bigint,jsonb)')
    and prorettype='bigint'::regtype and not prosecdef and proconfig=array['search_path=""']) then
    raise exception 'Standalone pending action requires the original commit boundary' using errcode='23514';
  end if;
  for item in select * from pg_temp.standalone_pending_v1_prerequisites loop
      function_oid:=to_regprocedure(item.signature);
      if item.signature='public.nexus_commit(bigint,jsonb)'
        and (md5(item.source)<>'d980adf870f237e64c227802471257cd' or length(item.source)<>1613) then
        raise exception 'Standalone pending action frozen RPC source is incompatible' using errcode='23514';
      end if;
      if not exists(select 1 from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid=p.prolang
        where p.oid=function_oid and p.proowner=baseline_owner
          and (item.signature<>'public.nexus_commit(bigint,jsonb)' or
            (md5(replace(p.prosrc,E'\r\n',E'\n'))='ce50e167139388c1beecab34e4ac6cbf' and length(replace(p.prosrc,E'\r\n',E'\n'))=1661) or
            (md5(replace(p.prosrc,E'\r\n',E'\n'))='ea8c50ff687c7ad890ae3dd53100940a' and length(replace(p.prosrc,E'\r\n',E'\n'))=1615))
          and (case when item.signature='public.nexus_commit(bigint,jsonb)'
          then btrim(regexp_replace(p.prosrc,'[[:space:]]+',' ','g'))
          else replace(p.prosrc,E'\r\n',E'\n') end)=item.source
          and p.prorettype=item.result_type::regtype and p.prosecdef=item.definer
          and p.proargnames is not distinct from item.argument_names
          and l.lanname='plpgsql' and p.prokind='f' and not p.proretset and not p.proisstrict
          and not p.proleakproof and p.provolatile='v' and p.proparallel='u'
          and p.pronargdefaults=0 and p.proconfig=array['search_path=""'])
        or exists(select 1 from pg_catalog.pg_proc p,
          lateral pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
          where p.oid=function_oid and a.privilege_type='EXECUTE' and
            (a.grantee=0 or a.grantee in(select oid from pg_catalog.pg_roles where rolname in('anon','authenticated'))))
        or pg_catalog.has_function_privilege('anon',function_oid,'EXECUTE')
        or pg_catalog.has_function_privilege('authenticated',function_oid,'EXECUTE') then
        raise exception 'Standalone pending action original V1 function is incompatible: %',item.signature using errcode='23514';
      end if;
    end loop;
    if not pg_catalog.has_function_privilege('service_role','public.nexus_commit(bigint,jsonb)','EXECUTE') then
      raise exception 'Standalone pending action requires the original RPC service grant' using errcode='23514';
    end if;
  -- Exact source and hosted ACL variants, not just a blacklist. Supabase's
  -- existing service-role defaults give pending_actions all table privileges
  -- and appmeta all except INSERT/DELETE. Derive the server's owner privilege
  -- set so PostgreSQL 17 MAINTAIN is represented without a PostgreSQL 16 grant.
  for item in
    select c.relname object_name,'r'::"char" kind,c.relowner object_owner,c.relacl acl,
      case when c.relname='pending_actions' then array['DELETE','INSERT','SELECT','UPDATE'] else array['SELECT','UPDATE'] end source_grants,
      array(select a.privilege_type from pg_catalog.aclexplode(pg_catalog.acldefault('r',c.relowner)) a
        where a.grantee=c.relowner and (c.relname='pending_actions' or a.privilege_type not in('INSERT','DELETE'))
        order by a.privilege_type) hosted_grants
      from pg_catalog.pg_class c where c.oid in('public.pending_actions'::regclass,'public.appmeta'::regclass)
    union all
    select p.proname,'f'::"char",p.proowner,p.proacl,
      case when p.proname='nexus_commit' then array['EXECUTE'] else '{}'::text[] end,
      case when p.proname='nexus_commit' then array['EXECUTE'] else '{}'::text[] end
      from pg_catalog.pg_proc p where p.oid in('public.nexus_commit(bigint,jsonb)'::regprocedure,'nexus_private.bump_revision()'::regprocedure)
    union all
    select n.nspname,'n'::"char",n.nspowner,n.nspacl,'{}'::text[],'{}'::text[]
      from pg_catalog.pg_namespace n where n.oid='nexus_private'::regnamespace
  loop
    if item.object_owner<>baseline_owner
      or exists(select 1 from pg_catalog.aclexplode(coalesce(item.acl,pg_catalog.acldefault(item.kind,item.object_owner))) a
        where a.grantee not in(baseline_owner,service_oid) or a.grantor<>baseline_owner or a.is_grantable)
      or array(select a.privilege_type from pg_catalog.aclexplode(coalesce(item.acl,pg_catalog.acldefault(item.kind,item.object_owner))) a
        where a.grantee=baseline_owner order by a.privilege_type)
        is distinct from array(select a.privilege_type from pg_catalog.aclexplode(pg_catalog.acldefault(item.kind,baseline_owner)) a
          where a.grantee=baseline_owner order by a.privilege_type)
      or (array(select a.privilege_type from pg_catalog.aclexplode(coalesce(item.acl,pg_catalog.acldefault(item.kind,item.object_owner))) a
          where a.grantee=service_oid order by a.privilege_type) is distinct from item.source_grants
        and array(select a.privilege_type from pg_catalog.aclexplode(coalesce(item.acl,pg_catalog.acldefault(item.kind,item.object_owner))) a
          where a.grantee=service_oid order by a.privilege_type) is distinct from item.hosted_grants) then
      raise exception 'Standalone pending action original ACL is incompatible: %',item.object_name using errcode='23514';
    end if;
  end loop;
  if exists(select 1 from pg_catalog.pg_attribute where attrelid in('public.pending_actions'::regclass,'public.appmeta'::regclass)
    and attnum>0 and not attisdropped and attacl is not null) then
    raise exception 'Standalone pending action column ACL is incompatible' using errcode='23514';
  end if;
  -- Preserve known trigger composition only. An unknown later BEFORE trigger
  -- could otherwise rewrite NEW after this guard had validated its envelope.
  if exists(select 1 from pg_catalog.pg_trigger t where t.tgrelid='public.pending_actions'::regclass
    and not t.tgisinternal and t.tgenabled<>'D' and not exists(
      select 1 from (values
        ('nexus_revision',revision_function,60,true),
        ('standalone_pending_action_v1_guard',to_regprocedure('nexus_private.standalone_pending_action_v1_guard()')::oid,31,true),
        ('standalone_pending_action_v1_truncate_guard',to_regprocedure('nexus_private.standalone_pending_action_v1_guard()')::oid,34,true)
      ) expected(name,function_oid,kind,allowed)
      where expected.allowed and t.tgname=expected.name and t.tgfoid=expected.function_oid
        and t.tgtype=expected.kind and t.tgenabled in('O','A') and t.tgnargs=0
        and t.tgqual is null and t.tgattr=''::int2vector and t.tgconstraint=0
    )) then
    raise exception 'Standalone pending action active trigger inventory is incompatible' using errcode='23514';
  end if;
  select to_jsonb(a) into strict saved_meta from public.appmeta a where singleton=1;
  if (select count(*) from public.appmeta)<>1
    or (saved_meta ? 'workflow_adapter_write' and saved_meta->>'workflow_adapter_write' is distinct from '0') then
    raise exception 'Standalone pending action metadata is incompatible or busy' using errcode='23514';
  end if;
  select pg_catalog.pg_get_functiondef('public.nexus_commit(bigint,jsonb)'::regprocedure) into saved_rpc;
  select pg_catalog.pg_get_functiondef(revision_function) into saved_revision;
  select jsonb_agg(jsonb_build_object('oid',oid,'acl',relacl,'rls',relrowsecurity,'force',relforcerowsecurity) order by oid)
    into saved_acl from pg_catalog.pg_class where oid in('public.appmeta'::regclass,'public.pending_actions'::regclass);
  create temporary table standalone_pending_v1_rows on commit drop as select to_jsonb(p) body from public.pending_actions p;
  create temporary table standalone_pending_v1_triggers on commit drop as
    select t.tgname,pg_catalog.pg_get_triggerdef(t.oid) definition,t.tgenabled from pg_catalog.pg_trigger t
    where t.tgrelid='public.pending_actions'::regclass;

  select md5('standalone-v1:row-before-insert-update-delete:31:statement-before-truncate:34:'||
    string_agg(signature||arguments||result_type||volatility||language_name||definer::text||strict_args::text||source,E'\n' order by signature))
    into step_digest from pg_temp.standalone_pending_v1_contract;
  ledger_oid:=to_regclass('nexus_private.pending_action_v1_migrations');
  if ledger_oid is not null then
    if not exists(select 1 from pg_catalog.pg_class where oid=ledger_oid and relowner=baseline_owner and relkind='r' and relpersistence='p' and relrowsecurity)
      or (select count(*) from pg_catalog.pg_attribute where attrelid=ledger_oid and attnum>0 and not attisdropped)<>2
      or exists(select 1 from (values('id'),('definition_digest')) expected(col)
        left join pg_catalog.pg_attribute a on a.attrelid=ledger_oid and a.attname=expected.col and not a.attisdropped
        where a.attnum is null or a.atttypid<>'text'::regtype or not a.attnotnull or a.attgenerated<>'' or a.atthasdef or a.attacl is not null)
      or not exists(select 1 from pg_catalog.pg_constraint c where c.conrelid=ledger_oid and c.contype='p'
        and c.conkey=array[(select attnum from pg_catalog.pg_attribute where attrelid=ledger_oid and attname='id')]
        and c.convalidated and not c.condeferrable)
      or exists(select 1 from pg_catalog.pg_trigger where tgrelid=ledger_oid and not tgisinternal) then
      raise exception 'Standalone pending action ledger schema is incompatible' using errcode='23514';
    end if;
    execute 'select definition_digest from nexus_private.pending_action_v1_migrations where id=$1'
      into installed_digest using '202610010002_workflow_pending_action_v1_guard';
    if installed_digest is null then
      raise exception 'Standalone pending action cannot adopt an unledgered installation' using errcode='23514';
    end if;
    if installed_digest<>step_digest then
      raise exception 'Standalone pending action contract changed without a new schema version' using errcode='23514';
    end if;
  else
    create table nexus_private.pending_action_v1_migrations(id text primary key,definition_digest text not null);
    alter table nexus_private.pending_action_v1_migrations enable row level security;
    revoke all on nexus_private.pending_action_v1_migrations from public,anon,authenticated,service_role;
    ledger_oid:='nexus_private.pending_action_v1_migrations'::regclass;
  end if;
  if exists(select 1 from pg_catalog.pg_class c,
    lateral pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
    where c.oid=ledger_oid and (c.relowner<>baseline_owner or a.grantee<>baseline_owner
      or a.grantor<>baseline_owner or a.is_grantable))
    or (select array(select a.privilege_type from pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
      order by a.privilege_type) from pg_catalog.pg_class c where c.oid=ledger_oid)
      is distinct from array(select a.privilege_type from pg_catalog.aclexplode(pg_catalog.acldefault('r',baseline_owner)) a
        where a.grantee=baseline_owner order by a.privilege_type) then
    raise exception 'Standalone pending action ledger permissions are incompatible' using errcode='23514';
  end if;
  select jsonb_agg(to_jsonb(m) order by id) into saved_ledger from nexus_private.pending_action_v1_migrations m;
  for item in select * from pg_temp.standalone_pending_v1_contract order by signature loop
    function_oid:=to_regprocedure(item.signature);
    if installed_digest is null then
      if function_oid is not null then
        raise exception 'Standalone pending action cannot adopt an unledgered function' using errcode='23514';
      end if;
      execute format('create function %s(%s) returns %s language %s %s %s security %s set search_path='''' as %L',
        split_part(item.signature,'(',1),item.arguments,item.result_type,item.language_name,item.volatility,
        case when item.strict_args then 'strict' else 'called on null input' end,
        case when item.definer then 'definer' else 'invoker' end,item.source);
      execute format('revoke all on function %s from public,anon,authenticated,service_role',item.signature);
      function_oid:=to_regprocedure(item.signature);
    end if;
    if not exists(select 1 from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid=p.prolang
      where p.oid=function_oid and p.proowner=baseline_owner and p.prosrc=item.source and p.prorettype=item.result_type::regtype
        and p.prosecdef=item.definer and p.provolatile=left(item.volatility,1)::"char"
        and l.lanname=item.language_name and p.prokind='f' and p.proisstrict=item.strict_args and not p.proleakproof
        and p.proparallel='u' and p.pronargdefaults=0 and p.proconfig=array['search_path=""'])
      or exists(select 1 from pg_catalog.pg_proc p,
        lateral pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
        where p.oid=function_oid and (a.grantee<>baseline_owner or a.grantor<>baseline_owner
          or a.privilege_type<>'EXECUTE' or a.is_grantable))
      or (select array(select a.privilege_type from pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
        order by a.privilege_type) from pg_catalog.pg_proc p where p.oid=function_oid) is distinct from array['EXECUTE'] then
      raise exception 'Standalone pending action installed function is incompatible' using errcode='23514';
    end if;
  end loop;
  if installed_digest is null then
    if exists(select 1 from pg_catalog.pg_trigger where tgrelid='public.pending_actions'::regclass
      and tgname in('standalone_pending_action_v1_guard','standalone_pending_action_v1_truncate_guard')) then
      raise exception 'Standalone pending action cannot adopt an unledgered trigger' using errcode='23514';
    end if;
    create trigger standalone_pending_action_v1_guard before insert or update or delete on public.pending_actions
      for each row execute function nexus_private.standalone_pending_action_v1_guard();
    create trigger standalone_pending_action_v1_truncate_guard before truncate on public.pending_actions
      for each statement execute function nexus_private.standalone_pending_action_v1_guard();
  end if;
  if exists(select 1 from (values('standalone_pending_action_v1_guard',31),('standalone_pending_action_v1_truncate_guard',34)) expected(name,typ)
    left join pg_catalog.pg_trigger t on t.tgrelid='public.pending_actions'::regclass and t.tgname=expected.name
    where t.oid is null or t.tgfoid<>'nexus_private.standalone_pending_action_v1_guard()'::regprocedure
      or t.tgenabled not in('O','A') or t.tgtype<>expected.typ or t.tgnargs<>0 or t.tgqual is not null
      or t.tgattr<>''::int2vector or t.tgisinternal or t.tgconstraint<>0) then
    raise exception 'Standalone pending action installed trigger is incompatible' using errcode='23514';
  end if;
  if exists((select to_jsonb(p) from public.pending_actions p except select body from pg_temp.standalone_pending_v1_rows)
    union all (select body from pg_temp.standalone_pending_v1_rows except select to_jsonb(p) from public.pending_actions p))
    or (select to_jsonb(a) from public.appmeta a where singleton=1) is distinct from saved_meta
    or (select jsonb_agg(to_jsonb(m) order by id) from nexus_private.pending_action_v1_migrations m) is distinct from saved_ledger
    or pg_catalog.pg_get_functiondef('public.nexus_commit(bigint,jsonb)'::regprocedure) is distinct from saved_rpc
    or pg_catalog.pg_get_functiondef(revision_function) is distinct from saved_revision
    or (select jsonb_agg(jsonb_build_object('oid',oid,'acl',relacl,'rls',relrowsecurity,'force',relforcerowsecurity) order by oid)
      from pg_catalog.pg_class where oid in('public.appmeta'::regclass,'public.pending_actions'::regclass)) is distinct from saved_acl
    or exists(select 1 from pg_temp.standalone_pending_v1_triggers s left join pg_catalog.pg_trigger t
      on t.tgrelid='public.pending_actions'::regclass and t.tgname=s.tgname
      where t.oid is null or pg_catalog.pg_get_triggerdef(t.oid) is distinct from s.definition or t.tgenabled is distinct from s.tgenabled) then
    raise exception 'Standalone pending action changed preceding data or contract' using errcode='23514';
  end if;
  if installed_digest is null then
    insert into nexus_private.pending_action_v1_migrations values('202610010002_workflow_pending_action_v1_guard',step_digest);
  end if;
end $install$;
commit;
