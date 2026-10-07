import { DomainError, invariant } from '../core/errors';
import { z } from 'zod';
import { digest } from '../core/utils';
import type { ProjectedRow, WorkflowTransactionContext } from '../storage/workflow-projections';
import {
  committedTargetSchema, dashboardShareRevokeEventSchema, dashboardShareV2Schema, directoryIdentitySchema, instantSchema,
  pendingActionV2Schema, workflowReceiptV2Schema,
  type CommittedTarget, type GuardedTransaction, type PendingActionV2, type WorkflowReceiptV2,
} from './contracts';
import {
  freezeWorkflowValue, mergeExpectedRows,
  type ActionTargetRow, type RuntimeReadContext, type SemanticEffectRow, type WorkflowActionRuntime, type WorkflowRootRow,
} from './action-runtime';
import { capturePostconditions, checkPostconditions, definitelyNotCommitted, failureResult, validateCommittedTargets, validateProofs, writeWorkflowAudit,
  type ExpectedField, type ExpectedPostcondition, type WorkflowClaimRecoveryResult, type WorkflowCommandResult, type WorkflowOperationContext } from './action-results';
import { dashboardShareRevokeEventIdV1 } from './share-revoke-id';

interface ClaimedExecution {
  action: PendingActionV2; executionId: string; rootId: string; rootVersion: number; fresh: boolean;
  operationContext: WorkflowOperationContext;
  winnerActionId: string;
}
const operationContextSchema = z.object({ conversationId: directoryIdentitySchema.shape.id, turnId: directoryIdentitySchema.shape.id }).strict();
const CORE_TABLES = new Set(['profiles', 'sessions', 'directory_identities', 'responsibilities', 'org_units', 'reporting_relationships',
  'workflow_policies', 'review_snapshots', 'review_snapshot_targets', 'pending_actions', 'action_confirmations', 'action_idempotency_roots',
  'action_executions', 'action_targets', 'semantic_effects', 'audit_events', 'conversations', 'conversation_messages']);

export function workflowActionTargetId(executionId: string, targetId: string): string {
  return `target_${digest({ executionId, targetId })}`;
}

interface DashboardShareRevokePin {
  targetId: string;
  shareId: string;
  shareCreationExecutionId: string;
  priorShareRowVersion: number;
  revokedShareRowVersion: number;
  eventId: string;
}

function requirePostconditionField(fields: readonly ExpectedField[], path: string, expected: unknown): void {
  const matches = fields.filter(field => field.path === path);
  invariant(matches.length === 1 && digest(matches[0].expected) === digest(expected),
    'WORKFLOW_CALLBACK_CONTRACT', 'A reviewed revoke attribution field did not match');
}

function pinPostconditionField(fields: readonly ExpectedField[], path: string, expected: unknown): ExpectedField[] {
  const matches = fields.filter(field => field.path === path);
  invariant(matches.length <= 1 && (!matches.length || digest(matches[0].expected) === digest(expected)),
    'WORKFLOW_CALLBACK_CONTRACT', 'A reviewed revoke attribution field changed');
  return matches.length ? [...fields] : [...fields, { path, expected }];
}

async function readDashboardShareRevokePin(context: RuntimeReadContext, action: PendingActionV2): Promise<Omit<DashboardShareRevokePin, 'eventId'> | null> {
  if (action.payload.kind !== 'dashboard_share_revoke') return null;
  invariant(action.targets.length === 1, 'WORKFLOW_CALLBACK_CONTRACT', 'A share revoke must target exactly one share');
  const target = action.targets[0], shareId = action.payload.shareId;
  invariant(target.ref.table === 'dashboard_shares' && target.ref.id === shareId &&
    target.expectedEffectRef.table === 'dashboard_shares' && target.expectedEffectRef.id === shareId,
  'WORKFLOW_CALLBACK_CONTRACT', 'The revoke target did not identify the approved share');
  const targetGuards = target.expectedRows.filter(row => row.ref.table === 'dashboard_shares' && row.ref.id === shareId);
  const reviewedGuards = mergeExpectedRows(action.expectedRows, ...action.targets.map(item => item.expectedRows))
    .filter(row => row.ref.table === 'dashboard_shares' && row.ref.id === shareId);
  invariant(targetGuards.length === 1 && reviewedGuards.length === 1 && digest(targetGuards[0]) === digest(reviewedGuards[0]) &&
    reviewedGuards[0].state === 'active' && target.expectedEffectVersion === reviewedGuards[0].rowVersion + 1,
  'WORKFLOW_CALLBACK_CONTRACT', 'The reviewed active share version is unavailable');
  const source = await context.projections.get('dashboard_shares', shareId);
  invariant(source && source.rowVersion === reviewedGuards[0].rowVersion,
    'WORKFLOW_STALE', 'The reviewed share changed before revocation', 409);
  const share = dashboardShareV2Schema.parse(source.body);
  invariant(share.id === shareId && share.rowVersion === reviewedGuards[0].rowVersion && share.status === 'active',
    'WORKFLOW_STALE', 'The reviewed share changed before revocation', 409);
  return { targetId: target.targetId, shareId, shareCreationExecutionId: share.executionId,
    priorShareRowVersion: reviewedGuards[0].rowVersion, revokedShareRowVersion: target.expectedEffectVersion };
}

