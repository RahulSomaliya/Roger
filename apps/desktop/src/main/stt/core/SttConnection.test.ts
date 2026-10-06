import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger, type LogFields } from '../../logger';
import { SttConnectError, type SttEvent, type SttStreamSettings } from '../SpeechToText';
import {
  FakeVendorServer,
  manualClock,
  SilentTcpServer,
  waitFor,
} from '../testing/fakeVendorServer';
import {
  STT_LIVENESS,
  SttConnection,
  type SttConnectionOptions,
  type SttWireRecord,
} from './SttConnection';
import {
  describeCloseWith,
  type SttConnectRefusal,
  type SttProtocol,
  type SttProtocolMessage,
} from './SttProtocol';

/**
 * The shared lifecycle, driven through a toy vendor protocol. Real vendors run the same checks in
 * conformance.test.ts; this file pins the core's own rules (state machine, timeouts, error text).
 */

const settings: SttStreamSettings = {
  model: 'toy-1',
  language: 'en',
  sampleRate: 16000,
  encoding: 'linear16',
  pricePerHourUsd: 0.15,
};
const CHUNK_100_MS = 3200;
const FINISH = JSON.stringify({ type: 'Finish' });
const KEEP_ALIVE = JSON.stringify({ type: 'Ping' });

interface LogLine {
  level: string;
  message: string;
  fields: LogFields;
}

/** Toy wire format: {type: ready|final|hold|done|error, text?}; anything else is unreadable. */
function toyProtocol(
  baseUrl: string,
  overrides: Partial<
    Pick<SttProtocol, 'readyOn' | 'finishedOn' | 'keepAlive' | 'audioPacing'>
  > = {},
): SttProtocol {
  return {
    provider: 'toy',
    vendorName: 'Toy',
    readyOn: overrides.readyOn ?? 'ready-message',
    finishedOn: overrides.finishedOn ?? 'finished-message',
    keepAlive: overrides.keepAlive ?? null,
    audioPacing: overrides.audioPacing ?? 'none',
    target: (options) => ({
      url: `${baseUrl}/listen?model=${options.settings.model}`,
      headers: { Authorization: `Bearer ${options.accessToken}` },
    }),
    session: () => {
      let held: SttEvent | null = null;
      return {
        encodeAudio: (pcm) => [pcm],
        finishSequence: () => [FINISH],
        read: (raw): SttProtocolMessage => {
          let message: unknown;
          try {
            message = JSON.parse(raw);
          } catch {
            return { kind: 'invalid', reason: 'not JSON' };
          }
          if (typeof message !== 'object' || message === null || !('type' in message)) {
            return { kind: 'invalid', reason: 'missing type' };
          }
          const text = 'text' in message && typeof message.text === 'string' ? message.text : '';
          switch (message.type) {
            case 'ready':
              return { kind: 'ready', sessionId: 's1' };
            case 'final':
              return { kind: 'transcript', events: [final(text)] };
            case 'hold':
              held = final(text);
              return { kind: 'transcript', events: [] };
            case 'done':
              return { kind: 'finished', events: [final('released by done')] };
            case 'error':
              return { kind: 'vendor-error', message: text };
            default:
              return { kind: 'ignored', messageType: String(message.type) };
          }
        },
        release: () => {
          const events = held?.type === 'final' ? [held] : [];
          held = null;
          return events;
        },
      };
    },
    describeClose: (code, reason) => describeCloseWith({ 4000: 'toy limit' }, code, reason),
    connectAdvice: (explanation) => (/slow down/i.test(explanation) ? 'Wait a minute.' : null),
  };
}

function final(text: string): Extract<SttEvent, { type: 'final' }> {
  return { type: 'final', text, startMs: 0, endMs: 100, confidence: 1, words: [] };
}

