# Wave 4 monitoring integration (not wired)

Entry: `runMonitorPlan({request, context, state?}) -> Result<MonitorOutput>`.
One condition: `sales_below_target`, comparing evidenced per-branch net sales to
evidenced positive targets with a user-approved ratio in (0,1]. Only hourly cadence
and one-hour cooldown are registered. The ratio is configuration, not a generated
business fact. Query refs pin `branch_performance`, exact regions and branch IDs.

Lead hook: add `monitor.prepare_plan` to the tool broker in
`ConciergeService.turn`, gated by `BIZTANIA_DYNAMIC_EFFECTS=on` (off by default). Preview shows recipient names/refs, threshold, cadence, cooldown and exact
claim content. Route service `confirm`/execution/`reconcile` to the four installation
phases and persist immutable workflow + current monitor state. Verify reads the
persisted executed installation; tests implement this with returned server state.
Lifecycle API pause/resume passes a server-loaded monitor and expected state version
to the reducer, then uses a storage CAS. Never accept client-supplied state.

Scheduling proposal: lead adds a protected Vercel Cron route (e.g.
`/api/cron/dynamic-monitors`) and an hourly `vercel.json` schedule; neither is added
here. Authenticate the route with a server secret, bound monitor batches/time,
reload actor, consent, recipient authorization, registered query and evidence on
every tick, then call `evaluate` with exact evidence ref. CAS evaluated state,
high-water observation time, alert history and an outbox candidate together.
On conflict reload and reevaluate. A deployment Cron lease/unique outbox key must
prevent duplicate dispatch across retries; do not interpret local CAS as a lease.

Evaluation is pure and produces an alert candidate only. It never sends. Any alert
delivery must get current grounded claims, preview its exact new content/recipients
and use the communication consent + confirmation lifecycle; existing consent for
old facts cannot approve changed facts. For fully automatic future alert delivery,
the owner must design/approve a separately registered bounded template-consent
policy; this module grants no such authority. Expired/revoked consent, stale content
evidence or changed immutable versions hold the monitor pending a fresh approved
plan. Lead owns that renewal UX.

Budgets: 1000 exact branches, 20 recipients, 32 claims, 64 history entries, hourly
evaluation/cooldown. A monotonic observedAt high-water mark rejects old samples even
after history eviction. Missing/partial/untrusted/mis-scoped or nonfinite evidence
cannot trigger an alert; equal-to-threshold sales do not trigger. Fresh evidence
snapshots must carry adapter-certified observedAt and full approved branch coverage.
No scheduler, storage adapter, migration, flag wiring or UI is implemented here.

## Wiring requirements

- Installation execute is a no-op in the pure module; at wiring time verify must read back the persisted monitor row independently.


## Live wiring (Track B lane C)

Monitors run on the daily external scheduler (`app/api/cron/monitors`, protected by CRON_SECRET). Each tick re-reads owner and every approved recipient inside the alert transaction, then delivers the alert to the owner and each approved recipient's own simulated inbox (idempotent per dedupe key + recipient). Every evaluation is persisted on the monitor row (`evaluations`, bounded to 30) and listed through `GET /api/monitors`; pause/resume/delete stay CAS operations.
