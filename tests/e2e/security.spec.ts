import { expect, test } from '@playwright/test';

type CsrfVariant = 'missing-origin' | 'wrong-origin' | 'missing-csrf' | 'wrong-csrf';
type E2EWorkspace = {
  actor: { id: string; mode: string; modeRevision: number };
  csrfToken: string;
  dashboards: Array<{ id: string }>;
  actions: Array<{ id: string; status: string; payloadHash: string }>;
  receipts: unknown[];
  messages: Array<{
    id: string;
    role: string;
    text: string;
    pendingActionId?: string;
    receiptId?: string;
  }>;
  audit: unknown[];
};

const csrfVariants: CsrfVariant[] = [
  'missing-origin',
  'wrong-origin',
  'missing-csrf',
  'wrong-csrf',
];

async function sendRequest(
  page: import('@playwright/test').Page,
  origin: string,
  csrfToken: string,
  path: string,
  method: string,
  variant: CsrfVariant | 'valid',
  body?: Record<string, unknown>,
) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (variant !== 'missing-origin') {
    headers.origin = variant === 'wrong-origin' ? 'https://attacker.invalid' : origin;
  }
  if (variant !== 'missing-csrf') {
    headers['x-csrf-token'] = variant === 'wrong-csrf' ? 'wrong-csrf-token' : csrfToken;
  }
  return page.request.fetch(new URL(path, origin).toString(), {
    method,
    headers,
    ...(body === undefined ? {} : { data: body }),
  });
}

async function readWorkspace(page: import('@playwright/test').Page, origin: string) {
  const response = await page.request.get(new URL('/api/workspace', origin).toString());
  expect(response.status()).toBe(200);
  return response.json() as Promise<E2EWorkspace>;
}

async function assertUnauthenticatedWorkspaceReady(page: import('@playwright/test').Page, origin: string) {
  const url = new URL('/api/workspace', origin).toString();
  let lastFailure: Error | undefined;

  // The read-only route may still be compiling after session setup. Bound two long GETs; only reset/timeout
  // transport failures are retryable, and every HTTP response must still be 401.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await page.request.get(url, { timeout: 30_000 }).catch((error: unknown) => {
      if (error instanceof Error && (error.message.includes('ECONNRESET') || error.name === 'TimeoutError')) {
        lastFailure = error;
        return null;
      }
      throw error;
    });
    if (response) {
      expect(response.status()).toBe(401);
      return;
    }
    if (attempt < 1) await page.waitForTimeout(250);
  }

  throw new Error(`Unauthenticated workspace GET did not become ready: ${lastFailure?.message ?? 'transport failure'}`);
}

async function observableState(page: import('@playwright/test').Page, origin: string) {
  const workspace = await readWorkspace(page, origin);
  return {
    actor: {
      id: workspace.actor.id,
      mode: workspace.actor.mode,
      modeRevision: workspace.actor.modeRevision,
    },
    dashboards: workspace.dashboards.map((dashboard: { id: string }) => dashboard.id),
    actions: workspace.actions.map((action: { id: string; status: string; payloadHash: string }) => ({
      id: action.id,
      status: action.status,
      payloadHash: action.payloadHash,
    })),
    receipts: workspace.receipts,
    messages: workspace.messages.map((message) => ({
      id: message.id,
      role: message.role,
      text: message.text,
      pendingActionId: message.pendingActionId,
      receiptId: message.receiptId,
    })),
    audit: workspace.audit,
  };
}

