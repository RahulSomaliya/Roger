import { randomUUID } from 'node:crypto';
import type { CallApp } from '../../shared/calendar';
import type { CaptureNotice, CaptureStatus } from '../../shared/capture';
import { AUDIO_SOURCES, type AudioSource } from '../../shared/transcript';
import type { RecordingStarted, StartOptions, StatusContributor } from '../capture/CaptureService';
import type { MeetingAppMonitor } from '../detect/MeetingAppMonitor';
import { errorMessage, type Logger } from '../logger';
import { MIN_CRASH_TAIL_MS } from '../rerun/crashTails';
import type {
  AudioFile,
  LocalMeeting,
  TranscriptGap,
  TranscriptStore,
} from '../store/TranscriptStore';

/** A meeting left open resumes only if Roger was seen recording it at most this long ago (M2 D7). */
export const RESUME_WITHIN_MS = 10 * 60_000;

/** How often the heartbeat is written while a recording runs. */
export const HEARTBEAT_INTERVAL_MS = 5_000;

/**
 * The `app_state` row that says which meeting is recording: its value is the meeting id, its
 * `updated_at` the last time Roger was seen recording it. Written at Start and every
 * HEARTBEAT_INTERVAL_MS, deleted at Stop, so after a kill -9 it names the meeting and the moment.
 */
export const HEARTBEAT_KEY = 'recording.heartbeat';

/**
 * How long a launch nobody relaunched waits for the call app monitor to report a call app on the
 * mic. The monitor lists mic users when its helper starts and after every 1 s poll, and it reports
 * only a change, so an empty list never arrives: the wait ends at this bound instead.
 */
export const CALL_APP_WAIT_MS = 3_000;

/** The capture event a resume writes, for the capture report (M2-T20b). */
export const RESUMED_AFTER_CRASH_EVENT = 'resumed_after_crash';

export const RESUMED_NOTICE_MESSAGE = 'Roger restarted and kept taking notes';

/** The call app monitor (M2-T17a), as far as the resume asks it. */
export type CallAppWatch = Pick<MeetingAppMonitor, 'callApps' | 'onCallApps' | 'running'>;

/** CaptureService, as far as the recovery uses it (its seams, M2-T4). */
export interface RecoveryCapture {
  start(options: StartOptions): Promise<CaptureStatus>;
  onRecording(listener: {
    started?(recording: Pick<RecordingStarted, 'meetingId' | 'resumed'>): void;
    ended?(): void;
  }): () => void;
  addStatusContributor(name: string, read: StatusContributor): () => void;
  refreshStatus(): void;
}

export interface CrashRecoveryOptions {
  store: TranscriptStore;
  /**
   * This launch is the monitor helper's relaunch of a killed Roger: `--relaunched` in argv, the
   * only sign of it (ParentWatch.swift).
   */
  relaunched: boolean;
  /**
   * The call app monitor, read once `start` runs (it is built with the capture runtime, after
   * `endMeetingsLeftOpen`); null when this launch cannot ask it. While null, a launch nobody
   * relaunched ends every meeting left open at once, as M1 did.
   */
  callApps: (() => CallAppWatch) | null;
  logger: Logger;
  clock?: () => number;
}

/** The meeting left open that may resume, between the two steps. */
interface KeptMeeting {
  meetingId: string;
  startedAtMs: number;
  /** Its last heartbeat (epoch ms): when Roger was last seen recording it. */
  lastSeenAtMs: number;
}

type ResumeTrigger = { kind: 'relaunch' } | { kind: 'call-app'; app: CallApp };

