import { basename } from 'node:path';
import type { CallApp } from '../../shared/calendar';

/**
 * Which processes that hold the mic are a call (M2 D6): an allowlist, never a deny-list, so Voice
 * Memos, dictation and a dev tool never offer a recording. The monitor helper lists every process
 * with audio input running (native/roger-audio/Monitor.swift, `mic_users`); this file reads that
 * list and says which of them are a call app. Pure: MeetingAppMonitor feeds it, CallDetector
 * (M2-T17b) times what it returns.
 */

/**
 * Roger's own bundle id: `appId` in electron-builder.yml, which the helper's relaunch command names
 * too (ParentWatch.swift's RelaunchCommand). callApps.test.ts checks the first; change all three
 * together.
 */
export const ROGER_BUNDLE_ID = 'ai.linkt.roger';

/** One row of the monitor's `mic_users` (Monitor.swift): a process with audio input running. */
export interface MicUser {
  pid: number;
  /** The outermost `.app`'s CFBundleIdentifier; null for a process outside any app bundle. */
  bundleId: string | null;
  /** The `.app` folder, or the executable for a process outside an app. */
  path: string;
  name: string;
}

/**
 * - `native`: an app made for calls, offered after 5 s of mic use.
 * - `browser`: a browser, a weaker signal (any tab may hold the mic), offered after 15 s and
 *   auto-stopped after 30 s of release (M2 D6).
 */
export type CallAppKind = 'native' | 'browser';

/** A call app seen using the mic. `CallApp` is what the prompt card and the status carry on. */
export interface DetectedCallApp extends CallApp {
  kind: CallAppKind;
}

const FACETIME_BUNDLE_ID = 'com.apple.FaceTime';
const SAFARI_BUNDLE_ID = 'com.apple.Safari';

const NATIVE_APPS: ReadonlyMap<string, string> = new Map([
  ['us.zoom.xos', 'Zoom'],
  ['com.microsoft.teams2', 'Microsoft Teams'],
  ['com.microsoft.teams', 'Microsoft Teams'],
  ['com.tinyspeck.slackmacgap', 'Slack'],
  ['Cisco-Systems.Spark', 'Webex'],
  ['com.cisco.webexmeetingsapp', 'Webex'],
  ['com.webex.meetingmanager', 'Webex'],
  [FACETIME_BUNDLE_ID, 'FaceTime'],
]);

const BROWSERS: ReadonlyMap<string, string> = new Map([
  ['com.google.Chrome', 'Google Chrome'],
  ['com.google.Chrome.beta', 'Google Chrome Beta'],
  ['com.google.Chrome.canary', 'Google Chrome Canary'],
  [SAFARI_BUNDLE_ID, 'Safari'],
  ['com.apple.SafariTechnologyPreview', 'Safari Technology Preview'],
  ['org.mozilla.firefox', 'Firefox'],
  ['com.microsoft.edgemac', 'Microsoft Edge'],
  ['com.brave.Browser', 'Brave'],
  ['company.thebrowser.Browser', 'Arc'],
  ['com.operasoftware.Opera', 'Opera'],
  ['com.vivaldi.Vivaldi', 'Vivaldi'],
]);

/**
 * FaceTime audio and phone calls run in daemons with no `.app` around them (anarlog's
 * `APPLE_CALL_DAEMON_IDS`), so the monitor lists them by executable. Matched on the executable's
 * name, which is the same wherever the system keeps the file.
 */
const FACETIME_DAEMONS: ReadonlySet<string> = new Set(['avconferenced', 'callservicesd']);

/**
 * Safari's mic use shows as WebKit's GPU process, never as Safari (Monitor.swift's header): its
 * entitlements carry the host app's Microphone grant. Matched by `name`, never by `path`: the
 * helper reads the path under /System/Volumes/Preboot/Cryptexes/OS/ and `ps` shows another one.
 *
 * Trap: every app that hosts WebKit runs its own GPU process and nothing ties one to its app, so
 * this cannot tell Safari from another WebKit app (a mail client rendering a call link): it reads
 * them all as Safari. Which WebKit process holds the mic in a real Safari call is unverified (the
 * M2-T22 exit check on a Mac).
 */
const WEBKIT_GPU_NAME = 'com.apple.WebKit.GPU';

/** The call app a mic user is, or null for any other process (Roger's own excluded by the caller). */
function resolveCallApp(user: MicUser): DetectedCallApp | null {
  if (user.bundleId !== null) {
    const native = NATIVE_APPS.get(user.bundleId);
    if (native !== undefined) return { bundleId: user.bundleId, name: native, kind: 'native' };
    const browser = BROWSERS.get(user.bundleId);
    if (browser !== undefined) return { bundleId: user.bundleId, name: browser, kind: 'browser' };
    return null;
  }
  if (FACETIME_DAEMONS.has(basename(user.path)) || FACETIME_DAEMONS.has(user.name)) {
    return { bundleId: FACETIME_BUNDLE_ID, name: 'FaceTime or phone call', kind: 'native' };
  }
  if (user.name === WEBKIT_GPU_NAME) {
    return { bundleId: SAFARI_BUNDLE_ID, name: 'Safari', kind: 'browser' };
  }
  return null;
}

/**
 * The call apps among `users`, each once (Chrome runs several processes), in the order the monitor
 * lists them (by pid). Roger's own processes never count, by pid (`ownPids`: main, the renderer,
 * the GPU and utility processes) and by bundle: its renderer holds the mic for the whole
 * recording, and a Roger that counted itself would offer a recording that is already running and
 * keep auto-stop from ever seeing the call end.
 */
export function detectCallApps(
  users: readonly MicUser[],
  ownPids: ReadonlySet<number>,
): DetectedCallApp[] {
  const found = new Map<string, DetectedCallApp>();
  for (const user of users) {
    if (ownPids.has(user.pid) || user.bundleId === ROGER_BUNDLE_ID) continue;
    const callApp = resolveCallApp(user);
    if (callApp !== null && !found.has(callApp.bundleId)) found.set(callApp.bundleId, callApp);
  }
  return [...found.values()];
}
