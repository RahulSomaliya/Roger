import type { Unsubscribe } from './unsubscribe';

/**
 * The login item's channels (M5-T11), for the main window's page only: Settings' "Open at login"
 * row and the line after the first calendar connect. Main registers them in
 * src/main/app/loginItemIpc.ts. Add a member here together with its bridge
 * (src/preload/bridges/loginItem.ts) and its preview fake (preview/fakes/loginItem.ts): the type
 * check fails until all three agree.
 *
 * What the user CHOOSES is the preference `app.openAtLogin` (`auto`, `on`, `off`;
 * src/shared/calendarPrefs.ts), read and set through `getPreferences` and `setPreference` like
 * every other setting: a set there reaches main's LoginItemController at once. This feature only
 * reports what macOS did with it, which a preference cannot say (it can be waiting for approval).
 */
export const loginItemChannels = {
  /** renderer → main, invoke */
  LoginItemGetState: 'login-item:get-state',
  /** main → renderer event */
  LoginItemStateChanged: 'login-item:state-changed',
} as const;

/**
 * What macOS says about Roger as a login item.
 * - enabled: Roger opens when the user logs in
 * - disabled: it does not
 * - requires-approval: registered, but the user must allow it in System Settings
 *   (LOGIN_ITEMS_SETTINGS_PATH): until then Roger does not open at login, and reminders for the
 *   first calls of the day are missed
 * - unavailable: this build never registers one: a dev build (Electron.app would be listed at
 *   login, and quit at once against the installed Roger's lock), the e2e run (macOS shows a
 *   "background item added" notice), or macOS cannot find the app (moved, or run from a disk image)
 */
export type LoginItemStatus = 'enabled' | 'disabled' | 'requires-approval' | 'unavailable';

export interface LoginItemState {
  status: LoginItemStatus;
}

/** Where System Settings lists login items to allow, macOS 15 and later. */
export const LOGIN_ITEMS_SETTINGS_PATH = 'System Settings → General → Login Items & Extensions';

/** The login item's part of `window.roger` (types above). */
export interface LoginItemApi {
  /** The state now. Rejects with a message to show when macOS cannot be asked. */
  getLoginItemState(): Promise<LoginItemState>;
  /** The state changed: the preference was set, the calendar connected or disconnected. */
  onLoginItemStateChanged(listener: (state: LoginItemState) => void): Unsubscribe;
}
