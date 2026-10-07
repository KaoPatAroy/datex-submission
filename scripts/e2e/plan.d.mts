export interface Options {
  mode: 'full' | 'group' | 'spec' | 'changed'; list: boolean; shards: number;
  flagProfile: 'on' | 'off' | 'shadow'; specs: string[]; group?: string; ref?: string;
}
export interface Shard {
  id: string; specs: string[]; estimatedSeconds: number; port: number; dbPath: string;
  outputDir: string; traceDir: string; reportDir: string; logDir: string;
  jsonPath: string; serverStatePath: string;
}
export interface Impact { path: string; rule: string; groups: string[]; full: boolean; specs: string[] }
export interface Plan {
  authority: 'release-authoritative' | 'focused'; flagProfile: string; selected: string[];
  skipped: { path: string; reason: string }[]; impacts: Impact[]; warnings: string[]; shards: Shard[];
}
export function parseArgs(args: string[]): Options;
export function matchImpact(path: string, inventory: string[]): Impact;
export function createPlan(options: Options, inventory: string[], context?: {
  changedPaths?: string[]; root?: string; tempRoot?: string; runId?: string; basePort?: number;
}): Plan;
export function formatPlan(plan: Plan): string;
export function playwrightInvocation(cli: string, shard: Shard): string[];
