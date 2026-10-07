import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { digest } from '../lib/core/utils';
import { tables } from '../lib/contracts';
import {
  defaultDemoWorkflowPolicy,
  pendingActionV2Schema,
  versionedDemoWorkflowPolicySchema,
  workflowReceiptV2Schema,
  type PendingActionV2,
  type WorkflowPayloadV2,
  type WorkflowReceiptV2,
  type WorkflowStore,
  type WorkflowStorageTable,
} from '../lib/workflows/contracts';
import { validateWorkflowProjectionBody, type WorkflowStorageQuery } from '../lib/storage/workflow-projections';
import {
  applyWorkflowSqliteMigrations,
  workflowMigrationDefinitions,
  WORKFLOW_COMPLETENESS_MIGRATION,
  WORKFLOW_ACTION_TARGET_PROVENANCE_MIGRATION,
  WORKFLOW_PENDING_ACTION_REVISION_MIGRATION,
  WORKFLOW_PENDING_ACTION_V2_BODY_GUARD_MIGRATION,
  WORKFLOW_PENDING_ACTION_DELETE_FENCE_MIGRATION,
  WORKFLOW_PENDING_ACTION_INSERT_IDENTITY_FENCE_MIGRATION,
  WORKFLOW_PENDING_ACTION_FRESH_V1_INSERT_MIGRATION,
  WORKFLOW_PENDING_ACTION_FRESH_V1_STATUS_PROJECTION_MIGRATION,
} from '../lib/storage/workflow-sqlite-migrations';
import {
  WORKFLOW_BASE_DIGEST,
  WORKFLOW_BASE_MIGRATION,
  historicalWorkflowBaseDefinitions,
  WORKFLOW_SCOPE_DIGEST,
  WORKFLOW_SCOPE_MIGRATION,
  historicalWorkflowScopeDefinitions,
  WORKFLOW_CONVERSATION_PERSISTENCE_DIGEST,
  WORKFLOW_CONVERSATION_PERSISTENCE_MIGRATION,
  WORKFLOW_SNAPSHOT_PROOF_REFERENCES_DIGEST,
  WORKFLOW_SNAPSHOT_PROOF_REFERENCES_MIGRATION,
  historicalWorkflowCompletenessDefinitions,
} from '../lib/storage/workflow-schema-history';
import { createWorkflowSqliteFixture } from './helpers/workflow-storage';
import { itSqliteBound } from './helpers/local-pg';

const createdAt = '2026-10-03T05:00:00.000Z';
const PINNED_WORKFLOW_MANIFEST_DIGEST = '08056f5eec686e42982e7cc487267ef7069dca98a3b46f18727557bb7a7721a7';
const PINNED_COMPLETENESS_DIGEST = 'fb51d8adc53817bf29ef0aff23be83c6ccd66079d1d3f68e19da77444e44d6fb';
const PINNED_ACTION_TARGET_PROVENANCE_DIGEST = 'a15366ac17b25edc5a34dfd4aa64e9c48d12191767d3fe89515b4fe3e84ca1ff';
const PINNED_PENDING_ACTION_REVISION_DIGEST = '4ad1e3fc649d63e6c9c73c42645f6df46310c482fac2e6dc6153ef236aeb799a';
const PINNED_PENDING_ACTION_V2_BODY_GUARD_DIGEST = '42ef4db17800ecb84a75b408c64840e2c38152c39bec57aece119ddfb3377f10';
const PINNED_PENDING_ACTION_DELETE_FENCE_DIGEST = 'cc6391cb66d9200c69cd0b17a99417c481953a28e1a9990af812f9f92675b2f8';
const PINNED_PENDING_ACTION_INSERT_IDENTITY_FENCE_DIGEST = '2a7012790bc12f06a2244551848214a379e8063303775142b69c8ecf772b2b8e';
const PINNED_PENDING_ACTION_FRESH_V1_INSERT_DIGEST = '0290bacc31512b60c429a75a63d7edac370ba1d5ae13c020dd907fd07a130ef4';
const PINNED_PENDING_ACTION_FRESH_V1_STATUS_PROJECTION_DIGEST = '107f5118887c49d9a5397fae68db14a33a5520aac1fb7d47d83d07137a93f1cc';

type WorkflowFixture = Awaited<ReturnType<typeof createWorkflowSqliteFixture>>;

type HrContext = {
  branchId: string;
  managerProfileId: string;
  directorProfileId: string;
  employeeId: string;
  orgUnitId: string;
  managerIdentityId: string;
  directorIdentityId: string;
  sessionId: string;
  conversationId: string;
  request: {
    id: string;
    employeeId: string;
    orgUnitId: string;
    managerIdentityId: string;
    directorIdentityId: string;
    startDate: string;
    state: string;
    rowVersion: number;
    lifecycleId: string;
    managerApprovalEventId: null;
    managerApprovedBy: null;
    managerApprovedAt: null;
    directorApprovalEventId: null;
    directorApprovedBy: null;
    directorApprovedAt: null;
    createdAt: string;
    updatedAt: string;
  };
};

async function insertUnique<T extends { id: string }>(
  store: WorkflowStore,
  table: WorkflowStorageTable,
  row: T,
  constraint = `${String(table)}_primary_key`,
  values: Record<string, string | number> = { id: row.id },
) {
  return store.workflowTransaction((tx) => tx.insertUnique(table, row, { constraint, values }));
}

async function seedHrContext(store: WorkflowStore, suffix: string): Promise<HrContext> {
  const branchId = `projection-completeness-branch-${suffix}`;
  const managerProfileId = `projection-completeness-manager-profile-${suffix}`;
  const directorProfileId = `projection-completeness-director-profile-${suffix}`;
  const employeeId = `projection-completeness-employee-${suffix}`;
  const orgUnitId = `projection-completeness-org-${suffix}`;
  const managerIdentityId = `projection-completeness-manager-${suffix}`;
  const directorIdentityId = `projection-completeness-director-${suffix}`;
  const sessionId = `projection-completeness-session-${suffix}`;
  const conversationId = `projection-completeness-conversation-${suffix}`;
  const requestId = `projection-completeness-request-${suffix}`;

  await store.transaction(async (tx) => {
    await tx.put('branches', { id: branchId, name: 'Synthetic HR branch', region: 'east' });
    await tx.put('profiles', {
      id: managerProfileId, name: 'Synthetic HR Manager', role: 'hr_admin', active: true,
      permissions: [], regions: []
    });
    await tx.put('profiles', {
      id: directorProfileId, name: 'Synthetic HR Director', role: 'executive', active: true,
      permissions: [], regions: []
    });
    await tx.put('employees', { id: employeeId, name: 'Synthetic Employee', branchId, active: true });
    await tx.put('sessions', {
      id: sessionId, profileId: managerProfileId, mode: 'scripted_demo', modeRevision: 0,
      csrfToken: `synthetic-csrf-${suffix}`, expiresAt: '2099-01-01T00:00:00.000Z'
    });
    await tx.put('conversations', {
      id: conversationId, actorId: managerProfileId, createdAt
    });
  });

  await store.workflowTransaction(async (tx) => {
    await tx.insertUnique('org_units', {
      id: orgUnitId, name: `Synthetic HR ${suffix}`, parentOrgUnitId: null, active: true
    }, { constraint: 'org_units_primary_key', values: { id: orgUnitId } });
    await tx.insertUnique('directory_identities', {
      id: managerIdentityId, profileId: managerProfileId, displayName: 'Synthetic HR Manager',
      active: true, role: 'hr_admin', department: 'hr', orgUnitId, managerIdentityId: null,
      verifiedDemoEmail: `projection-manager-${suffix}@example.invalid`, slackIdentity: null,
      allowedChannels: ['simulated_email'], classificationCeiling: 'internal', rowVersion: 1
    }, { constraint: 'directory_identities_primary_key', values: { id: managerIdentityId } });
    await tx.insertUnique('directory_identities', {
      id: directorIdentityId, profileId: directorProfileId, displayName: 'Synthetic HR Director',
      active: true, role: 'hr_director', department: 'hr', orgUnitId, managerIdentityId: null,
      verifiedDemoEmail: `projection-director-${suffix}@example.invalid`, slackIdentity: null,
      allowedChannels: ['simulated_email'], classificationCeiling: 'internal', rowVersion: 1
    }, { constraint: 'directory_identities_primary_key', values: { id: directorIdentityId } });
  });

  const request = {
    id: requestId,
    employeeId,
    orgUnitId,
    managerIdentityId,
    directorIdentityId,
    startDate: '2026-10-15',
    state: 'draft',
    rowVersion: 1,
    lifecycleId: `projection-completeness-lifecycle-${suffix}`,
    managerApprovalEventId: null,
    managerApprovedBy: null,
    managerApprovedAt: null,
    directorApprovalEventId: null,
    directorApprovedBy: null,
    directorApprovedAt: null,
    createdAt,
    updatedAt: createdAt
  } as const;
  await insertUnique(store, 'onboarding_requests', request);

  return {
    branchId, managerProfileId, directorProfileId, employeeId, orgUnitId,
    managerIdentityId, directorIdentityId, sessionId, conversationId, request
  };
}

async function createPendingExecution(
  store: WorkflowStore,
  context: HrContext,
  suffix: string,
  payload: WorkflowPayloadV2,
  targets: PendingActionV2['targets'],
  expectedRows: PendingActionV2['expectedRows'],
): Promise<{ action: PendingActionV2; root: { id: string }; receipt: WorkflowReceiptV2 }> {
  const policy = versionedDemoWorkflowPolicySchema.parse(defaultDemoWorkflowPolicy);
  const policyRow = { id: 'demo-workflow', version: 1, digest: digest(policy), policy };
  const action = pendingActionV2Schema.parse({
    id: `projection-completeness-action-${suffix}`,
    contractVersion: 2,
    actorId: context.managerProfileId,
    sessionId: context.sessionId,
    conversationId: context.conversationId,
    turnId: `projection-completeness-turn-${suffix}`,
    mode: 'scripted_demo',
    modeRevision: 0,
    payload,
    payloadHash: digest(payload),
    idempotencyKey: digest({ idempotency: suffix }),
    targets,
    targetCount: targets.length,
    expectedRows,
    approvedBranchIds: [context.branchId],
    approvedOrgUnitIds: [context.orgUnitId],
    reviewedSnapshotId: null,
    policy: { id: 'demo-workflow', version: 1, digest: digest(defaultDemoWorkflowPolicy) },
    packs: [{
      id: 'workflow-hr', version: '1.0', schemaDigest: 'c'.repeat(64),
      implementationRevision: 'projection-completeness-test'
    }],
    releaseRevision: 'projection-completeness-test-r1',
    executionMode: 'atomic_local',
    createdAt,
    expiresAt: '2026-10-03T05:10:00.000Z',
    status: 'pending'
  });
  const executionId = `projection-completeness-execution-${suffix}`;
  const root = {
    id: `projection-completeness-root-${suffix}`,
    actionId: action.id,
    actorId: action.actorId,
    idempotencyKey: action.idempotencyKey,
    activeExecutionId: executionId,
    rowVersion: 1,
    status: 'open',
    createdAt
  };
  const receipt = workflowReceiptV2Schema.parse({
    id: executionId,
    actionId: action.id,
    contractVersion: 2,
    actorId: action.actorId,
    kind: action.payload.kind,
    outcome: 'pending',
    proofs: [],
    createdAt,
    verifiedAt: null,
    currentStates: []
  });

  await insertUnique(store, 'workflow_policies', policyRow);
  await store.workflowTransaction(async (tx) => {
    await tx.insertUnique('pending_actions', action, {
      constraint: 'pending_actions_primary_key', values: { id: action.id }
    });
    await tx.insertUnique('action_idempotency_roots', root, {
      constraint: 'action_idempotency_roots_key_unique',
      values: { idempotencyKey: action.idempotencyKey }
    });
    await tx.insertUnique('action_executions', receipt, {
      constraint: 'action_executions_root_attempt_unique',
      values: { rootId: root.id, attempt: 1 }
    });
  });

  return { action, root, receipt };
}

function openInspectionDatabase(fixture: WorkflowFixture): Database.Database {
  const db = fixture.openDatabase();
  // Register connection-local guard functions for direct SQL assertions on this isolated file.
  applyWorkflowSqliteMigrations(db);
  db.pragma('foreign_keys = ON');
  return db;
}

function readRevision(fixture: WorkflowFixture): number {
  const db = fixture.openDatabase();
  try {
    return (db.prepare('SELECT revision FROM appmeta WHERE singleton = 1').get() as { revision: number }).revision;
  } finally {
    db.close();
  }
}

function seedLegacyV1Sqlite(db: Database.Database) {
  for (const table of tables) {
    db.exec(`CREATE TABLE "${table}" (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL)`);
  }
  db.exec('CREATE TABLE appmeta (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), revision INTEGER NOT NULL)');
  db.prepare('INSERT INTO appmeta (singleton, revision) VALUES (1, 17)').run();

  const profile = {
    id: 'projection-completeness-legacy-profile', name: 'Synthetic legacy profile', role: 'hr_admin',
    active: true, permissions: [], regions: []
  };
  const branch = {
    id: 'projection-completeness-legacy-branch', name: 'Synthetic legacy branch', region: 'east'
  };
  const employee = {
    id: 'projection-completeness-legacy-employee', name: 'Synthetic legacy employee',
    branchId: branch.id, active: true
  };
  const session = {
    id: 'projection-completeness-legacy-session', profileId: profile.id, mode: 'scripted_demo',
    modeRevision: 0, csrfToken: 'synthetic-legacy-csrf', expiresAt: '2099-01-01T00:00:00.000Z'
  };
  const conversation = {
    id: 'projection-completeness-legacy-conversation', actorId: profile.id, createdAt
  };
  const pendingAction = {
    id: 'projection-completeness-legacy-action', actorId: profile.id, sessionId: session.id,
    conversationId: conversation.id, turnId: 'projection-completeness-legacy-turn', mode: 'scripted_demo',
    modeRevision: 0, payload: { scenario: 'legacy-fixture' }, payloadHash: 'legacy-payload-hash',
    packs: [], createdAt, expiresAt: '2099-01-01T00:00:00.000Z', status: 'completed', preview: 'Synthetic legacy preview'
  };
  const receipt = {
    id: 'projection-completeness-legacy-receipt', actionId: pendingAction.id, actorId: profile.id,
    kind: 'demo_update', status: 'pending', results: [], createdAt, verifiedAt: null
  };
  const ticket = {
    id: 'projection-completeness-legacy-profile-ticket', branchId: branch.id, assigneeId: profile.id,
    title: 'Synthetic legacy ticket', reason: 'Legacy V1 ticket body remains readable.',
    unansweredQuestion: 'Which profile owns this historic row?', sourceIds: ['projection-completeness-legacy-source'],
    status: 'open', operationKey: 'projection-completeness-legacy-operation', createdAt
  };
  const rows = [
    ['profiles', profile], ['branches', branch], ['employees', employee], ['sessions', session],
    ['conversations', conversation], ['pending_actions', pendingAction], ['action_executions', receipt],
    ['mock_tickets', ticket]
  ] as const;
  const payloads = new Map<string, string>();
  for (const [table, row] of rows) {
    const payload = JSON.stringify(row);
    payloads.set(row.id, payload);
    db.prepare(`INSERT INTO "${table}" (id, payload) VALUES (?, ?)`).run(row.id, payload);
  }
  return { profile, branch, employee, session, conversation, pendingAction, receipt, ticket, payloads };
}

