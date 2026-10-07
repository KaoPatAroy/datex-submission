import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import type { Dashboard, Evidence, TurnResponse, Workspace } from '../../lib/contracts';

type DashboardRead = { dashboard: Dashboard; evidence: Evidence; analysisStale: boolean };
type RenderedClaim = { text: string; sourceIds: string[]; sourceLabels: string[] };

const sourceDisplayNames: Record<string, string> = {
  sales: 'ยอดขายจริง',
  targets: 'เป้าหมายยอดขาย',
  inventory: 'สต็อกสินค้า',
  incidents: 'Incident',
  staffing: 'กำลังคน',
  employees: 'ข้อมูลพนักงาน',
  policies: 'นโยบายองค์กร',
  badges: 'สถานะบัตรพนักงาน',
};

function displayedClaimText(text: string) {
  const regions: Record<string, string> = { East: 'ตะวันออก', Central: 'กลาง', South: 'ใต้' };
  return text
    .replace(/\bDemo (East|Central|South) Branch (\d+)\b/g, (_match, region: string, branch: string) => `สาขา${regions[region]} ${branch}`)
    .replace(/\bDemo Employee (\d+)\b/g, (_match, employee: string) => `พนักงานสาธิต ${employee}`)
    .replace(/lost demand\s*\/\s*conversion/gi, 'ยอดขายที่สูญเสียและสัดส่วนผู้สนใจที่ซื้อจริง');
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

type StreamPayload = { type: string; turnId?: string; conversationId?: string; assistantMessageId?: string; response?: TurnResponse };
type StreamFrame = { eventName: string; payload: StreamPayload };

function streamFrames(body: string): StreamFrame[] {
  return body.split(/\r?\n\r?\n/).filter(Boolean).map((frame) => {
    const lines = frame.split(/\r?\n/);
    const eventName = lines.find((line) => line.startsWith('event: '))?.slice('event: '.length);
    const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.replace(/^data:\s?/, '')).join('\n');
    if (!eventName || !data) throw new Error('Expected a complete named SSE event with data.');
    const payload = JSON.parse(data) as StreamPayload;
    if (payload.type !== eventName) throw new Error('SSE event name does not match its payload.');
    return { eventName, payload };
  });
}

function completedTurnFromStream(body: string): TurnResponse {
  const frames = streamFrames(body);
  const started = frames[0];
  const completed = frames.at(-1);
  if (started?.eventName !== 'turn.started' || completed?.eventName !== 'turn.completed' || !completed.payload.response) {
    throw new Error('The real chat stream did not end with a canonical completed turn.');
  }
  const turn = completed.payload.response;
  if (turn.turnId !== started.payload.turnId || turn.conversationId !== started.payload.conversationId || turn.assistantMessageId !== started.payload.assistantMessageId) {
    throw new Error('The completed turn does not match the stream admission event.');
  }
  return turn;
}

type CapturedChatStream = { status: number; contentType: string; terminal?: StreamPayload; error?: string };

function completedStreamResponse(response: CapturedChatStream): TurnResponse {
  expect(response.status).toBe(200);
  expect(response.contentType).toContain('text/event-stream');
  if (response.error || response.terminal?.type !== 'turn.completed' || !response.terminal.response) {
    throw new Error(response.error ?? 'The captured stream did not contain a canonical completed turn.');
  }
  return response.terminal.response;
}

async function holdNextChatStream(page: Page) {
  const backendResponded = deferred<void>();
  const releaseResponse = deferred<void>();
  let entered = false;
  let released = false;
  let backendStatus: number | undefined;
  let backendTurn: TurnResponse | undefined;
  let backendError: string | undefined;
  const handler = async (route: import('@playwright/test').Route) => {
    if (entered) {
      await route.continue();
      return;
    }
    entered = true;
    try {
      const response = await route.fetch({ timeout: 30_000 });
      backendStatus = response.status();
      const body = await response.text();
      const contentType = (await response.headers())['content-type'] ?? '';
      if (backendStatus !== 200 || !contentType.toLowerCase().startsWith('text/event-stream')) {
        throw new Error(`Expected a successful SSE response, got ${backendStatus} ${contentType}`);
      }
      backendTurn = completedTurnFromStream(body);
      backendResponded.resolve();
      await releaseResponse.promise;
      await route.fulfill({ response, body });
    } catch (error) {
      backendError = error instanceof Error ? error.message : String(error);
      backendResponded.resolve();
      await route.abort().catch(() => undefined);
    }
  };
  await page.route('**/api/chat/stream', handler);
  return {
    backendResponded: backendResponded.promise,
    backendStatus: () => backendStatus,
    backendTurn: () => backendTurn,
    backendError: () => backendError,
    isReleased: () => released,
    release: () => { released = true; releaseResponse.resolve(); },
    dispose: async () => {
      releaseResponse.resolve();
      await page.unroute('**/api/chat/stream', handler);
    },
  };
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({ path: testInfo.outputPath(name), fullPage: true });
}

