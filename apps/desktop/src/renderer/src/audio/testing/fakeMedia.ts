import type { DeviceInfo, DeviceWatch } from '../MicRecovery';
import type { CaptureStream, CaptureTrack, TrackEvent } from '../streams';

/**
 * Media doubles for the capture tests: node has no getUserMedia, MediaStream or AudioContext. A
 * plain module, not a `*.test.ts`: importing from a test file would register its tests again.
 */

export class FakeTrack implements CaptureTrack {
  readyState: MediaStreamTrackState = 'live';
  muted = false;
  stopped = false;
  private readonly listeners = new Map<TrackEvent, Set<() => void>>();

  constructor(
    readonly label = 'MacBook Pro Microphone',
    private readonly settings: MediaTrackSettings = { deviceId: 'default', groupId: 'built-in' },
  ) {}

  getSettings(): MediaTrackSettings {
    return this.settings;
  }

  addEventListener(type: TrackEvent, listener: () => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: TrackEvent, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  /** As in browsers, stopping a track fires no `ended` event. */
  stop(): void {
    this.stopped = true;
    this.readyState = 'ended';
  }

  /** The device went away, or macOS ended the track: `ended` fires. */
  end(): void {
    this.readyState = 'ended';
    this.emit('ended');
  }

  /** The device stopped delivering frames for now. */
  mute(): void {
    this.muted = true;
    this.emit('mute');
  }

  unmute(): void {
    this.muted = false;
    this.emit('unmute');
  }

  listenerCount(type: TrackEvent): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  private emit(type: TrackEvent): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }
}

export class FakeStream implements CaptureStream {
  constructor(readonly track: FakeTrack = new FakeTrack()) {}

  getAudioTracks(): FakeTrack[] {
    return [this.track];
  }

  getTracks(): FakeTrack[] {
    return [this.track];
  }
}

/** A physical input: its name and its group id (one per device, as Chromium reports it). */
export interface FakeInput {
  label: string;
  groupId: string;
}

export const BUILT_IN: FakeInput = { label: 'MacBook Pro Microphone', groupId: 'built-in' };
export const AIRPODS: FakeInput = { label: 'AirPods Pro', groupId: 'airpods' };
export const USB_MIC: FakeInput = { label: 'Shure MV7', groupId: 'shure' };

/** A live track on `input`, opened on the default device as getUserMedia without an id does. */
export function micStream(input: FakeInput): FakeStream {
  return new FakeStream(
    new FakeTrack(input.label, { deviceId: 'default', groupId: input.groupId }),
  );
}

/**
 * navigator.mediaDevices as MicRecovery reads it. Chromium lists the default input first, as a
 * "Default - <name>" entry sharing its device's group id, then every input by its own id.
 */
export class FakeMediaDevices implements DeviceWatch {
  enumerations = 0;
  private inputs: FakeInput[];
  private readonly listeners = new Set<() => void>();

  constructor(...inputs: FakeInput[]) {
    this.inputs = inputs;
  }

  enumerateDevices(): Promise<DeviceInfo[]> {
    this.enumerations += 1;
    const [first] = this.inputs;
    const entries: DeviceInfo[] = this.inputs.map((input) => ({
      deviceId: `id-${input.groupId}`,
      groupId: input.groupId,
      kind: 'audioinput',
      label: input.label,
    }));
    if (first === undefined) return Promise.resolve(entries);
    const defaultEntry: DeviceInfo = {
      deviceId: 'default',
      groupId: first.groupId,
      kind: 'audioinput',
      label: `Default - ${first.label}`,
    };
    const speakers: DeviceInfo = {
      deviceId: 'id-speakers',
      groupId: 'speakers',
      kind: 'audiooutput',
      label: 'MacBook Pro Speakers',
    };
    return Promise.resolve([defaultEntry, ...entries, speakers]);
  }

  addEventListener(_type: 'devicechange', listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'devicechange', listener: () => void): void {
    this.listeners.delete(listener);
  }

  get listening(): number {
    return this.listeners.size;
  }

  /** The inputs become `inputs`, the first one the default, and devicechange fires. */
  change(...inputs: FakeInput[]): void {
    this.inputs = inputs;
    for (const listener of [...this.listeners]) listener();
  }
}
