import type { TranscriptWord } from '../../../shared/transcript';
import type { SttEvent } from '../SpeechToText';

/**
 * Deepgram streaming wire format → SttEvent. Pure, so it is unit-tested without a socket.
 * Shapes follow the Deepgram SDK types: Results, Metadata, UtteranceEnd, SpeechStarted, Error.
 *
 * Every field is read from `unknown` and checked: a vendor message is untrusted input, and a cast
 * here once let a Results without `channel` throw a TypeError mid-call. A message that does not fit
 * comes back as `invalid` (the adapter logs it and emits a non-fatal error), never as a throw.
 *
 * Fields read from Results: `start` and `duration` (seconds), `is_final`, `from_finalize`,
 * `channel.alternatives[0]` with `transcript`, `confidence` and `words[]` (`word`,
 * `punctuated_word`, `start`, `end`, `confidence`).
 */

export type ParsedDeepgramMessage =
  /** `warning` names data that was dropped while keeping the event, for the adapter to log. */
  | { kind: 'event'; event: SttEvent; warning?: string }
  | { kind: 'ignored'; messageType: string }
  | { kind: 'invalid'; reason: string };

export function parseDeepgramMessage(raw: string): ParsedDeepgramMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'invalid', reason: 'not JSON' };
  }
  if (!isRecord(parsed) || typeof parsed.type !== 'string') {
    return { kind: 'invalid', reason: 'missing type' };
  }
  switch (parsed.type) {
    case 'Results':
      return resultsToEvent(parsed);
    case 'Error': {
      const message = firstString(parsed.description, parsed.message) ?? 'Deepgram error';
      return { kind: 'event', event: { type: 'error', message, fatal: true } };
    }
    case 'Metadata':
    case 'UtteranceEnd':
    case 'SpeechStarted':
      return { kind: 'ignored', messageType: parsed.type };
    default:
      return { kind: 'ignored', messageType: parsed.type };
  }
}

function resultsToEvent(results: Record<string, unknown>): ParsedDeepgramMessage {
  const { start, duration, channel } = results;
  if (!isFiniteNumber(start) || !isFiniteNumber(duration)) {
    return { kind: 'invalid', reason: 'Results without timing' };
  }
  const alternatives = isRecord(channel) ? channel.alternatives : undefined;
  const alternative: unknown = Array.isArray(alternatives) ? alternatives[0] : undefined;
  if (!isRecord(alternative) || typeof alternative.transcript !== 'string') {
    return { kind: 'invalid', reason: 'Results without a transcript' };
  }
  const text = alternative.transcript.trim();
  if (text === '') return { kind: 'ignored', messageType: 'Results(empty)' };

  const startMs = secondsToMs(start);
  const endMs = secondsToMs(start + duration);
  const isFinal = results.is_final === true || results.from_finalize === true;
  if (!isFinal) {
    return { kind: 'event', event: { type: 'interim', text, startMs, endMs } };
  }
  const words = parseWords(alternative.words);
  const event: SttEvent = {
    type: 'final',
    text,
    startMs,
    endMs,
    confidence: isFiniteNumber(alternative.confidence) ? alternative.confidence : null,
    words: words ?? [],
  };
  // Word timings are extras: a malformed list costs the timings, never the line itself.
  return words === null
    ? { kind: 'event', event, warning: 'word timings dropped: malformed word list' }
    : { kind: 'event', event };
}

/** The word list, `[]` when absent, or null when any entry is malformed. */
function parseWords(value: unknown): TranscriptWord[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const words: TranscriptWord[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const text = firstString(entry.punctuated_word, entry.word);
    if (text === undefined || !isFiniteNumber(entry.start) || !isFiniteNumber(entry.end)) {
      return null;
    }
    words.push({
      text,
      startMs: secondsToMs(entry.start),
      endMs: secondsToMs(entry.end),
      confidence: isFiniteNumber(entry.confidence) ? entry.confidence : null,
    });
  }
  return words;
}

function secondsToMs(seconds: number): number {
  return Math.round(seconds * 1000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string');
}

/** Client → server control messages. */
export const DEEPGRAM_KEEP_ALIVE = JSON.stringify({ type: 'KeepAlive' });
export const DEEPGRAM_FINALIZE = JSON.stringify({ type: 'Finalize' });
export const DEEPGRAM_CLOSE_STREAM = JSON.stringify({ type: 'CloseStream' });
