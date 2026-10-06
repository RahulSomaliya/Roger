import {
  DIGITAL_SILENCE_PEAK,
  type CaptureNotice,
  type CaptureWarning,
  type CaptureWarningKind,
} from '../../../shared/capture';
import { PCM_ENCODING, PCM_SAMPLE_RATE } from '../../../shared/ipc';
import type {
  CaptureService,
  RecordingStarted,
  StatusContext,
  StatusContribution,
} from '../../capture/CaptureService';
import { MAX_CAPTURE_TIME_SKEW_MS } from '../../ipc-validation';
import { errorMessage, type Logger } from '../../logger';
import {
  type HelperFrame,
  helperCommand,
  HelperProcess,
  type HelperProcessOptions,
  type HelperRunEnd,
} from '../../native/HelperProcess';
import type { JsonObject, TranscriptStore } from '../../store/TranscriptStore';
import { type HelperAudioFormat, type HelperEvent, parseHelperEvent } from './helperEvents';
import type { SystemAudioSelection } from './selectSystemAudio';
import type { SystemAudioSource } from './SystemAudioSource';
import type { SystemAudioVerification } from './systemAudioVerification';

/** The tap's chunk length; any length works, 100 ms is what the renderer's mic sends too. */
const TAP_CHUNK_MS = 100;

/**
 * Frames that arrive before their run's `ready` wait, at most this many (2 s), and are fed once
 * `ready` says their format is the one main takes. stdout and stderr are two pipes: the first
 * frame can be read before the `ready` line that was written before it.
 */
const MAX_FRAMES_BEFORE_READY = 20;

/** What TapSystemAudio needs of CaptureService. */
export type TapCapture = Pick<CaptureService, 'pushAudio' | 'reportSourceState' | 'refreshStatus'>;

/** HelperProcess's timings; the defaults are the M2 design's, and tests shorten them. */
export type HelperTimings = Pick<
  HelperProcessOptions,
  'hangKillMs' | 'maxRestarts' | 'restartDelayMs' | 'healthyResetMs' | 'stdinGraceMs' | 'termKillMs'
>;

export interface TapSystemAudioOptions {
  selection: Extract<SystemAudioSelection, { mode: 'tap' }>;
  capture: TapCapture;
  /** The meeting's capture events: helper restarts, tap rebuilds, failures (the capture report). */
  store: Pick<TranscriptStore, 'addCaptureEvent'>;
  verification: SystemAudioVerification;
  logger: Logger;
  clock?: () => number;
  /** The helper's environment; process.env by default. */
  env?: NodeJS.ProcessEnv;
  timings?: HelperTimings;
}

/** One recording's tap: its helper, and what the status says about it. */
interface TapRecording {
  meetingId: string;
  meetingStartedAtMs: number;
  helper: HelperProcess | null;
  /** The helper's run now, and the run whose `ready` announced a format main takes. */
  run: number;
  readyRun: number | null;
  waiting: HelperFrame[];
  /** The last `error` event's code: the helper's own reason for the exit that follows. */
  lastErrorCode: string | null;
  /** Restarts (crash, hang) this recording, for the notice. */
  restarts: number;
  /** A restart whose audio has not flowed yet: its notice comes with the audio. */
  restartPending: boolean;
  warning: CaptureWarning | null;
  notice: CaptureNotice | null;
  /** Call audio is off for this recording: the helper is out of restarts, refused or missing. */
  failed: boolean;
  /** Frames dropped for a capture time far from now, in this spell. */
  badTimeFrames: number;
}

