import { PCM_ENCODING } from '../../../shared/ipc';
import {
  describeCloseWith,
  type SttProtocol,
  type SttProtocolContext,
  type SttProtocolMessage,
  type SttProtocolSession,
  type TranscriptEvent,
} from '../core/SttProtocol';
import { WebSocketSpeechToText, type WebSocketSttOptions } from '../core/WebSocketSpeechToText';
import { SttConnectError, type SttEvent, type SttStreamSettings } from '../SpeechToText';
import { AudioFrameSizer } from './AudioFrameSizer';
import { ASSEMBLYAI_TERMINATE, parseAssemblyAiMessage } from './messages';

/**
 * AssemblyAI Universal-Streaming (v3) adapter. Docs relied on, read 2026-10-06:
 * - https://www.assemblyai.com/docs/streaming/api-spec/streaming-websocket (URL, query
 *   parameters, messages; 50 to 1000 ms of audio per message; sessions capped at 3 hours)
 * - https://www.assemblyai.com/docs/streaming/authenticate-with-a-temporary-token (the `token`
 *   query parameter; one token may open several sessions, so mic and system share one)
 * - https://www.assemblyai.com/docs/streaming/message-sequence (format_turns sends a turn twice)
 * - https://www.assemblyai.com/docs/streaming/common-session-errors-and-closures (an Error frame,
 *   then the close: 1008 unauthorized, 3005 server error, 3006 bad message or inactivity, 3007
 *   audio chunk duration or rate, 3008 session expired, 3009 too many concurrent sessions)
 * - https://www.assemblyai.com/docs/streaming/rate-limits (read 2026-10-06: free accounts may
 *   START 5 sessions a minute, paid 100+. Over the limit the close is 1008 there, 3009 on the page
 *   above, both with the reason "Too many concurrent sessions"; see SESSION_LIMIT_REASON)
 * - https://www.assemblyai.com/docs/universal-streaming ("billed on the total duration that your
 *   WebSocket connection stays open, not on the amount of audio you send")
 *
 * This file only describes the protocol: the token in the query string, Begin as the ready signal,
 * binary PCM in 50 to 1000 ms frames, Terminate on stop answered by Termination (after the last
 * turn), and one saved line per turn. The socket lifecycle, its timeouts and the forced close are
 * SttConnection's (core/SttConnection.ts). A vendor close or error mid-call becomes a visible error
 * event; nothing reconnects (M2).
 */

export const ASSEMBLYAI_DEFAULT_BASE_URL = 'wss://streaming.assemblyai.com';
/**
 * The vendor's reason when an account starts too many sessions in a minute. It says "concurrent",
 * but the limit counts sessions STARTED per minute, and every Start opens two (one per audio
 * source), so Start, Stop, Start, Stop, Start within a minute fails on a free account with nothing
 * leaked. Matched on the text, not the code: the vendor's two pages give 1008 and 3009.
 */
const SESSION_LIMIT_REASON = /too many concurrent sessions/i;
const SESSION_LIMIT_ADVICE =
  'AssemblyAI limits how many sessions start per minute (5 on a free account) and each ' +
  'Start opens two, one per audio source: wait a minute, then press Start again.';
/** AssemblyAI closes the session (3007) on a binary message outside this range. */
const MIN_FRAME_MS = 50;
const MAX_FRAME_MS = 1000;
/** For a close that carries no reason text (the vendor's text wins when there is one). */
const ASSEMBLYAI_CLOSE_MEANINGS: Readonly<Record<number, string>> = {
  1008: 'unauthorized: the token was refused or has expired',
  3005: 'AssemblyAI server error',
  3006: 'a message AssemblyAI could not read, or the session was inactive',
  3007: 'audio messages outside 50 to 1000 ms, or sent faster than real time',
  3008: 'the session reached its maximum duration',
  3009: 'too many concurrent sessions',
};

