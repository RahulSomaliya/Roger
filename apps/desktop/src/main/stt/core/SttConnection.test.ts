import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger, type LogFields } from '../../logger';
import { SttConnectError, type SttEvent, type SttStreamSettings } from '../SpeechToText';
import {
  FakeVendorServer,
  manualClock,
  SilentTcpServer,
  waitFor,
} from '../testing/fakeVendorServer';
import { SttConnection, type SttConnectionOptions } from './SttConnection';
import { describeCloseWith, type SttProtocol, type SttProtocolMessage } from './SttProtocol';

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
    expect(events.at(-1)).toMatchObject({ type: 'closed' });
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
    const { connection } = await open({ closeTimeoutMs: 80 });

    const started = Date.now();
    await connection.close();
    expect(Date.now() - started).toBeLessThan(1_000);
    vendor.last().socket.resume(); // let the deaf peer notice the dropped connection
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

  /**
   * Pacing on a manual clock: the clock decides what may go, real timers only wake the queue. A
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
      const { connection } = await open({ clock: clock.now });

      sendBurst(connection, 30);

      expect(connection.usage().audioSentMs).toBe(3_000);
      await waitFor(() => vendor.last().binaryFrames.length === 30);
      await connection.close();
    });

    it('never holds live chunks', async () => {
      const clock = manualClock(0);
      const { connection } = await open({ clock: clock.now, protocol: realtime() });

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
      const { connection } = await open({ clock: clock.now, protocol: realtime() });

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

    it('counts real time from the ready signal, not from the handshake', async () => {
      const clock = manualClock(0);
      let ready = (): void => undefined;
      vendor.script.onConnect = (peer) => {
        ready = () => {
          peer.socket.send(JSON.stringify({ type: 'ready' }));
        };
      };
      const connection = new SttConnection(options({ clock: clock.now, protocol: realtime() }));
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
      const { connection, events } = await open({ clock: clock.now, protocol: realtime() });
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
        clock: clock.now,
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
      const { connection, events } = await open({ clock: clock.now, protocol: realtime() });

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
