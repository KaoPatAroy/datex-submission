import { describe, expect, it } from 'vitest';
import type { PersistedConversationMessage } from '../lib/workflows/contracts';
import {
  assertCompletedActionTurn,
  finalAssistantContentDigest,
  normalizedFinalActionIds,
  readCompletedTurn,
  turnCompletionId,
  turnCompletionRecordSchema,
  turnRequestCompletionProofSchema,
  type TurnCompletionReader,
  type TurnCompletionRecord,
  type TurnCompletionTuple,
  type TurnRequestCompletionProof,
} from '../lib/core/turn-completion-gate';
import { assistantMessageId } from '../lib/core/conversation-actions';
import { DomainError } from '../lib/core/errors';
import { digest } from '../lib/core/utils';
import { createWorkflowSqliteFixture } from './helpers/workflow-storage';

const CREATED_AT = '2026-10-04T04:00:00.000Z';
const MESSAGE = 'The requested synthetic workflow summary is ready.';
const CONTENT = { text: 'The requested synthetic workflow summary is ready.' };

type Table = Parameters<TurnCompletionReader['get']>[0];
type EntryKey = `${Table}\u0000${string}`;

interface Rows {
  tuple: TurnCompletionTuple;
  completion: TurnCompletionRecord;
  request: TurnRequestCompletionProof;
  user: PersistedConversationMessage;
  assistant: PersistedConversationMessage;
}

function validRows(origin: 'chat' | 'standalone_prepare' = 'chat'): Rows {
  const tuple: TurnCompletionTuple = {
    actorId: 'turn-completion-actor',
    sessionId: 'turn-completion-session',
    conversationId: 'turn-completion-conversation',
    turnId: 'turn-completion-turn',
    mode: 'scripted_demo',
    modeRevision: 3,
  };
  const user: PersistedConversationMessage = {
    id: tuple.turnId,
    actorId: tuple.actorId,
    sessionId: tuple.sessionId,
    conversationId: tuple.conversationId,
    turnId: tuple.turnId,
    role: 'user',
    text: MESSAGE,
    mode: tuple.mode,
    modeRevision: tuple.modeRevision,
    createdAt: CREATED_AT,
  };
  const assistantId = assistantMessageId(tuple.actorId, tuple);
  const assistant: PersistedConversationMessage = {
    id: assistantId,
    actorId: tuple.actorId,
    sessionId: tuple.sessionId,
    conversationId: tuple.conversationId,
    turnId: tuple.turnId,
    role: 'assistant',
    text: CONTENT.text,
    mode: tuple.mode,
    modeRevision: tuple.modeRevision,
    createdAt: CREATED_AT,
    pendingActionIds: ['completion-action-b', 'completion-action-a'],
  };
  const finalActionIds = normalizedFinalActionIds(assistant);
  const finalContentDigest = finalAssistantContentDigest(assistant, finalActionIds);
  const completion = turnCompletionRecordSchema.parse({
    ...tuple,
    id: turnCompletionId(tuple),
    name: 'chat.turn_completion',
    schemaVersion: 1,
    origin,
    requestLedgerId: origin === 'chat' ? 'turn-completion-request' : null,
    status: 'completed',
    createdAt: CREATED_AT,
    assistantMessageId: assistantId,
    finalContentDigest,
    finalActionIds,
  });
  const request = turnRequestCompletionProofSchema.parse({
    ...tuple,
    id: 'turn-completion-request',
    name: 'chat.turn_request',
    actionContractVersion: 2,
    intentHash: digest({
      actorId: tuple.actorId,
      sessionId: tuple.sessionId,
      conversationId: null,
      message: MESSAGE,
      actionContractVersion: 2,
    }),
    status: 'completed',
    createdAt: CREATED_AT,
    finalContentDigest,
    finalActionIds,
  });
  return { tuple, completion, request, user, assistant };
}

function key(table: Table, id: string): EntryKey {
  return `${table}\u0000${id}`;
}

