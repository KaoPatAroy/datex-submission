import { z, type ZodTypeAny } from 'zod';
import { businessDateSchema, dashboardSpecSchema, scopeSchema, tables, type RowFilter, type Table } from '../contracts';
import {
  persistedConversationSchema,
  persistedConversationMessageSchema,
  dashboardShareV2Schema,
  dashboardShareRevokeEventSchema,
  entityStateSchema,
  expectedRowSchema,
  instantSchema,
  directoryIdentitySchema,
  onboardingRequestSchema,
  pendingActionV2Schema,
  responsibilitySchema,
  refSchema,
  reviewSnapshotSchema,
  simulatedDeliverySchema,
  versionedDemoWorkflowPolicySchema,
  type GuardedTransaction,
  workflowEntityTables,
  workflowReceiptV2Schema,
  targetProofSchema,
  type CasBody,
  type WorkflowStorageTable,
  rowVersionSchema,
  isoDateSchema,
  MAX_WORKFLOW_REASON_CHARS,
  MAX_WORKFLOW_TARGETS,
} from '../workflows/contracts';

export type WorkflowTableClass = 'shared' | 'mixed' | 'new';
export type WorkflowSqlType = 'text' | 'integer' | 'real' | 'boolean' | 'json';

export interface ProjectedRow<T = Record<string, unknown>> {
  id: string;
  rowVersion: number;
  body: T;
}

export interface WorkflowProjectionColumn {
  column: string;
  bodyField: string;
  type: WorkflowSqlType;
  nullable: boolean;
  state?: boolean;
  immutable?: boolean;
  queryable?: boolean;
  external?: boolean;
  /** Preserved historical projection; no new body may supply this field. */
  legacyOnly?: true;
}

export interface WorkflowUniqueConstraint {
  name: string;
  fields: readonly string[];
  openOnly?: boolean;
  openStates?: readonly string[];
  /** A native FK parent key must cover every row, including shared-table history. */
  referenceKey?: true;
}

export interface WorkflowForeignKey {
  column: string;
  target: WorkflowStorageTable;
  nullable: boolean;
  deferred?: boolean;
  bodyField?: string;
  tagField?: string;
  tagValue?: string;
  external?: boolean;
  requiredContractVersion?: 2;
}

export interface WorkflowMarkerlessV2Discriminator {
  path: string;
  equals?: string | number | boolean;
  presence?: true;
}

export interface WorkflowProjectionEquality {
  leftPath: string;
  rightPath: string;
}

export interface WorkflowNormalizedChild {
  table: string;
  parentIdColumn: string;
  parentBodyField: string;
  arrayBodyField: string;
  childIdColumn: string;
  target: WorkflowStorageTable;
  uniqueName: string;
  maximumItems?: number;
  immutable?: true;
  ownership?: {
    parentTable: WorkflowStorageTable;
    parentReferenceField: string;
    ownerField: string;
    targetOwnerField: string;
  };
}

/** TypeScript and native SQL consume these same reviewed field rules. */
export interface WorkflowBodyGuard {
  field: string;
  kind: 'business_date' | 'priority' | 'reason' | 'identifier' | 'id_array' | 'employee_snapshot' | 'escalation_stage' | 'document_status' | 'nonnegative_integer';
  minimum?: number;
  maximum?: number;
}

export interface WorkflowCompositeForeignKey {
  columns: readonly string[];
  target: WorkflowStorageTable;
  targetColumns: readonly string[];
  deferred?: boolean;
}

export interface WorkflowProjectionDefinition {
  table: WorkflowStorageTable;
  storage: WorkflowTableClass;
  bodyColumn: 'payload' | 'body';
  markerColumn?: 'workflow_contract_version';
  markerlessV2Discriminators: readonly WorkflowMarkerlessV2Discriminator[];
  projectionEqualities: readonly WorkflowProjectionEquality[];
  columns: readonly WorkflowProjectionColumn[];
  stateField?: string;
  permittedTransitions: Readonly<Record<string, readonly string[]>>;
  terminalImmutableFields: Readonly<Record<string, readonly string[]>>;
  immutableFields: readonly string[];
  unique: readonly WorkflowUniqueConstraint[];
  foreignKeys: readonly WorkflowForeignKey[];
  compositeForeignKeys: readonly WorkflowCompositeForeignKey[];
  normalizedChildren: readonly WorkflowNormalizedChild[];
  queryFields: readonly string[];
  ownerField?: string;
  orgUnitField?: string;
  branchField?: string;
  dateField?: string;
  bodyGuards?: readonly WorkflowBodyGuard[];
  requiredWriteFields?: readonly string[];
  insertStates?: readonly string[];
  legacyReadOnlyStates?: readonly string[];
  /** SQL-only historical quarantine; never supplied by a public row body. */
  legacyQuarantineColumn?: string;
  bodySchema: ZodTypeAny;
}

type DefinitionSeed = Omit<WorkflowProjectionDefinition, 'bodyColumn' | 'markerColumn' | 'bodySchema' | 'normalizedChildren' | 'compositeForeignKeys' | 'terminalImmutableFields' | 'markerlessV2Discriminators' | 'projectionEqualities'> & {
  bodyFields: readonly string[];
  requiredFields?: readonly string[];
  strictSchema?: ZodTypeAny;
  normalizedChildren?: readonly WorkflowNormalizedChild[];
  compositeForeignKeys?: readonly WorkflowCompositeForeignKey[];
  terminalImmutableFields?: Readonly<Record<string, readonly string[]>>;
  markerlessV2Discriminators?: readonly WorkflowMarkerlessV2Discriminator[];
  projectionEqualities?: readonly WorkflowProjectionEquality[];
};

const idSchema = z.string().min(1).max(300);
const workflowReferenceIdSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const workflowEmployeeSnapshotSchema = z.object({
  id: workflowReferenceIdSchema,
  name: z.string().min(1),
  branchId: workflowReferenceIdSchema.nullable(),
  active: z.boolean(),
  rowVersion: rowVersionSchema,
}).strict();

function guardSchema(guard: WorkflowBodyGuard): ZodTypeAny {
  switch (guard.kind) {
    case 'business_date': return isoDateSchema;
    case 'nonnegative_integer': return z.number().int().safe().nonnegative();
    case 'priority': return z.enum(['normal', 'high']);
    case 'reason': return z.string().min(1).max(MAX_WORKFLOW_REASON_CHARS).refine(value => value.trim().length > 0);
    case 'identifier': return workflowReferenceIdSchema;
    case 'escalation_stage': return z.enum(['un_escalated', 'team_requested']);
    // The older document labels are readable quarantine data, never write aliases.
    case 'document_status': return z.enum(['accepted', 'withdrawn', 'replaced', 'missing', 'received', 'waived']);
    case 'employee_snapshot': return workflowEmployeeSnapshotSchema;
    case 'id_array': return z.array(workflowReferenceIdSchema).min(guard.minimum ?? 0).max(guard.maximum ?? MAX_WORKFLOW_TARGETS)
      .refine(values => new Set(values).size === values.length);
  }
}
const scalarSchemas: Record<WorkflowSqlType, ZodTypeAny> = {
  text: z.string(),
  integer: z.number().int().safe(),
  real: z.number().finite(),
  boolean: z.boolean(),
  json: z.unknown(),
};

function bodyFieldSchema(field: string): ZodTypeAny {
  if (['active', 'pinned'].includes(field)) return z.boolean();
  if (['idempotencyKey', 'payloadHash', 'digest', 'verificationDigest', 'confirmationDigest', 'contentDigest'].includes(field)) return z.string().regex(/^[a-f0-9]{64}$/);
  if (['rowVersion', 'expectedRowVersion', 'version', 'keyVersion', 'modeRevision', 'targetCount', 'count', 'attempt', 'quantity', 'amountSatang', 'discountBasisPoints', 'onHand', 'minimum', 'planned', 'actual'].includes(field)) return z.number().int().safe().nonnegative();
  if (['date', 'businessDate', 'dueDate', 'startDate', 'endDate', 'lastDay', 'expectedCloseDate'].includes(field)) return businessDateSchema;
  if (field.endsWith('At')) return instantSchema.nullable();
  if (['branchIds', 'approvedBranchIds', 'approvedOrgUnitIds', 'displayedIds', 'sourceIds', 'allowedChannels', 'permissions', 'regions'].includes(field)) return z.array(z.string());
  if (field === 'expectedRows') return z.array(expectedRowSchema);
  if (field === 'proofs') return z.array(targetProofSchema);
  if (field === 'currentStates') return z.array(entityStateSchema);
  if (field === 'ref') return refSchema;
  if (field === 'scope' || field === 'lastScope') return scopeSchema.nullable();
  if (field === 'spec') return dashboardSpecSchema;
  if (field.endsWith('Id')) return idSchema;
  if (['role', 'status', 'state', 'stage', 'kind', 'department', 'priority', 'purpose', 'outcome', 'targetStatus', 'category', 'effect', 'event', 'milestone', 'channel', 'classification', 'decision', 'contractType', 'documentType', 'templateId'].includes(field)) return z.string().min(1);
  if (['name', 'title', 'reason', 'summary', 'description', 'unansweredQuestion', 'displayName', 'verifiedDemoEmail', 'slackIdentity', 'region', 'sku', 'serialNumber', 'assetTag', 'policyVersion', 'operationKey', 'lifecycleId', 'semanticKey', 'executionId', 'destinationIdentity', 'subject', 'body', 'text'].includes(field)) return z.string();
  return z.unknown();
}

function bodyPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function bodyPathExists(value: unknown, path: string): boolean {
  let current = value;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return false;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return false;
    current = (current as Record<string, unknown>)[segment];
  }
  return true;
}

function strictBodySchema(seed: DefinitionSeed): ZodTypeAny {
  const shape: Record<string, ZodTypeAny> = {
    id: idSchema,
    rowVersion: rowVersionSchema.optional(),
  };
  for (const column of seed.columns) {
    if (column.external || column.legacyOnly) continue;
    const field = column.bodyField;
    const guard = seed.bodyGuards?.find(candidate => candidate.field === field);
    const fieldSchema = guard ? guardSchema(guard) : scalarSchemas[column.type];
    const accepted = column.nullable ? fieldSchema.nullable() : fieldSchema;
    shape[field] = seed.requiredFields?.includes(field) ? accepted : accepted.optional();
  }
  for (const field of seed.bodyFields) {
    if (!(field in shape)) {
      const guard = seed.bodyGuards?.find(candidate => candidate.field === field);
      shape[field] = (guard ? guardSchema(guard) : bodyFieldSchema(field)).optional();
    }
  }
  // Legacy scenarios annotate these shared payloads. SQL already permits them;
  // keep the sealed migration descriptors unchanged while validating the annotation.
  if (seed.table === 'inventory_snapshots' || seed.table === 'incidents') {
    shape.operationKey = z.string().optional();
  }
  return z.object(shape).strict();
}

function schemaFields(schema: object): string[] {
  const shape = Reflect.get(schema, 'shape');
  if (shape && typeof shape === 'object') return Object.keys(shape);
  const options = Reflect.get(schema, 'options');
  if (!Array.isArray(options)) return [];
  return [...new Set(options
    .filter((option): option is object => typeof option === 'object' && option !== null)
    .flatMap(schemaFields))];
}

function schemasAtBodyPath(schema: ZodTypeAny, path: readonly string[]): ZodTypeAny[] {
  if (path.length === 0) return [schema];

  const shape = Reflect.get(schema, 'shape');
  if (shape && typeof shape === 'object') {
    const child = Reflect.get(shape, path[0]);
    return child && typeof child === 'object'
      ? schemasAtBodyPath(child as ZodTypeAny, path.slice(1))
      : [];
  }

  const options = Reflect.get(schema, 'options');
  if (Array.isArray(options)) {
    return options
      .filter((option): option is ZodTypeAny => typeof option === 'object' && option !== null)
      .flatMap((option) => schemasAtBodyPath(option, path));
  }

  const unwrap = Reflect.get(schema, 'unwrap');
  if (typeof unwrap === 'function') {
    const unwrapped: unknown = unwrap.call(schema);
    if (typeof unwrapped === 'object' && unwrapped !== null) {
      return schemasAtBodyPath(unwrapped as ZodTypeAny, path);
    }
  }

  return [];
}

const column = (
  bodyField: string,
  type: WorkflowSqlType = 'text',
  options: Partial<Pick<WorkflowProjectionColumn, 'nullable' | 'state' | 'immutable' | 'queryable' | 'external'>> = {},
): WorkflowProjectionColumn => ({
  column: bodyField.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
  bodyField,
  type,
  nullable: options.nullable ?? true,
  ...options,
});

const columnAt = (
  sqlColumn: string,
  bodyField: string,
  type: WorkflowSqlType = 'text',
  options: Partial<Pick<WorkflowProjectionColumn, 'nullable' | 'state' | 'immutable' | 'queryable' | 'external'>> = {},
): WorkflowProjectionColumn => ({
  column: sqlColumn,
  bodyField,
  type,
  nullable: options.nullable ?? true,
  ...options,
});

const fk = (columnName: string, target: WorkflowStorageTable, nullable = false, deferred = false, bodyField?: string, external = false): WorkflowForeignKey => ({
  column: columnName,
  target,
  nullable,
  deferred,
  bodyField,
  external,
});
const executionFk = (columnName: string, nullable = false, deferred = false, bodyField?: string, external = false): WorkflowForeignKey => ({
  ...fk(columnName, 'action_executions', nullable, deferred, bodyField, external),
  requiredContractVersion: 2,
});
const targetFk = (columnName: string, target: WorkflowStorageTable): WorkflowForeignKey => ({
  column: columnName,
  target,
  nullable: true,
  bodyField: 'ref.id',
  tagField: 'ref.table',
  tagValue: target,
});
const childRefs = (table: string, parentBodyField: string, arrayBodyField: string, childIdColumn: string, target: WorkflowStorageTable, uniqueName: string): WorkflowNormalizedChild => ({
  table,
  parentIdColumn: 'responsibility_id',
  parentBodyField,
  arrayBodyField,
  childIdColumn,
  target,
  uniqueName,
});

