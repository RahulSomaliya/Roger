import { describe, expect, it, vi } from 'vitest';
import { calendarChannels } from '../../shared/ipc/calendar';
import { calendarBridge } from './calendar';

// Electron's ipcRenderer, as far as the bridge helpers use it (see ../bridge.test.ts). Hoisted,
// because vi.mock runs before the imports.
const ipc = vi.hoisted(() => {
  const listeners = new Map<string, ((event: object, payload: unknown) => void)[]>();
  const calls: { how: 'invoke' | 'on'; channel: string; payload?: unknown }[] = [];
  return {
    calls,
    renderer: {
      invoke: (channel: string, payload: unknown): Promise<unknown> => {
        calls.push({ how: 'invoke', channel, payload });
        return Promise.resolve(null);
      },
      on: (channel: string, listener: (event: object, payload: unknown) => void): void => {
        calls.push({ how: 'on', channel });
        listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
      },
      removeListener: (channel: string, listener: (event: object, payload: unknown) => void) => {
        listeners.set(
          channel,
          (listeners.get(channel) ?? []).filter((each) => each !== listener),
        );
      },
    },
    emit: (channel: string, payload: unknown): void => {
      for (const listener of listeners.get(channel) ?? []) listener({}, payload);
    },
  };
});
vi.mock('electron', () => ({ ipcRenderer: ipc.renderer }));

describe('the calendar bridge', () => {
  it('sends each request on its own channel, the lookup with its ids', async () => {
    ipc.calls.length = 0;
    await calendarBridge.getCalendarConnection();
    await calendarBridge.connectCalendar();
    await calendarBridge.disconnectCalendar();
    await calendarBridge.getCalendarEvents();
    await calendarBridge.getCalendarSyncState();
    await calendarBridge.findCalendarMeetings(['fake-call', 'fake-standup_20261006T100000Z']);

    expect(ipc.calls).toEqual([
      { how: 'invoke', channel: calendarChannels.CalendarGetConnection, payload: undefined },
      { how: 'invoke', channel: calendarChannels.CalendarConnect, payload: undefined },
      { how: 'invoke', channel: calendarChannels.CalendarDisconnect, payload: undefined },
      { how: 'invoke', channel: calendarChannels.CalendarGetEvents, payload: undefined },
      { how: 'invoke', channel: calendarChannels.CalendarGetSyncState, payload: undefined },
      {
        how: 'invoke',
        channel: calendarChannels.CalendarFindMeetings,
        payload: { eventIds: ['fake-call', 'fake-standup_20261006T100000Z'] },
      },
    ]);
  });

  it("hands each of main's events to its listener until it unsubscribes", () => {
    const heard: unknown[] = [];
    const stops = [
      calendarBridge.onCalendarConnectionChanged((connection) =>
        heard.push(['connection', connection]),
      ),
      calendarBridge.onCalendarEventsChanged((events) => heard.push(['events', events])),
      calendarBridge.onCalendarSyncStateChanged((state) => heard.push(['state', state])),
    ];
    ipc.emit(calendarChannels.CalendarConnectionChanged, null);
    ipc.emit(calendarChannels.CalendarEventsChanged, []);
    ipc.emit(calendarChannels.CalendarSyncStateChanged, { staleSince: null });
    for (const stop of stops) stop();
    ipc.emit(calendarChannels.CalendarEventsChanged, ['late']);

    expect(heard).toEqual([
      ['connection', null],
      ['events', []],
      ['state', { staleSince: null }],
    ]);
  });

  it('uses the channel names main registers', () => {
    expect(calendarChannels).toEqual({
      CalendarGetConnection: 'calendar:get-connection',
      CalendarConnect: 'calendar:connect',
      CalendarDisconnect: 'calendar:disconnect',
      CalendarGetEvents: 'calendar:get-events',
      CalendarGetSyncState: 'calendar:get-sync-state',
      CalendarFindMeetings: 'calendar:find-meetings',
      CalendarConnectionChanged: 'calendar:connection-changed',
      CalendarEventsChanged: 'calendar:events-changed',
      CalendarSyncStateChanged: 'calendar:sync-state-changed',
    });
  });
});
