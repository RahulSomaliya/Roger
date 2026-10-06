import type { BackupStatus } from '../../shared/capture';
import type { AudioSink } from '../capture/AudioFanout';
import type { StatusContribution } from '../capture/CaptureService';
import type { CaptureSettings } from '../config';
import type { QuitHook } from '../lifecycle';
import { errorMessage, type Logger } from '../logger';
import type { TranscriptStore } from '../store/TranscriptStore';
import { AudioBackupWriter, type BackupRecording } from './AudioBackupWriter';
import { AudioCompressor, type RunTool } from './AudioCompressor';
import { meetingAudioDir, removeMeetingAudioDir } from './audioPaths';
import { audioKeep, AudioRetentionSweeper } from './AudioRetentionSweeper';
import type { FreeDiskBytes } from './diskGuard';
import { WAV_HEADER_BYTES } from './wav';

/** The capture event a delete writes; the report reads it back as `deleted`. */
const AUDIO_DELETED_EVENT = 'audio_deleted';

/** Who deleted a meeting's audio, in its `audio_deleted` capture event. */
type DeletedBy = 'user' | 'retention';

/**
 * The capture seams the backup uses (M2-T4), narrowed to what it reads: CaptureService has them
 * all, and a test drives them by hand.
 */
export interface AudioBackupCapture {
  addAudioSink(name: string, sink: AudioSink): () => void;
  addStatusContributor(name: string, read: () => StatusContribution): () => void;
  onRecording(listener: {
    started?(recording: BackupRecording): void;
    ended?(recording: { meetingId: string }): void;
  }): () => void;
  refreshStatus(): void;
}

export interface AudioBackupOptions {
  capture: AudioBackupCapture;
  store: TranscriptStore;
  /** The app's data folder; the audio goes under `audio/` (audioPaths.ts). */
  userData: string;
  settings: Pick<CaptureSettings, 'audioBackup' | 'audioRetentionDays'>;
  logger: Logger;
  clock?: () => number;
  freeDiskBytes?: FreeDiskBytes;
  /** afconvert's runner (AudioCompressor). */
  run?: RunTool;
}

/**
 * The local audio backup (M2 D5, M2-T15), as `[slot M2-T15]` of createCaptureRuntime.ts wires it:
 * - AudioBackupWriter, a fan-out sink, keeps each recording's audio in WAV files of at most 60 s
 * - AudioCompressor turns each closed WAV into AAC
 * - AudioRetentionSweeper deletes audio past `audioRetentionDays`, keeping a meeting whose gap
 *   waits for its re-run up to BACKUP_KEEP_FOR_RERUN_MAX_DAYS
 * and this class answers the capture report's `backup`, the status's `backup` (and its
 * `backup-paused` warning), and delete-audio, with its path check.
 *
 * `start()` runs at launch, before any recording: it repairs what a crash left open at once (the
 * gap re-run's slot comes next and reads these files), then sweeps and encodes the WAVs left over
 * in the background, then sweeps every hour.
 */
export class AudioBackup {
  readonly quitHook: QuitHook;
  private readonly clock: () => number;
  private readonly writer: AudioBackupWriter;
  private readonly compressor: AudioCompressor;
  private readonly sweeper: AudioRetentionSweeper;
  private launchWork: Promise<void> = Promise.resolve();
  /** The meeting the status shows after Stop, until the next Start. */
  private lastMeetingId: string | null = null;
  private last: BackupStatus | null = null;
  /**
   * How the last recording's backup ended when that was not well (paused for a full disk, or a
   * write failed): its status keeps saying so after Stop, though some audio may be kept.
   */
  private lastEnded: Pick<BackupStatus, 'state' | 'message'> | null = null;

  constructor(private readonly options: AudioBackupOptions) {
    const { capture, store, userData, settings, logger } = options;
    this.clock = options.clock ?? (() => Date.now());
    this.compressor = new AudioCompressor({
      store,
      userData,
      logger,
      ...(options.run === undefined ? {} : { run: options.run }),
      onEncoded: (job) => {
        this.refresh(job.meetingId);
      },
    });
    this.writer = new AudioBackupWriter({
      store,
      userData,
      enabled: settings.audioBackup,
      logger,
      clock: this.clock,
      ...(options.freeDiskBytes === undefined ? {} : { freeDiskBytes: options.freeDiskBytes }),
      onFileClosed: (job) => {
        this.compressor.enqueue(job);
      },
      onChange: () => {
        capture.refreshStatus();
      },
    });
    this.sweeper = new AudioRetentionSweeper({
      store,
      retentionDays: settings.audioRetentionDays,
      logger,
      clock: this.clock,
      deleteMeetingAudio: (meetingId) => this.deleteAudio(meetingId, 'retention'),
    });
    this.quitHook = {
      name: 'stop the audio backup',
      // Closing files and killing one afconvert: well under a second.
      timeoutMs: 3_000,
      run: async () => {
        this.sweeper.stop();
        this.writer.stop();
        await this.compressor.stop();
      },
    };
  }

