import { describe, expect, it } from 'vitest';
import { type CaptureStatus, idleCaptureStatus } from '../../../shared/capture';
import { recentMeetingsKey } from './recentMeetingsKey';

const W = '3e8a1c52-6d0f-4b7e-a913-c4f2d8e05b61';
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

describe('recentMeetingsKey', () => {
  it("stays the same over main's idle heartbeat, whatever the upload says", () => {
    const before = recentMeetingsKey(idle(), X);
    expect(recentMeetingsKey(idle(), X)).toBe(before);
    expect(recentMeetingsKey(idle(3), X)).toBe(before);
    expect(recentMeetingsKey(null, null)).toBe(recentMeetingsKey(idle(), null));
  });

  it('changes when a recording starts, and not again while it records', () => {
    const before = recentMeetingsKey(idle(), null);
    const started = recentMeetingsKey(live(X), X);
    expect(started).not.toBe(before);
    expect(recentMeetingsKey(live(X), X)).toBe(started);
    expect(recentMeetingsKey(live(X, 'stopping'), X)).toBe(started);
  });

  it('changes when Stop ends a recording, whether anyone spoke or not', () => {
    // Someone spoke: main ends the meeting, and the list shows its end.
    expect(recentMeetingsKey(idle(), X)).not.toBe(recentMeetingsKey(live(X), X));
    // Nobody spoke: main deletes the meeting, and the list must drop it.
    expect(recentMeetingsKey(idle(), Y)).not.toBe(recentMeetingsKey(live(Y), Y));
  });

  it('changes for a whole recording React renders at once', () => {
    // The preview's scenarios send `recording` then `idle` in one task, so the list renders idle
    // before and after. useCapture saw the status that named the meeting, rendered or not.
    expect(recentMeetingsKey(idle(), X)).not.toBe(recentMeetingsKey(idle(), W));
    expect(recentMeetingsKey(idle(), X)).not.toBe(recentMeetingsKey(idle(), null));
  });
});
