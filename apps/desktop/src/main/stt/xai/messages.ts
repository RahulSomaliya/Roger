import type { TranscriptWord } from '../../../shared/transcript';
import type { TranscriptEvent } from '../core/SttProtocol';
import { firstString, isFiniteNumber, isRecord } from '../json';

/**
 * xAI streaming speech-to-text wire format. Pure, so it is unit-tested without a socket. Shapes
 * from https://docs.x.ai/developers/model-capabilities/audio/speech-to-text (read 2026-10-07):
 * `transcript.created` (the server is ready; "wait for this before sending audio"),
 * `transcript.partial` (`text`, `words[]` with `text`, `start`, `end` in seconds, `is_final`,
 * `speech_final`, `start` and `duration` in seconds), `transcript.done` (after `audio.done`) and
 * `error` (`message`; most errors close the connection).
 *
 * Every field is read from `unknown` and checked: a vendor message is untrusted input. A message
 * that does not fit comes back as `invalid` (the adapter logs it and emits a non-fatal error),
 * never as a throw.
 */

/**
 * Client to server control messages. `Finalize` is spelt with a capital F in xAI's docs (its other
 * client message, `audio.done`, is lower case): a lower-case `finalize` is a different message
 * and may be ignored or refused.
 */
export const XAI_FINALIZE = JSON.stringify({ type: 'Finalize' });
export const XAI_AUDIO_DONE = JSON.stringify({ type: 'audio.done' });

/** One `transcript.partial`, in Roger's units. */
export interface XaiPartial {
  /** May be empty: an utterance-final partial can carry no text (the assembler decides). */
  text: string;
  /** `is_final`: the text is locked. With `speechFinal` false it is a chunk of ~3 s of speech. */
  isFinal: boolean;
  /** `speech_final`: the speaker stopped; the text is the complete stitched utterance. */
  speechFinal: boolean;
  startMs: number;
  endMs: number;
  words: TranscriptWord[];
}

export type ParsedXaiMessage =
  | { kind: 'created' }
  /** `warning` names data that was dropped while keeping the partial, for the adapter to log. */
  | { kind: 'partial'; partial: XaiPartial; warning?: string }
  /** `transcript.done` repeats the whole stream's text: lines were already sent, so it is dropped. */
  | { kind: 'done' }
  | { kind: 'error'; message: string }
  | { kind: 'ignored'; messageType: string }
  | { kind: 'invalid'; reason: string };

export function parseXaiMessage(raw: string): ParsedXaiMessage {
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
    case 'transcript.created':
      return { kind: 'created' };
    case 'transcript.partial':
      return parsePartial(parsed);
    case 'transcript.done':
      return { kind: 'done' };
    case 'error':
      return { kind: 'error', message: firstString(parsed.message) ?? 'xAI error' };
    default:
      return { kind: 'ignored', messageType: parsed.type };
  }
}

function parsePartial(message: Record<string, unknown>): ParsedXaiMessage {
  const { text, start, duration } = message;
  if (typeof text !== 'string') return { kind: 'invalid', reason: 'partial without text' };
  if (!isFiniteNumber(start) || !isFiniteNumber(duration)) {
    return { kind: 'invalid', reason: 'partial without timing' };
  }
  const words = parseWords(message.words);
  const partial: XaiPartial = {
    text: text.trim(),
    // Only a real `true` locks text: a string "true" from format drift must not.
    isFinal: message.is_final === true,
    speechFinal: message.speech_final === true,
    startMs: secondsToMs(start),
    endMs: secondsToMs(start + duration),
    words: words ?? [],
  };
  // Word timings are extras: a malformed list costs the timings, never the line itself.
  return words === null
    ? { kind: 'partial', partial, warning: 'word timings dropped: malformed word list' }
    : { kind: 'partial', partial };
}

