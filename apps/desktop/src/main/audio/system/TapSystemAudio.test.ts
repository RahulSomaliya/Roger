import { fileURLToPath } from 'node:url';
import { describe, expect, it, type TestContext, vi } from 'vitest';
import type {
  AudioSourceState,
  CaptureNotice,
  CaptureWarning,
  CapturePhase,
} from '../../../shared/capture';
import type { AudioSource } from '../../../shared/transcript';
import { createLogger } from '../../logger';
import type { SigningIdentity } from '../../signing';
import { InMemoryTranscriptStore } from '../../store/InMemoryTranscriptStore';
import { SYSTEM_AUDIO_VERIFIED_KEY, SystemAudioVerification } from './systemAudioVerification';
import { TapSystemAudio, type TapSystemAudioOptions } from './TapSystemAudio';

const FAKE_HELPER = fileURLToPath(
  new URL('../../../../test/fixtures/fake-roger-audio.mjs', import.meta.url),
);
const MEETING = '6f1d2b7e-8a4c-4f0e-9b1a-2c3d4e5f6a7b';
const IDENTITY: SigningIdentity = {
  kind: 'local-identity',
  requirement: 'identifier "ai.linkt.roger" and certificate leaf = H"b457"',
  requirementHash: 'c'.repeat(64),
};

interface Pushed {
  source: AudioSource;
  pcm: Uint8Array;
  capturedAtMs: number | null;
}

/** CaptureService as TapSystemAudio reaches it: the chunks, the source states and the refreshes. */
function fakeCapture() {
  const pushed: Pushed[] = [];
  const states: { source: AudioSource; state: AudioSourceState; message: string | null }[] = [];
  const refresh = vi.fn();
  return {
    pushed,
    states,
    refresh,
    port: {
      pushAudio: (source: AudioSource, pcm: Uint8Array, capturedAtMs: number | null = null) => {
        pushed.push({ source, pcm, capturedAtMs });
      },
      reportSourceState: (source: AudioSource, state: AudioSourceState, message: string | null) => {
        states.push({ source, state, message });
      },
      refreshStatus: refresh,
    },
  };
}

interface Harness {
  tap: TapSystemAudio;
  capture: ReturnType<typeof fakeCapture>;
  store: InMemoryTranscriptStore;
  verification: SystemAudioVerification;
  logs: Record<string, unknown>[];
  status: (phase?: CapturePhase) => ReturnType<TapSystemAudio['status']>;
  /** The kinds of the capture events written for the meeting, in order. */
  events: () => string[];
  messages: () => unknown[];
}

/**
 * A tap on the fake helper, with `directives` (ROGER_FAKE_AUDIO). It is stopped when the test
 * finishes; the tests run concurrently, so through the test's own hook.
 */
function harness(
  context: TestContext,
  directives: string,
  overrides: Partial<TapSystemAudioOptions> = {},
): Harness {
  const store = new InMemoryTranscriptStore();
  store.createMeeting({ id: MEETING, title: 'T', startedAt: '2026-10-07T09:00:00.000Z' });
  const logs: Record<string, unknown>[] = [];
  const logger = createLogger({
    level: 'debug',
    format: 'json',
    sink: (line) => logs.push(JSON.parse(line) as Record<string, unknown>),
  });
  const capture = fakeCapture();
  const verification = new SystemAudioVerification({
    store,
    identity: Promise.resolve(IDENTITY),
    logger,
  });
  const tap = new TapSystemAudio({
    selection: { mode: 'tap', helper: { origin: 'e2e-fake', path: FAKE_HELPER } },
    capture: capture.port,
    store,
    verification,
    logger,
    env: { ...process.env, ROGER_FAKE_AUDIO: directives },
    timings: { restartDelayMs: 20 },
    ...overrides,
  });
  context.onTestFinished(async () => {
    await tap.stop();
  });
  return {
    tap,
    capture,
    store,
    verification,
    logs,
    status: (phase = 'recording') => tap.status({ phase, meetingId: MEETING }),
    events: () => store.listCaptureEvents(MEETING).map((event) => event.kind),
    messages: () => logs.map((line) => line.message),
  };
}

