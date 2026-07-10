import { describe, it, expect } from "vitest";
import {
  mean,
  sampleVariance,
  sampleStd,
  perCaseMeans,
  grandMean,
  percentile,
  pairedDifferenceTest,
  winRateVsAnchor,
  rankBands,
  benjaminiHochberg,
  studentTTwoSidedP,
  incompleteBeta,
  mulberry32,
  type Sample,
} from "../../src/harness/stats";

/**
 * GOLDEN tests: every closed-form stats function pinned to a value computed BY HAND, so a
 * regression in the math is caught, not masked. The bootstrap's randomized behavior is
 * pinned separately (stats-property.test.ts) since it has no single hand-computed value.
 * `npm run stats:golden` runs this directory.
 */
describe("stats golden — elementary moments", () => {
  it("mean / variance / std of [1,2,3,4] (hand-computed)", () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    // var = (1.5^2 + 0.5^2 + 0.5^2 + 1.5^2)/3 = 5/3
    expect(sampleVariance([1, 2, 3, 4])).toBeCloseTo(5 / 3, 12);
    expect(sampleStd([1, 2, 3, 4])).toBeCloseTo(1.2909944487, 9);
  });

  it("perCaseMeans collapses trials; grandMean weights cases equally", () => {
    const sample: Sample = [
      [1, 3], // case mean 2
      [2, 4], // case mean 3
    ];
    expect(perCaseMeans(sample)).toEqual([2, 3]);
    expect(grandMean(sample)).toBe(2.5);
    // A 100-trial case and a 1-trial case count EQUALLY (trials never inflate n).
    const uneven: Sample = [Array(100).fill(1), [0]];
    expect(grandMean(uneven)).toBe(0.5);
  });

  it("percentile uses type-7 linear interpolation", () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([0, 10], 0.025)).toBeCloseTo(0.25, 12);
    expect(percentile([0, 10], 0.975)).toBeCloseTo(9.75, 12);
  });
});

describe("stats golden — paired-per-case test (arXiv 2411.00640)", () => {
  it("df=1, t=1 gives EXACTLY p=0.5 (Cauchy identity 1 - 2*arctan(t)/pi)", () => {
    // diffs = [2, 0]: mean=1, sd=|2-0|/sqrt(2)=1.4142, se=sd/sqrt(2)=1, t=1, df=1.
    const candidate: Sample = [[2], [2]];
    const anchor: Sample = [[0], [2]];
    const r = pairedDifferenceTest(candidate, anchor);
    expect(r.meanDiff).toBeCloseTo(1, 12);
    expect(r.se).toBeCloseTo(1, 12);
    expect(r.t).toBeCloseTo(1, 12);
    expect(r.df).toBe(1);
    expect(r.pValue).toBeCloseTo(0.5, 9); // exact for df=1, t=1
    expect(r.cohenD).toBeCloseTo(1 / Math.SQRT2, 9);
  });

  it("diffs=[1,2,3,4]: matches the t-table (t=3.873, df=3, two-sided p≈0.0305)", () => {
    const candidate: Sample = [[2], [3], [4], [5]];
    const anchor: Sample = [[1], [1], [1], [1]];
    const r = pairedDifferenceTest(candidate, anchor);
    expect(r.meanDiff).toBe(2.5);
    expect(r.se).toBeCloseTo(0.6454972244, 9);
    expect(r.t).toBeCloseTo(3.8729833462, 8);
    expect(r.df).toBe(3);
    expect(r.pValue).toBeCloseTo(0.0305, 3); // t-table anchored
    // 95% CI: 2.5 ± t_0.975,3 (=3.1824) * 0.64550
    expect(r.ciLow).toBeCloseTo(0.4457, 3);
    expect(r.ciHigh).toBeCloseTo(4.5543, 3);
  });

  it("degenerate single-case comparison → no evidence, never NaN", () => {
    const r = pairedDifferenceTest([[1]], [[0]]);
    expect(r.pValue).toBe(1);
    expect(Number.isNaN(r.t)).toBe(false);
  });
});

