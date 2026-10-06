import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BACKUP_MIN_FREE_BYTES } from '../../shared/capture';
import { freeDiskBytes, hasBackupRoom } from './diskGuard';

describe('the disk guard', () => {
  it('reads the free bytes of the volume that holds a folder', () => {
    const free = freeDiskBytes(tmpdir());
    expect(Number.isSafeInteger(free)).toBe(true);
    expect(free).toBeGreaterThan(0);
  });

  it('throws with the path when the folder is missing', () => {
    expect(() => freeDiskBytes(join(tmpdir(), 'roger-no-such-folder'))).toThrow(
      /roger-no-such-folder/,
    );
  });

  it('keeps writing at BACKUP_MIN_FREE_BYTES free and pauses one byte under it', () => {
    expect(hasBackupRoom(BACKUP_MIN_FREE_BYTES)).toBe(true);
    expect(hasBackupRoom(BACKUP_MIN_FREE_BYTES - 1)).toBe(false);
  });
});
