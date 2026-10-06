import { PCM_ENCODING, PCM_SAMPLE_RATE } from '../../shared/ipc';
import type { SttStreamSettings } from './SpeechToText';

/**
 * The renderer always sends PCM_SAMPLE_RATE Hz PCM_ENCODING audio (src/shared/ipc.ts). The API
 * names the format the vendor should expect, and a vendor told the wrong one returns nonsense
 * words with no error at all. Returns why the settings cannot work, naming both sides, or null.
 *
 * `encoding` is the app's own name for its audio, `linear16`, for every vendor: the API never sends
 * a vendor's term, and each protocol translates it. AssemblyAI's turns it into `pcm_s16le`
 * (buildStreamingUrl) and refuses any other value; Deepgram's term is the same word, so its
 * protocol passes it on. That keeps this check to one rule. Never relax it to take a vendor's term:
 * AssemblyAI's protocol would refuse it at the connect instead of here, and Deepgram would be sent
 * a name it does not know.
 */
export function streamSettingsMismatch(settings: SttStreamSettings): string | null {
  if (settings.sampleRate === PCM_SAMPLE_RATE && settings.encoding === PCM_ENCODING) return null;
  return (
    `The API's speech-to-text settings ask for ${settings.sampleRate} Hz ${settings.encoding} ` +
    `audio, but Roger sends ${PCM_SAMPLE_RATE} Hz ${PCM_ENCODING}. Set ` +
    `STT_SAMPLE_RATE=${PCM_SAMPLE_RATE} and STT_ENCODING=${PCM_ENCODING} on the API.`
  );
}
