import { z } from 'zod';
import type { Profile, Mode } from '../contracts';
import { invariant } from '../core/errors';
import type { ProjectedRow, WorkflowStorageQuery, WorkflowTransactionContext } from '../storage/workflow-projections';
import {
  directoryIdentitySchema,
  expectedRowSchema,
  instantSchema,
  MAX_WORKFLOW_TARGETS,
  responsibilitySchema,
  roleV2Schema,
  type DirectoryIdentity,
  type ExpectedRow,
  type Instant,
  type Responsibility,
  type RoleV2,
  type WorkflowActor,
} from './contracts';

const identifierSchema = directoryIdentitySchema.shape.id;
const modeSchema = z.enum(['live_ai', 'scripted_demo']);

const profileAuthoritySchema = z.object({
  id: identifierSchema,
  name: z.string().min(1).max(160),
  active: z.boolean(),
  permissions: z.array(z.string().min(1)),
  regions: z.array(z.string().min(1)),
});

const sessionAuthoritySchema = z.object({
  id: identifierSchema,
  profileId: identifierSchema,
  expiresAt: instantSchema,
  mode: modeSchema,
  modeRevision: z.number().int().nonnegative(),
});

const workflowScopeTargetSchema = z.object({
  orgUnitId: identifierSchema.optional(),
  branchId: identifierSchema.optional(),
}).strict().superRefine((target, context) => {
  if (target.orgUnitId === undefined && target.branchId === undefined) {
    context.addIssue({ code: 'custom', message: 'A workflow scope target needs an organization unit or branch' });
  }
});

const workflowScopeRequestSchema = z.object({
  permission: z.string().min(1).max(160),
  roles: z.array(roleV2Schema).min(1),
  purpose: responsibilitySchema.shape.purpose,
  targets: z.array(workflowScopeTargetSchema).max(MAX_WORKFLOW_TARGETS),
}).strict().superRefine((request, context) => {
  if (new Set(request.roles).size !== request.roles.length) {
    context.addIssue({ code: 'custom', message: 'Workflow scope roles must be unique' });
  }
});

type DeepReadonly<T> =
  T extends readonly (infer TItem)[] ? readonly DeepReadonly<TItem>[] :
  T extends object ? { readonly [TKey in keyof T]: DeepReadonly<T[TKey]> } :
  T;

function freezeTree(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeTree(child);
  Object.freeze(value);
}

export interface WorkflowAuthorityOrgUnitBody extends Record<string, unknown> {
  readonly id: string;
  readonly name: string;
  readonly active: boolean;
  readonly parentOrgUnitId?: string | null;
}

export interface WorkflowAuthorityBranchBody extends Record<string, unknown> {
  readonly id: string;
  readonly name: string;
  readonly region: string;
  readonly orgUnitId?: string | null;
  readonly active?: boolean;
}

export interface WorkflowPrincipal {
  readonly actor: DeepReadonly<WorkflowActor>;
  readonly profileAnchor: DeepReadonly<{ id: string; rowVersion: number }>;
  readonly sessionAnchor: DeepReadonly<{ id: string; rowVersion: number; expiresAt: Instant }>;
  readonly directory: DeepReadonly<ProjectedRow<DirectoryIdentity>>;
  readonly responsibilities: readonly DeepReadonly<ProjectedRow<Responsibility>>[];
  readonly orgUnits: readonly DeepReadonly<ProjectedRow<WorkflowAuthorityOrgUnitBody>>[];
  readonly branches: readonly DeepReadonly<ProjectedRow<WorkflowAuthorityBranchBody>>[];
  readonly authorityExpectedRows: readonly DeepReadonly<ExpectedRow>[];
}

export interface WorkflowScopeTarget {
  readonly orgUnitId?: string;
  readonly branchId?: string;
}

export interface WorkflowScopeRequest {
  readonly permission: string;
  readonly roles: readonly RoleV2[];
  readonly purpose: Responsibility['purpose'];
  readonly targets: readonly WorkflowScopeTarget[];
}

