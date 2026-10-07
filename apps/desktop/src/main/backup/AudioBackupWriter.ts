import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import {
  BACKUP_MIN_FREE_BYTES,
  type BackupState,
  type BackupStatus,
  type CaptureWarning,
} from '../../shared/capture';
import { PCM_SAMPLE_RATE } from '../../shared/ipc';
import { AUDIO_SOURCES, type AudioSource } from '../../shared/transcript';
import type { AudioSink } from '../capture/AudioFanout';
import { AudioTimeline } from '../capture/AudioTimeline';
import { errorMessage, type Logger } from '../logger';
import type { CaptureEvent, JsonObject, TranscriptStore } from '../store/TranscriptStore';
import {
  ensureMeetingAudioDir,
  PRIVATE_FILE_MODE,
  removeEmptyMeetingAudioDir,
  resolveStoredAudioPath,
  storedAudioPath,
} from './audioPaths';
import type { CompressJob } from './AudioCompressor';
import { type FreeDiskBytes, freeDiskBytes, hasBackupRoom } from './diskGuard';
import { repairWavFile, WAV_HEADER_BYTES, wavDataBytesToMs, wavHeader } from './wav';

/**
 * Free disk space is read when a recording starts, then once this much of the clock has passed
 * while it runs, and at once after the clock steps back (checkDisk).
 */
export const DISK_CHECK_INTERVAL_MS = 10_000;

/** A backup file holds at most this much of one stream (M2 D5, after anarlog's 60 s chunks). */
const MAX_FILE_MS = 60_000;
const BYTES_PER_SAMPLE = 2;
const MAX_FILE_BYTES = ((MAX_FILE_MS * PCM_SAMPLE_RATE) / 1_000) * BYTES_PER_SAMPLE;
/** The capture events saved when a recording's audio stops being kept: missedAudio reads them. */
const BACKUP_PAUSED_EVENT = 'backup_paused';
/** Its detail is `{ error: <code> }` (errorCode), never a path. */
const BACKUP_FAILED_EVENT = 'backup_failed';
/** errorCode's answer for an error with no Node code (a folder that is a link). */
const UNKNOWN_ERROR_CODE = 'unknown';

/** The free space the backup pauses below, for people: "2 GB". */
const MIN_FREE_TEXT = `${BACKUP_MIN_FREE_BYTES / 1024 ** 3} GB`;

const PAUSED_MESSAGE =
  `Less than ${MIN_FREE_TEXT} of disk is free, so Roger stopped keeping ` +
  "this call's audio. The transcript goes on; free some space and the backup starts again.";

/** What the backup needs of a recording that starts (CaptureService's RecordingStarted). */
export interface BackupRecording {
  meetingId: string;
  /** Every offset counts from it; a resumed meeting's is its first start. */
  meetingStartedAtMs: number;
}

/** The backup of the recording that runs, for the status. */
export interface LiveBackup {
  status: BackupStatus;
  /** `backup-paused` while the disk is nearly full; null otherwise. */
  warning: CaptureWarning | null;
}

export interface AudioBackupWriterOptions {
  store: Pick<
    TranscriptStore,
    'addAudioFile' | 'closeAudioFile' | 'addCaptureEvent' | 'listAudioFiles' | 'listOpenAudioFiles'
  >;
  userData: string;
  /** config.json's `audioBackup` (false too when `audioRetentionDays` is 0): nothing is written. */
  enabled: boolean;
  logger: Logger;
  /** Each file it closes, for the compressor. */
  onFileClosed: (job: CompressJob) => void;
  /** The state or the warning changed (the slot passes `capture.refreshStatus`). */
  onChange: () => void;
  freeDiskBytes?: FreeDiskBytes;
  clock?: () => number;
  newId?: () => string;
}

interface OpenWav {
  id: string;
  /** Absolute. */
  path: string;
  /** As `audio_files.path` holds it. */
  storedPath: string;
  fd: number;
  /** Meeting offset of its first sample. */
  startMs: number;
  /** Wall clock (epoch ms) of its first sample, as its timeline run places it. */
  startCapturedAtMs: number;
  dataBytes: number;
}

