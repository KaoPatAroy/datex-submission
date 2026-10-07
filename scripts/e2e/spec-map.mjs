// Per-spec seconds: measured sums from biztania-track-a-hosted-p1/e2e-int.log (2026-10-06); router-flows is an estimate (six tests, ~15s each) pending a measured run; director-flows is an estimate (V2 server: cold start runs the V2 bootstrap + manager advancement, then role gate and the Director flows); p2-closure is an estimate (two V1 tests, each builds a Dashboard by chat first, ~30s each).
// dashboard-task-options is an estimate for its four sign-in, selection, and prefill scenarios.
// Groups describe impact; longest-first packing balances execution independently.
export const groups = {
  A: ['action-revision-real', 'action-revision', 'badge-current-review', 'dashboard-empty'],
  B: ['chat-recovery', 'refinement', 'security', 'answer-reading-order', 'follow-up-prompts', 'director-flows', 'resources-flows'],
  C: ['product-ux', 'workspace', 'conversation-sidebar', 'visual-identity', 'first-paint-mode', 'resources-ops', 'p2-closure', 'dashboard-task-options'],
  D: ['demo-mode', 'dynamic-query', 'dynamic-off', 'router-flows', 'router-visual-flows'],
};
export const seconds = {
  'action-revision-real': 23.8, 'action-revision': 100.6, 'answer-reading-order': 21.7,
  'badge-current-review': 27.9, 'chat-recovery': 34.5, 'conversation-sidebar': 28.7,
  'dashboard-empty': 23.7, 'demo-mode': 25.5, 'director-flows': 110, 'dynamic-query': 20, 'dynamic-off': 10, 'router-flows': 90, 'router-visual-flows': 150, 'first-paint-mode': 20.7,
  'follow-up-prompts': 32.1, 'p2-closure': 60, 'product-ux': 66.6, refinement: 50.3, 'resources-flows': 150, 'resources-ops': 70,
  'dashboard-task-options': 90,
  security: 35, 'visual-identity': 36.6, workspace: 72.8,
};
/** Specs whose server runs Workflow V2 (WORKFLOW_V2_ENABLED=true; bootstrap + real manager advancement => a Director-ready queue). Every other spec keeps the V1 server. */
export const workflowV2Specs = ['director-flows'];
export const specName = path => path.replace(/^.*[/\\]/, '').replace(/\.spec\.ts$/, '');
export const groupFor = path => Object.keys(groups).find(key => groups[key].includes(specName(path)));

/** Per-spec server environment layered over the shard env; V2 is explicit (true/false), never inherited from the caller. */
export const specEnvironment = path => ({ WORKFLOW_V2_ENABLED: workflowV2Specs.includes(specName(path)) ? 'true' : 'false' });
