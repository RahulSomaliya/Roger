import { describe, expect, it, vi } from 'vitest';
import type { SttTokenResponse } from '../api/ApiClient';
import { rerunCredentials } from './rerunStt';

function token(overrides: Partial<SttTokenResponse['stream']> = {}): SttTokenResponse {
  return {
    provider: 'assemblyai',
    access_token: 'temporary',
    expires_in: 60,
    stream: {
      model: 'universal-streaming-english',
      language: 'en',
      sample_rate: 16_000,
      encoding: 'linear16',
      price_per_hour_usd: 0.15,
      price_per_hour_usd_without_keyterms: 0.12,
      keyterms: ['Roger'],
      ...overrides,
    },
  };
}

describe('rerunCredentials', () => {
  it("takes a fresh token from the API, as a recording's reopen does", async () => {
    const api = { getSttToken: vi.fn(() => Promise.resolve(token())) };
    await expect(rerunCredentials(api, null)()).resolves.toEqual({
      provider: 'assemblyai',
      accessToken: 'temporary',
      settings: {
        model: 'universal-streaming-english',
        language: 'en',
        sampleRate: 16_000,
        encoding: 'linear16',
        pricePerHourUsd: 0.15,
        keyterms: ['Roger'],
      },
      pricePerHourUsdWithoutKeyterms: 0.12,
    });
    expect(api.getSttToken).toHaveBeenCalledTimes(1);
  });

  it('asks the API for nothing with the fake provider (development and e2e)', async () => {
    const api = { getSttToken: vi.fn(() => Promise.resolve(token())) };
    await expect(rerunCredentials(api, 'fake')()).resolves.toMatchObject({
      provider: 'fake',
      accessToken: '',
      settings: { sampleRate: 16_000, encoding: 'linear16', pricePerHourUsd: 0 },
    });
    expect(api.getSttToken).not.toHaveBeenCalled();
  });

  it('refuses a token for audio the backup does not hold, before any open', async () => {
    const api = { getSttToken: () => Promise.resolve(token({ sample_rate: 48_000 })) };
    await expect(rerunCredentials(api, null)()).rejects.toThrow('48000 Hz');
  });
});
