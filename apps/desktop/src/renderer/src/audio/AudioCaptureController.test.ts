import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  type CaptureStatus,
  emptySourceStatus,
  idleCaptureStatus,
  type SourceHealth,
} from '../../../shared/capture';
import type {
  AudioChunkMessage,
  AudioSourceStateMessage,
  CaptureApi,
} from '../../../shared/ipc/capture';
import type { AudioSource } from '../../../shared/transcript';
import {
  AudioCaptureController,
  type CaptureDevices,
  type SourceCapture,
} from './AudioCaptureController';
import type { PcmStreamCaptureOptions } from './PcmStreamCapture';
import { describeMediaError } from './sources';
import {
  BUILT_IN,
  type FakeInput,
  FakeMediaDevices,
  FakeStream,
  micStream,
  USB_MIC,
} from './testing/fakeMedia';

/** A capture double: records whether it runs. No AudioContext or getUserMedia in node. */
class FakeCapture implements SourceCapture<FakeStream> {
  running = false;
  stopped = false;
  stream: FakeStream | null = null;
  /** Streams swapped in since start, in order (MicRecovery). */
  replaced: FakeStream[] = [];
  constructor(readonly options: PcmStreamCaptureOptions) {}
  start(stream: FakeStream): Promise<void> {
    this.running = true;
    this.stream = stream;
    return Promise.resolve();
  }
  replaceStream(stream: FakeStream): void {
    this.stream?.track.stop();
    this.stream = stream;
    this.replaced.push(stream);
  }
  stop(): Promise<void> {
    this.running = false;
    this.stopped = true;
    return Promise.resolve();
  }
}

const MEETING = '0b6f6f0e-5a8e-4c41-9a3e-6f1c2f6c1a01';
const NEXT_MEETING = '7d1d3c55-2f0b-4e7e-8a51-0c9e3f2b6d02';

function idle(): CaptureStatus {
  return idleCaptureStatus({
    state: 'idle',
    pending: 0,
    rejected: 0,
    lastError: null,
    nextAttemptAt: null,
  });
}

/** Main's status while it records; `mic` sets the mic source's health as main sees it. */
function recording(
  overrides: Partial<CaptureStatus> = {},
  mic: SourceHealth = 'active',
): CaptureStatus {
  return {
    ...idle(),
    phase: 'recording',
    meetingId: MEETING,
    sources: { mic: { ...emptySourceStatus(), health: mic }, system: emptySourceStatus() },
    ...overrides,
  };
}

function rogerApi() {
  const status = idle();
  const api = {
    startCapture: () => Promise.resolve(status),
    stopCapture: () => Promise.resolve(status),
    getCaptureStatus: () => Promise.resolve(status),
    getSystemAudioSourceId: vi.fn(() => Promise.resolve<string | null>('screen:1')),
    sendAudioChunk: vi.fn<(message: AudioChunkMessage) => void>(),
    reportAudioSourceState: vi.fn<(message: AudioSourceStateMessage) => void>(),
    onCaptureStatus: () => () => undefined,
    onTranscriptSegment: () => () => undefined,
    onTranscriptInterim: () => () => undefined,
    // Capture's own members the controller never calls: they are here because the double is a
    // whole CaptureApi, so each member capture's contract gains needs a line here too.
    onTranscriptSegmentChanged: () => () => undefined,
    getCaptureReport: vi.fn(),
    rerunGaps: vi.fn(),
    deleteMeetingAudio: vi.fn(),
    unhideSegment: vi.fn(),
  };
  return api satisfies CaptureApi;
}

function harness() {
  const captures: FakeCapture[] = [];
  /** What the next getUserMedia for the mic opens, or how it fails, once the test says so. */
  const mic: { input: FakeInput; error: Error | null; ready: () => void; opens: number } = {
    input: USB_MIC,
    error: null,
    ready: () => undefined,
    opens: 0,
  };
  const mediaDevices = new FakeMediaDevices(USB_MIC, BUILT_IN);
  const openSystemAudio = vi.fn(() => Promise.resolve(new FakeStream()));
  const devices: CaptureDevices<FakeStream> = {
    mediaDevices,
    // The mic waits for the test: getUserMedia and the worklet setup take hundreds of ms.
    openMicrophone: () =>
      new Promise((resolve, reject) => {
        mic.opens += 1;
        mic.ready = () => {
          if (mic.error === null) resolve(micStream(mic.input));
          else reject(mic.error);
        };
      }),
    openSystemAudio,
    createCapture: (options) => {
      const capture = new FakeCapture(options);
      captures.push(capture);
      return capture;
    },
  };
  const roger = rogerApi();
  const controller = new AudioCaptureController(roger, devices);
  const live = (source: AudioSource) =>
    captures.filter((capture) => capture.options.source === source && capture.running);
  return {
    controller,
    roger,
    captures,
    mic,
    mediaDevices,
    openSystemAudio,
    live,
    micReady: () => {
      mic.ready();
    },
  };
}

