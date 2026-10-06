import { BACKUP_KEEP_FOR_RERUN_MAX_DAYS } from '../../shared/capture';
import { errorMessage, type Logger } from '../logger';
import type { TranscriptStore } from '../store/TranscriptStore';

/** Retention is checked at launch and then this often (M2 D5). */
export const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1_000;

const DAY_MS = 24 * 60 * 60 * 1_000;

/** How long one meeting's audio is kept. */
export interface AudioKeep {
  /** Epoch ms from which the audio is deleted; null while the meeting is open (never deleted). */
  keepUntilMs: number | null;
  /** A gap of the meeting still waits for its re-run, so its audio outlives the retention. */
  keptForRerun: boolean;
}

/**
 * The retention rule of M2 D5, counted from the meeting's end: `retentionDays` (config.json
 * `audioRetentionDays`), or BACKUP_KEEP_FOR_RERUN_MAX_DAYS while a gap waits for its re-run
 * (deleting the audio then would defeat the backup; failed re-runs count as waiting). A meeting
 * with no end yet is being recorded or was left open by a crash, and CrashRecovery (M2-T23) may
 * resume it: never deleted.
 */
export function audioKeep(
  endedAt: string | null,
  unrecoveredGaps: number,
  retentionDays: number,
): AudioKeep {
  const keptForRerun = unrecoveredGaps > 0;
  if (endedAt === null) return { keepUntilMs: null, keptForRerun };
  const days = keptForRerun
    ? Math.max(retentionDays, BACKUP_KEEP_FOR_RERUN_MAX_DAYS)
    : retentionDays;
  return { keepUntilMs: Date.parse(endedAt) + days * DAY_MS, keptForRerun };
}

export interface AudioRetentionSweeperOptions {
  store: Pick<TranscriptStore, 'listMeetingIdsWithAudio' | 'getMeeting' | 'listUnrecoveredGaps'>;
  retentionDays: number;
  /** Deletes one meeting's audio with its path check (AudioBackup.deleteMeetingAudio). */
  deleteMeetingAudio: (meetingId: string) => Promise<void>;
  logger: Logger;
  clock?: () => number;
}

/**
 * Deletes the audio of meetings past their retention (`audioKeep`), at launch (AudioBackup runs
 * the first sweep) and every hour after `start()`. Only the audio goes: the meeting and its lines
 * stay, and a meeting with no line left with no audio is the uploader's to discard
 * (TranscriptUploader's pending rule; `TranscriptStore.deleteMeetingIfEmpty` says why no other
 * code may).
 */
export class AudioRetentionSweeper {
  private readonly clock: () => number;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly options: AudioRetentionSweeperOptions) {
    this.clock = options.clock ?? (() => Date.now());
  }

  /** Deletes what is past its retention now; returns the meetings whose audio went. */
  async sweep(): Promise<string[]> {
    const { store, retentionDays, logger } = this.options;
    const now = this.clock();
    const deleted: string[] = [];
    for (const meetingId of store.listMeetingIdsWithAudio()) {
      const meeting = store.getMeeting(meetingId);
      if (meeting === null) continue;
      const gaps = store.listUnrecoveredGaps(meetingId).length;
      const { keepUntilMs, keptForRerun } = audioKeep(meeting.endedAt, gaps, retentionDays);
      if (keepUntilMs === null || now < keepUntilMs) continue;
      try {
        await this.options.deleteMeetingAudio(meetingId);
      } catch (error) {
        // The next sweep tries again; the others still go.
        logger.error('audio backup: could not delete audio past its retention', {
          meetingId,
          error: errorMessage(error),
        });
        continue;
      }
      deleted.push(meetingId);
      logger.info('audio backup: deleted audio past its retention', {
        meetingId,
        retentionDays,
        // True when the 30-day cap ended a wait for a re-run that never succeeded.
        rerunCap: keptForRerun,
      });
    }
    return deleted;
  }

  /** Sweeps every RETENTION_SWEEP_INTERVAL_MS until `stop()`; the launch sweep is the caller's. */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      this.sweep().catch((error: unknown) => {
        this.options.logger.error('audio backup: the retention sweep failed', {
          error: errorMessage(error),
        });
      });
    }, RETENTION_SWEEP_INTERVAL_MS);
    // Never what keeps Roger running.
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}
