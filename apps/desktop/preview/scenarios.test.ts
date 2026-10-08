import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CaptureStatus } from '../src/shared/capture';
import type { InterimTranscript, TranscriptSegment } from '../src/shared/transcript';
import { PreviewHub } from './control';
import { createFakeRoger } from './fakeRoger';
import {
  LIVE_CALL,
  LIVE_CALL_FIRST_LINES,
  LIVE_LINE_INTERVAL_MS,
  PAST_MEETING,
  SCENARIOS,
  type ScenarioId,
  segmentIdForLine,
} from './scenarios';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A scenario started on a fresh hub, with everything it sent to the renderer recorded. */
function run(id: ScenarioId) {
  const hub = new PreviewHub();
  const roger = createFakeRoger(hub);
  const segments: TranscriptSegment[] = [];
  const statuses: CaptureStatus[] = [];
  const interims: InterimTranscript[] = [];
  roger.onTranscriptSegment((segment) => segments.push(segment));
  roger.onCaptureStatus((status) => statuses.push(status));
  roger.onTranscriptInterim((interim) => interims.push(interim));
  const stop = SCENARIOS[id].start({ hub, roger });
  return { hub, roger, segments, statuses, interims, stop };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('preview scenarios', () => {
  it('the live scenario adds a line every 200 ms', () => {
    vi.useFakeTimers();
    const live = run('live-call');
    expect(LIVE_LINE_INTERVAL_MS).toBe(200);
    expect(live.segments).toHaveLength(LIVE_CALL_FIRST_LINES);
    expect(LIVE_CALL_FIRST_LINES).toBe(500);

    vi.advanceTimersByTime(199);
    expect(live.segments).toHaveLength(500);
    vi.advanceTimersByTime(1);
    expect(live.segments).toHaveLength(501);
    vi.advanceTimersByTime(1_000);
    expect(live.segments).toHaveLength(506);

    // Main sends a status with every final line; the call is still recording, every line counted.
    expect(live.statuses.at(-1)).toMatchObject({
      phase: 'recording',
      meetingId: LIVE_CALL.meetingId,
      segmentsStored: 506,
      streams: { mic: 'open', system: 'open' },
    });
    // The next line shows as an interim before it is final.
    expect(live.interims.at(-1)?.meetingId).toBe(LIVE_CALL.meetingId);

    live.stop();
    vi.advanceTimersByTime(1_000);
    expect(live.segments).toHaveLength(506);
  });

  it('the offline scenario fails API calls with an ApiError', async () => {
    const offline = run('api-offline');

    // A request main answers from the Roger API rejects the way ipcRenderer.invoke does when the
    // handler throws main's ApiError: a plain Error whose text names the class, never an instance.
    const vocabulary = offline.hub.request('vocabulary:get', () => ['Linkt']);
    await expect(vocabulary).rejects.toThrow(
      "Error invoking remote method 'vocabulary:get': ApiError: vocabulary:get failed: connect ECONNREFUSED 127.0.0.1:8000",
    );

    // Start asks the API for a speech-to-text token first: main reports that ApiError in the status,
    // in plain words, with the request's text kept for Details.
    await expect(offline.roger.startCapture()).resolves.toMatchObject({
      phase: 'idle',
      error:
        'Roger could not reach its server, so notes did not start. Check the Mac is online, then Start notes again.',
      errorDetail: 'POST /v1/stt/token failed: connect ECONNREFUSED 127.0.0.1:8000',
    });

    // The meeting recorded while offline waits on this Mac, and the uploader says why.
    const status = await offline.roger.getCaptureStatus();
    expect(status.upload).toMatchObject({
      state: 'backoff',
      pending: PAST_MEETING.lines.length,
      lastError: 'POST /v1/meetings failed: connect ECONNREFUSED 127.0.0.1:8000',
    });
    expect(offline.segments).toHaveLength(PAST_MEETING.lines.length);
  });

  it('the live scenario stops adding lines once capture stops', async () => {
    vi.useFakeTimers();
    const live = run('live-call');
    await live.roger.stopCapture();
    vi.advanceTimersByTime(1_000);
    expect(live.segments).toHaveLength(LIVE_CALL_FIRST_LINES);
    expect(live.statuses.at(-1)?.phase).toBe('idle');
  });

  it('the past meeting scenario leaves the finished meeting on screen', async () => {
    const past = run('past-meeting');
    expect(past.segments.map((segment) => segment.text)).toEqual(
      PAST_MEETING.lines.map((line) => line.text),
    );
    expect(past.segments.every((segment) => segment.meetingId === PAST_MEETING.meetingId)).toBe(
      true,
    );
    // As after Stop: idle, everything uploaded, and the meeting's meter kept.
    const status = await past.roger.getCaptureStatus();
    expect(status).toMatchObject({ phase: 'idle', meetingId: null, upload: { state: 'idle' } });
    expect(status.meter?.total.sessionsOpened).toBe(
      PAST_MEETING.meter.sources.mic.sessionsOpened +
        PAST_MEETING.meter.sources.system.sessionsOpened,
    );
    expect(past.statuses[0]).toMatchObject({
      phase: 'recording',
      meetingId: PAST_MEETING.meetingId,
      startedAt: PAST_MEETING.startedAt,
    });
  });

  it('the empty Mac scenario sends nothing', async () => {
    const empty = run('empty-mac');
    expect([...empty.segments, ...empty.statuses, ...empty.interims]).toEqual([]);
    await expect(empty.roger.getCaptureStatus()).resolves.toMatchObject({
      phase: 'idle',
      meter: null,
      upload: { state: 'idle', pending: 0 },
    });
  });

  it('gives every line its own UUIDv4 id and runs each meeting forward in time', () => {
    vi.useFakeTimers();
    for (const id of ['past-meeting', 'live-call'] as const) {
      const { segments } = run(id);
      const ids = new Set(segments.map((segment) => segment.id));
      expect(ids.size).toBe(segments.length);
      expect([...ids].every((segmentId) => UUID_V4.test(segmentId))).toBe(true);
      for (const [index, segment] of segments.entries()) {
        expect(segment.endMs).toBeGreaterThan(segment.startMs);
        expect(segment.startMs).toBeGreaterThan(segments[index - 1]?.endMs ?? -1);
        expect(segment.speaker).toBe(segment.source === 'mic' ? 'me' : 'them');
      }
    }
  });

  it('names line N of a meeting by a stable id, so a QA script can cite it', () => {
    vi.useFakeTimers();
    const { segments } = run('live-call');
    expect(segments[39]?.id).toBe(segmentIdForLine(LIVE_CALL.meetingId, 40));
    expect(segmentIdForLine(LIVE_CALL.meetingId, 40)).toMatch(UUID_V4);
    expect(() => segmentIdForLine(LIVE_CALL.meetingId, 0)).toThrow('line 0');
  });
});
