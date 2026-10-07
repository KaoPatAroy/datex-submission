import { expect, test, type Page, type Route } from '@playwright/test';
import type { Workspace } from '../../lib/contracts';
import type { LifecycleAction } from '../../components/biztania/product-labels';
import type { DashboardRevisionRequest } from '../../components/action-review-dialog';

test.setTimeout(90_000);
const title = 'ภาพรวมเดิม';
const nextTitle = 'ภาพรวมฉบับปรับปรุง';
async function prepare(page: Page, state: 'pending' | 'expired' | 'stale' = 'pending', confirmationStatus: 'verified_success' | 'pending' = 'verified_success') {
  expect((await page.request.get('/api/session', { timeout: 60_000 })).status()).toBe(401);
  await page.goto('/');
  await page.getByLabel('รหัสเข้าใช้งาน').fill('nexus-test-access');
  await page.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true }).click();
  await expect(page.getByRole('switch')).toBeVisible();
  const baseline = await page.evaluate(async () => await fetch('/api/workspace').then(response => response.json()) as Workspace);
  const now = Date.now();
  const original: LifecycleAction = { id: 'proposal-A', actorId: baseline.actor.id, sessionId: baseline.actor.sessionId, conversationId: 'revision-conversation', turnId: 'source-turn', mode: baseline.actor.mode, modeRevision: baseline.actor.modeRevision, payload: { kind: 'dashboard_create', spec: { title, description: 'คำอธิบายเดิม', scope: { region: 'east', date: baseline.businessDate }, widgets: [{ type: 'metric', title: 'ยอดขายสุทธิ', metric: 'net_sales' }, { type: 'bar_chart', title: 'เทียบเป้าหมาย', metric: 'net_sales', comparisonMetric: 'target', groupBy: 'branch' }, { type: 'incident_list', title: 'Incident', dataset: 'open_incidents' }] } }, payloadHash: 'hash-A', evidenceVersion: 'evidence-A', packs: [], createdAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(state === 'expired' ? now - 1_000 : now + 600_000).toISOString(), status: state === 'stale' ? 'stale' : 'pending', ...(state === 'stale' ? { staleReason: 'evidence_changed' as const } : {}), preview: '' };
  let actions: LifecycleAction[] = [structuredClone(original)];
  const receipts: Workspace['receipts'] = [];
  const revisions: DashboardRevisionRequest[] = [];
  const confirms: string[] = [];
  const cancellations: string[] = [];
  let effects = 0;
  let chats = 0;
  const workspace = () => ({ ...baseline, actions, receipts, dashboards: [], inbox: [], audit: [], actionCatalog: [], actionCatalogStatus: 'ready', messages: [{ id: 'revision-user', actorId: baseline.actor.id, sessionId: baseline.actor.sessionId, conversationId: original.conversationId, turnId: original.turnId, role: 'user', text: 'สร้าง Dashboard ภาพรวมยอดขาย', mode: baseline.actor.mode, modeRevision: baseline.actor.modeRevision, createdAt: original.createdAt }, { id: 'revision-assistant', actorId: baseline.actor.id, sessionId: baseline.actor.sessionId, conversationId: original.conversationId, turnId: original.turnId, role: 'assistant', text: 'เตรียมข้อเสนอสำหรับตรวจสอบแล้ว', pendingActionIds: [original.id], mode: baseline.actor.mode, modeRevision: baseline.actor.modeRevision, createdAt: original.createdAt }] });
  let workspaceReads = 0;
  let workspaceHandler: ((route: Route, snapshot: ReturnType<typeof workspace>) => Promise<void>) | undefined;
  await page.route('**/api/workspace', route => {
    workspaceReads += 1;
    const snapshot = structuredClone(workspace());
    return workspaceHandler ? workspaceHandler(route, snapshot) : route.fulfill({ json: snapshot });
  });
  await page.route(/\/api\/chat(?:\/stream)?$/, route => { chats += 1; return route.abort(); });
  function replacement(request: DashboardRevisionRequest) {
    if (original.payload.kind !== 'dashboard_create') throw new Error('Expected dashboard base');
    const spec = structuredClone(original.payload.spec);
    if (request.patch.title !== undefined) spec.title = request.patch.title;
    if (request.patch.description !== undefined) spec.description = request.patch.description;
    if (request.patch.widgetChange?.operation === 'remove') spec.widgets = spec.widgets.filter((_, index) => !request.patch.widgetChange || request.patch.widgetChange.operation !== 'remove' || !request.patch.widgetChange.indexes.includes(index));
    if (request.patch.widgetChange?.operation === 'reorder') spec.widgets = request.patch.widgetChange.order.map(index => structuredClone(original.payload.kind === 'dashboard_create' ? original.payload.spec.widgets[index] : spec.widgets[index]));
    const diff = [`เปลี่ยนชื่อ: "${title}" → "${spec.title}"`, request.patch.widgetChange?.operation === 'remove' ? 'ลบ: เทียบเป้าหมาย (ตำแหน่งเดิม 2)' : 'เรียงลำดับมุมมองตามข้อเสนอที่ตรวจแล้ว'];
    const predecessor: LifecycleAction = { ...structuredClone(original), status: 'stale', staleReason: 'superseded', supersededByActionId: 'proposal-B' };
    const next: LifecycleAction = { ...structuredClone(original), id: 'proposal-B', turnId: 'revision-turn', payload: { kind: 'dashboard_create', spec }, payloadHash: 'hash-B', predecessorActionId: original.id, revisionDiff: diff };
    actions = [predecessor, next];
    return { predecessor, replacement: next, diff };
  }
  let reviseHandler: ((route: Route, request: DashboardRevisionRequest) => Promise<void>) | undefined;
  await page.route('**/api/actions/*/revise', async route => {
    expect(new URL(route.request().url()).pathname).toBe(`/api/actions/${original.id}/revise`);
    expect(route.request().method()).toBe('POST');
    expect(Boolean(route.request().headers()['x-csrf-token'])).toBe(true);
    const body = route.request().postDataJSON() as DashboardRevisionRequest;
    expect(Object.keys(body).sort()).toEqual(['patch', 'requestKey']);
    expect(body.requestKey).toMatch(/^[A-Za-z0-9_-]{16,120}$/);
    revisions.push(structuredClone(body));
    if (reviseHandler) return reviseHandler(route, body);
    await route.fulfill({ json: replacement(body) });
  });
  await page.route('**/api/actions/*/cancel', async route => {
    expect(route.request().method()).toBe('POST');
    expect(Boolean(route.request().headers()['x-csrf-token'])).toBe(true);
    expect(route.request().postDataJSON()).toEqual({});
    const id = new URL(route.request().url()).pathname.split('/')[3];
    cancellations.push(id);
    const cancelled: LifecycleAction = { ...actions.find(action => action.id === id)!, status: 'stale', staleReason: 'user_cancelled' };
    actions = actions.map(action => action.id === id ? cancelled : action);
    await route.fulfill({ json: { action: cancelled } });
  });
  await page.route('**/api/actions/*/confirm', async route => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().postDataJSON()).toEqual({});
    const id = new URL(route.request().url()).pathname.split('/')[3];
    confirms.push(id);
    expect(id).toBe('proposal-B');
    effects += 1;
    actions = actions.map(action => action.id === id ? { ...action, status: 'completed' } : action);
    const receipt = { id: 'receipt-B', actionId: id, actorId: baseline.actor.id, kind: 'dashboard_create' as const, status: confirmationStatus, dashboardId: 'dashboard-B', results: [], createdAt: new Date().toISOString(), verifiedAt: confirmationStatus === 'verified_success' ? new Date().toISOString() : null };
    receipts.push(receipt);
    await route.fulfill({ json: receipt });
  });
  await page.goto('/');
  await expect(page.locator('[data-action-id="proposal-A"]')).toBeVisible();
  page.setDefaultTimeout(15_000);
  return { original, revisions, confirms, cancellations, get actions() { return actions; }, get effects() { return effects; }, get chats() { return chats; }, get workspaceReads() { return workspaceReads; }, replacement, setActions(next: LifecycleAction[]) { actions = next; }, setReviseHandler(handler: typeof reviseHandler) { reviseHandler = handler; }, setWorkspaceHandler(handler: typeof workspaceHandler) { workspaceHandler = handler; } };
}
async function openEditor(page: Page) {
  await page.locator('[data-action-review="proposal-A"]').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveAttribute('data-review-action-id', 'proposal-A');
  await dialog.getByRole('button', { name: 'แก้ไขข้อเสนอ', exact: true }).click();
  await dialog.getByLabel('ชื่อ Dashboard', { exact: true }).fill(nextTitle);
  return dialog;
}

