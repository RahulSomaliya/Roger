// Stub from P2-F1; owned by M5-T6.
// The calendar feature's IPC channels and its part of `window.roger`, which src/shared/ipc.ts
// composes. Add a member here together with its bridge (src/preload/bridges/calendar.ts) and its
// preview fake (preview/fakes/calendar.ts): the type check fails until all three agree.

export const calendarChannels = {} as const;

/** Empty until M5-T6 adds the first member; make it an interface then. */
export type CalendarApi = object;
