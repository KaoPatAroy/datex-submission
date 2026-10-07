import { describe, expect, it, vi } from 'vitest';
import { recipientDirectory } from '@/lib/router/context/recipients';
import { ConciergeService } from '@/lib/core/service';
import type { Table, RowFilter, Dashboard } from '@/lib/contracts';
import { specRevision } from '@/lib/router/executors/action-ports';
import { actors, createWorkspaceFixture, dashboardPayload } from '../helpers/workspace';

describe('current recipient labels and policy reads', () => {
  it('starts recipient policy reads together and keeps deterministic directory order', async () => {
    const fixture = await createWorkspaceFixture();
    try {
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const allowed = vi.fn(async () => { await gate; return true; });
      const reading = recipientDirectory(fixture.store, actors.executive, allowed, 50);
      await new Promise(resolve => setTimeout(resolve, 0));
      const started = allowed.mock.calls.length;
      release();
      const directory = await reading;
      expect(started).toBe(2);
      expect(directory.map(person => person.id)).toEqual(['east', 'hr']);
    } finally { await fixture.dispose(); }
  });

  it('labels share recipients through the directory and never falls back to a raw id', async () => {
    const fixture = await createWorkspaceFixture();
    try {
      await fixture.store.transaction(async tx => { await tx.put('profiles', { ...actors.east, name: 'Demo East Manager' }); });
      const pending = await fixture.service.prepare(actors.executive, dashboardPayload());
      const made = await fixture.service.confirm(actors.executive, pending.id);
      const share = await fixture.service.prepare(actors.executive, { kind: 'dashboard_share', dashboardId: made.dashboardId!, recipientId: 'east' });
      await fixture.service.confirm(actors.executive, share.id);
      const rows = await fixture.service.dashboardShares(actors.executive, made.dashboardId!);
      expect(rows.find(row => row.recipientId === 'east')?.recipientName).toBe('ผู้จัดการภาคตะวันออก');
      const missing = new ConciergeService({ ...fixture.store,
        get: (table, id) => table === 'profiles' && id === 'east' ? Promise.resolve(undefined) : fixture.store.get(table, id),
        list: async <T>(table: Table, filter?: RowFilter) => (await fixture.store.list<T>(table, filter)).filter(row => table !== 'profiles' || (row as { id: string }).id !== 'east'),
      });
      expect((await missing.dashboardShares(actors.executive, made.dashboardId!))[0]?.recipientName).toBe('ผู้ติดต่อ');
    } finally { await fixture.dispose(); }
  });

  it('records a shared Dashboard edit awaiting confirmation as prepare-only', async () => {
    const fixture = await createWorkspaceFixture();
    try {
      const pending = await fixture.service.prepare(actors.executive, dashboardPayload());
      const made = await fixture.service.confirm(actors.executive, pending.id);
      const share = await fixture.service.prepare(actors.executive, { kind: 'dashboard_share', dashboardId: made.dashboardId!, recipientId: 'east' });
      await fixture.service.confirm(actors.executive, share.id);
      const dashboard = (await fixture.store.get<Dashboard>('dashboards', made.dashboardId!))!;
      expect(await fixture.service.editDashboardUi(actors.executive, made.dashboardId!, { kind: 'rename', title: 'Awaiting owner confirmation', baseRevision: specRevision(dashboard.spec) })).toMatchObject({ outcome: 'staged' });
      const audits = await fixture.store.list<{ category: string; summary: string }>('audit_events');
      expect(audits.find(event => event.summary === 'เตรียมการแก้ Dashboard ที่แชร์แล้ว (รอยืนยัน)')?.category).toBe('prepare');
    } finally { await fixture.dispose(); }
  });
});
