import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Workspace } from '../../lib/contracts';

// Lane I: resource management without chat. Results library (recent -> save -> rename -> pin -> archive -> unarchive -> search/filter -> add to Dashboard),
// all 11 Dashboard families from scripted plans, and direct Dashboard management (description, reorder, remove, stale rename conflict).
// Typed text is planned by the local scripted TurnPlan double (exact prompts); the UI calls the same server operations the AI uses.
test.setTimeout(180_000);

const FAMILY_PROMPTS = [
  'Build a dashboard of East sales and target by branch for 2026-10-01 with every chart family.',
  'Add a 3-day East sales trend to my dashboard.',
  'Add the East total sales for 2026-10-01 to my dashboard.',
] as const;
const COMBO = 'Make a combo chart of East sales and target by branch for 2026-10-01.';

async function workspace(page: Page): Promise<Workspace> {
  const response = await page.request.get('/api/workspace');
  expect(response.status()).toBe(200);
  return response.json();
}
async function login(page: Page, profile: 'executive' | 'east') {
  expect((await page.request.get('/api/session', { timeout: 60_000 })).status()).toBe(401);
  await page.goto('/');
  await page.getByLabel('โปรไฟล์', { exact: true }).selectOption(profile);
  await page.getByLabel('รหัสเข้าใช้งาน', { exact: true }).fill('nexus-test-access');
  await page.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true }).click();
  await expect(page.getByRole('region', { name: 'บทสนทนากับ DaTex', exact: true })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'เปลี่ยนโหมดการทำงาน' })).toBeChecked();
}
async function ask(page: Page, prompt: string): Promise<Locator> {
  const known = new Set((await workspace(page)).messages.map(message => message.id));
  await page.getByRole('textbox', { name: 'ข้อความถึง DaTex' }).fill(prompt);
  await page.getByRole('button', { name: 'ส่ง', exact: true }).click();
  let answerId = '';
  await expect.poll(async () => {
    const answer = (await workspace(page)).messages.find(message => message.role === 'assistant' && !known.has(message.id));
    answerId = answer?.id ?? '';
    return answerId;
  }, { timeout: 30_000 }).not.toBe('');
  const article = page.locator(`[data-message-id="${answerId}"]`);
  await expect(article).toHaveAttribute('data-delivery', 'complete');
  await expect(page.getByRole('textbox', { name: 'ข้อความถึง DaTex' })).toBeEnabled();
  return article;
}
const nav = (page: Page, name: string) => page.getByRole('navigation', { name: 'เมนูหลัก' }).getByRole('button', { name, exact: true }).click();
async function csrf(page: Page): Promise<string> { return (await (await page.request.get('/api/session')).json()).csrfToken as string; }
async function openDashboard(page: Page, title: string) {
  await nav(page, 'Dashboard');
  await page.getByRole('button', { name: title, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
}
// The specs of one file share one DB, and the scripted title is the same on every run, so each test addresses the Dashboard IT created by id (never by title).
async function newDashboardIdAny(page: Page, before: Set<string>): Promise<string> {
  let id = '';
  await expect.poll(async () => { id = (await workspace(page)).dashboards.find(d => !before.has(d.id))?.id ?? ''; return id; }).not.toBe('');
  return id;
}
async function newDashboardId(page: Page, before: Set<string>, title: string): Promise<string> {
  let id = '';
  await expect.poll(async () => { id = (await workspace(page)).dashboards.find(d => !before.has(d.id) && d.spec.title === title)?.id ?? ''; return id; }).not.toBe('');
  return id;
}
const dashboardIds = async (page: Page) => new Set((await workspace(page)).dashboards.map(d => d.id));
const dashboardById = async (page: Page, id: string) => (await workspace(page)).dashboards.find(d => d.id === id);
async function openDashboardById(page: Page, id: string, title: string) {
  await page.goto(`/dashboards/${encodeURIComponent(id)}`);
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
}
async function familiesDashboard(page: Page): Promise<string> {
  const before = await dashboardIds(page);
  for (const prompt of FAMILY_PROMPTS) await ask(page, prompt);
  const id = await newDashboardId(page, before, 'East chart families');
  await expect.poll(async () => (await dashboardById(page, id))?.spec.widgets.length).toBe(11);
  return id;
}
async function newFamilyDashboard(page: Page): Promise<string> {
  const before = await dashboardIds(page);
  await ask(page, FAMILY_PROMPTS[0]);
  return newDashboardId(page, before, 'East chart families');
}

test('all 11 Dashboard families render from scripted plans and reload as the same families', async ({ page }) => {
  await login(page, 'executive');
  const familiesId = await familiesDashboard(page);
  const check = async () => {
    for (const primitive of ['bar', 'scatter', 'pie', 'donut', 'treemap', 'combo', 'line', 'area', 'heatmap']) {
      await expect(page.locator(`figure[data-chart-primitive="${primitive}"]`).first()).toBeVisible();
    }
    await expect(page.locator('[data-viz-widget="kpi"]')).toBeVisible();
    await expect(page.locator('[data-viz-widget="table"]')).toBeVisible();
  };
  await openDashboardById(page, familiesId, 'East chart families');
  await check();
  await page.reload();
  await check(); // reload re-reads every widget under the viewer and draws the same families
});

test('Dashboard direct management: description, reorder, remove with confirmation, and a stale rename is refused', async ({ page }) => {
  await login(page, 'executive');
  const dashboardId = await newFamilyDashboard(page);
  await openDashboardById(page, dashboardId, 'East chart families');
  const manage = page.locator('[data-dashboard-manage]');
  await manage.locator('summary').click();
  await manage.locator('[data-dashboard-description-input]').fill('คำอธิบายที่แก้ด้วยมือ');
  await manage.getByRole('button', { name: 'บันทึกคำอธิบาย', exact: true }).click();
  await expect(manage.locator('[data-dashboard-manage-notice]')).toContainText('บันทึกคำอธิบายแล้ว');

  const titles = () => manage.locator('[data-manage-widget] strong').allTextContents();
  const before = await titles();
  await manage.locator('[data-manage-widget="1"] [data-widget-action="up"]').click();
  await expect.poll(titles).toEqual([before[1], before[0], ...before.slice(2)]);
  await manage.locator('[data-manage-widget="0"] [data-widget-action="remove"]').click();
  await manage.locator('[data-widget-remove-confirm]').getByRole('button', { name: 'ยืนยันเอาออก', exact: true }).click();
  await expect.poll(async () => (await titles()).length).toBe(before.length - 1);
  await page.reload();
  await expect.poll(async () => (await dashboardById(page, dashboardId))?.spec.description).toBe('คำอธิบายที่แก้ด้วยมือ');

  // Stale page: another writer renames first (same server write path); the UI rename then gets a conflict and never overwrites.
  const dashboard = (await dashboardById(page, dashboardId))!;
  const token = await csrf(page);
  const fresh = await (await page.request.get(`/api/dashboards/${encodeURIComponent(dashboard.id)}`)).json() as { revision: string };
  await openDashboardById(page, dashboardId, 'East chart families');
  const bumped = await page.request.patch(`/api/dashboards/${encodeURIComponent(dashboard.id)}`, { headers: { 'x-csrf-token': token, origin: new URL(page.url()).origin, 'content-type': 'application/json' }, data: { title: 'ชื่อจากอีกหน้าจอ', baseRevision: fresh.revision } });
  expect(bumped.status()).toBe(200);
  await page.getByRole('button', { name: 'เปลี่ยนชื่อ', exact: true }).first().click();
  await page.getByRole('textbox', { name: 'ชื่อ Dashboard' }).fill('ชื่อที่ทับไม่ได้');
  await page.getByRole('button', { name: 'บันทึกชื่อ', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'ถูกแก้ไขไปแล้ว' })).toBeVisible();
  expect((await workspace(page)).dashboards.find(d => d.id === dashboard.id)?.spec.title).toBe('ชื่อจากอีกหน้าจอ');
});

test('Results library: recent -> save -> rename -> pin -> archive -> unarchive -> search/filter -> add to Dashboard', async ({ page }) => {
  await login(page, 'executive');
  const dashboardId = await newFamilyDashboard(page);
  const answer = await ask(page, COMBO);
  await expect(answer.locator('figure[data-chart-primitive="combo"]')).toBeVisible();
  await nav(page, 'ผลลัพธ์');
  const library = page.locator('[data-results-library]');
  const item = library.locator('[data-result]').first();
  await expect(item).toHaveAttribute('data-result-section', 'recent'); // a chat Result starts under Recent
  await item.locator('[data-result-action="save"]').click();
  await expect(library.locator('[data-result][data-result-section="saved"]').first()).toBeVisible();
  await page.reload();
  await nav(page, 'ผลลัพธ์');
  await expect(library.locator('[data-result][data-result-section="saved"]').first()).toBeVisible(); // survives a reload

  const saved = library.locator('[data-result][data-result-section="saved"]').first();
  await saved.locator('[data-result-action="rename"]').click();
  await saved.locator('[data-result-rename-input]').fill('ยอดขายและเป้าภาคตะวันออก');
  await saved.getByRole('button', { name: 'บันทึกชื่อ', exact: true }).click();
  await expect(library.locator('[data-result]', { hasText: 'ยอดขายและเป้าภาคตะวันออก' })).toBeVisible();
  const renamed = library.locator('[data-result]', { hasText: 'ยอดขายและเป้าภาคตะวันออก' });
  await renamed.locator('[data-result-action="pin"]').click();
  await expect(renamed).toHaveAttribute('data-result-pinned', 'true');
  await renamed.locator('[data-result-action="unpin"]').click();
  await expect(renamed).toHaveAttribute('data-result-pinned', 'false');

  await library.locator('[data-results-search]').fill('ภาคตะวันออก');
  await expect(library.locator('[data-result]', { hasText: 'ยอดขายและเป้าภาคตะวันออก' })).toBeVisible();
  await library.locator('[data-results-search]').fill('ไม่มีผลลัพธ์ชื่อนี้');
  await expect(library.locator('[data-results-no-match]')).toBeVisible();
  await library.locator('[data-results-search]').fill('');
  await library.locator('[data-results-kind]').selectOption('table');
  await expect(library.locator('[data-results-no-match]')).toBeVisible();
  await library.locator('[data-results-kind]').selectOption('chart');
  await expect(renamed).toBeVisible();

  await renamed.locator('[data-result-action="archive"]').click();
  await expect(library.locator('[data-results-archived]')).toBeVisible();
  await library.locator('[data-results-archived] > summary').click();
  const archived = library.locator('[data-results-archived] [data-result]', { hasText: 'ยอดขายและเป้าภาคตะวันออก' });
  await expect(archived).toBeVisible();
  await archived.locator('[data-result-action="unarchive"]').click();
  await expect(library.locator('[data-result][data-result-section="saved"]', { hasText: 'ยอดขายและเป้าภาคตะวันออก' })).toBeVisible();

  const target = library.locator('[data-result]', { hasText: 'ยอดขายและเป้าภาคตะวันออก' });
  await target.locator('[data-result-action="add-to-dashboard"]').click();
  await target.locator('[data-result-dashboard-select]').selectOption({ value: dashboardId });
  await target.getByRole('button', { name: 'เพิ่ม', exact: true }).click();
  await expect(library.locator('[data-results-notice]')).toContainText('เข้า Dashboard แล้ว');
  await expect.poll(async () => (await dashboardById(page, dashboardId))?.spec.widgets.at(-1)).toMatchObject({ type: 'viz', kind: 'combo' });
  await openDashboardById(page, dashboardId, 'East chart families');
  await expect(page.locator('figure[data-chart-primitive="combo"]').first()).toBeVisible(); // a live, re-authorized widget, not an image
});

// A shared Dashboard edited from the normal UI becomes the SAME staged confirm proposal chat creates (confirm dialog, base revision CAS); nothing changes until confirmed.
async function shareSalesDashboard(page: Page): Promise<{ id: string; title: string }> {
  const known = await dashboardIds(page);
  await ask(page, 'Create a sales dashboard');
  const id = await newDashboardIdAny(page, known);
  await ask(page, 'Share dashboard with East manager.');
  await expect.poll(async () => (await workspace(page)).actions.some(action => action.payload.kind === 'dashboard_share' && action.status === 'pending')).toBe(true);
  const pending = (await workspace(page)).actions.find(action => action.payload.kind === 'dashboard_share' && action.status === 'pending')!;
  await nav(page, 'งานและการอนุมัติ');
  await page.locator(`[data-action-review="${pending.id}"]`).click();
  await page.getByRole('dialog').getByRole('button', { name: 'แชร์ Dashboard', exact: true }).click();
  await expect.poll(async () => (await workspace(page)).receipts.some(receipt => receipt.actionId === pending.id && receipt.status === 'verified_success')).toBe(true);
  return { id, title: (await dashboardById(page, id))!.spec.title };
}

test('Shared Dashboard direct UI edit: description edit opens the staged confirm dialog, cancel changes nothing, confirm applies it', async ({ page }) => {
  await login(page, 'executive');
  const { id: sharedId, title } = await shareSalesDashboard(page);
  const description = () => dashboardById(page, sharedId).then(d => d?.spec.description);
  const original = await description();
  await openDashboardById(page, sharedId, title);
  const manage = page.locator('[data-dashboard-manage]');
  await manage.locator('summary').click();
  await manage.locator('[data-dashboard-description-input]').fill('คำอธิบายที่รอยืนยัน');
  await manage.getByRole('button', { name: 'บันทึกคำอธิบาย', exact: true }).click();
  const dialog = page.locator('dialog[data-staged-dialog]');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: /แก้ไข Dashboard ที่แชร์แล้ว/ })).toBeVisible();
  expect(await description()).toBe(original); // nothing changed by asking
  await dialog.getByRole('button', { name: 'ยกเลิกรายการ', exact: true }).click();
  await dialog.getByRole('button', { name: 'ปิด', exact: true }).click();
  expect(await description()).toBe(original);

  await manage.locator('[data-dashboard-description-input]').fill('คำอธิบายที่ยืนยันแล้ว');
  await manage.getByRole('button', { name: 'บันทึกคำอธิบาย', exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'ยืนยันแก้ไข Dashboard', exact: true }).click();
  await expect(dialog.getByRole('status', { name: 'ผลการดำเนินการ' })).toContainText('ดำเนินการและตรวจผลแล้ว');
  await dialog.getByRole('button', { name: 'ปิด', exact: true }).click();
  await expect.poll(description).toBe('คำอธิบายที่ยืนยันแล้ว');
});

