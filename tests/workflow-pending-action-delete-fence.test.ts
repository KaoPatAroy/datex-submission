import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import type { PendingAction, Profile } from '../lib/contracts';
import { digest } from '../lib/core/utils';
import { localPsql, migrationPath } from '../scripts/local-supabase';
import { itSqliteBound, pgTestsEnabled } from './helpers/local-pg';
import { createWorkflowSqliteFixture } from './helpers/workflow-storage';
import {
  WORKFLOW_PENDING_ACTION_DELETE_FENCE_MIGRATION,
  WORKFLOW_PENDING_ACTION_FRESH_V1_INSERT_MIGRATION,
  WORKFLOW_PENDING_ACTION_FRESH_V1_STATUS_PROJECTION_MIGRATION,
  WORKFLOW_PENDING_ACTION_INSERT_IDENTITY_FENCE_MIGRATION,
} from '../lib/storage/workflow-sqlite-migrations';
import {
  pendingActionV2Schema,
  type PendingActionV2,
  type WorkflowPayloadV2,
} from '../lib/workflows/contracts';
import { demoWorkflowPolicyV1, getDemoWorkflowPolicyV1Pin } from '../lib/workflows/policy';

const NOW = '2026-10-05T02:00:00.000Z';
const LATER = '2099-01-01T00:00:00.000Z';
const actorId = 'delete-fence-actor';
const sessionId = 'delete-fence-session';
const conversationId = 'delete-fence-conversation';

function profile(id: string): Profile {
  return { id, name: 'Synthetic delete-fence profile', role: 'executive', active: true, permissions: [], regions: [] };
}

function legacyAction(id: string, overrides: Partial<PendingAction> = {}): PendingAction {
  return {
    id,
    actorId,
    sessionId,
    conversationId,
    turnId: `turn-${id}`,
    mode: 'live_ai',
    modeRevision: 0,
    payload: {
      kind: 'dashboard_create',
      spec: {
        title: 'Delete-fence approval',
        description: 'Synthetic immutable approval fixture.',
        scope: { region: 'east', date: '2026-10-05', branchIds: ['delete-fence-branch'] },
        widgets: [{ type: 'metric', title: 'Net sales', metric: 'net_sales' }],
      },
    },
    payloadHash: `hash-${id}`,
    evidenceVersion: null,
    packs: [],
    actionContractVersion: 1,
    approvalScope: { region: 'east', date: '2026-10-05', branchIds: ['delete-fence-branch'] },
    approvalDisplay: { artifactTitle: 'Delete-fence approval' },
    createdAt: NOW,
    expiresAt: LATER,
    status: 'pending',
    preview: 'Synthetic approval for delete-fence coverage.',
    ...overrides,
  };
}

function v2Action(): PendingActionV2 {
  const id = 'delete-fence-v2-pending';
  const shareId = 'delete-fence-v2-share';
  const turnId = `${id}-turn`;
  const payload: WorkflowPayloadV2 = { kind: 'dashboard_share_revoke', shareId };
  const expected = { ref: { table: 'dashboard_shares' as const, id: shareId }, rowVersion: 1, state: 'active' };
  return pendingActionV2Schema.parse({
    id,
    contractVersion: 2,
    actorId,
    sessionId,
    conversationId,
    turnId,
    mode: 'live_ai',
    modeRevision: 0,
    payload,
    payloadHash: digest(payload),
    idempotencyKey: digest({ id, turnId }),
    targets: [{
      targetId: 'delete-fence-v2-target',
      ref: expected.ref,
      semanticKey: 'delete-fence-v2-semantic-key',
      expectedRows: [expected],
      ownerIdentityId: actorId,
      expectedEffectRef: expected.ref,
      expectedEffectVersion: 2,
    }],
    targetCount: 1,
    expectedRows: [expected],
    approvedBranchIds: [],
    approvedOrgUnitIds: [],
    reviewedSnapshotId: null,
    policy: getDemoWorkflowPolicyV1Pin(),
    packs: [],
    releaseRevision: 'delete-fence-r1',
    executionMode: 'atomic_local',
    createdAt: NOW,
    expiresAt: LATER,
    status: 'pending',
  });
}

