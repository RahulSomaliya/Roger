import type { DatabaseSync, SQLOutputValue, StatementSync } from 'node:sqlite';
import {
  promptKey,
  toUtcInstant,
  type CallApp,
  type PromptShownBy,
  type TimedCalendarEvent,
} from '../../shared/calendar';
import type { MissedReason } from './reminderPolicy';

/**
 * The prompt log and the run log in `calendar.sqlite` (schema in SqliteCalendarCache.ts): the
 * exit check's evidence, so neither is ever cleared or deleted from, Disconnect included.
 *
 * - `prompts`: one row per account and prompt key. Every prompt-worthy calendar event gets one:
 *   shown (PromptService, M5-T9b, writes it as the card goes up) and then its outcome, or `missed`
 *   with a reason (ReminderScheduler, once start + 10 min has passed with no row). A detected call
 *   with no event gets a `call_detected` row, which never counts toward the streak. The owner's
 *   streak query is `apps/desktop/scripts/calendar-streak.sql`.
 * - `runs`: one row per stretch Roger was awake, from a launch or a wake to its last heartbeat
 *   tick. `missedReason` (reminderPolicy.ts) reads "Roger was running" from these rows, so a row
 *   must never span a sleep: the scheduler opens a new one on each wake.
 *
 * Every instant is stored as `YYYY-MM-DDTHH:MM:SS.sssZ` (`toUtcInstant`), so they compare as text.
 * The statements run on the cache's connection (`SqliteCalendarCache.database`): one file, one
 * writer at a time.
 */

/** Every outcome a `prompts` row can hold (`action`); null while a shown card is unanswered. */
export type PromptAction =
  | 'starting'
  | 'started'
  | 'joined_and_started'
  | 'started_degraded'
  | 'start_failed'
  | 'dismissed'
  | 'expired'
  | 'missed';

/** What a shown card's actions log (`recordAction`); `missed` is only ever written by a sweep. */
export type PromptOutcome = Exclude<PromptAction, 'missed'>;

/**
 * The account of a `call_detected` row logged while no calendar is connected: `account_email` is
 * NOT NULL, and a detected call needs no calendar.
 */
export const NO_ACCOUNT = '';

/** Why a row was settled at launch: the run that showed it ended first (quit or crash). */
export const APP_EXIT_REASON = 'app_exit';

export interface PromptRow {
  accountEmail: string;
  key: string;
  source: 'calendar' | 'call_detected';
  eventId: string | null;
  title: string | null;
  scheduledStart: string | null;
  shownAt: string | null;
  shownBy: PromptShownBy | null;
  action: PromptAction | null;
  /** `missed`: a `MissedReason`. `started_degraded`: the source that failed. Else free text. */
  reason: string | null;
  detail: string | null;
  meetingId: string | null;
  decidedAt: string | null;
  /** Set by hand (the exit check): not a call that took place. */
  excludedReason: string | null;
}

/** One `runs` row: a stretch Roger was awake. */
export interface RunSpan {
  startedAt: string;
  lastTickAt: string;
}

/** The row state each outcome may follow; `open` is a shown card nobody answered yet. */
type RowState = PromptAction | 'open';

/**
 * A start is `starting` until both sources deliver (then `started`, `joined_and_started` or
 * `started_degraded`) or it fails (`start_failed`, after which the card stays and the user may try
 * again). Everything else is final. Checked in the UPDATE itself: a card's expiry that fires while
 * a start is settling, or a Dismiss after a failed start, must not overwrite the outcome the
 * streak and the capture evidence are read from.
 */
const ALLOWED_FROM: Readonly<Record<PromptOutcome, readonly RowState[]>> = {
  starting: ['open', 'start_failed'],
  started: ['starting'],
  joined_and_started: ['starting'],
  started_degraded: ['starting'],
  start_failed: ['starting'],
  dismissed: ['open'],
  expired: ['open'],
};

export interface ShownCalendarPrompt {
  accountEmail: string;
  event: TimedCalendarEvent;
  /** The reminder put the card up, or a detected call that matched the event (D5 rule 3). */
  shownBy: PromptShownBy;
  at: string;
}

export interface ShownCallDetectedPrompt {
  /** The connected account, or null while none is (logged as `NO_ACCOUNT`). */
  accountEmail: string | null;
  app: CallApp;
  at: string;
}

export interface PromptActionEntry {
  accountEmail: string;
  key: string;
  action: PromptOutcome;
  at: string;
  /** Replaces the row's reason (null clears it). */
  reason?: string | null;
  detail?: string | null;
  /** Kept when left out: an outcome need not repeat the meeting its start logged. */
  meetingId?: string | null;
}

export interface MissedPrompt {
  accountEmail: string;
  event: TimedCalendarEvent;
  reason: MissedReason;
  /** For `policy`, the rule that last kept the event from prompting, when one did. */
  detail: string | null;
  at: string;
}

type Row = Record<string, SQLOutputValue>;

