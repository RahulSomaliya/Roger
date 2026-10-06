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
import { capKeyterms } from '../keyterms';
import { estimateCostUsd } from '../usage';
import { rawDataToString } from '../websocket';
import { AudioPacer } from './AudioPacer';
import type {
  SttConnectRefusal,
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
 *   terminates the socket and rejects `whenOpen()` only once the socket is closed. A refusal the
 *   protocol blames on the jargon list rejects with `keytermsRejected` set; it is never retried
 *   here (see keytermsRefused).
 * - open: audio flows, paced to real time for a vendor that declares it (see pump). The keep-alive
 *   runs only while audio was sent within keepAliveForMs. A vendor close here is one fatal error,
 *   then "closed".
 * - finishing: Stop sends the audio still waiting for its pace, then the finish sequence (or the
 *   vendor reported a fatal error, and that audio is dropped). No new audio, no keep-alive.
 *   closeTimeoutMs after Stop the socket is terminated, whatever the vendor does, queue or not.
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
  /**
   * The keep-alive is sent only while audio was sent within this long (or the stream opened within
   * it). The capture's stall close (costGuards: sttStallCloseMs) is the same window.
   */
  keepAliveForMs: number;
  /** Wall-clock ms: the connected time and the keep-alive window. Never the pacer's (paceClock). */
  clock: () => number;
  /**
   * Monotonic ms, for pacing only (performance.now() in the app). Never the wall clock: an NTP step
   * or a manual time change forward would count as time passed and send a backlog at once, the
   * 3007 close pacing exists to prevent; a step back would hold it until the clock caught up.
   * Node's timers run on monotonic time too, so the pace timer shares the pacer's time base.
   */
  paceClock: () => number;
}

