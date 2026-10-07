import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { ArtifactChart } from '@/components/biztania/artifact-chart';
import { EMPTY_CHART_STATE, type ChartState } from '@/components/biztania/artifact-families';
import type { SafeVisualizationSpec } from '@/lib/visualization/contracts';
import styles from '@/components/biztania/artifact-preview.module.css';

// Match the existing static-render setup under Vitest's react-server condition.
vi.mock('react', async () => createRequire(import.meta.url)(`${process.cwd()}/node_modules/react/index.js`));
const require = createRequire(import.meta.url);
const Module = require('node:module').Module;
const entries: { path: string; previous?: NodeJS.Module }[] = [];
for (const name of ['react', 'react-dom']) {
  const path = require.resolve(name), previous = require.cache[path], entry = previous ?? new Module(path);
  entry.filename = path; entry.loaded = true;
  entry.exports = require(`${process.cwd()}/node_modules/${name}/index.js`);
  require.cache[path] = entry; entries.push({ path, previous });
}
afterAll(() => { for (const { path, previous } of entries) { if (previous) require.cache[path] = previous; else delete require.cache[path]; } });
const { renderToStaticMarkup } = require(`${process.cwd()}/node_modules/react-dom/server.node.js`) as typeof import('react-dom/server');

function fixture(count = 8): SafeVisualizationSpec {
  return {
    version: 1, primitive: 'bar', xField: 'branch', yFields: ['sales'], domain: ['east'],
    points: Array.from({ length: count }, (_, index) => ({ claimId: `claim-${index}`, category: 'east', series: `measure-${index}`, seriesLabel: `Measure ${index}`, value: index + 1, unit: 'THB' })),
    interaction: { version: 1, interactionIds: ['inspect_data', 'legend_toggle', 'select_point', 'tooltip'], selectionFields: ['branch'] },
    animation: { version: 1, modeId: 'none', durationMs: 0, reducedMotion: 'respect' },
  };
}

