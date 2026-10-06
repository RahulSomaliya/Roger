import { describe, expect, it } from 'vitest';
import { type CaptureStatus, idleCaptureStatus } from '../../../shared/capture';
import { captureMeetingAfter, meetingPhase } from './captureMeeting';

const FIRST = '0b6f1c5e-3f7a-4c1e-9d2b-6a8e4f1d2c3b';
const SECOND = '7f3c2a10-5b6d-4e8f-9a1b-2c3d4e5f6a7b';
const IDLE = idleCaptureStatus({
  state: 'idle',
  pending: 0,
  rejected: 0,
  lastError: null,
  nextAttemptAt: null,
});

function recording(meetingId: string, startedAt: string | null): CaptureStatus {
  return { ...IDLE, phase: 'recording', meetingId, startedAt };
}

/** What main reports while the next recording starts: no meeting yet (CaptureService.getStatus). */
const STARTING: CaptureStatus = { ...IDLE, phase: 'starting' };

describe('captureMeetingAfter', () => {
  it('is null until a status names a meeting', () => {
    expect(captureMeetingAfter(null, null)).toBeNull();
    expect(captureMeetingAfter(null, IDLE)).toBeNull();
  });

  it('takes the meeting a status names, and keeps it after Stop, as the transcript stays', () => {
    const started = captureMeetingAfter(null, recording(FIRST, '2026-10-06T09:00:00.000Z'));
    expect(started).toEqual({ id: FIRST, startedAt: '2026-10-06T09:00:00.000Z' });
    expect(captureMeetingAfter(started, IDLE)).toBe(started);
  });

  it('keeps the stopped meeting while the next one starts, as main names none until it records', () => {
    const stopped = captureMeetingAfter(
      captureMeetingAfter(null, recording(FIRST, '2026-10-06T09:00:00.000Z')),
      IDLE,
    );
    expect(captureMeetingAfter(stopped, STARTING)).toBe(stopped);
  });

  it('returns the same object while the meeting is unchanged, so React can stop re-rendering', () => {
    const started = captureMeetingAfter(null, recording(FIRST, '2026-10-06T09:00:00.000Z'));
    expect(captureMeetingAfter(started, recording(FIRST, '2026-10-06T09:00:00.000Z'))).toBe(
      started,
    );
  });

  it('fills in the start time once main reports it', () => {
    const starting = captureMeetingAfter(null, recording(FIRST, null));
    expect(captureMeetingAfter(starting, recording(FIRST, '2026-10-06T09:00:00.000Z'))).toEqual({
      id: FIRST,
      startedAt: '2026-10-06T09:00:00.000Z',
    });
  });

  it('moves to the next meeting when one starts', () => {
    const first = captureMeetingAfter(null, recording(FIRST, '2026-10-06T09:00:00.000Z'));
    expect(captureMeetingAfter(first, recording(SECOND, '2026-10-06T10:00:00.000Z'))).toEqual({
      id: SECOND,
      startedAt: '2026-10-06T10:00:00.000Z',
    });
  });
});

describe('meetingPhase', () => {
  const first = captureMeetingAfter(null, recording(FIRST, '2026-10-06T09:00:00.000Z'));

  it("is main's phase for the meeting its status names", () => {
    expect(meetingPhase(first, recording(FIRST, '2026-10-06T09:00:00.000Z'))).toBe('recording');
    expect(
      meetingPhase(first, { ...recording(FIRST, '2026-10-06T09:00:00.000Z'), phase: 'stopping' }),
    ).toBe('stopping');
  });

  it('is idle for the meeting stopped last while the next one starts', () => {
    // Stop, then New note: the shell still points at the stopped meeting (its lines stay on
    // screen), but main's 'starting' is the next recording's, not this meeting's.
    const stopped = captureMeetingAfter(first, IDLE);
    const stillShown = captureMeetingAfter(stopped, STARTING);
    expect(meetingPhase(stillShown, STARTING)).toBe('idle');
  });

  it('is idle for a meeting the status does not name, and with no meeting or status yet', () => {
    expect(meetingPhase(first, recording(SECOND, '2026-10-06T10:00:00.000Z'))).toBe('idle');
    expect(meetingPhase(null, recording(FIRST, '2026-10-06T09:00:00.000Z'))).toBe('idle');
    expect(meetingPhase(first, null)).toBe('idle');
  });
});
