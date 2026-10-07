import type { CallApp } from '../../shared/calendar';
import type { CallAppKind, DetectedCallApp } from './callApps';

/**
 * When a call is offered and when its recording stops by itself (M2 D6). Pure: it is told the
 * clock, never reads one, so CallOffer owns the timers and every rule here runs under a plain
 * number in its test. The monitor (callApps.ts, MeetingAppMonitor) says which call apps hold the
 * mic, and only when that list changes, so a timed rule needs the caller's own timer: ask
 * `nextDeadlineMs()` after every change.
 *
 * Offer: an app that has held the mic for CALL_*_OFFER_DELAY_MS, once per spell of mic use (a
 * spell ends when the app lets go, so a switch to AirPods or a second call offers again). Never
 * while a recording runs, and not for a call a recording was already running in: an app on the
 * mic when a recording starts, or arriving during one, is marked offered, or a note stopped by
 * hand mid-call would get a card five seconds later.
 *
 * Auto-stop: only for a recording in which a call app was seen, and only once none holds the mic
 * for the release debounce of the app that let go last. Muting keeps the mic running in Zoom and
 * Meet, so a mute never counts; the debounce covers the mic moving between devices. After a wake
 * the release is not decided before CALL_WAKE_GRACE_MS have passed: the call's app reconnects and
 * the helper may report an empty list meanwhile.
 */

/** A native call app (Zoom, Teams, FaceTime) is offered after this much mic use. */
export const CALL_NATIVE_OFFER_DELAY_MS = 5_000;
/** A browser is a weaker signal (any tab may hold the mic), so it waits longer. */
export const CALL_BROWSER_OFFER_DELAY_MS = 15_000;
/** Auto-stop after a native app let go of the mic for this long. */
export const CALL_NATIVE_RELEASE_MS = 15_000;
/** Auto-stop after a browser let go of the mic for this long. */
export const CALL_BROWSER_RELEASE_MS = 30_000;
/** No auto-stop earlier than this after a wake from sleep during a recording. */
export const CALL_WAKE_GRACE_MS = 60_000;

const OFFER_DELAY_MS: Record<CallAppKind, number> = {
  native: CALL_NATIVE_OFFER_DELAY_MS,
  browser: CALL_BROWSER_OFFER_DELAY_MS,
};

const RELEASE_MS: Record<CallAppKind, number> = {
  native: CALL_NATIVE_RELEASE_MS,
  browser: CALL_BROWSER_RELEASE_MS,
};

/** One app's spell of mic use. */
interface Spell {
  app: DetectedCallApp;
  sinceMs: number;
  offered: boolean;
}

/** What a recording remembers for auto-stop. */
interface FollowedRecording {
  /** A call app held the mic at some point in this recording (the only kind that auto-stops). */
  seen: boolean;
  /** The app the recording follows: the one that was on the mic, and the last one seen. */
  trigger: DetectedCallApp | null;
  /** When the last call app let go; null while one holds the mic. */
  releasedAtMs: number | null;
  /** How long that release must last: the longest of the apps that let go together. */
  releaseDebounceMs: number;
  /** When the Mac woke during this recording; null when it did not. */
  wokeAtMs: number | null;
  /** The stop was asked for (`stopRequested`). */
  stopRequested: boolean;
}

export class CallDetector {
  private spells = new Map<string, Spell>();
  private recording: FollowedRecording | null = null;
  private asleep = false;

  /** The call app this recording follows, for the status; null with none seen or no recording. */
  get trigger(): CallApp | null {
    const trigger = this.recording?.trigger;
    return trigger === undefined || trigger === null
      ? null
      : { bundleId: trigger.bundleId, name: trigger.name };
  }

  /** The monitor's whole list of call apps on the mic now. */
  setApps(apps: readonly DetectedCallApp[], nowMs: number): void {
    const before = [...this.spells.values()].map((spell) => spell.app);
    const next = new Map<string, Spell>();
    for (const app of apps) {
      const spell = this.spells.get(app.bundleId);
      // A recording marks what it sees as offered (see the header).
      next.set(app.bundleId, spell ?? { app, sinceMs: nowMs, offered: this.recording !== null });
    }
    this.spells = next;
    const recording = this.recording;
    if (recording === null) return;
    if (apps.length > 0) {
      recording.seen = true;
      recording.releasedAtMs = null;
      const kept = recording.trigger !== null && next.has(recording.trigger.bundleId);
      if (!kept) recording.trigger = preferNative(apps);
    } else if (before.length > 0) {
      recording.releasedAtMs = nowMs;
      recording.releaseDebounceMs = Math.max(...before.map((app) => RELEASE_MS[app.kind]));
    }
  }

