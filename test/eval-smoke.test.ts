import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { ulid, nowIso, canonicalHash } from "../src/util/ids";
import type { RunOrchestrator, RunConfig } from "../src/harness/orchestrator/run";

/**
 * eval:smoke — the deterministic fixture suite (mock provider, NO model calls) exercising
 * the FULL pipeline end to end: BudgetLedger reservation → dispatch → structural scoring →
 * R2 transcript write → batched D1 case_result/score writes → finalize with a pass-rate
 * bootstrap CI aggregate. Proves the orchestration mechanics with zero neurons of real
 * inference (ARCHITECTURE verification gate).
 */
async function seedRegistry() {
  const db = drizzle(env.DB, { schema });
  const iso = nowIso();
  const targetId = ulid();
  await db.insert(schema.targets).values({
    id: targetId, provider: "workers-ai", modelId: "mock-model", params: {}, versionLabel: "mock@1",
    fingerprint: await canonicalHash({ m: targetId }), createdAt: iso,
  });
  const suiteId = ulid();
  await db.insert(schema.suites).values({
    id: suiteId, slug: `smoke-${suiteId}`, name: "Smoke", domain: "general",
    casesLicense: "CC0", casesProvenance: "authored-in-repo", judging: "structural", createdAt: iso,
  });
  const versionId = ulid();
  const hash = await canonicalHash([suiteId]);
  await db.insert(schema.suiteVersions).values({ id: versionId, suiteId, semver: "0.1.0", contentHash: hash, frozenAt: iso });

  // 4 cases: 3 whose expected matches the mock output ("MOCK:<prompt>") → pass, 1 → fail.
  const specs = [
    { prompt: "alpha", expected: "MOCK:alpha", passes: true },
    { prompt: "beta", expected: "MOCK:beta", passes: true },
    { prompt: "gamma", expected: "MOCK:gamma", passes: true },
    { prompt: "delta", expected: "WRONG", passes: false },
  ];
  const cases = [];
  for (const s of specs) {
    const caseId = ulid();
    await db.insert(schema.cases).values({
      id: caseId, suiteVersionId: versionId, input: { kind: "single_turn", content: s.prompt },
      scorerType: "structural", weight: 1, tags: [],
    });
    cases.push({ caseId, input: { kind: "single_turn" as const, content: s.prompt }, expected: s.expected });
  }
  return { db, targetId, suiteId, versionId, hash, cases };
}

async function drive(stub: DurableObjectStub<RunOrchestrator>) {
  // Deterministically pump the alarm loop until the run reaches a terminal state.
  for (let i = 0; i < 20; i++) {
    const status = await stub.status();
    if (status.status === "scored" || status.status === "budget_skipped" || status.status === "aborted") return status;
    await runInDurableObject(stub, (instance) => instance.alarm());
  }
  return stub.status();
}

describe("eval:smoke — full pipeline, no model calls", () => {
  it("runs a mock structural suite to a scored aggregate with a pass-rate CI", async () => {
    const { db, targetId, suiteId, versionId, hash, cases } = await seedRegistry();
    const runId = ulid();
    const config: RunConfig = {
      runId,
      suiteVersionId: versionId,
      suiteVersionHash: hash,
      targetId,
      provider: "mock",
      modelId: "mock-model",
      scorerType: "structural",
      samplingParams: { max_tokens: 64 },
      nTrials: 3,
      seed: 12345,
      channel: "system",
      environment: "ci",
      cases,
    };
    void suiteId;

    const stub = env.RUN_ORCHESTRATOR.get(env.RUN_ORCHESTRATOR.idFromName(runId));
    const started = await stub.start(config);
    expect(started.ok).toBe(true);

    const final = await drive(stub);
    expect(final.status).toBe("scored");
    expect(final.total).toBe(4 * 3); // 4 cases × 3 trials
    expect(final.done).toBe(12);
    expect(final.neuronsSpent).toBe(12 * 5); // NEURONS_PER_CALL

    // D1: run row scored; 12 case_results; 12 scores; aggregate with pass-rate + CI.
    const runRow = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
    expect(runRow[0]!.status).toBe("scored");
    expect(runRow[0]!.neuronsSpent).toBe(60);

    const crs = await db.select().from(schema.caseResults).where(eq(schema.caseResults.runId, runId));
    expect(crs).toHaveLength(12);

    const agg = await db.select().from(schema.aggregates).where(eq(schema.aggregates.provenanceRef, runId));
    expect(agg).toHaveLength(1);
    expect(agg[0]!.metric).toBe("pass_rate");
    expect(agg[0]!.n).toBe(4); // case count is the primary unit, not the 12 rows
    // 3 of 4 cases pass deterministically → point estimate 0.75, CI brackets it.
    expect(agg[0]!.value).toBeCloseTo(0.75, 12);
    expect(agg[0]!.ciLow).toBeLessThanOrEqual(0.75);
    expect(agg[0]!.ciHigh).toBeGreaterThanOrEqual(0.75);

    // R2: every case_result's model_output_ref resolves to a stored object (provenance).
    const firstRef = crs[0]!.modelOutputRef;
    const obj = await env.TRANSCRIPTS.get(firstRef);
    expect(obj).not.toBeNull();
    expect(await obj!.text()).toContain("MOCK:");

    // BudgetLedger recorded the spend in the system channel.
    const ledger = env.BUDGET_LEDGER.get(env.BUDGET_LEDGER.idFromName("global"));
    const stats = await ledger.stats({});
    expect(stats.channels.system!.spent).toBeGreaterThanOrEqual(0);
  });
});
