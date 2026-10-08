import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { CapturePhase, SttStreamState } from '../../shared/capture';
import { CaptureSession } from '../capture/CaptureSession';
import type { StatusContributor, StopOptions } from '../capture/CaptureService';
import { SttOpenBudget } from '../capture/SttOpenBudget';
import { DEFAULT_COST_GUARDS } from '../costGuards';
import { createLogger, type Logger } from '../logger';
import { InMemoryTranscriptStore } from '../store/InMemoryTranscriptStore';
import {
  type SpeechToText,
  SttEventEmitter,
  type SttEventListener,
  type SttStream,
} from '../stt/SpeechToText';
import type { SttUsage } from '../stt/usage';
import {
  type PowerCapture,
  PowerCoordinator,
  type RecordingFollower,
  type SleepFollower,
} from './PowerCoordinator';

const T0 = Date.parse('2026-10-07T10:00:00.000Z');
const MINUTE = 60_000;
const NO_SPEECH_STOP_MS = DEFAULT_COST_GUARDS.noSpeechStopMs;

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A logger whose lines the test reads back, without their time. */
function recordingLogger(): { logger: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  return {
    lines,
    logger: createLogger({
      level: 'info',
      format: 'json',
      sink: (line) => {
        const entry = JSON.parse(line) as Record<string, unknown>;
        delete entry.time;
        lines.push(entry);
      },
    }),
  };
}

function fakeSession(): SleepFollower & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    suspendStreams: (reason) => {
      calls.push(`suspend:${reason}`);
    },
    resumeStreams: (reason) => {
      calls.push(`resume:${reason}`);
    },
  };
}

/**
 * CaptureService as the coordinator reaches it: its recording listeners, phase, stop, status
 * contributor and refresh. `begin` and `end` play a recording's `started` and `ended`.
 */
function fakeCapture() {
  const listeners: RecordingFollower[] = [];
  let contributor: StatusContributor | null = null;
  const capture = {
    phase: 'idle' as CapturePhase,
    stops: [] as StopOptions[],
    refreshes: 0,
    /** What stop() does besides recording the call: the default only moves the phase. */
    onStop: (): Promise<void> => Promise.resolve(),
    onRecording(listener: RecordingFollower): () => void {
      listeners.push(listener);
      return () => undefined;
    },
    stop(options: StopOptions): Promise<void> {
      capture.stops.push(options);
      capture.phase = 'stopping';
      return capture.onStop();
    },
    addStatusContributor(_name: string, read: StatusContributor): () => void {
      contributor = read;
      return () => undefined;
    },
    refreshStatus(): void {
      capture.refreshes += 1;
    },
    begin(session: SleepFollower): void {
      capture.phase = 'recording';
      for (const listener of listeners) listener.started?.({ meetingId: 'm1', session });
    },
    end(): void {
      capture.phase = 'idle';
      for (const listener of listeners) listener.ended?.({ meetingId: 'm1' });
    },
    /** The `paused` the coordinator adds to the next status. */
    paused(): unknown {
      const meetingId = capture.phase === 'idle' ? null : 'm1';
      return contributor?.({ phase: capture.phase, meetingId }).paused;
    },
  };
  return capture satisfies PowerCapture;
}

/** Electron's powerSaveBlocker: which ids it holds now, and every type it was asked for. */
function fakeBlocker() {
  let next = 1;
  const blocker = {
    held: new Set<number>(),
    types: [] as string[],
    start(type: 'prevent-app-suspension'): number {
      blocker.types.push(type);
      const id = next;
      next += 1;
      blocker.held.add(id);
      return id;
    },
    stop(id: number): void {
      blocker.held.delete(id);
    },
  };
  return blocker;
}

function harness() {
  const clock = { ms: T0 };
  const capture = fakeCapture();
  const powerMonitor = new EventEmitter();
  const blocker = fakeBlocker();
  const restarts: string[] = [];
  const log = recordingLogger();
  new PowerCoordinator({
    capture,
    systemAudio: { restart: (reason) => restarts.push(reason) },
    powerMonitor,
    powerSaveBlocker: blocker,
    noSpeechStopMs: NO_SPEECH_STOP_MS,
    logger: log.logger,
    clock: () => clock.ms,
  }).attach();
  /** The lid closes, and opens `sleptForMs` later on the wall clock. */
  const sleep = (sleptForMs: number): void => {
    powerMonitor.emit('suspend');
    clock.ms += sleptForMs;
    powerMonitor.emit('resume');
  };
  return { clock, capture, powerMonitor, blocker, restarts, log, sleep };
}

