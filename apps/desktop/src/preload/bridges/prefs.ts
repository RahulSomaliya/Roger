// Stub from P2-F1; owned by M4-S2.
import type { PrefsApi } from '../../shared/ipc/prefs';

/**
 * The preferences feature's part of `window.roger`, built from the helpers in ../bridge.ts. It
 * implements src/shared/ipc/prefs.ts: a member added there fails the type check until it is here.
 */
export const prefsBridge: PrefsApi = {};
