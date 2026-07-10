import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * D1 schema (drizzle-orm) — the registry + results of record for the Crucible harness.
 * This IS the eval-harness.md data model made concrete; it ships in `@crucible/harness`
 * and Basilisk deploys it unchanged in its own Worker (see docs/eval-harness.md).
 *
 * Rules (ARCHITECTURE invariants, enforced here where noted):
 *  - Versioned migrations only — NEVER `db push` (anti-list). `npm run migrate:generate`
 *    then `npm run migrate` (wrangler d1 migrations apply), tracked in git.
 *  - IDs are ULID (text). Times are UTC ISO-8601 strings (contract fidelity — Basilisk
 *    sees these columns; ISO-8601 UTC sorts lexicographically so range queries hold).
 *  - Replayability is a NOT NULL constraint, not a habit: every CaseResult carries a
 *    `model_output_ref` (R2); every Comparison carries BOTH transcript refs; every
 *    Aggregate carries a `provenance_ref`. There is no hand-settable aggregate value.
 *  - Bulk bytes (transcripts, raw model outputs) live in R2; D1 holds only refs + rows.
 *
 * JSON columns use drizzle's `{ mode: "json" }` for storage; the TRUST boundary is Zod
 * (src/harness/contract.ts), which parses these payloads on the way in — the `.$type<>()`
 * annotations here are compile-time shape only, never a runtime guarantee.
 */

// ————— shared JSON payload shapes (compile-time; Zod is the runtime boundary) —————

/** A Case's input — one of three declared shapes (eval-harness Case.input). */
export type CaseInput =
  | { kind: "single_turn"; content: string | { role: string; content: string }[] }
  | { kind: "multi_turn"; messages: { role: string; content: string }[] }
  | { kind: "tool_use_trace"; payload: unknown }; // per-suite payload schema (Basilisk attack scenarios fit here)

/** Sampling parameters recorded on a Run (all seeds/params are audited). */
export type SamplingParams = {
  temperature?: number;
  top_p?: number;
  max_tokens: number; // bounded generation is mandatory (security: unbounded = neuron-drain + DoS)
  [k: string]: unknown;
};

/** Score/Comparison flags (self_judged, unscoreable, ...). */
export type ScoreFlags = {
  self_judged?: boolean;
  unscoreable?: boolean;
  [k: string]: unknown;
};

// ————— enums (SQLite has no native enum; drizzle enforces at the type layer) —————
const JUDGING = ["structural", "single_rubric", "pairwise"] as const;
const SCORER_TYPE = ["structural", "single_rubric", "severity", "llm_judge"] as const;
const JUDGE_PROTOCOL = ["single_rubric", "pairwise"] as const;
const TARGET_PROVIDER = ["workers-ai", "http", "byo-key"] as const;
const RUN_STATUS = ["pending", "running", "scored", "budget_skipped", "aborted", "unscoreable"] as const;
const AGG_METRIC = ["pass_rate", "mean_scale", "win_rate_vs_anchor", "mean_severity"] as const;
const PAIRWISE_VERDICT = ["candidate", "anchor", "tie"] as const;
const REGRESSION_STATUS = ["unconfirmed", "confirmed"] as const;

// ————— Suite: logical grouping —————
export const suites = sqliteTable(
  "suites",
  {
    id: text("id").primaryKey(), // ULID
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    domain: text("domain").notNull(),
    casesLicense: text("cases_license").notNull(),
    casesProvenance: text("cases_provenance").notNull(),
    judging: text("judging", { enum: JUDGING }).notNull(),
    /** Required when judging = pairwise (anchored, not all-pairs). App-enforced (see contract). */
    anchorTargetId: text("anchor_target_id"),
    createdAt: text("created_at").notNull(), // ISO-8601 UTC
  },
  (t) => [uniqueIndex("suites_slug_uidx").on(t.slug)],
);

