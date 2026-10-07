import { describe, expect, it, vi, type Mock } from 'vitest';
import type { TranscriptSegmentChange } from '../../../shared/capture';
import type { AudioSource, TranscriptSegment } from '../../../shared/transcript';
import type { MeetingDto, UploadApi } from '../../api/ApiClient';
import { createLogger } from '../../logger';
import { InMemoryTranscriptStore } from '../../store/InMemoryTranscriptStore';
import { SqliteTranscriptStore } from '../../store/SqliteTranscriptStore';
import type { SegmentOrigin, TranscriptStore } from '../../store/TranscriptStore';
import { TranscriptUploader } from '../../upload/TranscriptUploader';
import type { SourceWatermark, WatermarkListener } from '../CaptureSession';
import { ECHO_MATCH_WINDOW_MS } from './EchoFilter';
import {
  ECHO_HOLD_CAP_MS,
  type EchoCapture,
  type EchoRecordingListener,
  type EchoSession,
  EchoSink,
} from './EchoSink';
import { LatestRoute } from './RouteProvider';

const MEETING = '6f1d2b7e-8a4c-4f0e-9b1a-2c3d4e5f6a7b';
const OTHER_MEETING = '0e9d8c7b-6a5f-4e3d-8c1b-0a9f8e7d6c5b';
const T0 = Date.parse('2026-10-07T10:00:00.000Z');
const quiet = createLogger({ level: 'error', format: 'json', sink: () => undefined });

const SAID = 'so the plan is to ship on Friday';
const MIXED = 'yes I agree so the plan is to ship on Friday';

/** A final line whose words are 300 ms apart and 250 ms long, its span from first to last word. */
function line(
  id: string,
  source: AudioSource,
  text: string,
  startMs: number,
  createdAtMs: number,
): TranscriptSegment {
  const words = text.split(' ').map((word, index) => ({
    text: word,
    startMs: startMs + index * 300,
    endMs: startMs + index * 300 + 250,
    confidence: 0.9,
  }));
  return {
    id,
    meetingId: MEETING,
    source,
    speaker: source === 'mic' ? 'me' : 'them',
    startMs,
    endMs: words[words.length - 1]!.endMs,
    text,
    confidence: 0.9,
    words,
    createdAt: new Date(createdAtMs).toISOString(),
  };
}

/** CaptureSession as the sink sees it: a watermark per source, moved by the test. */
class FakeSession implements EchoSession {
  private readonly marks: Record<AudioSource, SourceWatermark> = {
    mic: { finalEndMs: null, closed: false },
    system: { finalEndMs: null, closed: false },
  };
  private readonly listeners = new Set<WatermarkListener>();

  watermark(source: AudioSource): SourceWatermark {
    return { ...this.marks[source] };
  }

  onWatermark(listener: WatermarkListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  move(source: AudioSource, mark: SourceWatermark): void {
    this.marks[source] = mark;
    for (const listener of [...this.listeners]) listener(source, { ...mark });
  }

  get watchers(): number {
    return this.listeners.size;
  }
}

/** CaptureService as the sink sees it: recordings, and each final line once it is stored. */
class FakeCapture implements EchoCapture {
  private readonly segmentListeners = new Set<(segment: TranscriptSegment) => void>();
  private readonly recordingListeners = new Set<EchoRecordingListener>();

  on(_event: 'segment', listener: (segment: TranscriptSegment) => void): () => void {
    this.segmentListeners.add(listener);
    return () => {
      this.segmentListeners.delete(listener);
    };
  }

  onRecording(listener: EchoRecordingListener): () => void {
    this.recordingListeners.add(listener);
    return () => {
      this.recordingListeners.delete(listener);
    };
  }

  start(meetingId: string, session: EchoSession): void {
    for (const listener of this.recordingListeners) listener.started?.({ meetingId, session });
  }

  end(meetingId: string): void {
    for (const listener of this.recordingListeners) listener.ended?.({ meetingId });
  }

