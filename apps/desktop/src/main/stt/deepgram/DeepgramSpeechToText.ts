import WebSocket from 'ws';
import { errorMessage, type Logger } from '../../logger';
import {
  type OpenStreamOptions,
  type SpeechToText,
  SttEventEmitter,
  type SttEventListener,
  type SttStream,
  type SttStreamSettings,
} from '../SpeechToText';
import { rawDataToString, waitForOpen } from '../websocket';
import {
  DEEPGRAM_CLOSE_STREAM,
  DEEPGRAM_FINALIZE,
  DEEPGRAM_KEEP_ALIVE,
  parseDeepgramMessage,
} from './messages';

export const DEEPGRAM_DEFAULT_BASE_URL = 'wss://api.deepgram.com';

export interface DeepgramOptions {
  logger: Logger;
  baseUrl?: string;
  /** Deepgram closes idle sockets after ~10 s; a KeepAlive every 5 s keeps quiet streams alive. */
  keepAliveMs?: number;
  connectTimeoutMs?: number;
  closeTimeoutMs?: number;
}

/** The query string Deepgram's `/v1/listen` websocket expects for raw PCM. */
export function buildListenUrl(baseUrl: string, settings: SttStreamSettings): string {
  const url = new URL('/v1/listen', baseUrl);
  const params: Record<string, string> = {
    model: settings.model,
    language: settings.language,
    encoding: settings.encoding,
    sample_rate: String(settings.sampleRate),
    channels: '1',
    interim_results: 'true',
    punctuate: 'true',
    smart_format: 'true',
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

export class DeepgramSpeechToText implements SpeechToText {
  readonly provider = 'deepgram';
  private readonly baseUrl: string;
  private readonly keepAliveMs: number;
  private readonly connectTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly logger: Logger;

  constructor(options: DeepgramOptions) {
    this.logger = options.logger;
    this.baseUrl = options.baseUrl ?? DEEPGRAM_DEFAULT_BASE_URL;
    this.keepAliveMs = options.keepAliveMs ?? 5_000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.closeTimeoutMs = options.closeTimeoutMs ?? 5_000;
  }

  async openStream(options: OpenStreamOptions): Promise<SttStream> {
    const url = buildListenUrl(this.baseUrl, options.settings);
    const logger = this.logger.child({ stream: options.label });
    // A backend-minted grant is a bearer token. A raw API key would be `Token ...`, but raw keys
    // never reach the desktop (house rule 3).
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${options.accessToken}` },
      handshakeTimeout: this.connectTimeoutMs,
    });
    await waitForOpen(socket, this.connectTimeoutMs);
    logger.info('deepgram stream open', { model: options.settings.model });
    return new DeepgramStream(socket, logger, this.keepAliveMs, this.closeTimeoutMs);
  }
}

class DeepgramStream implements SttStream {
  private readonly emitter = new SttEventEmitter();
  private readonly keepAlive: NodeJS.Timeout;
  private closing = false;
  private closed = false;
  private droppedChunks = 0;
  private closedPromise: Promise<void>;

  constructor(
    private readonly socket: WebSocket,
    private readonly logger: Logger,
    keepAliveMs: number,
    private readonly closeTimeoutMs: number,
  ) {
    this.closedPromise = new Promise((resolve) => {
      socket.on('close', (code, reason) => {
        this.closed = true;
        clearInterval(this.keepAlive);
        this.emitter.emit({
          type: 'closed',
          code,
          reason: reason.length > 0 ? reason.toString() : null,
        });
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
      this.logger.error('deepgram socket error', { error: errorMessage(error) });
      this.emitter.emit({ type: 'error', message: error.message, fatal: true });
    });
    this.keepAlive = setInterval(() => {
      if (this.socket.readyState === WebSocket.OPEN && !this.closing) {
        this.socket.send(DEEPGRAM_KEEP_ALIVE);
      }
    }, keepAliveMs);
  }

  send(pcm: Uint8Array): void {
    if (this.socket.readyState !== WebSocket.OPEN || this.closing) {
      this.droppedChunks += 1;
      if (this.droppedChunks === 1) this.logger.warn('dropping audio: deepgram socket not open');
      return;
    }
    this.socket.send(pcm);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (!this.closing) {
      this.closing = true;
      clearInterval(this.keepAlive);
      if (this.socket.readyState === WebSocket.OPEN) {
        // Finalize flushes buffered audio into final results; CloseStream then ends the session.
        this.socket.send(DEEPGRAM_FINALIZE);
        this.socket.send(DEEPGRAM_CLOSE_STREAM);
      }
      const timer = setTimeout(() => {
        this.logger.warn('deepgram did not close in time, terminating', {
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

  private handleMessage(raw: string): void {
    const parsed = parseDeepgramMessage(raw);
    switch (parsed.kind) {
      case 'event':
        if (parsed.warning !== undefined) {
          this.logger.warn('deepgram message partly understood', { warning: parsed.warning });
        }
        this.emitter.emit(parsed.event);
        return;
      case 'ignored':
        this.logger.debug('deepgram message ignored', { messageType: parsed.messageType });
        return;
      case 'invalid':
        // No raw payload in the log: it may contain transcript text.
        this.logger.warn('deepgram message not understood', {
          reason: parsed.reason,
          bytes: raw.length,
        });
        // Non-fatal: one unreadable message (vendor format drift) must not end the stream.
        this.emitter.emit({
          type: 'error',
          message: `Deepgram sent a message Roger could not read (${parsed.reason})`,
          fatal: false,
        });
    }
  }
}