// ————— SuiteVersion: immutable, content-hashed; a Run pins one by hash —————
export const suiteVersions = sqliteTable(
  "suite_versions",
  {
    id: text("id").primaryKey(),
    suiteId: text("suite_id").notNull().references(() => suites.id),
    semver: text("semver").notNull(),
    /** SHA-256 over all member cases — the immutability anchor a Run pins to. */
    contentHash: text("content_hash").notNull(),
    frozenAt: text("frozen_at").notNull(),
  },
  (t) => [
    index("suite_versions_suite_idx").on(t.suiteId),
    uniqueIndex("suite_versions_hash_uidx").on(t.contentHash),
  ],
);

// ————— Case: one test item within a suite version —————
export const cases = sqliteTable(
  "cases",
  {
    id: text("id").primaryKey(),
    suiteVersionId: text("suite_version_id").notNull().references(() => suiteVersions.id),
    input: text("input", { mode: "json" }).$type<CaseInput>().notNull(),
    /** Optional golden — required by structural scorers, optional for reference-anchored judges. */
    expected: text("expected", { mode: "json" }).$type<unknown>(),
    scorerType: text("scorer_type", { enum: SCORER_TYPE }).notNull(),
    rubricRef: text("rubric_ref"),
    weight: real("weight").notNull().default(1),
    /** Category tags → per-category rollups (Basilisk sets OWASP Agentic Top 10 tags here). */
    tags: text("tags", { mode: "json" }).$type<string[]>().notNull(),
    /** Parametrized/contamination-resistant suites instantiate fresh variants from the seed. */
    paramTemplate: text("param_template", { mode: "json" }).$type<unknown>(),
    seed: integer("seed"),
  },
  (t) => [index("cases_suite_version_idx").on(t.suiteVersionId)],
);

// ————— Target: a model under test (or the anchor) —————
export const targets = sqliteTable(
  "targets",
  {
    id: text("id").primaryKey(),
    provider: text("provider", { enum: TARGET_PROVIDER }).notNull(),
    modelId: text("model_id").notNull(),
    params: text("params", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    versionLabel: text("version_label").notNull(),
    /** hash(model_id + params) — the regression identity a Baseline is pinned against. */
    fingerprint: text("fingerprint").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("targets_fingerprint_idx").on(t.fingerprint)],
);

// ————— Judge: immutable once referenced by a Run —————
export const judges = sqliteTable(
  "judges",
  {
    id: text("id").primaryKey(),
    model: text("model").notNull(),
    promptTemplate: text("prompt_template").notNull(),
    promptVersion: text("prompt_version").notNull(),
    protocol: text("protocol", { enum: JUDGE_PROTOCOL }).notNull(),
    k: integer("k").notNull(),
    aggregation: text("aggregation").notNull(), // "majority" | "mean" (declared per judge)
    calibrationRef: text("calibration_ref"),
    /** hash(model + prompt_template + prompt_version + protocol + k + aggregation). */
    configHash: text("config_hash").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("judges_config_hash_uidx").on(t.configHash)],
);

// ————— Run: the unit of execution; a full audit of exactly what ran —————
export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    /** Pins the SuiteVersion by content hash (immutability). */
    suiteVersionHash: text("suite_version_hash").notNull(),
    targetId: text("target_id").notNull().references(() => targets.id),
    judgeConfigHash: text("judge_config_hash"),
    /** Pairwise only: the anchor target's Run over the SAME suite_version_hash. */
    anchorRunId: text("anchor_run_id"),
    seed: integer("seed").notNull(),
    samplingParams: text("sampling_params", { mode: "json" }).$type<SamplingParams>().notNull(),
    nTrials: integer("n_trials").notNull(),
    status: text("status", { enum: RUN_STATUS }).notNull(),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    neuronsSpent: integer("neurons_spent").notNull().default(0),
    environment: text("environment").notNull(), // "prod" | "dev" | "ci"
  },
  (t) => [
    index("runs_suite_target_idx").on(t.suiteVersionHash, t.targetId),
    index("runs_status_idx").on(t.status),
  ],
);

