import type { TranscriptWord } from '../../../shared/transcript';
import type { TranscriptEvent } from '../core/SttProtocol';
import { firstString, isFiniteNumber, isRecord } from '../json';
import type { SttEvent } from '../SpeechToText';

/**
 * Soniox real-time wire format → tokens, and tokens → the lines Roger saves. Pure, so both are
 * unit-tested without a socket. Shapes follow these docs, read 2026-10-07:
 * - https://soniox.com/docs/api-reference/stt/websocket-api (the response and its tokens, the
 *   finished response, the error response and its codes, the empty text frame that ends a stream)
 * - https://soniox.com/docs/stt/rt/real-time-transcription (tokens are words, parts of words,
 *   punctuation and spaces; a final token is sent once and never again; the non-final tokens are
 *   replaced whole by every response)
 * - https://soniox.com/docs/stt/rt/endpoint-detection (a final `<end>` token ends an utterance)
 * - https://soniox.com/docs/stt/rt/manual-finalization (`finalize`, answered by a final `<fin>`)
 * - https://soniox.com/docs/stt/rt/error-handling (an error response, then the close)
 * - https://soniox.com/docs/stt/rt/connection-keepalive (`keepalive`)
 *
 * Every field is read from `unknown` and checked, as in the other parsers: a message that does not
 * fit comes back as `invalid` (the core logs it without the payload and emits a non-fatal error),
 * never as a throw. Soniox sends a final token once, so a message is refused only when it cannot be
 * read at all: a token with no timing keeps its text, placed where the audio sent ends.
 * M9: with `enable_speaker_diarization` a token also carries `speaker`; read it here.
 */

type InterimEvent = Extract<SttEvent, { type: 'interim' }>;
type FinalEvent = Extract<SttEvent, { type: 'final' }>;

/** One token: a word, part of one, punctuation or a space. Offsets in ms of the stream's audio. */
export interface SonioxToken {
  text: string;
  isFinal: boolean;
  startMs: number;
  endMs: number;
  confidence: number | null;
}

export type ParsedSonioxMessage =
  /** `warning` names data that was dropped while keeping the tokens, for the adapter to log. */
  | { kind: 'tokens'; tokens: SonioxToken[]; finished: boolean; warning?: string }
  /** The error response Soniox sends right before it closes the session. */
  | { kind: 'error'; message: string }
  | { kind: 'invalid'; reason: string };

/**
 * `audioSentMs` is how much audio the adapter has sent so far. It places a token with no timing, so
 * its text is kept (a final token never comes again) and still sorts near where it was spoken.
 */
export function parseSonioxMessage(raw: string, audioSentMs: number): ParsedSonioxMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'invalid', reason: 'not JSON' };
  }
  if (!isRecord(parsed)) return { kind: 'invalid', reason: 'not an object' };
  // Before the tokens: an error response carries `tokens: []` as well.
  if (present(parsed.error_code) || present(parsed.error_type)) {
    return { kind: 'error', message: errorText(parsed) };
  }
  if (!Array.isArray(parsed.tokens)) return { kind: 'invalid', reason: 'no tokens' };
  const finished = parsed.finished ?? false;
  if (typeof finished !== 'boolean') return { kind: 'invalid', reason: 'malformed finished' };

  const tokens: SonioxToken[] = [];
  let untimed = false;
  for (const entry of parsed.tokens) {
    if (!isRecord(entry) || typeof entry.text !== 'string' || typeof entry.is_final !== 'boolean') {
      return { kind: 'invalid', reason: 'malformed token' };
    }
    const startMs = isFiniteNumber(entry.start_ms) ? entry.start_ms : null;
    const endMs = isFiniteNumber(entry.end_ms) ? entry.end_ms : null;
    if (startMs === null || endMs === null) untimed = true;
    tokens.push({
      text: entry.text,
      isFinal: entry.is_final,
      // Whole ms: the API refuses a fractional one (CaptureSession rounds too, CLAUDE.md).
      startMs: Math.round(startMs === null || endMs === null ? audioSentMs : startMs),
      endMs: Math.round(startMs === null || endMs === null ? audioSentMs : endMs),
      confidence: isFiniteNumber(entry.confidence) ? entry.confidence : null,
    });
  }
  return untimed
    ? {
        kind: 'tokens',
        tokens,
        finished,
        warning: 'token without timing: placed at the end of the audio sent',
      }
    : { kind: 'tokens', tokens, finished };
}

