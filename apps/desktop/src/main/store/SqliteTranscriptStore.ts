import { DatabaseSync, type SQLOutputValue, type StatementSync } from 'node:sqlite';
import {
  isAudioSource,
  type AudioSource,
  type TranscriptSegment,
  type TranscriptWord,
} from '../../shared/transcript';
import type { SttUsage } from '../stt/usage';
import { canonicalInstant, checkAudioPath, checkGapWindow, checkTrim } from './storeChecks';
import type {
  AppStateEntry,
  AudioFile,
  AudioFileFormat,
  CaptureEvent,
  GapReason,
  JsonObject,
  LocalMeeting,
  MeetingStopReason,
  MeetingSttUsage,
  NewAudioFile,
  NewCaptureEvent,
  NewLocalMeeting,
  NewTranscriptGap,
  RemoteState,
  SegmentOrigin,
  SegmentTrim,
  StoredSegment,
  SuppressedReason,
  TranscriptGap,
  TranscriptStore,
} from './TranscriptStore';

/**
 * Ordered, forward-only migrations tracked with `PRAGMA user_version`.
 * Add a new entry for every schema change; never edit an applied one.
 *
 * Each upgrade test winds a file back to the schema before its migration, and `migrate()` then
 * re-runs every entry above `user_version`. So a wind-back must also undo every later migration,
 * or an `ALTER TABLE ... ADD COLUMN` runs twice and fails with "duplicate column name". With a new
 * migration, add its wind-back to the test file, call it first in the one before (as
 * `windBackToSchema3` must then call `windBackToSchema4`), and raise the `user_version` the
 * upgrade tests expect.
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
  `
  ALTER TABLE segments ADD COLUMN rejected_at TEXT;
  ALTER TABLE segments ADD COLUMN rejected_reason TEXT;
  CREATE INDEX segments_rejected ON segments (rejected_at) WHERE rejected_at IS NOT NULL;
  `,
  // Speech-to-text usage per meeting (cost guard G7). No foreign key on purpose: a meeting
  // deleted for having no lines still had billed sessions, and this row keeps them.
  `
  CREATE TABLE stt_usage (
    meeting_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    sessions_opened INTEGER NOT NULL,
    connected_ms INTEGER NOT NULL,
    audio_sent_ms INTEGER NOT NULL,
    dropped_chunks INTEGER NOT NULL,
    estimated_cost_usd REAL,
    by_source_json TEXT NOT NULL,
    stop_reason TEXT,
    updated_at TEXT NOT NULL
  );
  `,
  // M2 (capture you can trust): echo state, holds and origin on lines, why a meeting stopped,
  // gaps to re-run, the audio backup, capture events and device state. stt_usage is untouched.
  // `workspace_id` is NULL until M6 sign-in gives the Mac a workspace (M2 D9).
  `
  ALTER TABLE segments ADD COLUMN suppressed_reason TEXT CHECK (suppressed_reason IN ('echo'));
  ALTER TABLE segments ADD COLUMN echo_of TEXT;
  ALTER TABLE segments ADD COLUMN original_text TEXT;
  ALTER TABLE segments ADD COLUMN original_words_json TEXT;
  ALTER TABLE segments ADD COLUMN upload_after TEXT;
  ALTER TABLE segments ADD COLUMN origin TEXT NOT NULL DEFAULT 'live'
    CHECK (origin IN ('live', 'rerun'));
  CREATE INDEX segments_held ON segments (meeting_id, start_ms)
    WHERE upload_after IS NOT NULL AND synced_at IS NULL;
  ALTER TABLE meetings ADD COLUMN stop_reason TEXT;
  CREATE TABLE transcript_gaps (
    id TEXT PRIMARY KEY,
    workspace_id TEXT,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    source TEXT NOT NULL CHECK (source IN ('mic', 'system')),
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL,
    recovered_at TEXT,
    recover_error TEXT,
    CHECK (end_ms > start_ms)
  );
  CREATE INDEX transcript_gaps_by_meeting ON transcript_gaps (meeting_id, start_ms);
  CREATE INDEX transcript_gaps_unrecovered ON transcript_gaps (created_at)
    WHERE recovered_at IS NULL;
  CREATE TABLE audio_files (
    id TEXT PRIMARY KEY,
    workspace_id TEXT,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    source TEXT NOT NULL CHECK (source IN ('mic', 'system')),
    start_ms INTEGER NOT NULL,
    end_ms INTEGER CHECK (end_ms IS NULL OR end_ms >= start_ms),
    path TEXT NOT NULL,
    format TEXT NOT NULL CHECK (format IN ('wav', 'm4a')),
    bytes INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    closed_at TEXT,
    deleted_at TEXT
  );
  CREATE INDEX audio_files_by_meeting ON audio_files (meeting_id, start_ms);
  CREATE INDEX audio_files_kept ON audio_files (meeting_id) WHERE deleted_at IS NULL;
  CREATE TABLE capture_events (
    id INTEGER PRIMARY KEY,
    workspace_id TEXT,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    offset_ms INTEGER NOT NULL,
    source TEXT CHECK (source IN ('mic', 'system')),
    kind TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX capture_events_by_meeting ON capture_events (meeting_id, id);
  CREATE TABLE app_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
];

/**
 * A line can upload when it is not uploaded, not rejected, not hidden and not held: `upload_after`
 * unset or past `:now`. The list and the count share it, or "N lines waiting" never reaches zero
 * while a line is hidden; so does `meetingsNeedingSync`, or a meeting ended remotely comes back for
 * a line the uploader then finds nothing to send for (or never comes back for one it would). The
 * compare is on text, which is right only because `holdSegment` writes every instant in
 * `toISOString` form (storeChecks.canonicalInstant). `canUpload` in InMemoryTranscriptStore is its
 * twin: change both.
 */
