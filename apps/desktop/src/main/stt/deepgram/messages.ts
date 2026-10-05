import type { TranscriptWord } from '../../../shared/transcript';
import type { SttEvent } from '../SpeechToText';

/**
 * Deepgram streaming wire format → SttEvent. Pure, so it is unit-tested without a socket.
 * Shapes follow the Deepgram SDK types: Results, Metadata, UtteranceEnd, SpeechStarted, Error.
 */

interface DeepgramWord {
  word: string;
  start: number;
  end: number;
  confidence?: number;
  punctuated_word?: string;
}

interface DeepgramAlternative {
  transcript: string;
  confidence?: number;
  words?: DeepgramWord[];
}

interface DeepgramResults {
  type: 'Results';
  start: number;
  duration: number;
  is_final?: boolean;
  speech_final?: boolean;
  from_finalize?: boolean;
  channel: { alternatives: DeepgramAlternative[] };
}

interface DeepgramError {
  type: 'Error';
  description?: string;
  message?: string;
  err_code?: string;
}

export type ParsedDeepgramMessage =
  | { kind: 'event'; event: SttEvent }
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
      return resultsToEvent(parsed as unknown as DeepgramResults);
    case 'Error': {
      const error = parsed as unknown as DeepgramError;
      const message = error.description ?? error.message ?? 'Deepgram error';
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

function resultsToEvent(results: DeepgramResults): ParsedDeepgramMessage {
  const alternative = results.channel.alternatives[0];
  if (!alternative || typeof results.start !== 'number' || typeof results.duration !== 'number') {
    return { kind: 'invalid', reason: 'Results without alternatives or timing' };
  }
  const text = alternative.transcript.trim();
  if (text === '') return { kind: 'ignored', messageType: 'Results(empty)' };

  const startMs = secondsToMs(results.start);
  const endMs = secondsToMs(results.start + results.duration);
  const isFinal = results.is_final === true || results.from_finalize === true;
  if (!isFinal) {
    return { kind: 'event', event: { type: 'interim', text, startMs, endMs } };
  }
  const words: TranscriptWord[] = (alternative.words ?? []).map((word) => ({
    text: word.punctuated_word ?? word.word,
    startMs: secondsToMs(word.start),
    endMs: secondsToMs(word.end),
    confidence: typeof word.confidence === 'number' ? word.confidence : null,
  }));
  return {
    kind: 'event',
    event: {
      type: 'final',
      text,
      startMs,
      endMs,
      confidence: typeof alternative.confidence === 'number' ? alternative.confidence : null,
      words,
    },
  };
}

function secondsToMs(seconds: number): number {
  return Math.round(seconds * 1000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Client → server control messages. */
export const DEEPGRAM_KEEP_ALIVE = JSON.stringify({ type: 'KeepAlive' });
export const DEEPGRAM_FINALIZE = JSON.stringify({ type: 'Finalize' });
export const DEEPGRAM_CLOSE_STREAM = JSON.stringify({ type: 'CloseStream' });
