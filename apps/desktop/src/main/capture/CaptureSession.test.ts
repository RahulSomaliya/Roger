import { describe, expect, it } from 'vitest';
import type { AudioSource, TranscriptSegment } from '../../shared/transcript';
import { createLogger } from '../logger';
import { InMemoryTranscriptStore } from '../store/InMemoryTranscriptStore';
import {
  type OpenStreamOptions,
  type SpeechToText,
  SttEventEmitter,
  type SttEventListener,
  type SttStream,
} from '../stt/SpeechToText';
import type { SttUsage } from '../stt/usage';
import {
  CaptureSession,
  type CaptureSessionListeners,
  type CaptureSessionOptions,
} from './CaptureSession';
import { SttOpenBudget } from './SttOpenBudget';

const logger = createLogger({ level: 'error', format: 'json', sink: () => undefined });
const settings = {
  model: 'm',
  language: 'en',
  sampleRate: 16000,
  encoding: 'linear16',
  pricePerHourUsd: null,
};

class ScriptedStream implements SttStream {
  readonly emitter = new SttEventEmitter();
  readonly sent: Uint8Array[] = [];
  closed = false;
  send(pcm: Uint8Array): void {
    this.sent.push(pcm);
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
  on(listener: SttEventListener): () => void {
    return this.emitter.on(listener);
  }
}

/** Streams open when the test says so, in any order. */
class ControlledSpeechToText implements SpeechToText {
  readonly provider = 'scripted';
  readonly vendorName = 'Scripted';
  usage(): SttUsage {
    return {
      sessionsOpened: 0,
      connectedMs: 0,
      audioSentMs: 0,
      droppedChunks: 0,
      estimatedCostUsd: 0,
    };
  }
  readonly streams = new Map<string, ScriptedStream>();
  private readonly pending = new Map<
    string,
    { resolve: (s: SttStream) => void; reject: (e: Error) => void }
  >();
  /** Labels of every openStream call, in order. */
  readonly opens: string[] = [];
  openStream(options: OpenStreamOptions): Promise<SttStream> {
    this.opens.push(options.label);
    return new Promise((resolve, reject) => {
      this.pending.set(options.label, { resolve, reject });
    });
  }
  succeed(label: string): ScriptedStream {
    const stream = new ScriptedStream();
    this.streams.set(label, stream);
    this.pending.get(label)?.resolve(stream);
    return stream;
  }
  fail(label: string, error: Error): void {
    this.pending.get(label)?.reject(error);
  }
}

/** A store whose next `appendSegment` throws, like a full disk or SQLite busy past its timeout. */
class FailingStore extends InMemoryTranscriptStore {
  failNext: Error | null = null;
  override appendSegment(segment: TranscriptSegment): void {
    const error = this.failNext;
    this.failNext = null;
    if (error) throw error;
    super.appendSegment(segment);
  }
}

function listeners(): CaptureSessionListeners & {
  failures: [AudioSource, string, number | null][];
  saveFailures: [AudioSource, string][];
  shown: string[];
  states: string[];
} {
  const failures: [AudioSource, string, number | null][] = [];
  const saveFailures: [AudioSource, string][] = [];
  const shown: string[] = [];
  const states: string[] = [];
  return {
    failures,
    saveFailures,
    shown,
    states,
    onSegment: (segment) => {
      shown.push(segment.text);
    },
    onSaveFailure: (source, reason) => {
      saveFailures.push([source, reason]);
    },
    onInterim: () => undefined,
    onStreamClosed: () => undefined,
    onStreamState: (source, state) => {
      states.push(`${source}:${state}`);
    },
    onStreamFailure: (source, reason, retryAtMs) => {
      failures.push([source, reason, retryAtMs]);
    },
  };
}

function session(
  stt: SpeechToText,
  l: CaptureSessionListeners,
  clock: () => number = () => 10_000,
  store: InMemoryTranscriptStore = new InMemoryTranscriptStore(),
  overrides: Partial<CaptureSessionOptions> = {},
) {
  return new CaptureSession({
    meetingId: 'm1',
    meetingStartedAtMs: 10_000,
    stt,
    accessToken: 't',
    settings,
    refreshCredentials: () => Promise.resolve({ accessToken: 'fresh', settings }),
    reopenBufferMs: 3_000,
    budget: openBudget(clock),
    reopenBackoffMs: 2_000,
    reopenBackoffMaxMs: 60_000,
    store,
    logger,
    listeners: l,
    clock,
    ...overrides,
  });
}

function openBudget(clock: () => number): SttOpenBudget {
  const budget = new SttOpenBudget({ perMinute: 100, perMeeting: 100 }, clock);
  budget.beginMeeting();
  return budget;
}

/** Lets every pending promise callback run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A promise the test settles by hand. */
function gate<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('CaptureSession', () => {
  it('closes a stream that opens after another one failed, so no socket leaks', async () => {
    const stt = new ControlledSpeechToText();
    const l = listeners();
    const opening = session(stt, l).open();
    stt.fail('mic', new Error('mic refused'));
    const system = stt.succeed('system');
    await expect(opening).rejects.toThrow('mic refused');
    expect(system.closed).toBe(true);
  });

  it('reports a stream that the vendor closes mid-call as a failure, but keeps the other stream', async () => {
    const stt = new ControlledSpeechToText();
    const l = listeners();
    const s = session(stt, l);
    const opening = s.open();
    const mic = stt.succeed('mic');
    const system = stt.succeed('system');
    await opening;

    system.emitter.emit({ type: 'closed', code: 1011, reason: 'timeout' });
    // Reopens with its next chunk after the first backoff (2 s on this session's clock).
    expect(l.failures).toEqual([['system', 'connection closed (code 1011: timeout)', 12_000]]);
    expect(l.states.at(-1)).toBe('system:retrying');
    expect(system.closed).toBe(true); // the dead stream is closed, not only forgotten

    s.pushAudio('mic', new Uint8Array(3200));
    s.pushAudio('system', new Uint8Array(3200));
    expect(mic.sent).toHaveLength(1);
    expect(system.sent).toHaveLength(0);

    await s.close();
    expect(mic.closed).toBe(true);
  });

  it('closes only the session of a source that failed, and never reports that close', async () => {
    const stt = new ControlledSpeechToText();
    const l = listeners();
    const s = session(stt, l);
    const opening = s.open();
    const mic = stt.succeed('mic');
    const system = stt.succeed('system');
    await opening;

    s.closeSource('system', 'No screen source is available for system audio');
    expect(system.closed).toBe(true);
    expect(mic.closed).toBe(false);
    expect(l.states.at(-1)).toBe('system:closed');
    system.emitter.emit({ type: 'closed', code: 1000, reason: null });
    expect(l.failures).toEqual([]);

    s.pushAudio('system', new Uint8Array(3200));
    s.pushAudio('mic', new Uint8Array(3200));
    expect(system.sent).toHaveLength(0);
    expect(mic.sent).toHaveLength(1);
    await s.close();
    expect(mic.closed).toBe(true);
  });

  describe('a paused source', () => {
    async function paused(overrides: Partial<CaptureSessionOptions> = {}) {
      const stt = new ControlledSpeechToText();
      const l = listeners();
      let now = 10_000;
      const s = session(stt, l, () => now, new InMemoryTranscriptStore(), overrides);
      const opening = s.open();
      stt.succeed('mic');
      const system = stt.succeed('system');
      await opening;
      now = 40_000;
      s.pauseSource('system', 30_000);
      return {
        stt,
        l,
        s,
        system,
        at: (ms: number) => {
          now = ms;
        },
      };
    }

    it('closes its stream and opens none until audio returns', async () => {
      const { l, s, system } = await paused();
      expect(system.closed).toBe(true);
      expect(l.states.at(-1)).toBe('system:paused');
      system.emitter.emit({ type: 'closed', code: 1000, reason: null });
      expect(l.failures).toEqual([]);
      await s.close();
    });

    it('holds at most the reopen buffer while it reconnects, dropping the oldest audio', async () => {
      const credentials = gate<{ accessToken: string; settings: typeof settings }>();
      const { stt, s, at } = await paused({ refreshCredentials: () => credentials.promise });
      // 50 chunks of 100 ms arrive while the token is fetched; 3 s may wait.
      for (let i = 0; i < 50; i += 1) {
        at(50_000 + i * 100);
        s.pushAudio('system', new Uint8Array(3200).fill(i));
      }
      credentials.resolve({ accessToken: 'fresh', settings });
      await flush();
      const reopened = stt.succeed('system');
      await flush();
      expect(reopened.sent.map((pcm) => pcm[0])).toEqual(
        Array.from({ length: 30 }, (_, i) => i + 20),
      );
      await s.close();
    });

    it('never carries audio from before a gap into a reopened stream', async () => {
      const credentials = gate<{ accessToken: string; settings: typeof settings }>();
      const { stt, s, at } = await paused({ refreshCredentials: () => credentials.promise });
      at(50_000);
      s.pushAudio('system', new Uint8Array(3200).fill(1));
      at(55_000); // the source went quiet again for 5 s: that gap is not in the vendor's audio
      s.pushAudio('system', new Uint8Array(3200).fill(2));
      credentials.resolve({ accessToken: 'fresh', settings });
      await flush();
      const reopened = stt.succeed('system');
      await flush();
      expect(reopened.sent.map((pcm) => pcm[0])).toEqual([2]);
      await s.close();
    });

    it('closes a reopen that lands after the source closed, and Stop waits for it', async () => {
      const { stt, l, s } = await paused();
      s.pushAudio('system', new Uint8Array(3200));
      await flush(); // the fresh token is in; the vendor is still connecting
      expect(stt.opens).toEqual(['mic', 'system', 'system']);
      expect(l.states.at(-1)).toBe('system:connecting');
      s.closeSource('system', 'The audio device stopped delivering audio');

      const closing = s.close();
      const late = stt.succeed('system');
      await closing;
      expect(late.closed).toBe(true);
      expect(late.sent).toHaveLength(0);
    });

    it('opens nothing when the source closes before its fresh token arrives', async () => {
      const credentials = gate<{ accessToken: string; settings: typeof settings }>();
      const { stt, s } = await paused({ refreshCredentials: () => credentials.promise });
      s.pushAudio('system', new Uint8Array(3200));
      s.closeSource('system', 'The audio device stopped delivering audio');
      credentials.resolve({ accessToken: 'fresh', settings });
      await flush();
      expect(stt.opens).toEqual(['mic', 'system']);
      await s.close();
    });

    it('shows a failed reopen with the reason, and tries again only after the backoff', async () => {
      let tokenRequests = 0;
      const { l, s, at } = await paused({
        refreshCredentials: () => {
          tokenRequests += 1;
          return Promise.reject(new Error('API unreachable'));
        },
      });
      s.pushAudio('system', new Uint8Array(3200));
      await flush();
      expect(l.states.at(-1)).toBe('system:retrying');
      expect(l.failures.at(-1)).toEqual(['system', 'could not reconnect: API unreachable', 42_000]);
      at(41_900);
      s.pushAudio('system', new Uint8Array(3200));
      await flush();
      expect(tokenRequests).toBe(1); // ten chunks a second must not mean ten token requests
      at(42_000);
      s.pushAudio('system', new Uint8Array(3200));
      await flush();
      expect(tokenRequests).toBe(2);
      await s.close();
    });
  });

  it('does not report the close it asked for', async () => {
    const stt = new ControlledSpeechToText();
    const l = listeners();
    const s = session(stt, l);
    const opening = s.open();
    const mic = stt.succeed('mic');
    stt.succeed('system');
    await opening;
    await s.close();
    mic.emitter.emit({ type: 'closed', code: 1000, reason: null });
    expect(l.failures).toEqual([]);
  });

  it('reports a line it could not save locally, still shows it, and keeps recording', async () => {
    const stt = new ControlledSpeechToText();
    const l = listeners();
    const store = new FailingStore();
    const s = session(stt, l, () => 10_000, store);
    const opening = s.open();
    const mic = stt.succeed('mic');
    stt.succeed('system');
    await opening;
    const final = (text: string) => {
      mic.emitter.emit({ type: 'final', text, startMs: 0, endMs: 100, confidence: 1, words: [] });
    };

    store.failNext = new Error('database or disk is full');
    final('lost line');
    expect(l.saveFailures).toEqual([['mic', 'database or disk is full']]);
    expect(l.shown).toEqual(['lost line']);
    expect(s.storedSegmentCount).toBe(0);
    expect(store.countSegments('m1')).toBe(0);

    final('kept line');
    expect(s.storedSegmentCount).toBe(1);
    expect(store.countSegments('m1')).toBe(1);
    expect(l.failures).toEqual([]);
    await s.close();
  });

  it('dates the first chunk from when its audio was captured, not when it arrived', async () => {
    const stt = new ControlledSpeechToText();
    const l = listeners();
    let now = 10_000;
    const s = session(stt, l, () => now);
    const opening = s.open();
    const mic = stt.succeed('mic');
    stt.succeed('system');
    await opening;
    const store = new InMemoryTranscriptStore();
    const segments: number[] = [];
    const withStore = new CaptureSession({
      meetingId: 'm2',
      meetingStartedAtMs: 10_000,
      stt,
      accessToken: 't',
      settings,
      refreshCredentials: () => Promise.resolve({ accessToken: 'fresh', settings }),
      reopenBufferMs: 3_000,
      budget: openBudget(() => now),
      reopenBackoffMs: 2_000,
      reopenBackoffMaxMs: 60_000,
      store,
      logger,
      listeners: { ...l, onSegment: (segment) => segments.push(segment.startMs) },
      clock: () => now,
    });
    const opening2 = withStore.open();
    const mic2 = stt.succeed('mic');
    stt.succeed('system');
    await opening2;
    now = 12_100; // a 100 ms chunk arrives 2.1 s into the meeting: it was captured at 2.0 s
    withStore.pushAudio('mic', new Uint8Array(3200));
    mic2.emitter.emit({
      type: 'final',
      text: 'hi',
      startMs: 500,
      endMs: 900,
      confidence: 1,
      words: [],
    });
    expect(segments).toEqual([2500]);
    expect(mic.sent).toHaveLength(0);
  });
});
