// Stub from P2-F1; owned by M4-S4.
import type { MeetingsApi } from '../../src/shared/ipc/meetings';

/**
 * The meetings feature's part of the preview's `window.roger`. It implements
 * src/shared/ipc/meetings.ts: a member added there fails the type check until it is here. Take the
 * hub (`hub: FakeHub`, ./hub.ts; fakeRoger.ts already passes it) once a member needs it: answer
 * requests through `hub.request` and send events with `hub.emit`, so scenarios can drive them.
 */
export function createMeetingsFake(): MeetingsApi {
  return {};
}
