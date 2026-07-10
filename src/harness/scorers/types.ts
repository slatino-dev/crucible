import { z } from "zod";
import type { CaseInput } from "../../db/schema";

/**
 * Scorer plugin interface (eval-harness.md "Scorer plugin interface"). Typed I/O, Zod both
 * directions. SINGLE-OUTPUT families only — `structural`, `single_rubric`, `severity`.
 * Pairwise/Comparison scoring is orchestrator-internal (two operands), NOT a plugin seam in
 * v1. Basilisk registers its own single-output `severity` scorers against this same signature.
 *
 *   scorer(input, output, ctx) => Promise<ScoreResult>
 *
 * A failed/unparseable result yields an `unscoreable`-flagged ScoreResult, never a silent drop.
 */

/** The raw model output handed to a scorer (text + optional structured payload). */
export interface ModelOutput {
  text: string;
  /** Parsed structured output when the target returned JSON/tool calls (structural scorers). */
  structured?: unknown;
}

/** Context a scorer may need (judge calls, R2 for transcript storage) — kept minimal for v1. */
export interface ScoreContext {
  /** The R2 ref of the raw model output already stored by the orchestrator (provenance). */
  modelOutputRef: string;
}

/** Verdict domains, declared per scorer family (never free-form). */
export const scoreResultSchema = z.object({
  /** Categorical verdict: "pass"|"fail" (structural) or a severity level or a scale label. */
  verdict: z.string(),
  /** Numeric form the stats module reads: 1/0 (pass/fail), 0..4 (severity), or a scale value. */
  verdictNum: z.number().nullable(),
  /** R2 ref of a judge transcript — set by llm_judge scorers, null for structural. */
  transcriptRef: z.string().nullable(),
  flags: z.object({ self_judged: z.boolean().optional(), unscoreable: z.boolean().optional() }).passthrough(),
});
export type ScoreResult = z.infer<typeof scoreResultSchema>;

export type Scorer = (input: CaseInput, output: ModelOutput, ctx: ScoreContext) => Promise<ScoreResult>;

/** Build an `unscoreable`-flagged result (a failed/unparseable score, never dropped). */
export function unscoreable(reason: string): ScoreResult {
  return { verdict: "unscoreable", verdictNum: null, transcriptRef: null, flags: { unscoreable: true, reason } };
}
