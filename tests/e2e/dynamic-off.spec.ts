import { expect, test } from '@playwright/test';

// Runs only in the runner's `off` flag profile (BIZTANIA_DYNAMIC_QUERY=off): there is no legacy fallback router, so a live
// turn completes truthfully with "AI temporarily unavailable" and offers the explicit switch to Demo. Nothing is prepared.
test.skip(process.env.BIZTANIA_DYNAMIC_QUERY !== 'off', 'Requires BIZTANIA_DYNAMIC_QUERY=off in the runner environment.');
test.setTimeout(90_000);

test('with the live AI switch off, chat says AI is temporarily unavailable and offers Demo without preparing anything', async ({ page }) => {
  expect((await page.request.get('/api/session', { timeout: 60_000 })).status()).toBe(401);
  await page.goto('/');
  await page.getByLabel('โปรไฟล์', { exact: true }).selectOption('executive');
  await page.getByLabel('รหัสเข้าใช้งาน', { exact: true }).fill('nexus-test-access');
  await page.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true }).click();
  await expect(page.getByRole('switch', { name: 'เปลี่ยนโหมดการทำงาน' })).toBeChecked();
  await page.getByRole('textbox', { name: 'ข้อความถึง DaTex' }).fill('Create dashboard.');
  await page.getByRole('button', { name: 'ส่ง', exact: true }).click();
  const answer = page.locator('[data-message-role="assistant"][data-delivery="complete"]').last();
  await expect(answer).toContainText('Live AI ยังไม่ได้เปิดใช้งานในระบบนี้');
  await expect(answer).toContainText('ครั้งนี้ยังไม่ได้ดำเนินการหรือเปลี่ยนข้อมูล');
  const workspace = await (await page.request.get('/api/workspace')).json();
  expect(workspace.actions).toEqual([]);
  expect(workspace.receipts).toEqual([]);
  await expect(answer.getByRole('button', { name: 'สลับเป็นโหมดสาธิต', exact: true })).toBeVisible();
});
