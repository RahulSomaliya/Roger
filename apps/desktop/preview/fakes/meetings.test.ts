import { describe, expect, it } from 'vitest';
import {
  type CaptureStatus,
  idleCaptureStatus,
  type TranscriptSegmentChange,
  type UploadStatus,
} from '../../src/shared/capture';
import { captureChannels } from '../../src/shared/ipc/capture';
import type { AudioSource, TranscriptSegment } from '../../src/shared/transcript';
import { createFakeRoger } from '../fakeRoger';
import { LIVE_CALL, PAST_MEETING } from '../scenarios';
import { FakeHub } from './hub';
import { createMeetingsFake } from './meetings';

const UPLOADED: UploadStatus = {
  state: 'idle',
  pending: 0,
  rejected: 0,
  lastError: null,
  nextAttemptAt: null,
};
const FIRST = '1a2b3c4d-1111-4aaa-8bbb-000000000001';
const SECOND = '1a2b3c4d-2222-4aaa-8bbb-000000000002';
const THIRD = '1a2b3c4d-3333-4aaa-8bbb-000000000003';

function recording(meetingId: string, startedAt: string): CaptureStatus {
  return { ...idleCaptureStatus(UPLOADED), phase: 'recording', meetingId, startedAt };
}

function line(
  meetingId: string,
  id: string,
  startMs: number,
  createdAt: string,
  source: AudioSource = 'mic',
): TranscriptSegment {
  return {
    id,
    meetingId,
    source,
    speaker: source === 'mic' ? 'me' : 'them',
    startMs,
    endMs: startMs + 900,
    text: `line ${id}`,
    confidence: 0.9,
    words: null,
    createdAt,
  };
}

/** Plays a meeting as main sends it: recording, its lines, then idle after Stop. */
function play(hub: FakeHub, meetingId: string, startedAt: string, lines: TranscriptSegment[]) {
  hub.emit(captureChannels.CaptureStatusChanged, recording(meetingId, startedAt));
  for (const segment of lines) hub.emit(captureChannels.TranscriptSegment, segment);
  hub.emit(captureChannels.CaptureStatusChanged, idleCaptureStatus(UPLOADED));
}

