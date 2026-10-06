// Stub from P2-F1; owned by M5-T11.
// The login item feature's IPC channels and its part of `window.roger`, which src/shared/ipc.ts
// composes. Add a member here together with its bridge (src/preload/bridges/loginItem.ts) and its
// preview fake (preview/fakes/loginItem.ts): the type check fails until all three agree.

export const loginItemChannels = {} as const;

/** Empty until M5-T11 adds the first member; make it an interface then. */
export type LoginItemApi = object;
