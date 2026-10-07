import { expect, test, type Page } from '@playwright/test';
import type { ConversationMessage, Dashboard, Evidence, PendingAction, Workspace } from '../../lib/contracts';
import type { CatalogEntry, CatalogStatus } from '../../components/biztania/work-catalog';

test.setTimeout(90_000);
const viewports = [{ width: 1920, height: 953 }, { width: 1440, height: 900 }, { width: 941, height: 744 }, { width: 768, height: 1024 }, { width: 390, height: 844 }];
async function login(page: Page, profile = 'executive') {
  // Await the fresh synthetic store, rather than racing its initial seed during UI assertions.
  const ready = await page.request.get('/api/session', { timeout: 60_000 });
  expect(ready.status()).toBe(401);
  await page.goto('/');
  await page.getByLabel('โปรไฟล์', { exact: true }).selectOption(profile);
  await page.getByLabel('รหัสเข้าใช้งาน', { exact: true }).fill('nexus-test-access');
  await page.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true }).click();
  await expect(page.getByRole('switch')).toBeVisible();
  return page.evaluate(async () => await fetch('/api/workspace').then(response => response.json()) as Workspace);
}
function catalogFor(profile: string): CatalogEntry[] {
  if (profile === 'hr') return [
    { id: 'hr.find', section: 'ask_analyze', title: 'ค้นหาพนักงาน', description: 'อ่านข้อมูลพนักงานที่มีสิทธิ์เห็น', prompt: 'ค้นหาพนักงาน E024', consequence: 'read' },
    { id: 'hr.revoke', section: 'prepare_review', title: 'เพิกถอนบัตรพนักงาน', description: 'เตรียมข้อเสนอเพื่อตรวจสอบ', prompt: 'เตรียมเพิกถอนบัตร C102 ของ E024 เนื่องจากพ้นสภาพพนักงาน', consequence: 'review_required', actionKind: 'badge_revoke' },
  ];
  return [
    { id: 'sales.read', section: 'ask_analyze', title: profile === 'east' ? 'ยอดขายภาคตะวันออก' : 'ภาพรวมยอดขายทุกภูมิภาค', description: 'วิเคราะห์ข้อมูลในขอบเขตที่ได้รับอนุญาต', prompt: profile === 'east' ? 'วิเคราะห์ยอดขายภาคตะวันออก' : 'วิเคราะห์ยอดขายทุกภูมิภาค', consequence: 'analyze' },
    { id: 'dashboard.create', section: 'prepare_review', title: 'สร้าง Dashboard', description: 'เตรียมข้อเสนอสร้าง Dashboard ก่อนยืนยัน', prompt: 'ช่วยเตรียมข้อเสนอสร้าง Dashboard จากข้อมูลล่าสุด', consequence: 'review_required', actionKind: 'dashboard_create' },
  ];
}
async function fixture(page: Page, baseline: Workspace, update: Partial<Workspace> & { actionCatalog?: CatalogEntry[]; actionCatalogStatus?: CatalogStatus }, section = '') {
  const data = { ...baseline, actionCatalogStatus: Array.isArray(update.actionCatalog) ? 'ready' : undefined, messages: [], actions: [], receipts: [], audit: [], dashboards: [], inbox: [], ...update };
  await page.route('**/api/workspace', route => route.fulfill({ json: data }));
  const conversationIds = [...new Set(data.messages.map(message => message.conversationId))];
  await page.route('**/api/conversations?*', route => route.fulfill({ json: { conversations: conversationIds.map(id => ({ id, title: 'ภาพรวมยอดขาย', rowVersion: 1, pinned: false, archived: false, updatedAt: data.messages.find(message => message.conversationId === id)?.createdAt })), pagination: { limit: 25, total: conversationIds.length, hasMore: false } } }));
  await page.goto(section ? `/?section=${section}` : '/');
  await expect(page.getByRole('switch')).toBeVisible();
}

