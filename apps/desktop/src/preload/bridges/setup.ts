// Stub from P2-F1; owned by M2-T2.
import type { SetupApi } from '../../shared/ipc/setup';

/**
 * The setup feature's part of `window.roger`, built from the helpers in ../bridge.ts. It implements
 * src/shared/ipc/setup.ts: a member added there fails the type check until it is here.
 */
export const setupBridge: SetupApi = {};
