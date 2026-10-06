// Stub from P2-F1; owned by M4-S1.
import type { AppApi } from '../../shared/ipc/app';

/**
 * The app shell feature's part of `window.roger`, built from the helpers in ../bridge.ts. It
 * implements src/shared/ipc/app.ts: a member added there fails the type check until it is here.
 */
export const appBridge: AppApi = {};
