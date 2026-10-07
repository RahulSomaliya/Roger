import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CapturePhase, type CaptureStatus, idleCaptureStatus } from '../shared/capture';
import type { StopOptions } from './capture/CaptureService';
import { createLogger } from './logger';
import {
  type QuitHook,
  RENDERER_CRASH_LIMIT,
  RENDERER_CRASH_WINDOW_MS,
  RecordingLifecycle,
  watchApp,
  watchWindow,
} from './lifecycle';

function fakeCapture(phase: CapturePhase = 'recording') {
  const status: CaptureStatus = {
    ...idleCaptureStatus({
      state: 'idle',
      pending: 0,
      rejected: 0,
      lastError: null,
      nextAttemptAt: null,
    }),
    phase,
  };
  let finish: () => void = () => undefined;
  const capture = {
    stops: [] as StopOptions[],
    /** When false, stop() never settles, like a vendor that never answers. */
    settles: true,
    /** When false, the phase stays as it was, so every event below still finds a recording. */
    idleAfterStop: true,
    get phase(): CapturePhase {
      return status.phase;
    },
    stop: (options: StopOptions): Promise<CaptureStatus> => {
      capture.stops.push(options);
      return new Promise((resolve) => {
        finish = () => {
          if (capture.idleAfterStop) status.phase = 'idle';
          resolve(status);
        };
        if (capture.settles) finish();
      });
    },
    finish: () => {
      finish();
    },
  };
  return capture;
}

function harness(phase: CapturePhase = 'recording') {
  const capture = fakeCapture(phase);
  const lines: string[] = [];
  const order: string[] = [];
  /** The lifecycle's monotonic clock, moved by the test. */
  const clock = { ms: 0 };
  const lifecycle = new RecordingLifecycle({
    capture,
    logger: createLogger({ level: 'info', format: 'json', sink: (line) => lines.push(line) }),
    now: () => clock.ms,
    quitStopTimeoutMs: 5_000,
    quitHooks: [
      {
        name: 'beforeExit',
        timeoutMs: 1_000,
        run: () => {
          order.push('beforeExit');
        },
      },
    ],
    quit: () => order.push('quit'),
  });
  return { capture, lines, order, lifecycle, clock };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('RecordingLifecycle on quit', () => {
  it('holds the quit, stops the recording through the normal path, then lets the app go', async () => {
    const h = harness();
    expect(h.lifecycle.onQuitRequested()).toBe(true); // the caller prevents this quit
    expect(h.capture.stops).toEqual([{ flushUploads: false, reason: 'quit' }]);
    expect(h.lifecycle.onQuitRequested()).toBe(true); // a second Cmd+Q while stopping waits too
    await flush();

    expect(h.order).toEqual(['beforeExit', 'quit']);
    expect(h.capture.stops).toHaveLength(1);
    expect(h.lifecycle.onQuitRequested()).toBe(false); // the quit it started goes through
  });

  describe('when the stop hangs', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('quits after the bounded wait anyway: process exit closes the sockets', async () => {
      const h = harness();
      h.capture.settles = false;
      h.lifecycle.onQuitRequested();
      await vi.advanceTimersByTimeAsync(4_900);
      expect(h.order).toEqual([]);

      await vi.advanceTimersByTimeAsync(200);
      expect(h.order).toEqual(['beforeExit', 'quit']);
      expect(h.lines.some((line) => line.includes('stop on quit did not finish'))).toBe(true);
    });
  });

  it('still quits when the cleanup throws', async () => {
    const capture = fakeCapture();
    const order: string[] = [];
    const lifecycle = new RecordingLifecycle({
      capture,
      logger: createLogger({ level: 'error', format: 'json', sink: () => undefined }),
      quitStopTimeoutMs: 5_000,
      quitHooks: [
        {
          name: 'close the store',
          timeoutMs: 1_000,
          run: () => {
            throw new Error('database is not open');
          },
        },
      ],
      quit: () => order.push('quit'),
    });
    lifecycle.onQuitRequested();
    await flush();
    expect(order).toEqual(['quit']);
  });
});

/** A lifecycle whose quit records the stop, each hook and the quit in one list, in order. */
function quitHarness(hooks: (order: string[]) => QuitHook[]) {
  const capture = fakeCapture();
  const stop = capture.stop;
  const order: string[] = [];
  const lines: string[] = [];
  let quitted: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    quitted = resolve;
  });
  capture.stop = (options) => {
    order.push('stop');
    return stop(options);
  };
  const lifecycle = new RecordingLifecycle({
    capture,
    logger: createLogger({ level: 'info', format: 'json', sink: (line) => lines.push(line) }),
    quitStopTimeoutMs: 5_000,
    quitHooks: hooks(order),
    quit: () => {
      order.push('quit');
      quitted();
    },
  });
  return { capture, lifecycle, order, lines, done };
}

