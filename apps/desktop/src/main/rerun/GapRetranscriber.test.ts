import { describe, expect, it } from 'vitest';
import {
  type CapturePhase,
  type CaptureStatus,
  idleCaptureStatus,
  type RerunStatus,
  type TranscriptSegmentChange,
} from '../../shared/capture';
import { PCM_SAMPLE_RATE } from '../../shared/ipc';
import type { AudioSource, TranscriptWord } from '../../shared/transcript';
import type { RecordingEnded, StatusContributor } from '../capture/CaptureService';
import { EchoSink } from '../capture/echo/EchoSink';
import { RouteHistory } from '../capture/echo/RouteProvider';
import { SttOpenBudget } from '../capture/SttOpenBudget';
import { createLogger } from '../logger';
import { InMemoryTranscriptStore } from '../store/InMemoryTranscriptStore';
import type { GapReason, MeetingSttUsage, StoredSegment } from '../store/TranscriptStore';
import {
  type OpenStreamOptions,
  type SpeechToText,
  SttConnectError,
  SttEventEmitter,
  type SttEventListener,
  type SttStream,
} from '../stt/SpeechToText';
import { type SessionUsage, sumUsage, type SttUsage } from '../stt/usage';
import type { GapAudioPiece } from './gapAudio';
import { GapRetranscriber, RERUN_PAD_MS, type RerunCapture } from './GapRetranscriber';
import type { RerunCredentials } from './rerunStt';

const logger = createLogger({ level: 'error', format: 'json', sink: () => undefined });
const MEETING = '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d';
const STARTED_AT = '2026-10-07T09:00:00.000Z';
const ENDED_AT = '2026-10-07T09:30:00.000Z';
/** The re-run happens later the same day. */
const LATER = Date.parse('2026-10-07T11:00:00.000Z');
const BYTES_PER_MS = (PCM_SAMPLE_RATE / 1_000) * 2;
const PRICE_PER_HOUR = 0.36;

let ids = 0;
function uuid(): string {
  ids += 1;
  return `${String(ids).padStart(8, '0')}-aaaa-4bbb-8ccc-000000000000`;
}

function word(text: string, startMs: number, endMs: number): TranscriptWord {
  return { text, startMs, endMs, confidence: 0.9 };
}

/** A vendor final on the stream's own clock: ms from the first byte the re-run sent. */
interface VendorFinal {
  text: string;
  startMs: number;
  endMs: number;
  words: TranscriptWord[];
}

function said(words: TranscriptWord[]): VendorFinal {
  return {
    text: words.map((w) => w.text).join(' '),
    startMs: words[0]?.startMs ?? 0,
    endMs: words.at(-1)?.endMs ?? 0,
    words,
  };
}

/**
 * The vendor, scripted per source: what it answers once the re-run closes the stream. Every
 * adapter the factory makes logs its opens here, so a test sees each session in order.
 */
class ScriptedVendor {
  readonly opens: { label: string; keyterms: readonly string[]; atMs: number }[] = [];
  readonly streams: ScriptedStream[] = [];
  /** The finals each source's session sends at its close. */
  finals: Partial<Record<AudioSource, VendorFinal[]>> = {};
  /** The next opens throw these, in order. */
  openErrors: Error[] = [];
  /** A fatal error each source's session reports at its close, after its finals. */
  fatalAtClose: Partial<Record<AudioSource, string>> = {};
  /** Called after each chunk is sent: a test acts mid-session here. */
  onSend: (stream: ScriptedStream) => void = () => undefined;

  constructor(readonly clock: () => number) {}

  readonly factory = (provider: string): SpeechToText => new ScriptedStt(this, provider);
}

class ScriptedStt implements SpeechToText {
  readonly vendorName = 'Scripted';
  private readonly mine: ScriptedStream[] = [];

  constructor(
    private readonly vendor: ScriptedVendor,
    readonly provider: string,
  ) {}

  openStream(options: OpenStreamOptions): Promise<SttStream> {
    const { vendor } = this;
    vendor.opens.push({
      label: options.label,
      keyterms: options.settings.keyterms ?? [],
      atMs: vendor.clock(),
    });
    const error = vendor.openErrors.shift();
    if (error !== undefined) return Promise.reject(error);
    const stream = new ScriptedStream(vendor, options.label as AudioSource);
    vendor.streams.push(stream);
    this.mine.push(stream);
    return Promise.resolve(stream);
  }

