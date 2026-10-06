/**
 * The parts of a MediaStream and its tracks that capture reads. A browser MediaStream fits both;
 * the tests pass doubles (testing/fakeMedia.ts), since node has no getUserMedia.
 */

export type TrackEvent = 'ended' | 'mute' | 'unmute';

export interface CaptureTrack {
  readonly readyState: MediaStreamTrackState;
  /** True while the device delivers no frames for now (MicRecovery waits a grace, then recovers). */
  readonly muted: boolean;
  /** The device's name for people, e.g. "MacBook Pro Microphone". */
  readonly label: string;
  getSettings(): MediaTrackSettings;
  addEventListener(type: TrackEvent, listener: () => void): void;
  removeEventListener(type: TrackEvent, listener: () => void): void;
  stop(): void;
}

export interface CaptureStream {
  getAudioTracks(): CaptureTrack[];
  getTracks(): CaptureTrack[];
}

/** Releases the device: a stopped track fires no `ended` event, so nothing reports it. */
export function stopTracks(stream: CaptureStream | null): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}
