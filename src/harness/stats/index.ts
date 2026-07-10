/**
 * Crucible stats module — the mathematical spine, as PURE functions.
 *
 * Everything the honest leaderboard sells lives here: bootstrap 95% CIs resampled over
 * CASES as the primary unit (with the clustered-trial treatment of arXiv 2411.00640 so
 * repeated trials never inflate apparent precision), the paired-per-case comparison test,
 * rank-banding (strict ranks only where intervals separate), win-rate-vs-anchor, and the
 * Benjamini-Hochberg FDR adjustment behind the nightly repeated-testing correction.
 *
 * No I/O, no randomness except an injected seeded {@link Rng}. These run INSIDE the
 * RunOrchestrator DO (30s budget), never on the 10ms Worker request path (ARCHITECTURE).
 * Golden tests pin the closed-form functions to hand-computed values; property tests pin
 * the bootstrap's invariants (CI narrows with n; paired test symmetric; BH monotone).
 */
import { mulberry32, resampleIndices, randInt, type Rng } from "./rng";
import { studentTTwoSidedP, tQuantile } from "./tdist";

export { mulberry32, type Rng } from "./rng";
export { studentTTwoSidedP, studentTCdf, tQuantile, incompleteBeta, lnGamma } from "./tdist";

/** One case's trial values (a case may have n_trials >= 1 observations). */
export type CaseTrials = number[];
/** A sample: cases as the primary unit, each carrying its trials (the clustering). */
export type Sample = CaseTrials[];

// ————— elementary moments —————
export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Unbiased (n-1) sample variance; 0 for n < 2. */
export function sampleVariance(xs: readonly number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return s / (n - 1);
}

export function sampleStd(xs: readonly number[]): number {
  return Math.sqrt(sampleVariance(xs));
}

/** Collapse each case's trials to its mean — the per-case unit the bootstrap resamples. */
export function perCaseMeans(sample: Sample): number[] {
  return sample.map(mean);
}

/** The point estimate: mean over cases of the per-case mean (trials never inflate n). */
export function grandMean(sample: Sample): number {
  return mean(perCaseMeans(sample));
}

