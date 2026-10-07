import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SystemPreferences } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import {
  type E2eElectron,
  type E2eMode,
  type E2eModeContext,
  E2E_CHROMIUM_SWITCHES,
  enterE2eMode,
  resolveE2eMode,
} from './e2eMode';
import { createLogger, type Logger } from './logger';
import { helperLocation } from './native/helperPath';
import { ensureMicrophoneAccess } from './permissions';

// permissions.ts reads Electron's systemPreferences: here it is a fake that would ask, and counts
// every time the real question would have reached macOS.
const tcc = vi.hoisted(() => {
  const asked: string[] = [];
  const systemPreferences: Pick<SystemPreferences, 'getMediaAccessStatus' | 'askForMediaAccess'> = {
    getMediaAccessStatus: () => 'not-determined',
    askForMediaAccess: (mediaType) => {
      asked.push(mediaType);
      return Promise.resolve(true);
    },
  };
  return { asked, electron: { systemPreferences } };
});
vi.mock('electron', () => tcc.electron);

const USER_DATA = '/private/tmp/roger-e2e-run/user-data';

function context(overrides: Partial<E2eModeContext> = {}): E2eModeContext {
  return {
    isPackaged: false,
    env: { ROGER_E2E: '1' },
    userDataDirSwitch: USER_DATA,
    makeTemporaryDir: () => {
      throw new Error('this run names its folder; none should be made');
    },
    ...overrides,
  };
}

const ON: E2eMode = { on: true, userData: USER_DATA, userDataFrom: 'switch' };

/** What the real Electron would have been asked: each count is a call that reached the Mac. */
interface ElectronCalls {
  userData: string[];
  switches: string[];
  statusAsked: string[];
  accessAsked: string[];
  screenAsked: number;
}

function fakeElectron(): { electron: E2eElectron; calls: ElectronCalls } {
  const calls: ElectronCalls = {
    userData: [],
    switches: [],
    statusAsked: [],
    accessAsked: [],
    screenAsked: 0,
  };
  const electron: E2eElectron = {
    app: {
      setPath: (name, path) => {
        calls.userData.push(`${name}=${path}`);
      },
      commandLine: {
        appendSwitch: (name, value) => {
          calls.switches.push(value === undefined ? name : `${name}=${value}`);
        },
      },
    },
    systemPreferences: {
      getMediaAccessStatus: (mediaType) => {
        calls.statusAsked.push(mediaType);
        return 'not-determined';
      },
      askForMediaAccess: (mediaType) => {
        calls.accessAsked.push(mediaType);
        return Promise.resolve(true);
      },
    },
    desktopCapturer: {
      getSources: () => {
        calls.screenAsked += 1;
        return Promise.resolve([]);
      },
    },
    Notification: { isSupported: () => true },
  };
  return { electron, calls };
}

function recordingLogger(): { logger: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    level: 'debug',
    format: 'json',
    sink: (line) => {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    },
  });
  return { logger, lines };
}

describe('resolveE2eMode', () => {
  it('turns on for ROGER_E2E=1 in an unpackaged build', () => {
    expect(resolveE2eMode(context())).toEqual(ON);
  });

  it.each([undefined, '0', 'true', 'yes', '', ' 1', '1 '])(
    'stays off for ROGER_E2E=%j',
    (value) => {
      expect(resolveE2eMode(context({ env: { ROGER_E2E: value } }))).toEqual({ on: false });
    },
  );

  // An installed Roger.app keeps the real TCC gate and the real data folder, whatever its
  // environment says: e2e mode would otherwise be a switch that turns off the privacy prompt.
  it('stays off in a packaged build', () => {
    expect(resolveE2eMode(context({ isPackaged: true }))).toEqual({ on: false });
  });

  // helperPath.ts runs the fake helper under the same rule. Out of step, a run would record the
  // real Mac with the fake call audio, or the fake helper with the real data folder and TCC gate.
  it('keeps the rule helperPath.ts uses for the fake helper', () => {
    for (const isPackaged of [false, true]) {
      for (const value of [undefined, '1', '0', 'true', '', ' 1']) {
        const env = { ROGER_E2E: value };
        const fakeHelper =
          helperLocation({
            isPackaged,
            resourcesPath: '/Applications/Roger.app/Contents/Resources',
            appPath: '/Users/someone/Roger/apps/desktop',
            env,
          }).origin === 'e2e-fake';
        expect(resolveE2eMode(context({ isPackaged, env })).on, `${isPackaged} ${value}`).toBe(
          fakeHelper,
        );
      }
    }
  });

  it('keeps user data in the folder --user-data-dir names', () => {
    expect(resolveE2eMode(context({ userDataDirSwitch: 'runs/one' }))).toEqual({
      on: true,
      // Resolved as Chromium resolves the switch: against the folder the run started in.
      userData: resolve('runs/one'),
      userDataFrom: 'switch',
    });
  });

  it('makes one fresh folder when the run names none', () => {
    const made: string[] = [];
    const mode = resolveE2eMode(
      context({
        userDataDirSwitch: '',
        makeTemporaryDir: () => {
          made.push('/private/tmp/roger-e2e-abc123');
          return '/private/tmp/roger-e2e-abc123';
        },
      }),
    );
    expect(mode).toEqual({
      on: true,
      userData: '/private/tmp/roger-e2e-abc123',
      userDataFrom: 'temporary',
    });
    expect(made).toHaveLength(1);
  });

  it('makes no folder when off', () => {
    expect(
      resolveE2eMode(context({ env: {}, userDataDirSwitch: '' })), // makeTemporaryDir throws
    ).toEqual({ on: false });
  });
});

