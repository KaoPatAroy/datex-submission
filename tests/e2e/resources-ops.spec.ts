import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Workspace } from '../../lib/contracts';

// Direct Monitor and Task operations from the operations page (no chat): the UI sends the canonical id + operation, the server validates.
// Fixtures reuse the scripted prompts of router-visual-flows.spec.ts to create one task and one monitor.
test.setTimeout(120_000);

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
const openOperations = (page: Page) => page.getByRole('navigation', { name: 'เมนูหลัก' }).getByRole('button', { name: 'งานและการอนุมัติ', exact: true }).click();
async function confirmCard(page: Page, answer: Locator, confirmLabel: string) {
  const card = answer.locator('[data-staged-proposal-id]');
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'ตรวจและยืนยัน', exact: true }).click();
  const dialog = page.locator('dialog[data-staged-dialog]');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: confirmLabel, exact: true }).click();
  await expect(dialog.getByRole('status', { name: 'ผลการดำเนินการ' })).toContainText('ดำเนินการและตรวจผลแล้ว');
  await dialog.getByRole('button', { name: 'ปิด', exact: true }).click();
}

test('Monitor: pause -> resume -> delete asks for confirmation (cancel keeps it, confirm removes it)', async ({ page }) => {
  await login(page, 'executive');
  await ask(page, 'Show East sales and target for 2026-10-01.');
  const answer = await ask(page, 'Alert East manager when sales fall below 90% of target.');
  await confirmCard(page, answer, 'ยืนยันสร้าง Monitor');
  await openOperations(page);
  const monitor = page.locator('[data-monitors] [data-monitor]').first();
  await expect(monitor).toContainText('ทำงานอยู่');
  await expect(monitor.locator('[data-monitor-action="resume"]')).toHaveCount(0);

  await monitor.locator('[data-monitor-action="pause"]').click();
  await expect(monitor).toContainText('หยุดชั่วคราว');
  await expect(page.locator('[data-monitor-status]')).toContainText('หยุด');
  await monitor.locator('[data-monitor-action="resume"]').click();
  await expect(monitor).toContainText('ทำงานอยู่');

  await monitor.locator('[data-monitor-action="delete"]').click();
  const dialog = monitor.getByRole('alertdialog');
  await expect(dialog).toContainText('จะไม่มีการแจ้งเตือนอีก ประวัติการตรวจที่ผ่านมายังดูได้ในหัวข้อ “Monitor ที่ลบแล้ว”');
  await dialog.getByRole('button', { name: 'ยกเลิก', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(monitor).toBeVisible();

  await monitor.locator('[data-monitor-action="delete"]').click();
  await monitor.getByRole('alertdialog').getByRole('button', { name: 'ยืนยันลบ Monitor', exact: true }).click();
  await expect(page.locator('[data-monitors] [data-monitor]')).toHaveCount(0);
  await expect(page.locator('[data-monitors-empty]')).toBeVisible();
  // Metadata-only audit events (kind, monitor id, operation) for every UI lifecycle change.
  const audit = (await workspace(page)).audit.filter(event => event.category === 'monitor_manage');
  expect(audit.map(event => event.summary)).toEqual(expect.arrayContaining(['monitor.pause', 'monitor.resume', 'monitor.delete']));
  expect(audit.every(event => /^monitor\.(pause|resume|delete)$/.test(event.summary) && !!event.actionId)).toBe(true);
});

test('Task: complete -> reopen -> edit (persists after reload) -> cancel -> archive', async ({ page }) => {
  await login(page, 'executive');
  const answer = await ask(page, 'Create an urgent East follow-up task due 2026-10-05 with a checklist.');
  await confirmCard(page, answer, 'ยืนยันสร้างงานติดตาม');
  await openOperations(page);
  const item = page.locator('[data-work-items] [data-work-item]').first();
  await expect(item).toHaveAttribute('data-work-item-state', 'open');

  await item.locator('[data-work-item-action="complete"]').click();
  await expect(item).toHaveAttribute('data-work-item-state', 'completed');
  await expect(item).toContainText('เสร็จแล้ว');
  await item.locator('[data-work-item-action="reopen"]').click();
  await expect(item).toHaveAttribute('data-work-item-state', 'open');

  await item.locator('[data-work-item-action="edit"]').click();
  const form = item.getByRole('form');
  await form.getByLabel('ชื่องาน').fill('งานติดตามที่แก้ไขแล้ว');
  await form.getByLabel('ความสำคัญ').selectOption('low');
  await form.getByRole('button', { name: 'บันทึก', exact: true }).click();
  await expect(item).toContainText('งานติดตามที่แก้ไขแล้ว');
  await page.reload();
  await openOperations(page);
  const reloaded = page.locator('[data-work-items] [data-work-item]').first();
  await expect(reloaded).toContainText('งานติดตามที่แก้ไขแล้ว');
  await expect(reloaded).toContainText('ความสำคัญ ต่ำ');

  await reloaded.locator('[data-work-item-action="cancel"]').click();
  await reloaded.getByRole('alertdialog').getByRole('button', { name: 'ยืนยันยกเลิกงาน', exact: true }).click();
  await expect(reloaded).toHaveAttribute('data-work-item-state', 'cancelled');
  await reloaded.locator('[data-work-item-action="archive"]').click();
  await expect(page.locator('[data-work-items] [data-work-item]')).toHaveCount(0);
  await page.locator('[data-work-items-archived] summary').click();
  await expect(page.locator('[data-work-items-archived] [data-work-item]')).toHaveAttribute('data-work-item-state', 'archived');
});
