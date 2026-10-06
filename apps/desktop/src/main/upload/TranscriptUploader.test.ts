import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { MeetingCalendarEvent } from '../../shared/calendar';
import type { TranscriptSegment } from '../../shared/transcript';
import { ApiError, type MeetingDto, type UploadApi } from '../api/ApiClient';
import { createLogger } from '../logger';
import { InMemoryTranscriptStore } from '../store/InMemoryTranscriptStore';
import { SqliteTranscriptStore } from '../store/SqliteTranscriptStore';
import type { TranscriptStore } from '../store/TranscriptStore';
import { TranscriptUploader } from './TranscriptUploader';

const logger = createLogger({ level: 'error', format: 'json', sink: () => undefined });

function segment(meetingId: string, n: number): TranscriptSegment {
  return {
    id: `${meetingId}-seg-${n}`,
    meetingId,
    source: n % 2 === 0 ? 'mic' : 'system',
    speaker: n % 2 === 0 ? 'me' : 'them',
    startMs: n * 1000,
    endMs: n * 1000 + 500,
    text: `line ${n}`,
    confidence: null,
    words: null,
    createdAt: '2026-10-05T10:00:00.000Z',
  };
}

function meetingDto(id: string): MeetingDto {
  return {
    id,
    workspace_id: 'w1',
    title: 'T',
    status: 'recording',
    started_at: '2026-10-05T10:00:00Z',
    ended_at: null,
    segment_count: 0,
    start_source: 'manual',
    calendar_event: null,
    created_at: '2026-10-05T10:00:00Z',
    updated_at: '2026-10-05T10:00:00Z',
  };
}

/** Typed by the uploader's own view of the API, so no cast is needed to pass it in. */
interface FakeApi {
  createMeeting: Mock<UploadApi['createMeeting']>;
  appendSegments: Mock<UploadApi['appendSegments']>;
  endMeeting: Mock<UploadApi['endMeeting']>;
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

/** A store whose meeting listing fails the first `times` calls, like SQLite busy past its timeout. */
class FlakyStore extends InMemoryTranscriptStore {
  constructor(private times: number) {
    super();
  }
  override listMeetingsNeedingSync() {
    if (this.times > 0) {
      this.times -= 1;
      throw new Error('database is locked');
    }
    return super.listMeetingsNeedingSync();
  }
}

/**
 * A store that throws on every call while failing, the counts the status reads included, like a
 * SQLite file closed at quit, corrupt or hitting I/O errors ('database is not open').
 */
function failingStore(): { store: InMemoryTranscriptStore; setFailing: (on: boolean) => void } {
  let failing = false;
  const store = new Proxy(new InMemoryTranscriptStore(), {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (!failing || typeof value !== 'function') return value;
      return () => {
        throw new Error('database is not open');
      };
    },
  });
  return {
    store,
    setFailing: (on) => {
      failing = on;
    },
  };
}