export class PromptLog {
  private readonly statements: {
    insertShown: StatementSync;
    insertMissed: StatementSync;
    updateAction: StatementSync;
    selectRow: StatementSync;
    selectLoggedKeys: StatementSync;
    settleStarting: StatementSync;
    settleUnanswered: StatementSync;
    insertRun: StatementSync;
    updateRun: StatementSync;
    selectLastTick: StatementSync;
    selectRunsSince: StatementSync;
  };
  /** The `runs` row this stretch writes its heartbeat to; null until `openRun`. */
  private runId: number | bigint | null = null;

  constructor(private readonly database: DatabaseSync) {
    this.statements = {
      insertShown: database.prepare(
        `INSERT INTO prompts (account_email, key, source, event_id, title, scheduled_start,
                              shown_at, shown_by)
         VALUES (:account, :key, :source, :eventId, :title, :scheduledStart, :at, :shownBy)
         ON CONFLICT (account_email, key) DO NOTHING`,
      ),
      insertMissed: database.prepare(
        `INSERT INTO prompts (account_email, key, source, event_id, title, scheduled_start,
                              action, reason, detail, decided_at)
         VALUES (:account, :key, 'calendar', :eventId, :title, :scheduledStart,
                 'missed', :reason, :detail, :at)
         ON CONFLICT (account_email, key) DO NOTHING`,
      ),
      updateAction: database.prepare(
        `UPDATE prompts SET action = :action, decided_at = :at, reason = :reason, detail = :detail,
                            meeting_id = COALESCE(:meetingId, meeting_id)
         WHERE account_email = :account AND key = :key
           AND IFNULL(action, 'open') IN (SELECT value FROM json_each(:allowedFrom))`,
      ),
      selectRow: database.prepare('SELECT * FROM prompts WHERE account_email = ? AND key = ?'),
      selectLoggedKeys: database.prepare(
        `SELECT key FROM prompts
         WHERE account_email = ? AND key IN (SELECT value FROM json_each(?))`,
      ),
      settleStarting: database.prepare(
        `UPDATE prompts SET action = 'start_failed', reason = :reason, detail = NULL, decided_at = :at
         WHERE action = 'starting'`,
      ),
      settleUnanswered: database.prepare(
        `UPDATE prompts SET action = 'expired', reason = :reason, detail = NULL, decided_at = :at
         WHERE action IS NULL`,
      ),
      insertRun: database.prepare('INSERT INTO runs (started_at, last_tick_at) VALUES (?, ?)'),
      updateRun: database.prepare('UPDATE runs SET last_tick_at = ? WHERE id = ?'),
      selectLastTick: database.prepare('SELECT MAX(last_tick_at) AS at FROM runs'),
      selectRunsSince: database.prepare(
        `SELECT started_at, last_tick_at FROM runs WHERE last_tick_at >= ?
         ORDER BY started_at ASC, id ASC`,
      ),
    };
  }

  // prompts --------------------------------------------------------------------------------------

  /**
   * A calendar card went up for `event`. Returns false, writing nothing, when the key already has a
   * row for the account: a prompt is logged, and shown, once.
   */
  recordShown({ accountEmail, event, shownBy, at }: ShownCalendarPrompt): boolean {
    const result = this.statements.insertShown.run({
      account: requireAccount(accountEmail),
      key: promptKey(event),
      source: 'calendar',
      eventId: event.id,
      title: event.title,
      scheduledStart: toUtcInstant(event.start),
      at: toUtcInstant(at),
      shownBy,
    });
    return Number(result.changes) > 0;
  }

  /** A call-detected card with no event went up. Returns its key, for its actions. */
  recordCallDetected({ accountEmail, app, at }: ShownCallDetectedPrompt): string {
    const shownAt = toUtcInstant(at);
    const key = `call_detected:${app.bundleId}@${shownAt}`;
    this.statements.insertShown.run({
      account: accountEmail ?? NO_ACCOUNT,
      key,
      source: 'call_detected',
      eventId: null,
      title: app.name,
      scheduledStart: null,
      at: shownAt,
      shownBy: 'call_detected',
    });
    return key;
  }

  /**
   * Log what the user did with a card, or how a start ended. Returns false, writing nothing, when
   * the row's outcome does not allow it (see ALLOWED_FROM): a late expiry after a start, a second
   * Dismiss. Throws when the key has no row for the account: an action on a card that was never
   * logged would leave the streak without its evidence.
   */
  recordAction({
    accountEmail,
    key,
    action,
    at,
    reason = null,
    detail = null,
    meetingId = null,
  }: PromptActionEntry): boolean {
    const result = this.statements.updateAction.run({
      account: accountEmail,
      key,
      action,
      at: toUtcInstant(at),
      reason,
      detail,
      meetingId,
      allowedFrom: JSON.stringify(ALLOWED_FROM[action]),
    });
    if (Number(result.changes) > 0) return true;
    if (this.get(accountEmail, key) === null) {
      throw new Error(
        `cannot log ${action} for prompt ${key} (account "${accountEmail}"): it was never logged`,
      );
    }
    return false;
  }

