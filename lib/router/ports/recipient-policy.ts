import type { Actor, Profile, Store } from '../../contracts';

/**
 * Standalone recipient policy for server jobs that run without a ConciergeService (the monitor cron): the recipient exists,
 * is active, is not the actor, and holds the sales read grant the shared content requires. Mirrors
 * ConciergeService.recipientAllowed for the sales pack.
 */
export function createRecipientPolicy(store: Pick<Store, 'get'>, required: readonly string[] = ['sales.read']) {
  return async (actor: Actor, recipientId: string, reader: Pick<Store, 'get'> = store): Promise<boolean> => {
    if (recipientId === actor.id) return false;
    const profile = await reader.get<Profile>('profiles', recipientId);
    return !!profile && profile.active && profile.id === recipientId && required.every(p => profile.permissions.includes(p));
  };
}
