import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { localPsql, migrationPath } from '../scripts/local-supabase';
import { pgTestsEnabled, resetLocalPgData } from './helpers/local-pg';

/**
 * 202610060900_router_proposals on the canonical `fresh` profile: table shape, ACL, revision
 * trigger, nexus_commit allowlist (and its V2 legacy guard), and idempotent re-apply.
 */
describe.skipIf(!pgTestsEnabled)('router_proposals migration (local PostgreSQL)', () => {
  const body = (id: string) => JSON.stringify({ id, actorId: 'a1', conversationId: 'c1', status: 'staged' });

  it('has the payload table shape, RLS and service_role-only ACL', () => {
    expect(localPsql("select relrowsecurity from pg_class where oid='public.router_proposals'::regclass")).toBe('t');
    const grantees = localPsql("select string_agg(distinct grantee, ',' order by grantee) from information_schema.role_table_grants where table_schema='public' and table_name='router_proposals'");
    expect(grantees).toBe('postgres,service_role');
    const privileges = localPsql("select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants where table_schema='public' and table_name='router_proposals' and grantee='service_role'");
    expect(privileges).toContain('INSERT');
    expect(privileges).toContain('SELECT');
  });

  it('commits through nexus_commit as service_role, bumps the revision, and rejects mismatched payload ids', () => {
    resetLocalPgData();
    const revision = Number(localPsql('select revision from public.appmeta where singleton=1'));
    const changes = JSON.stringify([{ table: 'router_proposals', id: 'rp-1', payload: JSON.parse(body('rp-1')) }]).replaceAll("'", "''");
    const next = Number(localPsql(`set role service_role; select public.nexus_commit(${revision}, '${changes}'::jsonb);`).split(/\r?\n/).at(-1));
    expect(next).toBeGreaterThan(revision);
    expect(localPsql("select payload->>'status' from public.router_proposals where id='rp-1'")).toBe('staged');
    const bad = JSON.stringify([{ table: 'router_proposals', id: 'rp-2', payload: JSON.parse(body('other')) }]);
    expect(() => localPsql(`set role service_role; select public.nexus_commit(${next}, '${bad}'::jsonb);`)).toThrow(/Invalid record/);
    const stale = JSON.stringify([{ table: 'router_proposals', id: 'rp-3', payload: JSON.parse(body('rp-3')) }]);
    expect(() => localPsql(`set role service_role; select public.nexus_commit(${revision}, '${stale}'::jsonb);`)).toThrow(/Revision conflict/);
    resetLocalPgData();
  });

  it('re-applies idempotently and still blocks legacy writes to V2 workflow rows', () => {
    localPsql(readFileSync(migrationPath('202610060900_router_proposals'), 'utf8'));
    // Re-declaring nexus_commit from the older file must not leave the older body installed for later tests.
    localPsql(readFileSync(migrationPath('202610070001_nexus_commit_update_first'), 'utf8'));
    expect(localPsql("select count(*) from pg_trigger where tgrelid='public.router_proposals'::regclass and not tgisinternal")).toBe('1');
    const evil = JSON.stringify([{ table: 'pending_actions', id: 'x', payload: { id: 'x', contractVersion: 2 } }]);
    expect(() => localPsql(`set role service_role; select public.nexus_commit(0, '${evil}'::jsonb);`)).toThrow();
  });
});