  /**
   * The monitor is gone (its helper is out of restarts) and its empty list says nothing about the
   * call: forget what was on the mic, and never read it as a release. Without this a lost helper
   * stops a live call's recording 15 s later.
   */
  lose(): void {
    this.spells = new Map();
    if (this.recording !== null) this.recording.releasedAtMs = null;
  }

  /** Apps whose spell has lasted its delay and was not offered yet, native first; marks them. */
  dueOffers(nowMs: number): DetectedCallApp[] {
    const due = [...this.spells.values()].filter(
      (spell) => !spell.offered && nowMs >= spell.sinceMs + OFFER_DELAY_MS[spell.app.kind],
    );
    for (const spell of due) spell.offered = true;
    return due.map((spell) => spell.app).sort(byKind);
  }

  /** A recording starts: what is on the mic is the call it was started in. */
  startRecording(): void {
    for (const spell of this.spells.values()) spell.offered = true;
    const present = [...this.spells.values()].map((spell) => spell.app);
    this.recording = {
      seen: present.length > 0,
      trigger: present.length > 0 ? preferNative(present) : null,
      releasedAtMs: null,
      releaseDebounceMs: 0,
      wokeAtMs: null,
      stopRequested: false,
    };
  }

  endRecording(): void {
    this.recording = null;
    this.asleep = false;
  }

  /** The Mac is going to sleep: no stop is decided until it wakes. */
  suspend(): void {
    this.asleep = true;
  }

  /**
   * The Mac woke. Trap: a timer that was due during the sleep fires with the wall clock already
   * past it, and may run before this event: `suspend` stops it deciding anything meanwhile.
   */
  resume(nowMs: number): void {
    this.asleep = false;
    if (this.recording !== null) this.recording.wokeAtMs = nowMs;
  }

  /**
   * The caller acted on `stopDue`: it is due no more, and has no deadline. One stop per recording,
   * made or failed: a Stop that is slow (the upload drain takes up to 15 s) must not be asked
   * again by the next tick, and one that failed is not retried in a loop.
   */
  stopRequested(): void {
    if (this.recording !== null) this.recording.stopRequested = true;
  }

  /** The trigger when the recording should stop now because its call ended; else null. */
  stopDue(nowMs: number): CallApp | null {
    const stopAtMs = this.stopAtMs();
    if (stopAtMs === null || nowMs < stopAtMs) return null;
    return this.trigger;
  }

  /** The next time something is due (an offer or the stop), or null: for the caller's timer. */
  nextDeadlineMs(): number | null {
    const deadlines: number[] = [];
    for (const spell of this.spells.values()) {
      if (!spell.offered) deadlines.push(spell.sinceMs + OFFER_DELAY_MS[spell.app.kind]);
    }
    const stopAtMs = this.stopAtMs();
    if (stopAtMs !== null) deadlines.push(stopAtMs);
    return deadlines.length === 0 ? null : Math.min(...deadlines);
  }

  /** When the recording stops, or null if it is not going to (see the header). */
  private stopAtMs(): number | null {
    const recording = this.recording;
    if (
      recording === null ||
      !recording.seen ||
      recording.releasedAtMs === null ||
      this.asleep ||
      recording.stopRequested
    ) {
      return null;
    }
    const released = recording.releasedAtMs + recording.releaseDebounceMs;
    return recording.wokeAtMs === null
      ? released
      : Math.max(released, recording.wokeAtMs + CALL_WAKE_GRACE_MS);
  }
}

function byKind(a: DetectedCallApp, b: DetectedCallApp): number {
  return Number(b.kind === 'native') - Number(a.kind === 'native');
}

function preferNative(apps: readonly DetectedCallApp[]): DetectedCallApp | null {
  return [...apps].sort(byKind)[0] ?? null;
}
