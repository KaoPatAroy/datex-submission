import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { tables, type Branch, type Employee, type Incident, type Inventory, type PendingAction, type PolicyDocument, type Product, type Profile } from '../lib/contracts';
import { defaultDemoWorkflowPolicy, pendingActionV2Schema, reviewSnapshotSchema, versionedDemoWorkflowPolicySchema, workflowReceiptV2Schema } from '../lib/workflows/contracts';
import type { DashboardShareV2, GuardedTransaction, PendingActionV2, VersionedDemoWorkflowPolicy, WorkflowReceiptV2, WorkflowStore, WorkflowStorageTable } from '../lib/workflows/contracts';
import type { WorkflowStorageQuery } from '../lib/storage/workflow-projections';
import { digest } from '../lib/core/utils';
import { DomainError } from '../lib/core/errors';
import { createWorkflowSqliteFixture } from './helpers/workflow-storage';
import { actors, createWorkspaceFixture, dashboardPayload } from './helpers/workspace';
import {
  WORKFLOW_BASE_DIGEST,
  WORKFLOW_BASE_MIGRATION,
  WORKFLOW_SCOPE_DIGEST,
  WORKFLOW_SCOPE_MIGRATION
} from '../lib/storage/workflow-schema-history';
import { applyWorkflowSqliteMigrations } from '../lib/storage/workflow-sqlite-migrations';
import { itSqliteBound } from './helpers/local-pg';

type ProjectedRow<T> = { id: string; rowVersion: number; body: T };
type WorkflowStoreWithProjectionReader = WorkflowStore & {
  workflowProjectionReader: {
    get<T>(table: WorkflowStorageTable, id: string): Promise<ProjectedRow<T> | undefined>;
    query<T>(query: WorkflowStorageQuery): Promise<ProjectedRow<T>[]>;
  };
};

const HISTORICAL_STAGE_STOP = 'test-only historical workflow schema checkpoint';

function seedLegacyWorkflowV1(db: Database.Database) {
  for (const table of tables) {
    db.exec(`CREATE TABLE "${table}" (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL)`);
  }
  db.exec('CREATE TABLE appmeta (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), revision INTEGER NOT NULL)');
  db.prepare('INSERT INTO appmeta (singleton, revision) VALUES (1, 17)').run();

  const profile = {
    id: 'workflow-storage-index-upgrade-profile',
    name: 'Synthetic workflow storage profile',
    role: 'hr_admin',
    active: true,
    permissions: [],
    regions: []
  };
  db.prepare('INSERT INTO profiles (id, payload) VALUES (?, ?)').run(profile.id, JSON.stringify(profile));
  return profile;
}