describe('RecordingLifecycle quit hooks', () => {
  it('runs after the stop, in list order, each awaited, then quits', async () => {
    const h = quitHarness((order) => [
      {
        name: 'flush the notes',
        timeoutMs: 1_000,
        run: async () => {
          await flush(); // an async hook is awaited before the next one starts
          order.push('flush the notes');
        },
      },
      {
        name: 'close the store',
        timeoutMs: 1_000,
        run: () => {
          order.push('close the store');
        },
      },
    ]);
    h.lifecycle.onQuitRequested();
    await h.done;
    expect(h.order).toEqual(['stop', 'flush the notes', 'close the store', 'quit']);
  });

  it('logs a hook that throws or rejects, and still runs the next ones and quits', async () => {
    const h = quitHarness((order) => [
      {
        name: 'throws',
        timeoutMs: 1_000,
        run: () => {
          throw new Error('database is not open');
        },
      },
      {
        name: 'rejects',
        timeoutMs: 1_000,
        run: () => Promise.reject(new Error('window is gone')),
      },
      {
        name: 'close the store',
        timeoutMs: 1_000,
        run: () => {
          order.push('close the store');
        },
      },
    ]);
    h.lifecycle.onQuitRequested();
    await h.done;
    expect(h.order).toEqual(['stop', 'close the store', 'quit']);
    const failures = h.lines.filter((line) => line.includes('cleanup on quit failed'));
    expect(failures).toHaveLength(2);
    expect(failures[0]).toContain('"hook":"throws"');
    expect(failures[0]).toContain('database is not open');
    expect(failures[1]).toContain('"hook":"rejects"');
    expect(failures[1]).toContain('window is gone');
  });

  describe('when a hook hangs', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('cuts it at its own bound and goes on to the next hook and the quit', async () => {
      const h = quitHarness((order) => [
        {
          name: 'flush the notes',
          timeoutMs: 1_000,
          run: () => new Promise<void>(() => undefined),
        },
        {
          name: 'close the store',
          timeoutMs: 1_000,
          run: () => {
            order.push('close the store');
          },
        },
      ]);
      h.lifecycle.onQuitRequested();
      await vi.advanceTimersByTimeAsync(900);
      expect(h.order).toEqual(['stop']);

      await vi.advanceTimersByTimeAsync(200);
      expect(h.order).toEqual(['stop', 'close the store', 'quit']);
      const failure = h.lines.find((line) => line.includes('cleanup on quit failed'));
      expect(failure).toContain('"hook":"flush the notes"');
      expect(failure).toContain('timed out after 1000 ms');
    });
  });
});

describe('RecordingLifecycle once quitting', () => {
  it('leaves the other events to the quit: its cleanup has closed the store by then', async () => {
    const h = harness();
    h.capture.idleAfterStop = false;
    h.lifecycle.onQuitRequested();
    await flush(); // stopped, store closed, app.quit() called: now the window closes
    h.lifecycle.stopFor('window-closed');
    h.lifecycle.stopFor('renderer-gone');
    expect(h.capture.stops).toEqual([{ flushUploads: false, reason: 'quit' }]);
  });
});

describe('RecordingLifecycle.quitting', () => {
  // The window's close handler hides the window unless a quit is under way, and only this class
  // knows that (its quit state is private; nothing else may listen for before-quit). Without the
  // getter the close that app.quit() sends after the stop would be turned into a hide, which
  // cancels the quit: Roger never exits (M5-T11, app/windowLifecycle.ts).
  it('is false until a quit is requested, and true from then on', async () => {
    const h = harness();
    expect(h.lifecycle.quitting).toBe(false);
    h.lifecycle.onQuitRequested();
    expect(h.lifecycle.quitting).toBe(true);
    await flush();
    expect(h.order).toEqual(['beforeExit', 'quit']);
    expect(h.lifecycle.quitting).toBe(true);
  });

  it('stays false for a crash, a reload and a window close, which are not quits', () => {
    const h = watched();
    h.window.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    h.window.emit('closed');
    expect(h.lifecycle.quitting).toBe(false);
  });
});

