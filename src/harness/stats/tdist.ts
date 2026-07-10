/**
 * Student's t two-sided p-value via the regularized incomplete beta function.
 *
 * The paired-per-case comparison (arXiv 2411.00640) is a paired t-test on per-case mean
 * differences; its p-value is exact (not a normal approximation) through the identity
 *   P(|T| >= t | df) = I_x(df/2, 1/2),  x = df / (df + t^2).
 * We implement I_x with the Lentz continued fraction (Numerical Recipes betacf), which is
 * accurate to ~1e-10 across the df/t range this product uses and is fully deterministic,
 * so the golden tests can pin p-values against known t-table values.
 *
 * Pure, no I/O. Runs inside the DO.
 */

/** ln(Gamma(x)) — Lanczos approximation (g=7, n=9), accurate to ~1e-13 for x>0. */
export function lnGamma(x: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    // Reflection formula for x < 0.5.
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  }
  x -= 1;
  let a = c[0]!;
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i]! / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** betacf — the continued fraction for the incomplete beta (Numerical Recipes, modified Lentz). */
function betacf(a: number, b: number, x: number): number {
  const FPMIN = 1e-30;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-12) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b). */
export function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = lnGamma(a + b) - lnGamma(a) - lnGamma(b);
  const front = Math.exp(lbeta + a * Math.log(x) + b * Math.log(1 - x));
  // Use the symmetry that makes the continued fraction converge fast.
  if (x < (a + 1) / (a + b + 2)) {
    return (front * betacf(a, b, x)) / a;
  }
  return 1 - (front * betacf(b, a, 1 - x)) / b;
}

/**
 * Two-sided p-value for a t statistic with `df` degrees of freedom.
 * df <= 0 (a degenerate single-case comparison) yields p = 1 (no evidence), never NaN.
 */
export function studentTTwoSidedP(t: number, df: number): number {
  if (!Number.isFinite(t) || df <= 0) return 1;
  const x = df / (df + t * t);
  return incompleteBeta(x, df / 2, 0.5);
}

/** One-sided Student's t CDF: F(t) = P(T <= t | df). */
export function studentTCdf(t: number, df: number): number {
  if (df <= 0) return t < 0 ? 0 : t > 0 ? 1 : 0.5;
  const x = df / (df + t * t);
  const tail = 0.5 * incompleteBeta(x, df / 2, 0.5); // = P(|T| >= |t|)/2
  return t >= 0 ? 1 - tail : tail;
}

/**
 * Inverse Student's t CDF (quantile) via bisection on {@link studentTCdf}. Used to place
 * a t-based confidence interval on the paired mean difference (e.g. tQuantile(0.975, df)).
 * Symmetric distribution, so we bracket by magnitude and sign the result.
 */
export function tQuantile(p: number, df: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  if (p === 0.5) return 0;
  const target = p > 0.5 ? p : 1 - p;
  let lo = 0;
  let hi = 1e6;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (studentTCdf(mid, df) < target) lo = mid;
    else hi = mid;
  }
  const mag = (lo + hi) / 2;
  return p > 0.5 ? mag : -mag;
}