async function signIn(page: Page, profileId = 'executive') {
  // Let the isolated synthetic store finish seeding before timing the first UI assertion.
  const ready = await page.request.get('/api/session', { timeout: 60_000 });
  expect(ready.status()).toBe(401);
  await page.goto('/');
  await expect(page.getByLabel('โปรไฟล์')).toBeVisible();
  await page.getByLabel('โปรไฟล์').selectOption(profileId);
  await page.getByLabel('รหัสเข้าใช้งาน').fill('nexus-test-access');
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
  await expect(page.getByRole('region', { name: 'บทสนทนากับ DaTex', exact: true })).toBeVisible();
}

async function sendMessage(page: Page, message: string) {
  const captured = deferred<CapturedChatStream>();
  let entered = false;
  const handler = async (route: import('@playwright/test').Route) => {
    if (entered) {
      await route.continue();
      return;
    }
    entered = true;
    try {
      const response = await route.fetch({ timeout: 30_000 });
      const status = response.status();
      const headers = await response.headers();
      const contentType = headers['content-type'] ?? '';
      const body = await response.text();
      const result: CapturedChatStream = { status, contentType };
      if (contentType.toLowerCase().startsWith('text/event-stream')) result.terminal = streamFrames(body).at(-1)?.payload;
      else result.error = body.slice(0, 500);
      await route.fulfill({ response, body });
      captured.resolve(result);
    } catch (error) {
      captured.resolve({ status: 0, contentType: '', error: error instanceof Error ? error.message : String(error) });
      await route.abort().catch(() => undefined);
    }
  };
  await page.route('**/api/chat/stream', handler);
  try {
    await page.getByRole('textbox', { name: 'ข้อความถึง DaTex' }).fill(message);
    await page.getByRole('button', { name: 'ส่ง', exact: true }).click();
    const response = await captured.promise;
    await expect(page.locator('[data-message-role="user"]').last()).toHaveText(message);
    await expect(page.locator('[data-message-role="assistant"][data-delivery="waiting"]')).toHaveCount(0);
    return response;
  } finally {
    await page.unroute('**/api/chat/stream', handler);
  }
}

function category(message: Locator, label: string): Locator {
  return message.locator('details').filter({ hasText: label }).first();
}

async function renderedClaims(section: Locator): Promise<RenderedClaim[]> {
  const paragraphs = section.locator('p');
  if (await paragraphs.count()) {
    return paragraphs.evaluateAll((elements) => elements.map((element) => {
      const links = Array.from(element.parentElement?.querySelectorAll<HTMLAnchorElement>('a[href^="#source-"]') ?? []);
      return {
        text: element.textContent?.trim() ?? '',
        sourceIds: links.map((link) => decodeURIComponent((link.getAttribute('href') ?? '').slice('#source-'.length))),
        sourceLabels: links.map((link) => link.textContent?.trim() ?? ''),
      };
    }));
  }
  return section.locator('.claim').evaluateAll((elements) => elements.map((element) => {
    const links = Array.from(element.querySelectorAll<HTMLAnchorElement>('.claim-sources .source-link'));
    return {
      text: Array.from(element.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent ?? '').join('').trim(),
      sourceIds: links.map((link) => link.getAttribute('data-source-id') ?? ''),
      sourceLabels: links.map((link) => link.textContent?.trim() ?? ''),
    };
  }));
}

function conversationScroller(page: Page) {
  const region = page.getByRole('region', { name: 'บทสนทนากับ DaTex', exact: true });
  return region.locator('div').filter({ has: page.locator('[data-message-role]').last() }).first();
}

function expectedClaims(
  claims: Array<{ text: string; sourceIds: string[] }>,
  sources: Array<{ id: string; system: string }>,
  presentation: 'chat' | 'dashboard' = 'dashboard',
): RenderedClaim[] {
  return claims.map((claim) => ({
    text: displayedClaimText(claim.text),
    sourceIds: claim.sourceIds,
    sourceLabels: claim.sourceIds.map((sourceId) => {
      const sourceIndex = sources.findIndex((source) => source.id === sourceId);
      expect(sourceIndex, `backend source ${sourceId} should be present in the same evidence response`).toBeGreaterThanOrEqual(0);
      const label = sourceDisplayNames[sources[sourceIndex].system] ?? sources[sourceIndex].system;
      return presentation === 'chat' ? label : `แหล่ง ${sourceIndex + 1} · ${label}`;
    }),
  }));
}

async function attachJson(testInfo: TestInfo, name: string, value: unknown) {
  await testInfo.attach(name, {
    body: JSON.stringify(value, null, 2),
    contentType: 'application/json',
  });
}

