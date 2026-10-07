-- All application data is synthetic. Data API clients get no direct access.
create schema if not exists nexus_private;
revoke all on schema nexus_private from public, anon, authenticated;
create table if not exists public.appmeta(singleton integer primary key check(singleton=1), revision bigint not null default 0);
insert into public.appmeta(singleton,revision) values(1,0) on conflict do nothing;
alter table public.appmeta enable row level security;
revoke all on public.appmeta from public,anon,authenticated;
grant select,update on public.appmeta to service_role;

create or replace function nexus_private.bump_revision() returns trigger language plpgsql security definer set search_path='' as $$
begin update public.appmeta set revision=revision+1 where singleton=1; return null; end;
$$;
revoke all on function nexus_private.bump_revision() from public,anon,authenticated;

do $$
declare name text;
begin
  foreach name in array array['profiles','branches','products','sales_orders','sales_targets','inventory_snapshots','incidents','staffing_summaries','employees','policy_documents','sessions','conversations','conversation_messages','tool_executions','dashboards','dashboard_shares','pending_actions','action_executions','audit_events','mock_tickets','mock_badges','mock_messages','rate_limits'] loop
    execute format('create table if not exists public.%I(id text primary key, payload jsonb not null check(jsonb_typeof(payload)=''object'' and payload->>''id''=id))',name);
    execute format('alter table public.%I enable row level security',name);
    execute format('revoke all on public.%I from public,anon,authenticated',name);
    execute format('grant select,insert,update,delete on public.%I to service_role',name);
    execute format('drop trigger if exists nexus_revision on public.%I',name);
    execute format('create trigger nexus_revision after insert or update or delete or truncate on public.%I for each statement execute function nexus_private.bump_revision()',name);
  end loop;
end $$;
create unique index if not exists mock_ticket_operation_unique on public.mock_tickets((payload->>'operationKey')) where payload->>'operationKey' is not null;
create unique index if not exists mock_message_operation_unique on public.mock_messages((payload->>'operationKey')) where payload->>'operationKey' is not null;
create unique index if not exists dashboard_share_operation_unique on public.dashboard_shares((payload->>'operationKey')) where payload->>'operationKey' is not null;

create or replace function public.nexus_commit(expected_revision bigint, changes jsonb) returns bigint language plpgsql security invoker set search_path='' as $$
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
end $$;
revoke all on function public.nexus_commit(bigint,jsonb) from public,anon,authenticated;
grant execute on function public.nexus_commit(bigint,jsonb) to service_role;