interface SourceBackup {
  timeline: AudioTimeline;
  file: OpenWav | null;
}

interface Recording extends BackupRecording {
  state: Extract<BackupState, 'writing' | 'paused' | 'error' | 'off'>;
  message: string | null;
  warning: CaptureWarning | null;
  /** The meeting's folder; null when backup is off or it could not be made. */
  dir: string | null;
  sources: Record<AudioSource, SourceBackup>;
  /**
   * The meeting's audio on disk, as BackupStatus.bytes means it: every file's size as its row
   * says, an open file's as written so far. Never a running total of what was written: the
   * compressor swaps each closed WAV for an m4a about 5 times smaller while the call goes on
   * (fileEncoded), and a resumed meeting (M2 D7) already has audio on disk at begin.
   */
  bytes: number;
  /** Each of the meeting's files on disk but the open ones, by id: its size, to swap at encode. */
  fileBytes: Map<string, number>;
  /** When free space was last read (the writer's clock); null until the first read. */
  lastDiskCheckAtMs: number | null;
  /** Free space could not be read: said once per recording, then writing goes on. */
  diskUnreadable: boolean;
}

/**
 * The local audio backup while recording (M2 D5): a fan-out sink (AudioFanout) that writes each
 * stream to WAV files of at most 60 s under `userData/audio/<meeting>`, with one `audio_files` row
 * per file, so a gap the vendor never heard can be re-run after Stop (M2-T16) and M3's bench can
 * clip real calls. Never uploaded.
 *
 * Files sit on the meeting timeline exactly as the transcript lines do: each source has its own
 * AudioTimeline, fed the same capture times CaptureSession's vendor streams are, and a new file
 * starts at every new timeline run (a stall, a sleep, a clock jump), so a file never spans a hole.
 * The offsets are rounded where CaptureSession rounds a line's (`meetingOffset`), so a gap's
 * offsets and a file's agree to the millisecond. A file is written with its header's sizes at 0
 * and closed with the right ones; one a crash left open is repaired at the next launch
 * (`repairLeftOpen`).
 *
 * Below BACKUP_MIN_FREE_BYTES of free disk it pauses with a loud `backup-paused` warning and starts
 * again once there is room. A write that fails ends the backup for the recording, with the reason
 * in its status. Neither ever touches the recording: a sink only reads audio (house rule 9), and
 * the transcript is what the call is for.
 *
 * Writes are synchronous on main's event loop, like the store's: 3,200 bytes per source every
 * 100 ms into the page cache, so a chunk is on disk, in order, before the next one arrives.
 */
export class AudioBackupWriter implements AudioSink {
  private readonly clock: () => number;
  private readonly freeDiskBytes: FreeDiskBytes;
  private readonly newId: () => string;
  private recording: Recording | null = null;
  /** Quit: no recording is backed up after it. */
  private stopped = false;

  constructor(private readonly options: AudioBackupWriterOptions) {
    this.clock = options.clock ?? (() => Date.now());
    this.freeDiskBytes = options.freeDiskBytes ?? freeDiskBytes;
    this.newId = options.newId ?? randomUUID;
  }

  /** The meeting being backed up; null while none is. */
  get meetingId(): string | null {
    return this.recording?.meetingId ?? null;
  }

  /** A recording started: its audio is kept from its first chunk. Never throws. */
  begin(recording: BackupRecording): void {
    if (this.stopped) return;
    const rec: Recording = {
      meetingId: recording.meetingId,
      meetingStartedAtMs: recording.meetingStartedAtMs,
      state: this.options.enabled ? 'writing' : 'off',
      message: null,
      warning: null,
      dir: null,
      sources: { mic: newSourceBackup(), system: newSourceBackup() },
      bytes: 0,
      fileBytes: new Map(),
      lastDiskCheckAtMs: null,
      diskUnreadable: false,
    };
    this.recording = rec;
    if (rec.state === 'writing') {
      try {
        for (const file of this.options.store.listAudioFiles(rec.meetingId)) {
          rec.fileBytes.set(file.id, file.bytes);
          rec.bytes += file.bytes;
        }
        rec.dir = ensureMeetingAudioDir(this.options.userData, rec.meetingId);
        this.checkDisk(rec, this.clock());
      } catch (error) {
        this.fail(rec, error);
      }
    }
    this.options.onChange();
  }