for (const profile of ['executive', 'east', 'hr']) {
  test(`server-supplied ${profile} catalog has distinct consequences and only prefills`, async ({ page }, testInfo) => {
    const baseline = await login(page, profile);
    const entries = catalogFor(profile);
    await fixture(page, baseline, { actionCatalog: entries });
    let submissions = 0;
    await page.route('**/api/chat/stream', route => { submissions += 1; return route.abort(); });
    await expect(page.getByText('เตรียมงานจากหลักฐาน', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'ถามและวิเคราะห์', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'สร้างและจัดการงาน', exact: true })).toBeVisible();
    for (const entry of entries) {
      const choice = page.locator(`[data-catalog-id="${entry.id}"]`);
      await expect(choice).toContainText(entry.actionKind === 'dashboard_create' ? 'เริ่มสร้าง Dashboard' : 'เติมคำถาม');
      await expect(choice).toHaveAttribute('data-consequence', entry.consequence);
      await choice.click();
      await expect(page.getByRole('textbox', { name: 'ข้อความถึง DaTex' })).toHaveValue(entry.prompt);
      await expect(page.getByRole('textbox', { name: 'ข้อความถึง DaTex' })).toBeFocused();
      expect(submissions).toBe(0);
    }
    const visible = await page.locator('main').innerText();
    expect(visible).not.toMatch(/sales\.query_metrics|dashboard\.prepare_create|hr\.find_employee|capability|API/);
    if (profile === 'hr') await expect(page.getByRole('button', { name: /สร้าง Dashboard/ })).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('button', { name: 'ไปข้อความล่าสุด', exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`${profile}-catalog-mobile.png`) });
    await page.getByRole('button', { name: 'ดูงานที่ทำได้', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'งานที่ทำได้', exact: true })).toBeVisible();
    await page.locator(`[data-catalog-id="${entries[0].id}"]`).click();
    await expect(page.getByRole('textbox', { name: 'ข้อความถึง DaTex' })).toHaveValue(entries[0].prompt);
    expect(submissions).toBe(0);
  });
}

test('navigation, role, mode, Back and blue rendering stay reachable at all requested widths', async ({ page }) => {
  await login(page);
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    const nav = page.getByRole('navigation', { name: 'เมนูหลัก' });
    for (const label of ['Dashboard', 'งานและการอนุมัติ', 'ประวัติการทำงาน', 'แชต']) {
      await nav.getByRole('button', { name: label, exact: true }).click();
      await expect(nav.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-current', 'page');
    }
    await expect(page.locator('[aria-label="สถานะพื้นที่ทำงาน"]')).toContainText('ผู้บริหาร');
    await expect(page.getByRole('switch')).toBeChecked();
    await expect(page.getByRole('button', { name: 'ออกจากระบบ', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())).toBe('#2855d9');
  }
  await page.setViewportSize({ width: 941, height: 744 });
  const nav = page.getByRole('navigation', { name: 'เมนูหลัก' });
  await nav.getByRole('button', { name: 'Dashboard', exact: true }).click();
  await nav.getByRole('button', { name: 'ประวัติการทำงาน', exact: true }).click();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Dashboard ของฉัน', exact: true })).toBeVisible();
  await nav.getByRole('button', { name: 'แชต', exact: true }).click();
  await page.getByRole('button', { name: 'บทสนทนาใหม่', exact: true }).click();
  await expect(nav).toBeVisible();
});

test('dashboard empty state has one proposal prefill and expired actions have no confirm button', async ({ page }, testInfo) => {
  const baseline = await login(page);
  const now = Date.now();
  const baseAction: PendingAction = { id: 'ui-action-expired', actorId: baseline.actor.id, sessionId: baseline.actor.sessionId, conversationId: 'ui-conversation', turnId: 'ui-turn', mode: baseline.actor.mode, modeRevision: baseline.actor.modeRevision, payload: { kind: 'dashboard_create', spec: { title: 'ภาพรวมยอดขาย', description: 'ข้อมูลสำหรับตรวจสอบ', scope: { region: 'east', date: baseline.businessDate }, widgets: [{ type: 'metric', title: 'ยอดขาย', metric: 'net_sales' }] } }, payloadHash: 'ui-hash', evidenceVersion: null, packs: [], createdAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now - 1_000).toISOString(), status: 'pending', preview: '' };
  const active = { ...baseAction, id: 'ui-action-current', expiresAt: new Date(now + 3_600_000).toISOString() };
  await fixture(page, baseline, { actionCatalog: catalogFor('executive'), actions: [baseAction, active], audit: [{ id: 'ui-read-1', actorId: baseline.actor.id, category: 'prepare', summary: 'dashboard.prepare_create', actionId: active.id, createdAt: baseAction.createdAt }, { id: 'ui-read-2', actorId: baseline.actor.id, category: 'prepare', summary: 'dashboard_create verified_success', actionId: active.id, createdAt: baseAction.createdAt }] }, 'dashboards');
  await expect(page.getByRole('button', { name: /^เริ่มสร้าง Dashboard/ })).toHaveCount(1);
  await page.getByRole('button', { name: 'เริ่มสร้าง Dashboard', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'ข้อความถึง DaTex' })).toHaveValue(catalogFor('executive')[1].prompt);
  await page.getByRole('navigation', { name: 'เมนูหลัก' }).getByRole('button', { name: 'งานและการอนุมัติ', exact: true }).click();
  const expired = page.locator('[data-action-id="ui-action-expired"]');
  // Expired proposals leave the approvals queue entirely: nothing to confirm (they stay readable in history).
  await expect(expired).toHaveCount(0);
  await expect(page.locator('[data-action-id="ui-action-current"]').getByRole('button', { name: 'ตรวจและยืนยัน', exact: true })).toBeEnabled();
  await page.getByRole('navigation', { name: 'เมนูหลัก' }).getByRole('button', { name: 'ประวัติการทำงาน', exact: true }).click();
  await expect(page.locator('[data-history-action="ui-action-current"]')).toHaveCount(1);
  expect(await page.locator('main').innerText()).not.toMatch(/dashboard\.prepare_create|verified_success|ui-action-current/);
  await page.getByRole('button', { name: 'หมดอายุ', exact: true }).click();
  await expect(page.locator('[data-history-action="ui-action-expired"]')).toBeVisible();
  await expect(page.locator('[data-history-action="ui-action-current"]')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('expired-history.png') });
  await page.getByRole('navigation', { name: 'เมนูหลัก' }).getByRole('button', { name: 'แชต', exact: true }).click();
  await page.route('**/api/chat/stream', route => route.fulfill({ status: 503, json: { error: { message: 'ยังอ่านผลไม่ได้' } } }));
  await page.getByRole('textbox', { name: 'ข้อความถึง DaTex' }).fill('ตรวจข้อมูลปัจจุบัน');
  await page.getByRole('button', { name: 'ส่ง', exact: true }).click();
  await expect(page.getByText('ตรวจสถานะคำขอเดิมก่อนส่งอีกครั้ง', { exact: true })).toBeVisible();
});

