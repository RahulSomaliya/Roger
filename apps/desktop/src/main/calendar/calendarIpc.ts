import type { CalendarEvent, CalendarSyncState } from '../../shared/calendar';
import {
  calendarChannels,
  type CalendarMeetingLink,
  MAX_CALENDAR_MEETINGS_LOOKUP,
  parseFindCalendarMeetingsRequest,
} from '../../shared/ipc/calendar';
import { handleTrusted, type IpcMainLike, type IpcTrust } from '../ipc/trust';
import { errorMessage, type Logger } from '../logger';
import type { CalendarAccount } from './CalendarAccount';
import type { CalendarSync } from './CalendarSync';
import type { SqliteCalendarCache } from './SqliteCalendarCache';

/** The parts of the main window this needs; a BrowserWindow is one. */
export interface CalendarIpcWindow {
  isDestroyed(): boolean;
  readonly webContents: { readonly id: number; send(channel: string, payload: unknown): void };
}

export interface CalendarIpcDeps {
  ipcMain: IpcMainLike;
  account: Pick<CalendarAccount, 'connect' | 'disconnect' | 'getConnection' | 'onConnectionChange'>;
  sync: Pick<CalendarSync, 'getState' | 'onStateChange' | 'onEventsChange'>;
  cache: Pick<SqliteCalendarCache, 'listEvents'>;
  /**
   * For each event id a local meeting was started for, the newest such meeting's id: the port
   * M5-T9c fills with the transcript store's `findMeetingIdsByEventIds` (roger.sqlite, one
   * indexed query). An event with none is left out of the map.
   */
  findMeetingIdsByEventIds: (eventIds: readonly string[]) => Map<string, string>;
  /** The main window, whose page alone may use these channels; null while it is closed. */
  getWindow: () => CalendarIpcWindow | null;
  logger: Logger;
}

/**
 * Wires the calendar's channels (src/shared/ipc/calendar.ts), for the main window's page only
 * (ipc/trust.ts): the prompt panel gets its cards through its own channels and has no business
 * connecting accounts. The connection, Connect and Disconnect go through CalendarAccount, which
 * words its failures for the page and logs them; the events and their sync state are read from
 * this Mac's copy and work with the API down. Every change main makes reaches the page as an
 * event, so Home and Settings never poll.
 *
 * Log lines carry channels and counts, never an event's title, attendees or ids: invites name
 * clients and colleagues.
 */
export function registerCalendarIpc({
  ipcMain,
  account,
  sync,
  cache,
  findMeetingIdsByEventIds,
  getWindow,
  logger,
}: CalendarIpcDeps): void {
  const trust: IpcTrust = { ipcMain, getWindow, logger };

  handleTrusted(trust, calendarChannels.CalendarGetConnection, () => account.getConnection());
  handleTrusted(trust, calendarChannels.CalendarConnect, () => account.connect());
  handleTrusted(trust, calendarChannels.CalendarDisconnect, () => account.disconnect());

  handleTrusted(trust, calendarChannels.CalendarGetEvents, (): CalendarEvent[] =>
    readCopy(calendarChannels.CalendarGetEvents, () => cache.listEvents()),
  );
  handleTrusted(trust, calendarChannels.CalendarGetSyncState, (): CalendarSyncState =>
    readCopy(calendarChannels.CalendarGetSyncState, () => sync.getState()),
  );

  handleTrusted(trust, calendarChannels.CalendarFindMeetings, (payload): CalendarMeetingLink[] => {
    const channel = calendarChannels.CalendarFindMeetings;
    const request = parseFindCalendarMeetingsRequest(payload);
    if (request === null) {
      logger.warn('calendar read refused', { channel });
      throw new Error(
        `${channel} takes { eventIds: at most ${MAX_CALENDAR_MEETINGS_LOOKUP} event ids }`,
      );
    }
    const eventIds = [...new Set(request.eventIds)];
    if (eventIds.length === 0) return [];
    let found: Map<string, string>;
    try {
      found = findMeetingIdsByEventIds(eventIds);
    } catch (error) {
      logger.warn('calendar read failed', {
        channel,
        eventIds: eventIds.length,
        error: errorMessage(error),
      });
      throw error;
    }
    // In the order asked, so the page can match them up without a lookup of its own.
    return eventIds.flatMap((eventId) => {
      const meetingId = found.get(eventId);
      return meetingId === undefined ? [] : [{ eventId, meetingId }];
    });
  });

  /** A read of the copy; a failure is logged and rejects the page's invoke with it. */
  function readCopy<T>(channel: string, read: () => T): T {
    try {
      return read();
    } catch (error) {
      logger.warn('calendar read failed', { channel, error: errorMessage(error) });
      throw error;
    }
  }

  const sendToPage = (channel: string, payload: unknown): void => {
    const window = getWindow();
    if (window !== null && !window.isDestroyed()) window.webContents.send(channel, payload);
  };
  account.onConnectionChange((connection) => {
    sendToPage(calendarChannels.CalendarConnectionChanged, connection);
  });
  sync.onEventsChange((events) => {
    sendToPage(calendarChannels.CalendarEventsChanged, events);
  });
  sync.onStateChange((state) => {
    sendToPage(calendarChannels.CalendarSyncStateChanged, state);
  });
}
