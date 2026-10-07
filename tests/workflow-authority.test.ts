import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createWorkflowSqliteFixture } from './helpers/workflow-storage';
import {
  authorizeWorkflowScope,
  reloadWorkflowPrincipal,
  type WorkflowScopeRequest
} from '../lib/workflows/authority';
import type { WorkflowTransactionContext } from '../lib/storage/workflow-projections';
import type { GuardedTransaction, Responsibility, RoleV2 } from '../lib/workflows/contracts';

const NOW = '2026-10-03T00:00:00.000Z';
const VALID_UNTIL = '2026-10-03T00:10:00.000Z';
const DIRECTOR_APPROVE = 'hr.onboarding.director_approve';
const MANAGER_APPROVE = 'hr.onboarding.manager_approve';
const ONBOARDING_START = 'hr.onboarding.start';

type Fixture = Awaited<ReturnType<typeof createWorkflowSqliteFixture>>;
type Scenario = Awaited<ReturnType<typeof createAuthorityScenario>>;
type AuthorityPurpose = Responsibility['purpose'];

function assertWorkflowTransactionContext(
  tx: GuardedTransaction
): asserts tx is WorkflowTransactionContext {
  const candidate = tx as GuardedTransaction & { workflowProjectionReader?: unknown };
  const reader = candidate.workflowProjectionReader;
  if (
    typeof reader !== 'object'
    || reader === null
    || typeof (reader as { get?: unknown }).get !== 'function'
    || typeof (reader as { query?: unknown }).query !== 'function'
  ) {
    throw new Error('The SQLite workflow transaction did not expose its projected reader');
  }
}

interface ScenarioOptions {
  directoryRole?: RoleV2;
  purpose?: AuthorityPurpose;
  permission?: string;
  permissions?: string[];
  profileActive?: boolean;
  directoryActive?: boolean;
  orgUnitActive?: boolean;
  responsibilityActive?: boolean;
  profileRegions?: string[];
  branchRegion?: string;
  sessionExpiresAt?: string;
  responsibilityId?: string;
  responsibilityBranchIds?: string[];
  directoryProfileMismatch?: boolean;
  withAncestorUnit?: boolean;
}

