import { execFile } from 'node:child_process';
import { chmodSync, renameSync, rmSync, statSync } from 'node:fs';
import { errorMessage, type Logger } from '../logger';
import type { TranscriptStore } from '../store/TranscriptStore';
import { PRIVATE_FILE_MODE, resolveStoredAudioPath } from './audioPaths';

/** Ships with macOS: the backup needs no audio dependency (M2 D5). */
export const AFCONVERT = '/usr/bin/afconvert';

/**
 * AAC at 48 kbps: about 43 MB per call hour for both streams against 230 MB of WAV (M2 D5), and
 * plenty for speech at 16 kHz. AudioCompressor.mac.test.ts runs this exact command on a Mac, and
 * the backup fixture (test/fixtures/backup/make-backup-fixture.mjs) was made with it: change all
 * three together.
 */
const AAC_BITS_PER_SECOND = 48_000;

/** A 60 s chunk encodes in well under a second; this only stops a hung afconvert. */
const ENCODE_TIMEOUT_MS = 60_000;

/** Runs a tool to its end, or rejects with what it printed; `signal` kills it. */
export type RunTool = (
  command: string,
  args: readonly string[],
  options: { timeoutMs: number; signal: AbortSignal },
) => Promise<void>;

export const runTool: RunTool = (command, args, { timeoutMs, signal }) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, signal }, (error, _stdout, stderr) => {
      if (error === null) {
        resolve();
        return;
      }
      const said = stderr.trim();
      reject(
        new Error(`${command} failed: ${error.message}${said === '' ? '' : ` (${said})`}`, {
          cause: error,
        }),
      );
    });
  });

/** One closed WAV of the backup to turn into AAC: its `audio_files` row as the writer left it. */
export interface CompressJob {
  id: string;
  meetingId: string;
  /** Its stored path, relative to userData, ending in `.wav`. */
  path: string;
}

export interface AudioCompressorOptions {
  store: Pick<TranscriptStore, 'listAudioFiles' | 'markAudioFileEncoded'>;
  userData: string;
  logger: Logger;
  run?: RunTool;
  /** A file is now an m4a of `bytes`: its row, size and path changed. */
  onEncoded?: (job: CompressJob, bytes: number) => void;
}

interface Running {
  job: CompressJob;
  controller: AbortController;
  done: Promise<void>;
}

/**
 * Turns each closed backup WAV into AAC in an m4a, in the background and one file at a time, with
 * macOS's afconvert (M2 D5). The row is switched to the m4a before the WAV is deleted, so a reader
 * of `audio_files` (M2-T16's re-run, M3's `bench clip`) finds a file the row names, except in the
 * instant between its read of the row and its open of the WAV: a reader that finds the WAV gone
 * must read the row again, not give up on the audio. If afconvert fails
 * the WAV stays and the row keeps naming it; the next launch tries again (AudioBackup).
 *
 * afconvert writes to a name of its own (`<file>.encoding.m4a`) that is renamed only once it has
 * finished, so a crash or a kill at quit never leaves a torn m4a under the name a row could name.
 */
export class AudioCompressor {
  private readonly run: RunTool;
  private queue: CompressJob[] = [];
  private running: Running | null = null;
  private stopped = false;

  constructor(private readonly options: AudioCompressorOptions) {
    this.run = options.run ?? runTool;
  }

  /** Queues a closed WAV. A file already queued or being encoded is not queued again. */
  enqueue(job: CompressJob): void {
    if (this.stopped) return;
    if (this.running?.job.id === job.id || this.queue.some((queued) => queued.id === job.id)) {
      return;
    }
    this.queue.push(job);
    this.next();
  }

  /**
   * Drops a meeting's queued files and stops the one being encoded, if it is the meeting's: its
   * folder is about to be deleted, and afconvert writing into it would make the delete fail.
   */
  async forget(meetingId: string): Promise<void> {
    this.queue = this.queue.filter((job) => job.meetingId !== meetingId);
    const running = this.running;
    if (running?.job.meetingId !== meetingId) return;
    running.controller.abort();
    await running.done;
  }

  /** At quit: stops the encoding under way and takes no more; the WAVs wait for the next launch. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.queue = [];
    const running = this.running;
    if (running === null) return;
    running.controller.abort();
    await running.done;
  }

  /** Resolves once nothing is queued or being encoded. */
  async idle(): Promise<void> {
    while (this.running !== null) await this.running.done;
  }

