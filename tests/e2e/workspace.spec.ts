import { expect, test } from '@playwright/test';

const viewports = [
  { name: 'desktop', size: { width: 1440, height: 1000 } },
  { name: 'mobile', size: { width: 390, height: 844 } },
] as const;

const roles = [
  { id: 'executive', role: 'executive', prompt: 'Compare sales across all regions on 2026-10-01.' },
  { id: 'east', role: 'east_manager', prompt: 'Compare sales across all regions on 2026-10-01.' },
  { id: 'hr', role: 'hr_admin', prompt: 'Show East sales totals for 2026-10-01.' },
] as const;

async function capture(page: import('@playwright/test').Page, testInfo: import('@playwright/test').TestInfo, role: string, viewport: string, state: string) {
  await page.screenshot({
    path: testInfo.outputPath(`${role}-${viewport}-${state}.png`),
    fullPage: true,
  });
}

type WorkspaceStreamResponse = { message?: string; analysis?: unknown; sources?: unknown[]; pendingAction?: { id: string; status?: string; payload?: { kind?: string } } };
type WorkspaceStreamTerminal = { type: string; code?: string; outcome?: string; response?: WorkspaceStreamResponse };
type CapturedChatStream = { status: number; contentType: string; terminal?: WorkspaceStreamTerminal; error?: string };

function preparedActionId(stream: CapturedChatStream) {
  const id = stream.terminal?.response?.pendingAction?.id;
  if (!id) throw new Error('Expected the exact newly prepared action.');
  return id;
}

async function expectVerifiedAction(page: import('@playwright/test').Page, actionId: string) {
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'กำลังยืนยัน', exact: true })).toHaveCount(0);
  // A confirmed proposal leaves the approvals queue, announces the verified outcome, and is recorded in history.
  await expect(page.locator(`[data-action-id="${actionId}"]`)).toHaveCount(0);
  await expect(page.locator('.success-banner')).toContainText('สำเร็จแล้ว');
  expect(await page.locator('#main-content').innerText()).not.toMatch(/execution_action_|effect_|\/dashboards\//);
  await page.getByRole('button', { name: 'ประวัติการทำงาน', exact: true }).click();
  const record = page.locator(`article[data-history-action="${actionId}"]`);
  await expect(record).toBeVisible();
  await expect(record).toContainText('สำเร็จ');
  return record;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function terminalEvent(body: string): WorkspaceStreamTerminal {
  const events = body.split(/\r?\n\r?\n/).filter(Boolean).map((frame) => {
    const lines = frame.split(/\r?\n/);
    const eventName = lines.find((line) => line.startsWith('event: '))?.slice('event: '.length);
    const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.replace(/^data:\s?/, '')).join('\n');
    if (!eventName || !data) throw new Error('Expected a named SSE event with data.');
    const payload = JSON.parse(data) as WorkspaceStreamTerminal;
    if (payload.type !== eventName) throw new Error('SSE event name does not match its payload.');
    return payload;
  });
  const terminal = events.at(-1);
  if (!terminal || !['turn.completed', 'turn.failed'].includes(terminal.type)) {
    throw new Error('The chat stream did not end with a terminal event.');
  }
  return terminal;
}