export interface WorkflowScopeGrant {
  readonly responsibilityId: string;
  readonly orgUnitId: string;
  readonly branchIds: readonly string[];
}

export interface AuthorizedWorkflowTarget extends WorkflowScopeTarget {
  readonly responsibilityId: string;
}

export interface WorkflowAuthorizationScope {
  readonly permission: string;
  readonly role: RoleV2;
  readonly purpose: Responsibility['purpose'];
  readonly grants: readonly DeepReadonly<WorkflowScopeGrant>[];
  readonly targets: readonly DeepReadonly<AuthorizedWorkflowTarget>[];
  readonly profileAnchor: DeepReadonly<{ id: string; rowVersion: number }>;
  readonly sessionAnchor: DeepReadonly<{ id: string; rowVersion: number; expiresAt: Instant }>;
  readonly authorityExpectedRows: readonly DeepReadonly<ExpectedRow>[];
}

const RESPONSIBILITY_PAGE_SIZE = 100;

function assertProjectedRow<T extends { id: string }>(
  row: ProjectedRow<T> | undefined,
  requestedId: string,
  label: string,
): asserts row is ProjectedRow<T> {
  invariant(row !== undefined, 'WORKFLOW_AUTHORITY_INVALID', label + ' was not found', 403);
  invariant(row.id === requestedId, 'WORKFLOW_AUTHORITY_INVALID', label + ' identity did not match', 409);
  invariant(Number.isSafeInteger(row.rowVersion) && row.rowVersion >= 1, 'WORKFLOW_AUTHORITY_INVALID', label + ' version is invalid', 409);
  invariant(row.body.id === row.id, 'WORKFLOW_AUTHORITY_INVALID', label + ' body identity did not match', 409);
  if ('rowVersion' in row.body && row.body.rowVersion !== undefined) {
    invariant(
      Number.isSafeInteger(row.body.rowVersion) && row.body.rowVersion === row.rowVersion,
      'WORKFLOW_AUTHORITY_INVALID',
      label + ' body and projection versions did not match',
      409,
    );
  }
}

function expectedRow<T extends { id: string }>(
  table: ExpectedRow['ref']['table'],
  row: ProjectedRow<T>,
  state: string | null,
): ExpectedRow {
  const parsed = expectedRowSchema.safeParse({
    ref: { table, id: row.id },
    rowVersion: row.rowVersion,
    state,
  });
  invariant(parsed.success, 'WORKFLOW_AUTHORITY_INVALID', 'An authority row could not be represented in the expected-row contract', 409);
  return parsed.data;
}

function activeState(active: boolean): 'active' | 'inactive' {
  return active ? 'active' : 'inactive';
}

async function loadResponsibilities(
  reader: WorkflowTransactionContext['workflowProjectionReader'],
  identityId: string,
): Promise<ProjectedRow<Responsibility>[]> {
  const rows: ProjectedRow<Responsibility>[] = [];
  const seenIds = new Set<string>();
  let cursor: string | undefined;

  while (true) {
    const query: WorkflowStorageQuery = {
      kind: 'scoped',
      table: 'responsibilities',
      ownerId: identityId,
      limit: RESPONSIBILITY_PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor }),
    };
    const page = await reader.query<Responsibility>(query);
    invariant(page.length <= RESPONSIBILITY_PAGE_SIZE, 'WORKFLOW_AUTHORITY_INVALID', 'Responsibility query exceeded its page bound', 409);

    for (const row of page) {
      assertProjectedRow(row, row.id, 'Responsibility');
      const parsed = responsibilitySchema.safeParse(row.body);
      invariant(parsed.success, 'WORKFLOW_AUTHORITY_INVALID', 'A responsibility projection was invalid', 409);
      invariant(parsed.data.identityId === identityId, 'WORKFLOW_AUTHORITY_INVALID', 'A responsibility belonged to another identity', 409);
      invariant(parsed.data.rowVersion === row.rowVersion, 'WORKFLOW_AUTHORITY_INVALID', 'Responsibility body and projection versions did not match', 409);
      invariant(!seenIds.has(row.id), 'WORKFLOW_AUTHORITY_INVALID', 'Responsibility pagination repeated a row', 409);
      seenIds.add(row.id);
      rows.push(row);
    }

    if (page.length < RESPONSIBILITY_PAGE_SIZE) break;
    const nextCursor = page[page.length - 1]?.id;
    invariant(nextCursor !== undefined && nextCursor !== cursor, 'WORKFLOW_AUTHORITY_INVALID', 'Responsibility pagination did not advance', 409);
    cursor = nextCursor;
  }

  return rows.sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Reload authority inside the active revision-fenced workflow transaction.
 * Pass its WorkflowTransactionContext, never WorkflowStoreCapability.workflowProjectionReader.
 * Callers must reload for every request so session, profile, directory and scope changes are current.
 */