const CAN_UPLOAD = `synced_at IS NULL AND rejected_at IS NULL AND suppressed_reason IS NULL
  AND (upload_after IS NULL OR upload_after <= :now)`;

/**
 * Held: waiting on the echo sink. The same lines `listHeldSegments` settles at startup and
 * `countHeldSegments` counts for the uploader's end rule. `isHeld` in InMemoryTranscriptStore is
 * its twin: change both.
 */
const HELD = `upload_after IS NOT NULL AND synced_at IS NULL AND rejected_at IS NULL
  AND suppressed_reason IS NULL`;

type Row = Record<string, SQLOutputValue>;

export class SqliteTranscriptStore implements TranscriptStore {
  private readonly db: DatabaseSync;
  /** Lines the uploader is sending (markSegmentsSent); in memory on purpose, see there. */
  private readonly sent = new Set<string>();
  private readonly statements: {
    insertMeeting: StatementSync;
    getMeeting: StatementSync;
    endMeeting: StatementSync;
    setRemoteState: StatementSync;
    deleteEmptyMeeting: StatementSync;
    endLeftOpen: StatementSync;
    openMeetings: StatementSync;
    setStopReason: StatementSync;
    getStopReason: StatementSync;
    resetSync: StatementSync;
    meetingsNeedingSync: StatementSync;
    insertSegment: StatementSync;
    unsyncedSegments: StatementSync;
    markSynced: StatementSync;
    markRejected: StatementSync;
    countUnsynced: StatementSync;
    countRejected: StatementSync;
    countSegments: StatementSync;
    getSegment: StatementSync;
    segmentsOverlapping: StatementSync;
    suppress: StatementSync;
    trim: StatementSync;
    unhide: StatementSync;
    hold: StatementSync;
    release: StatementSync;
    heldSegments: StatementSync;
    heldSegmentsOfMeeting: StatementSync;
    countHeld: StatementSync;
    saveSttUsage: StatementSync;
    getSttUsage: StatementSync;
    insertGap: StatementSync;
    gaps: StatementSync;
    unrecoveredGaps: StatementSync;
    unrecoveredGapsOfMeeting: StatementSync;
    gapRecovered: StatementSync;
    gapRecoverError: StatementSync;
    insertAudioFile: StatementSync;
    audioFileMeeting: StatementSync;
    closeAudioFile: StatementSync;
    encodeAudioFile: StatementSync;
    audioFiles: StatementSync;
    openAudioFiles: StatementSync;
    meetingIdsWithAudio: StatementSync;
    deleteMeetingAudio: StatementSync;
    insertCaptureEvent: StatementSync;
    captureEvents: StatementSync;
    getAppState: StatementSync;
    setAppState: StatementSync;
    deleteAppState: StatementSync;
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
    // A second process (or a stuck WAL checkpoint) must not throw SQLITE_BUSY at a live transcript.
    this.db.exec('PRAGMA busy_timeout = 5000');
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
      // The audio check guards the cascade; no gap check on purpose: see
      // TranscriptStore.deleteMeetingIfEmpty.
      deleteEmptyMeeting: this.db.prepare(
        `DELETE FROM meetings WHERE id = :id
           AND NOT EXISTS (SELECT 1 FROM segments WHERE meeting_id = :id)
           AND NOT EXISTS (SELECT 1 FROM audio_files WHERE meeting_id = :id AND deleted_at IS NULL)`,
      ),
      endLeftOpen: this.db.prepare(
        `UPDATE meetings
         SET ended_at = COALESCE((SELECT MAX(created_at) FROM segments WHERE meeting_id = meetings.id), started_at),
             stop_reason = COALESCE(stop_reason, 'crash'),
             updated_at = :updatedAt
         WHERE ended_at IS NULL AND id IS NOT :keepOpenId`,
      ),
      openMeetings: this.db.prepare(
        `SELECT * FROM meetings WHERE ended_at IS NULL ORDER BY started_at ASC, id ASC`,
      ),
      setStopReason: this.db.prepare(
        `UPDATE meetings SET stop_reason = ?, updated_at = ? WHERE id = ?`,
      ),
      getStopReason: this.db.prepare(`SELECT stop_reason FROM meetings WHERE id = ?`),
      resetSync: this.db.prepare(
        `UPDATE segments SET synced_at = NULL WHERE meeting_id = ? AND rejected_at IS NULL`,
      ),
      // A meeting ended remotely comes back while it has a line that can upload; the uploader then
      // re-sends its end (TranscriptStore.listMeetingsNeedingSync). The subquery is correlated on
      // purpose: CAN_UPLOAD's columns are the segment's, and `meetings` has none of them.
      meetingsNeedingSync: this.db.prepare(
        `SELECT * FROM meetings
         WHERE remote_state != 'ended'
            OR EXISTS (SELECT 1 FROM segments WHERE segments.meeting_id = meetings.id AND ${CAN_UPLOAD})
         ORDER BY started_at ASC, id ASC`,
      ),
      insertSegment: this.db.prepare(
        `INSERT OR IGNORE INTO segments
           (id, meeting_id, source, speaker, start_ms, end_ms, text, confidence, words_json, created_at, synced_at, origin)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      ),
      unsyncedSegments: this.db.prepare(
        `SELECT * FROM segments WHERE meeting_id = :meetingId AND ${CAN_UPLOAD}
         ORDER BY start_ms ASC, source ASC, id ASC LIMIT :limit`,
      ),
      markSynced: this.db.prepare(
        `UPDATE segments SET synced_at = ? WHERE id = ? AND synced_at IS NULL`,
      ),
      markRejected: this.db.prepare(
        `UPDATE segments SET rejected_at = ?, rejected_reason = ? WHERE id = ? AND synced_at IS NULL`,
      ),
      countUnsynced: this.db.prepare(`SELECT COUNT(*) AS n FROM segments WHERE ${CAN_UPLOAD}`),
      countRejected: this.db.prepare(
        `SELECT COUNT(*) AS n FROM segments WHERE rejected_at IS NOT NULL`,
      ),
      countSegments: this.db.prepare(`SELECT COUNT(*) AS n FROM segments WHERE meeting_id = ?`),
      getSegment: this.db.prepare(`SELECT * FROM segments WHERE id = ?`),
      segmentsOverlapping: this.db.prepare(
        `SELECT * FROM segments
         WHERE meeting_id = :meetingId AND source = :source AND start_ms <= :toMs AND end_ms >= :fromMs
         ORDER BY start_ms ASC, id ASC`,
      ),
      // Echo writes touch only lines not marked uploaded: Postgres keeps what it was sent.
      // `synced_at IS NULL` cannot see a request still out: the methods refuse a sent line first
      // (TranscriptStore.markSegmentsSent).
      suppress: this.db.prepare(
        `UPDATE segments SET suppressed_reason = ?, echo_of = ?, upload_after = NULL
         WHERE id = ? AND synced_at IS NULL`,
      ),
      // The right-hand sides read the row as it was, so the first trim's text is the one kept.
      trim: this.db.prepare(
        `UPDATE segments
         SET original_text = COALESCE(original_text, text),
             original_words_json = CASE WHEN original_text IS NULL THEN words_json ELSE original_words_json END,
             text = ?, words_json = ?, echo_of = ?
         WHERE id = ? AND synced_at IS NULL`,
      ),
      unhide: this.db.prepare(
        `UPDATE segments SET suppressed_reason = NULL, echo_of = NULL
         WHERE id = ? AND suppressed_reason IS NOT NULL`,
      ),
      hold: this.db.prepare(
        `UPDATE segments SET upload_after = ? WHERE id = ? AND synced_at IS NULL`,
      ),
      release: this.db.prepare(`UPDATE segments SET upload_after = NULL WHERE id = ?`),
      heldSegments: this.db.prepare(
        `SELECT * FROM segments WHERE ${HELD} ORDER BY meeting_id ASC, start_ms ASC, source ASC, id ASC`,
      ),
      heldSegmentsOfMeeting: this.db.prepare(
        `SELECT * FROM segments WHERE meeting_id = ? AND ${HELD}
         ORDER BY start_ms ASC, source ASC, id ASC`,
      ),
      countHeld: this.db.prepare(
        `SELECT COUNT(*) AS n FROM segments WHERE meeting_id = ? AND ${HELD}`,
      ),
      saveSttUsage: this.db.prepare(
        `INSERT INTO stt_usage
           (meeting_id, provider, sessions_opened, connected_ms, audio_sent_ms, dropped_chunks,
            estimated_cost_usd, by_source_json, stop_reason, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (meeting_id) DO UPDATE SET
           provider = excluded.provider,
           sessions_opened = excluded.sessions_opened,
           connected_ms = excluded.connected_ms,
           audio_sent_ms = excluded.audio_sent_ms,
           dropped_chunks = excluded.dropped_chunks,
           estimated_cost_usd = excluded.estimated_cost_usd,
           by_source_json = excluded.by_source_json,
           stop_reason = excluded.stop_reason,
           updated_at = excluded.updated_at`,
      ),
      getSttUsage: this.db.prepare(`SELECT * FROM stt_usage WHERE meeting_id = ?`),
      insertGap: this.db.prepare(
        `INSERT OR IGNORE INTO transcript_gaps
           (id, meeting_id, source, start_ms, end_ms, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ),
      gaps: this.db.prepare(
        `SELECT * FROM transcript_gaps WHERE meeting_id = ? ORDER BY start_ms ASC, source ASC, id ASC`,
      ),
      unrecoveredGaps: this.db.prepare(
        `SELECT * FROM transcript_gaps WHERE recovered_at IS NULL
         ORDER BY created_at ASC, start_ms ASC, id ASC`,
      ),
      unrecoveredGapsOfMeeting: this.db.prepare(
        `SELECT * FROM transcript_gaps WHERE meeting_id = ? AND recovered_at IS NULL
         ORDER BY created_at ASC, start_ms ASC, id ASC`,
      ),
      gapRecovered: this.db.prepare(
        `UPDATE transcript_gaps SET recovered_at = ?, recover_error = NULL WHERE id = ?`,
      ),
      gapRecoverError: this.db.prepare(
        `UPDATE transcript_gaps SET recover_error = ? WHERE id = ? AND recovered_at IS NULL`,
      ),
      // Not OR IGNORE: only an id clash may be skipped, and addAudioFile checks whose id it was.
      insertAudioFile: this.db.prepare(
        `INSERT INTO audio_files
           (id, meeting_id, source, start_ms, path, format, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
      ),
      audioFileMeeting: this.db.prepare(`SELECT meeting_id FROM audio_files WHERE id = ?`),
      closeAudioFile: this.db.prepare(
        `UPDATE audio_files SET end_ms = ?, bytes = ?, closed_at = ? WHERE id = ?`,
      ),
      encodeAudioFile: this.db.prepare(
        `UPDATE audio_files SET path = ?, format = ?, bytes = ? WHERE id = ?`,
      ),
      audioFiles: this.db.prepare(
        `SELECT * FROM audio_files WHERE meeting_id = ? AND deleted_at IS NULL
         ORDER BY start_ms ASC, source ASC, id ASC`,
      ),
      openAudioFiles: this.db.prepare(
        `SELECT * FROM audio_files WHERE closed_at IS NULL AND deleted_at IS NULL
         ORDER BY created_at ASC, start_ms ASC, source ASC, id ASC`,
      ),
      meetingIdsWithAudio: this.db.prepare(
        `SELECT DISTINCT meeting_id FROM audio_files WHERE deleted_at IS NULL ORDER BY meeting_id ASC`,
      ),
      deleteMeetingAudio: this.db.prepare(
        `UPDATE audio_files SET deleted_at = ? WHERE meeting_id = ? AND deleted_at IS NULL`,
      ),
      insertCaptureEvent: this.db.prepare(
        `INSERT INTO capture_events (meeting_id, at, offset_ms, source, kind, detail_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ),
      captureEvents: this.db.prepare(
        `SELECT * FROM capture_events WHERE meeting_id = ? ORDER BY id ASC`,
      ),
      getAppState: this.db.prepare(`SELECT value, updated_at FROM app_state WHERE key = ?`),
      setAppState: this.db.prepare(
        `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ),
      deleteAppState: this.db.prepare(`DELETE FROM app_state WHERE key = ?`),
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
    return this.statements.deleteEmptyMeeting.run({ id }).changes > 0;
  }

  endMeetingsLeftOpen(updatedAt: string, keepOpenId?: string): number {
    return Number(
      this.statements.endLeftOpen.run({ updatedAt, keepOpenId: keepOpenId ?? null }).changes,
    );
  }

  listOpenMeetings(): LocalMeeting[] {
    return this.statements.openMeetings.all().map(rowToMeeting);
  }

  setMeetingStopReason(id: string, reason: MeetingStopReason): void {
    this.statements.setStopReason.run(reason, this.now(), id);
  }

  getMeetingStopReason(id: string): string | null {
    return optionalText(this.statements.getStopReason.get(id), 'stop_reason');
  }

  resetSyncForMeeting(id: string): void {
    this.statements.resetSync.run(id);
  }

  listMeetingsNeedingSync(): LocalMeeting[] {
    return this.statements.meetingsNeedingSync.all({ now: this.now() }).map(rowToMeeting);
  }

  appendSegment(segment: TranscriptSegment, origin: SegmentOrigin = 'live'): void {
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
      origin,
    );
  }

  listUnsyncedSegments(meetingId: string, limit: number): TranscriptSegment[] {
    return this.statements.unsyncedSegments
      .all({ meetingId, limit, now: this.now() })
      .map(rowToSegment);
  }

  markSegmentsSent(ids: readonly string[]): void {
    for (const id of ids) this.sent.add(id);
  }

  markSegmentsSynced(ids: string[], syncedAt: string): void {
    if (ids.length === 0) return;
    this.transaction(() => {
      for (const id of ids) this.statements.markSynced.run(syncedAt, id);
    });
    // After the commit: a failed write keeps the lines refused, as a failed request does.
    for (const id of ids) this.sent.delete(id);
  }

  markSegmentRejected(id: string, reason: string, rejectedAt: string): void {
    this.statements.markRejected.run(rejectedAt, reason, id);
    this.sent.delete(id);
  }

  countUnsyncedSegments(): number {
    return Number(this.statements.countUnsynced.get({ now: this.now() })?.n ?? 0);
  }

  countRejectedSegments(): number {
    return Number(this.statements.countRejected.get()?.n ?? 0);
  }

  countSegments(meetingId: string): number {
    return Number(this.statements.countSegments.get(meetingId)?.n ?? 0);
  }

  getSegment(id: string): StoredSegment | null {
    const row = this.statements.getSegment.get(id);
    return row ? rowToStoredSegment(row) : null;
  }

  listSegmentsOverlapping(
    meetingId: string,
    source: AudioSource,
    fromMs: number,
    toMs: number,
  ): StoredSegment[] {
    return this.statements.segmentsOverlapping
      .all({ meetingId, source, fromMs, toMs })
      .map(rowToStoredSegment);
  }

  suppressSegment(id: string, reason: SuppressedReason, echoOf: string): boolean {
    if (this.sent.has(id)) return false;
    return this.statements.suppress.run(reason, echoOf, id).changes > 0;
  }

  trimSegment(id: string, trim: SegmentTrim): boolean {
    checkTrim(id, trim);
    if (this.sent.has(id)) return false;
    const words = trim.words === null ? null : JSON.stringify(trim.words);
    return this.statements.trim.run(trim.text, words, trim.echoOf, id).changes > 0;
  }

  unhideSegment(id: string): boolean {
    return this.statements.unhide.run(id).changes > 0;
  }

  holdSegment(id: string, uploadAfter: string): boolean {
    const until = canonicalInstant(uploadAfter, `hold of segment ${id}`);
    if (this.sent.has(id)) return false;
    return this.statements.hold.run(until, id).changes > 0;
  }

  releaseSegments(ids: readonly string[]): void {
    if (ids.length === 0) return;
    this.transaction(() => {
      for (const id of ids) this.statements.release.run(id);
    });
  }

  listHeldSegments(meetingId?: string): StoredSegment[] {
    const rows =
      meetingId === undefined
        ? this.statements.heldSegments.all()
        : this.statements.heldSegmentsOfMeeting.all(meetingId);
    return rows.map(rowToStoredSegment);
  }

  countHeldSegments(meetingId: string): number {
    return Number(this.statements.countHeld.get(meetingId)?.n ?? 0);
  }

  saveSttUsage(usage: MeetingSttUsage): void {
    const { total } = usage;
    this.statements.saveSttUsage.run(
      usage.meetingId,
      usage.provider,
      total.sessionsOpened,
      total.connectedMs,
      total.audioSentMs,
      total.droppedChunks,
      total.estimatedCostUsd,
      JSON.stringify(usage.bySource),
      usage.stopReason,
      usage.updatedAt,
    );
  }

  getSttUsage(meetingId: string): MeetingSttUsage | null {
    const row = this.statements.getSttUsage.get(meetingId);
    return row ? rowToSttUsage(row) : null;
  }

  addGap(gap: NewTranscriptGap): void {
    checkGapWindow(gap.id, gap.startMs, gap.endMs);
    withContext(`gap ${gap.id} of meeting ${gap.meetingId}`, () =>
      this.statements.insertGap.run(
        gap.id,
        gap.meetingId,
        gap.source,
        gap.startMs,
        gap.endMs,
        gap.reason,
        gap.createdAt,
      ),
    );
  }

  listGaps(meetingId: string): TranscriptGap[] {
    return this.statements.gaps.all(meetingId).map(rowToGap);
  }

  listUnrecoveredGaps(meetingId?: string): TranscriptGap[] {
    const rows =
      meetingId === undefined
        ? this.statements.unrecoveredGaps.all()
        : this.statements.unrecoveredGapsOfMeeting.all(meetingId);
    return rows.map(rowToGap);
  }

  markGapRecovered(id: string, recoveredAt: string): void {
    this.statements.gapRecovered.run(recoveredAt, id);
  }

  setGapRecoverError(id: string, error: string): void {
    this.statements.gapRecoverError.run(error, id);
  }

  addAudioFile(file: NewAudioFile): void {
    checkAudioPath(file.path);
    withContext(`audio file ${file.id} of meeting ${file.meetingId}`, () => {
      const inserted = this.statements.insertAudioFile.run(
        file.id,
        file.meetingId,
        file.source,
        file.startMs,
        file.path,
        file.format,
        file.createdAt,
      );
      if (inserted.changes > 0) return;
      // A re-send of this meeting's file is a no-op; another meeting's id is a clash (NewAudioFile.id).
      const holder = optionalText(this.statements.audioFileMeeting.get(file.id), 'meeting_id');
      if (holder !== file.meetingId) throw new Error(`the id already belongs to meeting ${holder}`);
    });
  }

  closeAudioFile(id: string, closed: { endMs: number; bytes: number; closedAt: string }): void {
    withContext(`closing audio file ${id}`, () =>
      this.statements.closeAudioFile.run(closed.endMs, closed.bytes, closed.closedAt, id),
    );
  }

  markAudioFileEncoded(
    id: string,
    encoded: { path: string; format: AudioFileFormat; bytes: number },
  ): void {
    checkAudioPath(encoded.path);
    this.statements.encodeAudioFile.run(encoded.path, encoded.format, encoded.bytes, id);
  }

  listAudioFiles(meetingId: string): AudioFile[] {
    return this.statements.audioFiles.all(meetingId).map(rowToAudioFile);
  }

  listOpenAudioFiles(): AudioFile[] {
    return this.statements.openAudioFiles.all().map(rowToAudioFile);
  }

  listMeetingIdsWithAudio(): string[] {
    return this.statements.meetingIdsWithAudio.all().map((row) => text(row, 'meeting_id'));
  }

  markMeetingAudioDeleted(meetingId: string, deletedAt: string): number {
    return Number(this.statements.deleteMeetingAudio.run(deletedAt, meetingId).changes);
  }

  addCaptureEvent(event: NewCaptureEvent): number {
    const result = withContext(`capture event ${event.kind} of meeting ${event.meetingId}`, () =>
      this.statements.insertCaptureEvent.run(
        event.meetingId,
        event.at,
        event.offsetMs,
        event.source,
        event.kind,
        JSON.stringify(event.detail ?? {}),
      ),
    );
    return Number(result.lastInsertRowid);
  }

  listCaptureEvents(meetingId: string): CaptureEvent[] {
    return this.statements.captureEvents.all(meetingId).map(rowToCaptureEvent);
  }

  getAppState(key: string): AppStateEntry | null {
    const row = this.statements.getAppState.get(key);
    return row ? { value: text(row, 'value'), updatedAt: text(row, 'updated_at') } : null;
  }

  setAppState(key: string, value: string, updatedAt: string): void {
    this.statements.setAppState.run(key, value, updatedAt);
  }

  deleteAppState(key: string): void {
    this.statements.deleteAppState.run(key);
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

function rowToStoredSegment(row: Row): StoredSegment {
  return {
    ...rowToSegment(row),
    origin: segmentOrigin(row.origin),
    suppressedReason: suppressedReason(row.suppressed_reason),
    echoOf: optionalText(row, 'echo_of'),
    originalText: optionalText(row, 'original_text'),
    originalWords: parseWords(row.original_words_json),
    uploadAfter: optionalText(row, 'upload_after'),
    syncedAt: optionalText(row, 'synced_at'),
  };
}

function rowToGap(row: Row): TranscriptGap {
  return {
    id: text(row, 'id'),
    meetingId: text(row, 'meeting_id'),
    source: audioSource(row.source, 'transcript_gaps'),
    startMs: Number(row.start_ms),
    endMs: Number(row.end_ms),
    reason: gapReason(row.reason),
    createdAt: text(row, 'created_at'),
    recoveredAt: optionalText(row, 'recovered_at'),
    recoverError: optionalText(row, 'recover_error'),
  };
}

function rowToAudioFile(row: Row): AudioFile {
  const format = row.format;
  if (format !== 'wav' && format !== 'm4a')
    throw new Error(`corrupt audio_files row: format=${String(format)}`);
  return {
    id: text(row, 'id'),
    meetingId: text(row, 'meeting_id'),
    source: audioSource(row.source, 'audio_files'),
    startMs: Number(row.start_ms),
    endMs: row.end_ms === null || row.end_ms === undefined ? null : Number(row.end_ms),
    path: text(row, 'path'),
    format,
    bytes: Number(row.bytes),
    createdAt: text(row, 'created_at'),
    closedAt: optionalText(row, 'closed_at'),
    deletedAt: optionalText(row, 'deleted_at'),
  };
}

function rowToCaptureEvent(row: Row): CaptureEvent {
  const source = row.source;
  if (source !== null && !isAudioSource(source))
    throw new Error(`corrupt capture_events row: source=${String(source)}`);
  return {
    id: Number(row.id),
    meetingId: text(row, 'meeting_id'),
    at: text(row, 'at'),
    offsetMs: Number(row.offset_ms),
    source,
    kind: text(row, 'kind'),
    detail: parseDetail(text(row, 'detail_json')),
  };
}

function rowToSttUsage(row: Row): MeetingSttUsage {
  const cost = row.estimated_cost_usd;
  return {
    meetingId: text(row, 'meeting_id'),
    provider: text(row, 'provider'),
    total: {
      sessionsOpened: Number(row.sessions_opened),
      connectedMs: Number(row.connected_ms),
      audioSentMs: Number(row.audio_sent_ms),
      droppedChunks: Number(row.dropped_chunks),
      estimatedCostUsd: cost === null || cost === undefined ? null : Number(cost),
    },
    // Written by saveSttUsage from a typed Record<AudioSource, SttUsage>; the cast restores it.
    bySource: JSON.parse(text(row, 'by_source_json')) as Record<AudioSource, SttUsage>,
    stopReason:
      row.stop_reason === null || row.stop_reason === undefined ? null : text(row, 'stop_reason'),
    updatedAt: text(row, 'updated_at'),
  };
}

function parseWords(value: SQLOutputValue | undefined): TranscriptWord[] | null {
  if (typeof value !== 'string') return null;
  // Written by appendSegment from a typed TranscriptWord[]; the cast restores that type.
  return JSON.parse(value) as TranscriptWord[];
}

function parseDetail(json: string): JsonObject {
  const value: unknown = JSON.parse(json);
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('corrupt capture_events row: detail_json is not an object');
  // Written by addCaptureEvent from a typed JsonObject; the cast restores that type.
  return value as JsonObject;
}

/** Run one write and name what it was for: SQLite's own message ("FOREIGN KEY constraint failed") does not. */
function withContext<T>(what: string, write: () => T): T {
  try {
    return write();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`could not write ${what}: ${message}`, { cause: error });
  }
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`corrupt row: ${key} is ${typeof value}`);
  return value;
}

function optionalText(row: Row | undefined, key: string): string | null {
  if (row === undefined) return null;
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error(`corrupt row: ${key} is ${typeof value}`);
  return value;
}

function audioSource(value: SQLOutputValue | undefined, table: string): AudioSource {
  if (!isAudioSource(value)) throw new Error(`corrupt ${table} row: source=${String(value)}`);
  return value;
}

function segmentOrigin(value: SQLOutputValue | undefined): SegmentOrigin {
  if (value === 'live' || value === 'rerun') return value;
  throw new Error(`corrupt segment row: origin=${String(value)}`);
}

function suppressedReason(value: SQLOutputValue | undefined): SuppressedReason | null {
  if (value === null || value === undefined) return null;
  if (value === 'echo') return value;
  throw new Error(`corrupt segment row: suppressed_reason=${String(value)}`);
}

function gapReason(value: SQLOutputValue | undefined): GapReason {
  if (value === 'stt_failed' || value === 'offline' || value === 'budget' || value === 'crash')
    return value;
  throw new Error(`corrupt transcript_gaps row: reason=${String(value)}`);
}

function remoteState(value: SQLOutputValue | undefined): RemoteState {
  if (value === 'pending' || value === 'created' || value === 'ended') return value;
  throw new Error(`corrupt meeting row: remote_state=${String(value)}`);
}