for (const viewport of viewports) {
  test(`details bind to chosen clarification at ${viewport.width} and restore mobile focus`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const baseline = await login(page);
    const common = { actorId: baseline.actor.id, sessionId: baseline.actor.sessionId, conversationId: 'ui-conversation', mode: baseline.actor.mode, modeRevision: baseline.actor.modeRevision, createdAt: new Date().toISOString() };
    const messages: (ConversationMessage & { clarification?: boolean })[] = [{ ...common, id: 'ui-user', role: 'user', text: 'ช่วยวิเคราะห์ภาพรวมยอดขายของทุกสาขาทั้งหมดในทุกภูมิภาคและระบุรายละเอียดพร้อมหลักฐานที่จำเป็นทั้งหมด' }, { ...common, id: 'ui-first', turnId: 'ui-first-turn', role: 'assistant', text: 'โปรดระบุวันที่ของข้อมูลที่ต้องการ', clarification: true }, { ...common, id: 'ui-second', turnId: 'ui-second-turn', role: 'assistant', text: 'คำตอบอีกเรื่องที่ไม่ใช่รายการที่เลือก', analysis: { facts: Array.from({ length: 5 }, (_, index) => ({ text: `ข้อเท็จจริงที่ ${index + 1}`, sourceIds: ['unrelated-source'] })), relationships: [], hypotheses: [], missingEvidence: [], evidenceVersion: 'ui-evidence', generatedAt: common.createdAt }, sources: [{ id: 'unrelated-source', system: 'hr', freshness: 'fresh', detail: 'ข้อมูลคนละคำตอบ', observedAt: common.createdAt, retrievedAt: common.createdAt }] }];
    await fixture(page, baseline, { messages, actionCatalog: catalogFor('executive') });
    const trigger = page.getByRole('article', { name: 'คำตอบจาก DaTex', exact: true }).filter({ hasText: 'โปรดระบุวันที่' }).getByRole('button', { name: 'ดูรายละเอียดคำตอบ', exact: true });
    await trigger.click();
    const detail = viewport.width < 768 ? page.getByRole('dialog') : page.getByRole('complementary', { name: /คำตอบที่เลือก|ขอข้อมูลเพิ่มเติม/ });
    await expect(detail).toBeVisible();
    await expect(detail).toContainText('ประเภทคำตอบ: ขอข้อมูลเพิ่มเติม');
    await expect(detail).not.toContainText('ข้อมูลคนละคำตอบ');
    await expect(detail).not.toContainText('รอหลักฐานจากคำตอบ');
    if (viewport.width >= 768) {
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.getByRole('textbox', { name: 'ข้อความถึง DaTex' }).fill('เขียนต่อได้ขณะดูรายละเอียด');
      await expect(detail).toBeVisible();
      const title = await page.locator('[class*="sessionRowTitle"]').first().innerText();
      expect(title.length).toBeLessThan(50);
    }
    await page.screenshot({ path: testInfo.outputPath(`selected-clarification-${viewport.width}.png`) });
    const latestTrigger = viewport.width >= 768 ? page.getByRole('article', { name: 'คำตอบจาก DaTex', exact: true }).filter({ hasText: 'คำตอบอีกเรื่อง' }).getByRole('button', { name: 'รายละเอียดแหล่งข้อมูล', exact: true }) : trigger;
    if (viewport.width >= 768) {
      await latestTrigger.click();
      await expect(detail.getByRole('heading', { level: 2 })).toContainText('คำตอบที่เลือก');
      await expect(detail).not.toContainText('ประเภทคำตอบ: ขอข้อมูลเพิ่มเติม');
      await expect(detail.locator('[data-detail-claim]')).toHaveCount(3);
      const facts = detail.locator('details').filter({ has: page.locator('[data-detail-claim]') }).first();
      await expect(facts).not.toHaveAttribute('open');
      await facts.locator('summary').click();
      await expect(facts).toHaveAttribute('open', '');
      await detail.getByRole('button', { name: 'ดูทั้งหมด 5 ข้อ', exact: true }).click();
      await expect(detail.locator('[data-detail-claim]')).toHaveCount(5);
      await expect(detail.getByRole('heading', { name: 'ความครอบคลุมของแหล่งข้อมูล' })).toBeVisible();
    }
    await detail.getByRole('button', { name: 'ปิดรายละเอียด', exact: true }).focus();
    await page.keyboard.press('Escape');
    await expect(detail).toHaveCount(0);
    await expect(latestTrigger).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  });
}


