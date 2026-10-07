import 'server-only';

import { z } from 'zod';
import { DEFAULT_CONVERSATION_TITLE } from './conversations';
import { DomainError } from './errors';
import { readCompletedTurn, type TurnCompletionTuple } from './turn-completion-gate';
import type { WorkflowSuggestionContext } from './workflow-capabilities';
import type { RuntimeReadContext } from '../workflows/action-runtime';
import type { WorkflowV2ServerRuntime } from '../server/workflow';
import type { ProjectedRow, WorkflowStorageQuery, WorkflowTransactionContext } from '../storage/workflow-projections';
import {
  conversationMetadataSchema,
  directoryIdentitySchema,
  persistedConversationMessageSchema,
  persistedConversationSchema,
  pendingActionV2Schema,
  type PendingActionV2,
  type PersistedConversationMessage,
} from '../workflows/contracts';
import {
  workflowActionViewV2Schema,
  workflowConversationReadV2Schema,
  workflowPublicActionV2Schema,
  workflowSuggestionsResponseV2Schema,
  workflowTurnRefsV2Schema,
  type WorkflowActionViewV2,
  type WorkflowConversationReadV2,
  type WorkflowPublicActionV2,
  type WorkflowSuggestionsResponseV2,
  type WorkflowTurnRefsV2,
} from '../workflows/api-contracts';
import { getWorkflowActionAuthority } from '../workflows/action-authority';
import { authorizeWorkflowScope } from '../workflows/authority';

const identifier = directoryIdentitySchema.shape.id;
const maximumPageSize = 100;
const defaultPageSize = 25;
const redactedMessage = 'This message is unavailable in your current access scope.';

const actionViewRequestSchema = workflowTurnRefsV2Schema.extend({ actionId: identifier }).strict();
const actionPageInputSchema = z.object({
  conversationId: identifier.optional(),
  cursor: identifier.optional(),
  limit: z.number().int().min(1).max(maximumPageSize).default(defaultPageSize),
}).strict();
const conversationReadInputSchema = z.object({
  conversationId: identifier,
  cursor: identifier.optional(),
  limit: z.number().int().min(1).max(maximumPageSize).default(defaultPageSize),
}).strict();
const actionViewPageSchema = z.object({
  actionViews: z.array(workflowActionViewV2Schema).max(maximumPageSize),
  nextCursor: identifier.nullable(),
}).strict();

/** The read layer needs only the runner's trusted runtime and the trusted suggestion projector. */
export type WorkflowV2ReadRuntime = Pick<WorkflowV2ServerRuntime, 'runner' | 'suggestions'>;
export type WorkflowActionViewPageV2 = z.infer<typeof actionViewPageSchema>;

function projectionUnavailable(): never {
  throw new DomainError('WORKFLOW_PROJECTION_UNAVAILABLE', 'A persisted workflow projection is unavailable', 503);
}

function ambiguousRead(): never {
  throw new DomainError('WORKFLOW_CONFLICT', 'The persisted workflow reference is ambiguous', 409);
}

