// Stub from P2-F1; owned by M4-S4.
// The meetings feature's IPC channels and its part of `window.roger`, which src/shared/ipc.ts
// composes. Add a member here together with its bridge (src/preload/bridges/meetings.ts) and its
// preview fake (preview/fakes/meetings.ts): the type check fails until all three agree.

export const meetingsChannels = {} as const;

/** Empty until M4-S4 adds the first member; make it an interface then. */
export type MeetingsApi = object;
