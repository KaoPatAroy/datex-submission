import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Dashboard, DashboardSpec, Profile } from '../lib/contracts';
import { digest } from '../lib/core/utils';
import { dashboardVersionDigest } from '../lib/workflows/dashboard-access';
import {
  dashboardShareRevokeEventSchema,
  dashboardShareV2Schema,
  pendingActionV2Schema,
  workflowReceiptV2Schema,
  type DashboardShareRevokeEvent,
  type DashboardShareV2,
  type PendingActionV2,
  type WorkflowPayloadV2,
  type WorkflowReceiptV2,
} from '../lib/workflows/contracts';
import { demoWorkflowPolicyV1, getDemoWorkflowPolicyV1Pin } from '../lib/workflows/policy';
import type { ActionTargetRow, WorkflowRootRow } from '../lib/workflows/action-runtime';
import {
  applyWorkflowSqliteMigrations,
  WORKFLOW_ACTION_TARGET_PROVENANCE_MIGRATION,
  workflowMigrationDefinitions,
  type WorkflowMigrationDefinition,
} from '../lib/storage/workflow-sqlite-migrations';
import {
  historicalWorkflowCompletenessDefinitions,
  historicalWorkflowConversationPersistenceDefinitions,
  WORKFLOW_SNAPSHOT_PROOF_REFERENCES_MIGRATION,
  historicalWorkflowSnapshotProofReferenceDefinitions,
} from '../lib/storage/workflow-schema-history';
import { createWorkflowSqliteFixture } from './helpers/workflow-storage';
import { tables } from '../lib/contracts';
import { itSqliteBound } from './helpers/local-pg';

const NOW = '2026-10-04T04:00:00.000Z';
const LATER = '2099-01-01T00:00:00.000Z';
const BRANCH_DATE = '2026-10-04';
const POLICY_PIN = getDemoWorkflowPolicyV1Pin();
const TARGET_REFERENCE_COLUMNS = [
  'branch_id', 'inventory_snapshot_id', 'incident_id', 'employee_id', 'badge_id',
  'dashboard_version_id', 'opportunity_id', 'onboarding_request_id', 'onboarding_document_id',
  'onboarding_event_id', 'offboarding_case_id', 'offboarding_plan_id', 'asset_assignment_id',
  'contract_id', 'policy_document_id', 'investigation_case_id', 'dashboard_share_id',
] as const;
const CHECKPOINT = 'test-only 040002 migration checkpoint';

type ActionCycle = {
  action: PendingActionV2;
  root: WorkflowRootRow;
  receipt: WorkflowReceiptV2;
  targetId: string;
};

type SeededWorkflow = {
  profileId: string;
  recipientProfileId: string;
  sessionId: string;
  conversationId: string;
  orgUnitId: string;
  branchId: string;
  identityId: string;
  recipientIdentityId: string;
  dashboardId: string;
  dashboardVersionId: string;
  caseId: string;
  spec: DashboardSpec;
};

function specFor(branchId: string): DashboardSpec {
  return {
    title: 'Synthetic East dashboard',
    description: 'Reviewed synthetic branch view.',
    scope: { region: 'east', date: BRANCH_DATE, branchIds: [branchId] },
    widgets: [{ type: 'metric', title: 'Net sales', metric: 'net_sales' }],
  };
}

function actionCycle(input: {
  ids: string[];
  actorId: string;
  sessionId: string;
  conversationId: string;
  identityId: string;
  orgUnitId: string;
  branchId: string;
  payload: WorkflowPayloadV2;
  ref: { table: WorkflowReceiptV2['proofs'][number]['ref']['table']; id: string };
  effectRef: { table: WorkflowReceiptV2['proofs'][number]['ref']['table']; id: string };
  expectedRows: PendingActionV2['expectedRows'];
  effectVersion: number;
  observedVersion?: number;
}): ActionCycle {
  const [actionId, rootId, executionId, targetId, turnId] = input.ids;
  if (!actionId || !rootId || !executionId || !targetId || !turnId) {
    throw new Error('Action-cycle fixture requires five explicit identifiers.');
  }
  const target = {
    targetId,
    ref: input.ref,
    semanticKey: 'semantic-' + targetId,
    expectedRows: input.expectedRows,
    ownerIdentityId: input.identityId,
    expectedEffectRef: input.effectRef,
    expectedEffectVersion: input.effectVersion,
  };
  const createdAt = NOW;
  const action = pendingActionV2Schema.parse({
    id: actionId,
    contractVersion: 2,
    actorId: input.actorId,
    sessionId: input.sessionId,
    conversationId: input.conversationId,
    turnId,
    mode: 'scripted_demo',
    modeRevision: 1,
    payload: input.payload,
    payloadHash: digest(input.payload),
    idempotencyKey: digest({ actionId, turnId }),
    targets: [target],
    targetCount: 1,
    expectedRows: input.expectedRows,
    approvedBranchIds: [input.branchId],
    approvedOrgUnitIds: [input.orgUnitId],
    reviewedSnapshotId: null,
    policy: POLICY_PIN,
    packs: [],
    releaseRevision: 'action-target-provenance-test-r1',
    executionMode: 'atomic_local',
    createdAt,
    expiresAt: LATER,
    status: 'pending',
  });
  const receipt = workflowReceiptV2Schema.parse({
    id: executionId,
    actionId,
    contractVersion: 2,
    actorId: input.actorId,
    kind: input.payload.kind,
    outcome: 'verified_success',
    proofs: [{
      targetId,
      ref: input.effectRef,
      outcome: 'verified_success',
      executionId,
      observedRowVersion: input.observedVersion ?? input.effectVersion,
      checkedAt: createdAt,
      mismatchCodes: [],
    }],
    createdAt,
    verifiedAt: createdAt,
    currentStates: [],
  });
  const root: WorkflowRootRow = {
    id: rootId,
    rowVersion: 1,
    actorId: input.actorId,
    idempotencyKey: action.idempotencyKey,
    actionId,
    activeExecutionId: executionId,
    status: 'open',
    createdAt,
  };
  return { action, root, receipt, targetId };
}

async function insertActionCycle(
  store: Awaited<ReturnType<typeof createWorkflowSqliteFixture>>['store'],
  cycle: ActionCycle,
): Promise<void> {
  const pendingReceipt = workflowReceiptV2Schema.parse({
    ...cycle.receipt, outcome: 'pending', proofs: [], verifiedAt: null,
  });
  await store.workflowTransaction(async tx => {
    await tx.insertUnique('pending_actions', cycle.action, {
      constraint: 'pending_actions_primary_key', values: { id: cycle.action.id },
    });
    await tx.insertUnique('action_idempotency_roots', cycle.root, {
      constraint: 'action_idempotency_roots_key_unique',
      values: { idempotencyKey: cycle.root.idempotencyKey },
    });
    await tx.insertUnique('action_executions', pendingReceipt, {
      constraint: 'action_executions_root_attempt_unique',
      values: { rootId: cycle.root.id, attempt: 1 },
    });
  });
  await store.workflowTransaction(async tx => {
    const changed = await tx.compareAndSwap('action_executions', cycle.receipt.id,
      { rowVersion: 1, state: 'pending' }, { ...cycle.receipt, rowVersion: 2 });
    if (!changed.updated) throw new Error('The synthetic pending receipt did not transition to verified success.');
  });
}

