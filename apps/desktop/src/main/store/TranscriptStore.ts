import type { MeetingCalendarEvent } from '../../shared/calendar';
import type { StartSource } from '../../shared/capture';
import type { AudioSource, TranscriptSegment, TranscriptWord } from '../../shared/transcript';
import type { StopReason } from '../capture/stopReasons';
import type { SttUsage } from '../stt/usage';

/** Where a local meeting stands against Postgres. */
export type RemoteState = 'pending' | 'created' | 'ended';

export interface LocalMeeting {
  id: string;
  title: string;
  /** ISO 8601 instant, UTC. */
  startedAt: string;
  endedAt: string | null;
  remoteState: RemoteState;
  /** How its recording was started (migration 5): `manual` for every meeting from before it. */
  startSource: StartSource;
  /** The calendar event it was started for, sent with its create; null when none. */
  calendarEvent: MeetingCalendarEvent | null;
}

export interface NewLocalMeeting {
  id: string;
  title: string;
  /**
   * In `toISOString` form ("2026-10-06T09:30:00.000Z"), as CaptureService writes it: the store
   * orders meetings on this text (listMeetings), and "09:30:00Z" or a "+01:00" offset sorts
   * against it by its characters, not by its instant, so the sidebar would list it out of order.
   */
  startedAt: string;
  /** Default `manual`. A value outside StartSource is refused (storeChecks.checkStartSource). */
  startSource?: StartSource;
  /** Default null. */
  calendarEvent?: MeetingCalendarEvent | null;
}

/**
 * What one meeting's speech-to-text sessions used, as the vendor bills it (cost guard G7). Local
 * only until M3 uploads it.
 */
export interface MeetingSttUsage {
  meetingId: string;
  provider: string;
  total: SttUsage;
  bySource: Record<AudioSource, SttUsage>;
  /** Why the recording stopped (stopReasons.ts, or `start-failed`); null while it still runs. */
  stopReason: string | null;
  /** ISO 8601 instant, UTC. */
  updatedAt: string;
}

/**
 * What `meetings.stop_reason` records: the stop that ended the recording, or `crash` for a meeting
 * a previous run left open. Read back as a plain string: a row may hold a reason since retired
 * (`page-reloaded`, M2-T12).
 */
export type MeetingStopReason = StopReason | 'crash';

/** Why a line is hidden: it repeated call audio (M2 D2). Hidden lines are never uploaded. */
export type SuppressedReason = 'echo';

/** A line from the live meeting, or one re-run from the audio backup after it (M2-T16). */
export type SegmentOrigin = 'live' | 'rerun';

/**
 * A stored line with its local-only state (migration 4). The uploader sends `TranscriptSegment`
 * fields only: none of these extra fields reaches Postgres.
 */
export interface StoredSegment extends TranscriptSegment {
  origin: SegmentOrigin;
  suppressedReason: SuppressedReason | null;
  /** The call-audio line this one repeated, when hidden or trimmed. */
  echoOf: string | null;
  /** The line as the vendor wrote it, kept once echo words were trimmed out; null otherwise. */
  originalText: string | null;
  /** The vendor's words for `originalText`; null when untrimmed or the vendor sent none. */
  originalWords: TranscriptWord[] | null;
  /** While set, the line waits for the echo sink, at most until this ISO 8601 instant. */
  uploadAfter: string | null;
  syncedAt: string | null;
}

/** What is left of a line once its echo words are cut out (M2 D2). */
export interface SegmentTrim {
  text: string;
  words: TranscriptWord[] | null;
  echoOf: string;
}

/**
 * Why audio reached main but not the vendor (M2-T6), or was lost in a crash (M2-T23). A window
 * with no audio at all is a capture event, not a gap. `asleep` is audio held while the Mac slept
 * (M2-T18) and never sent: a Stop at wake came first, or the hold overflowed before the reopen.
 * Every reason is listed here, because the tasks that write gaps (M2-T6, M2-T23) do not own this
 * file; SqliteTranscriptStore's reader and `CaptureGapReason` (shared/capture.ts) list them too.
 */
export type GapReason = 'stt_failed' | 'offline' | 'asleep' | 'budget' | 'crash';

/** A window of one stream to re-run from the audio backup. Offsets from the meeting start. */
export interface NewTranscriptGap {
  /** UUIDv4 from the desktop: re-recording a gap is a no-op. */
  id: string;
  meetingId: string;
  source: AudioSource;
  startMs: number;
  /** Greater than `startMs`. */
  endMs: number;
  reason: GapReason;
  createdAt: string;
}

