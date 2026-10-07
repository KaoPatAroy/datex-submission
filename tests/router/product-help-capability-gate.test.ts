import { describe, expect, it } from 'vitest';
import { actionRegistry } from '@/lib/router/action-registry';
import type { PlannerContext } from '@/lib/router/planner-context';
import { accountCapability, PRODUCT_CONCEPT_IDS, PRODUCT_OVERVIEW_TEXT } from '@/lib/router/product-model';
import { renderConversation } from '@/lib/router/render';
import { validateTurnPlan } from '@/lib/router/validate';
import { plan } from '../helpers/turn-planner';
import { contextFor, fullCapabilityContext, permissionsFor } from './fixtures';

/** G2 / P1-2: product_help prose cannot advertise an unavailable capability in OTHER WORDS ("automatic low-sales alerts" without Monitor). */
function withPermissions(role: 'executive' | 'east_manager' | 'hr_admin', permissions: string[]): PlannerContext {
  const base = contextFor(role);
  return { ...base, scope: { ...base.scope, permissions }, actions: actionRegistry.describeFor({ permissions }) };
}

function render(context: PlannerContext, prose: string, concepts?: string[]) {
  const raw = plan({ kind: 'conversation', topic: 'product_help', prose, ...(concepts ? { concepts } : {}) });
  const validation = validateTurnPlan({ raw, messages: { current: 'x' }, context, registry: actionRegistry, hooks: { isSafeText: () => true } });
  if (validation.outcome !== 'accepted') throw new Error(JSON.stringify(validation));
  return renderConversation(validation.steps[0]!, context);
}

const PARAPHRASES = [
  'DaTex can send you automatic low-sales alerts in Messages and keep an eye on your branches for you.',
  'DaTex ช่วยแจ้งเตือนอัตโนมัติเมื่อยอดขายต่ำ และคอยจับตาสาขาให้คุณ',
  // Onboarding approval in other words (unavailable to every role below).
  'You can sign off new-hire paperwork right here in chat.',
];
const ROLES: Array<[string, PlannerContext]> = [
  ['HR Admin', contextFor('hr_admin')],
  ['East Manager', contextFor('east_manager')],
  ['no monitor.manage', withPermissions('executive', permissionsFor('executive').filter(p => p !== 'dashboard.create'))],
];

describe('product_help capability gate (structural, server-owned copy for restricted accounts)', () => {
  it('the fixture accounts are restricted (no Monitor) and the full-capability fixture has every concept', () => {
    for (const [name, context] of ROLES) {
      expect(accountCapability(context).unavailable, name).toContain('onboarding_request');
      if (name !== 'East Manager') expect(context.actions.map(a => a.actionId), name).not.toContain('monitor.manage');
    }
    expect(accountCapability(fullCapabilityContext()).unavailable).toEqual([]);
  });

  it.each(ROLES)('%s: paraphrased unavailable capability prose is replaced by server copy (general and concept-named)', (_name, context) => {
    for (const prose of PARAPHRASES) {
      for (const concepts of [undefined, ['chat'], ['message']]) {
        const out = render(context, prose, concepts);
        expect(out.fromPlanner, `${prose} ${concepts}`).toBe(false);
        expect(out.text).not.toContain(prose);
        if (accountCapability(context).unavailable.includes('monitor')) expect(out.text).not.toMatch(/Monitor|อัตโนมัติ|low-sales/u);
        expect(out.text).not.toMatch(/Onboarding|new-hire/u);
      }
    }
  });

  it.each(ROLES)('%s: the server overview and concept copy name only concepts this account can use', (_name, context) => {
    const capability = accountCapability(context);
    const NAMES: Record<string, RegExp> = { dashboard: /Dashboard/u, monitor: /Monitor/u, task: /\bTask\b/u, ticket: /\bTicket\b/u, onboarding_request: /Onboarding/u, result: /Results?\b/u };
    for (const concepts of [undefined, ['chat'], ['message'], ['history'], ['action']]) {
      const out = render(context, 'DaTex ช่วยวิเคราะห์ข้อมูลธุรกิจของคุณ', concepts);
      const explanation = out.text.split('\n\n')[0]!;
      for (const concept of capability.unavailable) if (NAMES[concept]) expect(explanation, `${concept} ${concepts}`).not.toMatch(NAMES[concept]!);
    }
  });

  it('a full-capability account keeps the model prose; restricted overview differs from the full overview', () => {
    const out = render(fullCapabilityContext(), PARAPHRASES[1]!);
    expect(out.fromPlanner).toBe(true);
    expect(out.text).toContain(PARAPHRASES[1]);
    expect(render(contextFor('hr_admin'), PARAPHRASES[1]!).text).not.toContain(PRODUCT_OVERVIEW_TEXT);
    expect(PRODUCT_CONCEPT_IDS.length).toBeGreaterThan(0);
  });
});
