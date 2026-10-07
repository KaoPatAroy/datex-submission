import type { Actor, Profile, Store } from '../../contracts';
import { personLabels } from './display';

/** The same current, authorized directory and human labels feed planner recipients and Dashboard task choices. */
export async function recipientDirectory(store: Pick<Store, 'list'>, actor: Actor,
  recipientAllowed: (actor: Actor, id: string) => Promise<boolean>, limit: number) {
  const candidates = (await store.list<Profile>('profiles')).filter(profile => profile.active && profile.id !== actor.id)
    .sort((a, b) => a.id.localeCompare(b.id));
  const decisions = await Promise.all(candidates.map(profile => recipientAllowed(actor, profile.id)));
  const allowed = candidates.filter((_, index) => decisions[index]).slice(0, limit);
  const labels = personLabels(allowed);
  return allowed.map(profile => ({ id: profile.id, name: labels.get(profile.id)!, role: profile.role }));
}
