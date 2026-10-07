import type { RecordingLifecycle } from '../lifecycle';

/**
 * Roger keeps running without its window (M5): closing the window hides it, so the page, its
 * microphone capture and the calendar reminders go on (the window is created with
 * `backgroundThrottling: false`, window.ts), and Roger lives in the menu bar (tray.ts). Only a
 * quit (Cmd+Q, the app menu, the tray's Quit) ends it. This file holds those decisions with no
 * Electron import, so they test under Node; window.ts and index.ts connect Electron's objects.
 */

/** The parts of the main BrowserWindow these helpers use. Electron's BrowserWindow fits. */
export interface MainWindowLike {
  on(event: 'close', listener: (event: { preventDefault(): void }) => void): unknown;
  once(event: 'ready-to-show', listener: () => void): unknown;
  show(): void;
  hide(): void;
  focus(): void;
  restore(): void;
  isMinimized(): boolean;
  isDestroyed(): boolean;
}

/**
 * Closing the window hides it, unless a quit is under way.
 *
 * Trap: `lifecycle.quitting`, not a flag of this file's own. The close that `app.quit()` sends to
 * every window after the recording has stopped must go through; turned into a hide it cancels the
 * quit and Roger never exits (Cmd+Q does nothing). Only RecordingLifecycle knows a quit is under
 * way (src/main/lifecycle.ts `quitting`). Never stop the recording from here either: its G4 stop
 * is on the window's `closed` (watchWindow), which a hide never reaches, so a hidden window keeps
 * recording. Both rules are tested in windowLifecycle.test.ts and lifecycle.test.ts.
 */
export function hideOnClose(
  window: Pick<MainWindowLike, 'on' | 'hide'>,
  lifecycle: Pick<RecordingLifecycle, 'quitting'>,
): void {
  window.on('close', (event) => {
    if (lifecycle.quitting) return;
    event.preventDefault();
    window.hide();
  });
}

/**
 * Shows the window the first time its page can be drawn, except on a launch at login: there Roger
 * only needs to be running, and a window in the user's face at every boot is what they turn the
 * login item off for. `openedAtLogin` is `app.getLoginItemSettings().wasOpenedAtLogin`; macOS 13+
 * has no `openAsHidden`, so this is the only way to know. A build that cannot tell reads false and
 * shows the window, which is cosmetic (docs/plans/M5-calendar.md, "Roger keeps running").
 */
export function showWhenReady(
  window: Pick<MainWindowLike, 'once' | 'show'>,
  { openedAtLogin }: { openedAtLogin: boolean },
): void {
  // Once: a window hidden on purpose must not pop up again if a later load fires it again.
  window.once('ready-to-show', () => {
    if (!openedAtLogin) window.show();
  });
}

/** Brings the window forward from the menu bar, the Dock, or a second launch of the app. */
export function revealWindow(
  window: Pick<MainWindowLike, 'show' | 'focus' | 'restore' | 'isMinimized'>,
): void {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

/** The parts of Electron's `app` the helpers below listen on. */
export interface AppEvents {
  on(event: 'activate' | 'second-instance' | 'window-all-closed', listener: () => void): unknown;
}

/**
 * A click on Roger's Dock icon (`activate`) or a second launch of the app (`second-instance`,
 * which index.ts's single-instance lock turns away) shows the window: with close-hides it is
 * usually hidden, and a click that shows nothing reads as a dead app. `getWindow` is null before
 * the window exists and after it closed (only while quitting).
 */
export function revealOnReopen(
  app: AppEvents,
  getWindow: () => Pick<
    MainWindowLike,
    'show' | 'focus' | 'restore' | 'isMinimized' | 'isDestroyed'
  > | null,
): void {
  const reveal = (): void => {
    const window = getWindow();
    if (window === null || window.isDestroyed()) return;
    revealWindow(window);
  };
  app.on('activate', reveal);
  app.on('second-instance', reveal);
}

/**
 * The last window closing no longer quits the app. Registering a handler is what stops Electron's
 * default (quit); with close-hides the event only comes when the window is destroyed while a quit
 * is already under way, and app.quit() finishes by itself then.
 */
export function keepRunningWithoutWindows(app: AppEvents): void {
  app.on('window-all-closed', () => {
    // Nothing: the menu bar item and the next reminder need Roger running.
  });
}
