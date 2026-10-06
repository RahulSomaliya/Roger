import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptureStatus } from '../../shared/capture';
import type { AudioSource, TranscriptSegment } from '../../shared/transcript';
import type { MeetingDto, SttTokenApi, UploadApi } from '../api/ApiClient';
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
import { TranscriptUploader } from '../upload/TranscriptUploader';
import { CaptureService, defaultMeetingTitle } from './CaptureService';

const logger = createLogger({ level: 'error', format: 'json', sink: () => undefined });

function meetingDto(id: string): MeetingDto {
  return {
    id,
    workspace_id: 'w1',
    title: 'T',
    status: 'recording',
    started_at: '2026-10-05T10:00:00Z',
    ended_at: null,
    segment_count: 0,
    created_at: '2026-10-05T10:00:00Z',
    updated_at: '2026-10-05T10:00:00Z',
  };
}

/** A speech-to-text double the test drives by hand. */
class ScriptedStream implements SttStream {
  readonly emitter = new SttEventEmitter();
  readonly sent: Uint8Array[] = [];
  closed = false;
  closeCalls = 0;
  /** Emitted while closing, like a vendor flushing its last final after CloseStream. */
  finalOnClose: string | null = null;
  send(pcm: Uint8Array): void {
    this.sent.push(pcm);
  }
  close(): Promise<void> {
    this.closeCalls += 1;
    if (this.closed) return Promise.resolve();
    if (this.finalOnClose !== null) {
      this.emitter.emit({
        type: 'final',
        text: this.finalOnClose,
        startMs: 0,
        endMs: 100,
        confidence: 1,
        words: [],
      });
    }
    this.closed = true;
    // Like a vendor's: the close it was asked for still ends in "closed".
    this.emitter.emit({ type: 'closed', code: 1000, reason: null });
    return Promise.resolve();
  }
  on(listener: SttEventListener): () => void {
    return this.emitter.on(listener);
  }
}

class ScriptedSpeechToText implements SpeechToText {
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
  readonly opened: OpenStreamOptions[] = [];
  failWith: Error | null = null;
  /** Applied to every stream this double opens. */
  finalOnClose: string | null = null;
  openStream(options: OpenStreamOptions): Promise<SttStream> {
    this.opened.push(options);
    if (this.failWith) return Promise.reject(this.failWith);
    const stream = new ScriptedStream();
    stream.finalOnClose = this.finalOnClose;
    this.streams.set(options.label, stream);
    return Promise.resolve(stream);
  }
}

