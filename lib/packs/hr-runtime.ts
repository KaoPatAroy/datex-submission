import type { Actor, ApprovalDisplay, Badge, Branch, Employee, Reader } from '../contracts';
import { canRegion, requirePermission } from '../core/auth';
import { invariant } from '../core/errors';
import { defineAction, type TrustedPackRuntime } from '../core/runtime-contracts';
import { digest } from '../core/utils';
import { hrPack } from './hr';

function toolDescriptor(name: string) {
  const descriptor = hrPack.tools.find((tool) => tool.name === name);
  invariant(descriptor, 'UNKNOWN_TOOL', `HR tool is not in the manifest: ${name}`);
  return descriptor;
}

export function canReadHrEmployee(actor: Actor, employee: Employee, branch: Branch | undefined): boolean {
  return actor.active && actor.permissions.includes('hr.read') && (actor.role === 'hr_admin' ||
    (!!branch && branch.id === employee.branchId && canRegion(actor, branch.region)));
}

export async function readBadgeSnapshot(reader: Reader, actor: Actor, employeeId: string, badgeId: string) {
  requirePermission(actor, 'hr.read');
  const employee = await reader.get<Employee>('employees', employeeId);
  const branch = employee?.branchId ? await reader.get<Branch>('branches', employee.branchId) : undefined;
  invariant(employee && employee.id === employeeId && canReadHrEmployee(actor, employee, branch),
    'FORBIDDEN', 'Employee is unavailable in your current HR scope', 403);
  const badge = await reader.get<Badge>('mock_badges', badgeId);
  invariant(badge && badge.id === badgeId && badge.employeeId === employee.id,
    'INVALID_INPUT', 'Badge is unavailable for this employee');
  const display: ApprovalDisplay = {
    badge: { employeeId: employee.id, employeeName: employee.name, employeeBranchId: employee.branchId,
      badgeId: badge.id, state: badge.state, version: badge.version, updatedAt: badge.updatedAt },
    branches: branch ? [{ id: branch.id, name: branch.name }] : []
  };
  return { employee, badge, branch, display, version: digest({ badge, employee, branch: branch ?? null }) };
}

const findEmployee = toolDescriptor('hr.find_employee');
const prepareBadgeRevocation = toolDescriptor('badge.prepare_revoke');

const badgeRevocation = defineAction<'badge_revoke'>({
  kind: 'badge_revoke',
  riskTier: 'confirmation_required',
  packIds: ['hr'],
  validate: async (context, payload) => {
    requirePermission(context.actor, 'badge.revoke');
    const { employee, badge, version, display, branch } = await readBadgeSnapshot(context.reader, context.actor, payload.employeeId, payload.badgeId);
    invariant(
      employee.active && badge.state === 'active' && (employee.branchId === null || !!branch),
      'INVALID_INPUT',
      'ไม่พบบัตรที่ใช้งานอยู่และตรงกับพนักงาน'
    );
    return { version, display };
  },
  targetIds: (payload) => [payload.badgeId],
  overlaps: (candidate, claimed) => candidate.badgeId === claimed.badgeId,
  execute: async (context, payload) => {
    requirePermission(context.actor, 'badge.revoke');
    invariant(context.targetId === payload.badgeId, 'INVALID_INPUT', 'Badge target mismatch');
    const { employee, badge, branch } = await readBadgeSnapshot(context.tx, context.actor, payload.employeeId, payload.badgeId);
    invariant(
      employee.active && badge.state === 'active' && (employee.branchId === null || !!branch),
      'INVALID_INPUT',
      'บัตรไม่พร้อมเพิกถอน'
    );
    await context.tx.put('mock_badges', {
      ...badge,
      state: 'revoked',
      version: badge.version + 1,
      operationKey: context.operationKey,
      updatedAt: context.now().toISOString()
    });
    return { recordId: badge.id };
  },
  verify: async (context, payload) => {
    if (context.targetId !== payload.badgeId) return false;
    const { badge } = await readBadgeSnapshot(context.reader, context.actor, payload.employeeId, payload.badgeId);
    return badge.operationKey === context.operationKey && badge.state === 'revoked';
  },
  visible: async (context, payload) => {
    requirePermission(context.actor, 'badge.revoke');
    await readBadgeSnapshot(context.reader, context.actor, payload.employeeId, payload.badgeId);
    return true;
  }
});