  onChunk(source: AudioSource, pcm: Uint8Array, capturedAtMs: number): void {
    const rec = this.recording;
    if (rec === null || rec.state === 'off' || rec.state === 'error') return;
    const backup = rec.sources[source];
    // Every chunk goes on the timeline, paused or not, so a file that starts after a pause sits
    // where its audio was captured. A time or a byte count it cannot place throws here, before
    // anything is written, and the fan-out logs it.
    const run = backup.timeline.append(capturedAtMs, pcm.byteLength / BYTES_PER_SAMPLE);
    if (pcm.byteLength === 0) return;
    try {
      this.checkDisk(rec, this.clock());
      if (rec.state !== 'writing') return;
      if (run !== null) this.closeFile(rec, source);
      this.write(rec, source, pcm);
    } catch (error) {
      this.fail(rec, error);
    }
  }

  /**
   * The compressor swapped a closed WAV for an m4a of `bytes`: the recording's figure follows the
   * disk. A file of another meeting (the launch encoding what an earlier run left) changes nothing.
   */
  fileEncoded(job: CompressJob, bytes: number): void {
    const rec = this.recording;
    if (rec?.meetingId !== job.meetingId) return;
    const was = rec.fileBytes.get(job.id);
    if (was === undefined) return;
    rec.fileBytes.set(job.id, bytes);
    rec.bytes += bytes - was;
  }

  /** The recording ended (Stop, or a Stop that failed): its files are closed. Never throws. */
  end(meetingId: string): void {
    const rec = this.recording;
    if (rec?.meetingId !== meetingId) return;
    this.recording = null;
    this.finish(rec);
  }

  /** At quit, for a recording whose Stop outran its bound: its files are closed now. */
  stop(): void {
    this.stopped = true;
    const rec = this.recording;
    this.recording = null;
    if (rec !== null) this.finish(rec);
  }

  /** The recording's backup; null while none runs. */
  live(): LiveBackup | null {
    const rec = this.recording;
    if (rec === null) return null;
    return {
      status: {
        state: rec.state,
        bytes: rec.bytes,
        keepUntil: null,
        keptForRerun: false,
        message: rec.message,
      },
      warning: rec.warning,
    };
  }

  /**
   * At launch, before any recording: every file a crash (or a quit whose Stop outran its bound)
   * left open gets its WAV header rewritten from the samples on disk, and its row closed at the
   * last whole sample. A row whose file is gone gets an empty WAV, so every row names a file a
   * reader can open. Returns how many it closed; a file it cannot repair is logged and stays open.
   * Runs synchronously, so the gap re-run (M2-T16's slot, after this one) finds them closed.
   */
  repairLeftOpen(): number {
    const { store, userData, logger } = this.options;
    const closedAt = new Date(this.clock()).toISOString();
    let repaired = 0;
    for (const file of store.listOpenAudioFiles()) {
      const fields = { meetingId: file.meetingId, fileId: file.id };
      try {
        // Only the writer's own WAVs are ever open: repairWavFile would ruin anything else.
        if (file.format !== 'wav') throw new Error(`an open ${file.format} file is not a WAV`);
        const path = resolveStoredAudioPath(userData, file.path);
        let dataBytes = 0;
        if (existsSync(path)) {
          dataBytes = repairWavFile(path).dataBytes;
        } else {
          ensureMeetingAudioDir(userData, file.meetingId);
          writeFileSync(path, wavHeader(0), { mode: PRIVATE_FILE_MODE, flag: 'wx' });
        }
        store.closeAudioFile(file.id, {
          endMs: file.startMs + Math.round(wavDataBytesToMs(dataBytes)),
          bytes: WAV_HEADER_BYTES + dataBytes,
          closedAt,
        });
        repaired += 1;
        logger.info('audio backup: repaired a file left open', {
          ...fields,
          audioMs: Math.round(wavDataBytesToMs(dataBytes)),
        });
      } catch (error) {
        logger.error('audio backup: could not repair a file left open', {
          ...fields,
          error: errorMessage(error),
        });
      }
    }
    return repaired;
  }

