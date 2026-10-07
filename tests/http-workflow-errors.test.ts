import { describe, expect, it } from 'vitest';
import { DomainError } from '../lib/core/errors';
import { failure } from '../lib/server/http';
import { safeWorkflowErrorSchema, type SafeWorkflowError } from '../lib/workflows/contracts';

const unknownClaim = {
  code: 'WORKFLOW_READBACK_PENDING',
  outcome: 'pending',
  message: 'Read the existing operation to establish its result.',
  correlationId: 'correlation-claim-01',
  actionId: 'action-claim-01',
  executionId: null,
  commitCertainty: 'unknown',
  domainEffect: 'none',
  operationPhase: 'claim',
  auditStatus: 'unverified',
  nextStep: 'readback_existing',
  retryBusinessWrite: false,
  reasons: [],
  currentStates: [],
} satisfies SafeWorkflowError;

const legacyV2Failure = {
  code: 'WORKFLOW_INVALID_INPUT',
  outcome: 'failed',
  message: 'The operation could not be completed.',
  correlationId: 'correlation-legacy-01',
  actionId: null,
  executionId: null,
  commitCertainty: 'definitely_not_committed',
  domainEffect: 'none',
  auditStatus: 'unverified',
  nextStep: 'correct_input',
  retryBusinessWrite: false,
  reasons: [{ code: 'WORKFLOW_INVALID_INPUT', targetId: null, message: 'The operation could not be completed.' }],
  currentStates: [],
} satisfies SafeWorkflowError;

class WorkflowOperationError extends DomainError {
  constructor(readonly details: SafeWorkflowError) {
    super(details.code, details.message, details.outcome === 'denied' ? 403 : details.outcome === 'stale' ? 409 : 503);
    this.name = 'WorkflowOperationError';
  }
}

describe('workflow HTTP errors', () => {
  it('allows unknown claim outcomes to state no domain effect only with the claim phase', () => {
    expect(safeWorkflowErrorSchema.parse(unknownClaim)).toEqual(unknownClaim);
    expect(safeWorkflowErrorSchema.safeParse({ ...unknownClaim, operationPhase: undefined }).success).toBe(false);
    expect(safeWorkflowErrorSchema.safeParse({ ...unknownClaim, operationPhase: 'effect' }).success).toBe(false);
  });

  it('preserves a validated unknown-claim phase in the HTTP response', async () => {
    const response = failure(new WorkflowOperationError(safeWorkflowErrorSchema.parse(unknownClaim)));

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toEqual(unknownClaim);
    expect(body.error).not.toHaveProperty('stack');
  });

  it('preserves valid legacy V2 details when operationPhase is absent', async () => {
    const details = safeWorkflowErrorSchema.parse(legacyV2Failure);
    const response = failure(new WorkflowOperationError(details));

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toEqual(legacyV2Failure);
    expect(body.error).not.toHaveProperty('operationPhase');
  });

  it('keeps the V1 DomainError response unchanged', async () => {
    const response = failure(new DomainError('LEGACY_ERROR', 'Legacy safe message', 409));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'LEGACY_ERROR', message: 'Legacy safe message' },
    });
  });
});