async function seedRows(store: Awaited<ReturnType<typeof createWorkflowSqliteFixture>>['store']): Promise<void> {
  await store.transaction(async tx => {
    await tx.put('profiles', profile(actorId));
    await tx.put('sessions', {
      id: sessionId, profileId: actorId, mode: 'live_ai', modeRevision: 0,
      csrfToken: 'delete-fence-csrf', expiresAt: LATER, createdAt: NOW,
    });
    await tx.put('conversations', {
      id: conversationId, actorId, title: 'Delete fence', pinned: false,
      archivedAt: null, rowVersion: 1, createdAt: NOW, updatedAt: NOW,
      lastScope: null, lastDashboardId: null,
    });
    await tx.put('profiles', profile('delete-fence-unrelated-profile'));
  });

  const pin = getDemoWorkflowPolicyV1Pin();
  await store.workflowTransaction(tx => tx.insertUnique('workflow_policies', {
    id: pin.id, version: pin.version, digest: pin.digest, policy: demoWorkflowPolicyV1,
  }, { constraint: 'workflow_policies_primary_key', values: { id: pin.id } }));

  const completed = legacyAction('delete-fence-v1-completed');
  const pending = legacyAction('delete-fence-v1-pending');
  // One commit is one net change: the lifecycle steps are separate commits (PostgreSQL has no per-put trigger firing).
  await store.transaction(async tx => { await tx.put('pending_actions', completed); });
  await store.transaction(async tx => { await tx.put('pending_actions', { ...completed, status: 'claimed' }); });
  await store.transaction(async tx => { await tx.put('pending_actions', { ...completed, status: 'completed' }); });
  await store.transaction(async tx => { await tx.put('pending_actions', pending); });

  const action = v2Action();
  await store.workflowTransaction(tx => tx.insertUnique('pending_actions', action, {
    constraint: 'pending_actions_primary_key', values: { id: action.id },
  }));
}

function pendingActionSnapshot(database: Database.Database) {
  return database.prepare('SELECT * FROM pending_actions ORDER BY id').all();
}

function insertRawV1Action(
  database: Database.Database,
  action: PendingAction,
  projectedStatus: PendingAction['status'] = action.status,
): void {
  database.prepare(`
    INSERT INTO pending_actions (
      id,payload,row_version,workflow_contract_version,actor_id,session_id,conversation_id,
      reviewed_snapshot_id,status,idempotency_key,payload_hash,expires_at,policy_id,policy_version,policy_digest
    ) VALUES (
      @id,@payload,NULL,NULL,@actorId,@sessionId,@conversationId,@reviewedSnapshotId,@status,NULL,
      @payloadHash,@expiresAt,NULL,NULL,NULL
    )
  `).run({
    id: action.id,
    payload: JSON.stringify(action),
    actorId: action.actorId,
    sessionId: action.sessionId,
    conversationId: action.conversationId,
    reviewedSnapshotId: null,
    status: projectedStatus,
    payloadHash: action.payloadHash,
    expiresAt: action.expiresAt,
  });
}

