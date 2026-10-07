import { describe, expect, it } from 'vitest';
import type { Actor, Profile, Store } from '@/lib/contracts';
import { createSemanticCatalog } from '@/lib/dynamic/catalog/semantic';
import { actionRegistry } from '@/lib/router/action-registry';
import { buildPlannerContext } from '@/lib/router/context/build-context';
import { createStagedStore } from '@/lib/router/storage/staged-store';
import { matchesRowFilter } from '@/lib/storage/filters';
import { actors, profiles } from '../../helpers/workspace';

const NOW = Date.parse('2026-10-06T05:00:00.000Z');
const catalog = createSemanticCatalog([
  { id: 'E02', name: 'East Two', region: 'east' }, { id: 'C01', name: 'Central One', region: 'central' },
]);
const east: Actor = { ...actors.east, sessionId: 's-east' };
/** Minimal in-memory Store: honours the real row-filter rules, no workflow-table guards. */
function memoryStore(): Store {
  const tables = new Map<string, Map<string, unknown>>();
  const t = (name: string) => tables.get(name) ?? tables.set(name, new Map()).get(name)!;
  const reader = {
    list: async (table: string, filter?: unknown) => [...t(table).values()].filter(r => matchesRowFilter(r, filter)),
    get: async (table: string, id: string) => t(table).get(id),
  };
  return { adapter: 'sqlite', ...reader,
    transaction: async (work: (tx: never) => Promise<unknown>) => work({ ...reader, put: async (table: string, row: { id: string }) => { t(table).set(row.id, structuredClone(row)); }, remove: async (table: string, id: string) => { t(table).delete(id); } } as never),
  } as unknown as Store;
}

async function fixture() {
  const store = memoryStore();
  await store.transaction(async tx => {
    for (const p of profiles) await tx.put('profiles', p);
    await tx.put('profiles', { id: 'gone', name: 'Gone', role: 'east_manager', active: false, permissions: [], regions: ['east'] });
    await tx.put('dashboards', { id: 'D1', ownerId: 'east', spec: { title: 'East dashboard' }, createdAt: 'x', updatedAt: '2026-10-05T00:00:00Z' });
    await tx.put('dashboards', { id: 'D2', ownerId: 'east', spec: { title: 'Deleted' }, createdAt: 'x', updatedAt: '2026-10-05T00:00:00Z', deletedAt: '2026-10-05T01:00:00Z' });
    await tx.put('dashboards', { id: 'D3', ownerId: 'executive', spec: { title: 'Not mine' }, createdAt: 'x', updatedAt: '2026-10-05T00:00:00Z' });
    const pending = (id: string, over: Record<string, unknown>) => tx.put('pending_actions', { id, actorId: 'east', conversationId: 'c1', status: 'pending',
      payload: { kind: 'dashboard_create', spec: { title: 'Draft', widgets: [{}, {}] } }, preview: 'p', createdAt: '2026-10-06T01:00:00.000Z', expiresAt: '2026-10-07T01:00:00.000Z', ...over });
    await pending('PA1', {}); await pending('PA2', { conversationId: 'c2' }); await pending('PA3', { actorId: 'executive' });
    await pending('PA4', { status: 'completed' }); await pending('PA5', { expiresAt: '2026-10-05T01:00:00.000Z' });
    await tx.put('conversation_messages', { id: 'm1', actorId: 'east', conversationId: 'c1', role: 'user', text: 'hello', createdAt: '2026-10-06T01:00:00.000Z' });
    await tx.put('conversation_messages', { id: 'm2', actorId: 'east', conversationId: 'c2', role: 'user', text: 'other chat', createdAt: '2026-10-06T01:00:01.000Z' });
    await tx.put('conversation_messages', { id: 'm3', actorId: 'executive', conversationId: 'c1', role: 'user', text: 'someone else', createdAt: '2026-10-06T01:00:02.000Z' });
  });
  return store;
}
const base = (store: Store, over: Record<string, unknown> = {}) => ({
  store, actor: east, conversationId: 'c1', businessDate: '2026-10-06', catalog, registry: actionRegistry, now: () => NOW,
  recipientAllowed: async (_a: Actor, id: string) => id !== 'hr', ...over,
});