describe('the meetings fake', () => {
  it('lists the meetings the hub played, newest start first, at most the limit', async () => {
    const hub = new FakeHub();
    const meetings = createMeetingsFake(hub);
    play(hub, FIRST, '2026-10-04T09:00:00.000Z', [
      line(FIRST, 'a1', 1000, '2026-10-04T09:00:02.000Z'),
    ]);
    play(hub, THIRD, '2026-10-06T09:00:00.000Z', [
      line(THIRD, 'c1', 1000, '2026-10-06T09:00:02.000Z'),
    ]);
    play(hub, SECOND, '2026-10-05T09:00:00.000Z', [
      line(SECOND, 'b1', 1000, '2026-10-05T09:00:02.000Z'),
    ]);

    const listed = await meetings.listMeetings({ limit: 2 });
    expect(listed.map((meeting) => meeting.id)).toEqual([THIRD, SECOND]);
    expect(listed[0]).toEqual({
      id: THIRD,
      title: expect.any(String) as string,
      startedAt: '2026-10-06T09:00:00.000Z',
      endedAt: '2026-10-06T09:00:02.000Z',
    });
  });

  it('answers a meeting with its lines in transcript order, hidden ones left out', async () => {
    const hub = new FakeHub();
    const meetings = createMeetingsFake(hub);
    hub.emit(captureChannels.CaptureStatusChanged, recording(FIRST, '2026-10-06T09:00:00.000Z'));
    hub.emit(
      captureChannels.TranscriptSegment,
      line(FIRST, 'late', 5000, '2026-10-06T09:00:06.000Z'),
    );
    hub.emit(
      captureChannels.TranscriptSegment,
      line(FIRST, 'early', 1000, '2026-10-06T09:00:02.000Z', 'system'),
    );
    hub.emit(
      captureChannels.TranscriptSegment,
      line(FIRST, 'echo', 3000, '2026-10-06T09:00:04.000Z'),
    );
    const change = (
      segmentId: string,
      kind: TranscriptSegmentChange['change'],
      text: string,
    ): void => {
      hub.emit(captureChannels.TranscriptSegmentChanged, {
        meetingId: FIRST,
        segmentId,
        source: 'mic',
        change: kind,
        reason: 'echo',
        echoOf: 'early',
        text,
      } satisfies TranscriptSegmentChange);
    };
    change('echo', 'hidden', 'line echo');
    change('late', 'trimmed', 'what is left of the late line');

    const meeting = await meetings.getMeeting({ meetingId: FIRST });
    expect(meeting?.endedAt).toBeNull();
    expect(meeting?.segments.map((segment) => [segment.id, segment.text])).toEqual([
      ['early', 'line early'],
      ['late', 'what is left of the late line'],
    ]);

    change('echo', 'unhidden', 'line echo');
    const unhidden = await meetings.getMeeting({ meetingId: FIRST });
    expect(unhidden?.segments.map((segment) => segment.id)).toEqual(['early', 'echo', 'late']);
  });

  it('ends a meeting at its last line once main stops naming it', async () => {
    const hub = new FakeHub();
    const meetings = createMeetingsFake(hub);
    play(hub, FIRST, '2026-10-05T09:30:04.000Z', [
      line(FIRST, 'a1', 1000, '2026-10-05T09:30:06.000Z'),
      line(FIRST, 'a2', 190_000, '2026-10-05T09:33:16.000Z'),
    ]);
    await expect(meetings.getMeeting({ meetingId: FIRST })).resolves.toMatchObject({
      startedAt: '2026-10-05T09:30:04.000Z',
      endedAt: '2026-10-05T09:33:16.000Z',
    });
  });

  it('drops a meeting nobody spoke in once it stops, as main does at Stop', async () => {
    const hub = new FakeHub();
    const meetings = createMeetingsFake(hub);
    play(hub, FIRST, '2026-10-06T09:00:00.000Z', []);
    await expect(meetings.getMeeting({ meetingId: FIRST })).resolves.toBeNull();
    await expect(meetings.listMeetings({ limit: 30 })).resolves.toEqual([]);
  });

  it('answers null for a meeting this Mac never recorded', async () => {
    const meetings = createMeetingsFake(new FakeHub());
    await expect(meetings.getMeeting({ meetingId: SECOND })).resolves.toBeNull();
  });

  it('refuses a request main refuses, as a failed invoke rejects', async () => {
    const meetings = createMeetingsFake(new FakeHub());
    await expect(meetings.getMeeting({ meetingId: '../roger.sqlite' })).rejects.toThrow(
      "Error invoking remote method 'meetings:get'",
    );
    await expect(meetings.listMeetings({ limit: 0 })).rejects.toThrow(
      "Error invoking remote method 'meetings:list'",
    );
  });

  it('names the preview meetings as their fixtures do, any other one as main would', async () => {
    const hub = new FakeHub();
    const meetings = createMeetingsFake(hub);
    play(hub, PAST_MEETING.meetingId, PAST_MEETING.startedAt, [
      line(PAST_MEETING.meetingId, 'p1', 1000, PAST_MEETING.startedAt),
    ]);
    hub.emit(
      captureChannels.CaptureStatusChanged,
      recording(LIVE_CALL.meetingId, '2026-10-06T14:00:00.000Z'),
    );
    hub.emit(captureChannels.CaptureStatusChanged, idleCaptureStatus(UPLOADED));
    hub.emit(captureChannels.CaptureStatusChanged, recording(FIRST, '2026-10-06T09:05:00.000Z'));

    const titles = (await meetings.listMeetings({ limit: 30 })).map((meeting) => meeting.title);
    // LIVE_CALL ended with no line, so main dropped it. The new one is named from its start, in
    // the Mac's time zone, as main's defaultMeetingTitle does.
    expect(titles).toEqual([
      expect.stringMatching(/^Meeting \d{1,2} Oct 2026 \d\d:\d\d$/),
      PAST_MEETING.title,
    ]);
  });

  it('records a meeting the preview starts with New note', async () => {
    const hub = new FakeHub();
    const roger = createFakeRoger(hub);
    const started = await roger.startCapture();
    expect(started.meetingId).not.toBeNull();
    const listed = await roger.listMeetings({ limit: 30 });
    expect(listed.map((meeting) => meeting.id)).toEqual([started.meetingId]);
    await roger.stopCapture();
    // Nobody spoke: the preview has no speech-to-text, so the meeting goes at Stop, as in main.
    await expect(roger.listMeetings({ limit: 30 })).resolves.toEqual([]);
  });
});
