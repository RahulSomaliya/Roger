import { resolve } from 'node:path';
import type { DesktopCapturer, SystemPreferences } from 'electron';
import type { Logger } from './logger';

/**
 * The Electron smoke test's mode (M2-T13, `e2e/capture.e2e.ts` through `e2e/harness.ts`): Roger
 * runs as itself on Chromium's fake microphone, the fake helper (`native/helperPath.ts`) and the
 * fake STT, in a data folder of its own, and never raises a macOS prompt. Launched by an agent,
 * the responsible process for a TCC prompt is the terminal or Electron.app, so the real gate
 * (`permissions.ts`, `askForMediaAccess`) would hang the run on a dialog nobody answers.
 *
 * On only when `ROGER_E2E=1` (exactly "1") in an unpackaged build: an installed Roger.app keeps
 * its TCC gate and its data whatever its environment says. `helperPath.ts` picks the fake helper
 * by the same rule; keep the two in step (`e2eMode.test.ts` checks they agree).
 *
 * Trap: `[slot M2-T13]` in index.ts reads `ROGER_E2E` before `loadDevEnv` fills `ROGER_*` keys
 * from the repo's `.env`, and helperPath.ts reads it after. Set it in the launch's environment,
 * never in `.env`: from there it would run the fake helper beside the real microphone, the real
 * data folder and the real TCC gate.
 */

export interface E2eModeContext {
  /** `app.isPackaged`. */
  isPackaged: boolean;
  /** `process.env`; only `ROGER_E2E` is read. */
  env: Readonly<Record<string, string | undefined>>;
  /** `app.commandLine.getSwitchValue('user-data-dir')`: '' when the run passed none. */
  userDataDirSwitch: string;
  /** Makes a fresh, empty folder (`mkdtempSync` under the temp folder). Only called when on. */
  makeTemporaryDir: () => string;
}

export type E2eMode =
  | { on: false }
  | {
      on: true;
      /** Absolute. Every file Roger keeps goes here: roger.sqlite, config.json, audio, prefs. */
      userData: string;
      /** `switch`: the run named it (`--user-data-dir`), and reads it after. */
      userDataFrom: 'switch' | 'temporary';
    };

/**
 * Chromium switches every e2e run gets, however it was launched (the harness passes them too):
 * the fake microphone and camera in place of the Mac's own, which raise no TCC prompt, and a mock
 * keychain, so cookie encryption never asks for the login keychain. Appended before `ready`, they
 * reach the audio service, which starts later.
 */
export const E2E_CHROMIUM_SWITCHES: readonly string[] = [
  'use-fake-device-for-media-stream',
  'use-mock-keychain',
];

export function resolveE2eMode(context: E2eModeContext): E2eMode {
  if (context.isPackaged || context.env.ROGER_E2E !== '1') return { on: false };
  if (context.userDataDirSwitch !== '') {
    // Against the folder the run started in, as Chromium resolves the switch itself.
    return { on: true, userData: resolve(context.userDataDirSwitch), userDataFrom: 'switch' };
  }
  return { on: true, userData: context.makeTemporaryDir(), userDataFrom: 'temporary' };
}

/** The Electron objects e2e mode changes, as narrowly as it uses them (tests pass fakes). */
export interface E2eElectron {
  app: {
    setPath(name: 'userData', path: string): void;
    readonly commandLine: { appendSwitch(name: string, value?: string): void };
  };
  systemPreferences: Pick<SystemPreferences, 'getMediaAccessStatus' | 'askForMediaAccess'>;
  desktopCapturer: Pick<DesktopCapturer, 'getSources'>;
  Notification: { isSupported: () => boolean };
}

export class E2eModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'E2eModeError';
  }
}

/**
 * Puts this process in e2e mode; does nothing when off. Call it before the single-instance lock
 * and before anything reads userData (`[slot M2-T13]` in index.ts).
 *
 * Every macOS prompt Roger can raise is answered here instead, so none can reach the Mac:
 * - The TCC gate: the microphone reads as granted (Chromium's fake device needs no grant), the
 *   camera and the screen as denied, and `askForMediaAccess` rejects without asking.
 * - Screen Recording: `desktopCapturer.getSources` rejects. Call audio comes from the fake helper;
 *   Electron's fallback path would raise the prompt, so a run that falls back fails visibly.
 * - Notifications: unsupported, so the Notifier badges the dock instead of asking to post.
 */
export function enterE2eMode(mode: E2eMode, electron: E2eElectron, logger: Logger): void {
  if (!mode.on) return;
  const { app, systemPreferences, desktopCapturer, Notification } = electron;
  app.setPath('userData', mode.userData);
  for (const name of E2E_CHROMIUM_SWITCHES) app.commandLine.appendSwitch(name);

  systemPreferences.getMediaAccessStatus = (mediaType) => {
    const answer = mediaType === 'microphone' ? 'granted' : 'denied';
    logger.info('media access answered without asking macOS', { mediaType, answer });
    return answer;
  };
  systemPreferences.askForMediaAccess = (mediaType) => {
    logger.error('refused to ask macOS for media access', { mediaType });
    return Promise.reject(
      new E2eModeError(
        `e2e mode never asks macOS for ${mediaType} access (ROGER_E2E=1): the run would hang on the prompt`,
      ),
    );
  };
  desktopCapturer.getSources = (options) => {
    logger.error('refused to capture the screen', { types: options.types });
    return Promise.reject(
      new E2eModeError(
        'e2e mode never captures the screen (ROGER_E2E=1): call audio comes from the fake helper, and Screen Recording would prompt',
      ),
    );
  };
  Notification.isSupported = () => false;

  logger.info('e2e mode on', {
    userData: mode.userData,
    userDataFrom: mode.userDataFrom,
    chromiumSwitches: E2E_CHROMIUM_SWITCHES,
    mediaAccess: 'microphone granted without asking; camera and screen denied',
    notifications: 'off',
  });
}