type CreatorReceiptMutation = 'target_id_mismatch' | 'numeric_actor' | 'numeric_ref_id' | 'numeric_execution_id' | 'non_integer_contract_version';

async function insertCorruptedCreatorCycle(
  store: Awaited<ReturnType<typeof createWorkflowSqliteFixture>>['store'],
  raw: Database.Database,
  cycle: ActionCycle,
  mutation: CreatorReceiptMutation,
): Promise<void> {
  const root = { ...cycle.root, activeExecutionId: null };
  await store.workflowTransaction(async tx => {
    await tx.insertUnique('pending_actions', cycle.action, {
      constraint: 'pending_actions_primary_key', values: { id: cycle.action.id },
    });
    await tx.insertUnique('action_idempotency_roots', root, {
      constraint: 'action_idempotency_roots_key_unique', values: { idempotencyKey: root.idempotencyKey },
    });
  });

  const malformed = structuredClone(cycle.receipt) as unknown as Record<string, unknown>;
  const proof = (malformed.proofs as Array<Record<string, unknown>>)[0];
  if (!proof) throw new Error('Creator receipt fixture omitted its proof.');
  let serializedBody: string | undefined;
  switch (mutation) {
    case 'target_id_mismatch':
      proof.targetId = 'different-creator-target';
      break;
    case 'numeric_actor':
      malformed.actorId = 17;
      break;
    case 'numeric_ref_id':
      (proof.ref as Record<string, unknown>).id = 17;
      break;
    case 'numeric_execution_id':
      proof.executionId = 17;
      break;
    case 'non_integer_contract_version':
      serializedBody = JSON.stringify(malformed).replace('"contractVersion":2', '"contractVersion":2.0');
      break;
  }
  const definition = workflowMigrationDefinitions().find(candidate => candidate.table === 'action_executions');
  if (!definition) throw new Error('Current workflow descriptor omitted action executions.');
  const pending = { ...malformed, outcome: 'pending', proofs: [], verifiedAt: null };
  const pendingBody = mutation === 'non_integer_contract_version'
    ? JSON.stringify(pending).replace('"contractVersion":2', '"contractVersion":2.0')
    : JSON.stringify(pending);
  const terminalBody = serializedBody ?? JSON.stringify(malformed);
  insertProjectedBody(raw, definition, pending, { root_id: root.id, attempt: 1 }, pendingBody);
  raw.prepare('UPDATE action_executions SET payload=?,row_version=2,outcome=? WHERE id=?')
    .run(terminalBody, 'verified_success', cycle.receipt.id);
  await store.workflowTransaction(async tx => {
    const changed = await tx.compareAndSwap('action_idempotency_roots', root.id,
      { rowVersion: 1, state: 'open' }, { ...root, rowVersion: 2, activeExecutionId: cycle.receipt.id });
    if (!changed.updated) throw new Error('Synthetic creator execution root did not attach.');
  });
}

async function seedCurrentWorkflow(store: Awaited<ReturnType<typeof createWorkflowSqliteFixture>>['store'], suffix: string): Promise<SeededWorkflow> {
  const profileId = 'prov-profile-' + suffix;
  const recipientProfileId = 'prov-recipient-profile-' + suffix;
  const sessionId = 'prov-session-' + suffix;
  const conversationId = 'prov-conversation-' + suffix;
  const orgUnitId = 'prov-org-' + suffix;
  const branchId = 'prov-branch-' + suffix;
  const identityId = 'prov-identity-' + suffix;
  const recipientIdentityId = 'prov-recipient-identity-' + suffix;
  const dashboardId = 'prov-dashboard-' + suffix;
  const dashboardVersionId = 'prov-dashboard-version-' + suffix;
  const caseId = 'prov-case-' + suffix;
  const spec = specFor(branchId);
  const owner: Profile = {
    id: profileId, name: 'Synthetic provenance owner', role: 'executive', active: true,
    permissions: ['sales.read', 'operations.read'], regions: ['east'],
  };
  const recipient: Profile = {
    id: recipientProfileId, name: 'Synthetic provenance recipient', role: 'east_manager', active: true,
    permissions: ['sales.read', 'operations.read'], regions: ['east'],
  };
  const dashboard: Dashboard = {
    id: dashboardId, ownerId: profileId, spec, packs: [], createdAt: NOW, updatedAt: NOW,
    lastRefreshAt: NOW, sourceMetadata: [], analysis: null, evidenceVersion: 'synthetic-evidence-v1',
  };
  const dashboardVersionWithoutDigest = {
    id: dashboardVersionId, dashboardId, version: 1, ownerId: profileId, createdAt: NOW,
    spec, packs: [], sourceMetadata: [], analysis: null, evidenceVersion: 'synthetic-evidence-v1',
  };
  const dashboardVersion = {
    ...dashboardVersionWithoutDigest,
    digest: dashboardVersionDigest(dashboardVersionWithoutDigest),
  };
  await store.workflowTransaction(tx => tx.insertUnique('org_units', {
    id: orgUnitId, parentOrgUnitId: null, name: 'Synthetic provenance org ' + suffix,
    active: true, rowVersion: 1,
  }, { constraint: 'org_units_primary_key', values: { id: orgUnitId } }).then(() => undefined));
  await store.transaction(async tx => {
    await tx.put('profiles', owner);
    await tx.put('profiles', recipient);
    await tx.put('sessions', {
      id: sessionId, profileId, mode: 'scripted_demo', modeRevision: 1,
      csrfToken: 'synthetic-csrf-' + suffix, expiresAt: LATER, createdAt: NOW,
    });
    await tx.put('branches', {
      id: branchId, name: 'Synthetic East branch', region: 'east', orgUnitId, active: true,
    });
    await tx.put('dashboards', dashboard);
  });
  await store.workflowTransaction(async tx => {
    const identity = {
      id: identityId, profileId, displayName: owner.name, active: true, role: 'executive' as const,
      department: 'sales_operations' as const, orgUnitId, managerIdentityId: null,
      verifiedDemoEmail: 'owner-' + suffix + '@example.invalid', slackIdentity: 'owner-' + suffix,
      allowedChannels: ['simulated_email'] as const, classificationCeiling: 'internal' as const, rowVersion: 1,
    };
    const recipientIdentity = {
      id: recipientIdentityId, profileId: recipientProfileId, displayName: recipient.name, active: true,
      role: 'east_manager' as const, department: 'sales_operations' as const, orgUnitId, managerIdentityId: null,
      verifiedDemoEmail: 'recipient-' + suffix + '@example.invalid', slackIdentity: 'recipient-' + suffix,
      allowedChannels: ['simulated_email'] as const, classificationCeiling: 'internal' as const, rowVersion: 1,
    };
    await tx.insertUnique('directory_identities', identity, {
      constraint: 'directory_identities_primary_key', values: { id: identityId },
    });
    await tx.insertUnique('directory_identities', recipientIdentity, {
      constraint: 'directory_identities_primary_key', values: { id: recipientIdentityId },
    });
    await tx.insertUnique('workflow_policies', {
      id: POLICY_PIN.id, version: POLICY_PIN.version, digest: POLICY_PIN.digest, policy: demoWorkflowPolicyV1,
    }, { constraint: 'workflow_policies_primary_key', values: { id: POLICY_PIN.id } });
    await tx.insertUnique('conversations', {
      id: conversationId, actorId: profileId, title: 'Synthetic provenance test', pinned: false,
      archivedAt: null, rowVersion: 1, createdAt: NOW, updatedAt: NOW, lastScope: null, lastDashboardId: null,
    }, { constraint: 'conversations_primary_key', values: { id: conversationId } });
    await tx.insertUnique('dashboard_versions', dashboardVersion, {
      constraint: 'dashboard_versions_dashboard_version_unique', values: { dashboardId, version: 1 },
    });
    await tx.insertUnique('investigation_cases', {
      id: caseId, rowVersion: 1, branchId, ownerIdentityId: identityId, status: 'open',
      businessDate: BRANCH_DATE, dueDate: '2026-10-06', reason: 'Synthetic source case.',
      priority: 'normal', sourceIds: ['source-' + suffix], unansweredQuestion: 'Which movement explains the gap?',
      lifecycleId: 'case-lifecycle-' + suffix,
    }, { constraint: 'investigation_cases_primary_key', values: { id: caseId } });
  });
  return {
    profileId, recipientProfileId, sessionId, conversationId, orgUnitId, branchId,
    identityId, recipientIdentityId, dashboardId, dashboardVersionId, caseId, spec,
  };
}

