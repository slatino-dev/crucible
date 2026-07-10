import { DurableObject } from "cloudflare:workers";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Env } from "../../env";
import * as schema from "../../db/schema";
import type { CaseInput, SamplingParams } from "../../db/schema";
import { canonicalHash, nowIso } from "../../util/ids";
import { bootstrapCI, mulberry32, type Sample } from "../stats";
import { makeExactMatch } from "../scorers/structural";
import type { BudgetChannel } from "../budget/config";

/**
 * RunOrchestrator DO — one instance per run; the SQLite state machine + alarm engine
 * (ARCHITECTURE "System shape"). A run advances through pending → running → scored /
 * budget_skipped / aborted. Alarms pace dispatch and retry with backoff+jitter; each batch
 * asks the BudgetLedger to RESERVE neurons before dispatching (a batch runs only if it
 * fits), writes raw outputs to R2 (content-addressed), batches its D1 case_result + score
 * writes, and reconciles the reservation against actual usage. On completion it computes the
 * headline aggregate (pass-rate + bootstrap CI over cases) via the pure stats module and
 * writes the aggregates row — the only place a number reaches the board, always with
 * provenance (provenance_ref = run id).
 *
 * v1.0 built-in path: `structural` scoring over `workers-ai` and `mock` targets. The mock
 * provider is the deterministic fixture path (no model calls) that the smoke test exercises
 * end-to-end. The `llm_judge` anchored-pairwise path lands in Phase 1.4.
 *
 * All batch sizing respects the free-tier subrequest budget: v1 targets are `workers-ai`
 * (internal-service subrequests, 1,000/invocation cap — see ARCHITECTURE build-start
 * re-verification), and BATCH_SIZE stays well under it with headroom for the D1/R2 writes.
 */

const BATCH_SIZE = 6;
const PACING_MS = 200;
const MAX_ATTEMPTS = 3;
/** A claim older than this (ms) is presumed orphaned (alarm crashed mid-batch) and reclaimed. */
const STALE_CLAIM_MS = 30_000;
/** Build-start neuron-per-call working estimate (ARCHITECTURE Neuron budget: ~3-5). */
const NEURONS_PER_CALL = 5;

export const runConfigSchema = z.object({
  runId: z.string(),
  suiteVersionId: z.string(),
  suiteVersionHash: z.string(),
  targetId: z.string(),
  provider: z.enum(["workers-ai", "mock"]),
  modelId: z.string(),
  scorerType: z.enum(["structural"]), // llm_judge/pairwise → Phase 1.4
  samplingParams: z.object({ max_tokens: z.number().int().positive() }).passthrough(),
  nTrials: z.number().int().positive(),
  seed: z.number().int(),
  channel: z.enum(["visitor", "system"]),
  visitorKey: z.string().optional(),
  environment: z.enum(["prod", "dev", "ci"]),
  cases: z.array(
    z.object({
      caseId: z.string(),
      input: z.custom<CaseInput>(),
      expected: z.string(), // structural exact-match golden
    }),
  ).min(1),
});
export type RunConfig = z.infer<typeof runConfigSchema>;

export interface RunStatus {
  runId: string;
  status: string;
  total: number;
  done: number;
  neuronsSpent: number;
  reason?: string;
}

/** Extract a single prompt string from a Case input (v1 handles single_turn strings). */
function promptText(input: CaseInput): string {
  if (input.kind === "single_turn") {
    return typeof input.content === "string"
      ? input.content
      : input.content.map((m) => `${m.role}: ${m.content}`).join("\n");
  }
  if (input.kind === "multi_turn") return input.messages.map((m) => `${m.role}: ${m.content}`).join("\n");
  return JSON.stringify(input.payload);
}

