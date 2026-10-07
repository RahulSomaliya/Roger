import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { createLogger, type Logger } from '../../logger';
import { SttConnectError, type SttEvent, type SttStreamSettings } from '../SpeechToText';
import { rawDataToString } from '../websocket';
import { buildListenUrl, DeepgramSpeechToText } from './DeepgramSpeechToText';

const logger = createLogger({ level: 'error', format: 'json', sink: () => undefined });
const settings: SttStreamSettings = {
  model: 'nova-3',
  language: 'en',
  sampleRate: 16000,
  encoding: 'linear16',
  pricePerHourUsd: 0.462,
};

interface ServerLog {
  headers: Record<string, string | string[] | undefined>;
  url: string;
  text: string[];
  binaryBytes: number;
}

describe('buildListenUrl', () => {
  it('encodes the stream settings the way Deepgram expects', () => {
    const url = new URL(buildListenUrl('wss://api.deepgram.com', settings));
    expect(url.pathname).toBe('/v1/listen');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      model: 'nova-3',
      language: 'en',
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
      interim_results: 'true',
      punctuate: 'true',
      smart_format: 'true',
      mip_opt_out: 'true',
    });
  });

  it('always opts out of model training, list or no list', () => {
    for (const each of [
      settings,
      { ...settings, keyterms: [] },
      { ...settings, keyterms: ['L'] },
    ]) {
      const url = new URL(buildListenUrl('wss://api.deepgram.com', each));
      expect(url.searchParams.getAll('mip_opt_out')).toEqual(['true']);
    }
  });

  it('sends one keyterm per term, spaces encoded as %20', () => {
    const raw = buildListenUrl('wss://api.deepgram.com', {
      ...settings,
      keyterms: ['Linkt', 'order number', 'R&D'],
    });

    expect(new URL(raw).searchParams.getAll('keyterm')).toEqual(['Linkt', 'order number', 'R&D']);
    // %20, never '+': a form-decoded '+' is a space, but a plain percent-decoder keeps it a '+'.
    expect(raw).toContain('keyterm=Linkt&keyterm=order%20number&keyterm=R%26D');
  });

  it('sends no keyterm without a list', () => {
    for (const each of [settings, { ...settings, keyterms: [] }]) {
      const raw = buildListenUrl('wss://api.deepgram.com', each);
      expect(raw).not.toContain('keyterm');
    }
  });
});

