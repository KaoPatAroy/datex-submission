import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { tables, type Profile } from '../lib/contracts';
import { digest } from '../lib/core/utils';
import { createHrApprovalWorkflowBindings } from '../lib/packs/hr-approval-workflows';
import { demoWorkflowPolicyV1, getDemoWorkflowPolicyV1Pin } from '../lib/workflows/policy';
import { createWorkflowActionRunner } from '../lib/workflows/action-runner';
import { createWorkflowActionRuntime, workflowSnapshotDigest } from '../lib/workflows/action-runtime';
import { createOnboardingQueryService, type ReviewSnapshotTargetV2 } from '../lib/workflows/onboarding-queries';
import type { OnboardingRequest, ReviewSnapshot } from '../lib/workflows/contracts';
import {
  applyWorkflowSqliteMigrations,
  WORKFLOW_SNAPSHOT_PROOF_REFERENCES_MIGRATION,
  workflowSnapshotProofReferenceDefinitions,
} from '../lib/storage/workflow-sqlite-migrations';
import {
  WORKFLOW_BASE_DIGEST,
  WORKFLOW_BASE_MIGRATION,
  WORKFLOW_COMPLETENESS_DIGEST,
  WORKFLOW_COMPLETENESS_MIGRATION,
  WORKFLOW_CONVERSATION_PERSISTENCE_DIGEST,
  WORKFLOW_CONVERSATION_PERSISTENCE_MIGRATION,
  WORKFLOW_SNAPSHOT_PROOF_REFERENCES_DIGEST,
  WORKFLOW_SCOPE_DIGEST,
  WORKFLOW_SCOPE_MIGRATION,
  historicalWorkflowCompletenessDefinitions,
  historicalWorkflowConversationPersistenceDefinitions,
} from '../lib/storage/workflow-schema-history';
import { getWorkflowProjection } from '../lib/storage/workflow-projections';
import { createWorkflowSqliteFixture } from './helpers/workflow-storage';
import { itSqliteBound } from './helpers/local-pg';

const NOW = '2026-10-04T04:00:00.000Z';
const BUSINESS_DATE = '2026-10-04';
const STAGE_STOP = 'test-only migration checkpoint';
const REQUIRED_REFERENCE_COLUMNS = ['directory_identity_id', 'responsibility_id', 'action_execution_id'] as const;

type MigrationDefinition = typeof historicalWorkflowConversationPersistenceDefinitions[number];

function currentLedger(db: Database.Database) {
  return db.prepare('SELECT id, digest FROM workflow_schema_migrations ORDER BY id')
    .all() as Array<{ id: string; digest: string }>;
}

function rowBytes(db: Database.Database, table: string, id: string) {
  return db.prepare(`SELECT id, body, row_version FROM "${table}" WHERE id = ?`).get(id) as
    { id: string; body: string; row_version: number } | undefined;
}

function schemaSnapshot(db: Database.Database) {
  return db.prepare(`
    SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE sql IS NOT NULL AND type IN ('table', 'index', 'trigger')
    ORDER BY type, name
  `).all();
}

