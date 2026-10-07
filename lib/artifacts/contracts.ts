import { z } from 'zod';
import { idSchema, refSchema, queryPlanSchema } from '../dynamic/plan/schemas';
import type { ActorAuthority } from '../dynamic/validate/query-plan';
import { freeze } from '../dynamic/shared';

export const ARTIFACT_LIMITS = freeze({ rows: 2000, claims: 2000, sources: 10000, bytes: 2_000_000, versions: 100, previewMs: 300_000 });
export const ARTIFACT_REGISTRY = freeze({
  table: { permission: 'dashboard.create', format: 'preview' },
  ranking: { permission: 'dashboard.create', format: 'preview' },
  chart: { permission: 'dashboard.create', format: 'preview' },
  executive_brief: { permission: 'dashboard.create', format: 'preview' },
  csv_export: { permission: 'dashboard.create', format: 'csv' },
} as const);
export type ArtifactKind = keyof typeof ARTIFACT_REGISTRY;
export const artifactKindSchema = z.enum(['table', 'ranking', 'chart', 'executive_brief', 'csv_export']);
export const artifactPlanSchema = z.object({
  version: z.literal(1), artifactTypeId: artifactKindSchema, operation: z.enum(['create', 'revise']),
  title: z.string().trim().min(1).max(140), baseRevision: refSchema.nullable(),
  queryPlan: refSchema, responsePlan: refSchema, evidence: refSchema, claimGraph: refSchema,
  outputFormat: z.enum(['preview', 'csv']),
}).strict();
export type ArtifactPlan = z.infer<typeof artifactPlanSchema>;

const ids = (max: number) => z.array(idSchema).min(1).max(max).refine(v => new Set(v).size === v.length);
const text = z.string().max(1000);
const instant = z.string().datetime({ offset: true });
export const claimSchema = z.object({
  id: idSchema, kind: z.literal('fact'), measure: idSchema, value: z.number().finite().nullable(), unit: z.string().min(1).max(100),
  dimensions: z.record(idSchema, z.string().max(200)), rowRefs: ids(ARTIFACT_LIMITS.rows), sourceRefs: ids(ARTIFACT_LIMITS.sources),
  computation: z.object({ calculatorId: idSchema, operation: z.enum(['value', 'sum', 'avg', 'latest', 'max', 'gap', 'weighted_ratio', 'difference', 'rank']),
    inputs: z.array(idSchema).max(16) }).strict(), caveat: text.optional(),
}).strict();
const bundleSchema = z.object({
  version: z.literal(1), ref: refSchema, query: refSchema, dataset: refSchema, authorityDigest: refSchema.shape.digest,
  scope: z.object({ regions: ids(2000), branchIds: ids(2000), source: z.enum(['explicit', 'default']).optional() }).strict(), grain: ids(8),
  rows: z.array(z.object({ rowId: idSchema, branchId: idSchema, region: idSchema, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    values: z.record(idSchema, z.union([z.string().max(200), z.number().finite(), z.null()])), sourceRefs: ids(16) }).strict()).max(ARTIFACT_LIMITS.rows),
  sources: z.array(z.object({ id: idSchema, system: idSchema, observedAt: instant, retrievedAt: instant,
    freshness: z.enum(['fresh', 'stale', 'missing', 'misaligned']) }).strict()).max(ARTIFACT_LIMITS.sources),
  provenance: z.object({ sourceNames: ids(16), dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1).max(62), readAt: instant }).strict(),
  coverage: z.object({ expected: z.number().int().nonnegative(), read: z.number().int().nonnegative(), complete: z.boolean(),
    omittedReasons: z.array(text).max(ARTIFACT_LIMITS.rows) }).strict(),
  limitations: z.array(text).max(ARTIFACT_LIMITS.rows), interpretationLabels: z.array(text).max(100),
}).strict();
const graphSchema = z.object({
  version: z.literal(1), evidence: refSchema, claims: z.array(claimSchema).min(1).max(ARTIFACT_LIMITS.claims),
  edges: z.array(z.object({ from: idSchema, to: idSchema, relation: z.literal('derived_from') }).strict()).max(100_000),
  populationRowRefs: ids(ARTIFACT_LIMITS.rows), limitations: z.array(text).max(ARTIFACT_LIMITS.rows), digest: refSchema.shape.digest,
}).strict();
export const responsePlanSchema = z.object({
  version: z.literal(1), claimGraph: refSchema,
  sections: z.array(z.object({ kind: z.enum(['answer', 'table', 'chart', 'caveat', 'clarification']), claimIds: ids(ARTIFACT_LIMITS.claims),
    order: z.number().int().nonnegative() }).strict()).min(1).max(8),
  wordingStyle: z.enum(['concise', 'explanatory']), interpretationLabels: z.array(text).max(100),
  citations: z.array(z.object({ claimId: idSchema, sourceRefs: ids(ARTIFACT_LIMITS.sources) }).strict()).max(ARTIFACT_LIMITS.claims),
  locale: z.literal('en'),
}).strict();
export type ArtifactResponse = { ref: z.infer<typeof refSchema>; plan: z.infer<typeof responsePlanSchema> };
export const artifactVersionSchema = z.object({
  version: z.literal(1), artifactId: idSchema, revision: z.number().int().positive().max(ARTIFACT_LIMITS.versions), ownerId: idSchema,
  ref: refSchema, plan: artifactPlanSchema, query: queryPlanSchema, response: z.object({ ref: refSchema, plan: responsePlanSchema }).strict(),
  bundle: bundleSchema, graph: graphSchema, readPermissions: ids(32), authority: refSchema, catalogSnapshot: refSchema, createdAt: instant,
}).strict();
export type ArtifactVersion = z.infer<typeof artifactVersionSchema>;
export type LatestArtifact = { kind: 'absent' } | { kind: 'version'; artifact: ArtifactVersion };
export interface ArtifactPreview { ref: z.infer<typeof refSchema>; artifact: ArtifactVersion; expiresAt: string }
export type ArtifactAuthority = ActorAuthority & { catalogDigest: string };

/** Implementations must be transaction-scoped, append-only and authorization-aware. */
export interface ArtifactStore {
  latest(artifactId: string): Promise<ArtifactVersion | null>;
  read(ref: z.infer<typeof refSchema>): Promise<ArtifactVersion | null>;
  append(record: ArtifactVersion, expectedLatest: z.infer<typeof refSchema> | null): Promise<'written' | 'conflict'>;
}