export async function reloadWorkflowPrincipal(
  tx: WorkflowTransactionContext,
  sessionId: string,
  now: Instant,
): Promise<WorkflowPrincipal> {
  const parsedSessionId = identifierSchema.safeParse(sessionId);
  const parsedNow = instantSchema.safeParse(now);
  invariant(parsedSessionId.success && parsedNow.success, 'WORKFLOW_REQUEST_INVALID', 'The session ID or current instant was invalid');

  const reader = tx.workflowProjectionReader;
  const session = await reader.get<{
    id: string;
    profileId: string;
    expiresAt: string;
    mode: Mode;
    modeRevision: number;
  }>('sessions', sessionId);
  invariant(session !== undefined, 'WORKFLOW_AUTHENTICATION_REQUIRED', 'The session was not found', 401);
  assertProjectedRow(session, sessionId, 'Session');
  const sessionBody = sessionAuthoritySchema.safeParse(session.body);
  invariant(sessionBody.success, 'WORKFLOW_AUTHENTICATION_REQUIRED', 'The session authority was invalid', 401);
  invariant(Date.parse(sessionBody.data.expiresAt) > Date.parse(parsedNow.data), 'WORKFLOW_AUTHENTICATION_REQUIRED', 'The session has expired', 401);

  const profile = await reader.get<Profile>('profiles', sessionBody.data.profileId);
  invariant(profile !== undefined, 'WORKFLOW_AUTHENTICATION_REQUIRED', 'The session profile was not found', 401);
  assertProjectedRow(profile, sessionBody.data.profileId, 'Profile');
  const profileBody = profileAuthoritySchema.safeParse(profile.body);
  invariant(profileBody.success, 'WORKFLOW_AUTHENTICATION_REQUIRED', 'The profile authority was invalid', 401);
  invariant(profileBody.data.active, 'WORKFLOW_AUTHENTICATION_REQUIRED', 'The profile is inactive', 401);

  const directoryRows = await reader.query<DirectoryIdentity>({
    kind: 'unique',
    table: 'directory_identities',
    constraint: 'directory_identities_profile_unique',
    values: { profileId: profileBody.data.id },
  });
  invariant(directoryRows.length === 1, 'WORKFLOW_AUTHORITY_INVALID', 'The profile must have exactly one directory identity', 403);
  const directory = directoryRows[0];
  assertProjectedRow(directory, directory.id, 'Directory identity');
  const directoryBody = directoryIdentitySchema.safeParse(directory.body);
  invariant(directoryBody.success, 'WORKFLOW_AUTHORITY_INVALID', 'The directory identity projection was invalid', 409);
  invariant(directoryBody.data.profileId === profileBody.data.id, 'WORKFLOW_AUTHORITY_INVALID', 'The directory identity belonged to another profile', 409);
  invariant(directoryBody.data.rowVersion === directory.rowVersion, 'WORKFLOW_AUTHORITY_INVALID', 'Directory body and projection versions did not match', 409);
  invariant(directoryBody.data.active, 'WORKFLOW_AUTHORITY_INVALID', 'The directory identity is inactive', 403);

  const responsibilities = await loadResponsibilities(reader, directoryBody.data.id);
  const targetedResponsibilities = responsibilities.filter((row) => row.body.active);
  const branchIds = [...new Set(targetedResponsibilities.flatMap((row) => row.body.branchIds))].sort();
  const branches: ProjectedRow<WorkflowAuthorityBranchBody>[] = [];

  for (const branchId of branchIds) {
    const branch = await reader.get<WorkflowAuthorityBranchBody>('branches', branchId);
    assertProjectedRow(branch, branchId, 'Branch');
    invariant(typeof branch.body.name === 'string' && typeof branch.body.region === 'string', 'WORKFLOW_AUTHORITY_INVALID', 'The branch projection was invalid', 409);
    if (branch.body.orgUnitId !== undefined && branch.body.orgUnitId !== null) {
      const parsedOrgUnitId = identifierSchema.safeParse(branch.body.orgUnitId);
      invariant(parsedOrgUnitId.success, 'WORKFLOW_AUTHORITY_INVALID', 'The branch organization link was invalid', 409);
    }
    branches.push(branch);
  }

  const orgUnitIds = [...new Set([
    directoryBody.data.orgUnitId,
    ...responsibilities.map((row) => row.body.orgUnitId),
    ...branches.flatMap((row) => row.body.orgUnitId ? [row.body.orgUnitId] : []),
  ])].sort();
  const orgUnits: ProjectedRow<WorkflowAuthorityOrgUnitBody>[] = [];

  for (const orgUnitId of orgUnitIds) {
    const orgUnit = await reader.get<WorkflowAuthorityOrgUnitBody>('org_units', orgUnitId);
    assertProjectedRow(orgUnit, orgUnitId, 'Organization unit');
    invariant(typeof orgUnit.body.name === 'string' && typeof orgUnit.body.active === 'boolean', 'WORKFLOW_AUTHORITY_INVALID', 'The organization unit projection was invalid', 409);
    orgUnits.push(orgUnit);
  }
  const homeOrgUnit = orgUnits.find((row) => row.id === directoryBody.data.orgUnitId);
  invariant(homeOrgUnit?.body.active === true, 'WORKFLOW_AUTHORITY_INVALID', 'The directory identity home organization is inactive', 403);

  const authorityExpectedRows = [
    expectedRow('directory_identities', directory, activeState(directoryBody.data.active)),
    ...responsibilities.map((row) => expectedRow('responsibilities', row, activeState(row.body.active))),
    ...orgUnits.map((row) => expectedRow('org_units', row, activeState(row.body.active))),
    ...branches.map((row) => expectedRow('branches', row, null)),
  ].sort((left, right) => {
    const leftKey = left.ref.table + ':' + left.ref.id;
    const rightKey = right.ref.table + ':' + right.ref.id;
    return leftKey.localeCompare(rightKey);
  });

  const actor: WorkflowActor = {
    id: profileBody.data.id,
    name: profileBody.data.name,
    role: directoryBody.data.role,
    active: profileBody.data.active,
    permissions: profileBody.data.permissions,
    regions: profileBody.data.regions,
    sessionId: session.id,
    mode: sessionBody.data.mode,
    modeRevision: sessionBody.data.modeRevision,
  };

  const principal: WorkflowPrincipal = structuredClone({
    actor,
    profileAnchor: { id: profile.id, rowVersion: profile.rowVersion },
    sessionAnchor: { id: session.id, rowVersion: session.rowVersion, expiresAt: sessionBody.data.expiresAt },
    directory,
    responsibilities,
    orgUnits,
    branches,
    authorityExpectedRows,
  });
  freezeTree(principal);
  return principal;
}