  private next(): void {
    if (this.running !== null || this.stopped) return;
    const job = this.queue.shift();
    if (job === undefined) return;
    const controller = new AbortController();
    const done = this.encode(job, controller.signal).finally(() => {
      this.running = null;
      this.next();
    });
    this.running = { job, controller, done };
  }

  /** Never rejects: a file that cannot be encoded keeps its WAV, and the log says why. */
  private async encode(job: CompressJob, signal: AbortSignal): Promise<void> {
    try {
      await this.encodeOnce(job, signal);
    } catch (error) {
      // The store refused a read (closed at quit, the disk full): the WAV and its row stay.
      this.options.logger.error('audio backup: could not encode a WAV; the WAV is kept', {
        meetingId: job.meetingId,
        fileId: job.id,
        error: errorMessage(error),
      });
    }
  }

  private async encodeOnce(job: CompressJob, signal: AbortSignal): Promise<void> {
    const { store, userData, logger } = this.options;
    const fields = { meetingId: job.meetingId, fileId: job.id };
    if (!this.stillWav(job)) return;
    let wav: string;
    let m4aPath: string;
    let m4a: string;
    try {
      if (!job.path.endsWith('.wav')) {
        throw new Error(`the backup file ${job.path} does not end in .wav`);
      }
      m4aPath = `${job.path.slice(0, -'.wav'.length)}.m4a`;
      wav = resolveStoredAudioPath(userData, job.path);
      m4a = resolveStoredAudioPath(userData, m4aPath);
    } catch (error) {
      logger.warn('audio backup: not encoding a file outside the audio folder', {
        ...fields,
        error: errorMessage(error),
      });
      return;
    }
    const partial = `${m4a.slice(0, -'.m4a'.length)}.encoding.m4a`;
    try {
      await this.run(AFCONVERT, encodeArgs(wav, partial), {
        timeoutMs: ENCODE_TIMEOUT_MS,
        signal,
      });
      // afconvert creates it under the umask (0644), and the rename keeps that mode: without this
      // every m4a, kept for weeks, is readable by anyone who gets a copy of the folder.
      chmodSync(partial, PRIVATE_FILE_MODE);
      renameSync(partial, m4a);
    } catch (error) {
      this.remove(partial, fields);
      if (signal.aborted) {
        logger.info('audio backup: encoding stopped; the WAV is kept', fields);
        return;
      }
      logger.warn('audio backup: could not encode a WAV to AAC; the WAV is kept', {
        ...fields,
        error: errorMessage(error),
      });
      return;
    }
    // Deleted while afconvert ran (delete-audio waits for it, a retention sweep does too): the
    // folder may be gone already, and the row must not come back to life with a new path.
    if (!this.stillWav(job)) {
      this.remove(m4a, fields);
      return;
    }
    // If this throws, the row still names the WAV, which is still there: nothing is lost, and the
    // next launch encodes it again over this m4a.
    const bytes = statSync(m4a).size;
    store.markAudioFileEncoded(job.id, { path: m4aPath, format: 'm4a', bytes });
    this.remove(wav, fields);
    this.options.onEncoded?.(job, bytes);
  }

  /** The file is still a closed WAV of the backup: not deleted, not encoded already. */
  private stillWav(job: CompressJob): boolean {
    return this.options.store
      .listAudioFiles(job.meetingId)
      .some((file) => file.id === job.id && file.format === 'wav' && file.closedAt !== null);
  }

  /** A leftover file: removing it is tidying, so a failure is logged and nothing else. */
  private remove(path: string, fields: Record<string, string>): void {
    try {
      rmSync(path, { force: true });
    } catch (error) {
      this.options.logger.warn('audio backup: could not remove a leftover file', {
        ...fields,
        error: errorMessage(error),
      });
    }
  }
}

/** afconvert's arguments: AAC in an MPEG-4 file (m4af) at 48 kbps, from a backup WAV. */
function encodeArgs(wav: string, m4a: string): string[] {
  return ['-f', 'm4af', '-d', 'aac', '-b', String(AAC_BITS_PER_SECOND), wav, m4a];
}
