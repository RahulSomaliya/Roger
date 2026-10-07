import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CaptureStatus, idleCaptureStatus } from '../../shared/capture';
import { PCM_SAMPLE_RATE } from '../../shared/ipc';
import type { AudioSource, TranscriptSegment } from '../../shared/transcript';
import { ApiClient, type MeetingDto, type UploadApi } from '../api/ApiClient';
import type {
  StartOptions,
  StatusContribution,
  StatusContributor,
} from '../capture/CaptureService';
import { createCaptureRuntime } from '../capture/createCaptureRuntime';
import { loadConfig } from '../config';
import type { DetectedCallApp } from '../detect/callApps';
import { createLogger } from '../logger';
import { InMemoryTranscriptStore } from '../store/InMemoryTranscriptStore';
import type { SttUsage } from '../stt/usage';
import { FakeSpeechToText } from '../stt/fake/FakeSpeechToText';
import { TranscriptUploader } from '../upload/TranscriptUploader';
import {
  CALL_APP_WAIT_MS,
  type CallAppWatch,
  CrashRecovery,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_KEY,
  RESUME_WITHIN_MS,
  type RecoveryCapture,
} from './CrashRecovery';

// Only the last describe builds the capture runtime; the shared mock is the one every such test uses.
vi.mock('electron', async () =>
  (await import('../testing/electronRuntimeMock')).electronRuntimeMock(),
);

