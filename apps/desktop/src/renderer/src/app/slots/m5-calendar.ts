import type { SlotContributions } from '../slotRegistry';
import { CalendarSettings } from '../../calendar/CalendarSettings';
import { NoticeBanner } from '../../calendar/NoticeBanner';

/**
 * What M5-T13 mounts: the calendar settings and the consent notice on the meeting page. Slot
 * names and their props: ../slotRegistry.ts. Today is not here: HomePage mounts TodaySection
 * itself, and no outlet reads the `home` slot for it.
 *
 * The components are M5-T12's and read one shared store each (calendar/useCalendar.ts), so the
 * mounts show one calendar. Orders: Settings keeps M3's jargon list (10) before the calendar.
 * The calendar's health no longer has a banner above every page: it is one quiet line in Today, so
 * a capture problem is the only thing above a page.
 */
export const contributions: SlotContributions = {
  settings: [{ id: 'm5-calendar', order: 30, component: CalendarSettings }],
  meetingBanner: [{ id: 'm5-calendar-notice', order: 0, component: NoticeBanner }],
};
