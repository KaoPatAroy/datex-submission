'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import type { ArtifactLabels, SafeVisualizationSpec } from '@/lib/visualization/contracts';
import { applyChartView } from '@/lib/visualization/geometry';
import { displaySuitability, factValue } from '@/lib/visualization/presentation';
import { chartCategoryLabel, chartSeriesLabel } from '@/lib/visualization/chart-display-labels';
import {
  BarFamily, ComboFamily, EMPTY_CHART_STATE, HeatmapFamily, LineFamily, MetricFamily, PieFamily, ScatterFamily, TreemapFamily,
  type ChartState, type FamilyProps,
} from './artifact-families';
import styles from './artifact-preview.module.css';

export type { ChartState };
export { EMPTY_CHART_STATE };

const FAMILY_TITLE: Record<SafeVisualizationSpec['primitive'], [string, string]> = {
  bar: ['กราฟแท่ง', 'Bar chart of'], line: ['กราฟเส้น', 'Line chart of'], area: ['กราฟพื้นที่', 'Area chart of'], scatter: ['แผนภาพกระจาย', 'Scatter plot of'],
  heatmap: ['แผนที่ความร้อน', 'Heatmap of'], pie: ['กราฟวงกลม', 'Pie chart of'], donut: ['กราฟโดนัท', 'Donut chart of'], treemap: ['แผนผังต้นไม้', 'Treemap of'],
  combo: ['กราฟผสมแท่งและเส้น', 'Combo chart of'], metric: ['ตัวเลขสำคัญ', 'Key figures of'],
};

/** True when the user (or the OS) asks for reduced motion; the chart then renders without any transition or animation. */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    if (!query) return;
    const apply = () => setReduced(query.matches);
    apply();
    query.addEventListener?.('change', apply);
    return () => query.removeEventListener?.('change', apply);
  }, []);
  return reduced;
}

export interface ArtifactChartProps {
  spec: SafeVisualizationSpec; labels?: ArtifactLabels;
  /** Controlled interaction state (the artifact view links the chart and the exact table). Uncontrolled when absent. */
  state?: ChartState; onState?: (next: (current: ChartState) => ChartState) => void;
  /** Server-authorized drilldown of the selected category (absent => no drill control). */
  onDrill?: (category: string) => void; drillBusy?: boolean;
}

