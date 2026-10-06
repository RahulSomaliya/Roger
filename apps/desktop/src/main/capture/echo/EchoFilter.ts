import type { TranscriptSegment, TranscriptWord } from '../../../shared/transcript';

/**
 * Text-level echo removal (M2 D2). On laptop speakers the mic hears the call audio too, so the
 * vendor writes Them's words a second time under Me. This decides, for one mic line, whether it
 * repeats call-audio lines said at the same moment: hide it, trim the repeated words out, or keep
 * it. The session sink (EchoSink, M2-T14b) applies the decision; this file only decides.
 *
 * Keep it pure: no Electron, no logger, no store, nothing but the type import below. M3-T11's
 * benchmark loads it in plain Node to score Me after the filter; an Electron import breaks the
 * bench, not the app, so the test pins the import list.
 */

/**
 * Version of the rules below. The benchmark stores it with every run (M3 `run.json`), so a stored
 * score can be traced to the filter that produced it: bump it when a rule or threshold changes.
 */
export const ECHO_FILTER_VERSION = 1;

/**
 * A mic word matches a call-audio word with the same normalised text when their start times are
 * at most this far apart on the meeting timeline, in either direction. EchoSink holds a mic line
 * until the call-audio watermark passes the line's end plus this, so both read this one constant.
 */
export const ECHO_MATCH_WINDOW_MS = 700;

/** A line of 3 or more words is hidden when at least this share of its words match. */
const HIDE_RATIO = 0.7;
/** Below the hide ratio, only runs of this many matched words in a row are trimmed. */
const TRIM_MIN_RUN = 3;
/**
 * Lines this short ("yes, exactly") are easily the user's own words said back, so they are hidden
 * only when every word matches and the line overlaps its twin in time by MIN_SHORT_OVERLAP.
 */
const SHORT_LINE_MAX_WORDS = 2;
const MIN_SHORT_OVERLAP = 0.5;

/**
 * Where call audio plays. Only known headphones turn the filter off: an unknown route may be the
 * laptop speakers, which leak call audio into the mic.
 */
export type EchoOutputRoute = 'speakers' | 'headphones' | 'unknown';

/** The fields of a line the filter reads. A `TranscriptSegment` fits. */
export type EchoLine = Pick<TranscriptSegment, 'id' | 'startMs' | 'endMs' | 'text' | 'words'>;

export type EchoDecision =
  | { action: 'keep' }
  /** `echoOf` is the call-audio line that supplied the most matched words. */
  | { action: 'hide'; echoOf: string }
  | {
      action: 'trim';
      echoOf: string;
      /** The kept words joined by spaces; a word that is only punctuation is dropped. */
      text: string;
      /** The line as the vendor wrote it, for the local `original_text` column. */
      originalText: string;
      /** The kept words with their own timings; the line's own value when it had no timings. */
      words: TranscriptWord[] | null;
    };

export function isEchoFilterOn(route: EchoOutputRoute): boolean {
  return route !== 'headphones';
}

/**
 * Decide what to do with one mic line, given the call-audio lines stored so far. Lines far from
 * the mic line are skipped, so the caller may pass every call-audio line of the meeting.
 *
 * Always pass the mic line as the vendor wrote it, also when re-deciding a line already trimmed
 * (a late call-audio twin, a re-run): the 70% share and the runs are measured on the whole line,
 * and a trimmed copy would be judged on what is left, hiding a line the user mostly spoke.
 */
