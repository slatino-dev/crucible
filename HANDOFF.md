# HANDOFF — Crucible

> Session close: Phase 0 complete + Phase 1 items 1-4 complete, all with evidence. Written
> for the next session to resume from files. Repo: https://github.com/slatino-dev/crucible
> (public). Live: https://crucible.samlatino.dev. Model: this work is Opus 4.8 (incl. all
> security items, which are Opus-owned).

## State: what is done (with evidence)

### Phase 0 — Foundation — DONE (gate: CI green on hello-world Worker)
- Repo `slatino-dev/crucible` public from the first commit; branch `main` is default.
- Scaffold copied from the Conduit template: vitest-pool-workers (miniflare = real runtime),
  tsconfig, eslint, drizzle config, `.github/workflows/ci.yml` (types/lint/unit + dep-audit +
  gitleaks on push; wrangler deploy on main, guarded on the `CLOUDFLARE_API_TOKEN` secret).
- `analytics/events.ts`: typed plan with the `live_run_completed` activation event, the
  ordered funnel `arena_viewed → live_run_started → live_run_completed → repo_clicked`, and
  `score_provenance_opened` as a parallel engagement event.
- `DESIGN.md` + `src/styles/theme.css`: consumes Conduit's ratified Signal Path token base
  UNCHANGED (`[LAB BASE]`), overrides only the furnace-ember accent `OKLCH(0.72 0.16 55)` +
  ember chart primary series (`[CRUCIBLE OVERRIDE]`). Five designed states documented.
- `docs/research/oss-decisions.md`: promptfoo embed-vs-study → **STUDY** (runtime mismatch;
  the harness is the differentiator). License verified **MIT at commit a3114835** (2026-07-10).
- Free-tier limits re-verified at build start (2026-07-10) and recorded in `ARCHITECTURE.md`,
  including the material correction: the free plan's subrequest cap is **50 external + 1,000
  internal** (D1/KV/R2/Workers AI are internal), so v1 batch sizing is bound by 1,000, not 50.
- **Evidence:** CI run success `github.com/slatino-dev/crucible/actions/runs/29104764233`;
  deployed hello-world, `curl /healthz` → 200 with the full security-header set.

### Phase 1.1 — D1 schema + migrations — DONE
- `src/db/schema.ts`: all 14 entities from `docs/eval-harness.md` (suites, suite_versions,
  cases, targets, judges, runs, case_results, scores, comparisons, aggregates, baselines,
  regressions, api_keys, audit_log). ULID ids; UTC ISO-8601 times; typed JSON columns; NOT-NULL
  provenance refs; unique constraints (suite content hash, run×case×trial, baseline per
  suite×target). `src/util/ids.ts`: ulid + canonical hash + HMAC.
- Provisioned D1 `crucible` (`b7835a1a-0b8a-43c5-b404-3d657f7eab46`); migration `0000_init.sql`.
- **Evidence:** migration applies clean (33 commands) local AND remote; remote D1 has all 14
  tables (queried this session); `test/db-schema.test.ts` (3 tests) exercises the full chain +
  FK/unique enforcement.

### Phase 1.2 — Stats module — DONE (built FIRST, pure functions)
- `src/harness/stats/`: bootstrap 95% CIs resampled over cases with clustered-trial treatment
  (arXiv 2411.00640); paired-per-case test (exact Student-t via incomplete beta); rank-banding;
  win-rate-vs-anchor; Benjamini-Hochberg FDR; seeded mulberry32 PRNG.
- **Evidence:** `test/golden/` — 19 tests (14 golden vs hand-computed values incl. df=1/t=1 →
  p=0.5 and diffs=[1,2,3,4] → t=3.873/p≈0.0305; BH; rank bands; + 5 property tests: CI narrows
  with n, paired test symmetric, BH monotone). `npm run stats:golden`.

### Phase 1.3 — RunOrchestrator DO + BudgetLedger DO — DONE [SECURITY/Opus]
- `src/harness/budget/ledger.ts` (BudgetLedger DO): daily neuron ceiling (2,000/day share)
  split into visitor/system channel pools, per-visitor daily slice, per-IP/per-key
  sliding-window rate limits — ALL in DO SQLite, never KV. reserve → reconcile; reset by UTC
  day key. `src/security/client-id.ts`: salted-IP + signed-visitor-token helpers.
- `src/harness/orchestrator/run.ts` (RunOrchestrator DO): SQLite state machine + alarm engine;
  reserves budget before each dispatch batch; R2 content-addressed transcripts; batched
  idempotent D1 writes; finalize → pass-rate bootstrap-CI aggregate. Structural exact-match
  scorer + `mock` provider = full no-model fixture path. Concurrency-hardened: claimed/done
  split, per-item neuron accounting paired with `done`, stale-claim reclaim, idempotent inserts.
