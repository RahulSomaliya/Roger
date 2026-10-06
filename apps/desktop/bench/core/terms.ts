import { normalise } from './normalise';

/**
 * Jargon term metrics (M3 design, "Term metrics"). WER weighs "Linkt" the same as "the", but names
 * are what people notice. For each term, counted on normalised text (so ignoring case):
 * recall = sum of min(reference count, hypothesis count) / sum of reference counts, and
 * false alarms = sum of max(0, hypothesis count - reference count), which catch "linked" turning
 * into "Linkt" once the list biases the vendor.
 */

export interface PreparedTerm {
  /** As the jargon list spells it. */
  term: string;
  /** Its normalised words, matched as a whole phrase. */
  words: string[];
}

export interface PreparedTerms {
  terms: PreparedTerm[];
  /** Terms that normalise to no words ("um", "!!"): they cannot be counted, so reports name them. */
  unscorable: string[];
}

/** The jargon list normalised once per run. Terms that normalise the same are counted once. */
export function prepareTerms(terms: readonly string[]): PreparedTerms {
  const prepared: PreparedTerms = { terms: [], unscorable: [] };
  const seen = new Set<string>();
  for (const term of terms) {
    const words = normalise(term);
    if (words.length === 0) {
      prepared.unscorable.push(term);
      continue;
    }
    const key = words.join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    prepared.terms.push({ term, words });
  }
  return prepared;
}

/** One term's occurrences in one item's reference and hypothesis (one stream, or both). */
export interface TermCount {
  term: string;
  reference: number;
  hypothesis: number;
}

export function countTerms(
  terms: readonly PreparedTerm[],
  referenceText: string,
  hypothesisText: string,
): TermCount[] {
  const reference = normalise(referenceText);
  const hypothesis = normalise(hypothesisText);
  return terms.map(({ term, words }) => ({
    term,
    reference: occurrences(reference, words),
    hypothesis: occurrences(hypothesis, words),
  }));
}

export interface TermScore {
  referenceCount: number;
  recalled: number;
  falseAlarms: number;
  /** Null when no term was said in the reference. */
  recall: number | null;
}

/**
 * Pool counts over terms and items. Pass one count per term per item: min and max are taken per
 * count, so a term heard in one item cannot make up for the same term missed in another.
 */
export function scoreTerms(counts: Iterable<TermCount>): TermScore {
  let referenceCount = 0;
  let recalled = 0;
  let falseAlarms = 0;
  for (const count of counts) {
    referenceCount += count.reference;
    recalled += Math.min(count.reference, count.hypothesis);
    falseAlarms += Math.max(0, count.hypothesis - count.reference);
  }
  return {
    referenceCount,
    recalled,
    falseAlarms,
    recall: referenceCount === 0 ? null : recalled / referenceCount,
  };
}

/** Non-overlapping occurrences of `phrase` in `words`, left to right. */
function occurrences(words: readonly string[], phrase: readonly string[]): number {
  let count = 0;
  let index = 0;
  while (index + phrase.length <= words.length) {
    if (phrase.every((word, offset) => words[index + offset] === word)) {
      count += 1;
      index += phrase.length;
    } else {
      index += 1;
    }
  }
  return count;
}
