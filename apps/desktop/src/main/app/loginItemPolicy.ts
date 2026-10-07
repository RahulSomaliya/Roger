import type { OpenAtLogin } from '../../shared/calendarPrefs';
import type { LoginItemStatus } from '../../shared/ipc/loginItem';

/**
 * Whether Roger is a login item, decided with no Electron import so it tests under Node
 * (loginItem.ts calls Electron). The user's choice is the preference `app.openAtLogin`:
 * - `on`: register
 * - `off`: never
 * - `auto`: register while a calendar is connected (the first connect turns it on; nothing the
 *   user said is overridden, since a choice moves the preference off `auto`)
 * It ships defaulting to `off` until real-Mac check 1 in docs/plans/M5-calendar.md passes
 * (src/shared/calendarPrefs.ts says why).
 */

/** `app.getLoginItemSettings().status` (macOS 13+). */
export type MacLoginStatus = 'not-registered' | 'enabled' | 'requires-approval' | 'not-found';

export interface LoginItemBuild {
  /** `app.isPackaged`. */
  isPackaged: boolean;
  /** `e2e.on` from main/e2eMode.ts. */
  e2eOn: boolean;
}

export interface LoginItemWorld extends LoginItemBuild {
  preference: OpenAtLogin;
  /** A calendar account is connected. */
  calendarConnected: boolean;
  macStatus: MacLoginStatus;
}

/**
 * What to do with the login item now: register it, remove it, or leave it.
 *
 * Trap: a build that is not packaged never registers, and nothing here ever calls Electron for it,
 * not even to remove. `app.setLoginItemSettings` in a dev run registers Electron.app, which then
 * starts at every login with no Roger in it. The e2e run is the same case twice over: macOS
 * answers a registration with a "background item added" notice nobody can dismiss in a harness.
 * Both are tested in loginItemPolicy.test.ts, and loginItem.ts asks this before it touches `app`.
 */
export function decideLoginItem(world: LoginItemWorld): 'register' | 'unregister' | 'leave' {
  if (!world.isPackaged || world.e2eOn) return 'leave';
  const wanted =
    world.preference === 'on' || (world.preference === 'auto' && world.calendarConnected);
  // `requires-approval` is registered: asking again changes nothing, and each ask is a call into
  // a macOS service that can raise the "background item added" notice again.
  const registered = world.macStatus === 'enabled' || world.macStatus === 'requires-approval';
  if (wanted) return registered ? 'leave' : 'register';
  return registered ? 'unregister' : 'leave';
}

/** What Settings is told: macOS's answer, or `unavailable` for a build that never registers. */
export function loginItemStatusFor(build: LoginItemBuild, mac: MacLoginStatus): LoginItemStatus {
  if (!build.isPackaged || build.e2eOn) return 'unavailable';
  switch (mac) {
    case 'enabled':
      return 'enabled';
    case 'requires-approval':
      return 'requires-approval';
    case 'not-registered':
      return 'disabled';
    case 'not-found':
      return 'unavailable';
  }
}
