import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { tables } from '../lib/contracts';
import { createWorkflowSqliteFixture } from './helpers/workflow-storage';
import {
  applyWorkflowSqliteMigrations,
  WORKFLOW_CONVERSATION_PERSISTENCE_MIGRATION,
  WORKFLOW_SNAPSHOT_PROOF_REFERENCES_MIGRATION,
  workflowSnapshotProofReferenceDefinitions,
} from '../lib/storage/workflow-sqlite-migrations';
import {
  WORKFLOW_BASE_DIGEST,
  WORKFLOW_BASE_MIGRATION,
  WORKFLOW_COMPLETENESS_DIGEST,
  WORKFLOW_COMPLETENESS_MIGRATION,
  WORKFLOW_CONVERSATION_PERSISTENCE_DIGEST,
  WORKFLOW_SCOPE_DIGEST,
  WORKFLOW_SCOPE_MIGRATION,
} from '../lib/storage/workflow-schema-history';
import type {
  PersistedConversation,
  PersistedConversationMessage,
} from '../lib/workflows/contracts';
import { itSqliteBound } from './helpers/local-pg';

const createdAt = '2026-10-04T03:00:00.000Z';
const updatedAt = '2026-10-04T03:05:00.000Z';
const HISTORICAL_STAGE_STOP = 'test-only historical schema checkpoint';

function analysis() {
  return {
    facts: [{ text: 'Synthetic persisted fact.', sourceIds: ['source-1'] }],
    relationships: [],
    hypotheses: [],
    missingEvidence: [],
    generatedAt: createdAt,
    evidenceVersion: 'evidence-v1',
  };
}

function profile(actorId: string) {
  return {
    id: actorId,
    name: 'Synthetic actor',
    role: 'staff',
    active: true,
    permissions: [],
    regions: [],
  };
}

function conversation(actorId: string, id = 'conversation-roundtrip') {
  return {
    id,
    actorId,
    title: 'Pinned context',
    pinned: false,
    pinnedAt: null,
    archivedAt: null,
    createdAt,
    updatedAt,
    lastScope: null,
    lastDashboardId: null,
    lastAnalysis: analysis(),
  } satisfies PersistedConversation;
}

function message(
  actorId: string,
  conversationId: string,
  values: Partial<PersistedConversationMessage> & Pick<PersistedConversationMessage, 'id' | 'role' | 'text'>,
): PersistedConversationMessage {
  return {
    ...values,
    conversationId,
    actorId,
    mode: values.mode ?? 'scripted_demo',
    modeRevision: values.modeRevision ?? 2,
    createdAt: values.createdAt ?? createdAt,
  };
}

function historicalLedger(db: Database.Database) {
  return db.prepare('SELECT id, digest FROM workflow_schema_migrations ORDER BY id')
    .all() as Array<{ id: string; digest: string }>;
}

function sqliteSchema(db: Database.Database) {
  return db.prepare(`
    SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE sql IS NOT NULL AND type IN ('table', 'index', 'trigger')
    ORDER BY type, name
  `).all();
}

function rowSnapshot(db: Database.Database, table: string, id: string) {
  return db.prepare(`SELECT id, payload, row_version FROM "${table}" WHERE id = ?`).get(id) as
    { id: string; payload: string; row_version: number } | undefined;
}