export function ArtifactChart({ spec, labels, state: controlled, onState, onDrill, drillBusy }: ArtifactChartProps) {
  const id = useId().replace(/:/g, '');
  const [local, setLocal] = useState<ChartState>(EMPTY_CHART_STATE);
  const [point, setPoint] = useState('');
  const state = controlled ?? local;
  const update = (next: (current: ChartState) => ChartState) => (onState ?? setLocal)(next);
  const reduced = useReducedMotion();
  const ids = spec.interaction.interactionIds;
  const has = (value: (typeof ids)[number]) => ids.includes(value);
  const thai = Boolean(labels);
  const text = (th: string, en: string) => thai ? th : en;
  const label = (category: string) => chartCategoryLabel(spec, labels, category);
  const series = useMemo(() => [...new Set(spec.points.map(p => p.series))], [spec.points]);
  const seriesLabel = (seriesId: string) => chartSeriesLabel(spec, labels, seriesId);
  const view = useMemo(() => applyChartView(spec, { hidden: new Set(state.hidden), range: state.range, sorted: state.sorted }), [spec, state.hidden, state.range, state.sorted]);
  const yTitle = spec.yFields.map(field => labels?.fields[field] ?? field).join(', ');
  const [familyTitle, familyEnglish] = FAMILY_TITLE[spec.primitive];
  const dirty = state.selected !== null || state.hidden.length > 0 || state.range !== null || state.sorted || point !== '';
  const active = view.points.find(p => p.claimId === point) ?? spec.points.find(p => p.claimId === point);
  const motion = reduced ? 'none' : spec.animation.modeId;
  const duration = reduced ? 0 : spec.animation.durationMs;
  const onSelect = (category: string) => { if (!has('select_point')) return; update(current => ({ ...current, selected: current.selected === category ? null : category })); setPoint(''); };
  const onHover = (category: string | null) => update(current => ({ ...current, hover: category }));
  const family: FamilyProps = { id, spec: view, labels, state, onSelect, onHover };
  const domainLabel = (index: number) => label(spec.domain[index] ?? '');
  const range = state.range ?? [0, Math.max(0, spec.domain.length - 1)];
  const shown = state.selected !== null ? view.points.filter(p => p.category === state.selected) : view.points.filter(p => p.category === state.hover);
  const status = shown.length
    ? shown.map(p => `${label(p.category)} · ${seriesLabel(p.series)}: ${factValue(p, labels)}`).join(' | ')
    : active ? `${label(active.category)}: ${factValue(active, labels)}`
      : text('เลือกค่า หรืออ่านจากตารางด้านล่าง', 'Choose a value or read the table below.');
  const visibleMarks = view.points.length;
  const hiddenNote = state.hidden.length || state.range ? text(`แสดง ${visibleMarks} จาก ${spec.points.length} ค่า`, `Showing ${visibleMarks} of ${spec.points.length} values`) : '';

  return <figure className={styles.figure} data-chart-primitive={spec.primitive} data-motion={motion} style={{ ['--chart-duration' as string]: `${duration}ms` }}>
    <figcaption className={styles.srOnly} id={`${id}-desc`}>{thai
      ? `${familyTitle} ${yTitle} จัดกลุ่มตาม ${labels?.fields[spec.xField] ?? spec.xField} ค่าที่ไม่มีข้อมูลแสดงเป็นช่องว่าง อ่านค่า หน่วย และที่มาครบถ้วนได้จากตารางด้านล่าง`
      : `${familyEnglish} ${yTitle}, grouped by ${spec.xField}. Unavailable values are gaps. Inspect the complete data table for values, units and sources.`}</figcaption>
    {spec.suitability && <p className={styles.suitability} data-chart-suitability>{displaySuitability(spec.suitability)}</p>}
    {(has('reset') || has('zoom_brush') || spec.animation.modeId === 'reorder') && <div className={styles.chartTools} role="group" aria-label={text('เครื่องมือกราฟ', 'Chart tools')}>
      {has('zoom_brush') && <>
        <label>{text('จาก', 'From')} <select value={range[0]} data-chart-brush="from" onChange={event => update(current => ({ ...current, range: [Math.min(Number(event.target.value), range[1]), range[1]] }))}>
          {spec.domain.map((_, index) => <option key={index} value={index}>{domainLabel(index)}</option>)}</select></label>
        <label>{text('ถึง', 'To')} <select value={range[1]} data-chart-brush="to" onChange={event => update(current => ({ ...current, range: [range[0], Math.max(Number(event.target.value), range[0])] }))}>
          {spec.domain.map((_, index) => <option key={index} value={index}>{domainLabel(index)}</option>)}</select></label>
      </>}
      {spec.animation.modeId === 'reorder' && !['line', 'area', 'heatmap'].includes(spec.primitive) && spec.xField !== 'date' &&
        <button type="button" className="btn btn-small" aria-pressed={state.sorted} data-chart-sort onClick={() => update(current => ({ ...current, sorted: !current.sorted }))}>{text('เรียงตามค่า', 'Sort by value')}</button>}
      {has('reset') && <button type="button" className="btn btn-small" data-chart-reset disabled={!dirty} onClick={() => { update(() => EMPTY_CHART_STATE); setPoint(''); }}>{text('รีเซ็ตมุมมอง', 'Reset view')}</button>}
    </div>}
    <div className={styles.chartWrap} role="region" aria-label={text(`${familyTitle} ค่าที่ถูกต้องอยู่ในตารางด้านล่าง`, `${familyEnglish} ${yTitle}. Exact values are in the data table below.`)} aria-describedby={`${id}-desc`} tabIndex={0}>
      {spec.primitive === 'bar' && <BarFamily {...family} />}
      {spec.primitive === 'line' && <LineFamily {...family} />}
      {spec.primitive === 'area' && <LineFamily {...family} area />}
      {spec.primitive === 'combo' && <ComboFamily {...family} />}
      {spec.primitive === 'scatter' && <ScatterFamily {...family} />}
      {spec.primitive === 'heatmap' && <HeatmapFamily {...family} />}
      {spec.primitive === 'pie' && <PieFamily {...family} donut={false} />}
      {spec.primitive === 'donut' && <PieFamily {...family} donut />}
      {spec.primitive === 'treemap' && <TreemapFamily {...family} />}
      {spec.primitive === 'metric' && <MetricFamily {...family} />}
    </div>
    {series.length > 0 && !['pie', 'donut', 'treemap', 'metric', 'heatmap'].includes(spec.primitive) && <ul className={styles.legend} aria-label={text('ชุดข้อมูลในกราฟ', 'Chart series')}>{series.map((seriesId, index) => {
      const off = state.hidden.includes(seriesId);
      const swatch = <svg width="28" height="16" aria-hidden="true">{spec.primitive === 'bar' || (spec.primitive === 'combo' && !spec.lineSeries?.includes(seriesId))
        ? <rect x="1" y="1" width="24" height="14" className={styles.bar} fill={`url(#${id}-series-${index % 8})`} />
        : <><line x1="0" x2="28" y1="8" y2="8" className={styles.line} strokeDasharray={['none', '8 3', '2 3', '10 3 2 3', '1 3', '12 5', '5 2 1 2', '3 6'][index % 8]} />
          {/* Line series are drawn as points (joined only on a time axis): the key shows the same point. */}
          <circle cx="14" cy="8" r="4" className={styles.point} /></>}</svg>;
      return <li key={seriesId}>{has('legend_toggle') && series.length > 1
        ? <button type="button" className={styles.legendButton} aria-pressed={!off} data-legend-series={index}
          onClick={() => update(current => ({ ...current, hidden: current.hidden.includes(seriesId) ? current.hidden.filter(s => s !== seriesId) : series.length - current.hidden.length > 1 ? [...current.hidden, seriesId] : current.hidden }))}>
          {swatch}<span className={off ? styles.legendOff : ''}>{seriesLabel(seriesId)}</span><span className={styles.srOnly}>{off ? text(' (ซ่อนอยู่)', ' (hidden)') : text(' (แสดงอยู่)', ' (shown)')}</span></button>
        : <>{swatch}{seriesLabel(seriesId)}</>}</li>;
    })}</ul>}
    <p role="status" aria-live="polite" className={styles.chartStatus} data-chart-status>{status}{hiddenNote && <> · {hiddenNote}</>}</p>
    {(has('select_point')) && <div className={styles.inspect}>
      <label htmlFor={`${id}-point`}>{text('ดูค่าในกราฟ', 'Inspect a chart value')}</label>
      <select id={`${id}-point`} value={point} onChange={event => {
        const claim = spec.points.find(p => p.claimId === event.target.value);
        setPoint(event.target.value);
        update(current => ({ ...current, selected: claim && has('cross_filter') ? claim.category : current.selected }));
      }}>
        <option value="">{text('เลือกค่า', 'Choose a value')}</option>{spec.points.map(p => <option key={p.claimId} value={p.claimId}>
          {label(p.category)} · {seriesLabel(p.series)} · {factValue(p, labels)}
        </option>)}
      </select>
      {has('drilldown') && onDrill && state.selected !== null && <button type="button" className="btn btn-small" data-chart-drill disabled={drillBusy} onClick={() => onDrill(state.selected!)}>
        {drillBusy ? text('กำลังโหลดรายละเอียด…', 'Loading detail…') : text(`ดูรายละเอียดของ ${label(state.selected)}`, `Drill into ${label(state.selected)}`)}</button>}
    </div>}
  </figure>;
}
