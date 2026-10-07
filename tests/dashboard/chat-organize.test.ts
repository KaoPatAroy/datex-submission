import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Dashboard } from '@/lib/contracts';
import { specRevision } from '@/lib/router/executors/action-ports';
import { SCRIPTED_DASHBOARD_FAMILY_PROMPTS } from '@/lib/router/planner/scripted';
import { createSeededService } from '../helpers/seeded-service';

/**
 * AI parity for Dashboard organization: dashboard.manage from chat converges on ConciergeService's own organization rules (the same ones the
 * Dashboard page route calls), is written with the turn, and changes exactly what the UI operation changes. The plan carries the DASHBOARDS
 * server id (scripted planner fixtures); nothing reads the user text.
 */
type Seeded = Awaited<ReturnType<typeof createSeededService>>;
let seeded: Seeded;
let dashboardId: string;
let conversationId: string;
const byId = async (id: string) => (await seeded.store.get<Dashboard>('dashboards', id))!;
const owned = async () => (await seeded.store.list<Dashboard>('dashboards')).filter(d => d.ownerId === 'executive' && !(d as Dashboard & { deletedAt?: string }).deletedAt);

beforeAll(async () => {
  for (const [key, value] of Object.entries({ NODE_ENV: 'test', USE_LOCAL_DEMO_DATA: 'true', AI_PROVIDER: 'scripted', BIZTANIA_DYNAMIC_QUERY: '', NEXUS_E2E_RUNNER: '', VERCEL: '', BIZTANIA_DEPLOYMENT_ENV: 'development' })) vi.stubEnv(key, value);
  seeded = await createSeededService();
  const first = await seeded.service.turn(seeded.actors.executive, SCRIPTED_DASHBOARD_FAMILY_PROMPTS[0]);
  conversationId = first.conversationId;
  dashboardId = (await owned())[0]!.id;
}, 120_000);
afterAll(async () => { vi.unstubAllEnvs(); await seeded?.dispose(); });

describe('dashboard.manage from chat (same rules as the Dashboard page)', { timeout: 120_000 }, () => {
  it('pin, archive (pin refused while archived), restore and unpin persist exactly like the UI and never touch the widgets', async () => {
    const actor = seeded.actors.executive;
    const before = await byId(dashboardId);
    const pinned = await seeded.service.turn(actor, 'Pin my dashboard.', conversationId);
    expect(pinned.message).toContain('ปักหมุด Dashboard');
    expect((await byId(dashboardId)).pinnedAt).toBeTruthy();

    await seeded.service.turn(actor, 'Archive my dashboard.', conversationId);
    const archived = await byId(dashboardId);
    expect(archived.archivedAt).toBeTruthy();
    // The SAME rule as the UI route: an archived Dashboard is not pinned; the chat answer says nothing happened.
    const refused = await seeded.service.turn(actor, 'Pin my dashboard.', conversationId);
    expect(refused.message).toContain('ยังไม่ได้ดำเนินการ');
    expect(refused.message).toContain('นำ Dashboard ที่เก็บถาวรกลับมาก่อน');
    expect(await byId(dashboardId)).toEqual(archived);
    await expect(seeded.service.organizeDashboard(actor, dashboardId, { op: 'pin' })).rejects.toMatchObject({ code: 'CONFLICT' });

    await seeded.service.turn(actor, 'Restore my archived dashboard.', conversationId);
    await seeded.service.turn(actor, 'Unpin my dashboard.', conversationId);
    const after = await byId(dashboardId);
    expect(after.archivedAt).toBeUndefined();
    expect(after.pinnedAt).toBeUndefined();
    expect(after.spec).toEqual(before.spec);
    expect(specRevision(after.spec)).toBe(specRevision(before.spec));
    expect(after.updatedAt).toBe(before.updatedAt);
    const audit = (await seeded.store.list<{ actorId: string; detail?: string; summary?: string }>('audit_events')).filter(e => e.actorId === 'executive');
    expect(JSON.stringify(audit)).toContain('ปักหมุด Dashboard');
    expect(JSON.stringify(audit)).toContain('เก็บ Dashboard ถาวร');
  });

  it('duplicate makes a new private copy with the same widgets (not pinned, archived or shared), exactly like the UI operation', async () => {
    const actor = seeded.actors.executive;
    const count = (await owned()).length;
    const source = await byId(dashboardId);
    const reply = await seeded.service.turn(actor, 'Duplicate my dashboard.', conversationId);
    expect(reply.message).toContain('ทำสำเนา Dashboard');
    const copies = (await owned()).filter(d => d.id !== dashboardId && d.spec.title.startsWith('สำเนา — '));
    expect((await owned()).length).toBe(count + 1);
    expect(copies).toHaveLength(1);
    expect(copies[0]!.spec.widgets).toEqual(source.spec.widgets);
    expect(copies[0]!.pinnedAt).toBeUndefined();
    expect(copies[0]!.archivedAt).toBeUndefined();
  });

  it('another account never reaches the Dashboard: the server rule refuses it (owner-only)', async () => {
    await expect(seeded.service.organizeDashboard(seeded.actors.east, dashboardId, { op: 'archive' })).rejects.toMatchObject({ status: 404 });
    expect((await byId(dashboardId)).archivedAt).toBeUndefined();
  });
});
