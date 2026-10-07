'use client';

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { Analysis, BranchMetric, Dashboard, Evidence, Freshness, SourceRef } from '@/lib/contracts';
import { Icon } from '@/components/icons';
import { displayPerson, regionName } from '@/components/biztania/product-labels';
import { evidenceWarningText, freshnessText, sourceDisplayName, sourceDetailText } from '@/lib/presentation/source-names';
import { displayBranchNames } from '@/lib/presentation/branch-names';
import { VizWidgetView } from '@/components/biztania/viz-widget';
import { dashboardSourcesForWidgets } from '@/lib/visualization/dashboard-sources';
import { ShareManager } from '@/components/biztania/share-manager';
import { DashboardManage, type EditOutcome, type WidgetChange } from '@/components/biztania/dashboard-manage';
import type { VizWidgetResult } from '@/lib/visualization/dashboard-data';

import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

const metricLabels: Record<string, string> = {
  net_sales: 'ยอดขายสุทธิ', target: 'เป้าหมาย', gap: 'ส่วนต่าง', achievement: 'ผลเทียบเป้าหมาย',
  stock_issues: 'สินค้าต่ำกว่าขั้นต่ำ', incident_count: 'เหตุการณ์', staffing_actual: 'กำลังคนจริง', staffing_planned: 'กำลังคนตามแผน',
  branch_metrics: 'ตัวชี้วัดรายสาขา', inventory: 'สต็อกสินค้า', staffing: 'กำลังคน', open_incidents: 'Incident ที่ยังไม่ปิด',
};

/** One display presenter for model- or server-written text: Thai business wording and Thai branch names. */
function shown(text: string) { return displayBranchNames(text); }

