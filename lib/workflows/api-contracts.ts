import { z } from 'zod';
import type { WorkflowClaimRecoveryResult } from './action-results';
import {
  conversationMetadataSchema,
  directoryIdentitySchema,
  entityStateSchema,
  MAX_WORKFLOW_TARGETS,
  pendingActionV2Schema,
  persistedConversationMessageSchema,
  preparationResultSchema,
  safeWorkflowErrorSchema,
  targetSpecSchema,
  workflowReceiptV2Schema,
} from './contracts';

const identifier = directoryIdentitySchema.shape.id;
const messageFields = persistedConversationMessageSchema.shape;

/** Wire validation cannot establish persistence or authorization; the service verifies both. */
export const workflowTurnRefsV2Schema = z.object({
  conversationId: identifier,
  turnId: identifier,
  assistantMessageId: identifier,
}).strict();
export type WorkflowTurnRefsV2 = z.infer<typeof workflowTurnRefsV2Schema>;

/** Action version and chat replay version are independent protocol discriminants. */
export const workflowChatRequestV2Schema = z.object({
  actionContractVersion: z.literal(2),
  contractVersion: z.literal(2),
  requestKey: z.string().regex(/^[A-Za-z0-9_-]{16,120}$/),
  message: z.string().min(1).max(8_000).refine(value => value.trim().length > 0, 'The message cannot be blank'),
  conversationId: identifier.optional(),
}).strict();
export type WorkflowChatRequestV2 = z.infer<typeof workflowChatRequestV2Schema>;

export const workflowClaimRecoveryResultSchema: z.ZodType<WorkflowClaimRecoveryResult> = z.object({
  actionId: identifier,
  existingExecutionId: identifier.nullable(),
  claimCommitCertainty: safeWorkflowErrorSchema.shape.commitCertainty,
  currentStates: z.array(entityStateSchema).max(500),
  error: safeWorkflowErrorSchema.nullable(),
  retryBusinessWrite: z.literal(false),
}).strict().superRefine((recovery, context) => {
  if (recovery.error?.actionId !== undefined && recovery.error.actionId !== null &&
      recovery.error.actionId !== recovery.actionId) {
    context.addIssue({ code: 'custom', path: ['error', 'actionId'], message: 'Recovery error belongs to another action' });
  }
  if (recovery.error?.executionId !== undefined && recovery.error.executionId !== null &&
      recovery.existingExecutionId !== null && recovery.error.executionId !== recovery.existingExecutionId) {
    context.addIssue({ code: 'custom', path: ['error', 'executionId'], message: 'Recovery execution references conflict' });
  }
});
export type WorkflowClaimRecoveryResultV2 = z.infer<typeof workflowClaimRecoveryResultSchema>;

/** Reviewed business details only; storage identity, hashes, and internal pins stay server-side. */
export const workflowPublicTargetV2Schema = z.object({
  targetId: targetSpecSchema.shape.targetId,
  ref: targetSpecSchema.shape.ref,
  ownerIdentityId: targetSpecSchema.shape.ownerIdentityId,
  expectedEffectRef: targetSpecSchema.shape.expectedEffectRef,
}).strict();
export type WorkflowPublicTargetV2 = z.infer<typeof workflowPublicTargetV2Schema>;

export const workflowPublicActionV2Schema = z.object({
  id: pendingActionV2Schema.shape.id,
  contractVersion: pendingActionV2Schema.shape.contractVersion,
  conversationId: pendingActionV2Schema.shape.conversationId,
  turnId: pendingActionV2Schema.shape.turnId,
  mode: pendingActionV2Schema.shape.mode,
  payload: pendingActionV2Schema.shape.payload,
  targets: z.array(workflowPublicTargetV2Schema).min(1).max(MAX_WORKFLOW_TARGETS),
  targetCount: pendingActionV2Schema.shape.targetCount,
  approvedBranchIds: pendingActionV2Schema.shape.approvedBranchIds,
  approvedOrgUnitIds: pendingActionV2Schema.shape.approvedOrgUnitIds,
  reviewedSnapshotId: pendingActionV2Schema.shape.reviewedSnapshotId,
  executionMode: pendingActionV2Schema.shape.executionMode,
  createdAt: pendingActionV2Schema.shape.createdAt,
  expiresAt: pendingActionV2Schema.shape.expiresAt,
  status: pendingActionV2Schema.shape.status,
}).strict().superRefine((action, context) => {
  if (action.targetCount !== action.targets.length) {
    context.addIssue({ code: 'custom', path: ['targetCount'], message: 'Target count must equal the reviewed targets' });
  }
});
export type WorkflowPublicActionV2 = z.infer<typeof workflowPublicActionV2Schema>;