for (const [kind, status, width] of [['revise', 404, 390], ['cancel', 404, 941], ['revise', 409, 1440], ['cancel', 409, 390]] as const) {
  test(`first ${kind} ${status} stays guarded through pending readback and reload`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const harness = await prepare(page);
    let attempts = 0;
    await page.route(`**/api/actions/*/${kind}`, async route => {
      attempts += 1;
      await route.fulfill({ status, json: { error: { code: 'ACTION_CONFLICT', message: 'ข้อเสนอเปลี่ยนไป' } } });
    });
    if (kind === 'revise') {
      const dialog = await openEditor(page);
      await dialog.getByRole('button', { name: 'ดูตัวอย่างฉบับปรับแก้', exact: true }).click();
    } else {
      await page.locator('[data-action-review="proposal-A"]').click();
      await page.getByRole('dialog').getByRole('button', { name: 'ยกเลิกข้อเสนอ', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'ยืนยันยกเลิกข้อเสนอ', exact: true }).click();
    }
    const dialog = page.getByRole('dialog');
    const card = page.locator('[data-action-id="proposal-A"]');
    await expect(card).toHaveAttribute('data-action-state', 'rejected');
    await expect(dialog.getByRole('button', { name: 'สร้าง Dashboard', exact: true })).toBeDisabled();
    await expect(dialog).toContainText('คำขอเปลี่ยนข้อเสนอถูกปฏิเสธ');
    await page.keyboard.press('Escape');
    const before = harness.workspaceReads;
    await card.getByRole('button', { name: 'ตรวจผลคำขอเดิม', exact: true }).click();
    await expect.poll(() => harness.workspaceReads).toBeGreaterThan(before);
    await expect(card).toHaveAttribute('data-action-state', 'rejected');
    await expect(page.locator('[data-action-review="proposal-A"]')).toHaveCount(0);
    await page.reload();
    await expect(card).toHaveAttribute('data-action-state', 'rejected');
    await expect(page.locator('[data-action-review="proposal-A"]')).toHaveCount(0);
    await expect(card).toContainText('ข้อเสนอเดิมยังยืนยันไม่ได้');
    await card.getByRole('button', { name: 'เตรียมรายการใหม่', exact: true }).click();
    await expect(page.getByLabel('ข้อความถึง DaTex')).not.toHaveValue('');
    expect(await card.evaluate(element => {
      const box = element.getBoundingClientRect();
      return box.left >= 0 && box.right <= innerWidth && [...element.querySelectorAll('button')].every(button => {
        const bounds = button.getBoundingClientRect();
        return bounds.left >= box.left && bounds.right <= box.right;
      });
    })).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`rejected-${kind}-${status}-${width}.png`) });
    expect(harness.chats).toBe(0); expect(harness.confirms).toEqual([]); expect(attempts).toBe(1);
    harness.setActions([{ ...harness.original, status: 'stale', staleReason: 'evidence_changed' }]);
    await card.getByRole('button', { name: 'ตรวจผลคำขอเดิม', exact: true }).click();
    await expect(card).toHaveAttribute('data-action-state', 'stale');
    await expect(card.getByRole('button', { name: 'ตรวจผลคำขอเดิม', exact: true })).toHaveCount(0);
    expect(attempts).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  });
}

