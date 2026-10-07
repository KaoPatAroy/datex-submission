import { z, ZodError } from 'zod';
import { DomainError, invariant } from '../core/errors';
import { digest } from '../core/utils';
import type { WorkflowProjectionReader, WorkflowTransactionContext } from '../storage/workflow-projections';
import {
  committedTargetSchema, refSchema, safeWorkflowErrorSchema, targetProofSchema,
  type CommittedTarget, type Ref, type SafeWorkflowError, type TargetProof,
  type TargetSpec, type WorkflowReceiptV2,
} from './contracts';

export interface WorkflowCommandResult {
  receipt: WorkflowReceiptV2 | null;
  error: SafeWorkflowError | null;
  operationContext?: WorkflowOperationContext;
  claimRecovery?: WorkflowClaimRecoveryResult;
}
export interface WorkflowOperationContext { conversationId: string; turnId: string }
export interface WorkflowClaimRecoveryResult {
  actionId: string;
  existingExecutionId: string | null;
  claimCommitCertainty: SafeWorkflowError['commitCertainty'];
  currentStates: WorkflowReceiptV2['currentStates'];
  error: SafeWorkflowError | null;
  retryBusinessWrite: false;
}

export interface ExpectedField { path: string; expected: unknown }
export interface AttributionPostcondition { ref: Ref; rowVersion?: number; fields: readonly ExpectedField[] }
export interface ExpectedPostcondition {
  targetId: string; ref: Ref; rowVersion: number; executionId: string;
  fields: readonly ExpectedField[]; attributionRefs: readonly AttributionPostcondition[];
}
const expectedFieldSchema = z.object({ path: z.string().regex(/^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$/), expected: z.unknown() }).strict();
const postconditionSchema = committedTargetSchema.extend({ fields: z.array(expectedFieldSchema).min(1).max(100),
  attributionRefs: z.array(z.object({ ref: refSchema, rowVersion: z.number().int().positive().optional(), fields: z.array(expectedFieldSchema).min(1).max(100) }).strict()).max(100) }).strict();

export function capturePostconditions(targets: readonly TargetSpec[], executionId: string, raw: readonly ExpectedPostcondition[]): ExpectedPostcondition[] {
  const plan = z.array(postconditionSchema).parse(structuredClone(raw));
  validateCommittedTargets(targets, executionId, plan.map(({ targetId, ref, rowVersion, executionId }) => ({ targetId, ref, rowVersion, executionId })));
  for (const witness of plan) {
    invariant(witness.fields.some(field => !['id', 'rowVersion', 'executionId', 'actorId'].includes(field.path)),
      'WORKFLOW_CALLBACK_CONTRACT', 'Postconditions do not compare business fields');
    for (const field of [...witness.fields, ...witness.attributionRefs.flatMap(row => row.fields)]) {
      invariant(Object.hasOwn(field, 'expected') && field.expected !== undefined,
        'WORKFLOW_CALLBACK_CONTRACT', 'A postcondition expected value is absent');
    }
    const target = targets.find(target => target.targetId === witness.targetId)!;
    invariant(witness.fields.some(field => field.path === 'executionId' && field.expected === executionId) ||
      witness.attributionRefs.some(row => row.fields.some(field => field.path === 'executionId' && field.expected === executionId) &&
        row.fields.some(field => field.path !== 'executionId' && (field.expected === target.ref.id || field.expected === witness.ref.id))),
    'WORKFLOW_CALLBACK_CONTRACT', 'Postconditions do not link the business effect to its execution');
  }
  return plan;
}

function atPath(body: unknown, path: string): unknown {
  let value = body;
  for (const key of path.split('.')) {
    if (typeof value !== 'object' || value === null || !Object.hasOwn(value, key)) return undefined;
    value = Reflect.get(value, key);
  }
  return value;
}
export async function checkPostconditions(reader: WorkflowProjectionReader, plan: readonly ExpectedPostcondition[]): Promise<void> {
  for (const witness of plan) for (const expected of [witness, ...witness.attributionRefs]) {
    const row = await reader.get<Record<string, unknown>>(expected.ref.table, expected.ref.id);
    invariant(row && row.body.id === expected.ref.id && (expected.rowVersion === undefined || row.rowVersion === expected.rowVersion),
      'WORKFLOW_CALLBACK_CONTRACT', 'A postcondition reference or version did not match');
    for (const field of expected.fields) invariant(digest(atPath(row.body, field.path)) === digest(field.expected),
      'WORKFLOW_CALLBACK_CONTRACT', 'A persisted approved field or attribution did not match');
  }
}

export class WorkflowOperationError extends DomainError {
  constructor(readonly details: SafeWorkflowError) {
    super(details.code, details.message, details.outcome === 'denied' ? 403 : details.outcome === 'stale' ? 409 : 503);
    this.name = 'WorkflowOperationError';
  }
}

export function definitelyNotCommitted(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    Reflect.get(error, 'definitelyNotCommitted') === true;
}

