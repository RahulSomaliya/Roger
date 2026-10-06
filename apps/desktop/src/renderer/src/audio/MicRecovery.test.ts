import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MIC_DEVICE_CHANGE_DEBOUNCE_MS,
  MIC_MUTE_GRACE_MS,
  MIC_RETRY_MS,
  MicRecovery,
} from './MicRecovery';
import {
  AIRPODS,
  BUILT_IN,
  FakeMediaDevices,
  type FakeInput,
  type FakeStream,
  micStream,
  USB_MIC,
} from './testing/fakeMedia';

/** A getUserMedia that fails like Chromium does. */
function mediaError(name: string): DOMException {
  return new DOMException(`${name} from getUserMedia`, name);
}

function harness(...inputs: FakeInput[]) {
  const devices = new FakeMediaDevices(...inputs);
  /** What getUserMedia opens next: the default input, unless a test makes it fail or wait. */
  const next: {
    input: FakeInput;
    error: Error | null;
    gate: Promise<void> | null;
    attempts: number;
  } = { input: inputs[0] ?? BUILT_IN, error: null, gate: null, attempts: 0 };
  const opened: FakeStream[] = [];
  const swapped: FakeStream[] = [];
  const switched: string[] = [];
  const failed: unknown[] = [];
  const recovery = new MicRecovery<FakeStream>({
    mediaDevices: devices,
    acquire: async () => {
      next.attempts += 1;
      // getUserMedia picks the default input when it is called, not when it answers.
      const input = next.input;
      if (next.gate !== null) await next.gate;
      if (next.error !== null) throw next.error;
      const stream = micStream(input);
      opened.push(stream);
      return stream;
    },
    swap: (stream) => {
      swapped.push(stream);
    },
    onSwitched: (device) => {
      switched.push(device);
    },
    onFailed: (error) => {
      failed.push(error);
    },
  });
  const first = micStream(inputs[0] ?? BUILT_IN);
  /** The track capture runs on now: the last one swapped in, or the first. */
  const current = () => (swapped.at(-1) ?? first).track;
  return { devices, next, opened, swapped, switched, failed, recovery, first, current };
}

/** Holds getUserMedia open until the returned function is called. */
function hold(next: { gate: Promise<void> | null }): () => void {
  let release = (): void => undefined;
  next.gate = new Promise((resolve) => {
    release = resolve;
  });
  return () => {
    next.gate = null;
    release();
  };
}