function harness(
  overrides: {
    startupError?: string | null;
    override?: string | null;
    mic?: 'granted' | 'denied';
    logger?: Logger;
    store?: InMemoryTranscriptStore;
  } = {},
) {
  const store = overrides.store ?? new InMemoryTranscriptStore();
  // Typed by the narrow views the services take (SttTokenApi, UploadApi), so no cast is needed.
  const api = {
    getSttToken: vi.fn<SttTokenApi['getSttToken']>().mockResolvedValue({
      provider: 'scripted',
      access_token: 'tok',
      expires_in: 30,
      stream: {
        model: 'm',
        language: 'en',
        sample_rate: 16000,
        encoding: 'linear16',
        price_per_hour_usd: 0.15,
      },
    }),
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
  const stt = new ScriptedSpeechToText();
  const uploader = new TranscriptUploader({ store, api, logger });
  let now = 1_000_000;
  const service = new CaptureService({
    store,
    api,
    uploader,
    createSpeechToText: () => stt,
    ensureMicrophoneAccess: () => Promise.resolve(overrides.mic ?? 'granted'),
    logger: overrides.logger ?? logger,
    sttProviderOverride: overrides.override ?? null,
    startupError: overrides.startupError ?? null,
    clock: () => now,
  });
  const statuses: CaptureStatus[] = [];
  const segments: TranscriptSegment[] = [];
  service.on('status', (status) => statuses.push(status));
  service.on('segment', (segment) => segments.push(segment));
  return {
    store,
    api,
    stt,
    uploader,
    service,
    statuses,
    segments,
    advance: (ms: number) => (now += ms),
    /** Fake timers only: let `ms` pass in 100 ms steps, calling `each` after every step. */
    elapse: async (ms: number, each: () => void = () => undefined) => {
      for (let passed = 0; passed < ms; passed += 100) {
        now += 100;
        each();
        await vi.advanceTimersByTimeAsync(100);
      }
    },
  };
}

type Harness = ReturnType<typeof harness>;

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

/** A final line from one stream, as the vendor would send it. */
function sayFinal(h: Harness, source: AudioSource, text: string): void {
  h.stt.streams.get(source)!.emitter.emit({
    type: 'final',
    text,
    startMs: 0,
    endMs: 100,
    confidence: 1,
    words: [],
  });
}

describe('CaptureService', () => {
  it('runs a full session: start, audio, final line stored and uploaded, stop', async () => {
    const h = harness();
    const started = await h.service.start();
    expect(started.phase).toBe('recording');
    expect(started.streams).toEqual({ mic: 'open', system: 'open' });
    expect(h.api.getSttToken).toHaveBeenCalledTimes(1);
    expect(h.stt.opened.map((o) => o.label).sort()).toEqual(['mic', 'system']);
    expect(h.stt.opened[0]?.accessToken).toBe('tok');

    h.advance(2_000);
    h.service.pushAudio('system', new Uint8Array(3200));
    expect(h.stt.streams.get('system')?.sent).toHaveLength(1);
    expect(h.service.getStatus().sources.system).toMatchObject({ health: 'active', chunks: 1 });

    h.stt.streams.get('system')?.emitter.emit({
      type: 'final',
      text: 'Hi Rahul',
      startMs: 500,
      endMs: 1200,
      confidence: 0.9,
      words: [{ text: 'Hi', startMs: 500, endMs: 700, confidence: 0.9 }],
    });
    expect(h.segments).toHaveLength(1);
    expect(h.segments[0]).toMatchObject({
      source: 'system',
      speaker: 'them',
      text: 'Hi Rahul',
      // The 100 ms chunk arrived 2.0 s in, so its audio started at 1.9 s; vendor offsets add to that.
      startMs: 2400,
      endMs: 3100,
    });
    expect(h.segments[0]?.words?.[0]).toMatchObject({ startMs: 2400, endMs: 2600 });
    expect(h.store.countUnsyncedSegments()).toBe(1);
    expect(h.service.getStatus().segmentsStored).toBe(1);

    const stopped = await h.service.stop();
    expect(stopped.phase).toBe('idle');
    expect(h.stt.streams.get('mic')?.closed).toBe(true);
    expect(h.api.createMeeting).toHaveBeenCalledTimes(1);
    expect(h.api.appendSegments).toHaveBeenCalledTimes(1);
    expect(h.api.endMeeting).toHaveBeenCalledTimes(1);
    expect(h.store.listMeetingsNeedingSync()).toEqual([]);
    expect(h.statuses.map((s) => s.phase)).toEqual(
      expect.arrayContaining(['starting', 'recording', 'stopping', 'idle']),
    );
  });

  it('stores finals that arrive while closing before the meeting is ended, and stop() waits for a start in flight', async () => {
    const h = harness();
    h.stt.finalOnClose = 'last words';
    const starting = h.service.start();
    const stopping = h.service.stop(); // queued behind start
    await starting;
    const stopped = await stopping;
    expect(stopped.phase).toBe('idle');
    // One final per stream, both emitted during close, both stored and uploaded before the meeting ends.
    expect(h.segments.map((s) => s.text)).toEqual(['last words', 'last words']);
    const batches = h.api.appendSegments.mock.calls.map((call) => call[1].map((s) => s.text));
    expect(batches).toEqual([['last words', 'last words']]);
    expect(h.api.endMeeting).toHaveBeenCalledTimes(1);
    expect(h.api.appendSegments.mock.invocationCallOrder[0]!).toBeLessThan(
      h.api.endMeeting.mock.invocationCallOrder[0]!,
    );
  });

  it('leaves no empty meeting behind when nothing was said and Postgres never heard of it', async () => {
    const h = harness();
    await h.service.start();
    await h.service.stop();
    expect(h.store.meetings.size).toBe(0);
    expect(h.api.createMeeting).not.toHaveBeenCalled();
    expect(h.api.endMeeting).not.toHaveBeenCalled();
  });

  it('surfaces a stream that dies mid-call as an error the user can read', async () => {
    const h = harness();
    await h.service.start();
    h.stt.streams.get('system')!.emitter.emit({ type: 'closed', code: 1011, reason: 'timeout' });
    const status = h.service.getStatus();
    expect(status.phase).toBe('recording');
    expect(status.streams.system).toBe('error');
    expect(status.error).toContain('Transcription of Them (them) stopped');
    expect(status.error).toContain('code 1011');
    await h.service.stop();
  });

  it('makes a line it could not save locally a visible error, and keeps recording', async () => {
    const store = new FailingStore();
    const h = harness({ store });
    const { meetingId } = await h.service.start();
    store.failNext = new Error('database or disk is full');
    sayFinal(h, 'mic', 'lost line');

    let status = h.service.getStatus();
    expect(status.phase).toBe('recording');
    expect(status.segmentsStored).toBe(0);
    expect(status.segmentsUnsaved).toBe(1);
    expect(status.error).toContain('1 line could not be saved on this Mac');
    expect(status.error).toContain('Mic (me)');
    expect(status.error).toContain(meetingId!);
    expect(status.error).toContain('database or disk is full');
    expect(h.statuses.at(-1)?.error).toBe(status.error);
    expect(h.segments.map((s) => s.text)).toEqual(['lost line']);

    sayFinal(h, 'system', 'kept line');
    status = h.service.getStatus();
    expect(status.segmentsStored).toBe(1);
    expect(status.segmentsUnsaved).toBe(1);
    expect(status.error).toContain('database or disk is full');

    const stopped = await h.service.stop();
    expect(stopped.segmentsUnsaved).toBe(0);
    expect(h.store.getMeeting(meetingId!)?.remoteState).toBe('ended');
  });

  it('returns to idle with an error and no stray meeting when speech-to-text cannot connect', async () => {
    const h = harness();
    h.stt.failWith = new SttConnectError('rejected with HTTP 401', 401);
    const status = await h.service.start();
    expect(status.phase).toBe('idle');
    expect(status.error).toContain('401');
    expect(h.store.meetings.size).toBe(0);
  });

  it('refuses to start without microphone access or with a startup configuration error', async () => {
    const denied = harness({ mic: 'denied' });
    expect((await denied.service.start()).error).toContain('Microphone access is denied');
    const misconfigured = harness({ startupError: 'No API token' });
    expect(await misconfigured.service.start()).toMatchObject({
      phase: 'idle',
      error: 'No API token',
    });
    expect(misconfigured.api.getSttToken).not.toHaveBeenCalled();
  });

  it('refuses to start when the API asks for audio the renderer does not send', async () => {
    const h = harness();
    h.api.getSttToken.mockResolvedValueOnce({
      provider: 'scripted',
      access_token: 'tok',
      expires_in: 30,
      stream: {
        model: 'm',
        language: 'en',
        sample_rate: 48000,
        encoding: 'linear16',
        price_per_hour_usd: null,
      },
    });
    const status = await h.service.start();
    expect(status.phase).toBe('idle');
    expect(status.error).toContain('48000 Hz');
    expect(status.error).toContain('16000 Hz');
    expect(h.stt.opened).toHaveLength(0);
    expect(h.store.meetings.size).toBe(0);
  });

  it('uses the fake adapter without asking the API for a token when overridden', async () => {
    const h = harness({ override: 'fake' });
    const status = await h.service.start();
    expect(status.phase).toBe('recording');
    expect(status.sttProvider).toBe('fake');
    expect(h.api.getSttToken).not.toHaveBeenCalled();
    await h.service.stop();
  });

  it('hands the adapter the stream settings the API names, price included', async () => {
    const h = harness();
    await h.service.start();

    expect(h.stt.opened[0]?.settings).toEqual({
      model: 'm',
      language: 'en',
      sampleRate: 16000,
      encoding: 'linear16',
      pricePerHourUsd: 0.15,
    });
    await h.service.stop();
  });

  it('ignores audio and duplicate transitions outside of recording', async () => {
    const h = harness();
    h.service.pushAudio('mic', new Uint8Array(10));
    expect((await h.service.stop()).phase).toBe('idle');
    const [a, b] = await Promise.all([h.service.start(), h.service.start()]);
    expect(a.phase).toBe('recording');
    expect(b.phase).toBe('recording');
    expect(h.stt.opened).toHaveLength(2);
    await h.service.stop();
  });
});

describe('CaptureService with the uploader loop running', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('leaves no trace in Postgres of a meeting stopped before its first line', async () => {
    const h = harness();
    h.uploader.start();
    await h.service.start();
    await vi.advanceTimersByTimeAsync(5_000); // two upload ticks while recording
    await h.service.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.api.createMeeting).not.toHaveBeenCalled();
    expect(h.api.endMeeting).not.toHaveBeenCalled();
    expect(h.store.meetings.size).toBe(0);
    h.uploader.stop();
  });

  it('creates the meeting in Postgres with its first line, and ends it on stop', async () => {
    const h = harness();
    h.uploader.start();
    const started = await h.service.start();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.api.createMeeting).not.toHaveBeenCalled();

    sayFinal(h, 'mic', 'first words');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.api.createMeeting).toHaveBeenCalledTimes(1);
    expect(h.api.createMeeting.mock.calls[0]?.[0].id).toBe(started.meetingId);
    expect(h.api.appendSegments).toHaveBeenCalledTimes(1);

    await h.service.stop();
    expect(h.api.endMeeting).toHaveBeenCalledTimes(1);
    expect(h.store.getMeeting(started.meetingId!)?.remoteState).toBe('ended');
    h.uploader.stop();
  });

  it('keeps and ends a meeting whose creation is still in flight when Stop is pressed', async () => {
    const h = harness();
    let finishCreate: () => void = () => undefined;
    h.api.createMeeting.mockImplementationOnce(
      (input) =>
        new Promise<MeetingDto>((resolve) => {
          finishCreate = () => {
            resolve(meetingDto(input.id));
          };
        }),
    );
    h.uploader.start();
    const started = await h.service.start();
    sayFinal(h, 'system', 'hello');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.api.createMeeting).toHaveBeenCalledTimes(1);

    const stopping = h.service.stop();
    finishCreate();
    await stopping;
    expect(h.store.getMeeting(started.meetingId!)?.remoteState).toBe('ended');
    expect(h.api.appendSegments).toHaveBeenCalledTimes(1);
    expect(h.api.endMeeting).toHaveBeenCalledTimes(1);
    h.uploader.stop();
  });
});

