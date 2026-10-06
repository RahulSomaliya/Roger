import type { TranscriptWord } from '../../shared/transcript';
import type { SttUsage } from './usage';

/**
 * The one small interface every speech-to-text vendor sits behind (house rule 4).
 * Callers only ever see `SttEvent`s; vendor wire formats stay inside the adapter.
 */

export interface SttStreamSettings {
  model: string;
  language: string;
  sampleRate: number;
  encoding: string;
  /**
   * USD per hour of this one stream while it is open, from the API (vendor prices stay
   * server-side). Null when the API knows no price. Only used to estimate cost in logs.
   */
  pricePerHourUsd: number | null;
  /**
   * The workspace's jargon list, so the vendor spells those words right. Missing means none.
   * SttConnection cuts it to the shared limits (keyterms.ts) before the protocol maps it to the
   * vendor's parameter; a vendor that refuses it fails the connect with
   * SttConnectError.keytermsRejected.
   */
  keyterms?: readonly string[];
}

export interface OpenStreamOptions {
  /** Short-lived credential handed out by the API. May be empty for the fake adapter. */
  accessToken: string;
  settings: SttStreamSettings;
  /** Free text for logs, for example "mic" or "system". */
  label: string;
}

export type SttEvent =
  | { type: 'interim'; text: string; startMs: number; endMs: number }
  | {
      type: 'final';
      text: string;
      startMs: number;
      endMs: number;
      confidence: number | null;
      words: TranscriptWord[];
    }
  | { type: 'error'; message: string; fatal: boolean }
  | { type: 'closed'; code: number | null; reason: string | null };

export type SttEventListener = (event: SttEvent) => void;

export interface SttStream {
  /** Send Int16 little-endian mono PCM at `settings.sampleRate`. Safe to call before open completes. */
  send(pcm: Uint8Array): void;
  /** Flush pending audio, collect the last finals and close. Resolves once the stream is closed. */
  close(): Promise<void>;
  on(listener: SttEventListener): () => void;
}

export interface SpeechToText {
  readonly provider: string;
  /** For people: the status line and error text, e.g. "AssemblyAI". */
  readonly vendorName: string;
  openStream(options: OpenStreamOptions): Promise<SttStream>;
  /**
   * What every session this adapter opened has used so far (live ones up to now), or only those
   * opened with this `label` (one audio source). The cost guards and the status line read it.
   */
  usage(label?: string): SttUsage;
}

export class SttConnectError extends Error {
  /**
   * The vendor refused the connect over the jargon list (SttProtocol.keytermsRejected). The core
   * set it with the socket already closed and did not retry. CaptureSession reopens that source
   * once without keyterms, through SttOpenBudget like any open (M3-T4b); a retry anywhere else, an
   * adapter's or a loop's, would open billed sessions the budget never saw (house rule 9).
   */
  readonly keytermsRejected: boolean;

  constructor(
    message: string,
    readonly statusCode: number | null = null,
    options: { keytermsRejected?: boolean } = {},
  ) {
    super(message);
    this.name = 'SttConnectError';
    this.keytermsRejected = options.keytermsRejected ?? false;
  }
}

/** Small listener set reused by adapters. */
export class SttEventEmitter {
  private readonly listeners = new Set<SttEventListener>();

  on(listener: SttEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: SttEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
