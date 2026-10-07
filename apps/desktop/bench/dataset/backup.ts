import { execFile } from 'node:child_process';
import { type Stats, existsSync } from 'node:fs';
import { chmod, mkdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type AudioSource, isAudioSource } from '../../src/shared/transcript';
import { WAV_SAMPLE_RATE, readWav } from '../core/wav';
import { isMissingFile } from './item';

/**
 * The app's local audio backup, read for `bench clip`, and the two guards on where clips may be
 * kept. The contract with M2-T15, stated in both plans: open `<userData>/roger.sqlite` read-only
 * with `node:sqlite` and read the meeting's `audio_files` rows where `deleted_at` is null, ordered
 * by `start_ms`; each row's `path` is relative to userData. Chunks are WAV as captured (16 kHz mono
 * PCM16) or AAC m4a that `/usr/bin/afconvert` decodes, so the bench needs no new dependency.
 */

/**
 * The installed app's userData folder; its `roger started` log line prints the folder in use. A
 * build run from the checkout keeps its data elsewhere (M5-T11's "Roger Dev"), so pass that one
 * with --user-data.
 */
export const DEFAULT_USER_DATA_DIR = join(homedir(), 'Library', 'Application Support', 'Roger');
export const BACKUP_DATABASE = 'roger.sqlite';
export const AFCONVERT = '/usr/bin/afconvert';
export const FDESETUP = '/usr/bin/fdesetup';

const FDESETUP_TIMEOUT_MS = 10_000;
/** A backup chunk is 60 s at most, which afconvert decodes in well under a second. */
const AFCONVERT_TIMEOUT_MS = 60_000;

/** One kept chunk of one stream. */
export interface BackupChunk {
  source: AudioSource;
  /** Meeting offset of the first sample. */
  startMs: number;
  /** Meeting offset just past the last sample; null while the app is still writing the chunk. */
  endMs: number | null;
  format: 'wav' | 'm4a';
  /** Absolute. */
  path: string;
}

export interface BackupMeeting {
  meetingId: string;
  /** ISO 8601, UTC. */
  startedAt: string;
  /** Every kept chunk of both streams, by start then stream. Empty when its audio was deleted. */
  chunks: BackupChunk[];
}

/** Turns one backup chunk into 16 kHz mono samples; `scratchDir` takes any decoded file. */
export type DecodeChunk = (chunk: BackupChunk, scratchDir: string) => Promise<Int16Array>;

/** The meeting's kept chunks. Throws with the database path when it or the meeting is missing. */
export function readBackupMeeting(userDataDir: string, meetingId: string): BackupMeeting {
  const databasePath = join(userDataDir, BACKUP_DATABASE);
  if (!existsSync(databasePath)) {
    throw new Error(
      `no Roger database at ${databasePath}; pass --user-data <folder> with the folder the ` +
        `app's "roger started" log line prints (default ${DEFAULT_USER_DATA_DIR})`,
    );
  }
  // Read-only, never a write: the app holds this file open in WAL mode and writes to it while a
  // call records. A read-only connection still sees rows the app committed to the -wal file.
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const meeting = db.prepare('SELECT started_at FROM meetings WHERE id = ?').get(meetingId);
    if (meeting === undefined) {
      throw new Error(`meeting ${meetingId} is not in ${databasePath}`);
    }
    const audioRoot = resolve(userDataDir, 'audio');
    const chunks = db
      .prepare(
        `SELECT id, source, start_ms, end_ms, path, format FROM audio_files
         WHERE meeting_id = ? AND deleted_at IS NULL ORDER BY start_ms, source`,
      )
      .all(meetingId)
      .map((row) => parseChunk(row, userDataDir, audioRoot, databasePath));
    return { meetingId, startedAt: String(meeting.started_at), chunks };
  } finally {
    db.close();
  }
}

