import type { CapturePhase } from '../../shared/capture';
import type { StatusContribution, StatusContributor, StopOptions } from '../capture/CaptureService';
import { errorMessage, type Logger } from '../logger';

/** Electron's `powerMonitor`, as far as sleep and wake go. */
export interface PowerEvents {
  on(event: 'suspend' | 'resume', listener: () => void): unknown;
}

/** Electron's `powerSaveBlocker`, as far as a recording uses it. */
export interface AppSuspensionBlocker {
  start(type: 'prevent-app-suspension'): number;
  stop(id: number): unknown;
}

/**
 * The live CaptureSession's sleep switch (M2-T6). Only `asleep`: the reasons stack and each resume
 * lifts its own, and `offline` belongs to the network poll (stt/networkStatus.ts), which tells the
 * session only on a change it sees. A wake that lifted `offline` while the Mac is still offline
 * would reopen both streams with nothing left to suspend them again.
 */
export interface SleepFollower {
  suspendStreams(reason: 'asleep'): void;
  resumeStreams(reason: 'asleep'): void;
}

/** What `capture.onRecording` tells the coordinator (CaptureService's RecordingListener). */
export interface RecordingFollower {
  started?(recording: { meetingId: string; session: SleepFollower }): void;
  ended?(recording: { meetingId: string }): void;
}

/** CaptureService through its seams (M2-T4): never an edit to that file. */
export interface PowerCapture {
  onRecording(listener: RecordingFollower): () => void;
  readonly phase: CapturePhase;
  stop(options: StopOptions): Promise<unknown>;
  addStatusContributor(name: string, read: StatusContributor): () => void;
  refreshStatus(): void;
}

export interface PowerCoordinatorOptions {
  capture: PowerCapture;
  /** Call audio (M2-T10): restarted at wake, outside its restart count. */
  systemAudio: { restart(reason: string): void };
  powerMonitor: PowerEvents;
  powerSaveBlocker: AppSuspensionBlocker;
  /** costGuards.noSpeechStopMs: a sleep this long or longer stops the recording at wake. */
  noSpeechStopMs: number;
  logger: Logger;
  /**
   * The wall clock (epoch ms). Never a monotonic one: it stops while the Mac sleeps, so every
   * sleep would measure as no time at all.
   */
  clock?: () => number;
}

/** The recording being followed, from `started` until `ended`. */
interface FollowedRecording {
  meetingId: string;
  session: SleepFollower;
  /** The power save blocker it holds; null when Electron refused one (logged). */
  blockerId: number | null;
}

/**
 * Sleep and wake while recording (M2-T18, a delta on cost guard G4). Sockets do not survive a
 * sleep, and one left half-open bills until the vendor's idle timeout (120 s on AssemblyAI), so at
 * `suspend` both sources' sessions finish and close (`suspendStreams('asleep')`: their last lines
 * saved, the audio held as for a stall) and nothing reopens while asleep. At `resume` after a sleep
 * shorter than noSpeechStopMs, `resumeStreams('asleep')` leaves each source paused with no backoff,
 * to reopen with its next chunk through the open budget (CaptureSession.pushAudio decides, so a
 * source M3-T20's silence gate had closed waits for speech), and the call audio helper restarts;
 * the renderer brings the mic back itself (MicRecovery, or followMain after a reload). G4 used to
 * stop on every sleep, which split a call the lid interrupted into two meetings. A sleep of
 * noSpeechStopMs or more is not a pause in a meeting: the recording stops at wake with
 * `system-sleep` and its notice, and the audio held since the suspend becomes a gap named `asleep`
 * for M2-T16 to re-run from the backup.
 *
 * While a recording runs it also holds `powerSaveBlocker('prevent-app-suspension')`, so a long
 * call with nobody at the keyboard never idles the Mac to sleep; closing the lid still sleeps it.
 * This is the only owner of `powerMonitor`'s suspend and resume for capture: lifecycle.ts stopped
 * listening to them, and a second owner would decide the same sleep twice.
 *
 * `[slot M2-T18]` in capture/createCaptureRuntime.ts builds it and calls attach().
 */
export class PowerCoordinator {
  private readonly clock: () => number;
  private recording: FollowedRecording | null = null;
  /**
   * Wall clock when the Mac went to sleep during a recording, or one still starting; null while
   * awake. Cleared at wake and at the recording's end.
   */
  private asleepSinceMs: number | null = null;

  constructor(private readonly options: PowerCoordinatorOptions) {
    this.clock = options.clock ?? (() => Date.now());
  }

