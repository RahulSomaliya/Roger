import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../../logger';
import { createSpeechToText } from '../createSpeechToText';
import { SttConnectError, type SttEvent, type SttStreamSettings } from '../SpeechToText';
import { type FakeVendorConnection, FakeVendorServer, waitFor } from '../testing/fakeVendorServer';
import { buildStreamUrl, xaiProtocol, XaiSpeechToText } from './XaiSpeechToText';

const settings: SttStreamSettings = {
  model: 'grok-voice-transcribe-2.0',
  language: 'en',
  sampleRate: 16000,
  encoding: 'linear16',
  pricePerHourUsd: 0.2,
};
/** A client secret as the API hands it out. */
const CLIENT_SECRET = 'xai-client-secret.test-secret';
const CHUNK_100_MS = 3200;
const CREATED = JSON.stringify({ type: 'transcript.created' });
const FINALIZE = JSON.stringify({ type: 'Finalize' });
const AUDIO_DONE = JSON.stringify({ type: 'audio.done' });

function partial(
  text: string,
  flags: { final?: boolean; speechFinal?: boolean },
  start: number,
  duration: number,
): string {
  return JSON.stringify({
    type: 'transcript.partial',
    text,
    words: [{ text, start, end: start + duration }],
    is_final: flags.final ?? false,
    speech_final: flags.speechFinal ?? false,
    start,
    duration,
  });
}

const DONE = JSON.stringify({ type: 'transcript.done', text: 'the call', duration: 2 });

/** As xAI ends a stream: transcript.done after audio.done, then the close. */
function answerAudioDone(connection: FakeVendorConnection, text: string): void {
  if (text !== AUDIO_DONE) return;
  connection.socket.send(DONE);
  connection.socket.close(1000);
}

describe('buildStreamUrl', () => {
  it('asks for the model on raw 16 kHz PCM, interims and formatted text in the call language', () => {
    const url = new URL(buildStreamUrl('wss://api.x.ai', settings));

    expect(url.pathname).toBe('/v1/stt');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      model: 'grok-voice-transcribe-2.0',
      // Our `linear16` (16-bit signed little-endian mono PCM) under xAI's name.
      encoding: 'pcm',
      sample_rate: '16000',
      interim_results: 'true',
      language: 'en',
      // `format` needs `language`, and Roger's notes want punctuation and numerals.
      format: 'true',
    });
  });

  it('never asks for diarization: the mic and the call are already separate streams', () => {
    expect(buildStreamUrl('wss://api.x.ai', settings)).not.toContain('diarize');
  });

  it('sends one keyterm per term, spaces encoded as %20', () => {
    const raw = buildStreamUrl('wss://api.x.ai', {
      ...settings,
      keyterms: ['Linkt', 'order number', 'R&D'],
    });

    expect(new URL(raw).searchParams.getAll('keyterm')).toEqual(['Linkt', 'order number', 'R&D']);
    // %20, never '+': only a form decoder reads '+' as a space.
    expect(raw).toContain('keyterm=Linkt&keyterm=order%20number&keyterm=R%26D');
  });

  it('sends no keyterm without a list', () => {
    for (const each of [settings, { ...settings, keyterms: [] }]) {
      expect(buildStreamUrl('wss://api.x.ai', each)).not.toContain('keyterm');
    }
  });

  it('refuses audio Roger does not send, naming both sides', () => {
    expect(() => buildStreamUrl('wss://api.x.ai', { ...settings, encoding: 'opus' })).toThrow(
      SttConnectError,
    );
    expect(() => buildStreamUrl('wss://api.x.ai', { ...settings, encoding: 'opus' })).toThrow(
      'xAI cannot be sent opus audio; Roger sends linear16',
    );
  });
});

describe('the registry', () => {
  it('builds the xAI adapter for the provider id the API names (stt_vendors.py)', () => {
    const stt = createSpeechToText('xai', {
      logger: createLogger({ level: 'error', format: 'json', sink: () => undefined }),
    });

    expect(stt).toBeInstanceOf(XaiSpeechToText);
    expect(stt.provider).toBe('xai');
    expect(stt.vendorName).toBe('xAI');
  });
});

