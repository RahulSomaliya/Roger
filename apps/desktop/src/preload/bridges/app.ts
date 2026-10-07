import { appChannels, type AppApi } from '../../shared/ipc/app';
import { send, subscribe } from '../bridge';

/** The app shell's part of `window.roger`. */
export const appBridge: AppApi = {
  appReady: () => {
    send(appChannels.AppReady, null);
  },
  onNavigate: (listener) => subscribe(appChannels.AppNavigate, listener),
};