  usage(label?: string): SttUsage {
    return sumUsage(
      this.mine
        .filter((stream) => label === undefined || stream.source === label)
        .map((s) => s.usage()),
    );
  }
}

class ScriptedStream implements SttStream {
  sentBytes = 0;
  terminated = false;
  private closed = false;
  private readonly emitter = new SttEventEmitter();

  constructor(
    private readonly vendor: ScriptedVendor,
    readonly source: AudioSource,
  ) {}

  get sentMs(): number {
    return this.sentBytes / BYTES_PER_MS;
  }

  send(pcm: Uint8Array): void {
    this.sentBytes += pcm.byteLength;
    this.vendor.onSend(this);
  }

  close(): Promise<void> {
    if (!this.closed) {
      for (const final of this.vendor.finals[this.source] ?? []) {
        this.emitter.emit({ type: 'final', confidence: 0.8, ...final });
      }
      const fatal = this.vendor.fatalAtClose[this.source];
      if (fatal !== undefined) this.emitter.emit({ type: 'error', message: fatal, fatal: true });
      this.end();
    }
    return Promise.resolve();
  }

  terminate(): Promise<void> {
    if (!this.closed) {
      this.terminated = true;
      this.end();
    }
    return Promise.resolve();
  }

  on(listener: SttEventListener): () => void {
    return this.emitter.on(listener);
  }

  usage(): SessionUsage {
    // Billed while open: here, for exactly the audio it was sent.
    return {
      opened: true,
      connectedMs: this.sentMs,
      audioSentMs: this.sentMs,
      droppedChunks: 0,
      pricePerHourUsd: PRICE_PER_HOUR,
    };
  }

  private end(): void {
    this.closed = true;
    this.emitter.emit({ type: 'closed', code: null, reason: null });
  }
}

