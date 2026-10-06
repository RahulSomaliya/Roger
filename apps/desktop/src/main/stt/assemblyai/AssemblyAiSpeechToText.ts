import { PCM_ENCODING } from '../../../shared/ipc';
import { DEFAULT_COST_GUARDS } from '../../costGuards';
import { AudioFrameSizer } from '../core/AudioFrameSizer';
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
import { ASSEMBLYAI_TERMINATE, parseAssemblyAiMessage } from './messages';

/**
 * AssemblyAI Universal-Streaming (v3) adapter. Docs relied on, read 2026-10-06:
 * - https://www.assemblyai.com/docs/streaming/api-spec/streaming-websocket (URL, query
 *   parameters, messages; 50 to 1000 ms of audio per message; sessions capped at 3 hours;
 *   `inactivity_timeout` 5 to 3600 s, unset meaning none)
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
 * binary PCM in 50 to 1000 ms frames never sent faster than real time (the core paces them),
 * Terminate on stop answered by Termination (after the last turn), and one saved line per turn.
 * The socket lifecycle, its timeouts, its pacing and the forced close are SttConnection's
 * (core/SttConnection.ts). A vendor close or error mid-call becomes a fatal error event;
 * CaptureSession decides whether to reopen, through its open budget.
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
  /** Sent as `inactivity_timeout`. Default: costGuards.sttVendorIdleTimeoutMs (120 s). */
  vendorIdleTimeoutMs?: number;
  /**
   * How long a finished turn waits for its formatted copy. The docs say it follows "immediately";
   * the bound keeps a lost copy from holding a line back for the rest of the call.
   */
  formattedTurnWaitMs?: number;
}

export type AssemblyAiOptions = WebSocketSttOptions & AssemblyAiProtocolOptions;

/** AssemblyAI's accepted range for `inactivity_timeout`, in seconds. */
const MIN_INACTIVITY_TIMEOUT_S = 5;
const MAX_INACTIVITY_TIMEOUT_S = 3600;

/**
 * Universal-Streaming (`universal-streaming-*`) finishes a turn raw and, with `format_turns`, sends
 * it again punctuated and cased. The Universal-3 Pro models (`universal-3-*-pro`) send one end of
 * turn, always formatted, and take no `format_turns` (AssemblyAI's migration guide to Universal-3
 * Pro).
 */
function sendsEachTurnTwice(model: string): boolean {
  return model.startsWith('universal-streaming');
}

/** The Universal-3 Pro models, the only ones that take `language_codes`. */
function isUniversal3Pro(model: string): boolean {
  return /^universal-3-.+-pro$/.test(model);
}

/** The websocket URL for one stream. It carries the token: never log it. */
export function buildStreamingUrl(
  baseUrl: string,
  settings: SttStreamSettings,
  token: string,
  inactivityTimeoutMs: number,
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
  // The Pro models switch between languages by themselves: without the hint, accented English can
  // come back partly in another language or script, and the migration guide says to pass it (a
  // JSON list, one code for one language). The English model takes only English, and nothing
  // Roger runs uses the multilingual one, so neither is sent it.
  if (isUniversal3Pro(settings.model)) {
    url.searchParams.set('language_codes', JSON.stringify([settings.language]));
  }
  if (sendsEachTurnTwice(settings.model)) url.searchParams.set('format_turns', 'true');
  // The jargon list, so names like Linkt come out spelled right: one parameter holding a JSON
  // array (up to 100 terms of 50 characters; the core has already cut the list to the shared
  // limits, keyterms.ts). Never sent empty: no list, no parameter.
  const keyterms = settings.keyterms ?? [];
  if (keyterms.length > 0) url.searchParams.set('keyterms_prompt', JSON.stringify(keyterms));
  // M9: streaming speaker labels plug in here as `speaker_labels=true` (then see messages.ts).
  // The vendor-side safety net. AssemblyAI bills the time a session is open, not the audio in it,
  // and with no `inactivity_timeout` it never closes a quiet session: one Roger cannot close (the
  // Mac slept with the socket half-open, main hung) bills to the 3-hour cap, $0.45 a stream. The
  // timeout counts messages, so silent chunks keep a live stream open; it is set above the
  // capture's own stall close (30 s), so it only fires when Roger could not act. The 3-hour cap
  // itself is set on the token by the API (`max_session_duration_seconds`).
  const timeoutS = Math.round(inactivityTimeoutMs / 1000);
  url.searchParams.set(
    'inactivity_timeout',
    String(Math.min(MAX_INACTIVITY_TIMEOUT_S, Math.max(MIN_INACTIVITY_TIMEOUT_S, timeoutS))),
  );
  // A temporary token goes in the query string. The master key would go in an Authorization
  // header, but it never reaches the desktop (house rule 3).
  url.searchParams.set('token', token);
  return url.toString();
}

export function assemblyAiProtocol(options: AssemblyAiProtocolOptions = {}): SttProtocol {
  const baseUrl = options.baseUrl ?? ASSEMBLYAI_DEFAULT_BASE_URL;
  const formattedTurnWaitMs = options.formattedTurnWaitMs ?? 2_000;
  const inactivityTimeoutMs =
    options.vendorIdleTimeoutMs ?? DEFAULT_COST_GUARDS.sttVendorIdleTimeoutMs;
  return {
    provider: 'assemblyai',
    vendorName: 'AssemblyAI',
    target: ({ accessToken, settings }) => ({
      url: buildStreamingUrl(baseUrl, settings, accessToken, inactivityTimeoutMs),
      headers: {},
    }),
    // Begin. The core listens from socket creation, so a Begin that lands in the same read as the
    // handshake is not missed.
    readyOn: 'ready-message',
    // Terminate flushes the last turn and the vendor answers Termination; closing without waiting
    // for it loses that turn. The core then closes the socket itself.
    finishedOn: 'finished-message',
    keepAlive: null,
    // AssemblyAI closes a session sent audio faster than real time (3007, "Audio Transmission
    // Rate Exceeded") and documents no tolerance, so the core paces every frame to real time:
    // a reopen's held audio included, which then runs that session behind live by its length.
    audioPacing: 'realtime',
    session: (context) => new AssemblyAiSession(context, formattedTurnWaitMs),
    describeClose: (code, reason) => describeCloseWith(ASSEMBLYAI_CLOSE_MEANINGS, code, reason),
    connectAdvice: (explanation) =>
      SESSION_LIMIT_REASON.test(explanation) ? SESSION_LIMIT_ADVICE : null,
    // AssemblyAI documents no refusal for a list it will not take, so any close before Begin is
    // put down to the list (the core asks only when one was sent), except the two codes that name
    // another cause: 1008 (a bad or expired token, an account problem) and 3009 (too many sessions
    // started this minute). A reopen without the list cannot fix those, and CaptureSession would
    // keep the list off that source for the rest of the meeting under a false warning. A close
    // blamed wrongly (3005, a server error) costs one reopen without the list, and if that fails
    // too its error carries both reasons (M3-T4b). An HTTP status at the handshake is never put
    // down to the list: AssemblyAI documents its refusals as close codes. A connection that
    // dropped with no close frame (1006) never gets here: the core calls it a network error and
    // does not ask (SttConnectRefusal).
    keytermsRejected: (refusal) =>
      refusal.kind === 'closed-before-ready' && refusal.code !== 1008 && refusal.code !== 3009,
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
