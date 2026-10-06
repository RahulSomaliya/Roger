// Stub from P2-F1; owned by M4-T13.
import type { NotesApi } from '../../shared/ipc/notes';

/**
 * The notes feature's part of `window.roger`, built from the helpers in ../bridge.ts. It implements
 * src/shared/ipc/notes.ts: a member added there fails the type check until it is here.
 */
export const notesBridge: NotesApi = {};