export interface TranscriptGap extends NewTranscriptGap {
  /** When the re-run filled it; null until then. */
  recoveredAt: string | null;
  /** Why the last re-run did not fill it (no audio kept, the vendor failed); null otherwise. */
  recoverError: string | null;
}

export type AudioFileFormat = 'wav' | 'm4a';

/** One chunk of the local audio backup (M2 D5): one stream, one timeline run, 60 s at most. */
export interface NewAudioFile {
  /**
   * UUIDv4 from the desktop, unique across every meeting: `audio_files.id` is one key for all of
   * them, and `closeAudioFile` and `markAudioFileEncoded` find a row by id alone. Never a
   * per-meeting name such as `mic-000000000`: the second meeting's row would clash with the first
   * (`addAudioFile` throws). A descriptive name belongs in `path`.
   */
  id: string;
  meetingId: string;
  source: AudioSource;
  /** Meeting offset of the first sample. */
  startMs: number;
  /**
   * Relative to the app's userData folder (`audio/<meetingId>/<file>`), never absolute and never
   * climbing out with `..`: the committed backup fixture and M3-T12's reader resolve it against
   * a folder of their own, and a stored path cannot point a delete outside the audio root.
   */
  path: string;
  format: AudioFileFormat;
  createdAt: string;
}

export interface AudioFile extends NewAudioFile {
  /** Meeting offset just past the last sample; null while the file is still being written. */
  endMs: number | null;
  /** Size on disk; 0 until the file is closed. */
  bytes: number;
  closedAt: string | null;
  deletedAt: string | null;
}

/** A JSON value, as capture event details store it. */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

/**
 * Something capture did or saw (a pause, a failure, a reopen, a device switch), for the capture
 * report. `kind` is free text, so the tasks that add kinds need not edit this file. Details hold
 * codes, counts and timings, never transcript text.
 */
export interface NewCaptureEvent {
  meetingId: string;
  /** ISO 8601 instant, UTC. */
  at: string;
  offsetMs: number;
  /** Null when the event concerns both streams or neither. */
  source: AudioSource | null;
  kind: string;
  detail?: JsonObject;
}

export interface CaptureEvent extends Required<NewCaptureEvent> {
  /**
   * Orders one meeting's events. Never a cursor across meetings: an id is the highest stored id
   * plus 1 (`INTEGER PRIMARY KEY`, no AUTOINCREMENT), so once `deleteMeetingIfEmpty` cascades the
   * newest events away, their ids are given out again.
   */
  id: number;
}

/** A device-level value, such as the signing identity system audio was verified for. */
export interface AppStateEntry {
  value: string;
  updatedAt: string;
}

/**
 * The Mac-side safety copy (house rule 1). Every final line is written here first; the uploader
 * drains it into Postgres. All methods are synchronous because SQLite is local and the writes are
 * tiny; keeping them synchronous means a line is on disk before `appendSegment` returns.
 */
