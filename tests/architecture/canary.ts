import { randomUUID } from 'node:crypto';
import { PERMANENT_ALLOWED_FUNCTIONS } from './user-text-scan';

/**
 * Runtime taint canary. A unique token is embedded in the user message; while installed, every String/RegExp method that
 * can interpret text records a hit (with stack) whenever its subject contains the token. A hit is a violation when a
 * guarded lib/** frame is on the stack and no frame is inside an allowlisted function (the evidence-span resolver etc.).
 */
export const newCanary = () => `⁣cnry-${randomUUID()}`;

const STRING_METHODS = [
  'match', 'matchAll', 'replace', 'replaceAll', 'search', 'split', 'includes', 'indexOf', 'lastIndexOf', 'startsWith', 'endsWith',
  'normalize', 'toLowerCase', 'toLocaleLowerCase', 'toUpperCase', 'toLocaleUpperCase', 'localeCompare',
] as const;
const REGEXP_METHODS = ['test', 'exec'] as const;

export interface CanaryHit { method: string; stack: string }
export interface Frame { fn: string | null; file: string; line: number }

const FRAME = /^\s*at (?:async )?(?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/u;
const GUARDED = /[\\/]lib[\\/](?:core|packs|dynamic|server|router|demo)[\\/]/u;

export function parseFrames(stack: string): Frame[] {
  return stack.split('\n').flatMap(line => {
    const m = FRAME.exec(line);
    return m ? [{ fn: m[1] ? (m[1].split('.').pop() ?? null) : null, file: m[2], line: Number(m[3]) }] : [];
  });
}

export function installCanary(canary: string): { hits: CanaryHit[]; restore(): void } {
  const hits: CanaryHit[] = [];
  const originalIncludes = String.prototype.includes;
  const restorers: Array<() => void> = [];
  const contains = (subject: unknown) => typeof subject === 'string' && originalIncludes.call(subject, canary);
  const patch = (proto: object, name: string, subjectOf: (self: unknown, args: unknown[]) => unknown) => {
    const original = (proto as Record<string, unknown>)[name] as (...a: unknown[]) => unknown;
    (proto as Record<string, unknown>)[name] = function patched(this: unknown, ...args: unknown[]) {
      if (contains(subjectOf(this, args))) hits.push({ method: name, stack: new Error().stack ?? '' });
      return original.apply(this, args);
    };
    restorers.push(() => { (proto as Record<string, unknown>)[name] = original; });
  };
  for (const name of STRING_METHODS) patch(String.prototype, name, self => typeof self === 'string' ? self : String(self));
  for (const name of REGEXP_METHODS) patch(RegExp.prototype, name, (_self, args) => args[0]);
  return { hits, restore: () => restorers.reverse().forEach(r => r()) };
}

/** Hits with a guarded lib frame and no allowlisted function anywhere on the stack. */
export function canaryViolations(hits: readonly CanaryHit[], allowed: ReadonlySet<string> = PERMANENT_ALLOWED_FUNCTIONS): CanaryHit[] {
  return hits.filter(hit => {
    const frames = parseFrames(hit.stack);
    const lib = frames.filter(f => GUARDED.test(f.file));
    return lib.length > 0 && !frames.some(f => f.fn !== null && allowed.has(f.fn));
  });
}

export function withCanary<T>(canary: string, run: () => T): { result: T; hits: CanaryHit[] } {
  const probe = installCanary(canary);
  try { return { result: run(), hits: probe.hits }; } finally { probe.restore(); }
}
