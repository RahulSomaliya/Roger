import {
  type CaptureNotice,
  type CaptureStatus,
  type CaptureWarning,
  DIGITAL_SILENCE_PEAK,
  FLAT_LEVEL_UNDER_FLOOR_DB,
  type SignalState,
} from '../../shared/capture';
import { PCM_SAMPLE_RATE } from '../../shared/ipc';
import { pcmBytesToMs } from '../../shared/pcm';
import { AUDIO_SOURCES, type AudioSource } from '../../shared/transcript';
import { errorMessage, type Logger } from '../logger';
import type { JsonObject, TranscriptStore } from '../store/TranscriptStore';
import type { AudioSink } from './AudioFanout';
import type {
  CaptureService,
  ContributedSourceStatus,
  RecordingStarted,
  StatusContribution,
} from './CaptureService';
import {
  deadSignalAfterMs,
  detectWarnings,
  type SignalFacts,
  type SourceSignal,
  WarningSpells,
} from './warnings';

/** How often the warnings are checked while recording. */
const CHECK_INTERVAL_MS = 1_000;

/**
 * A check that comes this much later than the last one means the Mac slept (Node's timers stop
 * while it sleeps and the wall clock does not) or the event loop was stuck: that check is skipped,
 * or every source would read as sending nothing for the whole sleep and warn of no audio at wake
 * (openwhispr's watchdog).
 */
const TIMER_GAP_MS = 5_000;

/** `levelDb` is the peak of the chunks that arrived in this last stretch of wall time. */
const LEVEL_WINDOW_MS = 1_000;

/**
 * How fast the flat-level rule's floor (MicFloor) may rise toward louder chunks: 80 s of loud
 * speech with no quieter chunk would be needed to lift it the rule's 40 dB over the room.
 */
const FLOOR_RISE_DB_PER_S = 0.5;

/**
 * For this much of the mic's audio after Start or a device switch, the floor follows every
 * quieter chunk down, however far: a pause in the first seconds teaches it the room before it
 * judges anything, so a call that opens on speech is not judged against the voice.
 */
const FLOOR_SETTLE_MS = 10_000;

/**
 * A run of chunks under the floor is a flat level while their peaks stay within this many dB of
 * each other: an input at volume 0 gives a steady faint level, and one that moves is something
 * heard. Noise a few LSB high peaks at 3 to 5 LSB from chunk to chunk, about 4.4 dB apart.
 */
const FLAT_LEVEL_SPREAD_DB = 6;

/** The device switches a recording keeps on screen; AirPods that flap would grow it forever. */
const MAX_NOTICES = 20;

/** Int16 full scale: the peak of 0 dBFS. */
const FULL_SCALE = 32_768;

/** The capture seams the monitor attaches to (M2-T4): it never edits CaptureService. */
export type SignalMonitorCapture = Pick<
  CaptureService,
  'addAudioSink' | 'addStatusContributor' | 'onRecording' | 'on'
>;

export interface SignalMonitorOptions {
  /** Where each warning spell and device switch goes, for the meeting's capture report. */
  store: Pick<TranscriptStore, 'addCaptureEvent'>;
  logger: Logger;
  /**
   * Called when the warnings or notices change, so the window gets them at once (the slot passes
   * `capture.refreshStatus`). Never called from inside `observeStatus`: a status listener that
   * emitted a status would hand the listeners after it the newer status before the older one.
   */
  onChange: () => void;
  clock?: () => number;
  /**
   * The flat-level rule of the M2 design: a mic level held more than FLAT_LEVEL_UNDER_FLOOR_DB
   * under its running floor is dead, like digital silence. Off, and stays off until the Mac check
   * M2-T11 hands to a person (the built-in mic's peak at `osascript -e 'set volume input volume
   * 0'`) finds a peak above DIGITAL_SILENCE_PEAK: if input volume 0 gives digital zeros, the
   * silence rule already catches it, and this rule could only add false warnings. Turn it on in
   * the M2-T11 slot of createCaptureRuntime.ts and write the measured peak into the M2 exit check
   * log in the same change.
   *
   * Check the room too: the floor is the room's level (MicFloor), and in 16-bit audio a peak of
   * 2 LSB (-84 dBFS) is FLAT_LEVEL_UNDER_FLOOR_DB under it only in a room louder than about
   * -44 dBFS. In a quiet room the rule cannot see input volume 0 at a faint level; that is a
   * change to the threshold in the M2 plan, not here.
   */
  flatLevelRule?: boolean;
}

