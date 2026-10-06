import { describe, expect, it } from 'vitest';
import {
  BOOTSTRAP_RESAMPLES,
  BOOTSTRAP_SEED,
  type RatioSample,
  bootstrapInterval,
  seededRandom,
} from './bootstrap';

/** Ten items with word error rates from 5% to 30%, 100 to 280 words each. */
const ITEMS: RatioSample[] = [5, 12, 8, 30, 20, 9, 15, 11, 25, 7].map((errors, index) => ({
  numerator: errors * (1 + index / 5),
  denominator: 100 * (1 + index / 5),
}));
const pooled = (samples: RatioSample[]): number =>
  samples.reduce((sum, item) => sum + item.numerator, 0) /
  samples.reduce((sum, item) => sum + item.denominator, 0);

describe('seededRandom', () => {
  it('gives the same sequence for the same seed, in [0, 1)', () => {
    const first = seededRandom(42);
    const second = seededRandom(42);
    const values = Array.from({ length: 1_000 }, () => first());

    expect(values).toEqual(Array.from({ length: 1_000 }, () => second()));
    expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
    expect(new Set(values).size).toBeGreaterThan(990);
  });

  it('gives another sequence for another seed', () => {
    const a = seededRandom(1);
    const b = seededRandom(2);

    expect([a(), a(), a()]).not.toEqual([b(), b(), b()]);
  });
});

describe('bootstrapInterval', () => {
  it('uses a fixed seed and 2000 resamples at 95% by default, and says so', () => {
    const interval = bootstrapInterval(ITEMS);

    expect(interval).toMatchObject({
      confidence: 0.95,
      resamples: BOOTSTRAP_RESAMPLES,
      seed: BOOTSTRAP_SEED,
    });
    expect(BOOTSTRAP_RESAMPLES).toBe(2_000);
  });

  it('is the same on every run with the same seed', () => {
    expect(bootstrapInterval(ITEMS)).toEqual(bootstrapInterval(ITEMS));
    expect(bootstrapInterval(ITEMS, { seed: 7 })).toEqual(bootstrapInterval(ITEMS, { seed: 7 }));
    expect(bootstrapInterval(ITEMS, { seed: 7 })).not.toEqual(bootstrapInterval(ITEMS));
  });

  it('brackets the pooled rate, and narrows as the confidence drops', () => {
    const wide = bootstrapInterval(ITEMS);
    const narrow = bootstrapInterval(ITEMS, { confidence: 0.5 });
    const point = pooled(ITEMS);

    expect(wide).not.toBeNull();
    expect(narrow).not.toBeNull();
    if (wide === null || narrow === null) return;
    expect(wide.low).toBeLessThan(point);
    expect(wide.high).toBeGreaterThan(point);
    expect(narrow.low).toBeGreaterThanOrEqual(wide.low);
    expect(narrow.high).toBeLessThanOrEqual(wide.high);
    expect(narrow.high - narrow.low).toBeLessThan(wide.high - wide.low);
  });

  it('resamples whole items, not words', () => {
    // Two items: one perfect, one all wrong. A resample of items is 0, 0.5 or 1; a resample of
    // the 20 words would almost never reach 0 or 1.
    const interval = bootstrapInterval([
      { numerator: 0, denominator: 10 },
      { numerator: 10, denominator: 10 },
    ]);

    expect(interval).toMatchObject({ low: 0, high: 1 });
  });

  it('collapses to the rate when every item has the same rate, or there is one item', () => {
    expect(
      bootstrapInterval([
        { numerator: 1, denominator: 10 },
        { numerator: 3, denominator: 30 },
      ]),
    ).toMatchObject({ low: 0.1, high: 0.1 });
    expect(bootstrapInterval([{ numerator: 2, denominator: 8 }])).toMatchObject({
      low: 0.25,
      high: 0.25,
    });
  });

  it('skips a resample with no reference words, and has no interval when no item has any', () => {
    const interval = bootstrapInterval(
      [
        { numerator: 3, denominator: 0 },
        { numerator: 1, denominator: 10 },
      ],
      { resamples: 400 },
    );

    expect(interval).not.toBeNull();
    // About a quarter of resamples draw the empty item twice; those cannot be scored.
    expect(interval?.resamples).toBeLessThan(400);
    expect(interval?.resamples).toBeGreaterThan(200);
    expect(bootstrapInterval([])).toBeNull();
    expect(bootstrapInterval([{ numerator: 2, denominator: 0 }])).toBeNull();
  });

  it('refuses bad options and bad samples', () => {
    expect(() => bootstrapInterval(ITEMS, { resamples: 0 })).toThrow(RangeError);
    expect(() => bootstrapInterval(ITEMS, { resamples: 1.5 })).toThrow(RangeError);
    expect(() => bootstrapInterval(ITEMS, { confidence: 1 })).toThrow(
      'bootstrap confidence must be above 0 and below 1, got 1',
    );
    expect(() => bootstrapInterval([{ numerator: Number.NaN, denominator: 1 }])).toThrow(
      'bootstrap sample 0 must have finite counts of 0 or more, got NaN / 1',
    );
    expect(() => bootstrapInterval([{ numerator: 1, denominator: -1 }])).toThrow(RangeError);
  });
});
