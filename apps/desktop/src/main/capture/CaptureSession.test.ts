import { describe, expect, it } from 'vitest';
import type { AudioSource, InterimTranscript, TranscriptSegment } from '../../shared/transcript';
import { createLogger, type Logger } from '../logger';
import { InMemoryTranscriptStore } from '../store/InMemoryTranscriptStore';
import {
  type OpenStreamOptions,
  type SpeechToText,
  SttConnectError,
  SttEventEmitter,
  type SttEventListener,
  type SttStream,
} from '../stt/SpeechToText';
import type { SttUsage } from '../stt/usage';
import {
  CaptureSession,
  type CaptureSessionListeners,
  type CaptureSessionOptions,
  type SessionWarning,
  type SourceWatermark,
  type StreamCredentials,
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
  /** Dropped with no finish sequence (the offline suspend), rather than finished and closed. */
  terminated = false;
  /**
   * Set by a test to play a vendor still finishing, sending its last lines (Stop's flush, a pause):
   * close() stays pending until the test resolves it, or until a terminate cuts the finish short,
   * as SttConnection's does. The one way this double holds a close open.
   */
  finishing: Gate<undefined> | null = null;
  send(pcm: Uint8Array): void {
    this.sent.push(pcm);
  }
  close(): Promise<void> {
    this.closed = true;
    return this.finishing?.promise ?? Promise.resolve();
  }
  terminate(): Promise<void> {
    this.terminated = true;
    this.closed = true;
    this.finishing?.resolve(undefined);
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
  /** What every openStream call asked for, in order. */
  readonly openOptions: OpenStreamOptions[] = [];
  openStream(options: OpenStreamOptions): Promise<SttStream> {
    this.opens.push(options.label);
    this.openOptions.push(options);
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
  segments: TranscriptSegment[];
  interims: InterimTranscript[];
  states: string[];
  /** The message each state came with, `${source}:${state}:${message}`. */
  stateMessages: string[];
  warnings: [AudioSource, SessionWarning][];
} {
  const failures: [AudioSource, string, number | null][] = [];
  const saveFailures: [AudioSource, string][] = [];
  const shown: string[] = [];
  const segments: TranscriptSegment[] = [];
  const interims: InterimTranscript[] = [];
  const states: string[] = [];
  const stateMessages: string[] = [];
  const warnings: [AudioSource, SessionWarning][] = [];
  return {
    failures,
    saveFailures,
    shown,
    segments,
    interims,
    states,
    stateMessages,
    warnings,
    onSegment: (segment) => {
      shown.push(segment.text);
      segments.push(segment);
    },
    onSaveFailure: (source, reason) => {
      saveFailures.push([source, reason]);
    },
    onInterim: (interim) => {
      interims.push(interim);
    },
    onStreamClosed: () => undefined,
    onStreamState: (source, state, message) => {
      states.push(`${source}:${state}`);
      stateMessages.push(`${source}:${state}:${message ?? ''}`);
    },
    onStreamFailure: (source, reason, retryAtMs) => {
      failures.push([source, reason, retryAtMs]);
    },
    onWarning: (source, warning) => {
      warnings.push([source, warning]);
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

interface Gate<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

/** A promise the test settles by hand. */
function gate<T>(): Gate<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** One final from the vendor, its times on the stream's own clock; one word per pair in `words`. */
function final(
  stream: ScriptedStream,
  text: string,
  startMs: number,
  endMs: number,
  words: [number, number][] = [],
): void {
  stream.emitter.emit({
    type: 'final',
    text,
    startMs,
    endMs,
    confidence: 1,
    words: words.map(([wordStart, wordEnd], i) => ({
      text: `w${i}`,
      startMs: wordStart,
      endMs: wordEnd,
      confidence: 1,
    })),
  });
}

/** A logger whose lines the test reads back. */
function recordingLogger(): { logger: Logger; messages: Record<string, unknown>[] } {
  const messages: Record<string, unknown>[] = [];
  const recorder = createLogger({
    level: 'info',
    format: 'json',
    sink: (line) => messages.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { logger: recorder, messages };
}

/** A store that knows meeting m1 (started at 10 s), so its gap rows and capture events save. */
function meetingStore(): InMemoryTranscriptStore {
  const store = new InMemoryTranscriptStore();
  store.createMeeting({ id: 'm1', title: 'T', startedAt: new Date(10_000).toISOString() });
  return store;
}

/** Starts a session on a test clock with both streams open. */
async function recording(overrides: Partial<CaptureSessionOptions> = {}) {
  const stt = new ControlledSpeechToText();
  const l = listeners();
  let now = 10_000;
  const store = meetingStore();
  const s = session(stt, l, () => now, store, overrides);
  const opening = s.open();
  const mic = stt.succeed('mic');
  const system = stt.succeed('system');
  await opening;
  return {
    stt,
    l,
    s,
    store,
    mic,
    system,
    at: (ms: number) => {
      now = ms;
    },
  };
}

/** Pushes `count` contiguous 100 ms chunks of `source`, the first captured at `fromMs`. */
function pushContiguous(
  s: CaptureSession,
  source: AudioSource,
  fromMs: number,
  count: number,
): void {
  for (let i = 0; i < count; i += 1) s.pushAudio(source, new Uint8Array(3200), fromMs + i * 100);
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

    s.pushAudio('mic', new Uint8Array(3200), 10_000);
    s.pushAudio('system', new Uint8Array(3200), 10_000);
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

    s.pushAudio('system', new Uint8Array(3200), 10_000);
    s.pushAudio('mic', new Uint8Array(3200), 10_000);
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
        s.pushAudio('system', new Uint8Array(3200).fill(i), 50_000 + i * 100);
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

    it('sends held audio from both sides of a gap, each side dated where it was captured', async () => {
      const credentials = gate<{ accessToken: string; settings: typeof settings }>();
      const { stt, l, s, at } = await paused({ refreshCredentials: () => credentials.promise });
      at(50_000);
      s.pushAudio('system', new Uint8Array(3200).fill(1), 49_900);
      at(55_000); // the source went quiet again for 5 s while the token was fetched
      s.pushAudio('system', new Uint8Array(3200).fill(2), 54_900);
      credentials.resolve({ accessToken: 'fresh', settings });
      await flush();
      const reopened = stt.succeed('system');
      await flush();
      // Both are sent (M1 dropped the audio before the gap); the vendor hears 200 ms with no hole.
      expect(reopened.sent.map((pcm) => pcm[0])).toEqual([1, 2]);
      final(reopened, 'before the gap', 20, 80);
      final(reopened, 'after the gap', 120, 180);
      // The meeting started at 10 s: the second line was said 5 s after the first, not 100 ms.
      expect(l.segments.map(({ startMs, endMs }) => [startMs, endMs])).toEqual([
        [39_920, 39_980],
        [44_920, 44_980],
      ]);
      await s.close();
    });

    it('closes a reopen that lands after the source closed, and Stop waits for it', async () => {
      const { stt, l, s } = await paused();
      s.pushAudio('system', new Uint8Array(3200), 40_000);
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
      s.pushAudio('system', new Uint8Array(3200), 40_000);
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
      s.pushAudio('system', new Uint8Array(3200), 40_000);
      await flush();
      expect(l.states.at(-1)).toBe('system:retrying');
      expect(l.failures.at(-1)).toEqual(['system', 'could not reconnect: API unreachable', 42_000]);
      at(41_900);
      s.pushAudio('system', new Uint8Array(3200), 41_900);
      await flush();
      expect(tokenRequests).toBe(1); // ten chunks a second must not mean ten token requests
      at(42_000);
      s.pushAudio('system', new Uint8Array(3200), 42_000);
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

  /**
   * M2-T6: the offline and asleep suspends, gap rows, capture events and the watermark, on top of
   * the landed reopen. A gap is audio that reached main and got no line; a window with no audio at
   * all (a stall) is only a capture event.
   */
  describe('suspends, gaps and watermarks', () => {
    const chunk = (): Uint8Array => new Uint8Array(3200);

    /** A credentials source that counts token fetches. */
    function countedCredentials(): {
      fetched: () => number;
      refreshCredentials: CaptureSessionOptions['refreshCredentials'];
    } {
      let count = 0;
      return {
        fetched: () => count,
        refreshCredentials: () => {
          count += 1;
          return Promise.resolve({ accessToken: 'fresh', settings });
        },
      };
    }

    function gaps(store: InMemoryTranscriptStore) {
      return store
        .listGaps('m1')
        .map(({ source, startMs, endMs, reason }) => ({ source, startMs, endMs, reason }));
    }

    function eventKinds(store: InMemoryTranscriptStore): string[] {
      return store.listCaptureEvents('m1').map(({ kind, source }) => `${source ?? '-'}:${kind}`);
    }

    it('goes offline at once: terminates both streams, holds audio, fetches no token, opens nothing', async () => {
      const credentials = countedCredentials();
      const { stt, l, s, mic, system, at } = await recording({
        refreshCredentials: credentials.refreshCredentials,
      });
      pushContiguous(s, 'mic', 10_000, 10);
      at(11_000);

      s.suspendStreams('offline');

      expect(mic.terminated).toBe(true);
      expect(system.terminated).toBe(true);
      expect(l.states.slice(-2)).toEqual(['mic:offline', 'system:offline']);
      for (let i = 0; i < 50; i += 1) {
        at(11_000 + i * 100);
        s.pushAudio('mic', chunk(), 11_000 + i * 100);
        s.pushAudio('system', chunk(), 11_000 + i * 100);
      }
      await flush();
      expect(credentials.fetched()).toBe(0);
      expect(stt.opens).toEqual(['mic', 'system']);
      // Not a vendor failure: the offline warning reads the state (M2-T11).
      expect(l.failures).toEqual([]);
      await s.close();
    });

    it('back online, each source reopens with its next chunk through the budget, with no backoff wait', async () => {
      let now = 10_000;
      const budget = openBudget(() => now);
      const { stt, l, s, system, at } = await recording({ budget });
      // The call audio stream had just failed: its backoff would hold a reopen until 12 s.
      system.emitter.emit({ type: 'closed', code: 1011, reason: 'timeout' });
      s.suspendStreams('offline');
      at(10_500);
      now = 10_500;

      s.resumeStreams('offline');
      expect(l.states.slice(-2)).toEqual(['mic:paused', 'system:paused']);
      s.pushAudio('mic', new Uint8Array(3200).fill(1), 10_400);
      s.pushAudio('system', new Uint8Array(3200).fill(2), 10_400);
      await flush();

      expect(stt.opens).toEqual(['mic', 'system', 'mic', 'system']);
      expect(budget.openedThisMeeting).toBe(4);
      const mic = stt.succeed('mic');
      const reopened = stt.succeed('system');
      await flush();
      expect(mic.sent.map((pcm) => pcm[0])).toEqual([1]);
      expect(reopened.sent.map((pcm) => pcm[0])).toEqual([2]);
      expect(l.states.slice(-2).sort()).toEqual(['mic:open', 'system:open']);
      await s.close();
    });

    it("records the window from the watermark to the new stream's first audio as one offline gap", async () => {
      const { stt, s, store, mic, at } = await recording();
      pushContiguous(s, 'mic', 10_000, 100); // stream 0-10 s, captured 10-20 s
      final(mic, 'last words', 7_000, 8_000); // the watermark: 8 s into the meeting
      at(20_000);
      s.suspendStreams('offline');
      // 30 s offline; only the newest 3 s are held for the reopen.
      for (let i = 0; i < 300; i += 1) {
        at(20_000 + i * 100);
        s.pushAudio('mic', chunk(), 20_000 + i * 100);
      }
      at(50_000);
      s.resumeStreams('offline');
      s.pushAudio('mic', chunk(), 50_000);
      await flush();
      const reopened = stt.succeed('mic');
      await flush();

      // The reopened stream carries 47.1 to 50.1 s: everything from the last line's end to that
      // is lost to the live transcript, for M2-T16 to re-run from the backup.
      expect(reopened.sent).toHaveLength(30);
      expect(gaps(store)).toEqual([
        { source: 'mic', startMs: 8_000, endMs: 37_100, reason: 'offline' },
      ]);
      await s.close();
      expect(gaps(store)).toHaveLength(1); // Stop adds none: nothing is lost after the reopen
    });

    it('takes a dead socket through the landed retrying path, and its lost window becomes an stt_failed gap', async () => {
      const { stt, l, s, store, system, at } = await recording();
      pushContiguous(s, 'system', 10_000, 50); // captured 10-15 s
      final(system, 'them', 1_000, 4_000);
      at(15_000);
      system.emitter.emit({
        type: 'error',
        message: 'Toy stopped answering: nothing received for 4 s',
        fatal: true,
      });
      expect(system.closed).toBe(true);
      expect(l.states.at(-1)).toBe('system:retrying');
      expect(l.failures.at(-1)).toEqual([
        'system',
        'Toy stopped answering: nothing received for 4 s',
        17_000,
      ]);

      // Audio goes on while the backoff runs; the reopen waits for it.
      for (let t = 15_000; t < 17_000; t += 100) {
        at(t);
        s.pushAudio('system', chunk(), t);
      }
      expect(stt.opens).toEqual(['mic', 'system']);
      at(17_000);
      s.pushAudio('system', chunk(), 17_000);
      await flush();
      const reopened = stt.succeed('system');
      await flush();

      expect(reopened.sent).toHaveLength(21);
      // From the last line's end (4 s) to the first held chunk (5 s): what the dead socket swallowed.
      expect(gaps(store)).toEqual([
        { source: 'system', startMs: 4_000, endMs: 5_000, reason: 'stt_failed' },
      ]);
      await s.close();
    });

    it('records a budget gap for the audio a refused reopen could not hold', async () => {
      const stt = new ControlledSpeechToText();
      const l = listeners();
      let now = 10_000;
      const store = meetingStore();
      const budget = new SttOpenBudget({ perMinute: 2, perMeeting: 100 }, () => now);
      budget.beginMeeting();
      const s = session(stt, l, () => now, store, { budget });
      const opening = s.open();
      stt.succeed('mic');
      stt.succeed('system');
      await opening;
      now = 40_000;
      s.pauseSource('system', 30_000);

      // Audio returns at 41 s, but Start's two opens fill the minute until 70 s.
      for (let t = 41_000; t < 70_000; t += 100) {
        now = t;
        s.pushAudio('system', chunk(), t);
      }
      await flush();
      expect(stt.opens).toEqual(['mic', 'system']);
      expect(l.states.at(-1)).toBe('system:retrying');
      now = 70_000;
      s.pushAudio('system', chunk(), 70_000);
      await flush();
      stt.succeed('system');
      await flush();

      expect(gaps(store)).toEqual([
        { source: 'system', startMs: 31_000, endMs: 57_100, reason: 'budget' },
      ]);
      await s.close();
    });

    it('records a stall with no audio as a capture event, never a gap', async () => {
      const { stt, s, store, at } = await recording();
      pushContiguous(s, 'system', 10_000, 10);
      at(41_000);
      s.pauseSource('system', 30_000);
      at(60_000);
      s.pushAudio('system', chunk(), 60_000);
      await flush();
      stt.succeed('system');
      await flush();

      expect(gaps(store)).toEqual([]);
      expect(eventKinds(store)).toEqual(['system:stt-paused', 'system:stt-reopened']);
      expect(store.listCaptureEvents('m1')[0]).toMatchObject({
        offsetMs: 31_000,
        detail: { silentForMs: 30_000 },
      });
      await s.close();
    });

    it('records at Stop the audio lost while offline, up to the last chunk', async () => {
      const { s, store, mic, at } = await recording();
      pushContiguous(s, 'mic', 10_000, 10); // offsets 0-1 s
      final(mic, 'hello', 0, 500);
      at(11_000);
      s.suspendStreams('offline');
      pushContiguous(s, 'mic', 11_000, 20); // offsets 1-3 s, never sent

      await s.close();

      expect(gaps(store)).toEqual([
        { source: 'mic', startMs: 500, endMs: 3_000, reason: 'offline' },
      ]);
    });

    it('keeps the loss of a source that gave up until Stop, which records it', async () => {
      let now = 10_000;
      const { s, store, system, at } = await recording({
        budget: (() => {
          const budget = new SttOpenBudget({ perMinute: 100, perMeeting: 2 }, () => now);
          budget.beginMeeting();
          return budget;
        })(),
      });
      pushContiguous(s, 'system', 10_000, 10);
      at(11_000);
      now = 11_000;
      system.emitter.emit({ type: 'closed', code: 1011, reason: 'timeout' });
      // The meeting's opens are spent: the source will not reopen, and its audio is dropped.
      pushContiguous(s, 'system', 11_000, 30);

      await s.close();

      expect(gaps(store)).toEqual([
        { source: 'system', startMs: 0, endMs: 4_000, reason: 'stt_failed' },
      ]);
    });

    it('finishes and closes both streams when the Mac sleeps, and opens nothing until resumed', async () => {
      const credentials = countedCredentials();
      const { stt, l, s, mic, system } = await recording({
        refreshCredentials: credentials.refreshCredentials,
      });

      s.suspendStreams('asleep');

      expect(mic.closed && system.closed).toBe(true);
      expect(mic.terminated || system.terminated).toBe(false);
      expect(l.states.slice(-2)).toEqual(['mic:paused', 'system:paused']);
      s.pushAudio('mic', chunk(), 10_000);
      await flush();
      expect(credentials.fetched()).toBe(0);
      expect(stt.opens).toEqual(['mic', 'system']);

      s.resumeStreams('asleep');
      s.pushAudio('mic', chunk(), 10_100);
      await flush();
      expect(credentials.fetched()).toBe(1);
      expect(stt.opens).toEqual(['mic', 'system', 'mic']);
      stt.succeed('mic'); // Stop waits for a reopen still connecting
      await s.close();
    });

    it('stacks offline and asleep: nothing reopens until both are lifted', async () => {
      const { stt, l, s } = await recording();
      s.suspendStreams('asleep');
      s.suspendStreams('offline');
      expect(l.states.slice(-2)).toEqual(['mic:offline', 'system:offline']);

      s.resumeStreams('asleep');
      s.pushAudio('mic', chunk(), 10_000);
      await flush();
      expect(stt.opens).toEqual(['mic', 'system']);
      expect(l.states.slice(-2)).toEqual(['mic:offline', 'system:offline']);

      s.suspendStreams('asleep');
      s.resumeStreams('offline');
      expect(l.states.slice(-2)).toEqual(['mic:paused', 'system:paused']);
      s.pushAudio('mic', chunk(), 10_100);
      await flush();
      expect(stt.opens).toEqual(['mic', 'system']);

      s.resumeStreams('asleep');
      s.pushAudio('mic', chunk(), 10_200);
      await flush();
      expect(stt.opens).toEqual(['mic', 'system', 'mic']);
      stt.succeed('mic'); // Stop waits for a reopen still connecting
      await s.close();
    });

    /**
     * A stream asked to finish (a sleep, a pause, a closed source, Stop) is no longer the source's,
     * so a finish that never completes loses the lines of its last audio with nothing else to say
     * so. Its tail, from its own last line to the end of the audio it was sent, is a gap.
     */
    describe('a finish cut short', () => {
      it("records a sleep's unfinished tail when going offline on wake cuts its finish short", async () => {
        const { stt, s, store, mic, at } = await recording();
        pushContiguous(s, 'mic', 10_000, 150); // 0-15 s in
        final(mic, 'last words', 9_000, 10_000); // its latest line ends 10 s in
        const finishing = gate<undefined>();
        mic.finishing = finishing; // no closing turn yet when the Mac sleeps
        at(25_000);
        s.suspendStreams('asleep');
        // On wake the 1 s poll sees the network gone before the finish ran out of time.
        s.suspendStreams('offline');
        expect(mic.terminated).toBe(true);
        await flush();
        s.resumeStreams('offline');
        s.resumeStreams('asleep');
        at(30_000);
        s.pushAudio('mic', chunk(), 30_000); // 20 s in
        await flush();
        stt.succeed('mic');
        await flush();

        expect(gaps(store)).toEqual([
          { source: 'mic', startMs: 10_000, endMs: 15_000, reason: 'offline' },
        ]);
        await s.close();
        expect(gaps(store)).toHaveLength(1);
      });

      it("records a sleep's unfinished tail when the vendor never finished, from the stream's own last line", async () => {
        const { l, s, store, mic, system, at } = await recording();
        pushContiguous(s, 'mic', 10_000, 150);
        pushContiguous(s, 'system', 10_000, 150);
        final(mic, 'last words', 9_000, 10_000);
        final(system, 'them', 9_000, 11_000);
        const finishing = gate<undefined>();
        mic.finishing = finishing;
        at(25_000);
        s.suspendStreams('asleep'); // the call audio stream finishes; the mic's never does
        await flush();
        // Sockets do not survive sleep: on wake the finish runs out of time. macOS timers do not
        // count sleep, so its deadline fires after the wake has lifted the suspend. The line the
        // core held comes first, then its word that the rest is lost.
        s.resumeStreams('asleep');
        final(mic, 'held', 10_500, 12_000);
        mic.emitter.emit({
          type: 'error',
          message: 'Scripted did not finish the stream (code 1006): its last lines are lost',
          fatal: true,
        });
        mic.emitter.emit({ type: 'closed', code: 1006, reason: null });
        finishing.resolve(undefined);
        await flush();

        // Named for the sleep, as the audio held in it is (hold): the vendor did not fail, the lid
        // closed on its socket (M2-T18). A pause's or Stop's finish failing stays `stt_failed`.
        expect(gaps(store)).toEqual([
          { source: 'mic', startMs: 12_000, endMs: 15_000, reason: 'asleep' },
        ]);
        // The source had left that stream already: nothing to reopen or show.
        expect(l.failures).toEqual([]);
        expect(s.watermark('mic')).toEqual({ finalEndMs: 12_000, closed: true });
        expect(store.listCaptureEvents('m1').at(-1)).toMatchObject({
          source: 'mic',
          kind: 'stt-failed',
          detail: {
            stage: 'finish',
            reason: 'Scripted did not finish the stream (code 1006): its last lines are lost',
          },
        });
        await s.close();
      });

      it("records a replaced stream's unfinished tail even after the new stream's lines", async () => {
        const { stt, s, store, system, at } = await recording();
        pushContiguous(s, 'system', 10_000, 100); // 0-10 s in
        final(system, 'them', 1_000, 6_000);
        const finishing = gate<undefined>();
        system.finishing = finishing;
        at(41_000);
        s.pauseSource('system', 31_000);
        // Audio returns while the old stream still finishes, and the new one says a line.
        at(42_000);
        s.pushAudio('system', chunk(), 42_000);
        await flush();
        const reopened = stt.succeed('system');
        await flush();
        final(reopened, 'later', 0, 100); // 32 s in: past the old stream's tail
        system.emitter.emit({ type: 'error', message: 'did not finish', fatal: true });
        finishing.resolve(undefined);
        await flush();

        expect(gaps(store)).toEqual([
          { source: 'system', startMs: 6_000, endMs: 10_000, reason: 'stt_failed' },
        ]);
        await s.close();
      });

      it('records the tail of a Stop the vendor never finished', async () => {
        const { s, store, mic } = await recording();
        pushContiguous(s, 'mic', 10_000, 50); // 0-5 s in
        final(mic, 'hello', 0, 2_000);
        const finishing = gate<undefined>();
        mic.finishing = finishing;

        const stopping = s.close();
        mic.emitter.emit({ type: 'error', message: 'did not finish', fatal: true });
        finishing.resolve(undefined);
        await stopping;

        expect(gaps(store)).toEqual([
          { source: 'mic', startMs: 2_000, endMs: 5_000, reason: 'stt_failed' },
        ]);
      });
    });

    it('opens nothing for a reopen caught mid-token by the offline suspend, and terminates one that lands late', async () => {
      const credentials = gate<{ accessToken: string; settings: typeof settings }>();
      const { stt, l, s, system, at } = await recording({
        refreshCredentials: () => credentials.promise,
      });
      system.emitter.emit({ type: 'closed', code: 1011, reason: 'timeout' });
      at(12_000);
      s.pushAudio('system', chunk(), 12_000);
      await flush();
      expect(l.states.at(-1)).toBe('system:connecting');

      s.suspendStreams('offline');
      expect(l.states.at(-1)).toBe('system:offline');
      credentials.resolve({ accessToken: 'fresh', settings });
      await flush();
      expect(stt.opens).toEqual(['mic', 'system']);
      await s.close();
    });

    it('terminates a reopen that lands after the Mac went offline', async () => {
      const { stt, l, s, system, at } = await recording();
      system.emitter.emit({ type: 'closed', code: 1011, reason: 'timeout' });
      at(12_000);
      s.pushAudio('system', chunk(), 12_000);
      await flush(); // the token is in; the vendor is still connecting
      expect(stt.opens).toEqual(['mic', 'system', 'system']);

      s.suspendStreams('offline');
      const late = stt.succeed('system');
      await flush();

      expect(late.terminated).toBe(true);
      expect(late.sent).toEqual([]);
      expect(l.states.at(-1)).toBe('system:offline');
      await s.close();
    });

    it("publishes each source's watermark: its last line's end, and once its stream has closed", async () => {
      const { stt, s, mic, system, at } = await recording();
      const seen: [string, SourceWatermark][] = [];
      s.onWatermark((source, watermark) => seen.push([source, watermark]));
      pushContiguous(s, 'system', 10_000, 20);

      final(system, 'them', 500, 1_200);
      expect(s.watermark('system')).toEqual({ finalEndMs: 1_200, closed: false });
      expect(seen).toEqual([['system', { finalEndMs: 1_200, closed: false }]]);

      // A stall pause closes it: no line can come for the audio it got, once its close settled.
      at(40_000);
      s.pauseSource('system', 30_000);
      expect(s.watermark('system').closed).toBe(false);
      await flush();
      expect(s.watermark('system')).toEqual({ finalEndMs: 1_200, closed: true });
      expect(seen.at(-1)).toEqual(['system', { finalEndMs: 1_200, closed: true }]);

      // Audio back: held for the reopen, so a line may come again.
      s.pushAudio('system', chunk(), 40_000);
      expect(s.watermark('system').closed).toBe(false);
      await flush();
      const reopened = stt.succeed('system');
      await flush();
      // A late line of the old stream that ends earlier never moves the watermark back.
      final(reopened, 'later', 0, 100);
      final(system, 'late and early', 100, 300);
      expect(s.watermark('system').finalEndMs).toBe(30_100);

      // A failed stream is not closed: it reconnects, and held audio may still bring a line.
      mic.emitter.emit({ type: 'error', message: 'gone', fatal: true });
      await flush();
      expect(s.watermark('mic')).toEqual({ finalEndMs: null, closed: false });
      await s.close();
    });

    it('writes a capture event for every pause, failure, suspend, resume and reopen', async () => {
      const { stt, s, store, mic, at } = await recording();
      pushContiguous(s, 'mic', 10_000, 10);
      at(11_000);
      mic.emitter.emit({ type: 'error', message: 'gone', fatal: true });
      at(12_000);
      s.suspendStreams('offline');
      at(13_000);
      s.resumeStreams('offline');
      s.pushAudio('mic', chunk(), 13_000);
      await flush();
      stt.succeed('mic');
      await flush();
      at(45_000);
      s.pauseSource('mic', 32_000);

      expect(eventKinds(store)).toEqual([
        'mic:stt-failed',
        '-:stt-suspended',
        '-:stt-resumed',
        'mic:stt-reopened',
        'mic:stt-paused',
      ]);
      expect(store.listCaptureEvents('m1').map(({ detail }) => detail)).toEqual([
        { stage: 'stream', reason: 'gone', retryInMs: 2_000 },
        { reason: 'offline' },
        { reason: 'offline', suspendedForMs: 1_000 },
        { heldMs: 100, droppedChunks: 0 },
        { silentForMs: 32_000 },
      ]);
      await s.close();
    });
  });

  describe('dating lines through the audio timeline', () => {
    it('dates lines from when their audio was captured, however late each chunk reached main', async () => {
      const { l, s, mic, at } = await recording();
      for (let i = 0; i < 100; i += 1) {
        const capturedAtMs = 12_000 + i * 100;
        // Each chunk lands 0 to 400 ms after its last sample, the delays in no particular order.
        at(capturedAtMs + 100 + (((i + 1) * 137) % 401));
        s.pushAudio('mic', new Uint8Array(3200), capturedAtMs);
      }
      final(mic, 'hello there', 9_500, 9_900, [
        [9_500, 9_700],
        [9_700, 9_900],
      ]);
      // The meeting started at 10 s and the audio at 12 s: arrival times would have put this up to
      // 400 ms late.
      expect(l.segments[0]).toMatchObject({ startMs: 11_500, endMs: 11_900 });
      expect(l.segments[0]?.words).toEqual([
        { text: 'w0', startMs: 11_500, endMs: 11_700, confidence: 1 },
        { text: 'w1', startMs: 11_700, endMs: 11_900, confidence: 1 },
      ]);
      await s.close();
    });

    it('keeps a line after a stall at the time it was said, not right after the audio before it', async () => {
      const log = recordingLogger();
      const { l, s, mic } = await recording({ logger: log.logger });
      pushContiguous(s, 'mic', 10_000, 100); // 10 s of audio
      // The renderer stalls for 20 s, under the 30 s that would pause the session: the vendor's
      // stream stays open and hears no hole.
      pushContiguous(s, 'mic', 40_000, 100);
      final(mic, 'before', 5_000, 6_000, [[5_000, 6_000]]);
      final(mic, 'after', 15_000, 16_000, [[15_000, 16_000]]);
      mic.emitter.emit({ type: 'interim', text: 'still after', startMs: 16_000, endMs: 17_000 });

      expect(l.segments.map(({ startMs, endMs }) => [startMs, endMs])).toEqual([
        [5_000, 6_000],
        [35_000, 36_000],
      ]);
      expect(l.segments[1]?.words?.[0]).toMatchObject({ startMs: 35_000, endMs: 36_000 });
      expect(l.interims).toEqual([
        { meetingId: 'm1', source: 'mic', text: 'still after', startMs: 36_000, endMs: 37_000 },
      ]);
      expect(log.messages).toContainEqual(
        expect.objectContaining({
          message: 'audio timeline: new run',
          source: 'mic',
          jumpMs: 20_000,
          runs: 2,
        }),
      );
      await s.close();
    });

    it('lets a word that ends at a gap end before it', async () => {
      const { l, s, mic } = await recording();
      pushContiguous(s, 'mic', 10_000, 10); // stream 0-1 s
      pushContiguous(s, 'mic', 15_000, 10); // stream 1-2 s, captured 4 s later
      final(mic, 'across', 600, 1_400, [
        [600, 1_000],
        [1_000, 1_400],
      ]);
      expect(l.segments[0]).toMatchObject({ startMs: 600, endMs: 5_400 });
      expect(l.segments[0]?.words?.map(({ startMs, endMs }) => [startMs, endMs])).toEqual([
        [600, 1_000],
        [5_000, 5_400],
      ]);
      await s.close();
    });

    it('never stretches a line across a stall for a word edge the vendor put just past it', async () => {
      const { l, s, mic } = await recording();
      pushContiguous(s, 'mic', 10_000, 10); // stream 0-1 s, captured 10-11 s
      // The mic stalls 20 s, under the 30 s that would pause the session: the stream stays open.
      pushContiguous(s, 'mic', 31_000, 10); // stream 1-2 s, captured 31-32 s
      // The vendor heard no hole: it ends the cut word 10 ms past the splice and starts the next
      // line 1 ms before it. Dated as stamped, the first line would end 20 s after it started (an
      // echo of it could no longer be hidden) and the second would start 20 s early.
      final(mic, 'yes exactly', 400, 1_010, [
        [400, 700],
        [700, 1_010],
      ]);
      final(mic, 'go on', 999, 1_600, [
        [999, 1_300],
        [1_300, 1_600],
      ]);
      expect(l.segments.map(({ startMs, endMs }) => [startMs, endMs])).toEqual([
        [400, 1_000],
        [21_000, 21_600],
      ]);
      expect(l.segments.map((segment) => segment.words?.map((w) => [w.startMs, w.endMs]))).toEqual([
        [
          [400, 700],
          [700, 1_000],
        ],
        [
          [21_000, 21_300],
          [21_300, 21_600],
        ],
      ]);
      await s.close();
    });

    it('keeps every word inside its line when a word at its edge falls the other side of a stall', async () => {
      const { l, s, mic } = await recording();
      pushContiguous(s, 'mic', 10_000, 10); // stream 0-1 s, captured 10-11 s
      pushContiguous(s, 'mic', 31_000, 10); // stream 1-2 s, captured 31-32 s
      // The line's first 100 ms sit before the splice, short enough to read as spill on their own,
      // but they hold a whole word: the word is real audio from before the stall. The echo filter
      // reaches call-audio lines by their spans, trusting their words to lie inside them.
      final(mic, 'so the rest', 900, 2_000, [
        [900, 980],
        [1_000, 2_000],
      ]);
      expect(l.segments[0]).toMatchObject({ startMs: 900, endMs: 22_000 });
      expect(l.segments[0]?.words?.map(({ startMs, endMs }) => [startMs, endMs])).toEqual([
        [900, 980],
        [21_000, 22_000],
      ]);
      await s.close();
    });

    it('starts a reopened stream at its own first chunk, and keeps the old stream on its own clock', async () => {
      const { stt, l, s, system, at } = await recording();
      pushContiguous(s, 'system', 10_000, 50); // 5 s
      at(15_000);
      system.emitter.emit({ type: 'closed', code: 1011, reason: 'timeout' });
      // Retrying: the backoff is over at 17 s, and the chunk that wakes it was captured at 20 s
      // and reached main 350 ms later.
      at(20_350);
      s.pushAudio('system', new Uint8Array(3200), 20_000);
      await flush();
      const reopened = stt.succeed('system');
      await flush();
      expect(reopened.sent).toHaveLength(1);

      final(reopened, 'new stream', 50, 90);
      // The dead stream's last line lands late: it still counts on the first stream's clock.
      final(system, 'old stream', 4_000, 4_500);
      expect(l.segments.map(({ text, startMs }) => [text, startMs])).toEqual([
        ['new stream', 10_050],
        ['old stream', 4_000],
      ]);
      await s.close();
    });

    it('stores whole milliseconds when capture times are fractional', async () => {
      const { l, s, mic } = await recording();
      // The renderer's capture times come from performance.now() and are fractional; the API's
      // offsets are integers (OffsetMs) and refuse 2500.4 with a 422.
      s.pushAudio('mic', new Uint8Array(3200), 12_000.4);
      final(mic, 'hi', 500, 900, [[500, 900]]);
      expect(l.segments[0]).toMatchObject({ startMs: 2_500, endMs: 2_900 });
      expect(l.segments[0]?.words?.[0]).toMatchObject({ startMs: 2_500, endMs: 2_900 });
      await s.close();
    });

    it('never stores an end before its start when the clock steps back inside a line', async () => {
      const { l, s, mic } = await recording();
      pushContiguous(s, 'mic', 12_000, 10); // stream 0-1 s, captured 12-13 s
      pushContiguous(s, 'mic', 11_000, 10); // the wall clock was set back 2 s
      // 500 ms each side of the step: more than spill (RUN_EDGE_SNAP_MS), so the span keeps both.
      final(mic, 'stepped', 500, 1_500, [[500, 1_500]]);
      // The API refuses end_ms < start_ms, so the end is held at the start.
      expect(l.segments[0]).toMatchObject({ startMs: 2_500, endMs: 2_500 });
      expect(l.segments[0]?.words?.[0]).toMatchObject({ startMs: 2_500, endMs: 2_500 });
      await s.close();
    });

    it('never stores a negative offset for audio captured before the meeting start', async () => {
      const { l, s, mic } = await recording();
      s.pushAudio('mic', new Uint8Array(3200), 9_800);
      final(mic, 'early', 100, 300);
      expect(l.segments[0]).toMatchObject({ startMs: 0, endMs: 100 });
      await s.close();
    });

    it('refuses a sample rate it cannot count in before any stream opens', () => {
      // Each stream's timeline is built once its socket is open: a throw there would leak it.
      const stt = new ControlledSpeechToText();
      expect(() =>
        session(stt, listeners(), () => 10_000, new InMemoryTranscriptStore(), {
          settings: { ...settings, sampleRate: 16_000.5 },
        }),
      ).toThrow(RangeError);
      expect(stt.opens).toEqual([]);
    });

    it('refuses a chunk it cannot place, and sends the vendor nothing of it', async () => {
      const { s, mic } = await recording();
      // The fan-out logs what a sink throws ("audio sink failed") and goes on with the next chunk.
      expect(() => {
        s.pushAudio('mic', new Uint8Array(3200), Number.NaN);
      }).toThrow(RangeError);
      expect(() => {
        s.pushAudio('mic', new Uint8Array(3201), 12_000);
      }).toThrow(RangeError);
      expect(mic.sent).toHaveLength(0);
      await s.close();
    });

    it('keeps every line and its offset over 2 hours of chunks on both streams', async () => {
      const log = recordingLogger();
      const { l, s, store, mic, system, at } = await recording({ logger: log.logger });
      const chunks = 72_000; // 2 hours of 100 ms chunks per stream
      const pcm = new Uint8Array(3200);
      for (let i = 0; i < chunks; i += 1) {
        const micAt = 10_000 + i * 100;
        const systemAt = micAt + 40; // the two sources are captured out of phase
        at(systemAt + 100 + ((i * 137) % 401));
        s.pushAudio('mic', pcm, micAt);
        s.pushAudio('system', pcm, systemAt);
        if (i % 600 === 599) {
          const minute = (i + 1) / 600 - 1;
          final(mic, `me ${minute}`, minute * 60_000 + 1_000, minute * 60_000 + 3_000);
          final(system, `them ${minute}`, minute * 60_000 + 2_000, minute * 60_000 + 4_000);
        }
      }
      expect(mic.sent).toHaveLength(chunks);
      expect(system.sent).toHaveLength(chunks);
      expect(store.countSegments('m1')).toBe(240);
      expect(s.storedSegmentCount).toBe(240);
      expect(l.segments.at(-2)).toMatchObject({ text: 'me 119', startMs: 7_141_000 });
      expect(l.segments.at(-1)).toMatchObject({ text: 'them 119', startMs: 7_142_040 });
      // Arrival jitter never split a stream's audio: one run each, the whole call.
      expect(log.messages.filter((m) => m.message === 'audio timeline: new run')).toEqual([]);
      await s.close();
    });
  });

  describe('a jargon list the vendor rejects (M3-T4b)', () => {
    /** A token's settings with a list, priced with the vendor's keyterm surcharge. */
    const listed = { ...settings, pricePerHourUsd: 0.19, keyterms: ['Linkt', 'Roger'] };
    const fresh = () =>
      Promise.resolve({
        accessToken: 'fresh',
        settings: listed,
        pricePerHourUsdWithoutKeyterms: 0.15,
      });
    /** The core's error for a connect refused over the list (SttConnection.keytermsRefused). */
    const listRefused = () =>
      new SttConnectError(
        'Scripted: rejected with HTTP 400; the jargon list (2 terms) was rejected',
        400,
        { keytermsRejected: true },
      );
    const warning: SessionWarning = {
      kind: 'keyterms-rejected',
      message:
        'Jargon list rejected by Scripted, transcribing without it. Check the list in Settings.',
    };
    /** What each open asked for: its source, the list it carried and the price it is metered at. */
    const opened = (stt: ControlledSpeechToText) =>
      stt.openOptions.map(({ label, settings: { keyterms, pricePerHourUsd } }) => [
        label,
        keyterms,
        pricePerHourUsd,
      ]);
    const rejectedLines = (messages: Record<string, unknown>[]) =>
      messages.filter(
        (m) => m.message === 'speech-to-text jargon list rejected: reopening without it',
      );

    /** A session whose tokens carry the list, on a test clock, with its budget in reach. */
    function listedSession(overrides: Partial<CaptureSessionOptions> = {}) {
      const stt = new ControlledSpeechToText();
      const l = listeners();
      const log = recordingLogger();
      let now = 10_000;
      const clock = () => now;
      const budget = overrides.budget ?? openBudget(clock);
      const store = meetingStore();
      const s = session(stt, l, clock, store, {
        settings: listed,
        pricePerHourUsdWithoutKeyterms: 0.15,
        refreshCredentials: fresh,
        logger: log.logger,
        budget,
        ...overrides,
      });
      return {
        stt,
        l,
        s,
        log,
        store,
        budget,
        at: (ms: number) => {
          now = ms;
        },
      };
    }

    /** Started, the mic's list refused at Start and the mic reopened without it. */
    async function micRefusedAtStart(overrides: Partial<CaptureSessionOptions> = {}) {
      const started = listedSession(overrides);
      const opening = started.s.open();
      started.stt.fail('mic', listRefused());
      await flush();
      started.stt.succeed('mic');
      started.stt.succeed('system');
      await opening;
      return started;
    }

    it('reopens a source refused at Start once without the list, through the budget, and says so', async () => {
      const { stt, l, s, log, store, budget } = listedSession();
      const opening = s.open();
      stt.fail('mic', listRefused());
      await flush();
      // The same token, no list, metered at the price without the list's surcharge: what the vendor
      // bills a stream opened with no list. Taken from the budget like any open.
      expect(opened(stt)).toEqual([
        ['mic', ['Linkt', 'Roger'], 0.19],
        ['system', ['Linkt', 'Roger'], 0.19],
        ['mic', [], 0.15],
      ]);
      expect(stt.openOptions[2]?.accessToken).toBe('t');
      expect(budget.openedThisMeeting).toBe(3);

      stt.succeed('mic');
      stt.succeed('system');
      await opening;
      expect(l.states.slice(-2).sort()).toEqual(['mic:open', 'system:open']);
      expect(l.warnings).toEqual([['mic', warning]]);
      // The term count, never the terms: they name clients and colleagues.
      expect(rejectedLines(log.messages)).toMatchObject([
        { level: 'warn', source: 'mic', terms: 2 },
      ]);
      expect(JSON.stringify(log.messages)).not.toContain('Linkt');
      expect(
        store.listCaptureEvents('m1').map(({ source, kind, detail }) => [source, kind, detail]),
      ).toEqual([['mic', 'stt-keyterms-rejected', { terms: 2 }]]);
      await s.close();
    });

    it('meters the list-free stream at the price with the list when the API names none without it', async () => {
      // An API older than price_per_hour_usd_without_keyterms: the price with the list errs high.
      const { stt, s } = await micRefusedAtStart({ pricePerHourUsdWithoutKeyterms: null });
      expect(opened(stt)[2]).toEqual(['mic', [], 0.19]);
      await s.close();
    });

    it('keeps the list off that source for the rest of the meeting, and only that source', async () => {
      const { stt, l, s, at } = await micRefusedAtStart();
      at(20_000);
      stt.streams.get('mic')?.emitter.emit({ type: 'closed', code: 1011, reason: 'timeout' });
      stt.streams.get('system')?.emitter.emit({ type: 'closed', code: 1011, reason: 'timeout' });
      at(23_000); // past the first backoff
      s.pushAudio('mic', new Uint8Array(3200), 22_900);
      s.pushAudio('system', new Uint8Array(3200), 22_900);
      await flush();
      // Each fresh token carries the list again: the mic still opens without it, the system with it.
      expect(opened(stt).slice(3)).toEqual([
        ['mic', [], 0.15],
        ['system', ['Linkt', 'Roger'], 0.19],
      ]);
      expect(stt.openOptions[3]?.accessToken).toBe('fresh');
      stt.succeed('mic');
      stt.succeed('system');
      await flush();
      expect(l.warnings).toHaveLength(1);
      await s.close();
    });

    it('fails Start with both reasons when the open without the list fails too, leaking nothing', async () => {
      const { stt, s } = listedSession();
      const opening = s.open();
      stt.fail('mic', listRefused());
      const system = stt.succeed('system');
      await flush();
      stt.fail('mic', new SttConnectError('Scripted: rejected with HTTP 401', 401));
      await expect(opening).rejects.toThrow(
        'Scripted: rejected with HTTP 400; the jargon list (2 terms) was rejected; and without the ' +
          'jargon list: Scripted: rejected with HTTP 401',
      );
      expect(system.closed).toBe(true);
      expect(stt.opens).toEqual(['mic', 'system', 'mic']);
    });

    it('opens without the list once, never in a loop, even when that open is refused for a list too', async () => {
      // Only a broken adapter could refuse a connect with no list "for its list": the core asks the
      // protocol only when one was sent (SttConnection.keytermsRefused).
      const { stt, s } = listedSession();
      const opening = s.open();
      stt.fail('mic', listRefused());
      stt.succeed('system');
      await flush();
      stt.fail('mic', listRefused());
      await expect(opening).rejects.toThrow('; and without the jargon list: ');
      expect(stt.opens).toEqual(['mic', 'system', 'mic']);
    });

    it('fails Start when the budget refuses the open without the list, naming both', async () => {
      const limited = new SttOpenBudget({ perMinute: 2, perMeeting: 100 }, () => 10_000);
      limited.beginMeeting();
      const { stt, l, s } = listedSession({ budget: limited });
      const opening = s.open();
      stt.fail('mic', listRefused());
      const system = stt.succeed('system');
      await expect(opening).rejects.toThrow(
        'the jargon list (2 terms) was rejected; not opened again without the jargon list: 2 ' +
          'speech-to-text sessions opened in the last minute',
      );
      expect(stt.opens).toEqual(['mic', 'system']);
      expect(system.closed).toBe(true);
      expect(l.warnings).toEqual([['mic', warning]]);
    });

    it('never retries a refusal that is not about the list, nor one when the list is empty', async () => {
      const { stt, l, s } = listedSession();
      const opening = s.open();
      stt.fail('mic', new SttConnectError('Scripted: rejected with HTTP 401', 401));
      stt.succeed('system');
      await expect(opening).rejects.toThrow('HTTP 401');
      expect(stt.opens).toEqual(['mic', 'system']);
      expect(l.warnings).toEqual([]);

      // No list to drop: an open without it would be the same open again.
      const empty = listedSession({ settings });
      const emptyOpening = empty.s.open();
      empty.stt.fail('mic', listRefused());
      empty.stt.succeed('system');
      await expect(emptyOpening).rejects.toThrow('was rejected');
      expect(empty.stt.opens).toEqual(['mic', 'system']);
      expect(empty.l.warnings).toEqual([]);
    });

    it('reopens a source refused mid-call once without the list, through the budget', async () => {
      const { stt, l, s, budget, at } = listedSession();
      const opening = s.open();
      stt.succeed('mic');
      const system = stt.succeed('system');
      await opening;
      at(20_000);
      system.emitter.emit({ type: 'closed', code: 1011, reason: 'timeout' });
      at(23_000);
      const woke = new Uint8Array(3200).fill(1);
      s.pushAudio('system', woke, 22_900); // wakes the source: a reopen with a fresh token
      await flush();
      stt.fail('system', listRefused());
      await flush();
      expect(opened(stt).slice(2)).toEqual([
        ['system', ['Linkt', 'Roger'], 0.19],
        ['system', [], 0.15],
      ]);
      expect(budget.openedThisMeeting).toBe(4);
      const reopened = stt.succeed('system');
      await flush();
      expect(l.states.at(-1)).toBe('system:open');
      expect(reopened.sent).toEqual([woke]); // what it held while connecting, sent in order
      expect(l.warnings).toEqual([['system', warning]]);
      await s.close();
    });

    it('says nothing of a list refused for a reopen Stop overtook, as nothing reopens', async () => {
      const { stt, l, s, log, store, at } = listedSession();
      const opening = s.open();
      stt.succeed('mic');
      const system = stt.succeed('system');
      await opening;
      at(20_000);
      system.emitter.emit({ type: 'closed', code: 1011, reason: 'timeout' });
      at(23_000);
      s.pushAudio('system', new Uint8Array(3200).fill(1), 22_900);
      await flush();
      const closing = s.close(); // Stop while that reopen connects: it waits for it
      stt.fail('system', listRefused());
      await closing;
      // No "reopening without it" line, event or warning: each would claim a reopen that never came.
      expect(stt.opens).toEqual(['mic', 'system', 'system']);
      expect(rejectedLines(log.messages)).toEqual([]);
      expect(
        store.listCaptureEvents('m1').filter(({ kind }) => kind === 'stt-keyterms-rejected'),
      ).toEqual([]);
      expect(l.warnings).toEqual([]);
    });

    it('waits like any refused reopen when the budget refuses the open without the list, which comes next', async () => {
      let now = 10_000;
      const limited = new SttOpenBudget({ perMinute: 3, perMeeting: 100 }, () => now);
      limited.beginMeeting();
      const { stt, l, s, at } = listedSession({ budget: limited });
      const moveTo = (ms: number) => {
        now = ms;
        at(ms);
      };
      const opening = s.open();
      stt.succeed('mic');
      const system = stt.succeed('system');
      await opening;
      moveTo(20_000);
      system.emitter.emit({ type: 'closed', code: 1011, reason: 'timeout' });
      moveTo(23_000);
      s.pushAudio('system', new Uint8Array(3200), 22_900);
      await flush();
      stt.fail('system', listRefused()); // the 3rd open in the minute; the retry would be the 4th
      await flush();
      expect(l.states.at(-1)).toBe('system:retrying');
      expect(l.failures.at(-1)).toMatchObject([
        'system',
        expect.stringContaining('waiting to reconnect'),
        70_000,
      ]);
      expect(l.warnings).toEqual([['system', warning]]);

      moveTo(70_000); // the minute has passed: its next chunk reopens it, without the list
      s.pushAudio('system', new Uint8Array(3200), 69_900);
      await flush();
      expect(opened(stt).slice(2)).toEqual([
        ['system', ['Linkt', 'Roger'], 0.19],
        ['system', [], 0.15],
      ]);
      stt.succeed('system');
      await flush();
      expect(l.states.at(-1)).toBe('system:open');
      await s.close();
    });
  });

  describe('word latency', () => {
    /** The `stt latency` lines logged so far. */
    const latencyLines = (messages: Record<string, unknown>[]) =>
      messages.filter((m) => m.message === 'stt latency');

    it('logs each source once at close, every word timed from when it was captured', async () => {
      const log = recordingLogger();
      const { s, mic, system, at } = await recording({ logger: log.logger });
      // The audio starts 2 s into the meeting: timed on the vendor's own clock, every word would
      // read 2 s slower than it showed.
      pushContiguous(s, 'mic', 12_000, 20); // stream 0-2 s, captured 12-14 s
      pushContiguous(s, 'system', 12_040, 20); // captured out of phase with the mic
      at(13_300);
      mic.emitter.emit({ type: 'interim', text: 'hello', startMs: 0, endMs: 1_000 });
      at(13_640);
      final(system, 'hi', 0, 1_000, [[0, 1_000]]);
      at(14_200);
      final(mic, 'hello there', 0, 1_800, [
        [0, 1_000],
        [1_000, 1_800],
      ]);
      expect(latencyLines(log.messages)).toEqual([]);

      await s.close();
      // A failed Start closes twice (open(), then CaptureService): still one line per session.
      await s.close();
      const lines = latencyLines(log.messages);
      expect(lines).toHaveLength(1);
      // "hello" showed with the interim 300 ms after it was said, "there" with the final 400 ms
      // after; the final that holds "hello" came 1 200 ms after it.
      expect(lines[0]?.mic).toEqual({
        words: 2,
        displayP50Ms: 300,
        displayP95Ms: 400,
        finalP50Ms: 400,
        finalP95Ms: 1_200,
        longestWaitMs: 400,
        clampedWords: 0,
        repeatedWords: 0,
      });
      expect(lines[0]?.system).toEqual({
        words: 1,
        displayP50Ms: 600,
        displayP95Ms: 600,
        finalP50Ms: 600,
        finalP95Ms: 600,
        longestWaitMs: 600,
        clampedWords: 0,
        repeatedWords: 0,
      });
    });

    it('logs only once every stream has closed, so the last line a close flushes is timed', async () => {
      const log = recordingLogger();
      const { s, mic, at } = await recording({ logger: log.logger });
      pushContiguous(s, 'mic', 12_000, 20); // stream 0-2 s, captured 12-14 s
      // At Stop the vendor sends its last final while the close is still pending (AssemblyAI's
      // ForceEndpoint and Terminate, Deepgram's Finalize): no event showed "goodbye" before it.
      const finishing = gate<undefined>();
      mic.finishing = finishing;
      const closing = s.close();
      await flush();
      expect(latencyLines(log.messages)).toEqual([]);

      at(14_500);
      final(mic, 'goodbye', 0, 1_000, [[0, 1_000]]); // captured by 13 s
      finishing.resolve(undefined);
      await closing;
      // Logged before the stream closed, the line would read 0 words for the mic.
      expect(latencyLines(log.messages)[0]?.mic).toMatchObject({
        words: 1,
        displayP50Ms: 1_500,
        finalP50Ms: 1_500,
      });
    });

    it("records Stop's gap before the latency line, and both see the line a close flushed", async () => {
      const log = recordingLogger();
      const { s, store, mic, at } = await recording({ logger: log.logger });
      pushContiguous(s, 'mic', 12_000, 20); // stream 0-2 s, captured 12-14 s
      const finishing = gate<undefined>();
      mic.finishing = finishing;
      at(14_000);
      s.suspendStreams('asleep'); // the mic's finish is still on the way at Stop
      pushContiguous(s, 'mic', 14_000, 10); // held while asleep: 4-5 s into the meeting
      const closing = s.close();
      await flush();
      expect(latencyLines(log.messages)).toEqual([]);
      expect(store.listGaps('m1')).toEqual([]);

      at(14_500);
      final(mic, 'goodnight', 0, 1_500, [[0, 1_500]]); // captured by 13.5 s
      finishing.resolve(undefined);
      await closing;

      expect(latencyLines(log.messages)[0]?.mic).toMatchObject({ words: 1, displayP50Ms: 1_000 });
      // The held audio never reached a vendor: lost from its first chunk to the last, after the
      // flushed line's end (3.5 s), the watermark the gap may never start before. Named for the
      // sleep that held it, not `stt_failed`: speech-to-text never failed (M2-T18).
      expect(
        store
          .listGaps('m1')
          .map(({ source, startMs, endMs, reason }) => [source, startMs, endMs, reason]),
      ).toEqual([['mic', 4_000, 5_000, 'asleep']]);
      const order = log.messages.map((m) => m.message);
      expect(order.indexOf('speech-to-text gap recorded')).toBeLessThan(
        order.indexOf('stt latency'),
      );
    });

    it('times a word the vendor ends just past a stall from before it, where its line is dated', async () => {
      const log = recordingLogger();
      const { l, s, mic, at } = await recording({ logger: log.logger });
      pushContiguous(s, 'mic', 10_000, 10); // stream 0-1 s, captured 10-11 s
      // The mic stalls 20 s, under the 30 s that would pause the session: the stream stays open.
      pushContiguous(s, 'mic', 31_000, 10); // stream 1-2 s, captured 31-32 s
      at(10_900);
      mic.emitter.emit({ type: 'interim', text: 'yes', startMs: 400, endMs: 700 });
      // The vendor ends "exactly" 10 ms past the splice: the line is dated before the stall.
      at(31_400);
      final(mic, 'yes exactly', 400, 1_010, [
        [400, 700],
        [700, 1_010],
      ]);
      expect(l.segments[0]).toMatchObject({ startMs: 400, endMs: 1_000 });

      await s.close();
      // "exactly" was said by 11 s and first showed at 31.4 s. Timed from its end mapped alone,
      // on the far side of the gap (31 010), it would read 390 ms: the stall would be invisible.
      expect(latencyLines(log.messages)[0]?.mic).toMatchObject({
        words: 2,
        displayP50Ms: 200,
        longestWaitMs: 20_400,
      });
    });

    it('times a reopened stream and a late line from the stream it replaced, each on its own clock', async () => {
      const log = recordingLogger();
      const { stt, s, system, at } = await recording({ logger: log.logger });
      pushContiguous(s, 'system', 10_000, 50); // stream 0-5 s, captured 10-15 s
      at(15_000);
      system.emitter.emit({ type: 'closed', code: 1011, reason: 'timeout' });
      at(20_350);
      s.pushAudio('system', new Uint8Array(3200), 20_000); // the backoff is over: it reopens
      await flush();
      const reopened = stt.succeed('system');
      await flush();

      at(20_400);
      final(reopened, 'new stream', 0, 100, [[0, 100]]); // captured by 20.1 s
      // The dead stream's last line lands late; its word was captured by 14.5 s. One meter across
      // both streams would count it as already measured and never time it.
      at(21_500);
      final(system, 'old stream', 4_000, 4_500, [[4_000, 4_500]]);

      await s.close();
      expect(latencyLines(log.messages)[0]?.system).toMatchObject({
        words: 2,
        displayP50Ms: 300,
        longestWaitMs: 7_000,
        repeatedWords: 0,
      });
    });

    it('measures a line only once it is saved and shown, so the meter can never cost one', async () => {
      const { l, s, store, mic } = await recording();
      pushContiguous(s, 'mic', 12_000, 10);
      // The adapters' parsers drop vendor times that are not numbers, so only a bug gets here; the
      // meter refuses such a time with a RangeError, which the STT core reports as "stt listener
      // failed" (SttConnection.deliver). By then the line must already be kept.
      expect(() => {
        final(mic, 'kept anyway', Number.NaN, Number.NaN);
      }).toThrow(RangeError);
      expect(l.shown).toEqual(['kept anyway']);
      expect(store.countSegments('m1')).toBe(1);
      await s.close();
    });
  });
  describe('the silence gate (M3-T20)', () => {
    const GATE = { closeAfterMs: 30_000, preRollMs: 1_000, reopensPerMeeting: 120 };
    /** 100 ms of a voice at about -6 dBFS: speech in any room. */
    const voice = (): Uint8Array => new Uint8Array(3200).fill(64);
    const quiet = (): Uint8Array => new Uint8Array(3200);
    const GATED_MESSAGE = /^mic:paused:silent for \d+ s; reopens when someone speaks$/;

    /**
     * A session with the gate on, on a clock the pushes move. Each token is good for 30 s from
     * when it came (the API's expires_in), and the source counts every fetch.
     */
    async function gated(
      overrides: Partial<CaptureSessionOptions> = {},
      limits = { perMinute: 100, perMeeting: 100 },
      tokenTtlMs = 30_000,
    ) {
      const stt = new ControlledSpeechToText();
      const l = listeners();
      const log = recordingLogger();
      let now = 10_000;
      const clock = (): number => now;
      let fetched = 0;
      let failing = 0;
      const budget = new SttOpenBudget(limits, clock);
      budget.beginMeeting();
      const store = meetingStore();
      const s = session(stt, l, clock, store, {
        silenceGate: GATE,
        refreshCredentials: (): Promise<StreamCredentials> => {
          fetched += 1;
          if (failing > 0) {
            failing -= 1;
            return Promise.reject(new Error('API unreachable'));
          }
          return Promise.resolve({
            accessToken: `token-${fetched}`,
            settings,
            expiresAtMs: now + tokenTtlMs,
          });
        },
        budget,
        logger: log.logger,
        ...overrides,
      });
      const opening = s.open();
      const mic = stt.succeed('mic');
      const system = stt.succeed('system');
      await opening;
      /** Capture time of every chunk pushed, by its bytes: what each stream was sent, in order. */
      const capturedAt = new Map<Uint8Array, number>();
      const push = (source: AudioSource, atMs: number, pcm: Uint8Array = quiet()): void => {
        now = atMs;
        capturedAt.set(pcm, atMs);
        s.pushAudio(source, pcm, atMs);
      };
      return {
        stt,
        l,
        s,
        store,
        mic,
        system,
        budget,
        log,
        push,
        fetched: () => fetched,
        failFetches: (count: number) => {
          failing = count;
        },
        at: (ms: number) => {
          now = ms;
        },
        /** Chunks of `source` every 100 ms from `fromMs` up to `toMs`, the clock following. */
        pushUntil: (source: AudioSource, fromMs: number, toMs: number, pcm = quiet): void => {
          for (let t = fromMs; t < toMs; t += 100) push(source, t, pcm());
        },
        sentAt: (stream: ScriptedStream) => stream.sent.map((pcm) => capturedAt.get(pcm)),
        /** The mic's latest state and its message, `mic:<state>:<message>`. */
        micState: () => l.stateMessages.filter((line) => line.startsWith('mic:')).at(-1),
        logged: (message: string) => log.messages.filter((line) => line.message === message),
      };
    }

    /** Closes the mic for silence at 70 s: Start was at 10 s, and a session lives 60 s at least. */
    async function micGated(
      overrides: Partial<CaptureSessionOptions> = {},
      limits?: { perMinute: number; perMeeting: number },
    ) {
      const g = await gated(overrides, limits);
      g.pushUntil('mic', 10_000, 70_100);
      await flush();
      return g;
    }

    function gaps(store: InMemoryTranscriptStore) {
      return store
        .listGaps('m1')
        .map(({ source, startMs, endMs, reason }) => ({ source, startMs, endMs, reason }));
    }

    it('closes a silent source through the normal close, and only speech reopens it', async () => {
      const g = await gated();
      const finishing = gate<undefined>();
      g.mic.finishing = finishing;
      g.pushUntil('mic', 10_000, 70_000);
      // Silent for 59.9 s, but open for less than the 60 s every session lives.
      expect(g.mic.closed).toBe(false);
      g.push('mic', 70_000);
      expect(g.mic.closed).toBe(true);
      expect(g.micState()).toMatch(GATED_MESSAGE);
      // The finish still saves the last lines the vendor sends.
      final(g.mic, 'last words', 1_000, 2_000);
      finishing.resolve(undefined);
      await flush();
      expect(g.l.shown).toEqual(['last words']);
      expect(g.fetched()).toBe(1); // the token prefetched at the close

      g.pushUntil('mic', 70_100, 80_000);
      await flush();
      expect(g.stt.opens).toEqual(['mic', 'system']); // silence never reopens it
      expect(g.l.states.at(-1)).toBe('mic:paused');

      g.push('mic', 80_000, voice());
      await flush();
      expect(g.stt.opens).toEqual(['mic', 'system', 'mic']);
      expect(g.fetched()).toBe(1); // no API call at the onset
      expect(g.stt.openOptions.at(-1)?.accessToken).toBe('token-1');
      const reopened = g.stt.succeed('mic');
      await flush();
      // The second before the speech first, then the chunk that woke it.
      expect(g.sentAt(reopened)).toEqual([
        ...Array.from({ length: 10 }, (_, i) => 79_000 + i * 100),
        80_000,
      ]);
      // Its time zero is the pre-roll's first chunk: the line is dated at meeting time.
      final(reopened, 'hello again', 1_000, 1_100);
      expect(g.l.segments.at(-1)).toMatchObject({ startMs: 70_000, endMs: 70_100 });
      await g.s.close();
    });

    it('keeps the whole pre-roll through a slow connect, and drops no audio', async () => {
      const g = await micGated({ silenceGate: { ...GATE, preRollMs: 2_000 } });
      g.pushUntil('mic', 70_100, 80_000);
      g.push('mic', 80_000, voice());
      await flush();
      // 1.5 s of speech arrives while it connects: with the 2 s pre-roll, more than the 3 s
      // reopen buffer, which alone would cut the pre-roll's start.
      g.pushUntil('mic', 80_100, 81_600, voice);
      const reopened = g.stt.succeed('mic');
      await flush();
      expect(g.sentAt(reopened)[0]).toBe(78_000);
      expect(reopened.sent).toHaveLength(20 + 16);
      expect(g.logged('audio dropped while reconnecting')).toEqual([]);
      await g.s.close();
    });

    it('refreshes the token before its TTL while gated, and fetches at the onset without one', async () => {
      const g = await micGated();
      expect(g.fetched()).toBe(1); // at 70 s, good until 100 s
      g.pushUntil('mic', 70_100, 90_000);
      await flush();
      expect(g.fetched()).toBe(1);
      g.push('mic', 90_000); // 10 s before it expires
      await flush();
      expect(g.fetched()).toBe(2);

      // No chunk for 26 s (a stall): the token has under 5 s left at the onset.
      g.push('mic', 116_000, voice());
      await flush();
      expect(g.fetched()).toBe(3);
      expect(g.stt.openOptions.at(-1)?.accessToken).toBe('token-3');
      g.stt.succeed('mic');
      await flush();
      await g.s.close();
    });

    it('logs a failed prefetch and falls back to a fetch at the onset', async () => {
      const g = await gated();
      g.failFetches(1);
      g.pushUntil('mic', 10_000, 70_100);
      await flush();
      expect(g.logged('speech-to-text token prefetch failed')).toHaveLength(1);
      g.push('mic', 70_100, voice());
      await flush();
      expect(g.fetched()).toBe(2);
      expect(g.stt.openOptions.at(-1)?.accessToken).toBe('token-2');
      g.stt.succeed('mic');
      await flush();
      await g.s.close();
    });

    it('fetches at most every 10 s while gated, however short-lived the token', async () => {
      // A token that lives under the refresh lead would otherwise be fetched again at every chunk.
      const g = await gated({}, undefined, 3_000);
      g.pushUntil('mic', 10_000, 70_100);
      await flush();
      expect(g.fetched()).toBe(1);
      for (let t = 70_100; t < 95_000; t += 100) {
        g.push('mic', t);
        await flush(); // each fetch lands before the next chunk, as in real time
      }
      expect(g.fetched()).toBe(3); // at 80 s and 90 s
      // Gone stale meanwhile: the onset fetches.
      g.push('mic', 95_000, voice());
      await flush();
      expect(g.fetched()).toBe(4);
      g.stt.succeed('mic');
      await flush();
      await g.s.close();
    });

    it('tries a failed prefetch again while the source stays gated', async () => {
      const g = await gated();
      g.failFetches(1);
      g.pushUntil('mic', 10_000, 70_100);
      await flush();
      g.pushUntil('mic', 70_100, 80_000);
      await flush();
      expect(g.fetched()).toBe(1);
      g.push('mic', 80_000);
      await flush();
      expect(g.fetched()).toBe(2);
      g.push('mic', 80_100, voice());
      await flush();
      expect(g.fetched()).toBe(2);
      g.stt.succeed('mic');
      await flush();
      await g.s.close();
    });

    it('leaves a stall to its own path: any chunk reopens it, on the meeting allowance', async () => {
      const g = await gated();
      g.pushUntil('system', 10_000, 20_000);
      g.at(50_000);
      g.s.pauseSource('system', 30_000);
      g.push('system', 50_000); // silent, but a stall reopens on any chunk
      await flush();
      expect(g.stt.opens).toEqual(['mic', 'system', 'system']);
      expect(g.budget.openedThisMeeting).toBe(3);
      g.stt.succeed('system');
      await flush();
      await g.s.close();
    });

    it('keeps a gated source gated across an offline flip and a wake, reopening only on speech', async () => {
      const g = await micGated();
      g.s.suspendStreams('offline');
      g.pushUntil('mic', 70_100, 75_000);
      g.s.resumeStreams('offline');
      expect(g.micState()).toMatch(GATED_MESSAGE);
      g.pushUntil('mic', 75_000, 80_000);
      g.s.suspendStreams('asleep');
      g.at(200_000);
      g.s.resumeStreams('asleep');
      expect(g.micState()).toMatch(GATED_MESSAGE);
      g.pushUntil('mic', 200_000, 205_000);
      await flush();
      expect(g.stt.opens).toEqual(['mic', 'system']);

      g.push('mic', 205_000, voice());
      await flush();
      expect(g.stt.opens).toEqual(['mic', 'system', 'mic']);
      g.stt.succeed('mic');
      await flush();
      // Nothing was said while it was gated, offline or not: no gap.
      expect(gaps(g.store)).toEqual([]);
      await g.s.close();
    });

    it('reopens on speech heard while offline once the network is back, with a gap from the onset', async () => {
      const g = await micGated();
      g.s.suspendStreams('offline');
      g.pushUntil('mic', 70_100, 72_000);
      g.pushUntil('mic', 72_000, 77_000, voice); // 5 s of speech the vendor never hears
      g.s.resumeStreams('offline');
      expect(g.micState()).toBe('mic:paused:reconnects with its next audio');
      g.push('mic', 77_000);
      await flush();
      expect(g.stt.opens).toEqual(['mic', 'system', 'mic']);
      const reopened = g.stt.succeed('mic');
      await flush();
      // Held: its newest pre-roll plus reopen buffer, 4 s. The second before the onset and the
      // first second of speech were dropped: that is the gap, never the silence before it.
      expect(g.sentAt(reopened)[0]).toBe(73_100);
      expect(gaps(g.store)).toEqual([
        { source: 'mic', startMs: 61_000, endMs: 63_100, reason: 'offline' },
      ]);
      await g.s.close();
    });

    it("takes a per-minute slot for a gate reopen, never one of the meeting's opens", async () => {
      // The defaults: Start's two leave 28 of the meeting's opens, fewer than the 30 cycles.
      const g = await gated({}, { perMinute: 4, perMeeting: 30 });
      let t = 10_000;
      for (let cycle = 0; cycle < 30; cycle += 1) {
        g.pushUntil('mic', t, t + 60_100); // silent past the 60 s a session lives: closed
        await flush();
        g.push('mic', t + 60_100, voice());
        await flush();
        g.stt.succeed('mic');
        await flush();
        t += 60_200;
      }
      expect(g.stt.opens.filter((label) => label === 'mic')).toHaveLength(31);
      expect(g.budget.openedThisMeeting).toBe(2); // Start's two
      // The last reopen holds a slot in the minute: with the default of 4, three are left.
      expect(g.budget.check(3, 'minute').ok).toBe(true);
      expect(g.budget.check(4, 'minute').ok).toBe(false);
      await g.s.close();
    });

    it('turns itself off once its own reopens are spent: one log line, sessions stay open', async () => {
      const g = await gated({ silenceGate: { ...GATE, reopensPerMeeting: 2 } });
      expect(g.s.silenceGateState).toBe('on');
      let t = 10_000;
      for (let cycle = 0; cycle < 2; cycle += 1) {
        g.pushUntil('mic', t, t + 60_100);
        await flush();
        g.push('mic', t + 60_100, voice());
        await flush();
        g.stt.succeed('mic');
        await flush();
        t += 60_200;
      }
      expect(g.s.silenceGateState).toBe('spent');
      const spent = g.logged('silence gate off for this meeting: its reopens are spent');
      expect(spent).toHaveLength(1);
      expect(spent[0]?.reopens).toBe(2);
      const last = g.stt.streams.get('mic');
      g.pushUntil('mic', t, t + 180_000);
      await flush();
      expect(last?.closed).toBe(false);
      expect(g.stt.opens.filter((label) => label === 'mic')).toHaveLength(3);
      // The other source never closes for silence either.
      g.pushUntil('system', t, t + 120_000);
      expect(g.system.closed).toBe(false);
      await g.s.close();
    });

    it('never closes a session that opened less than 60 s ago', async () => {
      const g = await micGated();
      g.push('mic', 80_000, voice());
      await flush();
      g.at(81_000);
      const reopened = g.stt.succeed('mic'); // opened at 81 s
      await flush();
      g.pushUntil('mic', 80_100, 140_900); // 60 s of silence after the speech
      expect(reopened.closed).toBe(false);
      g.push('mic', 141_000);
      expect(reopened.closed).toBe(true);
      await g.s.close();
    });

    it('writes no gap for a gated window, and starts the gap of a failed speech reopen at the onset', async () => {
      const g = await gated();
      g.failFetches(2); // the prefetch at the close fails, and so does the fetch at the onset
      g.pushUntil('mic', 10_000, 80_000);
      await flush();
      g.push('mic', 80_000, voice());
      await flush();
      expect(g.l.states.at(-1)).toBe('mic:retrying');
      // A failure takes the landed retry: any chunk after the backoff, on the meeting allowance.
      g.pushUntil('mic', 80_100, 82_100, voice);
      await flush();
      expect(g.budget.openedThisMeeting).toBe(3);
      const reopened = g.stt.succeed('mic');
      await flush();
      // From the onset (the pre-roll's first chunk at 79 s) to the new stream's first audio.
      const first = g.sentAt(reopened)[0] ?? 0;
      expect(gaps(g.store)).toEqual([
        { source: 'mic', startMs: 69_000, endMs: first - 10_000, reason: 'stt_failed' },
      ]);
      await g.s.close();
    });

    it('starts the gap of a speech reopen the per-minute window holds back at the onset', async () => {
      const g = await micGated({}, { perMinute: 4, perMeeting: 100 });
      g.pushUntil('mic', 70_100, 80_000);
      await flush();
      expect(g.budget.acquire(4, 'minute').ok).toBe(true); // the minute is full until 140 s
      g.push('mic', 80_000, voice());
      await flush();
      expect(g.l.states.at(-1)).toBe('mic:retrying');
      g.pushUntil('mic', 80_100, 140_100, voice);
      await flush();
      const reopened = g.stt.succeed('mic');
      await flush();
      expect(g.budget.openedThisMeeting).toBe(2); // still the gate's reopen, in the minute only
      // Held while it waited: the pre-roll plus the reopen buffer, the newest 4 s.
      expect(g.sentAt(reopened)[0]).toBe(136_100);
      expect(gaps(g.store)).toEqual([
        { source: 'mic', startMs: 69_000, endMs: 126_100, reason: 'budget' },
      ]);
      await g.s.close();
    });

    it('times the words of gate-reopened sessions in figures of their own', async () => {
      const g = await micGated();
      g.pushUntil('mic', 70_100, 80_000);
      g.push('mic', 80_000, voice());
      await flush();
      const reopened = g.stt.succeed('mic');
      await flush();
      g.at(81_500);
      final(reopened, 'hello', 1_000, 1_100, [[1_000, 1_100]]); // said at 80.1 s, shown 1.4 s on
      await g.s.close();
      const [line] = g.logged('stt latency');
      expect(line?.mic).toMatchObject({ words: 0 });
      expect(line?.gateReopened).toMatchObject({
        mic: { words: 1, displayP50Ms: 1_400 },
        system: { words: 0 },
      });
    });

    it('counts the time each source was gated and what it saved at its price', async () => {
      const priced = { ...settings, pricePerHourUsd: 0.36 };
      const g = await micGated({ settings: priced });
      g.pushUntil('mic', 70_100, 80_000);
      expect(g.s.gateUsage('mic')).toEqual({ gatedMs: 9_900, estimatedSavedUsd: 0.001 });
      g.push('mic', 80_000, voice());
      await flush();
      g.at(90_000);
      // The window ended at the onset: connecting is not gated time.
      expect(g.s.gateUsage('mic')).toEqual({ gatedMs: 10_000, estimatedSavedUsd: 0.001 });
      expect(g.s.gateUsage('system')).toEqual({ gatedMs: 0, estimatedSavedUsd: 0 });
      expect(g.s.gateUsage()).toEqual({ gatedMs: 10_000, estimatedSavedUsd: 0.001 });
      expect(g.s.gateReopens).toBe(1);
      g.stt.succeed('mic');
      await flush();
      await g.s.close();
      expect(g.store.listCaptureEvents('m1').map(({ kind }) => kind)).toEqual([
        'stt-gate-closed',
        'stt-gate-window',
        'stt-reopened',
      ]);
      expect(g.store.listCaptureEvents('m1')[1]?.detail).toEqual({
        gatedMs: 10_000,
        peakDb: -90,
        endedBy: 'speech',
      });
    });

    it('is off without its settings: a silent source keeps its session', async () => {
      const g = await gated({ silenceGate: null });
      expect(g.s.silenceGateState).toBe('off');
      g.pushUntil('mic', 10_000, 130_000);
      expect(g.mic.closed).toBe(false);
      expect(g.s.gateUsage()).toEqual({ gatedMs: 0, estimatedSavedUsd: 0 });
      await g.s.close();
    });
  });
});