function shareCreationCycle(seed: SeededWorkflow, suffix: string, shareId: string): ActionCycle {
  const targetId = 'share-create-target-' + suffix;
  const payload: WorkflowPayloadV2 = {
    kind: 'dashboard_share', dashboardId: seed.dashboardId, recipientIdentityId: seed.recipientIdentityId,
    channel: 'simulated_email', subject: 'Synthetic review', body: 'Please review the synthetic dashboard.',
  };
  return actionCycle({
    ids: ['share-create-action-' + suffix, 'share-create-root-' + suffix, 'share-create-exec-' + suffix, targetId, 'share-create-turn-' + suffix],
    actorId: seed.profileId, sessionId: seed.sessionId, conversationId: seed.conversationId,
    identityId: seed.identityId, orgUnitId: seed.orgUnitId, branchId: seed.branchId, payload,
    ref: { table: 'dashboard_versions', id: seed.dashboardVersionId },
    effectRef: { table: 'dashboard_shares', id: shareId },
    expectedRows: [
      { ref: { table: 'dashboard_versions', id: seed.dashboardVersionId }, rowVersion: 1, state: null },
      { ref: { table: 'branches', id: seed.branchId }, rowVersion: 1, state: 'active' },
    ],
    effectVersion: 1,
  });
}

function shareBody(seed: SeededWorkflow, cycle: ActionCycle, shareId: string, semanticKey: string, status: 'active' | 'revoked' = 'active'): DashboardShareV2 {
  return dashboardShareV2Schema.parse({
    id: shareId, dashboardId: seed.dashboardId, dashboardVersionId: seed.dashboardVersionId,
    senderIdentityId: seed.identityId, recipientIdentityId: seed.recipientIdentityId,
    approvedBranchIds: [seed.branchId], classification: 'internal', verificationDigest: 'e'.repeat(64),
    keyVersion: 1, channel: 'simulated_email', policy: POLICY_PIN, status,
    expiresAt: LATER, rowVersion: status === 'revoked' ? 2 : 1, semanticKey,
    executionId: cycle.receipt.id, createdAt: NOW, revokedAt: status === 'revoked' ? NOW : null,
  });
}

function shareRevokeCycle(seed: SeededWorkflow, suffix: string, share: DashboardShareV2, observedVersion = 2): ActionCycle {
  const targetId = 'share-revoke-target-' + suffix;
  const payload: WorkflowPayloadV2 = { kind: 'dashboard_share_revoke', shareId: share.id };
  return actionCycle({
    ids: ['share-revoke-action-' + suffix, 'share-revoke-root-' + suffix, 'share-revoke-exec-' + suffix, targetId, 'share-revoke-turn-' + suffix],
    actorId: seed.profileId, sessionId: seed.sessionId, conversationId: seed.conversationId,
    identityId: seed.identityId, orgUnitId: seed.orgUnitId, branchId: seed.branchId, payload,
    ref: { table: 'dashboard_shares', id: share.id },
    effectRef: { table: 'dashboard_shares', id: share.id },
    expectedRows: [{ ref: { table: 'dashboard_shares', id: share.id }, rowVersion: 1, state: 'active' }],
    effectVersion: 2, observedVersion,
  });
}

function shareRevokeEvent(seed: Pick<SeededWorkflow, 'profileId'>, share: DashboardShareV2, cycle: ActionCycle, suffix: string): DashboardShareRevokeEvent {
  return dashboardShareRevokeEventSchema.parse({
    id: 'share-revoke-event-' + suffix,
    shareId: share.id,
    actorId: seed.profileId,
    executionId: cycle.receipt.id,
    shareCreationExecutionId: share.executionId,
    priorShareRowVersion: 1,
    revokedShareRowVersion: 2,
    createdAt: NOW,
    rowVersion: 1,
  });
}

function rawRevokeShareAndInsertEvent(
  db: Database.Database,
  share: DashboardShareV2,
  event: DashboardShareRevokeEvent,
): void {
  const definition = workflowMigrationDefinitions().find(candidate => candidate.table === 'dashboard_share_revoke_events');
  if (!definition) throw new Error('Current workflow descriptor omitted dashboard share revoke events.');
  db.exec('BEGIN IMMEDIATE');
  try {
    const revoked = { ...share, rowVersion: 2, status: 'revoked' as const, revokedAt: NOW };
    db.prepare('UPDATE dashboard_shares SET payload=?,row_version=2,status=? WHERE id=?')
      .run(JSON.stringify(revoked), 'revoked', share.id);
    insertProjectedBody(db, definition, event as unknown as Record<string, unknown>);
    db.exec('COMMIT');
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

function shareTargetRow(share: DashboardShareV2, cycle: ActionCycle): ActionTargetRow {
  return {
    id: 'action-target-share-' + share.id, rowVersion: 1, executionId: cycle.receipt.id,
    targetId: cycle.targetId, entityType: 'dashboard_shares',
    ref: { table: 'dashboard_shares', id: share.id }, expectedRowVersion: 1,
    expectedState: 'active', targetStatus: 'pending',
  };
}

function caseCycle(seed: SeededWorkflow, suffix: string): ActionCycle {
  const targetId = 'case-target-' + suffix;
  const payload: WorkflowPayloadV2 = {
    kind: 'investigation_create', businessDate: BRANCH_DATE,
    targets: [{
      ownerIdentityId: seed.identityId, reason: 'Review the synthetic case.',
      dueDate: '2026-10-06', priority: 'normal', branchId: seed.branchId,
      caseId: seed.caseId, sourceIds: ['source-' + suffix],
      unansweredQuestion: 'Which movement explains the gap?',
    }],
  };
  return actionCycle({
    ids: ['case-action-' + suffix, 'case-root-' + suffix, 'case-exec-' + suffix, targetId, 'case-turn-' + suffix],
    actorId: seed.profileId, sessionId: seed.sessionId, conversationId: seed.conversationId,
    identityId: seed.identityId, orgUnitId: seed.orgUnitId, branchId: seed.branchId, payload,
    ref: { table: 'investigation_cases', id: seed.caseId },
    effectRef: { table: 'investigation_cases', id: seed.caseId },
    expectedRows: [], effectVersion: 1,
  });
}

function caseTargetRow(seed: SeededWorkflow, cycle: ActionCycle): ActionTargetRow {
  return {
    id: 'action-target-case-' + seed.caseId, rowVersion: 1, executionId: cycle.receipt.id,
    targetId: cycle.targetId, entityType: 'investigation_cases',
    ref: { table: 'investigation_cases', id: seed.caseId }, expectedRowVersion: 1,
    expectedState: 'open', targetStatus: 'pending',
  };
}

function nestedValue(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    return Reflect.get(current, key);
  }, value);
}