  /** Follows recordings and the Mac's power events from now on. Call once. */
  attach(): void {
    const { capture, powerMonitor } = this.options;
    capture.onRecording({
      started: ({ meetingId, session }) => {
        this.recordingStarted(meetingId, session);
      },
      ended: () => {
        this.recordingEnded();
      },
    });
    capture.addStatusContributor('power', (context) => this.contribution(context.phase));
    powerMonitor.on('suspend', () => {
      this.guarded('suspend', () => {
        this.suspended();
      });
    });
    powerMonitor.on('resume', () => {
      this.guarded('resume', () => {
        this.resumed();
      });
    });
  }

  private recordingStarted(meetingId: string, session: SleepFollower): void {
    this.recording = { meetingId, session, blockerId: this.holdBlocker(meetingId) };
    // A start whose opens finished after the suspend: its sockets would cross the sleep open.
    if (this.asleepSinceMs !== null) session.suspendStreams('asleep');
  }

  private recordingEnded(): void {
    const recording = this.recording;
    this.recording = null;
    this.asleepSinceMs = null;
    if (recording !== null && recording.blockerId !== null) {
      this.options.powerSaveBlocker.stop(recording.blockerId);
    }
  }

  private holdBlocker(meetingId: string): number | null {
    try {
      return this.options.powerSaveBlocker.start('prevent-app-suspension');
    } catch (error) {
      // The recording goes on: the Mac may idle to sleep, and the suspend path handles that.
      this.options.logger.error('could not keep the Mac awake while recording', {
        meetingId,
        error: errorMessage(error),
      });
      return null;
    }
  }

  private suspended(): void {
    const { capture, logger } = this.options;
    if (this.asleepSinceMs !== null) return; // a repeated event
    if (capture.phase !== 'recording' && capture.phase !== 'starting') return;
    this.asleepSinceMs = this.clock();
    logger.info('the Mac is going to sleep: speech-to-text suspended', {
      meetingId: this.recording?.meetingId ?? null,
    });
    // A recording still starting has no session yet: recordingStarted suspends it.
    this.recording?.session.suspendStreams('asleep');
    capture.refreshStatus();
  }

  /**
   * Trap: CaptureService's no-speech stop (G5, checkForgottenStop) counts on the wall clock too,
   * and its 500 ms monitor tick may run before Electron delivers `resume`. It skips the tick that
   * finds a sleep and takes the slept time out of its counts (suspendedSinceLastTick), so after a
   * sleep of noSpeechStopMs or more this handler, not G5, stops the recording, with `system-sleep`.
   * The `stopping` check below stays for a stop that really did start first (the person's Stop, a
   * quit); keep both halves in step.
   */
  private resumed(): void {
    const { capture, logger, noSpeechStopMs } = this.options;
    const since = this.asleepSinceMs;
    if (since === null) return; // no recording slept
    this.asleepSinceMs = null;
    const recording = this.recording;
    if (recording === null || capture.phase !== 'recording') {
      // A start still under way (awake now, it suspends nothing when it lands), one that failed
      // while asleep (it gets neither `started` nor `ended`, so only this forgets its sleep), or a
      // stop already under way: nothing to wake.
      capture.refreshStatus();
      return;
    }
    const { meetingId, session } = recording;
    // Never negative: a clock set back during the sleep is no reason to stop.
    const sleptForMs = Math.max(0, this.clock() - since);
    if (sleptForMs >= noSpeechStopMs) {
      logger.warn('the Mac slept too long for one meeting: stopping the recording', {
        meetingId,
        sleptForMs,
        noSpeechStopMs,
      });
      // Still suspended, so nothing reopens before Stop closes the session: a reopen now would
      // bill a fresh session for the seconds until it closes.
      capture.stop({ reason: 'system-sleep' }).catch((error: unknown) => {
        logger.error('stop after a long sleep failed', { meetingId, error: errorMessage(error) });
      });
      return;
    }
    logger.info('the Mac woke: speech-to-text reopens with the next audio', {
      meetingId,
      sleptForMs,
    });
    session.resumeStreams('asleep');
    this.options.systemAudio.restart('the Mac woke from sleep');
    capture.refreshStatus();
  }

  /** `paused` while a recording sleeps; M2-T11's SignalMonitor holds its warnings meanwhile. */
  private contribution(phase: CapturePhase): StatusContribution {
    if (phase === 'idle') return {};
    return { paused: this.asleepSinceMs === null ? null : 'asleep' };
  }

  /**
   * Runs one power event's handling. Electron calls these listeners itself, so a throw would be an
   * uncaught exception in main: it is logged with the event instead, and the next event is handled
   * afresh.
   */
  private guarded(event: 'suspend' | 'resume', run: () => void): void {
    try {
      run();
    } catch (error) {
      this.options.logger.error('power event not applied', {
        event,
        meetingId: this.recording?.meetingId ?? null,
        error: errorMessage(error),
      });
    }
  }
}
