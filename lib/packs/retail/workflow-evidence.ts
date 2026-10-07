import { z } from 'zod';
import { scopeSchema, type Actor, type Branch, type Evidence, type Reader, type Scope } from '../../contracts';
import { DomainError, invariant } from '../../core/errors';
import { digest } from '../../core/utils';
import { getWorkflowProjection, type ProjectedRow, type WorkflowProjectionReader } from '../../storage/workflow-projections';
import { authorizeWorkflowScope, type WorkflowPrincipal } from '../../workflows/authority';
import { directoryIdentitySchema, instantSchema, rowVersionSchema } from '../../workflows/contracts';
import { branchSchema, incidentSchema, inventorySchema, salesOrderSchema, salesTargetSchema, staffingSchema } from '../shared';
import { readEvidence } from './evidence';

const identifier = directoryIdentitySchema.shape.id;
const projectionIdentitySchema = z.object({ id: identifier, rowVersion: rowVersionSchema.optional() }).passthrough();
const pageSize = 100;
// Reject an oversized dataset rather than returning a truncated evidence calculation.
const maximumPages = 1_000;
const roles = ['executive', 'east_manager'] as const;
const factSchemas = {
  sales_orders: salesOrderSchema.passthrough(),
  sales_targets: salesTargetSchema.passthrough(),
  inventory_snapshots: inventorySchema.extend({ productId: identifier }).passthrough(),
  incidents: incidentSchema.passthrough(),
  staffing_summaries: staffingSchema.passthrough(),
};
type FactTable = keyof typeof factSchemas;
const currentBranchSchema = branchSchema.extend({
  id: identifier,
  orgUnitId: identifier.nullable().optional(),
  active: z.boolean().optional(),
  updatedAt: instantSchema.optional(),
  rowVersion: rowVersionSchema.optional(),
});

export interface WorkflowEvidenceContext {
  /** The allowlisted reader from the same guarded transaction that reloaded principal. */
  readonly projections: WorkflowProjectionReader;
  readonly principal: WorkflowPrincipal;
  readonly now: Date;
}

function checked(row: ProjectedRow<unknown>, table: 'branches' | FactTable): Record<string, unknown> {
  invariant(row && identifier.safeParse(row.id).success && rowVersionSchema.safeParse(row.rowVersion).success,
    'WORKFLOW_EVIDENCE_INVALID', 'The evidence projection identity or version is invalid', 409);
  const parsed = getWorkflowProjection(table).bodySchema.safeParse(row.body);
  invariant(parsed.success, 'WORKFLOW_EVIDENCE_INVALID', 'The evidence projection body is invalid', 409);
  const body = projectionIdentitySchema.safeParse(parsed.data);
  invariant(body.success && body.data.id === row.id &&
    (body.data.rowVersion === undefined || body.data.rowVersion === row.rowVersion),
  'WORKFLOW_EVIDENCE_INVALID', 'The evidence projection body is invalid', 409);
  return body.data;
}

