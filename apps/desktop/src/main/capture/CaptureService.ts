import { randomUUID } from 'node:crypto';
import {
  AUDIO_SOURCE_LABEL,
  emptySourceStatus,
  idleCaptureStatus,
  NO_AUDIO_WARNING_MS,
  type AudioSourceState,
  type CapturePhase,
  type CaptureStatus,
  type SourceStatus,
  type SttStreamState,
} from '../../shared/capture';
import { PCM_ENCODING, PCM_SAMPLE_RATE } from '../../shared/ipc';
import {
  AUDIO_SOURCES,
  SPEAKER_FOR_SOURCE,
  type AudioSource,
  type InterimTranscript,
  type TranscriptSegment,
} from '../../shared/transcript';
import type { SttTokenApi } from '../api/ApiClient';
import { errorMessage, type Logger } from '../logger';
import type { MicrophoneAccess } from '../permissions';
import type { TranscriptStore } from '../store/TranscriptStore';
import type { SpeechToTextFactory } from '../stt/createSpeechToText';
import type { SttStreamSettings } from '../stt/SpeechToText';
import { streamSettingsMismatch } from '../stt/streamSettings';
import type { TranscriptUploader } from '../upload/TranscriptUploader';
import { Emitter } from '../util/emitter';
import { withTimeout } from '../util/time';
import { CaptureSession } from './CaptureSession';

export interface CaptureServiceOptions {
  store: TranscriptStore;
  api: SttTokenApi;
  uploader: TranscriptUploader;
  createSpeechToText: SpeechToTextFactory;
  ensureMicrophoneAccess: () => Promise<MicrophoneAccess>;
  logger: Logger;
  /** Only "fake" is honoured: it skips the vendor token and transcribes audio energy (development). */
  sttProviderOverride: string | null;
  /** A configuration problem found at startup. Start fails with this message until it is fixed. */
  startupError: string | null;
  /** How long Stop waits for the uploader to drain before giving up (lines stay local). */
  stopFlushTimeoutMs?: number;
  clock?: () => number;
}

export interface StopOptions {
  /** Wait for the uploader to drain. Off when quitting: the uploader resumes on next launch. */
  flushUploads?: boolean;
}

interface CaptureEvents extends Record<string, unknown> {
  status: CaptureStatus;
  segment: TranscriptSegment;
  interim: InterimTranscript;
}

const FAKE_STREAM_SETTINGS: SttStreamSettings = {
  model: 'fake',
  language: 'en',
  sampleRate: PCM_SAMPLE_RATE,
  encoding: PCM_ENCODING,
  pricePerHourUsd: 0,
};

/** How often the audio flow is checked and chunk counters are pushed to the UI while recording. */
const MONITOR_INTERVAL_MS = 500;

const SPEAKER_TITLE: Record<AudioSource, string> = { mic: 'Me', system: 'Them' };

/**
 * The capture state machine: idle → starting → recording → stopping → idle. One session at a time;
 * start and stop are single-flight. Owns everything the renderer must never own: tokens, sockets,
 * the local store, the uploader.
 */
export class CaptureService {
  private readonly events = new Emitter<CaptureEvents>();
  private readonly clock: () => number;
  private phase: CapturePhase = 'idle';
  private session: CaptureSession | null = null;
  private sttProvider: string | null = null;
  private startedAt: string | null = null;
  private sources: Record<AudioSource, SourceStatus> = {
    mic: emptySourceStatus(),
    system: emptySourceStatus(),
  };
  private streams: Record<AudioSource, SttStreamState> = { mic: 'closed', system: 'closed' };
  private error: string | null = null;
  private segmentsUnsaved = 0;
  private transition: Promise<CaptureStatus> | null = null;
  private monitorTimer: NodeJS.Timeout | null = null;
  /** Clock time the session started recording; the no-audio check counts from it until a chunk. */
  private recordingSinceMs: number | null = null;

  constructor(private readonly options: CaptureServiceOptions) {
    this.clock = options.clock ?? (() => Date.now());
    this.error = options.startupError;
    options.uploader.onStatus(() => {
      this.emitStatus();
    });
  }

  on<K extends keyof CaptureEvents>(
    event: K,
    listener: (payload: CaptureEvents[K]) => void,
  ): () => void {
    return this.events.on(event, listener);
  }

  getStatus(): CaptureStatus {
    const upload = this.options.uploader.getStatus();
    if (this.phase === 'idle' && !this.session) {
      return { ...idleCaptureStatus(upload), error: this.error };
    }
    return {
      phase: this.phase,
      meetingId: this.session?.meetingId ?? null,
      startedAt: this.startedAt,
      sttProvider: this.sttProvider,
      sources: { mic: { ...this.sources.mic }, system: { ...this.sources.system } },
      streams: { ...this.streams },
      segmentsStored: this.session?.storedSegmentCount ?? 0,
      segmentsUnsaved: this.segmentsUnsaved,
      upload,
      error: this.error,
    };
  }

