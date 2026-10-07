import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import type { DashboardSpec, PendingAction, Profile } from '../lib/contracts';
import {
  getWorkflowProjection,
  validateWorkflowProjectionBody,
  validateWorkflowProjectionWriteBody,
} from '../lib/storage/workflow-projections';
import {
  WORKFLOW_PENDING_ACTION_V2_BODY_GUARD_MIGRATION,
  WORKFLOW_PENDING_ACTION_REVISION_MIGRATION,
  WORKFLOW_PENDING_ACTION_DELETE_FENCE_MIGRATION,
  WORKFLOW_PENDING_ACTION_INSERT_IDENTITY_FENCE_MIGRATION,
  WORKFLOW_PENDING_ACTION_FRESH_V1_INSERT_MIGRATION,
  WORKFLOW_PENDING_ACTION_FRESH_V1_STATUS_PROJECTION_MIGRATION,
} from '../lib/storage/workflow-sqlite-migrations';
import { digest } from '../lib/core/utils';
import {
  pendingActionV2Schema,
  type PendingActionV2,
  type WorkflowPayloadV2,
} from '../lib/workflows/contracts';
import { demoWorkflowPolicyV1, getDemoWorkflowPolicyV1Pin } from '../lib/workflows/policy';
import { createWorkflowSqliteFixture } from './helpers/workflow-storage';
import { itSqliteBound } from './helpers/local-pg';

const NOW = '2026-10-05T00:00:00.000Z';
const LATER = '2099-01-01T00:00:00.000Z';
const HISTORICAL_PENDING_ACTION_REVISION_DIGEST = '4ad1e3fc649d63e6c9c73c42645f6df46310c482fac2e6dc6153ef236aeb799a';
const REUSED_ID_PENDING_ACTION_REVISION_DIGEST = '42ef4db17800ecb84a75b408c64840e2c38152c39bec57aece119ddfb3377f10';
const actorId = 'revision-storage-actor';
const sessionId = 'revision-storage-session';
const conversationId = 'revision-storage-conversation';

type LegacyRevisionAction = PendingAction & {
  predecessorActionId?: string;
  supersededByActionId?: string;
  staleReason?: 'superseded' | 'user_cancelled' | 'expired' | 'mode_changed' | 'release_changed' | 'evidence_changed' | 'source_turn_failed' | 'source_turn_cancelled';
  revisionDiff?: string[];
};

function dashboardSpec(title: string): DashboardSpec {
  return {
    title,
    description: 'Revision storage fixture.',
    scope: { region: 'east', date: '2026-10-05', branchIds: ['branch-east-1'] },
    widgets: [{ type: 'metric', title: 'Net sales', metric: 'net_sales' }],
  };
}

function legacyAction(id: string, overrides: Partial<LegacyRevisionAction> = {}): LegacyRevisionAction {
  return {
    id,
    actorId,
    sessionId,
    conversationId,
    turnId: `turn-${id}`,
    mode: 'live_ai',
    modeRevision: 0,
    payload: { kind: 'dashboard_create', spec: dashboardSpec('Original dashboard') },
    payloadHash: `payload-hash-${id}`,
    evidenceVersion: null,
    packs: [],
    actionContractVersion: 1,
    approvalScope: { region: 'east', date: '2026-10-05', branchIds: ['branch-east-1'] },
    approvalDisplay: { artifactTitle: 'Original dashboard' },
    createdAt: NOW,
    expiresAt: LATER,
    status: 'pending',
    preview: 'Review the dashboard request.',
    ...overrides,
  };
}

function profile(id: string): Profile {
  return { id, name: 'Synthetic revision storage actor', role: 'executive', active: true, permissions: [], regions: [] };
}

async function seedOwnerContext(store: Awaited<ReturnType<typeof createWorkflowSqliteFixture>>['store']): Promise<void> {
  await store.transaction(async tx => {
    await tx.put('profiles', profile(actorId));
    await tx.put('sessions', {
      id: sessionId,
      profileId: actorId,
      mode: 'live_ai',
      modeRevision: 0,
      csrfToken: 'revision-storage-csrf',
      expiresAt: LATER,
      createdAt: NOW,
    });
    await tx.put('conversations', {
      id: conversationId,
      actorId,
      title: 'Revision storage',
      pinned: false,
      pinnedAt: null,
      archivedAt: null,
      rowVersion: 1,
      createdAt: NOW,
      updatedAt: NOW,
      lastScope: null,
      lastDashboardId: null,
    });
  });
}

