'use client';

import { useState } from 'react';

export type WidgetChange = { op: 'reorder'; order: number[] } | { op: 'remove'; index: number } | { op: 'retitle'; index: number; title: string } | { op: 'change_family'; index: number; kind: string };
/** `replaceable`: an evidence-bound visual widget whose family can be replaced (the server re-validates suitability against its bound plan). */
export interface ManagedWidget { title: string; kind: string; replaceable?: boolean }
/** 'staged' = a shared Dashboard: the edit became a confirm proposal (the page opened the confirm dialog), nothing was changed yet. */
export type EditOutcome = 'updated' | 'staged';
const FAMILY_CHOICES = ['kpi', 'table', 'bar', 'line', 'area', 'scatter', 'heatmap', 'pie', 'donut', 'treemap', 'combo'] as const;

const KIND_LABEL: Record<string, string> = {
  kpi: 'ตัวเลขสำคัญ', table: 'ตาราง', bar: 'กราฟแท่ง', line: 'กราฟเส้น', area: 'กราฟพื้นที่', scatter: 'แผนภาพกระจาย', heatmap: 'แผนที่ความร้อน',
  pie: 'กราฟวงกลม', donut: 'กราฟโดนัท', treemap: 'แผนผังต้นไม้', combo: 'กราฟผสม', metric: 'ตัวชี้วัด', bar_chart: 'กราฟแท่ง', line_chart: 'กราฟเส้น',
  incident_list: 'รายการเหตุการณ์', text_summary: 'สรุปข้อความ',
};
export const widgetKindLabel = (kind: string) => KIND_LABEL[kind] ?? kind;

/**
 * Direct management of the owner's own Dashboard: description, widget order, titles and removal. Each action calls the server with the revision the page
 * loaded; a stale page gets a clear conflict (and the latest view) instead of overwriting. A shared Dashboard stays confirm-tier: the same action becomes
 * a staged proposal (the existing confirm dialog opens) and nothing changes until it is confirmed. Evidence/query bindings are never editable here.
 */
