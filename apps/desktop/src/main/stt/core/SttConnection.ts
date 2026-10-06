import type { IncomingMessage } from 'node:http';
import WebSocket from 'ws';
import { pcmBytesToMs } from '../../../shared/pcm';
import { errorMessage, type Logger } from '../../logger';
import {
  type OpenStreamOptions,
  SttConnectError,
  type SttEvent,
  SttEventEmitter,
  type SttEventListener,
  type SttStream,
} from '../SpeechToText';
import { rawDataToString } from '../websocket';
import type {
  SttProtocol,
  SttProtocolMessage,
  SttProtocolSession,
  TranscriptEvent,
} from './SttProtocol';

/**
 * The one lifecycle every websocket speech-to-text vendor runs on. Vendors bill a session for as
 * long as its socket is open: AssemblyAI $0.15 an hour per stream, silent or not, for up to its
 * 3-hour cap, and every meeting runs two streams. So this class has one job above transcribing:
 * every path ends with the socket closed and one "closed" event, on a deadline.
 *
 *   connecting ──ready──▶ open ──close()/vendor error──▶ finishing ──socket closed──▶ closed
 *        └──────────── timeout / refused / vendor closed ─────────────────────────────▲
 *
 * - connecting: the handshake plus the vendor's ready signal, under one connect timeout. A failure
 *   terminates the socket and rejects `whenOpen()` only once the socket is closed.
 * - open: audio flows, the keep-alive runs. A vendor close here is one fatal error, then "closed".
 * - finishing: Stop sent the finish sequence (or the vendor reported a fatal error). No audio, no
 *   keep-alive. After closeTimeoutMs the socket is terminated, whatever the vendor does.
 * - closed: final. Audio is dropped and counted; close() returns the same settled promise.
 */

export type SttConnectionState = 'connecting' | 'open' | 'finishing' | 'closed';

export interface SttStreamUsage {
  /**
   * From the handshake to the socket closing (to now while it is open). This is what AssemblyAI
   * bills, so it is metered from the handshake, not from the ready signal: a session that opened
   * and never became ready still counts.
   */
  connectedMs: number;
  /** Audio frames sent, in ms of the stream's PCM. */
  audioSentMs: number;
  /** Chunks dropped because the stream was not open (Stop began, or it closed). */
  droppedChunks: number;
}

export interface SttConnectionOptions {
  protocol: SttProtocol;
  stream: OpenStreamOptions;
  logger: Logger;
  /** Covers the handshake and the vendor's ready signal together. */
  connectTimeoutMs: number;
  /** Hard cap from Stop (or a fatal vendor error) to the socket closing. Then it is terminated. */
  closeTimeoutMs: number;
  clock: () => number;
}

export class SttConnection implements SttStream {
  private currentState: SttConnectionState = 'connecting';
  private readonly protocol: SttProtocol;
  private readonly logger: Logger;
  private readonly socket: WebSocket;
  private readonly session: SttProtocolSession;
  private readonly emitter = new SttEventEmitter();
  private readonly opening = deferred();
  private readonly closing = deferred();
  private readonly clock: () => number;
  private readonly sampleRate: number;
  private readonly closeTimeoutMs: number;
  private connectTimer: NodeJS.Timeout | null;
  private finishTimer: NodeJS.Timeout | null = null;
  private keepAliveTimer: NodeJS.Timeout | null = null;
  /** The first reason a connect failed; the socket's close then rejects whenOpen() with it. */
  private connectError: SttConnectError | null = null;
  /** The vendor's last error text, to explain a close that comes before the ready signal. */
  private vendorError: string | null = null;
  /** One fatal error per stream: a vendor error frame and the close after it are one failure. */
  private fatalReported = false;
  private openedAtMs: number | null = null;
  private closedAtMs: number | null = null;
  private audioSentBytes = 0;
  private droppedChunks = 0;