for (const race of ['successful mutation', 'newer terminal read'] as const) {
  test(`older workspace ${race === 'successful mutation' ? 'success' : 'error'} cannot roll back ${race}`, async ({ page }) => {
    const harness = await prepare(page);
    await page.getByRole('navigation', { name: 'เมนูหลัก' }).getByRole('button', { name: 'งานและการอนุมัติ', exact: true }).click();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let reads = 0;
    harness.setWorkspaceHandler(async (route, snapshot) => {
      reads += 1;
      if (reads === 1) {
        await gate;
        await route.fulfill(race === 'successful mutation' ? { json: snapshot, headers: { 'x-fixture-read': 'delayed-race' } } : { status: 401, json: { error: { message: 'stale authentication error' } }, headers: { 'x-fixture-read': 'delayed-race' } });
      } else await route.fulfill({ json: snapshot });
    });
    const card = page.locator('[data-action-id="proposal-A"]');
    try {
      await page.getByRole('button', { name: 'โหลดสถานะ', exact: true }).click();
      await expect.poll(() => reads).toBe(1);
      if (race === 'successful mutation') {
        await page.locator('[data-action-review="proposal-A"]').click();
        await page.getByRole('dialog').getByRole('button', { name: 'ยกเลิกข้อเสนอ', exact: true }).click();
        await page.getByRole('dialog').getByRole('button', { name: 'ยืนยันยกเลิกข้อเสนอ', exact: true }).click();
        await expect(card).toHaveCount(0); // a cancelled proposal leaves the approvals queue and must not be resurrected by an older read
        await page.keyboard.press('Escape');
      } else {
        harness.setActions([{ ...harness.original, status: 'stale', staleReason: 'user_cancelled' }]);
        await page.getByRole('button', { name: 'โหลดสถานะ', exact: true }).click();
        await expect(card).toHaveCount(0); // a cancelled proposal leaves the approvals queue and must not be resurrected by an older read
      }
      const response = page.waitForResponse(response => response.headers()['x-fixture-read'] === 'delayed-race');
      release(); await (await response).finished();
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expect(card).toHaveCount(0); // a cancelled proposal leaves the approvals queue and must not be resurrected by an older read
      await expect(page.locator('[data-action-review="proposal-A"]')).toHaveCount(0);
      await expect(page.getByRole('switch')).toBeVisible();
      await expect(page.getByText('stale authentication error', { exact: true })).toHaveCount(0);
      expect(harness.confirms).toEqual([]);
      expect(harness.cancellations).toEqual(race === 'successful mutation' ? ['proposal-A'] : []);
      await page.reload();
      await expect(card).toHaveCount(0); // a cancelled proposal leaves the approvals queue and must not be resurrected by an older read
    } finally { release(); }
  });
}