describe('SttConnection', () => {
  let vendor: FakeVendorServer;
  let lines: LogLine[];

  beforeEach(async () => {
    lines = [];
    vendor = await FakeVendorServer.start();
    vendor.script = {
      onConnect: (connection) => {
        connection.socket.send(JSON.stringify({ type: 'ready' }));
      },
      onText: (connection, text) => {
        if (text === FINISH) connection.socket.send(JSON.stringify({ type: 'done' }));
      },
    };
  });

  afterEach(async () => {
    try {
      await vendor.expectNoOpenSockets();
    } finally {
      await vendor.stop();
    }
  });

  function options(overrides: Partial<SttConnectionOptions> = {}): SttConnectionOptions {
    return {
      protocol: toyProtocol(vendor.baseUrl),
      stream: { accessToken: 'secret-token', settings, label: 'mic' },
      logger: createLogger({
        level: 'debug',
        format: 'json',
        sink: (line) => {
          const { level, message, ...fields } = JSON.parse(line) as LogLine & LogFields;
          lines.push({ level, message, fields });
        },
      }),
      connectTimeoutMs: 1_000,
      closeTimeoutMs: 1_000,
      keepAliveForMs: 30_000,
      clock: () => Date.now(),
      paceClock: () => performance.now(),
      liveness: STT_LIVENESS,
      ...overrides,
    };
  }

  async function open(overrides: Partial<SttConnectionOptions> = {}) {
    const connection = new SttConnection(options(overrides));
    await connection.whenOpen();
    const events: SttEvent[] = [];
    connection.on((event) => events.push(event));
    return { connection, events };
  }

  async function connectError(overrides: Partial<SttConnectionOptions> = {}) {
    const connection = new SttConnection(options(overrides));
    const error = await connection.whenOpen().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SttConnectError);
    return { connection, error: error as SttConnectError };
  }

  it('opens only on the ready message, authenticated as the protocol says', async () => {
    let ready = (): void => undefined;
    vendor.script.onConnect = (connection) => {
      ready = () => {
        connection.socket.send(JSON.stringify({ type: 'ready' }));
      };
    };
    const connection = new SttConnection(options());
    let opened = false;
    void connection.whenOpen().then(() => {
      opened = true;
    });

    await waitFor(() => vendor.connections.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(opened).toBe(false);
    expect(connection.state).toBe('connecting');
    expect(vendor.last().headers.authorization).toBe('Bearer secret-token');

    ready();
    await connection.whenOpen();
    expect(connection.state).toBe('open');
    await connection.close();
  });

  it('opens on the handshake for a vendor whose ready signal is the socket opening', async () => {
    vendor.script.onConnect = () => undefined;
    const { connection } = await open({
      protocol: toyProtocol(vendor.baseUrl, { readyOn: 'socket-open' }),
    });
    expect(connection.state).toBe('open');
    await connection.close();
  });

  it('forwards audio while open and sends the finish sequence once on stop', async () => {
    const { connection, events } = await open();

    connection.send(new Uint8Array(CHUNK_100_MS));
    connection.send(new Uint8Array(CHUNK_100_MS));
    await Promise.all([connection.close(), connection.close()]);
    await connection.close();

    expect(vendor.last().binaryFrames).toEqual([CHUNK_100_MS, CHUNK_100_MS]);
    expect(vendor.last().texts).toEqual([FINISH]);
    // The completion signal's lines come before "closed"; the core closes with 1000 itself.
    expect(events).toEqual([
      final('released by done'),
      { type: 'closed', code: 1000, reason: null },
    ]);
    expect(connection.state).toBe('closed');
  });

  it('drops and counts audio once Stop began, and after close', async () => {
    vendor.script.onText = () => undefined; // never answers Finish
    const { connection } = await open({ closeTimeoutMs: 50 });

    const closing = connection.close();
    connection.send(new Uint8Array(CHUNK_100_MS));
    await closing;
    connection.send(new Uint8Array(CHUNK_100_MS));

    expect(vendor.last().binaryFrames).toEqual([]);
    expect(connection.usage().droppedChunks).toBe(2);
  });

  it('terminates within the hard finish timeout when the vendor never answers', async () => {
    vendor.script.onText = () => undefined;
    const { connection, events } = await open({ closeTimeoutMs: 80 });

    const started = Date.now();
    await connection.close();

    expect(Date.now() - started).toBeLessThan(1_000);
    // Cut short, the finish loses the lines of the audio the vendor had not finished: a failure
    // the caller must hear of (CaptureSession records that tail as a gap), not a quiet close.
    expect(events).toEqual([
      {
        type: 'error',
        message:
          'Toy did not finish the stream (code 1006: the connection dropped without a close frame): its last lines are lost',
        fatal: true,
      },
      { type: 'closed', code: 1006, reason: null },
    ]);
    expect(lines.some((line) => line.message.includes('did not finish in time'))).toBe(true);
    await waitFor(() => vendor.openSockets() === 0);
  });

  it('terminates when the vendor answers the finish but never closes its side', async () => {
    vendor.script.onText = (connection, text) => {
      if (text !== FINISH) return;
      connection.socket.send(JSON.stringify({ type: 'done' }));
      // A peer that ignores our close frame: ws alone would wait 30 s for it.
      connection.socket.pause();
    };
    const { connection, events } = await open({ closeTimeoutMs: 80 });

    const started = Date.now();
    await connection.close();
    expect(Date.now() - started).toBeLessThan(1_000);
    // The vendor finished: only its close frame is missing, so no line is lost.
    expect(events).toEqual([
      final('released by done'),
      { type: 'closed', code: 1006, reason: null },
    ]);
    vendor.last().socket.resume(); // let the deaf peer notice the dropped connection
  });

  it('reports a vendor that drops the connection before it finished, when its close is the signal', async () => {
    vendor.script.onText = (connection, text) => {
      if (text === FINISH) connection.socket.terminate(); // no close frame: not a finish
    };
    const { connection, events } = await open({
      protocol: toyProtocol(vendor.baseUrl, { finishedOn: 'vendor-close' }),
    });

    await connection.close();

    expect(events.map((event) => event.type)).toEqual(['error', 'closed']);
    expect(events[0]).toMatchObject({ type: 'error', fatal: true });
  });

  it('waits for the vendor to close when that is its completion signal', async () => {
    vendor.script.onText = (connection, text) => {
      if (text !== FINISH) return;
      // A finished message mid-sequence, then more lines, then the vendor's own close.
      connection.socket.send(JSON.stringify({ type: 'done' }));
      setTimeout(() => {
        connection.socket.send(JSON.stringify({ type: 'final', text: 'after done' }));
        connection.socket.close(1000, 'bye');
      }, 20);
    };
    const { connection, events } = await open({
      protocol: toyProtocol(vendor.baseUrl, { finishedOn: 'vendor-close' }),
    });

    await connection.close();
    // Closing on "done" would have lost the line after it.
    expect(events).toEqual([
      final('released by done'),
      final('after done'),
      { type: 'closed', code: 1000, reason: 'bye' },
    ]);
  });

  it('emits held lines before "closed"', async () => {
    vendor.script.onBinary = (connection) => {
      connection.socket.send(JSON.stringify({ type: 'hold', text: 'held line' }));
    };
    vendor.script.onText = (connection, text) => {
      if (text === FINISH) connection.socket.close(1000);
    };
    const { connection, events } = await open({
      protocol: toyProtocol(vendor.baseUrl, { finishedOn: 'vendor-close' }),
    });

    connection.send(new Uint8Array(CHUNK_100_MS));
    await waitFor(() => vendor.last().binaryFrames.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await connection.close();

    expect(events.map((event) => event.type)).toEqual(['final', 'closed']);
  });

  it('reports a vendor close mid-call as one fatal error, then closed', async () => {
    const { connection, events } = await open();

    vendor.last().socket.close(4000);
    await waitFor(() => events.some((event) => event.type === 'closed'));

    expect(events).toEqual([
      { type: 'error', message: 'Toy closed the stream (code 4000: toy limit)', fatal: true },
      { type: 'closed', code: 4000, reason: null },
    ]);
    expect(connection.state).toBe('closed');
    await connection.close(); // a no-op now
    expect(events).toHaveLength(2);
  });

  it('ends the session on a vendor error, and terminates it if the vendor keeps it open', async () => {
    vendor.script.onBinary = (connection) => {
      connection.socket.send(JSON.stringify({ type: 'error', text: 'quota exceeded' }));
      connection.socket.pause(); // and never closes, nor answers our close
    };
    const { connection, events } = await open({ closeTimeoutMs: 80 });

    connection.send(new Uint8Array(CHUNK_100_MS));
    await waitFor(() => events.some((event) => event.type === 'closed'));
    connection.send(new Uint8Array(CHUNK_100_MS));

    expect(events.map((event) => event.type)).toEqual(['error', 'closed']);
    expect(events[0]).toEqual({ type: 'error', message: 'quota exceeded', fatal: true });
    expect(vendor.last().binaryFrames).toEqual([CHUNK_100_MS]);
    expect(lines.some((line) => line.message.includes('did not finish in time'))).toBe(true);
    vendor.last().socket.resume(); // let the deaf peer notice the dropped connection
  });

  /**
   * CaptureSession's listener closes a stream from inside its fatal error, synchronously
   * (streamFailed → retire → close()). These pin that such a close never restarts the finish.
   */
  describe('a listener that closes the stream on its fatal error', () => {
    function closeOnFatal(connection: SttConnection): Promise<void>[] {
      const closes: Promise<void>[] = [];
      connection.on((event) => {
        if (event.type === 'error' && event.fatal) closes.push(connection.close());
      });
      return closes;
    }

    it('leaves no finish timer behind a vendor close mid-call', async () => {
      const { connection, events } = await open({ closeTimeoutMs: 50 });
      const closes = closeOnFatal(connection);

      vendor.last().socket.close(4000);
      await waitFor(() => events.some((event) => event.type === 'closed'));
      await Promise.all(closes);
      // Past the finish deadline: a timer armed by that close would log a forced termination now.
      await new Promise((resolve) => setTimeout(resolve, 120));

      expect(closes).toHaveLength(1);
      expect(events.map((event) => event.type)).toEqual(['error', 'closed']);
      expect(lines.some((line) => line.message.includes('did not finish in time'))).toBe(false);
    });

    it('closes at once after a vendor error, without a finish sequence for the dead session', async () => {
      vendor.script.onBinary = (connection) => {
        connection.socket.send(JSON.stringify({ type: 'error', text: 'quota exceeded' }));
      };
      vendor.script.onText = () => undefined; // keeps the socket open, ignores any finish
      const { connection, events } = await open({ closeTimeoutMs: 300 });
      const closes = closeOnFatal(connection);

      connection.send(new Uint8Array(CHUNK_100_MS));
      await waitFor(() => events.some((event) => event.type === 'closed'));
      await Promise.all(closes);

      expect(vendor.last().texts).not.toContain(FINISH);
      // Our close frame, answered: not the forced terminate (1006) at the finish deadline.
      expect(events.at(-1)).toEqual({ type: 'closed', code: 1000, reason: null });
      expect(lines.some((line) => line.message.includes('did not finish in time'))).toBe(false);
    });
  });

  it('turns an unreadable message into a non-fatal error and keeps going', async () => {
    vendor.script.onBinary = (connection) => {
      connection.socket.send('{nope');
      connection.socket.send(JSON.stringify({ type: 'final', text: 'still here' }));
    };
    const { connection, events } = await open();

    connection.send(new Uint8Array(CHUNK_100_MS));
    await waitFor(() => events.some((event) => event.type === 'final'));

    expect(events[0]).toEqual({
      type: 'error',
      message: 'Toy sent a message Roger could not read (not JSON)',
      fatal: false,
    });
    expect(events[1]).toEqual(final('still here'));
    expect(connection.state).toBe('open');
    await connection.close();
  });

  it('turns a listener that throws into a non-fatal error instead of crashing main', async () => {
    vendor.script.onBinary = (connection) => {
      connection.socket.send(JSON.stringify({ type: 'final', text: 'boom' }));
    };
    const { connection, events } = await open();
    connection.on((event) => {
      if (event.type === 'final') throw new Error('listener broke');
    });

    connection.send(new Uint8Array(CHUNK_100_MS));
    await waitFor(() => events.some((event) => event.type === 'error'));

    expect(events.at(-1)).toEqual({ type: 'error', message: 'listener broke', fatal: false });
    await connection.close();
  });

  it('sends the keep-alive only while open', async () => {
    const { connection } = await open({
      protocol: toyProtocol(vendor.baseUrl, {
        keepAlive: { message: KEEP_ALIVE, intervalMs: 10 },
      }),
    });

    await waitFor(() => vendor.last().texts.includes(KEEP_ALIVE));
    await connection.close();
    const sentAtClose = vendor.last().texts.length;
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(vendor.last().texts.length).toBe(sentAtClose);
    expect(vendor.last().texts.at(-1)).toBe(FINISH);
  });

  it('sends the keep-alive only while audio was sent within the keep-alive window', async () => {
    const clock = manualClock(0);
    const keepAlives = (): number => vendor.last().texts.filter((t) => t === KEEP_ALIVE).length;
    const { connection } = await open({
      clock: clock.now,
      keepAliveForMs: 1_000,
      protocol: toyProtocol(vendor.baseUrl, {
        keepAlive: { message: KEEP_ALIVE, intervalMs: 10 },
      }),
    });

    // Just opened: the window counts from the open.
    await waitFor(() => keepAlives() > 0);
    // A stalled source: no audio for the whole window. A keep-alive now would hold a billed
    // session open for a source that sends nothing.
    clock.set(1_000);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const stalled = keepAlives();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(keepAlives()).toBe(stalled);

    connection.send(new Uint8Array(CHUNK_100_MS));
    await waitFor(() => keepAlives() > stalled);
    await connection.close();
  });

  it('meters connected time from the handshake to the close, and the audio sent', async () => {
    const clock = manualClock(1_000);
    const { connection } = await open({ clock: clock.now });

    connection.send(new Uint8Array(CHUNK_100_MS));
    connection.send(new Uint8Array(CHUNK_100_MS));
    connection.send(new Uint8Array(CHUNK_100_MS));
    clock.set(31_000);
    expect(connection.usage()).toEqual({ connectedMs: 30_000, audioSentMs: 300, droppedChunks: 0 });

    clock.set(61_000);
    await connection.close();
    clock.set(500_000); // closed: the meter stopped
    expect(connection.usage()).toEqual({ connectedMs: 60_000, audioSentMs: 300, droppedChunks: 0 });
    const closedLine = lines.find((line) => line.message === 'stt stream closed');
    expect(closedLine?.fields).toMatchObject({ connectedMs: 60_000, audioSentMs: 300 });
    const openLine = lines.find((line) => line.message === 'stt stream open');
    expect(openLine?.fields).toMatchObject({ stream: 'mic', model: 'toy-1' });
  });

  it('logs what the closed stream cost at the price the API named', async () => {
    const clock = manualClock(0);
    const { connection } = await open({ clock: clock.now });
    clock.set(60_000);
    await connection.close();

    const closedLine = lines.find((line) => line.message === 'stt stream closed');
    // One minute open at $0.15 an hour, silent or not.
    expect(closedLine?.fields).toMatchObject({ connectedMs: 60_000, estimatedCostUsd: 0.0025 });
  });

  it('logs no cost estimate when the price is unknown', async () => {
    const { connection } = await open({
      stream: { accessToken: 't', settings: { ...settings, pricePerHourUsd: null }, label: 'mic' },
    });
    await connection.close();

    const closedLine = lines.find((line) => line.message === 'stt stream closed');
    expect(closedLine?.fields).toMatchObject({ estimatedCostUsd: null });
  });

  it('never logs the token or the URL that carries it', async () => {
    const { connection } = await open();
    await connection.close();
    expect(JSON.stringify(lines)).not.toContain('secret-token');
  });

  describe('the wire tap', () => {
    /** A vendor that takes the token in the query, under any name and in any encoding. */
    function tokenInQuery(token: string): SttProtocol {
      const toy = toyProtocol(vendor.baseUrl);
      const encoded = encodeURIComponent(token);
      return {
        ...toy,
        target: (stream) => ({
          url:
            `${vendor.baseUrl}/listen?model=${stream.settings.model}&access=${encoded}` +
            `&auth=Bearer%20${encoded}&raw=${token}&lang=en`,
          headers: {},
        }),
      };
    }

    it('gets the query with every parameter that carries the token left out', async () => {
      const token = 'se/cr+et';
      const tapped: SttWireRecord[] = [];
      const { connection } = await open({
        protocol: tokenInQuery(token),
        stream: { accessToken: token, settings, label: 'system' },
        wireTap: (record) => tapped.push(record),
      });
      await connection.close();

      expect(tapped[0]).toEqual({ kind: 'connect', label: 'system', query: 'model=toy-1&lang=en' });
      expect(JSON.stringify(tapped)).not.toContain('se/cr');
      expect(JSON.stringify(tapped)).not.toContain(encodeURIComponent('se/cr'));
    });

    it('sees nothing of a stream it was not given to', async () => {
      const tapped: SttWireRecord[] = [];
      const tapless = await open();
      const tappedStream = await open({ wireTap: (record) => tapped.push(record) });
      tapless.connection.send(new Uint8Array(CHUNK_100_MS));
      await tapless.connection.close();
      await tappedStream.connection.close();

      expect(tapped.filter((record) => record.kind === 'binary')).toEqual([]);
      expect(tapped.filter((record) => record.kind === 'connect')).toHaveLength(1);
    });

    it('turns a tap that throws once open into one non-fatal error, and the stream goes on', async () => {
      vendor.script.onBinary = (connection, frame) => {
        if (frame === 2) connection.socket.send(JSON.stringify({ type: 'final', text: 'kept' }));
      };
      let calls = 0;
      const { connection, events } = await open({
        wireTap: (record) => {
          calls += 1;
          if (record.kind === 'binary') throw new Error('disk full');
        },
      });
      const callsBeforeAudio = calls;

      connection.send(new Uint8Array(CHUNK_100_MS));
      connection.send(new Uint8Array(CHUNK_100_MS));
      await waitFor(() => events.some((event) => event.type === 'final'));
      await connection.close();

      expect(events.map((event) => event.type)).toEqual(['error', 'final', 'final', 'closed']);
      expect(events[0]).toEqual({
        type: 'error',
        message: 'Toy wire tap failed: disk full',
        fatal: false,
      });
      // Switched off at its first failure: a recording with holes would pass for the whole wire.
      expect(calls).toBe(callsBeforeAudio + 1);
      expect(vendor.last().binaryFrames).toEqual([CHUNK_100_MS, CHUNK_100_MS]);
      expect(lines.find((line) => line.message === 'stt wire tap failed')?.level).toBe('error');
    });

    /**
     * Before ready no listener exists: openStream hands the stream over only once it is open. An
     * error event there reached no one, and the item ran to its end unrecorded with nothing to say
     * so; the connect fails instead, so the bench fails the item.
     */
    it('fails the connect before any socket when the tap cannot take its first record', () => {
      // The bench's tap opens its file on the first record, always the connect: a missing
      // --save-wire directory, EACCES or a full disk fails it there.
      const connect = (): SttConnection =>
        new SttConnection(
          options({
            wireTap: () => {
              throw new Error('no such directory');
            },
          }),
        );

      expect(connect).toThrow(SttConnectError);
      expect(connect).toThrow('Toy wire tap failed: no such directory');
      expect(vendor.connections).toHaveLength(0);
      expect(lines.find((line) => line.message === 'stt wire tap failed')?.fields).toMatchObject({
        record: 'connect',
      });
    });

    it('fails the connect, with the socket closed, when the tap throws before the ready signal', async () => {
      let calls = 0;
      const { connection, error } = await connectError({
        wireTap: (record) => {
          calls += 1;
          if (record.kind === 'text') throw new Error('disk full');
        },
      });

      expect(error.message).toBe('Toy wire tap failed: disk full');
      expect(error.keytermsRejected).toBe(false);
      expect(connection.state).toBe('closed');
      // The connect, then the ready message it failed on: the ready message opened nothing.
      expect(calls).toBe(2);
    });
  });

  /**
   * Pacing on a manual pace clock: it decides what may go, real timers only wake the queue. A
   * vendor that declares 'realtime' (AssemblyAI) closes a session sent audio faster than real time.
   */
  describe('pacing', () => {
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 150));

    function realtime(): SttProtocol {
      return toyProtocol(vendor.baseUrl, { audioPacing: 'realtime' });
    }

    function sendBurst(connection: SttConnection, chunks: number): void {
      for (let chunk = 0; chunk < chunks; chunk += 1) {
        connection.send(new Uint8Array(CHUNK_100_MS));
      }
    }

    it('sends a backlog at once for a protocol that declares no pacing', async () => {
      const clock = manualClock(0);
      const { connection } = await open({ paceClock: clock.now });

      sendBurst(connection, 30);

      expect(connection.usage().audioSentMs).toBe(3_000);
      await waitFor(() => vendor.last().binaryFrames.length === 30);
      await connection.close();
    });

    it('never holds live chunks', async () => {
      const clock = manualClock(0);
      const { connection } = await open({ paceClock: clock.now, protocol: realtime() });

      for (let chunk = 0; chunk < 20; chunk += 1) {
        clock.set(chunk * 100 + 10);
        connection.send(new Uint8Array(CHUNK_100_MS));
        expect(connection.usage().audioSentMs).toBe((chunk + 1) * 100);
      }
      await connection.close();
      expect(vendor.last().binaryFrames).toHaveLength(20);
    });

    it('sends a 3 s backlog right after ready at 1x, never more than one frame ahead', async () => {
      const clock = manualClock(0);
      const { connection } = await open({ paceClock: clock.now, protocol: realtime() });

      sendBurst(connection, 30);
      expect(connection.usage().audioSentMs).toBe(100);
      await settle();
      expect(connection.usage().audioSentMs).toBe(100);

      clock.set(1_000);
      await waitFor(() => connection.usage().audioSentMs === 1_100);
      await settle();
      expect(connection.usage().audioSentMs).toBe(1_100);

      clock.set(2_900);
      await waitFor(() => vendor.last().binaryFrames.length === 30);
      expect(connection.usage().audioSentMs).toBe(3_000);
      await connection.close();
    });

    it('paces on the pace clock: a wall-clock step either way neither sends nor holds a backlog', async () => {
      // An NTP step or a manual time change moves the wall clock while real time goes on.
      const wall = manualClock(0);
      const pace = manualClock(0);
      const { connection } = await open({
        clock: wall.now,
        paceClock: pace.now,
        protocol: realtime(),
      });
      sendBurst(connection, 30);

      // Forward: counted as time passed, it would send the rest at once and draw AssemblyAI's 3007.
      wall.set(4_000);
      connection.send(new Uint8Array(CHUNK_100_MS)); // live audio wakes the queue on the new time
      await settle();
      expect(connection.usage().audioSentMs).toBe(100);

      // Back: the backlog keeps going at 1x rather than wait the step out.
      wall.set(-60_000);
      pace.set(1_000);
      await waitFor(() => connection.usage().audioSentMs === 1_100);
      await settle();
      expect(connection.usage().audioSentMs).toBe(1_100);

      pace.set(3_000);
      await waitFor(() => vendor.last().binaryFrames.length === 31);
      await connection.close();
    });

    it('counts real time from the ready signal, not from the handshake', async () => {
      const clock = manualClock(0);
      let ready = (): void => undefined;
      vendor.script.onConnect = (peer) => {
        ready = () => {
          peer.socket.send(JSON.stringify({ type: 'ready' }));
        };
      };
      const connection = new SttConnection(options({ paceClock: clock.now, protocol: realtime() }));
      await waitFor(() => vendor.connections.length === 1);
      clock.set(5_000); // a slow session start: none of it may be spent on a burst
      ready();
      await connection.whenOpen();

      sendBurst(connection, 30);

      expect(connection.usage().audioSentMs).toBe(100);
      clock.set(8_000);
      await connection.close();
    });

    it('drains the queue before the finish sequence on close', async () => {
      const clock = manualClock(0);
      let framesAtFinish: number | null = null;
      vendor.script.onText = (connection, text) => {
        if (text !== FINISH) return;
        framesAtFinish = connection.binaryFrames.length;
        connection.socket.send(JSON.stringify({ type: 'done' }));
      };
      const { connection, events } = await open({ paceClock: clock.now, protocol: realtime() });
      sendBurst(connection, 30);

      const closing = connection.close();
      clock.set(2_900);
      await closing;

      expect(framesAtFinish).toBe(30);
      expect(vendor.last().texts).toEqual([FINISH]);
      expect(connection.usage().audioSentMs).toBe(3_000);
      expect(events.at(-1)).toEqual({ type: 'closed', code: 1000, reason: null });
    });

    it('still closes within the hard timeout when the queue cannot drain in time', async () => {
      const clock = manualClock(0);
      const { connection, events } = await open({
        paceClock: clock.now,
        protocol: realtime(),
        closeTimeoutMs: 80,
      });
      sendBurst(connection, 30);

      const started = Date.now();
      await connection.close();

      expect(Date.now() - started).toBeLessThan(1_000);
      expect(vendor.last().texts).toEqual([]);
      expect(events.filter((event) => event.type === 'closed')).toHaveLength(1);
      const dropped = lines.find((line) => line.message === 'stt paced audio dropped');
      expect(dropped).toMatchObject({ level: 'warn', fields: { queuedMs: 2_900 } });
      // Nothing stays queued: no timer is left to send the rest once time moves on.
      clock.set(60_000);
      await settle();
      expect(connection.usage().audioSentMs).toBe(100);
    });

    it('drops the queue after a vendor error instead of sending it to the dead session', async () => {
      const clock = manualClock(0);
      vendor.script.onBinary = (connection) => {
        connection.socket.send(JSON.stringify({ type: 'error', text: 'quota exceeded' }));
      };
      const { connection, events } = await open({ paceClock: clock.now, protocol: realtime() });

      sendBurst(connection, 30);
      await waitFor(() => events.some((event) => event.type === 'closed'));
      clock.set(60_000);
      await settle();

      expect(vendor.last().binaryFrames).toEqual([CHUNK_100_MS]);
      expect(connection.usage().audioSentMs).toBe(100);
      expect(lines.find((line) => line.message === 'stt paced audio dropped')).toMatchObject({
        fields: { queuedMs: 2_900 },
      });
    });
    it('drops the queue on a vendor error while Stop drains it', async () => {
      const clock = manualClock(0);
      const { connection, events } = await open({
        paceClock: clock.now,
        protocol: realtime(),
        closeTimeoutMs: 300,
      });
      sendBurst(connection, 30);
      const closing = connection.close();
      await waitFor(() => vendor.last().binaryFrames.length === 1);

      vendor.last().socket.send(JSON.stringify({ type: 'error', text: 'quota exceeded' }));
      await waitFor(() => events.some((event) => event.type === 'error'));
      clock.set(60_000);
      await closing;

      expect(vendor.last().binaryFrames).toEqual([CHUNK_100_MS]);
      expect(vendor.last().texts).toEqual([]);
      expect(lines.find((line) => line.message === 'stt paced audio dropped')).toMatchObject({
        fields: { queuedMs: 2_900 },
      });
    });
  });

  describe('connect failures end with the socket closed', () => {
    it('times out a vendor that never sends its ready signal', async () => {
      vendor.script.onConnect = () => undefined;
      const { connection, error } = await connectError({ connectTimeoutMs: 60 });

      expect(error.message).toBe('Toy did not start the session within 60 ms');
      expect(connection.state).toBe('closed');
      expect(connection.usage().connectedMs).toBeGreaterThanOrEqual(0);
      expect(connection.opened).toBe(true); // the vendor may bill it: it counts as a session
    });

    it('explains a close before the ready signal with the vendor error text and advice', async () => {
      vendor.script.onConnect = (connection) => {
        connection.socket.send(JSON.stringify({ type: 'error', text: 'Slow down please' }));
        connection.socket.close(4000, 'Slow down please');
      };
      const { error } = await connectError();

      expect(error.message).toBe(
        'Toy ended the connection before the session began: Slow down please. Wait a minute.',
      );
    });

    it('explains a close before the ready signal with the close code when no error came', async () => {
      vendor.script.onConnect = (connection) => {
        connection.socket.close(4000);
      };
      const { error } = await connectError();

      expect(error.message).toBe(
        'Toy ended the connection before the session began (code 4000: toy limit)',
      );
    });

    it('reports a refused handshake with its HTTP status', async () => {
      vendor.rejectWith = 401;
      const { connection, error } = await connectError();

      expect(error.message).toBe('Toy: rejected with HTTP 401');
      expect(error.statusCode).toBe(401);
      expect(connection.opened).toBe(false);
    });

    it('refuses settings the protocol cannot use before opening any socket', () => {
      const protocol: SttProtocol = {
        ...toyProtocol(vendor.baseUrl),
        target: () => {
          throw new SttConnectError('Toy cannot be sent opus audio');
        },
      };
      expect(() => new SttConnection(options({ protocol }))).toThrow(SttConnectError);
      expect(vendor.connections).toHaveLength(0);
    });
  });

  /**
   * The jargon list: the core cuts it to the shared limits before any protocol sees it, and turns a
   * connect the vendor refused over it into SttConnectError.keytermsRejected. It never retries:
   * CaptureSession reopens once without the list, through the open budget (M3-T4b).
   */
  describe('keyterms', () => {
    const LIST = ['Linkt', 'Roger'];

    function withKeyterms(keyterms: readonly string[]): SttConnectionOptions['stream'] {
      return { accessToken: 't', settings: { ...settings, keyterms }, label: 'mic' };
    }

    /** Blames an HTTP 400 at the handshake on the list, as Deepgram's protocol does. */
    function refusingOn400(asked: SttConnectRefusal[] = []): SttProtocol {
      return {
        ...toyProtocol(vendor.baseUrl),
        keytermsRejected: (refusal) => {
          asked.push(refusal);
          return refusal.kind === 'http-status' && refusal.status === 400;
        },
      };
    }

    it('hands the protocol the list cut to the shared limits, with a warning that only counts', async () => {
      const seen: {
        target?: readonly string[] | undefined;
        session?: readonly string[] | undefined;
      } = {};
      const toy = toyProtocol(vendor.baseUrl);
      const protocol: SttProtocol = {
        ...toy,
        target: (stream) => {
          seen.target = stream.settings.keyterms;
          return toy.target(stream);
        },
        session: (context) => {
          seen.session = context.settings.keyterms;
          return toy.session(context);
        },
      };
      const long = Array.from({ length: 130 }, (_, index) => `Jargon${index}`);
      const { connection } = await open({ protocol, stream: withKeyterms(long) });
      await connection.close();

      expect(seen).toEqual({ target: long.slice(0, 100), session: long.slice(0, 100) });
      const warning = lines.find(
        (line) => line.message === 'stt keyterms cut to the vendor limits',
      );
      expect(warning?.level).toBe('warn');
      expect(warning?.fields).toMatchObject({ received: 130, sent: 100, dropped: 30 });
      // Terms name clients and colleagues: counts only, in every line.
      expect(JSON.stringify(lines)).not.toContain('Jargon');
    });

    it('flags a refusal the protocol blames on the list, after exactly one handshake', async () => {
      vendor.rejectWith = 400;
      const asked: SttConnectRefusal[] = [];
      const { connection, error } = await connectError({
        protocol: refusingOn400(asked),
        stream: withKeyterms(LIST),
      });

      expect(error.keytermsRejected).toBe(true);
      expect(error.statusCode).toBe(400);
      expect(error.message).toBe(
        'Toy: rejected with HTTP 400; the jargon list (2 terms) was rejected',
      );
      expect(asked).toEqual([{ kind: 'http-status', status: 400 }]);
      expect(connection.state).toBe('closed');
      expect(lines.find((line) => line.message === 'stt connect failed')?.fields).toMatchObject({
        keyterms: 2,
        keytermsRejected: true,
      });
      // Never retried here: that open would bypass the open budget (house rule 9).
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(vendor.handshakes).toBe(1);
    });

    it('never flags a refusal when no list was sent, and never asks the protocol', async () => {
      vendor.rejectWith = 400;
      const asked: SttConnectRefusal[] = [];
      for (const stream of [withKeyterms([]), { accessToken: 't', settings, label: 'mic' }]) {
        const { error } = await connectError({ protocol: refusingOn400(asked), stream });

        expect(error.keytermsRejected).toBe(false);
        expect(error.message).toBe('Toy: rejected with HTTP 400');
      }
      expect(asked).toEqual([]);
    });

    it('never flags a refusal the protocol does not blame on the list', async () => {
      vendor.rejectWith = 401;
      const { error } = await connectError({
        protocol: refusingOn400(),
        stream: withKeyterms(LIST),
      });

      expect(error.keytermsRejected).toBe(false);
      expect(error.message).toBe('Toy: rejected with HTTP 401');
    });

    it('never flags a refusal for a protocol that reports no rejected list', async () => {
      vendor.rejectWith = 400;
      const { error } = await connectError({ stream: withKeyterms(LIST) });

      expect(error.keytermsRejected).toBe(false);
    });

    it('asks about a close before the ready signal with its code and reason', async () => {
      vendor.script.onConnect = (connection) => {
        connection.socket.close(4001, 'bad prompt');
      };
      const asked: SttConnectRefusal[] = [];
      const protocol: SttProtocol = {
        ...toyProtocol(vendor.baseUrl),
        keytermsRejected: (refusal) => {
          asked.push(refusal);
          return refusal.kind === 'closed-before-ready';
        },
      };
      const { error } = await connectError({ protocol, stream: withKeyterms(['Linkt']) });

      expect(asked).toEqual([{ kind: 'closed-before-ready', code: 4001, reason: 'bad prompt' }]);
      expect(error.keytermsRejected).toBe(true);
      expect(error.message).toBe(
        'Toy ended the connection before the session began (code 4001: bad prompt); the jargon ' +
          'list (1 term) was rejected',
      );
    });

    it('never asks about a connect that timed out', async () => {
      vendor.script.onConnect = () => undefined;
      const asked: SttConnectRefusal[] = [];
      const protocol: SttProtocol = {
        ...toyProtocol(vendor.baseUrl),
        keytermsRejected: (refusal) => {
          asked.push(refusal);
          return true;
        },
      };
      const { error } = await connectError({
        protocol,
        stream: withKeyterms(LIST),
        connectTimeoutMs: 60,
      });

      expect(error.keytermsRejected).toBe(false);
      expect(asked).toEqual([]);
    });

    it('never asks about a connection that dropped before the ready signal', async () => {
      // The TCP connection ends after the upgrade with no close frame (a Wi-Fi handoff, a proxy
      // cutting it): ws reports 'close 1006' and no 'error', so this reaches the close path.
      vendor.script.onConnect = (connection) => {
        connection.socket.terminate();
      };
      const asked: SttConnectRefusal[] = [];
      const protocol: SttProtocol = {
        ...toyProtocol(vendor.baseUrl),
        keytermsRejected: (refusal) => {
          asked.push(refusal);
          return true;
        },
      };
      const { error } = await connectError({ protocol, stream: withKeyterms(LIST) });

      expect(asked).toEqual([]);
      expect(error.keytermsRejected).toBe(false);
      expect(error.message).toBe(
        'Toy ended the connection before the session began (code 1006: the connection dropped ' +
          'without a close frame)',
      );
    });
  });

  /**
   * Dead-socket detection (M2-T6) on a manual clock: real timers only wake the check, every few ms
   * here and every second in the app, and the clock decides what is due. A clock step here is one
   * of the app's checks.
   */
  describe('liveness', () => {
    const TICK_MS = 5;
    /** Long enough for several checks to run and for a frame to cross the loopback. */
    const ticks = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, TICK_MS * 6));

    function lively(
      clock: ReturnType<typeof manualClock>,
      overrides: Partial<SttConnectionOptions> = {},
    ): Partial<SttConnectionOptions> {
      return {
        clock: clock.now,
        paceClock: clock.now,
        liveness: { ...STT_LIVENESS, pingIntervalMs: TICK_MS },
        ...overrides,
      };
    }

    /** Open, audio flowing, and the vendor has answered a ping: all at clock time 0. */
    async function answering(clock: ReturnType<typeof manualClock>) {
      const opened = await open(lively(clock));
      opened.connection.send(new Uint8Array(CHUNK_100_MS));
      await waitFor(() => vendor.last().pings > 0);
      await ticks(); // the pongs are back
      return opened;
    }

    const said = (message: string): number => lines.filter((l) => l.message === message).length;
    const NO_PING_CHECK =
      'stt vendor answers no ping: no dead-socket check on this stream until it does';

    it('pings only while audio flows: none before the first chunk, none once it stopped', async () => {
      const clock = manualClock(0);
      const { connection } = await open(lively(clock, { keepAliveForMs: 1_000 }));
      await ticks();
      expect(vendor.last().pings).toBe(0);

      connection.send(new Uint8Array(CHUNK_100_MS));
      await waitFor(() => vendor.last().pings > 0);

      clock.set(1_000); // no audio for the keep-alive window: a stalled source
      await ticks();
      const stalled = vendor.last().pings;
      await ticks();
      expect(vendor.last().pings).toBe(stalled);
      await connection.close();
    });

    it('declares the socket dead when nothing came for 4 s: one fatal error, then terminated', async () => {
      const clock = manualClock(0);
      const { connection, events } = await answering(clock);
      vendor.last().answersPings = false;

      clock.set(3_999);
      await ticks();
      expect(events).toEqual([]);

      clock.set(4_000);
      await waitFor(() => events.some((event) => event.type === 'closed'));
      expect(events).toEqual([
        { type: 'error', message: 'Toy stopped answering: nothing received for 4 s', fatal: true },
        // Terminated: a peer that answers no ping answers no close frame either.
        { type: 'closed', code: 1006, reason: null },
      ]);
      expect(connection.state).toBe('closed');
      expect(vendor.last().texts).not.toContain(FINISH);
      expect(said('stt socket dead: the vendor stopped answering')).toBe(1);
      await waitFor(() => vendor.last().closed);
    });

    it('counts any message from the vendor as a sign of life', async () => {
      const clock = manualClock(0);
      const { events } = await answering(clock);
      vendor.last().answersPings = false;

      clock.set(3_000);
      vendor.last().socket.send(JSON.stringify({ type: 'progress' }));
      await ticks();
      clock.set(6_999);
      await ticks();
      expect(events).toEqual([]);

      clock.set(7_000);
      await waitFor(() => events.some((event) => event.type === 'closed'));
      expect(events[0]).toMatchObject({ type: 'error', fatal: true });
    });

    it('starts the 4 s over when audio flows again after a quiet spell', async () => {
      const clock = manualClock(0);
      const { connection, events } = await answering(clock);
      vendor.last().answersPings = false;

      // No audio for the keep-alive window (30 s): no ping is owed an answer, so nothing is dead.
      clock.set(30_000);
      await ticks();
      clock.set(100_000);
      await ticks();
      expect(events).toEqual([]);

      connection.send(new Uint8Array(CHUNK_100_MS));
      await ticks();
      clock.set(103_999);
      await ticks();
      expect(events).toEqual([]);

      clock.set(104_000);
      await waitFor(() => events.some((event) => event.type === 'closed'));
      expect(events[0]).toMatchObject({ type: 'error', fatal: true });
    });

    it('falls back to messages, send errors and the network poll for a vendor that answers no ping', async () => {
      vendor.answersPings = false;
      const clock = manualClock(0);
      const { connection, events } = await open(lively(clock));
      connection.send(new Uint8Array(CHUNK_100_MS));
      await waitFor(() => vendor.last().pings > 0);

      // No pong yet, so no deadline: a vendor that ignores pings is not a dead one.
      clock.set(9_999);
      await ticks();
      expect(events).toEqual([]);
      expect(said(NO_PING_CHECK)).toBe(0);

      clock.set(10_000);
      await ticks();
      clock.set(60_000);
      connection.send(new Uint8Array(CHUNK_100_MS));
      await ticks();

      expect(events).toEqual([]);
      expect(connection.state).toBe('open');
      expect(said(NO_PING_CHECK)).toBe(1);
      await connection.close();
    });

    it('turns the deadline on when a pong comes after the fallback, since pings go on', async () => {
      vendor.answersPings = false;
      const clock = manualClock(0);
      const { connection, events } = await open(lively(clock));
      connection.send(new Uint8Array(CHUNK_100_MS));
      await waitFor(() => vendor.last().pings > 0);
      clock.set(10_000);
      await ticks();
      expect(said(NO_PING_CHECK)).toBe(1);

      // The pongs of pings sent while the upstream was down come in late: this vendor does
      // answer. Had the fallback stopped the check for good, the stream would run unchecked.
      vendor.last().socket.pong();
      await ticks();
      clock.set(13_999);
      await ticks();
      expect(events).toEqual([]);

      clock.set(14_000);
      await waitFor(() => events.some((event) => event.type === 'closed'));
      expect(events[0]).toMatchObject({ type: 'error', fatal: true });
    });

    it('keeps the deadline on a later stream of a vendor that answered pings, with no pong of its own', async () => {
      const clock = manualClock(0);
      const pongRecord = { answered: false };
      const earlier = await open(lively(clock, { pongRecord }));
      earlier.connection.send(new Uint8Array(CHUNK_100_MS));
      await waitFor(() => vendor.last().pings > 0);
      await ticks(); // its pongs are back
      await earlier.connection.close();
      expect(pongRecord.answered).toBe(true);

      // The upstream drops right after this stream became ready, before its first pong (Wi-Fi
      // still associated): on its own it would read as a vendor that ignores pings, unchecked.
      vendor.answersPings = false;
      const { connection, events } = await open(lively(clock, { pongRecord }));
      connection.send(new Uint8Array(CHUNK_100_MS));
      await waitFor(() => vendor.last().pings > 0);
      clock.set(3_999);
      await ticks();
      expect(events).toEqual([]);

      clock.set(4_000);
      await waitFor(() => events.some((event) => event.type === 'closed'));
      expect(events[0]).toEqual({
        type: 'error',
        message: 'Toy stopped answering: nothing received for 4 s',
        fatal: true,
      });
      expect(said(NO_PING_CHECK)).toBe(0);
    });

    it('stops pinging once Stop begins', async () => {
      vendor.script.onText = () => undefined; // never answers Finish: Stop waits for its deadline
      const clock = manualClock(0);
      const { connection } = await open(lively(clock, { closeTimeoutMs: 300 }));
      connection.send(new Uint8Array(CHUNK_100_MS));
      await waitFor(() => vendor.last().pings > 0);

      const closing = connection.close();
      await ticks(); // a ping already on the wire lands
      const pings = vendor.last().pings;
      await ticks();
      expect(vendor.last().pings).toBe(pings);
      await closing;
    });
  });

  /** For the network poll (M2-T6): with the network gone, a finish sequence can only wait. */
  describe('terminate', () => {
    it('drops the socket at once: no finish sequence, no fatal error, held lines first', async () => {
      vendor.script.onBinary = (connection) => {
        connection.socket.send(JSON.stringify({ type: 'hold', text: 'held line' }));
      };
      const { connection, events } = await open();
      connection.send(new Uint8Array(CHUNK_100_MS));
      await waitFor(() => vendor.last().binaryFrames.length === 1);
      await new Promise((resolve) => setTimeout(resolve, 20)); // the held line is in

      const started = Date.now();
      await connection.terminate();

      expect(Date.now() - started).toBeLessThan(500);
      expect(vendor.last().texts).not.toContain(FINISH);
      expect(events).toEqual([final('held line'), { type: 'closed', code: 1006, reason: null }]);
      expect(
        lines.some((line) => line.message === 'stt stream terminated: no finish sequence'),
      ).toBe(true);
      await waitFor(() => vendor.last().closed);
    });

    it('cuts short a Stop still waiting for the vendor to finish', async () => {
      vendor.script.onText = () => undefined; // never answers Finish
      const { connection, events } = await open({ closeTimeoutMs: 5_000 });
      const closing = connection.close();
      await waitFor(() => vendor.last().texts.includes(FINISH));

      const started = Date.now();
      await connection.terminate();
      await closing;

      expect(Date.now() - started).toBeLessThan(1_000);
      // No fatal error for the finish it cut short: the caller asked, and knows (CaptureSession).
      expect(events.map((event) => event.type)).toEqual(['closed']);
      expect(lines.some((line) => line.message.includes('did not finish in time'))).toBe(false);
    });

    it('fails a connect still waiting for the ready signal', async () => {
      vendor.script.onConnect = () => undefined; // never ready
      const connection = new SttConnection(options());
      const opening = connection.whenOpen().then(
        () => null,
        (e: unknown) => e,
      );
      await waitFor(() => vendor.connections.length === 1);

      await connection.terminate();

      expect(await opening).toBeInstanceOf(SttConnectError);
      expect(connection.state).toBe('closed');
    });
  });

  it('times out a handshake that never completes and closes the TCP socket', async () => {
    const silent = await SilentTcpServer.start();
    try {
      const { error } = await connectError({
        protocol: toyProtocol(silent.baseUrl),
        connectTimeoutMs: 60,
      });
      expect(error.message).toBe('Toy: connection timed out after 60 ms');
      await waitFor(() => silent.sockets.length === 1 && silent.openSockets() === 0);
    } finally {
      await silent.stop();
    }
  });
});
