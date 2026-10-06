import { type CaptureStream, type CaptureTrack, stopTracks } from './streams';

/**
 * Keeps the mic capturing through device changes (M2 design, "Mic capture"; from OpenWhispr's
 * `activeMicRecovery.js`). It follows the default input, and reacquires the mic when its track
 * ends, stays muted past a grace, or its device leaves. The new stream is swapped into the running
 * capture, into the same worklet node, so the chunks, their frame count and main's vendor session
 * carry on: a device Roger recovers from is not a cut, and main hears "switched", never "ended"
 * (which would close the mic's session for the rest of the meeting, G1).
 */

/** devicechange fires in bursts (a headset connecting fires several): one look after the last. */
export const MIC_DEVICE_CHANGE_DEBOUNCE_MS = 250;
/** A track muted this long has stopped delivering for now; a shorter mute is a blip. */
export const MIC_MUTE_GRACE_MS = 800;
/** A mic that is dead and could not be reopened is tried again this often. */
export const MIC_RETRY_MS = 2_000;
/**
 * Reopens in a row that hand out an already-ended track before recovery gives up. macOS does that,
 * instead of a NotAllowedError, once Roger's Microphone access is off (PcmStreamCapture.start), so
 * no retry brings the mic back; one alone may be a device leaving as it opened.
 */
export const MIC_DEAD_OPENS_LIMIT = 3;

/** One entry of `enumerateDevices()`, as far as recovery reads it. */
export type DeviceInfo = Pick<MediaDeviceInfo, 'deviceId' | 'groupId' | 'kind' | 'label'>;

/** `navigator.mediaDevices`, as far as recovery reads it. Tests pass a fake. */
export interface DeviceWatch {
  enumerateDevices(): Promise<DeviceInfo[]>;
  addEventListener(type: 'devicechange', listener: () => void): void;
  removeEventListener(type: 'devicechange', listener: () => void): void;
}

export interface MicRecoveryOptions<S extends CaptureStream> {
  mediaDevices: DeviceWatch;
  /** Opens the default input: getUserMedia with no device id. */
  acquire(): Promise<S>;
  /** Feeds the new stream into the running capture in place of the old one, and ends the old. */
  swap(stream: S): void;
  /** The mic now captures another device, named for people ("AirPods Pro"). */
  onSwitched(device: string): void;
  /**
   * The mic cannot come back: its permission is gone (NotAllowedError, or MIC_DEAD_OPENS_LIMIT
   * dead tracks in a row). Recovery has stopped by then.
   */
  onFailed(error: unknown): void;
}

interface AudioInputs {
  /** The default input's group id (one per physical device); '' when not exposed. */
  defaultGroupId: string;
  /** The default input's entry as a whole: it changes when the default does. */
  defaultKey: string;
  deviceIds: Set<string>;
  groupIds: Set<string>;
}

function describeInputs(devices: DeviceInfo[]): AudioInputs {
  const inputs = devices.filter((device) => device.kind === 'audioinput');
  // Chromium lists the default input first, as a "Default - <name>" entry with its device's group.
  const first = inputs[0];
  return {
    defaultGroupId: first?.groupId ?? '',
    defaultKey: first === undefined ? '' : `${first.deviceId}\n${first.groupId}\n${first.label}`,
    deviceIds: new Set(inputs.map((device) => device.deviceId).filter((id) => id !== '')),
    groupIds: new Set(inputs.map((device) => device.groupId).filter((id) => id !== '')),
  };
}

/** "Default - AirPods Pro" is "AirPods Pro": Chromium names the default entry so. */
function deviceName(label: string): string {
  const name = label.replace(/^Default - /, '').trim();
  return name === '' ? 'the default microphone' : name;
}

/** Which device a track captures: its group, or its name where the ids are not exposed. */
function deviceOf(track: CaptureTrack): string {
  const { groupId } = track.getSettings();
  return groupId !== undefined && groupId !== ''
    ? `group ${groupId}`
    : `name ${deviceName(track.label)}`;
}