function dayLabel(isoDate: string) {
  const date = new Date(`${isoDate.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(date.getTime())) return isoDate;
  return new Intl.DateTimeFormat('th-TH-u-ca-buddhist', { day: 'numeric', month: 'short', year: 'numeric' }).format(date);
}

function widgetTitle(widget: Dashboard['spec']['widgets'][number]) {
  const sourceId = 'metric' in widget ? widget.metric : 'dataset' in widget ? widget.dataset : undefined;
  return shown(sourceId && widget.title.trim() === sourceId ? metricLabels[sourceId] ?? widget.title : widget.title);
}

function dateLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function number(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return 'ไม่มีข้อมูล';
  return new Intl.NumberFormat('th-TH', { maximumFractionDigits: 1 }).format(value);
}

function baht(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return 'ไม่มีข้อมูล';
  return new Intl.NumberFormat('th-TH', { style: 'currency', currency: 'THB', minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(value);
}

function percent(value: number | null | undefined) {
  return value == null || !Number.isFinite(value) ? 'ไม่มีข้อมูล' : `${new Intl.NumberFormat('th-TH', { maximumFractionDigits: 1 }).format(value)}%`;
}

function valueForMetric(branch: BranchMetric, metric: string): number | null {
  switch (metric) {
    case 'net_sales': return branch.netSales;
    case 'target': return branch.target;
    case 'gap': return branch.gap;
    case 'achievement': return branch.achievement;
    case 'stock_issues': return branch.stockIssues;
    case 'incident_count': return branch.incidentCount;
    case 'staffing_actual': return branch.staffingActual;
    case 'staffing_planned': return branch.staffingPlanned;
    default: return null;
  }
}

function metricDisplay(metric: string, value: number | null | undefined) {
  if (metric === 'net_sales' || metric === 'target' || metric === 'gap') return baht(value);
  if (metric === 'achievement') return percent(value);
  return number(value);
}

function metricFamily(metric: string) {
  if (metric === 'net_sales' || metric === 'target' || metric === 'gap') return 'currency';
  if (metric === 'achievement') return 'percent';
  return 'count';
}

function chartLabel(metric: string, value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return 'ไม่มีข้อมูล';
  if (metricFamily(metric) === 'currency') return new Intl.NumberFormat('th-TH', { style: 'currency', currency: 'THB', minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(value);
  if (metricFamily(metric) === 'percent') return percent(value);
  return number(value);
}

function freshnessLabel(freshness: Freshness) {
  return freshnessText[freshness];
}

function freshnessClass(freshness: Freshness) {
  if (freshness === 'fresh') return 'badge-success';
  if (freshness === 'missing' || freshness === 'misaligned') return 'badge-danger';
  return 'badge-warning';
}

function scopeText(evidence: Evidence) {
  return `${regionName(evidence.scope.region.toLowerCase())} · ${dayLabel(evidence.scope.date)}${evidence.scope.branchIds?.length ? ` · ${evidence.scope.branchIds.length} สาขา` : ''}`;
}

export function EvidenceSources({ sources, initialCount = sources.length }: { sources: SourceRef[]; initialCount?: number }) {
  if (!sources.length) return <div className="empty-state"><strong>ไม่มีแหล่งข้อมูลในหลักฐานชุดนี้</strong><p>ระบบยังไม่ได้คืนรายการต้นทางสำหรับการตรวจสอบ</p></div>;
  return (
    <div className="source-list">
      {sources.slice(0, initialCount).map((source) => (
        <details className="source-row" id={`source-${encodeURIComponent(source.id)}`} key={source.id}>
          <summary><span className="source-main"><strong>{sourceDisplayName(source.system)}</strong><span>{shown(sourceDetailText(source.detail))}</span></span><span className={`badge ${freshnessClass(source.freshness)}`}>{freshnessLabel(source.freshness)}</span></summary>
          <div className="source-detail"><span>เวลาของข้อมูลต้นทาง {dateLabel(source.observedAt)}</span><span>ดึงข้อมูลเมื่อ {dateLabel(source.retrievedAt)}</span></div>
        </details>
      ))}
      {sources.length > initialCount && <details className="additional-sources"><summary>ดูอีก {sources.length - initialCount} แหล่งข้อมูล</summary><EvidenceSources sources={sources.slice(initialCount)} /></details>}
    </div>
  );
}

function ClaimList({ claims, sources = [], initialCount = claims.length }: { claims: Analysis['facts']; sources?: SourceRef[]; initialCount?: number }) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const visibleClaims = expanded ? claims : claims.slice(0, initialCount);
  return (
    <div className="claim-list" id={listId}>
      {visibleClaims.map((claim, index) => (
        <div className="claim" key={index}>
          {shown(claim.text)}
          {claim.sourceIds.length > 0 && <div className="claim-sources">{claim.sourceIds.map((sourceId) => {
            const sourceIndex = sources.findIndex((source) => source.id === sourceId);
            if (sourceIndex < 0) return <span className="source-unavailable" title="ระบบยังไม่คืนแหล่งข้อมูลนี้" key={sourceId}>แหล่งที่ไม่แสดง</span>;
            return <a className="source-link" href={`#source-${encodeURIComponent(sourceId)}`} data-source-id={sourceId} key={sourceId} onClick={() => { let target: HTMLElement | null = document.getElementById(`source-${encodeURIComponent(sourceId)}`); while (target) { if (target instanceof HTMLDetailsElement) target.open = true; target = target.parentElement; } }}>แหล่ง {sourceIndex + 1} · {sourceDisplayName(sources[sourceIndex].system)}</a>;
          })}</div>}
        </div>
      ))}
      {claims.length > initialCount && <div className="record-end"><span className="panel-subtitle">แสดง {visibleClaims.length} จาก {claims.length} รายการ</span><button type="button" className="btn btn-small" aria-expanded={expanded} aria-controls={listId} onClick={() => setExpanded(!expanded)}>{expanded ? 'แสดงน้อยลง' : `ดูทั้งหมด ${claims.length} รายการ`}</button></div>}
    </div>
  );
}

function ClaimSection({ title, icon, claims, tone, sources = [], open = false, initialCount }: { title: string; icon: 'check' | 'branch' | 'spark' | 'alert'; claims: Analysis['facts']; tone: string; sources?: SourceRef[]; open?: boolean; initialCount?: number }) {
  return (
    <details className="analysis-category" open={open}>
      <summary><Icon name={icon} size={16} /><span>{title}</span><span className={`badge ${tone}`}>{claims.length}</span></summary>
      {claims.length === 0 ? <p className="record-body">ไม่มีรายการในหมวดนี้</p> : (
        <ClaimList claims={claims} sources={sources} initialCount={initialCount} />
      )}
    </details>
  );
}

export function AnalysisPanel({ analysis, sources = [] }: { analysis: Analysis | null; sources?: SourceRef[] }) {
  if (!analysis) return <div className="empty-state"><strong>ยังไม่มีบทวิเคราะห์</strong><p>หลักฐานของ Dashboard นี้ยังไม่มีการวิเคราะห์ที่บันทึกไว้</p></div>;
  return (
    <>
      <div className="analysis-grid">
        <ClaimSection key={`${analysis.evidenceVersion}-${analysis.generatedAt}`} title="ข้อเท็จจริง" icon="check" claims={analysis.facts} tone="badge-success" sources={sources} open initialCount={4} />
        <ClaimSection title="ความเชื่อมโยง" icon="branch" claims={analysis.relationships} tone="badge-info" sources={sources} />
        <ClaimSection title="ข้อสันนิษฐาน" icon="spark" claims={analysis.hypotheses} tone="badge-warning" sources={sources} />
        <ClaimSection title="หลักฐานที่ยังขาด" icon="alert" claims={analysis.missingEvidence} tone="badge-danger" sources={sources} />
      </div>
      <p className="freshness-note">วิเคราะห์เมื่อ {dateLabel(analysis.generatedAt)}</p>
    </>
  );
}