/** The fake helper dates its frames by the real clock, so the meeting starts by it too. */
const RECORDING = { meetingId: MEETING, meetingStartedAtMs: Date.now() };

function onlyWarning(status: ReturnType<TapSystemAudio['status']>): CaptureWarning | undefined {
  expect(status.warnings?.length ?? 0).toBeLessThanOrEqual(1);
  return status.warnings?.[0];
}

function onlyNotice(status: ReturnType<TapSystemAudio['status']>): CaptureNotice | undefined {
  expect(status.notices?.length ?? 0).toBeLessThanOrEqual(1);
  return status.notices?.[0];
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

describe.concurrent('TapSystemAudio', () => {
  it('feeds each frame to capture as call audio, dated by the helper', async (context) => {
    const { tap, capture, status } = harness(context, '');
    expect(tap.mode).toBe('tap');
    tap.start(RECORDING);
    await vi.waitFor(() => {
      expect(capture.pushed.length).toBeGreaterThanOrEqual(3);
    });
    const [first, second] = capture.pushed;
    expect(first).toMatchObject({ source: 'system' });
    expect(first!.pcm.byteLength).toBe(3200);
    expect(Math.abs(first!.capturedAtMs! - Date.now())).toBeLessThan(5_000);
    expect(second!.capturedAtMs! - first!.capturedAtMs!).toBe(100);
    expect(status('recording').systemCapture).toBe('tap');
    expect(status('starting').systemCapture).toBe('tap');
    expect(status('idle').systemCapture).toBeNull();
    expect(capture.states).toEqual([]);
    expect(status().warnings).toBeUndefined();
  });

  it('stores system audio as verified on the first audio above digital silence', async (context) => {
    const { tap, store, verification, status } = harness(context, '');
    await verification.ready;
    expect(status().systemAudioVerified).toBe(false);
    tap.start(RECORDING);
    await vi.waitFor(() => {
      expect(status().systemAudioVerified).toBe(true);
    });
    expect(store.getAppState(SYSTEM_AUDIO_VERIFIED_KEY)?.value).toBe(IDENTITY.requirementHash);
  });

  it('never verifies on digital silence', async (context) => {
    const { tap, capture, store, status } = harness(context, 'silence');
    tap.start(RECORDING);
    await vi.waitFor(() => {
      expect(capture.pushed.length).toBeGreaterThanOrEqual(3);
    });
    expect(status().systemAudioVerified).toBe(false);
    expect(store.getAppState(SYSTEM_AUDIO_VERIFIED_KEY)).toBeNull();
  });

  // Every vendor stream is told 16 kHz linear16: audio at another rate is transcribed as garbage,
  // with no error (stt/streamSettings.ts).
  it('refuses a helper that sends anything but 16 kHz linear16 mono', async (context) => {
    const { tap, capture, status, events, messages } = harness(context, 'format=8000');
    tap.start(RECORDING);
    await vi.waitFor(() => {
      expect(capture.states.length).toBe(1);
    });
    const [state] = capture.states;
    expect(state).toMatchObject({ source: 'system', state: 'error' });
    expect(state!.message).toContain('8000 Hz');
    expect(onlyWarning(status())).toMatchObject({
      kind: 'source-ended',
      source: 'system',
      loud: true,
    });
    expect(events()).toEqual(['helper-format-refused']);
    await sleep(300);
    expect(capture.pushed).toEqual([]);
    // Refused for good: the same helper would announce the same format again.
    expect(messages().filter((message) => message === 'audio helper started')).toHaveLength(1);
  });

  it('reports call audio failed, loudly, once the helper is out of restarts', async (context) => {
    const { tap, capture, status, events } = harness(context, 'crash-after=1');
    tap.start(RECORDING);
    await vi.waitFor(
      () => {
        expect(capture.states.length).toBe(1);
      },
      { timeout: 5_000 },
    );
    const [state] = capture.states;
    expect(state).toMatchObject({ source: 'system', state: 'error' });
    expect(state!.message).toBe(
      'the call audio helper stopped 6 times in a row (last: exit 1, tap_failed)',
    );
    const warning = onlyWarning(status());
    expect(warning).toMatchObject({ kind: 'source-ended', source: 'system', loud: true });
    expect(warning!.message).toContain('Press Stop, then Start again');
    expect(events()).toEqual([...Array<string>(5).fill('helper-restarted'), 'helper-failed']);
    // Each run sent audio before it crashed; capture got it all.
    expect(capture.pushed.length).toBeGreaterThanOrEqual(6);
  });

  // `pkill -STOP roger-audio` in the exit check: Roger warns, kills and restarts it.
  it('warns while a hung helper is killed and restarted, until its audio is back', async (context) => {
    const { tap, capture, status, store } = harness(context, 'hang-after=3', {
      timings: { hangKillMs: 400, restartDelayMs: 20 },
    });
    const seen: (CaptureWarning | undefined)[] = [];
    capture.refresh.mockImplementation(() => {
      seen.push(onlyWarning(status()));
    });
    tap.start(RECORDING);
    await vi.waitFor(() => {
      expect(seen.some((warning) => warning?.kind === 'helper-hung')).toBe(true);
    });
    expect(seen.find((warning) => warning !== undefined)).toMatchObject({
      kind: 'helper-hung',
      source: 'system',
      loud: true,
    });
    // The restarted helper sends audio again, then hangs again (hang-after holds for every run):
    // both are read in one look, before the second hang.
    await vi.waitFor(() => {
      const now = status();
      expect(onlyNotice(now)).toMatchObject({ kind: 'helper-restarted', source: 'system' });
      expect(onlyWarning(now)).toBeUndefined();
    });
    const [event] = store.listCaptureEvents(MEETING);
    expect(event).toMatchObject({
      kind: 'helper-restarted',
      source: 'system',
      detail: { cause: 'hung', restarts: 1, detail: 'no output for 400 ms' },
    });
    expect(event!.offsetMs).toBeGreaterThan(0);
  });

  it('warns while a crashed helper restarts', async (context) => {
    const { tap, capture, status } = harness(context, 'crash-after=3', {
      timings: { restartDelayMs: 300 },
    });
    tap.start(RECORDING);
    await vi.waitFor(() => {
      expect(onlyWarning(status())).toMatchObject({
        kind: 'source-ended',
        source: 'system',
        loud: true,
      });
    });
    expect(capture.states).toEqual([]);
  });

  it('notes a tap rebuilt for a new output device', async (context) => {
    const { tap, status, events } = harness(context, 'route-after=2');
    tap.start(RECORDING);
    await vi.waitFor(() => {
      expect(events()).toEqual(['tap-rebuilt']);
    });
    expect(onlyNotice(status())).toMatchObject({
      kind: 'helper-restarted',
      source: 'system',
      message: 'Call audio followed the new output device.',
    });
  });

  // A tap built while the macOS dialog was up stays silent after the grant (M2 design).
  it('rebuilds the tap when Roger regains focus while system audio is unverified', async (context) => {
    const { tap, capture, messages } = harness(context, 'silence');
    tap.start(RECORDING);
    await vi.waitFor(() => {
      expect(capture.pushed.length).toBeGreaterThan(0);
    });
    tap.windowFocused();
    await vi.waitFor(() => {
      expect(messages()).toContain('call audio tap rebuilt');
    });
  });

  it('leaves a verified tap alone when Roger regains focus', async (context) => {
    const { tap, verification, messages } = harness(context, '');
    tap.start(RECORDING);
    await vi.waitFor(() => {
      expect(verification.verified).toBe(true);
    });
    tap.windowFocused();
    await sleep(300);
    expect(messages()).not.toContain('call audio tap rebuilt');
  });

  it('rebuilds on request, and ignores a focus with no recording', async (context) => {
    const { tap, capture, messages } = harness(context, '');
    tap.windowFocused();
    tap.rebuild('the person allowed System Audio Recording');
    expect(messages()).not.toContain('rebuilding the call audio tap');
    tap.start(RECORDING);
    await vi.waitFor(() => {
      expect(capture.pushed.length).toBeGreaterThan(0);
    });
    tap.rebuild('the person allowed System Audio Recording');
    await vi.waitFor(() => {
      expect(messages()).toContain('call audio tap rebuilt');
    });
  });

  it('stop ends the helper; nothing is pushed after it and the status forgets it', async (context) => {
    const { tap, capture, status, messages } = harness(context, '');
    tap.start(RECORDING);
    await vi.waitFor(() => {
      expect(capture.pushed.length).toBeGreaterThan(0);
    });
    await tap.stop();
    expect(messages()).toContain('audio helper stopped');
    const pushed = capture.pushed.length;
    await sleep(300);
    expect(capture.pushed).toHaveLength(pushed);
    expect(status('idle')).toEqual({ systemCapture: null, systemAudioVerified: true });
  });

  it('restart starts the helper afresh, not as a failure', async (context) => {
    const { tap, capture, status, events, messages } = harness(context, '', {
      timings: { stdinGraceMs: 100 },
    });
    tap.start(RECORDING);
    await vi.waitFor(() => {
      expect(capture.pushed.length).toBeGreaterThan(0);
    });
    tap.restart('the Mac woke up');
    await vi.waitFor(() => {
      expect(messages().filter((message) => message === 'audio helper started')).toHaveLength(2);
    });
    expect(events()).toEqual([]);
    expect(status().warnings).toBeUndefined();
  });

  it('reports call audio failed at Start when config.json forces a tap with no helper', async (context) => {
    const { tap, capture, status, events, messages } = harness(context, '', {
      selection: { mode: 'tap', helper: null, missing: 'no audio helper at /x/roger-audio' },
    });
    tap.start(RECORDING);
    expect(capture.states).toEqual([
      {
        source: 'system',
        state: 'error',
        message: 'there is no call audio helper: no audio helper at /x/roger-audio',
      },
    ]);
    expect(onlyWarning(status())).toMatchObject({ kind: 'source-ended', loud: true });
    expect(events()).toEqual(['helper-missing']);
    await expect(tap.stop()).resolves.toBeUndefined();
    expect(messages()).not.toContain('audio helper started');
  });

  it('drops frames dated more than a day from now, and says so once', async (context) => {
    const { tap, capture, messages } = harness(context, 'clock-offset-ms=90000000');
    tap.start(RECORDING);
    await vi.waitFor(() => {
      expect(messages()).toContain('call audio frames dated far from now dropped');
    });
    await sleep(300);
    expect(capture.pushed).toEqual([]);
    expect(
      messages().filter((message) => message === 'call audio frames dated far from now dropped'),
    ).toHaveLength(1);
  });

  it('pushes no frame before the helper says which format it sends', async (context) => {
    const { tap, capture } = harness(context, 'no-ready');
    tap.start(RECORDING);
    await sleep(500);
    expect(capture.pushed).toEqual([]);
  });

  it('logs the error a helper reports before it exits', async (context) => {
    const { tap, logs } = harness(context, 'crash-after=2', { timings: { maxRestarts: 0 } });
    tap.start(RECORDING);
    await vi.waitFor(() => {
      expect(logs.map((line) => line.message)).toContain('call audio helper error');
    });
    expect(logs.find((line) => line.message === 'call audio helper error')).toMatchObject({
      level: 'error',
      code: 'tap_failed',
    });
  });
});
