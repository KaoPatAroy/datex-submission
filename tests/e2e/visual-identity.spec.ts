import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { statSync } from 'node:fs';

test.setTimeout(120_000);

const viewports = [
  { width: 1920, height: 953 },
  { width: 1440, height: 900 },
  { width: 941, height: 744 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
] as const;

const roles = [
  { id: 'executive', profile: 'executive' },
  { id: 'east', profile: 'east' },
  { id: 'hr', profile: 'hr' },
] as const;

const accent = '#2855d9';
const nav = '#142c60';
const canvas = '#f4f6fa';

async function capture(page: Page, testInfo: TestInfo, role: string, surface: string, viewport: { width: number; height: number }) {
  const screenshotPath = testInfo.outputPath(`visual-identity/${role}-${surface}-${viewport.width}x${viewport.height}.png`);
  await page.screenshot({
    path: screenshotPath,
    fullPage: true,
  });
  expect(statSync(screenshotPath).size, `screenshot should contain rendered content: ${screenshotPath}`).toBeGreaterThan(5000);
}

async function signIn(page: Page, profile: string) {
  const ready = await page.request.get('/api/session', { timeout: 60_000 });
  expect(ready.status()).toBe(401);
  await page.goto('/');
  await expect(page.getByLabel('โปรไฟล์', { exact: true })).toBeVisible();
  await page.getByLabel('โปรไฟล์', { exact: true }).selectOption(profile);
  await page.getByLabel('รหัสเข้าใช้งาน', { exact: true }).fill('nexus-test-access');
  await page.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true }).click();
  await expect(page.getByRole('region', { name: 'บทสนทนากับ DaTex', exact: true })).toBeVisible();
}

async function expectBlueTokens(page: Page) {
  const tokens = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      accent: style.getPropertyValue('--accent').trim(),
      nav: style.getPropertyValue('--nav').trim(),
      canvas: style.getPropertyValue('--canvas').trim(),
      focus: style.getPropertyValue('--focus').trim(),
    };
  });
  expect(tokens).toEqual({ accent, nav, canvas, focus: accent });
}

async function expectNoHorizontalOverflow(page: Page) {
  const size = await page.evaluate(() => {
    const scrolling = document.scrollingElement;
    if (!scrolling) throw new Error('The document has no scrolling element.');
    return { scrollWidth: scrolling.scrollWidth, clientWidth: scrolling.clientWidth };
  });
  expect(size.scrollWidth, `horizontal overflow: ${size.scrollWidth}px > ${size.clientWidth}px`).toBeLessThanOrEqual(size.clientWidth);
}

async function greenSweep(page: Page) {
  const offenders = await page.evaluate(() => {
    const ignoredSuccess = '.badge-success, .success-banner, [data-status="success"], [data-status="completed"], [data-status="verified"]';
    const properties = ['color', 'background-color', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color', 'outline-color', 'fill', 'stroke'];
    const describe = (element: Element) => {
      const parts: string[] = [];
      for (let node: Element | null = element; node && parts.length < 4; node = node.parentElement) {
        const tag = node.tagName.toLowerCase();
        const id = node.id ? `#${node.id}` : '';
        const classes = typeof node.className === 'string' ? node.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(name => `.${name}`).join('') : '';
        parts.unshift(`${tag}${id}${classes}`);
      }
      return parts.join(' > ');
    };
    const rgba = (value: string) => {
      const match = value.match(/^rgba?\((.+)\)$/i);
      if (!match) return null;
      const parts = match[1].replace('/', ' ').split(/[\s,]+/).filter(Boolean).map(Number);
      if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) return null;
      return { red: parts[0], green: parts[1], blue: parts[2], alpha: parts.length > 3 ? parts[3] : 1 };
    };
    const hueSaturationLightness = (red: number, green: number, blue: number) => {
      const r = red / 255, g = green / 255, b = blue / 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
      let hue = 0;
      if (delta) {
        if (max === r) hue = 60 * (((g - b) / delta) % 6);
        else if (max === g) hue = 60 * ((b - r) / delta + 2);
        else hue = 60 * ((r - g) / delta + 4);
      }
      if (hue < 0) hue += 360;
      const lightness = (max + min) / 2;
      const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
      return { hue, saturation, lightness };
    };
    const results: string[] = [];
    for (const element of Array.from(document.querySelectorAll('*'))) {
      if (!element.getClientRects().length || getComputedStyle(element).visibility === 'hidden') continue;
      if (element.closest(ignoredSuccess)) continue;
      const style = getComputedStyle(element);
      for (const property of properties) {
        const value = style.getPropertyValue(property).trim();
        const color = rgba(value);
        if (!color || color.alpha <= 0.1) continue;
        const hsl = hueSaturationLightness(color.red, color.green, color.blue);
        if (hsl.hue >= 90 && hsl.hue <= 170 && hsl.saturation >= 0.25 && hsl.lightness >= 0.12 && hsl.lightness <= 0.92) {
          results.push(`${describe(element)} ${property}: ${value}`);
        }
      }
    }
    return results;
  });
  expect(offenders, `green visual-identity offenders:\n${offenders.join('\n')}`).toEqual([]);
}

