import { describe, expect, it } from 'vitest';
import type { AuditEvent, Badge, Store, Table, Ticket, Transaction } from '../lib/contracts';
import { ConciergeService } from '../lib/core/service';
import { createSeedData } from '../lib/seed/generate';
import { WorkflowStorageError } from '../lib/storage/sqlite';
import {
  actors,
  BUSINESS_DATE,
  CLOSED_BUSINESS_DATE,
  createWorkspaceFixture,
  FIXED_NOW,
  loseOneTicketCommitResponse,
} from './helpers/workspace';
import { createWorkflowSqliteFixture } from './helpers/workflow-storage';

async function createBadgeServiceFixture() {
  const fixture = await createWorkflowSqliteFixture();
  try {
    const seed = createSeedData(BUSINESS_DATE);
    const branch = seed.branches.find((row) => row.id === 'E02');
    const employee = seed.employees.find((row) => row.id === 'E024');
    const badge = seed.mock_badges.find((row) => row.id === 'C102');
    const hrProfile = seed.profiles.find((row) => row.id === 'hr');
    if (!branch || !employee || !badge || !hrProfile) throw new Error('Missing generated HR badge fixture rows.');

    await fixture.store.transaction(async (tx) => {
      await tx.put('branches', branch);
      await tx.put('employees', employee);
      await tx.put('mock_badges', badge);
    });
    await fixture.store.transaction(async (tx) => {
      await tx.put('profiles', hrProfile);
      await tx.put('sessions', {
        id: actors.hr.sessionId,
        profileId: actors.hr.id,
        mode: actors.hr.mode,
        modeRevision: actors.hr.modeRevision,
        csrfToken: 'private-legacy-commit-csrf',
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
    });

    const service = new ConciergeService(fixture.store, {
      businessDate: BUSINESS_DATE,
      now: () => new Date(FIXED_NOW),
    });
    return { ...fixture, service };
  } catch (error) {
    await fixture.dispose();
    throw error;
  }
}

function observeBadgeEffect(base: Store) {
  let badgeEffectWriteAttempts = 0;
  let executeAuditWriteAttempts = 0;
  const errors: unknown[] = [];

  const store: Store = {
    adapter: base.adapter,
    list: <T>(table: Table) => base.list<T>(table),
    get: <T>(table: Table, id: string) => base.get<T>(table, id),
    async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
      try {
        return await base.transaction((tx) => work({
          list: <R>(table: Table, filters?: Parameters<Transaction['list']>[1]) => tx.list<R>(table, filters),
          get: <R>(table: Table, id: string) => tx.get<R>(table, id),
          async put<R extends { id: string }>(table: Table, row: R): Promise<void> {
            const observed = row as { id: string; state?: unknown; category?: unknown };
            if (table === 'mock_badges' && observed.id === 'C102' && observed.state === 'revoked') badgeEffectWriteAttempts += 1;
            if (table === 'audit_events' && observed.category === 'execute') executeAuditWriteAttempts += 1;
            await tx.put(table, row);
          },
          remove: (table: Table, id: string) => tx.remove(table, id),
        }));
      } catch (error) {
        errors.push(error);
        throw error;
      }
    },
    close: () => base.close?.(),
  };

  return {
    store,
    badgeEffectWriteAttempts: () => badgeEffectWriteAttempts,
    executeAuditWriteAttempts: () => executeAuditWriteAttempts,
    errors: () => errors,
  };
}

function createBlindReadbackStore(base: Store & ReturnType<typeof loseOneTicketCommitResponse>): Store {
  let hideNextTicketRead = false;

  return {
    adapter: base.adapter,
    list: <T>(table: Table) => base.list<T>(table),
    get: <T>(table: Table, id: string) => base.get<T>(table, id),
    async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
      const commitsBefore = base.targetCommitCount();
      let wroteTicketTarget = false;
      try {
        return await base.transaction((tx) => work({
          list: <R>(table: Table, filters?: Parameters<Transaction['list']>[1]) => tx.list<R>(table, filters),
          get: async <R>(table: Table, id: string) => {
            if (hideNextTicketRead && table === 'mock_tickets') {
              hideNextTicketRead = false;
              return undefined;
            }
            return tx.get<R>(table, id);
          },
          put: <R extends { id: string }>(table: Table, row: R) => {
            if (table === 'mock_tickets') wroteTicketTarget = true;
            return tx.put(table, row);
          },
          remove: (table: Table, id: string) => tx.remove(table, id),
        }));
      } catch (error) {
        if (wroteTicketTarget && base.targetCommitCount() > commitsBefore) hideNextTicketRead = true;
        throw error;
      }
    },
    close: () => base.close?.(),
  };
}