function memoryReader(rows: Rows) {
  const entries = new Map<EntryKey, unknown>([
    [key('tool_executions', rows.completion.id), rows.completion],
    [key('tool_executions', rows.request.id), rows.request],
    [key('conversation_messages', rows.user.id), rows.user],
    [key('conversation_messages', rows.assistant.id), rows.assistant],
  ]);
  const reads: Array<{ table: Table; id: string }> = [];
  const reader: TurnCompletionReader = Object.freeze({
    async get<T>(table: Table, id: string): Promise<T | undefined> {
      reads.push({ table, id });
      return entries.get(key(table, id)) as T | undefined;
    },
  });
  return {
    reader,
    reads,
    set(table: Table, id: string, value: unknown): void {
      entries.set(key(table, id), value);
    },
    delete(table: Table, id: string): void {
      entries.delete(key(table, id));
    },
  };
}

function completionWith(rows: Rows, patch: Partial<TurnCompletionRecord>): TurnCompletionRecord {
  return { ...rows.completion, ...patch };
}

function requestWith(rows: Rows, patch: Partial<TurnRequestCompletionProof>): TurnRequestCompletionProof {
  return { ...rows.request, ...patch };
}

function messageWith(
  message: PersistedConversationMessage,
  patch: Partial<PersistedConversationMessage>,
): PersistedConversationMessage {
  return { ...message, ...patch };
}

function sqliteSnapshot(fixture: Awaited<ReturnType<typeof createWorkflowSqliteFixture>>) {
  const database = fixture.openDatabase();
  try {
    const revision = (database.prepare('SELECT revision FROM appmeta WHERE singleton = 1').get() as { revision: number }).revision;
    const toolExecutions = database.prepare(
      'SELECT id, payload FROM tool_executions ORDER BY id',
    ).all() as Array<{ id: string; payload: string }>;
    const messages = database.prepare(
      'SELECT id, payload FROM conversation_messages ORDER BY id',
    ).all() as Array<{ id: string; payload: string }>;
    const actions = database.prepare(
      'SELECT id, payload FROM pending_actions ORDER BY id',
    ).all() as Array<{ id: string; payload: string }>;
    return { revision, toolExecutions, messages, actions };
  } finally {
    database.close();
  }
}

async function seedSqlite(
  fixture: Awaited<ReturnType<typeof createWorkflowSqliteFixture>>,
  rows: Rows,
  options: { includeRequest?: boolean; includeUser?: boolean; includeCompletion?: boolean } = {},
): Promise<void> {
  const store = fixture.store;
  const conversation = {
    id: rows.tuple.conversationId,
    actorId: rows.tuple.actorId,
    title: 'Turn completion test conversation',
    pinned: false,
    pinnedAt: null,
    archivedAt: null,
    rowVersion: 1,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    lastScope: null,
    lastDashboardId: null,
  };
  await store.transaction(async tx => {
    await tx.put('profiles', {
      id: rows.tuple.actorId,
      name: 'Turn completion test actor',
      role: 'executive',
      active: true,
      permissions: [],
      regions: [],
    });
    await tx.put('conversations', conversation);
    if (options.includeUser !== false) await tx.put('conversation_messages', rows.user);
    await tx.put('conversation_messages', rows.assistant);
    if (options.includeCompletion !== false) {
      await tx.put('tool_executions', rows.completion as { id: string });
    }
    if (options.includeRequest !== false && rows.completion.requestLedgerId !== null) {
      await tx.put('tool_executions', rows.request as { id: string });
    }
  });
}

