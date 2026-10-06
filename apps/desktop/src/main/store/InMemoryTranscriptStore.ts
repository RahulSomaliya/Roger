import { compareTranscriptOrder } from '../../shared/meetings';
import type { AudioSource, TranscriptSegment } from '../../shared/transcript';
import {
  canonicalInstant,
  checkAudioPath,
  checkGapWindow,
  checkListLimit,
  checkStartSource,
  checkTrim,
} from './storeChecks';
import type {
  AppStateEntry,
  AudioFile,
  AudioFileFormat,
  CaptureEvent,
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

type MemorySegment = StoredSegment & { rejectedAt: string | null };

/** Reference implementation used by unit tests of the services around the store. */
export class InMemoryTranscriptStore implements TranscriptStore {
  readonly meetings = new Map<string, LocalMeeting>();
  readonly stopReasons = new Map<string, string>();
  readonly segments = new Map<string, MemorySegment>();
  readonly sttUsage = new Map<string, MeetingSttUsage>();
  readonly gaps = new Map<string, TranscriptGap>();
  readonly audioFiles = new Map<string, AudioFile>();
  readonly captureEvents: CaptureEvent[] = [];
  readonly appState = new Map<string, AppStateEntry>();
  /** Lines the uploader is sending (TranscriptStore.markSegmentsSent). */
  private readonly sent = new Set<string>();

  /** The clock decides whether a held line's cap has passed, as SQLite's does. */
  constructor(private readonly clock: () => Date = () => new Date()) {}

  createMeeting(meeting: NewLocalMeeting): void {
    const startSource = meeting.startSource ?? 'manual';
    checkStartSource(meeting.id, startSource);
    if (this.meetings.has(meeting.id)) return;
    const event = meeting.calendarEvent ?? null;
    this.meetings.set(meeting.id, {
      id: meeting.id,
      title: meeting.title,
      startedAt: meeting.startedAt,
      endedAt: null,
      remoteState: 'pending',
      startSource,
      calendarEvent: event === null ? null : structuredClone(event),
    });
  }

  getMeeting(id: string): LocalMeeting | null {
    return this.meetings.get(id) ?? null;
  }

  markMeetingEnded(id: string, endedAt: string): void {
    const meeting = this.meetings.get(id);
    if (meeting) meeting.endedAt ??= endedAt;
  }

  setMeetingRemoteState(id: string, state: RemoteState): void {
    const meeting = this.meetings.get(id);
    if (meeting) meeting.remoteState = state;
  }

  deleteMeetingIfEmpty(id: string): boolean {
    if (this.countSegments(id) > 0) return false;
    // Kept while it has audio, which a re-run reads and the sweeper finds; no gap check on
    // purpose: see TranscriptStore.deleteMeetingIfEmpty.
    if (this.listAudioFiles(id).length > 0) return false;
    if (!this.meetings.delete(id)) return false;
    this.stopReasons.delete(id);
    for (const [gapId, gap] of this.gaps) if (gap.meetingId === id) this.gaps.delete(gapId);
    for (const [fileId, file] of this.audioFiles)
      if (file.meetingId === id) this.audioFiles.delete(fileId);
    const kept = this.captureEvents.filter((event) => event.meetingId !== id);
    this.captureEvents.splice(0, this.captureEvents.length, ...kept);
    return true;
  }

  endMeetingsLeftOpen(_updatedAt: string, keepOpenId?: string): number {
    let closed = 0;
    for (const meeting of this.meetings.values()) {
      if (meeting.endedAt !== null || meeting.id === keepOpenId) continue;
      const lines = [...this.segments.values()].filter((s) => s.meetingId === meeting.id);
      meeting.endedAt =
        lines
          .map((s) => s.createdAt)
          .sort()
          .at(-1) ?? meeting.startedAt;
      if (!this.stopReasons.has(meeting.id)) this.stopReasons.set(meeting.id, 'crash');
      closed += 1;
    }
    return closed;
  }

  listOpenMeetings(): LocalMeeting[] {
    return [...this.meetings.values()]
      .filter((meeting) => meeting.endedAt === null)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
  }

  setMeetingStopReason(id: string, reason: MeetingStopReason): void {
    if (this.meetings.has(id)) this.stopReasons.set(id, reason);
  }

  getMeetingStopReason(id: string): string | null {
    return this.stopReasons.get(id) ?? null;
  }

  resetSyncForMeeting(id: string): void {
    for (const segment of this.segments.values()) {
      if (segment.meetingId === id && segment.rejectedAt === null) segment.syncedAt = null;
    }
  }

  listMeetingsNeedingSync(): LocalMeeting[] {
    const now = this.clock().toISOString();
    const withLineToUpload = new Set(
      [...this.segments.values()]
        .filter((segment) => canUpload(segment, now))
        .map((segment) => segment.meetingId),
    );
    return [...this.meetings.values()]
      .filter((meeting) => meeting.remoteState !== 'ended' || withLineToUpload.has(meeting.id))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
  }

  appendSegment(segment: TranscriptSegment, origin: SegmentOrigin = 'live'): void {
    if (this.segments.has(segment.id)) return;
    this.segments.set(segment.id, {
      ...segment,
      origin,
      suppressedReason: null,
      echoOf: null,
      originalText: null,
      originalWords: null,
      uploadAfter: null,
      syncedAt: null,
      rejectedAt: null,
    });
  }

  listUnsyncedSegments(meetingId: string, limit: number): TranscriptSegment[] {
    const now = this.clock().toISOString();
    return sortLines(
      [...this.segments.values()].filter(
        (segment) => segment.meetingId === meetingId && canUpload(segment, now),
      ),
    )
      .slice(0, limit)
      .map(toTranscriptSegment);
  }

  markSegmentsSent(ids: readonly string[]): void {
    for (const id of ids) this.sent.add(id);
  }

  markSegmentsSynced(ids: string[], syncedAt: string): void {
    for (const id of ids) {
      const segment = this.segments.get(id);
      if (segment) segment.syncedAt ??= syncedAt;
      this.sent.delete(id);
    }
  }

  markSegmentRejected(id: string, _reason: string, rejectedAt: string): void {
    const segment = this.segments.get(id);
    if (segment?.syncedAt === null) segment.rejectedAt = rejectedAt;
    this.sent.delete(id);
  }

  countUnsyncedSegments(): number {
    const now = this.clock().toISOString();
    return [...this.segments.values()].filter((segment) => canUpload(segment, now)).length;
  }

  countRejectedSegments(): number {
    return [...this.segments.values()].filter((segment) => segment.rejectedAt !== null).length;
  }

  countSegments(meetingId: string): number {
    return [...this.segments.values()].filter((segment) => segment.meetingId === meetingId).length;
  }

  getSegment(id: string): StoredSegment | null {
    const segment = this.segments.get(id);
    return segment === undefined ? null : toStoredSegment(segment);
  }

  listSegmentsOverlapping(
    meetingId: string,
    source: AudioSource,
    fromMs: number,
    toMs: number,
  ): StoredSegment[] {
    return [...this.segments.values()]
      .filter(
        (segment) =>
          segment.meetingId === meetingId &&
          segment.source === source &&
          segment.startMs <= toMs &&
          segment.endMs >= fromMs,
      )
      .sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id))
      .map(toStoredSegment);
  }

  suppressSegment(id: string, reason: SuppressedReason, echoOf: string): boolean {
    const segment = this.unsynced(id);
    if (!segment) return false;
    segment.suppressedReason = reason;
    segment.echoOf = echoOf;
    segment.uploadAfter = null;
    return true;
  }

  trimSegment(id: string, trim: SegmentTrim): boolean {
    checkTrim(id, trim);
    const segment = this.unsynced(id);
    if (!segment) return false;
    if (segment.originalText === null) {
      segment.originalText = segment.text;
      segment.originalWords = segment.words === null ? null : structuredClone(segment.words);
    }
    segment.text = trim.text;
    segment.words = trim.words === null ? null : structuredClone(trim.words);
    segment.echoOf = trim.echoOf;
    return true;
  }

  unhideSegment(id: string): boolean {
    const segment = this.segments.get(id);
    if (!segment?.suppressedReason) return false;
    segment.suppressedReason = null;
    segment.echoOf = null;
    return true;
  }

  holdSegment(id: string, uploadAfter: string): boolean {
    const until = canonicalInstant(uploadAfter, `hold of segment ${id}`);
    const segment = this.unsynced(id);
    if (!segment) return false;
    segment.uploadAfter = until;
    return true;
  }

  releaseSegments(ids: readonly string[]): void {
    for (const id of ids) {
      const segment = this.segments.get(id);
      if (segment) segment.uploadAfter = null;
    }
  }

  listHeldSegments(meetingId?: string): StoredSegment[] {
    return [...this.segments.values()]
      .filter(
        (segment) =>
          (meetingId === undefined || segment.meetingId === meetingId) && isHeld(segment),
      )
      .sort(
        (a, b) =>
          a.meetingId.localeCompare(b.meetingId) ||
          a.startMs - b.startMs ||
          a.source.localeCompare(b.source) ||
          a.id.localeCompare(b.id),
      )
      .map(toStoredSegment);
  }

  countHeldSegments(meetingId: string): number {
    return [...this.segments.values()].filter(
      (segment) => segment.meetingId === meetingId && isHeld(segment),
    ).length;
  }

  saveSttUsage(usage: MeetingSttUsage): void {
    this.sttUsage.set(usage.meetingId, structuredClone(usage));
  }

  getSttUsage(meetingId: string): MeetingSttUsage | null {
    const usage = this.sttUsage.get(meetingId);
    return usage === undefined ? null : structuredClone(usage);
  }

  addGap(gap: NewTranscriptGap): void {
    checkGapWindow(gap.id, gap.startMs, gap.endMs);
    this.requireMeeting(gap.meetingId, `gap ${gap.id}`);
    if (this.gaps.has(gap.id)) return;
    this.gaps.set(gap.id, { ...gap, recoveredAt: null, recoverError: null });
  }

  listGaps(meetingId: string): TranscriptGap[] {
    return [...this.gaps.values()]
      .filter((gap) => gap.meetingId === meetingId)
      .sort(
        (a, b) =>
          a.startMs - b.startMs || a.source.localeCompare(b.source) || a.id.localeCompare(b.id),
      )
      .map((gap) => ({ ...gap }));
  }

  listUnrecoveredGaps(meetingId?: string): TranscriptGap[] {
    return [...this.gaps.values()]
      .filter(
        (gap) =>
          gap.recoveredAt === null && (meetingId === undefined || gap.meetingId === meetingId),
      )
      .sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) ||
          a.startMs - b.startMs ||
          a.id.localeCompare(b.id),
      )
      .map((gap) => ({ ...gap }));
  }

  markGapRecovered(id: string, recoveredAt: string): void {
    const gap = this.gaps.get(id);
    if (!gap) return;
    gap.recoveredAt = recoveredAt;
    gap.recoverError = null;
  }

  setGapRecoverError(id: string, error: string): void {
    const gap = this.gaps.get(id);
    if (gap?.recoveredAt === null) gap.recoverError = error;
  }

  addAudioFile(file: NewAudioFile): void {
    checkAudioPath(file.path);
    this.requireMeeting(file.meetingId, `audio file ${file.id}`);
    const held = this.audioFiles.get(file.id);
    if (held) {
      // A re-send of this meeting's file is a no-op; another meeting's id is a clash, as in SQLite.
      if (held.meetingId === file.meetingId) return;
      throw new Error(
        `could not write audio file ${file.id} of meeting ${file.meetingId}: ` +
          `the id already belongs to meeting ${held.meetingId}`,
      );
    }
    this.audioFiles.set(file.id, {
      ...file,
      endMs: null,
      bytes: 0,
      closedAt: null,
      deletedAt: null,
    });
  }

  closeAudioFile(id: string, closed: { endMs: number; bytes: number; closedAt: string }): void {
    const file = this.audioFiles.get(id);
    if (!file) return;
    if (closed.endMs < file.startMs)
      throw new Error(`could not write closing audio file ${id}: it ends before it starts`);
    Object.assign(file, closed);
  }

  markAudioFileEncoded(
    id: string,
    encoded: { path: string; format: AudioFileFormat; bytes: number },
  ): void {
    checkAudioPath(encoded.path);
    const file = this.audioFiles.get(id);
    if (file) Object.assign(file, encoded);
  }

  listAudioFiles(meetingId: string): AudioFile[] {
    return this.keptAudioFiles()
      .filter((file) => file.meetingId === meetingId)
      .sort(
        (a, b) =>
          a.startMs - b.startMs || a.source.localeCompare(b.source) || a.id.localeCompare(b.id),
      );
  }

  listOpenAudioFiles(): AudioFile[] {
    return this.keptAudioFiles()
      .filter((file) => file.closedAt === null)
      .sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) ||
          a.startMs - b.startMs ||
          a.source.localeCompare(b.source) ||
          a.id.localeCompare(b.id),
      );
  }

  listMeetingIdsWithAudio(): string[] {
    return [...new Set(this.keptAudioFiles().map((file) => file.meetingId))].sort();
  }

  markMeetingAudioDeleted(meetingId: string, deletedAt: string): number {
    let deleted = 0;
    for (const file of this.audioFiles.values()) {
      if (file.meetingId !== meetingId || file.deletedAt !== null) continue;
      file.deletedAt = deletedAt;
      deleted += 1;
    }
    return deleted;
  }

  addCaptureEvent(event: NewCaptureEvent): number {
    this.requireMeeting(event.meetingId, `capture event ${event.kind}`);
    const id = (this.captureEvents.at(-1)?.id ?? 0) + 1;
    this.captureEvents.push({ ...event, id, detail: structuredClone(event.detail ?? {}) });
    return id;
  }

  listCaptureEvents(meetingId: string): CaptureEvent[] {
    return this.captureEvents
      .filter((event) => event.meetingId === meetingId)
      .map((event) => structuredClone(event));
  }

  getAppState(key: string): AppStateEntry | null {
    const entry = this.appState.get(key);
    return entry === undefined ? null : { ...entry };
  }

  setAppState(key: string, value: string, updatedAt: string): void {
    this.appState.set(key, { value, updatedAt });
  }

  deleteAppState(key: string): void {
    this.appState.delete(key);
  }

  listMeetings(limit: number): LocalMeeting[] {
    checkListLimit(limit, 'meetings');
    // The twin of SqliteTranscriptStore's `recentMeetings`: change both. Text compared as SQLite's
    // BINARY collation compares it, by character code, never localeCompare.
    return [...this.meetings.values()]
      .sort((a, b) => compareText(b.startedAt, a.startedAt) || compareText(b.id, a.id))
      .slice(0, limit)
      .map((meeting) => ({ ...meeting }));
  }

  listSegments(meetingId: string): TranscriptSegment[] {
    return [...this.segments.values()]
      .filter((segment) => segment.meetingId === meetingId && segment.suppressedReason === null)
      .map(toTranscriptSegment)
      .sort(compareTranscriptOrder);
  }

  findMeetingIdsByEventIds(eventIds: readonly string[]): Map<string, string> {
    const wanted = new Set(eventIds);
    const found = new Map<string, string>();
    // The twin of SqliteTranscriptStore's MEETING_IDS_BY_EVENT_IDS: oldest first, so that a later
    // meeting of the same event replaces the one before and the newest stays. Change both.
    const oldestFirst = [...this.meetings.values()].sort(
      (a, b) => compareText(a.startedAt, b.startedAt) || compareText(a.id, b.id),
    );
    for (const meeting of oldestFirst) {
      const eventId = meeting.calendarEvent?.eventId;
      if (eventId !== undefined && wanted.has(eventId)) found.set(eventId, meeting.id);
    }
    return found;
  }

  close(): void {
    // nothing to release
  }

  /** Not marked uploaded and not being sent: what an echo write may change (markSegmentsSent). */
  private unsynced(id: string): MemorySegment | null {
    if (this.sent.has(id)) return null;
    const segment = this.segments.get(id);
    return segment?.syncedAt === null ? segment : null;
  }

  /** SQLite refuses a row for an unknown meeting (foreign key); so does this store. */
  private requireMeeting(meetingId: string, what: string): void {
    if (!this.meetings.has(meetingId))
      throw new Error(`could not write ${what} of meeting ${meetingId}: no such meeting`);
  }

  private keptAudioFiles(): AudioFile[] {
    return [...this.audioFiles.values()]
      .filter((file) => file.deletedAt === null)
      .map((file) => ({ ...file }));
  }
}

