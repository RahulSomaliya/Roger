import { describe, expect, it } from 'vitest';
import type { CaptureReport, TranscriptSegmentChange } from '../../src/shared/capture';
import { IpcChannel } from '../../src/shared/ipc';
import { createCaptureFake } from './capture';
import { FakeHub } from './hub';

const MEETING = '2f1d9c4e-8a3b-4c5d-9e6f-7a8b9c0d1e2f';
const SEGMENT = '6b7c8d9e-0f1a-4b2c-8d3e-4f5a6b7c8d9e';

const hidden: TranscriptSegmentChange = {
  meetingId: MEETING,
  segmentId: SEGMENT,
  source: 'mic',
  change: 'hidden',
  reason: 'echo',
  echoOf: 'c0ffee00-1111-4222-8333-444455556666',
  text: 'we ship on Friday',
};

const seeded: CaptureReport = {
  meetingId: MEETING,
  stopReason: 'user',
  gaps: [
    {
      id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
      source: 'system',
      startMs: 61_000,
      endMs: 91_000,
      reason: 'offline',
      recoveredAt: null,
      recoverError: null,
    },
  ],
  events: [],
  echo: { hidden: 1, trimmed: 0, held: 0 },
  backup: {
    state: 'kept',
    bytes: 4_300_000,
    keepUntil: '2026-10-13T10:00:00.000Z',
    keptForRerun: true,
    message: null,
  },
};

describe('the preview capture fake', () => {
  it('answers an empty report for a meeting no scenario described', async () => {
    const capture = createCaptureFake(new FakeHub());
    await expect(capture.getCaptureReport({ meetingId: MEETING })).resolves.toEqual({
      meetingId: MEETING,
      stopReason: null,
      gaps: [],
      events: [],
      echo: { hidden: 0, trimmed: 0, held: 0 },
      backup: { state: 'off', bytes: 0, keepUntil: null, keptForRerun: false, message: null },
    });
  });

  it('answers the report a scenario seeded, and re-runs and deletes against it', async () => {
    const hub = new FakeHub();
    const capture = createCaptureFake(hub);
    hub.emit(IpcChannel.CaptureGetReport, seeded);
    await expect(capture.getCaptureReport({ meetingId: MEETING })).resolves.toEqual(seeded);

    const rerun = await capture.rerunGaps({ meetingId: MEETING });
    expect(rerun.gaps[0]?.recoveredAt).toEqual(expect.any(String));
    expect(rerun.backup.keptForRerun).toBe(false);

    const deleted = await capture.deleteMeetingAudio({ meetingId: MEETING });
    expect(deleted.backup).toEqual({
      state: 'deleted',
      bytes: 0,
      keepUntil: null,
      keptForRerun: false,
      message: null,
    });
    await expect(capture.getCaptureReport({ meetingId: MEETING })).resolves.toEqual(deleted);
  });

  it('unhides a line a scenario hid, with the unhidden event main would send', async () => {
    const hub = new FakeHub();
    const capture = createCaptureFake(hub);
    const seen: TranscriptSegmentChange[] = [];
    capture.onTranscriptSegmentChanged((change) => seen.push(change));
    hub.emit(IpcChannel.TranscriptSegmentChanged, hidden);

    await capture.unhideSegment({ meetingId: MEETING, segmentId: SEGMENT });
    expect(seen).toEqual([hidden, { ...hidden, change: 'unhidden', echoOf: null }]);
  });

  it('refuses to unhide a line it never saw hidden, as main would', async () => {
    const capture = createCaptureFake(new FakeHub());
    await expect(capture.unhideSegment({ meetingId: MEETING, segmentId: SEGMENT })).rejects.toThrow(
      `no hidden line ${SEGMENT}`,
    );
  });
});
