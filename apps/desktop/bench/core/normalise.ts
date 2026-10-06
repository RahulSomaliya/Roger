/**
 * The benchmark's text normaliser. WER, term recall and the draft compare words only after both
 * sides, the hand-fixed reference and the vendor's text, went through this. It is small on purpose,
 * so each rule can be owned and tested one by one (M3 design, "Normaliser"), with no Python
 * dependency.
 *
 * Version 1, in the order applied (`docs/research/stt-benchmark.md` lists the same rules):
 *
 *  1. Unicode NFKC, then lowercase.
 *  2. Curly quotes become straight.
 *  3. A comma between digit groups goes: `1,000` becomes `1000`.
 *  4. `$5` becomes `5 dollars`, with a scale word kept by its number (`$5 million` becomes
 *     `5 million dollars`).
 *  5. `%` becomes `percent`.
 *  6. A point between two letters goes, so a dotted abbreviation is one word (`U.S.` is `us`).
 *  7. Hyphens, dashes and slashes become spaces.
 *  8. Other punctuation and symbols become spaces, except apostrophes inside words (`don't`) and
 *     points inside numbers (`2.5`).
 *  9. The fillers `um uh er ah hmm mm` are removed.
 * 10. `ok` becomes `okay`, `alright` becomes `all right`, and `gonna`, `wanna` and `gotta` become
 *     `going to`, `want to` and `got to`.
 * 11. Spelled-out numbers become digits: cardinals with `hundred`, the scales `thousand` to
 *     `trillion` and `and` (`one hundred and five` is `105`; `a hundred` is `100`), decimals
 *     after `point` (`two point five` is `2.5`), ordinals with their suffix (`twenty first` is
 *     `21st`), and a year said in two pairs after `nineteen` or `twenty` (`twenty twenty six` is
 *     `2026`). A number in digits followed by a scale word is multiplied out (`5 million` is
 *     `5000000`), so it reads the same as the words.
 *
 * Every run stores `NORMALISER_VERSION`. Changing any rule bumps it; stored runs are then scored
 * again (scores are always computed from the stored events, never stored themselves).
 */
export const NORMALISER_VERSION = 1;