async function createAuthorityScenario(options: ScenarioOptions = {}) {
  const fixture = await createWorkflowSqliteFixture();
  const suffix = randomUUID();
  const profileId = `authority-profile-${suffix}`;
  const alternateProfileId = `authority-alternate-profile-${suffix}`;
  const sessionId = `authority-session-${suffix}`;
  const identityId = `authority-identity-${suffix}`;
  const orgUnitId = `authority-org-${suffix}`;
  const ancestorOrgUnitId = `authority-ancestor-org-${suffix}`;
  const branchId = `authority-branch-${suffix}`;
  const responsibilityId = options.responsibilityId ?? `authority-responsibility-${suffix}`;
  const purpose = options.purpose ?? 'director_onboarding';
  const permission = options.permission ?? DIRECTOR_APPROVE;
  const directoryRole = options.directoryRole ?? 'hr_director';
  const profile = {
    id: profileId,
    name: 'Authority fixture profile',
    role: 'hr_admin' as const,
    active: options.profileActive ?? true,
    permissions: options.permissions ?? [permission],
    regions: options.profileRegions ?? ['east']
  };
  const alternateProfile = {
    id: alternateProfileId,
    name: 'Authority fixture alternate profile',
    role: 'hr_admin' as const,
    active: true,
    permissions: [],
    regions: ['east']
  };
  const session = {
    id: sessionId,
    profileId,
    mode: 'scripted_demo' as const,
    modeRevision: 0,
    csrfToken: `csrf-${suffix}`,
    expiresAt: options.sessionExpiresAt ?? VALID_UNTIL
  };
  const orgUnit = {
    id: orgUnitId,
    name: `Authority fixture org ${suffix}`,
    parentOrgUnitId: options.withAncestorUnit ? ancestorOrgUnitId : null,
    active: options.orgUnitActive ?? true
  };
  const ancestorOrgUnit = {
    id: ancestorOrgUnitId,
    name: `Authority fixture ancestor ${suffix}`,
    parentOrgUnitId: null,
    active: true
  };
  const branch = {
    id: branchId,
    name: `Authority fixture branch ${suffix}`,
    region: options.branchRegion ?? 'east',
    orgUnitId
  };
  const directory = {
    id: identityId,
    profileId: options.directoryProfileMismatch ? alternateProfileId : profileId,
    displayName: 'Authority fixture directory identity',
    active: options.directoryActive ?? true,
    role: directoryRole,
    department: 'hr' as const,
    orgUnitId,
    managerIdentityId: null,
    verifiedDemoEmail: `authority-${suffix}@example.invalid`,
    slackIdentity: null,
    allowedChannels: ['simulated_email'] as const,
    classificationCeiling: 'internal' as const,
    rowVersion: 1
  };
  const responsibility = {
    id: responsibilityId,
    identityId,
    orgUnitId,
    purpose,
    branchIds: options.responsibilityBranchIds ?? [branchId],
    active: options.responsibilityActive ?? true,
    rowVersion: 1
  };

  try {
    await fixture.store.transaction(async (tx) => {
      await tx.put('profiles', profile);
      if (options.directoryProfileMismatch) await tx.put('profiles', alternateProfile);
      await tx.put('sessions', session);
    });
    await fixture.store.workflowTransaction(async (tx) => {
      if (options.withAncestorUnit) {
        await tx.insertUnique('org_units', ancestorOrgUnit, {
          constraint: 'org_units_primary_key', values: { id: ancestorOrgUnitId }
        });
      }
      await tx.insertUnique('org_units', orgUnit, {
        constraint: 'org_units_primary_key', values: { id: orgUnitId }
      });
    });
    await fixture.store.transaction((tx) => tx.put('branches', branch));
    await fixture.store.workflowTransaction(async (tx) => {
      await tx.insertUnique('directory_identities', directory, {
        constraint: 'directory_identities_primary_key', values: { id: identityId }
      });
      await tx.insertUnique('responsibilities', responsibility, {
        constraint: responsibility.active
          ? 'responsibilities_open_identity_purpose_unique'
          : 'responsibilities_primary_key',
        values: responsibility.active
          ? { identityId, purpose, orgUnitId }
          : { id: responsibilityId }
      });
    });
  } catch (error) {
    await fixture.dispose();
    throw error;
  }

  return {
    fixture,
    profile,
    alternateProfile,
    session,
    directory,
    responsibility,
    orgUnit,
    ancestorOrgUnit,
    branch,
    profileId,
    alternateProfileId,
    sessionId,
    identityId,
    orgUnitId,
    ancestorOrgUnitId,
    branchId,
    responsibilityId,
    directoryRole,
    purpose,
    permission
  };
}

async function withScenario<T>(
  options: ScenarioOptions,
  run: (scenario: Scenario) => Promise<T>
): Promise<T> {
  const scenario = await createAuthorityScenario(options);
  try {
    return await run(scenario);
  } finally {
    await scenario.fixture.dispose();
  }
}

async function reload(scenario: Scenario, sessionId = scenario.sessionId) {
  return scenario.fixture.store.workflowTransaction((tx) => {
    assertWorkflowTransactionContext(tx);
    return reloadWorkflowPrincipal(tx, sessionId, NOW);
  });
}

function requestFor(
  scenario: Scenario,
  changes: Partial<WorkflowScopeRequest> = {}
): WorkflowScopeRequest {
  return {
    permission: scenario.permission,
    roles: [scenario.directoryRole],
    purpose: scenario.purpose,
    targets: [{ orgUnitId: scenario.orgUnitId, branchId: scenario.branchId }],
    ...changes
  };
}

function expectAuthorized(scenario: Scenario, principal: Awaited<ReturnType<typeof reload>>) {
  return authorizeWorkflowScope(principal, requestFor(scenario));
}

async function insertOrgUnit(
  fixture: Fixture,
  id: string,
  name: string,
  parentOrgUnitId: string | null = null
) {
  await fixture.store.workflowTransaction((tx) => tx.insertUnique('org_units', {
    id,
    name,
    parentOrgUnitId,
    active: true
  }, { constraint: 'org_units_primary_key', values: { id } }));
}

async function insertBranch(fixture: Fixture, id: string, orgUnitId: string, region = 'east') {
  await fixture.store.transaction((tx) => tx.put('branches', {
    id,
    name: `Authority fixture branch ${id}`,
    region,
    orgUnitId
  }));
}

