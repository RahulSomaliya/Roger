import { chmodSync, lstatSync, mkdirSync, rmSync } from 'node:fs';
import { isAbsolute, join, posix, relative, resolve } from 'node:path';
import { isUuidV4 } from '../ipc-validation';

/**
 * Where the local audio backup lives (M2 D5): `userData/audio/<meeting>/<file>`, each folder mode
 * 0700 and each file 0600, never uploaded. `audio_files.path` holds the file relative to userData
 * (`audio/<meeting>/<file>`, NewAudioFile.path), which M3's `bench clip` resolves against a
 * userData folder of its own choosing.
 *
 * Every path the backup writes or deletes through comes from here. A meeting id must be a
 * lowercase UUIDv4 (a renderer-supplied `../x` would otherwise make delete-audio a path-traversal
 * delete), and a stored path must stay inside the audio root, judged by its text. A folder that is
 * a link is refused only where folders are made (ensureMeetingAudioDir, once per recording) and
 * where one is deleted (removeMeetingAudioDir), since a recursive delete through a link empties
 * whatever it points at. A recording's later files, the compressor and the launch repair go by the
 * text alone, so they would write through a link swapped in later. That takes the same user's
 * hand, and they only touch files an `audio_files` row names.
 */

const AUDIO_DIR_NAME = 'audio';
/** Readable by its owner only: the audio of colleagues' calls. */
const PRIVATE_DIR_MODE = 0o700;
/**
 * Every backup file, WAV or m4a, is owner-only too, so a copied folder stays private. A file made
 * by a tool (afconvert) gets the umask's 0644: AudioCompressor sets this before its rename.
 */
export const PRIVATE_FILE_MODE = 0o600;

/** The folder that holds every meeting's audio. */
export function audioRoot(userData: string): string {
  return join(userData, AUDIO_DIR_NAME);
}

/** One meeting's folder. Throws on an id that is not a lowercase UUIDv4. */
export function meetingAudioDir(userData: string, meetingId: string): string {
  if (!isUuidV4(meetingId)) {
    throw new Error(`${JSON.stringify(meetingId)} is not a meeting id: no audio folder for it.`);
  }
  return join(audioRoot(userData), meetingId);
}

/** A file of a meeting's folder in the form `audio_files.path` stores: relative to userData. */
export function storedAudioPath(meetingId: string, fileName: string): string {
  return posix.join(AUDIO_DIR_NAME, meetingId, fileName);
}

/**
 * The absolute path of a stored `audio_files.path`. Throws when it would point outside the audio
 * root (absolute, climbing with `..`, or another file of userData), so an edited database cannot
 * aim the compressor or a repair at anything else. It reads the text only and never checks for a
 * link (see the header).
 */
export function resolveStoredAudioPath(userData: string, stored: string): string {
  const root = audioRoot(userData);
  const path = resolve(userData, stored);
  const inside = relative(root, path);
  if (isAbsolute(stored) || inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    throw new Error(`The audio path ${stored} is outside the audio folder.`);
  }
  return path;
}

/** Creates the audio root and the meeting's folder, both mode 0700. Returns the meeting's folder. */
export function ensureMeetingAudioDir(userData: string, meetingId: string): string {
  const dir = meetingAudioDir(userData, meetingId);
  const root = audioRoot(userData);
  for (const folder of [root, dir]) {
    mkdirSync(folder, { recursive: true, mode: PRIVATE_DIR_MODE });
    assertRealFolder(folder);
    // mkdir's mode passes through the umask, and an existing folder keeps its own: set it outright.
    chmodSync(folder, PRIVATE_DIR_MODE);
  }
  return dir;
}

/**
 * Deletes one meeting's folder with every file in it. Returns false when there was no folder.
 * Throws, deleting nothing, when the folder or the audio root is a link or not a folder: a link
 * would aim the delete at wherever it points.
 */
export function removeMeetingAudioDir(userData: string, meetingId: string): boolean {
  const dir = meetingAudioDir(userData, meetingId);
  const root = audioRoot(userData);
  if (!exists(root)) return false;
  assertRealFolder(root);
  if (!exists(dir)) return false;
  assertRealFolder(dir);
  // No link is followed inside it either: rm removes a link, never what it points at.
  rmSync(dir, { recursive: true });
  return true;
}

/** Throws unless `path` is a folder itself, not a link to one. */
function assertRealFolder(path: string): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(
      `${path} is not a folder (a link or a file): the audio backup will not use it.`,
    );
  }
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
