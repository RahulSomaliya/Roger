import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../logger';
import { WebSocketSpeechToText } from './core/WebSocketSpeechToText';
import { LOCAL_STT_PROVIDERS, STT_VENDORS, type SttVendorOptions } from './registry';
import { SttConnectError, type SttEvent, type SttStream } from './SpeechToText';
import { CONFORMANCE_VENDORS, type ConformanceVendor } from './testing/conformanceVendors';
import {
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

  async function open(adapter = stt()): Promise<{ stream: SttStream; events: SttEvent[] }> {
    const stream = await adapter.openStream({
      accessToken: 'token',
      settings: vendor.settings,
      label: 'mic',
    });
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
    const { stream, events } = await open();

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

  it('closes within the hard timeout even when the vendor never answers the finish', async () => {
    answersFinish = false;
    const { stream, events } = await open();

    const started = Date.now();
    await stream.close();

    expect(Date.now() - started).toBeLessThan(CLOSE_TIMEOUT_MS + 900);
    expect(finishTexts()).toEqual(vendor.finishMessages);
    expect(events.filter((event) => event.type === 'closed')).toHaveLength(1);
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

  it('meters sessions, connected time and audio on its clock', async () => {
    const clock = manualClock(0);
    const adapter = stt({ clock: clock.now });

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
  });
});
