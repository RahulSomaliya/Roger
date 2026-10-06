// Stub from P2-F1; owned by M3-T8.
// The vocabulary feature's IPC channels and its part of `window.roger`, which src/shared/ipc.ts
// composes. Add a member here together with its bridge (src/preload/bridges/vocabulary.ts) and its
// preview fake (preview/fakes/vocabulary.ts): the type check fails until all three agree.

export const vocabularyChannels = {} as const;

/** Empty until M3-T8 adds the first member; make it an interface then. */
export type VocabularyApi = object;
