import { statfsSync } from 'node:fs';
import { BACKUP_MIN_FREE_BYTES } from '../../shared/capture';
import { errorMessage } from '../logger';

/** The free bytes of the volume that holds a folder; injected in tests. */
export type FreeDiskBytes = (path: string) => number;

/**
 * Free bytes an ordinary process may still write on the volume that holds `path` (`bavail`, not
 * `bfree`: the blocks reserved for root are not Roger's to fill). Throws with the path.
 */
export const freeDiskBytes: FreeDiskBytes = (path) => {
  try {
    const { bavail, bsize } = statfsSync(path);
    return bavail * bsize;
  } catch (error) {
    throw new Error(`could not read the free disk space at ${path}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
};

/**
 * Whether the backup may keep writing (M2 D5): below BACKUP_MIN_FREE_BYTES it pauses, so a long
 * call's audio never takes the last of the disk that SQLite, the transcript and macOS need.
 */
export function hasBackupRoom(freeBytes: number): boolean {
  return freeBytes >= BACKUP_MIN_FREE_BYTES;
}
