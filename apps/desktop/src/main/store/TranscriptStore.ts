import type { TranscriptSegment } from '../../shared/transcript';

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
 * The Mac-side safety copy (house rule 1). Every final line is written here first; the uploader
 * drains it into Postgres. All methods are synchronous because SQLite is local and the writes are
 * tiny; keeping them synchronous means a line is on disk before `appendSegment` returns.
 */
export interface TranscriptStore {
  createMeeting(meeting: NewLocalMeeting): void;
  getMeeting(id: string): LocalMeeting | null;
  markMeetingEnded(id: string, endedAt: string): void;
  setMeetingRemoteState(id: string, state: RemoteState): void;
  /** Delete a meeting that never produced a line (for example a failed start). */
  deleteMeetingIfEmpty(id: string): boolean;
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
  close(): void;
}
