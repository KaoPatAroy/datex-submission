import { it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import {
  assertLoopbackUrl,
  LOCAL_ENV_FILE,
  localPsql,
  parseEnvOutput,
} from '../../scripts/local-supabase';

/** Opt-in only: normal `vitest run` never touches a database. */
export const pgTestsEnabled = process.env.BIZTANIA_PG_TESTS === '1';

export type LocalPgConfig = { url: string; serviceRoleKey: string; profile: string };

/** Reads the local stack URL/key written by `scripts/local-supabase.ts`; loopback only. */
export function localPgConfig(): LocalPgConfig {
  const file = existsSync(LOCAL_ENV_FILE) ? parseEnvOutput(readFileSync(LOCAL_ENV_FILE, 'utf8')) : {};
  const url = file.BIZTANIA_PG_SUPABASE_URL;
  const serviceRoleKey = file.BIZTANIA_PG_SERVICE_ROLE_KEY;
  const profile = file.BIZTANIA_PG_PROFILE ?? 'unknown';
  if (!url || !serviceRoleKey) {
    throw new Error('Local PostgreSQL tests need `npm run db:local:reset` (writes .local/supabase-local.env).');
  }
  assertLoopbackUrl(url, 'BIZTANIA_PG_SUPABASE_URL');
  return { url, serviceRoleKey, profile };
}

/**
 * Empties every public data table of the local `postgres` database (schema, triggers,
 * ledgers and grants stay). Triggers are bypassed only for this superuser session.
 */
export function resetLocalPgData(): void {
  localPsql(`
    begin;
    set local session_replication_role = replica;
    do $reset$
    declare targets text;
    begin
      -- One TRUNCATE for every table: per-table statements cost seconds per test.
      select string_agg(format('public.%I', c.relname), ',' order by c.relname) into targets
        from pg_catalog.pg_class c
        where c.relnamespace='public'::regnamespace and c.relkind='r' and c.relname<>'appmeta';
      if targets is not null then execute 'truncate table ' || targets; end if;
      update public.appmeta set revision=0 where singleton=1;
      if exists(select 1 from pg_catalog.pg_attribute where attrelid='public.appmeta'::regclass
        and attname='workflow_adapter_write' and not attisdropped) then
        execute 'update public.appmeta set workflow_adapter_write=0 where singleton=1';
      end if;
    end $reset$;
    commit;
  `);
}

/**
 * `it` that is skipped when BIZTANIA_PG_TESTS=1. Use only for cases that are bound to the
 * SQLite storage shape (raw `payload` TEXT rows, SQLite triggers/pragmas/sqlite_master,
 * on-disk file migrations) or that expose a documented PostgreSQL adapter gap
 * (docs/BIZTANIA_WAVE5_LOCAL_PG.md section 4/5). They still run in the default suite.
 */
export const itSqliteBound: typeof it = (pgTestsEnabled ? it.skip : it) as typeof it;

/**
 * Inserts one ACTIVE Workflow V2 dashboard share exactly as the V2 writer would persist it (marker 2, full body), for
 * router tests that need "this dashboard has an active V2 share". The synthetic hybrid body the SQLite tests write
 * (`status: 'active'` without the V2 fields) is rightly rejected by PostgreSQL's V2 body validation, and building the
 * whole V2 provenance chain here would test nothing the router cares about. Triggers and FKs are bypassed for this one
 * superuser statement only; the row itself is a fully valid V2 body.
 */
export function seedRawV2ActiveShare(shareId: string, dashboardId: string): void {
  const body = {
    id: shareId, dashboardId, dashboardVersionId: `${shareId}-version`, senderIdentityId: 'raw-sender-identity',
    recipientIdentityId: 'raw-recipient-identity', approvedBranchIds: [], classification: 'internal',
    verificationDigest: 'a'.repeat(64), keyVersion: 1, channel: 'simulated_email', policy: { id: 'demo-workflow', version: 1, digest: 'b'.repeat(64) },
    status: 'active', expiresAt: '2099-01-01T00:00:00.000Z', rowVersion: 1, semanticKey: `${shareId}-semantic`,
    executionId: `${shareId}-execution`, createdAt: '2026-10-01T00:00:00.000Z', revokedAt: null,
  };
  localPsql(`
    begin;
    set local session_replication_role = replica;
    insert into public.dashboard_shares(id,payload,row_version,workflow_contract_version,dashboard_id,status)
      values ('${shareId}', '${JSON.stringify(body).replaceAll("'", "''")}'::jsonb, 1, 2, '${dashboardId}', 'active');
    update public.appmeta set revision=revision+1 where singleton=1;
    commit;
  `);
}

/** Revokes a share created by seedRawV2ActiveShare (same rules: one superuser statement, valid V2 body, version + 1). */
export function revokeRawV2Share(shareId: string): void {
  localPsql(`
    begin;
    set local session_replication_role = replica;
    update public.dashboard_shares set row_version=row_version+1, status='revoked',
      payload=payload || jsonb_build_object('status','revoked','rowVersion',row_version+1,'revokedAt','2026-10-02T00:00:00.000Z')
      where id='${shareId}';
    update public.appmeta set revision=revision+1 where singleton=1;
    commit;
  `);
}