test('Shared Dashboard: Add Result from the Results library stages the confirm dialog and applies only after confirm', async ({ page }) => {
  await login(page, 'executive');
  const { id: sharedId } = await shareSalesDashboard(page);
  await nav(page, 'แชต'); // the share was confirmed on the approvals page; asking needs the chat screen
  const answer = await ask(page, COMBO);
  await expect(answer.locator('figure[data-chart-primitive="combo"]')).toBeVisible();
  const widgets = () => dashboardById(page, sharedId).then(d => d?.spec.widgets.length ?? 0);
  const before = await widgets();
  await nav(page, 'ผลลัพธ์');
  const library = page.locator('[data-results-library]');
  const item = library.locator('[data-result]').first();
  await item.locator('[data-result-action="add-to-dashboard"]').click();
  await item.locator('[data-result-dashboard-select]').selectOption({ value: sharedId });
  await item.getByRole('button', { name: 'เพิ่ม', exact: true }).click();
  const dialog = page.locator('dialog[data-staged-dialog]');
  await expect(dialog).toBeVisible();
  expect(await widgets()).toBe(before);
  await dialog.getByRole('button', { name: 'ยืนยันแก้ไข Dashboard', exact: true }).click();
  await expect(dialog.getByRole('status', { name: 'ผลการดำเนินการ' })).toContainText('ดำเนินการและตรวจผลแล้ว');
  await dialog.getByRole('button', { name: 'ปิด', exact: true }).click();
  await expect.poll(widgets).toBe(before + 1);
});

