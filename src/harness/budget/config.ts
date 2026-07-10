/**
 * [SECURITY/Opus] — BudgetLedger tuning (ARCHITECTURE "Security posture" + "Neuron budget";
 * PORTFOLIO-V2 "Shared Workers AI neuron allocation": Crucible's share is 2,000/day).
 *
 * The daily ceiling is split into named CHANNELS so the public spotlight surface and the
 * nightly cron cannot starve each other: a burst of visitor runs can exhaust the visitor
 * pool without touching the nightly reserve, and vice versa. Their sum is the 2,000/day
 * share (the invariant PORTFOLIO-V2 enforces). Per-call neuron figures are verified at
 * build start against the Workers AI catalog; the ceiling is what the ledger closes against.
 */

/** Crucible's account share (PORTFOLIO-V2). The sum of the channel pools must equal this. */
export const DAILY_NEURON_CEILING = 2000;

/**
 * Channel pools. `visitor` funds the public spotlight live-run (the activation surface);
 * `system` funds the nightly cron + admin/v0.5 passes. Sum = DAILY_NEURON_CEILING.
 */
export const CHANNEL_POOLS = Object.freeze({
  visitor: 1200,
  system: 800,
} as const);
export type BudgetChannel = keyof typeof CHANNEL_POOLS;

/**
 * Per-visitor guaranteed slice of the visitor pool (neurons/day). A single actor cannot
 * consume more than this, so no IP-rotating actor can drain the day's spotlight budget and
 * dark the demo for real recruiters — the availability control the charter names. At
 * ~80 neurons/spotlight-run, 240 funds ~3 runs/visitor and >=5 distinct visitors/day
 * inside the 1,200 visitor pool.
 */
export const PER_VISITOR_DAILY_NEURONS = 240;

/**
 * Rate limits (sliding window). The hardest limits are on the auth + run-trigger surfaces,
 * anchored here in Phase 1 (not deferred), so the deployed admin surface is throttled from
 * first exposure. All are per-IP unless noted; the admin auth surface adds a per-key limit.
 */
export const RATE_LIMITS = Object.freeze({
  /** Public spotlight run-trigger, per salted IP. */
  runTrigger: { limit: 5, windowMs: 60_000 },
  /** Admin bearer-auth attempts, per salted IP (hardest — brute-force friction). */
  adminAuthPerIp: { limit: 5, windowMs: 60_000 },
  /** Admin bearer-auth attempts, per presented key hash (a valid key still can't hammer). */
  adminAuthPerKey: { limit: 10, windowMs: 60_000 },
});

/** UTC calendar day (YYYY-MM-DD) — the reset boundary is 00:00 UTC by key, not by timer. */
export function utcDay(nowMs: number = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}