/** Decodes with afconvert (m4a) or reads the WAV as captured. */
export const decodeBackupChunk: DecodeChunk = async (chunk, scratchDir) => {
  if (chunk.format === 'wav') return readWav(chunk.path);
  const decoded = join(scratchDir, `${basename(chunk.path)}.wav`);
  await runTool(
    AFCONVERT,
    ['-f', 'WAVE', '-d', `LEI16@${WAV_SAMPLE_RATE}`, '-c', '1', chunk.path, decoded],
    AFCONVERT_TIMEOUT_MS,
  );
  try {
    return await readWav(decoded);
  } finally {
    await rm(decoded, { force: true });
  }
};

/** What `fdesetup status` prints. */
export type ReadFileVaultStatus = () => Promise<string>;

export const readFileVaultStatus: ReadFileVaultStatus = () =>
  runTool(FDESETUP, ['status'], FDESETUP_TIMEOUT_MS);

/**
 * Refuses unless FileVault is on (M3 D2: clips are recordings of colleagues). `fdesetup` reports
 * the startup disk only, which holds the default ~/Roger-bench; a ROGER_BENCH_DIR on another volume
 * is not covered by this check.
 */
export async function assertFileVaultOn(
  read: ReadFileVaultStatus = readFileVaultStatus,
): Promise<void> {
  let status: string;
  try {
    status = await read();
  } catch (error) {
    throw new Error(
      `could not read the FileVault status (${FDESETUP} status): ${messageOf(error)}; bench ` +
        'clips are kept only on a FileVault disk',
      { cause: error },
    );
  }
  // "FileVault is Off, but will be enabled after the next restart." is not on yet.
  const firstLine = status.trim().split('\n')[0] ?? '';
  if (firstLine !== 'FileVault is On.') {
    throw new Error(
      `FileVault is not on (fdesetup says ${JSON.stringify(firstLine)}): bench clips are ` +
        'recordings of colleagues and are kept only on an encrypted disk. Turn on FileVault in ' +
        'System Settings > Privacy & Security, then clip again.',
    );
  }
}

/**
 * Creates the bench folder with mode 0700, or checks that an existing one is 0700 or tighter. An
 * existing looser folder is refused, never tightened: ROGER_BENCH_DIR may name a folder that holds
 * other things, and a silent chmod would change what others can open there.
 */
export async function ensurePrivateBenchDir(dir: string): Promise<void> {
  let info: Stats;
  try {
    info = await stat(dir);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // mkdir's mode passes through the umask; set it outright.
    await chmod(dir, 0o700);
    return;
  }
  if (!info.isDirectory()) throw new Error(`${dir} is not a folder; the bench needs a folder`);
  const mode = info.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `${dir} is mode 0${mode.toString(8)}; the bench folder holds recordings of colleagues, so ` +
        `only you may open it: chmod 700 '${dir}'`,
    );
  }
}

function parseChunk(
  row: Record<string, unknown>,
  userDataDir: string,
  audioRoot: string,
  databasePath: string,
): BackupChunk {
  const id = String(row.id);
  const fail = (problem: string): never => {
    throw new Error(`${databasePath}: audio_files row ${id}: ${problem}`);
  };
  const { source, start_ms: startMs, end_ms: endMs, path, format } = row;
  if (!isAudioSource(source)) return fail('source must be mic or system');
  if (typeof startMs !== 'number' || startMs < 0) return fail('start_ms must be 0 or more');
  if (endMs !== null && (typeof endMs !== 'number' || endMs < startMs)) {
    return fail('end_ms must be null or at least start_ms');
  }
  if (format !== 'wav' && format !== 'm4a') return fail('format must be wav or m4a');
  if (typeof path !== 'string') return fail('path must be text');
  // The store keeps paths relative to userData and never climbing out; a row that does is refused
  // before afconvert is pointed at it.
  const absolute = resolve(userDataDir, path);
  if (!absolute.startsWith(audioRoot + sep)) return fail('path must stay inside the audio folder');
  return { source, startMs, endMs, format, path: absolute };
}

/** Runs a macOS tool and resolves with its stdout; a failure carries its stderr. */
function runTool(file: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(file, args, { timeout: timeoutMs, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error === null) {
        resolvePromise(stdout);
        return;
      }
      const detail = stderr.trim() === '' ? error.message : stderr.trim();
      reject(new Error(`${file} ${args.join(' ')} failed: ${detail}`, { cause: error }));
    });
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
