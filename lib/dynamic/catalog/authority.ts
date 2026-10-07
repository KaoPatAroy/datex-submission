import { z } from 'zod';
import { idSchema } from '../plan/schemas';
import type { Sensitivity, Trust } from './physical';

export const catalogAuthoritySchema = z.object({
  id: idSchema, role: z.enum(['executive', 'east_manager', 'hr_admin', 'hr_director']), active: z.boolean(),
  revision: z.number().int().positive(), permissions: z.array(idSchema).max(100),
  regions: z.array(z.string().min(1).max(40)).max(2000),
  branchIds: z.array(idSchema).max(2000).nullable(),
  recipientIds: z.array(idSchema).max(100),
}).strict();
export type CatalogAuthority = z.infer<typeof catalogAuthoritySchema>;

/** Server snapshots only. Role limits remain binding even if region metadata is over-broad. */
export function canCatalogRegion(actor: CatalogAuthority, region: string): boolean {
  return actor.active && (actor.role !== 'east_manager' || region === 'east') &&
    (actor.regions.includes('*') || actor.regions.includes(region));
}
export function canCatalogBranch(actor: CatalogAuthority, branch: { id: string; region: string }): boolean {
  return canCatalogRegion(actor, branch.region) && (actor.branchIds === null || actor.branchIds.includes(branch.id));
}

export function authorizeCatalogField(input: {
  trust: Trust; sensitivity: Sensitivity; requiredPermissions: readonly string[];
  uses: readonly string[]; actor: CatalogAuthority;
}): { allowed: boolean; label?: string } {
  if (!input.actor.active || !input.requiredPermissions.every(p => input.actor.permissions.includes(p)) ||
    input.sensitivity === 'restricted' || input.trust === 'unknown' || !input.uses.length ||
    input.uses.some(use => !['answer', 'explore'].includes(use))) return { allowed: false };
  if (input.sensitivity === 'personal' && !input.actor.permissions.includes('hr.read')) return { allowed: false };
  if (input.sensitivity === 'confidential' && !input.actor.permissions.includes('catalog.confidential.read')) return { allowed: false };
  if (input.trust === 'certified') return { allowed: true };
  if (!['public_business', 'internal'].includes(input.sensitivity) || input.uses.some(use => use !== 'explore')) return { allowed: false };
  return { allowed: true, label: input.trust === 'inferred' ? 'Inferred interpretation' : 'Unverified field interpretation' };
}

/** A pure audience check, never a send capability. Every recipient needs current content authority. */
export function validateCatalogAudience(input: {
  actor: CatalogAuthority; recipients: readonly CatalogAuthority[]; recipientIds: readonly string[];
  branches: readonly { id: string; region: string }[]; requiredPermissions: readonly string[];
}): boolean {
  return input.recipientIds.length > 0 && input.recipientIds.length <= 100 &&
    new Set(input.recipientIds).size === input.recipientIds.length && input.actor.active &&
    input.requiredPermissions.every(p => input.actor.permissions.includes(p)) &&
    input.branches.every(b => canCatalogBranch(input.actor, b)) &&
    input.recipientIds.every(id => {
      const matches = input.recipients.filter(r => r.id === id);
      return input.actor.recipientIds.includes(id) && matches.length === 1 && matches[0].active &&
        input.requiredPermissions.every(p => matches[0].permissions.includes(p)) &&
        input.branches.every(b => canCatalogBranch(matches[0], b));
    });
}