describe('SQLite pending-action delete fence', () => {
  itSqliteBound('upgrades a database with the immutable 0005 trigger while preserving rows and revision', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      await seedRows(fixture.store);
      fixture.store.close?.();

      const preUpgrade = fixture.openDatabase();
      let rowsBefore: unknown;
      let revisionBefore: unknown;
      let priorLedger: unknown;
      try {
        rowsBefore = pendingActionSnapshot(preUpgrade);
        revisionBefore = preUpgrade.prepare('SELECT revision FROM appmeta WHERE singleton=1').get();
        expect(preUpgrade.prepare('SELECT digest FROM workflow_schema_migrations WHERE id=?')
          .get(WORKFLOW_PENDING_ACTION_FRESH_V1_INSERT_MIGRATION)).toEqual({
          digest: '0290bacc31512b60c429a75a63d7edac370ba1d5ae13c020dd907fd07a130ef4',
        });
        expect(preUpgrade.prepare("SELECT name,tbl_name FROM main.sqlite_master WHERE type='trigger' AND name=?")
          .get('workflow_pending_actions_fresh_v1_insert_guard')).toEqual({
          name: 'workflow_pending_actions_fresh_v1_insert_guard', tbl_name: 'pending_actions',
        });
        priorLedger = preUpgrade.prepare('SELECT id,digest FROM workflow_schema_migrations WHERE id<>? ORDER BY id')
          .all(WORKFLOW_PENDING_ACTION_FRESH_V1_STATUS_PROJECTION_MIGRATION);
        preUpgrade.prepare('DELETE FROM workflow_schema_migrations WHERE id=?')
          .run(WORKFLOW_PENDING_ACTION_FRESH_V1_STATUS_PROJECTION_MIGRATION);
        preUpgrade.exec('DROP TRIGGER workflow_pending_actions_fresh_v1_status_projection_guard');
      } finally {
        preUpgrade.close();
      }

      const upgraded = fixture.reopen();
      const afterUpgrade = fixture.openDatabase();
      try {
        expect(pendingActionSnapshot(afterUpgrade)).toEqual(rowsBefore);
        expect(afterUpgrade.prepare('SELECT revision FROM appmeta WHERE singleton=1').get()).toEqual(revisionBefore);
        expect(afterUpgrade.prepare('SELECT id,digest FROM workflow_schema_migrations WHERE id<>? ORDER BY id')
          .all(WORKFLOW_PENDING_ACTION_FRESH_V1_STATUS_PROJECTION_MIGRATION)).toEqual(priorLedger);
        expect(afterUpgrade.prepare('SELECT id FROM workflow_schema_migrations WHERE id=?')
          .get(WORKFLOW_PENDING_ACTION_DELETE_FENCE_MIGRATION)).toBeDefined();
        expect(afterUpgrade.prepare('SELECT id FROM workflow_schema_migrations WHERE id=?')
          .get(WORKFLOW_PENDING_ACTION_INSERT_IDENTITY_FENCE_MIGRATION)).toBeDefined();
        expect(afterUpgrade.prepare('SELECT id FROM workflow_schema_migrations WHERE id=?')
          .get(WORKFLOW_PENDING_ACTION_FRESH_V1_INSERT_MIGRATION)).toBeDefined();
        expect(afterUpgrade.prepare('SELECT id FROM workflow_schema_migrations WHERE id=?')
          .get(WORKFLOW_PENDING_ACTION_FRESH_V1_STATUS_PROJECTION_MIGRATION)).toBeDefined();
        expect(afterUpgrade.prepare("SELECT name,tbl_name FROM main.sqlite_master WHERE type='trigger' AND name=?")
          .get('workflow_pending_actions_fresh_v1_insert_guard')).toEqual({
          name: 'workflow_pending_actions_fresh_v1_insert_guard', tbl_name: 'pending_actions',
        });
        expect(afterUpgrade.prepare("SELECT name,tbl_name FROM main.sqlite_master WHERE type='trigger' AND name=?")
          .get('workflow_pending_actions_fresh_v1_status_projection_guard')).toEqual({
          name: 'workflow_pending_actions_fresh_v1_status_projection_guard', tbl_name: 'pending_actions',
        });
      } finally {
        afterUpgrade.close();
        upgraded.close?.();
      }
    } finally {
      await fixture.dispose();
    }
  });

  itSqliteBound('rejects Store.remove for V1 and V2 actions even when the SQLite trigger is absent', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      await seedRows(fixture.store);
      const removeGuardProbe = fixture.openDatabase();
      try {
        removeGuardProbe.exec('DROP TRIGGER workflow_pending_actions_delete_fence');
      } finally {
        removeGuardProbe.close();
      }
      const ids = ['delete-fence-v1-pending', 'delete-fence-v1-completed', 'delete-fence-v2-pending'];
      expect(ids.length).toBeGreaterThan(0);
      const beforeRows = fixture.openDatabase();
      let rowsBefore: unknown;
      let revisionBefore: unknown;
      try {
        rowsBefore = beforeRows.prepare('SELECT * FROM pending_actions WHERE id IN (?,?,?) ORDER BY id').all(...ids);
        revisionBefore = beforeRows.prepare('SELECT revision FROM appmeta WHERE singleton=1').get();
      } finally {
        beforeRows.close();
      }
      for (const id of ids) {
        await expect(fixture.store.transaction(tx => tx.remove('pending_actions', id)))
          .rejects.toMatchObject({ code: 'STORAGE', definitelyNotCommitted: true });
      }
      const database = fixture.openDatabase();
      try {
        expect(database.prepare('SELECT * FROM pending_actions WHERE id IN (?,?,?) ORDER BY id').all(...ids)).toEqual(rowsBefore);
        expect(database.prepare('SELECT revision FROM appmeta WHERE singleton=1').get()).toEqual(revisionBefore);
      } finally {
        database.close();
      }
    } finally {
      await fixture.dispose();
    }
  });

  itSqliteBound('rejects direct SQLite DELETE for V1 and V2 actions while allowing pending-to-stale updates', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      await seedRows(fixture.store);
      const database = fixture.openDatabase();
      try {
        const ids = ['delete-fence-v1-pending', 'delete-fence-v1-completed', 'delete-fence-v2-pending'];
        expect(ids.length).toBeGreaterThan(0);
        for (const id of ids) {
          expect(() => database.prepare('DELETE FROM pending_actions WHERE id=?').run(id)).toThrow();
        }
        expect(database.prepare('SELECT id FROM pending_actions WHERE id IN (?,?,?) ORDER BY id').all(...ids))
          .toHaveLength(ids.length);
      } finally {
        database.close();
      }

      const pending = await fixture.store.get<PendingAction>('pending_actions', 'delete-fence-v1-pending');
      if (!pending) throw new Error('The synthetic V1 pending action was not readable.');
      await fixture.store.transaction(tx => tx.put('pending_actions', {
        ...pending, status: 'stale', staleReason: 'expired',
      }));
      expect(await fixture.store.get<PendingAction>('pending_actions', pending.id)).toMatchObject({
        id: pending.id, status: 'stale', staleReason: 'expired',
        payload: pending.payload, payloadHash: pending.payloadHash,
        approvalScope: pending.approvalScope, approvalDisplay: pending.approvalDisplay,
      });

      const unrelated = fixture.openDatabase();
      try {
        expect(() => unrelated.prepare('DELETE FROM profiles WHERE id=?').run('delete-fence-unrelated-profile'))
          .not.toThrow();
        expect(unrelated.prepare('SELECT id FROM profiles WHERE id=?').get('delete-fence-unrelated-profile'))
          .toBeUndefined();
      } finally {
        unrelated.close();
      }
    } finally {
      await fixture.dispose();
    }
  });

  itSqliteBound('rejects invalid or non-pending fresh V1 inserts through Store and direct SQL while preserving lifecycle updates', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      await seedRows(fixture.store);
      const invalidStoreBody = {
        ...legacyAction('delete-fence-invalid-store-v1'),
        unexpectedApprovalField: 'not part of the V1 action body',
      } as unknown as PendingAction;
      const staleStoreAction = legacyAction('delete-fence-stale-store-v1', { status: 'stale' });
      await expect(fixture.store.transaction(tx => tx.put('pending_actions', invalidStoreBody))).rejects.toThrow();
      await expect(fixture.store.transaction(tx => tx.put('pending_actions', staleStoreAction))).rejects.toThrow();

      const invalidSqlBody = {
        ...legacyAction('delete-fence-invalid-sql-v1'),
        unexpectedApprovalField: 'not part of the V1 action body',
      } as unknown as PendingAction;
      const staleSqlAction = legacyAction('delete-fence-stale-sql-v1', { status: 'stale' });
      const validSqlAction = legacyAction('delete-fence-valid-sql-v1');
      const database = fixture.openDatabase();
      try {
        expect(() => insertRawV1Action(database, invalidSqlBody)).toThrow();
        expect(() => insertRawV1Action(database, staleSqlAction)).toThrow();
        expect(database.prepare('SELECT id FROM pending_actions WHERE id IN (?,?,?,?) ORDER BY id').all(
          invalidStoreBody.id, staleStoreAction.id, invalidSqlBody.id, staleSqlAction.id,
        )).toEqual([]);

        expect(() => insertRawV1Action(database, validSqlAction)).not.toThrow();
        expect(database.prepare('SELECT id,status FROM pending_actions WHERE id=?').get(validSqlAction.id))
          .toEqual({ id: validSqlAction.id, status: 'pending' });
        const staleExisting = { ...validSqlAction, status: 'stale' as const, staleReason: 'expired' as const };
        expect(() => database.prepare('UPDATE pending_actions SET payload=? WHERE id=?')
          .run(JSON.stringify(staleExisting), staleExisting.id)).not.toThrow();
        expect(JSON.parse((database.prepare('SELECT payload FROM pending_actions WHERE id=?')
          .get(staleExisting.id) as { payload: string }).payload)).toMatchObject({ status: 'stale', staleReason: 'expired' });
      } finally {
        database.close();
      }
    } finally {
      await fixture.dispose();
    }
  });

  itSqliteBound('rejects a fresh V1 row whose valid pending body has a stale projected status', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      await seedRows(fixture.store);
      const action = legacyAction('delete-fence-stale-projection-v1');
      const database = fixture.openDatabase();
      try {
        expect(() => insertRawV1Action(database, action, 'stale')).toThrow();
        expect(database.prepare('SELECT id FROM pending_actions WHERE id=?').get(action.id)).toBeUndefined();
      } finally {
        database.close();
      }
    } finally {
      await fixture.dispose();
    }
  });

  itSqliteBound('rejects INSERT OR REPLACE for persisted V1 and V2 actions with recursive triggers off', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      await seedRows(fixture.store);
      const database = fixture.openDatabase();
      try {
        expect(database.pragma('recursive_triggers', { simple: true })).toBe(0);
        const ids = ['delete-fence-v1-pending', 'delete-fence-v1-completed', 'delete-fence-v2-pending'];
        expect(ids.length).toBeGreaterThan(0);
        const before = database.prepare('SELECT * FROM pending_actions WHERE id IN (?,?,?) ORDER BY id').all(...ids);
        for (const id of ids) {
          const replacement = legacyAction(id, {
            payloadHash: `replacement-hash-${id}`,
            payload: {
              kind: 'dashboard_create',
              spec: {
                title: 'Replacement approval',
                description: 'Must not replace historical approval.',
                scope: { region: 'east', date: '2026-10-05', branchIds: ['delete-fence-branch'] },
                widgets: [{ type: 'metric', title: 'Target', metric: 'target' }],
              },
            },
            preview: 'Replacement approval must be rejected.',
          });
          expect(() => database.prepare(`
            INSERT OR REPLACE INTO pending_actions (
              id,payload,row_version,workflow_contract_version,actor_id,session_id,conversation_id,
              reviewed_snapshot_id,status,idempotency_key,payload_hash,expires_at,policy_id,policy_version,policy_digest
            ) VALUES (
              @id,@payload,NULL,NULL,@actorId,@sessionId,@conversationId,NULL,@status,NULL,
              @payloadHash,@expiresAt,NULL,NULL,NULL
            )
          `).run({
            id: replacement.id,
            payload: JSON.stringify(replacement),
            actorId: replacement.actorId,
            sessionId: replacement.sessionId,
            conversationId: replacement.conversationId,
            status: replacement.status,
            payloadHash: replacement.payloadHash,
            expiresAt: replacement.expiresAt,
          })).toThrow();
        }
        expect(database.prepare('SELECT * FROM pending_actions WHERE id IN (?,?,?) ORDER BY id').all(...ids)).toEqual(before);
      } finally {
        database.close();
      }
    } finally {
      await fixture.dispose();
    }
  });

  itSqliteBound('reopens idempotently and fails closed when the 0006 status projection trigger drifts', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      await seedRows(fixture.store);
      const initial = fixture.openDatabase();
      let rowsBefore: unknown;
      let ledgerBefore: unknown;
      let revisionBefore: unknown;
      try {
        rowsBefore = pendingActionSnapshot(initial);
        ledgerBefore = initial.prepare('SELECT id,digest FROM workflow_schema_migrations ORDER BY id').all();
        revisionBefore = initial.prepare('SELECT revision FROM appmeta WHERE singleton=1').get();
      } finally {
        initial.close();
      }
      let store = fixture.reopen();
      store.close?.();
      store = fixture.reopen();
      store.close?.();

      const reopened = fixture.openDatabase();
      try {
        expect(pendingActionSnapshot(reopened)).toEqual(rowsBefore);
        expect(reopened.prepare('SELECT id,digest FROM workflow_schema_migrations ORDER BY id').all()).toEqual(ledgerBefore);
        expect(reopened.prepare('SELECT revision FROM appmeta WHERE singleton=1').get()).toEqual(revisionBefore);
      } finally {
        reopened.close();
      }

      const damaged = fixture.openDatabase();
      try {
        damaged.exec(`DROP TRIGGER workflow_pending_actions_fresh_v1_status_projection_guard;
          CREATE TRIGGER workflow_pending_actions_fresh_v1_status_projection_guard BEFORE INSERT ON pending_actions
          BEGIN SELECT 1; END`);
      } finally {
        damaged.close();
      }
      expect(() => fixture.reopen()).toThrow(/incompatible fresh V1 status projection trigger/);
    } finally {
      await fixture.dispose();
    }
  });

  itSqliteBound('fails closed on 0006 migration digest drift without changing rows, ledger, or revision', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      await seedRows(fixture.store);
      fixture.store.close?.();
      const damaged = fixture.openDatabase();
      let rowsBefore: unknown;
      let ledgerBefore: unknown;
      let revisionBefore: unknown;
      try {
        damaged.prepare('UPDATE workflow_schema_migrations SET digest=? WHERE id=?')
          .run('0'.repeat(64), WORKFLOW_PENDING_ACTION_FRESH_V1_STATUS_PROJECTION_MIGRATION);
        rowsBefore = pendingActionSnapshot(damaged);
        ledgerBefore = damaged.prepare('SELECT id,digest FROM workflow_schema_migrations ORDER BY id').all();
        revisionBefore = damaged.prepare('SELECT revision FROM appmeta WHERE singleton=1').get();
      } finally {
        damaged.close();
      }

      expect(() => fixture.reopen()).toThrow(/manifest changed without a new schema version/);
      const afterFailedUpgrade = fixture.openDatabase();
      try {
        expect(pendingActionSnapshot(afterFailedUpgrade)).toEqual(rowsBefore);
        expect(afterFailedUpgrade.prepare('SELECT id,digest FROM workflow_schema_migrations ORDER BY id').all())
          .toEqual(ledgerBefore);
        expect(afterFailedUpgrade.prepare('SELECT revision FROM appmeta WHERE singleton=1').get()).toEqual(revisionBefore);
      } finally {
        afterFailedUpgrade.close();
      }
    } finally {
      await fixture.dispose();
    }
  });
});