// ————— percentile (type-7 linear interpolation) —————
export function percentile(sortedAsc: readonly number[], q: number): number {
  const n = sortedAsc.length;
  if (n === 0) return NaN;
  if (n === 1) return sortedAsc[0]!;
  const h = (n - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  if (lo === hi) return sortedAsc[lo]!;
  return sortedAsc[lo]! + (h - lo) * (sortedAsc[hi]! - sortedAsc[lo]!);
}

// ————— bootstrap CI (clustered: resample cases, then trials within case) —————
export interface CIResult {
  point: number;
  ciLow: number;
  ciHigh: number;
  /** Case count — the primary bootstrap unit, NOT the row/trial count. */
  n: number;
  b: number;
}

export interface BootstrapOpts {
  /** Resamples (default 2000 — enough for a stable 95% CI inside the DO budget). */
  b?: number;
  /** Two-sided miscoverage (default 0.05 → a 95% CI). */
  alpha?: number;
  /** Seeded RNG; pass mulberry32(run.seed) so the CI is reproducible from the stored seed. */
  rng?: Rng;
}

/**
 * Bootstrap CI for the grand mean, resampled over CASES (primary unit) with trials
 * resampled WITHIN each drawn case (the clustered treatment of arXiv 2411.00640). With
 * n_trials = 1 this reduces to the ordinary case bootstrap. The point estimate is the
 * observed grand mean; the interval is the [alpha/2, 1-alpha/2] percentiles of the
 * resampled grand means.
 */
export function bootstrapCI(sample: Sample, opts: BootstrapOpts = {}): CIResult {
  const b = opts.b ?? 2000;
  const alpha = opts.alpha ?? 0.05;
  const rng = opts.rng ?? mulberry32(0x0a55a1);
  const n = sample.length;
  const point = grandMean(sample);
  if (n === 0) return { point: 0, ciLow: 0, ciHigh: 0, n: 0, b };
  if (n === 1) return { point, ciLow: point, ciHigh: point, n: 1, b };

  const stats = new Array<number>(b);
  for (let i = 0; i < b; i++) {
    const caseIdx = resampleIndices(rng, n);
    let acc = 0;
    for (const ci of caseIdx) {
      const trials = sample[ci]!;
      // Resample trials within the drawn case (clustered); mean of the resampled trials.
      if (trials.length <= 1) {
        acc += trials.length === 1 ? trials[0]! : 0;
      } else {
        let tAcc = 0;
        for (let k = 0; k < trials.length; k++) tAcc += trials[randInt(rng, trials.length)]!;
        acc += tAcc / trials.length;
      }
    }
    stats[i] = acc / n;
  }
  stats.sort((x, y) => x - y);
  return {
    point,
    ciLow: percentile(stats, alpha / 2),
    ciHigh: percentile(stats, 1 - alpha / 2),
    n,
    b,
  };
}

// ————— paired-per-case comparison (arXiv 2411.00640) —————
export interface PairedResult {
  /** mean over cases of (mean_trials(candidate_i) - mean_trials(anchor_i)). */
  meanDiff: number;
  /** Clustered standard error: sd(per-case diffs) / sqrt(n_cases). */
  se: number;
  t: number;
  df: number;
  pValue: number;
  ciLow: number;
  ciHigh: number;
  /** Standardized effect size (Cohen's d_z on the per-case differences). */
  cohenD: number;
  n: number;
}

/**
 * Paired-per-case difference test. `candidate` and `anchor` are aligned Samples over the
 * SAME cases (candidate[i] and anchor[i] are the two models' trials on case i). The test
 * collapses trials to a per-case mean, forms per-case differences, and runs a paired
 * t-test on them — the case is the cluster, so repeated trials do not add spurious df.
 * Two-sided p-value is exact (Student's t via the incomplete beta). CI on the mean
 * difference uses the t critical value.
 */
export function pairedDifferenceTest(
  candidate: Sample,
  anchor: Sample,
  opts: { alpha?: number } = {},
): PairedResult {
  const alpha = opts.alpha ?? 0.05;
  const n = Math.min(candidate.length, anchor.length);
  const diffs = new Array<number>(n);
  for (let i = 0; i < n; i++) diffs[i] = mean(candidate[i]!) - mean(anchor[i]!);
  const meanDiff = mean(diffs);
  const sd = sampleStd(diffs);
  const df = n - 1;

  if (n < 2) {
    // A single case cannot estimate between-case variance: no evidence, never NaN.
    return { meanDiff, se: 0, t: 0, df: Math.max(0, df), pValue: 1, ciLow: meanDiff, ciHigh: meanDiff, cohenD: 0, n };
  }
  if (sd === 0) {
    // n >= 2 with zero variance: every case agrees on the same difference. If that shared
    // difference is nonzero the result is deterministic (maximally significant, p -> 0);
    // if it is exactly zero there is no difference at all (p = 1).
    const nonzero = meanDiff !== 0;
    return {
      meanDiff,
      se: 0,
      t: nonzero ? Infinity : 0,
      df,
      pValue: nonzero ? 0 : 1,
      ciLow: meanDiff,
      ciHigh: meanDiff,
      cohenD: 0,
      n,
    };
  }

  const se = sd / Math.sqrt(n);
  const t = meanDiff / se;
  const pValue = studentTTwoSidedP(t, df);
  const tCrit = tQuantile(1 - alpha / 2, df);
  return {
    meanDiff,
    se,
    t,
    df,
    pValue,
    ciLow: meanDiff - tCrit * se,
    ciHigh: meanDiff + tCrit * se,
    cohenD: meanDiff / sd,
    n,
  };
}

// ————— win-rate-vs-anchor —————
export type PairwiseVerdict = "candidate" | "anchor" | "tie";

/**
 * Convert per-case, per-trial pairwise verdicts into a Sample of win indicators (1 when
 * the candidate is preferred, else 0 — a tie is NOT a win, per the swap-resolution rule).
 * The result feeds {@link bootstrapCI} to produce win-rate-vs-anchor with a CI over cases.
 */
export function winIndicatorSample(verdicts: PairwiseVerdict[][]): Sample {
  return verdicts.map((caseTrials) => caseTrials.map((v) => (v === "candidate" ? 1 : 0)));
}

/** Win-rate-vs-anchor point estimate + bootstrap CI over cases. */
export function winRateVsAnchor(verdicts: PairwiseVerdict[][], opts: BootstrapOpts = {}): CIResult {
  return bootstrapCI(winIndicatorSample(verdicts), opts);
}

// ————— rank banding (strict ranks only where 95% CIs separate) —————
export interface RankEntry {
  id: string;
  value: number;
  ciLow: number;
  ciHigh: number;
}
export interface BandedEntry extends RankEntry {
  /** 1-based band index — shared by every member of a tie-band. */
  rank: number;
  /** True when this entry shares its band with at least one other (an overlapping ranking). */
  tie: boolean;
}

/** Do two closed intervals intersect? */
function overlaps(a: RankEntry, b: RankEntry): boolean {
  return a.ciLow <= b.ciHigh && b.ciLow <= a.ciHigh;
}

/**
 * Assign rank bands. Entries are sorted by value descending; a new entry opens a new band
 * only when its CI is DISJOINT from the previous entry's CI, so overlapping models share a
 * tie-band at the same rank ("ranks shown only where the intervals separate"). Consecutive-
 * overlap banding is deliberately conservative: if A overlaps B and B overlaps C but A is
 * disjoint from C, all three still tie — the product never asserts a rank it cannot support.
 * Ties in `value` are broken by `id` for a deterministic, stable order.
 */
export function rankBands(entries: readonly RankEntry[]): BandedEntry[] {
  const sorted = [...entries].sort((a, b) => (b.value - a.value) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out: BandedEntry[] = [];
  let band = 1;
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i]!;
    if (i > 0 && !overlaps(sorted[i - 1]!, cur)) band += 1;
    out.push({ ...cur, rank: band, tie: false });
  }
  // Mark ties: any band with more than one member.
  const counts = new Map<number, number>();
  for (const e of out) counts.set(e.rank, (counts.get(e.rank) ?? 0) + 1);
  for (const e of out) e.tie = (counts.get(e.rank) ?? 0) > 1;
  return out;
}