for (const viewport of [{ width: 1920, height: 953 }, { width: 1440, height: 900 }, { width: 941, height: 900 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]) {
  test(`dashboard A to B stays identity-bound and has no effect until explicit confirm at ${viewport.width}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const harness = await prepare(page);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    harness.setReviseHandler(async (route, request) => { await gate; await route.fulfill({ json: harness.replacement(request) }); });
    const dialog = await openEditor(page);
    await dialog.getByLabel('คำอธิบาย', { exact: true }).fill('คำอธิบายฉบับใหม่');
    await dialog.getByRole('radio', { name: 'เอามุมมองออก', exact: true }).check();
    await dialog.getByRole('checkbox', { name: 'เอา “เทียบเป้าหมาย” ออก', exact: true }).check();
    await expect(dialog.getByRole('button', { name: 'สร้าง Dashboard', exact: true })).toBeDisabled();
    await expect(page.locator('[data-action-id="proposal-A"] .proposal-summary').first()).toContainText(title);
    await page.screenshot({ path: testInfo.outputPath(`revision-draft-${viewport.width}.png`) });
    await dialog.getByRole('button', { name: 'ดูตัวอย่างฉบับปรับแก้', exact: true }).dblclick();
    await expect.poll(() => harness.revisions.length).toBe(1);
    await expect(page.locator('[data-action-id="proposal-A"]')).toHaveAttribute('data-action-state', 'revising');
    await expect(dialog.getByRole('button', { name: 'สร้าง Dashboard', exact: true })).toBeDisabled();
    expect(harness.revisions[0].patch).toEqual({ title: nextTitle, description: 'คำอธิบายฉบับใหม่', widgetChange: { operation: 'remove', indexes: [1] } });
    expect(harness.confirms).toEqual([]); expect(harness.effects).toBe(0); expect(harness.chats).toBe(0);
    release();
    await expect(dialog).toHaveAttribute('data-review-action-id', 'proposal-B');
    await expect(dialog.getByRole('region', { name: 'สิ่งที่เปลี่ยนจากข้อเสนอเดิม' })).toContainText(`เปลี่ยนชื่อ: "${title}" → "${nextTitle}"`);
    await expect(dialog.getByRole('region', { name: 'สิ่งที่เปลี่ยนจากข้อเสนอเดิม' })).toContainText('ลบ: เทียบเป้าหมาย (ตำแหน่งเดิม 2)');
    await expect(dialog.getByRole('button', { name: 'สร้าง Dashboard', exact: true })).toBeEnabled();
    await expect(page.locator('[data-action-id="proposal-A"]')).toHaveAttribute('data-action-state', 'superseded');
    await expect(page.locator('[data-action-review="proposal-A"]')).toHaveCount(0);
    expect(harness.actions[0].payload).toEqual(harness.original.payload);
    expect(new URL(page.url()).pathname).toBe('/');
    expect(harness.effects).toBe(0);
    await page.screenshot({ path: testInfo.outputPath(`revision-B-${viewport.width}.png`) });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('[data-action-review="proposal-B"]')).toBeFocused();
    await page.reload();
    await expect(page.locator('[data-action-id="proposal-B"]')).toHaveCount(1);
    await expect(page.locator('[data-action-id="proposal-A"]')).toHaveAttribute('data-action-state', 'superseded');
    await page.locator('[data-action-review="proposal-B"]').click();
    await expect(page.getByRole('dialog')).toContainText(nextTitle);
    expect(harness.confirms).toEqual([]);
    const automaticDashboardNavigations: string[] = [];
    let explicitOpenAllowed = false;
    const isDashboardRoute = (url: string) => new URL(url).pathname.startsWith('/dashboards/');
    // Next may request the destination's RSC payload long before committing its URL.
    page.on('request', request => {
      if (!explicitOpenAllowed && isDashboardRoute(request.url())) automaticDashboardNavigations.push(`request: ${request.url()}`);
    });
    page.on('framenavigated', frame => {
      if (!explicitOpenAllowed && frame === page.mainFrame() && isDashboardRoute(frame.url())) automaticDashboardNavigations.push(`navigation: ${frame.url()}`);
    });
    await page.getByRole('dialog').getByRole('button', { name: 'สร้าง Dashboard', exact: true }).click();
    await expect.poll(() => harness.effects).toBe(1);
    expect(harness.confirms).toEqual(['proposal-B']); expect(harness.chats).toBe(0);
    const verifiedCard = page.locator('[data-action-id="proposal-B"]');
    await expect(verifiedCard).toHaveAttribute('data-action-state', 'verified_success');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(verifiedCard.getByRole('status', { name: 'ผลที่ตรวจสอบแล้ว' })).toContainText('ตรวจสอบผลสำเร็จ');
    expect(await verifiedCard.innerText()).not.toMatch(/receipt-B|dashboard-B|\/dashboards\//);
    await expect(verifiedCard.getByRole('button', { name: 'เปิด Dashboard', exact: true })).toHaveAttribute('data-open-dashboard', 'dashboard-B');
    await expect(verifiedCard.getByRole('button', { name: 'เปิด Dashboard', exact: true })).toBeFocused();
    expect(automaticDashboardNavigations, 'confirmation must not request or navigate to a dashboard').toEqual([]);
    // Observe delayed transitions before reload can cancel an outstanding router.push.
    await page.waitForRequest(request => isDashboardRoute(request.url()), { timeout: 2_000 }).catch((error: unknown) => {
      if (!(error instanceof Error) || error.name !== 'TimeoutError') throw error;
    });
    expect(automaticDashboardNavigations, 'no automatic dashboard navigation during the post-confirm observation window').toEqual([]);
    expect(new URL(page.url()).pathname).toBe('/');
    await expect(page.locator('[data-action-review="proposal-B"]')).toHaveCount(0);
    await page.reload();
    await expect(verifiedCard).toHaveCount(1);
    await expect(verifiedCard).toHaveAttribute('data-action-state', 'verified_success');
    expect(await verifiedCard.innerText()).not.toMatch(/receipt-B|dashboard-B|\/dashboards\//);
    const technicalDetails = verifiedCard.locator('details.technical-detail');
    await technicalDetails.locator('summary').click();
    await expect(technicalDetails.locator('pre')).toBeVisible();
    await expect(technicalDetails.locator('pre')).toContainText('receipt-B');
    await expect(technicalDetails.locator('pre')).toContainText('dashboard-B');
    await technicalDetails.locator('summary').click();
    await expect(technicalDetails.locator('pre')).toBeHidden();
    expect(new URL(page.url()).pathname).toBe('/');
    await verifiedCard.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`verified-card-${viewport.width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    expect(automaticDashboardNavigations).toEqual([]);
    explicitOpenAllowed = true;
    await verifiedCard.getByRole('button', { name: 'เปิด Dashboard', exact: true }).click();
    await expect(page).toHaveURL(/\/dashboards\/dashboard-B$/);
    expect(harness.confirms).toEqual(['proposal-B']); expect(harness.effects).toBe(1);
  });
}

test('pending dashboard receipt stays on chat without offering an unverified dashboard', async ({ page }) => {
  const harness = await prepare(page, 'pending', 'pending');
  const dialog = await openEditor(page);
  await dialog.getByRole('button', { name: 'ดูตัวอย่างฉบับปรับแก้', exact: true }).click();
  await expect(dialog).toHaveAttribute('data-review-action-id', 'proposal-B');
  await dialog.getByRole('button', { name: 'สร้าง Dashboard', exact: true }).click();
  await expect.poll(() => harness.effects).toBe(1);
  const card = page.locator('[data-action-id="proposal-B"]');
  await expect(card.getByRole('button', { name: 'ตรวจผลคำขอเดิม', exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'เปิด Dashboard', exact: true })).toHaveCount(0);
  await expect(card.getByRole('status', { name: 'ผลที่ตรวจสอบแล้ว' })).toHaveCount(0);
  await expect(page.locator('[data-action-review="proposal-B"]')).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe('/');
  expect(harness.confirms).toEqual(['proposal-B']);
});

for (const width of [1440, 390]) {
  test(`unknown revision survives full reload with its draft and request key at ${width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const harness = await prepare(page);
    harness.setReviseHandler(async route => { await route.fulfill({ status: 503, json: { error: { message: 'ผลยังไม่พร้อม' } } }); });
    let dialog = await openEditor(page);
    await dialog.getByLabel('คำอธิบาย', { exact: true }).fill('ฉบับร่างที่ต้องกู้คืน');
    await dialog.getByRole('radio', { name: 'จัดลำดับมุมมอง', exact: true }).check();
    await dialog.getByRole('button', { name: 'เลื่อน ยอดขายสุทธิ ลง', exact: true }).click();
    await dialog.getByRole('button', { name: 'ดูตัวอย่างฉบับปรับแก้', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('ยังยืนยันผลตัวอย่างใหม่ไม่ได้');
    const originalRequest = structuredClone(harness.revisions[0]);
    await page.reload();
    const card = page.locator('[data-action-id="proposal-A"]');
    await expect(card).toHaveAttribute('data-action-state', 'unresolved');
    const reads = harness.workspaceReads;
    await card.getByRole('button', { name: 'ตรวจผลคำขอเดิม', exact: true }).click();
    await expect.poll(() => harness.workspaceReads).toBeGreaterThan(reads);
    await expect(card).toHaveAttribute('data-action-state', 'unresolved');
    await page.locator('[data-action-review="proposal-A"]').click();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('ชื่อ Dashboard')).toHaveValue(nextTitle);
    await expect(dialog.getByLabel('คำอธิบาย', { exact: true })).toHaveValue('ฉบับร่างที่ต้องกู้คืน');
    await expect(dialog.getByRole('radio', { name: 'จัดลำดับมุมมอง', exact: true })).toBeChecked();
    await expect(dialog.getByRole('button', { name: 'สร้าง Dashboard', exact: true })).toBeDisabled();
    expect(harness.revisions).toHaveLength(1);
    expect(harness.confirms).toEqual([]); expect(harness.cancellations).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`recovered-revision-${width}.png`) });
    harness.setReviseHandler(async (route, request) => { await route.fulfill({ json: harness.replacement(request) }); });
    await dialog.getByRole('button', { name: 'ลองส่งคำขอเดิมอีกครั้ง', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveAttribute('data-review-action-id', 'proposal-B');
    expect(harness.revisions).toEqual([originalRequest, originalRequest]);
    expect(harness.effects).toBe(0); expect(harness.chats).toBe(0);
  });

  test(`keyboard focus enters and leaves the editor and survives cancellation at ${width}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await prepare(page);
    await page.locator('[data-action-review="proposal-A"]').focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    const edit = dialog.getByRole('button', { name: 'แก้ไขข้อเสนอ', exact: true });
    await edit.focus(); await page.keyboard.press('Enter');
    await expect(dialog.getByRole('heading', { name: 'ปรับข้อเสนอ', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByLabel('ชื่อ Dashboard', { exact: true })).toBeFocused();
    await expect(dialog.getByLabel('ชื่อ Dashboard', { exact: true })).toBeInViewport();
    await dialog.getByRole('button', { name: 'เลิกแก้ไข', exact: true }).focus(); await page.keyboard.press('Enter');
    await expect(edit).toBeFocused();
    await dialog.getByRole('button', { name: 'ยกเลิกข้อเสนอ', exact: true }).focus(); await page.keyboard.press('Enter');
    await dialog.getByRole('button', { name: 'ยืนยันยกเลิกข้อเสนอ', exact: true }).focus(); await page.keyboard.press('Enter');
    await expect(dialog).toContainText('ยกเลิกแล้ว');
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-action-id="proposal-A"]')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('[data-action-id="proposal-A"]').getByRole('button', { name: 'รายละเอียดรายการ', exact: true })).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath(`cancel-focus-${width}.png`) });
  });
}

for (const finalState of ['pending', 'cancelled', 'superseded', 'stale'] as const) {
  test(`unknown cancellation reload reconciles only verified ${finalState} state`, async ({ page }) => {
    const harness = await prepare(page);
    let attempts = 0;
    await page.route('**/api/actions/*/cancel', async route => { attempts += 1; await route.fulfill({ status: 503, json: { error: { message: 'ยังตรวจผลไม่ได้' } } }); });
    await page.locator('[data-action-review="proposal-A"]').click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'ยกเลิกข้อเสนอ', exact: true }).click();
    await dialog.getByRole('button', { name: 'ยืนยันยกเลิกข้อเสนอ', exact: true }).click();
    await expect(dialog.locator('.error-banner')).toContainText('ยังยืนยันผลการยกเลิกไม่ได้');
    await page.reload();
    const card = page.locator('[data-action-id="proposal-A"]');
    await expect(card).toHaveAttribute('data-action-state', 'unresolved');
    if (finalState === 'superseded') harness.replacement({ requestKey: 'readback-only-request', patch: { title: nextTitle } });
    else if (finalState !== 'pending') harness.setActions([{ ...harness.original, status: 'stale', staleReason: finalState === 'cancelled' ? 'user_cancelled' : 'evidence_changed' }]);
    const reads = harness.workspaceReads;
    await card.getByRole('button', { name: 'ตรวจผลคำขอเดิม', exact: true }).click();
    await expect.poll(() => harness.workspaceReads).toBeGreaterThan(reads);
    await expect(card).toHaveAttribute('data-action-state', finalState === 'pending' ? 'unresolved' : finalState);
    if (finalState === 'pending') {
      await page.locator('[data-action-review="proposal-A"]').click();
      await expect(dialog.getByRole('button', { name: 'สร้าง Dashboard', exact: true })).toBeDisabled();
      await page.keyboard.press('Escape');
      harness.setActions([harness.original, { ...harness.original, id: 'unrelated-proposal', payloadHash: 'unrelated-hash' }]);
      await page.reload();
      await expect(card).toHaveAttribute('data-action-state', 'unresolved');
      await page.getByRole('navigation', { name: 'เมนูหลัก' }).getByRole('button', { name: 'งานและการอนุมัติ', exact: true }).click();
      await page.locator('[data-action-review="unrelated-proposal"]').click();
      await expect(dialog.getByRole('button', { name: 'สร้าง Dashboard', exact: true })).toBeEnabled();
    } else {
      await expect(card.getByRole('button', { name: 'ตรวจผลคำขอเดิม', exact: true })).toHaveCount(0);
      await expect(page.locator('[data-action-review="proposal-A"]')).toHaveCount(0);
      await page.reload();
      await expect(card).toHaveAttribute('data-action-state', finalState);
    }
    if (finalState === 'superseded') {
      await page.locator('[data-action-review="proposal-B"]').click();
      await expect(dialog.getByRole('button', { name: 'สร้าง Dashboard', exact: true })).toBeEnabled();
    }
    expect(attempts).toBe(1); expect(harness.revisions).toHaveLength(0); expect(harness.confirms).toEqual([]); expect(harness.effects).toBe(0);
  });
}