function pinDashboardShareRevokePostconditions(action: PendingActionV2, executionId: string, confirmedAt: string,
  raw: readonly ExpectedPostcondition[], pin: Omit<DashboardShareRevokePin, 'eventId'>): { postconditions: ExpectedPostcondition[]; eventId: string } {
  invariant(action.payload.kind === 'dashboard_share_revoke' && raw.length === 1,
    'WORKFLOW_CALLBACK_CONTRACT', 'A share revoke postcondition plan was incomplete');
  const witness = raw[0];
  invariant(witness.targetId === pin.targetId && witness.ref.table === 'dashboard_shares' && witness.ref.id === pin.shareId &&
    witness.rowVersion === pin.revokedShareRowVersion && witness.executionId === executionId,
  'WORKFLOW_CALLBACK_CONTRACT', 'A share revoke postcondition did not match the reviewed target');
  requirePostconditionField(witness.fields, 'id', pin.shareId);
  requirePostconditionField(witness.fields, 'status', 'revoked');
  requirePostconditionField(witness.fields, 'revokedAt', confirmedAt);
  const eventRefs = witness.attributionRefs.filter(item => item.ref.table === 'dashboard_share_revoke_events');
  invariant(eventRefs.length === 1 && eventRefs[0].rowVersion === 1,
    'WORKFLOW_CALLBACK_CONTRACT', 'A share revoke must include one versioned event attribution');
  const event = eventRefs[0];
  const eventId = dashboardShareRevokeEventIdV1(executionId, pin.shareId);
  invariant(event.ref.id === eventId,
    'WORKFLOW_CALLBACK_CONTRACT', 'The share revoke event reference did not match its canonical identity');
  requirePostconditionField(event.fields, 'shareId', pin.shareId);
  requirePostconditionField(event.fields, 'actorId', action.actorId);
  requirePostconditionField(event.fields, 'executionId', executionId);
  requirePostconditionField(event.fields, 'priorShareRowVersion', pin.priorShareRowVersion);
  requirePostconditionField(event.fields, 'revokedShareRowVersion', pin.revokedShareRowVersion);
  requirePostconditionField(event.fields, 'createdAt', confirmedAt);
  requirePostconditionField(event.fields, 'rowVersion', 1);
  return {
    eventId,
    postconditions: [{ ...witness,
      fields: pinPostconditionField(witness.fields, 'executionId', pin.shareCreationExecutionId),
      attributionRefs: witness.attributionRefs.map(item => item.ref.table === 'dashboard_share_revoke_events' && item.ref.id === event.ref.id
        ? { ...item, fields: pinPostconditionField(item.fields, 'shareCreationExecutionId', pin.shareCreationExecutionId) }
        : item) }],
  };
}

/**
 * Confirmations against one store are admitted one at a time within a process. A second concurrent confirmation
 * then sees the winner's committed claim (a definite conflict or the stored receipt) instead of racing it, so the
 * effect callback is not re-run by the storage adapter's revision-conflict retry. Across processes the adapter's
 * compare-and-swap and retry still guarantee exactly one committed effect.
 */
const confirmationQueues = new WeakMap<object, Promise<unknown>>();

export class WorkflowActionRunner {
  constructor(readonly runtime: WorkflowActionRuntime) {}

  private async action(tx: WorkflowTransactionContext, actionId: string): Promise<ProjectedRow<PendingActionV2>> {
    const row = await tx.workflowProjectionReader.get<PendingActionV2>('pending_actions', actionId);
    invariant(row, 'WORKFLOW_NOT_FOUND', 'The pending action is unavailable', 404);
    return { ...row, body: freezeWorkflowValue(pendingActionV2Schema.parse(row.body)) };
  }

  private async claim(sessionId: string, actionId: string, correlationId: string, operationContext: WorkflowOperationContext): Promise<ClaimedExecution> {
    return this.runtime.store.workflowTransaction(async tx => {
      const context = await this.runtime.context(tx, sessionId), pending = await this.action(tx, actionId), action = pending.body;
      const intent = await this.runtime.assertEnvelope(tx, context, action, false, operationContext);
      const roots = await context.projections.query<WorkflowRootRow>({ kind: 'unique', table: 'action_idempotency_roots',
        constraint: 'action_idempotency_roots_key_unique', values: { idempotencyKey: action.idempotencyKey } });
      let root: ProjectedRow<WorkflowRootRow> | undefined = roots[0];
      if (root?.body.activeExecutionId) {
        const existing = await context.projections.get<WorkflowReceiptV2>('action_executions', root.body.activeExecutionId);
        invariant(existing, 'WORKFLOW_STALE', 'The active execution is unavailable', 409);
        const receipt = workflowReceiptV2Schema.parse(existing.body);
        if (receipt.actionId === action.id || root.body.status !== 'open' || !['failed', 'denied', 'stale'].includes(receipt.outcome)) {
          return { action, executionId: receipt.id, rootId: root.id, rootVersion: root.rowVersion, fresh: false, operationContext, winnerActionId: receipt.actionId };
        }
      }
      const prior = await this.runtime.existing(context, intent, action.payload.kind);
      if (prior?.existingExecutionId) {
        const winner = await context.projections.get('action_executions', prior.existingExecutionId);
        invariant(winner, 'WORKFLOW_STALE', 'The winning execution is unavailable', 409);
        return { action, executionId: prior.existingExecutionId, rootId: root?.id ?? '', rootVersion: root?.rowVersion ?? 0,
          fresh: false, operationContext, winnerActionId: workflowReceiptV2Schema.parse(winner.body).actionId };
      }
      await this.runtime.assertEnvelope(tx, context, action, true, operationContext);
      invariant(action.status === 'pending', 'WORKFLOW_STALE', 'This review was already used', 409);
      const executionId = this.runtime.makeId('execution'), createdAt = this.runtime.now().toISOString();
      let attempt: number;
      if (!root) {
        const rootBody: WorkflowRootRow = { id: this.runtime.makeId('root'), rowVersion: 1, actorId: context.actor.id,
          idempotencyKey: action.idempotencyKey, status: 'open', activeExecutionId: executionId, actionId: action.id, createdAt };
        const inserted = await tx.insertUnique('action_idempotency_roots', rootBody,
          { constraint: 'action_idempotency_roots_key_unique', values: { idempotencyKey: action.idempotencyKey } });
        invariant(inserted.inserted, 'WORKFLOW_CONFLICT', 'Another execution claimed this semantic root', 409);
        root = await context.projections.get<WorkflowRootRow>('action_idempotency_roots', rootBody.id);
        invariant(root?.rowVersion === 1, 'WORKFLOW_CALLBACK_CONTRACT', 'The inserted root version was unavailable');
        attempt = 1;
      } else {
        invariant(root.body.status === 'open', 'WORKFLOW_STALE', 'The semantic root is terminal', 409);
        await this.runtime.assertFreshRootReview(context, action, root);
        // An attempt is a unique positive root CAS version, never a phantom receipt/body field.
        attempt = root.rowVersion + 1;
        const changed = await tx.compareAndSwap('action_idempotency_roots', root.id,
          { rowVersion: root.rowVersion, state: 'open' }, { ...root.body, rowVersion: attempt, activeExecutionId: executionId, actionId: action.id });
        invariant(changed.updated, 'WORKFLOW_CONFLICT', 'Another execution changed this semantic root', 409);
        root = await context.projections.get<WorkflowRootRow>('action_idempotency_roots', root.id);
        invariant(root?.rowVersion === attempt, 'WORKFLOW_CALLBACK_CONTRACT', 'The claimed root version did not match');
      }
      const receipt: WorkflowReceiptV2 = { id: executionId, actionId: action.id, contractVersion: 2, actorId: context.actor.id,
        kind: action.payload.kind, outcome: 'pending', proofs: [], currentStates: [], createdAt, verifiedAt: null };
      const execution = await tx.insertUnique('action_executions', receipt,
        { constraint: 'action_executions_root_attempt_unique', values: { rootId: root.id, attempt } });
      invariant(execution.inserted, 'WORKFLOW_CONFLICT', 'The root attempt is already occupied', 409);
      const confirmation = { id: this.runtime.makeId('confirmation'), rowVersion: 1, actionId: action.id, actorId: context.actor.id,
        sessionId: context.actor.sessionId, confirmedAt: createdAt, correlationId, confirmationDigest: action.payloadHash };
      const confirmed = await tx.insertUnique('action_confirmations', confirmation,
        { constraint: 'action_confirmations_action_unique', values: { actionId: action.id } });
      invariant(confirmed.inserted, 'WORKFLOW_CONFLICT', 'The approval was already confirmed', 409);
      const changed = await tx.compareAndSwap('pending_actions', action.id, { rowVersion: pending.rowVersion, state: 'pending' },
        { ...action, rowVersion: pending.rowVersion + 1, status: 'claimed' });
      invariant(changed.updated, 'WORKFLOW_CONFLICT', 'The approval was changed concurrently', 409);
      await writeWorkflowAudit(tx, { id: this.runtime.makeId('audit'), actorId: context.actor.id, actionId: action.id, executionId,
        category: 'workflow_confirm', summary: 'The exact approval was claimed without business effects.', createdAt, correlationId,
        targetRefs: action.targets.map(target => target.ref) });
      return { action: { ...action, status: 'claimed' }, executionId, rootId: root.id, rootVersion: root.rowVersion, fresh: true, operationContext, winnerActionId: action.id };
    });
  }