/** What the monitor knows about one source this recording. */
interface SourceMeter {
  chunks: number;
  /** Clock time of the last chunk; Start, a wake or a device switch before one. */
  lastChunkAtMs: number;
  /** Audio time since the source last carried sound (SourceSignal.silentForMs). */
  silentForMs: number;
  /** Clock time the current silence began; null while the source carries sound. */
  silentSinceMs: number | null;
  /** A chunk above digital silence came in this recording. */
  heard: boolean;
  /** Peaks of the chunks of the last LEVEL_WINDOW_MS, oldest first. */
  recent: { atMs: number; peak: number }[];
  /** The status says the track or helper ended or failed (CaptureService's source health). */
  stopped: SourceSignal['stopped'];
}

interface Recording {
  meetingId: string;
  meetingStartedAtMs: number;
}

/**
 * Signal health and the warnings of the M2 design ("Silence and no-audio warnings"): a fan-out
 * sink (AudioFanout) that measures every chunk of both sources, plus a once-a-second check that
 * turns what it measured into warnings (warnings.ts). It adds `warnings`, `notices` and each
 * source's `signal` and `levelDb` to the status through M2-T4's status-contributor seam, and the
 * Notifier posts the loud ones. Each spell and device switch is also a capture event, so the
 * capture report of every exit-check call lists them.
 *
 * It only warns: it never opens or closes a vendor session. CaptureSession's stall close (G2) and
 * M3-T20's silence gate do that, through the open budget (house rule 9).
 *
 * Inputs it does not measure come from the status CaptureService emits (`observeStatus`): a
 * source's health (`ended`, `error`), an `offline` stream (M2-T6), `systemAudioVerified` (M2-T10),
 * `paused` (M2-T18), the phase (Stop) and the mic's `device`. A Bluetooth mic comes through
 * `setMicBluetooth` (M2-T17a's monitor knows the input's transport; the status names only the
 * device).
 */
export class SignalMonitor implements AudioSink {
  private readonly clock: () => number;
  private readonly flatLevelRule: boolean;
  private readonly spells = new WarningSpells();
  private recording: Recording | null = null;
  private meters: Record<AudioSource, SourceMeter>;
  /** The flat-level rule's floor; the mic's own (call audio has rules of its own). */
  private micFloor = new MicFloor();
  private timer: NodeJS.Timeout | null = null;
  private lastCheckAtMs = 0;
  private warnings: CaptureWarning[] = [];
  private notices: CaptureNotice[] = [];
  /** Notices added this recording, and how many the last change told the status about. */
  private noticesAdded = 0;
  private noticesTold = 0;
  /** Device level: it outlives recordings, as the input does. */
  private micBluetooth = false;
  /** The mic's device as this recording's status last named it; null until one does. */
  private micDevice: string | null = null;
  /** Clock time of the last mic line transcribed this recording. */
  private micLineAtMs: number | null = null;
  private systemAudioVerified = false;
  private offline = false;
  private asleep = false;
  /**
   * The status's phase is not `recording`: Stop has begun. CaptureService drops every chunk from
   * then until the sessions close and `ended` comes, and that close can take 5 s (a vendor that
   * never answers the finish) plus 10 s (a reopen still connecting). Checked like any other phase,
   * both sources read as cut and post "no audio" next to the stop notice. CaptureService's own
   * no-audio check (`checkAudioFlow`) runs only while recording for the same reason.
   */
  private stopping = false;

  constructor(private readonly options: SignalMonitorOptions) {
    this.clock = options.clock ?? (() => Date.now());
    this.flatLevelRule = options.flatLevelRule ?? false;
    this.meters = { mic: newMeter(0), system: newMeter(0) };
  }

  /** Follows every recording of `capture` through its seams. */
  attach(capture: SignalMonitorCapture): void {
    capture.addAudioSink('signal', this);
    capture.addStatusContributor('signal', () => this.contribution());
    capture.onRecording({
      started: (recording) => {
        this.recordingStarted(recording);
      },
      ended: () => {
        this.recordingEnded();
      },
    });
    capture.on('status', (status) => {
      this.observeStatus(status);
    });
    capture.on('segment', (segment) => {
      this.lineHeard(segment.source);
    });
  }

