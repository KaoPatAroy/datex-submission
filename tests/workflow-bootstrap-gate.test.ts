import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SeedData, Store, Table } from '../lib/contracts';
import { createSeedData } from '../lib/seed/generate';
import { prepareWorkflowV2SeedPlan } from '../lib/seed/workflow-v2';
import type { WorkflowStoreCapability } from '../lib/storage/workflow-projections';
import { createWorkflowSqliteFixture } from './helpers/workflow-storage';
import { itSqliteBound } from './helpers/local-pg';

const BUSINESS_DATE = '2026-10-04';
const environmentKeys = [
  'USE_LOCAL_DEMO_DATA',
  'DB_PATH',
  'DEMO_BUSINESS_DATE',
  'WORKFLOW_V2_ENABLED',
  'VERCEL',
  'SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
] as const;

const openedStores = vi.hoisted(() => ({
  values: [] as Array<{ close?: () => void }>,
  closed: [] as Array<{ close?: () => void }>,
}));

vi.mock('server-only', () => ({}));
vi.mock('../lib/storage/sqlite', async importOriginal => {
  const actual = await importOriginal<typeof import('../lib/storage/sqlite')>();
  return {
    ...actual,
    createSqliteStore: (path: string) => {
      const store = actual.createSqliteStore(path);
      const close = store.close?.bind(store);
      store.close = () => {
        openedStores.closed.push(store);
        close?.();
      };
      openedStores.values.push(store);
      return store;
    },
  };
});

let savedEnvironment = new Map<string, string | undefined>();

beforeEach(() => {
  savedEnvironment = new Map(environmentKeys.map(key => [key, process.env[key]]));
  openedStores.closed.length = 0;
});

