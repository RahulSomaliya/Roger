import { DatabaseSync, type SQLOutputValue, type StatementSync } from 'node:sqlite';
import {
  isAudioSource,
  type TranscriptSegment,
  type TranscriptWord,
} from '../../shared/transcript';
import type {
  LocalMeeting,
  NewLocalMeeting,
  RemoteState,
  TranscriptStore,
} from './TranscriptStore';

/**
 * Ordered, forward-only migrations tracked with `PRAGMA user_version`.
 * Add a new entry for every schema change; never edit an applied one.
 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE meetings (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    remote_state TEXT NOT NULL DEFAULT 'pending'
      CHECK (remote_state IN ('pending', 'created', 'ended')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE segments (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    source TEXT NOT NULL CHECK (source IN ('mic', 'system')),
    speaker TEXT NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    text TEXT NOT NULL,
    confidence REAL,
    words_json TEXT,
    created_at TEXT NOT NULL,
    synced_at TEXT
  );
  CREATE INDEX segments_by_meeting ON segments (meeting_id, start_ms);
  CREATE INDEX segments_unsynced ON segments (meeting_id, start_ms) WHERE synced_at IS NULL;
  `,
];

type Row = Record<string, SQLOutputValue>;

export class SqliteTranscriptStore implements TranscriptStore {
  private readonly db: DatabaseSync;
  private readonly statements: {
    insertMeeting: StatementSync;
    getMeeting: StatementSync;
    endMeeting: StatementSync;
    setRemoteState: StatementSync;
    deleteEmptyMeeting: StatementSync;
    meetingsNeedingSync: StatementSync;
    insertSegment: StatementSync;
    unsyncedSegments: StatementSync;
    markSynced: StatementSync;
    countUnsynced: StatementSync;
    countSegments: StatementSync;
  };

  /** `path` may be `:memory:` for tests. */
  constructor(
    path: string,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
    this.statements = {
      insertMeeting: this.db.prepare(
        `INSERT OR IGNORE INTO meetings (id, title, started_at, ended_at, remote_state, created_at, updated_at)
         VALUES (?, ?, ?, NULL, 'pending', ?, ?)`,
      ),
      getMeeting: this.db.prepare(`SELECT * FROM meetings WHERE id = ?`),
      endMeeting: this.db.prepare(
        `UPDATE meetings SET ended_at = COALESCE(ended_at, ?), updated_at = ? WHERE id = ?`,
      ),
      setRemoteState: this.db.prepare(
        `UPDATE meetings SET remote_state = ?, updated_at = ? WHERE id = ?`,
      ),
      deleteEmptyMeeting: this.db.prepare(
        `DELETE FROM meetings WHERE id = ? AND NOT EXISTS (SELECT 1 FROM segments WHERE meeting_id = ?)`,
      ),
      meetingsNeedingSync: this.db.prepare(
        `SELECT * FROM meetings WHERE remote_state != 'ended' ORDER BY started_at ASC, id ASC`,
      ),
      insertSegment: this.db.prepare(
        `INSERT OR IGNORE INTO segments
           (id, meeting_id, source, speaker, start_ms, end_ms, text, confidence, words_json, created_at, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      ),
      unsyncedSegments: this.db.prepare(
        `SELECT * FROM segments WHERE meeting_id = ? AND synced_at IS NULL
         ORDER BY start_ms ASC, source ASC, id ASC LIMIT ?`,
      ),
      markSynced: this.db.prepare(
        `UPDATE segments SET synced_at = ? WHERE id = ? AND synced_at IS NULL`,
      ),
      countUnsynced: this.db.prepare(`SELECT COUNT(*) AS n FROM segments WHERE synced_at IS NULL`),
      countSegments: this.db.prepare(`SELECT COUNT(*) AS n FROM segments WHERE meeting_id = ?`),
    };
  }

  createMeeting(meeting: NewLocalMeeting): void {
    const now = this.now();
    this.statements.insertMeeting.run(meeting.id, meeting.title, meeting.startedAt, now, now);
  }

  getMeeting(id: string): LocalMeeting | null {
    const row = this.statements.getMeeting.get(id);
    return row ? rowToMeeting(row) : null;
  }

  markMeetingEnded(id: string, endedAt: string): void {
    this.statements.endMeeting.run(endedAt, this.now(), id);
  }

  setMeetingRemoteState(id: string, state: RemoteState): void {
    this.statements.setRemoteState.run(state, this.now(), id);
  }

  deleteMeetingIfEmpty(id: string): boolean {
    return this.statements.deleteEmptyMeeting.run(id, id).changes > 0;
  }

  listMeetingsNeedingSync(): LocalMeeting[] {
    return this.statements.meetingsNeedingSync.all().map(rowToMeeting);
  }

  appendSegment(segment: TranscriptSegment): void {
    this.statements.insertSegment.run(
      segment.id,
      segment.meetingId,
      segment.source,
      segment.speaker,
      segment.startMs,
      segment.endMs,
      segment.text,
      segment.confidence,
      segment.words === null ? null : JSON.stringify(segment.words),
      segment.createdAt,
    );
  }

  listUnsyncedSegments(meetingId: string, limit: number): TranscriptSegment[] {
    return this.statements.unsyncedSegments.all(meetingId, limit).map(rowToSegment);
  }

  markSegmentsSynced(ids: string[], syncedAt: string): void {
    if (ids.length === 0) return;
    this.transaction(() => {
      for (const id of ids) this.statements.markSynced.run(syncedAt, id);
    });
  }

  countUnsyncedSegments(): number {
    return Number(this.statements.countUnsynced.get()?.n ?? 0);
  }

  countSegments(meetingId: string): number {
    return Number(this.statements.countSegments.get(meetingId)?.n ?? 0);
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const current = Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    for (let version = current; version < MIGRATIONS.length; version += 1) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[version] ?? '');
        this.db.exec(`PRAGMA user_version = ${version + 1}`);
      });
    }
  }

  private transaction(work: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      work();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private now(): string {
    return this.clock().toISOString();
  }
}

function rowToMeeting(row: Row): LocalMeeting {
  return {
    id: text(row, 'id'),
    title: text(row, 'title'),
    startedAt: text(row, 'started_at'),
    endedAt: row.ended_at === null || row.ended_at === undefined ? null : text(row, 'ended_at'),
    remoteState: remoteState(row.remote_state),
  };
}

function rowToSegment(row: Row): TranscriptSegment {
  const source = row.source;
  if (!isAudioSource(source)) throw new Error(`corrupt segment row: source=${String(source)}`);
  const speaker = text(row, 'speaker');
  if (speaker !== 'me' && speaker !== 'them')
    throw new Error(`corrupt segment row: speaker=${speaker}`);
  return {
    id: text(row, 'id'),
    meetingId: text(row, 'meeting_id'),
    source,
    speaker,
    startMs: Number(row.start_ms),
    endMs: Number(row.end_ms),
    text: text(row, 'text'),
    confidence:
      row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    words: parseWords(row.words_json),
    createdAt: text(row, 'created_at'),
  };
}

function parseWords(value: SQLOutputValue | undefined): TranscriptWord[] | null {
  if (typeof value !== 'string') return null;
  // Written by appendSegment from a typed TranscriptWord[]; the cast restores that type.
  return JSON.parse(value) as TranscriptWord[];
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`corrupt row: ${key} is ${typeof value}`);
  return value;
}

function remoteState(value: SQLOutputValue | undefined): RemoteState {
  if (value === 'pending' || value === 'created' || value === 'ended') return value;
  throw new Error(`corrupt meeting row: remote_state=${String(value)}`);
}
