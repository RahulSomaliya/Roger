import WebSocket from 'ws';
import { PCM_ENCODING } from '../../../shared/ipc';
import { pcmBytesToMs } from '../../../shared/pcm';
import { errorMessage, type Logger } from '../../logger';
import {
  type OpenStreamOptions,
  type SpeechToText,
  SttConnectError,
  type SttEvent,
  SttEventEmitter,
  type SttEventListener,
  type SttStream,
  type SttStreamSettings,
} from '../SpeechToText';
import { rawDataToString, waitForOpen } from '../websocket';
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
 *
 * Same lifecycle as the Deepgram adapter: open, stream binary PCM as it arrives, and on stop send
 * Terminate and wait (bounded) for Termination, which comes after the last turn. A vendor close or
 * error mid-call becomes a visible error event; nothing reconnects (M2).
 */

export const ASSEMBLYAI_DEFAULT_BASE_URL = 'wss://streaming.assemblyai.com';
/** AssemblyAI closes the session (3007) on a binary message outside this range. */
const MIN_FRAME_MS = 50;
const MAX_FRAME_MS = 1000;

export interface AssemblyAiOptions {
  logger: Logger;
  baseUrl?: string;
  /** Applies to the handshake, then again to the vendor's Begin message. */
  connectTimeoutMs?: number;
  /** How long Stop waits for Termination after Terminate before dropping the socket. */
  closeTimeoutMs?: number;
  /**
   * How long a finished turn waits for its formatted copy. The docs say it follows "immediately";
   * the bound keeps a lost copy from holding a line back for the rest of the call.
   */
  formattedTurnWaitMs?: number;
}

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
  // a quiet session, as Deepgram's KeepAlive keeps one open.
  // A temporary token goes in the query string. The master key would go in an Authorization
  // header, but it never reaches the desktop (house rule 3).
  url.searchParams.set('token', token);
  return url.toString();
}

export class AssemblyAiSpeechToText implements SpeechToText {
  readonly provider = 'assemblyai';
  private readonly baseUrl: string;
  private readonly connectTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly formattedTurnWaitMs: number;
  private readonly logger: Logger;

  constructor(options: AssemblyAiOptions) {
    this.logger = options.logger;
    this.baseUrl = options.baseUrl ?? ASSEMBLYAI_DEFAULT_BASE_URL;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.closeTimeoutMs = options.closeTimeoutMs ?? 5_000;
    this.formattedTurnWaitMs = options.formattedTurnWaitMs ?? 2_000;
  }

  async openStream(options: OpenStreamOptions): Promise<SttStream> {
    const url = buildStreamingUrl(this.baseUrl, options.settings, options.accessToken);
    const logger = this.logger.child({ stream: options.label });
    const socket = new WebSocket(url, { handshakeTimeout: this.connectTimeoutMs });
    // The stream listens from the start: Begin can arrive in the same read as the handshake,
    // before code after `await waitForOpen` runs, and a listener added then would miss it.
    const stream = new AssemblyAiStream(socket, logger, options.settings, {
      closeTimeoutMs: this.closeTimeoutMs,
      formattedTurnWaitMs: this.formattedTurnWaitMs,
    });
    try {
      await waitForOpen(socket, this.connectTimeoutMs);
    } catch (error) {
      if (!(error instanceof SttConnectError)) throw error;
      throw new SttConnectError(`AssemblyAI: ${error.message}`, error.statusCode);
    }
    await stream.began(this.connectTimeoutMs);
    logger.info('assemblyai stream open', { model: options.settings.model });
    return stream;
  }
}

type FinalEvent = Extract<SttEvent, { type: 'final' }>;
type TurnEvent = Extract<SttEvent, { type: 'interim' | 'final' }>;

interface HeldTurn {
  turnOrder: number;
  event: FinalEvent;
  timer: NodeJS.Timeout;
}

type BeginState =
  | { kind: 'waiting'; settle: ((error: SttConnectError | null) => void) | null }
  | { kind: 'begun' }
  | { kind: 'failed'; error: SttConnectError };

