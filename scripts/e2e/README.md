Run `node scripts/run-e2e-isolated.mjs --full` for the release-authoritative selection.
No arguments also select full for compatibility. Use `--changed-from <git-ref>`,
`--group A|B|C|D`, or repeat `--spec tests/e2e/name.spec.ts` for focused selection.
`--list` combines with any selection and creates no directories, DBs, listeners or
servers. Its deterministic ports/DB paths are previews; execution allocates and
verifies free ports and uses a unique run UUID. `--shards 1..16` defaults to four
(bounded by selected spec count). `--flag-profile on|off|shadow` defaults to on.
Only a full selection has the release-authoritative label; passing focused tests
does not establish release acceptance even if an impact rule expands to FULL.

The tracked `spec-map.mjs` owns logical impact groups A (actions), B (chat), C (UX)
and D (demo/dynamic). Durations are sums of per-test timings in the supplied
`biztania-track-a-hosted-p1/e2e-int.log`, excluding repeated cold-server overhead.
Longest-first packing, with stable tie breaking, assigns specs to execution shards.
The current full estimates are 153.0, 153.5, 151.2 and 142.8 seconds. Refresh timings
after a real production-mode run. Unmapped specs warn loudly in every plan and
receive a deterministic hash fallback shard in full/explicit-spec selection.

Next 16.3.8's local `dist/docs/01-app/03-api-reference/06-cli/next.md` says dev uses
`.next/dev`, while start requires a production build. `setup-dev-bundler.js` acquires
`<distDir>/lock`; multiple dev servers cannot safely share it. This runner always
builds once, records BUILD_ID, HEAD, commit tree, dirty flag and source-content
digest, then runs one Playwright process and one `next start` per shard concurrently.
It rejects source/build changes during build or tests. A workspace runner lock
prevents two instances; a stale lock fails closed and requires manual investigation.
External builds/dev sessions should not mutate this checkout during execution.
No existing build is silently reused. Next config remains untouched.

Production start removes HMR and changes development diagnostics, caching and
NODE_ENV-dependent behavior (including secure session cookies). Current specs do
not require HMR; the lead must verify production cookie behavior on loopback,
first-paint assertions and cross-spec DB state in the real full sharded run.
Each shard has a fresh validated temporary UUID DB and separate output, traces,
report and log directories. CleanupReporter runs after Playwright server teardown.
Trace attachments are copied to that shard's traces directory; JSON attachments
are updated to their archived paths. Stdout/stderr go to logs/playwright.log.

Impact planning uses merge-base diff `<ref>...HEAD`, staged/unstaged changes and
untracked nonignored files. Docs paths/Markdown skip; dynamic and AI select B+D;
demo selects D+C; components select C (demo-guide also D); core pending-action and
action-revision select A; an E2E spec selects itself. Shared runtime/config/storage,
E2E helpers/infrastructure, manifests/migrations and unknown paths select FULL.
Every changed path prints its matched rule. Git failures fail planning.

Aggregation reads JSON only, cross-checks outcome totals and spec coverage, and
rejects missing/corrupt reports, reporter errors, failed attempts, interrupted or
timed-out tests, bad child exits/signals, unverified startup and cleanup. It waits
for every shard rather than stopping at the first failure. summary.json contains
git/flag/build provenance, counts, shard exits/durations and failing titles/traces.
Startup is an observed HTTP success from the owned Next PID wrapper. Cleanup uses
taskkill /PID /T /F on Windows (process groups elsewhere), then checks owned server
PIDs and port release; an unverified kill cannot produce success. Build/shard
timeouts are five/ten minutes. SIGINT/SIGTERM cancel active children and fail the run.

Dynamic coverage limitation: the flag reaches the server, but service.ts gates
dynamic queries to live_ai; scripted_demo uses runScripted first. The planner calls
getRuntimeSettings in lib/ai/client.ts, which supports only AI_PROVIDER=ninearm and
requires a configured API key. AI_PROVIDER=scripted therefore cannot execute a real
dynamic plan. Product would need an explicitly gated deterministic planner provider
at lib/dynamic/planner/provider.ts (or an injected planner seam in runtime.ts),
selected for E2E while preserving live_ai admission and all plan validation/reader
authorization; merely enabling dynamic for scripted_demo would not supply a planner.
Alternatively a separately authorized real ninearm provider setup is required.
The runner makes no Product/provider change and does not claim dynamic coverage.

Isolation design (validated by the first sharded trial): every spec file gets its own fresh DB
(byte copy of a template seeded once after the build, since first store access costs ~15 s)
and its own `next start`; specs inside a shard run sequentially, shards run concurrently.
`server.mjs` fronts `next start` (inner port) with a pass-through proxy on the shard port that
only strips `Secure` from Set-Cookie (Next production marks the session cookie Secure; Playwright's
request jar drops it over plain http, giving 401s) and answers 503 until a cold-start warm-up
(unauthenticated GET /api/session) completes. Plan-only output prints ports as allocated at run time.
