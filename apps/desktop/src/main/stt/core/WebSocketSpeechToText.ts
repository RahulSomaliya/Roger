import type { Logger } from '../../logger';
import type { OpenStreamOptions, SpeechToText, SttStream } from '../SpeechToText';
import { SttConnection, type SttStreamUsage } from './SttConnection';
import type { SttProtocol } from './SttProtocol';

export interface SttUsage extends SttStreamUsage {
  /** Sockets that completed the handshake, failed connects included: each may be billed. */
  sessionsOpened: number;
}

export interface WebSocketSttOptions {
  logger: Logger;
  /** Handshake plus the vendor's ready signal. */
  connectTimeoutMs?: number;
  /** Hard cap on close(): past it the socket is terminated. */
  closeTimeoutMs?: number;
  clock?: () => number;
}

/**
 * SpeechToText for any websocket vendor: the vendor's SttProtocol says what to send and how to read
 * the answers; SttConnection runs the one lifecycle. Vendor classes (AssemblyAiSpeechToText,
 * DeepgramSpeechToText) only build their protocol and pass it here.
 */
export class WebSocketSpeechToText implements SpeechToText {
  readonly provider: string;
  private readonly logger: Logger;
  private readonly connectTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly clock: () => number;
  /** Every connection this adapter made, failed ones too, for usage(). Two per meeting. */
  private readonly connections: SttConnection[] = [];

  constructor(
    private readonly protocol: SttProtocol,
    options: WebSocketSttOptions,
  ) {
    this.provider = protocol.provider;
    this.logger = options.logger;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.closeTimeoutMs = options.closeTimeoutMs ?? 5_000;
    this.clock = options.clock ?? (() => Date.now());
  }

  async openStream(options: OpenStreamOptions): Promise<SttStream> {
    const connection = new SttConnection({
      protocol: this.protocol,
      stream: options,
      logger: this.logger,
      connectTimeoutMs: this.connectTimeoutMs,
      closeTimeoutMs: this.closeTimeoutMs,
      clock: this.clock,
    });
    this.connections.push(connection);
    await connection.whenOpen();
    return connection;
  }

  /** What this adapter has opened so far: the vendor's billing view, live streams to now. */
  usage(): SttUsage {
    const usage: SttUsage = { sessionsOpened: 0, connectedMs: 0, audioSentMs: 0, droppedChunks: 0 };
    for (const connection of this.connections) {
      if (connection.opened) usage.sessionsOpened += 1;
      const stream = connection.usage();
      usage.connectedMs += stream.connectedMs;
      usage.audioSentMs += stream.audioSentMs;
      usage.droppedChunks += stream.droppedChunks;
    }
    return usage;
  }
}
