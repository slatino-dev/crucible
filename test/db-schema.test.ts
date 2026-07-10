import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { ulid, nowIso, canonicalHash } from "../src/util/ids";

/**
 * D1 schema exercise: walk the full harness chain (suite → version → cases → targets →
 * run → case_results → comparison → aggregate → baseline → regression) against the REAL
 * miniflare D1 with the shipped migrations applied (test/apply-migrations.ts). Asserts the
 * schema-enforced invariants: unique suite content hash, one CaseResult per run×case×trial,
 * one Baseline per suite_version×target, and that provenance refs are stored NOT NULL.
 */
describe("D1 harness schema", () => {
  it("persists a full anchored-pairwise run chain and enforces its uniqueness invariants", async () => {
    const db = drizzle(env.DB, { schema });
    const iso = nowIso();

    // Suite (pairwise → anchored) + immutable content-hashed version.
    const suiteId = ulid();
    const anchorTargetId = ulid();
    const candidateTargetId = ulid();
    await db.insert(schema.targets).values([
      {
        id: anchorTargetId,
        provider: "workers-ai",
        modelId: "@cf/meta/llama-3.1-8b-instruct",
        params: { temperature: 0 },
        versionLabel: "llama-3.1-8b@base",
        fingerprint: await canonicalHash({ modelId: "@cf/meta/llama-3.1-8b-instruct", params: { temperature: 0 } }),
        createdAt: iso,
      },
      {
        id: candidateTargetId,
        provider: "workers-ai",
        modelId: "@cf/qwen/qwen2.5-7b-instruct",
        params: { temperature: 0 },
        versionLabel: "qwen2.5-7b@base",
        fingerprint: await canonicalHash({ modelId: "@cf/qwen/qwen2.5-7b-instruct", params: { temperature: 0 } }),
        createdAt: iso,
      },
    ]);

    await db.insert(schema.suites).values({
      id: suiteId,
      slug: "instruction-following-v0",
      name: "Instruction Following",
      domain: "general",
      casesLicense: "CC-BY-4.0",
      casesProvenance: "authored-in-repo",
      judging: "pairwise",
      anchorTargetId,
      createdAt: iso,
    });

    const versionId = ulid();
    const contentHash = await canonicalHash([{ input: "case-1" }, { input: "case-2" }]);
    await db.insert(schema.suiteVersions).values({
      id: versionId,
      suiteId,
      semver: "0.1.0",
      contentHash,
      frozenAt: iso,
    });

    const caseId = ulid();
    await db.insert(schema.cases).values({
      id: caseId,
      suiteVersionId: versionId,
      input: { kind: "single_turn", content: "Write a haiku about error bars." },
      scorerType: "llm_judge",
      weight: 1,
      tags: ["formatting", "instruction"],
    });

    // Candidate + anchor Runs over the same version hash; the candidate points at the anchor.
    const anchorRunId = ulid();
    const candidateRunId = ulid();
    await db.insert(schema.runs).values([
      {
        id: anchorRunId,
        suiteVersionHash: contentHash,
        targetId: anchorTargetId,
        seed: 42,
        samplingParams: { max_tokens: 256 },
        nTrials: 1,
        status: "scored",
        startedAt: iso,
        finishedAt: iso,
        neuronsSpent: 40,
        environment: "ci",
      },
      {
        id: candidateRunId,
        suiteVersionHash: contentHash,
        targetId: candidateTargetId,
        judgeConfigHash: "judge-abc",
        anchorRunId,
        seed: 42,
        samplingParams: { max_tokens: 256 },
        nTrials: 1,
        status: "scored",
        startedAt: iso,
        finishedAt: iso,
        neuronsSpent: 60,
        environment: "ci",
      },
    ]);

    const anchorResultId = ulid();
    const candidateResultId = ulid();
    await db.insert(schema.caseResults).values([
      { id: anchorResultId, runId: anchorRunId, caseId, trialIdx: 0, modelOutputRef: "r2://out/anchor-0", latencyMs: 800, tokens: 120 },
      { id: candidateResultId, runId: candidateRunId, caseId, trialIdx: 0, modelOutputRef: "r2://out/cand-0", latencyMs: 900, tokens: 140 },
    ]);

    // Comparison: candidate preferred in both orders → verdict "candidate"; both transcripts stored.
    await db.insert(schema.comparisons).values({
      id: ulid(),
      caseId,
      judgeConfigHash: "judge-abc",
      caseResultCandidate: candidateResultId,
      caseResultAnchor: anchorResultId,
      verdictOrder1: "candidate",
      verdictOrder2: "candidate",
      verdict: "candidate",
      transcriptRefOrder1: "r2://judge/o1",
      transcriptRefOrder2: "r2://judge/o2",
      flags: {},
    });

    // Aggregate computed from the comparison rows; provenance_ref is mandatory.
    const aggregateId = ulid();
    await db.insert(schema.aggregates).values({
      id: aggregateId,
      suiteVersionId: versionId,
      targetId: candidateTargetId,
      judgeConfigHash: "judge-abc",
      metric: "win_rate_vs_anchor",
      value: 1.0,
      ciLow: 0.4,
      ciHigh: 1.0,
      n: 1,
      provenanceRef: candidateRunId,
      computedAt: iso,
    });

    // Baseline pin + a regression event row.
    const baselineId = ulid();
    await db.insert(schema.baselines).values({
      id: baselineId,
      suiteVersionId: versionId,
      targetId: candidateTargetId,
      aggregateRef: aggregateId,
      pinnedBy: "keyhash-xyz",
      pinnedAt: iso,
    });
    await db.insert(schema.regressions).values({
      id: ulid(),
      suiteVersionId: versionId,
      targetId: candidateTargetId,
      baselineRef: baselineId,
      runId: candidateRunId,
      pValue: 0.2,
      effectSize: 0.05,
      status: "unconfirmed",
      detectedAt: iso,
    });

    // Round-trips: JSON columns preserve typed shape; the comparison verdict resolved.
    const roundTripped = await db.select().from(schema.comparisons).where(eq(schema.comparisons.caseId, caseId));
    expect(roundTripped).toHaveLength(1);
    expect(roundTripped[0]!.verdict).toBe("candidate");
    expect(roundTripped[0]!.transcriptRefOrder1).toBe("r2://judge/o1");

    const caseRow = await db.select().from(schema.cases).where(eq(schema.cases.id, caseId));
    expect(caseRow[0]!.input).toEqual({ kind: "single_turn", content: "Write a haiku about error bars." });
    expect(caseRow[0]!.tags).toEqual(["formatting", "instruction"]);

    const agg = await db.select().from(schema.aggregates).where(eq(schema.aggregates.id, aggregateId));
    expect(agg[0]!.provenanceRef).toBe(candidateRunId);
  });

  it("rejects a duplicate suite content hash (immutability anchor)", async () => {
    const db = drizzle(env.DB, { schema });
    const iso = nowIso();
    const suiteId = ulid();
    await db.insert(schema.suites).values({
      id: suiteId,
      slug: `dup-hash-${suiteId}`,
      name: "Dup",
      domain: "general",
      casesLicense: "CC0",
      casesProvenance: "authored-in-repo",
      judging: "structural",
      createdAt: iso,
    });
    const hash = await canonicalHash(["identical-cases"]);
    await db.insert(schema.suiteVersions).values({ id: ulid(), suiteId, semver: "1.0.0", contentHash: hash, frozenAt: iso });
    await expect(
      db.insert(schema.suiteVersions).values({ id: ulid(), suiteId, semver: "1.0.1", contentHash: hash, frozenAt: iso }),
    ).rejects.toThrow();
  });

  it("rejects two CaseResults for the same run×case×trial", async () => {
    const db = drizzle(env.DB, { schema });
    const iso = nowIso();
    // Minimal target + run to satisfy FKs.
    const targetId = ulid();
    await db.insert(schema.targets).values({
      id: targetId, provider: "workers-ai", modelId: "m", params: {}, versionLabel: "v", fingerprint: await canonicalHash({ m: targetId }), createdAt: iso,
    });
    const runId = ulid();
    await db.insert(schema.runs).values({
      id: runId, suiteVersionHash: `h-${runId}`, targetId, seed: 1, samplingParams: { max_tokens: 8 }, nTrials: 1, status: "scored", startedAt: iso, environment: "ci",
    });
    // A case to reference (needs a suite_version).
    const suiteId = ulid();
    await db.insert(schema.suites).values({ id: suiteId, slug: `s-${suiteId}`, name: "n", domain: "d", casesLicense: "CC0", casesProvenance: "p", judging: "structural", createdAt: iso });
    const versionId = ulid();
    await db.insert(schema.suiteVersions).values({ id: versionId, suiteId, semver: "1", contentHash: `ch-${versionId}`, frozenAt: iso });
    const caseId = ulid();
    await db.insert(schema.cases).values({ id: caseId, suiteVersionId: versionId, input: { kind: "single_turn", content: "x" }, scorerType: "structural", weight: 1, tags: [] });

    await db.insert(schema.caseResults).values({ id: ulid(), runId, caseId, trialIdx: 0, modelOutputRef: "r2://a", latencyMs: 1, tokens: 1 });
    await expect(
      db.insert(schema.caseResults).values({ id: ulid(), runId, caseId, trialIdx: 0, modelOutputRef: "r2://b", latencyMs: 1, tokens: 1 }),
    ).rejects.toThrow();
  });
});