test('real scripted evidence starts with four facts and expands to twelve without changing order or citations', async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  try {
    await signIn(page); // Live AI (default): the router plans the typed request through the scripted planner.

    const response = await sendMessage(page, 'Compare sales across all regions on 2026-10-01.');
    expect(response.status).toBe(200);
    const turn = completedStreamResponse(response);
    const facts = turn.analysis?.facts ?? [];
    expect(turn.analysis).toBeTruthy();
    expect(turn.sources?.length).toBeGreaterThan(0);
    expect(facts).toHaveLength(12);

    const evidence = { sources: turn.sources ?? [] };
    const assistant = page.locator('[data-message-role="assistant"][data-delivery="complete"]').last();
    const factsSection = category(assistant, 'ข้อเท็จจริง');
    await expect(factsSection.locator('p')).toHaveCount(4);
    const expected = expectedClaims(facts, evidence.sources, 'chat');
    expect(await renderedClaims(factsSection)).toEqual(expected.slice(0, 4));
    const expand = factsSection.getByRole('button');
    await expect(expand).toHaveAttribute('aria-expanded', 'false');
    await expect(expand).toHaveText(`ดูทั้งหมด ${facts.length} รายการ`);
    await capture(page, testInfo, 'desktop-facts-initial.png');

    await expand.click();
    await expect(factsSection.locator('p')).toHaveCount(facts.length);
    await expect(expand).toHaveAttribute('aria-expanded', 'true');
    await expect(expand).toHaveText('แสดงน้อยลง');
    expect(await renderedClaims(factsSection)).toEqual(expected);
    await capture(page, testInfo, 'desktop-facts-expanded.png');

    await expand.click();
    await expect(factsSection.locator('p')).toHaveCount(4);
    await expect(expand).toHaveAttribute('aria-expanded', 'false');
    await expect(expand).toHaveText(`ดูทั้งหมด ${facts.length} รายการ`);
    expect(await renderedClaims(factsSection)).toEqual(expected.slice(0, 4));
    await capture(page, testInfo, 'desktop-facts-after-collapse.png');

    await attachJson(testInfo, 'actual-chat-evidence.json', {
      endpoint: '/api/chat/stream',
      status: response.status,
      factCount: facts.length,
      facts: facts.map(({ text, sourceIds }) => ({ text, sourceIds })),
      sourceCount: evidence.sources.length,
    });

    const prepare = await sendMessage(page, 'Create dashboard.');
    expect(prepare.status).toBe(200);
    const preparedTurn = completedStreamResponse(prepare);
    // A private dashboard is a reversible owner-only draft: created directly, the same turn carries the verified receipt.
    expect(preparedTurn.pendingAction?.payload.kind).toBe('dashboard_create');
    const preparedAction = preparedTurn.pendingAction;
    if (!preparedAction || preparedAction.payload.kind !== 'dashboard_create') throw new Error('Expected the exact newly created dashboard action');
    expect(preparedAction.status).toBe('completed');
    const readbackResponse = await page.request.get('/api/workspace');
    expect(readbackResponse.status()).toBe(200);
    const readback = await readbackResponse.json() as Workspace;
    const receipt = readback.receipts.find(item => item.actionId === preparedAction.id);
    expect(receipt?.status).toBe('verified_success');
    if (!receipt || receipt.visibility === 'restricted' || !receipt.dashboardId) throw new Error('Expected a verified receipt identifying the created dashboard');
    const dashboardId = receipt.dashboardId;
    expect(readback.dashboards.find(item => item.id === dashboardId)).toMatchObject({ spec: { title: preparedAction.payload.spec.title } });
    await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
    const openDashboard = page.getByRole('button', { name: preparedAction.payload.spec.title, exact: true });
    const detailResponsePromise = page.waitForResponse((candidate) =>
      new URL(candidate.url()).pathname === `/api/dashboards/${encodeURIComponent(dashboardId)}` && candidate.request().method() === 'GET',
    );
    await openDashboard.click();
    const detailResponse = await detailResponsePromise;
    expect(detailResponse.status()).toBe(200);
    const detail = await detailResponse.json() as DashboardRead;
    expect(detail.dashboard.id).toBe(dashboardId);
    expect(detail.dashboard.spec.title).toBe(preparedAction.payload.spec.title);
    await expect(page.getByRole('heading', { name: detail.dashboard.spec.title, exact: true })).toBeVisible();
    const summaryWidget = detail.dashboard.spec.widgets.find((widget) => widget.type === 'text_summary');
    expect(summaryWidget).toBeTruthy();
    const dashboardFacts = detail.dashboard.analysis?.facts ?? [];
    expect(dashboardFacts).toHaveLength(facts.length);
    const summaryPanel = page.locator('section.panel').filter({ hasText: summaryWidget!.title }).last();
    const dashboardFactSection = summaryPanel.locator('.claim-list');
    await expect(dashboardFactSection.locator('.claim')).toHaveCount(4);
    const dashboardExpected = expectedClaims(dashboardFacts, detail.evidence.sources);
    expect(await renderedClaims(dashboardFactSection)).toEqual(dashboardExpected.slice(0, 4));
    const dashboardExpand = dashboardFactSection.getByRole('button');
    await expect(dashboardExpand).toHaveText(`ดูทั้งหมด ${dashboardFacts.length} รายการ`);
    await dashboardExpand.click();
    await expect(dashboardFactSection.locator('.claim')).toHaveCount(dashboardFacts.length);
    expect(await renderedClaims(dashboardFactSection)).toEqual(dashboardExpected);
    await capture(page, testInfo, 'desktop-dashboard-facts-expanded.png');
    await dashboardExpand.click();
    await expect(dashboardFactSection.locator('.claim')).toHaveCount(4);
    expect(await renderedClaims(dashboardFactSection)).toEqual(dashboardExpected.slice(0, 4));

    const chartWidget = detail.dashboard.spec.widgets.find((widget) => widget.type === 'bar_chart' || widget.type === 'line_chart');
    expect(chartWidget).toBeTruthy();
    expect(detail.evidence.branches).toHaveLength(12);
    const chartViewport = page.getByRole('region', { name: `${chartWidget!.title} เลื่อนแนวนอนเพื่อดูทุกสาขา` });
    const chartPanel = chartViewport.locator('..').locator('..');
    const chartCue = chartPanel.getByText(`เลื่อนซ้าย–ขวาเพื่อดูครบ ${detail.evidence.branches.length} สาขา`, { exact: true });
    await expect(chartViewport).toHaveCount(1);
    const chartControls = chartPanel.getByRole('group', { name: `เลื่อนกราฟ ${chartWidget!.title}` });
    const scrollLeft = chartControls.getByRole('button', { name: /เลื่อนซ้าย/ });
    const scrollRight = chartControls.getByRole('button', { name: /เลื่อนขวา/ });
    await expect(chartViewport).toBeVisible();
    await expect(chartCue).toBeVisible();
    await expect(chartViewport).toHaveAttribute('aria-describedby', /.+/);
    await expect(scrollLeft).toBeDisabled();
    await expect(scrollRight).toBeEnabled();
    await chartCue.scrollIntoViewIfNeeded();
    await capture(page, testInfo, 'desktop-dashboard-chart-scroll-cue.png');

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(chartCue).toBeVisible();
    await expect(scrollLeft).toBeDisabled();
    await expect(scrollRight).toBeEnabled();
    await chartCue.scrollIntoViewIfNeeded();
    await capture(page, testInfo, 'mobile-390-dashboard-chart-scroll-cue.png');
    await page.screenshot({ path: testInfo.outputPath('mobile-390-chart-viewport.png'), fullPage: false });

    await page.emulateMedia({ reducedMotion: 'reduce' });
    const chartData = chartPanel.locator('details.chart-data');
    await chartData.locator('summary').click();
    const chartRows = chartData.locator('tbody tr');
    await expect(chartRows).toHaveCount(detail.evidence.branches.length);
    const rowsBeforeScroll = await chartRows.allTextContents();
    expect(await chartRows.locator('td:first-child').allTextContents()).toEqual(detail.evidence.branches.map((branch) => displayedClaimText(branch.branchName)));

    let rightClicks = 0;
    while (await scrollRight.isEnabled() && rightClicks < 20) {
      const before = await chartViewport.evaluate((viewport) => viewport.scrollLeft);
      await scrollRight.click();
      await expect.poll(() => chartViewport.evaluate((viewport) => viewport.scrollLeft)).toBeGreaterThan(before);
      if (rightClicks === 0) await page.screenshot({ path: testInfo.outputPath('mobile-390-chart-controls-in-use.png'), fullPage: false });
      rightClicks += 1;
    }
    expect(rightClicks).toBeGreaterThan(1);
    await expect(scrollRight).toBeDisabled();
    await expect.poll(() => chartViewport.evaluate((viewport) => viewport.scrollLeft + viewport.clientWidth >= viewport.scrollWidth - 1)).toBe(true);

    let leftClicks = 0;
    while (await scrollLeft.isEnabled() && leftClicks < 20) {
      const before = await chartViewport.evaluate((viewport) => viewport.scrollLeft);
      await scrollLeft.click();
      await expect.poll(() => chartViewport.evaluate((viewport) => viewport.scrollLeft)).toBeLessThan(before);
      leftClicks += 1;
    }
    expect(leftClicks).toBeGreaterThan(1);
    await expect(scrollLeft).toBeDisabled();
    await expect.poll(() => chartViewport.evaluate((viewport) => viewport.scrollLeft)).toBeLessThanOrEqual(1);
    await expect(chartRows).toHaveCount(12);
    expect(await chartRows.allTextContents()).toEqual(rowsBeforeScroll);
    await page.setViewportSize({ width: 1440, height: 1000 });

    const tableWidget = detail.dashboard.spec.widgets.find((widget) => widget.type === 'table' && widget.dataset === 'branch_metrics');
    expect(tableWidget).toBeTruthy();
    const tablePanel = page.locator('section.panel').filter({ hasText: tableWidget!.title }).last();
    await expect(tablePanel.locator('details.technical-detail')).toHaveCount(0);
    expect(await tablePanel.innerText()).not.toContain(detail.evidence.version);
    await capture(page, testInfo, 'desktop-table-full-evidence-details.png');
    await attachJson(testInfo, 'actual-dashboard-evidence.json', {
      endpoint: `/api/dashboards/${detail.dashboard.id}`,
      status: detailResponse.status(),
      evidenceVersion: detail.evidence.version,
      asOf: detail.evidence.asOf,
      sourceCount: detail.evidence.sources.length,
    });
  } finally {
    await context.close();
  }
});

