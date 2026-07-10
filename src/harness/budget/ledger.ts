import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../env";
import { ulid } from "../../util/ids";
import {
  CHANNEL_POOLS,
  PER_VISITOR_DAILY_NEURONS,
  utcDay,
  type BudgetChannel,
} from "./config";

/**
 * [SECURITY/Opus] — BudgetLedger: the single serialized cost/rate-limit substrate
 * (ARCHITECTURE "Security posture"). ONE named instance ("global") is authoritative for:
 *   1. the daily Workers AI neuron ceiling (Crucible's 2,000/day share), split into
 *      channel pools so visitor runs and the nightly cron cannot starve each other;
 *   2. the per-visitor daily slice (an availability control: no IP-rotating actor can
 *      drain the spotlight budget and dark the demo);
 *   3. per-IP / per-key sliding-window rate limits on the auth + run-trigger surfaces.
 *
 * ALL counters live in THIS DO's SQLite storage — NEVER KV (KV's 1,000-writes/day +
 * 1-write/sec/key free caps cannot carry a per-dispatch ledger). The DO is single-threaded,
 * so reserve → (dispatch) → reconcile is serialized and concurrent runs cannot race past
 * the ceiling. The daily reset is by DAY KEY (00:00 UTC), not a timer: a new day simply has
 * no row and reads 0; stale rows are pruned opportunistically.
 *
 * `nowMs` is injectable on every method so tests are deterministic; production passes none
 * and gets Date.now().
 */
export interface ReserveResult {
  ok: boolean;
  reason?: "pool_exhausted" | "visitor_exhausted";
  channel: BudgetChannel;
  reservationId?: string;
  /** Neurons already spent in this channel today (before this reserve). */
  spentToday: number;
  /** The channel's pool ceiling. */
  pool: number;
  /** Neurons remaining in the channel after this reserve (0 when denied for pool). */
  remaining: number;
}

export interface RateDecision {
  ok: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
  retryAfterSeconds: number;
}