/** The mic's permission is gone: no retry can bring it back. */
function isPermissionError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'NotAllowedError' || error.name === 'SecurityError')
  );
}

export class MicRecovery<S extends CaptureStream> {
  private running = false;
  /** Bumped by stop() and start(): an attempt from before ends its stream and swaps nothing. */
  private generation = 0;
  private stream: S | null = null;
  private track: CaptureTrack | null = null;
  /** The device of `track`, read when it was attached: an ended track may no longer say. */
  private device: string | null = null;
  /** The inputs at the last look; null before one, or when the browser would not list them. */
  private inputs: AudioInputs | null = null;
  /** The attempt in flight: one at a time, or two streams would race to be swapped in. */
  private recovery: Promise<void> | null = null;
  /** A devicechange, or a track ending, came while an attempt ran: look again once it is done. */
  private changedDuringRecovery = false;
  /** Reopens in a row whose track had ended before it was handed out (MIC_DEAD_OPENS_LIMIT). */
  private deadOpens = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private muteTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly onDeviceChange = (): void => {
    this.scheduleLook();
  };
  private readonly onEnded = (): void => {
    // An attempt in flight may have just swapped this track in, and would leave it dead: the look
    // after it finds the ended track and reacquires.
    if (this.recovery !== null) this.changedDuringRecovery = true;
    void this.recover();
  };
  private readonly onMute = (): void => {
    clearTimeout(this.muteTimer);
    this.muteTimer = setTimeout(() => {
      this.muteTimer = undefined;
      if (this.track?.muted === true) void this.recover();
    }, MIC_MUTE_GRACE_MS);
  };
  private readonly onUnmute = (): void => {
    clearTimeout(this.muteTimer);
    this.muteTimer = undefined;
  };

  constructor(private readonly options: MicRecoveryOptions<S>) {}

  /** Watches `stream`, which the capture runs on now. Restarts from scratch if already running. */
  async start(stream: S): Promise<void> {
    this.stop();
    this.running = true;
    const generation = this.generation;
    this.options.mediaDevices.addEventListener('devicechange', this.onDeviceChange);
    this.attach(stream);
    this.inputs = await this.listInputs();
    if (!this.isCurrent(generation)) return;
    // The track may have ended, or come up muted, before the listeners were on; neither event
    // fires again.
    if (this.track?.readyState === 'ended') void this.recover();
    else if (this.track?.muted === true) this.onMute();
  }

  stop(): void {
    this.running = false;
    this.generation += 1;
    this.options.mediaDevices.removeEventListener('devicechange', this.onDeviceChange);
    this.detach();
    clearTimeout(this.debounceTimer);
    clearTimeout(this.retryTimer);
    this.debounceTimer = undefined;
    this.retryTimer = undefined;
    this.recovery = null;
    this.changedDuringRecovery = false;
    this.deadOpens = 0;
    this.stream = null;
  }

  /** A method, not a field read: typed lint trusts a narrowing of `running` across an await. */
  private isCurrent(generation: number): boolean {
    return this.running && generation === this.generation;
  }

  private attach(stream: S): void {
    this.detach();
    this.stream = stream;
    const track = stream.getAudioTracks()[0] ?? null;
    this.track = track;
    this.device = track === null ? null : deviceOf(track);
    track?.addEventListener('ended', this.onEnded);
    track?.addEventListener('mute', this.onMute);
    track?.addEventListener('unmute', this.onUnmute);
  }

  private detach(): void {
    this.track?.removeEventListener('ended', this.onEnded);
    this.track?.removeEventListener('mute', this.onMute);
    this.track?.removeEventListener('unmute', this.onUnmute);
    this.track = null;
    clearTimeout(this.muteTimer);
    this.muteTimer = undefined;
  }

  /**
   * The audio inputs, or null when the browser will not list them (it refuses only a page that is
   * going away). Null is not hidden: every decision below then rests on the track alone.
   */
  private async listInputs(): Promise<AudioInputs | null> {
    try {
      return describeInputs(await this.options.mediaDevices.enumerateDevices());
    } catch {
      return null;
    }
  }