async function contrastRatio(target: Locator) {
  return target.evaluate(element => {
    const parse = (value: string) => {
      const match = value.match(/^rgba?\((.+)\)$/i);
      if (!match) return null;
      const parts = match[1].replace('/', ' ').split(/[\s,]+/).filter(Boolean).map(Number);
      if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) return null;
      return { channels: parts.slice(0, 3), alpha: parts.length > 3 ? parts[3] : 1 };
    };
    const luminance = (channels: number[]) => {
      const [red, green, blue] = channels.map(channel => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    };
    const foreground = parse(getComputedStyle(element).color);
    if (!foreground) throw new Error(`Cannot parse foreground color for ${element.tagName}.`);
    let background: ReturnType<typeof parse> = null;
    for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
      const color = parse(getComputedStyle(ancestor).backgroundColor);
      if (color && color.alpha >= 0.999) { background = color; break; }
    }
    if (!background) background = { channels: [255, 255, 255], alpha: 1 };
    const lighter = Math.max(luminance(foreground.channels), luminance(background.channels));
    const darker = Math.min(luminance(foreground.channels), luminance(background.channels));
    return { ratio: (lighter + 0.05) / (darker + 0.05), foreground: getComputedStyle(element).color, background: `rgb(${background.channels.join(', ')})` };
  });
}

async function expectContrast(target: Locator, description: string) {
  const result = await contrastRatio(target);
  expect(result.ratio, `${description} contrast ${result.ratio.toFixed(2)}:1 (${result.foreground} on ${result.background})`).toBeGreaterThanOrEqual(4.5);
}

test('login first paint serves blue CSS before delayed JavaScript', async ({ page }) => {
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/*.js', async route => {
    await new Promise<void>(resolve => setTimeout(resolve, 1_500));
    await delayed;
    await route.continue();
  });
  try {
    await page.goto('/', { waitUntil: 'commit' });
    await page.waitForFunction(() => {
      const link = document.querySelector('link[rel="stylesheet"]');
      return Boolean(document.body && link && getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
    });
    const firstPaint = await page.evaluate(() => ({
      accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
      background: getComputedStyle(document.body).backgroundColor,
    }));
    expect(firstPaint).toEqual({ accent, background: 'rgb(244, 246, 250)' });
  } finally {
    release();
    await page.unroute('**/*.js');
  }
});

test('anonymous login keeps the blue visual identity at every requested viewport', async ({ page }, testInfo) => {
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.request.get('/api/session', { timeout: 60_000 });
    await page.goto('/');
    await expect(page.getByLabel('โปรไฟล์', { exact: true })).toBeVisible();
    await expectBlueTokens(page);
    const intro = page.locator('[class*="auth-intro"]');
    await expect(intro).toHaveCSS('background-color', 'rgb(20, 44, 96)');
    await expectContrast(page.locator('.auth-message h1'), 'login heading');
    await expectNoHorizontalOverflow(page);
    await greenSweep(page);
    await capture(page, testInfo, 'anonymous', 'login', viewport);
  }
});