function v2Action(id = 'revision-storage-v2-action'): PendingActionV2 {
  const shareId = 'revision-storage-v2-share';
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
      targetId: 'revision-storage-v2-target',
      ref: expected.ref,
      semanticKey: 'revision-storage-v2-semantic-key',
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
    releaseRevision: 'revision-storage-r1',
    executionMode: 'atomic_local',
    createdAt: NOW,
    expiresAt: LATER,
    status: 'pending',
  });
}

function insertRawV2Action(db: Database.Database, action: PendingActionV2, body: unknown): void {
  db.prepare(`
    INSERT INTO pending_actions (
      id, payload, workflow_contract_version, row_version,
      actor_id, session_id, conversation_id, reviewed_snapshot_id, status,
      idempotency_key, payload_hash, expires_at, policy_id, policy_version, policy_digest
    ) VALUES (
      @id, @payload, 2, 1,
      @actorId, @sessionId, @conversationId, @reviewedSnapshotId, @status,
      @idempotencyKey, @payloadHash, @expiresAt, @policyId, @policyVersion, @policyDigest
    )
  `).run({
    id: action.id,
    payload: JSON.stringify(body),
    actorId: action.actorId,
    sessionId: action.sessionId,
    conversationId: action.conversationId,
    reviewedSnapshotId: action.reviewedSnapshotId,
    status: action.status,
    idempotencyKey: action.idempotencyKey,
    payloadHash: action.payloadHash,
    expiresAt: action.expiresAt,
    policyId: action.policy.id,
    policyVersion: action.policy.version,
    policyDigest: action.policy.digest,
  });
}

function installPermissiveHistoricalPendingActionV2InsertGuard(db: Database.Database): void {
  db.exec(`
    DROP TRIGGER workflow_pending_actions_insert_guard;
    CREATE TRIGGER workflow_pending_actions_insert_guard BEFORE INSERT ON pending_actions
    WHEN NEW.workflow_contract_version=2 AND workflow_migration_active()=0 BEGIN
      SELECT CASE WHEN NEW.row_version<>1 THEN RAISE(ABORT,'Invalid workflow insertion version') END;
    END;
  `);
}

function dropPendingActionDescendantMigrations(db: Database.Database): void {
  for (const migration of [
    WORKFLOW_PENDING_ACTION_DELETE_FENCE_MIGRATION,
    WORKFLOW_PENDING_ACTION_INSERT_IDENTITY_FENCE_MIGRATION,
    WORKFLOW_PENDING_ACTION_FRESH_V1_INSERT_MIGRATION,
    WORKFLOW_PENDING_ACTION_FRESH_V1_STATUS_PROJECTION_MIGRATION,
  ]) {
    db.prepare('DELETE FROM workflow_schema_migrations WHERE id=?').run(migration);
  }
  db.exec('DROP TRIGGER IF EXISTS workflow_pending_actions_delete_fence');
  db.exec('DROP TRIGGER IF EXISTS workflow_pending_actions_insert_identity_fence');
  db.exec('DROP TRIGGER IF EXISTS workflow_pending_actions_fresh_v1_insert_guard');
  db.exec('DROP TRIGGER IF EXISTS workflow_pending_actions_fresh_v1_status_projection_guard');
}

