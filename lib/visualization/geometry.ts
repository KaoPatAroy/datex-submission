import type { SafeVisualizationSpec } from './contracts';
import { chartGeometry } from './presentation';

// ---------------------------------------------------------------------------------------------------------------------
// Additional registered families. Pure numeric geometry only (browser-safe): the renderer turns these numbers into SVG with
// fixed templates, so no data value ever reaches markup, a path string, a style or an attribute name.
// ---------------------------------------------------------------------------------------------------------------------

export interface ChartView {
  /** Series hidden by the legend toggle. */
  hidden?: ReadonlySet<string>;
  /** Inclusive [from, to] indexes into `spec.domain` (zoom/brush). */
  range?: readonly [number, number] | null;
  /** Reorder mode: categories sorted by their plotted total (descending). */
  sorted?: boolean;
}
const finite = (n: number): number => (Number.isFinite(n) ? n : 0);
const fmt = (n: number): string => finite(n).toFixed(2);

/** The part of the spec a view shows: filtered series/range, optionally re-ordered. Facts and claims are never rewritten. */
export function applyChartView(spec: SafeVisualizationSpec, view: ChartView = {}): SafeVisualizationSpec {
  let domain = [...spec.domain];
  if (view.range) domain = domain.slice(Math.max(0, view.range[0]), Math.min(domain.length, view.range[1] + 1));
  const inDomain = new Set(domain);
  const points = spec.points.filter(p => inDomain.has(p.category) && !view.hidden?.has(p.series));
  if (view.sorted) {
    const total = (category: string) => points.filter(p => p.category === category).reduce((sum, p) => sum + (p.value ?? 0), 0);
    domain.sort((a, b) => total(b) - total(a) || a.localeCompare(b));
  }
  const pairs = spec.pairs?.filter(pair => inDomain.has(pair.category));
  return { ...spec, domain, points, ...(pairs ? { pairs } : {}) };
}

/** Value axis ticks: zero (when in range), and the extremes. */
export function valueTicks(values: readonly number[]): { value: number; ratio: number }[] {
  const numeric = values.filter(Number.isFinite);
  const min = Math.min(0, ...numeric), max = Math.max(0, ...numeric);
  const range = max - min || 1;
  const set = [...new Set([min, 0, max])].filter(v => v >= min && v <= max);
  return set.sort((a, b) => a - b).map(value => ({ value, ratio: (value - min) / range }));
}
function scaleOf(values: readonly number[], top: number, bottom: number) {
  const numeric = values.filter(Number.isFinite);
  const min = Math.min(0, ...numeric), max = Math.max(0, ...numeric), range = max - min || 1;
  const y = (value: number) => bottom - ((value - min) / range) * (bottom - top);
  return { y, baseline: y(0), min, max };
}

/** Area: a filled run per series between consecutive observed dates; isolated observations stay as points (never interpolated across gaps). */
export function areaGeometry(spec: SafeVisualizationSpec) {
  const base = chartGeometry(spec);
  const series = [...new Set(spec.points.map(p => p.series))];
  const runs = series.flatMap(seriesId => {
    const points = base.bars.filter(p => p.series === seriesId && p.y !== null);
    const groups: (typeof points)[] = [];
    for (const point of points) {
      const prior = groups.at(-1)?.at(-1);
      if (prior && point.domainIndex === prior.domainIndex + 1 && Date.parse(point.category) - Date.parse(prior.category) === 86_400_000) groups.at(-1)!.push(point);
      else groups.push([point]);
    }
    return groups.filter(group => group.length > 1).map(group => ({ series: seriesId,
      path: `M${fmt(group[0].centerX)} ${fmt(base.baseline)}${group.map(p => ` L${fmt(p.centerX)} ${fmt(p.y!)}`).join('')} L${fmt(group.at(-1)!.centerX)} ${fmt(base.baseline)} Z`,
      points: group }));
  });
  return { ...base, runs };
}

