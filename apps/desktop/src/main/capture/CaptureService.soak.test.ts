import { getHeapSpaceStatistics, setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SttTokenApi, UploadApi } from '../api/ApiClient';
import { createLogger } from '../logger';
import { SqliteTranscriptStore } from '../store/SqliteTranscriptStore';
import { FakeSpeechToText } from '../stt/fake/FakeSpeechToText';
import { TranscriptUploader } from '../upload/TranscriptUploader';
import { CaptureService } from './CaptureService';

/**
 * M2's 2-hour soak (M2 plan, Tests), through the whole service: the fan-out, the session, the
 * fake vendor's streams, the status monitor and SQLite, on a fake clock. CaptureSession.test.ts
 * covers the session alone over the same 2 hours; this one also proves that nothing in the
 * service keeps what a chunk or a line leaves behind.
 */

/** Two hours of 100 ms chunks, per stream. */
const CHUNKS = 72_000;
const CHUNK_MS = 100;
/** FakeSpeechToText's default window: one final line per 2 s of audio, per stream. */
const LINE_MS = 2_000;
const LINES_PER_STREAM = (CHUNKS * CHUNK_MS) / LINE_MS;
/** Call audio is captured this far behind the mic, so the two streams are out of phase. */
const SYSTEM_LAG_MS = 40;
const START = Date.parse('2026-10-07T09:00:00.000Z');

/**
 * What the second hour may add to the live data: the heap's data spaces and the typed arrays'
 * backing stores, measured at the same point of the loop after each hour. A clean run shrinks by
 * about 0.3 MB (Node 22.19). Keeping every chunk of that hour adds about 230 MB, a small object per
 * chunk about 4 MB, and every line in a list in memory about 1.5 MB: lines belong in SQLite,
 * outside the JS heap.
 */
const SECOND_HOUR_GROWTH_BYTES = 512 * 1024;

/**
 * Where V8 keeps compiled code and bytecode, left out of the measure: it flushes the bytecode of
 * functions not run for a while (Start's, the modules' setup), about 1 MB here between the two
 * hours, on its own schedule rather than on anything the soak does.
 */
const CODE_SPACES = new Set([
  'code_space',
  'code_large_object_space',
  'trusted_space',
  'trusted_large_object_space',
]);

/**
 * A full collection. A Vitest worker has no `gc`: the flag set at run time reaches only contexts
 * made after it, so a fresh vm context hands the function out. Made once: each context is a whole
 * new global.
 */
setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void; // a function once the flag is set (see above)

/**
 * Collects and answers the bytes of live data (CODE_SPACES aside) and of typed arrays' backing
 * stores. A backing store is freed a tick after the collection that found it dead, hence a real
 * setImmediate (left out of the fake timers) between two passes.
 */
async function liveBytes(): Promise<number> {
  for (let pass = 0; pass < 2; pass += 1) {
    gc();
    await new Promise((resolve) => setImmediate(resolve));
  }
  const data = getHeapSpaceStatistics()
    .filter(({ space_name: space }) => !CODE_SPACES.has(space))
    .reduce((bytes, space) => bytes + space.space_used_size, 0);
  return data + process.memoryUsage().arrayBuffers;
}

