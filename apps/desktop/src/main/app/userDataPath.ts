import { join } from 'node:path';

/**
 * The data folder of a build that is not packaged (`make dev-desktop`): "Roger Dev", beside the
 * installed app's "Roger" under `~/Library/Application Support`.
 *
 * Why: `productName` is "Roger" in a dev build too, so both used the same `userData`. Electron keys
 * the single-instance lock on `userData`, so with Roger.app always running in the menu bar a dev
 * run quit at once ("a second copy"), and where it did start, the two copies shared roger.sqlite
 * and calendar.sqlite. Set before `app.requestSingleInstanceLock()` in index.ts (the lock reads
 * the folder when it is taken: set after it, the lock stays on the old folder), and before any
 * module reads `app.getPath('userData')`.
 */
export const DEV_USER_DATA_FOLDER = 'Roger Dev';

/** What Electron derives from `productName` for a packaged build; only named here for the test. */
export const PACKAGED_USER_DATA_FOLDER = 'Roger';

export interface UserDataContext {
  /** `app.isPackaged`. */
  isPackaged: boolean;
  /** `e2e.on` from main/e2eMode.ts. */
  e2eOn: boolean;
  /** `app.commandLine.hasSwitch('user-data-dir')`. */
  userDataSwitch: boolean;
  /** `app.getPath('appData')`. */
  appData: string;
}

/**
 * The folder to set as `userData`, or null to leave Electron's. Null for a packaged build (its
 * "Roger" is Electron's own), for the e2e run (M2-T13 gave it a folder of its own: a dev folder
 * here would put the smoke test's config.json and databases in the developer's) and when the launch
 * passed `--user-data-dir`, which Electron honours by itself from the first line of main (Electron
 * 44, checked 2026-10-07): overriding it would move a run its caller pointed elsewhere.
 */
export function userDataOverride(context: UserDataContext): string | null {
  if (context.isPackaged || context.e2eOn || context.userDataSwitch) return null;
  return join(context.appData, DEV_USER_DATA_FOLDER);
}