async function materializeFacts<T extends { id: string; branchId: string; date: string }>(
  projections: WorkflowProjectionReader,
  table: FactTable,
  schema: z.ZodType<T>,
  scope: Scope & { branchIds: string[] },
): Promise<T[]> {
  const rows: T[] = [], seen = new Set<string>(), cursors = new Set<string>(), allowed = new Set(scope.branchIds);
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < maximumPages; pageNumber += 1) {
    const query = { kind: 'scoped' as const, table, branchIds: scope.branchIds,
      fromDate: scope.date, throughDate: scope.date, limit: pageSize,
      ...(cursor === undefined ? {} : { cursor }) };
    const page = await projections.query<unknown>(query);
    invariant(Array.isArray(page) && page.length <= pageSize,
      'WORKFLOW_EVIDENCE_INVALID', 'The evidence page exceeded its bound', 409);
    for (const row of page) {
      const body = checked(row, table), parsed = schema.safeParse(body);
      invariant(parsed.success && identifier.safeParse(parsed.data.id).success &&
        identifier.safeParse(parsed.data.branchId).success && allowed.has(parsed.data.branchId) && parsed.data.date === scope.date,
      'WORKFLOW_EVIDENCE_INVALID', 'The evidence page contains invalid or out-of-scope data', 409);
      invariant(!seen.has(row.id) && row.id !== cursor,
        'WORKFLOW_EVIDENCE_INVALID', 'The evidence cursor repeated or did not advance', 409);
      seen.add(row.id); rows.push(parsed.data);
    }
    if (page.length === 0) return rows;
    const nextCursor = page.at(-1)!.id;
    // Ordering and the exclusive cursor predicate belong to the same database
    // collation. JavaScript's string comparator cannot validate their order.
    invariant(nextCursor !== cursor && !cursors.has(nextCursor),
      'WORKFLOW_EVIDENCE_INVALID', 'The evidence cursor did not advance', 409);
    cursors.add(nextCursor);
    if (page.length < pageSize) {
      // The storage contract says a short page is exhausted. Verify its tail so
      // an incomplete short page cannot silently become a partial calculation.
      const tail = await projections.query<unknown>({ ...query, cursor: nextCursor, limit: 1 });
      invariant(Array.isArray(tail) && tail.length === 0,
        'WORKFLOW_EVIDENCE_INVALID', 'The evidence page was incomplete', 409);
      return rows;
    }
    cursor = nextCursor;
  }
  throw new DomainError('WORKFLOW_EVIDENCE_INVALID', 'The evidence query exceeded its page bound', 409);
}

/**
 * Materialize exact authorized rows in the caller's guarded transaction, then
 * invoke the unchanged retail calculator once. This module never opens a store.
 */
