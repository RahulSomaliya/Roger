import type { Logger } from '../logger';
import { STT_VENDORS } from './registry';
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

/** The API names the provider in its token response; the registry (registry.ts) has its adapter. */
export function createSpeechToText(provider: string, deps: { logger: Logger }): SpeechToText {
  const create = STT_VENDORS.get(provider);
  if (create === undefined) throw new UnsupportedSttProviderError(provider);
  return create({ logger: deps.logger.child({ stt: provider }) });
}
