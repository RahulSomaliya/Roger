import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import {
  promptKey,
  toUtcInstant,
  type CalendarEvent,
  type CalendarSyncState,
} from '../../shared/calendar';

/**
 * `calendar.sqlite`: M5's own file, apart from `roger.sqlite`, with its own `user_version`, so the
 * calendar takes no number from the shared migration list and the prompt log is one `sqlite3`
 * away for the exit check (docs/plans/M5-calendar.md, "Desktop storage").
 *
 * Every table's schema lives here. This class reads and writes `events`, `fetch_state` and
 * `connections_log`; PromptLog (M5-T9a) writes `prompts` and `runs` through `database`. A connect
 * or disconnect is written through CalendarSync, never straight here (`recordConnected` says why).
 *
 * - `events`: the last good window from the API, replaced in one transaction on each poll.
 * - `fetch_state`: one row, the health of that copy. Gone while no calendar is connected.
 * - `connections_log`: every connect and disconnect. Never cleared.
 * - `prompts`: every prompt-worthy event and its outcome, per account. Never cleared: the 20-call
 *   streak (`apps/desktop/scripts/calendar-streak.sql`) is read from it.
 * - `runs`: one row per stretch Roger was awake (a launch, or a wake from sleep), with its last
 *   heartbeat. Never cleared.
 *
 * Every instant is stored as `YYYY-MM-DDTHH:MM:SS.sssZ`, so instants sort and compare as text.
 *
 * Ordered, forward-only migrations tracked with `PRAGMA user_version`. Add an entry for every
 * schema change; never edit an applied one.
 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE events (
    key TEXT PRIMARY KEY,
    position INTEGER NOT NULL,
    event_id TEXT NOT NULL,
    start_at TEXT,
    start_date TEXT,
    event_json TEXT NOT NULL,
    first_seen_at TEXT NOT NULL
  );
  CREATE TABLE fetch_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_success_at TEXT,
    last_error TEXT,
    stale_since TEXT,
    reconnect_required INTEGER NOT NULL DEFAULT 0 CHECK (reconnect_required IN (0, 1)),
    updated_at TEXT NOT NULL
  );
  CREATE TABLE connections_log (
    id INTEGER PRIMARY KEY,
    account_email TEXT NOT NULL,
    connected_at TEXT NOT NULL,
    disconnected_at TEXT
  );
  CREATE INDEX connections_log_by_account ON connections_log (account_email, connected_at);
  CREATE TABLE prompts (
    account_email TEXT NOT NULL,
    key TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('calendar', 'call_detected')),
    event_id TEXT,
    title TEXT,
    scheduled_start TEXT,
    shown_at TEXT,
    shown_by TEXT CHECK (shown_by IN ('calendar', 'call_detected')),
    action TEXT CHECK (action IN ('starting', 'started', 'joined_and_started', 'started_degraded',
                                  'start_failed', 'dismissed', 'expired', 'missed')),
    reason TEXT,
    detail TEXT,
    meeting_id TEXT,
    decided_at TEXT,
    excluded_reason TEXT,
    PRIMARY KEY (account_email, key)
  );
  CREATE TABLE runs (
    id INTEGER PRIMARY KEY,
    started_at TEXT NOT NULL,
    last_tick_at TEXT NOT NULL
  );
  `,
];

/** One `connections_log` row: an account connected, and when it stopped being, if it has. */
export interface ConnectionLogEntry {
  accountEmail: string;
  connectedAt: string;
  disconnectedAt: string | null;
}

/**
 * The `events` key: the prompt key (`<event id>@<start instant>`) for a timed event, so
 * `firstSeenAt` answers for a prompt; `<event id>@<start date>` for an all-day one, which never
 * prompts.
 */
export function cacheKey(event: CalendarEvent): string {
  return event.allDay ? `${event.id}@${event.startDate}` : promptKey(event);
}

type Row = Record<string, SQLOutputValue>;

const NO_SYNC_STATE: CalendarSyncState = {
  lastSuccessAt: null,
  lastError: null,
  staleSince: null,
  reconnectRequired: false,
};

export class SqliteCalendarCache {
  /**
   * The open connection, for the one other writer: PromptLog (M5-T9a) prepares its `prompts` and
   * `runs` statements on it. Sharing it keeps one file, one schema and one writer at a time.
   */
  readonly database: DatabaseSync;