afterEach(() => {
  closeOpenedStores();
  for (const [key, value] of savedEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
});

function configureLocalDatabase(path: string, workflowV2: boolean): void {
  process.env.USE_LOCAL_DEMO_DATA = 'true';
  process.env.DB_PATH = path;
  process.env.DEMO_BUSINESS_DATE = BUSINESS_DATE;
  process.env.WORKFLOW_V2_ENABLED = String(workflowV2);
  delete process.env.VERCEL;
  delete process.env.SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
}

function closeOpenedStores(): void {
  for (const store of openedStores.values.splice(0)) store.close?.();
}

async function loadStorageModule() {
  vi.resetModules();
  return import('../lib/storage/index');
}

function sortedById<T extends { id: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((left, right) => left.id.localeCompare(right.id));
}

async function expectCanonicalV1Seed(store: Store, seed: SeedData): Promise<void> {
  const tables = Object.entries(seed) as [Table, { id: string }[]][];
  for (const [table, expectedRows] of tables) {
    const actualRows = await store.list<{ id: string }>(table);
    expect(sortedById(actualRows)).toEqual(sortedById(expectedRows));
  }
}

describe('workflow V2 bootstrap gate', () => {
  itSqliteBound('keeps the canonical V1 bootstrap when the V2 flag is off', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      configureLocalDatabase(fixture.databasePath, false);
      const storage = await loadStorageModule();
      const store = await storage.getStore();

      await expectCanonicalV1Seed(store, createSeedData(BUSINESS_DATE));
      expect(await storage.getWorkflowV2BootstrapResult()).toBeNull();
      const workflowStore = store as Store & WorkflowStoreCapability;
      const seedMarkers = await workflowStore.workflowProjectionReader.query({
        kind: 'scoped',
        table: 'audit_events',
        equals: { category: 'synthetic_workflow_v2_seed_begin' },
        limit: 10,
      });
      expect(seedMarkers).toHaveLength(0);
    } finally {
      closeOpenedStores();
      await fixture.dispose();
    }
  }, 180_000);

  itSqliteBound('runs the deterministic seed-1 V2 plan after V1 and advances the demo queue through the real Manager approval path', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      configureLocalDatabase(fixture.databasePath, true);
      const storage = await loadStorageModule();
      const store = await storage.getStore();
      const seed = createSeedData(BUSINESS_DATE);
      const plan = prepareWorkflowV2SeedPlan(seed, { seed: 1, businessDate: BUSINESS_DATE });
      const workflowStore = store as Store & WorkflowStoreCapability;

      for (const table of ['profiles', 'branches', 'products'] as const) {
        const expectedRows = seed[table];
        for (const expected of expectedRows) {
          expect(await store.get(table, expected.id)).toEqual(expected);
        }
      }

      const result = await storage.getWorkflowV2BootstrapResult();
      expect(result).toMatchObject({
        state: 'source_ready',
        bootstrapReady: true,
        sourcePhasesComplete: true,
        seedVersion: 2,
        seed: 1,
        seedTag: plan.seedTag,
        businessDate: BUSINESS_DATE,
        inputDigest: plan.inputDigest,
      });
      expect(result?.managerAdvancement).toMatchObject({
        state: 'verified',
        selectedRequestIds: [plan.identities.onboardingRequestIds[0]],
        directorQueueRequestIds: [plan.identities.onboardingRequestIds[0]],
      });
      expect(result?.directorQueueReady).toBe(true);
      expect(await storage.getWorkflowV2BootstrapResult()).toEqual(result);

      // Base ready request + 3 additive demo-queue requests reached Director approval via real manager executions (4 manager events).
      const managerApprovalEvents = await workflowStore.workflowProjectionReader.query({
        kind: 'scoped',
        table: 'onboarding_approval_events',
        equals: { stage: 'manager' },
        limit: 10,
      });
      expect(managerApprovalEvents).toHaveLength(4);
    } finally {
      closeOpenedStores();
      await fixture.dispose();
    }
  }, 180_000);

  itSqliteBound('gives the real Director a realistic queue (4 pending, 1 still at manager stage) that survives a restart idempotently', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      configureLocalDatabase(fixture.databasePath, true);
      let storage = await loadStorageModule();
      let store = await storage.getStore();
      const states = async () => {
        const rows = await (store as Store & WorkflowStoreCapability).workflowProjectionReader.query<{ state: string }>({
          kind: 'scoped', table: 'onboarding_requests', limit: 50 });
        return rows.map(row => row.body.state).sort();
      };
      expect(await states()).toEqual(['director_approval_pending', 'director_approval_pending', 'director_approval_pending', 'director_approval_pending', 'manager_review_pending']);

      // The login Director profile is the V2 Director principal: its queue is the realistic 4-request queue with distinct start dates.
      await store.transaction(tx => tx.put('sessions', { id: 'director-queue-session', profileId: 'director', mode: 'scripted_demo', modeRevision: 1,
        csrfToken: 'csrf-test', expiresAt: '2099-01-01T00:00:00.000Z' }));
      const { createTrustedWorkflowRuntime } = await import('../lib/core/workflow-runtime');
      const trusted = createTrustedWorkflowRuntime({ store: store as Store & WorkflowStoreCapability, businessDate: BUSINESS_DATE,
        contextFactory: () => ({ latestDashboard: async () => undefined }) });
      const queue = await trusted.onboarding.directorQueue('director-queue-session');
      expect(queue.items).toHaveLength(4);
      expect(new Set(queue.items.map(item => item.request.startDate)).size).toBeGreaterThan(1);
      for (const item of queue.items) expect(item.documents.length).toBeGreaterThan(0);

      // A real Director decision advances a seeded row (rowVersion > planned); the restart below must treat that as product state, not a seed conflict.
      await (store as Store & WorkflowStoreCapability).workflowTransaction(async tx => {
        await tx.insertUnique('conversations', { id: 'director-conv', actorId: 'director', title: 't', pinned: false, archivedAt: null, rowVersion: 1,
          createdAt: '2026-10-04T08:00:00.000Z', updatedAt: '2026-10-04T08:00:00.000Z', lastScope: null, lastDashboardId: null }, { constraint: 'conversations_primary_key', values: { id: 'director-conv' } });
      });
      const turn = { conversationId: 'director-conv', turnId: 'director-turn' };
      const prepared = await trusted.runtime.prepare('director-queue-session', { kind: 'onboarding_director_approve', snapshotId: queue.snapshot.id,
        requestIds: [queue.items[0].request.id] }, turn);
      expect(prepared.pendingAction).not.toBeNull();
      const confirmed = await trusted.runner.confirm('director-queue-session', prepared.pendingAction!.id, 'director-confirm', turn);
      expect(confirmed.receipt?.outcome).toBe('verified_success');
      expect(await states()).toEqual(['director_approval_pending', 'director_approval_pending', 'director_approval_pending', 'director_approved', 'manager_review_pending']);
      // Restart on the same DB: the bootstrap is idempotent (no extra manager executions, no seed conflict from advanced rows).
      closeOpenedStores();
      storage = await loadStorageModule();
      store = await storage.getStore();
      await expect(storage.getWorkflowV2BootstrapResult()).resolves.toMatchObject({ state: 'source_ready', bootstrapReady: true });
      const events = await (store as Store & WorkflowStoreCapability).workflowProjectionReader.query({
        kind: 'scoped', table: 'onboarding_approval_events', equals: { stage: 'manager' }, limit: 10 });
      expect(events).toHaveLength(4);
      expect(await states()).toEqual(['director_approval_pending', 'director_approval_pending', 'director_approval_pending', 'director_approved', 'manager_review_pending']);
    } finally {
      closeOpenedStores();
      await fixture.dispose();
    }
  }, 120_000);

  itSqliteBound('fails closed on a partial legacy store with no profiles without overwriting its existing rows', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const legacyBranch = { ...createSeedData(BUSINESS_DATE).branches[0], name: 'Conflicting partial legacy branch' };
      await fixture.store.transaction(tx => tx.put('branches', legacyBranch));
      configureLocalDatabase(fixture.databasePath, true);
      const storage = await loadStorageModule();
      const firstBootstrapStoreIndex = openedStores.values.length;

      await expect(storage.getStore()).rejects.toMatchObject({ code: 'WORKFLOW_UNAVAILABLE' });

      const failedAdapters = openedStores.values.slice(firstBootstrapStoreIndex);
      expect(failedAdapters).toHaveLength(1);
      expect(openedStores.closed).toContain(failedAdapters[0]);
      expect(await fixture.store.list('profiles')).toEqual([]);
      expect(await fixture.store.list('branches')).toEqual([legacyBranch]);
      expect(await fixture.store.list('products')).toEqual([]);
      const workflowStore = fixture.store as Store & WorkflowStoreCapability;
      const seedMarkers = await workflowStore.workflowProjectionReader.query({
        kind: 'scoped',
        table: 'audit_events',
        equals: { category: 'synthetic_workflow_v2_seed_begin' },
        limit: 10,
      });
      expect(seedMarkers).toHaveLength(0);
    } finally {
      closeOpenedStores();
      await fixture.dispose();
    }
  }, 180_000);

  itSqliteBound('fails closed on conflicting legacy rows and clears the rejected cache so a clean local retry can initialize', async () => {
    const conflictFixture = await createWorkflowSqliteFixture();
    const retryFixture = await createWorkflowSqliteFixture();
    try {
      const seed = createSeedData(BUSINESS_DATE);
      const legacyProfile = { ...seed.profiles[0], name: 'Pre-existing legacy executive' };
      const legacyBranch = { ...seed.branches[0], name: 'Conflicting pre-existing legacy branch' };
      await conflictFixture.store.transaction(async tx => {
        await tx.put('profiles', legacyProfile);
        await tx.put('branches', legacyBranch);
      });

      configureLocalDatabase(conflictFixture.databasePath, true);
      const storage = await loadStorageModule();
      const firstBootstrapStoreIndex = openedStores.values.length;
      await expect(storage.getStore()).rejects.toMatchObject({ code: 'WORKFLOW_UNAVAILABLE' });

      const failedAdapters = openedStores.values.slice(firstBootstrapStoreIndex);
      expect(failedAdapters).toHaveLength(1);
      expect(openedStores.closed).toContain(failedAdapters[0]);

      expect(await conflictFixture.store.list('profiles')).toEqual([legacyProfile]);
      expect(await conflictFixture.store.list('branches')).toEqual([legacyBranch]);
      const conflictWorkflowStore = conflictFixture.store as Store & WorkflowStoreCapability;
      const seedMarkers = await conflictWorkflowStore.workflowProjectionReader.query({
        kind: 'scoped',
        table: 'audit_events',
        equals: { category: 'synthetic_workflow_v2_seed_begin' },
        limit: 10,
      });
      expect(seedMarkers).toHaveLength(0);

      process.env.DB_PATH = retryFixture.databasePath;
      const retryStore = await storage.getStore();
      expect(await retryStore.get('branches', seed.branches[0].id)).toEqual(seed.branches[0]);
      await expect(storage.getWorkflowV2BootstrapResult()).resolves.toMatchObject({
        state: 'source_ready',
        bootstrapReady: true,
        seed: 1,
      });
    } finally {
      closeOpenedStores();
      await Promise.all([conflictFixture.dispose(), retryFixture.dispose()]);
    }
  }, 180_000);
});