  /** Appends one chunk to its source's file, opening files as needed and splitting at 60 s. */
  private write(rec: Recording, source: AudioSource, pcm: Uint8Array): void {
    const backup = rec.sources[source];
    // The chunk was just appended, so its samples are all in the last run.
    const run = backup.timeline.runs.at(-1);
    if (run === undefined) throw new Error(`no timeline run for ${source} audio`);
    let sample = backup.timeline.sampleCount - pcm.byteLength / BYTES_PER_SAMPLE;
    let offset = 0;
    while (offset < pcm.byteLength) {
      const file =
        backup.file ??
        this.openFile(
          rec,
          source,
          run.capturedAtMs + ((sample - run.startSample) * 1_000) / PCM_SAMPLE_RATE,
        );
      const take = Math.min(MAX_FILE_BYTES - file.dataBytes, pcm.byteLength - offset);
      writeAll(file.fd, pcm, offset, take, null);
      file.dataBytes += take;
      rec.bytes += take;
      offset += take;
      sample += take / BYTES_PER_SAMPLE;
      if (file.dataBytes >= MAX_FILE_BYTES) this.closeFile(rec, source);
    }
  }

  private openFile(rec: Recording, source: AudioSource, capturedAtMs: number): OpenWav {
    if (rec.dir === null) throw new Error('the meeting has no audio folder');
    const now = this.clock();
    // As CaptureSession.meetingOffset rounds a line's: a gap and a file agree to the millisecond.
    const startMs = Math.max(0, Math.round(capturedAtMs - rec.meetingStartedAtMs));
    const id = this.newId();
    // The id's head keeps two files of one offset apart (a clock stepped back); the row's id is the
    // key, never the name (NewAudioFile.id).
    const name = `${source}-${String(startMs).padStart(9, '0')}-${id.slice(0, 8)}.wav`;
    const path = join(rec.dir, name);
    const storedPath = storedAudioPath(rec.meetingId, name);
    // The file before its row: a crash between leaves a header-only file no row names, never a
    // row that names nothing. The meeting's delete removes it with the folder; if it was the
    // meeting's first file nothing does, as no sweep or delete walks a folder without rows.
    const fd = openSync(path, 'wx', PRIVATE_FILE_MODE);
    try {
      writeAll(fd, wavHeader(0), 0, WAV_HEADER_BYTES, null);
      this.options.store.addAudioFile({
        id,
        meetingId: rec.meetingId,
        source,
        startMs,
        path: storedPath,
        format: 'wav',
        createdAt: new Date(now).toISOString(),
      });
    } catch (error) {
      closeSync(fd);
      this.removeStray(path, rec.meetingId);
      throw error;
    }
    rec.bytes += WAV_HEADER_BYTES;
    const file: OpenWav = {
      id,
      path,
      storedPath,
      fd,
      startMs,
      startCapturedAtMs: capturedAtMs,
      dataBytes: 0,
    };
    rec.sources[source].file = file;
    return file;
  }