- Provisioned R2 `crucible-transcripts` + KV `AGGREGATE_KV`.
- **Evidence:** 7 BudgetLedger security tests + `test/eval-smoke.test.ts` (end-to-end: 12
  case×trial mock run → scored, 60 neurons, 12 R2 objects, `pass_rate=0.75` aggregate with CI).

### Phase 1.4 — llm_judge scorer + admin auth — DONE [SECURITY/Opus]
- `src/harness/judge/pairwise.ts`: anchored pairwise + position swap + k-sampling; all three
  arXiv 2306.05685 biases mitigated (position swap, verbosity prompt rule, self-preference
  flag); injection-hardened (delimited data regions + delimiter escaping + constrained Zod
  verdict + bounded retry → unscoreable). AI runner injected for testing.
- `src/security/admin-auth.ts` + `src/security/middleware.ts`: argon2id bearer keys
  (`ck_<id>.<secret>`, PHC-encoded, uniform errors, dummy-verify timing equalization);
  rate-limit + admin middleware on the BudgetLedger, fail-closed, rate-check before argon2.
  Wired `/api/run` (rate-limited) + `/api/admin/ping` (argon2-guarded).
- **Evidence:** 8 judge tests + 7 admin-auth tests. **Live curl on crucible.samlatino.dev:**
  `/healthz`→200, `/api/admin/ping`→401, `/api/run` → 5×202 then 429 with `RateLimit-Remaining`
  counting down. Deployed version `86e40d0d`; `HASH_SALT` secret set in prod.

**Full suite: 48/48 tests pass; typecheck + eslint clean. CI green on every push to main.**

## What is next (Phase 1 items 5-8, then Phase 1.5 / Phase 2)
1. **Wire the orchestrator's PAIRWISE path** (item 4 remainder / item 5): the judge module is
   built + tested, but the RunOrchestrator only runs the `structural` scorer path today. Next:
   a pairwise run mode that pairs candidate + anchor CaseResults over the shared
   suite_version_hash (via `anchor_run_id`), calls `judgePairwise` with an env.AI adapter,
   writes `Comparison` rows, and finalizes with win-rate-vs-anchor. Then item 5's real run:
   ONE judged instruction-following suite, 3 Workers AI targets (1 anchor), n_trials≥3, via
   CLI/API (no public button).
2. **Item 6:** the honest chart — a static SVG CI-whisker render (custom component, chart
   tokens, NOT Recharts) of 3 targets with click-through to R2 transcripts.
3. **Item 7 remainder [SECURITY]:** admin key CREATION/rotation CLI + the audit_log writes on
   privileged actions (schema + middleware exist; the suite-publish/baseline-pin handlers that
   write audit rows are not built yet).
4. **Item 8:** the induced A/B variant-diff demo (labeled induced) proving the paired gate fires.
5. Then Phase 1.5 (structural tool-call suite) and Phase 2 (public spotlight SSE, calibration,
   regression timeline, SPA, render-boundary CSP).

## Residuals / decisions for Sam
- **CI auto-deploy needs a secret.** The deploy job no-ops (green) until Sam adds the
  `CLOUDFLARE_API_TOKEN` repo secret (Workers Scripts:Edit + D1:Edit). Deploys this session were
  done locally via authenticated wrangler. A CI runner cannot mint the token.
- **argon2id vs the 10ms free CPU limit.** Admin verify is pure-JS argon2id (m=2 MiB) and may
  exceed 10ms CPU on a cold path; acceptable for the rare CLI admin surface (Cloudflare allows
  brief bursts). Documented escalation if it bites: HMAC-SHA256 over the high-entropy secret
  (cryptographically sufficient for 256-bit random keys). Sam's call whether to keep argon2id.
- **Static assets bypass the Worker.** Cloudflare serves `public/` at the edge, so the SPA HTML
  will NOT get the Worker's security headers by default — Phase 2 render-boundary hardening
  needs `run_worker_first` or Worker-served HTML for the CSP.
- **License / accent coherence** still flagged: Apache-2.0 pending Sam's ratification; the ember
  accent is flagged for the lab-wide coherence pass (vs Conduit cyan / siblings TBD).
- `wrangler.test.toml` mirrors `wrangler.toml` minus `[ai]` (no local AI emulation → CI would
  need a Cloudflare login). Keep the two in sync when bindings change.

## Runbook
`npm test` · `npm run stats:golden` · `npm run eval:smoke` · `npm run typecheck` · `npm run lint`
· `npm run migrate` (local) · `npx wrangler d1 migrations apply crucible --remote` (prod schema)
· `npx wrangler deploy` (local authed deploy).
