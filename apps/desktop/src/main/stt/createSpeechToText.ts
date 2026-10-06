import { type CostGuards, DEFAULT_COST_GUARDS } from '../costGuards';
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

export interface SpeechToTextDeps {
  logger: Logger;
  /** The cost guards an adapter applies itself (costGuards.ts). Defaults to the defaults. */
  guards?: Pick<CostGuards, 'sttStallCloseMs' | 'sttVendorIdleTimeoutMs'>;
}

/** The API names the provider in its token response; the registry (registry.ts) has its adapter. */
export function createSpeechToText(provider: string, deps: SpeechToTextDeps): SpeechToText {
  const create = STT_VENDORS.get(provider);
  if (create === undefined) throw new UnsupportedSttProviderError(provider);
  const guards = deps.guards ?? DEFAULT_COST_GUARDS;
  return create({
    logger: deps.logger.child({ stt: provider }),
    // A keep-alive past the stall window would bill a source that sends nothing.
    keepAliveForMs: guards.sttStallCloseMs,
    vendorIdleTimeoutMs: guards.sttVendorIdleTimeoutMs,
  });
}
