import {
  calendarChannels,
  type CalendarApi,
  type FindCalendarMeetingsRequest,
} from '../../shared/ipc/calendar';
import { invoke, subscribe } from '../bridge';

/**
 * The calendar's part of `window.roger`. Main checks the lookup's ids again
 * (main/calendar/calendarIpc.ts); the sign-in runs entirely in main and the default browser.
 */
export const calendarBridge: CalendarApi = {
  getCalendarConnection: () => invoke(calendarChannels.CalendarGetConnection),
  connectCalendar: () => invoke(calendarChannels.CalendarConnect),
  disconnectCalendar: () => invoke(calendarChannels.CalendarDisconnect),
  getCalendarEvents: () => invoke(calendarChannels.CalendarGetEvents),
  getCalendarSyncState: () => invoke(calendarChannels.CalendarGetSyncState),
  findCalendarMeetings: (eventIds) => {
    const request: FindCalendarMeetingsRequest = { eventIds };
    return invoke(calendarChannels.CalendarFindMeetings, request);
  },
  onCalendarConnectionChanged: (listener) =>
    subscribe(calendarChannels.CalendarConnectionChanged, listener),
  onCalendarEventsChanged: (listener) =>
    subscribe(calendarChannels.CalendarEventsChanged, listener),
  onCalendarSyncStateChanged: (listener) =>
    subscribe(calendarChannels.CalendarSyncStateChanged, listener),
};
