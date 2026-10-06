import { randomUUID } from 'node:crypto';
import { PCM_SAMPLE_RATE } from '../../shared/ipc';
import { pcmBytesToMs } from '../../shared/pcm';
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

export type SessionStreamState = 'connecting' | 'open' | 'closed';

export interface CaptureSessionListeners {
  onSegment(segment: TranscriptSegment): void;
  onInterim(interim: InterimTranscript): void;
  onStreamState(source: AudioSource, state: SessionStreamState): void;
  /** A stream died while the session was still recording. The session keeps the other stream. */
  onStreamFailure(source: AudioSource, reason: string): void;
  /** A final line could not be written to the local store. onSegment still gets it right after. */
  onSaveFailure(source: AudioSource, reason: string): void;
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
  private closing = false;

  constructor(private readonly options: CaptureSessionOptions) {
    this.meetingId = options.meetingId;
    this.clock = options.clock ?? (() => Date.now());
  }

  get storedSegmentCount(): number {
    return this.segmentsStored;
  }

  /** Open every stream. If any fails, the ones that opened are closed and the first error is rethrown. */
  async open(): Promise<void> {
    const results = await Promise.allSettled(
      AUDIO_SOURCES.map((source) => this.openStream(source)),
    );
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) {
      await this.close();
      throw failed.reason instanceof Error ? failed.reason : new Error(String(failed.reason));
    }
  }

  pushAudio(source: AudioSource, pcm: Uint8Array): void {
    const stream = this.streams.get(source);
    if (!stream) return;
    if (!this.firstChunkOffsetMs.has(source)) {
      // The vendor's clock starts at its first audio byte. That byte was captured one chunk
      // before it reached us, so the offset is "now" minus the chunk's own duration.
      const captured =
        this.clock() -
        pcmBytesToMs(pcm.byteLength, this.options.settings.sampleRate || PCM_SAMPLE_RATE);
      this.firstChunkOffsetMs.set(source, Math.max(0, captured - this.options.meetingStartedAtMs));
    }
    stream.send(pcm);
  }

  async close(): Promise<void> {
    this.closing = true;
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
    const stream = await stt.openStream({ accessToken, settings, label: source });
    if (this.closing) {
      // Another stream failed while this one was still connecting; do not leak it.
      await stream.close();
      return;
    }
    stream.on((event) => {
      this.handleEvent(source, event);
    });
    this.streams.set(source, stream);
    listeners.onStreamState(source, 'open');
  }

  private handleEvent(source: AudioSource, event: SttEvent): void {
    const offset = this.firstChunkOffsetMs.get(source) ?? 0;
    const { listeners, logger } = this.options;
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
        try {
          this.options.store.appendSegment(segment);
          this.segmentsStored += 1;
        } catch (error) {
          // Disk full, or SQLite busy past its timeout. Uncaught, this became a non-fatal vendor
          // error that was only logged: the line was gone and the screen said nothing. The session
          // keeps recording (see CaptureService's onSaveFailure for why) and still shows the line.
          const reason = errorMessage(error);
          logger.error('line not saved locally', {
            meetingId: this.meetingId,
            source,
            segmentId: segment.id,
            reason,
          });
          listeners.onSaveFailure(source, reason);
        }
        listeners.onSegment(segment);
        return;
      }
      case 'interim':
        listeners.onInterim({
          meetingId: this.meetingId,
          source,
          text: event.text,
          startMs: offset + event.startMs,
          endMs: offset + event.endMs,
        });
        return;
      case 'error':
        logger.error('speech-to-text error', {
          source,
          message: event.message,
          fatal: event.fatal,
        });
        if (event.fatal && !this.closing) this.fail(source, event.message);
        return;
      case 'closed': {
        const reason = describeClose(event.code, event.reason);
        logger.info('speech-to-text stream closed', { source, reason });
        if (this.closing) return;
        // Not asked to close: the vendor or the network ended the stream mid-call.
        this.fail(source, `connection closed (${reason})`);
      }
    }
  }

  private fail(source: AudioSource, reason: string): void {
    if (!this.streams.has(source)) return;
    this.streams.delete(source);
    this.options.listeners.onStreamState(source, 'closed');
    this.options.listeners.onStreamFailure(source, reason);
  }
}

function describeClose(code: number | null, reason: string | null): string {
  if (code === null && reason === null) return 'no close code';
  return [code === null ? null : `code ${code}`, reason]
    .filter((part) => part !== null && part !== '')
    .join(': ');
}
