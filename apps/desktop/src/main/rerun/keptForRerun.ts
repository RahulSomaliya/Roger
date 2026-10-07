import type { MeetingKeptForRerun } from '../../shared/ipc/capture';
import { audioKeep } from '../backup/AudioRetentionSweeper';
import type { TranscriptStore } from '../store/TranscriptStore';

/**
 * The meetings whose audio is kept for a re-run (`audio:list-kept-for-rerun`, M2-T20b's Home
 * card), newest first, as their reports would say it: kept while a gap is unrecovered and audio is
 * left (a gap with none can never be re-run), until `audioKeep`'s date, the rule the report's
 * `backup` (AudioBackup.report) and the retention sweep use, so the card, the report and the delete
 * agree.
 *
 * One read of every unrecovered gap, counted per meeting, then `getMeeting` per meeting listed:
 * the store has no read for several meetings, and the list is short. Never a report per meeting,
 * which reads each meeting's files, events and gaps.
 */
export function listMeetingsKeptForRerun(
  store: Pick<TranscriptStore, 'listUnrecoveredGaps' | 'listMeetingIdsWithAudio' | 'getMeeting'>,
  retentionDays: number,
): MeetingKeptForRerun[] {
  const gapCounts = new Map<string, number>();
  for (const gap of store.listUnrecoveredGaps()) {
    gapCounts.set(gap.meetingId, (gapCounts.get(gap.meetingId) ?? 0) + 1);
  }
  const kept: (MeetingKeptForRerun & { startedAt: string })[] = [];
  for (const meetingId of store.listMeetingIdsWithAudio()) {
    const gaps = gapCounts.get(meetingId) ?? 0;
    const meeting = gaps === 0 ? null : store.getMeeting(meetingId);
    if (meeting === null) continue;
    const { keepUntilMs } = audioKeep(meeting.endedAt, gaps, retentionDays);
    kept.push({
      meetingId,
      title: meeting.title,
      keepUntil: keepUntilMs === null ? null : new Date(keepUntilMs).toISOString(),
      startedAt: meeting.startedAt,
    });
  }
  // As listMeetings orders: the start (always toISOString form, so text order is time order),
  // then the id, both descending. Code-unit order, as SQLite's BINARY collation compares: never
  // localeCompare, whose collation may weigh the `-` and `:` differently.
  kept.sort((a, b) => byText(b.startedAt, a.startedAt) || byText(b.meetingId, a.meetingId));
  return kept.map(({ meetingId, title, keepUntil }) => ({ meetingId, title, keepUntil }));
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