/** CaptureService's seams the re-run uses, driven by hand. */
function fakeCapture() {
  let phase: CapturePhase = 'idle';
  const statusListeners = new Set<(status: CaptureStatus) => void>();
  const recordings: { ended?(recording: RecordingEnded): void }[] = [];
  let contributor: StatusContributor | null = null;
  const rerun = (): RerunStatus | null => contributor?.({ phase, meetingId: null }).rerun ?? null;
  /** Every re-run status the window was sent, in order. */
  const seen: (RerunStatus | null)[] = [];
  const status = (): CaptureStatus => ({
    ...idleCaptureStatus({
      state: 'idle',
      pending: 0,
      rejected: 0,
      lastError: null,
      nextAttemptAt: null,
    }),
    phase,
  });
  const capture: RerunCapture = {
    get phase() {
      return phase;
    },
    on: (_event, listener) => {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    onRecording: (listener) => {
      recordings.push(listener);
      return () => undefined;
    },
    addStatusContributor: (_name, read) => {
      contributor = read;
      return () => undefined;
    },
    refreshStatus: () => {
      seen.push(rerun());
    },
  };
  return {
    capture,
    seen,
    rerun,
    /** CaptureService's setPhase: the phase changes, and a status goes out. */
    setPhase: (next: CapturePhase) => {
      phase = next;
      for (const listener of [...statusListeners]) listener(status());
    },
    /** Stop's `ended`, while the phase is still `stopping`. */
    ended: (meetingId: string) => {
      for (const listener of recordings) {
        listener.ended?.({ meetingId, reason: 'user', discarded: false, stopFailed: false });
      }
    },
  };
}

interface HarnessOptions {
  perMinute?: number;
  perMeeting?: number;
  stopReason?: 'user' | 'crash';
  /** False: the test calls start() itself, once the store holds what launch should find. */
  started?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const clock = { now: LATER };
  const store = new InMemoryTranscriptStore(() => new Date(clock.now));
  store.createMeeting({ id: MEETING, title: 'Weekly sync', startedAt: STARTED_AT });
  store.setMeetingStopReason(MEETING, options.stopReason ?? 'user');
  store.markMeetingEnded(MEETING, ENDED_AT);
  const budget = new SttOpenBudget(
    { perMinute: options.perMinute ?? 4, perMeeting: options.perMeeting ?? 30 },
    () => clock.now,
  );
  const vendor = new ScriptedVendor(() => clock.now);
  const capture = fakeCapture();
  const changes: TranscriptSegmentChange[] = [];
  const echo = new EchoSink({
    store,
    enabled: true,
    route: new RouteHistory(() => clock.now),
    publishChange: (change) => changes.push(change),
    logger,
    clock: () => clock.now,
  });
  /** What the backup holds per source: [start, length] in meeting ms, one file each. */
  const backup: Record<AudioSource, [number, number][]> = { mic: [], system: [] };
  const reads: { source: AudioSource; fromMs: number; toMs: number }[] = [];
  const recovered: string[] = [];
  let credentials = 0;
  const rerun = new GapRetranscriber({
    store,
    capture: capture.capture,
    budget,
    opensPerMinute: options.perMinute ?? 4,
    credentials: (): Promise<RerunCredentials> => {
      credentials += 1;
      return Promise.resolve({
        provider: 'scripted',
        accessToken: `token-${credentials}`,
        settings: {
          model: 'm',
          language: 'en',
          sampleRate: PCM_SAMPLE_RATE,
          encoding: 'linear16',
          pricePerHourUsd: PRICE_PER_HOUR,
          keyterms: ['Roger'],
        },
        pricePerHourUsdWithoutKeyterms: 0.3,
      });
    },
    createSpeechToText: vendor.factory,
    audio: {
      read: (_meetingId, source, fromMs, toMs) => {
        reads.push({ source, fromMs, toMs });
        const pieces: GapAudioPiece[] = [];
        for (const [startMs, lengthMs] of backup[source]) {
          const from = Math.max(fromMs, startMs);
          const to = Math.min(toMs, startMs + lengthMs);
          if (to > from) {
            pieces.push({ startMs: from, pcm: new Uint8Array((to - from) * BYTES_PER_MS).fill(1) });
          }
        }
        return Promise.resolve(pieces);
      },
    },
    echo,
    onRecovered: (meetingId) => recovered.push(meetingId),
    logger,
    clock: () => clock.now,
    paceClock: () => clock.now,
    // Time passes only when the re-run waits: real time, at no cost to the test.
    sleep: (ms) => {
      clock.now += ms;
      return Promise.resolve();
    },
  });

  const gap = (
    source: AudioSource,
    startMs: number,
    endMs: number,
    reason: GapReason = 'offline',
  ) => {
    const id = uuid();
    store.addGap({
      id,
      meetingId: MEETING,
      source,
      startMs,
      endMs,
      reason,
      createdAt: STARTED_AT,
    });
    return id;
  };
  const line = (source: AudioSource, words: TranscriptWord[]): string => {
    const id = uuid();
    store.appendSegment({
      id,
      meetingId: MEETING,
      source,
      speaker: source === 'mic' ? 'me' : 'them',
      startMs: words[0]?.startMs ?? 0,
      endMs: words.at(-1)?.endMs ?? 0,
      text: words.map((w) => w.text).join(' '),
      confidence: 0.9,
      words,
      createdAt: STARTED_AT,
    });
    return id;
  };
  if (options.started !== false) rerun.start();
  const rerunLines = (): StoredSegment[] =>
    [
      ...store.listSegmentsOverlapping(MEETING, 'mic', 0, 1e9),
      ...store.listSegmentsOverlapping(MEETING, 'system', 0, 1e9),
    ].filter((segment) => segment.origin === 'rerun');
  const gapOf = (id: string) => store.listGaps(MEETING).find((g) => g.id === id);
  /** The backup holds `lengthMs` of `source` from `startMs`: one closed file, its row and audio. */
  const keep = (source: AudioSource, startMs: number, lengthMs: number): void => {
    backup[source].push([startMs, lengthMs]);
    const id = uuid();
    store.addAudioFile({
      id,
      meetingId: MEETING,
      source,
      startMs,
      path: `audio/${MEETING}/${source}-${startMs}.wav`,
      format: 'wav',
      createdAt: STARTED_AT,
    });
    store.closeAudioFile(id, {
      endMs: startMs + lengthMs,
      bytes: 44 + lengthMs * BYTES_PER_MS,
      closedAt: ENDED_AT,
    });
  };

  return {
    clock,
    store,
    budget,
    vendor,
    capture,
    changes,
    backup,
    reads,
    recovered,
    rerun,
    gap,
    line,
    keep,
    rerunLines,
    gapOf,
  };
}

describe('GapRetranscriber', () => {
  it('re-runs a gap from its backup audio and adds only the words the stored lines lack', async () => {
    const h = harness();
    h.line('system', [word('before', 0, 1_000), word('first.', 2_200, 2_800)]);
    h.line('system', [word('second', 6_200, 6_600), word('after', 7_000, 8_000)]);
    const gap = h.gap('system', 3_000, 6_000, 'stt_failed');
    h.keep('system', 0, 10_000);
    // The stream's clock starts at the window's start, a second before the gap.
    const from = 3_000 - RERUN_PAD_MS;
    h.vendor.finals.system = [
      said([
        word('first.', 2_200 - from, 2_800 - from),
        word('lost', 3_500 - from, 3_900 - from),
        word('words', 4_000 - from, 4_400 - from),
        word('second', 6_200 - from, 6_600 - from),
      ]),
    ];

    await h.rerun.rerunMeeting(MEETING);

    expect(h.reads).toEqual([{ source: 'system', fromMs: 2_000, toMs: 7_000 }]);
    expect(h.vendor.opens.map((open) => open.label)).toEqual(['system']);
    // Every second of the window, sent at real time: 5 s of audio took 5 s.
    expect(h.vendor.streams[0]?.sentMs).toBe(5_000);
    expect(h.clock.now - LATER).toBeGreaterThanOrEqual(4_900);
    expect(h.rerunLines()).toMatchObject([
      {
        source: 'system',
        speaker: 'them',
        startMs: 3_500,
        endMs: 4_400,
        text: 'lost words',
        words: [word('lost', 3_500, 3_900), word('words', 4_000, 4_400)],
        origin: 'rerun',
        suppressedReason: null,
      },
    ]);
    expect(h.gapOf(gap)).toMatchObject({
      recoveredAt: new Date(h.clock.now).toISOString(),
      recoverError: null,
    });
    expect(h.recovered).toEqual([MEETING]);
  });

  it('re-runs call audio first, so a re-run mic line that repeats it is hidden', async () => {
    const h = harness();
    // Offline cut both sources; the mic's gap comes first in the store.
    h.gap('mic', 10_000, 14_000);
    h.gap('system', 10_050, 14_000);
    h.keep('mic', 0, 20_000);
    h.keep('system', 0, 20_000);
    const spoken = (from: number): TranscriptWord[] => [
      word('we', 11_000 - from, 11_200 - from),
      word('ship', 11_200 - from, 11_400 - from),
      word('on', 11_400 - from, 11_600 - from),
      word('Friday', 11_600 - from, 11_800 - from),
    ];
    // Laptop speakers: the mic heard Them 50 ms later.
    h.vendor.finals.system = [said(spoken(10_050 - RERUN_PAD_MS))];
    h.vendor.finals.mic = [said(spoken(10_000 - RERUN_PAD_MS - 50))];

    await h.rerun.rerunMeeting(MEETING);

    expect(h.vendor.opens.map((open) => open.label)).toEqual(['system', 'mic']);
    const lines = h.rerunLines();
    const them = lines.find((segment) => segment.source === 'system');
    const me = lines.find((segment) => segment.source === 'mic');
    expect(them?.suppressedReason).toBeNull();
    expect(me).toMatchObject({ suppressedReason: 'echo', echoOf: them?.id });
    expect(h.changes.map((change) => [change.segmentId, change.change])).toEqual([
      [me?.id, 'hidden'],
    ]);
    expect(h.store.listUnrecoveredGaps(MEETING)).toEqual([]);
  });

  it('marks a gap the backup holds no audio for with the reason, and opens nothing', async () => {
    const h = harness();
    const gap = h.gap('mic', 1_000, 5_000);
    h.keep('mic', 20_000, 10_000);

    await h.rerun.rerunMeeting(MEETING);

    expect(h.gapOf(gap)?.recoveredAt).toBeNull();
    expect(h.gapOf(gap)?.recoverError).toContain('audio backup holds none');
    expect(h.vendor.opens).toEqual([]);
    expect(h.budget.check(4, 'minute').ok).toBe(true);
    expect(h.recovered).toEqual([]);
  });

  it('turns a crash tail into a gap at launch, and re-runs it', async () => {
    const h = harness({ stopReason: 'crash', started: false });
    h.line('system', [word('until', 0, 12_000)]);
    h.keep('system', 0, 20_000);
    h.vendor.finals.system = [said([word('cut', 2_000, 2_400), word('off', 2_400, 2_800)])];

    h.rerun.start();
    await h.rerun.idle();

    expect(h.store.listGaps(MEETING)).toMatchObject([
      { source: 'system', startMs: 12_000, endMs: 20_000, reason: 'crash' },
    ]);
    expect(h.store.listUnrecoveredGaps(MEETING)).toEqual([]);
    expect(h.rerunLines().map((segment) => [segment.text, segment.startMs])).toEqual([
      ['cut off', 13_000],
    ]);
  });

  it('takes a minute slot before each session and waits when refused, whatever the meeting spent', async () => {
    // The last meeting spent its opens (2 of 2), both in this minute.
    const h = harness({ perMinute: 4, perMeeting: 2 });
    h.budget.beginMeeting();
    expect(h.budget.acquire(2).ok).toBe(true);
    expect(h.budget.check(1).ok).toBe(false);
    h.gap('system', 3_000, 4_000);
    h.keep('system', 0, 10_000);

    await h.rerun.rerunMeeting(MEETING);

    // A re-run leaves room for a Start's two opens: with two of four taken, it waited the minute
    // out, saying so, then opened in the minute window only.
    expect(h.vendor.opens).toHaveLength(1);
    expect(h.vendor.opens[0]?.atMs).toBe(LATER + 60_000);
    expect(h.capture.seen.map((status) => status?.state ?? null)).toEqual([
      'running',
      'waiting',
      'running',
      'running',
      null,
    ]);
    expect(h.budget.openedThisMeeting).toBe(2);
    expect(h.store.listUnrecoveredGaps(MEETING)).toEqual([]);
  });

  it('counts each session in the minute window, so a long list waits its turn', async () => {
    const h = harness({ perMinute: 4 });
    for (const startMs of [1_000, 3_000, 5_000]) h.gap('system', startMs, startMs + 500);
    h.keep('system', 0, 10_000);

    await h.rerun.rerunMeeting(MEETING);

    // Two a minute (four, less a Start's two): the third session waited for the first to age out.
    const opened = h.vendor.opens.map((open) => open.atMs - LATER);
    expect(opened).toHaveLength(3);
    expect(opened[2]).toBeGreaterThanOrEqual(60_000);
    expect(h.capture.seen.at(-2)).toMatchObject({ gaps: 3, finished: 3 });
  });

  it('never starts while a recording runs, and gives way to a Start mid-session', async () => {
    const h = harness({ started: false });
    const gap = h.gap('system', 3_000, 6_000);
    h.keep('system', 0, 10_000);
    h.capture.setPhase('recording');

    await expect(h.rerun.rerunMeeting(MEETING)).rejects.toThrow('recording');
    h.rerun.start();
    await h.rerun.idle();
    expect(h.vendor.opens).toEqual([]);

    // The recording stops: the queued meeting re-runs. Two seconds in, the next Start begins.
    h.vendor.onSend = (stream) => {
      if (stream.sentMs === 2_000) h.capture.setPhase('starting');
    };
    h.capture.setPhase('idle');
    await h.rerun.idle();
    expect(h.vendor.streams[0]?.terminated).toBe(true);
    expect(h.vendor.streams[0]?.sentMs).toBe(2_000);
    expect(h.gapOf(gap)).toMatchObject({ recoveredAt: null, recoverError: null });

    // Back to idle: it goes again, from the gap's start.
    h.vendor.onSend = () => undefined;
    h.capture.setPhase('idle');
    await h.rerun.idle();
    expect(h.vendor.streams[1]?.sentMs).toBe(5_000);
    expect(h.gapOf(gap)?.recoveredAt).not.toBeNull();
  });

  it("adds its usage to the meeting's stt_usage row, keeping what the recording saved", async () => {
    const h = harness();
    const saved: MeetingSttUsage = {
      meetingId: MEETING,
      provider: 'scripted',
      total: {
        sessionsOpened: 2,
        connectedMs: 60_000,
        audioSentMs: 59_000,
        droppedChunks: 3,
        estimatedCostUsd: 0.006,
      },
      bySource: {
        mic: {
          sessionsOpened: 1,
          connectedMs: 30_000,
          audioSentMs: 29_500,
          droppedChunks: 1,
          estimatedCostUsd: 0.003,
        },
        system: {
          sessionsOpened: 1,
          connectedMs: 30_000,
          audioSentMs: 29_500,
          droppedChunks: 2,
          estimatedCostUsd: 0.003,
        },
      },
      stopReason: 'user',
      updatedAt: ENDED_AT,
    };
    h.store.saveSttUsage(saved);
    h.gap('system', 3_000, 6_000);
    h.keep('system', 0, 10_000);

    await h.rerun.rerunMeeting(MEETING);

    // 5 s open at $0.36 an hour: $0.0005.
    expect(h.store.getSttUsage(MEETING)).toMatchObject({
      provider: 'scripted',
      total: {
        sessionsOpened: 3,
        connectedMs: 65_000,
        audioSentMs: 64_000,
        estimatedCostUsd: 0.0065,
      },
      bySource: {
        mic: saved.bySource.mic,
        system: {
          sessionsOpened: 2,
          connectedMs: 35_000,
          audioSentMs: 34_500,
          estimatedCostUsd: 0.0035,
        },
      },
      stopReason: 'user',
      updatedAt: new Date(h.clock.now).toISOString(),
    });
  });

  it('opens once more without the jargon list when the vendor refuses it, through the budget', async () => {
    const h = harness();
    h.gap('system', 3_000, 4_000);
    h.keep('system', 0, 10_000);
    h.vendor.openErrors = [
      new SttConnectError('keyterms refused', 400, { keytermsRejected: true }),
    ];

    await h.rerun.rerunMeeting(MEETING);

    expect(h.vendor.opens.map((open) => open.keyterms)).toEqual([['Roger'], []]);
    // Both opens took a slot: two of the minute's four are gone.
    expect(h.budget.check(3, 'minute').ok).toBe(false);
    expect(h.store.listUnrecoveredGaps(MEETING)).toEqual([]);
  });

  it('keeps the lines a failing session sent and records why the gap was not filled', async () => {
    const h = harness();
    const gap = h.gap('system', 3_000, 6_000);
    h.keep('system', 0, 10_000);
    h.vendor.finals.system = [said([word('partly', 3_000, 3_400)])];
    h.vendor.fatalAtClose.system = 'socket dropped';

    await h.rerun.rerunMeeting(MEETING);

    expect(h.rerunLines().map((segment) => segment.text)).toEqual(['partly']);
    expect(h.gapOf(gap)?.recoveredAt).toBeNull();
    expect(h.gapOf(gap)?.recoverError).toContain('socket dropped');
  });

  it('re-runs the meeting a Stop ended, once capture is idle again', async () => {
    const h = harness();
    h.gap('system', 3_000, 4_000);
    h.keep('system', 0, 10_000);

    h.capture.setPhase('stopping');
    h.capture.ended(MEETING);
    await h.rerun.idle();
    expect(h.vendor.opens).toEqual([]);

    h.capture.setPhase('idle');
    await h.rerun.idle();
    expect(h.vendor.opens.map((open) => open.label)).toEqual(['system']);
    expect(h.store.listUnrecoveredGaps(MEETING)).toEqual([]);
  });

  it('refuses a meeting that has not ended, and re-runs nothing of it', async () => {
    const h = harness();
    const open = '8b9c0d1e-2f3a-4b4c-9d5e-6f7a8b9c0d1e';
    h.store.createMeeting({ id: open, title: 'Open', startedAt: STARTED_AT });
    await expect(h.rerun.rerunMeeting(open)).rejects.toThrow('has not ended');
    expect(h.vendor.opens).toEqual([]);
  });

  it('stops a session at quit and takes no more', async () => {
    const h = harness();
    h.gap('system', 3_000, 9_000);
    h.keep('system', 0, 10_000);
    // On an object: TypeScript does not see a callback set it (CLAUDE.md, no-unnecessary-condition).
    const quit: { done: Promise<void> | null } = { done: null };
    h.vendor.onSend = (stream) => {
      if (stream.sentMs === 1_000) quit.done = h.rerun.stop();
    };
    await h.rerun.rerunMeeting(MEETING);
    await quit.done;
    expect(h.vendor.streams[0]?.terminated).toBe(true);
    await expect(h.rerun.rerunMeeting(MEETING)).rejects.toThrow('quitting');
  });
});