describe('legacy V1 pending action revision projection', () => {
  it('keeps legacy rows readable and accepts bounded immutable A→B lineage on new V1 bodies', () => {
    const predecessor = legacyAction('revision-storage-a');
    const replacement = legacyAction('revision-storage-b', {
      turnId: 'turn-revision-storage-b',
      payload: { kind: 'dashboard_create', spec: dashboardSpec('Revised dashboard') },
      payloadHash: 'payload-hash-replacement',
      predecessorActionId: predecessor.id,
      revisionDiff: ['เปลี่ยนชื่อ: "Original dashboard" → "Revised dashboard"'],
    });
    const superseded = legacyAction(predecessor.id, {
      status: 'stale',
      supersededByActionId: replacement.id,
      staleReason: 'superseded',
    });

    expect(validateWorkflowProjectionBody<LegacyRevisionAction>('pending_actions', predecessor.id, 1, predecessor).body)
      .toEqual(predecessor);
    expect(validateWorkflowProjectionWriteBody<LegacyRevisionAction>('pending_actions', replacement.id, 1, replacement).body)
      .toEqual(replacement);
    expect(validateWorkflowProjectionBody<LegacyRevisionAction>('pending_actions', superseded.id, 2, superseded).body)
      .toEqual(superseded);

    const projection = getWorkflowProjection('pending_actions');
    expect(projection.immutableFields).toContain('predecessorActionId');
    expect(projection.immutableFields).toContain('revisionDiff');
    expect(projection.terminalImmutableFields.claimed).toEqual(['supersededByActionId', 'staleReason']);
    expect(projection.terminalImmutableFields.stale).toEqual(['supersededByActionId', 'staleReason']);

    const unchangedV2 = v2Action();
    expect(pendingActionV2Schema.parse(unchangedV2)).toEqual(unchangedV2);
    expect(() => getWorkflowProjection('pending_actions').bodySchema.parse({
      ...unchangedV2,
      predecessorActionId: predecessor.id,
      revisionDiff: ['revision'],
    })).toThrow();
  });

  it('rejects partial lineage, invalid stale metadata, unknown reasons, and malformed revision diffs', () => {
    const predecessor = legacyAction('revision-storage-invalid-a');
    const validLineage = {
      predecessorActionId: predecessor.id,
      revisionDiff: ['Changed title.'],
    };

    const invalidBodies = [
      { ...predecessor, predecessorActionId: 'revision-storage-parent-without-diff' },
      { ...predecessor, ...validLineage, revisionDiff: [] },
      { ...predecessor, ...validLineage, revisionDiff: ['   '] },
      { ...predecessor, ...validLineage, revisionDiff: ['x'.repeat(601)] },
      { ...predecessor, ...validLineage, revisionDiff: Array.from({ length: 33 }, (_, index) => `change ${index}`) },
      { ...predecessor, staleReason: 'superseded' },
      { ...predecessor, status: 'stale', staleReason: 'superseded' },
      { ...predecessor, status: 'stale', supersededByActionId: 'revision-storage-successor', staleReason: 'made_up_reason' },
      { ...predecessor, unexpectedLineage: true },
    ];

    for (const body of invalidBodies) {
      expect(() => validateWorkflowProjectionBody('pending_actions', predecessor.id, 1, body)).toThrow();
    }
  });
});

