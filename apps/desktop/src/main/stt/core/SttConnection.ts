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
 *   here (see keytermsRefused). A wire tap that fails here fails the connect too (see tap).
 * - open: audio flows, paced to real time for a vendor that declares it (see pump). The keep-alive
 *   runs only while audio was sent within keepAliveForMs, and so do the liveness pings: a socket
 *   that stops answering them is dead, one fatal error and a terminate (see checkLiveness). A
 *   vendor close here is one fatal error, then "closed".
 * - finishing: Stop sends the audio still waiting for its pace, then the finish sequence (or the
 *   vendor reported a fatal error, and that audio is dropped). No new audio, no keep-alive.
 *   closeTimeoutMs after Stop the socket is terminated, whatever the vendor does, queue or not.
 * - closed: final. Audio is dropped and counted; close() returns the same settled promise.
 *
 * terminate() skips the finish: from connecting, open or finishing, the socket is dropped at once
 * (CaptureSession's offline suspend, M2-T6: with the network gone a finish can only wait).
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

/**
 * One thing on a stream's wire, as the wire tap sees it (WebSocketSttOptions.wireTap). It holds
 * transcript text: hand it to the bench's files, never to a log line.
 */
export type SttWireRecord =
  /**
   * The connect, once, before the handshake: the URL's query with every parameter that carries the
   * access token left out (queryWithoutToken). Never the URL, never the headers.
   */
  | { kind: 'connect'; label: string; query: string }
  /** A text message, as it went to the vendor or came from it. */
  | { kind: 'text'; label: string; direction: 'sent' | 'received'; text: string }
  /** A binary message by its size: the audio Roger sent, which the bench holds itself. */
  | { kind: 'binary'; label: string; direction: 'sent' | 'received'; bytes: number };

export type SttWireTap = (record: SttWireRecord) => void;

/**
 * Dead-socket detection (M2 design, "STT reconnect"). `ws` gets no prompt error when the Mac's
 * network goes down: a half-open socket looks open until TCP gives up, minutes later, while the
 * audio sent into it is lost and nothing says so. So while audio flows the core pings the vendor,
 * and a socket that answered pings and then hears nothing at all (no pong, no message) for
 * deadAfterMs is dead: one fatal error and a terminate, and CaptureSession's landed retry reopens
 * it through the open budget. With the check once per pingIntervalMs, a cut is declared at most
 * deadAfterMs plus one interval after the last thing heard (4 to 5 s), whatever the phase of the
 * cycle: inside the exit check's 10 s warning, with the 1 s network poll catching Wi-Fi off first.
 */
export interface SttLiveness {
  /** A WebSocket ping this often while audio flows; the deadline is checked as often. */
  pingIntervalMs: number;
  /** Once the vendor has answered a ping: no pong and no message this long is a dead socket. */
  deadAfterMs: number;
  /**
   * No pong this long after the first ping: the vendor ignores pings (RFC 6455 says answer, not
   * every server does). The socket then has no deadline and relies on vendor messages and closes,
   * send errors and main's network poll; declaring it dead would reopen a healthy, billed session
   * every few seconds for good. Said once in the log.
   */
  firstPongWithinMs: number;
}

export const STT_LIVENESS: Readonly<SttLiveness> = Object.freeze({
  pingIntervalMs: 1_000,
  deadAfterMs: 4_000,
  firstPongWithinMs: 10_000,
});

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
   * Monotonic ms, for pacing and the liveness deadline (performance.now() in the app). Never the
   * wall clock: an NTP step or a manual time change forward would count as time passed and send a
   * backlog at once, the 3007 close pacing exists to prevent, or declare a healthy socket dead (a
   * billed reopen and a false gap); a step back would hold a backlog, or hide a dead socket, until
   * the clock caught up. Node's timers run on monotonic time too, so the pace timer and the
   * liveness check share this time base.
   */
  paceClock: () => number;
  /** The ping cadence and deadlines (STT_LIVENESS in the app; tests shorten the interval). */
  liveness: SttLiveness;
  /** Sees every message both ways and the query without the token (SttWireRecord). Bench only. */
  wireTap?: SttWireTap | null;
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
  private readonly liveness: SttLiveness;
  /** Pings and checks the deadline while open (checkLiveness). */
  private livenessTimer: NodeJS.Timeout | null = null;
  /** paceClock time the vendor last sent anything: a pong, a ping, a message. */
  private heardAtMs = 0;
  /** Whether the vendor answers pings: unknown until its first pong, or firstPongWithinMs. */
  private pongs: 'unknown' | 'answered' | 'ignored' = 'unknown';
  private firstPingAtMs: number | null = null;
  /** No audio flows, so no ping goes: the deadline starts over when audio does. */
  private pingsIdle = true;
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
  /** Null without one, and from its first failure on (tap). */
  private wireTap: SttWireTap | null;

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
    this.liveness = options.liveness;
    this.pacer = new AudioPacer({ pacing: this.protocol.audioPacing, sampleRate: this.sampleRate });
    this.wireTap = options.wireTap ?? null;
    const stream = this.withCappedKeyterms(options.stream);
    this.keyterms = stream.settings.keyterms ?? [];
    // Throws SttConnectError on settings the vendor cannot take, before any socket exists.
    const target = this.protocol.target(stream);
    // Before the socket exists, and never the URL: an AssemblyAI URL carries the temporary token.
    // A tap that cannot take this first record (the bench opens its file on it) fails the connect
    // here, with nothing opened or billed: no listener exists yet to hear an error event (tap).
    if (this.wireTap !== null) {
      const failure = this.recordOnTap({
        kind: 'connect',
        label: this.label,
        query: queryWithoutToken(target.url, stream.accessToken),
      });
      if (failure !== null) throw new SttConnectError(failure);
    }
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
    // Any frame from the vendor is a sign of life (checkLiveness); ws answers its pings itself.
    this.socket.on('pong', () => {
      this.heard();
      this.pongs = 'answered';
    });
    this.socket.on('ping', () => {
      this.heard();
    });
    this.socket.on('message', (data, isBinary) => {
      this.heard();
      if (isBinary) {
        this.tap({
          kind: 'binary',
          label: this.label,
          direction: 'received',
          bytes: byteLength(data),
        });
        return;
      }
      const text = rawDataToString(data);
      this.tap({ kind: 'text', label: this.label, direction: 'received', text });
      this.handleMessage(text);
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
      this.stopLiveness();
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

  /**
   * Drops the connection now: no finish sequence, no wait for the vendor, no fatal error (the
   * caller asked). For CaptureSession's offline suspend (M2-T6): with the network gone a finish
   * can only wait out its deadline, while a half-open socket may bill until the vendor's own idle
   * timeout. Lines the protocol held still arrive before "closed"; audio the vendor had not turned
   * into lines is lost to this stream, which CaptureSession records as a gap. Also cuts short a
   * Stop still waiting for the vendor. Every call returns close()'s promise.
   */
  terminate(): Promise<void> {
    if (this.currentState === 'connecting') {
      this.failConnect(
        new SttConnectError(`${this.protocol.vendorName}: closed before the session began`),
      );
    } else if (this.currentState === 'open' || this.currentState === 'finishing') {
      this.logger.info('stt stream terminated: no finish sequence', { state: this.currentState });
      this.dropPacedAudio();
      this.stopKeepAlive();
      this.stopLiveness();
      // Left 'open', finalize would report the close as the vendor ending the stream mid-call.
      this.currentState = 'finishing';
      this.socket.terminate();
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
    // A failed connect stays failed while its socket is terminated: a ready message read after it
    // (the one a wire tap just failed on, or one that raced the connect timeout) would resolve
    // whenOpen() on a dead session and lose the connect error to a false "closed the stream".
    if (this.currentState !== 'connecting' || this.connectError !== null) return;
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
          this.transmit(keepAlive.message);
        }
      }, keepAlive.intervalMs);
    }
    this.livenessTimer = setInterval(() => {
      this.checkLiveness();
    }, this.liveness.pingIntervalMs);
    this.pacer.start(this.paceClock());
    this.opening.resolve();
  }

  /**
   * One liveness check (SttLiveness): runs every pingIntervalMs while open. The timer only wakes
   * it; paceClock decides what is due. Pings go only while audio flows, by the keep-alive's rule: a
   * source that sent nothing for keepAliveForMs is stalled (CaptureSession closes it), and while no
   * ping goes, no pong is owed, so the deadline starts over when audio does. Before the first pong
   * there is no deadline at all: a vendor that ignores pings is not a dead one.
   */
  private checkLiveness(): void {
    if (this.currentState !== 'open' || this.socket.readyState !== WebSocket.OPEN) return;
    const now = this.paceClock();
    if (!this.audioFlowing()) {
      this.pingsIdle = true;
      return;
    }
    if (this.pingsIdle) {
      this.pingsIdle = false;
      this.heardAtMs = now;
    }
    if (this.pongs === 'answered') {
      const silentMs = now - this.heardAtMs;
      if (silentMs >= this.liveness.deadAfterMs) {
        this.declareDead(silentMs);
        return;
      }
    } else if (
      this.firstPingAtMs !== null &&
      now - this.firstPingAtMs >= this.liveness.firstPongWithinMs
    ) {
      this.pongs = 'ignored';
      this.stopLiveness();
      this.logger.warn('stt vendor answers no ping: no dead-socket check on this stream', {
        waitedMs: Math.round(now - this.firstPingAtMs),
      });
      return;
    }
    this.socket.ping();
    this.firstPingAtMs ??= now;
  }

  /** Audio was sent within the keep-alive window: what keeps pings, and the deadline, going. */
  private audioFlowing(): boolean {
    return this.lastAudioAtMs !== null && this.clock() - this.lastAudioAtMs < this.keepAliveForMs;
  }

  private heard(): void {
    this.heardAtMs = this.paceClock();
  }

  /**
   * The vendor stopped answering: the network under the socket is gone (Wi-Fi dropped, a proxy cut
   * it). Terminated, not closed: a peer that answers no ping answers no close frame or finish
   * either, and ws waits 30 s for a close frame. The fatal error hands it to CaptureSession's
   * landed retry, which reopens through the open budget.
   */
  private declareDead(silentMs: number): void {
    this.logger.warn('stt socket dead: the vendor stopped answering', {
      silentMs: Math.round(silentMs),
    });
    this.dropPacedAudio();
    this.stopKeepAlive();
    this.stopLiveness();
    // Before the report, as in endAfterFatal: a close() from the listener must find nothing to finish.
    this.currentState = 'finishing';
    this.socket.terminate();
    this.reportFatal(
      `${this.protocol.vendorName} stopped answering: nothing received for ${Math.round(silentMs / 1000)} s`,
    );
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
    this.stopLiveness();
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
      if (typeof message === 'string') this.transmit(message);
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
   * them: CaptureSession's per-stream AudioTimeline counts the vendor's clock in the samples it
   * sent, so dropping or reordering bytes would shift every later line of the stream.
   */
  private sendFrame(frame: Uint8Array): void {
    this.transmit(frame);
    this.audioSentBytes += frame.byteLength;
  }

  /**
   * Every message to the vendor goes through here, so the wire tap sees what the vendor sees. Audio
   * reaches it only through pump() and sendFrame (pacing); text is the finish sequence and the
   * keep-alive.
   */
  private transmit(data: string | Uint8Array): void {
    this.socket.send(data);
    this.tap(
      typeof data === 'string'
        ? { kind: 'text', label: this.label, direction: 'sent', text: data }
        : { kind: 'binary', label: this.label, direction: 'sent', bytes: data.byteLength },
    );
  }

  /**
   * Hands one record to the wire tap, if there is one. A tap that throws (the bench's disk is
   * full) must not end a billed session mid-item, or escape a socket handler and kill the process
   * with sockets open. It is switched off for this stream at its first failure, because a
   * recording with holes would pass for the whole wire, and the bench is told, so it can fail the
   * item it no longer records: once open by a non-fatal error, before that by a failed connect.
   * Before ready no listener exists (openStream hands the stream over only once it is open), so an
   * error event there reached no one and the item ran to its end unrecorded, with nothing to say
   * so. The connect record itself fails in the constructor, before any socket (see there).
   */
  private tap(record: SttWireRecord): void {
    const failure = this.recordOnTap(record);
    if (failure === null) return;
    if (this.currentState === 'connecting') this.failConnect(new SttConnectError(failure));
    else this.deliver({ type: 'error', message: failure, fatal: false });
  }

  /** Runs the tap on one record. Returns why it failed (logged, the tap switched off), else null. */
  private recordOnTap(record: SttWireRecord): string | null {
    if (this.wireTap === null) return null;
    try {
      this.wireTap(record);
      return null;
    } catch (error) {
      this.wireTap = null;
      this.logger.error('stt wire tap failed', { record: record.kind, error: errorMessage(error) });
      return `${this.protocol.vendorName} wire tap failed: ${errorMessage(error)}`;
    }
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
    this.stopLiveness();
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

  private stopLiveness(): void {
    if (this.livenessTimer !== null) clearInterval(this.livenessTimer);
    this.livenessTimer = null;
  }

  private clearPaceTimer(): void {
    if (this.paceTimer !== null) clearTimeout(this.paceTimer);
    this.paceTimer = null;
  }
}

/**
 * The URL's query with every parameter that carries the token left out, in the order and encoding
 * it was sent. Matched on the token's value, not on a parameter name, so a vendor that takes it in
 * the query under any name is covered without declaring anything (AssemblyAI's `token`), and a
 * vendor that takes it in a header (Deepgram) loses nothing. Never throws: it runs before the
 * socket exists. String work rather than `new URL`, so an odd URL cannot throw here either.
 */
function queryWithoutToken(url: string, token: string): string {
  const start = url.indexOf('?');
  if (start === -1) return '';
  const end = url.indexOf('#', start);
  return url
    .slice(start + 1, end === -1 ? undefined : end)
    .split('&')
    .filter((pair) => pair !== '' && !carriesToken(pair, token))
    .join('&');
}

function carriesToken(pair: string, token: string): boolean {
  if (token === '') return false;
  if (pair.includes(token)) return true;
  try {
    return decodeURIComponent(pair.replaceAll('+', ' ')).includes(token);
  } catch {
    // Not valid percent-encoding, so it cannot be read for the token: left out, never risked.
    return true;
  }
}

function byteLength(data: WebSocket.RawData): number {
  if (Array.isArray(data)) return data.reduce((total, part) => total + part.byteLength, 0);
  return data.byteLength;
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
