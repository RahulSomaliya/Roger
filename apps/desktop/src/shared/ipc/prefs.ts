// Stub from P2-F1; owned by M4-S2.
// The preferences feature's IPC channels and its part of `window.roger`, which src/shared/ipc.ts
// composes. Add a member here together with its bridge (src/preload/bridges/prefs.ts) and its
// preview fake (preview/fakes/prefs.ts): the type check fails until all three agree.

export const prefsChannels = {} as const;

/** Empty until M4-S2 adds the first member; make it an interface then. */
export type PrefsApi = object;
