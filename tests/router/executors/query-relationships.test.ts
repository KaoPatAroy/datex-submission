import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeQueryStep } from '@/lib/router/executors/query';
import { proposal, span } from '../../dynamic/fixtures';
import { actors, base, read, seed, type Fixture } from './fixtures';

let fixture: Fixture;
beforeEach(async () => { fixture = await seed(); });
afterEach(async () => { await fixture.dispose(); });

describe('query executor analysis relationships', () => {
  it('carries the server-computed cross-region comparison with its source ids', async () => {
    const message = 'Compare East and Central region sales', plan = proposal(message);
    plan.dimensions = [{ fieldId: 'region', interpretation: { value: 'region', source: 'explicit', sourceText: span(message, 'region'), confidence: 1 } }];
    plan.group.fieldIds = ['region'];
    plan.filters = [{ fieldId: 'region', op: 'in', value: ['east', 'central'], sourceText: span(message, 'East and Central'), confidence: 1 } as never];
    const result = await executeQueryStep({ ...base(fixture, actors.executive, message), read, step: { kind: 'query', continuation: false, plan } });
    expect(result.outcome).toBe('accepted');
    if (result.outcome !== 'accepted') return;
    expect(result.analysis.relationships.length).toBeGreaterThan(0);
    expect(result.analysis.relationships[0].text).toContain('สูงกว่า');
    expect(result.analysis.relationships[0].sourceIds.length).toBeGreaterThan(0);
  });
});
