import { describe, expect, it, vi } from 'vitest';
import { setupChannels, type SetupStatus } from '../../shared/ipc/setup';
import type { IpcMainLike, SenderEvent, TrustedWindow } from '../ipc/trust';
import { createLogger } from '../logger';
import { registerSetupIpc, type SetupActions } from './setupIpc';

const MAIN_PAGE = 7;
const PROMPT_PANEL = 9;

const fine = { state: 'ok', message: null, relaunchNeeded: false } as const;
const STATUS: SetupStatus = {
  microphone: { state: 'granted', message: null, relaunchNeeded: false },
  systemAudio: { state: 'verified', message: null, relaunchNeeded: false },
  systemCapture: 'tap',
  screenRecording: null,
  notifications: { state: 'unknown', message: null, relaunchNeeded: false },
  signing: { state: 'local-identity', message: null, relaunchNeeded: false },
  api: fine,
  stt: fine,
};

type Handler = (event: SenderEvent, payload: unknown) => unknown;

function harness() {
  const handlers = new Map<string, Handler>();
  const ipcMain: IpcMainLike = {
    handle: (channel, listener) => {
      handlers.set(channel, listener);
    },
    on: () => undefined,
  };
  const lines: string[] = [];
  const logger = createLogger({ level: 'debug', format: 'json', sink: (line) => lines.push(line) });
  const service = {
    status: vi.fn(() => Promise.resolve(STATUS)),
    requestMicrophone: vi.fn(() => Promise.resolve(STATUS)),
    testSystemAudio: vi.fn(() => Promise.resolve(STATUS)),
    confirmSystemAudioAllowed: vi.fn(() => Promise.resolve(STATUS)),
    testNotification: vi.fn(() => Promise.resolve(STATUS)),
    openSettingsPane: vi.fn((_pane: string) => Promise.resolve()),
    relaunch: vi.fn(),
  } satisfies SetupActions;
  const window: TrustedWindow = { webContents: { id: MAIN_PAGE } };
  registerSetupIpc({ ipcMain, service, getWindow: () => window, logger });

  /** Like ipcRenderer.invoke: a handler that throws rejects the page's promise. */
  const invoke = (channel: string, payload?: unknown, senderId = MAIN_PAGE): Promise<unknown> =>
    Promise.resolve().then(() => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`nothing registered on ${channel}`);
      return handler({ sender: { id: senderId } }, payload);
    });
  return { handlers, service, invoke, lines };
}

describe('registerSetupIpc', () => {
  it('registers every setup channel', () => {
    const { handlers } = harness();
    expect([...handlers.keys()].sort()).toEqual(Object.values(setupChannels).sort());
  });

  it('answers each action with the status after it', async () => {
    const { invoke, service } = harness();
    await expect(invoke(setupChannels.SetupGetStatus)).resolves.toEqual(STATUS);
    await expect(invoke(setupChannels.SetupRequestMicrophone)).resolves.toEqual(STATUS);
    await expect(invoke(setupChannels.SetupTestSystemAudio)).resolves.toEqual(STATUS);
    await expect(invoke(setupChannels.SetupConfirmSystemAudio)).resolves.toEqual(STATUS);
    await expect(invoke(setupChannels.SetupTestNotification)).resolves.toEqual(STATUS);
    expect(service.status).toHaveBeenCalledTimes(1);
    expect(service.requestMicrophone).toHaveBeenCalledTimes(1);
    expect(service.testSystemAudio).toHaveBeenCalledTimes(1);
    expect(service.confirmSystemAudioAllowed).toHaveBeenCalledTimes(1);
    expect(service.testNotification).toHaveBeenCalledTimes(1);
  });

  it('opens a pane the page names from the closed list, and refuses anything else', async () => {
    const { invoke, service } = harness();
    await invoke(setupChannels.SetupOpenSettingsPane, { pane: 'systemAudio' });
    expect(service.openSettingsPane).toHaveBeenCalledWith('systemAudio');
    for (const payload of [
      { pane: 'x-apple.systempreferences:com.apple.preference.security' },
      { pane: 'https://example.com' },
      'microphone',
      null,
    ]) {
      await expect(invoke(setupChannels.SetupOpenSettingsPane, payload)).rejects.toThrow(
        'setup:open-settings-pane takes { pane: "microphone" | "systemAudio" | "screenRecording" }',
      );
    }
    expect(service.openSettingsPane).toHaveBeenCalledTimes(1);
  });

  it('relaunches on request', async () => {
    const { invoke, service } = harness();
    await expect(invoke(setupChannels.SetupRelaunch)).resolves.toBeUndefined();
    expect(service.relaunch).toHaveBeenCalledTimes(1);
  });

  it('answers only the main window: the prompt panel cannot relaunch Roger or open a pane', async () => {
    const { invoke, service } = harness();
    await expect(invoke(setupChannels.SetupRelaunch, undefined, PROMPT_PANEL)).rejects.toThrow(
      'untrusted sender',
    );
    await expect(
      invoke(setupChannels.SetupOpenSettingsPane, { pane: 'microphone' }, PROMPT_PANEL),
    ).rejects.toThrow('untrusted sender');
    expect(service.relaunch).not.toHaveBeenCalled();
    expect(service.openSettingsPane).not.toHaveBeenCalled();
  });

  it('logs a failed action with its channel and passes the error to the page', async () => {
    const { invoke, service, lines } = harness();
    service.testSystemAudio.mockRejectedValueOnce(new Error('the helper is missing'));
    await expect(invoke(setupChannels.SetupTestSystemAudio)).rejects.toThrow(
      'the helper is missing',
    );
    const failure = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line.message === 'setup action failed');
    expect(failure).toMatchObject({
      level: 'warn',
      channel: setupChannels.SetupTestSystemAudio,
      error: 'the helper is missing',
    });
  });
});
