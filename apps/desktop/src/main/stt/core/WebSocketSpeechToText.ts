import { DEFAULT_COST_GUARDS } from '../../costGuards';
import type { Logger } from '../../logger';
import type { OpenStreamOptions, SpeechToText, SttStream } from '../SpeechToText';
import { sumUsage, type SttUsage } from '../usage';
import { SttConnection } from './SttConnection';
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
  clock?: () => number;
}

/**
 * SpeechToText for any websocket vendor: the vendor's SttProtocol says what to send and how to read
 * the answers; SttConnection runs the one lifecycle. Vendor classes (AssemblyAiSpeechToText,
 * DeepgramSpeechToText) only build their protocol and pass it here.
 */
export class WebSocketSpeechToText implements SpeechToText {
  readonly provider: string;
  readonly vendorName: string;
  /** What the adapter runs; the conformance suite checks its declarations against the vendor. */
  readonly protocol: SttProtocol;
  private readonly logger: Logger;
  private readonly connectTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly keepAliveForMs: number;
  private readonly clock: () => number;
  /**
   * Every connection this adapter made, failed ones too, for usage(). CaptureService makes one
   * adapter per meeting, so this is one meeting's sessions: two at Start, plus any reopens.
   */
  private readonly connections: SttConnection[] = [];

  constructor(protocol: SttProtocol, options: WebSocketSttOptions) {
    this.provider = protocol.provider;
    this.vendorName = protocol.vendorName;
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