test('rejects missing or invalid origin and CSRF on protected actions without effects', async ({ page }) => {
  test.setTimeout(120_000);
  const sessionReady = await page.request.get('/api/session', { timeout: 60_000 });
  expect(sessionReady.status()).toBe(401);
  await page.goto('/');
  const origin = new URL(page.url()).origin;
  const loginUrl=new URL('/api/session',page.url()).toString();
  await assertUnauthenticatedWorkspaceReady(page, origin);
  for(const requestOrigin of [undefined,'https://attacker.invalid']){
    const response=await page.request.post(loginUrl,{headers:requestOrigin?{origin:requestOrigin}:{},data:{profileId:'executive',accessCode:'nexus-test-access'}});
    expect(response.status()).toBe(403);
    expect((await response.json()).error.code).toBe('CSRF');
    expect((await page.context().cookies()).some(cookie=>cookie.name==='biztania_session')).toBe(false);
    await assertUnauthenticatedWorkspaceReady(page, origin);
  }
  await page.getByLabel('โปรไฟล์').selectOption('executive');
  await page.getByLabel('รหัสเข้าใช้งาน').fill('nexus-test-access');
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
  await expect(
    page.getByRole('region', { name: 'บทสนทนากับ DaTex', exact: true }),
  ).toBeVisible();

  let workspace = await readWorkspace(page, origin);
  const csrfToken = workspace.csrfToken as string;
  expect(csrfToken.length).toBeGreaterThan(0);

  // Router turns need Live AI (typed text is never interpreted in Demo): the executive starts in live_ai.
  expect(workspace.actor.mode).toBe('live_ai');
  const dashboardOne = await sendRequest(page, origin, csrfToken, '/api/chat', 'POST', 'valid', { message: 'Create dashboard.' });
  expect(dashboardOne.status()).toBe(200);
  const shareOneResponse = await sendRequest(page, origin, csrfToken, '/api/chat', 'POST', 'valid', {
    message: 'Share dashboard with East manager.',
  });
  expect(shareOneResponse.status()).toBe(200);
  const firstProposal = await shareOneResponse.json();
  expect(firstProposal.pendingAction?.id).toBeTruthy();
  expect(firstProposal.pendingAction.status).toBe('pending');

  const confirmedResponse = await sendRequest(
    page,
    origin,
    csrfToken,
    '/api/actions/' + firstProposal.pendingAction.id + '/confirm',
    'POST',
    'valid',
    {},
  );
  expect(confirmedResponse.status()).toBe(200);
  const confirmed = await confirmedResponse.json();
  expect(confirmed.status).toBe('verified_success');

  // A second dashboard (different share target) gives an independent, still-pending confirm-tier proposal.
  const dashboardTwo = await sendRequest(page, origin, csrfToken, '/api/chat', 'POST', 'valid', { message: 'Create a sales dashboard' });
  expect(dashboardTwo.status()).toBe(200);
  const secondProposalResponse = await sendRequest(page, origin, csrfToken, '/api/chat', 'POST', 'valid', {
    message: 'Share dashboard with East manager.',
  });
  expect(secondProposalResponse.status()).toBe(200);
  const secondProposal = await secondProposalResponse.json();
  expect(secondProposal.pendingAction?.id).toBeTruthy();
  expect(secondProposal.pendingAction.status).toBe('pending');

  const switched = await sendRequest(page, origin, csrfToken, '/api/session', 'PATCH', 'valid', {
    mode: 'scripted_demo',
  });
  expect(switched.status()).toBe(200);

  const scenarioResponse = await sendRequest(page, origin, csrfToken, '/api/demo/scenario', 'POST', 'valid', {
    scenario: 'stock_recovered',
  });
  expect(scenarioResponse.status()).toBe(200);
  const scenarioProposal = await scenarioResponse.json();
  expect(scenarioProposal.id).toBeTruthy();

  const protectedRequests = [
    {
      label: 'chat',
      path: '/api/chat',
      method: 'POST',
      body: { message: 'Compare sales in East on 2026-10-01.' },
    },
    {
      label: 'confirm',
      path: '/api/actions/' + secondProposal.pendingAction.id + '/confirm',
      method: 'POST',
      body: {},
    },
    {
      label: 'reconcile',
      path: '/api/executions/' + confirmed.id + '/reconcile',
      method: 'POST',
      body: {},
    },
    {
      label: 'scenario',
      path: '/api/demo/scenario',
      method: 'POST',
      body: { scenario: 'payment_resolved' },
    },
    {
      label: 'mode',
      path: '/api/session',
      method: 'PATCH',
      body: { mode: 'live_ai' },
    },
    {
      label: 'logout',
      path: '/api/session',
      method: 'DELETE',
      body: undefined,
    },
  ] as const;

  for (const operation of protectedRequests) {
    for (const variant of csrfVariants) {
      const before = await observableState(page, origin);
      const response = await sendRequest(
        page,
        origin,
        csrfToken,
        operation.path,
        operation.method,
        variant,
        operation.body,
      );
      expect(response.status(), operation.label + ' should reject ' + variant).toBe(403);
      expect((await response.json()).error.code, operation.label + ' error for ' + variant).toBe('CSRF');
      expect(await observableState(page, origin), operation.label + ' should have no effects for ' + variant).toEqual(before);
    }
  }

  workspace = await readWorkspace(page, origin);
  const beforeForgedMode = await observableState(page, origin);
  const forgedMode = await sendRequest(page, origin, csrfToken, '/api/chat', 'POST', 'valid', {
    message: 'Compare sales in East on 2026-10-01.',
    mode: 'live_ai',
  });
  expect(forgedMode.status()).toBe(400);
  expect((await forgedMode.json()).error.code).toBe('INVALID_INPUT');
  expect(await observableState(page, origin)).toEqual(beforeForgedMode);
  expect(workspace.actor.mode).toBe('scripted_demo');
});