export class BudgetLedger extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS daily (
           day TEXT NOT NULL, channel TEXT NOT NULL, neurons INTEGER NOT NULL DEFAULT 0,
           PRIMARY KEY (day, channel)
         );`,
      );
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS visitor (
           day TEXT NOT NULL, vkey TEXT NOT NULL,
           neurons INTEGER NOT NULL DEFAULT 0, runs INTEGER NOT NULL DEFAULT 0,
           PRIMARY KEY (day, vkey)
         );`,
      );
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS rl (bucket TEXT NOT NULL, ts INTEGER NOT NULL);`,
      );
      this.sql.exec(`CREATE INDEX IF NOT EXISTS rl_bucket_idx ON rl (bucket, ts);`);
    });
  }

  private scalar(query: string, ...binds: unknown[]): number {
    const rows = this.sql.exec(query, ...binds).toArray();
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) return 0;
    const v = Object.values(row)[0];
    return typeof v === "number" ? v : Number(v ?? 0);
  }

  /**
   * Reserve `neurons` in `channel` (debits the ledger up front — the batch runs only if it
   * fits). Enforces the channel pool ceiling AND, for the `visitor` channel, the per-visitor
   * daily slice. Serialized by the single-threaded DO so concurrent runs cannot overshoot.
   */
  async reserve(args: {
    channel: BudgetChannel;
    neurons: number;
    visitorKey?: string;
    nowMs?: number;
  }): Promise<ReserveResult> {
    const { channel, neurons } = args;
    const nowMs = args.nowMs ?? Date.now();
    const day = utcDay(nowMs);
    const pool = CHANNEL_POOLS[channel];
    this.pruneStaleDays(day);

    const spent = this.scalar(`SELECT neurons FROM daily WHERE day = ? AND channel = ?`, day, channel);
    if (spent + neurons > pool) {
      return { ok: false, reason: "pool_exhausted", channel, spentToday: spent, pool, remaining: Math.max(0, pool - spent) };
    }

    if (channel === "visitor" && args.visitorKey) {
      const vSpent = this.scalar(`SELECT neurons FROM visitor WHERE day = ? AND vkey = ?`, day, args.visitorKey);
      if (vSpent + neurons > PER_VISITOR_DAILY_NEURONS) {
        return { ok: false, reason: "visitor_exhausted", channel, spentToday: spent, pool, remaining: Math.max(0, pool - spent) };
      }
    }

    this.sql.exec(
      `INSERT INTO daily (day, channel, neurons) VALUES (?, ?, ?)
       ON CONFLICT (day, channel) DO UPDATE SET neurons = neurons + excluded.neurons`,
      day,
      channel,
      neurons,
    );
    if (args.visitorKey) {
      this.sql.exec(
        `INSERT INTO visitor (day, vkey, neurons, runs) VALUES (?, ?, ?, 1)
         ON CONFLICT (day, vkey) DO UPDATE SET neurons = neurons + excluded.neurons, runs = runs + 1`,
        day,
        args.visitorKey,
        neurons,
      );
    }
    return { ok: true, channel, reservationId: ulid(nowMs), spentToday: spent, pool, remaining: pool - (spent + neurons) };
  }

  /**
   * Reconcile a reservation against the response's reported usage: apply the signed delta
   * (`actualNeurons - reservedNeurons`) to the channel (and visitor) counters, clamped at 0.
   * Over-estimates release headroom; under-estimates draw it down honestly.
   */
  async reconcile(args: {
    channel: BudgetChannel;
    reservedNeurons: number;
    actualNeurons: number;
    visitorKey?: string;
    nowMs?: number;
  }): Promise<{ delta: number; spentToday: number }> {
    const nowMs = args.nowMs ?? Date.now();
    const day = utcDay(nowMs);
    const delta = args.actualNeurons - args.reservedNeurons;
    this.sql.exec(
      `UPDATE daily SET neurons = MAX(0, neurons + ?) WHERE day = ? AND channel = ?`,
      delta,
      day,
      args.channel,
    );
    if (args.visitorKey) {
      this.sql.exec(
        `UPDATE visitor SET neurons = MAX(0, neurons + ?) WHERE day = ? AND vkey = ?`,
        delta,
        day,
        args.visitorKey,
      );
    }
    return { delta, spentToday: this.scalar(`SELECT neurons FROM daily WHERE day = ? AND channel = ?`, day, args.channel) };
  }

  /**
   * Sliding-window rate check for `bucket` (exact log, no window-boundary burst). Emits the
   * IETF RateLimit-* fields. Registers the hit on admit; a denied call does NOT consume a slot.
   */
  async rateCheck(args: { bucket: string; limit: number; windowMs: number; nowMs?: number }): Promise<RateDecision> {
    const nowMs = args.nowMs ?? Date.now();
    const { bucket, limit, windowMs } = args;
    const cutoff = nowMs - windowMs;
    this.sql.exec(`DELETE FROM rl WHERE bucket = ? AND ts <= ?`, bucket, cutoff);
    const count = this.scalar(`SELECT COUNT(*) FROM rl WHERE bucket = ?`, bucket);

    if (count >= limit) {
      const oldest = this.scalar(`SELECT MIN(ts) FROM rl WHERE bucket = ?`, bucket);
      const retry = Math.max(1, Math.ceil((oldest + windowMs - nowMs) / 1000));
      return { ok: false, limit, remaining: 0, resetSeconds: retry, retryAfterSeconds: retry };
    }
    this.sql.exec(`INSERT INTO rl (bucket, ts) VALUES (?, ?)`, bucket, nowMs);
    return {
      ok: true,
      limit,
      remaining: Math.max(0, limit - (count + 1)),
      resetSeconds: Math.ceil(windowMs / 1000),
      retryAfterSeconds: 0,
    };
  }

  /** Observability: spend per channel for a day (default today). No PII. */
  async stats(args: { nowMs?: number } = {}): Promise<{ day: string; channels: Record<string, { spent: number; pool: number }> }> {
    const day = utcDay(args.nowMs ?? Date.now());
    const channels: Record<string, { spent: number; pool: number }> = {};
    for (const channel of Object.keys(CHANNEL_POOLS) as BudgetChannel[]) {
      channels[channel] = {
        spent: this.scalar(`SELECT neurons FROM daily WHERE day = ? AND channel = ?`, day, channel),
        pool: CHANNEL_POOLS[channel],
      };
    }
    return { day, channels };
  }

  /** Drop counter rows from earlier days (the reset is by key; this just reclaims space). */
  private pruneStaleDays(today: string): void {
    this.sql.exec(`DELETE FROM daily WHERE day < ?`, today);
    this.sql.exec(`DELETE FROM visitor WHERE day < ?`, today);
    this.sql.exec(`DELETE FROM rl WHERE ts <= ?`, Date.parse(`${today}T00:00:00Z`) - 86_400_000);
  }
}