  /** `path` may be `:memory:` for tests. */
  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA journal_mode = WAL');
    this.database.exec('PRAGMA synchronous = NORMAL');
    // The owner reads this file with `sqlite3` while Roger runs; a reader must not fail a poll.
    this.database.exec('PRAGMA busy_timeout = 5000');
    this.migrate();
  }

  // events ---------------------------------------------------------------------------------------

  /**
   * Replace the copy with one answer from the API and record the success, in one transaction: the
   * list and the time it is from never disagree. An event the answer no longer holds (deleted,
   * moved, out of the window) goes; a key seen before keeps its `first_seen_at`, which tells a
   * missed prompt's `api_stale` from `policy` (reminderPolicy.ts `missedReason`). Throws, writing
   * nothing, when an event cannot be keyed (a start that is not an instant).
   */
  replaceEvents(events: readonly CalendarEvent[], fetchedAt: string): void {
    const at = toUtcInstant(fetchedAt);
    const rows = events.map((event, position) => ({
      key: cacheKey(event),
      position,
      eventId: event.id,
      startAt: event.allDay ? null : toUtcInstant(event.start),
      startDate: event.allDay ? event.startDate : null,
      json: JSON.stringify(event),
    }));
    this.transaction(() => {
      const firstSeen = new Map(
        this.database
          .prepare('SELECT key, first_seen_at FROM events')
          .all()
          .map((row) => [text(row, 'key'), text(row, 'first_seen_at')]),
      );
      this.database.exec('DELETE FROM events');
      // The same instance twice in one answer is one event: the first copy stays.
      const insert = this.database.prepare(
        `INSERT INTO events (key, position, event_id, start_at, start_date, event_json, first_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (key) DO NOTHING`,
      );
      for (const row of rows) {
        insert.run(
          row.key,
          row.position,
          row.eventId,
          row.startAt,
          row.startDate,
          row.json,
          firstSeen.get(row.key) ?? at,
        );
      }
      this.database
        .prepare(
          `INSERT INTO fetch_state (id, last_success_at, last_error, stale_since, reconnect_required, updated_at)
           VALUES (1, :at, NULL, NULL, 0, :at)
           ON CONFLICT (id) DO UPDATE SET
             last_success_at = :at, last_error = NULL, stale_since = NULL,
             reconnect_required = 0, updated_at = :at`,
        )
        .run({ at });
    });
  }

  /** The cached events, in the API's order (by start). */
  listEvents(): CalendarEvent[] {
    return (
      this.database
        .prepare('SELECT event_json FROM events ORDER BY position ASC')
        .all()
        // Written by replaceEvents from a typed CalendarEvent; the cast restores that type.
        .map((row) => JSON.parse(text(row, 'event_json')) as CalendarEvent)
    );
  }

  /**
   * When the event with this key first reached the copy, or null when it is not in it: never
   * cached, or dropped by a later answer (only the catch-up fetch at launch saw it).
   */
  firstSeenAt(key: string): string | null {
    const row = this.database.prepare('SELECT first_seen_at FROM events WHERE key = ?').get(key);
    return row === undefined ? null : text(row, 'first_seen_at');
  }

  // fetch_state ----------------------------------------------------------------------------------

  /** The copy's health; all empty while no calendar is connected or before the first answer. */
  getSyncState(): CalendarSyncState {
    const row = this.database.prepare('SELECT * FROM fetch_state WHERE id = 1').get();
    if (row === undefined) return { ...NO_SYNC_STATE };
    return {
      lastSuccessAt: optionalText(row, 'last_success_at'),
      lastError: optionalText(row, 'last_error'),
      staleSince: optionalText(row, 'stale_since'),
      reconnectRequired: Number(row.reconnect_required) === 1,
    };
  }

  /** A poll failed. The events and the time of the last success stay as they were. */
  recordFailure(error: string, at: string): void {
    this.writeError(error, false, at);
  }

  /** Google refused the stored grant (`424`): polling stops until the next connect. */
  markReconnectRequired(error: string, at: string): void {
    this.writeError(error, true, at);
  }

  /** The copy turned stale at `since`. A spell keeps its first moment until the next success. */
  markStale(since: string): void {
    const at = toUtcInstant(since);
    this.database
      .prepare(
        `INSERT INTO fetch_state (id, stale_since, updated_at) VALUES (1, :at, :at)
         ON CONFLICT (id) DO UPDATE SET
           stale_since = COALESCE(stale_since, :at), updated_at = :at`,
      )
      .run({ at });
  }

  // connections_log ------------------------------------------------------------------------------

  /**
   * An account connected. Any open row is closed at the same moment. A grant for the same account
   * keeps the copy, which is still that account's calendar, and clears a refused-grant mark;
   * another account, or none before, starts from an empty copy, so one account's events never
   * prompt under another's name.
   *
   * Settings → Connect (M5-T6) calls `CalendarSync.connected`, never this: called straight, an
   * answer already on its way for the old account lands in the new account's empty copy, and a
   * refused grant's stopped polling never restarts.
   */
  recordConnected(accountEmail: string, at: string): void {
    const account = accountEmail.trim();
    if (account === '') throw new Error('cannot record a calendar connection without an account');
    const connectedAt = toUtcInstant(at);
    this.transaction(() => {
      const open = this.activeConnection();
      if (open?.accountEmail === account) {
        this.database
          .prepare('UPDATE fetch_state SET reconnect_required = 0, updated_at = ? WHERE id = 1')
          .run(connectedAt);
      } else {
        this.clearCopy();
      }
      this.closeOpenConnections(connectedAt);
      this.database
        .prepare('INSERT INTO connections_log (account_email, connected_at) VALUES (?, ?)')
        .run(account, connectedAt);
    });
  }

  /**
   * The calendar was disconnected. Clears `events` and `fetch_state` only: the log, the prompts
   * and the runs are the exit check's evidence and survive a disconnect.
   *
   * Settings → Disconnect (M5-T6) calls `CalendarSync.disconnected`, never this: called straight,
   * a poll already on its way writes the disconnected account's events and a fresh `fetch_state`
   * row straight back, and the polling goes on, so prompts keep coming from a calendar the user
   * just disconnected.
   */
  recordDisconnected(at: string): void {
    const disconnectedAt = toUtcInstant(at);
    this.transaction(() => {
      this.closeOpenConnections(disconnectedAt);
      this.clearCopy();
    });
  }

  /** The connection in force, or null while none is. */
  activeConnection(): ConnectionLogEntry | null {
    const row = this.database
      .prepare(
        `SELECT * FROM connections_log WHERE disconnected_at IS NULL
         ORDER BY connected_at DESC, id DESC LIMIT 1`,
      )
      .get();
    return row === undefined ? null : rowToConnection(row);
  }

  /** Every connection of one account, oldest first: when it could have been prompted. */
  listConnections(accountEmail: string): ConnectionLogEntry[] {
    return this.database
      .prepare(
        `SELECT * FROM connections_log WHERE account_email = ?
         ORDER BY connected_at ASC, id ASC`,
      )
      .all(accountEmail)
      .map(rowToConnection);
  }

  close(): void {
    this.database.close();
  }

  private clearCopy(): void {
    this.database.exec('DELETE FROM events');
    this.database.exec('DELETE FROM fetch_state');
  }

  private closeOpenConnections(at: string): void {
    this.database
      .prepare('UPDATE connections_log SET disconnected_at = ? WHERE disconnected_at IS NULL')
      .run(at);
  }

  /** Only a success or a new grant clears the refused-grant mark; a later failure keeps it. */
  private writeError(error: string, reconnectRequired: boolean, at: string): void {
    this.database
      .prepare(
        `INSERT INTO fetch_state (id, last_error, reconnect_required, updated_at)
         VALUES (1, :error, :reconnect, :at)
         ON CONFLICT (id) DO UPDATE SET
           last_error = :error,
           reconnect_required = MAX(reconnect_required, :reconnect),
           updated_at = :at`,
      )
      .run({ error, reconnect: reconnectRequired ? 1 : 0, at: toUtcInstant(at) });
  }

  private migrate(): void {
    const current = Number(this.database.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    for (let version = current; version < MIGRATIONS.length; version += 1) {
      this.transaction(() => {
        this.database.exec(MIGRATIONS[version] ?? '');
        this.database.exec(`PRAGMA user_version = ${version + 1}`);
      });
    }
  }

  private transaction(work: () => void): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      work();
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

function rowToConnection(row: Row): ConnectionLogEntry {
  return {
    accountEmail: text(row, 'account_email'),
    connectedAt: text(row, 'connected_at'),
    disconnectedAt: optionalText(row, 'disconnected_at'),
  };
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`corrupt calendar row: ${key} is ${typeof value}`);
  return value;
}

function optionalText(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error(`corrupt calendar row: ${key} is ${typeof value}`);
  return value;
}