/**
 * PostgreSQL contract for the same invariants. The SQLite cases above test SQLite triggers, file migrations and
 * pragmas; on PostgreSQL the fence is the activated V1 guard (202610060001) plus the adapter's own V1 checks.
 */
describe.skipIf(!pgTestsEnabled)('PostgreSQL pending-action delete fence', () => {
  const ids = ['delete-fence-v1-pending', 'delete-fence-v1-completed', 'delete-fence-v2-pending'];
  const asService = (sql: string): string => localPsql(`set role service_role; ${sql}`);
  const sqlText = (value: unknown): string => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
  const snapshot = (): string => localPsql(
    "select coalesce(json_agg(t order by id)::text,'[]') from public.pending_actions t")
    + '|' + localPsql('select revision from public.appmeta where singleton=1');
  const insertSql = (action: PendingAction, status?: string): string => status === undefined
    ? `insert into public.pending_actions(id,payload) values ('${action.id}', ${sqlText(action)});`
    : `insert into public.pending_actions(id,payload,status) values ('${action.id}', ${sqlText(action)}, '${status}');`;
  const present = (id: string): boolean => localPsql(`select count(*) from public.pending_actions where id='${id}'`) === '1';
  const triggerSet = (): string => localPsql(
    "select string_agg(tgname||':'||tgenabled::text,',' order by tgname) from pg_trigger where tgrelid='public.pending_actions'::regclass and not tgisinternal");
  const activate = (): string => localPsql(readFileSync(migrationPath('202610060001_workflow_v1_guard_bridge_activate'), 'utf8'));

  it('re-applies the activated V1 guard idempotently while preserving rows, revision and trigger set', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      await seedRows(fixture.store);
      const before = snapshot();
      const triggers = triggerSet();
      activate();
      expect(snapshot()).toBe(before);
      expect(triggerSet()).toBe(triggers);
      expect(triggers).toContain('workflow_pending_action_v1_bridge_guard:O');
    } finally { await fixture.dispose(); }
  });

  it('rejects Store.remove for V1 and V2 actions', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      await seedRows(fixture.store);
      const before = snapshot();
      for (const id of ids) {
        await expect(fixture.store.transaction(tx => tx.remove('pending_actions', id)))
          .rejects.toMatchObject({ code: 'STORAGE', definitelyNotCommitted: true });
      }
      expect(snapshot()).toBe(before);
    } finally { await fixture.dispose(); }
  });

  it('rejects direct SQL DELETE for V1 and V2 actions while allowing pending-to-stale updates', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      await seedRows(fixture.store);
      for (const id of ids) expect(() => asService(`delete from public.pending_actions where id='${id}'`)).toThrow();
      expect(ids.every(present)).toBe(true);
      const pending = await fixture.store.get<PendingAction>('pending_actions', 'delete-fence-v1-pending');
      if (!pending) throw new Error('The synthetic V1 pending action was not readable.');
      await fixture.store.transaction(tx => tx.put('pending_actions', { ...pending, status: 'stale', staleReason: 'expired' }));
      expect(await fixture.store.get<PendingAction>('pending_actions', pending.id)).toMatchObject({
        id: pending.id, status: 'stale', staleReason: 'expired', payload: pending.payload, payloadHash: pending.payloadHash,
        approvalScope: pending.approvalScope, approvalDisplay: pending.approvalDisplay,
      });
      expect(() => asService("delete from public.profiles where id='delete-fence-unrelated-profile'")).not.toThrow();
      expect(localPsql("select count(*) from public.profiles where id='delete-fence-unrelated-profile'")).toBe('0');
    } finally { await fixture.dispose(); }
  });

  it('rejects invalid or non-pending fresh V1 inserts through Store and direct SQL while preserving lifecycle updates', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      await seedRows(fixture.store);
      const invalid = { ...legacyAction('delete-fence-invalid-store-v1'), unexpectedApprovalField: 'not part of the V1 action body' } as unknown as PendingAction;
      const stale = legacyAction('delete-fence-stale-store-v1', { status: 'stale' });
      await expect(fixture.store.transaction(tx => tx.put('pending_actions', invalid))).rejects.toThrow();
      await expect(fixture.store.transaction(tx => tx.put('pending_actions', stale))).rejects.toThrow();
      const invalidSql = { ...legacyAction('delete-fence-invalid-sql-v1'), unexpectedApprovalField: 'x' } as unknown as PendingAction;
      const staleSql = legacyAction('delete-fence-stale-sql-v1', { status: 'stale' });
      const valid = legacyAction('delete-fence-valid-sql-v1');
      expect(() => asService(insertSql(invalidSql))).toThrow();
      expect(() => asService(insertSql(staleSql))).toThrow();
      expect([invalid.id, stale.id, invalidSql.id, staleSql.id].some(present)).toBe(false);
      expect(() => asService(insertSql(valid))).not.toThrow();
      expect(localPsql(`select payload->>'status' from public.pending_actions where id='${valid.id}'`)).toBe('pending');
      const staleExisting = { ...valid, status: 'stale' as const, staleReason: 'expired' as const };
      expect(() => asService(`update public.pending_actions set payload=${sqlText(staleExisting)} where id='${valid.id}'`)).not.toThrow();
      expect(localPsql(`select payload->>'status' from public.pending_actions where id='${valid.id}'`)).toBe('stale');
    } finally { await fixture.dispose(); }
  });

  it('rejects a fresh V1 row whose valid pending body has a stale projected status', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      await seedRows(fixture.store);
      const action = legacyAction('delete-fence-stale-projection-v1');
      expect(() => asService(insertSql(action, 'stale'))).toThrow();
      expect(present(action.id)).toBe(false);
    } finally { await fixture.dispose(); }
  });

  it('rejects INSERT ... ON CONFLICT replacement for persisted V1 and V2 actions', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      await seedRows(fixture.store);
      const before = snapshot();
      for (const id of ids) {
        const replacement = legacyAction(id, {
          payloadHash: `replacement-hash-${id}`,
          payload: { kind: 'dashboard_create', spec: { title: 'Replacement approval', description: 'Must not replace historical approval.',
            scope: { region: 'east', date: '2026-10-05', branchIds: ['delete-fence-branch'] }, widgets: [{ type: 'metric', title: 'Target', metric: 'target' }] } },
          preview: 'Replacement approval must be rejected.',
        });
        expect(() => asService(`insert into public.pending_actions(id,payload) values ('${id}', ${sqlText(replacement)})
          on conflict(id) do update set payload=excluded.payload`)).toThrow();
        expect(() => asService(`delete from public.pending_actions where id='${id}'; ${insertSql(replacement)}`)).toThrow();
      }
      expect(snapshot()).toBe(before);
    } finally { await fixture.dispose(); }
  });

  it('fails closed on every write while a V1 guard trigger has drifted, and recovers when it is restored', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      await seedRows(fixture.store);
      const before = snapshot();
      const probe = legacyAction('delete-fence-drift-probe-v1');
      localPsql('alter table public.pending_actions disable trigger workflow_guard');
      try {
        expect(() => asService(insertSql(probe))).toThrow(/trigger inventory is incompatible/);
        await expect(fixture.store.transaction(tx => tx.put('pending_actions', probe))).rejects.toThrow();
        expect(snapshot()).toBe(before);
      } finally {
        localPsql('alter table public.pending_actions enable trigger workflow_guard');
      }
      await fixture.store.transaction(tx => tx.put('pending_actions', probe));
      expect(present(probe.id)).toBe(true);
    } finally { await fixture.dispose(); }
  });

  it('fails closed on bridge ledger digest drift without changing rows or revision', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      await seedRows(fixture.store);
      const before = snapshot();
      const original = localPsql("select definition_digest from nexus_private.workflow_v1_bridge_migrations where id='activate'");
      expect(original.length).toBeGreaterThan(0);
      localPsql(`update nexus_private.workflow_v1_bridge_migrations set definition_digest='${'0'.repeat(original.length)}' where id='activate'`);
      try {
        expect(() => activate()).toThrow();
        expect(snapshot()).toBe(before);
      } finally {
        localPsql(`update nexus_private.workflow_v1_bridge_migrations set definition_digest='${original}' where id='activate'`);
      }
      activate();
      expect(snapshot()).toBe(before);
    } finally { await fixture.dispose(); }
  });
});