  private async execute(tx: WorkflowTransactionContext, context: RuntimeReadContext, claim: ClaimedExecution, correlationId: string): Promise<void> {
    const pending = await this.action(tx, claim.action.id), action = pending.body;
    await this.runtime.assertEnvelope(tx, context, action, true, claim.operationContext);
    invariant(action.status === 'claimed', 'WORKFLOW_STALE', 'The approval is no longer claimed', 409);
    const root = await context.projections.get<WorkflowRootRow>('action_idempotency_roots', claim.rootId);
    invariant(root && root.rowVersion === claim.rootVersion && root.body.status === 'open' && root.body.activeExecutionId === claim.executionId,
      'WORKFLOW_CONFLICT', 'The active semantic claim changed', 409);
    const execution = await context.projections.get<WorkflowReceiptV2>('action_executions', claim.executionId);
    invariant(execution && workflowReceiptV2Schema.parse(execution.body).outcome === 'pending' && execution.body.actorId === action.actorId &&
      execution.body.actionId === action.id && execution.body.kind === action.payload.kind, 'WORKFLOW_STALE', 'The execution is no longer pending or does not match', 409);
    for (const target of action.targets) {
      const found = await context.projections.query<SemanticEffectRow>({ kind: 'unique', table: 'semantic_effects',
        constraint: 'semantic_effects_key_unique', values: { semanticKey: target.semanticKey } });
      invariant(found.length === 0, 'WORKFLOW_STALE', 'A target already has an effect', 409);
    }
    const binding = this.runtime.binding(action.payload.kind);
    const confirmedAt = instantSchema.parse(execution.body.createdAt);
    const shareRevokeSource = await readDashboardShareRevokePin(context, action);
    const expectedPostconditions = binding.expectedPostconditions(action, claim.executionId, confirmedAt);
    const shareRevokePlan = shareRevokeSource ? pinDashboardShareRevokePostconditions(action, claim.executionId, confirmedAt,
      expectedPostconditions, shareRevokeSource) : null;
    const postconditions = freezeWorkflowValue(capturePostconditions(action.targets, claim.executionId,
      shareRevokePlan?.postconditions ?? expectedPostconditions));
    const shareRevokePin = shareRevokeSource && shareRevokePlan ? { ...shareRevokeSource, eventId: shareRevokePlan.eventId } : null;
    const permittedWrites = new Set(postconditions.flatMap(row => [row.ref, ...row.attributionRefs.map(attribution => attribution.ref)]).map(ref => digest(ref)));
    const guardWrite = (table: string, id: string) => invariant(!CORE_TABLES.has(table) && permittedWrites.has(digest({ table, id })),
      'WORKFLOW_CALLBACK_CONTRACT', 'The callback attempted an unapproved or core-owned write');
    const effectTx: GuardedTransaction = Object.freeze<GuardedTransaction>({
      get: context.reader.get, list: context.reader.list,
      insertUnique: async (table, row, key) => { guardWrite(table, row.id); return freezeWorkflowValue(structuredClone(await tx.insertUnique(table, row, key))); },
      compareAndSwap: async (table, id, expected, next) => { guardWrite(table, id); return freezeWorkflowValue(structuredClone(await tx.compareAndSwap(table, id, expected, next))); },
    });
    const committed = validateCommittedTargets(action.targets, claim.executionId,
      await binding.executeAtomic({ ...context, now: () => new Date(confirmedAt), tx: effectTx, action, executionId: claim.executionId }, action.payload));
    for (const result of committed) {
      const observed = await context.projections.get<Record<string, unknown>>(result.ref.table, result.ref.id);
      invariant(observed && observed.rowVersion === result.rowVersion && observed.body.id === result.ref.id,
        'WORKFLOW_CALLBACK_CONTRACT', 'The staged effect reference or version did not match');
      if (observed.body.executionId !== undefined) {
        const immutableShareCreationAttribution = shareRevokePin && result.ref.table === 'dashboard_shares' &&
          result.ref.id === shareRevokePin.shareId && observed.body.executionId === shareRevokePin.shareCreationExecutionId;
        invariant(observed.body.executionId === claim.executionId || immutableShareCreationAttribution,
          'WORKFLOW_CALLBACK_CONTRACT', 'The staged effect belongs to another execution');
      }
      const target = action.targets.find(candidate => candidate.targetId === result.targetId)!;
      const reservation: SemanticEffectRow = { id: `semantic_${target.semanticKey}`, rowVersion: 1, semanticKey: target.semanticKey,
        executionId: claim.executionId, effectType: result.ref.table, effectId: result.ref.id, status: 'committed', createdAt: this.runtime.now().toISOString() };
      const reserved = await tx.insertUnique('semantic_effects', reservation,
        { constraint: 'semantic_effects_key_unique', values: { semanticKey: target.semanticKey } });
      invariant(reserved.inserted, 'WORKFLOW_CONFLICT', 'A target semantic key is already reserved', 409);
      const sourceExpected = mergeExpectedRows(action.expectedRows, target.expectedRows).find(row => digest(row.ref) === digest(target.ref));
      invariant(sourceExpected || digest(target.ref) === digest(result.ref), 'WORKFLOW_CALLBACK_CONTRACT', 'A target source has no reviewed version');
      const targetRow: ActionTargetRow = { id: workflowActionTargetId(claim.executionId, target.targetId), rowVersion: 1, executionId: claim.executionId,
        targetId: target.targetId, entityType: target.ref.table, ref: target.ref, expectedRowVersion: sourceExpected?.rowVersion ?? result.rowVersion,
        expectedState: sourceExpected?.state ?? null, targetStatus: 'pending' };
      const inserted = await tx.insertUnique('action_targets', targetRow,
        { constraint: 'action_targets_execution_target_unique', values: { executionId: claim.executionId, entityType: target.ref.table, targetId: target.targetId } });
      invariant(inserted.inserted, 'WORKFLOW_CONFLICT', 'An execution target was already recorded', 409);
      const targetProjection = await context.projections.get<ActionTargetRow>('action_targets', targetRow.id);
      invariant(targetProjection, 'WORKFLOW_CALLBACK_CONTRACT', 'The target projection was unavailable');
      const changed = await tx.compareAndSwap('action_targets', targetRow.id,
        { rowVersion: targetProjection.rowVersion, state: 'pending' }, { ...targetRow, rowVersion: targetProjection.rowVersion + 1, targetStatus: 'committed', result });
      invariant(changed.updated, 'WORKFLOW_CONFLICT', 'The execution target changed', 409);
      const persistedReservation = await context.projections.get<SemanticEffectRow>('semantic_effects', reservation.id);
      const persistedTarget = await context.projections.get<ActionTargetRow>('action_targets', targetRow.id);
      invariant(persistedReservation?.body.executionId === claim.executionId && persistedReservation.body.effectId === result.ref.id &&
        persistedReservation.body.effectType === result.ref.table && persistedTarget?.body.targetStatus === 'committed' && digest(persistedTarget.body.result) === digest(result),
      'WORKFLOW_CALLBACK_CONTRACT', 'The staged target attribution was not persisted');
    }
    if (shareRevokePin) {
      const eventProjection = await context.projections.get('dashboard_share_revoke_events', shareRevokePin.eventId);
      const eventResult = dashboardShareRevokeEventSchema.safeParse(eventProjection?.body);
      invariant(eventProjection?.rowVersion === 1 && eventResult.success,
        'WORKFLOW_CALLBACK_CONTRACT', 'The staged share revoke event was unavailable or malformed');
      const event = eventResult.data;
      invariant(event.id === shareRevokePin.eventId && event.shareId === shareRevokePin.shareId &&
        event.actorId === action.actorId && event.executionId === claim.executionId &&
        event.shareCreationExecutionId === shareRevokePin.shareCreationExecutionId &&
        event.priorShareRowVersion === shareRevokePin.priorShareRowVersion &&
        event.revokedShareRowVersion === shareRevokePin.revokedShareRowVersion && event.createdAt === confirmedAt && event.rowVersion === 1,
      'WORKFLOW_CALLBACK_CONTRACT', 'The staged share revoke event did not match its reviewed attribution');
    }
    await checkPostconditions(context.projections, postconditions);
    const completed = await tx.compareAndSwap('action_idempotency_roots', root.id,
      { rowVersion: root.rowVersion, state: 'open' }, { ...root.body, rowVersion: root.rowVersion + 1, status: 'completed' });
    invariant(completed.updated, 'WORKFLOW_CONFLICT', 'The semantic claim changed before commit', 409);
    await writeWorkflowAudit(tx, { id: this.runtime.makeId('audit'), actorId: context.actor.id, actionId: action.id, executionId: claim.executionId,
      category: 'workflow_execute', summary: 'All validated local target effects were committed together; independent readback is required.',
      createdAt: this.runtime.now().toISOString(), correlationId, targetRefs: committed.map(result => result.ref) });
  }

