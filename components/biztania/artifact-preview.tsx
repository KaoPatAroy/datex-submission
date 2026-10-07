'use client';

import { useCallback, useState } from 'react';
import type { ArtifactFact, ArtifactRendererSpec } from '@/lib/visualization/contracts';
import { factLabel, factValue } from '@/lib/visualization/presentation';
import { freshnessDisplay } from '@/lib/presentation/source-names';
import { ArtifactChart, EMPTY_CHART_STATE, type ChartState } from './artifact-chart';
import { ArtifactTable } from './artifact-table';
import styles from './artifact-preview.module.css';

/** Server answer of a drilldown (a linked read re-authorized and re-run through the registered query path). */
export interface ArtifactDrillResult {
  field: string; value: string; facts: ArtifactFact[]; labels?: ArtifactRendererSpec['labels'];
  /** true when the fresh read equals what this artifact version recorded for the selected group */
  matchesVersion: boolean; note: string;
}
type DrillState = { status: 'idle' } | { status: 'loading'; category: string } | { status: 'error'; message: string } | { status: 'ready'; result: ArtifactDrillResult };

/** Receives only a server-compiled, authorized spec. Confirmation/effects belong to the service shell. */
export function ArtifactPreview({ spec, drillUrl }: {
  spec: ArtifactRendererSpec;
  /** Builds the same-origin GET url of the server drilldown for one selected value. Absent => the drill control is not offered. */
  drillUrl?: (field: string, value: string) => string;
}) {
  const labels = spec.labels;
  const thai = Boolean(labels);
  const text = (th: string, en: string) => thai ? th : en;
  const regionLabel = (id: string) => labels?.values.region?.[id] ?? id;
  const branchLabel = (id: string) => labels?.values.branch?.[id] ?? id;
  const visual = spec.visualization;
  const [chart, setChart] = useState<ChartState>(EMPTY_CHART_STATE);
  const [drill, setDrill] = useState<DrillState>({ status: 'idle' });
  const onState = useCallback((next: (current: ChartState) => ChartState) => setChart(next), []);
  const filtering = Boolean(visual?.interaction.interactionIds.includes('cross_filter') && chart.selected !== null);
  const facts = filtering ? spec.facts.filter(fact => visual!.xField in fact.dimensions && fact.dimensions[visual!.xField] === chart.selected) : spec.facts;
  const drillField = visual?.interaction.selectionFields[0];
  const canDrill = Boolean(visual?.interaction.interactionIds.includes('drilldown') && drillUrl && drillField);
  const runDrill = async (category: string) => {
    if (!drillUrl || !drillField) return;
    setDrill({ status: 'loading', category });
    try {
      const response = await fetch(drillUrl(drillField, category), { method: 'GET', credentials: 'include', cache: 'no-store' });
      const body = await response.json().catch(() => null) as { error?: { message?: string } } & Partial<ArtifactDrillResult> | null;
      if (!response.ok || !body?.facts) throw new Error(body?.error?.message ?? text('โหลดรายละเอียดไม่สำเร็จ', 'Could not load the detail'));
      setDrill({ status: 'ready', result: body as ArtifactDrillResult });
    } catch (error) { setDrill({ status: 'error', message: error instanceof Error ? error.message : text('โหลดรายละเอียดไม่สำเร็จ', 'Could not load the detail') }); }
  };
  return <section className={styles.preview} aria-label={text(`ตัวอย่างผลลัพธ์ ${spec.title}`, `${spec.title} artifact preview`)} data-artifact-preview={spec.artifact.id} data-artifact-version={spec.artifact.version}>
    <header><h2>{spec.title}</h2><p className={styles.scope}>{text('ภูมิภาค', 'Regions')}: {spec.scope.regions.map(regionLabel).join(', ')} · {text('สาขา', 'Branches')}: {spec.scope.branchIds.map(branchLabel).join(', ')}
      <br />{text('วันที่', 'Dates')}: {spec.scope.dates.join(', ')} · {text('เวอร์ชัน', 'Version')} {spec.artifact.version}
      {spec.sharedBy && <><br /><span data-artifact-shared-by>{text(`แชร์โดย ${spec.sharedBy} · ดูได้อย่างเดียว`, `Shared by ${spec.sharedBy} · read only`)}</span></>}</p></header>
    <p>{text('ตัวอย่าง', 'Preview')} · {spec.coverage.complete ? text('ตรวจครบทุกกลุ่มในหลักฐาน', 'Evidence population verified') : text('หลักฐานไม่ครบ', 'Partial evidence')}
      {spec.ranking && (thai
        ? ` · ระบบเลือก ${spec.ranking.count} กลุ่ม${spec.ranking.direction === 'highest' ? 'สูงสุด' : 'ต่ำสุด'}จากกลุ่มที่ตรวจครบแล้ว ตารางแสดงทุกค่าที่เลือก`
        : ` · Query selected the ${spec.ranking.direction} ${spec.ranking.count} groups from the verified population. The table shows every selected claim.`)}</p>
    {spec.interpretationLabels.length > 0 && <ul className={styles.notes}>{spec.interpretationLabels.map(label => <li key={label}>{label}</li>)}</ul>}
    {spec.limitations.length > 0 && <aside aria-label={text('ข้อจำกัดของหลักฐาน', 'Evidence limitations')}><h3>{text('ข้อจำกัดของหลักฐาน', 'Evidence limitations')}</h3><ul>{spec.limitations.map(note => <li key={note}>{note}</li>)}</ul></aside>}
    {!spec.facts.length ? <p>{text('ยังไม่มีค่าที่อ้างอิงหลักฐานได้ ขอข้อมูลที่รองรับก่อนเตรียมผลลัพธ์', 'No grounded values are available. Request supported evidence before preparing an artifact.')}</p> : <>
      {visual && <ArtifactChart spec={visual} labels={labels} state={chart} onState={onState} {...(canDrill ? { onDrill: category => void runDrill(category), drillBusy: drill.status === 'loading' } : {})} />}
      {drill.status === 'error' && <p role="alert" className={styles.drillError} data-drill-error>{drill.message}</p>}
      {drill.status === 'ready' && drill.result.value === chart.selected && <section className={styles.drill} aria-label={text('รายละเอียดที่เจาะลึก', 'Drilldown detail')} data-artifact-drill>
        <h3>{text('รายละเอียด', 'Detail')}: {labels?.values[drill.result.field]?.[drill.result.value] ?? drill.result.value}</h3>
        <p role="status">{drill.result.note}{drill.result.matchesVersion ? '' : text(' · ข้อมูลที่อ่านใหม่ต่างจาก Result ฉบับนี้', ' · Re-read data differs from this version')}</p>
        <ArtifactTable facts={drill.result.facts} labels={drill.result.labels ?? labels} caption={text('ข้อมูลที่อ่านใหม่สำหรับรายการที่เลือก', 'Re-read data for the selected item')} />
        <button type="button" className="btn btn-small" onClick={() => setDrill({ status: 'idle' })}>{text('ปิดรายละเอียด', 'Close detail')}</button>
      </section>}
      {spec.kind === 'executive_brief' && <ul className={styles.brief}>{spec.facts.map(fact => <li key={fact.claimId}>
        <strong>{factLabel(fact, labels)}</strong>: {factValue(fact, labels)}{fact.caveat && <p>{fact.caveat}</p>}
      </li>)}</ul>}
      {filtering && <p role="status" className={styles.chartStatus} data-table-filter>{text(`ตารางกรองตามกลุ่มที่เลือก: ${facts.length} จาก ${spec.facts.length} แถว`, `Table filtered by the selected group: ${facts.length} of ${spec.facts.length} rows`)}</p>}
      <ArtifactTable facts={facts} labels={labels} caption={text('ผลลัพธ์ที่ถูกต้อง: ทุกค่าที่เลือก พร้อมหน่วยและที่มา', 'Exact query results: all selected claims with units and sources')} />
      {spec.csv !== null && <details><summary>{text('ดูเนื้อหาไฟล์ CSV', 'Inspect CSV export content')}</summary><pre className={styles.csv}>{spec.csv}</pre></details>}
    </>}
    <details><summary>{text('ดูหลักฐานและแหล่งข้อมูล', 'Inspect evidence and sources')}</summary><p>{text('ระดับข้อมูล', 'Grain')}: {spec.grain.join(', ')}</p>
      <ul>{spec.sources.map(source => <li key={source.id}>{source.id} · {text(freshnessDisplay(source.freshness), source.freshness)} · {text('เวลาของข้อมูลต้นทาง', 'source time')} {source.observedAt} · {text('ดึงข้อมูลเมื่อ', 'retrieved at')} {source.retrievedAt}</li>)}</ul>
      <p className={styles.digest}>Query {spec.query.id} · Evidence {spec.evidence.digest} · Claims {spec.claimGraphDigest}</p>
    </details>
  </section>;
}
