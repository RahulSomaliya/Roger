import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readWav } from '../core/wav';
import { BACKUP_DATABASE, type BackupChunk, type DecodeChunk, decodeBackupChunk } from './backup';
import { type ClipOptions, clip, parseClockTime, parseParticipant } from './clip';
import { readItem } from './item';
import {
  FIXTURE_DIR,
  FIXTURE_MEETING,
  FIXTURE_TONE_HZ,
  fixtureToneSample,
} from './testing/backupFixture';

/** What the fake decoder fills an m4a chunk with, per stream, so its samples can be told apart. */
const M4A_MARK = { mic: 1111, system: 2222 } as const;

/**
 * Runs `scenario` with the process in `timeZone`, proving the switch took effect (the repo's rule:
 * a TZ switch that did nothing passes in silence). recorded_on is the local day of the fixture's
 * started_at (09:00Z), so any expected date depends on the zone.
 */
async function inTimeZone<T>(
  timeZone: string,
  octoberOffsetMinutes: number,
  scenario: () => Promise<T>,
): Promise<T> {
  const previous = process.env.TZ;
  process.env.TZ = timeZone;
  try {
    expect(new Date(Date.UTC(2026, 9, 6)).getTimezoneOffset()).toBe(octoberOffsetMinutes);
    return await scenario();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

describe('clip', () => {
  let scratch = '';
  let benchDir = '';
  let scratchDirs: string[] = [];

  /**
   * The real reader for the WAV chunks, and a marked constant for the m4a ones: afconvert is macOS
   * only and its AAC output is lossy, so exact sample checks use this; clip.mac.test.ts runs the
   * real decode.
   */
  const decode: DecodeChunk = async (chunk, scratchDir) => {
    scratchDirs.push(scratchDir);
    expect(existsSync(scratchDir)).toBe(true);
    if (chunk.format === 'wav') return decodeBackupChunk(chunk, scratchDir);
    return new Int16Array(((chunk.endMs ?? chunk.startMs) - chunk.startMs) * 16).fill(
      M4A_MARK[chunk.source],
    );
  };
  const fileVaultOn = (): Promise<void> => Promise.resolve();

  function options(change: Partial<ClipOptions> = {}): ClipOptions {
    return {
      benchDir,
      userDataDir: FIXTURE_DIR,
      meetingId: FIXTURE_MEETING,
      fromMs: 1000,
      toMs: 4000,
      itemId: 'tone-1',
      participants: [{ name: 'Ana Lopez', consentOn: '2026-10-05' }],
      kind: 'standup',
      setup: 'headphones',
      ...change,
    };
  }

  async function fixtureCopy(sql: string): Promise<string> {
    const userData = join(scratch, 'userData');
    await cp(FIXTURE_DIR, userData, { recursive: true });
    const db = new DatabaseSync(join(userData, BACKUP_DATABASE));
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
    return userData;
  }

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'roger-bench-clip-'));
    benchDir = join(scratch, 'Roger-bench');
    scratchDirs = [];
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it('cuts exact sample windows from both streams and fills the gap with silence', async () => {
    const item = await inTimeZone('Europe/London', -60, () =>
      clip(options(), { assertFileVault: fileVaultOn, decode }),
    );

    for (const source of ['mic', 'system'] as const) {
      const samples = await readWav(join(benchDir, 'items', 'tone-1', `${source}.wav`));
      expect(samples).toHaveLength(3 * 16_000);
      // 1000 to 2000 ms: the second half of the m4a chunk.
      expect(samples.subarray(0, 16_000).every((sample) => sample === M4A_MARK[source])).toBe(true);
      // 2000 to 3000 ms: no chunk, so silence.
      expect(samples.subarray(16_000, 32_000).every((sample) => sample === 0)).toBe(true);
      // 3000 to 4000 ms: the first 16,000 samples of the WAV chunk, exactly.
      const wavPart = Array.from(samples.subarray(32_000));
      expect(wavPart).toEqual(
        wavPart.map((_, index) => fixtureToneSample(FIXTURE_TONE_HZ[source], index)),
      );
    }
    expect(item).toEqual({
      schemaVersion: 1,
      id: 'tone-1',
      origin: 'backup',
      meetingId: FIXTURE_MEETING,
      window: { fromMs: 1000, toMs: 4000 },
      recordedOn: '2026-10-06',
      kind: 'standup',
      setup: 'headphones',
      streams: ['mic', 'system'],
      gaps: [
        { source: 'mic', startMs: 1000, endMs: 2000 },
        { source: 'system', startMs: 1000, endMs: 2000 },
      ],
      participants: [{ name: 'Ana Lopez', consentOn: '2026-10-05' }],
      draftRuns: [],
    });
    expect(await readItem(benchDir, 'tone-1')).toEqual(item);
  });

  it("records the meeting's local day, not its UTC day", async () => {
    // 09:00Z on 2026-10-06 is 23:00 on 2026-10-05 in Honolulu (UTC-10, no daylight saving).
    const item = await inTimeZone('Pacific/Honolulu', 600, () =>
      clip(options(), { assertFileVault: fileVaultOn, decode }),
    );

    expect(item.recordedOn).toBe('2026-10-05');
  });

  it('skips backup rows marked deleted, leaving their audio out as a gap', async () => {
    const userData = await fixtureCopy(
      `UPDATE audio_files SET deleted_at = '2026-10-07T00:00:00.000Z'
       WHERE source = 'system' AND start_ms = 0`,
    );

    const item = await clip(options({ userDataDir: userData }), {
      assertFileVault: fileVaultOn,
      decode,
    });

    const system = await readWav(join(benchDir, 'items', 'tone-1', 'system.wav'));
    expect(system.subarray(0, 32_000).every((sample) => sample === 0)).toBe(true);
    expect(system[32_000 + 4]).toBe(fixtureToneSample(FIXTURE_TONE_HZ.system, 4));
    expect(item.gaps).toEqual([
      { source: 'mic', startMs: 1000, endMs: 2000 },
      { source: 'system', startMs: 0, endMs: 2000 },
    ]);
  });

  it('writes listen.wav as stereo, mic left and system right', async () => {
    await clip(options(), { assertFileVault: fileVaultOn, decode });

    const listen = await readFile(join(benchDir, 'items', 'tone-1', 'listen.wav'));
    expect(listen.readUInt16LE(22)).toBe(2); // channels
    expect(listen.readUInt32LE(24)).toBe(16_000);
    const frames = listen.readUInt32LE(40) / 4;
    expect(frames).toBe(3 * 16_000);
    const left = (frame: number): number => listen.readInt16LE(44 + frame * 4);
    const right = (frame: number): number => listen.readInt16LE(44 + frame * 4 + 2);
    expect([left(10), right(10)]).toEqual([M4A_MARK.mic, M4A_MARK.system]);
    expect([left(32_005), right(32_005)]).toEqual([
      fixtureToneSample(FIXTURE_TONE_HZ.mic, 5),
      fixtureToneSample(FIXTURE_TONE_HZ.system, 5),
    ]);
  });

  it('creates the bench folder 0700 and every file in the item 0600', async () => {
    await clip(options(), { assertFileVault: fileVaultOn, decode });

    expect((await stat(benchDir)).mode & 0o777).toBe(0o700);
    const itemDir = join(benchDir, 'items', 'tone-1');
    expect((await stat(itemDir)).mode & 0o777).toBe(0o700);
    const files = (await readdir(itemDir)).sort();
    expect(files).toEqual(['item.json', 'listen.wav', 'mic.wav', 'system.wav']);
    for (const file of files) {
      expect((await stat(join(itemDir, file))).mode & 0o777, file).toBe(0o600);
    }
  });

  it('decodes inside the item folder and removes the decoded files afterwards', async () => {
    await clip(options(), { assertFileVault: fileVaultOn, decode });

    expect(scratchDirs.length).toBeGreaterThan(0);
    for (const dir of scratchDirs) {
      expect(dir.startsWith(join(benchDir, 'items', 'tone-1'))).toBe(true);
      expect(existsSync(dir)).toBe(false);
    }
  });

  it('refuses when FileVault is off, before writing anything', async () => {
    await expect(
      clip(options(), {
        assertFileVault: () => Promise.reject(new Error('FileVault is not on')),
        decode,
      }),
    ).rejects.toThrow('FileVault is not on');

    expect(existsSync(benchDir)).toBe(false);
  });

  it('names the database path and --user-data when there is no database', async () => {
    const missing = join(scratch, 'no-user-data');

    await expect(
      clip(options({ userDataDir: missing }), { assertFileVault: fileVaultOn, decode }),
    ).rejects.toThrow(`no Roger database at ${join(missing, BACKUP_DATABASE)}; pass --user-data`);
    expect(existsSync(benchDir)).toBe(false);
  });

  it('leaves out a stream with no audio in the window', async () => {
    const userData = await fixtureCopy(
      `UPDATE audio_files SET deleted_at = '2026-10-07T00:00:00.000Z' WHERE source = 'mic'`,
    );

    const item = await clip(options({ userDataDir: userData }), {
      assertFileVault: fileVaultOn,
      decode,
    });

    expect(item.streams).toEqual(['system']);
    expect(item.gaps).toEqual([{ source: 'system', startMs: 1000, endMs: 2000 }]);
    expect(existsSync(join(benchDir, 'items', 'tone-1', 'mic.wav'))).toBe(false);
    const listen = await readFile(join(benchDir, 'items', 'tone-1', 'listen.wav'));
    expect([listen.readInt16LE(44 + 10 * 4), listen.readInt16LE(44 + 10 * 4 + 2)]).toEqual([
      0,
      M4A_MARK.system,
    ]);
  });

  it('reports a meeting whose backup audio is gone', async () => {
    const userData = await fixtureCopy(
      `UPDATE audio_files SET deleted_at = '2026-10-13T00:00:00.000Z'`,
    );

    await expect(
      clip(options({ userDataDir: userData }), { assertFileVault: fileVaultOn, decode }),
    ).rejects.toThrow(`meeting ${FIXTURE_MEETING} has no audio left in the backup`);
  });

  it('refuses a window past the end of the backup audio, or ending before it starts', async () => {
    await expect(
      clip(options({ fromMs: 3000, toMs: 6000 }), { assertFileVault: fileVaultOn, decode }),
    ).rejects.toThrow(
      `the backup of meeting ${FIXTURE_MEETING} ends at 00:05; --to 00:06 is past it`,
    );
    await expect(
      clip(options({ fromMs: 4000, toMs: 4000 }), { assertFileVault: fileVaultOn, decode }),
    ).rejects.toThrow('--to (00:04) must be after --from (00:04)');
  });

  it('refuses an item that exists, leaving it as it was', async () => {
    const itemDir = join(benchDir, 'items', 'tone-1');
    await mkdir(itemDir, { recursive: true, mode: 0o700 });
    await writeFile(join(itemDir, 'item.json'), 'hand-fixed');

    await expect(clip(options(), { assertFileVault: fileVaultOn, decode })).rejects.toThrow(
      `item tone-1 already exists at ${itemDir}`,
    );
    expect(await readFile(join(itemDir, 'item.json'), 'utf8')).toBe('hand-fixed');
  });

  it('refuses a folder a killed clip left, so no stale stream sits beside the new one', async () => {
    const itemDir = join(benchDir, 'items', 'tone-1');
    await mkdir(itemDir, { recursive: true, mode: 0o700 });
    await writeFile(join(itemDir, 'mic.wav'), 'from another window');

    await expect(clip(options(), { assertFileVault: fileVaultOn, decode })).rejects.toThrow(
      `${itemDir} holds a clip that did not finish (no item.json); delete the folder and clip again`,
    );
    expect(await readFile(join(itemDir, 'mic.wav'), 'utf8')).toBe('from another window');
  });

  it('removes the item folder it created when a decode fails', async () => {
    const failing: DecodeChunk = (chunk: BackupChunk) =>
      Promise.reject(new Error(`afconvert failed on ${chunk.path}`));

    await expect(
      clip(options(), { assertFileVault: fileVaultOn, decode: failing }),
    ).rejects.toThrow('afconvert failed on');
    expect(existsSync(join(benchDir, 'items', 'tone-1'))).toBe(false);
  });
});

