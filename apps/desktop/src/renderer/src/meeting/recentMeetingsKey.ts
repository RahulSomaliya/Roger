import type { CaptureStatus } from '../../../shared/capture';

/**
 * The sidebar's refreshKey (useRecentMeetings): it changes when the meetings on this Mac may have
 * changed, a recording starting (main adds its meeting) or stopping (main ends it, or deletes it
 * when nobody spoke), and never on the statuses in between.
 *
 * Never the status object itself: main sends an idle status after every uploader pass, every 2 s,
 * each a new object over IPC, and that key read `meetings:list` every 2 s all day. Never the phase
 * alone either: React renders a burst of statuses once (the preview's scenarios send `recording`
 * then `idle` in one task), so the list would see idle before and after and miss the recording.
 * `lastMeetingId` catches that: useCapture takes it from every status main sends, rendered or not
 * (lastNamedMeeting), so after such a burst it names the meeting the burst recorded. A burst
 * nobody spoke in costs one read that finds the list as it was.
 */
export function recentMeetingsKey(
  status: CaptureStatus | null,
  lastMeetingId: string | null,
): string {
  const named = status?.meetingId ?? null;
  if (named !== null) return `recording ${named}`;
  return `idle ${lastMeetingId ?? ''}`;
}
