import type { Branch, Role } from '../../contracts';
import { regionDefinitions } from '../../dynamic/catalog/seed';
import { displayBranchNames } from '../../presentation/branch-names';

/**
 * Server-owned Thai display names for ids that reach user-visible text (clarify chips, previews, answers). Demo fixture
 * names ("Demo East Manager" / "Demo East Branch 1") are never shown raw: the Thai role or region name is used instead.
 * Pure data formatting: no user text is read here.
 */
const DEMO_FIXTURE = /^Demo\b/u;
export const ROLE_LABELS: Readonly<Record<Role, string>> = { executive: 'ผู้บริหาร', east_manager: 'ผู้จัดการภาคตะวันออก', hr_admin: 'ผู้ดูแลฝ่ายบุคคล', hr_director: 'ผู้อำนวยการฝ่ายบุคคล' };

export function regionLabel(id: string): string {
  return regionDefinitions.find(region => region.id === id)?.labels[0] ?? id;
}

export function branchLabel(branch: Pick<Branch, 'id' | 'name' | 'region'>): string {
  const shown = displayBranchNames(branch.name);
  if (DEMO_FIXTURE.test(shown) || !shown.trim()) return `สาขา ${branch.id} (${regionLabel(branch.region)})`;
  return shown.includes(branch.id) ? shown : `${shown} (${branch.id})`;
}

function demoPersonPurpose(name: string): string {
  return name.replace(/^Demo\b\s*/u, '').replace(/\s+V\d+\s+Profile Anchor$/u, '').trim();
}

/** Demo accounts use their human fixture purpose when repeated roles need distinction; profile ids never enter display text. */
export function personLabel(person: { id: string; name: string; role: string }, sameRoleCount = 1, accountOrdinal?: number): string {
  const name = person.name.trim();
  const role = ROLE_LABELS[person.role as Role];
  const ordinalLabel = typeof accountOrdinal === 'number' && Number.isSafeInteger(accountOrdinal) && accountOrdinal > 0
    ? `บัญชี ${accountOrdinal}` : '';
  if (DEMO_FIXTURE.test(name)) {
    const purpose = demoPersonPurpose(name);
    const base = role && sameRoleCount > 1 && purpose ? `${role} (${purpose})` : (role ?? purpose) || 'ผู้ติดต่อ';
    return ordinalLabel ? `${base} (${ordinalLabel})` : base;
  }
  if (!name) return role ? `${role}${ordinalLabel ? ` (${ordinalLabel})` : ''}` : `ผู้ติดต่อ${ordinalLabel ? ` (${ordinalLabel})` : ''}`;
  if (!role) return ordinalLabel ? `${name} (${ordinalLabel})` : name;
  return `${name} (${role}${ordinalLabel ? `, ${ordinalLabel}` : ''})`;
}

export function personLabels(people: readonly { id: string; name: string; role: string }[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const person of people) {
    const normalizedName = person.name.trim().normalize('NFKC').toLowerCase();
    const sameRoleCount = people.filter(candidate => candidate.role === person.role).length;
    const sameNameRolePeople = people.filter(candidate => candidate.role === person.role
      && candidate.name.trim().normalize('NFKC').toLowerCase() === normalizedName);
    const sortedSameNameRolePeople = sameNameRolePeople.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const accountOrdinal = sortedSameNameRolePeople.length > 1
      ? sortedSameNameRolePeople.findIndex(candidate => candidate.id === person.id) + 1 : undefined;
    labels.set(person.id, personLabel(person, sameRoleCount, accountOrdinal));
  }
  return labels;
}
