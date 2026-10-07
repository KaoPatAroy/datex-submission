import { z } from 'zod';
import type { Mode, PackPin, Store } from '../contracts';
import { DomainError, invariant } from '../core/errors';
import { digest, id } from '../core/utils';
import { assistantMessageId, guardedAssistantAnchorAdapter, linkAssistantMessage } from '../core/conversation-actions';
import { getWorkflowProjection, type ProjectedRow, type WorkflowProjectionReader, type WorkflowStoreCapability, type WorkflowTransactionContext } from '../storage/workflow-projections';
import type { RowFilter } from '../storage/filters';
import { authorizeWorkflowScope, reloadWorkflowPrincipal, type WorkflowPrincipal, type WorkflowScopeRequest, type WorkflowScopeTarget } from './authority';
import {
  directoryIdentitySchema, entityStateSchema, expectedRowSchema, instantSchema, isoDateSchema, MAX_WORKFLOW_TARGETS, pendingActionV2Schema,
  persistedConversationMessageSchema, preparationResultSchema, refSchema, responsibilitySchema, reviewSnapshotSchema, roleV2Schema, workflowActionKinds, workflowActionPayloadSchema, workflowReceiptV2Schema,
  workflowValidationSchema, type CommittedTarget, type CurrentState, type ExpectedRow, type GuardedTransaction, type Instant, type PendingActionV2, type PolicyPin,
  type PreparationResult, type Ref, type ReviewSnapshot, type WorkflowActionBinding,
  type WorkflowActionKind, type WorkflowActor, type WorkflowPackReadContext, type WorkflowPayloadV2,
  type TargetProof, type WorkflowReader, type WorkflowStorageTable, type WorkflowValidation,
} from './contracts';
import { demoWorkflowPolicyV1, getDemoWorkflowPolicyV1Pin, pendingActionExpiresAt } from './policy';
import { assertWorkflowBindingAuthority, getWorkflowActionAuthority } from './action-authority';
import { definitelyNotCommitted, failureResult, WorkflowOperationError, writeWorkflowAudit, type ExpectedPostcondition, type WorkflowOperationContext } from './action-results';

export interface SemanticTarget {
  targetId: string; ref: Ref; semanticKey: string; scope: WorkflowScopeTarget;
}
export interface SemanticIntent { targets: readonly SemanticTarget[] }
export interface RuntimeReadContext extends WorkflowPackReadContext {
  principal: WorkflowPrincipal; projections: WorkflowProjectionReader;
}
/** Optional only for direct low-level preparation; every trusted turn broker supplies this pin. */
export interface WorkflowPreparationModePin {
  readonly expectedMode: Mode;
  readonly expectedModeRevision: number;
}
type PreparationReview = Omit<PendingActionV2, 'id' | 'payloadHash' | 'createdAt' | 'expiresAt' | 'status'>;
export interface WorkflowRuntimeBinding<K extends WorkflowActionKind = WorkflowActionKind>
  extends Omit<WorkflowActionBinding<K>, 'validate' | 'executeAtomic' | 'verify' | 'currentStates'> {
  authority: Pick<WorkflowScopeRequest, 'permission' | 'roles' | 'purpose'>;
  /** Caller-supplied nonsecret revision of snapshotted callback configuration; required when callbacks capture configuration. */
  readonly configurationRevision?: string;
  identify(this: void, context: RuntimeReadContext, payload: Extract<WorkflowPayloadV2, { kind: K }>): Promise<SemanticIntent>;
  validate(this: void, context: RuntimeReadContext, payload: Extract<WorkflowPayloadV2, { kind: K }>): Promise<WorkflowValidation>;
  executeAtomic(this: void, context: RuntimeReadContext & { tx: GuardedTransaction; action: PendingActionV2; executionId: string },
    payload: Extract<WorkflowPayloadV2, { kind: K }>): Promise<CommittedTarget[]>;
  verify(this: void, context: RuntimeReadContext & { action: PendingActionV2; executionId: string },
    committed: CommittedTarget[]): Promise<TargetProof[]>;
  currentStates(this: void, context: RuntimeReadContext, refs: Ref[]): Promise<CurrentState[]>;
  /** Pure approved-field plan: include every persisted reviewed field and deterministic attribution, never observed output. */
  expectedPostconditions(this: void, action: PendingActionV2, executionId: string, confirmedAt: Instant): readonly ExpectedPostcondition[];
}
export interface WorkflowRuntimeOptions {
  store: Store & WorkflowStoreCapability;
  bindings: readonly WorkflowRuntimeBinding[];
  businessDate: string;
  getReleaseRevision: () => string;
  getPackPins: (packIds: string[]) => PackPin[];
  contextFactory: (reader: WorkflowReader, principal: WorkflowPrincipal,
    view: Readonly<{ projections: WorkflowProjectionReader; now: () => Date }>) => Pick<WorkflowPackReadContext, 'evidence' | 'latestDashboard'>;
  getReadPermissions?: (packIds: string[]) => string[];
  now?: () => Date;
  makeId?: (prefix: string) => string;
}
export interface SemanticEffectRow {
  id: string; rowVersion?: number; semanticKey: string; executionId: string;
  effectType: Ref['table']; effectId: string; status: 'committed'; createdAt: string;
}
export interface WorkflowRootRow {
  id: string; rowVersion?: number; actorId: string; idempotencyKey: string;
  status: 'open' | 'completed' | 'stale'; activeExecutionId: string | null; actionId?: string; createdAt: string;
}
export interface ActionTargetRow {
  id: string; rowVersion?: number; executionId: string; targetId: string; entityType: Ref['table'];
  ref: Ref; expectedRowVersion: number; expectedState: string | null;
  targetStatus: 'pending' | 'committed' | 'verified' | 'failed'; result?: unknown; proof?: unknown;
}

