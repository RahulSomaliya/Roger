// Stub from P2-F1; owned by M3-T8.
import type { VocabularyApi } from '../../shared/ipc/vocabulary';

/**
 * The vocabulary feature's part of `window.roger`, built from the helpers in ../bridge.ts. It
 * implements src/shared/ipc/vocabulary.ts: a member added there fails the type check until it is
 * here.
 */
export const vocabularyBridge: VocabularyApi = {};
