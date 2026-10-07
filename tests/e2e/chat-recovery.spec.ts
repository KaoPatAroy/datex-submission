import { expect, test, type Page } from '@playwright/test';
import type { ConversationMessage, Workspace } from '../../lib/contracts';

test.setTimeout(90_000);
const conversationId = 'verified-failed-conversation';
const failedMessage = 'คำถามเดิมที่สิ้นสุดแล้ว';
const nextMessage = 'คำถามถัดไปในบทสนทนาเดิม';
const priorQuestion = 'ประวัติคำถามก่อนเกิดปัญหา';
const priorAnswer = 'คำตอบก่อนหน้าในบทสนทนาเดิม';
type Request = { requestKey: string; message: string; conversationId?: string };

async function prepare(page: Page, recoveryStatus: 'failed' | 'unavailable' = 'failed') {
  await page.goto('/');
  await page.getByLabel('รหัสเข้าใช้งาน').fill('nexus-test-access');
  await page.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true }).click();
  await expect(page.getByRole('switch')).toBeVisible();
  const baseline = await page.evaluate(async () => await fetch('/api/workspace').then(response => response.json()) as Workspace);
  const now = Date.now();
  const common = { actorId: baseline.actor.id, sessionId: baseline.actor.sessionId, conversationId, mode: baseline.actor.mode, modeRevision: baseline.actor.modeRevision };
  const messages: ConversationMessage[] = [
    { ...common, id: 'prior-user', turnId: 'prior-turn', role: 'user', text: priorQuestion, createdAt: new Date(now - 60_000).toISOString() },
    { ...common, id: 'prior-assistant', turnId: 'prior-turn', role: 'assistant', text: priorAnswer, createdAt: new Date(now - 59_000).toISOString() },
    { ...common, id: 'other-user', conversationId: 'unrelated-conversation', role: 'user', text: 'บทสนทนาอื่นที่ห้ามเลือกแทน', createdAt: new Date(now - 120_000).toISOString() },
  ];
  const requests: Request[] = [];
  const recoveries: Request[] = [];
  let forbiddenWrites = 0;
  await page.route('**/api/workspace', route => route.fulfill({ json: { ...baseline, messages, actions: [], receipts: [], dashboards: [], inbox: [], audit: [] } }));
  await page.route(/\/api\/actions\/|\/api\/chat$/, route => { forbiddenWrites += 1; return route.abort(); });
  const stream = (events: Record<string, unknown>[]) => events.map((event, index) => {
    const payload = { streamVersion: 1, sequence: index + 1, ...event };
    return `event: ${event.type}\ndata: ${JSON.stringify(payload)}\n\n`;
  }).join('');
  await page.route('**/api/chat/stream', async route => {
    const request = route.request().postDataJSON() as Request;
    requests.push(request);
    const failed = requests.length === 1;
    const turnId = failed ? 'failed-turn' : 'next-turn';
    const assistantMessageId = failed ? 'failed-assistant' : 'next-assistant';
    const started = { type: 'turn.started', requestKey: request.requestKey, conversationId, turnId, assistantMessageId, mode: baseline.actor.mode, replayed: false };
    messages.push({ ...common, id: turnId, turnId, role: 'user', text: request.message, createdAt: new Date(now + requests.length * 1000).toISOString() });
    if (failed) {
      // A different conversation is newer at reload; continuation must not infer "latest".
      messages.find(message => message.id === 'other-user')!.createdAt = new Date(now + 60_000).toISOString();
      await route.fulfill({ contentType: 'text/event-stream', body: stream([started, { type: 'text.delta', text: 'คำตอบที่ยังไม่สมบูรณ์' }, { type: 'turn.failed', code: 'outcome_unknown', outcome: 'unknown', recovery: 'check_original_request' }]) });
    } else {
      const response = { conversationId, turnId, assistantMessageId, mode: baseline.actor.mode, message: 'รับคำถามถัดไปในบทสนทนาเดิมแล้ว' };
      messages.push({ ...common, id: assistantMessageId, turnId, role: 'assistant', text: response.message, createdAt: new Date(now + requests.length * 1000 + 1).toISOString() });
      await route.fulfill({ contentType: 'text/event-stream', body: stream([started, { type: 'turn.completed', response }]) });
    }
  });
  await page.route('**/api/chat/recovery', async route => {
    const request = route.request().postDataJSON() as Request;
    recoveries.push(request);
    expect(request.requestKey).toBe(requests[0].requestKey);
    expect(request.message).toBe(failedMessage);
    expect(request.conversationId).toBe(conversationId);
    await route.fulfill({ json: recoveryStatus === 'failed' ? { status: 'failed', conversationId, turnId: 'failed-turn' } : { status: 'unavailable' } });
  });
  await page.reload();
  await expect(page.locator('[data-message-role="assistant"]').filter({ hasText: priorAnswer })).toBeVisible();
  return { requests, recoveries, messages, get forbiddenWrites() { return forbiddenWrites; } };
}

