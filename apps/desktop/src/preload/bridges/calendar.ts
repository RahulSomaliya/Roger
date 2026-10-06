// Stub from P2-F1; owned by M5-T6.
import type { CalendarApi } from '../../shared/ipc/calendar';

/**
 * The calendar feature's part of `window.roger`, built from the helpers in ../bridge.ts. It
 * implements src/shared/ipc/calendar.ts: a member added there fails the type check until it is
 * here.
 */
export const calendarBridge: CalendarApi = {};
