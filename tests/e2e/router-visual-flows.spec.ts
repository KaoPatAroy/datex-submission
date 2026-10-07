import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Workspace } from '../../lib/contracts';

// Track B lane C flows: registered chart families + interactions + motion, artifact history reload, artifact sharing with per-recipient
// authorization, receipts, communication bound to an artifact, task.create fields and monitor history. Typed text is planned by the
// local scripted TurnPlan double (exact prompts); every effect still needs an explicit confirmation.
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
const openResults = (page: Page) => page.getByRole('navigation', { name: 'เมนูหลัก' }).getByRole('button', { name: 'ผลลัพธ์', exact: true }).click();
const openOperations = (page: Page) => page.getByRole('navigation', { name: 'เมนูหลัก' }).getByRole('button', { name: 'งานและการอนุมัติ', exact: true }).click();
const openMessages = (page: Page) => page.getByRole('navigation', { name: 'เมนูหลัก' }).getByRole('button', { name: 'ข้อความ', exact: true }).click();
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

test('interactive bar chart: tooltip, selection, cross-filter, drilldown through the server, reset, and reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await login(page, 'executive');
  const answer = await ask(page, 'Make a bar chart of East sales by branch for 2026-10-01 with drilldown.');
  const figure = answer.locator('figure[data-chart-primitive="bar"]');
  await expect(figure).toBeVisible();
  await expect(figure).toHaveAttribute('data-motion', 'none'); // prefers-reduced-motion wins over the requested reorder animation
  const mark = figure.locator('[data-mark]').first();
  await mark.focus();
  await expect(figure.locator('[data-chart-status]')).toContainText('บาท'); // keyboard focus shows the exact value
  await page.keyboard.press('Enter');
  await expect(mark).toHaveAttribute('aria-pressed', 'true');
  await expect(answer.locator('[data-table-filter]')).toBeVisible();
  await figure.locator('[data-chart-drill]').click();
  const drill = answer.locator('[data-artifact-drill]');
  await expect(drill).toBeVisible();
  await expect(drill.getByRole('status')).toContainText('ตรวจสิทธิ์ปัจจุบัน');
  await figure.locator('[data-chart-reset]').click();
  await expect(answer.locator('[data-table-filter]')).toHaveCount(0);
  await expect(drill).toHaveCount(0);
});

test('donut family: part-to-whole share with hover/focus dimming and an exact table alternative', async ({ page }) => {
  await login(page, 'executive');
  const answer = await ask(page, 'Make a donut chart of sales across all regions on 2026-10-01.');
  const figure = answer.locator('figure[data-chart-primitive="donut"]');
  await expect(figure).toBeVisible();
  await expect(figure).toHaveAttribute('data-motion', 'interpolate');
  const marks = figure.locator('[data-mark]');
  expect(await marks.count()).toBeGreaterThan(1);
  await marks.first().focus();
  await expect(marks.nth(1)).toHaveClass(/dim/); // unrelated marks are dimmed
  await expect(answer.getByRole('table')).toBeVisible();
});

test('a chart family the data cannot support falls back to the exact table and says why', async ({ page }) => {
  await login(page, 'executive');
  const answer = await ask(page, 'Make a scatter plot of East sales by branch for 2026-10-01.');
  await expect(answer).toContainText('ไม่เหมาะกับข้อมูลนี้');
  await expect(answer.locator('figure[data-chart-primitive]')).toHaveCount(0);
  await expect(answer.getByRole('table')).toBeVisible();
});

test('a saved artifact version reloads from history under current authority', async ({ page }) => {
  await login(page, 'executive');
  const answer = await ask(page, 'Make a combo chart of East sales and target by branch for 2026-10-01.');
  await expect(answer.locator('figure[data-chart-primitive="combo"]')).toBeVisible();
  await openResults(page);
  const history = page.locator('[data-results-library]');
  // Earlier tests of the same shard may have created Results for this actor: open the newest one (newest first).
  await expect(history.locator('[data-result]').first()).toBeVisible();
  await history.locator('[data-result]').first().locator('[data-result-action="open"]').click();
  const opened = history.locator('[data-artifact-opened]');
  await expect(opened).toBeVisible();
  await expect(opened.locator('figure[data-chart-primitive="combo"]')).toBeVisible();
});

