import { execFileSync } from 'node:child_process';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Workspace } from '../../lib/contracts';

// HR Director (Workflow V2 bridge) through the unified chat. Typed prompts are planned by the local scripted TurnPlan double (exact
// prompts, lib/router/planner/scripted.ts SCRIPTED_DIRECTOR_FLOW_PROMPTS). Every decision and Email needs an explicit confirmation.
//
// The isolated runner starts this spec on a Workflow V2 server (scripts/e2e/spec-map.mjs specEnvironment: WORKFLOW_V2_ENABLED=true). The V2
// bootstrap then advances the seeded onboarding requests through the REAL manager approval path, so the Director queue holds 4
// requests (director_approval_pending) and 1 request is still at the manager stage. Tests run in file order on one DB.
// Requests that arrive later are created through the same real V2 path (scripts/e2e/add-onboarding-arrival.ts). The role-gate
// test runs on that V2 server too: a non-Director never receives the queue.
test.setTimeout(120_000);
const QUEUE = 'Show the onboarding requests waiting for my approval.';
const v2Server = process.env.WORKFLOW_V2_ENABLED === 'true' && process.env.NEXUS_E2E_RUNNER === '1';

/** A request that reaches Director approval AFTER the review (complete documents + real manager approval); one distinct employee per ordinal. */
function addLateArrival(ordinal: number) {
  execFileSync(process.execPath, ['--conditions=react-server', '--import', 'tsx', 'scripts/e2e/add-onboarding-arrival.ts', String(ordinal)],
    { cwd: process.cwd(), env: process.env, timeout: 90_000, stdio: 'pipe' });
}

async function workspace(page: Page): Promise<Workspace> {
  const response = await page.request.get('/api/workspace');
  expect(response.status()).toBe(200);
  return response.json();
}

async function login(page: Page, profile: 'executive' | 'east' | 'hr' | 'director') {
  expect((await page.request.get('/api/session', { timeout: 60_000 })).status()).toBe(401);
  await page.goto('/');
  await page.getByLabel('โปรไฟล์', { exact: true }).selectOption(profile);
  await page.getByLabel('รหัสเข้าใช้งาน', { exact: true }).fill('nexus-test-access');
  await page.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true }).click();
  await expect(page.getByRole('region', { name: 'บทสนทนากับ DaTex', exact: true })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'เปลี่ยนโหมดการทำงาน' })).toBeChecked();
}

/** Sends a typed prompt in Live AI and returns the newly completed assistant message. */
async function ask(page: Page, prompt: string): Promise<Locator> {
  const known = new Set((await workspace(page)).messages.map(message => message.id));
  await page.getByRole('textbox', { name: 'ข้อความถึง DaTex' }).fill(prompt);
  await page.getByRole('button', { name: 'ส่ง', exact: true }).click();
  let answerId = '';
  await expect.poll(async () => {
    answerId = (await workspace(page)).messages.find(message => message.role === 'assistant' && !known.has(message.id))?.id ?? '';
    return answerId;
  }, { timeout: 30_000 }).not.toBe('');
  const article = page.locator(`[data-message-id="${answerId}"]`);
  await expect(article).toHaveAttribute('data-delivery', 'complete');
  return article;
}

/** Opens the staged proposal of this answer, checks the preview, confirms it and returns the dialog result text. */
async function confirmStaged(page: Page, answer: Locator, heading: RegExp, confirmLabel: string): Promise<Locator> {
  const card = answer.locator('[data-staged-proposal-id]');
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'ตรวจและยืนยัน', exact: true }).click();
  const dialog = page.locator('dialog[data-staged-dialog]');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: heading })).toBeVisible();
  await dialog.getByRole('button', { name: confirmLabel, exact: true }).click();
  const status = dialog.getByRole('status', { name: 'ผลการดำเนินการ' });
  await expect(status).toContainText('ดำเนินการและตรวจผลแล้ว');
  return dialog;
}

test('the isolated runner serves this spec from a Workflow V2 server', () => {
  if (process.env.NEXUS_E2E_RUNNER === '1') expect(process.env.WORKFLOW_V2_ENABLED).toBe('true');
});

