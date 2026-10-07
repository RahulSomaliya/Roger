import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { idleCaptureStatus, type CapturePhase, type CaptureStatus } from '../../shared/capture';
import { RecordingLifecycle, watchApp, watchWindow } from '../lifecycle';
import { createLogger } from '../logger';
import {
  hideOnClose,
  keepRunningWithoutWindows,
  revealOnReopen,
  revealWindow,
  showWhenReady,
} from './windowLifecycle';

/** A BrowserWindow as windowLifecycle.ts sees it: events plus the calls it makes. */
function fakeWindow() {
  const window = Object.assign(new EventEmitter(), {
    visible: false,
    minimized: false,
    focused: false,
    destroyed: false,
    show: () => {
      window.visible = true;
    },
    hide: () => {
      window.visible = false;
    },
    focus: () => {
      window.focused = true;
    },
    restore: () => {
      window.minimized = false;
    },
    isMinimized: () => window.minimized,
    isDestroyed: () => window.destroyed,
    webContents: Object.assign(new EventEmitter(), {
      reload: () => undefined,
      isDestroyed: () => false,
    }),
  });
  return window;
}

/** What a click on the red button does: `close` with a preventDefault, then the close unless stopped. */
function clickClose(window: ReturnType<typeof fakeWindow>): { prevented: boolean } {
  const event = {
    prevented: false,
    preventDefault: () => {
      event.prevented = true;
    },
  };
  window.emit('close', event);
  if (!event.prevented) window.emit('closed');
  return event;
}

function lifecycleHarness(phase: CapturePhase = 'recording') {
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
  const stops: (string | undefined)[] = [];
  const quits: string[] = [];
  const app = Object.assign(new EventEmitter(), {
    quit: () => {
      // Electron's app.quit(): before-quit first; when nothing prevents it, the windows close.
      const event = { prevented: false, preventDefault: () => (event.prevented = true) };
      app.emit('before-quit', event);
      if (event.prevented) return;
      quits.push('closing windows');
      app.emit('close-all-windows');
    },
  });
  const lifecycle = new RecordingLifecycle({
    capture: {
      get phase() {
        return status.phase;
      },
      stop: (options) => {
        stops.push(options.reason);
        status.phase = 'idle';
        return Promise.resolve(status);
      },
    },
    logger: createLogger({ level: 'error', format: 'json', sink: () => undefined }),
    quitStopTimeoutMs: 1_000,
    quitHooks: [],
    quit: () => {
      app.quit();
    },
  });
  watchApp(lifecycle, { app });
  return { app, lifecycle, stops, quits };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('close hides the window', () => {
  it('hides it instead of closing it, and the recording keeps going', () => {
    const h = lifecycleHarness();
    const window = fakeWindow();
    window.visible = true;
    watchWindow(h.lifecycle, window);
    hideOnClose(window, h.lifecycle);

    const close = clickClose(window);

    expect(close.prevented).toBe(true);
    expect(window.visible).toBe(false);
    // The landed G4 stop is on the window's real close, which a hide never reaches.
    expect(h.stops).toEqual([]);
  });

  it('hides again after being shown again: closing is never a one-off', () => {
    const h = lifecycleHarness('idle');
    const window = fakeWindow();
    hideOnClose(window, h.lifecycle);
    for (let times = 0; times < 3; times += 1) {
      window.show();
      expect(clickClose(window).prevented).toBe(true);
      expect(window.visible).toBe(false);
    }
  });

  it('lets a close through while quitting, so Cmd+Q with the window open quits', async () => {
    const h = lifecycleHarness();
    const window = fakeWindow();
    window.visible = true;
    watchWindow(h.lifecycle, window);
    hideOnClose(window, h.lifecycle);
    let closed = 0;
    window.on('closed', () => (closed += 1));
    // What Electron does when app.quit() goes through: it closes every window.
    h.app.on('close-all-windows', () => {
      clickClose(window);
    });

    // Cmd+Q: before-quit is prevented while the recording stops, then RecordingLifecycle quits
    // again and the windows close. A close turned into a hide here would cancel that quit.
    const first = { prevented: false, preventDefault: () => (first.prevented = true) };
    h.app.emit('before-quit', first);
    expect(first.prevented).toBe(true);
    await flush();

    expect(h.stops).toEqual(['quit']);
    expect(h.quits).toEqual(['closing windows']);
    // Really closed, not hidden: a hide here would have left the app running after Cmd+Q.
    expect(closed).toBe(1);
    expect(window.visible).toBe(true);
  });

  it('hides the window of a quit that has not been requested yet', () => {
    const h = lifecycleHarness();
    const window = fakeWindow();
    hideOnClose(window, h.lifecycle);
    expect(h.lifecycle.quitting).toBe(false);
    expect(clickClose(window).prevented).toBe(true);
  });
});

describe('keepRunningWithoutWindows', () => {
  it('does not quit when the last window goes', () => {
    let quits = 0;
    const app = Object.assign(new EventEmitter(), {
      quit: () => {
        quits += 1;
      },
    });
    keepRunningWithoutWindows(app);
    app.emit('window-all-closed');
    expect(quits).toBe(0);
    expect(app.listenerCount('window-all-closed')).toBe(1);
  });
});

describe('the first show', () => {
  it('shows the window once the page can be drawn on an ordinary launch', () => {
    const window = fakeWindow();
    showWhenReady(window, { openedAtLogin: false });
    expect(window.visible).toBe(false);
    window.emit('ready-to-show');
    expect(window.visible).toBe(true);
  });

  it('shows it once: a window the user hid is not shown again by a later load', () => {
    const window = fakeWindow();
    showWhenReady(window, { openedAtLogin: false });
    window.emit('ready-to-show');
    window.hide();
    window.emit('ready-to-show');
    expect(window.visible).toBe(false);
  });

  it('keeps the window hidden on a launch at login, where Roger only needs to be running', () => {
    const window = fakeWindow();
    showWhenReady(window, { openedAtLogin: true });
    window.emit('ready-to-show');
    expect(window.visible).toBe(false);
  });
});

describe('reopening shows the window', () => {
  it('shows a hidden window on activate (a Dock click) and focuses it', () => {
    const window = fakeWindow();
    const app = new EventEmitter();
    revealOnReopen(app, () => window);
    app.emit('activate');
    expect(window.visible).toBe(true);
    expect(window.focused).toBe(true);
  });

  it('shows it for a second launch of the app, which the single-instance lock turns away', () => {
    const window = fakeWindow();
    const app = new EventEmitter();
    revealOnReopen(app, () => window);
    app.emit('second-instance');
    expect(window.visible).toBe(true);
  });

  it('restores a minimized window', () => {
    const window = fakeWindow();
    window.minimized = true;
    revealWindow(window);
    expect(window.minimized).toBe(false);
    expect(window.visible).toBe(true);
  });

  it('does nothing without a window, or with one that was destroyed', () => {
    const app = new EventEmitter();
    let window: ReturnType<typeof fakeWindow> | null = null;
    revealOnReopen(app, () => window);
    app.emit('activate');
    window = fakeWindow();
    window.destroyed = true;
    app.emit('activate');
    expect(window.visible).toBe(false);
  });
});
