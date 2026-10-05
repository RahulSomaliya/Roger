import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { TranscriptSegment } from '../../shared/transcript';
import { ApiError, type ApiClient } from '../api/ApiClient';
import { createLogger } from '../logger';
import { InMemoryTranscriptStore } from '../store/InMemoryTranscriptStore';
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

type AsyncMock = Mock<(...args: unknown[]) => Promise<unknown>>;

interface FakeApi {
  createMeeting: AsyncMock;
  appendSegments: AsyncMock;
  endMeeting: AsyncMock;
  getSttToken: AsyncMock;
}

function fakeApi(): FakeApi {
  return {
    createMeeting: vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({}),
    appendSegments: vi
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockResolvedValue({ accepted: 0, duplicates: 0 }),
    endMeeting: vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({}),
    getSttToken: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  };
}

/** The uploader only calls the four methods above; the cast narrows nothing it uses. */
const asClient = (api: FakeApi): ApiClient => api as unknown as ApiClient;

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

    const uploader = new TranscriptUploader({ store, api: asClient(api), logger, batchSize: 2 });
    await uploader.flush();

    expect(api.createMeeting).toHaveBeenCalledWith({
      id: 'm1',
      title: 'T',
      startedAt: '2026-10-05T10:00:00Z',
    });
    expect(api.appendSegments).toHaveBeenCalledTimes(3);
    expect(
      api.appendSegments.mock.calls.map((call) =>
        (call[1] as TranscriptSegment[]).map((s) => s.id),
      ),
    ).toEqual([['m1-seg-0', 'm1-seg-1'], ['m1-seg-2', 'm1-seg-3'], ['m1-seg-4']]);
    expect(api.endMeeting).toHaveBeenCalledWith('m1', '2026-10-05T10:30:00Z');
    expect(store.getMeeting('m1')?.remoteState).toBe('ended');
    expect(store.countUnsyncedSegments()).toBe(0);
    expect(uploader.getStatus()).toMatchObject({ state: 'idle', pending: 0, lastError: null });
  });

  it('keeps lines local and backs off when the API is down, then recovers', async () => {
    const store = new InMemoryTranscriptStore();
    const api = fakeApi();
    api.createMeeting.mockRejectedValueOnce(new ApiError(0, 'network_error', 'down'));
    store.createMeeting({ id: 'm1', title: 'T', startedAt: '2026-10-05T10:00:00Z' });
    store.appendSegment(segment('m1', 0));

    const uploader = new TranscriptUploader({
      store,
      api: asClient(api),
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

    const uploader = new TranscriptUploader({ store, api: asClient(api), logger });
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
    api.appendSegments.mockImplementation((_meetingId: unknown, batch: unknown) => {
      const ids = (batch as TranscriptSegment[]).map((s) => s.id);
      return ids.includes('m1-seg-1')
        ? Promise.reject(invalid)
        : Promise.resolve({ accepted: ids.length, duplicates: 0 });
    });

    const uploader = new TranscriptUploader({ store, api: asClient(api), logger });
    await uploader.flush();

    expect(api.appendSegments).toHaveBeenCalledTimes(4); // the batch, then each of its three lines
    expect(store.countUnsyncedSegments()).toBe(0);
    expect(store.countRejectedSegments()).toBe(1);
    expect(store.segments.get('m1-seg-1')?.rejectedAt).not.toBeNull();
    expect(store.segments.get('m1-seg-0')?.syncedAt).not.toBeNull();
    expect(api.endMeeting).toHaveBeenCalledTimes(1);
    expect(uploader.getStatus()).toMatchObject({ state: 'idle', pending: 0, rejected: 1 });
  });

  it('does not reschedule after stop() even if a tick was in flight', async () => {
    const store = new InMemoryTranscriptStore();
    const api = fakeApi();
    store.createMeeting({ id: 'm1', title: 'T', startedAt: '2026-10-05T10:00:00Z' });
    let resolveCreate: () => void = () => undefined;
    api.createMeeting.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const uploader = new TranscriptUploader({ store, api: asClient(api), logger, intervalMs: 10 });
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
    let resolveCreate: () => void = () => undefined;
    api.createMeeting.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const uploader = new TranscriptUploader({ store, api: asClient(api), logger });
    const first = uploader.flush();
    const second = uploader.flush();
    resolveCreate();
    await Promise.all([first, second]);
    expect(api.createMeeting).toHaveBeenCalledTimes(1);
  });
});