test('other roles cannot see or act on the Director onboarding queue', async ({ page }) => {
  for (const profile of ['hr', 'east', 'executive'] as const) {
    await page.context().clearCookies();
    await login(page, profile);
    const answer = await ask(page, QUEUE);
    // No queue details and no decision proposal for a non-Director role (HR Admin included).
    await expect(answer).not.toContainText('รอคุณอนุมัติในขั้นผู้อำนวยการ');
    await expect(answer.locator('[data-staged-proposal-id]')).toHaveCount(0);
  }
});

test.describe('HR Director flows (Workflow V2 server)', () => {
  test.skip(!v2Server, 'needs the isolated runner with a Workflow V2 server (WORKFLOW_V2_ENABLED=true, NEXUS_E2E_RUNNER=1)');

  test('seeded queue -> approve one request -> explicit confirm -> verified receipt; Email is not sent', async ({ page }) => {
    await login(page, 'director');
    await expect(page.getByText('ผู้อำนวยการฝ่ายบุคคล').first()).toBeVisible();
    const queue = await ask(page, QUEUE);
    await expect(queue).toContainText('รอคุณอนุมัติในขั้นผู้อำนวยการ');
    // The bootstrap advanced the seeded demo requests through the real manager path: 4 are waiting for the Director.
    await expect(queue).toContainText('4 รายการ');
    const approve = await ask(page, 'Approve the first request.');
    await expect(approve).toContainText('ยังไม่ได้ดำเนินการ');
    const dialog = await confirmStaged(page, approve, /อนุมัติคำขอ Onboarding/, 'ยืนยันอนุมัติ');
    await expect(dialog).toContainText('ตรวจสอบสถานะที่บันทึกไว้แล้ว');
    await dialog.getByRole('button', { name: 'ปิด', exact: true }).click();
  });

  test('approve all reviewed binds exactly the reviewed queue; a request that arrives after the review is NOT approved', async ({ page }) => {
    await login(page, 'director');
    const queue = await ask(page, QUEUE);
    // The answer text is one pre-wrap block; each listed request is a line that starts with its ordinal.
    const listed = ((await queue.innerText()).match(/^\d+\. /gm) ?? []).length;
    expect(listed).toBeGreaterThan(0);
    // A new request reaches Director approval through the real V2 path AFTER the review snapshot was taken.
    addLateArrival(0);
    const approve = await ask(page, 'Approve all the requests I just reviewed.');
    await expect(approve.locator('[data-staged-proposal-id]')).toContainText('ไม่รวมรายการที่เข้ามาภายหลัง');
    const dialog = await confirmStaged(page, approve, /อนุมัติคำขอ Onboarding/, 'ยืนยันอนุมัติ');
    await expect(dialog).toContainText(`${listed} รายการ`);
    await dialog.getByRole('button', { name: 'ปิด', exact: true }).click();
    // The late arrival is still waiting: only a NEW queue read (a new snapshot) shows it, and exactly it.
    const after = await ask(page, QUEUE);
    await expect(after).toContainText('1 รายการ');
    await expect(after).not.toContainText(`${listed} รายการ`);
  });

  test('simulated Email after a verified approval needs its own preview and confirm, then shows a delivery receipt', async ({ page }) => {
    addLateArrival(1);
    await login(page, 'director');
    await ask(page, QUEUE);
    const approve = await ask(page, 'Approve the first request.');
    const approved = await confirmStaged(page, approve, /อนุมัติคำขอ Onboarding/, 'ยืนยันอนุมัติ');
    await approved.getByRole('button', { name: 'ปิด', exact: true }).click();
    const email = await ask(page, 'Email the related people that these requests were approved.');
    await expect(email.locator('[data-staged-proposal-id]')).toContainText('ยังไม่ได้ส่ง');
    const dialog = await confirmStaged(page, email, /Email แจ้งผลการอนุมัติ/, 'ยืนยันส่ง Email');
    await expect(dialog).toContainText('Email จำลอง');
  });
});
