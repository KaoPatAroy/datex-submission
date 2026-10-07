import type { ArtifactFact } from '../visualization/contracts';
import { factsToCSV } from '../visualization/presentation';
import type { ArtifactVersion } from './contracts';

/**
 * CSV of a runtime-trusted artifact version: one row per verified claim (id, dimensions, measure, value, unit, operation,
 * row/source refs, caveat). Text cells are formula-neutralized by `csvCell`. Values come only from the stored ClaimGraph.
 */
export function artifactCsv(artifact: ArtifactVersion): string {
  const facts: ArtifactFact[] = artifact.graph.claims.map(claim => ({ claimId: claim.id, measure: claim.measure, value: claim.value,
    unit: claim.unit, dimensions: { ...claim.dimensions }, rowRefs: [...claim.rowRefs], sourceRefs: [...claim.sourceRefs],
    operation: claim.computation.operation, ...(claim.caveat ? { caveat: claim.caveat } : {}) }));
  return factsToCSV(facts);
}

/** Safe attachment filename: ASCII id characters only. */
export function artifactCsvFilename(artifact: Pick<ArtifactVersion, 'artifactId' | 'revision'>): string {
  return `${artifact.artifactId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)}-r${artifact.revision}.csv`;
}
