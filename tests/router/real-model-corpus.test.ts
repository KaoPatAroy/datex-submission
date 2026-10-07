/**
 * Real-model corpus: raw planner outputs recorded from the live model (qwen via the 9arm gateway, eval @3eeee5f) for the
 * Thai eval prompts. Every entry is replayed through the REAL parse -> canonicalize -> validate -> executors -> render path
 * against a fully seeded demo workspace. This is the regression guard against "scripted-only green": scripted fixtures
 * never produced these plan shapes.
 *
 * Context is reconstructed per entry (prior corpus turns in the same conversation, saved dashboards, a monitor) and the
 * run-specific ids the model copied from its SERVER_CONTEXT (state / dashboard / monitor / proposal ids) are mapped onto
 * the ids of the reconstructed context, positionally by kind. User text is only ever passed through, never inspected.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import corpus from './fixtures/real-model-corpus.json';
import type { Actor, Table } from '../../lib/contracts';
import type { TurnPlannerInput } from '../../lib/router/planner/input';
import type { RouterTurnOutcome } from '../../lib/core/router-turn';
import type { TurnPlanValidation } from '../../lib/router/validate';
import { ConciergeService } from '../../lib/core/service';
import { createSeedData } from '../../lib/seed/generate';
import { createSqliteStore } from '../../lib/storage/sqlite';
import { AIRuntimeError } from '../../lib/ai/errors';
import { parseTurnPlan } from '../../lib/router/planner/parse';

interface CorpusEntry {
  id: string; scenario: string; role: 'executive' | 'east' | 'hr'; user: string; repair: boolean; content: string;
  /** Corpus entries replayed first in the same conversation (their outcome is not asserted there). */
  prior?: string[];
  /** Confirm the staged proposal the last prior turn created (e.g. install a monitor before managing it). */
  confirmPrior?: boolean;
  /** Expected outcome class with the real-model plan (see Observed). */
  expect?: Observed;
  /** G3: what the user must (not) see, the server-built choice ids that must be offered, and the Results the turn must produce. */
  textIncludes?: string[];
  textExcludes?: string[];
  choiceIds?: string[];
  artifacts?: number;
  /** G5: verified receipt cards (direct Dashboard organization) the turn must return. */
  receiptCards?: number;
}
const ENTRIES = corpus as CorpusEntry[];

const capture: { content?: string; outcome?: RouterTurnOutcome; validation?: TurnPlanValidation; parseFailed?: boolean; codes?: string[] } = {};

vi.mock('@/lib/router/planner/provider', async importOriginal => ({
  ...(await importOriginal<object>()),
  requestTurnPlan: async (input: TurnPlannerInput) => {
    const content = mapContextIds(capture.content ?? '', input);
    const parsed = parseTurnPlan(content, input.validator, input.context);
    if (!parsed.success) {
      capture.parseFailed = true;
      throw new AIRuntimeError('invalid_model_response', `corpus plan failed parse: ${parsed.issuePaths.join(', ')}`);
    }
    return parsed.plan;
  },
}));
vi.mock('@/lib/core/router-turn', async importOriginal => {
  const original = await importOriginal<typeof import('../../lib/core/router-turn')>();
  return { ...original, runRouterTurn: async (deps: Parameters<typeof original.runRouterTurn>[0]) => {
    const outcome = await original.runRouterTurn(deps);
    capture.outcome = outcome;
    return outcome;
  } };
});
vi.mock('@/lib/router/executors/query', async importOriginal => {
  const original = await importOriginal<typeof import('../../lib/router/executors/query')>();
  return { ...original, executeQueryStep: async (input: Parameters<typeof original.executeQueryStep>[0]) => {
    const result = await original.executeQueryStep(input);
    if (result.outcome !== 'accepted') (capture.codes ??= []).push(`query:${result.code}`);
    return result;
  } };
});
vi.mock('@/lib/router/executors/hr', async importOriginal => {
  const original = await importOriginal<typeof import('../../lib/router/executors/hr')>();
  return { ...original, executeHrQueryStep: async (input: Parameters<typeof original.executeHrQueryStep>[0]) => {
    const result = await original.executeHrQueryStep(input);
    if (result.outcome !== 'accepted') (capture.codes ??= []).push(`hr:${result.code}`);
    return result;
  } };
});
vi.mock('@/lib/router/validate', async importOriginal => {
  const original = await importOriginal<typeof import('../../lib/router/validate')>();
  return { ...original, validateTurnPlan: (input: Parameters<typeof original.validateTurnPlan>[0]) => {
    const result = original.validateTurnPlan(input);
    capture.validation = result;
    return result;
  } };
});