/**
 * What happens at launch to the meetings a previous run left open (M2 D7, M2-T23). A crash, a
 * kill -9 or a Force Quit leaves its meeting open, and so does a quit whose stop outran
 * `quitStopTimeoutMs`. One left open by a crash resumes in the same meeting id when Roger was seen
 * recording it under RESUME_WITHIN_MS ago (the heartbeat) and either this launch is the monitor's
 * relaunch or a call app holds the mic: one call stays one meeting, the per-meeting count and
 * quote checks included. Every other one is ended as in M1 (`stop_reason` `crash`, or the reason a
 * stop already wrote, `quit` for a quit that outran its bound).
 *
 * Two steps, because they need different parts of the launch (index.ts, `[slot M2-T23]`):
 * 1. `endMeetingsLeftOpen`, before the capture runtime: M2-T16's launch pass in that runtime
 *    records the crash tails of the meetings a crash ended and re-runs them, so all but the one
 *    that may resume must be ended by then. That one stays open, and M2-T16 skips it.
 * 2. `start(capture)`, once the runtime exists (M2-T15 has repaired the WAVs a crash left open, so
 *    each file's end is known): the heartbeat and the resumed notice follow every recording from
 *    then on, and the kept meeting resumes through
 *    `capture.start({ resume: { meetingId } })`, which reads its start and its saved `stt_usage`
 *    row itself (the cost record carries on; the open allowance starts afresh). First, each
 *    source's audio the crash cut off before the vendor answered becomes a `crash` gap (its
 *    tail), which the re-run fills once the meeting ends; the time Roger was gone had no audio at
 *    all, so it is the `resumed_after_crash` event's `downMs`, not a gap.
 *
 * A resume refused (no microphone, no token, the vendor) ends the meeting there, as a crash.
 * So does a launch nobody relaunched once no call app shows within CALL_APP_WAIT_MS. Ended in this
 * second step, after M2-T16's launch pass, its tails wait for the next launch or a re-run asked
 * from Home; recorded here, they are not recorded again (crashTails.ts skips a source that has a
 * `crash` gap).
 *
 * The echo holds the crash left are settled by M2-T14b's hook before the uploader's first tick
 * (`TranscriptUploader.setBeforeFirstTick`), and only on lines created before the uploader was
 * built. The resume runs after that (step 2), so the lines it holds are never settled as left
 * over: their call-audio twins are still to come.
 *
 * The relaunch is once per meeting: MeetingAppMonitor.attach does not arm it again in a meeting
 * a `--relaunched` launch resumed, so a Roger that crashes on every resume does not loop.
 */
export class CrashRecovery {
  private readonly clock: () => number;
  private kept: KeptMeeting | null = null;
  /** The resumed recording's notice, while it runs. */
  private resumed: { meetingId: string; notice: CaptureNotice } | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  /** A heartbeat write failed and has not succeeded since: the failure is logged once. */
  private heartbeatFailing = false;

  constructor(private readonly options: CrashRecoveryOptions) {
    this.clock = options.clock ?? (() => Date.now());
  }

  /**
   * Step 1, at launch before the capture runtime: ends every meeting left open but the one that
   * may resume. No session can run yet, so each open meeting was cut off. A store that fails here
   * fails the launch, as M1's did: nothing after it could keep its lines either.
   */
  endMeetingsLeftOpen(): void {
    const { store, logger } = this.options;
    const now = this.clock();
    this.kept = this.resumable(store.listOpenMeetings(), now);
    const ended = store.endMeetingsLeftOpen(iso(now), this.kept?.meetingId);
    if (ended > 0) logger.warn('ended meetings left open by a previous run', { count: ended });
    if (this.kept !== null) {
      logger.info('kept the meeting a crash left open, to resume it', {
        meetingId: this.kept.meetingId,
        relaunched: this.options.relaunched,
        lastSeenMsAgo: now - this.kept.lastSeenAtMs,
      });
    }
  }

  /**
   * Step 2, once the capture runtime exists: follows every recording from now on (the heartbeat,
   * the resumed notice), then resumes the kept meeting or ends it. Never rejects: a failure is
   * logged, and a meeting it leaves open is ended at the next launch.
   */
  async start(capture: RecoveryCapture): Promise<void> {
    this.follow(capture);
    const kept = this.kept;
    this.kept = null;
    if (kept === null) return;
    try {
      await this.resumeOrEnd(capture, kept);
    } catch (error) {
      this.options.logger.error('crash recovery failed: the meeting stays open until next launch', {
        meetingId: kept.meetingId,
        error: errorMessage(error),
      });
    }
  }

