import {
  AUDIO_SOURCE_LABEL,
  BLUETOOTH_MIC_DEAD_WARNING_MS,
  CALL_AUDIO_NEVER_HEARD_WARNING_MS,
  CALL_AUDIO_SILENT_LOUD_MS,
  CALL_AUDIO_SILENT_LOUD_WITH_SPEECH_MS,
  CALL_AUDIO_SILENT_WARNING_MS,
  type CaptureWarning,
  type CaptureWarningKind,
  MIC_DEAD_WARNING_MS,
  NO_AUDIO_WARNING_MS,
} from '../../shared/capture';
import { AUDIO_SOURCES, type AudioSource } from '../../shared/transcript';

/**
 * The warning rules of the M2 design ("Silence and no-audio warnings", D3, D4): given what
 * SignalMonitor measured, which warnings hold now and which are loud. Pure, so every threshold is
 * tested here without audio or timers; the thresholds themselves live once in shared/capture.ts.
 *
 * A warning only tells the user. It never opens or closes a vendor session: CaptureSession's stall
 * close (G2) and M3-T20's silence gate do that, and a warning that did would fight them.
 */

/** What SignalMonitor measured about one source at one check. */
export interface SourceSignal {
  /**
   * The track or helper ended or failed (CaptureService's source health `ended` or `error`), with
   * the reason it gave; null while it runs.
   */
  stopped: { message: string | null } | null;
  /** Wall-clock ms since the source's last chunk, or since Start before its first one. */
  noChunkForMs: number;
  /**
   * Ms of audio received since the source last carried sound (since Start if it never did): digital
   * silence, and a flat level when SignalMonitor's flat-level rule is on. 0 while it carries sound.
   * Audio time, not wall time: a Mac asleep or a stalled source sends no audio, so neither counts
   * as silence.
   */
  silentForMs: number;
  /** A chunk above digital silence came in this recording. */
  heard: boolean;
}

export interface SignalFacts {
  sources: Readonly<Record<AudioSource, SourceSignal>>;
  /** The mic is a Bluetooth input: it may stay silent far longer (D4). */
  micBluetooth: boolean;
  /**
   * A mic line was transcribed since call audio went silent: the user talks and nobody answers,
   * so the silence is likely a cut, not a pause (D3).
   */
  micSpokeSinceCallSilence: boolean;
  /** Call audio was heard for this signing identity (M2-T1, M2-T10; `systemAudioVerified`). */
  systemAudioVerified: boolean;
  /** A speech-to-text stream is `offline` (M2-T6). */
  offline: boolean;
}

/** A warning that holds now, before its spell is dated. */
export interface DetectedWarning extends Omit<CaptureWarning, 'since'> {
  /** How long its condition has held: the spell is dated this far back. */
  heldForMs: number;
}

/** How long a source may carry only silence before its signal is dead (`SignalState`). */
export function deadSignalAfterMs(source: AudioSource, micBluetooth: boolean): number {
  if (source === 'system') return CALL_AUDIO_SILENT_WARNING_MS;
  return micBluetooth ? BLUETOOTH_MIC_DEAD_WARNING_MS : MIC_DEAD_WARNING_MS;
}

/** The warnings that hold for these facts: the offline one first, then the mic's, then call audio's. */
export function detectWarnings(facts: SignalFacts): DetectedWarning[] {
  const detected: DetectedWarning[] = [];
  if (facts.offline) {
    detected.push({
      kind: 'offline',
      source: null,
      loud: true,
      message: MESSAGES.offline,
      heldForMs: 0,
    });
  }
  for (const source of AUDIO_SOURCES) {
    const warning = sourceWarning(source, facts.sources[source], facts);
    if (warning !== null) detected.push(warning);
  }
  return detected;
}

/**
 * At most one warning per source, the most specific first: a stopped source sends nothing and a
 * source that sends nothing has no silence to judge, so the user reads one cause, not three.
 */
function sourceWarning(
  source: AudioSource,
  signal: SourceSignal,
  facts: SignalFacts,
): DetectedWarning | null {
  const warn = (
    kind: CaptureWarningKind,
    loud: boolean,
    message: string,
    heldForMs: number,
  ): DetectedWarning => ({ kind, source, loud, message, heldForMs });

  if (signal.stopped !== null) {
    const reason = signal.stopped.message ?? 'its audio ended';
    return warn(
      'source-ended',
      true,
      `${AUDIO_SOURCE_LABEL[source]} stopped: ${reason}. Press Stop, then Start again.`,
      0,
    );
  }
  if (signal.noChunkForMs >= NO_AUDIO_WARNING_MS) {
    return warn('no-audio', true, MESSAGES.noAudio[source], signal.noChunkForMs);
  }
  if (source === 'mic') {
    return signal.silentForMs >= deadSignalAfterMs('mic', facts.micBluetooth)
      ? warn('mic-dead', true, MESSAGES.micDead, signal.silentForMs)
      : null;
  }
  // Call audio from a global tap is exact zeros whenever nothing plays, so its silence is judged
  // more gently than the mic's (D3). Before it was ever heard: a waiting room or an early join is
  // silent too, so only the 20 s rule applies, and it is loud only while nothing proves Roger may
  // record call audio at all (a refused or still-pending tap is silent with no error).
  if (!signal.heard) {
    if (signal.silentForMs < CALL_AUDIO_NEVER_HEARD_WARNING_MS) return null;
    return facts.systemAudioVerified
      ? warn('call-audio-never-heard', false, MESSAGES.neverHeard, signal.silentForMs)
      : warn('call-audio-never-heard', true, MESSAGES.neverHeardUnverified, signal.silentForMs);
  }
  if (signal.silentForMs < CALL_AUDIO_SILENT_WARNING_MS) return null;
  if (signal.silentForMs >= CALL_AUDIO_SILENT_LOUD_MS) {
    return warn('call-audio-silent', true, MESSAGES.callSilentLong, signal.silentForMs);
  }
  if (
    facts.micSpokeSinceCallSilence &&
    signal.silentForMs >= CALL_AUDIO_SILENT_LOUD_WITH_SPEECH_MS
  ) {
    return warn('call-audio-silent', true, MESSAGES.callSilentWhileYouTalk, signal.silentForMs);
  }
  return warn('call-audio-silent', false, MESSAGES.callSilent, signal.silentForMs);
}

