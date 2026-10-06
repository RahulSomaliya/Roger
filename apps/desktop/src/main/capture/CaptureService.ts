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
import { pcmBytesToMs } from '../../shared/pcm';
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
import type { MeetingSttUsage, TranscriptStore } from '../store/TranscriptStore';
import type { SpeechToTextFactory } from '../stt/createSpeechToText';
import type { SpeechToText, SttStreamSettings } from '../stt/SpeechToText';
import type { SttUsage } from '../stt/usage';
import { streamSettingsMismatch } from '../stt/streamSettings';
import type { TranscriptUploader } from '../upload/TranscriptUploader';
import { Emitter } from '../util/emitter';
import { withTimeout } from '../util/time';
import { AudioFanout, type AudioSink } from './AudioFanout';
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
  /**
   * The open budget every session open passes (cost guard G3). createCaptureRuntime.ts builds the
   * one budget and shares it with the gap re-run (M2-T16), which opens outside a recording; left
   * out, one is built from `guards`, as before.
   */
  budget?: SttOpenBudget;
  clock?: () => number;
}

/**
 * A meeting a previous run left open, continued in the same id (M2 D7; M2-T23's CrashRecovery
 * decides when). Its start and its saved `stt_usage` row are read from the store, so they cannot
 * disagree with it.
 */
export interface ResumeMeeting {
  meetingId: string;
}

export interface StartOptions {
  /** Continue this open meeting instead of creating one. */
  resume?: ResumeMeeting;
}

export interface StopOptions {
  /** Wait for the uploader to drain. Off when quitting: the uploader resumes on next launch. */
  flushUploads?: boolean;
  /** Why it stops (default `user`): logged and kept with the meeting's usage; see stopNotice. */
  reason?: StopReason;
  /** Extra words for the notice, e.g. how the renderer crashed. */
  detail?: string;
}

interface CaptureEvents extends Record<string, unknown> {
  status: CaptureStatus;
  segment: TranscriptSegment;
  interim: InterimTranscript;
}

/** A recording that has begun: what `RecordingListener.started` gets. */
export interface RecordingStarted {
  meetingId: string;
  /** Epoch ms of the meeting's start, which every offset counts from; a resume keeps the first. */
  meetingStartedAtMs: number;
  /** True when this recording continues a meeting a previous run left open (M2 D7). */
  resumed: boolean;
  /**
   * The live pipeline. Features that act on it mid-recording (M2-T6's offline suspend, M2-T18's
   * sleep, M2-T14b's watermarks) reach it here, never through an edit to this file.
   */
  session: CaptureSession;
}

/** A recording that is over: what `RecordingListener.ended` gets. */
export interface RecordingEnded {
  meetingId: string;
  reason: StopReason;
  /** True when the meeting had no line and was deleted: nothing to upload, nothing to write up. */
  discarded: boolean;
}

/**
 * The session event listeners (M2-T4): how features follow recordings without editing this file.
 * Each call is synchronous and its own; one that throws is logged and the rest still run.
 */
export interface RecordingListener {
  /**
   * Both streams are open and the phase is `recording`; no audio has reached the session yet. A
   * listener added while a recording runs is told at once.
   */
  started?(recording: RecordingStarted): void;
  /**
   * Stop closed both streams, saved the last lines and ended (or discarded) the meeting; the upload
   * flush may still run. Every `started` gets exactly one `ended`; a Start that failed gets neither.
   */
  ended?(recording: RecordingEnded): void;
}

/**
 * The M2 fields of CaptureStatus a feature fills (M2-T2 made each optional, so a status built
 * without them is still valid). Warnings and notices from every contributor are joined; any other
 * field has one owning feature, and a later contributor's value would replace an earlier one's.
 */
export type ContributedStatus = Pick<
  CaptureStatus,
  | 'warnings'
  | 'notices'
  | 'systemCapture'
  | 'systemAudioVerified'
  | 'route'
  | 'trigger'
  | 'paused'
  | 'backup'
  | 'echo'
  | 'rerun'
>;

/** The M2 fields of one source's status a feature fills (M2-T11's signal, M2-T12's device). */
export type ContributedSourceStatus = Pick<SourceStatus, 'signal' | 'levelDb' | 'device'>;

