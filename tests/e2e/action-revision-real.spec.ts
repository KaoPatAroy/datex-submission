import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { PendingAction, Workspace } from '../../lib/contracts';
import { showcase } from '../../lib/demo/showcase';

const dashboardCard = showcase.find((item) => item.id === 'executive-dashboard')!;

type RevisionResponse = {
  predecessor: PendingAction;
  replacement: PendingAction;
  diff: string[];
};

async function readWorkspace(page: Page): Promise<Workspace> {
  const result = await page.evaluate(async () => {
    const response = await fetch('/api/workspace', { cache: 'no-store' });
    return { status: response.status, body: await response.json() };
  });
  expect(result.status).toBe(200);
  return result.body as Workspace;
}

async function readCsrfToken(page: Page): Promise<string> {
  const result = await page.evaluate(async () => {
    const response = await fetch('/api/session', { cache: 'no-store' });
    return { status: response.status, body: await response.json() };
  });
  expect(result.status).toBe(200);
  const body = result.body as { csrfToken?: unknown };
  expect(typeof body.csrfToken).toBe('string');
  return body.csrfToken as string;
}

async function postJson(page: Page, path: string, csrfToken: string, body: Record<string, unknown>) {
  return page.evaluate(async (input) => {
    const response = await fetch(input.path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': input.csrfToken },
      body: JSON.stringify(input.body),
      cache: 'no-store',
    });
    return { status: response.status, body: await response.json() };
  }, { path, csrfToken, body });
}

function dashboardAction(action: PendingAction): asserts action is PendingAction & {
  payload: Extract<PendingAction['payload'], { kind: 'dashboard_create' }>;
} {
  expect(action.payload.kind).toBe('dashboard_create');
}

