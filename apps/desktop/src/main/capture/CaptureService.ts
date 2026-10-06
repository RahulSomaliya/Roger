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
  type SttMeter,
  type SttMeterStatus,
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
import { type CostGuards, DEFAULT_COST_GUARDS } from '../costGuards';
import { errorMessage, type Logger } from '../logger';
import type { MicrophoneAccess } from '../permissions';
import type { TranscriptStore } from '../store/TranscriptStore';
import type { SpeechToTextFactory } from '../stt/createSpeechToText';
import type { SpeechToText, SttStreamSettings } from '../stt/SpeechToText';
import type { SttUsage } from '../stt/usage';
import { streamSettingsMismatch } from '../stt/streamSettings';
import type { TranscriptUploader } from '../upload/TranscriptUploader';
import { Emitter } from '../util/emitter';
import { withTimeout } from '../util/time';
import { CaptureSession, type StreamCredentials } from './CaptureSession';
import { SttOpenBudget } from './SttOpenBudget';
import { type StopReason, stopNotice } from './stopReasons';

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
  /** Bounds on billed speech-to-text time (costGuards.ts). Defaults to the defaults. */
  guards?: CostGuards;
  clock?: () => number;
}

export interface StopOptions {
  /** Wait for the uploader to drain. Off when quitting: the uploader resumes on next launch. */
  flushUploads?: boolean;
  /** Why it stops; anything but `user` (the default) leaves a notice on screen. */
  reason?: StopReason;
  /** Extra words for the notice, e.g. how the renderer crashed. */
  detail?: string;
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
  private readonly guards: CostGuards;
  /**
   * Every vendor session open passes here (cost guard G3). It outlives meetings on purpose: the
   * vendor's per-minute limit counts per account, so Start, Stop, Start spends one window.
   */
  private readonly budget: SttOpenBudget;
  private phase: CapturePhase = 'idle';
  private session: CaptureSession | null = null;
  /** The meeting's adapter: its usage() is the meter. */
  private stt: SpeechToText | null = null;
  /** The last meeting's meter, shown after Stop until the next Start. */
  private lastMeter: SttMeterStatus | null = null;
  private sttProvider: string | null = null;
  private startedAt: string | null = null;
  private sources: Record<AudioSource, SourceStatus> = {
    mic: emptySourceStatus(),
    system: emptySourceStatus(),
  };
  private streams: Record<AudioSource, SttStreamState> = { mic: 'closed', system: 'closed' };
  private streamMessages: Record<AudioSource, string | null> = { mic: null, system: null };
  /** The error text each source's last failure set, so its recovery can clear exactly that. */
  private streamErrors: Record<AudioSource, string | null> = { mic: null, system: null };
  private error: string | null = null;
  private notice: string | null = null;
  private segmentsUnsaved = 0;
  private transition: Promise<CaptureStatus> | null = null;
  private monitorTimer: NodeJS.Timeout | null = null;
  /** Clock time the session started recording; the no-audio check counts from it until a chunk. */
  private recordingSinceMs: number | null = null;
  /** Clock time of the last final line from either source; the no-speech stop counts from it. */
  private lastFinalAtMs: number | null = null;

