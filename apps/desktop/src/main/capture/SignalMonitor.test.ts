import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BLUETOOTH_MIC_DEAD_WARNING_MS,
  type CaptureStatus,
  idleCaptureStatus,
  type SourceStatus,
} from '../../shared/capture';
import { PCM_SAMPLE_RATE } from '../../shared/ipc';
import type { AudioSource } from '../../shared/transcript';
import { ApiClient } from '../api/ApiClient';
import { createLogger } from '../logger';
import { InMemoryTranscriptStore } from '../store/InMemoryTranscriptStore';
import { FakeSpeechToText } from '../stt/fake/FakeSpeechToText';
import type { SpeechToText } from '../stt/SpeechToText';
import { TranscriptUploader } from '../upload/TranscriptUploader';
import { CaptureService } from './CaptureService';
import { pcmPeak, SignalMonitor } from './SignalMonitor';

const logger = createLogger({ level: 'error', format: 'json', sink: () => undefined });

const MEETING = '3c1f6a2e-5b7d-4e8f-9a0b-1c2d3e4f5a6b';
const START = Date.parse('2026-10-07T10:00:00.000Z');
const CHUNK_MS = 100;
/** About -20 dBFS: a voice at a normal distance. */
const VOICE = 3_277;

/** 100 ms of Int16 little-endian mono whose samples swing between +peak and -peak. */
function chunk(peak: number): Uint8Array {
  const samples = new Int16Array((PCM_SAMPLE_RATE * CHUNK_MS) / 1000);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = index % 2 === 0 ? peak : -peak;
  }
  return new Uint8Array(samples.buffer);
}

function recordingStatus(
  overrides: Partial<CaptureStatus> = {},
  sources: Partial<Record<AudioSource, Partial<SourceStatus>>> = {},
): CaptureStatus {
  const idle = idleCaptureStatus({
    state: 'idle',
    pending: 0,
    rejected: 0,
    lastError: null,
    nextAttemptAt: null,
  });
  return {
    ...idle,
    phase: 'recording',
    meetingId: MEETING,
    startedAt: new Date(START).toISOString(),
    sources: {
      mic: { ...idle.sources.mic, health: 'active', ...sources.mic },
      system: { ...idle.sources.system, health: 'active', ...sources.system },
    },
    ...overrides,
  };
}