  private async recordUncommitted(sessionId: string, claim: ClaimedExecution, stale: boolean): Promise<void> {
    await this.runtime.store.workflowTransaction(async tx => {
      const context = await this.runtime.context(tx, sessionId);
      invariant(context.actor.id === claim.action.actorId, 'WORKFLOW_NOT_FOUND', 'The execution is unavailable', 404);
      const receipt = await context.projections.get<WorkflowReceiptV2>('action_executions', claim.executionId);
      const root = await context.projections.get<WorkflowRootRow>('action_idempotency_roots', claim.rootId);
      invariant(receipt && root?.body.status === 'open' && root.body.activeExecutionId === claim.executionId, 'WORKFLOW_CONFLICT', 'The execution claim changed', 409);
      const body = workflowReceiptV2Schema.parse(receipt.body);
      if (body.outcome !== 'pending') return;
      for (const target of claim.action.targets) invariant(!(await context.projections.query({ kind: 'unique', table: 'semantic_effects',
        constraint: 'semantic_effects_key_unique', values: { semanticKey: target.semanticKey } })).length, 'WORKFLOW_CONFLICT', 'An effect exists for the failed claim', 409);
      const changed = await tx.compareAndSwap('action_executions', receipt.id, { rowVersion: receipt.rowVersion, state: 'pending' },
        { ...body, rowVersion: receipt.rowVersion + 1, outcome: stale ? 'stale' : 'failed' });
      invariant(changed.updated, 'WORKFLOW_CONFLICT', 'The receipt changed', 409);
      const pending = await this.action(tx, claim.action.id);
      if (pending.body.status === 'claimed') {
        const changedAction = await tx.compareAndSwap('pending_actions', pending.id, { rowVersion: pending.rowVersion, state: 'claimed' },
          { ...pending.body, rowVersion: pending.rowVersion + 1, status: 'stale' });
        invariant(changedAction.updated, 'WORKFLOW_CONFLICT', 'The approval changed', 409);
      }
    });
  }