/** A fresh 100 ms chunk of loud PCM, so the fake vendor writes a line for every window. */
function voice(): Uint8Array {
  return new Uint8Array(3200).fill(64);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('CaptureService over a 2-hour call', () => {
  it('stores every line at its offset with both sessions open throughout, and keeps no audio', async () => {
    vi.useFakeTimers({
      now: START,
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    const logged = new Map<string, number>();
    const logger = createLogger({
      level: 'info',
      format: 'json',
      sink: (line) => {
        const { level, message } = JSON.parse(line) as { level: string; message: string };
        const key = `${level} ${message}`;
        logged.set(key, (logged.get(key) ?? 0) + 1);
      },
    });
    const store = new SqliteTranscriptStore(':memory:');
    const noApi = (): Promise<never> => Promise.reject(new Error('the soak has no API'));
    const api: SttTokenApi & UploadApi = {
      getSttToken: noApi,
      createMeeting: noApi,
      appendSegments: noApi,
      endMeeting: noApi,
    };
    const service = new CaptureService({
      store,
      api,
      // Never started: uploads are TranscriptUploader's soak, not this one.
      uploader: new TranscriptUploader({ store, api, logger }),
      createSpeechToText: () => new FakeSpeechToText({ clock: () => Date.now() }),
      ensureMicrophoneAccess: () => Promise.resolve('granted'),
      logger,
      sttProviderOverride: 'fake',
      startupError: null,
    });

    const started = await service.start();
    expect(started.phase).toBe('recording');
    const meetingId = started.meetingId ?? '';
    // Both chunks of a step arrive together, as the call audio's ends: the mic's 40 ms late.
    vi.advanceTimersByTime(SYSTEM_LAG_MS);
    // Measured at the same point of the loop each hour, so only what the hour left behind differs.
    const liveAfterHour: number[] = [];
    for (let i = 0; i < CHUNKS; i += 1) {
      vi.advanceTimersByTime(CHUNK_MS); // the status monitor ticks every 5 chunks
      const micAt = START + i * CHUNK_MS;
      service.pushAudio('mic', voice(), micAt);
      service.pushAudio('system', voice(), micAt + SYSTEM_LAG_MS);
      if ((i + 1) % (CHUNKS / 2) === 0) liveAfterHour.push(await liveBytes());
    }
    const [afterFirstHour = 0, afterSecondHour = 0] = liveAfterHour;

    const recording = service.getStatus();
    expect(recording).toMatchObject({
      phase: 'recording',
      streams: { mic: 'open', system: 'open' },
      segmentsStored: 2 * LINES_PER_STREAM,
      segmentsUnsaved: 0,
      error: null,
    });
    expect(recording.sources.mic).toMatchObject({ health: 'active', chunks: CHUNKS });
    expect(recording.sources.system).toMatchObject({ health: 'active', chunks: CHUNKS });

    // Every line stored, each at its own window of the meeting to the ms, up to the last ones at
    // 7,198,000 ms (the mic) and 7,198,040 ms (call audio).
    const lines = store.listSegments(meetingId);
    expect(lines).toHaveLength(2 * LINES_PER_STREAM);
    for (const source of ['mic', 'system'] as const) {
      const lagMs = source === 'system' ? SYSTEM_LAG_MS : 0;
      const offsets = lines
        .filter((line) => line.source === source)
        .map((line) => [line.startMs, line.endMs])
        .sort(([a = 0], [b = 0]) => a - b);
      const expected = Array.from({ length: LINES_PER_STREAM }, (_, k) => [
        k * LINE_MS + lagMs,
        (k + 1) * LINE_MS + lagMs,
      ]);
      expect(offsets, source).toEqual(expected);
    }

    // Nothing held what the second hour sent: no chunk, no line, no event in memory.
    expect(afterSecondHour - afterFirstHour).toBeLessThan(SECOND_HOUR_GROWTH_BYTES);

    const stopped = await service.stop({ flushUploads: false });
    expect(stopped).toMatchObject({ phase: 'idle', error: null });
    expect(store.getMeeting(meetingId)?.endedAt).not.toBeNull();
    // One session per stream the whole call: no stall close, no reopen, no gap.
    expect(store.listGaps(meetingId)).toEqual([]);
    expect(store.getSttUsage(meetingId)).toMatchObject({
      stopReason: 'user',
      bySource: {
        mic: { sessionsOpened: 1, audioSentMs: CHUNKS * CHUNK_MS },
        system: { sessionsOpened: 1, audioSentMs: CHUNKS * CHUNK_MS },
      },
    });
    // One run per stream: no chunk was ever dated off its stream's timeline.
    expect(logged.get('info audio timeline: new run')).toBeUndefined();
    expect([...logged.keys()].filter((key) => !key.startsWith('info '))).toEqual([]);
    store.close();
  }, 120_000);
});
