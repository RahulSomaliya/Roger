import { describe, expect, it } from 'vitest';
import { DEFAULT_COST_GUARDS } from '../../src/main/costGuards';
import { createLogger } from '../../src/main/logger';
import { UnsupportedSttProviderError } from '../../src/main/stt/createSpeechToText';
import { FakeSpeechToText } from '../../src/main/stt/fake/FakeSpeechToText';
import type { SttVendorFactory, SttVendorOptions } from '../../src/main/stt/registry';
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
});