  async confirm(sessionId: string, actionId: string, inputCorrelationId: string, operationContext: WorkflowOperationContext): Promise<WorkflowCommandResult> {
    const queue = this.runtime.store as object;
    const turn = (confirmationQueues.get(queue) ?? Promise.resolve()).then(() => this.confirmAdmitted(sessionId, actionId, inputCorrelationId, operationContext));
    confirmationQueues.set(queue, turn.then(() => undefined, () => undefined));
    return turn;
  }

  private async confirmAdmitted(sessionId: string, actionId: string, inputCorrelationId: string, operationContext: WorkflowOperationContext): Promise<WorkflowCommandResult> {
    const correlationId = directoryIdentitySchema.shape.id.safeParse(inputCorrelationId).success ? inputCorrelationId : this.runtime.makeId('correlation');
    let claim: ClaimedExecution | undefined, callbackFailed = false, committed = false, claimStarted = false;
    let parsedContext: WorkflowOperationContext | undefined;
    let operationPhase: 'claim' | 'effect' | 'readback' = 'claim';
    try {
      directoryIdentitySchema.shape.id.parse(actionId);
      parsedContext = freezeWorkflowValue(operationContextSchema.parse(operationContext));
      claimStarted = true;
      claim = await this.claim(sessionId, actionId, correlationId, parsedContext);
      if (!claim.fresh) {
        if (claim.winnerActionId === actionId) return this.reconcile(sessionId, claim.executionId, correlationId, parsedContext);
        const recovery = await this.recoverClaim(sessionId, actionId, correlationId, parsedContext);
        return { receipt: null, error: recovery.error, operationContext: parsedContext, claimRecovery: recovery };
      }
      operationPhase = 'effect';
      await this.runtime.store.workflowTransaction(async tx => {
        try { await this.execute(tx, await this.runtime.context(tx, sessionId), claim!, correlationId); }
        catch (error) { callbackFailed = true; throw error; }
      });
      committed = true;
      operationPhase = 'readback';
      const readback = await this.reconcile(sessionId, claim.executionId, correlationId, parsedContext);
      if (readback.error) return { receipt: null, error: failureResult(new DomainError(readback.error.code, 'Readback was not established'),
        { correlationId, actionId, executionId: claim.executionId, certainty: 'committed', effect: 'persisted', operationPhase, auditStatus: readback.error.auditStatus }), operationContext: parsedContext };
      return readback;
    } catch (error) {
      const noCommit = !claimStarted || callbackFailed || definitelyNotCommitted(error);
      if (claim && noCommit && !committed) {
        try { await this.recordUncommitted(sessionId, claim, error instanceof DomainError && /STALE|CONFLICT/.test(error.code)); } catch { /* Failure bookkeeping cannot change the established effect certainty. */ }
      }
      const unknownClaim = !claim && parsedContext && claimStarted && !noCommit && operationPhase === 'claim';
      let recovery = unknownClaim ? await this.recoverClaim(sessionId, actionId, correlationId, parsedContext!) : undefined;
      // Authorized readback may recover a reference; it cannot rewrite the failed dispatch's certainty.
      const details = { correlationId, actionId, executionId: claim?.executionId ?? (recovery?.error === null ? recovery.existingExecutionId : null),
        certainty: committed ? 'committed' as const : noCommit ? 'definitely_not_committed' as const : 'unknown' as const,
        effect: committed ? 'persisted' as const : noCommit || operationPhase === 'claim' ? 'none' as const : 'unknown' as const, operationPhase,
        ...(claim ? { targetRefs: claim.action.targets.map(target => target.ref) } : {}) };
      const recorded = await this.runtime.denialAudit(sessionId, details);
      const conflict = !claim && parsedContext && noCommit && ((error instanceof DomainError && error.code === 'WORKFLOW_CONFLICT') ||
        (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'CONFLICT'));
      if (conflict) recovery = await this.recoverClaim(sessionId, actionId, correlationId, parsedContext!);
      return { receipt: null, error: failureResult(error, { ...details, auditStatus: recorded ? 'recorded' : 'unverified' }),
        ...(parsedContext ? { operationContext: parsedContext } : {}), ...(recovery ? { claimRecovery: recovery } : {}) };
    }
  }