export function failureResult(error: unknown, context: {
  correlationId: string; actionId: string | null; executionId: string | null;
  certainty: SafeWorkflowError['commitCertainty'];
  effect: SafeWorkflowError['domainEffect']; auditStatus?: SafeWorkflowError['auditStatus'];
  operationPhase?: SafeWorkflowError['operationPhase'];
}): SafeWorkflowError {
  const rawCode = error instanceof DomainError ? error.code : error instanceof ZodError ? 'WORKFLOW_INVALID_INPUT' : 'WORKFLOW_FAILED';
  const code = rawCode === 'TRANSPORT_OUTCOME_UNKNOWN' && context.certainty !== 'unknown' ? 'WORKFLOW_READBACK_PENDING' :
    /^[A-Za-z0-9_.:-]{1,160}$/.test(rawCode) ? rawCode : 'WORKFLOW_FAILED';
  const stale = /STALE|EXPIRED|CONFLICT/.test(code);
  const denied = error instanceof DomainError && (error.status === 401 || error.status === 403 || error.status === 404);
  const outcome = context.certainty === 'unknown' || context.effect === 'persisted' ? 'pending' : stale ? 'stale' : denied ? 'denied' : 'failed';
  const message = outcome === 'pending' ? 'Read the existing operation to establish its result. Business writes will not be replayed.' :
    outcome === 'stale' ? 'The reviewed information changed. Prepare a fresh review.' :
      outcome === 'denied' ? 'Current authority does not permit this operation.' : 'The operation could not be completed.';
  return safeWorkflowErrorSchema.parse({
    code, outcome, message, correlationId: context.correlationId, actionId: context.actionId,
    executionId: context.executionId, commitCertainty: context.certainty, domainEffect: context.effect,
    ...(context.operationPhase ? { operationPhase: context.operationPhase } : {}),
    auditStatus: context.auditStatus ?? 'unverified',
    nextStep: outcome === 'pending' ? 'readback_existing' : outcome === 'stale' ? 'refresh_review' : outcome === 'denied' ? 'none' : 'correct_input',
    retryBusinessWrite: false, reasons: [{ code, targetId: null, message }], currentStates: [],
  });
}

export async function writeWorkflowAudit(tx: WorkflowTransactionContext, input: {
  id: string; actorId: string; category: string; summary: string; createdAt: string;
  correlationId: string; actionId?: string; executionId?: string; targetRefs?: Ref[]; outcome?: string;
}): Promise<void> {
  const row = { ...input, ...(input.targetRefs ? { targetRefs: input.targetRefs.map(ref => refSchema.parse(ref)) } : {}) };
  const result = await tx.insertUnique('audit_events', row, { constraint: 'audit_events_primary_key', values: { id: row.id } });
  invariant(result.inserted || digest(result.existing) === digest(row), 'WORKFLOW_CONFLICT', 'An audit identity was reused', 409);
}

export function validateCommittedTargets(targets: readonly TargetSpec[], executionId: string, raw: unknown): CommittedTarget[] {
  invariant(Array.isArray(raw), 'WORKFLOW_CALLBACK_CONTRACT', 'The callback did not return target facts');
  const committed = raw.map(value => committedTargetSchema.parse(value));
  invariant(committed.length === targets.length, 'WORKFLOW_CALLBACK_CONTRACT', 'The callback target count did not match');
  const expected = new Map(targets.map(target => [target.targetId, target]));
  const seen = new Set<string>();
  for (const result of committed) {
    const target = expected.get(result.targetId);
    invariant(target && !seen.has(result.targetId), 'WORKFLOW_CALLBACK_CONTRACT', 'The callback returned an unknown or repeated target');
    invariant(result.executionId === executionId && digest(result.ref) === digest(target.expectedEffectRef) &&
      result.rowVersion === target.expectedEffectVersion, 'WORKFLOW_CALLBACK_CONTRACT', 'The callback effect reference or version did not match');
    seen.add(result.targetId);
  }
  return committed;
}

export function validateProofs(committed: readonly CommittedTarget[], executionId: string, raw: unknown): TargetProof[] {
  invariant(Array.isArray(raw), 'WORKFLOW_CALLBACK_CONTRACT', 'Verification did not return target facts');
  const proofs = raw.map(value => targetProofSchema.parse(value));
  invariant(proofs.length === committed.length, 'WORKFLOW_CALLBACK_CONTRACT', 'Verification target count did not match');
  const expected = new Map(committed.map(target => [target.targetId, target]));
  const seen = new Set<string>();
  for (const proof of proofs) {
    const target = expected.get(proof.targetId);
    invariant(target && !seen.has(proof.targetId) && proof.executionId === executionId && digest(proof.ref) === digest(target.ref),
      'WORKFLOW_CALLBACK_CONTRACT', 'Verification identity did not match');
    if (proof.outcome === 'verified_success') invariant(proof.observedRowVersion === target.rowVersion,
      'WORKFLOW_CALLBACK_CONTRACT', 'Verification version did not match the committed effect');
    seen.add(proof.targetId);
  }
  return proofs;
}