  recordingStarted({
    meetingId,
    meetingStartedAtMs,
  }: Pick<RecordingStarted, 'meetingId' | 'meetingStartedAtMs'>): void {
    this.stopChecks();
    const now = this.clock();
    this.recording = { meetingId, meetingStartedAtMs };
    this.meters = { mic: newMeter(now), system: newMeter(now) };
    this.micFloor = new MicFloor();
    this.spells.clear();
    this.warnings = [];
    this.notices = [];
    this.noticesAdded = 0;
    this.noticesTold = 0;
    this.micDevice = null;
    this.micLineAtMs = null;
    this.offline = false;
    this.asleep = false;
    this.stopping = false;
    this.lastCheckAtMs = now;
    this.timer = setInterval(() => {
      this.check();
    }, CHECK_INTERVAL_MS);
  }

  /**
   * Every spell ends with the recording, in the capture report too (a `warning` with no
   * `warning-cleared` reads as a cut that never ended); the status drops the monitor's fields.
   */
  recordingEnded(): void {
    const recording = this.recording;
    if (recording === null) return;
    this.stopChecks();
    const now = this.clock();
    for (const warning of this.spells.clear()) this.cleared(recording, warning, now);
    this.recording = null;
    this.warnings = [];
    this.notices = [];
    this.options.onChange();
  }

  onChunk(source: AudioSource, pcm: Uint8Array): void {
    if (this.recording === null) return;
    const meter = this.meters[source];
    const now = this.clock();
    const durationMs = pcmBytesToMs(pcm.byteLength, PCM_SAMPLE_RATE);
    const peak = pcmPeak(pcm);
    meter.chunks += 1;
    meter.lastChunkAtMs = now;
    meter.recent.push({ atMs: now, peak });
    while ((meter.recent[0]?.atMs ?? now) <= now - LEVEL_WINDOW_MS) meter.recent.shift();
    if (this.carriesSound(source, peak, durationMs)) {
      meter.silentForMs = 0;
      meter.silentSinceMs = null;
      meter.heard = true;
      return;
    }
    meter.silentSinceMs ??= now - durationMs;
    meter.silentForMs += durationMs;
  }

  /**
   * Reads what the monitor does not measure from a status CaptureService emitted. Only records:
   * the next check acts on it (see `onChange`).
   */
  observeStatus(status: CaptureStatus): void {
    const recording = this.recording;
    if (recording?.meetingId !== status.meetingId) return;
    this.systemAudioVerified = status.systemAudioVerified === true;
    this.offline = AUDIO_SOURCES.some((source) => status.streams[source] === 'offline');
    this.asleep = status.paused === 'asleep';
    this.stopping = status.phase !== 'recording';
    for (const source of AUDIO_SOURCES) {
      const { health, message } = status.sources[source];
      this.meters[source].stopped = health === 'ended' || health === 'error' ? { message } : null;
    }
    this.followMicDevice(recording, status.sources.mic.device ?? null);
  }

  /**
   * A final line was transcribed from `source`. A mic line during a call-audio silence makes that
   * silence loud sooner (D3): the user talks and nobody is heard answering. Lines, not mic level:
   * a real mic is never silent, so its level cannot tell speech from a room's hiss, and the
   * vendor's finals already do.
   */
  lineHeard(source: AudioSource): void {
    if (this.recording !== null && source === 'mic') this.micLineAtMs = this.clock();
  }

  /**
   * The default input is a Bluetooth device, which may stay silent for longer (D4). Its caller is
   * M2-T17a, from the monitor helper's `route.input.transport` (AudioRouteStatus carries no input
   * transport). At the M2-T11 review nothing called it and no task's spec named it: until a caller
   * lands, D4 is not live and an AirPods mic is called dead at 8 s. The caller drops this line.
   */
  setMicBluetooth(bluetooth: boolean): void {
    this.micBluetooth = bluetooth;
  }

  /** The monitor's part of the status (M2-T4's status contributor); nothing when idle. */
  contribution(): StatusContribution {
    if (this.recording === null) return {};
    const now = this.clock();
    return {
      warnings: [...this.warnings],
      notices: [...this.notices],
      sources: { mic: this.sourceStatus('mic', now), system: this.sourceStatus('system', now) },
    };
  }