describe('PowerCoordinator', () => {
  it('holds the power save blocker only while recording', () => {
    const h = harness();
    expect(h.blocker.types).toEqual([]);

    h.capture.begin(fakeSession());
    expect([...h.blocker.held]).toEqual([1]);
    expect(h.blocker.types).toEqual(['prevent-app-suspension']);
    h.capture.end();
    expect(h.blocker.held.size).toBe(0);

    h.capture.begin(fakeSession());
    expect([...h.blocker.held]).toEqual([2]);
    h.capture.end();
    expect(h.blocker.held.size).toBe(0);
  });

  it('finishes and closes both streams at suspend, and the recording goes on', () => {
    const h = harness();
    const session = fakeSession();
    h.capture.begin(session);
    const refreshes = h.capture.refreshes;

    h.powerMonitor.emit('suspend');

    expect(session.calls).toEqual(['suspend:asleep']);
    expect(h.capture.stops).toEqual([]);
    expect(h.capture.paused()).toBe('asleep');
    expect(h.capture.refreshes).toBeGreaterThan(refreshes);
    expect(h.blocker.held.size).toBe(1); // still recording
    expect(h.log.lines).toContainEqual({
      level: 'info',
      message: 'the Mac is going to sleep: speech-to-text suspended',
      meetingId: 'm1',
    });
  });

  it('wakes from a sleep shorter than noSpeechStopMs: lifts asleep and restarts the call audio helper', () => {
    const h = harness();
    const session = fakeSession();
    h.capture.begin(session);

    h.sleep(NO_SPEECH_STOP_MS - 1);

    expect(session.calls).toEqual(['suspend:asleep', 'resume:asleep']);
    expect(h.restarts).toEqual(['the Mac woke from sleep']);
    expect(h.capture.stops).toEqual([]);
    expect(h.capture.paused()).toBeNull();
    expect(h.log.lines).toContainEqual({
      level: 'info',
      message: 'the Mac woke: speech-to-text reopens with the next audio',
      meetingId: 'm1',
      sleptForMs: NO_SPEECH_STOP_MS - 1,
    });
  });

  it('stops at wake with system-sleep after a sleep of noSpeechStopMs or more, and reopens nothing', () => {
    const h = harness();
    const session = fakeSession();
    h.capture.begin(session);

    h.sleep(NO_SPEECH_STOP_MS);

    expect(h.capture.stops).toEqual([{ reason: 'system-sleep' }]);
    expect(session.calls).toEqual(['suspend:asleep']);
    expect(h.restarts).toEqual([]);
    expect(h.log.lines).toContainEqual({
      level: 'warn',
      message: 'the Mac slept too long for one meeting: stopping the recording',
      meetingId: 'm1',
      sleptForMs: NO_SPEECH_STOP_MS,
      noSpeechStopMs: NO_SPEECH_STOP_MS,
    });
  });

  it('does nothing for a sleep while nothing records', () => {
    const h = harness();
    h.sleep(5 * MINUTE);
    expect(h.capture.paused()).toBeUndefined();
    expect(h.capture.stops).toEqual([]);
    expect(h.restarts).toEqual([]);
    expect(h.blocker.types).toEqual([]);
  });

  it('suspends a recording that finishes starting after the suspend: its sockets must not cross the sleep', () => {
    const h = harness();
    const session = fakeSession();
    h.capture.phase = 'starting';
    h.powerMonitor.emit('suspend');
    expect(h.capture.paused()).toBe('asleep');

    h.capture.begin(session); // its streams opened as the Mac went to sleep
    expect(session.calls).toEqual(['suspend:asleep']);
    h.clock.ms += MINUTE;
    h.powerMonitor.emit('resume');
    expect(session.calls).toEqual(['suspend:asleep', 'resume:asleep']);
  });

  it('forgets a sleep that began while a start failed, so the next recording is not born asleep', () => {
    const h = harness();
    h.capture.phase = 'starting';
    h.powerMonitor.emit('suspend');
    h.capture.phase = 'idle'; // the start failed: no started, no ended
    h.clock.ms += MINUTE;
    h.powerMonitor.emit('resume');

    const session = fakeSession();
    h.capture.begin(session);
    expect(session.calls).toEqual([]);
    expect(h.capture.paused()).toBeNull();
  });

  it('hears each sleep once: a repeated event or a resume with no sleep changes nothing', () => {
    const h = harness();
    const session = fakeSession();
    h.capture.begin(session);
    h.powerMonitor.emit('resume');
    h.powerMonitor.emit('suspend');
    h.powerMonitor.emit('suspend');
    h.clock.ms += MINUTE;
    h.powerMonitor.emit('resume');
    h.powerMonitor.emit('resume');

    expect(session.calls).toEqual(['suspend:asleep', 'resume:asleep']);
    expect(h.restarts).toHaveLength(1);
  });

  it('leaves a recording that ended while asleep alone at wake', () => {
    const h = harness();
    const session = fakeSession();
    h.capture.begin(session);
    h.powerMonitor.emit('suspend');
    h.capture.end();
    expect(h.blocker.held.size).toBe(0);
    expect(h.capture.paused()).toBeUndefined();

    h.clock.ms += NO_SPEECH_STOP_MS;
    h.powerMonitor.emit('resume');
    expect(session.calls).toEqual(['suspend:asleep']);
    expect(h.capture.stops).toEqual([]);
    expect(h.restarts).toEqual([]);
  });

  it("leaves a stop already under way alone at wake: G5's tick may come before Electron's resume", () => {
    const h = harness();
    const session = fakeSession();
    h.capture.begin(session);
    h.powerMonitor.emit('suspend');
    h.clock.ms += 20 * MINUTE;
    h.capture.phase = 'stopping'; // CaptureService's no-speech check ran first, on the wall clock
    h.powerMonitor.emit('resume');

    expect(h.capture.stops).toEqual([]);
    expect(session.calls).toEqual(['suspend:asleep']);
    expect(h.restarts).toEqual([]);
  });

  it('logs a power event it could not apply instead of throwing it into Electron', () => {
    const h = harness();
    h.capture.begin({
      suspendStreams: () => {
        throw new Error('session gone');
      },
      resumeStreams: () => undefined,
    });

    expect(() => h.powerMonitor.emit('suspend')).not.toThrow();
    expect(h.log.lines).toContainEqual({
      level: 'error',
      message: 'power event not applied',
      event: 'suspend',
      meetingId: 'm1',
      error: 'session gone',
    });
  });

  it('logs a stop at wake that fails', async () => {
    const h = harness();
    h.capture.onStop = () => Promise.reject(new Error('database is not open'));
    h.capture.begin(fakeSession());
    h.sleep(NO_SPEECH_STOP_MS);
    await flush();

    expect(h.log.lines).toContainEqual({
      level: 'error',
      message: 'stop after a long sleep failed',
      meetingId: 'm1',
      error: 'database is not open',
    });
  });
});