/**
 * Call audio from `roger-audio tap` (M2 D1), the helper's Core Audio process tap: it needs only
 * System Audio Recording, not Screen Recording. While a recording runs, HelperProcess runs the
 * helper and this class feeds each frame to capture as the `system` source, with the capture time
 * the helper stamped where the audio was taken, through `capture.pushAudio`: the renderer's mic
 * goes through the same door (house rule 6 keeps the two sources apart).
 *
 * What it adds to the status: `systemCapture: tap`, `systemAudioVerified`, a loud warning while
 * the helper is down (`helper-hung` after the watchdog killed it, `source-ended` after a crash)
 * that clears when its audio is back, a `helper-restarted` notice, and every restart, rebuild and
 * failure as a capture event for the capture report.
 *
 * A helper out of restarts is reported through `capture.reportSourceState('system', 'error')`, the
 * path the renderer uses for a track that failed, so the landed cost guard G1 closes call audio's
 * vendor session at once. Between restarts it reports nothing: a restart that leaves no chunk for
 * the stall window is paused by G2 like any stall, and reopens on the first chunk after.
 */
export class TapSystemAudio implements SystemAudioSource {
  readonly mode = 'tap';
  private readonly clock: () => number;
  private recording: TapRecording | null = null;
  /** Helpers still stopping; the quit waits for them (`stop()`). */
  private readonly stopping = new Set<Promise<void>>();

  constructor(private readonly options: TapSystemAudioOptions) {
    this.clock = options.clock ?? (() => Date.now());
  }

  start({
    meetingId,
    meetingStartedAtMs,
  }: Pick<RecordingStarted, 'meetingId' | 'meetingStartedAtMs'>): void {
    if (this.recording !== null) void this.stop();
    const recording: TapRecording = {
      meetingId,
      meetingStartedAtMs,
      helper: null,
      run: 0,
      readyRun: null,
      waiting: [],
      lastErrorCode: null,
      restarts: 0,
      restartPending: false,
      warning: null,
      notice: null,
      failed: false,
      badTimeFrames: 0,
    };
    this.recording = recording;
    const { selection } = this.options;
    if (selection.helper === null) {
      this.event(recording, 'helper-missing', { reason: selection.missing });
      this.fail(recording, `there is no call audio helper: ${selection.missing}`);
      return;
    }
    const helper = new HelperProcess({
      name: 'tap',
      command: helperCommand(
        selection.helper,
        ['tap', '--sample-rate', String(PCM_SAMPLE_RATE), '--chunk-ms', String(TAP_CHUNK_MS)],
        this.options.env,
      ),
      stdout: 'frames',
      logger: this.options.logger,
      clock: this.clock,
      ...this.options.timings,
      listener: {
        onSpawn: ({ run }) => {
          recording.run = run;
          recording.readyRun = null;
          recording.waiting = [];
          recording.lastErrorCode = null;
        },
        onFrame: (frame) => {
          this.frame(recording, frame);
        },
        onStderrLine: (line) => {
          this.stderrLine(recording, line);
        },
        onRestart: (end) => {
          this.restarted(recording, end);
        },
        onFailed: (end) => {
          this.event(recording, 'helper-failed', runEndDetail(end));
          const last = recording.lastErrorCode === null ? '' : `, ${recording.lastErrorCode}`;
          this.fail(
            recording,
            `the call audio helper stopped ${end.restarts + 1} times in a row (last: ${end.detail}${last})`,
          );
        },
      },
    });
    recording.helper = helper;
    helper.start();
  }

  /** Stops this recording's helper, and waits for every helper still stopping (the quit). */
  stop(): Promise<void> {
    const recording = this.recording;
    this.recording = null;
    const helper = recording?.helper ?? null;
    if (helper !== null) {
      // HelperProcess.stop never rejects: SIGKILL ends any helper.
      const stopped = helper.stop().then(() => {
        this.stopping.delete(stopped);
      });
      this.stopping.add(stopped);
    }
    return Promise.all(this.stopping).then(() => undefined);
  }

  windowFocused(): void {
    if (this.options.verification.verified) return;
    this.rebuild('Roger regained focus while system audio is unverified');
  }

  rebuild(reason: string): void {
    const recording = this.recording;
    if (recording === null || recording.failed || recording.helper === null) return;
    if (recording.helper.writeLine('rebuild')) {
      this.options.logger.info('rebuilding the call audio tap', { reason });
    }
  }

  restart(reason: string): void {
    const recording = this.recording;
    if (recording === null || recording.failed) return;
    recording.helper?.restart(reason);
  }

