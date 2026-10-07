import type { CapturePhase } from '../../../../shared/capture';
import type { SetupStatus } from '../../../../shared/ipc/setup';

/** What the redirect reads of the shell's capture view (useCapture) on each render. */
export interface CaptureSnapshot {
  /** Main's capture error (`CaptureStatus.error`), or null. */
  error: string | null;
  /** A Start or a Stop is on its way (`CaptureView.busy`). */
  busy: boolean;
  /** Main's phase, or null before its first status. */
  phase: CapturePhase | null;
}

/**
 * When the page sends the person to the setup screen by itself (M2-T19). Main cannot: the setup
 * slot in capture/createCaptureRuntime.ts runs before `[slot M4-S1]` in index.ts declares the
 * navigation, so the renderer's banner entry (app/slots/m2-setup.ts) watches and opens it:
 * - a first run: once per page load, when main says Roger never asked for the microphone
 *   (`not-determined`); the person can leave with Done and is not sent back until a reload;
 * - a refused Start: when a Start ends with an error, or the capture error turns non-null, while
 *   the microphone is `denied` or `restricted`, so the person lands on the row that says which
 *   switch to flip.
 *
 * One per page load (`pageSetupRedirect` in the slot file): a module outlives every route.
 */
export class SetupRedirect {
  private firstRunAsked = false;
  private lastError: string | null = null;
  private busy = false;
  /** The press that set `busy` was a Start: main was idle when it began. */
  private startRan = false;

  constructor(private readonly getStatus: () => Promise<SetupStatus>) {}

  /** Opens setup on a first run; asks main once, however often it is called. */
  async firstRun(open: () => void): Promise<void> {
    if (this.firstRunAsked) return;
    this.firstRunAsked = true;
    const status = await this.getStatus();
    if (status.microphone.state === 'not-determined') open();
  }

  /**
   * Called with the capture view whenever it may have changed; asks main only for a new error:
   * one that just turned non-null, or the one a Start ended with. A status that still carries the
   * same error, or swaps one for another, is the same failure the person already saw.
   *
   * Trap: never tell a new refusal by the error turning non-null alone. Main sends `starting`
   * (error null) and the refusal back to back (CaptureService.doStart), and React draws both in one
   * render, so a second Start refused in the same words reads as no change at all. Only the press
   * (`busy`, set the moment it runs) says a Start ran; the error is read once it has ended.
   */
  async captureChanged(view: CaptureSnapshot, open: () => void): Promise<void> {
    if (view.busy) {
      // A Stop begins while main records: the error it ends with is the recording's, already seen.
      if (!this.busy) this.startRan = view.phase === null || view.phase === 'idle';
      this.busy = true;
      return;
    }
    const appeared = view.error !== null && (this.lastError === null || this.startRan);
    this.busy = false;
    this.startRan = false;
    this.lastError = view.error;
    if (!appeared) return;
    const { state } = (await this.getStatus()).microphone;
    if (state === 'denied' || state === 'restricted') open();
  }
}