function MetricWidget({ title, metric, evidence }: { title: string; metric: string; evidence: Evidence }) {
  const totals = evidence.totals;
  const totalMap: Record<string, number | null> = {
    net_sales: totals.netSales, target: totals.target, gap: totals.gap, achievement: totals.achievement,
    stock_issues: evidence.branches.reduce((sum, branch) => sum + branch.stockIssues, 0),
    incident_count: evidence.branches.reduce((sum, branch) => sum + branch.incidentCount, 0),
    staffing_actual: evidence.branches.reduce((sum, branch) => sum + branch.staffingActual, 0),
    staffing_planned: evidence.branches.reduce((sum, branch) => sum + branch.staffingPlanned, 0),
  };
  return (
    <section className="panel">
      <header className="panel-header"><div><h2 className="panel-title">{title}</h2><p className="panel-subtitle">{metricLabels[metric] ?? metric}</p></div><span className="badge badge-muted">{evidence.branches.length} สาขา</span></header>
      <div className="metric-feature"><div className="metric-value">{metricDisplay(metric, totalMap[metric])}</div><div className="metric-note">ข้อมูลวันที่ {dayLabel(evidence.scope.date)}</div></div>
    </section>
  );
}

function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: { name?: string; value?: number; dataKey?: string }[]; label?: string }) {
  if (!active || !payload?.length) return null;
  return <div className="chart-tooltip"><strong>{label}</strong>{payload.map((item) => <div key={item.dataKey}>{item.name}: {chartLabel(item.dataKey ?? '', item.value)}</div>)}</div>;
}