export interface StatusContribution extends ContributedStatus {
  sources?: Partial<Record<AudioSource, ContributedSourceStatus>>;
}

export interface StatusContext {
  phase: CapturePhase;
  /** The recording's meeting; null when idle. */
  meetingId: string | null;
}

/**
 * The status-contributor seam: a feature's part of every status (M2-T10, T11, T14b, T15 and
 * later), read each time one is built, idle or recording. It runs often (every status the window
 * gets, twice a second while recording), so it only reads state the feature keeps in memory;
 * when that state changes, the feature calls `refreshStatus()`.
 */
export type StatusContributor = (context: StatusContext) => StatusContribution;

/** Fields of ContributedStatus that hold one value, copied by name so nothing else gets through. */
const CONTRIBUTED_FIELDS = [
  'systemCapture',
  'systemAudioVerified',
  'route',
  'trigger',
  'paused',
  'backup',
  'echo',
  'rerun',
] as const satisfies readonly Exclude<keyof ContributedStatus, 'warnings' | 'notices'>[];

const CONTRIBUTED_SOURCE_FIELDS = [
  'signal',
  'levelDb',
  'device',
] as const satisfies readonly (keyof ContributedSourceStatus)[];

interface ContributorEntry {
  name: string;
  read: StatusContributor;
  /** The error of the spell this contributor is failing in, or null. */
  failing: string | null;
}

const FAKE_STREAM_SETTINGS: SttStreamSettings = {
  model: 'fake',
  language: 'en',
  sampleRate: PCM_SAMPLE_RATE,
  encoding: PCM_ENCODING,
  pricePerHourUsd: 0,
  keyterms: [],
};

/** How often the audio flow is checked and chunk counters are pushed to the UI while recording. */
const MONITOR_INTERVAL_MS = 500;

const SPEAKER_TITLE: Record<AudioSource, string> = { mic: 'Me', system: 'Them' };

