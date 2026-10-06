import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptureStatus } from '../../shared/capture';
import type { AudioSource, TranscriptSegment } from '../../shared/transcript';
import type { MeetingDto, SttTokenApi, UploadApi } from '../api/ApiClient';
import { type CostGuards, DEFAULT_COST_GUARDS } from '../costGuards';
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
import { sumUsage, type SttUsage } from '../stt/usage';
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
  closedAtMs: number | null = null;
  constructor(
    readonly options: OpenStreamOptions,
    readonly openedAtMs: number,
    private readonly clock: () => number,
  ) {}
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
    this.closedAtMs = this.clock();
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
  readonly streams = new Map<string, ScriptedStream>();
  private readonly all: ScriptedStream[] = [];
  readonly opened: OpenStreamOptions[] = [];
  failWith: Error | null = null;
  /** Applied to every stream this double opens. */
  finalOnClose: string | null = null;
  constructor(private readonly clock: () => number) {}
  /** The real factory makes one adapter per Start; this double is reused, so its meter restarts. */
  beginMeeting(): this {
    this.all.length = 0;
    return this;
  }
  /** Metered like a vendor: open time on the harness clock, 100 ms per 3200-byte chunk. */
  usage(label?: string): SttUsage {
    return sumUsage(
      this.all
        .filter((stream) => label === undefined || stream.options.label === label)
        .map((stream) => ({
          opened: true,
          connectedMs: (stream.closedAtMs ?? this.clock()) - stream.openedAtMs,
          audioSentMs: stream.sent.reduce((ms, pcm) => ms + pcm.byteLength / 32, 0),
          droppedChunks: 0,
          pricePerHourUsd: stream.options.settings.pricePerHourUsd,
        })),
    );
  }
  openStream(options: OpenStreamOptions): Promise<SttStream> {
    this.opened.push(options);
    if (this.failWith) return Promise.reject(this.failWith);
    const stream = new ScriptedStream(options, this.clock(), this.clock);
    this.all.push(stream);
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
    guards?: Partial<CostGuards>;
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
        keyterms: [],
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
  let now = 1_000_000;
  const stt = new ScriptedSpeechToText(() => now);
  const uploader = new TranscriptUploader({ store, api, logger });
  const service = new CaptureService({
    store,
    api,
    uploader,
    createSpeechToText: () => stt.beginMeeting(),
    ensureMicrophoneAccess: () => Promise.resolve(overrides.mic ?? 'granted'),
    logger: overrides.logger ?? logger,
    sttProviderOverride: overrides.override ?? null,
    startupError: overrides.startupError ?? null,
    guards: { ...DEFAULT_COST_GUARDS, ...overrides.guards },
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
    /** Fake timers only: let `ms` pass in `stepMs` steps, calling `each` after every step. */
    elapse: async (ms: number, each: () => void = () => undefined, stepMs = 100) => {
      for (let passed = 0; passed < ms; passed += stepMs) {
        now += stepMs;
        each();
        await vi.advanceTimersByTimeAsync(stepMs);
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
    expect(status.streams.system).toBe('retrying');
    expect(status.error).toContain('Transcription of Them (them) stopped');
    expect(status.error).toContain('code 1011');
    expect(status.error).toContain('Reconnecting when its audio flows, in 2 s');
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
        keyterms: [],
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
    expect(h.stt.opened.map((options) => options.settings.keyterms)).toEqual([[], []]);
    await h.service.stop();
  });

  it('hands both adapters the stream settings the API names, price and jargon list included', async () => {
    const h = harness();
    const token = await h.api.getSttToken();
    h.api.getSttToken.mockResolvedValue({
      ...token,
      stream: { ...token.stream, keyterms: ['Linkt', 'Roger'] },
    });
    await h.service.start();

    expect(h.stt.opened).toHaveLength(2);
    for (const options of h.stt.opened) {
      expect(options.settings).toEqual({
        model: 'm',
        language: 'en',
        sampleRate: 16000,
        encoding: 'linear16',
        pricePerHourUsd: 0.15,
        keyterms: ['Linkt', 'Roger'],
      });
    }
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

describe('CaptureService metering', () => {
  function infoLog() {
    const lines: Record<string, unknown>[] = [];
    const infoLogger = createLogger({
      level: 'info',
      format: 'json',
      sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    });
    return { lines, logger: infoLogger };
  }

  it('shows connected time, audio, sessions and cost per source and per meeting, and keeps them after Stop', async () => {
    const log = infoLog();
    const h = harness({ logger: log.logger });
    const { meetingId } = await h.service.start();
    h.service.pushAudio('mic', new Uint8Array(3200));
    h.advance(6 * 60_000);

    const meter = h.service.getStatus().meter;
    const source = (audioSentMs: number) => ({
      sessionsOpened: 1,
      connectedMs: 360_000,
      audioSentMs,
      // Six minutes open at the API's $0.15 an hour, silent or not.
      estimatedCostUsd: 0.015,
    });
    expect(meter).toEqual({
      vendorName: 'Scripted',
      total: { sessionsOpened: 2, connectedMs: 720_000, audioSentMs: 100, estimatedCostUsd: 0.03 },
      sources: { mic: source(100), system: source(0) },
    });

    h.advance(60_000);
    const stopped = await h.service.stop();
    expect(stopped.phase).toBe('idle');
    expect(stopped.meter?.total).toMatchObject({ connectedMs: 840_000, estimatedCostUsd: 0.035 });
    h.advance(60_000);
    expect(h.service.getStatus().meter?.total.connectedMs).toBe(840_000); // the meter stopped

    const summary = log.lines.find((line) => line.message === 'stt meter at stop');
    expect(summary).toMatchObject({
      meetingId,
      provider: 'scripted',
      stopReason: 'user',
      total: { sessionsOpened: 2, connectedMs: 840_000, estimatedCostUsd: 0.035 },
      mic: { connectedMs: 420_000 },
      system: { connectedMs: 420_000 },
    });
    expect(h.store.getSttUsage(meetingId!)).toMatchObject({
      provider: 'scripted',
      total: { sessionsOpened: 2, connectedMs: 840_000, estimatedCostUsd: 0.035 },
      bySource: { mic: { connectedMs: 420_000 }, system: { connectedMs: 420_000 } },
      stopReason: 'user',
    });

    h.api.getSttToken.mockRejectedValueOnce(new Error('API unreachable'));
    expect((await h.service.start()).meter).toBeNull(); // Start forgets the last meeting's meter
  });

  it('shows the cost as unknown, never NaN, when an older API sends no price', async () => {
    const h = harness();
    // An API from before stream.price_per_hour_usd: the field is missing, not null.
    const { price_per_hour_usd: _missing, ...olderStream } = (await h.api.getSttToken()).stream;
    h.api.getSttToken.mockResolvedValue({
      provider: 'scripted',
      access_token: 'tok',
      expires_in: 30,
      stream: olderStream,
    });

    await h.service.start();
    h.advance(60_000);

    expect(h.stt.opened[0]?.settings.pricePerHourUsd).toBeNull();
    expect(h.service.getStatus().meter?.total.estimatedCostUsd).toBeNull();
    await h.service.stop();
  });

  it('logs and saves the meter whenever a session closes mid-meeting', async () => {
    const log = infoLog();
    const h = harness({ logger: log.logger });
    const { meetingId } = await h.service.start();
    h.advance(30_000);
    h.service.reportSourceState(
      'system',
      'error',
      'No screen source is available for system audio',
    );
    await Promise.resolve();
    await Promise.resolve();

    const line = log.lines.find((entry) => entry.message === 'stt meter');
    expect(line).toMatchObject({
      meetingId,
      closedSource: 'system',
      system: { connectedMs: 30_000 },
    });
    expect(h.store.getSttUsage(meetingId!)).toMatchObject({
      stopReason: null,
      bySource: { system: { connectedMs: 30_000 } },
    });
    await h.service.stop();
  });
});

describe('CaptureService stall close', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const chunk = (fill = 0) => new Uint8Array(3200).fill(fill);

  it('closes the session of a source silent for the stall window, and reopens it with a fresh token when audio returns', async () => {
    const h = harness();
    const { meetingId } = await h.service.start();
    const meetingStart = 1_000_000;
    const firstSystem = h.stt.streams.get('system')!;
    const micChunk = () => {
      h.service.pushAudio('mic', chunk());
    };

    await h.elapse(29_000, micChunk);
    expect(firstSystem.closeCalls).toBe(0);
    await h.elapse(1_500, micChunk);
    expect(firstSystem.closed).toBe(true);
    expect(h.stt.streams.get('mic')?.closeCalls).toBe(0);
    let status = h.service.getStatus();
    expect(status.streams).toEqual({ mic: 'open', system: 'paused' });
    expect(status.streamMessages.system).toContain('no audio for 30 s');
    expect(status.phase).toBe('recording');

    h.api.getSttToken.mockResolvedValueOnce({
      provider: 'scripted',
      access_token: 'fresh-token',
      expires_in: 30,
      stream: {
        model: 'm',
        language: 'en',
        sample_rate: 16000,
        encoding: 'linear16',
        price_per_hour_usd: 0.15,
        // Edited since Start: a reopen's fresh token carries the list as it is now.
        keyterms: ['Linkt'],
      },
    });
    const arrivedAt = 1_000_000 + 30_500;
    const first = chunk(1);
    const second = chunk(2);
    h.service.pushAudio('system', first); // wakes the source: a reopen starts
    h.service.pushAudio('system', second); // arrives while it connects
    expect(h.service.getStatus().streams.system).toBe('connecting');
    await vi.advanceTimersByTimeAsync(0);

    expect(h.api.getSttToken).toHaveBeenCalledTimes(2);
    expect(h.stt.opened.at(-1)).toMatchObject({ label: 'system', accessToken: 'fresh-token' });
    expect(h.stt.opened.at(-1)?.settings.keyterms).toEqual(['Linkt']);
    const reopened = h.stt.streams.get('system')!;
    expect(reopened).not.toBe(firstSystem);
    // Nothing lost, nothing reordered: the chunk that woke it goes first.
    expect(reopened.sent).toEqual([first, second]);
    status = h.service.getStatus();
    expect(status.streams.system).toBe('open');
    expect(status.streamMessages.system).toBeNull();

    // The new stream's clock starts at the first buffered chunk, so lines stay meeting-relative.
    sayFinal(h, 'system', 'back again');
    expect(h.segments.at(-1)).toMatchObject({
      meetingId,
      text: 'back again',
      startMs: arrivedAt - 100 - meetingStart,
    });
    await h.service.stop();
    expect(reopened.closed).toBe(true);
  });

  it('closes both sessions when no audio arrives at all, and keeps them closed without audio', async () => {
    const h = harness();
    await h.service.start();
    await h.elapse(31_000);
    expect(h.service.getStatus().streams).toEqual({ mic: 'paused', system: 'paused' });
    await h.elapse(60_000);
    expect(h.stt.opened).toHaveLength(2);
    expect(h.api.getSttToken).toHaveBeenCalledTimes(1);
    await h.service.stop();
  });
});

describe('CaptureService reopen budget', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const chunk = () => new Uint8Array(3200);
  const bothTalk = (h: Harness) => () => {
    h.service.pushAudio('mic', chunk());
    h.service.pushAudio('system', chunk());
  };
  const vendorCloses = (h: Harness, source: AudioSource, code = 1011, reason = 'server error') => {
    h.stt.streams.get(source)!.emitter.emit({ type: 'closed', code, reason });
  };

  it('reopens a session the vendor ended mid-call after a backoff, with a fresh token, when audio flows', async () => {
    const h = harness();
    await h.service.start();
    const first = h.stt.streams.get('system')!;
    await h.elapse(1_000, bothTalk(h));

    // The vendor's 3-hour cap: AssemblyAI closes with 3008. Recording goes on, so a fresh one opens.
    vendorCloses(h, 'system', 3008, 'Session Expired: Maximum session duration exceeded');
    expect(first.closeCalls).toBe(1);
    expect(h.service.getStatus().streams.system).toBe('retrying');
    await h.elapse(1_900, bothTalk(h));
    expect(h.stt.opened).toHaveLength(2); // still inside the 2 s backoff: nothing opened

    await h.elapse(200, bothTalk(h));
    expect(h.stt.opened).toHaveLength(3);
    expect(h.api.getSttToken).toHaveBeenCalledTimes(2);
    const status = h.service.getStatus();
    expect(status.streams.system).toBe('open');
    expect(status.error).toBeNull();
    expect(h.stt.streams.get('system')!.sent.length).toBeGreaterThan(0);
    await h.service.stop();
  });

  it('counts the reconnect wait down on screen, and drops it once only audio is awaited', async () => {
    const h = harness();
    await h.service.start();
    const micTalks = () => {
      h.service.pushAudio('mic', chunk());
    };
    await h.elapse(1_000, bothTalk(h));

    vendorCloses(h, 'system');
    expect(h.service.getStatus().error).toContain('Reconnecting when its audio flows, in 2 s.');
    await h.elapse(1_000, micTalks); // the system source has gone quiet
    expect(h.service.getStatus().error).toContain('Reconnecting when its audio flows, in 1 s.');
    await h.elapse(1_500, micTalks);

    // The wait is over, but a source reopens only with its next chunk: no countdown to show.
    const status = h.service.getStatus();
    expect(status.streams.system).toBe('retrying');
    expect(status.error).toMatch(/Reconnecting when its audio flows\.$/);
    expect(h.statuses.at(-1)?.error).toBe(status.error);
    expect(h.stt.opened).toHaveLength(2);
    await h.service.stop();
  });

  it('doubles the backoff for failures in a row, and starts over after a stream stayed up a minute', async () => {
    const h = harness({ guards: { sttOpensPerMinute: 100 } });
    await h.service.start();
    const opensAfter = async (ms: number) => {
      await h.elapse(ms, bothTalk(h));
      return h.stt.opened.length;
    };
    vendorCloses(h, 'system');
    expect(await opensAfter(2_100)).toBe(3); // 2 s
    vendorCloses(h, 'system');
    expect(await opensAfter(3_500)).toBe(3);
    expect(await opensAfter(700)).toBe(4); // 4 s
    vendorCloses(h, 'system');
    expect(await opensAfter(7_500)).toBe(4);
    expect(await opensAfter(700)).toBe(5); // 8 s

    await h.elapse(60_000, bothTalk(h)); // up for a minute: healthy again
    vendorCloses(h, 'system');
    expect(await opensAfter(2_100)).toBe(6); // 2 s again
    await h.service.stop();
  });

  it('counts every open of both sources against one budget, and waits when the minute is spent', async () => {
    const h = harness();
    await h.service.start(); // opens 1 and 2
    vendorCloses(h, 'system');
    await h.elapse(2_100, bothTalk(h)); // 3
    vendorCloses(h, 'mic');
    await h.elapse(2_100, bothTalk(h)); // 4
    expect(h.stt.opened).toHaveLength(4);

    vendorCloses(h, 'system');
    await h.elapse(10_000, bothTalk(h));
    // A 5th open in the minute would trip AssemblyAI's free-tier limit: Roger waits instead.
    expect(h.stt.opened).toHaveLength(4);
    let status = h.service.getStatus();
    expect(status.streams.system).toBe('retrying');
    expect(status.streamMessages.system).toContain("Roger's limit is 4, sttOpensPerMinute");
    expect(status.error).toContain('Transcription of Them (them)');

    await h.elapse(46_000, bothTalk(h)); // Start's opens leave the window at 60 s
    expect(h.stt.opened).toHaveLength(5);
    status = h.service.getStatus();
    expect(status.streams.system).toBe('open');
    await h.service.stop();
  });

  it("stays closed with a visible error once the meeting's opens are spent", async () => {
    const h = harness({ guards: { sttOpensPerMeeting: 3 } });
    await h.service.start();
    vendorCloses(h, 'system');
    await h.elapse(2_100, bothTalk(h));
    expect(h.stt.opened).toHaveLength(3);

    vendorCloses(h, 'system');
    await h.elapse(120_000, bothTalk(h));
    expect(h.stt.opened).toHaveLength(3);
    const status = h.service.getStatus();
    expect(status.streams).toEqual({ mic: 'open', system: 'error' });
    expect(status.streamMessages.system).toContain("Roger's limit is 3, sttOpensPerMeeting");
    expect(status.error).toContain('Transcription of Them (them) stopped');
    expect(status.error).toContain('Press Stop, then Start again');
    await h.service.stop();
  });

  it('refuses a Start when the minute is spent, says when to try, and opens nothing', async () => {
    const h = harness();
    await h.service.start();
    await h.service.stop();
    h.advance(5_000);
    await h.service.start();
    await h.service.stop();
    h.advance(5_000);

    const refused = await h.service.start();
    expect(refused.phase).toBe('idle');
    expect(refused.error).toContain("Roger's limit is 4, sttOpensPerMinute");
    expect(refused.error).toContain('the next may open in 50 s');
    expect(h.stt.opened).toHaveLength(4);
    expect(h.store.meetings.size).toBe(0);
    // The two meetings that ran keep their usage; the refused one opened nothing to keep.
    expect(h.store.sttUsage.size).toBe(2);
  });
});

describe('CaptureService forgotten Stop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const SECOND = 1_000;
  const MINUTE = 60 * SECOND;
  /** Silence still flowing from both sources, a second at a time: no stall, no speech. */
  const silence = (h: Harness) => () => {
    h.service.pushAudio('mic', new Uint8Array(3200));
    h.service.pushAudio('system', new Uint8Array(3200));
  };

  it('stops after 15 minutes with no final line from either source, through the normal stop', async () => {
    const h = harness();
    await h.service.start();
    const mic = h.stt.streams.get('mic')!;

    await h.elapse(14 * MINUTE + 50 * SECOND, silence(h), SECOND);
    expect(h.service.getStatus().phase).toBe('recording');
    await h.elapse(15 * SECOND, silence(h), SECOND);

    const status = h.service.getStatus();
    expect(status.phase).toBe('idle');
    expect(status.notice).toMatch(/^Stopped at \d\d:\d\d after 15 minutes with no speech\.$/);
    expect(mic.closed).toBe(true);
    expect(h.stt.streams.get('system')?.closed).toBe(true);
    expect(h.statuses.at(-1)?.notice).toBe(status.notice);
  });

  it('counts the 15 minutes from the last final line, from either source', async () => {
    const h = harness();
    await h.service.start();
    await h.elapse(10 * MINUTE, silence(h), SECOND);
    sayFinal(h, 'system', 'are you still there?');
    await h.elapse(14 * MINUTE, silence(h), SECOND);
    expect(h.service.getStatus().phase).toBe('recording');
    await h.elapse(1 * MINUTE + SECOND, silence(h), SECOND);
    expect(h.service.getStatus().phase).toBe('idle');
  });

  it('stops at the recording cap even while people talk, and both limits can be set', async () => {
    const h = harness({ guards: { maxRecordingMs: 2 * MINUTE, noSpeechStopMs: 90 * SECOND } });
    const { meetingId } = await h.service.start();
    const talk = () => {
      silence(h)();
      sayFinal(h, 'mic', 'still talking');
    };
    await h.elapse(119 * SECOND, talk, SECOND);
    expect(h.service.getStatus().phase).toBe('recording');
    await h.elapse(2 * SECOND, talk, SECOND);

    const status = h.service.getStatus();
    expect(status.phase).toBe('idle');
    expect(status.notice).toMatch(/^Stopped at \d\d:\d\d: one recording is capped at 2 minutes\.$/);
    expect(h.store.getMeeting(meetingId!)?.endedAt).not.toBeNull();
  });

  it('shows no notice for a Stop the person pressed, and clears an old one on Start', async () => {
    const h = harness({ guards: { noSpeechStopMs: MINUTE } });
    await h.service.start();
    await h.elapse(MINUTE + SECOND, silence(h), SECOND);
    expect(h.service.getStatus().notice).toContain('after 1 minute with no speech');

    await h.service.start();
    expect(h.service.getStatus().notice).toBeNull();
    await h.service.stop();
    expect(h.service.getStatus().notice).toBeNull();
  });
});

describe('defaultMeetingTitle', () => {
  it('names a meeting after its start time', () => {
    expect(defaultMeetingTitle(new Date('2026-10-05T10:05:00Z'))).toMatch(
      /^Meeting 5 Oct 2026 \d\d:\d\d$/,
    );
  });
});