/** Run-specific ids the model copied from its context, mapped positionally onto the reconstructed context of this run. */
function mapContextIds(content: string, input: TurnPlannerInput): string {
  const context = input.context;
  const replaceKind = (text: string, pattern: RegExp, targets: readonly string[]) => {
    const seen: string[] = [];
    return text.replace(pattern, id => {
      if (!seen.includes(id)) seen.push(id);
      return targets[seen.indexOf(id)] ?? id;
    });
  };
  const states = [...new Set([context.previousState?.stateId, ...context.acceptedStates.map(s => s.stateId)].filter((s): s is string => !!s))];
  let out = replaceKind(content, /conversation_state:[0-9a-f]{40}/g, states.filter(s => s.startsWith('conversation_state:')));
  out = replaceKind(out, /effect_[0-9a-f]{24}/g, context.dashboards.map(d => d.id));
  out = replaceKind(out, /monitor:stg_[0-9a-f-]{36}/g, (context.monitors ?? []).map(m => m.id));
  out = replaceKind(out, /(?<!monitor:)stg_[0-9a-f-]{36}/g, context.pendingActions.map(p => p.id));
  // G5: Result ids (revise base) and saved-Dashboard ids written as dash_<uuid>.
  out = replaceKind(out, /artifact_[0-9a-f-]{36}/g, context.artifacts.map(a => a.id));
  out = replaceKind(out, /dash_[0-9a-f-]{36}/g, context.dashboards.map(d => d.id));
  return out;
}

const BUSINESS_DATE = '2026-10-01';
const NOW = new Date('2026-10-02T05:00:00.000Z');
const ACTORS: Record<CorpusEntry['role'], Actor> = {} as Record<CorpusEntry['role'], Actor>;
let directory: string;
let service: ConciergeService;
let store: ReturnType<typeof createSqliteStore>;

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('USE_LOCAL_DEMO_DATA', 'true');
  vi.stubEnv('BIZTANIA_DYNAMIC_QUERY', '');
  directory = await mkdtemp(join(tmpdir(), 'nexus-tests-corpus-'));
  store = createSqliteStore(join(directory, 'corpus.sqlite'));
  const seed = createSeedData(BUSINESS_DATE);
  const sessions = seed.profiles.filter(p => ['executive', 'east', 'hr'].includes(p.id)).map(p => ({
    id: `corpus-session-${p.id}`, profileId: p.id, mode: 'live_ai', modeRevision: 1, csrfToken: 'corpus-csrf', expiresAt: '2099-01-01T00:00:00.000Z',
  }));
  const rows: Array<[Table, Array<{ id: string }>]> = [
    ['profiles', seed.profiles], ['branches', seed.branches], ['products', seed.products], ['sales_orders', seed.sales_orders],
    ['sales_targets', seed.sales_targets], ['inventory_snapshots', seed.inventory_snapshots], ['incidents', seed.incidents],
    ['staffing_summaries', seed.staffing_summaries], ['employees', seed.employees], ['policy_documents', seed.policy_documents],
    ['mock_badges', seed.mock_badges], ['sessions', sessions],
  ];
  await store.transaction(async tx => { for (const [table, values] of rows) for (const value of values) await tx.put(table, value); });
  for (const profile of seed.profiles) {
    if (profile.id !== 'executive' && profile.id !== 'east' && profile.id !== 'hr') continue;
    ACTORS[profile.id] = { ...profile, sessionId: `corpus-session-${profile.id}`, mode: 'live_ai', modeRevision: 1 };
  }
  service = new ConciergeService(store, { businessDate: BUSINESS_DATE, now: () => new Date(NOW) });
}, 120_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  store?.close?.();
  if (directory) await rm(directory, { recursive: true, force: true });
});

