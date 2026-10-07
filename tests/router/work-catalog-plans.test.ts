import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@/lib/contracts';
import { actors, createWorkspaceFixture } from '../helpers/workspace';

type Fixture = Awaited<ReturnType<typeof createWorkspaceFixture>>;
let fixture: Fixture;
const roles = ['executive', 'east', 'hr'] as const;

async function live(actor: Actor): Promise<Actor> {
  await fixture.patchSession(actor.sessionId, { mode: 'live_ai', modeRevision: 1 });
  return { ...actor, mode: 'live_ai', modeRevision: 1 };
}
beforeEach(async () => {
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('NEXUS_E2E_RUNNER', ''); vi.stubEnv('AI_PROVIDER', 'scripted'); vi.stubEnv('USE_LOCAL_DEMO_DATA', 'true');
  vi.stubEnv('VERCEL', ''); vi.stubEnv('BIZTANIA_DEPLOYMENT_ENV', 'development'); vi.stubEnv('BIZTANIA_DYNAMIC_QUERY', '');
  fixture = await createWorkspaceFixture();
});
afterEach(async () => { vi.unstubAllEnvs(); await fixture.dispose(); });

describe('server-owned work-catalog plans', { timeout: 120_000 }, () => {
  for (const role of roles) {
    it(`every entry offered to ${role} validates and answers instead of clarifying`, async () => {
      const actor = await live(actors[role]);
      const workspace = await fixture.service.getWorkspace(actor);
      const entries = (workspace.actionCatalog ?? []).filter(entry => !entry.actionKind);
      const failures: string[] = [];
      for (const entry of entries) {
        const response = await fixture.service.turn(actor, entry.prompt, undefined, undefined,
          { contractVersion: 2, requestKey: `req_${role}_${entry.id.replace(/[^A-Za-z0-9]/g, '')}_0123456789`, catalogEntryId: entry.id });
        if (entry.id === 'retail.sales-analysis') {
          const systems = new Set((response.sources ?? []).map(source => source.system));
          if (systems.size < 2) failures.push(`${entry.id}: sales analysis must cite sales and targets (got ${[...systems].join(',')})`);
        }
        if (response.clarification || (!response.sources?.length && !response.analysis)) failures.push(`${entry.id}: ${response.message.slice(0, 80)}`);
      }
      expect(failures).toEqual([]);
      expect(entries.length).toBeGreaterThan(0);
    });
  }
});
