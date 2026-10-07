import { expect, test } from '@playwright/test';
import type { ConversationMessage, Evidence, TurnResponse, Workspace } from '../../lib/contracts';
import { encodeChatStreamEvent, type ChatStreamEvent } from '../../lib/chat-stream-contracts';

test.setTimeout(60_000);
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'wait' }); });

for (const width of [1440, 390]) {
  test(`actual conclusion stays visible with long prose and warnings at ${width} without stealing reading position`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.request.get('/api/session', { timeout: 60_000 });
    await page.goto('/');
    await page.getByLabel('รหัสเข้าใช้งาน', { exact: true }).fill('nexus-test-access');
    await page.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true }).click();
    await expect(page.getByRole('switch')).toBeVisible();
    const baseline = await (await page.request.get('/api/workspace')).json() as Workspace;
    const messages: ConversationMessage[] = [];
    const conclusion = 'ข้อมูลยังไม่ครบ จึงยังสรุปสาเหตุยอดขายที่ลดลงไม่ได้';
    const continuation = Array.from({ length: 24 }, (_, index) => `ประเด็นที่ต้องตรวจ ${index + 1}: ตรวจวันของข้อมูล ขอบเขตสาขา และหลักฐานต้นทางก่อนใช้ตัดสินใจ`).join('\n\n');
    const evidence: Evidence = {
      scope: { region: 'east', date: baseline.businessDate }, asOf: new Date().toISOString(), version: 'long-warning-evidence',
      branches: [], totals: { netSales: 0, target: 0, gap: 0, achievement: null }, sources: [],
      warnings: Array.from({ length: 12 }, (_, index) => `ข้อจำกัด ${index + 1}: ยังขาดข้อมูลจากสาขาและยังยืนยันความครอบคลุมไม่ได้ โปรดตรวจสอบต้นทางก่อนสรุปหรือดำเนินการ`),
    };
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let turnNumber = 0;
    let secondRequestStarted = false;
    await page.route('**/api/workspace', route => route.fulfill({ json: { ...baseline, messages, actions: [], receipts: [], dashboards: [], inbox: [], audit: [] } }));
    await page.route('**/api/chat/stream', async route => {
      const request = route.request().postDataJSON() as { requestKey: string; message: string };
      const number = ++turnNumber;
      const turnId = `reading-turn-${number}`;
      const assistantMessageId = `reading-answer-${number}`;
      const response: TurnResponse = { conversationId: 'reading-conversation', turnId, assistantMessageId, mode: baseline.actor.mode, message: `${conclusion}\n\n${continuation}`, evidence };
      const common = { actorId: baseline.actor.id, sessionId: baseline.actor.sessionId, conversationId: response.conversationId, turnId, mode: baseline.actor.mode, modeRevision: baseline.actor.modeRevision, createdAt: new Date(Date.now() + number * 1000).toISOString() };
      if (number === 2) { secondRequestStarted = true; await held; }
      messages.push({ ...common, id: turnId, role: 'user', text: request.message }, { ...common, id: assistantMessageId, role: 'assistant', text: response.message, evidence });
      const events: ChatStreamEvent[] = [
        { streamVersion: 1, sequence: 1, type: 'turn.started', requestKey: request.requestKey, conversationId: response.conversationId, turnId, assistantMessageId, mode: baseline.actor.mode, replayed: false },
        { streamVersion: 1, sequence: 2, type: 'turn.completed', response },
      ];
      await route.fulfill({ contentType: 'text/event-stream', body: events.map(encodeChatStreamEvent).join('') });
    });
    try {
      await page.reload();
      const composer = page.getByLabel('ข้อความถึง DaTex');
      await composer.fill('ตรวจข้อสรุปจากข้อมูลที่ยังไม่ครบ');
      await page.getByRole('button', { name: 'ส่ง', exact: true }).click();
      const answer = page.locator('[data-message-role="assistant"][data-turn-id="reading-turn-1"][data-delivery="complete"]');
      const lead = answer.locator('[data-answer-lead]');
      await expect(lead).toHaveText(conclusion);
      await expect(lead).toBeInViewport({ ratio: 1 });
      const positions = await answer.evaluate(element => ({
        lead: element.querySelector('[data-answer-lead]')!.getBoundingClientRect().top,
        metrics: element.querySelector('dl')!.getBoundingClientRect().top,
        warnings: element.querySelector('[data-evidence-warnings]')!.getBoundingClientRect().top,
      }));
      expect(positions.lead).toBeLessThan(positions.metrics);
      expect(positions.lead).toBeLessThan(positions.warnings);
      await expect(answer.locator('[data-answer-continuation]')).toHaveText(continuation);
      await expect(answer.locator('[data-evidence-warnings] li')).toHaveCount(12);
      await page.screenshot({ path: testInfo.outputPath(`actual-conclusion-${width}.png`) });

      await composer.fill('ตรวจข้อมูลเพิ่มเติมโดยคงตำแหน่งที่กำลังอ่าน');
      await page.getByRole('button', { name: 'ส่ง', exact: true }).click();
      await expect.poll(() => secondRequestStarted).toBe(true);
      const scroller = page.locator('[class*="conversationScroll"]');
      await scroller.evaluate(element => { element.scrollTop = 0; });
      await expect(page.getByRole('button', { name: 'ไปข้อความล่าสุด', exact: true })).toBeVisible();
      release();
      const second = page.locator('[data-message-role="assistant"][data-turn-id="reading-turn-2"][data-delivery="complete"]');
      await expect(second).toBeAttached();
      await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(0);
      await expect(second.locator('[data-answer-lead]')).not.toBeInViewport();
    } finally { release(); }
  });
}
