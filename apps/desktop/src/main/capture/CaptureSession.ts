import { randomUUID } from 'node:crypto';
import type { SttStreamState } from '../../shared/capture';
import {
  AUDIO_SOURCES,
  SPEAKER_FOR_SOURCE,
  type AudioSource,
  type InterimTranscript,
  type TranscriptSegment,
} from '../../shared/transcript';
import { errorMessage, type Logger } from '../logger';
import type { TranscriptStore } from '../store/TranscriptStore';
import type { SpeechToText, SttEvent, SttStream, SttStreamSettings } from '../stt/SpeechToText';

export interface CaptureSessionListeners {
  onSegment(segment: TranscriptSegment): void;
  onInterim(interim: InterimTranscript): void;
  onStreamState(source: AudioSource, state: SttStreamState): void;
}

export interface CaptureSessionOptions {
  meetingId: string;
  /** Epoch ms of the meeting start; all offsets are relative to it. */
  meetingStartedAtMs: number;
  stt: SpeechToText;
  accessToken: string;
  settings: SttStreamSettings;
  store: TranscriptStore;
  logger: Logger;
  listeners: CaptureSessionListeners;
  clock?: () => number;
}

/**
 * One meeting's live pipeline: one speech-to-text stream per audio source, finals written to the
 * local store the moment they arrive (house rule 1), interims passed straight to the UI.
 */
export class CaptureSession {
  readonly meetingId: string;
  private readonly streams = new Map<AudioSource, SttStream>();
  private readonly firstChunkOffsetMs = new Map<AudioSource, number>();
  private readonly clock: () => number;
  private segmentsStored = 0;

  constructor(private readonly options: CaptureSessionOptions) {
    this.meetingId = options.meetingId;
    this.clock = options.clock ?? (() => Date.now());
  }

  get storedSegmentCount(): number {
    return this.segmentsStored;
  }

  /** Open every stream. If one fails, the others are closed and the error is rethrown. */
  async open(): Promise<void> {
    try {
      await Promise.all(AUDIO_SOURCES.map((source) => this.openStream(source)));
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  pushAudio(source: AudioSource, pcm: Uint8Array): void {
    const stream = this.streams.get(source);
    if (!stream) return;
    if (!this.firstChunkOffsetMs.has(source)) {
      // The vendor's clock starts at its first audio byte; remember where that falls in the meeting.
      this.firstChunkOffsetMs.set(
        source,
        Math.max(0, this.clock() - this.options.meetingStartedAtMs),
      );
    }
    stream.send(pcm);
  }

  async close(): Promise<void> {
    const streams = [...this.streams.entries()];
    this.streams.clear();
    const results = await Promise.allSettled(streams.map(([, stream]) => stream.close()));
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        this.options.logger.warn('stream close failed', {
          source: streams[index]?.[0],
          error: errorMessage(result.reason),
        });
      }
    });
  }

  private async openStream(source: AudioSource): Promise<void> {
    const { listeners, stt, accessToken, settings } = this.options;
    listeners.onStreamState(source, 'connecting');
    try {
      const stream = await stt.openStream({ accessToken, settings, label: source });
      stream.on((event) => {
        this.handleEvent(source, event);
      });
      this.streams.set(source, stream);
      listeners.onStreamState(source, 'open');
    } catch (error) {
      listeners.onStreamState(source, 'error');
      throw error;
    }
  }

  private handleEvent(source: AudioSource, event: SttEvent): void {
    const offset = this.firstChunkOffsetMs.get(source) ?? 0;
    switch (event.type) {
      case 'final': {
        const segment: TranscriptSegment = {
          id: randomUUID(),
          meetingId: this.meetingId,
          source,
          speaker: SPEAKER_FOR_SOURCE[source],
          startMs: offset + event.startMs,
          endMs: offset + event.endMs,
          text: event.text,
          confidence: event.confidence,
          words: event.words.map((word) => ({
            ...word,
            startMs: offset + word.startMs,
            endMs: offset + word.endMs,
          })),
          createdAt: new Date(this.clock()).toISOString(),
        };
        this.options.store.appendSegment(segment);
        this.segmentsStored += 1;
        this.options.listeners.onSegment(segment);
        return;
      }
      case 'interim':
        this.options.listeners.onInterim({
          meetingId: this.meetingId,
          source,
          text: event.text,
          startMs: offset + event.startMs,
          endMs: offset + event.endMs,
        });
        return;
      case 'error':
        this.options.logger.error('speech-to-text error', {
          source,
          message: event.message,
          fatal: event.fatal,
        });
        if (event.fatal) this.options.listeners.onStreamState(source, 'error');
        return;
      case 'closed':
        this.options.logger.info('speech-to-text stream closed', {
          source,
          code: event.code,
          reason: event.reason,
        });
        if (this.streams.has(source)) this.options.listeners.onStreamState(source, 'closed');
    }
  }
}