const quiet = createLogger({ level: 'error', format: 'json', sink: () => undefined });
const MINUTE = 60_000;
const MEETING = '6f1d2b7e-8a4c-4f0e-9b1a-2c3d4e5f6a7b';
const OTHER = '0e9d8c7b-6a5f-4e3d-8c1b-0a9f8e7d6c5b';
/** The launch instant of the unit tests (fake timers). */
const NOW = Date.parse('2026-10-07T10:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const ZOOM: DetectedCallApp = { bundleId: 'us.zoom.xos', name: 'Zoom', kind: 'native' };

type Listener = Parameters<RecoveryCapture['onRecording']>[0];

/** CaptureService as far as CrashRecovery uses it; a resume records unless `refuse` is set. */
class FakeCapture implements RecoveryCapture {
  readonly starts: StartOptions[] = [];
  /** Answer resumes with this error and stay idle, as a refused Start does. */
  refuse: string | null = null;
  private meetingId: string | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly contributors = new Map<string, StatusContributor>();

  start(options: StartOptions): Promise<CaptureStatus> {
    this.starts.push(options);
    const idle = idleCaptureStatus({
      state: 'idle',
      pending: 0,
      rejected: 0,
      lastError: null,
      nextAttemptAt: null,
    });
    const resume = options.resume;
    if (this.refuse !== null || resume === undefined) {
      return Promise.resolve({ ...idle, error: this.refuse });
    }
    this.begin(resume.meetingId, true);
    return Promise.resolve({ ...idle, phase: 'recording', meetingId: resume.meetingId });
  }

  onRecording(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  addStatusContributor(name: string, read: StatusContributor): () => void {
    this.contributors.set(name, read);
    return () => this.contributors.delete(name);
  }

  refreshStatus(): void {
    // Nothing to send: tests read contributed() instead.
  }

  begin(meetingId: string, resumed: boolean): void {
    this.meetingId = meetingId;
    for (const listener of this.listeners) listener.started?.({ meetingId, resumed });
  }

  end(): void {
    this.meetingId = null;
    for (const listener of this.listeners) listener.ended?.();
  }

  /** What every contributor adds to a status built now. */
  contributed(): StatusContribution[] {
    const meetingId = this.meetingId;
    return [...this.contributors.values()].map((read) =>
      read({ phase: meetingId === null ? 'idle' : 'recording', meetingId }),
    );
  }
}

/** The call app monitor as CrashRecovery reads it; `report` is a `mic_users` that changed. */
class FakeCallApps implements CallAppWatch {
  callApps: readonly DetectedCallApp[] = [];
  running = true;
  private readonly listeners = new Set<(apps: readonly DetectedCallApp[]) => void>();

  onCallApps(listener: (apps: readonly DetectedCallApp[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  report(apps: readonly DetectedCallApp[]): void {
    this.callApps = apps;
    for (const listener of this.listeners) listener(apps);
  }
}

interface LeftOpen {
  id?: string;
  startedAtMs?: number;
  /** When the last recording's heartbeat was written for this meeting; null for none. */
  heartbeatAtMs?: number | null;
  stopReason?: 'quit';
}

/** A meeting a previous run left open, as a kill -9 leaves it (the heartbeat names it). */
function leftOpen(store: InMemoryTranscriptStore, options: LeftOpen = {}): string {
  const id = options.id ?? MEETING;
  const startedAtMs = options.startedAtMs ?? NOW - 5 * MINUTE;
  store.createMeeting({ id, title: 'Weekly sync', startedAt: iso(startedAtMs) });
  const heartbeatAtMs = options.heartbeatAtMs === undefined ? NOW - 20_000 : options.heartbeatAtMs;
  if (heartbeatAtMs !== null) store.setAppState(HEARTBEAT_KEY, id, iso(heartbeatAtMs));
  if (options.stopReason !== undefined) store.setMeetingStopReason(id, options.stopReason);
  return id;
}

/** Closed backup files (meeting offsets), as the launch's WAV repair leaves them. */
function audio(store: InMemoryTranscriptStore, source: AudioSource, files: [number, number][]) {
  for (const [startMs, endMs] of files) {
    const id = randomUUID();
    store.addAudioFile({
      id,
      meetingId: MEETING,
      source,
      startMs,
      path: `audio/${MEETING}/${source}-${startMs}.wav`,
      format: 'wav',
      createdAt: iso(NOW - 5 * MINUTE),
    });
    store.closeAudioFile(id, { endMs, bytes: 1_000, closedAt: iso(NOW - MINUTE) });
  }
}

function line(store: InMemoryTranscriptStore, source: AudioSource, startMs: number, endMs: number) {
  store.appendSegment({
    id: randomUUID(),
    meetingId: MEETING,
    source,
    speaker: source === 'mic' ? 'me' : 'them',
    startMs,
    endMs,
    text: 'said before the crash',
    confidence: null,
    words: null,
    createdAt: iso(NOW - MINUTE),
  });
}

/** A crash four and a half minutes in: lines stop short of the end of each source's audio. */
function crashedCall(store: InMemoryTranscriptStore): void {
  leftOpen(store);
  audio(store, 'mic', [[0, 290_000]]);
  audio(store, 'system', [
    [0, 240_000],
    [240_000, 295_000],
  ]);
  line(store, 'mic', 2_000, 280_000);
  line(store, 'system', 1_000, 250_000);
}

function gapsOf(store: InMemoryTranscriptStore) {
  return store
    .listGaps(MEETING)
    .map(({ source, startMs, endMs, reason }) => ({ source, startMs, endMs, reason }));
}

function recovery(
  store: InMemoryTranscriptStore,
  options: { relaunched?: boolean; callApps?: CallAppWatch | null; logLines?: string[] } = {},
): CrashRecovery {
  const callApps = options.callApps ?? null;
  const lines = options.logLines;
  return new CrashRecovery({
    store,
    relaunched: options.relaunched ?? false,
    callApps: callApps === null ? null : () => callApps,
    logger:
      lines === undefined
        ? quiet
        : createLogger({ level: 'debug', format: 'json', sink: (l) => lines.push(l) }),
  });
}

describe('CrashRecovery at launch', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resumes the meeting the heartbeat names in the same id when this launch is the relaunch', async () => {
    const store = new InMemoryTranscriptStore();
    crashedCall(store);
    // The heartbeat names one meeting (crashedCall's): this one was left open by something older.
    leftOpen(store, { id: OTHER, startedAtMs: NOW - 3 * MINUTE, heartbeatAtMs: null });
    const crash = recovery(store, { relaunched: true });

    crash.endMeetingsLeftOpen();
    // Before the runtime: only the one to resume stays open, so the crash tails skip it alone.
    expect(store.getMeeting(OTHER)?.endedAt).not.toBeNull();
    expect(store.getMeetingStopReason(OTHER)).toBe('crash');
    expect(store.getMeeting(MEETING)?.endedAt).toBeNull();

    const capture = new FakeCapture();
    await crash.start(capture);

    expect(capture.starts).toEqual([{ resume: { meetingId: MEETING } }]);
    expect(store.getMeeting(MEETING)?.endedAt).toBeNull();
    expect(store.getMeetingStopReason(MEETING)).toBeNull();
    // Each source's audio after its last line: what the crash cut off before the vendor answered.
    expect(gapsOf(store)).toEqual([
      { source: 'system', startMs: 250_000, endMs: 295_000, reason: 'crash' },
      { source: 'mic', startMs: 280_000, endMs: 290_000, reason: 'crash' },
    ]);
    expect(store.listCaptureEvents(MEETING)).toEqual([
      {
        id: 1,
        meetingId: MEETING,
        at: iso(NOW),
        offsetMs: 5 * MINUTE,
        source: null,
        kind: 'resumed_after_crash',
        detail: { downMs: 20_000, trigger: 'relaunch', callApp: null, gaps: 2 },
      },
    ]);
    expect(capture.contributed()).toEqual([
      {
        notices: [
          {
            kind: 'resumed-after-crash',
            source: null,
            at: iso(NOW),
            message: 'Roger restarted and kept taking notes',
          },
        ],
      },
    ]);
    // The resumed recording keeps the heartbeat going, so a second crash can resume it too.
    expect(store.getAppState(HEARTBEAT_KEY)).toEqual({ value: MEETING, updatedAt: iso(NOW) });
  });

  it("resumes when a call app holds the mic, on the monitor's first report", async () => {
    const store = new InMemoryTranscriptStore();
    crashedCall(store);
    const callApps = new FakeCallApps();
    const crash = recovery(store, { callApps });
    crash.endMeetingsLeftOpen();
    // Kept open until the monitor can say: nobody relaunched this launch.
    expect(store.getMeeting(MEETING)?.endedAt).toBeNull();

    const capture = new FakeCapture();
    const done = crash.start(capture);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(capture.starts).toEqual([]);
    callApps.report([ZOOM]);
    await done;

    expect(capture.starts).toEqual([{ resume: { meetingId: MEETING } }]);
    expect(store.listCaptureEvents(MEETING).map((event) => event.detail)).toEqual([
      { downMs: 21_000, trigger: 'call-app', callApp: 'Zoom', gaps: 2 },
    ]);
  });

  it('resumes at once when a call app already holds the mic', async () => {
    const store = new InMemoryTranscriptStore();
    leftOpen(store);
    const callApps = new FakeCallApps();
    callApps.report([ZOOM]);
    const crash = recovery(store, { callApps });
    crash.endMeetingsLeftOpen();

    const capture = new FakeCapture();
    await crash.start(capture);

    expect(capture.starts).toEqual([{ resume: { meetingId: MEETING } }]);
    // No backup audio: nothing to mark as cut off, the event still says how long Roger was gone.
    expect(gapsOf(store)).toEqual([]);
    expect(store.listCaptureEvents(MEETING).map((event) => event.detail)).toEqual([
      { downMs: 20_000, trigger: 'call-app', callApp: 'Zoom', gaps: 0 },
    ]);
  });

  it('ends it as in M1 when no call app holds the mic and nobody relaunched', async () => {
    const store = new InMemoryTranscriptStore();
    crashedCall(store);
    const callApps = new FakeCallApps();
    const crash = recovery(store, { callApps });
    crash.endMeetingsLeftOpen();

    const capture = new FakeCapture();
    const done = crash.start(capture);
    await vi.advanceTimersByTimeAsync(CALL_APP_WAIT_MS);
    await done;

    expect(capture.starts).toEqual([]);
    // Ended where Roger was last seen recording it, as a crash: the re-run fills its tails.
    expect(store.getMeeting(MEETING)?.endedAt).toBe(iso(NOW - 20_000));
    expect(store.getMeetingStopReason(MEETING)).toBe('crash');
    expect(gapsOf(store)).toHaveLength(2);
    expect(store.listCaptureEvents(MEETING)).toEqual([]);
    expect(capture.contributed()).toEqual([{}]);
  });

  it('does not wait for a call app monitor that is down', async () => {
    const store = new InMemoryTranscriptStore();
    leftOpen(store);
    const callApps = new FakeCallApps();
    callApps.running = false;
    const crash = recovery(store, { callApps });
    crash.endMeetingsLeftOpen();

    await crash.start(new FakeCapture());

    expect(store.getMeetingStopReason(MEETING)).toBe('crash');
  });

  it('ends it before the runtime when this build cannot ask about call apps and nobody relaunched', async () => {
    const store = new InMemoryTranscriptStore();
    crashedCall(store);
    const crash = recovery(store, { callApps: null });

    crash.endMeetingsLeftOpen();
    // Ended now, as M1 did: the runtime's crash tails record its gaps and re-run them at launch.
    expect(store.getMeetingStopReason(MEETING)).toBe('crash');
    expect(store.getMeeting(MEETING)?.endedAt).not.toBeNull();

    const capture = new FakeCapture();
    await crash.start(capture);
    expect(capture.starts).toEqual([]);
    expect(gapsOf(store)).toEqual([]);
  });

  it('ends one left over 10 minutes ago, one the heartbeat does not name, and one a stop began', () => {
    const old = new InMemoryTranscriptStore();
    leftOpen(old, { heartbeatAtMs: NOW - RESUME_WITHIN_MS - 1 });
    recovery(old, { relaunched: true }).endMeetingsLeftOpen();
    expect(old.getMeetingStopReason(MEETING)).toBe('crash');

    const unnamed = new InMemoryTranscriptStore();
    leftOpen(unnamed, { heartbeatAtMs: null });
    recovery(unnamed, { relaunched: true }).endMeetingsLeftOpen();
    expect(unnamed.getMeetingStopReason(MEETING)).toBe('crash');

    // A quit whose stop outran quitStopTimeoutMs: it ends as in M1 and keeps its reason.
    const quit = new InMemoryTranscriptStore();
    leftOpen(quit, { stopReason: 'quit' });
    recovery(quit, { relaunched: true }).endMeetingsLeftOpen();
    expect(quit.getMeeting(MEETING)?.endedAt).not.toBeNull();
    expect(quit.getMeetingStopReason(MEETING)).toBe('quit');
  });

  it('resumes one the heartbeat names just inside the 10 minutes', () => {
    const store = new InMemoryTranscriptStore();
    leftOpen(store, { heartbeatAtMs: NOW - RESUME_WITHIN_MS });
    recovery(store, { relaunched: true }).endMeetingsLeftOpen();
    expect(store.getMeeting(MEETING)?.endedAt).toBeNull();
  });

  it('ends the meeting when the resume is refused, and says why in the log', async () => {
    const store = new InMemoryTranscriptStore();
    crashedCall(store);
    const logLines: string[] = [];
    const crash = recovery(store, { relaunched: true, logLines });
    crash.endMeetingsLeftOpen();
    const capture = new FakeCapture();
    capture.refuse = 'Microphone access is denied.';

    await crash.start(capture);

    expect(capture.starts).toHaveLength(1);
    expect(store.getMeetingStopReason(MEETING)).toBe('crash');
    expect(store.getMeeting(MEETING)?.endedAt).toBe(iso(NOW - 20_000));
    // Its tails stay recorded, so the crash tails at the next launch do not record them again.
    expect(gapsOf(store)).toHaveLength(2);
    expect(store.listCaptureEvents(MEETING)).toEqual([]);
    expect(capture.contributed()).toEqual([{}]);
    const errors = logLines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((entry) => entry.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ meetingId: MEETING, error: 'Microphone access is denied.' });
  });

  it('starts the tail after a gap an earlier resume recorded, so no audio is re-run twice', async () => {
    const store = new InMemoryTranscriptStore();
    crashedCall(store);
    store.addGap({
      id: randomUUID(),
      meetingId: MEETING,
      source: 'mic',
      startMs: 280_000,
      endMs: 288_000,
      reason: 'crash',
      createdAt: iso(NOW - MINUTE),
    });
    const crash = recovery(store, { relaunched: true });
    crash.endMeetingsLeftOpen();

    await crash.start(new FakeCapture());

    expect(gapsOf(store)).toEqual([
      { source: 'system', startMs: 250_000, endMs: 295_000, reason: 'crash' },
      { source: 'mic', startMs: 280_000, endMs: 288_000, reason: 'crash' },
      { source: 'mic', startMs: 288_000, endMs: 290_000, reason: 'crash' },
    ]);
  });
});

describe('the recording heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is written at Start and every 5 s while recording, and deleted at Stop', async () => {
    const store = new InMemoryTranscriptStore();
    const capture = new FakeCapture();
    await recovery(store).start(capture);
    expect(store.getAppState(HEARTBEAT_KEY)).toBeNull();

    capture.begin(MEETING, false);
    expect(store.getAppState(HEARTBEAT_KEY)).toEqual({ value: MEETING, updatedAt: iso(NOW) });
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS - 1);
    expect(store.getAppState(HEARTBEAT_KEY)?.updatedAt).toBe(iso(NOW));
    await vi.advanceTimersByTimeAsync(1);
    expect(store.getAppState(HEARTBEAT_KEY)?.updatedAt).toBe(iso(NOW + HEARTBEAT_INTERVAL_MS));

    capture.end();
    expect(store.getAppState(HEARTBEAT_KEY)).toBeNull();
    await vi.advanceTimersByTimeAsync(3 * HEARTBEAT_INTERVAL_MS);
    expect(store.getAppState(HEARTBEAT_KEY)).toBeNull();
    // A recording nobody resumed shows no resumed notice.
    capture.begin(MEETING, false);
    expect(capture.contributed()).toEqual([{}]);
    capture.end();
  });

  it('logs a heartbeat it cannot write once per spell, and the recording goes on', async () => {
    const store = new InMemoryTranscriptStore();
    const logLines: string[] = [];
    const capture = new FakeCapture();
    await recovery(store, { logLines }).start(capture);
    const write = vi.spyOn(store, 'setAppState').mockImplementation(() => {
      throw new Error('database or disk is full');
    });

    capture.begin(MEETING, false);
    await vi.advanceTimersByTimeAsync(3 * HEARTBEAT_INTERVAL_MS);

    expect(write).toHaveBeenCalledTimes(4);
    const errors = logLines.filter((l) => l.includes('"level":"error"'));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('database or disk is full');

    // Back: written again at the next beat.
    write.mockRestore();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    expect(store.getAppState(HEARTBEAT_KEY)?.value).toBe(MEETING);
    capture.end();
  });
});

