import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../../logger';
import { SttConnectError, type SttEvent, type SttStreamSettings } from '../SpeechToText';
import { type FakeVendorConnection, FakeVendorServer, waitFor } from '../testing/fakeVendorServer';
import { buildStartRequest, sonioxProtocol, SonioxSpeechToText } from './SonioxSpeechToText';

const settings: SttStreamSettings = {
  model: 'stt-rt-v5',
  language: 'en',
  sampleRate: 16000,
  encoding: 'linear16',
  pricePerHourUsd: 0.12,
};
/** A temporary key as the API hands it out (M3-T14). */
const TEMPORARY_KEY = 'temp:soniox-temporary-key';
const CHUNK_100_MS = 3200;
const FINALIZE = JSON.stringify({ type: 'finalize' });
const END_OF_AUDIO = '';

function tokens(
  list: { text: string; final: boolean; startMs: number; endMs: number }[],
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    tokens: list.map((token) => ({
      text: token.text,
      start_ms: token.startMs,
      end_ms: token.endMs,
      confidence: 0.9,
      is_final: token.final,
    })),
    final_audio_proc_ms: 0,
    total_audio_proc_ms: 0,
    ...extra,
  });
}

const FINISHED = JSON.stringify({
  tokens: [],
  final_audio_proc_ms: 1560,
  total_audio_proc_ms: 1680,
  finished: true,
});

/** As Soniox ends a stream: the finished response after the empty text frame, then the close. */
function answerEndOfAudio(connection: FakeVendorConnection, text: string): void {
  if (text !== END_OF_AUDIO) return;
  connection.socket.send(FINISHED);
  connection.socket.close(1000);
}

describe('buildStartRequest', () => {
  it('asks for the model on raw 16 kHz mono PCM, with endpoint detection to end each line', () => {
    expect(JSON.parse(buildStartRequest(settings))).toEqual({
      model: 'stt-rt-v5',
      // Our `linear16` under Soniox's name.
      audio_format: 'pcm_s16le',
      sample_rate: 16000,
      num_channels: 1,
      enable_endpoint_detection: true,
    });
  });

  it('carries the jargon list as context terms, and no context without one', () => {
    const withList = JSON.parse(
      buildStartRequest({ ...settings, keyterms: ['Linkt', 'order number'] }),
    ) as Record<string, unknown>;
    expect(withList.context).toEqual({ terms: ['Linkt', 'order number'] });

    for (const each of [settings, { ...settings, keyterms: [] }]) {
      expect(JSON.parse(buildStartRequest(each))).not.toHaveProperty('context');
    }
  });

  it('refuses audio Roger does not send', () => {
    expect(() => buildStartRequest({ ...settings, encoding: 'opus' })).toThrow(SttConnectError);
    expect(() => buildStartRequest({ ...settings, encoding: 'opus' })).toThrow(
      'Soniox cannot be sent opus audio; Roger sends linear16',
    );
  });
});

describe('sonioxProtocol', () => {
  it('keeps a stalled session alive well inside the 20 s Soniox allows without audio', () => {
    const { keepAlive } = sonioxProtocol();
    expect(keepAlive?.message).toBe('{"type":"keepalive"}');
    expect(keepAlive?.intervalMs).toBeLessThanOrEqual(10_000);
  });

  it('sends audio as it comes and blames no refusal on the jargon list', () => {
    const protocol = sonioxProtocol();
    expect(protocol.audioPacing).toBe('none');
    expect('keytermsRejected' in protocol).toBe(false);
  });

  it('says what an idle close means', () => {
    expect(sonioxProtocol().describeClose(1001, null)).toBe(
      'code 1001: closed as idle: no audio or keepalive in time',
    );
    expect(sonioxProtocol().describeClose(1001, 'Idle')).toBe('code 1001: Idle');
  });
});

