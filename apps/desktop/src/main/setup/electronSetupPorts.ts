import { app, Notification, shell, systemPreferences } from 'electron';
import { type ApiConnection, createApiRequest } from '../api/http';
import type { DesktopConfig } from '../config';
import type { Logger } from '../logger';
import { findHelper } from '../native/helperPath';
import type { NotificationContent } from '../notify/Notifier';
import { readSigningIdentity } from '../signing';
import { STT_VENDORS } from '../stt/registry';
import { checkConnections } from './connectionChecks';
import type { NotificationTestOutcome, SetupPorts } from './PermissionService';
import { playTestSound, probeCommand, runSystemAudioProbe } from './systemAudioProbe';

/**
 * The setup screen's server checks wait at most this long: a person is looking at the screen, and
 * the banner's first-run check waits for the same status (api/http.ts defaults to 10 s).
 */
const SETUP_REQUEST_TIMEOUT_MS = 5_000;

/**
 * How long the test notification waits for macOS to show or refuse it. The first post can raise
 * macOS's "Roger would like to send notifications" dialog, and the answer takes a person.
 */
export const NOTIFICATION_ANSWER_MS = 20_000;

/** The flag the crash monitor relaunches Roger with (native/roger-audio/ParentWatch.swift). */
const RELAUNCHED_FLAG = '--relaunched';

export interface ElectronSetupPortsDeps {
  config: Pick<DesktopConfig, 'apiToken' | 'sttProviderOverride'>;
  apiConnection: ApiConnection;
  logger: Logger;
  /** `process.platform`: only macOS has privacy permissions to read. */
  platform?: NodeJS.Platform;
}

/**
 * The PermissionService's ports on Electron and macOS. Every Electron call happens inside a port,
 * when a setup request comes, never while the runtime is built: the tests that build the whole
 * capture runtime mock `electron` without these members (apps/desktop/CLAUDE.md, "Merged code
 * reads a field another task's test mock lacks").
 */
export function electronSetupPorts(deps: ElectronSetupPortsDeps): SetupPorts {
  const { config, apiConnection, logger } = deps;
  const onMac = (deps.platform ?? process.platform) === 'darwin';
  const request = createApiRequest({ ...apiConnection, timeoutMs: SETUP_REQUEST_TIMEOUT_MS });
  return {
    // Off macOS there is no privacy gate to read, as permissions.ts already assumes.
    mediaAccess: (type) => (onMac ? systemPreferences.getMediaAccessStatus(type) : 'granted'),
    askForMicrophone: () =>
      onMac ? systemPreferences.askForMediaAccess('microphone') : Promise.resolve(true),
    readSigningIdentity: () => readSigningIdentity(process.execPath),
    findHelper: () =>
      findHelper({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appPath: app.getAppPath(),
        env: process.env,
      }),
    probe: (helper) =>
      runSystemAudioProbe({ command: probeCommand(helper), playSound: playTestSound, logger }),
    postTestNotification: (content) => postNotification(content),
    checkConnections: () =>
      checkConnections({
        request,
        baseUrl: apiConnection.baseUrl,
        hasApiToken: Boolean(config.apiToken),
        sttProviderOverride: config.sttProviderOverride,
        isKnownProvider: (provider) => STT_VENDORS.has(provider),
        logger,
      }),
    openExternal: (url) => shell.openExternal(url),
    relaunch: () => {
      // The quit that follows stops a running recording first (lifecycle.ts), so no line is lost.
      app.relaunch({ args: relaunchArgs(process.argv) });
      app.quit();
    },
  };
}

/**
 * The arguments a relaunch passes on: this launch's own, but never `--relaunched`. With no
 * `args`, `app.relaunch()` passes argv on as is, and a Roger the crash monitor had relaunched
 * would pass the flag on again: M2-T23's CrashRecovery would read the setup screen's relaunch as
 * one after a crash, and resume a meeting nobody is in.
 */
export function relaunchArgs(argv: readonly string[]): string[] {
  return argv.slice(1).filter((arg) => arg !== RELAUNCHED_FLAG);
}

/**
 * Posts one notification and answers what macOS did with it. Its own post, not the Notifier's
 * (notify/Notifier.ts): that one hears only `failed`, and on a build macOS does not trust
 * `UNUserNotificationCenter` can fail with no event at all, so "no failure" would read as shown
 * on exactly the Mac where nothing showed. Here only `show` counts as shown.
 */
export function postNotification(
  content: NotificationContent,
  waitMs: number = NOTIFICATION_ANSWER_MS,
): Promise<NotificationTestOutcome> {
  if (!Notification.isSupported()) {
    return Promise.resolve({
      kind: 'failed',
      error: 'this Mac does not support notifications for Roger',
    });
  }
  return new Promise((resolve) => {
    // Referenced by its listeners until it answers, so it is not collected with them before then.
    const notification = new Notification({ title: content.title, body: content.body });
    let answered = false;
    const answer = (outcome: NotificationTestOutcome): void => {
      if (answered) return;
      answered = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      answer({ kind: 'no-answer' });
    }, waitMs);
    notification.on('show', () => {
      answer({ kind: 'shown' });
    });
    notification.on('failed', (_event, error) => {
      answer({ kind: 'failed', error });
    });
    notification.show();
  });
}