function missingRead(): never {
  throw new DomainError('WORKFLOW_NOT_FOUND', 'The workflow resource is unavailable', 404);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function actionReferences(message: PersistedConversationMessage): string[] {
  return [...new Set([...(message.pendingActionIds ?? []), ...(message.pendingActionId ? [message.pendingActionId] : [])])];
}

function parsePersistedMessage(row: ProjectedRow<unknown>): PersistedConversationMessage {
  const parsed = persistedConversationMessageSchema.safeParse(row.body);
  if (!parsed.success || parsed.data.id !== row.id) projectionUnavailable();
  return parsed.data;
}

function parseV2Action(row: ProjectedRow<unknown>): PendingActionV2 | undefined {
  const parsed = pendingActionV2Schema.safeParse(row.body);
  if (!parsed.success) {
    if (isRecord(row.body) && row.body.contractVersion === 2) projectionUnavailable();
    return undefined;
  }
  if (parsed.data.id !== row.id) projectionUnavailable();
  return parsed.data;
}

function requireExactAction(action: PendingActionV2, context: RuntimeReadContext, refs: WorkflowTurnRefsV2): void {
  if (action.actorId !== context.actor.id || action.sessionId !== context.actor.sessionId ||
    action.conversationId !== refs.conversationId || action.turnId !== refs.turnId) missingRead();
}

function completionTupleForAction(context: RuntimeReadContext, action: PendingActionV2): TurnCompletionTuple {
  return {
    actorId: context.actor.id,
    sessionId: context.actor.sessionId,
    conversationId: action.conversationId,
    turnId: action.turnId,
    mode: action.mode,
    modeRevision: action.modeRevision,
  };
}

function completionTupleForMessage(
  context: RuntimeReadContext,
  message: PersistedConversationMessage,
): TurnCompletionTuple | undefined {
  if (!message.turnId || message.actorId !== context.actor.id || message.sessionId !== context.actor.sessionId ||
    message.conversationId === undefined) return undefined;
  return {
    actorId: context.actor.id,
    sessionId: context.actor.sessionId,
    conversationId: message.conversationId,
    turnId: message.turnId,
    mode: message.mode,
    modeRevision: message.modeRevision,
  };
}

function toPublicAction(action: PendingActionV2): WorkflowPublicActionV2 {
  return workflowPublicActionV2Schema.parse({
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
  });
}

function assertAssistantTurnAnchor(
  anchor: PersistedConversationMessage | undefined,
  context: RuntimeReadContext,
  refs: WorkflowTurnRefsV2,
  actionId: string,
): PersistedConversationMessage {
  if (!anchor || anchor.id !== refs.assistantMessageId || anchor.role !== 'assistant' ||
    anchor.actorId !== context.actor.id || anchor.sessionId !== context.actor.sessionId ||
    anchor.conversationId !== refs.conversationId || anchor.turnId !== refs.turnId ||
    !actionReferences(anchor).includes(actionId)) missingRead();
  return anchor;
}

async function uniqueAssistantMessageForTurn(
  context: RuntimeReadContext,
  refs: Pick<WorkflowTurnRefsV2, 'conversationId' | 'turnId'>,
): Promise<PersistedConversationMessage | undefined> {
  const query: Extract<WorkflowStorageQuery, { kind: 'scoped' }> = {
    kind: 'scoped', table: 'conversation_messages',
    equals: { actorId: context.actor.id, sessionId: context.actor.sessionId,
      conversationId: refs.conversationId, turnId: refs.turnId },
    limit: maximumPageSize,
  };
  const rows = await context.projections.query<unknown>(query);
  const tail = await readPageTail(context, query, rows[rows.length - 1]?.id);
  if (rows.length >= maximumPageSize) ambiguousRead();
  if (tail) ambiguousRead();
  const assistants = rows.map(parsePersistedMessage).filter(message => message.role === 'assistant');
  if (assistants.length > 1) ambiguousRead();
  return assistants[0];
}

function currentScopeAllowsAction(context: RuntimeReadContext, action: PendingActionV2): boolean {
  const authority = getWorkflowActionAuthority(action.payload.kind);
  if (!authority.readPermissions.every(permission => context.actor.permissions.includes(permission))) return false;
  if (!action.approvedBranchIds.length && !action.approvedOrgUnitIds.length) return false;
  try {
    authorizeWorkflowScope(context.principal, {
      permission: authority.permission, roles: authority.roles, purpose: authority.purpose,
      targets: action.approvedBranchIds.map(branchId => ({ branchId })),
    });
    authorizeWorkflowScope(context.principal, {
      permission: authority.permission, roles: authority.roles, purpose: authority.purpose,
      targets: action.approvedOrgUnitIds.map(orgUnitId => ({ orgUnitId })),
    });
    return true;
  } catch (error) {
    if (error instanceof DomainError && [401, 403, 404].includes(error.status)) return false;
    throw error;
  }
}

async function displayStatus(
  server: WorkflowV2ReadRuntime,
  tx: WorkflowTransactionContext,
  context: RuntimeReadContext,
  action: PendingActionV2,
): Promise<PendingActionV2['status'] | undefined> {
  if (action.status !== 'pending') return action.status;
  try {
    await server.runner.runtime.assertEnvelope(tx, context, action, true,
      { conversationId: action.conversationId, turnId: action.turnId });
    return 'pending';
  } catch (error) {
    if (error instanceof DomainError && [401, 403, 404].includes(error.status)) return undefined;
    if (error instanceof DomainError && error.status === 409) return 'stale';
    throw error;
  }
}

async function projectActionView(
  server: WorkflowV2ReadRuntime,
  tx: WorkflowTransactionContext,
  context: RuntimeReadContext,
  action: PendingActionV2,
  assistantRow: PersistedConversationMessage | undefined,
  refs: WorkflowTurnRefsV2,
): Promise<WorkflowActionViewV2 | undefined> {
  requireExactAction(action, context, refs);
  const anchor = assertAssistantTurnAnchor(assistantRow, context, refs, action.id);
  if (!currentScopeAllowsAction(context, action)) return undefined;
  const completed = await readCompletedTurn(tx, completionTupleForAction(context, action), action.id);
  if (completed.kind !== 'completed' || completed.assistant.id !== anchor.id) return undefined;
  const status = await displayStatus(server, tx, context, action);
  if (status === undefined) return undefined;
  return workflowActionViewV2Schema.parse({
    ...refs,
    actionContractVersion: 2,
    action: toPublicAction(action),
    displayStatus: status,
  });
}

async function readActionRow(context: RuntimeReadContext, actionId: string): Promise<PendingActionV2 | undefined> {
  const row = await context.projections.get<unknown>('pending_actions', identifier.parse(actionId));
  return row ? parseV2Action(row) : undefined;
}

function scopedPageQuery(
  table: 'pending_actions' | 'conversation_messages',
  actorId: string,
  sessionId: string,
  limit: number,
  cursor?: string,
  conversationId?: string,
): Extract<WorkflowStorageQuery, { kind: 'scoped' }> {
  return {
    kind: 'scoped', table, limit,
    ...(cursor === undefined ? {} : { cursor }),
    equals: {
      actorId, sessionId,
      ...(conversationId === undefined ? {} : { conversationId }),
    },
  };
}

async function readPageTail(
  context: RuntimeReadContext,
  query: Extract<WorkflowStorageQuery, { kind: 'scoped' }>,
  cursor?: string,
): Promise<ProjectedRow<unknown> | undefined> {
  const rows = await context.projections.query<unknown>({
    ...query,
    ...(cursor === undefined ? {} : { cursor }),
    limit: 1,
  });
  if (rows.length > 1) ambiguousRead();
  if (cursor !== undefined && rows[0]?.id === cursor) ambiguousRead();
  return rows[0];
}

async function nextPageCursor(
  context: RuntimeReadContext,
  query: Extract<WorkflowStorageQuery, { kind: 'scoped' }>,
  rows: readonly ProjectedRow<unknown>[],
  limit: number,
  inputCursor?: string,
): Promise<string | null> {
  if (rows.length > limit) ambiguousRead();
  const seenIds = new Set<string>();
  for (const row of rows) {
    if (seenIds.has(row.id) || row.id === inputCursor) ambiguousRead();
    seenIds.add(row.id);
  }
  const lastId = rows[rows.length - 1]?.id;
  if (rows.length === limit && (!lastId || lastId === inputCursor)) ambiguousRead();
  const tail = await readPageTail(context, query, lastId ?? inputCursor);
  if (tail && (seenIds.has(tail.id) || tail.id === lastId || tail.id === inputCursor)) ambiguousRead();
  if (rows.length < limit) {
    if (tail) ambiguousRead();
    return null;
  }
  return tail ? lastId! : null;
}

async function loadActionViewForRow(
  server: WorkflowV2ReadRuntime,
  tx: WorkflowTransactionContext,
  context: RuntimeReadContext,
  action: PendingActionV2,
  anchors: Map<string, PersistedConversationMessage | undefined>,
): Promise<WorkflowActionViewV2 | undefined> {
  const turnKey = `${action.conversationId}\u0000${action.turnId}`;
  let anchor = anchors.get(turnKey);
  if (!anchors.has(turnKey)) {
    await server.runner.runtime.assertConversation(context, action.conversationId, true);
    anchor = await uniqueAssistantMessageForTurn(context, action);
    anchors.set(turnKey, anchor);
  }
  if (!anchor) return undefined;
  const refs: WorkflowTurnRefsV2 = {
    conversationId: action.conversationId,
    turnId: action.turnId,
    assistantMessageId: anchor.id,
  };
  return projectActionView(server, tx, context, action, anchor, refs);
}

/** Read one action only after the supplied persisted assistant message proves exact turn membership. */
export async function getWorkflowV2ActionView(
  server: WorkflowV2ReadRuntime,
  sessionId: string,
  input: WorkflowTurnRefsV2 & { actionId: string },
): Promise<WorkflowActionViewV2> {
  const { actionId, ...refs } = actionViewRequestSchema.parse(input);
  return server.runner.runtime.store.workflowTransaction(async tx => {
    const context = await server.runner.runtime.context(tx, sessionId);
    await server.runner.runtime.assertConversation(context, refs.conversationId, true);
    const action = await readActionRow(context, actionId);
    if (!action) missingRead();
    const message = await uniqueAssistantMessageForTurn(context, refs);
    const view = await projectActionView(server, tx, context, action, message, refs);
    if (!view) missingRead();
    return view;
  });
}

/** Page V2 actions by projection ID, with current authorization and persisted assistant anchors. */
export async function listWorkflowV2ActionViews(
  server: WorkflowV2ReadRuntime,
  sessionId: string,
  input: { conversationId?: string; cursor?: string; limit?: number },
): Promise<WorkflowActionViewPageV2> {
  const page = actionPageInputSchema.parse(input);
  return server.runner.runtime.store.workflowTransaction(async tx => {
    const context = await server.runner.runtime.context(tx, sessionId);
    if (page.conversationId) await server.runner.runtime.assertConversation(context, page.conversationId, true);
    const query = scopedPageQuery('pending_actions', context.actor.id, context.actor.sessionId,
      page.limit, page.cursor, page.conversationId);
    const rows = await context.projections.query<unknown>(query);
    const actionViews: WorkflowActionViewV2[] = [];
    const anchors = new Map<string, PersistedConversationMessage | undefined>();
    for (const row of rows) {
      const action = parseV2Action(row);
      if (!action) continue;
      const view = await loadActionViewForRow(server, tx, context, action, anchors);
      if (view) actionViews.push(view);
    }
    const nextCursor = await nextPageCursor(context, query, rows, page.limit, page.cursor);
    return actionViewPageSchema.parse({ actionViews, nextCursor });
  });
}

function messageCarriesUnverifiedSourceMetadata(message: PersistedConversationMessage): boolean {
  // There is no generic current-scope citation or receipt reader here, so source-backed and receipt-backed
  // prose stays private until every persisted reference can be checked against current authority.
  return message.analysis !== undefined || message.evidence !== undefined || message.sources !== undefined || message.receiptId !== undefined;
}

function conversationReadShape(conversation: z.infer<typeof persistedConversationSchema>) {
  const updatedAt = conversation.updatedAt ?? conversation.createdAt;
  if (!updatedAt) projectionUnavailable();
  return conversationMetadataSchema.pick({ id: true, title: true, pinned: true, archivedAt: true, updatedAt: true }).parse({
    id: conversation.id,
    title: conversation.title?.trim() || DEFAULT_CONVERSATION_TITLE,
    pinned: conversation.pinned ?? Boolean(conversation.pinnedAt),
    archivedAt: conversation.archivedAt ?? null,
    updatedAt,
  });
}

/** Read a bounded history page; persisted assistant prose has no server-owned source provenance. */
export async function readWorkflowV2Conversation(
  server: WorkflowV2ReadRuntime,
  sessionId: string,
  input: { conversationId: string; cursor?: string; limit?: number },
): Promise<WorkflowConversationReadV2> {
  const page = conversationReadInputSchema.parse(input);
  return server.runner.runtime.store.workflowTransaction(async tx => {
    const context = await server.runner.runtime.context(tx, sessionId);
    await server.runner.runtime.assertConversation(context, page.conversationId, true);
    const storedConversation = await context.projections.get<unknown>('conversations', page.conversationId);
    const parsedConversation = persistedConversationSchema.safeParse(storedConversation?.body);
    if (!storedConversation || !parsedConversation.success || parsedConversation.data.id !== page.conversationId ||
      parsedConversation.data.actorId !== context.actor.id) projectionUnavailable();

    const query = scopedPageQuery('conversation_messages', context.actor.id, context.actor.sessionId,
      page.limit, page.cursor, page.conversationId);
    const rows = await context.projections.query<unknown>(query);
    const messages = rows.map(parsePersistedMessage);
    const actionViews: WorkflowActionViewV2[] = [];
    const actionViewsById = new Map<string, WorkflowActionViewV2>();
    const authorizedRefsByMessage = new Map<string, string[]>();
    const redactedByMessage = new Map<string, boolean>();
    const anchors = new Map<string, PersistedConversationMessage | undefined>();
    const actionAnchorIds = new Map<string, string>();
    let totalRefs = 0;

    for (const message of messages) {
      if (message.actorId !== context.actor.id || message.sessionId !== context.actor.sessionId ||
        message.conversationId !== page.conversationId) projectionUnavailable();
      const refs = actionReferences(message);
      totalRefs += refs.length;
      if (totalRefs > maximumPageSize) ambiguousRead();
      const visibleRefs: string[] = [];
      // Completion proves the assistant bytes and action IDs, not the provenance of prose without source metadata.
      let redact = message.role === 'assistant' || messageCarriesUnverifiedSourceMetadata(message) || refs.length > 0;
      if (message.role === 'assistant') {
        const tuple = completionTupleForMessage(context, message);
        const completed = tuple ? await readCompletedTurn(tx, tuple) : undefined;
        if (completed?.kind !== 'completed' || completed.assistant.id !== message.id) {
          redact = true;
          authorizedRefsByMessage.set(message.id, visibleRefs);
          redactedByMessage.set(message.id, redact);
          continue;
        }
        for (const actionId of refs) {
          const priorAnchor = actionAnchorIds.get(actionId);
          if (priorAnchor !== undefined && priorAnchor !== message.id) ambiguousRead();
          actionAnchorIds.set(actionId, message.id);
          const action = await readActionRow(context, actionId);
          if (!action || action.actorId !== context.actor.id || action.sessionId !== context.actor.sessionId ||
            action.conversationId !== message.conversationId || action.turnId !== message.turnId) {
            redact = true;
            continue;
          }
          let anchor = anchors.get(`${action.conversationId}\u0000${action.turnId}`);
          const key = `${action.conversationId}\u0000${action.turnId}`;
          if (!anchors.has(key)) {
            anchor = await uniqueAssistantMessageForTurn(context, action);
            anchors.set(key, anchor);
          }
          if (!anchor || anchor.id !== message.id || !actionReferences(anchor).includes(action.id)) {
            redact = true;
            continue;
          }
          const refsForAction: WorkflowTurnRefsV2 = {
            conversationId: action.conversationId,
            turnId: action.turnId,
            assistantMessageId: message.id,
          };
          const view = await projectActionView(server, tx, context, action, anchor, refsForAction);
          if (!view) {
            redact = true;
            continue;
          }
          const previous = actionViewsById.get(action.id);
          if (previous && previous.assistantMessageId !== message.id) ambiguousRead();
          if (!previous) {
            if (actionViews.length >= maximumPageSize) ambiguousRead();
            actionViewsById.set(action.id, view);
            actionViews.push(view);
          }
          visibleRefs.push(action.id);
        }
      } else if (refs.length > 0) {
        redact = true;
      }
      authorizedRefsByMessage.set(message.id, visibleRefs);
      redactedByMessage.set(message.id, redact);
    }

    const resultMessages = messages.map(message => {
      const redacted = redactedByMessage.get(message.id) ?? false;
      return {
        id: message.id,
        role: message.role,
        ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
        text: redacted ? redactedMessage : message.text,
        createdAt: message.createdAt,
        redacted,
        pendingActionIds: authorizedRefsByMessage.get(message.id) ?? [],
      };
    });
    const nextCursor = await nextPageCursor(context, query, rows, page.limit, page.cursor);
    return workflowConversationReadV2Schema.parse({
      actionContractVersion: 2,
      conversation: conversationReadShape(parsedConversation.data),
      messages: resultMessages,
      actionViews,
      nextCursor,
    });
  });
}

async function persistedSuggestionContext(
  server: WorkflowV2ReadRuntime,
  sessionId: string,
  conversationId: string | undefined,
): Promise<WorkflowSuggestionContext> {
  if (conversationId === undefined) return { phase: 'empty_chat' };
  const parsedId = identifier.parse(conversationId);
  return server.runner.runtime.store.workflowTransaction(async tx => {
    const context = await server.runner.runtime.context(tx, sessionId);
    await server.runner.runtime.assertConversation(context, parsedId);
    const conversationRow = await context.projections.get<unknown>('conversations', parsedId);
    const conversation = persistedConversationSchema.safeParse(conversationRow?.body);
    if (!conversation.success || conversation.data.id !== parsedId || conversation.data.actorId !== context.actor.id) projectionUnavailable();
    const messages = await context.projections.query<unknown>({
      kind: 'scoped', table: 'conversation_messages',
      equals: { actorId: context.actor.id, sessionId: context.actor.sessionId, conversationId: parsedId },
      limit: 1,
    });
    const suggestion: WorkflowSuggestionContext = {
      phase: messages.length ? 'follow_up' : 'empty_chat',
      conversationId: parsedId,
      ...(conversation.data.lastDashboardId ? { dashboardId: conversation.data.lastDashboardId } : {}),
      ...(conversation.data.lastScope?.branchIds ? { branchIds: [...conversation.data.lastScope.branchIds] } : {}),
    };
    return suggestion;
  });
}

/** Derive suggestions only from trusted runtime policy and the persisted conversation selection. */
export async function readWorkflowV2Suggestions(
  server: WorkflowV2ReadRuntime,
  sessionId: string,
  conversationId?: string,
): Promise<WorkflowSuggestionsResponseV2> {
  const context = await persistedSuggestionContext(server, sessionId, conversationId);
  const suggestions = await server.suggestions(sessionId, context);
  return workflowSuggestionsResponseV2Schema.parse({
    actionContractVersion: 2,
    suggestions: suggestions.map(({ id, prompt }) => ({ id, prompt })),
  });
}