describe('RecordingLifecycle.stopFor', () => {
  it('stops a recording through the normal path with its reason, and logs why', () => {
    const h = harness();
    h.lifecycle.stopFor('window-closed');
    expect(h.capture.stops).toEqual([{ flushUploads: false, reason: 'window-closed' }]);
    expect(h.lines.some((line) => line.includes('"reason":"window-closed"'))).toBe(true);
  });

  it('stops one still starting too, once it has started', () => {
    const h = harness('starting');
    h.lifecycle.stopFor('window-closed');
    expect(h.capture.stops).toHaveLength(1);
  });

  it('does nothing when nothing records', () => {
    const h = harness('idle');
    h.lifecycle.stopFor('renderer-gone');
    expect(h.capture.stops).toEqual([]);
  });
});

/** The main window as watchWindow sees it: its events, and the reloads it was asked for. */
function fakeWindow() {
  const webContents = Object.assign(new EventEmitter(), {
    reloads: 0,
    destroyed: false,
    /** When set, reload() throws it, as Electron does for a destroyed webContents. */
    reloadError: null as Error | null,
    reload: () => {
      if (webContents.reloadError !== null) throw webContents.reloadError;
      webContents.reloads += 1;
    },
    isDestroyed: () => webContents.destroyed,
  });
  return Object.assign(new EventEmitter(), { webContents });
}

/** Electron's did-fail-load arguments after the event: code, description, URL, main frame. */
function failLoad(
  window: ReturnType<typeof fakeWindow>,
  errorCode: number,
  errorDescription: string,
  isMainFrame = true,
): void {
  window.webContents.emit(
    'did-fail-load',
    {},
    errorCode,
    errorDescription,
    'file:///index.html',
    isMainFrame,
  );
}

function watched(phase: CapturePhase = 'recording') {
  const h = harness(phase);
  h.capture.idleAfterStop = false;
  const window = fakeWindow();
  watchWindow(h.lifecycle, window);
  const stops = () => h.capture.stops.map((stop) => [stop.reason, stop.detail]);
  return { ...h, window, stops };
}

describe('the Electron events', () => {
  it('maps quit and the window really closing to a stop', () => {
    const h = harness();
    h.capture.idleAfterStop = false;
    const app = new EventEmitter();
    const window = fakeWindow();
    watchApp(h.lifecycle, { app });
    watchWindow(h.lifecycle, window);

    window.emit('closed');
    let prevented = 0;
    app.emit('before-quit', { preventDefault: () => (prevented += 1) });
    app.emit('will-quit', { preventDefault: () => (prevented += 1) });

    expect(prevented).toBe(2);
    expect(h.capture.stops.map((stop) => [stop.reason, stop.detail])).toEqual([
      ['window-closed', undefined],
      ['quit', undefined],
    ]);
  });

  it('never stops the recording for a hide: a close the window turned into a hide is not a close (M5-T11)', () => {
    const h = watched();
    // The window's close handler (app/windowLifecycle.ts) prevents the close and hides, so the
    // window lives on and `closed` never comes; only the `close` event does.
    h.window.emit('close', { preventDefault: () => undefined });
    h.window.emit('hide');
    expect(h.stops()).toEqual([]);
    expect(h.window.listenerCount('close')).toBe(0);
  });

  it('stops once the window is really closed', () => {
    const h = watched();
    h.window.emit('closed');
    expect(h.stops()).toEqual([['window-closed', undefined]]);
  });

  it('leaves sleep to PowerCoordinator: a suspend no longer stops the recording (M2-T18)', () => {
    const h = harness();
    const app = new EventEmitter();
    const powerMonitor = new EventEmitter();
    // index.ts handed watchApp the powerMonitor until M2-T18; one still passed must stay unheard,
    // or a lid closed for a minute splits the call into two meetings.
    const sources = { app, powerMonitor };
    watchApp(h.lifecycle, sources);

    powerMonitor.emit('suspend');
    expect(h.capture.stops).toEqual([]);
    expect(powerMonitor.listenerCount('suspend')).toBe(0);
  });
});

