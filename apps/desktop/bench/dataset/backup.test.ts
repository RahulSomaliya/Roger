import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BACKUP_DATABASE,
  type BackupChunk,
  assertFileVaultOn,
  decodeBackupChunk,
  ensurePrivateBenchDir,
  readBackupMeeting,
} from './backup';
import {
  FIXTURE_AUDIO as AUDIO,
  FIXTURE_DIR,
  FIXTURE_MEETING,
  FIXTURE_TONE_HZ,
  fixtureToneSample,
} from './testing/backupFixture';

describe('readBackupMeeting', () => {
  let scratch = '';

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'roger-bench-backup-'));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  /** A writable copy of the fixture: the committed file is only ever opened read-only. */
  async function fixtureCopy(): Promise<string> {
    const userData = join(scratch, 'userData');
    await cp(FIXTURE_DIR, userData, { recursive: true });
    return userData;
  }

  it("reads the fixture's chunks in start order, with absolute paths, and leaves it untouched", async () => {
    const before = await readFile(join(FIXTURE_DIR, BACKUP_DATABASE));

    const meeting = readBackupMeeting(FIXTURE_DIR, FIXTURE_MEETING);

    expect(meeting.startedAt).toBe('2026-10-06T09:00:00.000Z');
    expect(meeting.chunks).toEqual<BackupChunk[]>([
      {
        source: 'mic',
        startMs: 0,
        endMs: 2000,
        format: 'm4a',
        path: join(AUDIO, 'mic-000000000.m4a'),
      },
      {
        source: 'system',
        startMs: 0,
        endMs: 2000,
        format: 'm4a',
        path: join(AUDIO, 'system-000000000.m4a'),
      },
      {
        source: 'mic',
        startMs: 3000,
        endMs: 5000,
        format: 'wav',
        path: join(AUDIO, 'mic-000003000.wav'),
      },
      {
        source: 'system',
        startMs: 3000,
        endMs: 5000,
        format: 'wav',
        path: join(AUDIO, 'system-000003000.wav'),
      },
    ]);
    // Read-only: no journal or WAL sidecar appears beside the committed file, and it is unchanged.
    expect((await readdir(FIXTURE_DIR)).filter((name) => name.startsWith('roger.sqlite'))).toEqual([
      'roger.sqlite',
    ]);
    expect(await readFile(join(FIXTURE_DIR, BACKUP_DATABASE))).toEqual(before);
  });

  it('skips rows with deleted_at, reading a WAL file the app is still writing', async () => {
    const userData = await fixtureCopy();
    // The app keeps roger.sqlite in WAL mode and writes while the bench reads. This change stays
    // in the -wal file (the writer is still open, nothing checkpoints it), so the reader must see
    // through the WAL to skip the row.
    const app = new DatabaseSync(join(userData, BACKUP_DATABASE));
    try {
      app.exec('PRAGMA journal_mode = WAL');
      app.exec('PRAGMA wal_autocheckpoint = 0');
      app
        .prepare(
          `UPDATE audio_files SET deleted_at = '2026-10-07T09:00:00.000Z'
           WHERE meeting_id = ? AND source = 'mic' AND start_ms = 3000`,
        )
        .run(FIXTURE_MEETING);

      const meeting = readBackupMeeting(userData, FIXTURE_MEETING);

      expect(meeting.chunks.map((chunk) => [chunk.source, chunk.startMs])).toEqual([
        ['mic', 0],
        ['system', 0],
        ['system', 3000],
      ]);
    } finally {
      app.close();
    }
  });

  it('names the path and --user-data when there is no database', () => {
    const missing = join(scratch, 'nowhere');

    expect(() => readBackupMeeting(missing, FIXTURE_MEETING)).toThrow(
      `no Roger database at ${join(missing, BACKUP_DATABASE)}; pass --user-data <folder>`,
    );
  });

  it('names a meeting that is not in the database', () => {
    expect(() => readBackupMeeting(FIXTURE_DIR, '11111111-2222-4333-8444-555555555555')).toThrow(
      `meeting 11111111-2222-4333-8444-555555555555 is not in ${join(FIXTURE_DIR, BACKUP_DATABASE)}`,
    );
  });

  it('refuses a stored path that leaves the audio folder', async () => {
    const userData = await fixtureCopy();
    const app = new DatabaseSync(join(userData, BACKUP_DATABASE));
    try {
      app
        .prepare(
          `UPDATE audio_files SET path = '../../etc/passwd' WHERE source = 'mic' AND start_ms = 0`,
        )
        .run();
    } finally {
      app.close();
    }

    expect(() => readBackupMeeting(userData, FIXTURE_MEETING)).toThrow(
      'audio_files row 2f6a8c1d-5e3b-4a7f-9c2d-8e1f0a3b4c5d: path must stay inside the audio folder',
    );
  });
});

describe('decodeBackupChunk', () => {
  it('reads a WAV chunk as captured, without afconvert', async () => {
    const samples = await decodeBackupChunk(
      {
        source: 'mic',
        startMs: 3000,
        endMs: 5000,
        format: 'wav',
        path: join(AUDIO, 'mic-000003000.wav'),
      },
      '/no/scratch/needed',
    );

    expect(samples).toHaveLength(32_000);
    expect(samples[4]).toBe(fixtureToneSample(FIXTURE_TONE_HZ.mic, 4));
  });
});

describe('assertFileVaultOn', () => {
  it('passes when fdesetup says FileVault is on', async () => {
    await expect(assertFileVaultOn(() => Promise.resolve('FileVault is On.\n'))).resolves.toBe(
      undefined,
    );
  });

  it('refuses when FileVault is off or only due after a restart', async () => {
    for (const status of [
      'FileVault is Off.\n',
      'FileVault is Off, but will be enabled after the next restart.\n',
      '',
    ]) {
      await expect(assertFileVaultOn(() => Promise.resolve(status))).rejects.toThrow(
        /FileVault is not on .*recordings of colleagues/,
      );
    }
  });

  it('refuses, with the reason, when fdesetup cannot run', async () => {
    await expect(
      assertFileVaultOn(() => Promise.reject(new Error('spawn /usr/bin/fdesetup ENOENT'))),
    ).rejects.toThrow(
      'could not read the FileVault status (/usr/bin/fdesetup status): spawn /usr/bin/fdesetup ENOENT',
    );
  });
});

describe('ensurePrivateBenchDir', () => {
  let scratch = '';

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'roger-bench-dir-'));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it('creates a missing bench folder, and its parents, with mode 0700', async () => {
    const dir = join(scratch, 'home', 'Roger-bench');

    await ensurePrivateBenchDir(dir);

    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(scratch, 'home'))).mode & 0o777).toBe(0o700);
  });

  it('keeps an existing 0700 folder and refuses one others can open', async () => {
    const dir = join(scratch, 'bench');
    await mkdir(dir, { mode: 0o700 });
    await ensurePrivateBenchDir(dir);

    const open = join(scratch, 'open');
    await mkdir(open, { mode: 0o755 });
    await expect(ensurePrivateBenchDir(open)).rejects.toThrow(
      `${open} is mode 0755; the bench folder holds recordings of colleagues, so only you may open it: chmod 700 '${open}'`,
    );
  });

  it('refuses a file where the folder should be', async () => {
    const file = join(scratch, 'bench');
    await writeFile(file, '');

    await expect(ensurePrivateBenchDir(file)).rejects.toThrow(`${file} is not a folder`);
  });
});