describe('xaiProtocol', () => {
  it('waits for transcript.created, and ends on transcript.done', () => {
    const protocol = xaiProtocol();
    expect(protocol.readyOn).toBe('ready-message');
    expect(protocol.finishedOn).toBe('finished-message');
  });

  it('sends no keep-alive and no pacing, which xAI documents neither of', () => {
    const protocol = xaiProtocol();
    expect(protocol.keepAlive).toBeNull();
    expect(protocol.audioPacing).toBe('none');
  });

  it('blames no refusal on the jargon list: the shared limits are xAI own', () => {
    expect('keytermsRejected' in xaiProtocol()).toBe(false);
  });

  it('puts the secret in the Authorization header and never in the URL', () => {
    const target = xaiProtocol().target({ accessToken: CLIENT_SECRET, settings, label: 'mic' });

    expect(target.headers).toEqual({ Authorization: `Bearer ${CLIENT_SECRET}` });
    expect(target.url).not.toContain(CLIENT_SECRET);
  });

  it('describes a close with the vendor reason, or the standard meaning', () => {
    const protocol = xaiProtocol();
    expect(protocol.describeClose(1008, 'invalid api key')).toBe('code 1008: invalid api key');
    expect(protocol.describeClose(1011, null)).toBe('code 1011: server error');
  });
});

