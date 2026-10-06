import type { Logger } from '../../logger';
import type { OpenStreamOptions, SttEvent, SttStreamSettings } from '../SpeechToText';
import type { AudioPacing } from './AudioPacer';

/**
 * What a websocket speech-to-text vendor adapter describes, and all it describes. The adapter never
 * opens, times, keeps alive or closes a socket: SttConnection (SttConnection.ts) does that once for
 * every vendor. Vendors bill the time a session is open (AssemblyAI by the second, silent or not),
 * so a lifecycle written per adapter is a lifecycle that leaks per adapter; this split is how a new
 * vendor gets the careful one for free. The conformance suite (conformance.test.ts) proves it.
 */

export type TranscriptEvent = Extract<SttEvent, { type: 'interim' | 'final' }>;

/** Where to connect and how to authenticate. The URL may carry the token: never log it. */
export interface SttConnectTarget {
  url: string;
  headers: Record<string, string>;
}

/** What one text message from the vendor means. */
export type SttProtocolMessage =
  /** Lines to show and save, in order. May be empty (a copy the adapter already saved). */
  | { kind: 'transcript'; events: TranscriptEvent[]; warning?: string }
  /** The vendor's ready signal, for `readyOn: 'ready-message'` (AssemblyAI's Begin). */
  | { kind: 'ready'; sessionId: string | null }
  /**
   * The completion signal of the finish sequence, for `finishedOn: 'finished-message'`
   * (AssemblyAI's Termination): the core closes the socket on it. `events` are lines it releases;
   * they are emitted before "closed". Under `vendor-close` only its lines count: the core still
   * waits for the vendor's close.
   */
  | { kind: 'finished'; events: TranscriptEvent[] }
  /** A fatal error the vendor reports before it closes the session. */
  | { kind: 'vendor-error'; message: string }
  | { kind: 'ignored'; messageType: string }
  /** Unreadable (format drift). Becomes a non-fatal error; the stream goes on. Never a throw. */
  | { kind: 'invalid'; reason: string };

/** What the core hands one stream's protocol session. */
export interface SttProtocolContext {
  readonly logger: Logger;
  readonly settings: SttStreamSettings;
  /** Audio sent so far, in ms of the stream's PCM: the vendor's clock for lines with no timings. */
  audioSentMs(): number;
  /** A line the session releases on its own (a timer). Dropped once the stream has closed. */
  emit(event: TranscriptEvent): void;
}

/** Per-stream protocol state: frame sizing, held lines. Created once the socket exists. */
export interface SttProtocolSession {
  /** One chunk of Int16 mono PCM → the binary frames to send now (may be none, or several). */
  encodeAudio(pcm: Uint8Array): Uint8Array[];
  /**
   * What Stop sends, in order: any held audio first, then the vendor's control messages. The core
   * sends it after the audio still waiting for its pace, and paces the audio in it too.
   */
  finishSequence(): (string | Uint8Array)[];
  read(raw: string): SttProtocolMessage;
  /** The socket closed: clear timers, return lines still held. They are emitted before "closed". */
  release(): TranscriptEvent[];
}

export interface SttProtocol {
  /** The provider id the API names in /v1/stt/token, e.g. "assemblyai". */
  readonly provider: string;
  /** For people: error text and logs, e.g. "AssemblyAI". */
  readonly vendorName: string;
  /** Throws SttConnectError when the settings cannot work; no socket is opened then. */
  target(options: OpenStreamOptions): SttConnectTarget;
  /** `socket-open`: the handshake is the ready signal (Deepgram). Otherwise wait for `ready`. */
  readonly readyOn: 'socket-open' | 'ready-message';
  /**
   * `finished-message`: the vendor answers the finish sequence with a message (`finished`) and the
   * core then closes the socket. `vendor-close`: the vendor closes the socket itself (Deepgram), and
   * the core ignores any `finished` until then. Either way the core's hard finish timeout terminates
   * a socket the vendor leaves open. The conformance suite checks the declaration against the
   * vendor's fake (conformanceVendors.ts `answerFinish`).
   */
  readonly finishedOn: 'finished-message' | 'vendor-close';
  /** A message that keeps a quiet session from timing out, or null. Sent only while open. */
  readonly keepAlive: { message: string; intervalMs: number } | null;
  /**
   * `realtime` when the vendor closes a session sent audio faster than real time (AssemblyAI,
   * 3007): the core then never sends audio ahead of the wall time since the ready signal by more
   * than one frame, whoever hands it a burst (AudioPacer.ts). `none`: frames go as they come. The
   * conformance suite checks it against the vendor's fake
   * (conformanceVendors.ts `rejectsAudioFasterThanRealTime`).
   */
  readonly audioPacing: AudioPacing;
  session(context: SttProtocolContext): SttProtocolSession;
  /** Close code and reason → words for an error, e.g. "code 3008: Session Expired: ...". */
  describeClose(code: number, reason: string | null): string;
  /** Extra advice for a failed connect, given its explanation (AssemblyAI: wait a minute). */
  connectAdvice(explanation: string): string | null;
}

/**
 * The standard close codes every vendor shares (RFC 6455), for `describeClose` when the vendor gave
 * no reason. 1005 and 1006 come from the client library, never from the wire.
 */
export const STANDARD_CLOSE_MEANINGS: Readonly<Record<number, string>> = {
  1000: 'closed normally',
  1001: 'the server is going away',
  1005: 'closed without a status',
  1006: 'the connection dropped without a close frame',
  1011: 'server error',
};

/**
 * `code N: reason` when the vendor gave a reason (its own words are the most precise), else
 * `code N: meaning` from the vendor's table and then the standard one, else `code N`.
 */
export function describeCloseWith(
  meanings: Readonly<Record<number, string>>,
  code: number,
  reason: string | null,
): string {
  if (reason !== null && reason !== '') return `code ${code}: ${reason}`;
  const meaning = meanings[code] ?? STANDARD_CLOSE_MEANINGS[code];
  return meaning === undefined ? `code ${code}` : `code ${code}: ${meaning}`;
}
