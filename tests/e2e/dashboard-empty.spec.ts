import { expect, test, type Page } from '@playwright/test';

const modeSwitchName = 'เปลี่ยนโหมดการทำงาน';
const emptyTitle = 'ยังไม่มี Dashboard ของคุณ';
const emptyDescription = 'เติมคำขอสร้าง Dashboard ในแชต ตรวจคำขอแล้วกดส่ง ระบบจะเตรียมข้อเสนอให้ตรวจและยืนยันก่อนสร้าง';

const viewports = [
  { name: 'desktop', size: { width: 1440, height: 900 } },
  { name: 'mobile', size: { width: 390, height: 844 } },
] as const;

type ApiSnapshot = {
  status: number;
  body: {
    actor?: { mode?: string };
    dashboards?: unknown[];
    actionCatalog?: Array<{ actionKind?: string; prompt: string }>;
    actions?: Array<{ status: string; payload: { kind: string } }>;
    messages?: Array<{ role: string; text: string }>;
  };
};

async function signInAsExecutive(page: Page) {
  // Await the fresh synthetic store, rather than racing its initial seed during UI assertions.
  const ready = await page.request.get('/api/session', { timeout: 60_000 });
  expect(ready.status()).toBe(401);
  await page.goto('/');
  await expect(page.getByLabel('โปรไฟล์')).toBeVisible();
  await page.getByLabel('โปรไฟล์').selectOption('executive');
  await page.getByLabel('รหัสเข้าใช้งาน').fill('nexus-test-access');
  await page.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true }).click();
  await expect(page.getByRole('switch', { name: modeSwitchName })).toBeVisible();

  // Keep this workflow on the local synthetic provider for a deterministic, non-live preparation turn.
  const modeSwitch = page.getByRole('switch', { name: modeSwitchName });
  await expect(modeSwitch).toBeChecked();
  await modeSwitch.click();
  await expect(modeSwitch).not.toBeChecked();
}

async function readWorkspace(page: Page): Promise<ApiSnapshot> {
  return page.evaluate(async () => {
    const response = await fetch('/api/workspace', { cache: 'no-store' });
    return { status: response.status, body: await response.json() } as ApiSnapshot;
  });
}

async function inspectEmptyState(page: Page) {
  const title = page.getByRole('heading', { name: emptyTitle, exact: true, level: 2 });
  const panel = page.locator('[class*="emptyPanel"]').filter({ has: title }).first();
  const content = panel.locator('[class*="emptyPanelContent"]');
  const icon = panel.locator('[class*="emptyPanelIcon"]');
  const description = panel.getByText(emptyDescription, { exact: true });
  const button = panel.getByRole('button', { name: 'เริ่มสร้าง Dashboard', exact: true });

  await expect(panel).toBeVisible();
  await expect(icon.locator('svg')).toBeVisible();
  await expect(title).toBeVisible();
  await expect(description).toBeVisible();
  await expect(button).toBeVisible();
  await expect(button).toBeEnabled();
  await expect(button).toHaveClass(/btn-primary/);

  return { title, panel, content, icon, description, button };
}

