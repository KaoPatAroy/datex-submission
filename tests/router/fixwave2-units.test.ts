import { describe, expect, it } from 'vitest';
import { createSqliteStore } from '@/lib/storage/sqlite';
import { confirmProposal, executeActionStep, type ActionExecutorInput } from '@/lib/router/executors/action';
import { STAGED_CLAIM_LEASE_MS, createStagedStore } from '@/lib/router/storage/staged-store';
import { CONVERSATION, eastActor, fakePorts, grounded, NOW, TURN } from './executors/action-fixtures';

/** Real staged store over SQLite with a controllable clock, behind the fake action ports. */
async function setup() {
  const clock = { ms: NOW().getTime() };
  const store = createSqliteStore(':memory:');
  const staged = createStagedStore(store, { now: () => clock.ms });
  await store.transaction(tx => tx.put('profiles', { id: 'p', name: 'p', role: 'executive', active: true, regions: ['east'], permissions: [] } as never));
  await store.transaction(tx => tx.put('sessions', { id: 's', profileId: 'p', mode: 'live_ai', modeRevision: 1, csrfToken: 'test-csrf-token', expiresAt: '2099-01-01T00:00:00.000Z' } as never));
  await store.transaction(tx => tx.put('sessions', { id: 's1', profileId: 'p', mode: 'live_ai', modeRevision: 1, csrfToken: 'test-csrf-token', expiresAt: '2099-01-01T00:00:00.000Z' } as never));
  const f = fakePorts();
  f.ports.staged = staged;
  f.ports.getDashboard = async (_a, id) => f.state.dashboards.get(id);
  const input: ActionExecutorInput = { ports: f.ports, actor: eastActor(), conversationId: CONVERSATION, turnId: TURN, now: () => new Date(clock.ms), step: grounded('dashboard.delete', { dashboard: 'D1' }) };
  const created = await executeActionStep(input);
  const id = created.outcome === 'proposed' ? created.ids!.pendingActionId! : '';
  const confirm = (actor = eastActor()) => confirmProposal({ ports: f.ports, actor, proposalId: id, now: () => new Date(clock.ms) });
  return { clock, store, staged, f, id, confirm };
}

describe('G1 claim ownership is fenced by a claim token', () => {
  it('a superseded claimant cannot overwrite the newer claim; only the current token finishes the row', async () => {
    const env = await setup();
    const first = (await env.staged.claim(eastActor(), env.id))!;
    env.clock.ms += STAGED_CLAIM_LEASE_MS + 1;
    const second = (await env.staged.claim(eastActor(), env.id))!;
    expect(first.claimToken).toBeTruthy();
    expect(second.claimToken).not.toBe(first.claimToken);
    await expect(env.staged.save(eastActor(), env.id, { status: 'stale', claimToken: first.claimToken })).rejects.toMatchObject({ code: 'STAGED_CLAIM_LOST' });
    await expect(env.staged.save(eastActor(), env.id, { status: 'completed' })).rejects.toMatchObject({ code: 'STAGED_CLAIM_LOST' });
    expect((await env.staged.get(eastActor(), env.id))?.status).toBe('claimed');
    const done = await env.staged.save(eastActor(), env.id, { status: 'completed', data: { result: { text: 'ok' } }, claimToken: second.claimToken });
    expect(done).toMatchObject({ status: 'completed' });
    expect(done.claimToken).toBeUndefined();
    await expect(env.staged.save(eastActor(), env.id, { status: 'stale', data: { x: 1 }, claimToken: first.claimToken })).rejects.toBeTruthy();
    expect((await env.staged.get(eastActor(), env.id))?.status).toBe('completed');
  });

  it('overlapping live claimant + reclaimer: one effect, the final state records it, and the slow claimant returns the stored result', async () => {
    const env = await setup();
    const original = env.f.ports.deleteDashboard;
    let nested: Awaited<ReturnType<typeof env.confirm>> | undefined;
    let first = true;
    env.f.ports.deleteDashboard = async (actor, id) => {
      if (first) {
        // The first confirmer is mid-effect when its lease expires and a second confirmer reclaims and completes.
        first = false;
        env.clock.ms += STAGED_CLAIM_LEASE_MS + 1;
        nested = await env.confirm();
        return { dashboardId: id, deletedAt: 'x' }; // idempotent by operation key: this repeat changes nothing
      }
      return original(actor, id);
    };
    const result = await env.confirm();
    expect(nested).toMatchObject({ outcome: 'executed' });
    expect(result).toMatchObject({ outcome: 'executed', text: (nested as { text: string }).text });
    expect(env.f.state.calls.filter(call => call.startsWith('delete:'))).toEqual(['delete:D1']);
    const row = (await env.staged.get(eastActor(), env.id))!;
    expect(row.status).toBe('completed');
    expect((row.data.result as { text: string }).text).toBe((nested as { text: string }).text);
  });
});

describe('G2 mode change after the claim fences the effect', () => {
  it('a mode switch between the claim and the effect executes nothing and tells the truth in Thai', async () => {
    const env = await setup();
    let reloads = 0;
    // 1st reload: admission; 2nd: just before the effect (after the claim).
    env.f.ports.reloadActor = async actor => { reloads += 1; return reloads >= 2 ? { ...actor, mode: 'scripted_demo', modeRevision: 2 } : actor; };
    const result = await env.confirm();
    expect(result).toMatchObject({ outcome: 'denied', code: 'mode_changed' });
    expect(result.text).toContain('โหมดเปลี่ยนแล้ว');
    expect(env.f.state.calls.filter(call => call.startsWith('delete:'))).toEqual([]);
    expect(env.f.state.dashboards.get('D1')?.deleted).toBe(false);
    expect((await env.staged.get(eastActor(), env.id))?.status).toBe('stale');
  });

  it('the claim transaction itself re-reads the session mode revision', async () => {
    const env = await setup();
    await env.store.transaction(tx => tx.put('profiles', { id: 'p', name: 'p', role: 'executive', active: true, regions: ['east'], permissions: [] } as never));
    await env.store.transaction(tx => tx.put('sessions', { id: 's', profileId: 'p', mode: 'scripted_demo', modeRevision: 5, csrfToken: 'x', expiresAt: '2099-01-01T00:00:00.000Z' } as never));
    const row = (await env.store.get<Record<string, unknown>>('router_proposals', env.id))!;
    await env.store.transaction(tx => tx.put('router_proposals', { ...row, sessionId: 's', mode: 'live_ai', modeRevision: 1 } as never));
    expect(await env.staged.claim(eastActor(), env.id)).toBeUndefined();
    expect((await env.staged.get(eastActor(), env.id))?.status).toBe('stale');
  });
});
