import { parseAppRoute } from '../../shared/ipc/app';
import type { CallApp, PromptOffer } from '../../shared/calendar';
import type { CapturePhase } from '../../shared/capture';
import type { StatusContributor, StopOptions } from '../capture/CaptureService';
import type { QuitHook } from '../lifecycle';
import { errorMessage, type Logger } from '../logger';
import type { NotificationContent } from '../notify/Notifier';
import { CallDetector } from './CallDetector';
import type { DetectedCallApp } from './callApps';

/**
 * How long a dismissed call card keeps that app quiet (M2 D6): a person who said no to Zoom does
 * not want the same question each time the mic moves in a call that is still going.
 */
export const CALL_DISMISS_COOLDOWN_MS = 10 * 60_000;

/** What CallOffer needs of MeetingAppMonitor (M2-T17a). */
export interface CallOfferMonitor {
  readonly callApps: readonly DetectedCallApp[];
  /** False once the helper is out of restarts: its list is then empty, which says nothing. */
  readonly running: boolean;
  onCallApps(listener: (apps: readonly DetectedCallApp[]) => void): () => void;
}

/** What it needs of CaptureService, through the M2-T4 seams. */
export interface CallOfferCapture {
  readonly phase: CapturePhase;
  /** The live meeting's id, or null. Read before Stop: it is gone once the stop lands. */
  readonly meetingId: string | null;
  onRecording(listener: { started?(): void; ended?(): void }): () => void;
  stop(options: StopOptions): Promise<unknown>;
  addStatusContributor(name: string, read: StatusContributor): () => void;
  refreshStatus(): void;
}

/** M5's PromptService, as far as call detection goes. It owns the card and the notification. */
export interface CallPromptPort {
  offer(offer: PromptOffer): void;
  onCallCardDismissed(listener: (app: CallApp) => void): () => void;
}

/** Electron's `powerMonitor`, as far as sleep and wake go (a second listener, see `attach`). */
export interface CallPowerEvents {
  on(event: 'suspend' | 'resume', listener: () => void): unknown;
}

export interface CallOfferOptions {
  /** `config.capture.callDetection`: off means no offer and no auto-stop. */
  enabled: boolean;
  monitor: CallOfferMonitor;
  capture: CallOfferCapture;
  /** M2-T11's Notifier: a failed post bounces the dock and badges it until Roger is focused. */
  notifier: { notify(content: NotificationContent): void };
  powerMonitor: CallPowerEvents;
  logger: Logger;
  clock?: () => number;
}

/**
 * Call detection's side effects (M2-T17b): hands a call to the prompt panel and stops the
 * recording when the call ends. The rules and their numbers are CallDetector's; this owns the
 * timer (the monitor only emits when its list changes), the dismiss cooldown and the calls out.
 *
 * It never starts a recording: the offer is M5's card, whose "Take notes" goes through M5's start
 * request (OD-24). M2 posts no card or notification for an offer.
 *
 * `bindPrompts` is late-bound: PromptService is built by `createCalendarRuntime` (M5-T9c) in
 * index.ts, after `createCaptureRuntime` returns, and this is built inside it. Until it is bound
 * a due offer is logged and dropped, never queued: a card for a call that ended a minute ago is
 * worse than none.
 */
