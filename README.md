# Crucible

**The leaderboard that shows its error bars.**

A public LLM evals arena on Cloudflare's free tier: bias-mitigated LLM-as-judge, bootstrap
95% confidence intervals on every headline score, honest rank-band leaderboards (strict
ranks only where intervals separate), full click-through transcript provenance, and
regression gates. Every number resolves to the stored artifact it came from — retractions
are impossible by construction.

Public leaderboards are broadly distrusted and the distrust is documented. Live open boards
(LiveBench and kin) beat *contamination* but not *uncertainty*: none publishes confidence
intervals, runs a documented judge-bias program, or exposes click-through provenance and
regression gates. That combination is Crucible.

> Status: Phase 0 -> Phase 1 (v0.5 harness core). Not yet launched. See `BUILD-PLAN.md`.

## What makes it honest
- **Error bars, not point scores.** Every headline number carries a bootstrap 95% CI
  resampled over cases as the primary unit; repeated trials use the clustered treatment of
  [arXiv 2411.00640](https://arxiv.org/abs/2411.00640) so they never inflate apparent
  precision.
- **Rank bands.** A strict rank between two models is shown only when their 95% CIs do not
  overlap; overlapping models render as a tie-band at the same rank.
- **Bias-mitigated judging.** Anchored pairwise (every candidate vs one fixed anchor, O(M)
  not O(M squared)) with mandatory position-swap (win only if preferred in both orders),
  a self-preference family rule, and a verbosity/length covariate check at calibration.
- **Provenance is a NOT-NULL constraint.** Every score and comparison references a stored R2
  artifact; aggregates are computed only from rows that carry that reference. No hand-settable
  number exists anywhere in the schema.
- **Regression gates with multiple-comparisons control.** Nightly re-runs are treated as a
  growing family of tests; a regression publishes only after a Benjamini-Hochberg FDR
  correction, a minimum effect size, and a confirmation re-run. An unconfirmed hit is shown
  as unconfirmed, never as a regression.

## Platform
One Cloudflare Worker (Hono + Zod), a RunOrchestrator Durable Object per run as the execution
engine, a single BudgetLedger Durable Object as the serialized cost/rate-limit substrate, D1
(drizzle-orm, versioned migrations) as the registry and results of record, R2 for transcripts,
KV as a read-only aggregate cache, and Workers AI for targets and judges. No Queues, no Docker
— DO alarms are the scheduling substrate. Everything runs inside the account's free-tier
allocation; the design closes against Crucible's 2,000-neuron/day share (see `ARCHITECTURE.md`).

## The harness is a consumable contract
`@crucible/harness` (the `RunOrchestrator` DO, the drizzle schema + migrations, the scorer
plugin interface, and the pure stats module) is a versioned package. Basilisk (the sibling
agent-security project) installs it unchanged in its own Worker to score OWASP Agentic Top 10
suites. The contract lives in [`docs/eval-harness.md`](docs/eval-harness.md) and freezes at
v1.0 with Basilisk sign-off as a release gate.

## Develop
```bash
npm install
npm run dev          # wrangler dev (local D1 / DO / R2)
npm test             # vitest-pool-workers (miniflare D1/DO/R2 are the real runtime)
npm run typecheck
npm run lint
npm run migrate      # apply versioned D1 migrations to the local DB
npm run stats:golden # stats module golden tests vs hand-computed values
npm run eval:smoke   # deterministic fixture suite (mock AI binding) — full pipeline, no model calls
```

CI runs types / lint / unit + a migration check + a dependency audit on every push, and
deploys to `crucible.samlatino.dev` on `main`.

## License
Apache-2.0 (see `LICENSE` / `NOTICE`) — proposed in the PRD, pending Sam's ratification.
Crucible is not affiliated with any model provider; leaderboard figures are its own measured
results with stated methodology and error bars.