const unique = (name: string, ...fields: string[]): WorkflowUniqueConstraint => ({ name, fields });
const OPEN_WORKFLOW_STATES = Object.freeze(['active', 'open', 'pending', 'draft', 'assigned', 'in_progress', 'approved', 'returned_for_revision', 'manager_review_pending', 'director_approval_pending', 'director_approved', 'onboarding_in_progress', 'prospecting', 'qualified', 'proposal', 'negotiation', 'requested']);
const openUnique = (name: string, ...fields: string[]): WorkflowUniqueConstraint => ({ name, fields, openOnly: true, openStates: OPEN_WORKFLOW_STATES });
const pendingActionStaleReasonSchema = z.enum([
  'superseded',
  'user_cancelled',
  'expired',
  'mode_changed',
  'release_changed',
  'evidence_changed',
  'source_turn_failed',
  'source_turn_cancelled',
]);
const pendingActionRevisionDiffLineSchema = z.string().min(1).max(600).refine(value => value.trim().length > 0);
const legacyPendingActionBaseSchema = z.object({
  id: idSchema, actorId: idSchema, sessionId: idSchema, conversationId: idSchema, turnId: idSchema,
  mode: z.enum(['live_ai', 'scripted_demo']), modeRevision: z.number().int().nonnegative(), payload: z.unknown(),
  payloadHash: z.string().min(1), evidenceVersion: z.string().nullable().optional(), packs: z.array(z.unknown()),
  receiptAccess: z.unknown().optional(), releaseRevision: z.string().optional(), actionContractVersion: z.literal(1).optional(),
  approvalScope: z.unknown().optional(), approvalDisplay: z.unknown().optional(),
  predecessorActionId: idSchema.optional(),
  supersededByActionId: idSchema.optional(),
  staleReason: pendingActionStaleReasonSchema.optional(),
  revisionDiff: z.array(pendingActionRevisionDiffLineSchema).min(1).max(32).optional(),
  createdAt: z.string(), expiresAt: z.string(),
  status: z.enum(['pending', 'claimed', 'completed', 'stale']), preview: z.string(),
}).strict();
export const legacyPendingActionBodyFields = Object.freeze(Object.keys(legacyPendingActionBaseSchema.shape));
const legacyPendingActionSchema = legacyPendingActionBaseSchema.superRefine((action, context) => {
  if ((action.predecessorActionId === undefined) !== (action.revisionDiff === undefined)) {
    context.addIssue({ code: 'custom', path: ['revisionDiff'], message: 'Revision predecessor and diff must be supplied together.' });
  }
  if (action.status !== 'stale' && (action.supersededByActionId !== undefined || action.staleReason !== undefined)) {
    context.addIssue({ code: 'custom', path: ['staleReason'], message: 'Stale metadata may only appear on stale actions.' });
  }
  if (action.supersededByActionId !== undefined && action.staleReason !== 'superseded') {
    context.addIssue({ code: 'custom', path: ['staleReason'], message: 'Superseded action lineage requires the superseded reason.' });
  }
  if (action.staleReason === 'superseded' && action.supersededByActionId === undefined) {
    context.addIssue({ code: 'custom', path: ['supersededByActionId'], message: 'Superseded reason requires a successor action id.' });
  }
});
const legacyReceiptSchema = z.object({
  id: idSchema, actionId: idSchema, actorId: idSchema, kind: z.string(),
  status: z.enum(['verified_success', 'pending', 'failed', 'denied']), results: z.array(z.unknown()),
  createdAt: z.string(), verifiedAt: z.string().nullable(), dashboardId: idSchema.optional(),
}).strict();
const legacyDashboardShareSchema = z.object({
  id: idSchema, dashboardId: idSchema, recipientId: idSchema, actorId: idSchema,
  active: z.boolean(), operationKey: z.string(), createdAt: z.string(),
}).strict();
const legacyTicketSchema = z.object({
  id: idSchema, branchId: idSchema, assigneeId: idSchema, title: z.string(), reason: z.string(),
  unansweredQuestion: z.string(), sourceIds: z.array(idSchema), status: z.literal('open'),
  operationKey: z.string(), createdAt: z.string(),
}).strict();
const workflowAuditSchema = z.object({
  id: idSchema,
  actorId: idSchema,
  category: z.string().min(1),
  summary: z.string().min(1),
  actionId: idSchema.optional(),
  executionId: idSchema.optional(),
  region: z.string().optional(),
  createdAt: z.string().min(1),
  correlationId: idSchema,
  targetRefs: z.array(z.object({ table: idSchema, id: idSchema }).strict()).optional(),
  outcome: z.string().optional(),
}).strict();
const workflowPolicyRowSchema = z.object({
  id: idSchema,
  version: z.number().int().positive(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  policy: versionedDemoWorkflowPolicySchema,
}).strict();

const seeds: DefinitionSeed[] = [
  // Shared authority and source tables. Their V1 payload remains authoritative.
  { table: 'profiles', storage: 'shared', columns: [column('role'), column('active', 'boolean')], bodyFields: ['name', 'permissions', 'regions'], requiredFields: ['role', 'active'], stateField: 'active', permittedTransitions: {}, immutableFields: ['id'], unique: [], foreignKeys: [], queryFields: ['role', 'active'] },
  { table: 'sessions', storage: 'shared', columns: [column('profileId', 'text', { nullable: false, queryable: true }), column('expiresAt', 'text', { nullable: false, queryable: true })], bodyFields: ['mode', 'modeRevision', 'csrfToken', 'createdAt'], requiredFields: ['profileId', 'expiresAt'], permittedTransitions: {}, immutableFields: ['id', 'profileId'], unique: [], foreignKeys: [fk('profile_id', 'profiles')], queryFields: ['profileId', 'expiresAt'] },
  { table: 'branches', storage: 'shared', columns: [column('name', 'text', { nullable: false, queryable: true }), column('region', 'text', { nullable: false, queryable: true }), column('orgUnitId', 'text', { queryable: true })], bodyFields: ['active', 'updatedAt'], requiredFields: ['name', 'region'], permittedTransitions: {}, immutableFields: ['id'], unique: [], foreignKeys: [fk('org_unit_id', 'org_units', true)], queryFields: ['region', 'orgUnitId'] },
  { table: 'products', storage: 'shared', columns: [column('name', 'text', { nullable: false, queryable: true }), column('category', 'text', { nullable: false, queryable: true })], bodyFields: ['active', 'sku', 'updatedAt'], requiredFields: ['name', 'category'], permittedTransitions: {}, immutableFields: ['id'], unique: [], foreignKeys: [], queryFields: ['category'] },
  { table: 'sales_orders', storage: 'shared', columns: [column('branchId', 'text', { nullable: false, queryable: true }), column('date', 'text', { nullable: false, queryable: true }), column('status', 'text', { nullable: false, state: true, queryable: true }), column('amountSatang', 'integer', { nullable: false })], bodyFields: ['updatedAt'], requiredFields: ['branchId', 'date', 'status', 'amountSatang'], stateField: 'status', permittedTransitions: { paid: ['refunded', 'cancelled'], refunded: [], cancelled: [] }, immutableFields: ['id', 'branchId', 'date'], unique: [], foreignKeys: [fk('branch_id', 'branches')], queryFields: ['branchId', 'status', 'date'] },
  { table: 'sales_targets', storage: 'shared', columns: [column('branchId', 'text', { nullable: false, queryable: true }), column('date', 'text', { nullable: false, queryable: true }), column('amountSatang', 'integer', { nullable: false })], bodyFields: ['updatedAt'], requiredFields: ['branchId', 'date', 'amountSatang'], permittedTransitions: {}, immutableFields: ['id', 'branchId', 'date'], unique: [unique('sales_targets_branch_date_unique', 'branchId', 'date')], foreignKeys: [fk('branch_id', 'branches')], queryFields: ['branchId', 'date'] },
  { table: 'inventory_snapshots', storage: 'shared', columns: [column('branchId', 'text', { nullable: false, queryable: true }), column('productId', 'text', { nullable: false, queryable: true }), column('date', 'text', { nullable: false, queryable: true }), column('onHand', 'integer', { nullable: false }), column('minimum', 'integer', { nullable: false })], bodyFields: ['observedAt', 'updatedAt'], requiredFields: ['branchId', 'productId', 'date', 'onHand', 'minimum'], permittedTransitions: {}, immutableFields: ['id', 'branchId', 'productId', 'date'], unique: [], foreignKeys: [fk('branch_id', 'branches'), fk('product_id', 'products')], queryFields: ['branchId', 'productId', 'date'] },
  { table: 'incidents', storage: 'shared', columns: [column('branchId', 'text', { nullable: false, queryable: true }), column('date', 'text', { nullable: false, queryable: true }), column('status', 'text', { nullable: false, state: true, queryable: true })], bodyFields: ['title', 'kind', 'startedAt', 'endedAt', 'updatedAt'], requiredFields: ['branchId', 'date', 'status'], stateField: 'status', permittedTransitions: { open: ['resolved'], resolved: [] }, immutableFields: ['id', 'branchId', 'date'], unique: [], foreignKeys: [fk('branch_id', 'branches')], queryFields: ['branchId', 'status', 'date'] },
  { table: 'staffing_summaries', storage: 'shared', columns: [column('branchId', 'text', { nullable: false, queryable: true }), column('date', 'text', { nullable: false, queryable: true }), column('planned', 'integer', { nullable: false }), column('actual', 'integer', { nullable: false })], bodyFields: ['observedAt', 'updatedAt'], requiredFields: ['branchId', 'date', 'planned', 'actual'], permittedTransitions: {}, immutableFields: ['id', 'branchId', 'date'], unique: [unique('staffing_summaries_branch_date_unique', 'branchId', 'date')], foreignKeys: [fk('branch_id', 'branches')], queryFields: ['branchId', 'date'] },
  { table: 'employees', storage: 'shared', columns: [column('name', 'text', { nullable: false, queryable: true }), column('branchId', 'text', { queryable: true }), column('active', 'boolean', { nullable: false, queryable: true })], bodyFields: [], requiredFields: ['name', 'active'], permittedTransitions: {}, immutableFields: ['id'], unique: [], foreignKeys: [fk('branch_id', 'branches', true)], queryFields: ['branchId', 'active'] },
  { table: 'mock_badges', storage: 'shared', columns: [column('employeeId', 'text', { nullable: false, queryable: true }), column('state', 'text', { nullable: false, state: true, queryable: true }), column('version', 'integer', { nullable: false })], bodyFields: ['updatedAt', 'operationKey'], requiredFields: ['employeeId', 'state', 'version'], stateField: 'state', permittedTransitions: { active: ['revoked'], revoked: [] }, immutableFields: ['id', 'employeeId'], unique: [], foreignKeys: [fk('employee_id', 'employees')], queryFields: ['employeeId', 'state'] },
  { table: 'conversations', storage: 'shared', columns: [column('actorId', 'text', { nullable: false, queryable: true }), column('lastDashboardId', 'text', { queryable: true }), column('title', 'text', { queryable: true }), column('pinned', 'boolean', { queryable: true }), column('archivedAt', 'text', { queryable: true }), column('updatedAt', 'text', { queryable: true })], bodyFields: ['createdAt', 'lastScope', 'pinnedAt', 'lastAnalysis'], requiredFields: ['actorId'], strictSchema: persistedConversationSchema, permittedTransitions: {}, immutableFields: ['id', 'actorId', 'createdAt'], unique: [], foreignKeys: [fk('actor_id', 'profiles'), fk('last_dashboard_id', 'dashboards', true)], queryFields: ['actorId', 'pinned', 'archivedAt', 'updatedAt'] },
  { table: 'conversation_messages', storage: 'shared', columns: [column('conversationId', 'text', { nullable: false, queryable: true }), column('actorId', 'text', { nullable: false, queryable: true }), column('createdAt', 'text', { nullable: false, queryable: true }), column('turnId', 'text', { queryable: true }), column('sessionId', 'text', { queryable: true })], bodyFields: ['role', 'text', 'mode', 'modeRevision', 'analysis', 'evidence', 'sources', 'pendingActionId', 'pendingActionIds', 'turnId', 'sessionId', 'receiptId'], requiredFields: ['conversationId', 'actorId', 'createdAt'], strictSchema: persistedConversationMessageSchema, permittedTransitions: {}, immutableFields: ['id', 'conversationId', 'actorId', 'createdAt'], unique: [], foreignKeys: [fk('conversation_id', 'conversations'), fk('actor_id', 'profiles')], queryFields: ['conversationId', 'actorId', 'createdAt', 'turnId', 'sessionId'] },
  { table: 'dashboards', storage: 'shared', columns: [column('ownerId', 'text', { nullable: false, queryable: true }), column('conversationId', 'text', { queryable: true }), column('updatedAt', 'text', { nullable: false, queryable: true })], bodyFields: ['spec', 'packs', 'createdAt', 'lastRefreshAt', 'sourceMetadata', 'analysis', 'evidenceVersion'], requiredFields: ['ownerId', 'updatedAt'], permittedTransitions: {}, immutableFields: ['id', 'ownerId', 'createdAt'], unique: [], foreignKeys: [fk('owner_id', 'profiles'), fk('conversation_id', 'conversations', true)], queryFields: ['ownerId', 'conversationId', 'updatedAt'] },
  { table: 'policy_documents', storage: 'shared', columns: [column('title', 'text', { nullable: false, queryable: true }), column('version', 'text', { nullable: false, queryable: true })], bodyFields: ['text', 'updatedAt'], requiredFields: ['title', 'version'], permittedTransitions: {}, immutableFields: ['id', 'version'], unique: [unique('policy_documents_id_version_unique', 'id', 'version')], foreignKeys: [], queryFields: ['version'] },
  { table: 'mock_tickets', storage: 'mixed', columns: [column('branchId', 'text', { queryable: true }), column('assigneeId', 'text', { queryable: true }), column('status', 'text', { state: true, queryable: true }), column('operationKey', 'text', { queryable: true }), column('ownerIdentityId', 'text', { queryable: true }), column('caseId', 'text', { queryable: true }), column('executionId', 'text', { queryable: true }), column('dueDate', 'text', { queryable: true }), column('priority', 'text', { queryable: true })], bodyFields: ['title', 'reason', 'unansweredQuestion', 'sourceIds', 'createdAt', 'ownerIdentityId', 'caseId', 'executionId', 'dueDate', 'priority'], strictSchema: legacyTicketSchema, stateField: 'status', permittedTransitions: { open: ['completed', 'cancelled'], completed: [], cancelled: [] }, immutableFields: ['id', 'operationKey'], unique: [unique('mock_ticket_operation_unique', 'operationKey')], foreignKeys: [fk('branch_id', 'branches', true), fk('assignee_id', 'profiles', true), fk('owner_identity_id', 'directory_identities', true), fk('case_id', 'investigation_cases', true), executionFk('execution_id', true)], queryFields: ['branchId', 'assigneeId', 'status', 'operationKey', 'ownerIdentityId', 'caseId', 'executionId', 'dueDate', 'priority'], dateField: 'dueDate' },
  { table: 'pending_actions', storage: 'mixed', columns: [column('actorId', 'text', { nullable: false, queryable: true }), column('sessionId', 'text', { nullable: false, queryable: true }), column('conversationId', 'text', { nullable: false, queryable: true }), column('reviewedSnapshotId', 'text', { queryable: true }), column('status', 'text', { nullable: false, state: true, queryable: true }), column('idempotencyKey', 'text', { immutable: true, queryable: true }), column('payloadHash', 'text', { nullable: false, immutable: true }), column('expiresAt', 'text', { queryable: true }), columnAt('policy_id', 'policy.id', 'text', { immutable: true, queryable: true }), columnAt('policy_version', 'policy.version', 'integer', { immutable: true, queryable: true }), columnAt('policy_digest', 'policy.digest', 'text', { immutable: true, queryable: true })], bodyFields: ['contractVersion', 'turnId', 'mode', 'modeRevision', 'payload', 'payloadHash', 'evidenceVersion', 'idempotencyKey', 'targets', 'targetCount', 'expectedRows', 'approvedBranchIds', 'approvedOrgUnitIds', 'reviewedSnapshotId', 'policy', 'packs', 'releaseRevision', 'actionContractVersion', 'approvalScope', 'approvalDisplay', 'executionMode', 'createdAt', 'expiresAt', 'receiptAccess', 'preview', 'predecessorActionId', 'supersededByActionId', 'staleReason', 'revisionDiff'], strictSchema: z.union([pendingActionV2Schema, legacyPendingActionSchema]), stateField: 'status', permittedTransitions: { pending: ['claimed', 'stale'], claimed: ['completed', 'stale'], completed: [], stale: [] }, terminalImmutableFields: { claimed: ['supersededByActionId', 'staleReason'], stale: ['supersededByActionId', 'staleReason'] }, immutableFields: ['id', 'contractVersion', 'actorId', 'sessionId', 'conversationId', 'turnId', 'mode', 'modeRevision', 'payload', 'payloadHash', 'idempotencyKey', 'targets', 'targetCount', 'expectedRows', 'approvedBranchIds', 'approvedOrgUnitIds', 'reviewedSnapshotId', 'policy', 'packs', 'releaseRevision', 'executionMode', 'createdAt', 'expiresAt', 'predecessorActionId', 'revisionDiff'], unique: [], foreignKeys: [fk('actor_id', 'profiles'), fk('session_id', 'sessions'), fk('conversation_id', 'conversations'), fk('reviewed_snapshot_id', 'review_snapshots', true)], compositeForeignKeys: [{ columns: ['policy_id', 'policy_version', 'policy_digest'], target: 'workflow_policies', targetColumns: ['policy_id', 'version', 'digest'], deferred: true }], markerlessV2Discriminators: [{ path: 'contractVersion', equals: 2 }], queryFields: ['actorId', 'sessionId', 'conversationId', 'reviewedSnapshotId', 'status', 'expiresAt'], dateField: 'expiresAt' },
  { table: 'action_executions', storage: 'mixed', columns: [column('actionId', 'text', { nullable: false, immutable: true, queryable: true }), column('rootId', 'text', { nullable: false, immutable: true, queryable: true, external: true }), column('attempt', 'integer', { nullable: false, immutable: true, queryable: true, external: true }), column('outcome', 'text', { state: true, queryable: true }), column('executionId', 'text', { immutable: true, queryable: true }), column('createdAt', 'text', { queryable: true })], bodyFields: ['actionId', 'actorId', 'kind', 'contractVersion', 'outcome', 'proofs', 'currentStates', 'createdAt', 'verifiedAt', 'results', 'status', 'dashboardId'], strictSchema: z.union([workflowReceiptV2Schema, legacyReceiptSchema]), stateField: 'outcome', permittedTransitions: { pending: ['verified_success', 'already_completed', 'denied', 'stale', 'failed'], verified_success: [], already_completed: [], denied: [], stale: [], failed: [] }, terminalImmutableFields: { verified_success: ['proofs', 'currentStates', 'verifiedAt'], already_completed: ['proofs', 'currentStates', 'verifiedAt'], denied: ['proofs', 'currentStates', 'verifiedAt'], stale: ['proofs', 'currentStates', 'verifiedAt'], failed: ['proofs', 'currentStates', 'verifiedAt'] }, immutableFields: ['id', 'actionId', 'actorId', 'kind', 'contractVersion', 'createdAt'], unique: [unique('action_executions_root_attempt_unique', 'rootId', 'attempt')], foreignKeys: [fk('action_id', 'pending_actions'), fk('root_id', 'action_idempotency_roots', false, true, 'rootId', true)], markerlessV2Discriminators: [{ path: 'contractVersion', equals: 2 }], queryFields: ['actionId', 'actorId', 'rootId', 'outcome', 'createdAt'], dateField: 'createdAt' },
  { table: 'dashboard_shares', storage: 'mixed', columns: [column('dashboardId', 'text', { nullable: false, immutable: true, queryable: true }), column('dashboardVersionId', 'text', { immutable: true }), column('senderIdentityId', 'text', { immutable: true, queryable: true }), column('recipientIdentityId', 'text', { queryable: true }), column('recipientId', 'text', { queryable: true }), column('actorId', 'text', { queryable: true }), column('active', 'boolean', { queryable: true }), column('status', 'text', { state: true, queryable: true }), column('semanticKey', 'text', { immutable: true, queryable: true }), column('executionId', 'text', { immutable: true }), column('operationKey', 'text', { queryable: true }), column('createdAt', 'text', { immutable: true, queryable: true })], bodyFields: ['approvedBranchIds', 'classification', 'verificationDigest', 'keyVersion', 'channel', 'policy', 'expiresAt', 'createdAt', 'revokedAt'], strictSchema: z.union([dashboardShareV2Schema, legacyDashboardShareSchema]), stateField: 'status', permittedTransitions: { active: ['revoked'], revoked: [] }, terminalImmutableFields: { revoked: ['revokedAt'] }, immutableFields: ['id', 'dashboardId', 'dashboardVersionId', 'senderIdentityId', 'recipientIdentityId', 'recipientId', 'actorId', 'approvedBranchIds', 'classification', 'verificationDigest', 'keyVersion', 'channel', 'policy', 'expiresAt', 'semanticKey', 'executionId', 'operationKey', 'createdAt'], unique: [unique('dashboard_shares_semantic_unique', 'semanticKey'), { ...unique('dashboard_shares_revoke_version_creation_unique', 'id', 'rowVersion', 'executionId'), referenceKey: true }], foreignKeys: [fk('dashboard_id', 'dashboards'), fk('dashboard_version_id', 'dashboard_versions', true), fk('sender_identity_id', 'directory_identities', true), fk('recipient_identity_id', 'directory_identities', true), fk('recipient_id', 'profiles', true), fk('actor_id', 'profiles', true), executionFk('execution_id', true)], legacyQuarantineColumn: 'pre_migration_revoke_quarantined', compositeForeignKeys: [{ columns: ['workflow_revoke_share_id', 'workflow_revoke_share_row_version', 'workflow_revoke_creation_execution_id'], target: 'dashboard_share_revoke_events', targetColumns: ['share_id', 'revoked_share_row_version', 'share_creation_execution_id'], deferred: true }], markerlessV2Discriminators: [{ path: 'senderIdentityId', presence: true }, { path: 'recipientIdentityId', presence: true }, { path: 'approvedBranchIds', presence: true }], queryFields: ['dashboardId', 'senderIdentityId', 'recipientIdentityId', 'recipientId', 'actorId', 'status', 'semanticKey', 'createdAt'], dateField: 'createdAt' },
  { table: 'audit_events', storage: 'mixed', columns: [column('actorId', 'text', { immutable: true, queryable: true }), column('actionId', 'text', { immutable: true, queryable: true }), column('executionId', 'text', { immutable: true, queryable: true }), column('category', 'text', { immutable: true, queryable: true }), column('createdAt', 'text', { immutable: true, queryable: true }), column('correlationId', 'text', { nullable: false, immutable: true, queryable: true })], bodyFields: ['summary', 'region', 'targetRefs', 'correlationId', 'outcome'], strictSchema: workflowAuditSchema, permittedTransitions: {}, immutableFields: ['id', 'actorId', 'actionId', 'executionId', 'category', 'createdAt', 'summary', 'correlationId'], unique: [], foreignKeys: [fk('actor_id', 'profiles', true), fk('action_id', 'pending_actions', true), executionFk('execution_id', true)], markerlessV2Discriminators: [{ path: 'correlationId', presence: true }], queryFields: ['actorId', 'actionId', 'executionId', 'category', 'createdAt', 'correlationId'] },
  // Canonical V2-only tables.
  { table: 'dashboard_versions', storage: 'new', columns: [column('dashboardId', 'text', { nullable: false, immutable: true, queryable: true }), column('version', 'integer', { nullable: false, immutable: true, queryable: true }), column('ownerId', 'text', { nullable: false, immutable: true }), column('createdAt', 'text', { nullable: false, immutable: true, queryable: true })], bodyFields: ['spec', 'packs', 'sourceMetadata', 'analysis', 'evidenceVersion', 'digest'], requiredFields: ['dashboardId', 'version', 'ownerId', 'createdAt'], immutableFields: ['id', 'dashboardId', 'version', 'ownerId', 'spec', 'packs', 'sourceMetadata', 'analysis', 'evidenceVersion', 'createdAt', 'digest'], permittedTransitions: {}, unique: [unique('dashboard_versions_dashboard_version_unique', 'dashboardId', 'version')], foreignKeys: [fk('dashboard_id', 'dashboards'), fk('owner_id', 'profiles')], queryFields: ['dashboardId', 'ownerId', 'createdAt'], dateField: 'createdAt' },
  { table: 'dashboard_share_revoke_events', storage: 'new', columns: [column('shareId', 'text', { nullable: false, immutable: true, queryable: true }), column('actorId', 'text', { nullable: false, immutable: true, queryable: true }), column('executionId', 'text', { nullable: false, immutable: true, queryable: true }), column('shareCreationExecutionId', 'text', { nullable: false, immutable: true, queryable: true }), column('priorShareRowVersion', 'integer', { nullable: false, immutable: true }), column('revokedShareRowVersion', 'integer', { nullable: false, immutable: true }), column('createdAt', 'text', { nullable: false, immutable: true, queryable: true })], bodyFields: [], strictSchema: dashboardShareRevokeEventSchema, requiredFields: ['shareId', 'actorId', 'executionId', 'shareCreationExecutionId', 'priorShareRowVersion', 'revokedShareRowVersion', 'createdAt'], immutableFields: ['id', 'shareId', 'actorId', 'executionId', 'shareCreationExecutionId', 'priorShareRowVersion', 'revokedShareRowVersion', 'createdAt', 'rowVersion'], permittedTransitions: {}, unique: [unique('dashboard_share_revoke_events_share_unique', 'shareId'), unique('dashboard_share_revoke_events_execution_unique', 'executionId'), unique('dashboard_share_revoke_events_version_creation_unique', 'shareId', 'revokedShareRowVersion', 'shareCreationExecutionId')], foreignKeys: [{ ...fk('share_id', 'dashboard_shares'), requiredContractVersion: 2 }, fk('actor_id', 'profiles'), executionFk('execution_id'), executionFk('share_creation_execution_id')], compositeForeignKeys: [{ columns: ['share_id', 'revoked_share_row_version', 'share_creation_execution_id'], target: 'dashboard_shares', targetColumns: ['id', 'row_version', 'execution_id'], deferred: true }], queryFields: ['shareId', 'actorId', 'executionId', 'shareCreationExecutionId', 'createdAt'], dateField: 'createdAt' },
  { table: 'share_scope_branches', storage: 'new', columns: [column('shareId', 'text', { nullable: false, immutable: true, queryable: true }), column('branchId', 'text', { nullable: false, immutable: true, queryable: true })], bodyFields: [], requiredFields: ['shareId', 'branchId'], immutableFields: ['id', 'shareId', 'branchId'], permittedTransitions: {}, unique: [unique('share_scope_branches_share_branch_unique', 'shareId', 'branchId')], foreignKeys: [fk('share_id', 'dashboard_shares'), fk('branch_id', 'branches')], queryFields: ['shareId', 'branchId'] },
  { table: 'simulated_deliveries', storage: 'new', columns: [column('shareId', 'text', { nullable: false, immutable: true, queryable: true }), column('recipientIdentityId', 'text', { nullable: false, immutable: true, queryable: true }), column('executionId', 'text', { nullable: false, immutable: true, queryable: true }), column('status', 'text', { nullable: false, state: true, immutable: true }), column('createdAt', 'text', { nullable: false, immutable: true, queryable: true })], bodyFields: ['channel', 'destinationIdentity', 'subject', 'body'], requiredFields: ['shareId', 'recipientIdentityId', 'executionId', 'status', 'createdAt'], strictSchema: simulatedDeliverySchema, stateField: 'status', permittedTransitions: { simulated_completed: [] }, immutableFields: ['id', 'shareId', 'recipientIdentityId', 'executionId', 'status'], unique: [unique('simulated_deliveries_execution_unique', 'executionId')], foreignKeys: [fk('share_id', 'dashboard_shares'), fk('recipient_identity_id', 'directory_identities'), executionFk('execution_id')], queryFields: ['shareId', 'recipientIdentityId', 'status', 'createdAt'], dateField: 'createdAt' },
  { table: 'share_access_events', storage: 'new', columns: [column('shareId', 'text', { nullable: false, immutable: true, queryable: true }), column('actorIdentityId', 'text', { nullable: false, immutable: true, queryable: true }), column('event', 'text', { nullable: false, immutable: true, queryable: true }), column('createdAt', 'text', { nullable: false, immutable: true, queryable: true })], bodyFields: ['correlationId', 'outcome'], requiredFields: ['shareId', 'actorIdentityId', 'event', 'createdAt'], immutableFields: ['id', 'shareId', 'actorIdentityId', 'event', 'createdAt'], permittedTransitions: {}, unique: [], foreignKeys: [fk('share_id', 'dashboard_shares'), fk('actor_identity_id', 'directory_identities')], queryFields: ['shareId', 'actorIdentityId', 'event', 'createdAt'] },
  { table: 'org_units', storage: 'new', columns: [column('parentOrgUnitId', 'text', { queryable: true }), column('name', 'text', { nullable: false, queryable: true }), column('active', 'boolean', { nullable: false, queryable: true })], bodyFields: ['kind', 'createdAt'], requiredFields: ['name', 'active'], immutableFields: ['id'], permittedTransitions: { active: ['inactive'], inactive: ['active'] }, stateField: 'active', unique: [unique('org_units_name_unique', 'name')], foreignKeys: [fk('parent_org_unit_id', 'org_units', true, true)], queryFields: ['parentOrgUnitId', 'active'] },
  { table: 'directory_identities', storage: 'new', columns: [column('profileId', 'text', { nullable: false, immutable: true, queryable: true }), column('orgUnitId', 'text', { nullable: false, queryable: true }), column('managerIdentityId', 'text', { queryable: true }), column('role', 'text', { nullable: false, queryable: true }), column('active', 'boolean', { nullable: false, state: true, queryable: true }), column('verifiedDemoEmail', 'text', { nullable: false, immutable: true })], bodyFields: ['displayName', 'department', 'slackIdentity', 'allowedChannels', 'classificationCeiling'], requiredFields: ['profileId', 'orgUnitId', 'role', 'active', 'verifiedDemoEmail'], strictSchema: directoryIdentitySchema, stateField: 'active', permittedTransitions: { active: ['inactive'], inactive: ['active'] }, immutableFields: ['id', 'profileId'], unique: [unique('directory_identities_profile_unique', 'profileId'), unique('directory_identities_email_unique', 'verifiedDemoEmail')], foreignKeys: [fk('profile_id', 'profiles'), fk('org_unit_id', 'org_units'), fk('manager_identity_id', 'directory_identities', true, true)], queryFields: ['profileId', 'orgUnitId', 'managerIdentityId', 'role', 'active'] },
  { table: 'responsibilities', storage: 'new', columns: [column('identityId', 'text', { nullable: false, immutable: true, queryable: true }), column('orgUnitId', 'text', { nullable: false, queryable: true }), column('purpose', 'text', { nullable: false, queryable: true }), column('active', 'boolean', { nullable: false, state: true, queryable: true })], bodyFields: ['branchIds'], requiredFields: ['identityId', 'orgUnitId', 'purpose', 'active'], strictSchema: responsibilitySchema, stateField: 'active', permittedTransitions: { active: ['inactive'], inactive: ['active'] }, immutableFields: ['id', 'identityId', 'purpose'], unique: [openUnique('responsibilities_open_identity_purpose_unique', 'identityId', 'purpose', 'orgUnitId')], foreignKeys: [fk('identity_id', 'directory_identities'), fk('org_unit_id', 'org_units')], normalizedChildren: [childRefs('workflow_responsibility_branches', 'id', 'branchIds', 'branch_id', 'branches', 'workflow_responsibility_branches_unique')], queryFields: ['identityId', 'orgUnitId', 'purpose', 'active', 'branchId'] },
  { table: 'reporting_relationships', storage: 'new', columns: [column('managerIdentityId', 'text', { nullable: false, immutable: true, queryable: true }), column('reportIdentityId', 'text', { nullable: false, immutable: true, queryable: true }), column('orgUnitId', 'text', { nullable: false, queryable: true }), column('active', 'boolean', { nullable: false, state: true, queryable: true })], bodyFields: ['createdAt'], requiredFields: ['managerIdentityId', 'reportIdentityId', 'orgUnitId', 'active'], stateField: 'active', permittedTransitions: { active: ['inactive'], inactive: ['active'] }, immutableFields: ['id', 'managerIdentityId', 'reportIdentityId'], unique: [openUnique('reporting_relationships_open_pair_unique', 'managerIdentityId', 'reportIdentityId')], foreignKeys: [fk('manager_identity_id', 'directory_identities'), fk('report_identity_id', 'directory_identities'), fk('org_unit_id', 'org_units')], queryFields: ['managerIdentityId', 'reportIdentityId', 'orgUnitId', 'active'] },
  { table: 'workflow_policies', storage: 'new', columns: [columnAt('policy_id', 'policy.id', 'text', { nullable: false, immutable: true, queryable: true }), column('version', 'integer', { nullable: false, immutable: true, queryable: true }), column('digest', 'text', { nullable: false, immutable: true, queryable: true })], bodyFields: ['policy'], requiredFields: ['policy.id', 'version', 'digest'], strictSchema: workflowPolicyRowSchema, projectionEqualities: [{ leftPath: 'version', rightPath: 'policy.version' }], permittedTransitions: {}, immutableFields: ['id', 'version', 'digest', 'policy'], unique: [unique('workflow_policies_policy_version_unique', 'policy.id', 'version'), unique('workflow_policies_policy_version_digest_unique', 'policy.id', 'version', 'digest')], foreignKeys: [], queryFields: ['version', 'digest'] },
  { table: 'review_snapshots', storage: 'new', columns: [column('actorId', 'text', { nullable: false, immutable: true, queryable: true }), column('actorSessionId', 'text', { nullable: false, immutable: true, queryable: true }), column('purpose', 'text', { nullable: false, immutable: true, queryable: true }), column('count', 'integer', { nullable: false, immutable: true }), column('digest', 'text', { nullable: false, immutable: true }), column('createdAt', 'text', { nullable: false, immutable: true, queryable: true }), column('expiresAt', 'text', { nullable: false, immutable: true, queryable: true }), columnAt('policy_id', 'policy.id', 'text', { nullable: false, immutable: true, queryable: true }), columnAt('policy_version', 'policy.version', 'integer', { nullable: false, immutable: true, queryable: true }), columnAt('policy_digest', 'policy.digest', 'text', { nullable: false, immutable: true, queryable: true })], bodyFields: ['orgUnitIds', 'displayedIds', 'expectedRows', 'policy'], requiredFields: ['actorId', 'actorSessionId', 'purpose', 'count', 'digest', 'createdAt', 'expiresAt'], strictSchema: reviewSnapshotSchema, immutableFields: ['id', 'actorId', 'actorSessionId', 'purpose', 'orgUnitIds', 'displayedIds', 'count', 'expectedRows', 'policy', 'createdAt', 'expiresAt', 'digest'], permittedTransitions: {}, unique: [unique('review_snapshots_digest_unique', 'digest')], foreignKeys: [fk('actor_id', 'profiles'), fk('actor_session_id', 'sessions')], compositeForeignKeys: [{ columns: ['policy_id', 'policy_version', 'policy_digest'], target: 'workflow_policies', targetColumns: ['policy_id', 'version', 'digest'], deferred: true }], queryFields: ['actorId', 'actorSessionId', 'purpose', 'digest', 'createdAt'], dateField: 'createdAt' },
  { table: 'review_snapshot_targets', storage: 'new', columns: [column('snapshotId', 'text', { nullable: false, immutable: true, queryable: true }), column('entityType', 'text', { nullable: false, immutable: true }), column('targetId', 'text', { nullable: false, immutable: true, queryable: true }), column('expectedRowVersion', 'integer', { nullable: false, immutable: true }), column('expectedState', 'text', { immutable: true })], bodyFields: ['ref'], requiredFields: ['snapshotId', 'entityType', 'targetId', 'expectedRowVersion'], immutableFields: ['id', 'snapshotId', 'entityType', 'targetId', 'expectedRowVersion', 'expectedState'], permittedTransitions: {}, unique: [unique('review_snapshot_targets_snapshot_target_unique', 'snapshotId', 'entityType', 'targetId')], foreignKeys: [fk('snapshot_id', 'review_snapshots'), targetFk('branch_id', 'branches'), targetFk('inventory_snapshot_id', 'inventory_snapshots'), targetFk('incident_id', 'incidents'), targetFk('employee_id', 'employees'), targetFk('badge_id', 'mock_badges'), targetFk('dashboard_version_id', 'dashboard_versions'), targetFk('opportunity_id', 'crm_opportunities'), targetFk('onboarding_request_id', 'onboarding_requests'), targetFk('onboarding_document_id', 'onboarding_documents'), targetFk('onboarding_event_id', 'onboarding_approval_events'), targetFk('offboarding_case_id', 'offboarding_cases'), targetFk('offboarding_plan_id', 'offboarding_plans'), targetFk('asset_assignment_id', 'asset_assignments'), targetFk('contract_id', 'employment_contracts'), targetFk('policy_document_id', 'policy_documents'), targetFk('directory_identity_id', 'directory_identities'), targetFk('responsibility_id', 'responsibilities'), { ...targetFk('action_execution_id', 'action_executions'), requiredContractVersion: 2 }], queryFields: ['snapshotId', 'entityType', 'targetId'] },
  { table: 'action_confirmations', storage: 'new', columns: [column('actionId', 'text', { nullable: false, immutable: true, queryable: true }), column('actorId', 'text', { nullable: false, immutable: true, queryable: true }), column('sessionId', 'text', { nullable: false, immutable: true, queryable: true }), column('confirmedAt', 'text', { nullable: false, immutable: true })], bodyFields: ['correlationId', 'confirmationDigest'], requiredFields: ['actionId', 'actorId', 'sessionId', 'confirmedAt'], immutableFields: ['id', 'actionId', 'actorId', 'sessionId', 'confirmedAt', 'confirmationDigest'], permittedTransitions: {}, unique: [unique('action_confirmations_action_unique', 'actionId')], foreignKeys: [fk('action_id', 'pending_actions'), fk('actor_id', 'profiles'), fk('session_id', 'sessions')], queryFields: ['actionId', 'actorId', 'sessionId'] },
  { table: 'action_idempotency_roots', storage: 'new', columns: [column('actorId', 'text', { nullable: false, immutable: true, queryable: true }), column('idempotencyKey', 'text', { nullable: false, immutable: true, queryable: true }), column('status', 'text', { nullable: false, state: true, queryable: true }), column('activeExecutionId', 'text', { queryable: true })], bodyFields: ['actionId', 'createdAt', 'status'], requiredFields: ['actorId', 'idempotencyKey', 'status'], stateField: 'status', permittedTransitions: { open: ['completed', 'stale'], completed: [], stale: [] }, immutableFields: ['id', 'actorId', 'idempotencyKey', 'createdAt'], unique: [unique('action_idempotency_roots_key_unique', 'idempotencyKey')], foreignKeys: [fk('actor_id', 'profiles'), executionFk('active_execution_id', true, true)], queryFields: ['actorId', 'idempotencyKey', 'activeExecutionId', 'status'] },
  { table: 'action_targets', storage: 'new', columns: [column('executionId', 'text', { nullable: false, immutable: true, queryable: true }), column('targetId', 'text', { nullable: false, immutable: true, queryable: true }), column('entityType', 'text', { nullable: false, immutable: true }), column('expectedRowVersion', 'integer', { nullable: false, immutable: true }), column('expectedState', 'text', { immutable: true }), column('targetStatus', 'text', { nullable: false, state: true, queryable: true })], bodyFields: ['ref', 'result', 'proof'], requiredFields: ['executionId', 'targetId', 'entityType', 'expectedRowVersion', 'targetStatus'], stateField: 'targetStatus', permittedTransitions: { pending: ['committed', 'failed'], committed: ['verified'], verified: [], failed: [] }, terminalImmutableFields: { verified: ['result', 'proof'], failed: ['result', 'proof'] }, immutableFields: ['id', 'executionId', 'targetId', 'entityType', 'expectedRowVersion', 'expectedState', 'ref'], unique: [unique('action_targets_execution_target_unique', 'executionId', 'entityType', 'targetId')], foreignKeys: [executionFk('execution_id'), targetFk('branch_id', 'branches'), targetFk('inventory_snapshot_id', 'inventory_snapshots'), targetFk('incident_id', 'incidents'), targetFk('employee_id', 'employees'), targetFk('badge_id', 'mock_badges'), targetFk('dashboard_version_id', 'dashboard_versions'), targetFk('opportunity_id', 'crm_opportunities'), targetFk('onboarding_request_id', 'onboarding_requests'), targetFk('onboarding_document_id', 'onboarding_documents'), targetFk('onboarding_event_id', 'onboarding_approval_events'), targetFk('offboarding_case_id', 'offboarding_cases'), targetFk('offboarding_plan_id', 'offboarding_plans'), targetFk('asset_assignment_id', 'asset_assignments'), targetFk('contract_id', 'employment_contracts'), targetFk('policy_document_id', 'policy_documents'), targetFk('investigation_case_id', 'investigation_cases'), { ...targetFk('dashboard_share_id', 'dashboard_shares'), requiredContractVersion: 2 }], queryFields: ['executionId', 'targetId', 'entityType', 'targetStatus'] },
  { table: 'semantic_effects', storage: 'new', columns: [column('semanticKey', 'text', { nullable: false, immutable: true, queryable: true }), column('executionId', 'text', { nullable: false, immutable: true, queryable: true }), column('effectType', 'text', { nullable: false, immutable: true, queryable: true }), column('effectId', 'text', { nullable: false, immutable: true, queryable: true }), column('status', 'text', { nullable: false, state: true, immutable: true, queryable: true })], bodyFields: ['createdAt'], requiredFields: ['semanticKey', 'executionId', 'effectType', 'effectId', 'status'], stateField: 'status', permittedTransitions: { committed: [] }, immutableFields: ['id', 'semanticKey', 'executionId', 'effectType', 'effectId', 'status', 'createdAt'], unique: [unique('semantic_effects_key_unique', 'semanticKey')], foreignKeys: [executionFk('execution_id')], queryFields: ['semanticKey', 'executionId', 'effectType', 'effectId', 'status'] },
  { table: 'investigation_cases', storage: 'new', columns: [column('branchId', 'text', { nullable: false, queryable: true }), column('ownerIdentityId', 'text', { nullable: false, queryable: true }), column('status', 'text', { nullable: false, state: true, queryable: true }), column('businessDate', 'text', { nullable: false, queryable: true }), column('dueDate', 'text', { queryable: true })], bodyFields: ['reason', 'priority', 'sourceIds', 'unansweredQuestion', 'executionId', 'lifecycleId'], requiredFields: ['branchId', 'ownerIdentityId', 'status', 'businessDate'], stateField: 'status', permittedTransitions: { open: ['in_progress', 'resolved', 'cancelled'], in_progress: ['resolved', 'cancelled'], resolved: [], cancelled: [] }, immutableFields: ['id', 'branchId', 'ownerIdentityId', 'businessDate', 'createdAt'], unique: [openUnique('investigation_cases_open_equivalent_unique', 'branchId', 'ownerIdentityId', 'businessDate')], foreignKeys: [fk('branch_id', 'branches'), fk('owner_identity_id', 'directory_identities')], queryFields: ['branchId', 'ownerIdentityId', 'status', 'dueDate'], dateField: 'dueDate' },
  { table: 'investigation_tasks', storage: 'new', columns: [column('caseId', 'text', { nullable: false, queryable: true }), column('ownerIdentityId', 'text', { nullable: false, queryable: true }), column('branchId', 'text', { nullable: false, queryable: true }), column('status', 'text', { nullable: false, state: true, queryable: true }), column('dueDate', 'text', { queryable: true })], bodyFields: ['reason', 'priority', 'sourceIds', 'unansweredQuestion', 'executionId', 'createdAt'], requiredFields: ['caseId', 'ownerIdentityId', 'branchId', 'status'], stateField: 'status', permittedTransitions: { open: ['in_progress', 'completed', 'cancelled'], in_progress: ['completed', 'cancelled'], completed: [], cancelled: [] }, immutableFields: ['id', 'caseId', 'ownerIdentityId', 'branchId', 'createdAt'], unique: [openUnique('investigation_tasks_open_case_owner_unique', 'caseId', 'ownerIdentityId')], foreignKeys: [fk('case_id', 'investigation_cases'), fk('owner_identity_id', 'directory_identities'), fk('branch_id', 'branches')], queryFields: ['caseId', 'ownerIdentityId', 'branchId', 'status', 'dueDate'] },
  { table: 'branch_review_assignments', storage: 'new', columns: [column('branchId', 'text', { nullable: false, queryable: true }), column('caseId', 'text', { nullable: false, queryable: true }), column('ownerIdentityId', 'text', { nullable: false, queryable: true }), column('status', 'text', { nullable: false, state: true, queryable: true })], bodyFields: ['reason', 'executionId', 'createdAt'], requiredFields: ['branchId', 'caseId', 'ownerIdentityId', 'status'], stateField: 'status', permittedTransitions: { open: ['completed', 'cancelled'], assigned: ['completed', 'cancelled'], completed: [], cancelled: [] }, immutableFields: ['id', 'branchId', 'caseId', 'ownerIdentityId'], unique: [openUnique('branch_review_assignments_open_case_unique', 'caseId')], foreignKeys: [fk('branch_id', 'branches'), fk('case_id', 'investigation_cases'), fk('owner_identity_id', 'directory_identities')], queryFields: ['branchId', 'caseId', 'ownerIdentityId', 'status'] },
  { table: 'restock_requests', storage: 'new', columns: [column('branchId', 'text', { nullable: false, queryable: true }), column('productId', 'text', { nullable: false, queryable: true }), column('inventorySnapshotId', 'text', { nullable: false, queryable: true }), column('ownerIdentityId', 'text', { nullable: false, queryable: true }), column('replenishmentLifecycleId', 'text', { nullable: false, immutable: true, queryable: true }), column('quantity', 'integer', { nullable: false }), column('status', 'text', { nullable: false, state: true, queryable: true }), column('dueDate', 'text', { queryable: true })], bodyFields: ['reason', 'priority', 'executionId', 'createdAt'], requiredFields: ['branchId', 'productId', 'inventorySnapshotId', 'ownerIdentityId', 'replenishmentLifecycleId', 'quantity', 'status'], stateField: 'status', permittedTransitions: { open: ['approved', 'completed', 'cancelled'], approved: ['completed', 'cancelled'], completed: [], cancelled: [] }, immutableFields: ['id', 'branchId', 'productId', 'inventorySnapshotId', 'replenishmentLifecycleId', 'quantity', 'createdAt'], unique: [unique('restock_requests_replenishment_lifecycle_unique', 'branchId', 'productId', 'replenishmentLifecycleId'), openUnique('restock_requests_open_product_unique', 'branchId', 'productId')], foreignKeys: [fk('branch_id', 'branches'), fk('product_id', 'products'), fk('inventory_snapshot_id', 'inventory_snapshots'), fk('owner_identity_id', 'directory_identities')], queryFields: ['branchId', 'productId', 'replenishmentLifecycleId', 'ownerIdentityId', 'status', 'dueDate'] },
  { table: 'crm_customers', storage: 'new', columns: [column('ownerIdentityId', 'text', { queryable: true }), column('status', 'text', { state: true, queryable: true })], bodyFields: ['name', 'email', 'phone', 'region', 'createdAt'], requiredFields: [], stateField: 'status', permittedTransitions: {}, immutableFields: ['id', 'createdAt'], unique: [], foreignKeys: [fk('owner_identity_id', 'directory_identities', true)], queryFields: ['ownerIdentityId', 'status'] },
  { table: 'crm_opportunities', storage: 'new', columns: [column('customerId', 'text', { nullable: false, queryable: true }), column('ownerIdentityId', 'text', { nullable: false, queryable: true }), column('title', 'text', { nullable: false, queryable: true }), column('stage', 'text', { nullable: false, state: true, queryable: true }), column('amountSatang', 'integer', { nullable: false }), column('expectedCloseDate', 'text', { queryable: true })], bodyFields: ['createdAt', 'updatedAt', 'executionId'], requiredFields: ['customerId', 'ownerIdentityId', 'title', 'stage', 'amountSatang'], stateField: 'stage', permittedTransitions: { prospecting: ['qualified', 'lost'], qualified: ['proposal', 'lost'], proposal: ['negotiation', 'lost'], negotiation: ['won', 'lost'], won: [], lost: [] }, immutableFields: ['id', 'customerId', 'ownerIdentityId', 'createdAt'], unique: [openUnique('crm_opportunities_open_equivalent_unique', 'customerId', 'title')], foreignKeys: [fk('customer_id', 'crm_customers'), fk('owner_identity_id', 'directory_identities')], queryFields: ['customerId', 'ownerIdentityId', 'stage', 'expectedCloseDate'] },
  { table: 'crm_activities', storage: 'new', columns: [column('opportunityId', 'text', { nullable: false, queryable: true }), column('ownerIdentityId', 'text', { queryable: true }), column('status', 'text', { state: true, queryable: true }), column('occurredAt', 'text', { queryable: true })], bodyFields: ['kind', 'summary', 'executionId', 'createdAt'], requiredFields: ['opportunityId'], stateField: 'status', permittedTransitions: {}, immutableFields: ['id', 'opportunityId', 'createdAt'], unique: [], foreignKeys: [fk('opportunity_id', 'crm_opportunities'), fk('owner_identity_id', 'directory_identities', true)], queryFields: ['opportunityId', 'ownerIdentityId', 'status', 'occurredAt'] },
  { table: 'crm_followups', storage: 'new', columns: [column('opportunityId', 'text', { nullable: false, queryable: true }), column('ownerIdentityId', 'text', { nullable: false, queryable: true }), column('status', 'text', { nullable: false, state: true, queryable: true }), column('dueDate', 'text', { nullable: false, queryable: true })], bodyFields: ['reason', 'priority', 'executionId', 'createdAt'], requiredFields: ['opportunityId', 'ownerIdentityId', 'status', 'dueDate'], stateField: 'status', permittedTransitions: { open: ['completed', 'cancelled'], completed: [], cancelled: [] }, immutableFields: ['id', 'opportunityId', 'ownerIdentityId', 'dueDate'], unique: [openUnique('crm_followups_open_equivalent_unique', 'opportunityId', 'ownerIdentityId', 'dueDate')], foreignKeys: [fk('opportunity_id', 'crm_opportunities'), fk('owner_identity_id', 'directory_identities')], queryFields: ['opportunityId', 'ownerIdentityId', 'status', 'dueDate'] },
  { table: 'discount_requests', storage: 'new', columns: [column('opportunityId', 'text', { nullable: false, queryable: true }), column('ownerIdentityId', 'text', { nullable: false, queryable: true }), column('status', 'text', { nullable: false, state: true, queryable: true }), column('discountBasisPoints', 'integer', { nullable: false }), column('baseAmountSatang', 'integer', { nullable: false, immutable: true }), column('expiresAt', 'text', { queryable: true })], bodyFields: ['reason', 'executionId', 'createdAt'], requiredFields: ['opportunityId', 'ownerIdentityId', 'status', 'discountBasisPoints', 'baseAmountSatang'], stateField: 'status', permittedTransitions: { manager_review_pending: ['approved', 'rejected', 'cancelled'], approved: [], rejected: [], cancelled: [] }, immutableFields: ['id', 'opportunityId', 'ownerIdentityId', 'discountBasisPoints', 'baseAmountSatang', 'createdAt'], unique: [openUnique('discount_requests_open_opportunity_unique', 'opportunityId')], foreignKeys: [fk('opportunity_id', 'crm_opportunities'), fk('owner_identity_id', 'directory_identities')], queryFields: ['opportunityId', 'ownerIdentityId', 'status', 'expiresAt'] },
  { table: 'workflow_teams', storage: 'new', columns: [column('name', 'text', { nullable: false, queryable: true }), column('active', 'boolean', { nullable: false, queryable: true })], bodyFields: ['department', 'createdAt'], requiredFields: ['name', 'active'], stateField: 'active', permittedTransitions: { active: ['inactive'], inactive: ['active'] }, immutableFields: ['id'], unique: [unique('workflow_teams_name_unique', 'name')], foreignKeys: [], queryFields: ['active'] },
  { table: 'incident_escalation_events', storage: 'new', columns: [column('incidentId', 'text', { nullable: false, immutable: true, queryable: true }), column('teamId', 'text', { nullable: false, immutable: true, queryable: true }), column('actorId', 'text', { nullable: false, immutable: true, queryable: true }), column('stage', 'text', { nullable: false, state: true, immutable: true, queryable: true }), column('lifecycleId', 'text', { nullable: false, immutable: true, queryable: true }), column('executionId', 'text', { nullable: false, immutable: true, queryable: true })], bodyFields: ['createdAt'], requiredFields: ['incidentId', 'teamId', 'actorId', 'stage', 'lifecycleId', 'executionId'], stateField: 'stage', permittedTransitions: { team_requested: [] }, immutableFields: ['id', 'incidentId', 'teamId', 'actorId', 'stage', 'lifecycleId', 'executionId', 'createdAt'], unique: [unique('incident_escalation_lifecycle_stage_unique', 'incidentId', 'lifecycleId', 'stage')], foreignKeys: [fk('incident_id', 'incidents'), fk('team_id', 'workflow_teams'), fk('actor_id', 'profiles'), executionFk('execution_id')], queryFields: ['incidentId', 'teamId', 'actorId', 'stage'] },
  { table: 'onboarding_requests', storage: 'new', columns: [column('employeeId', 'text', { nullable: false, immutable: true, queryable: true }), column('orgUnitId', 'text', { nullable: false, immutable: true, queryable: true }), column('managerIdentityId', 'text', { nullable: false, immutable: true, queryable: true }), column('directorIdentityId', 'text', { nullable: false, immutable: true, queryable: true }), column('startDate', 'text', { nullable: false, queryable: true }), column('state', 'text', { nullable: false, state: true, queryable: true }), column('lifecycleId', 'text', { nullable: false, immutable: true }), column('managerApprovalEventId', 'text', { queryable: true }), column('directorApprovalEventId', 'text', { queryable: true })], bodyFields: ['managerApprovedBy', 'managerApprovedAt', 'directorApprovedBy', 'directorApprovedAt', 'createdAt', 'updatedAt'], requiredFields: ['employeeId', 'orgUnitId', 'managerIdentityId', 'directorIdentityId', 'startDate', 'state', 'lifecycleId'], strictSchema: onboardingRequestSchema, stateField: 'state', permittedTransitions: { draft: ['manager_review_pending', 'cancelled'], manager_review_pending: ['director_approval_pending', 'returned_for_revision', 'rejected'], director_approval_pending: ['director_approved', 'returned_for_revision', 'rejected'], director_approved: ['onboarding_in_progress'], onboarding_in_progress: ['completed'], returned_for_revision: [], rejected: [], completed: [], cancelled: [] }, immutableFields: ['id', 'employeeId', 'orgUnitId', 'managerIdentityId', 'directorIdentityId', 'startDate', 'lifecycleId', 'createdAt'], unique: [openUnique('onboarding_requests_open_employee_lifecycle_unique', 'employeeId', 'lifecycleId')], foreignKeys: [fk('employee_id', 'employees'), fk('org_unit_id', 'org_units'), fk('manager_identity_id', 'directory_identities'), fk('director_identity_id', 'directory_identities'), fk('manager_approval_event_id', 'onboarding_approval_events', true, true), fk('director_approval_event_id', 'onboarding_approval_events', true, true)], queryFields: ['employeeId', 'orgUnitId', 'managerIdentityId', 'directorIdentityId', 'state', 'startDate'] },
  { table: 'onboarding_documents', storage: 'new', columns: [column('requestId', 'text', { nullable: false, immutable: true, queryable: true }), column('employeeId', 'text', { nullable: false, immutable: true, queryable: true }), column('documentType', 'text', { nullable: false, queryable: true }), column('status', 'text', { nullable: false, state: true, queryable: true })], bodyFields: ['policyVersion', 'classification', 'contentDigest', 'createdAt', 'withdrawnAt'], requiredFields: ['requestId', 'employeeId', 'documentType', 'status'], stateField: 'status', permittedTransitions: { missing: ['received', 'waived'], received: ['withdrawn'], waived: [], withdrawn: ['received'] }, immutableFields: ['id', 'requestId', 'employeeId', 'documentType', 'contentDigest', 'createdAt'], unique: [unique('onboarding_documents_request_type_unique', 'requestId', 'documentType')], foreignKeys: [fk('request_id', 'onboarding_requests'), fk('employee_id', 'employees')], queryFields: ['requestId', 'employeeId', 'documentType', 'status'] },
  { table: 'onboarding_approval_events', storage: 'new', columns: [column('requestId', 'text', { nullable: false, immutable: true, queryable: true }), column('actorIdentityId', 'text', { nullable: false, immutable: true, queryable: true }), column('stage', 'text', { nullable: false, immutable: true, queryable: true }), column('lifecycleId', 'text', { nullable: false, immutable: true, queryable: true }), column('executionId', 'text', { immutable: true })], bodyFields: ['decision', 'reason', 'createdAt'], requiredFields: ['requestId', 'actorIdentityId', 'stage', 'lifecycleId'], immutableFields: ['id', 'requestId', 'actorIdentityId', 'stage', 'lifecycleId', 'executionId', 'decision', 'createdAt'], permittedTransitions: {}, unique: [unique('onboarding_approval_lifecycle_stage_unique', 'requestId', 'lifecycleId', 'stage')], foreignKeys: [fk('request_id', 'onboarding_requests'), fk('actor_identity_id', 'directory_identities'), executionFk('execution_id', true)], queryFields: ['requestId', 'actorIdentityId', 'stage', 'lifecycleId'] },
  { table: 'onboarding_checklists', storage: 'new', columns: [column('requestId', 'text', { nullable: false, queryable: true }), column('templateId', 'text', { nullable: false, immutable: true, queryable: true }), column('status', 'text', { nullable: false, state: true, queryable: true })], bodyFields: ['title', 'createdAt', 'completedAt'], requiredFields: ['requestId', 'templateId', 'status'], stateField: 'status', permittedTransitions: { open: ['completed'], completed: [] }, immutableFields: ['id', 'requestId', 'templateId'], unique: [unique('onboarding_checklists_request_template_unique', 'requestId', 'templateId')], foreignKeys: [fk('request_id', 'onboarding_requests')], queryFields: ['requestId', 'templateId', 'status'] },
  { table: 'onboarding_tasks', storage: 'new', columns: [column('requestId', 'text', { nullable: false, queryable: true }), column('employeeId', 'text', { nullable: false, queryable: true }), column('ownerIdentityId', 'text', { nullable: false, queryable: true }), column('templateId', 'text', { nullable: false, immutable: true, queryable: true }), column('status', 'text', { nullable: false, state: true, queryable: true }), column('dueDate', 'text', { queryable: true })], bodyFields: ['title', 'executionId', 'createdAt', 'completedAt'], requiredFields: ['requestId', 'employeeId', 'ownerIdentityId', 'templateId', 'status'], stateField: 'status', permittedTransitions: { open: ['in_progress', 'completed', 'cancelled'], in_progress: ['completed', 'cancelled'], completed: [], cancelled: [] }, immutableFields: ['id', 'requestId', 'employeeId', 'ownerIdentityId', 'templateId'], unique: [unique('onboarding_tasks_request_template_unique', 'requestId', 'templateId')], foreignKeys: [fk('request_id', 'onboarding_requests'), fk('employee_id', 'employees'), fk('owner_identity_id', 'directory_identities')], queryFields: ['requestId', 'employeeId', 'ownerIdentityId', 'templateId', 'status', 'dueDate'] },
  { table: 'offboarding_cases', storage: 'new', columns: [column('employeeId', 'text', { nullable: false, immutable: true, queryable: true }), column('ownerIdentityId', 'text', { nullable: false, queryable: true }), column('status', 'text', { nullable: false, state: true, queryable: true }), column('lifecycleId', 'text', { nullable: false, immutable: true }), column('lastDay', 'text', { queryable: true })], bodyFields: ['reason', 'createdAt', 'updatedAt'], requiredFields: ['employeeId', 'ownerIdentityId', 'status', 'lifecycleId'], stateField: 'status', permittedTransitions: { active: ['closed'], closed: [] }, immutableFields: ['id', 'employeeId', 'lifecycleId', 'createdAt'], unique: [openUnique('offboarding_cases_open_employee_unique', 'employeeId')], foreignKeys: [fk('employee_id', 'employees'), fk('owner_identity_id', 'directory_identities')], queryFields: ['employeeId', 'ownerIdentityId', 'status', 'lastDay'] },
  { table: 'offboarding_plans', storage: 'new', columns: [column('caseId', 'text', { nullable: false, immutable: true, queryable: true }), column('purpose', 'text', { nullable: false, immutable: true, queryable: true }), column('status', 'text', { nullable: false, state: true, immutable: true, queryable: true }), column('executionId', 'text', { queryable: true })], bodyFields: ['createdAt', 'completedAt'], requiredFields: ['caseId', 'purpose', 'status'], stateField: 'status', permittedTransitions: { prepared: [] }, immutableFields: ['id', 'caseId', 'purpose', 'createdAt', 'status'], unique: [unique('offboarding_plans_case_purpose_unique', 'caseId', 'purpose')], foreignKeys: [fk('case_id', 'offboarding_cases'), executionFk('execution_id', true)], queryFields: ['caseId', 'purpose', 'status', 'executionId'] },
  { table: 'planned_actions', storage: 'new', columns: [column('planId', 'text', { nullable: false, queryable: true }), column('purpose', 'text', { nullable: false, immutable: true, queryable: true }), column('status', 'text', { nullable: false, state: true, queryable: true }), column('executionId', 'text', { queryable: true }), column('dueDate', 'text', { queryable: true })], bodyFields: ['description', 'createdAt', 'completedAt'], requiredFields: ['planId', 'purpose', 'status'], stateField: 'status', permittedTransitions: { planned: ['requested', 'cancelled'], requested: ['completed', 'cancelled'], completed: [], cancelled: [] }, immutableFields: ['id', 'planId', 'purpose', 'description', 'createdAt'], unique: [unique('planned_actions_plan_purpose_unique', 'planId', 'purpose')], foreignKeys: [fk('plan_id', 'offboarding_plans'), executionFk('execution_id', true)], queryFields: ['planId', 'purpose', 'status', 'executionId', 'dueDate'] },
  { table: 'it_disable_requests', storage: 'new', columns: [column('caseId', 'text', { nullable: false, queryable: true }), column('planId', 'text', { nullable: false, queryable: true }), column('employeeId', 'text', { nullable: false, queryable: true }), column('status', 'text', { nullable: false, state: true, queryable: true }), column('executionId', 'text', { queryable: true })], bodyFields: ['requestedAt', 'completedAt'], requiredFields: ['caseId', 'planId', 'employeeId', 'status'], stateField: 'status', permittedTransitions: { requested: ['completed', 'failed'], completed: [], failed: [] }, immutableFields: ['id', 'caseId', 'planId', 'employeeId', 'requestedAt'], unique: [unique('it_disable_requests_case_plan_unique', 'caseId', 'planId')], foreignKeys: [fk('case_id', 'offboarding_cases'), fk('plan_id', 'offboarding_plans'), fk('employee_id', 'employees'), executionFk('execution_id', true)], queryFields: ['caseId', 'planId', 'employeeId', 'status'] },
  { table: 'assets', storage: 'new', columns: [column('assetTag', 'text', { nullable: false, immutable: true, queryable: true }), column('status', 'text', { nullable: false, state: true, queryable: true }), column('serialNumber', 'text', { queryable: true })], bodyFields: ['kind', 'model', 'createdAt'], requiredFields: ['assetTag', 'status'], stateField: 'status', permittedTransitions: { available: ['assigned', 'retired'], assigned: ['available', 'retired'], retired: [] }, immutableFields: ['id', 'assetTag', 'serialNumber', 'createdAt'], unique: [unique('assets_tag_unique', 'assetTag')], foreignKeys: [], queryFields: ['assetTag', 'status', 'serialNumber'] },
  { table: 'asset_assignments', storage: 'new', columns: [column('assetId', 'text', { nullable: false, queryable: true }), column('employeeId', 'text', { nullable: false, queryable: true }), column('status', 'text', { nullable: false, state: true, queryable: true }), column('assignedAt', 'text', { nullable: false, queryable: true })], bodyFields: ['returnedAt', 'executionId', 'createdAt'], requiredFields: ['assetId', 'employeeId', 'status', 'assignedAt'], stateField: 'status', permittedTransitions: { assigned: ['returned', 'lost'], returned: [], lost: [] }, immutableFields: ['id', 'assetId', 'employeeId', 'assignedAt'], unique: [openUnique('asset_assignments_open_asset_unique', 'assetId')], foreignKeys: [fk('asset_id', 'assets'), fk('employee_id', 'employees')], queryFields: ['assetId', 'employeeId', 'status', 'assignedAt'] },
  { table: 'asset_return_tasks', storage: 'new', columns: [column('assignmentId', 'text', { nullable: false, queryable: true }), column('caseId', 'text', { queryable: true }), column('planId', 'text', { queryable: true }), column('ownerIdentityId', 'text', { queryable: true }), column('status', 'text', { nullable: false, state: true, queryable: true }), column('dueDate', 'text', { queryable: true })], bodyFields: ['reason', 'executionId', 'createdAt', 'completedAt'], requiredFields: ['assignmentId', 'status'], stateField: 'status', permittedTransitions: { open: ['completed', 'cancelled'], completed: [], cancelled: [] }, immutableFields: ['id', 'assignmentId', 'caseId', 'planId', 'createdAt'], unique: [openUnique('asset_return_tasks_open_assignment_unique', 'assignmentId')], foreignKeys: [fk('assignment_id', 'asset_assignments'), fk('case_id', 'offboarding_cases', true), fk('plan_id', 'offboarding_plans', true), fk('owner_identity_id', 'directory_identities', true), executionFk('execution_id', true)], queryFields: ['assignmentId', 'caseId', 'planId', 'ownerIdentityId', 'status', 'dueDate'] },
  { table: 'employment_contracts', storage: 'new', columns: [column('employeeId', 'text', { nullable: false, immutable: true, queryable: true }), column('status', 'text', { nullable: false, state: true, queryable: true }), column('startDate', 'text', { nullable: false, queryable: true }), column('endDate', 'text', { queryable: true })], bodyFields: ['contractType', 'policyVersion', 'createdAt'], requiredFields: ['employeeId', 'status', 'startDate'], stateField: 'status', permittedTransitions: { draft: ['active', 'cancelled'], active: ['expired', 'terminated'], expired: [], terminated: [], cancelled: [] }, immutableFields: ['id', 'employeeId', 'contractType', 'startDate', 'createdAt'], unique: [openUnique('employment_contracts_open_employee_unique', 'employeeId')], foreignKeys: [fk('employee_id', 'employees')], queryFields: ['employeeId', 'status', 'startDate', 'endDate'] },
  { table: 'contract_reminders', storage: 'new', columns: [column('contractId', 'text', { nullable: false, queryable: true }), column('milestone', 'text', { nullable: false, immutable: true, queryable: true }), column('expiresAt', 'text', { nullable: false, queryable: true }), column('status', 'text', { nullable: false, state: true, queryable: true })], bodyFields: ['executionId', 'createdAt', 'sentAt'], requiredFields: ['contractId', 'milestone', 'expiresAt', 'status'], stateField: 'status', permittedTransitions: { pending: ['sent', 'cancelled'], sent: [], cancelled: [] }, immutableFields: ['id', 'contractId', 'milestone', 'expiresAt', 'createdAt'], unique: [unique('contract_reminders_contract_milestone_unique', 'contractId', 'expiresAt', 'milestone')], foreignKeys: [fk('contract_id', 'employment_contracts'), executionFk('execution_id', true)], queryFields: ['contractId', 'milestone', 'expiresAt', 'status'] },
  { table: 'policy_acknowledgement_tasks', storage: 'new', columns: [column('employeeId', 'text', { nullable: false, queryable: true }), column('policyDocumentId', 'text', { nullable: false, immutable: true, queryable: true }), column('policyVersion', 'text', { nullable: false, immutable: true, queryable: true }), column('status', 'text', { nullable: false, state: true, queryable: true }), column('dueDate', 'text', { queryable: true })], bodyFields: ['executionId', 'createdAt', 'acknowledgedAt'], requiredFields: ['employeeId', 'policyDocumentId', 'policyVersion', 'status'], stateField: 'status', permittedTransitions: { pending: ['acknowledged', 'cancelled'], acknowledged: [], cancelled: [] }, immutableFields: ['id', 'employeeId', 'policyDocumentId', 'policyVersion', 'createdAt'], unique: [unique('policy_ack_employee_version_unique', 'employeeId', 'policyDocumentId', 'policyVersion')], foreignKeys: [fk('employee_id', 'employees'), fk('policy_document_id', 'policy_documents'), executionFk('execution_id', true)], compositeForeignKeys: [{ columns: ['policy_document_id', 'policy_version'], target: 'policy_documents', targetColumns: ['id', 'version'], deferred: true }], queryFields: ['employeeId', 'policyDocumentId', 'policyVersion', 'status', 'dueDate'] },
  { table: 'badge_effect_events', storage: 'new', columns: [column('badgeId', 'text', { nullable: false, immutable: true, queryable: true }), column('employeeId', 'text', { nullable: false, immutable: true, queryable: true }), column('actorId', 'text', { nullable: false, immutable: true, queryable: true }), column('executionId', 'text', { nullable: false, immutable: true, queryable: true }), column('effect', 'text', { nullable: false, immutable: true, queryable: true }), column('createdAt', 'text', { nullable: false, immutable: true, queryable: true })], bodyFields: ['reason'], requiredFields: ['badgeId', 'employeeId', 'actorId', 'executionId', 'effect', 'createdAt'], immutableFields: ['id', 'badgeId', 'employeeId', 'actorId', 'executionId', 'effect', 'createdAt'], permittedTransitions: {}, unique: [unique('badge_effect_events_execution_unique', 'executionId')], foreignKeys: [fk('badge_id', 'mock_badges'), fk('employee_id', 'employees'), fk('actor_id', 'profiles'), executionFk('execution_id')], queryFields: ['badgeId', 'employeeId', 'actorId', 'executionId', 'effect', 'createdAt'] },
];

// This is the current additive contract. Historical migration descriptors live
// separately and do not depend on these future-facing changes.
const completenessFields: Partial<Record<WorkflowStorageTable, {
  columns: WorkflowProjectionColumn[];
  foreignKeys?: WorkflowForeignKey[];
  requiredWriteFields?: string[];
}>> = {
  incidents: {
    columns: [column('escalationStage', 'text', { queryable: true }), column('escalationLifecycleId', 'text', { queryable: true }), column('escalationEventId', 'text', { queryable: true })],
    foreignKeys: [fk('escalation_event_id', 'incident_escalation_events', true, true)],
  },
  onboarding_checklists: { columns: [column('executionId', 'text', { immutable: true, queryable: true })], foreignKeys: [executionFk('execution_id', true)], requiredWriteFields: ['executionId'] },
  branch_review_assignments: { columns: [column('dueDate', 'text', { queryable: true }), column('priority', 'text', { queryable: true }), column('executionId', 'text', { immutable: true, queryable: true })], foreignKeys: [executionFk('execution_id', true)], requiredWriteFields: ['dueDate', 'priority', 'reason', 'executionId'] },
  incident_escalation_events: { columns: [column('reason'), column('evidenceIds', 'json')], requiredWriteFields: ['reason', 'evidenceIds'] },
  onboarding_tasks: { columns: [column('reason'), column('priority', 'text', { queryable: true }), column('executionId', 'text', { immutable: true, queryable: true })], foreignKeys: [executionFk('execution_id', true)], requiredWriteFields: ['reason', 'priority', 'dueDate', 'executionId'] },
  it_disable_requests: { columns: [column('effectiveDate', 'text', { queryable: true }), column('reason')], requiredWriteFields: ['effectiveDate', 'reason'] },
  asset_return_tasks: { columns: [column('priority', 'text', { queryable: true })], requiredWriteFields: ['priority', 'reason', 'dueDate', 'ownerIdentityId', 'executionId'] },
  contract_reminders: { columns: [column('ownerIdentityId', 'text', { queryable: true }), column('dueDate', 'text', { queryable: true }), column('priority', 'text', { queryable: true }), column('reason')], foreignKeys: [fk('owner_identity_id', 'directory_identities', true)], requiredWriteFields: ['ownerIdentityId', 'dueDate', 'priority', 'reason', 'executionId'] },
  policy_acknowledgement_tasks: { columns: [column('ownerIdentityId', 'text', { queryable: true }), column('priority', 'text', { queryable: true }), column('reason')], foreignKeys: [fk('owner_identity_id', 'directory_identities', true)], requiredWriteFields: ['ownerIdentityId', 'dueDate', 'priority', 'reason', 'executionId'] },
  crm_activities: { columns: [column('executionId', 'text', { immutable: true, queryable: true })], foreignKeys: [executionFk('execution_id', true)] },
  offboarding_plans: { columns: [column('employeeSnapshot', 'json', { immutable: true }), column('assetAssignmentIds', 'json', { immutable: true })], requiredWriteFields: ['employeeSnapshot', 'assetAssignmentIds'] },
};

const v2CreationStates: Partial<Record<WorkflowStorageTable, string>> = {
  pending_actions: 'pending',
  action_idempotency_roots: 'open',
  action_executions: 'pending',
  action_targets: 'pending',
  dashboard_shares: 'active',
  mock_tickets: 'open',
  investigation_cases: 'open',
  investigation_tasks: 'open',
  branch_review_assignments: 'open',
  restock_requests: 'open',
  crm_followups: 'open',
  discount_requests: 'manager_review_pending',
  onboarding_checklists: 'open',
  onboarding_tasks: 'open',
  planned_actions: 'planned',
  it_disable_requests: 'requested',
  asset_return_tasks: 'open',
  contract_reminders: 'pending',
  policy_acknowledgement_tasks: 'pending',
};

for (const seed of seeds) {
  const initialState = v2CreationStates[seed.table];
  if (initialState !== undefined) seed.insertStates = [initialState];
  const addition = completenessFields[seed.table];
  if (addition) {
    seed.columns = [...seed.columns, ...addition.columns.filter(c => !seed.columns.some(existing => existing.column === c.column))];
    seed.bodyFields = [...new Set([...seed.bodyFields, ...addition.columns.map(c => c.bodyField)])];
    seed.foreignKeys = [...seed.foreignKeys, ...(addition.foreignKeys ?? []).filter(f => !seed.foreignKeys.some(existing => existing.column === f.column))];
    seed.immutableFields = [...new Set([...seed.immutableFields, ...addition.columns.filter(c => c.immutable).map(c => c.bodyField)])];
    seed.requiredWriteFields = addition.requiredWriteFields;
    seed.queryFields = [...new Set([...seed.queryFields, ...addition.columns.filter(c => c.queryable).map(c => c.bodyField)])];
    if (addition.columns.some(c => c.bodyField === 'ownerIdentityId')) seed.ownerField = 'ownerIdentityId';
  }
  const fields = new Set([...seed.bodyFields, ...seed.columns.map(c => c.bodyField)]);
  seed.bodyGuards = [
    ...[...fields].filter(field => ['date', 'businessDate', 'dueDate', 'startDate', 'endDate', 'lastDay', 'expectedCloseDate', 'effectiveDate'].includes(field)).map(field => ({ field, kind: 'business_date' as const })),
    ...(fields.has('priority') ? [{ field: 'priority', kind: 'priority' as const }] : []),
    ...(fields.has('reason') ? [{ field: 'reason', kind: 'reason' as const }] : []),
    ...(fields.has('evidenceIds') ? [{ field: 'evidenceIds', kind: 'id_array' as const, minimum: 1, maximum: MAX_WORKFLOW_TARGETS }] : []),
  ];
  if (seed.table === 'discount_requests') seed.bodyGuards = [...seed.bodyGuards, { field: 'baseAmountSatang', kind: 'nonnegative_integer' }];
  if (seed.table === 'incidents') seed.bodyGuards = [...seed.bodyGuards, { field: 'escalationStage', kind: 'escalation_stage' }, { field: 'escalationLifecycleId', kind: 'identifier' }, { field: 'escalationEventId', kind: 'identifier' }];
  if (seed.table === 'onboarding_documents') {
    seed.insertStates = ['accepted'];
    seed.permittedTransitions = { accepted: [], withdrawn: [], replaced: [] };
    seed.legacyReadOnlyStates = ['missing', 'received', 'waived', 'withdrawn', 'replaced'];
    seed.bodyGuards = [...seed.bodyGuards, { field: 'status', kind: 'document_status' }];
  }
  if (seed.table === 'offboarding_plans') {
    seed.bodyGuards = [...seed.bodyGuards, { field: 'employeeSnapshot', kind: 'employee_snapshot' }, { field: 'assetAssignmentIds', kind: 'id_array', maximum: MAX_WORKFLOW_TARGETS }];
    seed.normalizedChildren = [{
      table: 'workflow_offboarding_plan_assignments', parentIdColumn: 'plan_id', parentBodyField: 'id',
      arrayBodyField: 'assetAssignmentIds', childIdColumn: 'assignment_id', target: 'asset_assignments',
      uniqueName: 'workflow_offboarding_plan_assignments_unique', maximumItems: MAX_WORKFLOW_TARGETS, immutable: true,
      ownership: { parentTable: 'offboarding_cases', parentReferenceField: 'caseId', ownerField: 'employeeId', targetOwnerField: 'employeeId' },
    }];
  }
  if (seed.table === 'mock_tickets') {
    seed.legacyQuarantineColumn = 'legacy_assignee_quarantined';
    seed.markerlessV2Discriminators = ['ownerIdentityId', 'caseId', 'executionId', 'dueDate', 'priority'].map(path => ({ path, presence: true }));
    // Retain old profile-typed projection bytes; all new assignees are employees.
    seed.columns = seed.columns.map(c => c.column === 'assignee_id' ? { ...c, bodyField: 'legacyAssigneeId', legacyOnly: true, queryable: false } : c);
    seed.columns = [...seed.columns, columnAt('employee_assignee_id', 'assigneeId', 'text', { queryable: true })];
    seed.foreignKeys = seed.foreignKeys.map(f => f.column === 'assignee_id' ? { ...f, bodyField: 'legacyAssigneeId' } : f);
    seed.foreignKeys = [...seed.foreignKeys, fk('employee_assignee_id', 'employees', true, false, 'assigneeId')];
    seed.strictSchema = z.union([legacyTicketSchema, z.object({
      id: idSchema, rowVersion: rowVersionSchema.optional(), branchId: idSchema, assigneeId: idSchema,
      title: z.string(), reason: guardSchema({ field: 'reason', kind: 'reason' }), unansweredQuestion: z.string(),
      sourceIds: z.array(idSchema), status: z.enum(['open', 'completed', 'cancelled']), operationKey: z.string(),
      createdAt: instantSchema, ownerIdentityId: idSchema, caseId: idSchema, executionId: idSchema,
      dueDate: isoDateSchema, priority: z.enum(['normal', 'high']),
    }).strict()]);
  }
}

export const workflowProjectionManifest: ReadonlyMap<WorkflowStorageTable, WorkflowProjectionDefinition> = new Map(
  seeds.map((seed) => [seed.table, {
    table: seed.table,
    storage: seed.storage,
    bodyColumn: seed.storage === 'new' ? 'body' : 'payload',
    ...(seed.storage === 'mixed' ? { markerColumn: 'workflow_contract_version' as const } : {}),
    markerlessV2Discriminators: seed.markerlessV2Discriminators ?? [],
    projectionEqualities: seed.projectionEqualities ?? [],
    columns: seed.columns,
    stateField: seed.stateField,
    permittedTransitions: seed.permittedTransitions,
    terminalImmutableFields: seed.terminalImmutableFields ?? {},
    immutableFields: seed.immutableFields,
    unique: seed.unique.map((constraint) => constraint.openOnly
      ? { ...constraint, openStates: (constraint.openStates ?? []).filter((state) => (seed.permittedTransitions[state]?.length ?? 0) > 0) }
      : constraint),
    foreignKeys: seed.foreignKeys,
    compositeForeignKeys: seed.compositeForeignKeys ?? [],
    normalizedChildren: seed.normalizedChildren ?? [],
    queryFields: seed.queryFields,
    ownerField: seed.ownerField ?? ({
      sessions: 'profileId',
      conversations: 'actorId',
      conversation_messages: 'actorId',
      mock_tickets: 'ownerIdentityId',
      pending_actions: 'actorId',
      action_executions: 'actorId',
      dashboard_shares: 'senderIdentityId',
      audit_events: 'actorId',
      review_snapshots: 'actorId',
      action_confirmations: 'actorId',
      action_idempotency_roots: 'actorId',
      responsibilities: 'identityId',
      reporting_relationships: 'managerIdentityId',
      investigation_cases: 'ownerIdentityId',
      investigation_tasks: 'ownerIdentityId',
      branch_review_assignments: 'ownerIdentityId',
      restock_requests: 'ownerIdentityId',
      crm_customers: 'ownerIdentityId',
      crm_opportunities: 'ownerIdentityId',
      crm_activities: 'ownerIdentityId',
      crm_followups: 'ownerIdentityId',
      discount_requests: 'ownerIdentityId',
      onboarding_tasks: 'ownerIdentityId',
      offboarding_cases: 'ownerIdentityId',
      asset_return_tasks: 'ownerIdentityId',
    } as Partial<Record<WorkflowStorageTable, string>>)[seed.table],
    orgUnitField: seed.orgUnitField,
    branchField: seed.branchField,
    dateField: seed.dateField ?? ({
      sales_orders: 'date',
      sales_targets: 'date',
      inventory_snapshots: 'date',
      incidents: 'date',
      staffing_summaries: 'date',
      mock_tickets: 'dueDate',
      conversations: 'updatedAt',
      conversation_messages: 'createdAt',
      dashboard_shares: 'createdAt',
      audit_events: 'createdAt',
      review_snapshots: 'createdAt',
      investigation_cases: 'dueDate',
      investigation_tasks: 'dueDate',
      restock_requests: 'dueDate',
      crm_opportunities: 'expectedCloseDate',
      crm_activities: 'occurredAt',
      crm_followups: 'dueDate',
      discount_requests: 'expiresAt',
      onboarding_requests: 'startDate',
      onboarding_tasks: 'dueDate',
      offboarding_cases: 'lastDay',
      planned_actions: 'dueDate',
      asset_assignments: 'assignedAt',
      asset_return_tasks: 'dueDate',
      employment_contracts: 'endDate',
      contract_reminders: 'expiresAt',
      policy_acknowledgement_tasks: 'dueDate',
    } as Partial<Record<WorkflowStorageTable, string>>)[seed.table],
    bodyGuards: seed.bodyGuards,
    requiredWriteFields: seed.requiredWriteFields,
    insertStates: seed.insertStates,
    legacyReadOnlyStates: seed.legacyReadOnlyStates,
    legacyQuarantineColumn: seed.legacyQuarantineColumn,
    bodySchema: seed.strictSchema ?? strictBodySchema(seed),
  }]),
);

export const workflowProjectionTables = Object.freeze(Array.from(workflowProjectionManifest.keys()));
export const workflowProjectionColumnNames = Object.freeze(Array.from(new Set(
  Array.from(workflowProjectionManifest.values()).flatMap((definition) => definition.columns.map((entry) => entry.column)),
)));

export function getWorkflowProjection(table: WorkflowStorageTable): WorkflowProjectionDefinition {
  const definition = workflowProjectionManifest.get(table);
  if (!definition) throw new Error('Workflow storage received an unsupported table');
  return definition;
}

export function isMarkerlessV2WorkflowBody(table: WorkflowStorageTable, body: unknown): boolean {
  const definition = workflowProjectionManifest.get(table);
  if (!definition || definition.storage !== 'mixed' || typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  return definition.markerlessV2Discriminators.some(({ path, equals, presence }) => {
    if (presence) return bodyPathExists(body, path);
    const value = bodyPath(body, path);
    return equals === undefined ? value !== undefined && value !== null : value === equals;
  });
}

export type WorkflowStorageQuery =
  | { kind: 'ids'; table: WorkflowStorageTable; ids: readonly string[] }
  | { kind: 'unique'; table: WorkflowStorageTable; constraint: string; values: Readonly<Record<string, string | number>> }
  | {
      kind: 'scoped';
      table: WorkflowStorageTable;
      equals?: Readonly<Record<string, string | number | boolean | null>>;
      ownerId?: string;
      orgUnitId?: string;
      branchIds?: readonly string[];
      status?: string;
      fromDate?: string;
      throughDate?: string;
      cursor?: string;
      limit?: number;
    };

export interface WorkflowProjectionReader {
  get<T>(table: WorkflowStorageTable, id: string): Promise<ProjectedRow<T> | undefined>;
  query<T>(query: WorkflowStorageQuery): Promise<ProjectedRow<T>[]>;
}

export interface WorkflowTransactionContext extends GuardedTransaction {
  readonly workflowProjectionReader: WorkflowProjectionReader;
}

export interface WorkflowStoreCapability {
  readonly workflowContractVersion: 2;
  readonly workflowProjectionReader: WorkflowProjectionReader;
  workflowTransaction<T>(work: (tx: WorkflowTransactionContext) => Promise<T>): Promise<T>;
}

export function validateWorkflowProjectionBody<T>(
  table: WorkflowStorageTable,
  id: string,
  rowVersion: number,
  body: unknown,
): ProjectedRow<T> {
  const definition = getWorkflowProjection(table);
  const parsed = definition.bodySchema.safeParse(body);
  if (!parsed.success || typeof parsed.data !== 'object' || parsed.data === null) {
    throw new Error('Workflow projection contains an invalid body');
  }
  const value = parsed.data as Record<string, unknown>;
  if (value.id !== id || !Number.isSafeInteger(rowVersion) || rowVersion < 1 || (value.rowVersion !== undefined && value.rowVersion !== rowVersion)) {
    throw new Error('Workflow projection row identity or version is inconsistent');
  }
  for (const equality of definition.projectionEqualities) {
    if (bodyPath(value, equality.leftPath) !== bodyPath(value, equality.rightPath)) {
      throw new Error('Workflow projection contains inconsistent typed metadata');
    }
  }
  for (const projected of definition.columns) {
    if (projected.external || projected.legacyOnly) continue;
    const fieldValue = bodyPath(value, projected.bodyField);
    if (fieldValue === undefined || fieldValue === null) {
      if (!projected.nullable) throw new Error('Workflow projection is missing a required typed value');
      continue;
    }
    const check = scalarSchemas[projected.type].safeParse(fieldValue);
    if (!check.success) throw new Error('Workflow projection contains an invalid typed value');
  }
  for (const guard of definition.bodyGuards ?? []) {
    const fieldValue = bodyPath(value, guard.field);
    if (fieldValue !== undefined && fieldValue !== null && !guardSchema(guard).safeParse(fieldValue).success) {
      throw new Error('Workflow projection contains invalid reviewed metadata');
    }
  }
  if (table === 'incidents') {
    const stage = value.escalationStage;
    if (stage !== undefined && stage !== null) {
      if (!workflowReferenceIdSchema.safeParse(value.escalationLifecycleId).success
        || (stage === 'un_escalated' && value.escalationEventId !== undefined && value.escalationEventId !== null)
        || (stage === 'team_requested' && !workflowReferenceIdSchema.safeParse(value.escalationEventId).success)) {
        throw new Error('Workflow projection contains incoherent escalation proof');
      }
    } else if (value.escalationEventId !== undefined && value.escalationEventId !== null) {
      throw new Error('Workflow projection contains an unclassified escalation event');
    }
  }
  let concreteReferences = 0;
  for (const relation of definition.foreignKeys) {
    if (relation.external) continue;
    const relationValue = relation.bodyField
      ? bodyPath(value, relation.bodyField)
      : bodyPath(value, relation.column.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase()));
    if (relation.tagField && bodyPath(value, relation.tagField) === relation.tagValue) concreteReferences += 1;
    if (relation.tagField && relationValue !== undefined && relationValue !== null && typeof relationValue !== 'string') {
      throw new Error('Workflow projection contains an invalid concrete reference');
    }
    if (!relation.nullable && (typeof relationValue !== 'string' || relationValue.length === 0)) {
      throw new Error('Workflow projection is missing a required reference');
    }
  }
  if (definition.foreignKeys.some((relation) => relation.tagField) && concreteReferences !== 1) {
    throw new Error('Workflow projection must contain exactly one concrete target reference');
  }
  return { id, rowVersion, body: value as T };
}

/** Reads may retain legacy unknown data; no guarded write can promote it into proof. */
export function validateWorkflowProjectionWriteBody<T>(
  table: WorkflowStorageTable, id: string, rowVersion: number, body: unknown,
): ProjectedRow<T> {
  const projected = validateWorkflowProjectionBody<Record<string, unknown>>(table, id, rowVersion, body);
  const definition = getWorkflowProjection(table);
  if ((definition.requiredWriteFields ?? []).some(field => bodyPath(projected.body, field) === undefined || bodyPath(projected.body, field) === null)
    || (rowVersion === 1 && definition.insertStates !== undefined
      && (definition.storage !== 'mixed' || isMarkerlessV2WorkflowBody(table, projected.body))
      && !definition.insertStates.includes(String(bodyPath(projected.body, definition.stateField ?? 'status'))))
    || (definition.legacyReadOnlyStates ?? []).includes(String(bodyPath(projected.body, definition.stateField ?? 'status')))) {
    throw new Error('Workflow projection legacy data is not writable proof');
  }
  return projected as ProjectedRow<T>;
}

/** Validates the guarded CAS envelope while keeping version outside strict bodies that omit it. */
export function validateWorkflowCasBody<T extends { id: string; rowVersion: number }>(
  table: WorkflowStorageTable,
  id: string,
  expectedRowVersion: number,
  next: T,
): ProjectedRow<CasBody<T>> {
  if (
    typeof next !== 'object'
    || next === null
    || Array.isArray(next)
    || typeof next.id !== 'string'
    || next.id !== id
    || !Number.isSafeInteger(expectedRowVersion)
    || expectedRowVersion < 1
    || !Number.isSafeInteger(next.rowVersion)
    || next.rowVersion !== expectedRowVersion + 1
  ) {
    throw new Error('Workflow compare-and-swap version is invalid');
  }
  const definition = getWorkflowProjection(table);
  const body = schemaFields(definition.bodySchema).includes('rowVersion')
    ? next
    : Object.fromEntries(Object.entries(next).filter(([field]) => field !== 'rowVersion'));
  return validateWorkflowProjectionWriteBody<CasBody<T>>(table, id, next.rowVersion, body);
}

export function assertWorkflowUniqueKey(
  table: WorkflowStorageTable,
  constraint: string,
  values: Readonly<Record<string, string | number>>,
): WorkflowUniqueConstraint {
  const definition = getWorkflowProjection(table);
  if (typeof values !== 'object' || values === null || Array.isArray(values)) {
    throw new Error('Workflow storage received an unsupported unique constraint');
  }
  const keys = Object.keys(values);
  const primary = constraint === `${table}_primary_key` && keys.length === 1 && keys[0] === 'id';
  const match = primary ? { name: constraint, fields: ['id'] } : definition.unique.find((candidate) => candidate.name === constraint);
  if (!match || keys.length !== match.fields.length || match.fields.some((field) => !Object.prototype.hasOwnProperty.call(values, field))) {
    throw new Error('Workflow storage received an unsupported unique constraint');
  }

  for (const field of match.fields) {
    const value = values[field];
    const projection = definition.columns.find((column) => column.bodyField === field);
    if (projection && !scalarSchemas[projection.type].safeParse(value).success) {
      throw new Error('Workflow storage received invalid unique key values');
    }
    if (projection?.type === 'integer' && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)) {
      throw new Error('Workflow storage received invalid unique key values');
    }

    const bodySchemas = schemasAtBodyPath(definition.bodySchema, field.split('.'));
    const fieldSchemas = bodySchemas.length > 0
      ? bodySchemas
      : [field === 'id' ? idSchema : bodyFieldSchema(field.split('.').at(-1) ?? field)];
    if (!fieldSchemas.some((schema) => schema.safeParse(value).success)) {
      throw new Error('Workflow storage received invalid unique key values');
    }
  }

  return match;
}

