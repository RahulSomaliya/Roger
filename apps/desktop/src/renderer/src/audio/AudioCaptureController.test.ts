import { describe, expect, it, vi } from 'vitest';
import { idleCaptureStatus } from '../../../shared/capture';
import type { RogerApi } from '../../../shared/ipc';
import type { AudioSource } from '../../../shared/transcript';
import { AudioCaptureController, type CaptureDevices } from './AudioCaptureController';
import type { PcmStreamCaptureOptions } from './PcmStreamCapture';

/** A capture double: records whether it runs. No AudioContext or getUserMedia in node. */
class FakeCapture {
  running = false;
  stopped = false;
  constructor(readonly options: PcmStreamCaptureOptions) {}
  start(): Promise<void> {
    this.running = true;
    return Promise.resolve();
  }
  stop(): Promise<void> {
    this.running = false;
    this.stopped = true;
    return Promise.resolve();
  }
}

// Only getTracks is read (to stop a stream whose capture failed to start); a fake needs no more.
const fakeStream = { getTracks: () => [] } as Pick<MediaStream, 'getTracks'> as MediaStream;

function rogerApi(): RogerApi {
  const status = idleCaptureStatus({
    state: 'idle',
    pending: 0,
    rejected: 0,
    lastError: null,
    nextAttemptAt: null,
  });
  return {
    startCapture: () => Promise.resolve(status),
    stopCapture: () => Promise.resolve(status),
    getCaptureStatus: () => Promise.resolve(status),
    getSystemAudioSourceId: () => Promise.resolve('screen:1'),
    sendAudioChunk: vi.fn(),
    reportAudioSourceState: vi.fn(),
    onCaptureStatus: () => () => undefined,
    onTranscriptSegment: () => () => undefined,
    onTranscriptInterim: () => () => undefined,
  };
}

function harness() {
  const captures: FakeCapture[] = [];
  let micOpened = (): void => undefined;
  const openSystemAudio = vi.fn(() => Promise.resolve(fakeStream));
  const devices: CaptureDevices = {
    // The mic waits for the test: getUserMedia and the worklet setup take hundreds of ms.
    openMicrophone: () =>
      new Promise((resolve) => {
        micOpened = () => {
          resolve(fakeStream);
        };
      }),
    openSystemAudio,
    createCapture: (options) => {
      const capture = new FakeCapture(options);
      captures.push(capture);
      return capture;
    },
  };
  const controller = new AudioCaptureController(rogerApi(), devices);
  const live = (source: AudioSource) =>
    captures.filter((capture) => capture.options.source === source && capture.running);
  return {
    controller,
    captures,
    openSystemAudio,
    live,
    micReady: () => {
      micOpened();
    },
  };
}

/** Lets pending promise callbacks run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe('AudioCaptureController', () => {
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
});
