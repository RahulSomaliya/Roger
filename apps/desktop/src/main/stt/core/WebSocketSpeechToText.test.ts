import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../logger';
import { SttConnectError, type SttStreamSettings } from '../SpeechToText';
import { FakeVendorServer, manualClock } from '../testing/fakeVendorServer';
import type { SttProtocol } from './SttProtocol';
import { WebSocketSpeechToText } from './WebSocketSpeechToText';

const logger = createLogger({ level: 'error', format: 'json', sink: () => undefined });
const settings: SttStreamSettings = {
  model: 'toy-1',
  language: 'en',
  sampleRate: 16000,
  encoding: 'linear16',
  pricePerHourUsd: 0.15,
};

/** Ready on the handshake; the vendor closes the socket when it reads the finish message. */
function protocol(baseUrl: string): SttProtocol {
  return {
    provider: 'toy',
    vendorName: 'Toy',
    readyOn: 'socket-open',
    finishedOn: 'vendor-close',
    keepAlive: null,
    audioPacing: 'none',
    credentialUse: 'reusable',
    target: () => ({ url: `${baseUrl}/listen`, headers: {} }),
    session: () => ({
      encodeAudio: (pcm) => [pcm],
      finishSequence: () => ['finish'],
      read: () => ({ kind: 'ignored', messageType: 'any' }),
      release: () => [],
    }),
    describeClose: (code) => `code ${code}`,
    connectAdvice: () => null,
  };
}

describe('WebSocketSpeechToText', () => {
  let vendor: FakeVendorServer;

  beforeEach(async () => {
    vendor = await FakeVendorServer.start();
    vendor.script = {
      onText: (connection, text) => {
        if (text === 'finish') connection.socket.close(1000);
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

  it('names its provider and vendor after the protocol', () => {
    const stt = new WebSocketSpeechToText(protocol(vendor.baseUrl), { logger });
    expect(stt.provider).toBe('toy');
    expect(stt.vendorName).toBe('Toy');
  });

  it('meters every session it opened, live and closed, on its clock', async () => {
    const clock = manualClock(0);
    const stt = new WebSocketSpeechToText(protocol(vendor.baseUrl), { logger, clock: clock.now });

    const mic = await stt.openStream({ accessToken: 't', settings, label: 'mic' });
    clock.set(1_000);
    const system = await stt.openStream({ accessToken: 't', settings, label: 'system' });
    mic.send(new Uint8Array(3200));
    system.send(new Uint8Array(6400));
    clock.set(10_000);
    await mic.close();
    clock.set(20_000);

    expect(stt.usage()).toEqual({
      sessionsOpened: 2,
      connectedMs: 10_000 + 19_000,
      audioSentMs: 300,
      droppedChunks: 0,
      // 29 s of open streams at $0.15 an hour each.
      estimatedCostUsd: 0.0012,
    });
    expect(stt.usage('system')).toEqual({
      sessionsOpened: 1,
      connectedMs: 19_000,
      audioSentMs: 200,
      droppedChunks: 0,
      estimatedCostUsd: 0.0008,
    });
    await system.close();
  });

  it('prices each session at the price it was opened with, and says unknown when one has none', async () => {
    const clock = manualClock(0);
    const stt = new WebSocketSpeechToText(protocol(vendor.baseUrl), { logger, clock: clock.now });

    const first = await stt.openStream({ accessToken: 't', settings, label: 'mic' });
    const pricier = { ...settings, pricePerHourUsd: 0.45 };
    const second = await stt.openStream({ accessToken: 't', settings: pricier, label: 'mic' });
    clock.set(3_600_000);
    await first.close();
    await second.close();
    expect(stt.usage('mic').estimatedCostUsd).toBe(0.6);

    const unpriced = { ...settings, pricePerHourUsd: null };
    const third = await stt.openStream({ accessToken: 't', settings: unpriced, label: 'mic' });
    await third.close();
    expect(stt.usage('mic').estimatedCostUsd).toBeNull();
    expect(stt.usage('system')).toEqual({
      sessionsOpened: 0,
      connectedMs: 0,
      audioSentMs: 0,
      droppedChunks: 0,
      estimatedCostUsd: 0,
    });
  });

  it('paces on a monotonic clock by default, so a wall-clock step forward sends no burst', async () => {
    const stt = new WebSocketSpeechToText(
      { ...protocol(vendor.baseUrl), audioPacing: 'realtime' },
      { logger, closeTimeoutMs: 100 },
    );
    const stream = await stt.openStream({ accessToken: 't', settings, label: 'mic' });

    // An NTP step or a manual time change: the wall clock jumps a minute ahead, real time does not.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
    try {
      for (let chunk = 0; chunk < 30; chunk += 1) stream.send(new Uint8Array(3200));
      await new Promise((resolve) => setTimeout(resolve, 50));
      // At 1x about 50 ms of it may have gone, plus the frame in flight: not the 3 s burst.
      expect(stt.usage().audioSentMs).toBeLessThan(1_000);
    } finally {
      vi.restoreAllMocks();
    }
    await stream.close();
  });

  it('counts a refused handshake as no session', async () => {
    vendor.rejectWith = 401;
    const stt = new WebSocketSpeechToText(protocol(vendor.baseUrl), { logger });

    await expect(stt.openStream({ accessToken: 't', settings, label: 'mic' })).rejects.toThrow(
      SttConnectError,
    );
    expect(stt.usage().sessionsOpened).toBe(0);
  });
});
