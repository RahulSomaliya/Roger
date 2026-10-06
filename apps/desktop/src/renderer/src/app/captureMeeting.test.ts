import { describe, expect, it } from 'vitest';
import { type CaptureStatus, idleCaptureStatus } from '../../../shared/capture';
import { captureMeetingAfter } from './captureMeeting';

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
