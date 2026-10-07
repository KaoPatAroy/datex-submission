import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@/lib/contracts';
import { actors } from '../helpers/workspace';
import { seedTables, type TableFixture } from './executors/table-fixtures';

let fixture: TableFixture;
async function live(actor: Actor): Promise<Actor> {
  await fixture.patchSession(actor.sessionId, { mode: 'live_ai', modeRevision: 1 });
  return { ...actor, mode: 'live_ai', modeRevision: 1 };
}
beforeEach(async () => {
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('NEXUS_E2E_RUNNER', ''); vi.stubEnv('AI_PROVIDER', 'scripted');
  vi.stubEnv('USE_LOCAL_DEMO_DATA', 'true'); vi.stubEnv('VERCEL', ''); vi.stubEnv('BIZTANIA_DEPLOYMENT_ENV', 'development'); vi.stubEnv('BIZTANIA_DYNAMIC_QUERY', '');
  fixture = await seedTables({ incidents: 5 });
});
afterEach(async () => { vi.unstubAllEnvs(); await fixture.dispose(); });

describe('table datasets through the unified router (planner -> validate -> executor -> persisted turn)', { timeout: 40_000 }, () => {
  it('answers a grouped table query with sources and persists the table state', async () => {
    const actor = await live(actors.executive);
    const response = await fixture.service.turn(actor, 'Show low stock by branch.');
    expect(response.clarification).toBeUndefined();
    expect(response.sources?.length).toBeGreaterThan(0);
    const record = await fixture.store.get<{ name: string }>('tool_executions', `dynamic-table:${response.turnId}`);
    expect(record?.name).toBe('table.dynamic_query');
  });

  it('pages: the follow-up presents exactly the cursor the reference set offered and gets the next page', async () => {
    const actor = await live(actors.executive);
    const first = await fixture.service.turn(actor, 'List incidents.');
    expect(first.clarification).toBeUndefined();
    expect(first.message).toContain('จากทั้งหมด');
    const second = await fixture.service.turn(actor, 'Show more incidents.', first.conversationId);
    expect(second.clarification).toBeUndefined();
    expect(second.message).toMatch(/แสดงรายการที่ 3–4/);
  });

  it('joins two registered datasets in one turn', async () => {
    const actor = await live(actors.executive);
    const response = await fixture.service.turn(actor, 'Compare shortfall and incidents by branch.');
    expect(response.clarification).toBeUndefined();
    expect(response.message).toContain('Incident หน้าร้าน');
  });

  it('a role without operations.read never sees table datasets', async () => {
    const actor = await live(actors.hr);
    const response = await fixture.service.turn(actor, 'Show low stock by branch.');
    expect(response.sources).toBeUndefined();
  });
});

describe('policy_read through the unified router', { timeout: 40_000 }, () => {
  it('reads an authorized policy with version and Source; the persisted citation passes canCite', async () => {
    await fixture.store.transaction(async tx => {
      await tx.put('policy_documents', { id: 'POL-OPS-001', title: 'Incident handling', version: '1.0', text: 'Document the branch.', updatedAt: '2026-10-01T10:00:00+07:00' });
      await tx.put('policy_documents', { id: 'POL-HR-001', title: 'Badge revocation', version: '2.0', text: 'Needs a reason.', updatedAt: '2026-10-01T10:00:00+07:00' });
    });
    const actor = await live(actors.executive);
    const response = await fixture.service.turn(actor, 'Show the policy.');
    expect(response.clarification).toBeUndefined();
    expect(response.message).toContain('เวอร์ชัน 1.0');
    expect(response.message).not.toContain('policy:POL-OPS-001'); // source ids live in the sources panel, not the prose
    expect(response.message).not.toContain('Badge revocation');
    expect(response.sources?.[0]?.id).toBe('policy:POL-OPS-001:1.0');
  });

  it('S1: acknowledging requires a policy SHOWN in this conversation; an unseen one is clarified, a shown one is staged', async () => {
    await fixture.store.transaction(async tx => {
      await tx.put('policy_documents', { id: 'POL-OPS-001', title: 'Incident handling', version: '1.0', text: 'Document the branch.', updatedAt: '2026-10-01T10:00:00+07:00' });
    });
    const actor = await live(actors.executive);
    const unseen = await fixture.service.turn(actor, 'Acknowledge the policy.');
    expect(unseen.clarification).toBe(true);
    expect(unseen.pendingAction).toBeUndefined();
    expect(unseen.message).toContain('ยังไม่ได้แสดงเนื้อหา Policy');
    const shown = await fixture.service.turn(actor, 'Show the policy.', unseen.conversationId);
    expect(shown.clarification).toBeUndefined();
    const acknowledged = await fixture.service.turn(actor, 'Acknowledge the policy.', unseen.conversationId);
    expect(acknowledged.clarification).toBeUndefined();
    expect(acknowledged.message).toContain('ยังไม่ได้ดำเนินการ');
    // Another conversation never inherits the "shown" state.
    const other = await fixture.service.turn(actor, 'Acknowledge the policy.');
    expect(other.clarification).toBe(true);
  });
});
