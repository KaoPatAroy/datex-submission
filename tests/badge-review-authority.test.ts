import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Actor, Badge, Branch, Employee, PendingAction, Reader, Store, Transaction } from '../lib/contracts';
import { ConciergeService } from '../lib/core/service';
import { digest } from '../lib/core/utils';
import { actors, BUSINESS_DATE, createWorkspaceFixture, FIXED_NOW } from './helpers/workspace';

const payload = { kind: 'badge_revoke' as const, badgeId: 'C102', employeeId: 'E024', reason: 'Lost badge reported by employee' };

function rehash(action: PendingAction): PendingAction {
  const { actorId, sessionId, mode, modeRevision, payload, evidenceVersion, packs, expiresAt,
    receiptAccess, releaseRevision, actionContractVersion, approvalScope, approvalDisplay } = action;
  return { ...action, payloadHash: digest({ actorId, sessionId, mode, modeRevision, payload, evidenceVersion,
    packs, expiresAt, receiptAccess, releaseRevision, actionContractVersion, approvalScope, approvalDisplay }) };
}

describe('server verified badge review authority', () => {
  let fixture: Awaited<ReturnType<typeof createWorkspaceFixture>>;
  beforeEach(async () => { fixture = await createWorkspaceFixture(); });
  afterEach(async () => { await fixture.dispose(); });

  async function patchEmployee(patch: Partial<Employee>) {
    await fixture.store.transaction(async tx => {
      const employee = await tx.get<Employee>('employees', 'E024');
      if (!employee) throw new Error('Missing synthetic employee');
      await tx.put('employees', { ...employee, ...patch });
    });
  }

  async function regionalActor(regions = ['east', 'central']): Promise<Actor> {
    const actor = { ...actors.east, permissions: [...actors.east.permissions, 'hr.read', 'badge.revoke'], regions };
    await fixture.store.transaction(tx => tx.put('profiles', actor));
    return actor;
  }

  // The SQLite adapter correctly makes approval bytes immutable. A read overlay models
  // pre-upgrade rows and corrupted upstream storage without disabling that protection.
  function serviceWithAction(overlay: PendingAction) {
    const reads = (reader: Reader): Reader => ({
      get: async <T>(table: Parameters<Reader['get']>[0], key: string) =>
        table === 'pending_actions' && key === overlay.id ? overlay as T : reader.get<T>(table, key),
      list: async <T>(table: Parameters<Reader['list']>[0], filters?: Parameters<Reader['list']>[1]) => {
        const rows = await reader.list<T>(table, filters);
        return table === 'pending_actions' ? rows.map(row => (row as { id: string }).id === overlay.id ? overlay as T : row) : rows;
      },
    });
    const store: Store = { ...fixture.store, ...reads(fixture.store),
      transaction: <T>(work: (tx: Transaction) => Promise<T>) => fixture.store.transaction(tx => work({ ...tx, ...reads(tx) })),
    };
    return new ConciergeService(store, { businessDate: BUSINESS_DATE, now: () => new Date(FIXED_NOW) });
  }

  it('stores authorized employee and branch identity and returns a transient exact-hash current review without writes', async () => {
    const action = await fixture.service.prepare(actors.hr, payload);
    expect(action.approvalDisplay).toEqual({
      badge: { employeeId: 'E024', employeeName: 'Synthetic Employee E024', employeeBranchId: 'E02',
        badgeId: 'C102', state: 'active', version: 1, updatedAt: '2026-10-01T06:00:00.000Z' },
      branches: [{ id: 'E02', name: 'East Two' }],
    });
    const before = await fixture.store.list('pending_actions');
    const audits = await fixture.store.list('audit_events');
    const workspace = await fixture.service.getWorkspace(actors.hr);
    expect(workspace.badgeReviews?.[action.id]).toEqual({
      payloadHash: action.payloadHash, checkedAt: FIXED_NOW.toISOString(), status: 'current',
      current: { employeeName: 'Synthetic Employee E024', badgeState: 'active', badgeVersion: 1, updatedAt: '2026-10-01T06:00:00.000Z' },
    });
    expect(await fixture.store.list('pending_actions')).toEqual(before);
    expect(await fixture.store.list('audit_events')).toEqual(audits);
    expect(await fixture.store.list('action_executions')).toEqual([]);
    expect(await fixture.store.get('mock_badges', 'C102')).toMatchObject({ state: 'active', version: 1 });
    expect(action.receiptAccess?.regions).toEqual(['east']);
  });

  const changes: Array<[string, (tx: Transaction) => Promise<void>]> = [
    ['badge version', async tx => {
      const badge = await tx.get<Badge>('mock_badges', 'C102');
      await tx.put('mock_badges', { ...badge!, version: badge!.version + 1 });
    }],
    ['employee name', async tx => {
      const employee = await tx.get<Employee>('employees', 'E024');
      await tx.put('employees', { ...employee!, name: 'Updated Stored Name' });
    }],
    ['employee branch assignment', async tx => {
      const employee = await tx.get<Employee>('employees', 'E024');
      await tx.put('employees', { ...employee!, branchId: 'C01' });
    }],
    ['employee activity', async tx => {
      const employee = await tx.get<Employee>('employees', 'E024');
      await tx.put('employees', { ...employee!, active: false });
    }],
    ['resolved branch name', async tx => {
      const branch = await tx.get<Branch>('branches', 'E02');
      await tx.put('branches', { ...branch!, name: 'Renamed East Branch' });
    }],
    ['resolved branch region', async tx => {
      const branch = await tx.get<Branch>('branches', 'E02');
      await tx.put('branches', { ...branch!, region: 'central' });
    }],
  ];

  it.each(changes)('rejects %s drift after a current review and reports stale without changing the proposal', async (_name, change) => {
    const action = await fixture.service.prepare(actors.hr, payload);
    expect((await fixture.service.getWorkspace(actors.hr)).badgeReviews?.[action.id]?.status).toBe('current');
    await fixture.store.transaction(change);
    const workspace = await fixture.service.getWorkspace(actors.hr);
    expect(workspace.badgeReviews?.[action.id]?.status).toBe('stale');
    expect(workspace.actions.find(row => row.id === action.id)?.approvalDisplay).toEqual(action.approvalDisplay);
    await expect(fixture.service.confirm(actors.hr, action.id)).rejects.toBeDefined();
    expect((await fixture.store.get<Badge>('mock_badges', 'C102'))?.state).toBe('active');
    expect(await fixture.store.list('action_executions')).toEqual([]);
  });

  it('uses stored identity at preparation after an earlier lookup or caller expectation becomes outdated', async () => {
    await patchEmployee({ name: 'Current Stored Name', branchId: 'C01' });
    const action = await fixture.service.prepare(actors.hr, payload);
    expect(action.approvalDisplay).toMatchObject({
      badge: { employeeName: 'Current Stored Name', employeeBranchId: 'C01' },
      branches: [{ id: 'C01', name: 'Central Confidential Branch' }],
    });
    expect((await fixture.service.getWorkspace(actors.hr)).badgeReviews?.[action.id]?.status).toBe('current');
  });

  it('denies an out-of-region actor even with both HR permissions and never publishes the identity', async () => {
    const actor = await regionalActor(['east']);
    await patchEmployee({ branchId: 'C01', name: 'Private Central Employee' });
    await expect(fixture.service.prepare(actor, payload)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const workspace = await fixture.service.getWorkspace(actor);
    expect(workspace.actions).toEqual([]);
    expect(JSON.stringify(workspace)).not.toContain('Private Central Employee');
    expect(await fixture.store.list('pending_actions')).toEqual([]);
  });

  it('reloads narrowed scope and redacts pending identity and linked assistant history', async () => {
    const actor = await regionalActor();
    await patchEmployee({ branchId: 'C01', name: 'Private Central Employee' });
    const action = await fixture.service.prepare(actor, payload);
    expect((await fixture.service.getWorkspace(actor)).badgeReviews?.[action.id]?.status).toBe('current');
    await regionalActor(['east']);
    const workspace = await fixture.service.getWorkspace(actor);
    expect(workspace.actions).toEqual([]);
    expect(workspace.badgeReviews?.[action.id]).toBeUndefined();
    expect(workspace.messages.find(message => message.turnId === action.turnId)?.text).toBe('ประวัตินี้อยู่นอกสิทธิ์ปัจจุบัน');
    expect(JSON.stringify(workspace)).not.toContain('Private Central Employee');
    await expect(fixture.service.confirm(actor, action.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('retains authorized completed history but restricts its receipt and old display after reassignment and scope narrowing', async () => {
    const actor = await regionalActor();
    await patchEmployee({ branchId: 'C01', name: 'Private Central Employee' });
    const action = await fixture.service.prepare(actor, payload);
    const receipt = await fixture.service.confirm(actor, action.id);
    expect(receipt).toMatchObject({ status: 'verified_success', visibility: 'full' });
    expect((await fixture.service.getWorkspace(actor)).actions.find(row => row.id === action.id)?.status).toBe('completed');
    await patchEmployee({ branchId: 'E02', name: 'New East Name' });
    await regionalActor(['east']);
    const workspace = await fixture.service.getWorkspace(actor);
    expect(workspace.actions).toEqual([]);
    expect(workspace.receipts).toContainEqual(expect.objectContaining({ id: receipt.id, visibility: 'restricted', results: [] }));
    expect(await fixture.service.confirm(actor, action.id)).toMatchObject({ visibility: 'restricted', results: [] });
    expect(JSON.stringify(workspace)).not.toContain('Private Central Employee');
  });

  it('pins the original branch region for historical redaction when the branch itself moves regions', async () => {
    const actor = await regionalActor();
    await patchEmployee({ branchId: 'C01', name: 'Private Central Employee' });
    const action = await fixture.service.prepare(actor, payload);
    await fixture.service.confirm(actor, action.id);
    expect(action.receiptAccess?.regions).toEqual(['central']);
    await fixture.store.transaction(tx => tx.put('branches', { id: 'C01', name: 'Now East Branch', region: 'east' }));
    await regionalActor(['east']);
    const workspace = await fixture.service.getWorkspace(actor);
    expect(workspace.actions).toEqual([]);
    expect(workspace.receipts[0]).toMatchObject({ visibility: 'restricted', results: [] });
    expect(JSON.stringify(workspace)).not.toContain('Private Central Employee');
  });

  it.each(['missing', 'incomplete', 'tampered'] as const)('refuses %s approval display even when a legacy row has a consistent approval hash', async variant => {
    const action = await fixture.service.prepare(actors.hr, payload);
    const approvalDisplay = variant === 'missing' ? undefined : variant === 'incomplete'
      ? { badge: action.approvalDisplay!.badge }
      : { ...action.approvalDisplay, badge: { ...action.approvalDisplay!.badge!, employeeName: 'Not the stored employee' } };
    const legacy = rehash({ ...action, approvalDisplay });
    const service = serviceWithAction(legacy);
    const review = (await service.getWorkspace(actors.hr)).badgeReviews?.[action.id];
    expect(review?.status).toBe(variant === 'missing' ? 'unavailable' : 'stale');
    expect(review?.status).not.toBe('current');
    await expect(service.confirm(actors.hr, action.id)).rejects.toMatchObject({ code: 'STALE_ACTION' });
    expect((await fixture.store.get<Badge>('mock_badges', 'C102'))?.state).toBe('active');
  });

  it('hides a display altered without the server approval hash and redacts its assistant anchor', async () => {
    const action = await fixture.service.prepare(actors.hr, payload);
    const service = serviceWithAction({ ...action,
      approvalDisplay: { ...action.approvalDisplay, badge: { ...action.approvalDisplay!.badge!, employeeName: 'Tampered Identity' } } });
    const workspace = await service.getWorkspace(actors.hr);
    expect(workspace.actions).toEqual([]);
    expect(workspace.badgeReviews?.[action.id]).toBeUndefined();
    expect(JSON.stringify(workspace)).not.toContain('Tampered Identity');
    await expect(service.confirm(actors.hr, action.id)).rejects.toMatchObject({ code: 'STALE_ACTION' });
  });

  it('reads a completed V1 row without badge display without replaying its business write', async () => {
    const action = await fixture.service.prepare(actors.hr, payload);
    const legacyEvidenceVersion = digest(await fixture.store.get('mock_badges', 'C102'));
    await fixture.service.confirm(actors.hr, action.id);
    const stored = await fixture.store.get<PendingAction>('pending_actions', action.id);
    const service = serviceWithAction(rehash({ ...stored!, approvalDisplay: {}, evidenceVersion: legacyEvidenceVersion, releaseRevision: 'legacy-v1-release' }));
    const before = await fixture.store.get<Badge>('mock_badges', 'C102');
    const workspace = await service.getWorkspace(actors.hr);
    expect(workspace.actions.find(row => row.id === action.id)?.status).toBe('completed');
    expect(workspace.badgeReviews?.[action.id]?.status).toBe('unavailable');
    expect(await service.confirm(actors.hr, action.id)).toMatchObject({ visibility: 'full', status: 'verified_success' });
    expect(await fixture.store.get('mock_badges', 'C102')).toEqual(before);
  });

  it('confirms once and returns the same verified receipt for duplicate confirmations', async () => {
    const action = await fixture.service.prepare(actors.hr, payload);
    const receipts = await Promise.all([fixture.service.confirm(actors.hr, action.id), fixture.service.confirm(actors.hr, action.id)]);
    expect(receipts[0].id).toBe(receipts[1].id);
    expect(receipts.every(receipt => receipt.status === 'verified_success')).toBe(true);
    expect(await fixture.store.get('mock_badges', 'C102')).toMatchObject({ state: 'revoked', version: 2 });
    expect(await fixture.store.list('action_executions')).toHaveLength(1);
  });

  it('preserves completed receipt read access when revoke permission is removed but HR read scope remains', async () => {
    const action = await fixture.service.prepare(actors.hr, payload);
    await fixture.service.confirm(actors.hr, action.id);
    await fixture.store.transaction(tx => tx.put('profiles', { ...actors.hr, permissions: ['hr.read'] }));
    expect(await fixture.service.confirm(actors.hr, action.id)).toMatchObject({ status: 'verified_success', visibility: 'full' });
    expect((await fixture.service.getWorkspace(actors.hr)).receipts[0]).toMatchObject({ status: 'verified_success', visibility: 'full' });
    expect(await fixture.store.get('mock_badges', 'C102')).toMatchObject({ state: 'revoked', version: 2 });
  });

  it('rechecks evidence in the execution transaction after a successful claim', async () => {
    let changed = false;
    const store: Store = { ...fixture.store,
      transaction: async <T>(work: (tx: Transaction) => Promise<T>) => {
        const result = await fixture.store.transaction(work);
        if (!changed && (await fixture.store.list('action_executions')).length) {
          changed = true;
          await patchEmployee({ name: 'Changed after claim' });
        }
        return result;
      },
    };
    const service = new ConciergeService(store, { businessDate: BUSINESS_DATE, now: () => new Date(FIXED_NOW) });
    const action = await service.prepare(actors.hr, payload);
    expect((await service.getWorkspace(actors.hr)).badgeReviews?.[action.id]?.status).toBe('current');
    expect(await service.confirm(actors.hr, action.id)).toMatchObject({ status: 'failed' });
    expect(await fixture.store.get('mock_badges', 'C102')).toMatchObject({ state: 'active', version: 1 });
  });

  it('handles unassigned employees only for global HR and disallows revoked badge preparation', async () => {
    await patchEmployee({ branchId: null });
    const regional = await regionalActor();
    await expect(fixture.service.prepare(regional, payload)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const action = await fixture.service.prepare(actors.hr, payload);
    expect(action.approvalDisplay?.branches).toEqual([]);
    expect((await fixture.service.getWorkspace(actors.hr)).badgeReviews?.[action.id]?.status).toBe('current');
    await expect(fixture.service.prepare(actors.hr, { ...payload, badgeId: 'C103', employeeId: 'E025' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('makes a removed target unavailable without publishing its stored identity or permitting confirmation', async () => {
    const action = await fixture.service.prepare(actors.hr, payload);
    await fixture.store.transaction(tx => tx.remove('mock_badges', payload.badgeId));
    const workspace = await fixture.service.getWorkspace(actors.hr);
    expect(workspace.actions.some(row => row.id === action.id)).toBe(false);
    expect(workspace.badgeReviews?.[action.id]).toBeUndefined();
    await expect(fixture.service.confirm(actors.hr, action.id)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await fixture.store.list('action_executions')).toEqual([]);
  });
});
