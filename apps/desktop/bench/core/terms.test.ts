import { describe, expect, it } from 'vitest';
import { type TermCount, countTerms, prepareTerms, scoreTerms } from './terms';

describe('prepareTerms', () => {
  it('normalises each term, keeping the first spelling of duplicates that differ in case', () => {
    const prepared = prepareTerms(['Linkt', 'LINKT', 'Claude Code', 'U.S.']);

    expect(prepared.terms).toEqual([
      { term: 'Linkt', words: ['linkt'] },
      { term: 'Claude Code', words: ['claude', 'code'] },
      { term: 'U.S.', words: ['us'] },
    ]);
    expect(prepared.unscorable).toEqual([]);
  });

  it('lists a term that normalises to no words, which cannot be counted', () => {
    expect(prepareTerms(['um', '!!', 'Roger']).unscorable).toEqual(['um', '!!']);
  });
});

describe('countTerms', () => {
  const { terms } = prepareTerms(['Linkt', 'Roger', 'Claude Code']);

  it('counts each term in the reference and the hypothesis, ignoring case', () => {
    expect(
      countTerms(
        terms,
        ['Linkt built Roger.', 'LINKT ships it; linkt likes it.'],
        ['Linked built roger, Roger and Roger.'],
      ),
    ).toEqual([
      { term: 'Linkt', reference: 3, hypothesis: 0 },
      { term: 'Roger', reference: 1, hypothesis: 3 },
      { term: 'Claude Code', reference: 0, hypothesis: 0 },
    ]);
  });

  it('counts whole words and whole phrases only', () => {
    const [, , claudeCode] = countTerms(
      terms,
      ['We use Claude Code daily.'],
      ['We use Claude daily, code later, and claude code once.'],
    );
    const [linkt] = countTerms(terms, ['linkts linktx'], ['xlinkt']);

    expect(claudeCode).toEqual({ term: 'Claude Code', reference: 1, hypothesis: 1 });
    expect(linkt).toEqual({ term: 'Linkt', reference: 0, hypothesis: 0 });
  });

  it('counts on normalised text, so a number term matches however it was written', () => {
    const counted = countTerms(
      prepareTerms(['Q4 2026']).terms,
      ['Q4 twenty twenty six'],
      ['q4 2026'],
    );

    expect(counted).toEqual([{ term: 'Q4 2026', reference: 1, hypothesis: 1 }]);
  });

  it('normalises each line and each final on its own, so no number term spans two of them', () => {
    // Joined, the reference read "q4 twenty twenty six", the year 2026: a term nobody said.
    const counted = countTerms(
      prepareTerms(['Q4 2026']).terms,
      ['We closed Q4 twenty', 'twenty six people joined'],
      ['We closed Q4 20.', '26 people joined.'],
    );

    expect(counted).toEqual([{ term: 'Q4 2026', reference: 0, hypothesis: 0 }]);
  });
});

describe('scoreTerms', () => {
  it('computes recall as the sum of min counts over the sum of reference counts', () => {
    const counts: TermCount[] = [
      { term: 'Linkt', reference: 3, hypothesis: 1 },
      { term: 'Roger', reference: 1, hypothesis: 3 },
    ];

    expect(scoreTerms(counts)).toEqual({
      referenceCount: 4,
      recalled: 2,
      falseAlarms: 2,
      recall: 0.5,
    });
  });

  it('pools items by term and item, so a hit in one item cannot cover a miss in another', () => {
    const itemA: TermCount = { term: 'Linkt', reference: 2, hypothesis: 0 };
    const itemB: TermCount = { term: 'Linkt', reference: 0, hypothesis: 2 };

    expect(scoreTerms([itemA, itemB])).toEqual({
      referenceCount: 2,
      recalled: 0,
      falseAlarms: 2,
      recall: 0,
    });
  });

  it('has no recall when no term was said, but still counts false alarms', () => {
    expect(scoreTerms([{ term: 'Linkt', reference: 0, hypothesis: 1 }])).toEqual({
      referenceCount: 0,
      recalled: 0,
      falseAlarms: 1,
      recall: null,
    });
    expect(scoreTerms([]).recall).toBeNull();
  });
});
