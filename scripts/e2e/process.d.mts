import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { ChildResult } from './aggregate.mjs';
export function isAlive(pid: number): boolean;
export function killTree(pid?: number): Promise<{ ok: boolean; status: string }>;
export function runProcess(args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; logPath: string; signal?: AbortSignal; timeoutMs?: number;
  spawnChild?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
}): Promise<ChildResult & { pid?: number }>;
