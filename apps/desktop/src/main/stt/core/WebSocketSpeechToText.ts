import { DEFAULT_COST_GUARDS } from '../../costGuards';
import type { Logger } from '../../logger';
import type { OpenStreamOptions, SpeechToText, SttCredentialUse, SttStream } from '../SpeechToText';
import { sumUsage, type SttUsage } from '../usage';
import {
  STT_LIVENESS,
  SttConnection,
  type SttLiveness,
  type SttPongRecord,
  type SttWireTap,
} from './SttConnection';
import type { SttProtocol } from './SttProtocol';

export interface WebSocketSttOptions {
  logger: Logger;
  /** Handshake plus the vendor's ready signal. */
  connectTimeoutMs?: number;
  /** Hard cap on close(): past it the socket is terminated. */
  closeTimeoutMs?: number;
  /** Overrides the protocol's keep-alive interval (tests). No effect on a vendor without one. */
  keepAliveMs?: number;
  /** Keep-alive only while audio was sent within this long. Default: the capture's stall close. */
  keepAliveForMs?: number;
  /** Wall-clock ms for the meter and the keep-alive window. Default: Date.now(). */
  clock?: () => number;
  /**
   * Monotonic ms for pacing (tests pass a manual one). Default: performance.now(). Never Date.now():
   * a wall-clock step forward sends a backlog at once (SttConnectionOptions.paceClock).
   */
  paceClock?: () => number;
  /**
   * The dead-socket check's cadence and deadlines (SttLiveness), over STT_LIVENESS. Tests shorten
   * the ping interval and drive paceClock by hand; the app keeps the defaults.
   */
  liveness?: Partial<SttLiveness>;
  /**
   * The benchmark's wire tap (M3-T11): every message of every stream this adapter opens, both
   * ways, and each connect's query with the token left out (SttWireRecord). `bench run` stores the
   * query in run.json; `bench canary --save-wire` writes the vendor's messages as the wire fixtures
   * (stt/assemblyai/fixtures/). Only the bench passes one: the app never records the wire, which
   * holds transcript text. A tap that throws is switched off for that stream: before the session
   * began, openStream rejects with SttConnectError; once open, the stream emits one non-fatal error
   * (SttConnection.tap). Either way the bench fails the item its recording no longer covers.
   */
  wireTap?: SttWireTap;
}

/**
 * SpeechToText for any websocket vendor: the vendor's SttProtocol says what to send and how to read
 * the answers; SttConnection runs the one lifecycle. Vendor classes (AssemblyAiSpeechToText,
 * DeepgramSpeechToText) only build their protocol and pass it here.
 */
export class WebSocketSpeechToText implements SpeechToText {
  readonly provider: string;
  readonly vendorName: string;
  readonly credentialUse: SttCredentialUse;
  /** What the adapter runs; the conformance suite checks its declarations against the vendor. */
  readonly protocol: SttProtocol;
  private readonly logger: Logger;
  private readonly connectTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly keepAliveForMs: number;
  private readonly clock: () => number;
  private readonly paceClock: () => number;
  private readonly liveness: SttLiveness;
  private readonly wireTap: SttWireTap | null;
  /**
   * Every connection this adapter made, failed ones too, for usage(). CaptureService makes one
   * adapter per meeting, so this is one meeting's sessions: two at Start, plus any reopens.
   */
  private readonly connections: SttConnection[] = [];
  /** Shared by every stream: once one answered a ping, the vendor does (SttPongRecord). */
  private readonly pongRecord: SttPongRecord = { answered: false };

  constructor(protocol: SttProtocol, options: WebSocketSttOptions) {
    this.provider = protocol.provider;
    this.vendorName = protocol.vendorName;
    this.credentialUse = protocol.credentialUse;
    const keepAlive = protocol.keepAlive;
    this.protocol =
      keepAlive !== null && options.keepAliveMs !== undefined
        ? { ...protocol, keepAlive: { ...keepAlive, intervalMs: options.keepAliveMs } }
        : protocol;
    this.logger = options.logger;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.closeTimeoutMs = options.closeTimeoutMs ?? 5_000;
    this.keepAliveForMs = options.keepAliveForMs ?? DEFAULT_COST_GUARDS.sttStallCloseMs;
    this.clock = options.clock ?? (() => Date.now());
    this.paceClock = options.paceClock ?? (() => performance.now());
    this.liveness = { ...STT_LIVENESS, ...options.liveness };
    this.wireTap = options.wireTap ?? null;
  }

  async openStream(options: OpenStreamOptions): Promise<SttStream> {
    const connection = new SttConnection({
      protocol: this.protocol,
      stream: options,
      logger: this.logger,
      connectTimeoutMs: this.connectTimeoutMs,
      closeTimeoutMs: this.closeTimeoutMs,
      keepAliveForMs: this.keepAliveForMs,
      clock: this.clock,
      paceClock: this.paceClock,
      liveness: this.liveness,
      pongRecord: this.pongRecord,
      wireTap: this.wireTap,
    });
    this.connections.push(connection);
    await connection.whenOpen();
    return connection;
  }

  /** What this adapter has opened so far: the vendor's billing view, live streams to now. */
  usage(label?: string): SttUsage {
    return sumUsage(
      this.connections
        .filter((connection) => label === undefined || connection.label === label)
        .map((connection) => ({
          opened: connection.opened,
          pricePerHourUsd: connection.pricePerHourUsd,
          ...connection.usage(),
        })),
    );
  }
}
