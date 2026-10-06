import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { promptKey, type TimedCalendarEvent } from '../../shared/calendar';
import { NO_ACCOUNT, PromptLog, type PromptAction, type PromptOutcome } from './PromptLog';
import { SqliteCalendarCache } from './SqliteCalendarCache';

const ACCOUNT = 'rahul@linkt.ai';

function call(overrides: Partial<TimedCalendarEvent> = {}): TimedCalendarEvent {
  return {
    provider: 'fake',
    id: 'call_1',
    icalUid: 'call_1@google.com',
    recurringEventId: null,
    title: 'Sync with Jane',
    status: 'confirmed',
    allDay: false,
    start: '2026-10-06T11:00:00+02:00',
    end: '2026-10-06T11:30:00+02:00',
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

function open(): { cache: SqliteCalendarCache; log: PromptLog } {
  const cache = new SqliteCalendarCache(':memory:');
  return { cache, log: new PromptLog(cache.database) };
}

/** A shown, unanswered calendar prompt for `call()`. */
function shown(log: PromptLog, event = call()): string {
  log.recordShown({
    accountEmail: ACCOUNT,
    event,
    shownBy: 'calendar',
    at: '2026-10-06T08:59:00.000Z',
  });
  return promptKey(event);
}

describe('PromptLog prompts', () => {
  it('logs a shown prompt once per account and key, with the event as it was shown', () => {
    const { log } = open();
    const event = call();
    const key = promptKey(event);

    expect(
      log.recordShown({
        accountEmail: ACCOUNT,
        event,
        shownBy: 'calendar',
        at: '2026-10-06T08:59:00Z',
      }),
    ).toBe(true);
    // A second card for the same event (a restart, a detected call) never adds a row.
    expect(
      log.recordShown({
        accountEmail: ACCOUNT,
        event: call({ title: 'Renamed' }),
        shownBy: 'call_detected',
        at: '2026-10-06T09:01:00Z',
      }),
    ).toBe(false);

    expect(log.get(ACCOUNT, key)).toEqual({
      accountEmail: ACCOUNT,
      key: 'call_1@2026-10-06T09:00:00.000Z',
      source: 'calendar',
      eventId: 'call_1',
      title: 'Sync with Jane',
      scheduledStart: '2026-10-06T09:00:00.000Z',
      shownAt: '2026-10-06T08:59:00.000Z',
      shownBy: 'calendar',
      action: null,
      reason: null,
      detail: null,
      meetingId: null,
      decidedAt: null,
      excludedReason: null,
    });
    expect(log.get('rahul@gmail.com', key)).toBeNull();
  });

  it('answers which of the given keys already have a row, for one account', () => {
    const { log } = open();
    const first = shown(log, call({ id: 'a' }));
    log.recordMissed({
      accountEmail: ACCOUNT,
      event: call({ id: 'b' }),
      reason: 'not_running',
      detail: null,
      at: '2026-10-06T09:11:00Z',
    });
    log.recordShown({
      accountEmail: 'rahul@gmail.com',
      event: call({ id: 'c' }),
      shownBy: 'calendar',
      at: '2026-10-06T08:59:00Z',
    });

    const asked = [first, promptKey(call({ id: 'b' })), promptKey(call({ id: 'c' })), 'd@x'];
    expect([...log.loggedKeys(ACCOUNT, asked)].sort()).toEqual([
      first,
      promptKey(call({ id: 'b' })),
    ]);
    expect(log.loggedKeys(ACCOUNT, [])).toEqual(new Set());
  });

  it('logs a start as starting, then its outcome with the meeting', () => {
    const { log } = open();
    const key = shown(log);

    expect(
      log.recordAction({
        accountEmail: ACCOUNT,
        key,
        action: 'starting',
        at: '2026-10-06T08:59:30Z',
        meetingId: '6c1b4c6e-8f4e-4f43-9d7c-2b0b8a3f0a11',
      }),
    ).toBe(true);
    expect(
      log.recordAction({
        accountEmail: ACCOUNT,
        key,
        action: 'started',
        at: '2026-10-06T08:59:40Z',
      }),
    ).toBe(true);

    expect(log.get(ACCOUNT, key)).toMatchObject({
      action: 'started',
      decidedAt: '2026-10-06T08:59:40.000Z',
      // An outcome without a meeting id keeps the one the start logged.
      meetingId: '6c1b4c6e-8f4e-4f43-9d7c-2b0b8a3f0a11',
      reason: null,
    });
  });

  it('keeps a degraded start with the source that failed', () => {
    const { log } = open();
    const key = shown(log);
    log.recordAction({
      accountEmail: ACCOUNT,
      key,
      action: 'starting',
      at: '2026-10-06T08:59:30Z',
    });

    log.recordAction({
      accountEmail: ACCOUNT,
      key,
      action: 'started_degraded',
      at: '2026-10-06T08:59:50Z',
      reason: 'system',
      detail: 'no call audio within 20 s',
    });

    expect(log.get(ACCOUNT, key)).toMatchObject({
      action: 'started_degraded',
      reason: 'system',
      detail: 'no call audio within 20 s',
    });
  });

  it('never lets a late action overwrite a settled outcome', () => {
    const { log } = open();
    const key = shown(log);
    log.recordAction({
      accountEmail: ACCOUNT,
      key,
      action: 'starting',
      at: '2026-10-06T09:09:55Z',
    });

    // The card's expiry fires while the start is still settling: the start's outcome wins.
    expect(
      log.recordAction({
        accountEmail: ACCOUNT,
        key,
        action: 'expired',
        at: '2026-10-06T09:10:00Z',
      }),
    ).toBe(false);
    log.recordAction({ accountEmail: ACCOUNT, key, action: 'started', at: '2026-10-06T09:10:05Z' });

    const settled: PromptOutcome[] = [
      'starting',
      'dismissed',
      'expired',
      'start_failed',
      'started',
    ];
    for (const action of settled) {
      expect(
        log.recordAction({ accountEmail: ACCOUNT, key, action, at: '2026-10-06T09:11:00Z' }),
      ).toBe(false);
    }
    expect(log.get(ACCOUNT, key)).toMatchObject({
      action: 'started',
      decidedAt: '2026-10-06T09:10:05.000Z',
    });
  });

  it('lets a failed start be tried again, and keeps the failure when the card then goes', () => {
    const { log } = open();
    const key = shown(log);
    log.recordAction({
      accountEmail: ACCOUNT,
      key,
      action: 'starting',
      at: '2026-10-06T08:59:30Z',
    });
    log.recordAction({
      accountEmail: ACCOUNT,
      key,
      action: 'start_failed',
      at: '2026-10-06T08:59:31Z',
      reason: 'microphone denied',
    });

    // Dismissing the card after a failure would hide the capture problem the log is evidence of.
    expect(
      log.recordAction({
        accountEmail: ACCOUNT,
        key,
        action: 'dismissed',
        at: '2026-10-06T09:00:00Z',
      }),
    ).toBe(false);
    expect(log.get(ACCOUNT, key)).toMatchObject({
      action: 'start_failed',
      reason: 'microphone denied',
    });

    expect(
      log.recordAction({
        accountEmail: ACCOUNT,
        key,
        action: 'starting',
        at: '2026-10-06T09:01:00Z',
      }),
    ).toBe(true);
    log.recordAction({ accountEmail: ACCOUNT, key, action: 'started', at: '2026-10-06T09:01:10Z' });
    expect(log.get(ACCOUNT, key)).toMatchObject({ action: 'started', reason: null });
  });

  it('refuses an action for a prompt it never logged, naming the key', () => {
    const { log } = open();
    expect(() =>
      log.recordAction({
        accountEmail: ACCOUNT,
        key: 'gone@x',
        action: 'dismissed',
        at: '2026-10-06T09:00:00Z',
      }),
    ).toThrow(/gone@x/);
  });

  it('logs a missed prompt with its reason, never over a row that is already there', () => {
    const { log } = open();
    const key = shown(log);
    const missed = call({ id: 'missed_1', title: '' });

    expect(
      log.recordMissed({
        accountEmail: ACCOUNT,
        event: missed,
        reason: 'policy',
        detail: 'declined',
        at: '2026-10-06T09:11:00Z',
      }),
    ).toBe(true);
    expect(
      log.recordMissed({
        accountEmail: ACCOUNT,
        event: call(),
        reason: 'not_running',
        detail: null,
        at: '2026-10-06T09:11:00Z',
      }),
    ).toBe(false);

    expect(log.get(ACCOUNT, promptKey(missed))).toMatchObject({
      source: 'calendar',
      title: '',
      scheduledStart: '2026-10-06T09:00:00.000Z',
      shownAt: null,
      shownBy: null,
      action: 'missed',
      reason: 'policy',
      detail: 'declined',
      decidedAt: '2026-10-06T09:11:00.000Z',
    });
    expect(log.get(ACCOUNT, key)?.action).toBeNull();
  });

  it('logs a detected call with no calendar connected under the empty account', () => {
    const { log } = open();
    const app = { bundleId: 'us.zoom.xos', name: 'Zoom' };

    const key = log.recordCallDetected({ accountEmail: null, app, at: '2026-10-06T09:00:00Z' });

    expect(log.get(NO_ACCOUNT, key)).toMatchObject({
      accountEmail: '',
      source: 'call_detected',
      eventId: null,
      title: 'Zoom',
      scheduledStart: null,
      shownAt: '2026-10-06T09:00:00.000Z',
      shownBy: 'call_detected',
      action: null,
    });
    log.recordAction({
      accountEmail: NO_ACCOUNT,
      key,
      action: 'dismissed',
      at: '2026-10-06T09:00:10Z',
    });
    expect(log.get(NO_ACCOUNT, key)?.action).toBe('dismissed');
  });

  it('refuses a calendar prompt without an account', () => {
    const { log } = open();
    expect(() =>
      log.recordShown({
        accountEmail: ' ',
        event: call(),
        shownBy: 'calendar',
        at: '2026-10-06T09:00:00Z',
      }),
    ).toThrow(/account/);
  });

  it('at launch, a crashed start fails and every unanswered card expires, both for app_exit', () => {
    const { log } = open();
    const crashed = shown(log, call({ id: 'crashed' }));
    log.recordAction({
      accountEmail: ACCOUNT,
      key: crashed,
      action: 'starting',
      at: '2026-10-06T08:59:30Z',
    });
    const closed = shown(log, call({ id: 'closed' }));
    // Still in its window, but the card left with the app, and a restart never shows a prompt twice.
    const stillOpen = shown(
      log,
      call({ id: 'open', start: '2026-10-06T12:00:00Z', end: '2026-10-06T12:30:00Z' }),
    );
    const done = shown(log, call({ id: 'done' }));
    log.recordAction({
      accountEmail: ACCOUNT,
      key: done,
      action: 'dismissed',
      at: '2026-10-06T09:00:00Z',
    });
    const called = log.recordCallDetected({
      accountEmail: ACCOUNT,
      app: { bundleId: 'us.zoom.xos', name: 'Zoom' },
      at: '2026-10-06T10:00:00Z',
    });

    expect(log.settleAfterExit('2026-10-06T12:05:00Z')).toEqual({ startFailed: 1, expired: 3 });

    expect(log.get(ACCOUNT, crashed)).toMatchObject({
      action: 'start_failed',
      reason: 'app_exit',
      decidedAt: '2026-10-06T12:05:00.000Z',
    });
    for (const key of [closed, stillOpen, called]) {
      expect(log.get(ACCOUNT, key)).toMatchObject({ action: 'expired', reason: 'app_exit' });
    }
    expect(log.get(ACCOUNT, done)).toMatchObject({ action: 'dismissed', reason: null });
  });
});

describe('PromptLog runs', () => {
  it('opens a run, moves its heartbeat, and answers the last tick of any run', () => {
    const { log } = open();
    expect(log.lastTickAt()).toBeNull();

    log.openRun('2026-10-06T08:00:00Z');
    log.heartbeat('2026-10-06T08:00:10Z');
    log.heartbeat('2026-10-06T09:00:00Z');
    // A wake: the next stretch is its own row, so the sleep between is covered by neither.
    log.openRun('2026-10-06T17:00:00Z');
    log.heartbeat('2026-10-06T17:00:10Z');

    expect(log.lastTickAt()).toBe('2026-10-06T17:00:10.000Z');
    expect(log.runsSince('2026-10-06T00:00:00Z')).toEqual([
      { startedAt: '2026-10-06T08:00:00.000Z', lastTickAt: '2026-10-06T09:00:00.000Z' },
      { startedAt: '2026-10-06T17:00:00.000Z', lastTickAt: '2026-10-06T17:00:10.000Z' },
    ]);
    // Only runs still ticking at or after the moment can cover it.
    expect(log.runsSince('2026-10-06T10:00:00Z')).toEqual([
      { startedAt: '2026-10-06T17:00:00.000Z', lastTickAt: '2026-10-06T17:00:10.000Z' },
    ]);
  });

  it('refuses a heartbeat before a run is open', () => {
    const { log } = open();
    expect(() => {
      log.heartbeat('2026-10-06T08:00:10Z');
    }).toThrow(/run/);
  });
});

// ---------------------------------------------------------------------------------------------
// calendar-streak.sql: the owner's exit-check query, run here from the file itself.

const STREAK_SQL = readFileSync(
  fileURLToPath(new URL('../../../scripts/calendar-streak.sql', import.meta.url)),
  'utf8',
);

const HOUR = 60 * 60_000;

interface StreakRow {
  account?: string;
  /** Hours before now; the query reads SQLite's own clock, so these are real instants. */
  hoursAgo: number;
  action: PromptAction | null;
  source?: 'calendar' | 'call_detected';
  excluded?: string;
}

interface StreakResult {
  streak: number;
  since: string | null;
  /** Each row's `scheduled_start`, in the order given. */
  starts: string[];
}

function streak(rows: readonly StreakRow[]): StreakResult {
  const cache = new SqliteCalendarCache(':memory:');
  const now = Date.now();
  // The streak counts only the latest account's calls.
  cache.recordConnected('rahul@gmail.com', new Date(now - 30 * 24 * HOUR).toISOString());
  cache.recordConnected(ACCOUNT, new Date(now - 20 * 24 * HOUR).toISOString());
  const insert = cache.database.prepare(
    `INSERT INTO prompts (account_email, key, source, scheduled_start, action, excluded_reason)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const starts = rows.map((row, index) => {
    const start = new Date(now - row.hoursAgo * HOUR).toISOString();
    insert.run(
      row.account ?? ACCOUNT,
      `event_${index}@x`,
      row.source ?? 'calendar',
      start,
      row.action,
      row.excluded ?? null,
    );
    return start;
  });
  // Dot-commands (`.mode line`) are for the sqlite3 shell the owner runs; SQLite itself refuses
  // them. `prepare` runs only the first statement, so the file must hold exactly one.
  const sql = STREAK_SQL.split('\n')
    .filter((line) => !line.startsWith('.'))
    .join('\n');
  const result = cache.database.prepare(sql).get();
  cache.close();
  const since = result?.since;
  return {
    streak: Number(result?.streak),
    since: typeof since === 'string' ? since : null,
    starts,
  };
}

const startedRows = (count: number, fromHoursAgo: number): StreakRow[] =>
  Array.from({ length: count }, (_, index) => ({
    hoursAgo: fromHoursAgo - index,
    action: 'started' as const,
  }));

describe('calendar-streak.sql', () => {
  it('counts 20 started calls as a streak of 20, since the first', () => {
    const result = streak(startedRows(20, 100));
    expect(result.streak).toBe(20);
    expect(result.since).toBe(result.starts[0]);
  });

  it('counts joined_and_started like started', () => {
    expect(
      streak([...startedRows(2, 10), { hoursAgo: 5, action: 'joined_and_started' }]).streak,
    ).toBe(3);
  });

  it.each<PromptAction | null>([
    'missed',
    'dismissed',
    'started_degraded',
    'start_failed',
    'expired',
    null,
  ])('restarts at a %s row', (action) => {
    const rows = [...startedRows(5, 50), { hoursAgo: 40, action }, ...startedRows(3, 30)];
    const result = streak(rows);
    expect(result.streak).toBe(3);
    expect(result.since).toBe(result.starts[6]);
  });

  it('skips a row marked by hand as not a call', () => {
    const rows = [
      ...startedRows(3, 50),
      { hoursAgo: 40, action: 'missed' as const, excluded: 'no-show' },
      ...startedRows(2, 30),
    ];
    expect(streak(rows).streak).toBe(5);
  });

  it("ignores detected calls and the other account's rows", () => {
    const rows: StreakRow[] = [
      ...startedRows(3, 50),
      { hoursAgo: 45, action: 'dismissed', source: 'call_detected' },
      { hoursAgo: 44, action: 'started', source: 'call_detected' },
      { hoursAgo: 43, action: 'missed', account: 'rahul@gmail.com' },
      { hoursAgo: 42, action: 'started', account: 'rahul@gmail.com' },
      { hoursAgo: 41, action: null, account: NO_ACCOUNT, source: 'call_detected' },
      ...startedRows(2, 30),
    ];
    expect(streak(rows).streak).toBe(5);
  });

  it('ignores prompts still open (start + 10 min not passed)', () => {
    const rows: StreakRow[] = [
      ...startedRows(4, 50),
      { hoursAgo: 5 / 60, action: null },
      { hoursAgo: 2 / 60, action: 'started' },
    ];
    expect(streak(rows).streak).toBe(4);
  });

  it('is 0 with nothing logged', () => {
    expect(streak([])).toEqual({ streak: 0, since: null, starts: [] });
  });

  it('holds exactly one SQL statement', () => {
    const statements = STREAK_SQL.split('\n')
      .filter((line) => !line.startsWith('.') && !line.trimStart().startsWith('--'))
      .join('\n')
      .split(';')
      .filter((part) => part.trim() !== '');
    expect(statements).toHaveLength(1);
  });
});