describe('clip arguments', () => {
  it('reads mm:ss times', () => {
    expect(parseClockTime('12:30', '--from')).toBe(750_000);
    expect(parseClockTime('0:05', '--to')).toBe(5000);
    expect(parseClockTime('125:00', '--to')).toBe(7_500_000);
    for (const bad of ['12', '12:60', '1:2', '-1:00', '12:30.5', '']) {
      expect(() => parseClockTime(bad, '--from')).toThrow(
        `--from must be minutes and seconds, mm:ss, such as 12:30; got ${JSON.stringify(bad)}`,
      );
    }
  });

  it('reads a participant and their consent date, splitting at the last colon', () => {
    expect(parseParticipant('Ana Lopez:2026-10-05')).toEqual({
      name: 'Ana Lopez',
      consentOn: '2026-10-05',
    });
    expect(parseParticipant(' Dr: Who :2026-10-05')).toEqual({
      name: 'Dr: Who',
      consentOn: '2026-10-05',
    });
    for (const bad of ['Ana Lopez', ':2026-10-05', 'Ana:2026-13-01', 'Ana:yesterday']) {
      expect(() => parseParticipant(bad)).toThrow(
        '--person must be <name>:<consent date>, such as "Ana Lopez:2026-10-05"',
      );
    }
  });
});
