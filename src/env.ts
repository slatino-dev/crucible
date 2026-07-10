/**
 * Worker binding + var types — the shape the Cloudflare platform injects.
 *
 * Zod-at-the-boundary policy (backend system): runtime values that drive logic are
 * parsed through Zod at first use, not read as bare strings scattered across the
 * codebase. This interface is the injected shape; it is not the trust boundary.
 *
 * SCAFFOLD STATE: the platform surface grows as phases land. R2 (`TRANSCRIPTS`), KV
 * (`AGGREGATE_KV`), Workers AI (`AI`), and the RunOrchestrator + BudgetLedger Durable
 * Object namespaces are added to this interface at Phase 1.3/1.4 (see ARCHITECTURE
 * "System shape").
 */
export interface Env {
  /** D1: the registry + results of record (suites … regressions … audit_log). */
  DB: D1Database;

  /**
   * [SECURITY/Opus] HMAC salt for salted-IP hashing and cursor/badge integrity.
   * A Worker SECRET in production (`wrangler secret put HASH_SALT`), a local value
   * in `.dev.vars`. NEVER in wrangler.toml [vars] or git. Missing salt fails closed.
   */
  HASH_SALT?: string;
}
