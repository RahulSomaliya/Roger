import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteTranscriptStore } from '../../store/SqliteTranscriptStore';

/**
 * M2-T3's committed backup fixture (`test/fixtures/backup/`, made by its
 * `make-backup-fixture.mjs`), copied for a test that changes it. Never open the committed
 * `roger.sqlite` through the store: the store turns on WAL and migrates in place.
 *
 * Its one meeting started at 09:00:00 and ended at 09:00:05 on 2026-10-06; each stream has an m4a
 * chunk at 0 to 2000 ms and a WAV chunk at 3000 to 5000 ms, and call audio has an unrecovered gap
 * at 3500 to 4500 ms.
 */
export const FIXTURE_MEETING_ID = '0b6f1c5e-3f7a-4c1e-9d2b-6a8e4f1d2c3b';
export const FIXTURE_ENDED_AT_MS = Date.parse('2026-10-06T09:00:05.000Z');
export const FIXTURE_GAP_ID = '9d3e4f5a-6b7c-4d8e-af9b-0c1d2e3f4a5b';

const FIXTURE_DIR = fileURLToPath(new URL('../../../../test/fixtures/backup/', import.meta.url));

export interface FixtureCopy {
  /** A temp folder laid out as the app's userData: `roger.sqlite` and `audio/`. */
  userData: string;
  store: SqliteTranscriptStore;
  /** Closes the store and deletes the copy. */
  remove: () => void;
}

/** A private copy of the fixture as a userData folder, its store open with `clock`. */
export function copyBackupFixture(clock: () => Date = () => new Date()): FixtureCopy {
  const userData = mkdtempSync(join(tmpdir(), 'roger-backup-fixture-'));
  cpSync(FIXTURE_DIR, userData, {
    recursive: true,
    filter: (source) => !source.endsWith('.mjs'),
  });
  const store = new SqliteTranscriptStore(join(userData, 'roger.sqlite'), clock);
  return {
    userData,
    store,
    remove: () => {
      store.close();
      rmSync(userData, { recursive: true, force: true });
    },
  };
}
