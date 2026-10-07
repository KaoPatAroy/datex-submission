import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Workspace } from '../../lib/contracts';

// Router flows: private direct creation/rename, confirm-tier deletion, structured clarification chips, shared effects
// (message + monitor) staged for explicit confirmation, recipient inbox, and artifact export. Typed text is planned by the
// local scripted TurnPlan double (exact prompts); every effect below still needs an explicit confirmation by the user.
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

/** Sends a typed prompt in Live AI and returns the newly completed assistant message. */
async function ask(page: Page, prompt: string): Promise<Locator> {
  const before = await workspace(page);
  const known = new Set(before.messages.map(message => message.id));
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

test('private dashboard: created directly, renamed directly, deleted only after confirmation', async ({ page }) => {
  await login(page, 'executive');
  const start = (await workspace(page)).dashboards.length;

  const created = await ask(page, 'Create dashboard.');
  await expect(created).toContainText('Sales overview');
  await expect(created.getByRole('button', { name: 'ตรวจและยืนยัน', exact: true })).toHaveCount(0);
  let current = await workspace(page);
  expect(current.dashboards).toHaveLength(start + 1);
  const dashboardId = current.dashboards.find(item => item.spec.title === 'Sales overview')!.id;
  expect(current.actions.filter(action => action.status === 'pending')).toEqual([]);

  const renamed = await ask(page, 'Rename my dashboard to Regional pulse');
  await expect(renamed).toContainText('Regional pulse');
  await expect(renamed.getByRole('button', { name: 'ตรวจและยืนยัน', exact: true })).toHaveCount(0);
  current = await workspace(page);
  expect(current.dashboards.find(item => item.id === dashboardId)?.spec.title).toBe('Regional pulse');

  const requested = await ask(page, 'Delete my dashboard');
  const card = requested.locator('[data-staged-proposal-id]');
  await expect(card).toBeVisible();
  // Nothing is deleted by asking.
  expect((await workspace(page)).dashboards.some(item => item.id === dashboardId)).toBe(true);
  await card.getByRole('button', { name: 'ตรวจและยืนยัน', exact: true }).click();
  const dialog = page.locator('dialog[data-staged-dialog]');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: /ลบ Dashboard/ })).toBeVisible();
  expect((await workspace(page)).dashboards.some(item => item.id === dashboardId)).toBe(true);
  await dialog.getByRole('button', { name: 'ยืนยันลบ Dashboard', exact: true }).click();
  await expect(dialog.getByRole('status', { name: 'ผลการดำเนินการ' })).toContainText('ดำเนินการและตรวจผลแล้ว');
  await dialog.getByRole('button', { name: 'ปิด', exact: true }).click();
  await expect.poll(async () => (await workspace(page)).dashboards.some(item => item.id === dashboardId)).toBe(false);
});

test('private dashboard organization via chat: pin, archive (pin refused while archived), restore, duplicate — direct, same rules as the Dashboard page', async ({ page }) => {
  await login(page, 'executive');
  await ask(page, 'Create dashboard.');
  let current = await workspace(page);
  const dashboardId = [...current.dashboards].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!.id;
  const byId = async () => (await workspace(page)).dashboards.find(item => item.id === dashboardId)!;

  const pinned = await ask(page, 'Pin my dashboard.');
  await expect(pinned).toContainText('ปักหมุด Dashboard');
  await expect(pinned.getByRole('button', { name: 'ตรวจและยืนยัน', exact: true })).toHaveCount(0);
  expect((await byId()).pinnedAt).toBeTruthy();

  await ask(page, 'Archive my dashboard.');
  expect((await byId()).archivedAt).toBeTruthy();
  const refused = await ask(page, 'Pin my dashboard.');
  await expect(refused).toContainText('ยังไม่ได้ดำเนินการ');
  expect((await byId()).pinnedAt).toBeFalsy();

  await ask(page, 'Restore my archived dashboard.');
  expect((await byId()).archivedAt).toBeFalsy();

  const before = (await workspace(page)).dashboards.length;
  const copied = await ask(page, 'Duplicate my dashboard.');
  await expect(copied).toContainText('ทำสำเนา Dashboard');
  current = await workspace(page);
  expect(current.dashboards).toHaveLength(before + 1);
  expect(current.dashboards.some(item => item.id !== dashboardId && item.spec.title.startsWith('สำเนา — '))).toBe(true);
});

