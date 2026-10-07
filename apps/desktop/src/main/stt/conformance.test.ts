import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createLogger, type Logger } from '../logger';
import type { SttWireRecord } from './core/SttConnection';
import { WebSocketSpeechToText } from './core/WebSocketSpeechToText';
import { KEYTERM_LIMITS } from './keyterms';
import { LOCAL_STT_PROVIDERS, STT_VENDORS, type SttVendorOptions } from './registry';
import {
  SttConnectError,
  type SttEvent,
  type SttStream,
  type SttStreamSettings,
} from './SpeechToText';
import { CONFORMANCE_VENDORS, type ConformanceVendor } from './testing/conformanceVendors';
import {
  type FakeVendorConnection,
  FakeVendorServer,
  manualClock,
  SilentTcpServer,
  waitFor,
} from './testing/fakeVendorServer';

/**
 * The contract every network speech-to-text vendor must pass, run against each registered
 * vendor's own adapter (built through the registry) and a local fake that plays the vendor.
 * Vendors bill open sessions, so the heart of it is the leak check after every test: a socket the
 * adapter left open fails the suite, whichever test opened it.
 */

const logger = createLogger({ level: 'error', format: 'json', sink: () => undefined });
const CHUNK_100_MS = 3200;
const CLOSE_TIMEOUT_MS = 100;

/** A logger whose warning and error messages the test reads back. */
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

describe('the speech-to-text registry', () => {
  it('has a conformance entry for every network vendor', () => {
    const covered = new Set(CONFORMANCE_VENDORS.map((vendor) => vendor.provider));
    const missing = [...STT_VENDORS.keys()].filter(
      (provider) => !LOCAL_STT_PROVIDERS.has(provider) && !covered.has(provider),
    );
    expect(missing).toEqual([]);
  });

  it('builds every network vendor on the shared lifecycle', () => {
    for (const vendor of CONFORMANCE_VENDORS) {
      expect(create(vendor, { logger })).toBeInstanceOf(WebSocketSpeechToText);
    }
  });
});

/**
 * Registers a case only for the vendors it applies to (a keep-alive check for a vendor that sends
 * none), so a run reports no skipped tests: here a skip would only ever mean "not applicable".
 */
function itIf(applies: boolean) {
  return (name: string, fn: () => Promise<void>): void => {
    if (applies) it(name, fn);
  };
}

function create(vendor: ConformanceVendor, options: SttVendorOptions): WebSocketSpeechToText {
  const factory = STT_VENDORS.get(vendor.provider);
  if (factory === undefined) throw new Error(`${vendor.provider} is not in the registry`);
  const stt = factory(options);
  if (!(stt instanceof WebSocketSpeechToText)) {
    throw new Error(`${vendor.provider} does not run on the shared lifecycle`);
  }
  return stt;
}