/** The in-memory twin of the SQL `CAN_UPLOAD` predicate in SqliteTranscriptStore: change both. */
function canUpload(segment: MemorySegment, now: string): boolean {
  return (
    segment.syncedAt === null &&
    segment.rejectedAt === null &&
    segment.suppressedReason === null &&
    (segment.uploadAfter === null || segment.uploadAfter <= now)
  );
}

/** The in-memory twin of the SQL `HELD` predicate in SqliteTranscriptStore: change both. */
function isHeld(segment: MemorySegment): boolean {
  return (
    segment.uploadAfter !== null &&
    segment.syncedAt === null &&
    segment.rejectedAt === null &&
    segment.suppressedReason === null
  );
}

function sortLines(lines: MemorySegment[]): MemorySegment[] {
  return lines.sort(
    (a, b) => a.startMs - b.startMs || a.source.localeCompare(b.source) || a.id.localeCompare(b.id),
  );
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function toTranscriptSegment(segment: MemorySegment): TranscriptSegment {
  return {
    id: segment.id,
    meetingId: segment.meetingId,
    source: segment.source,
    speaker: segment.speaker,
    startMs: segment.startMs,
    endMs: segment.endMs,
    text: segment.text,
    confidence: segment.confidence,
    words: segment.words,
    createdAt: segment.createdAt,
  };
}

function toStoredSegment({ rejectedAt: _rejectedAt, ...segment }: MemorySegment): StoredSegment {
  return structuredClone(segment);
}