  private check(): void {
    const recording = this.recording;
    if (recording === null) return;
    const now = this.clock();
    const gapMs = now - this.lastCheckAtMs;
    this.lastCheckAtMs = now;
    // Paused for sleep (M2-T18), both sessions are closed; from Stop until its sessions close,
    // every chunk is dropped. Either way the sources stop on purpose and nothing is wrong with the
    // audio, so no warning holds.
    const stoppedOnPurpose = this.asleep || this.stopping;
    if (gapMs > TIMER_GAP_MS || stoppedOnPurpose) {
      // Silence counts in audio time, so a sleep adds none; the time since each source's last
      // chunk is wall time, so it starts again here, and a source that does not come back still
      // warns NO_AUDIO_WARNING_MS after the wake.
      for (const source of AUDIO_SOURCES) this.meters[source].lastChunkAtMs = now;
    }
    if (gapMs > TIMER_GAP_MS) {
      this.options.logger.info('signal check skipped after a timer gap', {
        meetingId: recording.meetingId,
        gapMs,
      });
      return;
    }
    const detected = stoppedOnPurpose ? [] : detectWarnings(this.facts(now));
    const changes = this.spells.update(detected, now);
    for (const warning of changes.raised) this.raised(recording, warning, now);
    for (const warning of changes.cleared) this.cleared(recording, warning, now);
    this.warnings = changes.warnings;
    if (changes.changed || this.noticesAdded !== this.noticesTold) {
      this.noticesTold = this.noticesAdded;
      this.options.onChange();
    }
  }

  private facts(now: number): SignalFacts {
    const system = this.meters.system;
    return {
      sources: { mic: this.sourceSignal('mic', now), system: this.sourceSignal('system', now) },
      micBluetooth: this.micBluetooth,
      micSpokeSinceCallSilence:
        system.silentSinceMs !== null &&
        this.micLineAtMs !== null &&
        this.micLineAtMs > system.silentSinceMs,
      systemAudioVerified: this.systemAudioVerified,
      offline: this.offline,
    };
  }

  private sourceSignal(source: AudioSource, now: number): SourceSignal {
    const meter = this.meters[source];
    return {
      stopped: meter.stopped,
      noChunkForMs: now - meter.lastChunkAtMs,
      silentForMs: meter.silentForMs,
      heard: meter.heard,
    };
  }

  private sourceStatus(source: AudioSource, now: number): ContributedSourceStatus {
    const meter = this.meters[source];
    let signal: SignalState;
    if (meter.chunks === 0) signal = 'unknown';
    else if (meter.silentForMs === 0) signal = 'signal';
    else if (meter.silentForMs >= deadSignalAfterMs(source, this.micBluetooth)) signal = 'dead';
    else signal = 'quiet';
    let peak = 0;
    for (const chunk of meter.recent) {
      if (chunk.atMs > now - LEVEL_WINDOW_MS) peak = Math.max(peak, chunk.peak);
    }
    // `|| 0` turns -0 (full scale rounds to it) into 0: toEqual and Object.is tell them apart.
    const levelDb = peak > DIGITAL_SILENCE_PEAK ? Math.round(toDbfs(peak) * 10) / 10 || 0 : null;
    return { signal, levelDb };
  }

  /** Whether a chunk counts as sound; digital silence never does, a flat level only by the rule. */
  private carriesSound(source: AudioSource, peak: number, durationMs: number): boolean {
    if (peak <= DIGITAL_SILENCE_PEAK) return false;
    if (!this.flatLevelRule || source !== 'mic') return true;
    return !this.micFloor.flatUnderFloor(toDbfs(peak), durationMs);
  }

  /**
   * A new mic device (M2-T12's recovery follows the default input) is a notice, never a warning,
   * and its silence is timed afresh: the old device's silence says nothing about the new one.
   *
   * At the M2-T11 review nothing in main wrote `sources.mic.device`: M2-T12's "switched" report
   * lives in the renderer, and the source-state IPC carries no device. Until a contributor sets
   * it, no "Switched to" notice shows and a switch is not timed afresh. The writer drops this
   * paragraph.
   */
  private followMicDevice(recording: Recording, device: string | null): void {
    const previous = this.micDevice;
    if (device === null) return;
    this.micDevice = device;
    if (previous === null || previous === device) return;
    const now = this.clock();
    const meter = this.meters.mic;
    meter.lastChunkAtMs = now;
    meter.silentForMs = 0;
    meter.silentSinceMs = null;
    this.micFloor = new MicFloor();
    const notice: CaptureNotice = {
      kind: 'device-switched',
      source: 'mic',
      at: new Date(now).toISOString(),
      message: `Switched to ${device}`,
    };
    this.notices = [...this.notices, notice].slice(-MAX_NOTICES);
    this.noticesAdded += 1;
    this.options.logger.info('mic device switched', { meetingId: recording.meetingId, device });
    this.record(recording, now, 'mic', 'device-switched', { device });
  }