describe('CaptureService audio flow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const chunk = () => new Uint8Array(3200);

  function warnings() {
    const lines: string[] = [];
    const warnLogger = createLogger({ level: 'warn', format: 'json', sink: (l) => lines.push(l) });
    return { lines, logger: warnLogger };
  }

  it('shows a source that sends no audio for 5 s as stalled, warns once, and clears when audio resumes', async () => {
    const log = warnings();
    const h = harness({ logger: log.logger });
    const { meetingId } = await h.service.start();
    const micChunk = () => {
      h.service.pushAudio('mic', chunk());
    };

    await h.elapse(4_800, micChunk);
    expect(h.service.getStatus().sources.system.health).not.toBe('stalled');

    await h.elapse(1_000, micChunk);
    const status = h.service.getStatus();
    expect(status.sources.system.health).toBe('stalled');
    expect(status.sources.mic.health).toBe('active');
    expect(h.statuses.at(-1)?.sources.system.health).toBe('stalled');
    const stalls = log.lines.filter((l) => l.includes('no audio from source'));
    expect(stalls).toHaveLength(1);
    expect(stalls[0]).toContain('"source":"system"');
    expect(stalls[0]).toContain(`"meetingId":"${meetingId}"`);

    await h.elapse(3_000, micChunk);
    expect(log.lines.filter((l) => l.includes('no audio from source'))).toHaveLength(1);

    h.service.pushAudio('system', chunk());
    expect(h.service.getStatus().sources.system.health).toBe('active');
    expect(h.statuses.at(-1)?.sources.system.health).toBe('active');

    await h.elapse(5_500, micChunk);
    expect(h.service.getStatus().sources.system.health).toBe('stalled');
    await h.service.stop();
  });

  it('does not let the renderer report a stalled source back to healthy without audio', async () => {
    const h = harness();
    await h.service.start();
    await h.elapse(5_500);
    expect(h.service.getStatus().sources.mic.health).toBe('stalled');
    h.service.reportSourceState('mic', 'active', null);
    expect(h.service.getStatus().sources.mic.health).toBe('stalled');
    await h.service.stop();
  });

  it('names the stream whose track ended mid-call, and the stall check leaves it ended', async () => {
    const log = warnings();
    const h = harness({ logger: log.logger });
    const { meetingId } = await h.service.start();
    h.service.pushAudio('system', chunk());
    h.service.reportSourceState('system', 'ended', 'The audio device stopped delivering audio');

    const status = h.service.getStatus();
    expect(status.phase).toBe('recording');
    expect(status.sources.system).toMatchObject({
      health: 'ended',
      message: 'The audio device stopped delivering audio',
    });
    expect(status.error).toContain('Call audio (them) stopped');
    expect(status.error).toContain('The audio device stopped delivering audio');
    const ended = log.lines.find((l) => l.includes('audio source problem'));
    expect(ended).toContain('"source":"system"');
    expect(ended).toContain(`"meetingId":"${meetingId}"`);

    await h.elapse(6_000);
    expect(h.service.getStatus().sources.system.health).toBe('ended');
    await h.service.stop();
  });
});