/** Stop after the pinned completeness step to build a realistic pre-forward database. */
function materializeCompletenessStage(db: Database.Database): void {
  const prepare = db.prepare.bind(db);
  let checkpointed = false;
  const staged = new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql: string) => {
          const statement = prepare(sql);
          if (sql !== 'INSERT INTO workflow_schema_migrations(id,digest) VALUES(?,?)') return statement;
          return new Proxy(statement, {
            get(inner, key) {
              if (key === 'run') {
                return (...parameters: unknown[]) => {
                  const result = inner.run(...parameters);
                  if (parameters[0] === WORKFLOW_COMPLETENESS_MIGRATION) {
                    target.exec('COMMIT');
                    checkpointed = true;
                    throw new Error(`${HISTORICAL_STAGE_STOP}: ${WORKFLOW_COMPLETENESS_MIGRATION}`);
                  }
                  return result;
                };
              }
              const value = Reflect.get(inner, key, inner);
              return typeof value === 'function' ? value.bind(inner) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  try {
    applyWorkflowSqliteMigrations(staged);
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    if (!checkpointed || !(cause instanceof Error) || !cause.message.startsWith(HISTORICAL_STAGE_STOP)) throw error;
  }
  if (!checkpointed) throw new Error('SQLite migration did not reach its completeness checkpoint');
}

async function createPreForwardFixture(options: {
  turnId?: string;
  sessionId?: string;
  pendingActionIds?: string[];
  existingTurnColumn?: string;
} = {}) {
  const fixture = await createWorkflowSqliteFixture({ initialize: false });
  const db = fixture.openDatabase();
  try {
    for (const table of tables) {
      db.exec(`CREATE TABLE "${table}" (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL)`);
    }
    db.exec('CREATE TABLE appmeta (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), revision INTEGER NOT NULL)');
    db.prepare('INSERT INTO appmeta (singleton, revision) VALUES (1, 41)').run();
    materializeCompletenessStage(db);

    const actorId = 'conversation-persistence-actor';
    const conversationId = 'conversation-persistence-history';
    const messageId = 'conversation-persistence-history-message';
    const historicalConversation = {
      id: conversationId,
      actorId,
      title: 'Historical conversation',
      pinned: false,
      pinnedAt: null,
      archivedAt: null,
      rowVersion: 5,
      createdAt: null,
      updatedAt,
      lastScope: null,
      lastDashboardId: null,
      lastAnalysis: analysis(),
    };
    const historicalMessage = {
      id: messageId,
      rowVersion: 7,
      conversationId,
      actorId,
      role: 'assistant',
      text: 'Historical assistant response',
      mode: 'scripted_demo',
      modeRevision: 2,
      createdAt,
      ...(options.turnId === undefined ? {} : { turnId: options.turnId }),
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(options.pendingActionIds === undefined ? {} : { pendingActionIds: options.pendingActionIds }),
    };

    // Seed through the predecessor's storage shape. Those historical bodies may
    // carry newer optional JSON keys that the predecessor did not project.
    db.prepare('INSERT INTO profiles (id, payload, row_version, role, active) VALUES (?, ?, 1, ?, 1)')
      .run(actorId, JSON.stringify(profile(actorId)), 'staff');
    db.exec(`
      DROP TRIGGER IF EXISTS workflow_conversations_insert_guard;
      DROP TRIGGER IF EXISTS workflow_conversations_update_guard;
      DROP TRIGGER IF EXISTS workflow_conversations_sync_insert;
      DROP TRIGGER IF EXISTS workflow_conversations_sync_update;
      DROP TRIGGER IF EXISTS workflow_conversations_revision_insert;
      DROP TRIGGER IF EXISTS workflow_conversations_revision_update;
      DROP TRIGGER IF EXISTS workflow_conversations_revision_delete;
      DROP TRIGGER IF EXISTS workflow_conversation_messages_insert_guard;
      DROP TRIGGER IF EXISTS workflow_conversation_messages_update_guard;
      DROP TRIGGER IF EXISTS workflow_conversation_messages_sync_insert;
      DROP TRIGGER IF EXISTS workflow_conversation_messages_sync_update;
      DROP TRIGGER IF EXISTS workflow_conversation_messages_revision_insert;
      DROP TRIGGER IF EXISTS workflow_conversation_messages_revision_update;
      DROP TRIGGER IF EXISTS workflow_conversation_messages_revision_delete;
    `);
    db.prepare(`
      INSERT INTO conversations (id, payload, row_version, actor_id, title, pinned, archived_at, updated_at)
      VALUES (?, ?, 5, ?, ?, 0, NULL, ?)
    `).run(conversationId, JSON.stringify(historicalConversation), actorId, historicalConversation.title, updatedAt);
    db.prepare(`
      INSERT INTO conversation_messages (id, payload, row_version, conversation_id, actor_id, created_at)
      VALUES (?, ?, 7, ?, ?, ?)
    `).run(messageId, JSON.stringify(historicalMessage), conversationId, actorId, createdAt);
    if (options.existingTurnColumn !== undefined) {
      db.exec('ALTER TABLE conversation_messages ADD COLUMN turn_id TEXT');
      db.prepare('UPDATE conversation_messages SET turn_id = ? WHERE id = ?').run(options.existingTurnColumn, messageId);
    }
    db.prepare('UPDATE appmeta SET revision = 83 WHERE singleton = 1').run();

    return {
      fixture,
      db,
      actorId,
      conversationId,
      messageId,
      historicalConversation,
      historicalMessage,
    };
  } catch (error) {
    db.close();
    await fixture.dispose();
    throw error;
  }
}

function projectionIndexes(db: Database.Database): Record<string, string[]> {
  const names = [
    'workflow_conversation_messages_turn_id_lookup',
    'workflow_conversation_messages_session_id_lookup',
    'workflow_conversation_messages_identity_lookup',
  ];
  return Object.fromEntries(names.map((name) => [
    name,
    (db.prepare(`PRAGMA index_info("${name}")`).all() as Array<{ name: string }>).map((column) => column.name),
  ]));
}

describe('SQLite conversation persistence', () => {
  itSqliteBound('upgrades populated completeness-era rows, backfills explicit identities, and reapplies without drift', async () => {
    const history = await createPreForwardFixture({
      turnId: 'historical-turn-1',
      sessionId: 'historical-session-1',
      pendingActionIds: ['historical-action-1', 'historical-action-2'],
    });
    const { fixture, db, conversationId, messageId, historicalConversation, historicalMessage } = history;
    try {
      const beforeConversation = rowSnapshot(db, 'conversations', conversationId)!;
      const beforeMessage = rowSnapshot(db, 'conversation_messages', messageId)!;
      const beforeRevision = (db.prepare('SELECT revision FROM appmeta WHERE singleton = 1').get() as { revision: number }).revision;
      const beforeLedger = historicalLedger(db);
      expect(beforeLedger).toEqual([
        { id: WORKFLOW_BASE_MIGRATION, digest: WORKFLOW_BASE_DIGEST },
        { id: WORKFLOW_SCOPE_MIGRATION, digest: WORKFLOW_SCOPE_DIGEST },
        { id: WORKFLOW_COMPLETENESS_MIGRATION, digest: WORKFLOW_COMPLETENESS_DIGEST },
      ]);
      expect((db.prepare('PRAGMA table_info(conversation_messages)').all() as Array<{ name: string }>)
        .some((column) => column.name === 'turn_id' || column.name === 'session_id')).toBe(false);
      expect(JSON.parse(beforeConversation.payload)).toEqual(historicalConversation);
      expect(JSON.parse(beforeMessage.payload)).toEqual(historicalMessage);
      expect((db.prepare('SELECT count(*) n FROM conversations').get() as { n: number }).n).toBe(1);
      expect((db.prepare('SELECT count(*) n FROM conversation_messages').get() as { n: number }).n).toBe(1);
      db.close();

      const store = fixture.openStore();
      store.close?.();
      const upgraded = fixture.openDatabase();
      try {
        const afterLedger = historicalLedger(upgraded);
        expect(afterLedger.slice(0, 3)).toEqual(beforeLedger);
        expect(afterLedger.find((entry) => entry.id === WORKFLOW_CONVERSATION_PERSISTENCE_MIGRATION)).toEqual({
          id: WORKFLOW_CONVERSATION_PERSISTENCE_MIGRATION,
          digest: WORKFLOW_CONVERSATION_PERSISTENCE_DIGEST,
        });
        expect(afterLedger.find((entry) => entry.id === WORKFLOW_SNAPSHOT_PROOF_REFERENCES_MIGRATION)).toEqual({
          id: WORKFLOW_SNAPSHOT_PROOF_REFERENCES_MIGRATION,
          digest: createHash('sha256').update(JSON.stringify(workflowSnapshotProofReferenceDefinitions())).digest('hex'),
        });
        expect(rowSnapshot(upgraded, 'conversations', conversationId)).toEqual(beforeConversation);
        expect(rowSnapshot(upgraded, 'conversation_messages', messageId)).toEqual(beforeMessage);
        expect((upgraded.prepare('SELECT revision FROM appmeta WHERE singleton = 1').get() as { revision: number }).revision)
          .toBe(beforeRevision);
        const identityColumns = upgraded.prepare('PRAGMA table_info(conversation_messages)').all() as Array<{
          name: string; type: string; notnull: number; dflt_value: unknown;
        }>;
        for (const name of ['turn_id', 'session_id']) {
          expect(identityColumns.find((column) => column.name === name)).toMatchObject({
            type: 'TEXT', notnull: 0, dflt_value: null,
          });
        }
        expect(projectionIndexes(upgraded)).toEqual({
          workflow_conversation_messages_turn_id_lookup: ['turn_id', 'id'],
          workflow_conversation_messages_session_id_lookup: ['session_id', 'id'],
          workflow_conversation_messages_identity_lookup: ['actor_id', 'conversation_id', 'session_id', 'turn_id', 'id'],
        });
        expect(upgraded.prepare('SELECT turn_id, session_id FROM conversation_messages WHERE id = ?').get(messageId))
          .toEqual({ turn_id: 'historical-turn-1', session_id: 'historical-session-1' });

        const firstSchema = sqliteSchema(upgraded);
        const firstLedger = historicalLedger(upgraded);
        applyWorkflowSqliteMigrations(upgraded);
        expect(sqliteSchema(upgraded)).toEqual(firstSchema);
        expect(historicalLedger(upgraded)).toEqual(firstLedger);
        expect(rowSnapshot(upgraded, 'conversations', conversationId)).toEqual(beforeConversation);
        expect(rowSnapshot(upgraded, 'conversation_messages', messageId)).toEqual(beforeMessage);
        expect((upgraded.prepare('SELECT revision FROM appmeta WHERE singleton = 1').get() as { revision: number }).revision)
          .toBe(beforeRevision);
        expect(upgraded.pragma('foreign_key_check')).toEqual([]);
      } finally {
        upgraded.close();
      }
    } finally {
      if (db.open) db.close();
      await fixture.dispose();
    }
  });

  itSqliteBound('rolls back the forward step for malformed body identity and a contradictory native projection', async () => {
    for (const options of [
      { turnId: 'historical turn with spaces', sessionId: 'historical-session-2' },
      { turnId: 'historical-turn-3', sessionId: 'historical-session-3', existingTurnColumn: 'different-turn' },
    ]) {
      const history = await createPreForwardFixture(options);
      const { fixture, db, messageId } = history;
      try {
        const beforeLedger = historicalLedger(db);
        const beforeRevision = (db.prepare('SELECT revision FROM appmeta WHERE singleton = 1').get() as { revision: number }).revision;
        const beforeMessage = rowSnapshot(db, 'conversation_messages', messageId)!;
        const beforeSchema = sqliteSchema(db);
        db.close();

        expect(() => fixture.openStore()).toThrow(/Workflow migration/);

        const rejected = fixture.openDatabase();
        try {
          expect(historicalLedger(rejected)).toEqual(beforeLedger);
          expect(historicalLedger(rejected).some((entry) => entry.id === WORKFLOW_CONVERSATION_PERSISTENCE_MIGRATION)).toBe(false);
          expect(rowSnapshot(rejected, 'conversation_messages', messageId)).toEqual(beforeMessage);
          expect((rejected.prepare('SELECT revision FROM appmeta WHERE singleton = 1').get() as { revision: number }).revision)
            .toBe(beforeRevision);
          expect(sqliteSchema(rejected)).toEqual(beforeSchema);
          expect(rejected.pragma('foreign_key_check')).toEqual([]);
        } finally {
          rejected.close();
        }
      } finally {
        if (db.open) db.close();
        await fixture.dispose();
      }
    }
  });

  it('round-trips ROOT-shaped messages and conversation metadata through insert, CAS, close, and reopen', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const store = fixture.store;
      const actorId = 'conversation-roundtrip-actor';
      const conversationId = 'conversation-roundtrip';
      const userMessage = message(actorId, conversationId, {
        id: 'conversation-roundtrip-user', role: 'user', text: 'Please review both actions.',
        turnId: 'conversation-roundtrip-turn', sessionId: 'conversation-roundtrip-session',
      });
      const assistantMessage = message(actorId, conversationId, {
        id: 'conversation-roundtrip-assistant', role: 'assistant', text: 'Both proposals are ready.',
        turnId: 'conversation-roundtrip-turn', sessionId: 'conversation-roundtrip-session',
        pendingActionId: 'conversation-roundtrip-action-1',
        pendingActionIds: ['conversation-roundtrip-action-1', 'conversation-roundtrip-action-2'],
      });
      const initialConversation = conversation(actorId, conversationId);
      await store.transaction(async (tx) => {
        await tx.put('profiles', profile(actorId));
        await tx.put('conversations', initialConversation);
        await tx.put('conversation_messages', userMessage);
        await tx.put('conversation_messages', assistantMessage);
      });

      const expected = { ...initialConversation, rowVersion: 1 };
      const cas = await store.workflowTransaction((tx) => tx.compareAndSwap(
        'conversations', conversationId, { rowVersion: 1, state: null }, {
          ...expected,
          rowVersion: 2,
          updatedAt: '2026-10-04T03:10:00.000Z',
          lastScope: { region: 'east', date: '2026-10-04', branchIds: ['branch-1'] },
        },
      ));
      expect(cas).toMatchObject({ updated: true, row: { rowVersion: 2, pinnedAt: null } });

      const reopened = fixture.reopen();
      expect(await reopened.get('conversations', conversationId)).toMatchObject({
        ...initialConversation,
        rowVersion: 2,
        updatedAt: '2026-10-04T03:10:00.000Z',
        lastScope: { region: 'east', date: '2026-10-04', branchIds: ['branch-1'] },
      });
      expect(await reopened.get('conversation_messages', userMessage.id)).toEqual(userMessage);
      expect(await reopened.get('conversation_messages', assistantMessage.id)).toEqual(assistantMessage);

      const db = fixture.openDatabase();
      try {
        expect(db.prepare('SELECT turn_id, session_id FROM conversation_messages WHERE id = ?').get(userMessage.id))
          .toEqual({ turn_id: userMessage.turnId, session_id: userMessage.sessionId });
        expect(db.prepare('SELECT turn_id, session_id FROM conversation_messages WHERE id = ?').get(assistantMessage.id))
          .toEqual({ turn_id: assistantMessage.turnId, session_id: assistantMessage.sessionId });
        expect(db.prepare('SELECT payload, row_version FROM conversations WHERE id = ?').get(conversationId))
          .toMatchObject({ row_version: 2, payload: expect.stringContaining('"pinnedAt":null') });
        expect(JSON.parse((db.prepare('SELECT payload FROM conversation_messages WHERE id = ?').get(assistantMessage.id) as { payload: string }).payload))
          .toEqual(assistantMessage);
      } finally {
        db.close();
      }
    } finally {
      await fixture.dispose();
    }
  });

  it('keeps legacy omissions readable, enriches a missing creation instant once, and rejects later timestamp changes', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const store = fixture.store;
      const actorId = 'conversation-legacy-actor';
      const noTimestamp = { id: 'conversation-legacy-absent-created-at', actorId, title: 'Old row' };
      const nullTimestamp = { id: 'conversation-legacy-null-created-at', actorId, createdAt: null, title: 'Null row' };
      const legacyMessage = message(actorId, noTimestamp.id, {
        id: 'conversation-legacy-message', role: 'user', text: 'Old message without identity columns.',
      });
      await store.transaction(async (tx) => {
        await tx.put('profiles', profile(actorId));
        await tx.put('conversations', noTimestamp);
        await tx.put('conversations', nullTimestamp);
        await tx.put('conversation_messages', legacyMessage);
      });

      expect(await store.get('conversation_messages', legacyMessage.id)).toEqual(legacyMessage);
      const beforeAbsent = await store.get<PersistedConversation>('conversations', noTimestamp.id);
      const beforeNull = await store.get<PersistedConversation>('conversations', nullTimestamp.id);
      if (!beforeAbsent || !beforeNull) throw new Error('Expected both legacy conversations to be readable');
      expect(beforeAbsent).not.toHaveProperty('createdAt');
      expect(beforeNull).toMatchObject({ createdAt: null });
      expect(await store.transaction((tx) => tx.get('conversation_messages', legacyMessage.id))).toEqual(legacyMessage);

      await store.transaction(async (tx) => {
        await tx.put('conversations', { ...beforeAbsent, createdAt });
        await tx.put('conversations', { ...beforeNull, createdAt });
      });
      expect(await store.get('conversations', noTimestamp.id)).toMatchObject({ createdAt });
      expect(await store.get('conversations', nullTimestamp.id)).toMatchObject({ createdAt });

      for (const id of [noTimestamp.id, nullTimestamp.id]) {
        const current = await store.get<PersistedConversation>('conversations', id);
        if (!current) throw new Error(`Expected legacy conversation ${id} to remain readable`);
        await expect(store.transaction((tx) => tx.put('conversations', {
          ...current,
          createdAt: '2026-10-04T04:00:00.000Z',
        }))).rejects.toThrow();
        expect(await store.get('conversations', id)).toMatchObject({ createdAt });
      }
      expect((await store.get('conversation_messages', legacyMessage.id))).not.toHaveProperty('turnId');
      expect((await store.get('conversation_messages', legacyMessage.id))).not.toHaveProperty('sessionId');
      const db = fixture.openDatabase();
      try {
        expect(db.prepare('SELECT turn_id, session_id FROM conversation_messages WHERE id = ?').get(legacyMessage.id))
          .toEqual({ turn_id: null, session_id: null });
      } finally {
        db.close();
      }
    } finally {
      await fixture.dispose();
    }
  });

  it('rejects unknown fields, invalid identities, duplicate action IDs, and malformed analysis at storage boundaries', async () => {
    const fixture = await createWorkflowSqliteFixture();
    try {
      const store = fixture.store;
      const actorId = 'conversation-validation-actor';
      const conversationId = 'conversation-validation';
      const baseConversation = conversation(actorId, conversationId);
      const baseMessage = message(actorId, conversationId, {
        id: 'conversation-validation-message', role: 'assistant', text: 'Validated message.',
        turnId: 'conversation-validation-turn', sessionId: 'conversation-validation-session',
        pendingActionIds: ['conversation-validation-action-1', 'conversation-validation-action-2'],
      });
      await store.transaction(async (tx) => {
        await tx.put('profiles', profile(actorId));
        await tx.put('conversations', baseConversation);
        await tx.put('conversation_messages', baseMessage);
      });

      const invalidRows: unknown[] = [
        { ...baseMessage, id: 'conversation-unknown-key', unexpectedField: true },
        { ...baseMessage, id: 'conversation-bad-turn-id', turnId: 'invalid turn id' },
        { ...baseMessage, id: 'conversation-duplicate-action-ids', pendingActionIds: ['same-action', 'same-action'] },
      ];
      for (const row of invalidRows) {
        await expect(store.transaction((tx) => tx.put('conversation_messages', row as { id: string })))
          .rejects.toThrow();
      }
      await expect(store.transaction((tx) => tx.put('conversations', {
        ...baseConversation,
        id: 'conversation-unknown-metadata',
        unexpectedField: true,
      } as { id: string }))).rejects.toThrow();

      await expect(store.workflowTransaction((tx) => tx.compareAndSwap(
        'conversations', conversationId, { rowVersion: 1, state: null }, {
          ...baseConversation,
          rowVersion: 2,
          lastAnalysis: { ...analysis(), generatedAt: 'not-an-instant' },
        },
      ))).rejects.toThrow();

      expect(await store.get('conversation_messages', 'conversation-unknown-key')).toBeUndefined();
      expect(await store.get('conversation_messages', 'conversation-bad-turn-id')).toBeUndefined();
      expect(await store.get('conversation_messages', 'conversation-duplicate-action-ids')).toBeUndefined();
      expect(await store.get('conversations', 'conversation-unknown-metadata')).toBeUndefined();
      expect(await store.get('conversations', conversationId)).toMatchObject({ lastAnalysis: analysis() });
      expect(await store.get('conversations', conversationId)).not.toHaveProperty('rowVersion');
      const db = fixture.openDatabase();
      try {
        expect(db.prepare('SELECT row_version FROM conversations WHERE id = ?').get(conversationId))
          .toEqual({ row_version: 1 });
        expect((db.prepare('SELECT count(*) n FROM conversation_messages WHERE conversation_id = ?').get(conversationId) as { n: number }).n)
          .toBe(1);
      } finally {
        db.close();
      }
    } finally {
      await fixture.dispose();
    }
  });

  itSqliteBound('refuses reapplication when a conversation guard, sync, or revision trigger is missing or replaced', async () => {
    const cases = [
      {
        name: 'missing guard',
        mutate(db: Database.Database) {
          db.exec('DROP TRIGGER workflow_conversations_insert_guard');
        },
      },
      {
        name: 'replaced message guard',
        mutate(db: Database.Database) {
          db.exec('DROP TRIGGER workflow_conversation_messages_update_guard');
          db.exec(`CREATE TRIGGER workflow_conversation_messages_update_guard BEFORE UPDATE ON conversation_messages BEGIN SELECT 1; END`);
        },
      },
      {
        name: 'missing conversation sync trigger',
        mutate(db: Database.Database) {
          db.exec('DROP TRIGGER workflow_conversations_sync_insert');
        },
      },
      {
        name: 'replaced message sync trigger',
        mutate(db: Database.Database) {
          db.exec('DROP TRIGGER workflow_conversation_messages_sync_update');
          db.exec(`CREATE TRIGGER workflow_conversation_messages_sync_update AFTER UPDATE OF payload ON conversation_messages BEGIN SELECT 1; END`);
        },
      },
      {
        name: 'missing conversation revision trigger',
        mutate(db: Database.Database) {
          db.exec('DROP TRIGGER workflow_conversations_revision_insert');
        },
      },
      {
        name: 'replaced message revision trigger',
        mutate(db: Database.Database) {
          db.exec('DROP TRIGGER workflow_conversation_messages_revision_update');
          db.exec(`CREATE TRIGGER workflow_conversation_messages_revision_update AFTER UPDATE ON conversation_messages BEGIN SELECT 1; END`);
        },
      },
    ];

    for (const testCase of cases) {
      const fixture = await createWorkflowSqliteFixture();
      try {
        const store = fixture.store;
        const actorId = `conversation-trigger-actor-${testCase.name.replaceAll(' ', '-')}`;
        const conversationRow = conversation(actorId, `conversation-trigger-row-${testCase.name.replaceAll(' ', '-')}`);
        const messageRow = {
          id: `conversation-trigger-message-${testCase.name.replaceAll(' ', '-')}`,
          conversationId: conversationRow.id,
          actorId,
          role: 'user' as const,
          text: 'Trigger attestation fixture.',
          mode: 'scripted_demo' as const,
          modeRevision: 1,
          createdAt,
          turnId: 'conversation-trigger-turn',
          sessionId: 'conversation-trigger-session',
        };
        await store.transaction(async (tx) => {
          await tx.put('profiles', profile(actorId));
          await tx.put('conversations', conversationRow);
          await tx.put('conversation_messages', messageRow);
        });
        store.close?.();

        const db = fixture.openDatabase();
        try {
          testCase.mutate(db);
          const beforeSchema = sqliteSchema(db);
          const beforeConversation = rowSnapshot(db, 'conversations', conversationRow.id)!;
          const beforeMessage = rowSnapshot(db, 'conversation_messages', messageRow.id)!;
          const beforeLedger = historicalLedger(db);
          const beforeRevision = (db.prepare('SELECT revision FROM appmeta WHERE singleton = 1').get() as { revision: number }).revision;

          expect(() => applyWorkflowSqliteMigrations(db), testCase.name).toThrow(/incompatible conversation trigger/);

          expect(sqliteSchema(db)).toEqual(beforeSchema);
          expect(rowSnapshot(db, 'conversations', conversationRow.id)).toEqual(beforeConversation);
          expect(rowSnapshot(db, 'conversation_messages', messageRow.id)).toEqual(beforeMessage);
          expect(historicalLedger(db)).toEqual(beforeLedger);
          expect((db.prepare('SELECT revision FROM appmeta WHERE singleton = 1').get() as { revision: number }).revision)
            .toBe(beforeRevision);
        } finally {
          db.close();
        }
      } finally {
        await fixture.dispose();
      }
    }
  });
});
