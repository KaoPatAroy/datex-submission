'use client';

import { useEffect, useRef, useState } from 'react';
import type { Workspace } from '@/lib/contracts';
import type { DashboardTaskOptions as TaskOptions } from '@/lib/dashboards/task-intent';

export default function DashboardTaskOptions({ title, actorId, assigneeOptions, disabled, onPrepare, onCancel }: {
  title: string;
  actorId: string;
  assigneeOptions: Workspace['taskAssigneeOptions'];
  disabled: boolean;
  onPrepare: (options: TaskOptions) => void;
  onCancel: () => void;
}) {
  const [assigneeId, setAssigneeId] = useState(actorId);
  const [dueDate, setDueDate] = useState('');
  const assigneeRef = useRef<HTMLSelectElement>(null);
  const assigneeAvailable = assigneeId === actorId || Boolean(assigneeOptions?.some(option => option.id === assigneeId));
  useEffect(() => { assigneeRef.current?.focus(); }, []);

  return <section className="panel" aria-labelledby="dashboard-task-options-title" style={{ marginBottom: 20 }}>
    <header className="panel-header"><div><h2 id="dashboard-task-options-title" className="panel-title">เตรียมงานติดตาม</h2><p className="panel-subtitle">จาก Dashboard “{title}”</p></div></header>
    <form className="panel-body" aria-label="ตัวเลือกงานติดตาม" onSubmit={event => {
      event.preventDefault();
      if (!disabled && assigneeAvailable) onPrepare({ assigneeId, ...(dueDate ? { dueDate } : {}) });
    }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0 20px' }}>
        <div className="form-field" style={{ flex: '1 1 220px', minWidth: 0 }}><label htmlFor="dashboard-task-assignee">ผู้รับผิดชอบ</label><select id="dashboard-task-assignee" ref={assigneeRef} value={assigneeId} disabled={disabled} onChange={event => setAssigneeId(event.target.value)}>
          <option value={actorId}>ฉัน (ผู้ขอ)</option>
          {assigneeOptions?.filter(option => option.id !== actorId).map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select></div>
        <div className="form-field" style={{ flex: '1 1 220px', minWidth: 0 }}><label htmlFor="dashboard-task-due-date">กำหนดส่ง (ไม่จำเป็น)</label><input id="dashboard-task-due-date" type="date" max="9999-12-31" value={dueDate} disabled={disabled} onChange={event => setDueDate(event.target.value)} /></div>
      </div>
      {!assigneeAvailable && <p role="alert">ผู้รับผิดชอบที่เลือกไม่อยู่ในรายการปัจจุบัน กรุณาเลือกอีกครั้ง</p>}
      <p className="form-hint">ตรวจและแก้ไขคำขอในบทสนทนาก่อนส่ง แล้วตรวจข้อเสนออีกครั้งก่อนยืนยัน</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 16 }}><button className="btn btn-primary" type="submit" disabled={disabled || !assigneeAvailable}>เติมคำขอในบทสนทนา</button><button className="btn" type="button" onClick={onCancel}>ยกเลิก</button></div>
    </form>
  </section>;
}
