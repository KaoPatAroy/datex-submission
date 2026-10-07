import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tables, type Branch, type ConversationMessage, type PendingAction, type Profile, type RowFilter, type SalesOrder, type Scope, type Store, type Table, type Transaction } from '../lib/contracts';
import { getFollowUpSuggestions } from '../lib/core/follow-up-suggestions';
import { assistantMessageId } from '../lib/core/conversation-actions';
import { finalAssistantContentDigest, normalizedFinalActionIds, turnCompletionId, turnCompletionRecordSchema, type TurnCompletionTuple } from '../lib/core/turn-completion-gate';
import { createConversation } from '../lib/core/conversations';
import { actors as demoActors, createWorkspaceFixture, FIXED_NOW } from './helpers/workspace';
import { baseQueryPlan, plan, planner, regionQueryStep } from './helpers/turn-planner';
import { readEvidence } from '../lib/packs/retail/evidence';
import { StorageReadUnavailableError } from '../lib/storage/read-error';

vi.mock('@/lib/router/planner/provider', async importOriginal =>
  (await import('./helpers/turn-planner')).plannerProviderModule(await importOriginal<object>()));

// Typed text is never interpreted any more: every answered turn below is a live turn whose planner returns a structured plan.
const actors = {
  ...demoActors,
  executive: { ...demoActors.executive, mode: 'live_ai' as const, modeRevision: 1 },
  east: { ...demoActors.east, mode: 'live_ai' as const, modeRevision: 1 },
};

function withReadFailure(base: Store, shouldFail: (table: Table, id?: string) => boolean): Store {
  return {
    adapter: base.adapter,
    get: <T>(table: Table, id: string) => shouldFail(table, id)
      ? Promise.reject(new StorageReadUnavailableError('sqlite', 'get', 'database_busy'))
      : base.get<T>(table, id),
    list: <T>(table: Table, filters?: RowFilter) => shouldFail(table)
      ? Promise.reject(new StorageReadUnavailableError('sqlite', 'list', 'database_busy'))
      : base.list<T>(table, filters),
    transaction: <T>(work: (tx: Transaction) => Promise<T>) => base.transaction(work),
    close: () => base.close?.(),
  };
}

function withPendingActionOverlay(base: Store, overlay: PendingAction): Store {
  const readMany = async <T>(table: Table, filters?: RowFilter): Promise<T[]> => {
    const rows = await base.list<T>(table, filters);
    if (table !== 'pending_actions') return rows;
    return rows.map(row => (row as { id?: unknown }).id === overlay.id ? overlay as T : row);
  };
  return {
    adapter: base.adapter,
    get: <T>(table: Table, id: string) => table === 'pending_actions' && id === overlay.id
      ? Promise.resolve(overlay as T)
      : base.get<T>(table, id),
    list: <T>(table: Table, filters?: RowFilter) => readMany<T>(table, filters),
    transaction: <T>(work: (tx: Transaction) => Promise<T>) => base.transaction(work),
    close: () => base.close?.(),
  };
}

type Service = Awaited<ReturnType<typeof createWorkspaceFixture>>['service'];

/**
 * The router's query answers persist verified dynamic state, not the V1 `evidence` snapshot that follow-up suggestions are
 * computed from. To keep exercising the suggestion rules this re-finalizes the live answer exactly as
 * a V1 evidence-bearing completed turn would be stored: message + request ledger + completion marker share one content digest.
 */
async function withV1Evidence<T extends { conversationId: string; turnId: string; assistantMessageId: string }>(store: Store, answer: T, scope: Scope) {
  const evidence = await readEvidence(store, actors.executive, scope, FIXED_NOW);
  const message = await store.get<ConversationMessage>('conversation_messages', answer.assistantMessageId);
  if (!message) throw new Error('The assistant message is missing.');
  const next = { ...message, evidence } as ConversationMessage;
  const completionId = turnCompletionId({ actorId: actors.executive.id, sessionId: actors.executive.sessionId, conversationId: answer.conversationId, turnId: answer.turnId });
  await store.transaction(async tx => {
    const completion = turnCompletionRecordSchema.parse(await tx.get('tool_executions', completionId));
    const request = await tx.get<{ id: string } & Record<string, unknown>>('tool_executions', completion.requestLedgerId!);
    const digest = finalAssistantContentDigest(next, normalizedFinalActionIds(next));
    await tx.put('conversation_messages', next);
    await tx.put('tool_executions', { ...completion, finalContentDigest: digest });
    await tx.put('tool_executions', { ...request!, finalContentDigest: digest });
  });
  return { ...answer, evidence };
}

