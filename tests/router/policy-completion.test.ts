import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor, Profile } from '@/lib/contracts';
import { actors, createWorkspaceFixture } from '../helpers/workspace';

type Fixture = Awaited<ReturnType<typeof createWorkspaceFixture>>;
let fixture: Fixture;
const hook = vi.hoisted(() => ({ afterRead: undefined as undefined | (() => Promise<void>) }));
vi.mock('@/lib/router/executors/policy', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/router/executors/policy')>();
  return { ...original, executePolicyReadStep: async (input: Parameters<typeof original.executePolicyReadStep>[0]) => {
    const result = await original.executePolicyReadStep(input);
    await hook.afterRead?.();
    return result;
  } };
});

beforeEach(async () => {
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('NEXUS_E2E_RUNNER', ''); vi.stubEnv('AI_PROVIDER', 'scripted'); vi.stubEnv('USE_LOCAL_DEMO_DATA', 'true');
  vi.stubEnv('VERCEL', ''); vi.stubEnv('BIZTANIA_DEPLOYMENT_ENV', 'development'); vi.stubEnv('BIZTANIA_DYNAMIC_QUERY', '');
  hook.afterRead = undefined;
  fixture = await createWorkspaceFixture();
  await fixture.store.transaction(tx => tx.put('policy_documents', { id: 'POL-OPS-001', title: 'Incident handling', version: '1.0', text: 'Document the branch.', updatedAt: '2026-10-01T10:00:00+07:00' }));
});
afterEach(async () => { vi.unstubAllEnvs(); await fixture.dispose(); });

describe('L5: policy text is re-authorized inside the completion transaction', { timeout: 40_000 }, () => {
  it('a permission revoked after the read but before completion persists and returns nothing', async () => {
    await fixture.patchSession(actors.executive.sessionId, { mode: 'live_ai', modeRevision: 1 });
    const actor: Actor = { ...actors.executive, mode: 'live_ai', modeRevision: 1 };
    hook.afterRead = async () => {
      const profile = await fixture.store.get<Profile>('profiles', 'executive');
      await fixture.store.transaction(tx => tx.put('profiles', { ...profile!, permissions: profile!.permissions.filter(p => p !== 'operations.read') }));
    };
    await expect(fixture.service.turn(actor, 'Show the policy.')).rejects.toMatchObject({ status: 403 });
    const messages = await fixture.store.list<{ text: string }>('conversation_messages');
    expect(messages.some(m => m.text.includes('Document the branch'))).toBe(false);
  });
});