function harness(options: { flatLevelRule?: boolean } = {}) {
  vi.useFakeTimers();
  let now = START;
  const store = new InMemoryTranscriptStore();
  store.createMeeting({
    id: MEETING,
    title: 'Weekly sync',
    startedAt: new Date(START).toISOString(),
  });
  const onChange = vi.fn();
  const monitor = new SignalMonitor({ store, logger, clock: () => now, onChange, ...options });
  monitor.recordingStarted({ meetingId: MEETING, meetingStartedAtMs: START });

  /** One step of wall time, as the Mac lives it: the clock and the timers move together. */
  const step = (ms: number): void => {
    now += ms;
    vi.advanceTimersByTime(ms);
  };
  return {
    monitor,
    store,
    onChange,
    get now() {
      return now;
    },
    /**
     * `ms` of audio in 100 ms chunks, each source at its peak; a source left out sends nothing.
     * Every chunk arrives on time, so audio time and wall time move together.
     */
    feed(peaks: Partial<Record<AudioSource, number>>, ms: number): void {
      for (let fed = 0; fed < ms; fed += CHUNK_MS) {
        // The chunk that ends at a check's instant is in before the check, as it would be if
        // it came a hair earlier: a source's 8th second of silence is counted at the 8 s check.
        now += CHUNK_MS;
        for (const [source, peak] of Object.entries(peaks) as [AudioSource, number][]) {
          monitor.onChunk(source, chunk(peak));
        }
        vi.advanceTimersByTime(CHUNK_MS);
      }
    },
    /** Wall time with no audio at all. */
    wait(ms: number): void {
      for (let waited = 0; waited < ms; waited += CHUNK_MS) step(CHUNK_MS);
    },
    /** The Mac sleeps: the wall clock jumps and timers stand still (CLAUDE.md, M5-T7). */
    sleep(ms: number): void {
      now += ms;
    },
    warnings() {
      return (monitor.contribution().warnings ?? []).map(({ kind, source, loud }) => ({
        kind,
        source,
        loud,
      }));
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('pcmPeak', () => {
  it('reads Int16 little-endian samples, full scale negative included, at any byte offset', () => {
    const bytes = new Uint8Array(7);
    const view = new DataView(bytes.buffer);
    view.setInt16(1, 12, true);
    view.setInt16(3, -32_768, true);
    view.setInt16(5, 300, true);
    expect(pcmPeak(bytes.subarray(1))).toBe(32_768);
    expect(pcmPeak(bytes.subarray(5))).toBe(300);
    expect(pcmPeak(new Uint8Array(0))).toBe(0);
  });
});

describe('SignalMonitor: what it measures', () => {
  it('reads a source as unknown, then signal, quiet in a pause and dead past its window', () => {
    const h = harness();
    expect(h.monitor.contribution().sources?.mic).toEqual({ signal: 'unknown', levelDb: null });

    h.feed({ mic: VOICE, system: VOICE }, 1_000);
    expect(h.monitor.contribution().sources?.mic).toEqual({ signal: 'signal', levelDb: -20 });

    h.feed({ mic: 0, system: VOICE }, 2_000);
    // Digital silence has no finite level: null, and `signal` says why.
    expect(h.monitor.contribution().sources?.mic).toEqual({ signal: 'quiet', levelDb: null });

    h.feed({ mic: 0, system: VOICE }, 6_000);
    expect(h.monitor.contribution().sources?.mic).toEqual({ signal: 'dead', levelDb: null });
    expect(h.monitor.contribution().sources?.system).toEqual({ signal: 'signal', levelDb: -20 });
  });

  it('reads the level of the last second only, and none once chunks stop', () => {
    const h = harness();
    h.feed({ mic: 32_767 }, 500);
    h.feed({ mic: VOICE }, 1_000);
    expect(h.monitor.contribution().sources?.mic?.levelDb).toBe(-20);
    h.feed({ mic: 32_767 }, 100);
    // Full scale rounds to 0, never -0 (a status compares equal to the one the window had).
    expect(Object.is(h.monitor.contribution().sources?.mic?.levelDb, 0)).toBe(true);
    h.wait(1_100);
    expect(h.monitor.contribution().sources?.mic?.levelDb).toBeNull();
  });

  it('counts a peak of 1 LSB as digital silence, and 2 as sound', () => {
    const h = harness();
    h.feed({ mic: 1 }, 1_000);
    expect(h.monitor.contribution().sources?.mic?.signal).toBe('quiet');
    h.feed({ mic: 2 }, 100);
    expect(h.monitor.contribution().sources?.mic?.signal).toBe('signal');
  });
});

describe('SignalMonitor: warnings', () => {
  it('warns of a source with no chunk for 5 s, and clears it when chunks return', () => {
    const h = harness();
    h.feed({ mic: VOICE, system: VOICE }, 1_000);
    h.feed({ system: VOICE }, 4_900);
    expect(h.warnings()).toEqual([]);
    h.feed({ system: VOICE }, 100);
    expect(h.warnings()).toEqual([{ kind: 'no-audio', source: 'mic', loud: true }]);
    // Dated from the last chunk, not from when the check noticed.
    expect(h.monitor.contribution().warnings?.[0]?.since).toBe(
      new Date(START + 1_000).toISOString(),
    );

    h.feed({ mic: VOICE, system: VOICE }, 1_000);
    expect(h.warnings()).toEqual([]);
  });

  it('warns of a source that never sent a chunk, 5 s after Start', () => {
    const h = harness();
    h.feed({ mic: VOICE }, 4_900);
    expect(h.warnings()).toEqual([]);
    h.feed({ mic: VOICE }, 100);
    expect(h.warnings()).toEqual([{ kind: 'no-audio', source: 'system', loud: true }]);
  });

  it('calls the mic dead after 8 s of digital silence, and lets it go when sound returns', () => {
    const h = harness();
    h.feed({ mic: 0, system: VOICE }, 7_900);
    expect(h.warnings()).toEqual([]);
    h.feed({ mic: 0, system: VOICE }, 100);
    expect(h.warnings()).toEqual([{ kind: 'mic-dead', source: 'mic', loud: true }]);
    h.feed({ mic: VOICE, system: VOICE }, 1_000);
    expect(h.warnings()).toEqual([]);
  });

  it('waits 30 s before calling a Bluetooth mic dead (D4)', () => {
    const h = harness();
    h.monitor.setMicBluetooth(true);
    h.feed({ mic: 0, system: VOICE }, BLUETOOTH_MIC_DEAD_WARNING_MS - CHUNK_MS);
    expect(h.warnings()).toEqual([]);
    expect(h.monitor.contribution().sources?.mic?.signal).toBe('quiet');
    h.feed({ mic: 0, system: VOICE }, CHUNK_MS);
    expect(h.warnings()).toEqual([{ kind: 'mic-dead', source: 'mic', loud: true }]);
  });

  it('calls a mic dead on a level 40 dB under its running floor only when the flat-level rule is on', () => {
    // Input volume 0 may give a faint level rather than digital zero on some Macs: about -70 dBFS
    // after a voice at -20 is 50 dB under the floor.
    const faint = 10;
    const on = harness({ flatLevelRule: true });
    on.feed({ mic: VOICE, system: VOICE }, 10_000);
    on.feed({ mic: faint, system: VOICE }, 7_900);
    expect(on.warnings()).toEqual([]);
    expect(on.monitor.contribution().sources?.mic?.signal).toBe('quiet');
    on.feed({ mic: faint, system: VOICE }, 100);
    expect(on.warnings()).toEqual([{ kind: 'mic-dead', source: 'mic', loud: true }]);
    on.feed({ mic: VOICE, system: VOICE }, 1_000);
    expect(on.warnings()).toEqual([]);

    vi.useRealTimers();
    const off = harness();
    off.feed({ mic: VOICE, system: VOICE }, 10_000);
    off.feed({ mic: faint, system: VOICE }, 20_000);
    expect(off.warnings()).toEqual([]);
    expect(off.monitor.contribution().sources?.mic?.signal).toBe('signal');
  });

  it('follows a slow fall in level with the floor: a quiet room is not a dead mic', () => {
    const h = harness({ flatLevelRule: true });
    h.feed({ mic: VOICE, system: VOICE }, 10_000);
    // Down 10 dB each 10 s, to about -70 dBFS, as a voice that stops leaves the room's hiss.
    for (const peak of [1_036, 328, 104, 33, 10]) h.feed({ mic: peak, system: VOICE }, 10_000);
    expect(h.warnings()).toEqual([]);
  });

  it('warns of call audio never heard for 20 s: loud while unverified, on screen once verified', () => {
    const h = harness();
    h.feed({ mic: VOICE, system: 0 }, 19_900);
    expect(h.warnings()).toEqual([]);
    h.feed({ mic: VOICE, system: 0 }, 100);
    expect(h.warnings()).toEqual([
      { kind: 'call-audio-never-heard', source: 'system', loud: true },
    ]);

    h.monitor.observeStatus(recordingStatus({ systemAudioVerified: true }));
    h.feed({ mic: VOICE, system: 0 }, 1_000);
    expect(h.warnings()).toEqual([
      { kind: 'call-audio-never-heard', source: 'system', loud: false },
    ]);

    h.feed({ mic: VOICE, system: VOICE }, 1_000);
    expect(h.warnings()).toEqual([]);
  });

  it('shows call audio silent mid-call at 8 s, loud at 60 s once the mic spoke during it (D3)', () => {
    const h = harness();
    h.feed({ mic: VOICE, system: VOICE }, 1_000);
    // A line from before the silence says nothing about it.
    h.monitor.lineHeard('mic');
    h.feed({ mic: VOICE, system: 0 }, 8_000);
    expect(h.warnings()).toEqual([{ kind: 'call-audio-silent', source: 'system', loud: false }]);
    h.feed({ mic: VOICE, system: 0 }, 51_000);
    expect(h.warnings()).toEqual([{ kind: 'call-audio-silent', source: 'system', loud: false }]);

    h.monitor.lineHeard('system');
    h.feed({ mic: VOICE, system: 0 }, 1_000);
    expect(h.warnings()).toEqual([{ kind: 'call-audio-silent', source: 'system', loud: false }]);
    h.monitor.lineHeard('mic');
    h.feed({ mic: VOICE, system: 0 }, 1_000);
    expect(h.warnings()).toEqual([{ kind: 'call-audio-silent', source: 'system', loud: true }]);
  });

  it('makes call audio silence loud at 180 s whatever the mic hears (D3)', () => {
    const h = harness();
    h.feed({ mic: VOICE, system: VOICE }, 1_000);
    h.feed({ mic: VOICE, system: 0 }, 179_900);
    expect(h.warnings()).toEqual([{ kind: 'call-audio-silent', source: 'system', loud: false }]);
    h.feed({ mic: VOICE, system: 0 }, 100);
    expect(h.warnings()).toEqual([{ kind: 'call-audio-silent', source: 'system', loud: true }]);
  });

  it('names a source the status says stopped, with its reason, until the status says otherwise', () => {
    const h = harness();
    h.feed({ mic: VOICE, system: VOICE }, 1_000);
    h.monitor.observeStatus(
      recordingStatus({}, { mic: { health: 'ended', message: 'the microphone was unplugged' } }),
    );
    h.wait(1_000);
    expect(h.warnings()).toEqual([{ kind: 'source-ended', source: 'mic', loud: true }]);
    expect(h.monitor.contribution().warnings?.[0]?.message).toContain(
      'the microphone was unplugged',
    );

    h.monitor.observeStatus(recordingStatus());
    h.feed({ mic: VOICE, system: VOICE }, 1_000);
    expect(h.warnings()).toEqual([]);
  });

  it('warns once of transcription offline while a stream is offline (M2-T6)', () => {
    const h = harness();
    h.monitor.observeStatus(recordingStatus({ streams: { mic: 'offline', system: 'offline' } }));
    h.feed({ mic: VOICE, system: VOICE }, 1_000);
    expect(h.warnings()).toEqual([{ kind: 'offline', source: null, loud: true }]);
    h.monitor.observeStatus(recordingStatus({ streams: { mic: 'open', system: 'open' } }));
    h.feed({ mic: VOICE, system: VOICE }, 1_000);
    expect(h.warnings()).toEqual([]);
  });

  it('ignores a status of another meeting, or one that comes when nothing records', () => {
    const h = harness();
    h.monitor.observeStatus(
      recordingStatus({
        meetingId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
        streams: { mic: 'offline', system: 'offline' },
      }),
    );
    h.feed({ mic: VOICE, system: VOICE }, 1_000);
    expect(h.warnings()).toEqual([]);
  });
});

describe('SignalMonitor: sleep, pauses and device switches', () => {
  it('skips the first check after a timer gap over 5 s (the Mac slept), and warns of nothing for the sleep', () => {
    const h = harness();
    h.feed({ mic: VOICE, system: VOICE }, 2_000);
    h.sleep(10 * 60_000);
    h.wait(1_000);
    expect(h.warnings()).toEqual([]);
    // The sleep was no silence: chunks that come back at wake carry on without a warning...
    h.feed({ mic: VOICE, system: VOICE }, 3_000);
    expect(h.warnings()).toEqual([]);
  });

  it('still warns of a source that does not come back after the wake, 5 s after it', () => {
    const h = harness();
    h.feed({ mic: VOICE, system: VOICE }, 2_000);
    h.sleep(10 * 60_000);
    h.wait(1_000);
    h.feed({ system: VOICE }, 4_000);
    expect(h.warnings()).toEqual([]);
    h.feed({ system: VOICE }, 1_000);
    expect(h.warnings()).toEqual([{ kind: 'no-audio', source: 'mic', loud: true }]);
  });

  it('warns of nothing while the recording is paused for sleep (M2-T18)', () => {
    const h = harness();
    h.feed({ mic: VOICE, system: VOICE }, 1_000);
    h.monitor.observeStatus(recordingStatus({ paused: 'asleep' }));
    h.wait(30_000);
    expect(h.warnings()).toEqual([]);
    h.monitor.observeStatus(recordingStatus({ paused: null }));
    h.feed({ mic: VOICE, system: VOICE }, 4_000);
    expect(h.warnings()).toEqual([]);
  });

  it('ends the warnings a recording had when it is paused for sleep: nothing is wrong with it then', () => {
    const h = harness();
    h.feed({ mic: 0, system: VOICE }, 9_000);
    expect(h.warnings()).toEqual([{ kind: 'mic-dead', source: 'mic', loud: true }]);
    h.monitor.observeStatus(recordingStatus({ paused: 'asleep' }));
    h.wait(1_000);
    expect(h.warnings()).toEqual([]);
    expect(h.store.listCaptureEvents(MEETING).map(({ kind }) => kind)).toEqual([
      'warning',
      'warning-cleared',
    ]);
  });

  it('warns of nothing while Stop closes the sessions, however long that takes', () => {
    const h = harness();
    h.feed({ mic: VOICE, system: VOICE }, 1_000);
    // From Stop until its sessions close, CaptureService drops every chunk: no source is cut.
    h.monitor.observeStatus(recordingStatus({ phase: 'stopping' }));
    h.wait(6_000);
    expect(h.warnings()).toEqual([]);
    expect(h.store.listCaptureEvents(MEETING)).toEqual([]);
    expect(h.onChange).not.toHaveBeenCalled();
  });

  it('shows a mic device switch as a notice, never a warning, and times its silence afresh', () => {
    const h = harness();
    h.monitor.observeStatus(recordingStatus({}, { mic: { device: 'MacBook Pro Microphone' } }));
    h.feed({ mic: 0, system: VOICE }, 6_000);
    // The first device is no switch.
    expect(h.monitor.contribution().notices).toEqual([]);

    h.monitor.observeStatus(recordingStatus({}, { mic: { device: 'AirPods Pro' } }));
    expect(h.monitor.contribution().notices).toEqual([
      {
        kind: 'device-switched',
        source: 'mic',
        at: new Date(h.now).toISOString(),
        message: 'Switched to AirPods Pro',
      },
    ]);
    // 6 s before the switch and 7.9 s after: no 8 s of silence on one device.
    h.feed({ mic: 0, system: VOICE }, 7_900);
    expect(h.warnings()).toEqual([]);
    h.feed({ mic: 0, system: VOICE }, 100);
    expect(h.warnings()).toEqual([{ kind: 'mic-dead', source: 'mic', loud: true }]);
    expect(
      h.store
        .listCaptureEvents(MEETING)
        .map(({ kind, source, detail }) => ({ kind, source, detail })),
    ).toContainEqual({ kind: 'device-switched', source: 'mic', detail: { device: 'AirPods Pro' } });
  });

  it('gives the new device of a switch 5 s for its first chunk', () => {
    const h = harness();
    h.monitor.observeStatus(recordingStatus({}, { mic: { device: 'USB Mic' } }));
    h.feed({ mic: VOICE, system: VOICE }, 1_000);
    // The USB mic is pulled: no chunk while the renderer moves to the next default input.
    h.feed({ system: VOICE }, 4_000);
    h.monitor.observeStatus(recordingStatus({}, { mic: { device: 'MacBook Pro Microphone' } }));
    h.feed({ system: VOICE }, 4_000);
    expect(h.warnings()).toEqual([]);
    h.feed({ system: VOICE }, 1_000);
    expect(h.warnings()).toEqual([{ kind: 'no-audio', source: 'mic', loud: true }]);
  });
});

describe('SignalMonitor: what it tells', () => {
  it('records each spell in the capture report: when it began, turned loud, and ended', () => {
    const h = harness();
    h.feed({ mic: VOICE, system: VOICE }, 1_000);
    h.feed({ mic: VOICE, system: 0 }, 8_000);
    h.feed({ mic: VOICE, system: 0 }, 172_000);
    h.feed({ mic: VOICE, system: VOICE }, 1_000);
    expect(
      h.store.listCaptureEvents(MEETING).map(({ kind, source, offsetMs, detail }) => ({
        kind,
        source,
        offsetMs,
        detail,
      })),
    ).toEqual([
      {
        kind: 'warning',
        source: 'system',
        offsetMs: 9_000,
        detail: { warning: 'call-audio-silent', loud: false },
      },
      {
        kind: 'warning',
        source: 'system',
        offsetMs: 181_000,
        detail: { warning: 'call-audio-silent', loud: true },
      },
      {
        kind: 'warning-cleared',
        source: 'system',
        offsetMs: 182_000,
        detail: { warning: 'call-audio-silent', lastedMs: 181_000 },
      },
    ]);
  });

  it('ends every spell still open at Stop in the capture report, once', () => {
    const h = harness();
    h.feed({ mic: 0, system: VOICE }, 9_000);
    h.monitor.recordingEnded();
    expect(
      h.store.listCaptureEvents(MEETING).map(({ kind, source, offsetMs, detail }) => ({
        kind,
        source,
        offsetMs,
        detail,
      })),
    ).toEqual([
      {
        kind: 'warning',
        source: 'mic',
        offsetMs: 8_000,
        detail: { warning: 'mic-dead', loud: true },
      },
      {
        kind: 'warning-cleared',
        source: 'mic',
        offsetMs: 9_000,
        detail: { warning: 'mic-dead', lastedMs: 9_000 },
      },
    ]);

    // A Stop that took a while ended the spell when it began: `ended` adds no second end.
    vi.useRealTimers();
    const slow = harness();
    slow.feed({ mic: 0, system: VOICE }, 9_000);
    slow.monitor.observeStatus(recordingStatus({ phase: 'stopping' }));
    slow.wait(3_000);
    slow.monitor.recordingEnded();
    expect(slow.store.listCaptureEvents(MEETING).map(({ kind }) => kind)).toEqual([
      'warning',
      'warning-cleared',
    ]);
  });

  it('tells the status when its warnings or notices change, not on every check', () => {
    const h = harness();
    h.feed({ mic: VOICE, system: VOICE }, 5_000);
    expect(h.onChange).not.toHaveBeenCalled();
    h.feed({ mic: 0, system: VOICE }, 8_000);
    expect(h.onChange).toHaveBeenCalledTimes(1);
    h.feed({ mic: 0, system: VOICE }, 5_000);
    expect(h.onChange).toHaveBeenCalledTimes(1);
    h.monitor.observeStatus(recordingStatus({}, { mic: { device: 'USB Mic' } }));
    h.monitor.observeStatus(recordingStatus({}, { mic: { device: 'AirPods Pro' } }));
    h.feed({ mic: VOICE, system: VOICE }, 1_000);
    // The warning ended and a notice came: one change, told once.
    expect(h.onChange).toHaveBeenCalledTimes(2);
  });

  it('drops every warning, notice and level when the recording ends, and stops checking', () => {
    const h = harness();
    h.monitor.observeStatus(recordingStatus({}, { mic: { device: 'USB Mic' } }));
    h.monitor.observeStatus(recordingStatus({}, { mic: { device: 'AirPods Pro' } }));
    h.feed({ mic: 0, system: VOICE }, 9_000);
    expect(h.warnings()).not.toEqual([]);
    h.onChange.mockClear();

    h.monitor.recordingEnded();
    expect(h.monitor.contribution()).toEqual({});
    expect(h.onChange).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    // A chunk after Stop changes nothing.
    h.monitor.onChunk('mic', chunk(0));
    expect(h.monitor.contribution()).toEqual({});
  });

  it('starts every recording afresh', () => {
    const h = harness();
    h.feed({ mic: 0, system: VOICE }, 9_000);
    h.monitor.recordingEnded();
    h.monitor.recordingStarted({ meetingId: MEETING, meetingStartedAtMs: h.now });
    expect(h.monitor.contribution()).toEqual({
      warnings: [],
      notices: [],
      sources: {
        mic: { signal: 'unknown', levelDb: null },
        system: { signal: 'unknown', levelDb: null },
      },
    });
    expect(vi.getTimerCount()).toBe(1);
  });
});

/** A CaptureService on the fake provider, with a SignalMonitor attached as the T11 slot does. */
function attachedCapture(
  store: InMemoryTranscriptStore,
  clock: () => number,
  createSpeechToText: () => SpeechToText,
): { capture: CaptureService; monitor: SignalMonitor } {
  const api = new ApiClient({ baseUrl: 'http://127.0.0.1:9', token: 'test' });
  const capture = new CaptureService({
    store,
    api,
    uploader: new TranscriptUploader({ store, api, logger }),
    createSpeechToText,
    ensureMicrophoneAccess: () => Promise.resolve('granted'),
    logger,
    // The fake provider: Start asks the API for no token.
    sttProviderOverride: 'fake',
    startupError: null,
    clock,
  });
  const monitor = new SignalMonitor({
    store,
    logger,
    clock,
    onChange: () => {
      capture.refreshStatus();
    },
  });
  monitor.attach(capture);
  return { capture, monitor };
}

/**
 * `stt` whose streams take `closeMs` to close, as a vendor that never answers the finish does
 * (WebSocketSpeechToText waits closeTimeoutMs, 5 s, for it; a reopen still connecting holds Stop
 * up to 10 s more).
 */
function slowToClose(stt: SpeechToText, closeMs: number): SpeechToText {
  return {
    provider: stt.provider,
    vendorName: stt.vendorName,
    usage: (label) => stt.usage(label),
    async openStream(options) {
      const stream = await stt.openStream(options);
      return {
        send: (pcm) => {
          stream.send(pcm);
        },
        on: (listener) => stream.on(listener),
        async close() {
          await new Promise((resolve) => setTimeout(resolve, closeMs));
          await stream.close();
        },
      };
    },
  };
}

describe('SignalMonitor.attach', () => {
  it('follows recordings through the capture seams: audio, status, lines and Stop', async () => {
    vi.useFakeTimers();
    let now = START;
    const store = new InMemoryTranscriptStore();
    const { capture, monitor } = attachedCapture(
      store,
      () => now,
      () => new FakeSpeechToText({ clock: () => now }),
    );
    const lineHeard = vi.spyOn(monitor, 'lineHeard');

    await capture.start();
    for (let fed = 0; fed < 8_000; fed += CHUNK_MS) {
      now += CHUNK_MS;
      capture.pushAudio('mic', chunk(0));
      capture.pushAudio('system', chunk(VOICE));
      vi.advanceTimersByTime(CHUNK_MS);
    }
    const status = capture.getStatus();
    expect(status.warnings?.map(({ kind }) => kind)).toEqual(['mic-dead']);
    expect(status.sources.mic.signal).toBe('dead');
    expect(status.sources.system).toMatchObject({ signal: 'signal', levelDb: -20 });
    // The fake vendor wrote a line of the loud call audio; the monitor heard of it.
    expect(lineHeard).toHaveBeenCalledWith('system');

    // A source CaptureService was told ended reaches the warnings through the status.
    capture.reportSourceState('system', 'ended', 'the helper exited');
    now += 1_000;
    vi.advanceTimersByTime(1_000);
    expect(
      capture.getStatus().warnings?.map(({ kind, source }) => `${kind}/${String(source)}`),
    ).toEqual(['mic-dead/mic', 'source-ended/system']);

    // No flush: the uploader would try the API, which this test does not run.
    await capture.stop({ flushUploads: false });
    expect(capture.getStatus().warnings).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('warns of no source while a Stop held open for 6 s closes the sessions', async () => {
    vi.useFakeTimers();
    let now = START;
    const store = new InMemoryTranscriptStore();
    const { capture } = attachedCapture(
      store,
      () => now,
      () => slowToClose(new FakeSpeechToText({ clock: () => now }), 6_000),
    );
    await capture.start();
    const meetingId = capture.getStatus().meetingId ?? '';
    for (let fed = 0; fed < 3_000; fed += CHUNK_MS) {
      now += CHUNK_MS;
      capture.pushAudio('mic', chunk(VOICE));
      capture.pushAudio('system', chunk(VOICE));
      vi.advanceTimersByTime(CHUNK_MS);
    }

    // The call ended (M2-T17b's auto-stop): Stop waits on the vendor while the sources go quiet.
    const stopped = capture.stop({ flushUploads: false });
    for (let waited = 0; waited < 6_000; waited += CHUNK_MS) {
      now += CHUNK_MS;
      capture.pushAudio('mic', chunk(VOICE));
      vi.advanceTimersByTime(CHUNK_MS);
      expect(capture.getStatus()).toMatchObject({ phase: 'stopping', warnings: [] });
    }
    expect(store.listCaptureEvents(meetingId).map(({ kind }) => kind)).not.toContain('warning');
    await stopped;
    expect(capture.getStatus().phase).toBe('idle');
  });
});
