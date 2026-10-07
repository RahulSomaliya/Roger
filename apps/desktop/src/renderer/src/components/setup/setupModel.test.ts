import { describe, expect, it, vi } from 'vitest';
import type { SetupApi, SetupStatus } from '../../../../shared/ipc/setup';
import { SetupModel } from './setupModel';
import { firstRunMac, readyMac } from './setupTesting';

/** Main's rejection as the page sees it: Electron wraps the message. */
const ipcError = (channel: string, message: string): Error =>
  new Error(`Error invoking remote method '${channel}': Error: ${message}`);

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function api(change: Partial<SetupApi> = {}) {
  return {
    getSetupStatus: vi.fn(() => Promise.resolve(readyMac())),
    requestMicrophoneAccess: vi.fn(() => Promise.resolve(readyMac())),
    testSystemAudio: vi.fn(() => Promise.resolve(readyMac())),
    confirmSystemAudioAllowed: vi.fn(() => Promise.resolve(readyMac())),
    testNotification: vi.fn(() => Promise.resolve(readyMac())),
    openSettingsPane: vi.fn((_request: { pane: string }) => Promise.resolve()),
    relaunchRoger: vi.fn(() => Promise.resolve()),
    ...change,
  } satisfies SetupApi;
}

describe('SetupModel', () => {
  it('starts loading, then holds the status main answered', async () => {
    const model = new SetupModel(api({ getSetupStatus: () => Promise.resolve(firstRunMac()) }));
    expect(model.getSnapshot()).toEqual({
      status: null,
      loadError: null,
      running: null,
      failure: null,
    });
    await model.load();
    expect(model.getSnapshot().status).toEqual(firstRunMac());
  });

  it("keeps a failed read's reason, without Electron's wrapper", async () => {
    const model = new SetupModel(
      api({
        getSetupStatus: () =>
          Promise.reject(ipcError('setup:get-status', 'codesign gave no answer')),
      }),
    );
    await model.load();
    expect(model.getSnapshot()).toMatchObject({
      status: null,
      loadError: 'codesign gave no answer',
    });
  });

  it('runs each action through its own call and shows the status it answers', async () => {
    const roger = api({ testSystemAudio: () => Promise.resolve(firstRunMac()) });
    const model = new SetupModel(roger);
    await model.load();
    await model.run('callAudio', { kind: 'test-system-audio', label: 'Test call audio' });
    expect(model.getSnapshot().status).toEqual(firstRunMac());
    await model.run('microphone', { kind: 'request-microphone', label: 'Allow microphone' });
    await model.run('callAudio', { kind: 'confirm-system-audio', label: 'I allowed it' });
    await model.run('notifications', { kind: 'test-notification', label: 'Send' });
    await model.run('microphone', {
      kind: 'open-pane',
      pane: 'microphone',
      label: 'Open Microphone settings',
    });
    await model.run('server', { kind: 'recheck', label: 'Check again' });
    await model.run('microphone', { kind: 'relaunch', label: 'Relaunch Roger' });
    expect(roger.requestMicrophoneAccess).toHaveBeenCalledTimes(1);
    expect(roger.confirmSystemAudioAllowed).toHaveBeenCalledTimes(1);
    expect(roger.testNotification).toHaveBeenCalledTimes(1);
    expect(roger.openSettingsPane).toHaveBeenCalledWith({ pane: 'microphone' });
    expect(roger.getSetupStatus).toHaveBeenCalledTimes(2);
    expect(roger.relaunchRoger).toHaveBeenCalledTimes(1);
  });

  it('says which action runs, and runs one at a time', async () => {
    const probe = deferred<SetupStatus>();
    const roger = api({ testSystemAudio: () => probe.promise });
    const model = new SetupModel(roger);
    await model.load();
    const running = model.run('callAudio', { kind: 'test-system-audio', label: 'Test' });
    expect(model.getSnapshot().running).toEqual({ row: 'callAudio', action: 'test-system-audio' });
    // A second press while the first runs does nothing: two probes would fight over the sound.
    await model.run('notifications', { kind: 'test-notification', label: 'Send' });
    expect(roger.testNotification).not.toHaveBeenCalled();
    probe.resolve(readyMac());
    await running;
    expect(model.getSnapshot().running).toBeNull();
  });

  it("shows a failed action's reason on its row, and clears it when the next action starts", async () => {
    const roger = api({
      testSystemAudio: vi
        .fn<SetupApi['testSystemAudio']>()
        .mockRejectedValueOnce(
          ipcError(
            'setup:test-system-audio',
            'Roger records call audio through Screen Recording on this Mac.',
          ),
        )
        .mockResolvedValueOnce(readyMac()),
    });
    const model = new SetupModel(roger);
    await model.load();
    await model.run('callAudio', { kind: 'test-system-audio', label: 'Test' });
    expect(model.getSnapshot().failure).toEqual({
      row: 'callAudio',
      message: 'Roger records call audio through Screen Recording on this Mac.',
    });
    await model.run('callAudio', { kind: 'test-system-audio', label: 'Test' });
    expect(model.getSnapshot().failure).toBeNull();
  });

  it('drops a read that answers after a newer answer, so an old status never comes back', async () => {
    const slow = deferred<SetupStatus>();
    const roger = api({
      getSetupStatus: vi
        .fn<SetupApi['getSetupStatus']>()
        .mockReturnValueOnce(slow.promise)
        .mockResolvedValue(readyMac()),
      requestMicrophoneAccess: () => Promise.resolve(readyMac()),
    });
    const model = new SetupModel(roger);
    const firstRead = model.load();
    await model.run('microphone', { kind: 'request-microphone', label: 'Allow microphone' });
    slow.resolve(firstRunMac());
    await firstRead;
    expect(model.getSnapshot().status).toEqual(readyMac());
  });

  it('reads nothing again while an action runs: its own answer brings the status', async () => {
    const dialog = deferred<SetupStatus>();
    const roger = api({ requestMicrophoneAccess: () => dialog.promise });
    const model = new SetupModel(roger);
    await model.load();
    const asking = model.run('microphone', { kind: 'request-microphone', label: 'Allow' });
    // The macOS dialog took focus; Roger's window gets it back when the person answers.
    await model.load();
    expect(roger.getSetupStatus).toHaveBeenCalledTimes(1);
    dialog.resolve(readyMac());
    await asking;
  });

  it('tells subscribers of every change, and stops when they leave', async () => {
    const model = new SetupModel(api());
    const listener = vi.fn();
    const unsubscribe = model.subscribe(listener);
    await model.load();
    expect(listener).toHaveBeenCalled();
    listener.mockClear();
    unsubscribe();
    await model.load();
    expect(listener).not.toHaveBeenCalled();
  });
});
