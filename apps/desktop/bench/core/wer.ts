import { align } from './align';
import { normaliseEach } from './normalise';
import { type ReferenceLine, speakerTexts } from './reference';

/**
 * Word error rate: (substitutions + deletions + insertions) / reference words, on normalised words
 * (M3 design, "Scoring"). Items are pooled by summing the counts, never by averaging rates, so a
 * long item weighs more than a short one.
 */

export interface WerCounts {
  referenceWords: number;
  hypothesisWords: number;
  substitutions: number;
  deletions: number;
  insertions: number;
}

/** The counts for two lists of words that are already normalised. */
export function countErrors(
  reference: readonly string[],
  hypothesis: readonly string[],
): WerCounts {
  const counts: WerCounts = {
    referenceWords: reference.length,
    hypothesisWords: hypothesis.length,
    substitutions: 0,
    deletions: 0,
    insertions: 0,
  };
  for (const step of align(reference, hypothesis)) {
    if (step.op === 'substitute') counts.substitutions += 1;
    else if (step.op === 'delete') counts.deletions += 1;
    else if (step.op === 'insert') counts.insertions += 1;
  }
  return counts;
}

/**
 * The counts for a reference and a hypothesis given as lines or finals, each run through the same
 * normaliser on its own (`normaliseEach`). One whole text is a list of one.
 */
export function scoreTexts(
  referenceTexts: readonly string[],
  hypothesisTexts: readonly string[],
): WerCounts {
  return countErrors(normaliseEach(referenceTexts), normaliseEach(hypothesisTexts));
}

export function errorCount(counts: WerCounts): number {
  return counts.substitutions + counts.deletions + counts.insertions;
}

/**
 * Errors per reference word; above 1 when the hypothesis adds more words than the reference has.
 * Null for an empty reference, whose insertions still count once pooled.
 */
export function errorRate(counts: WerCounts): number | null {
  return counts.referenceWords === 0 ? null : errorCount(counts) / counts.referenceWords;
}

/** Items pooled: every count summed. */
export function poolCounts(counts: Iterable<WerCounts>): WerCounts {
  const pooled: WerCounts = {
    referenceWords: 0,
    hypothesisWords: 0,
    substitutions: 0,
    deletions: 0,
    insertions: 0,
  };
  for (const item of counts) {
    pooled.referenceWords += item.referenceWords;
    pooled.hypothesisWords += item.hypothesisWords;
    pooled.substitutions += item.substitutions;
    pooled.deletions += item.deletions;
    pooled.insertions += item.insertions;
  }
  return pooled;
}

/**
 * One item's vendor finals per stream, in order, or null when the stream is missing. A list, never
 * the finals joined: each is normalised on its own, so a final ending "twenty" and the next one
 * starting "five" stay 20 and 5 instead of reading as 25.
 */
export interface StreamHypotheses {
  /** Me's finals as scored: the mic finals after the echo filter (the caller runs it). */
  mic: readonly string[] | null;
  system: readonly string[] | null;
}

export interface SpeakerCounts {
  /** Null when the item has no mic stream (a system-only meet recording): left out of Me WER. */
  me: WerCounts | null;
  them: WerCounts | null;
}

/** Me is scored against the mic stream and Them against the system stream. */
export function scoreSpeakers(
  reference: readonly ReferenceLine[],
  hypotheses: StreamHypotheses,
): SpeakerCounts {
  return {
    me: scoreSpeaker(reference, 'me', hypotheses.mic, 'Me', 'mic'),
    them: scoreSpeaker(reference, 'them', hypotheses.system, 'Them', 'system'),
  };
}

function scoreSpeaker(
  reference: readonly ReferenceLine[],
  speaker: ReferenceLine['speaker'],
  hypothesis: readonly string[] | null,
  label: string,
  stream: string,
): WerCounts | null {
  const texts = speakerTexts(reference, speaker);
  if (hypothesis !== null) return scoreTexts(texts, hypothesis);
  // Scoring these lines against nothing would count every word as deleted and blame the vendor
  // for an item that was clipped or labelled wrong.
  if (texts.length > 0) {
    throw new Error(`the reference has ${label} lines but the item has no ${stream} stream`);
  }
  return null;
}