  start(): Promise<CaptureStatus> {
    if (this.transition) return this.transition;
    if (this.phase !== 'idle') return Promise.resolve(this.getStatus());
    this.transition = this.doStart().finally(() => {
      this.transition = null;
    });
    return this.transition;
  }

  stop(options: StopOptions = {}): Promise<CaptureStatus> {
    if (this.transition) return this.transition.then(() => this.stop(options));
    if (this.phase !== 'recording') return Promise.resolve(this.getStatus());
    this.transition = this.doStop(options).finally(() => {
      this.transition = null;
    });
    return this.transition;
  }

  pushAudio(source: AudioSource, pcm: Uint8Array): void {
    if (this.phase !== 'recording' || !this.session) return;
    const status = this.sources[source];
    const now = this.clock();
    if (status.health === 'stalled') {
      this.options.logger.info('audio resumed', {
        source,
        meetingId: this.session.meetingId,
        silentForMs: now - (status.lastChunkAt ?? this.recordingSinceMs ?? now),
      });
    }
    status.chunks += 1;
    status.lastChunkAt = now;
    if (status.health === 'pending' || status.health === 'stalled') {
      status.health = 'active';
      this.emitStatus();
    }
    // M2's silence warning (chunks arriving but all near zero, e.g. rmsInt16) belongs here.
    this.session.pushAudio(source, pcm);
  }

  reportSourceState(source: AudioSource, state: AudioSourceState, message: string | null): void {
    if (this.phase === 'idle') return;
    const status = this.sources[source];
    if (state === 'active') {
      // "The track is live" is not "audio flows": only a chunk may clear a stalled source.
      if (status.health === 'pending') status.health = 'active';
      this.emitStatus();
      return;
    }
    status.health = state;
    status.message = message;
    const meetingId = this.session?.meetingId ?? null;
    this.options.logger.warn('audio source problem', { source, state, message, meetingId });
    if (state === 'ended' && this.phase === 'recording') {
      // A track that ends mid-call never comes back; only a new session reopens the device.
      this.error = `${AUDIO_SOURCE_LABEL[source]} stopped: ${message ?? 'the audio track ended'}. Press Stop, then Start again.`;
    }
    this.emitStatus();
  }

  private async doStart(): Promise<CaptureStatus> {
    if (this.options.startupError) {
      this.error = this.options.startupError;
      return this.getStatus();
    }
    const { logger, store } = this.options;
    this.error = null;
    this.resetSessionState();
    this.setPhase('starting');
    const startedAtMs = this.clock();
    const meetingId = randomUUID();
    let session: CaptureSession | null = null;
    let meetingCreated = false;
    try {
      if ((await this.options.ensureMicrophoneAccess()) === 'denied') {
        throw new Error(
          'Microphone access is denied. Allow Roger under System Settings → Privacy & Security → Microphone.',
        );
      }
      const { provider, accessToken, settings } = await this.resolveStt();
      // Checked before the meeting exists: a session on the wrong format would store nonsense lines.
      const mismatch = streamSettingsMismatch(settings);
      if (mismatch !== null) throw new Error(mismatch);
      const stt = this.options.createSpeechToText(provider);
      this.sttProvider = provider;
      this.startedAt = new Date(startedAtMs).toISOString();
      store.createMeeting({
        id: meetingId,
        title: defaultMeetingTitle(new Date(startedAtMs)),
        startedAt: this.startedAt,
      });
      meetingCreated = true;
      session = new CaptureSession({
        meetingId,
        meetingStartedAtMs: startedAtMs,
        stt,
        accessToken,
        settings,
        store,
        logger: logger.child({ meetingId }),
        clock: this.clock,
        listeners: {
          onSegment: (segment) => {
            this.events.emit('segment', segment);
            this.emitStatus();
          },
          onInterim: (interim) => {
            this.events.emit('interim', interim);
          },
          onStreamState: (source, state) => {
            this.streams[source] = state;
            this.emitStatus();
          },
          onStreamFailure: (source, reason) => {
            this.streams[source] = 'error';
            this.error = `Transcription of ${SPEAKER_TITLE[source]} (${SPEAKER_FOR_SOURCE[source]}) stopped: ${reason}. Press Stop, then Start again.`;
            logger.error('speech-to-text stream failed mid-call', { meetingId, source, reason });
            this.emitStatus();
          },
          onSaveFailure: (source, reason) => {
            // Recording goes on. The likely causes (disk full, the file locked past SQLite's 5 s
            // busy timeout) are often brief or fixable mid-call, and M1 keeps no audio to
            // re-transcribe from (that is M2), so stopping would lose every later line as well.
            // The count and this error stay on screen so the person can decide to stop.
            this.segmentsUnsaved += 1;
            const lines = this.segmentsUnsaved === 1 ? '1 line' : `${this.segmentsUnsaved} lines`;
            this.error = `${lines} could not be saved on this Mac (latest from ${AUDIO_SOURCE_LABEL[source]}, meeting ${meetingId}): ${reason}. Recording continues; free disk space, or press Stop if this keeps happening.`;
            this.emitStatus();
          },
        },
      });
      await session.open();
      this.session = session;
      this.recordingSinceMs = this.clock();
      this.setPhase('recording');
      this.startMonitor();
      logger.info('capture started', { meetingId, provider });
    } catch (error) {
      this.error = errorMessage(error);
      logger.error('capture start failed', { meetingId, error: this.error });
      try {
        if (session) await session.close();
        if (meetingCreated) store.deleteMeetingIfEmpty(meetingId);
      } catch (cleanupError) {
        logger.error('cleanup after failed start failed', {
          meetingId,
          error: errorMessage(cleanupError),
        });
      } finally {
        this.resetSessionState();
        this.setPhase('idle');
      }
    }
    return this.getStatus();
  }