export interface AssemblyAiProtocolOptions {
  baseUrl?: string;
  /**
   * How long a finished turn waits for its formatted copy. The docs say it follows "immediately";
   * the bound keeps a lost copy from holding a line back for the rest of the call.
   */
  formattedTurnWaitMs?: number;
}

export type AssemblyAiOptions = WebSocketSttOptions & AssemblyAiProtocolOptions;

/** The websocket URL for one stream. It carries the token: never log it. */
export function buildStreamingUrl(
  baseUrl: string,
  settings: SttStreamSettings,
  token: string,
): string {
  if (settings.encoding !== PCM_ENCODING) {
    throw new SttConnectError(
      `AssemblyAI cannot be sent ${settings.encoding} audio; Roger sends ${PCM_ENCODING}`,
    );
  }
  const url = new URL('/v3/ws', baseUrl);
  url.searchParams.set('speech_model', settings.model);
  url.searchParams.set('sample_rate', String(settings.sampleRate));
  // Our `linear16` (16-bit signed little-endian mono PCM) under AssemblyAI's name.
  url.searchParams.set('encoding', 'pcm_s16le');
  // Universal-Streaming finishes a turn raw, then sends it again punctuated and cased when asked.
  // The Universal-3 Pro models always format and do not take the parameter.
  if (settings.model.startsWith('universal-streaming'))
    url.searchParams.set('format_turns', 'true');
  // M3: the jargon list plugs in here as `keyterms_prompt`.
  // M9: streaming speaker labels plug in here as `speaker_labels=true` (then see messages.ts).
  // Not sent: `settings.language` (the English model takes only English; `language_codes` is for
  // the multilingual one), and `inactivity_timeout`, whose absence means the vendor never closes
  // a quiet session, as Deepgram's KeepAlive keeps one open. AssemblyAI bills the time a session
  // is open, not the audio in it, so a silent or dead system stream costs as much as a live one
  // until Stop. An inactivity timeout would not change that: it counts messages, and the renderer
  // sends silent chunks too.
  // A temporary token goes in the query string. The master key would go in an Authorization
  // header, but it never reaches the desktop (house rule 3).
  url.searchParams.set('token', token);
  return url.toString();
}

export function assemblyAiProtocol(options: AssemblyAiProtocolOptions = {}): SttProtocol {
  const baseUrl = options.baseUrl ?? ASSEMBLYAI_DEFAULT_BASE_URL;
  const formattedTurnWaitMs = options.formattedTurnWaitMs ?? 2_000;
  return {
    provider: 'assemblyai',
    vendorName: 'AssemblyAI',
    target: ({ accessToken, settings }) => ({
      url: buildStreamingUrl(baseUrl, settings, accessToken),
      headers: {},
    }),
    // Begin. The core listens from socket creation, so a Begin that lands in the same read as the
    // handshake is not missed.
    readyOn: 'ready-message',
    // Terminate flushes the last turn and the vendor answers Termination; closing without waiting
    // for it loses that turn. The core then closes the socket itself.
    finishedOn: 'finished-message',
    keepAlive: null,
    session: (context) => new AssemblyAiSession(context, formattedTurnWaitMs),
    describeClose: (code, reason) => describeCloseWith(ASSEMBLYAI_CLOSE_MEANINGS, code, reason),
    connectAdvice: (explanation) =>
      SESSION_LIMIT_REASON.test(explanation) ? SESSION_LIMIT_ADVICE : null,
  };
}

export class AssemblyAiSpeechToText extends WebSocketSpeechToText {
  constructor(options: AssemblyAiOptions) {
    super(assemblyAiProtocol(options), options);
  }
}

type FinalEvent = Extract<SttEvent, { type: 'final' }>;

interface HeldTurn {
  turnOrder: number;
  event: FinalEvent;
  timer: NodeJS.Timeout;
}