describe('a renderer crash or a reload while recording (M2 D7)', () => {
  it('reloads the page after a crash, and the recording goes on', () => {
    const h = watched();
    h.window.webContents.emit('render-process-gone', {}, { reason: 'oom' });

    expect(h.window.webContents.reloads).toBe(1);
    expect(h.stops()).toEqual([]);
    const reloading = h.lines.find((line) => line.includes('reloading the page'));
    expect(reloading).toContain('"reason":"oom"');
  });

  it('reloads a crashed page while nothing records too, so the window is never left dead', () => {
    const h = watched('idle');
    h.window.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    expect(h.window.webContents.reloads).toBe(1);
    expect(h.stops()).toEqual([]);
  });

  it('does not stop on a reload: the reloaded page reopens the mic because main records', () => {
    const h = watched();
    h.window.webContents.emit('did-start-loading');
    h.window.webContents.emit('did-finish-load');
    expect(h.stops()).toEqual([]);
  });

  it('stops with renderer-gone when the page does not load, saying why', () => {
    const h = watched();
    h.window.webContents.emit('render-process-gone', {}, { reason: 'oom' });
    failLoad(h.window, -6, 'ERR_FILE_NOT_FOUND');
    expect(h.stops()).toEqual([['renderer-gone', 'ERR_FILE_NOT_FOUND']]);
  });

  it('stops when a reload someone asked for fails too: no page captures the mic', () => {
    const h = watched();
    h.window.webContents.emit('did-start-loading');
    failLoad(h.window, -102, 'ERR_CONNECTION_REFUSED');
    expect(h.stops()).toEqual([['renderer-gone', 'ERR_CONNECTION_REFUSED']]);
  });

  it('ignores a load another load replaced (ERR_ABORTED) and a failing subframe', () => {
    const h = watched();
    failLoad(h.window, -3, 'ERR_ABORTED');
    failLoad(h.window, -6, 'ERR_FILE_NOT_FOUND', false);
    expect(h.stops()).toEqual([]);
  });

  it('stops instead of reloading again when the reloaded page crashes before it loads', () => {
    const h = watched();
    h.window.webContents.emit('render-process-gone', {}, { reason: 'oom' });
    h.window.webContents.emit('render-process-gone', {}, { reason: 'launch-failed' });

    // A renderer that dies on load would otherwise reload forever.
    expect(h.window.webContents.reloads).toBe(1);
    expect(h.stops()).toEqual([['renderer-gone', 'it crashed again: launch-failed']]);
  });

  it('reloads again after a later crash once the last reload loaded', () => {
    const h = watched();
    h.window.webContents.emit('render-process-gone', {}, { reason: 'oom' });
    h.window.webContents.emit('did-finish-load');
    h.window.webContents.emit('render-process-gone', {}, { reason: 'oom' });
    expect(h.window.webContents.reloads).toBe(2);
    expect(h.stops()).toEqual([]);
  });

  it('stops instead of reloading when the loaded page keeps crashing', () => {
    // The page opens the mic only after it loads, so a crash in the capture path or the recording
    // view comes after did-finish-load. Each cycle sends a few chunks, so G2's stall close never
    // fires, and without this the window would reload every second or two until the 4-hour cap.
    const h = watched();
    for (let crash = 1; crash < RENDERER_CRASH_LIMIT; crash += 1) {
      h.window.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
      h.clock.ms += 1_000;
      h.window.webContents.emit('did-finish-load');
      h.clock.ms += 1_000;
    }
    h.window.webContents.emit('render-process-gone', {}, { reason: 'crashed' });

    expect(h.window.webContents.reloads).toBe(RENDERER_CRASH_LIMIT - 1);
    expect(h.stops()).toEqual([['renderer-gone', 'it kept crashing: crashed']]);
  });

  it('keeps reloading crashes spread wider than the window', () => {
    const h = watched();
    const gap = RENDERER_CRASH_WINDOW_MS / (RENDERER_CRASH_LIMIT - 1) + 1;
    for (let crash = 0; crash < RENDERER_CRASH_LIMIT * 2; crash += 1) {
      h.window.webContents.emit('render-process-gone', {}, { reason: 'oom' });
      h.window.webContents.emit('did-finish-load');
      h.clock.ms += gap;
    }
    expect(h.window.webContents.reloads).toBe(RENDERER_CRASH_LIMIT * 2);
    expect(h.stops()).toEqual([]);
  });

  it('stops with renderer-gone when the reload itself throws', () => {
    const h = watched();
    h.window.webContents.reloadError = new Error('Object has been destroyed');
    h.window.webContents.emit('render-process-gone', {}, { reason: 'oom' });
    expect(h.stops()).toEqual([['renderer-gone', 'Object has been destroyed']]);
  });

  it('leaves a renderer that goes with its window alone: the close or the quit stopped it', async () => {
    const closed = watched();
    closed.window.webContents.destroyed = true;
    closed.window.webContents.emit('render-process-gone', {}, { reason: 'clean-exit' });
    expect(closed.window.webContents.reloads).toBe(0);
    expect(closed.stops()).toEqual([]);

    const quitting = watched();
    quitting.lifecycle.onQuitRequested();
    await flush();
    quitting.window.webContents.emit('render-process-gone', {}, { reason: 'clean-exit' });
    expect(quitting.window.webContents.reloads).toBe(0);
    expect(quitting.stops()).toEqual([['quit', undefined]]);
  });
});
