import {
  type SetupCheck,
  setupChannels,
  type SetupApi,
  type SetupStatus,
} from '../../src/shared/ipc/setup';
import type { FakeHub } from './hub';

/**
 * The setup feature's part of the preview's `window.roger`. It starts on a Mac where every
 * permission is granted and the notification test has not run. A scenario describes another Mac
 * by emitting a status on the SetupGetStatus channel (`hub.emit(IpcChannel.SetupGetStatus,
 * status)`): it becomes the answer, and each action then fixes its own row as if the user said yes.
 * The preview has no System Settings and no app to relaunch: those two actions only resolve.
 */
export function createSetupFake(hub: FakeHub): SetupApi {
  let status = readyMac();
  hub.on(setupChannels.SetupGetStatus, (next: SetupStatus) => {
    status = next;
  });
  const update = (change: Partial<SetupStatus>): SetupStatus => {
    status = { ...status, ...change };
    return status;
  };

  return {
    getSetupStatus: () => hub.request(setupChannels.SetupGetStatus, () => status),
    requestMicrophoneAccess: () =>
      hub.request(setupChannels.SetupRequestMicrophone, () =>
        update({ microphone: fine('granted') }),
      ),
    testSystemAudio: () =>
      hub.request(setupChannels.SetupTestSystemAudio, () =>
        update({ systemAudio: fine('verified') }),
      ),
    confirmSystemAudioAllowed: () =>
      hub.request(setupChannels.SetupConfirmSystemAudio, () =>
        update({ systemAudio: fine('verified') }),
      ),
    testNotification: () =>
      hub.request(setupChannels.SetupTestNotification, () =>
        update({ notifications: fine('shown') }),
      ),
    openSettingsPane: () => hub.request(setupChannels.SetupOpenSettingsPane, () => undefined),
    relaunchRoger: () => hub.request(setupChannels.SetupRelaunch, () => undefined),
  };
}

function fine<State extends string>(state: State): SetupCheck<State> {
  return { state, message: null, relaunchNeeded: false };
}

function readyMac(): SetupStatus {
  return {
    microphone: fine('granted'),
    systemAudio: fine('verified'),
    systemCapture: 'tap',
    screenRecording: null,
    notifications: fine('unknown'),
    signing: fine('local-identity'),
    api: fine('ok'),
    stt: fine('ok'),
  };
}