/** One stream's protocol state: the frame sizer and the turn waiting for its formatted copy. */
class AssemblyAiSession implements SttProtocolSession {
  private readonly frames: AudioFrameSizer;
  /** turn_order of the last line emitted. Turn orders only grow, so anything at or below is a copy. */
  private lastFinalTurnOrder = -1;
  /** An unformatted finished turn waiting for its formatted copy. */
  private held: HeldTurn | null = null;

  constructor(
    private readonly context: SttProtocolContext,
    private readonly formattedTurnWaitMs: number,
  ) {
    this.frames = new AudioFrameSizer({
      sampleRate: context.settings.sampleRate,
      minMs: MIN_FRAME_MS,
      maxMs: MAX_FRAME_MS,
    });
  }

  encodeAudio(pcm: Uint8Array): Uint8Array[] {
    return this.frames.push(pcm);
  }

  finishSequence(): (string | Uint8Array)[] {
    const tail = this.frames.flush();
    return tail === null ? [ASSEMBLYAI_TERMINATE] : [tail, ASSEMBLYAI_TERMINATE];
  }

  read(raw: string): SttProtocolMessage {
    const parsed = parseAssemblyAiMessage(raw, this.context.audioSentMs());
    switch (parsed.kind) {
      case 'begin':
        return { kind: 'ready', sessionId: parsed.sessionId };
      case 'turn': {
        const events = this.acceptTurn(parsed.turnOrder, parsed.formatted, parsed.event);
        return parsed.warning === undefined
          ? { kind: 'transcript', events }
          : { kind: 'transcript', events, warning: parsed.warning };
      }
      case 'termination':
        this.context.logger.info('assemblyai session terminated', {
          audioDurationSeconds: parsed.audioDurationSeconds,
        });
        return { kind: 'finished', events: this.releaseHeldTurn() };
      case 'event':
        return { kind: 'vendor-error', message: parsed.event.message };
      case 'ignored':
      case 'invalid':
        return parsed;
    }
  }

  release(): TranscriptEvent[] {
    return this.releaseHeldTurn();
  }

  /**
   * One saved line per turn_order. With format_turns a finished turn arrives unformatted, then
   * formatted with the same turn_order: the unformatted copy is held until the formatted one
   * replaces it, the next turn starts, the stream ends, or formattedTurnWaitMs passes. A formatted
   * copy arriving after that is a duplicate and dropped. Returns the lines to emit now, in order.
   */
  private acceptTurn(
    turnOrder: number,
    formatted: boolean,
    event: TranscriptEvent,
  ): TranscriptEvent[] {
    if (turnOrder <= this.lastFinalTurnOrder) {
      this.context.logger.debug('assemblyai turn already saved', { turnOrder });
      return [];
    }
    const events =
      this.held !== null && this.held.turnOrder !== turnOrder ? this.releaseHeldTurn() : [];
    if (event.type === 'interim') {
      if (this.held === null) events.push(event);
      return events;
    }
    if (formatted) {
      this.dropHeldTurn();
      this.lastFinalTurnOrder = turnOrder;
      events.push(event);
      return events;
    }
    if (this.held !== null) return events; // A second unformatted copy: keep the first.
    const timer = setTimeout(() => {
      this.context.logger.warn('formatted turn did not arrive in time, saving it unformatted', {
        turnOrder,
        waitedMs: this.formattedTurnWaitMs,
      });
      for (const line of this.releaseHeldTurn()) this.context.emit(line);
    }, this.formattedTurnWaitMs);
    this.held = { turnOrder, event, timer };
    return events;
  }

  private releaseHeldTurn(): TranscriptEvent[] {
    const held = this.held;
    if (held === null) return [];
    this.dropHeldTurn();
    this.lastFinalTurnOrder = held.turnOrder;
    return [held.event];
  }

  private dropHeldTurn(): void {
    if (this.held !== null) clearTimeout(this.held.timer);
    this.held = null;
  }
}