describe('MicRecovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('follows a new default input once devicechange settles, and reports the switch', async () => {
    const h = harness(BUILT_IN);
    await h.recovery.start(h.first);

    // AirPods connecting fire several devicechange events; one look after the last.
    h.next.input = AIRPODS;
    h.devices.change(AIRPODS, BUILT_IN);
    await vi.advanceTimersByTimeAsync(100);
    h.devices.change(AIRPODS, BUILT_IN);
    await vi.advanceTimersByTimeAsync(MIC_DEVICE_CHANGE_DEBOUNCE_MS - 1);
    expect(h.opened).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(h.swapped).toEqual(h.opened);
    expect(h.swapped).toHaveLength(1);
    expect(h.switched).toEqual(['AirPods Pro']);
  });

  it('leaves the mic alone when a devicechange moves nothing it captures', async () => {
    const h = harness(BUILT_IN);
    await h.recovery.start(h.first);
    // A second input appears; the default stays the built-in mic.
    h.devices.change(BUILT_IN, USB_MIC);
    await vi.advanceTimersByTimeAsync(MIC_DEVICE_CHANGE_DEBOUNCE_MS * 4);
    expect(h.opened).toEqual([]);
  });

  it('reacquires at once when the track ends, onto the default input that is left', async () => {
    const h = harness(USB_MIC, BUILT_IN);
    await h.recovery.start(h.first);
    // The USB mic is unplugged: its track ends, and the built-in mic is the default now.
    h.next.input = BUILT_IN;
    h.devices.change(BUILT_IN);
    h.first.track.end();
    await vi.advanceTimersByTimeAsync(0);

    expect(h.swapped.map((stream) => stream.track.label)).toEqual(['MacBook Pro Microphone']);
    expect(h.switched).toEqual(['MacBook Pro Microphone']);
    // The devicechange that came with it finds the new track on the default: no second attempt.
    await vi.advanceTimersByTimeAsync(MIC_DEVICE_CHANGE_DEBOUNCE_MS * 4);
    expect(h.opened).toHaveLength(1);
  });

  it('waits out an 800 ms mute before reacquiring; a blip that unmutes in time is nothing', async () => {
    const h = harness(BUILT_IN);
    await h.recovery.start(h.first);

    h.first.track.mute();
    await vi.advanceTimersByTimeAsync(MIC_MUTE_GRACE_MS - 1);
    h.first.track.unmute();
    await vi.advanceTimersByTimeAsync(MIC_MUTE_GRACE_MS * 2);
    expect(h.opened).toEqual([]);

    h.first.track.mute();
    await vi.advanceTimersByTimeAsync(MIC_MUTE_GRACE_MS);
    expect(h.swapped).toHaveLength(1);
    // The same device again is no switch: nothing to tell main.
    expect(h.switched).toEqual([]);
  });

  it('recovers a track that ended or came up muted before it was watched', async () => {
    const ended = harness(BUILT_IN);
    ended.first.track.end();
    await ended.recovery.start(ended.first);
    await vi.advanceTimersByTimeAsync(0);
    expect(ended.swapped).toHaveLength(1);

    const muted = harness(BUILT_IN);
    muted.first.track.mute();
    await muted.recovery.start(muted.first);
    await vi.advanceTimersByTimeAsync(MIC_MUTE_GRACE_MS);
    expect(muted.swapped).toHaveLength(1);
  });

  it('ignores a stale attempt: a stream that opens after stop() is ended, never swapped in', async () => {
    const h = harness(BUILT_IN);
    await h.recovery.start(h.first);
    const release = hold(h.next);
    h.first.track.end();
    await vi.advanceTimersByTimeAsync(0);

    h.recovery.stop();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.swapped).toEqual([]);
    expect(h.opened).toHaveLength(1);
    expect(h.opened[0]?.track.stopped).toBe(true);
  });

  it('ignores the attempt of a recovery started again since (generation counter)', async () => {
    const h = harness(BUILT_IN);
    await h.recovery.start(h.first);
    const release = hold(h.next);
    h.first.track.end();
    await vi.advanceTimersByTimeAsync(0);

    // A new capture started over (main stopped and started again): the old attempt is stale.
    const second = micStream(BUILT_IN);
    await h.recovery.start(second);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.swapped).toEqual([]);
    expect(h.opened[0]?.track.stopped).toBe(true);
  });

  it('runs one attempt at a time, and looks again after it if the default moved meanwhile', async () => {
    const h = harness(USB_MIC, BUILT_IN);
    await h.recovery.start(h.first);
    const release = hold(h.next);
    h.next.input = BUILT_IN;
    h.devices.change(BUILT_IN);
    h.first.track.end();
    h.first.track.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.next.attempts).toBe(1);

    // AirPods arrive while the built-in mic is still opening.
    h.next.input = AIRPODS;
    h.devices.change(AIRPODS, BUILT_IN);
    await vi.advanceTimersByTimeAsync(MIC_DEVICE_CHANGE_DEBOUNCE_MS);
    release();
    await vi.advanceTimersByTimeAsync(MIC_DEVICE_CHANGE_DEBOUNCE_MS);

    expect(h.swapped.map((stream) => stream.track.label)).toEqual([
      'MacBook Pro Microphone',
      'AirPods Pro',
    ]);
    expect(h.switched).toEqual(['MacBook Pro Microphone', 'AirPods Pro']);
  });

  it('gives up and says so when the microphone permission is gone', async () => {
    const h = harness(BUILT_IN);
    await h.recovery.start(h.first);
    h.next.error = mediaError('NotAllowedError');
    h.first.track.end();
    await vi.advanceTimersByTimeAsync(0);

    expect(h.failed).toEqual([h.next.error]);
    await vi.advanceTimersByTimeAsync(MIC_RETRY_MS * 3);
    h.devices.change(AIRPODS, BUILT_IN);
    await vi.advanceTimersByTimeAsync(MIC_DEVICE_CHANGE_DEBOUNCE_MS);
    expect(h.next.attempts).toBe(1);
    expect(h.failed).toHaveLength(1);
    expect(h.devices.listening).toBe(0);
  });

  it('tries a dead mic again every 2 s until a device opens', async () => {
    const h = harness(USB_MIC);
    await h.recovery.start(h.first);
    // The only mic was unplugged: nothing to open for now.
    h.next.error = mediaError('NotFoundError');
    h.first.track.end();
    await vi.advanceTimersByTimeAsync(MIC_RETRY_MS - 1);
    expect(h.next.attempts).toBe(1);
    expect(h.failed).toEqual([]);

    h.next.error = null;
    h.next.input = USB_MIC;
    await vi.advanceTimersByTimeAsync(1);
    expect(h.next.attempts).toBe(2);
    expect(h.swapped).toHaveLength(1);
    expect(h.switched).toEqual([]);
  });

  it('keeps a live mic when the new default will not open, until the next change', async () => {
    const h = harness(BUILT_IN);
    await h.recovery.start(h.first);
    h.next.error = mediaError('NotReadableError');
    h.devices.change(AIRPODS, BUILT_IN);
    await vi.advanceTimersByTimeAsync(MIC_DEVICE_CHANGE_DEBOUNCE_MS + MIC_RETRY_MS * 3);

    expect(h.next.attempts).toBe(1);
    expect(h.swapped).toEqual([]);
    expect(h.failed).toEqual([]);
    expect(h.current().readyState).toBe('live');
  });

  it('stop() lets go of every listener and timer', async () => {
    const h = harness(BUILT_IN);
    await h.recovery.start(h.first);
    h.first.track.mute();
    h.devices.change(AIRPODS, BUILT_IN);
    h.recovery.stop();

    expect(h.devices.listening).toBe(0);
    expect(h.first.track.listenerCount('ended')).toBe(0);
    expect(h.first.track.listenerCount('mute')).toBe(0);
    await vi.advanceTimersByTimeAsync(MIC_RETRY_MS * 3);
    expect(h.opened).toEqual([]);
  });
});