  private scheduleLook(): void {
    if (!this.running) return;
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.look();
    }, MIC_DEVICE_CHANGE_DEBOUNCE_MS);
  }

  /** After a devicechange: reacquire if the track is dead, gone, or off the default input. */
  private async look(): Promise<void> {
    if (this.recovery !== null) {
      this.changedDuringRecovery = true;
      return;
    }
    const generation = this.generation;
    const previous = this.inputs;
    const current = await this.listInputs();
    if (!this.isCurrent(generation)) return;
    this.inputs = current;
    if (this.needsRecovery(previous, current)) void this.recover();
  }

  private needsRecovery(previous: AudioInputs | null, current: AudioInputs | null): boolean {
    const track = this.track;
    if (track === null || track.readyState === 'ended') return true;
    // No list: a live track is healthier than a guess that the device left.
    if (current === null) return false;
    const { deviceId, groupId } = track.getSettings();
    const known = (id: string | undefined): id is string => id !== undefined && id !== '';
    if (known(deviceId) && !current.deviceIds.has(deviceId)) {
      if (!known(groupId) || !current.groupIds.has(groupId)) return true;
    }
    // Follow the default input. A track opened on the default stays on that device when the
    // default moves; its group id tells which device it is on.
    if (known(groupId) && current.defaultGroupId !== '') return groupId !== current.defaultGroupId;
    // Ids not exposed: a change of the default entry is all there is to go on.
    return previous !== null && previous.defaultKey !== current.defaultKey;
  }

  private recover(): Promise<void> {
    if (!this.running) return Promise.resolve();
    if (this.recovery !== null) return this.recovery;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const generation = this.generation;
    const recovery = this.attempt(generation).finally(() => {
      if (this.recovery === recovery) this.recovery = null;
      if (this.isCurrent(generation) && this.changedDuringRecovery) {
        this.changedDuringRecovery = false;
        this.scheduleLook();
      }
    });
    this.recovery = recovery;
    return recovery;
  }

  /** One reacquire. It settles, never rejects: a failure is handled here. */
  private async attempt(generation: number): Promise<void> {
    const before = this.device;
    let replacement: S | null = null;
    try {
      replacement = await this.options.acquire();
      if (!this.isCurrent(generation)) {
        stopTracks(replacement);
        return;
      }
      const track = replacement.getAudioTracks()[0];
      if (track === undefined) throw new Error('The microphone stream has no audio track');
      // As in start(): an ended track never fires `ended`, and one that came up muted never fires
      // `mute`. Swapped in unchecked, an ended one would leave the mic dead for the rest of the
      // meeting, with no retry, no error for main, and maybe a false "switched".
      if (track.readyState === 'ended') {
        this.deadOpens += 1;
        throw new Error(
          'The microphone track had ended as it opened (is the microphone permission granted?)',
        );
      }
      this.deadOpens = 0;
      this.options.swap(replacement);
      this.attach(replacement);
      if (track.muted) this.onMute();
      this.inputs = await this.listInputs();
      // stop() may have come during the listing: a switch reported now could land on the next
      // meeting, under the name of no device (the track is gone).
      if (!this.isCurrent(generation)) return;
      if (this.device !== null && this.device !== before) {
        this.options.onSwitched(deviceName(this.track?.label ?? ''));
      }
    } catch (error) {
      if (replacement !== null && replacement !== this.stream) stopTracks(replacement);
      if (!this.isCurrent(generation)) return;
      if (isPermissionError(error)) {
        this.fail(error);
        return;
      }
      // A new default that will not open while the old device still captures: keep the old one
      // until the next devicechange, rather than reopen every 2 s for nothing.
      if (this.track !== null && this.track.readyState !== 'ended' && !this.track.muted) return;
      if (this.deadOpens >= MIC_DEAD_OPENS_LIMIT) {
        this.fail(error);
        return;
      }
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        void this.recover();
      }, MIC_RETRY_MS);
    }
  }

  private fail(error: unknown): void {
    this.stop();
    this.options.onFailed(error);
  }
}
