/** Summary statistics for perf series. Pure functions, unit-tested. */

export type Dist = { mean: number; p50: number; p95: number; max: number; min: number; n: number };

/** Percentile by linear interpolation between closest ranks. `p` in [0, 100]. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

export function mean(values: readonly number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

export function median(values: readonly number[]): number {
  return percentile(values, 50);
}

export function dist(values: readonly number[]): Dist {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return { mean: 0, p50: 0, p95: 0, max: 0, min: 0, n: 0 };
  return {
    mean: mean(finite),
    p50: percentile(finite, 50),
    p95: percentile(finite, 95),
    max: Math.max(...finite),
    min: Math.min(...finite),
    n: finite.length,
  };
}

/**
 * Least-squares slope of `ys` over `xs`, in y-units per x-unit. The leak
 * signal: a fitted line ignores the sawtooth of garbage collection and single
 * spikes that a start-versus-end comparison would be fooled by.
 */
export function slope(xs: readonly number[], ys: readonly number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

export const round = (v: number, digits = 2) => Math.round(v * 10 ** digits) / 10 ** digits;
