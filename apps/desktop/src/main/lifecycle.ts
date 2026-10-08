import type { CapturePhase, CaptureStatus } from '../shared/capture';
import type { StopOptions } from './capture/CaptureService';
import type { StopReason } from './capture/stopReasons';
import { errorMessage, type Logger } from './logger';
import { withTimeout } from './util/time';

/**
 * Cost guard G4: whatever ends the app's ability to record (quit, the window really closing, a page
 * that cannot be brought back) stops the recording through the normal stop: finish sequence, last lines
 * saved, sessions closed. Left open, each vendor session bills until a vendor timeout (AssemblyAI:
 * the 120 s idle timeout Roger asks for; without it, the 3-hour cap, $0.45 a stream). A renderer
 * crash or a reload no longer stops (M2 D7, M2-T12): the page comes back and reopens the mic
 * because main is recording, and until its chunks come, G2's stall close shuts the mic's session
 * after 30 s, so a crash costs at most that. Closing the window hides it and the recording goes on
 * (M5-T11, app/windowLifecycle.ts): the window's `closed`, which with close-hides comes only while
 * quitting, is what stops. A page that keeps crashing stops instead
 * (RENDERER_CRASH_LIMIT). Nor does a sleep (M2-T18): power/PowerCoordinator.ts finishes and closes
 * both sessions at `suspend` and stops with `system-sleep` only after a sleep of noSpeechStopMs or
 * more. The decisions live here and are tested; index.ts only connects Electron's objects.
 */

/**
 * The crash that makes this many within RENDERER_CRASH_WINDOW_MS stops the recording instead of
 * reloading. The page opens the mic only after it loads, so a crash in the capture path or the
 * recording view comes after did-finish-load, past the guard for a page that dies on load. Each
 * such cycle sends a few chunks, so G2's stall close never fires: without this limit the window
 * reloads every second or two, the mic flickering, until G5's 4-hour cap.
 */
export const RENDERER_CRASH_LIMIT = 3;
export const RENDERER_CRASH_WINDOW_MS = 60_000;

export interface StoppableCapture {
  stop(options: StopOptions): Promise<CaptureStatus>;
  /** Not getStatus(): that reads the store, which the quit's cleanup closes. */
  readonly phase: CapturePhase;
}

/**
 * One step of the quit's cleanup, run after the recording has stopped (or its stop timed out).
 * Hooks run in list order, each awaited for at most its own `timeoutMs`. A hook that throws,
 * rejects or hangs is logged and the quit goes on to the next one, so no hook can keep Roger from
 * quitting. A synchronous hook cannot be cut short: the bound only reaches the async part.
 */
export interface QuitHook {
  /** Names the hook in the log, e.g. "close the transcript store". */
  readonly name: string;
  readonly timeoutMs: number;
  run(): Promise<void> | void;
}

export interface RecordingLifecycleOptions {
  capture: StoppableCapture;
  logger: Logger;
  /** How long a quit waits for the stop (costGuards.quitStopTimeoutMs). */
  quitStopTimeoutMs: number;
  /**
   * Monotonic ms for the crash window (performance.now() in the app). Never the wall clock: an
   * NTP step could hide a crash loop or invent one. Injected in tests.
   */
  now?: () => number;
  /**
   * The quit's cleanup after the stop, in order; index.ts lists them, with the uploader stop and
   * the store close last. Add a hook to that list; never a before-quit listener of your own:
   * Electron runs it on the first Cmd+Q, while this class is still stopping the recording, so a
   * store it closes is gone before the stop has saved the last lines, and it runs again on the
   * quit this class re-issues.
   */
  quitHooks: readonly QuitHook[];
  /** Quits for real (app.quit). The quit requests it causes are let through. */
  quit: () => void;
}

/**
 * The reasons an Electron event stops a recording; the quit has its own path. Not `system-sleep`:
 * PowerCoordinator decides that one at wake (M2-T18).
 */
export type LifecycleStopReason = Extract<StopReason, 'window-closed' | 'renderer-gone'>;

/** Chromium's net error for a load that another load replaced, or one that was cancelled. */
const ERR_ABORTED = -3;

/** A page load that failed (Electron's did-fail-load), as far as the decision below needs it. */
export interface PageLoadFailure {
  errorCode: number;
  errorDescription: string;
  /** False for a subframe; the app has none, and a subframe's failure leaves the page running. */
  isMainFrame: boolean;
}

export class RecordingLifecycle {
  private quitState: 'running' | 'stopping' | 'done' = 'running';
  /**
   * True from a crash's reload until that page has loaded. A crash before then is the reloaded
   * page dying on load, which would reload forever: that one stops instead.
   */
  private reloadingAfterCrash = false;
  /** When each crash in the last RENDERER_CRASH_WINDOW_MS came, on `now`'s clock. */
  private recentCrashes: number[] = [];
  private readonly now: () => number;