/** Combo: bars + lines over one category/date axis, one value axis or two when the units differ. */
export function comboGeometry(spec: SafeVisualizationSpec) {
  const lineSet = new Set(spec.lineSeries ?? []);
  const barPoints = spec.points.filter(p => !lineSet.has(p.series)), linePoints = spec.points.filter(p => lineSet.has(p.series));
  const numbers = (points: typeof barPoints) => points.flatMap(p => p.value === null ? [] : [p.value]);
  const left = scaleOf(numbers(barPoints), 20, 180);
  const dual = (spec.axisUnits?.length ?? 1) === 2;
  const right = dual ? scaleOf(numbers(linePoints), 20, 180) : scaleOf([...numbers(barPoints), ...numbers(linePoints)], 20, 180);
  const leftScale = dual ? left : right;
  const categories = [...spec.domain];
  const barSeries = [...new Set(barPoints.map(p => p.series))], lineSeries = [...new Set(linePoints.map(p => p.series))];
  const width = Math.max(640, categories.length * Math.max(44, barSeries.length * 18));
  const slot = (width - 80) / Math.max(1, categories.length);
  const centerX = (category: string) => 40 + categories.indexOf(category) * slot + slot / 2;
  const bars = barPoints.map(point => ({ ...point, x: 40 + categories.indexOf(point.category) * slot + barSeries.indexOf(point.series) * slot / Math.max(1, barSeries.length) + slot * 0.08,
    y: point.value === null ? null : leftScale.y(point.value), width: Math.max(1, slot * 0.84 / Math.max(1, barSeries.length) - 2), centerX: centerX(point.category) }));
  const marks = linePoints.map(point => ({ ...point, centerX: centerX(point.category), y: point.value === null ? null : right.y(point.value), domainIndex: categories.indexOf(point.category) }));
  const timeAxis = spec.xField === 'date';
  const segments = lineSeries.flatMap(seriesId => {
    const pts = marks.filter(p => p.series === seriesId);
    return pts.flatMap((point, index) => {
      const prior = pts[index - 1];
      return timeAxis && prior && point.y !== null && prior.y !== null && point.domainIndex === prior.domainIndex + 1 &&
        Date.parse(point.category) - Date.parse(prior.category) === 86_400_000 ? [{ from: prior, to: point, series: seriesId }] : [];
    });
  });
  return { width, height: 220, baselineLeft: leftScale.y(0), baselineRight: right.y(0), bars, marks, segments, barSeries, lineSeries, dual,
    leftTicks: valueTicks(dual ? numbers(barPoints) : [...numbers(barPoints), ...numbers(linePoints)]).map(t => ({ ...t, y: leftScale.y(t.value) })),
    rightTicks: dual ? valueTicks(numbers(linePoints)).map(t => ({ ...t, y: right.y(t.value) })) : [],
    ticks: categories.map(category => ({ category, x: centerX(category) })) };
}

/** Scatter: padded linear scales (a scatter does not claim a zero baseline). */
export function scatterGeometry(spec: SafeVisualizationSpec) {
  const pairs = (spec.pairs ?? []).filter(pair => pair.x !== null && pair.y !== null);
  const width = 640, height = 280, left = 64, right = 24, top = 20, bottom = 48;
  const range = (values: number[]) => {
    if (!values.length) return { min: 0, max: 1 };
    const min = Math.min(...values), max = Math.max(...values), pad = (max - min || Math.abs(max) || 1) * 0.08;
    return { min: min - pad, max: max + pad };
  };
  const xs = range(pairs.map(p => p.x!)), ys = range(pairs.map(p => p.y!));
  const sx = (v: number) => left + ((v - xs.min) / (xs.max - xs.min || 1)) * (width - left - right);
  const sy = (v: number) => height - bottom - ((v - ys.min) / (ys.max - ys.min || 1)) * (height - top - bottom);
  const ticks = (r: { min: number; max: number }) => [0, 0.5, 1].map(t => r.min + (r.max - r.min) * t);
  return { width, height, left, bottom, points: pairs.map(p => ({ ...p, cx: sx(p.x!), cy: sy(p.y!) })),
    xTicks: ticks(xs).map(value => ({ value, x: sx(value) })), yTicks: ticks(ys).map(value => ({ value, y: sy(value) })) };
}

/** Heatmap: one cell per (column, row) claim; missing combinations stay empty (never zero-filled). */
export function heatmapGeometry(spec: SafeVisualizationSpec) {
  const columns = [...spec.domain], rows = [...(spec.rowDomain ?? [])];
  const labelWidth = 120, top = 44, cell = { w: Math.max(44, Math.min(96, 560 / Math.max(1, columns.length))), h: 34 };
  const values = spec.points.flatMap(p => p.value === null ? [] : [p.value]);
  const min = values.length ? Math.min(...values) : 0, max = values.length ? Math.max(...values) : 0, range = max - min;
  const cells = spec.points.flatMap(point => {
    const row = spec.rows?.[point.claimId];
    const colIndex = columns.indexOf(point.category), rowIndex = row === undefined ? -1 : rows.indexOf(row);
    if (colIndex < 0 || rowIndex < 0) return [];
    return [{ ...point, row: row!, x: labelWidth + colIndex * cell.w, y: top + rowIndex * cell.h, w: cell.w - 2, h: cell.h - 2,
      /** 0..1 position in the observed value range (0 when all cells are equal) */
      t: point.value === null || !range ? 0 : (point.value - min) / range }];
  });
  return { width: labelWidth + columns.length * cell.w + 8, height: top + rows.length * cell.h + 8, labelWidth, top, cell, columns, rows, cells, min, max };
}