describe("stats golden — win-rate-vs-anchor", () => {
  it("tie is NOT a win; point estimate is the case win-rate", () => {
    // candidate wins 2 of 4 cases; a tie counts as 0.
    const verdicts = [
      [["candidate"]],
      [["candidate"]],
      [["anchor"]],
      [["tie"]],
    ].map((c) => c[0]!) as ("candidate" | "anchor" | "tie")[][];
    const r = winRateVsAnchor(verdicts, { rng: mulberry32(1), b: 500 });
    expect(r.point).toBe(0.5);
    expect(r.n).toBe(4);
    expect(r.ciLow).toBeLessThanOrEqual(0.5);
    expect(r.ciHigh).toBeGreaterThanOrEqual(0.5);
  });
});

describe("stats golden — rank banding", () => {
  it("overlapping CIs tie; a disjoint CI opens a new rank", () => {
    const banded = rankBands([
      { id: "A", value: 0.8, ciLow: 0.7, ciHigh: 0.9 },
      { id: "B", value: 0.75, ciLow: 0.65, ciHigh: 0.85 },
      { id: "C", value: 0.3, ciLow: 0.2, ciHigh: 0.4 },
    ]);
    const byId = Object.fromEntries(banded.map((e) => [e.id, e]));
    expect(byId.A!.rank).toBe(1);
    expect(byId.B!.rank).toBe(1); // overlaps A → tie-band
    expect(byId.A!.tie).toBe(true);
    expect(byId.B!.tie).toBe(true);
    expect(byId.C!.rank).toBe(2); // disjoint from B → strict rank
    expect(byId.C!.tie).toBe(false);
  });

  it("conservative: A~B, B~C, but A disjoint C still ties all three (no unsupported rank)", () => {
    const banded = rankBands([
      { id: "A", value: 0.9, ciLow: 0.55, ciHigh: 0.95 },
      { id: "B", value: 0.7, ciLow: 0.45, ciHigh: 0.75 },
      { id: "C", value: 0.5, ciLow: 0.35, ciHigh: 0.5 }, // disjoint from A ([0.55,0.95]) but overlaps B
    ]);
    expect(new Set(banded.map((e) => e.rank))).toEqual(new Set([1]));
    expect(banded.every((e) => e.tie)).toBe(true);
  });
});

describe("stats golden — Benjamini-Hochberg FDR", () => {
  it("p=[.01,.02,.03,.04,.05] at FDR .05 → all q=0.05, all rejected", () => {
    const r = benjaminiHochberg([0.01, 0.02, 0.03, 0.04, 0.05], 0.05);
    for (const q of r.qValues) expect(q).toBeCloseTo(0.05, 12);
    expect(r.rejected).toEqual([true, true, true, true, true]);
    expect(r.threshold).toBeCloseTo(0.05, 12);
  });

  it("p=[.001,.5] → q=[0.002,0.5]; only the first rejects", () => {
    const r = benjaminiHochberg([0.001, 0.5], 0.05);
    expect(r.qValues[0]).toBeCloseTo(0.002, 12);
    expect(r.qValues[1]).toBeCloseTo(0.5, 12);
    expect(r.rejected).toEqual([true, false]);
  });

  it("q-values are order-independent (shuffled input, same q per hypothesis)", () => {
    const r = benjaminiHochberg([0.04, 0.01, 0.05, 0.02, 0.03], 0.05);
    for (const q of r.qValues) expect(q).toBeCloseTo(0.05, 12);
    expect(r.rejected).toEqual([true, true, true, true, true]);
  });
});

describe("stats golden — incomplete beta sanity", () => {
  it("I_x(a,b) endpoints and the symmetry I_x(a,b)=1-I_{1-x}(b,a)", () => {
    expect(incompleteBeta(0, 2, 3)).toBe(0);
    expect(incompleteBeta(1, 2, 3)).toBe(1);
    expect(incompleteBeta(0.5, 2, 2)).toBeCloseTo(0.5, 9); // symmetric a=b
    expect(incompleteBeta(0.3, 2, 5)).toBeCloseTo(1 - incompleteBeta(0.7, 5, 2), 9);
  });

  it("studentTTwoSidedP(0, df)=1 and shrinks toward 0 for large t", () => {
    expect(studentTTwoSidedP(0, 10)).toBeCloseTo(1, 9);
    expect(studentTTwoSidedP(10, 10)).toBeLessThan(0.001);
  });
});