/**
 * Outcome classes. Success classes: answer (verified data answer), action (prepared/created/updated/cancelled effect),
 * clarify (question with server-validated choices), clarify_suggest (question / refusal with server-owned next-step chips),
 * conversation (greeting/advice/ack/out-of-scope prose), denied (a real authorization refusal), limited (truthful data
 * limitation such as dates outside the served window). Failure classes: clarify_bare (dead end) and failed (unusable plan).
 */
type Observed = 'answer' | 'action' | 'clarify' | 'clarify_suggest' | 'conversation' | 'denied' | 'limited' | 'clarify_bare' | 'failed';
const SUCCESS: ReadonlySet<Observed> = new Set(['answer', 'action', 'clarify', 'clarify_suggest', 'conversation', 'denied', 'limited']);

const PLANNER_FAILURE_PREFIX = 'ยังประมวลผลคำขอนี้ไม่สำเร็จ';
const AUTHORIZATION_CODES = new Set(['permission_denied', 'scope_denied', 'explicit_scope_denied', 'dataset_permission', 'field_permission',
  'dataset_unavailable', 'unknown_action', 'recipient_denied', 'FORBIDDEN', 'hr_scope', 'hr_permission']);

function classify(): Observed {
  if (capture.parseFailed) return 'failed';
  const outcome = capture.outcome, validation = capture.validation;
  if (!outcome || !validation) return 'failed';
  if (outcome.text.startsWith(PLANNER_FAILURE_PREFIX)) return 'failed';
  const unresolved = (): Observed => outcome.choices?.length ? 'clarify' : outcome.followUps?.length ? 'clarify_suggest' : 'clarify_bare';
  if (validation.outcome === 'denied') return AUTHORIZATION_CODES.has(validation.code) ? 'denied' : 'failed';
  if (validation.outcome === 'clarify') return unresolved();
  const kinds = validation.plan.steps.map(s => s.kind);
  if (outcome.actions.some(a => ['created', 'proposed', 'updated', 'cancelled'].includes(a.outcome))) return 'action';
  if (outcome.denials?.some(d => AUTHORIZATION_CODES.has(d.code) || AUTHORIZATION_CODES.has(d.code.split(':')[0]!))) return 'denied';
  if (kinds.includes('conversation')) return 'conversation';
  if (!outcome.clarification) return 'answer';
  if (kinds.includes('clarify')) return unresolved();
  if (outcome.choices?.length) return 'clarify';
  return outcome.followUps?.length ? 'limited' : 'clarify_bare';
}

const byId = new Map(ENTRIES.map(entry => [entry.id, entry]));

async function turnOf(entry: CorpusEntry, conversationId?: string) {
  for (const key of Object.keys(capture) as (keyof typeof capture)[]) delete capture[key];
  capture.content = entry.content;
  return service.turn(ACTORS[entry.role], entry.user, conversationId);
}

interface EntryResult { observed: Observed; text: string; choiceIds?: string[]; artifacts?: number; receiptCards?: number }

async function runEntry(entry: CorpusEntry): Promise<EntryResult> {
  let conversationId: string | undefined;
  let lastProposal: string | undefined;
  for (const priorId of entry.prior ?? []) {
    const prior = byId.get(priorId)!;
    conversationId = (await turnOf(prior, conversationId)).conversationId;
    lastProposal = capture.outcome?.actions.find(a => a.outcome === 'proposed')?.ids.pendingActionId ?? lastProposal;
  }
  if (entry.confirmPrior && lastProposal) await service.confirmStagedProposal(ACTORS[entry.role], lastProposal);
  const response = await turnOf(entry, conversationId);
  return { observed: classify(), text: response.message, choiceIds: capture.outcome?.choices?.map(choice => choice.id) ?? [], artifacts: capture.outcome?.artifacts?.length ?? 0,
    receiptCards: response.receiptCards?.length ?? 0 };
}

