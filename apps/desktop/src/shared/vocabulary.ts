/**
 * The workspace jargon list's rules (M3 plan, "Jargon list limits"; docs/api-contract.md,
 * "Vocabulary"), shared by both ends of `vocabulary:set`: the editor
 * (renderer/src/settings/vocabularyEditor.ts) refuses a term the API would refuse, and main checks
 * the whole list again before it sends it (main/vocabulary/vocabularyIpc.ts).
 *
 * The numbers must equal the API's (apps/api/src/roger_api/schemas/vocabulary.py and
 * db/models_vocabulary.py) and KEYTERM_LIMITS in main/stt/keyterms.ts, the cut the STT core applies
 * to every stream. vocabulary.test.ts reads the API's source and fails when any of the three
 * drift: change them together, with the contract.
 */
export const VOCABULARY_LIMITS = {
  /** Terms in one list, counted as sent: before the API drops repeats that differ in case. */
  maxTerms: 100,
  /** Characters in one term, after trimming. */
  maxTermChars: 50,
  /** Characters in all terms together, each trimmed. */
  maxTotalChars: 800,
} as const;

/** Why one term cannot be on the list. */
export type TermProblem =
  | { readonly kind: 'blank' }
  | { readonly kind: 'too-long'; readonly length: number }
  | { readonly kind: 'control-character' };

/**
 * Characters as the API counts them (Python `len`, Postgres `char_length`): code points, not the
 * UTF-16 units of `String.length`, or a term ending in an emoji would be refused here and taken
 * there. Counted without building an array, so a pasted megabyte costs no copy.
 */
export function termLength(term: string): number {
  let length = 0;
  // The string iterator yields code points, exactly the API's count (not graphemes).
  for (const _ of term) length += 1;
  return length;
}

/**
 * Why `term` cannot be on the list, or null. Measured after trimming, as the API measures.
 *
 * JavaScript's `trim()` and Python's `strip()` differ on four separators (U+001C to U+001F) and
 * U+0085, which Python strips and this keeps: here they are control characters, so a term that
 * starts or ends with one is refused where the API would have taken it trimmed. Stricter, never
 * looser, so the editor never sends a term the API refuses.
 */
export function termProblem(term: string): TermProblem | null {
  const trimmed = term.trim();
  if (trimmed === '') return { kind: 'blank' };
  if (hasControlCharacter(trimmed)) return { kind: 'control-character' };
  const length = termLength(trimmed);
  if (length > VOCABULARY_LIMITS.maxTermChars) return { kind: 'too-long', length };
  return null;
}

/**
 * Why `PUT /v1/vocabulary` would refuse this list with a 422, or null when it takes it. Repeats
 * that differ only in case are no problem: the API drops them, keeping the first spelling.
 *
 * The answer names a term by its index (`terms[3]`), as the API's 422 names `body.terms[3]`, and
 * never quotes it: main logs it, and terms name clients and colleagues.
 */
export function vocabularyProblem(terms: readonly string[]): string | null {
  const { maxTerms, maxTermChars, maxTotalChars } = VOCABULARY_LIMITS;
  if (terms.length > maxTerms) return `the list has ${terms.length} terms; at most ${maxTerms}`;
  let total = 0;
  for (const [index, term] of terms.entries()) {
    const problem = termProblem(term);
    switch (problem?.kind) {
      case 'blank':
        return `terms[${index}] is blank`;
      case 'control-character':
        return `terms[${index}] has a control character`;
      case 'too-long':
        return `terms[${index}] is ${problem.length} characters long; at most ${maxTermChars}`;
      case undefined:
        total += termLength(term.trim());
    }
  }
  if (total > maxTotalChars) {
    return `the terms add up to ${total} characters; at most ${maxTotalChars} in all`;
  }
  return null;
}

/**
 * True when the API would keep only one of the two: the same after trimming, ignoring case.
 *
 * The API compares with Postgres `lower()`, which differs from `toLowerCase()` on a few non-ASCII
 * letters (a dotted capital I, a final sigma). Where they differ, the editor may call two terms one
 * that the API keeps apart, or the reverse; the API's answer is the list as stored, so the editor
 * shows what was kept either way.
 */
export function sameTerm(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** An array of strings: the shape of a jargon list on every wire it crosses. */
export function isTermList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((term) => typeof term === 'string');
}

/**
 * Unicode's Cc category: U+0000 to U+001F and U+007F to U+009F, the characters the API refuses.
 * Checked by code, not a regex: a control-character class trips ESLint's no-control-regex, and an
 * editor can turn its escapes into the raw characters (CLAUDE.md failure log).
 */
function hasControlCharacter(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}
