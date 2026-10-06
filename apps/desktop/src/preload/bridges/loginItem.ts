// Stub from P2-F1; owned by M5-T11.
import type { LoginItemApi } from '../../shared/ipc/loginItem';

/**
 * The login item feature's part of `window.roger`, built from the helpers in ../bridge.ts. It
 * implements src/shared/ipc/loginItem.ts: a member added there fails the type check until it is
 * here.
 */
export const loginItemBridge: LoginItemApi = {};
