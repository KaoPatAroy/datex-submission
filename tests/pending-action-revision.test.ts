import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PendingAction, Profile, RowFilter, Store, Table, Transaction } from '../lib/contracts';
import { cancelPendingActionRequestSchema, revisePendingActionRequestSchema } from '../lib/core/action-revision';
import { BOOKKEEPING_MAX_RETRIES, ConciergeService } from '../lib/core/service';
import { actors, CLOSED_BUSINESS_DATE, createWorkspaceFixture, dashboardPayload, FIXED_NOW } from './helpers/workspace';

type Fixture = Awaited<ReturnType<typeof createWorkspaceFixture>>;
const REQUEST_KEY = 'revision-request-key-0001';
const SAME_SPEC_OTHER_KEY = 'revision-request-key-0002';
const DIFFERENT_SPEC_KEY = 'revision-request-key-0003';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function revisionPatch() {
  return {
    title: 'Reviewed East sales and staffing',
    widgetChange: { operation: 'remove' as const, indexes: [2] },
  };
}

function payloadWithStaffing() {
  const payload = dashboardPayload();
  return {
    ...payload,
    spec: {
      ...payload.spec,
      widgets: [
        ...payload.spec.widgets,
        { type: 'table' as const, title: 'Staffing coverage', dataset: 'staffing' as const },
      ],
    },
  };
}

function failWhenSuperseding(base: Store, predecessorId: string): { store: Store; failures(): number } {
  let failures = 0;
  const store: Store = {
    adapter: base.adapter,
    list<T>(table: Table, filters?: RowFilter) { return base.list<T>(table, filters); },
    get<T>(table: Table, id: string) { return base.get<T>(table, id); },
    transaction<T>(work: (tx: Transaction) => Promise<T>) {
      return base.transaction(tx => work({
        list: <R>(table: Table, filters?: RowFilter) => tx.list<R>(table, filters),
        get: <R>(table: Table, id: string) => tx.get<R>(table, id),
        async put<R extends { id: string }>(table: Table, row: R) {
          const action = row as Partial<PendingAction>;
          if (table === 'pending_actions' && row.id === predecessorId
            && action.status === 'stale' && action.supersededByActionId) {
            failures += 1;
            throw new Error('Injected failure while finalizing predecessor supersession.');
          }
          await tx.put(table, row);
        },
        remove: (table: Table, id: string) => tx.remove(table, id),
      }));
    },
    close: () => base.close?.(),
  };
  return { store, failures: () => failures };
}

type SuccessorState = 'pending' | 'claimed' | 'completed' | 'stale';

async function prepareSuccessorInState(fixture: Fixture, status: SuccessorState) {
  const predecessor = await fixture.service.prepare(actors.executive, payloadWithStaffing());
  const patch = { ...revisionPatch(), scope: { region: 'central', branchIds: ['C01'] } };
  const revised = await fixture.service.revisePendingAction(actors.executive, predecessor.id, patch, REQUEST_KEY);

  if (status === 'claimed') {
    await fixture.store.transaction(async tx => {
      const action = await tx.get<PendingAction>('pending_actions', revised.replacement.id);
      if (!action) throw new Error('The revised dashboard action is missing.');
      await tx.put('pending_actions', { ...action, status: 'claimed' });
      await tx.put('action_executions', {
        id: `execution_${action.id}`,
        actionId: action.id,
        actorId: action.actorId,
        kind: 'dashboard_create',
        status: 'pending',
        results: [{ targetId: 'artifact', id: null, status: 'pending', detail: 'Simulated in-flight dashboard effect.' }],
        createdAt: FIXED_NOW.toISOString(),
        verifiedAt: null,
      });
    });
    const receipt = await fixture.service.confirm(actors.executive, revised.replacement.id);
    expect(receipt.status).toBe('pending');
  } else if (status === 'completed') {
    await fixture.service.confirm(actors.executive, revised.replacement.id);
  } else if (status === 'stale') {
    await fixture.service.cancelPendingAction(actors.executive, revised.replacement.id);
  }

  const replacement = await fixture.store.get<PendingAction>('pending_actions', revised.replacement.id);
  if (!replacement) throw new Error('The revised dashboard action is missing.');
  expect(replacement.status).toBe(status);
  return { predecessor, replacement, service: fixture.service };
}