  /** As CaptureSession does it: the line is stored, then it goes out. */
  final(store: TranscriptStore, segment: TranscriptSegment): void {
    store.appendSegment(segment);
    for (const listener of this.segmentListeners) listener(segment);
  }
}

interface FakeApi {
  createMeeting: Mock<UploadApi['createMeeting']>;
  appendSegments: Mock<UploadApi['appendSegments']>;
  endMeeting: Mock<UploadApi['endMeeting']>;
}

function meetingDto(id: string): MeetingDto {
  return {
    id,
    workspace_id: 'w1',
    title: 'Weekly sync',
    status: 'recording',
    started_at: new Date(T0).toISOString(),
    ended_at: null,
    segment_count: 0,
    start_source: 'manual',
    calendar_event: null,
    created_at: new Date(T0).toISOString(),
    updated_at: new Date(T0).toISOString(),
  };
}

function fakeApi(): FakeApi {
  return {
    createMeeting: vi.fn<UploadApi['createMeeting']>((input) =>
      Promise.resolve(meetingDto(input.id)),
    ),
    appendSegments: vi.fn<UploadApi['appendSegments']>((_meetingId, segments) =>
      Promise.resolve({ accepted: segments.length, duplicates: 0 }),
    ),
    endMeeting: vi.fn<UploadApi['endMeeting']>((meetingId) =>
      Promise.resolve(meetingDto(meetingId)),
    ),
  };
}

interface HarnessOptions {
  enabled?: boolean;
  /** The store, on the harness's clock (it decides whether a hold's cap has passed). */
  makeStore?: (clock: () => Date) => TranscriptStore;
}

function harness(options: HarnessOptions = {}) {
  let now = T0;
  const clock = (): Date => new Date(now);
  const store = options.makeStore?.(clock) ?? new InMemoryTranscriptStore(clock);
  store.createMeeting({ id: MEETING, title: 'Weekly sync', startedAt: new Date(T0).toISOString() });
  const changes: TranscriptSegmentChange[] = [];
  const logs: Record<string, unknown>[] = [];
  const route = new LatestRoute();
  const sink = new EchoSink({
    store,
    enabled: options.enabled ?? true,
    route,
    publishChange: (change) => changes.push(change),
    logger: createLogger({
      level: 'debug',
      format: 'json',
      sink: (entry) => logs.push(JSON.parse(entry) as Record<string, unknown>),
    }),
    clock: () => now,
  });
  const capture = new FakeCapture();
  sink.attach(capture);
  const session = new FakeSession();
  const api = fakeApi();
  // Built at T0, as main builds it before anything stores a line: its launchedAt is T0.
  const uploader = new TranscriptUploader({
    store,
    api,
    logger: quiet,
    clock,
  });
  return {
    store,
    sink,
    capture,
    session,
    route,
    changes,
    logs,
    api,
    uploader,
    advance(ms: number): void {
      now += ms;
    },
    record(): void {
      capture.start(MEETING, session);
    },
    /** A final line from the live recording, stored and sent out now. */
    say(id: string, source: AudioSource, text: string, startMs: number): TranscriptSegment {
      const segment = line(id, source, text, startMs, now);
      capture.final(store, segment);
      return segment;
    },
    /** As CaptureSession does after a call-audio line: the watermark moves past it. */
    callAudioUpTo(endMs: number): void {
      session.move('system', { finalEndMs: endMs, closed: false });
    },
    /** A line stored outside the live recording: an earlier run's, or a gap re-run's. */
    stored(
      id: string,
      source: AudioSource,
      text: string,
      startMs: number,
      createdAtMs: number,
      origin: SegmentOrigin = 'live',
    ): TranscriptSegment {
      const segment = line(id, source, text, startMs, createdAtMs);
      store.appendSegment(segment, origin);
      return segment;
    },
    /** Every line id the uploader sent, in order. */
    uploaded(): string[] {
      return api.appendSegments.mock.calls.flatMap(([, segments]) => segments.map((s) => s.id));
    },
  };
}

describe('EchoSink: lines from the live recording', () => {
  it('hides a mic line that repeats a call-audio line already stored, and never uploads it', async () => {
    const h = harness();
    h.record();
    const them = h.say('them-1', 'system', SAID, 10_000);
    h.callAudioUpTo(them.endMs);
    h.say('me-1', 'mic', SAID, 10_120);

    expect(h.store.getSegment('me-1')).toMatchObject({
      suppressedReason: 'echo',
      echoOf: 'them-1',
      uploadAfter: null,
    });
    expect(h.changes).toEqual([
      {
        meetingId: MEETING,
        segmentId: 'me-1',
        source: 'mic',
        change: 'hidden',
        reason: 'echo',
        echoOf: 'them-1',
        text: SAID,
      },
    ]);
    expect(h.sink.liveStatus(MEETING)).toEqual({ hidden: 1, trimmed: 0, held: 0 });

    await h.uploader.flush();
    expect(h.uploaded()).toEqual(['them-1']);
  });

  it('holds a mic line with other words until the call-audio watermark passes its end plus 700 ms', async () => {
    const h = harness();
    h.record();
    const me = h.say('me-1', 'mic', 'I think we should wait a week', 5_000);

    expect(h.store.getSegment('me-1')).toMatchObject({
      suppressedReason: null,
      uploadAfter: new Date(T0 + ECHO_HOLD_CAP_MS).toISOString(),
    });
    expect(h.sink.liveStatus(MEETING)).toEqual({ hidden: 0, trimmed: 0, held: 1 });
    await h.uploader.flush();
    expect(h.uploaded()).toEqual([]);

    h.callAudioUpTo(me.endMs + ECHO_MATCH_WINDOW_MS - 1);
    expect(h.store.getSegment('me-1')?.uploadAfter).not.toBeNull();

    h.callAudioUpTo(me.endMs + ECHO_MATCH_WINDOW_MS);
    expect(h.store.getSegment('me-1')?.uploadAfter).toBeNull();
    expect(h.sink.liveStatus(MEETING)).toEqual({ hidden: 0, trimmed: 0, held: 0 });
    await h.uploader.flush();
    expect(h.uploaded()).toEqual(['me-1']);
    expect(h.changes).toEqual([]);
  });

  it('trims the repeated run out of a mixed line, keeps the vendor text locally, and uploads the rest', async () => {
    const h = harness();
    h.record();
    const them = h.say('them-1', 'system', 'so the plan is to', 10_900);
    h.callAudioUpTo(them.endMs);
    const me = h.say('me-1', 'mic', MIXED, 10_000);

    expect(h.store.getSegment('me-1')).toMatchObject({
      text: 'yes I agree ship on Friday',
      originalText: MIXED,
      echoOf: 'them-1',
      suppressedReason: null,
    });
    expect(h.store.getSegment('me-1')?.words?.map((word) => word.text)).toEqual([
      'yes',
      'I',
      'agree',
      'ship',
      'on',
      'Friday',
    ]);
    expect(h.changes).toEqual([
      {
        meetingId: MEETING,
        segmentId: 'me-1',
        source: 'mic',
        change: 'trimmed',
        reason: 'echo',
        echoOf: 'them-1',
        text: 'yes I agree ship on Friday',
      },
    ]);
    // Trimmed lines still wait: a later call-audio line may repeat more of it.
    expect(h.sink.liveStatus(MEETING)).toEqual({ hidden: 0, trimmed: 1, held: 1 });

    h.callAudioUpTo(me.endMs + ECHO_MATCH_WINDOW_MS);
    await h.uploader.flush();
    // One batch, in start order: the mic line began first.
    expect(h.api.appendSegments.mock.calls[0]?.[1].map((segment) => segment.text)).toEqual([
      'yes I agree ship on Friday',
      'so the plan is to',
    ]);
  });

  it('hides a held mic line when its call-audio twin arrives after it, before it can upload', async () => {
    const h = harness();
    h.record();
    h.say('me-1', 'mic', SAID, 10_120);
    expect(h.store.getSegment('me-1')?.suppressedReason).toBeNull();
    await h.uploader.flush();
    expect(h.uploaded()).toEqual([]);

    const them = h.say('them-1', 'system', SAID, 10_000);
    h.callAudioUpTo(them.endMs);

    expect(h.store.getSegment('me-1')).toMatchObject({
      suppressedReason: 'echo',
      echoOf: 'them-1',
    });
    expect(h.changes.map((change) => change.change)).toEqual(['hidden']);
    await h.uploader.flush();
    expect(h.uploaded()).toEqual(['them-1']);
  });

  // CaptureSession's watermark never moves back: a stream retired with a finish (a stall, a
  // sleep) can still send its last line after the stream that replaced it has passed the spot.
  it('hides a released mic line when a late line of a replaced call-audio stream repeats it', async () => {
    const h = harness();
    h.record();
    h.say('me-1', 'mic', SAID, 10_120);
    h.callAudioUpTo(h.say('them-2', 'system', 'and the next item is hiring', 30_000).endMs);
    expect(h.store.getSegment('me-1')?.uploadAfter).toBeNull();

    h.say('them-1', 'system', SAID, 10_000);

    expect(h.store.getSegment('me-1')).toMatchObject({
      suppressedReason: 'echo',
      echoOf: 'them-1',
    });
    expect(h.changes.map(({ segmentId, change }) => [segmentId, change])).toEqual([
      ['me-1', 'hidden'],
    ]);
    await h.uploader.flush();
    expect(h.uploaded()).toEqual(['them-1', 'them-2']);
  });

  it('hides a mic line never held, stored once the watermark had passed it, when its twin comes late', async () => {
    const h = harness();
    h.record();
    h.callAudioUpTo(h.say('them-2', 'system', 'and the next item is hiring', 30_000).endMs);
    h.say('me-1', 'mic', SAID, 10_120);
    expect(h.store.getSegment('me-1')?.uploadAfter).toBeNull();

    h.say('them-1', 'system', SAID, 10_000);

    expect(h.store.getSegment('me-1')?.suppressedReason).toBe('echo');
    await h.uploader.flush();
    expect(h.uploaded()).toEqual(['them-1', 'them-2']);
  });

  it('leaves an uploaded mic line as Postgres has it when its twin comes after the upload', async () => {
    const h = harness();
    h.record();
    h.callAudioUpTo(h.say('them-2', 'system', 'and the next item is hiring', 30_000).endMs);
    h.say('me-1', 'mic', SAID, 10_120);
    await h.uploader.flush();
    expect(h.uploaded()).toEqual(['me-1', 'them-2']);

    h.say('them-1', 'system', SAID, 10_000);

    expect(h.store.getSegment('me-1')?.suppressedReason).toBeNull();
    expect(h.changes).toEqual([]);
  });

  it('never hides again a line the user showed again, nor tells the window twice of a hidden one', () => {
    const h = harness();
    h.record();
    h.callAudioUpTo(h.say('them-1', 'system', SAID, 10_000).endMs);
    h.say('me-1', 'mic', SAID, 10_120);
    h.say('me-2', 'mic', SAID, 40_120);
    h.say('them-3', 'system', SAID, 40_000);
    h.sink.unhide(h.store.getSegment('me-1')!);

    // More call audio near both lines: me-1 is the user's call now, me-2 is hidden already.
    h.say('them-2', 'system', SAID, 10_050);
    h.say('them-4', 'system', SAID, 40_050);

    expect(h.store.getSegment('me-1')?.suppressedReason).toBeNull();
    expect(h.changes.map(({ segmentId, change }) => [segmentId, change])).toEqual([
      ['me-1', 'hidden'],
      ['me-2', 'hidden'],
      ['me-1', 'unhidden'],
    ]);
  });

  it('re-decides a trimmed line on the words the vendor wrote, not on what the trim left', () => {
    const h = harness();
    h.record();
    h.callAudioUpTo(h.say('them-1', 'system', 'so the plan is to', 10_900).endMs);
    h.say('me-1', 'mic', MIXED, 10_000);
    expect(h.store.getSegment('me-1')?.text).toBe('yes I agree ship on Friday');

    // 8 of the 11 words the vendor wrote now repeat call audio: hidden. Judged on the 6 words
    // the trim left, only 3 would match, and "yes I agree ship on Friday" would lose "ship on
    // Friday" and go up as "yes I agree".
    h.say('them-2', 'system', 'ship on Friday', 12_400);

    expect(h.store.getSegment('me-1')).toMatchObject({
      suppressedReason: 'echo',
      echoOf: 'them-1',
      originalText: MIXED,
    });
    expect(h.changes.map(({ change, text }) => [change, text])).toEqual([
      ['trimmed', 'yes I agree ship on Friday'],
      ['hidden', 'yes I agree ship on Friday'],
    ]);
    expect(h.sink.liveStatus(MEETING)).toEqual({ hidden: 1, trimmed: 0, held: 0 });
  });

  it('keeps a mic line held while call audio reconnects, and releases it when that stream closes', async () => {
    const h = harness();
    h.record();
    h.say('me-1', 'mic', SAID, 10_120);
    // Call audio failed and is retrying: its watermark stays where it was, not closed.
    h.advance(30_000);
    h.session.move('system', { finalEndMs: null, closed: false });
    await h.uploader.flush();
    expect(h.uploaded()).toEqual([]);

    // The stall pause (or a source that ended) closes it: no twin can come any more.
    h.session.move('system', { finalEndMs: null, closed: true });
    expect(h.store.getSegment('me-1')?.uploadAfter).toBeNull();
    await h.uploader.flush();
    expect(h.uploaded()).toEqual(['me-1']);
  });

  it('lets a held line upload at its 120 s cap when call audio never catches up', async () => {
    const h = harness();
    h.record();
    h.say('me-1', 'mic', 'I think we should wait a week', 5_000);

    h.advance(ECHO_HOLD_CAP_MS - 1);
    expect(h.sink.liveStatus(MEETING)?.held).toBe(1);
    await h.uploader.flush();
    expect(h.uploaded()).toEqual([]);

    h.advance(1);
    expect(h.sink.liveStatus(MEETING)?.held).toBe(0);
    await h.uploader.flush();
    expect(h.uploaded()).toEqual(['me-1']);
  });

  it('does not hold a mic line when call audio can send no more lines', () => {
    const h = harness();
    h.record();
    h.session.move('system', { finalEndMs: 2_000, closed: true });
    h.say('me-1', 'mic', 'I think we should wait a week', 5_000);

    expect(h.store.getSegment('me-1')?.uploadAfter).toBeNull();
  });

  it('releases every held line at Stop, so the stop flush uploads it and ends the meeting', async () => {
    const h = harness();
    h.record();
    h.say('me-1', 'mic', 'I think we should wait a week', 5_000);
    h.store.markMeetingEnded(MEETING, new Date(T0 + 10_000).toISOString());
    h.capture.end(MEETING);

    expect(h.store.countHeldSegments(MEETING)).toBe(0);
    expect(h.session.watchers).toBe(0);
    expect(h.sink.liveStatus(MEETING)).toBeNull();
    await h.uploader.flush();
    expect(h.uploaded()).toEqual(['me-1']);
    expect(h.api.endMeeting).toHaveBeenCalledTimes(1);
  });

  it('leaves a line the uploader is sending as it was sent, even when its twin arrives meanwhile', async () => {
    const h = harness();
    h.record();
    h.say('me-1', 'mic', SAID, 10_120);
    h.advance(ECHO_HOLD_CAP_MS); // past its cap: the uploader may take it
    let answer: (() => void) | undefined;
    h.api.appendSegments.mockImplementationOnce(
      (_meetingId, segments) =>
        new Promise((resolve) => {
          answer = () => {
            resolve({ accepted: segments.length, duplicates: 0 });
          };
        }),
    );
    const flushing = h.uploader.flush();
    await vi.waitFor(() => {
      expect(h.api.appendSegments).toHaveBeenCalledTimes(1);
    });

    // Postgres may already hold it: hiding it here would leave the two disagreeing.
    h.say('them-1', 'system', SAID, 10_000);
    expect(h.store.getSegment('me-1')?.suppressedReason).toBeNull();
    expect(h.changes).toEqual([]);

    answer?.();
    await flushing;
    expect(h.store.getSegment('me-1')?.syncedAt).not.toBeNull();
    expect(h.sink.liveStatus(MEETING)?.held).toBe(0);
  });

  it('hides, trims and holds nothing behind known headphones', async () => {
    const h = harness();
    h.route.set('headphones');
    h.record();
    h.callAudioUpTo(h.say('them-1', 'system', SAID, 10_000).endMs);
    h.say('me-1', 'mic', SAID, 10_120);
    h.say('me-2', 'mic', 'I think we should wait a week', 15_000);

    expect(h.store.getSegment('me-1')).toMatchObject({ suppressedReason: null, uploadAfter: null });
    expect(h.store.getSegment('me-2')?.uploadAfter).toBeNull();
    expect(h.changes).toEqual([]);
    await h.uploader.flush();
    expect(h.uploaded()).toEqual(['them-1', 'me-1', 'me-2']);
  });

  it('hides, trims and holds nothing with echoFilter off in config.json', () => {
    const h = harness({ enabled: false });
    h.record();
    h.callAudioUpTo(h.say('them-1', 'system', SAID, 10_000).endMs);
    h.say('me-1', 'mic', SAID, 10_120);
    h.say('me-2', 'mic', 'I think we should wait a week', 15_000);

    expect(h.store.getSegment('me-1')).toMatchObject({ suppressedReason: null, uploadAfter: null });
    expect(h.store.getSegment('me-2')?.uploadAfter).toBeNull();
    expect(h.changes).toEqual([]);
  });

  it('logs a store that fails with the ids, never the text, and the line still goes out', () => {
    class FailingHolds extends InMemoryTranscriptStore {
      override holdSegment(): boolean {
        throw new Error('disk I/O error');
      }
    }
    const h = harness({ makeStore: (clock) => new FailingHolds(clock) });
    const seen: string[] = [];
    h.capture.on('segment', (segment) => seen.push(segment.id));
    h.record();

    expect(() => h.say('me-1', 'mic', 'I think we should wait a week', 5_000)).not.toThrow();
    expect(seen).toEqual(['me-1']);
    expect(h.logs.find((entry) => entry.level === 'error')).toMatchObject({
      meetingId: MEETING,
      segmentId: 'me-1',
      error: 'disk I/O error',
    });
    expect(JSON.stringify(h.logs)).not.toContain('wait a week');
  });
});

describe('EchoSink: counts', () => {
  it('counts the live meeting in the status, and any meeting from the store in its report', () => {
    const h = harness();
    h.record();
    h.callAudioUpTo(h.say('them-1', 'system', SAID, 10_000).endMs);
    h.say('me-1', 'mic', SAID, 10_120); // hidden
    h.callAudioUpTo(h.say('them-2', 'system', 'so the plan is to', 20_900).endMs);
    h.say('me-2', 'mic', MIXED, 20_000); // trimmed, held
    h.say('me-3', 'mic', 'I think we should wait a week', 40_000); // held

    const counts = { hidden: 1, trimmed: 1, held: 2 };
    expect(h.sink.liveStatus(MEETING)).toEqual(counts);
    expect(h.sink.report(MEETING)).toEqual(counts);
    expect(h.sink.liveStatus(OTHER_MEETING)).toBeNull();
    expect(h.sink.liveStatus(null)).toBeNull();

    h.capture.end(MEETING);
    expect(h.sink.liveStatus(MEETING)).toBeNull();
    expect(h.sink.report(MEETING)).toEqual({ hidden: 1, trimmed: 1, held: 0 });

    // A resume of the same meeting starts from what the store holds.
    h.capture.start(MEETING, new FakeSession());
    expect(h.sink.liveStatus(MEETING)).toEqual({ hidden: 1, trimmed: 1, held: 0 });
  });
});

describe('EchoSink on the SQLite store', () => {
  // The in-memory store is the SQL's twin, but holds are compared as text in SQL and the counts
  // list a whole meeting's lines with the widest offsets a number can carry.
  it('hides, trims, holds, releases and counts as it does in memory', async () => {
    const h = harness({ makeStore: (clock) => new SqliteTranscriptStore(':memory:', clock) });
    h.record();
    h.callAudioUpTo(h.say('them-1', 'system', SAID, 10_000).endMs);
    h.say('me-1', 'mic', SAID, 10_120); // hidden
    h.callAudioUpTo(h.say('them-2', 'system', 'so the plan is to', 20_900).endMs);
    h.say('me-2', 'mic', MIXED, 20_000); // trimmed, held
    h.say('me-3', 'mic', 'I think we should wait a week', 40_000); // held

    expect(h.sink.report(MEETING)).toEqual({ hidden: 1, trimmed: 1, held: 2 });
    await h.uploader.flush();
    expect(h.uploaded()).toEqual(['them-1', 'them-2']);

    h.advance(ECHO_HOLD_CAP_MS - 1);
    await h.uploader.flush();
    expect(h.uploaded()).toEqual(['them-1', 'them-2']);
    h.advance(1);
    expect(h.sink.report(MEETING).held).toBe(0);
    await h.uploader.flush();
    expect(h.uploaded()).toEqual(['them-1', 'them-2', 'me-2', 'me-3']);
    expect(h.store.getSegment('me-2')).toMatchObject({
      text: 'yes I agree ship on Friday',
      originalText: MIXED,
    });

    h.sink.unhide(h.store.getSegment('me-1')!);
    expect(h.sink.report(MEETING)).toEqual({ hidden: 0, trimmed: 1, held: 0 });
  });
});

describe('EchoSink.unhide', () => {
  it('shows a hidden line again, tells the window, and lets it upload', async () => {
    const h = harness();
    h.record();
    h.callAudioUpTo(h.say('them-1', 'system', SAID, 10_000).endMs);
    h.say('me-1', 'mic', SAID, 10_120);
    const hidden = h.store.getSegment('me-1')!;

    h.sink.unhide(hidden);

    expect(h.store.getSegment('me-1')).toMatchObject({ suppressedReason: null, echoOf: null });
    expect(h.changes.at(-1)).toEqual({
      meetingId: MEETING,
      segmentId: 'me-1',
      source: 'mic',
      change: 'unhidden',
      reason: 'echo',
      echoOf: null,
      text: SAID,
    });
    expect(h.sink.liveStatus(MEETING)).toEqual({ hidden: 0, trimmed: 0, held: 0 });
    await h.uploader.flush();
    expect(h.uploaded()).toEqual(['them-1', 'me-1']);

    expect(() => {
      h.sink.unhide(hidden);
    }).toThrow(`Line me-1 of meeting ${MEETING} is not hidden`);
  });
});

describe('EchoSink.settleAll', () => {
  /** An earlier run, a minute before this one was launched, left two mic lines held. */
  function leftHeld(h: ReturnType<typeof harness>): void {
    const earlier = T0 - 60_000;
    const cap = new Date(earlier + ECHO_HOLD_CAP_MS).toISOString();
    h.stored('them-1', 'system', SAID, 10_000, earlier);
    h.stored('me-1', 'mic', SAID, 10_120, earlier);
    h.store.holdSegment('me-1', cap);
    h.stored('me-2', 'mic', 'I think we should wait a week', 20_000, earlier);
    h.store.holdSegment('me-2', cap);
  }

  it("settles an earlier run's holds before the first upload, and never this run's", async () => {
    const h = harness();
    leftHeld(h);
    h.uploader.setBeforeFirstTick((launchedAt) => {
      h.sink.settleAll(launchedAt);
    });
    // A Start after launch holds a line of its own before the settle runs (a retried settle can).
    h.advance(5_000);
    h.record();
    h.say('me-3', 'mic', 'nothing like what they said', 30_000);

    await h.uploader.flush();

    expect(h.store.getSegment('me-1')).toMatchObject({
      suppressedReason: 'echo',
      echoOf: 'them-1',
    });
    expect(h.store.getSegment('me-2')?.uploadAfter).toBeNull();
    expect(h.store.getSegment('me-3')?.uploadAfter).not.toBeNull();
    expect(h.uploaded()).toEqual(['them-1', 'me-2']);
    expect(h.changes.map(({ segmentId, change }) => [segmentId, change])).toEqual([
      ['me-1', 'hidden'],
    ]);
    // The resumed meeting's count takes in the line the settle hid.
    expect(h.sink.liveStatus(MEETING)).toEqual({ hidden: 1, trimmed: 0, held: 1 });
  });

  it('only releases the holds left behind when echoFilter is off', () => {
    const h = harness({ enabled: false });
    leftHeld(h);

    h.sink.settleAll(new Date(T0).toISOString());

    expect(h.store.getSegment('me-1')).toMatchObject({ suppressedReason: null, uploadAfter: null });
    expect(h.store.getSegment('me-2')?.uploadAfter).toBeNull();
    expect(h.changes).toEqual([]);
  });

  it('refuses a launch instant that is not one', () => {
    expect(() => {
      harness().sink.settleAll('yesterday');
    }).toThrow('"yesterday" is not an instant');
  });
});

describe('EchoSink.filterStored', () => {
  it('filters re-run mic lines against the call-audio lines stored, and holds none', () => {
    const h = harness();
    h.stored('them-1', 'system', SAID, 10_000, T0);
    h.stored('them-2', 'system', 'so the plan is to', 20_900, T0);
    h.stored('me-1', 'mic', SAID, 10_120, T0, 'rerun');
    h.stored('me-2', 'mic', MIXED, 20_000, T0, 'rerun');
    h.stored('me-3', 'mic', 'I think we should wait a week', 40_000, T0, 'rerun');

    expect(h.sink.filterStored('me-1')).toBe('hidden');
    expect(h.sink.filterStored('me-2')).toBe('trimmed');
    expect(h.sink.filterStored('me-3')).toBe('kept');
    expect(h.sink.filterStored('them-1')).toBe('kept');

    expect(h.store.getSegment('me-1')).toMatchObject({ suppressedReason: 'echo', origin: 'rerun' });
    expect(h.store.getSegment('me-2')?.text).toBe('yes I agree ship on Friday');
    for (const id of ['me-1', 'me-2', 'me-3']) {
      expect(h.store.getSegment(id)?.uploadAfter).toBeNull();
    }
    expect(h.changes.map(({ segmentId, change }) => [segmentId, change])).toEqual([
      ['me-1', 'hidden'],
      ['me-2', 'trimmed'],
    ]);
  });

  it('keeps every re-run line with the filter off or behind headphones', () => {
    const off = harness({ enabled: false });
    off.stored('them-1', 'system', SAID, 10_000, T0);
    off.stored('me-1', 'mic', SAID, 10_120, T0, 'rerun');
    expect(off.sink.filterStored('me-1')).toBe('kept');

    const headphones = harness();
    headphones.route.set('headphones');
    headphones.stored('them-1', 'system', SAID, 10_000, T0);
    headphones.stored('me-1', 'mic', SAID, 10_120, T0, 'rerun');
    expect(headphones.sink.filterStored('me-1')).toBe('kept');
  });

  it('refuses a line that is not stored', () => {
    expect(() => harness().sink.filterStored('me-9')).toThrow('Line me-9 is not stored');
  });
});