describe('ConciergeService legacy target commit outcomes', () => {
  it('marks a badge receipt failed after a native deferred-FK COMMIT rejection and never replays the target', async () => {
    const fixture = await createBadgeServiceFixture();
    const nativeDb = fixture.openDatabase();
    try {
      nativeDb.pragma('foreign_keys = ON');
      nativeDb.exec(`
        CREATE TABLE legacy_commit_guard_parent (id TEXT PRIMARY KEY NOT NULL);
        CREATE TABLE legacy_commit_guard_child (
          parent_id TEXT NOT NULL REFERENCES legacy_commit_guard_parent(id) DEFERRABLE INITIALLY DEFERRED
        );
        CREATE TRIGGER reject_c102_badge_commit
        AFTER UPDATE OF payload ON mock_badges
        WHEN NEW.id = 'C102' AND json_extract(NEW.payload, '$.state') = 'revoked'
        BEGIN
          INSERT INTO legacy_commit_guard_child(parent_id) VALUES ('no-such-parent');
        END;
      `);
      expect(nativeDb.pragma('foreign_keys', { simple: true })).toBe(1);

      const observer = observeBadgeEffect(fixture.store);
      const service = new ConciergeService(observer.store, {
        businessDate: BUSINESS_DATE,
        now: () => new Date(FIXED_NOW),
      });
      const badgeBefore = await fixture.store.get<Badge>('mock_badges', 'C102');
      if (!badgeBefore) throw new Error('Missing C102 badge fixture.');
      const proposal = await service.prepare(actors.hr, {
        kind: 'badge_revoke',
        badgeId: 'C102',
        employeeId: 'E024',
        reason: 'Synthetic legacy commit-outcome regression fixture.',
      });
      const auditBaseline = await fixture.store.list<AuditEvent>('audit_events');

      const receipt = await service.confirm(actors.hr, proposal.id);

      // The rejected COMMIT is retried by the transaction runner, so several attempts surface; every one must be a definite
      // not-committed storage error, while the target write itself (below) is attempted exactly once.
      expect(observer.errors().length).toBeGreaterThanOrEqual(1);
      for (const error of observer.errors()) {
        expect(error).toBeInstanceOf(WorkflowStorageError);
        expect(error).toMatchObject({ code: 'STORAGE', definitelyNotCommitted: true });
      }
      // Each definite-rollback attempt is a fresh transaction (bounded retry), so the target is written once per attempt and
      // never again once the receipt is failed.
      const attempts = observer.errors().length;
      expect(observer.badgeEffectWriteAttempts()).toBe(attempts);
      expect(observer.executeAuditWriteAttempts()).toBe(attempts);
      expect(receipt).toMatchObject({
        visibility: 'full',
        id: `execution_${proposal.id}`,
        actionId: proposal.id,
        status: 'failed',
        results: [{ targetId: 'C102', id: null, status: 'failed' }],
      });
      expect(JSON.stringify(receipt)).not.toMatch(/SQLITE_CONSTRAINT|FOREIGN KEY|no-such-parent|WorkflowStorageError/i);

      const badgeAfter = await fixture.store.get<Badge>('mock_badges', 'C102');
      expect(badgeAfter).toEqual(badgeBefore);
      const badgeEffects = (await fixture.store.list<Badge>('mock_badges'))
        .filter((row) => row.operationKey === `${receipt.id}:C102`);
      expect(badgeEffects).toHaveLength(0);
      const auditsAfter = await fixture.store.list<AuditEvent>('audit_events');
      expect(auditsAfter.filter((row) => auditBaseline.some((baseline) => baseline.id === row.id)))
        .toEqual(auditBaseline);
      expect(auditsAfter.filter((row) => row.actionId === proposal.id && row.category === 'execute'))
        .toHaveLength(0);

      const repeated = await service.confirm(actors.hr, proposal.id);
      expect(repeated).toMatchObject({ id: receipt.id, status: 'failed' });
      expect(observer.badgeEffectWriteAttempts()).toBe(attempts);
      expect(observer.errors()).toHaveLength(attempts);
      expect(await fixture.store.get<Badge>('mock_badges', 'C102')).toEqual(badgeBefore);
    } finally {
      nativeDb.close();
      await fixture.dispose();
    }
  });

  it('keeps an unknown committed ticket pending until readback, then reconciles without another target write', async () => {
    const fixture = await createWorkspaceFixture();
    try {
      const responseLossStore = loseOneTicketCommitResponse(fixture.store);
      const service = new ConciergeService(createBlindReadbackStore(responseLossStore), {
        businessDate: BUSINESS_DATE,
        now: () => new Date(FIXED_NOW),
      });
      const evidence = await service.queryEvidence(actors.executive, {
        region: 'east',
        date: CLOSED_BUSINESS_DATE,
        branchIds: ['E02'],
      });
      const branch = evidence.branches.find((row) => row.branchId === 'E02');
      if (!branch) throw new Error('Missing East branch evidence for the synthetic ticket fixture.');
      const proposal = await service.prepare(actors.executive, {
        kind: 'ticket_create',
        scope: evidence.scope,
        targets: [{
          branchId: 'E02',
          assigneeId: 'E024',
          title: 'Review the synthetic East sales gap',
          reason: 'The synthetic evidence identifies a gap without proving its cause.',
          sourceIds: [...branch.sourceIds],
          unansweredQuestion: 'Which additional evidence would explain the gap?',
        }],
      });

      const pending = await service.confirm(actors.executive, proposal.id);
      expect(pending).toMatchObject({
        status: 'pending',
        results: [{ targetId: 'E02', id: expect.any(String), status: 'pending' }],
      });
      expect(responseLossStore.targetCommitCount()).toBe(1);
      expect(responseLossStore.targetDispatchCount()).toBe(1);
      const committedTicket = await fixture.store.get<Ticket>('mock_tickets', pending.results[0].id!);
      expect(committedTicket).toMatchObject({
        id: pending.results[0].id,
        branchId: 'E02',
        operationKey: `${pending.id}:E02`,
        status: 'open',
      });

      const reconciled = await service.reconcile(actors.executive, pending.id);
      expect(reconciled).toMatchObject({
        id: pending.id,
        status: 'verified_success',
        results: [{ targetId: 'E02', id: pending.results[0].id, status: 'verified_success' }],
      });
      const repeated = await service.confirm(actors.executive, proposal.id);
      expect(repeated).toMatchObject({ id: pending.id, status: 'verified_success' });
      expect(await fixture.store.list<Ticket>('mock_tickets')).toHaveLength(1);
      expect(responseLossStore.targetCommitCount()).toBe(1);
      expect(responseLossStore.targetDispatchCount()).toBe(1);
    } finally {
      await fixture.dispose();
    }
  });
});
