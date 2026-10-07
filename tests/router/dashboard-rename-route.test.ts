import { beforeEach, describe, expect, it, vi } from 'vitest';

const deps = vi.hoisted(() => ({ getStore: vi.fn(), actorSession: vi.fn(), checkCsrf: vi.fn(), rateLimit: vi.fn(), trustedClientIp: vi.fn(), editDashboardUi: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/storage', () => ({ getStore: deps.getStore }));
vi.mock('@/lib/server/session', () => ({ actorSession: deps.actorSession, checkCsrf: deps.checkCsrf, rateLimit: deps.rateLimit, trustedClientIp: deps.trustedClientIp }));
vi.mock('@/lib/core/service', () => ({ ConciergeService: class { editDashboardUi = deps.editDashboardUi; } }));

import { NextRequest } from 'next/server';
import { DomainError } from '@/lib/core/errors';
import { PATCH } from '@/app/api/dashboards/[id]/route';
import { DASHBOARD_CHANGED_TEXT, renameDashboardRequest } from '@/components/biztania/router-ui';

const call = (body: unknown) => PATCH(new NextRequest('http://localhost/api/dashboards/D1', { method: 'PATCH', body: JSON.stringify(body) }), { params: Promise.resolve({ id: 'D1' }) });
beforeEach(() => {
  Object.values(deps).forEach(fn => fn.mockReset());
  deps.getStore.mockResolvedValue({});
  deps.actorSession.mockResolvedValue({ actor: { id: 'a' }, session: { id: 's' } });
  deps.trustedClientIp.mockReturnValue('ip');
});

describe('G3 PATCH /api/dashboards/[id] is a CAS on the loaded revision', () => {
  it('requires baseRevision (400) and forwards it as the expected revision', async () => {
    expect((await call({ title: 'X' })).status).toBe(400);
    expect(deps.editDashboardUi).not.toHaveBeenCalled();
    deps.editDashboardUi.mockResolvedValue({ outcome: 'updated', view: { ok: true } });
    expect((await call({ title: 'X', baseRevision: 'rev-1' })).status).toBe(200);
    expect(deps.editDashboardUi).toHaveBeenCalledWith({ id: 'a' }, 'D1', { kind: 'rename', title: 'X', baseRevision: 'rev-1' });
  });
  it('maps a stale revision to 409 DASHBOARD_CHANGED with the Thai copy', async () => {
    deps.editDashboardUi.mockRejectedValue(new DomainError('DASHBOARD_CHANGED', DASHBOARD_CHANGED_TEXT, 409));
    const response = await call({ title: 'X', baseRevision: 'old' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'DASHBOARD_CHANGED', message: DASHBOARD_CHANGED_TEXT } });
  });
});

describe('G3 shared Dashboard: the PATCH returns the staged proposal instead of a silent write', () => {
  it('passes the staged outcome through (the page opens the confirm dialog)', async () => {
    deps.editDashboardUi.mockResolvedValue({ outcome: 'staged', proposalId: 'stg_1', preview: 'p', expiresAt: 1 });
    const response = await call({ title: 'X', baseRevision: 'rev-1' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: 'staged', proposalId: 'stg_1', preview: 'p', expiresAt: 1 });
    const request = vi.fn(async () => ({ outcome: 'staged', proposalId: 'stg_1', preview: 'p', expiresAt: 1 }));
    expect(await renameDashboardRequest(request as never, 'csrf', 'D1', 'X', 'rev-1')).toEqual({ status: 'staged', proposalId: 'stg_1', preview: 'p' });
  });
});

describe('G3 client helper renameDashboardRequest', () => {
  it('sends the loaded revision', async () => {
    const request = vi.fn(async () => ({ revision: 'rev-2' }));
    expect(await renameDashboardRequest(request as never, 'csrf', 'D 1', 'New', 'rev-1')).toEqual({ status: 'renamed', view: { revision: 'rev-2' } });
    expect(request).toHaveBeenCalledWith('/api/dashboards/D%201', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ title: 'New', baseRevision: 'rev-1' }) }));
  });
  it('on DASHBOARD_CHANGED it reloads the dashboard and reports a conflict with the Thai message; other errors propagate', async () => {
    const request = vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') throw Object.assign(new Error('x'), { code: 'DASHBOARD_CHANGED', status: 409 });
      return { revision: 'fresh' };
    });
    expect(await renameDashboardRequest(request as never, 'csrf', 'D1', 'New', 'old')).toEqual({ status: 'conflict', view: { revision: 'fresh' }, message: DASHBOARD_CHANGED_TEXT });
    await expect(renameDashboardRequest((async () => { throw Object.assign(new Error('boom'), { code: 'X' }); }) as never, 'c', 'D1', 'N', 'r')).rejects.toThrow('boom');
  });
});