  /** At launch, before any recording (see the class comment). */
  start(): void {
    const { capture, logger } = this.options;
    this.writer.repairLeftOpen();
    capture.addAudioSink('audio-backup', this.writer);
    capture.addStatusContributor('audio-backup', () => this.contribution());
    capture.onRecording({
      started: (recording) => {
        this.writer.begin(recording);
      },
      ended: ({ meetingId }) => {
        this.recordingEnded(meetingId);
      },
    });
    this.launchWork = this.launch().catch((error: unknown) => {
      logger.error('audio backup: the launch sweep failed', { error: errorMessage(error) });
    });
    this.sweeper.start();
  }

  /** One meeting's backup, for its capture report. */
  report(meetingId: string): BackupStatus {
    const { store, settings } = this.options;
    if (this.writer.meetingId === meetingId) {
      const live = this.writer.live();
      if (live !== null) return live.status;
    }
    const files = store.listAudioFiles(meetingId);
    if (files.length === 0) {
      const deleted = store
        .listCaptureEvents(meetingId)
        .some((event) => event.kind === AUDIO_DELETED_EVENT);
      return {
        state: deleted ? 'deleted' : 'off',
        bytes: 0,
        keepUntil: null,
        keptForRerun: false,
        message: null,
      };
    }
    const keep = audioKeep(
      store.getMeeting(meetingId)?.endedAt ?? null,
      store.listUnrecoveredGaps(meetingId).length,
      settings.audioRetentionDays,
    );
    return {
      state: 'kept',
      bytes: files.reduce((sum, file) => sum + file.bytes, 0),
      keepUntil: keep.keepUntilMs === null ? null : new Date(keep.keepUntilMs).toISOString(),
      keptForRerun: keep.keptForRerun,
      message: null,
    };
  }

  /**
   * Delete-audio (`audio:delete-meeting`): the meeting's folder and every file in it, after the
   * path check (audioPaths.ts). Its lines stay. Refused for the meeting being recorded.
   */
  deleteMeetingAudio(meetingId: string): Promise<void> {
    return this.deleteAudio(meetingId, 'user');
  }

  /**
   * A meeting's kept audio changed outside this class (M2-T16's re-run recovered its gap): the
   * status, which shows the last meeting's backup after Stop, is read again.
   */
  refresh(meetingId: string): void {
    if (this.writer.meetingId !== null || this.lastMeetingId !== meetingId) return;
    this.last = this.lastStatus(meetingId);
    this.options.capture.refreshStatus();
  }

  /** The launch work and every queued encoding are done (tests). */
  async idle(): Promise<void> {
    await this.launchWork;
    await this.compressor.idle();
  }

  private async launch(): Promise<void> {
    const { store } = this.options;
    await this.sweeper.sweep();
    // WAVs the last run closed but never encoded (a quit or a crash came first, afconvert failed,
    // or the launch repair just closed them). An empty one has nothing to encode.
    for (const meetingId of store.listMeetingIdsWithAudio()) {
      for (const file of store.listAudioFiles(meetingId)) {
        if (file.format === 'wav' && file.closedAt !== null && file.bytes > WAV_HEADER_BYTES) {
          this.compressor.enqueue({ id: file.id, meetingId, path: file.path });
        }
      }
    }
  }

  private async deleteAudio(meetingId: string, by: DeletedBy): Promise<void> {
    const { store, userData, logger } = this.options;
    // Checks the id before anything is touched (`../x` throws here), as the IPC already did.
    meetingAudioDir(userData, meetingId);
    this.refuseWhileRecording(meetingId);
    // afconvert writing into the folder would make the delete fail, or leave a file behind it.
    await this.compressor.forget(meetingId);
    this.refuseWhileRecording(meetingId);
    const folder = removeMeetingAudioDir(userData, meetingId);
    const now = this.clock();
    const files = store.markMeetingAudioDeleted(meetingId, new Date(now).toISOString());
    const meeting = store.getMeeting(meetingId);
    if (meeting !== null) {
      store.addCaptureEvent({
        meetingId,
        at: new Date(now).toISOString(),
        offsetMs: Math.max(0, Math.round(now - Date.parse(meeting.startedAt))),
        source: null,
        kind: AUDIO_DELETED_EVENT,
        detail: { by, files },
      });
    }
    logger.info("audio backup: deleted a meeting's audio", { meetingId, by, files, folder });
    this.refresh(meetingId);
  }

  private refuseWhileRecording(meetingId: string): void {
    if (this.writer.meetingId === meetingId) {
      throw new Error(`Meeting ${meetingId} is being recorded: stop it before deleting its audio.`);
    }
  }

  private recordingEnded(meetingId: string): void {
    const final = this.writer.live()?.status ?? null;
    this.writer.end(meetingId);
    this.lastMeetingId = meetingId;
    this.lastEnded =
      final !== null && (final.state === 'paused' || final.state === 'error')
        ? { state: final.state, message: final.message }
        : null;
    this.last = this.lastStatus(meetingId);
  }

  private lastStatus(meetingId: string): BackupStatus {
    const status = this.report(meetingId);
    if (this.lastEnded === null || status.state === 'deleted') return status;
    return { ...status, ...this.lastEnded };
  }

  /** Read twice a second while recording: memory only, never the store. */
  private contribution(): StatusContribution {
    const live = this.writer.live();
    if (live !== null) {
      // No `warnings: []`: CaptureService would put an empty list in every status.
      return live.warning === null
        ? { backup: live.status }
        : { backup: live.status, warnings: [live.warning] };
    }
    return this.last === null ? {} : { backup: this.last };
  }
}
