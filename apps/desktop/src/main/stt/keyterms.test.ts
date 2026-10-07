import { describe, expect, it } from 'vitest';
import { capKeyterms, KEYTERM_LIMITS } from './keyterms';

/** `count` distinct terms of `length` characters each: t0001x..., t0002x..., ... */
function terms(count: number, length = 6): string[] {
  return Array.from({ length: count }, (_, index) =>
    `t${String(index).padStart(4, '0')}`.padEnd(length, 'x'),
  );
}

describe('capKeyterms', () => {
  it('keeps a list inside the limits as it is, in its order', () => {
    expect(capKeyterms(['Roger', 'Linkt', 'AssemblyAI'])).toEqual({
      terms: ['Roger', 'Linkt', 'AssemblyAI'],
      dropped: 0,
    });
    expect(capKeyterms([])).toEqual({ terms: [], dropped: 0 });
  });

  it('trims each term and drops blank ones, over-long ones and ones with control characters', () => {
    const tab = String.fromCharCode(9);
    const del = String.fromCharCode(0x7f);
    const c1 = String.fromCharCode(0x85);
    const result = capKeyterms([
      '  Linkt  ',
      '   ',
      '',
      'x'.repeat(KEYTERM_LIMITS.maxTermChars + 1),
      `Ro${tab}ger`,
      `Ro${del}ger`,
      `Ro${c1}ger`,
      'y'.repeat(KEYTERM_LIMITS.maxTermChars),
    ]);

    expect(result).toEqual({
      terms: ['Linkt', 'y'.repeat(KEYTERM_LIMITS.maxTermChars)],
      dropped: 6,
    });
  });

  it('drops a term that repeats an earlier one in another case: the first spelling wins', () => {
    expect(capKeyterms(['Linkt', 'LINKT', 'linkt ', 'Roger'])).toEqual({
      terms: ['Linkt', 'Roger'],
      dropped: 2,
    });
  });

  it('cuts the list after the term limit', () => {
    const result = capKeyterms(terms(KEYTERM_LIMITS.maxTerms + 20));

    expect(result.terms).toEqual(terms(KEYTERM_LIMITS.maxTerms));
    expect(result.dropped).toBe(20);
  });

  it('cuts the list before the term that would pass the character limit', () => {
    // 20 terms of 50 characters: 16 fill exactly 800, the 17th would pass it.
    const result = capKeyterms(terms(20, 50));

    expect(KEYTERM_LIMITS.maxTotalChars).toBe(800);
    expect(result.terms).toEqual(terms(16, 50));
    expect(result.dropped).toBe(4);
  });

  it('counts characters as the API does, by code point, so an emoji counts once', () => {
    // 49 letters plus one astral character: 50 code points (Python len), 51 UTF-16 units.
    const term = `${'a'.repeat(49)}\u{1F600}`;
    expect(capKeyterms([term])).toEqual({ terms: [term], dropped: 0 });
  });
});
