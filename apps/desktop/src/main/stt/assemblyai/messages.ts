import type { TranscriptWord } from '../../../shared/transcript';
import { firstString, isFiniteNumber, isRecord } from '../json';
import type { SttEvent } from '../SpeechToText';

/**
 * AssemblyAI Universal-Streaming (v3) wire format → SttEvent. Pure, so it is unit-tested without a
 * socket. Shapes follow these docs, read on 2026-10-06:
 * - https://www.assemblyai.com/docs/streaming/api-spec/streaming-websocket (every message and field)
 * - https://www.assemblyai.com/docs/streaming/message-sequence (partials, end of turn, format_turns)
 * - https://www.assemblyai.com/docs/streaming/common-session-errors-and-closures (the Error frame)
 *
 * Every field is read from `unknown` and checked, as in the Deepgram parser: a message that does
 * not fit comes back as `invalid` (the adapter logs it without the payload and emits a non-fatal
 * error), never as a throw.
 *
 * Fields read from Turn: `turn_order`, `end_of_turn`, `turn_is_formatted`, `transcript`, and
 * `words[]` (`text`, `start` and `end` in ms from the session's first audio byte, `confidence`).
 * A turn has no timing of its own: it spans its first to its last word. `end_of_turn_confidence` is
 * how sure the vendor is that the speaker finished, not how well it heard them, so the line's
 * confidence is the mean word confidence instead.
 * M9: with `speaker_labels=true` a Turn also carries `speaker_label`; read it here.
 *
 * Deciding which Turn becomes the one saved line (format_turns sends two) is the adapter's job:
 * this parser reports `turnOrder` and `formatted` with every turn event.
 */

type InterimEvent = Extract<SttEvent, { type: 'interim' }>;
type FinalEvent = Extract<SttEvent, { type: 'final' }>;

export type ParsedAssemblyAiMessage =
  | { kind: 'begin'; sessionId: string }
  | {
      kind: 'turn';
      turnOrder: number;
      formatted: boolean;
      event: InterimEvent | FinalEvent;
      /** Names data that was dropped while keeping the line, for the adapter to log. */
      warning?: string;
    }
  | { kind: 'termination'; audioDurationSeconds: number | null }
  /** Only the fatal error the vendor sends right before it closes the session. */
  | { kind: 'event'; event: Extract<SttEvent, { type: 'error' }> }
  | { kind: 'ignored'; messageType: string }
  | { kind: 'invalid'; reason: string };

/**
 * `audioSentMs` is how much audio the adapter has sent so far. It places a line whose words carry
 * no timing, so the line is kept (a crash or format drift must never cost a line) and still sorts
 * near where it was spoken.
 */
export function parseAssemblyAiMessage(raw: string, audioSentMs: number): ParsedAssemblyAiMessage {
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
    case 'Begin':
      return typeof parsed.id === 'string'
        ? { kind: 'begin', sessionId: parsed.id }
        : { kind: 'invalid', reason: 'Begin without a session id' };
    case 'Turn':
      return turnToEvent(parsed, audioSentMs);
    case 'Termination':
      return {
        kind: 'termination',
        audioDurationSeconds: isFiniteNumber(parsed.audio_duration_seconds)
          ? parsed.audio_duration_seconds
          : null,
      };
    case 'Error': {
      const message = firstString(parsed.error) ?? 'AssemblyAI error';
      const code = isFiniteNumber(parsed.error_code)
        ? ` (AssemblyAI error ${parsed.error_code})`
        : '';
      return { kind: 'event', event: { type: 'error', message: `${message}${code}`, fatal: true } };
    }
    default:
      // SpeechStarted, Heartbeat, SpeakerRevision, and anything added later.
      return { kind: 'ignored', messageType: parsed.type };
  }
}

function turnToEvent(turn: Record<string, unknown>, audioSentMs: number): ParsedAssemblyAiMessage {
  const turnOrder = turn.turn_order;
  if (typeof turnOrder !== 'number' || !Number.isInteger(turnOrder) || turnOrder < 0) {
    return { kind: 'invalid', reason: 'Turn without turn_order' };
  }
  if (typeof turn.transcript !== 'string') {
    return { kind: 'invalid', reason: 'Turn without a transcript' };
  }
  const endOfTurn = optionalBoolean(turn.end_of_turn);
  const formatted = optionalBoolean(turn.turn_is_formatted);
  if (endOfTurn === null || formatted === null) {
    return { kind: 'invalid', reason: 'Turn with a non-boolean flag' };
  }

  const words = parseWords(turn.words);
  // In partials `transcript` holds only the finalized words, so early in a turn it can be empty
  // while `words` already has the live guess. A final's `transcript` is always the whole turn.
  const text =
    turn.transcript.trim() ||
    (endOfTurn
      ? ''
      : (words ?? [])
          .map((word) => word.text)
          .join(' ')
          .trim());
  if (text === '') return { kind: 'ignored', messageType: 'Turn(empty)' };

  const first = words?.[0];
  const last = words?.at(-1);
  const startMs = first?.startMs ?? audioSentMs;
  const endMs = last?.endMs ?? audioSentMs;
  if (!endOfTurn) {
    return { kind: 'turn', turnOrder, formatted, event: { type: 'interim', text, startMs, endMs } };
  }
  const event: FinalEvent = {
    type: 'final',
    text,
    startMs,
    endMs,
    confidence: meanConfidence(words ?? []),
    words: words ?? [],
  };
  // Word timings are extras: a malformed list costs the timings, never the line itself.
  if (words === null) {
    return {
      kind: 'turn',
      turnOrder,
      formatted,
      event,
      warning: 'word timings dropped: malformed word list',
    };
  }
  if (words.length === 0) {
    return {
      kind: 'turn',
      turnOrder,
      formatted,
      event,
      warning: 'no word timings: line placed at the end of the audio sent',
    };
  }
  return { kind: 'turn', turnOrder, formatted, event };
}

/** Absent means false; anything but a boolean is a malformed message (null). */
function optionalBoolean(value: unknown): boolean | null {
  if (value === undefined) return false;
  return typeof value === 'boolean' ? value : null;
}

/** The word list, `[]` when absent, or null when any entry is malformed. Offsets are already ms. */
function parseWords(value: unknown): TranscriptWord[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const words: TranscriptWord[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const { text, start, end, confidence } = entry;
    if (typeof text !== 'string' || !isFiniteNumber(start) || !isFiniteNumber(end)) return null;
    words.push({
      text,
      startMs: Math.round(start),
      endMs: Math.round(end),
      confidence: isFiniteNumber(confidence) ? confidence : null,
    });
  }
  return words;
}

/** Mean word confidence, or null when there are no words or any word has none. */
function meanConfidence(words: TranscriptWord[]): number | null {
  if (words.length === 0) return null;
  let sum = 0;
  for (const word of words) {
    if (word.confidence === null) return null;
    sum += word.confidence;
  }
  return sum / words.length;
}

/** Client → server control message. Flushes the last turn; the server answers with Termination. */
export const ASSEMBLYAI_TERMINATE = JSON.stringify({ type: 'Terminate' });