/** 100 ms of loud, steady audio: the fake STT writes one line per 2 s of it. */
const VOICE = new Uint8Array(new Int16Array(PCM_SAMPLE_RATE / 10).fill(8_000).buffer);
const SAID = 'so the plan is to ship on Friday';

function meetingDto(id: string): MeetingDto {
  return {
    id,
    workspace_id: 'w1',
    title: 'Weekly sync',
    status: 'recording',
    started_at: '2026-10-07T09:00:00.000Z',
    ended_at: null,
    segment_count: 0,
    start_source: 'manual',
    calendar_event: null,
    created_at: '2026-10-07T09:00:00.000Z',
    updated_at: '2026-10-07T09:00:00.000Z',
  };
}

describe('a crash resume through the capture runtime, in index.ts order', () => {
  it("carries the saved stt_usage on and settles the crash's holds before the first upload", async () => {
    // A kill -9 two minutes into a call on the laptop speakers: the mic line that repeated Them
    // was still held for the echo filter, and the usage row holds the sessions billed so far.
    const store = new InMemoryTranscriptStore();
    const startedAtMs = Date.now() - 2 * MINUTE;
    const earlier = iso(startedAtMs + MINUTE);
    store.createMeeting({ id: MEETING, title: 'Weekly sync', startedAt: iso(startedAtMs) });
    const said = (id: string, source: AudioSource): TranscriptSegment => ({
      id,
      meetingId: MEETING,
      source,
      speaker: source === 'mic' ? 'me' : 'them',
      startMs: source === 'mic' ? 10_100 : 10_000,
      endMs: (source === 'mic' ? 10_100 : 10_000) + 2_000,
      text: SAID,
      confidence: null,
      words: null,
      createdAt: earlier,
    });
    store.appendSegment(said('them-1', 'system'));
    store.appendSegment(said('me-1', 'mic'));
    store.holdSegment('me-1', iso(Date.now() + MINUTE));
    const saved = (n: number): SttUsage => ({
      sessionsOpened: 3 * n,
      connectedMs: 100_000 * n,
      audioSentMs: 90_000 * n,
      droppedChunks: 0,
      estimatedCostUsd: 0,
    });
    store.saveSttUsage({
      meetingId: MEETING,
      provider: 'fake',
      total: saved(2),
      bySource: { mic: saved(1), system: saved(1) },
      stopReason: null,
      updatedAt: earlier,
    });
    store.setAppState(HEARTBEAT_KEY, MEETING, iso(Date.now() - 3_000));

    // [slot M2-T23]: before the uploader and the runtime.
    const crash = recovery(store, { relaunched: true });
    crash.endMeetingsLeftOpen();

    // [slot M2-T4 runtime]: the uploader first (its launchedAt is before every line of this run).
    const appendSegments = vi.fn<UploadApi['appendSegments']>((_meetingId, segments) =>
      Promise.resolve({ accepted: segments.length, duplicates: 0 }),
    );
    const uploader = new TranscriptUploader({
      store,
      api: {
        createMeeting: (input) => Promise.resolve(meetingDto(input.id)),
        appendSegments,
        endMeeting: (meetingId) => Promise.resolve(meetingDto(meetingId)),
      },
      logger: quiet,
    });
    const connection = { baseUrl: 'http://127.0.0.1:9', token: 'test' };
    const runtime = createCaptureRuntime({
      config: {
        ...loadConfig({}, { capture: { audioBackup: false, echoFilter: true } }),
        sttProviderOverride: 'fake',
      },
      store,
      api: new ApiClient(connection),
      apiConnection: connection,
      uploader,
      createSpeechToText: () => new FakeSpeechToText(),
      ensureMicrophoneAccess: () => Promise.resolve('granted'),
      startupError: null,
      userData: '/nonexistent/roger-test',
      ipcMain: { handle: () => undefined, on: () => undefined },
      getWindow: () => null,
      logger: quiet,
    });
    const { capture } = runtime;

    // The deferred start once main() has run to its end.
    await crash.start(capture);
    expect(capture.getStatus()).toMatchObject({ phase: 'recording', meetingId: MEETING });
    expect(capture.getStatus().notices).toMatchObject([{ kind: 'resumed-after-crash' }]);
    expect(store.meetings.size).toBe(1);

    // The resumed mic says something with no call audio yet: held for its twin, live.
    const from = Date.now();
    for (let chunk = 0; chunk < 20; chunk += 1) capture.pushAudio('mic', VOICE, from + chunk * 100);
    const live = store
      .listSegmentsOverlapping(MEETING, 'mic', 0, Number.MAX_SAFE_INTEGER)
      .filter((segment) => segment.id !== 'me-1');
    expect(live).toHaveLength(1);
    expect(live[0]?.uploadAfter).not.toBeNull();

    await uploader.flush();

    // The crash's hold was settled first (an echo: hidden); the resume's live hold was left alone.
    expect(store.getSegment('me-1')?.suppressedReason).toBe('echo');
    expect(appendSegments.mock.calls.flatMap(([, lines]) => lines.map((l) => l.id))).toEqual([
      'them-1',
    ]);
    expect(store.getSegment(live[0]?.id ?? '')?.uploadAfter).not.toBeNull();

    await capture.stop({ flushUploads: false });
    // The cost record carried on: Start's two new sessions on top of the six saved.
    expect(store.getSttUsage(MEETING)?.total.sessionsOpened).toBe(8);
    expect(store.getAppState(HEARTBEAT_KEY)).toBeNull();
    uploader.stop();
    for (const hook of runtime.quitHooks) await hook.run();
  });
});

describe('the M2-T23 slot in main/index.ts', () => {
  // The deferred start reads `capture`, declared below the slot by `[slot M2-T4 runtime]`. It runs
  // once main() has run to its end, which holds only while nothing in between awaits; an await
  // there would let it read `capture` before its line ran (a ReferenceError in main).
  it('awaits nothing between CrashRecovery and the capture runtime it starts later', () => {
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    const from = source.indexOf('[slot M2-T23]');
    const to = source.indexOf('createCaptureRuntime({');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const code = source
      .slice(from, to)
      .split('\n')
      .filter((text) => !/^\s*(\/\/|\*)/.test(text));
    expect(code.filter((text) => /\bawait\b/.test(text))).toEqual([]);
    expect(code.join('\n')).toContain('new CrashRecovery(');
  });
});
