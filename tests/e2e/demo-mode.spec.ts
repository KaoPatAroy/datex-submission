import { expect, test, type Page } from '@playwright/test';
import { encodeChatStreamEvent, type ChatStreamEvent } from '../../lib/chat-stream-contracts';
import { showcase } from '../../lib/demo/showcase';

// Uses playwright.config.ts's isolated SQLite database, one worker, private port and cleanup reporter.
test.setTimeout(90_000);
async function signIn(page: Page, health = 'ok') {
  await page.route('**/api/ai/health', route => route.fulfill({ json: { status: health, reason: health, checkedAt: new Date().toISOString() } }));
  await page.request.get('/api/session', { timeout: 60_000 });
  await page.goto('/');
  await page.getByLabel('โปรไฟล์').selectOption('executive');
  await page.getByLabel('รหัสเข้าใช้งาน', { exact: true }).fill('nexus-test-access');
  await page.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true }).click();
  await expect(page.getByRole('switch')).toBeVisible();
}

for (const width of [1440, 390]) {
  test(`Demo guide, two grounded showcases, unsupported chips and once-per-session entry at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await signIn(page);
    await page.getByRole('switch').click();
    const guide = page.locator('[data-demo-guide]');
    await expect(guide.getByRole('heading', { name: 'โหมดสาธิต: สิ่งที่ระบบทำได้' })).toBeVisible();
    const executiveCards = showcase.filter(entry => entry.role === 'executive');
    await expect(guide.locator('article[data-showcase-id]')).toHaveCount(executiveCards.length);
    await expect(guide.locator('ul')).toContainText('ข้อมูลตัวอย่างที่เตรียมไว้');
    await expect(guide.locator('ul')).toContainText('คำถามอิสระต้องใช้ Live AI');
    await expect(guide.locator('ul')).toContainText('รายการที่เปลี่ยนข้อมูล: ตรวจรายละเอียด → ยืนยัน → ตรวจผลการดำเนินการ');
    const kindLabel = { answer: 'ตอบ', action: 'เตรียมงาน', denial: 'ปฏิเสธ', scenario: 'สถานการณ์' };
    for (const showcaseItem of showcase.filter(entry => entry.role === 'executive')) {
      await expect(guide.locator(`article[data-showcase-id="${showcaseItem.id}"]`)).toContainText(kindLabel[showcaseItem.kind]);
    }
    const item = showcase.find(entry => entry.id === 'executive-e01')!;
    const tryShowcase = guide.getByRole('button', { name: `ลองเลย: ${item.title}`, exact: true });
    await expect(tryShowcase).toBeEnabled();
    const first = page.waitForResponse(response => response.url().endsWith('/api/chat/stream') && response.request().method() === 'POST');
    if (width === 1440) {
      // The guide moves focus to its heading once on mount; wait for that deterministic signal so it cannot
      // steal focus after we focus the card, then confirm focus landed before pressing Enter.
      await expect(guide.getByRole('heading', { name: 'โหมดสาธิต: สิ่งที่ระบบทำได้' })).toBeFocused();
      await tryShowcase.focus();
      await expect(tryShowcase).toBeFocused();
      await page.keyboard.press('Enter');
    } else {
      await tryShowcase.click();
    }
    expect((await first).status()).toBe(200);
    await expect(page.locator('[data-message-role="assistant"]').last()).toHaveAttribute('data-delivery', 'complete');
    const showcaseAnswerElement = page.locator('[data-message-role="assistant"]').last();
    await expect(showcaseAnswerElement).toContainText('5,531.25');
    const persistedText = await page.evaluate(async messageId => {
      const response = await fetch('/api/workspace');
      const workspace = await response.json();
      return workspace.messages.find((message: { id: string }) => message.id === messageId)?.text;
    }, await showcaseAnswerElement.getAttribute('data-message-id'));
    if (typeof persistedText !== 'string') throw new Error('Showcase answer was not persisted in the workspace.');
    const displayedText = await showcaseAnswerElement.evaluate(element => Array.from(element.querySelectorAll('[data-answer-lead], [data-answer-continuation]')).map(node => node.textContent ?? '').join('\n\n'));
    expect(displayedText).toBe(persistedText);
    await expect(page.getByLabel('ข้อความถึง DaTex')).toBeFocused();
    await expect(guide).toHaveCount(0);
    await page.getByRole('button', { name: 'คู่มือโหมดสาธิต', exact: true }).click();
    const composer = page.getByLabel('ข้อความถึง DaTex');
    await composer.fill('Draft to preserve');
    const second = page.waitForRequest(request => request.url().endsWith('/api/chat/stream'));
    await guide.locator('article[data-showcase-id="executive-overview"]').getByRole('button').click();
    expect((await second).postDataJSON()).toMatchObject({ message: showcase.find(entry => entry.id === 'executive-overview')!.prompt, demoShowcaseId: 'executive-overview' });
    await expect(composer).toHaveValue('Draft to preserve');
    await expect(page.locator('[data-message-role="assistant"]').last()).toHaveAttribute('data-delivery', 'complete');
    await composer.fill('แต่งกลอนเกี่ยวกับดวงจันทร์');
    const freeText = page.waitForRequest(request => request.url().endsWith('/api/chat/stream'));
    await composer.press('Enter');
    expect((await freeText).postDataJSON()).not.toHaveProperty('demoShowcaseId');
    const answer = page.locator('[data-message-role="assistant"]').last();
    await expect(answer).toContainText('นี่คือโหมดสาธิต');
    const chips = answer.getByLabel('คำถามในชุดสาธิต');
    await expect(chips.getByRole('button')).toHaveCount(executiveCards.length);
    const chipRequest = page.waitForRequest(request => request.url().endsWith('/api/chat/stream'));
    await chips.getByRole('button', { name: item.title, exact: true }).click();
    expect((await chipRequest).postDataJSON()).toMatchObject({ message: item.prompt, demoShowcaseId: item.id });
    await expect(page.locator('[data-message-role="assistant"]').last()).toHaveAttribute('data-delivery', 'complete');
    await expect(page.locator('[data-message-role="assistant"]').last()).toContainText('5,531.25');
    await page.reload();
    await expect(page.getByRole('switch')).not.toBeChecked();
    await expect(guide).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test('not_configured health asks proactively after sign-in; switching is explicit', async ({ page }) => {
  await signIn(page, 'not_configured');
  const banner = page.getByRole('status', { name: 'Live AI ไม่พร้อมใช้งาน', exact: true });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('Live AI ยังไม่ได้เปิดใช้งานในระบบนี้');
  await expect(banner).not.toContainText('Live AI ยังตอบไม่ได้ในขณะนี้');
  await expect(page.getByRole('switch')).toBeChecked();
  await page.getByRole('button', { name: 'ปิดไปก่อน', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Live AI ไม่พร้อมใช้งาน', exact: true })).toHaveCount(0);
  await expect(page.getByRole('switch')).toBeChecked();
});

test('provider failure → banner → explicit Demo switch → guide; failed request is never resent', async ({ page }) => {
  await signIn(page);
  let chatRequests = 0;
  await page.route('**/api/chat/stream', async route => {
    chatRequests += 1;
    const request = route.request().postDataJSON() as { requestKey: string };
    const events: ChatStreamEvent[] = [
      { streamVersion: 1, sequence: 1, type: 'turn.started', requestKey: request.requestKey, conversationId: 'demo-failure-conversation', turnId: 'demo-failure-turn', assistantMessageId: 'demo-failure-answer', mode: 'live_ai', replayed: false },
      { streamVersion: 1, sequence: 2, type: 'turn.failed', code: 'provider_unavailable', outcome: 'unknown', recovery: 'check_original_request' },
    ];
    await route.fulfill({ contentType: 'text/event-stream', body: events.map(encodeChatStreamEvent).join('') });
  });
  await page.route('**/api/chat/recovery', route => route.fulfill({ json: { status: 'failed', conversationId: 'demo-failure-conversation', turnId: 'demo-failure-turn' } }));
  const composer = page.getByLabel('ข้อความถึง DaTex');
  await composer.fill('คำถามอิสระที่ผู้ให้บริการตอบไม่ได้');
  await composer.press('Enter');
  await expect(page.getByRole('status', { name: 'Live AI ไม่พร้อมใช้งาน', exact: true })).toBeVisible();
  await expect(page.getByRole('switch')).toBeChecked();
  const switchToDemo = page.getByRole('button', { name: 'สลับเป็นโหมดสาธิต', exact: true });
  // A provider outage before anything was prepared is a known failure: no recovery ritual, switch is ready now.
  await expect(switchToDemo).toBeEnabled();
  await expect(page.getByText('ตรวจสถานะคำขอเดิม', { exact: false })).toHaveCount(0);
  await expect(composer).toBeEnabled();
  await switchToDemo.click();
  await expect(page.getByRole('switch')).not.toBeChecked();
  await expect(page.locator('[data-demo-guide]')).toBeVisible();
  await expect(page.locator('[data-demo-guide] [data-showcase-id]').getByRole('button').first()).toBeEnabled();
  await expect(composer).toBeEnabled();
  await expect(page.getByText('รายการที่รอยืนยันจากโหมดเดิมจะยืนยันต่อไม่ได้', { exact: false })).toBeVisible();
  // The mode change starts a new conversation: the failed Live turn is not carried into the demo.
  await expect(page.locator('[data-message-role]')).toHaveCount(0);
  expect(chatRequests).toBe(1);
});
