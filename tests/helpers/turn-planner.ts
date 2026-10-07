/**
 * Test double for the TurnPlan planner provider. Suites mock `@/lib/router/planner/provider` with
 * `plannerProviderModule(original)` and then script TurnPlans per test:
 *
 *   vi.mock('@/lib/router/planner/provider', async importOriginal =>
 *     (await import('./helpers/turn-planner')).plannerProviderModule(await importOriginal()));
 *
 * The planner returns RAW (unvalidated) plans exactly like the provider does after schema parsing; the service
 * still runs validateTurnPlan, authority, evidence grounding and the registered executors on them.
 * Live turns need `AI_PROVIDER=scripted`-independent env only for the kill switch; no network is used.
 */
import type { PlannerContext } from '@/lib/router/planner-context';
import type { TurnPlannerInput } from '@/lib/router/planner/input';
import type { ParamEnvelope, ParamValue, TurnPlan } from '@/lib/router/turn-plan';

type PlannerRuntime = { actor?: unknown; diagnosticId?: string; signal?: AbortSignal; onFinishReason?: (reason: string | null) => void };
export type PlannerReply = unknown | ((input: TurnPlannerInput, runtime: PlannerRuntime) => unknown | Promise<unknown>);

let handler: PlannerReply | undefined;
let queue: PlannerReply[] = [];
export const plannerCalls: TurnPlannerInput[] = [];

export const planner = {
  /** Every planner call returns this plan (or computes it from the call's input). */
  reply(reply: PlannerReply) { handler = reply; queue = []; },
  /** The n-th planner call returns the n-th reply; a call beyond the queue fails like a missing fixture. */
  sequence(...replies: PlannerReply[]) { queue = [...replies]; handler = undefined; },
  /** Planner provider failure (throws the given error). */
  fail(error: Error) { handler = () => { throw error; }; queue = []; },
  reset() { handler = undefined; queue = []; plannerCalls.length = 0; },
  get calls() { return plannerCalls; },
};

export async function requestTurnPlan(input: TurnPlannerInput, runtime: PlannerRuntime): Promise<unknown> {
  plannerCalls.push(input);
  const reply = queue.length ? queue.shift() : handler;
  if (reply === undefined) throw new Error('No planner reply was scripted for this test.');
  const value = typeof reply === 'function' ? await (reply as (i: TurnPlannerInput, r: PlannerRuntime) => unknown)(input, runtime) : reply;
  runtime.onFinishReason?.('stop');
  return value;
}

export function plannerProviderModule<T extends object>(original: T): T & { requestTurnPlan: typeof requestTurnPlan } {
  return { ...original, requestTurnPlan };
}

// ----------------------------------------------------------------------------------------------- plan builders
export const plan = (...steps: unknown[]): TurnPlan => ({ turnPlanVersion: 1, steps } as TurnPlan);
export const param = (value: ParamValue, source: ParamEnvelope['source'], evidenceText?: string): ParamEnvelope => ({
  value, source, ...(evidenceText === undefined ? {} : { evidenceText }),
});
export const quoted = (value: ParamValue, evidenceText: string) => param(value, 'user_quoted', evidenceText);
export const fromContext = (value: ParamValue) => param(value, 'context_id');

export function baseQueryPlan(context: PlannerContext, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    planVersion: 1, planId: 'test:query', datasetId: 'branch_performance',
    measures: [{ fieldId: 'net_sales', aggregation: 'sum', interpretation: { value: 'net_sales', source: 'default', sourceText: null, confidence: 1 } }],
    dimensions: [], filters: [], scope: null,
    time: { fieldId: 'date', timezone: context.business.timezone, source: 'default', dates: [context.business.date] },
    grain: ['branch', 'date'], aggregation: 'registered', multiDateGrain: null, group: { fieldIds: [] }, compare: null,
    sort: [], topN: null,
    completeness: { expectation: 'requested_scope', requireFullPopulation: true, requiredSourceIds: [], minimumCoverage: 1 },
    clarificationNeeds: [], confidence: 1, requestedUses: ['answer'],
    ...overrides,
  };
}

