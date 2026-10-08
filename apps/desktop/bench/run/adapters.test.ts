import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_COST_GUARDS } from '../../src/main/costGuards';
import { createLogger } from '../../src/main/logger';
import { UnsupportedSttProviderError } from '../../src/main/stt/createSpeechToText';
import { FakeSpeechToText } from '../../src/main/stt/fake/FakeSpeechToText';
import type { SttVendorFactory, SttVendorOptions } from '../../src/main/stt/registry';
import { FakeVendorServer } from '../../src/main/stt/testing/fakeVendorServer';
import { XaiSpeechToText } from '../../src/main/stt/xai/XaiSpeechToText';
import { type BenchWireRecord, registryAdapters } from './adapters';

const logger = createLogger({ level: 'error', format: 'json', sink: () => undefined });

describe('registryAdapters', () => {
  it("builds the adapter the desktop's registry has for the token's provider", () => {
    const adapters = registryAdapters({ logger, guards: DEFAULT_COST_GUARDS });

    const stt = adapters('fake', () => undefined);

    expect(stt).toBeInstanceOf(FakeSpeechToText);
    expect(stt.provider).toBe('fake');
  });

  it('refuses a provider the registry does not have, own keys only', () => {
    const adapters = registryAdapters({ logger, guards: DEFAULT_COST_GUARDS });

    expect(() => adapters('whisper', () => undefined)).toThrow(UnsupportedSttProviderError);
    expect(() => adapters('constructor', () => undefined)).toThrow(UnsupportedSttProviderError);
  });

  it("passes the app's cost guards and the bench's wire tap to the vendor", () => {
    const calls: SttVendorOptions[] = [];
    const factory: SttVendorFactory = (options) => {
      calls.push(options);
      return new FakeSpeechToText();
    };
    const seen: BenchWireRecord[] = [];
    const adapters = registryAdapters({
      logger,
      guards: { sttStallCloseMs: 30_000, sttVendorIdleTimeoutMs: 120_000 },
      vendors: new Map([['assemblyai', factory]]),
    });

    adapters('assemblyai', (record) => seen.push(record));

    const options = calls[0];
    expect(options).toMatchObject({ keepAliveForMs: 30_000, vendorIdleTimeoutMs: 120_000 });
    // Read by name: the field is M3-T5's (WebSocketSttOptions.wireTap), typed there.
    const tap: unknown = options === undefined ? undefined : Reflect.get(options, 'wireTap');
    expect(typeof tap).toBe('function');
    if (typeof tap === 'function') {
      Reflect.apply(tap, undefined, [
        { kind: 'connect', label: 'mic', query: 'sample_rate=16000' },
      ]);
    }
    expect(seen).toEqual([{ kind: 'connect', label: 'mic', query: 'sample_rate=16000' }]);
  });

  describe('the xAI vendor', () => {
    let server: FakeVendorServer | null = null;

    afterEach(async () => {
      await server?.stop();
      server = null;
    });

    it('comes from the registry like the others, so the bench needs no code of its own', () => {
      const stt = registryAdapters({ logger, guards: DEFAULT_COST_GUARDS })('xai', () => undefined);

      expect(stt).toBeInstanceOf(XaiSpeechToText);
      expect(stt.provider).toBe('xai');
    });

    it('taps the connect without the client secret, which travels in a header', async () => {
      const fake = await FakeVendorServer.start();
      server = fake;
      fake.script = {
        onConnect: (connection) => {
          connection.socket.send(JSON.stringify({ type: 'transcript.created' }));
        },
      };
      const seen: BenchWireRecord[] = [];
      const vendors = new Map<string, SttVendorFactory>([
        ['xai', (options) => new XaiSpeechToText({ ...options, baseUrl: fake.baseUrl })],
      ]);
      const stt = registryAdapters({ logger, guards: DEFAULT_COST_GUARDS, vendors })(
        'xai',
        (record) => seen.push(record),
      );

      const stream = await stt.openStream({
        accessToken: 'xai-client-secret.bench',
        settings: {
          model: 'grok-voice-transcribe-2.0',
          language: 'en',
          sampleRate: 16000,
          encoding: 'linear16',
          pricePerHourUsd: 0.2,
        },
        label: 'mic',
      });
      await stream.terminate?.();

      expect(seen[0]).toMatchObject({ kind: 'connect', label: 'mic' });
      expect(JSON.stringify(seen)).not.toContain('xai-client-secret.bench');
      expect(fake.last().headers.authorization).toBe('Bearer xai-client-secret.bench');
    });
  });
});