  constructor(options: SttConnectionOptions) {
    this.protocol = options.protocol;
    this.logger = options.logger.child({ stream: options.stream.label });
    this.clock = options.clock;
    this.sampleRate = options.stream.settings.sampleRate;
    this.closeTimeoutMs = options.closeTimeoutMs;
    // Throws SttConnectError on settings the vendor cannot take, before any socket exists.
    const target = this.protocol.target(options.stream);
    this.session = this.protocol.session({
      logger: this.logger,
      settings: options.stream.settings,
      audioSentMs: () => pcmBytesToMs(this.audioSentBytes, this.sampleRate),
      emit: (event) => {
        if (this.currentState !== 'closed') this.deliver(event);
      },
    });
    // No `handshakeTimeout`: the connect timer below covers the handshake and the ready signal, so
    // one deadline and one error text apply whichever stage stalls.
    this.socket = new WebSocket(target.url, { headers: target.headers });
    this.connectTimer = setTimeout(() => {
      this.connectTimedOut(options.connectTimeoutMs);
    }, options.connectTimeoutMs);
    // Every listener is attached now, before any await: a ready message can arrive in the same
    // read as the handshake, and a listener added after `await` would miss it.
    this.socket.on('open', () => {
      this.openedAtMs = this.clock();
      if (this.protocol.readyOn === 'socket-open') this.becomeOpen(null);
    });
    this.socket.on('unexpected-response', (_request, response: IncomingMessage) => {
      const status = response.statusCode ?? null;
      this.failConnect(
        new SttConnectError(
          `${this.protocol.vendorName}: rejected with HTTP ${status ?? 'unknown'}`,
          status,
        ),
      );
    });
    this.socket.on('error', (error) => {
      if (this.currentState === 'connecting') {
        this.failConnect(new SttConnectError(`${this.protocol.vendorName}: ${error.message}`));
        return;
      }
      this.logger.error('stt socket error', { error: errorMessage(error) });
      this.reportFatal(`${this.protocol.vendorName} connection failed: ${error.message}`);
    });
    this.socket.on('message', (data, isBinary) => {
      if (!isBinary) this.handleMessage(rawDataToString(data));
    });
    this.socket.on('close', (code, reason) => {
      this.finalize(code, reason.length > 0 ? reason.toString() : null);
    });
  }

  get state(): SttConnectionState {
    return this.currentState;
  }

  /** True once the handshake completed: from then on the vendor may bill the session. */
  get opened(): boolean {
    return this.openedAtMs !== null;
  }

  /** Resolves on the ready signal; rejects with SttConnectError once a failed socket is closed. */
  whenOpen(): Promise<void> {
    return this.opening.promise;
  }

  /**
   * Sends one chunk while open. Outside open it is dropped and counted: before ready there is no
   * session to send to, and once Stop began the vendor is flushing its last lines.
   */
  send(pcm: Uint8Array): void {
    if (this.currentState !== 'open' || this.socket.readyState !== WebSocket.OPEN) {
      this.droppedChunks += 1;
      if (this.droppedChunks === 1) {
        this.logger.warn('dropping audio: stream not open', { state: this.currentState });
      }
      return;
    }
    for (const frame of this.session.encodeAudio(pcm)) this.sendFrame(frame);
  }

  /**
   * Stop: send the vendor's finish sequence, wait for its completion signal, close. Idempotent:
   * every call returns the same promise, which settles once the socket is closed.
   */
  close(): Promise<void> {
    if (this.currentState === 'open') {
      this.currentState = 'finishing';
      this.stopKeepAlive();
      for (const message of this.session.finishSequence()) this.sendRaw(message);
      this.armFinishTimer();
    } else if (this.currentState === 'connecting') {
      this.failConnect(
        new SttConnectError(`${this.protocol.vendorName}: closed before the session began`),
      );
    }
    return this.closing.promise;
  }

  on(listener: SttEventListener): () => void {
    return this.emitter.on(listener);
  }

