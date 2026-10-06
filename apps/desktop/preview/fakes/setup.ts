// Stub from P2-F1; owned by M2-T2.
import type { SetupApi } from '../../src/shared/ipc/setup';

/**
 * The setup feature's part of the preview's `window.roger`. It implements src/shared/ipc/setup.ts:
 * a member added there fails the type check until it is here. Take the hub (`hub: FakeHub`,
 * ./hub.ts; fakeRoger.ts already passes it) once a member needs it: answer requests through
 * `hub.request` and send events with `hub.emit`, so scenarios can drive them.
 */
export function createSetupFake(): SetupApi {
  return {};
}