  constructor(private readonly options: CaptureServiceOptions) {
    this.clock = options.clock ?? (() => Date.now());
    this.guards = options.guards ?? DEFAULT_COST_GUARDS;
    this.budget = new SttOpenBudget(
      { perMinute: this.guards.sttOpensPerMinute, perMeeting: this.guards.sttOpensPerMeeting },
      this.clock,
    );
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
      return {
        ...idleCaptureStatus(upload),
        error: this.error,
        meter: this.lastMeter,
        notice: this.notice,
      };
    }
    return {
      phase: this.phase,
      meetingId: this.session?.meetingId ?? null,
      startedAt: this.startedAt,
      sttProvider: this.sttProvider,
      sources: { mic: { ...this.sources.mic }, system: { ...this.sources.system } },
      streams: { ...this.streams },
      streamMessages: { ...this.streamMessages },
      segmentsStored: this.session?.storedSegmentCount ?? 0,
      segmentsUnsaved: this.segmentsUnsaved,
      upload,
      error: this.error,
      meter: this.stt === null ? this.lastMeter : meterStatus(this.stt),
      notice: this.notice,
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
    // Its vendor session would bill silence until Stop: close it now; the other source goes on.
    this.session?.closeSource(source, message ?? `the audio source reported ${state}`);
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
    this.notice = null;
    this.lastMeter = null;
    this.resetSessionState();
    this.budget.beginMeeting();
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
      this.stt = stt;
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
        refreshCredentials: () => this.freshCredentials(provider),
        reopenBufferMs: this.guards.sttReopenBufferMs,
        budget: this.budget,
        reopenBackoffMs: this.guards.sttReopenBackoffMs,
        reopenBackoffMaxMs: this.guards.sttReopenBackoffMaxMs,
        store,
        logger: logger.child({ meetingId }),
        clock: this.clock,
        listeners: {
          onSegment: (segment) => {
            this.lastFinalAtMs = this.clock();
            this.events.emit('segment', segment);
            this.emitStatus();
          },
          onInterim: (interim) => {
            this.events.emit('interim', interim);
          },
          onStreamState: (source, state, message) => {
            this.streams[source] = state;
            this.streamMessages[source] = message;
            if (
              state === 'open' &&
              this.error !== null &&
              this.error === this.streamErrors[source]
            ) {
              // Back again: the error that said it stopped is no longer true.
              this.error = null;
            }
            this.emitStatus();
          },
          onStreamFailure: (source, reason, retryAtMs) => {
            const next =
              retryAtMs === null
                ? 'Press Stop, then Start again.'
                : `Reconnecting when its audio flows, in ${Math.max(0, Math.ceil((retryAtMs - this.clock()) / 1000))} s.`;
            this.error = `Transcription of ${SPEAKER_TITLE[source]} (${SPEAKER_FOR_SOURCE[source]}) stopped: ${reason}. ${next}`;
            this.streamErrors[source] = this.error;
            logger.error('speech-to-text stream failed mid-call', {
              meetingId,
              source,
              reason,
              reopens: retryAtMs !== null,
            });
            this.emitStatus();
          },
          onStreamClosed: (source) => {
            this.recordMeter(meetingId, null, source);
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
        // A failed connect that reached the handshake may be billed: keep its numbers too.
        if ((this.stt?.usage().sessionsOpened ?? 0) > 0) {
          this.recordMeter(meetingId, 'start-failed', null);
        }
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
    const reason = options.reason ?? 'user';
    const session = this.session;
    this.setPhase('stopping');
    this.stopMonitor();
    try {
      if (session) {
        await session.close();
        const meetingId = session.meetingId;
        this.recordMeter(meetingId, reason, null);
        if (this.stt !== null) this.lastMeter = meterStatus(this.stt);
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
        logger.info('capture stopped', {
          meetingId,
          segments: session.storedSegmentCount,
          reason,
        });
      }
    } catch (error) {
      this.error = errorMessage(error);
      logger.error('capture stop failed', { error: this.error, reason });
    } finally {
      this.notice = stopNotice(reason, new Date(this.clock()), this.guards, options.detail ?? null);
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

  /**
   * Credentials for a reopen, mid-meeting. The vendor and the audio format must be the ones the
   * meeting started with: the session's adapter cannot switch vendor, and another format would be
   * transcribed as garbage with no error.
   */
  private async freshCredentials(provider: string): Promise<StreamCredentials> {
    const { provider: issued, accessToken, settings } = await this.resolveStt();
    if (issued !== provider) {
      throw new Error(
        `the API now names speech-to-text provider "${issued}", not "${provider}"; press Stop, then Start to switch`,
      );
    }
    const mismatch = streamSettingsMismatch(settings);
    if (mismatch !== null) throw new Error(mismatch);
    return { accessToken, settings };
  }

  private resetSessionState(): void {
    this.sources = { mic: emptySourceStatus(), system: emptySourceStatus() };
    this.streams = { mic: 'closed', system: 'closed' };
    this.streamMessages = { mic: null, system: null };
    this.streamErrors = { mic: null, system: null };
    this.stt = null;
    this.sttProvider = null;
    this.startedAt = null;
    this.recordingSinceMs = null;
    this.lastFinalAtMs = null;
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
      this.checkForgottenStop();
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
   *
   * Cost guard G2: past sttStallCloseMs with no chunk, the source's vendor session closes (it
   * bills silence otherwise, $0.15 an hour on AssemblyAI) and reopens with its next chunk.
   */
  private checkAudioFlow(): void {
    if (this.phase !== 'recording' || this.recordingSinceMs === null) return;
    const now = this.clock();
    for (const source of AUDIO_SOURCES) {
      const status = this.sources[source];
      if (
        status.health !== 'pending' &&
        status.health !== 'active' &&
        status.health !== 'stalled'
      ) {
        continue;
      }
      const silentForMs = now - (status.lastChunkAt ?? this.recordingSinceMs);
      if (silentForMs >= this.guards.sttStallCloseMs) {
        this.session?.pauseSource(source, silentForMs);
      }
      if (status.health === 'stalled' || silentForMs < NO_AUDIO_WARNING_MS) continue;
      status.health = 'stalled';
      this.options.logger.warn('no audio from source', {
        source,
        meetingId: this.session?.meetingId ?? null,
        silentForMs,
      });
    }
  }

  /**
   * Cost guard G5: a Stop nobody pressed. With silence still flowing (a muted mic, call audio
   * without its permission) the stall close never fires and both sessions bill, $0.30 an hour on
   * AssemblyAI, for as long as the app stays open: overnight is $4.20. So a recording with no final
   * line from either source for noSpeechStopMs stops, and any recording stops at maxRecordingMs,
   * both through the normal stop (last lines saved, sessions finished and closed).
   */
  private checkForgottenStop(): void {
    if (this.phase !== 'recording' || this.recordingSinceMs === null) return;
    const now = this.clock();
    const recordingForMs = now - this.recordingSinceMs;
    const quietForMs = now - (this.lastFinalAtMs ?? this.recordingSinceMs);
    let reason: StopReason | null = null;
    if (recordingForMs >= this.guards.maxRecordingMs) reason = 'max-duration';
    else if (quietForMs >= this.guards.noSpeechStopMs) reason = 'no-speech';
    if (reason === null) return;
    this.options.logger.warn('stopping a recording nobody stopped', {
      meetingId: this.session?.meetingId ?? null,
      reason,
      recordingForMs,
      quietForMs,
    });
    void this.stop({ reason });
  }

  /**
   * Logs the meeting's speech-to-text use and keeps it in the local store (cost guard G7): after
   * every stream that closes mid-meeting, and once at Stop with the reason. Saving at each close
   * keeps most of it should the app die before Stop.
   */
  private recordMeter(
    meetingId: string,
    stopReason: StopReason | 'start-failed' | null,
    closedSource: AudioSource | null,
  ): void {
    const { stt, sttProvider: provider } = this;
    if (stt === null || provider === null) return;
    const total = stt.usage();
    const bySource = { mic: stt.usage('mic'), system: stt.usage('system') };
    const { logger, store } = this.options;
    logger.info(stopReason === null ? 'stt meter' : 'stt meter at stop', {
      meetingId,
      provider,
      closedSource,
      stopReason,
      total,
      mic: bySource.mic,
      system: bySource.system,
    });
    try {
      store.saveSttUsage({
        meetingId,
        provider,
        total,
        bySource,
        stopReason,
        updatedAt: new Date(this.clock()).toISOString(),
      });
    } catch (error) {
      // The log line above keeps the numbers; recording goes on.
      logger.error('speech-to-text usage not saved locally', {
        meetingId,
        error: errorMessage(error),
      });
    }
  }

  private emitStatus(): void {
    this.events.emit('status', this.getStatus());
  }
}

function meterStatus(stt: SpeechToText): SttMeterStatus {
  return {
    vendorName: stt.vendorName,
    total: toMeter(stt.usage()),
    sources: { mic: toMeter(stt.usage('mic')), system: toMeter(stt.usage('system')) },
  };
}

function toMeter({
  sessionsOpened,
  connectedMs,
  audioSentMs,
  estimatedCostUsd,
}: SttUsage): SttMeter {
  return { sessionsOpened, connectedMs, audioSentMs, estimatedCostUsd };
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