  /** The meeting the heartbeat names, if it may resume (see the class comment); null otherwise. */
  private resumable(open: readonly LocalMeeting[], now: number): KeptMeeting | null {
    const { store, logger, relaunched, callApps } = this.options;
    const beat = store.getAppState(HEARTBEAT_KEY);
    const meeting = beat === null ? undefined : open.find(({ id }) => id === beat.value);
    if (beat === null || meeting === undefined) return null;
    const notResumed = (reason: string): null => {
      logger.info('the meeting a crash left open is not resumed', {
        meetingId: meeting.id,
        reason,
      });
      return null;
    };
    if (!relaunched && callApps === null) {
      return notResumed('not relaunched, and no call app monitor to ask');
    }
    // Stop writes its reason before it closes the sessions: a stop had begun (a quit that outran
    // its bound, a Stop that threw), so this is no crash to recover from.
    if (store.getMeetingStopReason(meeting.id) !== null) return notResumed('a stop had begun');
    const startedAtMs = Date.parse(meeting.startedAt);
    const lastSeenAtMs = Date.parse(beat.updatedAt);
    if (!Number.isFinite(startedAtMs) || !Number.isFinite(lastSeenAtMs)) {
      return notResumed('its start or heartbeat is not a time');
    }
    if (now - lastSeenAtMs > RESUME_WITHIN_MS) {
      return notResumed('last seen recording over 10 minutes ago');
    }
    return { meetingId: meeting.id, startedAtMs, lastSeenAtMs };
  }

  private async resumeOrEnd(capture: RecoveryCapture, kept: KeptMeeting): Promise<void> {
    const { logger } = this.options;
    const { meetingId } = kept;
    const gaps = this.recordCrashTails(kept);
    const trigger = await this.trigger();
    if (trigger === null) {
      this.end(kept);
      logger.warn('ended the meeting a crash left open: no call app holds the mic', { meetingId });
      return;
    }
    const status = await capture.start({ resume: { meetingId } });
    if (status.phase !== 'recording' || status.meetingId !== meetingId) {
      // Refused (its error is on screen), or a recording another Start made runs instead.
      logger.error('could not resume the meeting a crash left open: it is ended', {
        meetingId,
        phase: status.phase,
        error: status.error,
      });
      this.end(kept);
      return;
    }
    const now = this.clock();
    const detail = {
      downMs: Math.max(0, now - kept.lastSeenAtMs),
      trigger: trigger.kind,
      callApp: trigger.kind === 'call-app' ? trigger.app.name : null,
      gaps,
    };
    logger.info('resumed the meeting a crash left open', { meetingId, ...detail });
    try {
      this.options.store.addCaptureEvent({
        meetingId,
        at: iso(now),
        offsetMs: Math.max(0, now - kept.startedAtMs),
        source: null,
        kind: RESUMED_AFTER_CRASH_EVENT,
        detail,
      });
    } catch (error) {
      // The recording goes on: only the capture report misses the resume.
      logger.error('could not save the resume in the capture report', {
        meetingId,
        error: errorMessage(error),
      });
    }
  }

  /** Why to resume: the relaunch, or a call app on the mic (the monitor asked first). */
  private async trigger(): Promise<ResumeTrigger | null> {
    const { relaunched, callApps } = this.options;
    if (relaunched) return { kind: 'relaunch' };
    if (callApps === null) return null;
    const app = await callAppOnMic(callApps(), CALL_APP_WAIT_MS);
    return app === null ? null : { kind: 'call-app', app };
  }

  /**
   * Each source's tail the crash cut off becomes a `crash` gap. A failure is logged and the resume
   * goes on: a missing gap row costs that tail's words, a missing resume the rest of the call.
   */
  private recordCrashTails(kept: KeptMeeting): number {
    const { store, logger } = this.options;
    const { meetingId } = kept;
    let recorded = 0;
    try {
      const files = store.listAudioFiles(meetingId);
      const gaps = store.listGaps(meetingId);
      const createdAt = iso(this.clock());
      for (const source of AUDIO_SOURCES) {
        const tail = crashTail(store, meetingId, source, files, gaps);
        if (tail === null) continue;
        store.addGap({ id: randomUUID(), meetingId, source, ...tail, reason: 'crash', createdAt });
        recorded += 1;
      }
    } catch (error) {
      logger.error('could not record what the crash cut off as gaps: it is not re-run', {
        meetingId,
        error: errorMessage(error),
      });
    }
    return recorded;
  }

  /**
   * Ends a kept meeting as a crash, where Roger was last seen recording it (never before its start
   * or after now). Per meeting, never the store's endMeetingsLeftOpen: by now a Start of this run
   * may have a meeting open.
   */
  private end(kept: KeptMeeting): void {
    const { store } = this.options;
    const endedAtMs = Math.max(kept.startedAtMs, Math.min(kept.lastSeenAtMs, this.clock()));
    store.setMeetingStopReason(kept.meetingId, 'crash');
    store.markMeetingEnded(kept.meetingId, iso(endedAtMs));
  }

