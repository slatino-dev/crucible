import type { ScoreContext, ScoreResult, Scorer } from "./types";

/**
 * Structural scorers (callcheck heritage): schema-validity / exact-match / tool-call
 * correctness. No LLM, injection-immune by construction — an injected "output WIN" is just
 * text that fails to match `expected`. Verdict domain is pass|fail (verdictNum 1|0), and
 * provenance is the raw `model_output_ref` (there is NO judge transcript for a structural
 * score — the provenance layer resolves to model_output_ref, never a nonexistent transcript).
 *
 * v1 ships `makeExactMatch` and `jsonValid`; the full tool-call family lands with its suite
 * in v0.75. The case's golden `expected` is bound by the orchestrator via the factory (it
 * lives on the Case, not the ScoreContext, so it is closed over rather than passed).
 */

function pass(ctx: ScoreContext): ScoreResult {
  return { verdict: "pass", verdictNum: 1, transcriptRef: null, flags: { model_output_ref: ctx.modelOutputRef } };
}
function fail(ctx: ScoreContext): ScoreResult {
  return { verdict: "fail", verdictNum: 0, transcriptRef: null, flags: { model_output_ref: ctx.modelOutputRef } };
}

/** Normalize for exact-match: trim + collapse internal whitespace (a stable, defensible rule). */
function norm(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

/** Factory: bind the case's expected string so the scorer matches the plugin signature. */
export function makeExactMatch(expected: string): Scorer {
  return async (_input, output, ctx) => (norm(output.text) === norm(expected) ? pass(ctx) : fail(ctx));
}

/** JSON-validity structural scorer: output parses as JSON (deeper schema checks land with the suite). */
export const jsonValid: Scorer = async (_input, output, ctx) => {
  try {
    JSON.parse(output.text);
    return pass(ctx);
  } catch {
    return fail(ctx);
  }
};