function preparationAuditId(actionId: string): string { return `workflow_prepare_${digest({ actionId })}`; }
function preparationRootStamp(root?: ProjectedRow<WorkflowRootRow>): string {
  return digest({ rootId: root?.id ?? null, rootVersion: root?.rowVersion ?? null });
}

const identifier = directoryIdentitySchema.shape.id;
const preparationModePinSchema = z.object({
  expectedMode: pendingActionV2Schema.shape.mode,
  expectedModeRevision: pendingActionV2Schema.shape.modeRevision,
}).strict();

function assertPreparationModePin(context: RuntimeReadContext, modePin?: WorkflowPreparationModePin): void {
  invariant(!modePin || (context.actor.mode === modePin.expectedMode && context.actor.modeRevision === modePin.expectedModeRevision),
    'WORKFLOW_STALE', 'The turn mode changed; start a fresh turn', 409);
}
const configurationRevisionSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const semanticIntentSchema = z.object({ targets: z.array(z.object({
  targetId: identifier, ref: refSchema, semanticKey: z.string().regex(/^[a-f0-9]{64}$/),
  scope: z.object({ orgUnitId: identifier.optional(), branchId: identifier.optional() }).strict()
    .refine(scope => scope.orgUnitId !== undefined || scope.branchId !== undefined),
}).strict()).min(1).max(MAX_WORKFLOW_TARGETS) }).strict();

export function freezeWorkflowValue<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeWorkflowValue(child);
    Object.freeze(value);
  }
  return value;
}

// Narrowing wrappers retain the server callback source they invoke, including repeated wrapping.
const workflowCallbackSources = new WeakMap<object, string>();
function workflowCallbackSource(callback: object): string {
  const source = workflowCallbackSources.get(callback) ?? Function.prototype.toString.call(callback);
  workflowCallbackSources.set(callback, source);
  return source;
}

/**
 * Generic narrowing is checked before invoking captured, receiver-independent department callbacks.
 * Callback source pins cannot inspect closure configuration; callers must snapshot it and supply a nonsecret configurationRevision.
 * Any configuration change requires an updated configurationRevision or build/pack implementation revision.
 */
export function defineWorkflowBinding<K extends WorkflowActionKind>(binding: WorkflowRuntimeBinding<K>): WorkflowRuntimeBinding {
  const { kind, configurationRevision, identify, expectedPostconditions, validate, executeAtomic, verify, currentStates } = binding;
  invariant(configurationRevision === undefined || configurationRevisionSchema.safeParse(configurationRevision).success,
    'WORKFLOW_INVALID_BINDING', 'The callback configuration revision is invalid');
  const sources = [identify, expectedPostconditions, validate, executeAtomic, verify, currentStates].map(workflowCallbackSource);
  const narrow = (payload: WorkflowPayloadV2): Extract<WorkflowPayloadV2, { kind: K }> => {
    invariant(payload.kind === kind, 'WORKFLOW_INVALID_INPUT', 'Binding kind did not match');
    return payload as Extract<WorkflowPayloadV2, { kind: K }>;
  };
  const wrapped: WorkflowRuntimeBinding = { kind, configurationRevision, contractVersion: binding.contractVersion, executionMode: binding.executionMode,
    packIds: [...binding.packIds], authority: { ...binding.authority, roles: [...binding.authority.roles] },
    identify: (context, payload) => identify(context, narrow(payload)),
    expectedPostconditions: (action, executionId, confirmedAt) => expectedPostconditions(action, executionId, confirmedAt),
    validate: (context, payload) => validate(context, narrow(payload)),
    executeAtomic: (context, payload) => executeAtomic(context, narrow(payload)),
    verify: (context, committed) => verify(context, committed),
    currentStates: (context, refs) => currentStates(context, refs) };
  workflowCallbackSources.set(wrapped.identify, sources[0]);
  workflowCallbackSources.set(wrapped.expectedPostconditions, sources[1]);
  workflowCallbackSources.set(wrapped.validate, sources[2]);
  workflowCallbackSources.set(wrapped.executeAtomic, sources[3]);
  workflowCallbackSources.set(wrapped.verify, sources[4]);
  workflowCallbackSources.set(wrapped.currentStates, sources[5]);
  return wrapped;
}

export function workflowApprovalHash(action: PendingActionV2): string {
  // Every remaining field belongs to the immutable reviewed envelope, including expiry.
  const { payloadHash: _hash, status: _status, ...approval } = action;
  void _hash; void _status;
  return digest({ purpose: 'nexus/workflow-approval/v2', approval });
}
export function workflowSemanticRoot(kind: WorkflowActionKind, targets: readonly Pick<SemanticTarget, 'semanticKey'>[]): string {
  return digest({ purpose: 'nexus/workflow-semantic-root/v2', kind, keys: targets.map(t => t.semanticKey).sort() });
}
export function workflowSnapshotDigest(snapshot: ReviewSnapshot): string {
  const { digest: _digest, ...body } = snapshot; void _digest;
  return digest({ domain: 'nexus/workflow-review/v2', ...body,
    orgUnitIds: [...body.orgUnitIds].sort(), displayedIds: [...body.displayedIds].sort(),
    expectedRows: [...body.expectedRows].sort((a, b) => digest(a.ref).localeCompare(digest(b.ref))) });
}
export function workflowRowState(table: WorkflowStorageTable, body: unknown): string | null {
  const field = getWorkflowProjection(table).stateField;
  if (!field) return null;
  const value = typeof body === 'object' && body !== null ? Reflect.get(body, field) : undefined;
  return field === 'active' ? value === true ? 'active' : value === false ? 'inactive' : null : typeof value === 'string' ? value : null;
}
export function mergeExpectedRows(...groups: readonly (readonly ExpectedRow[])[]): ExpectedRow[] {
  const rows = new Map<string, ExpectedRow>();
  for (const group of groups) for (const input of group) {
    const row = expectedRowSchema.parse(input), key = digest(row.ref), previous = rows.get(key);
    invariant(!previous || digest(previous) === digest(row), 'WORKFLOW_STALE', 'Expected row guards disagree', 409);
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => digest(a.ref).localeCompare(digest(b.ref)));
}

