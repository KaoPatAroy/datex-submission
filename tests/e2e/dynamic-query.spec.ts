import { expect, test, type Page } from '@playwright/test';
import type { ConversationMessage, Workspace } from '../../lib/contracts';
import { createSeedData } from '../../lib/seed/generate';

// The sharded runner on claude/biztania-e2e-runner-20261006 sets this in the runner
// environment; Playwright's webServer inherits it. A webServer-only flag is insufficient.
test.skip(process.env.BIZTANIA_DYNAMIC_QUERY !== 'on', 'Dynamic E2E requires BIZTANIA_DYNAMIC_QUERY=on in the runner environment.');
test.setTimeout(90_000);
const date = '2026-10-01';
const seed = createSeedData(date);
function sales(branchIds: string[]) {
  // Same paid-order definition as the registered retail evidence reader, in THB.
  return seed.sales_orders.filter(row => row.date === date && row.status === 'paid' && branchIds.includes(row.branchId))
    .reduce((sum, row) => sum + row.amountSatang, 0) / 100;
}
const formatMoney = (value: number) => new Intl.NumberFormat('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
const regionSales = (region: string) => sales(seed.branches.filter(branch => branch.region === region).map(branch => branch.id));

async function workspace(page: Page): Promise<Workspace> {
  const response = await page.request.get('/api/workspace');
  expect(response.status()).toBe(200);
  return response.json();
}
async function login(page: Page, role: 'executive' | 'east', baseURL: string | undefined) {
  expect(new URL(baseURL!).hostname).toBe('127.0.0.1');
  await page.request.get('/api/session', { timeout: 60_000 });
  await page.goto('/');
  await page.getByLabel('โปรไฟล์', { exact: true }).selectOption(role);
  await page.getByLabel('รหัสเข้าใช้งาน', { exact: true }).fill('nexus-test-access');
  await page.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true }).click();
  const mode = page.getByRole('switch', { name: 'เปลี่ยนโหมดการทำงาน' });
  await expect(mode).toBeVisible();
  if (!await mode.isChecked()) await mode.click();
  await expect(mode).toBeChecked();
  expect((await workspace(page)).actor.mode).toBe('live_ai');
  const newConversation = page.getByRole('button', { name: 'บทสนทนาใหม่', exact: true });
  if (!await newConversation.isVisible()) await page.getByRole('button', { name: 'เปิดบทสนทนา', exact: true }).click();
  await newConversation.click();
}
async function ask(page: Page, prompt: string): Promise<ConversationMessage> {
  const before = await workspace(page);
  const priorIds = new Set(before.messages.map(message => message.id));
  const priorActionIds = new Set(before.actions.map(action => action.id));
  await page.getByLabel('ข้อความถึง DaTex').fill(prompt);
  await page.getByRole('button', { name: 'ส่ง', exact: true }).click();
  let answer: ConversationMessage | undefined;
  await expect.poll(async () => {
    answer = (await workspace(page)).messages.find(message => message.role === 'assistant'
      && message.sessionId === before.actor.sessionId && !priorIds.has(message.id));
    return answer?.text;
  }, { timeout: 30_000 }).toBeTruthy();
  if (!answer) throw new Error('No persisted assistant answer.');
  await expect(page.locator(`[data-message-id="${answer.id}"]`)).toHaveAttribute('data-delivery', 'complete');
  await expect(page.getByLabel('ข้อความถึง DaTex')).toBeEnabled();
  expect(answer.mode).toBe('live_ai');
  expect(answer.pendingActionId).toBeUndefined();
  expect(answer.pendingActionIds ?? []).toEqual([]);
  expect((await workspace(page)).actions.filter(action => !priorActionIds.has(action.id))).toEqual([]);
  return answer;
}

test('executive dynamic sales render grounded East, contextual Central, and E01 without a May date filter', async ({ page, baseURL }) => {
  await login(page, 'executive', baseURL);
  const first = await ask(page, 'ยอดขายภาคตะวันออกวันที่ 1 ตุลาคม 2569');
  const eastClaim = `ภาคตะวันออก มียอดขายสุทธิ ${formatMoney(regionSales('east'))} บาท.`;
  await expect(page.locator(`[data-message-id="${first.id}"]`)).toContainText(eastClaim);
  expect(first.text).toContain('4 สาขา');
  expect(first.analysis?.facts).toMatchObject([{ text: eastClaim }]);
  expect(first.sources?.some(source => source.id === `sales:E01:${date}`)).toBe(true);

  const follow = await ask(page, 'แล้วภาคกลางล่ะ');
  expect(follow.conversationId).toBe(first.conversationId);
  const followArticle = page.locator(`[data-message-id="${follow.id}"]`);
  await expect(followArticle).toContainText(`ขอบเขตที่ตีความ: ช่วงวันที่ ${date} (ต่อจากคำถามก่อน)`);
  expect(follow.text).not.toContain('Follow-up scope:');
  expect(follow.text).not.toContain('Follow-up dates:');
  await expect(followArticle).toContainText(`ภาคกลาง มียอดขายสุทธิ ${formatMoney(regionSales('central'))} บาท.`);
  await expect(followArticle).toContainText('(ต่อจากคำถามก่อน)');

  const branch = await ask(page, 'May I see E01 sales?');
  const article = page.locator(`[data-message-id="${branch.id}"]`);
  await expect(article).toContainText(`ยอดขายสุทธิ ${formatMoney(sales(['E01']))} บาท.`);
  await expect(article).toContainText(`ขอบเขตที่ตีความ: ช่วงวันที่ ${date}`);
  expect(branch.text.match(/^ขอบเขตที่ตีความ:/gmu)).toHaveLength(1);
  expect(branch.text).toContain('สาขา ตะวันออก 1');
  expect(branch.text).not.toContain('E01');
  expect(branch.text).not.toContain('\nScope:');
  expect(branch.text).not.toContain('Business dates:');
  expect(branch.text).not.toContain('2026-05');
  expect(branch.sources?.every(source => source.id.endsWith(`:E01:${date}`))).toBe(true);
  expect(branch.sources?.length).toBeGreaterThan(0);
});

test('East Manager dynamic South query renders a permission refusal with no action or numeric evidence', async ({ page, baseURL }) => {
  await login(page, 'east', baseURL);
  const answer = await ask(page, 'ยอดขายภาคใต้');
  await expect(page.locator(`[data-message-id="${answer.id}"]`)).toContainText('อยู่นอกสิทธิ์ของบัญชีนี้');
  expect(answer.analysis).toBeUndefined();
  expect(answer.sources ?? []).toEqual([]);
  expect(answer.text).not.toContain('net_sales:');
  expect(answer.text).not.toMatch(/S0[1-4]/);
});
