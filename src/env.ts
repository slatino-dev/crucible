/**
 * Worker binding + var types — the shape the Cloudflare platform injects.
 *
 * Zod-at-the-boundary policy (backend system): runtime values that drive logic are
 * parsed through Zod at first use, not read as bare strings scattered across the
 * codebase. This interface is the injected shape; it is not the trust boundary.
 *
 */
import type { BudgetLedger } from "./harness/budget/ledger";
import type { RunOrchestrator } from "./harness/orchestrator/run";

export interface Env {
  /** D1: the registry + results of record (suites … regressions … audit_log). */
  DB: D1Database;

  /** R2: content-addressed judge transcripts + raw model outputs (D1 holds only refs). */
  TRANSCRIPTS: R2Bucket;

  /** KV: read-heavy leaderboard aggregate cache ONLY — never a counter. */
  AGGREGATE_KV: KVNamespace;

  /** Workers AI: targets + judges. Self-metered against the 2,000-neuron/day share. */
  AI: Ai;

  /**
   * [SECURITY/Opus] BudgetLedger DO — single named instance; the serialized cost/rate-limit
   * substrate (global daily neurons, per-visitor slices, per-key/IP rate limits) in DO
   * SQLite storage, never KV.
   */
  BUDGET_LEDGER: DurableObjectNamespace<BudgetLedger>;

  /** RunOrchestrator DO — one instance per run; the SQLite state machine + alarm engine. */
  RUN_ORCHESTRATOR: DurableObjectNamespace<RunOrchestrator>;

  /**
   * [SECURITY/Opus] HMAC salt for salted-IP hashing and cursor/badge integrity.
   * A Worker SECRET in production (`wrangler secret put HASH_SALT`), a local value
   * in `.dev.vars`. NEVER in wrangler.toml [vars] or git. Missing salt fails closed.
   */
  HASH_SALT?: string;
}