async function insertResponsibility(
  scenario: Scenario,
  row: {
    id: string;
    orgUnitId: string;
    purpose: AuthorityPurpose;
    branchIds: string[];
    active: boolean;
  }
) {
  const responsibility = {
    ...row,
    identityId: scenario.identityId,
    rowVersion: 1
  };
  await scenario.fixture.store.workflowTransaction((tx) => tx.insertUnique('responsibilities', {
    ...responsibility
  }, responsibility.active ? {
    constraint: 'responsibilities_open_identity_purpose_unique',
    values: {
      identityId: scenario.identityId,
      purpose: responsibility.purpose,
      orgUnitId: responsibility.orgUnitId
    }
  } : {
    constraint: 'responsibilities_primary_key', values: { id: row.id }
  }));
}

async function setV2Active(
  fixture: Fixture,
  table: 'directory_identities' | 'org_units' | 'responsibilities',
  id: string,
  active: boolean
) {
  await fixture.store.workflowTransaction(async (tx) => {
    assertWorkflowTransactionContext(tx);
    const current = await tx.workflowProjectionReader.get<{
      id: string;
      active: boolean;
      rowVersion: number;
      [field: string]: unknown;
    }>(table, id);
    if (!current) throw new Error(`Expected seeded ${table} row ${id} to exist`);
    const result = await tx.compareAndSwap(table, id, {
      rowVersion: current.rowVersion,
      state: current.body.active ? 'active' : 'inactive'
    }, {
      ...current.body,
      active,
      rowVersion: current.rowVersion + 1
    });
    if (!result.updated) throw new Error(`Expected seeded ${table} row ${id} to update`);
  });
}