test('missing catalog is availability rather than permission denial and daily history uses Bangkok dates', async ({ page }) => {
  const baseline = await login(page);
  await fixture(page, baseline, { actionCatalog: undefined, audit: [{ id: 'late-utc-read', actorId: baseline.actor.id, category: 'read', summary: 'sales.query_metrics สำเร็จ', createdAt: '2026-10-04T18:30:00.000Z' }] }, 'dashboards');
  await expect(page.getByText('รายการงานยังไม่พร้อม กรุณาโหลดสถานะอีกครั้งเพื่อดูคำถามและข้อเสนอที่เลือกได้', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'โหลดรายการงานอีกครั้ง', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'เริ่มสร้าง Dashboard', exact: true })).toHaveCount(0);
  expect(await page.locator('main').innerText()).not.toContain('ไม่มีสิทธิ์');
  await page.getByRole('navigation', { name: 'เมนูหลัก' }).getByRole('button', { name: 'ประวัติการทำงาน', exact: true }).click();
  await expect(page.locator('[data-history-daily="2026-10-05"]')).toBeVisible();
  await expect(page.locator('[data-history-daily="2026-10-04"]')).toHaveCount(0);
});


test('dashboard detail hides version jargon and only offers supported Ticket prefills', async ({ page }, testInfo) => {
  const baseline = await login(page);
  const now = '2026-10-01T16:59:00.000Z';
  const source = { id: 'sales:E01:2026-10-01', system: 'sales', freshness: 'fresh' as const, detail: 'ยอดขายของสาขาในช่วงข้อมูลที่เลือก', observedAt: now, retrievedAt: now };
  const evidence: Evidence = { scope: { region: 'all', date: '2026-10-01' }, asOf: now, version: 'ui-evidence-version', branches: [], totals: { netSales: 100, target: 120, gap: -20, achievement: 83.3 }, sources: [source], warnings: [] };
  const dashboard: Dashboard = { id: 'ui-display-fixture', ownerId: baseline.actor.id, spec: { title: 'ภาพรวมยอดขายที่บันทึกไว้', description: 'ชุดข้อมูลสำหรับตรวจการแสดงผล', scope: evidence.scope, widgets: [{ type: 'metric', title: 'ยอดขายสุทธิ', metric: 'net_sales' }] }, packs: [], createdAt: now, updatedAt: now, lastRefreshAt: now, sourceMetadata: [source], analysis: null, evidenceVersion: evidence.version };
  await page.route('**/api/dashboards/ui-display-fixture', route => route.fulfill({ json: { dashboard, evidence, analysisStale: false } }));
  await page.goto('/dashboards/ui-display-fixture');
  await expect(page.getByRole('heading', { name: dashboard.spec.title, exact: true })).toBeVisible();
  await expect(page.locator('.scope-meta')).toContainText('ทุกภูมิภาค');
  await expect(page.locator('.source-main').first()).toContainText('ยอดขายจริง');
  expect(await page.locator('main').innerText()).not.toMatch(/API|capability|read · all/);
  expect(await page.locator('main').innerText()).not.toContain(evidence.version.slice(0, 8));
  await expect(page.locator('details.technical-detail')).toHaveCount(0);
  expect(await page.locator('main').innerText()).not.toContain(evidence.version);
  await expect(page.locator('.scope-meta')).toContainText('ข้อมูลวันที่ 1 ต.ค. 2569');
  for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.locator('[class*="contentPage"]').evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: testInfo.outputPath(`dashboard-labels-${size.width}.png`) });
  }
  const ticketPrompt = 'เตรียม Ticket ติดตามสาขาโดยตรวจหลักฐานก่อนเสนอให้ยืนยัน';
  const ticketEntry: CatalogEntry = { id: 'ticket.prepare', section: 'prepare_review', title: 'สร้าง Ticket ติดตามสาขา', description: 'เตรียมข้อเสนอให้ตรวจสอบก่อนยืนยัน', consequence: 'review_required', actionKind: 'ticket_create', prompt: ticketPrompt };
  await page.route('**/api/workspace', route => route.fulfill({ json: { ...baseline, actionCatalogStatus: 'ready', actionCatalog: [ticketEntry], dashboards: [dashboard] } }));
  let submissions = 0;
  await page.route('**/api/chat{,/stream}', route => { submissions += 1; return route.abort(); });
  for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size);
    await page.goto('/dashboards/ui-display-fixture');
    const ticket = page.getByRole('button', { name: 'เตรียม Ticket ติดตามสาขา', exact: true });
    await expect(ticket).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath(`dashboard-ticket-available-${size.width}.png`) });
    await ticket.click();
    await page.getByRole('button', { name: 'เติมคำขอในบทสนทนา', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'ข้อความถึง DaTex' })).toHaveValue(`${ticketPrompt} จาก Dashboard “${dashboard.spec.title}”`);
    await expect(page.getByRole('textbox', { name: 'ข้อความถึง DaTex' })).toBeFocused();
    expect(submissions).toBe(0);
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('biztania:dashboard-prefill:v1'))).toBeNull();
    await page.screenshot({ path: testInfo.outputPath(`dashboard-ticket-prefilled-${size.width}.png`) });
    await page.goBack();
    await expect(page.getByRole('heading', { name: dashboard.spec.title, exact: true })).toBeVisible();
    expect(submissions).toBe(0);
    await page.goForward();
    await expect(page.getByRole('textbox', { name: 'ข้อความถึง DaTex' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('textbox', { name: 'ข้อความถึง DaTex' })).toHaveValue('');
    expect(submissions).toBe(0);
  }
});


