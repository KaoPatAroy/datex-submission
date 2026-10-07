import 'server-only';
import { getRuntimeSettings } from './client';
import { AIRuntimeError } from './errors';

export type AIHealthOutcome = 'ok' | 'provider_unavailable' | 'deadline_exceeded' | 'not_configured';
export type AIHealth = { status: 'ok' | 'degraded' | 'unavailable' | 'not_configured'; reason: string; checkedAt: string };
const windowMs = 5 * 60_000;
const capacity = 32;
const outcomes: { outcome: AIHealthOutcome; at: number }[] = [];
/**
 * Per-actor planner observations: a model that keeps returning malformed / unusable output (invalid_model_response) is
 * unhealthy for that actor even though the provider answers. 3 of the actor's last 5 observations within the window flip
 * health. Schema-valid plans that validation merely rejects (user-inducible) are never recorded here.
 */
const actorWindow = 5, actorFailureThreshold = 3, actorCapacity = 200;
const actorObservations = new Map<string, { unusable: boolean; at: number }[]>();
export function recordModelResponse(actorId: string, unusable: boolean, at = Date.now()): void {
  const list = actorObservations.get(actorId) ?? [];
  list.push({ unusable, at });
  if (list.length > actorWindow) list.splice(0, list.length - actorWindow);
  actorObservations.delete(actorId); actorObservations.set(actorId, list);
  if (actorObservations.size > actorCapacity) actorObservations.delete(actorObservations.keys().next().value as string);
}

/** Per-instance memory only. Retains neither requests nor provider configuration. */
export function recordAIHealth(outcome: AIHealthOutcome, at = Date.now()): void {
  outcomes.push({ outcome, at });
  if (outcomes.length > capacity) outcomes.splice(0, outcomes.length - capacity);
}

export function getAIHealth(now = Date.now(), actorId?: string): AIHealth {
  const checkedAt = new Date(now).toISOString();
  try {
    if (!process.env.NINEARM_API_KEY?.trim()) return { status: 'not_configured', reason: 'not_configured', checkedAt };
    getRuntimeSettings();
  } catch {
    return { status: 'not_configured', reason: 'not_configured', checkedAt };
  }
  const own = (actorId ? actorObservations.get(actorId) ?? [] : []).filter(item => item.at <= now && now - item.at < windowMs);
  if (own.filter(item => item.unusable).length >= actorFailureThreshold) {
    return { status: 'unavailable', reason: 'recent_unusable_plans', checkedAt: new Date(own.at(-1)!.at).toISOString() };
  }
  const recent = outcomes.filter(item => item.at <= now && now - item.at < windowMs).slice(-3);
  const failures = recent.filter(item => item.outcome === 'provider_unavailable' || item.outcome === 'deadline_exceeded').length;
  const last = recent.at(-1);
  const reason = failures >= 2 ? 'recent_provider_failures' : last?.outcome ?? 'no_recent_turns';
  return { status: failures >= 2 ? 'unavailable' : !last || failures || last.outcome === 'not_configured' ? 'degraded' : 'ok', reason, checkedAt: last ? new Date(last.at).toISOString() : checkedAt };
}

/** One observation per Live runtime invocation; application/auth/cancel errors are not provider failures. */
export async function observeLiveAITurn<T>(live: boolean, turn: () => Promise<T>, actorId?: string): Promise<T> {
  let outcome: AIHealthOutcome | undefined, unusable: boolean | undefined;
  try {
    const result = await turn();
    outcome = 'ok'; unusable = false;
    return result;
  } catch (error) {
    if (error instanceof AIRuntimeError) {
      if (error.code === 'not_configured' || error.code === 'invalid_configuration') outcome = 'not_configured';
      else if (error.code === 'provider_unavailable' || error.code === 'deadline_exceeded') outcome = error.code;
      else if (error.code === 'invalid_model_response') unusable = true;
    }
    throw error;
  } finally {
    if (live && outcome) recordAIHealth(outcome);
    if (live && actorId && unusable !== undefined) recordModelResponse(actorId, unusable);
  }
}
