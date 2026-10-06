import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readWav } from '../core/wav';
import { decodeBackupChunk, readFileVaultStatus } from './backup';
import { clip } from './clip';
import {
  FIXTURE_DIR,
  FIXTURE_MEETING,
  FIXTURE_TONE_HZ,
  fixtureToneSample,
} from './testing/backupFixture';

/**
 * macOS only (`pnpm test:mac`): the real afconvert decode of the fixture's AAC chunks, and the
 * real fdesetup. clip.test.ts covers the layout with a fake decoder on any machine.
 */
describe('clip on macOS', () => {
  let scratch = '';

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'roger-bench-clip-mac-'));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it('decodes the m4a chunks in place, so AAC priming never shifts the audio', async () => {
    const benchDir = join(scratch, 'Roger-bench');
    const item = await clip(
      {
        benchDir,
        userDataDir: FIXTURE_DIR,
        meetingId: FIXTURE_MEETING,
        fromMs: 0,
        toMs: 5000,
        itemId: 'tone-mac',
        participants: [],
        kind: 'other',
        setup: 'unknown',
      },
      // FileVault is checked by the next test; a developer Mac without it must still run this one.
      { assertFileVault: () => Promise.resolve(), decode: decodeBackupChunk },
    );

    expect(item.gaps).toEqual([
      { source: 'mic', startMs: 2000, endMs: 3000 },
      { source: 'system', startMs: 2000, endMs: 3000 },
    ]);
    for (const source of ['mic', 'system'] as const) {
      const hz = FIXTURE_TONE_HZ[source];
      const samples = await readWav(join(benchDir, 'items', 'tone-mac', `${source}.wav`));
      expect(samples).toHaveLength(5 * 16_000);
      // 0 to 2000 ms, decoded from AAC: lossy, so compared by correlation with the tone that was
      // encoded. Priming left in would shift it by 2112 samples and the correlation would collapse.
      const aac = samples.subarray(0, 32_000);
      let dot = 0;
      let aacEnergy = 0;
      let toneEnergy = 0;
      aac.forEach((sample, index) => {
        const tone = fixtureToneSample(hz, index);
        dot += sample * tone;
        aacEnergy += sample * sample;
        toneEnergy += tone * tone;
      });
      expect(dot / Math.sqrt(aacEnergy * toneEnergy), source).toBeGreaterThan(0.95);
      expect(samples.subarray(32_000, 48_000).every((sample) => sample === 0)).toBe(true);
      const wavPart = Array.from(samples.subarray(48_000));
      expect(wavPart).toEqual(wavPart.map((_, index) => fixtureToneSample(hz, index)));
    }
  });

  it('reads the FileVault status without admin rights', async () => {
    expect(await readFileVaultStatus()).toMatch(/^FileVault is (On|Off)/);
  });
});