export class RunOrchestrator extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly db: DrizzleD1Database<typeof schema>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.db = drizzle(env.DB, { schema });
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);`);
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS queue (
           seq INTEGER PRIMARY KEY AUTOINCREMENT, case_id TEXT NOT NULL, trial_idx INTEGER NOT NULL,
           claimed INTEGER NOT NULL DEFAULT 0, claimed_at INTEGER NOT NULL DEFAULT 0,
           done INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0
         );`,
      );
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS results (
           case_id TEXT NOT NULL, trial_idx INTEGER NOT NULL, verdict_num REAL NOT NULL,
           PRIMARY KEY (case_id, trial_idx)
         );`,
      );
    });
  }

  private getMeta(k: string): string | undefined {
    const rows = this.sql.exec(`SELECT v FROM meta WHERE k = ?`, k).toArray() as { v: string }[];
    return rows[0]?.v;
  }
  private setMeta(k: string, v: string): void {
    this.sql.exec(`INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`, k, v);
  }
  private scalar(query: string, ...binds: unknown[]): number {
    const row = this.sql.exec(query, ...binds).toArray()[0] as Record<string, unknown> | undefined;
    if (!row) return 0;
    const v = Object.values(row)[0];
    return typeof v === "number" ? v : Number(v ?? 0);
  }

  /** Start a run: persist config, insert the D1 runs row (running), enqueue case×trial work. */
  async start(rawConfig: unknown): Promise<{ ok: boolean; runId: string }> {
    const config = runConfigSchema.parse(rawConfig);
    this.setMeta("config", JSON.stringify(config));
    this.setMeta("status", "running");
    this.setMeta("neuronsSpent", "0");
    this.setMeta("startedAt", nowIso());

    for (const c of config.cases) {
      for (let trial = 0; trial < config.nTrials; trial++) {
        this.sql.exec(`INSERT INTO queue (case_id, trial_idx) VALUES (?, ?)`, c.caseId, trial);
      }
    }

    await this.db.insert(schema.runs).values({
      id: config.runId,
      suiteVersionHash: config.suiteVersionHash,
      targetId: config.targetId,
      seed: config.seed,
      samplingParams: config.samplingParams as SamplingParams,
      nTrials: config.nTrials,
      status: "running",
      startedAt: nowIso(),
      neuronsSpent: 0,
      environment: config.environment,
    });

    await this.ctx.storage.setAlarm(Date.now() + 1);
    return { ok: true, runId: config.runId };
  }

  async status(): Promise<RunStatus> {
    const config = this.getMeta("config");
    if (!config) return { runId: "", status: "unknown", total: 0, done: 0, neuronsSpent: 0 };
    const c = JSON.parse(config) as RunConfig;
    const total = this.scalar(`SELECT COUNT(*) FROM queue`);
    const done = this.scalar(`SELECT COUNT(*) FROM queue WHERE done = 1`);
    return {
      runId: c.runId,
      status: this.getMeta("status") ?? "unknown",
      total,
      done,
      neuronsSpent: Number(this.getMeta("neuronsSpent") ?? "0"),
      reason: this.getMeta("reason"),
    };
  }

  /** Alarm handler: process one batch (reserve → dispatch → score → persist → reconcile). */
  override async alarm(): Promise<void> {
    const configRaw = this.getMeta("config");
    if (!configRaw || this.getMeta("status") !== "running") return;
    const config = JSON.parse(configRaw) as RunConfig;
    const caseById = new Map(config.cases.map((c) => [c.caseId, c]));

    // Reclaim orphaned claims (an alarm that crashed after claiming but before completing).
    const nowMs = Date.now();
    this.sql.exec(`UPDATE queue SET claimed = 0 WHERE done = 0 AND claimed = 1 AND claimed_at < ?`, nowMs - STALE_CLAIM_MS);

    // Select only UNCLAIMED, not-done work. `claimed` and `done` are distinct: `claimed`
    // means an alarm is dispatching it right now; `done` means it completed. Gating finalize
    // on `done` (not `claimed`) is what stops one alarm finalizing while another's batch is
    // still in flight — the bug that produced a partial aggregate + lost neuron count.
    const batch = this.sql
      .exec(`SELECT seq, case_id, trial_idx, attempts FROM queue WHERE claimed = 0 AND done = 0 ORDER BY seq LIMIT ?`, BATCH_SIZE)
      .toArray() as { seq: number; case_id: string; trial_idx: number; attempts: number }[];

    if (batch.length === 0) {
      // Nothing to claim. If everything is genuinely done, finalize; otherwise other
      // in-flight claims are still running — re-check shortly.
      if (this.scalar(`SELECT COUNT(*) FROM queue WHERE done = 0`) === 0) await this.finalize(config);
      else await this.ctx.storage.setAlarm(nowMs + PACING_MS);
      return;
    }

    // Atomically CLAIM the batch BEFORE any await, so a concurrently-firing alarm cannot
    // select the same rows and double-dispatch. Success sets done=1; a retryable failure
    // releases the claim (claimed=0) so a later alarm reprocesses it.
    for (const item of batch) this.sql.exec(`UPDATE queue SET claimed = 1, claimed_at = ? WHERE seq = ?`, nowMs, item.seq);

    // Reserve neurons for this batch BEFORE dispatch (a batch runs only if it fits).
    const reserveNeurons = batch.length * NEURONS_PER_CALL;
    const ledger = this.env.BUDGET_LEDGER.get(this.env.BUDGET_LEDGER.idFromName("global"));
    const reservation = await ledger.reserve({
      channel: config.channel as BudgetChannel,
      neurons: reserveNeurons,
      visitorKey: config.visitorKey,
    });
    if (!reservation.ok) {
      // Release the claims (not done) and stop: budget exhaustion is terminal for this run.
      for (const item of batch) this.sql.exec(`UPDATE queue SET claimed = 0 WHERE seq = ?`, item.seq);
      this.setMeta("status", "budget_skipped");
      this.setMeta("reason", reservation.reason ?? "budget");
      await this.db.update(schema.runs).set({ status: "budget_skipped", finishedAt: nowIso() }).where(eq(schema.runs.id, config.runId));
      return;
    }

    let actualNeurons = 0;
    const caseResultInserts: (typeof schema.caseResults.$inferInsert)[] = [];
    const scoreInserts: (typeof schema.scores.$inferInsert)[] = [];

    for (const item of batch) {
      const c = caseById.get(item.case_id);
      if (!c) continue; // unknown case: already claimed done, nothing to dispatch
      try {
        const dispatched = await this.dispatchCase(config, c.input);
        actualNeurons += dispatched.neurons;

        // Content-addressed R2 write of the raw model output (replayability provenance).
        const outputRef = `outputs/${await canonicalHash({ runId: config.runId, caseId: c.caseId, trial: item.trial_idx, text: dispatched.text })}`;
        await this.env.TRANSCRIPTS.put(outputRef, dispatched.text);

        const caseResultId = `${config.runId}:${c.caseId}:${item.trial_idx}`;
        caseResultInserts.push({
          id: caseResultId,
          runId: config.runId,
          caseId: c.caseId,
          trialIdx: item.trial_idx,
          modelOutputRef: outputRef,
          latencyMs: dispatched.latencyMs,
          tokens: dispatched.tokens,
        });

        const scorer2 = makeExactMatch(c.expected);
        const result = await scorer2(c.input, { text: dispatched.text }, { modelOutputRef: outputRef });
        scoreInserts.push({
          id: `${caseResultId}:s`,
          caseResultId,
          scorer: "structural",
          verdict: result.verdict,
          verdictNum: result.verdictNum,
          judgeTranscriptRef: result.transcriptRef,
          flags: result.flags,
        });
        // Mark done AND record the neuron spend in the SAME synchronous block, so "done"
        // always implies "accounted": when a (possibly concurrent) alarm later observes all
        // items done and finalizes, every item's neuron count is already in the meta counter.
        this.sql.exec(`INSERT OR REPLACE INTO results (case_id, trial_idx, verdict_num) VALUES (?, ?, ?)`, c.caseId, item.trial_idx, result.verdictNum ?? 0);
        this.sql.exec(`UPDATE queue SET done = 1 WHERE seq = ?`, item.seq);
        this.sql.exec(`UPDATE meta SET v = CAST((CAST(v AS INTEGER) + ?) AS TEXT) WHERE k = 'neuronsSpent'`, dispatched.neurons);
      } catch (err) {
        // Retry with backoff+jitter; after MAX_ATTEMPTS mark the item scored-unscoreable
        // (never a silent drop). A retryable failure RELEASES the claim (claimed=0, done=0)
        // so a later alarm reprocesses; the terminal path completes it (done=1).
        const attempts = item.attempts + 1;
        if (attempts >= MAX_ATTEMPTS) {
          const caseResultId = `${config.runId}:${c.caseId}:${item.trial_idx}`;
          const outputRef = `outputs/unscoreable/${caseResultId}`;
          caseResultInserts.push({ id: caseResultId, runId: config.runId, caseId: c.caseId, trialIdx: item.trial_idx, modelOutputRef: outputRef, latencyMs: 0, tokens: 0 });
          scoreInserts.push({ id: `${caseResultId}:s`, caseResultId, scorer: "structural", verdict: "unscoreable", verdictNum: 0, judgeTranscriptRef: null, flags: { unscoreable: true, error: String(err) } });
          this.sql.exec(`INSERT OR REPLACE INTO results (case_id, trial_idx, verdict_num) VALUES (?, ?, ?)`, c.caseId, item.trial_idx, 0);
          this.sql.exec(`UPDATE queue SET done = 1, attempts = ? WHERE seq = ?`, attempts, item.seq);
        } else {
          this.sql.exec(`UPDATE queue SET claimed = 0, attempts = ? WHERE seq = ?`, attempts, item.seq);
        }
      }
    }

    // Batched D1 writes for the whole batch (one round trip).
    // onConflictDoNothing makes the batch idempotent: deterministic ids mean a re-run of a
    // claimed-then-reprocessed item never duplicates a row (defense-in-depth with the claim).
    const stmts = [
      ...caseResultInserts.map((v) => this.db.insert(schema.caseResults).values(v).onConflictDoNothing()),
      ...scoreInserts.map((v) => this.db.insert(schema.scores).values(v).onConflictDoNothing()),
    ];
    if (stmts.length > 0) {
      // drizzle-d1 batch requires a non-empty tuple.
      await this.db.batch(stmts as [(typeof stmts)[number], ...(typeof stmts)[number][]]);
    }

    // Reconcile the reservation against actual usage (per-item neuron spend was already
    // recorded synchronously above, paired with each item's done flag).
    await ledger.reconcile({
      channel: config.channel as BudgetChannel,
      reservedNeurons: reserveNeurons,
      actualNeurons,
      visitorKey: config.visitorKey,
    });

    const remaining = this.scalar(`SELECT COUNT(*) FROM queue WHERE done = 0`);
    if (remaining > 0) {
      await this.ctx.storage.setAlarm(Date.now() + PACING_MS + Math.floor(Math.random() * 50));
    } else {
      await this.finalize(config);
    }
  }

  /** Dispatch one case to the target. `mock` = deterministic fixture path (no model call). */
  private async dispatchCase(
    config: RunConfig,
    input: CaseInput,
  ): Promise<{ text: string; tokens: number; latencyMs: number; neurons: number }> {
    const prompt = promptText(input);
    if (config.provider === "mock") {
      const text = `MOCK:${prompt}`;
      return { text, tokens: Math.ceil(text.length / 4), latencyMs: 5, neurons: NEURONS_PER_CALL };
    }
    // workers-ai: real target dispatch (exercised with live targets in Phase 1.4).
    const started = Date.now();
    const res = (await this.env.AI.run(config.modelId as never, {
      messages: [{ role: "user", content: prompt }],
      max_tokens: config.samplingParams.max_tokens,
    } as never)) as { response?: string };
    const text = typeof res?.response === "string" ? res.response : JSON.stringify(res);
    return { text, tokens: Math.ceil(text.length / 4), latencyMs: Date.now() - started, neurons: NEURONS_PER_CALL };
  }

  /** Finalize: compute the pass-rate aggregate (bootstrap CI over cases) and close the run. */
  private async finalize(config: RunConfig): Promise<void> {
    // Claim finalization synchronously so a concurrent alarm cannot double-write the aggregate.
    if (this.getMeta("status") !== "running") return;
    this.setMeta("status", "finalizing");

    const rows = this.sql.exec(`SELECT case_id, verdict_num FROM results`).toArray() as { case_id: string; verdict_num: number }[];
    const byCase = new Map<string, number[]>();
    for (const r of rows) {
      const arr = byCase.get(r.case_id) ?? [];
      arr.push(r.verdict_num);
      byCase.set(r.case_id, arr);
    }
    const sample: Sample = [...byCase.values()];
    const ci = bootstrapCI(sample, { rng: mulberry32(config.seed >>> 0), b: 2000 });

    await this.db.insert(schema.aggregates).values({
      id: `${config.runId}:agg`,
      suiteVersionId: config.suiteVersionId,
      targetId: config.targetId,
      metric: "pass_rate",
      value: ci.point,
      ciLow: ci.ciLow,
      ciHigh: ci.ciHigh,
      n: ci.n,
      provenanceRef: config.runId,
      computedAt: nowIso(),
    }).onConflictDoNothing();

    const neuronsSpent = Number(this.getMeta("neuronsSpent") ?? "0");
    await this.db
      .update(schema.runs)
      .set({ status: "scored", finishedAt: nowIso(), neuronsSpent })
      .where(eq(schema.runs.id, config.runId));
    this.setMeta("status", "scored");
  }
}
