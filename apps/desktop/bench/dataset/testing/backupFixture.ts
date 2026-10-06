import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * M2-T3's committed audio backup (`test/fixtures/backup/`, made by its make-backup-fixture.mjs),
 * laid out as a userData folder: `roger.sqlite` plus the chunks its `audio_files` rows name. Each
 * stream has an m4a chunk at 0 to 2000 ms, a 1 s gap, then a WAV chunk at 3000 to 5000 ms; the mic
 * is a 440 Hz tone and call audio 660 Hz, at amplitude 8192.
 *
 * Open it read-only, or copy it first: the app's store would turn on WAL and rewrite the file.
 */
export const FIXTURE_DIR = fileURLToPath(
  new URL('../../../test/fixtures/backup/', import.meta.url),
);
export const FIXTURE_MEETING = '0b6f1c5e-3f7a-4c1e-9d2b-6a8e4f1d2c3b';
export const FIXTURE_AUDIO = join(FIXTURE_DIR, 'audio', FIXTURE_MEETING);
export const FIXTURE_TONE_HZ = { mic: 440, system: 660 } as const;

/** Sample `index` of a fixture WAV chunk's tone, as make-backup-fixture.mjs wrote it. */
export function fixtureToneSample(hz: number, index: number): number {
  // `|| 0`: Math.round gives -0 for a tiny negative, which Int16 stores as 0 and toEqual tells apart.
  return Math.round(Math.sin((2 * Math.PI * hz * index) / 16_000) * 8192) || 0;
}
