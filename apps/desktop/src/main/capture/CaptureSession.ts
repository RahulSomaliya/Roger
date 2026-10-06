import { randomUUID } from 'node:crypto';
import type { SttStreamState } from '../../shared/capture';
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

export interface CaptureSessionListeners {
  onSegment(segment: TranscriptSegment): void;
  onInterim(interim: InterimTranscript): void;
  /** A source's vendor session changed state; `message` says why it is not open, or null. */
  onStreamState(source: AudioSource, state: SttStreamState, message: string | null): void;
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

/** One vendor stream, from its open until its close settles. */
interface StreamHandle {
  readonly stream: SttStream;
  /**
   * Meeting offset of the stream's first audio byte, the vendor's time zero. Per stream, not per
   * source: a reopened stream starts its own clock. Null until its first chunk is sent.
   */
  offsetMs: number | null;
  /** Set once the stream was asked to close; settles when it has. */
  closing: Promise<void> | null;
}

/** What one audio source has with the vendor right now. */
interface SourceLink {
  state: SttStreamState;
  /** The stream carrying this source's audio, or null. Only `open` has one. */
  current: StreamHandle | null;
  /** Bumped by every open and every close, so an open that lands late knows it is stale. */
  attempt: number;
}

/**
 * One meeting's live pipeline: one speech-to-text stream per audio source, finals written to the
 * local store the moment they arrive (house rule 1), interims passed straight to the UI.
 *
 * Vendors bill every second a session is open, silent or not, so a source that has no audio must
 * not hold one: a source that fails or ends closes its own session at once (closeSource), and the
 * other keeps going. Every stream this class ever opened is tracked until its close settles, and
 * close() waits for all of them.
 */
export class CaptureSession {
  readonly meetingId: string;
  private readonly links: Record<AudioSource, SourceLink> = { mic: newLink(), system: newLink() };
  /** Every stream not yet closed, the ones closing included: close() waits for each. */
  private readonly handles = new Set<StreamHandle>();
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

  /**
   * Open every stream. If any fails, the ones that opened are closed and the first error is
   * rethrown. Each open starts one vendor session per source, and vendors meter sessions started
   * (AssemblyAI: 5 a minute on a free account), so a retry or reconnect loop around this spends
   * that budget fast.
   */
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
    if (this.closing) return;
    const link = this.links[source];
    if (link.state === 'open' && link.current !== null) this.send(link.current, pcm, this.clock());
  }

  /**
   * The source failed or ended: close its vendor session now, without waiting for Stop. The
   * renderer reports this once the track is gone for good, so the session would only bill silence
   * (Deepgram even kept it alive with KeepAlive) for the rest of the meeting. It stays closed: a
   * dead track never comes back, only a new Start reopens the device.
   */
  closeSource(source: AudioSource, reason: string): void {
    if (this.closing) return;
    const link = this.links[source];
    link.attempt += 1;
    const handle = link.current;
    link.current = null;
    if (link.state === 'closed') return;
    this.setState(source, 'closed', reason);
    if (handle !== null) {
      this.options.logger.info('speech-to-text stream closed: the source has no audio', {
        source,
        reason,
      });
      void this.retire(handle);
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const link of Object.values(this.links)) {
      link.attempt += 1;
      if (link.current !== null) void this.retire(link.current);
      link.current = null;
    }
    await Promise.all([...this.handles].map((handle) => this.retire(handle)));
  }

  private async openStream(source: AudioSource): Promise<void> {
    const { stt, accessToken, settings } = this.options;
    const link = this.links[source];
    const attempt = (link.attempt += 1);
    this.setState(source, 'connecting', null);
    const handle = this.track(
      source,
      await stt.openStream({ accessToken, settings, label: source }),
    );
    if (this.closing || link.attempt !== attempt) {
      // Another stream failed, or the source closed, while this one was connecting: do not leak it.
      await this.retire(handle);
      return;
    }
    link.current = handle;
    this.setState(source, 'open', null);
  }

  /** Every stream is tracked from the moment it exists, so close() can never miss one. */
  private track(source: AudioSource, stream: SttStream): StreamHandle {
    const handle: StreamHandle = { stream, offsetMs: null, closing: null };
    this.handles.add(handle);
    stream.on((event) => {
      this.handleEvent(source, handle, event);
    });
    return handle;
  }

  /** Asks the stream to close (idempotent); the handle is forgotten once it has. */
  private retire(handle: StreamHandle): Promise<void> {
    handle.closing ??= handle.stream
      .close()
      .catch((error: unknown) => {
        this.options.logger.warn('stream close failed', { error: errorMessage(error) });
      })
      .finally(() => {
        this.handles.delete(handle);
      });
    return handle.closing;
  }

  private send(handle: StreamHandle, pcm: Uint8Array, arrivedAtMs: number): void {
    if (handle.offsetMs === null) {
      // The vendor's clock starts at its first audio byte. That byte was captured one chunk
      // before it reached us, so the offset is its arrival minus the chunk's own duration.
      // Adapters must hand the vendor every byte, in order (AssemblyAI regroups them; see
      // SttConnection.sendFrame).
      const captured =
        arrivedAtMs -
        pcmBytesToMs(pcm.byteLength, this.options.settings.sampleRate || PCM_SAMPLE_RATE);
      handle.offsetMs = Math.max(0, captured - this.options.meetingStartedAtMs);
    }
    handle.stream.send(pcm);
  }

  private setState(source: AudioSource, state: SttStreamState, message: string | null): void {
    this.links[source].state = state;
    this.options.listeners.onStreamState(source, state, message);
  }

  private handleEvent(source: AudioSource, handle: StreamHandle, event: SttEvent): void {
    const offset = handle.offsetMs ?? 0;
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
        if (event.fatal) this.streamFailed(source, handle, event.message);
        return;
      case 'closed': {
        const reason = describeClose(event.code, event.reason);
        logger.info('speech-to-text stream closed', { source, reason });
        // Not asked to close: the vendor or the network ended the stream mid-call.
        this.streamFailed(source, handle, `connection closed (${reason})`);
      }
    }
  }

  /**
   * The source's current stream died mid-call. A stream we asked to close (Stop, a failed source)
   * is no longer current, so its "closed" is not a failure. The dead stream is closed too: the core
   * closes itself after a fatal error, but a stream that only reported one must not stay open.
   */
  private streamFailed(source: AudioSource, handle: StreamHandle, reason: string): void {
    const link = this.links[source];
    if (this.closing || link.current !== handle) return;
    link.current = null;
    link.attempt += 1;
    void this.retire(handle);
    this.setState(source, 'error', reason);
    this.options.listeners.onStreamFailure(source, reason);
  }
}

function newLink(): SourceLink {
  return { state: 'closed', current: null, attempt: 0 };
}

function describeClose(code: number | null, reason: string | null): string {
  if (code === null && reason === null) return 'no close code';
  return [code === null ? null : `code ${code}`, reason]
    .filter((part) => part !== null && part !== '')
    .join(': ');
}