function workflowSchemaSnapshot(db: Database.Database): Array<{ type: string; name: string; tbl_name: string; sql: string }> {
  return db.prepare(`
    SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE sql IS NOT NULL AND type IN ('table', 'index', 'trigger') ORDER BY type, name
  `).all() as Array<{ type: string; name: string; tbl_name: string; sql: string }>;
}

function workflowRowsSnapshot(db: Database.Database): string {
  const rows = workflowMigrationDefinitions().map((definition) => {
    const columns = [
      'id', definition.bodyColumn, 'row_version',
      ...(definition.markerColumn ? [definition.markerColumn] : []),
      ...(definition.legacyQuarantineColumn ? [definition.legacyQuarantineColumn] : [])
    ].map((column) => `"${column}"`).join(', ');
    const table = `"${definition.table}"`;
    return [definition.table, db.prepare(`SELECT ${columns} FROM ${table} ORDER BY id`).all()];
  });
  return JSON.stringify(rows);
}

function historicalWorkflowRowsSnapshot(
  db: Database.Database,
  definitions: typeof historicalWorkflowBaseDefinitions
): string {
  return JSON.stringify(definitions.map((definition) => {
    const columns = [
      'id', definition.bodyColumn, 'row_version',
      ...(definition.storage === 'mixed' ? ['workflow_contract_version'] : [])
    ].map((column) => `"${column}"`).join(', ');
    return [definition.table, db.prepare(`SELECT ${columns} FROM "${definition.table}" ORDER BY id`).all()];
  }));
}

function workflowLedger(db: Database.Database): Array<{ id: string; digest: string }> {
  return db.prepare('SELECT id, digest FROM workflow_schema_migrations ORDER BY id')
    .all() as Array<{ id: string; digest: string }>;
}

function expectedWorkflowLedger(): Array<{ id: string; digest: string }> {
  return [
    { id: WORKFLOW_BASE_MIGRATION, digest: WORKFLOW_BASE_DIGEST },
    { id: WORKFLOW_SCOPE_MIGRATION, digest: WORKFLOW_SCOPE_DIGEST },
    { id: WORKFLOW_COMPLETENESS_MIGRATION, digest: PINNED_COMPLETENESS_DIGEST },
    { id: WORKFLOW_CONVERSATION_PERSISTENCE_MIGRATION, digest: WORKFLOW_CONVERSATION_PERSISTENCE_DIGEST },
    { id: WORKFLOW_SNAPSHOT_PROOF_REFERENCES_MIGRATION, digest: WORKFLOW_SNAPSHOT_PROOF_REFERENCES_DIGEST },
    { id: WORKFLOW_ACTION_TARGET_PROVENANCE_MIGRATION, digest: PINNED_ACTION_TARGET_PROVENANCE_DIGEST },
    { id: WORKFLOW_PENDING_ACTION_REVISION_MIGRATION, digest: PINNED_PENDING_ACTION_REVISION_DIGEST },
    { id: WORKFLOW_PENDING_ACTION_V2_BODY_GUARD_MIGRATION, digest: PINNED_PENDING_ACTION_V2_BODY_GUARD_DIGEST },
    { id: WORKFLOW_PENDING_ACTION_DELETE_FENCE_MIGRATION, digest: PINNED_PENDING_ACTION_DELETE_FENCE_DIGEST },
    { id: WORKFLOW_PENDING_ACTION_INSERT_IDENTITY_FENCE_MIGRATION, digest: PINNED_PENDING_ACTION_INSERT_IDENTITY_FENCE_DIGEST },
    { id: WORKFLOW_PENDING_ACTION_FRESH_V1_INSERT_MIGRATION, digest: PINNED_PENDING_ACTION_FRESH_V1_INSERT_DIGEST },
    { id: WORKFLOW_PENDING_ACTION_FRESH_V1_STATUS_PROJECTION_MIGRATION, digest: PINNED_PENDING_ACTION_FRESH_V1_STATUS_PROJECTION_DIGEST }
  ];
}

function indexColumns(db: Database.Database, indexName: string): string[] {
  return (db.prepare(`PRAGMA index_info('${indexName}')`).all() as Array<{ name: string }>).map((row) => row.name);
}

function indexSql(db: Database.Database, indexName: string): string {
  const result = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(indexName) as { sql: string | null } | undefined;
  if (!result?.sql) throw new Error(`Missing SQL for index ${indexName}`);
  return result.sql;
}

const HISTORICAL_STAGE_STOP = 'test-only historical schema checkpoint';

/** Run the production migration only through one pinned historical ledger step. */
function materializeHistoricalWorkflowStage(db: Database.Database, migrationId: string): void {
  const prepare = db.prepare.bind(db);
  let checkpointed = false;
  const stagedDatabase = new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql: string) => {
          const statement = prepare(sql);
          if (sql !== 'INSERT INTO workflow_schema_migrations(id,digest) VALUES(?,?)') return statement;
          return new Proxy(statement, {
            get(inner, statementProperty) {
              if (statementProperty === 'run') {
                return (...parameters: unknown[]) => {
                  const result = inner.run(...parameters);
                  if (parameters[0] === migrationId) {
                    target.exec('COMMIT');
                    checkpointed = true;
                    throw new Error(`${HISTORICAL_STAGE_STOP}: ${migrationId}`);
                  }
                  return result;
                };
              }
              const value = Reflect.get(inner, statementProperty, inner);
              return typeof value === 'function' ? value.bind(inner) : value;
            }
          });
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });

  try {
    applyWorkflowSqliteMigrations(stagedDatabase);
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    if (!checkpointed || !(cause instanceof Error) || !cause.message.startsWith(HISTORICAL_STAGE_STOP)) throw error;
  }
  if (!checkpointed) throw new Error(`Workflow migration did not reach historical checkpoint ${migrationId}`);
}

