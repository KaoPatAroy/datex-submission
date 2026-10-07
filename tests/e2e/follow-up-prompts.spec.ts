import { expect, test, type Page } from '@playwright/test';
import type { FollowUpSuggestions, Workspace } from '../../lib/contracts';

test.setTimeout(90_000);
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'wait' }); });

async function readWorkspace(page: Page): Promise<Workspace> {
  const response = await page.request.get('/api/workspace');
  expect(response.status()).toBe(200);
  return response.json();
}
async function login(page: Page, profile = 'executive') {
  await page.request.get('/api/session', { timeout: 60_000 });
  await page.goto('/');
  await page.getByLabel('โปรไฟล์', { exact: true }).selectOption(profile);
  await page.getByLabel('รหัสเข้าใช้งาน', { exact: true }).fill('nexus-test-access');
  await page.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true }).click();
  await expect(page.getByRole('switch')).toBeVisible();
  await page.getByRole('switch').click();
  await expect(page.getByRole('switch')).not.toBeChecked();
  const newConversation = page.getByRole('button', { name: 'บทสนทนาใหม่', exact: true });
  if (!await newConversation.isVisible()) await page.getByRole('button', { name: 'เปิดบทสนทนา', exact: true }).click();
  await newConversation.click();
}
function nextSuggestions(page: Page) {
  return page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname.endsWith('/suggestions'));
}
async function ask(page: Page, prompt?: string) {
  const response = nextSuggestions(page);
  if (prompt) await page.getByLabel('ข้อความถึง DaTex').fill(prompt);
  else {
    await page.getByRole('button', { name: 'ดูงานที่ทำได้', exact: true }).click();
    await page.locator('[data-consequence="analyze"], [data-consequence="read"]').first().click();
  }
  await page.getByRole('button', { name: 'ส่ง', exact: true }).click();
  const result = await response;
  expect(result.status()).toBe(200);
  const body = await result.json() as FollowUpSuggestions;
  await expect(page.locator(`[data-follow-up-anchor="${body.afterMessageId}"]`)).toHaveAttribute('data-follow-up-status', body.status === 'ready' && body.items.length ? 'ready' : 'none');
  return body;
}