/** Starts both sources the way a Start does, the mic answering at once. */
async function started(h: ReturnType<typeof harness>, status = recording()): Promise<void> {
  const starting = h.controller.start(status);
  await settle();
  h.micReady();
  await starting;
}

/** Lets pending promise callbacks run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe('AudioCaptureController', () => {
  // Checked by tsc (tsconfig.web.json), not at run time. RogerApi is every feature's part at once:
  // typed against it, this controller and its fake below break the type check the moment any other
  // feature adds a member, in files that feature does not own.
  it("needs only capture's part of window.roger", () => {
    expectTypeOf<
      ConstructorParameters<typeof AudioCaptureController>[0]
    >().toEqualTypeOf<CaptureApi>();
  });

  it('stops a source still starting when main goes idle, and starts no other', async () => {
    const h = harness();
    const starting = h.controller.start(recording());
    await settle();
    // Main stopped on its own (the Mac went to sleep) before the mic was up: nothing runs yet.
    expect(h.controller.running).toBe(false);
    h.controller.followMain(idle());

    h.micReady();
    await starting;

    expect(h.live('mic')).toEqual([]);
    expect(h.captures.every((capture) => capture.stopped)).toBe(true);
    expect(h.openSystemAudio).not.toHaveBeenCalled();
    expect(h.controller.running).toBe(false);
  });

  it('stops every running source when main goes idle, and nothing while it records', async () => {
    const h = harness();
    await started(h);
    expect(h.live('mic')).toHaveLength(1);
    expect(h.live('system')).toHaveLength(1);

    h.controller.followMain(recording());
    expect(h.controller.running).toBe(true);
    expect(h.mic.opens).toBe(1);
    h.controller.followMain(idle());
    await settle();

    expect(h.live('mic')).toEqual([]);
    expect(h.live('system')).toEqual([]);
    expect(h.controller.running).toBe(false);
  });

  it('never starts on top of a running capture: a second start keeps it', async () => {
    const h = harness();
    await started(h);
    await h.controller.start(recording());

    // One capture per source: two would send main the same audio twice. Restarting it would cut
    // the mic for nothing.
    expect(h.live('mic')).toHaveLength(1);
    expect(h.live('system')).toHaveLength(1);
    expect(h.captures).toHaveLength(2);
    expect(h.mic.opens).toBe(1);
  });

  it('sends each chunk with the wall clock of its first sample, as the capture dated it', async () => {
    const h = harness();
    await started(h);
    const pcm = new ArrayBuffer(3_200);
    h.live('mic')[0]?.options.onChunk(pcm, 1_765_000_000_123);
    expect(h.roger.sendAudioChunk).toHaveBeenCalledWith({
      source: 'mic',
      pcm,
      capturedAtMs: 1_765_000_000_123,
    });
  });

  it('reports each source live once it captures, and the call audio track ending', async () => {
    const h = harness();
    await started(h);
    expect(h.roger.reportAudioSourceState).toHaveBeenCalledWith({ source: 'mic', state: 'active' });
    expect(h.roger.reportAudioSourceState).toHaveBeenCalledWith({
      source: 'system',
      state: 'active',
    });

    h.live('system')[0]?.stream?.track.end();
    expect(h.roger.reportAudioSourceState).toHaveBeenLastCalledWith({
      source: 'system',
      state: 'ended',
      message: 'The audio device stopped delivering audio',
    });
  });

  it('follows the mic to the device left when its track ends, in the same capture', async () => {
    const h = harness();
    await started(h);
    const capture = h.live('mic')[0];
    // The USB mic is unplugged: its track ends and the built-in mic is the default now.
    h.mic.input = BUILT_IN;
    h.mediaDevices.change(BUILT_IN);
    capture?.stream?.track.end();
    await settle();
    h.micReady();
    await settle();

    expect(capture?.replaced.map((stream) => stream.track.label)).toEqual([
      'MacBook Pro Microphone',
    ]);
    expect(h.live('mic')).toEqual([capture]);
    // A recovered mic is not a cut: main hears "switched", never "ended" (which would close its
    // vendor session for the rest of the meeting, G1).
    expect(h.roger.reportAudioSourceState).toHaveBeenLastCalledWith({
      source: 'mic',
      state: 'active',
      message: 'Switched to MacBook Pro Microphone',
    });
    const reports = h.roger.reportAudioSourceState.mock.calls.map(([report]) => report);
    expect(reports.filter((report) => report.source === 'mic' && report.state === 'ended')).toEqual(
      [],
    );
    await h.controller.stop();
  });

  it('tells main the mic failed when it cannot come back, and stops capturing it', async () => {
    const h = harness();
    await started(h);
    const capture = h.live('mic')[0];
    h.mic.error = new DOMException('Permission denied', 'NotAllowedError');
    capture?.stream?.track.end();
    await settle();
    h.micReady();
    await settle();

    expect(h.roger.reportAudioSourceState).toHaveBeenLastCalledWith({
      source: 'mic',
      state: 'error',
      message: describeMediaError(h.mic.error),
    });
    expect(capture?.stopped).toBe(true);
    // Call audio goes on: only the mic's session closes (G1).
    expect(h.live('system')).toHaveLength(1);
    await h.controller.stop();
  });

  it('opens the mic when main records and nothing captures: a reload, a wake, a resume', async () => {
    // A page loaded mid-recording: a new controller, and main already recording.
    const h = harness();
    h.controller.followMain(recording());
    await settle();
    h.micReady();
    await settle();

    expect(h.live('mic')).toHaveLength(1);
    expect(h.live('system')).toHaveLength(1);
    h.controller.followMain(idle());
    await settle();
    expect(h.controller.running).toBe(false);
  });

  it('opens it once: statuses during that start, and a Start pressed meanwhile, join it', async () => {
    const h = harness();
    h.controller.followMain(recording());
    h.controller.followMain(recording());
    const pressed = h.controller.start(recording());
    h.controller.followMain(recording());
    await settle();
    h.micReady();
    await pressed;

    expect(h.mic.opens).toBe(1);
    expect(h.live('mic')).toHaveLength(1);
    expect(h.live('system')).toHaveLength(1);
  });

  it('tells main when a mic opened for it fails, and does not retry it every status', async () => {
    const h = harness();
    h.mic.error = new DOMException('Permission denied', 'NotAllowedError');
    h.controller.followMain(recording());
    await settle();
    h.micReady();
    await settle();

    expect(h.roger.reportAudioSourceState).toHaveBeenLastCalledWith({
      source: 'mic',
      state: 'error',
      message: describeMediaError(h.mic.error),
    });
    // Main sends a status every second while it records; each would open the mic again.
    h.controller.followMain(recording());
    h.controller.followMain(recording());
    await settle();
    expect(h.mic.opens).toBe(1);
  });

  it('leaves the mic shut when main gave up on it for this meeting, not for the next', async () => {
    const h = harness();
    // Main closed the mic's session for good (G1): a failed or ended source never reopens.
    h.controller.followMain(recording({}, 'error'));
    h.controller.followMain(recording({}, 'ended'));
    await settle();
    expect(h.mic.opens).toBe(0);

    h.controller.followMain(recording({ meetingId: NEXT_MEETING }));
    await settle();
    expect(h.mic.opens).toBe(1);
  });

  it("opens call audio only on Electron's path: the helper's tap runs in main", async () => {
    const opensCallAudio = async (status: CaptureStatus): Promise<boolean> => {
      const h = harness();
      await started(h, status);
      return h.roger.getSystemAudioSourceId.mock.calls.length > 0 && h.live('system').length > 0;
    };
    expect(await opensCallAudio(recording({ systemCapture: 'electron' }))).toBe(true);
    expect(await opensCallAudio(recording({ systemCapture: 'tap' }))).toBe(false);
    // No field: a main from before the helper (M2-T10), where Electron's path is the only one.
    expect(await opensCallAudio(recording())).toBe(true);
    // Null: main has not said. Opening ours could put a second call audio stream beside the tap.
    expect(await opensCallAudio(recording({ systemCapture: null }))).toBe(false);
  });

  it('does not reopen the mic between a Stop and main going idle', async () => {
    const h = harness();
    await started(h);
    // The person pressed Stop: capture here stops first, then main finishes its sessions, and
    // its status tick meanwhile still says recording.
    await h.controller.stop();
    h.controller.followMain(recording());
    await settle();
    expect(h.mic.opens).toBe(1);
    expect(h.controller.running).toBe(false);

    h.controller.followMain(idle());
    h.controller.followMain(recording({ meetingId: NEXT_MEETING }));
    await settle();
    expect(h.mic.opens).toBe(2);
  });
});
