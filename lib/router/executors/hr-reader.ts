import 'server-only';

import type { Actor, Branch, Employee, Reader } from '../../contracts';
import { requirePermission } from '../../core/auth';
import type { CatalogAuthority } from '../../dynamic/catalog/authority';
import type { HrReadRequest, HrSnapshot } from '../../dynamic/catalog/hr';
import type { Badge } from '../../contracts';
import { canReadHrEmployee } from '../../packs/hr-runtime';

/** Server authority snapshot for the Wave 2 certified HR validator. */
export function hrCatalogAuthority(actor: Actor): CatalogAuthority {
  return { id: actor.id, role: actor.role, active: actor.active, revision: actor.modeRevision + 1,
    permissions: [...actor.permissions],
    // hr_admin reads the whole directory through the existing HR tool; others stay region-bound.
    regions: actor.role === 'hr_admin' ? ['*'] : [...actor.regions], branchIds: null, recipientIds: [] };
}

const BADGE_ID_CHUNK = 500;

/**
 * Bounded HR snapshot over the existing store. Authorization is the existing `hr.find_employee` rule
 * (`canReadHrEmployee`); only id/name/branchId/active ever leave the reader (no private columns).
 *
 * The scan is bounded AT THE STORAGE BOUNDARY: every store read carries `limit = maxRows + 1` (so an over-budget branch is
 * detected by the store read itself, never loaded in full), exact employee ids named by the plan are pushed as an id
 * filter, and badges are fetched only for the readable employees. A read that hits the bound marks the snapshot
 * `truncated`; the evidence executor then refuses to build an answer from an unknown population.
 *
 * The synthetic store is the system of record and is read in one pass, so each population is attested by that same
 * read. When employee rows carry `updatedAt` the latest one is the observation time; otherwise the read time is used,
 * exactly as the existing `hr.find_employee` tool does for rows without `updatedAt`.
 */
export async function readHrSnapshot(reader: Reader, actor: Actor, request: HrReadRequest, now: () => Date): Promise<HrSnapshot> {
  requirePermission(actor, 'hr.read');
  const started = Date.now();
  const retrievedAt = now().toISOString();
  const bound = { limit: request.maxRows + 1 };
  const idFilter: Record<string, string | string[]> = request.lookupIds?.length ? { id: [...request.lookupIds] } : {};
  const branches = new Map((await reader.list<Branch>('branches')).map(branch => [branch.id, branch]));
  const rows: { id: string; name: string; branchId: string | null; active: boolean; badges?: { id: string; state: Badge['state']; type: string }[] }[] = [];
  const populations: HrSnapshot['populations'][number][] = [];
  let truncated = false;
  const populationFor = (branchId: string | null, employees: readonly (Employee & { updatedAt?: unknown })[]) => {
    const readable = employees.filter(employee => canReadHrEmployee(actor, employee, employee.branchId ? branches.get(employee.branchId) : undefined));
    const stamps = readable.map(employee => typeof employee.updatedAt === 'string' ? employee.updatedAt : null);
    const observed = stamps.length && stamps.every(Boolean)
      ? stamps.map(String).sort().at(-1)! : retrievedAt;
    for (const employee of readable) rows.push({ id: employee.id, name: employee.name, branchId: employee.branchId, active: employee.active });
    populations.push({ branchId, employeeIds: readable.map(employee => employee.id),
      observedAt: Date.parse(observed) > Date.parse(retrievedAt) ? retrievedAt : observed, retrievedAt });
  };
  for (const branchId of request.branchIds) {
    const read = await reader.list<Employee>('employees', { branchId, ...idFilter }, bound);
    if (read.length > request.maxRows) { truncated = true; break; }
    populationFor(branchId, read);
    if (rows.length > request.maxRows) { truncated = true; break; }
  }
  if (!truncated && request.includeGlobal) {
    // Global (branchless) records cannot be expressed as a store filter; the read is still capped by the bound.
    const read = await reader.list<Employee>('employees', idFilter, bound);
    if (read.length > request.maxRows) truncated = true;
    else populationFor(null, read.filter(employee => employee.branchId === null));
  }
  // Badge state (id, state, type only; never version/timestamps/operation keys) for the readable employees only.
  if (!truncated && request.includeBadges && rows.length) {
    const badgesByEmployee = new Map<string, { id: string; state: Badge['state']; type: string }[]>();
    for (let offset = 0; offset < rows.length; offset += BADGE_ID_CHUNK) {
      const ids = rows.slice(offset, offset + BADGE_ID_CHUNK).map(row => row.id);
      const chunk = await reader.list<Badge & { type?: unknown }>('mock_badges', { employeeId: ids }, { limit: ids.length * 20 + 1 });
      for (const badge of chunk.sort((a, b) => a.id.localeCompare(b.id))) {
        const list = badgesByEmployee.get(badge.employeeId) ?? [];
        if (list.length < 20) list.push({ id: badge.id, state: badge.state, type: typeof badge.type === 'string' && badge.type ? badge.type.slice(0, 40) : 'employee_badge' });
        badgesByEmployee.set(badge.employeeId, list);
      }
    }
    for (const row of rows) row.badges = badgesByEmployee.get(row.id) ?? [];
  }
  return { rows, populations, elapsedMs: Math.max(0, Date.now() - started), ...(truncated ? { truncated: true } : {}) };
}