/** A field an error response sets; a success response leaves it out (or null, in some clients). */
function present(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/** The vendor's own words, then its code and type (the type is what its docs say to branch on). */
function errorText(error: Record<string, unknown>): string {
  const message = firstString(error.error_message) ?? 'Soniox error';
  const detail = [
    isFiniteNumber(error.error_code) ? String(error.error_code) : null,
    typeof error.error_type === 'string' ? error.error_type : null,
  ].filter((part) => part !== null);
  return detail.length === 0 ? message : `${message} (Soniox error ${detail.join(' ')})`;
}

/**
 * Final marker tokens, never text: `<end>` ends an utterance (endpoint detection, which the start
 * request turns on) and `<fin>` answers a `finalize`.
 */
const LINE_END_MARKERS: ReadonlySet<string> = new Set(['<end>', '<fin>']);

/**
 * Soniox sends tokens, not lines: this gathers one stream's tokens into the lines Roger saves and
 * shows. Final tokens are held until a marker ends the utterance, then become one final line; the
 * line in progress (the held finals, then the latest guesses) shows as one interim, said only when
 * it changed. Pure: no timers, no socket. One per stream, so a reopened session starts empty.
 *
 * Held finals are the one place a Soniox line can be lost: the vendor never sends them again. So
 * every way a stream ends releases them (`flush`): the finished response, and the socket's close
 * (SttProtocolSession.release), the dead-socket terminate and the hard finish timeout included.
 */
export class SonioxLineAssembler {
  private held: SonioxToken[] = [];
  /** The interim last said, so a response that changed nothing says nothing. */
  private shown: string | null = null;

  /** One response's tokens → the lines they ended, then the line in progress if it changed. */
  accept(tokens: readonly SonioxToken[]): TranscriptEvent[] {
    const events: TranscriptEvent[] = [];
    const guesses: SonioxToken[] = [];
    for (const token of tokens) {
      if (LINE_END_MARKERS.has(token.text)) {
        // Always final in the docs; a guess at one is only dropped.
        if (!token.isFinal) continue;
        const line = this.flush();
        if (line !== null) events.push(line);
      } else if (token.isFinal) {
        this.held.push(token);
      } else {
        guesses.push(token);
      }
    }
    const span = spanOf([...this.held, ...guesses]);
    if (span !== null) {
      const interim: InterimEvent = {
        type: 'interim',
        text: span.text,
        startMs: span.startMs,
        endMs: span.endMs,
      };
      const key = `${interim.startMs}:${interim.endMs}:${interim.text}`;
      if (key !== this.shown) {
        this.shown = key;
        events.push(interim);
      }
    }
    return events;
  }

  /**
   * The held finals as a line, or null when none hold a word. The latest guesses are dropped: Soniox
   * never confirmed them, and a stream that ends without its finish lost them to its gap.
   */
  flush(): FinalEvent | null {
    const tokens = this.held;
    this.held = [];
    this.shown = null;
    const span = spanOf(tokens);
    if (span === null) return null;
    return {
      type: 'final',
      text: span.text,
      startMs: span.startMs,
      endMs: span.endMs,
      // The mean word confidence, as for AssemblyAI's lines.
      confidence: mean(span.words.map((word) => word.confidence)),
      words: span.words,
    };
  }
}

interface Span {
  text: string;
  startMs: number;
  endMs: number;
  words: TranscriptWord[];
}

/** Tokens → their text, words and span (first word to last), or null when no word is in them. */
function spanOf(tokens: readonly SonioxToken[]): Span | null {
  const words = toWords(tokens);
  const first = words[0];
  const last = words.at(-1);
  if (first === undefined || last === undefined) return null;
  const text = tokens
    .map((token) => token.text)
    .join('')
    .trim();
  return { text, startMs: first.startMs, endMs: last.endMs, words };
}

/**
 * Tokens → words. Soniox's spaces live in the tokens: a token that starts with whitespace (" are")
 * starts a word, one that ends with it ends one, a space alone (" ") only separates, and a token
 * with none ("ing", "?") belongs to the word before it.
 */
function toWords(tokens: readonly SonioxToken[]): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  let parts: SonioxToken[] = [];
  const endWord = (): void => {
    const word = wordOf(parts);
    if (word !== null) words.push(word);
    parts = [];
  };
  for (const token of tokens) {
    if (/^\s/.test(token.text)) endWord();
    if (token.text.trim() !== '') parts.push(token);
    if (/\s$/.test(token.text)) endWord();
  }
  endWord();
  return words;
}

/** A word's span is its first to its last token; its confidence their mean. */
function wordOf(parts: readonly SonioxToken[]): TranscriptWord | null {
  const first = parts[0];
  const last = parts.at(-1);
  if (first === undefined || last === undefined) return null;
  return {
    text: parts
      .map((part) => part.text)
      .join('')
      .trim(),
    startMs: first.startMs,
    endMs: last.endMs,
    confidence: mean(parts.map((part) => part.confidence)),
  };
}

/** The mean, or null when there is nothing to average or any value is unknown. */
function mean(values: readonly (number | null)[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const value of values) {
    if (value === null) return null;
    sum += value;
  }
  return sum / values.length;
}

/** Client → server. Makes every token so far final; Soniox answers with a final `<fin>`. */
export const SONIOX_FINALIZE = JSON.stringify({ type: 'finalize' });
/** Client → server. Holds a session that is sent no audio open (Soniox: at least every 20 s). */
export const SONIOX_KEEP_ALIVE = JSON.stringify({ type: 'keepalive' });
/**
 * Client → server. An empty TEXT frame ends the stream: Soniox sends its last tokens and the
 * finished response, then closes. An empty binary frame is only an empty audio chunk.
 */
export const SONIOX_END_OF_AUDIO = '';