interface StreamRetry {
  reason: string;
  /** Clock time the source may reopen, with its next chunk. */
  retryAtMs: number;
}

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
  /** Every recorded chunk goes out here: the meeting's session and the features' sinks. */
  private readonly audio: AudioFanout;
  private readonly recordingListeners = new Set<RecordingListener>();
  private readonly contributors: ContributorEntry[] = [];
  private currentPhase: CapturePhase = 'idle';
  private session: CaptureSession | null = null;
  /** The running recording, as its listeners were told; null when none runs. */
  private live: RecordingStarted | null = null;
  /** Takes the session's sink out of the fan-out at Stop. */
  private removeSessionSink: (() => void) | null = null;
  /** The meeting's adapter: its usage() is the meter. */
  private stt: SpeechToText | null = null;
  /**
   * A resumed meeting's saved use (M2 D7): the meter adds this run's sessions to it, since the new
   * adapter counts from zero. Null for a new meeting.
   */
  private savedUsage: MeetingSttUsage | null = null;
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
  /** Each source's failure while it waits to reconnect, so the monitor can count the wait down. */
  private streamRetries: Record<AudioSource, StreamRetry | null> = { mic: null, system: null };
  private error: string | null = null;
  private notice: string | null = null;
  private segmentsUnsaved = 0;
  private transition: Promise<CaptureStatus> | null = null;
  private monitorTimer: NodeJS.Timeout | null = null;
  /** Clock time the session started recording; the no-audio check counts from it until a chunk. */
  private recordingSinceMs: number | null = null;
  /** Clock time the recording cap (maxRecordingMs) counts from: a resume's is the meeting's start. */
  private capFromMs: number | null = null;
  /** Clock time of the last final line from either source; the no-speech stop counts from it. */
  private lastFinalAtMs: number | null = null;

  constructor(private readonly options: CaptureServiceOptions) {
    this.clock = options.clock ?? (() => Date.now());
    this.guards = options.guards ?? DEFAULT_COST_GUARDS;
    this.budget =
      options.budget ??
      new SttOpenBudget(
        { perMinute: this.guards.sttOpensPerMinute, perMeeting: this.guards.sttOpensPerMeeting },
        this.clock,
      );
    this.audio = new AudioFanout(options.logger);
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

  /**
   * Follows recordings: `started` with the live session, `ended` with how it ended. Returns the
   * removal. Added while a recording runs, `started` is called at once.
   */
  onRecording(listener: RecordingListener): () => void {
    this.recordingListeners.add(listener);
    const live = this.live;
    if (live !== null) this.tell('started', live.meetingId, () => listener.started?.(live));
    return () => {
      this.recordingListeners.delete(listener);
    };
  }

  /**
   * Adds a sink that gets every chunk recorded from now on, both sources, while a recording runs
   * (AudioFanout). Returns the removal.
   */
  addAudioSink(name: string, sink: AudioSink): () => void {
    return this.audio.add(name, sink);
  }

  /** Adds a feature's part of the status (StatusContributor). Returns the removal. */
  addStatusContributor(name: string, read: StatusContributor): () => void {
    const entry: ContributorEntry = { name, read, failing: null };
    this.contributors.push(entry);
    return () => {
      const index = this.contributors.indexOf(entry);
      if (index !== -1) this.contributors.splice(index, 1);
    };
  }

  /** A contributor's part changed: send the window a fresh status. */
  refreshStatus(): void {
    this.emitStatus();
  }

  /** The phase alone: cheap, and it never reads the store (getStatus does, for upload counts). */
  get phase(): CapturePhase {
    return this.currentPhase;
  }

  getStatus(): CaptureStatus {
    return this.withContributions(this.landedStatus());
  }

  /** The status as M1 built it, before any feature's part. */
  private landedStatus(): CaptureStatus {
    const upload = this.options.uploader.getStatus();
    if (this.currentPhase === 'idle' && !this.session) {
      return {
        ...idleCaptureStatus(upload),
        error: this.error,
        meter: this.lastMeter,
        notice: this.notice,
      };
    }
    return {
      phase: this.currentPhase,
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
      meter: this.stt === null ? this.lastMeter : this.meterStatus(this.stt),
      notice: this.notice,
    };
  }

  /** Adds every contributor's part to `status`; one that throws is logged and left out. */
  private withContributions(status: CaptureStatus): CaptureStatus {
    const context: StatusContext = { phase: status.phase, meetingId: status.meetingId };
    for (const entry of this.contributors) {
      let part: StatusContribution;
      try {
        part = entry.read(context);
      } catch (error) {
        const message = errorMessage(error);
        // Once per spell: a broken contributor fails on every status, twice a second.
        if (entry.failing !== message) {
          this.options.logger.error('status contributor failed', {
            contributor: entry.name,
            error: message,
          });
        }
        entry.failing = message;
        continue;
      }
      entry.failing = null;
      if (part.warnings !== undefined) {
        status.warnings = [...(status.warnings ?? []), ...part.warnings];
      }
      if (part.notices !== undefined) {
        status.notices = [...(status.notices ?? []), ...part.notices];
      }
      for (const field of CONTRIBUTED_FIELDS) copyField<ContributedStatus>(status, part, field);
      for (const source of AUDIO_SOURCES) {
        const sourcePart = part.sources?.[source];
        if (sourcePart === undefined) continue;
        for (const field of CONTRIBUTED_SOURCE_FIELDS) {
          copyField<ContributedSourceStatus>(status.sources[source], sourcePart, field);
        }
      }
    }
    return status;
  }

  start(options: StartOptions = {}): Promise<CaptureStatus> {
    if (this.transition) return this.transition;
    if (this.currentPhase !== 'idle') return Promise.resolve(this.getStatus());
    this.transition = this.doStart(options).finally(() => {
      this.transition = null;
    });
    return this.transition;
  }

  stop(options: StopOptions = {}): Promise<CaptureStatus> {
    if (this.transition) return this.transition.then(() => this.stop(options));
    if (this.currentPhase !== 'recording') return Promise.resolve(this.getStatus());
    this.transition = this.doStop(options).finally(() => {
      this.transition = null;
    });
    return this.transition;
  }

  /**
   * One chunk from a source: the renderer's (ipc.ts), or from M2-T10 the helper's call audio.
   * `capturedAtMs` is the wall clock of its first sample where it was captured; null (M1's
   * renderer, until M2-T12 sends it) dates it from its arrival instead.
   */
  pushAudio(source: AudioSource, pcm: Uint8Array, capturedAtMs: number | null = null): void {
    if (this.currentPhase !== 'recording' || !this.session) return;
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
    // The session and every feature that reads audio (M2-T11's silence warning on chunks that
    // arrive but carry nothing, M2-T15's backup) take it from the fan-out: add a sink
    // (addAudioSink), never a line here.
    this.audio.push(
      source,
      pcm,
      capturedAtMs ?? now - pcmBytesToMs(pcm.byteLength, PCM_SAMPLE_RATE),
    );
  }

  reportSourceState(source: AudioSource, state: AudioSourceState, message: string | null): void {
    if (this.currentPhase === 'idle') return;
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
    if (state === 'ended' && this.currentPhase === 'recording') {
      // A track that ends mid-call never comes back; only a new session reopens the device.
      this.error = `${AUDIO_SOURCE_LABEL[source]} stopped: ${message ?? 'the audio track ended'}. Press Stop, then Start again.`;
    }
    this.emitStatus();
  }

  private async doStart({ resume }: StartOptions): Promise<CaptureStatus> {
    if (this.options.startupError) {
      this.error = this.options.startupError;
      return this.getStatus();
    }
    const { logger, store } = this.options;
    this.error = null;
    this.notice = null;
    this.lastMeter = null;
    this.resetSessionState();
    // A resume's allowance starts afresh too (M2 D7): its saved sessions_opened also counts opens
    // made in the minute only (gate reopens, re-runs), so seeding from it could refuse this Start.
    this.budget.beginMeeting();
    this.setPhase('starting');
    let startedAtMs = this.clock();
    const meetingId = resume?.meetingId ?? randomUUID();
    let session: CaptureSession | null = null;
    let meetingCreated = false;
    try {
      if (resume !== undefined) {
        const meeting = store.getMeeting(meetingId);
        if (meeting === null) {
          throw new Error(`Meeting ${meetingId} cannot be resumed: it is not in the local store.`);
        }
        if (meeting.endedAt !== null) {
          throw new Error(`Meeting ${meetingId} cannot be resumed: it already ended.`);
        }
        startedAtMs = Date.parse(meeting.startedAt);
        if (!Number.isFinite(startedAtMs)) {
          throw new Error(
            `Meeting ${meetingId} cannot be resumed: its start "${meeting.startedAt}" is not a time.`,
          );
        }
        this.savedUsage = store.getSttUsage(meetingId);
      }
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
      if (resume === undefined) {
        store.createMeeting({
          id: meetingId,
          title: defaultMeetingTitle(new Date(startedAtMs)),
          startedAt: this.startedAt,
        });
        meetingCreated = true;
      }
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
            if (state === 'open') this.streamRetries[source] = null;
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
            this.streamRetries[source] = retryAtMs === null ? null : { reason, retryAtMs };
            this.error = this.streamFailureText(source, reason, retryAtMs);
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
      // The cap bounds one meeting: a resumed one has been recording since its first start.
      this.capFromMs = resume === undefined ? this.recordingSinceMs : startedAtMs;
      // Bound, not wrapped: when CaptureSession.pushAudio takes the capture time too (M2-T5), the
      // fan-out's third argument reaches it with no edit here.
      this.removeSessionSink = this.audio.add('speech-to-text', {
        onChunk: session.pushAudio.bind(session),
      });
      this.setPhase('recording');
      this.startMonitor();
      const live: RecordingStarted = {
        meetingId,
        meetingStartedAtMs: startedAtMs,
        resumed: resume !== undefined,
        session,
      };
      this.live = live;
      for (const listener of [...this.recordingListeners]) {
        this.tell('started', meetingId, () => listener.started?.(live));
      }
      logger.info('capture started', { meetingId, provider, resumed: resume !== undefined });
    } catch (error) {
      this.error = errorMessage(error);
      logger.error('capture start failed', { meetingId, error: this.error });
      try {
        if (session) await session.close();
        // A failed connect that reached the handshake may be billed: keep its numbers too.
        if ((this.stt?.usage().sessionsOpened ?? 0) > 0) {
          this.recordMeter(meetingId, 'start-failed', null);
        }
        // A failed resume leaves its meeting open as it was: CrashRecovery (M2-T23) decides.
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
    let discarded = false;
    this.setPhase('stopping');
    this.stopMonitor();
    this.removeSessionSink?.();
    this.removeSessionSink = null;
    try {
      if (session) {
        const meetingId = session.meetingId;
        this.saveStopReason(meetingId, reason);
        await session.close();
        this.recordMeter(meetingId, reason, null);
        if (this.stt !== null) this.lastMeter = this.meterStatus(this.stt);
        // A meeting with no line was never sent to Postgres: TranscriptUploader.syncMeeting creates
        // it only once it holds one, and lines are never deleted, so this delete cannot race an
        // upload. If the uploader ever creates meetings earlier again, this leaves Postgres a
        // meeting stuck in "recording".
        if (
          store.getMeeting(meetingId)?.remoteState === 'pending' &&
          store.deleteMeetingIfEmpty(meetingId)
        ) {
          discarded = true;
          logger.info('empty meeting discarded', { meetingId });
        } else {
          store.markMeetingEnded(meetingId, new Date(this.clock()).toISOString());
        }
        this.endRecording(reason, discarded);
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
      // Also after a stop that failed: a listener holding something for the recording (a power
      // save blocker, the helper's "recording on") must hear that it is over.
      this.endRecording(reason, discarded);
      this.notice = stopNotice(reason, new Date(this.clock()), this.guards, options.detail ?? null);
      this.session = null;
      this.resetSessionState();
      this.setPhase('idle');
    }
    return this.getStatus();
  }

  /**
   * `meetings.stop_reason`, written before the sessions close: a quit whose stop outruns
   * quitStopTimeoutMs then still says `quit`, and the next launch keeps it rather than `crash`
   * (TranscriptStore.endMeetingsLeftOpen). A store that refuses is logged; the stop goes on, since
   * the sessions bill until they close.
   */
  private saveStopReason(meetingId: string, reason: StopReason): void {
    try {
      this.options.store.setMeetingStopReason(meetingId, reason);
    } catch (error) {
      this.options.logger.error('stop reason not saved', {
        meetingId,
        reason,
        error: errorMessage(error),
      });
    }
  }

  /** Tells the listeners the recording is over, once per recording. */
  private endRecording(reason: StopReason, discarded: boolean): void {
    const live = this.live;
    if (live === null) return;
    this.live = null;
    const ended: RecordingEnded = { meetingId: live.meetingId, reason, discarded };
    for (const listener of [...this.recordingListeners]) {
      this.tell('ended', live.meetingId, () => listener.ended?.(ended));
    }
  }

  /** Runs one listener call; one that throws is logged and never stops Start, Stop or the rest. */
  private tell(event: keyof RecordingListener, meetingId: string, call: () => void): void {
    try {
      call();
    } catch (error) {
      this.options.logger.error('recording listener failed', {
        event,
        meetingId,
        error: errorMessage(error),
      });
    }
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
        // Missing from an older API: unknown, so the meter says "cost unknown", not "$NaN".
        pricePerHourUsd: token.stream.price_per_hour_usd ?? null,
        // Read per token, never cached: a reopen's fresh token carries the list as edited since.
        keyterms: token.stream.keyterms,
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
    // Here as well as at Stop: a Start that failed after adding the session's sink must not leave
    // a closed session in the fan-out.
    this.removeSessionSink?.();
    this.removeSessionSink = null;
    this.sources = { mic: emptySourceStatus(), system: emptySourceStatus() };
    this.streams = { mic: 'closed', system: 'closed' };
    this.streamMessages = { mic: null, system: null };
    this.streamErrors = { mic: null, system: null };
    this.streamRetries = { mic: null, system: null };
    this.stt = null;
    this.savedUsage = null;
    this.sttProvider = null;
    this.startedAt = null;
    this.recordingSinceMs = null;
    this.capFromMs = null;
    this.lastFinalAtMs = null;
    this.segmentsUnsaved = 0;
  }

  private setPhase(phase: CapturePhase): void {
    this.currentPhase = phase;
    this.emitStatus();
  }

  private startMonitor(): void {
    this.stopMonitor();
    this.monitorTimer = setInterval(() => {
      this.checkAudioFlow();
      this.checkForgottenStop();
      this.refreshRetryCountdowns();
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
   * and is M2-T11's silence warning, a fan-out sink (see pushAudio). Sources already `ended` or in `error` keep that
   * more specific state.
   *
   * Cost guard G2: past sttStallCloseMs with no chunk, the source's vendor session closes (it
   * bills silence otherwise, $0.15 an hour on AssemblyAI) and reopens with its next chunk.
   */
  private checkAudioFlow(): void {
    if (this.currentPhase !== 'recording' || this.recordingSinceMs === null) return;
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

  /** What the banner says about a source's failed stream; `retryAtMs` null: it will not reopen. */
  private streamFailureText(source: AudioSource, reason: string, retryAtMs: number | null): string {
    const waitMs = retryAtMs === null ? 0 : retryAtMs - this.clock();
    const next =
      retryAtMs === null
        ? 'Press Stop, then Start again.'
        : waitMs > 0
          ? `Reconnecting when its audio flows, in ${Math.ceil(waitMs / 1000)} s.`
          : 'Reconnecting when its audio flows.';
    return `Transcription of ${SPEAKER_TITLE[source]} (${SPEAKER_FOR_SOURCE[source]}) stopped: ${reason}. ${next}`;
  }

  /**
   * The reconnect wait, counted down while the banner shows it. Written once at the failure, "in
   * 2 s" (up to "in 60 s" after failures in a row) stayed on screen for as long as the other source
   * talked, while nothing was being attempted: a source reopens only with its next chunk, never on
   * a timer (CaptureSession.pushAudio), so once the wait is over it waits for audio, not seconds.
   */
  private refreshRetryCountdowns(): void {
    for (const source of AUDIO_SOURCES) {
      const retry = this.streamRetries[source];
      // Another error took the banner since: leave it alone.
      if (retry === null || this.error !== this.streamErrors[source]) continue;
      this.error = this.streamFailureText(source, retry.reason, retry.retryAtMs);
      this.streamErrors[source] = this.error;
      if (retry.retryAtMs <= this.clock()) this.streamRetries[source] = null; // nothing left to count
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
    if (this.currentPhase !== 'recording' || this.recordingSinceMs === null) return;
    const now = this.clock();
    const recordingForMs = now - (this.capFromMs ?? this.recordingSinceMs);
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
    const total = this.usage(stt);
    const bySource = { mic: this.usage(stt, 'mic'), system: this.usage(stt, 'system') };
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

  /** What the meeting used: this run's sessions, plus a resumed meeting's saved row. */
  private usage(stt: SpeechToText, source?: AudioSource): SttUsage {
    const live = stt.usage(source);
    const saved = this.savedUsage;
    if (saved === null) return live;
    return addUsage(source === undefined ? saved.total : saved.bySource[source], live);
  }

  private meterStatus(stt: SpeechToText): SttMeterStatus {
    return {
      vendorName: stt.vendorName,
      total: toMeter(this.usage(stt)),
      sources: { mic: toMeter(this.usage(stt, 'mic')), system: toMeter(this.usage(stt, 'system')) },
    };
  }

  private emitStatus(): void {
    this.events.emit('status', this.getStatus());
  }
}

/** Copies one field when the contribution sets it; a field left out keeps what is there. */
function copyField<T extends object>(to: T, from: T, field: keyof T): void {
  const value = from[field];
  if (value !== undefined) to[field] = value;
}

/**
 * A resumed meeting's saved use plus this run's (M2 D7). An unknown cost on either side stays
 * unknown: a partial sum would read as the whole cost (stt/usage.ts).
 */
function addUsage(saved: SttUsage, live: SttUsage): SttUsage {
  return {
    sessionsOpened: saved.sessionsOpened + live.sessionsOpened,
    connectedMs: saved.connectedMs + live.connectedMs,
    audioSentMs: saved.audioSentMs + live.audioSentMs,
    droppedChunks: saved.droppedChunks + live.droppedChunks,
    estimatedCostUsd:
      saved.estimatedCostUsd === null || live.estimatedCostUsd === null
        ? null
        : Math.round((saved.estimatedCostUsd + live.estimatedCostUsd) * 10_000) / 10_000,
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
