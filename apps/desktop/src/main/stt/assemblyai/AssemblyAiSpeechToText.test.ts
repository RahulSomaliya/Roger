import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { isRecord } from '../json';
import { createLogger } from '../../logger';
import type { TranscriptEvent } from '../core/SttProtocol';
import { SttConnectError, type SttEvent, type SttStreamSettings } from '../SpeechToText';
import { rawDataToString } from '../websocket';
import {
  AssemblyAiSpeechToText,
  type AssemblyAiOptions,
  assemblyAiProtocol,
  buildStreamingUrl,
} from './AssemblyAiSpeechToText';
import { readWireFixture, WIRE_FIXTURE_MODELS } from './fixtures/wireFixtures';

const logger = createLogger({ level: 'error', format: 'json', sink: () => undefined });
const settings: SttStreamSettings = {
  model: 'universal-streaming-english',
  language: 'en',
  sampleRate: 16000,
  encoding: 'linear16',
  pricePerHourUsd: 0.15,
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
    const url = new URL(
      buildStreamingUrl('wss://streaming.assemblyai.com', settings, 'tok/en+1', 120_000),
    );
    expect(url.pathname).toBe('/v3/ws');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      speech_model: 'universal-streaming-english',
      sample_rate: '16000',
      encoding: 'pcm_s16le',
      format_turns: 'true',
      inactivity_timeout: '120',
      token: 'tok/en+1',
    });
  });

  it('keeps the inactivity timeout inside the 5 to 3600 s AssemblyAI takes', () => {
    const timeout = (ms: number) =>
      new URL(buildStreamingUrl('wss://x', settings, 't', ms)).searchParams.get(
        'inactivity_timeout',
      );
    expect(timeout(45_400)).toBe('45');
    expect(timeout(1_000)).toBe('5');
    expect(timeout(7_200_000)).toBe('3600');
  });

  it('asks the Universal-3 Pro models for the stream language, and no other model', () => {
    const query = (model: string, language = 'en') =>
      Object.fromEntries(
        new URL(
          buildStreamingUrl(
            'wss://streaming.assemblyai.com',
            { ...settings, model, language },
            't',
            120_000,
          ),
        ).searchParams,
      );

    for (const model of ['universal-3-6-pro', 'universal-3-5-pro']) {
      expect(query(model), model).toEqual({
        speech_model: model,
        sample_rate: '16000',
        encoding: 'pcm_s16le',
        language_codes: '["en"]',
        inactivity_timeout: '120',
        token: 't',
      });
    }
    expect(query('universal-3-6-pro', 'de').language_codes).toBe('["de"]');
    expect(query('universal-streaming-english')).not.toHaveProperty('language_codes');
    expect(query('universal-streaming-multilingual')).not.toHaveProperty('language_codes');
  });

  it('leaves format_turns off for models that always format (Universal-3 Pro)', () => {
    const url = new URL(
      buildStreamingUrl(
        'wss://streaming.assemblyai.com',
        { ...settings, model: 'universal-3-6-pro' },
        't',
        120_000,
      ),
    );
    expect(url.searchParams.get('speech_model')).toBe('universal-3-6-pro');
    expect(url.searchParams.has('format_turns')).toBe(false);
  });

  it('sends the jargon list as one keyterms_prompt JSON array, and none without a list', () => {
    const query = (keyterms?: readonly string[]) =>
      new URL(
        buildStreamingUrl(
          'wss://streaming.assemblyai.com',
          keyterms === undefined ? settings : { ...settings, keyterms },
          't',
          120_000,
        ),
      ).searchParams;

    const withList = query(['Linkt', 'order number', 'Roger & Co']);
    expect(withList.getAll('keyterms_prompt')).toHaveLength(1);
    expect(JSON.parse(withList.get('keyterms_prompt') ?? '')).toEqual([
      'Linkt',
      'order number',
      'Roger & Co',
    ]);
    expect(query([]).has('keyterms_prompt')).toBe(false);
    expect(query().has('keyterms_prompt')).toBe(false);
  });

  it('refuses an encoding it has no AssemblyAI name for', () => {
    expect(() => buildStreamingUrl('wss://x', { ...settings, encoding: 'opus' }, 't', 1)).toThrow(
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

  async function open(
    options: Partial<AssemblyAiOptions> = {},
    accessToken = 'temp-token',
    streamSettings: SttStreamSettings = settings,
  ) {
    const stt = new AssemblyAiSpeechToText({ logger, baseUrl, ...options });
    const stream = await stt.openStream({ accessToken, settings: streamSettings, label: 'mic' });
    const events: SttEvent[] = [];
    stream.on((event) => events.push(event));
    return { stream, events };
  }

  it('asks the vendor for the configured inactivity timeout', async () => {
    const { stream } = await open({ vendorIdleTimeoutMs: 300_000 });
    expect(new URL(log.url, 'ws://x').searchParams.get('inactivity_timeout')).toBe('300');
    await stream.close();
  });

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
    // Explicit, never left unset: the default cost guard (costGuards.sttVendorIdleTimeoutMs).
    expect(query.get('inactivity_timeout')).toBe('120');

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

  it('saves a Pro end of turn at once, formatted or not, and only once', async () => {
    script.onAudio = (socket, frame) => {
      // The Pro models format every turn and send its end once. This one says it is unformatted:
      // a rule read from turn_is_formatted alone would hold it for a copy that never comes.
      if (frame === 1) socket.send(turn(0, 'My name is Sonny.', { endOfTurn: true }));
      // A copy of a turn already saved is dropped, as on Universal-Streaming.
      if (frame === 2)
        socket.send(turn(0, 'My name is Sonny!', { endOfTurn: true, formatted: true }));
    };
    const { stream, events } = await open({ formattedTurnWaitMs: 10_000 }, 'temp-token', {
      ...settings,
      model: 'universal-3-6-pro',
    });

    stream.send(new Uint8Array(CHUNK_100_MS));
    await waitFor(() => events.some((e) => e.type === 'final'), 1_000);
    stream.send(new Uint8Array(CHUNK_100_MS));
    await waitFor(() => log.binaryFrames.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await stream.close();

    expect(events.map((e) => e.type)).toEqual(['final', 'closed']);
    expect(events[0]).toMatchObject({ type: 'final', text: 'My name is Sonny.', startMs: 100 });
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

  it('says what a close code means when the vendor gives no reason', async () => {
    script.onAudio = (socket) => {
      socket.close(3008);
    };
    const { stream, events } = await open();

    stream.send(new Uint8Array(CHUNK_100_MS));
    await waitFor(() => events.some((e) => e.type === 'closed'));
    expect(events).toEqual([
      {
        type: 'error',
        message:
          'AssemblyAI closed the stream (code 3008: the session reached its maximum duration)',
        fatal: true,
      },
      { type: 'closed', code: 3008, reason: null },
    ]);
  });

  it('says to wait a minute on a session-limit close that carries no reason', async () => {
    script.onConnect = (socket) => {
      socket.close(3009);
    };
    const error = await open().catch((e: unknown) => e);

    expect((error as SttConnectError).message).toBe(
      'AssemblyAI ended the connection before the session began ' +
        '(code 3009: too many concurrent sessions). ' +
        'AssemblyAI limits how many sessions start per minute (5 on a free account) and each ' +
        'Start opens two, one per audio source: wait a minute, then press Start again.',
    );
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

  it('says to wait a minute when the per-minute session limit refuses the stream', async () => {
    script.onConnect = (socket) => {
      socket.close(1008, 'Unauthorized connection: Too many concurrent sessions');
    };
    const error = await open().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SttConnectError);
    expect((error as SttConnectError).message).toBe(
      'AssemblyAI ended the connection before the session began ' +
        '(code 1008: Unauthorized connection: Too many concurrent sessions). ' +
        'AssemblyAI limits how many sessions start per minute (5 on a free account) and each ' +
        'Start opens two, one per audio source: wait a minute, then press Start again.',
    );
  });

  it('says to wait a minute when an Error frame names the session limit', async () => {
    script.onConnect = (socket) => {
      socket.send(
        JSON.stringify({
          type: 'Error',
          error_code: 3009,
          error: 'Unauthorized Connection: Too many concurrent sessions',
        }),
      );
      socket.close(3009, 'Unauthorized Connection: Too many concurrent sessions');
    };
    const error = await open().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SttConnectError);
    expect((error as SttConnectError).message).toBe(
      'AssemblyAI ended the connection before the session began: ' +
        'Unauthorized Connection: Too many concurrent sessions (AssemblyAI error 3009). ' +
        'AssemblyAI limits how many sessions start per minute (5 on a free account) and each ' +
        'Start opens two, one per audio source: wait a minute, then press Start again.',
    );
  });

  describe('with a jargon list', () => {
    const withList: SttStreamSettings = { ...settings, keyterms: ['Linkt', 'Roger'] };

    async function refusal(
      onConnect: (socket: WebSocket) => void,
      streamSettings = withList,
    ): Promise<SttConnectError> {
      script.onConnect = onConnect;
      const error = await open({}, 'temp-token', streamSettings).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SttConnectError);
      return error as SttConnectError;
    }

    it('blames a close before Begin on the list, except for the token and session-limit codes', async () => {
      const rejected = await refusal((socket) => {
        socket.close(3005, 'Session Cancelled: An error occurred');
      });
      expect(rejected.keytermsRejected).toBe(true);
      expect(rejected.message).toBe(
        'AssemblyAI ended the connection before the session began ' +
          '(code 3005: Session Cancelled: An error occurred); the jargon list (2 terms) was rejected',
      );

      // A bad token or a busy account: a reopen without the list would fail the same way.
      for (const [code, reason] of [
        [1008, 'Unauthorized Connection: Missing Authorization header'],
        [3009, 'Unauthorized Connection: Too many concurrent sessions'],
        [1008, 'Unauthorized connection: Too many concurrent sessions'],
      ] as const) {
        const error = await refusal((socket) => {
          socket.close(code, reason);
        });
        expect(error.keytermsRejected, `${code} ${reason}`).toBe(false);
      }
    });

    it('never blames the list when none was sent', async () => {
      const error = await refusal((socket) => {
        socket.close(3005, 'Session Cancelled: An error occurred');
      }, settings);
      expect(error.keytermsRejected).toBe(false);
    });

    it('never blames the list for a connection that dropped without a close frame (1006)', async () => {
      const error = await refusal((socket) => {
        socket.terminate();
      });
      expect(error.keytermsRejected).toBe(false);
      expect(error.message).toContain('code 1006');
    });

    it('never blames the list for a refused handshake', async () => {
      rejectWith = 400;
      const error = await open({}, 'temp-token', withList).catch((e: unknown) => e);
      expect((error as SttConnectError).keytermsRejected).toBe(false);
    });
  });

  describe('logs', () => {
    let lines: { level: string; message: string; asked?: unknown; running?: unknown }[];
    let raw: string[];
    const recording = () =>
      createLogger({
        level: 'debug',
        format: 'json',
        sink: (line) => {
          raw.push(line);
          lines.push(JSON.parse(line) as (typeof lines)[number]);
        },
      });

    beforeEach(() => {
      lines = [];
      raw = [];
    });

    function beginRunning(model: string | null): (socket: WebSocket) => void {
      return (socket) => {
        socket.send(
          JSON.stringify({
            type: 'Begin',
            id: 'session-1',
            expires_at: 1772570132,
            ...(model === null ? {} : { configuration: { model, mode: 'balanced' } }),
          }),
        );
      };
    }

    const modelWarnings = () =>
      lines.filter((line) => line.message === 'assemblyai runs another model than asked for');

    it('warns when Begin says the session runs another model than the one asked for', async () => {
      // AssemblyAI ignores what it does not know and runs a model of its choosing (M3 plan).
      script.onConnect = beginRunning('universal-streaming-english');
      const { stream } = await open({ logger: recording() }, 'temp-token', {
        ...settings,
        model: 'universal-3-6-pro',
      });
      await stream.close();

      expect(modelWarnings()).toEqual([
        expect.objectContaining({
          level: 'warn',
          asked: 'universal-3-6-pro',
          running: 'universal-streaming-english',
        }),
      ]);
    });

    it('says nothing when Begin names the model asked for, or none', async () => {
      for (const model of ['universal-streaming-english', null]) {
        script.onConnect = beginRunning(model);
        const { stream } = await open({ logger: recording() });
        await stream.close();
      }
      expect(lines.some((line) => line.message === 'stt stream open')).toBe(true);
      expect(modelWarnings()).toEqual([]);
    });

    it('never writes the token, which rides in the URL, into a log line', async () => {
      const token = 'temp-token-c2VjcmV0';
      const withList = { ...settings, keyterms: ['Linkt'], model: 'universal-3-6-pro' };
      script.onConnect = beginRunning('universal-streaming-english');
      const { stream } = await open({ logger: recording() }, token, withList);
      stream.send(new Uint8Array(CHUNK_100_MS));
      await stream.close();
      script.onConnect = (socket) => {
        socket.close(3005, 'Session Cancelled: An error occurred');
      };
      await open({ logger: recording() }, token, withList).catch((e: unknown) => e);

      expect(lines.some((line) => line.message === 'stt connect failed')).toBe(true);
      expect(modelWarnings()).toHaveLength(1);
      expect(raw.join('\n')).not.toContain(token);
    });
  });

  it('reports a rejected handshake as a connect error with the status code', async () => {
    rejectWith = 401;
    const error = await open().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SttConnectError);
    expect((error as SttConnectError).statusCode).toBe(401);
    expect((error as SttConnectError).message).toBe('AssemblyAI: rejected with HTTP 401');
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

/**
 * Each model's wire file (fixtures/wireFixtures.ts) through the protocol's session, as the core
 * hands it the vendor's messages. Properties only, so a recording from close step 0 keeps it green.
 */
describe.each(WIRE_FIXTURE_MODELS)('the %s wire through the protocol', (model) => {
  it('saves one line per finished turn as it ends, the formatted copy when there is one', () => {
    vi.useFakeTimers();
    try {
      const warnings: string[] = [];
      const releasedByTimer: TranscriptEvent[] = [];
      const session = assemblyAiProtocol().session({
        logger: createLogger({
          level: 'warn',
          format: 'json',
          sink: (line) => warnings.push(line),
        }),
        settings: { ...settings, model },
        audioSentMs: () => 0,
        emit: (event) => releasedByTimer.push(event),
      });
      const lines = readWireFixture(model);
      const saved: Extract<SttEvent, { type: 'final' }>[] = [];
      for (const line of lines) {
        const message = session.read(line);
        expect(message.kind, line.slice(0, 40)).not.toBe('invalid');
        if (message.kind === 'transcript' || message.kind === 'finished') {
          for (const event of message.events) if (event.type === 'final') saved.push(event);
        }
      }
      expect(session.release()).toEqual([]);
      vi.advanceTimersByTime(60_000);

      // Nothing waited for a copy that never came: the wait timer released nothing, and said so.
      expect(releasedByTimer).toEqual([]);
      expect(warnings).toEqual([]);
      expect(saved.map((event) => event.text)).toEqual(finishedTurnTexts(lines));
      for (const event of saved) expect(event.words.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Read straight from the wire, apart from the parser: per turn_order, in order, the transcript of
 * its formatted end of turn when the vendor sent one, else of its first end of turn.
 */
function finishedTurnTexts(lines: string[]): string[] {
  const turns = new Map<number, { text: string; formatted: boolean }>();
  for (const line of lines) {
    const message: unknown = JSON.parse(line);
    if (!isRecord(message) || message.type !== 'Turn' || message.end_of_turn !== true) continue;
    const { turn_order: order, transcript, turn_is_formatted: formatted } = message;
    if (typeof order !== 'number' || typeof transcript !== 'string') continue;
    const seen = turns.get(order);
    if (seen === undefined || (!seen.formatted && formatted === true)) {
      turns.set(order, { text: transcript, formatted: formatted === true });
    }
  }
  return [...turns.values()].map((turn) => turn.text);
}

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
