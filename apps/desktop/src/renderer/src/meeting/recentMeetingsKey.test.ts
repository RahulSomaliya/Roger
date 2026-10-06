import { describe, expect, it } from 'vitest';
import { type CaptureStatus, idleCaptureStatus } from '../../../shared/capture';
import type { TranscriptSegment } from '../../../shared/transcript';
import { recentMeetingsKey } from './recentMeetingsKey';

const X = '5c1d7a4e-2f3b-4c8a-9e61-0d2b7f4a9c13';
const Y = '9b2e6f10-7c4d-4a5b-8e3f-61a0c2d9e874';

/** An idle status as main sends it after each uploader pass, every 2 s. */
function idle(pending = 0): CaptureStatus {
  return idleCaptureStatus({
    state: 'idle',
    pending,
    rejected: 0,
    lastError: null,
    nextAttemptAt: null,
  });
}

function live(meetingId: string, phase: CaptureStatus['phase'] = 'recording'): CaptureStatus {
  return { ...idle(), phase, meetingId, startedAt: '2026-10-06T09:00:00.000Z' };
}

function line(meetingId: string, id: string): TranscriptSegment {
  return {
    id,
    meetingId,
    source: 'mic',
    speaker: 'me',
    startMs: 1200,
    endMs: 2400,
    text: 'Shall we start?',
    confidence: 0.9,
    words: null,
    createdAt: '2026-10-06T09:00:02.000Z',
  };
}

describe('recentMeetingsKey', () => {
  it("stays the same over main's idle heartbeat, whatever the upload says", () => {
    const before = recentMeetingsKey(idle(), [line(X, 'x1')]);
    expect(recentMeetingsKey(idle(), [line(X, 'x1')])).toBe(before);
    expect(recentMeetingsKey(idle(3), [line(X, 'x1')])).toBe(before);
    expect(recentMeetingsKey(null, [])).toBe(recentMeetingsKey(idle(), []));
  });

  it('changes when a recording starts, and not again while it records', () => {
    const before = recentMeetingsKey(idle(), []);
    const started = recentMeetingsKey(live(X), []);
    expect(started).not.toBe(before);
    expect(recentMeetingsKey(live(X), [line(X, 'x1'), line(X, 'x2')])).toBe(started);
    expect(recentMeetingsKey(live(X, 'stopping'), [line(X, 'x1')])).toBe(started);
  });

  it('changes when Stop ends a recording, lines or none', () => {
    expect(recentMeetingsKey(idle(), [line(X, 'x1')])).not.toBe(
      recentMeetingsKey(live(X), [line(X, 'x1')]),
    );
    // Nobody spoke: main deletes the meeting, and the list must drop it.
    expect(recentMeetingsKey(idle(), [])).not.toBe(recentMeetingsKey(live(Y), []));
  });

  it('changes for a whole recording React renders at once, when main keeps that meeting', () => {
    // The preview's scenarios send `recording` then `idle` in one task, so the list renders idle
    // before and after. Main keeps only a meeting someone spoke in, and its lines reach the view.
    const before = recentMeetingsKey(idle(), [line(X, 'x1')]);
    expect(recentMeetingsKey(idle(), [line(Y, 'y1')])).not.toBe(before);
  });
});