/** A live turn whose planner returns a grounded region-scoped sales query (the wording below is only the evidence source). */
async function askRegion(store: Store, service: Service, regionId: 'east' | 'central', conversationId?: string) {
  const label = regionId === 'east' ? 'East' : 'Central';
  planner.reply((input: Parameters<typeof regionQueryStep>[0]) => plan(regionQueryStep(input, regionId, label, '2026-10-01', '2026-10-01')));
  const answer = await service.turn(actors.executive, `Compare sales against target in ${label} on 2026-10-01.`, conversationId);
  return withV1Evidence(store, answer, { region: regionId, date: '2026-10-01' });
}

describe('contextual follow-up suggestions', () => {
  let fixture: Awaited<ReturnType<typeof createWorkspaceFixture>> | undefined;

  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('USE_LOCAL_DEMO_DATA', 'true');
    vi.stubEnv('BIZTANIA_DYNAMIC_QUERY', '');
    planner.reset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fixture?.dispose();
    fixture = undefined;
  });

  async function setup(live = true) {
    fixture = await createWorkspaceFixture();
    if (live) for (const actor of [actors.executive, actors.east]) await fixture.patchSession(actor.sessionId, { mode: 'live_ai', modeRevision: 1 });
    return fixture;
  }

  async function snapshotStoreTables(store: Awaited<ReturnType<typeof createWorkspaceFixture>>['store']) {
    return Promise.all(tables.map(async table => [table, await store.list(table)] as const));
  }

  async function prepareDashboardAnswer() {
    const actor = demoActors.executive;
    const { store, service, setNow } = await setup(false);
    await setNow(new Date());
    const catalog = await service.getWorkspace(actor);
    const entry = catalog.actionCatalog?.find(item => item.actionKind === 'dashboard_create');
    const prompt = entry?.prompt;
    if (!prompt) throw new Error('The dashboard proposal is not currently available in the V1 catalog.');
    // Demo mode keeps private creations behind the preview -> confirm step; the catalog id is the structured intent.
    const answer = await service.turn(actor, prompt, undefined, undefined, { contractVersion: 2, requestKey: 'follow-up-suggestions-dashboard', catalogEntryId: entry!.id });
    if (!answer.pendingAction) throw new Error('The expected pending action was not created.');
    return { store, service, answer, action: answer.pendingAction, actor };
  }

  it('returns bounded, current read-only prompts from the exact completed evidence scope without writes', async () => {
    const { store, service } = await setup();
    const answer = await askRegion(store, service, 'east');
    expect(answer.evidence?.scope).toMatchObject({ region: 'east', date: '2026-10-01' });
    const before = await snapshotStoreTables(store);

    const response = await getFollowUpSuggestions(store, actors.executive, answer.conversationId, answer.assistantMessageId);

    expect(response).toMatchObject({ status: 'ready', conversationId: answer.conversationId, afterMessageId: answer.assistantMessageId });
    expect(response.items).toHaveLength(3);
    expect(response.items.every(item => item.consequence === 'analyze')).toBe(true);
    expect(response.items.every(item => item.prompt.includes('วันที่ 2026-10-01') && item.prompt.includes('E02'))).toBe(true);
    expect(response.items.every(item => !item.prompt.includes('C01'))).toBe(true);
    expect(response.items.every(item => item.label.length <= 180 && !item.label.includes('ทุกภูมิภาค'))).toBe(true);
    expect(response.items.every(item => !item.prompt.includes('ทุกภูมิภาค'))).toBe(true);
    expect(await snapshotStoreTables(store)).toEqual(before);
  });

  it('a live router query answer yields follow-up suggestions without any test seeding', async () => {
    const { store, service } = await setup();
    planner.reply((input: Parameters<typeof regionQueryStep>[0]) => plan(regionQueryStep(input, 'east', 'East', '2026-10-01', '2026-10-01')));
    const answer = await service.turn(actors.executive, 'Compare sales against target in East on 2026-10-01.');
    const response = await getFollowUpSuggestions(store, actors.executive, answer.conversationId, answer.assistantMessageId);
    expect(response.status).toBe('ready');
  });

  it('keeps labels bounded when the exact branch identifiers are long', async () => {
    const { store, service } = await setup();
    const longBranchIds = ['A', 'B', 'C'].map(prefix => `${prefix}${'x'.repeat(63)}`);
    await store.transaction(async tx => {
      for (const [index, branchId] of longBranchIds.entries()) {
        await tx.put('branches', { id: branchId, name: `Long branch ${index + 1}`, region: 'east' } satisfies Branch);
        await tx.put('sales_orders', {
          id: `SO-${branchId}`, branchId, date: '2026-10-01', amountSatang: 100_000 + index,
          status: 'paid', updatedAt: '2026-10-01T16:59:55.000Z',
        } satisfies SalesOrder);
        await tx.put('sales_targets', {
          id: `TGT-${branchId}`, branchId, date: '2026-10-01', amountSatang: 150_000,
          updatedAt: '2026-10-01T16:59:55.000Z',
        });
      }
    });
    const answer = await askRegion(store, service, 'east');

    const response = await getFollowUpSuggestions(store, actors.executive, answer.conversationId, answer.assistantMessageId);

    expect(response.status).toBe('ready');
    expect(response.items.every(item => item.label.length <= 180)).toBe(true);
    expect(response.items.every(item => item.prompt.length <= 1_200)).toBe(true);
    expect(response.items.every(item => longBranchIds.every(id => item.prompt.includes(id)))).toBe(true);
  });

  it('suppresses an older answer after a newer answer changes the scope', async () => {
    const { store, service } = await setup();
    const east = await askRegion(store, service, 'east');
    await fixture?.setNow(new Date(FIXED_NOW.getTime() + 1_000));
    const central = await askRegion(store, service, 'central', east.conversationId);

    const oldAnchor = await getFollowUpSuggestions(store, actors.executive, central.conversationId, east.assistantMessageId);
    const currentAnchor = await getFollowUpSuggestions(store, actors.executive, central.conversationId, central.assistantMessageId);

    expect(oldAnchor).toMatchObject({ status: 'none', items: [] });
    expect(currentAnchor.status).toBe('ready');
    expect(currentAnchor.items.every(item => item.prompt.includes('C01') && !item.prompt.includes('E02'))).toBe(true);
  });

  it('recomputes suggestions after role and branch-scope drift', async () => {
    const { store, service } = await setup();
    planner.reply((input: Parameters<typeof regionQueryStep>[0]) => plan({ kind: 'query', continuation: false, plan: baseQueryPlan(input.context) }));
    const answer = await withV1Evidence(store, await service.turn(actors.executive, 'Compare sales across all regions on 2026-10-01.'), { region: 'all', date: '2026-10-01' });
    const profile = await store.get<Profile>('profiles', actors.executive.id);
    if (!profile) throw new Error('The executive fixture profile is missing.');
    await store.transaction(tx => tx.put('profiles', { ...profile, role: 'east_manager', regions: ['east'] }));

    const response = await getFollowUpSuggestions(store, actors.executive, answer.conversationId, answer.assistantMessageId);

    expect(response).toMatchObject({ status: 'none', items: [] });
    expect(JSON.stringify(response)).not.toContain('C01');
  });

  it('suppresses an answer from a renewed session', async () => {
    const { store, service } = await setup();
    const answer = await askRegion(store, service, 'east');
    const renewedSessionId = 'test-session-executive-renewed';
    await store.transaction(tx => tx.put('sessions', {
      id: renewedSessionId,
      profileId: actors.executive.id,
      mode: actors.executive.mode,
      modeRevision: actors.executive.modeRevision,
      csrfToken: 'renewed-session-csrf',
      expiresAt: '2099-01-01T00:00:00.000Z',
    }));

    const response = await getFollowUpSuggestions(store, { ...actors.executive, sessionId: renewedSessionId }, answer.conversationId, answer.assistantMessageId);

    expect(response).toMatchObject({ status: 'none', items: [] });
  });

  it('suppresses an answer created before the current session mode revision', async () => {
    const { store, service, patchSession } = await setup();
    const answer = await askRegion(store, service, 'east');
    await patchSession(actors.executive.sessionId, { mode: 'live_ai', modeRevision: actors.executive.modeRevision + 1 });

    const response = await getFollowUpSuggestions(store, actors.executive, answer.conversationId, answer.assistantMessageId);

    expect(response).toMatchObject({ status: 'none', items: [] });
  });

  it('suppresses suggestions after the current profile loses required read permission', async () => {
    const { store, service } = await setup();
    const answer = await askRegion(store, service, 'east');
    const profile = await store.get<Profile>('profiles', actors.executive.id);
    if (!profile) throw new Error('The executive fixture profile is missing.');
    await store.transaction(tx => tx.put('profiles', {
      ...profile,
      permissions: profile.permissions.filter(permission => permission !== 'sales.read'),
    }));

    const response = await getFollowUpSuggestions(store, actors.executive, answer.conversationId, answer.assistantMessageId);

    expect(response).toMatchObject({ status: 'none', items: [] });
  });

  it('hides a conversation owned by another actor and returns no items for a cross-conversation anchor', async () => {
    const { store, service } = await setup();
    const answer = await askRegion(store, service, 'east');
    await expect(getFollowUpSuggestions(store, actors.east, answer.conversationId, answer.assistantMessageId))
      .rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    const other = await createConversation(store, actors.executive.id, 'Other conversation');

    const response = await getFollowUpSuggestions(store, actors.executive, other.id, answer.assistantMessageId);

    expect(response).toMatchObject({ status: 'none', conversationId: other.id, items: [] });
  });

  it('returns data_unavailable for known ownership and completion-proof read outages', async () => {
    const { store, service } = await setup();
    const answer = await askRegion(store, service, 'east');
    const ownerOutage = withReadFailure(store, table => table === 'conversations');
    const unavailableOwner = await getFollowUpSuggestions(ownerOutage, actors.executive, answer.conversationId, answer.assistantMessageId);
    expect(unavailableOwner).toMatchObject({ status: 'data_unavailable', items: [] });

    const turnId = answer.turnId;
    const completionId = turnCompletionId({
      actorId: actors.executive.id,
      sessionId: actors.executive.sessionId,
      conversationId: answer.conversationId,
      turnId,
    });
    let completionReads = 0;
    const proofOutage = withReadFailure(store, (table, id) => {
      if (table !== 'tool_executions' || id !== completionId) return false;
      completionReads += 1;
      return completionReads === 2;
    });
    const unavailableProof = await getFollowUpSuggestions(proofOutage, actors.executive, answer.conversationId, answer.assistantMessageId);
    expect(completionReads).toBeGreaterThanOrEqual(2);
    expect(unavailableProof).toMatchObject({ status: 'data_unavailable', items: [] });
  });

  it('returns no suggestions for empty, in-progress, or failed turns', async () => {
    const { store } = await setup();
    const empty = await createConversation(store, actors.executive.id, 'Empty conversation');
    const emptyResponse = await getFollowUpSuggestions(store, actors.executive, empty.id, 'message-empty-anchor');
    expect(emptyResponse).toMatchObject({ status: 'none', items: [] });

    for (const status of ['started', 'failed'] as const) {
      const conversation = await createConversation(store, actors.executive.id, `${status} conversation`);
      const tuple: TurnCompletionTuple = {
        actorId: actors.executive.id,
        sessionId: actors.executive.sessionId,
        conversationId: conversation.id,
        turnId: `turn-${status}-followups`,
        mode: actors.executive.mode,
        modeRevision: actors.executive.modeRevision,
      };
      const createdAt = new Date().toISOString();
      const assistantCreatedAt = new Date(Date.parse(createdAt) + 1_000).toISOString();
      const assistantId = assistantMessageId(tuple.actorId, tuple);
      const user: ConversationMessage = {
        id: tuple.turnId, ...tuple, role: 'user', text: 'Read the latest sales.', createdAt,
      };
      const assistant: ConversationMessage = {
        id: assistantId, ...tuple, role: 'assistant', text: 'An unfinished answer.', createdAt: assistantCreatedAt,
      };
      const completion = turnCompletionRecordSchema.parse({
        ...tuple,
        id: turnCompletionId(tuple),
        name: 'chat.turn_completion',
        schemaVersion: 1,
        origin: 'chat',
        requestLedgerId: `request-${status}-followups`,
        status,
        createdAt,
      });
      await store.transaction(async tx => {
        await tx.put('conversation_messages', user);
        await tx.put('conversation_messages', assistant);
        await tx.put('tool_executions', completion);
      });

      const response = await getFollowUpSuggestions(store, actors.executive, conversation.id, assistant.id);
      expect(response.status).not.toBe('ready');
      expect(response.items).toEqual([]);
    }
  });

  it('does not derive suggestions from a pending action before or after completion', async () => {
    const { store, service, answer, action, actor } = await prepareDashboardAnswer();
    const pending = await getFollowUpSuggestions(store, actor, answer.conversationId, answer.assistantMessageId);
    expect(pending.items.every(item => !item.id.startsWith('pending-review:'))).toBe(true);
    expect(pending.items.every(item => item.consequence === 'read' || item.consequence === 'analyze')).toBe(true);
    expect((await store.get<typeof action>('pending_actions', action.id))?.status).toBe('pending');

    await service.confirm(actor, action.id);
    const completed = await getFollowUpSuggestions(store, actor, answer.conversationId, answer.assistantMessageId);
    expect(completed.items.every(item => !item.id.startsWith('pending-review:'))).toBe(true);
  });

  it('does not derive a pending-action prompt when its approval hash is invalid', async () => {
    const { store, answer, action, actor } = await prepareDashboardAnswer();
    const tampered = withPendingActionOverlay(store, { ...action, payloadHash: '0'.repeat(64) });

    const response = await getFollowUpSuggestions(tampered, actor, answer.conversationId, answer.assistantMessageId);

    expect((await store.get<typeof action>('pending_actions', action.id))?.status).toBe('pending');
    expect(response.items.every(item => !item.id.startsWith('pending-review:'))).toBe(true);
    expect(response.items.every(item => item.consequence === 'read' || item.consequence === 'analyze')).toBe(true);
  });

  it('does not derive a pending-action prompt after its evidence version drifts', async () => {
    const { store, answer, action, actor } = await prepareDashboardAnswer();
    const scope = action.approvalScope;
    if (!scope) throw new Error('The dashboard action is missing its approved evidence scope.');
    const sale = await store.get<SalesOrder>('sales_orders', 'SO-E02-PAID');
    if (!sale) throw new Error('The East sales fixture is missing.');
    await store.transaction(tx => tx.put('sales_orders', { ...sale, amountSatang: sale.amountSatang + 100 }));
    const refreshedEvidence = await readEvidence(store, actor, scope, FIXED_NOW);
    expect(refreshedEvidence.version).not.toBe(action.evidenceVersion);

    const response = await getFollowUpSuggestions(store, actor, answer.conversationId, answer.assistantMessageId);

    expect((await store.get<typeof action>('pending_actions', action.id))?.status).toBe('pending');
    expect(response.items.every(item => !item.id.startsWith('pending-review:'))).toBe(true);
    expect(response.items.every(item => item.consequence === 'read' || item.consequence === 'analyze')).toBe(true);
  });
});