test('artifact.share: confirmed by the sender, receipt readable, recipient opens it read-only; an out-of-scope recipient is refused', async ({ page }) => {
  await login(page, 'executive');
  await ask(page, 'Make a bar chart of East sales by branch for 2026-10-01 with drilldown.');
  const shared = await ask(page, 'Share my chart with East manager.');
  await confirmCard(page, shared, 'ยืนยันแชร์ผลลัพธ์');
  await openMessages(page);
  const receipt = page.locator('[data-router-receipt][data-receipt-kind="artifact_share"]');
  await expect(receipt).toBeVisible();
  await expect(receipt.locator('[data-receipt-recipients]')).toContainText('ผู้จัดการภาคตะวันออก');

  await page.getByRole('button', { name: 'ออกจากระบบ', exact: true }).click();
  await login(page, 'east');
  await openMessages(page);
  const message = page.locator('[data-inbox-source="artifact_share"]');
  await expect(message).toHaveCount(1);
  await message.locator('[data-open-shared-artifact]').click();
  await expect(message.locator('[data-artifact-shared-by]')).toBeVisible();
  await expect(message.locator('figure[data-chart-primitive="bar"]')).toBeVisible();
  await page.getByRole('button', { name: 'ออกจากระบบ', exact: true }).click();

  // An all-region artifact cannot be shared with a recipient who cannot read every region of it: nothing is staged, nothing delivered.
  await login(page, 'executive');
  await ask(page, 'Make a bar chart of sales across all regions on 2026-10-01.');
  const refused = await ask(page, 'Share my chart with East manager.');
  await expect(refused.locator('[data-staged-proposal-id]')).toHaveCount(0);
  await expect(refused).toContainText('ยังไม่มีสิทธิ์ดูข้อมูลครบทุกส่วน');
});

test('communication.send can carry an exact artifact version and the sender keeps a readable receipt', async ({ page }) => {
  await login(page, 'executive');
  await ask(page, 'Make a bar chart of East sales by branch for 2026-10-01 with drilldown.');
  const answer = await ask(page, 'Send this answer with my chart to East manager.');
  await expect(answer.locator('[data-staged-proposal-id]')).toContainText('พร้อมแนบผลลัพธ์');
  await confirmCard(page, answer, 'ยืนยันส่งข้อความ');
  await openMessages(page);
  await expect(page.locator('[data-router-receipt][data-receipt-kind="communication"]')).toContainText('ตรวจผลแล้ว');
  await page.getByRole('button', { name: 'ออกจากระบบ', exact: true }).click();
  await login(page, 'east');
  await openMessages(page);
  await expect(page.locator('[data-inbox-source="communication"] [data-message-bound-artifact]')).toBeVisible();
  // PC-08: the recipient opens the exact attached version through the same share/open path (authorization is rechecked server-side on every open).
  const attached = page.locator('[data-inbox-source="communication"]');
  await attached.locator('[data-open-shared-artifact]').click();
  await expect(attached.locator('figure[data-chart-primitive="bar"]')).toBeVisible();
});

test('task.create keeps priority, due date and checklist through confirmation and shows them in the work list', async ({ page }) => {
  await login(page, 'executive');
  const answer = await ask(page, 'Create an urgent East follow-up task due 2026-10-05 with a checklist.');
  await expect(answer.locator('[data-staged-proposal-id]')).toContainText('ด่วน');
  await confirmCard(page, answer, 'ยืนยันสร้างงานติดตาม');
  await openOperations(page);
  const item = page.locator('[data-work-items] [data-work-item]').first();
  await expect(item).toContainText('ครบกำหนด 2026-10-05');
  await expect(item).toContainText('ด่วน');
  await expect(item.getByRole('list', { name: 'รายการตรวจ' })).toContainText('Check sales');
});

