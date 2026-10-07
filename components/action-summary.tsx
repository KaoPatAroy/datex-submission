import type { PendingAction, Workspace } from '@/lib/contracts';
import { ticketPlanLines } from '@/lib/core/ticket-plan-text';
import { displayBranchNames } from '@/lib/presentation/branch-names';
import { demoScenarioImpact, demoScenarioLabel, displayPerson, regionName, scopeName, type LifecycleAction } from '@/components/biztania/product-labels';

export function hasShareApprovalDetails(action: PendingAction) {
  return action.payload.kind !== 'dashboard_share' || Boolean(action.approvalScope?.region && action.approvalScope.date && action.approvalScope.branchIds?.length && action.approvalDisplay?.artifactTitle?.trim());
}

/** Presents the exact server proposal without editing its payload or authorizing an action. */
function ActionSummaryBody({ action, profiles = [] }: { action: PendingAction; profiles?: Workspace['profiles'] }) {
  const payload = action.payload;
  if (payload.kind === 'dashboard_create') return <div className="proposal-summary"><dl className="detail-grid"><div><dt>Dashboard</dt><dd>{payload.spec.title}</dd></div><div><dt>ขอบเขตข้อมูล</dt><dd>{scopeName(payload.spec.scope)}</dd></div></dl><p>{payload.spec.description}</p><div className="proposal-widgets"><strong>มุมมองที่จะบันทึก · {payload.spec.widgets.length}</strong><ul>{payload.spec.widgets.map((widget, index) => <li key={index}>{widget.title}</li>)}</ul></div></div>;
  if (payload.kind === 'dashboard_share') {
    const recipient = profiles.find(profile => profile.id === payload.recipientId);
    const scope = action.approvalScope;
    const branches = scope?.branchIds?.map(id => { const branch = action.approvalDisplay?.branches?.find(branch => branch.id === id); return branch?.name ? displayBranchNames(branch.name) : id; });
    return <div className="proposal-summary"><dl className="detail-grid"><div><dt>Dashboard ที่จะแชร์</dt><dd>{action.approvalDisplay?.artifactTitle || 'ยังไม่มีชื่อที่ยืนยันได้'}</dd></div><div><dt>ผู้รับ</dt><dd>{recipient ? displayPerson(recipient.name) : 'ผู้รับที่ระบุในข้อเสนอ'}</dd></div></dl>{scope && <dl className="detail-grid"><div><dt>วันของข้อมูล</dt><dd>{scope.date}</dd></div><div><dt>ภูมิภาคที่ผู้รับจะเห็น</dt><dd>{regionName(scope.region)}</dd></div><div><dt>สาขาที่อนุมัติให้ผู้รับเห็น</dt><dd>{branches?.map(branch => <span className="approval-branch" key={branch}>{branch}</span>)}</dd></div></dl>}{!hasShareApprovalDetails(action) && <div className="warning-banner"><p>รายการนี้ยังไม่มีชื่อหรือขอบเขตการแชร์ที่ยืนยันได้ กรุณาขอข้อเสนอใหม่ก่อนยืนยัน</p></div>}</div>;
  }
  if (payload.kind === 'ticket_create') return <div className="proposal-summary"><p>{scopeName(payload.scope)} · {payload.targets.length} Ticket</p>{payload.plan ? <ul className="ticket-plan" data-ticket-plan>{ticketPlanLines(payload.plan).map(line => <li key={line}>{line}</li>)}</ul> : null}<div className="record-list">{payload.targets.map((target, index) => { const assignee = profiles.find(profile => profile.id === target.assigneeId); const branch = action.approvalDisplay?.branches?.find(branch => branch.id === target.branchId); return <article className="proposal-target" key={`${target.branchId}-${index}`}><strong>{displayBranchNames(target.title)}</strong><dl className="detail-grid"><div><dt>สาขา / ผู้รับผิดชอบ</dt><dd>{branch?.name ? displayBranchNames(branch.name) : target.branchId} / {assignee ? displayPerson(assignee.name) : 'ผู้รับผิดชอบที่ระบุในข้อเสนอ'}</dd></div><div><dt>เหตุผล</dt><dd>{target.reason}</dd></div><div><dt>คำถามที่ยังต้องตรวจ</dt><dd>{target.unansweredQuestion || 'ไม่ได้ระบุ'}</dd></div><div><dt>หลักฐานอ้างอิง</dt><dd>{target.sourceIds.length ? `${target.sourceIds.length} รายการ` : 'ไม่ได้ระบุ'}</dd></div></dl></article>; })}</div></div>;
  if (payload.kind === 'badge_revoke') return <dl className="detail-grid"><div><dt>พนักงาน</dt><dd>{payload.employeeId}</dd></div><div><dt>บัตรที่จะเพิกถอน</dt><dd>{payload.badgeId}</dd></div><div><dt>เหตุผล</dt><dd>{payload.reason}</dd></div></dl>;
  const scope = action.approvalScope;
  const branches = scope?.branchIds?.map(id => { const branch = action.approvalDisplay?.branches?.find(branch => branch.id === id); return branch?.name ? displayBranchNames(branch.name) : id; });
  return <div className="proposal-summary"><p>การเปลี่ยนแปลงนี้ใช้กับชุด Demo ของวันข้อมูลและสาขาที่แสดงด้านล่าง</p><dl className="detail-grid"><div><dt>สถานการณ์ข้อมูลตัวอย่าง</dt><dd>{demoScenarioLabel[payload.scenario]}</dd></div>{scope?.date && <div><dt>วันของข้อมูล</dt><dd>{scope.date}</dd></div>}{branches?.length ? <div><dt>สาขาที่เกี่ยวข้อง</dt><dd>{branches.map(branch => <span className="approval-branch" key={branch}>{branch}</span>)}</dd></div> : null}</dl><p>{demoScenarioImpact[payload.scenario]}</p></div>;
}

export default function ActionSummary(props: { action: PendingAction; profiles?: Workspace['profiles'] }) {
  const diff = (props.action as LifecycleAction).revisionDiff;
  return <><ActionSummaryBody {...props} />{diff?.length ? <section className="proposal-summary" aria-label="สิ่งที่เปลี่ยนจากข้อเสนอเดิม"><h3>สิ่งที่เปลี่ยนจากข้อเสนอเดิม</h3><ul>{diff.map((line, index) => <li key={index}>{line}</li>)}</ul></section> : null}</>;
}

export function readablePreview(preview: string) {
  try { JSON.parse(preview); return null; } catch { return preview; }
}