/** The normalised words of `text`, in order. */
export function normalise(text: string): string[] {
  const cleaned = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’‚‛′ʼ]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/(?<=\d),(?=\d{3}(?!\d))/g, '')
    .replace(
      /\$\s?(\d+(?:\.\d+)?)(\s+(?:hundred|thousand|million|billion|trillion)\b)?/g,
      '$1$2 dollars',
    )
    .replace(/%/g, ' percent ')
    .replace(/(?<=\p{L})\.(?=\p{L})/gu, '')
    .replace(/[\p{Pd}/]/gu, ' ')
    // Spaces, not deletion: "hello,world" and "so...yeah" are two words each.
    .replace(/[^\p{L}\p{N}\p{M}\s'.]/gu, ' ')
    .replace(/(?<![\p{L}\p{N}\p{M}])'|'(?![\p{L}\p{N}])/gu, ' ')
    .replace(/(?<!\d)\.|\.(?!\d)/g, ' ');
  const words = cleaned
    .split(/\s+/)
    .filter((word) => word !== '' && !FILLERS.has(word))
    .flatMap((word) => SPELLINGS.get(word) ?? [word]);
  return numbersToDigits(words);
}

// Maps, never object literals: a transcript word such as "constructor" must not find
// Object.prototype's members and read as a number or a spelling.
const FILLERS: ReadonlySet<string> = new Set(['um', 'uh', 'er', 'ah', 'hmm', 'mm']);

const SPELLINGS: ReadonlyMap<string, readonly string[]> = new Map([
  ['ok', ['okay']],
  ['alright', ['all', 'right']],
  ['gonna', ['going', 'to']],
  ['wanna', ['want', 'to']],
  ['gotta', ['got', 'to']],
]);

const table = (entries: Record<string, number>): ReadonlyMap<string, number> =>
  new Map(Object.entries(entries));

const DIGITS = table({
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
});
const ONES = table({
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
});
const ORDINAL_ONES = table({
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
});
const TEENS = table({
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
});
const ORDINAL_TEENS = table({
  tenth: 10,
  eleventh: 11,
  twelfth: 12,
  thirteenth: 13,
  fourteenth: 14,
  fifteenth: 15,
  sixteenth: 16,
  seventeenth: 17,
  eighteenth: 18,
  nineteenth: 19,
});
const TENS = table({
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
});
const ORDINAL_TENS = table({
  twentieth: 20,
  thirtieth: 30,
  fortieth: 40,
  fiftieth: 50,
  sixtieth: 60,
  seventieth: 70,
  eightieth: 80,
  ninetieth: 90,
});
/** Scale words by their number of zeros. `hundred` is one too, but it scales only its group. */
const SCALES = table({ hundred: 2, thousand: 3, million: 6, billion: 9, trillion: 12 });
const ORDINAL_SCALES = table({
  hundredth: 2,
  thousandth: 3,
  millionth: 6,
  billionth: 9,
  trillionth: 12,
});
/** The first pair of a year said in two pairs ("nineteen ninety nine", "twenty twenty six"). */
const YEAR_FIRST_PAIRS: ReadonlySet<string> = new Set(['nineteen', 'twenty']);

interface ParsedNumber {
  text: string;
  /** Index of the first word after the number. */
  end: number;
}

interface Cardinal {
  value: number;
  end: number;
  ordinal: boolean;
  /** Made only of ones, teens and tens words: a candidate for the second pair of a year. */
  simple: boolean;
}

function numbersToDigits(words: readonly string[]): string[] {
  const out: string[] = [];
  let index = 0;
  while (index < words.length) {
    const parsed = readWrittenScaled(words, index) ?? readSpelled(words, index);
    if (parsed === null) {
      out.push(words[index] ?? '');
      index += 1;
    } else {
      out.push(parsed.text);
      index = parsed.end;
    }
  }
  return out;
}

/** "5 million", "2.5 billion": a number in digits, then one scale word. */
function readWrittenScaled(words: readonly string[], start: number): ParsedNumber | null {
  const digits = words[start];
  const zeros = SCALES.get(words[start + 1] ?? '');
  if (digits === undefined || zeros === undefined || !/^\d+(?:\.\d+)?$/.test(digits)) return null;
  const [whole = '', fraction = ''] = digits.split('.');
  return { text: shiftPoint(whole, fraction, zeros), end: start + 2 };
}

function readSpelled(words: readonly string[], start: number): ParsedNumber | null {
  const cardinal = readCardinal(words, start);
  if (cardinal === null) return null;
  if (cardinal.ordinal) return { text: withOrdinalSuffix(cardinal.value), end: cardinal.end };
  return (
    readYear(words, start, cardinal) ??
    readDecimal(words, cardinal) ?? { text: String(cardinal.value), end: cardinal.end }
  );
}

/**
 * The longest valid cardinal (or ordinal) from `start`. Words that cannot continue the number end
 * it, so "one two" is two numbers and "five and two" keeps its "and". Values stay below 10^15,
 * well inside a double's exact integers.
 */
function readCardinal(words: readonly string[], start: number): Cardinal | null {
  let total = 0;
  /** The part below the last scale word, not yet multiplied. */
  let group = 0;
  let hasHundreds = false;
  let hasTens = false;
  /** The group's last two digits are complete (a ones or teen word was read). */
  let hasUnits = false;
  let lastScale = Number.POSITIVE_INFINITY;
  /** The word before was `hundred` or a scale, so `and` may follow. */
  let afterScale = false;
  let simple = true;
  let consumed = false;
  let index = start;

  const done = (ordinal: boolean, end: number): Cardinal => ({
    value: total + group,
    end,
    ordinal,
    simple,
  });

  for (; index < words.length; index += 1) {
    const word = words[index] ?? '';

    if (!consumed && word === 'zero')
      return { value: 0, end: index + 1, ordinal: false, simple: false };
    // "a hundred", "a thousand": the article is the number one, but only before a scale word.
    if (!consumed && word === 'a' && isScaleWord(words[index + 1])) {
      group = 1;
      hasUnits = true;
      consumed = true;
      simple = false;
      continue;
    }

    const one = ONES.get(word) ?? ORDINAL_ONES.get(word);
    if (one !== undefined) {
      if (hasUnits) break;
      group += one;
      hasUnits = true;
      consumed = true;
      afterScale = false;
      if (ORDINAL_ONES.has(word)) return done(true, index + 1);
      continue;
    }

    const teenOrTens =
      TEENS.get(word) ?? ORDINAL_TEENS.get(word) ?? TENS.get(word) ?? ORDINAL_TENS.get(word);
    if (teenOrTens !== undefined) {
      if (hasUnits || hasTens) break;
      group += teenOrTens;
      if (teenOrTens < 20) hasUnits = true;
      else hasTens = true;
      consumed = true;
      afterScale = false;
      if (ORDINAL_TEENS.has(word) || ORDINAL_TENS.has(word)) return done(true, index + 1);
      continue;
    }

    const zeros = SCALES.get(word) ?? ORDINAL_SCALES.get(word);
    if (zeros !== undefined) {
      if (zeros === 2) {
        // "fifteen hundred", "twenty five hundred": hundred scales its own group only.
        if (hasHundreds || (consumed && group === 0)) break;
        group = (consumed ? group : 1) * 100;
        hasHundreds = true;
      } else {
        const scale = 10 ** zeros;
        // Scales fall: "thousand million" is two numbers.
        if (scale >= lastScale || (consumed && group === 0)) break;
        total += (consumed ? group : 1) * scale;
        group = 0;
        hasHundreds = false;
        lastScale = scale;
      }
      hasTens = false;
      hasUnits = false;
      afterScale = true;
      simple = false;
      consumed = true;
      if (ORDINAL_SCALES.has(word)) return done(true, index + 1);
      continue;
    }

    // "one hundred and five": "and" belongs to the number only between a scale and the rest.
    if (word === 'and' && afterScale && isBelowHundredWord(words[index + 1])) {
      afterScale = false;
      simple = false;
      continue;
    }
    break;
  }
  return consumed ? done(false, index) : null;
}

/** "nineteen ninety nine" is 1999, not 19 and 99: a year after its first pair. */
function readYear(words: readonly string[], start: number, first: Cardinal): ParsedNumber | null {
  if (first.end !== start + 1 || !YEAR_FIRST_PAIRS.has(words[start] ?? '')) return null;
  const second = readCardinal(words, first.end);
  if (second === null || second.ordinal || !second.simple) return null;
  if (second.value < 10 || second.value > 99) return null;
  return { text: `${first.value}${second.value}`, end: second.end };
}

/** "two point five" is 2.5; "two point five million" is 2500000. */
function readDecimal(words: readonly string[], cardinal: Cardinal): ParsedNumber | null {
  if (words[cardinal.end] !== 'point') return null;
  let index = cardinal.end + 1;
  let fraction = '';
  let digit = DIGITS.get(words[index] ?? '');
  while (digit !== undefined) {
    fraction += String(digit);
    index += 1;
    digit = DIGITS.get(words[index] ?? '');
  }
  if (fraction === '') return null;
  const zeros = SCALES.get(words[index] ?? '');
  if (zeros !== undefined && cardinal.value < 1000) {
    return { text: shiftPoint(String(cardinal.value), fraction, zeros), end: index + 1 };
  }
  return { text: `${cardinal.value}.${fraction}`, end: index };
}

/** `whole.fraction` times 10^zeros, written without exponent or leading zeros: no float rounding. */
function shiftPoint(whole: string, fraction: string, zeros: number): string {
  const moved = (whole + fraction.slice(0, zeros).padEnd(zeros, '0')).replace(/^0+(?=\d)/, '');
  const rest = fraction.slice(zeros);
  return rest === '' ? moved : `${moved}.${rest}`;
}

function withOrdinalSuffix(value: number): string {
  const lastTwo = value % 100;
  const last = value % 10;
  const suffix =
    lastTwo >= 11 && lastTwo <= 13
      ? 'th'
      : last === 1
        ? 'st'
        : last === 2
          ? 'nd'
          : last === 3
            ? 'rd'
            : 'th';
  return `${value}${suffix}`;
}

function isScaleWord(word: string | undefined): boolean {
  return word !== undefined && SCALES.has(word);
}

function isBelowHundredWord(word: string | undefined): boolean {
  if (word === undefined) return false;
  return [ONES, ORDINAL_ONES, TEENS, ORDINAL_TEENS, TENS, ORDINAL_TENS].some((words) =>
    words.has(word),
  );
}
