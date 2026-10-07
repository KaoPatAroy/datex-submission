import type { ArtifactFact, ArtifactLabels, InteractionId, SafeVisualizationSpec } from './contracts';

/** Finite Thai labels for interaction ids: user-facing notes never show the raw registry codes. */
export const INTERACTION_LABELS_TH: Readonly<Record<InteractionId, string>> = {
  inspect_data: 'ดูตารางข้อมูล', inspect_sources: 'ดูแหล่งข้อมูล', select_point: 'เลือกจุดข้อมูล', tooltip: 'ป้ายข้อมูลเมื่อชี้',
  legend_toggle: 'ซ่อน/แสดงชุดข้อมูล', cross_filter: 'กรองข้ามกราฟ', drilldown: 'เจาะลึกข้อมูล', zoom_brush: 'ซูมช่วงข้อมูล', reset: 'รีเซ็ตมุมมอง',
};
/** The Thai note for interactions the data shape cannot support (deduplicated, labels only). */
export function droppedInteractionsNote(ids: readonly InteractionId[]): string {
  const labels = [...new Set(ids.map(id => INTERACTION_LABELS_TH[id]))];
  return labels.length ? `ข้อมูลชุดนี้ไม่รองรับ: ${labels.join(', ')}` : '';
}
/** Display-side guard for notes persisted before labels existed: the legacy compiler suffix listed raw ids; show Thai labels instead. */
export function displaySuitability(note: string): string {
  return note.replace(/\s*\(ตัดการโต้ตอบที่ข้อมูลนี้ไม่รองรับ: ([^)]*)\)/g, (_match, list: string) => {
    const ids = list.split(',').map(id => id.trim()).filter((id): id is InteractionId => Object.hasOwn(INTERACTION_LABELS_TH, id));
    return ids.length ? ` (${droppedInteractionsNote(ids)})` : '';
  });
}

