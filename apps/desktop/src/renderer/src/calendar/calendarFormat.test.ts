import { describe, expect, it } from 'vitest';
import type { CalendarConnection, CalendarSyncState } from '../../../shared/calendar';
import { LOGIN_ITEMS_SETTINGS_PATH } from '../../../shared/ipc/loginItem';
import { calendarState } from './calendarTesting';
import {
  calendarNotices,
  calendarProblem,
  createCalendarFormat,
  openAtLoginHint,
  reconnectLabel,
  staleText,
} from './calendarFormat';

// Asia/Kolkata is UTC+5:30 with no DST, so the same instants read differently from UTC.
const format = createCalendarFormat('Asia/Kolkata');
const NOW = Date.parse('2026-10-06T09:00:00.000Z'); // 14:30 in Kolkata, Tue 6 Oct
const DAY_MS = 24 * 60 * 60 * 1000;

const connection: CalendarConnection = {
  provider: 'google',
  accountEmail: 'you@example.com',
  status: 'active',
  connectedAt: '2026-10-01T03:00:00.000Z',
  expiresHint: null,
  lastError: null,
};
const freshSync: CalendarSyncState = {
  lastSuccessAt: '2026-10-06T08:55:00.000Z',
  lastError: null,
  staleSince: null,
  reconnectRequired: false,
};
const staleSync: CalendarSyncState = {
  lastSuccessAt: '2026-10-06T03:42:00.000Z', // 09:12 in Kolkata
  lastError: 'Google answered 503',
  staleSince: '2026-10-06T04:42:00.000Z',
  reconnectRequired: false,
};

describe('createCalendarFormat', () => {
  it('writes times on a 12 hour clock and dates as "Wed 14 Oct", in the given zone', () => {
    expect(format.time(Date.parse('2026-10-06T03:42:00.000Z'))).toBe('9:12 am');
    expect(format.time(Date.parse('2026-10-06T15:35:00.000Z'))).toBe('9:05 pm');
    expect(format.date(Date.parse('2026-10-14T00:00:00.000Z'))).toBe('Wed 14 Oct');
  });

  it('reads the zone a day is in: 23:30 UTC is already tomorrow in Kolkata', () => {
    const late = Date.parse('2026-10-06T23:30:00.000Z');
    expect(createCalendarFormat('UTC').date(late)).toBe('Tue 6 Oct');
    expect(format.date(late)).toBe('Wed 7 Oct');
  });

  it('adds the weekday only for another day than now', () => {
    expect(format.when(Date.parse('2026-10-06T03:42:00.000Z'), NOW)).toBe('9:12 am');
    expect(format.when(Date.parse('2026-10-07T03:42:00.000Z'), NOW)).toBe('Wed 9:12 am');
  });
});

describe('staleText', () => {
  it('says since when, with the weekday for an earlier day', () => {
    expect(staleText(staleSync, NOW, format)).toBe('Calendar not updated since 9:12 am');
    const older = { ...staleSync, lastSuccessAt: '2026-10-04T15:35:00.000Z' };
    expect(staleText(older, NOW, format)).toBe('Calendar not updated since Sun 9:05 pm');
  });

  it('says only "not updated" when it has never synced', () => {
    expect(staleText({ ...staleSync, lastSuccessAt: null }, NOW, format)).toBe(
      'Calendar not updated',
    );
  });
});

describe('reconnectLabel', () => {
  const expiresAt = Date.parse('2026-10-14T03:00:00.000Z');
  const expiring = { ...connection, expiresHint: new Date(expiresAt).toISOString() };

  it('says nothing before the last day, nothing when there is no expiry, nothing when fine', () => {
    expect(reconnectLabel(expiring, freshSync, expiresAt - DAY_MS - 1, format)).toBeNull();
    expect(reconnectLabel(connection, freshSync, expiresAt + 5 * DAY_MS, format)).toBeNull();
    expect(reconnectLabel(connection, freshSync, NOW, format)).toBeNull();
  });

  it('names the date from 24 hours before the expiry', () => {
    expect(reconnectLabel(expiring, freshSync, expiresAt - DAY_MS, format)).toBe(
      'Reconnect before Wed 14 Oct',
    );
    expect(reconnectLabel(expiring, freshSync, expiresAt - 1, format)).toBe(
      'Reconnect before Wed 14 Oct',
    );
  });

  it('has no date to give once Google refused the grant or the date has passed', () => {
    expect(reconnectLabel(expiring, freshSync, expiresAt, format)).toBe('Reconnect');
    const refused = { ...connection, status: 'reconnect_required' as const };
    expect(reconnectLabel(refused, freshSync, NOW, format)).toBe('Reconnect');
    expect(reconnectLabel(connection, { ...freshSync, reconnectRequired: true }, NOW, format)).toBe(
      'Reconnect',
    );
  });

  it('is null with no connection', () => {
    expect(reconnectLabel(null, freshSync, NOW, format)).toBeNull();
  });
});