// ————— Benjamini-Hochberg FDR (the nightly repeated-testing correction) —————
export interface BHResult {
  /** FDR-adjusted p-values (q-values) in the SAME order as the input p-values. */
  qValues: number[];
  /** Whether each hypothesis is rejected at the target FDR, input order. */
  rejected: boolean[];
  /** The largest p-value that clears the BH threshold (0 if none reject). */
  threshold: number;
}

/**
 * Benjamini-Hochberg step-up procedure at false-discovery rate `fdr` (default 0.05).
 * Sort p ascending p_(1..m); q_(i) = min over k>=i of (m * p_(k) / k), enforced monotone
 * non-decreasing; reject all hypotheses with p <= the largest p_(i) satisfying
 * p_(i) <= (i/m)*fdr. Returns q-values and rejection flags in the ORIGINAL order — this is
 * the pure function behind the nightly family-wise correction (a raw single-night alpha hit
 * is stored `unconfirmed` and only publishes as a regression after it clears this).
 */
export function benjaminiHochberg(pValues: readonly number[], fdr = 0.05): BHResult {
  const m = pValues.length;
  if (m === 0) return { qValues: [], rejected: [], threshold: 0 };
  const order = [...pValues.keys()].sort((a, b) => pValues[a]! - pValues[b]!);

  // Step-up q-values: walk from the largest p to the smallest, carrying the running min.
  const qSorted = new Array<number>(m);
  let running = Infinity;
  for (let rank = m; rank >= 1; rank--) {
    const idx = order[rank - 1]!;
    const q = Math.min(1, (pValues[idx]! * m) / rank);
    running = Math.min(running, q);
    qSorted[rank - 1] = running;
  }

  // Rejection threshold: largest rank i with p_(i) <= (i/m)*fdr.
  let threshold = 0;
  for (let rank = m; rank >= 1; rank--) {
    const idx = order[rank - 1]!;
    if (pValues[idx]! <= (rank / m) * fdr) {
      threshold = pValues[idx]!;
      break;
    }
  }

  const qValues = new Array<number>(m);
  const rejected = new Array<boolean>(m);
  for (let rank = 1; rank <= m; rank++) {
    const idx = order[rank - 1]!;
    qValues[idx] = qSorted[rank - 1]!;
    rejected[idx] = pValues[idx]! <= threshold && threshold > 0;
  }
  return { qValues, rejected, threshold };
}