describe('enterE2eMode', () => {
  it('changes nothing when off', () => {
    const { electron, calls } = fakeElectron();
    const before = { ...electron.systemPreferences, ...electron.desktopCapturer };
    const { logger, lines } = recordingLogger();
    enterE2eMode({ on: false }, electron, logger);
    expect(calls).toEqual({
      userData: [],
      switches: [],
      statusAsked: [],
      accessAsked: [],
      screenAsked: 0,
    });
    expect(electron.systemPreferences.getMediaAccessStatus).toBe(before.getMediaAccessStatus);
    expect(electron.systemPreferences.askForMediaAccess).toBe(before.askForMediaAccess);
    expect(electron.desktopCapturer.getSources).toBe(before.getSources);
    expect(electron.Notification.isSupported()).toBe(true);
    expect(lines).toEqual([]);
  });

  // Before the single-instance lock, which locks that folder, and before anything reads it: a run
  // must never touch the Roger data of the Mac it runs on (unpackaged, that is Roger.app's own).
  it('moves user data to the run folder', () => {
    const { electron, calls } = fakeElectron();
    enterE2eMode(ON, electron, recordingLogger().logger);
    expect(calls.userData).toEqual([`userData=${USER_DATA}`]);
  });

  it("uses Chromium's fake media devices and a mock keychain", () => {
    const { electron, calls } = fakeElectron();
    enterE2eMode(ON, electron, recordingLogger().logger);
    expect(calls.switches).toEqual(['use-fake-device-for-media-stream', 'use-mock-keychain']);
    expect(E2E_CHROMIUM_SWITCHES).toEqual(calls.switches);
  });

  it('answers microphone access as granted without asking macOS', () => {
    const { electron, calls } = fakeElectron();
    const { logger, lines } = recordingLogger();
    enterE2eMode(ON, electron, logger);
    expect(electron.systemPreferences.getMediaAccessStatus('microphone')).toBe('granted');
    expect(calls.statusAsked).toEqual([]);
    expect(lines).toContainEqual(
      expect.objectContaining({
        message: 'media access answered without asking macOS',
        mediaType: 'microphone',
        answer: 'granted',
      }),
    );
  });

  // Chromium fakes the microphone only. Nothing in a run needs the camera or the screen, and a
  // "granted" there would lead code to a real capture and its prompt.
  it.each(['camera', 'screen'] as const)('answers %s access as denied', (mediaType) => {
    const { electron, calls } = fakeElectron();
    enterE2eMode(ON, electron, recordingLogger().logger);
    expect(electron.systemPreferences.getMediaAccessStatus(mediaType)).toBe('denied');
    expect(calls.statusAsked).toEqual([]);
  });

  it('refuses to ask macOS for media access, loudly', async () => {
    const { electron, calls } = fakeElectron();
    const { logger, lines } = recordingLogger();
    enterE2eMode(ON, electron, logger);
    await expect(electron.systemPreferences.askForMediaAccess('microphone')).rejects.toThrow(
      /e2e mode never asks macOS for microphone access/,
    );
    expect(calls.accessAsked).toEqual([]);
    expect(lines).toContainEqual(
      expect.objectContaining({ level: 'error', message: 'refused to ask macOS for media access' }),
    );
  });

  it('refuses to capture the screen, loudly', async () => {
    const { electron, calls } = fakeElectron();
    const { logger, lines } = recordingLogger();
    enterE2eMode(ON, electron, logger);
    await expect(electron.desktopCapturer.getSources({ types: ['screen'] })).rejects.toThrow(
      /e2e mode never captures the screen/,
    );
    expect(calls.screenAsked).toBe(0);
    expect(lines).toContainEqual(
      expect.objectContaining({ level: 'error', message: 'refused to capture the screen' }),
    );
  });

  // Electron posts through UNUserNotificationCenter, whose first post asks the person to allow
  // notifications: a prompt an unattended run must never raise.
  it('turns notifications off', () => {
    const { electron } = fakeElectron();
    enterE2eMode(ON, electron, recordingLogger().logger);
    expect(electron.Notification.isSupported()).toBe(false);
  });

  it('says it is on, and where the data goes', () => {
    const { electron } = fakeElectron();
    const { logger, lines } = recordingLogger();
    enterE2eMode(ON, electron, logger);
    expect(lines[0]).toMatchObject({
      level: 'info',
      message: 'e2e mode on',
      userData: USER_DATA,
      userDataFrom: 'switch',
    });
  });
});

describe('the TCC gate in e2e mode', () => {
  // The gate itself (permissions.ts), not a copy: a run that reaches askForMediaAccess hangs on a
  // dialog for the terminal or Electron.app (the M2 design's "Renderer tests" row).
  it('lets Start through without asking macOS', async () => {
    const { electron } = fakeElectron();
    enterE2eMode(
      ON,
      { ...electron, systemPreferences: tcc.electron.systemPreferences },
      recordingLogger().logger,
    );
    await expect(ensureMicrophoneAccess('darwin')).resolves.toBe('granted');
    expect(tcc.asked).toEqual([]);
  });
});

describe('the M2-T13 slot in index.ts', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const at = (text: string): number => {
    const index = source.indexOf(text);
    if (index === -1) throw new Error(`index.ts has no ${text}`);
    return index;
  };

  // In its own slot: after M5-T11's "Roger Dev" folder it would run after that slot chose user
  // data, and after the lock or loadDevEnv the real folder would already be locked and read.
  it('enters e2e mode in its slot, before M5-T11 picks user data', () => {
    const entered = at('enterE2eMode(');
    expect(entered).toBeGreaterThan(at('// [slot M2-T13]'));
    expect(entered).toBeLessThan(at('// [slot M5-T11 userData]'));
    expect(entered).toBeLessThan(at('app.requestSingleInstanceLock()'));
  });
});
