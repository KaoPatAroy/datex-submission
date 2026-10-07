import 'server-only';

/**
 * Live AI kill switch. The unified TurnPlan router is the only live path; there is no legacy/shadow router.
 * `BIZTANIA_DYNAMIC_QUERY=off` disables live AI turns: they complete with a truthful "AI temporarily unavailable —
 * use Demo" answer and never call a model. Any other value (or unset) leaves the router on.
 * Read per turn so an operator can flip it without a new service instance.
 */
export function liveAIKillSwitchOn(): boolean {
  return process.env.BIZTANIA_DYNAMIC_QUERY?.trim() === 'off';
}

/** One thinking-disabled planner call takes ~4-5 s on the current provider; default leaves headroom. */
export function readDynamicPlannerTimeoutMs(): number {
  const raw = process.env.BIZTANIA_DYNAMIC_PLANNER_TIMEOUT_MS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? Math.max(1_000, Math.min(15_000, Math.floor(parsed))) : 15_000;
}