  async reconcile(sessionId: string, executionId: string, inputCorrelationId: string, operationContext: WorkflowOperationContext): Promise<WorkflowCommandResult> {
    const correlationId = directoryIdentitySchema.shape.id.safeParse(inputCorrelationId).success ? inputCorrelationId : this.runtime.makeId('correlation');
    let actionId: string | null = null, effectEstablished = false;
    let authorizationDenial: DomainError | undefined;
    let parsedContext: WorkflowOperationContext | undefined;
    try {
      directoryIdentitySchema.shape.id.parse(executionId);
      parsedContext = freezeWorkflowValue(operationContextSchema.parse(operationContext));
      const receipt = await this.runtime.store.workflowTransaction(async tx => {
        let authorized = false;
        try {
        const context = await this.runtime.context(tx, sessionId);
        const stored = await context.projections.get<WorkflowReceiptV2>('action_executions', executionId);
        invariant(stored, 'WORKFLOW_NOT_FOUND', 'The execution is unavailable', 404);
        const body = workflowReceiptV2Schema.parse(stored.body); actionId = body.actionId;
        const pending = await this.action(tx, body.actionId), action = pending.body;
        // Another actor may read a safe current state through preparation, never the owner's raw receipt.
        invariant(body.actorId === context.actor.id && action.actorId === context.actor.id,
          'WORKFLOW_NOT_FOUND', 'The execution is unavailable', 404);
        await this.runtime.assertEnvelope(tx, context, action, false, parsedContext);
        authorized = true;
        const binding = this.runtime.binding(action.payload.kind);
        if (body.outcome !== 'pending') {
          effectEstablished = body.outcome === 'verified_success' || body.outcome === 'already_completed';
          return workflowReceiptV2Schema.parse({ ...body, currentStates: await this.runtime.currentStates(binding, context, action.targets.map(target => target.ref)) });
        }
        const committed: CommittedTarget[] = [];
        for (const target of action.targets) {
          const row = await context.projections.get<ActionTargetRow>('action_targets', workflowActionTargetId(executionId, target.targetId));
          if (!row || row.body.targetStatus === 'pending' || row.body.targetStatus === 'failed') return body;
          const result = committedTargetSchema.parse(row.body.result);
          invariant(result.executionId === executionId && result.targetId === target.targetId && digest(result.ref) === digest(target.expectedEffectRef) &&
            result.rowVersion === target.expectedEffectVersion, 'WORKFLOW_CALLBACK_CONTRACT', 'Stored committed target facts do not match');
          committed.push(result);
        }
        effectEstablished = true;
        // Changed verification implementations cannot reinterpret an old pending execution.
        context.assertPins(action.packs);
        const postconditions = freezeWorkflowValue(capturePostconditions(action.targets, executionId,
          binding.expectedPostconditions(action, executionId, instantSchema.parse(body.createdAt))));
        await checkPostconditions(context.projections, postconditions);
        const proofs = validateProofs(committed, executionId, await binding.verify({ ...context, action, executionId }, committed));
        if (!proofs.every(proof => proof.outcome === 'verified_success')) return workflowReceiptV2Schema.parse({ ...body,
          currentStates: await this.runtime.currentStates(binding, context, action.targets.map(target => target.ref)) });
        const verified = workflowReceiptV2Schema.parse({ ...body, outcome: 'verified_success', proofs, currentStates: [], verifiedAt: this.runtime.now().toISOString() });
        const changed = await tx.compareAndSwap('action_executions', stored.id, { rowVersion: stored.rowVersion, state: 'pending' },
          { ...verified, rowVersion: stored.rowVersion + 1 });
        invariant(changed.updated, 'WORKFLOW_CONFLICT', 'The receipt changed during verification', 409);
        for (const proof of proofs) {
          const row = await context.projections.get<ActionTargetRow>('action_targets', workflowActionTargetId(executionId, proof.targetId));
          invariant(row, 'WORKFLOW_CALLBACK_CONTRACT', 'The committed target is unavailable');
          if (row.body.targetStatus === 'committed') {
            const updated = await tx.compareAndSwap('action_targets', row.id, { rowVersion: row.rowVersion, state: 'committed' },
              { ...row.body, rowVersion: row.rowVersion + 1, targetStatus: 'verified', proof });
            invariant(updated.updated, 'WORKFLOW_CONFLICT', 'The target changed during verification', 409);
          }
        }
        if (action.status === 'claimed') {
          const updated = await tx.compareAndSwap('pending_actions', pending.id, { rowVersion: pending.rowVersion, state: 'claimed' },
            { ...action, rowVersion: pending.rowVersion + 1, status: 'completed' });
          invariant(updated.updated, 'WORKFLOW_CONFLICT', 'The approval changed during verification', 409);
        }
        await writeWorkflowAudit(tx, { id: this.runtime.makeId('audit'), actorId: context.actor.id, actionId: action.id, executionId,
          category: 'workflow_verify', summary: 'Independent committed readback verified every approved target.',
          createdAt: this.runtime.now().toISOString(), correlationId, targetRefs: committed.map(target => target.ref) });
        return workflowReceiptV2Schema.parse({ ...verified, currentStates: await this.runtime.currentStates(binding, context, action.targets.map(target => target.ref)) });
        } catch (error) {
          if (!authorized && error instanceof DomainError && [401, 403, 404].includes(error.status)) authorizationDenial = error;
          throw error;
        }
      });
      return { receipt, error: null, operationContext: parsedContext };
    } catch (error) {
      const denied = authorizationDenial !== undefined && (error === authorizationDenial || definitelyNotCommitted(error));
      const details = { correlationId, actionId: denied ? null : actionId, executionId,
        certainty: denied ? 'definitely_not_committed' as const : effectEstablished ? 'committed' as const : 'unknown' as const,
        effect: denied ? 'none' as const : effectEstablished ? 'persisted' as const : 'unknown' as const, operationPhase: 'readback' as const };
      const recorded = await this.runtime.denialAudit(sessionId, details);
      return { receipt: null, error: failureResult(denied ? authorizationDenial : error, { ...details, auditStatus: recorded ? 'recorded' : 'unverified' }),
        ...(parsedContext ? { operationContext: parsedContext } : {}) };
    }
  }

