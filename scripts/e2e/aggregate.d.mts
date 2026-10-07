import type { Plan, Shard } from './plan.mjs';
export interface ChildResult {
  code?: number | null; signal?: string | null; error?: string; terminationSignal?: string;
  timedOut?: boolean; startupOk?: boolean; durationMs?: number; cleanup?: { ok: boolean; status?: string };
}
export interface Counts { tests: number; passed: number; failed: number; flaky: number; skipped: number; interrupted: number; timedOut: number }
export interface ShardResult {
  id: string; ok: boolean; code: number | null; signal: string | null; durationMs: number;
  counts: Counts; failures: { title: string; traces: string[] }[]; problems: string[];
  cleanup: { ok: boolean; status?: string }; jsonPath: string;
}
export interface RunResult extends Counts {
  ok: boolean; exitCode: number; authority: string; flagProfile: string; specs: number; shards: ShardResult[];
}
export function aggregateShard(shard: Shard, child: ChildResult, json?: string): ShardResult;
export function aggregateRun(plan: Plan, results: ShardResult[]): RunResult;
export function executeShards(plan: Plan, dependencies: {
  runChild: (shard: Shard) => Promise<ChildResult>;
  readResult: (shard: Shard) => string | undefined | Promise<string | undefined>;
}): Promise<RunResult>;