export const workflowPreparationResultV2Schema = z.object({
  outcome: preparationResultSchema.shape.outcome,
  pendingAction: workflowPublicActionV2Schema.nullable(),
  existingExecutionId: preparationResultSchema.shape.existingExecutionId,
  currentStates: preparationResultSchema.shape.currentStates,
  reasons: preparationResultSchema.shape.reasons,
}).strict();
export type WorkflowPreparationResultV2 = z.infer<typeof workflowPreparationResultV2Schema>;

export const workflowChatResponseV2Schema = z.object({
  ...workflowTurnRefsV2Schema.shape,
  actionContractVersion: z.literal(2),
  contractVersion: z.literal(2),
  replayed: z.boolean(),
  mode: messageFields.mode,
  message: messageFields.text.min(1),
  pendingActionIds: messageFields.pendingActionIds.unwrap(),
  preparations: z.array(workflowPreparationResultV2Schema).max(MAX_WORKFLOW_TARGETS),
  receipts: z.array(workflowReceiptV2Schema).max(MAX_WORKFLOW_TARGETS).optional(),
  analysis: messageFields.analysis,
  evidence: messageFields.evidence,
  sources: messageFields.sources,
  clarification: z.boolean().optional(),
}).strict().superRefine((response, context) => {
  const actionIds = new Set(response.pendingActionIds);
  const actions = new Map<string, WorkflowPublicActionV2>();
  for (const [index, preparation] of response.preparations.entries()) {
    const action = preparation.pendingAction;
    if (!action) continue;
    if (actions.has(action.id)) {
      context.addIssue({ code: 'custom', path: ['preparations', index, 'pendingAction', 'id'], message: 'Prepared action references repeat' });
    }
    actions.set(action.id, action);
    if (!actionIds.has(action.id) || action.conversationId !== response.conversationId || action.turnId !== response.turnId ||
        action.mode !== response.mode) {
      context.addIssue({ code: 'custom', path: ['preparations', index, 'pendingAction'], message: 'Prepared action does not match the anchored turn' });
    }
    if (preparation.outcome !== 'pending' || preparation.existingExecutionId !== null) {
      context.addIssue({ code: 'custom', path: ['preparations', index], message: 'A prepared review cannot also claim an existing execution outcome' });
    }
  }
  for (const [index, actionId] of response.pendingActionIds.entries()) {
    if (!actions.has(actionId)) {
      context.addIssue({ code: 'custom', path: ['pendingActionIds', index], message: 'The anchored action has no prepared envelope' });
    }
  }
  // Actor/session equality is checked against persisted envelopes before projection.
  const receiptIds = new Set<string>();
  for (const [index, receipt] of (response.receipts ?? []).entries()) {
    const action = actions.get(receipt.actionId);
    if (receiptIds.has(receipt.id)) {
      context.addIssue({ code: 'custom', path: ['receipts', index, 'id'], message: 'Receipt references repeat' });
    }
    receiptIds.add(receipt.id);
    if (!action || receipt.kind !== action.payload.kind) {
      context.addIssue({ code: 'custom', path: ['receipts', index], message: 'Receipt does not belong to an anchored action' });
    }
  }
});
export type WorkflowChatResponseV2 = z.infer<typeof workflowChatResponseV2Schema>;

/** The action ID comes from the URL; clients supply references, never an executable payload. */
export const workflowActionRequestV2Schema = z.object({
  ...workflowTurnRefsV2Schema.shape,
  actionContractVersion: z.literal(2),
}).strict();
export type WorkflowActionRequestV2 = z.infer<typeof workflowActionRequestV2Schema>;

