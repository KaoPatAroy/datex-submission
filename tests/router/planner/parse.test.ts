import { describe, expect, it } from 'vitest';
import { parseTurnPlan } from '@/lib/router/planner/parse';
import { turnPlanSchema } from '@/lib/router/turn-plan';

const greeting = { turnPlanVersion: 1, steps: [{ kind: 'conversation', topic: 'greeting', prose: 'Hello.' }] };

describe('TurnPlan parser', () => {
  it('extracts one object from a fenced response with surrounding prose', () => {
    const result = parseTurnPlan(`Here is the plan:\n\`\`\`json\n${JSON.stringify(greeting)}\n\`\`\`\nDone.`);
    expect(result).toEqual({ success: true, plan: greeting });
  });

  it('rejects competing JSON objects instead of merging them', () => {
    const result = parseTurnPlan(`${JSON.stringify(greeting)} ${JSON.stringify(greeting)}`);
    expect(result).toMatchObject({ success: false, code: 'malformed_model_json' });
  });

  it('returns schema paths for one repair attempt', () => {
    const result = parseTurnPlan({ turnPlanVersion: 1, steps: [] }, turnPlanSchema);
    expect(result).toMatchObject({ success: false, code: 'invalid_model_plan' });
    if (result.success) throw new Error('Expected invalid schema result');
    expect(result.issuePaths.join('\n')).toContain('steps');
    expect(result.issuePaths.join('\n')).not.toContain('Hello');
  });

  it('materializes query span offsets on the server after extracting JSON', () => {
    const query = {
      turnPlanVersion: 1,
      steps: [{ kind: 'query', continuation: false, plan: {
        planVersion: 1, planId: 'P1', datasetId: 'branch_performance',
        measures: [{ fieldId: 'net_sales', aggregation: 'sum', interpretation: { value: 'net_sales', source: 'explicit', sourceText: { text: 'sales' }, confidence: 1 } }],
        dimensions: [], filters: [], scope: null, time: null, grain: ['branch', 'date'], aggregation: 'registered',
        multiDateGrain: null, group: { fieldIds: [] }, compare: null, sort: [], topN: null,
        completeness: { expectation: 'requested_scope', requireFullPopulation: true, requiredSourceIds: [], minimumCoverage: 1 },
        clarificationNeeds: [], confidence: 1, requestedUses: ['answer'],
      } }],
    };
    const result = parseTurnPlan(query);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const step = result.plan.steps[0];
    expect(step.kind).toBe('query');
    if (step.kind !== 'query') return;
    expect(step.plan.measures[0]?.interpretation.sourceText).toEqual({ start: 0, end: 5, text: 'sales' });
  });
});