// Fixed per rule, never with a running count ("for 61 s"): SignalMonitor refreshes the status only
// when a warning changes, and a message that changed every second would refresh it every second.
// Never transcript text: warnings reach logs, capture events and macOS notifications.
const MESSAGES = {
  offline:
    'The Mac is offline, so transcription stopped. Roger reconnects on its own when the network is back.',
  noAudio: {
    mic: 'No audio has come from the mic for 5 seconds: Roger cannot hear you. Check the microphone; if it does not come back, press Stop, then Start again.',
    system:
      'No call audio has reached Roger for 5 seconds: it cannot hear the call. If it does not come back, press Stop, then Start again.',
  },
  micDead:
    'The mic sends only silence: Roger cannot hear you. Check that the input volume is not at 0 and that Roger is on under System Settings, Privacy & Security, Microphone.',
  neverHeardUnverified:
    'No call audio since Start. If the call is playing, Roger may not be allowed to record it: open Set up Roger and test system audio.',
  neverHeard: 'No call audio yet. Roger picks it up as soon as the call plays sound.',
  callSilent:
    'Call audio is silent. That is normal in a pause; if the others are talking, Roger is not hearing them.',
  callSilentWhileYouTalk:
    'Call audio has been silent for a minute while you talk. If the others are talking, Roger is not hearing them: press Stop, then Start again.',
  callSilentLong:
    'Call audio has been silent for 3 minutes. If the others are talking, Roger is not hearing them: press Stop, then Start again.',
} as const;

const TITLES: Readonly<
  Record<CaptureWarningKind, string | Readonly<Record<AudioSource | 'none', string>>>
> = {
  'no-audio': { mic: 'No audio from your mic', system: 'No call audio', none: 'No audio' },
  'source-ended': { mic: 'Your mic stopped', system: 'Call audio stopped', none: 'Audio stopped' },
  'helper-hung': 'Call audio stalled',
  'mic-dead': 'Your mic is silent',
  'call-audio-never-heard': 'No call audio',
  'call-audio-silent': 'Call audio is silent',
  offline: 'Transcription is offline',
  'backup-paused': 'Audio backup paused',
};

/**
 * A notification's title for a warning, whoever raised it: the Notifier posts every loud warning
 * in the status, M2-T10's and M2-T15's included, and macOS shows "Roger" above it.
 */
export function warningTitle({ kind, source }: Pick<CaptureWarning, 'kind' | 'source'>): string {
  const title = TITLES[kind];
  return typeof title === 'string' ? title : title[source ?? 'none'];
}

export interface WarningChanges {
  /** Every warning now; a spell keeps the `since` it began with for as long as it lasts. */
  warnings: CaptureWarning[];
  /** Spells that began with this update, or turned loud (call audio silent at 60 or 180 s). */
  raised: CaptureWarning[];
  /** Spells that ended with this update, as they last read. */
  cleared: CaptureWarning[];
  /** Anything a status shows changed: a spell began, ended, turned loud or quiet, or reworded. */
  changed: boolean;
}

/**
 * The spells of the warnings: one per kind and stream, from the first update that detects it to the
 * first that does not. A spell keeps its `since`, which the Notifier uses to post once per spell.
 */
export class WarningSpells {
  private spells = new Map<string, CaptureWarning>();

  update(detected: readonly DetectedWarning[], nowMs: number): WarningChanges {
    const next = new Map<string, CaptureWarning>();
    const raised: CaptureWarning[] = [];
    let changed = false;
    for (const { heldForMs, ...warning } of detected) {
      const key = spellKey(warning);
      const spell = this.spells.get(key);
      const since = spell?.since ?? new Date(nowMs - heldForMs).toISOString();
      const current: CaptureWarning = { ...warning, since };
      next.set(key, current);
      if (spell === undefined || (current.loud && !spell.loud)) raised.push(current);
      if (spell?.loud !== current.loud || spell.message !== current.message) changed = true;
    }
    const cleared = [...this.spells].flatMap(([key, spell]) => (next.has(key) ? [] : [spell]));
    this.spells = next;
    return {
      warnings: [...next.values()],
      raised,
      cleared,
      changed: changed || cleared.length > 0,
    };
  }

  /** Ends every spell (the recording ended) and returns them as they last read. */
  clear(): CaptureWarning[] {
    const ended = [...this.spells.values()];
    this.spells = new Map();
    return ended;
  }
}

function spellKey({ kind, source }: Pick<CaptureWarning, 'kind' | 'source'>): string {
  return `${kind}/${source ?? 'none'}`;
}