test('a revision committed before a lost response is recovered on reload without another write', async ({ page }) => {
  const harness = await prepare(page);
  harness.setReviseHandler(async (route, request) => {
    harness.replacement(request);
    await route.fulfill({ status: 503, json: { error: { message: 'ขาดการเชื่อมต่อหลังบันทึก' } } });
  });
  const dialog = await openEditor(page);
  await dialog.getByRole('button', { name: 'ดูตัวอย่างฉบับปรับแก้', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('ยังยืนยันผลตัวอย่างใหม่ไม่ได้');
  await page.reload();
  await expect(page.locator('[data-action-id="proposal-A"]')).toHaveAttribute('data-action-state', 'superseded');
  await expect(page.locator('[data-action-review="proposal-A"]')).toHaveCount(0);
  await page.locator('[data-action-review="proposal-B"]').click();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'สร้าง Dashboard', exact: true })).toBeEnabled();
  expect(harness.revisions).toHaveLength(1); expect(harness.confirms).toEqual([]); expect(harness.effects).toBe(0);
});

for (const terminal of ['cancelled', 'superseded'] as const) {
  test(`a delayed pending workspace cannot replace newer ${terminal} readback`, async ({ page }) => {
    const harness = await prepare(page);
    harness.setReviseHandler(route => route.fulfill({ status: 503, json: { error: { message: 'ผลยังไม่พร้อม' } } }));
    const dialog = await openEditor(page);
    await dialog.getByRole('button', { name: 'ดูตัวอย่างฉบับปรับแก้', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('ยังยืนยันผลตัวอย่างใหม่ไม่ได้');
    await page.keyboard.press('Escape');
    let releaseOlder!: () => void;
    let markOlderFinished!: () => void;
    const olderFinished = new Promise<void>(resolve => { markOlderFinished = resolve; });
    const gate = new Promise<void>(resolve => { releaseOlder = resolve; });
    let reads = 0;
    harness.setWorkspaceHandler(async (route, snapshot) => {
      reads += 1;
      if (reads === 1) {
        await gate;
        await route.fulfill({ json: snapshot, headers: { 'x-fixture-read': 'older' } });
        markOlderFinished();
      } else await route.fulfill({ json: snapshot });
    });
    const card = page.locator('[data-action-id="proposal-A"]');
    try {
      await card.getByRole('button', { name: 'ตรวจผลคำขอเดิม', exact: true }).click();
      await expect.poll(() => reads).toBe(1);
      if (terminal === 'superseded') harness.replacement(harness.revisions[0]);
      else harness.setActions([{ ...harness.original, status: 'stale', staleReason: 'user_cancelled' }]);
      await card.getByRole('button', { name: 'ตรวจผลคำขอเดิม', exact: true }).click();
      await expect(card).toHaveAttribute('data-action-state', terminal);
      await expect(page.locator('[data-action-review="proposal-A"]')).toHaveCount(0);
      const delivered = page.waitForResponse(response => response.headers()['x-fixture-read'] === 'older');
      releaseOlder(); await olderFinished; await (await delivered).finished();
      // Give the completed fetch and React's scheduled render their next browser frames.
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expect(card).toHaveAttribute('data-action-state', terminal);
      await expect(page.locator('[data-action-review="proposal-A"]')).toHaveCount(0);
      await expect(card.getByRole('button', { name: 'ตรวจผลคำขอเดิม', exact: true })).toHaveCount(0);
      expect(harness.revisions).toHaveLength(1); expect(harness.confirms).toEqual([]); expect(harness.cancellations).toEqual([]);
      await page.reload();
      await expect(card).toHaveAttribute('data-action-state', terminal);
    } finally { releaseOlder(); }
  });
}

test('cancellation committed before a lost response reconciles by read only without a retry', async ({ page }) => {
  const harness = await prepare(page);
  let attempts = 0;
  await page.route('**/api/actions/*/cancel', async route => {
    attempts += 1;
    harness.setActions([{ ...harness.original, status: 'stale', staleReason: 'user_cancelled' }]);
    await route.fulfill({ status: 503, json: { error: { message: 'ขาดการเชื่อมต่อหลังบันทึก' } } });
  });
  await page.locator('[data-action-review="proposal-A"]').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'ยกเลิกข้อเสนอ', exact: true }).click();
  await dialog.getByRole('button', { name: 'ยืนยันยกเลิกข้อเสนอ', exact: true }).click();
  await expect(dialog.locator('.error-banner')).toContainText('ยังยืนยันผลการยกเลิกไม่ได้');
  await expect(dialog.getByRole('button', { name: 'สร้าง Dashboard', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'ตรวจผลคำขอเดิม', exact: true }).click();
  await expect(page.locator('[data-action-id="proposal-A"]')).toHaveAttribute('data-action-state', 'cancelled');
  await expect(dialog.getByRole('button', { name: 'ตรวจผลคำขอเดิม', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.locator('[data-action-id="proposal-A"]')).toHaveAttribute('data-action-state', 'cancelled');
  expect(attempts).toBe(1); expect(harness.confirms).toEqual([]); expect(harness.revisions).toHaveLength(0); expect(harness.effects).toBe(0);
});

test('failed revision preserves typed draft and stable retry key, including dialog close', async ({ page }, testInfo) => {
  const harness = await prepare(page);
  harness.setReviseHandler(async (route, request) => {
    if (harness.revisions.length === 1) return route.fulfill({ status: 503, json: { error: { code: 'TEMPORARY', message: 'ผลยังไม่พร้อม' } } });
    return route.fulfill({ json: harness.replacement(request) });
  });
  let dialog = await openEditor(page);
  await dialog.getByRole('radio', { name: 'จัดลำดับมุมมอง', exact: true }).check();
  await dialog.getByRole('button', { name: 'เลื่อน ยอดขายสุทธิ ลง', exact: true }).click();
  await dialog.getByRole('button', { name: 'ดูตัวอย่างฉบับปรับแก้', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('ยังยืนยันผลตัวอย่างใหม่ไม่ได้');
  await expect(dialog.getByLabel('ชื่อ Dashboard')).toHaveValue(nextTitle);
  await expect(dialog.getByRole('button', { name: 'สร้าง Dashboard', exact: true })).toBeDisabled();
  expect(harness.actions[0]).toEqual(harness.original);
  await page.screenshot({ path: testInfo.outputPath('revision-failure.png') });
  await page.keyboard.press('Escape');
  await page.locator('[data-action-review="proposal-A"]').click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('ชื่อ Dashboard')).toHaveValue(nextTitle);
  await dialog.getByRole('button', { name: 'ลองส่งคำขอเดิมอีกครั้ง', exact: true }).click();
  await expect(dialog).toHaveAttribute('data-review-action-id', 'proposal-B');
  expect(harness.revisions).toHaveLength(2);
  expect(harness.revisions[0].requestKey).toBe(harness.revisions[1].requestKey);
  expect(harness.revisions[1].patch).toEqual({ title: nextTitle, widgetChange: { operation: 'reorder', order: [1, 0, 2] } });
  expect(harness.effects).toBe(0); expect(harness.chats).toBe(0);
});

test('closing is not cancellation; explicit cancellation survives reload and history', async ({ page }, testInfo) => {
  const harness = await prepare(page);
  await page.locator('[data-action-review="proposal-A"]').click();
  await page.keyboard.press('Escape');
  expect(harness.cancellations).toEqual([]);
  await page.locator('[data-action-review="proposal-A"]').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'ยกเลิกข้อเสนอ', exact: true }).click();
  expect(harness.cancellations).toEqual([]);
  await page.keyboard.press('Escape');
  expect(harness.cancellations).toEqual([]);
  await page.locator('[data-action-review="proposal-A"]').click();
  await expect(dialog.getByRole('button', { name: 'ยืนยันยกเลิกข้อเสนอ', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'ยกเลิกข้อเสนอ', exact: true }).click();
  await dialog.getByRole('button', { name: 'ยืนยันยกเลิกข้อเสนอ', exact: true }).click();
  await expect(dialog).toContainText('ยกเลิกแล้ว');
  await expect(dialog.getByRole('button', { name: 'สร้าง Dashboard', exact: true })).toBeDisabled();
  expect(harness.cancellations).toEqual(['proposal-A']); expect(harness.effects).toBe(0); expect(harness.chats).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('cancelled-review.png') });
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.locator('[data-action-id="proposal-A"]')).toHaveAttribute('data-action-state', 'cancelled');
  await expect(page.locator('[data-action-review="proposal-A"]')).toHaveCount(0);
  await page.getByRole('navigation', { name: 'เมนูหลัก' }).getByRole('button', { name: 'ประวัติการทำงาน', exact: true }).click();
  await expect(page.locator('[data-history-action="proposal-A"]')).toContainText('ยกเลิกแล้ว');
  expect(harness.confirms).toEqual([]);
});