describe('TranscriptUploader', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates the meeting, uploads lines in batches in order, then ends the meeting', async () => {
    const store = new InMemoryTranscriptStore();
    const api = fakeApi();
    store.createMeeting({ id: 'm1', title: 'T', startedAt: '2026-10-05T10:00:00Z' });
    for (let n = 0; n < 5; n += 1) store.appendSegment(segment('m1', n));
    store.markMeetingEnded('m1', '2026-10-05T10:30:00Z');

    const uploader = new TranscriptUploader({ store, api, logger, batchSize: 2 });
    await uploader.flush();

    expect(api.createMeeting).toHaveBeenCalledWith({
      id: 'm1',
      title: 'T',
      startedAt: '2026-10-05T10:00:00Z',
      startSource: 'manual',
      calendarEvent: null,
    });
    expect(api.appendSegments).toHaveBeenCalledTimes(3);
    expect(api.appendSegments.mock.calls.map((call) => call[1].map((s) => s.id))).toEqual([
      ['m1-seg-0', 'm1-seg-1'],
      ['m1-seg-2', 'm1-seg-3'],
      ['m1-seg-4'],
    ]);
    expect(api.endMeeting).toHaveBeenCalledWith('m1', '2026-10-05T10:30:00Z');
    expect(store.getMeeting('m1')?.remoteState).toBe('ended');
    expect(store.countUnsyncedSegments()).toBe(0);
    expect(uploader.getStatus()).toMatchObject({ state: 'idle', pending: 0, lastError: null });
  });

  // The exit check counts meetings in Postgres whose start_source is `notification` and that carry
  // their event: both come from the create, and a meeting is created once only.
  it('creates a meeting with how it started and its calendar event, as roger.sqlite keeps them', async () => {
    const store = new SqliteTranscriptStore(':memory:');
    const api = fakeApi();
    const event = {
      provider: 'google',
      eventId: 'standup_20261007T093000Z',
      icalUid: null,
      recurringEventId: 'standup',
      scheduledStart: '2026-10-07T09:30:00.000Z',
      scheduledEnd: '2026-10-07T09:45:00.000Z',
      attendees: [
        {
          email: 'jane@linkt.ai',
          displayName: null,
          responseStatus: 'accepted',
          isSelf: false,
          isOrganizer: true,
        },
      ],
    } as const satisfies MeetingCalendarEvent;
    store.createMeeting({
      id: 'm1',
      title: 'Standup',
      startedAt: '2026-10-07T09:31:00.000Z',
      startSource: 'notification',
      calendarEvent: event,
    });
    store.appendSegment(segment('m1', 0));

    await new TranscriptUploader({ store, api, logger }).flush();

    expect(api.createMeeting).toHaveBeenCalledWith({
      id: 'm1',
      title: 'Standup',
      startedAt: '2026-10-07T09:31:00.000Z',
      startSource: 'notification',
      calendarEvent: event,
    });
    store.close();
  });

  it('keeps lines local and backs off when the API is down, then recovers', async () => {
    const store = new InMemoryTranscriptStore();
    const api = fakeApi();
    api.createMeeting.mockRejectedValueOnce(new ApiError(0, 'network_error', 'down'));
    store.createMeeting({ id: 'm1', title: 'T', startedAt: '2026-10-05T10:00:00Z' });
    store.appendSegment(segment('m1', 0));

    const uploader = new TranscriptUploader({
      store,
      api,
      logger,
      intervalMs: 1000,
      baseBackoffMs: 500,
    });
    const statuses: string[] = [];
    uploader.onStatus((status) => statuses.push(status.state));
    uploader.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(uploader.getStatus()).toMatchObject({ state: 'backoff', pending: 1, lastError: 'down' });
    expect(api.appendSegments).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(api.createMeeting).toHaveBeenCalledTimes(2);
    expect(api.appendSegments).toHaveBeenCalledTimes(1);
    expect(uploader.getStatus()).toMatchObject({ state: 'idle', pending: 0 });
    expect(statuses).toContain('backoff');
    uploader.stop();
  });

  it('does not end a meeting remotely while lines are still pending, and recreates a meeting the API lost', async () => {
    const store = new InMemoryTranscriptStore();
    const api = fakeApi();
    store.createMeeting({ id: 'm1', title: 'T', startedAt: '2026-10-05T10:00:00Z' });
    store.setMeetingRemoteState('m1', 'created');
    store.appendSegment(segment('m1', 0));
    store.markMeetingEnded('m1', '2026-10-05T10:30:00Z');
    api.appendSegments.mockRejectedValueOnce(new ApiError(404, 'not_found', 'gone'));

    const uploader = new TranscriptUploader({ store, api, logger });
    await expect(uploader.flush()).rejects.toBeInstanceOf(ApiError);
    expect(api.endMeeting).not.toHaveBeenCalled();
    expect(store.getMeeting('m1')?.remoteState).toBe('pending');

    await uploader.flush();
    expect(api.createMeeting).toHaveBeenCalledTimes(1);
    expect(api.endMeeting).toHaveBeenCalledTimes(1);
  });

  it('sets aside lines the API rejects as invalid instead of retrying the batch forever', async () => {
    const store = new InMemoryTranscriptStore();
    const api = fakeApi();
    store.createMeeting({ id: 'm1', title: 'T', startedAt: '2026-10-05T10:00:00Z' });
    for (let n = 0; n < 3; n += 1) store.appendSegment(segment('m1', n));
    store.markMeetingEnded('m1', '2026-10-05T10:30:00Z');
    const invalid = new ApiError(422, 'validation_error', 'body.segments[0].text: too short');
    api.appendSegments.mockImplementation((_meetingId, batch) => {
      const ids = batch.map((s) => s.id);
      return ids.includes('m1-seg-1')
        ? Promise.reject(invalid)
        : Promise.resolve({ accepted: ids.length, duplicates: 0 });
    });

    const uploader = new TranscriptUploader({ store, api, logger });
    await uploader.flush();

    expect(api.appendSegments).toHaveBeenCalledTimes(4); // the batch, then each of its three lines
    expect(store.countUnsyncedSegments()).toBe(0);
    expect(store.countRejectedSegments()).toBe(1);
    expect(store.segments.get('m1-seg-1')?.rejectedAt).not.toBeNull();
    expect(store.segments.get('m1-seg-0')?.syncedAt).not.toBeNull();
    expect(api.endMeeting).toHaveBeenCalledTimes(1);
    expect(uploader.getStatus()).toMatchObject({ state: 'idle', pending: 0, rejected: 1 });
  });

  it('does not create a meeting in Postgres until it has a line to upload', async () => {
    const store = new InMemoryTranscriptStore();
    const api = fakeApi();
    store.createMeeting({ id: 'm1', title: 'T', startedAt: '2026-10-05T10:00:00Z' });
    const uploader = new TranscriptUploader({ store, api, logger });

    await uploader.flush();
    expect(api.createMeeting).not.toHaveBeenCalled();
    expect(store.getMeeting('m1')?.remoteState).toBe('pending');

    store.appendSegment(segment('m1', 0));
    await uploader.flush();
    expect(api.createMeeting).toHaveBeenCalledTimes(1);
    expect(api.appendSegments).toHaveBeenCalledTimes(1);
    expect(store.getMeeting('m1')?.remoteState).toBe('created');
  });

  it('discards an ended meeting that never got a line, without a call to the API', async () => {
    const store = new InMemoryTranscriptStore();
    const api = fakeApi();
    // For example a crash right after Start: recovery ends it at its start time with no lines.
    store.createMeeting({ id: 'm1', title: 'T', startedAt: '2026-10-05T10:00:00Z' });
    store.markMeetingEnded('m1', '2026-10-05T10:00:00Z');
    const uploader = new TranscriptUploader({ store, api, logger });

    await uploader.flush();
    expect(store.getMeeting('m1')).toBeNull();
    expect(api.createMeeting).not.toHaveBeenCalled();
    expect(api.endMeeting).not.toHaveBeenCalled();
    expect(uploader.getStatus()).toMatchObject({ state: 'idle', lastError: null });
  });

  it('does not reschedule after stop() even if a tick was in flight', async () => {
    const store = new InMemoryTranscriptStore();
    const api = fakeApi();
    store.createMeeting({ id: 'm1', title: 'T', startedAt: '2026-10-05T10:00:00Z' });
    store.appendSegment(segment('m1', 0));
    let resolveCreate: () => void = () => undefined;
    api.createMeeting.mockImplementationOnce(
      (input) =>
        new Promise<MeetingDto>((resolve) => {
          resolveCreate = () => {
            resolve(meetingDto(input.id));
          };
        }),
    );
    const uploader = new TranscriptUploader({ store, api, logger, intervalMs: 10 });
    uploader.start();
    await vi.advanceTimersByTimeAsync(0);
    uploader.stop();
    resolveCreate();
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.createMeeting).toHaveBeenCalledTimes(1);
  });

  it('runs only one tick at a time', async () => {
    const store = new InMemoryTranscriptStore();
    const api = fakeApi();
    store.createMeeting({ id: 'm1', title: 'T', startedAt: '2026-10-05T10:00:00Z' });
    store.appendSegment(segment('m1', 0));
    let resolveCreate: () => void = () => undefined;
    api.createMeeting.mockImplementationOnce(
      (input) =>
        new Promise<MeetingDto>((resolve) => {
          resolveCreate = () => {
            resolve(meetingDto(input.id));
          };
        }),
    );
    const uploader = new TranscriptUploader({ store, api, logger });
    const first = uploader.flush();
    const second = uploader.flush();
    resolveCreate();
    await Promise.all([first, second]);
    expect(api.createMeeting).toHaveBeenCalledTimes(1);
  });

  it('keeps running when the local store fails during a scheduled tick, and says so', async () => {
    const store = new FlakyStore(1);
    const api = fakeApi();
    const lines: string[] = [];
    const warnLogger = createLogger({ level: 'warn', format: 'json', sink: (l) => lines.push(l) });
    store.createMeeting({ id: 'm1', title: 'T', startedAt: '2026-10-05T10:00:00Z' });
    store.appendSegment(segment('m1', 0));
    const uploader = new TranscriptUploader({
      store,
      api,
      logger: warnLogger,
      baseBackoffMs: 500,
    });
    uploader.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(uploader.getStatus()).toMatchObject({
      state: 'backoff',
      lastError: 'database is locked',
    });
    expect(lines.some((l) => l.includes('upload failed') && l.includes('database is locked'))).toBe(
      true,
    );

    await vi.advanceTimersByTimeAsync(500);
    expect(api.appendSegments).toHaveBeenCalledTimes(1);
    expect(uploader.getStatus()).toMatchObject({ state: 'idle', pending: 0 });
    uploader.stop();
  });

  it('still retries when the store also fails the counts the status reads', async () => {
    const { store, setFailing } = failingStore();
    const api = fakeApi();
    const lines: string[] = [];
    const warnLogger = createLogger({ level: 'warn', format: 'json', sink: (l) => lines.push(l) });
    store.createMeeting({ id: 'm1', title: 'T', startedAt: '2026-10-05T10:00:00Z' });
    store.appendSegment(segment('m1', 0));
    const uploader = new TranscriptUploader({
      store,
      api,
      logger: warnLogger,
      baseBackoffMs: 500,
    });
    // Like CaptureService, which answers every uploader status with a full status read.
    uploader.onStatus(() => uploader.getStatus());
    setFailing(true);
    uploader.start();

    // A rejected tick would surface here as an unhandled rejection and fail the run.
    await vi.advanceTimersByTimeAsync(0);
    expect(
      lines.some((l) => l.includes('upload failed') && l.includes('database is not open')),
    ).toBe(true);

    setFailing(false);
    expect(uploader.getStatus()).toMatchObject({
      state: 'backoff',
      lastError: 'database is not open',
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(api.appendSegments).toHaveBeenCalledTimes(1);
    expect(uploader.getStatus()).toMatchObject({ state: 'idle', pending: 0 });
    uploader.stop();
  });

  it('flush rejects with the store error when the store fails every call', async () => {
    const { store, setFailing } = failingStore();
    const uploader = new TranscriptUploader({ store, api: fakeApi(), logger });
    setFailing(true);
    await expect(uploader.flush()).rejects.toThrow('database is not open');
  });

  it('flush waits out a failing tick in flight, then reports the result of its own run', async () => {
    const store = new InMemoryTranscriptStore();
    const api = fakeApi();
    store.createMeeting({ id: 'm1', title: 'T', startedAt: '2026-10-05T10:00:00Z' });
    store.appendSegment(segment('m1', 0));
    let failCreate: () => void = () => undefined;
    api.createMeeting.mockImplementationOnce(
      () =>
        new Promise<MeetingDto>((_resolve, reject) => {
          failCreate = () => {
            reject(new ApiError(0, 'network_error', 'down'));
          };
        }),
    );
    const uploader = new TranscriptUploader({ store, api, logger, baseBackoffMs: 60_000 });
    uploader.start();
    await vi.advanceTimersByTimeAsync(0);
    const flushing = uploader.flush();
    failCreate();
    await flushing;
    expect(api.createMeeting).toHaveBeenCalledTimes(2);
    expect(store.countUnsyncedSegments()).toBe(0);
    uploader.stop();
  });
});