export const workflowActionResponseV2Schema = z.object({
  ...workflowTurnRefsV2Schema.shape,
  actionContractVersion: z.literal(2),
  actionId: identifier,
  receipt: workflowReceiptV2Schema.nullable(),
  error: safeWorkflowErrorSchema.nullable(),
  claimRecovery: workflowClaimRecoveryResultSchema.optional(),
}).strict().superRefine((response, context) => {
  if (response.receipt !== null && response.error !== null) {
    context.addIssue({ code: 'custom', path: ['error'], message: 'An operation cannot return both a receipt and an error' });
  }
  // The runner can return a successful read-only claim recovery without a receipt.
  if (response.receipt === null && response.error === null &&
      (!response.claimRecovery || response.claimRecovery.error !== null)) {
    context.addIssue({ code: 'custom', path: ['receipt'], message: 'An operation needs a receipt, error, or successful claim recovery result' });
  }
  if (response.receipt && response.receipt.actionId !== response.actionId) {
    context.addIssue({ code: 'custom', path: ['receipt', 'actionId'], message: 'Receipt belongs to another action' });
  }
  if (response.error?.actionId !== undefined && response.error.actionId !== null && response.error.actionId !== response.actionId) {
    context.addIssue({ code: 'custom', path: ['error', 'actionId'], message: 'Operation error belongs to another action' });
  }
  if (response.claimRecovery && response.claimRecovery.actionId !== response.actionId) {
    context.addIssue({ code: 'custom', path: ['claimRecovery', 'actionId'], message: 'Claim recovery belongs to another action' });
  }
  if (response.receipt && response.claimRecovery) {
    if (response.claimRecovery.error !== null) {
      context.addIssue({ code: 'custom', path: ['claimRecovery', 'error'], message: 'A receipt requires successful claim recovery' });
    }
    if (response.claimRecovery.existingExecutionId !== response.receipt.id) {
      context.addIssue({ code: 'custom', path: ['claimRecovery', 'existingExecutionId'], message: 'Recovery must identify the receipt execution' });
    }
  }
});
export type WorkflowActionResponseV2 = z.infer<typeof workflowActionResponseV2Schema>;

export const workflowActionViewV2Schema = z.object({
  ...workflowTurnRefsV2Schema.shape,
  actionContractVersion: z.literal(2),
  action: workflowPublicActionV2Schema,
  displayStatus: pendingActionV2Schema.shape.status,
}).strict().superRefine((view, context) => {
  if (view.action.conversationId !== view.conversationId || view.action.turnId !== view.turnId) {
    context.addIssue({ code: 'custom', path: ['action'], message: 'Action does not belong to the referenced turn' });
  }
  if (view.displayStatus !== view.action.status && !(view.action.status === 'pending' && view.displayStatus === 'stale')) {
    context.addIssue({ code: 'custom', path: ['displayStatus'], message: 'Display status cannot change the persisted action outcome' });
  }
});
export type WorkflowActionViewV2 = z.infer<typeof workflowActionViewV2Schema>;

/** Public history contains no storage session ID or unvalidated source payload. */
export const workflowConversationReadV2Schema = z.object({
  actionContractVersion: z.literal(2),
  conversation: conversationMetadataSchema.pick({
    id: true, title: true, pinned: true, archivedAt: true, updatedAt: true,
  }),
  messages: z.array(z.object({
    id: identifier,
    role: messageFields.role,
    turnId: identifier.optional(),
    text: messageFields.text,
    createdAt: messageFields.createdAt,
    redacted: z.boolean(),
    pendingActionIds: z.array(identifier).max(MAX_WORKFLOW_TARGETS),
  }).strict()).max(100),
  actionViews: z.array(workflowActionViewV2Schema).max(100),
  nextCursor: identifier.nullable(),
}).strict().superRefine((view, context) => {
  const actionIds = new Set(view.actionViews.map(item => item.action.id));
  for (const [index, message] of view.messages.entries()) {
    for (const actionId of message.pendingActionIds) {
      if (!actionIds.has(actionId)) {
        context.addIssue({ code: 'custom', path: ['messages', index, 'pendingActionIds'],
          message: 'Message exposes an action outside this authorized page' });
      }
    }
  }
  for (const [index, item] of view.actionViews.entries()) {
    if (item.conversationId !== view.conversation.id) {
      context.addIssue({ code: 'custom', path: ['actionViews', index],
        message: 'Action belongs to another conversation' });
    }
  }
});
export type WorkflowConversationReadV2 = z.infer<typeof workflowConversationReadV2Schema>;

export const workflowSuggestedPromptSchema = z.object({
  id: identifier,
  prompt: z.string().min(1).max(8_000).refine(value => value.trim().length > 0, 'The prompt cannot be blank'),
}).strict();
export type WorkflowSuggestedPromptV2 = z.infer<typeof workflowSuggestedPromptSchema>;

export const workflowSuggestionsResponseV2Schema = z.object({
  actionContractVersion: z.literal(2),
  suggestions: z.array(workflowSuggestedPromptSchema).max(6),
}).strict().superRefine((response, context) => {
  const ids = new Set<string>();
  for (const [index, suggestion] of response.suggestions.entries()) {
    if (ids.has(suggestion.id)) {
      context.addIssue({ code: 'custom', path: ['suggestions', index, 'id'], message: 'Suggestion references repeat' });
    }
    ids.add(suggestion.id);
  }
});
export type WorkflowSuggestionsResponseV2 = z.infer<typeof workflowSuggestionsResponseV2Schema>;