describe.each(CONFORMANCE_VENDORS)('$provider conforms', (vendor) => {
  let server: FakeVendorServer;
  /** When false the fake vendor stays silent after the finish sequence. */
  let answersFinish: boolean;
  /** When false the fake vendor never sends its ready message. */
  let sendsReady: boolean;

  beforeEach(async () => {
    answersFinish = true;
    sendsReady = true;
    server = await FakeVendorServer.start();
    server.script = {
      onConnect: (connection) => {
        if (vendor.readyMessage !== null && sendsReady) {
          connection.socket.send(vendor.readyMessage);
        }
      },
      onText: (connection, text) => {
        if (answersFinish && text === vendor.finishMessages.at(-1)) {
          vendor.answerFinish(connection.socket);
        }
      },
    };
  });

  afterEach(async () => {
    try {
      // The point of the suite: whatever a test did, no vendor socket may stay open.
      await server.expectNoOpenSockets();
    } finally {
      await server.stop();
    }
  });

  function stt(options: Partial<SttVendorOptions> = {}): WebSocketSpeechToText {
    return create(vendor, {
      logger,
      baseUrl: server.baseUrl,
      connectTimeoutMs: 1_000,
      closeTimeoutMs: CLOSE_TIMEOUT_MS,
      ...options,
    });
  }

  async function open(
    adapter = stt(),
    settings: SttStreamSettings = vendor.settings,
  ): Promise<{ stream: SttStream; events: SttEvent[] }> {
    const stream = await adapter.openStream({ accessToken: 'token', settings, label: 'mic' });
    const events: SttEvent[] = [];
    stream.on((event) => events.push(event));
    return { stream, events };
  }

  function finishTexts(): string[] {
    return server.last().texts.filter((text) => vendor.finishMessages.includes(text));
  }

  it('opens only once the vendor is ready', async () => {
    let ready = (): void => undefined;
    server.script.onConnect = (connection) => {
      ready = () => {
        if (vendor.readyMessage !== null) connection.socket.send(vendor.readyMessage);
      };
    };
    let opened = false;
    const opening = open().then((result) => {
      opened = true;
      return result;
    });

    await waitFor(() => server.connections.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    // A vendor whose handshake is the ready signal is open by now; one that sends a message is not.
    expect(opened).toBe(vendor.readyMessage === null);
    ready();
    const { stream } = await opening;
    await stream.close();
  });

  it('forwards audio as the vendor expects, then stops with its finish sequence', async () => {
    server.script.onBinary = (connection, frame) => {
      if (frame === 1) connection.socket.send(vendor.finalMessage('hello there'));
    };
    // Room for the paced audio: a `realtime` vendor gets the second chunk 100 ms after ready, so
    // under the suite's 100 ms deadline its finish raced the cut, and a finish cut short is a
    // fatal error ("did not finish the stream"): the test failed now and then under load.
    const { stream, events } = await open(stt({ closeTimeoutMs: 2_000 }));

    stream.send(new Uint8Array(CHUNK_100_MS));
    stream.send(new Uint8Array(CHUNK_100_MS));
    await waitFor(() => events.some((event) => event.type === 'final'));
    await stream.close();

    expect(server.last().binaryFrames).toEqual([CHUNK_100_MS, CHUNK_100_MS]);
    expect(finishTexts()).toEqual(vendor.finishMessages);
    expect(events.map((event) => event.type)).toEqual(['final', 'closed']);
    expect(events[0]).toMatchObject({ type: 'final', text: 'hello there' });
    await waitFor(() => server.last().closed);
  });

  it('finishes on the completion signal its protocol declares', async () => {
    const adapter = stt();
    let vendorClosed: boolean | null = null;
    server.script.onText = (connection, text) => {
      if (text !== vendor.finishMessages.at(-1)) return;
      // The vendor's last line, then, a little later, its answer to the finish sequence.
      connection.socket.send(vendor.finalMessage('last words'));
      setTimeout(() => {
        vendor.answerFinish(connection.socket);
        vendorClosed = connection.socket.readyState !== WebSocket.OPEN;
      }, 30);
    };
    const { stream, events } = await open(adapter);

    await stream.close();

    // The fixture plays the real vendor: it must close the socket itself exactly when the adapter
    // declares 'vendor-close'. With 'finished-message' the core closes on the vendor's message.
    expect(vendorClosed).toBe(adapter.protocol.finishedOn === 'vendor-close');
    expect(events.map((event) => event.type)).toEqual(['final', 'closed']);
    expect(events[0]).toMatchObject({ type: 'final', text: 'last words' });
    // A graceful close, not the hard timeout's terminate (1006).
    expect(events[1]).toMatchObject({ type: 'closed', code: 1000 });
  });

  it('closes within the hard timeout even when the vendor never answers the finish', async () => {
    answersFinish = false;
    const { stream, events } = await open();

    const started = Date.now();
    await stream.close();

    expect(Date.now() - started).toBeLessThan(CLOSE_TIMEOUT_MS + 900);
    expect(finishTexts()).toEqual(vendor.finishMessages);
    // A finish the deadline cut short lost its last lines: one fatal error says so (M2-T6).
    expect(events.map((event) => event.type)).toEqual(['error', 'closed']);
    expect(events[0]).toMatchObject({ type: 'error', fatal: true });
    await waitFor(() => server.last().closed);
  });

  it('closes once however often close() is called', async () => {
    const { stream, events } = await open();

    await Promise.all([stream.close(), stream.close(), stream.close()]);
    await stream.close();

    expect(server.connections).toHaveLength(1);
    expect(finishTexts()).toEqual(vendor.finishMessages);
    expect(events.filter((event) => event.type === 'closed')).toHaveLength(1);
  });

  it('sends nothing after close: no audio, no keep-alive', async () => {
    const adapter = stt();
    const { stream } = await open(adapter);
    stream.send(new Uint8Array(CHUNK_100_MS));
    await stream.close();
    const sent = { frames: server.last().binaryFrames.length, texts: server.last().texts.length };

    stream.send(new Uint8Array(CHUNK_100_MS));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(server.last().binaryFrames).toHaveLength(sent.frames);
    expect(server.last().texts).toHaveLength(sent.texts);
    expect(adapter.usage().droppedChunks).toBe(1);
  });

  itIf(vendor.keepAliveMessage !== null)('sends its keep-alive only while open', async () => {
    const keepAlive = vendor.keepAliveMessage ?? '';
    const adapter = create(vendor, { logger, baseUrl: server.baseUrl, keepAliveMs: 10 });
    const { stream } = await open(adapter);

    await waitFor(() => server.last().texts.includes(keepAlive));
    await stream.close();
    const count = server.last().texts.filter((text) => text === keepAlive).length;
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(server.last().texts.filter((text) => text === keepAlive)).toHaveLength(count);
  });

  itIf(vendor.keepAliveMessage !== null)(
    'sends no keep-alive once no audio was sent for the keep-alive window',
    async () => {
      const keepAlive = vendor.keepAliveMessage ?? '';
      const clock = manualClock(0);
      const adapter = create(vendor, {
        logger,
        baseUrl: server.baseUrl,
        keepAliveMs: 10,
        keepAliveForMs: 1_000,
        clock: clock.now,
      });
      const { stream } = await open(adapter);
      const count = (): number => server.last().texts.filter((text) => text === keepAlive).length;
      await waitFor(() => count() > 0);

      clock.set(1_000);
      await new Promise((resolve) => setTimeout(resolve, 30));
      const stalled = count();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(count()).toBe(stalled);
      await stream.close();
    },
  );

  it('reports a vendor close mid-call as one fatal error, then closed', async () => {
    const { code, reason } = vendor.midCallClose;
    server.script.onBinary = (connection) => {
      connection.socket.close(code, reason);
    };
    const { stream, events } = await open();

    stream.send(new Uint8Array(CHUNK_100_MS));
    await waitFor(() => events.some((event) => event.type === 'closed'));

    expect(events.map((event) => event.type)).toEqual(['error', 'closed']);
    expect(events[0]).toMatchObject({ type: 'error', fatal: true });
    expect(events[0]?.type === 'error' && events[0].message).toContain(String(code));
    expect(events[1]).toEqual({ type: 'closed', code, reason });
    await stream.close(); // a no-op now
    expect(events).toHaveLength(2);
  });

  itIf(vendor.errorFrame !== null)(
    'reports a vendor error frame and the close after it as one error',
    async () => {
      const errorFrame = vendor.errorFrame ?? '';
      const { code, reason } = vendor.midCallClose;
      server.script.onBinary = (connection) => {
        connection.socket.send(errorFrame);
        connection.socket.close(code, reason);
      };
      const { stream, events } = await open();

      stream.send(new Uint8Array(CHUNK_100_MS));
      await waitFor(() => events.some((event) => event.type === 'closed'));

      expect(events.map((event) => event.type)).toEqual(['error', 'closed']);
    },
  );

  /**
   * CaptureSession closes a stream from inside its fatal error, synchronously (streamFailed →
   * retire → close()). Such a close must not start a finish on a session the vendor already ended.
   */
  describe('when the listener closes the stream on its fatal error', () => {
    function closeOnFatal(stream: SttStream): Promise<void>[] {
      const closes: Promise<void>[] = [];
      stream.on((event) => {
        if (event.type === 'error' && event.fatal) closes.push(stream.close());
      });
      return closes;
    }

    it('leaves no finish timer running after a vendor close mid-call', async () => {
      const { code, reason } = vendor.midCallClose;
      server.script.onBinary = (connection) => {
        connection.socket.close(code, reason);
      };
      const log = recordingLogger();
      const { stream, events } = await open(stt({ logger: log.logger }));
      const closes = closeOnFatal(stream);

      stream.send(new Uint8Array(CHUNK_100_MS));
      await waitFor(() => events.some((event) => event.type === 'closed'));
      await Promise.all(closes);
      await new Promise((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS + 50));

      expect(events.map((event) => event.type)).toEqual(['error', 'closed']);
      expect(log.warnings.filter((message) => message.includes('did not finish in time'))).toEqual(
        [],
      );
    });

    itIf(vendor.errorFrame !== null)(
      'closes at once after an error frame, with no finish sequence',
      async () => {
        const errorFrame = vendor.errorFrame ?? '';
        answersFinish = false;
        server.script.onBinary = (connection) => {
          connection.socket.send(errorFrame); // and leaves the socket open
        };
        const log = recordingLogger();
        const { stream, events } = await open(stt({ logger: log.logger }));
        const closes = closeOnFatal(stream);

        stream.send(new Uint8Array(CHUNK_100_MS));
        await waitFor(() => events.some((event) => event.type === 'closed'));
        await Promise.all(closes);

        expect(finishTexts()).toEqual([]);
        // Our close frame, answered, not the forced terminate at the finish deadline.
        expect(events.at(-1)).toEqual({ type: 'closed', code: 1000, reason: null });
        expect(
          log.warnings.filter((message) => message.includes('did not finish in time')),
        ).toEqual([]);
      },
    );
  });

  it('keeps going after a message it cannot read', async () => {
    server.script.onBinary = (connection) => {
      connection.socket.send('not json');
      connection.socket.send(vendor.finalMessage('still here'));
    };
    const { stream, events } = await open();

    stream.send(new Uint8Array(CHUNK_100_MS));
    await waitFor(() => events.some((event) => event.type === 'final'));

    expect(events[0]).toMatchObject({ type: 'error', fatal: false });
    await stream.close();
  });

  /**
   * The benchmark's wire tap (WebSocketSttOptions.wireTap): `bench run` stores its query in
   * run.json, `bench canary --save-wire` writes its messages as wire fixtures. It sees the wire as
   * the vendor does, both ways, and never the token, whether the vendor takes it in the URL
   * (AssemblyAI) or in a header (Deepgram): run.json and the fixtures are kept and committed.
   */
  it('shows the wire tap every message both ways and the query without the token', async () => {
    const token = 'temporary-token-dG9rZW4';
    const tapped: SttWireRecord[] = [];
    const sentByVendor: string[] = [];
    const vendorSends = (connection: FakeVendorConnection, text: string): void => {
      sentByVendor.push(text);
      connection.socket.send(text);
    };
    server.script = {
      onConnect: (connection) => {
        if (vendor.readyMessage !== null) vendorSends(connection, vendor.readyMessage);
      },
      onBinary: (connection, frame) => {
        if (frame === 1) vendorSends(connection, vendor.finalMessage('hello there'));
      },
      onText: (connection, text) => {
        if (text !== vendor.finishMessages.at(-1)) return;
        vendorSends(connection, vendor.finalMessage('last words'));
        connection.socket.close(1000);
      },
    };
    const stream = await stt({ wireTap: (record) => tapped.push(record) }).openStream({
      accessToken: token,
      settings: { ...vendor.settings, keyterms: ['Linkt'] },
      label: 'mic',
    });
    const events: SttEvent[] = [];
    stream.on((event) => events.push(event));

    stream.send(new Uint8Array(CHUNK_100_MS));
    await waitFor(() => events.some((event) => event.type === 'final'));
    await stream.close();

    const connection = server.last();
    // The token was on the wire, so its absence below means the tap was kept from it.
    expect(connection.url + JSON.stringify(connection.headers)).toContain(token);
    expect(JSON.stringify(tapped)).not.toContain(token);

    const connects = tapped.flatMap((record) => (record.kind === 'connect' ? [record] : []));
    expect(tapped[0]?.kind).toBe('connect');
    expect(connects).toHaveLength(1);
    const query = connects[0]?.query ?? '';
    const url = new URL(connection.url, 'ws://vendor');
    // The query as the vendor got it, its token parameter left out; never the host or the path.
    expect([...new URLSearchParams(query)]).toEqual(
      [...url.searchParams].filter(([, value]) => value !== token),
    );
    expect(query).not.toContain('://');
    expect(query).not.toContain(url.pathname);

    const texts = (direction: 'sent' | 'received'): string[] =>
      tapped.flatMap((record) =>
        record.kind === 'text' && record.direction === direction ? [record.text] : [],
      );
    const frames = tapped.flatMap((record) =>
      record.kind === 'binary' && record.direction === 'sent' ? [record.bytes] : [],
    );
    expect(texts('sent')).toEqual(connection.texts);
    expect(frames).toEqual(connection.binaryFrames);
    expect(texts('received')).toEqual(sentByVendor);
    expect(tapped.every((record) => record.label === 'mic')).toBe(true);
  });

  /**
   * A reopen hands the core a burst right after ready: the audio CaptureSession held while it
   * connected. A vendor that rejects audio faster than real time must get it paced; any other must
   * get it at once, or the burst becomes lag for nothing. On a manual pace clock: it decides what
   * may go, real timers only wake the queue.
   */
  describe('a burst right after ready', () => {
    const BURST_MS = 3_000;
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));
    const bytesPerMs = (vendor.settings.sampleRate * 2) / 1000;
    const receivedMs = (): number =>
      server.last().binaryFrames.reduce((sum, bytes) => sum + bytes, 0) / bytesPerMs;
    const largestFrameMs = (): number => Math.max(...server.last().binaryFrames) / bytesPerMs;

    function sendBurst(stream: SttStream): void {
      for (let sent = 0; sent < BURST_MS; sent += 100) stream.send(new Uint8Array(CHUNK_100_MS));
    }

    it(
      vendor.rejectsAudioFasterThanRealTime
        ? 'goes out no faster than real time, then all of it before the finish sequence'
        : 'goes out at once, then the finish sequence',
      async () => {
        const clock = manualClock(0);
        let receivedAtFinish: number | null = null;
        server.script.onText = (connection, text) => {
          if (text === vendor.finishMessages[0]) receivedAtFinish = receivedMs();
          if (text === vendor.finishMessages.at(-1)) vendor.answerFinish(connection.socket);
        };
        const { stream } = await open(stt({ paceClock: clock.now }));

        sendBurst(stream);

        if (vendor.rejectsAudioFasterThanRealTime) {
          for (const elapsedMs of [0, 1_000, 2_500]) {
            clock.set(elapsedMs);
            await waitFor(() => receivedMs() > elapsedMs);
            await settle();
            // Never ahead of the real time since ready by more than the one frame in flight.
            expect(receivedMs() - elapsedMs).toBeLessThanOrEqual(largestFrameMs());
          }
        } else {
          await waitFor(() => receivedMs() === BURST_MS); // the clock has not moved
        }
        clock.set(BURST_MS);
        await stream.close();

        // Nothing stayed queued: every byte went, and went before the finish sequence.
        expect(receivedAtFinish).toBeGreaterThanOrEqual(BURST_MS);
        expect(finishTexts()).toEqual(vendor.finishMessages);
      },
    );

    it('cannot hold the close past the hard timeout, and none of it is sent after', async () => {
      const clock = manualClock(0); // never moves: a paced burst can never drain
      const { stream, events } = await open(stt({ paceClock: clock.now }));
      sendBurst(stream);

      const started = Date.now();
      await stream.close();
      const sentAtClose = receivedMs();
      clock.set(60_000);
      await settle();

      expect(Date.now() - started).toBeLessThan(CLOSE_TIMEOUT_MS + 900);
      expect(events.filter((event) => event.type === 'closed')).toHaveLength(1);
      expect(receivedMs()).toBe(sentAtClose);
      expect(sentAtClose).toBe(vendor.rejectsAudioFasterThanRealTime ? 100 : BURST_MS);
    });

    itIf(vendor.rejectsAudioFasterThanRealTime)(
      'is not sent early when the wall clock steps forward',
      async () => {
        const wall = manualClock(0);
        const pace = manualClock(0); // never moves: no real time passes
        const { stream } = await open(stt({ clock: wall.now, paceClock: pace.now }));
        sendBurst(stream);
        await waitFor(() => receivedMs() > 0);

        wall.set(60_000); // an NTP step or a manual time change
        stream.send(new Uint8Array(CHUNK_100_MS)); // live audio wakes the queue on the new time
        await settle();

        expect(receivedMs()).toBeLessThanOrEqual(largestFrameMs());
        await stream.close();
      },
    );
  });

  /**
   * Dead-socket detection (M2-T6) against the vendor's fake, on a manual clock: real timers only
   * wake the check (every few ms here, every second in the app) and the clock decides what is due,
   * so a clock step of 1 s here is one of the app's checks. ws gets no prompt error when the Mac's
   * network goes down, so without this a dead socket swallows audio until TCP gives up.
   */
  describe('liveness', () => {
    const TICK_MS = 5;
    /** Long enough for several checks to run and for a frame to cross the loopback. */
    const ticks = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, TICK_MS * 6));

    function lively(
      clock: ReturnType<typeof manualClock>,
      options: Partial<SttVendorOptions> = {},
    ): WebSocketSpeechToText {
      return stt({
        clock: clock.now,
        paceClock: clock.now,
        liveness: { pingIntervalMs: TICK_MS },
        ...options,
      });
    }

    it('pings only while audio flows', async () => {
      const clock = manualClock(0);
      const { stream } = await open(lively(clock, { keepAliveForMs: 1_000 }));
      await ticks();
      expect(server.last().pings).toBe(0);

      stream.send(new Uint8Array(CHUNK_100_MS));
      await waitFor(() => server.last().pings > 0);

      clock.set(1_000); // nothing sent for the keep-alive window
      await ticks();
      const stalled = server.last().pings;
      await ticks();
      expect(server.last().pings).toBe(stalled);
      await stream.close();
    });

    it.each([0, 400, 999])(
      'declares a socket that stops answering dead at most 5 s after its last pong (check phase %i ms)',
      async (phaseMs) => {
        const clock = manualClock(0);
        const { stream, events } = await open(lively(clock, { keepAliveForMs: 60_000 }));
        stream.send(new Uint8Array(CHUNK_100_MS));
        await waitFor(() => server.last().pings > 0);
        await ticks(); // the last pongs are back, all at clock 0
        server.last().answersPings = false;

        let deadAtMs: number | null = null;
        for (let atMs = phaseMs; atMs <= 6_000 && deadAtMs === null; atMs += 1_000) {
          clock.set(atMs);
          await ticks();
          if (events.length > 0) deadAtMs = atMs;
        }

        expect(deadAtMs).toBeGreaterThanOrEqual(4_000);
        expect(deadAtMs).toBeLessThanOrEqual(5_000);
        await waitFor(() => events.some((event) => event.type === 'closed'));
        expect(events.map((event) => event.type)).toEqual(['error', 'closed']);
        expect(events[0]).toMatchObject({ type: 'error', fatal: true });
        // Terminated, with no finish sequence sent into a dead connection.
        expect(finishTexts()).toEqual([]);
        await waitFor(() => server.last().closed);
      },
    );

    it('falls back after 10 s when the vendor never answers a ping, says so, and stays open', async () => {
      server.answersPings = false;
      const clock = manualClock(0);
      const log = recordingLogger();
      const { stream, events } = await open(lively(clock, { logger: log.logger }));
      stream.send(new Uint8Array(CHUNK_100_MS));
      await waitFor(() => server.last().pings > 0);

      for (const atMs of [4_000, 9_999]) {
        clock.set(atMs);
        await ticks();
      }
      expect(events).toEqual([]);

      clock.set(10_000);
      await ticks();
      clock.set(20_000);
      stream.send(new Uint8Array(CHUNK_100_MS));
      await ticks();

      expect(events).toEqual([]);
      expect(log.warnings).toContain(
        'stt vendor answers no ping: no dead-socket check on this stream until it does',
      );
      await stream.close();
    });

    it('keeps the check on a later stream of a vendor that answered pings, from its first ping', async () => {
      const clock = manualClock(0);
      const adapter = lively(clock);
      const earlier = await open(adapter);
      earlier.stream.send(new Uint8Array(CHUNK_100_MS));
      await waitFor(() => server.last().pings > 0);
      await ticks(); // its pongs are back
      await earlier.stream.close();

      // This stream's upstream dropped before its first pong: the adapter knows the vendor answers.
      server.answersPings = false;
      const { stream, events } = await open(adapter);
      stream.send(new Uint8Array(CHUNK_100_MS));
      await waitFor(() => server.last().pings > 0);
      clock.set(5_000);
      await waitFor(() => events.some((event) => event.type === 'closed'));

      expect(events.map((event) => event.type)).toEqual(['error', 'closed']);
      expect(events[0]).toMatchObject({ type: 'error', fatal: true });
      await waitFor(() => server.last().closed);
    });

    it('terminates at once when the network is gone: no finish sequence, no fatal error', async () => {
      answersFinish = false; // a finish would wait out the hard timeout
      const { stream, events } = await open(stt({ closeTimeoutMs: 5_000 }));
      stream.send(new Uint8Array(CHUNK_100_MS));
      await waitFor(() => server.last().binaryFrames.length > 0);
      expect('terminate' in stream).toBe(true);

      const started = Date.now();
      await stream.terminate?.();

      expect(Date.now() - started).toBeLessThan(1_000);
      expect(finishTexts()).toEqual([]);
      expect(events.map((event) => event.type)).toEqual(['closed']);
      await waitFor(() => server.last().closed);
    });
  });

  it('meters sessions, connected time and audio on its clock', async () => {
    const clock = manualClock(0);
    // Paced on the same clock: 60 s after ready, the 300 ms below goes at once.
    const adapter = stt({ clock: clock.now, paceClock: clock.now });

    const mic = await open(adapter);
    const system = await open(adapter);
    clock.set(60_000);
    for (let chunk = 0; chunk < 3; chunk += 1) mic.stream.send(new Uint8Array(CHUNK_100_MS));
    await mic.stream.close();
    clock.set(90_000);
    await system.stream.close();
    clock.set(600_000); // both closed: the meter stopped

    const usage = adapter.usage();
    expect(usage).toMatchObject({
      sessionsOpened: 2,
      connectedMs: 60_000 + 90_000,
      audioSentMs: 300,
      droppedChunks: 0,
    });
    // Open time at the API's price per stream-hour, which is what AssemblyAI bills.
    const price = vendor.settings.pricePerHourUsd ?? Number.NaN;
    // Rounded to 1/10000 USD, so within half of that of the exact figure.
    expect(usage.estimatedCostUsd).toBeCloseTo((150_000 / 3_600_000) * price, 3);
  });

  /**
   * The jargon list: the core cuts it to the shared limits, the protocol maps it, and a connect the
   * vendor refuses over it is reported as keytermsRejected after one handshake, its socket closed.
   * The one reopen without the list is CaptureSession's, through the open budget (M3-T4b); an
   * adapter or core that retried would open billed sessions the budget never saw (house rule 9).
   */
  describe('with a jargon list', () => {
    const LIST = ['Linkt', 'order number'];

    function keyterms(): NonNullable<ConformanceVendor['keyterms']> {
      if (vendor.keyterms === null) throw new Error(`${vendor.provider} takes no jargon list`);
      return vendor.keyterms;
    }

    function refuseAsTheVendorDoes(): void {
      const { refusal } = keyterms();
      if ('httpStatus' in refusal) {
        server.rejectWith = refusal.httpStatus;
        return;
      }
      server.script.onConnect = (connection) => {
        connection.socket.close(refusal.closeBeforeReady.code, refusal.closeBeforeReady.reason);
      };
    }

    it('declares keytermsRejected exactly when its entry says how it refuses a list', () => {
      expect(stt().protocol.keytermsRejected !== undefined).toBe(vendor.keyterms !== null);
    });

    itIf(vendor.keyterms !== null)(
      'sends the list cut to the shared limits, and none without one',
      async () => {
        const long = Array.from({ length: KEYTERM_LIMITS.maxTerms + 20 }, (_, i) => `Term${i}`);
        const withList = await open(stt(), { ...vendor.settings, keyterms: long });
        await withList.stream.close();
        expect(keyterms().sent(server.last())).toEqual(long.slice(0, KEYTERM_LIMITS.maxTerms));

        const without = await open();
        await without.stream.close();
        expect(keyterms().sent(server.last())).toEqual([]);
      },
    );

    itIf(vendor.keyterms !== null)(
      'reports a connect refused for its list as keytermsRejected, after exactly one handshake',
      async () => {
        refuseAsTheVendorDoes();
        const error = await open(stt(), { ...vendor.settings, keyterms: LIST }).catch(
          (e: unknown) => e,
        );

        expect(error).toBeInstanceOf(SttConnectError);
        expect((error as SttConnectError).keytermsRejected).toBe(true);
        await server.expectNoOpenSockets();
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(server.handshakes).toBe(1);
      },
    );

    itIf(vendor.keyterms !== null)(
      'reports the same refusal without a list as a plain connect error',
      async () => {
        refuseAsTheVendorDoes();
        const error = await open().catch((e: unknown) => e);

        expect(error).toBeInstanceOf(SttConnectError);
        expect((error as SttConnectError).keytermsRejected).toBe(false);
        expect(server.handshakes).toBe(1);
      },
    );
  });

  describe('a failed connect leaves no socket open', () => {
    it('when the vendor refuses the handshake', async () => {
      server.rejectWith = 401;
      const adapter = stt();
      const error = await open(adapter).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(SttConnectError);
      expect((error as SttConnectError).statusCode).toBe(401);
      expect(adapter.usage().sessionsOpened).toBe(0);
    });

    it('when the handshake never completes', async () => {
      const silent = await SilentTcpServer.start();
      try {
        const adapter = create(vendor, { logger, baseUrl: silent.baseUrl, connectTimeoutMs: 60 });
        const error = await open(adapter).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(SttConnectError);
        await waitFor(() => silent.sockets.length === 1 && silent.openSockets() === 0);
      } finally {
        await silent.stop();
      }
    });

    // A vendor whose handshake is its ready signal has no separate ready message to withhold.
    itIf(vendor.readyMessage !== null)('when the vendor never says it is ready', async () => {
      sendsReady = false;
      const adapter = stt({ connectTimeoutMs: 60 });
      const error = await open(adapter).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(SttConnectError);
      await waitFor(() => server.last().closed);
      // It reached the handshake, so the vendor may bill it: it counts as a session.
      expect(adapter.usage().sessionsOpened).toBe(1);
    });

    itIf(vendor.readyMessage !== null)('when the vendor closes before it is ready', async () => {
      server.script.onConnect = (connection) => {
        connection.socket.close(1008, 'Unauthorized Connection: Invalid token');
      };
      const error = await open().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(SttConnectError);
      expect((error as SttConnectError).message).toContain('Invalid token');
    });

    // The ready message is tapped before it opens the stream, and openStream hands the stream over
    // only once open: no listener exists yet to hear a non-fatal error (SttConnection.tap).
    itIf(vendor.readyMessage !== null)('when the wire tap fails on the ready message', async () => {
      const adapter = stt({
        wireTap: (record) => {
          if (record.kind === 'text') throw new Error('disk full');
        },
      });
      const error = await open(adapter).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(SttConnectError);
      expect((error as SttConnectError).message).toBe(
        `${adapter.vendorName} wire tap failed: disk full`,
      );
      await waitFor(() => server.last().closed);
    });
  });
});