function insertHistoricalV2Rows(db: Database.Database, legacy: ReturnType<typeof seedLegacyV1Sqlite>, stage: string) {
  const suffix = stage.replaceAll('-', '_');
  const orgUnit = {
    id: `projection-completeness-history-${suffix}-org`, rowVersion: 6,
    parentOrgUnitId: null, name: `Historical fixture ${suffix}`, active: true,
    kind: 'department', createdAt
  };
  const identity = {
    id: `projection-completeness-history-${suffix}-identity`, profileId: legacy.profile.id,
    displayName: `Historical fixture ${suffix}`, active: true, role: 'hr_admin', department: 'hr',
    orgUnitId: orgUnit.id, managerIdentityId: null, verifiedDemoEmail: `${suffix}@example.invalid`,
    slackIdentity: null, allowedChannels: ['simulated_email'], classificationCeiling: 'internal', rowVersion: 7
  };
  const responsibility = {
    id: `projection-completeness-history-${suffix}-responsibility`, identityId: identity.id,
    orgUnitId: orgUnit.id, purpose: 'hr_operations', branchIds: [], active: true, rowVersion: 8
  };
  const team = {
    id: `projection-completeness-history-${suffix}-team`, rowVersion: 9,
    name: `Historical fixture ${suffix} team`, active: true, department: 'operations', createdAt
  };
  const investigationCase = {
    id: `projection-completeness-history-${suffix}-case`, rowVersion: 11,
    branchId: legacy.branch.id, ownerIdentityId: identity.id, status: 'open',
    businessDate: '2026-10-03', dueDate: '2026-10-07',
    reason: 'Synthetic historical investigation case.', priority: 'normal',
    sourceIds: [`projection-completeness-history-${suffix}-source`],
    unansweredQuestion: 'Which historical source applies?',
    lifecycleId: `projection-completeness-history-${suffix}-lifecycle`
  };
  const branchAssignment = {
    id: `projection-completeness-history-${suffix}-branch-assignment`, rowVersion: 12,
    branchId: legacy.branch.id, caseId: investigationCase.id, ownerIdentityId: identity.id,
    status: 'assigned', executionId: `projection-completeness-history-${suffix}-receipt`,
    reason: 'Synthetic historical branch review assignment.', createdAt
  };

  const policy = versionedDemoWorkflowPolicySchema.parse(defaultDemoWorkflowPolicy);
  const policyRecord = { id: 'demo-workflow', version: 1, digest: digest(policy), policy };
  const payload = { kind: 'offboarding_plan_create' as const, caseId: `projection-completeness-history-${suffix}-offboarding-case` };
  const actionId = `projection-completeness-history-${suffix}-action`;
  const rootId = `projection-completeness-history-${suffix}-root`;
  const executionId = `projection-completeness-history-${suffix}-receipt`;
  const idempotencyKey = digest({ historicalMigrationFixture: suffix });
  const action = pendingActionV2Schema.parse({
    id: actionId, contractVersion: 2, actorId: legacy.profile.id, sessionId: legacy.session.id,
    conversationId: legacy.conversation.id, turnId: `projection-completeness-history-${suffix}-turn`,
    mode: 'scripted_demo', modeRevision: 0, payload, payloadHash: digest(payload), idempotencyKey,
    targets: [{
      targetId: `projection-completeness-history-${suffix}-target`,
      ref: { table: 'org_units', id: orgUnit.id }, semanticKey: `history:${suffix}:org-unit`,
      expectedRows: [], ownerIdentityId: null,
      expectedEffectRef: { table: 'workflow_teams', id: team.id }, expectedEffectVersion: 1
    }],
    targetCount: 1, expectedRows: [], approvedBranchIds: [legacy.branch.id],
    approvedOrgUnitIds: [orgUnit.id], reviewedSnapshotId: null,
    policy: { id: policyRecord.id, version: policyRecord.version, digest: policyRecord.digest },
    packs: [{ id: 'workflow-hr', version: '1.0', schemaDigest: 'd'.repeat(64), implementationRevision: 'historical-fixture' }],
    releaseRevision: 'historical-fixture-r1', executionMode: 'atomic_local', createdAt,
    expiresAt: '2026-10-03T06:00:00.000Z', status: 'pending'
  });
  const root = {
    id: rootId, rowVersion: 4, actorId: legacy.profile.id, idempotencyKey,
    status: 'open', activeExecutionId: executionId, actionId, createdAt
  };
  const receipt = workflowReceiptV2Schema.parse({
    id: executionId, actionId, contractVersion: 2, actorId: legacy.profile.id,
    kind: payload.kind, outcome: 'pending', proofs: [], createdAt, verifiedAt: null, currentStates: []
  });

  const workflowTriggers = db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'workflow_%'
  `).all() as Array<{ name: string }>;
  for (const { name } of workflowTriggers) {
    db.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      INSERT INTO org_units (id, body, row_version, parent_org_unit_id, name, active)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(orgUnit.id, JSON.stringify(orgUnit), orgUnit.rowVersion, null, orgUnit.name, 1);
    db.prepare(`
      INSERT INTO directory_identities (
        id, body, row_version, profile_id, org_unit_id, manager_identity_id, role, active, verified_demo_email
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(identity.id, JSON.stringify(identity), identity.rowVersion, identity.profileId, identity.orgUnitId,
      identity.managerIdentityId, identity.role, 1, identity.verifiedDemoEmail);
    db.prepare(`
      INSERT INTO responsibilities (id, body, row_version, identity_id, org_unit_id, purpose, active)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(responsibility.id, JSON.stringify(responsibility), responsibility.rowVersion,
      responsibility.identityId, responsibility.orgUnitId, responsibility.purpose, 1);
    db.prepare(`
      INSERT INTO workflow_teams (id, body, row_version, name, active)
      VALUES (?, ?, ?, ?, ?)
    `).run(team.id, JSON.stringify(team), team.rowVersion, team.name, 1);
    db.prepare(`
      INSERT INTO workflow_policies (id, body, row_version, policy_id, version, digest)
      VALUES (?, ?, 1, ?, ?, ?)
    `).run(policyRecord.id, JSON.stringify(policyRecord), policyRecord.id,
      policyRecord.version, policyRecord.digest);
    db.prepare(`
      INSERT INTO investigation_cases (
        id, body, row_version, branch_id, owner_identity_id, status, business_date, due_date
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(investigationCase.id, JSON.stringify(investigationCase), investigationCase.rowVersion,
      investigationCase.branchId, investigationCase.ownerIdentityId, investigationCase.status,
      investigationCase.businessDate, investigationCase.dueDate);
    db.prepare(`
      INSERT INTO branch_review_assignments (
        id, body, row_version, branch_id, case_id, owner_identity_id, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(branchAssignment.id, JSON.stringify(branchAssignment), branchAssignment.rowVersion,
      branchAssignment.branchId, branchAssignment.caseId, branchAssignment.ownerIdentityId, branchAssignment.status);
    db.prepare(`
      INSERT INTO pending_actions (
        id, payload, row_version, workflow_contract_version, actor_id, session_id, conversation_id,
        reviewed_snapshot_id, status, idempotency_key, payload_hash, expires_at,
        policy_id, policy_version, policy_digest
      ) VALUES (?, ?, ?, 2, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(action.id, JSON.stringify(action), 3, action.actorId, action.sessionId, action.conversationId,
      action.reviewedSnapshotId, action.status, action.idempotencyKey, action.payloadHash, action.expiresAt,
      action.policy.id, action.policy.version, action.policy.digest);
    db.prepare(`
      INSERT INTO action_idempotency_roots (id, body, row_version, actor_id, idempotency_key, status, active_execution_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(root.id, JSON.stringify(root), root.rowVersion, root.actorId, root.idempotencyKey,
      root.status, root.activeExecutionId);
    db.prepare(`
      INSERT INTO action_executions (
        id, payload, row_version, workflow_contract_version, action_id, root_id, attempt, outcome, execution_id, created_at
      ) VALUES (?, ?, ?, 2, ?, ?, ?, ?, ?, ?)
    `).run(receipt.id, JSON.stringify(receipt), 5, receipt.actionId, root.id, 1,
      receipt.outcome, null, receipt.createdAt);
    db.exec('COMMIT');
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw error;
  }

  return { orgUnit, identity, responsibility, team, policyRecord, investigationCase, branchAssignment, action, root, receipt };
}

function historicalV2RowsSnapshot(
  db: Database.Database,
  rows: ReturnType<typeof insertHistoricalV2Rows>
): string {
  return JSON.stringify({
    orgUnit: db.prepare('SELECT id, body, row_version, parent_org_unit_id, name, active FROM org_units WHERE id = ?')
      .get(rows.orgUnit.id),
    identity: db.prepare(`
      SELECT id, body, row_version, profile_id, org_unit_id, manager_identity_id, role, active, verified_demo_email
      FROM directory_identities WHERE id = ?
    `).get(rows.identity.id),
    responsibility: db.prepare(`
      SELECT id, body, row_version, identity_id, org_unit_id, purpose, active
      FROM responsibilities WHERE id = ?
    `).get(rows.responsibility.id),
    team: db.prepare('SELECT id, body, row_version, name, active FROM workflow_teams WHERE id = ?')
      .get(rows.team.id),
    policy: db.prepare('SELECT id, body, row_version, policy_id, version, digest FROM workflow_policies WHERE id = ?')
      .get(rows.policyRecord.id),
    investigationCase: db.prepare(`
      SELECT id, body, row_version, branch_id, owner_identity_id, status, business_date, due_date
      FROM investigation_cases WHERE id = ?
    `).get(rows.investigationCase.id),
    branchAssignment: db.prepare(`
      SELECT id, body, row_version, branch_id, case_id, owner_identity_id, status
      FROM branch_review_assignments WHERE id = ?
    `).get(rows.branchAssignment.id),
    action: db.prepare(`
      SELECT id, payload, row_version, workflow_contract_version, actor_id, session_id,
        conversation_id, reviewed_snapshot_id, status, idempotency_key, payload_hash, expires_at,
        policy_id, policy_version, policy_digest
      FROM pending_actions WHERE id = ?
    `).get(rows.action.id),
    root: db.prepare(`
      SELECT id, body, row_version, actor_id, idempotency_key, status, active_execution_id
      FROM action_idempotency_roots WHERE id = ?
    `).get(rows.root.id),
    receipt: db.prepare(`
      SELECT id, payload, row_version, workflow_contract_version, action_id, root_id,
        attempt, outcome, execution_id, created_at
      FROM action_executions WHERE id = ?
    `).get(rows.receipt.id)
  });
}

function insertHistoricalContractReminder(
  db: Database.Database,
  legacy: ReturnType<typeof seedLegacyV1Sqlite>,
  rows: ReturnType<typeof insertHistoricalV2Rows>,
  suffix: string
) {
  const contract = {
    id: `projection-completeness-history-${suffix}-contract`, rowVersion: 13,
    employeeId: legacy.employee.id, status: 'active', startDate: '2026-01-01', endDate: null,
    contractType: 'employment', policyVersion: 'synthetic-policy-v1', createdAt
  };
  const reminder = {
    id: `projection-completeness-history-${suffix}-reminder`, rowVersion: 14,
    contractId: contract.id, milestone: 'expiration_30_days', expiresAt: '2026-11-02T00:00:00.000Z',
    status: 'pending', executionId: rows.receipt.id, createdAt
  };
  db.prepare(`
    INSERT INTO employment_contracts (id, body, row_version, employee_id, status, start_date, end_date)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(contract.id, JSON.stringify(contract), contract.rowVersion, contract.employeeId,
    contract.status, contract.startDate, contract.endDate);
  db.prepare(`
    INSERT INTO contract_reminders (
      id, body, row_version, contract_id, milestone, expires_at, status, execution_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(reminder.id, JSON.stringify(reminder), reminder.rowVersion, reminder.contractId,
    reminder.milestone, reminder.expiresAt, reminder.status, reminder.executionId);
  return { contract, reminder };
}

function contractReminderRowSnapshot(db: Database.Database, reminderId: string): string {
  return JSON.stringify(db.prepare(`
    SELECT id, body, row_version, contract_id, milestone, expires_at, status, execution_id
    FROM contract_reminders WHERE id = ?
  `).get(reminderId));
}

function historicalOnboardingRequest(
  legacy: ReturnType<typeof seedLegacyV1Sqlite>,
  rows: ReturnType<typeof insertHistoricalV2Rows>,
  options: { id: string; lifecycleId: string; state: string; rowVersion: number }
) {
  return {
    id: options.id, rowVersion: options.rowVersion,
    employeeId: legacy.employee.id, orgUnitId: rows.orgUnit.id,
    managerIdentityId: rows.identity.id, directorIdentityId: rows.identity.id,
    startDate: '2026-10-15', state: options.state, lifecycleId: options.lifecycleId,
    managerApprovalEventId: null, managerApprovedBy: null, managerApprovedAt: null,
    directorApprovalEventId: null, directorApprovedBy: null, directorApprovedAt: null,
    createdAt, updatedAt: createdAt
  };
}

function insertHistoricalOnboardingRequest(db: Database.Database, request: ReturnType<typeof historicalOnboardingRequest>): void {
  db.prepare(`
    INSERT INTO onboarding_requests (
      id, body, row_version, employee_id, org_unit_id, manager_identity_id, director_identity_id,
      start_date, state, lifecycle_id, manager_approval_event_id, director_approval_event_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(request.id, JSON.stringify(request), request.rowVersion, request.employeeId, request.orgUnitId,
    request.managerIdentityId, request.directorIdentityId, request.startDate, request.state, request.lifecycleId,
    request.managerApprovalEventId, request.directorApprovalEventId);
}

describe('SQLite workflow projection completeness', () => {
  itSqliteBound('records the pinned migration ledger and keeps a second apply byte-for-byte idle', async () => {
    const fixture = await createWorkflowSqliteFixture({ initialize: false });
    const db = fixture.openDatabase();
    try {
      const legacy = seedLegacyV1Sqlite(db);
      const descriptorDigest = createHash('sha256')
        .update(JSON.stringify(workflowMigrationDefinitions()))
        .digest('hex');
      expect(descriptorDigest).toBe(PINNED_WORKFLOW_MANIFEST_DIGEST);
      expect(createHash('sha256').update(JSON.stringify(historicalWorkflowCompletenessDefinitions)).digest('hex'))
        .toBe(PINNED_COMPLETENESS_DIGEST);
      const pendingProjection = workflowMigrationDefinitions().find(definition => definition.table === 'pending_actions');
      expect(pendingProjection?.bodyFields).toEqual(expect.arrayContaining([
        'predecessorActionId', 'supersededByActionId', 'staleReason', 'revisionDiff'
      ]));
      expect(pendingProjection?.immutableFields).toEqual(expect.arrayContaining(['predecessorActionId', 'revisionDiff']));
      expect(pendingProjection?.terminalImmutableFields).toMatchObject({
        claimed: ['supersededByActionId', 'staleReason'],
        stale: ['supersededByActionId', 'staleReason']
      });
      expect(validateWorkflowProjectionBody('pending_actions', legacy.pendingAction.id, 1, legacy.pendingAction).body)
        .toEqual(legacy.pendingAction);

      applyWorkflowSqliteMigrations(db);

      expect(workflowLedger(db)).toEqual(expectedWorkflowLedger());
      expect((db.prepare('SELECT revision FROM appmeta WHERE singleton = 1').get() as { revision: number }).revision)
        .toBe(17);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(indexColumns(db, 'responsibilities_open_identity_purpose_unique'))
        .toEqual(['identity_id', 'purpose', 'org_unit_id']);

      const legacyTicket = db.prepare(`
        SELECT payload, row_version, workflow_contract_version, assignee_id,
          employee_assignee_id, legacy_assignee_quarantined
        FROM mock_tickets WHERE id = ?
      `).get(legacy.ticket.id);
      expect(legacyTicket).toEqual({
        payload: legacy.payloads.get(legacy.ticket.id), row_version: null,
        workflow_contract_version: null, assignee_id: null,
        employee_assignee_id: null, legacy_assignee_quarantined: 1
      });
      expect(JSON.parse((legacyTicket as { payload: string }).payload).assigneeId).toBe(legacy.profile.id);
      const legacyReceipt = db.prepare(`
        SELECT payload, row_version, workflow_contract_version FROM action_executions WHERE id = ?
      `).get(legacy.receipt.id);
      expect(legacyReceipt).toEqual({
        payload: legacy.payloads.get(legacy.receipt.id), row_version: null, workflow_contract_version: null
      });

      const rowsAfterFirstApply = workflowRowsSnapshot(db);
      const schemaAfterFirstApply = workflowSchemaSnapshot(db);
      const ledgerAfterFirstApply = workflowLedger(db);
      applyWorkflowSqliteMigrations(db);
      expect(workflowRowsSnapshot(db)).toBe(rowsAfterFirstApply);
      expect(workflowSchemaSnapshot(db)).toEqual(schemaAfterFirstApply);
      expect(workflowLedger(db)).toEqual(ledgerAfterFirstApply);
      expect((db.prepare('SELECT revision FROM appmeta WHERE singleton = 1').get() as { revision: number }).revision)
        .toBe(17);
    } finally {
      db.close();
      await fixture.dispose();
    }
  });

  itSqliteBound('rejects terminal initial states for V2 actions, receipts, and new workflow rows', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const store = fixture.store;
      const context = await seedHrContext(store, 'creation-state');
      const requestRef = { table: 'onboarding_requests' as const, id: context.request.id };
      const expectedRows = [{ ref: requestRef, rowVersion: 1, state: 'draft' }];
      const payload: WorkflowPayloadV2 = {
        kind: 'offboarding_plan_create', caseId: 'projection-completeness-creation-state-case'
      };
      const target = {
        targetId: 'projection-completeness-creation-state-target',
        ref: requestRef,
        semanticKey: 'creation-state:request',
        expectedRows,
        ownerIdentityId: context.managerIdentityId,
        expectedEffectRef: { table: 'offboarding_plans' as const, id: 'projection-completeness-creation-state-plan' },
        expectedEffectVersion: 1
      };
      const { action, root, receipt } = await createPendingExecution(
        store, context, 'creation-state', payload, [target], expectedRows
      );

      const completedAction = pendingActionV2Schema.parse({
        ...action, id: 'projection-completeness-creation-state-completed-action', status: 'completed'
      });
      expect(() => validateWorkflowProjectionBody('pending_actions', completedAction.id, 1, completedAction)).not.toThrow();
      const revisionBeforeAction = readRevision(fixture);
      await expect(insertUnique(store, 'pending_actions', completedAction)).rejects.toMatchObject({ code: 'STORAGE' });
      expect(readRevision(fixture)).toBe(revisionBeforeAction);
      expect(await store.workflowProjectionReader.get('pending_actions', completedAction.id)).toBeUndefined();

      const failedReceipt = workflowReceiptV2Schema.parse({
        ...receipt, id: 'projection-completeness-creation-state-failed-receipt', outcome: 'failed'
      });
      expect(() => validateWorkflowProjectionBody('action_executions', failedReceipt.id, 1, failedReceipt)).not.toThrow();
      const revisionBeforeReceipt = readRevision(fixture);
      await expect(insertUnique(store, 'action_executions', failedReceipt,
        'action_executions_root_attempt_unique', { rootId: root.id, attempt: 2 }))
        .rejects.toMatchObject({ code: 'STORAGE' });
      expect(readRevision(fixture)).toBe(revisionBeforeReceipt);
      expect(await store.workflowProjectionReader.get('action_executions', failedReceipt.id)).toBeUndefined();

      const completedChecklist = {
        id: 'projection-completeness-creation-state-completed-checklist',
        requestId: context.request.id,
        templateId: 'creation-state-checklist',
        status: 'completed'
      };
      expect(() => validateWorkflowProjectionBody('onboarding_checklists', completedChecklist.id, 1, completedChecklist))
        .not.toThrow();
      const revisionBeforeChecklist = readRevision(fixture);
      await expect(insertUnique(store, 'onboarding_checklists', completedChecklist))
        .rejects.toMatchObject({ code: 'STORAGE' });
      expect(readRevision(fixture)).toBe(revisionBeforeChecklist);
      expect(await store.workflowProjectionReader.get('onboarding_checklists', completedChecklist.id)).toBeUndefined();

      const db = openInspectionDatabase(fixture);
      try {
        expect(() => db.prepare(`
          INSERT INTO action_executions (
            id, payload, row_version, workflow_contract_version, action_id, root_id, attempt, outcome, execution_id, created_at
          ) VALUES (?, ?, 1, 2, ?, ?, 2, ?, NULL, ?)
        `).run(failedReceipt.id, JSON.stringify(failedReceipt), failedReceipt.actionId, root.id,
          failedReceipt.outcome, failedReceipt.createdAt)).toThrow(/Invalid workflow creation state/);
        expect(() => db.prepare(`
          INSERT INTO onboarding_checklists (id, body, row_version, request_id, template_id, status)
          VALUES (?, ?, 1, ?, ?, ?)
        `).run(completedChecklist.id, JSON.stringify(completedChecklist), completedChecklist.requestId,
          completedChecklist.templateId, completedChecklist.status)).toThrow(/Invalid workflow creation state/);
      } finally {
        db.close();
      }
    } finally {
      await fixture.dispose();
    }
  });

  itSqliteBound('enforces SQLite nonnegative safe-integer guards for discount request base amounts', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const store = fixture.store;
      const context = await seedHrContext(store, 'discount-base-amount');
      const customerId = 'projection-completeness-discount-base-customer';
      await insertUnique(store, 'crm_customers', {
        id: customerId, ownerIdentityId: context.managerIdentityId,
        name: 'Synthetic discount customer', status: 'active', createdAt
      });

      const cases = [
        { label: 'negative', value: -1, expectedError: /Invalid workflow projection/ },
        { label: 'fractional', value: 1.5, expectedError: /Invalid workflow projection/ },
        { label: 'unsafe', value: Number.MAX_SAFE_INTEGER + 1, expectedError: /Invalid workflow projection/ },
        { label: 'zero', value: 0 },
        { label: 'safe-boundary', value: Number.MAX_SAFE_INTEGER }
      ] as const;
      for (const entry of cases) {
        const opportunityId = `projection-completeness-discount-base-${entry.label}-opportunity`;
        await insertUnique(store, 'crm_opportunities', {
          id: opportunityId, customerId, ownerIdentityId: context.managerIdentityId,
          title: `Synthetic ${entry.label} discount opportunity`, stage: 'prospecting', amountSatang: 100_000,
          expectedCloseDate: '2026-10-20', createdAt, updatedAt: createdAt
        });
      }

      const db = openInspectionDatabase(fixture);
      try {
        for (const entry of cases) {
          const id = `projection-completeness-discount-base-${entry.label}-request`;
          const opportunityId = `projection-completeness-discount-base-${entry.label}-opportunity`;
          const row = {
            id, opportunityId, ownerIdentityId: context.managerIdentityId,
            status: 'manager_review_pending', discountBasisPoints: 500,
            baseAmountSatang: entry.value, expiresAt: '2026-10-03T06:00:00.000Z',
            reason: 'Synthetic base amount boundary probe.', createdAt
          };
          const insert = db.prepare(`
            INSERT INTO discount_requests (
              id, row_version, body, opportunity_id, owner_identity_id, status,
              discount_basis_points, base_amount_satang, expires_at
            ) VALUES (@id, 1, @body, @opportunityId, @ownerIdentityId, @status,
              @discountBasisPoints, @baseAmountSatang, @expiresAt)
          `);
          const metadata = { ...row, body: JSON.stringify(row) };
          if ('expectedError' in entry) {
            expect(() => insert.run({ ...metadata, baseAmountSatang: 0 })).toThrow(entry.expectedError);
            expect(await store.workflowProjectionReader.get('discount_requests', id)).toBeUndefined();
          } else {
            insert.run(metadata);
            expect(db.prepare('SELECT base_amount_satang FROM discount_requests WHERE id = ?').get(id))
              .toEqual({ base_amount_satang: entry.value });
          }
        }
      } finally {
        db.close();
      }
    } finally {
      await fixture.dispose();
    }
  });

  itSqliteBound('rejects a wrong historical digest before changing schema, rows, revision, or the ledger', async () => {
    const fixture = await createWorkflowSqliteFixture({ initialize: false });
    const db = fixture.openDatabase();
    try {
      seedLegacyV1Sqlite(db);
      applyWorkflowSqliteMigrations(db);
      db.prepare('UPDATE workflow_schema_migrations SET digest = ? WHERE id = ?')
        .run('0'.repeat(64), WORKFLOW_BASE_MIGRATION);
      const schemaBefore = workflowSchemaSnapshot(db);
      const rowsBefore = workflowRowsSnapshot(db);
      const ledgerBefore = workflowLedger(db);
      const revisionBefore = (db.prepare('SELECT revision FROM appmeta WHERE singleton = 1').get() as { revision: number }).revision;

      expect(() => applyWorkflowSqliteMigrations(db)).toThrow(/manifest changed without a new schema version/);
      expect(workflowSchemaSnapshot(db)).toEqual(schemaBefore);
      expect(workflowRowsSnapshot(db)).toBe(rowsBefore);
      expect(workflowLedger(db)).toEqual(ledgerBefore);
      expect((db.prepare('SELECT revision FROM appmeta WHERE singleton = 1').get() as { revision: number }).revision)
        .toBe(revisionBefore);
    } finally {
      db.close();
      await fixture.dispose();
    }
  });

  itSqliteBound.each([
    {
      stage: 'pre-scope', checkpoint: WORKFLOW_BASE_MIGRATION,
      ledger: [{ id: WORKFLOW_BASE_MIGRATION, digest: WORKFLOW_BASE_DIGEST }],
      responsibilityIndex: ['identity_id', 'purpose']
    },
    {
      stage: 'scope', checkpoint: WORKFLOW_SCOPE_MIGRATION,
      ledger: [
        { id: WORKFLOW_BASE_MIGRATION, digest: WORKFLOW_BASE_DIGEST },
        { id: WORKFLOW_SCOPE_MIGRATION, digest: WORKFLOW_SCOPE_DIGEST }
      ],
      responsibilityIndex: ['identity_id', 'purpose', 'org_unit_id']
    }
  ])('upgrades the populated pinned $stage layout without rewriting V2 rows or revision', async ({
    stage, checkpoint, ledger, responsibilityIndex
  }) => {
    const fixture = await createWorkflowSqliteFixture({ initialize: false });
    const db = fixture.openDatabase();
    try {
      const legacy = seedLegacyV1Sqlite(db);
      expect(createHash('sha256').update(JSON.stringify(historicalWorkflowBaseDefinitions)).digest('hex'))
        .toBe(WORKFLOW_BASE_DIGEST);
      expect(createHash('sha256').update(JSON.stringify(historicalWorkflowScopeDefinitions)).digest('hex'))
        .toBe(WORKFLOW_SCOPE_DIGEST);

      materializeHistoricalWorkflowStage(db, checkpoint);
      expect(workflowLedger(db)).toEqual(ledger);
      expect(workflowLedger(db).some((entry) => entry.id === WORKFLOW_COMPLETENESS_MIGRATION)).toBe(false);
      expect(indexColumns(db, 'responsibilities_open_identity_purpose_unique')).toEqual(responsibilityIndex);
      const historicalDefinitions = stage === 'pre-scope'
        ? historicalWorkflowBaseDefinitions : historicalWorkflowScopeDefinitions;
      const branchIndexBefore = indexSql(db, 'branch_review_assignments_open_case_unique');
      expect(branchIndexBefore.toLowerCase()).toContain("'assigned'");
      expect(branchIndexBefore.toLowerCase()).not.toContain("'open'");
      expect((db.prepare('PRAGMA table_info(incidents)').all() as Array<{ name: string }>).map((column) => column.name))
        .not.toContain('escalation_stage');

      const rows = insertHistoricalV2Rows(db, legacy, stage);
      const rowsBefore = historicalWorkflowRowsSnapshot(db, historicalDefinitions);
      const v2RowsBefore = historicalV2RowsSnapshot(db, rows);
      const revisionBefore = (db.prepare('SELECT revision FROM appmeta WHERE singleton = 1').get() as { revision: number }).revision;
      expect(rowsBefore).toContain(rows.receipt.id);
      expect(JSON.parse(v2RowsBefore)).toMatchObject({
        responsibility: { row_version: 8 },
        action: { row_version: 3, workflow_contract_version: 2 },
        root: { row_version: 4 },
        receipt: { row_version: 5, workflow_contract_version: 2, root_id: rows.root.id, action_id: rows.action.id }
      });
      expect(db.pragma('foreign_key_check')).toEqual([]);

      applyWorkflowSqliteMigrations(db);

      expect(historicalWorkflowRowsSnapshot(db, historicalDefinitions)).toBe(rowsBefore);
      expect(historicalV2RowsSnapshot(db, rows)).toBe(v2RowsBefore);
      expect((db.prepare('SELECT revision FROM appmeta WHERE singleton = 1').get() as { revision: number }).revision)
        .toBe(revisionBefore);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(indexColumns(db, 'responsibilities_open_identity_purpose_unique'))
        .toEqual(['identity_id', 'purpose', 'org_unit_id']);
      const branchIndexAfter = indexSql(db, 'branch_review_assignments_open_case_unique');
      expect(branchIndexAfter.toLowerCase()).toContain("in ('open','assigned')");
      expect((db.prepare('PRAGMA table_info(incidents)').all() as Array<{ name: string }>).map((column) => column.name))
        .toContain('escalation_stage');
      expect(workflowLedger(db)).toEqual(expectedWorkflowLedger());

      const schemaAfterUpgrade = workflowSchemaSnapshot(db);
      applyWorkflowSqliteMigrations(db);
      expect(historicalWorkflowRowsSnapshot(db, historicalDefinitions)).toBe(rowsBefore);
      expect(historicalV2RowsSnapshot(db, rows)).toBe(v2RowsBefore);
      expect(workflowSchemaSnapshot(db)).toEqual(schemaAfterUpgrade);
      expect(workflowLedger(db)).toEqual(expectedWorkflowLedger());

      const store = fixture.openStore();
      const sameCaseOpen = {
        ...rows.branchAssignment,
        id: `projection-completeness-history-${stage}-same-case-open`,
        rowVersion: 1,
        status: 'open',
        dueDate: '2026-10-10', priority: 'normal', executionId: rows.receipt.id
      };
      const unique = {
        constraint: 'branch_review_assignments_open_case_unique',
        values: { caseId: rows.branchAssignment.caseId }
      };
      const revisionBeforeSameCase = readRevision(fixture);
      await expect(store.workflowTransaction((tx) => tx.insertUnique('branch_review_assignments', sameCaseOpen, unique)))
        .resolves.toEqual({ inserted: false, existing: rows.branchAssignment });
      expect(readRevision(fixture)).toBe(revisionBeforeSameCase);
      expect(await store.workflowProjectionReader.get('branch_review_assignments', sameCaseOpen.id)).toBeUndefined();

      const makeCase = (id: string, businessDate: string) => ({
        id, rowVersion: 1, branchId: legacy.branch.id, ownerIdentityId: rows.identity.id,
        status: 'open', businessDate, dueDate: '2026-10-10',
        reason: 'Synthetic branch review case.', priority: 'normal',
        sourceIds: [`${id}-source`], unansweredQuestion: 'Which source is under review?',
        lifecycleId: `${id}-lifecycle`
      });
      const differentCase = makeCase(`projection-completeness-${stage}-different-case`, '2026-10-04');
      const unassignedCase = makeCase(`projection-completeness-${stage}-assigned-rejection-case`, '2026-10-05');
      await insertUnique(store, 'investigation_cases', differentCase, 'investigation_cases_open_equivalent_unique', {
        branchId: differentCase.branchId, ownerIdentityId: differentCase.ownerIdentityId,
        businessDate: differentCase.businessDate
      });
      await insertUnique(store, 'investigation_cases', unassignedCase, 'investigation_cases_open_equivalent_unique', {
        branchId: unassignedCase.branchId, ownerIdentityId: unassignedCase.ownerIdentityId,
        businessDate: unassignedCase.businessDate
      });
      const differentCaseOpen = {
        id: `projection-completeness-${stage}-different-case-open`, rowVersion: 1,
        branchId: differentCase.branchId, caseId: differentCase.id, ownerIdentityId: differentCase.ownerIdentityId,
        status: 'open', dueDate: '2026-10-10', priority: 'normal', executionId: rows.receipt.id,
        reason: 'Synthetic branch review assignment.', createdAt
      };
      await expect(insertUnique(store, 'branch_review_assignments', differentCaseOpen,
        'branch_review_assignments_open_case_unique', { caseId: differentCase.id }))
        .resolves.toEqual({ inserted: true, row: differentCaseOpen });

      const freshAssigned = {
        ...differentCaseOpen,
        id: `projection-completeness-${stage}-fresh-assigned-rejected`,
        caseId: unassignedCase.id,
        status: 'assigned'
      };
      const revisionBeforeFreshAssigned = readRevision(fixture);
      await expect(insertUnique(store, 'branch_review_assignments', freshAssigned,
        'branch_review_assignments_open_case_unique', { caseId: unassignedCase.id }))
        .rejects.toMatchObject({ code: 'STORAGE' });
      expect(readRevision(fixture)).toBe(revisionBeforeFreshAssigned);
      expect(await store.workflowProjectionReader.get('branch_review_assignments', freshAssigned.id)).toBeUndefined();

      const revisionBeforeInvalidTransition = readRevision(fixture);
      await expect(store.workflowTransaction((tx) => tx.compareAndSwap(
        'branch_review_assignments', differentCaseOpen.id,
        { rowVersion: 1, state: 'open' },
        { ...differentCaseOpen, rowVersion: 2, status: 'assigned' }
      ))).rejects.toMatchObject({ code: 'STORAGE' });
      expect(readRevision(fixture)).toBe(revisionBeforeInvalidTransition);
      expect(await store.workflowProjectionReader.get('branch_review_assignments', differentCaseOpen.id))
        .toEqual({ id: differentCaseOpen.id, rowVersion: 1, body: differentCaseOpen });
    } finally {
      db.close();
      await fixture.dispose();
    }
  });

  itSqliteBound('rolls back completeness when the new open branch assignment key is duplicated', async () => {
    const fixture = await createWorkflowSqliteFixture({ initialize: false });
    const db = fixture.openDatabase();
    try {
      const legacy = seedLegacyV1Sqlite(db);
      materializeHistoricalWorkflowStage(db, WORKFLOW_SCOPE_MIGRATION);
      const rows = insertHistoricalV2Rows(db, legacy, 'scope-duplicate-open');
      const duplicateAssignments = [13, 14].map((rowVersion) => ({
        ...rows.branchAssignment,
        id: `projection-completeness-history-scope-duplicate-open-${rowVersion}`,
        rowVersion,
        status: 'open'
      }));
      const insertAssignment = db.prepare(`
        INSERT INTO branch_review_assignments (
          id, body, row_version, branch_id, case_id, owner_identity_id, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const assignment of duplicateAssignments) {
        insertAssignment.run(assignment.id, JSON.stringify(assignment), assignment.rowVersion,
          assignment.branchId, assignment.caseId, assignment.ownerIdentityId, assignment.status);
      }

      const rowsBefore = historicalWorkflowRowsSnapshot(db, historicalWorkflowScopeDefinitions);
      const v2RowsBefore = historicalV2RowsSnapshot(db, rows);
      const schemaBefore = workflowSchemaSnapshot(db);
      const branchIndexBefore = indexSql(db, 'branch_review_assignments_open_case_unique');
      const ledgerBefore = workflowLedger(db);
      const revisionBefore = (db.prepare('SELECT revision FROM appmeta WHERE singleton = 1').get() as { revision: number }).revision;
      expect(branchIndexBefore.toLowerCase()).toContain("'assigned'");
      expect(db.pragma('foreign_key_check')).toEqual([]);

      expect(() => applyWorkflowSqliteMigrations(db))
        .toThrow('Workflow migration contains duplicate open branch review assignments');

      expect(historicalWorkflowRowsSnapshot(db, historicalWorkflowScopeDefinitions)).toBe(rowsBefore);
      expect(historicalV2RowsSnapshot(db, rows)).toBe(v2RowsBefore);
      expect(workflowSchemaSnapshot(db)).toEqual(schemaBefore);
      expect(indexSql(db, 'branch_review_assignments_open_case_unique')).toBe(branchIndexBefore);
      expect(workflowLedger(db)).toEqual(ledgerBefore);
      expect((db.prepare('SELECT revision FROM appmeta WHERE singleton = 1').get() as { revision: number }).revision)
        .toBe(revisionBefore);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
      await fixture.dispose();
    }
  });

  itSqliteBound('rolls back when historical assigned and open branch rows collide under the expanded key', async () => {
    const fixture = await createWorkflowSqliteFixture({ initialize: false });
    const db = fixture.openDatabase();
    try {
      const legacy = seedLegacyV1Sqlite(db);
      materializeHistoricalWorkflowStage(db, WORKFLOW_SCOPE_MIGRATION);
      const rows = insertHistoricalV2Rows(db, legacy, 'scope-duplicate-mixed-branch-states');
      const openAssignment = {
        ...rows.branchAssignment,
        id: 'projection-completeness-history-scope-duplicate-mixed-open',
        rowVersion: 13,
        status: 'open'
      };
      db.prepare(`
        INSERT INTO branch_review_assignments (
          id, body, row_version, branch_id, case_id, owner_identity_id, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(openAssignment.id, JSON.stringify(openAssignment), openAssignment.rowVersion,
        openAssignment.branchId, openAssignment.caseId, openAssignment.ownerIdentityId, openAssignment.status);

      const rowsBefore = historicalWorkflowRowsSnapshot(db, historicalWorkflowScopeDefinitions);
      const v2RowsBefore = historicalV2RowsSnapshot(db, rows);
      const schemaBefore = workflowSchemaSnapshot(db);
      const branchIndexBefore = indexSql(db, 'branch_review_assignments_open_case_unique');
      const ledgerBefore = workflowLedger(db);
      const revisionBefore = (db.prepare('SELECT revision FROM appmeta WHERE singleton = 1').get() as { revision: number }).revision;
      expect(branchIndexBefore.toLowerCase()).toContain("in ('assigned')");
      expect(db.prepare(`
        SELECT count(*) AS count FROM branch_review_assignments
        WHERE case_id = ? AND status IN ('assigned','open')
      `).get(rows.branchAssignment.caseId)).toEqual({ count: 2 });
      expect(db.pragma('foreign_key_check')).toEqual([]);

      expect(() => applyWorkflowSqliteMigrations(db))
        .toThrow('Workflow migration contains duplicate open branch review assignments');

      expect(historicalWorkflowRowsSnapshot(db, historicalWorkflowScopeDefinitions)).toBe(rowsBefore);
      expect(historicalV2RowsSnapshot(db, rows)).toBe(v2RowsBefore);
      expect(workflowSchemaSnapshot(db)).toEqual(schemaBefore);
      expect(indexSql(db, 'branch_review_assignments_open_case_unique')).toBe(branchIndexBefore);
      expect(workflowLedger(db)).toEqual(ledgerBefore);
      expect((db.prepare('SELECT revision FROM appmeta WHERE singleton = 1').get() as { revision: number }).revision)
        .toBe(revisionBefore);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
      await fixture.dispose();
    }
  });

  itSqliteBound('replaces the historical contract reminder key and accepts different expiry dates', async () => {
    const fixture = await createWorkflowSqliteFixture({ initialize: false });
    const db = fixture.openDatabase();
    try {
      const legacy = seedLegacyV1Sqlite(db);
      materializeHistoricalWorkflowStage(db, WORKFLOW_SCOPE_MIGRATION);
      const rows = insertHistoricalV2Rows(db, legacy, 'scope-reminder-index');
      const { contract, reminder } = insertHistoricalContractReminder(db, legacy, rows, 'scope-reminder-index');
      const indexBefore = indexSql(db, 'contract_reminders_contract_milestone_unique');
      expect(indexColumns(db, 'contract_reminders_contract_milestone_unique')).toEqual(['contract_id', 'milestone']);
      expect(indexBefore.toLowerCase()).not.toContain('expires_at');

      const rowsBefore = historicalWorkflowRowsSnapshot(db, historicalWorkflowScopeDefinitions);
      const reminderBefore = contractReminderRowSnapshot(db, reminder.id);
      const revisionBefore = (db.prepare('SELECT revision FROM appmeta WHERE singleton = 1').get() as { revision: number }).revision;
      expect(db.pragma('foreign_key_check')).toEqual([]);

      applyWorkflowSqliteMigrations(db);

      expect(historicalWorkflowRowsSnapshot(db, historicalWorkflowScopeDefinitions)).toBe(rowsBefore);
      expect(contractReminderRowSnapshot(db, reminder.id)).toBe(reminderBefore);
      expect(indexColumns(db, 'contract_reminders_contract_milestone_unique'))
        .toEqual(['contract_id', 'expires_at', 'milestone']);
      expect(indexSql(db, 'contract_reminders_contract_milestone_unique').toLowerCase()).toContain('expires_at');
      expect((db.prepare('SELECT revision FROM appmeta WHERE singleton = 1').get() as { revision: number }).revision)
        .toBe(revisionBefore);
      expect(workflowLedger(db)).toEqual(expectedWorkflowLedger());
      expect(db.pragma('foreign_key_check')).toEqual([]);

      const schemaAfterUpgrade = workflowSchemaSnapshot(db);
      applyWorkflowSqliteMigrations(db);
      expect(workflowSchemaSnapshot(db)).toEqual(schemaAfterUpgrade);
      expect(historicalWorkflowRowsSnapshot(db, historicalWorkflowScopeDefinitions)).toBe(rowsBefore);
      expect(contractReminderRowSnapshot(db, reminder.id)).toBe(reminderBefore);

      const store = fixture.openStore();
      const nextExpiry = '2026-11-03T00:00:00.000Z';
      const nextReminder = {
        id: 'projection-completeness-reminder-next-expiry', rowVersion: 1,
        contractId: contract.id, milestone: reminder.milestone, expiresAt: nextExpiry,
        status: 'pending', executionId: rows.receipt.id, ownerIdentityId: rows.identity.id,
        dueDate: '2026-11-03', priority: 'normal', reason: 'Synthetic expiry-specific reminder.', createdAt
      };
      const unique = {
        constraint: 'contract_reminders_contract_milestone_unique',
        values: { contractId: contract.id, expiresAt: nextExpiry, milestone: reminder.milestone }
      };
      await expect(store.workflowTransaction((tx) => tx.insertUnique('contract_reminders', nextReminder, unique)))
        .resolves.toEqual({ inserted: true, row: nextReminder });
      expect(await store.workflowProjectionReader.get('contract_reminders', nextReminder.id))
        .toEqual({ id: nextReminder.id, rowVersion: 1, body: nextReminder });

      const revisionBeforeDuplicate = readRevision(fixture);
      const duplicate = { ...nextReminder, id: 'projection-completeness-reminder-exact-duplicate' };
      await expect(store.workflowTransaction((tx) => tx.insertUnique('contract_reminders', duplicate, unique)))
        .resolves.toEqual({ inserted: false, existing: nextReminder });
      expect(readRevision(fixture)).toBe(revisionBeforeDuplicate);
      expect(await store.workflowProjectionReader.get('contract_reminders', duplicate.id)).toBeUndefined();
    } finally {
      db.close();
      await fixture.dispose();
    }
  });

  itSqliteBound('fails closed and rolls back when a historical contract reminder index has unknown SQL', async () => {
    const fixture = await createWorkflowSqliteFixture({ initialize: false });
    const db = fixture.openDatabase();
    try {
      const legacy = seedLegacyV1Sqlite(db);
      materializeHistoricalWorkflowStage(db, WORKFLOW_SCOPE_MIGRATION);
      const rows = insertHistoricalV2Rows(db, legacy, 'scope-reminder-unknown-index');
      const { reminder } = insertHistoricalContractReminder(db, legacy, rows, 'scope-reminder-unknown-index');
      db.exec('DROP INDEX contract_reminders_contract_milestone_unique');
      db.exec(`
        CREATE UNIQUE INDEX contract_reminders_contract_milestone_unique
        ON contract_reminders (expires_at)
      `);

      const rowsBefore = historicalWorkflowRowsSnapshot(db, historicalWorkflowScopeDefinitions);
      const v2RowsBefore = historicalV2RowsSnapshot(db, rows);
      const reminderBefore = contractReminderRowSnapshot(db, reminder.id);
      const schemaBefore = workflowSchemaSnapshot(db);
      const indexBefore = indexSql(db, 'contract_reminders_contract_milestone_unique');
      const ledgerBefore = workflowLedger(db);
      const revisionBefore = (db.prepare('SELECT revision FROM appmeta WHERE singleton = 1').get() as { revision: number }).revision;
      expect(indexColumns(db, 'contract_reminders_contract_milestone_unique')).toEqual(['expires_at']);
      expect(db.pragma('foreign_key_check')).toEqual([]);

      expect(() => applyWorkflowSqliteMigrations(db))
        .toThrow('Workflow migration found incompatible contract reminder index');

      expect(historicalWorkflowRowsSnapshot(db, historicalWorkflowScopeDefinitions)).toBe(rowsBefore);
      expect(historicalV2RowsSnapshot(db, rows)).toBe(v2RowsBefore);
      expect(contractReminderRowSnapshot(db, reminder.id)).toBe(reminderBefore);
      expect(workflowSchemaSnapshot(db)).toEqual(schemaBefore);
      expect(indexSql(db, 'contract_reminders_contract_milestone_unique')).toBe(indexBefore);
      expect(workflowLedger(db)).toEqual(ledgerBefore);
      expect((db.prepare('SELECT revision FROM appmeta WHERE singleton = 1').get() as { revision: number }).revision)
        .toBe(revisionBefore);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
      await fixture.dispose();
    }
  });

  itSqliteBound('removes returned-for-revision from the historical onboarding request key', async () => {
    const fixture = await createWorkflowSqliteFixture({ initialize: false });
    const db = fixture.openDatabase();
    try {
      const legacy = seedLegacyV1Sqlite(db);
      materializeHistoricalWorkflowStage(db, WORKFLOW_SCOPE_MIGRATION);
      const rows = insertHistoricalV2Rows(db, legacy, 'scope-onboarding-index');
      const returned = historicalOnboardingRequest(legacy, rows, {
        id: 'projection-completeness-history-onboarding-returned',
        lifecycleId: 'projection-completeness-history-onboarding-lifecycle',
        state: 'returned_for_revision',
        rowVersion: 16
      });
      insertHistoricalOnboardingRequest(db, returned);
      const indexBefore = indexSql(db, 'onboarding_requests_open_employee_lifecycle_unique');
      expect(indexColumns(db, 'onboarding_requests_open_employee_lifecycle_unique'))
        .toEqual(['employee_id', 'lifecycle_id']);
      expect(indexBefore.toLowerCase()).toContain("'returned_for_revision'");

      const rowsBefore = historicalWorkflowRowsSnapshot(db, historicalWorkflowScopeDefinitions);
      const revisionBefore = (db.prepare('SELECT revision FROM appmeta WHERE singleton = 1').get() as { revision: number }).revision;
      expect(db.pragma('foreign_key_check')).toEqual([]);

      applyWorkflowSqliteMigrations(db);

      expect(historicalWorkflowRowsSnapshot(db, historicalWorkflowScopeDefinitions)).toBe(rowsBefore);
      const indexAfter = indexSql(db, 'onboarding_requests_open_employee_lifecycle_unique');
      expect(indexAfter.toLowerCase()).not.toContain("'returned_for_revision'");
      expect(indexColumns(db, 'onboarding_requests_open_employee_lifecycle_unique'))
        .toEqual(['employee_id', 'lifecycle_id']);
      expect((db.prepare('SELECT revision FROM appmeta WHERE singleton = 1').get() as { revision: number }).revision)
        .toBe(revisionBefore);
      expect(workflowLedger(db)).toEqual(expectedWorkflowLedger());
      expect(db.pragma('foreign_key_check')).toEqual([]);

      const store = fixture.openStore();
      expect(await store.workflowProjectionReader.get('onboarding_requests', returned.id))
        .toEqual({ id: returned.id, rowVersion: returned.rowVersion, body: returned });
      const reopened = historicalOnboardingRequest(legacy, rows, {
        ...returned,
        id: 'projection-completeness-history-onboarding-reopened',
        state: 'draft',
        rowVersion: 1
      });
      const unique = {
        constraint: 'onboarding_requests_open_employee_lifecycle_unique',
        values: { employeeId: reopened.employeeId, lifecycleId: reopened.lifecycleId }
      };
      await expect(store.workflowTransaction((tx) => tx.insertUnique('onboarding_requests', reopened, unique)))
        .resolves.toEqual({ inserted: true, row: reopened });
      const revisionBeforeDuplicate = readRevision(fixture);
      const duplicate = { ...reopened, id: 'projection-completeness-history-onboarding-duplicate' };
      await expect(store.workflowTransaction((tx) => tx.insertUnique('onboarding_requests', duplicate, unique)))
        .resolves.toEqual({ inserted: false, existing: reopened });
      expect(readRevision(fixture)).toBe(revisionBeforeDuplicate);
      expect(await store.workflowProjectionReader.get('onboarding_requests', duplicate.id)).toBeUndefined();
    } finally {
      db.close();
      await fixture.dispose();
    }
  });

  itSqliteBound('fails closed and rolls back when a historical onboarding request index has unknown SQL', async () => {
    const fixture = await createWorkflowSqliteFixture({ initialize: false });
    const db = fixture.openDatabase();
    try {
      const legacy = seedLegacyV1Sqlite(db);
      materializeHistoricalWorkflowStage(db, WORKFLOW_SCOPE_MIGRATION);
      const rows = insertHistoricalV2Rows(db, legacy, 'scope-onboarding-unknown-index');
      const returned = historicalOnboardingRequest(legacy, rows, {
        id: 'projection-completeness-history-onboarding-unknown-index',
        lifecycleId: 'projection-completeness-history-onboarding-unknown-lifecycle',
        state: 'returned_for_revision',
        rowVersion: 16
      });
      insertHistoricalOnboardingRequest(db, returned);
      db.exec('DROP INDEX onboarding_requests_open_employee_lifecycle_unique');
      db.exec(`
        CREATE UNIQUE INDEX onboarding_requests_open_employee_lifecycle_unique
        ON onboarding_requests (employee_id, lifecycle_id)
        WHERE state IN ('draft')
      `);

      const rowsBefore = historicalWorkflowRowsSnapshot(db, historicalWorkflowScopeDefinitions);
      const v2RowsBefore = historicalV2RowsSnapshot(db, rows);
      const schemaBefore = workflowSchemaSnapshot(db);
      const indexBefore = indexSql(db, 'onboarding_requests_open_employee_lifecycle_unique');
      const ledgerBefore = workflowLedger(db);
      const revisionBefore = (db.prepare('SELECT revision FROM appmeta WHERE singleton = 1').get() as { revision: number }).revision;
      expect(indexBefore.toLowerCase()).toContain("'draft'");
      expect(db.pragma('foreign_key_check')).toEqual([]);

      expect(() => applyWorkflowSqliteMigrations(db))
        .toThrow('Workflow migration found incompatible onboarding request index');

      expect(historicalWorkflowRowsSnapshot(db, historicalWorkflowScopeDefinitions)).toBe(rowsBefore);
      expect(historicalV2RowsSnapshot(db, rows)).toBe(v2RowsBefore);
      expect(workflowSchemaSnapshot(db)).toEqual(schemaBefore);
      expect(indexSql(db, 'onboarding_requests_open_employee_lifecycle_unique')).toBe(indexBefore);
      expect(workflowLedger(db)).toEqual(ledgerBefore);
      expect((db.prepare('SELECT revision FROM appmeta WHERE singleton = 1').get() as { revision: number }).revision)
        .toBe(revisionBefore);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
      await fixture.dispose();
    }
  });

  itSqliteBound('rolls back onboarding index replacement when historical rows duplicate a current open key', async () => {
    const fixture = await createWorkflowSqliteFixture({ initialize: false });
    const db = fixture.openDatabase();
    try {
      const legacy = seedLegacyV1Sqlite(db);
      materializeHistoricalWorkflowStage(db, WORKFLOW_SCOPE_MIGRATION);
      const rows = insertHistoricalV2Rows(db, legacy, 'scope-onboarding-duplicate-key');
      db.exec('DROP INDEX onboarding_requests_open_employee_lifecycle_unique');
      const requests = [20, 21].map((rowVersion) => historicalOnboardingRequest(legacy, rows, {
        id: `projection-completeness-history-onboarding-duplicate-key-${rowVersion}`,
        lifecycleId: 'projection-completeness-history-onboarding-duplicate-key-lifecycle',
        state: 'draft',
        rowVersion
      }));
      for (const request of requests) insertHistoricalOnboardingRequest(db, request);

      const rowsBefore = historicalWorkflowRowsSnapshot(db, historicalWorkflowScopeDefinitions);
      const v2RowsBefore = historicalV2RowsSnapshot(db, rows);
      const schemaBefore = workflowSchemaSnapshot(db);
      const ledgerBefore = workflowLedger(db);
      const revisionBefore = (db.prepare('SELECT revision FROM appmeta WHERE singleton = 1').get() as { revision: number }).revision;
      expect(db.prepare(`
        SELECT count(*) AS count FROM onboarding_requests
        WHERE employee_id = ? AND lifecycle_id = ? AND state = 'draft'
      `).get(legacy.employee.id, 'projection-completeness-history-onboarding-duplicate-key-lifecycle'))
        .toEqual({ count: 2 });
      expect(db.pragma('foreign_key_check')).toEqual([]);

      expect(() => applyWorkflowSqliteMigrations(db))
        .toThrow('Workflow migration contains duplicate open onboarding requests');

      expect(historicalWorkflowRowsSnapshot(db, historicalWorkflowScopeDefinitions)).toBe(rowsBefore);
      expect(historicalV2RowsSnapshot(db, rows)).toBe(v2RowsBefore);
      expect(workflowSchemaSnapshot(db)).toEqual(schemaBefore);
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get('onboarding_requests_open_employee_lifecycle_unique')).toBeUndefined();
      expect(workflowLedger(db)).toEqual(ledgerBefore);
      expect((db.prepare('SELECT revision FROM appmeta WHERE singleton = 1').get() as { revision: number }).revision)
        .toBe(revisionBefore);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
      await fixture.dispose();
    }
  });

  itSqliteBound('quarantines profile-assigned V1 tickets and pins new ticket assignees to employees', async () => {
    const fixture = await createWorkflowSqliteFixture({ initialize: false });
    const migrationDb = fixture.openDatabase();
    let legacy: ReturnType<typeof seedLegacyV1Sqlite>;
    try {
      legacy = seedLegacyV1Sqlite(migrationDb);
      applyWorkflowSqliteMigrations(migrationDb);
    } finally {
      migrationDb.close();
    }

    try {
      const store = fixture.openStore();
      const context = await seedHrContext(store, 'ticket-assignment');
      const caseId = 'projection-completeness-investigation-case';
      const caseRow = {
        id: caseId,
        rowVersion: 1,
        branchId: context.branchId,
        ownerIdentityId: context.managerIdentityId,
        status: 'open',
        businessDate: '2026-10-03',
        dueDate: '2026-10-07',
        reason: 'Synthetic reviewed investigation case.',
        priority: 'normal',
        sourceIds: ['projection-completeness-investigation-source'],
        unansweredQuestion: 'Which reviewed source explains the difference?',
        lifecycleId: 'projection-completeness-investigation-life'
      };
      await insertUnique(store, 'investigation_cases', caseRow,
        'investigation_cases_open_equivalent_unique', {
          branchId: context.branchId,
          ownerIdentityId: context.managerIdentityId,
          businessDate: '2026-10-03'
        });
      const freshTicketId = 'projection-completeness-fresh-employee-ticket';
      const payload = {
        kind: 'investigation_create' as const,
        businessDate: '2026-10-03',
        targets: [{
          ownerIdentityId: context.managerIdentityId,
          reason: 'Synthetic reviewed investigation task.',
          dueDate: '2026-10-07',
          priority: 'normal' as const,
          branchId: context.branchId,
          caseId,
          sourceIds: ['projection-completeness-investigation-source'],
          unansweredQuestion: 'Which reviewed source explains the difference?'
        }]
      };
      const expectedRows = [{
        ref: { table: 'branches' as const, id: context.branchId }, rowVersion: 1, state: null
      }];
      const targets = [{
        targetId: 'projection-completeness-ticket-target',
        ref: { table: 'investigation_cases' as const, id: caseId },
        semanticKey: `investigation:${caseId}:task`,
        expectedRows,
        ownerIdentityId: context.managerIdentityId,
        expectedEffectRef: { table: 'mock_tickets' as const, id: freshTicketId },
        expectedEffectVersion: 1
      }];
      const { receipt } = await createPendingExecution(store, context, 'ticket-assignment', payload, targets, expectedRows);
      const freshTicket = {
        id: freshTicketId,
        rowVersion: 1,
        branchId: context.branchId,
        assigneeId: context.employeeId,
        title: 'Synthetic investigation ticket',
        reason: 'Synthetic reviewed investigation task.',
        unansweredQuestion: 'Which reviewed source explains the difference?',
        sourceIds: ['projection-completeness-investigation-source'],
        status: 'open',
        operationKey: 'projection-completeness-fresh-ticket-operation',
        createdAt,
        ownerIdentityId: context.managerIdentityId,
        caseId,
        executionId: receipt.id,
        dueDate: '2026-10-07',
        priority: 'normal'
      };
      await insertUnique(store, 'mock_tickets', freshTicket, 'mock_ticket_operation_unique', {
        operationKey: freshTicket.operationKey
      });

      expect(await store.get('mock_tickets', legacy.ticket.id)).toEqual(legacy.ticket);
      expect(await store.workflowProjectionReader.get('mock_tickets', legacy.ticket.id)).toBeUndefined();
      expect(await store.workflowProjectionReader.get<typeof freshTicket>('mock_tickets', freshTicket.id))
        .toEqual({ id: freshTicket.id, rowVersion: 1, body: freshTicket });

      const db = openInspectionDatabase(fixture);
      try {
        expect(db.prepare(`
          SELECT payload, row_version, workflow_contract_version, assignee_id,
            employee_assignee_id, legacy_assignee_quarantined
          FROM mock_tickets WHERE id = ?
        `).get(legacy.ticket.id)).toEqual({
          payload: legacy.payloads.get(legacy.ticket.id), row_version: null,
          workflow_contract_version: null, assignee_id: null,
          employee_assignee_id: null, legacy_assignee_quarantined: 1
        });
        expect(JSON.parse((db.prepare('SELECT payload FROM mock_tickets WHERE id = ?').get(legacy.ticket.id) as { payload: string }).payload).assigneeId)
          .toBe(legacy.profile.id);
        expect(db.prepare(`
          SELECT workflow_contract_version, assignee_id, employee_assignee_id,
            legacy_assignee_quarantined
          FROM mock_tickets WHERE id = ?
        `).get(freshTicket.id)).toEqual({
          workflow_contract_version: 2, assignee_id: null,
          employee_assignee_id: context.employeeId, legacy_assignee_quarantined: 0
        });
      } finally {
        db.close();
      }

      const revision = readRevision(fixture);
      await expect(store.transaction((tx) => tx.put('mock_tickets', {
        ...legacy.ticket, title: 'Synthetic attempted legacy rewrite'
      }))).rejects.toMatchObject({ code: 'STORAGE' });
      await expect(insertUnique(store, 'mock_tickets', {
        ...freshTicket,
        id: 'projection-completeness-invalid-profile-ticket',
        assigneeId: context.managerProfileId,
        operationKey: 'projection-completeness-invalid-profile-operation'
      }, 'mock_ticket_operation_unique', {
        operationKey: 'projection-completeness-invalid-profile-operation'
      })).rejects.toMatchObject({ code: 'STORAGE' });
      expect(readRevision(fixture)).toBe(revision);
      expect(await store.get('mock_tickets', legacy.ticket.id)).toEqual(legacy.ticket);
      expect(await store.workflowProjectionReader.get('mock_tickets', 'projection-completeness-invalid-profile-ticket'))
        .toBeUndefined();
    } finally {
      await fixture.dispose();
    }
  });

  itSqliteBound('keeps accepted documents distinct from readable legacy states and rejects non-accepted initial writes', async () => {
    const fixture = await createWorkflowSqliteFixture({ initialize: false });
    try {
      const migrationDb = fixture.openDatabase();
      let legacyRows: Array<{
        id: string;
        documentType: string;
        status: string;
        requestId: string;
        employeeId: string;
        rowVersion: number;
        policyVersion: string;
        classification: string;
        contentDigest: string;
        createdAt: string;
        withdrawnAt: string | null;
      }>;
      try {
        const legacy = seedLegacyV1Sqlite(migrationDb);
        materializeHistoricalWorkflowStage(migrationDb, WORKFLOW_SCOPE_MIGRATION);
        const historicalRows = insertHistoricalV2Rows(migrationDb, legacy, 'scope-document-states');
        const historicalRequest = historicalOnboardingRequest(legacy, historicalRows, {
          id: 'projection-completeness-document-history-request',
          lifecycleId: 'projection-completeness-document-history-lifecycle',
          state: 'draft',
          rowVersion: 1
        });
        insertHistoricalOnboardingRequest(migrationDb, historicalRequest);
        const acceptedBeforeUpgrade = {
          id: 'projection-completeness-document-accepted-predecessor',
          rowVersion: 1,
          requestId: historicalRequest.id,
          employeeId: legacy.employee.id,
          documentType: 'legacy_accepted',
          status: 'accepted',
          policyVersion: '1.0',
          classification: 'internal',
          contentDigest: 'a'.repeat(64),
          createdAt,
          withdrawnAt: null
        };
        legacyRows = [
          { id: 'projection-completeness-document-missing', documentType: 'legacy_missing', status: 'missing' },
          { id: 'projection-completeness-document-received', documentType: 'legacy_received', status: 'received' },
          { id: 'projection-completeness-document-waived', documentType: 'legacy_waived', status: 'waived' },
          { id: 'projection-completeness-document-withdrawn', documentType: 'legacy_withdrawn', status: 'withdrawn' },
          { id: 'projection-completeness-document-replaced', documentType: 'legacy_replaced', status: 'replaced' }
        ].map((row) => ({
          ...row,
          requestId: historicalRequest.id,
          employeeId: legacy.employee.id,
          rowVersion: 1,
          policyVersion: '1.0',
          classification: 'internal',
          contentDigest: createHash('sha256').update(`legacy-${row.status}`).digest('hex'),
          createdAt,
          withdrawnAt: row.status === 'withdrawn' || row.status === 'replaced' ? createdAt : null
        }));
        migrationDb.exec('DROP TRIGGER IF EXISTS workflow_onboarding_documents_insert_guard');
        const insert = migrationDb.prepare(`
          INSERT INTO onboarding_documents (
            id, body, row_version, request_id, employee_id, document_type, status
          ) VALUES (
            @id, @body, 1, @requestId, @employeeId, @documentType, @status
          )
        `);
        for (const row of [acceptedBeforeUpgrade, ...legacyRows]) {
          insert.run({ ...row, body: JSON.stringify(row) });
        }

        const revisionBeforeCompletenessUpgrade = (migrationDb.prepare(
          'SELECT revision FROM appmeta WHERE singleton = 1'
        ).get() as { revision: number }).revision;
        const documentsBeforeCompletenessUpgrade = [acceptedBeforeUpgrade, ...legacyRows];
        const bodyBytesBeforeCompletenessUpgrade = documentsBeforeCompletenessUpgrade.map((row) => ({
          id: row.id,
          ...migrationDb.prepare('SELECT body, row_version FROM onboarding_documents WHERE id = ?').get(row.id) as {
            body: string; row_version: number
          }
        }));
        applyWorkflowSqliteMigrations(migrationDb);
        const bodyBytesAfterCompletenessUpgrade = documentsBeforeCompletenessUpgrade.map((row) => ({
          id: row.id,
          ...migrationDb.prepare('SELECT body, row_version FROM onboarding_documents WHERE id = ?').get(row.id) as {
            body: string; row_version: number
          }
        }));
        expect(bodyBytesAfterCompletenessUpgrade).toEqual(bodyBytesBeforeCompletenessUpgrade);
        expect((migrationDb.prepare('SELECT revision FROM appmeta WHERE singleton = 1').get() as { revision: number }).revision)
          .toBe(revisionBeforeCompletenessUpgrade);
      } finally {
        migrationDb.close();
      }

      const store = fixture.openStore();
      const context = await seedHrContext(store, 'document-states');
      const accepted = {
        id: 'projection-completeness-document-accepted',
        rowVersion: 1,
        requestId: context.request.id,
        employeeId: context.employeeId,
        documentType: 'identity_document',
        status: 'accepted',
        policyVersion: '1.0',
        classification: 'internal',
        contentDigest: 'a'.repeat(64),
        createdAt,
        withdrawnAt: null
      };
      await insertUnique(store, 'onboarding_documents', accepted, 'onboarding_documents_request_type_unique', {
        requestId: context.request.id, documentType: accepted.documentType
      });

      expect(await store.workflowProjectionReader.get<typeof accepted>('onboarding_documents', accepted.id))
        .toEqual({ id: accepted.id, rowVersion: 1, body: accepted });
      for (const legacy of legacyRows) {
        expect(await store.workflowProjectionReader.get<typeof legacy>('onboarding_documents', legacy.id))
          .toEqual({ id: legacy.id, rowVersion: 1, body: legacy });
        await expect(store.workflowTransaction((tx) => tx.compareAndSwap(
          'onboarding_documents', legacy.id,
          { rowVersion: 1, state: legacy.status },
          { ...legacy, rowVersion: 2, status: 'accepted' }
        ))).rejects.toMatchObject({ code: 'STORAGE' });
      }
      expect(await store.workflowProjectionReader.query<typeof accepted>({
        kind: 'scoped', table: 'onboarding_documents', equals: { requestId: context.request.id },
        status: 'accepted', limit: 10
      })).toEqual([{ id: accepted.id, rowVersion: 1, body: accepted }]);

      const revisionBeforeInvalidDocumentWrites = readRevision(fixture);
      for (const status of ['withdrawn', 'replaced'] as const) {
        const rejected = {
          ...accepted,
          id: `projection-completeness-new-${status}-document`,
          documentType: `new_${status}`,
          status
        };
        await expect(insertUnique(store, 'onboarding_documents', rejected,
          'onboarding_documents_request_type_unique', {
            requestId: context.request.id, documentType: rejected.documentType
          })).rejects.toMatchObject({ code: 'STORAGE' });
        expect(await store.workflowProjectionReader.get('onboarding_documents', rejected.id)).toBeUndefined();
      }
      expect(readRevision(fixture)).toBe(revisionBeforeInvalidDocumentWrites);
    } finally {
      await fixture.dispose();
    }
  });

  itSqliteBound('stores two onboarding templates under one request and enforces native task fields and execution pins', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const store = fixture.store;
      const context = await seedHrContext(store, 'task-templates');
      const taskIds = [
        'projection-completeness-task-welcome',
        'projection-completeness-task-it-setup'
      ] as const;
      const templates = ['hr_welcome', 'it_setup_request'] as const;
      const payload = {
        kind: 'onboarding_tasks_create' as const,
        requestId: context.request.id,
        targets: templates.map((templateId) => ({
          ownerIdentityId: context.managerIdentityId,
          reason: `Synthetic reviewed ${templateId} task.`,
          dueDate: '2026-10-08',
          priority: 'normal' as const,
          templateId
        }))
      };
      const expectedRows = [{
        ref: { table: 'onboarding_requests' as const, id: context.request.id },
        rowVersion: 1,
        state: 'draft'
      }];
      const targets = taskIds.map((id, index) => ({
        targetId: `projection-completeness-target-${index}`,
        ref: { table: 'onboarding_requests' as const, id: context.request.id },
        semanticKey: `onboarding-task:${context.request.lifecycleId}:${templates[index]}`,
        expectedRows,
        ownerIdentityId: context.managerIdentityId,
        expectedEffectRef: { table: 'onboarding_tasks' as const, id },
        expectedEffectVersion: 1
      }));
      const { receipt } = await createPendingExecution(store, context, 'task-templates', payload, targets, expectedRows);
      const taskRows = taskIds.map((id, index) => ({
        id,
        rowVersion: 1,
        requestId: context.request.id,
        employeeId: context.employeeId,
        ownerIdentityId: context.managerIdentityId,
        templateId: templates[index],
        status: 'open',
        title: `Synthetic ${templates[index]} checklist`,
        reason: `Synthetic reviewed ${templates[index]} task.`,
        dueDate: '2026-10-08',
        priority: 'normal',
        executionId: receipt.id,
        createdAt
      }));
      for (const task of taskRows) await insertUnique(store, 'onboarding_tasks', task);

      expect(await Promise.all(taskIds.map((id) => store.workflowProjectionReader.get('onboarding_tasks', id))))
        .toEqual(taskRows.map((task) => ({ id: task.id, rowVersion: 1, body: task })));

      const db = openInspectionDatabase(fixture);
      try {
        expect(db.prepare(`
          SELECT request_id, template_id, due_date, priority, execution_id, execution_contract_version
          FROM onboarding_tasks ORDER BY template_id
        `).all()).toEqual([
          {
            request_id: context.request.id, template_id: 'hr_welcome', due_date: '2026-10-08',
            priority: 'normal', execution_id: receipt.id, execution_contract_version: 2
          },
          {
            request_id: context.request.id, template_id: 'it_setup_request', due_date: '2026-10-08',
            priority: 'normal', execution_id: receipt.id, execution_contract_version: 2
          }
        ]);
      } finally {
        db.close();
      }

      const beforeInvalidWrites = readRevision(fixture);
      const invalidRows = [
        { ...taskRows[0], id: 'projection-completeness-task-invalid-date', dueDate: '2026-02-30', templateId: 'policy_acknowledgement' },
        { ...taskRows[0], id: 'projection-completeness-task-invalid-priority', priority: 'urgent', templateId: 'policy_acknowledgement' },
        { ...taskRows[0], id: 'projection-completeness-task-blank-reason', reason: ' \t ', templateId: 'policy_acknowledgement' },
        { ...taskRows[0], id: 'projection-completeness-task-missing-execution', executionId: 'projection-completeness-absent-execution', templateId: 'policy_acknowledgement' }
      ];
      for (const row of invalidRows) {
        await expect(insertUnique(store, 'onboarding_tasks', row)).rejects.toMatchObject({ code: 'STORAGE' });
        expect(await store.workflowProjectionReader.get('onboarding_tasks', row.id)).toBeUndefined();
      }
      expect(readRevision(fixture)).toBe(beforeInvalidWrites);
      await expect(insertUnique(store, 'onboarding_tasks', {
        ...taskRows[0], id: 'projection-completeness-task-orphan', requestId: 'projection-completeness-missing-request',
        templateId: 'policy_acknowledgement'
      })).rejects.toMatchObject({ code: 'STORAGE' });
      const duplicateTask = {
        ...taskRows[0], id: 'projection-completeness-task-template-duplicate', templateId: 'hr_welcome'
      };
      const revisionBeforeDuplicate = readRevision(fixture);
      const duplicateResult = await insertUnique(store, 'onboarding_tasks', duplicateTask,
        'onboarding_tasks_request_template_unique', {
          requestId: duplicateTask.requestId, templateId: duplicateTask.templateId
        });
      expect(duplicateResult).toEqual({ inserted: false, existing: taskRows[0] });
      expect(await store.workflowProjectionReader.get('onboarding_tasks', duplicateTask.id)).toBeUndefined();
      expect(readRevision(fixture)).toBe(revisionBeforeDuplicate);
    } finally {
      await fixture.dispose();
    }
  });

  itSqliteBound('keeps legacy incident proof unknown and commits escalation event plus source pointer in one guarded transaction', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const store = fixture.store;
      const context = await seedHrContext(store, 'incident-proof');
      const legacyIncident = {
        id: 'projection-completeness-legacy-incident',
        branchId: context.branchId,
        date: '2026-10-01',
        title: 'Legacy synthetic incident',
        kind: 'operations',
        status: 'open',
        startedAt: '2026-10-01T08:00:00.000Z',
        endedAt: null,
        updatedAt: createdAt
      };
      const incident = {
        ...legacyIncident,
        id: 'projection-completeness-fresh-incident',
        title: 'Fresh synthetic incident',
        escalationStage: 'un_escalated',
        escalationLifecycleId: 'projection-completeness-incident-life',
        escalationEventId: null
      };
      await store.transaction(async (tx) => {
        await tx.put('incidents', legacyIncident);
        await tx.put('incidents', incident);
      });

      const db = openInspectionDatabase(fixture);
      try {
        expect(db.prepare(`
          SELECT escalation_stage, escalation_lifecycle_id, escalation_event_id
          FROM incidents WHERE id = ?
        `).get(legacyIncident.id)).toEqual({
          escalation_stage: null, escalation_lifecycle_id: null, escalation_event_id: null
        });
        expect(db.prepare(`
          SELECT escalation_stage, escalation_lifecycle_id, escalation_event_id
          FROM incidents WHERE id = ?
        `).get(incident.id)).toEqual({
          escalation_stage: 'un_escalated', escalation_lifecycle_id: incident.escalationLifecycleId,
          escalation_event_id: null
        });
      } finally {
        db.close();
      }

      await insertUnique(store, 'workflow_teams', {
        id: 'demo_operations', name: 'Synthetic operations team', active: true
      }, 'workflow_teams_name_unique', { name: 'Synthetic operations team' });
      const eventId = 'projection-completeness-incident-event';
      const payload = {
        kind: 'incident_escalate' as const,
        targets: [{
          incidentId: incident.id,
          targetTeamId: 'demo_operations' as const,
          evidenceIds: ['projection-completeness-evidence-01'],
          reason: 'Synthetic reviewed incident escalation.'
        }]
      };
      const expectedRows = [{
        ref: { table: 'incidents' as const, id: incident.id }, rowVersion: 1, state: 'open'
      }];
      const targets = [{
        targetId: 'projection-completeness-incident-target',
        ref: { table: 'incidents' as const, id: incident.id },
        semanticKey: `incident:${incident.id}:${incident.escalationLifecycleId}:team_requested`,
        expectedRows,
        ownerIdentityId: context.managerIdentityId,
        expectedEffectRef: { table: 'incident_escalation_events' as const, id: eventId },
        expectedEffectVersion: 1
      }];
      const { receipt } = await createPendingExecution(store, context, 'incident-proof', payload, targets, expectedRows);
      const event = {
        id: eventId,
        rowVersion: 1,
        incidentId: incident.id,
        teamId: 'demo_operations',
        actorId: context.managerProfileId,
        stage: 'team_requested',
        lifecycleId: incident.escalationLifecycleId,
        executionId: receipt.id,
        reason: 'Synthetic reviewed incident escalation.',
        evidenceIds: ['projection-completeness-evidence-01'],
        createdAt
      };
      await store.workflowTransaction(async (tx) => {
        await tx.insertUnique('incident_escalation_events', event, {
          constraint: 'incident_escalation_lifecycle_stage_unique',
          values: {
            incidentId: incident.id,
            lifecycleId: incident.escalationLifecycleId,
            stage: event.stage
          }
        });
        const result = await tx.compareAndSwap('incidents', incident.id,
          { rowVersion: 1, state: 'open' },
          {
            ...incident,
            rowVersion: 2,
            escalationStage: 'team_requested',
            escalationEventId: event.id,
            updatedAt: '2026-10-03T05:01:00.000Z'
          });
        expect(result.updated).toBe(true);
      });

      expect(await store.workflowProjectionReader.get('incident_escalation_events', event.id)).toEqual({
        id: event.id, rowVersion: 1, body: event
      });
      const escalated = await store.workflowProjectionReader.get<typeof incident & { rowVersion: number }>(
        'incidents', incident.id
      );
      expect(escalated).toMatchObject({
        rowVersion: 2,
        body: {
          escalationStage: 'team_requested',
          escalationLifecycleId: incident.escalationLifecycleId,
          escalationEventId: event.id
        }
      });

      const invalidEvent = {
        ...event,
        id: 'projection-completeness-incident-event-wrong-life',
        lifecycleId: 'projection-completeness-wrong-life'
      };
      await expect(store.workflowTransaction(async (tx) => {
        await tx.insertUnique('workflow_teams', {
          id: 'projection-completeness-rollback-team', name: 'Synthetic rollback probe', active: true
        }, { constraint: 'workflow_teams_name_unique', values: { name: 'Synthetic rollback probe' } });
        await tx.insertUnique('incident_escalation_events', invalidEvent, {
          constraint: 'incident_escalation_lifecycle_stage_unique',
          values: {
            incidentId: invalidEvent.incidentId,
            lifecycleId: invalidEvent.lifecycleId,
            stage: invalidEvent.stage
          }
        });
      })).rejects.toMatchObject({ code: 'STORAGE' });
      expect(await store.workflowProjectionReader.get('workflow_teams', 'projection-completeness-rollback-team'))
        .toBeUndefined();
      expect(await store.workflowProjectionReader.get('incident_escalation_events', invalidEvent.id)).toBeUndefined();

      const unknownExecutionIncident = {
        ...incident,
        id: 'projection-completeness-incident-unknown-execution-source',
        escalationLifecycleId: 'projection-completeness-incident-unknown-execution-life'
      };
      await store.transaction((tx) => tx.put('incidents', unknownExecutionIncident));
      const invalidEvents = [
        {
          ...event,
          id: 'projection-completeness-incident-event-wrong-incident',
          incidentId: legacyIncident.id
        },
        {
          ...event,
          id: 'projection-completeness-incident-event-wrong-stage',
          stage: 'un_escalated'
        },
        {
          ...event,
          id: 'projection-completeness-incident-event-unknown-execution',
          incidentId: unknownExecutionIncident.id,
          lifecycleId: unknownExecutionIncident.escalationLifecycleId,
          executionId: 'projection-completeness-unknown-execution'
        },
        {
          ...event,
          id: 'projection-completeness-incident-event-no-evidence',
          evidenceIds: []
        },
        {
          ...event,
          id: 'projection-completeness-incident-event-duplicate-evidence',
          evidenceIds: ['projection-completeness-evidence-duplicate', 'projection-completeness-evidence-duplicate']
        },
        {
          ...event,
          id: 'projection-completeness-incident-event-invalid-evidence-id',
          evidenceIds: ['projection completeness evidence']
        }
      ];
      for (const invalid of invalidEvents) {
        const revision = readRevision(fixture);
        await expect(insertUnique(store, 'incident_escalation_events', invalid,
          'incident_escalation_lifecycle_stage_unique', {
            incidentId: invalid.incidentId, lifecycleId: invalid.lifecycleId, stage: invalid.stage
          })).rejects.toMatchObject({ code: 'STORAGE' });
        expect(readRevision(fixture)).toBe(revision);
        expect(await store.workflowProjectionReader.get('incident_escalation_events', invalid.id)).toBeUndefined();
      }

      const revisionBeforeWrongAttempt = readRevision(fixture);
      const wrongAttemptReceipt = {
        ...receipt,
        id: 'projection-completeness-execution-wrong-attempt',
        actorId: context.directorProfileId
      };
      await expect(store.workflowTransaction(async (tx) => {
        await tx.insertUnique('workflow_teams', {
          id: 'projection-completeness-attempt-rollback-team',
          name: 'Synthetic attempt rollback probe', active: true
        }, {
          constraint: 'workflow_teams_name_unique',
          values: { name: 'Synthetic attempt rollback probe' }
        });
        await tx.insertUnique('action_executions', wrongAttemptReceipt, {
          constraint: 'action_executions_root_attempt_unique',
          values: { rootId: 'projection-completeness-root-incident-proof', attempt: 1 }
        });
      })).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(readRevision(fixture)).toBe(revisionBeforeWrongAttempt);
      expect(await store.workflowProjectionReader.get('workflow_teams', 'projection-completeness-attempt-rollback-team'))
        .toBeUndefined();
      expect(await store.workflowProjectionReader.get('action_executions', wrongAttemptReceipt.id)).toBeUndefined();
      expect(await store.workflowProjectionReader.get('action_executions', receipt.id))
        .toEqual({ id: receipt.id, rowVersion: 1, body: receipt });

      await expect(store.workflowTransaction(async (tx) => {
        return tx.compareAndSwap('incidents', incident.id, { rowVersion: 1, state: 'open' }, {
          ...escalated!.body,
          rowVersion: 2,
          status: 'resolved'
        });
      })).resolves.toMatchObject({ updated: false });
      await expect(store.transaction((tx) => tx.put('incidents', {
        ...legacyIncident,
        id: incident.id,
        status: 'resolved'
      }))).rejects.toMatchObject({ code: 'STORAGE' });
      expect(await store.workflowProjectionReader.get('incidents', incident.id)).toMatchObject({
        rowVersion: 2,
        body: {
          status: 'open', escalationStage: 'team_requested',
          escalationLifecycleId: incident.escalationLifecycleId, escalationEventId: event.id
        }
      });
    } finally {
      await fixture.dispose();
    }
  });

  itSqliteBound('preserves reviewed empty asset scope and rejects offboarding child assignments owned by another employee', async () => {
    const fixture = await createWorkflowSqliteFixture({ initialize: false });
    try {
      const migrationDb = fixture.openDatabase();
      const legacyCaseId = 'projection-completeness-offboarding-legacy-case';
      const legacyUnknown = {
        id: 'projection-completeness-offboarding-legacy-unknown-scope',
        rowVersion: 1,
        caseId: legacyCaseId,
        purpose: 'legacy_unreviewed',
        status: 'prepared',
        createdAt
      };
      const legacyBodyBytes = JSON.stringify(legacyUnknown);
      try {
        const legacy = seedLegacyV1Sqlite(migrationDb);
        materializeHistoricalWorkflowStage(migrationDb, WORKFLOW_SCOPE_MIGRATION);
        const historicalRows = insertHistoricalV2Rows(migrationDb, legacy, 'scope-offboarding-plan');
        const historicalCase = {
          id: legacyCaseId,
          rowVersion: 1,
          employeeId: legacy.employee.id,
          ownerIdentityId: historicalRows.identity.id,
          status: 'active',
          lifecycleId: 'projection-completeness-offboarding-legacy-lifecycle',
          lastDay: '2026-10-15',
          reason: 'Synthetic historical offboarding case.',
          createdAt,
          updatedAt: createdAt
        };
        migrationDb.prepare(`
          INSERT INTO offboarding_cases (
            id, body, row_version, employee_id, owner_identity_id, status, lifecycle_id, last_day
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(historicalCase.id, JSON.stringify(historicalCase), historicalCase.rowVersion,
          historicalCase.employeeId, historicalCase.ownerIdentityId, historicalCase.status,
          historicalCase.lifecycleId, historicalCase.lastDay);
        migrationDb.prepare(`
          INSERT INTO offboarding_plans (id, body, row_version, case_id, purpose, status)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(legacyUnknown.id, legacyBodyBytes, legacyUnknown.rowVersion, legacyUnknown.caseId,
          legacyUnknown.purpose, legacyUnknown.status);

        const legacyPlanBefore = migrationDb.prepare(
          'SELECT id, body, row_version FROM offboarding_plans WHERE id = ?'
        ).get(legacyUnknown.id) as { id: string; body: string; row_version: number };
        expect(legacyPlanBefore).toEqual({
          id: legacyUnknown.id,
          body: legacyBodyBytes,
          row_version: legacyUnknown.rowVersion
        });
        const revisionBeforeCompletenessUpgrade = (migrationDb.prepare(
          'SELECT revision FROM appmeta WHERE singleton = 1'
        ).get() as { revision: number }).revision;
        applyWorkflowSqliteMigrations(migrationDb);
        expect(migrationDb.prepare(`
          SELECT id, body, row_version, employee_snapshot, asset_assignment_ids
          FROM offboarding_plans WHERE id = ?
        `).get(legacyUnknown.id)).toEqual({
          ...legacyPlanBefore,
          employee_snapshot: null,
          asset_assignment_ids: null
        });
        expect((migrationDb.prepare('SELECT revision FROM appmeta WHERE singleton = 1').get() as { revision: number }).revision)
          .toBe(revisionBeforeCompletenessUpgrade);
        expect(migrationDb.prepare(`
          SELECT plan_id, assignment_id FROM workflow_offboarding_plan_assignments WHERE plan_id = ?
        `).all(legacyUnknown.id)).toEqual([]);
      } finally {
        migrationDb.close();
      }

      const store = fixture.openStore();
      const context = await seedHrContext(store, 'offboarding-scope');
      const secondEmployeeId = 'projection-completeness-second-employee';
      await store.transaction((tx) => tx.put('employees', {
        id: secondEmployeeId, name: 'Synthetic Second Employee', branchId: context.branchId, active: true
      }));

      const primaryAsset = {
        id: 'projection-completeness-primary-asset', assetTag: 'SYN-ASSET-01',
        status: 'assigned', serialNumber: 'SYN-SERIAL-01', kind: 'laptop', model: 'Synthetic Laptop', createdAt
      };
      const secondAsset = {
        id: 'projection-completeness-second-asset', assetTag: 'SYN-ASSET-02',
        status: 'assigned', serialNumber: 'SYN-SERIAL-02', kind: 'laptop', model: 'Synthetic Laptop', createdAt
      };
      await insertUnique(store, 'assets', primaryAsset, 'assets_tag_unique', { assetTag: primaryAsset.assetTag });
      await insertUnique(store, 'assets', secondAsset, 'assets_tag_unique', { assetTag: secondAsset.assetTag });
      const primaryAssignment = {
        id: 'projection-completeness-primary-assignment', rowVersion: 1,
        assetId: primaryAsset.id, employeeId: context.employeeId, status: 'assigned', assignedAt: createdAt
      };
      const otherEmployeeAssignment = {
        id: 'projection-completeness-other-employee-assignment', rowVersion: 1,
        assetId: secondAsset.id, employeeId: secondEmployeeId, status: 'assigned', assignedAt: createdAt
      };
      await insertUnique(store, 'asset_assignments', primaryAssignment);
      await insertUnique(store, 'asset_assignments', otherEmployeeAssignment);

      const offboardingCase = {
        id: 'projection-completeness-offboarding-case',
        employeeId: context.employeeId,
        ownerIdentityId: context.managerIdentityId,
        status: 'active',
        lifecycleId: 'projection-completeness-offboarding-life',
        lastDay: '2026-10-15',
        reason: 'Synthetic reviewed offboarding case.',
        createdAt,
        updatedAt: createdAt
      };
      await insertUnique(store, 'offboarding_cases', offboardingCase);
      const employeeSnapshot = {
        id: context.employeeId, name: 'Synthetic Employee', branchId: context.branchId,
        active: true, rowVersion: 1
      };
      const emptyPlan = {
        id: 'projection-completeness-offboarding-empty-plan',
        rowVersion: 1,
        caseId: offboardingCase.id,
        purpose: 'standard_offboarding',
        status: 'prepared',
        createdAt,
        employeeSnapshot,
        assetAssignmentIds: [] as string[]
      };
      const populatedPlan = {
        ...emptyPlan,
        id: 'projection-completeness-offboarding-populated-plan',
        purpose: 'asset_return',
        assetAssignmentIds: [primaryAssignment.id]
      };
      await insertUnique(store, 'offboarding_plans', emptyPlan);
      await insertUnique(store, 'offboarding_plans', populatedPlan, 'offboarding_plans_case_purpose_unique', {
        caseId: offboardingCase.id, purpose: populatedPlan.purpose
      });

      expect(Object.prototype.hasOwnProperty.call(
        (await store.workflowProjectionReader.get<typeof emptyPlan>('offboarding_plans', emptyPlan.id))?.body ?? {},
        'assetAssignmentIds'
      )).toBe(true);
      const db = openInspectionDatabase(fixture);
      try {
        expect(db.prepare(`
          SELECT plan_id, assignment_id FROM workflow_offboarding_plan_assignments ORDER BY plan_id, assignment_id
        `).all()).toEqual([{ plan_id: populatedPlan.id, assignment_id: primaryAssignment.id }]);
        expect(db.prepare(`
          SELECT body, row_version, employee_snapshot, asset_assignment_ids
          FROM offboarding_plans WHERE id = ?
        `).get(legacyUnknown.id)).toEqual({
          body: legacyBodyBytes,
          row_version: legacyUnknown.rowVersion,
          employee_snapshot: null,
          asset_assignment_ids: null
        });
        expect(db.prepare(`
          SELECT plan_id, assignment_id FROM workflow_offboarding_plan_assignments
          WHERE plan_id = ?
        `).all(legacyUnknown.id)).toEqual([]);
      } finally {
        db.close();
      }

      expect(await store.workflowProjectionReader.get<typeof legacyUnknown>(
        'offboarding_plans', legacyUnknown.id
      )).toEqual({ id: legacyUnknown.id, rowVersion: 1, body: legacyUnknown });
      const revisionBeforeLegacyWrite = readRevision(fixture);
      await expect(store.workflowTransaction((tx) => tx.compareAndSwap(
        'offboarding_plans', legacyUnknown.id,
        { rowVersion: 1, state: 'prepared' },
        {
          ...legacyUnknown,
          rowVersion: 2,
          employeeSnapshot: {
            id: context.employeeId, name: 'Synthetic Employee', branchId: context.branchId,
            active: true, rowVersion: 1
          },
          assetAssignmentIds: []
        }
      ))).rejects.toMatchObject({ code: 'STORAGE' });
      expect(readRevision(fixture)).toBe(revisionBeforeLegacyWrite);

      const mismatchedPlan = {
        ...emptyPlan,
        id: 'projection-completeness-offboarding-mismatched-owner-plan',
        purpose: 'review_mismatch',
        assetAssignmentIds: [otherEmployeeAssignment.id]
      };
      const revision = readRevision(fixture);
      await expect(insertUnique(store, 'offboarding_plans', mismatchedPlan,
        'offboarding_plans_case_purpose_unique', {
          caseId: offboardingCase.id, purpose: mismatchedPlan.purpose
        })).rejects.toMatchObject({ code: 'STORAGE' });
      expect(readRevision(fixture)).toBe(revision);
      expect(await store.workflowProjectionReader.get('offboarding_plans', mismatchedPlan.id)).toBeUndefined();
    } finally {
      await fixture.dispose();
    }
  });

  itSqliteBound('uses native exact opportunityId equality with keyset pagination and rejects unsupported equality fields', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const store = fixture.store;
      const context = await seedHrContext(store, 'scoped-equals');
      const customerIds = ['projection-completeness-customer-a', 'projection-completeness-customer-b'] as const;
      for (const id of customerIds) {
        await insertUnique(store, 'crm_customers', {
          id, ownerIdentityId: context.managerIdentityId, name: `Synthetic ${id}`, status: 'active', createdAt
        });
      }
      const opportunityIds = ['projection-completeness-opportunity-a', 'projection-completeness-opportunity-b'] as const;
      await insertUnique(store, 'crm_opportunities', {
        id: opportunityIds[0], customerId: customerIds[0], ownerIdentityId: context.managerIdentityId,
        title: 'Synthetic opportunity A', stage: 'prospecting', amountSatang: 1000,
        expectedCloseDate: '2026-10-20', createdAt, updatedAt: createdAt
      });
      await insertUnique(store, 'crm_opportunities', {
        id: opportunityIds[1], customerId: customerIds[1], ownerIdentityId: context.managerIdentityId,
        title: 'Synthetic opportunity B', stage: 'prospecting', amountSatang: 1200,
        expectedCloseDate: '2026-10-21', createdAt, updatedAt: createdAt
      });
      const activityRows = [
        { id: 'projection-completeness-activity-a1', opportunityId: opportunityIds[0], summary: 'Synthetic activity 1' },
        { id: 'projection-completeness-activity-a2', opportunityId: opportunityIds[0], summary: 'Synthetic activity 2' },
        { id: 'projection-completeness-activity-b1', opportunityId: opportunityIds[1], summary: 'Synthetic activity 3' }
      ].map((row) => ({
        ...row, rowVersion: 1, ownerIdentityId: null, status: null, occurredAt: createdAt,
        kind: 'note', createdAt
      }));
      for (const row of activityRows) await insertUnique(store, 'crm_activities', row);

      const firstPage = await store.workflowProjectionReader.query<typeof activityRows[number]>({
        kind: 'scoped', table: 'crm_activities', equals: { opportunityId: opportunityIds[0] }, limit: 1
      });
      expect(firstPage).toEqual([{ id: activityRows[0].id, rowVersion: 1, body: activityRows[0] }]);
      const secondPage = await store.workflowProjectionReader.query<typeof activityRows[number]>({
        kind: 'scoped', table: 'crm_activities', equals: { opportunityId: opportunityIds[0] },
        cursor: activityRows[0].id, limit: 1
      });
      expect(secondPage).toEqual([{ id: activityRows[1].id, rowVersion: 1, body: activityRows[1] }]);
      expect(await store.workflowProjectionReader.query({
        kind: 'scoped', table: 'crm_activities', equals: { ownerIdentityId: null }, limit: 10
      })).toHaveLength(3);

      const invalidQueries = [
        { kind: 'scoped', table: 'crm_activities', equals: { unknownColumn: 'x' } },
        { kind: 'scoped', table: 'pending_actions', equals: { targets: [] } },
        { kind: 'scoped', table: 'action_executions', equals: { rootId: 'projection-completeness-root' } },
        { kind: 'scoped', table: 'crm_activities', equals: { opportunityId: null } }
      ] as const;
      for (const query of invalidQueries) {
        await expect(store.workflowProjectionReader.query(query as unknown as WorkflowStorageQuery)).rejects.toThrow();
      }

      const db = openInspectionDatabase(fixture);
      try {
        expect((db.prepare(`PRAGMA index_info('workflow_crm_activities_opportunity_id_lookup')`).all() as Array<{ name: string }>).map((row) => row.name))
          .toEqual(['opportunity_id', 'id']);
        expect(db.prepare('SELECT opportunity_id FROM crm_activities WHERE id = ?').get(activityRows[0].id))
          .toEqual({ opportunity_id: opportunityIds[0] });
      } finally {
        db.close();
      }
    } finally {
      await fixture.dispose();
    }
  });
});
