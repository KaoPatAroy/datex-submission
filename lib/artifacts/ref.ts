/**
 * Server-issued reference to ONE exact Result version. The planner copies context ids verbatim; when the owner selected an older revision
 * (Results page, "share this version"), the context lists that Result as `<artifactId>:v<revision>`. Only the server builds these ids (from a
 * verified {artifactId, revision}); the validator accepts them only because they are in the context, and executors split them back here.
 * Anything that does not parse is treated as a plain artifact id (and is refused by the normal lookups if unknown).
 */
const PINNED = /^(.{1,90}):v([1-9]\d{0,2})$/;
export const pinnedArtifactRef = (artifactId: string, revision: number): string => `${artifactId}:v${revision}`;
export function parseArtifactRef(value: string): { artifactId: string; revision?: number } {
  const match = PINNED.exec(value);
  return match ? { artifactId: match[1], revision: Number(match[2]) } : { artifactId: value };
}
