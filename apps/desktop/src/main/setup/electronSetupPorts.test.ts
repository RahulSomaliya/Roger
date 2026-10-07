import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config';
import { createLogger } from '../logger';
import { electronSetupPorts, postNotification, relaunchArgs } from './electronSetupPorts';

// Every Electron call the ports make, faked: no test here opens System Settings, asks macOS for
// anything, posts a notification or relaunches the test runner.
const electron = vi.hoisted(() => {
  class FakeNotification {
    static supported = true;
    static made: FakeNotification[] = [];
    static isSupported(): boolean {
      return FakeNotification.supported;
    }
    private readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>();
    shown = 0;
    constructor(readonly options: { title: string; body: string }) {
      FakeNotification.made.push(this);
    }
    on(event: string, listener: (...args: unknown[]) => void): this {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
      return this;
    }
    show(): void {
      this.shown += 1;
    }
    /** What macOS does: tells the notification it was shown, or why it was not. */
    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) listener(...args);
    }
  }
  return {
    FakeNotification,
    app: {
      isPackaged: false,
      getAppPath: () => '/nonexistent/roger-app',
      relaunch: vi.fn(),
      quit: vi.fn(),
    },
    shell: { openExternal: vi.fn(() => Promise.resolve()) },
    systemPreferences: {
      getMediaAccessStatus: vi.fn(() => 'denied'),
      askForMediaAccess: vi.fn(() => Promise.resolve(false)),
    },
  };
});
vi.mock('electron', () => ({
  app: electron.app,
  shell: electron.shell,
  systemPreferences: electron.systemPreferences,
  Notification: electron.FakeNotification,
}));

const logger = createLogger({ level: 'error', format: 'json', sink: () => undefined });
const CONTENT = { title: 'Roger can reach you', body: 'A test.' };

beforeEach(() => {
  electron.FakeNotification.supported = true;
  electron.FakeNotification.made = [];
});

describe('relaunchArgs', () => {
  it("passes this launch's arguments on, but never the crash monitor's --relaunched", () => {
    // app.relaunch() with no args passes argv on as is, flag included: CrashRecovery (M2-T23)
    // would read a relaunch from the setup screen as one after a crash, and resume a meeting.
    expect(relaunchArgs(['/Applications/Roger.app/Contents/MacOS/Roger', '--relaunched'])).toEqual(
      [],
    );
    expect(relaunchArgs(['/path/Electron', '/repo/apps/desktop', '--inspect=9229'])).toEqual([
      '/repo/apps/desktop',
      '--inspect=9229',
    ]);
  });
});

describe('postNotification', () => {
  it('answers shown once macOS shows it', async () => {
    const answer = postNotification(CONTENT, 1_000);
    const [made] = electron.FakeNotification.made;
    expect(made?.options).toEqual(CONTENT);
    expect(made?.shown).toBe(1);
    made?.emit('show');
    await expect(answer).resolves.toEqual({ kind: 'shown' });
  });

  it("answers failed with macOS's reason", async () => {
    const answer = postNotification(CONTENT, 1_000);
    electron.FakeNotification.made[0]?.emit('failed', {}, 'not allowed');
    await expect(answer).resolves.toEqual({ kind: 'failed', error: 'not allowed' });
  });

  it('answers no-answer when macOS says nothing within the wait', async () => {
    await expect(postNotification(CONTENT, 20)).resolves.toEqual({ kind: 'no-answer' });
  });

  it('answers failed without posting on a Mac that supports none', async () => {
    electron.FakeNotification.supported = false;
    await expect(postNotification(CONTENT, 1_000)).resolves.toEqual({
      kind: 'failed',
      error: 'this Mac does not support notifications for Roger',
    });
    expect(electron.FakeNotification.made).toEqual([]);
  });
});

describe('electronSetupPorts', () => {
  const config = { ...loadConfig({}), apiToken: 'token' };
  const connection = { baseUrl: 'http://127.0.0.1:9', token: 'token' };

  it('reads media access from macOS, and treats every other platform as granted', () => {
    const mac = electronSetupPorts({
      config,
      apiConnection: connection,
      logger,
      platform: 'darwin',
    });
    expect(mac.mediaAccess('microphone')).toBe('denied');
    expect(electron.systemPreferences.getMediaAccessStatus).toHaveBeenCalledWith('microphone');
    const linux = electronSetupPorts({
      config,
      apiConnection: connection,
      logger,
      platform: 'linux',
    });
    expect(linux.mediaAccess('screen')).toBe('granted');
  });

  it('opens a link through the shell, and relaunches without --relaunched', async () => {
    const ports = electronSetupPorts({ config, apiConnection: connection, logger });
    await ports.openExternal('x-apple.systempreferences:com.apple.preference.security');
    expect(electron.shell.openExternal).toHaveBeenCalledWith(
      'x-apple.systempreferences:com.apple.preference.security',
    );
    const argv = process.argv;
    process.argv = ['/Applications/Roger.app/Contents/MacOS/Roger', '--relaunched'];
    try {
      ports.relaunch();
    } finally {
      process.argv = argv;
    }
    expect(electron.app.relaunch).toHaveBeenCalledWith({ args: [] });
    expect(electron.app.quit).toHaveBeenCalledTimes(1);
  });

  it('finds the helper only where the build keeps it: never in a folder without one', () => {
    const ports = electronSetupPorts({ config, apiConnection: connection, logger });
    expect(ports.findHelper()).toMatchObject({ found: false });
  });
});