test('clarification chips: tapping a recipient completes the share, which still needs explicit confirmation', async ({ page }) => {
  await login(page, 'executive');
  await ask(page, 'Create dashboard.');
  const asked = await ask(page, 'Share my dashboard');
  await expect(asked).toContainText('แชร์ Dashboard นี้ให้ใคร');
  const chips = asked.getByRole('group', { name: 'ตัวเลือกเพื่อตอบคำถามที่ผู้ช่วยถาม' });
  await expect(chips).toBeVisible();
  const eastChip = chips.getByRole('button', { name: 'ผู้จัดการภาคตะวันออก' });
  await expect(eastChip).toHaveCount(1);
  const before = await workspace(page);
  const known = new Set(before.messages.map(message => message.id));
  const request = page.waitForRequest(item => item.url().endsWith('/api/chat/stream') && item.method() === 'POST');
  await eastChip.click();
  // The chip sends the structured choice id and the clarified turn id (never text for parsing).
  expect((await request).postDataJSON()).toMatchObject({ clarificationChoiceId: expect.any(String), clarifiedTurnId: expect.any(String) });
  await expect.poll(async () => (await workspace(page)).actions.some(action => action.payload.kind === 'dashboard_share' && action.status === 'pending')).toBe(true);
  const pending = (await workspace(page)).actions.find(action => action.payload.kind === 'dashboard_share' && action.status === 'pending')!;
  expect((await workspace(page)).messages.some(message => !known.has(message.id) && message.role === 'assistant')).toBe(true);
  expect((await workspace(page)).receipts.some(receipt => receipt.actionId === pending.id)).toBe(false);

  await page.getByRole('navigation', { name: 'เมนูหลัก' }).getByRole('button', { name: 'งานและการอนุมัติ', exact: true }).click();
  await page.locator(`[data-action-review="${pending.id}"]`).click();
  await page.getByRole('dialog').getByRole('button', { name: 'แชร์ Dashboard', exact: true }).click();
  await expect.poll(async () => (await workspace(page)).receipts.some(receipt => receipt.actionId === pending.id && receipt.status === 'verified_success')).toBe(true);
});

test('communication.send is staged, confirmed by the sender, and then appears in the recipient messages', async ({ page }) => {
  await login(page, 'executive');
  await ask(page, 'Show East sales totals for 2026-10-01.');
  const answer = await ask(page, 'Send this answer to East manager.');
  const card = answer.locator('[data-staged-proposal-id]');
  await expect(card).toBeVisible();
  await expect(card).toContainText('ส่งข้อความ');
  await card.getByRole('button', { name: 'ตรวจและยืนยัน', exact: true }).click();
  const dialog = page.locator('dialog[data-staged-dialog]');
  await expect(dialog.getByRole('list', { name: 'ข้อมูลที่จะดำเนินการ' }).or(dialog.getByLabel('ข้อมูลที่จะดำเนินการ'))).toBeVisible();
  await dialog.getByRole('button', { name: 'ยืนยันส่งข้อความ', exact: true }).click();
  await expect(dialog.getByRole('status', { name: 'ผลการดำเนินการ' })).toContainText('ดำเนินการและตรวจผลแล้ว');
  await dialog.getByRole('button', { name: 'ปิด', exact: true }).click();

  // The sender does not receive their own message.
  await page.getByRole('navigation', { name: 'เมนูหลัก' }).getByRole('button', { name: 'ข้อความ', exact: true }).click();
  await expect(page.getByText('ยังไม่มีข้อความ', { exact: false })).toBeVisible();

  await page.getByRole('button', { name: 'ออกจากระบบ', exact: true }).click();
  await login(page, 'east');
  await page.getByRole('navigation', { name: 'เมนูหลัก' }).getByRole('button', { name: 'ข้อความ', exact: true }).click();
  const inbox = page.getByRole('region', { name: 'กล่องข้อความ' });
  await expect(inbox).toBeVisible();
  await expect(inbox.locator('article')).toHaveCount(1);
  await expect(inbox.locator('article').first()).toContainText('จาก');
  await expect(inbox.locator('article').first()).toContainText('ภาคตะวันออก');
});

test('monitor.create is staged and installed only after explicit confirmation', async ({ page }) => {
  await login(page, 'executive');
  await ask(page, 'Show East sales and target for 2026-10-01.');
  const answer = await ask(page, 'Alert East manager when sales fall below 90% of target.');
  const card = answer.locator('[data-staged-proposal-id]');
  await expect(card).toBeVisible();
  await expect(card).toContainText('สร้าง Monitor');
  await card.getByRole('button', { name: 'ตรวจและยืนยัน', exact: true }).click();
  const dialog = page.locator('dialog[data-staged-dialog]');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('วันละครั้งเวลาประมาณ 08:00 น.');
  await dialog.getByRole('button', { name: 'ยืนยันสร้าง Monitor', exact: true }).click();
  await expect(dialog.getByRole('status', { name: 'ผลการดำเนินการ' })).toContainText('ดำเนินการและตรวจผลแล้ว');
});

test('AI-proposed follow-up questions appear as chips and only prefill the composer', async ({ page }) => {
  await login(page, 'executive');
  const answer = await ask(page, 'Show East sales and target for 2026-10-01.');
  const region = answer.getByRole('region', { name: 'ลองถามต่อ', exact: true });
  await expect(region.getByRole('button')).toHaveCount(2);
  await expect(region.getByRole('button').first()).toContainText('เปรียบเทียบกับภูมิภาคอื่นได้ไหม');
  await region.getByRole('button').first().click();
  await expect(page.getByRole('textbox', { name: 'ข้อความถึง DaTex' })).toHaveValue('เปรียบเทียบกับภูมิภาคอื่นได้ไหม');
});

test('artifact export downloads the exact CSV file of the answer', async ({ page }) => {
  await login(page, 'executive');
  const answer = await ask(page, 'Export East sales and target for 2026-10-01 as a CSV file.');
  const actions = answer.locator('[data-artifact-actions]');
  await expect(actions).toBeVisible();
  const download = page.waitForEvent('download');
  await actions.getByRole('button', { name: 'ส่งออก CSV', exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.csv$/);
  const stream = await file.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const csv = Buffer.concat(chunks).toString('utf8');
  expect(csv.split(/\r?\n/).filter(Boolean).length).toBeGreaterThanOrEqual(2);
  expect(csv).not.toMatch(/SO-|session|csrf/i);
});
