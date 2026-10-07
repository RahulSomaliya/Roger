import { loginItemChannels, type LoginItemApi } from '../../shared/ipc/loginItem';
import { invoke, subscribe } from '../bridge';

/**
 * The login item feature's part of `window.roger`, built from the helpers in ../bridge.ts. It
 * implements src/shared/ipc/loginItem.ts: a member added there fails the type check until it is
 * here. Setting the choice goes through the preference `app.openAtLogin`, not through here.
 */
export const loginItemBridge: LoginItemApi = {
  getLoginItemState: () => invoke(loginItemChannels.LoginItemGetState),
  onLoginItemStateChanged: (listener) =>
    subscribe(loginItemChannels.LoginItemStateChanged, listener),
};