  constructor(private readonly options: RecordingLifecycleOptions) {
    this.now = options.now ?? (() => performance.now());
  }

  /**
   * before-quit and will-quit (Cmd+Q, the menu, logout). True means the caller must prevent this
   * quit: the recording stops first, then this class quits itself. A quit never hangs on the stop:
   * past quitStopTimeoutMs it goes ahead, and process exit closes the sockets anyway.
   */
  onQuitRequested(): boolean {
    if (this.quitState === 'done') return false;
    if (this.quitState === 'running') {
      this.quitState = 'stopping';
      void this.stopThenQuit();
    }
    return true;
  }

  /** Stops a recording (or one still starting) through the normal stop, with the reason. */
  stopFor(reason: LifecycleStopReason, detail?: string): void {
    // A quit stops the recording itself, and its cleanup closes the store before the window
    // closes; a stop started now would race that cleanup.
    if (this.quitState !== 'running') return;
    const { capture, logger } = this.options;
    const phase = capture.phase;
    if (phase !== 'recording' && phase !== 'starting') return;
    // `detail` (a crash's reason, a load error) is for this log line only: never the stop's
    // `detail`, which words the notice on the page (stopReasons.ts stopNotice; sweep W3).
    logger.warn('stopping the recording', { reason, detail: detail ?? null });
    // No upload flush: the app may be going away, and the uploader resumes on its own.
    const options: StopOptions = { flushUploads: false, reason };
    capture.stop(options).catch((error: unknown) => {
      logger.error('stop failed', { reason, error: errorMessage(error) });
    });
  }

  /**
   * The renderer process died (M2 D7): reload the page instead of stopping, while recording or
   * not, so the window is never left dead. The reloaded page reopens the mic because main is
   * recording (renderer/src/state/useCapture.ts follows main). `reload` throwing, the reloaded
   * page crashing before it loads, or a page that keeps crashing after it loads
   * (RENDERER_CRASH_LIMIT) stops with `renderer-gone` and reloads no more.
   */
  onRendererGone(reason: string, reload: () => void): void {
    // Quitting: the window is going away, and the quit has stopped the recording itself.
    if (this.quitState !== 'running') return;
    const { capture, logger } = this.options;
    if (this.reloadingAfterCrash) {
      logger.error('the reloaded page crashed before it loaded; not reloading again', { reason });
      this.stopFor('renderer-gone', `it crashed again: ${reason}`);
      return;
    }
    const now = this.now();
    this.recentCrashes = [
      ...this.recentCrashes.filter((at) => now - at < RENDERER_CRASH_WINDOW_MS),
      now,
    ];
    if (this.recentCrashes.length >= RENDERER_CRASH_LIMIT) {
      logger.error('the page keeps crashing; not reloading again', {
        reason,
        crashes: this.recentCrashes.length,
        withinMs: RENDERER_CRASH_WINDOW_MS,
      });
      this.stopFor('renderer-gone', `it kept crashing: ${reason}`);
      return;
    }
    logger.warn('renderer gone; reloading the page', { reason, phase: capture.phase });
    this.reloadingAfterCrash = true;
    try {
      reload();
    } catch (error) {
      logger.error('reload after a renderer crash failed', { reason, error: errorMessage(error) });
      this.stopFor('renderer-gone', errorMessage(error));
    }
  }

  /**
   * The page finished loading: a later crash is a new one, and reloads again unless the page keeps
   * crashing (RENDERER_CRASH_LIMIT).
   */
  onPageLoaded(): void {
    this.reloadingAfterCrash = false;
  }

  /**
   * A page load failed. A main-frame failure leaves no page to capture the mic, whichever reload it
   * was (a crash's, or one someone asked for): stop with `renderer-gone`. ERR_ABORTED is a load
   * another load replaced (two quick reloads) or one that was cancelled: the page carries on.
   */
  onPageLoadFailed({ errorCode, errorDescription, isMainFrame }: PageLoadFailure): void {
    if (!isMainFrame || errorCode === ERR_ABORTED) return;
    this.reloadingAfterCrash = false;
    this.options.logger.warn('page failed to load', { errorCode, errorDescription });
    this.stopFor(
      'renderer-gone',
      errorDescription === '' ? `error ${errorCode}` : errorDescription,
    );
  }

