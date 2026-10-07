import { describe, expect, it } from 'vitest';
import type { PendingAction, Profile } from '../lib/contracts';
import { digest } from '../lib/core/utils';
import { createWorkflowSqliteFixture } from './helpers/workflow-storage';
import {
  pendingActionV2Schema,
  type PersistedConversation,
  type PendingActionV2,
  type WorkflowPayloadV2,
} from '../lib/workflows/contracts';
import { demoWorkflowPolicyV1, getDemoWorkflowPolicyV1Pin } from '../lib/workflows/policy';
import { itSqliteBound } from './helpers/local-pg';

const NOW = '2026-10-04T04:00:00.000Z';
const UPDATED_AT = '2026-10-04T04:05:00.000Z';
const LATER = '2099-01-01T00:00:00.000Z';

function profile(id: string): Profile {
  return { id, name: 'Synthetic V1 version writer', role: 'executive', active: true, permissions: [], regions: [] };
}

function versionedConversation(actorId: string, id: string): PersistedConversation & { rowVersion: number } {
  return {
    id,
    actorId,
    title: 'V1 first version',
    pinned: false,
    pinnedAt: null,
    archivedAt: null,
    rowVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
    lastScope: null,
    lastDashboardId: null,
  };
}

function versionedAction(input: { profileId: string; sessionId: string; conversationId: string }): PendingActionV2 {
  const id = 'v1-version-test-v2-action';
  const shareId = 'v1-version-test-v2-share';
  const turnId = 'v1-version-test-v2-turn';
  const payload: WorkflowPayloadV2 = { kind: 'dashboard_share_revoke', shareId };
  const expected = { ref: { table: 'dashboard_shares' as const, id: shareId }, rowVersion: 1, state: 'active' };
  return pendingActionV2Schema.parse({
    id,
    contractVersion: 2,
    actorId: input.profileId,
    sessionId: input.sessionId,
    conversationId: input.conversationId,
    turnId,
    mode: 'scripted_demo',
    modeRevision: 1,
    payload,
    payloadHash: digest(payload),
    idempotencyKey: digest({ id, turnId }),
    targets: [{
      targetId: 'v1-version-test-target',
      ref: expected.ref,
      semanticKey: 'v1-version-test-semantic-key',
      expectedRows: [expected],
      ownerIdentityId: input.profileId,
      expectedEffectRef: expected.ref,
      expectedEffectVersion: 2,
    }],
    targetCount: 1,
    expectedRows: [expected],
    approvedBranchIds: [],
    approvedOrgUnitIds: [],
    reviewedSnapshotId: null,
    policy: getDemoWorkflowPolicyV1Pin(),
    packs: [],
    releaseRevision: 'v1-shared-version-test-r1',
    executionMode: 'atomic_local',
    createdAt: NOW,
    expiresAt: LATER,
    status: 'pending',
  });
}

async function seedV2ActionContext(
  store: Awaited<ReturnType<typeof createWorkflowSqliteFixture>>['store'],
  profileId: string,
  sessionId: string,
  conversationId: string,
): Promise<void> {
  await store.transaction(async tx => {
    await tx.put('profiles', profile(profileId));
    await tx.put('sessions', {
      id: sessionId, profileId, mode: 'scripted_demo', modeRevision: 1,
      csrfToken: 'v1-version-test-csrf', expiresAt: LATER, createdAt: NOW,
    });
    await tx.put('conversations', {
      id: conversationId, actorId: profileId, title: 'V1 action owner conversation',
      pinned: false, archivedAt: null, rowVersion: 1, createdAt: NOW, updatedAt: NOW,
      lastScope: null, lastDashboardId: null,
    });
  });
  const pin = getDemoWorkflowPolicyV1Pin();
  await store.workflowTransaction(async tx => {
    await tx.insertUnique('workflow_policies', {
      id: pin.id, version: pin.version, digest: pin.digest, policy: demoWorkflowPolicyV1,
    }, { constraint: 'workflow_policies_primary_key', values: { id: pin.id } });
  });
}