function sqlValue(value: unknown, type: string): string | number | null {
  if (value === undefined || value === null) return null;
  if (type === 'boolean') return value === true ? 1 : value === false ? 0 : null;
  if (type === 'json') return JSON.stringify(value);
  return typeof value === 'string' || typeof value === 'number' ? value : null;
}

function insertProjectedBody(
  db: Database.Database,
  definition: WorkflowMigrationDefinition,
  body: Record<string, unknown>,
  external: Record<string, string | number> = {},
  serializedBody?: string,
): void {
  const physical = db.prepare('PRAGMA table_xinfo(\"' + definition.table + '\")').all() as Array<{ name: string; hidden: number }>;
  const values = new Map<string, string | number | null>([
    ['id', String(body.id)],
    [definition.bodyColumn, serializedBody ?? JSON.stringify(body)],
    ['row_version', typeof body.rowVersion === 'number' ? body.rowVersion : 1],
  ]);
  if (definition.markerColumn) values.set(definition.markerColumn, 2);
  for (const column of definition.columns) {
    if (column.external) {
      const value = external[column.column] ?? nestedValue(body, column.bodyField);
      if (value !== undefined && value !== null) values.set(column.column, value as string | number);
      continue;
    }
    if (column.legacyOnly) continue;
    const relation = definition.foreignKeys.find(item => item.column === column.column);
    const field = relation?.bodyField ?? column.bodyField;
    const taggedOut = relation?.tagField !== undefined &&
      nestedValue(body, relation.tagField) !== (relation.tagValue ?? relation.target);
    values.set(column.column, sqlValue(taggedOut ? null : nestedValue(body, field), column.type));
  }
  for (const relation of definition.foreignKeys) {
    if (values.has(relation.column)) continue;
    const field = relation.bodyField ?? relation.column.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
    const taggedOut = relation.tagField !== undefined &&
      nestedValue(body, relation.tagField) !== (relation.tagValue ?? relation.target);
    values.set(relation.column, sqlValue(taggedOut ? null : nestedValue(body, field), 'text'));
  }
  for (const [column, value] of Object.entries(external)) values.set(column, value);
  const insertColumns = physical.filter(column => column.hidden === 0 && values.has(column.name)).map(column => column.name);
  const names = insertColumns.map(column => '\"' + column + '\"').join(', ');
  const placeholders = insertColumns.map(() => '?').join(', ');
  db.prepare('INSERT INTO \"' + definition.table + '\" (' + names + ') VALUES (' + placeholders + ')')
    .run(...insertColumns.map(column => values.get(column)!));
}

function materialize040002(db: Database.Database): void {
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
                  if (parameters[0] === WORKFLOW_SNAPSHOT_PROOF_REFERENCES_MIGRATION) {
                    target.exec('COMMIT');
                    checkpointed = true;
                    throw new Error(CHECKPOINT);
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
    if (!checkpointed || !(cause instanceof Error) || !cause.message.startsWith(CHECKPOINT)) throw error;
  }
  if (!checkpointed) throw new Error('SQLite migration did not stop after 040002.');
}

function makeHistoricalRows(suffix: string) {
  const profileId = 'old-profile-' + suffix;
  const recipientProfileId = 'old-recipient-profile-' + suffix;
  const sessionId = 'old-session-' + suffix;
  const conversationId = 'old-conversation-' + suffix;
  const orgUnitId = 'old-org-' + suffix;
  const branchId = 'old-branch-' + suffix;
  const identityId = 'old-identity-' + suffix;
  const recipientIdentityId = 'old-recipient-identity-' + suffix;
  const dashboardId = 'old-dashboard-' + suffix;
  const versionId = 'old-dashboard-version-' + suffix;
  const spec = specFor(branchId);
  const creator = actionCycle({
    ids: ['old-create-action-' + suffix, 'old-create-root-' + suffix, 'old-unrelated-exec-' + suffix,
      'old-create-target-' + suffix, 'old-create-turn-' + suffix],
    actorId: profileId, sessionId, conversationId, identityId, orgUnitId, branchId,
    payload: { kind: 'dashboard_create', spec },
    ref: { table: 'dashboard_versions', id: versionId },
    effectRef: { table: 'dashboards', id: dashboardId },
    expectedRows: [{ ref: { table: 'dashboard_versions', id: versionId }, rowVersion: 1, state: null }],
    effectVersion: 1,
  });
  const owner: Profile = {
    id: profileId, name: 'Historical synthetic owner', role: 'executive', active: true, permissions: [], regions: ['east'],
  };
  const recipient: Profile = {
    id: recipientProfileId, name: 'Historical synthetic recipient', role: 'east_manager', active: true,
    permissions: [], regions: ['east'],
  };
  const identity = {
    id: identityId, profileId, displayName: owner.name, active: true, role: 'executive',
    department: 'sales_operations', orgUnitId, managerIdentityId: null,
    verifiedDemoEmail: 'historical-owner-' + suffix + '@example.invalid', slackIdentity: null,
    allowedChannels: ['simulated_email'], classificationCeiling: 'internal', rowVersion: 1,
  };
  const recipientIdentity = {
    id: recipientIdentityId, profileId: recipientProfileId, displayName: recipient.name, active: true,
    role: 'east_manager', department: 'sales_operations', orgUnitId, managerIdentityId: null,
    verifiedDemoEmail: 'historical-recipient-' + suffix + '@example.invalid', slackIdentity: null,
    allowedChannels: ['simulated_email'], classificationCeiling: 'internal', rowVersion: 1,
  };
  const dashboardVersionWithoutDigest = {
    id: versionId, dashboardId, version: 1, ownerId: profileId, createdAt: NOW,
    spec, packs: [], sourceMetadata: [], analysis: null, evidenceVersion: 'old-evidence-v1',
  };
  const dashboardVersion = {
    ...dashboardVersionWithoutDigest,
    digest: dashboardVersionDigest(dashboardVersionWithoutDigest),
  };
  const dashboard = {
    id: dashboardId, ownerId: profileId, spec, packs: [], createdAt: NOW, updatedAt: NOW,
    lastRefreshAt: NOW, sourceMetadata: [], analysis: null, evidenceVersion: 'old-evidence-v1',
  };
  const activeShare: DashboardShareV2 = dashboardShareV2Schema.parse({
    id: 'old-active-share-' + suffix, dashboardId, dashboardVersionId: versionId,
    senderIdentityId: identityId, recipientIdentityId, approvedBranchIds: [branchId],
    classification: 'internal', verificationDigest: 'f'.repeat(64), keyVersion: 1,
    channel: 'simulated_email', policy: POLICY_PIN, status: 'active', expiresAt: LATER,
    rowVersion: 1, semanticKey: 'old-active-semantic-' + suffix,
    executionId: creator.receipt.id, createdAt: NOW, revokedAt: null,
  });
  const revokedShare: DashboardShareV2 = dashboardShareV2Schema.parse({
    ...activeShare,
    id: 'old-revoked-share-' + suffix,
    status: 'revoked',
    rowVersion: 2,
    semanticKey: 'old-revoked-semantic-' + suffix,
    revokedAt: NOW,
  });
  const oldTarget: ActionTargetRow = {
    id: 'old-action-target-' + suffix, rowVersion: 1, executionId: creator.receipt.id,
    targetId: creator.targetId, entityType: 'dashboard_versions',
    ref: { table: 'dashboard_versions', id: versionId }, expectedRowVersion: 1,
    expectedState: null, targetStatus: 'pending',
  };
  return {
    suffix, profileId, recipientProfileId, sessionId, conversationId, orgUnitId, branchId,
    identityId, recipientIdentityId, dashboardId, versionId, creator, owner, recipient,
    identity, recipientIdentity, dashboard, dashboardVersion, activeShare, revokedShare, oldTarget,
  };
}

