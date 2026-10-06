// Stub from P2-F1; owned by M4-T13.
// The chat feature's IPC channels and its part of `window.roger`, which src/shared/ipc.ts composes.
// Add a member here together with its bridge (src/preload/bridges/chat.ts) and its preview fake
// (preview/fakes/chat.ts): the type check fails until all three agree.

export const chatChannels = {} as const;

/** Empty until M4-T13 adds the first member; make it an interface then. */
export type ChatApi = object;