export interface TranscriptStore {
  createMeeting(meeting: NewLocalMeeting): void;
  getMeeting(id: string): LocalMeeting | null;
  markMeetingEnded(id: string, endedAt: string): void;
  setMeetingRemoteState(id: string, state: RemoteState): void;
  /**
   * Delete a meeting that never produced a line (a failed start, or Stop before anyone spoke),
   * with its gaps, audio rows and capture events (the cascade). A meeting with audio not yet
   * deleted is kept: the cascade would drop the rows a gap re-run reads and leave files on disk
   * that no sweeper finds. It goes once its audio is deleted (by the user, the retention sweep or
   * the 30-day cap), whether or not a gap is still unrecovered. Do not add an unrecovered-gap
   * check: a gap with no audio kept can never be re-run (backup off, or the audio deleted), so such
   * a check would keep the meeting pending, and in every uploader tick, for good; and a gap whose
   * audio is kept is already covered by the audio check.
   */
  deleteMeetingIfEmpty(id: string): boolean;
  /**
   * Close meetings a crash left open: `ended_at` becomes the last line's time, or the start, and
   * `stop_reason` becomes `crash` unless a stop already wrote one (a quit whose stop outran its
   * bound). `keepOpenId` stays open, for a crash resume (M2-T23). Only safe when no session is
   * running (startup). Returns how many were closed.
   */
  endMeetingsLeftOpen(updatedAt: string, keepOpenId?: string): number;
  /** Meetings with no end yet, oldest first. At startup, the ones a previous run left open. */
  listOpenMeetings(): LocalMeeting[];
  setMeetingStopReason(id: string, reason: MeetingStopReason): void;
  getMeetingStopReason(id: string): string | null;
  /** Forget that a meeting's lines were uploaded, so they are sent again (Postgres lost the meeting). */
  resetSyncForMeeting(id: string): void;
  /**
   * Meetings the uploader has work for, oldest first: every meeting not ended remotely, plus a
   * meeting ended remotely that has a line that can upload (as `listUnsyncedSegments` selects
   * them: a re-run line, an unhidden one, a released hold). M1 dropped a meeting from sync for good
   * once it was ended remotely, which stranded every later line. One ended remotely with nothing
   * to upload is never listed, so the uploader does not touch it again.
   */
  listMeetingsNeedingSync(): LocalMeeting[];
  /** Idempotent on `segment.id`. */
  appendSegment(segment: TranscriptSegment, origin?: SegmentOrigin): void;
  /**
   * Lines that can upload, oldest first: not uploaded, not rejected, not hidden, and not held
   * (`upload_after` unset or past, by the store's clock). "N lines waiting" counts the same set,
   * or it would never reach zero while the echo filter hides a line.
   */
  listUnsyncedSegments(meetingId: string, limit: number): TranscriptSegment[];
  /**
   * The uploader is sending these lines, as listed. From now until each is marked uploaded or
   * rejected, `suppressSegment`, `trimSegment` and `holdSegment` refuse it as they refuse an
   * uploaded line: once the request is out, Postgres may hold the text as sent, and a hide or trim
   * landing before the response would leave the local copy disagreeing with it (the plan's case: a
   * mic line's 120 s cap passes while call audio reconnects, and its twin arrives mid-upload). A
   * failed request keeps the mark, since the API may have stored the batch before the response
   * was lost; the retry ends it. Sent lines still upload and count as waiting.
   *
   * Kept in memory, not in SQLite: a crash between a request and its `markSegmentsSynced` forgets
   * it, so after a relaunch a line Postgres holds can read as never sent. Only a held line past its
   * cap can be both uploading at the crash and seen by the startup settle (`listHeldSegments`).
   */
  markSegmentsSent(ids: readonly string[]): void;
  /** Stamps every listed line not yet marked, and ends its `markSegmentsSent` mark. */
  markSegmentsSynced(ids: string[], syncedAt: string): void;
  /**
   * Set a line aside after the API rejected it as invalid, so it never blocks the queue. It never
   * reaches Postgres, so its `markSegmentsSent` mark ends too.
   */
  markSegmentRejected(id: string, reason: string, rejectedAt: string): void;
  /** Lines that can upload, as `listUnsyncedSegments` selects them, across meetings. */
  countUnsyncedSegments(): number;
  countRejectedSegments(): number;
  countSegments(meetingId: string): number;
  getSegment(id: string): StoredSegment | null;
  /**
   * Every stored line of one source whose span touches `[fromMs, toMs]`, hidden ones included,
   * in start order: the call-audio lines a mic line is checked against (M2-T14b), and the lines a
   * gap re-run must not repeat (M2-T16).
   */
  listSegmentsOverlapping(
    meetingId: string,
    source: AudioSource,
    fromMs: number,
    toMs: number,
  ): StoredSegment[];
  /**
   * Hide a line not yet sent and end its hold. False when it is unknown, being sent
   * (`markSegmentsSent`) or already marked uploaded: Postgres keeps what it was sent, so hiding it
   * here would make the two disagree. The echo sink reads false as "too late": the line stays.
   * True proves this run never sent it (see `markSegmentsSent` for a crash).
   */
  suppressSegment(id: string, reason: SuppressedReason, echoOf: string): boolean;
  /**
   * Replace a line's text and words with what is left after the echo words are cut out, keeping
   * the vendor's version in `original_text` (the first trim's, on a second trim). The hold is
   * kept: the echo sink releases the line. False when unknown, being sent or already marked
   * uploaded, as `suppressSegment`. Throws on an empty text: a line trimmed to nothing is hidden
   * instead.
   */
  trimSegment(id: string, trim: SegmentTrim): boolean;
  /** Show a hidden line again, which lets it upload. False when it was not hidden. */
  unhideSegment(id: string): boolean;
  /**
   * Hold a line that is not uploaded yet until the echo sink releases it, or `uploadAfter` (an ISO
   * 8601 instant, the cap) passes. False when unknown, being sent or already marked uploaded, as
   * `suppressSegment`. Throws on a cap without a `Z` or `±hh:mm` offset
   * (storeChecks.canonicalInstant).
   */
  holdSegment(id: string, uploadAfter: string): boolean;
  releaseSegments(ids: readonly string[]): void;
  /**
   * Lines still held: not uploaded, not hidden, not rejected, with `upload_after` set, past or not.
   * One meeting, or every meeting. Not only the holds a crash left: the startup settle (the
   * uploader's `beforeFirstTick`) is retried after a failure and can run once a capture holds
   * lines for their call-audio twins, so it keeps to lines created before the uploader's
   * `launchedAt` (see `TranscriptUploader.setBeforeFirstTick`).
   */
  listHeldSegments(meetingId?: string): StoredSegment[];
  /**
   * How many lines one meeting still holds, as `listHeldSegments` lists them: a line past its cap
   * counts until it is uploaded or released. The uploader never ends a meeting while this is not 0.
   */
  countHeldSegments(meetingId: string): number;

