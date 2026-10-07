import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ApiError } from '../api/http';
import type { SttUsageRoutes } from '../api/sttUsageClient';
import { createLogger } from '../logger';
import { InMemoryTranscriptStore } from '../store/InMemoryTranscriptStore';
import { SqliteTranscriptStore } from '../store/SqliteTranscriptStore';
import type { MeetingSttUsage, TranscriptStore } from '../store/TranscriptStore';
import { SttUsageUploader, type SttUsageUploaderOptions } from './SttUsageUploader';

const T0 = '2026-10-07T10:00:00.000Z';

/** A row as CaptureService saves it, at `T0` plus `atMs`. */
function usage(
  meetingId: string,
  atMs = 0,
  overrides: Partial<MeetingSttUsage> = {},
): MeetingSttUsage {
  const source = {
    sessionsOpened: 1,
    connectedMs: 60_000,
    audioSentMs: 59_000,
    droppedChunks: 0,
    estimatedCostUsd: 0.0025,
  };
  return {
    meetingId,
    provider: 'assemblyai',
    total: {
      sessionsOpened: 2,
      connectedMs: 120_000,
      audioSentMs: 118_000,
      droppedChunks: 0,
      estimatedCostUsd: 0.005,
    },
    bySource: { mic: { ...source }, system: { ...source } },
    stopReason: null,
    updatedAt: new Date(Date.parse(T0) + atMs).toISOString(),
    ...overrides,
  };
}

interface LogLine {
  level: string;
  message: string;
  [field: string]: unknown;
}