function materializeStage(db: Database.Database, migrationId: string): void {
  const prepare = db.prepare.bind(db);
  let checkpointed = false;
  const staged = new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql: string) => {
          const statement = prepare(sql);
          if (sql !== 'INSERT INTO workflow_schema_migrations(id,digest) VALUES(?,?)') return statement;
          return new Proxy(statement, {
            get(inner, key) {
              if (key === 'run') {
                return (...parameters: unknown[]) => {
                  const result = inner.run(...parameters);
                  if (parameters[0] === migrationId) {
                    target.exec('COMMIT');
                    checkpointed = true;
                    throw new Error(`${STAGE_STOP}: ${migrationId}`);
                  }
                  return result;
                };
              }
              const value = Reflect.get(inner, key, inner);
              return typeof value === 'function' ? value.bind(inner) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  try {
    applyWorkflowSqliteMigrations(staged);
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    if (!checkpointed || !(cause instanceof Error) || !cause.message.startsWith(STAGE_STOP)) throw error;
  }
  if (!checkpointed) throw new Error(`SQLite migration did not reach ${migrationId}`);
}

function pathValue(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, segment) => {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    return Reflect.get(current, segment);
  }, value);
}

function sqlValue(value: unknown, type: string): string | number | null {
  if (value === undefined || value === null) return null;
  if (type === 'boolean') return value === true ? 1 : value === false ? 0 : null;
  if (type === 'json') return JSON.stringify(value);
  return typeof value === 'string' || typeof value === 'number' ? value : null;
}

/** Insert only fields owned by the frozen SQLite descriptor, through its real guards. */
function insertProjectedBody<T extends { id: string }>(
  db: Database.Database,
  definition: MigrationDefinition,
  body: T,
): void {
  const record = body as Record<string, unknown>;
  const physical = db.prepare(`PRAGMA table_xinfo("${definition.table}")`).all() as Array<{
    name: string; hidden: number;
  }>;
  const values = new Map<string, string | number | null>([
    ['id', String(record.id)],
    [definition.bodyColumn, JSON.stringify(record)],
    ['row_version', Number(record.rowVersion ?? 1)],
  ]);
  if (definition.markerColumn) values.set(definition.markerColumn, 2);

  for (const column of definition.columns) {
    if (column.external || column.legacyOnly) continue;
    const relation = definition.foreignKeys.find((foreignKey) => foreignKey.column === column.column);
    const tagField = relation?.tagField;
    const tagValue = relation?.tagValue ?? relation?.target;
    const field = relation?.bodyField ?? column.bodyField;
    const value = tagField && pathValue(record, tagField) !== tagValue ? null : pathValue(record, field);
    values.set(column.column, sqlValue(value, column.type));
  }
  for (const relation of definition.foreignKeys) {
    if (values.has(relation.column)) continue;
    const tagValue = relation.tagValue ?? relation.target;
    const field = relation.bodyField ?? relation.column.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
    const value = relation.tagField && pathValue(record, relation.tagField) !== tagValue
      ? null : pathValue(record, field);
    values.set(relation.column, sqlValue(value, 'text'));
  }

  const columns = physical.filter((column) => column.hidden === 0 && values.has(column.name)).map((column) => column.name);
  const quoted = columns.map((column) => `"${column}"`).join(', ');
  const placeholders = columns.map(() => '?').join(', ');
  db.prepare(`INSERT INTO "${definition.table}" (${quoted}) VALUES (${placeholders})`)
    .run(...columns.map((column) => values.get(column)!));
}

async function create040001PopulatedFixture() {
  const fixture = await createWorkflowSqliteFixture({ initialize: false });
  const db = fixture.openDatabase();
  try {
    for (const table of tables) {
      db.exec(`CREATE TABLE "${table}" (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL)`);
    }
    db.exec('CREATE TABLE appmeta (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), revision INTEGER NOT NULL)');
    db.prepare('INSERT INTO appmeta (singleton, revision) VALUES (1, 41)').run();
    materializeStage(db, WORKFLOW_CONVERSATION_PERSISTENCE_MIGRATION);

    const byTable = new Map(historicalWorkflowCompletenessDefinitions.map((definition) => [definition.table, definition]));
    const profileId = 'snapshot-migration-profile';
    const sessionId = 'snapshot-migration-session';
    const branchId = 'snapshot-migration-branch';
    const snapshotId = 'snapshot-migration-snapshot';
    const targetId = 'snapshot-migration-target';
    const pin = getDemoWorkflowPolicyV1Pin();
    const policyId = 'snapshot-migration-policy-row';
    const policy = {
      id: policyId, version: pin.version, digest: pin.digest, policy: demoWorkflowPolicyV1,
    };
    const profile: Profile = {
      id: profileId, name: 'Synthetic migration actor', role: 'hr_admin', active: true,
      permissions: [], regions: [],
    };
    const session = {
      id: sessionId, profileId, mode: 'scripted_demo', modeRevision: 1,
      csrfToken: 'snapshot-migration-csrf', expiresAt: '2099-01-01T00:00:00.000Z', createdAt: NOW,
    };
    const branch = { id: branchId, name: 'Synthetic migration branch', region: 'east' };
    const snapshotBody: ReviewSnapshot = {
      id: snapshotId, actorId: profileId, actorSessionId: sessionId,
      purpose: 'manager_queue', orgUnitIds: [], displayedIds: [branchId], count: 1,
      expectedRows: [{ ref: { table: 'branches', id: branchId }, rowVersion: 1, state: null }],
      policy: pin, createdAt: NOW, expiresAt: '2099-01-01T00:00:00.000Z', digest: '0'.repeat(64),
    };
    const snapshot = { ...snapshotBody, digest: workflowSnapshotDigest(snapshotBody) };
    const target = {
      id: targetId, snapshotId, entityType: 'branches', targetId: branchId,
      ref: { table: 'branches', id: branchId }, expectedRowVersion: 1, expectedState: null,
    };

    for (const [table, body] of [
      ['profiles', profile], ['sessions', session], ['branches', branch],
      ['workflow_policies', policy], ['review_snapshots', snapshot], ['review_snapshot_targets', target],
    ] as const) {
      const definition = byTable.get(table);
      if (!definition) throw new Error(`Missing frozen migration descriptor for ${table}`);
      insertProjectedBody(db, definition, body);
    }
    return { fixture, db, snapshotId, targetId, body: target };
  } catch (error) {
    db.close();
    await fixture.dispose();
    throw error;
  }
}

interface ActorFixture {
  profileId: string;
  sessionId: string;
  identityId: string;
  responsibilityId: string;
  conversationId: string;
}

interface HrHarness {
  fixture: Awaited<ReturnType<typeof createWorkflowSqliteFixture>>;
  runtime: ReturnType<typeof createWorkflowActionRuntime>;
  runner: ReturnType<typeof createWorkflowActionRunner>;
  queries: ReturnType<typeof createOnboardingQueryService>;
  actors: { manager: ActorFixture; director: ActorFixture };
  branchId: string;
  requestId: string;
  dispose(): Promise<void>;
}

async function createHrHarness(): Promise<HrHarness> {
  const fixture = await createWorkflowSqliteFixture();
  const suffix = 'snapshot-proof-references';
  const makeId = (prefix: string) => `${prefix}-${suffix}`;
  let runtimeIdSequence = 0;
  const makeRuntimeId = (prefix: string) => makeId(`${prefix}-${++runtimeIdSequence}`);
  const orgUnitId = makeId('snapshot-hr-unit');
  const branchId = makeId('snapshot-hr-branch');
  const actors = {
    manager: {
      profileId: makeId('snapshot-manager-profile'), sessionId: makeId('snapshot-manager-session'),
      identityId: makeId('snapshot-manager-identity'), responsibilityId: makeId('snapshot-manager-responsibility'),
      conversationId: makeId('snapshot-manager-conversation'),
    },
    director: {
      profileId: makeId('snapshot-director-profile'), sessionId: makeId('snapshot-director-session'),
      identityId: makeId('snapshot-director-identity'), responsibilityId: makeId('snapshot-director-responsibility'),
      conversationId: makeId('snapshot-director-conversation'),
    },
  };
  const definitions = [
    { key: 'manager' as const, role: 'east_manager', permissions: ['hr.onboarding.manager_read', 'hr.onboarding.manager_approve'], purpose: 'manager_onboarding', name: 'Synthetic East Manager' },
    { key: 'director' as const, role: 'hr_director', permissions: ['hr.onboarding.director_read', 'hr.onboarding.director_approve', 'hr.onboarding.return'], purpose: 'director_onboarding', name: 'Synthetic HR Director' },
  ];

  try {
    await fixture.store.transaction(async (tx) => {
      await tx.put('branches', { id: branchId, name: 'Synthetic East Branch', region: 'east' });
      for (const definition of definitions) {
        const actor = actors[definition.key];
        const profile: Profile = {
          id: actor.profileId, name: definition.name, role: 'hr_admin', active: true,
          permissions: definition.permissions, regions: ['east'],
        };
        await tx.put('profiles', profile);
        await tx.put('sessions', {
          id: actor.sessionId, profileId: actor.profileId, mode: 'scripted_demo', modeRevision: 1,
          csrfToken: makeId(`${definition.key}-csrf`), expiresAt: '2099-01-01T00:00:00.000Z',
        });
      }
    });

    const pin = getDemoWorkflowPolicyV1Pin();
    const policyRowId = makeId('snapshot-policy-row');
    await fixture.store.workflowTransaction(async (tx) => {
      await tx.insertUnique('org_units', {
        id: orgUnitId, name: 'Synthetic onboarding org unit', parentOrgUnitId: null, active: true,
      }, { constraint: 'org_units_primary_key', values: { id: orgUnitId } });
      for (const definition of definitions) {
        const actor = actors[definition.key];
        await tx.insertUnique('directory_identities', {
          id: actor.identityId, profileId: actor.profileId, displayName: definition.name,
          active: true, role: definition.role, department: 'hr', orgUnitId, managerIdentityId: null,
          verifiedDemoEmail: `${definition.key}-${suffix}@example.invalid`, slackIdentity: null,
          allowedChannels: ['simulated_email'], classificationCeiling: 'internal', rowVersion: 1,
        }, { constraint: 'directory_identities_primary_key', values: { id: actor.identityId } });
        await tx.insertUnique('responsibilities', {
          id: actor.responsibilityId, identityId: actor.identityId, orgUnitId,
          purpose: definition.purpose, branchIds: [branchId], active: true, rowVersion: 1,
        }, {
          constraint: 'responsibilities_open_identity_purpose_unique',
          values: { identityId: actor.identityId, purpose: definition.purpose, orgUnitId },
        });
        await tx.insertUnique('conversations', {
          id: actor.conversationId, actorId: actor.profileId, title: `${definition.name} snapshot test`,
          pinned: false, archivedAt: null, rowVersion: 1, createdAt: NOW, updatedAt: NOW,
          lastScope: null, lastDashboardId: null,
        }, { constraint: 'conversations_primary_key', values: { id: actor.conversationId } });
      }
      await tx.insertUnique('workflow_policies', {
        id: policyRowId, version: pin.version, digest: pin.digest, policy: demoWorkflowPolicyV1,
      }, { constraint: 'workflow_policies_primary_key', values: { id: policyRowId } });
    });

    const runtime = createWorkflowActionRuntime({
      store: fixture.store,
      bindings: createHrApprovalWorkflowBindings(),
      businessDate: BUSINESS_DATE,
      getReleaseRevision: () => 'workflow-snapshot-proof-test-r1',
      getPackPins: (packIds) => packIds.map((id) => ({
        id, version: '1.0', schemaDigest: 'a'.repeat(64), implementationRevision: 'workflow-snapshot-proof-test-r1',
      })),
      contextFactory: () => ({
        evidence: async () => ({
          scope: { region: 'east', date: BUSINESS_DATE, branchIds: [branchId] },
          asOf: NOW, version: 'workflow-snapshot-proof-test-evidence-v1', branches: [],
          totals: { netSales: 0, target: 0, gap: 0, achievement: null }, sources: [], warnings: [],
        }),
        latestDashboard: async () => undefined,
      }),
      now: () => new Date(NOW),
      makeId: makeRuntimeId,
    });
    const runner = createWorkflowActionRunner(runtime);
    const queries = createOnboardingQueryService(runtime);

    const requestId = makeId('snapshot-hr-request');
    const employeeId = makeId('snapshot-hr-employee');
    await fixture.store.transaction((tx) => tx.put('employees', {
      id: employeeId, name: 'Synthetic onboarding employee', branchId, active: true,
    }));
    const request: OnboardingRequest = {
      id: requestId, employeeId, orgUnitId, managerIdentityId: actors.manager.identityId,
      directorIdentityId: actors.director.identityId, startDate: '2026-10-15',
      state: 'manager_review_pending', rowVersion: 1, lifecycleId: makeId('snapshot-hr-lifecycle'),
      managerApprovalEventId: null, managerApprovedBy: null, managerApprovedAt: null,
      directorApprovalEventId: null, directorApprovedBy: null, directorApprovedAt: null,
      createdAt: NOW, updatedAt: NOW,
    };
    await fixture.store.workflowTransaction(async (tx) => {
      await tx.insertUnique('onboarding_requests', request, {
        constraint: 'onboarding_requests_primary_key', values: { id: requestId },
      });
      for (const documentType of demoWorkflowPolicyV1.requiredOnboardingDocuments) {
        await tx.insertUnique('onboarding_documents', {
          id: makeId(`snapshot-hr-document-${documentType}`), rowVersion: 1, requestId, employeeId,
          documentType, status: 'accepted', policyVersion: demoWorkflowPolicyV1.policyAcknowledgementVersion,
          classification: demoWorkflowPolicyV1.classification,
          contentDigest: digest({ purpose: 'snapshot-proof-document', requestId, documentType }),
          createdAt: NOW, withdrawnAt: null,
        }, { constraint: 'onboarding_documents_request_type_unique', values: { requestId, documentType } });
      }
    });

    return {
      fixture, runtime, runner, queries, actors, branchId, requestId,
      async dispose() { await fixture.dispose(); },
    };
  } catch (error) {
    await fixture.dispose();
    throw error;
  }
}

async function approveAsManager(harness: HrHarness) {
  const manager = harness.actors.manager;
  const page = await harness.queries.managerQueue(manager.sessionId);
  const prepared = await harness.runtime.prepare(manager.sessionId, {
    kind: 'onboarding_manager_approve', snapshotId: page.snapshot.id, requestIds: [harness.requestId],
  }, { conversationId: manager.conversationId, turnId: `snapshot-manager-turn-${randomUUID()}` });
  if (!prepared.pendingAction) throw new Error('The real HR workflow did not prepare the manager approval');
  const action = prepared.pendingAction;
  const result = await harness.runner.confirm(
    manager.sessionId, action.id, `snapshot-manager-correlation-${randomUUID()}`,
    { conversationId: action.conversationId, turnId: action.turnId },
  );
  expect(result.error).toBeNull();
  expect(result.receipt?.outcome).toBe('verified_success');
  if (!result.receipt) throw new Error('The real manager approval did not return its verified receipt');
  return result.receipt;
}

function targetInsert(target: ReviewSnapshotTargetV2, values: Partial<ReviewSnapshotTargetV2>): ReviewSnapshotTargetV2 {
  return { ...target, ...values };
}

describe('SQLite workflow snapshot proof references', () => {
  itSqliteBound('adds the 040002 projections after 040001 and preserves populated snapshot bodies, versions, revision, and prior ledgers', async () => {
    const history = await create040001PopulatedFixture();
    const { fixture, db, snapshotId, targetId } = history;
    try {
      const targetBefore = rowBytes(db, 'review_snapshot_targets', targetId)!;
      const ledgerBefore = currentLedger(db);
      const revisionBefore = (db.prepare('SELECT revision FROM appmeta WHERE singleton = 1').get() as { revision: number }).revision;
      expect(ledgerBefore.map((entry) => entry.id)).toContain(WORKFLOW_CONVERSATION_PERSISTENCE_MIGRATION);
      expect(ledgerBefore.some((entry) => entry.id === WORKFLOW_SNAPSHOT_PROOF_REFERENCES_MIGRATION)).toBe(false);
      db.close();

      const store = fixture.openStore();
      store.close?.();
      const upgraded = fixture.openDatabase();
      try {
        const afterLedger = currentLedger(upgraded);
        expect(afterLedger.find((entry) => entry.id === WORKFLOW_CONVERSATION_PERSISTENCE_MIGRATION))
          .toEqual({ id: WORKFLOW_CONVERSATION_PERSISTENCE_MIGRATION, digest: WORKFLOW_CONVERSATION_PERSISTENCE_DIGEST });
        expect(createHash('sha256').update(JSON.stringify(workflowSnapshotProofReferenceDefinitions())).digest('hex'))
          .toBe(WORKFLOW_SNAPSHOT_PROOF_REFERENCES_DIGEST);
        expect(afterLedger.find((entry) => entry.id === WORKFLOW_SNAPSHOT_PROOF_REFERENCES_MIGRATION)).toEqual({
          id: WORKFLOW_SNAPSHOT_PROOF_REFERENCES_MIGRATION,
          digest: WORKFLOW_SNAPSHOT_PROOF_REFERENCES_DIGEST,
        });
        expect(ledgerBefore).toEqual([
          { id: WORKFLOW_BASE_MIGRATION, digest: WORKFLOW_BASE_DIGEST },
          { id: WORKFLOW_SCOPE_MIGRATION, digest: WORKFLOW_SCOPE_DIGEST },
          { id: WORKFLOW_COMPLETENESS_MIGRATION, digest: WORKFLOW_COMPLETENESS_DIGEST },
          { id: WORKFLOW_CONVERSATION_PERSISTENCE_MIGRATION, digest: WORKFLOW_CONVERSATION_PERSISTENCE_DIGEST },
        ]);
        expect(afterLedger.slice(0, ledgerBefore.length)).toEqual(ledgerBefore);
        expect(rowBytes(upgraded, 'review_snapshot_targets', targetId)).toEqual(targetBefore);
        expect((upgraded.prepare('SELECT revision FROM appmeta WHERE singleton = 1').get() as { revision: number }).revision)
          .toBe(revisionBefore);
        expect(upgraded.prepare(`SELECT directory_identity_id, responsibility_id, action_execution_id
          FROM review_snapshot_targets WHERE id = ?`).get(targetId))
          .toEqual({ directory_identity_id: null, responsibility_id: null, action_execution_id: null });

        const beforeReapplySchema = schemaSnapshot(upgraded);
        const beforeReapplyLedger = currentLedger(upgraded);
        applyWorkflowSqliteMigrations(upgraded);
        expect(schemaSnapshot(upgraded)).toEqual(beforeReapplySchema);
        expect(currentLedger(upgraded)).toEqual(beforeReapplyLedger);
        expect(rowBytes(upgraded, 'review_snapshot_targets', targetId)).toEqual(targetBefore);
        expect((upgraded.prepare('SELECT revision FROM appmeta WHERE singleton = 1').get() as { revision: number }).revision)
          .toBe(revisionBefore);
        expect(upgraded.pragma('foreign_key_check')).toEqual([]);
        expect((upgraded.prepare('SELECT count(*) AS n FROM review_snapshots WHERE id = ?').get(snapshotId) as { n: number }).n)
          .toBe(1);
      } finally {
        upgraded.close();
      }
    } finally {
      if (db.open) db.close();
      await fixture.dispose();
    }
  });

  itSqliteBound('rejects a same-name replacement snapshot guard on reapply without healing schema or changing persisted state', async () => {
    const history = await create040001PopulatedFixture();
    const { fixture, db, snapshotId, targetId } = history;
    try {
      db.close();
      const store = fixture.openStore();
      store.close?.();

      const upgraded = fixture.openDatabase();
      try {
        upgraded.exec('DROP TRIGGER workflow_review_snapshot_targets_insert_guard');
        upgraded.exec(`CREATE TRIGGER workflow_review_snapshot_targets_insert_guard
          BEFORE INSERT ON review_snapshot_targets BEGIN SELECT 1; END`);

        const beforeSchema = schemaSnapshot(upgraded);
        const beforeTarget = rowBytes(upgraded, 'review_snapshot_targets', targetId)!;
        const beforeLedger = currentLedger(upgraded);
        const beforeRevision = (upgraded.prepare('SELECT revision FROM appmeta WHERE singleton = 1').get() as { revision: number }).revision;

        expect(() => applyWorkflowSqliteMigrations(upgraded)).toThrow(/Workflow migration/);

        expect(schemaSnapshot(upgraded)).toEqual(beforeSchema);
        expect(rowBytes(upgraded, 'review_snapshot_targets', targetId)).toEqual(beforeTarget);
        expect(currentLedger(upgraded)).toEqual(beforeLedger);
        expect((upgraded.prepare('SELECT revision FROM appmeta WHERE singleton = 1').get() as { revision: number }).revision)
          .toBe(beforeRevision);
        expect((upgraded.prepare('SELECT count(*) AS n FROM review_snapshots WHERE id = ?').get(snapshotId) as { n: number }).n)
          .toBe(1);
        expect(upgraded.pragma('foreign_key_check')).toEqual([]);
      } finally {
        upgraded.close();
      }
    } finally {
      if (db.open) db.close();
      await fixture.dispose();
    }
  });

  itSqliteBound('persists native Director snapshot identity, responsibility, and V2 execution proofs and rejects mismatched, orphaned, or changed references', async () => {
    const harness = await createHrHarness();
    try {
      const director = harness.actors.director;
      expect((await harness.queries.directorQueue(director.sessionId)).items).toEqual([]);
      const receipt = await approveAsManager(harness);
      const page = await harness.queries.directorQueue(director.sessionId);
      expect(page.items.map((item) => item.request.id)).toEqual([harness.requestId]);
      for (const table of ['directory_identities', 'responsibilities', 'action_executions']) {
        expect(page.snapshot.expectedRows).toContainEqual(expect.objectContaining({ ref: expect.objectContaining({ table }) }));
        expect(page.snapshotTargets).toContainEqual(expect.objectContaining({ entityType: table }));
      }

      const readback = harness.fixture.openDatabase();
      try {
        const rows = readback.prepare(`SELECT *
          FROM review_snapshot_targets WHERE snapshot_id = ?`).all(page.snapshot.id) as Array<{
          [column: string]: unknown;
          id: string; entity_type: string; target_id: string; body: string;
          directory_identity_id: string | null; responsibility_id: string | null; action_execution_id: string | null;
          action_execution_contract_version: number | null;
        }>;
        const taggedColumns = getWorkflowProjection('review_snapshot_targets').foreignKeys
          .filter((foreignKey) => foreignKey.tagField).map((foreignKey) => foreignKey.column);
        for (const [table, nativeColumn] of [
          ['directory_identities', 'directory_identity_id'],
          ['responsibilities', 'responsibility_id'],
          ['action_executions', 'action_execution_id'],
        ] as const) {
          const target = rows.find((row) => JSON.parse(row.body).ref.table === table);
          expect(target).toBeDefined();
          expect(REQUIRED_REFERENCE_COLUMNS.map((column) => target![column]).filter(Boolean))
            .toHaveLength(1);
          expect(taggedColumns.filter((column) => target![column] !== null)).toHaveLength(1);
          expect(target![nativeColumn]).toBe(JSON.parse(target!.body).ref.id);
          expect(target!.entity_type).toBe(table);
        }
        const executionTarget = rows.find((row) => JSON.parse(row.body).ref.table === 'action_executions')!;
        expect(executionTarget.action_execution_id).toBe(receipt.id);
        expect(executionTarget.action_execution_contract_version).toBe(2);
        const provenance = readback.prepare(`SELECT workflow_contract_version FROM action_executions WHERE id = ?`)
          .get(receipt.id) as { workflow_contract_version: number };
        expect(provenance.workflow_contract_version).toBe(2);

        const foreignKeys = readback.pragma('foreign_key_list(review_snapshot_targets)') as Array<{
          id: number; table: string; from: string; to: string;
        }>;
        for (const [from, toTable] of [
          ['directory_identity_id', 'directory_identities'],
          ['responsibility_id', 'responsibilities'],
          ['action_execution_id', 'action_executions'],
        ]) {
          expect(foreignKeys).toContainEqual(expect.objectContaining({ from, table: toTable, to: 'id' }));
        }
        const compositeIds = new Set(foreignKeys
          .filter((key) => key.from === 'action_execution_contract_version' && key.table === 'action_executions')
          .map((key) => key.id));
        const actionForeignKey = foreignKeys.find((key) => key.from === 'action_execution_id' &&
          key.table === 'action_executions' && compositeIds.has(key.id))!;
        expect(foreignKeys.filter((key) => key.id === actionForeignKey.id).map((key) => [key.from, key.to]))
          .toEqual(expect.arrayContaining([
            ['action_execution_id', 'id'],
            ['action_execution_contract_version', 'workflow_contract_version'],
          ]));
      } finally {
        readback.close();
      }

      const identityTarget = page.snapshotTargets.find((target) => target.entityType === 'directory_identities')!;
      const mismatched = targetInsert(identityTarget, {
        id: `snapshot-tag-mismatch-${randomUUID()}`,
        entityType: 'directory_identities',
        targetId: director.identityId,
        ref: { table: 'responsibilities', id: director.responsibilityId },
      });
      await expect(harness.fixture.store.workflowTransaction((tx) => tx.insertUnique(
        'review_snapshot_targets', mismatched,
        { constraint: 'review_snapshot_targets_snapshot_target_unique', values: {
          snapshotId: mismatched.snapshotId, entityType: mismatched.entityType, targetId: mismatched.targetId,
        } },
      ))).rejects.toThrow();

      const orphanId = `snapshot-proof-orphan-${randomUUID()}`;
      const orphan = targetInsert(identityTarget, {
        id: `snapshot-orphan-target-${randomUUID()}`,
        targetId: orphanId,
        ref: { table: 'directory_identities', id: orphanId },
      });
      await expect(harness.fixture.store.workflowTransaction((tx) => tx.insertUnique(
        'review_snapshot_targets', orphan,
        { constraint: 'review_snapshot_targets_snapshot_target_unique', values: {
          snapshotId: orphan.snapshotId, entityType: orphan.entityType, targetId: orphan.targetId,
        } },
      ))).rejects.toThrow();

      const persistedIdentityTarget = await harness.fixture.store.workflowProjectionReader.get<ReviewSnapshotTargetV2>(
        'review_snapshot_targets', identityTarget.id,
      );
      if (!persistedIdentityTarget) throw new Error('Expected Director snapshot identity target to be persisted');
      const altered = { ...identityTarget, rowVersion: persistedIdentityTarget.rowVersion + 1,
        ref: { table: 'directory_identities' as const, id: director.identityId } };
      await expect(harness.fixture.store.workflowTransaction((tx) => tx.compareAndSwap(
        'review_snapshot_targets', identityTarget.id,
        { rowVersion: persistedIdentityTarget.rowVersion, state: null }, altered,
      ))).rejects.toThrow();
      expect(await harness.fixture.store.workflowProjectionReader.get<ReviewSnapshotTargetV2>(
        'review_snapshot_targets', identityTarget.id,
      )).toMatchObject({ body: identityTarget });
    } finally {
      await harness.dispose();
    }
  });

  itSqliteBound('excludes missing, legacy, and changed Manager execution proof from the Director queue', async () => {
    for (const corruption of ['missing', 'legacy', 'changed-proof'] as const) {
      const harness = await createHrHarness();
      try {
        const receipt = await approveAsManager(harness);
        const db = harness.fixture.openDatabase();
        try {
          db.pragma('foreign_keys = OFF');
          if (corruption === 'missing') {
            db.exec('DROP TRIGGER IF EXISTS workflow_action_executions_delete_guard');
            db.prepare('DELETE FROM action_executions WHERE id = ?').run(receipt.id);
          } else if (corruption === 'legacy') {
            db.exec('DROP TRIGGER IF EXISTS workflow_action_executions_update_guard');
            db.prepare(`UPDATE action_executions SET workflow_contract_version = NULL,
              payload = ? WHERE id = ?`).run(JSON.stringify({
                id: receipt.id, actionId: receipt.actionId, actorId: receipt.actorId,
                kind: receipt.kind, status: 'verified_success', results: [],
                createdAt: receipt.createdAt, verifiedAt: receipt.verifiedAt,
              }), receipt.id);
          } else {
            db.exec('DROP TRIGGER IF EXISTS workflow_action_executions_update_guard');
            const firstProof = receipt.proofs[0];
            if (!firstProof) throw new Error('The verified Manager receipt has no target proof');
            const changed = {
              ...receipt,
              proofs: [{ ...firstProof, ref: { ...firstProof.ref, id: `different-proof-${randomUUID()}` } }, ...receipt.proofs.slice(1)],
            };
            db.prepare('UPDATE action_executions SET payload = ? WHERE id = ?')
              .run(JSON.stringify(changed), receipt.id);
          }
        } finally {
          db.close();
        }

        expect((await harness.queries.directorQueue(harness.actors.director.sessionId)).items, corruption)
          .toEqual([]);
      } finally {
        await harness.dispose();
      }
    }
  });
});
