'use client';

import type { ArtifactLabels } from '@/lib/visualization/contracts';
import { vizDataToChartSpec, type VizWidgetResult } from '@/lib/visualization/dashboard-data';
import { factValue } from '@/lib/visualization/presentation';
import { ArtifactChart } from './artifact-chart';
import { ArtifactTable } from './artifact-table';
import styles from './artifact-preview.module.css';

/**
 * Renders one evidence-bound `viz` dashboard widget from server-resolved, per-viewer data. No data (not yet re-queried,
 * denied for this viewer, or unavailable) renders a typed Thai state; nothing is read from the stored spec but the title.
 */
export function VizWidgetView({ title, result }: { title: string; result?: VizWidgetResult }) {
  if (!result || result.status !== 'ready') {
    const text = !result ? 'กำลังโหลดข้อมูลตามสิทธิ์ของคุณ…' : result.text;
    return <section className="panel" aria-label={title}><header className="panel-header"><h2 className="panel-title">{title}</h2></header>
      <div className="panel-body"><div className="empty-state" role={result ? 'status' : undefined}><strong>{result?.status === 'denied' ? 'ไม่มีสิทธิ์ดูข้อมูลนี้' : 'ยังไม่มีข้อมูลให้แสดง'}</strong><p>{text}</p></div></div></section>;
  }
  const { data } = result;
  const labels: ArtifactLabels = data.labels ?? { fields: { [data.measure]: data.measureLabel, ...(data.dimension ? { [data.dimension]: data.dimensionLabel ?? data.dimension } : {}) },
    units: { [data.unit]: data.unitLabel }, values: {} };
  const chart = data.chart ?? vizDataToChartSpec(data);
  const subtitle = [data.measureLabel, data.dimensionLabel ? `จำแนกตาม${data.dimensionLabel}` : null,
    data.shown < data.total ? `แสดง ${data.shown} จาก ${data.total} รายการ` : null].filter(Boolean).join(' · ');
  return <section className="panel" aria-label={title} data-viz-widget={data.kind}>
    <header className="panel-header"><div><h2 className="panel-title">{title}</h2><p className="panel-subtitle">{subtitle}</p></div><span className="badge badge-muted">{data.shown} รายการ</span></header>
    <div className="panel-body">
      {data.kind === 'kpi' && <div className="metric-feature"><div className="metric-value">{factValue({ value: data.points[0].value, unit: data.unit }, labels)}</div>
        <div className="metric-note">{data.measureLabel}</div></div>}
      {chart && <ArtifactChart spec={chart} labels={labels} />}
      {data.chart && data.facts && <ArtifactTable facts={data.facts} labels={labels} caption={`${title} ค่าที่ถูกต้อง`} />}
      {data.kind !== 'kpi' && !data.chart && <div className={`table-wrap ${styles.tableWrap}`} role="region" aria-label={`${title} ตารางค่า`} tabIndex={0}>
        <table className={styles.table}><caption>{title}</caption>
          <thead><tr><th scope="col">{data.dimensionLabel ?? 'รายการ'}</th><th scope="col" className="numeric">{data.measureLabel}</th></tr></thead>
          <tbody>{data.points.map(point => <tr key={point.claimId}><th scope="row">{point.label}</th><td className="numeric">{factValue({ value: point.value, unit: data.unit }, labels)}</td></tr>)}</tbody>
        </table></div>}
      {data.limitations.length > 0 && <ul className="warning-list">{data.limitations.map(note => <li key={note}>{note}</li>)}</ul>}
      <p className="panel-subtitle">อ้างอิงหลักฐานที่ตรวจแล้ว · {data.sources.length} แหล่งข้อมูล</p>
    </div>
  </section>;
}