  private raised(recording: Recording, warning: CaptureWarning, now: number): void {
    this.options.logger.warn('capture warning', {
      meetingId: recording.meetingId,
      kind: warning.kind,
      source: warning.source,
      loud: warning.loud,
    });
    this.record(recording, now, warning.source, 'warning', {
      warning: warning.kind,
      loud: warning.loud,
    });
  }

  private cleared(recording: Recording, warning: CaptureWarning, now: number): void {
    const lastedMs = now - Date.parse(warning.since);
    this.options.logger.info('capture warning cleared', {
      meetingId: recording.meetingId,
      kind: warning.kind,
      source: warning.source,
      lastedMs,
    });
    this.record(recording, now, warning.source, 'warning-cleared', {
      warning: warning.kind,
      lastedMs,
    });
  }

  /** A capture event for the report. A refused write is logged; the warning itself still shows. */
  private record(
    recording: Recording,
    now: number,
    source: AudioSource | null,
    kind: string,
    detail: JsonObject,
  ): void {
    try {
      this.options.store.addCaptureEvent({
        meetingId: recording.meetingId,
        at: new Date(now).toISOString(),
        offsetMs: Math.round(now - recording.meetingStartedAtMs),
        source,
        kind,
        detail,
      });
    } catch (error) {
      this.options.logger.error('capture event not saved', {
        meetingId: recording.meetingId,
        kind,
        error: errorMessage(error),
      });
    }
  }

  private stopChecks(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}

function newMeter(now: number): SourceMeter {
  return {
    chunks: 0,
    lastChunkAtMs: now,
    silentForMs: 0,
    silentSinceMs: null,
    heard: false,
    recent: [],
    stopped: null,
  };
}

/**
 * The flat-level rule's view of the mic (M2 design: "a level flat for 8 s more than 40 dB under
 * the running floor"). The floor is the room's level, the quietest the mic has been lately, never
 * the voice's: it follows a quieter chunk down at once and rises toward louder ones at most
 * FLOOR_RISE_DB_PER_S, so the pauses between phrases hold it at the room. An average of the
 * chunks would sit at the voice's level and call the first pause in a quiet room a dead mic.
 *
 * A chunk more than FLAT_LEVEL_UNDER_FLOOR_DB under the floor leaves the floor where it is (a dead
 * input must not teach the floor its level, or the warning would end while the mic is still
 * dead), and counts toward a dead mic while the run of such chunks stays flat.
 */
class MicFloor {
  private floorDb: number | null = null;
  private judgedMs = 0;
  /** The quietest and loudest chunk of the current run under the floor; null outside one. */
  private run: { minDb: number; maxDb: number } | null = null;

  /** Whether a chunk at `levelDb`, above digital silence, is in a flat level under the floor. */
  flatUnderFloor(levelDb: number, durationMs: number): boolean {
    const floorDb = this.floorDb;
    const settled = this.judgedMs >= FLOOR_SETTLE_MS;
    this.judgedMs += durationMs;
    if (floorDb !== null && settled && levelDb < floorDb - FLAT_LEVEL_UNDER_FLOOR_DB) {
      const run = this.run;
      const minDb = Math.min(run?.minDb ?? levelDb, levelDb);
      const maxDb = Math.max(run?.maxDb ?? levelDb, levelDb);
      if (maxDb - minDb <= FLAT_LEVEL_SPREAD_DB) {
        this.run = { minDb, maxDb };
        return true;
      }
      // The level moved: not flat, so this chunk counts as sound (it restarts the mic's silence)
      // and a new run may start from it.
      this.run = { minDb: levelDb, maxDb: levelDb };
      return false;
    }
    this.run = null;
    this.floorDb =
      floorDb === null
        ? levelDb
        : Math.min(levelDb, floorDb + (FLOOR_RISE_DB_PER_S * durationMs) / 1_000);
    return false;
  }
}

/** The largest sample magnitude of Int16 little-endian PCM (32768 for a full-scale negative). */
export function pcmPeak(pcm: Uint8Array): number {
  // A DataView, not an Int16Array: a chunk may start at an odd byte offset of its buffer.
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let peak = 0;
  for (let offset = 0; offset + 1 < pcm.byteLength; offset += 2) {
    peak = Math.max(peak, Math.abs(view.getInt16(offset, true)));
  }
  return peak;
}

function toDbfs(peak: number): number {
  return 20 * Math.log10(peak / FULL_SCALE);
}
