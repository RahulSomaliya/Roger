import { setupChannels, type SetupApi } from '../../shared/ipc/setup';
import { invoke } from '../bridge';

/** The setup feature's part of `window.roger`. */
export const setupBridge: SetupApi = {
  getSetupStatus: () => invoke(setupChannels.SetupGetStatus),
  requestMicrophoneAccess: () => invoke(setupChannels.SetupRequestMicrophone),
  testSystemAudio: () => invoke(setupChannels.SetupTestSystemAudio),
  confirmSystemAudioAllowed: () => invoke(setupChannels.SetupConfirmSystemAudio),
  testNotification: () => invoke(setupChannels.SetupTestNotification),
  openSettingsPane: (request) => invoke(setupChannels.SetupOpenSettingsPane, request),
  relaunchRoger: () => invoke(setupChannels.SetupRelaunch),
};