test('real chat creates Action A, revision supersedes A, and only B confirmation creates one dashboard', async ({ page }) => {
  test.setTimeout(120_000);

  const postedPaths: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') postedPaths.push(new URL(request.url()).pathname);
  });

  expect((await page.request.get('/api/session', { timeout: 60_000 })).status()).toBe(401);
  await page.goto('/');
  await expect(page.getByLabel('โปรไฟล์')).toBeVisible();
  await page.getByLabel('โปรไฟล์').selectOption('executive');
  await page.getByLabel('รหัสเข้าใช้งาน').fill('nexus-test-access');
  await page.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true }).click();

  const modeSwitch = page.getByRole('switch', { name: 'เปลี่ยนโหมดการทำงาน' });
  await expect(modeSwitch).toBeVisible();
  await expect(modeSwitch).toBeChecked();
  await modeSwitch.click();
  await expect(modeSwitch).not.toBeChecked();
  const initial = await readWorkspace(page);
  expect(initial.actor.role).toBe('executive');
  expect(initial.actor.mode).toBe('scripted_demo');

  const actionIdsBeforeChat = new Set(initial.actions.map((action) => action.id));
  const streamResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/chat/stream' && response.request().method() === 'POST';
  }, { timeout: 30_000 });
  // Demo turns are bound by card id (typed text is never interpreted); in Demo the proposal stays pending for review.
  await page.locator('button[data-showcase-id="executive-dashboard"]').first().click();
  const streamResponse = await streamResponsePromise;
  expect(streamResponse.status()).toBe(200);
  expect(streamResponse.headers()['content-type']).toContain('text/event-stream');

  await expect.poll(async () => {
    const workspace = await readWorkspace(page);
    return workspace.actions.filter((action) => !actionIdsBeforeChat.has(action.id) &&
      action.status === 'pending' && action.payload.kind === 'dashboard_create').length;
  }, { timeout: 15_000 }).toBe(1);
  const afterChat = await readWorkspace(page);
  expect(afterChat.messages.some((message) => message.role === 'user' && message.text === dashboardCard.prompt)).toBe(true);
  const actionA = afterChat.actions.find((action) => !actionIdsBeforeChat.has(action.id) &&
    action.status === 'pending' && action.payload.kind === 'dashboard_create');
  expect(actionA).toBeTruthy();
  dashboardAction(actionA!);
  const specA = actionA.payload.spec;
  expect(specA.widgets.length).toBeGreaterThan(1);

  const dashboardsBeforeRevision = afterChat.dashboards.length;
  const dashboardReceiptsBeforeRevision = afterChat.receipts.filter((receipt) => receipt.kind === 'dashboard_create').length;
  const removeIndex = specA.widgets.length - 1;
  const removedWidget = specA.widgets[removeIndex]!;
  const nextTitle = `${specA.title} revised`;
  const patch = { title: nextTitle, widgetChange: { operation: 'remove', indexes: [removeIndex] } };
  const csrfToken = await readCsrfToken(page);

  const revisionResponse = await postJson(page, `/api/actions/${encodeURIComponent(actionA.id)}/revise`, csrfToken, {
    requestKey: randomUUID(),
    patch,
  });
  expect(revisionResponse.status).toBe(200);
  const revision = revisionResponse.body as RevisionResponse;
  const actionB = revision.replacement;
  expect(revision.predecessor).toMatchObject({
    id: actionA.id,
    status: 'stale',
    staleReason: 'superseded',
    supersededByActionId: actionB.id,
    payload: actionA.payload,
    payloadHash: actionA.payloadHash,
  });
  expect(actionB).toMatchObject({
    predecessorActionId: actionA.id,
    status: 'pending',
    payload: {
      kind: 'dashboard_create',
      spec: {
        ...specA,
        title: nextTitle,
        widgets: specA.widgets.filter((_, index) => index !== removeIndex),
      },
    },
  });
  expect(actionB.revisionDiff).toEqual(revision.diff);
  expect(revision.diff).toHaveLength(3);
  expect(revision.diff[0]).toBe(`เปลี่ยนชื่อ: ${JSON.stringify(specA.title)} → ${JSON.stringify(nextTitle)}`);
  expect(revision.diff[1]).toContain(`ลบ: ${JSON.stringify(removedWidget.title)} [`);
  expect(revision.diff[1]).toContain(`ตำแหน่งเดิม ${removeIndex + 1}`);
  expect(revision.diff[2]).toBe(`คงเดิม: ${specA.widgets.length - 1} มุมมอง`);
  expect((await readWorkspace(page)).dashboards).toHaveLength(dashboardsBeforeRevision);
  expect((await readWorkspace(page)).receipts.filter((receipt) => receipt.kind === 'dashboard_create'))
    .toHaveLength(dashboardReceiptsBeforeRevision);

  const confirmA = await postJson(page, `/api/actions/${encodeURIComponent(actionA.id)}/confirm`, csrfToken, {});
  expect(confirmA.status).toBe(409);
  expect((confirmA.body as { error?: { code?: string } }).error?.code).toBe('STALE_ACTION');
  const afterRejectedA = await readWorkspace(page);
  expect(afterRejectedA.dashboards).toHaveLength(dashboardsBeforeRevision);
  expect(afterRejectedA.receipts.filter((receipt) => receipt.kind === 'dashboard_create'))
    .toHaveLength(dashboardReceiptsBeforeRevision);

  const confirmB = await postJson(page, `/api/actions/${encodeURIComponent(actionB.id)}/confirm`, csrfToken, {});
  expect(confirmB.status).toBe(200);
  const receiptB = confirmB.body as { id: string; actionId: string; kind: string; status: string };
  expect(receiptB).toMatchObject({ actionId: actionB.id, kind: 'dashboard_create', status: 'verified_success' });
  const afterConfirmB = await readWorkspace(page);
  expect(afterConfirmB.dashboards).toHaveLength(dashboardsBeforeRevision + 1);
  expect(afterConfirmB.receipts.filter((receipt) => receipt.kind === 'dashboard_create'))
    .toHaveLength(dashboardReceiptsBeforeRevision + 1);
  expect(afterConfirmB.receipts.filter((receipt) => receipt.actionId === actionB.id)).toHaveLength(1);
  expect(afterConfirmB.dashboards.filter((dashboard) => dashboard.spec.title === nextTitle)).toHaveLength(1);

  const duplicateConfirmB = await postJson(page, `/api/actions/${encodeURIComponent(actionB.id)}/confirm`, csrfToken, {});
  expect(duplicateConfirmB.status).toBe(200);
  expect(duplicateConfirmB.body).toMatchObject({ id: receiptB.id, actionId: actionB.id, status: 'verified_success' });
  await page.reload();
  const refreshed = await readWorkspace(page);
  expect(refreshed.actor.mode).toBe('scripted_demo');
  expect(refreshed.actions.find((action) => action.id === actionA.id)).toMatchObject({ status: 'stale', staleReason: 'superseded' });
  expect(refreshed.actions.find((action) => action.id === actionB.id)?.status).toBe('completed');
  expect(refreshed.dashboards).toHaveLength(dashboardsBeforeRevision + 1);
  expect(refreshed.dashboards.filter((dashboard) => dashboard.spec.title === nextTitle)).toHaveLength(1);
  expect(refreshed.receipts.filter((receipt) => receipt.kind === 'dashboard_create'))
    .toHaveLength(dashboardReceiptsBeforeRevision + 1);
  expect(refreshed.receipts.filter((receipt) => receipt.actionId === actionB.id)).toHaveLength(1);

  await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
  await expect(page.getByText(nextTitle, { exact: true })).toBeVisible();

  expect(postedPaths.filter((path) => path === '/api/chat/stream')).toHaveLength(1);
  expect(postedPaths.filter((path) => path === `/api/actions/${actionA.id}/revise`)).toHaveLength(1);
  expect(postedPaths.filter((path) => path === `/api/actions/${actionA.id}/confirm`)).toHaveLength(1);
  expect(postedPaths.filter((path) => path === `/api/actions/${actionB.id}/confirm`)).toHaveLength(2);
  expect(removedWidget).toEqual(specA.widgets[removeIndex]);
});