/** A clock the test moves, for hold caps (the store decides with it whether a cap has passed). */
function manualClock(iso: string): { now: () => Date; set: (next: string) => void } {
  let current = new Date(iso);
  return {
    now: () => current,
    set: (next) => {
      current = new Date(next);
    },
  };
}

const ENDED_AT = '2026-10-05T10:30:00Z';

/**
 * Stands in for the echo sink's settleAll (M2-T14b): each hold on a line stored before
 * `launchedAt` is checked once against the stored call-audio lines, then released. A hold of this
 * run is left alone: a retried settle can run while a capture holds lines for their twins.
 */
function settleHoldsBefore(store: TranscriptStore, launchedAt: string): void {
  const launch = Date.parse(launchedAt);
  const leftByACrash = store
    .listHeldSegments()
    .filter((held) => Date.parse(held.createdAt) < launch);
  store.releaseSegments(leftByACrash.map((held) => held.id));
}

/** What each appendSegments call sent, as line ids. */
function sentBatches(api: FakeApi): string[][] {
  return api.appendSegments.mock.calls.map((call) => call[1].map((s) => s.id));
}

describe('TranscriptUploader: no stranded lines (M2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uploads re-run lines added after the meeting ended remotely, then re-sends its end', async () => {
    const store = new InMemoryTranscriptStore();
    const api = fakeApi();
    store.createMeeting({ id: 'm1', title: 'T', startedAt: '2026-10-05T10:00:00Z' });
    store.appendSegment(segment('m1', 0));
    store.markMeetingEnded('m1', ENDED_AT);
    const uploader = new TranscriptUploader({ store, api, logger });
    await uploader.flush();
    expect(store.getMeeting('m1')?.remoteState).toBe('ended');

    // The gap re-run (M2-T16) adds the words the live stream lost, after the meeting ended.
    store.appendSegment(segment('m1', 3), 'rerun');
    store.appendSegment(segment('m1', 5), 'rerun');
    await uploader.flush();

    expect(sentBatches(api)).toEqual([['m1-seg-0'], ['m1-seg-3', 'm1-seg-5']]);
    // Only the line's own fields go up: its origin is local.
    expect(api.appendSegments.mock.calls[1]?.[1]).toEqual([segment('m1', 3), segment('m1', 5)]);
    expect(api.createMeeting).toHaveBeenCalledTimes(1);
    expect(api.endMeeting.mock.calls).toEqual([
      ['m1', ENDED_AT],
      ['m1', ENDED_AT],
    ]);
    expect(store.getMeeting('m1')?.remoteState).toBe('ended');
    expect(uploader.getStatus()).toMatchObject({ state: 'idle', pending: 0 });
  });

  it('uploads a line unhidden after the meeting ended remotely, and re-sends its end', async () => {
    const store = new InMemoryTranscriptStore();
    const api = fakeApi();
    store.createMeeting({ id: 'm1', title: 'T', startedAt: '2026-10-05T10:00:00Z' });
    store.appendSegment(segment('m1', 1)); // call audio
    store.appendSegment(segment('m1', 2)); // the mic heard it too
    store.suppressSegment('m1-seg-2', 'echo', 'm1-seg-1');
    store.markMeetingEnded('m1', ENDED_AT);
    const uploader = new TranscriptUploader({ store, api, logger });
    await uploader.flush();
    expect(sentBatches(api)).toEqual([['m1-seg-1']]);

    // The user says it was not an echo.
    expect(store.unhideSegment('m1-seg-2')).toBe(true);
    await uploader.flush();

    expect(sentBatches(api)).toEqual([['m1-seg-1'], ['m1-seg-2']]);
    expect(api.endMeeting).toHaveBeenCalledTimes(2);
    expect(store.getMeeting('m1')?.remoteState).toBe('ended');
  });

  it('does not send end while the meeting holds lines, and sends it once they are released', async () => {
    const store = new InMemoryTranscriptStore();
    const api = fakeApi();
    store.createMeeting({ id: 'm1', title: 'T', startedAt: '2026-10-05T10:00:00Z' });
    store.appendSegment(segment('m1', 0));
    store.appendSegment(segment('m1', 2));
    // A mic line waiting for the call-audio stream's watermark (M2 D2), cap far ahead.
    store.holdSegment('m1-seg-2', '2099-01-01T00:00:00.000Z');
    store.markMeetingEnded('m1', ENDED_AT);
    const uploader = new TranscriptUploader({ store, api, logger });

    await uploader.flush();
    await uploader.flush();
    expect(sentBatches(api)).toEqual([['m1-seg-0']]);
    expect(api.endMeeting).not.toHaveBeenCalled();
    expect(store.getMeeting('m1')?.remoteState).toBe('created');
    expect(store.listMeetingsNeedingSync().map((m) => m.id)).toEqual(['m1']);

    store.releaseSegments(['m1-seg-2']);
    await uploader.flush();
    expect(sentBatches(api)).toEqual([['m1-seg-0'], ['m1-seg-2']]);
    expect(api.endMeeting).toHaveBeenCalledExactlyOnceWith('m1', ENDED_AT);
    expect(store.getMeeting('m1')?.remoteState).toBe('ended');
  });

  it('neither creates nor discards an ended meeting whose only line is held, and ends it after the cap', async () => {
    const clock = manualClock('2026-10-05T10:30:00.000Z');
    const store = new InMemoryTranscriptStore(clock.now);
    const api = fakeApi();
    store.createMeeting({ id: 'm1', title: 'T', startedAt: '2026-10-05T10:00:00Z' });
    store.appendSegment(segment('m1', 0));
    store.holdSegment('m1-seg-0', '2026-10-05T10:32:00.000Z');
    store.markMeetingEnded('m1', ENDED_AT);
    const uploader = new TranscriptUploader({ store, api, logger, clock: clock.now });

    await uploader.flush();
    expect(store.getMeeting('m1')?.remoteState).toBe('pending');
    expect(api.createMeeting).not.toHaveBeenCalled();
    expect(api.endMeeting).not.toHaveBeenCalled();

    // The call-audio stream never caught up: the cap lets the line go, uncompared.
    clock.set('2026-10-05T10:32:00.000Z');
    await uploader.flush();
    expect(api.createMeeting).toHaveBeenCalledTimes(1);
    expect(sentBatches(api)).toEqual([['m1-seg-0']]);
    expect(api.endMeeting).toHaveBeenCalledExactlyOnceWith('m1', ENDED_AT);
    expect(store.getMeeting('m1')?.remoteState).toBe('ended');
  });

  it('does not touch a meeting again once it has nothing to upload', async () => {
    const store = new InMemoryTranscriptStore();
    const api = fakeApi();
    store.createMeeting({ id: 'm1', title: 'T', startedAt: '2026-10-05T10:00:00Z' });
    store.appendSegment(segment('m1', 0));
    store.appendSegment(segment('m1', 1));
    store.appendSegment(segment('m1', 2));
    store.markSegmentRejected('m1-seg-0', 'text too short', '2026-10-05T10:10:00.000Z');
    store.suppressSegment('m1-seg-2', 'echo', 'm1-seg-1');
    store.markMeetingEnded('m1', ENDED_AT);
    const uploader = new TranscriptUploader({ store, api, logger });
    await uploader.flush();
    expect(sentBatches(api)).toEqual([['m1-seg-1']]);
    const calls = (): number[] => [
      api.createMeeting.mock.calls.length,
      api.appendSegments.mock.calls.length,
      api.endMeeting.mock.calls.length,
    ];
    expect(calls()).toEqual([1, 1, 1]);

    // A late line that is held is not one that can upload yet either.
    store.appendSegment(segment('m1', 4));
    store.holdSegment('m1-seg-4', '2099-01-01T00:00:00.000Z');
    await uploader.flush();
    await uploader.flush();

    expect(calls()).toEqual([1, 1, 1]);
    expect(store.listMeetingsNeedingSync()).toEqual([]);
  });

  it('settles the holds a kill -9 left before its first tick, so a relaunch 6 s later uploads them', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'roger-uploader-')), 'roger.sqlite');
    const crashed = new SqliteTranscriptStore(path, () => new Date('2026-10-05T10:05:00.000Z'));
    crashed.createMeeting({ id: 'm1', title: 'T', startedAt: '2026-10-05T10:00:00Z' });
    crashed.appendSegment(segment('m1', 1));
    for (const n of [2, 4]) {
      crashed.appendSegment(segment('m1', n));
      crashed.holdSegment(`m1-seg-${n}`, '2026-10-05T10:07:00.000Z'); // created plus 120 s
    }
    // No close(): kill -9 never runs it. Committed writes are in the WAL file.

    const relaunched = (): Date => new Date('2026-10-05T10:05:06.000Z');
    const store = new SqliteTranscriptStore(path, relaunched);
    store.endMeetingsLeftOpen(relaunched().toISOString()); // as main does at launch
    // The holds outlived the crash: without a settle the lines would wait out their cap.
    expect(store.countUnsyncedSegments()).toBe(1);
    const api = fakeApi();
    const order: string[] = [];
    api.createMeeting.mockImplementation((input) => {
      order.push('create');
      return Promise.resolve(meetingDto(input.id));
    });
    // Built first and given the hook later, as main does: index.ts builds the uploader before the
    // capture runtime, whose M2-T14b slot sets the hook, then starts it.
    const uploader = new TranscriptUploader({ store, api, logger, clock: relaunched });
    // Async, so a hook that is not awaited shows here.
    uploader.setBeforeFirstTick(async (launchedAt) => {
      await Promise.resolve();
      order.push('settle');
      settleHoldsBefore(store, launchedAt);
    });
    uploader.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(order).toEqual(['settle', 'create']);
    expect(sentBatches(api)).toEqual([['m1-seg-1', 'm1-seg-2', 'm1-seg-4']]);
    expect(api.endMeeting).toHaveBeenCalledTimes(1);
    expect(store.getMeeting('m1')?.remoteState).toBe('ended');
    uploader.stop();
    store.close();
    crashed.close();
  });

  it('retries a failed beforeFirstTick on the next tick before any line goes up, then never runs it again', async () => {
    const store = new InMemoryTranscriptStore();
    const api = fakeApi();
    const lines: string[] = [];
    const warnLogger = createLogger({ level: 'warn', format: 'json', sink: (l) => lines.push(l) });
    store.createMeeting({ id: 'm1', title: 'T', startedAt: '2026-10-05T10:00:00Z' });
    store.appendSegment(segment('m1', 0));
    let settles = 0;
    const uploader = new TranscriptUploader({
      store,
      api,
      logger: warnLogger,
      intervalMs: 1000,
      baseBackoffMs: 500,
    });
    uploader.setBeforeFirstTick(() => {
      settles += 1;
      if (settles === 1) throw new Error('database is locked');
    });
    uploader.start();

    await vi.advanceTimersByTimeAsync(0);
    // A line the settle would have hidden must not go up first.
    expect(api.createMeeting).not.toHaveBeenCalled();
    const failure = 'could not run the step before the first upload: database is locked';
    expect(uploader.getStatus()).toMatchObject({ state: 'backoff', lastError: failure });
    expect(lines.some((l) => l.includes('upload failed') && l.includes(failure))).toBe(true);

    await vi.advanceTimersByTimeAsync(500);
    expect(settles).toBe(2);
    expect(sentBatches(api)).toEqual([['m1-seg-0']]);
    await vi.advanceTimersByTimeAsync(1000);
    await uploader.flush();
    expect(settles).toBe(2);
    uploader.stop();
  });

  it('hands a retried settle the instant it was built, so the holds of a capture started since stay held', async () => {
    const clock = manualClock('2026-10-05T10:05:06.000Z');
    const store = new InMemoryTranscriptStore(clock.now);
    const api = fakeApi();
    // Left by a kill -9: a mic line held for its call-audio twin, stored before this launch.
    store.createMeeting({ id: 'm1', title: 'T', startedAt: '2026-10-05T10:00:00Z' });
    store.appendSegment({ ...segment('m1', 2), createdAt: '2026-10-05T10:04:58.000Z' });
    store.holdSegment('m1-seg-2', '2026-10-05T10:06:58.000Z');
    store.markMeetingEnded('m1', ENDED_AT);
    const uploader = new TranscriptUploader({
      store,
      api,
      logger,
      clock: clock.now,
      baseBackoffMs: 3000,
    });
    const handed: string[] = [];
    uploader.setBeforeFirstTick((launchedAt) => {
      handed.push(launchedAt);
      if (handed.length === 1) throw new Error('database is locked');
      settleHoldsBefore(store, launchedAt);
    });
    uploader.start();
    await vi.advanceTimersByTimeAsync(0);

    // The user presses Start during the backoff, and a mic line waits for its call-audio twin.
    clock.set('2026-10-05T10:05:08.000Z');
    store.createMeeting({ id: 'm2', title: 'T', startedAt: '2026-10-05T10:05:07Z' });
    store.appendSegment({ ...segment('m2', 2), createdAt: '2026-10-05T10:05:08.000Z' });
    store.holdSegment('m2-seg-2', '2026-10-05T10:07:08.000Z');
    clock.set('2026-10-05T10:05:09.000Z');
    await vi.advanceTimersByTimeAsync(3000);

    expect(handed).toEqual(['2026-10-05T10:05:06.000Z', '2026-10-05T10:05:06.000Z']);
    expect(sentBatches(api)).toEqual([['m1-seg-2']]);
    // Released now it would go up before its twin, and Postgres would get the echo text twice.
    expect(store.listHeldSegments('m2').map((s) => s.id)).toEqual(['m2-seg-2']);
    uploader.stop();
  });

  it('runs beforeFirstTick before a flush that comes first, and only once', async () => {
    const store = new InMemoryTranscriptStore();
    const api = fakeApi();
    const order: string[] = [];
    api.appendSegments.mockImplementation((_meetingId, segments) => {
      order.push('append');
      return Promise.resolve({ accepted: segments.length, duplicates: 0 });
    });
    store.createMeeting({ id: 'm1', title: 'T', startedAt: '2026-10-05T10:00:00Z' });
    store.appendSegment(segment('m1', 0));
    const uploader = new TranscriptUploader({ store, api, logger });
    uploader.setBeforeFirstTick(() => {
      order.push('settle');
    });

    await uploader.flush();
    store.appendSegment(segment('m1', 1));
    await uploader.flush();
    expect(order).toEqual(['settle', 'append', 'append']);
  });

  it('refuses a beforeFirstTick set once the first tick has started, or a second one', async () => {
    const tooLate = /set before the uploader's first tick, which has started/;
    const settle = (): void => undefined;

    // Started, and its first tick ran: a hook set now could not run before it.
    const started = new TranscriptUploader({
      store: new InMemoryTranscriptStore(),
      api: fakeApi(),
      logger,
    });
    started.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(() => {
      started.setBeforeFirstTick(settle);
    }).toThrow(tooLate);
    started.stop();

    // A flush that comes first starts the first tick at once, before it settles.
    const flushed = new TranscriptUploader({
      store: new InMemoryTranscriptStore(),
      api: fakeApi(),
      logger,
    });
    const flushing = flushed.flush();
    expect(() => {
      flushed.setBeforeFirstTick(settle);
    }).toThrow(tooLate);
    await flushing;

    // Started but its 0 ms timer has not fired: still in time.
    const pending = new TranscriptUploader({
      store: new InMemoryTranscriptStore(),
      api: fakeApi(),
      logger,
    });
    pending.start();
    pending.setBeforeFirstTick(settle);
    // One hook: a second would silently replace the first.
    expect(() => {
      pending.setBeforeFirstTick(settle);
    }).toThrow(/already set/);
    pending.stop();
  });

  it('marks a batch sent before the request, so an echo decision landing mid-upload is refused', async () => {
    const store = new InMemoryTranscriptStore();
    const api = fakeApi();
    store.createMeeting({ id: 'm1', title: 'T', startedAt: '2026-10-05T10:00:00Z' });
    store.appendSegment(segment('m1', 0));
    store.appendSegment(segment('m1', 2));
    let respond: () => void = () => undefined;
    api.appendSegments.mockImplementationOnce(
      (_meetingId, segments) =>
        new Promise((resolve) => {
          respond = () => {
            resolve({ accepted: segments.length, duplicates: 0 });
          };
        }),
    );
    const uploader = new TranscriptUploader({ store, api, logger });
    const flushing = uploader.flush();
    await vi.waitFor(() => {
      expect(api.appendSegments).toHaveBeenCalledTimes(1);
    });

    // The call-audio twins land while the request is out (a cap passed while call audio
    // reconnected): too late, Postgres may already hold the text as sent.
    expect(store.suppressSegment('m1-seg-0', 'echo', 'm1-seg-1')).toBe(false);
    expect(store.trimSegment('m1-seg-2', { text: 'line', words: null, echoOf: 'm1-seg-1' })).toBe(
      false,
    );
    respond();
    await flushing;

    expect(store.getSegment('m1-seg-0')).toMatchObject({ suppressedReason: null });
    expect(store.getSegment('m1-seg-2')).toMatchObject({ text: 'line 2', originalText: null });
    expect(store.countUnsyncedSegments()).toBe(0);
  });

  it('keeps a line it sent refused after a failed request, which may have reached the API', async () => {
    const store = new InMemoryTranscriptStore();
    const api = fakeApi();
    store.createMeeting({ id: 'm1', title: 'T', startedAt: '2026-10-05T10:00:00Z' });
    store.appendSegment(segment('m1', 0));
    api.appendSegments.mockRejectedValueOnce(new ApiError(0, 'network_error', 'connection reset'));
    const uploader = new TranscriptUploader({ store, api, logger });

    await expect(uploader.flush()).rejects.toThrow('connection reset');
    expect(store.suppressSegment('m1-seg-0', 'echo', 'm1-seg-1')).toBe(false);
    await uploader.flush();

    expect(sentBatches(api)).toEqual([['m1-seg-0'], ['m1-seg-0']]);
    expect(store.getSegment('m1-seg-0')).toMatchObject({ suppressedReason: null });
    expect(store.countUnsyncedSegments()).toBe(0);
  });
});

