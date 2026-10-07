-- Workflow V2 commit performance: typed unique-key lookups.
-- Runs after 202610060001_workflow_v1_guard_bridge_activate. Applies to every lineage that
-- has 202610020002_workflow_v2 (fresh, hosted after the bridge, and the V2 proof chain).
--
-- Why: 202610020002 builds each insert_unique lookup as
--   select t.<body> from public.<table> t where to_jsonb(t)->'<col>' = $1->'<field>' limit 1
-- which converts every row to JSONB and defeats every index (measured locally: Seq Scan,
-- 17.3 ms on 6,640 inventory_snapshots rows; the V2 seed then hit the 8 s PostgREST
-- statement_timeout). This step CREATE OR REPLACEs public.nexus_workflow_commit(bigint,jsonb)
-- with one change: each unique-key field becomes a typed predicate on its mapped SQL
-- column (t.<col> = <typed value>; IS NULL for JSON null). The truth table is the same as
-- the JSONB comparison: a value whose JSON type can never equal the column's JSON form
-- yields false, integer/numeric/jsonb columns compare by value, and any other column
-- type keeps the exact JSONB comparison (to_jsonb(t.<col>) = value). Signature, return
-- type, LANGUAGE plpgsql, VOLATILE, SECURITY DEFINER, search_path='', owner and grants
-- are unchanged and re-verified. 202610020002 itself is not edited.
--
-- Lineages:
--   * Function source equals the reviewed 202610020002 source (LF md5
--     f5ef58318e3472dd712f8abe2d54184c): replace it.
--   * Function source already equals this step's source: no-op (idempotent).
--   * Anything else (missing function, other source, changed attributes or ACL): raise
--     23514 and change nothing (fail closed).
--
-- Rollback notes: a forward migration that re-creates the 202610020002 source restores
-- the previous behavior; this step never touches data.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
select pg_catalog.pg_advisory_xact_lock(20261006,2);
create temporary table workflow_commit_typed_source(source text not null) on commit drop;
insert into pg_temp.workflow_commit_typed_source values($commit$
declare actual bigint; op jsonb; d jsonb; r jsonb; b jsonb; tbl text; names text; vals text;
  criterion text; u jsonb; c jsonb; v jsonb; field text; colname text; current_body jsonb; affected bigint; row_data jsonb;
  key_type oid; key_value jsonb; key_number numeric; predicate text;
begin
  if expected_revision is null or expected_revision<0 or operations is null or jsonb_typeof(operations)<>'array'
    or jsonb_array_length(operations)>50000 or octet_length(operations::text)>20971520 then raise exception 'Invalid workflow commit batch' using errcode='22023'; end if;
  select revision into actual from public.appmeta where singleton=1 for update;
  if actual is distinct from expected_revision then raise exception 'Workflow revision conflict' using errcode='40001'; end if;
  update public.appmeta set workflow_adapter_write=1 where singleton=1;
  for op in select value from jsonb_array_elements(operations) loop
    tbl:=op->>'table';
    select definition into d from nexus_private.workflow_manifest where table_name=tbl;
    if d is null or jsonb_typeof(op)<>'object' or op->>'kind' is null or op->>'kind' not in ('insert_unique','cas') then raise exception 'Invalid workflow operation' using errcode='22023'; end if;
    if (op->>'kind'='insert_unique' and (not op ?& array['kind','table','constraint','values','row'] or (select count(*) from jsonb_object_keys(op))<>5))
      or (op->>'kind'='cas' and (not op ?& array['kind','table','id','expected','next'] or (select count(*) from jsonb_object_keys(op))<>5)) then raise exception 'Invalid workflow operation fields' using errcode='22023'; end if;
    r:=case when op->>'kind'='cas' then op->'next' else op->'row' end; b:=r->'body';
    if jsonb_typeof(r)<>'object' or not r ?& array['id','rowVersion','body'] or (select count(*) from jsonb_object_keys(r))<>3 or jsonb_typeof(b)<>'object' or r->>'id' is distinct from b->>'id'
      or jsonb_typeof(r->'id')<>'string' or r->>'id' is null or length(r->>'id')>300 or jsonb_typeof(r->'rowVersion')<>'number' or r->>'rowVersion' !~ '^[1-9][0-9]*$' then raise exception 'Invalid workflow operation row' using errcode='22023'; end if;
    row_data:=jsonb_build_object('id',r->>'id','row_version',(r->>'rowVersion')::bigint,d->>'bodyColumn',b);
    names:='id,row_version,'||format('%I',d->>'bodyColumn'); vals:='x.id,x.row_version,x.'||format('%I',d->>'bodyColumn');
    if d->>'storage'='mixed' then row_data:=row_data||jsonb_build_object('workflow_contract_version',2); names:=names||',workflow_contract_version';vals:=vals||',x.workflow_contract_version'; end if;
    for c in select value from jsonb_array_elements(d->'columns') loop
      if coalesce((c->>'external')::boolean,false) then
        if op->>'kind'='insert_unique' then
          if op->>'constraint'<>'action_executions_root_attempt_unique' or tbl<>'action_executions' then raise exception 'Invalid external workflow key' using errcode='22023'; end if;
          v:=op->'values'->(c->>'bodyField');
        else execute format('select to_jsonb(t)->%L from public.%I t where id=$1',c->>'column',tbl) into v using r->>'id'; end if;
      else v:=nexus_private.workflow_value(b,c); end if;
      row_data:=row_data||jsonb_build_object(c->>'column',v);
      names:=names||','||format('%I',c->>'column');vals:=vals||',x.'||format('%I',c->>'column');
    end loop;
    if op->>'kind'='insert_unique' then
      if op->>'constraint'=tbl||'_primary_key' then u:=jsonb_build_object('fields',jsonb_build_array('id'));
      else select value into u from jsonb_array_elements(d->'unique') where value->>'name'=op->>'constraint'; end if;
      if u is null or jsonb_typeof(op->'values')<>'object' or (select count(*) from jsonb_object_keys(op->'values'))<>jsonb_array_length(u->'fields') then raise exception 'Invalid workflow unique constraint' using errcode='22023'; end if;
      criterion:='';
      for field in select jsonb_array_elements_text(u->'fields') loop
        select x into c from jsonb_array_elements(d->'columns') x where x->>'bodyField'=field;
        if not (op->'values') ? field or (not coalesce((c->>'external')::boolean,false) and (op->'values'->field) is distinct from (b #> string_to_array(field,'.'))) then raise exception 'Invalid workflow unique key' using errcode='22023'; end if;
        if field='id' then colname:='id'; else select x->>'column' into colname from jsonb_array_elements(d->'columns') x where x->>'bodyField'=field; end if;
        if colname is null then raise exception 'Invalid workflow unique field' using errcode='22023'; end if;
        -- Typed predicate on the mapped column: same truth table as to_jsonb(t)->col = value
        -- (JSON null <=> SQL NULL), but sargable, so the unique/primary index is used.
        key_value:=op->'values'->field; key_type:=null;
        select a.atttypid into key_type from pg_catalog.pg_attribute a
          where a.attrelid=format('public.%I',tbl)::regclass and a.attname=colname and a.attnum>0 and not a.attisdropped;
        if key_type is null then predicate:='false';
        elsif jsonb_typeof(key_value)='null' then
          predicate:=case when key_type='jsonb'::regtype then format('(t.%I is null or t.%I=''null''::jsonb)',colname,colname)
            else format('t.%I is null',colname) end;
        elsif key_type in('text'::regtype,'varchar'::regtype) then
          predicate:=case when jsonb_typeof(key_value)='string' then format('t.%I=($1->>%L)::%s',colname,field,key_type::regtype) else 'false' end;
        elsif key_type='boolean'::regtype then
          predicate:=case when jsonb_typeof(key_value)='boolean' then format('t.%I=($1->>%L)::boolean',colname,field) else 'false' end;
        elsif key_type in('int2'::regtype,'int4'::regtype,'int8'::regtype) then
          predicate:='false';
          if jsonb_typeof(key_value)='number' then
            key_number:=(key_value #>> '{}')::numeric;
            if key_number=trunc(key_number) and key_number between
                (case key_type when 'int2'::regtype then -32768 when 'int4'::regtype then -2147483648 else -9223372036854775808 end)
                and (case key_type when 'int2'::regtype then 32767 when 'int4'::regtype then 2147483647 else 9223372036854775807 end) then
              predicate:=format('t.%I=%L::%s',colname,trunc(key_number)::text,key_type::regtype);
            end if;
          end if;
        elsif key_type='numeric'::regtype and jsonb_typeof(key_value)='number' then
          predicate:=format('t.%I=%L::numeric',colname,(key_value #>> '{}'));
        elsif key_type='jsonb'::regtype then
          predicate:=format('t.%I=$1->%L',colname,field);
        else
          predicate:=format('to_jsonb(t.%I)=$1->%L',colname,field);
        end if;
        criterion:=criterion||case when criterion='' then '' else ' and ' end||predicate;
      end loop;
      if d->>'storage'='mixed' then criterion:=criterion||' and t.workflow_contract_version=2'; end if;
      if coalesce((u->>'openOnly')::boolean,false) then
        select string_agg(quote_literal(value),',') into field from jsonb_array_elements_text(u->'openStates');
        if field is null then raise exception 'Invalid workflow open constraint' using errcode='22023'; end if;
        criterion:=criterion||format(' and nexus_private.workflow_state(t.%I,%L::jsonb) in (%s)',d->>'bodyColumn',d::text,field);
      end if;
      execute format('select t.%I from public.%I t where %s limit 1',d->>'bodyColumn',tbl,criterion) into current_body using op->'values';
      if current_body is not null then
        if current_body is distinct from b then raise exception 'Workflow unique operation conflict' using errcode='23505'; end if;
      else
        execute format('insert into public.%I(%s) select %s from jsonb_populate_record(null::public.%I,$1) x',tbl,names,vals,tbl) using row_data;
      end if;
    else
      if jsonb_typeof(op->'expected')<>'object' or not (op->'expected') ?& array['rowVersion','state'] or (select count(*) from jsonb_object_keys(op->'expected'))<>2
        or jsonb_typeof(op #> '{expected,rowVersion}')<>'number' or jsonb_typeof(op #> '{expected,state}') not in ('string','null')
        or op->>'id' is distinct from r->>'id' or op #>> '{expected,rowVersion}' !~ '^[1-9][0-9]*$'
        or (r->>'rowVersion')::bigint<>(op #>> '{expected,rowVersion}')::bigint+1 then raise exception 'Invalid workflow CAS version' using errcode='22023'; end if;
      criterion:=format('t.id=$2 and t.row_version=$3 and nexus_private.workflow_state(t.%I,%L::jsonb) is not distinct from $4',d->>'bodyColumn',d::text);
      if d->>'storage'='mixed' then criterion:=criterion||' and t.workflow_contract_version=2'; end if;
      names:='';
      for colname in select key from jsonb_each(row_data) where key<>'id' loop names:=names||case when names='' then '' else ',' end||format('%I=x.%I',colname,colname); end loop;
      execute format('update public.%I t set %s from jsonb_populate_record(null::public.%I,$1) x where %s',tbl,names,tbl,criterion)
        using row_data,r->>'id',(op #>> '{expected,rowVersion}')::bigint,op #>> '{expected,state}';
      get diagnostics affected=row_count;
      if affected<>1 then raise exception 'Workflow conditional conflict' using errcode='40001'; end if;
    end if;
  end loop;
  update public.appmeta set revision=actual+1,workflow_adapter_write=0 where singleton=1;
  return actual+1;
end $commit$);
update pg_temp.workflow_commit_typed_source set source=replace(source,E'\r\n',E'\n');

do $typed$
declare
  commit_function oid:=to_regprocedure('public.nexus_workflow_commit(bigint,jsonb)');
  new_source text; installed_md5 text; owner_oid oid; acl_before text;
begin
  select source into strict new_source from pg_temp.workflow_commit_typed_source;
  if commit_function is null or to_regclass('public.appmeta') is null
    or to_regclass('nexus_private.workflow_manifest') is null then
    raise exception 'Typed workflow commit requires 202610020002_workflow_v2' using errcode='23514';
  end if;
  select p.proowner,coalesce(p.proacl::text,'') into owner_oid,acl_before from pg_catalog.pg_proc p where p.oid=commit_function;
  if not pg_catalog.pg_has_role(current_user,owner_oid,'USAGE')
    and not (select rolsuper from pg_catalog.pg_roles where rolname=current_user) then
    raise exception 'Typed workflow commit requires function ownership' using errcode='42501';
  end if;
  -- Serialize with in-flight commits (they lock the appmeta row) before replacing.
  lock table public.appmeta in exclusive mode;
  if not exists(select 1 from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid=p.prolang
      where p.oid=commit_function and l.lanname='plpgsql' and p.prosecdef and p.prorettype='bigint'::regtype
        and p.provolatile='v' and p.proconfig=array['search_path=""']
        and p.proowner=(select relowner from pg_catalog.pg_class where oid='public.appmeta'::regclass)) then
    raise exception 'Typed workflow commit found changed function attributes' using errcode='23514';
  end if;
  -- Exact grants: only the owner and service_role may execute (no PUBLIC, anon, authenticated).
  if exists(select 1 from pg_catalog.pg_proc p,lateral pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
      where p.oid=commit_function and a.grantee not in(owner_oid,coalesce((select oid from pg_catalog.pg_roles where rolname='service_role'),0)))
    or not exists(select 1 from pg_catalog.pg_roles r where r.rolname='service_role'
      and pg_catalog.has_function_privilege(r.oid,commit_function,'EXECUTE')) then
    raise exception 'Typed workflow commit found changed function grants' using errcode='23514';
  end if;
  select md5(replace(prosrc,E'\r\n',E'\n')) into installed_md5 from pg_catalog.pg_proc where oid=commit_function;
  if installed_md5=md5(new_source) then
    return; -- Idempotent re-run.
  end if;
  if installed_md5 is distinct from 'f5ef58318e3472dd712f8abe2d54184c' then
    raise exception 'Typed workflow commit found a modified nexus_workflow_commit source' using errcode='23514';
  end if;

  execute format('create or replace function public.nexus_workflow_commit(expected_revision bigint, operations jsonb) returns bigint '
    'language plpgsql volatile security definer set search_path='''' as %L',new_source);
  revoke all on function public.nexus_workflow_commit(bigint,jsonb) from public,anon,authenticated;
  grant execute on function public.nexus_workflow_commit(bigint,jsonb) to service_role;

  if not exists(select 1 from pg_catalog.pg_proc p where p.oid=commit_function and md5(p.prosrc)=md5(new_source)
      and p.prosecdef and p.proowner=owner_oid and p.proconfig=array['search_path=""']
      and coalesce(p.proacl::text,'')=acl_before) then
    raise exception 'Typed workflow commit did not preserve function identity, owner or grants' using errcode='23514';
  end if;
end $typed$;
commit;