async function sendMessage(page: import('@playwright/test').Page, message: string) {
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
      const contentType = (await response.headers())['content-type'] ?? '';
      const body = await response.text();
      const result: CapturedChatStream = { status, contentType };
      if (contentType.toLowerCase().startsWith('text/event-stream')) result.terminal = terminalEvent(body);
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

function terminalChatStream(response: CapturedChatStream) {
  expect(response.status).toBe(200);
  expect(response.contentType).toContain('text/event-stream');
  if (response.error || !response.terminal) throw new Error(response.error ?? 'The stream has no terminal event.');
  return response.terminal;
}

for (const role of roles) {
  for (const viewport of viewports) {
    test(`${role.id} ${viewport.name}: sign in and exercise the scoped workspace`, async ({ browser }, testInfo) => {
      test.setTimeout(120_000);
      const context = await browser.newContext({ viewport: viewport.size });
      const page = await context.newPage();
      try {
        const ready = await page.request.get('/api/session', { timeout: 60_000 });
        expect(ready.status()).toBe(401);
        await page.goto('/');
        await expect(page.getByLabel('โปรไฟล์')).toBeVisible();
        await capture(page, testInfo, role.id, viewport.name, 'login');

        await page.getByLabel('โปรไฟล์').selectOption(role.id);
        await page.getByLabel('รหัสเข้าใช้งาน').fill('nexus-test-access');
        await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();

        await expect(page.getByRole('region', { name: 'บทสนทนากับ DaTex', exact: true })).toBeVisible();
        const modeSwitch = page.getByRole('switch', { name: 'เปลี่ยนโหมดการทำงาน' });
        await expect(modeSwitch).toBeVisible();
        await expect(modeSwitch).toBeChecked();
        await modeSwitch.click();
        await expect(modeSwitch).not.toBeChecked();
        const workspaceStatus = page.locator('[aria-label="สถานะพื้นที่ทำงาน"]');
        await expect(workspaceStatus).toBeVisible();
        await expect(workspaceStatus).toContainText('ข้อมูลจำลองสำหรับสาธิต · อ่านเฉพาะข้อมูลที่คุณมีสิทธิ์เห็น');
        await expect(page.getByRole('textbox', { name: 'ข้อความถึง DaTex' })).toBeVisible();

        const readWorkspace = () => page.evaluate(async () => {
          const response = await fetch('/api/workspace');
          return { status: response.status, body: await response.json() };
        });
        const before = await readWorkspace();
        expect(before.status).toBe(200);
        expect(before.body.actor.role).toBe(role.role);
        expect(before.body.actor.mode).toBe('scripted_demo');
        await capture(page, testInfo, role.id, viewport.name, 'workspace-scripted-demo');

        const csrf = await page.evaluate(async () => {
          const response = await fetch('/api/session');
          return (await response.json()).csrfToken as string;
        });
        const forgedMode = await page.evaluate(async (csrfToken) => {
          const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
            body: JSON.stringify({ message: 'Compare sales across all regions on 2026-10-01.', mode: 'live_ai' }),
          });
          return { status: response.status, body: await response.json() };
        }, csrf);
        expect(forgedMode.status).toBe(400);
        expect(forgedMode.body.error.code).toBe('INVALID_INPUT');
        expect((await readWorkspace()).body.messages).toHaveLength(before.body.messages.length);

        if (role.id === 'east') expect(before.body.actor.regions).toEqual(['east']);
        if (role.id === 'hr') {
          const allowedTitles = before.body.capabilities.filter((capability: { allowed: boolean }) => capability.allowed)
            .map((capability: { title: string }) => capability.title.toLowerCase());
          expect(allowedTitles.join(' ')).not.toContain('sales');
        }

        // Typed text is only interpreted by the router in Live AI; return to it for the scoped chat turns below.
        await modeSwitch.click();
        await expect(modeSwitch).toBeChecked();
        await expect.poll(async () => (await readWorkspace()).body.actor.mode).toBe('live_ai');
        const beforeChat = await readWorkspace();

        const streamRequestKeys: string[] = [];
        const recoveryRequestKeys: string[] = [];
        if (role.id === 'hr' && viewport.name === 'desktop') {
          page.on('request', (request) => {
            if (request.method() !== 'POST') return;
            const payload = request.postDataJSON() as { requestKey?: string };
            const pathname = new URL(request.url()).pathname;
            if (pathname === '/api/chat/stream' && payload.requestKey) streamRequestKeys.push(payload.requestKey);
            if (pathname === '/api/chat/recovery' && payload.requestKey) recoveryRequestKeys.push(payload.requestKey);
          });
        }

        const chatResponse = await sendMessage(page, role.prompt);
        const chatTerminal = await terminalChatStream(chatResponse);
        if (role.id === 'hr') {
          // A permission refusal is a completed, known outcome: truthful denial text, no analysis, no sources, no recovery state.
          expect(chatTerminal.type).toBe('turn.completed');
          expect(chatTerminal.response?.analysis).toBeUndefined();
          expect(chatTerminal.response?.sources ?? []).toEqual([]);
          expect(chatTerminal.response?.pendingAction).toBeUndefined();
          expect(chatTerminal.response?.message).toContain('ไม่มีสิทธิ์');
          if (viewport.name === 'desktop') expect(streamRequestKeys).toHaveLength(1);
        } else {
          expect(chatTerminal.type).toBe('turn.completed');
          expect(chatTerminal.response).toBeTruthy();
        }
        await expect.poll(async () => {
          const next = await readWorkspace();
          if (next.status !== 200) return -1;
          return next.body.messages.length;
        }, { timeout: 15_000 }).toBeGreaterThan(beforeChat.body.messages.length);

        const after = await readWorkspace();
        const messageText = JSON.stringify(after.body.messages);
        if (role.id === 'executive') {
          const assistantMessage = after.body.messages.filter((message: { role: string }) => message.role === 'assistant').at(-1);
          expect(assistantMessage?.analysis?.facts.length).toBeGreaterThan(0);
          expect(messageText).toContain('C01');
        } else if (role.id === 'east') {
          const assistantMessage = after.body.messages.filter((message: { role: string }) => message.role === 'assistant').at(-1);
          expect(assistantMessage?.analysis?.facts.length).toBeGreaterThan(0);
          expect(messageText).not.toContain('C01');
          expect(messageText).not.toContain('Central Confidential Branch');
          expect(messageText).not.toContain('SO-C01-PAID');
        } else {
          expect(after.body.audit.some((event: { category: string }) => event.category === 'denied')).toBe(true);
        }
        if (role.id === 'hr') {
          expect(after.body.messages.filter((message: { role: string }) => message.role === 'assistant').every((message: { evidence?: unknown }) => !message.evidence)).toBe(true);
          expect(messageText).not.toContain('SO-E02-PAID');
        }
        await capture(page, testInfo, role.id, viewport.name, 'conversation');

        if (role.id === 'executive') {
          const dashboardCount = after.body.dashboards.length;
          const createDashboardStream = await sendMessage(page, 'Create dashboard.');
          expect(createDashboardStream.terminal?.type).toBe('turn.completed');
          expect(createDashboardStream.terminal?.response?.pendingAction?.payload?.kind).toBe('dashboard_create');
          // A private dashboard is a reversible draft owned by the requester: it is created directly (no confirmation turn)
          // and the same turn carries the verified receipt.
          expect(createDashboardStream.terminal?.response?.pendingAction?.status).toBe('completed');
          const dashboardActionId = preparedActionId(createDashboardStream);
          await expect.poll(async () => (await readWorkspace()).body.dashboards.length, { timeout: 15_000 }).toBe(dashboardCount + 1);
          const afterDashboard = await readWorkspace();
          expect(afterDashboard.body.actions.filter((action: { status: string; payload: { kind: string } }) => action.status === 'pending' && action.payload.kind === 'dashboard_create')).toEqual([]);
          const dashboardReceipt = afterDashboard.body.receipts.find((receipt: { actionId: string }) => receipt.actionId === dashboardActionId);
          expect(dashboardReceipt).toMatchObject({ kind: 'dashboard_create', status: 'verified_success' });
          const dashboard = afterDashboard.body.dashboards.find((item: { id: string }) => item.id === dashboardReceipt.dashboardId);
          expect(dashboard).toBeTruthy();
          await capture(page, testInfo, role.id, viewport.name, 'dashboard-direct-create');
          // Completed work lives in history (not in the approvals queue): the receipt is verified and technical ids stay collapsed.
          await page.getByRole('button', { name: 'ประวัติการทำงาน', exact: true }).click();
          const dashboardHistory = page.locator(`article[data-history-action="${dashboardActionId}"]`);
          await expect(dashboardHistory).toBeVisible();
          await expect(dashboardHistory).toContainText('สร้าง Dashboard');
          await expect(dashboardHistory).toContainText('สำเร็จ');
          expect(await page.locator('#main-content').innerText()).not.toMatch(/execution_action_|effect_|\/dashboards\//);
          await capture(page, testInfo, role.id, viewport.name, 'dashboard-receipt');

          await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
          // Newest first: an earlier test of this file may have created a dashboard with the same generated title.
          const openDashboard = page.getByRole('button', { name: dashboard.spec.title, exact: true }).first();
          // Opening in place must not remount the workspace: no session re-check screen and no /api/session or /api/workspace refetch.
          await page.evaluate(() => {
            const w = window as unknown as { __sawSessionLoading: boolean };
            w.__sawSessionLoading = false;
            new MutationObserver(() => { if (document.body.innerText.includes('กำลังตรวจสอบการเข้าสู่ระบบ')) w.__sawSessionLoading = true; }).observe(document.body, { childList: true, subtree: true, characterData: true });
          });
          const remountRequests: string[] = [];
          const onRequest = (request: { url(): string }) => { const path = new URL(request.url()).pathname; if (path === '/api/session' || path === '/api/workspace') remountRequests.push(path); };
          page.on('request', onRequest);
          await openDashboard.click();
          await expect(page).toHaveURL(new RegExp(`/dashboards/${dashboard.id}$`));
          await expect(page.getByRole('heading', { name: dashboard.spec.title, exact: true })).toBeVisible();
          await capture(page, testInfo, role.id, viewport.name, 'dashboard-detail');
          page.off('request', onRequest);
          expect(remountRequests).toEqual([]);
          expect(await page.evaluate(() => (window as unknown as { __sawSessionLoading: boolean }).__sawSessionLoading)).toBe(false);

          // Deep link / refresh on the dashboard URL still renders the dashboard.
          await page.goto(`/dashboards/${dashboard.id}`);
          await expect(page.getByRole('heading', { name: dashboard.spec.title, exact: true })).toBeVisible();

          await page.goto('/');
          const shareDashboardStream = await sendMessage(page, 'Share dashboard with East manager.');
          expect(shareDashboardStream.terminal?.type).toBe('turn.completed');
          expect(shareDashboardStream.terminal?.response?.pendingAction?.payload?.kind).toBe('dashboard_share');
          const shareActionId = preparedActionId(shareDashboardStream);
          await expect.poll(async () => (await readWorkspace()).body.actions.filter(
            (action: { status: string; payload: { kind: string } }) => action.status === 'pending' && action.payload.kind === 'dashboard_share',
          ).length).toBeGreaterThan(0);
          await page.getByRole('button', { name: 'งานและการอนุมัติ', exact: true }).click();
          await page.locator(`[data-action-id="${shareActionId}"]`).getByRole('button', { name: 'ตรวจและยืนยัน', exact: true }).click();
          await expect(page.getByRole('heading', { name: 'ตรวจสอบก่อนยืนยัน: แชร์ Dashboard' })).toBeVisible();
          await expect(page.getByRole('dialog').getByText('รายละเอียดทางเทคนิค')).toBeVisible();
          await capture(page, testInfo, role.id, viewport.name, 'share-preview');
          await page.getByRole('button', { name: 'แชร์ Dashboard', exact: true }).click();
          await expect.poll(async () => (await readWorkspace()).body.receipts.some((receipt: { actionId: string; kind: string; status: string }) =>
            receipt.actionId === shareActionId && receipt.kind === 'dashboard_share' && receipt.status === 'verified_success'), { timeout: 15_000 }).toBe(true);
          await expectVerifiedAction(page, shareActionId);
          await capture(page, testInfo, role.id, viewport.name, 'share-receipt');

          await page.getByRole('button', { name: 'ออกจากระบบ' }).click();
          await expect(page.getByLabel('โปรไฟล์')).toBeVisible();
          await capture(page, testInfo, role.id, viewport.name, 'east-recipient-login');
          await page.getByLabel('โปรไฟล์').selectOption('east');
          await page.getByLabel('รหัสเข้าใช้งาน').fill('nexus-test-access');
          await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
          await expect(page.getByRole('region', { name: 'บทสนทนากับ DaTex', exact: true })).toBeVisible();
          const eastMode = page.getByRole('switch', { name: 'เปลี่ยนโหมดการทำงาน' });
          await expect(eastMode).toBeChecked();
          await eastMode.click();
          await expect(eastMode).not.toBeChecked();

          const eastWorkspace = await readWorkspace();
          expect(eastWorkspace.body.inbox.some((entry: { dashboardId: string }) => entry.dashboardId === dashboard.id)).toBe(true);
          const detail = await page.evaluate(async (id) => {
            const response = await fetch(`/api/dashboards/${id}`);
            return { status: response.status, body: await response.json() };
          }, dashboard.id as string);
          expect(detail.status).toBe(200);
          const scopedJson = JSON.stringify(detail.body);
          expect(scopedJson).not.toContain('C01');
          expect(scopedJson).not.toContain('Central Confidential Branch');
          expect(scopedJson).not.toContain('SO-C01-PAID');
          await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
          await page.getByRole('button', { name: /แชร์ถึงฉัน/ }).click();
          const inboxDashboard = page.locator(`[data-open-dashboard="${dashboard.id}"]`);
          await expect(inboxDashboard).toBeVisible();
          expect(await page.locator('#main-content').innerText()).not.toContain(dashboard.id);
          await capture(page, testInfo, role.id, viewport.name, 'east-recipient-inbox');
          await inboxDashboard.click();
          await expect(page.getByRole('heading', { name: detail.body.dashboard.spec.title, exact: true })).toBeVisible();
          await capture(page, testInfo, role.id, viewport.name, 'east-recipient-dashboard');
        }

        if (role.id === 'hr' && viewport.name === 'desktop') {
          // A permission denial is a known outcome: no recovery ritual, nothing was resent.
          await expect(page.getByRole('button', { name: 'ตรวจสถานะคำขอเดิม', exact: true })).toHaveCount(0);
          expect(recoveryRequestKeys).toEqual([]);
          expect(streamRequestKeys).toHaveLength(1);
          await expect(page.getByLabel('ข้อความถึง DaTex')).toBeEnabled();

          const badgeRevokeStream = await sendMessage(page, 'Revoke badge C102 for E024 because their employment ended.');
          expect(badgeRevokeStream.terminal?.type).toBe('turn.completed');
          expect(badgeRevokeStream.terminal?.response?.pendingAction?.payload?.kind).toBe('badge_revoke');
          const badgeActionId = preparedActionId(badgeRevokeStream);
          expect(streamRequestKeys).toHaveLength(2);
          expect(streamRequestKeys[1]).not.toBe(streamRequestKeys[0]);
          await expect.poll(async () => (await readWorkspace()).body.actions.filter(
            (action: { status: string; payload: { kind: string } }) => action.status === 'pending' && action.payload.kind === 'badge_revoke',
          ).length).toBeGreaterThan(0);
          await page.getByRole('button', { name: 'งานและการอนุมัติ', exact: true }).click();
          await page.locator(`[data-action-id="${badgeActionId}"]`).getByRole('button', { name: 'ตรวจและยืนยัน', exact: true }).click();
          await expect(page.getByRole('heading', { name: 'ตรวจสอบก่อนยืนยัน: เพิกถอนบัตรพนักงาน' })).toBeVisible();
          await expect(page.getByRole('dialog')).toContainText('C102');
          await expect(page.getByRole('dialog')).toContainText('E024');
          await capture(page, testInfo, role.id, viewport.name, 'badge-revoke-preview');
          await page.getByRole('button', { name: 'เพิกถอนบัตร', exact: true }).click();
          await expect.poll(async () => (await readWorkspace()).body.receipts.some((receipt: { actionId: string; kind: string; status: string; results: { status: string }[] }) =>
            receipt.actionId === badgeActionId && receipt.kind === 'badge_revoke' && receipt.status === 'verified_success' && receipt.results.some((result) => result.status === 'verified_success'),
          ), { timeout: 15_000 }).toBe(true);
          await expectVerifiedAction(page, badgeActionId);
          await page.getByRole('button', { name: 'ประวัติการทำงาน', exact: true }).click();
          const badgeRevokeHistory = page.locator(`article[data-history-action="${badgeActionId}"]`);
          await expect(badgeRevokeHistory).toBeVisible();
          await expect(badgeRevokeHistory.getByRole('heading', { name: 'เพิกถอนบัตรพนักงาน', exact: true })).toBeVisible();
          const badgeReceipt = badgeRevokeHistory.locator('.record-row').filter({ hasText: 'C102' });
          await expect(badgeReceipt).toBeVisible();
          await expect(badgeReceipt).toContainText('เรียบร้อยแล้ว');
          await capture(page, testInfo, role.id, viewport.name, 'badge-revoke-receipt');
        }
      } finally {
        await context.close();
      }
    });
  }
}
