/**
 * The jargon list's limits, one set for every vendor (M3 plan, "Jargon list limits"). The strictest
 * vendor sets the bar: AssemblyAI takes 100 terms of up to 50 characters; Deepgram takes 500 tokens
 * across all keyterms and rejects the whole request beyond that, which 800 characters only
 * estimates (so a list can still be rejected: SttProtocol.keytermsRejected). The API refuses a list
 * past these limits when it is saved (`PUT /v1/vocabulary`), so this cut is the net for an API that
 * did not: SttConnection applies it to every stream before the protocol sees the list, and a longer
 * list costs the call a few words, never its transcript. Keep the numbers equal to the API's.
 */
export const KEYTERM_LIMITS = {
  maxTerms: 100,
  maxTermChars: 50,
  maxTotalChars: 800,
} as const;

export interface CappedKeyterms {
  /** What the vendor may be sent: trimmed, valid, first spellings, a prefix inside the limits. */
  terms: string[];
  /**
   * How many terms were left out. A count only: terms name clients and colleagues, so a log line
   * carries this, never the terms.
   */
  dropped: number;
}

/**
 * Each term trimmed; a blank one, one over `maxTermChars` or one with a control character dropped;
 * a repeat of an earlier term in another case dropped (the first spelling wins, as on the API).
 * Then the list is cut before the first term that would pass `maxTerms` or `maxTotalChars`, so the
 * vendor gets the list's head, not a reordering.
 */
export function capKeyterms(terms: readonly string[]): CappedKeyterms {
  const kept: string[] = [];
  const seen = new Set<string>();
  let totalChars = 0;
  for (const raw of terms) {
    const term = raw.trim();
    const chars = codePoints(term);
    if (chars === 0 || chars > KEYTERM_LIMITS.maxTermChars || hasControlCharacter(term)) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    if (
      kept.length === KEYTERM_LIMITS.maxTerms ||
      totalChars + chars > KEYTERM_LIMITS.maxTotalChars
    ) {
      break;
    }
    seen.add(key);
    kept.push(term);
    totalChars += chars;
  }
  return { terms: kept, dropped: terms.length - kept.length };
}

/**
 * Characters as the API counts them (Python `len`, Postgres `char_length`): code points, not the
 * UTF-16 units of `String.length`, or a term with an emoji would be cut here and accepted there.
 */
function codePoints(text: string): number {
  // The string iterator yields code points, which is exactly the API's count (not graphemes).
  return Array.from(text).length;
}

/**
 * Unicode's Cc category: U+0000 to U+001F and U+007F to U+009F. Checked by code, not a regex: a
 * control-character class trips ESLint's no-control-regex, and an editor can turn its escapes into
 * the raw characters (CLAUDE.md failure log).
 */
function hasControlCharacter(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}
