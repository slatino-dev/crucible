/**
 * Deterministic PRNG for the bootstrap. A seeded generator is a correctness requirement,
 * not a convenience: every Run records its seed (ARCHITECTURE invariant), so a bootstrap
 * CI is reproducible byte-for-byte from the stored seed, and the golden tests can assert
 * exact resampled values. mulberry32 — small, fast, good enough for resampling indices.
 *
 * Pure and allocation-light. Runs inside the RunOrchestrator DO (30s budget), NEVER on the
 * 10ms Worker request path (ARCHITECTURE: "bootstrap-resampling is CPU-bound and runs
 * inside the DO").
 */
export type Rng = () => number;

/** Seeded uniform generator in [0, 1). Same seed ⇒ same stream, on every runtime. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A uniform integer in [0, n). */
export function randInt(rng: Rng, n: number): number {
  return Math.floor(rng() * n);
}

/**
 * Resample `n` indices from [0, n) with replacement — the bootstrap's primary operation.
 * Returned as an array of indices so a caller can resample any parallel array by the same
 * draw (e.g. paired candidate/anchor case arrays stay aligned).
 */
export function resampleIndices(rng: Rng, n: number): number[] {
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = randInt(rng, n);
  return out;
}
