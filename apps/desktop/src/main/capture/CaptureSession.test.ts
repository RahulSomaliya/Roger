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
import { CaptureSession, type CaptureSessionListeners } from './CaptureSession';

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
  readonly streams = new Map<string, ScriptedStream>();
  private readonly pending = new Map<
    string,
    { resolve: (s: SttStream) => void; reject: (e: Error) => void }
  >();
  openStream(options: OpenStreamOptions): Promise<SttStream> {
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
  failures: [AudioSource, string][];
  saveFailures: [AudioSource, string][];
  shown: string[];
  states: string[];
} {
  const failures: [AudioSource, string][] = [];
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
    onStreamState: (source, state) => {
      states.push(`${source}:${state}`);
    },
    onStreamFailure: (source, reason) => {
      failures.push([source, reason]);
    },
  };
}

function session(
  stt: SpeechToText,
  l: CaptureSessionListeners,
  clock: () => number = () => 10_000,
  store: InMemoryTranscriptStore = new InMemoryTranscriptStore(),
) {
  return new CaptureSession({
    meetingId: 'm1',
    meetingStartedAtMs: 10_000,
    stt,
    accessToken: 't',
    settings,
    store,
    logger,
    listeners: l,
    clock,
  });
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
    expect(l.failures).toEqual([['system', 'connection closed (code 1011: timeout)']]);
    expect(l.states.at(-1)).toBe('system:closed');

    s.pushAudio('mic', new Uint8Array(3200));
    s.pushAudio('system', new Uint8Array(3200));
    expect(mic.sent).toHaveLength(1);
    expect(system.sent).toHaveLength(0);

    await s.close();
    expect(mic.closed).toBe(true);
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
