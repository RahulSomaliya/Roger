/**
 * A bootstrap interval for a pooled rate over bench items (M3 design, "Scoring"): resample whole
 * items with replacement, pool each resample (sum of numerators over sum of denominators), and
 * take the middle `confidence` share of those rates. On 10 clips a 0.5-point WER gap is noise; the
 * interval keeps it from picking the vendor.
 *
 * Items, never words, are resampled: words of one clip share a speaker, a room and a topic, so
 * resampling them would make the interval far too narrow. The seed is fixed, so a run scored twice
 * reports the same interval.
 */

/** One item's share of a pooled rate: WER is errors over reference words. */
export interface RatioSample {
  numerator: number;
  denominator: number;
}

export interface BootstrapOptions {
  resamples?: number;
  seed?: number;
  /** The share of resampled rates the interval holds, above 0 and below 1. */
  confidence?: number;
}

export interface BootstrapInterval {
  low: number;
  high: number;
  confidence: number;
  /** Resamples scored; one whose items have no denominator at all is skipped. */
  resamples: number;
  seed: number;
}

export const BOOTSTRAP_SEED = 20_261_006;
export const BOOTSTRAP_RESAMPLES = 2_000;
const DEFAULT_CONFIDENCE = 0.95;

/** The interval, or null when there is nothing to pool (no items, or no item with a denominator). */
export function bootstrapInterval(
  samples: readonly RatioSample[],
  options: BootstrapOptions = {},
): BootstrapInterval | null {
  const resamples = options.resamples ?? BOOTSTRAP_RESAMPLES;
  const seed = options.seed ?? BOOTSTRAP_SEED;
  const confidence = options.confidence ?? DEFAULT_CONFIDENCE;
  if (!Number.isInteger(resamples) || resamples < 1) {
    throw new RangeError(
      `bootstrap resamples must be a whole number of 1 or more, got ${resamples}`,
    );
  }
  if (!(confidence > 0 && confidence < 1)) {
    throw new RangeError(`bootstrap confidence must be above 0 and below 1, got ${confidence}`);
  }
  samples.forEach((sample, index) => {
    const valid = [sample.numerator, sample.denominator].every(
      (count) => Number.isFinite(count) && count >= 0,
    );
    if (!valid) {
      throw new RangeError(
        `bootstrap sample ${index} must have finite counts of 0 or more, got ` +
          `${sample.numerator} / ${sample.denominator}`,
      );
    }
  });
  if (!samples.some((sample) => sample.denominator > 0)) return null;

  const random = seededRandom(seed);
  const rates: number[] = [];
  // Each resample draws as many items as there are, with replacement.
  const draws = samples.length;
  for (let round = 0; round < resamples; round += 1) {
    let numerator = 0;
    let denominator = 0;
    for (let draw = 0; draw < draws; draw += 1) {
      const sample = samples[Math.floor(random() * draws)];
      numerator += sample?.numerator ?? 0;
      denominator += sample?.denominator ?? 0;
    }
    if (denominator > 0) rates.push(numerator / denominator);
  }
  rates.sort((a, b) => a - b);
  const tail = (1 - confidence) / 2;
  return {
    low: nearestRank(rates, tail),
    high: nearestRank(rates, 1 - tail),
    confidence,
    resamples: rates.length,
    seed,
  };
}

/**
 * Mulberry32: a small, fast 32-bit generator. Not for secrets; only so that the same seed gives
 * the same resamples on every machine and every Node version (Math.random cannot be seeded).
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Nearest-rank percentile of sorted values. */
function nearestRank(sorted: readonly number[], fraction: number): number {
  // The tolerance absorbs float noise: (1 - 0.95) / 2 * 2000 is 50.00000000000004, not 50.
  const rank = Math.max(1, Math.ceil(fraction * sorted.length - 1e-9));
  return sorted[Math.min(rank, sorted.length) - 1] ?? Number.NaN;
}
