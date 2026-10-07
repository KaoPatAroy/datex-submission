import { describe, expect, it } from 'vitest';
import { digest } from '../lib/core/utils';
import {
  pendingActionV2Schema,
  safeWorkflowErrorSchema,
  workflowReceiptV2Schema,
  type PendingActionV2,
  type SafeWorkflowError,
} from '../lib/workflows/contracts';
import { getDemoWorkflowPolicyV1Pin } from '../lib/workflows/policy';
import {
  workflowActionRequestV2Schema,
  workflowActionResponseV2Schema,
  workflowActionViewV2Schema,
  workflowChatRequestV2Schema,
  workflowChatResponseV2Schema,
  workflowClaimRecoveryResultSchema,
  workflowSuggestionsResponseV2Schema,
  workflowPublicActionV2Schema,
  type WorkflowPublicActionV2,
} from '../lib/workflows/api-contracts';

const CONVERSATION_ID = 'api-contract-conversation';
const TURN_ID = 'api-contract-turn';
const ASSISTANT_MESSAGE_ID = 'api-contract-assistant-message';
const ACTION_ID = 'api-contract-action';
const ACTOR_ID = 'api-contract-actor';
const SESSION_ID = 'api-contract-session';
const EXECUTION_ID = 'api-contract-execution';
const CREATED_AT = '2026-10-04T04:00:00.000Z';
const PUBLIC_ACTION_FIELDS = [
  'id',
  'contractVersion',
  'conversationId',
  'turnId',
  'mode',
  'payload',
  'targets',
  'targetCount',
  'approvedBranchIds',
  'approvedOrgUnitIds',
  'reviewedSnapshotId',
  'executionMode',
  'createdAt',
  'expiresAt',
  'status',
];

function pendingAction(overrides: Partial<PendingActionV2> = {}): PendingActionV2 {
  const payload = {
    kind: 'policy_acknowledgement_assign' as const,
    policyDocumentId: 'api-contract-policy-document',
    policyVersion: 'r1',
    targets: [{
      employeeId: 'api-contract-employee',
      ownerIdentityId: 'api-contract-owner',
      reason: 'Review the current policy.',
      dueDate: '2026-10-10',
      priority: 'normal' as const,
    }],
  };
  const semanticKey = digest({
    kind: payload.kind,
    employeeId: payload.targets[0].employeeId,
    ownerIdentityId: payload.targets[0].ownerIdentityId,
  });
  return pendingActionV2Schema.parse({
    id: ACTION_ID,
    contractVersion: 2,
    actorId: ACTOR_ID,
    sessionId: SESSION_ID,
    conversationId: CONVERSATION_ID,
    turnId: TURN_ID,
    mode: 'live_ai',
    modeRevision: 0,
    payload,
    payloadHash: digest('api-contract-approval-hash'),
    idempotencyKey: digest('api-contract-idempotency-key'),
    targets: [{
      targetId: 'api-contract-target',
      ref: { table: 'employees', id: payload.targets[0].employeeId },
      semanticKey,
      expectedRows: [],
      ownerIdentityId: payload.targets[0].ownerIdentityId,
      expectedEffectRef: { table: 'policy_acknowledgement_tasks', id: 'api-contract-effect' },
      expectedEffectVersion: 1,
    }],
    targetCount: 1,
    expectedRows: [],
    approvedBranchIds: [],
    approvedOrgUnitIds: ['api-contract-org'],
    reviewedSnapshotId: null,
    policy: getDemoWorkflowPolicyV1Pin(),
    packs: [{
      id: 'api-contract-pack',
      version: '1.0',
      schemaDigest: 'a'.repeat(64),
      implementationRevision: 'api-contract-test-r1',
    }],
    releaseRevision: 'api-contract-release-r1',
    executionMode: 'atomic_local',
    createdAt: CREATED_AT,
    expiresAt: '2026-10-04T04:10:00.000Z',
    status: 'pending',
    ...overrides,
  });
}

