import { PCM_ENCODING, PCM_SAMPLE_RATE } from '../../shared/ipc';
import type { SttTokenApi } from '../api/ApiClient';
import type { StreamCredentials } from '../capture/CaptureSession';
import type { SttStreamSettings } from '../stt/SpeechToText';
import { streamSettingsMismatch } from '../stt/streamSettings';

/** A re-run session's credentials, and the vendor they are for. */
export interface RerunCredentials extends StreamCredentials {
  provider: string;
  pricePerHourUsdWithoutKeyterms: number | null;
}

/**
 * The fake provider's settings: it needs no token and bills nothing. The twin of CaptureService's
 * private FAKE_STREAM_SETTINGS, which this task may not edit (M2-T16): change both together.
 */
const FAKE_STREAM_SETTINGS: SttStreamSettings = {
  model: 'fake',
  language: 'en',
  sampleRate: PCM_SAMPLE_RATE,
  encoding: PCM_ENCODING,
  pricePerHourUsd: 0,
  keyterms: [],
};

/**
 * How the gap re-run gets each session's credentials: a fresh token from the API per session, as a
 * recording's reopen does (CaptureService.resolveStt, private to that file), so the vendor is the
 * one the API names now and the jargon list is the one as edited since. With `sttProviderOverride`
 * "fake" (development, e2e), the fake adapter and no token. A token for another audio format is
 * refused before any open: the backup holds PCM_SAMPLE_RATE PCM_ENCODING, and a vendor told
 * another format transcribes garbage with no error (stt/streamSettings.ts).
 */
export function rerunCredentials(
  api: SttTokenApi,
  sttProviderOverride: string | null,
): () => Promise<RerunCredentials> {
  return async () => {
    if (sttProviderOverride === 'fake') {
      return {
        provider: 'fake',
        accessToken: '',
        settings: FAKE_STREAM_SETTINGS,
        pricePerHourUsdWithoutKeyterms: FAKE_STREAM_SETTINGS.pricePerHourUsd,
      };
    }
    const token = await api.getSttToken();
    const settings: SttStreamSettings = {
      model: token.stream.model,
      language: token.stream.language,
      sampleRate: token.stream.sample_rate,
      encoding: token.stream.encoding,
      // Missing from an older API: unknown, so the cost reads unknown, never NaN.
      pricePerHourUsd: token.stream.price_per_hour_usd ?? null,
      keyterms: token.stream.keyterms,
    };
    const mismatch = streamSettingsMismatch(settings);
    if (mismatch !== null) throw new Error(mismatch);
    return {
      provider: token.provider,
      accessToken: token.access_token,
      settings,
      pricePerHourUsdWithoutKeyterms: token.stream.price_per_hour_usd_without_keyterms ?? null,
    };
  };
}