describe('SonioxSpeechToText', () => {
  let server: FakeVendorServer;
  let logLines: string[];

  beforeEach(async () => {
    logLines = [];
    server = await FakeVendorServer.start();
    server.script = { onText: answerEndOfAudio };
  });

  afterEach(async () => {
    try {
      await server.expectNoOpenSockets();
    } finally {
      await server.stop();
    }
  });

  function adapter(): SonioxSpeechToText {
    return new SonioxSpeechToText({
      logger: createLogger({ level: 'debug', format: 'json', sink: (line) => logLines.push(line) }),
      baseUrl: server.baseUrl,
      closeTimeoutMs: 1_000,
    });
  }

  async function open(stream: Partial<SttStreamSettings> = {}) {
    const opened = await adapter().openStream({
      accessToken: TEMPORARY_KEY,
      settings: { ...settings, ...stream },
      label: 'mic',
    });
    const events: SttEvent[] = [];
    opened.on((event) => events.push(event));
    return { stream: opened, events };
  }

  it('authenticates with the temporary key as a bearer header, and says its start request first', async () => {
    const { stream } = await open({ keyterms: ['Linkt'] });
    stream.send(new Uint8Array(CHUNK_100_MS));
    await waitFor(() => server.last().binaryFrames.length === 1);
    await stream.close();

    const connection = server.last();
    expect(connection.headers.authorization).toBe(`Bearer ${TEMPORARY_KEY}`);
    // The key travels in the header only: the URL and every message are free of it (the wire tap
    // records both, and `api_key` in the start request is deprecated).
    expect(connection.url).toBe('/transcribe-websocket');
    expect(connection.texts.join('\n')).not.toContain(TEMPORARY_KEY);
    expect(connection.texts[0]).toBe(buildStartRequest({ ...settings, keyterms: ['Linkt'] }));
    expect(connection.texts.slice(1)).toEqual([FINALIZE, END_OF_AUDIO]);
    expect(logLines.join('\n')).not.toContain(TEMPORARY_KEY);
  });

  it('streams tokens as interims, saves one line per utterance, and stops on finished', async () => {
    server.script.onBinary = (connection, frame) => {
      if (frame === 1) {
        connection.socket.send(
          tokens([
            { text: 'Hello', final: true, startMs: 100, endMs: 400 },
            { text: ' wor', final: false, startMs: 450, endMs: 600 },
          ]),
        );
      }
      if (frame === 2) {
        connection.socket.send(
          tokens([
            { text: ' world', final: true, startMs: 450, endMs: 800 },
            { text: '<end>', final: true, startMs: 800, endMs: 800 },
            { text: 'Last', final: true, startMs: 1_500, endMs: 1_800 },
          ]),
        );
      }
    };
    const { stream, events } = await open();

    stream.send(new Uint8Array(CHUNK_100_MS));
    stream.send(new Uint8Array(CHUNK_100_MS));
    await waitFor(() => events.some((event) => event.type === 'final'));
    await stream.close();

    expect(events.map((event) => event.type)).toEqual([
      'interim',
      'final',
      'interim',
      'final',
      'closed',
    ]);
    expect(events[0]).toEqual({ type: 'interim', text: 'Hello wor', startMs: 100, endMs: 600 });
    expect(events[1]).toMatchObject({
      type: 'final',
      text: 'Hello world',
      startMs: 100,
      endMs: 800,
    });
    // The line still held at Stop comes with the finished response, before "closed".
    expect(events[3]).toMatchObject({ type: 'final', text: 'Last', startMs: 1_500, endMs: 1_800 });
    expect(events[4]).toEqual({ type: 'closed', code: 1000, reason: null });
  });

  it('frames a merged read within 1 s and pads a short tail at Stop, ahead of the finalize', async () => {
    let framesAtFinalize: number[] = [];
    server.script.onText = (connection, text) => {
      if (text === FINALIZE) framesAtFinalize = [...connection.binaryFrames];
      answerEndOfAudio(connection, text);
    };
    const { stream } = await open();

    stream.send(new Uint8Array(CHUNK_100_MS * 15)); // a pipe read that merged 1.5 s
    stream.send(new Uint8Array(800)); // 25 ms: waits for more
    await waitFor(() => server.last().binaryFrames.length === 2);
    await stream.close();

    // 1000 ms, 500 ms, then at Stop the held 25 ms padded with silence to 50 ms.
    expect(framesAtFinalize).toEqual([32_000, 16_000, 1_600]);
    expect(server.last().binaryFrames).toEqual([32_000, 16_000, 1_600]);
  });

  it('ends the stream on the 5-hour cap with one fatal error naming it, the held line kept', async () => {
    server.script.onBinary = (connection) => {
      connection.socket.send(tokens([{ text: 'Almost', final: true, startMs: 0, endMs: 300 }]));
      connection.socket.send(
        JSON.stringify({
          tokens: [],
          error_code: 403,
          error_type: 'temp_api_key_session_expired',
          error_message:
            'Temporary API key session duration limit exceeded. Create a new temporary API key ' +
            'to start a new session.',
        }),
      );
      connection.socket.close(1000);
    };
    const { stream, events } = await open();

    stream.send(new Uint8Array(CHUNK_100_MS));
    await waitFor(() => events.some((event) => event.type === 'closed'));

    // A fatal error is what makes CaptureSession reopen a fresh session (with a fresh key), as on
    // AssemblyAI's 3008: the cap is a reopen, never the end of the meeting.
    expect(events.map((event) => event.type)).toEqual(['interim', 'error', 'final', 'closed']);
    expect(events[1]).toMatchObject({ type: 'error', fatal: true });
    expect(events[1]?.type === 'error' && events[1].message).toContain(
      '(Soniox error 403 temp_api_key_session_expired)',
    );
    expect(events[2]).toMatchObject({ type: 'final', text: 'Almost' });
    expect(server.last().texts).not.toContain(FINALIZE);
  });

  it('reports a key Soniox refuses after the handshake as a fatal error on the open stream', async () => {
    // Soniox checks the key at the start request and answers with an error response, never a
    // failed handshake: the stream is already open, so this is a stream failure, not a connect one.
    server.script.onText = (connection) => {
      if (connection.texts.length !== 1) return;
      connection.socket.send(
        JSON.stringify({
          tokens: [],
          error_code: 401,
          error_type: 'unauthenticated',
          error_message: 'Invalid or expired temporary API key.',
        }),
      );
      connection.socket.close(1000);
    };
    const { stream, events } = await open();

    await waitFor(() => events.some((event) => event.type === 'closed'));

    expect(events.map((event) => event.type)).toEqual(['error', 'closed']);
    expect(events[0]).toMatchObject({ type: 'error', fatal: true });
    expect(events[0]?.type === 'error' && events[0].message).toContain(
      'Invalid or expired temporary API key. (Soniox error 401 unauthenticated)',
    );
    await stream.close(); // a no-op now
  });

  it('releases the held line when the socket closes before Soniox finished', async () => {
    server.script.onBinary = (connection) => {
      connection.socket.send(tokens([{ text: 'Cut', final: true, startMs: 0, endMs: 200 }]));
    };
    const { stream, events } = await open();
    stream.send(new Uint8Array(CHUNK_100_MS));
    await waitFor(() => events.length === 1);

    await stream.terminate?.();

    expect(events.map((event) => event.type)).toEqual(['interim', 'final', 'closed']);
    expect(events[1]).toMatchObject({ type: 'final', text: 'Cut', startMs: 0, endMs: 200 });
  });

  it('refuses audio Roger does not send before opening any socket', async () => {
    const error = await open({ encoding: 'opus' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SttConnectError);
    expect(server.handshakes).toBe(0);
  });
});