export class WorkflowActionRuntime {
  readonly store: Store & WorkflowStoreCapability;
  private readonly bindings = new Map<WorkflowActionKind, WorkflowRuntimeBinding>();
  private readonly options: WorkflowRuntimeOptions;
  constructor(options: WorkflowRuntimeOptions) {
    invariant(options.store.workflowContractVersion === 2 && typeof options.store.workflowTransaction === 'function',
      'WORKFLOW_UNAVAILABLE', 'Guarded workflow storage is unavailable', 503);
    invariant([options.getReleaseRevision, options.getPackPins, options.contextFactory].every(callback => typeof callback === 'function'),
      'WORKFLOW_INVALID_BINDING', 'Server runtime dependencies are incomplete');
    isoDateSchema.parse(options.businessDate);
    this.store = options.store;
    this.options = { ...options, bindings: [...options.bindings] };
    for (const binding of options.bindings) {
      invariant(workflowActionKinds.includes(binding.kind) && !this.bindings.has(binding.kind) && binding.contractVersion === 2 &&
        binding.executionMode === 'atomic_local' && binding.packIds.length > 0 && new Set(binding.packIds).size === binding.packIds.length &&
        [binding.identify, binding.expectedPostconditions, binding.validate, binding.executeAtomic, binding.verify, binding.currentStates].every(callback => typeof callback === 'function'),
      'WORKFLOW_INVALID_BINDING', 'A workflow registration is incomplete or repeated');
      identifier.parse(binding.authority.permission);
      z.array(roleV2Schema).min(1).parse(binding.authority.roles);
      responsibilitySchema.shape.purpose.parse(binding.authority.purpose);
      invariant(new Set(binding.authority.roles).size === binding.authority.roles.length, 'WORKFLOW_INVALID_BINDING', 'Action roles must be unique');
      assertWorkflowBindingAuthority(binding.kind, binding.authority);
      this.bindings.set(binding.kind, freezeWorkflowValue(defineWorkflowBinding(binding)));
    }
    for (const binding of this.bindings.values()) pendingActionV2Schema.shape.packs.parse(this.pins(binding.packIds));
  }
  availableKinds(): readonly WorkflowActionKind[] { return Object.freeze([...this.bindings.keys()]); }
  binding(kind: WorkflowActionKind): WorkflowRuntimeBinding {
    const binding = this.bindings.get(kind);
    invariant(binding, 'WORKFLOW_UNAVAILABLE', 'The action binding is unavailable', 503);
    return binding;
  }
  now(): Date {
    const date = new Date((this.options.now ?? (() => new Date()))().getTime());
    instantSchema.parse(date.toISOString()); return date;
  }
  makeId(prefix: string): string { return identifier.parse((this.options.makeId ?? id)(prefix)); }
  releaseRevision(): string { return this.options.getReleaseRevision(); }
  pins(packIds: string[]): PackPin[] {
    const pins = this.options.getPackPins([...packIds]);
    invariant(pins.length === packIds.length && new Set(pins.map(pin => pin.id)).size === pins.length && packIds.every(packId => pins.some(pin => pin.id === packId)),
      'WORKFLOW_INVALID_BINDING', 'Pack pins do not cover the action');
    return pins.map(pin => ({ ...structuredClone(pin), implementationRevision: `workflow-v2:${digest({ base: pin.implementationRevision,
      bindings: [...this.bindings.values()].filter(binding => binding.packIds.includes(pin.id)).sort((a, b) => a.kind.localeCompare(b.kind)).map(binding => ({
        kind: binding.kind, configurationRevision: binding.configurationRevision ?? null, authority: getWorkflowActionAuthority(binding.kind),
        callbacks: [binding.identify, binding.expectedPostconditions, binding.validate,
          binding.executeAtomic, binding.verify, binding.currentStates].map(workflowCallbackSource),
      })) })}` }));
  }
  async context(tx: WorkflowTransactionContext, sessionId: string): Promise<RuntimeReadContext> {
    const principal = await reloadWorkflowPrincipal(tx, sessionId, this.now().toISOString());
    const reader: WorkflowReader = Object.freeze({
      get: async <T>(table: WorkflowStorageTable, rowId: string) => freezeWorkflowValue(structuredClone(await tx.get<T>(table, rowId))),
      list: async <T>(table: WorkflowStorageTable, filters?: RowFilter) => freezeWorkflowValue(structuredClone(await tx.list<T>(table, filters))),
    });
    const projections: WorkflowProjectionReader = Object.freeze({
      get: async <T>(table: WorkflowStorageTable, rowId: string) => freezeWorkflowValue(structuredClone(await tx.workflowProjectionReader.get<T>(table, rowId))),
      query: async <T>(query: Parameters<WorkflowProjectionReader['query']>[0]) => freezeWorkflowValue(structuredClone(await tx.workflowProjectionReader.query<T>(structuredClone(query)))),
    });
    const actor: WorkflowActor = { ...principal.actor, permissions: [...principal.actor.permissions], regions: [...principal.actor.regions] };
    const view = Object.freeze({ projections, now: () => this.now() });
    const callbacks = this.options.contextFactory(reader, principal, view);
    invariant(typeof callbacks.evidence === 'function' && typeof callbacks.latestDashboard === 'function',
      'WORKFLOW_INVALID_BINDING', 'The server read context is incomplete');
    return freezeWorkflowValue({ reader, projections, principal, actor, businessDate: this.options.businessDate,
      now: view.now, evidence: callbacks.evidence, latestDashboard: callbacks.latestDashboard,
      assertPins: (pins: PackPin[]) => invariant(digest(this.pins(pins.map(pin => pin.id))) === digest(pins), 'WORKFLOW_STALE', 'Pack pins changed', 409) });
  }
  async assertPolicy(tx: WorkflowTransactionContext, expected: PolicyPin = getDemoWorkflowPolicyV1Pin()): Promise<void> {
    const pin = getDemoWorkflowPolicyV1Pin();
    const rows = await tx.workflowProjectionReader.query<{ id: string; version: number; digest: string; policy: unknown }>({
      kind: 'unique', table: 'workflow_policies', constraint: 'workflow_policies_policy_version_unique', values: { 'policy.id': pin.id, version: pin.version },
    });
    invariant(rows.length === 1 && digest(expected) === digest(pin) && rows[0].body.digest === pin.digest && digest(rows[0].body.policy) === pin.digest,
      'WORKFLOW_STALE', 'The current policy no longer matches the reviewed policy', 409);
  }
  async assertConversation(context: RuntimeReadContext, conversationId: string, allowArchived = false): Promise<void> {
    const row = await context.projections.get<{ id: string; actorId: string; archivedAt?: string | null }>('conversations', identifier.parse(conversationId));
    invariant(row && row.body.actorId === context.actor.id, 'WORKFLOW_NOT_FOUND', 'The conversation is unavailable', 404);
    invariant(allowArchived || !row.body.archivedAt, 'WORKFLOW_STALE', 'The conversation is archived', 409);
  }
  async identify(context: RuntimeReadContext, binding: WorkflowRuntimeBinding, payload: WorkflowPayloadV2): Promise<SemanticIntent> {
    const authority = getWorkflowActionAuthority(binding.kind);
    for (const permission of new Set([...authority.readPermissions, ...(this.options.getReadPermissions?.(binding.packIds) ?? [])])) invariant(context.actor.permissions.includes(permission),
      'WORKFLOW_PERMISSION_DENIED', 'A required read permission is absent', 403);
    // The primary permission/role check occurs before any department source query.
    authorizeWorkflowScope(context.principal, { permission: authority.permission, roles: authority.roles, purpose: authority.purpose, targets: [] });
    const result = semanticIntentSchema.parse(await binding.identify(context, payload));
    invariant(new Set(result.targets.map(t => t.targetId)).size === result.targets.length &&
      new Set(result.targets.map(t => t.semanticKey)).size === result.targets.length,
    'WORKFLOW_CALLBACK_CONTRACT', 'Semantic target identities are repeated');
    authorizeWorkflowScope(context.principal, { permission: authority.permission, roles: authority.roles, purpose: authority.purpose, targets: result.targets.map(t => t.scope) });
    return freezeWorkflowValue(result);
  }
  async existing(context: RuntimeReadContext, intent: SemanticIntent, kind: WorkflowActionKind): Promise<PreparationResult | null> {
    const effects: ProjectedRow<SemanticEffectRow>[] = [];
    for (const target of intent.targets) {
      const found = await context.projections.query<SemanticEffectRow>({ kind: 'unique', table: 'semantic_effects',
        constraint: 'semantic_effects_key_unique', values: { semanticKey: target.semanticKey } });
      invariant(found.length <= 1, 'WORKFLOW_CALLBACK_CONTRACT', 'A semantic reservation is ambiguous');
      if (found[0]) effects.push(found[0]);
    }
    if (!effects.length) return null;
    invariant(effects.length === intent.targets.length && new Set(effects.map(row => row.body.executionId)).size === 1,
      'WORKFLOW_STALE', 'Existing and new targets require a fresh explicit selection', 409);
    for (const effect of effects) {
      const ref = refSchema.parse({ table: effect.body.effectType, id: effect.body.effectId });
      invariant(effect.body.status === 'committed' && await context.projections.get(ref.table, ref.id),
        'WORKFLOW_STALE', 'An existing effect cannot be established', 409);
    }
    const executionId = effects[0].body.executionId;
    const receipt = await context.projections.get('action_executions', executionId);
    invariant(receipt, 'WORKFLOW_STALE', 'An existing execution cannot be established', 409);
    const existingReceipt = workflowReceiptV2Schema.parse(receipt.body);
    invariant(existingReceipt.kind === kind, 'WORKFLOW_STALE', 'An existing execution is not compatible with this action', 409);
    return preparationResultSchema.parse({ outcome: existingReceipt.outcome === 'verified_success' || existingReceipt.outcome === 'already_completed' ? 'already_completed' : 'pending',
      pendingAction: null, existingExecutionId: executionId, currentStates: [], reasons: [] });
  }
  async assertExpectedRows(tx: WorkflowTransactionContext, rows: readonly ExpectedRow[]): Promise<void> {
    for (const expected of rows) {
      const current = await tx.workflowProjectionReader.get(expected.ref.table, expected.ref.id);
      invariant(current && current.rowVersion === expected.rowVersion && workflowRowState(expected.ref.table, current.body) === expected.state,
        'WORKFLOW_STALE', 'A reviewed row changed', 409);
    }
  }
  async assertFreshRootReview(context: RuntimeReadContext, action: PendingActionV2, root?: ProjectedRow<WorkflowRootRow>): Promise<void> {
    const audit = await context.projections.get<{ actorId: string; actionId: string; category: string; outcome?: string }>('audit_events', preparationAuditId(action.id));
    invariant(audit?.body.actorId === action.actorId && audit.body.actionId === action.id && audit.body.category === 'workflow_prepare' &&
      audit.body.outcome === preparationRootStamp(root), 'WORKFLOW_STALE', 'The review predates the current semantic claim', 409);
  }
  async assertSnapshot(context: RuntimeReadContext, action: Pick<PendingActionV2, 'payload' | 'reviewedSnapshotId' | 'policy' | 'expectedRows' | 'targets'>): Promise<void> {
    if (action.reviewedSnapshotId === null) return;
    const projection = await context.projections.get<ReviewSnapshot>('review_snapshots', action.reviewedSnapshotId);
    invariant(projection, 'WORKFLOW_STALE', 'The reviewed snapshot is unavailable', 409);
    const snapshot = reviewSnapshotSchema.parse(projection.body);
    invariant(snapshot.actorId === context.actor.id && snapshot.actorSessionId === context.actor.sessionId &&
      Date.parse(snapshot.expiresAt) > this.now().getTime() && snapshot.digest === workflowSnapshotDigest(snapshot) &&
      digest(snapshot.policy) === digest(action.policy), 'WORKFLOW_STALE', 'The reviewed snapshot changed', 409);
    const payload = action.payload;
    if (payload.kind === 'onboarding_manager_approve' || payload.kind === 'onboarding_director_approve' || payload.kind === 'onboarding_return') {
      invariant(payload.snapshotId === snapshot.id && payload.requestIds.every(requestId => snapshot.displayedIds.includes(requestId)) &&
        snapshot.purpose === (payload.kind === 'onboarding_manager_approve' ? 'manager_queue' : 'director_queue'),
      'WORKFLOW_STALE', 'The selected requests do not match the displayed snapshot', 409);
      const selectedGuards = mergeExpectedRows(action.expectedRows, ...action.targets.map(target => target.expectedRows));
      for (const reviewed of snapshot.expectedRows) {
        const selected = selectedGuards.find(row => digest(row.ref) === digest(reviewed.ref));
        invariant(!selected || digest(selected) === digest(reviewed), 'WORKFLOW_STALE', 'A selected snapshot guard changed before preparation', 409);
      }
      for (const requestId of payload.requestIds) {
        const reviewed = snapshot.expectedRows.find(row => row.ref.table === 'onboarding_requests' && row.ref.id === requestId);
        const selected = selectedGuards.find(row => row.ref.table === 'onboarding_requests' && row.ref.id === requestId);
        invariant(reviewed && selected && digest(reviewed) === digest(selected), 'WORKFLOW_STALE', 'A selected request lacks its reviewed snapshot guard', 409);
      }
    }
  }
  async assertEnvelope(tx: WorkflowTransactionContext, context: RuntimeReadContext, action: PendingActionV2, fresh = true,
    operationContext?: WorkflowOperationContext): Promise<SemanticIntent> {
    invariant(action.actorId === context.actor.id && action.sessionId === context.actor.sessionId,
      'WORKFLOW_NOT_FOUND', 'The pending action is unavailable', 404);
    if (operationContext) invariant(action.conversationId === operationContext.conversationId && action.turnId === operationContext.turnId,
      'WORKFLOW_NOT_FOUND', 'The pending action is unavailable', 404);
    invariant(action.payloadHash === workflowApprovalHash(action), 'WORKFLOW_STALE', 'The immutable approval changed', 409);
    await this.assertConversation(context, action.conversationId, !fresh);
    const binding = this.binding(action.payload.kind), intent = await this.identify(context, binding, action.payload);
    invariant(action.idempotencyKey === workflowSemanticRoot(action.payload.kind, intent.targets), 'WORKFLOW_STALE', 'The semantic root changed', 409);
    invariant(digest(intent.targets.map(t => [t.targetId, t.ref, t.semanticKey]).sort((a, b) => digest(a).localeCompare(digest(b)))) ===
      digest(action.targets.map(t => [t.targetId, t.ref, t.semanticKey]).sort((a, b) => digest(a).localeCompare(digest(b)))),
    'WORKFLOW_STALE', 'Semantic identity no longer matches the approved targets', 409);
    if (fresh) {
      invariant(action.mode === context.actor.mode && action.modeRevision === context.actor.modeRevision && Date.parse(action.expiresAt) > this.now().getTime() &&
        action.releaseRevision === this.releaseRevision() && action.executionMode === binding.executionMode,
      'WORKFLOW_STALE', 'Mode, expiry or implementation changed', 409);
      context.assertPins(action.packs); await this.assertPolicy(tx, action.policy); await this.assertSnapshot(context, action);
      await this.assertExpectedRows(tx, mergeExpectedRows(action.expectedRows, ...action.targets.map(target => target.expectedRows)));
    }
    return intent;
  }
  async denialAudit(sessionId: string, details: Parameters<typeof failureResult>[1] & { targetRefs?: Ref[] }): Promise<boolean> {
    try {
      await this.store.workflowTransaction(async tx => {
        const session = await tx.workflowProjectionReader.get<{ profileId: string }>('sessions', sessionId);
        const actorId = session?.body.profileId;
        invariant(actorId && await tx.workflowProjectionReader.get('profiles', actorId), 'WORKFLOW_NOT_FOUND', 'Audit actor unavailable');
        const actionId = details.actionId && await tx.workflowProjectionReader.get('pending_actions', details.actionId) ? details.actionId : undefined;
        const executionId = details.executionId && await tx.workflowProjectionReader.get('action_executions', details.executionId) ? details.executionId : undefined;
        await writeWorkflowAudit(tx, { id: this.makeId('audit'), actorId, category: 'workflow_denied', summary: 'A workflow attempt was rejected or requires readback.',
          createdAt: this.now().toISOString(), correlationId: details.correlationId,
          ...(actionId ? { actionId } : {}), ...(executionId ? { executionId } : {}),
          ...(details.targetRefs ? { targetRefs: details.targetRefs } : {}) });
      }); return true;
    } catch { return false; }
  }
  async prepare(sessionId: string, input: WorkflowPayloadV2, request: WorkflowOperationContext,
    expectedModePin?: WorkflowPreparationModePin): Promise<PreparationResult> {
    const correlationId = this.makeId('correlation');
    let attempted: { action: PendingActionV2; messageId: string } | undefined;
    let preparedRequest: { payload: WorkflowPayloadV2; requestContext: WorkflowOperationContext; modePin?: WorkflowPreparationModePin } | undefined;
    let callbackCompleted = false;
    try {
      const payload = freezeWorkflowValue(workflowActionPayloadSchema.parse(input));
      const requestContext = freezeWorkflowValue({ conversationId: identifier.parse(request.conversationId), turnId: identifier.parse(request.turnId) });
      const modePin = expectedModePin === undefined ? undefined : freezeWorkflowValue(preparationModePinSchema.parse(expectedModePin));
      preparedRequest = { payload, requestContext, modePin };
      return await this.store.workflowTransaction(async tx => {
        const context = await this.context(tx, sessionId), binding = this.binding(payload.kind);
        assertPreparationModePin(context, modePin);
        await this.assertConversation(context, requestContext.conversationId);
        const intent = await this.identify(context, binding, payload), prior = await this.existing(context, intent, payload.kind);
        if (prior) {
          const result = { ...prior, currentStates: await this.currentStates(binding, context, intent.targets.map(target => target.ref)) };
          callbackCompleted = true; return result;
        }
        const rootKey = workflowSemanticRoot(payload.kind, intent.targets);
        const roots = await context.projections.query<WorkflowRootRow>({ kind: 'unique', table: 'action_idempotency_roots',
          constraint: 'action_idempotency_roots_key_unique', values: { idempotencyKey: rootKey } });
        if (roots[0]?.body.activeExecutionId) {
          const old = await context.projections.get<{ outcome: string }>('action_executions', roots[0].body.activeExecutionId);
          if (old?.body.outcome !== 'failed' && old?.body.outcome !== 'stale' && old?.body.outcome !== 'denied') {
            const result = preparationResultSchema.parse({ outcome: 'pending', pendingAction: null,
              existingExecutionId: roots[0].body.activeExecutionId, currentStates: [], reasons: [] });
            callbackCompleted = true; return result;
          }
        }
        const review = await this.preparationReview(tx, context, binding, payload, requestContext, intent);
        const reusable = await this.anchoredPreparation(context, review, roots[0]);
        if (reusable) { callbackCompleted = true; return reusable; }
        const created = this.now();
        const action = pendingActionV2Schema.parse({ ...review, id: this.makeId('action'), payloadHash: '0'.repeat(64),
          createdAt: created.toISOString(), expiresAt: pendingActionExpiresAt(created), status: 'pending' });
        action.payloadHash = workflowApprovalHash(action);
        attempted = { action: freezeWorkflowValue(structuredClone(action)), messageId: assistantMessageId(context.actor.id, requestContext) };
        const inserted = await tx.insertUnique('pending_actions', action, { constraint: 'pending_actions_primary_key', values: { id: action.id } });
        invariant(inserted.inserted, 'WORKFLOW_CONFLICT', 'The pending action identity already exists', 409);
        await writeWorkflowAudit(tx, { id: preparationAuditId(action.id), actorId: context.actor.id, actionId: action.id, category: 'workflow_prepare',
          summary: 'An exact workflow review was prepared without business effects.', createdAt: created.toISOString(), correlationId,
          targetRefs: action.targets.map(t => t.ref), outcome: preparationRootStamp(roots[0]) });
        const linked = await linkAssistantMessage(guardedAssistantAnchorAdapter(tx), context.actor, requestContext,
          { appendActionIds: [action.id], now: created });
        attempted.messageId = linked.message.id;
        const result = preparationResultSchema.parse({ outcome: 'pending', pendingAction: action, existingExecutionId: null, currentStates: [], reasons: [] });
        callbackCompleted = true; return result;
      });
    } catch (error) {
      // Callback failures never dispatch preparation; an unacknowledged commit is not a rollback proof.
      const noCommit = !attempted || !callbackCompleted || definitelyNotCommitted(error);
      if (this.store.adapter === 'supabase' && preparedRequest && definitelyNotCommitted(error) &&
        typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'CONFLICT') {
        const winner = await this.readPreparationWinner(sessionId, preparedRequest);
        if (winner) return winner;
      }
      if (!noCommit && attempted) {
        const recovered = await this.readPreparedAction(sessionId, attempted, correlationId);
        if (recovered) return recovered;
      }
      const context = { correlationId, actionId: attempted?.action.id ?? null, executionId: null,
        certainty: noCommit ? 'definitely_not_committed' as const : 'unknown' as const,
        effect: noCommit ? 'none' as const : 'unknown' as const };
      const recorded = await this.denialAudit(sessionId, context), failure = failureResult(noCommit ? error :
        new DomainError('TRANSPORT_OUTCOME_UNKNOWN', 'The preparation commit outcome requires readback', 503),
      { ...context, auditStatus: recorded ? 'recorded' : 'unverified' });
      if (error instanceof DomainError && (failure.outcome === 'denied' || failure.outcome === 'stale')) return preparationResultSchema.parse({
        outcome: failure.outcome, pendingAction: null, existingExecutionId: null, currentStates: [], reasons: failure.reasons });
      throw new WorkflowOperationError(failure);
    }
  }
  private async preparationReview(tx: WorkflowTransactionContext, context: RuntimeReadContext, binding: WorkflowRuntimeBinding,
    payload: WorkflowPayloadV2, request: WorkflowOperationContext, intent: SemanticIntent): Promise<PreparationReview> {
    await this.assertPolicy(tx);
    const validated = workflowValidationSchema.parse(await binding.validate(context, payload));
    await this.assertPolicy(tx, validated.policy);
    invariant(validated.targets.length <= demoWorkflowPolicyV1.maxBatchTargets, 'WORKFLOW_INVALID_INPUT', 'The batch exceeds the configured policy limit');
    authorizeWorkflowScope(context.principal, { ...binding.authority, targets: validated.approvedBranchIds.map(branchId => ({ branchId })) });
    authorizeWorkflowScope(context.principal, { ...binding.authority, targets: validated.approvedOrgUnitIds.map(orgUnitId => ({ orgUnitId })) });
    invariant(intent.targets.every(target => (target.scope.branchId === undefined || validated.approvedBranchIds.includes(target.scope.branchId)) &&
      (target.scope.orgUnitId === undefined || validated.approvedOrgUnitIds.includes(target.scope.orgUnitId))),
    'WORKFLOW_CALLBACK_CONTRACT', 'The approved scope omits an identified target');
    invariant(digest(validated.targets.map(t => [t.targetId, t.ref, t.semanticKey]).sort((a, b) => digest(a).localeCompare(digest(b)))) ===
      digest(intent.targets.map(t => [t.targetId, t.ref, t.semanticKey]).sort((a, b) => digest(a).localeCompare(digest(b)))),
    'WORKFLOW_CALLBACK_CONTRACT', 'Validation changed the identified targets');
    const expectedRows = mergeExpectedRows(validated.expectedRows, context.principal.authorityExpectedRows.map(row => expectedRowSchema.parse(row)));
    const review: PreparationReview = { contractVersion: 2, actorId: context.actor.id, sessionId: context.actor.sessionId,
      conversationId: request.conversationId, turnId: request.turnId, mode: context.actor.mode, modeRevision: context.actor.modeRevision,
      payload, idempotencyKey: workflowSemanticRoot(payload.kind, intent.targets), ...validated, expectedRows, targetCount: validated.targets.length,
      packs: this.pins(binding.packIds), releaseRevision: this.releaseRevision(), executionMode: binding.executionMode };
    await this.assertSnapshot(context, review);
    await this.assertExpectedRows(tx, mergeExpectedRows(review.expectedRows, ...review.targets.map(target => target.expectedRows)));
    return freezeWorkflowValue(review);
  }
  private async anchoredPreparation(context: RuntimeReadContext, review: PreparationReview,
    root?: ProjectedRow<WorkflowRootRow>): Promise<PreparationResult | null> {
    const deterministicId = assistantMessageId(context.actor.id, review);
    let anchor = await context.projections.get('conversation_messages', deterministicId);
    if (!anchor) {
      // The linker can preserve an explicitly identified historical message ID.
      // Projection pages allow at most 100 rows; a full page cannot establish uniqueness.
      const limit = 100;
      const rows = await context.projections.query({ kind: 'scoped', table: 'conversation_messages', limit,
        equals: { actorId: review.actorId, sessionId: review.sessionId, conversationId: review.conversationId, turnId: review.turnId } });
      invariant(rows.length < limit, 'WORKFLOW_CONFLICT', 'The assistant message identity set cannot be established', 409);
      const assistants = rows.filter(row => persistedConversationMessageSchema.parse(row.body).role === 'assistant');
      invariant(assistants.length <= 1, 'WORKFLOW_CONFLICT', 'The turn has conflicting assistant messages', 409);
      anchor = assistants[0];
    }
    if (!anchor) return null;
    const message = persistedConversationMessageSchema.parse(anchor.body);
    invariant(message.role === 'assistant' && message.actorId === review.actorId && message.sessionId === review.sessionId &&
      message.conversationId === review.conversationId && message.turnId === review.turnId,
    'WORKFLOW_CONFLICT', 'The assistant anchor does not belong to this exact turn', 409);
    const refs = [...new Set([...(message.pendingActionIds ?? []), ...(message.pendingActionId ? [message.pendingActionId] : [])])];
    invariant(refs.length <= MAX_WORKFLOW_TARGETS, 'WORKFLOW_CONFLICT', 'Too many assistant action references', 409);
    let samePayload = false;
    const matches: PendingActionV2[] = [];
    for (const actionId of refs) {
      const row = await context.projections.get<Pick<PendingActionV2, 'id' | 'actorId' | 'sessionId' | 'conversationId' | 'turnId'> & { contractVersion?: number }>(
        'pending_actions', actionId);
      invariant(row && row.body.id === actionId && row.body.actorId === review.actorId && row.body.sessionId === review.sessionId &&
        row.body.conversationId === review.conversationId && row.body.turnId === review.turnId,
      'WORKFLOW_CONFLICT', 'An assistant action reference does not belong to this exact turn', 409);
      if (row.body.contractVersion !== 2) continue;
      const action = pendingActionV2Schema.parse(row.body);
      if (digest(action.payload) !== digest(review.payload)) continue;
      samePayload = true;
      invariant(action.payloadHash === workflowApprovalHash(action), 'WORKFLOW_STALE', 'The immutable approval changed', 409);
      if (action.status !== 'pending' || Date.parse(action.expiresAt) <= this.now().getTime() ||
        action.payloadHash !== workflowApprovalHash({ ...action, ...review })) continue;
      await this.assertFreshRootReview(context, action, root);
      matches.push(action);
    }
    invariant(matches.length <= 1, 'WORKFLOW_CONFLICT', 'The turn has repeated active reviews for the same payload', 409);
    invariant(!samePayload || matches.length === 1, 'WORKFLOW_STALE', 'The existing turn review changed or expired; prepare a fresh turn', 409);
    return matches[0] ? preparationResultSchema.parse({ outcome: 'pending', pendingAction: matches[0],
      existingExecutionId: null, currentStates: [], reasons: [] }) : null;
  }
  private async readPreparationWinner(sessionId: string,
    request: { payload: WorkflowPayloadV2; requestContext: WorkflowOperationContext; modePin?: WorkflowPreparationModePin }): Promise<PreparationResult | null> {
    try {
      return await this.store.workflowTransaction(async tx => {
        const context = await this.context(tx, sessionId), binding = this.binding(request.payload.kind);
        assertPreparationModePin(context, request.modePin);
        await this.assertConversation(context, request.requestContext.conversationId);
        const intent = await this.identify(context, binding, request.payload);
        const roots = await context.projections.query<WorkflowRootRow>({ kind: 'unique', table: 'action_idempotency_roots',
          constraint: 'action_idempotency_roots_key_unique', values: { idempotencyKey: workflowSemanticRoot(request.payload.kind, intent.targets) } });
        const review = await this.preparationReview(tx, context, binding, request.payload, request.requestContext, intent);
        return this.anchoredPreparation(context, review, roots[0]);
      });
    } catch (error) {
      if (error instanceof DomainError) {
        const failure = failureResult(error, { correlationId: this.makeId('correlation'), actionId: null, executionId: null,
          certainty: 'definitely_not_committed', effect: 'none' });
        if (failure.outcome === 'denied' || failure.outcome === 'stale') return preparationResultSchema.parse({
          outcome: failure.outcome, pendingAction: null, existingExecutionId: null, currentStates: [], reasons: failure.reasons });
      }
      return null;
    }
  }
  private async readPreparedAction(sessionId: string, attempted: { action: PendingActionV2; messageId: string },
    correlationId: string): Promise<PreparationResult | null> {
    try {
      return await this.store.workflowTransaction(async tx => {
        const context = await this.context(tx, sessionId), expected = attempted.action;
        invariant(context.actor.id === expected.actorId && context.actor.sessionId === expected.sessionId,
          'WORKFLOW_NOT_FOUND', 'The prepared action is unavailable', 404);
        await this.assertConversation(context, expected.conversationId, true);
        const binding = this.binding(expected.payload.kind), authority = getWorkflowActionAuthority(expected.payload.kind);
        for (const permission of new Set([...authority.readPermissions, ...(this.options.getReadPermissions?.(binding.packIds) ?? [])])) {
          invariant(context.actor.permissions.includes(permission), 'WORKFLOW_PERMISSION_DENIED', 'A required read permission is absent', 403);
        }
        authorizeWorkflowScope(context.principal, { ...binding.authority, targets: [
          ...expected.approvedBranchIds.map(branchId => ({ branchId })), ...expected.approvedOrgUnitIds.map(orgUnitId => ({ orgUnitId })),
        ] });
        const actionRow = await tx.workflowProjectionReader.get('pending_actions', expected.id);
        const messageRow = await tx.workflowProjectionReader.get('conversation_messages', attempted.messageId);
        const audit = await tx.workflowProjectionReader.get<{ actorId: string; actionId: string; category: string; correlationId: string }>(
          'audit_events', preparationAuditId(expected.id));
        if (!actionRow || !messageRow || !audit) return null;
        const action = pendingActionV2Schema.parse(actionRow.body), message = persistedConversationMessageSchema.parse(messageRow.body);
        const refs = [...(message.pendingActionIds ?? []), ...(message.pendingActionId ? [message.pendingActionId] : [])];
        invariant(action.id === expected.id && action.actorId === expected.actorId && action.sessionId === expected.sessionId &&
          action.conversationId === expected.conversationId && action.turnId === expected.turnId && action.payloadHash === expected.payloadHash &&
          workflowApprovalHash(action) === expected.payloadHash && message.id === attempted.messageId && message.role === 'assistant' &&
          message.actorId === expected.actorId && message.sessionId === expected.sessionId && message.conversationId === expected.conversationId &&
          message.turnId === expected.turnId && refs.includes(expected.id) && audit.body.actorId === expected.actorId &&
          audit.body.actionId === expected.id && audit.body.category === 'workflow_prepare' && audit.body.correlationId === correlationId,
        'WORKFLOW_STALE', 'The preparation anchor could not establish the attempted commit', 409);
        return preparationResultSchema.parse({ outcome: 'pending', pendingAction: action, existingExecutionId: null, currentStates: [], reasons: [] });
      });
    } catch { return null; }
  }
  async currentStates(binding: WorkflowRuntimeBinding, context: RuntimeReadContext, refs: Ref[]): Promise<CurrentState[]> {
    const allowed = new Set(refs.map(ref => digest(ref)));
    const rows = (await binding.currentStates(context, refs)).map(row => entityStateSchema.parse(row));
    invariant(rows.every(row => allowed.has(digest(row.ref))) && new Set(rows.map(row => digest(row.ref))).size === rows.length,
      'WORKFLOW_CALLBACK_CONTRACT', 'Current states contain unauthorized or repeated references');
    for (const row of rows) {
      const observed = await context.projections.get(row.ref.table, row.ref.id);
      invariant(observed && observed.rowVersion === row.rowVersion, 'WORKFLOW_CALLBACK_CONTRACT', 'A current-state version was not freshly observed');
    }
    return rows;
  }
}

export function createWorkflowActionRuntime(options: WorkflowRuntimeOptions): WorkflowActionRuntime { return new WorkflowActionRuntime(options); }