  /** The heartbeat and the resumed notice, for every recording from now on. */
  private follow(capture: RecoveryCapture): void {
    capture.onRecording({
      started: ({ meetingId, resumed }) => {
        this.stopHeartbeat();
        this.beat(meetingId);
        this.heartbeat = setInterval(() => {
          this.beat(meetingId);
        }, HEARTBEAT_INTERVAL_MS);
        if (resumed) {
          this.resumed = {
            meetingId,
            notice: {
              kind: 'resumed-after-crash',
              source: null,
              at: iso(this.clock()),
              message: RESUMED_NOTICE_MESSAGE,
            },
          };
          capture.refreshStatus();
        }
      },
      ended: () => {
        this.stopHeartbeat();
        this.resumed = null;
        try {
          this.options.store.deleteAppState(HEARTBEAT_KEY);
        } catch (error) {
          // Harmless at the next launch: the meeting it names has ended, so it is not resumed.
          this.options.logger.warn('could not clear the recording heartbeat', {
            error: errorMessage(error),
          });
        }
      },
    });
    // Leaves `notices` out when it has none: an empty list would join every status.
    capture.addStatusContributor('crash-recovery', ({ meetingId }) => {
      const resumed = this.resumed;
      return resumed !== null && resumed.meetingId === meetingId
        ? { notices: [{ ...resumed.notice }] }
        : {};
    });
  }

  /** Runs on a timer: nothing may escape it (a throw would be an uncaught exception in main). */
  private beat(meetingId: string): void {
    try {
      this.options.store.setAppState(HEARTBEAT_KEY, meetingId, iso(this.clock()));
      this.heartbeatFailing = false;
    } catch (error) {
      if (!this.heartbeatFailing) {
        this.options.logger.error(
          'recording heartbeat not saved: a crash now would end this meeting, not resume it',
          { meetingId, error: errorMessage(error) },
        );
      }
      this.heartbeatFailing = true;
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
}

/**
 * One source's crash tail: its backup audio after the later of its last stored line (the vendor
 * had answered up to there; hidden echo lines count) and its last gap (an earlier resume's tail),
 * or from its first audio. Null when it has no audio kept or the tail is too short for a word.
 *
 * The twin of M2-T16's rule in rerun/crashTails.ts, which only takes meetings a crash ended: keep
 * the two in step. This one also starts after the source's gaps, because a resumed meeting can
 * crash again, and its first tail is already a gap.
 */
function crashTail(
  store: TranscriptStore,
  meetingId: string,
  source: AudioSource,
  files: readonly AudioFile[],
  gaps: readonly TranscriptGap[],
): { startMs: number; endMs: number } | null {
  const own = files.filter((file) => file.source === source);
  if (own.length === 0) return null;
  const audioFromMs = Math.min(...own.map((file) => file.startMs));
  const audioToMs = Math.max(...own.map((file) => file.endMs ?? file.startMs));
  const lines = store.listSegmentsOverlapping(meetingId, source, audioFromMs, audioToMs);
  const startMs = Math.max(
    audioFromMs,
    ...lines.map((line) => line.endMs),
    ...gaps.filter((gap) => gap.source === source).map((gap) => gap.endMs),
  );
  if (audioToMs - startMs < MIN_CRASH_TAIL_MS) return null;
  return { startMs, endMs: audioToMs };
}

/**
 * The first call app the monitor sees on the mic within `waitMs`, or null. A monitor that is down
 * answers null at once: it would report nothing.
 */
function callAppOnMic(watch: CallAppWatch, waitMs: number): Promise<CallApp | null> {
  const now = watch.callApps[0];
  if (now !== undefined) return Promise.resolve(now);
  if (!watch.running) return Promise.resolve(null);
  return new Promise((resolve) => {
    // Neither callback runs before both lines below have: onCallApps tells only later changes.
    const done = (app: CallApp | null): void => {
      clearTimeout(timer);
      stopListening();
      resolve(app);
    };
    const timer = setTimeout(() => {
      done(null);
    }, waitMs);
    const stopListening = watch.onCallApps((apps) => {
      const app = apps[0];
      if (app !== undefined) done(app);
    });
  });
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}
