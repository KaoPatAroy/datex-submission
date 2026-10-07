import { z } from 'zod';
import { idSchema, refSchema, type Ref } from '../plan/schemas';
import { digest, freeze } from '../shared';
import type { ActorAuthority } from '../validate/query-plan';

export const learningProposalSchema = z.object({
  version: z.literal(1), id: idSchema, revision: z.number().int().positive(), kind: z.literal('catalog_label'),
  catalog: refSchema, targetId: idSchema, proposedLabel: z.string().trim().min(1).max(80),
  provenance: z.object({ source: z.enum(['user_correction', 'model_suggestion', 'discovery']), evidence: refSchema }).strict(),
  status: z.literal('pending_review'), requiredReviewers: z.tuple([z.literal('semantic_owner'), z.literal('security_owner')]),
  activationAllowed: z.literal(false), previous: refSchema.nullable(), createdAt: z.string().datetime({ offset: true }),
}).strict();
export type GovernedLearningRecord = z.infer<typeof learningProposalSchema> & { ref: Ref };

export const approvedCatalogLabelSchema = z.object({ catalog: refSchema, targetId: idSchema,
  label: z.string().trim().min(1).max(80), description: z.string().trim().max(500).optional(),
  examples: z.array(z.string().trim().min(1).max(200)).max(10).optional(), status: z.literal('approved') }).strict();
export type ApprovedCatalogLabel = z.infer<typeof approvedCatalogLabelSchema>;
export type PlannerCatalogLabel = Pick<ApprovedCatalogLabel, 'targetId' | 'label' | 'description' | 'examples'>;

/** Approved labels are planner-context data only; server code must never match user text against them. */
export function approvedCatalogLabelsForPlanner(records: readonly ApprovedCatalogLabel[], catalog: Ref,
  registeredTargetIds: ReadonlySet<string>): readonly PlannerCatalogLabel[] {
  return records.map(record => approvedCatalogLabelSchema.parse(record)).filter(record =>
    digest(record.catalog) === digest(catalog) && registeredTargetIds.has(record.targetId))
    .map(({ targetId, label, description, examples }) => ({ targetId, label, ...(description ? { description } : {}), ...(examples ? { examples } : {}) }));
}

/** Returns an immutable pending record for storage; there is no catalog mutation or promotion API. */
export function proposeGovernedLearning(input: {
  proposal: unknown; catalog: Ref; actor: ActorAuthority; allowedTargetIds: readonly string[];
  recordedSourceText: string; now: string; previous?: GovernedLearningRecord;
}): GovernedLearningRecord {
  const record = learningProposalSchema.parse(input.proposal);
  z.string().min(1).max(200).parse(input.recordedSourceText);
  z.string().datetime({ offset: true }).parse(input.now);
  if (!input.actor.active || !input.actor.permissions.includes('catalog.learning.propose') ||
    digest(record.catalog) !== digest(input.catalog) || !input.allowedTargetIds.includes(record.targetId)) throw new Error('Unregistered learning target.');
  if (record.proposedLabel.toLowerCase().includes(input.recordedSourceText.toLowerCase())) throw new Error('Learning label contains recorded source text.');
  if (Math.abs(Date.parse(record.createdAt) - Date.parse(input.now)) > 5 * 60_000) throw new Error('Learning timestamp outside allowed clock skew.');
  const previous = input.previous;
  if (record.revision !== (previous?.revision ?? 0) + 1 || digest(record.previous) !== digest(previous?.ref ?? null) ||
    previous && (record.id !== previous.id || record.kind !== previous.kind || Date.parse(record.createdAt) < Date.parse(previous.createdAt))) throw new Error('Learning revision mismatch.');
  return freeze({ ...record, ref: { id: record.id, version: record.revision, digest: digest(record) } });
}
