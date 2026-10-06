// Stub from P2-F1; owned by M5-T11.
import type { LoginItemApi } from '../../src/shared/ipc/loginItem';

/**
 * The login item feature's part of the preview's `window.roger`. It implements
 * src/shared/ipc/loginItem.ts: a member added there fails the type check until it is here. Take the
 * hub (`hub: FakeHub`, ./hub.ts; fakeRoger.ts already passes it) once a member needs it: answer
 * requests through `hub.request` and send events with `hub.emit`, so scenarios can drive them.
 */
export function createLoginItemFake(): LoginItemApi {
  return {};
}