class AssemblyAiStream implements SttStream {
  private readonly emitter = new SttEventEmitter();
  private readonly frames: AudioFrameSizer;
  private readonly sampleRate: number;
  private readonly closeTimeoutMs: number;
  private readonly formattedTurnWaitMs: number;
  private beginState: BeginState = { kind: 'waiting', settle: null };
  /** The last Error frame's text, to explain a close that comes before Begin. */
  private vendorError: string | null = null;
  private closing = false;
  private closed = false;
  private droppedChunks = 0;
  private audioSentBytes = 0;
  /** turn_order of the last line emitted. Turn orders only grow, so anything at or below is a copy. */
  private lastFinalTurnOrder = -1;
  /** An unformatted finished turn waiting for its formatted copy. */
  private held: HeldTurn | null = null;
  private closedPromise: Promise<void>;

  constructor(
    private readonly socket: WebSocket,
    private readonly logger: Logger,
    settings: SttStreamSettings,
    options: { closeTimeoutMs: number; formattedTurnWaitMs: number },
  ) {
    this.sampleRate = settings.sampleRate;
    this.frames = new AudioFrameSizer({
      sampleRate: settings.sampleRate,
      minMs: MIN_FRAME_MS,
      maxMs: MAX_FRAME_MS,
    });
    this.closeTimeoutMs = options.closeTimeoutMs;
    this.formattedTurnWaitMs = options.formattedTurnWaitMs;
    this.closedPromise = new Promise((resolve) => {
      socket.on('close', (code, reasonBuffer) => {
        const reason = reasonBuffer.length > 0 ? reasonBuffer.toString() : null;
        this.closed = true;
        // Before Begin this is a failed connect (a bad or expired token closes with 1008).
        if (this.beginState.kind === 'waiting') {
          const why =
            this.vendorError === null
              ? ` (${describeClose(code, reason)})`
              : `: ${this.vendorError}`;
          this.failBegin(
            new SttConnectError(`AssemblyAI ended the connection before the session began${why}`),
          );
        }
        // The last turn is saved before "closed": CaptureSession stores finals that arrive
        // while it closes, never after.
        this.releaseHeldTurn();
        this.emitter.emit({ type: 'closed', code, reason });
        resolve();
      });
    });
    socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      try {
        this.handleMessage(rawDataToString(data));
      } catch (error) {
        // A listener (the UI bridge, say) threw. Report it; an uncaught error here would kill main.
        // A failed local save never lands here: CaptureSession reports it as a visible error.
        this.logger.error('error while handling a transcript message', {
          error: errorMessage(error),
        });
        this.emitter.emit({ type: 'error', message: errorMessage(error), fatal: false });
      }
    });
    socket.on('error', (error) => {
      this.logger.error('assemblyai socket error', { error: errorMessage(error) });
      this.emitter.emit({
        type: 'error',
        message: `AssemblyAI connection failed: ${error.message}`,
        fatal: true,
      });
    });
  }

  /** Resolves on the vendor's Begin; rejects if the connection ends first or Begin is late. */
  began(timeoutMs: number): Promise<void> {
    const state = this.beginState;
    if (state.kind === 'begun') return Promise.resolve();
    if (state.kind === 'failed') return Promise.reject(state.error);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failBegin(
          new SttConnectError(`AssemblyAI did not start the session within ${timeoutMs} ms`),
        );
        this.socket.terminate();
      }, timeoutMs);
      state.settle = (error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
    });
  }

  send(pcm: Uint8Array): void {
    if (this.socket.readyState !== WebSocket.OPEN || this.closing) {
      this.droppedChunks += 1;
      if (this.droppedChunks === 1) this.logger.warn('dropping audio: assemblyai socket not open');
      return;
    }
    for (const frame of this.frames.push(pcm)) this.sendFrame(frame);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (!this.closing) {
      this.closing = true;
      if (this.socket.readyState === WebSocket.OPEN) {
        const tail = this.frames.flush();
        if (tail) this.sendFrame(tail);
        // Terminate flushes the last turn. Closing without waiting for Termination loses it.
        this.socket.send(ASSEMBLYAI_TERMINATE);
      }
      const timer = setTimeout(() => {
        this.logger.warn('assemblyai did not confirm Termination in time, terminating', {
          ms: this.closeTimeoutMs,
        });
        this.socket.terminate();
      }, this.closeTimeoutMs);
      this.closedPromise = this.closedPromise.finally(() => {
        clearTimeout(timer);
      });
    }
    await this.closedPromise;
    if (this.droppedChunks > 0) {
      this.logger.warn('audio chunks dropped during stream', { dropped: this.droppedChunks });
    }
  }

  on(listener: SttEventListener): () => void {
    return this.emitter.on(listener);
  }

  /**
   * Frames only regroup the renderer's bytes, never drop or reorder them, so the vendor's time zero
   * stays the first byte CaptureSession timed (firstChunkOffsetMs) and word offsets line up with the
   * meeting clock. Dropping or skipping leading audio here would shift every line of the stream.
   */
  private sendFrame(frame: Uint8Array): void {
    this.socket.send(frame);
    this.audioSentBytes += frame.byteLength;
  }

  private handleMessage(raw: string): void {
    const parsed = parseAssemblyAiMessage(raw, pcmBytesToMs(this.audioSentBytes, this.sampleRate));
    switch (parsed.kind) {
      case 'begin': {
        const state = this.beginState;
        this.beginState = { kind: 'begun' };
        if (state.kind === 'waiting') state.settle?.(null);
        this.logger.info('assemblyai session began', { sessionId: parsed.sessionId });
        return;
      }
      case 'turn':
        if (parsed.warning !== undefined) {
          this.logger.warn('assemblyai message partly understood', { warning: parsed.warning });
        }
        this.handleTurn(parsed.turnOrder, parsed.formatted, parsed.event);
        return;
      case 'termination':
        this.logger.info('assemblyai session terminated', {
          audioDurationSeconds: parsed.audioDurationSeconds,
        });
        this.releaseHeldTurn();
        // Termination is the last message. When Stop asked for it, end the socket now rather
        // than wait for the vendor to close it.
        if (this.closing) this.socket.close(1000);
        return;
      case 'event':
        this.vendorError = parsed.event.message;
        this.logger.error('assemblyai reported an error', { message: parsed.event.message });
        this.emitter.emit(parsed.event);
        return;
      case 'ignored':
        this.logger.debug('assemblyai message ignored', { messageType: parsed.messageType });
        return;
      case 'invalid':
        // No raw payload in the log: it may contain transcript text.
        this.logger.warn('assemblyai message not understood', {
          reason: parsed.reason,
          bytes: raw.length,
        });
        // Non-fatal: one unreadable message (vendor format drift) must not end the stream.
        this.emitter.emit({
          type: 'error',
          message: `AssemblyAI sent a message Roger could not read (${parsed.reason})`,
          fatal: false,
        });
    }
  }

  /**
   * One saved line per turn_order. With format_turns a finished turn arrives unformatted, then
   * formatted with the same turn_order: the unformatted copy is held until the formatted one
   * replaces it, the next turn starts, the stream ends, or formattedTurnWaitMs passes. A formatted
   * copy arriving after that is a duplicate and dropped.
   */
  private handleTurn(turnOrder: number, formatted: boolean, event: TurnEvent): void {
    if (turnOrder <= this.lastFinalTurnOrder) {
      this.logger.debug('assemblyai turn already saved', { turnOrder });
      return;
    }
    if (this.held !== null && this.held.turnOrder !== turnOrder) this.releaseHeldTurn();
    if (event.type === 'interim') {
      if (this.held === null) this.emitter.emit(event);
      return;
    }
    if (formatted) {
      this.dropHeldTurn();
      this.emitFinal(turnOrder, event);
      return;
    }
    if (this.held !== null) return; // A second unformatted copy: keep the first.
    const timer = setTimeout(() => {
      this.logger.warn('formatted turn did not arrive in time, saving it unformatted', {
        turnOrder,
        waitedMs: this.formattedTurnWaitMs,
      });
      this.releaseHeldTurn();
    }, this.formattedTurnWaitMs);
    this.held = { turnOrder, event, timer };
  }

  private releaseHeldTurn(): void {
    const held = this.held;
    if (held === null) return;
    this.dropHeldTurn();
    this.emitFinal(held.turnOrder, held.event);
  }

  private dropHeldTurn(): void {
    if (this.held !== null) clearTimeout(this.held.timer);
    this.held = null;
  }

  private emitFinal(turnOrder: number, event: FinalEvent): void {
    this.lastFinalTurnOrder = turnOrder;
    this.emitter.emit(event);
  }

  private failBegin(error: SttConnectError): void {
    const state = this.beginState;
    if (state.kind !== 'waiting') return;
    this.beginState = { kind: 'failed', error };
    state.settle?.(error);
  }
}

function describeClose(code: number, reason: string | null): string {
  return reason === null ? `code ${code}` : `code ${code}: ${reason}`;
}
