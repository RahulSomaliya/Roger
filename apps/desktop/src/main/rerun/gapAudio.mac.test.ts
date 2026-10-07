import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PCM_SAMPLE_RATE } from '../../shared/ipc';
import {
  copyBackupFixture,
  FIXTURE_MEETING_ID,
  type FixtureCopy,
} from '../backup/testing/backupFixture';
import { createLogger } from '../logger';
import { GapAudioReader } from './gapAudio';

/**
 * macOS only (`pnpm test:mac`): the real afconvert decodes the backup fixture's m4a, made by the
 * compressor's own command (test/fixtures/backup/make-backup-fixture.mjs). gapAudio.test.ts covers
 * the reader with a stand-in on any machine; this pins M4A_DECODE_ARGS against the real tool.
 */

const logger = createLogger({ level: 'error', format: 'json', sink: () => undefined });
/** The fixture's mic tone, and its m4a's span (0 to 2000 ms). */
const MIC_TONE_HZ = 440;
const M4A_MS = 2_000;

/** Upward zero crossings: one per cycle of a pure tone. */
function cycles(samples: Int16Array): number {
  let count = 0;
  for (let i = 1; i < samples.length; i += 1) {
    if ((samples[i - 1] ?? 0) < 0 && (samples[i] ?? 0) >= 0) count += 1;
  }
  return count;
}

describe('GapAudioReader on macOS', () => {
  let fixture: FixtureCopy;

  beforeEach(() => {
    fixture = copyBackupFixture();
  });

  afterEach(() => {
    fixture.remove();
  });

  it("decodes the backup's AAC back to 16 kHz PCM16 that still holds its tone", async () => {
    const reader = new GapAudioReader({ store: fixture.store, userData: fixture.userData, logger });
    const pieces = await reader.read(FIXTURE_MEETING_ID, 'mic', 0, M4A_MS);
    expect(pieces).toHaveLength(1);
    const pcm = pieces[0]?.pcm ?? new Uint8Array();
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
    // AAC's priming and padding may move the end by a frame (1024 samples at most), never more.
    expect(Math.abs(samples.length - (M4A_MS * PCM_SAMPLE_RATE) / 1_000)).toBeLessThanOrEqual(
      1_024,
    );
    // 440 Hz for 2 s, give or take the edges a lossy codec smears.
    expect(cycles(samples)).toBeGreaterThan(MIC_TONE_HZ * 2 * 0.95);
    expect(cycles(samples)).toBeLessThan(MIC_TONE_HZ * 2 * 1.05);
  });
});
