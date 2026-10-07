-- A legacy (marker-less) pending action may carry a projected `status` column only if it equals the body status.
-- Mirrors the SQLite fresh-V1 status projection guard (0006). It is a CHECK constraint, not a trigger, so the exact
-- active trigger inventory required by the activated V1 guard is unchanged. Hosted application needs separate
-- owner confirmation; the constraint is added NOT VALID first and validated in the same transaction.
begin;
set local lock_timeout='5s';
set local statement_timeout='120s';
do $$
begin
  if not exists (select 1 from pg_catalog.pg_constraint
    where conrelid='public.pending_actions'::regclass and conname='pending_actions_v1_status_projection_check') then
    alter table public.pending_actions add constraint pending_actions_v1_status_projection_check
      check (workflow_contract_version is not null or status is null or status is not distinct from (payload->>'status')) not valid;
  end if;
end $$;
alter table public.pending_actions validate constraint pending_actions_v1_status_projection_check;
commit;
