import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AllDayCalendarEvent, CalendarEvent, TimedCalendarEvent } from '../../shared/calendar';
import { cacheKey, SqliteCalendarCache } from './SqliteCalendarCache';

function call(overrides: Partial<TimedCalendarEvent> = {}): TimedCalendarEvent {
  return {
    provider: 'fake',
    id: 'call_1',
    icalUid: 'call_1@google.com',
    recurringEventId: null,
    title: 'Sync with Jane',
    status: 'confirmed',
    allDay: false,
    start: '2026-10-06T09:00:00Z',
    end: '2026-10-06T09:30:00Z',
    startDate: null,
    endDate: null,
    selfResponse: 'accepted',
    attendees: [
      {
        email: 'jane@example.com',
        displayName: 'Jane',
        responseStatus: 'accepted',
        isSelf: false,
        isOrganizer: true,
      },
    ],
    attendeesOmitted: false,
    videoLink: 'https://meet.google.com/abc-defg-hij',
    videoLinkSource: 'conference',
    htmlLink: null,
    ...overrides,
  };
}

function holiday(): AllDayCalendarEvent {
  return {
    ...call({ id: 'holiday_1', title: 'Holiday' }),
    allDay: true,
    start: null,
    end: null,
    startDate: '2026-10-06',
    endDate: '2026-10-07',
  };
}

/** A `prompts` row as PromptLog (M5-T9a) will write it: only the columns the test reads. */
function insertPrompt(cache: SqliteCalendarCache, accountEmail: string, key: string): void {
  cache.database
    .prepare(
      `INSERT INTO prompts (account_email, key, source, event_id, title, scheduled_start, action)
       VALUES (?, ?, 'calendar', 'call_1', 'Sync with Jane', '2026-10-06T09:00:00.000Z', 'started')`,
    )
    .run(accountEmail, key);
}

function countRows(cache: SqliteCalendarCache, table: string): number {
  const row = cache.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
  return Number(row?.n);
}