function publicAction(action: PendingActionV2): WorkflowPublicActionV2 {
  return {
    id: action.id,
    contractVersion: action.contractVersion,
    conversationId: action.conversationId,
    turnId: action.turnId,
    mode: action.mode,
    payload: action.payload,
    targets: action.targets.map(({ targetId, ref, ownerIdentityId, expectedEffectRef }) => ({
      targetId,
      ref,
      ownerIdentityId,
      expectedEffectRef,
    })),
    targetCount: action.targetCount,
    approvedBranchIds: action.approvedBranchIds,
    approvedOrgUnitIds: action.approvedOrgUnitIds,
    reviewedSnapshotId: action.reviewedSnapshotId,
    executionMode: action.executionMode,
    createdAt: action.createdAt,
    expiresAt: action.expiresAt,
    status: action.status,
  };
}

function preparation(action: WorkflowPublicActionV2) {
  return {
    outcome: 'pending' as const,
    pendingAction: action,
    existingExecutionId: null,
    currentStates: [],
    reasons: [],
  };
}

function receipt(action: PendingActionV2) {
  return workflowReceiptV2Schema.parse({
    id: 'api-contract-receipt',
    actionId: action.id,
    contractVersion: 2,
    actorId: action.actorId,
    kind: action.payload.kind,
    outcome: 'failed',
    proofs: [],
    createdAt: CREATED_AT,
    verifiedAt: null,
    currentStates: [],
  });
}

function chatResponse(action: PendingActionV2) {
  return {
    conversationId: CONVERSATION_ID,
    turnId: TURN_ID,
    assistantMessageId: ASSISTANT_MESSAGE_ID,
    actionContractVersion: 2,
    contractVersion: 2,
    replayed: false,
    mode: action.mode,
    message: 'I prepared the reviewed proposal.',
    pendingActionIds: [action.id],
    preparations: [preparation(publicAction(action))],
    receipts: [receipt(action)],
  };
}

function uncertainError(actionId: string | null, executionId: string | null): SafeWorkflowError {
  return safeWorkflowErrorSchema.parse({
    code: 'STORAGE',
    outcome: 'pending',
    message: 'The write result is not verified yet.',
    correlationId: 'api-contract-correlation',
    actionId,
    executionId,
    commitCertainty: 'unknown',
    domainEffect: 'unknown',
    operationPhase: 'effect',
    auditStatus: 'unverified',
    nextStep: 'readback_existing',
    retryBusinessWrite: false,
    reasons: [],
    currentStates: [],
  });
}