describe('TranscriptUploader: meetings with notes (M4)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a notes-only meeting is created and ended exactly once', async () => {
    const store = new InMemoryTranscriptStore();
    const api = fakeApi();
    // Nobody spoke, but the user wrote notes during the call.
    store.createMeeting({ id: 'm1', title: 'T', startedAt: '2026-10-05T10:00:00Z' });
    store.markMeetingEnded('m1', ENDED_AT);
    const uploader = new TranscriptUploader({
      store,
      api,
      logger,
      intervalMs: 1000,
      hasNotes: (meetingId) => meetingId === 'm1',
    });
    uploader.start();

    // In one pass: created, then ended in the same tick.
    await vi.advanceTimersByTimeAsync(0);
    expect(api.createMeeting).toHaveBeenCalledExactlyOnceWith({
      id: 'm1',
      title: 'T',
      startedAt: '2026-10-05T10:00:00Z',
      startSource: 'manual',
      calendarEvent: null,
    });
    expect(api.endMeeting).toHaveBeenCalledExactlyOnceWith('m1', ENDED_AT);
    expect(store.getMeeting('m1')?.remoteState).toBe('ended');

    await vi.advanceTimersByTimeAsync(5_000);
    await uploader.flush();
    expect(api.createMeeting).toHaveBeenCalledTimes(1);
    expect(api.endMeeting).toHaveBeenCalledTimes(1);
    expect(api.appendSegments).not.toHaveBeenCalled();
    uploader.stop();
  });

  it('a recording meeting with notes and no line is not created', async () => {
    const store = new InMemoryTranscriptStore();
    const api = fakeApi();
    store.createMeeting({ id: 'm1', title: 'T', startedAt: '2026-10-05T10:00:00Z' });
    const hasNotes = vi.fn((_meetingId: string) => true);
    const uploader = new TranscriptUploader({ store, api, logger, hasNotes });

    await uploader.flush();
    await uploader.flush();
    // Postgres never holds a meeting with no line while it is still recording.
    expect(api.createMeeting).not.toHaveBeenCalled();
    expect(store.getMeeting('m1')?.remoteState).toBe('pending');
    // notes.sqlite is read only when its answer decides something, not on every 2 s tick.
    expect(hasNotes).not.toHaveBeenCalled();

    store.markMeetingEnded('m1', ENDED_AT);
    await uploader.flush();
    expect(hasNotes).toHaveBeenCalledWith('m1');
    expect(api.createMeeting).toHaveBeenCalledTimes(1);
    expect(api.endMeeting).toHaveBeenCalledExactlyOnceWith('m1', ENDED_AT);
    expect(api.appendSegments).not.toHaveBeenCalled();
  });

  it('an ended lineless meeting with notes is never discarded', async () => {
    const store = new InMemoryTranscriptStore();
    const api = fakeApi();
    // Both ended with no line (a crash right after Start); only m1 has notes.
    store.createMeeting({ id: 'm1', title: 'T', startedAt: '2026-10-05T10:00:00Z' });
    store.markMeetingEnded('m1', '2026-10-05T10:00:00Z');
    store.createMeeting({ id: 'm2', title: 'T', startedAt: '2026-10-05T11:00:00Z' });
    store.markMeetingEnded('m2', '2026-10-05T11:00:00Z');
    api.createMeeting.mockRejectedValue(new ApiError(0, 'network_error', 'down'));
    const uploader = new TranscriptUploader({
      store,
      api,
      logger,
      hasNotes: (meetingId) => meetingId === 'm1',
    });

    // Offline: the create fails, and the meeting stays for the next try.
    await expect(uploader.flush()).rejects.toThrow('down');
    await expect(uploader.flush()).rejects.toThrow('down');
    expect(store.getMeeting('m1')).toMatchObject({ remoteState: 'pending' });
    expect(store.getMeeting('m2')).toBeNull();

    api.createMeeting.mockImplementation((input) => Promise.resolve(meetingDto(input.id)));
    await uploader.flush();
    expect(api.createMeeting.mock.calls.map((call) => call[0].id)).toEqual(['m1', 'm1', 'm1']);
    expect(api.endMeeting).toHaveBeenCalledExactlyOnceWith('m1', '2026-10-05T10:00:00Z');
    expect(store.getMeeting('m1')?.remoteState).toBe('ended');
  });

  it('keeps a lineless meeting whose notes cannot be read, and backs off naming it', async () => {
    const store = new InMemoryTranscriptStore();
    const api = fakeApi();
    store.createMeeting({ id: 'm1', title: 'T', startedAt: '2026-10-05T10:00:00Z' });
    store.markMeetingEnded('m1', ENDED_AT);
    let readable = false;
    const uploader = new TranscriptUploader({
      store,
      api,
      logger,
      baseBackoffMs: 500,
      hasNotes: () => {
        if (!readable) throw new Error('database is locked');
        return true;
      },
    });
    uploader.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(store.getMeeting('m1')).not.toBeNull();
    expect(uploader.getStatus()).toMatchObject({
      state: 'backoff',
      lastError: 'could not read the notes of meeting m1: database is locked',
    });

    readable = true;
    await vi.advanceTimersByTimeAsync(500);
    expect(api.createMeeting).toHaveBeenCalledTimes(1);
    expect(api.endMeeting).toHaveBeenCalledTimes(1);
    expect(uploader.getStatus()).toMatchObject({ state: 'idle', lastError: null });
    uploader.stop();
  });

  it('markMeetingMissing re-creates the meeting and re-sends its lines', async () => {
    const store = new InMemoryTranscriptStore();
    const api = fakeApi();
    store.createMeeting({ id: 'm1', title: 'T', startedAt: '2026-10-05T10:00:00Z' });
    store.appendSegment(segment('m1', 0));
    store.appendSegment(segment('m1', 1));
    store.markMeetingEnded('m1', ENDED_AT);
    const uploader = new TranscriptUploader({ store, api, logger });
    await uploader.flush();
    expect(store.getMeeting('m1')?.remoteState).toBe('ended');

    // A notes PUT answered 404: Postgres lost the meeting (a reset dev database).
    uploader.markMeetingMissing('m1');
    // At once: NotesSync reads the state right after the call, and waits while it is pending.
    expect(store.getMeeting('m1')?.remoteState).toBe('pending');
    expect(store.countUnsyncedSegments()).toBe(2);

    await uploader.flush();
    expect(api.createMeeting).toHaveBeenCalledTimes(2);
    expect(sentBatches(api)).toEqual([
      ['m1-seg-0', 'm1-seg-1'],
      ['m1-seg-0', 'm1-seg-1'],
    ]);
    expect(api.endMeeting.mock.calls).toEqual([
      ['m1', ENDED_AT],
      ['m1', ENDED_AT],
    ]);
    expect(store.getMeeting('m1')?.remoteState).toBe('ended');
  });

  it('markMeetingMissing takes a notes-only meeting back too, and leaves an unknown one unknown', async () => {
    const store = new InMemoryTranscriptStore();
    const api = fakeApi();
    store.createMeeting({ id: 'm1', title: 'T', startedAt: '2026-10-05T10:00:00Z' });
    store.markMeetingEnded('m1', ENDED_AT);
    const uploader = new TranscriptUploader({ store, api, logger, hasNotes: () => true });
    await uploader.flush();

    uploader.markMeetingMissing('m1');
    expect(store.getMeeting('m1')?.remoteState).toBe('pending');
    await uploader.flush();
    expect(api.createMeeting).toHaveBeenCalledTimes(2);
    expect(api.endMeeting).toHaveBeenCalledTimes(2);
    expect(store.getMeeting('m1')?.remoteState).toBe('ended');

    // Discarded as empty before its notes were saved: NotesSync reads null and deals with it.
    uploader.markMeetingMissing('gone');
    expect(store.getMeeting('gone')).toBeNull();
    expect(store.listMeetingsNeedingSync()).toEqual([]);
  });

  it('saveOpenNotes runs the injected save, and names what it was doing when that fails', async () => {
    const store = new InMemoryTranscriptStore();
    // Not wired (before M4-T16): no editor can hold notes, so there is nothing to wait for.
    const unwired = new TranscriptUploader({ store, api: fakeApi(), logger });
    await expect(unwired.saveOpenNotes()).resolves.toBeUndefined();

    const save = vi.fn(() => Promise.resolve());
    await new TranscriptUploader({
      store,
      api: fakeApi(),
      logger,
      saveOpenNotes: save,
    }).saveOpenNotes();
    expect(save).toHaveBeenCalledTimes(1);

    const failing = new TranscriptUploader({
      store,
      api: fakeApi(),
      logger,
      saveOpenNotes: () => Promise.reject(new Error('the window is gone')),
    });
    await expect(failing.saveOpenNotes()).rejects.toThrow(
      'could not save the notes open in an editor: the window is gone',
    );
  });
});
