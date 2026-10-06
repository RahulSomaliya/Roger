// Stub from P2-F1; owned by M2-T2.
// The setup feature's IPC channels and its part of `window.roger`, which src/shared/ipc.ts
// composes. Add a member here together with its bridge (src/preload/bridges/setup.ts) and its
// preview fake (preview/fakes/setup.ts): the type check fails until all three agree.

export const setupChannels = {} as const;

/** Empty until M2-T2 adds the first member; make it an interface then. */
export type SetupApi = object;