describe('turn completion gate', () => {
  it('accepts only the exact completed turn, keyed request, user, assistant digest, and frozen action set', async () => {
    const rows = validRows();
    const { reader, reads } = memoryReader(rows);

    const result = await readCompletedTurn(reader, rows.tuple);

    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') return;
    expect(result.record).toEqual(rows.completion);
    expect(result.request).toEqual(rows.request);
    expect(result.user).toEqual(rows.user);
    expect(result.assistant).toEqual(rows.assistant);
    expect(normalizedFinalActionIds(result.assistant)).toEqual(['completion-action-a', 'completion-action-b']);
    expect(reads).toEqual([
      { table: 'tool_executions', id: turnCompletionId(rows.tuple) },
      { table: 'tool_executions', id: rows.request.id },
      { table: 'conversation_messages', id: rows.tuple.turnId },
      { table: 'conversation_messages', id: rows.completion.assistantMessageId },
    ]);
  });

  it('denies a missing deterministic completion record', async () => {
    const rows = validRows();
    const { reader, delete: deleteEntry } = memoryReader(rows);
    deleteEntry('tool_executions', turnCompletionId(rows.tuple));

    await expect(readCompletedTurn(reader, rows.tuple)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'completion_missing',
    });
  });

  it.each(['started', 'failed'] as const)(
    'denies %s completion records',
    async status => {
      const rows = validRows();
      const memory = memoryReader(rows);
      memory.set('tool_executions', rows.completion.id, completionWith(rows, { status }));

      await expect(readCompletedTurn(memory.reader, rows.tuple)).resolves.toEqual({
        kind: 'unavailable',
        reason: 'turn_incomplete',
      });
    },
  );

  it.each([
    ['unknown stale status', { status: 'stale' }],
    ['missing action reference freeze', { finalActionIds: undefined }],
    ['transplanted deterministic identity', { id: 'turn-completion-foreign-record' }],
  ] as const)('denies malformed completion records: %s', async (_label, patch) => {
    const rows = validRows();
    const memory = memoryReader(rows);
    memory.set('tool_executions', rows.completion.id, { ...rows.completion, ...patch });

    await expect(readCompletedTurn(memory.reader, rows.tuple)).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'completion_invalid',
    });
  });

  it('denies a completion transplanted to a different exact turn tuple', async () => {
    const rows = validRows();
    const memory = memoryReader(rows);
    memory.set('tool_executions', rows.completion.id, completionWith(rows, {
      modeRevision: rows.tuple.modeRevision + 1,
    }));

    await expect(readCompletedTurn(memory.reader, rows.tuple)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'completion_invalid',
    });
  });

  it('denies a chat completion without its keyed request ledger', async () => {
    const rows = validRows();
    const memory = memoryReader(rows);
    memory.set('tool_executions', rows.completion.id, completionWith(rows, { requestLedgerId: null }));

    const result = await readCompletedTurn(memory.reader, rows.tuple);

    expect(result.kind).toBe('unavailable');
  });

  const invalidLedgerCases: Array<[string, Partial<TurnRequestCompletionProof> | undefined]> = [
    ['missing keyed ledger', undefined],
    ['started keyed ledger', { status: 'started' }],
    ['failed keyed ledger', { status: 'failed' }],
    ['transplanted ledger identity', { id: 'turn-completion-foreign-request' }],
    ['wrong final digest', { finalContentDigest: 'f'.repeat(64) }],
    ['wrong frozen action set', { finalActionIds: ['completion-action-a'] }],
    ['wrong actor identity', { actorId: 'turn-completion-foreign-actor' }],
    ['wrong session identity', { sessionId: 'turn-completion-foreign-session' }],
    ['wrong conversation identity', { conversationId: 'turn-completion-foreign-conversation' }],
    ['wrong turn identity', { turnId: 'turn-completion-foreign-turn' }],
    ['wrong mode revision', { modeRevision: 4 }],
  ];

  it.each(invalidLedgerCases)('denies request ledger with %s', async (_label, patch) => {
    const rows = validRows();
    const memory = memoryReader(rows);
    const badRequest = patch === undefined ? undefined : requestWith(rows, patch);
    if (badRequest === undefined) memory.delete('tool_executions', rows.request.id);
    else memory.set('tool_executions', rows.request.id, badRequest);

    await expect(readCompletedTurn(memory.reader, rows.tuple)).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'request_unverified',
    });
  });

  it('denies a request ledger whose intent does not describe the exact persisted user turn', async () => {
    const rows = validRows();
    const memory = memoryReader(rows);
    memory.set('tool_executions', rows.request.id, requestWith(rows, {
      intentHash: digest({ different: 'request intent' }),
    }));

    await expect(readCompletedTurn(memory.reader, rows.tuple)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'user_unverified',
    });
  });

  it('denies a user message transplanted from another actor, session, conversation, or turn', async () => {
    const rows = validRows();
    const cases: Array<Partial<PersistedConversationMessage>> = [
      { actorId: 'turn-completion-foreign-actor' },
      { sessionId: 'turn-completion-foreign-session' },
      { conversationId: 'turn-completion-foreign-conversation' },
      { turnId: 'turn-completion-foreign-turn' },
      { modeRevision: rows.tuple.modeRevision + 1 },
    ];

    for (const patch of cases) {
      const memory = memoryReader(rows);
      memory.set('conversation_messages', rows.user.id, messageWith(rows.user, patch));
      await expect(readCompletedTurn(memory.reader, rows.tuple)).resolves.toEqual({
        kind: 'unavailable',
        reason: 'user_unverified',
      });
    }
  });

  it('denies an assistant message transplanted to another turn or noncanonical message ID', async () => {
    const rows = validRows();
    for (const patch of [
      { sessionId: 'turn-completion-foreign-session' },
      { conversationId: 'turn-completion-foreign-conversation' },
      { turnId: 'turn-completion-foreign-turn' },
      { id: 'turn-completion-foreign-assistant' },
    ] as const) {
      const memory = memoryReader(rows);
      memory.set('conversation_messages', rows.assistant.id, messageWith(rows.assistant, patch));
      await expect(readCompletedTurn(memory.reader, rows.tuple)).resolves.toEqual({
        kind: 'unavailable',
        reason: 'assistant_unverified',
      });
    }
  });

  it('denies late action references that were appended after completion', async () => {
    const rows = validRows();
    const memory = memoryReader(rows);
    memory.set('conversation_messages', rows.assistant.id, messageWith(rows.assistant, {
      pendingActionIds: [...(rows.assistant.pendingActionIds ?? []), 'completion-action-late'],
    }));

    await expect(readCompletedTurn(memory.reader, rows.tuple)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'references_unverified',
    });
  });

  it('denies conflicting singular and plural action references', async () => {
    const rows = validRows();
    const memory = memoryReader(rows);
    memory.set('conversation_messages', rows.assistant.id, messageWith(rows.assistant, {
      pendingActionId: 'completion-action-other',
    }));

    await expect(readCompletedTurn(memory.reader, rows.tuple)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'references_unverified',
    });
  });

  it('normalizes duplicate singular/plural references but rejects disagreement', () => {
    expect(normalizedFinalActionIds({
      pendingActionId: 'completion-action-a',
      pendingActionIds: ['completion-action-b', 'completion-action-a'],
    })).toEqual(['completion-action-a', 'completion-action-b']);
    expect(() => normalizedFinalActionIds({
      pendingActionId: 'completion-action-late',
      pendingActionIds: ['completion-action-a'],
    })).toThrow(DomainError);
  });

  it('binds final content digest to every final field and the normalized action set', () => {
    const rows = validRows();
    const ids = normalizedFinalActionIds(rows.assistant);
    expect(finalAssistantContentDigest(rows.assistant, ids))
      .toBe(rows.completion.finalContentDigest);
    expect(finalAssistantContentDigest({ text: 'Changed final text.' }, ids))
      .not.toBe(rows.completion.finalContentDigest);
    expect(finalAssistantContentDigest(CONTENT, ['different-action']))
      .not.toBe(rows.completion.finalContentDigest);
    expect(finalAssistantContentDigest(CONTENT, [...ids].reverse()))
      .toBe(rows.completion.finalContentDigest);
  });

  it('allows standalone_prepare only with an explicit completed marker and exact assistant row', async () => {
    const rows = validRows('standalone_prepare');
    const memory = memoryReader(rows);
    memory.delete('conversation_messages', rows.user.id);

    const result = await readCompletedTurn(memory.reader, rows.tuple);

    expect(result.kind).toBe('completed');
    if (result.kind === 'completed') {
      expect(result.record.origin).toBe('standalone_prepare');
      expect(result.record.requestLedgerId).toBeNull();
      expect(result.request).toBeNull();
      expect(result.user).toBeNull();
    }
  });

  it('denies standalone_prepare without its explicit marker or assistant row', async () => {
    const rows = validRows('standalone_prepare');
    const noMarker = memoryReader(rows);
    noMarker.delete('tool_executions', rows.completion.id);
    await expect(readCompletedTurn(noMarker.reader, rows.tuple)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'completion_missing',
    });

    const noAssistant = memoryReader(rows);
    noAssistant.delete('conversation_messages', rows.assistant.id);
    await expect(readCompletedTurn(noAssistant.reader, rows.tuple)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'assistant_unverified',
    });
  });

  it('requires an exact persisted action identity but returns proof without granting authority', async () => {
    const rows = validRows();
    const memory = memoryReader(rows);
    const action = { ...rows.tuple, id: 'completion-action-a' };
    memory.set('pending_actions', action.id, action);

    const result = await assertCompletedActionTurn(memory.reader, action);

    expect(result.kind).toBe('completed');
    expect(Object.keys(result).sort()).toEqual(['assistant', 'kind', 'record', 'request', 'user']);
    expect(result).not.toHaveProperty('principal');
    expect(result).not.toHaveProperty('permissions');
    expect(result).not.toHaveProperty('authorized');
    expect(memory.reads.map(read => read.table)).toEqual([
      'pending_actions',
      'tool_executions',
      'tool_executions',
      'conversation_messages',
      'conversation_messages',
    ]);
  });

  it('denies transplanted and late actions at the transactional action gate', async () => {
    const rows = validRows();
    const transplanted = memoryReader(rows);
    const foreignAction = {
      ...rows.tuple,
      id: 'completion-action-a',
      sessionId: 'turn-completion-foreign-session',
    };
    transplanted.set('pending_actions', foreignAction.id, foreignAction);
    await expect(assertCompletedActionTurn(transplanted.reader, {
      ...rows.tuple,
      id: foreignAction.id,
    })).rejects.toMatchObject({ code: 'TURN_NOT_COMPLETED' });

    const late = memoryReader(rows);
    const lateAction = { ...rows.tuple, id: 'completion-action-late' };
    late.set('pending_actions', lateAction.id, lateAction);
    await expect(assertCompletedActionTurn(late.reader, {
      ...rows.tuple,
      id: lateAction.id,
    })).rejects.toMatchObject({ code: 'TURN_NOT_COMPLETED' });
  });

  it('reads an isolated SQLite completion snapshot without changing durable rows', async () => {
    const rows = validRows();
    const fixture = await createWorkflowSqliteFixture();
    try {
      await seedSqlite(fixture, rows);
      const before = sqliteSnapshot(fixture);

      const result = await fixture.store.workflowTransaction(tx =>
        readCompletedTurn({ get: (table, id) => tx.get(table, id) }, rows.tuple),
      );

      const after = sqliteSnapshot(fixture);
      expect(result.kind).toBe('completed');
      expect(after).toEqual(before);
    } finally {
      await fixture.dispose();
    }
  });

  it('reads standalone_prepare only from a marker written with its exact assistant row', async () => {
    const rows = validRows('standalone_prepare');
    const fixture = await createWorkflowSqliteFixture();
    try {
      const store = fixture.store;
      const conversation = {
        id: rows.tuple.conversationId,
        actorId: rows.tuple.actorId,
        title: 'Standalone preparation completion test',
        pinned: false,
        pinnedAt: null,
        archivedAt: null,
        rowVersion: 1,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
        lastScope: null,
        lastDashboardId: null,
      };
      await store.transaction(async tx => {
        await tx.put('profiles', {
          id: rows.tuple.actorId,
          name: 'Standalone preparation test actor',
          role: 'executive',
          active: true,
          permissions: [],
          regions: [],
        });
        await tx.put('conversations', conversation);
        await tx.put('conversation_messages', rows.assistant);
        await tx.put('tool_executions', rows.completion as { id: string });
      });

      const result = await store.workflowTransaction(tx =>
        readCompletedTurn({ get: (table, id) => tx.get(table, id) }, rows.tuple),
      );

      expect(result).toMatchObject({
        kind: 'completed',
        request: null,
        user: null,
        record: { origin: 'standalone_prepare', status: 'completed' },
      });
    } finally {
      await fixture.dispose();
    }
  });
});
