import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Workspace } from '../../lib/contracts';

// Closure P2 (direct UI, no new planner behaviour): Dashboard pin / archive / restore / duplicate, Monitor explanation + rename,
// History showing verified results and proposals that ended without an effect, Results origin link. Prompts are the existing scripted ones.
test.setTimeout(180_000);

const FAMILY_PROMPT = 'Build a dashboard of East sales and target by branch for 2026-10-01 with every chart family.';

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

test('Dashboard list: pin, duplicate, archive and restore from the library (no chat)', async ({ page }) => {
  await login(page, 'executive');
  await ask(page, FAMILY_PROMPT);
  await expect.poll(async () => (await workspace(page)).dashboards.length).toBeGreaterThan(0);
  await nav(page, 'Dashboard');
  const record = page.locator('[data-dashboard-record]').first();

  await record.locator('[data-dashboard-action="pin"]').click();
  await expect(record).toHaveAttribute('data-dashboard-pinned', 'true');
  await expect(record.locator('[data-dashboard-pin-badge]')).toBeVisible();
  await record.locator('[data-dashboard-action="unpin"]').click();
  await expect(record).toHaveAttribute('data-dashboard-pinned', 'false');

  const before = (await workspace(page)).dashboards.length;
  await record.locator('[data-dashboard-action="duplicate"]').click();
  await expect.poll(async () => (await workspace(page)).dashboards.length).toBe(before + 1);
  await expect(page.locator('[data-dashboard-record]').filter({ hasText: 'สำเนา —' })).toHaveCount(1);

  await record.locator('[data-dashboard-action="archive"]').click();
  const archived = page.locator('[data-dashboards-archived]');
  await expect(archived).toBeVisible();
  await archived.locator('summary').click();
  await expect(archived.locator('[data-dashboard-record]')).toHaveCount(1);
  await archived.locator('[data-dashboard-action="restore"]').click();
  await expect(page.locator('[data-dashboards-archived]')).toHaveCount(0);
});

test('Monitor: the condition and expiry are explained and the display title can be renamed', async ({ page }) => {
  await login(page, 'executive');
  await ask(page, 'Show East sales and target for 2026-10-01.');
  const answer = await ask(page, 'Alert East manager when sales fall below 90% of target.');
  const card = answer.locator('[data-staged-proposal-id]');
  await card.getByRole('button', { name: 'ตรวจและยืนยัน', exact: true }).click();
  const dialog = page.locator('dialog[data-staged-dialog]');
  await dialog.getByRole('button', { name: 'ยืนยันสร้าง Monitor', exact: true }).click();
  await expect(dialog.getByRole('status', { name: 'ผลการดำเนินการ' })).toContainText('ดำเนินการและตรวจผลแล้ว');
  await dialog.getByRole('button', { name: 'ปิด', exact: true }).click();

  await nav(page, 'งานและการอนุมัติ');
  const monitor = page.locator('[data-monitors] [data-monitor]').first();
  await monitor.locator('[data-monitor-explain] summary').click();
  await expect(monitor.locator('[data-monitor-explain]')).toContainText('ต่ำกว่า 90% ของเป้า');
  await monitor.locator('[data-monitor-action="rename"]').click();
  await monitor.locator('[data-monitor-rename-form] input').fill('ติดตามยอดขายตะวันออก');
  await monitor.getByRole('button', { name: 'บันทึกชื่อ', exact: true }).click();
  await expect(page.locator('[data-monitor-status]')).toContainText('ติดตามยอดขายตะวันออก');
  await expect(page.locator('[data-monitors] [data-monitor]').first()).toContainText('ติดตามยอดขายตะวันออก');

  // The verified result of the confirmed install is also reachable from History.
  await nav(page, 'ประวัติการทำงาน');
  await expect(page.locator('[data-router-history] [data-router-receipt]').first()).toBeVisible();
  await expect(page.locator('[data-router-history] [data-closed-proposals], [data-router-history] [data-closed-proposals-empty]').first()).toBeVisible();
});