  status(context: StatusContext): StatusContribution {
    const recording = this.recording;
    const part: StatusContribution = {
      systemCapture: context.phase === 'idle' ? null : 'tap',
      systemAudioVerified: this.options.verification.verified,
    };
    if (recording === null) return part;
    if (recording.warning !== null) part.warnings = [recording.warning];
    if (recording.notice !== null) part.notices = [recording.notice];
    return part;
  }

  private stderrLine(recording: TapRecording, line: string): void {
    const { logger } = this.options;
    const parsed = parseHelperEvent(line);
    if (parsed.kind === 'malformed') {
      // The line itself is not logged: it is the helper's, unchecked.
      logger.warn('call audio helper wrote a line that is not an event', {
        reason: parsed.reason,
        run: recording.run,
      });
      return;
    }
    if (parsed.kind === 'unknown') {
      logger.debug('call audio helper event passed over', { event: parsed.name });
      return;
    }
    this.helperEvent(recording, parsed.event);
  }

  private helperEvent(recording: TapRecording, event: HelperEvent): void {
    const { logger } = this.options;
    switch (event.event) {
      case 'ready':
        this.ready(recording, event.format, event.tapFormat);
        return;
      case 'restarted':
        logger.info('call audio tap rebuilt', { reason: event.reason, tapFormat: event.tapFormat });
        // Main's own `rebuild` is no news for the report; a route change is.
        if (event.reason === 'rebuild_requested') return;
        this.event(recording, 'tap-rebuilt', { reason: event.reason });
        recording.notice = this.notice(rebuildNotice(event.reason));
        this.options.capture.refreshStatus();
        return;
      case 'stats':
        if (event.dropped > 0) {
          logger.warn('call audio tap dropped audio', {
            droppedMs: event.dropped,
            run: recording.run,
          });
        }
        return;
      case 'warning':
        logger.warn('call audio helper warning', { code: event.code, message: event.message });
        return;
      case 'error':
        recording.lastErrorCode = event.code;
        logger.error('call audio helper error', {
          code: event.code,
          message: event.message,
          status: event.status,
        });
        return;
    }
  }

  private ready(
    recording: TapRecording,
    format: HelperAudioFormat,
    tapFormat: { sampleRate: number; channels: number },
  ): void {
    const { logger } = this.options;
    if (
      format.encoding !== PCM_ENCODING ||
      format.sampleRate !== PCM_SAMPLE_RATE ||
      format.channels !== 1
    ) {
      // Every vendor stream is told 16 kHz linear16: other audio is transcribed as garbage with no
      // error (stt/streamSettings.ts). The same helper would announce it again: no restart.
      const got = `${format.sampleRate} Hz ${format.encoding}, ${format.channels} channel(s)`;
      this.event(recording, 'helper-format-refused', {
        encoding: format.encoding,
        sampleRate: format.sampleRate,
        channels: format.channels,
      });
      this.fail(
        recording,
        `the call audio helper sends ${got}; Roger takes only ${PCM_SAMPLE_RATE} Hz ${PCM_ENCODING} mono`,
      );
      return;
    }
    logger.info('call audio tap ready', { run: recording.run, format, tapFormat });
    recording.readyRun = recording.run;
    const waiting = recording.waiting;
    recording.waiting = [];
    for (const frame of waiting) this.feed(recording, frame);
  }

  private frame(recording: TapRecording, frame: HelperFrame): void {
    if (recording.failed) return;
    if (recording.readyRun !== recording.run) {
      if (recording.waiting.length === MAX_FRAMES_BEFORE_READY) recording.waiting.shift();
      recording.waiting.push(frame);
      return;
    }
    this.feed(recording, frame);
  }