function ChartWidget({ title, metric, comparisonMetric, evidence, type }: { title: string; metric: string; comparisonMetric?: string; evidence: Evidence; type: 'bar_chart' | 'line_chart' }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const viewportId = useId();
  const hintId = useId();
  const [scrollState, setScrollState] = useState({ overflow: false, left: false, right: false });
  const data = evidence.branches.map((branch) => ({
    name: displayBranchNames(branch.branchName),
    [metric]: valueForMetric(branch, metric),
    ...(comparisonMetric ? { [comparisonMetric]: valueForMetric(branch, comparisonMetric) } : {}),
  }));
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const update = () => {
      const next = { overflow: viewport.scrollWidth > viewport.clientWidth + 1, left: viewport.scrollLeft > 1, right: viewport.scrollLeft + viewport.clientWidth < viewport.scrollWidth - 1 };
      setScrollState((previous) => previous.overflow === next.overflow && previous.left === next.left && previous.right === next.right ? previous : next);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    if (viewport.firstElementChild) observer.observe(viewport.firstElementChild);
    viewport.addEventListener('scroll', update, { passive: true });
    return () => { observer.disconnect(); viewport.removeEventListener('scroll', update); };
  }, [data.length]);
  const scrollChart = (direction: -1 | 1) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollBy({ left: direction * Math.max(124, viewport.clientWidth * 0.8), behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };
  if (!data.length) return <EmptyWidget title={title} message="หลักฐานชุดนี้ไม่มีข้อมูลสาขาสำหรับกราฟ" />;
  const chartColor = '#2855d9';
  const compareColor = '#6686a0';
  const separateScale = Boolean(comparisonMetric && metricFamily(metric) !== metricFamily(comparisonMetric));
  const axisFormat = (axisMetric: string) => (value: number) => metricFamily(axisMetric) === 'percent' ? `${number(value)}%` : number(value);
  return (
    <section className="panel">
      <header className="panel-header"><div><h2 className="panel-title">{title}</h2><p className="panel-subtitle">{metricLabels[metric] ?? metric} · จำแนกตามสาขา</p></div><span className="badge badge-muted">{data.length} สาขา</span></header>
      <div className="panel-body">
        <div className="chart-legend" aria-label="ชุดข้อมูลในกราฟ" style={{ marginBottom: 10 }}>
          <span><span aria-hidden="true" style={{ display: 'inline-block', width: 12, height: 12, marginRight: 6, borderRadius: 2, backgroundColor: chartColor, verticalAlign: 'middle' }} />{metricLabels[metric] ?? metric}</span>
          {comparisonMetric && <span><span aria-hidden="true" style={{ display: 'inline-block', width: 12, height: 12, marginRight: 6, borderRadius: 2, backgroundColor: compareColor, verticalAlign: 'middle' }} />{metricLabels[comparisonMetric] ?? comparisonMetric}</span>}
        </div>
        {scrollState.overflow && <div className="chart-legend" style={{ alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}><strong id={hintId}>เลื่อนซ้าย–ขวาเพื่อดูครบ {data.length} สาขา</strong><div className="record-end" role="group" aria-label={`เลื่อนกราฟ ${title}`}><button type="button" className="btn btn-small" style={{ minHeight: 44 }} aria-controls={viewportId} disabled={!scrollState.left} onClick={() => scrollChart(-1)}><Icon name="chevron" size={14} style={{ transform: 'rotate(180deg)' }} />เลื่อนซ้าย</button><button type="button" className="btn btn-small" style={{ minHeight: 44 }} aria-controls={viewportId} disabled={!scrollState.right} onClick={() => scrollChart(1)}>เลื่อนขวา<Icon name="chevron" size={14} /></button></div></div>}
        <div ref={viewportRef} id={viewportId} className="chart-viewport" role="region" aria-label={`${title} เลื่อนแนวนอนเพื่อดูทุกสาขา`} aria-describedby={scrollState.overflow ? hintId : undefined} tabIndex={0}><div className="chart-shell" style={{ minWidth: data.length * 124 + 80 }} role="img" aria-label={`${title}: ${metricLabels[metric] ?? metric}${comparisonMetric ? ` และ ${metricLabels[comparisonMetric] ?? comparisonMetric}` : ''} แยกตามสาขา`}>
          <ResponsiveContainer width="100%" height="100%">
            {type === 'bar_chart' ? (
              <BarChart data={data} margin={{ top: 8, right: 5, left: -18, bottom: 18 }}>
                <CartesianGrid vertical={false} stroke="#e6ebf3" />
                <XAxis dataKey="name" tick={{ fill: '#586780', fontSize: 11 }} tickLine={false} axisLine={{ stroke: '#d6deea' }} interval={0} angle={-22} textAnchor="end" height={45} />
                <YAxis yAxisId="primary" tick={{ fill: '#586780', fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={axisFormat(metric)} />
                {separateScale && comparisonMetric && <YAxis yAxisId="comparison" orientation="right" tick={{ fill: '#586780', fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={axisFormat(comparisonMetric)} />}
                <Tooltip content={<ChartTooltip />} />
                <Bar yAxisId="primary" dataKey={metric} name={metricLabels[metric] ?? metric} fill={chartColor} radius={[4, 4, 0, 0]} maxBarSize={28} />
                {comparisonMetric && <Bar yAxisId={separateScale ? 'comparison' : 'primary'} dataKey={comparisonMetric} name={metricLabels[comparisonMetric] ?? comparisonMetric} fill={compareColor} radius={[4, 4, 0, 0]} maxBarSize={28} />}
              </BarChart>
            ) : (
              <LineChart data={data} margin={{ top: 8, right: 10, left: -18, bottom: 18 }}>
                <CartesianGrid vertical={false} stroke="#e6ebf3" />
                <XAxis dataKey="name" tick={{ fill: '#586780', fontSize: 11 }} tickLine={false} axisLine={{ stroke: '#d6deea' }} interval={0} angle={-22} textAnchor="end" height={45} />
                <YAxis yAxisId="primary" tick={{ fill: '#586780', fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={axisFormat(metric)} />
                {separateScale && comparisonMetric && <YAxis yAxisId="comparison" orientation="right" tick={{ fill: '#586780', fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={axisFormat(comparisonMetric)} />}
                <Tooltip content={<ChartTooltip />} />
                <Line yAxisId="primary" type="monotone" dataKey={metric} name={metricLabels[metric] ?? metric} stroke={chartColor} strokeWidth={2} dot={{ r: 3, fill: chartColor }} activeDot={{ r: 5 }} />
                {comparisonMetric && <Line yAxisId={separateScale ? 'comparison' : 'primary'} type="monotone" dataKey={comparisonMetric} name={metricLabels[comparisonMetric] ?? comparisonMetric} stroke={compareColor} strokeWidth={2} dot={{ r: 3, fill: compareColor }} />}
              </LineChart>
            )}
          </ResponsiveContainer>
        </div></div>
        <p className="chart-scroll-hint">กราฟที่กว้างเลื่อนแนวนอนได้ หรืออ่านชื่อสาขาและค่าทั้งหมดในตาราง</p>
        <details className="chart-data">
          <summary>อ่านค่ากราฟเป็นตาราง</summary>
          <div className="table-wrap">
            <table>
              <caption>{title} · ข้อมูลวันที่ {dayLabel(evidence.scope.date)}</caption>
              <thead><tr><th>สาขา</th><th className="numeric">{metricLabels[metric] ?? metric}</th>{comparisonMetric && <th className="numeric">{metricLabels[comparisonMetric] ?? comparisonMetric}</th>}</tr></thead>
              <tbody>{evidence.branches.map((branch) => <tr key={branch.branchId}><td>{displayBranchNames(branch.branchName)}</td><td className="numeric">{metricDisplay(metric, valueForMetric(branch, metric))}</td>{comparisonMetric && <td className="numeric">{metricDisplay(comparisonMetric, valueForMetric(branch, comparisonMetric))}</td>}</tr>)}</tbody>
            </table>
          </div>
        </details>
        <div className="chart-legend"><span>ข้อมูลวันที่ {dayLabel(evidence.scope.date)}</span></div>
      </div>
    </section>
  );
}

function EmptyWidget({ title, message }: { title: string; message: string }) {
  return <section className="panel"><header className="panel-header"><h2 className="panel-title">{title}</h2></header><div className="panel-body"><div className="empty-state"><strong>ไม่มีรายการให้แสดง</strong><p>{message}</p></div></div></section>;
}

function EvidenceMetadata({ context, evidence }: { context: string; evidence: Evidence }) {
  return <p className="panel-subtitle">{context} · ข้อมูลวันที่ {dayLabel(evidence.scope.date)}</p>;
}

function TableWidget({ title, dataset, evidence }: { title: string; dataset: string; evidence: Evidence }) {
  if (dataset === 'inventory') return <EmptyWidget title={title} message="หลักฐานชุดนี้มีเฉพาะจำนวนปัญหาสต็อกระดับสาขา ไม่มีรายการสินค้าและยอดคงเหลือในหลักฐานชุดนี้" />;
  if (dataset === 'open_incidents') {
    const incidents = evidence.branches.flatMap((branch) => branch.incidents.filter((incident) => incident.status === 'open').map((incident) => ({ branch, incident })));
    if (!incidents.length) return <EmptyWidget title={title} message="ไม่มี Incident ที่ยังไม่ปิดในข้อมูลชุดนี้" />;
    return (
      <section className="panel">
        <header className="panel-header"><div><h2 className="panel-title">{title}</h2><EvidenceMetadata context="Incident ที่ยังไม่ปิด" evidence={evidence} /></div><span className="badge badge-warning">{incidents.length}</span></header>
        <div className="panel-body"><div className="record-list">{incidents.map(({ branch, incident }) => <article className="record-row" key={incident.id}><div className="record-main"><strong>{shown(incident.title)}</strong><span>{displayBranchNames(branch.branchName)} · {({ payment: 'การชำระเงิน', stock: 'สต็อก', operations: 'การดำเนินงาน' } as Record<string, string>)[incident.kind] ?? incident.kind} · เริ่ม {dateLabel(incident.startedAt)}</span></div><span className="badge badge-warning">กำลังติดตาม</span></article>)}</div></div>
      </section>
    );
  }
  if (dataset === 'staffing') {
    return (
      <section className="panel">
        <header className="panel-header"><div><h2 className="panel-title">{title}</h2><EvidenceMetadata context="สรุปตามสาขา" evidence={evidence} /></div></header>
        {evidence.branches.length ? <div className="table-wrap"><table><thead><tr><th>สาขา</th><th className="numeric">ตามแผน</th><th className="numeric">ปฏิบัติงานจริง</th></tr></thead><tbody>{evidence.branches.map((branch) => <tr key={branch.branchId}><td>{displayBranchNames(branch.branchName)}</td><td className="numeric">{number(branch.staffingPlanned)}</td><td className="numeric">{number(branch.staffingActual)}</td></tr>)}</tbody></table></div> : <div className="panel-body"><div className="empty-state"><strong>ไม่มีข้อมูลกำลังคน</strong><p>หลักฐานชุดนี้ไม่มีสรุปกำลังคนระดับสาขา</p></div></div>}
      </section>
    );
  }
  return (
    <section className="panel">
      <header className="panel-header"><div><h2 className="panel-title">{title}</h2><EvidenceMetadata context="ตัวเลขและที่มา" evidence={evidence} /></div></header>
      {evidence.branches.length ? (
        <div className="table-wrap"><table><thead><tr><th>สาขา</th><th>ภูมิภาค</th><th className="numeric">ยอดขายสุทธิ</th><th className="numeric">เป้าหมาย</th><th className="numeric">เทียบเป้า</th><th className="numeric">ปัญหาสต็อก</th><th className="numeric">เหตุการณ์</th></tr></thead><tbody>{evidence.branches.map((branch) => <tr key={branch.branchId}><td>{displayBranchNames(branch.branchName)}</td><td>{regionName(branch.region.toLowerCase())}</td><td className="numeric">{baht(branch.netSales)}</td><td className="numeric">{baht(branch.target)}</td><td className="numeric">{percent(branch.achievement)}</td><td className="numeric">{number(branch.stockIssues)}</td><td className="numeric">{number(branch.incidentCount)}</td></tr>)}</tbody></table></div>
      ) : <div className="panel-body"><div className="empty-state"><strong>ไม่มีข้อมูลสาขา</strong><p>หลักฐานชุดนี้ไม่มีสรุปตัวชี้วัดระดับสาขา</p></div></div>}
    </section>
  );
}

function TextSummaryWidget({ title, analysis, sources }: { title: string; analysis: Analysis | null; sources: SourceRef[] }) {
  if (!analysis?.facts.length) return <EmptyWidget title={title} message="ยังไม่มีข้อเท็จจริงจากการวิเคราะห์ที่บันทึกไว้" />;
  return <section className="panel"><header className="panel-header"><h2 className="panel-title">{title}</h2><span className="badge badge-success">{analysis.facts.length} ข้อเท็จจริง</span></header><div className="panel-body"><ClaimList key={`${analysis.evidenceVersion}-${analysis.generatedAt}`} claims={analysis.facts} sources={sources} initialCount={4} /><p className="freshness-note">วิเคราะห์เมื่อ {dateLabel(analysis.generatedAt)}</p></div></section>;
}

function Widget({ widget, dashboard, evidence, sources, vizResult }: { widget: Dashboard['spec']['widgets'][number]; dashboard: Dashboard; evidence: Evidence; sources: SourceRef[]; vizResult?: VizWidgetResult }) {
  const title = widgetTitle(widget);
  switch (widget.type) {
    case 'metric': return <MetricWidget title={title} metric={widget.metric} evidence={evidence} />;
    case 'bar_chart':
    case 'line_chart': return <ChartWidget title={title} metric={widget.metric} comparisonMetric={widget.comparisonMetric} evidence={evidence} type={widget.type} />;
    case 'table': return <TableWidget title={title} dataset={widget.dataset} evidence={evidence} />;
    case 'incident_list': return <TableWidget title={title} dataset="open_incidents" evidence={evidence} />;
    case 'viz': return <VizWidgetView title={title} result={vizResult} />;
    case 'text_summary': return <TextSummaryWidget title={title} analysis={dashboard.analysis} sources={sources} />;
  }
}

export default function DashboardDetail({
  dashboard,
  evidence,
  analysisStale,
  sources,
  canShare,
  canPrepareTasks,
  onShare,
  onPrepareTasks,
  sharedBy,
  onRename,
  onRefine,
  onBackToChat,
  onDelete,
  vizData,
  manage,
}: {
  dashboard: Dashboard;
  evidence: Evidence;
  analysisStale: boolean;
  sources: SourceRef[];
  canShare: boolean;
  canPrepareTasks: boolean;
  onShare: () => void;
  onPrepareTasks: () => void;
  sharedBy?: { name: string };
  /** Present only for the owner. Rejects with a Thai message the form shows inline. */
  onRename?: (title: string) => Promise<void>;
  onRefine?: () => void;
  onBackToChat?: () => void;
  /** Present only for the owner of a private (unshared) dashboard. Rejects with a Thai message shown inline. */
  onDelete?: () => Promise<void>;
  /** Per-viewer, server re-queried data for evidence-bound `viz` widgets (executeDashboardVizWidgets). Absent for legacy dashboards. */
  vizData?: VizWidgetResult[];
  /** Owner-only direct management (description, widget order/title/removal); absent for recipients. */
  manage?: { onWidgetOp: (change: WidgetChange) => Promise<EditOutcome>; onDescription: (description: string) => Promise<EditOutcome>; onGoResults?: () => void; onAddWithAI?: () => void };
}) {
  const warnings = evidence.warnings;
  const displayedSources = dashboardSourcesForWidgets(sources, dashboard.spec.widgets, vizData, dashboard.analysis);
  const [editing, setEditing] = useState(false);
  const [deletePrompt, setDeletePrompt] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  async function confirmDelete() {
    if (!onDelete || deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try { await onDelete(); }
    catch (error) { setDeleteError(error instanceof Error ? error.message : 'ลบ Dashboard ไม่สำเร็จ กรุณาตรวจสถานะแล้วลองอีกครั้ง'); }
    finally { setDeleteBusy(false); }
  }
  const [draftTitle, setDraftTitle] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  async function submitRename(event: FormEvent) {
    event.preventDefault();
    const next = draftTitle.trim();
    if (!next || !onRename) { setRenameError('กรุณาใส่ชื่อ Dashboard'); return; }
    if (next === dashboard.spec.title) { setEditing(false); return; }
    setRenameBusy(true);
    setRenameError(null);
    try { await onRename(next); setEditing(false); }
    catch (error) { setRenameError(error instanceof Error ? error.message : 'เปลี่ยนชื่อไม่สำเร็จ ลองอีกครั้ง'); }
    finally { setRenameBusy(false); }
  }
  return (
    <div className="section-stack">
      <header className="page-heading">
        <div>
          {editing
            ? <form onSubmit={submitRename} aria-label="เปลี่ยนชื่อ Dashboard" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <input className="input" aria-label="ชื่อ Dashboard" value={draftTitle} maxLength={120} autoFocus disabled={renameBusy} onChange={(event) => setDraftTitle(event.target.value)} style={{ minWidth: 240, flex: 1 }} />
                <button className="btn btn-primary" type="submit" disabled={renameBusy}>{renameBusy ? 'กำลังบันทึก…' : 'บันทึกชื่อ'}</button>
                <button className="btn" type="button" disabled={renameBusy} onClick={() => { setEditing(false); setRenameError(null); }}>ยกเลิก</button>
                {renameError && <p role="alert" className="panel-subtitle" style={{ flexBasis: '100%', color: 'var(--danger, #b42318)' }}>{renameError}</p>}
              </form>
            : <h1>{shown(dashboard.spec.title)}</h1>}
          <p>{shown(dashboard.spec.description) || 'Dashboard ที่บันทึกไว้สำหรับขอบเขตงานนี้'}</p>
          <div className="scope-meta">{sharedBy && <span className="scope-pill">แชร์โดย {displayPerson(sharedBy.name)}</span>}<span className="scope-pill">{scopeText(evidence)}</span><span className="scope-pill">ข้อมูลวันที่ {dayLabel(evidence.scope.date)}</span><span className="scope-pill">อัปเดต Dashboard {dateLabel(dashboard.lastRefreshAt)}</span></div>
        </div>
        <div className="heading-tools">
          {onBackToChat && <button className="btn" type="button" onClick={onBackToChat}>กลับไปแชต</button>}
          {onRename && !editing && <button className="btn" type="button" onClick={() => { setDraftTitle(dashboard.spec.title); setRenameError(null); setEditing(true); }}>เปลี่ยนชื่อ</button>}
          {onRefine && <button className="btn" type="button" onClick={onRefine}>ปรับหรือถามต่อในแชต</button>}
          {onDelete && <button className="btn btn-danger" type="button" data-dashboard-delete disabled={deleteBusy} onClick={() => { setDeleteError(null); setDeletePrompt(true); }}>ลบ Dashboard</button>}
          {canShare && <button className="btn" type="button" onClick={onShare}><Icon name="external" size={15} /> เตรียมแชร์</button>}
          {canPrepareTasks && <button className="btn btn-primary" type="button" onClick={onPrepareTasks}><Icon name="plus" size={15} /> เตรียม Ticket ติดตามสาขา</button>}
        </div>
      </header>

      {onDelete && deletePrompt && <section className="warning-banner" role="alertdialog" aria-labelledby="dashboard-delete-title" data-dashboard-delete-prompt><h2 id="dashboard-delete-title">ลบ Dashboard นี้หรือไม่?</h2><p>Dashboard “{shown(dashboard.spec.title)}” จะถูกลบออกจากรายการของคุณ ข้อมูลต้นทางไม่ได้รับผลกระทบ</p>{deleteError && <p role="alert">{deleteError}</p>}<div className="heading-tools"><button className="btn" type="button" disabled={deleteBusy} onClick={() => setDeletePrompt(false)}>เก็บไว้</button><button className="btn btn-danger" type="button" disabled={deleteBusy} onClick={() => void confirmDelete()}>{deleteBusy ? 'กำลังลบ…' : 'ยืนยันลบ Dashboard'}</button></div></section>}

      {manage && <DashboardManage widgets={dashboard.spec.widgets.map(widget => ({ title: widgetTitle(widget), kind: widget.type === 'viz' ? widget.kind : widget.type, replaceable: widget.type === 'viz' }))} description={dashboard.spec.description} {...manage} />}
      {manage && <ShareManager kind="dashboard" id={dashboard.id} />}

      {analysisStale && <div className="stale-note"><Icon name="alert" size={15} /><span><strong>บทวิเคราะห์อ้างอิงข้อมูลเก่า</strong> — หลักฐานชุดปัจจุบันเปลี่ยนหลังการวิเคราะห์ครั้งล่าสุด โปรดอ่านแต่ละช่วงเวลาแยกกัน</span></div>}
      {warnings.length > 0 && <div className="warning-banner"><Icon name="alert" size={15} /><div className="banner-copy"><strong>หลักฐานมีข้อจำกัด</strong><ul className="warning-list">{warnings.map((warning, index) => <li key={index}>{shown(evidenceWarningText(warning))}</li>)}</ul></div></div>}

      <section>
        <div className="section-heading"><h2>ตัวชี้วัดและมุมมอง</h2><p>ข้อมูลแสดงตามหลักฐานที่ได้รับ</p></div>
        {dashboard.spec.widgets.length === 0 ? <div className="panel"><div className="empty-state"><strong>Dashboard ยังไม่มี Widget</strong><p>ขอบเขตนี้ไม่มีองค์ประกอบที่แสดงข้อมูล</p></div></div> : <div className="widget-grid">{dashboard.spec.widgets.map((widget, index) => <div className={widget.type !== 'metric' ? 'widget-wide' : ''} key={`${widget.type}-${index}`}><Widget widget={widget} dashboard={dashboard} evidence={evidence} sources={displayedSources} vizResult={vizData?.find(result => result.index === index)} /></div>)}</div>}
      </section>

      <section className="panel">
        <header className="panel-header"><div><h2 className="panel-title">การวิเคราะห์</h2><p className="panel-subtitle">แยกสิ่งที่ทราบ ความเชื่อมโยง ข้อสันนิษฐาน และช่องว่างของหลักฐาน</p></div>{analysisStale && <span className="badge badge-warning">ต้องอ่านตามช่วงเวลา</span>}</header>
        <div className="panel-body"><AnalysisPanel analysis={dashboard.analysis} sources={sources} /></div>
      </section>

      <section className="panel">
        <header className="panel-header"><div><h2 className="panel-title">แหล่งข้อมูลและความสดใหม่</h2><p className="panel-subtitle">ดูเวลาของข้อมูลต้นทางและเวลาที่ระบบดึงข้อมูล</p></div><span className="badge badge-muted">{displayedSources.length} แหล่ง</span></header>
        <div className="panel-body">
          <EvidenceSources sources={displayedSources} initialCount={3} />
          <div className="freshness-note">อัปเดต Dashboard {dateLabel(dashboard.lastRefreshAt)} · อัปเดตการตั้งค่า {dateLabel(dashboard.updatedAt)}</div>
        </div>
      </section>
    </div>
  );
}

export function EvidenceContext({ evidence, analysis, className = '' }: { evidence?: Evidence; analysis?: Analysis; className?: string }) {
  if (!evidence && !analysis) return null;
  return (
    <div className={`panel message-context ${className}`}>
      <header className="panel-header"><div><h3 className="panel-title">หลักฐานสำหรับคำตอบนี้</h3>{evidence && <p className="panel-subtitle">{scopeText(evidence)}</p>}</div></header>
      <div className="panel-body">
        {evidence && <><div className="scope-meta"><span className="scope-pill">ยอดขายสุทธิ {baht(evidence.totals.netSales)}</span><span className="scope-pill">เป้าหมาย {baht(evidence.totals.target)}</span><span className="scope-pill">ผลเทียบเป้า {percent(evidence.totals.achievement)}</span></div><EvidenceSources sources={evidence.sources} /></>}
        {analysis && <div style={{ marginTop: evidence ? 16 : 0 }}><AnalysisPanel analysis={analysis} sources={evidence?.sources} /></div>}
      </div>
    </div>
  );
}

export function FactChip({ children }: { children: ReactNode }) {
  return <span className="scope-pill">{children}</span>;
}

export function EvidenceArtifact({ evidence, analysis, sources = [] }: { evidence?: Evidence; analysis?: Analysis; sources?: SourceRef[] }) {
  return <>
    {evidence && <><div className="artifact-scope">{scopeText(evidence)}<span>ข้อมูลวันที่ {dayLabel(evidence.scope.date)}</span></div><dl className="evidence-totals"><div><dt>ยอดขายสุทธิ</dt><dd>{baht(evidence.totals.netSales)}</dd></div><div><dt>เป้าหมาย</dt><dd>{baht(evidence.totals.target)}</dd></div><div><dt>เทียบเป้าหมาย</dt><dd>{percent(evidence.totals.achievement)}</dd></div></dl>{evidence.warnings.length > 0 && <div className="warning-banner"><div className="banner-copy"><strong>หลักฐานมีข้อจำกัด</strong><ul className="warning-list">{evidence.warnings.map((warning, index) => <li key={index}>{shown(evidenceWarningText(warning))}</li>)}</ul></div></div>}</>}
    {analysis ? <AnalysisPanel analysis={analysis} sources={evidence?.sources ?? sources} /> : <div className="empty-state"><strong>ยังไม่มีบทวิเคราะห์</strong><p>คำตอบนี้ไม่ได้คืนการวิเคราะห์แยกหมวด</p></div>}
  </>;
}
