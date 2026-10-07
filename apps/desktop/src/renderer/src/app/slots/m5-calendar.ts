import type { SlotContributions } from '../slotRegistry';
import { CalendarSettings } from '../../calendar/CalendarSettings';
import { CalendarStatusBanner } from '../../calendar/CalendarStatusBanner';
import { NoticeBanner } from '../../calendar/NoticeBanner';
import { TodaySection } from '../../calendar/TodaySection';

/**
 * What M5-T13 mounts: Today (home), the calendar settings, the calendar's health above every page
 * and the consent notice on the meeting page. Slot names and their props: ../slotRegistry.ts.
 *
 * The components are M5-T12's and read one shared store each (calendar/useCalendar.ts), so the
 * four mounts show one calendar. Orders: Settings keeps M3's jargon list (10) before the
 * calendar; the status banner follows M2's capture warnings (0), so a capture problem
 * stays the first thing above the page.
 */
export const contributions: SlotContributions = {
  home: [{ id: 'm5-today', order: 10, component: TodaySection }],
  settings: [{ id: 'm5-calendar', order: 30, component: CalendarSettings }],
  banner: [{ id: 'm5-calendar-status', order: 10, component: CalendarStatusBanner }],
  meetingBanner: [{ id: 'm5-calendar-notice', order: 0, component: NoticeBanner }],
};