  private async doStop(options: StopOptions): Promise<CaptureStatus> {
    const { logger, store, uploader, stopFlushTimeoutMs = 15_000 } = this.options;
    const session = this.session;
    this.setPhase('stopping');
    this.stopMonitor();
    try {
      if (session) {
        await session.close();
        const meetingId = session.meetingId;
        // A meeting with no line was never sent to Postgres: TranscriptUploader.syncMeeting creates
        // it only once it holds one, and lines are never deleted, so this delete cannot race an
        // upload. If the uploader ever creates meetings earlier again, this leaves Postgres a
        // meeting stuck in "recording".
        if (
          store.getMeeting(meetingId)?.remoteState === 'pending' &&
          store.deleteMeetingIfEmpty(meetingId)
        ) {
          logger.info('empty meeting discarded', { meetingId });
        } else {
          store.markMeetingEnded(meetingId, new Date(this.clock()).toISOString());
        }
        if (options.flushUploads !== false) {
          try {
            await withTimeout(uploader.flush(), stopFlushTimeoutMs, 'upload on stop');
          } catch (error) {
            // Lines are safe locally; the uploader keeps retrying in the background.
            logger.warn('upload did not finish on stop', { error: errorMessage(error) });
          }
        }
        logger.info('capture stopped', { meetingId, segments: session.storedSegmentCount });
      }
    } catch (error) {
      this.error = errorMessage(error);
      logger.error('capture stop failed', { error: this.error });
    } finally {
      this.session = null;
      this.resetSessionState();
      this.setPhase('idle');
    }
    return this.getStatus();
  }

  private async resolveStt(): Promise<{
    provider: string;
    accessToken: string;
    settings: SttStreamSettings;
  }> {
    if (this.options.sttProviderOverride === 'fake') {
      return { provider: 'fake', accessToken: '', settings: FAKE_STREAM_SETTINGS };
    }
    const token = await this.options.api.getSttToken();
    return {
      provider: token.provider,
      accessToken: token.access_token,
      settings: {
        model: token.stream.model,
        language: token.stream.language,
        sampleRate: token.stream.sample_rate,
        encoding: token.stream.encoding,
        pricePerHourUsd: token.stream.price_per_hour_usd,
      },
    };
  }

  private resetSessionState(): void {
    this.sources = { mic: emptySourceStatus(), system: emptySourceStatus() };
    this.streams = { mic: 'closed', system: 'closed' };
    this.sttProvider = null;
    this.startedAt = null;
    this.recordingSinceMs = null;
    this.segmentsUnsaved = 0;
  }

  private setPhase(phase: CapturePhase): void {
    this.phase = phase;
    this.emitStatus();
  }

  private startMonitor(): void {
    this.stopMonitor();
    this.monitorTimer = setInterval(() => {
      this.checkAudioFlow();
      this.emitStatus();
    }, MONITOR_INTERVAL_MS);
  }

  private stopMonitor(): void {
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.monitorTimer = null;
  }

  /**
   * The M1 plan's no-audio check: a source that has sent no chunk at all for NO_AUDIO_WARNING_MS
   * while recording is marked stalled and logged once; its next chunk clears it (pushAudio). It
   * sees a capture path that stopped (renderer, worklet or IPC), not a live track of silence: that
   * still sends chunks of zeros, as system audio without its macOS permission most likely does,
   * and is M2's silence warning (see pushAudio). Sources already `ended` or in `error` keep that
   * more specific state.
   */
  private checkAudioFlow(): void {
    if (this.phase !== 'recording' || this.recordingSinceMs === null) return;
    const now = this.clock();
    for (const source of AUDIO_SOURCES) {
      const status = this.sources[source];
      if (status.health !== 'pending' && status.health !== 'active') continue;
      const silentForMs = now - (status.lastChunkAt ?? this.recordingSinceMs);
      if (silentForMs < NO_AUDIO_WARNING_MS) continue;
      status.health = 'stalled';
      this.options.logger.warn('no audio from source', {
        source,
        meetingId: this.session?.meetingId ?? null,
        silentForMs,
      });
    }
  }

  private emitStatus(): void {
    this.events.emit('status', this.getStatus());
  }
}

export function defaultMeetingTitle(startedAt: Date): string {
  const date = startedAt.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  const time = startedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `Meeting ${date} ${time}`;
}