describe('DeepgramSpeechToText', () => {
  let server: WebSocketServer;
  let baseUrl: string;
  let log: ServerLog;
  let rejectWith: number | null;
  /** Every handshake attempted, refused ones too. */
  let handshakes: number;

  beforeEach(async () => {
    rejectWith = null;
    handshakes = 0;
    log = { headers: {}, url: '', text: [], binaryBytes: 0 };
    server = new WebSocketServer({
      port: 0,
      verifyClient: (_info, done) => {
        handshakes += 1;
        if (rejectWith !== null) done(false, rejectWith, 'nope');
        else done(true);
      },
    });
    await new Promise<void>((resolve) => {
      server.once('listening', () => {
        resolve();
      });
    });
    baseUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
    server.on('connection', (socket: WebSocket, request) => {
      log.headers = request.headers;
      log.url = request.url ?? '';
      socket.on('message', (data, isBinary) => {
        if (isBinary) {
          log.binaryBytes += (data as Buffer).length;
          socket.send(results('hello', false));
          socket.send(results('hello there', true));
          return;
        }
        const text = rawDataToString(data);
        log.text.push(text);
        if (text.includes('CloseStream')) {
          socket.send(JSON.stringify({ type: 'Metadata', request_id: 'r' }));
          socket.close(1000, 'done');
        }
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  it('authenticates with a bearer token, streams audio, and shuts down cleanly', async () => {
    const stt = new DeepgramSpeechToText({ logger, baseUrl, keepAliveMs: 20 });
    const stream = await stt.openStream({ accessToken: 'jwt-123', settings, label: 'mic' });
    const events: SttEvent[] = [];
    stream.on((event) => events.push(event));

    expect(log.headers.authorization).toBe('Bearer jwt-123');
    expect(log.url).toContain('/v1/listen?model=nova-3');

    stream.send(new Uint8Array(3200));
    await waitFor(() => events.filter((e) => e.type === 'final').length === 1);
    await waitFor(() => log.text.some((t) => t.includes('KeepAlive')));

    await stream.close();
    expect(log.binaryBytes).toBe(3200);
    expect(log.text.filter((t) => t.includes('Finalize'))).toHaveLength(1);
    expect(log.text.filter((t) => t.includes('CloseStream'))).toHaveLength(1);
    expect(events.map((e) => e.type)).toEqual(['interim', 'final', 'closed']);
    expect(events.at(-1)).toEqual({ type: 'closed', code: 1000, reason: 'done' });
  });

  it('turns a message it cannot read into a non-fatal error and keeps the stream open', async () => {
    server.removeAllListeners('connection');
    server.on('connection', (socket: WebSocket) => {
      socket.on('message', (_data, isBinary) => {
        if (!isBinary) return;
        socket.send(JSON.stringify({ type: 'Results', channel: null }));
        socket.send(results('still here', true));
      });
    });
    const stt = new DeepgramSpeechToText({ logger, baseUrl, closeTimeoutMs: 50 });
    const stream = await stt.openStream({ accessToken: 't', settings, label: 'mic' });
    const events: SttEvent[] = [];
    stream.on((event) => events.push(event));
    stream.send(new Uint8Array(3200));
    await waitFor(() => events.some((e) => e.type === 'final'));
    expect(events[0]).toMatchObject({ type: 'error', fatal: false });
    expect(events[1]).toMatchObject({ type: 'final', text: 'still here' });
    await stream.close();
  });

  it('reports a rejected handshake as a connect error with the status code', async () => {
    rejectWith = 401;
    const stt = new DeepgramSpeechToText({ logger, baseUrl });
    const error = await stt
      .openStream({ accessToken: 'bad', settings, label: 'mic' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SttConnectError);
    expect((error as SttConnectError).statusCode).toBe(401);
  });

  it('sends the jargon list cut to the shared limits, with a warning', async () => {
    const recorded = recordingLogger();
    const stt = new DeepgramSpeechToText({ logger: recorded.logger, baseUrl });
    const keyterms = Array.from({ length: 120 }, (_, index) => `Term${index}`);
    const stream = await stt.openStream({
      accessToken: 't',
      settings: { ...settings, keyterms },
      label: 'mic',
    });
    await stream.close();

    const sent = new URL(log.url, 'ws://local').searchParams.getAll('keyterm');
    expect(sent).toEqual(keyterms.slice(0, 100));
    expect(recorded.warnings).toContain('stt keyterms cut to the vendor limits');
  });

  it('rejects an HTTP 400 with keyterms as a rejected jargon list, after one handshake', async () => {
    rejectWith = 400;
    const stt = new DeepgramSpeechToText({ logger, baseUrl });
    const error = await stt
      .openStream({
        accessToken: 't',
        settings: { ...settings, keyterms: ['Linkt'] },
        label: 'mic',
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SttConnectError);
    expect((error as SttConnectError).keytermsRejected).toBe(true);
    expect((error as SttConnectError).statusCode).toBe(400);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(handshakes).toBe(1);
  });

  it('reports an HTTP 400 without keyterms, or another status with them, as a plain connect error', async () => {
    const stt = new DeepgramSpeechToText({ logger, baseUrl });
    for (const [status, keyterms] of [
      [400, []],
      [401, ['Linkt']],
    ] as const) {
      rejectWith = status;
      const error = await stt
        .openStream({ accessToken: 't', settings: { ...settings, keyterms }, label: 'mic' })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(SttConnectError);
      expect((error as SttConnectError).keytermsRejected).toBe(false);
      expect((error as SttConnectError).statusCode).toBe(status);
    }
  });

  it('says what a Deepgram close reason means when it ends the stream mid-call', async () => {
    server.removeAllListeners('connection');
    server.on('connection', (socket: WebSocket) => {
      socket.on('message', () => {
        socket.close(1011, 'NET-0001');
      });
    });
    const stt = new DeepgramSpeechToText({ logger, baseUrl });
    const stream = await stt.openStream({ accessToken: 't', settings, label: 'system' });
    const events: SttEvent[] = [];
    stream.on((event) => events.push(event));

    stream.send(new Uint8Array(3200));
    await waitFor(() => events.some((e) => e.type === 'closed'));
    expect(events).toEqual([
      {
        type: 'error',
        message:
          'Deepgram closed the stream (code 1011: NET-0001, no audio or KeepAlive reached ' +
          'Deepgram in time)',
        fatal: true,
      },
      { type: 'closed', code: 1011, reason: 'NET-0001' },
    ]);
  });

  it('closes even when the vendor never answers CloseStream', async () => {
    server.removeAllListeners('connection');
    server.on('connection', () => undefined);
    const stt = new DeepgramSpeechToText({ logger, baseUrl, closeTimeoutMs: 50 });
    const stream = await stt.openStream({ accessToken: 't', settings, label: 'system' });
    const started = Date.now();
    await stream.close();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

function recordingLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    logger: createLogger({
      level: 'warn',
      format: 'json',
      sink: (line) => warnings.push((JSON.parse(line) as { message: string }).message),
    }),
  };
}

function results(transcript: string, isFinal: boolean): string {
  return JSON.stringify({
    type: 'Results',
    channel_index: [0, 1],
    start: 0,
    duration: 0.1,
    is_final: isFinal,
    channel: { alternatives: [{ transcript, confidence: 0.9, words: [] }] },
    metadata: {
      request_id: 'r',
      model_info: { name: 'nova-3', version: '1', arch: 'x' },
      model_uuid: 'u',
    },
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
