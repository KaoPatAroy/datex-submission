'use client';

import type { CSSProperties, KeyboardEvent } from 'react';
import type { ArtifactLabels, SafeVisualizationSpec } from '@/lib/visualization/contracts';
import { chartCategoryLabel, chartSeriesLabel } from '@/lib/visualization/chart-display-labels';
import { areaGeometry, comboGeometry, heatmapGeometry, pieGeometry, scatterGeometry, treemapGeometry } from '@/lib/visualization/geometry';
import { chartGeometry, estimateTextWidth, factValue, fitLabelLines, placeScatterLabels } from '@/lib/visualization/presentation';
import styles from './artifact-preview.module.css';

/** Interaction state shared by the chart and the exact table. */
export interface ChartState { selected: string | null; hover: string | null; hidden: readonly string[]; range: readonly [number, number] | null; sorted: boolean }
export const EMPTY_CHART_STATE: ChartState = { selected: null, hover: null, hidden: [], range: null, sorted: false };

export interface FamilyProps {
  id: string; spec: SafeVisualizationSpec; labels?: ArtifactLabels; state: ChartState;
  onSelect: (category: string) => void; onHover: (category: string | null) => void;
  /** Original identities, before the chart view filters or reorders the data. */
  seriesOrder?: readonly string[]; categoryOrder?: readonly string[];
}
const DASH = ['none', '8 3', '2 3', '10 3 2 3', '1 3', '12 5', '5 2 1 2', '3 6'];
export const seriesDash = (index: number) => DASH[Math.max(0, index) % DASH.length];
// Circle, square, triangle, diamond, plus, cross, inverted triangle and star.
const MARKER_PATHS = [
  'M4 0A4 4 0 1 0-4 0A4 4 0 1 0 4 0Z',
  'M-4 -4H4V4H-4Z',
  'M0 -5L4 3H-4Z',
  'M0 -5L4 0L0 5L-4 0Z',
  'M-1.5 -4H1.5V-1.5H4V1.5H1.5V4H-1.5V1.5H-4V-1.5H-1.5Z',
  'M-4 -2L-2 -4L0 -2L2 -4L4 -2L2 0L4 2L2 4L0 2L-2 4L-4 2L-2 0Z',
  'M-4 -3H4L0 5Z',
  'M0 -5L1.5 -1.5L5 -1.5L2 1L3 4.5L0 2.5L-3 4.5L-2 1L-5 -1.5L-1.5 -1.5Z',
];
const PATTERN_PATHS = ['', 'M0 12L12 0', 'M0 3H12M0 9H12', 'M3 0V12M9 0V12', 'M0 0L12 12', 'M0 6H12M6 0V12', 'M0 0L12 12M0 12L12 0', 'M0 0H12V12H0Z'];
const label = (spec: SafeVisualizationSpec, labels: ArtifactLabels | undefined, category: string) => chartCategoryLabel(spec, labels, category);
const seriesLabel = (spec: SafeVisualizationSpec, labels: ArtifactLabels | undefined, seriesId: string) => chartSeriesLabel(spec, labels, seriesId);

/** The eight colours wrap together with the existing eight patterns/dashes. */
export const seriesStyle = (index: number): CSSProperties => ({
  ['--chart-series' as string]: `var(--series-${Math.max(0, index) % 8 + 1})`,
  ['--series-pattern' as string]: [0, 2, 6].includes(Math.max(0, index) % 8) ? 'var(--surface)' : 'var(--ink)',
});

/** The same canonical marker in the plot and legend remains identifiable without a connecting line. */
export function SeriesMarker({ index, x = 0, y = 0, title }: { index: number; x?: number; y?: number; title?: string }) {
  return <path d={MARKER_PATHS[Math.max(0, index) % MARKER_PATHS.length]} transform={`translate(${x} ${y})`} className={styles.point} style={seriesStyle(index)}>
    {title && <title>{title}</title>}
  </path>;
}

