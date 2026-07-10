/**
 * Crucible tracking plan as code — the single source of truth for analytics events.
 * Seeded from ~/.claude/templates/tracking-plan-starter.ts and tailored to Crucible.
 *
 * Rules: object_action, past tense, snake_case. Properties carry context; don't mint a
 * new event per variant. New/changed events are PR-reviewed like migrations; renames are
 * breaking changes. NO PII in properties — enforced here in the schema (no email, name,
 * ip, raw client id, or full URL with tokens). No string-literal track() calls.
 *
 * SCAFFOLD STATE: this is the typed plan only. Wiring `capture` to PostHog is net-new
 * secret handling ([SECURITY/Opus]-owned, deferred) — no key is read here.
 */
import { z } from "zod";

// ————— shared property schemas —————
const source = z.enum(["organic", "referral", "launch", "docs", "ai_citation", "direct"]);

/** A suite's scorer family — drives which metric the run produced (see eval-harness.md). */
const scorerFamily = z.enum(["structural", "single_rubric", "pairwise", "severity"]);

/** How a run terminated. `unscoreable` = judge output never parsed (never silently dropped). */
const runOutcome = z.enum(["scored", "budget_skipped", "aborted", "unscoreable"]);

// ————— the event registry —————
// Ordered funnel (the path a visitor actually takes — run first, audit after):
//   arena_viewed → live_run_started → live_run_completed → repo_clicked
// score_provenance_opened is a PARALLEL engagement event, not a strict funnel step,
// because most visitors run before they audit (see PRD "Activation event").
export const events = {
  // ————— Acquisition —————
  arena_viewed: z.object({
    source,
    utm_campaign: z.string().optional(),
    referrer_domain: z.string().optional(), // domain only, never full URL with tokens
  }),

  /** Visitor clicked the spotlight live-run trigger; the run is dispatched server-side. */
  live_run_started: z.object({
    suite_slug: z.string(),
    /** Bounded model spend is enforced server-side; this is telemetry only. */
    neurons_estimated: z.number().nonnegative(),
  }),

  // ————— INSTRUMENT ZERO — the activation event —————
  // A visitor-initiated spotlight eval run reaches SCORED completion with a result + CI
  // rendered in-session (PRD "Activation event"). Joinable to the D1 run record by
  // run_id — no vanity pageview proxy. TTV target <60s; run itself <40s p95.
  live_run_completed: z.object({
    suite_slug: z.string(),
    /** Opaque ULID of the D1 Run row — the join key to the queryable record. Not PII. */
    run_id: z.string(),
    scorer_family: scorerFamily,
    outcome: runOutcome,
    /** Whether the trigger served a cached recent real run (budget-ceiling fallback). */
    served_from_cache: z.boolean(),
    /** Milliseconds from live_run_started to scored completion (time-to-value). */
    ms_to_complete: z.number().nonnegative(),
  }),

  /** Visitor clicked through to the source repo — the funnel's terminal audit step. */
  repo_clicked: z.object({
    surface: z.enum(["leaderboard", "methodology", "transcript", "footer"]),
  }),

  // ————— Parallel engagement (NOT a strict funnel step) —————
  // A score was clicked through to its stored provenance artifact (judge transcript for
  // llm_judge/pairwise, raw model output for structural). The product thesis as a metric:
  // does anyone actually audit the numbers?
  score_provenance_opened: z.object({
    scorer_family: scorerFamily,
    /** Which artifact family resolved — never a nonexistent "judge transcript" for structural. */
    artifact_kind: z.enum(["judge_transcript", "model_output"]),
  }),
} as const;

export type EventName = keyof typeof events;
export type EventProps<E extends EventName> = z.infer<(typeof events)[E]>;

// ————— the only track entrypoint —————
// Wire `capture` to PostHog when secret handling lands ([SECURITY/Opus]-owned):
// identify at first touch; UTM/referrer persisted; group() is N/A (no accounts in v1).
export function track<E extends EventName>(event: E, props: EventProps<E>): void {
  const parsed = events[event].parse(props); // throws on schema drift & PII leaks
  // posthog.capture(event, parsed);
  void parsed;
}