describe('workflow authority reload and scope checks', () => {
  it('rejects expired and exact-now sessions using the supplied clock', async () => {
    await withScenario({ sessionExpiresAt: '2026-10-02T23:59:59.999Z' }, async (scenario) => {
      await expect(reload(scenario)).rejects.toThrow();
    });
    await withScenario({ sessionExpiresAt: NOW }, async (scenario) => {
      await expect(reload(scenario)).rejects.toThrow();
    });
  });

  it('rejects an unknown session instead of deriving authority from a profile alone', async () => {
    await withScenario({}, async (scenario) => {
      await expect(reload(scenario, `unknown-${scenario.sessionId}`)).rejects.toThrow();
    });
  });

  it('rejects a malformed session body from a controlled projection reader', async () => {
    await withScenario({}, async (scenario) => {
      await scenario.fixture.store.workflowTransaction(async (tx) => {
        assertWorkflowTransactionContext(tx);
        const realReader = tx.workflowProjectionReader;
        const malformedReader = new Proxy(realReader, {
          get(target, property, receiver) {
            if (property !== 'get') return Reflect.get(target, property, receiver);
            return async (table: Parameters<typeof realReader.get>[0], id: string) => {
              const row = await realReader.get<{
                id: string;
                profileId: string;
                expiresAt: string;
                mode: 'live_ai' | 'scripted_demo';
                modeRevision: number;
              }>(table, id);
              if (table !== 'sessions' || id !== scenario.sessionId || !row) return row;
              return {
                ...row,
                body: { ...row.body, expiresAt: 'not-an-instant' }
              };
            };
          }
        });
        const controlledTransaction = new Proxy(tx, {
          get(target, property, receiver) {
            if (property === 'workflowProjectionReader') return malformedReader;
            return Reflect.get(target, property, receiver);
          }
        });
        assertWorkflowTransactionContext(controlledTransaction);

        await expect(reloadWorkflowPrincipal(controlledTransaction, scenario.sessionId, NOW))
          .rejects.toThrow();
      });
    });
  });

  it('uses the directory V2 role while preserving the active V1 profile anchor', async () => {
    await withScenario({ directoryRole: 'hr_director' }, async (scenario) => {
      await scenario.fixture.store.workflowTransaction(async (tx) => {
        assertWorkflowTransactionContext(tx);
        expect(typeof tx.workflowProjectionReader.get).toBe('function');
        expect(typeof tx.workflowProjectionReader.query).toBe('function');
      });
      const principal = await reload(scenario);

      expect(principal.actor.role).toBe('hr_director');
      expect(principal.actor.permissions).toContain(DIRECTOR_APPROVE);
      expect(principal.actor.regions).toEqual(['east']);
      expect(principal.directory.body.role).toBe('hr_director');
      expect(principal.profileAnchor.id).toBe(scenario.profileId);
      expect(principal.sessionAnchor.id).toBe(scenario.sessionId);
      expect(principal.sessionAnchor.expiresAt).toBe(VALID_UNTIL);
      expect('csrfToken' in principal.sessionAnchor).toBe(false);
      const authorization = expectAuthorized(scenario, principal);
      expect(authorization.targets[0].responsibilityId).toBe(scenario.responsibilityId);
      expect(authorization.profileAnchor).toEqual(principal.profileAnchor);
      expect(authorization.sessionAnchor).toEqual(principal.sessionAnchor);
      expect(authorization.authorityExpectedRows).toEqual(principal.authorityExpectedRows);
    });
  });

  it('requires the requested direct profile permission even when the directory role matches', async () => {
    await withScenario({ permissions: [] }, async (scenario) => {
      const principal = await reload(scenario);
      expect(principal.actor.role).toBe('hr_director');
      expect(() => authorizeWorkflowScope(principal, requestFor(scenario))).toThrow();
    });
  });

  it('does not reuse the V1 profile role when matching an allowed workflow role', async () => {
    await withScenario({}, async (scenario) => {
      const principal = await reload(scenario);
      expect(principal.actor.role).toBe('hr_director');
      expect(() => authorizeWorkflowScope(principal, requestFor(scenario, {
        roles: ['hr_admin']
      }))).toThrow();
    });
  });

  it('keeps returned authority and scope snapshots immutable without freezing reader-owned rows', async () => {
    await withScenario({}, async (scenario) => {
      const readerOwnedObjects: object[] = [];
      const captureRow = (row: unknown) => {
        if (typeof row !== 'object' || row === null) return;
        readerOwnedObjects.push(row);
        const body = Reflect.get(row, 'body');
        if (typeof body !== 'object' || body === null) return;
        readerOwnedObjects.push(body);
        const branchIds = Reflect.get(body, 'branchIds');
        if (Array.isArray(branchIds)) readerOwnedObjects.push(branchIds);
      };

      const principal = await scenario.fixture.store.workflowTransaction(async (tx) => {
        assertWorkflowTransactionContext(tx);
        const realReader = tx.workflowProjectionReader;
        const observingReader = new Proxy(realReader, {
          get(target, property, receiver) {
            if (property === 'get') {
              return async (table: Parameters<typeof realReader.get>[0], id: string) => {
                const row = await realReader.get<Record<string, unknown>>(table, id);
                captureRow(row);
                return row;
              };
            }
            if (property === 'query') {
              return async (query: Parameters<typeof realReader.query>[0]) => {
                const rows = await realReader.query<Record<string, unknown>>(query);
                rows.forEach(captureRow);
                return rows;
              };
            }
            return Reflect.get(target, property, receiver);
          }
        });
        const observingTransaction = new Proxy(tx, {
          get(target, property, receiver) {
            if (property === 'workflowProjectionReader') return observingReader;
            return Reflect.get(target, property, receiver);
          }
        });
        assertWorkflowTransactionContext(observingTransaction);
        return reloadWorkflowPrincipal(observingTransaction, scenario.sessionId, NOW);
      });
      const responsibility = principal.responsibilities.find(row => row.id === scenario.responsibilityId);
      expect(responsibility).toBeDefined();
      expect(principal.authorityExpectedRows.length).toBeGreaterThan(0);
      const request = requestFor(scenario);
      const before = authorizeWorkflowScope(principal, request);
      const branchIds = responsibility?.body.branchIds;
      if (!responsibility || !branchIds?.length) throw new Error('Expected an explicit responsibility branch grant');

      const blockedWrites = [
        Reflect.set(principal.actor.permissions, '0', ONBOARDING_START),
        Reflect.set(principal.directory.body, 'active', false),
        Reflect.set(principal.directory.body, 'role', 'hr_admin'),
        Reflect.set(responsibility.body.branchIds, '0', `other-${scenario.branchId}`),
        Reflect.set(responsibility.body, 'orgUnitId', `other-${scenario.orgUnitId}`),
        Reflect.set(before.grants, '0', { responsibilityId: 'other' }),
        Reflect.set(before.grants[0].branchIds, '0', `other-${scenario.branchId}`),
        Reflect.set(before.targets[0], 'branchId', `other-${scenario.branchId}`),
        Reflect.set(before.profileAnchor, 'rowVersion', 999),
        Reflect.set(before.sessionAnchor, 'rowVersion', 999),
        Reflect.set(before.authorityExpectedRows[0], 'rowVersion', 999)
      ];
      expect(blockedWrites).toHaveLength(11);
      expect(blockedWrites.every(result => result === false)).toBe(true);
      expect(readerOwnedObjects.length).toBeGreaterThan(0);
      expect(readerOwnedObjects.every(value => !Object.isFrozen(value))).toBe(true);

      const after = authorizeWorkflowScope(principal, request);
      expect(after.targets).toEqual(before.targets);
      expect(after.grants).toEqual(before.grants);
      expect(after.profileAnchor).toEqual(principal.profileAnchor);
      expect(after.sessionAnchor).toEqual(principal.sessionAnchor);
      expect(after.authorityExpectedRows).toEqual(principal.authorityExpectedRows);
    });
  });

  it('keeps manager approval, Director approval, and onboarding start permissions separate', async () => {
    await withScenario({
      directoryRole: 'east_manager',
      purpose: 'manager_onboarding',
      permission: MANAGER_APPROVE
    }, async (manager) => {
      const managerPrincipal = await reload(manager);
      expect(() => expectAuthorized(manager, managerPrincipal)).not.toThrow();
      expect(() => authorizeWorkflowScope(managerPrincipal, requestFor(manager, {
        permission: DIRECTOR_APPROVE
      }))).toThrow();
      expect(() => authorizeWorkflowScope(managerPrincipal, requestFor(manager, {
        permission: ONBOARDING_START
      }))).toThrow();
    });

    await withScenario({
      directoryRole: 'hr_director',
      purpose: 'director_onboarding',
      permission: DIRECTOR_APPROVE
    }, async (director) => {
      const directorPrincipal = await reload(director);
      expect(() => authorizeWorkflowScope(directorPrincipal, requestFor(director, {
        permission: MANAGER_APPROVE
      }))).toThrow();
      expect(() => authorizeWorkflowScope(directorPrincipal, requestFor(director, {
        permission: ONBOARDING_START
      }))).toThrow();
    });
  });

  it('rejects a directory identity linked to a different authenticated profile', async () => {
    await withScenario({ directoryProfileMismatch: true }, async (scenario) => {
      await expect(reload(scenario)).rejects.toThrow();
    });
  });

  it('rejects profiles and directory identities deactivated after a successful reload', async () => {
    await withScenario({}, async (scenario) => {
      const before = await reload(scenario);
      expect(() => expectAuthorized(scenario, before)).not.toThrow();
      await scenario.fixture.store.transaction((tx) => tx.put('profiles', {
        ...scenario.profile,
        active: false
      }));
      await expect(reload(scenario)).rejects.toThrow();
    });

    await withScenario({}, async (scenario) => {
      const before = await reload(scenario);
      expect(() => expectAuthorized(scenario, before)).not.toThrow();
      await setV2Active(scenario.fixture, 'directory_identities', scenario.identityId, false);
      await expect(reload(scenario)).rejects.toThrow();
    });
  });

  it('rereads profile permission withdrawal between fresh principal loads', async () => {
    await withScenario({}, async (scenario) => {
      const before = await reload(scenario);
      expect(() => expectAuthorized(scenario, before)).not.toThrow();

      await scenario.fixture.store.transaction((tx) => tx.put('profiles', {
        ...scenario.profile,
        permissions: []
      }));

      const after = await reload(scenario);
      expect(after.actor.permissions).not.toContain(scenario.permission);
      expect(after.profileAnchor.rowVersion).toBeGreaterThan(before.profileAnchor.rowVersion);
      expect(() => expectAuthorized(scenario, after)).toThrow();
    });
  });

  it('rereads responsibility withdrawal between fresh principal loads', async () => {
    await withScenario({}, async (scenario) => {
      const before = await reload(scenario);
      expect(() => expectAuthorized(scenario, before)).not.toThrow();
      const beforeAuthorityRow = before.authorityExpectedRows.find(row =>
        row.ref.table === 'responsibilities' && row.ref.id === scenario.responsibilityId
      );
      expect(beforeAuthorityRow).toBeDefined();

      await setV2Active(scenario.fixture, 'responsibilities', scenario.responsibilityId, false);

      const after = await reload(scenario);
      expect(after.responsibilities.find(row => row.id === scenario.responsibilityId)?.body.active)
        .toBe(false);
      const afterAuthorityRow = after.authorityExpectedRows.find(row =>
        row.ref.table === 'responsibilities' && row.ref.id === scenario.responsibilityId
      );
      expect(afterAuthorityRow).toBeDefined();
      expect(afterAuthorityRow?.rowVersion).toBeGreaterThan(beforeAuthorityRow?.rowVersion ?? 0);
      expect(() => expectAuthorized(scenario, after)).toThrow();
      const emptyScope = authorizeWorkflowScope(after, requestFor(scenario, { targets: [] }));
      expect(emptyScope.profileAnchor).toEqual(after.profileAnchor);
      expect(emptyScope.sessionAnchor).toEqual(after.sessionAnchor);
      expect(emptyScope.authorityExpectedRows).toEqual(after.authorityExpectedRows);
    });
  });

  it('rereads current session mode and revision instead of returning cached session state', async () => {
    await withScenario({}, async (scenario) => {
      const before = await reload(scenario);
      expect(before.actor.mode).toBe('scripted_demo');
      expect(before.actor.modeRevision).toBe(0);

      await scenario.fixture.store.transaction((tx) => tx.put('sessions', {
        ...scenario.session,
        mode: 'live_ai',
        modeRevision: 7
      }));

      const after = await reload(scenario);
      expect(after.actor.mode).toBe('live_ai');
      expect(after.actor.modeRevision).toBe(7);
      expect(after.sessionAnchor.rowVersion).toBeGreaterThan(before.sessionAnchor.rowVersion);
      const authorization = expectAuthorized(scenario, after);
      expect(authorization.profileAnchor).toEqual(after.profileAnchor);
      expect(authorization.sessionAnchor).toEqual(after.sessionAnchor);
      expect(authorization.authorityExpectedRows).toEqual(after.authorityExpectedRows);
    });
  });

  it('rejects a transaction context borrowed after its workflow callback closes', async () => {
    await withScenario({}, async (scenario) => {
      const borrowed: { transaction?: WorkflowTransactionContext } = {};
      await scenario.fixture.store.workflowTransaction(async (tx) => {
        assertWorkflowTransactionContext(tx);
        borrowed.transaction = tx;
        const principal = await reloadWorkflowPrincipal(tx, scenario.sessionId, NOW);
        expect(principal.actor.id).toBe(scenario.profileId);
      });

      if (!borrowed.transaction) throw new Error('The workflow transaction was not captured');
      await expect(reloadWorkflowPrincipal(borrowed.transaction, scenario.sessionId, NOW))
        .rejects.toThrow();
    });
  });

  it('rejects a principal when its directory home organization is deactivated', async () => {
    await withScenario({}, async (scenario) => {
      const before = await reload(scenario);
      expect(() => expectAuthorized(scenario, before)).not.toThrow();

      await setV2Active(scenario.fixture, 'org_units', scenario.orgUnitId, false);

      await expect(reload(scenario)).rejects.toMatchObject({
        name: 'DomainError',
        code: 'WORKFLOW_AUTHORITY_INVALID',
        status: 403
      });
    });
  });

  it('denies a deactivated responsibility unit while the home organization stays active', async () => {
    await withScenario({}, async (scenario) => {
      const otherUnitId = `authority-inactive-responsibility-org-${randomUUID()}`;
      const otherBranchId = `authority-inactive-responsibility-branch-${randomUUID()}`;
      const otherResponsibilityId = `authority-inactive-responsibility-${randomUUID()}`;
      await insertOrgUnit(scenario.fixture, otherUnitId, 'Authority fixture inactive responsibility org');
      await insertBranch(scenario.fixture, otherBranchId, otherUnitId);
      await insertResponsibility(scenario, {
        id: otherResponsibilityId,
        orgUnitId: otherUnitId,
        purpose: scenario.purpose,
        branchIds: [otherBranchId],
        active: true
      });

      const before = await reload(scenario);
      expect(() => authorizeWorkflowScope(before, requestFor(scenario, {
        targets: [{ orgUnitId: otherUnitId, branchId: otherBranchId }]
      }))).not.toThrow();

      await setV2Active(scenario.fixture, 'org_units', otherUnitId, false);

      const after = await reload(scenario);
      expect(after.orgUnits.find(row => row.id === scenario.orgUnitId)?.body.active).toBe(true);
      expect(after.orgUnits.find(row => row.id === otherUnitId)?.body.active).toBe(false);
      expect(() => authorizeWorkflowScope(after, requestFor(scenario, {
        targets: [{ orgUnitId: otherUnitId, branchId: otherBranchId }]
      }))).toThrow();
      const currentScope = authorizeWorkflowScope(after, requestFor(scenario, { targets: [] }));
      expect(currentScope.grants.some(grant => grant.orgUnitId === otherUnitId)).toBe(false);
      expect(() => expectAuthorized(scenario, after)).not.toThrow();
    });
  });

  it('requires the explicit organization unit, an assigned branch, and profile-region intersection', async () => {
    await withScenario({}, async (scenario) => {
      const principal = await reload(scenario);
      expect(() => expectAuthorized(scenario, principal)).not.toThrow();
      expect(() => authorizeWorkflowScope(principal, requestFor(scenario, {
        targets: [{ orgUnitId: scenario.orgUnitId, branchId: `missing-${scenario.branchId}` }]
      }))).toThrow();
    });

    await withScenario({ profileRegions: ['east'], branchRegion: 'west' }, async (scenario) => {
      const principal = await reload(scenario);
      expect(() => expectAuthorized(scenario, principal)).toThrow();
    });
  });

  it('denies a target in another unit even when that unit has a real branch', async () => {
    await withScenario({}, async (scenario) => {
      const otherUnitId = `authority-other-org-${randomUUID()}`;
      const otherBranchId = `authority-other-branch-${randomUUID()}`;
      await insertOrgUnit(scenario.fixture, otherUnitId, 'Authority fixture other org');
      await insertBranch(scenario.fixture, otherBranchId, otherUnitId);

      const principal = await reload(scenario);
      expect(() => authorizeWorkflowScope(principal, requestFor(scenario, {
        targets: [{ orgUnitId: otherUnitId, branchId: otherBranchId }]
      }))).toThrow();
    });
  });

  it('keeps each target within one responsibility pair and honors explicit cross-unit branch grants', async () => {
    await withScenario({
      responsibilityActive: false,
      responsibilityBranchIds: []
    }, async (scenario) => {
      const otherUnitId = `authority-paired-org-${randomUUID()}`;
      const otherBranchId = `authority-paired-branch-${randomUUID()}`;
      const responsibilityId = `authority-paired-responsibility-${randomUUID()}`;
      await insertOrgUnit(scenario.fixture, otherUnitId, 'Authority fixture paired org');
      await insertBranch(scenario.fixture, otherBranchId, otherUnitId);
      await insertResponsibility(scenario, {
        id: responsibilityId,
        orgUnitId: scenario.orgUnitId,
        purpose: scenario.purpose,
        branchIds: [otherBranchId],
        active: true
      });

      const principal = await reload(scenario);
      const authorization = authorizeWorkflowScope(principal, requestFor(scenario, {
        targets: [{ orgUnitId: scenario.orgUnitId, branchId: otherBranchId }]
      }));
      expect(authorization.targets[0].responsibilityId).toBe(responsibilityId);
      expect(authorization.grants[0]).toMatchObject({
        responsibilityId,
        orgUnitId: scenario.orgUnitId,
        branchIds: [otherBranchId]
      });
    });

    await withScenario({}, async (scenario) => {
      const otherUnitId = `authority-cross-org-${randomUUID()}`;
      const otherBranchId = `authority-cross-branch-${randomUUID()}`;
      const secondResponsibilityId = `authority-cross-responsibility-${randomUUID()}`;
      await insertOrgUnit(scenario.fixture, otherUnitId, 'Authority fixture cross org');
      await insertBranch(scenario.fixture, otherBranchId, otherUnitId);
      await insertResponsibility(scenario, {
        id: secondResponsibilityId,
        orgUnitId: otherUnitId,
        purpose: scenario.purpose,
        branchIds: [otherBranchId],
        active: true
      });

      const principal = await reload(scenario);
      expect(principal.responsibilities.filter(row => row.body.active)).toHaveLength(2);
      expect(principal.responsibilities.find(row => row.id === scenario.responsibilityId)?.body.branchIds)
        .toEqual([scenario.branchId]);
      expect(principal.responsibilities.find(row => row.id === secondResponsibilityId)?.body.branchIds)
        .toEqual([otherBranchId]);
      expect(() => authorizeWorkflowScope(principal, requestFor(scenario, {
        targets: [{ orgUnitId: scenario.orgUnitId, branchId: otherBranchId }]
      }))).toThrow();
    });
  });

  it('authorizes explicit Director grants in both assigned organization units', async () => {
    await withScenario({}, async (scenario) => {
      const otherUnitId = `authority-multi-org-${randomUUID()}`;
      const otherBranchId = `authority-multi-branch-${randomUUID()}`;
      const secondResponsibilityId = `authority-multi-responsibility-${randomUUID()}`;
      await insertOrgUnit(scenario.fixture, otherUnitId, 'Authority fixture multi org');
      await insertBranch(scenario.fixture, otherBranchId, otherUnitId);
      await insertResponsibility(scenario, {
        id: secondResponsibilityId,
        orgUnitId: otherUnitId,
        purpose: scenario.purpose,
        branchIds: [otherBranchId],
        active: true
      });

      const principal = await reload(scenario);
      expect(principal.responsibilities.filter(row => row.body.active)).toHaveLength(2);
      const authorization = authorizeWorkflowScope(principal, requestFor(scenario, {
        targets: [
          { orgUnitId: scenario.orgUnitId, branchId: scenario.branchId },
          { orgUnitId: otherUnitId, branchId: otherBranchId }
        ]
      }));
      expect(authorization.targets).toEqual([
        {
          orgUnitId: scenario.orgUnitId,
          branchId: scenario.branchId,
          responsibilityId: scenario.responsibilityId
        },
        {
          orgUnitId: otherUnitId,
          branchId: otherBranchId,
          responsibilityId: secondResponsibilityId
        }
      ]);
    });
  });

  it('invalidates the principal when its home organization is inactive despite another active grant', async () => {
    await withScenario({}, async (scenario) => {
      const otherUnitId = `authority-home-org-${randomUUID()}`;
      const otherBranchId = `authority-home-branch-${randomUUID()}`;
      const otherResponsibilityId = `authority-home-responsibility-${randomUUID()}`;
      await insertOrgUnit(scenario.fixture, otherUnitId, 'Authority fixture other assigned org');
      await insertBranch(scenario.fixture, otherBranchId, otherUnitId);
      await insertResponsibility(scenario, {
        id: otherResponsibilityId,
        orgUnitId: otherUnitId,
        purpose: scenario.purpose,
        branchIds: [otherBranchId],
        active: true
      });

      const before = await reload(scenario);
      expect(before.orgUnits.find(row => row.id === otherUnitId)?.body.active).toBe(true);
      const otherUnitAuthorization = authorizeWorkflowScope(before, requestFor(scenario, {
        targets: [{ orgUnitId: otherUnitId, branchId: otherBranchId }]
      }));
      expect(otherUnitAuthorization.targets[0].responsibilityId).toBe(otherResponsibilityId);

      await setV2Active(scenario.fixture, 'org_units', scenario.orgUnitId, false);
      await expect(reload(scenario)).rejects.toThrow();
    });
  });

  it('does not inherit a child-unit responsibility into its ancestor organization unit', async () => {
    await withScenario({ withAncestorUnit: true }, async (scenario) => {
      const principal = await reload(scenario);
      expect(() => authorizeWorkflowScope(principal, requestFor(scenario, {
        targets: [{ orgUnitId: scenario.ancestorOrgUnitId, branchId: scenario.branchId }]
      }))).toThrow();
    });
  });

  it('retains a targeted responsibility grant beyond a full responsibility page', async () => {
    await withScenario({ responsibilityId: 'zz-authority-active-grant' }, async (scenario) => {
      await scenario.fixture.store.workflowTransaction(async (tx) => {
        for (let index = 0; index < 101; index += 1) {
          const id = `aa-authority-inactive-${String(index).padStart(3, '0')}`;
          await tx.insertUnique('responsibilities', {
            id,
            identityId: scenario.identityId,
            orgUnitId: scenario.orgUnitId,
            purpose: scenario.purpose,
            branchIds: [],
            active: false,
            rowVersion: 1
          }, { constraint: 'responsibilities_primary_key', values: { id } });
        }
      });

      const principal = await reload(scenario);
      const authorization = expectAuthorized(scenario, principal);
      expect(authorization.targets).toHaveLength(1);
      expect(authorization.targets[0].responsibilityId).toBe('zz-authority-active-grant');
    });
  });
});
