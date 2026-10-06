import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/main/api/ApiClient';
import { BenchCredentialSource, RunStoppedError } from './credentials';
import { ScriptedTokenApi, tokenResponse } from './testing/fakes';

describe('BenchCredentialSource', () => {
  it('maps the token to stream settings the way the app does', async () => {
    const source = new BenchCredentialSource(new ScriptedTokenApi(tokenResponse()), {
      keyterms: true,
    });

    const credentials = await source.fetch();

    expect(credentials).toEqual({
      provider: 'assemblyai',
      model: 'universal-streaming-english',
      accessToken: 'tok-1',
      settings: {
        model: 'universal-streaming-english',
        language: 'en',
        sampleRate: 16_000,
        encoding: 'linear16',
        // Left out by an older API: unknown, so the report says "unknown", never $NaN.
        pricePerHourUsd: null,
        keyterms: ['Linkt', 'Roger'],
      },
    });
    expect(source.label).toEqual({
      provider: 'assemblyai',
      model: 'universal-streaming-english',
      terms: ['Linkt', 'Roger'],
    });
  });

  it("carries the token's price per stream-hour", async () => {
    const source = new BenchCredentialSource(
      new ScriptedTokenApi(tokenResponse({ pricePerHourUsd: 0.19 })),
      { keyterms: true },
    );

    expect((await source.fetch()).settings.pricePerHourUsd).toBe(0.19);
  });

  it('sends no keyterms with --no-keyterms, and keeps the list for term recall', async () => {
    const source = new BenchCredentialSource(new ScriptedTokenApi(tokenResponse()), {
      keyterms: false,
    });

    const credentials = await source.fetch();

    expect(credentials.settings.keyterms).toEqual([]);
    expect(source.label?.terms).toEqual(['Linkt', 'Roger']);
  });

  it('stops the run, naming both, when a later token names another provider or model', async () => {
    const source = new BenchCredentialSource(
      new ScriptedTokenApi(
        tokenResponse(),
        tokenResponse({ model: 'universal-3-6-pro' }),
        tokenResponse({ provider: 'deepgram', model: 'nova-3' }),
      ),
      { keyterms: true },
    );
    await source.fetch();

    const modelChanged = source.fetch();
    await expect(modelChanged).rejects.toThrow(RunStoppedError);
    await expect(modelChanged).rejects.toThrow(
      'the API now serves assemblyai universal-3-6-pro, but this run began on assemblyai ' +
        'universal-streaming-english',
    );
    await expect(source.fetch()).rejects.toThrow(
      /now serves deepgram nova-3, but this run began on assemblyai universal-streaming-english/,
    );
  });

  it('stops the run when the token asks for audio the bench does not send', async () => {
    const source = new BenchCredentialSource(
      new ScriptedTokenApi(tokenResponse({ sampleRate: 48_000 })),
      { keyterms: true },
    );

    await expect(source.fetch()).rejects.toThrow(RunStoppedError);
  });

  it("passes a failed token request on as the API's error, for the item to retry", async () => {
    const failure = new ApiError(0, 'network_error', 'POST /v1/stt/token failed: timed out');
    const source = new BenchCredentialSource(new ScriptedTokenApi(failure), { keyterms: true });

    await expect(source.fetch()).rejects.toBe(failure);
    expect(source.label).toBeNull();
  });
});
