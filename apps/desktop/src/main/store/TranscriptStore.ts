import type { AudioSource, TranscriptSegment } from '../../shared/transcript';
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
}

export interface NewLocalMeeting {
  id: string;
  title: string;
  startedAt: string;
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
 * The Mac-side safety copy (house rule 1). Every final line is written here first; the uploader
 * drains it into Postgres. All methods are synchronous because SQLite is local and the writes are
 * tiny; keeping them synchronous means a line is on disk before `appendSegment` returns.
 */
export interface TranscriptStore {
  createMeeting(meeting: NewLocalMeeting): void;
  getMeeting(id: string): LocalMeeting | null;
  markMeetingEnded(id: string, endedAt: string): void;
  setMeetingRemoteState(id: string, state: RemoteState): void;
  /** Delete a meeting that never produced a line (a failed start, or Stop before anyone spoke). */
  deleteMeetingIfEmpty(id: string): boolean;
  /**
   * Close meetings a crash left open: `ended_at` becomes the last line's time, or the start.
   * Only safe when no session is running (startup). Returns how many were closed.
   */
  endMeetingsLeftOpen(updatedAt: string): number;
  /** Forget that a meeting's lines were uploaded, so they are sent again (Postgres lost the meeting). */
  resetSyncForMeeting(id: string): void;
  /** Meetings not yet fully in Postgres, oldest first. */
  listMeetingsNeedingSync(): LocalMeeting[];
  /** Idempotent on `segment.id`. */
  appendSegment(segment: TranscriptSegment): void;
  /** Lines not yet uploaded and not rejected, oldest first. */
  listUnsyncedSegments(meetingId: string, limit: number): TranscriptSegment[];
  markSegmentsSynced(ids: string[], syncedAt: string): void;
  /** Set a line aside after the API rejected it as invalid, so it never blocks the queue. */
  markSegmentRejected(id: string, reason: string, rejectedAt: string): void;
  countUnsyncedSegments(): number;
  countRejectedSegments(): number;
  countSegments(meetingId: string): number;
  /**
   * Upsert one meeting's usage. Not tied to the meetings table: a meeting deleted for having no
   * lines still had billed sessions, and the row keeps them.
   */
  saveSttUsage(usage: MeetingSttUsage): void;
  getSttUsage(meetingId: string): MeetingSttUsage | null;
  close(): void;
}
