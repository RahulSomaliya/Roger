import { PCM_ENCODING, PCM_SAMPLE_RATE } from '../../shared/ipc';
import type { SttStreamSettings } from './SpeechToText';

/**
 * The renderer always sends PCM_SAMPLE_RATE Hz PCM_ENCODING audio (src/shared/ipc.ts). The API
 * names the format the vendor should expect, and a vendor told the wrong one returns nonsense
 * words with no error at all. Returns why the settings cannot work, naming both sides, or null.
 */
export function streamSettingsMismatch(settings: SttStreamSettings): string | null {
  if (settings.sampleRate === PCM_SAMPLE_RATE && settings.encoding === PCM_ENCODING) return null;
  return (
    `The API's speech-to-text settings ask for ${settings.sampleRate} Hz ${settings.encoding} ` +
    `audio, but Roger sends ${PCM_SAMPLE_RATE} Hz ${PCM_ENCODING}. Set ` +
    `STT_SAMPLE_RATE=${PCM_SAMPLE_RATE} and STT_ENCODING=${PCM_ENCODING} on the API.`
  );
}
