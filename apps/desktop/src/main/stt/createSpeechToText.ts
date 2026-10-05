import type { Logger } from '../logger';
import { DeepgramSpeechToText } from './deepgram/DeepgramSpeechToText';
import { FakeSpeechToText } from './fake/FakeSpeechToText';
import type { SpeechToText } from './SpeechToText';

export type SpeechToTextFactory = (provider: string) => SpeechToText;

export class UnsupportedSttProviderError extends Error {
  constructor(provider: string) {
    super(
      `Unsupported speech-to-text provider "${provider}". The API and desktop must agree on one.`,
    );
    this.name = 'UnsupportedSttProviderError';
  }
}

/** The API names the provider in its token response; this picks the matching adapter. */
export function createSpeechToText(provider: string, deps: { logger: Logger }): SpeechToText {
  switch (provider) {
    case 'deepgram':
      return new DeepgramSpeechToText({ logger: deps.logger.child({ stt: 'deepgram' }) });
    case 'fake':
      return new FakeSpeechToText();
    default:
      throw new UnsupportedSttProviderError(provider);
  }
}
