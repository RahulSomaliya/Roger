// Stub from P2-F1; owned by M4-T13.
import type { ChatApi } from '../../shared/ipc/chat';

/**
 * The chat feature's part of `window.roger`, built from the helpers in ../bridge.ts. It implements
 * src/shared/ipc/chat.ts: a member added there fails the type check until it is here.
 */
export const chatBridge: ChatApi = {};
