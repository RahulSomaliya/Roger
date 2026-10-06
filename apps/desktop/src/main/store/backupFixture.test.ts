import { copyFileSync, existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SqliteTranscriptStore } from './SqliteTranscriptStore';

/**
 * The committed audio-backup fixture (`test/fixtures/backup/`, made by its
 * `make-backup-fixture.mjs`). M2-T15's tests and M3-T12's `bench clip` read it as a userData
 * folder: `roger.sqlite` plus the files its `audio_files` rows name.
 */
const FIXTURE_DIR = fileURLToPath(new URL('../../../test/fixtures/backup/', import.meta.url));
const DATABASE = join(FIXTURE_DIR, 'roger.sqlite');
/** Named in make-backup-fixture.mjs; the readers use it. */
const MEETING_ID = '0b6f1c5e-3f7a-4c1e-9d2b-6a8e4f1d2c3b';
const BYTES_PER_MS = 32; // 16 kHz mono Int16

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface AudioRow {
  id: string;
  source: string;
  start_ms: number;
  end_ms: number;
  path: string;
  format: string;
  bytes: number;
  closed_at: string | null;
}

/** The rows exactly as M3-T12 reads them: read-only, not deleted, in start order. */
function readAudioRows(): AudioRow[] {
  const db = new DatabaseSync(DATABASE, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT id, source, start_ms, end_ms, path, format, bytes, closed_at FROM audio_files
         WHERE meeting_id = ? AND deleted_at IS NULL ORDER BY start_ms`,
      )
      .all(MEETING_ID)
      .map((row) => ({
        id: String(row.id),
        source: String(row.source),
        start_ms: Number(row.start_ms),
        end_ms: Number(row.end_ms),
        path: String(row.path),
        format: String(row.format),
        bytes: Number(row.bytes),
        closed_at: row.closed_at === null ? null : String(row.closed_at),
      }));
  } finally {
    db.close();
  }
}

describe('audio-backup fixture', () => {
  it('opens read-only with no WAL sidecar, at migration 4 or later', () => {
    const db = new DatabaseSync(DATABASE, { readOnly: true });
    try {
      // A WAL-mode file needs its -wal and -shm sidecars to open read-only; the fixture has none.
      expect(db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('delete');
      expect(Number(db.prepare('PRAGMA user_version').get()?.user_version)).toBeGreaterThanOrEqual(
        4,
      );
      expect(
        db
          .prepare('SELECT id FROM meetings')
          .all()
          .map((row) => row.id),
      ).toEqual([MEETING_ID]);
    } finally {
      db.close();
    }
    expect(existsSync(`${DATABASE}-wal`)).toBe(false);
  });

  it('gives each stream an m4a chunk, then a gap, then a WAV chunk', () => {
    const rows = readAudioRows();
    for (const source of ['mic', 'system']) {
      const chunks = rows.filter((row) => row.source === source);
      expect(chunks.map((row) => [row.format, row.start_ms, row.end_ms])).toEqual([
        ['m4a', 0, 2000],
        ['wav', 3000, 5000],
      ]);
    }
    for (const row of rows) {
      const file = join(FIXTURE_DIR, row.path);
      // `audio_files.id` is one key across every meeting: a reader copying this fixture must not
      // copy a per-meeting name as the id (see NewAudioFile.id).
      expect(row.id).toMatch(UUID_V4);
      expect(row.path).toMatch(new RegExp(`^audio/${MEETING_ID}/`));
      expect(row.closed_at).not.toBeNull();
      expect(statSync(file).size).toBe(row.bytes);
      const head = readFileSync(file).subarray(0, 44);
      if (row.format === 'm4a') {
        expect(head.toString('latin1', 4, 8)).toBe('ftyp');
        continue;
      }
      expect(head.toString('latin1', 0, 4)).toBe('RIFF');
      expect(head.toString('latin1', 8, 12)).toBe('WAVE');
      expect(head.readUInt16LE(20)).toBe(1); // PCM
      expect(head.readUInt16LE(22)).toBe(1); // mono
      expect(head.readUInt32LE(24)).toBe(16_000);
      expect(head.readUInt16LE(34)).toBe(16);
      expect(head.readUInt32LE(40)).toBe((row.end_ms - row.start_ms) * BYTES_PER_MS);
      expect(row.bytes).toBe(44 + (row.end_ms - row.start_ms) * BYTES_PER_MS);
    }
  });

  it('reads back through the store, with a gap still to re-run inside a WAV chunk', () => {
    // A copy: the store turns on WAL and would rewrite the committed file.
    const copy = join(mkdtempSync(join(tmpdir(), 'roger-fixture-')), 'roger.sqlite');
    copyFileSync(DATABASE, copy);
    const store = new SqliteTranscriptStore(copy);
    try {
      expect(store.getMeeting(MEETING_ID)?.endedAt).not.toBeNull();
      expect(store.listAudioFiles(MEETING_ID)).toHaveLength(4);
      expect(store.listUnrecoveredGaps(MEETING_ID)).toEqual([
        expect.objectContaining({ source: 'system', startMs: 3500, endMs: 4500 }),
      ]);
      expect(store.countSegments(MEETING_ID)).toBe(2);
    } finally {
      store.close();
    }
  });
});