export class CallOffer {
  private readonly detector = new CallDetector();
  private readonly clock: () => number;
  private prompts: CallPromptPort | null = null;
  private readonly dismissedAtMs = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private readonly options: CallOfferOptions) {
    this.clock = options.clock ?? (() => Date.now());
  }

  /** Connects the prompt panel: the offers go to it, and its dismissals start the cooldown. */
  bindPrompts(prompts: CallPromptPort): void {
    if (this.prompts !== null) throw new Error('CallOffer already has a prompt service');
    this.prompts = prompts;
    prompts.onCallCardDismissed((app) => {
      this.dismissedAtMs.set(app.bundleId, this.clock());
    });
  }

  /**
   * Follows the monitor, the recordings and the Mac's power from now on. Call once, at launch.
   *
   * Trap: `powerMonitor`'s suspend and resume are PowerCoordinator's (M2-T18) to act on. This is a
   * second listener that only keeps CallDetector from deciding a release across a sleep; it never
   * pauses or stops anything for the sleep itself.
   */
  attach(): void {
    const { monitor, capture, powerMonitor, logger } = this.options;
    if (!this.options.enabled) {
      logger.info('call detection is off: no call offers and no auto-stop');
      return;
    }
    this.detector.setApps(monitor.callApps, this.clock());
    monitor.onCallApps((apps) => {
      this.guarded('call apps', () => {
        this.appsChanged(apps);
      });
    });
    capture.onRecording({
      started: () => {
        this.guarded('recording started', () => {
          this.detector.startRecording();
          this.changed();
        });
      },
      ended: () => {
        this.guarded('recording ended', () => {
          this.detector.endRecording();
          this.changed();
        });
      },
    });
    capture.addStatusContributor('call', () => ({ trigger: this.detector.trigger }));
    powerMonitor.on('suspend', () => {
      this.guarded('suspend', () => {
        this.detector.suspend();
        this.schedule();
      });
    });
    powerMonitor.on('resume', () => {
      this.guarded('resume', () => {
        this.detector.resume(this.clock());
        this.schedule();
      });
    });
    this.schedule();
  }

  /** Stops the timer at quit: nothing may offer or stop after the recording's own stop. */
  readonly quitHook: QuitHook = {
    name: 'stop call detection',
    timeoutMs: 1_000,
    run: () => {
      this.closed = true;
      this.clearTimer();
    },
  };

  private appsChanged(apps: readonly DetectedCallApp[]): void {
    const { monitor } = this.options;
    // MeetingAppMonitor reports an empty list when it is lost (its helper is out of restarts).
    // Trap: read as "everyone let go", the call's recording would stop 15 s after the helper dies.
    if (apps.length === 0 && !monitor.running) this.detector.lose();
    else this.detector.setApps(apps, this.clock());
    this.changed();
  }

  /** The followed app may have changed: tell the status, and set the timer for what is due next. */
  private changed(): void {
    this.options.capture.refreshStatus();
    this.schedule();
  }

  private schedule(): void {
    this.clearTimer();
    if (this.closed) return;
    const deadlineMs = this.detector.nextDeadlineMs();
    if (deadlineMs === null) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.guarded('timer', () => {
          this.tick();
        });
      },
      Math.max(0, deadlineMs - this.clock()),
    );
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private tick(): void {
    const nowMs = this.clock();
    for (const app of this.detector.dueOffers(nowMs)) this.offer(app, nowMs);
    const call = this.detector.stopDue(nowMs);
    if (call !== null) this.stopForEndedCall(call);
    this.schedule();
  }

  private offer(app: DetectedCallApp, nowMs: number): void {
    const { logger } = this.options;
    const dismissedAtMs = this.dismissedAtMs.get(app.bundleId);
    if (dismissedAtMs !== undefined && nowMs - dismissedAtMs < CALL_DISMISS_COOLDOWN_MS) {
      logger.info('call offer held back: its card was dismissed lately', {
        bundleId: app.bundleId,
        sinceDismissMs: nowMs - dismissedAtMs,
      });
      return;
    }
    if (this.prompts === null) {
      logger.warn('call offer dropped: no prompt service is bound yet', {
        bundleId: app.bundleId,
      });
      return;
    }
    // PromptService decides what the offer is worth (a recording running, a calendar prompt that
    // covers the call, a card for the app already up) and never throws.
    this.prompts.offer({
      source: 'call_detected',
      app: { bundleId: app.bundleId, name: app.name },
    });
  }

  /**
   * The normal stop, with its reason. Only a recording that is still recording: a Stop someone
   * pressed in the same second is already under way, and its notice would be false.
   */
  private stopForEndedCall(call: CallApp): void {
    const { capture, notifier, logger } = this.options;
    this.detector.stopRequested();
    if (capture.phase !== 'recording') return;
    logger.info('the call ended: stopping the recording', { bundleId: call.bundleId });
    // Read before the stop: the session is gone when it lands, and a click on the notice must open
    // THIS meeting, not Home (the Notifier's route; none means Home).
    const meetingId = capture.meetingId;
    const route = meetingId === null ? null : parseAppRoute(`meeting/${meetingId}`);
    capture
      .stop({ reason: 'call-ended', detail: call.name })
      .then(() => {
        notifier.notify({
          title: `Roger stopped your notes: the call in ${call.name} ended`,
          body: 'Your notes are in Roger.',
          ...(route === null ? {} : { route }),
        });
      })
      .catch((error: unknown) => {
        // No retry: CaptureService says in its status why Stop failed, and the no-speech and
        // 4-hour stops are still behind it.
        logger.error('stop for call-ended failed', {
          bundleId: call.bundleId,
          error: errorMessage(error),
        });
      });
  }

  /** A listener that throws must not take the monitor's or the clock's callback down with it. */
  private guarded(what: string, run: () => void): void {
    try {
      run();
    } catch (error) {
      this.options.logger.error('call detection failed', { what, error: errorMessage(error) });
    }
  }
}