test('Replace widget: a private Dashboard widget changes family from the manage panel (same bound data, server-validated)', async ({ page }) => {
  await login(page, 'executive');
  const dashboardId = await newFamilyDashboard(page);
  await openDashboardById(page, dashboardId, 'East chart families');
  const manage = page.locator('[data-dashboard-manage]');
  await manage.locator('summary').click();
  const row = manage.locator('[data-manage-widget="1"]'); // widget 0 is already a table; widget 1 is the bar chart
  await row.locator('[data-widget-action="replace"]').click();
  await row.locator('[data-widget-replace-select]').selectOption('table');
  await row.getByRole('button', { name: 'ใช้รูปแบบนี้', exact: true }).click();
  await expect(manage.locator('[data-dashboard-manage-notice]')).toBeVisible();
  await expect.poll(async () => (await dashboardById(page, dashboardId))?.spec.widgets[1]).toMatchObject({ type: 'viz', kind: 'table' });
});

test('AI parity: the same Results library operations by chat (rename, pin, archive, restore) show up in the library', async ({ page }) => {
  await login(page, 'executive');
  await ask(page, FAMILY_PROMPTS[0]);
  const answer = await ask(page, COMBO);
  await expect(answer.locator('figure[data-chart-primitive="combo"]')).toBeVisible();
  await ask(page, 'Rename my latest result to East weekly view.');
  await ask(page, 'Pin my latest result.');
  await nav(page, 'ผลลัพธ์');
  const library = page.locator('[data-results-library]');
  const item = library.locator('[data-result]', { hasText: 'East weekly view' });
  await expect(item).toHaveAttribute('data-result-pinned', 'true');
  await nav(page, 'แชต');
  await ask(page, 'Archive my latest result.');
  await nav(page, 'ผลลัพธ์');
  await expect(library.locator('[data-results-archived] [data-result]', { hasText: 'East weekly view' })).toHaveCount(1);
  await nav(page, 'แชต');
  await ask(page, 'Restore my archived result.');
  await nav(page, 'ผลลัพธ์');
  await expect(library.locator('[data-result]:not([data-result-section="archived"])', { hasText: 'East weekly view' })).toBeVisible();
});