type ActionWriteGate = 'supersede' | 'cancel' | 'claim';

function gateActionWrite(base: Store, actionId: string, point: ActionWriteGate) {
  const writeReached = deferred<void>();
  const competingCallObserved = deferred<void>();
  const releaseWrite = deferred<void>();
  let holdingFirstWrite = false;
  let intercepted = false;
  let observedCompetingCall = false;
  const observeCompetingCall = () => {
    if (!holdingFirstWrite || observedCompetingCall) return;
    observedCompetingCall = true;
    competingCallObserved.resolve(undefined);
  };
  const matchesPoint = (action: Partial<PendingAction>) => point === 'claim'
    ? action.status === 'claimed'
    : action.status === 'stale' && action.staleReason === (point === 'supersede' ? 'superseded' : 'user_cancelled');
  const store: Store = {
    adapter: base.adapter,
    list<T>(table: Table, filters?: RowFilter) { return base.list<T>(table, filters); },
    get<T>(table: Table, id: string) {
      observeCompetingCall();
      return base.get<T>(table, id);
    },
    transaction<T>(work: (tx: Transaction) => Promise<T>) {
      observeCompetingCall();
      return base.transaction(tx => work({
        list: <R>(table: Table, filters?: RowFilter) => tx.list<R>(table, filters),
        get: <R>(table: Table, id: string) => tx.get<R>(table, id),
        async put<R extends { id: string }>(table: Table, row: R) {
          const action = row as Partial<PendingAction>;
          if (!intercepted && table === 'pending_actions' && row.id === actionId && matchesPoint(action)) {
            intercepted = true;
            holdingFirstWrite = true;
            writeReached.resolve(undefined);
            await releaseWrite.promise;
            holdingFirstWrite = false;
          }
          await tx.put(table, row);
        },
        remove: (table: Table, id: string) => tx.remove(table, id),
      }));
    },
    close: () => base.close?.(),
  };
  return {
    store,
    writeReached: writeReached.promise,
    competingCallObserved: competingCallObserved.promise,
    release() { releaseWrite.resolve(undefined); },
  };
}