const render = (spec: SafeVisualizationSpec, state: ChartState = EMPTY_CHART_STATE) => renderToStaticMarkup(createElement(ArtifactChart, { spec, state }));
const marks = (html: string, category: string) => [...html.matchAll(new RegExp(`<g\\b[^>]*data-mark="${category}"[^>]*>.*?</g>`, 'g'))].map(match => match[0]);
function timeFixture(primitive: 'line' | 'area' | 'combo', count = 2): SafeVisualizationSpec {
  const spec = fixture(count), domain = ['2026-09-29', '2026-09-30'];
  return { ...spec, primitive, xField: 'date', domain,
    points: spec.points.flatMap(point => domain.map(category => ({ ...point, category, claimId: `${point.claimId}-${category}` }))),
    ...(primitive === 'combo' ? { lineSeries: ['measure-0'], axisUnits: ['THB'] } : {}),
  };
}
function markerFixture(primitive: 'line' | 'area' | 'combo'): SafeVisualizationSpec {
  const spec = timeFixture(primitive, 8);
  return { ...spec, interaction: { ...spec.interaction, interactionIds: [...spec.interaction.interactionIds, 'zoom_brush'] },
    ...(primitive === 'combo' ? { lineSeries: [...new Set(spec.points.map(point => point.series))].filter(series => series !== 'measure-0') } : {}),
  };
}
/** Compare the actual SVG silhouette, ignoring colour and placement. */
function markerShape(html: string) {
  const marker = html.match(new RegExp(`<(circle|path)\\b(?=[^>]*class="${styles.point}")[^>]*>`));
  expect(marker).not.toBeNull();
  return `${marker![1]}:${marker![0].match(/\b(?:d|r)="([^"]+)"/)?.[1]}`;
}
function legendShape(html: string, index: number) {
  const swatch = html.match(new RegExp(`data-legend-series="${index}"[^>]*>(<svg\\b.*?</svg>)`));
  expect(swatch).not.toBeNull();
  return markerShape(swatch![1]);
}
const pointMarks = (html: string, category: string) => marks(html, category).filter(mark => mark.includes(`class="${styles.point}"`));
function partFixture(primitive: 'pie' | 'donut' | 'treemap'): SafeVisualizationSpec {
  const spec = fixture(1), domain = ['small', 'large', 'middle'];
  return { ...spec, primitive, domain, points: domain.map((category, index) => ({ ...spec.points[0], category, claimId: `part-${index}`, value: [1, 9, 3][index] })) };
}
const globals = readFileSync(new URL('../../app/globals.css', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../components/biztania/artifact-preview.module.css', import.meta.url), 'utf8');
function declaration(selector: string, property: string) {
  const rule = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(match => match[1].split(',').map(part => part.trim()).includes(selector));
  return rule?.[2].match(new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`))?.[1].trim();
}
const token = (name: string) => globals.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1].trim();
function luminance(hex: string) {
  const channels = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}

describe('categorical chart palette', () => {
  it('renders all eight series colours with their existing distinct patterns', () => {
    const html = renderToStaticMarkup(createElement(ArtifactChart, { spec: fixture() }));
    const patterns = [...html.matchAll(/<pattern\b[^>]*>.*?<\/pattern>/g)].map(match => match[0]);
    expect(patterns).toHaveLength(8);
    const paths = ['', 'M0 12L12 0', 'M0 3H12M0 9H12', 'M3 0V12M9 0V12', 'M0 0L12 12', 'M0 6H12M6 0V12', 'M0 0L12 12M0 12L12 0', 'M0 0H12V12H0Z'];
    patterns.forEach((pattern, index) => {
      expect(pattern).toContain(`var(--series-${index + 1})`);
      if (index) expect(pattern).toContain(`d="${paths[index]}"`);
      else expect(pattern).not.toContain('<path');
      expect(html).toContain(`-series-${index})`);
    });
  });

  it('keeps the second series and its legend on orange when the first series is hidden', () => {
    const html = render(fixture(2), { ...EMPTY_CHART_STATE, hidden: ['measure-0'] });
    expect(marks(html, 'east')).toHaveLength(1);
    expect(marks(html, 'east')[0]).toMatch(/fill="url\(#[^"]+-series-1\)"/);
    expect(html).toMatch(/<pattern\b[^>]*id="[^"]+-series-1"[^>]*style="[^"]*var\(--series-2\)/);
    expect(html).toMatch(/<svg\b[^>]*style="[^"]*var\(--series-2\)/);
  });

  it.each(['line', 'area', 'combo'] as const)('%s lines, points and legends use canonical colours and dashes', primitive => {
    const html = render(timeFixture(primitive));
    const lines = [...html.matchAll(/<line\b[^>]*stroke-dasharray="[^"]*"[^>]*>/g)].map(match => match[0]);
    if (primitive !== 'combo') {
      expect(lines[0]).toContain('var(--series-1)');
      expect(lines[1]).toContain('var(--series-2)');
      expect(lines[1]).toContain('stroke-dasharray="8 3"');
      expect(marks(html, '2026-09-29')[1]).toContain('var(--series-2)');
    } else {
      // The first canonical series is a line; bar-first geometry must not change its slot.
      expect(lines[0]).toContain('var(--series-1)');
      expect(lines[0]).toContain('stroke-dasharray="none"');
      expect(marks(html, '2026-09-29')[0]).toMatch(/fill="url\(#[^"]+-series-1\)"/);
    }
    expect(html).toMatch(/<svg\b[^>]*style="[^"]*var\(--series-2\)/);
    if (primitive === 'area') expect(html).toMatch(/<path\b[^>]*class="[^"]*areaFill[^>]*style="[^"]*var\(--series-2\)/);
  });

  it.each(['line', 'area', 'combo'] as const)('%s keeps distinct marker silhouettes matching the legends when brushed to one date', primitive => {
    const spec = markerFixture(primitive), html = render(spec, { ...EMPTY_CHART_STATE, range: [1, 1] });
    const drawn = pointMarks(html, '2026-09-30');
    const indices = primitive === 'combo' ? [1, 2, 3, 4, 5, 6, 7] : [0, 1, 2, 3, 4, 5, 6, 7];
    expect(drawn).toHaveLength(indices.length);
    // Inspect only the plot: the legend still has its sample lines after brushing.
    const plot = html.slice(0, html.indexOf('<ul'));
    expect(plot).not.toContain('stroke-dasharray=');
    expect(new Set(drawn.map(markerShape)).size).toBe(indices.length);
    drawn.forEach((mark, position) => expect(markerShape(mark)).toBe(legendShape(html, indices[position])));
  });

  it.each((['line', 'area', 'combo'] as const).flatMap(primitive => (['omitted', 'null'] as const).map(gap => ({ primitive, gap }))))
    ('$primitive keeps the same distinct markers and legend across an $gap date gap', ({ primitive, gap }) => {
      const base = markerFixture(primitive), domain = ['2026-09-28', '2026-09-29', '2026-09-30'];
      const spec = { ...base, domain, points: base.points.filter(point => point.category === base.domain[0]).flatMap(point => domain.flatMap((category, index) =>
        index === 1 && gap === 'omitted' ? [] : [{ ...point, category, claimId: `${point.series}-${category}`, value: index === 1 ? null : point.value }])) };
      const html = render(spec), plot = html.slice(0, html.indexOf('<ul'));
      expect(plot).not.toContain('stroke-dasharray=');
      expect(plot).not.toContain(`class="${styles.areaFill}"`);
      expect(pointMarks(html, domain[1])).toHaveLength(0);
      const expected = pointMarks(render(base), base.domain[0]).map(markerShape);
      expect(new Set(expected).size).toBe(primitive === 'combo' ? 7 : 8);
      for (const category of [domain[0], domain[2]]) {
        const drawn = pointMarks(html, category);
        expect(drawn.map(markerShape)).toEqual(expected);
        drawn.forEach((mark, position) => expect(markerShape(mark)).toBe(legendShape(html, position + (primitive === 'combo' ? 1 : 0))));
      }
    });

  it.each(['line', 'area', 'combo'] as const)('%s preserves marker identity after hiding the first line series and brushing', primitive => {
    const spec = markerFixture(primitive), firstLine = primitive === 'combo' ? 1 : 0;
    const before = pointMarks(render(spec), '2026-09-30').map(markerShape);
    const html = render(spec, { ...EMPTY_CHART_STATE, range: [1, 1], hidden: [`measure-${firstLine}`] });
    const after = pointMarks(html, '2026-09-30');
    expect(after.map(markerShape)).toEqual(before.slice(1));
    after.forEach((mark, position) => expect(markerShape(mark)).toBe(legendShape(html, position + firstLine + 1)));
  });

  it.each(['pie', 'donut', 'treemap'] as const)('%s colour follows category identity rather than value rank', primitive => {
    const spec = partFixture(primitive), html = render(spec, { ...EMPTY_CHART_STATE, sorted: true });
    expect(marks(html, 'large')[0]).toMatch(/fill="url\(#[^"]+-series-1\)"/);
    expect(marks(html, 'small')[0]).toMatch(/fill="url\(#[^"]+-series-0\)"/);
    if (primitive !== 'treemap') {
      const legend = html.slice(html.indexOf('<ul'));
      expect(legend).toMatch(/fill="url\(#[^"]+-series-1\)"[^>]*>.*?<\/svg>large/);
    }
  });

  it.each(['pie', 'donut', 'treemap'] as const)('%s keeps the category colour and pattern defined after filtering', primitive => {
    const html = render(partFixture(primitive), { ...EMPTY_CHART_STATE, range: [1, 1] });
    expect(marks(html, 'large')).toHaveLength(1);
    expect(marks(html, 'large')[0]).toMatch(/fill="url\(#[^"]+-series-1\)"/);
    expect(html).toMatch(/<pattern\b[^>]*id="[^"]+-series-1"[^>]*style="[^"]*var\(--series-2\)/);
  });

  it.each(['bar', 'line', 'area'] as const)('a single %s series stays series-1 blue', primitive => {
    const html = render(primitive === 'bar' ? fixture(1) : timeFixture(primitive, 1));
    expect(html).toContain('var(--series-1)');
    expect(html).not.toContain('var(--series-2)');
    expect(token('series-1')).toBe('#2855d9');
  });

  it('wraps bar colours and patterns together beyond eight series', () => {
    const html = render(fixture(10)), drawn = marks(html, 'east');
    expect(drawn).toHaveLength(10);
    expect([...html.matchAll(/<pattern\b/g)]).toHaveLength(8);
    expect(drawn[8]).toContain('var(--series-1)');
    expect(drawn[8]).toMatch(/fill="url\(#[^"]+-series-0\)"/);
    expect(drawn[9]).toContain('var(--series-2)');
    expect(drawn[9]).toMatch(/fill="url\(#[^"]+-series-1\)"/);
    expect(html).not.toContain('var(--series-9)');
  });

  it('wraps line colours, dashes and marker shapes together beyond eight series', () => {
    const html = render(timeFixture('line', 10));
    const lines = [...html.matchAll(/<line\b[^>]*stroke-dasharray="[^"]*"[^>]*>/g)].map(match => match[0]);
    expect(lines[8]).toContain('var(--series-1)');
    expect(lines[8]).toContain('stroke-dasharray="none"');
    expect(lines[9]).toContain('var(--series-2)');
    expect(lines[9]).toContain('stroke-dasharray="8 3"');
    const drawn = pointMarks(html, '2026-09-29');
    expect(markerShape(drawn[8])).toBe(markerShape(drawn[0]));
    expect(markerShape(drawn[9])).toBe(markerShape(drawn[1]));
    expect(legendShape(html, 8)).toBe(markerShape(drawn[0]));
    expect(legendShape(html, 9)).toBe(markerShape(drawn[1]));
  });

  it('keeps the remaining series orange when brushing away the first series', () => {
    const spec = timeFixture('line');
    spec.points = [spec.points[0], spec.points[3]];
    const html = render(spec, { ...EMPTY_CHART_STATE, range: [1, 1] });
    expect(marks(html, '2026-09-30')[0]).toContain('var(--series-2)');
    expect(markerShape(marks(html, '2026-09-30')[0])).toBe(legendShape(html, 1));
    expect(html).toMatch(/<pattern\b[^>]*id="[^"]+-series-1"/);
  });

  it('selection dims other categories without repainting them', () => {
    const spec = partFixture('pie');
    const before = marks(render(spec), 'large')[0];
    const after = marks(render(spec, { ...EMPTY_CHART_STATE, selected: 'small' }), 'large')[0];
    expect(after).toContain(styles.dim);
    expect(after.match(/fill="[^"]*"/)?.[0]).toBe(before.match(/fill="[^"]*"/)?.[0]);
    expect(declaration('.dim', 'opacity')).toBe('.3');
  });

  it('uses the approved tokens without a green hue and gives pattern strokes at least 3:1 contrast', () => {
    const colours = ['#2855d9', '#e07a2e', '#7b4fd0', '#0e8fb3', '#c4527a', '#b58300', '#142c60', '#6b7a99'];
    expect(colours.map((_, index) => token(`series-${index + 1}`))).toEqual(colours);
    const patterns = [...render(fixture()).matchAll(/<pattern\b[^>]*>.*?<\/pattern>/g)].map(match => match[0]);
    expect(declaration('.patternBackground', 'fill')).toContain('var(--chart-series');
    expect(declaration('.patternInk', 'fill')).toContain('var(--chart-series');
    expect(declaration('.patternStroke', 'stroke')).toBe('var(--series-pattern)');
    colours.forEach((colour, index) => {
      const contrastToken = patterns[index].match(/--series-pattern:var\(--(\w+)\)/)?.[1];
      const overlay = token(contrastToken ?? '');
      expect(overlay).toBeDefined();
      const a = luminance(colour), b = luminance(overlay!);
      expect((Math.max(a, b) + .05) / (Math.min(a, b) + .05)).toBeGreaterThanOrEqual(3);
      const [r, g, bChannel] = [1, 3, 5].map(offset => parseInt(colour.slice(offset, offset + 2), 16) / 255);
      const max = Math.max(r, g, bChannel), min = Math.min(r, g, bChannel), delta = max - min;
      const rawHue = max === r ? 60 * (((g - bChannel) / delta) % 6) : max === g ? 60 * ((bChannel - r) / delta + 2) : 60 * ((r - g) / delta + 4);
      const hue = (rawHue + 360) % 360, saturation = delta / (1 - Math.abs(max + min - 1));
      expect(hue >= 90 && hue <= 170 && saturation > .2).toBe(false);
    });
  });

  it('keeps chart text on ink or muted tokens rather than categorical colours', () => {
    for (const selector of ['.label', '.sliceText', '.tileText']) expect(declaration(selector, 'fill')).toMatch(/^var\(--(?:ink|muted)\)$/);
    for (const selector of ['.legend li', '.legendButton', '.chartStatus', '.sliceList li']) expect(declaration(selector, 'color')).toMatch(/^var\(--(?:ink|muted)\)$/);
  });

  it('scatter shows one blue point population without a misleading measure-series legend', () => {
    const domain = ['small', 'large', 'middle'], spec = fixture(2);
    const scatter: SafeVisualizationSpec = { ...spec, primitive: 'scatter', yFields: ['sales', 'target'], domain,
      points: spec.points.flatMap(point => domain.map(category => ({ ...point, category, claimId: `${point.claimId}-${category}` }))),
      pairs: domain.map((category, index) => ({ category, xClaimId: `claim-0-${category}`, yClaimId: `claim-1-${category}`, x: index + 1, y: index + 2, xUnit: 'THB', yUnit: 'THB' })),
    };
    const html = render(scatter);
    expect(html).not.toContain('aria-label="Chart series"');
    expect([...html.matchAll(new RegExp(`<circle\\b[^>]*class="${styles.point}"`, 'g'))]).toHaveLength(3);
    expect(declaration('.point', 'fill')).toContain('var(--series-1)');
    expect(html).toContain('>sales</text>');
    expect(html).toContain('>target</text>');
  });
});