export const hrRuntime: TrustedPackRuntime = {
  sourcePolicies:[{systems:['hr'],permission:'hr.read',branchScoped:true}],
  manifest: hrPack,
  tools: [
    {
      name: findEmployee.name,
      audit: 'read',
      run: async (context, args) => {
        requirePermission(context.actor, 'hr.read');
        const input = findEmployee.inputSchema.parse(args) as { employeeId: string };
        const storedEmployee = await context.reader.get<Employee>('employees', input.employeeId) ?? null;
        const employeeBranch = storedEmployee?.branchId
          ? await context.reader.get<Branch>('branches', storedEmployee.branchId)
          : undefined;
        const canReadEmployee = !!storedEmployee && canReadHrEmployee(context.actor, storedEmployee, employeeBranch);
        const visibleEmployee = canReadEmployee ? storedEmployee : null;
        const employee = visibleEmployee ? {
          id: visibleEmployee.id,
          name: visibleEmployee.name,
          branchId: visibleEmployee.branchId,
          active: visibleEmployee.active
        } : null;
        const badges = visibleEmployee
          ? (await context.reader.list<Badge>('mock_badges')).filter((badge) => badge.employeeId === visibleEmployee.id)
              .map((badge) => ({ id: badge.id, state: badge.state })).sort((left, right) => left.id.localeCompare(right.id)).slice(0, 20)
          : undefined;
        const retrievedAt = context.now().toISOString();
        const updatedAt = (visibleEmployee as (Employee & { updatedAt?: unknown }) | null)?.updatedAt;
        const hasSourceTimestamp = typeof updatedAt === 'string';
        const sourceId = employee ? `hr:${employee.branchId ?? '__global__'}:employees:${employee.id}` : undefined;
        const result = {
          employee,
          ...(badges ? { badges } : {}),
          analysis:{facts:employee?[{text:employee.id+' · '+employee.name+' · '+(employee.active?'ใช้งาน':'ไม่ใช้งาน')+' · สาขา '+(employee.branchId??'ส่วนกลาง'),sourceIds:sourceId?[sourceId]:[]}]:[],relationships:[],hypotheses:[],missingEvidence:employee?[]:[{text:'ไม่พบพนักงานที่ตรงกับรหัสนี้',sourceIds:[]}],generatedAt:retrievedAt,evidenceVersion:digest(employee)},
          sourceIds: sourceId ? [sourceId] : [],
          sources: sourceId ? [{
            id: sourceId,
            system: 'hr',
            observedAt: hasSourceTimestamp ? updatedAt : retrievedAt,
            retrievedAt,
            freshness: 'fresh' as const,
            detail: hasSourceTimestamp
              ? 'Synthetic employee lookup snapshot; observedAt uses employee updatedAt metadata.'
              : 'Synthetic employee lookup snapshot; observedAt is the retrieval time because source updatedAt metadata is unavailable.'
          }] : []
        };
        return findEmployee.resultSchema.parse(result);
      }
    },
    {
      name: prepareBadgeRevocation.name,
    requiredPermissions:['hr.read'],
      audit: 'prepare',
      run: async (context, args) => {
        requirePermission(context.actor, 'badge.revoke');
        requirePermission(context.actor, 'hr.read');
        const input = prepareBadgeRevocation.inputSchema.parse(args) as {
          badgeId: string;
          employeeId: string;
          reason: string;
        };
        const pendingAction = await context.prepare({
          kind: 'badge_revoke',
          badgeId: input.badgeId,
          employeeId: input.employeeId,
          reason: input.reason
        });
        return prepareBadgeRevocation.resultSchema.parse({ pendingAction });
      }
    }
  ],
  actions: [badgeRevocation]
};