export async function readWorkflowEvidence(context: WorkflowEvidenceContext, input: Scope): Promise<Evidence> {
  const parsedScope = scopeSchema.safeParse(input);
  const now = new Date(context.now.getTime());
  invariant(parsedScope.success && Number.isFinite(now.getTime()),
    'WORKFLOW_REQUEST_INVALID', 'The evidence scope or current instant is invalid');
  const { principal, projections } = context, currentActor = principal.actor;
  invariant(currentActor.role === 'executive' || currentActor.role === 'east_manager',
    'WORKFLOW_ROLE_DENIED', 'The directory role cannot read retail evidence', 403);
  invariant(principal.directory.body.department === 'sales_operations',
    'WORKFLOW_SCOPE_DENIED', 'The directory department cannot read retail evidence', 403);
  const grants = ['sales.read', 'operations.read'].map(permission => authorizeWorkflowScope(principal,
    { permission, roles, purpose: 'sales_operations', targets: [] }));
  const allowed = new Set(grants[0].grants.flatMap(grant => grant.branchIds)
    .filter(id => grants[1].grants.some(grant => grant.branchIds.includes(id))));
  const principalBranches = new Map(principal.branches.map(row => [row.id, row]));
  invariant(principalBranches.size === principal.branches.length,
    'WORKFLOW_AUTHORITY_INVALID', 'The evidence authority repeats a branch', 409);
  const regionNames = [...new Set(principal.branches.map(row => row.body.region))];
  const matches = regionNames.filter(region => region.toLowerCase() === parsedScope.data.region.toLowerCase());
  invariant(parsedScope.data.region.toLowerCase() === 'all' || matches.length === 1,
    'WORKFLOW_SCOPE_DENIED', 'The evidence region is outside the current scope', 403);
  const region = parsedScope.data.region.toLowerCase() === 'all' ? 'all' : matches[0];
  const explicitIds = parsedScope.data.branchIds;
  invariant(explicitIds === undefined || new Set(explicitIds).size === explicitIds.length,
    'WORKFLOW_REQUEST_INVALID', 'The evidence scope repeats a branch');
  const ids = [...(explicitIds ?? allowed)].filter(id => {
    const branch = principalBranches.get(id);
    if (explicitIds !== undefined) invariant(allowed.has(id) && branch && branch.body.active !== false &&
      (region === 'all' || branch.body.region === region),
    'WORKFLOW_SCOPE_DENIED', 'An evidence branch is outside the current scope', 403);
    return allowed.has(id) && branch && branch.body.active !== false && (region === 'all' || branch.body.region === region);
  }).sort();
  invariant(ids.length > 0, 'WORKFLOW_SCOPE_DENIED', 'No active branches are authorized for this evidence scope', 403);
  const branches: Branch[] = [], seen = new Set<string>();
  for (let offset = 0; offset < ids.length; offset += pageSize) {
    const chunk = ids.slice(offset, offset + pageSize), chunkIds = new Set(chunk);
    const page = await projections.query<unknown>({ kind: 'ids', table: 'branches', ids: chunk });
    invariant(Array.isArray(page) && page.length === chunk.length,
      'WORKFLOW_EVIDENCE_INVALID', 'The authorized branch page is incomplete', 409);
    for (const row of page) {
      const body = checked(row, 'branches'), parsed = currentBranchSchema.safeParse(body), anchor = principalBranches.get(row.id);
      invariant(parsed.success && chunkIds.has(row.id) && !seen.has(row.id) && parsed.data.active !== false &&
        anchor && anchor.rowVersion === row.rowVersion && digest(anchor.body) === digest(body),
      'WORKFLOW_EVIDENCE_INVALID', 'The authorized branch projection changed or is invalid', 409);
      invariant(!parsed.data.orgUnitId || principal.orgUnits.some(unit => unit.id === parsed.data.orgUnitId && unit.body.active),
        'WORKFLOW_SCOPE_DENIED', 'The evidence branch organization is inactive', 403);
      seen.add(row.id); branches.push(parsed.data);
    }
  }
  branches.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const scope = scopeSchema.parse({ date: parsedScope.data.date, region, branchIds: ids });
  // ids is explicit above; retain the narrowed type needed by the query adapter.
  const exactScope = { ...scope, branchIds: ids };
  for (const permission of ['sales.read', 'operations.read']) authorizeWorkflowScope(principal,
    { permission, roles, purpose: 'sales_operations', targets: ids.map(branchId => ({ branchId })) });
  const datasets = {
    branches,
    sales_orders: await materializeFacts(projections, 'sales_orders', factSchemas.sales_orders, exactScope),
    sales_targets: await materializeFacts(projections, 'sales_targets', factSchemas.sales_targets, exactScope),
    inventory_snapshots: await materializeFacts(projections, 'inventory_snapshots', factSchemas.inventory_snapshots, exactScope),
    incidents: await materializeFacts(projections, 'incidents', factSchemas.incidents, exactScope),
    staffing_summaries: await materializeFacts(projections, 'staffing_summaries', factSchemas.staffing_summaries, exactScope),
  };
  const actor: Actor = { ...currentActor, role: currentActor.role,
    permissions: [...currentActor.permissions], regions: [...currentActor.regions] };
  const reader: Reader = {
    get: async () => { throw new DomainError('WORKFLOW_EVIDENCE_INVALID', 'The evidence calculator requested an unsupported read', 409); },
    list: async <T>(table: Parameters<Reader['list']>[0], filters?: Parameters<Reader['list']>[1]): Promise<T[]> => {
      invariant(Object.hasOwn(datasets, table), 'WORKFLOW_EVIDENCE_INVALID', 'The evidence calculator requested an unsupported table', 409);
      if (table === 'branches') invariant(filters === undefined,
        'WORKFLOW_EVIDENCE_INVALID', 'The evidence calculator requested unsupported branch filters', 409);
      else invariant(filters && Object.keys(filters).length === 2 && filters.date === scope.date &&
        Array.isArray(filters.branchId) && digest(filters.branchId) === digest(ids),
      'WORKFLOW_EVIDENCE_INVALID', 'The evidence calculator requested unsupported fact filters', 409);
      // Reader's generic result is selected only after the closed table/filter checks.
      return structuredClone(datasets[table as keyof typeof datasets]) as T[];
    },
  };
  const evidence = await readEvidence(reader, actor, exactScope, now);
  invariant(evidence.branches.length === ids.length && evidence.branches.every(branch => seen.has(branch.branchId)) &&
    digest(evidence.scope.branchIds) === digest(ids),
  'WORKFLOW_EVIDENCE_INVALID', 'The evidence calculator changed its authorized scope', 409);
  return evidence;
}