test('an installed monitor is listed with its evaluation history and truthful recipient copy', async ({ page }) => {
  await login(page, 'executive');
  await ask(page, 'Show East sales and target for 2026-10-01.');
  const answer = await ask(page, 'Alert East manager when sales fall below 90% of target.');
  await expect(answer.locator('[data-staged-proposal-id]')).toContainText('และของ');
  await confirmCard(page, answer, 'ยืนยันสร้าง Monitor');
  await openOperations(page);
  const monitor = page.locator('[data-monitors] [data-monitor]').first();
  await expect(monitor).toBeVisible();
  await expect(monitor.locator('[data-monitor-no-history]')).toBeVisible(); // no scheduler tick has run yet
});

// Track B lane F: policy acknowledgement, table answers as sources of later steps, ticket plan fields.
test('policy.acknowledge is staged for the exact version, confirmed, and leaves a readable receipt', async ({ page }) => {
  await login(page, 'executive');
  await ask(page, 'Show the policy.');
  const answer = await ask(page, 'Acknowledge the policy.');
  await expect(answer.locator('[data-staged-proposal-id]')).toContainText('เวอร์ชัน');
  await confirmCard(page, answer, 'ยืนยันรับทราบ Policy');
  await openMessages(page);
  const receipt = page.locator('[data-router-receipt][data-receipt-kind="policy_acknowledgement"]');
  await expect(receipt).toContainText('รับทราบ Policy');
  await expect(receipt).toContainText('เวอร์ชัน');
});

test('a table answer feeds a Dashboard: widgets are bound to the inventory dataset and the answer says it was created', async ({ page }) => {
  await login(page, 'executive');
  const answer = await ask(page, 'Build a dashboard of low stock by branch.');
  await expect(answer).toContainText('Dashboard');
  await expect.poll(async () => (await workspace(page)).dashboards.some(d => d.spec.widgets.some(w => w.type === 'viz' && w.binding.datasetId === 'inventory_items'))).toBe(true);
});

test('a table answer feeds a table artifact and a chart', async ({ page }) => {
  await login(page, 'executive');
  const table = await ask(page, 'Make a table of low stock by branch.');
  await expect(table.getByRole('table')).toBeVisible();
  const chart = await ask(page, 'Make a bar chart of low stock by branch.');
  await expect(chart.locator('figure[data-chart-primitive="bar"]')).toBeVisible();
});

test('a monitor over a table answer is refused honestly instead of installing something that cannot evaluate', async ({ page }) => {
  await login(page, 'executive');
  await ask(page, 'Show low stock by branch.');
  const answer = await ask(page, 'Alert East manager when low stock is below 90%.');
  await expect(answer).toContainText('Monitor ตั้งได้เฉพาะคำตอบผลงานสาขา');
  await expect(answer.locator('[data-staged-proposal-id]')).toHaveCount(0);
});

test('ticket.create carries priority, due date and grouping into the approval the user reviews', async ({ page }) => {
  await login(page, 'executive');
  await ask(page, 'Open an urgent single ticket for E01 and E02 due 2026-10-05.');
  await expect.poll(async () => (await workspace(page)).actions.some(action => action.payload.kind === 'ticket_create' && action.status === 'pending')).toBe(true);
  const pending = (await workspace(page)).actions.find(action => action.payload.kind === 'ticket_create' && action.status === 'pending')!;
  expect(pending.payload).toMatchObject({ plan: { priority: 'urgent', dueDate: '2026-10-05', grouping: 'single', checklist: ['Check sales', 'Check stock'] } });
  await page.getByRole('navigation', { name: 'เมนูหลัก' }).getByRole('button', { name: 'งานและการอนุมัติ', exact: true }).click();
  await page.locator(`[data-action-review="${pending.id}"]`).click();
  await expect(page.getByRole('dialog').locator('[data-ticket-plan]')).toContainText('ด่วน');
  await expect(page.getByRole('dialog').locator('[data-ticket-plan]')).toContainText('ครบกำหนด 2026-10-05');
});
