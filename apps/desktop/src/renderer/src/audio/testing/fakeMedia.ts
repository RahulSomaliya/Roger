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
