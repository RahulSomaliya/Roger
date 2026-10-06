// Stub from P2-F1; owned by M4-S1.
// The app shell feature's IPC channels and its part of `window.roger`, which src/shared/ipc.ts
// composes. Add a member here together with its bridge (src/preload/bridges/app.ts) and its preview
// fake (preview/fakes/app.ts): the type check fails until all three agree.

export const appChannels = {} as const;

/** Empty until M4-S1 adds the first member; make it an interface then. */
export type AppApi = object;
