import { createHash, randomUUID } from 'node:crypto';
import type { PendingAction } from '../contracts';
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
/** The canonical approval binding used by confirmation, readback and seed recovery. */
export function pendingActionApprovalHash(a: Pick<PendingAction, 'actorId'|'sessionId'|'mode'|'modeRevision'|'payload'|'evidenceVersion'|'packs'|'expiresAt'|'receiptAccess'|'releaseRevision'|'actionContractVersion'|'approvalScope'|'approvalDisplay'|'predecessorActionId'|'revisionDiff'>): string {
  const {actorId,sessionId,mode,modeRevision,payload,evidenceVersion,packs,expiresAt,receiptAccess,releaseRevision,actionContractVersion,approvalScope,approvalDisplay,predecessorActionId,revisionDiff}=a;
  const approval={actorId,sessionId,mode,modeRevision,payload,evidenceVersion,packs,expiresAt,receiptAccess,releaseRevision,actionContractVersion,approvalScope,approvalDisplay};
  return predecessorActionId===undefined&&revisionDiff===undefined?digest(approval):digest({...approval,predecessorActionId:predecessorActionId??null,revisionDiff:revisionDiff??[]});
}
export function id(prefix: string): string { return `${prefix}_${randomUUID()}`; }
