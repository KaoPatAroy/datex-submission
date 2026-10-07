import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor, ConversationMessage } from '../lib/contracts';
import { defaultRuntimes, RuntimeCatalog } from '../lib/core/runtime-catalog';
import { ConciergeService } from '../lib/core/service';
import { finalAssistantContentDigest, normalizedFinalActionIds, turnCompletionId } from '../lib/core/turn-completion-gate';
import { plan, planner } from './helpers/turn-planner';
import { actors, BUSINESS_DATE, createWorkspaceFixture, FIXED_NOW } from './helpers/workspace';
import { span } from './dynamic/fixtures';
import { hrPlan } from './dynamic/wave2/fixtures';
import { executeHrQueryStep } from '../lib/router/executors/hr';

vi.mock('@/lib/router/planner/provider', async importOriginal =>
  (await import('./helpers/turn-planner')).plannerProviderModule(await importOriginal<object>()));

const message = 'Find employee CENTRAL-1.';

/** The planner's structured HR lookup: the employee id is quoted from the message (no text routing on the server). */
function hrLookupStep(text: string, employeeId: string) {
  return {
    kind: 'hr_query',
    plan: {
      ...hrPlan(text),
      dimensions: [],
      filters: [{ fieldId: 'employee_id', op: 'eq', value: employeeId, source: 'explicit', evidenceText: employeeId, sourceText: span(text, employeeId), confidence: 1 }],
    },
  };
}

