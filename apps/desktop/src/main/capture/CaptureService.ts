import { randomUUID } from 'node:crypto';
import {
  emptySourceStatus,
  fitMeetingTitle,
  idleCaptureStatus,
  isApiBlank,
  NO_AUDIO_WARNING_MS,
  storedMeetingText,
  type AudioSourceState,
  type CapturePhase,
  type CaptureStatus,
  type CaptureWarning,
  type SilenceGateState,
  type SourceStatus,
  type StartCaptureRequest,
  type SttMeter,
  type SttMeterStatus,
  type SttStreamState,
} from '../../shared/capture';
import { formatClock } from '../../shared/clock';
import { PCM_ENCODING, PCM_SAMPLE_RATE } from '../../shared/ipc';
import { pcmBytesToMs } from '../../shared/pcm';
import {
  AUDIO_SOURCES,
  type AudioSource,
  type InterimTranscript,
  type TranscriptSegment,
} from '../../shared/transcript';
import type { SttTokenApi } from '../api/ApiClient';
import { type CostGuards, DEFAULT_COST_GUARDS } from '../costGuards';
import { parseStartCaptureRequest } from '../ipc-validation';
import { errorMessage, type Logger } from '../logger';
import type { MicrophoneAccess } from '../permissions';
import type { MeetingSttUsage, TranscriptStore } from '../store/TranscriptStore';
import type { SpeechToTextFactory } from '../stt/createSpeechToText';
import type { SpeechToText, SttStreamSettings } from '../stt/SpeechToText';
import { estimateCostUsd, type SttUsage } from '../stt/usage';
import { streamSettingsMismatch } from '../stt/streamSettings';
import type { TranscriptUploader } from '../upload/TranscriptUploader';
import { Emitter } from '../util/emitter';
import { withTimeout } from '../util/time';
import { AudioFanout, type AudioSink } from './AudioFanout';
import { CaptureSession, type StreamCredentials } from './CaptureSession';
import {
  type CaptureErrorWords,
  configurationWords,
  MicrophoneDeniedError,
  ResumeRefusedError,
  startFailureWords,
  stopFailureWords,
  streamFailureWords,
  StreamFormatError,
  SttProviderChangedError,
  unsavedLinesWords,
} from './errorWords';
import type { SilenceGateSettings } from './SilenceGate';
import { SttOpenBudget } from './SttOpenBudget';
import { type StopReason, stopNotice } from './stopReasons';
import { KEYTERMS_REJECTED_MESSAGE } from './warnings';

