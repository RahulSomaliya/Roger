import { describe, expect, it } from 'vitest';
import type { ContextClock } from './captureClock';
import type { PcmWorkletChunk, PcmWorkletOptions } from './pcm-worklet-contract';
import { type CaptureGraph, PcmStreamCapture } from './PcmStreamCapture';
import { FakeStream, FakeTrack } from './testing/fakeMedia';

const RATE = 16_000;
const WALL = 1_765_000_000_000;

/** The AudioContext, worklet and source nodes, as PcmStreamCapture drives them. */
class FakeGraph implements CaptureGraph<FakeStream> {
  worklets: PcmWorkletOptions[] = [];
  /** The streams fed into the worklet now, in the order they were plugged in. */
  plugged: FakeStream[] = [];
  flushes = 0;
  resumed = false;
  closed = false;
  clock: ContextClock = {
    outputTimestamp: { contextTime: 10, performanceTime: 5_000 },
    currentTime: 10.2,
  };
  private onChunk: ((chunk: PcmWorkletChunk) => void) | null = null;

  constructor(readonly sampleRate: number) {}

  startWorklet(options: PcmWorkletOptions, onChunk: (chunk: PcmWorkletChunk) => void) {
    this.worklets.push(options);
    this.onChunk = onChunk;
    return Promise.resolve();
  }

  connect(stream: FakeStream): () => void {
    this.plugged.push(stream);
    return () => {
      this.plugged = this.plugged.filter((plugged) => plugged !== stream);
    };
  }

  flush(): void {
    this.flushes += 1;
  }

  readClock(): ContextClock {
    return this.clock;
  }

  resume(): Promise<void> {
    this.resumed = true;
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  /** The worklet posts a chunk whose first sample is `frame`. */
  post(frame: number): ArrayBuffer {
    const pcm = new ArrayBuffer(3_200);
    this.onChunk?.({ pcm, frame });
    return pcm;
  }
}

function harness(contextRate = RATE) {
  const graphs: FakeGraph[] = [];
  const chunks: [ArrayBuffer, number][] = [];
  /** performance.now() and Date.now() as the page reads them. */
  const page = { performanceNow: 5_200, dateNow: WALL };
  const capture = new PcmStreamCapture<FakeStream>(
    {
      source: 'mic',
      sampleRate: RATE,
      chunkSamples: 1_600,
      onChunk: (pcm, capturedAtMs) => chunks.push([pcm, capturedAtMs]),
    },
    () => {
      const graph = new FakeGraph(contextRate);
      graphs.push(graph);
      return graph;
    },
    () => ({ ...page }),
  );
  const graph = () => {
    const only = graphs[0];
    if (graphs.length !== 1 || only === undefined) throw new Error(`${graphs.length} graphs`);
    return only;
  };
  return { capture, chunks, graph, graphs, page };
}

describe('PcmStreamCapture', () => {
  it('feeds the stream through the worklet and dates each chunk on the wall clock', async () => {
    const h = harness();
    const stream = new FakeStream();
    await h.capture.start(stream);
    expect(h.graph().worklets).toEqual([{ chunkSamples: 1_600 }]);
    expect(h.graph().plugged).toEqual([stream]);
    expect(h.graph().resumed).toBe(true);

    // Frame 9.9 s played at 4900 ms on the monotonic clock; read at 5200 ms it is 300 ms old.
    const pcm = h.graph().post(9.9 * RATE);
    expect(h.chunks).toHaveLength(1);
    expect(h.chunks[0]?.[0]).toBe(pcm);
    expect(h.chunks[0]?.[1]).toBeCloseTo(WALL - 300, 6);
  });

  it('maps every chunk with the clocks read when it arrives, not once per capture', async () => {
    // Anchoring once drifts: a recording that lives through a sleep would date later chunks
    // early (AudioChunkMessage.capturedAtMs).
    const h = harness();
    await h.capture.start(new FakeStream());
    h.graph().post(9.9 * RATE);
    // An hour asleep, then 10 s of audio: the monotonic clocks moved 10 s, the wall clock 1 h 10 s.
    h.graph().clock = {
      outputTimestamp: { contextTime: 20, performanceTime: 15_000 },
      currentTime: 20.2,
    };
    h.page.performanceNow = 15_200;
    h.page.dateNow = WALL + 3_610_000;
    h.graph().post(19.9 * RATE);
    expect(h.chunks.map(([, at]) => Math.round(at))).toEqual([WALL - 300, WALL + 3_609_700]);
  });

  it('swaps a new stream into the same worklet node, and ends the old stream', async () => {
    const h = harness();
    const first = new FakeStream();
    const second = new FakeStream(new FakeTrack('AirPods Pro'));
    await h.capture.start(first);
    h.capture.replaceStream(second);

    // One graph and one worklet: its partial chunk and frame count carry on across the swap.
    expect(h.graph().worklets).toHaveLength(1);
    expect(h.graph().plugged).toEqual([second]);
    expect(first.track.stopped).toBe(true);
    expect(second.track.stopped).toBe(false);
    h.graph().post(9.9 * RATE);
    expect(h.chunks).toHaveLength(1);

    await h.capture.stop();
    expect(second.track.stopped).toBe(true);
  });

  it('refuses a swap while it is not running', () => {
    expect(() => {
      harness().capture.replaceStream(new FakeStream());
    }).toThrow(/not running/);
  });

  it('refuses a stream whose track is missing or already ended', async () => {
    const ended = new FakeTrack();
    ended.end();
    await expect(harness().capture.start(new FakeStream(ended))).rejects.toThrow(/ended/);
    const empty = { getAudioTracks: () => [], getTracks: () => [] };
    await expect(
      new PcmStreamCapture<typeof empty>(
        { source: 'mic', sampleRate: RATE, chunkSamples: 1_600, onChunk: () => undefined },
        () => {
          throw new Error('no graph for a stream without a track');
        },
      ).start(empty),
    ).rejects.toThrow(/no audio track/);
  });

  it('refuses a context Chromium runs at another rate, and stop closes it', async () => {
    const h = harness(48_000);
    await expect(h.capture.start(new FakeStream())).rejects.toThrow(/48000 Hz/);
    await h.capture.stop();
    expect(h.graph().closed).toBe(true);
  });

  it('stop asks for the partial chunk, then unplugs the stream, ends its tracks, closes', async () => {
    const h = harness();
    const stream = new FakeStream();
    await h.capture.start(stream);
    await h.capture.stop();
    expect(h.graph().flushes).toBe(1);
    expect(h.graph().plugged).toEqual([]);
    expect(stream.track.stopped).toBe(true);
    expect(h.graph().closed).toBe(true);
  });
});
