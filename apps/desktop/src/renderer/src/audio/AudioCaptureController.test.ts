import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { idleCaptureStatus } from '../../../shared/capture';
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

function rogerApi() {
  const status = idleCaptureStatus({
    state: 'idle',
    pending: 0,
    rejected: 0,
    lastError: null,
    nextAttemptAt: null,
  });
  const api = {
    startCapture: () => Promise.resolve(status),
    stopCapture: () => Promise.resolve(status),
    getCaptureStatus: () => Promise.resolve(status),
    getSystemAudioSourceId: () => Promise.resolve('screen:1'),
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
  const mic: { input: FakeInput; error: Error | null; ready: () => void } = {
    input: USB_MIC,
    error: null,
    ready: () => undefined,
  };
  const mediaDevices = new FakeMediaDevices(USB_MIC, BUILT_IN);
  const openSystemAudio = vi.fn(() => Promise.resolve(new FakeStream()));
  const devices: CaptureDevices<FakeStream> = {
    mediaDevices,
    // The mic waits for the test: getUserMedia and the worklet setup take hundreds of ms.
    openMicrophone: () =>
      new Promise((resolve, reject) => {
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
async function started(h: ReturnType<typeof harness>): Promise<void> {
  const starting = h.controller.start();
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
    const starting = h.controller.start();
    await settle();
    // Main stopped on its own (the Mac went to sleep) before the mic was up: nothing runs yet.
    expect(h.controller.running).toBe(false);
    h.controller.followMain('idle');

    h.micReady();
    await starting;

    expect(h.live('mic')).toEqual([]);
    expect(h.captures.every((capture) => capture.stopped)).toBe(true);
    expect(h.openSystemAudio).not.toHaveBeenCalled();
    expect(h.controller.running).toBe(false);
  });

  it('stops every running source when main goes idle, and nothing while it records', async () => {
    const h = harness();
    const starting = h.controller.start();
    await settle();
    h.micReady();
    await starting;
    expect(h.live('mic')).toHaveLength(1);
    expect(h.live('system')).toHaveLength(1);

    h.controller.followMain('recording');
    expect(h.controller.running).toBe(true);
    h.controller.followMain('idle');
    await settle();

    expect(h.live('mic')).toEqual([]);
    expect(h.live('system')).toEqual([]);
    expect(h.controller.running).toBe(false);
  });

  it('never starts on top of a running capture', async () => {
    const h = harness();
    const first = h.controller.start();
    await settle();
    h.micReady();
    await first;

    const second = h.controller.start();
    await settle();
    h.micReady();
    await second;

    // One capture per source: two would send main the same audio twice.
    expect(h.live('mic')).toHaveLength(1);
    expect(h.live('system')).toHaveLength(1);
    expect(h.captures.filter((capture) => capture.stopped)).toHaveLength(2);
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
});