export interface CaptureServiceOptions {
  store: TranscriptStore;
  api: SttTokenApi;
  /**
   * Also the notes check both delete sites ask (`TranscriptUploader.hasNotes`), and the editors'
   * save they wait for first (`TranscriptUploader.saveOpenNotes`). There is no notes option here on
   * purpose: wired into the uploader once, the check cannot disagree with its pending rule.
   */
  uploader: TranscriptUploader;
  createSpeechToText: SpeechToTextFactory;
  ensureMicrophoneAccess: () => Promise<MicrophoneAccess>;
  logger: Logger;
  /** Only "fake" is honoured: it skips the vendor token and transcribes audio energy (development). */
  sttProviderOverride: string | null;
  /**
   * A configuration problem found at startup. Start fails with it until it is fixed: the status
   * says it in plain words (errorWords.ts configurationWords), this text is its `errorDetail`.
   */
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

/**
 * A Start: the request's fields (how it was started, the title, the calendar event), checked as
 * the window's are (parseStartCaptureRequest), or a resume.
 */
export interface StartOptions extends StartCaptureRequest {
  /**
   * Continue this open meeting instead of creating one. It keeps the title, source and event it
   * was stored with: the request's fields and the enricher are not used.
   */
  resume?: ResumeMeeting;
}

/**
 * Completes what a start request leaves out, before its meeting is made: M5-T9c's links a start
 * made near exactly one calendar event to it (M5 design, "Manual start near a meeting"). It sees
 * every start that makes a meeting, whatever its source, a prompt's included (which carries its
 * event already), and answers the request to start with. Main cuts its answer's title to fit
 * (fitMeetingTitle), so it may pass an event's title as it is, then checks the answer as the
 * window's request is; an enricher that throws or answers a request main would refuse is logged,
 * and the start goes on with the request as it came: a note without its event beats no note. Its
 * error's message goes to the log, so it never quotes an event's title or attendees.
 */
export type StartRequestEnricher = (request: StartCaptureRequest) => StartCaptureRequest;

/**
 * How long a start request from main waits for the window to take it (M5 design, "One click
 * starts the note"): a window still loading gets that long; after it, the click is stale.
 */
export const PENDING_START_TTL_MS = 60_000;

interface PendingStart {
  request: StartCaptureRequest;
  /** Clock time it was made. */
  atMs: number;
}

export interface StopOptions {
  /** Wait for the uploader to drain. Off when quitting: the uploader resumes on next launch. */
  flushUploads?: boolean;
  /** Why it stops (default `user`): logged and kept with the meeting's usage; see stopNotice. */
  reason?: StopReason;
  /**
   * Extra words for the notice: the call app's name for `call-ended` ("the call in Zoom ended").
   * Never an error's text: the notice is on the page (docs/design.md, Words from main), so a crash's
   * reason stays in the caller's log line (lifecycle.ts stopFor).
   */
  detail?: string;
}

interface CaptureEvents extends Record<string, unknown> {
  status: CaptureStatus;
  segment: TranscriptSegment;
  interim: InterimTranscript;
  /** requestStart left a request for the window to take (ipc.ts tells the window). */
  'start-requested': StartCaptureRequest;
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
  /**
   * True when the meeting had no line and no notes and was deleted: nothing to upload, nothing to
   * write up. A meeting nobody spoke in that has notes is kept and ended (`discarded` false). So
   * is one whose notes could not be saved or read in time (keepsForNotes): the uploader's pending
   * rule may still discard it as empty a tick later, so a listener that acts on a lineless meeting
   * must expect it to be gone.
   */
  discarded: boolean;
  /**
   * True when Stop threw before it ended the meeting (a store write refused: full disk, SQLite
   * busy). Its `ended_at` may still be NULL, so it stays resumable and CrashRecovery (M2-T23)
   * decides at the next launch; the error is in the status. A listener that acts on an ended
   * meeting (notes after Stop, the last usage upload) checks this first.
   */
  stopFailed: boolean;
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
   * Stop closed both streams, saved the last lines and ended (or discarded) the meeting, unless
   * `stopFailed` says it threw first; the upload flush may still run. Every `started` gets exactly
   * one `ended`, a failed Stop included (a listener holding something for the recording must let it
   * go); a Start that failed gets neither.
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
/**
 * A monitor tick this long after the last one means the process was suspended (a Mac asleep, a
 * stopped debugger), not busy: nothing in main blocks for seconds. The time in between is no
 * recording time (checkForgottenStop).
 */
const MONITOR_SUSPENDED_GAP_MS = 5_000;

/**
 * How long a delete site waits for the open editors to save (keepsForNotes): the 1 s main gives
 * each window at quit (M4 plan, "Saving at quit"). Past it the meeting is kept, never deleted.
 */
const OPEN_NOTES_SAVE_TIMEOUT_MS = 1_000;

/** A token as the session takes it, and the vendor it is for (resolveStt). */
interface ResolvedStt extends StreamCredentials {
  provider: string;
  pricePerHourUsdWithoutKeyterms: number | null;
}

/** What the silence gate kept closed (M3-T20), as the meter shows it. */
interface GateFigures {
  gatedMs: number;
  estimatedSavedUsd: number | null;
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
  /**
   * Start's token's price per stream-hour: a resumed meeting's saved time closed for silence is
   * priced at it, since stt_usage keeps the time and not the price (M3-T20).
   */
  private pricePerHourUsd: number | null = null;
  private startedAt: string | null = null;
  /** The recording meeting's title, from the moment its meeting is made or resumed. */
  private title: string | null = null;
  private enricher: StartRequestEnricher | null = null;
  /** A start main asked for, until the window takes it or it is too old (requestStart). */
  private pendingStart: PendingStart | null = null;
  private sources: Record<AudioSource, SourceStatus> = {
    mic: emptySourceStatus(),
    system: emptySourceStatus(),
  };
  private streams: Record<AudioSource, SttStreamState> = { mic: 'closed', system: 'closed' };
  private streamMessages: Record<AudioSource, string | null> = { mic: null, system: null };
  /** The error each source's last failure set, so its recovery can clear exactly that one. */
  private streamErrors: Record<AudioSource, CaptureErrorWords | null> = { mic: null, system: null };
  /** What the session warned about each source (onWarning), shown until Stop. */
  private sessionWarnings: Record<AudioSource, CaptureWarning | null> = { mic: null, system: null };
  /**
   * The status's `error` (the sentence) and `errorDetail` (the raw text), set together from
   * errorWords.ts so the page never gets one without the other, and never the raw text alone.
   */
  private error: CaptureErrorWords | null = null;
  private notice: string | null = null;
  private segmentsUnsaved = 0;
  /** The start or stop under way: a stop waits for either, a Start waits out a stop (start()). */
  private transition: { kind: 'start' | 'stop'; done: Promise<CaptureStatus> } | null = null;
  private monitorTimer: NodeJS.Timeout | null = null;
  /** Clock time of the monitor's last tick (or its start); a long gap before the next is a sleep. */
  private lastMonitorTickMs: number | null = null;
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
    this.error = this.startupErrorWords();
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
        ...this.errorPart(),
        meter: this.lastMeter,
        notice: this.notice,
      };
    }
    return {
      phase: this.currentPhase,
      meetingId: this.session?.meetingId ?? null,
      // Named with the meeting: null while starting, as the meeting id is.
      title: this.session === null ? null : this.title,
      startedAt: this.startedAt,
      sttProvider: this.sttProvider,
      sources: { mic: { ...this.sources.mic }, system: { ...this.sources.system } },
      streams: { ...this.streams },
      streamMessages: { ...this.streamMessages },
      segmentsStored: this.session?.storedSegmentCount ?? 0,
      segmentsUnsaved: this.segmentsUnsaved,
      upload,
      ...this.errorPart(),
      meter: this.stt === null ? this.lastMeter : this.meterStatus(this.stt),
      notice: this.notice,
      ...this.sessionWarningsPart(),
    };
  }

  /** The error as the status carries it: the plain sentence, and the raw text for Details. */
  private errorPart(): Pick<CaptureStatus, 'error' | 'errorDetail'> {
    return { error: this.error?.sentence ?? null, errorDetail: this.error?.detail ?? null };
  }

  /** The startup configuration error in words, or null when there is none. */
  private startupErrorWords(): CaptureErrorWords | null {
    const { startupError } = this.options;
    return startupError === null ? null : configurationWords(startupError);
  }

  /**
   * The session's warnings in source order, joined with the contributors' (withContributions).
   * Left out when there are none: an empty list would go into every status.
   */
  private sessionWarningsPart(): Pick<CaptureStatus, 'warnings'> {
    const warnings = AUDIO_SOURCES.flatMap((source) => this.sessionWarnings[source] ?? []);
    return warnings.length === 0 ? {} : { warnings };
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

  /**
   * Starts a recording, or resumes one. Never rejects: a refusal (no microphone access, a request
   * that does not check, the open budget, the vendor) comes back as the status's `error`, a plain
   * sentence (errorWords.ts startFailureWords) with the raw text in `errorDetail`, which is how a
   * requested start's outcome reaches whoever asked (M5-T9b reads the status).
   *
   * A Start while a stop is under way starts once that stop is done, as stop() waits out a start:
   * a stop drains uploads for up to 15 s, and answered with its idle status, a prompt's Take notes
   * on the next meeting lost its title and event with no error and no log line. A Start while a
   * recording starts or runs joins it instead (join()).
   */
  start(options: StartOptions = {}): Promise<CaptureStatus> {
    if (this.transition?.kind === 'stop') {
      return this.transition.done.then(() => this.start(options));
    }
    if (this.transition !== null) return this.join(options, this.transition.done);
    if (this.currentPhase !== 'idle') return this.join(options, Promise.resolve(this.getStatus()));
    const done = this.doStart(options).finally(() => {
      this.transition = null;
    });
    this.transition = { kind: 'start', done };
    return done;
  }

  stop(options: StopOptions = {}): Promise<CaptureStatus> {
    if (this.transition) return this.transition.done.then(() => this.stop(options));
    if (this.currentPhase !== 'recording') return Promise.resolve(this.getStatus());
    const done = this.doStop(options).finally(() => {
      this.transition = null;
    });
    this.transition = { kind: 'stop', done };
    return done;
  }

  /**
   * A Start while a recording starts or runs: a second click, or a window's Start racing another.
   * It answers that recording's status, `status`, with no error, so a request of its own (a
   * source, a title, an event, a resume) goes nowhere: logged here, since nothing else says so.
   * M5-T9b stops a recording note before it asks for a start (requestStart).
   */
  private join(options: StartOptions, status: Promise<CaptureStatus>): Promise<CaptureStatus> {
    const { resume, source, title, calendarEvent } = options;
    if (
      resume !== undefined ||
      source !== undefined ||
      title !== undefined ||
      calendarEvent !== undefined
    ) {
      this.options.logger.warn('start request not applied: a recording is starting or running', {
        source: source ?? 'manual',
        linked: calendarEvent !== undefined,
        resume: resume !== undefined,
        phase: this.currentPhase,
        meetingId: this.session?.meetingId ?? null,
      });
    }
    return status;
  }

  /**
   * The enricher every start that makes a meeting runs (StartRequestEnricher). M5-T9c sets it
   * from its slot in index.ts, after createCaptureRuntime has built this service, hence a setter.
   * Throws when one is set already: a second would silently replace the first.
   */
  setStartRequestEnricher(enricher: StartRequestEnricher): void {
    if (this.enricher !== null) throw new Error('a start request enricher is already set');
    this.enricher = enricher;
  }

  /**
   * Asks the window to start a recording (a prompt's Take notes, M5-T9b): audio capture runs in
   * the renderer, so main cannot start one alone. The request waits here until the window takes
   * it (takePendingStart, on the `start-requested` event or as its page loads) and starts with it,
   * through start() and the open budget like any Start. A later request replaces a waiting one.
   * Its title is cut to fit (fitMeetingTitle), so a caller may pass an event's title as it is;
   * throws, naming the field, on anything else the window's start would refuse.
   *
   * Trap: stop a recording note first (await stop(), then this). start() waits out a stop under
   * way, but joins a recording that starts or runs: the answer is that note's status with no
   * error, and this request's title and event go nowhere but a warning in the log (join()).
   */
  requestStart(request: StartCaptureRequest): void {
    const checked = parseStartCaptureRequest(withTitleCutToFit(request));
    this.pendingStart = { request: checked, atMs: this.clock() };
    this.options.logger.info('start requested', {
      source: checked.source ?? 'manual',
      linked: checked.calendarEvent !== undefined,
    });
    this.events.emit('start-requested', checked);
  }

  /**
   * The start request waiting for the window, once: a second call answers null, so a request
   * runs once however many pages ask. Null as well when none waits, or once it is older than
   * PENDING_START_TTL_MS (on the wall clock, so a Mac that slept through the wait drops it).
   */
  takePendingStart(): StartCaptureRequest | null {
    const pending = this.pendingStart;
    this.pendingStart = null;
    if (pending === null) return null;
    const ageMs = this.clock() - pending.atMs;
    if (ageMs > PENDING_START_TTL_MS) {
      this.options.logger.warn('start request dropped: no window took it in time', {
        source: pending.request.source ?? 'manual',
        ageMs,
      });
      return null;
    }
    return pending.request;
  }

  /**
   * One chunk from a source: the renderer's (ipc.ts), or from M2-T10 the helper's call audio.
   * `capturedAtMs` is the wall clock of its first sample where it was captured; null (a sender
   * with none: the renderer has sent one with every chunk since M2-T12) dates it from its arrival.
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
    // A track that ends mid-call never comes back; only a new session reopens the device.
    //
    // No `error` for it: SignalMonitor turns this health (`ended` or `error`) into the loud
    // `source-ended` warning (capture/warnings.ts), which the banner, the header's status line and
    // a macOS notification say. An error set here as well said the same cut twice on every page
    // but the meeting's, and outlived the recording with "Press Stop" after Stop. `message` stays
    // the source's own (Details).
    this.session?.closeSource(source, message ?? `the audio source reported ${state}`);
    this.emitStatus();
  }

  private async doStart({ resume, ...asked }: StartOptions): Promise<CaptureStatus> {
    if (this.options.startupError !== null) {
      this.error = this.startupErrorWords();
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
      // Checked here as well as at the IPC: main's own callers pass typed requests whose lengths
      // no type bounds, and a meeting the API refuses to create never reaches the server.
      const request = resume === undefined ? this.enrich(parseStartCaptureRequest(asked)) : {};
      if (resume !== undefined) {
        const meeting = store.getMeeting(meetingId);
        if (meeting === null) {
          throw new ResumeRefusedError(meetingId, 'it is not in the local store.');
        }
        if (meeting.endedAt !== null) {
          throw new ResumeRefusedError(meetingId, 'it already ended.');
        }
        startedAtMs = Date.parse(meeting.startedAt);
        if (!Number.isFinite(startedAtMs)) {
          throw new ResumeRefusedError(
            meetingId,
            `its start "${meeting.startedAt}" is not a time.`,
          );
        }
        this.savedUsage = store.getSttUsage(meetingId);
        this.title = meeting.title;
      }
      if ((await this.options.ensureMicrophoneAccess()) === 'denied') {
        throw new MicrophoneDeniedError();
      }
      // ONE token here, which names the vendor. It opens both sources only when the vendor's
      // token is reusable (AssemblyAI); a single-connection one (xAI's client secret: one
      // websocket, ever) opens the first source alone, and CaptureSession.open fetches the other's
      // beside it. Never hand this token to a second open here: every Start failed with "xAI:
      // rejected with HTTP 401" while it served both (2026-10-08). Every other open fetches its
      // own the same way (CaptureSession.reopen, GateTokens, rerun/GapRetranscriber.open).
      const { provider, accessToken, settings, pricePerHourUsdWithoutKeyterms } =
        await this.resolveStt();
      // Checked before the meeting exists: a session on the wrong format would store nonsense lines.
      const mismatch = streamSettingsMismatch(settings);
      if (mismatch !== null) throw new StreamFormatError(mismatch);
      const stt = this.options.createSpeechToText(provider);
      this.stt = stt;
      this.sttProvider = provider;
      this.pricePerHourUsd = settings.pricePerHourUsd;
      this.startedAt = new Date(startedAtMs).toISOString();
      if (resume === undefined) {
        // Kept as the API stores it (storedMeetingText), and blank as the API and the start check
        // read it (isApiBlank), never as `=== ''`: a title of U+0000 and spaces (with trim()), or
        // of U+001C to U+001F (which the stored text keeps and Python's strip() trims), stayed an
        // invisible title here while the server named the meeting "Untitled meeting".
        const title = storedMeetingText(request.title ?? '');
        this.title = isApiBlank(title) ? defaultMeetingTitle(new Date(startedAtMs)) : title;
        store.createMeeting({
          id: meetingId,
          title: this.title,
          startedAt: this.startedAt,
          startSource: request.source ?? 'manual',
          calendarEvent: request.calendarEvent ?? null,
        });
        meetingCreated = true;
      }
      session = new CaptureSession({
        meetingId,
        meetingStartedAtMs: startedAtMs,
        stt,
        accessToken,
        settings,
        pricePerHourUsdWithoutKeyterms,
        refreshCredentials: () => this.freshCredentials(provider),
        reopenBufferMs: this.guards.sttReopenBufferMs,
        budget: this.budget,
        reopenBackoffMs: this.guards.sttReopenBackoffMs,
        reopenBackoffMaxMs: this.guards.sttReopenBackoffMaxMs,
        silenceGate: this.silenceGateSettings(),
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
            this.error = streamFailureWords(source, reason, retryAtMs !== null);
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
          onWarning: (source, warning) => {
            // Quiet: on screen only, as the Notifier posts loud warnings alone. The call goes on,
            // without the list on that source until Stop (CaptureSession.connect), so the warning
            // holds until then; the session logged it. The first warning to hold all meeting, so a
            // later loud one on the same source (M2-T11's mic-dead) comes on top of it: a view that
            // joins a source's warnings into one row must date a loud row by its loud warnings,
            // not the earliest since, or a mic silent for 8 s reads as silent since Start.
            //
            // The session's text names the vendor ("Jargon list rejected by xAI"): it stays in the
            // session's log line and capture event, and the warning reads the plain words.
            this.sessionWarnings[source] ??= {
              kind: warning.kind,
              source,
              since: new Date(this.clock()).toISOString(),
              message: KEYTERMS_REJECTED_MESSAGE,
              loud: false,
            };
            this.emitStatus();
          },
          onSaveFailure: (source, reason) => {
            // Recording goes on. The likely causes (disk full, the file locked past SQLite's 5 s
            // busy timeout) are often brief or fixable mid-call, and M1 keeps no audio to
            // re-transcribe from (that is M2), so stopping would lose every later line as well.
            // The count and this error stay on screen so the person can decide to stop.
            this.segmentsUnsaved += 1;
            // House rule 1: the count and the way out stay on screen (unsavedLinesWords); the
            // store's reason is the detail, for Details and the log.
            this.error = unsavedLinesWords(this.segmentsUnsaved, reason);
            this.emitStatus();
          },
        },
      });
      await session.open();
      this.session = session;
      this.recordingSinceMs = this.clock();
      // The cap bounds one meeting: a resumed one has been recording since its first start.
      this.capFromMs = resume === undefined ? this.recordingSinceMs : startedAtMs;
      // Bound, not wrapped: CaptureSession.pushAudio takes AudioSink.onChunk's three arguments in
      // order, so each chunk's capture time reaches it; a wrapper that passed two would drop it.
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
      logger.info('capture started', {
        meetingId,
        provider,
        resumed: resume !== undefined,
        source: resume === undefined ? (request.source ?? 'manual') : null,
      });
    } catch (error) {
      this.error = startFailureWords(error);
      logger.error('capture start failed', { meetingId, error: this.error.detail });
      try {
        if (session) await session.close();
        // A failed connect that reached the handshake may be billed: keep its numbers too.
        if ((this.stt?.usage().sessionsOpened ?? 0) > 0) {
          this.recordMeter(meetingId, 'start-failed', null);
        }
        // A failed resume leaves its meeting open as it was: CrashRecovery (M2-T23) decides.
        //
        // Trap: one of the three sites that decide which meetings no one spoke in are kept, with
        // the Stop below and the pending rule in TranscriptUploader.syncMeeting; all three ask the
        // uploader's hasNotes, and both here only once the editors have saved (keepsForNotes). The
        // uploader is the only code that creates meetings in Postgres, and NotesSync waits for it,
        // so a meeting deleted here with notes strands them for good. One with notes is ended
        // instead, which lets the pending rule create it; left open, it would never be created
        // and would read as a crash at the next launch.
        if (meetingCreated) {
          if (await this.keepsForNotes(meetingId)) {
            store.markMeetingEnded(meetingId, new Date(this.clock()).toISOString());
          } else {
            store.deleteMeetingIfEmpty(meetingId);
          }
        }
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
        // it only once it holds one, or once it has ended with notes (not before this Stop ends
        // it), and lines are never deleted, so this delete cannot race an upload. If the uploader
        // ever creates meetings earlier again, this leaves Postgres a meeting stuck in "recording".
        //
        // Trap: one of the three sites that decide which meetings no one spoke in are kept, with
        // the failed Start above and the pending rule in TranscriptUploader.syncMeeting; all three
        // ask the uploader's hasNotes before the delete, and this one only once the editors have
        // saved (keepsForNotes: Stop rarely blurs them). The uploader is the only code that creates
        // meetings in Postgres and NotesSync waits for it, so a meeting deleted here with notes
        // strands them for good. One with notes is ended below, and the pending rule creates it.
        // A meeting with a line is never deleted, so it does not wait for the editors.
        if (
          store.getMeeting(meetingId)?.remoteState === 'pending' &&
          store.countSegments(meetingId) === 0 &&
          !(await this.keepsForNotes(meetingId)) &&
          store.deleteMeetingIfEmpty(meetingId)
        ) {
          discarded = true;
          logger.info('empty meeting discarded', { meetingId });
        } else {
          store.markMeetingEnded(meetingId, new Date(this.clock()).toISOString());
        }
        this.endRecording({ reason, discarded, stopFailed: false });
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
      this.error = stopFailureWords(error);
      logger.error('capture stop failed', { error: this.error.detail, reason });
    } finally {
      // Also after a stop that failed: a listener holding something for the recording (a power
      // save blocker, the helper's "recording on") must hear that it is over. The try tells the
      // listeners itself once the meeting is ended or discarded, so this call only speaks when the
      // try threw first, with the meeting maybe still open: `stopFailed`, never a plain end.
      this.endRecording({ reason, discarded, stopFailed: true });
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

  /**
   * Whether a meeting no one spoke in is kept for its notes, by the uploader's check
   * (`TranscriptUploader.hasNotes`), so both delete sites here and its pending rule always agree.
   *
   * Trap: the open editors save first (`TranscriptUploader.saveOpenNotes`), and the check must
   * never move before that save. An editor writes 400 ms after the last keystroke
   * (renderer/src/notes/debouncedSaver.ts), and the tray, the shortcut, Cmd-Q and the auto-stops
   * stop without blurring it. Asked first, a note typed just before them reads as none, the
   * meeting is deleted, and the save that lands next waits for a meeting that is gone, for good
   * (NotesSync). At quit, this save is the one in time: the quit hook's flush runs after Stop.
   *
   * A save that fails or outlasts OPEN_NOTES_SAVE_TIMEOUT_MS, or a check that fails, keeps the
   * meeting: a delete could strand notes for good, while a kept meeting is decided again by the
   * uploader's pending rule on its next tick (Stop's own upload flush, or 2 s later), with whatever
   * has saved by then; a failed check shows in the upload status until notes.sqlite reads again. A
   * window that saves only after that tick still finds the meeting gone: the plan's 1 s limit, as
   * at quit.
   */
  private async keepsForNotes(meetingId: string): Promise<boolean> {
    const { uploader, logger } = this.options;
    try {
      await withTimeout(
        uploader.saveOpenNotes(),
        OPEN_NOTES_SAVE_TIMEOUT_MS,
        'saving the open notes',
      );
      return uploader.hasNotes(meetingId);
    } catch (error) {
      logger.error('kept a meeting whose notes could not be checked', {
        meetingId,
        error: errorMessage(error),
      });
      return true;
    }
  }

  /**
   * The request as the enricher completes it, its title cut to fit and then checked as the
   * window's is (StartRequestEnricher). A failure is logged with the request's source, never its
   * title or event (calendar content), and the request goes on as it came.
   */
  private enrich(request: StartCaptureRequest): StartCaptureRequest {
    const enricher = this.enricher;
    if (enricher === null) return request;
    try {
      return parseStartCaptureRequest(withTitleCutToFit(enricher(request)));
    } catch (error) {
      this.options.logger.error('start request enricher failed', {
        source: request.source ?? 'manual',
        error: errorMessage(error),
      });
      return request;
    }
  }

  /** Tells the listeners the recording is over, once per recording. */
  private endRecording(outcome: Omit<RecordingEnded, 'meetingId'>): void {
    const live = this.live;
    if (live === null) return;
    this.live = null;
    const ended: RecordingEnded = { meetingId: live.meetingId, ...outcome };
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

  private async resolveStt(): Promise<ResolvedStt> {
    if (this.options.sttProviderOverride === 'fake') {
      return {
        provider: 'fake',
        accessToken: '',
        settings: FAKE_STREAM_SETTINGS,
        pricePerHourUsdWithoutKeyterms: FAKE_STREAM_SETTINGS.pricePerHourUsd,
        // The fake's empty token never expires.
        expiresAtMs: null,
      };
    }
    const token = await this.options.api.getSttToken();
    return {
      provider: token.provider,
      accessToken: token.access_token,
      // From when it arrived: the silence gate's prefetched token is refreshed before this, and a
      // gate reopen fetches anew when it has under 5 s left (CaptureSession, M3-T20). A lifetime of
      // 0 (the API's fake vendor, whose empty token never expires) or none at all (the response is
      // cast, not validated) is no known expiry: read as now, it would be fetched again every 10 s.
      expiresAtMs:
        Number.isFinite(token.expires_in) && token.expires_in > 0
          ? this.clock() + token.expires_in * 1000
          : null,
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
      // A stream opened with no list once the vendor refused it (CaptureSession.streamSettings).
      // Missing from an older API, mapped as the price above: the session then meters such a
      // stream at the price with the list, which errs high.
      pricePerHourUsdWithoutKeyterms: token.stream.price_per_hour_usd_without_keyterms ?? null,
    };
  }

  /**
   * Credentials for a reopen, mid-meeting, and for each Start open after the first when the
   * vendor's token opens one connection (SttCredentialUse): one fresh token per call, never cached
   * here, so no two opens share one. The vendor and the audio format must be the ones the meeting
   * started with: the session's adapter cannot switch vendor, and another format would be
   * transcribed as garbage with no error.
   */
  private async freshCredentials(provider: string): Promise<StreamCredentials> {
    const { provider: issued, ...credentials } = await this.resolveStt();
    if (issued !== provider) throw new SttProviderChangedError(provider, issued);
    const mismatch = streamSettingsMismatch(credentials.settings);
    if (mismatch !== null) throw new StreamFormatError(mismatch);
    return credentials;
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
    this.sessionWarnings = { mic: null, system: null };
    this.stt = null;
    this.savedUsage = null;
    this.sttProvider = null;
    this.pricePerHourUsd = null;
    this.startedAt = null;
    this.title = null;
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
    this.lastMonitorTickMs = this.clock();
    this.monitorTimer = setInterval(() => {
      const suspendedForMs = this.suspendedSinceLastTick();
      this.checkAudioFlow();
      // Not on the tick that finds a sleep: see checkForgottenStop.
      if (suspendedForMs === 0) this.checkForgottenStop();
      // Every tick, changed or not. While main records and the window captures no mic (a reload,
      // a start from the tray), M2-T12's followMain opens it on the next status the page gets;
      // besides its first read and the focus read, this tick is what brings one. Sent only on a
      // change, that mic stayed shut until something else changed.
      this.emitStatus();
    }, MONITOR_INTERVAL_MS);
  }

  private stopMonitor(): void {
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.monitorTimer = null;
    this.lastMonitorTickMs = null;
  }

  /**
   * Stamps this tick and returns how long the process was suspended before it (0 when it was not).
   * The suspended time is taken out of the recording: the three clock anchors G5 and the no-audio
   * check count from move forward by it, so a sleep is neither recording time nor silence.
   */
  private suspendedSinceLastTick(): number {
    const now = this.clock();
    const last = this.lastMonitorTickMs;
    this.lastMonitorTickMs = now;
    if (last === null || now - last < MONITOR_SUSPENDED_GAP_MS) return 0;
    const gap = now - last;
    // Capped at now: a final line may have landed between the wake and this tick.
    const shift = (anchor: number | null) => (anchor === null ? null : Math.min(anchor + gap, now));
    this.recordingSinceMs = shift(this.recordingSinceMs);
    this.capFromMs = shift(this.capFromMs);
    this.lastFinalAtMs = shift(this.lastFinalAtMs);
    return gap;
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

  /**
   * Cost guard G5: a Stop nobody pressed. With silence still flowing (a muted mic, call audio
   * without its permission) the stall close never fires and both sessions bill, $0.30 an hour on
   * AssemblyAI, for as long as the app stays open: overnight is $4.20. So a recording with no final
   * line from either source for noSpeechStopMs stops, and any recording stops at maxRecordingMs,
   * both through the normal stop (last lines saved, sessions finished and closed).
   *
   * Trap: time the Mac slept counts as neither (suspendedSinceLastTick), and the tick that finds a
   * sleep never runs this check. Timers fire at wake, often before Electron delivers `resume`
   * (PowerCoordinator), so a check on the wall clock stopped a recording that slept for
   * noSpeechStopMs or more with `no-speech`, and PowerCoordinator's `system-sleep` stop, which
   * decides that case on `resume`, found it already stopping. The sleep's own reason must win.
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
    // What the silence gate kept closed (M3-T20): in the log line beside each figure, and its time
    // in the saved row (stt_usage.gated_ms), which SttUsageUploader sends up.
    const gated = {
      total: this.gateFigures(),
      mic: this.gateFigures('mic'),
      system: this.gateFigures('system'),
    };
    const { logger, store } = this.options;
    logger.info(stopReason === null ? 'stt meter' : 'stt meter at stop', {
      meetingId,
      provider,
      closedSource,
      stopReason,
      total: { ...total, ...gated.total },
      mic: { ...bySource.mic, ...gated.mic },
      system: { ...bySource.system, ...gated.system },
      silenceGate: this.silenceGateState(),
      gateReopens: this.session?.gateReopens ?? 0,
    });
    try {
      store.saveSttUsage({
        meetingId,
        provider,
        total,
        bySource: {
          mic: { ...bySource.mic, gatedMs: gated.mic.gatedMs },
          system: { ...bySource.system, gatedMs: gated.system.gatedMs },
        },
        gatedMs: gated.total.gatedMs,
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

  /**
   * What the silence gate kept closed this meeting (M3-T20), one source or both: the session's,
   * plus a resumed meeting's saved time (savedUsage, priced at this run's Start price). Read while
   * the session lives: Stop computes the last meter before it lets the session go.
   */
  private gateFigures(source?: AudioSource): GateFigures {
    const live = this.session?.gateUsage(source) ?? { gatedMs: 0, estimatedSavedUsd: 0 };
    const saved = this.savedUsage;
    const savedMs = (source === undefined ? saved?.gatedMs : saved?.bySource[source].gatedMs) ?? 0;
    if (savedMs === 0) return live;
    const savedUsd = estimateCostUsd(savedMs, this.pricePerHourUsd);
    return {
      gatedMs: savedMs + live.gatedMs,
      estimatedSavedUsd:
        savedUsd === null || live.estimatedSavedUsd === null
          ? null
          : Math.round((savedUsd + live.estimatedSavedUsd) * 10_000) / 10_000,
    };
  }

  /** The gate's settings for a session, or null when sttSilenceCloseMs 0 turns it off. */
  private silenceGateSettings(): SilenceGateSettings | null {
    const { sttSilenceCloseMs, sttSilencePreRollMs, sttSilenceReopensPerMeeting } = this.guards;
    if (sttSilenceCloseMs <= 0) return null;
    return {
      closeAfterMs: sttSilenceCloseMs,
      preRollMs: sttSilencePreRollMs,
      reopensPerMeeting: sttSilenceReopensPerMeeting,
    };
  }

  /** The session's gate state; before its session exists, what the settings make it. */
  private silenceGateState(): SilenceGateState {
    return this.session?.silenceGateState ?? (this.silenceGateSettings() === null ? 'off' : 'on');
  }

  private meterStatus(stt: SpeechToText): SttMeterStatus {
    return {
      vendorName: stt.vendorName,
      total: toMeter(this.usage(stt), this.gateFigures()),
      sources: {
        mic: toMeter(this.usage(stt, 'mic'), this.gateFigures('mic')),
        system: toMeter(this.usage(stt, 'system'), this.gateFigures('system')),
      },
      silenceGate: this.silenceGateState(),
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

function toMeter(
  { sessionsOpened, connectedMs, audioSentMs, estimatedCostUsd }: SttUsage,
  { gatedMs, estimatedSavedUsd }: GateFigures,
): SttMeter {
  return { sessionsOpened, connectedMs, audioSentMs, estimatedCostUsd, gatedMs, estimatedSavedUsd };
}

/**
 * `request` with its title cut to what the API stores (fitMeetingTitle). Main's own requests carry
 * calendar titles, which have no length limit: refused for the title alone, a prompt's Take notes
 * would fail every time for that event, and the enricher's answer would lose its event link too.
 * The window's requests are not cut: an over-long one is refused at the IPC, naming the field.
 */
function withTitleCutToFit(request: StartCaptureRequest): StartCaptureRequest {
  return request.title === undefined
    ? request
    : { ...request, title: fitMeetingTitle(request.title) };
}

/**
 * What a meeting is called when its start names nothing: "Meeting at 5:01 pm". shared/
 * suggestTemplate.ts matches this format (DEFAULT_MEETING_TITLE) to leave it out of template
 * picks: change the two together, and keep that pattern reading the old "Meeting 6 Oct 2026 09:30"
 * too, because meetings already saved keep the title they were given.
 */
export function defaultMeetingTitle(startedAt: Date): string {
  return `Meeting at ${formatClock(startedAt)}`;
}
