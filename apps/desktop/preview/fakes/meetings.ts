import type { CaptureStatus, TranscriptSegmentChange } from '../../src/shared/capture';
import { captureChannels } from '../../src/shared/ipc/capture';
import { meetingsChannels, type MeetingsApi } from '../../src/shared/ipc/meetings';
import {
  compareTranscriptOrder,
  type MeetingSummary,
  parseGetMeetingRequest,
  parseListMeetingsRequest,
} from '../../src/shared/meetings';
import type { TranscriptSegment } from '../../src/shared/transcript';
import { LIVE_CALL, PAST_MEETING } from '../scenarios';
import type { FakeHub } from './hub';

/** The titles the preview's own meetings carry in their fixtures (preview/fixtures/). */
const FIXTURE_TITLES = new Map([
  [PAST_MEETING.meetingId, PAST_MEETING.title],
  [LIVE_CALL.meetingId, LIVE_CALL.title],
]);

/** One recorded line and whether the echo filter hides it now. */
interface RecordedLine {
  segment: TranscriptSegment;
  hidden: boolean;
}

/**
 * The meetings feature's part of the preview's `window.roger`. Main answers these reads from
 * roger.sqlite, where CaptureService wrote what it sent; this fake records the same from the hub,
 * so whatever a scenario or a QA script plays is there to read, and so is a meeting the preview's
 * New note starts. A status naming a meeting creates it; its lines come with TranscriptSegment and
 * change with TranscriptSegmentChanged (a hidden line is left out of reads, as M4-S4b's
 * listSegments leaves out echo-suppressed lines); once a status stops naming it, it ends, or goes
 * if nobody spoke, as CaptureService's Stop calls deleteMeetingIfEmpty.
 */
export function createMeetingsFake(hub: FakeHub): MeetingsApi {
  const meetings = new Map<string, MeetingSummary>();
  const lines = new Map<string, Map<string, RecordedLine>>();
  let recording: string | null = null;

  const linesOf = (meetingId: string): Map<string, RecordedLine> => {
    const recorded = lines.get(meetingId) ?? new Map<string, RecordedLine>();
    lines.set(meetingId, recorded);
    return recorded;
  };

  const end = (meetingId: string): void => {
    const meeting = meetings.get(meetingId);
    if (meeting === undefined) return;
    const recorded = [...linesOf(meetingId).values()];
    if (recorded.length === 0) {
      meetings.delete(meetingId);
      return;
    }
    // At its last line, not at the clock: a scenario plays a past meeting in one go, and the
    // clock at that Stop would make yesterday's 3-minute standup last a day.
    const last = recorded
      .map(({ segment }) => segment.createdAt)
      .reduce((latest, at) => (at > latest ? at : latest));
    meetings.set(meetingId, { ...meeting, endedAt: last });
  };

  hub.on(captureChannels.CaptureStatusChanged, (status: CaptureStatus) => {
    const named = status.meetingId;
    if (recording !== null && named !== recording) {
      end(recording);
      recording = null;
    }
    if (named === null) return;
    recording = named;
    if (meetings.has(named)) return;
    const startedAt = status.startedAt ?? new Date().toISOString();
    meetings.set(named, {
      id: named,
      title: FIXTURE_TITLES.get(named) ?? defaultMeetingTitle(new Date(startedAt)),
      startedAt,
      endedAt: null,
    });
  });

  hub.on(captureChannels.TranscriptSegment, (segment: TranscriptSegment) => {
    const recorded = linesOf(segment.meetingId);
    if (!recorded.has(segment.id)) recorded.set(segment.id, { segment, hidden: false });
  });

  hub.on(captureChannels.TranscriptSegmentChanged, (change: TranscriptSegmentChange) => {
    const recorded = linesOf(change.meetingId);
    const line = recorded.get(change.segmentId);
    if (line === undefined) return;
    recorded.set(change.segmentId, {
      segment: { ...line.segment, text: change.text },
      hidden: change.change === 'hidden' || (line.hidden && change.change === 'trimmed'),
    });
  });

  return {
    listMeetings: (request) =>
      hub.request(meetingsChannels.MeetingsList, () => {
        const parsed = parseListMeetingsRequest(request);
        if (parsed === null) throw refused(meetingsChannels.MeetingsList, request);
        return [...meetings.values()]
          .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))
          .slice(0, parsed.limit);
      }),
    getMeeting: (request) =>
      hub.request(meetingsChannels.MeetingsGet, () => {
        const parsed = parseGetMeetingRequest(request);
        if (parsed === null) throw refused(meetingsChannels.MeetingsGet, request);
        const meeting = meetings.get(parsed.meetingId);
        if (meeting === undefined) return null;
        const segments = [...linesOf(parsed.meetingId).values()]
          .filter((line) => !line.hidden)
          .map((line) => line.segment)
          .sort(compareTranscriptOrder);
        // The preview starts no meeting from an invite, so it has no invitees.
        return { ...meeting, segments, attendees: [] };
      }),
  };
}

/**
 * What the page gets when main's handler refuses a payload: Electron rejects the invoke with the
 * error's text, never the object (qa/README.md, "Errors cross IPC as text").
 */
function refused(channel: string, payload: unknown): Error {
  return new Error(
    `Error invoking remote method '${channel}': Error: ${channel} refused ${JSON.stringify(payload)}`,
  );
}

/** As main's defaultMeetingTitle (src/main/capture/CaptureService.ts) names a meeting it starts. */
function defaultMeetingTitle(startedAt: Date): string {
  const date = startedAt.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  const time = startedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `Meeting ${date} ${time}`;
}