/** Contrasting patterns over each series colour keep colour from being the only distinction. */
export function Patterns({ id, count }: { id: string; count: number }) {
  return <defs>{Array.from({ length: Math.min(count, 8) }, (_, index) => <pattern key={index} id={`${id}-series-${index}`} patternUnits="userSpaceOnUse" width="12" height="12" style={seriesStyle(index)}>
    <rect width="12" height="12" className={index === 0 ? styles.patternInk : styles.patternBackground} />
    {index > 0 && <path className={styles.patternStroke} d={PATTERN_PATHS[index]} />}
  </pattern>)}</defs>;
}
export const patternFill = (id: string, index: number) => `url(#${id}-series-${Math.max(0, index) % 8})`;
const seriesOrderOf = (props: FamilyProps) => props.seriesOrder ?? [...new Set(props.spec.points.map(point => point.series))];

/** A focusable, keyboard-operable mark: Enter/Space select, hover/focus show the exact value. */
function markProps(props: FamilyProps, category: string, text: string, interactive: boolean) {
  const { state } = props;
  const focus = state.selected ?? state.hover;
  const dim = focus !== null && focus !== category;
  return {
    className: `${styles.mark} ${dim ? styles.dim : ''} ${state.selected === category ? styles.selected : ''}`,
    'data-mark': category,
    ...(interactive ? {
      role: 'button' as const, tabIndex: 0, 'aria-pressed': state.selected === category, 'aria-label': text,
      onClick: () => props.onSelect(category), onFocus: () => props.onHover(category), onBlur: () => props.onHover(null),
      onMouseEnter: () => props.onHover(category), onMouseLeave: () => props.onHover(null),
      onKeyDown: (event: KeyboardEvent) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); props.onSelect(category); } },
    } : {}),
  };
}
/** Marks are individually focusable only while the count stays navigable; the select + table are the keyboard alternative. */
const FOCUSABLE_MARKS = 60;
const interactiveOf = (spec: SafeVisualizationSpec) => spec.points.length <= FOCUSABLE_MARKS && spec.interaction.interactionIds.some(i => i === 'select_point' || i === 'tooltip');