  async recoverClaim(sessionId: string, actionId: string, inputCorrelationId: string, operationContext: WorkflowOperationContext): Promise<WorkflowClaimRecoveryResult> {
    const correlationId = directoryIdentitySchema.shape.id.safeParse(inputCorrelationId).success ? inputCorrelationId : this.runtime.makeId('correlation');
    let authorizationDenial: DomainError | undefined;
    try {
      directoryIdentitySchema.shape.id.parse(actionId);
      const parsedContext = freezeWorkflowValue(operationContextSchema.parse(operationContext));
      return await this.runtime.store.workflowTransaction(async tx => {
        let authorized = false;
        try {
        const context = await this.runtime.context(tx, sessionId), projection = await this.action(tx, actionId), action = projection.body;
        await this.runtime.assertEnvelope(tx, context, action, false, parsedContext);
        authorized = true;
        const roots = await context.projections.query<WorkflowRootRow>({ kind: 'unique', table: 'action_idempotency_roots',
          constraint: 'action_idempotency_roots_key_unique', values: { idempotencyKey: action.idempotencyKey } });
        invariant(roots.length <= 1, 'WORKFLOW_STALE', 'The semantic claim is ambiguous', 409);
        const confirmations = await context.projections.query<{ actionId: string; actorId: string; sessionId: string; confirmationDigest: string }>({
          kind: 'unique', table: 'action_confirmations', constraint: 'action_confirmations_action_unique', values: { actionId } });
        if (confirmations[0]) invariant(confirmations[0].body.actorId === action.actorId && confirmations[0].body.sessionId === action.sessionId &&
          confirmations[0].body.confirmationDigest === action.payloadHash, 'WORKFLOW_STALE', 'The stored confirmation does not match its approval', 409);
        const executionId = roots[0]?.body.activeExecutionId ?? null;
        if (executionId) {
          const execution = await context.projections.get('action_executions', executionId);
          invariant(execution && workflowReceiptV2Schema.parse(execution.body).kind === action.payload.kind, 'WORKFLOW_STALE', 'The winning execution is unavailable', 409);
        }
        const certainty = confirmations.length === 1 ? 'committed' as const : action.status === 'pending' ? 'definitely_not_committed' as const : 'unknown' as const;
        return { actionId, existingExecutionId: executionId, claimCommitCertainty: certainty,
          currentStates: await this.runtime.currentStates(this.runtime.binding(action.payload.kind), context, action.targets.map(target => target.ref)),
          error: null, retryBusinessWrite: false as const };
        } catch (error) {
          if (!authorized && error instanceof DomainError && [401, 403, 404].includes(error.status)) authorizationDenial = error;
          throw error;
        }
      });
    } catch (error) {
      const denied = authorizationDenial !== undefined && (error === authorizationDenial || definitelyNotCommitted(error));
      return { actionId, existingExecutionId: null, claimCommitCertainty: 'unknown', currentStates: [], retryBusinessWrite: false,
        error: failureResult(denied ? authorizationDenial : error, { correlationId, actionId, executionId: null,
          certainty: denied ? 'definitely_not_committed' : 'unknown', effect: 'none', operationPhase: 'claim' }) };
    }
  }

