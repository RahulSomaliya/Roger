import type { CostGuards } from '../../src/main/costGuards';
import type { Logger } from '../../src/main/logger';
import { UnsupportedSttProviderError } from '../../src/main/stt/createSpeechToText';
import {
  STT_VENDORS,
  type SttVendorFactory,
  type SttVendorOptions,
} from '../../src/main/stt/registry';
import type { SpeechToText } from '../../src/main/stt/SpeechToText';

/**
 * The bench measures the exact adapter code the app runs: every adapter comes from the desktop's
 * registry (stt/registry.ts) for the provider the token names, built with the app's cost guards, so
 * each session runs the same shared core (pacing, keep-alive, close) as a live meeting. Only the
 * bench adds the core's wire tap.
 */

/**
 * What the bench reads of one record of the core's wire tap: SttWireRecord in core/SttConnection.ts,
 * added by M3-T5 in the same wave as this file. Declared here as a looser shape of it (every
 * SttWireRecord fits), so this file type-checks before and after that change merges; the
 * controller may swap it for an import of SttWireRecord once both have. It holds transcript text:
 * it goes to the bench's files, never to a log line.
 */
export interface BenchWireRecord {
  /** `connect` (once per session, before the handshake), `text` or `binary`. */
  readonly kind: string;
  readonly label: string;
  /** `connect`: the URL's query with the token left out. Never the URL. */
  readonly query?: unknown;
  /** `text` and `binary`: `sent` or `received`. */
  readonly direction?: unknown;
  /** `text`: the message as it went or came. */
  readonly text?: unknown;
}

export type BenchWireTap = (record: BenchWireRecord) => void;

/** One adapter for one attempt at an item (or the canary), its wire tapped. */
export type BenchAdapterFactory = (provider: string, wireTap: BenchWireTap) => SpeechToText;

export interface RegistryAdapterDeps {
  logger: Logger;
  /** The guards an adapter applies itself, as createSpeechToText passes them in the app. */
  guards: Pick<CostGuards, 'sttStallCloseMs' | 'sttVendorIdleTimeoutMs'>;
  /** Tests only: the registry to build from. */
  vendors?: ReadonlyMap<string, SttVendorFactory>;
}

export function registryAdapters(deps: RegistryAdapterDeps): BenchAdapterFactory {
  const vendors = deps.vendors ?? STT_VENDORS;
  return (provider, wireTap) => {
    const create = vendors.get(provider);
    if (create === undefined) throw new UnsupportedSttProviderError(provider);
    // A variable, not a literal in the call: until M3-T5 adds `wireTap` to WebSocketSttOptions,
    // a literal would be refused for the extra field. createSpeechToText cannot pass a tap, so the
    // bench builds from the registry with the same options it gives.
    const options: SttVendorOptions & { wireTap: BenchWireTap } = {
      logger: deps.logger.child({ stt: provider }),
      // A keep-alive past the stall window would bill a source that sends nothing.
      keepAliveForMs: deps.guards.sttStallCloseMs,
      vendorIdleTimeoutMs: deps.guards.sttVendorIdleTimeoutMs,
      wireTap,
    };
    return create(options);
  };
}