describe('CaptureService cost guards', () => {
  const chunk = () => new Uint8Array(3200);

  it('closes the session of a source that fails, in the same tick, and leaves the other one open', async () => {
    const h = harness();
    await h.service.start();
    const mic = h.stt.streams.get('mic')!;
    const system = h.stt.streams.get('system')!;

    h.service.reportSourceState(
      'system',
      'error',
      'No screen source is available for system audio',
    );

    // No await: the vendor session is asked to close before reportSourceState returns.
    expect(system.closeCalls).toBe(1);
    expect(mic.closeCalls).toBe(0);
    const status = h.service.getStatus();
    expect(status.streams).toEqual({ mic: 'open', system: 'closed' });
    expect(status.phase).toBe('recording');
    expect(h.statuses.at(-1)?.streams.system).toBe('closed');

    h.service.pushAudio('mic', chunk());
    h.service.pushAudio('system', chunk());
    expect(mic.sent).toHaveLength(1);
    expect(system.sent).toHaveLength(0);
    expect(h.stt.opened).toHaveLength(2); // a failed source never reopens on its own

    await h.service.stop();
    expect(mic.closed).toBe(true);
    expect(system.closeCalls).toBe(1);
  });

  it('closes the session of a source whose track ended mid-call', async () => {
    const h = harness();
    await h.service.start();
    h.service.pushAudio('mic', chunk());
    h.service.reportSourceState('mic', 'ended', 'The audio device stopped delivering audio');

    expect(h.stt.streams.get('mic')?.closed).toBe(true);
    expect(h.stt.streams.get('system')?.closed).toBe(false);
    expect(h.service.getStatus().streams.mic).toBe('closed');
    expect(h.service.getStatus().error).toContain('Mic (me) stopped');
    await h.service.stop();
  });

  it('closes a stream the vendor ended mid-call instead of only forgetting it', async () => {
    const h = harness();
    await h.service.start();
    const system = h.stt.streams.get('system')!;
    system.emitter.emit({ type: 'error', message: 'Session Cancelled', fatal: true });
    expect(system.closeCalls).toBe(1);
    await h.service.stop();
  });
});

describe('defaultMeetingTitle', () => {
  it('names a meeting after its start time', () => {
    expect(defaultMeetingTitle(new Date('2026-10-05T10:05:00Z'))).toMatch(
      /^Meeting 5 Oct 2026 \d\d:\d\d$/,
    );
  });
});