export function workflowQueryFields(query: WorkflowStorageQuery): string[] {
  const definition = getWorkflowProjection(query.table);
  if (query.kind === 'ids') return ['id'];
  if (query.kind === 'unique') {
    const constraint = assertWorkflowUniqueKey(query.table, query.constraint, query.values);
    return [...constraint.fields];
  }
  if (query.equals !== undefined && (typeof query.equals !== 'object' || query.equals === null || Array.isArray(query.equals))) {
    throw new Error('Workflow storage equality query is invalid');
  }
  const requested = [
    query.ownerId === undefined ? null : definition.ownerField ?? 'ownerId',
    query.orgUnitId === undefined ? null : definition.orgUnitField ?? 'orgUnitId',
    query.branchIds === undefined ? null : definition.branchField ?? 'branchId',
    query.status === undefined ? null : definition.stateField ?? '__missing_state__',
    query.fromDate === undefined ? null : definition.dateField ?? 'date',
    query.throughDate === undefined ? null : definition.dateField ?? 'date',
  ].filter((field): field is string => field !== null);
  for (const [field, value] of Object.entries(query.equals ?? {})) {
    const projected = definition.columns.find(column => column.bodyField === field && !column.legacyOnly && !column.external);
    if (!definition.queryFields.includes(field) || !projected || projected.type === 'json'
      || (value === null ? !projected.nullable : !scalarSchemas[projected.type].safeParse(value).success)) {
      throw new Error('Workflow storage received an unsupported equality query');
    }
    requested.push(field);
  }
  if (requested.includes('__missing_state__')) throw new Error('Workflow storage received an unsupported status query');
  if (requested.some((field) => !definition.queryFields.includes(field))) {
    throw new Error('Workflow storage received an unsupported scoped query');
  }
  const limit = query.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Workflow storage query limit is invalid');
  if (query.cursor !== undefined && !idSchema.safeParse(query.cursor).success) throw new Error('Workflow storage query cursor is invalid');
  return [...new Set(requested)];
}

export function workflowRowFilterQuery(table: WorkflowStorageTable, filters?: RowFilter): WorkflowStorageQuery {
  if (!filters || Object.keys(filters).length === 0) return { kind: 'scoped', table, limit: 25 };
  const keys = Object.keys(filters);
  if (keys.length === 1 && keys[0] === 'id') {
    const ids = filters.id;
    return { kind: 'ids', table, ids: Array.isArray(ids) ? ids : [ids] };
  }
  throw new Error('Workflow storage uses named queries instead of arbitrary row filters');
}

export function isLegacyTable(table: string): table is Table {
  return (tables as readonly string[]).includes(table);
}

export function isWorkflowTable(table: string): table is WorkflowStorageTable {
  return (workflowEntityTables as readonly string[]).includes(table) || isLegacyTable(table);
}