describe('SqliteCalendarCache', () => {
  it('disconnect clears events and fetch_state but keeps prompts, runs and connections_log', () => {
    const cache = new SqliteCalendarCache(':memory:');
    cache.recordConnected('rahul@linkt.ai', '2026-10-06T08:00:00.000Z');
    cache.replaceEvents([call(), holiday()], '2026-10-06T08:00:05.000Z');
    cache.recordFailure('Google is unreachable', '2026-10-06T08:05:00.000Z');
    insertPrompt(cache, 'rahul@linkt.ai', cacheKey(call()));
    cache.database
      .prepare('INSERT INTO runs (started_at, last_tick_at) VALUES (?, ?)')
      .run('2026-10-06T07:59:00.000Z', '2026-10-06T08:05:00.000Z');

    cache.recordDisconnected('2026-10-06T08:10:00.000Z');

    expect(cache.listEvents()).toEqual([]);
    expect(countRows(cache, 'events')).toBe(0);
    expect(countRows(cache, 'fetch_state')).toBe(0);
    expect(cache.getSyncState()).toEqual({
      lastSuccessAt: null,
      lastError: null,
      staleSince: null,
      reconnectRequired: false,
    });
    expect(countRows(cache, 'prompts')).toBe(1);
    expect(countRows(cache, 'runs')).toBe(1);
    expect(cache.activeConnection()).toBeNull();
    expect(cache.listConnections('rahul@linkt.ai')).toEqual([
      {
        accountEmail: 'rahul@linkt.ai',
        connectedAt: '2026-10-06T08:00:00.000Z',
        disconnectedAt: '2026-10-06T08:10:00.000Z',
      },
    ]);
    cache.close();
  });

  it('keeps the prompts of two accounts apart, also for the same event key', () => {
    const cache = new SqliteCalendarCache(':memory:');
    const key = cacheKey(call());
    insertPrompt(cache, 'rahul@linkt.ai', key);
    insertPrompt(cache, 'rahul@gmail.com', key);

    cache.recordConnected('rahul@gmail.com', '2026-10-06T08:00:00.000Z');
    cache.recordDisconnected('2026-10-06T08:10:00.000Z');

    const rows = cache.database
      .prepare('SELECT account_email, key FROM prompts ORDER BY account_email')
      .all();
    expect(rows).toEqual([
      { account_email: 'rahul@gmail.com', key },
      { account_email: 'rahul@linkt.ai', key },
    ]);
    // The same account and key twice is one prompt: its outcome is updated, never duplicated.
    expect(() => {
      insertPrompt(cache, 'rahul@linkt.ai', key);
    }).toThrow(/UNIQUE/);
    cache.close();
  });

  it('replaces the events in one go: a deleted event goes, a kept one keeps its first sighting', () => {
    const cache = new SqliteCalendarCache(':memory:');
    const kept = call({ id: 'kept' });
    const deleted = call({ id: 'deleted', start: '2026-10-06T10:00:00Z' });
    const added = call({ id: 'added', start: '2026-10-06T11:00:00Z' });
    cache.replaceEvents([holiday(), kept, deleted], '2026-10-06T08:00:00.000Z');

    cache.replaceEvents([holiday(), kept, added], '2026-10-06T08:05:00.000Z');

    expect(cache.listEvents()).toEqual([holiday(), kept, added]);
    expect(cache.firstSeenAt(cacheKey(kept))).toBe('2026-10-06T08:00:00.000Z');
    expect(cache.firstSeenAt(cacheKey(added))).toBe('2026-10-06T08:05:00.000Z');
    expect(cache.firstSeenAt(cacheKey(deleted))).toBeNull();
    expect(cache.getSyncState().lastSuccessAt).toBe('2026-10-06T08:05:00.000Z');
    cache.close();
  });

  it('writes nothing when one event of the answer is bad', () => {
    const cache = new SqliteCalendarCache(':memory:');
    cache.replaceEvents([call()], '2026-10-06T08:00:00.000Z');
    // A local time: read in this Mac's zone it would move the prompt by hours.
    const bad = call({ id: 'bad', start: '2026-10-06T10:00:00' });

    expect(() => {
      cache.replaceEvents([call({ id: 'other' }), bad], '2026-10-06T08:05:00.000Z');
    }).toThrow(/Not an ISO 8601 instant/);

    expect(cache.listEvents()).toEqual([call()]);
    expect(cache.getSyncState().lastSuccessAt).toBe('2026-10-06T08:00:00.000Z');
    cache.close();
  });

  it('keys a timed event by its prompt key and an all-day event by its date', () => {
    expect(cacheKey(call({ start: '2026-10-06T11:00:00+02:00' }))).toBe(
      'call_1@2026-10-06T09:00:00.000Z',
    );
    expect(cacheKey(holiday())).toBe('holiday_1@2026-10-06');
  });

  it('records a success, a failure, a stale spell and a refused grant in fetch_state', () => {
    const cache = new SqliteCalendarCache(':memory:');
    cache.replaceEvents([], '2026-10-06T08:00:00.000Z');
    cache.recordFailure('Google is unreachable', '2026-10-06T08:05:00.000Z');
    cache.markStale('2026-10-06T09:00:00.000Z');
    // A second mark in the same spell keeps the first moment.
    cache.markStale('2026-10-06T09:10:00.000Z');

    expect(cache.getSyncState()).toEqual({
      lastSuccessAt: '2026-10-06T08:00:00.000Z',
      lastError: 'Google is unreachable',
      staleSince: '2026-10-06T09:00:00.000Z',
      reconnectRequired: false,
    });

    cache.markReconnectRequired('Reconnect Google Calendar', '2026-10-06T09:15:00.000Z');
    expect(cache.getSyncState()).toMatchObject({
      lastError: 'Reconnect Google Calendar',
      reconnectRequired: true,
    });

    cache.replaceEvents([], '2026-10-06T09:20:00.000Z');
    expect(cache.getSyncState()).toEqual({
      lastSuccessAt: '2026-10-06T09:20:00.000Z',
      lastError: null,
      staleSince: null,
      reconnectRequired: false,
    });
    cache.close();
  });

  it('connecting another account drops the cached calendar; the same account keeps it', () => {
    const cache = new SqliteCalendarCache(':memory:');
    cache.recordConnected('rahul@linkt.ai', '2026-10-06T08:00:00.000Z');
    cache.replaceEvents([call()], '2026-10-06T08:00:05.000Z');
    cache.markReconnectRequired('Reconnect Google Calendar', '2026-10-06T08:05:00.000Z');

    // A new grant for the same account: the copy is still that account's calendar.
    cache.recordConnected('rahul@linkt.ai', '2026-10-06T08:10:00.000Z');
    expect(cache.listEvents()).toEqual([call()]);
    expect(cache.getSyncState()).toMatchObject({
      lastSuccessAt: '2026-10-06T08:00:05.000Z',
      reconnectRequired: false,
    });

    // Another account's events must never prompt under this one's name.
    cache.recordConnected('rahul@gmail.com', '2026-10-06T08:20:00.000Z');
    expect(cache.listEvents()).toEqual([]);
    expect(cache.getSyncState().lastSuccessAt).toBeNull();

    expect(cache.activeConnection()).toEqual({
      accountEmail: 'rahul@gmail.com',
      connectedAt: '2026-10-06T08:20:00.000Z',
      disconnectedAt: null,
    });
    expect(cache.listConnections('rahul@linkt.ai')).toEqual([
      {
        accountEmail: 'rahul@linkt.ai',
        connectedAt: '2026-10-06T08:00:00.000Z',
        disconnectedAt: '2026-10-06T08:10:00.000Z',
      },
      {
        accountEmail: 'rahul@linkt.ai',
        connectedAt: '2026-10-06T08:10:00.000Z',
        disconnectedAt: '2026-10-06T08:20:00.000Z',
      },
    ]);
    cache.close();
  });

  it('refuses an empty account name', () => {
    const cache = new SqliteCalendarCache(':memory:');
    expect(() => {
      cache.recordConnected('  ', '2026-10-06T08:00:00.000Z');
    }).toThrow(/account/);
    cache.close();
  });

  it('lets the prompt log open one runs row per awake stretch', () => {
    const cache = new SqliteCalendarCache(':memory:');
    const openRun = cache.database.prepare(
      'INSERT INTO runs (started_at, last_tick_at) VALUES (?, ?)',
    );
    // Launch, then a wake from sleep in the same app run: two rows, never one stretched over it.
    openRun.run('2026-10-06T08:00:00.000Z', '2026-10-06T08:30:00.000Z');
    openRun.run('2026-10-06T09:45:00.000Z', '2026-10-06T09:45:00.000Z');

    expect(countRows(cache, 'runs')).toBe(2);
    cache.close();
  });

  it('has the columns the prompt log and the streak query read', () => {
    const cache = new SqliteCalendarCache(':memory:');
    const columns = (table: string): string[] =>
      cache.database
        .prepare(`SELECT name FROM pragma_table_info('${table}') ORDER BY cid`)
        .all()
        .map((row) => String(row.name));

    expect(columns('prompts')).toEqual([
      'account_email',
      'key',
      'source',
      'event_id',
      'title',
      'scheduled_start',
      'shown_at',
      'shown_by',
      'action',
      'reason',
      'detail',
      'meeting_id',
      'decided_at',
      'excluded_reason',
    ]);
    expect(columns('runs')).toEqual(['id', 'started_at', 'last_tick_at']);
    expect(columns('connections_log')).toEqual([
      'id',
      'account_email',
      'connected_at',
      'disconnected_at',
    ]);
    cache.close();
  });

  it('refuses a prompt outcome the streak query does not know', () => {
    const cache = new SqliteCalendarCache(':memory:');
    expect(() =>
      cache.database
        .prepare(
          `INSERT INTO prompts (account_email, key, source, action) VALUES ('a', 'k', 'calendar', 'start')`,
        )
        .run(),
    ).toThrow(/CHECK/);
    cache.close();
  });

  it('keeps everything across a reopen of the same file', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'roger-calendar-')), 'calendar.sqlite');
    const first = new SqliteCalendarCache(path);
    first.recordConnected('rahul@linkt.ai', '2026-10-06T08:00:00.000Z');
    const events: CalendarEvent[] = [holiday(), call()];
    first.replaceEvents(events, '2026-10-06T08:00:05.000Z');
    first.close();

    const second = new SqliteCalendarCache(path);
    expect(second.listEvents()).toEqual(events);
    expect(second.activeConnection()?.accountEmail).toBe('rahul@linkt.ai');
    expect(Number(second.database.prepare('PRAGMA user_version').get()?.user_version)).toBe(1);
    second.close();
  });
});
