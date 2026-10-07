import { expect, test, type Page } from '@playwright/test';

const modeSwitchName = 'เปลี่ยนโหมดการทำงาน';

type SessionSnapshot = {
  status: number;
  mode?: string;
};

async function signIn(page: Page) {
  // Complete the fresh synthetic store initialization before timing UI assertions.
  const ready = await page.request.get('/api/session');
  expect(ready.status()).toBe(401);
  await page.goto('/');
  await expect(page.getByLabel('โปรไฟล์')).toBeVisible();
  await page.getByLabel('โปรไฟล์').selectOption('executive');
  await page.getByLabel('รหัสเข้าใช้งาน').fill('nexus-test-access');
  await page.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true }).click();
  await expect(page.getByRole('switch', { name: modeSwitchName })).toBeVisible();
}

async function readSession(page: Page): Promise<SessionSnapshot> {
  return page.evaluate(async () => {
    const response = await fetch('/api/session', { cache: 'no-store' });
    const body = await response.json() as { actor?: { mode?: string } };
    return { status: response.status, mode: body.actor?.mode };
  });
}

async function expectMode(page: Page, mode: 'live_ai' | 'scripted_demo') {
  await expect.poll(async () => (await readSession(page)).mode).toBe(mode);
  const modeSwitch = page.getByRole('switch', { name: modeSwitchName });
  await expect(modeSwitch).toBeChecked({ checked: mode === 'live_ai' });
  await expect(modeSwitch.locator('.mode-state')).toHaveText(mode === 'live_ai' ? 'Live AI' : 'โหมดสาธิต');
}

async function readSwitchAppearance(page: Page) {
  return page.getByRole('switch', { name: modeSwitchName }).evaluate((control) => {
    const track = control.querySelector('.mode-track');
    if (!track) throw new Error('The mode switch has no visible track.');
    const pseudo = getComputedStyle(track, '::after');
    const matrix = pseudo.transform === 'none' ? new DOMMatrixReadOnly() : new DOMMatrixReadOnly(pseudo.transform);
    return {
      checked: control.getAttribute('aria-checked'),
      title: control.getAttribute('title'),
      trackColor: getComputedStyle(track).backgroundColor,
      thumbOffset: matrix.m41,
    };
  });
}

test('server-rendered first paint keeps the blue tokens on repeated hard refreshes before hydration', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const devtools = await context.newCDPSession(page);
  await devtools.send('Network.setCacheDisabled', { cacheDisabled: true });

  try {
    for (let refresh = 0; refresh < 3; refresh += 1) {
      const response = refresh === 0 ? await page.goto('/') : await page.reload();
      expect(response?.status()).toBe(200);
      await expect(page.getByRole('status')).toContainText('กำลังตรวจสอบการเข้าสู่ระบบ');

      const firstPaint = await page.locator('main').evaluate((main) => {
        const style = getComputedStyle(main);
        const bounds = main.getBoundingClientRect();
        return {
          accent: style.getPropertyValue('--accent').trim(),
          canvas: style.getPropertyValue('--canvas').trim(),
          background: style.backgroundColor,
          width: bounds.width,
          height: bounds.height,
          viewportWidth: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth,
        };
      });

      expect(firstPaint.accent).toBe('#2855d9');
      expect(firstPaint.canvas).toBe('#f4f6fa');
      expect(firstPaint.background).toBe('rgb(244, 246, 250)');
      expect(firstPaint.width).toBe(firstPaint.viewportWidth);
      expect(firstPaint.height).toBeGreaterThanOrEqual(900);
      expect(firstPaint.documentWidth).toBeLessThanOrEqual(firstPaint.viewportWidth);
    }
  } finally {
    await devtools.detach();
    await context.close();
  }
});

test('fresh live_ai defaults ON, mode changes persist across refreshes and workspace navigation without hydration errors', async ({ browser }) => {
  test.setTimeout(60_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const hydrationErrors: string[] = [];
  const hydrationErrorPattern = /hydration|hydrating|server-rendered|server rendered|didn't match|does not match|text content does not match/i;

  page.on('console', (message) => {
    if (message.type() === 'error' && hydrationErrorPattern.test(message.text())) hydrationErrors.push(message.text());
  });
  page.on('pageerror', (error) => {
    if (hydrationErrorPattern.test(error.message)) hydrationErrors.push(error.message);
  });

  try {
    await signIn(page);
    const modeSwitch = page.getByRole('switch', { name: modeSwitchName });
    await expectMode(page, 'live_ai');
    expect((await readSession(page)).status).toBe(200);

    const liveAppearance = await readSwitchAppearance(page);
    expect(liveAppearance.checked).toBe('true');
    expect(liveAppearance.title).toContain('เปิด: Live AI');
    expect(liveAppearance.trackColor).toBe('rgb(40, 85, 217)');
    expect(liveAppearance.thumbOffset).toBeGreaterThan(0);

    await modeSwitch.click();
    await expectMode(page, 'scripted_demo');
    await page.reload();
    await expectMode(page, 'scripted_demo');

    await page.getByRole('switch', { name: modeSwitchName }).click();
    await expectMode(page, 'live_ai');
    await page.reload();
    await expectMode(page, 'live_ai');

    const dashboardsNav = page.getByRole('button', { name: 'Dashboard', exact: true });
    await dashboardsNav.click();
    await expect(dashboardsNav).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { name: 'Dashboard ของฉัน', exact: true })).toBeVisible();
    await expectMode(page, 'live_ai');

    const actionsNav = page.getByRole('button', { name: 'งานและการอนุมัติ', exact: true });
    await actionsNav.click();
    await expect(actionsNav).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { name: 'งานและการอนุมัติ', exact: true })).toBeVisible();
    await expectMode(page, 'live_ai');

    const auditNav = page.getByRole('button', { name: 'ประวัติการทำงาน', exact: true });
    await auditNav.click();
    await expect(auditNav).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { name: 'ประวัติการทำงาน', exact: true })).toBeVisible();
    await expectMode(page, 'live_ai');

    expect(hydrationErrors).toEqual([]);
  } finally {
    await context.close();
  }
});
