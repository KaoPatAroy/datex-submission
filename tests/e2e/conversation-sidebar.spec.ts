import { expect, test, type Page } from '@playwright/test';
import type { ConversationView } from '../../lib/core/conversations';

test.setTimeout(90_000);
async function login(page: Page) {
  await page.request.get('/api/session', { timeout: 60_000 });
  await page.goto('/');
  await page.getByLabel('รหัสเข้าใช้งาน', { exact: true }).fill('nexus-test-access');
  await page.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true }).click();
  await expect(page.getByRole('switch')).toBeVisible();
  const response = await page.request.get('/api/session');
  return (await response.json()).csrfToken as string;
}

test('conversation metadata persists rename pin archive restore and recovers a stale edit', async ({ page }, testInfo) => {
  const csrf = await login(page);
  const mutationHeaders = { 'x-csrf-token': csrf, origin: new URL(page.url()).origin };
  const created = await page.request.post('/api/conversations', { headers: mutationHeaders, data: { title: 'รายงานทีมภาคตะวันออก' } });
  expect(created.status()).toBe(201);
  const row = (await created.json()).conversation as ConversationView;
  const patches: { expectedVersion: number; mutation: { type: string; title?: string } }[] = [];
  let abortNextMutation = false;
  await page.route('**/api/conversations/*', async route => {
    if (route.request().method() === 'PATCH') {
      patches.push(route.request().postDataJSON());
      if (abortNextMutation) { abortNextMutation = false; return route.abort(); }
    }
    return route.continue();
  });
  await page.reload();
  const item = page.locator(`[data-conversation-id="${row.id}"]`);
  const manage = () => item.locator('summary');
  await expect(item).toBeVisible(); // Includes persisted conversations with no messages.
  await manage().click();
  await item.getByRole('button', { name: 'เปลี่ยนชื่อ', exact: true }).click();
  await item.getByLabel('ชื่อบทสนทนา').fill('สรุปยอดขายประจำเดือน');
  await item.getByRole('button', { name: 'บันทึกชื่อ', exact: true }).click();
  await expect(item.getByRole('button', { name: /สรุปยอดขายประจำเดือน/ })).toBeVisible();
  expect(patches[0]).toEqual({ expectedVersion: row.rowVersion, mutation: { type: 'rename', title: 'สรุปยอดขายประจำเดือน' } });
  await item.getByRole('button', { name: 'ปักหมุด', exact: true }).click();
  await expect(page.getByRole('region', { name: 'ปักหมุด', exact: true }).locator(`[data-conversation-id="${row.id}"]`)).toBeVisible();
  await page.reload();
  await expect(page.getByRole('region', { name: 'ปักหมุด', exact: true })).toContainText('สรุปยอดขายประจำเดือน');
  await manage().click();
  await item.getByRole('button', { name: 'เก็บเข้าคลัง', exact: true }).click();
  await expect(page.getByRole('region', { name: 'เก็บเข้าคลังแล้ว', includeHidden: true }).locator(`[data-conversation-id="${row.id}"]`)).toHaveCount(1);
  await page.reload();
  await page.getByText('คลังบทสนทนา · 1', { exact: true }).click();
  await expect(page.getByRole('region', { name: 'เก็บเข้าคลังแล้ว', exact: true })).toContainText('สรุปยอดขายประจำเดือน');
  await manage().click();
  await item.getByRole('button', { name: 'นำกลับมาใช้งาน', exact: true }).click();
  await expect(page.getByRole('region', { name: 'ปักหมุด', exact: true })).toContainText('สรุปยอดขายประจำเดือน');
  await page.reload();
  await expect(item).toBeVisible();
  const current = (await (await page.request.get(`/api/conversations/${row.id}`)).json()).conversation as ConversationView;
  const external = await page.request.patch(`/api/conversations/${row.id}`, { headers: mutationHeaders, data: { expectedVersion: current.rowVersion, mutation: { type: 'rename', title: 'ชื่อที่แก้จากหน้าต่างอื่น' } } });
  expect(external.status()).toBe(200);
  await manage().click();
  await item.getByRole('button', { name: 'เปลี่ยนชื่อ', exact: true }).click();
  await item.getByLabel('ชื่อบทสนทนา').fill('ชื่อที่ผู้ใช้กำลังแก้');
  await item.getByRole('button', { name: 'บันทึกชื่อ', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'บทสนทนา', exact: true }).getByRole('alert')).toContainText('เปลี่ยนจากอีกหน้าต่าง');
  expect(patches.at(-1)?.expectedVersion).toBe(current.rowVersion);
  await expect(item).toContainText('ชื่อที่แก้จากหน้าต่างอื่น');
  await expect(item.getByLabel('ชื่อบทสนทนา')).toHaveValue('ชื่อที่ผู้ใช้กำลังแก้');
  await item.getByRole('button', { name: 'บันทึกชื่อ', exact: true }).click();
  await expect(item.getByRole('button', { name: /ชื่อที่ผู้ใช้กำลังแก้/ })).toBeVisible();
  expect(patches.at(-1)?.expectedVersion).toBe(current.rowVersion + 1);
  await page.reload();
  await expect(item).toContainText('ชื่อที่ผู้ใช้กำลังแก้');
  await manage().click();
  abortNextMutation = true;
  const patchCount = patches.length;
  await item.getByRole('button', { name: 'เลิกปักหมุด', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'บทสนทนา', exact: true }).getByRole('alert')).toContainText('โหลดสถานะล่าสุดแล้ว');
  await expect(item.getByRole('button', { name: 'เลิกปักหมุด', exact: true })).toBeEnabled();
  expect(patches).toHaveLength(patchCount + 1); // Readback, never an automatic PATCH retry.
  for (const width of [390, 768, 941, 1440, 1920]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    if (width === 390) await page.getByRole('button', { name: 'เปิดบทสนทนา', exact: true }).click();
    await expect(item).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath(`conversation-sidebar-${width}.png`) });
    if (width === 390) await page.getByRole('button', { name: 'ปิดบทสนทนา', exact: true }).click();
  }
});