// Product closure J1 (PC-10 / PC-04): the owner revokes ONE Result share from the Results page and the recipient fails closed; a Result action is bound to the version it names.
test('closure J1: owner revokes a Result share (recipient cannot open it any more); Results actions name the exact version', async ({ page }) => {
  await login(page, 'executive');
  await ask(page, 'Make a bar chart of East sales by branch for 2026-10-01 with drilldown.');
  const shared = await ask(page, 'Share my chart with East manager.');
  const card = shared.locator('[data-staged-proposal-id]');
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'ตรวจและยืนยัน', exact: true }).click();
  const dialog = page.locator('dialog[data-staged-dialog]');
  await dialog.getByRole('button', { name: 'ยืนยันแชร์ผลลัพธ์', exact: true }).click();
  await expect(dialog.getByRole('status', { name: 'ผลการดำเนินการ' })).toContainText('ดำเนินการและตรวจผลแล้ว');
  await dialog.getByRole('button', { name: 'ปิด', exact: true }).click();

  await nav(page, 'ผลลัพธ์');
  const library = page.locator('[data-results-library]');
  // Earlier tests of this file left Results in the same library: address the one this test shared (by its title), not whichever sorts first.
  const item = library.locator('[data-result]').filter({ hasText: 'East sales by branch' }).first();
  // The version the action applies to is shown on the action itself (latest here, since no older version is open).
  await expect(item.locator('[data-result-share-revision]')).toHaveAttribute('data-result-share-revision', '1');
  // PC-10: archiving does not end a share, so the archived card keeps the revoke control (and offers no new share).
  await item.locator('[data-result-action="archive"]').click();
  await library.locator('[data-results-archived] > summary').click();
  const archivedItem = library.locator('[data-results-archived] [data-result]').filter({ hasText: 'East sales by branch' }).first();
  await expect(archivedItem.locator('[data-result-action="share"]')).toHaveCount(0);
  await archivedItem.locator('[data-share-manager="result"] summary').click();
  await expect(archivedItem.locator('[data-share-id]')).toHaveCount(1);
  await archivedItem.locator('[data-share-revoke]').click();
  await archivedItem.locator('[data-share-revoke-confirm]').click();
  await expect(archivedItem.locator('[data-share-notice]')).toContainText('เพิกถอนการแชร์');
  await expect(archivedItem.locator('[data-share-empty]')).toBeVisible();

  await page.getByRole('button', { name: 'ออกจากระบบ', exact: true }).click();
  await login(page, 'east');
  await nav(page, 'ข้อความ');
  const message = page.locator('[data-inbox-source="artifact_share"]');
  await expect(message).toHaveCount(1);
  await message.locator('[data-open-shared-artifact]').click();
  await expect(message.locator('[data-shared-artifact-error]')).toContainText('เพิกถอน');
  await expect(message.locator('figure[data-chart-primitive="bar"]')).toHaveCount(0);
});