describe('workflow API wire contracts', () => {
  it('requires separate V2 action and replay versions on strict request bodies', () => {
    const chatRequest = {
      actionContractVersion: 2,
      contractVersion: 2,
      requestKey: 'request-key-123456',
      message: 'Review the current policy.',
      conversationId: CONVERSATION_ID,
    };
    expect(workflowChatRequestV2Schema.parse(chatRequest)).toEqual(chatRequest);

    expect(workflowChatRequestV2Schema.safeParse({
      ...chatRequest,
      contractVersion: 1,
    }).success).toBe(false);
    expect(workflowChatRequestV2Schema.safeParse({
      contractVersion: 2,
      requestKey: chatRequest.requestKey,
      message: chatRequest.message,
    }).success).toBe(false);
    expect(workflowChatRequestV2Schema.safeParse({
      ...chatRequest,
      actionContractVersion: 1,
    }).success).toBe(false);
    expect(workflowChatRequestV2Schema.safeParse({
      ...chatRequest,
      requestKey: 'too-short',
    }).success).toBe(false);
    expect(workflowChatRequestV2Schema.safeParse({
      ...chatRequest,
      conversationId: 'invalid conversation id',
    }).success).toBe(false);
    expect(workflowChatRequestV2Schema.safeParse({
      ...chatRequest,
      actionId: ACTION_ID,
    }).success).toBe(false);

    const actionRequest = {
      actionContractVersion: 2,
      conversationId: CONVERSATION_ID,
      turnId: TURN_ID,
      assistantMessageId: ASSISTANT_MESSAGE_ID,
    };
    expect(workflowActionRequestV2Schema.parse(actionRequest)).toEqual(actionRequest);
    expect(workflowActionRequestV2Schema.safeParse({ ...actionRequest, contractVersion: 2 }).success).toBe(false);
    expect(workflowActionRequestV2Schema.safeParse({ ...actionRequest, actionId: ACTION_ID }).success).toBe(false);
    expect(workflowActionRequestV2Schema.safeParse({ ...actionRequest, turnId: 'invalid turn id' }).success).toBe(false);
  });

  it('anchors prepared action IDs and receipts to the response conversation and assistant turn', () => {
    const action = pendingAction();
    const response = chatResponse(action);
    const parsed = workflowChatResponseV2Schema.parse(response);
    const reviewedAction = publicAction(action);
    expect(parsed).toEqual(response);
    expect(parsed.preparations[0].pendingAction).toEqual(reviewedAction);
    expect(Object.keys(parsed.preparations[0].pendingAction!).sort()).toEqual([...PUBLIC_ACTION_FIELDS].sort());
    expect(parsed.preparations[0].pendingAction?.payload).toEqual(action.payload);
    expect(parsed.preparations[0].pendingAction?.targets[0]).toMatchObject({
      targetId: action.targets[0].targetId,
      ref: { table: 'employees', id: action.targets[0].ref.id },
      ownerIdentityId: action.targets[0].ownerIdentityId,
      expectedEffectRef: action.targets[0].expectedEffectRef,
    });
    expect(Object.keys(parsed.preparations[0].pendingAction!.targets[0]).sort()).toEqual([
      'expectedEffectRef', 'ownerIdentityId', 'ref', 'targetId',
    ]);
    for (const internalField of [
      'actorId', 'sessionId', 'modeRevision', 'payloadHash', 'idempotencyKey', 'expectedRows',
      'policy', 'packs', 'releaseRevision',
    ]) {
      expect(parsed.preparations[0].pendingAction).not.toHaveProperty(internalField);
    }

    expect(workflowPublicActionV2Schema.safeParse(action).success).toBe(false);
    const nestedInternalTargetLeak = structuredClone(reviewedAction) as unknown as {
      targets: Array<Record<string, unknown>>;
    };
    Object.assign(nestedInternalTargetLeak.targets[0], {
      semanticKey: action.targets[0].semanticKey,
      expectedRows: action.targets[0].expectedRows,
      expectedEffectVersion: action.targets[0].expectedEffectVersion,
    });
    expect(workflowPublicActionV2Schema.safeParse(nestedInternalTargetLeak).success).toBe(false);
    expect(workflowChatResponseV2Schema.safeParse({
      ...response,
      preparations: [{ ...response.preparations[0], pendingAction: action }],
    }).success).toBe(false);

    const sessionLeakInBusinessTarget = structuredClone(reviewedAction) as unknown as {
      payload: { targets: Array<Record<string, unknown>> };
    };
    sessionLeakInBusinessTarget.payload.targets[0].sessionId = SESSION_ID;
    expect(workflowPublicActionV2Schema.safeParse(sessionLeakInBusinessTarget).success).toBe(false);

    const sessionLeakInReviewedTarget = structuredClone(reviewedAction) as unknown as {
      targets: Array<Record<string, unknown>>;
    };
    sessionLeakInReviewedTarget.targets[0].sessionId = SESSION_ID;
    expect(workflowPublicActionV2Schema.safeParse(sessionLeakInReviewedTarget).success).toBe(false);

    expect(workflowChatResponseV2Schema.safeParse({
      ...response,
      preparations: [{
        ...preparation({ ...action, conversationId: 'another-conversation' }),
      }],
    }).success).toBe(false);
    expect(workflowChatResponseV2Schema.safeParse({
      ...response,
      preparations: [{
        ...preparation({ ...action, turnId: 'another-turn' }),
      }],
    }).success).toBe(false);
    expect(workflowChatResponseV2Schema.safeParse({ ...response, pendingActionIds: [] }).success).toBe(false);
    expect(workflowChatResponseV2Schema.safeParse({
      ...response,
      pendingActionIds: ['api-contract-orphan-action'],
    }).success).toBe(false);
    expect(workflowChatResponseV2Schema.safeParse({
      ...response,
      receipts: [{ ...receipt(action), actionId: 'api-contract-other-action' }],
    }).success).toBe(false);
    expect(workflowChatResponseV2Schema.safeParse({
      ...response,
      preparations: [{
        ...preparation(action),
        existingExecutionId: 'api-contract-existing-execution',
      }],
    }).success).toBe(false);
  });

  it('requires exclusive receipt/error outcomes and read-only unknown-commit recovery', () => {
    const action = pendingAction();
    const validReceipt = receipt(action);
    const responseBase = {
      conversationId: CONVERSATION_ID,
      turnId: TURN_ID,
      assistantMessageId: ASSISTANT_MESSAGE_ID,
      actionContractVersion: 2 as const,
      actionId: action.id,
    };
    const committed = { ...responseBase, receipt: validReceipt, error: null };
    expect(workflowActionResponseV2Schema.parse(committed)).toEqual(committed);
    expect(workflowActionResponseV2Schema.safeParse({
      ...committed,
      receipt: { ...validReceipt, actionId: 'api-contract-other-action' },
    }).success).toBe(false);
    expect(workflowActionResponseV2Schema.safeParse({
      ...committed,
      error: uncertainError(action.id, EXECUTION_ID),
    }).success).toBe(false);

    const unknown = uncertainError(action.id, EXECUTION_ID);
    const pending = { ...responseBase, receipt: null, error: unknown };
    expect(workflowActionResponseV2Schema.parse(pending)).toEqual(pending);
    expect(safeWorkflowErrorSchema.safeParse({ ...unknown, nextStep: 'none' }).success).toBe(false);
    expect(safeWorkflowErrorSchema.safeParse({ ...unknown, retryBusinessWrite: true }).success).toBe(false);
    expect(safeWorkflowErrorSchema.safeParse({ ...unknown, actionId: null, executionId: null }).success).toBe(false);

    const recovery = {
      actionId: action.id,
      existingExecutionId: EXECUTION_ID,
      claimCommitCertainty: 'committed' as const,
      currentStates: [],
      error: null,
      retryBusinessWrite: false as const,
    };
    expect(workflowClaimRecoveryResultSchema.parse(recovery)).toEqual(recovery);
    const recoveredResponse = { ...responseBase, receipt: null, error: null, claimRecovery: recovery };
    expect(workflowActionResponseV2Schema.parse(recoveredResponse)).toEqual(recoveredResponse);
    expect(workflowActionResponseV2Schema.safeParse({
      ...recoveredResponse,
      claimRecovery: { ...recovery, actionId: 'api-contract-other-action' },
    }).success).toBe(false);

    const failedRecovery = {
      actionId: action.id,
      existingExecutionId: null,
      claimCommitCertainty: 'definitely_not_committed' as const,
      currentStates: [],
      error: {
        code: 'WORKFLOW_STALE',
        outcome: 'stale' as const,
        message: 'The claim was rejected before a write.',
        correlationId: 'api-contract-correlation',
        actionId: action.id,
        executionId: null,
        commitCertainty: 'definitely_not_committed' as const,
        domainEffect: 'none' as const,
        auditStatus: 'unverified' as const,
        nextStep: 'refresh_review' as const,
        retryBusinessWrite: false as const,
        reasons: [],
        currentStates: [],
      },
      retryBusinessWrite: false as const,
    };
    expect(workflowClaimRecoveryResultSchema.parse(failedRecovery)).toEqual(failedRecovery);
    expect(workflowActionResponseV2Schema.safeParse({
      ...committed,
      claimRecovery: failedRecovery,
    }).success).toBe(false);

    const matchingRecovery = { ...recovery, existingExecutionId: validReceipt.id };
    const receiptWithRecovery = { ...committed, claimRecovery: matchingRecovery };
    expect(workflowActionResponseV2Schema.parse(receiptWithRecovery)).toEqual(receiptWithRecovery);
    expect(workflowActionResponseV2Schema.safeParse({
      ...receiptWithRecovery,
      claimRecovery: { ...matchingRecovery, existingExecutionId: 'api-contract-other-execution' },
    }).success).toBe(false);

    const uncertainRecovery = {
      ...recovery,
      claimCommitCertainty: 'unknown' as const,
      error: unknown,
    };
    expect(workflowClaimRecoveryResultSchema.parse(uncertainRecovery)).toEqual(uncertainRecovery);
    expect(workflowClaimRecoveryResultSchema.safeParse({ ...recovery, retryBusinessWrite: true }).success).toBe(false);
  });

  it('allows only the pending-to-stale display overlay and serializes suggestions as ID plus prompt', () => {
    const action = pendingAction();
    const reviewedAction = publicAction(action);
    const view = {
      conversationId: CONVERSATION_ID,
      turnId: TURN_ID,
      assistantMessageId: ASSISTANT_MESSAGE_ID,
      actionContractVersion: 2,
      action: reviewedAction,
      displayStatus: 'pending' as const,
    };
    const parsedView = workflowActionViewV2Schema.parse(view);
    expect(parsedView).toEqual(view);
    expect(parsedView.action.targets[0].ref).toEqual(action.targets[0].ref);
    expect(parsedView.action.targets[0].expectedEffectRef).toEqual(action.targets[0].expectedEffectRef);
    expect(workflowActionViewV2Schema.safeParse({ ...view, action }).success).toBe(false);
    const staleOverlay = { ...view, displayStatus: 'stale' as const };
    expect(workflowActionViewV2Schema.parse(staleOverlay)).toEqual(staleOverlay);
    expect(workflowActionViewV2Schema.safeParse({ ...view, displayStatus: 'completed' }).success).toBe(false);
    expect(workflowActionViewV2Schema.safeParse({
      ...view,
      action: publicAction({ ...action, status: 'stale' }),
      displayStatus: 'pending',
    }).success).toBe(false);
    expect(workflowActionViewV2Schema.safeParse({ ...view, turnId: 'another-turn' }).success).toBe(false);

    const suggestions = {
      actionContractVersion: 2,
      suggestions: [
        { id: 'suggestion-session-01', prompt: 'Review the current policy.' },
        { id: 'suggestion-session-02', prompt: 'Show pending approvals.' },
      ],
    };
    const parsed = workflowSuggestionsResponseV2Schema.parse(suggestions);
    expect(parsed).toEqual(suggestions);
    expect(Object.keys(parsed.suggestions[0]).sort()).toEqual(['id', 'prompt']);
    expect(workflowSuggestionsResponseV2Schema.safeParse({
      ...suggestions,
      suggestions: [{ id: 'suggestion-session-01', prompt: 'Review it.', actionId: ACTION_ID }],
    }).success).toBe(false);
    expect(workflowSuggestionsResponseV2Schema.safeParse({
      ...suggestions,
      suggestions: [suggestions.suggestions[0], { ...suggestions.suggestions[0], prompt: 'Another prompt.' }],
    }).success).toBe(false);
    expect(workflowSuggestionsResponseV2Schema.safeParse({
      ...suggestions,
      suggestions: Array.from({ length: 7 }, (_, index) => ({ id: `suggestion-session-${index}`, prompt: 'Review it.' })),
    }).success).toBe(false);
  });
});
