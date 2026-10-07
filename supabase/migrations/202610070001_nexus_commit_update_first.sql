-- nexus_commit: update existing rows before inserting (see the comment in the function body).
-- Re-declares public.nexus_commit with the identical allowlist, V2 legacy guard and revision check of
-- 202610060900_router_proposals; only the per-row upsert is split into UPDATE then INSERT. Owner and ACL are kept
-- (CREATE OR REPLACE) and re-asserted below. Synthetic-safe; hosted application needs separate owner confirmation.
begin;
create or replace function public.nexus_commit(expected_revision bigint, changes jsonb) returns bigint
language plpgsql security invoker set search_path='' as $$
declare actual bigint; updated bigint; entry jsonb; target text; row_id text; body jsonb; protected integer; definition jsonb;
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
      -- Update first: an existing row must go through the BEFORE UPDATE guards only. The previous single
      -- INSERT ... ON CONFLICT DO UPDATE ran the BEFORE INSERT guard first, which rejected any body whose
      -- rowVersion had been advanced (conversations, sessions, ...) with 'Inconsistent workflow body version'.
      execute format('update public.%I set payload=$2 where id=$1',target) using row_id,body;
      get diagnostics updated = row_count;
      if updated=0 then
        execute format('insert into public.%I(id,payload) values($1,$2) on conflict(id) do update set payload=excluded.payload',target) using row_id,body;
      end if;
    end if;
  end loop;
  select revision into actual from public.appmeta where singleton=1;return actual;
end $$;
revoke all on function public.nexus_commit(bigint,jsonb) from public,anon,authenticated;
grant execute on function public.nexus_commit(bigint,jsonb) to service_role;
commit;
