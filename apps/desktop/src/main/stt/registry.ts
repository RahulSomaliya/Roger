import { AssemblyAiSpeechToText } from './assemblyai/AssemblyAiSpeechToText';
import type { WebSocketSttOptions } from './core/WebSocketSpeechToText';
import { DeepgramSpeechToText } from './deepgram/DeepgramSpeechToText';
import { FakeSpeechToText } from './fake/FakeSpeechToText';
import type { SpeechToText } from './SpeechToText';

export interface SttVendorOptions extends WebSocketSttOptions {
  /** The vendor's websocket origin. Tests point it at a local fake vendor. */
  baseUrl?: string;
  /**
   * Asks the vendor to close a session that receives nothing for this long, where it can
   * (AssemblyAI's `inactivity_timeout`; Deepgram has no such parameter and closes a quiet socket
   * after about 10 s on its own). The net for when Roger cannot close the session itself.
   */
  vendorIdleTimeoutMs?: number;
}

export type SttVendorFactory = (options: SttVendorOptions) => SpeechToText;

/**
 * Every speech-to-text provider the desktop can run, by the id the API names in /v1/stt/token
 * (the API's registry is apps/api/src/roger_api/stt_vendors.py; both must list the same ids).
 * Adding one: "Add a speech-to-text vendor" in apps/desktop/README.md. A network vendor added here
 * without an entry in testing/conformanceVendors.ts fails the conformance suite, so it cannot ship
 * without proving it closes its sockets.
 */
export const STT_VENDORS: ReadonlyMap<string, SttVendorFactory> = new Map<string, SttVendorFactory>(
  [
    ['assemblyai', (options) => new AssemblyAiSpeechToText(options)],
    ['deepgram', (options) => new DeepgramSpeechToText(options)],
    ['fake', () => new FakeSpeechToText()],
  ],
);

/** Providers that open no network connection, so the conformance suite has nothing to check. */
export const LOCAL_STT_PROVIDERS: ReadonlySet<string> = new Set(['fake']);
