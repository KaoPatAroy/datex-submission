import type { Actor, Profile, Reader, Scope, Mode } from '../contracts';
import { invariant } from './errors';

export interface SessionRow { id: string; profileId: string; mode: Mode; modeRevision: number; csrfToken: string; expiresAt: string }
export function requirePermission(actor: Actor, permission: string): void {
  invariant(actor.active && actor.permissions.includes(permission), 'FORBIDDEN', 'บัญชีนี้ไม่มีสิทธิ์ดำเนินการนี้', 403);
}
export function canRegion(actor: Actor, region: string): boolean { return actor.active && (actor.regions.includes('*') || actor.regions.includes(region)); }
export function authorizedScope(actor: Actor, scope: Scope): Scope {
  requirePermission(actor, 'sales.read');
  if (scope.region === 'all') return { ...scope, region: actor.regions.includes('*') || actor.regions.length > 1 ? 'all' : actor.regions[0] ?? '__denied__' };
  invariant(canRegion(actor, scope.region), 'FORBIDDEN', 'ข้อมูลอยู่นอกภูมิภาคที่คุณมีสิทธิ์', 403);
  return scope;
}
export async function reloadActor(reader: Reader, actor: Actor, now = new Date()): Promise<Actor> {
  const profile = await reader.get<Profile>('profiles', actor.id);
  const session = await reader.get<SessionRow>('sessions', actor.sessionId);
  invariant(profile?.active && session && session.profileId === actor.id && new Date(session.expiresAt) > now, 'UNAUTHENTICATED', 'กรุณาเข้าสู่ระบบใหม่', 401);
  return { ...profile, sessionId: session.id, mode: session.mode, modeRevision: session.modeRevision };
}