/** A promise the test settles by hand: an upload still out. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function harness(options: Partial<SttUsageUploaderOptions> & { store?: TranscriptStore } = {}): {
  store: TranscriptStore;
  save: Mock<SttUsageRoutes['saveMeetingUsage']>;
  uploader: SttUsageUploader;
  lines: LogLine[];
  sentIds: () => string[];
  waiting: () => string[];
} {
  const store = options.store ?? new InMemoryTranscriptStore();
  const save = vi.fn<SttUsageRoutes['saveMeetingUsage']>(() => Promise.resolve());
  const lines: LogLine[] = [];
  const logger = createLogger({
    level: 'debug',
    format: 'json',
    sink: (line) => lines.push(JSON.parse(line) as LogLine),
  });
  const uploader = new SttUsageUploader({
    store,
    api: { saveMeetingUsage: save },
    logger,
    ...options,
  });
  return {
    store,
    save,
    uploader,
    lines,
    sentIds: () => save.mock.calls.map(([sent]) => sent.meetingId),
    waiting: () => store.listSttUsageToUpload(100).map((row) => row.meetingId),
  };
}

const warnings = (lines: LogLine[]): LogLine[] => lines.filter((line) => line.level === 'warn');

describe('SttUsageUploader', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends every row waiting at start, oldest save first, each once, and marks it uploaded', async () => {
    const h = harness();
    h.store.saveSttUsage(usage('m2', 1_000));
    h.store.saveSttUsage(usage('m1', 0, { stopReason: 'user' }));
    h.uploader.start();
    h.uploader.start(); // one loop, not two
    await vi.advanceTimersByTimeAsync(0);

    expect(h.sentIds()).toEqual(['m1', 'm2']);
    // The row as the store holds it: the client maps it to the wire.
    expect(h.save.mock.calls[0]?.[0]).toEqual(h.store.getSttUsage('m1'));
    expect(h.waiting()).toEqual([]);

    // Nothing saved since: nothing sent, however many passes run.
    await vi.advanceTimersByTimeAsync(5 * 30_000);
    expect(h.sentIds()).toEqual(['m1', 'm2']);
    await h.uploader.stop();
  });

  it('sends a row saved after its upload on the next pass, every 30 s', async () => {
    const h = harness();
    h.uploader.start();
    await vi.advanceTimersByTimeAsync(10_000);
    h.store.saveSttUsage(usage('m1', 10_000)); // a stream closed mid-meeting
    await vi.advanceTimersByTimeAsync(19_999);
    expect(h.sentIds()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sentIds()).toEqual(['m1']);

    const stopped = usage('m1', 40_000, { stopReason: 'user' });
    h.store.saveSttUsage(stopped);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.sentIds()).toEqual(['m1', 'm1']);
    expect(h.save.mock.calls[1]?.[0]).toMatchObject({ stopReason: 'user' });
    expect(h.waiting()).toEqual([]);
    await h.uploader.stop();
  });

  it('sends at once when asked after Stop, without waiting for the next pass', async () => {
    const h = harness();
    h.uploader.start();
    await vi.advanceTimersByTimeAsync(5_000);
    h.store.saveSttUsage(usage('m1', 5_000, { stopReason: 'user' }));

    h.uploader.sendNow();
    // The request is out in the same turn: nothing waits on a timer, or on anything else.
    expect(h.sentIds()).toEqual(['m1']);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.waiting()).toEqual([]);
    // The polling goes on from there.
    h.store.saveSttUsage(usage('m1', 6_000, { stopReason: 'user' }));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(h.sentIds()).toEqual(['m1']);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sentIds()).toEqual(['m1', 'm1']);
    await h.uploader.stop();
  });

  it('never has two requests out: a send asked for during a pass runs right after it', async () => {
    const h = harness();
    const out = deferred();
    h.save.mockImplementationOnce(() => out.promise);
    h.store.saveSttUsage(usage('m1'));
    h.uploader.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sentIds()).toEqual(['m1']);

    h.store.saveSttUsage(usage('m2', 1_000, { stopReason: 'user' }));
    h.uploader.sendNow();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.sentIds()).toEqual(['m1']); // still one out

    out.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sentIds()).toEqual(['m1', 'm2']); // at once, not 30 s later
    expect(h.waiting()).toEqual([]);
    await h.uploader.stop();
  });

  it('keeps a send asked for in the same turn as a pass that had nothing to send', async () => {
    const h = harness();
    h.uploader.start();
    await vi.advanceTimersByTimeAsync(1_000);
    // A pass with nothing to send ends in the turn it started, yet counts as out until its
    // promise settles: a second ask in that turn must still be honoured.
    h.uploader.sendNow();
    h.store.saveSttUsage(usage('m1', 1_000, { stopReason: 'user' }));
    h.uploader.sendNow();
    await vi.advanceTimersByTimeAsync(10);
    expect(h.sentIds()).toEqual(['m1']);
    await h.uploader.stop();
  });

  it('sends a row saved again while its request was out once more, with the newer totals', async () => {
    const h = harness();
    const out = deferred();
    h.save.mockImplementationOnce(() => out.promise);
    h.store.saveSttUsage(usage('m1'));
    h.uploader.start();
    await vi.advanceTimersByTimeAsync(0);

    // Stop's save, in the same millisecond as the row being sent.
    const stopped = usage('m1', 0, { stopReason: 'user' });
    h.store.saveSttUsage(stopped);
    out.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.waiting()).toEqual(['m1']);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.save.mock.calls.map(([sent]) => sent.stopReason)).toEqual([null, 'user']);
    expect(h.waiting()).toEqual([]);
    await h.uploader.stop();
  });

  it('backs off on failure, doubling to its cap, keeps the row, and polls every 30 s once a pass succeeds', async () => {
    const h = harness({ baseBackoffMs: 1_000, maxBackoffMs: 4_000 });
    const at: number[] = [];
    h.save.mockImplementation(() => {
      at.push(Date.now() - Date.parse(T0));
      return at.length <= 4
        ? Promise.reject(new ApiError(503, 'http_error', 'PUT /v1/stt-usage returned HTTP 503'))
        : Promise.resolve();
    });
    h.store.saveSttUsage(usage('m1'));
    h.uploader.start();
    await vi.advanceTimersByTimeAsync(11_000);

    expect(at).toEqual([0, 1_000, 3_000, 7_000, 11_000]);
    expect(h.waiting()).toEqual([]);
    expect(
      warnings(h.lines).map(({ message, failures, delayMs, error }) => ({
        message,
        failures,
        delayMs,
        error,
      })),
    ).toEqual(
      [1_000, 2_000, 4_000, 4_000].map((delayMs, index) => ({
        message: 'speech-to-text usage upload failed, backing off',
        failures: index + 1,
        delayMs,
        error: 'PUT /v1/stt-usage returned HTTP 503',
      })),
    );

    h.store.saveSttUsage(usage('m1', 12_000, { stopReason: 'user' }));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(at).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(at).toEqual([0, 1_000, 3_000, 7_000, 11_000, 41_000]);
    await h.uploader.stop();
  });

  it('waits 30 s after a first failure, then twice as long each time (the defaults)', async () => {
    const h = harness();
    const at: number[] = [];
    h.save.mockImplementation(() => {
      at.push(Date.now() - Date.parse(T0));
      return Promise.reject(new ApiError(0, 'network_error', 'PUT failed: fetch failed'));
    });
    h.store.saveSttUsage(usage('m1'));
    h.uploader.start();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    // 30 s, 1, 2 and 4 min, then the 5-minute cap.
    expect(at.slice(0, 7)).toEqual([0, 30_000, 90_000, 210_000, 450_000, 750_000, 1_050_000]);
    await h.uploader.stop();
  });

  it("takes a 422 as a refused row: logged once with the meeting and the API's message, never sent again until a later save", async () => {
    const h = harness();
    const message = 'Invalid request: body.stop_reason: String should have at most 64 characters';
    h.save.mockImplementation((sent) =>
      sent.meetingId === 'm1' && sent.stopReason !== null
        ? Promise.reject(new ApiError(422, 'validation_error', message))
        : Promise.resolve(),
    );
    h.store.saveSttUsage(usage('m1', 0, { stopReason: 'a'.repeat(65) }));
    h.store.saveSttUsage(usage('m2', 1_000));
    h.uploader.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(h.sentIds()).toEqual(['m1', 'm2']);
    expect(h.waiting()).toEqual([]);
    expect(
      warnings(h.lines).map(({ message, meetingId, reason }) => ({ message, meetingId, reason })),
    ).toEqual([
      {
        message: 'speech-to-text usage refused by the API, not sent again until it changes',
        meetingId: 'm1',
        reason: message,
      },
    ]);

    // Not a failure: no backoff, and the refused row is not sent again.
    await vi.advanceTimersByTimeAsync(3 * 30_000);
    expect(h.sentIds()).toEqual(['m1', 'm2']);
    expect(warnings(h.lines)).toHaveLength(1);

    // A later save changes it, and it goes again.
    h.store.saveSttUsage(usage('m1', 100_000));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.sentIds()).toEqual(['m1', 'm2', 'm1']);
    expect(h.waiting()).toEqual([]);
    await h.uploader.stop();
  });

  it('lets no failing row hold the others back, but no answer at all ends the pass', async () => {
    const h = harness();
    let m1Error = new ApiError(500, 'internal_error', 'Internal server error');
    h.save.mockImplementation((sent) =>
      sent.meetingId === 'm1' ? Promise.reject(m1Error) : Promise.resolve(),
    );
    h.store.saveSttUsage(usage('m1'));
    h.store.saveSttUsage(usage('m2', 1_000));
    h.uploader.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sentIds()).toEqual(['m1', 'm2']);
    expect(h.waiting()).toEqual(['m1']);
    expect(warnings(h.lines).map((line) => line.error)).toEqual(['Internal server error']);

    // Offline: the rest would meet the same, so the pass ends at the first.
    m1Error = new ApiError(
      0,
      'network_error',
      'PUT /v1/stt-usage/meetings/m1 failed: fetch failed',
    );
    h.store.saveSttUsage(usage('m2', 2_000, { stopReason: 'user' }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.sentIds()).toEqual(['m1', 'm2', 'm1']);
    expect(h.waiting()).toEqual(['m1', 'm2']);
    await h.uploader.stop();
  });

  it('logs a store that cannot be read and tries again later, never throwing', async () => {
    class FlakyStore extends InMemoryTranscriptStore {
      failures = 1;
      override listSttUsageToUpload(limit: number): MeetingSttUsage[] {
        if (this.failures > 0) {
          this.failures -= 1;
          throw new Error('database is locked');
        }
        return super.listSttUsageToUpload(limit);
      }
    }
    const h = harness({ store: new FlakyStore() });
    h.store.saveSttUsage(usage('m1'));
    h.uploader.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sentIds()).toEqual([]);
    expect(
      warnings(h.lines).map(({ failures, delayMs, error }) => ({ failures, delayMs, error })),
    ).toEqual([{ failures: 1, delayMs: 30_000, error: 'database is locked' }]);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.sentIds()).toEqual(['m1']);
    expect(h.waiting()).toEqual([]);
    await h.uploader.stop();
  });

  it('sends a full batch, then the next at once, then waits', async () => {
    const h = harness({ batchSize: 2 });
    for (let n = 1; n <= 5; n += 1) h.store.saveSttUsage(usage(`m${n}`, n * 1_000));
    h.uploader.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sentIds()).toEqual(['m1', 'm2']);
    // Each full batch is followed at once, not 30 s later. (Fake timers run a 0 ms timer set
    // during a tick 1 ms later, so the bound is a few ms, not 0.)
    await vi.advanceTimersByTimeAsync(10);
    expect(h.sentIds()).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);

    // A short batch: the next pass waits the 30 s.
    h.store.saveSttUsage(usage('m6', 6_000));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.sentIds()).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.sentIds()).toHaveLength(6);
    await h.uploader.stop();
  });

  it('stops at quit once the request out has answered, and sends nothing after', async () => {
    const h = harness();
    const out = deferred();
    h.save.mockImplementationOnce(() => out.promise);
    h.store.saveSttUsage(usage('m1', 0, { stopReason: 'quit' }));
    h.uploader.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(h.uploader.quitHook.name).toBe('stop the speech-to-text usage uploader');
    let stopped = false;
    const stopping = Promise.resolve(h.uploader.quitHook.run()).then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    out.resolve();
    await stopping;
    // Marked before the store closes, so the next launch does not send it again.
    expect(h.waiting()).toEqual([]);

    h.store.saveSttUsage(usage('m2', 1_000));
    h.uploader.sendNow();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.sentIds()).toEqual(['m1']);
  });

  it('sends no further row of a pass once quit has come: one request at most to wait for', async () => {
    const h = harness();
    const out = deferred();
    h.save.mockImplementationOnce(() => out.promise);
    h.store.saveSttUsage(usage('m1'));
    h.store.saveSttUsage(usage('m2', 1_000));
    h.uploader.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sentIds()).toEqual(['m1']);

    const stopping = h.uploader.quitHook.run();
    out.resolve();
    await stopping;
    // m1 answered and is marked; m2 was never sent, and waits for the next launch.
    expect(h.sentIds()).toEqual(['m1']);
    expect(h.waiting()).toEqual(['m2']);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.sentIds()).toEqual(['m1']);
  });

  it('sends nothing before start', async () => {
    const h = harness();
    h.store.saveSttUsage(usage('m1'));
    h.uploader.sendNow();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.sentIds()).toEqual([]);
  });
});

describe('SttUsageUploader on the SQLite store', () => {
  it('sends a row once, and again after the next save', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'roger-usage-')), 'roger.sqlite');
    const store = new SqliteTranscriptStore(path);
    const h = harness({ store });
    store.saveSttUsage(usage('m1'));
    h.uploader.start();
    await vi.waitFor(() => {
      expect(h.waiting()).toEqual([]);
    });
    store.saveSttUsage(usage('m1', 1_000, { stopReason: 'user' }));
    h.uploader.sendNow();
    await vi.waitFor(() => {
      expect(h.waiting()).toEqual([]);
    });
    await h.uploader.stop();
    expect(
      h.save.mock.calls.map(([sent]) => [sent.meetingId, sent.stopReason, sent.gatedMs]),
    ).toEqual([
      ['m1', null, 0],
      ['m1', 'user', 0],
    ]);
    store.close();
  });
});