function scopeRequest(input: WorkflowScopeRequest): z.infer<typeof workflowScopeRequestSchema> {
  const parsed = workflowScopeRequestSchema.safeParse(input);
  invariant(parsed.success, 'WORKFLOW_REQUEST_INVALID', 'The workflow scope request was invalid');
  return parsed.data;
}

export function authorizeWorkflowScope(
  principal: WorkflowPrincipal,
  request: WorkflowScopeRequest,
): WorkflowAuthorizationScope {
  const input = scopeRequest(request);
  const directory = principal.directory.body;
  invariant(principal.actor.active, 'WORKFLOW_AUTHENTICATION_REQUIRED', 'The profile is inactive', 401);
  invariant(directory.active && principal.actor.id === directory.profileId, 'WORKFLOW_AUTHORITY_INVALID', 'The workflow principal no longer matches its directory identity', 403);
  invariant(principal.actor.role === directory.role, 'WORKFLOW_AUTHORITY_INVALID', 'The workflow actor role did not come from its directory identity', 403);
  invariant(principal.actor.permissions.includes(input.permission), 'WORKFLOW_PERMISSION_DENIED', 'The profile does not grant this permission', 403);
  invariant(input.roles.includes(directory.role), 'WORKFLOW_ROLE_DENIED', 'The directory role is not allowed for this operation', 403);

  const orgUnits = new Map(principal.orgUnits.map((row) => [row.id, row]));
  const branches = new Map(principal.branches.map((row) => [row.id, row]));
  const regionSet = new Set(principal.actor.regions);
  const grants = principal.responsibilities
    .filter((row) => row.body.active && row.body.identityId === directory.id && row.body.purpose === input.purpose)
    .flatMap((row): WorkflowScopeGrant[] => {
      const responsibilityOrgUnit = orgUnits.get(row.body.orgUnitId);
      if (!responsibilityOrgUnit || !responsibilityOrgUnit.body.active) return [];

      const explicitBranchIds = row.body.branchIds.filter((branchId) => {
        const branch = branches.get(branchId);
        if (!branch || !regionSet.has(branch.body.region)) return false;
        const linkedOrgUnitId = branch.body.orgUnitId;
        if (linkedOrgUnitId === undefined || linkedOrgUnitId === null) return true;
        return orgUnits.get(linkedOrgUnitId)?.body.active === true;
      }).sort();

      return [{
        responsibilityId: row.id,
        orgUnitId: row.body.orgUnitId,
        branchIds: explicitBranchIds,
      }];
    })
    .sort((left, right) => left.responsibilityId.localeCompare(right.responsibilityId));

  const authorizedTargets = input.targets.map((target) => {
    const matchingGrant = grants.find((grant) =>
      (target.orgUnitId === undefined || grant.orgUnitId === target.orgUnitId) &&
      (target.branchId === undefined || grant.branchIds.includes(target.branchId))
    );
    invariant(matchingGrant !== undefined, 'WORKFLOW_SCOPE_DENIED', 'A target is outside the active responsibility grants', 403);
    return {
      ...(target.orgUnitId === undefined ? {} : { orgUnitId: target.orgUnitId }),
      ...(target.branchId === undefined ? {} : { branchId: target.branchId }),
      responsibilityId: matchingGrant.responsibilityId,
    };
  });

  const selectedResponsibilityIds = new Set(authorizedTargets.map((target) => target.responsibilityId));
  const selectedGrants = input.targets.length === 0
    ? grants
    : grants.filter((grant) => selectedResponsibilityIds.has(grant.responsibilityId));

  const scope: WorkflowAuthorizationScope = structuredClone({
    permission: input.permission,
    role: directory.role,
    purpose: input.purpose,
    grants: selectedGrants,
    targets: authorizedTargets,
    profileAnchor: principal.profileAnchor,
    sessionAnchor: principal.sessionAnchor,
    authorityExpectedRows: principal.authorityExpectedRows,
  });
  freezeTree(scope);
  return scope;
}
