import type { CaptureStatus } from '../../../shared/capture';
import type { TranscriptSegment } from '../../../shared/transcript';

/**
 * The sidebar's refreshKey (useRecentMeetings): it changes when the meetings on this Mac may have
 * changed, a recording starting (main adds its meeting) or stopping (main ends it, or deletes it
 * when nobody spoke), and never on the statuses in between.
 *
 * Never the status object itself: main sends an idle status after every uploader pass, every 2 s,
 * each a new object over IPC, and that key read `meetings:list` every 2 s all day. Never the phase
 * alone either: React renders a burst of statuses once (the preview's scenarios send `recording`
 * then `idle` in one task), so the list would see idle before and after and miss the recording.
 * The newest line's meeting catches that: main keeps only a meeting someone spoke in, each line
 * reaches `segments` (useCapture), and useCapture empties them when main names the next meeting.
 */
export function recentMeetingsKey(
  status: CaptureStatus | null,
  segments: readonly TranscriptSegment[],
): string {
  const named = status?.meetingId ?? null;
  if (named !== null) return `recording ${named}`;
  return `idle ${segments.at(-1)?.meetingId ?? ''}`;
}
