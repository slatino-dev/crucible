import { describe, it, expect } from "vitest";
import {
  bootstrapCI,
  pairedDifferenceTest,
  benjaminiHochberg,
  mulberry32,
  type Sample,
} from "../../src/harness/stats";

/**
 * PROPERTY tests: invariants the stats module must hold for ANY input, the checks the
 * BUILD-PLAN names — (1) the bootstrap CI narrows monotonically with n; (2) the paired
 * test is symmetric under swapping the two models; (3) BH q-values are monotone in the
 * sorted p-values. These pin the randomized bootstrap where a single golden value cannot.
 */
describe("stats property — bootstrap CI narrows with n", () => {
  it("replicating the same case distribution 4x tightens the 95% CI", () => {
    const base: Sample = [[0.2], [0.8], [0.5], [0.6], [0.4]];
    const wide = bootstrapCI(base, { rng: mulberry32(7), b: 3000 });
    // Same underlying distribution, 4x the cases → a narrower interval (SE ~ 1/sqrt(n)).
    const big: Sample = [...base, ...base, ...base, ...base];
    const narrow = bootstrapCI(big, { rng: mulberry32(7), b: 3000 });
    const wideWidth = wide.ciHigh - wide.ciLow;
    const narrowWidth = narrow.ciHigh - narrow.ciLow;
    expect(narrowWidth).toBeLessThan(wideWidth);
    // Both are centered on the same point estimate and bracket it.
    expect(wide.point).toBeCloseTo(narrow.point, 12);
    expect(wide.ciLow).toBeLessThanOrEqual(wide.point);
    expect(wide.ciHigh).toBeGreaterThanOrEqual(wide.point);
  });

  it("a determined mean has a CI that contains it for large B", () => {
    const sample: Sample = [[0.5], [0.5], [0.5], [0.5]];
    const ci = bootstrapCI(sample, { rng: mulberry32(3), b: 1000 });
    expect(ci.point).toBe(0.5);
    expect(ci.ciLow).toBe(0.5);
    expect(ci.ciHigh).toBe(0.5);
  });
});

describe("stats property — paired test symmetric under model swap", () => {
  it("swapping candidate/anchor flips the sign but keeps |t| and p", () => {
    const a: Sample = [[0.9, 0.8], [0.7], [0.6, 0.5], [0.55]];
    const b: Sample = [[0.4, 0.5], [0.6], [0.3, 0.35], [0.5]];
    const ab = pairedDifferenceTest(a, b);
    const ba = pairedDifferenceTest(b, a);
    expect(ab.pValue).toBeCloseTo(ba.pValue, 12);
    expect(ab.meanDiff).toBeCloseTo(-ba.meanDiff, 12);
    expect(ab.t).toBeCloseTo(-ba.t, 9);
    expect(ab.se).toBeCloseTo(ba.se, 12);
    // The CI on the difference also mirrors.
    expect(ab.ciLow).toBeCloseTo(-ba.ciHigh, 9);
    expect(ab.ciHigh).toBeCloseTo(-ba.ciLow, 9);
  });
});

describe("stats property — Benjamini-Hochberg q-values monotone in sorted p", () => {
  it("q-values are non-decreasing along ascending p, and each q in [0,1]", () => {
    const p = [0.001, 0.2, 0.02, 0.5, 0.04, 0.3, 0.008];
    const { qValues } = benjaminiHochberg(p, 0.05);
    // Order indices by ascending p, then assert q is non-decreasing along that order.
    const order = [...p.keys()].sort((i, j) => p[i]! - p[j]!);
    let prev = -Infinity;
    for (const idx of order) {
      const q = qValues[idx]!;
      expect(q).toBeGreaterThanOrEqual(prev - 1e-12);
      expect(q).toBeGreaterThanOrEqual(0);
      expect(q).toBeLessThanOrEqual(1);
      prev = q;
    }
  });

  it("larger target FDR never rejects fewer hypotheses (monotone in fdr)", () => {
    const p = [0.001, 0.01, 0.03, 0.2, 0.5];
    const strict = benjaminiHochberg(p, 0.01).rejected.filter(Boolean).length;
    const loose = benjaminiHochberg(p, 0.1).rejected.filter(Boolean).length;
    expect(loose).toBeGreaterThanOrEqual(strict);
  });
});
