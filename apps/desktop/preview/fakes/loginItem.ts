import {
  type LoginItemApi,
  loginItemChannels,
  type LoginItemState,
} from '../../src/shared/ipc/loginItem';
import type { FakeHub } from './hub';

/**
 * The login item's part of the preview's `window.roger`: the preview is no packaged Roger, so it
 * starts `unavailable`, as a dev build's main does. A change a scenario sends on
 * LoginItemStateChanged becomes what the fake answers, as it would in main (`requires-approval` for
 * Settings' System Settings line, `enabled` for the line after the first connect).
 */
export function createLoginItemFake(hub: FakeHub): LoginItemApi {
  let state: LoginItemState = { status: 'unavailable' };
  hub.on(loginItemChannels.LoginItemStateChanged, (next: LoginItemState) => {
    state = next;
  });
  return {
    getLoginItemState: () => hub.request(loginItemChannels.LoginItemGetState, () => ({ ...state })),
    onLoginItemStateChanged: (listener) =>
      hub.on(loginItemChannels.LoginItemStateChanged, listener),
  };
}