test('chat keeps one waiting assistant until the real response resolves, then reveals completed evidence and action controls', async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  let activeGate: Awaited<ReturnType<typeof holdNextChatStream>> | undefined;
  try {
    await signIn(page);
    await page.getByRole('button', { name: 'บทสนทนาใหม่', exact: true }).click();

    const message = 'Compare sales across all regions on 2026-10-01.';
    activeGate = await holdNextChatStream(page);
    const evidenceResponsePromise = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/chat/stream' && response.request().method() === 'POST',
    );
    await page.getByRole('textbox', { name: 'ข้อความถึง DaTex' }).fill(message);
    await page.getByRole('button', { name: 'ส่ง', exact: true }).click();
    await activeGate.backendResponded;
    expect(activeGate.backendStatus()).toBe(200);
    expect(activeGate.backendError()).toBeUndefined();
    expect(activeGate.isReleased()).toBe(false);
    const evidenceTurn = activeGate.backendTurn();
    if (!evidenceTurn) throw new Error('The real SSE response has no canonical completed turn.');

    const waitingUser = page.locator('[data-message-role="user"]');
    const waitingAssistant = page.locator('[data-message-role="assistant"][data-delivery="waiting"]');
    await expect(waitingUser).toHaveCount(1);
    await expect(page.locator('[data-message-role="assistant"]')).toHaveCount(1);
    await expect(waitingAssistant).toHaveCount(1);
    await expect(waitingUser.last()).toHaveText(message);
    await expect(waitingAssistant.getByRole('link')).toHaveCount(0);
    await expect(waitingAssistant.getByRole('button', { name: 'รายละเอียดแหล่งข้อมูล' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'ตรวจและยืนยัน', exact: true })).toHaveCount(0);

    activeGate.release();
    const evidenceResponse = await evidenceResponsePromise;
    expect(evidenceResponse.status()).toBe(200);
    expect(evidenceTurn.sources?.length).toBeGreaterThan(0);
    expect(evidenceTurn.analysis).toBeTruthy();
    const userMessage = page.locator(`[data-message-role="user"][data-turn-id="${evidenceTurn.turnId}"]`);
    const assistantMessage = page.locator(`[data-message-role="assistant"][data-delivery="complete"][data-turn-id="${evidenceTurn.turnId}"]`);
    await expect(userMessage).toHaveText(message);
    await expect(assistantMessage).toBeVisible();
    await expect(page.locator('[data-delivery="waiting"]')).toHaveCount(0);

    const sourceId = evidenceTurn.analysis!.facts.slice(0, 4).flatMap((fact) => fact.sourceIds)[0];
    if (!sourceId) throw new Error('Expected a visible claim to cite a source.');
    const source = evidenceTurn.sources!.find((entry) => entry.id === sourceId);
    expect(source).toBeTruthy();
    const sourceName = sourceDisplayNames[source!.system] ?? source!.system;
    const sourceLink = assistantMessage.locator(`a[href="#source-${encodeURIComponent(sourceId)}"]`).first();
    await expect(sourceLink).toHaveText(sourceName);
    await expect(assistantMessage.getByRole('button', { name: 'รายละเอียดแหล่งข้อมูล' })).toBeVisible();
    await sourceLink.click();
    const sourceDialog = page.getByRole('complementary', { name: /คำตอบที่เลือก/ });
    await expect(sourceDialog).toBeVisible();
    const selectedSource = sourceDialog.locator(`[id="source-${encodeURIComponent(sourceId)}"]`);
    await expect(selectedSource).toBeVisible();
    await expect(selectedSource.locator(':scope > summary')).toContainText(sourceName);
    await expect(selectedSource).toContainText(sourceId);
    await expect(selectedSource.locator(':scope > summary')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(sourceDialog).toBeHidden();
    await expect(sourceLink).toBeFocused();

    await activeGate.dispose();
    activeGate = undefined;
    const actionGate = await holdNextChatStream(page);
    activeGate = actionGate;
    const actionResponsePromise = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/chat/stream' && response.request().method() === 'POST',
    );
    await page.getByRole('textbox', { name: 'ข้อความถึง DaTex' }).fill('Create dashboard.');
    await page.getByRole('button', { name: 'ส่ง', exact: true }).click();
    await actionGate.backendResponded;
    expect(actionGate.backendStatus()).toBe(200);
    expect(actionGate.backendError()).toBeUndefined();
    const actionTurn = actionGate.backendTurn();
    if (!actionTurn) throw new Error('The real action stream has no canonical completed turn.');
    const waitingActionAssistant = page.locator('[data-message-role="assistant"][data-delivery="waiting"]');
    await expect(waitingActionAssistant).toHaveCount(1);
    await expect(waitingActionAssistant.getByRole('button', { name: 'ตรวจและยืนยัน', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'ตรวจและยืนยัน', exact: true })).toHaveCount(0);

    actionGate.release();
    const actionResponse = await actionResponsePromise;
    expect(actionResponse.status()).toBe(200);
    expect(actionTurn.pendingAction?.payload.kind).toBe('dashboard_create');
    const completedActionAssistant = page.locator(`[data-message-role="assistant"][data-delivery="complete"][data-turn-id="${actionTurn.turnId}"]`);
    // Private dashboard creation is direct: the completed answer reports it and offers no confirmation control.
    expect(actionTurn.pendingAction?.status).toBe('completed');
    await expect(completedActionAssistant).toContainText(actionTurn.pendingAction!.payload.kind === 'dashboard_create' ? actionTurn.pendingAction!.payload.spec.title : '');
    await expect(completedActionAssistant.getByRole('button', { name: 'ตรวจและยืนยัน', exact: true })).toHaveCount(0);
  } finally {
    if (activeGate) await activeGate.dispose();
    await context.close();
  }
});

