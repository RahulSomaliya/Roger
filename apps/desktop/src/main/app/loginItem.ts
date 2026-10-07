import type { OpenAtLogin } from '../../shared/calendarPrefs';
import type { LoginItemState } from '../../shared/ipc/loginItem';
import { errorMessage, type Logger } from '../logger';
import {
  decideLoginItem,
  type LoginItemBuild,
  loginItemStatusFor,
  type MacLoginStatus,
} from './loginItemPolicy';

/** The parts of Electron's `app` this uses. */
export interface LoginItemApp {
  getLoginItemSettings(): { status: MacLoginStatus };
  setLoginItemSettings(settings: { openAtLogin: boolean }): void;
}

export interface LoginItemOptions {
  app: LoginItemApp;
  build: LoginItemBuild;
  /** The preference `app.openAtLogin`, read each time (PreferencesStore.get). */
  preference: () => OpenAtLogin;
  logger: Logger;
}

/**
 * Keeps macOS's login item as the preference `app.openAtLogin` and the calendar connection say
 * (loginItemPolicy.ts decides), and tells the page what macOS made of it. Call `start` once, then
 * `preferenceChanged` and `setCalendarConnected` when those change; each re-checks and acts only
 * when macOS's answer differs from what is wanted.
 *
 * A build that is not packaged, and the e2e run, never reach `app` (loginItemPolicy.ts says why).
 */
export class LoginItemController {
  private calendarConnected = false;
  private lastStatus: LoginItemState['status'] | null = null;
  private readonly listeners = new Set<(state: LoginItemState) => void>();

  constructor(private readonly options: LoginItemOptions) {}

  /** Applies the preference as it stands at launch (a login item the user turned on is repaired). */
  start(): void {
    // What the page may already have been told: macOS's answer before this launch changes it.
    this.lastStatus = this.getState().status;
    this.apply();
  }

  /** The preference `app.openAtLogin` was set. */
  preferenceChanged(): void {
    this.apply();
  }

  /** A calendar account was connected or disconnected (CalendarAccount.onConnectionChange). */
  setCalendarConnected(connected: boolean): void {
    this.calendarConnected = connected;
    this.apply();
  }

  getState(): LoginItemState {
    const { build } = this.options;
    if (!build.isPackaged || build.e2eOn) return { status: 'unavailable' };
    return { status: loginItemStatusFor(build, this.options.app.getLoginItemSettings().status) };
  }

  onChange(listener: (state: LoginItemState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private apply(): void {
    const { app, build, preference, logger } = this.options;
    if (!build.isPackaged || build.e2eOn) return;
    const action = decideLoginItem({
      ...build,
      preference: preference(),
      calendarConnected: this.calendarConnected,
      macStatus: app.getLoginItemSettings().status,
    });
    if (action !== 'leave') {
      try {
        app.setLoginItemSettings({ openAtLogin: action === 'register' });
        logger.info('login item changed', { action });
      } catch (error) {
        // Callers are event handlers with nobody to tell: the log carries what was asked, and the
        // page reads the unchanged state below (Settings shows it as off).
        logger.error('login item change failed', { action, error: errorMessage(error) });
      }
    }
    const state = this.getState();
    if (state.status === this.lastStatus) return;
    this.lastStatus = state.status;
    for (const listener of [...this.listeners]) listener(state);
  }
}
