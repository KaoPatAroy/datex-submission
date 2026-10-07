-- Router-staged proposals (dashboard.delete, communication.send, monitor.create). Synthetic data only.
-- Additive: one new table following the legacy payload-table convention, and nexus_commit is re-declared with the
-- identical V2 legacy guard plus 'router_proposals' in its table allowlist. Existing migrations are untouched.
-- Requires owner-confirmed hosted application; until applied, router staging fails closed (table missing).
begin;
create table if not exists public.router_proposals(id text primary key, payload jsonb not null check(jsonb_typeof(payload)='object' and payload->>'id'=id));
alter table public.router_proposals enable row level security;
revoke all on public.router_proposals from public,anon,authenticated;
grant select,insert,update,delete on public.router_proposals to service_role;
drop trigger if exists nexus_revision on public.router_proposals;
create trigger nexus_revision after insert or update or delete or truncate on public.router_proposals for each statement execute function nexus_private.bump_revision();
create index if not exists router_proposals_owner_idx on public.router_proposals((payload->>'actorId'),(payload->>'conversationId'),(payload->>'status'));

create or replace function public.nexus_commit(expected_revision bigint, changes jsonb) returns bigint
language plpgsql security invoker set search_path='' as $$
declare actual bigint; entry jsonb; target text; row_id text; body jsonb; protected integer; definition jsonb;
begin
  if expected_revision is null or jsonb_typeof(changes)<>'array' or jsonb_array_length(changes)>50000 or octet_length(changes::text)>20971520 then raise exception 'Invalid commit batch' using errcode='22023'; end if;
  select revision into actual from public.appmeta where singleton=1 for update;
  if actual is distinct from expected_revision then raise exception 'Revision conflict' using errcode='40001'; end if;
  for entry in select value from jsonb_array_elements(changes) loop
    target:=entry->>'table';row_id:=entry->>'id';body:=entry->'payload';
    if target is null or target<>all(array['profiles','branches','products','sales_orders','sales_targets','inventory_snapshots','incidents','staffing_summaries','employees','policy_documents','sessions','conversations','conversation_messages','tool_executions','dashboards','dashboard_shares','pending_actions','action_executions','audit_events','mock_tickets','mock_badges','mock_messages','rate_limits','router_proposals']) or row_id is null or length(row_id)>300 then raise exception 'Invalid commit target' using errcode='22023'; end if;
    if target in ('mock_tickets','pending_actions','action_executions','dashboard_shares','audit_events') then
      execute format('select workflow_contract_version from public.%I where id=$1',target) into protected using row_id;
      if protected=2 or body->>'contractVersion'='2' or (target='dashboard_shares' and body ? 'senderIdentityId') then raise exception 'Legacy mutation cannot write V2 workflow row' using errcode='23514'; end if;
    end if;
    if body='null'::jsonb then execute format('delete from public.%I where id=$1',target) using row_id;
    else
      if jsonb_typeof(body)<>'object' or body->>'id' is distinct from row_id then raise exception 'Invalid record' using errcode='22023'; end if;
      execute format('insert into public.%I(id,payload) values($1,$2) on conflict(id) do update set payload=excluded.payload',target) using row_id,body;
    end if;
  end loop;
  select revision into actual from public.appmeta where singleton=1;return actual;
end $$;
revoke all on function public.nexus_commit(bigint,jsonb) from public,anon,authenticated;
grant execute on function public.nexus_commit(bigint,jsonb) to service_role;
commit;