  /** Explicit server bookkeeping closes a proven unexecuted claim; recovery never invokes this method. */
  async closeUnexecutedClaim(sessionId: string, actionId: string, inputCorrelationId: string, operationContext: WorkflowOperationContext): Promise<WorkflowCommandResult> {
    const correlationId = directoryIdentitySchema.shape.id.safeParse(inputCorrelationId).success ? inputCorrelationId : this.runtime.makeId('correlation');
    let executionId: string | null = null, dispatched = false, effectEstablished = false;
    let parsedContext: WorkflowOperationContext | undefined, authorizationDenial: DomainError | undefined;
    try {
      directoryIdentitySchema.shape.id.parse(actionId);
      parsedContext = freezeWorkflowValue(operationContextSchema.parse(operationContext));
      dispatched = true;
      return await this.runtime.store.workflowTransaction(async tx => {
        let authorized = false;
        try {
          const context = await this.runtime.context(tx, sessionId), pending = await this.action(tx, actionId), action = pending.body;
          await this.runtime.assertEnvelope(tx, context, action, false, parsedContext);
          authorized = true;
          const roots = await context.projections.query<WorkflowRootRow>({ kind: 'unique', table: 'action_idempotency_roots',
            constraint: 'action_idempotency_roots_key_unique', values: { idempotencyKey: action.idempotencyKey } });
          const root = roots[0];
          invariant(roots.length === 1 && root.body.actionId === action.id && root.body.activeExecutionId,
            'WORKFLOW_CONFLICT', 'The original execution is no longer the active claim', 409);
          executionId = root.body.activeExecutionId;
          const stored = await context.projections.get<WorkflowReceiptV2>('action_executions', executionId);
          invariant(stored, 'WORKFLOW_STALE', 'The execution is unavailable', 409);
          const receipt = workflowReceiptV2Schema.parse(stored.body);
          invariant(receipt.id === executionId && receipt.actionId === action.id && receipt.actorId === action.actorId && receipt.kind === action.payload.kind,
            'WORKFLOW_STALE', 'The execution does not match its approval', 409);
          const confirmations = await context.projections.query<{ actionId: string; actorId: string; sessionId: string; confirmationDigest: string; confirmedAt: string }>({
            kind: 'unique', table: 'action_confirmations', constraint: 'action_confirmations_action_unique', values: { actionId } });
          invariant(confirmations.length === 1 && confirmations[0].body.actionId === action.id && confirmations[0].body.actorId === action.actorId &&
            confirmations[0].body.sessionId === action.sessionId && confirmations[0].body.confirmationDigest === action.payloadHash &&
            confirmations[0].body.confirmedAt === receipt.createdAt, 'WORKFLOW_STALE', 'The execution confirmation does not match its approval', 409);
          effectEstablished = root.body.status === 'completed' || receipt.outcome === 'verified_success' || receipt.outcome === 'already_completed';
          const currentStates = await this.runtime.currentStates(this.runtime.binding(action.payload.kind), context, action.targets.map(target => target.ref));
          if (effectEstablished) {
            return { receipt: workflowReceiptV2Schema.parse({ ...receipt, currentStates }), operationContext: parsedContext,
              error: receipt.outcome === 'pending' ? { ...failureResult(new DomainError('WORKFLOW_READBACK_PENDING', 'Committed effects require readback'),
                { correlationId, actionId, executionId, certainty: 'committed', effect: 'persisted', operationPhase: 'readback' }), currentStates } : null };
          }
          invariant(root.body.status === 'open', 'WORKFLOW_STALE', 'The semantic root is terminal', 409);
          for (const target of action.targets) {
            const effects = await context.projections.query<SemanticEffectRow>({ kind: 'unique', table: 'semantic_effects',
              constraint: 'semantic_effects_key_unique', values: { semanticKey: target.semanticKey } });
            invariant(effects.length === 0, 'WORKFLOW_CONFLICT', 'An approved semantic key already has an effect', 409);
            const targets = await context.projections.query<ActionTargetRow>({ kind: 'unique', table: 'action_targets',
              constraint: 'action_targets_execution_target_unique', values: { executionId, entityType: target.ref.table, targetId: target.targetId } });
            // Current claims have no target rows until the effect transaction; any existing row must be unexecuted.
            invariant(targets.length <= 1 && targets.every(row => row.id === workflowActionTargetId(executionId!, target.targetId) &&
              row.body.executionId === executionId && row.body.targetId === target.targetId && row.body.entityType === target.ref.table &&
              digest(row.body.ref) === digest(target.ref) && row.body.targetStatus === 'pending' &&
              !Object.hasOwn(row.body, 'result') && !Object.hasOwn(row.body, 'proof')),
            'WORKFLOW_CONFLICT', 'An execution target has effect or result evidence', 409);
          }
          const closedAuditId = `workflow_claim_close_${digest({ executionId })}`;
          const closedAudit = await context.projections.get<{ actionId?: string; executionId?: string; category: string }>('audit_events', closedAuditId);
          const noEffectResult = (failedReceipt: WorkflowReceiptV2, auditStatus: 'recorded' | 'unverified'): WorkflowCommandResult => ({
            receipt: workflowReceiptV2Schema.parse({ ...failedReceipt, currentStates }), operationContext: parsedContext,
            error: { ...failureResult(new DomainError('WORKFLOW_STALE', 'The unexecuted claim is closed'),
              { correlationId, actionId, executionId, certainty: 'definitely_not_committed', effect: 'none', auditStatus, operationPhase: 'claim' }), currentStates },
          });
          if (receipt.outcome === 'failed' && action.status === 'stale' && closedAudit?.body.actionId === action.id &&
            closedAudit.body.executionId === executionId && closedAudit.body.category === 'workflow_claim_close') return noEffectResult(receipt, 'recorded');
          invariant(receipt.outcome === 'pending' && receipt.proofs.length === 0 && receipt.verifiedAt === null && action.status === 'claimed',
            'WORKFLOW_STALE', 'The approval or receipt is no longer pending', 409);
          const stamped = await context.projections.query<WorkflowReceiptV2>({ kind: 'unique', table: 'action_executions',
            constraint: 'action_executions_root_attempt_unique', values: { rootId: root.id, attempt: root.rowVersion } });
          invariant(stamped.length === 1 && stamped[0].id === executionId && stamped[0].rowVersion === stored.rowVersion,
            'WORKFLOW_CONFLICT', 'The execution attempt stamp changed', 409);
          // This fence makes an effect transaction based on the old claim fail its final root CAS and roll back.
          const fenced = await tx.compareAndSwap('action_idempotency_roots', root.id, { rowVersion: root.rowVersion, state: 'open' },
            { ...root.body, rowVersion: root.rowVersion + 1 });
          invariant(fenced.updated, 'WORKFLOW_CONFLICT', 'The active claim changed during closure', 409);
          const failed = workflowReceiptV2Schema.parse({ ...receipt, outcome: 'failed' });
          const changedReceipt = await tx.compareAndSwap('action_executions', stored.id, { rowVersion: stored.rowVersion, state: 'pending' },
            { ...failed, rowVersion: stored.rowVersion + 1 });
          invariant(changedReceipt.updated, 'WORKFLOW_CONFLICT', 'The receipt changed during closure', 409);
          const changedAction = await tx.compareAndSwap('pending_actions', pending.id, { rowVersion: pending.rowVersion, state: 'claimed' },
            { ...action, rowVersion: pending.rowVersion + 1, status: 'stale' });
          invariant(changedAction.updated, 'WORKFLOW_CONFLICT', 'The approval changed during closure', 409);
          await writeWorkflowAudit(tx, { id: closedAuditId, actorId: context.actor.id, actionId, executionId,
            category: 'workflow_claim_close', summary: 'An unexecuted claim was closed without business effects; a fresh review is required.',
            createdAt: this.runtime.now().toISOString(), correlationId, targetRefs: action.targets.map(target => target.ref), outcome: 'failed' });
          return noEffectResult(failed, 'recorded');
        } catch (error) {
          if (!authorized && error instanceof DomainError && [401, 403, 404].includes(error.status)) authorizationDenial = error;
          throw error;
        }
      });
    } catch (error) {
      const denied = authorizationDenial !== undefined && (error === authorizationDenial || definitelyNotCommitted(error));
      // A rolled-back close proves only bookkeeping certainty; an in-flight business effect may have won the race.
      const noEffect = denied || !dispatched;
      const details = { correlationId, actionId, executionId,
        certainty: noEffect ? 'definitely_not_committed' as const : effectEstablished ? 'committed' as const : 'unknown' as const,
        effect: noEffect ? 'none' as const : effectEstablished ? 'persisted' as const : 'unknown' as const,
        operationPhase: 'claim' as const };
      const recorded = await this.runtime.denialAudit(sessionId, details);
      return { receipt: null, error: failureResult(denied ? authorizationDenial : error, { ...details, auditStatus: recorded ? 'recorded' : 'unverified' }),
        ...(parsedContext ? { operationContext: parsedContext } : {}) };
    }
  }
}

export function createWorkflowActionRunner(runtime: WorkflowActionRuntime): WorkflowActionRunner { return new WorkflowActionRunner(runtime); }
