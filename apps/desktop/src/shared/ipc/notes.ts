// Stub from P2-F1; owned by M4-T13.
// The notes feature's IPC channels and its part of `window.roger`, which src/shared/ipc.ts
// composes. Add a member here together with its bridge (src/preload/bridges/notes.ts) and its
// preview fake (preview/fakes/notes.ts): the type check fails until all three agree.

export const notesChannels = {} as const;

/** Empty until M4-T13 adds the first member; make it an interface then. */
export type NotesApi = object;
