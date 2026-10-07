import { describe, expect, it, vi } from 'vitest';
import { IpcChannel } from '../../shared/ipc';
import { setupChannels, type SetupStatus } from '../../shared/ipc/setup';
import { ApiClient } from '../api/ApiClient';
import { createCaptureRuntime } from '../capture/createCaptureRuntime';
import { loadConfig } from '../config';
import type { SenderEvent } from '../ipc/trust';
import { createLogger } from '../logger';
import { SETTINGS_PANES } from '../settingsPanes';
import { InMemoryTranscriptStore } from '../store/InMemoryTranscriptStore';
import { FakeSpeechToText } from '../stt/fake/FakeSpeechToText';
import { TranscriptUploader } from '../upload/TranscriptUploader';

// The shared stand-in (testing/electronRuntimeMock.ts) with the fakes this file asserts on: what
// `[slot M2-T19]`'s ports call when a setup request comes, so no test here asks macOS for anything,
// opens System Settings or relaunches the runner.
const electron = vi.hoisted(() => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/nonexistent/roger-app',
    on: vi.fn(),
    relaunch: vi.fn(),
    quit: vi.fn(),
  },
  shell: { openExternal: vi.fn(() => Promise.resolve()) },
  systemPreferences: {
    getMediaAccessStatus: vi.fn((type: string) => (type === 'microphone' ? 'granted' : 'denied')),
    askForMediaAccess: vi.fn(() => Promise.resolve(true)),
  },
}));
vi.mock('electron', async () =>
  (await import('../testing/electronRuntimeMock')).electronRuntimeMock({
    app: electron.app,
    shell: electron.shell,
    systemPreferences: electron.systemPreferences,
  }),
);

const logger = createLogger({ level: 'error', format: 'json', sink: () => undefined });

function runtimeHarness() {
  const handlers = new Map<string, (event: SenderEvent, payload: unknown) => unknown>();
  const ipcMain = {
    handle: (channel: string, listener: (event: SenderEvent, payload: unknown) => unknown) => {
      handlers.set(channel, listener);
    },
    on: () => undefined,
  };
  const store = new InMemoryTranscriptStore();
  // Port 9 answers nothing on 127.0.0.1: the server rows fail at once, as on a Mac with no API.
  const connection = { baseUrl: 'http://127.0.0.1:9', token: 'test' };
  const api = new ApiClient(connection);
  createCaptureRuntime({
    config: { ...loadConfig({}), apiToken: 'test', sttProviderOverride: 'fake' },
    store,
    api,
    apiConnection: connection,
    uploader: new TranscriptUploader({ store, api, logger }),
    createSpeechToText: () => new FakeSpeechToText(),
    ensureMicrophoneAccess: () => Promise.resolve('granted'),
    startupError: null,
    userData: '/nonexistent/roger-test',
    ipcMain,
    getWindow: () => ({ webContents: { id: 7, send: vi.fn() }, isDestroyed: () => false }),
    logger,
  });
  const invoke = (channel: string, payload?: unknown): Promise<unknown> =>
    Promise.resolve().then(() => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`nothing registered on ${channel}`);
      return handler({ sender: { id: 7 } }, payload);
    });
  return { handlers, invoke };
}

describe('[slot M2-T19] in createCaptureRuntime', () => {
  it('registers every setup channel beside the capture ones', () => {
    const { handlers } = runtimeHarness();
    for (const channel of Object.values(setupChannels)) expect(handlers.has(channel)).toBe(true);
    expect(handlers.has(IpcChannel.CaptureGetStatus)).toBe(true);
  });

  it("answers the Mac's status: Electron's path, so Screen Recording stands for call audio", async () => {
    const { invoke } = runtimeHarness();
    const status = (await invoke(setupChannels.SetupGetStatus)) as SetupStatus;
    expect(status.systemCapture).toBe('electron');
    expect(status.microphone.state).toBe('granted');
    expect(status.screenRecording?.state).toBe('denied');
    expect(status.api.state).toBe('failed');
    // ROGER_STT_PROVIDER=fake: Start asks the API for no token, so neither does the check.
    expect(status.stt.state).toBe('ok');
  }, 15_000);

  it('opens a pane by its link and relaunches, both through Electron', async () => {
    const { invoke } = runtimeHarness();
    await invoke(setupChannels.SetupOpenSettingsPane, { pane: 'screenRecording' });
    expect(electron.shell.openExternal).toHaveBeenCalledWith(SETTINGS_PANES.screenRecording.url);
    await invoke(setupChannels.SetupRelaunch);
    expect(electron.app.relaunch).toHaveBeenCalledTimes(1);
    expect(electron.app.quit).toHaveBeenCalledTimes(1);
  });

  it('posts no test notification on a Mac that supports none, and says so', async () => {
    const { invoke } = runtimeHarness();
    const status = (await invoke(setupChannels.SetupTestNotification)) as SetupStatus;
    expect(status.notifications.state).toBe('failed');
  }, 15_000);
});
