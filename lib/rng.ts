/**
 * Seeded RNG. Every stochastic part of Pahunch takes an explicit seed so that a
 * verdict is reproducible: the same request returns the same probability, and a
 * reviewer can rerun the validation and get our numbers rather than numbers
 * close to ours.
 */

export interface Rng {
  /** Uniform on [0, 1). */
  next(): number;
  normal(mean: number, sd: number): number;
  /** Truncated normal, resampled rather than clamped so the mass is not piled at the bound. */
  normalIn(mean: number, sd: number, lo: number, hi: number): number;
  lognormal(median: number, sigma: number): number;
  bernoulli(p: number): boolean;
  pick<T>(items: T[]): T;
}

/** mulberry32: small, fast, good enough statistically for Monte Carlo of this size. */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;

  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // Box-Muller with a cached second deviate.
  let spare: number | null = null;
  const standardNormal = (): number => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = next() * 2 - 1;
      v = next() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const mul = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * mul;
    return u * mul;
  };

  const normal = (mean: number, sd: number): number => mean + sd * standardNormal();

  return {
    next,
    normal,
    normalIn(mean, sd, lo, hi) {
      for (let i = 0; i < 24; i++) {
        const x = normal(mean, sd);
        if (x >= lo && x <= hi) return x;
      }
      return Math.min(hi, Math.max(lo, mean));
    },
    lognormal(median, sigma) {
      return median * Math.exp(sigma * standardNormal());
    },
    bernoulli(p) {
      return next() < p;
    },
    pick(items) {
      return items[Math.floor(next() * items.length) % items.length];
    },
  };
}

/** Linear-interpolated percentile of an unsorted numeric array. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((x, y) => x - y);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function mean(values: number[]): number {
  if (values.length === 0) return NaN;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}