test('completed analysis opens at its conclusion and source drawer leads with coverage', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.getByRole('switch').click();
  await expect(page.getByRole('switch')).not.toBeChecked();
  const dismiss = page.getByRole('button', { name: 'ปิดข้อความ', exact: true });
  if (await dismiss.count()) await dismiss.click();
  await page.getByRole('button', { name: 'บทสนทนาใหม่', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'วันนี้มีเรื่องไหนให้ช่วย?', exact: true })).toBeVisible();
  // Demo answers are bound by showcase card id, so the card (not typed or catalog text) sends the turn.
  await page.locator('[data-showcase-id="executive-overview"]').getByRole('button').click();
  const answer = page.locator('[data-message-role="assistant"][data-delivery="complete"]').last();
  await expect(answer).toBeVisible();
  const metricsTop = await answer.locator('dl').first().evaluate(element => element.getBoundingClientRect().top);
  const narrative = answer.locator('[data-answer-lead]');
  await expect(narrative).toBeInViewport({ ratio: 0.75 });
  const narrativeTop = await narrative.evaluate(element => element.getBoundingClientRect().top);
  expect(narrativeTop).toBeLessThan(metricsTop); // The actual conclusion precedes the numeric summary.
  await page.screenshot({ path: testInfo.outputPath('answer-conclusion-desktop.png') });
  await page.getByRole('button', { name: 'รายละเอียดแหล่งข้อมูล', exact: true }).click();
  const panel = page.getByRole('complementary', { name: /คำตอบที่เลือก/ });
  await expect(panel.getByRole('heading', { name: 'ความครอบคลุมของแหล่งข้อมูล', exact: true })).toBeInViewport();
  await expect(panel.locator('details').filter({ has: page.locator('[data-detail-claim]') }).first()).not.toHaveAttribute('open');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'ความครอบคลุมของแหล่งข้อมูล', exact: true })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('source-coverage-mobile.png') });
});

test('search disables old conversation results before debounce and until matching results arrive', async ({ page }) => {
  await login(page);
  const rows = [
    { id: 'search-old', title: 'สรุปยอดขายเดิม', rowVersion: 1, pinned: false, archived: false },
    { id: 'search-new', title: 'งานฝ่ายบุคคล', rowVersion: 1, pinned: false, archived: false },
  ];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let searchStarted = false;
  await page.route('**/api/conversations?*', async route => {
    const query = new URL(route.request().url()).searchParams.get('q');
    if (query) { searchStarted = true; await held; }
    const selected = query ? rows.slice(1) : rows;
    await route.fulfill({ json: { conversations: selected, pagination: { limit: 25, total: selected.length, hasMore: false } } });
  });
  await page.reload();
  const oldButton = page.locator('[data-conversation-id="search-old"]').getByRole('button', { name: 'สรุปยอดขายเดิม', exact: true });
  await expect(oldButton).toBeEnabled();
  const clockStart = Date.now();
  await page.clock.install({ time: clockStart });
  await page.clock.pauseAt(clockStart + 1);
  await page.getByRole('searchbox', { name: 'ค้นหาบทสนทนา' }).fill('ฝ่ายบุคคล');
  expect(searchStarted).toBe(false);
  expect(await oldButton.isEnabled()).toBe(false); // Before the 250ms timer runs.
  await page.clock.runFor(250);
  await expect.poll(() => searchStarted).toBe(true);
  await expect(oldButton).toBeDisabled();
  release();
  await expect(oldButton).toHaveCount(0);
  await expect(page.locator('[data-conversation-id="search-new"]').getByRole('button', { name: 'งานฝ่ายบุคคล', exact: true })).toBeEnabled();
});

test('composer sends to the selected conversation after a full reload', async ({ page }) => {
  const csrf = await login(page);
  const created = await page.request.post('/api/conversations', {
    headers: { 'x-csrf-token': csrf, origin: new URL(page.url()).origin },
    data: { title: 'บทสนทนาทดสอบหลังโหลดใหม่' },
  });
  expect(created.status()).toBe(201);
  const conversationId = (await created.json()).conversation.id as string;
  await page.reload();
  const row = page.locator(`[data-conversation-id="${conversationId}"]`);
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'บทสนทนาทดสอบหลังโหลดใหม่', exact: true }).click();
  await page.reload();
  await expect(row.getByRole('button', { name: 'บทสนทนาทดสอบหลังโหลดใหม่', exact: true })).toHaveAttribute('aria-current', 'page');

  let requestBody: { conversationId?: string } | undefined;
  await page.route('**/api/chat/stream', async route => {
    requestBody = route.request().postDataJSON() as { conversationId?: string };
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Test request stopped before admission', code: 'provider_unavailable' } }) });
  });
  const composer = page.getByLabel('ข้อความถึง DaTex', { exact: true });
  await composer.fill('Continue in the selected conversation.');
  await composer.press('Enter');
  await expect.poll(() => requestBody?.conversationId).toBe(conversationId);
});