describe('SQLite V1 pending action revision guard', () => {
  itSqliteBound('rejects V1 lineage fields in raw marker-two pending action bodies', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const store = fixture.store;
      await seedOwnerContext(store);
      const policyPin = getDemoWorkflowPolicyV1Pin();
      await store.workflowTransaction(tx => tx.insertUnique('workflow_policies', {
        id: policyPin.id,
        version: policyPin.version,
        digest: policyPin.digest,
        policy: demoWorkflowPolicyV1,
      }, { constraint: 'workflow_policies_primary_key', values: { id: policyPin.id } }));

      const db = fixture.openDatabase();
      try {
        const baseline = v2Action('revision-storage-v2-raw-baseline');
        expect(() => insertRawV2Action(db, baseline, baseline)).not.toThrow();

        const actionWithV1Lineage = v2Action('revision-storage-v2-with-v1-lineage');
        const invalidBody = {
          ...actionWithV1Lineage,
          predecessorActionId: 'revision-storage-v1-predecessor',
          revisionDiff: ['This field is V1-only.'],
        };
        expect(pendingActionV2Schema.safeParse(invalidBody).success).toBe(false);
        expect(() => insertRawV2Action(db, actionWithV1Lineage, invalidBody)).toThrow();
        expect(db.prepare('SELECT id FROM pending_actions WHERE id=?').get(actionWithV1Lineage.id)).toBeUndefined();
      } finally {
        db.close();
      }
    } finally {
      await fixture.dispose();
    }
  });

  itSqliteBound('upgrades and reapplies the trigger without backfilling or rewriting an old V1 action', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const initialStore = fixture.store;
      let oldAction: LegacyRevisionAction;
      try {
        await seedOwnerContext(initialStore);
        const policyPin = getDemoWorkflowPolicyV1Pin();
        await initialStore.workflowTransaction(tx => tx.insertUnique('workflow_policies', {
          id: policyPin.id,
          version: policyPin.version,
          digest: policyPin.digest,
          policy: demoWorkflowPolicyV1,
        }, { constraint: 'workflow_policies_primary_key', values: { id: policyPin.id } }));
        oldAction = legacyAction('revision-storage-existing-a', {
          predecessorActionId: 'revision-storage-existing-predecessor',
          revisionDiff: ['Existing immutable V1 lineage.'],
        });
        await initialStore.transaction(tx => tx.put('pending_actions', oldAction));
      } finally {
        initialStore.close?.();
      }

      const setupDb = fixture.openDatabase();
      let before: unknown;
      let revisionBefore: unknown;
      try {
        before = setupDb.prepare(
          'SELECT payload,row_version,workflow_contract_version FROM pending_actions WHERE id=?',
        ).get(oldAction.id);
        revisionBefore = setupDb.prepare('SELECT revision FROM appmeta WHERE singleton=1').get();
        expect(setupDb.prepare('SELECT id FROM workflow_schema_migrations WHERE id=?')
          .get(WORKFLOW_PENDING_ACTION_REVISION_MIGRATION)).toBeDefined();
        setupDb.prepare('UPDATE workflow_schema_migrations SET digest=? WHERE id=?')
          .run(HISTORICAL_PENDING_ACTION_REVISION_DIGEST, WORKFLOW_PENDING_ACTION_REVISION_MIGRATION);
        setupDb.prepare('DELETE FROM workflow_schema_migrations WHERE id=?')
          .run(WORKFLOW_PENDING_ACTION_V2_BODY_GUARD_MIGRATION);
        dropPendingActionDescendantMigrations(setupDb);
        setupDb.exec('DROP TRIGGER workflow_pending_actions_v1_update_guard');
        setupDb.exec('DROP TRIGGER workflow_pending_actions_v1_insert_guard');
        // The 2763b57 V2 insert guard used the V1 allowlist, so it accepted V1 lineage keys on marker-two bodies.
        installPermissiveHistoricalPendingActionV2InsertGuard(setupDb);
        setupDb.exec('SAVEPOINT historical_pending_action_guard_probe');
        try {
          const historicalInvalid = v2Action('revision-storage-historical-v2-v1-lineage');
          expect(() => insertRawV2Action(setupDb, historicalInvalid, {
            ...historicalInvalid,
            predecessorActionId: 'revision-storage-pre-upgrade-v1-action',
            revisionDiff: ['V1 lineage was accepted by the historical marker-two guard.'],
          })).not.toThrow();
        } finally {
          setupDb.exec('ROLLBACK TO historical_pending_action_guard_probe');
          setupDb.exec('RELEASE historical_pending_action_guard_probe');
        }
      } finally {
        setupDb.close();
      }

      const upgradedStore = fixture.reopen();
      try {
        const afterUpgradeDb = fixture.openDatabase();
        try {
          const afterUpgrade = afterUpgradeDb.prepare(
            'SELECT payload,row_version,workflow_contract_version FROM pending_actions WHERE id=?',
          ).get(oldAction.id);
          expect(afterUpgrade).toEqual(before);
          expect(afterUpgradeDb.prepare('SELECT revision FROM appmeta WHERE singleton=1').get()).toEqual(revisionBefore);
          expect(afterUpgradeDb.prepare('SELECT id FROM workflow_schema_migrations WHERE id=?')
            .get(WORKFLOW_PENDING_ACTION_REVISION_MIGRATION)).toBeDefined();
          expect(afterUpgradeDb.prepare('SELECT digest FROM workflow_schema_migrations WHERE id=?')
            .get(WORKFLOW_PENDING_ACTION_REVISION_MIGRATION)).toEqual({ digest: HISTORICAL_PENDING_ACTION_REVISION_DIGEST });
          expect(afterUpgradeDb.prepare('SELECT id FROM workflow_schema_migrations WHERE id=?')
            .get(WORKFLOW_PENDING_ACTION_V2_BODY_GUARD_MIGRATION)).toBeDefined();
          expect(afterUpgradeDb.prepare('SELECT id FROM workflow_schema_migrations WHERE id=?')
            .get(WORKFLOW_PENDING_ACTION_DELETE_FENCE_MIGRATION)).toBeDefined();
          expect(afterUpgradeDb.prepare('SELECT id FROM workflow_schema_migrations WHERE id=?')
            .get(WORKFLOW_PENDING_ACTION_INSERT_IDENTITY_FENCE_MIGRATION)).toBeDefined();
          expect(afterUpgradeDb.prepare('SELECT id FROM workflow_schema_migrations WHERE id=?')
            .get(WORKFLOW_PENDING_ACTION_FRESH_V1_INSERT_MIGRATION)).toBeDefined();
          expect(afterUpgradeDb.prepare('SELECT id FROM workflow_schema_migrations WHERE id=?')
            .get(WORKFLOW_PENDING_ACTION_FRESH_V1_STATUS_PROJECTION_MIGRATION)).toBeDefined();
          expect(afterUpgradeDb.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name=?")
            .get('workflow_pending_actions_v1_update_guard')).toEqual({ name: 'workflow_pending_actions_v1_update_guard' });
          const upgradedBaseline = v2Action('revision-storage-upgraded-v2-baseline');
          expect(() => insertRawV2Action(afterUpgradeDb, upgradedBaseline, upgradedBaseline)).not.toThrow();
          const upgradedInvalid = v2Action('revision-storage-upgraded-v2-v1-lineage');
          expect(() => insertRawV2Action(afterUpgradeDb, upgradedInvalid, {
            ...upgradedInvalid,
            predecessorActionId: 'revision-storage-pre-upgrade-v1-action',
            revisionDiff: ['V1 lineage is not allowed in a marker-two body.'],
          })).toThrow();
          expect(afterUpgradeDb.prepare('SELECT id FROM pending_actions WHERE id=?').get(upgradedInvalid.id)).toBeUndefined();
        } finally {
          afterUpgradeDb.close();
        }
      } finally {
        upgradedStore.close?.();
      }

      const reusedIdSetupDb = fixture.openDatabase();
      try {
        reusedIdSetupDb.prepare('UPDATE workflow_schema_migrations SET digest=? WHERE id=?')
          .run(REUSED_ID_PENDING_ACTION_REVISION_DIGEST, WORKFLOW_PENDING_ACTION_REVISION_MIGRATION);
        reusedIdSetupDb.prepare('DELETE FROM workflow_schema_migrations WHERE id=?')
          .run(WORKFLOW_PENDING_ACTION_V2_BODY_GUARD_MIGRATION);
        dropPendingActionDescendantMigrations(reusedIdSetupDb);
      } finally {
        reusedIdSetupDb.close();
      }

      const reusedIdStore = fixture.reopen();
      try {
        const reusedIdDb = fixture.openDatabase();
        try {
          expect(reusedIdDb.prepare('SELECT digest FROM workflow_schema_migrations WHERE id=?')
            .get(WORKFLOW_PENDING_ACTION_REVISION_MIGRATION)).toEqual({ digest: REUSED_ID_PENDING_ACTION_REVISION_DIGEST });
          expect(reusedIdDb.prepare('SELECT id FROM workflow_schema_migrations WHERE id=?')
            .get(WORKFLOW_PENDING_ACTION_V2_BODY_GUARD_MIGRATION)).toBeDefined();
          expect(reusedIdDb.prepare(
            'SELECT payload,row_version,workflow_contract_version FROM pending_actions WHERE id=?',
          ).get(oldAction.id)).toEqual(before);
        } finally {
          reusedIdDb.close();
        }
      } finally {
        reusedIdStore.close?.();
      }

      const reappliedStore = fixture.reopen();
      try {
        const reapplyDb = fixture.openDatabase();
        try {
          expect(reapplyDb.prepare(
            'SELECT payload,row_version,workflow_contract_version FROM pending_actions WHERE id=?',
          ).get(oldAction.id)).toEqual(before);
          expect(reapplyDb.prepare('SELECT digest FROM workflow_schema_migrations WHERE id=?')
            .get(WORKFLOW_PENDING_ACTION_REVISION_MIGRATION)).toEqual({ digest: REUSED_ID_PENDING_ACTION_REVISION_DIGEST });
          expect(reapplyDb.prepare('SELECT id FROM workflow_schema_migrations WHERE id=?')
            .get(WORKFLOW_PENDING_ACTION_V2_BODY_GUARD_MIGRATION)).toBeDefined();
        } finally {
          reapplyDb.close();
        }
      } finally {
        reappliedStore.close?.();
      }

      const damagedDb = fixture.openDatabase();
      try {
        damagedDb.exec('DROP TRIGGER workflow_pending_actions_v1_update_guard');
      } finally {
        damagedDb.close();
      }
      expect(() => fixture.reopen()).toThrow(/incompatible action provenance trigger/);
    } finally {
      await fixture.dispose();
    }
  });

  itSqliteBound('fails closed without rewriting a persisted marker-two row accepted by the historical guard', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const initialStore = fixture.store;
      try {
        await seedOwnerContext(initialStore);
        const policyPin = getDemoWorkflowPolicyV1Pin();
        await initialStore.workflowTransaction(tx => tx.insertUnique('workflow_policies', {
          id: policyPin.id,
          version: policyPin.version,
          digest: policyPin.digest,
          policy: demoWorkflowPolicyV1,
        }, { constraint: 'workflow_policies_primary_key', values: { id: policyPin.id } }));
        await initialStore.transaction(tx => tx.put('pending_actions', legacyAction('revision-storage-fail-closed-v1')));
      } finally {
        initialStore.close?.();
      }

      const setupDb = fixture.openDatabase();
      let invalidId: string;
      let beforeInvalidRow: unknown;
      let beforeLedger: Array<{ id: string; digest: string }>;
      let revisionBefore: unknown;
      let historicalGuardSql: string;
      try {
        setupDb.prepare('UPDATE workflow_schema_migrations SET digest=? WHERE id=?')
          .run(HISTORICAL_PENDING_ACTION_REVISION_DIGEST, WORKFLOW_PENDING_ACTION_REVISION_MIGRATION);
        setupDb.prepare('DELETE FROM workflow_schema_migrations WHERE id=?')
          .run(WORKFLOW_PENDING_ACTION_V2_BODY_GUARD_MIGRATION);
        dropPendingActionDescendantMigrations(setupDb);
        setupDb.exec('DROP TRIGGER workflow_pending_actions_v1_update_guard');
        setupDb.exec('DROP TRIGGER workflow_pending_actions_v1_insert_guard');
        installPermissiveHistoricalPendingActionV2InsertGuard(setupDb);

        const invalidAction = v2Action('revision-storage-fail-closed-v2-lineage');
        invalidId = invalidAction.id;
        const invalidBody = {
          ...invalidAction,
          predecessorActionId: 'revision-storage-persisted-v1-predecessor',
          revisionDiff: ['Historical marker-two row carrying V1 lineage.'],
        };
        insertRawV2Action(setupDb, invalidAction, invalidBody);
        beforeInvalidRow = setupDb.prepare(
          'SELECT payload,row_version,workflow_contract_version FROM pending_actions WHERE id=?',
        ).get(invalidId);
        expect(beforeInvalidRow).toEqual({
          payload: JSON.stringify(invalidBody),
          row_version: 1,
          workflow_contract_version: 2,
        });
        const row = setupDb.prepare('SELECT sql FROM sqlite_master WHERE type=? AND name=?')
          .get('trigger', 'workflow_pending_actions_insert_guard') as { sql: string };
        historicalGuardSql = row.sql;
        beforeLedger = setupDb.prepare('SELECT id,digest FROM workflow_schema_migrations ORDER BY id')
          .all() as Array<{ id: string; digest: string }>;
        revisionBefore = setupDb.prepare('SELECT revision FROM appmeta WHERE singleton=1').get();
      } finally {
        setupDb.close();
      }

      expect(() => fixture.reopen()).toThrow(/Workflow migration incompatible table: pending_actions/);

      const afterFailureDb = fixture.openDatabase();
      try {
        expect(afterFailureDb.prepare(
          'SELECT payload,row_version,workflow_contract_version FROM pending_actions WHERE id=?',
        ).get(invalidId)).toEqual(beforeInvalidRow);
        expect(afterFailureDb.prepare('SELECT id,digest FROM workflow_schema_migrations ORDER BY id')
          .all()).toEqual(beforeLedger);
        expect(afterFailureDb.prepare('SELECT revision FROM appmeta WHERE singleton=1').get()).toEqual(revisionBefore);
        expect(afterFailureDb.prepare('SELECT sql FROM sqlite_master WHERE type=? AND name=?')
          .get('trigger', 'workflow_pending_actions_insert_guard')).toEqual({ sql: historicalGuardSql });
      } finally {
        afterFailureDb.close();
      }
    } finally {
      await fixture.dispose();
    }
  });

  itSqliteBound('atomically supersedes A with B, preserves approval data, and rejects later lineage or envelope edits', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const store = fixture.store;
      await seedOwnerContext(store);
      const insertedPendingWithReason = legacyAction('revision-storage-pending-reason', { staleReason: 'expired' });
      await expect(store.transaction(tx => tx.put('pending_actions', insertedPendingWithReason))).rejects.toThrow();
      expect(await store.get('pending_actions', insertedPendingWithReason.id)).toBeUndefined();
      const nullLineage = {
        ...legacyAction('revision-storage-null-lineage'),
        predecessorActionId: null,
      } as unknown as LegacyRevisionAction;
      await expect(store.transaction(tx => tx.put('pending_actions', nullLineage))).rejects.toThrow();
      expect(await store.get('pending_actions', nullLineage.id)).toBeUndefined();

      const insertedStale = legacyAction('revision-storage-inserted-stale', {
        status: 'stale',
        staleReason: 'expired',
      });
      await expect(store.transaction(tx => tx.put('pending_actions', insertedStale))).rejects.toThrow();
      expect(await store.get('pending_actions', insertedStale.id)).toBeUndefined();

      const freshClaimedB = legacyAction('revision-storage-fresh-claimed', {
        status: 'claimed',
        predecessorActionId: 'revision-storage-unpersisted-base',
        revisionDiff: ['Changed title'],
      });
      await expect(store.transaction(tx => tx.put('pending_actions', freshClaimedB))).rejects.toThrow();
      expect(await store.get('pending_actions', freshClaimedB.id)).toBeUndefined();

      const actionA = legacyAction('revision-storage-lifecycle-a');
      const actionB = legacyAction('revision-storage-lifecycle-b', {
        turnId: 'turn-revision-storage-lifecycle-b',
        payload: { kind: 'dashboard_create', spec: dashboardSpec('Production Revision Acceptance') },
        payloadHash: 'payload-hash-b',
        predecessorActionId: actionA.id,
        revisionDiff: [
          'เปลี่ยนชื่อ: "Original dashboard" → "Production Revision Acceptance"',
          'ลบ: "กำลังคน: แผนเทียบจริง"',
        ],
      });
      await store.transaction(tx => tx.put('pending_actions', actionA));

      await expect(store.transaction(async tx => {
        await tx.put('pending_actions', actionB);
        await tx.put('pending_actions', {
          ...actionA,
          status: 'stale',
          supersededByActionId: actionB.id,
          staleReason: 'superseded',
        });
      })).resolves.toBeUndefined();

      const staleA = await store.get<LegacyRevisionAction>('pending_actions', actionA.id);
      const pendingB = await store.get<LegacyRevisionAction>('pending_actions', actionB.id);
      expect(staleA).toMatchObject({
        status: 'stale',
        supersededByActionId: actionB.id,
        staleReason: 'superseded',
        payload: actionA.payload,
        payloadHash: actionA.payloadHash,
        approvalScope: actionA.approvalScope,
        approvalDisplay: actionA.approvalDisplay,
      });
      expect(pendingB).toEqual(actionB);

      const raw = fixture.openDatabase();
      const aPayload = JSON.parse((raw.prepare('SELECT payload FROM pending_actions WHERE id=?').get(actionA.id) as { payload: string }).payload);
      expect(aPayload.payload).toEqual(actionA.payload);
      expect(aPayload.payloadHash).toBe(actionA.payloadHash);
      expect(aPayload.approvalScope).toEqual(actionA.approvalScope);
      expect(aPayload.approvalDisplay).toEqual(actionA.approvalDisplay);
      raw.close();

      const staleAgain = { ...staleA!, staleReason: 'user_cancelled' as const, supersededByActionId: undefined };
      await expect(store.transaction(tx => tx.put('pending_actions', staleAgain))).rejects.toThrow();

      const reverted = { ...staleA!, status: 'pending' as const, staleReason: undefined, supersededByActionId: undefined };
      await expect(store.transaction(tx => tx.put('pending_actions', reverted))).rejects.toThrow();

      const changedB = { ...pendingB!, revisionDiff: ['Different diff'] };
      await expect(store.transaction(tx => tx.put('pending_actions', changedB))).rejects.toThrow();
      const changedPredecessor = { ...pendingB!, predecessorActionId: 'revision-storage-different-base' };
      await expect(store.transaction(tx => tx.put('pending_actions', changedPredecessor))).rejects.toThrow();

      const claimedB = { ...pendingB!, status: 'claimed' as const };
      await store.transaction(tx => tx.put('pending_actions', claimedB));
      const completedB = { ...claimedB, status: 'completed' as const };
      await store.transaction(tx => tx.put('pending_actions', completedB));
      expect(await store.get<LegacyRevisionAction>('pending_actions', actionB.id)).toEqual(completedB);

      const tamperedCompletedB = { ...completedB, payloadHash: 'tampered-after-completion' };
      await expect(store.transaction(tx => tx.put('pending_actions', tamperedCompletedB))).rejects.toThrow();
      expect(await store.get<LegacyRevisionAction>('pending_actions', actionB.id)).toEqual(completedB);

      const pendingC = legacyAction('revision-storage-envelope-c');
      await store.transaction(tx => tx.put('pending_actions', pendingC));
      const tamperedC = {
        ...pendingC,
        status: 'stale' as const,
        payloadHash: 'tampered-hash',
        supersededByActionId: 'revision-storage-envelope-successor',
        staleReason: 'superseded' as const,
      };
      await expect(store.transaction(tx => tx.put('pending_actions', tamperedC))).rejects.toThrow();
      expect(await store.get<LegacyRevisionAction>('pending_actions', pendingC.id)).toEqual(pendingC);

      const claimedD = legacyAction('revision-storage-claim-d');
      await store.transaction(async tx => {
        await tx.put('pending_actions', claimedD);
        await tx.put('pending_actions', { ...claimedD, status: 'claimed' });
      });
      await store.transaction(tx => tx.put('pending_actions', { ...claimedD, status: 'completed' }));

      const claimedE = legacyAction('revision-storage-claim-e');
      await store.transaction(async tx => {
        await tx.put('pending_actions', claimedE);
        await tx.put('pending_actions', { ...claimedE, status: 'claimed' });
      });
      await expect(store.transaction(tx => tx.put('pending_actions', {
        ...claimedE,
        status: 'stale',
        staleReason: 'expired',
      }))).rejects.toThrow();
      await store.transaction(tx => tx.put('pending_actions', { ...claimedE, status: 'stale' }));
    } finally {
      await fixture.dispose();
    }
  });

  it('cancels a lineage-bearing replacement once and rejects stale upsert tampering', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const store = fixture.store;
      await seedOwnerContext(store);
      const actionA = legacyAction('revision-storage-cancel-lineage-a');
      const actionB = legacyAction('revision-storage-cancel-lineage-b', {
        turnId: 'turn-revision-storage-cancel-lineage-b',
        payload: { kind: 'dashboard_create', spec: dashboardSpec('Replacement before cancel') },
        payloadHash: 'revision-storage-cancel-lineage-hash',
        predecessorActionId: actionA.id,
        revisionDiff: ['Changed title before cancellation'],
      });
      await store.transaction(tx => tx.put('pending_actions', actionA));
      await store.transaction(async tx => {
        await tx.put('pending_actions', actionB);
        await tx.put('pending_actions', {
          ...actionA,
          status: 'stale',
          supersededByActionId: actionB.id,
          staleReason: 'superseded',
        });
      });

      const cancelledB = { ...actionB, status: 'stale' as const, staleReason: 'user_cancelled' as const };
      await store.transaction(tx => tx.put('pending_actions', cancelledB));
      expect(await store.get<LegacyRevisionAction>('pending_actions', actionB.id)).toEqual(cancelledB);
      expect(cancelledB.supersededByActionId).toBeUndefined();

      await store.transaction(tx => tx.put('pending_actions', cancelledB));
      expect(await store.get<LegacyRevisionAction>('pending_actions', actionB.id)).toEqual(cancelledB);

      const tamperedBodies = [
        { ...cancelledB, payloadHash: 'tampered-cancelled-hash' },
        { ...cancelledB, payload: { kind: 'dashboard_create', spec: dashboardSpec('Tampered payload') } },
        { ...cancelledB, predecessorActionId: 'revision-storage-other-predecessor' },
        { ...cancelledB, revisionDiff: ['Tampered lineage diff'] },
        { ...cancelledB, status: 'pending' as const },
      ];
      for (const tampered of tamperedBodies) {
        await expect(store.transaction(tx => tx.put('pending_actions', tampered))).rejects.toThrow();
        expect(await store.get<LegacyRevisionAction>('pending_actions', actionB.id)).toEqual(cancelledB);
      }
    } finally {
      await fixture.dispose();
    }
  });
});