  usage(): SttStreamUsage {
    const end = this.closedAtMs ?? this.clock();
    return {
      connectedMs: this.openedAtMs === null ? 0 : end - this.openedAtMs,
      audioSentMs: pcmBytesToMs(this.audioSentBytes, this.sampleRate),
      droppedChunks: this.droppedChunks,
    };
  }

  private becomeOpen(sessionId: string | null): void {
    if (this.currentState !== 'connecting') return;
    this.clearConnectTimer();
    this.currentState = 'open';
    this.logger.info('stt stream open', { sessionId });
    const keepAlive = this.protocol.keepAlive;
    if (keepAlive !== null) {
      // A keep-alive holds a billed session open on purpose. It runs only while open: it stops the
      // moment Stop, a vendor error or a close begins, so it can never keep a dead stream alive.
      this.keepAliveTimer = setInterval(() => {
        if (this.currentState === 'open' && this.socket.readyState === WebSocket.OPEN) {
          this.socket.send(keepAlive.message);
        }
      }, keepAlive.intervalMs);
    }
    this.opening.resolve();
  }

  private connectTimedOut(timeoutMs: number): void {
    this.connectTimer = null;
    const vendor = this.protocol.vendorName;
    this.failConnect(
      new SttConnectError(
        this.opened
          ? `${vendor} did not start the session within ${timeoutMs} ms`
          : `${vendor}: connection timed out after ${timeoutMs} ms`,
      ),
    );
  }

  /** The first failure wins; the socket's close event then settles whenOpen(). */
  private failConnect(error: SttConnectError): void {
    if (this.currentState !== 'connecting' || this.connectError !== null) return;
    this.connectError = error;
    this.clearConnectTimer();
    this.socket.terminate();
  }

  private handleMessage(raw: string): void {
    let message: SttProtocolMessage;
    try {
      message = this.session.read(raw);
    } catch (error) {
      // Parsers return `invalid` rather than throw; one that throws anyway must not kill main.
      message = { kind: 'invalid', reason: `parser failed: ${errorMessage(error)}` };
    }
    switch (message.kind) {
      case 'ready':
        if (this.protocol.readyOn === 'ready-message') this.becomeOpen(message.sessionId);
        return;
      case 'transcript':
        if (message.warning !== undefined) {
          this.logger.warn('stt message partly understood', { warning: message.warning });
        }
        for (const event of message.events) this.emitTranscript(event);
        return;
      case 'finished':
        for (const event of message.events) this.emitTranscript(event);
        this.logger.info('stt session finished');
        // The completion signal is the vendor's last message. When Stop asked for it, close now
        // rather than wait, billed, for the vendor to close.
        if (this.currentState === 'finishing') this.socket.close(1000);
        return;
      case 'vendor-error':
        this.vendorError = message.message;
        this.logger.error('stt vendor reported an error', { message: message.message });
        // Before ready it only explains the close that follows (a failed connect).
        if (this.currentState !== 'connecting') this.endAfterVendorError(message.message);
        return;
      case 'ignored':
        this.logger.debug('stt message ignored', { messageType: message.messageType });
        return;
      case 'invalid':
        // No raw payload in the log: it may contain transcript text.
        this.logger.warn('stt message not understood', {
          reason: message.reason,
          bytes: raw.length,
        });
        // Non-fatal: one unreadable message (vendor format drift) must not end the stream.
        this.deliver({
          type: 'error',
          message: `${this.protocol.vendorName} sent a message Roger could not read (${message.reason})`,
          fatal: false,
        });
    }
  }

  /**
   * A fatal vendor error ends the session. The vendor says it closes right after; close our side
   * as well and arm the hard timeout, so a vendor that keeps the socket open cannot keep billing a
   * stream the caller already treats as dead.
   */
  private endAfterVendorError(message: string): void {
    this.reportFatal(message);
    if (this.currentState !== 'open') return;
    this.currentState = 'finishing';
    this.stopKeepAlive();
    this.socket.close(1000);
    this.armFinishTimer();
  }