describe('buildPlannerContext', () => {
  it('scopes pending actions, dashboards and conversation to this actor and conversation', async () => {
    const store = await fixture();
    await createStagedStore(store, { now: () => NOW }).create(east, { conversationId: 'c1', turnId: 't' },
      { actionId: 'dashboard.delete', digest: 'x', preview: 'delete D1\nmore', data: {}, expiresAt: NOW + 60_000 });
    const ctx = await buildPlannerContext(base(store));
    expect(ctx.pendingActions.map(p => p.id)).toEqual(expect.arrayContaining(['PA1']));
    expect(ctx.pendingActions.filter(p => p.id.startsWith('PA')).map(p => p.id)).toEqual(['PA1']);
    expect(ctx.pendingActions.find(p => p.id === 'PA1')).toMatchObject({ kind: 'dashboard_create', title: 'Draft', widgetIndexes: [0, 1] });
    expect(ctx.pendingActions.find(p => p.kind === 'dashboard.delete')?.title).toBe('delete D1');
    expect(ctx.dashboards).toEqual([{ id: 'D1', title: 'East dashboard', updatedAt: '2026-10-05T00:00:00Z' }]);
    expect(ctx.conversation).toEqual([{ role: 'user', text: 'hello' }]);
  });
  it('lists only allowed active recipients, authorized scope, and permitted catalog', async () => {
    const store = await fixture();
    const ctx = await buildPlannerContext(base(store));
    expect(ctx.recipients.map(r => r.id)).toEqual(['executive']);
    expect(ctx.scope).toMatchObject({ actorId: 'east', regionIds: ['east'], branchIds: ['E02'] });
    expect(ctx.catalog.choices.map(c => c.id)).toEqual(['east', 'E02']);
    expect(ctx.catalog.datasets.map(d => d.id)).toEqual(['branch_performance', 'inventory_items', 'incident_log', 'support_tickets']);
    expect(ctx.actions.some(a => a.actionId === 'dashboard.create')).toBe(true);
    expect(ctx.business).toEqual({ date: '2026-10-06', weekday: 'Tuesday', timezone: 'Asia/Bangkok', availability: null });
    const hr = await buildPlannerContext(base(store, { actor: { ...actors.hr, sessionId: 's-hr' } }));
    expect(hr.catalog.datasets.map(d => d.id)).toEqual(['hr_employees']);
  });
  it('labels distinct same-role Demo profiles by their human account purpose and preserves execution ids', async () => {
    const store = await fixture();
    const boundProfiles = [
      { id: 'profile-east-legacy', name: 'Demo East Manager' },
      { id: 'profile-east-operations', name: 'Demo East Operations Manager V2 Profile Anchor' },
      { id: 'profile-east-onboarding', name: 'Demo East Onboarding Manager V2 Profile Anchor' },
    ];
    await store.transaction(async tx => {
      for (const profile of boundProfiles) {
        await tx.put('profiles', { id: profile.id, name: profile.name, role: 'east_manager', active: true, permissions: [], regions: ['east'] });
      }
    });

    const ctx = await buildPlannerContext(base(store));
    const legacy = ctx.recipients.find(recipient => recipient.id === 'profile-east-legacy');
    const operations = ctx.recipients.find(recipient => recipient.id === 'profile-east-operations');
    const onboarding = ctx.recipients.find(recipient => recipient.id === 'profile-east-onboarding');
    expect(legacy?.id).toBe('profile-east-legacy');
    expect(operations?.id).toBe('profile-east-operations');
    expect(onboarding?.id).toBe('profile-east-onboarding');
    expect(legacy?.name).toContain('East Manager');
    expect(operations?.name).toContain('East Operations Manager');
    expect(onboarding?.name).toContain('East Onboarding Manager');
    expect(legacy?.name).not.toContain('profile-east-legacy');
    expect(operations?.name).not.toContain('profile-east-operations');
    expect(onboarding?.name).not.toContain('profile-east-onboarding');
    expect(legacy?.name).not.toContain('Demo');
    expect(operations?.name).not.toContain('Demo');
    expect(onboarding?.name).not.toContain('Demo');
    expect(operations?.name).not.toEqual(onboarding?.name);
  });
  it('distinguishes genuine same-name same-role recipients with human account labels', async () => {
    const store = await fixture();
    await store.transaction(async tx => {
      for (const id of ['profile-morgan-z', 'profile-morgan-a']) {
        await tx.put('profiles', { id, name: 'Morgan Lee', role: 'east_manager', active: true, permissions: [], regions: ['east'] });
      }
    });

    const ctx = await buildPlannerContext(base(store));
    const first = ctx.recipients.find(recipient => recipient.id === 'profile-morgan-a');
    const second = ctx.recipients.find(recipient => recipient.id === 'profile-morgan-z');
    expect(first?.id).toBe('profile-morgan-a');
    expect(second?.id).toBe('profile-morgan-z');
    expect(first?.name).toContain('Morgan Lee');
    expect(second?.name).toContain('Morgan Lee');
    expect(first?.name).toContain('บัญชี 1');
    expect(second?.name).toContain('บัญชี 2');
    expect(first?.name).not.toContain('profile-morgan-a');
    expect(second?.name).not.toContain('profile-morgan-z');
    expect(first?.name).not.toBe(second?.name);
  });
  it('uses human fallbacks for unknown and blank recipient roles', async () => {
    const store = await fixture();
    const malformedProfiles = [
      { id: 'profile-unknown-role', name: 'Demo Support Desk V2 Profile Anchor', role: 'support', active: true, permissions: [], regions: [] },
      { id: 'profile-blank-role', name: '  ', role: '', active: true, permissions: [], regions: [] },
    ] as unknown as Profile[];
    await store.transaction(async tx => {
      for (const profile of malformedProfiles) await tx.put('profiles', profile);
    });

    const allowedIds = new Set(malformedProfiles.map(profile => profile.id));
    const ctx = await buildPlannerContext(base(store, { recipientAllowed: async (_actor: Actor, id: string) => allowedIds.has(id) }));
    const unknown = ctx.recipients.find(recipient => recipient.id === 'profile-unknown-role');
    const blank = ctx.recipients.find(recipient => recipient.id === 'profile-blank-role');
    expect(unknown?.name).toBe('Support Desk');
    expect(blank?.name).toBe('ผู้ติดต่อ');
    expect(unknown?.name).not.toContain('profile-unknown-role');
    expect(blank?.name).not.toContain('profile-blank-role');
  });
  it('passes availability, clarification and artifacts through, bounded', async () => {
    const store = await fixture();
    const ctx = await buildPlannerContext(base(store, {
      availability: { from: '2026-09-01', to: '2026-10-06' }, pendingClarification: { about: 'date', missing: ['date'] },
      artifacts: async () => Array.from({ length: 9 }, (_, i) => ({ id: `AR${i}`, typeId: 'table', title: `T${i}` })),
    }));
    expect(ctx.business.availability).toEqual({ from: '2026-09-01', to: '2026-10-06' });
    expect(ctx.pendingClarification).toEqual({ about: 'date', missing: ['date'] });
    expect(ctx.artifacts).toHaveLength(5);
    expect(ctx.previousState).toBeNull();
    expect(ctx.acceptedStates).toEqual([]);
  });
  it('ignores malformed or foreign accepted-state records', async () => {
    const store = await fixture();
    await store.transaction(async tx => {
      await tx.put('tool_executions', { id: 'bad', name: 'retail.dynamic_query', status: 'completed', actorId: 'east', sessionId: 's-east', conversationId: 'c1', state: { nope: 1 } });
      await tx.put('tool_executions', { id: 'foreign', name: 'retail.dynamic_query', status: 'completed', actorId: 'executive', sessionId: 's-east', conversationId: 'c1', state: {} });
    });
    const ctx = await buildPlannerContext(base(store));
    expect(ctx.acceptedStates).toEqual([]);
  });
});