/** ws's close code when the connection ended without a close frame (RFC 6455: never on the wire). */
const NO_CLOSE_FRAME = 1006;

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
  /** The pacer's time and the pace timer's, never `clock` (SttConnectionOptions.paceClock). */
  private readonly paceClock: () => number;
  private readonly sampleRate: number;
  /** USD per hour this session is open, from the API; null when unknown. */
  readonly pricePerHourUsd: number | null;
  /** The OpenStreamOptions label (the audio source), so usage can be read per source. */
  readonly label: string;
  private readonly closeTimeoutMs: number;
  private readonly keepAliveForMs: number;
  /** The jargon list this stream sent, cut to the shared limits (keyterms.ts). */
  private readonly keyterms: readonly string[];
  private connectTimer: NodeJS.Timeout | null;
  private finishTimer: NodeJS.Timeout | null = null;
  private keepAliveTimer: NodeJS.Timeout | null = null;
  /** Wakes pump() when the next paced frame is due. */
  private paceTimer: NodeJS.Timeout | null = null;
  private readonly pacer: AudioPacer;
  /** The finish sequence still to send once the paced audio before it has gone (Stop). */
  private finishQueue: (string | Uint8Array)[] = [];
  /** The first reason a connect failed; the socket's close then rejects whenOpen() with it. */
  private connectError: SttConnectError | null = null;
  /** The vendor's last error text, to explain a close that comes before the ready signal. */
  private vendorError: string | null = null;
  /** One fatal error per stream: a vendor error frame and the close after it are one failure. */
  private fatalReported = false;
  private openedAtMs: number | null = null;
  private closedAtMs: number | null = null;
  /** Clock time of the last audio handed to send() while open; the keep-alive window counts from it. */
  private lastAudioAtMs: number | null = null;
  private audioSentBytes = 0;
  private droppedChunks = 0;

  constructor(options: SttConnectionOptions) {
    this.protocol = options.protocol;
    this.logger = options.logger.child({
      stream: options.stream.label,
      model: options.stream.settings.model,
    });
    this.clock = options.clock;
    this.paceClock = options.paceClock;
    this.sampleRate = options.stream.settings.sampleRate;
    this.pricePerHourUsd = options.stream.settings.pricePerHourUsd;
    this.label = options.stream.label;
    this.closeTimeoutMs = options.closeTimeoutMs;
    this.keepAliveForMs = options.keepAliveForMs;
    this.pacer = new AudioPacer({ pacing: this.protocol.audioPacing, sampleRate: this.sampleRate });
    const stream = this.withCappedKeyterms(options.stream);
    this.keyterms = stream.settings.keyterms ?? [];
    // Throws SttConnectError on settings the vendor cannot take, before any socket exists.
    const target = this.protocol.target(stream);
    this.session = this.protocol.session({
      logger: this.logger,
      settings: stream.settings,
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
      const keytermsRejected =
        status !== null && this.keytermsRefused({ kind: 'http-status', status });
      this.failConnect(
        new SttConnectError(
          `${this.protocol.vendorName}: rejected with HTTP ${status ?? 'unknown'}` +
            this.keytermsRejectedNote(keytermsRejected),
          status,
          { keytermsRejected },
        ),
      );
    });
    this.socket.on('error', (error) => {
      if (this.currentState === 'connecting') {
        this.failConnect(new SttConnectError(`${this.protocol.vendorName}: ${error.message}`));
        return;
      }
      this.logger.error('stt socket error', { error: errorMessage(error) });
      this.endAfterFatal(`${this.protocol.vendorName} connection failed: ${error.message}`);
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
   * Sends one chunk while open: at once, or as real time allows for a vendor that declares
   * `realtime` pacing (pump). Outside open it is dropped and counted: before ready there is no
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
    this.lastAudioAtMs = this.clock();
    for (const frame of this.session.encodeAudio(pcm)) this.pacer.enqueue(frame);
    this.pump();
  }

  /**
   * Stop: send the vendor's finish sequence, wait for its completion signal, close. Idempotent:
   * every call returns the same promise, which settles once the socket is closed. Safe from inside
   * a listener (CaptureSession closes a stream from its fatal error): the core leaves 'open' before
   * it reports one, so such a call never starts a finish on a dead session (see reportFatal).
   */
  close(): Promise<void> {
    if (this.currentState === 'open') {
      this.currentState = 'finishing';
      this.stopKeepAlive();
      // Armed first: draining the paced audio counts against the same hard deadline. A backlog
      // longer than closeTimeoutMs is cut by the terminate, and its last turn with it.
      this.armFinishTimer();
      this.finishQueue = this.session.finishSequence();
      this.pump();
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
      // moment Stop, a vendor error or a close begins. And only while audio flows: a source that
      // sent nothing for keepAliveForMs is stalled, and a keep-alive would bill its silence (Deepgram
      // $0.46 an hour) until the capture closes it; without one the vendor closes it itself
      // (Deepgram NET-0001 after about 10 s).
      this.keepAliveTimer = setInterval(() => {
        const since = this.lastAudioAtMs ?? this.openedAtMs ?? this.clock();
        if (this.clock() - since >= this.keepAliveForMs) return;
        if (this.currentState === 'open' && this.socket.readyState === WebSocket.OPEN) {
          this.socket.send(keepAlive.message);
        }
      }, keepAlive.intervalMs);
    }
    this.pacer.start(this.paceClock());
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
        // Closed on only when the protocol declares this message its completion signal. A vendor
        // that closes the socket itself (Deepgram) still sends results after messages mid-sequence;
        // closing on one of those would lose its last lines. The finish deadline bounds both.
        if (this.protocol.finishedOn !== 'finished-message') return;
        this.logger.info('stt session finished');
        // The completion signal is the vendor's last message. When Stop asked for it, close now
        // rather than wait, billed, for the vendor to close.
        if (this.currentState === 'finishing') this.socket.close(1000);
        return;
      case 'vendor-error':
        this.vendorError = message.message;
        this.logger.error('stt vendor reported an error', { message: message.message });
        // Before ready it only explains the close that follows (a failed connect).
        if (this.currentState !== 'connecting') this.endAfterFatal(message.message);
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
   * A fatal error mid-call (a vendor error frame, a socket error) ends the session. The vendor says
   * it closes right after; close our side as well and arm the hard timeout, so a vendor that keeps
   * the socket open cannot keep billing a stream the caller already treats as dead. A finish
   * sequence is pointless here: the vendor already ended the session.
   */
  private endAfterFatal(message: string): void {
    // Also while Stop drains it: audio still waiting for its pace, and the finish sequence behind
    // it, would go to a session the vendor already ended.
    this.dropPacedAudio();
    if (this.currentState === 'open') {
      this.currentState = 'finishing';
      this.stopKeepAlive();
      this.socket.close(1000);
      this.armFinishTimer();
    }
    this.reportFatal(message);
  }

  private emitTranscript(event: TranscriptEvent): void {
    if (this.currentState !== 'closed') this.deliver(event);
  }

  /**
   * Never call this while 'open': move the state on first (endAfterFatal, finalize). Listeners run
   * synchronously, and CaptureSession's calls close() from inside this report. Seeing 'open', that
   * close() sent the finish sequence to a session the vendor had already ended and armed a finish
   * timer: after a vendor error our own close frame was skipped, so a vendor that kept its socket
   * open billed until the 5 s finish deadline; after a vendor close the timer outlived the socket
   * and logged a false "did not finish in time" on every mid-call close.
   */
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

  /**
   * Sends every frame the pacer lets go now, then, once Stop began and no audio waits, the finish
   * sequence in order (audio in it is paced too). What is not due yet waits for the timer.
   *
   * The only way audio reaches the socket. Pacing lives here, not in CaptureSession or an adapter,
   * so no caller can skip it: every reopen's held audio (up to costGuards.sttReopenBufferMs)
   * arrives as a burst right after ready, and so will M2-T6's offline reopen, M2-T16's re-run and
   * M3-T20's pre-roll. Live audio is never held. AssemblyAI takes no audio faster than real time
   * (3007), so held audio goes out at 1x and adds its own length of lag to that session until it
   * closes; nothing past the held audio is replayed inline, at any speed (that window is a gap,
   * for M2-T6 to record and M2-T16 to re-run from the backup). A raw `socket.send(pcm)` anywhere
   * else draws that 3007 close the first time a flush, or a pipe read that merged a stall's
   * writes, sends more than real time.
   */
  private pump(): void {
    this.clearPaceTimer();
    if (this.socket.readyState !== WebSocket.OPEN) return;
    for (;;) {
      for (const frame of this.pacer.take(this.paceClock())) this.sendFrame(frame);
      const nextAtMs = this.pacer.nextAtMs();
      if (nextAtMs !== null) {
        this.paceTimer = setTimeout(
          () => {
            this.paceTimer = null;
            this.pump();
          },
          Math.max(1, Math.ceil(nextAtMs - this.paceClock())),
        );
        return;
      }
      const message = this.finishQueue.shift();
      if (message === undefined) return;
      if (typeof message === 'string') this.socket.send(message);
      else this.pacer.enqueue(message);
    }
  }

  /** The session is over: audio still waiting for its pace will never be sent. Said, not hidden. */
  private dropPacedAudio(): void {
    this.clearPaceTimer();
    this.finishQueue = [];
    const queuedMs = this.pacer.discard();
    if (queuedMs > 0)
      this.logger.warn('stt paced audio dropped', { queuedMs: Math.round(queuedMs) });
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
    // Closed before any listener runs: a close() from inside one (the fatal report below) must find
    // nothing left to finish, or it arms a timer after the ones cleared here (see reportFatal).
    this.currentState = 'closed';
    this.clearConnectTimer();
    this.stopKeepAlive();
    this.dropPacedAudio();
    if (this.finishTimer !== null) clearTimeout(this.finishTimer);
    this.finishTimer = null;
    this.closedAtMs = this.clock();
    const held = this.session.release();

    if (was === 'connecting') {
      const error = this.connectError ?? this.earlyCloseError(code, reason);
      this.logger.warn('stt connect failed', {
        error: error.message,
        keyterms: this.keyterms.length,
        keytermsRejected: error.keytermsRejected,
        ...this.usage(),
      });
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
    const usage = this.usage();
    this.logger.info('stt stream closed', {
      code,
      ...usage,
      estimatedCostUsd: estimateCostUsd(usage.connectedMs, this.pricePerHourUsd),
    });
    this.deliver({ type: 'closed', code, reason });
    this.closing.resolve();
  }

  private earlyCloseError(code: number, reason: string | null): SttConnectError {
    const explanation =
      this.vendorError === null
        ? ` (${this.protocol.describeClose(code, reason)})`
        : `: ${this.vendorError}`;
    const advice = this.protocol.connectAdvice(explanation);
    // 1006 is ws's code for a TCP connection that ended with no close frame (a Wi-Fi handoff, a
    // proxy cutting it): the vendor said nothing, so it is a network error and never a refusal
    // (SttProtocol's SttConnectRefusal). Asked anyway, a predicate like AssemblyAI's "any close
    // before Begin except 1008 and 3009" would blame the drop on the list, and CaptureSession
    // would keep the list off that source for the whole meeting under a false warning.
    const keytermsRejected =
      code !== NO_CLOSE_FRAME &&
      this.keytermsRefused({ kind: 'closed-before-ready', code, reason });
    return new SttConnectError(
      `${this.protocol.vendorName} ended the connection before the session began${explanation}` +
        this.keytermsRejectedNote(keytermsRejected) +
        (advice === null ? '' : `. ${advice}`),
      null,
      { keytermsRejected },
    );
  }

  /**
   * The stream's options with its jargon list cut to the shared limits, so no protocol maps more
   * than every vendor takes. A cut list is a warning, never a failed call; the line counts terms
   * and never names them (they name clients and colleagues).
   */
  private withCappedKeyterms(stream: OpenStreamOptions): OpenStreamOptions {
    const received = stream.settings.keyterms ?? [];
    const { terms, dropped } = capKeyterms(received);
    if (dropped > 0) {
      this.logger.warn('stt keyterms cut to the vendor limits', {
        received: received.length,
        sent: terms.length,
        dropped,
      });
    }
    return { ...stream, settings: { ...stream.settings, keyterms: terms } };
  }

  /**
   * Whether the vendor refused this connect over the jargon list. Asked only when one was sent.
   * The caller only sets the flag: the core never opens a second socket for it. CaptureSession's
   * one reopen without the list goes through SttOpenBudget (M3-T4b); a retry here would be a billed
   * open the budget never saw, and a vendor that kept refusing would make it a loop (house rule 9).
   */
  private keytermsRefused(refusal: SttConnectRefusal): boolean {
    return this.keyterms.length > 0 && this.protocol.keytermsRejected?.(refusal) === true;
  }

  private keytermsRejectedNote(rejected: boolean): string {
    if (!rejected) return '';
    const count = this.keyterms.length;
    return `; the jargon list (${count} ${count === 1 ? 'term' : 'terms'}) was rejected`;
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== null) clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer !== null) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
  }

  private clearPaceTimer(): void {
    if (this.paceTimer !== null) clearTimeout(this.paceTimer);
    this.paceTimer = null;
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
