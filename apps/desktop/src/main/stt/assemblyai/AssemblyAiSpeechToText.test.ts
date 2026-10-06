import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { createLogger } from '../../logger';
import { SttConnectError, type SttEvent, type SttStreamSettings } from '../SpeechToText';
import { rawDataToString } from '../websocket';
import {
  AssemblyAiSpeechToText,
  type AssemblyAiOptions,
  buildStreamingUrl,
} from './AssemblyAiSpeechToText';

const logger = createLogger({ level: 'error', format: 'json', sink: () => undefined });
const settings: SttStreamSettings = {
  model: 'universal-streaming-english',
  language: 'en',
  sampleRate: 16000,
  encoding: 'linear16',
};
const CHUNK_100_MS = 3200;

interface ServerLog {
  headers: Record<string, string | string[] | undefined>;
  url: string;
  text: string[];
  binaryFrames: number[];
}

/** What the fake vendor does: on connect, on each binary frame (numbered from 1), on Terminate. */
interface VendorScript {
  onConnect?(socket: WebSocket): void;
  onAudio?(socket: WebSocket, frame: number): void;
  onTerminate?(socket: WebSocket): void;
}

describe('buildStreamingUrl', () => {
  it('asks for the v3 stream with our PCM under AssemblyAI names, token as the auth', () => {
    const url = new URL(buildStreamingUrl('wss://streaming.assemblyai.com', settings, 'tok/en+1'));
    expect(url.pathname).toBe('/v3/ws');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      speech_model: 'universal-streaming-english',
      sample_rate: '16000',
      encoding: 'pcm_s16le',
      format_turns: 'true',
      token: 'tok/en+1',
    });
  });

  it('leaves format_turns off for models that always format (Universal-3 Pro)', () => {
    const url = new URL(
      buildStreamingUrl(
        'wss://streaming.assemblyai.com',
        { ...settings, model: 'universal-3-6-pro' },
        't',
      ),
    );
    expect(url.searchParams.get('speech_model')).toBe('universal-3-6-pro');
    expect(url.searchParams.has('format_turns')).toBe(false);
  });

  it('refuses an encoding it has no AssemblyAI name for', () => {
    expect(() => buildStreamingUrl('wss://x', { ...settings, encoding: 'opus' }, 't')).toThrow(
      SttConnectError,
    );
  });
});