/** A vendor stream that records how much audio it got and how it ended. */
class RecordedStream implements SttStream {
  private readonly emitter = new SttEventEmitter();
  chunks = 0;
  closed = false;
  terminated = false;
  send(): void {
    this.chunks += 1;
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
  terminate(): Promise<void> {
    this.terminated = true;
    return this.close();
  }
  on(listener: SttEventListener): () => void {
    return this.emitter.on(listener);
  }
}

class OpenAtOnce implements SpeechToText {
  readonly provider = 'scripted';
  readonly vendorName = 'Scripted';
  readonly credentialUse = 'reusable';
  readonly opens: string[] = [];
  readonly streams: RecordedStream[] = [];
  openStream({ label }: { label?: string }): Promise<SttStream> {
    this.opens.push(label ?? '?');
    const stream = new RecordedStream();
    this.streams.push(stream);
    return Promise.resolve(stream);
  }
  usage(): SttUsage {
    return {
      sessionsOpened: 0,
      connectedMs: 0,
      audioSentMs: 0,
      droppedChunks: 0,
      estimatedCostUsd: 0,
    };
  }
}

/** 100 ms of 16 kHz Int16 mono. */
function chunk(): Uint8Array {
  return new Uint8Array(3_200);
}

/** A real CaptureSession behind the fake capture, as CaptureService hands it over at `started`. */
async function liveRecording() {
  const h = harness();
  const store = new InMemoryTranscriptStore();
  store.createMeeting({ id: 'm1', title: 'Lid call', startedAt: new Date(T0).toISOString() });
  const stt = new OpenAtOnce();
  const states: Partial<Record<string, SttStreamState>> = {};
  let tokens = 0;
  const budget = new SttOpenBudget({ perMinute: 100, perMeeting: 100 }, () => h.clock.ms);
  budget.beginMeeting();
  const settings = {
    model: 'm',
    language: 'en',
    sampleRate: 16_000,
    encoding: 'linear16',
    pricePerHourUsd: null,
  };
  const session = new CaptureSession({
    meetingId: 'm1',
    meetingStartedAtMs: T0,
    stt,
    accessToken: 't',
    settings,
    refreshCredentials: () => {
      tokens += 1;
      return Promise.resolve({ accessToken: 'fresh', settings });
    },
    reopenBufferMs: 3_000,
    budget,
    reopenBackoffMs: 2_000,
    reopenBackoffMaxMs: 60_000,
    store,
    logger: createLogger({ level: 'error', format: 'json', sink: () => undefined }),
    listeners: {
      onSegment: () => undefined,
      onInterim: () => undefined,
      onStreamState: (source, state) => {
        states[source] = state;
      },
      onStreamFailure: () => undefined,
      onSaveFailure: () => undefined,
      onStreamClosed: () => undefined,
    },
    clock: () => h.clock.ms,
  });
  await session.open();
  h.capture.begin(session);
  // Stop closes the session, as CaptureService's does.
  h.capture.onStop = () => session.close();
  return { ...h, store, stt, states, session, tokens: () => tokens };
}

describe('PowerCoordinator with a live CaptureSession', () => {
  it('closes both streams at suspend and opens nothing while asleep; at wake each reopens with its audio', async () => {
    const r = await liveRecording();
    r.powerMonitor.emit('suspend');
    expect(r.stt.streams.map((stream) => [stream.closed, stream.terminated])).toEqual([
      [true, false],
      [true, false],
    ]);
    expect(r.states).toEqual({ mic: 'paused', system: 'paused' });
    r.session.pushAudio('mic', chunk(), T0 + 1_000); // the last words before the lid shut
    await flush();
    expect(r.tokens()).toBe(0);
    expect(r.stt.opens).toEqual(['mic', 'system']);

    r.clock.ms += 10 * MINUTE;
    r.powerMonitor.emit('resume');
    r.session.pushAudio('mic', chunk(), r.clock.ms);
    r.session.pushAudio('system', chunk(), r.clock.ms);
    await flush();

    expect(r.tokens()).toBe(2);
    expect(r.stt.opens).toEqual(['mic', 'system', 'mic', 'system']);
    // The mic's reopened stream got the chunk held while asleep, then the one that woke it.
    expect(r.stt.streams[2]?.chunks).toBe(2);
    expect(r.states).toEqual({ mic: 'open', system: 'open' });
    expect(r.store.listGaps('m1')).toEqual([]);
    await r.session.close();
  });

  it('leaves an offline suspend in force at wake: nothing reopens until the network is back', async () => {
    const r = await liveRecording();
    r.powerMonitor.emit('suspend');
    r.session.suspendStreams('offline'); // the network poll, seeing no Wi-Fi as the Mac woke
    r.clock.ms += MINUTE;
    r.powerMonitor.emit('resume');
    r.session.pushAudio('mic', chunk(), r.clock.ms);
    await flush();
    expect(r.states).toEqual({ mic: 'offline', system: 'offline' });
    expect(r.tokens()).toBe(0);

    r.session.resumeStreams('offline');
    r.session.pushAudio('mic', chunk(), r.clock.ms + 100);
    await flush();
    expect(r.stt.opens).toEqual(['mic', 'system', 'mic']);
    await r.session.close();
  });

  it('stops after a long sleep with the audio held while asleep as a gap named asleep', async () => {
    const r = await liveRecording();
    r.powerMonitor.emit('suspend');
    // Chunks that came after the suspend, before the Mac slept: held, never sent.
    r.session.pushAudio('mic', chunk(), T0 + 4_000);
    r.session.pushAudio('mic', chunk(), T0 + 4_100);
    r.clock.ms += NO_SPEECH_STOP_MS;
    r.powerMonitor.emit('resume');
    await flush();

    expect(r.capture.stops).toEqual([{ reason: 'system-sleep' }]);
    // Speech-to-text did not fail: the recording stopped while asleep. M2-T16 re-runs it.
    expect(
      r.store
        .listGaps('m1')
        .map(({ source, startMs, endMs, reason }) => [source, startMs, endMs, reason]),
    ).toEqual([['mic', 4_000, 4_200, 'asleep']]);
    expect(r.stt.opens).toEqual(['mic', 'system']);
  });
});
