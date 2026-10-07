import { expect, test, type Page } from '@playwright/test';
import type { PendingAction, Workspace } from '../../lib/contracts';

test.setTimeout(90_000);
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'wait' }); });
async function workspace(page: Page): Promise<Workspace> {
  const response = await page.request.get('/api/workspace');
  expect(response.status()).toBe(200);
  return response.json();
}
async function prepareBadge(page: Page, badgeId = 'C102', employeeId = 'E024') {
  await page.request.get('/api/session', { timeout: 60_000 });
  await page.goto('/');
  await page.getByLabel('โปรไฟล์', { exact: true }).selectOption('hr');
  await page.getByLabel('รหัสเข้าใช้งาน', { exact: true }).fill('nexus-test-access');
  await page.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true }).click();
  await expect(page.getByRole('switch')).toBeVisible();
  // Live AI (default): the router plans the typed request; each test revokes its own badge.
  await expect(page.getByRole('switch')).toBeChecked();
  const before = await workspace(page);
  const existing = new Set(before.actions.map(action => action.id));
  await page.getByLabel('ข้อความถึง DaTex').fill(`Revoke badge ${badgeId} for ${employeeId} because their employment ended.`);
  await page.getByRole('button', { name: 'ส่ง', exact: true }).click();
  let action: PendingAction | undefined;
  await expect.poll(async () => {
    action = (await workspace(page)).actions.find(item => !existing.has(item.id) && item.payload.kind === 'badge_revoke' && item.status === 'pending');
    return Boolean(action);
  }, { timeout: 20_000 }).toBe(true);
  if (!action || action.payload.kind !== 'badge_revoke') throw new Error('No real badge proposal was persisted');
  await page.getByRole('navigation', { name: 'เมนูหลัก' }).getByRole('button', { name: 'งานและการอนุมัติ', exact: true }).click();
  await expect(page.locator(`[data-action-review="${action.id}"]`)).toBeVisible();
  return action;
}

for (const width of [1440, 390]) {
  test(`real badge review refreshes exact current identity before confirmation at ${width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const action = await prepareBadge(page, width === 390 ? 'C001' : 'C102', width === 390 ? 'E001' : 'E024');
    const before = await workspace(page);
    const original = before.badgeReviews?.[action.id];
    expect(original?.status).toBe('current');
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let refreshStarted = false;
    let completedRefreshes = 0;
    let confirmationCount = 0;
    page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/actions/${action.id}/confirm`) confirmationCount += 1; });
    await page.route('**/api/workspace', async route => {
      const response = await route.fetch({ timeout: 15_000 });
      if (!refreshStarted) { refreshStarted = true; await held; }
      await route.fulfill({ response });
      completedRefreshes += 1;
    });
    try {
      await page.locator(`[data-action-review="${action.id}"]`).click();
      const dialog = page.getByRole('dialog', { name: 'ตรวจสอบก่อนยืนยัน: เพิกถอนบัตรพนักงาน', exact: true });
      const confirm = dialog.getByRole('button', { name: 'เพิกถอนบัตร', exact: true });
      await expect(dialog.locator('[data-badge-review-status]')).toHaveAttribute('data-badge-review-status', 'loading');
      await expect(confirm).toBeDisabled();
      await expect(dialog).toContainText('ยังไม่มีชื่อที่ตรวจสอบล่าสุด');
      expect(confirmationCount).toBe(0);
      await expect.poll(() => refreshStarted).toBe(true);
      release();
      await expect(dialog.locator('[data-badge-review-status]')).toHaveAttribute('data-badge-review-status', 'current');
      await expect.poll(() => completedRefreshes).toBeGreaterThan(0);
      await expect(confirm).toBeEnabled();
      if (action.payload.kind !== 'badge_revoke') throw new Error('Unexpected action kind');
      await expect(dialog).toContainText(action.payload.employeeId);
      await expect(dialog).toContainText(action.payload.badgeId);
      await expect(dialog).toContainText('พนักงานสาธิต');
      await expect(dialog).toContainText('ใช้งานอยู่');
      await expect(dialog.locator('dl > div').filter({ hasText: 'รุ่นข้อมูลบัตร' })).toContainText(String(original?.current?.badgeVersion));
      await expect(confirm).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: testInfo.outputPath(`badge-current-${width}.png`) });
      const beforeConfirmationRefreshes = completedRefreshes;
      await confirm.click();
      await expect.poll(async () => (await workspace(page)).receipts.some(receipt => receipt.actionId === action.id && receipt.status === 'verified_success'), { timeout: 15_000 }).toBe(true);
      expect(confirmationCount).toBe(1);
      await expect.poll(() => completedRefreshes).toBeGreaterThan(beforeConfirmationRefreshes);
    } finally { release(); }
  });
}

test('omitted mismatched stale unavailable and failed badge readbacks keep confirmation closed', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const action = await prepareBadge(page, 'C002', 'E002');
  let scenario: 'omitted' | 'mismatch' | 'stale' | 'unavailable' | 'network' | 'current' = 'omitted';
  let confirmations = 0;
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/confirm')) confirmations += 1; });
  await page.route('**/api/workspace', async route => {
    if (scenario === 'network') return route.abort();
    const response = await route.fetch({ timeout: 15_000 });
    const result = await response.json() as Workspace;
    const review = result.badgeReviews?.[action.id];
    if (!review || !result.badgeReviews) throw new Error('Expected real current badge readback before response-only fault');
    if (scenario === 'omitted') delete result.badgeReviews[action.id];
    if (scenario === 'mismatch') result.badgeReviews[action.id] = { ...review, payloadHash: 'different-proposal-hash' };
    if (scenario === 'stale') result.badgeReviews[action.id] = { ...review, status: 'stale' };
    if (scenario === 'unavailable') result.badgeReviews[action.id] = { ...review, status: 'unavailable', current: undefined };
    await route.fulfill({ response, json: result });
  });
  for (const value of ['omitted', 'mismatch', 'stale', 'unavailable', 'network'] as const) {
    scenario = value;
    await page.locator(`[data-action-review="${action.id}"]`).click();
    const dialog = page.getByRole('dialog', { name: 'ตรวจสอบก่อนยืนยัน: เพิกถอนบัตรพนักงาน', exact: true });
    await expect(dialog.locator('[data-badge-review-status]')).toHaveAttribute('data-badge-review-status', value === 'stale' ? 'stale' : 'unavailable');
    await expect(dialog.getByRole('button', { name: 'เพิกถอนบัตร', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('alert')).toContainText('ยังยืนยันไม่ได้');
    if (value !== 'stale') await expect(dialog).toContainText('ยังไม่มีชื่อที่ตรวจสอบล่าสุด');
    expect(confirmations).toBe(0);
    await page.screenshot({ path: testInfo.outputPath(`badge-${value}-390.png`) });
    await dialog.getByRole('button', { name: 'ปิดหน้าต่าง', exact: true }).click();
  }
  scenario = 'current';
  await page.locator(`[data-action-review="${action.id}"]`).click();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'เพิกถอนบัตร', exact: true })).toBeEnabled();
  expect(confirmations).toBe(0);
});