  private feed(recording: TapRecording, frame: HelperFrame): void {
    const { capture, logger, verification } = this.options;
    if (Math.abs(frame.capturedAtMs - this.clock()) > MAX_CAPTURE_TIME_SKEW_MS) {
      // The same rule as the renderer's chunks (ipc-validation.ts): a frame a day off would put
      // its lines a day away on the meeting timeline. A helper whose clock is off stays off, so
      // this is said once per spell, and the stall warning says call audio is missing.
      if (recording.badTimeFrames === 0) {
        logger.error('call audio frames dated far from now dropped', {
          capturedAtMs: frame.capturedAtMs,
          run: recording.run,
        });
      }
      recording.badTimeFrames += 1;
      return;
    }
    recording.badTimeFrames = 0;
    if (!verification.verified && peakOf(frame.pcm) > DIGITAL_SILENCE_PEAK) {
      verification.markHeard('tap');
    }
    capture.pushAudio('system', frame.pcm, frame.capturedAtMs);
    if (recording.warning !== null || recording.restartPending) {
      // Its audio is back: the spell is over.
      recording.warning = null;
      if (recording.restartPending) {
        recording.restartPending = false;
        const times = recording.restarts === 1 ? 'once' : `${recording.restarts} times`;
        recording.notice = this.notice(
          `Roger restarted the call audio helper (${times} this recording); call audio is back.`,
        );
      }
      capture.refreshStatus();
    }
  }

  private restarted(recording: TapRecording, end: HelperRunEnd): void {
    this.event(recording, 'helper-restarted', runEndDetail(end));
    recording.restarts += 1;
    recording.restartPending = true;
    recording.warning =
      end.cause === 'hung'
        ? this.warning(
            'helper-hung',
            'Call audio stopped: the call audio helper stopped responding, so Roger restarted it.',
          )
        : this.warning(
            'source-ended',
            `Call audio stopped: the call audio helper quit (${end.detail}). Roger is restarting it.`,
          );
    this.options.capture.refreshStatus();
  }

  /** Call audio is off for this recording: G1 closes its vendor session, and the warning is loud. */
  private fail(recording: TapRecording, reason: string): void {
    recording.failed = true;
    recording.waiting = [];
    recording.restartPending = false;
    void recording.helper?.stop();
    this.options.logger.error('call audio failed', { meetingId: recording.meetingId, reason });
    recording.warning = this.warning(
      'source-ended',
      `Call audio stopped: ${reason}. Press Stop, then Start again.`,
    );
    this.options.capture.reportSourceState('system', 'error', reason);
    this.options.capture.refreshStatus();
  }

  private warning(kind: CaptureWarningKind, message: string): CaptureWarning {
    return { kind, source: 'system', since: this.isoNow(), message, loud: true };
  }

  private notice(message: string): CaptureNotice {
    return { kind: 'helper-restarted', source: 'system', at: this.isoNow(), message };
  }

  /** A capture event for the meeting's report; a store that refuses it is logged, capture goes on. */
  private event(recording: TapRecording, kind: string, detail: JsonObject): void {
    const now = this.clock();
    try {
      this.options.store.addCaptureEvent({
        meetingId: recording.meetingId,
        at: new Date(now).toISOString(),
        offsetMs: now - recording.meetingStartedAtMs,
        source: 'system',
        kind,
        detail,
      });
    } catch (error) {
      this.options.logger.error('capture event not saved', {
        meetingId: recording.meetingId,
        kind,
        error: errorMessage(error),
      });
    }
  }

  private isoNow(): string {
    return new Date(this.clock()).toISOString();
  }
}

/** The largest |sample| of Int16 little-endian PCM (0 to 32768). */
function peakOf(pcm: Uint8Array): number {
  const samples = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let peak = 0;
  for (let offset = 0; offset + 1 < pcm.byteLength; offset += 2) {
    const sample = Math.abs(samples.getInt16(offset, true));
    if (sample > peak) peak = sample;
  }
  return peak;
}

function runEndDetail(end: HelperRunEnd): JsonObject {
  return {
    cause: end.cause,
    restarts: end.restarts,
    detail: end.detail,
    exitCode: end.exitCode,
    signal: end.signal,
  };
}

function rebuildNotice(reason: string): string {
  switch (reason) {
    case 'output_device_changed':
      return 'Call audio followed the new output device.';
    case 'tap_format_changed':
      return 'Call audio followed a change of the output format.';
    default:
      return 'Roger rebuilt its call audio capture.';
  }
}