describe('calendarNotices', () => {
  const input = { connection, sync: freshSync, nowMs: NOW, format };

  it('is empty for a healthy calendar, and for no calendar at all', () => {
    expect(calendarNotices(input)).toEqual([]);
    // A disconnect clears the copy, but a health still on its way can arrive after it.
    expect(calendarNotices({ ...input, connection: null, sync: staleSync })).toEqual([]);
  });

  it('shows the stale line alone, with no action', () => {
    const [notice, ...rest] = calendarNotices({ ...input, sync: staleSync });
    expect(rest).toEqual([]);
    expect(notice).toMatchObject({
      kind: 'stale',
      text: 'Calendar not updated since 9:12 am',
      action: null,
    });
  });

  it('puts a refused grant first with its action, and drops the stale line it explains', () => {
    const notices = calendarNotices({
      connection: { ...connection, status: 'reconnect_required' },
      sync: { ...staleSync, reconnectRequired: true },
      nowMs: NOW,
      format,
    });
    expect(notices.map((notice) => notice.kind)).toEqual(['reconnect-required']);
    expect(notices[0]?.action).toBe('Reconnect');
  });

  it('warns before the expiry date and still shows a stale copy', () => {
    const expiresAt = NOW + 5 * 60 * 60 * 1000; // 19:30 the same day in Kolkata
    const notices = calendarNotices({
      ...input,
      connection: { ...connection, expiresHint: new Date(expiresAt).toISOString() },
      sync: staleSync,
    });
    expect(notices.map((notice) => notice.kind)).toEqual(['reconnect-soon', 'stale']);
    expect(notices[0]?.action).toBe('Reconnect before Tue 6 Oct');
    // The date moved from the button into the sentence: Home's button just says Reconnect.
    expect(notices[0]?.text).toContain('on Tue 6 Oct');
  });
});

describe("calendarProblem (Home's one quiet line)", () => {
  const problem = (fields: Parameters<typeof calendarState>[0] = {}, nowMs = NOW) =>
    calendarProblem({
      state: calendarState({ sync: freshSync, ...fields }),
      nowMs,
      format,
    });

  it('is null for a healthy calendar', () => {
    expect(problem()).toBeNull();
  });

  it('says a stale copy since when, with nothing to press', () => {
    expect(problem({ sync: staleSync })).toEqual({
      text: 'Calendar not updated since 9:12 am',
      action: null,
    });
  });

  it('puts a refused grant first, with Reconnect, over every other problem', () => {
    const result = problem({
      connection: { ...connection, status: 'reconnect_required' },
      sync: { ...staleSync, reconnectRequired: true },
      copyError: 'disk is full',
    });
    expect(result?.action).toBe('reconnect');
    expect(result?.text).toContain('sign in again');
  });

  it('says why the connection or the copy could not be read, and offers to try again', () => {
    expect(problem({ connectionStatus: 'failed', connectionError: 'API is down' })).toEqual({
      text: 'Roger could not check your Google Calendar connection: API is down',
      action: 'reload',
    });
    expect(problem({ copyError: 'disk is full' })).toEqual({
      text: 'Roger could not read your calendar: disk is full',
      action: 'reload',
    });
  });

  it('warns before the grant expires, with Reconnect', () => {
    const expiresAt = NOW + 5 * 60 * 60 * 1000;
    const result = problem({
      connection: { ...connection, expiresHint: new Date(expiresAt).toISOString() },
    });
    expect(result?.action).toBe('reconnect');
  });

  it('says last that the lookup of existing notes failed, with nothing to press', () => {
    expect(problem({ linksError: 'main is busy' })).toEqual({
      text: 'Roger could not check which meetings already have notes: main is busy',
      action: null,
    });
  });
});

describe('openAtLoginHint', () => {
  it('says where to allow Roger when macOS waits for the user, with the path System Settings uses', () => {
    const hint = openAtLoginHint('requires-approval');
    expect(hint).toContain(LOGIN_ITEMS_SETTINGS_PATH);
    expect(hint).toContain('missed');
  });

  it('says what a dev build, or a Roger macOS cannot find, cannot do', () => {
    expect(openAtLoginHint('unavailable')).toContain('Not available');
  });
});