  /** The event passed its window with no row. Returns false when a row arrived meanwhile. */
  recordMissed({ accountEmail, event, reason, detail, at }: MissedPrompt): boolean {
    const result = this.statements.insertMissed.run({
      account: requireAccount(accountEmail),
      key: promptKey(event),
      eventId: event.id,
      title: event.title,
      scheduledStart: toUtcInstant(event.start),
      reason,
      detail,
      at: toUtcInstant(at),
    });
    return Number(result.changes) > 0;
  }

  /** The keys among `keys` that already have a row for the account, whatever its outcome. */
  loggedKeys(accountEmail: string, keys: readonly string[]): Set<string> {
    if (keys.length === 0) return new Set();
    return new Set(
      this.statements.selectLoggedKeys
        .all(accountEmail, JSON.stringify(keys))
        .map((row) => text(row, 'key')),
    );
  }

  get(accountEmail: string, key: string): PromptRow | null {
    const row = this.statements.selectRow.get(accountEmail, key);
    return row === undefined ? null : rowToPrompt(row);
  }

  /**
   * At launch, before this run shows anything: a `starting` row is a start the last run never saw
   * end (a crash or a quit mid-start), so it failed; a shown card with no answer went away with
   * that run, so it expired. Both get reason `app_exit`. Every unanswered card is settled, not only
   * those whose window has closed: a restart never shows a prompt twice, so nothing else would
   * ever answer one still in its window.
   */
  settleAfterExit(at: string): { startFailed: number; expired: number } {
    const params = { reason: APP_EXIT_REASON, at: toUtcInstant(at) };
    let counts = { startFailed: 0, expired: 0 };
    this.transaction(() => {
      counts = {
        startFailed: Number(this.statements.settleStarting.run(params).changes),
        expired: Number(this.statements.settleUnanswered.run(params).changes),
      };
    });
    return counts;
  }

  // runs -----------------------------------------------------------------------------------------

  /** The last heartbeat of any run, or null before the first. Read it before `openRun`. */
  lastTickAt(): string | null {
    const row = this.statements.selectLastTick.get();
    return row === undefined ? null : optionalText(row, 'at');
  }

  /** A stretch began (a launch or a wake); later heartbeats go to its row. */
  openRun(at: string): void {
    const startedAt = toUtcInstant(at);
    this.runId = this.statements.insertRun.run(startedAt, startedAt).lastInsertRowid;
  }

  /** Roger is still running at `at`. */
  heartbeat(at: string): void {
    if (this.runId === null) throw new Error('cannot write a run heartbeat before a run is open');
    this.statements.updateRun.run(toUtcInstant(at), this.runId);
  }

  /** The runs still ticking at or after `at`: the only ones that can cover a moment from then on. */
  runsSince(at: string): RunSpan[] {
    return this.statements.selectRunsSince.all(toUtcInstant(at)).map((row) => ({
      startedAt: text(row, 'started_at'),
      lastTickAt: text(row, 'last_tick_at'),
    }));
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

/** A calendar row belongs to the account whose calendar it came from; the streak filters by it. */
function requireAccount(accountEmail: string): string {
  const account = accountEmail.trim();
  if (account === '') throw new Error('cannot log a calendar prompt without an account');
  return account;
}

function rowToPrompt(row: Row): PromptRow {
  return {
    accountEmail: text(row, 'account_email'),
    key: text(row, 'key'),
    source: oneOf(row, 'source', ['calendar', 'call_detected'] as const),
    eventId: optionalText(row, 'event_id'),
    title: optionalText(row, 'title'),
    scheduledStart: optionalText(row, 'scheduled_start'),
    shownAt: optionalText(row, 'shown_at'),
    shownBy: row.shown_by === null ? null : oneOf(row, 'shown_by', SHOWN_BY),
    action: row.action === null ? null : oneOf(row, 'action', ACTIONS),
    reason: optionalText(row, 'reason'),
    detail: optionalText(row, 'detail'),
    meetingId: optionalText(row, 'meeting_id'),
    decidedAt: optionalText(row, 'decided_at'),
    excludedReason: optionalText(row, 'excluded_reason'),
  };
}

const SHOWN_BY: readonly PromptShownBy[] = ['calendar', 'call_detected'];
const ACTIONS: readonly PromptAction[] = [
  'starting',
  'started',
  'joined_and_started',
  'started_degraded',
  'start_failed',
  'dismissed',
  'expired',
  'missed',
];

function oneOf<T extends string>(row: Row, key: string, choices: readonly T[]): T {
  const value = row[key];
  const match = choices.find((choice) => choice === value);
  if (match === undefined) throw new Error(`corrupt prompts row: ${key} is ${String(value)}`);
  return match;
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