export function filterEcho(
  mic: EchoLine,
  callAudio: readonly EchoLine[],
  route: EchoOutputRoute,
): EchoDecision {
  if (!isEchoFilterOn(route)) return { action: 'keep' };
  const micTokens = tokenize(mic);
  const first = micTokens[0];
  const last = micTokens[micTokens.length - 1];
  if (!first || !last) return { action: 'keep' };

  // A call-audio word can only match if it starts within the window of some mic word. Words lie
  // inside their own line's span, so a line outside this reach has nothing to offer.
  const reachFrom = first.startMs - ECHO_MATCH_WINDOW_MS;
  const reachTo = last.startMs + ECHO_MATCH_WINDOW_MS;
  const callTokens = callAudio
    .filter((line) => line.endMs >= reachFrom && line.startMs <= reachTo)
    .flatMap(tokenize);
  const twins = matchWords(micTokens, callTokens);
  const matched = twins.filter((twin) => twin !== null);

  if (micTokens.length <= SHORT_LINE_MAX_WORDS) {
    const everyWord = matched.length === micTokens.length;
    return everyWord && overlapShare(micTokens, matched) >= MIN_SHORT_OVERLAP
      ? { action: 'hide', echoOf: mostMatchedLine(matched) }
      : { action: 'keep' };
  }
  // A line whose every word sits in a matched run is caught here (100%), so trimming below
  // never leaves an empty line.
  if (matched.length / micTokens.length >= HIDE_RATIO) {
    return { action: 'hide', echoOf: mostMatchedLine(matched) };
  }

  const trimmed = matchedRuns(twins);
  if (trimmed.size === 0) return { action: 'keep' };
  const removed = twins.filter((twin, index): twin is Token => twin !== null && trimmed.has(index));
  const kept = micTokens.filter((_, index) => !trimmed.has(index));
  return {
    action: 'trim',
    echoOf: mostMatchedLine(removed),
    text: kept.map((token) => token.text).join(' '),
    originalText: mic.text,
    words: hasWordTimings(mic)
      ? kept.flatMap((token) => (token.word === null ? [] : [token.word]))
      : mic.words,
  };
}

interface Token {
  lineId: string;
  /** As the vendor wrote it, punctuation and case included. */
  text: string;
  normalized: string;
  startMs: number;
  endMs: number;
  /** The vendor's word, or null when the timing was estimated from the line's span. */
  word: TranscriptWord | null;
}

function hasWordTimings(line: EchoLine): line is EchoLine & { words: TranscriptWord[] } {
  return line.words !== null && line.words.length > 0;
}

/**
 * The line's words, in order, without the ones that are only punctuation. A line without word
 * timings (an adapter that sends none, or a malformed list the parser dropped) has its text
 * spread evenly over its span: echo lines still match, and a trim of such a line rebuilds the
 * text only, so the estimated timings never reach the store.
 */
function tokenize(line: EchoLine): Token[] {
  const tokens: Token[] = hasWordTimings(line)
    ? line.words.map((word) => ({
        lineId: line.id,
        text: word.text,
        normalized: normalizeWord(word.text),
        startMs: word.startMs,
        endMs: word.endMs,
        word,
      }))
    : estimateTimings(line);
  return tokens.filter((token) => token.normalized !== '');
}

function estimateTimings(line: EchoLine): Token[] {
  const texts = line.text.split(/\s+/).filter((text) => text !== '');
  const share = Math.max(0, line.endMs - line.startMs) / Math.max(1, texts.length);
  return texts.map((text, index) => ({
    lineId: line.id,
    text,
    normalized: normalizeWord(text),
    startMs: line.startMs + index * share,
    endMs: line.startMs + (index + 1) * share,
    word: null,
  }));
}

/**
 * Lowercase letters and digits with their combining marks, keeping apostrophes inside a word
 * ("don't", curly ones made straight). Both streams go through the same vendor, so this only has
 * to undo what differs between two hearings of one sentence: case and punctuation. It is not the
 * benchmark's WER normaliser (M3), which also rewrites numbers and fillers.
 */