  /**
   * Writes the header's sizes, closes the file and its row, and hands it to the compressor. If
   * this throws, the row stays open and the next launch repairs the file from its size.
   */
  private closeFile(rec: Recording, source: AudioSource): void {
    const backup = rec.sources[source];
    const file = backup.file;
    if (file === null) return;
    backup.file = null;
    rec.fileBytes.set(file.id, WAV_HEADER_BYTES + file.dataBytes);
    try {
      writeAll(file.fd, wavHeader(file.dataBytes), 0, WAV_HEADER_BYTES, 0);
    } finally {
      closeSync(file.fd);
    }
    const endMs = Math.round(
      file.startCapturedAtMs + wavDataBytesToMs(file.dataBytes) - rec.meetingStartedAtMs,
    );
    this.options.store.closeAudioFile(file.id, {
      endMs: Math.max(file.startMs, endMs),
      bytes: WAV_HEADER_BYTES + file.dataBytes,
      closedAt: new Date(this.clock()).toISOString(),
    });
    this.options.onFileClosed({ id: file.id, meetingId: rec.meetingId, path: file.storedPath });
  }

  /**
   * The recording is over: its files are closed, and its folder is removed if it holds none (the
   * backup paused or failed before its first file, or Stop came before the first chunk). No row
   * names such a folder, so no sweep or delete would ever find it. Never throws.
   */
  private finish(rec: Recording): void {
    this.closeAll(rec);
    if (rec.dir === null) return;
    try {
      removeEmptyMeetingAudioDir(this.options.userData, rec.meetingId);
    } catch (error) {
      // Harmless: an empty folder, and the next recording of the meeting uses it again.
      this.options.logger.warn('audio backup: could not remove an empty audio folder', {
        meetingId: rec.meetingId,
        error: errorMessage(error),
      });
    }
  }

  /** Closes both sources' files; one that cannot be closed is left for the launch repair. */
  private closeAll(rec: Recording): void {
    for (const source of AUDIO_SOURCES) {
      try {
        this.closeFile(rec, source);
      } catch (error) {
        this.options.logger.error(
          'audio backup: could not close a file; the next launch repairs it',
          { meetingId: rec.meetingId, source, error: errorMessage(error) },
        );
      }
    }
  }

  private checkDisk(rec: Recording, now: number): void {
    if (rec.dir === null) return;
    const last = rec.lastDiskCheckAtMs;
    // A clock that stepped back (a manual time change, an NTP step) reads at once. Waiting for the
    // old clock's next read would stop the pause and the resume for as long as the step, writing
    // into the reserve below BACKUP_MIN_FREE_BYTES unwarned (lifecycle.ts keeps its crash window
    // off the wall clock for the same reason).
    if (last !== null && now >= last && now - last < DISK_CHECK_INTERVAL_MS) return;
    rec.lastDiskCheckAtMs = now;
    let free: number;
    try {
      free = this.freeDiskBytes(rec.dir);
    } catch (error) {
      // Writing goes on: a full disk still shows up as a failed write.
      if (!rec.diskUnreadable) {
        this.options.logger.warn('audio backup: could not read the free disk space', {
          meetingId: rec.meetingId,
          error: errorMessage(error),
        });
      }
      rec.diskUnreadable = true;
      return;
    }
    if (rec.state === 'writing' && !hasBackupRoom(free)) {
      this.closeAll(rec);
      rec.state = 'paused';
      rec.message = PAUSED_MESSAGE;
      rec.warning = {
        kind: 'backup-paused',
        source: null,
        since: new Date(now).toISOString(),
        message: PAUSED_MESSAGE,
        // Loud (M2 scope): the audio a gap re-run would need is not being kept.
        loud: true,
      };
      this.event(rec, now, BACKUP_PAUSED_EVENT, {
        freeBytes: free,
        minFreeBytes: BACKUP_MIN_FREE_BYTES,
      });
      this.options.logger.warn('audio backup paused: the disk is nearly full', {
        meetingId: rec.meetingId,
        freeBytes: free,
      });
      this.options.onChange();
    } else if (rec.state === 'paused' && hasBackupRoom(free)) {
      rec.state = 'writing';
      rec.message = null;
      rec.warning = null;
      this.event(rec, now, 'backup_resumed', { freeBytes: free });
      this.options.logger.info('audio backup resumed', {
        meetingId: rec.meetingId,
        freeBytes: free,
      });
      this.options.onChange();
    }
  }