// ————— CaseResult: one model output per case×trial; model_output_ref → R2 (NOT NULL) —————
export const caseResults = sqliteTable(
  "case_results",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull().references(() => runs.id),
    caseId: text("case_id").notNull().references(() => cases.id),
    trialIdx: integer("trial_idx").notNull(),
    /** R2 content-hash key of the raw model output — replayability is a NOT NULL constraint. */
    modelOutputRef: text("model_output_ref").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    tokens: integer("tokens").notNull(),
  },
  (t) => [
    index("case_results_run_idx").on(t.runId),
    uniqueIndex("case_results_run_case_trial_uidx").on(t.runId, t.caseId, t.trialIdx),
  ],
);

// ————— Score: the scoring unit for structural + single_rubric + severity (single-output) —————
export const scores = sqliteTable(
  "scores",
  {
    id: text("id").primaryKey(),
    caseResultId: text("case_result_id").notNull().references(() => caseResults.id),
    scorer: text("scorer", { enum: SCORER_TYPE }).notNull(),
    /**
     * Verdict domain is DECLARED by scorer type, never free-form:
     *  structural → "pass"|"fail"; single_rubric → numeric scale (stored in `verdictNum`);
     *  severity   → ordered enum none<low<medium<high<critical (level in `verdictNum` 0..4).
     * `verdict` holds the categorical form; `verdictNum` the numeric the stats module reads.
     */
    verdict: text("verdict").notNull(),
    verdictNum: real("verdict_num"),
    /** R2 ref — NOT NULL for any llm_judge/single_rubric judge score (app-enforced per family). */
    judgeTranscriptRef: text("judge_transcript_ref"),
    flags: text("flags", { mode: "json" }).$type<ScoreFlags>().notNull(),
  },
  (t) => [index("scores_case_result_idx").on(t.caseResultId)],
);

// ————— Comparison: the scoring unit for pairwise; BOTH transcript refs NOT NULL —————
export const comparisons = sqliteTable(
  "comparisons",
  {
    id: text("id").primaryKey(),
    caseId: text("case_id").notNull().references(() => cases.id),
    judgeConfigHash: text("judge_config_hash").notNull(),
    caseResultCandidate: text("case_result_candidate").notNull().references(() => caseResults.id),
    caseResultAnchor: text("case_result_anchor").notNull().references(() => caseResults.id),
    /** Verdict per presentation order (which side the judge preferred). */
    verdictOrder1: text("verdict_order1", { enum: PAIRWISE_VERDICT }).notNull(),
    verdictOrder2: text("verdict_order2", { enum: PAIRWISE_VERDICT }).notNull(),
    /** Swap-resolved: "candidate" win only if preferred in BOTH orders, else "tie". */
    verdict: text("verdict", { enum: PAIRWISE_VERDICT }).notNull(),
    transcriptRefOrder1: text("transcript_ref_order1").notNull(),
    transcriptRefOrder2: text("transcript_ref_order2").notNull(),
    flags: text("flags", { mode: "json" }).$type<ScoreFlags>().notNull(),
  },
  (t) => [index("comparisons_case_idx").on(t.caseId)],
);

// ————— Aggregate: computed ONLY from Score/Comparison rows; provenance_ref mandatory —————
export const aggregates = sqliteTable(
  "aggregates",
  {
    id: text("id").primaryKey(),
    suiteVersionId: text("suite_version_id").notNull().references(() => suiteVersions.id),
    targetId: text("target_id").notNull().references(() => targets.id),
    judgeConfigHash: text("judge_config_hash"),
    metric: text("metric", { enum: AGG_METRIC }).notNull(),
    value: real("value").notNull(),
    ciLow: real("ci_low").notNull(),
    ciHigh: real("ci_high").notNull(),
    /** Case count (the primary bootstrap unit), NOT the row count. */
    n: integer("n").notNull(),
    /** Mandatory pointer to the run/rows this was computed from — no hand-set numbers. */
    provenanceRef: text("provenance_ref").notNull(),
    computedAt: text("computed_at").notNull(),
  },
  (t) => [index("aggregates_suite_target_idx").on(t.suiteVersionId, t.targetId)],
);