  private emitTranscript(event: TranscriptEvent): void {
    if (this.currentState !== 'closed') this.deliver(event);
  }

  private reportFatal(message: string): void {
    if (this.fatalReported) return;
    this.fatalReported = true;
    this.deliver({ type: 'error', message, fatal: true });
  }

  /**
   * Hands an event to the listeners. A listener that throws (the UI bridge, say) is reported as a
   * non-fatal error: uncaught, it would escape a socket event handler and kill the main process.
   * A failed local save never lands here: CaptureSession reports it as a visible error itself.
   */
  private deliver(event: SttEvent): void {
    try {
      this.emitter.emit(event);
    } catch (error) {
      this.logger.error('stt listener failed', { event: event.type, error: errorMessage(error) });
      if (event.type === 'interim' || event.type === 'final') {
        this.deliver({ type: 'error', message: errorMessage(error), fatal: false });
      }
    }
  }

  private sendRaw(message: string | Uint8Array): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    if (typeof message === 'string') this.socket.send(message);
    else this.sendFrame(message);
  }

  /**
   * Adapters may regroup the renderer's bytes into frames (AssemblyAI does), never drop or reorder
   * them: the vendor's time zero is the first byte CaptureSession timed (firstChunkOffsetMs), so
   * dropping or skipping leading audio would shift every line of the stream.
   */
  private sendFrame(frame: Uint8Array): void {
    this.socket.send(frame);
    this.audioSentBytes += frame.byteLength;
  }

  /**
   * The hard deadline. Without it a vendor that never answers the finish sequence, or never
   * answers our close frame (ws waits 30 s for that on its own), keeps a socket open that bills
   * until the vendor's own cap: 3 hours, $0.45 a stream on AssemblyAI. Terminate drops the TCP
   * connection without asking anyone.
   */
  private armFinishTimer(): void {
    if (this.finishTimer !== null) return;
    this.finishTimer = setTimeout(() => {
      this.finishTimer = null;
      this.logger.warn('stt vendor did not finish in time, terminating', {
        ms: this.closeTimeoutMs,
      });
      this.socket.terminate();
    }, this.closeTimeoutMs);
  }

  /** The socket closed, for whatever reason. Runs once; every timer stops here. */
  private finalize(code: number, reason: string | null): void {
    if (this.currentState === 'closed') return;
    const was = this.currentState;
    this.clearConnectTimer();
    this.stopKeepAlive();
    if (this.finishTimer !== null) clearTimeout(this.finishTimer);
    this.finishTimer = null;
    this.closedAtMs = this.clock();
    const held = this.session.release();

    if (was === 'connecting') {
      this.currentState = 'closed';
      const error = this.connectError ?? this.earlyCloseError(code, reason);
      this.logger.warn('stt connect failed', { error: error.message, ...this.usage() });
      this.opening.reject(error);
      this.closing.resolve();
      return;
    }
    // Lines still held are saved before "closed": CaptureSession stores finals that arrive while
    // it closes, never after.
    for (const event of held) this.deliver(event);
    if (was === 'open') {
      // Not asked to close: the vendor or the network ended the stream mid-call.
      this.reportFatal(
        `${this.protocol.vendorName} closed the stream (${this.protocol.describeClose(code, reason)})`,
      );
    }
    this.currentState = 'closed';
    this.logger.info('stt stream closed', { code, ...this.usage() });
    this.deliver({ type: 'closed', code, reason });
    this.closing.resolve();
  }

  private earlyCloseError(code: number, reason: string | null): SttConnectError {
    const explanation =
      this.vendorError === null
        ? ` (${this.protocol.describeClose(code, reason)})`
        : `: ${this.vendorError}`;
    const advice = this.protocol.connectAdvice(explanation);
    return new SttConnectError(
      `${this.protocol.vendorName} ended the connection before the session began${explanation}` +
        (advice === null ? '' : `. ${advice}`),
    );
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== null) clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer !== null) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
  }
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