/** Span of an exact substring of the message (the schema requires start/end/text). */
export function span(message: string, text: string) {
  const start = message.indexOf(text);
  if (start < 0) throw new Error(`Span text is not in the message: ${text}`);
  return { start, end: start + text.length, text };
}

/** A region-scoped sales query. `regionText` / `dateText` must be exact substrings of the user message. */
export function regionQueryStep(input: TurnPlannerInput, regionId: string, regionText: string, date?: string, dateText?: string, continuation = false) {
  const query = baseQueryPlan(input.context, {
    dimensions: [{ fieldId: 'region', interpretation: { value: 'region', source: 'explicit', sourceText: span(input.currentMessage, regionText), confidence: 1 } }],
    filters: [{ fieldId: 'region', op: 'eq', value: regionId, source: 'explicit', evidenceText: regionText, confidence: 1 }],
    grain: ['region', 'date'], group: { fieldIds: ['region'] },
    ...(date && dateText ? { time: { fieldId: 'date', timezone: input.context.business.timezone, source: 'explicit', dates: [date], evidenceText: dateText } } : {}),
  });
  return { kind: 'query', continuation, plan: query };
}

/** A branch-scoped sales query. `branchText` must be an exact substring of the user message. */
export function branchQueryStep(input: TurnPlannerInput, branchId: string, branchText: string, date?: string, dateText?: string, continuation = false) {
  const query = baseQueryPlan(input.context, {
    filters: [{ fieldId: 'branch', op: 'eq', value: branchId, source: 'explicit', evidenceText: branchText, confidence: 1 }],
    ...(date && dateText ? { time: { fieldId: 'date', timezone: input.context.business.timezone, source: 'explicit', dates: [date], evidenceText: dateText } } : {}),
  });
  return { kind: 'query', continuation, plan: query };
}

/** Default-scope (authorized default, business date) sales query with no explicit evidence. */
export const defaultQueryStep = (input: TurnPlannerInput, continuation = false) => ({ kind: 'query', continuation, plan: baseQueryPlan(input.context) });

export const clarifyStep = (about: Record<string, unknown>, slot: string, question: string, choices: Array<{ id: string; label: string }> = [], reason = 'absent') => ({
  kind: 'clarify', about, missing: [{ slot, reason }], question, choices,
});
export const conversationStep = (topic: 'greeting' | 'capability' | 'advice' | 'acknowledgement' | 'out_of_scope', prose: string) => ({ kind: 'conversation', topic, prose });

export const dashboardCreateStep = (title = 'Sales overview', extra: Record<string, ParamEnvelope> = {}) => ({
  kind: 'action', actionId: 'dashboard.create', params: { title: param(title, 'generated'), ...extra },
});
export const dashboardShareStep = (dashboardId: string, recipientId: string) => ({
  kind: 'action', actionId: 'dashboard.share', params: { dashboard: fromContext(dashboardId), recipientId: fromContext(recipientId) },
});
export const ticketCreateStep = (branchIds: string[], evidenceText: string, extra: Record<string, ParamEnvelope> = {}) => ({
  kind: 'action', actionId: 'ticket.create', params: { branchIds: quoted(branchIds, evidenceText), ...extra },
});
export const badgeRevokeStep = (badgeId: string, employeeId: string, reason: string, evidenceText = reason) => ({
  kind: 'action', actionId: 'badge.revoke', params: {
    badgeId: quoted(badgeId, badgeId), employeeId: quoted(employeeId, employeeId), reason: quoted(reason, evidenceText),
  },
});
export const refineCancelStep = (pendingActionId: string) => ({ kind: 'refine', pendingActionId, operation: { op: 'cancel' } });
export const refineTitleStep = (pendingActionId: string, title: string) => ({
  kind: 'refine', pendingActionId, operation: { op: 'revise_dashboard', title: quoted(title, title) },
});
