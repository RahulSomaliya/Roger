import WebSocket, { type RawData } from 'ws';
import { errorMessage, type Logger } from '../../logger';
import {
  type OpenStreamOptions,
  type SpeechToText,
  SttConnectError,
  SttEventEmitter,
  type SttEventListener,
  type SttStream,
  type SttStreamSettings,
} from '../SpeechToText';
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

function waitForOpen(socket: WebSocket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error: SttConnectError | null): void => {
      clearTimeout(timer);
      socket.off('open', onOpen);
      socket.off('error', onError);
      socket.off('unexpected-response', onUnexpected);
      if (error) {
        // ws throws on an 'error' with no listener; keep one attached while we tear down.
        socket.on('error', () => undefined);
        socket.terminate();
        reject(error);
      } else {
        resolve();
      }
    };
    const timer = setTimeout(() => {
      finish(new SttConnectError(`connection timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    const onOpen = (): void => {
      finish(null);
    };
    const onError = (error: Error): void => {
      finish(new SttConnectError(error.message));
    };
    const onUnexpected = (_request: unknown, response: { statusCode?: number }): void => {
      const status = response.statusCode ?? null;
      finish(new SttConnectError(`rejected with HTTP ${status ?? 'unknown'}`, status));
    };
    socket.once('open', onOpen);
    socket.once('error', onError);
    socket.once('unexpected-response', onUnexpected);
  });
}

/** ws hands text frames over as Buffer, Buffer[] or ArrayBuffer depending on the transport. */
export function rawDataToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
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
      this.handleMessage(rawDataToString(data));
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
        this.emitter.emit(parsed.event);
        return;
      case 'ignored':
        this.logger.debug('deepgram message ignored', { messageType: parsed.messageType });
        return;
      case 'invalid':
        this.logger.warn('deepgram message not understood', {
          reason: parsed.reason,
          sample: raw.slice(0, 200),
        });
    }
  }
}
