import { describe, expect, it } from 'vitest';
import { parseReference } from './reference';
import {
  type WerCounts,
  countErrors,
  errorCount,
  errorRate,
  poolCounts,
  scoreSpeakers,
  scoreText,
} from './wer';

const words = (text: string): string[] => (text === '' ? [] : text.split(' '));

const counts = (fields: Partial<WerCounts>): WerCounts => ({
  referenceWords: 0,
  hypothesisWords: 0,
  substitutions: 0,
  deletions: 0,
  insertions: 0,
  ...fields,
});

describe('countErrors', () => {
  it('counts known substitutions, deletions and insertions', () => {
    // The only alignment with 3 edits: ship>shipped, "new" deleted, "morning" inserted.
    const result = countErrors(
      words('we ship the new build on friday'),
      words('we shipped the build on friday morning'),
    );

    expect(result).toEqual({
      referenceWords: 7,
      hypothesisWords: 7,
      substitutions: 1,
      deletions: 1,
      insertions: 1,
    });
    expect(errorCount(result)).toBe(3);
    expect(errorRate(result)).toBeCloseTo(3 / 7, 10);
  });

  it('counts the same total whichever of two equally short alignments it picks', () => {
    // Three substitutions or a substitution, a deletion and an insertion: both are 3 edits.
    const result = countErrors(
      words('the quick brown fox jumps'),
      words('the quack brown jumps over'),
    );

    expect(errorCount(result)).toBe(3);
    expect(errorRate(result)).toBeCloseTo(0.6, 10);
  });

  it('scores a perfect hypothesis 0 and a missing one 1', () => {
    expect(errorRate(countErrors(words('a b c'), words('a b c')))).toBe(0);
    expect(errorRate(countErrors(words('a b c'), []))).toBe(1);
  });

  it('can exceed 1 when the hypothesis adds more words than the reference has', () => {
    expect(errorRate(countErrors(words('yes'), words('yes yes yes')))).toBe(2);
  });

  it('has no rate for an empty reference, but still counts its insertions', () => {
    const inserted = countErrors([], words('words nobody said'));

    expect(inserted).toEqual(counts({ hypothesisWords: 3, insertions: 3 }));
    expect(errorRate(inserted)).toBeNull();
    expect(errorRate(countErrors([], []))).toBeNull();
  });
});

describe('scoreText', () => {
  it('normalises both sides before counting', () => {
    expect(
      scoreText('OK, so twenty five percent of the U.S. team.', 'okay so 25% of the US team'),
    ).toEqual(counts({ referenceWords: 8, hypothesisWords: 8 }));
  });
});

describe('poolCounts', () => {
  it('sums errors and words, so a long item weighs more than a short one', () => {
    const long = counts({ referenceWords: 10, hypothesisWords: 10, substitutions: 1 });
    const short = counts({ referenceWords: 2, hypothesisWords: 2, substitutions: 1 });
    const pooled = poolCounts([long, short]);

    expect(pooled).toEqual(counts({ referenceWords: 12, hypothesisWords: 12, substitutions: 2 }));
    expect(errorRate(pooled)).toBeCloseTo(2 / 12, 10);
    // Not the mean of the two rates, (0.1 + 0.5) / 2 = 0.3.
    expect(errorRate(pooled)).not.toBeCloseTo(0.3, 2);
  });

  it('keeps the insertions of an item with an empty reference', () => {
    const pooled = poolCounts([
      counts({ referenceWords: 4, hypothesisWords: 4 }),
      counts({ hypothesisWords: 2, insertions: 2 }),
    ]);

    expect(errorRate(pooled)).toBe(0.5);
  });

  it('pools nothing into zeros and no rate', () => {
    expect(poolCounts([])).toEqual(counts({}));
    expect(errorRate(poolCounts([]))).toBeNull();
  });
});

describe('scoreSpeakers', () => {
  const { lines } = parseReference(
    [
      '[00:01] Me: We ship Roger on Friday.',
      '[00:04] Them: Great, the team is ready.',
      '[00:07] Me: Okay, thanks.',
    ].join('\n'),
  );

  it('scores Me against the mic stream and Them against the system stream', () => {
    const scores = scoreSpeakers(lines, {
      mic: 'we ship roger on friday ok thanks',
      system: 'great the team is red',
    });

    expect(scores.me).toEqual(counts({ referenceWords: 7, hypothesisWords: 7 }));
    expect(scores.them).toEqual(
      counts({ referenceWords: 5, hypothesisWords: 5, substitutions: 1 }),
    );
  });

  it('leaves Me out of a system-only item, which has no mic stream', () => {
    const themOnly = parseReference('[00:01] Them: hello all').lines;

    expect(scoreSpeakers(themOnly, { mic: null, system: 'hello all' })).toEqual({
      me: null,
      them: counts({ referenceWords: 2, hypothesisWords: 2 }),
    });
  });

  it('counts mic words where the reference has no Me line as insertions', () => {
    const themOnly = parseReference('[00:01] Them: hello all').lines;
    const scores = scoreSpeakers(themOnly, { mic: 'hello all', system: 'hello all' });

    expect(scores.me).toEqual(counts({ hypothesisWords: 2, insertions: 2 }));
  });

  it('refuses Me lines without a mic stream, and Them lines without a system stream', () => {
    expect(() => scoreSpeakers(lines, { mic: null, system: 'x' })).toThrow(
      'the reference has Me lines but the item has no mic stream',
    );
    expect(() => scoreSpeakers(lines, { mic: 'x', system: null })).toThrow(
      'the reference has Them lines but the item has no system stream',
    );
  });
});