describe('HR employee region scope fence', () => {
  let fixture: Awaited<ReturnType<typeof createWorkspaceFixture>> | undefined;

  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('USE_LOCAL_DEMO_DATA', 'true');
    vi.stubEnv('BIZTANIA_DYNAMIC_QUERY', '');
    planner.reset();
    planner.reply(plan(hrLookupStep(message, 'CENTRAL-1')));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fixture?.dispose();
    fixture = undefined;
  });

  async function createCentralEmployee() {
    const workspace = await createWorkspaceFixture();
    fixture = workspace;
    await workspace.store.transaction(async tx => {
      await tx.put('employees', {
        id: 'CENTRAL-1', name: 'Synthetic Central Employee', branchId: 'C01', active: true,
      });
      const profile = await tx.get<Record<string, unknown> & { id: string }>('profiles', 'east');
      if (!profile) throw new Error('Missing persisted East Manager profile.');
      await tx.put('profiles', { ...profile, permissions: [...actors.east.permissions, 'hr.read'] });
    });
    await workspace.patchSession(actors.east.sessionId, { mode: 'live_ai', modeRevision: 1 });
    return workspace;
  }

  function service() {
    if (!fixture) throw new Error('The workspace fixture has not been created.');
    return new ConciergeService(fixture.store, { businessDate: BUSINESS_DATE, now: () => new Date(FIXED_NOW) });
  }

  const liveEast = (regions: string[] = ['east']): Actor => ({
    ...actors.east, permissions: [...actors.east.permissions, 'hr.read'], regions, mode: 'live_ai', modeRevision: 1,
  });
  const eastMessage = 'Find employee E024.';
  async function setEastRegions(workspace: Awaited<ReturnType<typeof createWorkspaceFixture>>, regions: string[]) {
    await workspace.store.transaction(async tx => {
      const profile = await tx.get<Record<string, unknown> & { id: string }>('profiles', 'east');
      if (!profile) throw new Error('Missing persisted East Manager profile.');
      await tx.put('profiles', { ...profile, regions });
    });
  }
  /** Persists a completed East turn (E024 lookup) and rewrites its stored citations to the given HR source ids. */
  async function persistedEastTurnCiting(workspace: Awaited<ReturnType<typeof createWorkspaceFixture>>, svc: ConciergeService, sourceId: string) {
    planner.reply(plan(hrLookupStep(eastMessage, 'E024')));
    const liveActor = liveEast(['east', 'central']);
    const turn = await svc.turn(liveActor, eastMessage);
    await workspace.store.transaction(async tx => {
      const stored = await tx.get<ConversationMessage>('conversation_messages', turn.assistantMessageId);
      if (!stored?.sources?.length) throw new Error('The East turn did not persist HR sources.');
      const rewritten: ConversationMessage = {
        ...stored, analysis: undefined, evidence: undefined,
        sources: stored.sources.slice(0, 1).map(source => ({ ...source, id: sourceId })),
      };
      await tx.put('conversation_messages', rewritten);
      // Keep the completed-turn proof consistent with the rewritten content so ONLY the citation fence decides visibility.
      const completionId = turnCompletionId({ actorId: liveActor.id, sessionId: liveActor.sessionId, conversationId: turn.conversationId, turnId: turn.turnId });
      const completion = await tx.get<{ requestLedgerId: string | null; finalContentDigest: string }>('tool_executions', completionId);
      if (!completion) throw new Error('Missing turn completion record.');
      const finalContentDigest = finalAssistantContentDigest(rewritten as never, normalizedFinalActionIds(rewritten));
      await tx.put('tool_executions', { ...completion, finalContentDigest } as never);
      if (completion.requestLedgerId) {
        const ledger = await tx.get<Record<string, unknown> & { id: string }>('tool_executions', completion.requestLedgerId);
        if (ledger) await tx.put('tool_executions', { ...ledger, finalContentDigest } as never);
      }
    });
    return turn;
  }
  const citedHrSources = (value: { sources?: { id: string }[] }) => (value.sources ?? []).filter(source => source.id.startsWith('hr:'));

  it('attributes an HR permission refusal to this account rather than system capability', async () => {
    const workspace = await createCentralEmployee();
    const result = await executeHrQueryStep({ store: workspace.store, actor: actors.executive, message, diagnosticId: 'hr-deny-copy',
      now: () => FIXED_NOW, step: { kind: 'hr_query', plan: hrPlan(message) } });
    expect(result.outcome).toBe('denied');
    expect(result.text).toContain('บัญชีนี้ไม่มีสิทธิ์');
    expect(result.text).not.toContain('ระบบไม่สามารถ');
    expect(result.text).not.toContain('Synthetic Central Employee');
  });

  it('denies a persisted East Manager with hr.read a Central employee lookup through the router', async () => {
    const workspace = await createCentralEmployee();
    await setEastRegions(workspace, ['east', 'central']);
    const result = await service().turn(liveEast(['east', 'central']), message);

    expect(JSON.stringify(result)).not.toContain('Synthetic Central Employee');
    expect(citedHrSources(result)).toEqual([]);
    expect(result.analysis?.facts ?? []).toEqual([]);
  });

  it('redacts a persisted Central citation after the stored profile loses Central scope', async () => {
    const workspace = await createCentralEmployee();
    await setEastRegions(workspace, ['east', 'central']);
    const svc = service();
    // The router's HR reader never serves Central to an East Manager (role limit), so seed the historical citation shape.
    const sourceId = 'hr:C01:employees:CENTRAL-1';
    const turn = await persistedEastTurnCiting(workspace, svc, sourceId);
    const beforeNarrowing = await svc.getWorkspace(actors.east);
    const visibleMessage = beforeNarrowing.messages.find(candidate => candidate.id === turn.assistantMessageId);
    expect(visibleMessage?.sources?.map(source => source.id)).toEqual([sourceId]);

    await setEastRegions(workspace, ['east']);
    const afterNarrowing = await svc.getWorkspace(actors.east);
    const redactedMessage = afterNarrowing.messages.find(candidate => candidate.id === turn.assistantMessageId);
    expect(redactedMessage?.text).toBe('ประวัตินี้อยู่นอกสิทธิ์ปัจจุบัน');
    expect(redactedMessage?.sources).toBeUndefined();
  });

  it('keeps legacy HR citations fail-closed for regional actors and visible to global HR Admin', () => {
    const catalog = new RuntimeCatalog(defaultRuntimes);
    const legacyEmployeeCitation = 'hr:employees:CENTRAL-1';
    const narrowedEast = {
      ...actors.east,
      permissions: [...actors.east.permissions, 'hr.read'],
      regions: ['east'],
    };

    expect(catalog.canCite(narrowedEast, legacyEmployeeCitation, new Set(['E02']))).toBe(false);
    expect(catalog.canCite(actors.hr, legacyEmployeeCitation, new Set())).toBe(true);
  });

  it('rejects malformed or unknown HR source shapes before regional or HR Admin scope checks', () => {
    const catalog = new RuntimeCatalog(defaultRuntimes);
    const regionalActor = {
      ...actors.east,
      permissions: [...actors.east.permissions, 'hr.read'],
      regions: ['east'],
    };
    const malformedSources = [
      'hr:',
      'hr:E02:unknown',
      'hr:E02:employees',
      'hr::employees:E024',
      'hr:E02:employees:',
      'hr:E02:employees:E:024',
      `hr:E02:employees:${'E'.repeat(81)}`,
      `hr:${'B'.repeat(150)}:employees:E024`,
    ];

    for (const sourceId of malformedSources) {
      expect(catalog.canCite(regionalActor, sourceId, new Set(['E02']))).toBe(false);
      expect(catalog.canCite(actors.hr, sourceId, new Set())).toBe(false);
    }
    expect(catalog.canCite(regionalActor, 'hr:E02:employees:E024', new Set(['E02']))).toBe(true);
  });

  it('redacts completed history carrying a malformed HR source ID', async () => {
    const workspace = await createCentralEmployee();
    await setEastRegions(workspace, ['east', 'central']);
    const malformedSourceId = 'hr:C01:unknown';
    const svc = service();
    const turn = await persistedEastTurnCiting(workspace, svc, malformedSourceId);
    const persisted = await workspace.store.get<ConversationMessage>('conversation_messages', turn.assistantMessageId);
    expect(persisted?.sources?.map(source => source.id)).toContain(malformedSourceId);

    const readback = await svc.getWorkspace(actors.east);
    const readMessage = readback.messages.find(candidate => candidate.id === turn.assistantMessageId);
    expect(readMessage?.text).toBe('ประวัตินี้อยู่นอกสิทธิ์ปัจจุบัน');
    expect(readMessage?.sources).toBeUndefined();
  });

  it('keeps the global HR Admin employee lookup available without a branch assignment', async () => {
    await createCentralEmployee();
    await fixture!.patchSession(actors.hr.sessionId, { mode: 'live_ai', modeRevision: 1 });
    const result = await service().turn({ ...actors.hr, mode: 'live_ai', modeRevision: 1 }, message);

    expect(result.message).toContain('CENTRAL-1 · Synthetic Central Employee');
    expect(citedHrSources(result).length).toBeGreaterThan(0);
  });

  it('keeps the global HR Admin lookup visible when the workspace is read back', async () => {
    await createCentralEmployee();
    await fixture!.patchSession(actors.hr.sessionId, { mode: 'live_ai', modeRevision: 1 });
    const svc = service();
    const result = await svc.turn({ ...actors.hr, mode: 'live_ai', modeRevision: 1 }, message);
    const sourceIds = citedHrSources(result).map(source => source.id);
    expect(sourceIds.length).toBeGreaterThan(0);
    expect((await svc.getWorkspace(actors.hr)).messages.some(candidate =>
      candidate.role === 'assistant' && candidate.sources?.some(source => sourceIds.includes(source.id)))).toBe(true);
  });
});