for (const [profile, width] of [['executive', 1440], ['east', 390]] as const) {
  test(`real ${profile} answer suggestions stay on their exact anchor and only prefill at ${width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await login(page, profile);
    let posts = 0;
    page.on('request', request => { if (request.method() === 'POST') posts += 1; });
    const suggestions = await ask(page);
    expect(suggestions.status).toBe('ready');
    expect(suggestions.items.length).toBeGreaterThan(0);
    expect(suggestions.items.length).toBeLessThanOrEqual(3);
    const article = page.locator(`[data-message-id="${suggestions.afterMessageId}"]`);
    const region = article.getByRole('region', { name: 'ลองถามต่อ', exact: true });
    await expect(region).toBeVisible();
    await expect(region.getByRole('button')).toHaveCount(suggestions.items.length);
    const beforeClick = posts;
    const before = await readWorkspace(page);
    await region.getByRole('button').first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`follow-ups-${profile}-${width}.png`) });
    await region.getByRole('button').first().click();
    await expect(page.getByLabel('ข้อความถึง DaTex')).toHaveValue(suggestions.items[0].prompt);
    await expect(page.getByLabel('ข้อความถึง DaTex')).toBeFocused();
    expect(posts).toBe(beforeClick);
    expect((await readWorkspace(page)).messages).toHaveLength(before.messages.length);

    const reloaded = nextSuggestions(page);
    await page.reload();
    const replay = await (await reloaded).json() as FollowUpSuggestions;
    expect(replay.afterMessageId).toBe(suggestions.afterMessageId);
    await expect(page.locator(`[data-follow-up-anchor="${replay.afterMessageId}"]`)).toHaveAttribute('data-follow-up-status', 'ready');
    expect(posts).toBe(beforeClick);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);

    if (profile === 'executive') {
      // Typed text is never interpreted in Demo: the E01 showcase card (sent by id) changes the answer scope.
      const nextAnchor = nextSuggestions(page);
      await page.getByRole('button', { name: 'คู่มือโหมดสาธิต', exact: true }).click();
      await page.locator('button[data-showcase-id="executive-e01"]').first().click();
      const changed = await (await nextAnchor).json() as FollowUpSuggestions;
      await expect(page.locator(`[data-follow-up-anchor="${changed.afterMessageId}"]`)).toHaveAttribute('data-follow-up-status', 'ready');
      expect(changed.afterMessageId).not.toBe(suggestions.afterMessageId);
      await expect(article.locator('[data-follow-up-anchor]')).toHaveCount(0);
      const after = await readWorkspace(page);
      const answer = after.messages.find(message => message.id === changed.afterMessageId);
      expect(answer?.evidence?.scope.branchIds).toEqual(['E01']);
      expect(changed.status).toBe('ready');
      const scopedIds = answer?.evidence?.branches.map(branch => branch.branchId) ?? [];
      expect(scopedIds).toEqual(['E01']);
      expect(changed.items.every(item => scopedIds.every(id => item.prompt.includes(id)))).toBe(true);
      await page.getByRole('button', { name: 'ออกจากระบบ', exact: true }).click();
      await login(page, 'hr');
      await expect(page.getByRole('region', { name: 'ลองถามต่อ', exact: true })).toHaveCount(0);
      const noTarget = await ask(page);
      expect(noTarget.status).toBe('none');
      expect(noTarget.items).toEqual([]);
      await expect(page.getByRole('region', { name: 'ลองถามต่อ', exact: true })).toHaveCount(0);
      await expect(page.getByLabel('ข้อความถึง DaTex')).toBeEnabled();
    }
  });
}

test('busy and recovery states remove old follow-ups without sending a suggestion automatically', async ({ page }) => {
  await login(page);
  const suggestions = await ask(page);
  expect(suggestions.status).toBe('ready');
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let requested = false;
  await page.route('**/api/chat/stream', async route => {
    requested = true;
    await held;
    await route.fulfill({ status: 503, json: { error: { message: 'ไม่พร้อมใช้งานในการทดสอบ' } } });
  });
  try {
    await page.getByRole('region', { name: 'ลองถามต่อ', exact: true }).getByRole('button').first().click();
    expect(requested).toBe(false);
    await page.getByRole('button', { name: 'ส่ง', exact: true }).click();
    await expect.poll(() => requested).toBe(true);
    await expect(page.locator('[data-follow-up-anchor]')).toHaveCount(0);
    release();
    await expect(page.getByLabel('ข้อความถึง DaTex')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'ตรวจสถานะคำขอเดิม', exact: true })).toBeVisible();
    await expect(page.locator('[data-follow-up-anchor]')).toHaveCount(0);
  } finally { release(); }
});

test('unavailable mismatched and over-budget suggestion responses never become selectable', async ({ page }) => {
  await login(page);
  const original = await ask(page);
  expect(original.status).toBe('ready');
  let response: FollowUpSuggestions = original;
  await page.route(/\/api\/conversations\/[^/]+\/suggestions\?/, route => route.fulfill({ json: response }));
  const cases: FollowUpSuggestions[] = [
    { ...original, status: 'none', items: [] },
    { ...original, status: 'data_unavailable', items: [] },
    { ...original, afterMessageId: 'a-different-answer' },
    { ...original, conversationId: 'a-different-conversation' },
    { ...original, items: Array.from({ length: 4 }, (_, index) => ({ ...original.items[0], id: `excess-${index}` })) },
  ];
  for (const value of cases) {
    response = value;
    await page.reload();
    await expect(page.locator(`[data-follow-up-anchor="${original.afterMessageId}"]`)).toHaveAttribute('data-follow-up-status', 'none');
    await expect(page.getByRole('region', { name: 'ลองถามต่อ', exact: true })).toHaveCount(0);
  }
});