for (const width of [390, 941, 1440]) {
  test(`verified failed turn continues its exact conversation through reload at ${width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await prepare(page);
    const composer = page.getByLabel('ข้อความถึง DaTex');
    await composer.fill(failedMessage); await composer.press('Enter');
    await expect(composer).toBeDisabled();
    await expect(page.getByRole('button', { name: 'ถามต่อในบทสนทนาเดิม', exact: true })).toHaveCount(0);
    expect(fixture.requests).toHaveLength(1); expect(fixture.recoveries).toHaveLength(0);
    await page.getByRole('button', { name: 'ตรวจสถานะคำขอเดิม', exact: true }).click();
    const resume = page.getByRole('button', { name: 'ถามต่อในบทสนทนาเดิม', exact: true });
    await expect(resume).toBeVisible();
    await resume.focus();
    await expect(resume).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath(`verified-failure-${width}.png`) });
    await page.keyboard.press('Enter');
    await expect(composer).toBeEnabled();
    await expect(composer).toBeFocused();
    await expect(page.locator('[data-message-role="assistant"]').filter({ hasText: priorAnswer })).toBeVisible();
    await expect(page.locator('[data-message-role="user"]').filter({ hasText: failedMessage })).toHaveCount(1);
    await page.reload();
    await expect(composer).toBeEnabled();
    await expect(page.locator('[data-message-role="assistant"]').filter({ hasText: priorAnswer })).toBeVisible();
    await expect(page.locator('[data-message-role="user"]').filter({ hasText: failedMessage })).toHaveCount(1);
    await composer.fill(failedMessage);
    await expect(page.getByRole('button', { name: 'ส่ง', exact: true })).toBeDisabled();
    await composer.press('Enter');
    expect(fixture.requests).toHaveLength(1); expect(fixture.recoveries).toHaveLength(1);
    await composer.fill(nextMessage); await composer.press('Enter');
    await expect(page.locator('[data-message-role="assistant"]').filter({ hasText: 'รับคำถามถัดไปในบทสนทนาเดิมแล้ว' })).toBeVisible();
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.requests.map(request => request.conversationId)).toEqual([conversationId, conversationId]);
    expect(fixture.requests.map(request => request.message)).toEqual([failedMessage, nextMessage]);
    expect(fixture.requests[1].requestKey).not.toBe(fixture.requests[0].requestKey);
    await page.reload();
    await expect(page.locator('[data-message-role="assistant"]').filter({ hasText: priorAnswer })).toBeVisible();
    await expect(page.locator('[data-message-role="user"]').filter({ hasText: nextMessage })).toHaveCount(1);
    expect(fixture.requests).toHaveLength(2); expect(fixture.recoveries).toHaveLength(1); expect(fixture.forbiddenWrites).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.screenshot({ path: testInfo.outputPath(`continued-conversation-${width}.png`) });
  });
}

test('unavailable exact recovery remains locked across reload and never retries the write', async ({ page }) => {
  const fixture = await prepare(page, 'unavailable');
  const composer = page.getByLabel('ข้อความถึง DaTex');
  await composer.fill(failedMessage); await composer.press('Enter');
  await expect(composer).toBeDisabled();
  await page.getByRole('button', { name: 'ตรวจสถานะคำขอเดิม', exact: true }).click();
  await expect(page.getByText('ยังยืนยันผลคำขอเดิมไม่ได้ กรุณาตรวจสถานะอีกครั้ง ระบบจะไม่ส่งข้อความเดิมซ้ำ', { exact: true })).toBeVisible();
  await expect(composer).toBeDisabled();
  await expect(page.getByRole('button', { name: 'ถามต่อในบทสนทนาเดิม', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'เริ่มคำถามใหม่', exact: true })).toHaveCount(0);
  await page.reload();
  await expect.poll(() => fixture.recoveries.length).toBe(2);
  await expect(composer).toBeDisabled();
  await expect(page.getByRole('button', { name: 'ถามต่อในบทสนทนาเดิม', exact: true })).toHaveCount(0);
  expect(fixture.requests).toHaveLength(1); expect(fixture.forbiddenWrites).toBe(0);
});

for (const exactRecord of [true, false]) {
  test(`failed recovery without a canonical response ID ${exactRecord ? 'uses only the exact persisted turn' : 'truthfully starts a new conversation'}`, async ({ page }) => {
    const fixture = await prepare(page);
    const composer = page.getByLabel('ข้อความถึง DaTex');
    await composer.fill(failedMessage); await composer.press('Enter');
    await expect(composer).toBeDisabled();
    if (!exactRecord) fixture.messages.splice(fixture.messages.findIndex(message => message.id === 'failed-turn'), 1);
    // Model an admission whose IDs were not captured locally, followed by an unusable conversation ID.
    await page.evaluate(() => {
      const key = Object.keys(sessionStorage).find(key => key.startsWith('biztania:turn-recovery:'))!;
      const memory = JSON.parse(sessionStorage.getItem(key)!);
      delete memory.pending.conversationId;
      delete memory.pending.requestConversationId;
      sessionStorage.setItem(key, JSON.stringify(memory));
    });
    await page.route('**/api/chat/recovery', route => route.fulfill({ json: { status: 'failed', conversationId: 'local-conversation-unusable', turnId: 'failed-turn' } }));
    await page.reload();
    const resume = page.getByRole('button', { name: exactRecord ? 'ถามต่อในบทสนทนาเดิม' : 'เริ่มคำถามใหม่', exact: true });
    await expect(resume).toBeVisible(); await resume.click();
    if (!exactRecord) await expect(page.getByText('ไม่พบรหัสบทสนทนาเดิมที่ตรวจสอบได้ คำถามถัดไปจะเริ่มบทสนทนาใหม่ โดยไม่ส่งคำขอเดิมซ้ำ', { exact: true })).toBeVisible();
    await page.reload();
    await expect(composer).toBeEnabled();
    await composer.fill(nextMessage); await composer.press('Enter');
    await expect.poll(() => fixture.requests.length).toBe(2);
    expect(fixture.requests[1].conversationId).toBe(exactRecord ? conversationId : undefined);
    expect(fixture.requests.map(request => request.message)).toEqual([failedMessage, nextMessage]);
    expect(fixture.forbiddenWrites).toBe(0);
  });
}

test('a permission denial with nothing prepared is a known outcome: no recovery lock, composer and new chat stay usable', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('รหัสเข้าใช้งาน').fill('nexus-test-access');
  await page.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true }).click();
  await expect(page.getByRole('switch')).toBeVisible();
  let calls = 0;
  await page.route('**/api/chat/stream', async route => {
    calls += 1;
    const request = route.request().postDataJSON() as { requestKey: string };
    const events = [
      { type: 'turn.started', requestKey: request.requestKey, conversationId: 'denied-conversation', turnId: 'denied-turn', assistantMessageId: 'denied-assistant', mode: 'live_ai', replayed: false },
      { type: 'turn.failed', code: 'forbidden', outcome: 'failed', recovery: 'check_original_request' },
    ];
    await route.fulfill({ contentType: 'text/event-stream', body: events.map((event, index) => `event: ${event.type}\ndata: ${JSON.stringify({ streamVersion: 1, sequence: index + 1, ...event })}\n\n`).join('') });
  });
  const composer = page.getByLabel('ข้อความถึง DaTex');
  await composer.fill('ขอดูข้อมูลนอกสิทธิ์');
  await composer.press('Enter');
  await expect(page.getByText('คำขอนี้อยู่นอกสิทธิ์ของคุณ', { exact: false })).toBeVisible();
  await expect(page.getByText('ตรวจสถานะคำขอเดิม', { exact: false })).toHaveCount(0);
  await expect(composer).toBeEnabled();
  await expect(page.getByRole('switch')).toBeEnabled();
  expect(calls).toBe(1);
});
