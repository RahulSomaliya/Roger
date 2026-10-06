import type { SttTokenApi, SttTokenResponse } from '../../src/main/api/ApiClient';
import type { SttStreamSettings } from '../../src/main/stt/SpeechToText';
import { streamSettingsMismatch } from '../../src/main/stt/streamSettings';

/**
 * Credentials for the bench, from the local API like the app's (M3 design, "Benchmark
 * credentials"): every attempt at an item asks `POST /v1/stt/token` just before its streams open,
 * and both streams of the item share that token. A fresh token per attempt, never one per run: a
 * Deepgram grant only works at the handshake and lives 30 s, an AssemblyAI token at most 600 s, so
 * one token per run would fail every later item and disqualify a vendor over a tooling bug.
 */

/**
 * A problem every later item would hit too, so the run stops instead of retrying: the API now serves
 * another vendor or model, an audio format the bench does not send, or a provider the desktop has no
 * adapter for.
 */
export class RunStoppedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunStoppedError';
  }
}

export interface BenchCredentials {
  /** The vendor id, as the desktop's registry knows it (stt/registry.ts). */
  provider: string;
  model: string;
  accessToken: string;
  settings: SttStreamSettings;
}

/** What a run is labelled with: its first token's vendor and model, and the workspace's list. */
export interface RunLabel {
  provider: string;
  model: string;
  /** Scored for term recall either way, also when `--no-keyterms` leaves it off the streams. */
  terms: string[];
}

export class BenchCredentialSource {
  private first: RunLabel | null = null;

  constructor(
    private readonly api: SttTokenApi,
    private readonly options: { keyterms: boolean },
  ) {}

  /** Null until the first token arrived. */
  get label(): RunLabel | null {
    return this.first;
  }

  /**
   * One fresh token as stream credentials. A failed request rejects with the API's error, which the
   * item retries; a token every later item would also fail on rejects with RunStoppedError.
   */
  async fetch(): Promise<BenchCredentials> {
    const token = await this.api.getSttToken();
    const model = token.stream.model;
    if (this.first === null) {
      this.first = { provider: token.provider, model, terms: [...token.stream.keyterms] };
    } else if (this.first.provider !== token.provider || this.first.model !== model) {
      throw new RunStoppedError(
        `the API now serves ${token.provider} ${model}, but this run began on ` +
          `${this.first.provider} ${this.first.model}. Was it restarted with another ` +
          'STT_PROVIDER mid-run? A run measures one configuration: start it again.',
      );
    }
    const settings = streamSettings(token, this.options.keyterms);
    const mismatch = streamSettingsMismatch(settings);
    if (mismatch !== null) throw new RunStoppedError(mismatch);
    return { provider: token.provider, model, accessToken: token.access_token, settings };
  }
}

/** The token's stream settings, mapped as CaptureService.resolveStt maps them for the app. */
function streamSettings(token: SttTokenResponse, keyterms: boolean): SttStreamSettings {
  return {
    model: token.stream.model,
    language: token.stream.language,
    sampleRate: token.stream.sample_rate,
    encoding: token.stream.encoding,
    // Missing from an older API: unknown, so the report says "unknown", never "$NaN".
    pricePerHourUsd: token.stream.price_per_hour_usd ?? null,
    // `--no-keyterms` (run E) measures what the list is worth: the same streams without it.
    keyterms: keyterms ? token.stream.keyterms : [],
  };
}
