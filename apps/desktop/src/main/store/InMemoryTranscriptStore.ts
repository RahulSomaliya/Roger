import type { TranscriptSegment } from '../../shared/transcript';
import type {
  LocalMeeting,
  NewLocalMeeting,
  RemoteState,
  TranscriptStore,
} from './TranscriptStore';

/** Reference implementation used by unit tests of the services around the store. */
export class InMemoryTranscriptStore implements TranscriptStore {
  readonly meetings = new Map<string, LocalMeeting>();
  readonly segments = new Map<
    string,
    TranscriptSegment & { syncedAt: string | null; rejectedAt: string | null }
  >();

  createMeeting(meeting: NewLocalMeeting): void {
    if (this.meetings.has(meeting.id)) return;
    this.meetings.set(meeting.id, { ...meeting, endedAt: null, remoteState: 'pending' });
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
    return this.meetings.delete(id);
  }

  listMeetingsNeedingSync(): LocalMeeting[] {
    return [...this.meetings.values()]
      .filter((meeting) => meeting.remoteState !== 'ended')
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
  }

  appendSegment(segment: TranscriptSegment): void {
    if (this.segments.has(segment.id)) return;
    this.segments.set(segment.id, { ...segment, syncedAt: null, rejectedAt: null });
  }

  listUnsyncedSegments(meetingId: string, limit: number): TranscriptSegment[] {
    return [...this.segments.values()]
      .filter(
        (segment) =>
          segment.meetingId === meetingId &&
          segment.syncedAt === null &&
          segment.rejectedAt === null,
      )
      .sort(
        (a, b) =>
          a.startMs - b.startMs || a.source.localeCompare(b.source) || a.id.localeCompare(b.id),
      )
      .slice(0, limit)
      .map(({ syncedAt: _syncedAt, rejectedAt: _rejectedAt, ...segment }) => segment);
  }

  markSegmentsSynced(ids: string[], syncedAt: string): void {
    for (const id of ids) {
      const segment = this.segments.get(id);
      if (segment) segment.syncedAt ??= syncedAt;
    }
  }

  markSegmentRejected(id: string, _reason: string, rejectedAt: string): void {
    const segment = this.segments.get(id);
    if (segment?.syncedAt === null) segment.rejectedAt = rejectedAt;
  }

  countUnsyncedSegments(): number {
    return [...this.segments.values()].filter((s) => s.syncedAt === null && s.rejectedAt === null)
      .length;
  }

  countRejectedSegments(): number {
    return [...this.segments.values()].filter((segment) => segment.rejectedAt !== null).length;
  }

  countSegments(meetingId: string): number {
    return [...this.segments.values()].filter((segment) => segment.meetingId === meetingId).length;
  }

  close(): void {
    // nothing to release
  }
}
