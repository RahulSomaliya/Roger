import { describe, expect, it } from 'vitest';
import { IpcChannel } from '../../src/shared/ipc';
import type { SetupStatus } from '../../src/shared/ipc/setup';
import { FakeHub } from './hub';
import { createSetupFake } from './setup';

/** A first run on a Mac that has granted nothing yet. */
const firstRun: SetupStatus = {
  microphone: {
    state: 'not-determined',
    message: 'Roger has not asked for the microphone yet.',
    relaunchNeeded: false,
  },
  systemAudio: {
    state: 'pending',
    message: 'Answer the macOS dialog, then press I allowed it.',
    relaunchNeeded: false,
  },
  systemCapture: 'tap',
  screenRecording: null,
  notifications: { state: 'unknown', message: null, relaunchNeeded: false },
  signing: { state: 'local-identity', message: null, relaunchNeeded: false },
  api: { state: 'ok', message: null, relaunchNeeded: false },
  stt: { state: 'ok', message: null, relaunchNeeded: false },
};

describe('the preview setup fake', () => {
  it('starts on a Mac where everything but the notification test is done', async () => {
    const setup = createSetupFake(new FakeHub());
    const status = await setup.getSetupStatus();
    expect(status).toMatchObject({
      microphone: { state: 'granted', message: null },
      systemAudio: { state: 'verified', message: null },
      systemCapture: 'tap',
      screenRecording: null,
      notifications: { state: 'unknown' },
      signing: { state: 'local-identity' },
      api: { state: 'ok' },
      stt: { state: 'ok' },
    });
  });

  it('answers the status a scenario seeded, and each action fixes its own row', async () => {
    const hub = new FakeHub();
    const setup = createSetupFake(hub);
    hub.emit(IpcChannel.SetupGetStatus, firstRun);
    await expect(setup.getSetupStatus()).resolves.toEqual(firstRun);

    const micAllowed = await setup.requestMicrophoneAccess();
    expect(micAllowed.microphone).toEqual({
      state: 'granted',
      message: null,
      relaunchNeeded: false,
    });
    expect(micAllowed.systemAudio.state).toBe('pending');

    const heard = await setup.confirmSystemAudioAllowed();
    expect(heard.systemAudio).toEqual({ state: 'verified', message: null, relaunchNeeded: false });

    const shown = await setup.testNotification();
    expect(shown.notifications).toEqual({ state: 'shown', message: null, relaunchNeeded: false });
    await expect(setup.getSetupStatus()).resolves.toEqual(shown);
  });

  it('opens panes and relaunches without a main process to do it', async () => {
    const setup = createSetupFake(new FakeHub());
    await expect(setup.openSettingsPane({ pane: 'microphone' })).resolves.toBeUndefined();
    await expect(setup.relaunchRoger()).resolves.toBeUndefined();
  });

  it('fails a request a scenario failed, as a failed invoke does', async () => {
    const hub = new FakeHub();
    const setup = createSetupFake(hub);
    hub.failNextRequest('the helper is missing');
    await expect(setup.testSystemAudio()).rejects.toThrow('the helper is missing');
  });
});