export function DashboardManage({ widgets, description, onWidgetOp, onDescription, onGoResults, onAddWithAI }: {
  widgets: ManagedWidget[]; description: string;
  onWidgetOp: (change: WidgetChange) => Promise<EditOutcome>; onDescription: (description: string) => Promise<EditOutcome>;
  onGoResults?: () => void; onAddWithAI?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [retitle, setRetitle] = useState<{ index: number; value: string } | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [family, setFamily] = useState<{ index: number; kind: string } | null>(null);

  const run = async (work: () => Promise<EditOutcome>, done: string) => {
    if (busy) return false;
    setBusy(true); setNotice(null);
    try { const outcome = await work(); setNotice({ kind: 'ok', text: outcome === 'staged' ? 'เตรียมรายการแล้ว — Dashboard นี้ถูกแชร์ โปรดตรวจและยืนยันก่อนจึงจะเปลี่ยนจริง' : done }); return true; }
    catch (error) { setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'แก้ไข Dashboard ไม่สำเร็จ กรุณาลองอีกครั้ง' }); return false; }
    finally { setBusy(false); }
  };
  const move = (index: number, to: number) => {
    const order = widgets.map((_, i) => i);
    [order[index], order[to]] = [order[to], order[index]];
    return run(() => onWidgetOp({ op: 'reorder', order }), 'จัดลำดับ Widget แล้ว');
  };

  return <details className="panel" data-dashboard-manage>
    <summary className="panel-header" style={{ cursor: 'pointer' }}><span className="panel-title">จัดการ Widget และคำอธิบาย</span></summary>
    <div className="panel-body">
      {notice && <p role={notice.kind === 'error' ? 'alert' : 'status'} data-dashboard-manage-notice style={{ color: notice.kind === 'error' ? 'var(--danger, #b42318)' : 'var(--accent-ink, #1d4ed8)' }}>{notice.text}</p>}
      <form aria-label="แก้ไขคำอธิบาย Dashboard" onSubmit={event => { event.preventDefault(); if (draft !== null) void run(() => onDescription(draft), 'บันทึกคำอธิบายแล้ว').then(ok => { if (ok) setDraft(null); }); }}
        style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
        <label style={{ flex: 1, minWidth: 240 }}>คำอธิบาย <input className="input" value={draft ?? description} maxLength={500} disabled={busy} onChange={event => setDraft(event.target.value)} data-dashboard-description-input style={{ width: '100%' }} /></label>
        <button className="btn btn-primary" type="submit" disabled={busy || draft === null || draft === description}>บันทึกคำอธิบาย</button>
      </form>
      <ol aria-label="Widget ใน Dashboard" style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {widgets.map((widget, index) => <li key={`${index}:${widget.title}`} data-manage-widget={index} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {retitle?.index === index
            ? <form onSubmit={event => { event.preventDefault(); void run(() => onWidgetOp({ op: 'retitle', index, title: retitle.value }), 'เปลี่ยนชื่อ Widget แล้ว').then(ok => { if (ok) setRetitle(null); }); }} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', flex: 1 }}>
              <input className="input" aria-label="ชื่อ Widget" value={retitle.value} maxLength={100} onChange={event => setRetitle({ index, value: event.target.value })} style={{ flex: 1, minWidth: 200 }} />
              <button className="btn btn-small btn-primary" type="submit" disabled={busy || !retitle.value.trim()}>บันทึกชื่อ</button>
              <button className="btn btn-small" type="button" onClick={() => setRetitle(null)}>ยกเลิก</button>
            </form>
            : <span style={{ flex: 1, minWidth: 200 }}><strong>{widget.title}</strong> <span className="panel-subtitle">· {widgetKindLabel(widget.kind)}</span></span>}
          <button className="btn btn-small" type="button" data-widget-action="up" aria-label={`เลื่อน ${widget.title} ขึ้น`} disabled={busy || index === 0} onClick={() => void move(index, index - 1)}>ขึ้น</button>
          <button className="btn btn-small" type="button" data-widget-action="down" aria-label={`เลื่อน ${widget.title} ลง`} disabled={busy || index === widgets.length - 1} onClick={() => void move(index, index + 1)}>ลง</button>
          <button className="btn btn-small" type="button" data-widget-action="retitle" disabled={busy} onClick={() => setRetitle({ index, value: widget.title })}>เปลี่ยนชื่อ</button>
          {widget.replaceable && <button className="btn btn-small" type="button" data-widget-action="replace" disabled={busy} onClick={() => setFamily({ index, kind: widget.kind })}>เปลี่ยนรูปแบบ</button>}
          <button className="btn btn-small btn-danger" type="button" data-widget-action="remove" disabled={busy || widgets.length < 2} title={widgets.length < 2 ? 'ต้องมี Widget อย่างน้อย 1 รายการ' : undefined} onClick={() => setRemoving(index)}>เอาออก</button>
          {family?.index === index && <form data-widget-replace-form style={{ flexBasis: '100%', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}
            onSubmit={event => { event.preventDefault(); void run(() => onWidgetOp({ op: 'change_family', index, kind: family.kind }), 'เปลี่ยนรูปแบบ Widget แล้ว').then(() => setFamily(null)); }}>
            <label>รูปแบบใหม่ <select className="input" value={family.kind} onChange={event => setFamily({ index, kind: event.target.value })} data-widget-replace-select>
              {FAMILY_CHOICES.map(kind => <option key={kind} value={kind}>{widgetKindLabel(kind)}</option>)}</select></label>
            <button className="btn btn-small btn-primary" type="submit" disabled={busy || family.kind === widget.kind}>ใช้รูปแบบนี้</button>
            <button className="btn btn-small" type="button" onClick={() => setFamily(null)}>ยกเลิก</button>
            <span className="panel-subtitle">ใช้ข้อมูลเดิมของ Widget · ระบบตรวจว่ารูปแบบเหมาะกับข้อมูลก่อนเปลี่ยน</span></form>}
          {removing === index && <span role="alertdialog" aria-label={`เอา ${widget.title} ออก`} data-widget-remove-confirm style={{ flexBasis: '100%' }}>
            เอา “{widget.title}” ออกจาก Dashboard? ข้อมูลต้นทางไม่ถูกลบ{' '}
            <button className="btn btn-small btn-danger" type="button" disabled={busy} onClick={() => void run(() => onWidgetOp({ op: 'remove', index }), 'เอา Widget ออกแล้ว').then(() => setRemoving(null))}>ยืนยันเอาออก</button>{' '}
            <button className="btn btn-small" type="button" onClick={() => setRemoving(null)}>ยกเลิก</button></span>}
        </li>)}
      </ol>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
        {onGoResults && <button className="btn" type="button" data-dashboard-add-result onClick={onGoResults}>เพิ่มผลลัพธ์ที่บันทึกไว้</button>}
        {onAddWithAI && <button className="btn" type="button" data-dashboard-add-ai onClick={onAddWithAI}>เพิ่มหรือเปลี่ยน Widget ด้วย AI ในแชต</button>}
      </div>
      <p className="panel-subtitle">Dashboard ที่แชร์แล้ว การแก้ไขจะเป็นรายการให้ตรวจและยืนยันก่อน · Widget ดึงข้อมูลสดตามสิทธิ์ของผู้เปิดทุกครั้ง</p>
    </div>
  </details>;
}
