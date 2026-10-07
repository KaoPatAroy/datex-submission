import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MODEL_TEXT_REGISTRY, MODEL_TEXT_SURFACES, type ModelTextSurface } from '@/lib/router/render/safety';

/**
 * G6 structural guard: every MODEL-authored user-visible string passes the ONE model-text gate (modelTextSafe). The registry
 * (MODEL_TEXT_REGISTRY) names each surface and the files that gate it; this test fails when an executor, renderer or builder reads a raw
 * model-text plan field without gating it there (directly, or through a registered gate wrapper).
 */
const ROOT = process.cwd();
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');
const tsFiles = (dir: string) => readdirSync(join(ROOT, dir)).filter(name => name.endsWith('.ts')).map(name => `${dir}/${name}`);

/** Files that read planner output and produce user-visible text. */
const SCANNED = [
  ...tsFiles('lib/router/executors'), ...tsFiles('lib/router/render'),
  'lib/core/router-turn.ts', 'lib/router/validate.ts', 'lib/visualization/dashboard-spec.ts', 'lib/visualization/dashboard-table.ts',
];

/** Raw model-text plan fields (planner output before any gate) and the surface each belongs to. */
const RAW_READS: ReadonlyArray<{ surface: ModelTextSurface; pattern: RegExp }> = [
  { surface: 'conversation', pattern: /\bstep\.prose\b/u },
  { surface: 'clarify', pattern: /\bstep\.question\b/u },
  { surface: 'clarify', pattern: /\.ask\?\.\(/u },
  { surface: 'follow_up', pattern: /\bplan\.followUps\b/u },
  { surface: 'title', pattern: /\.suggestedConversationTitle\b/u },
  { surface: 'dashboard_title', pattern: /(?<![\w.])(?:plan|modelPlan)\.title\b|\bvisualization\.title\b/u },
  { surface: 'visualization_text', pattern: /(?<![\w.])(?:plan|modelPlan)\.(?:description|widgets)\b|\bvisualization\.(?:description|widgets)\b/u },
  { surface: 'lookup_query', pattern: /\bstep\.query\b|\{[^}]*\bquery\b[^}]*\}\s*=\s*input\.step\b/u },
];

/** Functions that run modelTextSafe on the model text they are given, and the surfaces they gate. */
const WRAPPERS: Readonly<Record<string, { file: string; surfaces: readonly ModelTextSurface[] }>> = {
  isSafeFollowUp: { file: 'lib/router/render/safety.ts', surfaces: ['follow_up'] },
  isSafeConversationTitle: { file: 'lib/router/render/safety.ts', surfaces: ['title'] },
  isSafeClarificationText: { file: 'lib/router/render/safety.ts', surfaces: ['clarify'] },
  isSafeQuestion: { file: 'lib/router/executors/shared.ts', surfaces: ['clarify'] },
  renderClarify: { file: 'lib/router/render/respond.ts', surfaces: ['clarify'] },
  renderConversation: { file: 'lib/router/render/respond.ts', surfaces: ['conversation', 'product_help'] },
  gateVisualizationText: { file: 'lib/visualization/dashboard-spec.ts', surfaces: ['dashboard_title', 'visualization_text'] },
  executeResourceLookupStep: { file: 'lib/router/executors/resource-lookup.ts', surfaces: ['lookup_query'] },
};

/** Reads that never reach the user, each with its reason. Keep this list short. */
const EXEMPT: ReadonlyArray<{ file: string; surface: ModelTextSurface; reason: string }> = [
  { file: 'lib/router/validate.ts', surface: 'visualization_text', reason: 'control-character / hook validation only; display text is gated by gateVisualizationText in the builders' },
  { file: 'lib/router/validate.ts', surface: 'lookup_query', reason: 'control-character check only; the echo is gated in executeResourceLookupStep' },
];

function functionBody(source: string, name: string): string | undefined {
  const start = source.search(new RegExp(String.raw`(?:^|\n)(?:export\s+)?(?:async\s+)?function\s+${name}\b`, 'u'));
  if (start < 0) return undefined;
  const rest = source.slice(start + 1);
  const end = rest.search(/\n(?:export\s|function\s|const\s|\/\*\*)/u);
  return end < 0 ? rest : rest.slice(0, end);
}

/** The file runs modelTextSafe and names the surface (a literal argument, or a surface selector such as validate's surfaceOf). */
const gatesDirectly = (source: string, surface: ModelTextSurface) => /\bmodelTextSafe\(/u.test(source) && source.includes(`'${surface}'`);
const callsWrapperFor = (source: string, surface: ModelTextSurface) =>
  Object.entries(WRAPPERS).some(([name, wrapper]) => wrapper.surfaces.includes(surface) && new RegExp(String.raw`\b${name}\(`, 'u').test(source));

/** Every raw model-text read in `source` that is not gated in that file. Exported shape so the self-test can feed a synthetic violation. */
function ungatedReads(file: string, source: string): string[] {
  const out: string[] = [];
  for (const { surface, pattern } of RAW_READS) {
    if (!pattern.test(source)) continue;
    if (EXEMPT.some(e => e.file === file && e.surface === surface)) continue;
    const site = (MODEL_TEXT_REGISTRY[surface].gatedIn as readonly string[]).includes(file) && gatesDirectly(source, surface);
    if (!site && !callsWrapperFor(source, surface)) out.push(`${file}: reads ${surface} model text (${pattern.source}) without modelTextSafe('${surface}', ...) or a registered gate wrapper`);
  }
  return out;
}

describe('model-text surfaces (G6)', () => {
  it('every registered surface has gate sites that really call modelTextSafe for it', () => {
    expect(MODEL_TEXT_SURFACES.length).toBeGreaterThanOrEqual(10);
    for (const surface of MODEL_TEXT_SURFACES) {
      const spec = MODEL_TEXT_REGISTRY[surface];
      expect(spec.gatedIn.length, surface).toBeGreaterThan(0);
      for (const file of spec.gatedIn) expect(gatesDirectly(read(file), surface), `${file} must call modelTextSafe('${surface}', ...)`).toBe(true);
    }
  });

  it('every gate wrapper runs modelTextSafe (directly or through another wrapper)', () => {
    for (const [name, wrapper] of Object.entries(WRAPPERS)) {
      const body = functionBody(read(wrapper.file), name);
      expect(body, `${name} in ${wrapper.file}`).toBeDefined();
      const gated = /\bmodelTextSafe\(/u.test(body!) || Object.keys(WRAPPERS).some(other => other !== name && new RegExp(String.raw`\b${other}\(`, 'u').test(body!));
      expect(gated, `${name} must gate its model text`).toBe(true);
    }
  });

  it('no executor, renderer or builder reads raw model text outside a gate', () => {
    const violations = SCANNED.flatMap(file => ungatedReads(file, read(file)));
    expect(violations).toEqual([]);
  });

  it('generated free-text params are gated in validate before any executor reads them', () => {
    const generated = functionBody(read('lib/router/validate.ts'), 'ground');
    expect(generated).toMatch(/case 'generated':[\s\S]*modelTextSafe\(/u);
  });

  it('detects a synthetic ungated read (the guard is live)', () => {
    const file = 'lib/router/executors/synthetic.ts';
    expect(ungatedReads(file, 'export const leak = (step: { prose: string }) => ({ text: step.prose });')).toHaveLength(1);
    expect(ungatedReads(file, 'export const t = (plan: { title: string }) => plan.title;')).toHaveLength(1);
    expect(ungatedReads(file, 'export const ok = (step: { prose: string }) => renderConversation(step);')).toEqual([]);
  });
});