for (const role of roles) {
  test(`${role.id} workspace preserves blue controls, keyboard focus, and contrast at every requested viewport`, async ({ page }, testInfo) => {
    await signIn(page, role.profile);
    await expectBlueTokens(page);
    await expect(page.getByRole('heading', { name: 'บทสนทนาใหม่', exact: true })).toBeVisible();

    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      const composer = page.getByRole('textbox', { name: 'ข้อความถึง DaTex', exact: true });
      const send = page.getByRole('button', { name: 'ส่ง', exact: true });
      await composer.fill('ตรวจสอบสีและความคมชัดของช่องเขียนข้อความ');
      await expect(send).toBeEnabled();
      // The enabled state animates in from the disabled colour; wait for the settled value.
      await expect.poll(() => send.evaluate(button => getComputedStyle(button).backgroundColor)).toBe('rgb(40, 85, 217)');
      await expectContrast(composer, 'composer text');
      await expectContrast(send, 'primary send button label');

      await send.focus();
      // Tab order is composer, then the work chooser, then send.
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Shift+Tab');
      await expect(composer).toBeFocused();
      const focus = await composer.evaluate(element => {
        const style = getComputedStyle(element);
        return { outlineColor: style.outlineColor, boxShadow: style.boxShadow };
      });
      const focusColors = `${focus.outlineColor} ${focus.boxShadow}`;
      expect(focusColors, `composer focus should be blue: ${focusColors}`).toMatch(/(40, 85, 217|#2855d9|rgb\(40 85 217)/i);

      const selectedNav = page.getByRole('navigation', { name: 'เมนูหลัก', exact: true }).locator('[aria-current="page"]');
      await expect(selectedNav).toHaveCount(1);
      const navAppearance = await selectedNav.evaluate(element => {
        const style = getComputedStyle(element);
        return { color: style.color, background: style.backgroundColor, borderColor: style.borderBottomColor };
      });
      const navHues = `${navAppearance.color} ${navAppearance.background} ${navAppearance.borderColor}`;
      expect(navHues, `selected navigation item should use blue: ${navHues}`).toMatch(/(36, 74, 175|40, 85, 217|32, 62, 124|142, 168, 236)/);
      await expectNoHorizontalOverflow(page);
      await greenSweep(page);
      await capture(page, testInfo, role.id, 'workspace', viewport);
    }

    if (role.id === 'executive') {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.keyboard.press('Escape');
      // Live AI (default) interprets the typed request through the router's scripted planner.
      await expect(page.getByRole('switch')).toBeChecked();
      const composer = page.getByRole('textbox', { name: 'ข้อความถึง DaTex', exact: true });
      await composer.fill('Compare sales across all regions on 2026-10-01.');
      await page.getByRole('button', { name: 'ส่ง', exact: true }).click();
      const answer = page.locator('[data-message-role="assistant"][data-delivery="complete"]').last();
      await expect(answer).toBeVisible({ timeout: 45_000 });
      await capture(page, testInfo, role.id, 'populated-conversation', { width: 1440, height: 900 });

      const details = page.getByRole('button', { name: 'รายละเอียดแหล่งข้อมูล', exact: true });
      await expect(details).toHaveCount(1);
      await details.click();
      const panel = page.locator('aside[aria-labelledby="workspace-details-title"]');
      await expect(panel).toBeVisible();
      const detailComposer = page.getByRole('textbox', { name: 'ข้อความถึง DaTex', exact: true });
      for (const viewport of [{ width: 1920, height: 953 }, { width: 1440, height: 900 }]) {
        await page.setViewportSize(viewport);
        await expect(panel).toBeVisible();
        await expect(detailComposer).toBeVisible();
        const [composerBox, panelBox] = await Promise.all([detailComposer.boundingBox(), panel.boundingBox()]);
        expect(composerBox, 'composer should have a bounding box').not.toBeNull();
        expect(panelBox, 'details panel should have a bounding box').not.toBeNull();
        if (!composerBox || !panelBox) throw new Error('Expected visible composer and details panel bounds.');
        const intersects = composerBox.x < panelBox.x + panelBox.width
          && composerBox.x + composerBox.width > panelBox.x
          && composerBox.y < panelBox.y + panelBox.height
          && composerBox.y + composerBox.height > panelBox.y;
        expect(intersects, `composer should not intersect details panel at ${viewport.width}x${viewport.height}`).toBe(false);
        await detailComposer.click();
        expect(await detailComposer.evaluate(element => document.activeElement === element), 'clicking the composer should focus it').toBe(true);
      }
      await capture(page, testInfo, role.id, 'context-detail', { width: 1440, height: 900 });

      await page.setViewportSize({ width: 390, height: 844 });
      // The open details panel becomes a modal dialog at narrow widths; close it to reach the drawer.
      const closeDetails = page.getByRole('button', { name: 'ปิดรายละเอียด', exact: true });
      await expect(closeDetails).toHaveCount(1);
      await closeDetails.click();
      await expect(page.locator('dialog[open]')).toHaveCount(0);
      const openNavigation = page.getByRole('button', { name: 'เปิดบทสนทนา', exact: true });
      await expect(openNavigation).toBeVisible();
      await openNavigation.click();
      await expect(page.getByRole('complementary', { name: 'บทสนทนา', exact: true })).toBeVisible();
      await capture(page, testInfo, role.id, 'mobile-navigation-drawer', { width: 390, height: 844 });
    }
  });
}