// ————— Baseline: one pinned baseline per suite_version × target —————
export const baselines = sqliteTable(
  "baselines",
  {
    id: text("id").primaryKey(),
    suiteVersionId: text("suite_version_id").notNull().references(() => suiteVersions.id),
    targetId: text("target_id").notNull().references(() => targets.id),
    aggregateRef: text("aggregate_ref").notNull().references(() => aggregates.id),
    pinnedBy: text("pinned_by").notNull(), // actor key hash
    pinnedAt: text("pinned_at").notNull(),
  },
  (t) => [uniqueIndex("baselines_suite_target_uidx").on(t.suiteVersionId, t.targetId)],
);

// ————— Regression: event row; publishes as "detected" only when status = confirmed —————
export const regressions = sqliteTable(
  "regressions",
  {
    id: text("id").primaryKey(),
    suiteVersionId: text("suite_version_id").notNull().references(() => suiteVersions.id),
    targetId: text("target_id").notNull().references(() => targets.id),
    baselineRef: text("baseline_ref").notNull().references(() => baselines.id),
    runId: text("run_id").notNull().references(() => runs.id),
    pValue: real("p_value").notNull(),
    /** Benjamini-Hochberg FDR-adjusted p-value across the nightly family. */
    qValue: real("q_value"),
    effectSize: real("effect_size").notNull(),
    confirmationRunId: text("confirmation_run_id"),
    status: text("status", { enum: REGRESSION_STATUS }).notNull(),
    detectedAt: text("detected_at").notNull(),
  },
  (t) => [
    index("regressions_suite_target_idx").on(t.suiteVersionId, t.targetId),
    index("regressions_detected_idx").on(t.detectedAt),
  ],
);

// ————— api_keys: [SECURITY/Opus] admin authoring keys, argon2id-hashed at rest —————
export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    /** argon2id hash of the scoped bearer key (Phase 1.4). NEVER the plaintext key. */
    keyHash: text("key_hash").notNull(),
    label: text("label").notNull(),
    scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at"),
    revokedAt: text("revoked_at"),
  },
  (t) => [uniqueIndex("api_keys_hash_uidx").on(t.keyHash)],
);

// ————— audit_log: [SECURITY/Opus] every privileged action; no secrets, no case bodies —————
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(), // ULID (time-sortable)
    ts: text("ts").notNull(), // ISO-8601 UTC
    actorKeyHash: text("actor_key_hash").notNull(),
    action: text("action").notNull(), // "suite_publish" | "baseline_pin" | "judge_config_change" | "admin_run"
    targetId: text("target_id").notNull(),
    beforeHash: text("before_hash"),
    afterHash: text("after_hash"),
  },
  (t) => [index("audit_log_ts_idx").on(t.ts)],
);

// ————— inferred row types (harness + repository layers import these) —————
export type SuiteRow = typeof suites.$inferSelect;
export type SuiteInsert = typeof suites.$inferInsert;
export type SuiteVersionRow = typeof suiteVersions.$inferSelect;
export type CaseRow = typeof cases.$inferSelect;
export type CaseInsert = typeof cases.$inferInsert;
export type TargetRow = typeof targets.$inferSelect;
export type JudgeRow = typeof judges.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type RunInsert = typeof runs.$inferInsert;
export type CaseResultRow = typeof caseResults.$inferSelect;
export type CaseResultInsert = typeof caseResults.$inferInsert;
export type ScoreRow = typeof scores.$inferSelect;
export type ScoreInsert = typeof scores.$inferInsert;
export type ComparisonRow = typeof comparisons.$inferSelect;
export type ComparisonInsert = typeof comparisons.$inferInsert;
export type AggregateRow = typeof aggregates.$inferSelect;
export type AggregateInsert = typeof aggregates.$inferInsert;
export type BaselineRow = typeof baselines.$inferSelect;
export type RegressionRow = typeof regressions.$inferSelect;
export type RegressionInsert = typeof regressions.$inferInsert;
export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type AuditLogRow = typeof auditLog.$inferSelect;
export type AuditLogInsert = typeof auditLog.$inferInsert;
