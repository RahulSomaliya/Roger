import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
};

/** Ready on the handshake; the vendor closes the socket when it reads the finish message. */
function protocol(baseUrl: string): SttProtocol {
  return {
    provider: 'toy',
    vendorName: 'Toy',
    readyOn: 'socket-open',
    finishedOn: 'vendor-close',
    keepAlive: null,
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

  it('names its provider after the protocol', () => {
    expect(new WebSocketSpeechToText(protocol(vendor.baseUrl), { logger }).provider).toBe('toy');
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
    });
    await system.close();
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