describe('XaiSpeechToText', () => {
  let server: FakeVendorServer;
  let logLines: string[];

  beforeEach(async () => {
    logLines = [];
    server = await FakeVendorServer.start();
    server.script = {
      onConnect: (connection) => {
        connection.socket.send(CREATED);
      },
      onText: answerAudioDone,
    };
  });

  afterEach(async () => {
    try {
      await server.expectNoOpenSockets();
    } finally {
      await server.stop();
    }
  });

  function adapter(): XaiSpeechToText {
    return new XaiSpeechToText({
      logger: createLogger({ level: 'debug', format: 'json', sink: (line) => logLines.push(line) }),
      baseUrl: server.baseUrl,
      closeTimeoutMs: 1_000,
    });
  }

  async function open(stream: Partial<SttStreamSettings> = {}) {
    const opened = await adapter().openStream({
      accessToken: CLIENT_SECRET,
      settings: { ...settings, ...stream },
      label: 'mic',
    });
    const events: SttEvent[] = [];
    opened.on((event) => events.push(event));
    return { stream: opened, events };
  }

  it('authenticates with the client secret as a bearer header, and sends it nowhere else', async () => {
    const { stream } = await open({ keyterms: ['Linkt'] });
    stream.send(new Uint8Array(CHUNK_100_MS));
    await waitFor(() => server.last().binaryFrames.length === 1);
    await stream.close();

    const connection = server.last();
    expect(connection.headers.authorization).toBe(`Bearer ${CLIENT_SECRET}`);
    expect(connection.url).not.toContain(CLIENT_SECRET);
    expect(connection.texts.join('\n')).not.toContain(CLIENT_SECRET);
    expect(logLines.join('\n')).not.toContain(CLIENT_SECRET);
    expect(new URL(connection.url, 'ws://vendor').searchParams.getAll('keyterm')).toEqual([
      'Linkt',
    ]);
  });

  it('holds audio until transcript.created, then sends it as it comes', async () => {
    const { stream } = await open();

    stream.send(new Uint8Array(CHUNK_100_MS));
    await waitFor(() => server.last().binaryFrames.length === 1);
    await stream.close();

    expect(server.last().binaryFrames).toEqual([CHUNK_100_MS]);
  });

  it('on Stop sends the held audio, then Finalize, then audio.done, and waits for transcript.done', async () => {
    const { stream, events } = await open();

    stream.send(new Uint8Array(800)); // 25 ms: below the frame floor, held until Stop
    await stream.close();

    expect(server.last().texts).toEqual([FINALIZE, AUDIO_DONE]);
    // The held 25 ms went out padded with silence to the 50 ms floor, ahead of the control messages.
    expect(server.last().binaryFrames).toEqual([1_600]);
    expect(events.map((event) => event.type)).toEqual(['closed']);
  });

  it('shows interims, saves one line per utterance, and keeps the line held at Stop', async () => {
    server.script.onBinary = (connection, frame) => {
      if (frame === 1) connection.socket.send(partial('Hello', {}, 0.1, 0.3));
      if (frame === 2) {
        connection.socket.send(
          partial('Hello world.', { final: true, speechFinal: true }, 0.1, 0.9),
        );
        connection.socket.send(partial('Last words', {}, 1.5, 0.3));
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
    expect(events[0]).toEqual({ type: 'interim', text: 'Hello', startMs: 100, endMs: 400 });
    expect(events[1]).toMatchObject({
      type: 'final',
      text: 'Hello world.',
      startMs: 100,
      endMs: 1000,
    });
    // The interim that never finalized is released as a line when xAI finishes: Stop loses nothing.
    expect(events[3]).toMatchObject({
      type: 'final',
      text: 'Last words',
      startMs: 1500,
      endMs: 1800,
    });
    expect(events[4]).toEqual({ type: 'closed', code: 1000, reason: null });
  });

  it('does not save the text transcript.done repeats', async () => {
    server.script.onBinary = (connection) => {
      connection.socket.send(partial('Only line.', { final: true, speechFinal: true }, 0, 0.5));
    };
    const { stream, events } = await open();
    stream.send(new Uint8Array(CHUNK_100_MS));
    await waitFor(() => events.some((event) => event.type === 'final'));

    await stream.close();

    expect(events.filter((event) => event.type === 'final')).toHaveLength(1);
  });

  it('turns an error message into one fatal error, the held line kept', async () => {
    server.script.onBinary = (connection) => {
      connection.socket.send(partial('Almost', {}, 0, 0.3));
      connection.socket.send(JSON.stringify({ type: 'error', message: 'rate limit exceeded' }));
      connection.socket.close(1008, 'rate limit exceeded');
    };
    const { stream, events } = await open();

    stream.send(new Uint8Array(CHUNK_100_MS));
    await waitFor(() => events.some((event) => event.type === 'closed'));

    // A fatal error is what makes CaptureSession reopen through its open budget.
    expect(events.map((event) => event.type)).toEqual(['interim', 'error', 'final', 'closed']);
    expect(events[1]).toMatchObject({ type: 'error', fatal: true });
    expect(events[1]?.type === 'error' && events[1].message).toContain('rate limit exceeded');
    expect(events[2]).toMatchObject({ type: 'final', text: 'Almost' });
    expect(server.last().texts).not.toContain(AUDIO_DONE);
    await stream.close();
  });

  it('fails the connect, no audio sent, when xAI refuses the secret at the handshake', async () => {
    server.rejectWith = 401;

    const error = await open().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SttConnectError);
    expect(error instanceof Error && error.message).toBe('xAI: rejected with HTTP 401');
    expect(server.handshakes).toBe(1);
  });

  it('releases the held line when the socket closes before transcript.done', async () => {
    server.script.onBinary = (connection) => {
      connection.socket.send(partial('Cut', {}, 0, 0.2));
    };
    const { stream, events } = await open();
    stream.send(new Uint8Array(CHUNK_100_MS));
    await waitFor(() => events.length === 1);

    await stream.terminate?.();

    expect(events.map((event) => event.type)).toEqual(['interim', 'final', 'closed']);
    expect(events[1]).toMatchObject({ type: 'final', text: 'Cut', startMs: 0, endMs: 200 });
  });

  it('reports an unreadable message as a non-fatal error and goes on', async () => {
    server.script.onBinary = (connection) => {
      connection.socket.send('{"type":"transcript.partial","text":"x"}');
      connection.socket.send(partial('Fine.', { final: true, speechFinal: true }, 0, 0.5));
    };
    const { stream, events } = await open();

    stream.send(new Uint8Array(CHUNK_100_MS));
    await waitFor(() => events.some((event) => event.type === 'final'));
    await stream.close();

    expect(events[0]).toMatchObject({ type: 'error', fatal: false });
    expect(events[1]).toMatchObject({ type: 'final', text: 'Fine.' });
  });

  it('refuses audio Roger does not send before opening any socket', async () => {
    const error = await open({ encoding: 'opus' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SttConnectError);
    expect(server.handshakes).toBe(0);
  });
});