  /** Idempotent on `gap.id`. Throws when `endMs` is not after `startMs` or the meeting is unknown. */
  addGap(gap: NewTranscriptGap): void;
  /** One meeting's gaps, recovered ones included, in start order. */
  listGaps(meetingId: string): TranscriptGap[];
  /** Gaps not yet filled, failed attempts included, oldest first; one meeting or all. */
  listUnrecoveredGaps(meetingId?: string): TranscriptGap[];
  markGapRecovered(id: string, recoveredAt: string): void;
  setGapRecoverError(id: string, error: string): void;

  /**
   * Idempotent on `file.id` within its meeting. Throws when another meeting already holds the id
   * (a silent skip would orphan this meeting's file), or on a path that is absolute or climbs with
   * `..`.
   */
  addAudioFile(file: NewAudioFile): void;
  closeAudioFile(id: string, closed: { endMs: number; bytes: number; closedAt: string }): void;
  /** The file was re-encoded (WAV to m4a): its new path, format and size. */
  markAudioFileEncoded(
    id: string,
    encoded: { path: string; format: AudioFileFormat; bytes: number },
  ): void;
  /** One meeting's files not deleted, in start order (the M3-T12 reader's contract). */
  listAudioFiles(meetingId: string): AudioFile[];
  /** Files never closed and not deleted, oldest first: a crash left their WAV headers to repair. */
  listOpenAudioFiles(): AudioFile[];
  /** Meetings that still have audio not deleted, for the retention sweep. */
  listMeetingIdsWithAudio(): string[];
  /** Mark every file of a meeting deleted (after its folder is removed). Returns how many. */
  markMeetingAudioDeleted(meetingId: string, deletedAt: string): number;

  /** Returns the event's id. */
  addCaptureEvent(event: NewCaptureEvent): number;
  /** One meeting's events in the order they were written. */
  listCaptureEvents(meetingId: string): CaptureEvent[];

  getAppState(key: string): AppStateEntry | null;
  setAppState(key: string, value: string, updatedAt: string): void;
  deleteAppState(key: string): void;

  /**
   * Upsert one meeting's usage. Not tied to the meetings table: a meeting deleted for having no
   * lines still had billed sessions, and the row keeps them.
   */
  saveSttUsage(usage: MeetingSttUsage): void;
  getSttUsage(meetingId: string): MeetingSttUsage | null;

  /**
   * The newest meetings first, open ones included, at most `limit`: the sidebar's recent list
   * (M4-S4b). Ordered by `startedAt`, then by id, both descending. The start is compared as text,
   * which is right only while every start is written in `toISOString` form (NewLocalMeeting).
   * Throws on a limit that is not a whole number from 1: SQLite reads a negative one as no limit.
   */
  listMeetings(limit: number): LocalMeeting[];
  /**
   * One meeting's lines as its page shows them (M4-S4b): the TranscriptSegment fields only, in
   * transcript order (compareTranscriptOrder in src/shared/meetings.ts), without the lines the
   * echo filter hid, which the uploader leaves out of Postgres too. Trimmed, held, re-run and
   * rejected lines stay: each is still what was said. Empty for a meeting it does not hold.
   */
  listSegments(meetingId: string): TranscriptSegment[];
  /**
   * For each of `eventIds` that a local meeting was started for, the id of the newest such meeting
   * (by `startedAt`, then id, as listMeetings orders): Home's "Open note" on an event that already
   * has one (M5-T12). An event no meeting links is left out. Matched on the event id alone:
   * Google's ids are letters, digits and `_`, and the fake provider's all start with `fake-`.
   *
   * Main only, so far: no planned channel serves it to the renderer (M5-T6's calendar IPC carries
   * the account, events and sync state; M5-T12 owns renderer files only). The task that adds the
   * channel, its shared type, bridge and preview fake is to be named before M5-T12 builds Open
   * note; that task updates this line.
   */
  findMeetingIdsByEventIds(eventIds: readonly string[]): Map<string, string>;
  close(): void;
}