function normalizeWord(text: string): string {
  return (
    text
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[\u2018\u2019\u02bc]/g, "'")
      // Marks are part of the letter before them: Devanagari, Tamil and Thai write vowels as
      // marks and NFKC does not fold them in, so dropping them made काम and कम (or है,
      // हो and ही) one word and hid the user's own speech. A run of marks with no letter or
      // digit before it (an emoji's variation selector) goes first, or it outlives its emoji.
      .replace(/(?<![\p{L}\p{N}\p{M}])\p{M}+/gu, '')
      .replace(/[^\p{L}\p{N}\p{M}']/gu, '')
      .replace(/^'+|'+$/g, '')
  );
}

/** A mic word, the call-audio words it may repeat (closest first), and the one it was given. */
interface MicSlot {
  twins: Token[];
  twin: Token | null;
}

/**
 * For each mic word, the call-audio word it repeats, or null. Each call-audio word matches one
 * mic word at most, so "no no no" against a single "no" is one match, not three. Within that, as
 * many mic words match as possible (a maximum bipartite matching, Kuhn's augmenting paths).
 *
 * Do not go back to "each mic word takes its closest free twin": with a repeated word and a
 * timeline offset over half the gap between the repeats, an earlier mic word takes the later
 * twin and the later mic word is left with none in the window. That splits an echo run, so a
 * fragment like "to them today" survives a trim and is uploaded twice (the test pins this case).
 * Each word still starts from its closest twin and moves only when a later word needs it, which
 * keeps the overlap check of short lines measured against the nearest twin.
 */
function matchWords(micTokens: readonly Token[], callTokens: readonly Token[]): (Token | null)[] {
  const slots = micTokens.map((micToken): MicSlot => ({
    twins: callTokens
      .filter(
        (callToken) =>
          callToken.normalized === micToken.normalized &&
          Math.abs(callToken.startMs - micToken.startMs) <= ECHO_MATCH_WINDOW_MS,
      )
      .sort(
        (a, b) => Math.abs(a.startMs - micToken.startMs) - Math.abs(b.startMs - micToken.startMs),
      ),
    twin: null,
  }));
  const holders = new Map<Token, MicSlot>();
  // Give `slot` a twin, moving the holder of a taken twin to another of its own if it has one.
  // `visited` stops a path from trying the same call-audio word twice.
  const claim = (slot: MicSlot, visited: Set<Token>): boolean => {
    for (const twin of slot.twins) {
      if (visited.has(twin)) continue;
      visited.add(twin);
      const holder = holders.get(twin);
      if (holder === undefined || claim(holder, visited)) {
        holders.set(twin, slot);
        slot.twin = twin;
        return true;
      }
    }
    return false;
  };
  for (const slot of slots) claim(slot, new Set());
  return slots.map((slot) => slot.twin);
}

/** Indexes of the mic words that sit in a run of TRIM_MIN_RUN or more matched words in a row. */
function matchedRuns(twins: readonly (Token | null)[]): Set<number> {
  const inRuns = new Set<number>();
  let runStart = 0;
  for (let index = 0; index <= twins.length; index += 1) {
    if (index < twins.length && twins[index] !== null) continue;
    if (index - runStart >= TRIM_MIN_RUN) {
      for (let member = runStart; member < index; member += 1) inRuns.add(member);
    }
    runStart = index + 1;
  }
  return inRuns;
}

/** How much of the mic line's span the matched call-audio words cover, from 0 to 1. */
function overlapShare(micTokens: readonly Token[], twins: readonly Token[]): number {
  const micStart = Math.min(...micTokens.map((token) => token.startMs));
  const micEnd = Math.max(...micTokens.map((token) => token.endMs));
  const twinStart = Math.min(...twins.map((token) => token.startMs));
  const twinEnd = Math.max(...twins.map((token) => token.endMs));
  if (micEnd <= micStart) return micStart >= twinStart && micStart <= twinEnd ? 1 : 0;
  const overlap = Math.min(micEnd, twinEnd) - Math.max(micStart, twinStart);
  return Math.max(0, overlap) / (micEnd - micStart);
}

/**
 * The call-audio line most of these words came from. `twins` is in mic-line order and a Map
 * iterates in insertion order, so a tie goes to the line whose word matched earliest in the mic
 * line, whatever order the caller passed the call-audio lines in.
 */
function mostMatchedLine(twins: readonly Token[]): string {
  const counts = new Map<string, number>();
  for (const twin of twins) counts.set(twin.lineId, (counts.get(twin.lineId) ?? 0) + 1);
  let best: string | null = null;
  let bestCount = 0;
  for (const [lineId, count] of counts) {
    if (count > bestCount) {
      best = lineId;
      bestCount = count;
    }
  }
  if (best === null) throw new Error('echo decision without a matched call-audio word');
  return best;
}