/** Approximate rendered width of SVG label text (px at the given font size): wide Latin glyphs ~0.6em, Thai combining marks take no width. */
export function estimateTextWidth(text: string, fontPx = 12): number {
  let width = 0;
  for (const char of text) {
    if (/[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]/.test(char)) continue;
    width += /[A-Z0-9MW@#%]/.test(char) ? fontPx * 0.66 : char === ' ' ? fontPx * 0.3 : fontPx * 0.56;
  }
  return Math.ceil(width);
}
/** Scatter point labels with simple collision avoidance: labels are placed in order (right of the point, or left near the right
 * edge) and a label whose box overlaps an already placed label is skipped (its point keeps the <title> / accessible name). */
export interface ScatterLabelPlacement { visible: boolean; anchor: 'start' | 'end'; dx: number }
export function placeScatterLabels(points: ReadonlyArray<{ cx: number; cy: number; text: string }>, chartWidth: number, fontPx = 12): ScatterLabelPlacement[] {
  const placed: Array<{ x1: number; x2: number; y1: number; y2: number }> = [];
  return points.map(point => {
    const end = point.cx > chartWidth - 150;
    const width = estimateTextWidth(point.text, fontPx);
    const x1 = end ? point.cx - 10 - width : point.cx + 10;
    const box = { x1, x2: x1 + width, y1: point.cy + 4 - fontPx, y2: point.cy + 4 + 2 };
    const visible = !placed.some(other => box.x1 < other.x2 && other.x1 < box.x2 && box.y1 < other.y2 && other.y1 < box.y2);
    if (visible) placed.push(box);
    return { visible, anchor: end ? 'end' : 'start', dx: end ? -10 : 10 };
  });
}
/** Fit a label into `maxWidth` on at most `maxLines` lines (break at spaces, ellipsis when still too long); the full text stays in a <title>. */
export function fitLabelLines(text: string, maxWidth: number, maxLines = 2, fontPx = 12): string[] {
  const fits = (value: string) => estimateTextWidth(value, fontPx) <= maxWidth;
  const clip = (value: string) => {
    if (fits(value)) return value;
    let out = value;
    while (out.length > 1 && !fits(`${out}…`)) out = out.slice(0, -1);
    return `${out.trimEnd()}…`;
  };
  if (fits(text) || maxLines <= 1) return [clip(text)];
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (let index = 0; index < words.length; index += 1) {
    const candidate = current ? `${current} ${words[index]}` : words[index];
    if (fits(candidate) || !current) { current = candidate; continue; }
    lines.push(current);
    if (lines.length === maxLines - 1) { current = words.slice(index).join(' '); break; }
    current = words[index];
  }
  lines.push(current);
  return lines.slice(0, maxLines).map(clip);
}
export function factLabel(fact: ArtifactFact, labels?: ArtifactLabels): string {
  return [...Object.entries(fact.dimensions).map(([key, value]) => labels ? labels.values[key]?.[value] ?? value : `${key}: ${value}`),
    labels?.fields[fact.measure] ?? fact.measure].join(' · ');
}
export function factValue(fact: Pick<ArtifactFact, 'value' | 'unit'>, labels?: ArtifactLabels): string {
  if (labels) {
    const unit = labels.units[fact.unit] ?? fact.unit;
    return fact.value === null ? `ไม่มีข้อมูล (${unit})` : `${new Intl.NumberFormat('th-TH', { maximumFractionDigits: 2 }).format(fact.value)} ${unit}`;
  }
  return fact.value === null ? `Unavailable (${fact.unit})` : `${fact.value} ${fact.unit}`;
}
/** Strings are inert CSV data, including cells spreadsheets might otherwise interpret as formulas. */
export function csvCell(value: string | number | null): string {
  let cell = value === null ? '' : String(value);
  if (typeof value === 'string' && (/^\s*[=+\-@]/.test(cell) || /^[\t\r\n]/.test(cell))) cell = `'${cell}`;
  return `"${cell.replaceAll('"', '""')}"`;
}
export function factsToCSV(facts: readonly ArtifactFact[]): string {
  const rows = [ ['claim_id', 'dimensions', 'measure', 'value', 'unit', 'operation', 'row_refs', 'source_refs', 'caveat'],
    ...facts.map(fact => [fact.claimId, JSON.stringify(fact.dimensions), fact.measure, fact.value, fact.unit, fact.operation,
      fact.rowRefs.join(';'), fact.sourceRefs.join(';'), fact.caveat ?? '']) ];
  return rows.map(row => row.map(csvCell).join(',')).join('\r\n');
}

/** Browser-safe geometry: a zero baseline, finite coordinates, and explicit gaps for unavailable values. */
export function chartGeometry(spec: SafeVisualizationSpec) {
  const numeric = spec.points.flatMap(p => p.value === null ? [] : [p.value]);
  const min = Math.min(0, ...numeric), max = Math.max(0, ...numeric), magnitude = Math.max(Math.abs(min), Math.abs(max), 1);
  const low = min / magnitude, high = max / magnitude, range = high - low || 1;
  const y = (value: number) => 180 - ((value / magnitude - low) / range) * 160;
  const categories = [...spec.domain];
  const series = [...new Set(spec.points.map(p => p.series))];
  const width = Math.max(640, categories.length * Math.max(44, series.length * 18));
  const slot = (width - 80) / Math.max(1, categories.length);
  const start = Date.parse(categories[0]), end = Date.parse(categories.at(-1)!);
  const centerX = (category: string) => spec.primitive === 'line' || spec.primitive === 'area'
    ? start === end ? width / 2 : 40 + (Date.parse(category) - start) / (end - start) * (width - 80)
    : 40 + categories.indexOf(category) * slot + slot / 2;
  const bars = spec.points.map(point => ({ ...point,
    centerX: centerX(point.category), domainIndex: categories.indexOf(point.category),
    x: 40 + categories.indexOf(point.category) * slot + series.indexOf(point.series) * slot / Math.max(1, series.length),
    y: point.value === null ? null : y(point.value), width: Math.max(1, slot / Math.max(1, series.length) - 3),
  }));
  const segments = series.flatMap(seriesId => {
    const points = bars.filter(p => p.series === seriesId);
    return points.flatMap((point, index) => {
      const prior = points[index - 1];
      return prior && point.y !== null && prior.y !== null && point.domainIndex === prior.domainIndex + 1 &&
        Date.parse(point.category) - Date.parse(prior.category) === 86_400_000 ? [{ from: prior, to: point, series: seriesId }] : [];
    });
  });
  return { width, height: 220, baseline: y(0), bars, segments,
    ticks: categories.map(category => ({ category, x: centerX(category) })) };
}