test('conversation presents completed conclusions and preserves a manually scrolled position', async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  let activeGate: Awaited<ReturnType<typeof holdNextChatStream>> | undefined;
  try {
    await signIn(page);
    await page.getByRole('button', { name: 'บทสนทนาใหม่', exact: true }).click();
    for (const message of [
      'Compare sales across all regions on 2026-10-01.',
      'Show East sales totals for 2026-10-01.',
      'Compare sales across all regions on 2026-10-01.',
    ]) {
      const response = await sendMessage(page, message);
      expect(response.status).toBe(200);
    }

    const scroller = conversationScroller(page);
    const distanceFromBottom = () => scroller.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight);
    expect(await scroller.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(80);

    activeGate = await holdNextChatStream(page);
    const nearBottomResponsePromise = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/chat/stream' && response.request().method() === 'POST',
    );
    await page.getByRole('textbox', { name: 'ข้อความถึง DaTex' }).fill('Show East sales totals for 2026-10-01.');
    await page.getByRole('button', { name: 'ส่ง', exact: true }).click();
    await activeGate.backendResponded;
    expect(activeGate.backendStatus()).toBe(200);
    expect(activeGate.backendError()).toBeUndefined();
    const nearBottomTurn = activeGate.backendTurn();
    if (!nearBottomTurn) throw new Error('The real near-bottom stream has no canonical completed turn.');
    await scroller.evaluate((element) => { element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 40); });
    await expect.poll(distanceFromBottom).toBeLessThan(80);
    await expect(page.getByRole('button', { name: 'ไปข้อความล่าสุด', exact: true })).toBeHidden();
    activeGate.release();
    const nearBottomResponse = await nearBottomResponsePromise;
    expect(nearBottomResponse.status()).toBe(200);
    await expect(page.locator(`[data-message-role="assistant"][data-delivery="complete"][data-turn-id="${nearBottomTurn.turnId}"]`)).toBeVisible();
    await expect(page.locator(`[data-message-role="assistant"][data-turn-id="${nearBottomTurn.turnId}"]`).getByText('ยอดขายสุทธิ', { exact: true })).toBeInViewport();

    await activeGate.dispose();
    activeGate = undefined;
    const readingGate = await holdNextChatStream(page);
    activeGate = readingGate;
    const readingResponsePromise = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/chat/stream' && response.request().method() === 'POST',
    );
    await page.getByRole('textbox', { name: 'ข้อความถึง DaTex' }).fill('Compare sales across all regions on 2026-10-01.');
    await page.getByRole('button', { name: 'ส่ง', exact: true }).click();
    await readingGate.backendResponded;
    expect(readingGate.backendStatus()).toBe(200);
    expect(readingGate.backendError()).toBeUndefined();
    const readingTurn = readingGate.backendTurn();
    if (!readingTurn) throw new Error('The real reading-position stream has no canonical completed turn.');
    await scroller.evaluate((element) => { element.scrollTop = 0; });
    await expect.poll(distanceFromBottom).toBeGreaterThan(80);
    await expect(page.getByRole('button', { name: 'ไปข้อความล่าสุด', exact: true })).toBeVisible();
    readingGate.release();
    const readingResponse = await readingResponsePromise;
    expect(readingResponse.status()).toBe(200);
    await expect(page.locator(`[data-message-role="assistant"][data-delivery="complete"][data-turn-id="${readingTurn.turnId}"]`)).toBeVisible();
    await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(0);
    await expect.poll(distanceFromBottom).toBeGreaterThan(80);
    await expect(page.getByRole('button', { name: 'ไปข้อความล่าสุด', exact: true })).toBeVisible();
  } finally {
    if (activeGate) await activeGate.dispose();
    await context.close();
  }
});

