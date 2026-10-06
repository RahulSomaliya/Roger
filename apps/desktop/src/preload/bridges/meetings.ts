// Stub from P2-F1; owned by M4-S4.
import type { MeetingsApi } from '../../shared/ipc/meetings';

/**
 * The meetings feature's part of `window.roger`, built from the helpers in ../bridge.ts. It
 * implements src/shared/ipc/meetings.ts: a member added there fails the type check until it is
 * here.
 */
export const meetingsBridge: MeetingsApi = {};
