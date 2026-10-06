import type { CapturePhase, CaptureStatus } from '../shared/capture';
import type { StopOptions } from './capture/CaptureService';
import type { StopReason } from './capture/stopReasons';
import { errorMessage, type Logger } from './logger';
import { withTimeout } from './util/time';

/**
 * Cost guard G4: whatever ends the app's ability to record (quit, the window closing, the renderer
 * crashing or reloading, the Mac sleeping) stops the recording through the normal stop: finish
 * sequence, last lines saved, sessions closed. Left open, each vendor session bills until a vendor
 * timeout (AssemblyAI: the 120 s idle timeout Roger asks for; without it, the 3-hour cap, $0.45 a
 * stream). The decisions live here and are tested; index.ts only connects Electron's objects.
 */

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

/** The reasons an Electron event stops a recording; the quit has its own path. */
export type LifecycleStopReason = Extract<
  StopReason,
  'window-closed' | 'renderer-gone' | 'page-reloaded' | 'system-sleep'
>;

export class RecordingLifecycle {
  private quitState: 'running' | 'stopping' | 'done' = 'running';

  constructor(private readonly options: RecordingLifecycleOptions) {}

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
    logger.warn('stopping the recording', { reason, detail: detail ?? null });
    // No upload flush: the app may be going away, and the uploader resumes on its own.
    const options: StopOptions =
      detail === undefined
        ? { flushUploads: false, reason }
        : { flushUploads: false, reason, detail };
    capture.stop(options).catch((error: unknown) => {
      logger.error('stop failed', { reason, error: errorMessage(error) });
    });
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

/** The parts of Electron's `app` and `powerMonitor` this needs. */
export interface AppEventSources {
  app: { on(event: 'before-quit' | 'will-quit', listener: (event: QuitEvent) => void): unknown };
  powerMonitor: { on(event: 'suspend', listener: () => void): unknown };
}

/** The parts of the main BrowserWindow this needs. */
export interface WindowEventSource {
  on(event: 'close', listener: () => void): unknown;
  readonly webContents: {
    on(
      event: 'render-process-gone',
      listener: (event: unknown, details: { reason: string }) => void,
    ): unknown;
    on(event: 'did-start-loading', listener: () => void): unknown;
  };
}

export function watchApp(
  lifecycle: RecordingLifecycle,
  { app, powerMonitor }: AppEventSources,
): void {
  const onQuit = (event: QuitEvent): void => {
    if (lifecycle.onQuitRequested()) event.preventDefault();
  };
  app.on('before-quit', onQuit);
  // Also here: a quit that skipped before-quit must still stop first.
  app.on('will-quit', onQuit);
  // Asleep, Roger cannot close anything, and the socket may stay half-open on the vendor's side.
  powerMonitor.on('suspend', () => {
    lifecycle.stopFor('system-sleep');
  });
}

export function watchWindow(lifecycle: RecordingLifecycle, window: WindowEventSource): void {
  window.on('close', () => {
    lifecycle.stopFor('window-closed');
  });
  // The page that captured the audio is gone: no more chunks will come.
  window.webContents.on('render-process-gone', (_event, details) => {
    lifecycle.stopFor('renderer-gone', details.reason);
  });
  // Recording only starts from a loaded page, so any load while recording is a reload or a
  // navigation (will-navigate keeps it on the app's own page) that throws the capture away.
  window.webContents.on('did-start-loading', () => {
    lifecycle.stopFor('page-reloaded');
  });
}