describe('direct pending dashboard revision and cancellation', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await createWorkspaceFixture();
  });

  afterEach(async () => {
    await fixture.dispose();
  });

  it('keeps request bodies strict and accepts only the explicit revision/cancel contract', () => {
    expect(revisePendingActionRequestSchema.safeParse({ requestKey: REQUEST_KEY, patch: revisionPatch() }).success).toBe(true);
    expect(revisePendingActionRequestSchema.safeParse({ requestKey: REQUEST_KEY, patch: revisionPatch(), actorId: 'executive' }).success).toBe(false);
    expect(cancelPendingActionRequestSchema.safeParse({}).success).toBe(true);
    expect(cancelPendingActionRequestSchema.safeParse({ status: 'cancelled' }).success).toBe(false);
  });

  it('atomically supersedes A with a fresh B, preserves unedited fields, and writes only after B is confirmed', async () => {
    const service = fixture.service;
    const originalPayload = payloadWithStaffing();
    const predecessor = await service.prepare(actors.executive, originalPayload);
    const originalHash = predecessor.payloadHash;
    await fixture.setNow(new Date(FIXED_NOW.getTime() + 30_000));

    expect(await fixture.store.list('dashboards')).toEqual([]);
    expect(await fixture.store.list('action_executions')).toEqual([]);

    const result = await service.revisePendingAction(actors.executive, predecessor.id, revisionPatch(), REQUEST_KEY);

    expect(result.predecessor).toMatchObject({
      id: predecessor.id,
      status: 'stale',
      staleReason: 'superseded',
      supersededByActionId: result.replacement.id,
      payloadHash: originalHash,
    });
    expect(result.replacement).toMatchObject({
      status: 'pending',
      predecessorActionId: predecessor.id,
      payload: {
        kind: 'dashboard_create',
        spec: {
          title: revisionPatch().title,
          description: originalPayload.spec.description,
          scope: originalPayload.spec.scope,
          widgets: originalPayload.spec.widgets.slice(0, 2),
        },
      },
    });
    expect(result.replacement.id).not.toBe(predecessor.id);
    expect(result.replacement.payloadHash).not.toBe(originalHash);
    expect(result.replacement.createdAt).not.toBe(predecessor.createdAt);
    expect(Date.parse(result.replacement.expiresAt)).toBeGreaterThan(Date.parse(predecessor.expiresAt));
    expect(result.diff.length).toBeGreaterThan(0);
    expect(result.diff.join('\n')).toContain('เปลี่ยนชื่อ');
    expect(result.diff.join('\n')).toContain('ลบ');
    expect(result.replacement.revisionDiff).toEqual(result.diff);
    expect(await fixture.store.list('dashboards')).toEqual([]);
    expect(await fixture.store.list('action_executions')).toEqual([]);

    await expect(service.confirm(actors.executive, predecessor.id))
      .rejects.toMatchObject({ code: 'STALE_ACTION' });
    expect(await fixture.store.list('dashboards')).toEqual([]);
    expect(await fixture.store.list('action_executions')).toEqual([]);

    await service.confirm(actors.executive, result.replacement.id);
    expect(await fixture.store.list('dashboards')).toHaveLength(1);
    expect(await fixture.store.list('action_executions')).toHaveLength(1);
    await service.confirm(actors.executive, result.replacement.id);
    expect(await fixture.store.list('dashboards')).toHaveLength(1);
    expect(await fixture.store.list('action_executions')).toHaveLength(1);
  });

  it('replays equivalent revision requests to the same replacement and rejects a conflicting patch', async () => {
    const predecessor = await fixture.service.prepare(actors.executive, payloadWithStaffing());
    const [first, replay] = await Promise.all([
      fixture.service.revisePendingAction(actors.executive, predecessor.id, revisionPatch(), REQUEST_KEY),
      fixture.service.revisePendingAction(actors.executive, predecessor.id, revisionPatch(), REQUEST_KEY),
    ]);
    const equivalent = await fixture.service.revisePendingAction(actors.executive, predecessor.id, revisionPatch(), SAME_SPEC_OTHER_KEY);

    expect(replay.replacement.id).toBe(first.replacement.id);
    expect(equivalent.replacement.id).toBe(first.replacement.id);
    await expect(fixture.service.revisePendingAction(actors.executive, predecessor.id, {
      ...revisionPatch(), title: 'A different revised title',
    }, DIFFERENT_SPEC_KEY)).rejects.toMatchObject({ code: 'ACTION_REVISION_CONFLICT' });
    expect(await fixture.store.list('pending_actions', { actorId: actors.executive.id })).toHaveLength(2);
  });

  it.each(['fresh', 'replay'] as const)(
    'checks current scope before returning a no-op patch error for a %s revision', async flow => {
      const predecessor = await fixture.service.prepare(actors.executive, payloadWithStaffing());
      if (flow === 'replay') {
        await fixture.service.revisePendingAction(actors.executive, predecessor.id, revisionPatch(), REQUEST_KEY);
      }
      const noOpPatch = { scope: { region: 'east' } };

      await expect(fixture.service.revisePendingAction(actors.executive, predecessor.id, noOpPatch, SAME_SPEC_OTHER_KEY))
        .rejects.toMatchObject({ code: 'INVALID_REVISION' });

      const profile = await fixture.store.get<Profile>('profiles', actors.executive.id);
      if (!profile) throw new Error('The executive fixture profile is missing.');
      await fixture.store.transaction(tx => tx.put('profiles', { ...profile, regions: ['central'] }));
      const actionsBefore = await fixture.store.list('pending_actions', { actorId: actors.executive.id });
      const dashboardsBefore = await fixture.store.list('dashboards');
      const receiptsBefore = await fixture.store.list('action_executions');

      await expect(fixture.service.revisePendingAction(actors.executive, predecessor.id, noOpPatch, SAME_SPEC_OTHER_KEY))
        .rejects.toMatchObject({ code: 'FORBIDDEN' });

      expect(await fixture.store.list('pending_actions', { actorId: actors.executive.id })).toEqual(actionsBefore);
      expect(await fixture.store.list('dashboards')).toEqual(dashboardsBefore);
      expect(await fixture.store.list('action_executions')).toEqual(receiptsBefore);
    },
  );

  it.each(['pending', 'claimed', 'completed', 'stale'] as const)(
    'requires current access to the predecessor when replaying a %s successor', async status => {
      const { predecessor, replacement, service } = await prepareSuccessorInState(fixture, status);
      const authorizedReplay = await service.revisePendingAction(actors.executive, predecessor.id, {
        ...revisionPatch(), scope: { region: 'central', branchIds: ['C01'] },
      }, REQUEST_KEY);
      expect(authorizedReplay.replacement).toMatchObject({ id: replacement.id, status });

      const profile = await fixture.store.get<Profile>('profiles', actors.executive.id);
      if (!profile) throw new Error('The executive fixture profile is missing.');
      expect(profile.permissions).toContain('dashboard.create');
      expect(profile.permissions).toContain('sales.read');
      await fixture.store.transaction(tx => tx.put('profiles', { ...profile, regions: ['central'] }));

      const dashboardsBefore = await fixture.store.list('dashboards');
      const receiptsBefore = await fixture.store.list('action_executions');
      await expect(service.revisePendingAction(actors.executive, predecessor.id, {
        ...revisionPatch(), scope: { region: 'central', branchIds: ['C01'] },
      }, REQUEST_KEY)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(service.revisePendingAction(actors.executive, predecessor.id, {
        ...revisionPatch(), title: 'Another valid dashboard title', scope: { region: 'central', branchIds: ['C01'] },
      }, REQUEST_KEY)).rejects.toMatchObject({ code: 'FORBIDDEN' });

      expect(await fixture.store.get<PendingAction>('pending_actions', predecessor.id)).toMatchObject({
        status: 'stale', staleReason: 'superseded', supersededByActionId: replacement.id,
      });
      expect(await fixture.store.get<PendingAction>('pending_actions', replacement.id)).toMatchObject({ id: replacement.id, status });
      expect(await fixture.store.list('dashboards')).toEqual(dashboardsBefore);
      expect(await fixture.store.list('action_executions')).toEqual(receiptsBefore);
    },
  );

  it.each(['pending', 'claimed', 'completed', 'stale'] as const)(
    'requires current access to the successor when replaying a %s successor', async status => {
      const { predecessor, replacement, service } = await prepareSuccessorInState(fixture, status);
      const profile = await fixture.store.get<Profile>('profiles', actors.executive.id);
      if (!profile) throw new Error('The executive fixture profile is missing.');
      await fixture.store.transaction(tx => tx.put('profiles', { ...profile, regions: ['east'] }));

      const dashboardsBefore = await fixture.store.list('dashboards');
      const receiptsBefore = await fixture.store.list('action_executions');
      await expect(service.revisePendingAction(actors.executive, predecessor.id, {
        ...revisionPatch(), scope: { region: 'central', branchIds: ['C01'] },
      }, REQUEST_KEY)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(service.revisePendingAction(actors.executive, predecessor.id, {
        ...revisionPatch(), title: 'Another valid dashboard title', scope: { region: 'central', branchIds: ['C01'] },
      }, REQUEST_KEY)).rejects.toMatchObject({ code: 'FORBIDDEN' });

      expect(await fixture.store.get<PendingAction>('pending_actions', predecessor.id)).toMatchObject({
        status: 'stale', staleReason: 'superseded', supersededByActionId: replacement.id,
      });
      expect(await fixture.store.get<PendingAction>('pending_actions', replacement.id)).toMatchObject({ id: replacement.id, status });
      expect(await fixture.store.list('dashboards')).toEqual(dashboardsBefore);
      expect(await fixture.store.list('action_executions')).toEqual(receiptsBefore);
    },
  );

  it('rolls back a fresh proposal and completed anchor if finalizing the predecessor fails', async () => {
    const predecessor = await fixture.service.prepare(actors.executive, payloadWithStaffing());
    const messagesBefore = (await fixture.store.list<{ conversationId: string }>('conversation_messages'))
      .filter(message => message.conversationId === predecessor.conversationId);
    const completionsBefore = (await fixture.store.list<{ name?: string }>('tool_executions'))
      .filter(record => record.name === 'chat.turn_completion');
    const auditsBefore = await fixture.store.list('audit_events');
    const injected = failWhenSuperseding(fixture.store, predecessor.id);
    const service = new ConciergeService(injected.store, {
      businessDate: CLOSED_BUSINESS_DATE, now: () => new Date(FIXED_NOW),
    });

    await expect(service.revisePendingAction(actors.executive, predecessor.id, revisionPatch(), REQUEST_KEY))
      .rejects.toMatchObject({ code: 'STORAGE', definitelyNotCommitted: true });
    expect(injected.failures()).toBe(BOOKKEEPING_MAX_RETRIES + 1);

    expect(await fixture.store.get<PendingAction>('pending_actions', predecessor.id)).toMatchObject({
      status: 'pending', payloadHash: predecessor.payloadHash,
    });
    expect(await fixture.store.list('pending_actions', { actorId: actors.executive.id })).toHaveLength(1);
    expect((await fixture.store.list<{ conversationId: string }>('conversation_messages'))
      .filter(message => message.conversationId === predecessor.conversationId)).toEqual(messagesBefore);
    expect((await fixture.store.list<{ name?: string }>('tool_executions'))
      .filter(record => record.name === 'chat.turn_completion')).toEqual(completionsBefore);
    expect(await fixture.store.list('audit_events')).toEqual(auditsBefore);
    expect(await fixture.store.list('dashboards')).toEqual([]);
    expect(await fixture.store.list('action_executions')).toEqual([]);
  });

  it('cancels without deleting or executing the action, and treats a repeated cancel as the same result', async () => {
    const action = await fixture.service.prepare(actors.executive, dashboardPayload());
    const [cancelled, repeated] = await Promise.all([
      fixture.service.cancelPendingAction(actors.executive, action.id),
      fixture.service.cancelPendingAction(actors.executive, action.id),
    ]);

    expect(cancelled).toMatchObject({ id: action.id, status: 'stale', staleReason: 'user_cancelled' });
    expect(repeated).toEqual(cancelled);
    expect(await fixture.store.get<PendingAction>('pending_actions', action.id)).toEqual(cancelled);
    expect(await fixture.store.list('pending_actions', { actorId: actors.executive.id })).toHaveLength(1);
    expect(await fixture.store.list('action_executions')).toEqual([]);
    expect(await fixture.store.list('dashboards')).toEqual([]);
    expect((await fixture.store.list<{ category: string; summary: string }>('audit_events'))
      .filter(event => event.category === 'cancel' && event.summary === 'user_cancelled')).toHaveLength(1);
    await expect(fixture.service.confirm(actors.executive, action.id)).rejects.toMatchObject({ code: 'STALE_ACTION' });
    expect(await fixture.store.list('dashboards')).toEqual([]);
  });

  it('allows exactly one winner when confirmation races with revision', async () => {
    const predecessor = await fixture.service.prepare(actors.executive, payloadWithStaffing());
    const results = await Promise.allSettled([
      fixture.service.confirm(actors.executive, predecessor.id),
      fixture.service.revisePendingAction(actors.executive, predecessor.id, revisionPatch(), REQUEST_KEY),
    ]);
    const fulfilled = results.filter(result => result.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    if (fulfilled[0]?.status === 'fulfilled' && 'replacement' in fulfilled[0].value) {
      expect(await fixture.store.list('dashboards')).toEqual([]);
      expect(await fixture.store.list('action_executions')).toEqual([]);
      expect(await fixture.store.get<PendingAction>('pending_actions', predecessor.id)).toMatchObject({
        status: 'stale', staleReason: 'superseded',
      });
    } else {
      expect(await fixture.store.list('dashboards')).toHaveLength(1);
      expect(await fixture.store.list('action_executions')).toHaveLength(1);
      expect(await fixture.store.get<PendingAction>('pending_actions', predecessor.id)).toMatchObject({ status: 'claimed' });
    }
  });

  it('allows exactly one winner when confirmation races with cancellation', async () => {
    const action = await fixture.service.prepare(actors.executive, dashboardPayload());
    const results = await Promise.allSettled([
      fixture.service.confirm(actors.executive, action.id),
      fixture.service.cancelPendingAction(actors.executive, action.id),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const stored = await fixture.store.get<PendingAction>('pending_actions', action.id);
    expect(stored?.status === 'claimed' || stored?.staleReason === 'user_cancelled').toBe(true);
    expect(await fixture.store.list('dashboards')).toHaveLength(stored?.status === 'claimed' ? 1 : 0);
    expect(await fixture.store.list('action_executions')).toHaveLength(stored?.status === 'claimed' ? 1 : 0);
  });

  it.each([
    {
      label: 'revision commits before confirmation', first: 'revision' as const, second: 'confirm' as const,
      gate: 'supersede' as const, losingCode: 'STALE_ACTION',
    },
    {
      label: 'confirmation claims before revision', first: 'confirm' as const, second: 'revision' as const,
      gate: 'claim' as const, losingCode: 'STALE_ACTION',
    },
    {
      label: 'cancellation commits before confirmation', first: 'cancel' as const, second: 'confirm' as const,
      gate: 'cancel' as const, losingCode: 'STALE_ACTION',
    },
    {
      label: 'confirmation claims before cancellation', first: 'confirm' as const, second: 'cancel' as const,
      gate: 'claim' as const, losingCode: 'ACTION_NOT_CANCELLABLE',
    },
  ])('deterministically orders concurrent calls: $label', async ({ first, second, gate: gatePoint, losingCode }) => {
    const revisionParticipates = first === 'revision' || second === 'revision';
    const payload = revisionParticipates ? payloadWithStaffing() : dashboardPayload();
    const predecessor = await fixture.service.prepare(actors.executive, payload);
    const gate = gateActionWrite(fixture.store, predecessor.id, gatePoint);
    const service = new ConciergeService(gate.store, {
      businessDate: CLOSED_BUSINESS_DATE,
      now: () => new Date(FIXED_NOW),
    });
    const start = (operation: 'revision' | 'cancel' | 'confirm'): Promise<unknown> => {
      if (operation === 'revision') return service.revisePendingAction(actors.executive, predecessor.id, revisionPatch(), REQUEST_KEY);
      if (operation === 'cancel') return service.cancelPendingAction(actors.executive, predecessor.id);
      return service.confirm(actors.executive, predecessor.id);
    };

    const firstPromise = start(first);
    void firstPromise.catch(() => undefined);
    let secondPromise: Promise<unknown> | undefined;
    let secondSettled = false;
    try {
      const firstGate = await Promise.race([
        gate.writeReached.then(() => 'write-blocked' as const),
        firstPromise.then(() => 'settled-before-gate' as const, () => 'settled-before-gate' as const),
      ]);
      expect(firstGate).toBe('write-blocked');
      secondPromise = start(second);
      void secondPromise.then(() => { secondSettled = true; }, () => { secondSettled = true; });
      const competingGate = await Promise.race([
        gate.competingCallObserved.then(() => 'competing-call-observed' as const),
        secondPromise.then(() => 'settled-before-queue' as const, () => 'settled-before-queue' as const),
      ]);
      expect(competingGate).toBe('competing-call-observed');
      expect(secondSettled).toBe(false);
    } finally {
      gate.release();
    }
    if (!secondPromise) throw new Error('The competing action operation was not started.');

    const [firstResult, secondResult] = await Promise.allSettled([firstPromise, secondPromise]);
    expect(firstResult.status).toBe('fulfilled');
    expect(secondResult.status).toBe('rejected');
    if (secondResult.status === 'rejected') expect(secondResult.reason).toMatchObject({ code: losingCode });

    const storedPredecessor = await fixture.store.get<PendingAction>('pending_actions', predecessor.id);
    const actions = await fixture.store.list<PendingAction>('pending_actions', { actorId: actors.executive.id });
    const dashboards = await fixture.store.list<Record<string, unknown> & { id: string }>('dashboards');
    const receipts = await fixture.store.list<Record<string, unknown> & { actionId?: string; status?: string }>('action_executions');
    if (first === 'revision') {
      expect(storedPredecessor).toMatchObject({ status: 'stale', staleReason: 'superseded' });
      const replacementId = storedPredecessor?.supersededByActionId;
      expect(replacementId).toBeDefined();
      const replacement = replacementId
        ? await fixture.store.get<PendingAction>('pending_actions', replacementId)
        : undefined;
      expect(replacement).toMatchObject({ status: 'pending', predecessorActionId: predecessor.id });
      expect(actions).toHaveLength(2);
      expect(actions.filter(action => action.predecessorActionId === predecessor.id)).toHaveLength(1);
      expect(dashboards).toEqual([]);
      expect(receipts).toEqual([]);
    } else if (first === 'cancel') {
      expect(storedPredecessor).toMatchObject({ status: 'stale', staleReason: 'user_cancelled' });
      expect(storedPredecessor?.supersededByActionId).toBeUndefined();
      expect(actions).toHaveLength(1);
      expect(dashboards).toEqual([]);
      expect(receipts).toEqual([]);
    } else {
      expect(storedPredecessor).toMatchObject({ status: 'completed' });
      expect(actions).toHaveLength(1);
      expect(dashboards).toHaveLength(1);
      expect(new Set(dashboards.map(dashboard => dashboard.id)).size).toBe(1);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({ actionId: predecessor.id, status: 'verified_success' });
    }
  });

  it('revalidates current scope and permission and rejects expired or unsupported revisions without orphan actions', async () => {
    const eastAction = await fixture.service.prepare(actors.east, dashboardPayload());
    await expect(fixture.service.revisePendingAction(actors.east, eastAction.id, {
      scope: { region: 'central', branchIds: ['C01'] },
    }, REQUEST_KEY)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await fixture.store.list('pending_actions', { actorId: actors.east.id })).toHaveLength(1);

    const executiveAction = await fixture.service.prepare(actors.executive, payloadWithStaffing());
    const executiveProfile = await fixture.store.get<Profile>('profiles', actors.executive.id);
    if (!executiveProfile) throw new Error('The executive fixture profile is missing.');
    await fixture.store.transaction(tx => tx.put('profiles', {
      ...executiveProfile,
      permissions: executiveProfile.permissions.filter(permission => permission !== 'dashboard.create'),
    }));
    await expect(fixture.service.revisePendingAction(actors.executive, executiveAction.id, revisionPatch(), SAME_SPEC_OTHER_KEY))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await fixture.store.list('pending_actions', { actorId: actors.executive.id })).toHaveLength(1);
  });

  it('rejects expired predecessor actions and unsupported action kinds without mutation', async () => {
    const dashboardAction = await fixture.service.prepare(actors.executive, payloadWithStaffing());
    await fixture.setNow(new Date(FIXED_NOW.getTime() + 25 * 60 * 60_000));
    await expect(fixture.service.revisePendingAction(actors.executive, dashboardAction.id, revisionPatch(), REQUEST_KEY))
      .rejects.toMatchObject({ code: 'EXPIRED_ACTION' });
    expect(await fixture.store.get<PendingAction>('pending_actions', dashboardAction.id)).toMatchObject({ status: 'pending' });

    const service = fixture.service;
    const evidence = await service.queryEvidence(actors.executive, {
      region: 'east', date: CLOSED_BUSINESS_DATE, branchIds: ['E02'],
    });
    const branch = evidence.branches[0];
    if (!branch) throw new Error('The synthetic East branch evidence is missing.');
    const ticket = await service.prepare(actors.executive, {
      kind: 'ticket_create', scope: evidence.scope, targets: [{
        branchId: branch.branchId, assigneeId: 'E024', title: 'Review sales follow-up',
        reason: 'Synthetic fixture; no causal claim.', sourceIds: [...branch.sourceIds],
        unansweredQuestion: 'Which follow-up is required?',
      }],
    });
    await expect(service.revisePendingAction(actors.executive, ticket.id, { title: 'Not supported' }, SAME_SPEC_OTHER_KEY))
      .rejects.toMatchObject({ code: 'ACTION_REVISION_UNSUPPORTED' });
    expect(await fixture.store.list('pending_actions', { actorId: actors.executive.id })).toHaveLength(2);
  });

  it('rejects widgets the active dashboard renderer cannot display', async () => {
    const action = await fixture.service.prepare(actors.executive, dashboardPayload());
    await expect(fixture.service.revisePendingAction(actors.executive, action.id, {
      widgetChange: {
        operation: 'add', index: 2,
        widgets: [{ type: 'table', title: 'Stock detail', dataset: 'inventory' }],
      },
    }, REQUEST_KEY)).rejects.toMatchObject({ code: 'UNSUPPORTED_WIDGET' });
    expect(await fixture.store.get<PendingAction>('pending_actions', action.id)).toMatchObject({ status: 'pending' });
    expect(await fixture.store.list('pending_actions', { actorId: actors.executive.id })).toHaveLength(1);
  });
});
