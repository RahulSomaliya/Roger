import { describe, expect, it } from 'vitest';
import { type AlignStep, MAX_ALIGN_CELLS, align } from './align';

const words = (text: string): string[] => (text === '' ? [] : text.split(' '));

/** The steps as short codes: "=a" match, "a>b" substitution, "-a" deletion, "+b" insertion. */
function codes(reference: string, hypothesis: string): string[] {
  const ref = words(reference);
  const hyp = words(hypothesis);
  return align(ref, hyp).map((step) => {
    switch (step.op) {
      case 'match':
        return `=${ref[step.reference] ?? '?'}`;
      case 'substitute':
        return `${ref[step.reference] ?? '?'}>${hyp[step.hypothesis] ?? '?'}`;
      case 'delete':
        return `-${ref[step.reference] ?? '?'}`;
      case 'insert':
        return `+${hyp[step.hypothesis] ?? '?'}`;
    }
  });
}

const edits = (steps: AlignStep[]): number => steps.filter((step) => step.op !== 'match').length;

describe('align', () => {
  it('matches identical sequences word for word', () => {
    expect(codes('the call starts now', 'the call starts now')).toEqual([
      '=the',
      '=call',
      '=starts',
      '=now',
    ]);
  });

  it('finds a substitution, a deletion and an insertion', () => {
    expect(codes('we use linkt daily', 'we use linked daily')).toEqual([
      '=we',
      '=use',
      'linkt>linked',
      '=daily',
    ]);
    expect(codes('ship it today', 'ship today')).toEqual(['=ship', '-it', '=today']);
    expect(codes('ship today', 'ship it today')).toEqual(['=ship', '+it', '=today']);
  });

  it('uses the fewest edits', () => {
    expect(codes('a b c', 'a x c d')).toEqual(['=a', 'b>x', '=c', '+d']);
    expect(edits(align(words('one two three four'), words('two three four five')))).toBe(2);
  });

  it('prefers a substitution on a tie, so a swapped word is one disagreement, not two', () => {
    expect(codes('a b', 'b a')).toEqual(['a>b', 'b>a']);
    expect(codes('red', 'blue')).toEqual(['red>blue']);
  });

  it('handles empty sides: all insertions, all deletions, or nothing', () => {
    expect(codes('', 'hello there')).toEqual(['+hello', '+there']);
    expect(codes('hello there', '')).toEqual(['-hello', '-there']);
    expect(codes('', '')).toEqual([]);
  });

  it('visits every word of both sides once, in order', () => {
    const reference = words('so the plan is to ship roger to the team on friday okay');
    const hypothesis = words('so plan is to to ship rogers to team on the friday ok');
    const steps = align(reference, hypothesis);

    const refIndexes = steps.flatMap((step) => (step.reference === null ? [] : [step.reference]));
    const hypIndexes = steps.flatMap((step) => (step.hypothesis === null ? [] : [step.hypothesis]));
    expect(refIndexes).toEqual(reference.map((_, index) => index));
    expect(hypIndexes).toEqual(hypothesis.map((_, index) => index));
    for (const step of steps) {
      if (step.op === 'match') expect(reference[step.reference]).toBe(hypothesis[step.hypothesis]);
      if (step.op === 'substitute') {
        expect(reference[step.reference]).not.toBe(hypothesis[step.hypothesis]);
      }
    }
  });

  it('takes a comparison, for the draft, which aligns two vendors by normalised word', () => {
    const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

    expect(align(['Linkt', 'ships'], ['linkt', 'Ships'], same).map((step) => step.op)).toEqual([
      'match',
      'match',
    ]);
  });

  it('refuses inputs too long to align in memory, naming both lengths', () => {
    const side = Math.ceil(Math.sqrt(MAX_ALIGN_CELLS)) + 1;
    const long = Array.from({ length: side }, () => 'word');

    expect(() => align(long, long)).toThrow(RangeError);
    expect(() => align(long, long)).toThrow(
      `cannot align ${side} reference words with ${side} hypothesis words`,
    );
  });
});
