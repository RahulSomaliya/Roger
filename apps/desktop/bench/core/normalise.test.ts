import { describe, expect, it } from 'vitest';
import { NORMALISER_VERSION, normalise } from './normalise';

/** The normalised words of `text`, joined by spaces, so a failure reads as text. */
const n = (text: string): string => normalise(text).join(' ');

describe('normalise (version 1)', () => {
  it('is version 1; every stored run records it, and changing a rule bumps it', () => {
    expect(NORMALISER_VERSION).toBe(1);
  });

  it('returns words; nothing but whitespace and punctuation is no words', () => {
    expect(normalise('Hello there')).toEqual(['hello', 'there']);
    expect(normalise('')).toEqual([]);
    expect(normalise(' ... !? ')).toEqual([]);
  });

  it('applies Unicode NFKC, then lowercases', () => {
    expect(n('\uff2c\uff29\uff2e\uff2b\uff34 \ufb01le Roger')).toBe('linkt file roger');
  });

  it('makes curly quotes straight, so a curly apostrophe stays inside its word', () => {
    expect(n('don\u2019t \u2018quoted\u2019 \u201cthis\u201d')).toBe("don't quoted this");
  });

  it('removes punctuation, keeping apostrophes inside words and points inside numbers', () => {
    expect(n("Hello, world! Isn't it? Yes: it's fine; really.")).toBe(
      "hello world isn't it yes it's fine really",
    );
    expect(n("'Quoted' students' work")).toBe('quoted students work');
    expect(n('Version 2.5. Then 3.')).toBe('version 2.5 then 3');
    expect(n('so...yeah hello,world (aside) "said" #1 & more')).toBe(
      'so yeah hello world aside said 1 more',
    );
  });

  it('joins the letters of a dotted abbreviation, so U.S. and US read the same', () => {
    expect(n('The U.S. and US, e.g. today')).toBe('the us and us eg today');
  });

  it('turns hyphens, dashes and slashes into spaces', () => {
    expect(n('follow-up and/or well\u2014I mean\u2013no')).toBe('follow up and or well i mean no');
  });

  it('removes the fillers um, uh, er, ah, hmm and mm, and only those words', () => {
    expect(n('Um, so uh er ah hmm mm yes')).toBe('so yes');
    expect(n('umbrella hmmm ahead')).toBe('umbrella hmmm ahead');
  });

  it('writes ok as okay, alright as all right, and gonna, wanna, gotta in full', () => {
    expect(n('OK, ok, O.K., okay')).toBe('okay okay okay okay');
    expect(n('Alright, all right')).toBe('all right all right');
    expect(n("I'm gonna, you wanna, we gotta")).toBe("i'm going to you want to we got to");
  });

  describe('spelled-out numbers become digits', () => {
    it('reads cardinals, hyphenated or not', () => {
      expect(n('twenty five')).toBe('25');
      expect(n('twenty-five')).toBe('25');
      expect(n('zero, seven, thirteen, ninety')).toBe('0 7 13 90');
    });

    it('reads hundreds, scales and "and"', () => {
      expect(n('one hundred and five')).toBe('105');
      expect(n('two thousand twenty six')).toBe('2026');
      expect(n('three million four hundred thousand')).toBe('3400000');
      expect(n('two hundred and fifty thousand')).toBe('250000');
      expect(n('fifteen hundred dollars')).toBe('1500 dollars');
      expect(n('a hundred people and a thousand and one nights')).toBe(
        '100 people and 1001 nights',
      );
      expect(n('a hundred percent, hundred percent')).toBe('100 percent 100 percent');
    });

    it('reads a decimal after "point"', () => {
      expect(n('two point five')).toBe('2.5');
      expect(n('three point one four')).toBe('3.14');
      expect(n('zero point five')).toBe('0.5');
      expect(n('two point five million')).toBe('2500000');
    });

    it('reads ordinals with their suffix', () => {
      expect(n('first second third fourth')).toBe('1st 2nd 3rd 4th');
      expect(n('eleventh twelfth thirteenth twentieth')).toBe('11th 12th 13th 20th');
      expect(n('twenty first, twenty second, ninety third')).toBe('21st 22nd 93rd');
      expect(n('one hundred and first, the thousandth')).toBe('101st the 1000th');
    });

    it('reads a year said in two pairs', () => {
      expect(n('nineteen ninety nine')).toBe('1999');
      expect(n('twenty twenty six')).toBe('2026');
      expect(n('twenty twenty')).toBe('2020');
    });

    it('keeps separate numbers apart and leaves words that only look like numbers', () => {
      expect(n('one two three')).toBe('1 2 3');
      expect(n('five and two')).toBe('5 and 2');
      expect(n('the point is a lot')).toBe('the point is a lot');
      expect(n('two point oh')).toBe('2 point oh');
      expect(n('thousands of hundreds')).toBe('thousands of hundreds');
    });

    it('reads words named like Object.prototype members as plain words', () => {
      // Underscores are punctuation, so __proto__ is "proto" by rule 8.
      expect(n('constructor toString hasOwnProperty __proto__')).toBe(
        'constructor tostring hasownproperty proto',
      );
    });

    it('multiplies a written number by a scale word after it', () => {
      expect(n('5 million')).toBe('5000000');
      expect(n('2.5 billion')).toBe('2500000000');
      expect(n('1.234 thousand')).toBe('1234');
      expect(n('1.2345 thousand')).toBe('1234.5');
    });
  });

  it('removes the comma from 1,000', () => {
    expect(n('1,000 and 1,000,000 and 12,5')).toBe('1000 and 1000000 and 12 5');
  });

  it('writes % as percent', () => {
    expect(n('50% and 7 %')).toBe('50 percent and 7 percent');
  });

  it('writes $5 as 5 dollars, keeping a scale word with its number', () => {
    expect(n('$5, $1,500.50 and $5 million')).toBe('5 dollars 1500.50 dollars and 5000000 dollars');
  });

  it('makes what was said and what a vendor wrote read the same', () => {
    const pairs: [said: string, written: string][] = [
      ['twenty five percent', '25%'],
      ['five million dollars', '$5 million'],
      ['two point five', '2.5'],
      ['one thousand five hundred', '1,500'],
      ['the twenty first', 'the 21st'],
      ['in twenty twenty six', 'in 2026'],
      ['okay, alright', 'OK, all right'],
      ['the follow-up', 'the follow up'],
    ];
    for (const [said, written] of pairs) expect(normalise(said)).toEqual(normalise(written));
  });
});
