import type { TranscriptWord } from '../../shared/transcript';
import type { AudioTimeline } from '../capture/AudioTimeline';

/** A final line of the re-run, in meeting offsets, before it is stored. */
export interface RerunFinal {
  startMs: number;
  endMs: number;
  text: string;
  confidence: number | null;
  /** The vendor's words; empty when it sent none. */
  words: TranscriptWord[];
}

/** A stored line's span: what the re-run must not repeat. */
export interface StoredSpan {
  startMs: number;
  endMs: number;
}

/**
 * A vendor final as meeting offsets: each word and the line through the stream's timeline (whose
 * capture times are meeting offsets here), as one span each (AudioTimeline.toCapturedSpan cuts a
 * spill across the hole between two backup files; two single-edge calls would not), widened over
 * its words as CaptureSession.lineSpan widens a live line: EchoFilter finds call-audio lines by
 * span and trusts every word to lie inside its line. Whole ms, never negative, never ending
 * before it starts: the API refuses a fraction (OffsetMs) and `end_ms < start_ms`.
 */
export function mapFinal(timeline: AudioTimeline, final: RerunFinal): RerunFinal {
  const toMeeting = (span: StoredSpan): StoredSpan => {
    const mapped = timeline.toCapturedSpan(span.startMs, span.endMs) ?? span;
    const startMs = Math.max(0, Math.round(mapped.startMs));
    return { startMs, endMs: Math.max(startMs, Math.round(mapped.endMs)) };
  };
  const words = final.words.map((word) => ({ ...word, ...toMeeting(word) }));
  const span = toMeeting(final);
  return {
    ...final,
    startMs: Math.min(span.startMs, ...words.map((word) => word.startMs)),
    endMs: Math.max(span.endMs, ...words.map((word) => word.endMs)),
    words,
  };
}

/**
 * What of a re-run line the stored lines do not already hold, or null when they hold all of it.
 * The re-run streams each gap with 1 s of audio either side, and a gap row may overlap the lost
 * stream's late finals a little (M2-T6), so the same words come back at the edges. A word is
 * dropped when its middle falls inside a stored line's span: a word astride a line's edge goes to
 * the side that holds more of it, and two hearings of one word never both survive. The text is
 * rebuilt from the words kept, and the span cut to them.
 *
 * A line with no words (an adapter that sends none) has its text spread evenly over its span, as
 * EchoFilter estimates timings, and only its text is rebuilt: the estimates never reach the store.
 */
export function missingPart(line: RerunFinal, stored: readonly StoredSpan[]): RerunFinal | null {
  const held = (span: StoredSpan): boolean => {
    const middle = (span.startMs + span.endMs) / 2;
    return stored.some((other) => other.startMs <= middle && middle <= other.endMs);
  };
  if (line.words.length > 0) {
    const kept = line.words.filter((word) => !held(word));
    if (kept.length === line.words.length) return line;
    const first = kept[0];
    const last = kept.at(-1);
    if (first === undefined || last === undefined) return null;
    return {
      ...line,
      startMs: first.startMs,
      endMs: Math.max(...kept.map((word) => word.endMs)),
      text: kept.map((word) => word.text).join(' '),
      words: kept,
    };
  }
  const texts = line.text.split(/\s+/).filter((text) => text !== '');
  const share = Math.max(0, line.endMs - line.startMs) / Math.max(1, texts.length);
  const tokens = texts.map((text, index) => ({
    text,
    startMs: line.startMs + index * share,
    endMs: line.startMs + (index + 1) * share,
  }));
  const kept = tokens.filter((token) => !held(token));
  if (kept.length === tokens.length) return line;
  const first = kept[0];
  const last = kept.at(-1);
  if (first === undefined || last === undefined) return null;
  return {
    ...line,
    startMs: Math.round(first.startMs),
    endMs: Math.round(last.endMs),
    text: kept.map((token) => token.text).join(' '),
  };
}