describe('AssemblyAiSpeechToText', () => {
  let server: WebSocketServer;
  let baseUrl: string;
  let log: ServerLog;
  let rejectWith: number | null;
  let script: VendorScript;

  beforeEach(async () => {
    rejectWith = null;
    script = {};
    log = { headers: {}, url: '', text: [], binaryFrames: [] };
    server = new WebSocketServer({
      port: 0,
      verifyClient: (_info, done) => {
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
      if (script.onConnect) script.onConnect(socket);
      else socket.send(begin());
      socket.on('message', (data, isBinary) => {
        if (isBinary) {
          log.binaryFrames.push((data as Buffer).length);
          script.onAudio?.(socket, log.binaryFrames.length);
          return;
        }
        const text = rawDataToString(data);
        log.text.push(text);
        if (text.includes('"Terminate"')) {
          if (script.onTerminate) script.onTerminate(socket);
          else socket.send(termination());
        }
      });
    });
  });

  afterEach(async () => {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  async function open(options: Partial<AssemblyAiOptions> = {}, accessToken = 'temp-token') {
    const stt = new AssemblyAiSpeechToText({ logger, baseUrl, ...options });
    const stream = await stt.openStream({ accessToken, settings, label: 'mic' });
    const events: SttEvent[] = [];
    stream.on((event) => events.push(event));
    return { stream, events };
  }

  it('authenticates with the token, streams audio, keeps one formatted final per turn, and terminates', async () => {
    script.onAudio = (socket, frame) => {
      if (frame !== 1) return;
      socket.send(turn(0, 'my name', { words: words(['my', 'name']) }));
      socket.send(turn(0, 'my name is sonny', { endOfTurn: true }));
      socket.send(turn(0, 'My name is Sonny.', { endOfTurn: true, formatted: true }));
    };
    const { stream, events } = await open();

    expect(log.headers.authorization).toBeUndefined();
    const query = new URL(log.url, 'ws://x').searchParams;
    expect(query.get('token')).toBe('temp-token');
    expect(query.get('encoding')).toBe('pcm_s16le');

    stream.send(new Uint8Array(CHUNK_100_MS));
    await waitFor(() => events.some((e) => e.type === 'final'));
    await stream.close();

    expect(log.binaryFrames).toEqual([CHUNK_100_MS]);
    expect(log.text.filter((t) => t.includes('"Terminate"'))).toHaveLength(1);
    expect(events.map((e) => e.type)).toEqual(['interim', 'final', 'closed']);
    expect(events[0]).toEqual({ type: 'interim', text: 'my name', startMs: 100, endMs: 1100 });
    expect(events[1]).toMatchObject({
      type: 'final',
      text: 'My name is Sonny.',
      startMs: 100,
      endMs: 2100,
      confidence: 0.5,
    });
  });

  it('saves the unformatted text when the formatted copy does not arrive in time, and only once', async () => {
    script.onAudio = (socket, frame) => {
      if (frame === 1) socket.send(turn(0, 'hello there', { endOfTurn: true }));
      // Late: after the adapter stopped waiting for it.
      if (frame === 2) socket.send(turn(0, 'Hello there.', { endOfTurn: true, formatted: true }));
    };
    const { stream, events } = await open({ formattedTurnWaitMs: 30 });

    stream.send(new Uint8Array(CHUNK_100_MS));
    await waitFor(() => events.some((e) => e.type === 'final'));
    expect(events).toEqual([expect.objectContaining({ type: 'final', text: 'hello there' })]);

    stream.send(new Uint8Array(CHUNK_100_MS));
    await waitFor(() => log.binaryFrames.length === 2);
    await stream.close();
    expect(events.filter((e) => e.type === 'final')).toHaveLength(1);
  });

  it('saves a held turn as soon as the next turn starts', async () => {
    script.onAudio = (socket, frame) => {
      if (frame !== 1) return;
      socket.send(turn(0, 'first turn', { endOfTurn: true }));
      socket.send(turn(1, 'second', { words: words(['second'], 2000) }));
    };
    const { stream, events } = await open({ formattedTurnWaitMs: 10_000 });

    stream.send(new Uint8Array(CHUNK_100_MS));
    await waitFor(() => events.length === 2);
    expect(events.map((e) => e.type)).toEqual(['final', 'interim']);
    expect(events[0]).toMatchObject({ text: 'first turn' });
    await stream.close();
  });

  it('saves a held turn on stop, before reporting the stream closed', async () => {
    script.onAudio = (socket) => {
      socket.send(turn(0, 'last words', { endOfTurn: true }));
    };
    const { stream, events } = await open({ formattedTurnWaitMs: 10_000 });

    stream.send(new Uint8Array(CHUNK_100_MS));
    await waitFor(() => log.binaryFrames.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const started = Date.now();
    await stream.close();

    expect(Date.now() - started).toBeLessThan(2000);
    expect(events.map((e) => e.type)).toEqual(['final', 'closed']);
    expect(events[0]).toMatchObject({ text: 'last words' });
  });

  it('saves a held turn when the connection ends without Termination', async () => {
    script.onAudio = (socket) => {
      socket.send(turn(0, 'cut off', { endOfTurn: true }));
    };
    script.onTerminate = () => undefined;
    const { stream, events } = await open({ formattedTurnWaitMs: 10_000, closeTimeoutMs: 50 });

    stream.send(new Uint8Array(CHUNK_100_MS));
    await waitFor(() => log.binaryFrames.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await stream.close();

    expect(events.map((e) => e.type)).toEqual(['final', 'closed']);
    expect(events[0]).toMatchObject({ text: 'cut off' });
  });

  it('saves a formatted-only end of turn at once', async () => {
    script.onAudio = (socket) => {
      socket.send(turn(3, 'Formatted only.', { endOfTurn: true, formatted: true }));
    };
    const { stream, events } = await open({ formattedTurnWaitMs: 10_000 });

    stream.send(new Uint8Array(CHUNK_100_MS));
    await waitFor(() => events.length === 1);
    expect(events[0]).toMatchObject({ type: 'final', text: 'Formatted only.' });
    await stream.close();
  });

  it('pads a short tail to the minimum and sends it before Terminate', async () => {
    const { stream } = await open();

    stream.send(new Uint8Array(CHUNK_100_MS));
    stream.send(new Uint8Array(640)); // 20 ms: AssemblyAI closes the session on anything under 50 ms
    await stream.close();
    stream.send(new Uint8Array(CHUNK_100_MS)); // after close: dropped

    expect(log.binaryFrames).toEqual([CHUNK_100_MS, 1600]);
    expect(log.text).toEqual([JSON.stringify({ type: 'Terminate' })]);
  });

  it('reports a vendor close mid-call as a fatal error, then closed', async () => {
    script.onAudio = (socket) => {
      socket.send(
        JSON.stringify({
          type: 'Error',
          error_code: 3008,
          error: 'Session Expired: Maximum session duration exceeded',
        }),
      );
      socket.close(3008, 'Session Expired: Maximum session duration exceeded');
    };
    const { stream, events } = await open();

    stream.send(new Uint8Array(CHUNK_100_MS));
    await waitFor(() => events.some((e) => e.type === 'closed'));
    expect(events).toEqual([
      {
        type: 'error',
        message: 'Session Expired: Maximum session duration exceeded (AssemblyAI error 3008)',
        fatal: true,
      },
      {
        type: 'closed',
        code: 3008,
        reason: 'Session Expired: Maximum session duration exceeded',
      },
    ]);
    await stream.close();
  });

  it('turns a message it cannot read into a non-fatal error and keeps the stream open', async () => {
    script.onAudio = (socket) => {
      socket.send(JSON.stringify({ type: 'Turn', turn_order: 'zero' }));
      socket.send(turn(0, 'Still here.', { endOfTurn: true, formatted: true }));
    };
    const { stream, events } = await open();

    stream.send(new Uint8Array(CHUNK_100_MS));
    await waitFor(() => events.some((e) => e.type === 'final'));
    expect(events[0]).toMatchObject({ type: 'error', fatal: false });
    expect(events[1]).toMatchObject({ type: 'final', text: 'Still here.' });
    await stream.close();
  });

  it('fails to open when the vendor refuses the token after the handshake', async () => {
    script.onConnect = (socket) => {
      socket.send(
        JSON.stringify({
          type: 'Error',
          error_code: 1008,
          error: 'Unauthorized Connection: Invalid token',
        }),
      );
      socket.close(1008, 'Unauthorized Connection: Invalid token');
    };
    const error = await open({}, 'expired').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SttConnectError);
    expect((error as SttConnectError).message).toBe(
      'AssemblyAI ended the connection before the session began: ' +
        'Unauthorized Connection: Invalid token (AssemblyAI error 1008)',
    );
  });

  it('fails to open when the vendor closes before Begin without an Error frame', async () => {
    script.onConnect = (socket) => {
      socket.close(1008, 'Unauthorized Connection: Missing Authorization header');
    };
    const error = await open().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SttConnectError);
    expect((error as SttConnectError).message).toBe(
      'AssemblyAI ended the connection before the session began ' +
        '(code 1008: Unauthorized Connection: Missing Authorization header)',
    );
  });

  it('reports a rejected handshake as a connect error with the status code', async () => {
    rejectWith = 401;
    const error = await open().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SttConnectError);
    expect((error as SttConnectError).statusCode).toBe(401);
    expect((error as SttConnectError).message).toContain('AssemblyAI');
  });

  it('fails to open when Begin never arrives', async () => {
    script.onConnect = () => undefined;
    const error = await open({ connectTimeoutMs: 50 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SttConnectError);
    expect((error as SttConnectError).message).toContain('did not start the session');
  });

  it('closes even when the vendor never answers Terminate', async () => {
    script.onTerminate = () => undefined;
    const { stream, events } = await open({ closeTimeoutMs: 50 });

    const started = Date.now();
    await stream.close();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(events.at(-1)?.type).toBe('closed');
  });
});

function begin(): string {
  return JSON.stringify({ type: 'Begin', id: 'session-1', expires_at: 1772570132 });
}

function termination(): string {
  return JSON.stringify({
    type: 'Termination',
    audio_duration_seconds: 1,
    session_duration_seconds: 1,
  });
}

/** Words 500 ms apart from `startMs`, each 500 ms long, confidence 0.5. */
function words(texts: string[], startMs = 100) {
  return texts.map((text, index) => ({
    text,
    start: startMs + index * 500,
    end: startMs + (index + 1) * 500,
    confidence: 0.5,
    word_is_final: false,
  }));
}

function turn(
  turnOrder: number,
  transcript: string,
  options: { endOfTurn?: boolean; formatted?: boolean; words?: ReturnType<typeof words> } = {},
): string {
  return JSON.stringify({
    type: 'Turn',
    turn_order: turnOrder,
    turn_is_formatted: options.formatted ?? false,
    end_of_turn: options.endOfTurn ?? false,
    transcript,
    end_of_turn_confidence: 0.9,
    words: options.words ?? words(transcript.split(' ')),
    utterance: options.endOfTurn ? transcript : '',
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