for (const viewport of viewports) {
  test(`${viewport.name}: empty dashboard state is centered and its CTA starts preparation`, async ({ browser }, testInfo) => {
    test.setTimeout(60_000);
    const context = await browser.newContext({ viewport: viewport.size });
    const page = await context.newPage();

    try {
      await signInAsExecutive(page);
      const initial = await readWorkspace(page);
      expect(initial.status).toBe(200);
      expect(initial.body.actor?.mode).toBe('scripted_demo');
      expect(initial.body.dashboards).toHaveLength(0);
      const preparationIntent = initial.body.actionCatalog?.find(entry => entry.actionKind === 'dashboard_create')?.prompt;
      expect(preparationIntent).toBeTruthy();
      const matchingPromptsBefore = initial.body.messages?.filter(
        (message) => message.role === 'user' && message.text === preparationIntent,
      ).length ?? 0;

      const dashboardsNav = page.getByRole('button', { name: 'Dashboard', exact: true });
      await dashboardsNav.click();
      await expect(dashboardsNav).toHaveAttribute('aria-current', 'page');
      await expect(page.getByRole('heading', { name: 'Dashboard ของฉัน', exact: true, level: 1 })).toBeVisible();

      const empty = await inspectEmptyState(page);
      const createButtons = page.getByRole('button', { name: /เริ่มสร้าง Dashboard/ });
      await expect(createButtons).toHaveCount(1);

      const layout = await empty.panel.evaluate((panel) => {
        const find = (selector: string) => {
          const element = panel.querySelector(selector);
          if (!element) throw new Error(`Missing empty-state element: ${selector}`);
          const rect = element.getBoundingClientRect();
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, centerX: (rect.left + rect.right) / 2 };
        };
        const content = find('[class*="emptyPanelContent"]');
        const icon = find('[class*="emptyPanelIcon"]');
        const heading = find('h2');
        const description = find('p');
        const button = find('button');
        const panelRect = panel.getBoundingClientRect();
        const contentElement = panel.querySelector('[class*="emptyPanelContent"]') as HTMLElement;
        return {
          panel: { left: panelRect.left, right: panelRect.right, centerX: (panelRect.left + panelRect.right) / 2 },
          content,
          icon,
          heading,
          description,
          button,
          alignItems: getComputedStyle(contentElement).alignItems,
          textAlign: getComputedStyle(contentElement).textAlign,
          contentWidth: contentElement.clientWidth,
          contentScrollWidth: contentElement.scrollWidth,
          viewportWidth: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth,
        };
      });

      expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth + 1);
      expect(layout.panel.left).toBeGreaterThanOrEqual(0);
      expect(layout.panel.right).toBeLessThanOrEqual(layout.viewportWidth + 1);
      expect(layout.content.left).toBeGreaterThanOrEqual(layout.panel.left - 1);
      expect(layout.content.right).toBeLessThanOrEqual(layout.panel.right + 1);
      expect(layout.content.centerX).toBeCloseTo(layout.panel.centerX, 0);
      expect(layout.alignItems).toBe('center');
      expect(layout.textAlign).toBe('center');
      expect(layout.contentScrollWidth).toBeLessThanOrEqual(layout.contentWidth + 1);
      expect(layout.icon.centerX).toBeCloseTo(layout.content.centerX, 0);
      expect(layout.heading.centerX).toBeCloseTo(layout.content.centerX, 0);
      expect(layout.description.centerX).toBeCloseTo(layout.content.centerX, 0);
      expect(layout.button.centerX).toBeCloseTo(layout.content.centerX, 0);
      expect(layout.icon.top).toBeLessThan(layout.heading.top);
      expect(layout.heading.top).toBeLessThan(layout.description.top);
      expect(layout.description.top).toBeLessThan(layout.button.top);

      await page.screenshot({ path: testInfo.outputPath(`${viewport.name}-dashboard-empty.png`), fullPage: true });

      const requestPromise = page.waitForRequest((request) => {
        const url = new URL(request.url());
        return url.pathname === '/api/chat/stream' && request.method() === 'POST';
      });
      await empty.button.click();
      const composer = page.getByRole('textbox', { name: 'ข้อความถึง DaTex' });
      await expect(composer).toHaveValue(preparationIntent!);
      await expect(composer).toBeFocused();
      const beforeSend = await readWorkspace(page);
      expect(beforeSend.body.messages?.length).toBe(initial.body.messages?.length);
      expect(beforeSend.body.dashboards).toHaveLength(0);
      await page.getByRole('button', { name: 'ส่ง', exact: true }).click();
      const request = await requestPromise;
      const requestBody = request.postDataJSON() as { message?: string };
      expect(requestBody.message).toBe(preparationIntent);
      await expect(page.locator('[data-message-role="user"]').last()).toContainText(requestBody.message ?? '');
      await expect(page.locator('[data-message-role="assistant"][data-delivery="complete"]').last()).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(0);

      const prepared = await readWorkspace(page);
      expect(prepared.status).toBe(200);
      expect(prepared.body.dashboards).toHaveLength(0);
      expect(prepared.body.actions?.some(action => action.payload.kind === 'dashboard_create' && action.status === 'pending')).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`${viewport.name}-dashboard-preparation.png`), fullPage: true });

      await page.reload();
      await expect(page.getByRole('switch', { name: modeSwitchName })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'ข้อความถึง DaTex' })).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(0);

      const refreshed = await readWorkspace(page);
      expect(refreshed.status).toBe(200);
      expect(refreshed.body.actor?.mode).toBe('scripted_demo');
      expect(refreshed.body.dashboards).toHaveLength(0);
      expect(refreshed.body.messages?.filter(
        (message) => message.role === 'user' && message.text === requestBody.message,
      )).toHaveLength(matchingPromptsBefore + 1);
    } finally {
      await context.close();
    }
  });
}
