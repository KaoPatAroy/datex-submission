import { createElement } from 'react';
import { afterAll, describe, expect, it, vi } from 'vitest';
import HistoryPanel from '@/components/biztania/history-panel';
import type { AuditEvent, PendingAction, ReceiptView } from '@/lib/contracts';
import { listReceiptsPage } from '@/app/api/router-proposals/_view';
import { actors, createWorkspaceFixture } from './helpers/workspace';

const { require } = vi.hoisted(() => {
  const createRequire = process.getBuiltinModule('node:module').createRequire;
  return { require: createRequire(`${process.cwd()}/tests/hosted-history.test.ts`) };
});
vi.mock('react', () => {
  const React = require(`${process.cwd()}/node_modules/react/cjs/react.development.js`);
  return { ...React, default: React };
});
const Module = require('node:module').Module;
const overriddenReactModules: { path: string; entry?: NodeJS.Module }[] = [];
for (const name of ['react', 'react-dom']) {
  const path = require.resolve(name);
  const previous = require.cache[path];
  const entry = previous ?? new Module(path);
  entry.filename = path;
  entry.loaded = true;
  entry.exports = require(`${process.cwd()}/node_modules/${name}/index.js`);
  require.cache[path] = entry;
  overriddenReactModules.push({ path, entry: previous });
}
const { renderToStaticMarkup } = require(`${process.cwd()}/node_modules/react-dom/server.node.js`) as typeof import('react-dom/server');
afterAll(() => { for (const { path, entry } of overriddenReactModules) { if (entry) require.cache[path] = entry; else delete require.cache[path]; } });

const at = '2026-10-06T04:05:06.000Z';

function renderHistory({ actions = [], receipts = [], audit = [] }: { actions?: PendingAction[]; receipts?: ReceiptView[]; audit?: AuditEvent[] }) {
  return renderToStaticMarkup(createElement(HistoryPanel, {
    actions, receipts, audit, actorName: 'Ari', now: Date.parse(at), onAction: () => {},
    renderReceipt: receipt => createElement('p', { 'data-receipt-status': receipt.status }, receipt.status),
  }));
}

describe('hosted resource history', () => {
  it('shows an audit-only Dashboard rename in the visible history list', () => {
    const audit: AuditEvent[] = [{
      id: 'audit-dashboard-rename', actorId: 'actor-1', category: 'update',
      summary: 'เปลี่ยนชื่อ Dashboard', actionId: 'dashboard-1', createdAt: at,
    }];

    const html = renderHistory({ audit });

    expect(html).toContain('data-history-resource="dashboard-1"');
    expect(html).toContain('เปลี่ยนชื่อ Dashboard');
  });

  it('shows Monitor renames, every task transition and unlinked Result operations without inventing verification', () => {
    const audit: AuditEvent[] = [
      { id: 'monitor-rename', actorId: 'actor-1', category: 'monitor_manage', summary: 'monitor.rename', actionId: 'monitor-1', createdAt: at },
      ...['ทำเครื่องหมายว่าเสร็จแล้ว', 'เปิดงานอีกครั้งแล้ว', 'ยกเลิกงานแล้ว'].map((summary, i) => ({ id: `task-${i}`, actorId: 'actor-1', category: 'update', summary, actionId: 'task-1', createdAt: at })),
      { id: 'save-result', actorId: 'actor-1', category: 'update', summary: 'บันทึกผลลัพธ์ส่วนตัว', createdAt: at },
    ];
    const html = renderHistory({ audit });
    expect(html).toContain('<h2>เปลี่ยนชื่อ Monitor</h2>');
    for (const event of audit.slice(1)) expect(html).toContain(`<h2>${event.summary}</h2>`);
    expect(html).toContain('data-history-resource="monitor-1"');
    expect(html.match(/data-history-resource="task-1"/g)).toHaveLength(3);
    expect(html).toContain('บันทึกการทำงาน');
    expect(html).not.toContain('ตรวจผลแล้ว');
    expect(html).not.toContain('ไม่มีรายการในตัวกรองนี้');
  });

  it.each([
    ['monitor.rename', 'เปลี่ยนชื่อ Monitor'], ['monitor.pause', 'หยุด Monitor ชั่วคราว'],
    ['monitor.resume', 'เปิด Monitor อีกครั้ง'], ['monitor.delete', 'ลบ Monitor'],
  ])('shows the persisted %s operation with readable copy', (summary, label) => {
    const html = renderHistory({ audit: [{ id: summary, actorId: 'actor-1', actionId: 'monitor-1', category: 'monitor_manage', summary, createdAt: at }] });
    expect(html).toContain(`data-history-resource="monitor-1"`);
    expect(html).toContain(`<h2>${label}</h2>`);
    expect(html).not.toContain(`<h2>${summary}</h2>`);
  });

  it('keeps preparation records truthful and does not duplicate audits already represented by a receipt', () => {
    const receipt: ReceiptView = { visibility: 'restricted', id: 'r1', actionId: 'a1', status: 'verified_success', results: [], createdAt: at, verifiedAt: null, detail: '' };
    const html = renderHistory({ receipts: [receipt], audit: [
      { id: 'already-covered', actorId: 'actor-1', actionId: 'a1', category: 'update', summary: 'receipt audit', createdAt: at },
      { id: 'preparation', actorId: 'actor-1', actionId: 'dashboard-1', category: 'update', summary: 'เตรียมการแก้ Dashboard ที่แชร์แล้ว (รอยืนยัน)', createdAt: at },
    ] });
    expect(html).not.toContain('data-history-resource="a1"');
    expect(html).toContain('<h2>เตรียมการแก้ Dashboard ที่แชร์แล้ว (รอยืนยัน)</h2>');
    expect(html).toContain('data-receipt-status="verified_success"');
  });

  it('includes persisted Monitor and Task creation receipts in the History feed and excludes other actors', async () => {
    const fixture = await createWorkspaceFixture();
    try {
      const rows = [
        { id: 'monitor-complete', actorId: 'executive', actionId: 'monitor.create', kind: 'monitor', title: 'สร้าง Monitor' },
        { id: 'task-complete', actorId: 'executive', actionId: 'task.create', kind: 'task', title: 'สร้างงานติดตาม' },
        { id: 'foreign-task', actorId: 'east', actionId: 'task.create', kind: 'task', title: 'งานของคนอื่น' },
      ];
      await fixture.store.transaction(async tx => {
        for (const row of rows) await tx.put('router_proposals', { id: row.id, actorId: row.actorId, schemaVersion: 1, conversationId: 'history-conversation', turnId: 'history-turn',
          actionId: row.actionId, digest: row.id, status: 'completed', expiresAt: Date.parse(at) + 86400000, createdAt: Date.parse(at), updatedAt: Date.parse(at), revision: 3, preview: row.title,
          data: { receipt: { kind: row.kind, title: row.title, headline: 'ดำเนินการและตรวจผลแล้ว', verifiedAt: at } } });
      });
      const page = await listReceiptsPage(fixture.store, actors.executive);
      expect(page.total).toBe(2);
      expect(page.items.map(row => row.actionId).sort()).toEqual(['monitor.create', 'task.create']);
      expect(page.items.map(row => row.receipt.title).sort()).toEqual(['สร้าง Monitor', 'สร้างงานติดตาม']);
    } finally { await fixture.dispose(); }
  });
});