test('signed-in workspace remains a loading state while the actual workspace GET response is pending', async ({ browser }, testInfo) => {
  test.setTimeout(45_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const fetched = deferred<void>();
  const release = deferred<void>();
  const settled = deferred<void>();
  let entered = false;
  let workspaceStatus: number | undefined;
  await page.route('**/api/workspace', async (route) => {
    if (entered) {
      await route.continue();
      return;
    }
    entered = true;
    try {
      const response = await route.fetch();
      workspaceStatus = response.status();
      fetched.resolve();
      await release.promise;
      await route.fulfill({ response });
    } finally {
      settled.resolve();
    }
  });
  try {
    await page.goto('/');
    await page.getByLabel('โปรไฟล์').selectOption('executive');
    await page.getByLabel('รหัสเข้าใช้งาน').fill('nexus-test-access');
    await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
    await expect.poll(() => workspaceStatus, { timeout: 10_000 }).toBe(200);
    await fetched.promise;
    await expect(page.getByRole('status').getByRole('heading', { name: 'กำลังโหลดพื้นที่ทำงาน' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'เข้าสู่ระบบแล้ว แต่เปิดพื้นที่ทำงานไม่ได้' })).toHaveCount(0);
    await capture(page, testInfo, 'desktop-authenticated-workspace-pending.png');
    await attachJson(testInfo, 'pending-workspace-read.json', {
      endpoint: '/api/workspace',
      backendStatus: workspaceStatus,
      responseReleasedToBrowser: false,
      visibleState: 'authenticated-loading',
    });
  } finally {
    release.resolve();
    if (entered) await settled.promise;
    await context.close();
  }
});

test('workspace read timeout offers a manual GET retry without another LOGIN, CHAT, or CONFIRM post', async ({ browser }, testInfo) => {
  test.setTimeout(60_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await page.clock.install({ time: new Date() });
  const fetched = deferred<void>();
  const release = deferred<void>();
  const settled = deferred<void>();
  let firstRoute = true;
  let firstWorkspaceStatus: number | undefined;
  let workspaceGets = 0;
  const posts = { login: 0, chat: 0, confirm: 0 };
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/workspace' && request.method() === 'GET') workspaceGets += 1;
    if (request.method() !== 'POST') return;
    if (pathname === '/api/session') posts.login += 1;
    if (pathname === '/api/chat' || pathname === '/api/chat/stream') posts.chat += 1;
    if (/^\/api\/actions\/[^/]+\/confirm$/.test(pathname)) posts.confirm += 1;
  });
  await page.route('**/api/workspace', async (route) => {
    if (!firstRoute) {
      await route.continue();
      return;
    }
    firstRoute = false;
    try {
      const response = await route.fetch();
      firstWorkspaceStatus = response.status();
      fetched.resolve();
      await release.promise;
      await route.fulfill({ response });
    } catch {
      // The page's 30-second AbortController may already have canceled this held browser request.
    } finally {
      settled.resolve();
    }
  });
  try {
    await page.goto('/');
    await page.getByLabel('โปรไฟล์').selectOption('executive');
    await page.getByLabel('รหัสเข้าใช้งาน').fill('nexus-test-access');
    await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
    await expect.poll(() => firstWorkspaceStatus, { timeout: 10_000 }).toBe(200);
    await fetched.promise;
    await expect(page.getByRole('status').getByRole('heading', { name: 'กำลังโหลดพื้นที่ทำงาน' })).toBeVisible();

    await page.clock.fastForward(30_001);
    await expect(page.getByRole('heading', { name: 'เข้าสู่ระบบแล้ว แต่เปิดพื้นที่ทำงานไม่ได้' })).toBeVisible();
    await expect(page.getByText('หมดเวลารอข้อมูลเริ่มต้น กรุณาตรวจการเชื่อมต่อแล้วตรวจสอบสถานะอีกครั้ง', { exact: true })).toBeVisible();
    await capture(page, testInfo, 'desktop-workspace-timeout-recovery.png');

    release.resolve();
    await settled.promise;
    const retryResponsePromise = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/workspace' && response.request().method() === 'GET',
    );
    await page.getByRole('button', { name: 'โหลดพื้นที่ทำงานอีกครั้ง' }).click();
    const retryResponse = await retryResponsePromise;
    expect(retryResponse.status()).toBe(200);
    await expect(page.getByRole('region', { name: 'บทสนทนากับ DaTex', exact: true })).toBeVisible();
    expect(workspaceGets).toBe(2);
    expect(posts).toEqual({ login: 1, chat: 0, confirm: 0 });
    await capture(page, testInfo, 'desktop-workspace-after-manual-read-retry.png');
    await attachJson(testInfo, 'workspace-read-recovery.json', {
      endpoint: '/api/workspace',
      firstBackendStatus: firstWorkspaceStatus,
      retryStatus: retryResponse.status(),
      workspaceGets,
      posts,
      recoveryAction: 'manual GET retry',
    });
  } finally {
    release.resolve();
    if (!firstRoute) await settled.promise;
    await context.close();
  }
});