for (const state of ['expired', 'stale'] as const) {
  test(`${state} dashboard cannot open revision or confirmation`, async ({ page }) => {
    const harness = await prepare(page, state);
    await expect(page.locator('[data-action-id="proposal-A"]')).toHaveAttribute('data-action-state', state);
    await expect(page.locator('[data-action-review="proposal-A"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'แก้ไขข้อเสนอ', exact: true })).toHaveCount(0);
    expect(harness.revisions).toEqual([]); expect(harness.confirms).toEqual([]); expect(harness.cancellations).toEqual([]);
  });
}

test('invalid local drafts stay local and a corrected draft receives a new request key', async ({ page }) => {
  const harness = await prepare(page);
  harness.setReviseHandler(async (route, request) => {
    if (harness.revisions.length === 1) return route.fulfill({ status: 400, json: { error: { code: 'INVALID_REVISION', message: 'ตรวจข้อเสนออีกครั้ง' } } });
    return route.fulfill({ json: harness.replacement(request) });
  });
  const dialog = await openEditor(page);
  await dialog.getByRole('radio', { name: 'เอามุมมองออก', exact: true }).check();
  for (const name of ['ยอดขายสุทธิ', 'เทียบเป้าหมาย', 'Incident']) await dialog.getByRole('checkbox', { name: `เอา “${name}” ออก`, exact: true }).check();
  await expect(dialog.getByRole('button', { name: 'ดูตัวอย่างฉบับปรับแก้', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('alert')).toContainText('ต้องเหลืออย่างน้อย 1 มุมมอง');
  expect(harness.revisions).toEqual([]);
  await dialog.getByRole('radio', { name: 'คงมุมมองเดิม', exact: true }).check();
  await dialog.getByLabel('ชื่อ Dashboard').fill(' ');
  await expect(dialog.getByRole('button', { name: 'ดูตัวอย่างฉบับปรับแก้', exact: true })).toBeDisabled();
  await dialog.getByLabel('ชื่อ Dashboard').fill(nextTitle);
  await dialog.getByRole('button', { name: 'ดูตัวอย่างฉบับปรับแก้', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('ข้อมูลแก้ไขไม่ผ่านการตรวจสอบ');
  await expect(dialog.getByLabel('ชื่อ Dashboard')).toHaveValue(nextTitle);
  expect(harness.actions[0]).toEqual(harness.original);
  await dialog.getByLabel('คำอธิบาย').fill('ปรับคำอธิบายหลังตรวจข้อมูล');
  await dialog.getByRole('button', { name: 'ดูตัวอย่างฉบับปรับแก้', exact: true }).click();
  await expect(dialog).toHaveAttribute('data-review-action-id', 'proposal-B');
  expect(harness.revisions[0].requestKey).not.toBe(harness.revisions[1].requestKey);
  expect(harness.revisions[1].patch).toEqual({ title: nextTitle, description: 'ปรับคำอธิบายหลังตรวจข้อมูล' });
  expect(harness.effects).toBe(0); expect(harness.chats).toBe(0);
});

test('inconsistent returned lineage cannot replace the reviewed proposal', async ({ page }) => {
  const harness = await prepare(page);
  harness.setReviseHandler(async (route, request) => {
    const response = harness.replacement(request);
    await route.fulfill({ json: { ...response, replacement: { ...response.replacement, predecessorActionId: 'different-proposal' } } });
  });
  const dialog = await openEditor(page);
  await dialog.getByRole('button', { name: 'ดูตัวอย่างฉบับปรับแก้', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('ยังยืนยันผลตัวอย่างใหม่ไม่ได้');
  await expect(dialog).toHaveAttribute('data-review-action-id', 'proposal-A');
  await expect(dialog.getByLabel('ชื่อ Dashboard')).toHaveValue(nextTitle);
  await expect(dialog.getByRole('button', { name: 'สร้าง Dashboard', exact: true })).toBeDisabled();
  await expect(page.locator('[data-action-id="proposal-B"]')).toHaveCount(0);
  expect(harness.effects).toBe(0); expect(harness.confirms).toEqual([]);
});

test('an unknown cancellation can be retried manually after closing without confirming', async ({ page }) => {
  const harness = await prepare(page);
  let cancelAttempts = 0;
  await page.route('**/api/actions/*/cancel', async route => {
    cancelAttempts += 1;
    expect(route.request().postDataJSON()).toEqual({});
    if (cancelAttempts === 1) return route.fulfill({ status: 503, json: { error: { message: 'ยังตรวจผลไม่ได้' } } });
    await route.fallback();
  });
  await page.locator('[data-action-review="proposal-A"]').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'ยกเลิกข้อเสนอ', exact: true }).click();
  await dialog.getByRole('button', { name: 'ยืนยันยกเลิกข้อเสนอ', exact: true }).click();
  await expect(dialog.locator('.error-banner')).toContainText('ยังยืนยันผลการยกเลิกไม่ได้');
  await expect(dialog.getByRole('button', { name: 'สร้าง Dashboard', exact: true })).toBeDisabled();
  expect(harness.actions[0]).toEqual(harness.original);
  await page.keyboard.press('Escape');
  await page.locator('[data-action-review="proposal-A"]').click();
  await dialog.getByRole('button', { name: 'ยกเลิกข้อเสนอ', exact: true }).click();
  await dialog.getByRole('button', { name: 'ยืนยันยกเลิกข้อเสนอ', exact: true }).click();
  await expect(dialog).toContainText('ยกเลิกแล้ว');
  expect(cancelAttempts).toBe(2);
  expect(harness.effects).toBe(0); expect(harness.confirms).toEqual([]); expect(harness.chats).toBe(0);
});
