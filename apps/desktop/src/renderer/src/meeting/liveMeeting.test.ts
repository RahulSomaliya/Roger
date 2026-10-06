import { describe, expect, it } from 'vitest';
import { type CaptureStatus, idleCaptureStatus } from '../../../shared/capture';
import type { CaptureMeeting } from '../app/captureMeeting';
import { captureStatusFor } from './liveMeeting';

const SHOWN = '0b6f1c5e-3f7a-4c1e-9d2b-6a8e4f1d2c3b';
const OTHER = '7f3c2a10-5b6d-4e8f-9a1b-2c3d4e5f6a7b';
const IDLE = idleCaptureStatus({
  state: 'idle',
  pending: 0,
  rejected: 0,
  lastError: null,
  nextAttemptAt: null,
});
const SHOWN_MEETING: CaptureMeeting = { id: SHOWN, startedAt: '2026-10-06T09:00:00.000Z' };
const METER = {
  vendorName: 'AssemblyAI',
  total: { sessionsOpened: 2, connectedMs: 60_000, audioSentMs: 60_000, estimatedCostUsd: 0.005 },
  sources: {
    mic: { sessionsOpened: 1, connectedMs: 30_000, audioSentMs: 30_000, estimatedCostUsd: 0.0025 },
    system: {
      sessionsOpened: 1,
      connectedMs: 30_000,
      audioSentMs: 30_000,
      estimatedCostUsd: 0.0025,
    },
  },
};

function named(meetingId: string, phase: CaptureStatus['phase']): CaptureStatus {
  return { ...IDLE, phase, meetingId, startedAt: '2026-10-06T09:00:00.000Z' };
}

describe('captureStatusFor', () => {
  it("is main's status while it names the meeting", () => {
    const status = named(SHOWN, 'recording');
    expect(captureStatusFor(SHOWN, SHOWN_MEETING, status)).toBe(status);
    const stopping = named(SHOWN, 'stopping');
    expect(captureStatusFor(SHOWN, SHOWN_MEETING, stopping)).toBe(stopping);
  });

  it('is the status after its Stop, with the meter main keeps, until another recording starts', () => {
    const stopped: CaptureStatus = { ...IDLE, meter: METER };
    expect(captureStatusFor(SHOWN, SHOWN_MEETING, stopped)).toBe(stopped);
  });

  it("is nothing while the next recording starts: main's status is that one's", () => {
    // New note after Stop: main says starting and names no meeting until it records, while the
    // shell still points at the meeting stopped last. Its panel must not read "connected".
    expect(captureStatusFor(SHOWN, SHOWN_MEETING, { ...IDLE, phase: 'starting' })).toBeNull();
  });

  it('is nothing for a meeting the capture view does not describe', () => {
    expect(captureStatusFor(OTHER, SHOWN_MEETING, named(SHOWN, 'recording'))).toBeNull();
    expect(captureStatusFor(OTHER, SHOWN_MEETING, IDLE)).toBeNull();
    expect(captureStatusFor(SHOWN, null, IDLE)).toBeNull();
    expect(captureStatusFor(SHOWN, SHOWN_MEETING, null)).toBeNull();
  });
});