function materializeWorkflowStage(db: Database.Database, migrationId: string): void {
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
type WorkflowTransactionWithProjectionReader = GuardedTransaction & {
  workflowProjectionReader: WorkflowStoreWithProjectionReader['workflowProjectionReader'];
};

type WorkflowPolicyRow = {
  id: string;
  version: number;
  digest: string;
  policy: VersionedDemoWorkflowPolicy;
};

type IncidentEscalationProjectionBody = Incident & {
  escalationStage: 'un_escalated' | 'team_requested';
  escalationLifecycleId: string;
  escalationEventId: string | null;
  rowVersion?: number;
};

const branch: Branch = {
  id: 'workflow-storage-branch-01',
  name: 'Workflow storage test branch',
  region: 'east'
};

function workflowPolicyRow(pendingTtlSeconds: number): WorkflowPolicyRow {
  const policy = versionedDemoWorkflowPolicySchema.parse({
    ...defaultDemoWorkflowPolicy,
    pendingTtlSeconds
  });
  return { id: 'demo-workflow', version: 1, digest: digest(policy), policy };
}

async function seedCanonicalWorkflowPolicy(store: WorkflowStore, suffix: string): Promise<WorkflowPolicyRow> {
  const canonicalPolicy = workflowPolicyRow(defaultDemoWorkflowPolicy.pendingTtlSeconds);
  const row = { ...canonicalPolicy, id: `workflow-storage-policy-config-${suffix}` };
  await store.workflowTransaction((tx) => tx.insertUnique('workflow_policies', row, {
    constraint: 'workflow_policies_primary_key', values: { id: row.id }
  }));
  return row;
}

async function seedOnboardingContext(store: WorkflowStore, suffix: string) {
  const branchId = `workflow-storage-onboarding-branch-${suffix}`;
  const managerProfileId = `workflow-storage-manager-profile-${suffix}`;
  const directorProfileId = `workflow-storage-director-profile-${suffix}`;
  const employeeId = `workflow-storage-employee-${suffix}`;
  const sessionId = `workflow-storage-session-${suffix}`;
  const conversationId = `workflow-storage-conversation-${suffix}`;
  const orgUnitId = `workflow-storage-org-${suffix}`;
  const managerIdentityId = `workflow-storage-manager-${suffix}`;
  const directorIdentityId = `workflow-storage-director-${suffix}`;
  const requestId = `workflow-storage-request-${suffix}`;

  const branchRow: Branch = { id: branchId, name: 'Workflow storage HR branch', region: 'east' };
  const managerProfile: Profile = {
    id: managerProfileId, name: 'Workflow Storage HR Manager', role: 'hr_admin', active: true,
    permissions: [], regions: []
  };
  const directorProfile: Profile = {
    id: directorProfileId, name: 'Workflow Storage HR Director', role: 'executive', active: true,
    permissions: [], regions: []
  };
  const employee: Employee = { id: employeeId, name: 'Workflow Storage Employee', branchId, active: true };
  await store.transaction(async (tx) => {
    await tx.put('branches', branchRow);
    await tx.put('profiles', managerProfile);
    await tx.put('profiles', directorProfile);
    await tx.put('employees', employee);
    await tx.put('sessions', {
      id: sessionId, profileId: managerProfileId, mode: 'scripted_demo',
      modeRevision: 0, csrfToken: 'workflow-storage-csrf', expiresAt: '2099-01-01T00:00:00.000Z'
    });
    await tx.put('conversations', {
      id: conversationId, actorId: managerProfileId, createdAt: '2026-10-02T05:00:00.000Z'
    });
  });

  await store.workflowTransaction(async (tx) => {
    await tx.insertUnique('org_units', {
      id: orgUnitId, name: `Workflow Storage HR ${suffix}`, parentOrgUnitId: null, active: true
    }, { constraint: 'org_units_primary_key', values: { id: orgUnitId } });
    await tx.insertUnique('directory_identities', {
      id: managerIdentityId, profileId: managerProfileId, displayName: 'Workflow Storage HR Manager',
      active: true, role: 'hr_admin', department: 'hr', orgUnitId, managerIdentityId: null,
      verifiedDemoEmail: `workflow-manager-${suffix}@example.invalid`, slackIdentity: null,
      allowedChannels: ['simulated_email'], classificationCeiling: 'internal', rowVersion: 1
    }, { constraint: 'directory_identities_primary_key', values: { id: managerIdentityId } });
    await tx.insertUnique('directory_identities', {
      id: directorIdentityId, profileId: directorProfileId, displayName: 'Workflow Storage HR Director',
      active: true, role: 'hr_director', department: 'hr', orgUnitId, managerIdentityId: null,
      verifiedDemoEmail: `workflow-director-${suffix}@example.invalid`, slackIdentity: null,
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
    lifecycleId: `workflow-storage-lifecycle-${suffix}`,
    managerApprovalEventId: null,
    managerApprovedBy: null,
    managerApprovedAt: null,
    directorApprovalEventId: null,
    directorApprovedBy: null,
    directorApprovedAt: null,
    createdAt: '2026-10-02T05:00:00.000Z',
    updatedAt: '2026-10-02T05:00:00.000Z'
  };
  await store.workflowTransaction((tx) => tx.insertUnique('onboarding_requests', request, {
    constraint: 'onboarding_requests_primary_key', values: { id: requestId }
  }));

  return {
    branchRow, employee, managerProfile, directorProfile, orgUnitId, managerIdentityId,
    directorIdentityId, sessionId, conversationId, request
  };
}

function legacyPendingActionRow(
  context: Awaited<ReturnType<typeof seedOnboardingContext>>,
  id: string,
  preview: string,
): PendingAction {
  const payload = { kind: 'demo_update', scenario: 'baseline' } as const;
  return {
    id,
    actorId: context.managerProfile.id,
    sessionId: context.sessionId,
    conversationId: context.conversationId,
    turnId: `turn-${id}`,
    mode: 'scripted_demo',
    modeRevision: 0,
    payload,
    payloadHash: digest(payload),
    evidenceVersion: null,
    packs: [],
    actionContractVersion: 1,
    approvalScope: { region: context.branchRow.region, date: '2026-10-02', branchIds: [context.branchRow.id] },
    approvalDisplay: { artifactTitle: 'Legacy workflow storage approval' },
    createdAt: '2026-10-02T05:00:00.000Z',
    expiresAt: '2026-10-02T06:00:00.000Z',
    status: 'pending',
    preview,
  };
}

function pendingActionRow(context: Awaited<ReturnType<typeof seedOnboardingContext>>, suffix: string): PendingActionV2 {
  const caseId = `workflow-storage-case-${suffix}`;
  const taskId = `workflow-storage-investigation-task-${suffix}`;
  const payload = {
    kind: 'investigation_create',
    businessDate: '2026-10-01',
    targets: [{
      ownerIdentityId: context.managerIdentityId,
      reason: 'Review the synthetic inventory discrepancy.',
      dueDate: '2026-10-04',
      priority: 'normal',
      branchId: context.branchRow.id,
      caseId,
      sourceIds: ['workflow-storage-source-01'],
      unansweredQuestion: 'Which movement explains the reviewed difference?'
    }]
  } as const;
  const expectedRows = [{
    ref: { table: 'branches', id: context.branchRow.id },
    rowVersion: 1,
    state: null
  }];

  return pendingActionV2Schema.parse({
    id: `workflow-storage-action-${suffix}`,
    contractVersion: 2,
    actorId: context.managerProfile.id,
    sessionId: context.sessionId,
    conversationId: context.conversationId,
    turnId: `workflow-storage-turn-${suffix}`,
    mode: 'scripted_demo',
    modeRevision: 0,
    payload,
    payloadHash: digest(payload),
    idempotencyKey: digest({ idempotency: suffix }),
    targets: [{
      targetId: `workflow-storage-target-${suffix}`,
      ref: { table: 'investigation_cases', id: caseId },
      semanticKey: `workflow-storage-investigation:${caseId}`,
      expectedRows,
      ownerIdentityId: context.managerIdentityId,
      expectedEffectRef: { table: 'investigation_tasks', id: taskId },
      expectedEffectVersion: 1
    }],
    targetCount: 1,
    expectedRows,
    approvedBranchIds: [context.branchRow.id],
    approvedOrgUnitIds: [context.orgUnitId],
    reviewedSnapshotId: null,
    policy: { id: 'demo-workflow', version: 1, digest: digest(defaultDemoWorkflowPolicy) },
    packs: [{
      id: 'workflow-operations', version: '1.0', schemaDigest: 'c'.repeat(64),
      implementationRevision: 'operations-r1'
    }],
    releaseRevision: 'release-r1',
    executionMode: 'atomic_local',
    createdAt: '2026-10-02T05:00:00.000Z',
    expiresAt: '2026-10-02T05:10:00.000Z',
    status: 'pending'
  });
}

function incidentEscalationActionRow(
  context: Awaited<ReturnType<typeof seedOnboardingContext>>,
  suffix: string,
  incidentId: string,
): PendingActionV2 {
  const base = pendingActionRow(context, suffix);
  const lifecycleId = `workflow-storage-incident-lifecycle-${suffix}`;
  const eventId = `workflow-storage-incident-event-${suffix}`;
  const payload = {
    kind: 'incident_escalate',
    targets: [{
      incidentId,
      targetTeamId: 'demo_operations',
      evidenceIds: [`workflow-storage-incident-evidence-${suffix}`],
      reason: 'Escalate the reviewed synthetic incident to operations.'
    }]
  } as const;
  const expectedRows = [{
    ref: { table: 'incidents' as const, id: incidentId },
    rowVersion: 1,
    state: 'open'
  }];
  return pendingActionV2Schema.parse({
    ...base,
    payload,
    payloadHash: digest(payload),
    targets: [{
      targetId: `workflow-storage-incident-target-${suffix}`,
      ref: { table: 'incidents', id: incidentId },
      semanticKey: `incident:${incidentId}:${lifecycleId}:team_requested`,
      expectedRows,
      ownerIdentityId: context.managerIdentityId,
      expectedEffectRef: { table: 'incident_escalation_events', id: eventId },
      expectedEffectVersion: 1
    }],
    targetCount: 1,
    expectedRows
  });
}

async function createActionExecutionCycle(
  store: WorkflowStore,
  context: Awaited<ReturnType<typeof seedOnboardingContext>>,
  suffix: string,
  actionOverride?: PendingActionV2,
) {
  const action = actionOverride ?? pendingActionRow(context, suffix);
  const executionId = `workflow-storage-execution-${suffix}`;
  const root = {
    id: `workflow-storage-root-${suffix}`,
    actionId: action.id,
    actorId: action.actorId,
    idempotencyKey: action.idempotencyKey,
    activeExecutionId: executionId,
    rowVersion: 1,
    status: 'open',
    createdAt: '2026-10-02T05:00:00.000Z'
  };
  const receipt: WorkflowReceiptV2 = workflowReceiptV2Schema.parse({
    id: executionId,
    actionId: action.id,
    contractVersion: 2,
    actorId: action.actorId,
    kind: action.payload.kind,
    outcome: 'pending',
    proofs: [],
    createdAt: '2026-10-02T05:00:00.000Z',
    verifiedAt: null,
    currentStates: []
  });

  await seedCanonicalWorkflowPolicy(store, suffix);
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

async function seedShareSecurityContext(store: WorkflowStore, suffix: string) {
  const context = await seedOnboardingContext(store, `share-${suffix}`);
  const secondBranch: Branch = {
    id: `workflow-storage-share-branch-2-${suffix}`,
    name: 'Second workflow storage share branch',
    region: 'east'
  };
  const dashboardId = `workflow-storage-dashboard-${suffix}`;
  const dashboardVersionId = `workflow-storage-dashboard-version-${suffix}`;
  const shareId = `workflow-storage-share-${suffix}`;
  const childId = `workflow-storage-share-scope-${suffix}`;
  const { action, root, receipt } = await createActionExecutionCycle(store, context, `share-${suffix}`);
  const executionId = receipt.id;
  const templateSpec = dashboardPayload('east').spec;
  const dashboardSpec = {
    ...templateSpec,
    scope: { ...templateSpec.scope, branchIds: [context.branchRow.id] }
  };
  const dashboard = {
    id: dashboardId, ownerId: context.managerProfile.id,
    createdAt: '2026-10-02T05:00:00.000Z', updatedAt: '2026-10-02T05:00:00.000Z',
    spec: dashboardSpec
  };
  await store.transaction(async (tx) => {
    await tx.put('branches', secondBranch);
    await tx.put('dashboards', dashboard);
  });

  await store.workflowTransaction(async (tx) => {
    await tx.insertUnique('dashboard_versions', {
      id: dashboardVersionId, dashboardId, version: 1, ownerId: context.managerProfile.id,
      spec: dashboardSpec, packs: [], createdAt: '2026-10-02T05:00:00.000Z', digest: digest(dashboardSpec)
    }, { constraint: 'dashboard_versions_primary_key', values: { id: dashboardVersionId } });
  });

  const share: DashboardShareV2 = {
    id: shareId,
    dashboardId,
    dashboardVersionId,
    senderIdentityId: context.managerIdentityId,
    recipientIdentityId: context.directorIdentityId,
    approvedBranchIds: [context.branchRow.id],
    classification: 'internal',
    verificationDigest: 'e'.repeat(64),
    keyVersion: 1,
    channel: 'simulated_email',
    policy: { id: 'demo-workflow', version: 1, digest: digest(defaultDemoWorkflowPolicy) },
    status: 'active',
    expiresAt: '2099-01-01T00:00:00.000Z',
    rowVersion: 1,
    semanticKey: `workflow-storage-share-semantic-${suffix}`,
    executionId,
    createdAt: '2026-10-02T05:00:00.000Z',
    revokedAt: null
  };
  const scopeChild = { id: childId, shareId, branchId: context.branchRow.id };
  await store.workflowTransaction(async (tx) => {
    await tx.insertUnique('dashboard_shares', share, {
      constraint: 'dashboard_shares_semantic_unique', values: { semanticKey: share.semanticKey }
    });
    await tx.insertUnique('share_scope_branches', scopeChild, {
      constraint: 'share_scope_branches_primary_key', values: { id: scopeChild.id }
    });
  });

  return { context, secondBranch, action, root, receipt, share, scopeChild };
}

describe('SQLite workflow storage conformance', () => {
  it('persists projected versions across close and reopen while public reads return only the body', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      let store = fixture.store as WorkflowStoreWithProjectionReader;
      expect(store.workflowContractVersion).toBe(2);

      await store.transaction(async (tx) => tx.put('branches', branch));

      let projected = await store.workflowProjectionReader.get<Branch>('branches', branch.id);
      expect(projected).toEqual({ id: branch.id, rowVersion: 1, body: branch });
      expect(await store.get<Branch>('branches', branch.id)).toEqual(branch);
      expect(await store.list<Branch>('branches')).toContainEqual(branch);
      expect(await store.workflowProjectionReader.query<Branch>({
        kind: 'ids', table: 'branches', ids: [branch.id]
      })).toEqual([projected]);
      expect(Object.keys((await store.get<Branch>('branches', branch.id)) ?? {}).sort()).toEqual(['id', 'name', 'region']);

      store = fixture.reopen() as WorkflowStoreWithProjectionReader;
      projected = await store.workflowProjectionReader.get<Branch>('branches', branch.id);
      expect(projected).toEqual({ id: branch.id, rowVersion: 1, body: branch });
      expect(await store.get<Branch>('branches', branch.id)).toEqual(branch);
    } finally {
      await fixture.dispose();
    }
  });

  it('keeps V1 shared-source writes visible to the guarded projected reader and advances their version', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const store = fixture.store as WorkflowStoreWithProjectionReader;
      const first: Branch = { ...branch, id: 'workflow-storage-shared-branch-01' };
      const updated: Branch = { ...first, name: 'Updated shared source branch' };

      await store.transaction(async (tx) => tx.put('branches', first));
      const before = await store.workflowProjectionReader.get<Branch>('branches', first.id);
      expect(before).toEqual({ id: first.id, rowVersion: 1, body: first });

      await store.transaction(async (tx) => tx.put('branches', updated));
      const after = await store.workflowProjectionReader.get<Branch>('branches', first.id);
      expect(after).toEqual({ id: first.id, rowVersion: 2, body: updated });
      expect(await store.get<Branch>('branches', first.id)).toEqual(updated);
      expect(Object.keys((await store.get<Branch>('branches', first.id)) ?? {}).sort()).toEqual(['id', 'name', 'region']);
    } finally {
      await fixture.dispose();
    }
  });

  itSqliteBound('allows one active responsibility per identity, purpose, and org unit', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const store = fixture.store as WorkflowStoreWithProjectionReader;
      const context = await seedOnboardingContext(store, 'responsibility-scope');
      const secondOrgUnitId = 'workflow-storage-responsibility-org-second';
      await store.workflowTransaction((tx) => tx.insertUnique('org_units', {
        id: secondOrgUnitId,
        name: 'Workflow storage second responsibility org unit',
        parentOrgUnitId: context.orgUnitId,
        active: true
      }, { constraint: 'org_units_primary_key', values: { id: secondOrgUnitId } }));

      const first = {
        id: 'workflow-storage-responsibility-first-unit',
        identityId: context.managerIdentityId,
        orgUnitId: context.orgUnitId,
        purpose: 'hr_operations',
        branchIds: [],
        active: true,
        rowVersion: 1
      };
      const second = {
        ...first,
        id: 'workflow-storage-responsibility-second-unit',
        orgUnitId: secondOrgUnitId
      };
      const constraint = 'responsibilities_open_identity_purpose_unique';
      const uniqueValues = (row: typeof first) => ({
        identityId: row.identityId,
        purpose: row.purpose,
        orgUnitId: row.orgUnitId
      });
      const inserted = await store.workflowTransaction(async (tx) => ({
        first: await tx.insertUnique('responsibilities', first, {
          constraint, values: uniqueValues(first)
        }),
        second: await tx.insertUnique('responsibilities', second, {
          constraint, values: uniqueValues(second)
        })
      }));
      expect(inserted).toEqual({
        first: { inserted: true, row: first },
        second: { inserted: true, row: second }
      });

      const duplicateUnit = {
        ...first,
        id: 'workflow-storage-responsibility-duplicate-first-unit'
      };
      expect(await store.workflowTransaction((tx) => tx.insertUnique('responsibilities', duplicateUnit, {
        constraint, values: uniqueValues(duplicateUnit)
      }))).toEqual({ inserted: false, existing: first });

      const wrongUnitKeyCandidate = {
        ...second,
        id: 'workflow-storage-responsibility-wrong-unit-key'
      };
      await expect(store.workflowTransaction((tx) => tx.insertUnique(
        'responsibilities', wrongUnitKeyCandidate,
        { constraint, values: uniqueValues(first) }
      ))).rejects.toMatchObject({ code: 'STORAGE', definitelyNotCommitted: true });
      expect(await store.workflowProjectionReader.get<typeof wrongUnitKeyCandidate>(
        'responsibilities', wrongUnitKeyCandidate.id
      )).toBeUndefined();

      const db = fixture.openDatabase();
      db.pragma('foreign_keys = ON');
      try {
        expect(() => db.prepare(`
          INSERT INTO responsibilities (
            id, row_version, body, identity_id, org_unit_id, purpose, active
          ) VALUES (
            @id, 1, @body, @identityId, @orgUnitId, @purpose, 1
          )
        `).run({
          id: duplicateUnit.id,
          body: JSON.stringify(duplicateUnit),
          identityId: duplicateUnit.identityId,
          orgUnitId: duplicateUnit.orgUnitId,
          purpose: duplicateUnit.purpose
        })).toThrow();
        const persistedRows = db.prepare(`
          SELECT id, row_version, body FROM responsibilities
          WHERE identity_id = ? AND purpose = ? ORDER BY org_unit_id
        `).all(first.identityId, first.purpose) as Array<{ id: string; row_version: number; body: string }>;
        expect(persistedRows).toHaveLength(2);
        const persistedById = new Map(persistedRows.map((row) => [row.id, {
          rowVersion: row.row_version,
          body: JSON.parse(row.body)
        }]));
        expect(persistedById.get(first.id)).toEqual({ rowVersion: 1, body: first });
        expect(persistedById.get(second.id)).toEqual({ rowVersion: 1, body: second });
      } finally {
        db.close();
      }

      expect(await store.workflowProjectionReader.get<typeof first>(
        'responsibilities', first.id
      )).toEqual({ id: first.id, rowVersion: 1, body: first });
      expect(await store.workflowProjectionReader.get<typeof second>(
        'responsibilities', second.id
      )).toEqual({ id: second.id, rowVersion: 1, body: second });
      expect(await store.workflowProjectionReader.get<typeof duplicateUnit>(
        'responsibilities', duplicateUnit.id
      )).toBeUndefined();
      expect(await store.workflowProjectionReader.query<typeof first>({
        kind: 'unique', table: 'responsibilities', constraint,
        values: uniqueValues(first)
      })).toEqual([{ id: first.id, rowVersion: 1, body: first }]);
      expect(await store.workflowProjectionReader.query<typeof second>({
        kind: 'unique', table: 'responsibilities', constraint,
        values: uniqueValues(second)
      })).toEqual([{ id: second.id, rowVersion: 1, body: second }]);

      const identity = await store.workflowProjectionReader.get<{ id: string; orgUnitId: string; active: boolean }>(
        'directory_identities', context.managerIdentityId
      );
      expect(identity).toMatchObject({
        id: context.managerIdentityId,
        rowVersion: 1,
        body: { id: context.managerIdentityId, orgUnitId: context.orgUnitId, active: true }
      });
    } finally {
      await fixture.dispose();
    }
  });

  itSqliteBound('upgrades a pinned predecessor responsibility index without changing row bytes or versions', async () => {
    const fixture = await createWorkflowSqliteFixture({ initialize: false });
    const orgUnit = {
      id: 'workflow-storage-index-upgrade-org',
      rowVersion: 1,
      parentOrgUnitId: null,
      name: 'Synthetic workflow storage index unit',
      active: true,
      kind: 'department',
      createdAt: '2026-10-04T05:00:00.000Z'
    };
    const identity = {
      id: 'workflow-storage-index-upgrade-identity',
      profileId: 'workflow-storage-index-upgrade-profile',
      displayName: 'Synthetic workflow storage identity',
      active: true,
      role: 'hr_admin',
      department: 'hr',
      orgUnitId: orgUnit.id,
      managerIdentityId: null,
      verifiedDemoEmail: 'workflow-storage-index-upgrade@example.invalid',
      slackIdentity: null,
      allowedChannels: ['simulated_email'],
      classificationCeiling: 'internal',
      rowVersion: 1
    };
    const seededResponsibility = {
      id: 'workflow-storage-responsibility-predecessor-ledger',
      identityId: identity.id,
      orgUnitId: orgUnit.id,
      purpose: 'hr_operations',
      branchIds: [],
      active: true,
      rowVersion: 1
    };
    try {
      const db = fixture.openDatabase();
      try {
        const profile = seedLegacyWorkflowV1(db);
      materializeWorkflowStage(db, WORKFLOW_BASE_MIGRATION);
      expect(db.prepare('SELECT id, digest FROM workflow_schema_migrations ORDER BY id').all()).toEqual([
        { id: WORKFLOW_BASE_MIGRATION, digest: WORKFLOW_BASE_DIGEST }
      ]);

      db.prepare(`
        INSERT INTO org_units (id, body, row_version, parent_org_unit_id, name, active)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(orgUnit.id, JSON.stringify(orgUnit), orgUnit.rowVersion, null, orgUnit.name, 1);
      db.prepare(`
        INSERT INTO directory_identities (
          id, body, row_version, profile_id, org_unit_id, manager_identity_id, role, active, verified_demo_email
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(identity.id, JSON.stringify(identity), identity.rowVersion, profile.id, identity.orgUnitId,
        identity.managerIdentityId, identity.role, 1, identity.verifiedDemoEmail);
      db.prepare(`
        INSERT INTO responsibilities (id, body, row_version, identity_id, org_unit_id, purpose, active)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(seededResponsibility.id, JSON.stringify(seededResponsibility), seededResponsibility.rowVersion,
        seededResponsibility.identityId, seededResponsibility.orgUnitId, seededResponsibility.purpose, 1);

      const rowsBefore = db.prepare(`
        SELECT id, row_version, body FROM responsibilities ORDER BY id
      `).all() as Array<{ id: string; row_version: number; body: string }>;
      expect(rowsBefore).toHaveLength(1);
      expect(rowsBefore[0]).toMatchObject({ id: seededResponsibility.id, row_version: 1 });
      expect(JSON.parse(rowsBefore[0].body)).toEqual(seededResponsibility);
      const bodyDigestsBefore = rowsBefore.map((row) => createHash('sha256').update(row.body).digest('hex'));
      expect((db.prepare(`PRAGMA index_info('responsibilities_open_identity_purpose_unique')`).all() as Array<{ name: string }>).map((row) => row.name))
        .toEqual(['identity_id', 'purpose']);
      const revisionBefore = db.prepare('SELECT revision FROM appmeta WHERE singleton = 1').get();

      applyWorkflowSqliteMigrations(db);

      const rowsAfter = db.prepare(`
        SELECT id, row_version, body FROM responsibilities ORDER BY id
      `).all() as Array<{ id: string; row_version: number; body: string }>;
      expect(rowsAfter).toEqual(rowsBefore);
      expect(rowsAfter.map((row) => createHash('sha256').update(row.body).digest('hex')))
        .toEqual(bodyDigestsBefore);
      expect(db.prepare('SELECT revision FROM appmeta WHERE singleton = 1').get()).toEqual(revisionBefore);
      expect(db.prepare('SELECT digest FROM workflow_schema_migrations WHERE id = ?')
        .get(WORKFLOW_BASE_MIGRATION)).toEqual({ digest: WORKFLOW_BASE_DIGEST });
      expect(db.prepare('SELECT digest FROM workflow_schema_migrations WHERE id = ?')
        .get(WORKFLOW_SCOPE_MIGRATION)).toEqual({ digest: WORKFLOW_SCOPE_DIGEST });
      expect((db.prepare(`PRAGMA index_info('responsibilities_open_identity_purpose_unique')`).all() as Array<{ name: string }>).map((row) => row.name))
        .toEqual(['identity_id', 'purpose', 'org_unit_id']);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }

      const reopened = fixture.openStore() as WorkflowStoreWithProjectionReader;
      expect(await reopened.workflowProjectionReader.get<typeof seededResponsibility>(
        'responsibilities', seededResponsibility.id
      )).toEqual({ id: seededResponsibility.id, rowVersion: 1, body: seededResponsibility });
    } finally {
      await fixture.dispose();
    }
  });

  it('rejects branch deletion while a legacy employee still references it', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const store = fixture.store;
      const assignedBranch: Branch = {
        id: 'workflow-storage-assigned-branch', name: 'Branch with assigned employee', region: 'east'
      };
      const employee: Employee = {
        id: 'workflow-storage-assigned-employee', name: 'Assigned employee',
        branchId: assignedBranch.id, active: true
      };
      await store.transaction(async (tx) => {
        await tx.put('branches', assignedBranch);
        await tx.put('employees', employee);
      });

      await expect(store.transaction(async (tx) => tx.remove('branches', assignedBranch.id))).rejects.toThrow();

      expect(await store.get<Branch>('branches', assignedBranch.id)).toEqual(assignedBranch);
      expect(await store.get<Employee>('employees', employee.id)).toEqual(employee);
    } finally {
      await fixture.dispose();
    }
  });

  itSqliteBound('bumps the global revision for V1 writes, guarded inserts, and direct SQL workflow updates', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const store = fixture.store as WorkflowStoreWithProjectionReader;
      const context = await seedOnboardingContext(store, 'revision');
      const { receipt } = await createActionExecutionCycle(store, context, 'revision');
      const { request } = context;
      const db = fixture.openDatabase();
      const revision = () => (db.prepare('SELECT revision FROM appmeta WHERE singleton = 1').get() as { revision: number }).revision;
      try {
        const initialRevision = revision();
        const source: Branch = { ...branch, id: 'workflow-storage-revision-source' };
        await store.transaction(async (tx) => tx.put('branches', source));
        const afterV1Write = revision();
        expect(afterV1Write).toBeGreaterThan(initialRevision);

        const checklist = {
          id: 'workflow-storage-revision-checklist', requestId: request.id,
          templateId: 'hr_welcome', status: 'open', executionId: receipt.id
        };
        await store.workflowTransaction((tx) => tx.insertUnique('onboarding_checklists', checklist, {
          constraint: 'onboarding_checklists_primary_key', values: { id: checklist.id }
        }));
        const afterGuardedInsert = revision();
        expect(afterGuardedInsert).toBeGreaterThan(afterV1Write);

        const directBody = { ...checklist, status: 'completed', completedAt: '2026-10-02T06:00:00.000Z' };
        db.prepare(`
          UPDATE onboarding_checklists
          SET body = @body, status = 'completed', row_version = 2
          WHERE id = @id AND row_version = 1 AND status = 'open'
        `).run({ body: JSON.stringify(directBody), id: checklist.id });
        expect(revision()).toBeGreaterThan(afterGuardedInsert);
        expect(await store.workflowProjectionReader.get<typeof directBody>('onboarding_checklists', checklist.id)).toEqual({
          id: checklist.id, rowVersion: 2, body: directBody
        });
      } finally {
        db.close();
      }
    } finally {
      await fixture.dispose();
    }
  });

  itSqliteBound('preserves the exact V1 body bytes and digest when applying additive migrations', async () => {
    const fixture = await createWorkflowSqliteFixture({ initialize: false });
    const payload = JSON.stringify(branch);
    const payloadDigest = createHash('sha256').update(payload, 'utf8').digest('hex');
    try {
      const legacyDb = fixture.openDatabase();
      try {
        legacyDb.exec(`
          CREATE TABLE branches (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL);
          CREATE TABLE appmeta (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), revision INTEGER NOT NULL);
          INSERT INTO appmeta (singleton, revision) VALUES (1, 17);
        `);
        legacyDb.prepare('INSERT INTO branches (id, payload) VALUES (?, ?)').run(branch.id, payload);
      } finally {
        legacyDb.close();
      }

      const store = fixture.openStore() as WorkflowStoreWithProjectionReader;
      expect(await store.get<Branch>('branches', branch.id)).toEqual(branch);
      expect(await store.workflowProjectionReader.get<Branch>('branches', branch.id)).toEqual({
        id: branch.id,
        rowVersion: 1,
        body: branch
      });

      const migratedDb = fixture.openDatabase();
      try {
        const migratedPayload = (migratedDb.prepare('SELECT payload FROM branches WHERE id = ?').get(branch.id) as { payload: string }).payload;
        expect(migratedPayload).toBe(payload);
        expect(createHash('sha256').update(migratedPayload, 'utf8').digest('hex')).toBe(payloadDigest);
        const migratedRevision = (migratedDb.prepare('SELECT revision FROM appmeta WHERE singleton = 1').get() as { revision: number }).revision;
        expect(migratedRevision).toBeGreaterThanOrEqual(17);
      } finally {
        migratedDb.close();
      }
    } finally {
      await fixture.dispose();
    }
  });

  itSqliteBound('closes the constructor database handle after incompatible migration without leaking or losing the legacy row', async () => {
    const fixture = await createWorkflowSqliteFixture({ initialize: false });
    const privateSentinel = 'legacy-private-body-sentinel-workflow-storage';
    const legacyBody = { id: 'workflow-storage-incompatible-legacy-branch', name: privateSentinel };
    const legacyPayload = JSON.stringify(legacyBody);
    try {
      const legacyDb = fixture.openDatabase();
      try {
        legacyDb.exec(`
          CREATE TABLE branches (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL);
          CREATE TABLE appmeta (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), revision INTEGER NOT NULL);
          INSERT INTO appmeta (singleton, revision) VALUES (1, 4);
        `);
        legacyDb.prepare('INSERT INTO branches (id, payload) VALUES (?, ?)').run(legacyBody.id, legacyPayload);
      } finally {
        legacyDb.close();
      }

      let migrationError: unknown;
      try {
        fixture.openStore();
      } catch (error) {
        migrationError = error;
      }
      expect(migrationError).toBeInstanceOf(Error);
      expect((migrationError as Error).message).not.toContain(privateSentinel);

      const afterFailure = fixture.openDatabase();
      try {
        expect(afterFailure.prepare('SELECT id, payload FROM branches').all()).toEqual([{
          id: legacyBody.id,
          payload: legacyPayload
        }]);
      } finally {
        afterFailure.close();
      }
    } finally {
      await fixture.dispose();
      expect(existsSync(fixture.databasePath)).toBe(false);
    }
  });

  itSqliteBound('keeps historical policy-document expected versions while allowing live updates and retaining the document-ID foreign key', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const store = fixture.store as WorkflowStoreWithProjectionReader;
      const context = await seedOnboardingContext(store, 'policy-snapshot');
      const { receipt } = await createActionExecutionCycle(store, context, 'policy-snapshot-ack');
      const policyDocument: PolicyDocument = {
        id: 'workflow-storage-policy-document',
        title: 'Reviewed workflow policy',
        version: '1.0',
        text: 'Original approved business policy text.',
        updatedAt: '2026-10-02T05:00:00.000Z'
      };
      await store.transaction(async (tx) => tx.put('policy_documents', policyDocument));

      const ref = { table: 'policy_documents' as const, id: policyDocument.id };
      const expectedRows = [{ ref, rowVersion: 1, state: null }];
      const snapshotId = 'workflow-storage-policy-review-snapshot';
      const snapshotBody = {
        id: snapshotId,
        actorId: context.managerProfile.id,
        actorSessionId: context.sessionId,
        purpose: 'manager_queue' as const,
        orgUnitIds: [context.orgUnitId],
        displayedIds: [policyDocument.id],
        count: 1,
        expectedRows,
        policy: { id: 'demo-workflow' as const, version: 1 as const, digest: digest(defaultDemoWorkflowPolicy) },
        createdAt: '2026-10-02T05:00:00.000Z',
        expiresAt: '2026-10-02T05:10:00.000Z'
      };
      const snapshot = reviewSnapshotSchema.parse({ ...snapshotBody, digest: digest(snapshotBody) });
      const target = {
        id: 'workflow-storage-policy-review-target',
        snapshotId,
        entityType: 'policy_documents',
        targetId: policyDocument.id,
        expectedRowVersion: 1,
        expectedState: null,
        ref
      };
      const acknowledgement = {
        id: 'workflow-storage-policy-acknowledgement',
        employeeId: context.employee.id,
        policyDocumentId: policyDocument.id,
        policyVersion: policyDocument.version,
        status: 'pending',
        dueDate: '2026-10-10',
        ownerIdentityId: context.managerIdentityId,
        priority: 'normal',
        reason: 'Acknowledge the reviewed workflow policy.',
        executionId: receipt.id,
        createdAt: '2026-10-02T05:00:00.000Z'
      };
      await store.workflowTransaction(async (tx) => {
        await tx.insertUnique('review_snapshots', snapshot, {
          constraint: 'review_snapshots_primary_key', values: { id: snapshot.id }
        });
        await tx.insertUnique('review_snapshot_targets', target, {
          constraint: 'review_snapshot_targets_snapshot_target_unique',
          values: { snapshotId, entityType: target.entityType, targetId: target.targetId }
        });
        await tx.insertUnique('policy_acknowledgement_tasks', acknowledgement, {
          constraint: 'policy_ack_employee_version_unique',
          values: {
            employeeId: acknowledgement.employeeId,
            policyDocumentId: acknowledgement.policyDocumentId,
            policyVersion: acknowledgement.policyVersion
          }
        });
      });

      const updatedPolicyDocument = {
        ...policyDocument,
        title: 'Updated workflow policy text',
        text: 'Legitimate current policy content update.',
        updatedAt: '2026-10-02T06:00:00.000Z'
      };
      await store.transaction(async (tx) => tx.put('policy_documents', updatedPolicyDocument));

      const currentDocument = await store.workflowProjectionReader.get<typeof updatedPolicyDocument>(
        'policy_documents', policyDocument.id
      );
      const historicalTarget = await store.workflowProjectionReader.get<typeof target>(
        'review_snapshot_targets', target.id
      );
      expect(currentDocument).toEqual({ id: policyDocument.id, rowVersion: 2, body: updatedPolicyDocument });
      expect(historicalTarget).toEqual({ id: target.id, rowVersion: 1, body: target });
      expect(historicalTarget?.body.expectedRowVersion).toBe(1);
      expect(currentDocument?.rowVersion).not.toBe(historicalTarget?.body.expectedRowVersion);

      const db = fixture.openDatabase();
      db.pragma('foreign_keys = ON');
      try {
        const foreignKeys = db.pragma('foreign_key_list(review_snapshot_targets)') as Array<{
          table: string; from: string; to: string;
        }>;
        expect(foreignKeys).toContainEqual(expect.objectContaining({
          table: 'policy_documents', from: 'policy_document_id', to: 'id'
        }));

        const wrongBusinessVersionTask = {
          ...acknowledgement,
          id: 'workflow-storage-policy-ack-wrong-business-version',
          policyVersion: '2.0'
        };
        expect(() => db.prepare(`
          INSERT INTO policy_acknowledgement_tasks (
            id, row_version, body, employee_id, policy_document_id, policy_version,
            status, due_date, execution_id
          ) VALUES (
            @id, 1, @body, @employeeId, @policyDocumentId, @policyVersion,
            @status, @dueDate, NULL
          )
        `).run({ ...wrongBusinessVersionTask, body: JSON.stringify(wrongBusinessVersionTask) })).toThrow();
      } finally {
        db.close();
      }

      const orphanTarget = {
        ...target,
        id: 'workflow-storage-orphan-policy-review-target',
        targetId: 'workflow-storage-missing-policy-document',
        ref: { table: 'policy_documents' as const, id: 'workflow-storage-missing-policy-document' }
      };
      await expect(store.workflowTransaction((tx) => tx.insertUnique('review_snapshot_targets', orphanTarget, {
        constraint: 'review_snapshot_targets_snapshot_target_unique',
        values: { snapshotId, entityType: orphanTarget.entityType, targetId: orphanTarget.targetId }
      }))).rejects.toMatchObject({ code: 'STORAGE' });
      expect(await store.workflowProjectionReader.get<typeof target>('review_snapshot_targets', target.id)).toEqual({
        id: target.id, rowVersion: 1, body: target
      });
      expect(await store.workflowProjectionReader.get<typeof acknowledgement>(
        'policy_acknowledgement_tasks', acknowledgement.id
      )).toEqual({ id: acknowledgement.id, rowVersion: 1, body: acknowledgement });
      expect(await store.workflowProjectionReader.get<typeof acknowledgement>(
        'policy_acknowledgement_tasks', 'workflow-storage-policy-ack-wrong-business-version'
      )).toBeUndefined();
    } finally {
      await fixture.dispose();
    }
  });

  itSqliteBound('enforces policy-pin logical ID, version, and digest foreign keys without changing valid public bodies', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const store = fixture.store as WorkflowStoreWithProjectionReader;
      const context = await seedOnboardingContext(store, 'policy-pin-fk');
      const canonicalPolicy = workflowPolicyRow(defaultDemoWorkflowPolicy.pendingTtlSeconds);
      const policyRecord = { ...canonicalPolicy, id: 'workflow-storage-policy-config-row' };
      const validAction = pendingActionRow(context, 'policy-pin-fk');
      const snapshotCore = {
        id: 'workflow-storage-valid-policy-pin-snapshot',
        actorId: context.managerProfile.id,
        actorSessionId: context.sessionId,
        purpose: 'manager_queue' as const,
        orgUnitIds: [context.orgUnitId],
        displayedIds: [context.request.id],
        count: 1,
        expectedRows: [{
          ref: { table: 'onboarding_requests' as const, id: context.request.id },
          rowVersion: 1,
          state: 'draft'
        }],
        policy: {
          id: 'demo-workflow' as const,
          version: 1 as const,
          digest: canonicalPolicy.digest
        },
        createdAt: '2026-10-02T05:00:00.000Z',
        expiresAt: '2026-10-02T05:10:00.000Z'
      };
      const validSnapshot = reviewSnapshotSchema.parse({
        ...snapshotCore,
        digest: digest(snapshotCore)
      });
      await store.workflowTransaction(async (tx) => {
        await tx.insertUnique('workflow_policies', policyRecord, {
          constraint: 'workflow_policies_primary_key', values: { id: policyRecord.id }
        });
        await tx.insertUnique('review_snapshots', validSnapshot, {
          constraint: 'review_snapshots_primary_key', values: { id: validSnapshot.id }
        });
        await tx.insertUnique('pending_actions', validAction, {
          constraint: 'pending_actions_primary_key', values: { id: validAction.id }
        });
      });

      const db = fixture.openDatabase();
      db.pragma('foreign_keys = ON');
      try {
        const invalidPins = [
          { id: 'workflow-storage-wrong-policy-id', pin: { ...snapshotCore.policy, id: 'another-workflow' } },
          { id: 'workflow-storage-wrong-policy-version', pin: { ...snapshotCore.policy, version: 2 } },
          { id: 'workflow-storage-wrong-policy-digest', pin: { ...snapshotCore.policy, digest: 'f'.repeat(64) } }
        ];
        const insertSnapshot = db.prepare(`
          INSERT INTO review_snapshots (
            id, row_version, body, actor_id, actor_session_id, purpose, count, digest,
            created_at, expires_at, policy_id, policy_version, policy_digest
          ) VALUES (
            @id, 1, @body, @actorId, @actorSessionId, @purpose, @count, @digest,
            @createdAt, @expiresAt, @policyId, @policyVersion, @policyDigest
          )
        `);
        const insertPendingAction = db.prepare(`
          INSERT INTO pending_actions (
            id, payload, workflow_contract_version, row_version, actor_id, session_id,
            conversation_id, reviewed_snapshot_id, status, idempotency_key, payload_hash, expires_at,
            policy_id, policy_version, policy_digest
          ) VALUES (
            @id, @payload, 2, 1, @actorId, @sessionId, @conversationId,
            @reviewedSnapshotId, @status, @idempotencyKey, @payloadHash, @expiresAt,
            @policyId, @policyVersion, @policyDigest
          )
        `);
        for (const invalid of invalidPins) {
          const core = { ...snapshotCore, id: invalid.id, policy: invalid.pin };
          const body = { ...core, digest: digest(core) };
          expect(() => insertSnapshot.run({
            id: invalid.id,
            body: JSON.stringify(body),
            actorId: body.actorId,
            actorSessionId: body.actorSessionId,
            purpose: body.purpose,
            count: body.count,
            digest: body.digest,
            createdAt: body.createdAt,
            expiresAt: body.expiresAt,
            policyId: body.policy.id,
            policyVersion: body.policy.version,
            policyDigest: body.policy.digest
          })).toThrow();

          const invalidAction = {
            ...validAction,
            id: `${invalid.id}-action`,
            policy: invalid.pin
          };
          expect(() => insertPendingAction.run({
            id: invalidAction.id,
            payload: JSON.stringify(invalidAction),
            actorId: invalidAction.actorId,
            sessionId: invalidAction.sessionId,
            conversationId: invalidAction.conversationId,
            reviewedSnapshotId: invalidAction.reviewedSnapshotId,
            status: invalidAction.status,
            idempotencyKey: invalidAction.idempotencyKey,
            payloadHash: invalidAction.payloadHash,
            expiresAt: invalidAction.expiresAt,
            policyId: invalidAction.policy.id,
            policyVersion: invalidAction.policy.version,
            policyDigest: invalidAction.policy.digest
          })).toThrow();
        }
      } finally {
        db.close();
      }

      expect(await store.workflowProjectionReader.get<WorkflowPolicyRow>('workflow_policies', policyRecord.id)).toEqual({
        id: policyRecord.id, rowVersion: 1, body: policyRecord
      });
      expect(await store.workflowProjectionReader.get<typeof validSnapshot>('review_snapshots', validSnapshot.id)).toEqual({
        id: validSnapshot.id, rowVersion: 1, body: validSnapshot
      });
      expect(await store.workflowProjectionReader.get<PendingActionV2>('pending_actions', validAction.id)).toEqual({
        id: validAction.id, rowVersion: 1, body: validAction
      });
      for (const id of [
        'workflow-storage-wrong-policy-id',
        'workflow-storage-wrong-policy-version',
        'workflow-storage-wrong-policy-digest'
      ]) {
        expect(await store.workflowProjectionReader.get('review_snapshots', id)).toBeUndefined();
        expect(await store.workflowProjectionReader.get('pending_actions', `${id}-action`)).toBeUndefined();
      }
    } finally {
      await fixture.dispose();
    }
  });

  itSqliteBound('rejects a second policy digest for the same logical ID and version while preserving the triple pin FK', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const store = fixture.store as WorkflowStoreWithProjectionReader;
      const context = await seedOnboardingContext(store, 'policy-version-unique');
      const canonical = await seedCanonicalWorkflowPolicy(store, 'policy-version-unique');
      const conflicting = {
        ...workflowPolicyRow(defaultDemoWorkflowPolicy.pendingTtlSeconds + 1),
        id: 'workflow-storage-policy-config-conflicting-digest'
      };
      const key = {
        constraint: 'workflow_policies_policy_version_unique',
        values: { 'policy.id': conflicting.policy.id, version: conflicting.version }
      };

      expect(conflicting.policy.id).toBe(canonical.policy.id);
      expect(conflicting.version).toBe(canonical.version);
      expect(conflicting.digest).not.toBe(canonical.digest);
      await expect(store.workflowTransaction((tx) => tx.insertUnique('workflow_policies', conflicting, key)))
        .rejects.toMatchObject({ code: 'CONFLICT', definitelyNotCommitted: true });
      expect(await store.workflowProjectionReader.get<WorkflowPolicyRow>('workflow_policies', canonical.id)).toEqual({
        id: canonical.id, rowVersion: 1, body: canonical
      });

      const db = fixture.openDatabase();
      db.pragma('foreign_keys = ON');
      try {
        expect(() => db.prepare(`
          INSERT INTO workflow_policies (id, row_version, body, policy_id, version, digest)
          VALUES (@id, 1, @body, @policyId, @version, @digest)
        `).run({
          id: conflicting.id,
          body: JSON.stringify(conflicting),
          policyId: conflicting.policy.id,
          version: conflicting.version,
          digest: conflicting.digest
        })).toThrow();
        expect(db.prepare(`
          SELECT id, version, digest FROM workflow_policies WHERE policy_id = ? AND version = ?
        `).all(canonical.policy.id, canonical.version)).toEqual([{
          id: canonical.id, version: canonical.version, digest: canonical.digest
        }]);
      } finally {
        db.close();
      }

      const validAction = pendingActionRow(context, 'policy-version-unique');
      expect(await store.workflowTransaction((tx) => tx.insertUnique('pending_actions', validAction, {
        constraint: 'pending_actions_primary_key', values: { id: validAction.id }
      }))).toEqual({ inserted: true, row: validAction });
      expect(await store.workflowProjectionReader.get<PendingActionV2>('pending_actions', validAction.id)).toEqual({
        id: validAction.id, rowVersion: 1, body: validAction
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('returns an identical grant for a semantic duplicate and rejects changed immutable grant data', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const store = fixture.store as WorkflowStoreWithProjectionReader;
      const { context, share } = await seedShareSecurityContext(store, 'unique-semantics');
      const key = {
        constraint: 'dashboard_shares_semantic_unique',
        values: { semanticKey: share.semanticKey }
      };

      const identical = await store.workflowTransaction((tx) => tx.insertUnique('dashboard_shares', share, key));

      expect(identical).toEqual({ inserted: false, existing: share });
      const conflicting = {
        ...share,
        id: 'workflow-storage-share-conflicting-semantics',
        senderIdentityId: context.directorIdentityId
      };
      await expect(store.workflowTransaction((tx) => tx.insertUnique('dashboard_shares', conflicting, key)))
        .rejects.toMatchObject({ code: 'CONFLICT', definitelyNotCommitted: true });
      expect(await store.workflowProjectionReader.get<DashboardShareV2>('dashboard_shares', share.id)).toEqual({
        id: share.id,
        rowVersion: 1,
        body: share
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('rolls back every guarded write when a core postcondition throws after staged effects', async () => {
    const fixture = await createWorkflowSqliteFixture();
    const expected = Object.assign(
      new DomainError('CONFLICT', 'simulated core target-set postcondition failure', 409),
      { definitelyNotCommitted: true }
    );
    try {
      const store = fixture.store as WorkflowStoreWithProjectionReader;
      const context = await seedOnboardingContext(store, 'rollback');
      const { receipt } = await createActionExecutionCycle(store, context, 'rollback');
      const { employee, managerIdentityId, request } = context;
      const task = {
        id: 'workflow-storage-task-rollback', requestId: request.id, employeeId: employee.id,
        ownerIdentityId: managerIdentityId, templateId: 'hr_welcome', status: 'open',
        rowVersion: 1, title: 'Welcome checklist task', dueDate: '2026-10-18',
        priority: 'normal', reason: 'Complete the reviewed onboarding task.', executionId: receipt.id
      };
      const checklist = {
        id: 'workflow-storage-checklist-rollback', requestId: request.id,
        templateId: 'hr_welcome', status: 'open', title: 'Welcome checklist',
        executionId: receipt.id,
        createdAt: '2026-10-02T05:00:00.000Z'
      };

      const failure = await store.workflowTransaction(async (tx) => {
        await tx.insertUnique('onboarding_tasks', task, {
          constraint: 'onboarding_tasks_primary_key', values: { id: task.id }
        });
        await tx.insertUnique('onboarding_checklists', checklist, {
          constraint: 'onboarding_checklists_primary_key', values: { id: checklist.id }
        });
        throw expected;
      }).then(() => undefined, (error: unknown) => error);

      expect(failure).toBe(expected);
      expect(failure).toMatchObject({ code: 'CONFLICT', status: 409, definitelyNotCommitted: true });
      expect(await store.get<typeof task>('onboarding_tasks', task.id)).toBeUndefined();
      expect(await store.get<typeof checklist>('onboarding_checklists', checklist.id)).toBeUndefined();
      expect(await store.workflowProjectionReader.get<typeof task>('onboarding_tasks', task.id)).toBeUndefined();
      expect(await store.workflowProjectionReader.get<typeof checklist>('onboarding_checklists', checklist.id)).toBeUndefined();
    } finally {
      await fixture.dispose();
    }
  });

  it('promotes an unannotated DomainError after confirmed guarded rollback', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const store = fixture.store as WorkflowStoreWithProjectionReader;
      const context = await seedOnboardingContext(store, 'domain-error-certainty');
      const { receipt } = await createActionExecutionCycle(store, context, 'domain-error-certainty');
      const task = {
        id: 'workflow-storage-task-domain-error-certainty',
        requestId: context.request.id,
        employeeId: context.employee.id,
        ownerIdentityId: context.managerIdentityId,
        templateId: 'hr_welcome',
        status: 'open',
        rowVersion: 1,
        title: 'Domain error rollback task',
        dueDate: '2026-10-18',
        priority: 'normal',
        reason: 'Complete the reviewed onboarding task.',
        executionId: receipt.id
      };
      const domainError = new DomainError('STALE_ACTION', 'The reviewed source version is stale.', 409);
      const readRevision = (): number => {
        const db = fixture.openDatabase();
        try {
          return (db.prepare('SELECT revision FROM appmeta WHERE singleton = 1').get() as { revision: number }).revision;
        } finally {
          db.close();
        }
      };
      const revisionBefore = readRevision();

      const failure = await store.workflowTransaction(async (tx) => {
        await tx.insertUnique('onboarding_tasks', task, {
          constraint: 'onboarding_tasks_primary_key', values: { id: task.id }
        });
        throw domainError;
      }).then(() => undefined, (error: unknown) => error);

      expect(failure).toBeInstanceOf(DomainError);
      expect(failure).toMatchObject({ code: 'STALE_ACTION', status: 409, definitelyNotCommitted: true });
      expect(await store.get<typeof task>('onboarding_tasks', task.id)).toBeUndefined();
      expect(await store.workflowProjectionReader.get<typeof task>('onboarding_tasks', task.id)).toBeUndefined();
      expect(readRevision()).toBe(revisionBefore);
    } finally {
      await fixture.dispose();
    }
  });

  itSqliteBound('rolls back and remains reopenable when workflow write-flag setup fails', async () => {
    const fixture = await createWorkflowSqliteFixture();
    const policy = workflowPolicyRow(defaultDemoWorkflowPolicy.pendingTtlSeconds);
    const key = {
      constraint: 'workflow_policies_primary_key',
      values: { id: policy.id }
    };
    try {
      const store = fixture.store as WorkflowStoreWithProjectionReader;
      const setup = fixture.openDatabase();
      setup.exec(`
        CREATE TRIGGER fail_workflow_adapter_write_setup
        BEFORE UPDATE OF workflow_adapter_write ON appmeta
        WHEN NEW.workflow_adapter_write = 1
        BEGIN SELECT RAISE(ABORT, 'injected workflow write flag setup failure'); END;
      `);
      setup.close();

      let callbackRuns = 0;
      await expect(store.workflowTransaction(async (tx) => {
        callbackRuns += 1;
        return tx.insertUnique('workflow_policies', policy, key);
      })).rejects.toThrow();
      expect(callbackRuns).toBe(0);

      const inspect = fixture.openDatabase();
      inspect.pragma('foreign_keys = ON');
      try {
        expect(inspect.prepare('SELECT workflow_adapter_write FROM appmeta WHERE singleton = 1').get())
          .toEqual({ workflow_adapter_write: 0 });
        expect(inspect.prepare('SELECT COUNT(*) AS count FROM workflow_policies WHERE id = ?').get(policy.id))
          .toEqual({ count: 0 });
        inspect.exec('DROP TRIGGER fail_workflow_adapter_write_setup');
      } finally {
        inspect.close();
      }

      const reopened = fixture.reopen() as WorkflowStoreWithProjectionReader;
      await expect(reopened.workflowTransaction((tx) => tx.insertUnique('workflow_policies', policy, key)))
        .resolves.toEqual({ inserted: true, row: policy });
      expect(await reopened.workflowProjectionReader.get<WorkflowPolicyRow>('workflow_policies', policy.id)).toEqual({
        id: policy.id, rowVersion: 1, body: policy
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('does not expose V1 put/remove on the guarded transaction object', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const store = fixture.store as WorkflowStoreWithProjectionReader;
      await store.workflowTransaction(async (tx) => {
        expect('put' in tx).toBe(false);
        expect('remove' in tx).toBe(false);
      });
    } finally {
      await fixture.dispose();
    }
  });

  itSqliteBound('enforces one open restock per branch/product in SQL and reopens only under a fresh lifecycle', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const store = fixture.store as WorkflowStoreWithProjectionReader;
      const context = await seedOnboardingContext(store, 'restock-lifecycle');
      const product: Product = {
        id: 'workflow-storage-restock-product', name: 'Restock fixture product', category: 'beverage'
      };
      const snapshots: Inventory[] = [1, 2, 3].map((day) => ({
        id: `workflow-storage-restock-snapshot-${day}`,
        branchId: context.branchRow.id,
        productId: product.id,
        date: `2026-10-0${day}`,
        onHand: 1,
        minimum: 4,
        observedAt: `2026-10-0${day}T05:00:00.000Z`,
        updatedAt: `2026-10-0${day}T05:00:00.000Z`
      }));
      await store.transaction(async (tx) => {
        await tx.put('products', product);
        for (const snapshot of snapshots) await tx.put('inventory_snapshots', snapshot);
      });

      const first = {
        id: 'workflow-storage-restock-first',
        branchId: context.branchRow.id,
        productId: product.id,
        inventorySnapshotId: snapshots[0].id,
        ownerIdentityId: context.managerIdentityId,
        replenishmentLifecycleId: 'workflow-storage-restock-lifecycle-1',
        quantity: 8,
        status: 'open',
        rowVersion: 1,
        dueDate: '2026-10-10',
        priority: 'normal',
        reason: 'Restore the synthetic stock minimum.',
        createdAt: '2026-10-02T05:00:00.000Z'
      };
      await store.workflowTransaction((tx) => tx.insertUnique('restock_requests', first, {
        constraint: 'restock_requests_primary_key', values: { id: first.id }
      }));

      const directDuplicate = {
        ...first,
        id: 'workflow-storage-restock-direct-duplicate',
        inventorySnapshotId: snapshots[1].id,
        replenishmentLifecycleId: 'workflow-storage-restock-lifecycle-2'
      };
      const db = fixture.openDatabase();
      db.pragma('foreign_keys = ON');
      try {
        expect(() => db.prepare(`
          INSERT INTO restock_requests (
            id, row_version, body, branch_id, product_id, inventory_snapshot_id,
            owner_identity_id, replenishment_lifecycle_id, quantity, status, due_date
          ) VALUES (
            @id, 1, @body, @branchId, @productId, @inventorySnapshotId,
            @ownerIdentityId, @replenishmentLifecycleId, @quantity, @status, @dueDate
          )
        `).run({ ...directDuplicate, body: JSON.stringify(directDuplicate) })).toThrow();
      } finally {
        db.close();
      }
      expect(await store.workflowProjectionReader.query<typeof first>({
        kind: 'unique', table: 'restock_requests', constraint: 'restock_requests_open_product_unique',
        values: { branchId: first.branchId, productId: first.productId }
      })).toEqual([{ id: first.id, rowVersion: 1, body: first }]);

      const nextLifecycle = {
        ...first,
        id: 'workflow-storage-restock-next-lifecycle',
        inventorySnapshotId: snapshots[2].id,
        replenishmentLifecycleId: 'workflow-storage-restock-lifecycle-2'
      };
      const staged = await store.workflowTransaction(async (tx) => {
        const projectionReader = (tx as WorkflowTransactionWithProjectionReader).workflowProjectionReader;
        const openKey = {
          kind: 'unique' as const,
          table: 'restock_requests' as const,
          constraint: 'restock_requests_open_product_unique',
          values: { branchId: first.branchId, productId: first.productId }
        };
        const before = await projectionReader.query<typeof first>(openKey);
        const closed = await tx.compareAndSwap('restock_requests', first.id,
          { rowVersion: 1, state: 'open' },
          { ...first, rowVersion: 2, status: 'cancelled' });
        const afterClose = await projectionReader.query<typeof first>(openKey);
        const inserted = await tx.insertUnique('restock_requests', nextLifecycle, {
          constraint: 'restock_requests_open_product_unique',
          values: { branchId: nextLifecycle.branchId, productId: nextLifecycle.productId }
        });
        const afterInsert = await projectionReader.query<typeof nextLifecycle>(openKey);
        return { before, closed, afterClose, inserted, afterInsert };
      });

      expect(staged.before).toEqual([{ id: first.id, rowVersion: 1, body: first }]);
      expect(staged.closed).toEqual({ updated: true, row: { ...first, rowVersion: 2, status: 'cancelled' } });
      expect(staged.afterClose).toEqual([]);
      expect(staged.inserted).toEqual({ inserted: true, row: nextLifecycle });
      expect(staged.afterInsert).toEqual([{ id: nextLifecycle.id, rowVersion: 1, body: nextLifecycle }]);
      expect(await store.workflowProjectionReader.get<typeof first>('restock_requests', first.id)).toEqual({
        id: first.id, rowVersion: 2, body: { ...first, rowVersion: 2, status: 'cancelled' }
      });
      expect(await store.workflowProjectionReader.get<typeof nextLifecycle>('restock_requests', nextLifecycle.id)).toEqual({
        id: nextLifecycle.id, rowVersion: 1, body: nextLifecycle
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('projects and freshly reads the current idempotency-root status after guarded CAS', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const store = fixture.store as WorkflowStoreWithProjectionReader;
      const context = await seedOnboardingContext(store, 'root-status');
      const { root } = await createActionExecutionCycle(store, context, 'root-status');

      const before = await store.workflowProjectionReader.get<typeof root>('action_idempotency_roots', root.id);
      expect(before).toEqual({ id: root.id, rowVersion: 1, body: root });

      const completedRoot = { ...root, rowVersion: 2, status: 'completed' };
      expect(await store.workflowTransaction((tx) => tx.compareAndSwap(
        'action_idempotency_roots', root.id,
        { rowVersion: 1, state: 'open' },
        completedRoot
      ))).toEqual({ updated: true, row: completedRoot });

      const current = await store.workflowProjectionReader.get<typeof completedRoot>('action_idempotency_roots', root.id);
      expect(current).toEqual({ id: root.id, rowVersion: 2, body: completedRoot });
      const db = fixture.openDatabase();
      try {
        expect(db.prepare('SELECT status, row_version FROM action_idempotency_roots WHERE id = ?').get(root.id))
          .toEqual({ status: 'completed', row_version: 2 });
      } finally {
        db.close();
      }
    } finally {
      await fixture.dispose();
    }
  });

  it('commits exactly one idempotency root and one execution through the deferred foreign-key cycle', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const store = fixture.store as WorkflowStoreWithProjectionReader;
      const context = await seedOnboardingContext(store, 'root-cycle');
      const { action, root, receipt } = await createActionExecutionCycle(store, context, 'root-cycle');

      expect(await store.workflowProjectionReader.get<typeof root>('action_idempotency_roots', root.id)).toEqual({
        id: root.id, rowVersion: 1, body: root
      });
      expect(await store.workflowProjectionReader.get<WorkflowReceiptV2>('action_executions', receipt.id)).toEqual({
        id: receipt.id, rowVersion: 1, body: receipt
      });

      const db = fixture.openDatabase();
      try {
        const rootCount = (db.prepare('SELECT COUNT(*) AS count FROM action_idempotency_roots WHERE id = ?').get(root.id) as { count: number }).count;
        const executionCount = (db.prepare('SELECT COUNT(*) AS count FROM action_executions WHERE id = ?').get(receipt.id) as { count: number }).count;
        const pendingCount = (db.prepare('SELECT COUNT(*) AS count FROM pending_actions WHERE id = ? AND workflow_contract_version = 2').get(action.id) as { count: number }).count;
        const executionMetadata = db.prepare('SELECT root_id, attempt, workflow_contract_version FROM action_executions WHERE id = ?').get(receipt.id);
        expect(rootCount).toBe(1);
        expect(executionCount).toBe(1);
        expect(pendingCount).toBe(1);
        expect(executionMetadata).toEqual({ root_id: root.id, attempt: 1, workflow_contract_version: 2 });
      } finally {
        db.close();
      }
    } finally {
      await fixture.dispose();
    }
  });

  it('rejects malformed external root-attempt keys before lookup and preserves the existing cycle', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const store = fixture.store as WorkflowStoreWithProjectionReader;
      const context = await seedOnboardingContext(store, 'external-key-validation');
      const { root, receipt } = await createActionExecutionCycle(store, context, 'external-key-validation');
      const revisionBefore = (() => {
        const db = fixture.openDatabase();
        try {
          return (db.prepare('SELECT revision FROM appmeta WHERE singleton = 1').get() as { revision: number }).revision;
        } finally {
          db.close();
        }
      })();
      const invalidKeys = [
        { suffix: 'string-attempt', values: { rootId: root.id, attempt: '1' } },
        { suffix: 'numeric-root-id', values: { rootId: 17, attempt: 1 } }
      ];

      for (const invalid of invalidKeys) {
        const candidate = { ...receipt, id: `workflow-storage-execution-invalid-${invalid.suffix}` };
        const failure = await store.workflowTransaction((tx) => tx.insertUnique('action_executions', candidate, {
          constraint: 'action_executions_root_attempt_unique', values: invalid.values
        })).then(() => undefined, (error: unknown) => error);
        expect(failure).toMatchObject({ code: 'STORAGE', definitelyNotCommitted: true });
        expect(await store.workflowProjectionReader.get<WorkflowReceiptV2>(
          'action_executions', candidate.id
        )).toBeUndefined();
        expect(await store.workflowProjectionReader.get<WorkflowReceiptV2>(
          'action_executions', receipt.id
        )).toEqual({ id: receipt.id, rowVersion: 1, body: receipt });
        expect(await store.workflowProjectionReader.get<typeof root>(
          'action_idempotency_roots', root.id
        )).toEqual({ id: root.id, rowVersion: 1, body: root });
      }

      const retry = { ...receipt, id: 'workflow-storage-execution-valid-external-retry' };
      expect(await store.workflowTransaction((tx) => tx.insertUnique('action_executions', retry, {
        constraint: 'action_executions_root_attempt_unique',
        values: { rootId: root.id, attempt: 1 }
      }))).toEqual({ inserted: false, existing: receipt });

      const db = fixture.openDatabase();
      try {
        const executions = db.prepare(`
          SELECT id, row_version, payload, workflow_contract_version, root_id, attempt
          FROM action_executions WHERE root_id = ? ORDER BY attempt
        `).all(root.id) as Array<{
          id: string; row_version: number; payload: string; workflow_contract_version: number; root_id: string; attempt: number
        }>;
        expect(executions).toHaveLength(1);
        expect(executions[0]).toMatchObject({
          id: receipt.id, row_version: 1, workflow_contract_version: 2, root_id: root.id, attempt: 1
        });
        expect(JSON.parse(executions[0].payload)).toEqual(receipt);
        expect(db.prepare('SELECT row_version, status, active_execution_id FROM action_idempotency_roots WHERE id = ?')
          .get(root.id)).toEqual({ row_version: 1, status: 'open', active_execution_id: receipt.id });
        expect(db.prepare('SELECT revision FROM appmeta WHERE singleton = 1').get())
          .toEqual({ revision: revisionBefore });
      } finally {
        db.close();
      }
    } finally {
      await fixture.dispose();
    }
  });

  it('rolls back the pending action and root when the deferred active-execution foreign key is unresolved at commit', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const store = fixture.store as WorkflowStoreWithProjectionReader;
      const context = await seedOnboardingContext(store, 'missing-execution');
      await seedCanonicalWorkflowPolicy(store, 'missing-execution');
      const action = pendingActionRow(context, 'missing-execution');
      const missingExecutionId = 'workflow-storage-missing-execution';
      const root = {
        id: 'workflow-storage-root-missing-execution',
        actionId: action.id,
        actorId: action.actorId,
        idempotencyKey: action.idempotencyKey,
        activeExecutionId: missingExecutionId,
        rowVersion: 1,
        status: 'open',
        createdAt: '2026-10-02T05:00:00.000Z'
      };
      let callbackReturned = false;

      await expect(store.workflowTransaction(async (tx) => {
        await tx.insertUnique('pending_actions', action, {
          constraint: 'pending_actions_primary_key', values: { id: action.id }
        });
        await tx.insertUnique('action_idempotency_roots', root, {
          constraint: 'action_idempotency_roots_key_unique',
          values: { idempotencyKey: action.idempotencyKey }
        });
        callbackReturned = true;
      })).rejects.toThrow();
      expect(callbackReturned).toBe(true);
      expect(await store.workflowProjectionReader.get<PendingActionV2>('pending_actions', action.id)).toBeUndefined();
      expect(await store.workflowProjectionReader.get<typeof root>('action_idempotency_roots', root.id)).toBeUndefined();
      expect(await store.workflowProjectionReader.get<WorkflowReceiptV2>('action_executions', missingExecutionId)).toBeUndefined();

      const db = fixture.openDatabase();
      try {
        const pendingCount = (db.prepare('SELECT COUNT(*) AS count FROM pending_actions WHERE id = ?').get(action.id) as { count: number }).count;
        const rootCount = (db.prepare('SELECT COUNT(*) AS count FROM action_idempotency_roots WHERE id = ?').get(root.id) as { count: number }).count;
        const executionCount = (db.prepare('SELECT COUNT(*) AS count FROM action_executions WHERE id = ?').get(missingExecutionId) as { count: number }).count;
        expect({ pendingCount, rootCount, executionCount }).toEqual({ pendingCount: 0, rootCount: 0, executionCount: 0 });
      } finally {
        db.close();
      }
    } finally {
      await fixture.dispose();
    }
  });

  itSqliteBound('uses the canonical discount, offboarding-case, and offboarding-plan creation statuses', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const store = fixture.store as WorkflowStoreWithProjectionReader;
      const context = await seedOnboardingContext(store, 'lifecycle-statuses');
      const secondEmployee: Employee = {
        id: 'workflow-storage-offboarding-employee-2',
        name: 'Second offboarding fixture employee',
        branchId: context.branchRow.id,
        active: true
      };
      await store.transaction(async (tx) => tx.put('employees', secondEmployee));

      const customerId = 'workflow-storage-discount-customer';
      const alternateCustomerId = 'workflow-storage-discount-customer-2';
      const opportunityId = 'workflow-storage-discount-opportunity';
      const alternateOpportunityId = 'workflow-storage-discount-opportunity-2';
      const discount = {
        id: 'workflow-storage-discount-request', opportunityId,
        ownerIdentityId: context.managerIdentityId, status: 'manager_review_pending',
        discountBasisPoints: 500, baseAmountSatang: 100_000, expiresAt: '2026-10-10T05:00:00.000Z',
        reason: 'Request a reviewed synthetic discount.', createdAt: '2026-10-02T05:00:00.000Z'
      };
      const offboardingCase = {
        id: 'workflow-storage-offboarding-case', employeeId: context.employee.id,
        ownerIdentityId: context.managerIdentityId, status: 'active',
        lifecycleId: 'workflow-storage-offboarding-lifecycle', lastDay: '2026-10-15',
        reason: 'Employee departure review.', createdAt: '2026-10-02T05:00:00.000Z',
        updatedAt: '2026-10-02T05:00:00.000Z'
      };
      const plan = {
        id: 'workflow-storage-offboarding-plan', caseId: offboardingCase.id,
        purpose: 'standard_offboarding', status: 'prepared', createdAt: '2026-10-02T05:00:00.000Z',
        employeeSnapshot: {
          id: context.employee.id, name: context.employee.name, branchId: context.employee.branchId,
          active: context.employee.active, rowVersion: 1
        },
        assetAssignmentIds: [] as string[]
      };
      await store.workflowTransaction(async (tx) => {
        await tx.insertUnique('crm_customers', {
          id: customerId, ownerIdentityId: context.managerIdentityId,
          name: 'Discount fixture customer', status: 'active', createdAt: '2026-10-02T05:00:00.000Z'
        }, { constraint: 'crm_customers_primary_key', values: { id: customerId } });
        await tx.insertUnique('crm_customers', {
          id: alternateCustomerId, ownerIdentityId: context.managerIdentityId,
          name: 'Alternate discount fixture customer', status: 'active', createdAt: '2026-10-02T05:00:00.000Z'
        }, { constraint: 'crm_customers_primary_key', values: { id: alternateCustomerId } });
        await tx.insertUnique('crm_opportunities', {
          id: opportunityId, customerId, ownerIdentityId: context.managerIdentityId,
          title: 'Discount fixture opportunity', stage: 'prospecting', amountSatang: 100_000,
          createdAt: '2026-10-02T05:00:00.000Z'
        }, { constraint: 'crm_opportunities_primary_key', values: { id: opportunityId } });
        await tx.insertUnique('crm_opportunities', {
          id: alternateOpportunityId, customerId: alternateCustomerId,
          ownerIdentityId: context.managerIdentityId, title: 'Alternate discount fixture opportunity',
          stage: 'prospecting', amountSatang: 120_000, createdAt: '2026-10-02T05:00:00.000Z'
        }, { constraint: 'crm_opportunities_primary_key', values: { id: alternateOpportunityId } });
        await tx.insertUnique('discount_requests', discount, {
          constraint: 'discount_requests_primary_key', values: { id: discount.id }
        });
        await tx.insertUnique('offboarding_cases', offboardingCase, {
          constraint: 'offboarding_cases_primary_key', values: { id: offboardingCase.id }
        });
        await tx.insertUnique('offboarding_plans', plan, {
          constraint: 'offboarding_plans_case_purpose_unique',
          values: { caseId: plan.caseId, purpose: plan.purpose }
        });
      });

      const invalidDiscount = {
        ...discount,
        id: 'workflow-storage-invalid-discount-status',
        opportunityId: alternateOpportunityId,
        status: 'pending'
      };
      const invalidCase = {
        ...offboardingCase,
        id: 'workflow-storage-invalid-offboarding-case-status',
        employeeId: secondEmployee.id,
        lifecycleId: 'workflow-storage-invalid-offboarding-lifecycle',
        status: 'open'
      };
      const invalidPlan = {
        ...plan,
        id: 'workflow-storage-invalid-offboarding-plan-status',
        purpose: 'alternate_plan_purpose',
        status: 'active'
      };
      const db = fixture.openDatabase();
      db.pragma('foreign_keys = ON');
      try {
        expect(() => db.prepare(`
          INSERT INTO discount_requests (
            id, row_version, body, opportunity_id, owner_identity_id, status,
            discount_basis_points, expires_at
          ) VALUES (@id, 1, @body, @opportunityId, @ownerIdentityId, @status, @discountBasisPoints, @expiresAt)
        `).run({ ...invalidDiscount, body: JSON.stringify(invalidDiscount) })).toThrow();
        expect(() => db.prepare(`
          INSERT INTO offboarding_cases (
            id, row_version, body, employee_id, owner_identity_id, status, lifecycle_id, last_day
          ) VALUES (@id, 1, @body, @employeeId, @ownerIdentityId, @status, @lifecycleId, @lastDay)
        `).run({ ...invalidCase, body: JSON.stringify(invalidCase) })).toThrow();
        expect(() => db.prepare(`
          INSERT INTO offboarding_plans (id, row_version, body, case_id, purpose, status, execution_id)
          VALUES (@id, 1, @body, @caseId, @purpose, @status, NULL)
        `).run({ ...invalidPlan, body: JSON.stringify(invalidPlan) })).toThrow();
      } finally {
        db.close();
      }

      expect((await store.workflowProjectionReader.get<typeof discount>('discount_requests', discount.id))?.body.status)
        .toBe('manager_review_pending');
      expect((await store.workflowProjectionReader.get<typeof offboardingCase>('offboarding_cases', offboardingCase.id))?.body.status)
        .toBe('active');
      expect((await store.workflowProjectionReader.get<typeof plan>('offboarding_plans', plan.id))?.body.status)
        .toBe('prepared');
      expect(await store.workflowProjectionReader.get<typeof invalidDiscount>('discount_requests', invalidDiscount.id)).toBeUndefined();
      expect(await store.workflowProjectionReader.get<typeof invalidCase>('offboarding_cases', invalidCase.id)).toBeUndefined();
      expect(await store.workflowProjectionReader.get<typeof invalidPlan>('offboarding_plans', invalidPlan.id)).toBeUndefined();
    } finally {
      await fixture.dispose();
    }
  });

  it('rejects a V2 idempotency root whose active execution is a legacy V1 receipt', async () => {
    const fixture = await createWorkspaceFixture();
    try {
      const store = fixture.store as WorkflowStoreWithProjectionReader;
      const legacyAction = await fixture.service.prepare(actors.executive, dashboardPayload('east'));
      await fixture.service.confirm(actors.executive, legacyAction.id);
      const legacyExecutions = await store.list<{ id: string; actionId?: string }>('action_executions');
      const legacyExecution = legacyExecutions.find((row) => row.actionId === legacyAction.id);
      if (!legacyExecution) throw new Error('The V1 dashboard fixture did not persist its execution receipt.');

      const context = await seedOnboardingContext(store, 'root-v1-execution');
      await seedCanonicalWorkflowPolicy(store, 'root-v1-execution');
      const action = pendingActionRow(context, 'root-v1-execution');
      const root = {
        id: 'workflow-storage-root-v1-execution',
        actionId: action.id,
        actorId: action.actorId,
        idempotencyKey: action.idempotencyKey,
        activeExecutionId: legacyExecution.id,
        rowVersion: 1,
        status: 'open',
        createdAt: '2026-10-02T05:00:00.000Z'
      };
      let callbackReturned = false;

      await expect(store.workflowTransaction(async (tx) => {
        await tx.insertUnique('pending_actions', action, {
          constraint: 'pending_actions_primary_key', values: { id: action.id }
        });
        await tx.insertUnique('action_idempotency_roots', root, {
          constraint: 'action_idempotency_roots_key_unique',
          values: { idempotencyKey: action.idempotencyKey }
        });
        callbackReturned = true;
      })).rejects.toThrow();
      expect(callbackReturned).toBe(true);
      expect(await store.get('action_executions', legacyExecution.id)).toEqual(legacyExecution);
      expect(await store.workflowProjectionReader.get('action_executions', legacyExecution.id)).toBeUndefined();
      expect(await store.workflowProjectionReader.get<PendingActionV2>('pending_actions', action.id)).toBeUndefined();
      expect(await store.workflowProjectionReader.get<typeof root>('action_idempotency_roots', root.id)).toBeUndefined();
    } finally {
      await fixture.dispose();
    }
  });

  itSqliteBound('rejects invalid SQL versions, statuses, and mismatched body projections', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const store = fixture.store as WorkflowStoreWithProjectionReader;
      const context = await seedOnboardingContext(store, 'checks');
      const { request } = context;
      const { receipt } = await createActionExecutionCycle(store, context, 'checks-checklist');
      const policy = workflowPolicyRow(defaultDemoWorkflowPolicy.pendingTtlSeconds);
      const db = fixture.openDatabase();
      db.pragma('foreign_keys = ON');
      try {
        const insertPolicy = db.prepare(`
          INSERT INTO workflow_policies (id, row_version, body, version, digest)
          VALUES (@id, @rowVersion, @body, @version, @digest)
        `);
        expect(() => insertPolicy.run({
          id: 'workflow-storage-invalid-row-version', rowVersion: 0,
          body: JSON.stringify(policy), version: policy.version, digest: policy.digest
        })).toThrow();
        expect(() => insertPolicy.run({
          id: 'workflow-storage-invalid-policy-version', rowVersion: 1,
          body: JSON.stringify({ ...policy, version: 0 }), version: 0, digest: policy.digest
        })).toThrow();
        expect(() => insertPolicy.run({
          id: 'workflow-storage-projection-id-mismatch', rowVersion: 1,
          body: JSON.stringify({ ...policy, id: 'workflow-storage-body-id-mismatch' }),
          version: policy.version, digest: policy.digest
        })).toThrow();
        expect(() => insertPolicy.run({
          id: 'workflow-storage-projection-version-mismatch', rowVersion: 1,
          body: JSON.stringify({ ...policy, rowVersion: 2 }), version: policy.version, digest: policy.digest
        })).toThrow();

        const invalidChecklist = {
          id: 'workflow-storage-invalid-checklist-status', requestId: request.id,
          templateId: 'hr_welcome', status: 'corrupt', executionId: receipt.id
        };
        expect(() => db.prepare(`
          INSERT INTO onboarding_checklists (id, row_version, body, request_id, template_id, status)
          VALUES (@id, 1, @body, @requestId, @templateId, @status)
        `).run({
          id: invalidChecklist.id, body: JSON.stringify(invalidChecklist), requestId: request.id,
          templateId: invalidChecklist.templateId, status: invalidChecklist.status
        })).toThrow();
      } finally {
        db.close();
      }
    } finally {
      await fixture.dispose();
    }
  });

  itSqliteBound('enforces foreign keys for direct SQL writes and prevents deletion of referenced workflow history', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const store = fixture.store as WorkflowStoreWithProjectionReader;
      const context = await seedOnboardingContext(store, 'foreign-key');
      const { request } = context;
      const { receipt } = await createActionExecutionCycle(store, context, 'foreign-key-checklist');
      const orphan = {
        id: 'workflow-storage-orphan-checklist', requestId: 'workflow-storage-missing-request',
        templateId: 'hr_welcome', status: 'open', executionId: receipt.id
      };
      const db = fixture.openDatabase();
      db.pragma('foreign_keys = ON');
      try {
        expect(() => db.prepare(`
          INSERT INTO onboarding_checklists (id, row_version, body, request_id, template_id, status)
          VALUES (@id, 1, @body, @requestId, @templateId, @status)
        `).run({
          id: orphan.id, body: JSON.stringify(orphan), requestId: orphan.requestId,
          templateId: orphan.templateId, status: orphan.status
        })).toThrow();
      } finally {
        db.close();
      }

      const child = {
        id: 'workflow-storage-referenced-checklist', requestId: request.id,
        templateId: 'hr_welcome', status: 'open', executionId: receipt.id
      };
      await store.workflowTransaction((tx) => tx.insertUnique('onboarding_checklists', child, {
        constraint: 'onboarding_checklists_primary_key', values: { id: child.id }
      }));

      const deletion = fixture.openDatabase();
      deletion.pragma('foreign_keys = ON');
      try {
        expect(() => deletion.prepare('DELETE FROM onboarding_requests WHERE id = ?').run(request.id)).toThrow();
      } finally {
        deletion.close();
      }
      expect(await store.get<typeof child>('onboarding_checklists', child.id)).toEqual(child);
      expect(await store.get<typeof request>('onboarding_requests', request.id)).toEqual(request);
    } finally {
      await fixture.dispose();
    }
  });

  it('keeps insert→CAS and sequential CAS intents at each expected row version', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const store = fixture.store as WorkflowStoreWithProjectionReader;
      const context = await seedOnboardingContext(store, 'cas');
      const { employee, managerIdentityId, request } = context;
      const { receipt } = await createActionExecutionCycle(store, context, 'cas-task');
      const task = {
        id: 'workflow-storage-task-cas', requestId: request.id, employeeId: employee.id,
        ownerIdentityId: managerIdentityId, templateId: 'hr_welcome', status: 'open',
        rowVersion: 1, title: 'Welcome checklist task', dueDate: '2026-10-18',
        priority: 'normal', reason: 'Complete the reviewed onboarding task.', executionId: receipt.id
      };

      const outcomes = await store.workflowTransaction(async (tx) => {
        const inserted = await tx.insertUnique('onboarding_tasks', task, {
          constraint: 'onboarding_tasks_primary_key', values: { id: task.id }
        });
        const firstCas = await tx.compareAndSwap('onboarding_tasks', task.id,
          { rowVersion: 1, state: 'open' },
          { ...task, rowVersion: 2, status: 'in_progress' });
        const secondCas = await tx.compareAndSwap('onboarding_tasks', task.id,
          { rowVersion: 2, state: 'in_progress' },
          { ...task, rowVersion: 3, status: 'completed', completedAt: '2026-10-02T06:00:00.000Z' });
        return { inserted, firstCas, secondCas };
      });

      expect(outcomes.inserted).toEqual({ inserted: true, row: task });
      expect(outcomes.firstCas).toEqual({ updated: true, row: { ...task, rowVersion: 2, status: 'in_progress' } });
      expect(outcomes.secondCas).toEqual({
        updated: true,
        row: { ...task, rowVersion: 3, status: 'completed', completedAt: '2026-10-02T06:00:00.000Z' }
      });
      const current = await store.workflowProjectionReader.get<typeof task & { completedAt: string }>('onboarding_tasks', task.id);
      expect(current).toEqual({
        id: task.id,
        rowVersion: 3,
        body: { ...task, rowVersion: 3, status: 'completed', completedAt: '2026-10-02T06:00:00.000Z' }
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('rejects V1 mutations of a V2 pending action while preserving legacy V1 rows', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const store = fixture.store as WorkflowStoreWithProjectionReader;
      const context = await seedOnboardingContext(store, 'mixed-row');
      const legacy = legacyPendingActionRow(context, 'workflow-storage-legacy-pending-action', 'V1 body');
      await store.transaction(async (tx) => tx.put('pending_actions', legacy));
      await seedCanonicalWorkflowPolicy(store, 'mixed-row');
      expect(await store.get<typeof legacy>('pending_actions', legacy.id)).toEqual(legacy);

      const action = pendingActionRow(context, 'mixed-row');
      const inserted = await store.workflowTransaction((tx) => tx.insertUnique('pending_actions', action, {
        constraint: 'pending_actions_primary_key', values: { id: action.id }
      }));
      expect(inserted).toEqual({ inserted: true, row: action });

      await expect(store.transaction(async (tx) => tx.put('pending_actions', { ...action, status: 'claimed' })))
        .rejects.toThrow();
      await expect(store.transaction(async (tx) => tx.remove('pending_actions', action.id)))
        .rejects.toThrow();

      expect(await store.get<PendingActionV2>('pending_actions', action.id)).toBeUndefined();
      expect(await store.list<typeof legacy>('pending_actions')).toEqual([legacy]);
      expect(await store.workflowProjectionReader.get<PendingActionV2>('pending_actions', action.id)).toEqual({
        id: action.id,
        rowVersion: 1,
        body: action
      });
      expect(await store.get<typeof legacy>('pending_actions', legacy.id)).toEqual(legacy);
    } finally {
      await fixture.dispose();
    }
  });

  itSqliteBound('rejects markerless V2 pending actions through V1 put and direct SQL while retaining ordinary V1 rows', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const store = fixture.store as WorkflowStoreWithProjectionReader;
      const context = await seedOnboardingContext(store, 'markerless-v2');
      const legacy = legacyPendingActionRow(context, 'workflow-storage-markerless-legacy', 'V1 body');
      await store.transaction(async (tx) => tx.put('pending_actions', legacy));
      const action = pendingActionRow(context, 'markerless-v2');

      await expect(store.transaction(async (tx) => tx.put('pending_actions', action))).rejects.toThrow();
      const db = fixture.openDatabase();
      db.pragma('foreign_keys = ON');
      try {
        expect(() => db.prepare(`
          INSERT INTO pending_actions (
            id, payload, workflow_contract_version, row_version, actor_id, session_id,
            conversation_id, reviewed_snapshot_id, status, idempotency_key, payload_hash
          ) VALUES (
            @id, @payload, NULL, 1, @actorId, @sessionId, @conversationId,
            @reviewedSnapshotId, @status, @idempotencyKey, @payloadHash
          )
        `).run({
          id: action.id,
          payload: JSON.stringify(action),
          actorId: action.actorId,
          sessionId: action.sessionId,
          conversationId: action.conversationId,
          reviewedSnapshotId: action.reviewedSnapshotId,
          status: action.status,
          idempotencyKey: action.idempotencyKey,
          payloadHash: action.payloadHash
        })).toThrow();
      } finally {
        db.close();
      }

      const legacyExecutionParent = legacyPendingActionRow(
        context, 'workflow-storage-markerless-execution-parent', 'V1 action body'
      );
      await store.transaction(async (tx) => tx.put('pending_actions', legacyExecutionParent));
      const markerlessReceipt: WorkflowReceiptV2 = workflowReceiptV2Schema.parse({
        id: 'workflow-storage-markerless-v2-execution',
        actionId: legacyExecutionParent.id,
        contractVersion: 2,
        actorId: context.managerProfile.id,
        kind: 'investigation_create',
        outcome: 'pending',
        proofs: [],
        createdAt: '2026-10-02T05:00:00.000Z',
        verifiedAt: null,
        currentStates: []
      });
      const executionDb = fixture.openDatabase();
      executionDb.pragma('foreign_keys = ON');
      try {
        expect(() => executionDb.prepare(`
          INSERT INTO action_executions (
            id, payload, workflow_contract_version, row_version, action_id,
            root_id, attempt, outcome, execution_id, created_at
          ) VALUES (
            @id, @payload, NULL, 1, @actionId, @rootId, 1, @outcome, NULL, @createdAt
          )
        `).run({
          id: markerlessReceipt.id,
          payload: JSON.stringify(markerlessReceipt),
          actionId: markerlessReceipt.actionId,
          rootId: 'workflow-storage-markerless-v2-execution-root',
          outcome: markerlessReceipt.outcome,
          createdAt: markerlessReceipt.createdAt
        })).toThrow(/V2 body requires protected marker/);
        expect(executionDb.prepare('SELECT COUNT(*) AS count FROM action_executions WHERE id = ?')
          .get(markerlessReceipt.id)).toEqual({ count: 0 });
      } finally {
        executionDb.close();
      }
      await expect(store.transaction(async (tx) => tx.put('action_executions', markerlessReceipt))).rejects.toThrow();
      expect(await store.get<WorkflowReceiptV2>('action_executions', markerlessReceipt.id)).toBeUndefined();

      expect(await store.get<PendingActionV2>('pending_actions', action.id)).toBeUndefined();
      expect(await store.workflowProjectionReader.get<PendingActionV2>('pending_actions', action.id)).toBeUndefined();
      expect(await store.get<typeof legacy>('pending_actions', legacy.id)).toEqual(legacy);
      const legacyRows = await store.list<typeof legacy>('pending_actions');
      expect(legacyRows).toHaveLength(2);
      expect(legacyRows).toEqual(expect.arrayContaining([legacy, legacyExecutionParent]));
    } finally {
      await fixture.dispose();
    }
  });

  itSqliteBound('rejects markerless audit correlationId presence, including null, while preserving a genuine V1 audit', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const store = fixture.store as WorkflowStoreWithProjectionReader;
      const context = await seedOnboardingContext(store, 'audit-markerless');
      const { action, receipt } = await createActionExecutionCycle(store, context, 'audit-markerless');
      const legacyAudit = {
        id: 'workflow-storage-legacy-audit-without-correlation',
        actorId: context.managerProfile.id,
        category: 'workflow_action',
        summary: 'Preserve this legacy audit body without a V2 correlation key.',
        createdAt: '2026-10-02T05:00:00.000Z'
      };
      await store.transaction((tx) => tx.put('audit_events', legacyAudit));

      const markerlessAudit = {
        id: 'workflow-storage-markerless-audit-correlation-null',
        actorId: context.managerProfile.id,
        category: 'workflow_action',
        summary: 'A present null correlation key still marks a V2-shaped audit.',
        actionId: action.id,
        executionId: receipt.id,
        createdAt: '2026-10-02T05:01:00.000Z',
        correlationId: null,
        targetRefs: [],
        outcome: 'committed'
      };
      await expect(store.transaction((tx) => tx.put('audit_events', markerlessAudit)))
        .rejects.toMatchObject({ code: 'STORAGE' });

      const db = fixture.openDatabase();
      db.pragma('foreign_keys = ON');
      try {
        expect(() => db.prepare(`
          INSERT INTO audit_events (
            id, payload, workflow_contract_version, row_version,
            actor_id, action_id, execution_id, category, created_at, correlation_id
          ) VALUES (
            @id, @payload, NULL, 1,
            @actorId, @actionId, @executionId, @category, @createdAt, NULL
          )
        `).run({
          id: markerlessAudit.id,
          payload: JSON.stringify(markerlessAudit),
          actorId: markerlessAudit.actorId,
          actionId: markerlessAudit.actionId,
          executionId: markerlessAudit.executionId,
          category: markerlessAudit.category,
          createdAt: markerlessAudit.createdAt
        })).toThrow(/V2 body requires protected marker/);
        expect(db.prepare('SELECT COUNT(*) AS count FROM audit_events WHERE id = ?').get(markerlessAudit.id))
          .toEqual({ count: 0 });
      } finally {
        db.close();
      }

      expect(await store.get<typeof legacyAudit>('audit_events', legacyAudit.id)).toEqual(legacyAudit);
      expect(await store.list<typeof legacyAudit>('audit_events')).toEqual([legacyAudit]);
      expect(await store.get('audit_events', markerlessAudit.id)).toBeUndefined();
      expect(await store.workflowProjectionReader.get('audit_events', markerlessAudit.id)).toBeUndefined();
    } finally {
      await fixture.dispose();
    }
  });

  itSqliteBound('requires correlationId for protected marker-2 audit writes at adapter and SQL boundaries', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const store = fixture.store as WorkflowStoreWithProjectionReader;
      const context = await seedOnboardingContext(store, 'audit-required-correlation');
      const { action, receipt } = await createActionExecutionCycle(store, context, 'audit-required-correlation');
      const missingCorrelationAudit = {
        id: 'workflow-storage-audit-missing-correlation',
        actorId: context.managerProfile.id,
        category: 'workflow_action',
        summary: 'A protected audit must include its correlation identifier.',
        actionId: action.id,
        executionId: receipt.id,
        createdAt: '2026-10-02T05:02:00.000Z',
        targetRefs: [],
        outcome: 'committed'
      };
      await expect(store.workflowTransaction((tx) => tx.insertUnique('audit_events', missingCorrelationAudit, {
        constraint: 'audit_events_primary_key', values: { id: missingCorrelationAudit.id }
      }))).rejects.toMatchObject({ code: 'STORAGE' });

      const db = fixture.openDatabase();
      db.pragma('foreign_keys = ON');
      try {
        expect(() => db.prepare(`
          INSERT INTO audit_events (
            id, payload, workflow_contract_version, row_version,
            actor_id, action_id, execution_id, category, created_at, correlation_id
          ) VALUES (
            @id, @payload, 2, 1,
            @actorId, @actionId, @executionId, @category, @createdAt, NULL
          )
        `).run({
          id: missingCorrelationAudit.id,
          payload: JSON.stringify(missingCorrelationAudit),
          actorId: missingCorrelationAudit.actorId,
          actionId: missingCorrelationAudit.actionId,
          executionId: missingCorrelationAudit.executionId,
          category: missingCorrelationAudit.category,
          createdAt: missingCorrelationAudit.createdAt
        })).toThrow();
        expect(db.prepare('SELECT COUNT(*) AS count FROM audit_events WHERE id = ?')
          .get(missingCorrelationAudit.id)).toEqual({ count: 0 });
      } finally {
        db.close();
      }

      const validAudit = {
        ...missingCorrelationAudit,
        id: 'workflow-storage-audit-valid-correlation',
        correlationId: 'workflow-storage-audit-correlation-01'
      };
      expect(await store.workflowTransaction((tx) => tx.insertUnique('audit_events', validAudit, {
        constraint: 'audit_events_primary_key', values: { id: validAudit.id }
      }))).toEqual({ inserted: true, row: validAudit });
      expect(await store.workflowProjectionReader.get<typeof validAudit>('audit_events', validAudit.id)).toEqual({
        id: validAudit.id, rowVersion: 1, body: validAudit
      });
      expect(await store.get('audit_events', validAudit.id)).toBeUndefined();
    } finally {
      await fixture.dispose();
    }
  });

  itSqliteBound('binds incident escalation events to a V2 execution and the team_requested stage', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const store = fixture.store as WorkflowStoreWithProjectionReader;
      const context = await seedOnboardingContext(store, 'incident-escalation');
      const lifecycleId = 'workflow-storage-incident-lifecycle-incident-escalation';
      const incident: IncidentEscalationProjectionBody = {
        id: 'workflow-storage-escalation-incident',
        branchId: context.branchRow.id,
        date: '2026-10-01',
        title: 'Synthetic operations incident',
        kind: 'operations',
        status: 'open',
        startedAt: '2026-10-01T08:00:00.000Z',
        endedAt: null,
        updatedAt: '2026-10-02T05:00:00.000Z',
        escalationStage: 'un_escalated',
        escalationLifecycleId: lifecycleId,
        escalationEventId: null
      };
      await store.transaction(async (tx) => tx.put('incidents', incident));
      await store.workflowTransaction((tx) => tx.insertUnique('workflow_teams', {
        id: 'demo_operations', name: 'Demo operations', active: true
      }, { constraint: 'workflow_teams_primary_key', values: { id: 'demo_operations' } }));

      const action = incidentEscalationActionRow(context, 'incident-escalation', incident.id);
      const { receipt } = await createActionExecutionCycle(store, context, 'incident-escalation', action);
      const event = {
        id: 'workflow-storage-incident-event-incident-escalation',
        incidentId: incident.id,
        teamId: 'demo_operations',
        actorId: context.managerProfile.id,
        stage: 'team_requested',
        lifecycleId,
        executionId: receipt.id,
        reason: 'Escalate the reviewed synthetic incident.',
        evidenceIds: ['workflow-storage-incident-evidence-incident-escalation'],
        createdAt: '2026-10-02T05:00:00.000Z'
      };
      await store.workflowTransaction(async (tx) => {
        await tx.insertUnique('incident_escalation_events', event, {
          constraint: 'incident_escalation_lifecycle_stage_unique',
          values: { incidentId: event.incidentId, lifecycleId: event.lifecycleId, stage: event.stage }
        });
        const updated = await tx.compareAndSwap('incidents', incident.id,
          { rowVersion: 1, state: 'open' },
          {
            ...incident,
            rowVersion: 2,
            escalationStage: 'team_requested',
            escalationEventId: event.id,
            updatedAt: '2026-10-02T06:00:00.000Z'
          });
        expect(updated.updated).toBe(true);
      });

      const missingExecutionEvent = {
        ...event,
        id: 'workflow-storage-incident-event-missing-execution',
        lifecycleId: `${lifecycleId}-missing-execution`,
        executionId: 'workflow-storage-no-execution'
      };
      await expect(store.workflowTransaction((tx) => tx.insertUnique('incident_escalation_events', missingExecutionEvent, {
        constraint: 'incident_escalation_lifecycle_stage_unique',
        values: {
          incidentId: missingExecutionEvent.incidentId,
          lifecycleId: missingExecutionEvent.lifecycleId,
          stage: missingExecutionEvent.stage
        }
      }))).rejects.toMatchObject({ code: 'STORAGE' });

      const invalidStageEvent = {
        ...event,
        id: 'workflow-storage-incident-event-invalid-stage',
        lifecycleId: `${lifecycleId}-invalid-stage`,
        stage: 'another_stage'
      };
      const db = fixture.openDatabase();
      db.pragma('foreign_keys = ON');
      try {
        expect(() => db.prepare(`
          INSERT INTO incident_escalation_events (
            id, row_version, body, incident_id, team_id, actor_id, stage, lifecycle_id, execution_id
          ) VALUES (
            @id, 1, @body, @incidentId, @teamId, @actorId, @stage, @lifecycleId, @executionId
          )
        `).run({ ...invalidStageEvent, body: JSON.stringify(invalidStageEvent) })).toThrow();
      } finally {
        db.close();
      }

      expect(await store.workflowProjectionReader.get<typeof event>('incident_escalation_events', event.id)).toEqual({
        id: event.id, rowVersion: 1, body: event
      });
      expect(await store.workflowProjectionReader.get<typeof missingExecutionEvent>(
        'incident_escalation_events', missingExecutionEvent.id
      )).toBeUndefined();
      expect(await store.workflowProjectionReader.get<typeof invalidStageEvent>(
        'incident_escalation_events', invalidStageEvent.id
      )).toBeUndefined();
    } finally {
      await fixture.dispose();
    }
  });

  it('rejects an incident effect that references a V1 receipt while preserving both receipt generations', async () => {
    const fixture = await createWorkspaceFixture();
    try {
      const store = fixture.store as WorkflowStoreWithProjectionReader;
      const legacyAction = await fixture.service.prepare(actors.executive, dashboardPayload('east'));
      await fixture.service.confirm(actors.executive, legacyAction.id);
      const legacyExecutions = await store.list<{ id: string; actionId?: string }>('action_executions');
      const legacyReceipt = legacyExecutions.find((row) => row.actionId === legacyAction.id);
      if (!legacyReceipt) throw new Error('The V1 fixture did not persist its legacy execution receipt.');

      const context = await seedOnboardingContext(store, 'incident-legacy-execution');
      const suffix = 'incident-legacy-execution';
      const validLifecycleId = `workflow-storage-incident-lifecycle-${suffix}`;
      const incident: IncidentEscalationProjectionBody = {
        id: 'workflow-storage-incident-legacy-execution',
        branchId: context.branchRow.id,
        date: '2026-10-01',
        title: 'Legacy receipt reference fixture incident',
        kind: 'operations',
        status: 'open',
        startedAt: '2026-10-01T08:00:00.000Z',
        endedAt: null,
        updatedAt: '2026-10-02T05:00:00.000Z',
        escalationStage: 'un_escalated',
        escalationLifecycleId: validLifecycleId,
        escalationEventId: null
      };
      const v1IncidentLifecycleId = 'workflow-storage-incident-lifecycle-v1-execution-rejected';
      const v1Incident: IncidentEscalationProjectionBody = {
        ...incident,
        id: 'workflow-storage-incident-legacy-execution-v1',
        escalationLifecycleId: v1IncidentLifecycleId
      };
      await store.transaction(async (tx) => {
        await tx.put('incidents', incident);
        await tx.put('incidents', v1Incident);
      });
      await store.workflowTransaction((tx) => tx.insertUnique('workflow_teams', {
        id: 'demo_operations', name: 'Demo operations', active: true
      }, { constraint: 'workflow_teams_primary_key', values: { id: 'demo_operations' } }));

      const action = incidentEscalationActionRow(context, suffix, incident.id);
      const { receipt: v2Receipt } = await createActionExecutionCycle(store, context, suffix, action);
      const validEvent = {
        id: `workflow-storage-incident-event-${suffix}`,
        incidentId: incident.id,
        teamId: 'demo_operations',
        actorId: context.managerProfile.id,
        stage: 'team_requested',
        lifecycleId: validLifecycleId,
        executionId: v2Receipt.id,
        reason: 'Escalate the reviewed synthetic incident.',
        evidenceIds: [`workflow-storage-incident-evidence-${suffix}`],
        createdAt: '2026-10-02T05:00:00.000Z'
      };
      await store.workflowTransaction(async (tx) => {
        await tx.insertUnique('incident_escalation_events', validEvent, {
          constraint: 'incident_escalation_lifecycle_stage_unique',
          values: { incidentId: validEvent.incidentId, lifecycleId: validEvent.lifecycleId, stage: validEvent.stage }
        });
        const updated = await tx.compareAndSwap('incidents', incident.id,
          { rowVersion: 1, state: 'open' },
          {
            ...incident,
            rowVersion: 2,
            escalationStage: 'team_requested',
            escalationEventId: validEvent.id,
            updatedAt: '2026-10-02T06:00:00.000Z'
          });
        expect(updated.updated).toBe(true);
      });

      const invalidEvent = {
        ...validEvent,
        id: 'workflow-storage-incident-event-v1-execution-rejected',
        incidentId: v1Incident.id,
        lifecycleId: v1IncidentLifecycleId,
        executionId: legacyReceipt.id
      };
      await expect(store.workflowTransaction((tx) => tx.insertUnique('incident_escalation_events', invalidEvent, {
        constraint: 'incident_escalation_lifecycle_stage_unique',
        values: { incidentId: invalidEvent.incidentId, lifecycleId: invalidEvent.lifecycleId, stage: invalidEvent.stage }
      }))).rejects.toMatchObject({ code: 'STORAGE' });

      expect(await store.workflowProjectionReader.get<typeof validEvent>(
        'incident_escalation_events', validEvent.id
      )).toEqual({ id: validEvent.id, rowVersion: 1, body: validEvent });
      expect(await store.workflowProjectionReader.get<typeof invalidEvent>(
        'incident_escalation_events', invalidEvent.id
      )).toBeUndefined();
      expect(await store.get('action_executions', legacyReceipt.id)).toEqual(legacyReceipt);
      expect(await store.workflowProjectionReader.get('action_executions', legacyReceipt.id)).toBeUndefined();
      expect(await store.workflowProjectionReader.get<WorkflowReceiptV2>(
        'action_executions', v2Receipt.id
      )).toEqual({ id: v2Receipt.id, rowVersion: 1, body: v2Receipt });
    } finally {
      await fixture.dispose();
    }
  });

  itSqliteBound('treats a null approvedBranchIds key as a markerless V2 share while retaining legacy shares without it', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const store = fixture.store as WorkflowStoreWithProjectionReader;
      const { context, share } = await seedShareSecurityContext(store, 'markerless-share-null-scope');
      const legacyShare = {
        id: 'workflow-storage-legacy-share-no-scope-key',
        dashboardId: share.dashboardId,
        recipientId: context.directorProfile.id,
        actorId: context.managerProfile.id,
        active: true,
        operationKey: 'workflow-storage-legacy-share-no-scope-key-operation',
        createdAt: '2026-10-02T05:00:00.000Z'
      };
      await store.transaction((tx) => tx.put('dashboard_shares', legacyShare));

      const markerlessShare = {
        ...legacyShare,
        id: 'workflow-storage-markerless-share-null-scope',
        operationKey: 'workflow-storage-markerless-share-null-scope-operation',
        approvedBranchIds: null
      };
      await expect(store.transaction((tx) => tx.put('dashboard_shares', markerlessShare)))
        .rejects.toMatchObject({ code: 'STORAGE' });

      const db = fixture.openDatabase();
      db.pragma('foreign_keys = ON');
      try {
        // Install the production SQL functions on this separate connection before exercising its guards.
        applyWorkflowSqliteMigrations(db);
        expect(() => db.prepare(`
          INSERT INTO dashboard_shares (
            id, payload, workflow_contract_version, row_version,
            dashboard_id, recipient_id, actor_id, active, operation_key, created_at
          ) VALUES (
            @id, @payload, NULL, 1,
            @dashboardId, @recipientId, @actorId, 1, @operationKey, @createdAt
          )
        `).run({
          id: markerlessShare.id,
          payload: JSON.stringify(markerlessShare),
          dashboardId: markerlessShare.dashboardId,
          recipientId: markerlessShare.recipientId,
          actorId: markerlessShare.actorId,
          operationKey: markerlessShare.operationKey,
          createdAt: markerlessShare.createdAt
        })).toThrow(/V2 body requires protected marker/);
        expect(db.prepare('SELECT COUNT(*) AS count FROM dashboard_shares WHERE id = ?')
          .get(markerlessShare.id)).toEqual({ count: 0 });
      } finally {
        db.close();
      }

      expect(await store.get<typeof legacyShare>('dashboard_shares', legacyShare.id)).toEqual(legacyShare);
      expect(await store.list<typeof legacyShare>('dashboard_shares')).toEqual([legacyShare]);
      expect(await store.get('dashboard_shares', markerlessShare.id)).toBeUndefined();
      expect(await store.workflowProjectionReader.get('dashboard_shares', markerlessShare.id)).toBeUndefined();
    } finally {
      await fixture.dispose();
    }
  });

  itSqliteBound('keeps dashboard grant identity and child scope rows immutable at the SQL boundary', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const store = fixture.store as WorkflowStoreWithProjectionReader;
      const { context, action, root, receipt, share, scopeChild } = await seedShareSecurityContext(store, 'immutable');
      const db = fixture.openDatabase();
      db.pragma('foreign_keys = ON');
      try {
        const changedSender = { ...share, senderIdentityId: context.directorIdentityId, rowVersion: 2 };
        expect(() => db.prepare(`
          UPDATE dashboard_shares
          SET payload = @payload, sender_identity_id = @senderIdentityId, row_version = 2
          WHERE id = @id
        `).run({
          payload: JSON.stringify(changedSender), senderIdentityId: changedSender.senderIdentityId,
          id: share.id
        })).toThrow();

        expect(() => db.prepare('DELETE FROM share_scope_branches WHERE id = ?').run(scopeChild.id)).toThrow();
      } finally {
        db.close();
      }

      expect(await store.workflowProjectionReader.get<DashboardShareV2>('dashboard_shares', share.id)).toEqual({
        id: share.id, rowVersion: 1, body: share
      });
      expect(await store.workflowProjectionReader.get<typeof action>('pending_actions', action.id)).toEqual({
        id: action.id, rowVersion: 1, body: action
      });
      expect(await store.workflowProjectionReader.get<typeof root>('action_idempotency_roots', root.id)).toEqual({
        id: root.id, rowVersion: 1, body: root
      });
      expect(await store.workflowProjectionReader.get<WorkflowReceiptV2>('action_executions', receipt.id)).toEqual({
        id: receipt.id, rowVersion: 1, body: receipt
      });
      expect(await store.get<typeof scopeChild>('share_scope_branches', scopeChild.id)).toEqual(scopeChild);
    } finally {
      await fixture.dispose();
    }
  });

  it('stale CAS reports current row and leaves persisted body/version unchanged', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const store = fixture.store as WorkflowStoreWithProjectionReader;
      const context = await seedOnboardingContext(store, 'stale-cas');
      const { employee, managerIdentityId, request } = context;
      const { receipt } = await createActionExecutionCycle(store, context, 'stale-cas-task');
      const task = {
        id: 'workflow-storage-task-stale-cas', requestId: request.id, employeeId: employee.id,
        ownerIdentityId: managerIdentityId, templateId: 'hr_welcome', status: 'open',
        rowVersion: 1, title: 'Welcome checklist task', dueDate: '2026-10-18',
        priority: 'normal', reason: 'Complete the reviewed onboarding task.', executionId: receipt.id
      };
      await store.workflowTransaction(async (tx) => {
        await tx.insertUnique('onboarding_tasks', task, {
          constraint: 'onboarding_tasks_primary_key', values: { id: task.id }
        });
        await tx.compareAndSwap('onboarding_tasks', task.id,
          { rowVersion: 1, state: 'open' },
          { ...task, rowVersion: 2, status: 'in_progress' });
      });

      const stale = await store.workflowTransaction((tx) => tx.compareAndSwap('onboarding_tasks', task.id,
        { rowVersion: 1, state: 'open' },
        { ...task, rowVersion: 2, status: 'completed' }));
      const current = await store.workflowProjectionReader.get<typeof task>('onboarding_tasks', task.id);

      expect(stale).toEqual({ updated: false, current: { ...task, rowVersion: 2, status: 'in_progress' } });
      expect(current).toEqual({
        id: task.id,
        rowVersion: 2,
        body: { ...task, rowVersion: 2, status: 'in_progress' }
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('rejects a stale expected state when the CAS row version still matches', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const store = fixture.store as WorkflowStoreWithProjectionReader;
      const context = await seedOnboardingContext(store, 'state-only-cas');
      const { employee, managerIdentityId, request } = context;
      const { receipt } = await createActionExecutionCycle(store, context, 'state-only-cas-task');
      const task = {
        id: 'workflow-storage-task-state-only-cas', requestId: request.id, employeeId: employee.id,
        ownerIdentityId: managerIdentityId, templateId: 'hr_welcome', status: 'open',
        rowVersion: 1, title: 'Welcome checklist task', dueDate: '2026-10-18',
        priority: 'normal', reason: 'Complete the reviewed onboarding task.', executionId: receipt.id
      };
      await store.workflowTransaction((tx) => tx.insertUnique('onboarding_tasks', task, {
        constraint: 'onboarding_tasks_primary_key', values: { id: task.id }
      }));

      const stale = await store.workflowTransaction((tx) => tx.compareAndSwap('onboarding_tasks', task.id,
        { rowVersion: 1, state: 'in_progress' },
        { ...task, rowVersion: 2, status: 'completed' }));
      expect(stale).toEqual({ updated: false, current: task });
      expect(await store.workflowProjectionReader.get<typeof task>('onboarding_tasks', task.id)).toEqual({
        id: task.id, rowVersion: 1, body: task
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('marks invalid CAS versions and strict bodies definitely uncommitted and rolls back staged inserts', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const store = fixture.store as WorkflowStoreWithProjectionReader;
      const context = await seedOnboardingContext(store, 'cas-certainty');
      const { receipt } = await createActionExecutionCycle(store, context, 'cas-certainty');
      const currentReceipt = { id: receipt.id, rowVersion: 1, body: receipt };
      const readRevision = (): number => {
        const db = fixture.openDatabase();
        try {
          return (db.prepare('SELECT revision FROM appmeta WHERE singleton = 1').get() as { revision: number }).revision;
        } finally {
          db.close();
        }
      };
      const revisionBefore = readRevision();
      const versionTask = {
        id: 'workflow-storage-task-invalid-cas-version', requestId: context.request.id,
        employeeId: context.employee.id, ownerIdentityId: context.managerIdentityId,
        templateId: 'hr_welcome', status: 'open', rowVersion: 1,
        title: 'Version rejection rollback task', dueDate: '2026-10-18',
        priority: 'normal', reason: 'Complete the reviewed onboarding task.', executionId: receipt.id
      };
      const invalidVersionReceipt = { ...receipt, rowVersion: 3, outcome: 'failed' as const };
      const versionFailure = await store.workflowTransaction(async (tx) => {
        await tx.insertUnique('onboarding_tasks', versionTask, {
          constraint: 'onboarding_tasks_primary_key', values: { id: versionTask.id }
        });
        return tx.compareAndSwap('action_executions', receipt.id,
          { rowVersion: 1, state: 'pending' }, invalidVersionReceipt);
      }).then(() => undefined, (error: unknown) => error);
      expect(versionFailure).toMatchObject({ code: 'STORAGE', definitelyNotCommitted: true });
      expect(await store.workflowProjectionReader.get<typeof versionTask>(
        'onboarding_tasks', versionTask.id
      )).toBeUndefined();
      expect(await store.workflowProjectionReader.get<WorkflowReceiptV2>(
        'action_executions', receipt.id
      )).toEqual(currentReceipt);
      expect(readRevision()).toBe(revisionBefore);

      const bodyTask = {
        ...versionTask,
        id: 'workflow-storage-task-invalid-cas-body'
      };
      const invalidBodyReceipt = {
        ...receipt,
        rowVersion: 2,
        outcome: 'failed' as const,
        unexpectedBodyField: 'strict receipt bodies reject unknown fields'
      };
      const bodyFailure = await store.workflowTransaction(async (tx) => {
        await tx.insertUnique('onboarding_tasks', bodyTask, {
          constraint: 'onboarding_tasks_primary_key', values: { id: bodyTask.id }
        });
        return tx.compareAndSwap('action_executions', receipt.id,
          { rowVersion: 1, state: 'pending' }, invalidBodyReceipt);
      }).then(() => undefined, (error: unknown) => error);
      expect(bodyFailure).toMatchObject({ code: 'STORAGE', definitelyNotCommitted: true });
      expect(await store.workflowProjectionReader.get<typeof bodyTask>(
        'onboarding_tasks', bodyTask.id
      )).toBeUndefined();
      expect(await store.workflowProjectionReader.get<WorkflowReceiptV2>(
        'action_executions', receipt.id
      )).toEqual(currentReceipt);
      expect(readRevision()).toBe(revisionBefore);
    } finally {
      await fixture.dispose();
    }
  });

  itSqliteBound('classifies a native deferred FK failure at legacy transaction commit as definitely uncommitted', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const store = fixture.store;
      const orphanBranch = {
        id: 'workflow-storage-legacy-branch-deferred-fk',
        name: 'Branch with a missing organization parent',
        region: 'east',
        orgUnitId: 'workflow-storage-missing-org-parent'
      };
      const beforeDb = fixture.openDatabase();
      let revisionBefore = 0;
      try {
        const branchDefinition = beforeDb.prepare(`
          SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'branches'
        `).get() as { sql: string };
        expect(branchDefinition.sql).toMatch(/org_unit_id.*org_units.*DEFERRABLE INITIALLY DEFERRED/i);
        revisionBefore = (beforeDb.prepare('SELECT revision FROM appmeta WHERE singleton = 1').get() as { revision: number }).revision;
      } finally {
        beforeDb.close();
      }

      let callbackReturned = false;
      const failure = await store.transaction(async (tx) => {
        await tx.put('branches', orphanBranch);
        callbackReturned = true;
      }).then(() => undefined, (error: unknown) => error);

      expect(callbackReturned).toBe(true);
      expect(failure).toMatchObject({ code: 'STORAGE', definitelyNotCommitted: true });
      expect(await store.get('branches', orphanBranch.id)).toBeUndefined();

      const afterDb = fixture.openDatabase();
      try {
        expect(afterDb.prepare('SELECT COUNT(*) AS count FROM branches WHERE id = ?').get(orphanBranch.id))
          .toEqual({ count: 0 });
        expect(afterDb.prepare('SELECT revision FROM appmeta WHERE singleton = 1').get())
          .toEqual({ revision: revisionBefore });
        expect(afterDb.pragma('foreign_key_check')).toEqual([]);
      } finally {
        afterDb.close();
      }
    } finally {
      await fixture.dispose();
    }
  });
});
