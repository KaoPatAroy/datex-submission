import { describe, expect, it } from 'vitest';
import { dashboardIntentRequest, type DashboardIntent } from '@/lib/dashboards/task-intent';

const profiles = [
  { id: 'user-exec', name: 'Demo Executive', role: 'executive' as const },
  { id: 'user-east', name: 'Demo East Manager', role: 'east_manager' as const },
];
const workspace = { profiles, taskAssigneeOptions: [{ id: 'user-east', label: 'ผู้จัดการภาคตะวันออก' }] };
const intent: DashboardIntent = {
  dashboardId: 'dashboard-exact-42', title: 'ยอดขายตะวันออก', actionKind: 'ticket_create',
  prompt: 'เตรียมงานติดตามสาขาจากหลักฐานที่มีสิทธิ์อ่าน',
};

describe('Dashboard task intent', () => {
  it('adds the chosen person and due date to an editable natural-language request', () => {
    const result = dashboardIntentRequest({ ...intent, taskOptions: { assigneeId: 'user-east', dueDate: '2026-10-12' } }, workspace, 'user-exec');
    expect(result?.prompt).toBe(`${intent.prompt} จาก Dashboard “ยอดขายตะวันออก” มอบหมายให้ ผู้จัดการภาคตะวันออก กำหนดส่งวันที่ 2026-10-12`);
    expect(result?.prompt).not.toContain('user-east');
    expect(result?.prompt).not.toContain(intent.dashboardId);
  });

  it('keeps the exact Dashboard target and options through the storage handoff', () => {
    const stored = JSON.parse(JSON.stringify({ ...intent, taskOptions: { assigneeId: 'user-east', dueDate: '2026-10-12' } })) as DashboardIntent;
    const result = dashboardIntentRequest(stored, workspace, 'user-exec');
    expect(result?.targets).toEqual([{ kind: 'dashboard', id: 'dashboard-exact-42' }]);
    expect(result?.prompt).toContain('ผู้จัดการภาคตะวันออก');
    expect(result?.prompt).toContain('2026-10-12');
  });

  it('keeps self assignment and an omitted date as the executor defaults', () => {
    const result = dashboardIntentRequest({ ...intent, taskOptions: { assigneeId: 'user-exec' } }, workspace, 'user-exec');
    expect(result?.prompt).toBe(`${intent.prompt} จาก Dashboard “ยอดขายตะวันออก”`);
    expect(result?.targets).toEqual([{ kind: 'dashboard', id: intent.dashboardId }]);
  });

  it('retains compatibility with stored intents that have no task options or title', () => {
    expect(dashboardIntentRequest({ ...intent, title: undefined }, workspace, 'user-exec')).toEqual({
      prompt: `${intent.prompt} จาก Dashboard ที่เลือกไว้`, targets: [{ kind: 'dashboard', id: intent.dashboardId }],
    });
  });

  it('rejects a selected person absent from the current workspace instead of falling back to self', () => {
    expect(dashboardIntentRequest({ ...intent, taskOptions: { assigneeId: 'removed-person' } }, workspace, 'user-exec')).toBeNull();
  });

  it('rejects an active workspace profile excluded from the server assignee options', () => {
    const current = { ...workspace, profiles: [...profiles, { id: 'user-hr', name: 'Demo HR Admin', role: 'hr_admin' as const }] };
    expect(dashboardIntentRequest({ ...intent, taskOptions: { assigneeId: 'user-hr' } }, current, 'user-exec')).toBeNull();
  });

  it('uses the exact server assignee label including its account ordinal', () => {
    const current = {
      profiles: [...profiles, { id: 'user-east-2', name: 'สมชาย ใจดี', role: 'east_manager' as const }],
      taskAssigneeOptions: [{ id: 'user-east-2', label: 'สมชาย ใจดี (ผู้จัดการภาคตะวันออก) — บัญชี 2' }],
    };
    const result = dashboardIntentRequest({ ...intent, taskOptions: { assigneeId: 'user-east-2' } }, current, 'user-exec');
    expect(result?.prompt).toBe(`${intent.prompt} จาก Dashboard “ยอดขายตะวันออก” มอบหมายให้ สมชาย ใจดี (ผู้จัดการภาคตะวันออก) — บัญชี 2`);
  });

  it('allows only self when the workspace has no assignee options field', () => {
    const current = { profiles, taskAssigneeOptions: undefined };
    expect(dashboardIntentRequest({ ...intent, taskOptions: { assigneeId: 'user-east' } }, current, 'user-exec')).toBeNull();
    expect(dashboardIntentRequest({ ...intent, taskOptions: { assigneeId: 'user-exec' } }, current, 'user-exec')?.prompt).toBe(`${intent.prompt} จาก Dashboard “ยอดขายตะวันออก”`);
  });

  it('rejects an invalid date in a restored handoff', () => {
    expect(dashboardIntentRequest({ ...intent, taskOptions: { dueDate: '2026-02-30' } }, workspace, 'user-exec')).toBeNull();
  });

  it('preserves the intent for a non-sales task and keeps composer prefill free of JSON and internal ids', () => {
    const result = dashboardIntentRequest({ ...intent, prompt: 'ช่วยเตรียมงานติดตามปัญหาสต็อก', taskOptions: { assigneeId: 'user-east', dueDate: '2026-10-12' } }, workspace, 'user-exec');
    expect(result?.prompt).toBe('ช่วยเตรียมงานติดตามปัญหาสต็อก จาก Dashboard “ยอดขายตะวันออก” มอบหมายให้ ผู้จัดการภาคตะวันออก กำหนดส่งวันที่ 2026-10-12');
    expect(result?.prompt).not.toContain('{');
    expect(result?.prompt).not.toContain('ตัวเลือกที่ยืนยันจากระบบ');
    expect(result?.prompt).not.toContain('user-east');
  });

  it('looks up the selected assignee by id when account labels overlap', () => {
    const current = { taskAssigneeOptions: [{ id: 'account-1', label: 'ผู้จัดการ — บัญชี 1' }, { id: 'account-2', label: 'ผู้จัดการ — บัญชี 2' }] };
    const result = dashboardIntentRequest({ ...intent, taskOptions: { assigneeId: 'account-2' } }, current, 'user-exec');
    expect(result?.prompt).toContain('มอบหมายให้ ผู้จัดการ — บัญชี 2');
    expect(result?.prompt).not.toContain('บัญชี 1');
    expect(result?.prompt).not.toContain('account-2');
  });

  it('keeps share wording and target independent of task controls', () => {
    expect(dashboardIntentRequest({ ...intent, actionKind: 'dashboard_share' }, workspace, 'user-exec')).toEqual({
      prompt: 'ช่วยเตรียมแชร์ Dashboard “ยอดขายตะวันออก” ให้ผู้ร่วมงาน', targets: [{ kind: 'dashboard', id: intent.dashboardId }],
    });
  });
});
