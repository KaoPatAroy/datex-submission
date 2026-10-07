import 'server-only';

import type { IntentPlan, QueryPlan, Span } from '../plan/schemas';
import type { PlannerInput } from './planner';

/** Exact local E2E fixtures, not a language interpreter or an authorization decision. */
export function scriptedQueryPlan(input: PlannerInput, businessDate: string, previousPlan?: QueryPlan): IntentPlan | { intentKind: 'not_query' } {
  const text = input.sourceText;
  if (text === 'Create a sales dashboard') return { intentKind: 'not_query' };
  const span = (part: string): Span => {
    const start = text.indexOf(part);
    return { start, end: start + part.length, text: part };
  };
  const plan: IntentPlan = {
    planVersion: 1, planId: 'scripted:query', datasetId: 'branch_performance',
    intentKind: 'query', parentState: null,
    measures: [{ fieldId: 'net_sales', aggregation: 'sum', interpretation: {
      value: 'net_sales', source: 'default', sourceText: null, confidence: 1,
    } }],
    dimensions: [], filters: [], scope: null, time: { fieldId: 'date', timezone: 'Asia/Bangkok', source: 'default', dates: [businessDate] },
    grain: ['branch', 'date'], aggregation: 'registered', multiDateGrain: null,
    group: { fieldIds: [] }, compare: null, sort: [], topN: null,
    completeness: { expectation: 'requested_scope', requireFullPopulation: true, requiredSourceIds: [], minimumCoverage: 1 },
    clarificationNeeds: [], confidence: 1, requestedUses: ['answer'],
  };
  let region: string | undefined, regionText: string | undefined;
  switch (text) {
    case 'ยอดขายภาคตะวันออกวันที่ 1 ตุลาคม 2569':
      region = 'east'; regionText = 'ภาคตะวันออก';
      plan.time = { fieldId: 'date', dates: ['2026-10-01'], timezone: 'Asia/Bangkok',
        source: 'explicit', evidenceText: '1 ตุลาคม 2569' };
      break;
    case 'May I see E01 sales?':
      plan.filters.push({ fieldId: 'branch', op: 'eq', value: 'E01', source: 'explicit', evidenceText: 'E01', sourceText: span('E01'), confidence: 1 });
      break;
    case 'sales in May 2025':
      plan.time = { fieldId: 'date', timezone: 'Asia/Bangkok', source: 'explicit', evidenceText: 'May 2025',
        dates: Array.from({ length: 31 }, (_, index) => `2025-05-${String(index + 1).padStart(2, '0')}`) };
      break;
    case 'bottom 3 vs target':
      plan.measures = [{ fieldId: 'gap', aggregation: 'gap', interpretation: {
        value: 'gap', source: 'explicit', sourceText: span('target'), confidence: 1,
      } }];
      plan.dimensions = [{ fieldId: 'branch', interpretation: { value: 'branch', source: 'default', sourceText: null, confidence: 1 } }];
      plan.group.fieldIds = ['branch'];
      plan.sort = [{ fieldId: 'gap', direction: 'asc' }];
      plan.topN = { count: 3, direction: 'lowest', completeScopeRequired: true };
      plan.completeness = { expectation: 'complete_authorized_population', requireFullPopulation: true,
        requiredSourceIds: [], minimumCoverage: 1 };
      break;
    case 'ยอดขายภาคใต้':
      region = 'south'; regionText = 'ภาคใต้';
      break;
    case 'แล้วภาคกลางล่ะ':
    case 'แล้วภาคกลางยอดขายล่ะ':
      region = 'central'; regionText = 'ภาคกลาง';
      if (input.previousStateRef && previousPlan) {
        plan.intentKind = 'follow_up'; plan.parentState = input.previousStateRef;
        // Retain the resolved date, but never reuse source spans belonging to another message.
        plan.time = previousPlan.time ? { ...previousPlan.time, source: 'inherited',
          dates: [...input.previousState!.resolvedScope.dates], evidenceText: undefined } : null;
        plan.measures = previousPlan.measures.map(measure => ({ ...measure,
          interpretation: { ...measure.interpretation, source: 'inherited', sourceText: null } }));
      } else {
        plan.clarificationNeeds.push({ slotId: 'previous_query', question: 'Please ask an initial sales query first.', choices: [] });
      }
      break;
    default:
      return { intentKind: 'not_query' };
  }
  if (region && regionText) {
    plan.filters.push({ fieldId: 'region', op: 'eq', value: region, source: 'explicit', evidenceText: regionText, sourceText: span(regionText), confidence: 1 });
    plan.dimensions = [{ fieldId: 'region', interpretation: {
      value: 'region', source: 'explicit', sourceText: span(regionText), confidence: 1,
    } }];
    plan.group.fieldIds = ['region'];
  }
  return plan;
}