function insertHistoricalRows(db: Database.Database, suffix: string) {
  const rows = makeHistoricalRows(suffix);
  const full040002Definitions = historicalWorkflowCompletenessDefinitions.map(definition =>
    historicalWorkflowConversationPersistenceDefinitions.find(candidate => candidate.table === definition.table)
    ?? historicalWorkflowSnapshotProofReferenceDefinitions.find(candidate => candidate.table === definition.table)
    ?? definition);
  const definitions = new Map(full040002Definitions.map(definition => [definition.table, definition]));
  const insert = (table: string, body: Record<string, unknown>, external: Record<string, string | number> = {}) => {
    const definition = definitions.get(table as WorkflowMigrationDefinition['table']);
    if (!definition) throw new Error('Missing 040002 descriptor for ' + table);
    insertProjectedBody(db, definition, body, external);
  };
  db.exec('BEGIN IMMEDIATE');
  try {
    insert('profiles', rows.owner as unknown as Record<string, unknown>);
    insert('profiles', rows.recipient as unknown as Record<string, unknown>);
    insert('sessions', {
      id: rows.sessionId, profileId: rows.profileId, mode: 'scripted_demo', modeRevision: 1,
      csrfToken: 'historical-csrf-' + suffix, expiresAt: LATER, createdAt: NOW, rowVersion: 1,
    });
    insert('org_units', { id: rows.orgUnitId, parentOrgUnitId: null, name: 'Historical org ' + suffix, active: true, rowVersion: 1 });
    insert('branches', { id: rows.branchId, name: 'Historical East branch', region: 'east', orgUnitId: rows.orgUnitId, active: true, rowVersion: 1 });
    insert('directory_identities', rows.identity as unknown as Record<string, unknown>);
    insert('directory_identities', rows.recipientIdentity as unknown as Record<string, unknown>);
    insert('workflow_policies', {
      id: POLICY_PIN.id, version: POLICY_PIN.version, digest: POLICY_PIN.digest, policy: demoWorkflowPolicyV1,
    });
    insert('conversations', {
      id: rows.conversationId, actorId: rows.profileId, title: 'Historical provenance test', pinned: false,
      pinnedAt: null, archivedAt: null, rowVersion: 1, createdAt: NOW, updatedAt: NOW,
      lastScope: null, lastDashboardId: null,
    });
    insert('dashboards', rows.dashboard as unknown as Record<string, unknown>);
    insert('dashboard_versions', rows.dashboardVersion as unknown as Record<string, unknown>);
    insert('pending_actions', rows.creator.action as unknown as Record<string, unknown>);
    insert('action_idempotency_roots', rows.creator.root as unknown as Record<string, unknown>);
    const pendingReceipt = workflowReceiptV2Schema.parse({
      ...rows.creator.receipt, outcome: 'pending', proofs: [], verifiedAt: null,
    });
    insert('action_executions', pendingReceipt as unknown as Record<string, unknown>, {
      root_id: rows.creator.root.id, attempt: 1,
    });
    db.prepare('UPDATE action_executions SET payload=?,row_version=2,outcome=? WHERE id=?')
      .run(JSON.stringify(rows.creator.receipt), 'verified_success', rows.creator.receipt.id);
    insert('dashboard_shares', rows.activeShare as unknown as Record<string, unknown>);
    const priorRevokedShare = { ...rows.revokedShare, status: 'active' as const, rowVersion: 1, revokedAt: null };
    insert('dashboard_shares', priorRevokedShare as unknown as Record<string, unknown>);
    db.prepare('UPDATE dashboard_shares SET payload=?,row_version=2,status=? WHERE id=?')
      .run(JSON.stringify(rows.revokedShare), 'revoked', rows.revokedShare.id);
    insert('action_targets', rows.oldTarget as unknown as Record<string, unknown>);
    db.exec('COMMIT');
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw error;
  }
  return rows;
}

async function createPopulated040002Fixture(suffix: string) {
  const fixture = await createWorkflowSqliteFixture({ initialize: false });
  const db = fixture.openDatabase();
  try {
    for (const table of tables) db.exec('CREATE TABLE \"' + table + '\" (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL)');
    db.exec('CREATE TABLE appmeta (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), revision INTEGER NOT NULL)');
    db.prepare('INSERT INTO appmeta (singleton, revision) VALUES (1, 41)').run();
    materialize040002(db);
    const rows = insertHistoricalRows(db, suffix);
    return { fixture, db, rows };
  } catch (error) {
    db.close();
    await fixture.dispose();
    throw error;
  }
}

function ledgerRows(db: Database.Database): Array<{ id: string; digest: string }> {
  return db.prepare('SELECT id,digest FROM workflow_schema_migrations ORDER BY id').all() as Array<{ id: string; digest: string }>;
}

function storedRows(db: Database.Database, rows: ReturnType<typeof makeHistoricalRows>) {
  return {
    activeShare: db.prepare('SELECT id,payload,row_version FROM dashboard_shares WHERE id=?').get(rows.activeShare.id),
    revokedShare: db.prepare('SELECT id,payload,row_version FROM dashboard_shares WHERE id=?').get(rows.revokedShare.id),
    target: db.prepare('SELECT id,body,row_version FROM action_targets WHERE id=?').get(rows.oldTarget.id),
  };
}