const results = new Map<string, EntryResult>();

describe('real-model corpus (recorded live planner outputs)', { timeout: 900_000 }, () => {
  beforeAll(async () => {
    const report: string[] = [];
    for (const entry of ENTRIES) {
      let result: EntryResult;
      try { result = await runEntry(entry); }
      catch (error) { result = { observed: 'failed', text: `THROW ${(error as Error).message}` }; }
      results.set(entry.id, result);
      report.push([entry.id, entry.role, result.observed, entry.expect ?? '-', entry.user, result.text.replace(/\s+/g, ' ').slice(0, 220),
        capture.validation?.outcome === 'accepted' ? '' : JSON.stringify(capture.validation ?? null).slice(0, 300),
        [...(capture.codes ?? []), ...(capture.outcome?.actions ?? []).map(a => `${a.actionId}:${a.outcome}:${'code' in a ? a.code : ''}`)].join(' ')].join('\t'));
    }
    if (process.env.CORPUS_REPORT) (await import('node:fs')).writeFileSync(process.env.CORPUS_REPORT, report.join('\n'));
  }, 900_000);

  it('every entry reaches its expected outcome class with the real model plan', () => {
    const mismatches = ENTRIES.filter(entry => entry.expect && results.get(entry.id)?.observed !== entry.expect)
      .map(entry => `${entry.id} ${entry.user}: expected ${entry.expect}, got ${results.get(entry.id)?.observed} — ${results.get(entry.id)?.text.slice(0, 160)}`);
    expect(mismatches).toEqual([]);
    expect(ENTRIES.every(entry => entry.expect)).toBe(true);
  });

  it('at least 90% of recorded turns end in a success class (no dead ends, no unusable plans)', () => {
    const ok = ENTRIES.filter(entry => SUCCESS.has(results.get(entry.id)!.observed)).length;
    expect(ok / ENTRIES.length).toBeGreaterThanOrEqual(0.9);
  });

  it('G3 entries show the user what they must (text, server-built choices, chart Results) and never the garbled model Thai', () => {
    const problems = ENTRIES.flatMap(entry => {
      const result = results.get(entry.id)!;
      return [
        ...(entry.textIncludes ?? []).filter(text => !result.text.includes(text)).map(text => `${entry.id}: missing "${text}"`),
        ...(entry.textExcludes ?? []).filter(text => result.text.includes(text)).map(text => `${entry.id}: shows "${text}"`),
        ...(entry.choiceIds ?? []).filter(id => !result.choiceIds?.includes(id)).map(id => `${entry.id}: no choice ${id} (got ${result.choiceIds?.join(',')})`),
        ...(entry.artifacts !== undefined && result.artifacts !== entry.artifacts ? [`${entry.id}: ${result.artifacts} artifacts, expected ${entry.artifacts}`] : []),
        ...(entry.receiptCards !== undefined && result.receiptCards !== entry.receiptCards ? [`${entry.id}: ${result.receiptCards} receipt cards, expected ${entry.receiptCards}`] : []),
      ];
    });
    expect(problems).toEqual([]);
  });

  it('no user-visible text leaks internal codes, raw param paths or demo fixture names', () => {
    const leaks = [...results.entries()].filter(([, r]) => /params\.|conversation_state:|kpi_not_single_value|Demo (Executive|East Manager)|\(\w+_\w+\)/u.test(r.text))
      .map(([id, r]) => `${id}: ${r.text.slice(0, 200)}`);
    expect(leaks).toEqual([]);
  });
});