const compact = (value: number) => new Intl.NumberFormat('th-TH', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
/** Value axis for bar/line: zero at the baseline plus the largest and smallest drawn values, with the unit, so heights read as numbers. */
function ValueAxis({ marks, baseline, labels }: { marks: readonly { value: number | null; y: number | null; unit: string }[]; baseline: number; labels?: ArtifactLabels }) {
  const drawn = marks.filter((mark): mark is { value: number; y: number; unit: string } => mark.value !== null && mark.y !== null);
  if (!drawn.length) return null;
  const top = drawn.reduce((best, mark) => mark.value > best.value ? mark : best), bottom = drawn.reduce((best, mark) => mark.value < best.value ? mark : best);
  const ticks = [{ value: 0, y: baseline }, ...(top.value > 0 ? [top] : []), ...(bottom.value < 0 ? [bottom] : [])];
  const units = [...new Set(drawn.map(mark => mark.unit))];
  return <g data-value-axis>
    {units.length === 1 && <text x="4" y="12" className={styles.label}>{labels?.units[units[0]] ?? units[0]}</text>}
    {ticks.map(tick => <text key={`${tick.value}`} x="32" y={Math.max(24, tick.y + 4)} textAnchor="end" className={styles.label}>{compact(tick.value)}</text>)}
  </g>;
}

export function BarFamily(props: FamilyProps) {
  const { id, spec, labels } = props, geometry = chartGeometry(spec), series = seriesOrderOf(props), interactive = interactiveOf(spec);
  return <svg viewBox={`0 0 ${geometry.width} ${geometry.height}`} className={styles.chart} style={{ minWidth: geometry.width }} aria-hidden={interactive ? undefined : true}>
    <Patterns id={id} count={series.length} />
    <line x1="35" x2={geometry.width - 30} y1={geometry.baseline} y2={geometry.baseline} className={styles.axis} />
    <ValueAxis marks={geometry.bars} baseline={geometry.baseline} labels={labels} />
    {geometry.bars.map(bar => bar.y === null ? null : <g key={bar.claimId} style={{ transform: `translate(${bar.x}px, 0px)` }}
      {...markProps(props, bar.category, `${label(spec, labels, bar.category)} · ${seriesLabel(spec, labels, bar.series)}: ${factValue(bar, labels)}`, interactive)}>
      <rect x="0" y={Math.min(bar.y, geometry.baseline)} width={bar.width} height={Math.abs(bar.y - geometry.baseline)} className={`${styles.bar} ${styles.grow}`} style={seriesStyle(series.indexOf(bar.series))} fill={patternFill(id, series.indexOf(bar.series))}>
        <title>{label(spec, labels, bar.category)} · {seriesLabel(spec, labels, bar.series)}: {factValue(bar, labels)}</title>
      </rect></g>)}
    {geometry.ticks.map(tick => <text key={tick.category} x={tick.x} y="207" textAnchor="middle" className={styles.label}>{label(spec, labels, tick.category)}</text>)}
  </svg>;
}

export function LineFamily(props: FamilyProps & { area?: boolean }) {
  const { id, spec, labels, area } = props, geometry = areaGeometry(spec), series = seriesOrderOf(props), interactive = interactiveOf(spec);
  return <svg viewBox={`0 0 ${geometry.width} ${geometry.height}`} className={styles.chart} style={{ minWidth: geometry.width }} aria-hidden={interactive ? undefined : true}>
    <Patterns id={id} count={series.length} />
    <line x1="35" x2={geometry.width - 30} y1={geometry.baseline} y2={geometry.baseline} className={styles.axis} />
    <ValueAxis marks={geometry.bars} baseline={geometry.baseline} labels={labels} />
    {area && geometry.runs.map(run => <path key={`${run.series}-${run.points[0].claimId}`} d={run.path} className={styles.areaFill} style={seriesStyle(series.indexOf(run.series))} />)}
    {geometry.segments.map(segment => <line key={`${segment.from.claimId}-${segment.to.claimId}`} className={styles.line}
      x1={segment.from.centerX} y1={segment.from.y!} x2={segment.to.centerX} y2={segment.to.y!} style={seriesStyle(series.indexOf(segment.series))} strokeDasharray={seriesDash(series.indexOf(segment.series))} />)}
    {geometry.bars.map(point => point.y === null ? null : <g key={point.claimId} style={{ transform: `translate(${point.centerX}px, ${point.y}px)` }}
      {...markProps(props, point.category, `${label(spec, labels, point.category)} · ${seriesLabel(spec, labels, point.series)}: ${factValue(point, labels)}`, interactive)}>
      <SeriesMarker index={series.indexOf(point.series)} title={`${label(spec, labels, point.category)} · ${seriesLabel(spec, labels, point.series)}: ${factValue(point, labels)}`} /></g>)}
    {geometry.ticks.map(tick => <text key={tick.category} x={tick.x} y="207" textAnchor="middle" className={styles.label}>{label(spec, labels, tick.category)}</text>)}
  </svg>;
}

export function ComboFamily(props: FamilyProps) {
  const { id, spec, labels } = props, g = comboGeometry(spec), interactive = interactiveOf(spec);
  const seriesAll = seriesOrderOf(props);
  const unit = (index: number) => labels?.units[spec.axisUnits?.[index] ?? ''] ?? spec.axisUnits?.[index] ?? '';
  return <svg viewBox={`0 0 ${g.width} ${g.height}`} className={styles.chart} style={{ minWidth: g.width }} aria-hidden={interactive ? undefined : true}>
    <Patterns id={id} count={seriesAll.length} />
    <line x1="35" x2={g.width - 30} y1={g.baselineLeft} y2={g.baselineLeft} className={styles.axis} />
    {g.leftTicks.map(tick => <text key={`l${tick.value}`} x="30" y={tick.y + 4} textAnchor="end" className={styles.label}>{new Intl.NumberFormat('th-TH', { notation: 'compact', maximumFractionDigits: 1 }).format(tick.value)}</text>)}
    {g.rightTicks.map(tick => <text key={`r${tick.value}`} x={g.width - 26} y={tick.y + 4} textAnchor="start" className={styles.label}>{new Intl.NumberFormat('th-TH', { notation: 'compact', maximumFractionDigits: 1 }).format(tick.value)}</text>)}
    <text x="4" y="12" className={styles.label}>{unit(0)}</text>{g.dual && <text x={g.width - 4} y="12" textAnchor="end" className={styles.label}>{unit(1)}</text>}
    {g.bars.map(bar => bar.y === null ? null : <g key={bar.claimId} style={{ transform: `translate(${bar.x}px, 0px)` }}
      {...markProps(props, bar.category, `${label(spec, labels, bar.category)} · ${seriesLabel(spec, labels, bar.series)}: ${factValue(bar, labels)}`, interactive)}>
      <rect x="0" y={Math.min(bar.y, g.baselineLeft)} width={bar.width} height={Math.abs(bar.y - g.baselineLeft)} className={`${styles.bar} ${styles.grow}`} style={seriesStyle(seriesAll.indexOf(bar.series))} fill={patternFill(id, seriesAll.indexOf(bar.series))}>
        <title>{label(spec, labels, bar.category)} · {seriesLabel(spec, labels, bar.series)}: {factValue(bar, labels)}</title></rect></g>)}
    {g.segments.map(segment => <line key={`${segment.from.claimId}-${segment.to.claimId}`} className={styles.line}
      x1={segment.from.centerX} y1={segment.from.y!} x2={segment.to.centerX} y2={segment.to.y!} style={seriesStyle(seriesAll.indexOf(segment.series))} strokeDasharray={seriesDash(seriesAll.indexOf(segment.series))} />)}
    {g.marks.map(point => point.y === null ? null : <g key={point.claimId} style={{ transform: `translate(${point.centerX}px, ${point.y}px)` }}
      {...markProps(props, point.category, `${label(spec, labels, point.category)} · ${seriesLabel(spec, labels, point.series)}: ${factValue(point, labels)}`, interactive)}>
      <SeriesMarker index={seriesAll.indexOf(point.series)} title={`${label(spec, labels, point.category)} · ${seriesLabel(spec, labels, point.series)}: ${factValue(point, labels)}`} /></g>)}
    {g.ticks.map(tick => <text key={tick.category} x={tick.x} y="207" textAnchor="middle" className={styles.label}>{label(spec, labels, tick.category)}</text>)}
  </svg>;
}

export function ScatterFamily(props: FamilyProps) {
  const { spec, labels } = props, g = scatterGeometry(spec), interactive = (spec.pairs?.length ?? 0) <= FOCUSABLE_MARKS;
  const [xm, ym] = spec.yFields, labelled = g.points.length <= 12;
  const axis = (field: string) => labels?.fields[field] ?? field;
  const fmt = (v: number) => new Intl.NumberFormat('th-TH', { notation: 'compact', maximumFractionDigits: 1 }).format(v);
  // Up to 12 labels; one whose box would overlap an already placed label is skipped (the point keeps its <title> and accessible name).
  const placements = labelled ? placeScatterLabels(g.points.map(point => ({ cx: point.cx, cy: point.cy, text: label(spec, labels, point.category) })), g.width) : [];
  return <svg viewBox={`0 0 ${g.width} ${g.height}`} className={styles.chart} style={{ minWidth: g.width }} aria-hidden={interactive ? undefined : true}>
    <line x1={g.left} x2={g.width - 20} y1={g.height - g.bottom} y2={g.height - g.bottom} className={styles.axis} />
    <line x1={g.left} x2={g.left} y1="16" y2={g.height - g.bottom} className={styles.axis} />
    {g.xTicks.map(t => <text key={`x${t.x}`} x={t.x} y={g.height - g.bottom + 16} textAnchor="middle" className={styles.label}>{fmt(t.value)}</text>)}
    {g.yTicks.map(t => <text key={`y${t.y}`} x={g.left - 6} y={t.y + 4} textAnchor="end" className={styles.label}>{fmt(t.value)}</text>)}
    <text x={g.width / 2} y={g.height - 6} textAnchor="middle" className={styles.label}>{axis(xm)}</text>
    <text x="14" y="14" className={styles.label}>{axis(ym)}</text>
    {g.points.map((point, index) => {
      const text = `${label(spec, labels, point.category)}: ${axis(xm)} ${factValue({ value: point.x, unit: point.xUnit }, labels)} · ${axis(ym)} ${factValue({ value: point.y, unit: point.yUnit }, labels)}`;
      return <g key={point.xClaimId} style={{ transform: `translate(${point.cx}px, ${point.cy}px)` }} {...markProps(props, point.category, text, interactive)}>
        <circle className={styles.point} cx="0" cy="0" r="6"><title>{text}</title></circle>
        {placements[index]?.visible && <text x={placements[index].dx} y="4" textAnchor={placements[index].anchor} className={styles.label} data-scatter-label>{label(spec, labels, point.category)}</text>}</g>;
    })}
  </svg>;
}

const HEAT_STEPS = 5;
export function HeatmapFamily(props: FamilyProps) {
  const { spec, labels } = props, g = heatmapGeometry(spec), interactive = g.cells.length <= FOCUSABLE_MARKS;
  const rowLabel = (row: string) => spec.rowLabels?.[row] ?? row;
  return <svg viewBox={`0 0 ${g.width} ${g.height}`} className={styles.chart} style={{ minWidth: Math.min(g.width, 900) }} aria-hidden={interactive ? undefined : true}>
    {g.columns.map((col, i) => {
      // Column headers wrap to two lines and clip to their own cell width, so neighbouring labels never overlap.
      const lines = fitLabelLines(label(spec, labels, col), g.cell.w - 6);
      return <text key={col} x={g.labelWidth + i * g.cell.w + g.cell.w / 2} y={g.top - 10 - (lines.length - 1) * 14} textAnchor="middle" className={styles.label} data-heatmap-column>
        <title>{label(spec, labels, col)}</title>
        {lines.map((line, index) => <tspan key={index} x={g.labelWidth + i * g.cell.w + g.cell.w / 2} dy={index ? 14 : 0}>{line}</tspan>)}
      </text>;
    })}
    {g.rows.map((row, i) => <text key={row} x={g.labelWidth - 8} y={g.top + i * g.cell.h + g.cell.h / 2 + 4} textAnchor="end" className={styles.label}>
      <title>{rowLabel(row)}</title>{fitLabelLines(rowLabel(row), g.labelWidth - 12, 1)[0]}</text>)}
    {g.cells.map(cell => {
      const step = Math.min(HEAT_STEPS - 1, Math.floor(cell.t * HEAT_STEPS));
      const text = `${label(spec, labels, cell.category)} · ${rowLabel(cell.row)}: ${factValue(cell, labels)}`;
      return <g key={cell.claimId} style={{ transform: `translate(${cell.x}px, ${cell.y}px)` }} {...markProps(props, cell.category, text, interactive)}>
        <rect x="0" y="0" width={cell.w} height={cell.h} className={`${styles.heat} ${styles[`heat${step}` as 'heat0']}`}><title>{text}</title></rect>
        <text x={cell.w / 2} y={cell.h / 2 + 4} textAnchor="middle" className={step >= 3 ? styles.heatTextLight : styles.heatText}>{cell.value === null ? '–' : new Intl.NumberFormat('th-TH', { notation: 'compact', maximumFractionDigits: 1 }).format(cell.value)}</text>
      </g>;
    })}
  </svg>;
}

export function PieFamily(props: FamilyProps & { donut: boolean }) {
  const { id, spec, labels, donut } = props, g = pieGeometry(spec, donut), interactive = g.slices.length <= FOCUSABLE_MARKS;
  const categories = props.categoryOrder ?? spec.domain;
  const pct = (share: number) => `${Math.round(share * 1000) / 10}%`;
  return <div className={styles.pieWrap}>
    <svg viewBox={`0 0 ${g.width} ${g.height}`} className={styles.pie} aria-hidden={interactive ? undefined : true}>
      <Patterns id={id} count={categories.length} />
      {g.slices.map(slice => {
        const index = categories.indexOf(slice.category);
        const text = `${label(spec, labels, slice.category)}: ${factValue(slice, labels)} (${pct(slice.share)})`;
        return <g key={slice.claimId} {...markProps(props, slice.category, text, interactive)}>
          <path d={slice.path} className={styles.slice} fillRule="evenodd" fill={patternFill(id, index)}><title>{text}</title></path>
          {slice.share >= 0.07 && <text x={slice.labelX} y={slice.labelY + 4} textAnchor="middle" className={styles.sliceText}>{pct(slice.share)}</text>}
        </g>;
      })}
      {donut && <text x={g.cx} y={g.cy + 4} textAnchor="middle" className={styles.label}>{labels?.fields[spec.yFields[0]] ?? spec.yFields[0]}</text>}
    </svg>
    <ul className={styles.sliceList}>{g.slices.map(slice => <li key={slice.claimId}>
      <svg width="20" height="14" aria-hidden="true" style={seriesStyle(categories.indexOf(slice.category))}><rect width="20" height="14" className={styles.bar} fill={patternFill(id, categories.indexOf(slice.category))} /></svg>
      {label(spec, labels, slice.category)} · {pct(slice.share)}</li>)}</ul>
  </div>;
}

export function TreemapFamily(props: FamilyProps) {
  const { id, spec, labels } = props, g = treemapGeometry(spec), interactive = g.tiles.length <= FOCUSABLE_MARKS;
  const categories = props.categoryOrder ?? spec.domain;
  const pct = (share: number) => `${Math.round(share * 1000) / 10}%`;
  return <svg viewBox={`0 0 ${g.width} ${g.height}`} className={styles.chart} style={{ minWidth: 520 }} aria-hidden={interactive ? undefined : true}>
    <Patterns id={id} count={categories.length} />
    {g.tiles.map(tile => {
      const index = categories.indexOf(tile.category);
      const text = `${label(spec, labels, tile.category)}: ${factValue(tile, labels)} (${pct(tile.share)})`;
      return <g key={tile.claimId} style={{ transform: `translate(${tile.x}px, ${tile.y}px)` }} {...markProps(props, tile.category, text, interactive)}>
        <rect x="1" y="1" width={Math.max(0, tile.w - 2)} height={Math.max(0, tile.h - 2)} className={styles.tile} fill={patternFill(id, index)}><title>{text}</title></rect>
        {tile.w > 70 && tile.h > 34 && (() => {
          // The label stays inside its tile: one line when name · share fits, else name (clipped) over the share.
          const room = tile.w - 20, oneLine = `${label(spec, labels, tile.category)} · ${pct(tile.share)}`;
          const lines = estimateTextWidth(oneLine) <= room ? [oneLine]
            : tile.h > 54 ? [fitLabelLines(label(spec, labels, tile.category), room, 1)[0], pct(tile.share)] : [fitLabelLines(oneLine, room, 1)[0]];
          const boxWidth = Math.min(tile.w - 12, Math.max(...lines.map(line => estimateTextWidth(line))) + 10);
          return <><rect x="6" y="6" width={boxWidth} height={6 + lines.length * 16} className={styles.tileLabelBg} />
            <text x="10" y="20" className={styles.tileText} data-treemap-label>{lines.map((line, index) => <tspan key={index} x="10" dy={index ? 16 : 0}>{line}</tspan>)}</text></>;
        })()}
      </g>;
    })}
  </svg>;
}

export function MetricFamily(props: FamilyProps) {
  const { spec, labels } = props;
  return <ul className={styles.metrics} aria-label={labels ? 'ตัวเลขสำคัญ' : 'Key figures'}>{spec.points.map(point => <li key={point.claimId} {...markProps(props, point.category, `${label(spec, labels, point.category)} · ${seriesLabel(spec, labels, point.series)}: ${factValue(point, labels)}`, spec.interaction.interactionIds.includes('select_point'))}>
    <span className={styles.metricLabel}>{label(spec, labels, point.category)} · {seriesLabel(spec, labels, point.series)}</span>
    <strong className={styles.metricValue}>{factValue(point, labels)}</strong></li>)}</ul>;
}
