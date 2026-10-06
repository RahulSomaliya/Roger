import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CapturePhase, type CaptureStatus, idleCaptureStatus } from '../shared/capture';
import type { StopOptions } from './capture/CaptureService';
import { createLogger } from './logger';
import { type QuitHook, RecordingLifecycle, watchApp, watchWindow } from './lifecycle';

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
  const lifecycle = new RecordingLifecycle({
    capture,
    logger: createLogger({ level: 'info', format: 'json', sink: (line) => lines.push(line) }),
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
  return { capture, lines, order, lifecycle };
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
    h.lifecycle.stopFor('system-sleep');
    expect(h.capture.stops).toEqual([{ flushUploads: false, reason: 'quit' }]);
  });
});

describe('RecordingLifecycle.stopFor', () => {
  it('stops a recording through the normal path with its reason, and logs why', () => {
    const h = harness();
    h.lifecycle.stopFor('system-sleep');
    expect(h.capture.stops).toEqual([{ flushUploads: false, reason: 'system-sleep' }]);
    expect(h.lines.some((line) => line.includes('"reason":"system-sleep"'))).toBe(true);
  });

  it('stops one still starting too, once it has started', () => {
    const h = harness('starting');
    h.lifecycle.stopFor('window-closed');
    expect(h.capture.stops).toHaveLength(1);
  });

  it('does nothing when nothing records', () => {
    const h = harness('idle');
    h.lifecycle.stopFor('page-reloaded');
    expect(h.capture.stops).toEqual([]);
  });
});

describe('the Electron events', () => {
  it('maps quit, sleep, the window closing, a crash and a reload to a stop', () => {
    const h = harness();
    h.capture.idleAfterStop = false;
    const app = new EventEmitter();
    const powerMonitor = new EventEmitter();
    const window = Object.assign(new EventEmitter(), { webContents: new EventEmitter() });
    watchApp(h.lifecycle, { app, powerMonitor });
    watchWindow(h.lifecycle, window);

    powerMonitor.emit('suspend');
    window.emit('close');
    window.webContents.emit('render-process-gone', {}, { reason: 'oom' });
    window.webContents.emit('did-start-loading');
    let prevented = 0;
    app.emit('before-quit', { preventDefault: () => (prevented += 1) });
    app.emit('will-quit', { preventDefault: () => (prevented += 1) });

    expect(prevented).toBe(2);
    expect(h.capture.stops.map((stop) => [stop.reason, stop.detail])).toEqual([
      ['system-sleep', undefined],
      ['window-closed', undefined],
      ['renderer-gone', 'oom'],
      ['page-reloaded', undefined],
      ['quit', undefined],
    ]);
  });
});