test('dashboard prefill handoff rejects account session stale and oversized data and consumes once', async ({ page }) => {
  const baseline = await login(page);
  const prompt = 'เตรียม Ticket ติดตามสาขาจากหลักฐานที่มีสิทธิ์อ่าน';
  const entry: CatalogEntry = { id: 'ticket-handoff', section: 'prepare_review', title: 'สร้าง Ticket ติดตามสาขา', description: 'ข้อเสนอให้ตรวจยืนยัน', consequence: 'review_required', actionKind: 'ticket_create', prompt };
  await fixture(page, baseline, { actionCatalog: [entry] });
  let submissions = 0;
  await page.route(/\/api\/chat(?:\/stream)?$/, route => { submissions += 1; return route.abort(); });
  const key = 'biztania:dashboard-prefill:v1';
  const marker = { actorId: baseline.actor.id, sessionId: baseline.actor.sessionId, dashboardId: 'ui-exact-dashboard', catalogId: entry.id, actionKind: 'ticket_create', prompt, createdAt: Date.now() };
  for (const invalid of [
    { ...marker, actorId: 'different-actor' },
    { ...marker, sessionId: 'different-session' },
    { ...marker, createdAt: Date.now() - 121_000 },
    { ...marker, createdAt: Date.now() + 60_000 },
    { ...marker, prompt: 'x'.repeat(8001) },
    { ...marker, catalogId: 'no-longer-available' },
    { ...marker, prompt: 'คำถามเดิมที่ไม่ตรงกับรายการปัจจุบัน' },
  ]) {
    await page.evaluate(({ key, value }) => sessionStorage.setItem(key, JSON.stringify(value)), { key, value: invalid });
    await page.reload();
    await expect(page.getByRole('textbox', { name: 'ข้อความถึง DaTex' })).toHaveValue('');
    await expect.poll(() => page.evaluate(key => sessionStorage.getItem(key), key)).toBeNull();
    expect(submissions).toBe(0);
  }
  await page.evaluate(({ key, value }) => sessionStorage.setItem(key, JSON.stringify(value)), { key, value: { ...marker, createdAt: Date.now() } });
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'ข้อความถึง DaTex' })).toHaveValue(`${prompt} จาก Dashboard ที่เลือกไว้`);
  await expect(page.getByRole('textbox', { name: 'ข้อความถึง DaTex' })).toBeFocused();
  await expect.poll(() => page.evaluate(key => sessionStorage.getItem(key), key)).toBeNull();
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'ข้อความถึง DaTex' })).toHaveValue('');
  expect(submissions).toBe(0);
});
for (const profile of ['executive', 'east', 'hr']) {
  test(`new-chat first suggestion stays fully above composer for ${profile} at 941 and adjacent viewports`, async ({ page }, testInfo) => {
    const baseline = await login(page, profile);
    const entries = catalogFor(profile);
    await fixture(page, baseline, { actionCatalog: entries });
    let submissions = 0;
    await page.route(/\/api\/chat(?:\/stream)?$/, route => { submissions += 1; return route.abort(); });
    for (const size of [{ width: 941, height: 744 }, { width: 390, height: 844 }, { width: 1440, height: 900 }]) {
      await page.setViewportSize(size);
      const first = page.locator(`[data-catalog-id="${entries[0].id}"]`);
      await expect(first).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`first-suggestion-${profile}-${size.width}.png`) });
      const geometry = await first.evaluate(element => {
        const scroll = document.querySelector('[class*="conversationScroll"]') as HTMLElement;
        const composer = document.querySelector('[class*="composerRegion"]') as HTMLElement;
        const card = element.getBoundingClientRect();
        const viewport = scroll.getBoundingClientRect();
        const controls = composer.getBoundingClientRect();
        const affordance = element.querySelector('[class*="catalogChoiceFooter"] > span')!.getBoundingClientRect();
        return { scrollTop: scroll.scrollTop, top: card.top, bottom: card.bottom, visibleTop: viewport.top, visibleBottom: Math.min(viewport.bottom, controls.top), affordanceBottom: affordance.bottom, composerBottom: controls.bottom, viewportHeight: innerHeight, covered: !element.contains(document.elementFromPoint(card.left + card.width / 2, card.bottom - 6)) };
      });
      expect(geometry.scrollTop).toBe(0);
      expect(geometry.top).toBeGreaterThanOrEqual(geometry.visibleTop);
      expect(geometry.bottom).toBeLessThanOrEqual(geometry.visibleBottom);
      expect(geometry.affordanceBottom).toBeLessThanOrEqual(geometry.visibleBottom);
      expect(geometry.covered).toBe(false);
      expect(geometry.composerBottom).toBeLessThanOrEqual(geometry.viewportHeight);
      await expect(first).toBeInViewport({ ratio: 1 });
      await expect(first.getByText('เติมคำถาม', { exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      await first.click();
      await expect(page.getByRole('textbox', { name: 'ข้อความถึง DaTex' })).toHaveValue(entries[0].prompt);
      await expect(page.getByRole('textbox', { name: 'ข้อความถึง DaTex' })).toBeFocused();
      await expect(page.getByRole('button', { name: 'ส่ง', exact: true })).toBeEnabled();
      expect(submissions).toBe(0);
      expect(await page.getByRole('button', { name: 'ส่ง', exact: true }).evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
      const last = entries.at(-1)!;
      const lowerChoice = page.locator(`[data-catalog-id="${last.id}"]`);
      await lowerChoice.scrollIntoViewIfNeeded();
      await expect(lowerChoice).toBeInViewport({ ratio: 1 });
      await lowerChoice.click();
      await expect(page.getByRole('textbox', { name: 'ข้อความถึง DaTex' })).toHaveValue(last.prompt);
      expect(submissions).toBe(0);
      await page.getByRole('textbox', { name: 'ข้อความถึง DaTex' }).fill('');
      await page.locator('[class*="conversationScroll"]').evaluate(element => { element.scrollTop = 0; });
    }
  });
}


test.describe('catalog availability on touch-capable screens', () => {
  test.use({ hasTouch: true });
  for (const size of [{ width: 941, height: 744 }, { width: 390, height: 844 }]) {
    test(`server catalog statuses stay distinct in chat and work view at ${size.width}`, async ({ page }, testInfo) => {
      await page.setViewportSize(size);
      const baseline = await login(page);
      const entry = catalogFor('executive')[0];
      const cases: { status?: CatalogStatus; message?: string; retry: boolean; entries: CatalogEntry[]; offered: number }[] = [
        { status: undefined, message: 'รายการงานยังไม่พร้อม กรุณาโหลดสถานะอีกครั้งเพื่อดูคำถามและข้อเสนอที่เลือกได้', retry: true, entries: [], offered: 0 },
        { status: 'data_unavailable', message: 'ข้อมูลสำหรับรายการงานไม่พร้อมใช้งานชั่วคราว กรุณาลองโหลดอีกครั้ง', retry: true, entries: [entry], offered: 0 },
        { status: 'no_authorized_flows', message: 'โปรไฟล์นี้ยังไม่มีรายการงานที่ได้รับอนุญาต', retry: false, entries: [], offered: 0 },
        { status: 'no_current_targets', message: 'ยังไม่มีข้อมูลหรือรายการเป้าหมายที่ตรงเงื่อนไขของงานในขณะนี้', retry: true, entries: [], offered: 0 },
        { status: 'limited', message: 'รายการงานบางส่วนยังไม่พร้อม', retry: true, entries: [entry], offered: 1 },
        { status: 'ready', retry: false, entries: [entry], offered: 1 },
      ];
      let current = cases[0];
      let reads = 0;
      await page.route('**/api/workspace', route => {
        reads += 1;
        return route.fulfill({ json: { ...baseline, messages: [], actions: [], receipts: [], audit: [], dashboards: [], inbox: [], actionCatalog: current.entries, actionCatalogStatus: current.status } });
      });
      for (const item of cases) {
        current = item;
        for (const section of ['', 'capabilities']) {
          await page.goto(section ? '/?section=capabilities' : '/');
          await expect(page.getByRole('switch')).toBeVisible();
          if (item.message) await expect(page.getByText(item.message, { exact: true })).toBeVisible();
          await expect(page.locator('[data-catalog-id]')).toHaveCount(item.offered);
          if (!section && item.offered > 0) await expect(page.locator('[data-catalog-id]').first()).toBeInViewport({ ratio: 1 });
          const retry = page.getByRole('button', { name: 'โหลดรายการงานอีกครั้ง', exact: true });
          await expect(retry).toHaveCount(item.retry ? 1 : 0);
          if (item.retry) {
            const before = reads;
            await retry.tap();
            await expect.poll(() => reads).toBeGreaterThan(before);
            if (item.message) await expect(page.getByText(item.message, { exact: true })).toBeVisible();
          }
          if (item.status !== 'no_authorized_flows') expect(await page.locator('main').innerText()).not.toContain('โปรไฟล์นี้ยังไม่มีรายการงานที่ได้รับอนุญาต');
          expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
          await page.screenshot({ path: testInfo.outputPath(`catalog-${item.status ?? 'not_ready'}-${section || 'chat'}-${size.width}.png`) });
        }
      }
      current = cases[1];
      await page.goto('/?section=dashboards');
      await expect(page.getByText(cases[1].message!, { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'เริ่มสร้าง Dashboard', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'โหลดรายการงานอีกครั้ง', exact: true })).toBeVisible();
    });
  }
});