test('workspace fits desktop, 390px, and 320px; mobile sessions dialog opens and starts a new conversation', async ({ browser }, testInfo) => {
  test.setTimeout(60_000);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    await signIn(page, 'executive');
    // The private dashboard is created directly; sharing it is a confirm-tier proposal that stays pending in the approvals queue.
    const created = await sendMessage(page, 'Create dashboard.');
    expect(created.status).toBe(200);
    expect(completedStreamResponse(created).pendingAction?.status).toBe('completed');
    const prepare = await sendMessage(page, 'Share dashboard with East manager.');
    expect(prepare.status).toBe(200);
    const turn = completedStreamResponse(prepare);
    expect(turn.pendingAction?.payload.kind).toBe('dashboard_share');

    const workspace = await page.evaluate(async () => {
      const response = await fetch('/api/workspace');
      return { status: response.status, body: await response.json() };
    });
    expect(workspace.status).toBe(200);
    const pendingActions = workspace.body.actions.filter((action: { status: string; actorId: string; sessionId: string }) =>
      action.status === 'pending' && action.actorId === workspace.body.actor.id && action.sessionId === workspace.body.actor.sessionId,
    );
    expect(pendingActions.some((action: { id: string }) => action.id === turn.pendingAction?.id)).toBe(true);
    const pendingCount = pendingActions.length;
    expect(pendingCount).toBeGreaterThan(0);
    expect(workspace.body.dashboards.length).toBeGreaterThan(0);

    const actionsNav = page.getByRole('button', { name: 'งานและการอนุมัติ', exact: true });
    await actionsNav.click();
    await expect(actionsNav).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { name: 'งานและการอนุมัติ', exact: true })).toBeVisible();
    const reviewButtonCount = await page.getByRole('button', { name: 'ตรวจและยืนยัน', exact: true }).count();
    expect(reviewButtonCount).toBe(pendingCount);

    const viewportWidths = [1440, 390, 320] as const;
    const layouts: Array<{ width: number; documentWidth: number }> = [];
    for (const width of viewportWidths) {
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
      const layout = await page.evaluate(() => ({ width: window.innerWidth, documentWidth: document.documentElement.scrollWidth }));
      expect(layout.width).toBe(width);
      expect(layout.documentWidth, `${width}px document width`).toBeLessThanOrEqual(layout.width + 1);
      layouts.push(layout);
      await capture(page, testInfo, `workspace-no-overflow-${width}px.png`);
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'แชต', exact: true }).click();
    const chatLayouts: Array<{ width: number; documentWidth: number }> = [];
    for (const width of viewportWidths) {
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
      const layout = await page.evaluate(() => ({ width: window.innerWidth, documentWidth: document.documentElement.scrollWidth }));
      expect(layout.width).toBe(width);
      expect(layout.documentWidth, `${width}px chat width`).toBeLessThanOrEqual(layout.width + 1);
      chatLayouts.push(layout);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'เปิดบทสนทนา', exact: true }).click();
    const sessionsDialog = page.getByRole('dialog', { name: 'บทสนทนา', exact: true });
    await expect(sessionsDialog).toBeVisible();
    await expect(sessionsDialog.getByRole('searchbox', { name: 'ค้นหาบทสนทนา' })).toBeVisible();
    const persistedConversation = sessionsDialog.locator(`[data-conversation-id="${turn.conversationId}"]`);
    await expect(persistedConversation).toBeVisible();
    await expect(persistedConversation.getByRole('button').first()).toHaveAttribute('aria-current', 'page');
    const dialogBounds: Array<{ width: number; left: number; right: number }> = [];
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      const bounds = await sessionsDialog.evaluate((dialog) => {
        const rect = dialog.getBoundingClientRect();
        return { width: window.innerWidth, left: rect.left, right: rect.right };
      });
      expect(bounds.width).toBe(width);
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(width + 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
      dialogBounds.push(bounds);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await sessionsDialog.getByRole('button', { name: 'บทสนทนาใหม่', exact: true }).click();
    await expect(sessionsDialog).toBeHidden();
    await expect(page.getByRole('heading', { name: 'บทสนทนาใหม่', exact: true })).toBeVisible();

    await attachJson(testInfo, 'mobile-navigation-counts.json', {
      endpoint: '/api/workspace',
      status: workspace.status,
      dashboardCount: workspace.body.dashboards.length,
      pendingActionCount: pendingCount,
      visibleReviewActions: reviewButtonCount,
      viewportWidths,
      layouts,
      chatLayouts,
      dialogBounds,
      mobileSessionsDialogClosedAfterNewConversation: await sessionsDialog.isHidden(),
    });
  } finally {
    await context.close();
  }
});
