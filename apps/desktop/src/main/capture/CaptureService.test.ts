import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeetingCalendarEvent } from '../../shared/calendar';
import type { CaptureStatus, StartCaptureRequest } from '../../shared/capture';
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
import type { AudioSink } from './AudioFanout';
import {
  CaptureService,
  defaultMeetingTitle,
  PENDING_START_TTL_MS,
  type RecordingEnded,
  type RecordingStarted,
  type StartRequestEnricher,
} from './CaptureService';
import { CaptureSession } from './CaptureSession';
import { SttOpenBudget } from './SttOpenBudget';

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
    start_source: 'manual',
    calendar_event: null,
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
  /** Decides each open after `failWith`: the error it is refused with, or null to open it. */
  refuse: ((options: OpenStreamOptions) => Error | null) | null = null;
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
    const refusal = this.refuse?.(options) ?? null;
    if (refusal !== null) return Promise.reject(refusal);
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
    /** Built on the harness clock: `(clock) => new SttOpenBudget(limits, clock)`. */
    budget?: (clock: () => number) => SttOpenBudget;
    /** notes.sqlite's check, handed to the uploader as main wires it (M4-T16). */
    hasNotes?: (meetingId: string) => boolean;
    /** The windows' editor save (`notes:flush-request`), handed to the uploader likewise. */
    saveOpenNotes?: () => Promise<void>;
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
  const uploader = new TranscriptUploader({
    store,
    api,
    logger,
    ...(overrides.hasNotes === undefined ? {} : { hasNotes: overrides.hasNotes }),
    ...(overrides.saveOpenNotes === undefined ? {} : { saveOpenNotes: overrides.saveOpenNotes }),
  });
  const budget = overrides.budget?.(() => now);
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
    ...(budget === undefined ? {} : { budget }),
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
    /** The budget injected through `overrides.budget`, if any. */
    budget,
    now: () => now,
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
    // No ids and no stream labels on the page: both are in the log (CaptureSession, 'line not
    // saved locally'). What stays is the plain fact and what to do (house rule 1).
    expect(status.error).not.toContain(meetingId!);
    expect(status.error).not.toContain('Mic (me)');
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

  it('sends a status every 500 ms while recording, changed or not', async () => {
    // M2-T12's followMain opens the mic on the next status the page gets while main records and
    // the page captures none (a reload, a start from the tray): besides its first read and the
    // focus read, this tick is what brings one. Sent only on change, that mic stayed shut.
    const h = harness();
    await h.service.start();
    const before = h.statuses.length;
    await vi.advanceTimersByTimeAsync(2_000); // nothing changes: no audio yet, no stall yet
    expect(h.statuses.length - before).toBe(4);
    expect(h.statuses.at(-1)?.phase).toBe('recording');
    await h.service.stop();
    const after = h.statuses.length;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.statuses.length).toBe(after); // idle: nothing to follow
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

describe('CaptureService with a jargon list the vendor rejects (M3-T4b)', () => {
  /** The token as an API with a jargon list issues it: priced with and without the list. */
  function listedToken(h: Harness): void {
    h.api.getSttToken.mockResolvedValue({
      provider: 'scripted',
      access_token: 'tok',
      expires_in: 30,
      stream: {
        model: 'm',
        language: 'en',
        sample_rate: 16000,
        encoding: 'linear16',
        price_per_hour_usd: 0.19,
        price_per_hour_usd_without_keyterms: 0.15,
        keyterms: ['Linkt', 'Roger'],
      },
    });
  }
  /** The core's error for a connect refused over the list (SttConnection.keytermsRefused). */
  const listRefused = () =>
    new SttConnectError(
      'Scripted: rejected with HTTP 400; the jargon list (2 terms) was rejected',
      400,
      {
        keytermsRejected: true,
      },
    );
  /** A vendor that refuses every open carrying a list. */
  const refusesLists = (options: OpenStreamOptions) =>
    (options.settings.keyterms?.length ?? 0) > 0 ? listRefused() : null;
  const opened = (h: Harness) =>
    h.stt.opened.map(({ label, settings }) => [label, settings.keyterms, settings.pricePerHourUsd]);
  const message =
    'Jargon list rejected by Scripted, transcribing without it. Check the list in Settings.';

  it('records with each refused stream opened again without the list, as a quiet warning on it', async () => {
    const h = harness();
    listedToken(h);
    h.stt.refuse = refusesLists;
    const since = new Date(h.now()).toISOString();
    const status = await h.service.start();

    expect(status).toMatchObject({
      phase: 'recording',
      streams: { mic: 'open', system: 'open' },
      error: null,
    });
    // Opened again on the same token, with no list, at the price of a stream with no list.
    expect(opened(h)).toEqual([
      ['mic', ['Linkt', 'Roger'], 0.19],
      ['system', ['Linkt', 'Roger'], 0.19],
      ['mic', [], 0.15],
      ['system', [], 0.15],
    ]);
    expect(h.api.getSttToken).toHaveBeenCalledTimes(1);
    // Quiet: on screen, never a notification. It holds as long as the list stays off, until Stop.
    expect(status.warnings).toEqual([
      { kind: 'keyterms-rejected', source: 'mic', since, message, loud: false },
      { kind: 'keyterms-rejected', source: 'system', since, message, loud: false },
    ]);
    h.advance(60 * 60_000);
    expect(h.service.getStatus().warnings).toHaveLength(2);
    // Two streams for an hour at the price without the list.
    expect(h.service.getStatus().meter?.total.estimatedCostUsd).toBe(0.3);

    const stopped = await h.service.stop();
    expect(stopped).not.toHaveProperty('warnings');
  });

  it('opens the refused source without the list on every later reopen, at its price', async () => {
    // Five opens inside a minute: Start's two, the one without the list and both reopens.
    const h = harness({ guards: { sttOpensPerMinute: 5 } });
    listedToken(h);
    h.stt.refuse = (options) => (options.label === 'system' ? refusesLists(options) : null);
    await h.service.start();
    expect(h.service.getStatus().warnings?.map((warning) => warning.source)).toEqual(['system']);

    h.stt.streams.get('mic')!.emitter.emit({ type: 'closed', code: 1011, reason: 'timeout' });
    h.stt.streams.get('system')!.emitter.emit({ type: 'closed', code: 1011, reason: 'timeout' });
    h.advance(2_000); // the first backoff
    h.service.pushAudio('mic', new Uint8Array(3200));
    h.service.pushAudio('system', new Uint8Array(3200));
    await new Promise((resolve) => setImmediate(resolve));
    // A fresh token each, both carrying the list: only the refused source goes without it.
    expect(h.api.getSttToken).toHaveBeenCalledTimes(3);
    expect(opened(h).slice(3)).toEqual([
      ['mic', ['Linkt', 'Roger'], 0.19],
      ['system', [], 0.15],
    ]);
    expect(h.service.getStatus().streams).toEqual({ mic: 'open', system: 'open' });
    await h.service.stop();
  });

  it('fails Start with both reasons when the open without the list fails too', async () => {
    const h = harness();
    listedToken(h);
    h.stt.refuse = (options) =>
      refusesLists(options) ?? new SttConnectError('Scripted: rejected with HTTP 401', 401);
    const status = await h.service.start();
    expect(status.phase).toBe('idle');
    expect(status.error).toContain('the jargon list (2 terms) was rejected');
    expect(status.error).toContain(
      '; and without the jargon list: Scripted: rejected with HTTP 401',
    );
    expect(status).not.toHaveProperty('warnings');
    expect(h.store.meetings.size).toBe(0);
  });

  it('never opens again when the API sends no list', async () => {
    const h = harness();
    h.stt.refuse = () => listRefused(); // flagged with no list sent: only a broken adapter could
    const status = await h.service.start();
    expect(status.phase).toBe('idle');
    expect(h.stt.opened).toHaveLength(2);
    expect(status).not.toHaveProperty('warnings');
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
      // No chunk at all is a stall (G2), never silence: the gate kept nothing closed.
      gatedMs: 0,
      estimatedSavedUsd: 0,
    });
    expect(meter).toEqual({
      vendorName: 'Scripted',
      total: {
        sessionsOpened: 2,
        connectedMs: 720_000,
        audioSentMs: 100,
        estimatedCostUsd: 0.03,
        gatedMs: 0,
        estimatedSavedUsd: 0,
      },
      sources: { mic: source(100), system: source(0) },
      silenceGate: 'on',
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

  // A voice, not digital silence: a minute of silence would let the silence gate (M3-T20) close
  // the sessions these tests fail and reopen by hand.
  const chunk = () => new Uint8Array(3200).fill(64);
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
    expect(status.notice).toMatch(
      /^Stopped at \d{1,2}:\d\d [ap]m after 15 minutes with no speech\.$/,
    );
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

  // A Mac that slept: the clock jumps and no timer runs, then the monitor's first tick comes at
  // wake, often before Electron's `resume` reaches PowerCoordinator, which stops a long sleep with
  // `system-sleep`. G5 must not take that stop from it.
  const sleepFor = async (h: Harness, ms: number) => {
    h.advance(ms);
    await vi.advanceTimersByTimeAsync(500);
  };

  it('does not stop a sleep as no-speech: the tick at wake leaves the stop to the sleep reason', async () => {
    const h = harness();
    const ended: string[] = [];
    h.service.onRecording({ ended: (recording) => ended.push(recording.reason) });
    await h.service.start();
    await h.elapse(MINUTE, silence(h), SECOND);

    await sleepFor(h, 20 * MINUTE);
    expect(h.service.getStatus().phase).toBe('recording');
    // What PowerCoordinator.resumed does when `resume` arrives after that tick.
    await h.service.stop({ reason: 'system-sleep' });
    expect(ended).toEqual(['system-sleep']);
  });

  it('counts neither a sleep nor the quiet before it as time with no speech', async () => {
    const h = harness();
    await h.service.start();
    await h.elapse(10 * MINUTE, silence(h), SECOND);
    await sleepFor(h, 6 * MINUTE);
    // 10 quiet minutes before the sleep and 4 after: 14, not 20.
    await h.elapse(4 * MINUTE, silence(h), SECOND);
    expect(h.service.getStatus().phase).toBe('recording');
    await h.elapse(MINUTE + SECOND, silence(h), SECOND);
    expect(h.service.getStatus().phase).toBe('idle');
    expect(h.service.getStatus().notice).toContain('with no speech');
  });

  it('keeps the recording cap on awake time: a sleep does not use it up', async () => {
    const h = harness({ guards: { maxRecordingMs: 2 * MINUTE, noSpeechStopMs: 90 * MINUTE } });
    await h.service.start();
    await h.elapse(MINUTE, silence(h), SECOND);
    await sleepFor(h, 30 * MINUTE);
    await h.elapse(30 * SECOND, silence(h), SECOND);
    expect(h.service.getStatus().phase).toBe('recording');
    await h.elapse(40 * SECOND, silence(h), SECOND);
    expect(h.service.getStatus().notice).toContain('capped at 2 minutes');
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
    expect(status.notice).toMatch(
      /^Stopped at \d{1,2}:\d\d [ap]m: one meeting is capped at 2 minutes\.$/,
    );
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

function jsonLog(level: 'info' | 'warn' | 'error' = 'info') {
  const lines: Record<string, unknown>[] = [];
  const jsonLogger = createLogger({
    level,
    format: 'json',
    sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { lines, logger: jsonLogger };
}

describe('CaptureService open budget', () => {
  it('opens through an injected budget, the one the runtime shares with the gap re-run', async () => {
    const h = harness({
      budget: (clock) => new SttOpenBudget({ perMinute: 4, perMeeting: 30 }, clock),
    });
    const { budget } = h;
    if (budget === undefined) throw new Error('the harness built no budget');

    await h.service.start();
    expect(budget.openedThisMeeting).toBe(2); // Start's two opens came from it
    await h.service.stop();

    // A re-run's opens fill the same minute window, so the next Start must wait for it.
    expect(budget.acquire(2, 'minute')).toEqual({ ok: true });
    const refused = await h.service.start();
    expect(refused.phase).toBe('idle');
    expect(refused.error).toContain("Roger's limit is 4, sttOpensPerMinute");
    expect(h.stt.opened).toHaveLength(2);
  });
});

describe('CaptureService audio fan-out', () => {
  const chunk = (fill = 0) => new Uint8Array(3200).fill(fill);

  function collector(): AudioSink & { got: [string, Uint8Array, number][] } {
    const got: [string, Uint8Array, number][] = [];
    return {
      got,
      onChunk: (source, pcm, capturedAtMs) => {
        got.push([source, pcm, capturedAtMs]);
      },
    };
  }

  it('hands each chunk to every sink and to the session once, with its capture time', async () => {
    const h = harness();
    const sink = collector();
    h.service.addAudioSink('test', sink);
    await h.service.start();
    const pcm = chunk(1);
    h.service.pushAudio('mic', pcm, h.now() - 140);

    expect(sink.got).toEqual([['mic', pcm, 1_000_000 - 140]]);
    expect(h.stt.streams.get('mic')?.sent).toEqual([pcm]);
    expect(h.service.getStatus().sources.mic).toMatchObject({ chunks: 1, lastChunkAt: h.now() });
    await h.service.stop();
  });

  it('dates a chunk sent with no capture time from its arrival: its first sample is one chunk older', async () => {
    const h = harness();
    const sink = collector();
    h.service.addAudioSink('test', sink);
    await h.service.start();
    h.advance(2_000);
    h.service.pushAudio('system', chunk(), null);
    h.service.pushAudio('system', new Uint8Array(1600));
    // 3200 bytes of 16 kHz Int16 is 100 ms; 1600 bytes is 50 ms.
    expect(sink.got.map(([, , at]) => at)).toEqual([1_002_000 - 100, 1_002_000 - 50]);
    await h.service.stop();
  });

  it('gives sinks no audio outside a recording, and stops a removed sink', async () => {
    const h = harness();
    const sink = collector();
    const remove = h.service.addAudioSink('test', sink);
    h.service.pushAudio('mic', chunk(), null);
    await h.service.start();
    h.service.pushAudio('mic', chunk(), null);
    await h.service.stop();
    h.service.pushAudio('mic', chunk(), null);
    expect(sink.got).toHaveLength(1);

    remove();
    await h.service.start();
    h.service.pushAudio('mic', chunk(), null);
    expect(sink.got).toHaveLength(1);
    await h.service.stop();
  });

  it('still sends audio to the vendor when a sink throws, and logs the sink', async () => {
    const log = jsonLog('error');
    const h = harness({ logger: log.logger });
    h.service.addAudioSink('backup', {
      onChunk: () => {
        throw new Error('disk full');
      },
    });
    await h.service.start();
    h.service.pushAudio('system', chunk(2), null);
    expect(h.stt.streams.get('system')?.sent).toHaveLength(1);
    expect(log.lines).toContainEqual(
      expect.objectContaining({ message: 'audio sink failed', sink: 'backup', error: 'disk full' }),
    );
    await h.service.stop();
  });
});

describe('CaptureService recording listeners', () => {
  function listener() {
    const calls: (
      ['started', RecordingStarted, CaptureStatus['phase']] | ['ended', RecordingEnded]
    )[] = [];
    return { calls };
  }

  it('hands the live session over once both streams are open, before any audio', async () => {
    const h = harness();
    const { calls } = listener();
    h.service.onRecording({
      started: (recording) => {
        calls.push(['started', recording, h.service.phase]);
      },
      ended: (recording) => {
        calls.push(['ended', recording]);
      },
    });
    const { meetingId } = await h.service.start();

    expect(calls).toHaveLength(1);
    const [kind, started, phase] = calls[0] as ['started', RecordingStarted, string];
    expect(kind).toBe('started');
    expect(phase).toBe('recording');
    expect(started).toMatchObject({ meetingId, meetingStartedAtMs: 1_000_000, resumed: false });
    expect(started.session).toBeInstanceOf(CaptureSession);
    expect(started.session.meetingId).toBe(meetingId);
    expect(h.stt.streams.get('mic')?.sent).toEqual([]);

    sayFinal(h, 'mic', 'hello');
    await h.service.stop({ reason: 'no-speech' });
    expect(calls.slice(1)).toEqual([
      ['ended', { meetingId, reason: 'no-speech', discarded: false, stopFailed: false }],
    ]);
  });

  it('says when Stop discarded a meeting with no line, and tells nothing of a Start that failed', async () => {
    const h = harness();
    const { calls } = listener();
    h.service.onRecording({ ended: (recording) => calls.push(['ended', recording]) });
    const { meetingId } = await h.service.start();
    await h.service.stop();
    expect(calls).toEqual([
      ['ended', { meetingId, reason: 'user', discarded: true, stopFailed: false }],
    ]);

    h.stt.failWith = new SttConnectError('rejected with HTTP 401', 401);
    await h.service.start();
    expect(calls).toHaveLength(1);
  });

  it('still tells a listener of a Stop that failed, and says its meeting may not be ended', async () => {
    const h = harness();
    const { calls } = listener();
    h.service.onRecording({ ended: (recording) => calls.push(['ended', recording]) });
    const { meetingId } = await h.service.start();
    sayFinal(h, 'mic', 'hello');
    // A full disk or SQLite busy past its timeout: node:sqlite's run() throws.
    vi.spyOn(h.store, 'markMeetingEnded').mockImplementation(() => {
      throw new Error('database or disk is full');
    });

    const stopped = await h.service.stop();

    expect(stopped).toMatchObject({ phase: 'idle', error: 'database or disk is full' });
    expect(h.store.getMeeting(meetingId!)?.endedAt).toBeNull();
    expect(calls).toEqual([
      ['ended', { meetingId, reason: 'user', discarded: false, stopFailed: true }],
    ]);
  });

  it('tells a listener added mid-recording about it at once, and a removed one nothing', async () => {
    const h = harness();
    const { meetingId } = await h.service.start();
    const late = vi.fn<(recording: RecordingStarted) => void>();
    const remove = h.service.onRecording({ started: late });
    expect(late).toHaveBeenCalledTimes(1);
    expect(late.mock.calls[0]?.[0].meetingId).toBe(meetingId);

    remove();
    await h.service.stop();
    await h.service.start();
    expect(late).toHaveBeenCalledTimes(1);
    await h.service.stop();
  });

  it('logs a listener that throws, and the others, Start and Stop still run', async () => {
    const log = jsonLog('error');
    const h = harness({ logger: log.logger });
    h.service.onRecording({
      started: () => {
        throw new Error('power save blocker refused');
      },
      ended: () => {
        throw new Error('upload queue closed');
      },
    });
    const after = vi.fn();
    h.service.onRecording({ started: after, ended: after });

    expect((await h.service.start()).phase).toBe('recording');
    expect((await h.service.stop()).phase).toBe('idle');
    expect(after).toHaveBeenCalledTimes(2);
    expect(log.lines).toContainEqual(
      expect.objectContaining({
        message: 'recording listener failed',
        event: 'started',
        error: 'power save blocker refused',
      }),
    );
    expect(log.lines).toContainEqual(
      expect.objectContaining({ message: 'recording listener failed', event: 'ended' }),
    );
  });
});

describe('CaptureService status contributors', () => {
  const warning = (message: string) => ({
    kind: 'mic-dead' as const,
    source: 'mic' as const,
    since: '2026-10-06T10:00:00.000Z',
    message,
    loud: true,
  });

  it("adds each feature's fields to the status, idle and recording, and joins warnings and notices", async () => {
    const h = harness();
    h.service.addStatusContributor('signal', ({ phase }) =>
      phase === 'recording'
        ? {
            warnings: [warning('Mic is silent')],
            sources: { mic: { signal: 'dead', levelDb: null, device: 'MacBook Pro Microphone' } },
          }
        : {},
    );
    h.service.addStatusContributor('backup', () => ({
      warnings: [warning('Backup paused')],
      backup: { state: 'off', bytes: 0, keepUntil: null, keptForRerun: false, message: null },
      sources: { mic: { device: 'AirPods' } },
    }));

    expect(h.service.getStatus()).toMatchObject({
      phase: 'idle',
      warnings: [{ message: 'Backup paused' }],
      backup: { state: 'off' },
      sources: { mic: { health: 'pending', device: 'AirPods' } },
    });

    await h.service.start();
    const status = h.service.getStatus();
    expect(status.warnings?.map((w) => w.message)).toEqual(['Mic is silent', 'Backup paused']);
    // A field is merged into the landed source status; a later contributor's value wins.
    expect(status.sources.mic).toMatchObject({
      health: 'pending',
      chunks: 0,
      signal: 'dead',
      device: 'AirPods',
    });
    expect(status.sources.system).toEqual({
      health: 'pending',
      chunks: 0,
      lastChunkAt: null,
      message: null,
    });
    await h.service.stop();
  });

  it('copies only the M2 fields: a contributor never changes the landed ones', async () => {
    const h = harness();
    // Not a literal, so the type check lets the extra fields through, as a careless feature might.
    const part = { phase: 'idle', error: 'not mine', paused: 'asleep' as const };
    h.service.addStatusContributor('power', () => part);
    await h.service.start();
    expect(h.service.getStatus()).toMatchObject({
      phase: 'recording',
      error: null,
      paused: 'asleep',
    });
    await h.service.stop();
  });

  it('pushes a fresh status when a feature says its part changed', async () => {
    const h = harness();
    let paused: 'asleep' | null = null;
    h.service.addStatusContributor('power', () => ({ paused }));
    await h.service.start();
    paused = 'asleep';
    h.service.refreshStatus();
    expect(h.statuses.at(-1)?.paused).toBe('asleep');
    await h.service.stop();
  });

  it('leaves out the part of a contributor that throws, logs it once per spell, and stops a removed one', async () => {
    const log = jsonLog('error');
    const h = harness({ logger: log.logger });
    let fail = true;
    const remove = h.service.addStatusContributor('echo', () => {
      if (fail) throw new Error('store closed');
      return { echo: { hidden: 1, trimmed: 0, held: 0 } };
    });
    h.service.addStatusContributor('route', () => ({ route: null }));

    await h.service.start();
    h.service.getStatus();
    const status = h.service.getStatus();
    expect(status.phase).toBe('recording');
    expect(status.route).toBeNull();
    expect(status).not.toHaveProperty('echo');
    expect(log.lines.filter((line) => line.message === 'status contributor failed')).toEqual([
      expect.objectContaining({ contributor: 'echo', error: 'store closed' }),
    ]);

    fail = false;
    expect(h.service.getStatus().echo).toEqual({ hidden: 1, trimmed: 0, held: 0 });
    remove();
    expect(h.service.getStatus()).not.toHaveProperty('echo');
    await h.service.stop();
  });
});

describe('CaptureService resume', () => {
  const MINUTE = 60_000;
  /** The meeting a killed run left open: started 10 minutes before the harness clock. */
  const startedAtMs = 1_000_000 - 10 * MINUTE;
  const saved = (source: number): SttUsage => ({
    sessionsOpened: 15 * source,
    connectedMs: 300_000 * source,
    audioSentMs: 250_000 * source,
    droppedChunks: source,
    estimatedCostUsd: 0.0125 * source,
  });

  function leftOpen(h: Harness, meetingId = '6f1d2b7e-8a4c-4f0e-9b1a-2c3d4e5f6a7b') {
    h.store.createMeeting({
      id: meetingId,
      title: 'Weekly sync',
      startedAt: new Date(startedAtMs).toISOString(),
    });
    h.store.appendSegment({
      id: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
      meetingId,
      source: 'mic',
      speaker: 'me',
      startMs: 1_000,
      endMs: 2_000,
      text: 'before the crash',
      confidence: 1,
      words: [],
      createdAt: new Date(startedAtMs + 2_000).toISOString(),
    });
    h.store.saveSttUsage({
      meetingId,
      provider: 'scripted',
      total: saved(2),
      bySource: { mic: saved(1), system: saved(1) },
      stopReason: null,
      updatedAt: new Date(startedAtMs + 5 * MINUTE).toISOString(),
    });
    return meetingId;
  }

  it('records into the same meeting, with offsets from its first start', async () => {
    const h = harness();
    const meetingId = leftOpen(h);
    const started = vi.fn<(recording: RecordingStarted) => void>();
    h.service.onRecording({ started });

    const status = await h.service.start({ resume: { meetingId } });
    expect(status).toMatchObject({
      phase: 'recording',
      meetingId,
      startedAt: new Date(startedAtMs).toISOString(),
    });
    expect(h.store.meetings.size).toBe(1);
    expect(started.mock.calls[0]?.[0]).toMatchObject({
      meetingId,
      meetingStartedAtMs: startedAtMs,
      resumed: true,
    });

    h.advance(2_000);
    h.service.pushAudio('mic', new Uint8Array(3200));
    sayFinal(h, 'mic', 'after the crash');
    // The chunk arrived 10 min 2 s after the first start; its audio began 100 ms earlier.
    expect(h.segments.at(-1)).toMatchObject({ meetingId, startMs: 10 * MINUTE + 1_900 });

    await h.service.stop();
    expect(h.store.countSegments(meetingId)).toBe(2);
    expect(h.store.getMeeting(meetingId)?.endedAt).not.toBeNull();
  });

  it('adds this run to the saved speech-to-text use, on screen and in the saved row', async () => {
    const h = harness();
    const meetingId = leftOpen(h);
    await h.service.start({ resume: { meetingId } });
    h.advance(MINUTE);

    // Two sessions open a minute each at $0.15 an hour: $0.005, on top of the saved $0.025.
    expect(h.service.getStatus().meter).toEqual({
      vendorName: 'Scripted',
      total: {
        sessionsOpened: 32,
        connectedMs: 720_000,
        audioSentMs: 500_000,
        estimatedCostUsd: 0.03,
        gatedMs: 0,
        estimatedSavedUsd: 0,
      },
      sources: {
        mic: {
          sessionsOpened: 16,
          connectedMs: 360_000,
          audioSentMs: 250_000,
          estimatedCostUsd: 0.015,
          gatedMs: 0,
          estimatedSavedUsd: 0,
        },
        system: {
          sessionsOpened: 16,
          connectedMs: 360_000,
          audioSentMs: 250_000,
          estimatedCostUsd: 0.015,
          gatedMs: 0,
          estimatedSavedUsd: 0,
        },
      },
      silenceGate: 'on',
    });

    await h.service.stop();
    expect(h.store.getSttUsage(meetingId)).toMatchObject({
      total: { sessionsOpened: 32, connectedMs: 720_000, droppedChunks: 2, estimatedCostUsd: 0.03 },
      bySource: { mic: { sessionsOpened: 16 }, system: { connectedMs: 360_000 } },
      stopReason: 'user',
    });
    expect(h.service.getStatus().meter?.total.sessionsOpened).toBe(32); // kept after Stop
  });

  it("carries the saved row's time closed for silence forward, so a resume never zeroes it", async () => {
    const h = harness();
    const meetingId = leftOpen(h);
    const row = h.store.getSttUsage(meetingId);
    if (row === null) throw new Error('no saved row');
    h.store.saveSttUsage({
      ...row,
      gatedMs: 50_000,
      bySource: {
        mic: { ...row.bySource.mic, gatedMs: 20_000 },
        system: { ...row.bySource.system, gatedMs: 30_000 },
      },
    });
    await h.service.start({ resume: { meetingId } });
    h.advance(MINUTE);
    // Priced at this run's $0.15 an hour: the saved row keeps no price of its own.
    const meter = h.service.getStatus().meter;
    expect(meter?.total).toMatchObject({ gatedMs: 50_000, estimatedSavedUsd: 0.0021 });
    expect(meter?.sources.mic).toMatchObject({ gatedMs: 20_000, estimatedSavedUsd: 0.0008 });

    await h.service.stop();
    expect(h.store.getSttUsage(meetingId)).toMatchObject({
      gatedMs: 50_000,
      bySource: { mic: { gatedMs: 20_000 }, system: { gatedMs: 30_000 } },
    });
  });

  it("starts the meeting's open allowance afresh, whatever the saved row counted", async () => {
    // The saved row says 30 opens, the whole default allowance: gate reopens and re-runs count
    // there too, so seeding the allowance from it would refuse the resume's own Start.
    const h = harness({ guards: { sttOpensPerMeeting: 30 } });
    const meetingId = leftOpen(h);
    const status = await h.service.start({ resume: { meetingId } });
    expect(status.phase).toBe('recording');
    expect(h.stt.opened).toHaveLength(2);
    await h.service.stop();
  });

  it('adds nothing up when the saved price was unknown: the cost stays unknown', async () => {
    const h = harness();
    const meetingId = leftOpen(h);
    const row = h.store.getSttUsage(meetingId);
    if (row === null) throw new Error('no saved row');
    h.store.saveSttUsage({ ...row, total: { ...row.total, estimatedCostUsd: null } });
    await h.service.start({ resume: { meetingId } });
    h.advance(MINUTE);
    expect(h.service.getStatus().meter?.total.estimatedCostUsd).toBeNull();
    await h.service.stop();
  });

  it('keeps the meeting when the resume cannot connect, and refuses one that is unknown or ended', async () => {
    const h = harness();
    const meetingId = leftOpen(h);
    h.stt.failWith = new SttConnectError('rejected with HTTP 401', 401);
    const failed = await h.service.start({ resume: { meetingId } });
    expect(failed.phase).toBe('idle');
    expect(failed.error).toContain('401');
    expect(h.store.getMeeting(meetingId)?.endedAt).toBeNull(); // CrashRecovery decides what next
    h.stt.failWith = null;

    const unknown = await h.service.start({
      resume: { meetingId: '0e9d8c7b-6a5f-4e3d-8c1b-0a9f8e7d6c5b' },
    });
    expect(unknown.error).toContain('not in the local store');
    h.store.markMeetingEnded(meetingId, new Date().toISOString());
    const ended = await h.service.start({ resume: { meetingId } });
    expect(ended.error).toContain('already ended');
    expect(h.stt.opened).toHaveLength(2); // the failed connect's two; nothing since
    expect(h.store.meetings.size).toBe(1);
  });

  it("caps the resumed recording's length from the meeting's first start", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ guards: { maxRecordingMs: 15 * MINUTE } });
      const meetingId = leftOpen(h);
      await h.service.start({ resume: { meetingId } });
      const talk = () => {
        h.service.pushAudio('mic', new Uint8Array(3200));
        h.service.pushAudio('system', new Uint8Array(3200));
        sayFinal(h, 'mic', 'still talking');
      };
      await h.elapse(4 * MINUTE + 50_000, talk, 1_000);
      expect(h.service.getStatus().phase).toBe('recording');
      await h.elapse(15_000, talk, 1_000);
      expect(h.service.getStatus().phase).toBe('idle');
      expect(h.store.getMeetingStopReason(meetingId)).toBe('max-duration');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('CaptureService stop reason', () => {
  it("writes the stop's reason to the meeting before closing its streams", async () => {
    const h = harness();
    const { meetingId } = await h.service.start();
    sayFinal(h, 'system', 'hello');
    const mic = h.stt.streams.get('mic')!;
    let reasonAtClose: string | null = null;
    const close = mic.close.bind(mic);
    // A quit whose stop outruns its bound must still leave its reason, not `crash`.
    mic.close = () => {
      reasonAtClose = h.store.getMeetingStopReason(meetingId!);
      return close();
    };
    await h.service.stop({ reason: 'quit', flushUploads: false });
    expect(reasonAtClose).toBe('quit');
    expect(h.store.getMeetingStopReason(meetingId!)).toBe('quit');
  });

  it('closes the streams even when the reason cannot be written', async () => {
    const store = new InMemoryTranscriptStore();
    const log = jsonLog('error');
    const h = harness({ store, logger: log.logger });
    await h.service.start();
    store.setMeetingStopReason = () => {
      throw new Error('database is not open');
    };
    await h.service.stop();
    expect(h.stt.streams.get('mic')?.closed).toBe(true);
    expect(h.stt.streams.get('system')?.closed).toBe(true);
    expect(log.lines).toContainEqual(
      expect.objectContaining({ message: 'stop reason not saved', error: 'database is not open' }),
    );
  });
});

describe('defaultMeetingTitle', () => {
  it('names a meeting after its start time, in the 12-hour form docs/design.md gives', () => {
    expect(defaultMeetingTitle(new Date(2026, 9, 5, 17, 1))).toBe('Meeting at 5:01 pm');
    expect(defaultMeetingTitle(new Date(2026, 9, 5, 0, 7))).toBe('Meeting at 12:07 am');
  });
});

describe('CaptureService meetings with notes (M4)', () => {
  it('Stop keeps a meeting with notes when nobody spoke', async () => {
    const h = harness({ hasNotes: () => true });
    const ended: RecordingEnded[] = [];
    h.service.onRecording({ ended: (recording) => ended.push(recording) });
    const { meetingId } = await h.service.start();
    await h.service.stop();

    // A string, not just "not null": a deleted meeting reads undefined, which passes not.toBeNull().
    expect(h.store.getMeeting(meetingId!)?.endedAt).toEqual(expect.any(String));
    expect(ended).toEqual([{ meetingId, reason: 'user', discarded: false, stopFailed: false }]);
    // Stop's upload flush creates it and ends it in one pass, with no line.
    expect(h.api.createMeeting).toHaveBeenCalledTimes(1);
    expect(h.api.appendSegments).not.toHaveBeenCalled();
    expect(h.api.endMeeting).toHaveBeenCalledTimes(1);
    expect(h.store.getMeeting(meetingId!)?.remoteState).toBe('ended');
  });

  it('a failed start keeps a meeting that has notes', async () => {
    const h = harness({ hasNotes: () => true });
    h.stt.failWith = new SttConnectError('rejected with HTTP 401', 401);
    const status = await h.service.start();
    expect(status.phase).toBe('idle');
    expect(status.error).toContain('401');

    const kept = [...h.store.meetings.values()];
    expect(kept).toHaveLength(1);
    // Ended, so the uploader's pending rule creates it rather than wait for an end that never comes.
    expect(kept[0]?.endedAt).toEqual(expect.any(String));
    await h.uploader.flush();
    expect(h.api.createMeeting).toHaveBeenCalledTimes(1);
    expect(h.api.endMeeting).toHaveBeenCalledTimes(1);
  });

  it('keeps the meeting at Stop when its notes cannot be read, and logs why', async () => {
    const lines: string[] = [];
    const h = harness({
      hasNotes: () => {
        throw new Error('database is locked');
      },
      logger: createLogger({ level: 'error', format: 'json', sink: (line) => lines.push(line) }),
    });
    const { meetingId } = await h.service.start();
    const stopped = await h.service.stop();

    // The Stop itself went through: the uploader asks again on every tick and says so there.
    expect(stopped).toMatchObject({ phase: 'idle', error: null });
    expect(h.store.getMeeting(meetingId!)?.endedAt).toEqual(expect.any(String));
    expect(
      lines.some(
        (line) =>
          line.includes('kept a meeting whose notes could not be checked') &&
          line.includes(`could not read the notes of meeting ${meetingId!}: database is locked`),
      ),
    ).toBe(true);
  });

  it('a failed start keeps and ends a meeting whose notes cannot be read, and logs why', async () => {
    const log = jsonLog('error');
    const h = harness({
      hasNotes: () => {
        throw new Error('database is locked');
      },
      logger: log.logger,
    });
    h.stt.failWith = new SttConnectError('rejected with HTTP 401', 401);
    const status = await h.service.start();
    expect(status).toMatchObject({ phase: 'idle' });
    expect(status.error).toContain('401');

    // Kept, as at Stop: deleted, a meeting whose notes exist would strand them for good.
    const kept = [...h.store.meetings.values()];
    expect(kept).toHaveLength(1);
    const meetingId = kept[0]?.id;
    expect(kept[0]?.endedAt).toEqual(expect.any(String));
    expect(log.lines).toContainEqual(
      expect.objectContaining({
        message: 'kept a meeting whose notes could not be checked',
        meetingId,
        error: `could not read the notes of meeting ${meetingId}: database is locked`,
      }),
    );
  });
});

/**
 * The editor's save, as a window answers main's `notes:flush-request`: it lands a moment later,
 * and only then does notes.sqlite hold the note typed in the editor's last 400 ms.
 */
function lateSave(): { saveOpenNotes: () => Promise<void>; hasNotes: () => boolean } {
  let saved = false;
  return {
    saveOpenNotes: () =>
      new Promise((resolve) => {
        setTimeout(() => {
          saved = true;
          resolve();
        }, 5);
      }),
    hasNotes: () => saved,
  };
}

describe('CaptureService saves the open notes before it decides (M4)', () => {
  it('Stop keeps a meeting whose note was still in the editor', async () => {
    // The tray, the shortcut, Cmd-Q and the auto-stops never blur the editor, so a note typed
    // just before them reaches notes.sqlite only when main asks the windows to save.
    const h = harness(lateSave());
    const ended: RecordingEnded[] = [];
    h.service.onRecording({ ended: (recording) => ended.push(recording) });
    const { meetingId } = await h.service.start();
    await h.service.stop({ reason: 'quit', flushUploads: false });

    expect(h.store.getMeeting(meetingId!)?.endedAt).toEqual(expect.any(String));
    expect(ended).toEqual([{ meetingId, reason: 'quit', discarded: false, stopFailed: false }]);
  });

  it('a failed start keeps a meeting whose note was still in the editor', async () => {
    const h = harness(lateSave());
    h.stt.failWith = new SttConnectError('rejected with HTTP 401', 401);
    await h.service.start();

    const kept = [...h.store.meetings.values()];
    expect(kept).toHaveLength(1);
    expect(kept[0]?.endedAt).toEqual(expect.any(String));
  });

  it('Stop discards a meeting with no line once the editors saved and it has no notes', async () => {
    const calls: string[] = [];
    const h = harness({
      saveOpenNotes: () => {
        calls.push('save');
        return Promise.resolve();
      },
      hasNotes: (meetingId) => {
        calls.push(`check ${meetingId}`);
        return false;
      },
    });
    const ended: RecordingEnded[] = [];
    h.service.onRecording({ ended: (recording) => ended.push(recording) });
    const { meetingId } = await h.service.start();
    await h.service.stop();

    expect(calls).toEqual(['save', `check ${meetingId!}`]);
    expect(h.store.getMeeting(meetingId!)).toBeNull();
    expect(ended).toEqual([{ meetingId, reason: 'user', discarded: true, stopFailed: false }]);
  });

  it('Stop does not wait for the editors when the meeting has a line', async () => {
    const saveOpenNotes = vi.fn(() => Promise.resolve());
    const h = harness({ saveOpenNotes, hasNotes: () => false });
    const { meetingId } = await h.service.start();
    sayFinal(h, 'mic', 'hello');
    await h.service.stop({ flushUploads: false });

    expect(saveOpenNotes).not.toHaveBeenCalled();
    expect(h.store.getMeeting(meetingId!)?.endedAt).toEqual(expect.any(String));
  });

  it('keeps the meeting at Stop when the open notes cannot be saved, and logs why', async () => {
    const log = jsonLog('error');
    const hasNotes = vi.fn(() => false);
    const h = harness({
      saveOpenNotes: () => Promise.reject(new Error('the window is gone')),
      hasNotes,
      logger: log.logger,
    });
    const { meetingId } = await h.service.start();
    const stopped = await h.service.stop({ flushUploads: false });

    // Kept and ended: the uploader decides again on its next tick, after a late save has landed.
    expect(stopped).toMatchObject({ phase: 'idle', error: null });
    expect(h.store.getMeeting(meetingId!)?.endedAt).toEqual(expect.any(String));
    expect(hasNotes).not.toHaveBeenCalled();
    expect(log.lines).toContainEqual(
      expect.objectContaining({
        message: 'kept a meeting whose notes could not be checked',
        meetingId,
        error: 'could not save the notes open in an editor: the window is gone',
      }),
    );
  });

  it('waits at most 1 s for the open notes, then keeps the meeting', async () => {
    vi.useFakeTimers();
    try {
      const log = jsonLog('error');
      const h = harness({
        // A window that never answers (a hung renderer): Stop must still end, Cmd-Q still quit.
        saveOpenNotes: () => new Promise<void>(() => undefined),
        hasNotes: () => false,
        logger: log.logger,
      });
      const { meetingId } = await h.service.start();
      const stopping = h.service.stop({ reason: 'quit', flushUploads: false });
      await vi.advanceTimersByTimeAsync(999);
      expect(h.service.phase).toBe('stopping');

      await vi.advanceTimersByTimeAsync(1);
      await expect(stopping).resolves.toMatchObject({ phase: 'idle', error: null });
      expect(h.store.getMeeting(meetingId!)?.endedAt).toEqual(expect.any(String));
      expect(log.lines).toContainEqual(
        expect.objectContaining({
          message: 'kept a meeting whose notes could not be checked',
          meetingId,
          error: 'saving the open notes timed out after 1000 ms',
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('CaptureService start requests (M5)', () => {
  const STANDUP: MeetingCalendarEvent = {
    provider: 'google',
    eventId: 'standup_20261007T093000Z',
    icalUid: 'standup@google.com',
    recurringEventId: 'standup',
    scheduledStart: '2026-10-07T09:30:00.000Z',
    scheduledEnd: '2026-10-07T09:45:00.000Z',
    attendees: [
      {
        email: 'jane@linkt.ai',
        displayName: 'Jane',
        responseStatus: 'accepted',
        isSelf: false,
        isOrganizer: true,
      },
    ],
  };
  const REVIEW: MeetingCalendarEvent = { ...STANDUP, eventId: 'review_20261007T140000Z' };

  /** The meeting the last Start made, as the store keeps it. */
  const lastMeeting = (h: Harness) => [...h.store.meetings.values()].at(-1);

  it("stores the request's title, source and event with the meeting, and shows the title while it records", async () => {
    const h = harness();
    const started = await h.service.start({
      source: 'notification',
      title: 'Weekly sync',
      calendarEvent: STANDUP,
    });
    expect(started).toMatchObject({ phase: 'recording', title: 'Weekly sync' });
    expect(lastMeeting(h)).toMatchObject({
      id: started.meetingId,
      title: 'Weekly sync',
      startSource: 'notification',
      calendarEvent: STANDUP,
    });
    // No title before the recording names its meeting, and none once it is over.
    expect(h.statuses.find((s) => s.phase === 'starting')?.title).toBeNull();
    sayFinal(h, 'mic', 'hello');
    const stopped = await h.service.stop();
    expect(stopped).toMatchObject({ phase: 'idle', meetingId: null, title: null });
  });

  it('names the meeting after its start without a title, a blank one included', async () => {
    const h = harness();
    const plain = await h.service.start();
    expect(plain.title).toBe(defaultMeetingTitle(new Date(h.now())));
    expect(lastMeeting(h)).toMatchObject({
      title: defaultMeetingTitle(new Date(h.now())),
      startSource: 'manual',
      calendarEvent: null,
    });
    await h.service.stop();

    h.advance(60_000);
    const blank = await h.service.start({ source: 'home', title: '  ' });
    expect(blank.title).toBe(defaultMeetingTitle(new Date(h.now())));
    expect(lastMeeting(h)).toMatchObject({ startSource: 'home', calendarEvent: null });
    await h.service.stop();

    // Blank as the API and the start check read it: U+0000 is dropped before the trim.
    h.advance(60_000);
    const nul = await h.service.start({ title: '\u0000  ' });
    expect(nul.title).toBe(defaultMeetingTitle(new Date(h.now())));
    expect(lastMeeting(h)?.title).toBe(defaultMeetingTitle(new Date(h.now())));
    await h.service.stop();

    // And Python's strip(), the API's blank test, also trims U+001C to U+001F, which the stored
    // title keeps: an invisible title here, while the server named the meeting "Untitled meeting".
    h.advance(60_000);
    const separators = await h.service.start({ title: ` ${String.fromCharCode(0x1c, 0x1f)} ` });
    expect(separators.title).toBe(defaultMeetingTitle(new Date(h.now())));
    expect(lastMeeting(h)?.title).toBe(defaultMeetingTitle(new Date(h.now())));
  });

  // The uploader sends the stored title, so the local title is the one the server keeps.
  it('stores the title as the API stores it: U+0000 dropped, then trimmed as the API trims', async () => {
    const h = harness();
    const nextLine = String.fromCharCode(0x85);
    const started = await h.service.start({ title: `${nextLine} Weekly\u0000 sync ` });
    expect(started.title).toBe('Weekly sync');
    expect(lastMeeting(h)?.title).toBe('Weekly sync');
  });

  it("refuses a request from main's own code that the API would refuse, in the status, before any token", async () => {
    const h = harness();
    const refused = await h.service.start({ source: 'tray', title: 'x'.repeat(501) });
    expect(refused).toMatchObject({
      phase: 'idle',
      error: 'invalid start request: title is over 500 characters',
    });
    expect(h.api.getSttToken).not.toHaveBeenCalled();
    expect(h.store.meetings.size).toBe(0);
  });

  it('runs the enricher on every start that makes a meeting, whatever its source, and stores its answer', async () => {
    const h = harness();
    const enricher = vi.fn<StartRequestEnricher>((request) =>
      request.calendarEvent === undefined
        ? { ...request, title: 'Standup', calendarEvent: STANDUP }
        : request,
    );
    h.service.setStartRequestEnricher(enricher);

    await h.service.start({ source: 'tray' });
    expect(lastMeeting(h)).toMatchObject({
      title: 'Standup',
      startSource: 'tray',
      calendarEvent: STANDUP,
    });
    await h.service.stop();
    h.advance(60_000);
    await h.service.start({ source: 'notification', title: 'Review', calendarEvent: REVIEW });
    expect(lastMeeting(h)).toMatchObject({ title: 'Review', calendarEvent: REVIEW });
    expect(enricher.mock.calls).toEqual([
      [{ source: 'tray' }],
      [{ source: 'notification', title: 'Review', calendarEvent: REVIEW }],
    ]);
  });

  it('starts with the request as it came when the enricher fails or answers one main refuses, and logs why', async () => {
    const log = jsonLog('error');
    const h = harness({ logger: log.logger });
    let answer: () => StartCaptureRequest = () => {
      throw new Error('calendar.sqlite is locked');
    };
    h.service.setStartRequestEnricher(() => answer());

    await h.service.start({ source: 'tray', title: 'Mine' });
    expect(lastMeeting(h)).toMatchObject({
      title: 'Mine',
      startSource: 'tray',
      calendarEvent: null,
    });
    await h.service.stop();
    h.advance(60_000);
    // An event link the API would refuse would keep the meeting off the server.
    answer = () => ({ source: 'tray', calendarEvent: { ...STANDUP, eventId: ' ' } });
    await h.service.start({ source: 'tray', title: 'Mine' });
    expect(lastMeeting(h)).toMatchObject({ title: 'Mine', calendarEvent: null });

    expect(log.lines.filter((line) => line.message === 'start request enricher failed')).toEqual([
      expect.objectContaining({ source: 'tray', error: 'calendar.sqlite is locked' }),
      expect.objectContaining({
        source: 'tray',
        error: 'invalid start request: calendarEvent.eventId is blank',
      }),
    ]);
  });

  // A calendar title has no length limit (a pasted agenda): refused for its title alone, the
  // enricher's answer would lose its event link too, on every manual start near that meeting.
  it("cuts the enricher's calendar title to what the API stores, and keeps its event link", async () => {
    const log = jsonLog('error');
    const h = harness({ logger: log.logger });
    h.service.setStartRequestEnricher((request) => ({
      ...request,
      title: 'x'.repeat(600),
      calendarEvent: STANDUP,
    }));

    const started = await h.service.start({ source: 'tray' });
    expect(started).toMatchObject({ phase: 'recording', title: 'x'.repeat(500) });
    expect(lastMeeting(h)).toMatchObject({
      title: 'x'.repeat(500),
      startSource: 'tray',
      calendarEvent: STANDUP,
    });
    expect(log.lines).toEqual([]);
  });

  it('resumes a meeting with its stored title and event, and asks no enricher', async () => {
    const h = harness();
    const meetingId = '6f1d2b7e-8a4c-4f0e-9b1a-2c3d4e5f6a7b';
    h.store.createMeeting({
      id: meetingId,
      title: 'Standup',
      startedAt: new Date(h.now() - 60_000).toISOString(),
      startSource: 'notification',
      calendarEvent: STANDUP,
    });
    const enricher = vi.fn<StartRequestEnricher>((request) => request);
    h.service.setStartRequestEnricher(enricher);

    const resumed = await h.service.start({ resume: { meetingId } });
    expect(resumed).toMatchObject({ phase: 'recording', meetingId, title: 'Standup' });
    expect(h.store.getMeeting(meetingId)).toMatchObject({
      startSource: 'notification',
      calendarEvent: STANDUP,
    });
    expect(enricher).not.toHaveBeenCalled();
  });

  it('refuses a second enricher, which would silently replace the first', () => {
    const h = harness();
    h.service.setStartRequestEnricher((request) => request);
    expect(() => {
      h.service.setStartRequestEnricher((request) => request);
    }).toThrow('a start request enricher is already set');
  });

  it('hands a requested start to the window once, and drops it after 60 s', () => {
    const h = harness();
    const told: StartCaptureRequest[] = [];
    h.service.on('start-requested', (request) => told.push(request));
    const request: StartCaptureRequest = {
      source: 'notification',
      title: 'Standup',
      calendarEvent: STANDUP,
    };

    h.service.requestStart(request);
    expect(told).toEqual([request]);
    expect(h.service.takePendingStart()).toEqual(request);
    expect(h.service.takePendingStart()).toBeNull(); // taken once

    // The latest request wins; one still waits 60 s after it was made.
    h.service.requestStart({ source: 'call_detected' });
    h.service.requestStart(request);
    h.advance(PENDING_START_TTL_MS);
    expect(h.service.takePendingStart()).toEqual(request);

    h.service.requestStart(request);
    h.advance(PENDING_START_TTL_MS + 1);
    expect(h.service.takePendingStart()).toBeNull();
    expect(h.service.takePendingStart()).toBeNull();
    expect(PENDING_START_TTL_MS).toBe(60_000);
  });

  it("refuses a requested start the window's start would refuse, naming the field", () => {
    const h = harness();
    const told = vi.fn();
    h.service.on('start-requested', told);
    expect(() => {
      h.service.requestStart({
        source: 'notification',
        calendarEvent: { ...STANDUP, eventId: '' },
      });
    }).toThrow('invalid start request: calendarEvent.eventId is blank');
    expect(told).not.toHaveBeenCalled();
    expect(h.service.takePendingStart()).toBeNull();
  });

  // A prompt's Take notes carries the invite's title, which has no length limit: refused, it would
  // fail every time for that event.
  it("cuts a requested start's calendar title to what the API stores, and the window's start takes it", async () => {
    const h = harness();
    h.service.requestStart({
      source: 'notification',
      title: 'x'.repeat(600),
      calendarEvent: STANDUP,
    });
    const request = h.service.takePendingStart();
    expect(request).toEqual({
      source: 'notification',
      title: 'x'.repeat(500),
      calendarEvent: STANDUP,
    });
    const started = await h.service.start(request ?? {});
    expect(started).toMatchObject({ phase: 'recording', title: 'x'.repeat(500) });
    expect(lastMeeting(h)).toMatchObject({ title: 'x'.repeat(500), calendarEvent: STANDUP });
  });

  // A start request is a Start like any other: it never opens past the budget (cost guard G3).
  it('passes a requested start through the open budget: the third quick start is refused, saying why', async () => {
    const h = harness();
    await h.service.start();
    await h.service.stop();
    h.advance(5_000);
    await h.service.start({ source: 'notification', title: 'Standup', calendarEvent: STANDUP });
    await h.service.stop();
    h.advance(5_000);

    h.service.requestStart({ source: 'notification', title: 'Review', calendarEvent: REVIEW });
    const request = h.service.takePendingStart();
    expect(request).not.toBeNull();
    const refused = await h.service.start(request ?? {});
    expect(refused).toMatchObject({ phase: 'idle', meetingId: null, title: null });
    expect(refused.error).toContain("Roger's limit is 4, sttOpensPerMinute");
    expect(h.stt.opened).toHaveLength(4);
    expect(h.store.meetings.size).toBe(0);
  });

  // The prompt's card goes up a minute early, so Take notes on the next meeting often comes while
  // the last one's Stop still uploads (up to 15 s). Answered with the stop's idle status, the
  // request's title and event were lost with no error and no log line.
  it('starts a request that comes while a Stop still uploads once that Stop is done, with its title and event', async () => {
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
    const first = await h.service.start();
    sayFinal(h, 'mic', 'hello');
    const stopping = h.service.stop();
    await vi.waitFor(() => {
      expect(h.api.createMeeting).toHaveBeenCalledTimes(1);
    });
    expect(h.service.phase).toBe('stopping');

    const starting = h.service.start({
      source: 'notification',
      title: 'Review',
      calendarEvent: REVIEW,
    });
    finishCreate();
    await expect(stopping).resolves.toMatchObject({ phase: 'idle', meetingId: null });
    const started = await starting;
    expect(started).toMatchObject({ phase: 'recording', title: 'Review', error: null });
    expect(started.meetingId).not.toBe(first.meetingId);
    expect(lastMeeting(h)).toMatchObject({
      id: started.meetingId,
      title: 'Review',
      startSource: 'notification',
      calendarEvent: REVIEW,
    });
  });

  // M5-T9b stops a recording note before it asks for a start. A request that still meets one, or
  // a start under way, joins it: the answer is that note's status, with no error, so only the log
  // can say the request's own title and event went nowhere.
  it('answers a start while a note starts or records with that note, and logs that its request was not applied', async () => {
    const log = jsonLog('warn');
    const h = harness({ logger: log.logger });
    const starting = h.service.start();
    const joinedStart = h.service.start({ source: 'tray', title: 'Mine' });
    const recording = await starting;
    await expect(joinedStart).resolves.toEqual(recording);

    const joined = await h.service.start({
      source: 'notification',
      title: 'Review',
      calendarEvent: REVIEW,
    });
    expect(joined).toMatchObject({
      phase: 'recording',
      meetingId: recording.meetingId,
      title: recording.title,
      error: null,
    });
    expect(h.store.meetings.size).toBe(1);
    // A plain Start that joins loses nothing, so it says nothing.
    await h.service.start();

    expect(
      log.lines.filter(
        (line) => line.message === 'start request not applied: a recording is starting or running',
      ),
    ).toEqual([
      expect.objectContaining({
        source: 'tray',
        linked: false,
        resume: false,
        phase: 'starting',
        meetingId: null,
      }),
      expect.objectContaining({
        source: 'notification',
        linked: true,
        resume: false,
        phase: 'recording',
        meetingId: recording.meetingId,
      }),
    ]);
  });
});

describe('CaptureService silence gate (M3-T20)', () => {
  function infoLog() {
    const lines: Record<string, unknown>[] = [];
    const infoLogger = createLogger({
      level: 'info',
      format: 'json',
      sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    });
    return { lines, logger: infoLogger };
  }

  /** Lets the token fetches and closes in flight settle. */
  const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  /**
   * `ms` of a call where the mic talks and the call audio is digital silence (nobody else has
   * joined), in 100 ms chunks on the harness clock. Both send chunks, so neither stalls.
   */
  function talkOverSilence(h: Harness, ms: number): void {
    for (let passed = 0; passed < ms; passed += 100) {
      h.advance(100);
      h.service.pushAudio('mic', new Uint8Array(3200).fill(64), h.now() - 100);
      h.service.pushAudio('system', new Uint8Array(3200), h.now() - 100);
    }
  }

  it('closes call audio that only hears silence, and its closed time reaches the status, the log and stt_usage', async () => {
    const log = infoLog();
    const h = harness({ logger: log.logger });
    const { meetingId } = await h.service.start();
    talkOverSilence(h, 60_000); // a session lives a minute at least
    await settle();
    expect(h.stt.streams.get('system')?.closed).toBe(true);
    expect(h.stt.streams.get('mic')?.closed).toBe(false);
    const gated = h.service.getStatus();
    expect(gated.streams.system).toBe('paused');
    expect(gated.streamMessages.system).toMatch(/^silent for \d+ s; reopens when someone speaks$/);
    // The close was metered like any mid-meeting close.
    expect(log.lines.find((line) => line.message === 'stt meter')).toMatchObject({
      closedSource: 'system',
      silenceGate: 'on',
    });

    talkOverSilence(h, 10_000);
    const meter = h.service.getStatus().meter;
    // 10 s closed at the API's $0.15 an hour.
    expect(meter?.sources.system).toMatchObject({ gatedMs: 10_000, estimatedSavedUsd: 0.0004 });
    expect(meter?.sources.mic).toMatchObject({ gatedMs: 0, estimatedSavedUsd: 0 });
    expect(meter?.total).toMatchObject({ gatedMs: 10_000, estimatedSavedUsd: 0.0004 });
    expect(meter?.silenceGate).toBe('on');

    // Someone joins: speech reopens call audio, and its closed time stops there.
    h.advance(100);
    h.service.pushAudio('system', new Uint8Array(3200).fill(64), h.now() - 100);
    await settle();
    expect(h.service.getStatus().streams.system).toBe('open');
    h.advance(5_000);
    await h.service.stop();
    expect(h.service.getStatus().meter?.total.gatedMs).toBe(10_100); // kept after Stop
    expect(log.lines.find((line) => line.message === 'stt meter at stop')).toMatchObject({
      total: { gatedMs: 10_100, estimatedSavedUsd: 0.0004 },
      system: { gatedMs: 10_100 },
      silenceGate: 'on',
      gateReopens: 1,
    });
    expect(h.store.getSttUsage(meetingId!)).toMatchObject({
      gatedMs: 10_100,
      bySource: { mic: { gatedMs: 0 }, system: { gatedMs: 10_100 } },
    });
  });

  it('hands the session each token with its expiry, so the prefetched one is refreshed in time', async () => {
    const h = harness();
    await h.service.start();
    talkOverSilence(h, 60_000);
    await settle();
    // Start's token, then the one prefetched at the close: good for 30 s (expires_in).
    expect(h.api.getSttToken).toHaveBeenCalledTimes(2);
    talkOverSilence(h, 19_900);
    await settle();
    expect(h.api.getSttToken).toHaveBeenCalledTimes(2);
    talkOverSilence(h, 100); // 10 s before it expires
    await settle();
    expect(h.api.getSttToken).toHaveBeenCalledTimes(3);
    await h.service.stop();
  });

  it("keeps a token whose lifetime the API names as 0 s, its fake's, rather than fetch again", async () => {
    const h = harness();
    const token = await h.api.getSttToken();
    h.api.getSttToken.mockClear();
    h.api.getSttToken.mockResolvedValue({ ...token, expires_in: 0 });
    await h.service.start();
    talkOverSilence(h, 60_000);
    await settle();
    for (let step = 0; step < 6; step += 1) {
      talkOverSilence(h, 5_000);
      await settle();
    }
    expect(h.api.getSttToken).toHaveBeenCalledTimes(2); // Start's, and the one prefetched
    await h.service.stop();
  });

  it('is off with sttSilenceCloseMs 0: a silent source keeps its session, and the meter says so', async () => {
    const h = harness({ guards: { sttSilenceCloseMs: 0 } });
    await h.service.start();
    talkOverSilence(h, 120_000);
    await settle();
    expect(h.stt.streams.get('system')?.closed).toBe(false);
    expect(h.service.getStatus().meter).toMatchObject({
      silenceGate: 'off',
      total: { gatedMs: 0 },
    });
    await h.service.stop();
  });

  it('says the gate is spent once its own reopens are used', async () => {
    const h = harness({ guards: { sttSilenceReopensPerMeeting: 1 } });
    await h.service.start();
    talkOverSilence(h, 60_000);
    await settle();
    expect(h.service.getStatus().meter?.silenceGate).toBe('spent');
    await h.service.stop();
    expect(h.service.getStatus().meter?.silenceGate).toBe('spent');
  });
});
