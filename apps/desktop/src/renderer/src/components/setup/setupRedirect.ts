import type { SetupStatus } from '../../../../shared/ipc/setup';

/**
 * When the page sends the person to the setup screen by itself (M2-T19). Main cannot: the setup
 * slot in capture/createCaptureRuntime.ts runs before `[slot M4-S1]` in index.ts declares the
 * navigation, so the renderer's banner entry (app/slots/m2-setup.ts) watches and opens it:
 * - a first run: once per page load, when main says Roger never asked for the microphone
 *   (`not-determined`); the person can leave with Done and is not sent back until a reload;
 * - a refused Start: when the capture error turns non-null while the microphone is `denied` or
 *   `restricted`, so the person lands on the row that says which switch to flip.
 *
 * One per page load (`pageSetupRedirect` in the slot file): a module outlives every route.
 */
export class SetupRedirect {
  private firstRunAsked = false;
  private lastError: string | null = null;

  constructor(private readonly getStatus: () => Promise<SetupStatus>) {}

  /** Opens setup on a first run; asks main once, however often it is called. */
  async firstRun(open: () => void): Promise<void> {
    if (this.firstRunAsked) return;
    this.firstRunAsked = true;
    const status = await this.getStatus();
    if (status.microphone.state === 'not-determined') open();
  }

  /**
   * Called with the capture status's error whenever it may have changed; asks main only when it
   * just turned non-null. A status that still carries the same error, or swaps one for another,
   * is the same refusal the person already saw.
   */
  async captureError(error: string | null, open: () => void): Promise<void> {
    const appeared = error !== null && this.lastError === null;
    this.lastError = error;
    if (!appeared) return;
    const { state } = (await this.getStatus()).microphone;
    if (state === 'denied' || state === 'restricted') open();
  }
}
