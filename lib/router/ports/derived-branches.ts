import type { NumericClaim } from '../../dynamic/evidence/claim-graph';
import type { AcceptedEvidence } from './effect-bindings';
import { isTableEvidence, type TableAcceptedEvidence } from './table-evidence';

/**
 * S2: a derived branch set ("the branches below target") is never typed by the model. The plan names an accepted answer and a REGISTERED
 * rule; the server expands it to exact branch ids from that answer's verified claims (numbers only from evidence). Pure: no user text.
 *  - below_target: branch-performance answers; a branch counts when its own claims show gap < 0, achievement < 100, or net sales < target.
 *  - positive_value: any answer grouped by branch; a branch counts when some measure claim for it is a number > 0 (stock issues, incidents, tickets).
 */
export const BRANCH_RULES = ['below_target', 'positive_value'] as const;
export type BranchRule = (typeof BRANCH_RULES)[number];
export type DerivedBranches = { ok: true; branchIds: string[] } | { ok: false; code: 'rule_unsupported' | 'no_branch_grouping' };

interface Fact { measure: string; value: number | null; branch: string | undefined }

function factsOf(found: AcceptedEvidence | TableAcceptedEvidence): Fact[] {
  if (isTableEvidence(found)) {
    return found.claims.claims.flatMap((claim): Fact[] => {
      if (typeof claim.value === 'number' || claim.value === null) return [{ measure: claim.fieldId, value: claim.value, branch: claim.dimensions.branch }];
      const record = claim.value as Readonly<Record<string, string | number | null>>, branch = typeof record.branch === 'string' ? record.branch : claim.dimensions.branch;
      return Object.entries(record).map(([id, value]) => ({ measure: id, value: typeof value === 'number' ? value : null, branch }));
    });
  }
  return (found.graph.claims as readonly NumericClaim[]).filter(claim => claim.dimensions.comparison !== 'difference')
    .map(claim => ({ measure: claim.measure, value: claim.value, branch: claim.dimensions.branch }));
}

export function deriveBranchIds(found: AcceptedEvidence | TableAcceptedEvidence, rule: BranchRule | undefined): DerivedBranches {
  const facts = factsOf(found).filter((fact): fact is Fact & { branch: string } => !!fact.branch);
  if (!facts.length) return { ok: false, code: 'no_branch_grouping' };
  const table = isTableEvidence(found);
  const chosen: BranchRule = rule ?? (table ? 'positive_value' : 'below_target');
  if (chosen === 'below_target' && table) return { ok: false, code: 'rule_unsupported' };
  const byBranch = new Map<string, Fact[]>();
  for (const fact of facts) byBranch.set(fact.branch, [...(byBranch.get(fact.branch) ?? []), fact]);
  const hit = (items: Fact[]): boolean => {
    if (chosen === 'positive_value') return items.some(f => typeof f.value === 'number' && f.value > 0);
    const value = (id: string) => { const found = items.find(f => f.measure === id && typeof f.value === 'number'); return found ? found.value as number : undefined; };
    const gap = value('gap'), achievement = value('achievement'), net = value('net_sales'), target = value('target');
    return (gap !== undefined && gap < 0) || (achievement !== undefined && achievement < 100) || (net !== undefined && target !== undefined && target > 0 && net < target);
  };
  return { ok: true, branchIds: [...byBranch].filter(([, items]) => hit(items)).map(([id]) => id).sort() };
}