function shareCycleForHistorical(seed: ReturnType<typeof makeHistoricalRows>): ActionCycle {
  return actionCycle({
    ids: ['unsafe-revoke-action-' + seed.suffix, 'unsafe-revoke-root-' + seed.suffix,
      'unsafe-revoke-exec-' + seed.suffix, 'unsafe-revoke-target-' + seed.suffix, 'unsafe-revoke-turn-' + seed.suffix],
    actorId: seed.profileId, sessionId: seed.sessionId, conversationId: seed.conversationId,
    identityId: seed.identityId, orgUnitId: seed.orgUnitId, branchId: seed.branchId,
    payload: { kind: 'dashboard_share_revoke', shareId: seed.activeShare.id },
    ref: { table: 'dashboard_shares', id: seed.activeShare.id },
    effectRef: { table: 'dashboard_shares', id: seed.activeShare.id },
    expectedRows: [{ ref: { table: 'dashboard_shares', id: seed.activeShare.id }, rowVersion: 1, state: 'active' }],
    effectVersion: 2,
  });
}

describe('SQLite action-target provenance migration', () => {
  itSqliteBound('preserves populated 040002 rows, quarantines only historical revokes, and rejects a revoke pinned to an unrelated V2 receipt', async () => {
    const suffix = 'migration-' + randomUUID().replaceAll('-', '');
    const { fixture, db, rows } = await createPopulated040002Fixture(suffix);
    try {
      const oldRows = storedRows(db, rows);
      const oldLedger = ledgerRows(db);
      const oldRevision = (db.prepare('SELECT revision FROM appmeta WHERE singleton=1').get() as { revision: number }).revision;
      applyWorkflowSqliteMigrations(db);
      const migratedRows = storedRows(db, rows);
      expect(migratedRows).toEqual(oldRows);
      expect((db.prepare('SELECT revision FROM appmeta WHERE singleton=1').get() as { revision: number }).revision).toBe(oldRevision);
      const ledgerById = new Map(ledgerRows(db).map(entry => [entry.id, entry.digest]));
      expect(ledgerById.get(WORKFLOW_SNAPSHOT_PROOF_REFERENCES_MIGRATION)).toBe(
        oldLedger.find(entry => entry.id === WORKFLOW_SNAPSHOT_PROOF_REFERENCES_MIGRATION)?.digest,
      );
      expect(ledgerById.has(WORKFLOW_ACTION_TARGET_PROVENANCE_MIGRATION)).toBe(true);
      expect(db.prepare('SELECT pre_migration_revoke_quarantined FROM dashboard_shares WHERE id=?')
        .get(rows.activeShare.id)).toMatchObject({ pre_migration_revoke_quarantined: 0 });
      expect(db.prepare('SELECT pre_migration_revoke_quarantined FROM dashboard_shares WHERE id=?')
        .get(rows.revokedShare.id)).toMatchObject({ pre_migration_revoke_quarantined: 1 });
      applyWorkflowSqliteMigrations(db);
      expect(storedRows(db, rows)).toEqual(oldRows);
      expect(ledgerRows(db)).toEqual(expect.arrayContaining(oldLedger));
      expect((db.prepare('SELECT revision FROM appmeta WHERE singleton=1').get() as { revision: number }).revision).toBe(oldRevision);
      db.close();

      const store = fixture.openStore();
      const revoke = shareCycleForHistorical(rows);
      await insertActionCycle(store, revoke);
      const event = shareRevokeEvent({ profileId: rows.profileId }, rows.activeShare, revoke, suffix);
      const raw = fixture.openDatabase();
      try {
        applyWorkflowSqliteMigrations(raw);
        expect(() => rawRevokeShareAndInsertEvent(raw, rows.activeShare, event))
          .toThrow(/Invalid workflow relationship/);
      } finally {
        raw.close();
      }
      expect(await store.workflowProjectionReader.get<DashboardShareV2>('dashboard_shares', rows.activeShare.id))
        .toMatchObject({ rowVersion: 1, body: rows.activeShare });
      expect(await store.workflowProjectionReader.get('dashboard_share_revoke_events', event.id)).toBeUndefined();
    } finally {
      await fixture.dispose();
    }
  });

  itSqliteBound('round-trips source refs and commits a share revoke only with its exact append-only event', async () => {
    const fixture = await createWorkflowSqliteFixture();
    const suffix = 'fresh-' + randomUUID().replaceAll('-', '');
    const raw = fixture.openDatabase();
    try {
      applyWorkflowSqliteMigrations(raw);
      const store = fixture.store;
      const seed = await seedCurrentWorkflow(store, suffix);
      const shareId = 'prov-share-' + suffix;
      const creator = shareCreationCycle(seed, suffix, shareId);
      await insertActionCycle(store, creator);
      const share = shareBody(seed, creator, shareId, 'prov-share-semantic-' + suffix);
      await store.workflowTransaction(tx => tx.insertUnique('dashboard_shares', share, {
        constraint: 'dashboard_shares_semantic_unique', values: { semanticKey: share.semanticKey },
      }).then(result => {
        if (!result.inserted) throw new Error('The synthetic share already existed.');
      }));

      const forgedShare = shareBody(seed, creator, 'prov-forged-share-' + suffix, 'prov-forged-semantic-' + suffix);
      await store.workflowTransaction(tx => tx.insertUnique('dashboard_shares', forgedShare, {
        constraint: 'dashboard_shares_semantic_unique', values: { semanticKey: forgedShare.semanticKey },
      }).then(result => {
        if (!result.inserted) throw new Error('The synthetic historical-shaped share already existed.');
      }));
      const forgedRevoke = shareRevokeCycle(seed, suffix + '-forged', forgedShare);
      await insertActionCycle(store, forgedRevoke);
      const forgedEvent = shareRevokeEvent(seed, forgedShare, forgedRevoke, suffix + '-forged');
      await expect(store.workflowTransaction(async tx => {
        const changed = await tx.compareAndSwap('dashboard_shares', forgedShare.id,
          { rowVersion: 1, state: 'active' }, { ...forgedShare, rowVersion: 2, status: 'revoked', revokedAt: NOW });
        if (!changed.updated) throw new Error('The synthetic forged-pointer share unexpectedly changed.');
        await tx.insertUnique('dashboard_share_revoke_events', forgedEvent, {
          constraint: 'dashboard_share_revoke_events_primary_key', values: { id: forgedEvent.id },
        });
      })).rejects.toThrow();
      expect(await store.workflowProjectionReader.get<DashboardShareV2>('dashboard_shares', forgedShare.id))
        .toMatchObject({ rowVersion: 1, body: forgedShare });
      expect(await store.workflowProjectionReader.get('dashboard_share_revoke_events', forgedEvent.id)).toBeUndefined();

      const revoke = shareRevokeCycle(seed, suffix, share);
      await insertActionCycle(store, revoke);
      const target = shareTargetRow(share, revoke);
      const caseAction = caseCycle(seed, suffix);
      await insertActionCycle(store, caseAction);
      const caseTarget = caseTargetRow(seed, caseAction);
      await store.workflowTransaction(async tx => {
        await tx.insertUnique('action_targets', caseTarget, {
          constraint: 'action_targets_execution_target_unique',
          values: { executionId: caseTarget.executionId, entityType: caseTarget.entityType, targetId: caseTarget.targetId },
        });
        await tx.insertUnique('action_targets', target, {
          constraint: 'action_targets_execution_target_unique',
          values: { executionId: target.executionId, entityType: target.entityType, targetId: target.targetId },
        });
      });
      const rawCaseTarget = raw.prepare('SELECT investigation_case_id,dashboard_share_id,entity_type FROM action_targets WHERE id=?')
        .get(caseTarget.id) as { investigation_case_id: string | null; dashboard_share_id: string | null; entity_type: string };
      const rawShareTarget = raw.prepare('SELECT investigation_case_id,dashboard_share_id,dashboard_share_contract_version,entity_type FROM action_targets WHERE id=?')
        .get(target.id) as { investigation_case_id: string | null; dashboard_share_id: string | null; dashboard_share_contract_version: number | null; entity_type: string };
      expect(rawCaseTarget).toEqual({
        investigation_case_id: seed.caseId, dashboard_share_id: null, entity_type: 'investigation_cases',
      });
      expect(rawShareTarget).toEqual({
        investigation_case_id: null, dashboard_share_id: share.id,
        dashboard_share_contract_version: 2, entity_type: 'dashboard_shares',
      });
      const nonNullCaseRefs = raw.prepare('SELECT ' + TARGET_REFERENCE_COLUMNS.map(column => 'SUM(' + column + ' IS NOT NULL)').join(' + ') +
        ' AS count FROM action_targets WHERE id=?').get(caseTarget.id) as { count: number };
      const nonNullShareRefs = raw.prepare('SELECT ' + TARGET_REFERENCE_COLUMNS.map(column => 'SUM(' + column + ' IS NOT NULL)').join(' + ') +
        ' AS count FROM action_targets WHERE id=?').get(target.id) as { count: number };
      expect(nonNullCaseRefs.count).toBe(1);
      expect(nonNullShareRefs.count).toBe(1);

      const invalidTarget = {
        ...target, id: 'effect-target-' + suffix, targetId: 'effect-target-' + suffix,
        entityType: 'dashboard_share_revoke_events' as const,
        ref: { table: 'dashboard_share_revoke_events' as const, id: 'revoke-event-' + suffix },
      };
      await expect(store.workflowTransaction(tx => tx.insertUnique('action_targets', invalidTarget, {
        constraint: 'action_targets_execution_target_unique',
        values: { executionId: invalidTarget.executionId, entityType: invalidTarget.entityType, targetId: invalidTarget.targetId },
      }))).rejects.toThrow();
      const mismatchedTag = {
        ...target, id: 'mismatched-target-' + suffix, targetId: 'mismatched-target-' + suffix,
        entityType: 'dashboard_shares' as const,
        ref: { table: 'investigation_cases' as const, id: seed.caseId },
      };
      await expect(store.workflowTransaction(tx => tx.insertUnique('action_targets', mismatchedTag, {
        constraint: 'action_targets_execution_target_unique',
        values: { executionId: mismatchedTag.executionId, entityType: mismatchedTag.entityType, targetId: mismatchedTag.targetId },
      }))).rejects.toThrow();
      const orphanTarget = {
        ...caseTarget, id: 'orphan-target-' + suffix, targetId: 'orphan-target-' + suffix,
        ref: { table: 'investigation_cases' as const, id: 'missing-case-' + suffix },
      };
      await expect(store.workflowTransaction(tx => tx.insertUnique('action_targets', orphanTarget, {
        constraint: 'action_targets_execution_target_unique',
        values: { executionId: orphanTarget.executionId, entityType: orphanTarget.entityType, targetId: orphanTarget.targetId },
      }))).rejects.toThrow();
      await expect(store.workflowTransaction(tx => tx.compareAndSwap('action_targets', target.id,
        { rowVersion: 1, state: 'pending' }, {
          ...target, rowVersion: 2, ref: { table: 'investigation_cases', id: seed.caseId },
        }))).rejects.toThrow();

      const event = shareRevokeEvent(seed, share, revoke, suffix);
      await expect(store.workflowTransaction(tx => tx.compareAndSwap('action_targets', target.id,
        { rowVersion: 1, state: 'pending' }, {
          ...target, rowVersion: 2, ref: { table: 'dashboard_shares', id: forgedShare.id },
        }))).rejects.toThrow();

      const creatorReceiptBytes = (raw.prepare('SELECT payload FROM action_executions WHERE id=?')
        .get(creator.receipt.id) as { payload: string }).payload;
      const malformedCreatorCases: CreatorReceiptMutation[] = [
        'target_id_mismatch', 'numeric_actor', 'numeric_ref_id', 'numeric_execution_id', 'non_integer_contract_version',
      ];
      for (const mutation of malformedCreatorCases) {
        const variant = suffix + '-' + mutation;
        const unsafeShareId = 'unsafe-creator-share-' + variant;
        const unsafeCreator = shareCreationCycle(seed, variant, unsafeShareId);
        await insertCorruptedCreatorCycle(store, raw, unsafeCreator, mutation);
        const unsafeShare = shareBody(seed, unsafeCreator, unsafeShareId, 'unsafe-creator-semantic-' + variant);
        await store.workflowTransaction(tx => tx.insertUnique('dashboard_shares', unsafeShare, {
          constraint: 'dashboard_shares_semantic_unique', values: { semanticKey: unsafeShare.semanticKey },
        }).then(result => {
          if (!result.inserted) throw new Error('The malformed-creator share already existed.');
        }));
        const unsafeRevoke = shareRevokeCycle(seed, variant, unsafeShare);
        await insertActionCycle(store, unsafeRevoke);
        const unsafeEvent = shareRevokeEvent(seed, unsafeShare, unsafeRevoke, variant);
        expect(() => rawRevokeShareAndInsertEvent(raw, unsafeShare, unsafeEvent),
          'creator receipt mutation: ' + mutation).toThrow(/Invalid workflow relationship/);
        expect(await store.workflowProjectionReader.get<DashboardShareV2>('dashboard_shares', unsafeShare.id), mutation)
          .toMatchObject({ rowVersion: 1, body: unsafeShare });
        expect(await store.workflowProjectionReader.get('dashboard_share_revoke_events', unsafeEvent.id), mutation).toBeUndefined();
      }
      expect((raw.prepare('SELECT payload FROM action_executions WHERE id=?')
        .get(creator.receipt.id) as { payload: string }).payload).toBe(creatorReceiptBytes);
      await expect(store.workflowTransaction(async tx => {
        const result = await tx.compareAndSwap('dashboard_shares', share.id,
          { rowVersion: 1, state: 'active' }, { ...share, rowVersion: 2, status: 'revoked', revokedAt: NOW });
        if (!result.updated) throw new Error('The synthetic active share unexpectedly changed.');
      })).rejects.toThrow();
      expect(await store.workflowProjectionReader.get<DashboardShareV2>('dashboard_shares', share.id))
        .toMatchObject({ rowVersion: 1, body: share });
      await store.workflowTransaction(async tx => {
        const result = await tx.compareAndSwap('dashboard_shares', share.id,
          { rowVersion: 1, state: 'active' }, { ...share, rowVersion: 2, status: 'revoked', revokedAt: NOW });
        if (!result.updated) throw new Error('The synthetic active share unexpectedly changed.');
        const inserted = await tx.insertUnique('dashboard_share_revoke_events', event, {
          constraint: 'dashboard_share_revoke_events_primary_key', values: { id: event.id },
        });
        if (!inserted.inserted) throw new Error('The synthetic revoke event already existed.');
      });
      const nativeEvent = raw.prepare(
        'SELECT share_id,actor_id,execution_id,share_creation_execution_id,prior_share_row_version,revoked_share_row_version,created_at,' +
        'share_contract_version,execution_contract_version,share_creation_execution_contract_version ' +
        'FROM dashboard_share_revoke_events WHERE id=?',
      ).get(event.id);
      expect(nativeEvent).toEqual({
        share_id: share.id, actor_id: seed.profileId, execution_id: revoke.receipt.id,
        share_creation_execution_id: creator.receipt.id, prior_share_row_version: 1,
        revoked_share_row_version: 2, created_at: NOW, share_contract_version: 2,
        execution_contract_version: 2, share_creation_execution_contract_version: 2,
      });
      expect(raw.prepare('SELECT workflow_revoke_share_id,workflow_revoke_share_row_version,workflow_revoke_creation_execution_id FROM dashboard_shares WHERE id=?')
        .get(share.id)).toEqual({
          workflow_revoke_share_id: share.id, workflow_revoke_share_row_version: 2,
          workflow_revoke_creation_execution_id: creator.receipt.id,
        });
      expect(raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      const revoked = await store.workflowProjectionReader.get<DashboardShareV2>('dashboard_shares', share.id);
      expect(revoked?.body).toMatchObject({ status: 'revoked', rowVersion: 2, executionId: creator.receipt.id, revokedAt: NOW });
      expect(await store.workflowProjectionReader.get<DashboardShareRevokeEvent>('dashboard_share_revoke_events', event.id))
        .toMatchObject({ rowVersion: 1, body: event });

      const changedCreation = { ...revoked!.body, rowVersion: 3, executionId: revoke.receipt.id };
      await expect(store.workflowTransaction(tx => tx.compareAndSwap('dashboard_shares', share.id,
        { rowVersion: 2, state: 'revoked' }, changedCreation))).rejects.toThrow();
      expect(await store.workflowProjectionReader.get<DashboardShareV2>('dashboard_shares', share.id))
        .toMatchObject({ rowVersion: 2, body: { executionId: creator.receipt.id } });
      expect(() => raw.prepare('UPDATE dashboard_share_revoke_events SET row_version=row_version+1 WHERE id=?')
        .run(event.id)).toThrow();
      expect(() => raw.prepare('UPDATE dashboard_share_revoke_events SET body=json_set(body, \'$.actorId\', ?) WHERE id=?')
        .run('forged-actor-' + suffix, event.id)).toThrow();
      expect(() => raw.prepare('DELETE FROM dashboard_share_revoke_events WHERE id=?').run(event.id)).toThrow();
    } finally {
      raw.close();
      await fixture.dispose();
    }
  });

  itSqliteBound('fails closed on a same-name no-op revoke guard during reapply without repairing or mutating history', async () => {
    const suffix = 'attest-' + randomUUID().replaceAll('-', '');
    const { fixture, db, rows } = await createPopulated040002Fixture(suffix);
    try {
      applyWorkflowSqliteMigrations(db);
      const beforeRows = storedRows(db, rows);
      const beforeLedger = ledgerRows(db);
      const beforeRevision = (db.prepare('SELECT revision FROM appmeta WHERE singleton=1').get() as { revision: number }).revision;
      const eventInsertGuard = 'workflow_dashboard_share_revoke_events_insert_guard';
      const installed = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?")
        .get(eventInsertGuard) as { sql: string } | undefined;
      expect(installed?.sql).toContain('CREATE TRIGGER');
      db.exec('DROP TRIGGER \"' + eventInsertGuard + '\"');
      db.exec('CREATE TRIGGER \"' + eventInsertGuard + '\" BEFORE INSERT ON dashboard_share_revoke_events BEGIN SELECT 1; END');
      const tampered = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?")
        .get(eventInsertGuard) as { sql: string };
      expect(() => applyWorkflowSqliteMigrations(db)).toThrow(/incompatible action provenance trigger/);
      expect((db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?")
        .get(eventInsertGuard) as { sql: string }).sql).toBe(tampered.sql);
      expect(storedRows(db, rows)).toEqual(beforeRows);
      expect(ledgerRows(db)).toEqual(beforeLedger);
      expect((db.prepare('SELECT revision FROM appmeta WHERE singleton=1').get() as { revision: number }).revision)
        .toBe(beforeRevision);
    } finally {
      if (db.open) db.close();
      await fixture.dispose();
    }
  });

  itSqliteBound('rejects a generated guard name already attached to another table before changing the 040002 database', async () => {
    const suffix = 'collision-' + randomUUID().replaceAll('-', '');
    const { fixture, db, rows } = await createPopulated040002Fixture(suffix);
    try {
      const triggerName = 'workflow_dashboard_share_revoke_events_insert_guard';
      db.exec('CREATE TRIGGER "' + triggerName + '" BEFORE INSERT ON branches BEGIN SELECT 1; END');
      const beforeRows = storedRows(db, rows);
      const beforeLedger = ledgerRows(db);
      const beforeRevision = (db.prepare('SELECT revision FROM appmeta WHERE singleton=1').get() as { revision: number }).revision;
      const beforeSchema = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name').all();
      const beforeTrigger = db.prepare("SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger' AND name=?")
        .get(triggerName);
      let failure: unknown;
      try {
        applyWorkflowSqliteMigrations(db);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      if (!(failure instanceof Error)) throw new Error('Expected the action provenance migration to reject the trigger collision.');
      expect(failure.message).toBe('Workflow migration rejected incompatible schema or data');
      const cause = (failure as Error & { cause?: unknown }).cause;
      expect(cause).toBeInstanceOf(Error);
      if (!(cause instanceof Error)) throw new Error('The wrapped migration error omitted its cause.');
      expect(cause.message).toMatch(/cross-table generated trigger collision/);
      expect(db.prepare("SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger' AND name=?")
        .get(triggerName)).toEqual(beforeTrigger);
      expect(db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name').all())
        .toEqual(beforeSchema);
      expect(storedRows(db, rows)).toEqual(beforeRows);
      expect(ledgerRows(db)).toEqual(beforeLedger);
      expect((db.prepare('SELECT revision FROM appmeta WHERE singleton=1').get() as { revision: number }).revision)
        .toBe(beforeRevision);
    } finally {
      if (db.open) db.close();
      await fixture.dispose();
    }
  });
});
