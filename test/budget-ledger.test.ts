import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { CHANNEL_POOLS, PER_VISITOR_DAILY_NEURONS } from "../src/harness/budget/config";

/**
 * [SECURITY/Opus] BudgetLedger DO — the serialized cost/rate-limit substrate. Exercised
 * through its RPC surface against real miniflare DO SQLite storage. `nowMs` injection makes
 * the daily reset and sliding windows deterministic.
 */
function ledger(name: string) {
  return env.BUDGET_LEDGER.get(env.BUDGET_LEDGER.idFromName(name));
}
const DAY = Date.parse("2026-07-10T12:00:00Z");

describe("BudgetLedger — daily neuron ceiling", () => {
  it("reserves within the channel pool and denies once the pool is exhausted", async () => {
    const l = ledger("ceiling-1");
    const pool = CHANNEL_POOLS.system;
    const first = await l.reserve({ channel: "system", neurons: pool - 10, nowMs: DAY });
    expect(first.ok).toBe(true);
    expect(first.remaining).toBe(10);

    const second = await l.reserve({ channel: "system", neurons: 10, nowMs: DAY });
    expect(second.ok).toBe(true);
    expect(second.remaining).toBe(0);

    const denied = await l.reserve({ channel: "system", neurons: 1, nowMs: DAY });
    expect(denied.ok).toBe(false);
    expect(denied.reason).toBe("pool_exhausted");
  });

  it("resets by UTC day key: the next day starts fresh", async () => {
    const l = ledger("reset-1");
    await l.reserve({ channel: "visitor", neurons: CHANNEL_POOLS.visitor, nowMs: DAY });
    const sameDay = await l.reserve({ channel: "visitor", neurons: 1, nowMs: DAY });
    expect(sameDay.ok).toBe(false);

    const nextDay = Date.parse("2026-07-11T00:00:01Z");
    const fresh = await l.reserve({ channel: "visitor", neurons: 80, nowMs: nextDay });
    expect(fresh.ok).toBe(true);
  });

  it("channel pools are independent (visitor spend does not touch the system pool)", async () => {
    const l = ledger("channels-1");
    await l.reserve({ channel: "visitor", neurons: CHANNEL_POOLS.visitor, nowMs: DAY });
    const system = await l.reserve({ channel: "system", neurons: 100, nowMs: DAY });
    expect(system.ok).toBe(true);
  });
});

describe("BudgetLedger — per-visitor slice (availability control)", () => {
  it("caps a single visitor so one actor cannot drain the spotlight pool", async () => {
    const l = ledger("visitor-1");
    const vkey = "v:abc";
    const ok = await l.reserve({ channel: "visitor", neurons: PER_VISITOR_DAILY_NEURONS, visitorKey: vkey, nowMs: DAY });
    expect(ok.ok).toBe(true);
    const denied = await l.reserve({ channel: "visitor", neurons: 1, visitorKey: vkey, nowMs: DAY });
    expect(denied.ok).toBe(false);
    expect(denied.reason).toBe("visitor_exhausted");

    // A DIFFERENT visitor still gets their own slice — the pool is not exhausted.
    const other = await l.reserve({ channel: "visitor", neurons: 80, visitorKey: "v:xyz", nowMs: DAY });
    expect(other.ok).toBe(true);
  });
});

describe("BudgetLedger — reconcile", () => {
  it("applies the signed delta between reserved and actual usage", async () => {
    const l = ledger("reconcile-1");
    await l.reserve({ channel: "system", neurons: 100, nowMs: DAY });
    // Actual came in lower than reserved → release 40 neurons of headroom.
    const r = await l.reconcile({ channel: "system", reservedNeurons: 100, actualNeurons: 60, nowMs: DAY });
    expect(r.delta).toBe(-40);
    const stats = await l.stats({ nowMs: DAY });
    expect(stats.channels.system!.spent).toBe(60);
  });
});

describe("BudgetLedger — sliding-window rate limit", () => {
  it("admits up to the limit, denies over it, and recovers after the window", async () => {
    const l = ledger("rate-1");
    const bucket = "runTrigger:ip:hash";
    for (let i = 0; i < 5; i++) {
      const d = await l.rateCheck({ bucket, limit: 5, windowMs: 60_000, nowMs: DAY + i });
      expect(d.ok).toBe(true);
    }
    const over = await l.rateCheck({ bucket, limit: 5, windowMs: 60_000, nowMs: DAY + 6 });
    expect(over.ok).toBe(false);
    expect(over.retryAfterSeconds).toBeGreaterThan(0);

    // After the window fully elapses, the bucket recovers.
    const later = await l.rateCheck({ bucket, limit: 5, windowMs: 60_000, nowMs: DAY + 61_000 });
    expect(later.ok).toBe(true);
  });

  it("a denied request does not consume a slot (no self-inflicted lockout extension)", async () => {
    const l = ledger("rate-2");
    const bucket = "auth:ip:hash";
    for (let i = 0; i < 5; i++) await l.rateCheck({ bucket, limit: 5, windowMs: 60_000, nowMs: DAY + i });
    // Two denials while over the limit.
    await l.rateCheck({ bucket, limit: 5, windowMs: 60_000, nowMs: DAY + 10 });
    await l.rateCheck({ bucket, limit: 5, windowMs: 60_000, nowMs: DAY + 20 });
    // The oldest hit is at DAY+0, so at DAY+60_000 exactly one slot frees up.
    const recover = await l.rateCheck({ bucket, limit: 5, windowMs: 60_000, nowMs: DAY + 60_001 });
    expect(recover.ok).toBe(true);
  });
});
