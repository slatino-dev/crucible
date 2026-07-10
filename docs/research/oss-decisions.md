# OSS decisions: Crucible

> Fork-first per the warehouse discipline. Each row: license tier (verified at the commit),
> what it permits HERE, integration mode, runners-up. Licenses re-checked at adoption commit,
> not from memory.

## Adopt (embed, permissive)
| Project | License (verified at commit) | What it permits here | Mode | Runners-up |
|---|---|---|---|---|
| Hono | MIT (verify at commit) | Worker HTTP framework, routing, middleware for /api /gate /badge | embed | itty-router (thinner, less middleware) |
| drizzle-orm | Apache-2.0 (verify at commit) | D1 schema + versioned migrations; SQL-transparent, edge-ready | embed | Prisma (heavier on Workers) |
| Zod | MIT (verify at commit) | Validation at every boundary incl. judge output + LLM responses; schemas are the single source for validation + types | embed | valibot (smaller, less ecosystem) |
| @noble/hashes | MIT (verify at commit) | argon2id for admin bearer-key hashing at rest (Phase 1.4) — pure-JS, workerd-portable, no native/WASM dep | embed | hash-wasm (WASM; heavier bundle), PBKDF2 via WebCrypto (fast but not memory-hard) |
| shadcn/ui + TanStack Table + Streamdown | MIT (verify at commit) | Leaderboard / case grids (right-aligned tabular figures, sticky headers) + streamed judge rationales, restyled through Signal Path tokens | embed | assistant-ui (heavier); hand-built table (rejected: reinvents the wheel) |

## Decide at build (record outcome here)
- **promptfoo (github.com/promptfoo/promptfoo) — embed vs study** for the eval harness.
  promptfoo is the PRD's fork-first candidate and the reference proof that eval-harness
  demand exists.
  - **License verified at commit (2026-07-10):** **MIT**, confirmed by reading the LICENSE
    at commit `a3114835a073fe14427d648fe11be094aae06fbe` (default branch `main`,
    pushed 2026-07-10T13:51:59Z) — GitHub SPDX id `MIT`, LICENSE header
    "Copyright (c) Promptfoo 2025 ... Permission is hereby granted, free of charge ...".
    No `ee/` or `enterprise/` directory at the repo root at that commit, so the whole tree
    is under the single MIT grant (no relicensed enterprise carve-out to avoid). MIT is a
    permissive tier — embeddable freely with attribution.
  - **OUTCOME — STUDY, not embed (with a narrow dev/CI embed option).** Rationale:
    - **Runtime mismatch is decisive.** promptfoo is a Node CLI/library: it spawns a Node
      process, reads a local YAML config, and calls provider SDKs over the network. Crucible
      scores *inside a Durable Object on workerd* (ARCHITECTURE: stats + orchestration run in
      the DO, never the 10ms Worker path), against the Workers AI binding, with D1/R2 as the
      results of record. promptfoo does not run in that runtime and its execution model
      (process-per-run, filesystem config) is the opposite of the DO state-machine Crucible
      needs. Embedding its runtime is not viable on the free-tier platform.
    - **The harness IS the differentiator, not a generic capability.** The value Crucible
      sells — bootstrap CIs resampled over cases, the paired-per-case test (arXiv 2411.00640),
      anchored pairwise with position-swap + k-sampling, rank-banding, BH-FDR nightly
      correction, and NOT-NULL provenance to a stored artifact — is exactly what promptfoo
      does NOT do (it reports point pass-rates without CIs or a judge-bias program; that gap
      is the PRD's whole thesis). Forking it would mean deleting its core and keeping its
      config surface — negative leverage.
    - **What we STUDY (read, never copy code):** promptfoo's assertion/scorer *taxonomy*
      (`equals`, `contains`, `is-json`, `javascript`, `llm-rubric`, `factuality`) as prior art
      for Crucible's structural scorer family (callcheck heritage, Phase 1.5); its
      `llm-rubric` / model-graded judge *prompt shapes* as reference for the pairwise judge
      prompt (Phase 1.4); its config ergonomics as a foil for the in-repo suite-authoring
      format. These inform design; none of its code enters this Apache-licensed repo.
    - **Narrow embed option kept open (dev/CI only, not runtime):** if a CI-side golden
      harness ever wants promptfoo as a dev dependency to cross-check Crucible's own scores
      against a second implementation, its MIT license permits that as a devDependency that
      never ships in the Worker bundle. Recorded as available, not adopted; revisit at Phase 2
      calibration if a second-opinion oracle is wanted.

## Study only (NEVER copy code)
- **promptfoo** — MIT, but STUDY here for the runtime reason above (taxonomy + judge-prompt
  prior art). A dev/CI embed is separately permitted if ever wanted.
- **LiveBench / LiveCodeBench** — study the contamination-resistant, objective-ground-truth
  approach that needs no judge (grounds Crucible's "structural suites always headline"
  fallback). Public methodology only.
- **Chatbot Arena / LMArena** — study what NOT to do (the distortions documented in
  arXiv 2504.20879); no code.
- **OpenAI Evals / lm-evaluation-harness / DeepEval** — study suite/scorer shapes; wrong
  runtime for embed.

## Build (differentiator, not forked)
The pure stats module (bootstrap CIs, paired test, rank-banding, clustered trials, win-rate,
BH-FDR), the RunOrchestrator + BudgetLedger Durable Objects, the anchored-pairwise judge
loop with position-swap + k-sampling, the provenance-enforced D1 schema, the custom SVG
CI-whisker / tie-band / live-assay-line components, and the `@crucible/harness` package
contract Basilisk consumes. These are the product; they are not generic.

## License firewall note
Crucible ships Apache-2.0 (pending Sam's ratification — adoption is the moat, patent grant
preferred over MIT per warehouse discipline). No AGPL/GPL code enters the repo. Model weights
are not shipped (Workers AI is a hosted service call). Attribution preserved per each
embedded project's license.
