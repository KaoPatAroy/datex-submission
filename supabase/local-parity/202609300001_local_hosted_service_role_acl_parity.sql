-- LOCAL-ONLY hosted ACL parity fixture. Never apply to a hosted project.
-- Staged by scripts/local-supabase.ts in front of 202610010001_concierge for every
-- local profile; it is not a member of supabase/migrations.
--
-- A stock local Supabase stack grants service_role INSERT and DELETE on every new
-- public table through default privileges. The hosted project observed by
-- 202610010002 (see its ACL comment) holds appmeta for service_role as every owner
-- privilege except INSERT/DELETE, and 202610010002 fails closed on any other ACL.
-- Removing INSERT/DELETE from the default grant reproduces that hosted state:
-- 202610010001 then re-grants SELECT/INSERT/UPDATE/DELETE on its 23 data tables
-- and only SELECT/UPDATE on appmeta.
alter default privileges for role postgres in schema public
  revoke insert, delete on tables from service_role;