/** The word list, `[]` when absent, or null when any entry is malformed. */
function parseWords(value: unknown): TranscriptWord[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const words: TranscriptWord[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    if (
      typeof entry.text !== 'string' ||
      !isFiniteNumber(entry.start) ||
      !isFiniteNumber(entry.end)
    ) {
      return null;
    }
    // No confidence: xAI's word objects carry `text`, `start`, `end` and, only with `diarize`, a
    // `speaker`, which Roger never asks for (the mic and call streams are already "me" and "them").
    words.push({
      text: entry.text,
      startMs: secondsToMs(entry.start),
      endMs: secondsToMs(entry.end),
      confidence: null,
    });
  }
  return words;
}

function secondsToMs(seconds: number): number {
  return Math.round(seconds * 1000);
}

/**
 * Turns xAI's three partial states into Roger's two events.
 *
 * `is_final` false: an interim. `is_final` true and `speech_final` false: a chunk of about 3 s that
 * xAI has locked; `speech_final` true: the speaker stopped and the text is the "complete stitched
 * utterance". Only the last is a line: a chunk becomes a line only through the stitched utterance,
 * so saving it as one would save its words twice. Until the utterance ends a locked chunk is kept
 * in front of the next interim, so the live text never drops three seconds of speech.
 *
 * UNCONFIRMED against the real vendor, for the live-key check (the vendor log in
 * docs/research/stt-benchmark.md): that the stitched text repeats the locked chunks and that an
 * interim after a chunk carries only the new words. If either is the other way round, a line
 * repeats or loses a chunk here, and this assembler is the one place to fix it.
 */
export class XaiLineAssembler {
  private chunks: XaiPartial[] = [];
  /** The latest interim of the utterance in progress, for flush(). */
  private pending: XaiPartial | null = null;

  accept(partial: XaiPartial): TranscriptEvent[] {
    if (partial.speechFinal && partial.isFinal) return this.endUtterance(partial);
    if (partial.text === '') return [];
    if (partial.isFinal) {
      this.chunks.push(partial);
      this.pending = null;
      return [this.interim(null)];
    }
    this.pending = partial;
    return [this.interim(partial)];
  }

  /**
   * The utterance in progress as one line: locked chunks plus the latest interim. The stream is
   * over (Stop's `transcript.done`, a vendor error, a dead socket) and xAI never repeats them. Null
   * when nothing is held. Clears what it returns.
   */
  flush(): TranscriptEvent | null {
    const pieces = this.pending === null ? this.chunks : [...this.chunks, this.pending];
    this.chunks = [];
    this.pending = null;
    return joinPieces(pieces);
  }

  private endUtterance(partial: XaiPartial): TranscriptEvent[] {
    // No text on the utterance-final partial (endpointing after a chunk was already locked): the
    // locked chunks are the line, or nothing is.
    const line = partial.text === '' ? this.flush() : toFinal(partial);
    this.chunks = [];
    this.pending = null;
    return line === null ? [] : [line];
  }

  private interim(latest: XaiPartial | null): TranscriptEvent {
    const pieces = latest === null ? this.chunks : [...this.chunks, latest];
    const startMs = pieces[0]?.startMs ?? 0;
    const endMs = pieces[pieces.length - 1]?.endMs ?? startMs;
    return { type: 'interim', text: joinText(pieces), startMs, endMs };
  }
}

function joinText(pieces: readonly XaiPartial[]): string {
  return pieces.map((piece) => piece.text).join(' ');
}

function toFinal(partial: XaiPartial): TranscriptEvent {
  return {
    type: 'final',
    text: partial.text,
    startMs: partial.startMs,
    endMs: partial.endMs,
    confidence: null,
    words: partial.words,
  };
}

function joinPieces(pieces: readonly XaiPartial[]): TranscriptEvent | null {
  const first = pieces[0];
  const last = pieces[pieces.length - 1];
  if (first === undefined || last === undefined) return null;
  return {
    type: 'final',
    text: joinText(pieces),
    startMs: first.startMs,
    endMs: last.endMs,
    confidence: null,
    words: pieces.flatMap((piece) => piece.words),
  };
}
