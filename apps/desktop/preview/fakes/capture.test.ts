import { describe, expect, it } from 'vitest';
import type {
  CaptureReport,
  CaptureStatus,
  StartCaptureRequest,
  TranscriptSegmentChange,
} from '../../src/shared/capture';
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

  // Main's store unhides only a line with `suppressed_reason` set, and a trim never sets it: a
  // trimmed line already uploads, so an Unhide on it would work here and do nothing in the app.
  it('refuses to unhide a line that was only trimmed, as main would', async () => {
    const hub = new FakeHub();
    const capture = createCaptureFake(hub);
    const seen: TranscriptSegmentChange[] = [];
    capture.onTranscriptSegmentChanged((change) => seen.push(change));
    const trimmed: TranscriptSegmentChange = { ...hidden, change: 'trimmed', text: 'we ship' };
    hub.emit(IpcChannel.TranscriptSegmentChanged, trimmed);

    await expect(capture.unhideSegment({ meetingId: MEETING, segmentId: SEGMENT })).rejects.toThrow(
      `no hidden line ${SEGMENT}`,
    );
    expect(seen).toEqual([trimmed]);
  });

  it('keeps a hidden line hidden through a trim, and unhides it as trimmed', async () => {
    const hub = new FakeHub();
    const capture = createCaptureFake(hub);
    const seen: TranscriptSegmentChange[] = [];
    capture.onTranscriptSegmentChanged((change) => seen.push(change));
    const trimmed: TranscriptSegmentChange = { ...hidden, change: 'trimmed', text: 'we ship' };
    hub.emit(IpcChannel.TranscriptSegmentChanged, hidden);
    hub.emit(IpcChannel.TranscriptSegmentChanged, trimmed);

    await capture.unhideSegment({ meetingId: MEETING, segmentId: SEGMENT });
    expect(seen.at(-1)).toEqual({ ...hidden, change: 'unhidden', echoOf: null, text: 'we ship' });
  });

  it('refuses a second unhide of the same line', async () => {
    const hub = new FakeHub();
    const capture = createCaptureFake(hub);
    hub.emit(IpcChannel.TranscriptSegmentChanged, hidden);
    await capture.unhideSegment({ meetingId: MEETING, segmentId: SEGMENT });

    await expect(capture.unhideSegment({ meetingId: MEETING, segmentId: SEGMENT })).rejects.toThrow(
      `no hidden line ${SEGMENT}`,
    );
  });
});

describe('the preview capture fake and start requests (M5)', () => {
  it('records under the title a start request names', async () => {
    const capture = createCaptureFake(new FakeHub());
    await expect(
      capture.startCapture({ source: 'notification', title: 'Standup' }),
    ).resolves.toMatchObject({ phase: 'recording', title: 'Standup' });
    await expect(capture.stopCapture()).resolves.toMatchObject({ phase: 'idle', title: null });
    const plain: CaptureStatus = await capture.startCapture();
    expect(plain.title).toEqual(expect.any(String));
  });

  // As main's requestStart: the page hears the nudge and takes the request, once.
  it("hands a scenario's start request to the page once", async () => {
    const hub = new FakeHub();
    const capture = createCaptureFake(hub);
    const request: StartCaptureRequest = { source: 'notification', title: 'Standup' };
    let told = 0;
    capture.onStartRequested(() => {
      told += 1;
    });
    await expect(capture.takePendingStart()).resolves.toBeNull();
    hub.emit(IpcChannel.CaptureStartRequested, request);
    expect(told).toBe(1);
    await expect(capture.takePendingStart()).resolves.toEqual(request);
    await expect(capture.takePendingStart()).resolves.toBeNull();
  });
});