  /** A write failed: the backup ends for this recording, which goes on without it. */
  private fail(rec: Recording, error: unknown): void {
    this.closeAll(rec);
    const now = this.clock();
    rec.state = 'error';
    rec.message = `Roger stopped keeping this call's audio: ${errorMessage(error)}. The transcript goes on.`;
    rec.warning = null;
    this.event(rec, now, BACKUP_FAILED_EVENT, { error: errorCode(error) });
    this.options.logger.error('audio backup failed; the recording goes on without it', {
      meetingId: rec.meetingId,
      error: errorMessage(error),
    });
    this.options.onChange();
  }

  /** A capture event for the meeting's report; the store failing is logged, never thrown. */
  private event(rec: Recording, now: number, kind: string, detail: JsonObject): void {
    try {
      this.options.store.addCaptureEvent({
        meetingId: rec.meetingId,
        at: new Date(now).toISOString(),
        offsetMs: Math.max(0, Math.round(now - rec.meetingStartedAtMs)),
        source: null,
        kind,
        detail,
      });
    } catch (error) {
      this.options.logger.error('audio backup: could not record a capture event', {
        meetingId: rec.meetingId,
        kind,
        error: errorMessage(error),
      });
    }
  }

  private removeStray(path: string, meetingId: string): void {
    try {
      rmSync(path, { force: true });
    } catch (error) {
      // Harmless: a header-only file with no audio, which the meeting's delete removes with its
      // folder (see openFile).
      this.options.logger.warn('audio backup: could not remove a file it did not keep', {
        meetingId,
        error: errorMessage(error),
      });
    }
  }
}

function newSourceBackup(): SourceBackup {
  return { timeline: new AudioTimeline(PCM_SAMPLE_RATE), file: null };
}

/** writeSync may write less than asked; a backup file must never lose the rest of a chunk. */
function writeAll(
  fd: number,
  bytes: Uint8Array,
  offset: number,
  length: number,
  position: number | null,
): void {
  let written = 0;
  while (written < length) {
    written += writeSync(
      fd,
      bytes,
      offset + written,
      length - written,
      position === null ? null : position + written,
    );
  }
}

/** The code of a Node file error (`ENOSPC`, `EACCES`), for a capture event: never a path. */
function errorCode(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return UNKNOWN_ERROR_CODE;
}

/** How a meeting's backup stopped keeping its audio, for its report. */
export interface MissedAudio {
  state: Extract<BackupState, 'paused' | 'error'>;
  /** Ends a sentence: "less than 2 GB of disk was free". */
  reason: string;
}

/**
 * Whether a meeting's backup ever stopped keeping its audio, from the capture events the writer
 * saved. AudioBackup.report reads it once the recording is over, after Stop and after a relaunch,
 * when the writer's own state is gone: without it a backup that paused or failed before its first
 * file reports `off`, which says config.json turned the backup off. A failure wins over a pause. A
 * pause that ended (`backup_resumed`) still counts, as the minutes between were never kept; so do
 * the events of every recording of a resumed meeting (M2 D7), as none marks where one starts.
 */
export function missedAudio(
  events: readonly Pick<CaptureEvent, 'kind' | 'detail'>[],
): MissedAudio | null {
  let failed: Pick<CaptureEvent, 'detail'> | null = null;
  let paused = false;
  for (const event of events) {
    if (event.kind === BACKUP_FAILED_EVENT) failed = event;
    else if (event.kind === BACKUP_PAUSED_EVENT) paused = true;
  }
  if (failed !== null) {
    const code = failed.detail.error;
    const shown = typeof code === 'string' && code !== UNKNOWN_ERROR_CODE ? ` (${code})` : '';
    return { state: 'error', reason: `Roger could not write it to disk${shown}` };
  }
  return paused ? { state: 'paused', reason: `less than ${MIN_FREE_TEXT} of disk was free` } : null;
}