  /**
   * True once a quit was requested (before-quit, will-quit or the tray's Quit through app.quit()),
   * and for good. The main window's close handler hides the window unless this is true
   * (app/windowLifecycle.ts). Read there because only this class knows a quit is under way (its
   * `quitState` is private, and no other before-quit listener may exist, see `quitHooks`).
   *
   * Trap: never derive this from the window's own events. The close that `app.quit()` sends after
   * the stop must not be turned into a hide: the hide cancels the quit and Roger never exits.
   */
  get quitting(): boolean {
    return this.quitState !== 'running';
  }

  private async stopThenQuit(): Promise<void> {
    const { capture, logger, quitStopTimeoutMs, quitHooks, quit } = this.options;
    const phase = capture.phase;
    if (phase !== 'idle') logger.warn('stopping the recording', { reason: 'quit', phase });
    try {
      // No upload flush on quit: lines are safe in SQLite and the uploader resumes next launch.
      await withTimeout(
        capture.stop({ flushUploads: false, reason: 'quit' }),
        quitStopTimeoutMs,
        'stop on quit',
      );
    } catch (error) {
      logger.error('stop on quit did not finish; quitting anyway', {
        error: errorMessage(error),
      });
    }
    for (const hook of quitHooks) await this.runQuitHook(hook);
    this.quitState = 'done';
    quit();
  }

  private async runQuitHook(hook: QuitHook): Promise<void> {
    try {
      // Inside the try: a hook that throws synchronously is caught like one that rejects.
      await withTimeout(Promise.resolve(hook.run()), hook.timeoutMs, `quit hook "${hook.name}"`);
    } catch (error) {
      this.options.logger.error('cleanup on quit failed', {
        hook: hook.name,
        error: errorMessage(error),
      });
    }
  }
}

export interface QuitEvent {
  preventDefault(): void;
}

/** The parts of Electron's `app` this needs. */
export interface AppEventSources {
  app: { on(event: 'before-quit' | 'will-quit', listener: (event: QuitEvent) => void): unknown };
}

/** The parts of the main BrowserWindow this needs. */
export interface WindowEventSource {
  on(event: 'closed', listener: () => void): unknown;
  readonly webContents: {
    on(
      event: 'render-process-gone',
      listener: (event: unknown, details: { reason: string }) => void,
    ): unknown;
    on(event: 'did-finish-load', listener: () => void): unknown;
    on(
      event: 'did-fail-load',
      listener: (
        event: unknown,
        errorCode: number,
        errorDescription: string,
        validatedURL: string,
        isMainFrame: boolean,
      ) => void,
    ): unknown;
    reload(): void;
    isDestroyed(): boolean;
  };
}

export function watchApp(lifecycle: RecordingLifecycle, { app }: AppEventSources): void {
  const onQuit = (event: QuitEvent): void => {
    if (lifecycle.onQuitRequested()) event.preventDefault();
  };
  app.on('before-quit', onQuit);
  // Also here: a quit that skipped before-quit must still stop first.
  app.on('will-quit', onQuit);
  // No stop on `suspend` any more (M2-T18): power/PowerCoordinator.ts, in the T18 slot of
  // capture/createCaptureRuntime.ts, owns sleep and wake. It finishes and closes both sessions at
  // suspend (asleep, Roger cannot close anything, and a socket left half-open bills), so a stop
  // here would only split a call the lid interrupted into two meetings. Never add a second
  // powerMonitor listener here: two owners would each decide the same sleep.
}

export function watchWindow(lifecycle: RecordingLifecycle, window: WindowEventSource): void {
  const { webContents } = window;
  // `closed`, never `close`: with close-hides (M5-T11) a click on the red button fires `close` and
  // then hides the window, and a hide must keep recording. The window is gone only when it was
  // really closed, which happens while quitting. app/windowLifecycle.ts holds the hide.
  window.on('closed', () => {
    lifecycle.stopFor('window-closed');
  });
  webContents.on('render-process-gone', (_event, details) => {
    // A renderer that goes with its destroyed window needs no reload: the close stopped it.
    if (webContents.isDestroyed()) return;
    lifecycle.onRendererGone(details.reason, () => {
      webContents.reload();
    });
  });
  webContents.on('did-finish-load', () => {
    lifecycle.onPageLoaded();
  });
  webContents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
    lifecycle.onPageLoadFailed({ errorCode, errorDescription, isMainFrame });
  });
  // No stop on a reload (`did-start-loading`) any more, M2-T12: the reloaded page reopens the mic
  // because main is recording, and G2 closes the mic's session if no chunk comes for 30 s. While
  // that stop existed, renderer/src/app/router.ts kept the shell's route out of `location.hash`,
  // because Chromium starts a load on a hash change or a `replaceState`; read its trap note before
  // bringing back any stop on a load.
}