describe('SQLite V1 writes to shared workflow conversations', () => {
  itSqliteBound('materializes V1 rowVersion inserts and updates and rejects duplicate, stale, and missing version writes without effects', async () => {
    const fixture = await createWorkflowSqliteFixture();
    const raw = fixture.openDatabase();
    try {
      const store = fixture.store;
      const actorId = 'v1-shared-version-actor';
      const conversationId = 'v1-shared-version-conversation';
      const initial = versionedConversation(actorId, conversationId);
      await store.transaction(async tx => {
        await tx.put('profiles', profile(actorId));
        await tx.put('conversations', initial);
      });

      expect(raw.prepare('SELECT row_version,actor_id,title,pinned,archived_at,updated_at FROM conversations WHERE id=?')
        .get(conversationId)).toEqual({
          row_version: 1, actor_id: actorId, title: 'V1 first version',
          pinned: 0, archived_at: null, updated_at: NOW,
        });
      expect(await store.get<PersistedConversation & { rowVersion: number }>('conversations', conversationId))
        .toEqual(initial);

      const updated: PersistedConversation & { rowVersion: number } = {
        ...initial,
        title: 'V1 second version',
        pinned: true,
        rowVersion: 2,
        updatedAt: UPDATED_AT,
        lastScope: { region: 'east', date: '2026-10-04', branchIds: ['v1-shared-version-branch'] },
      };
      await store.transaction(tx => tx.put('conversations', updated));
      expect(raw.prepare('SELECT row_version,actor_id,title,pinned,archived_at,updated_at FROM conversations WHERE id=?')
        .get(conversationId)).toEqual({
          row_version: 2, actor_id: actorId, title: 'V1 second version',
          pinned: 1, archived_at: null, updated_at: UPDATED_AT,
        });
      expect(await store.get<PersistedConversation & { rowVersion: number }>('conversations', conversationId))
        .toEqual(updated);

      const beforeConflict = raw.prepare('SELECT payload,row_version,title,pinned,updated_at FROM conversations WHERE id=?')
        .get(conversationId);
      const beforeRevision = (raw.prepare('SELECT revision FROM appmeta WHERE singleton=1').get() as { revision: number }).revision;
      const duplicateVersionOne = { ...updated, rowVersion: 1, title: 'Must not overwrite version two' };
      await expect(store.transaction(tx => tx.put('conversations', duplicateVersionOne)))
        .rejects.toMatchObject({ code: 'CONFLICT', definitelyNotCommitted: true });
      const staleVersionTwo = { ...updated, title: 'Stale version two write' };
      await expect(store.transaction(tx => tx.put('conversations', staleVersionTwo)))
        .rejects.toMatchObject({ code: 'CONFLICT', definitelyNotCommitted: true });
      const missingHigherVersion = { ...initial, id: 'v1-shared-version-missing', rowVersion: 2 };
      await expect(store.transaction(tx => tx.put('conversations', missingHigherVersion)))
        .rejects.toMatchObject({ code: 'CONFLICT', definitelyNotCommitted: true });

      expect(raw.prepare('SELECT payload,row_version,title,pinned,updated_at FROM conversations WHERE id=?')
        .get(conversationId)).toEqual(beforeConflict);
      expect(raw.prepare('SELECT id FROM conversations WHERE id=?').get(missingHigherVersion.id)).toBeUndefined();
      expect((raw.prepare('SELECT revision FROM appmeta WHERE singleton=1').get() as { revision: number }).revision)
        .toBe(beforeRevision);
    } finally {
      raw.close();
      await fixture.dispose();
    }
  });

  it('preserves no-version V1 upserts and prevents a V1 writer from replacing a V2-marked action', async () => {
    const fixture = await createWorkflowSqliteFixture();
    const raw = fixture.openDatabase();
    try {
      const store = fixture.store;
      const actorId = 'v1-legacy-upsert-actor';
      const legacyId = 'v1-legacy-upsert-conversation';
      const legacy = { id: legacyId, actorId, title: 'Legacy initial row', createdAt: NOW };
      await store.transaction(async tx => {
        await tx.put('profiles', profile(actorId));
        await tx.put('conversations', legacy);
      });
      expect(raw.prepare('SELECT row_version,title FROM conversations WHERE id=?').get(legacyId))
        .toEqual({ row_version: 1, title: 'Legacy initial row' });

      await store.transaction(tx => tx.put('conversations', { ...legacy, title: 'Legacy updated row' }));
      expect(raw.prepare('SELECT row_version,title FROM conversations WHERE id=?').get(legacyId))
        .toEqual({ row_version: 2, title: 'Legacy updated row' });
      expect(await store.get('conversations', legacyId)).toEqual({ ...legacy, title: 'Legacy updated row' });

      const v2ActorId = 'v1-writer-v2-marker-actor';
      const sessionId = 'v1-writer-v2-marker-session';
      const conversationId = 'v1-writer-v2-marker-conversation';
      await seedV2ActionContext(store, v2ActorId, sessionId, conversationId);
      const action = versionedAction({ profileId: v2ActorId, sessionId, conversationId });
      await store.workflowTransaction(tx => tx.insertUnique('pending_actions', action, {
        constraint: 'pending_actions_primary_key', values: { id: action.id },
      }));
      const v2Before = await store.workflowProjectionReader.get<PendingActionV2>('pending_actions', action.id);
      if (!v2Before) throw new Error('The synthetic V2 pending action was not persisted.');
      const beforeRevision = (raw.prepare('SELECT revision FROM appmeta WHERE singleton=1').get() as { revision: number }).revision;
      const legacyReplacement: PendingAction = {
        id: action.id,
        actorId: v2ActorId,
        sessionId,
        conversationId,
        turnId: 'legacy-v1-turn',
        mode: 'scripted_demo',
        modeRevision: 1,
        payload: { kind: 'demo_update', scenario: 'baseline' },
        payloadHash: digest({ kind: 'demo_update', scenario: 'baseline' }),
        evidenceVersion: null,
        packs: [],
        createdAt: NOW,
        expiresAt: LATER,
        status: 'pending',
        preview: 'Synthetic legacy proposal.',
      };
      await expect(store.transaction(tx => tx.put('pending_actions', legacyReplacement))
        ).rejects.toMatchObject({ code: 'STORAGE', definitelyNotCommitted: true });
      expect(await store.workflowProjectionReader.get<PendingActionV2>('pending_actions', action.id))
        .toEqual(v2Before);
      expect(await store.get('pending_actions', action.id)).toBeUndefined();
      expect(raw.prepare('SELECT workflow_contract_version,payload FROM pending_actions WHERE id=?').get(action.id))
        .toMatchObject({ workflow_contract_version: 2, payload: expect.stringContaining('\"contractVersion\":2') });
      expect((raw.prepare('SELECT revision FROM appmeta WHERE singleton=1').get() as { revision: number }).revision)
        .toBe(beforeRevision);
    } finally {
      raw.close();
      await fixture.dispose();
    }
  });
});