/** Pie/donut: slice angles from the shares of the (validated, non-negative, additive) total. */
export function pieGeometry(spec: SafeVisualizationSpec, donut: boolean) {
  const slices = spec.points.filter(p => p.value !== null && p.value > 0).sort((a, b) => (b.value ?? 0) - (a.value ?? 0) || a.category.localeCompare(b.category));
  const total = slices.reduce((sum, p) => sum + (p.value ?? 0), 0) || 1;
  const cx = 130, cy = 130, outer = 110, inner = donut ? 62 : 0;
  const at = (angle: number, radius: number) => `${fmt(cx + radius * Math.sin(angle))} ${fmt(cy - radius * Math.cos(angle))}`;
  let start = 0;
  const out = slices.map(point => {
    const share = (point.value ?? 0) / total, sweep = share * Math.PI * 2, end = start + sweep, large = sweep > Math.PI ? 1 : 0;
    const full = share >= 0.9999;
    const path = full
      ? (donut ? `M${at(0, outer)} A${outer} ${outer} 0 1 1 ${at(Math.PI, outer)} A${outer} ${outer} 0 1 1 ${at(0, outer)} Z M${at(0, inner)} A${inner} ${inner} 0 1 0 ${at(Math.PI, inner)} A${inner} ${inner} 0 1 0 ${at(0, inner)} Z`
        : `M${at(0, outer)} A${outer} ${outer} 0 1 1 ${at(Math.PI, outer)} A${outer} ${outer} 0 1 1 ${at(0, outer)} Z`)
      : donut ? `M${at(start, outer)} A${outer} ${outer} 0 ${large} 1 ${at(end, outer)} L${at(end, inner)} A${inner} ${inner} 0 ${large} 0 ${at(start, inner)} Z`
        : `M${fmt(cx)} ${fmt(cy)} L${at(start, outer)} A${outer} ${outer} 0 ${large} 1 ${at(end, outer)} Z`;
    const mid = start + sweep / 2, labelRadius = donut ? (outer + inner) / 2 : outer * 0.68;
    const slice = { ...point, share, path, labelX: cx + labelRadius * Math.sin(mid), labelY: cy - labelRadius * Math.cos(mid) };
    start = end;
    return slice;
  });
  return { width: 260, height: 260, cx, cy, outer, inner, total, slices: out };
}

/** Squarified treemap (Bruls et al.): area proportional to value inside a fixed 640x300 canvas. */
export function treemapGeometry(spec: SafeVisualizationSpec) {
  const width = 640, height = 300;
  const items = spec.points.filter(p => p.value !== null && p.value > 0).sort((a, b) => (b.value ?? 0) - (a.value ?? 0) || a.category.localeCompare(b.category));
  const total = items.reduce((sum, p) => sum + (p.value ?? 0), 0) || 1;
  const tiles: (typeof items[number] & { x: number; y: number; w: number; h: number })[] = [];
  let x = 0, y = 0, w = width, h = height;
  const queue = items.map(item => ({ item, area: ((item.value ?? 0) / total) * width * height }));
  const worst = (row: number[], side: number) => {
    const sum = row.reduce((a, b) => a + b, 0), max = Math.max(...row), min = Math.min(...row);
    return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
  };
  let row: typeof queue = [];
  const flush = () => {
    if (!row.length) return;
    const sum = row.reduce((a, r) => a + r.area, 0);
    if (w >= h) {
      const colW = sum / h; let cy = y;
      for (const r of row) { const th = r.area / colW; tiles.push({ ...r.item, x, y: cy, w: colW, h: th }); cy += th; }
      x += colW; w -= colW;
    } else {
      const rowH = sum / w; let cx = x;
      for (const r of row) { const tw = r.area / rowH; tiles.push({ ...r.item, x: cx, y, w: tw, h: rowH }); cx += tw; }
      y += rowH; h -= rowH;
    }
    row = [];
  };
  for (const entry of queue) {
    const side = Math.min(w, h);
    if (!row.length || worst([...row.map(r => r.area), entry.area], side) <= worst(row.map(r => r.area), side)) row.push(entry);
    else { flush(); row.push(entry); }
  }
  flush();
  return { width, height, total, tiles: tiles.map(t => ({ ...t, share: (t.value ?? 0) / total })) };
}
