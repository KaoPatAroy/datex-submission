import { expect, test, type Page } from '@playwright/test';
import type { Dashboard, Evidence, Workspace } from '../../lib/contracts';

test.setTimeout(90_000);
const prompt = 'ช่วยเตรียมงานติดตามสำหรับสาขาที่ยอดขายต่ำกว่าเป้าในขอบเขตของฉัน';
const selectedId = 'task-dashboard-selected';

async function fixture(page: Page) {
  expect((await page.request.get('/api/session', { timeout: 60_000 })).status()).toBe(401);
  await page.goto('/');
  await page.getByLabel('โปรไฟล์', { exact: true }).selectOption('executive');
  await page.getByLabel('รหัสเข้าใช้งาน', { exact: true }).fill('nexus-test-access');
  await page.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true }).click();
  await expect(page.getByRole('switch')).toBeVisible();
  const baseline: Workspace = await page.evaluate(() => fetch('/api/workspace').then(response => response.json()));
  const now = '2026-10-01T16:59:00.000Z';
  const evidence: Evidence = { scope: { region: 'east', date: '2026-10-01' }, asOf: now, version: 'task-options-evidence', branches: [], totals: { netSales: 100, target: 120, gap: -20, achievement: 83.3 }, sources: [], warnings: [] };
  const dashboard: Dashboard = { id: selectedId, ownerId: baseline.actor.id, spec: { title: 'ติดตามยอดขายภาคตะวันออก', description: 'ข้อมูลสำหรับเตรียมงานติดตาม', scope: evidence.scope, widgets: [{ type: 'metric', title: 'ยอดขายสุทธิ', metric: 'net_sales' }] }, packs: [], createdAt: now, updatedAt: now, lastRefreshAt: now, sourceMetadata: [], analysis: null, evidenceVersion: evidence.version };
  const alternate = { ...dashboard, id: 'task-dashboard-other', updatedAt: '2026-10-02T16:59:00.000Z' };
  await page.route('**/api/workspace', route => route.fulfill({ json: {
    ...baseline, messages: [], dashboards: [alternate, dashboard],
    actionCatalogStatus: 'ready', actionCatalog: [{ id: 'ops.ticket-create', section: 'prepare_review', title: 'สร้าง Ticket ติดตามสาขา', description: 'เตรียมงานติดตามให้ตรวจสอบ', consequence: 'review_required', actionKind: 'ticket_create', prompt }],
  } }));
  await page.route(`**/api/dashboards/${selectedId}`, route => route.fulfill({ json: { dashboard, evidence, analysisStale: false } }));
  return { dashboard, baseline };
}

for (const width of [1440, 390]) {
  for (const entryPoint of ['list', 'detail'] as const) {
    test(`Dashboard ${entryPoint} task options remain editable and retain the exact target at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      const { dashboard, baseline } = await fixture(page);
      const east = baseline.taskAssigneeOptions?.find(option => option.id !== baseline.actor.id);
      expect(east).toBeTruthy();
      const submissions: { message: string; targets?: { kind: string; id: string }[]; catalogEntryId?: string }[] = [];
      const writes: string[] = [];
      page.on('request', request => {
        if (request.method() !== 'GET' && new URL(request.url()).pathname.startsWith('/api/')) writes.push(request.url());
      });
      await page.route(/\/api\/chat(?:\/stream)?$/, route => {
        submissions.push(route.request().postDataJSON());
        return route.abort();
      });
      await page.goto(entryPoint === 'detail' ? `/dashboards/${selectedId}` : '/?section=dashboards');
      const trigger = entryPoint === 'detail'
        ? page.getByRole('button', { name: 'เตรียม Ticket ติดตามสาขา', exact: true })
        : page.locator(`[data-dashboard-record="${selectedId}"]`).getByRole('button', { name: 'เตรียมงานติดตาม', exact: true });
      await trigger.click();
      const form = page.getByRole('form', { name: 'ตัวเลือกงานติดตาม' });
      await expect(form).toBeVisible();
      const optionValues = await form.getByLabel('ผู้รับผิดชอบ', { exact: true }).locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value));
      expect(optionValues).toEqual([baseline.actor.id, ...(baseline.taskAssigneeOptions ?? []).filter(option => option.id !== baseline.actor.id).map(option => option.id)]);
      await expect(form.getByLabel('ผู้รับผิดชอบ', { exact: true })).toBeFocused();
      await form.getByRole('button', { name: 'ยกเลิก', exact: true }).click();
      await expect(form).toHaveCount(0);
      await expect(trigger).toBeFocused();
      expect(writes).toEqual([]);

      await trigger.click();
      await form.getByLabel('ผู้รับผิดชอบ', { exact: true }).selectOption(east!.id);
      const personName = await form.getByLabel('ผู้รับผิดชอบ', { exact: true }).locator('option:checked').innerText();
      expect(personName).toBe(east!.label);
      expect(personName).not.toContain(east!.id);
      await form.getByLabel('กำหนดส่ง (ไม่จำเป็น)', { exact: true }).fill('2026-10-12');
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      await page.screenshot({ path: testInfo.outputPath(`task-options-${entryPoint}-${width}.png`) });
      await form.getByRole('button', { name: 'เติมคำขอในบทสนทนา', exact: true }).click();
      const composer = page.getByRole('textbox', { name: 'ข้อความถึง DaTex' });
      const prepared = `ช่วยเตรียม Task ติดตามสาขาที่ยอดขายต่ำกว่าเป้า จาก Dashboard “${dashboard.spec.title}” มอบหมายให้ ${personName} กำหนดส่งวันที่ 2026-10-12`;
      await expect(composer).toHaveValue(prepared);
      await expect(composer).toBeFocused();
      expect(writes).toEqual([]);
      expect(submissions).toHaveLength(0);
      expect(await page.evaluate(() => sessionStorage.getItem('biztania:dashboard-prefill:v1'))).toBeNull();

      await composer.fill(`${prepared} โดยสรุปสิ่งที่ต้องตรวจสอบด้วย`);
      await page.getByRole('button', { name: 'ส่ง', exact: true }).click();
      await expect.poll(() => submissions.length).toBe(1);
      expect(submissions[0]).toMatchObject({ message: `${prepared} โดยสรุปสิ่งที่ต้องตรวจสอบด้วย`, targets: [{ kind: 'dashboard', id: selectedId }] });
      expect(submissions[0].catalogEntryId).toBeUndefined();
    });
  }
}
