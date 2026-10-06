import type { TranscriptWord } from '../../shared/transcript';

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
  openStream(options: OpenStreamOptions): Promise<SttStream>;
}

export class SttConnectError extends Error {
  constructor(
    message: string,
    readonly statusCode: number | null = null,
  ) {
    super(message);
    this.name = 'SttConnectError';
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
