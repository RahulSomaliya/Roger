import {
  parseInstant,
  type CalendarEvent,
  type CalendarEventsPage,
  type CalendarSyncState,
} from '../../shared/calendar';
import { ApiError } from '../api/http';
import { errorMessage, type Logger } from '../logger';
import { Emitter } from '../util/emitter';
import type { CalendarApiPort, CalendarWindow } from './ports';
import { PROMPT_OPEN_AFTER_START_MS } from './reminderPolicy';
import type { SqliteCalendarCache } from './SqliteCalendarCache';

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** A healthy copy is refreshed this often. */
export const CALENDAR_POLL_INTERVAL_MS = 5 * MINUTE_MS;
/** Focusing the window refreshes at most this often (counted from any request). */
export const CALENDAR_FOCUS_THROTTLE_MS = 30 * SECOND_MS;
/** The first retry after a failure; each further failure doubles it, up to the cap. */
export const CALENDAR_FIRST_RETRY_MS = MINUTE_MS;
export const CALENDAR_MAX_BACKOFF_MS = 30 * MINUTE_MS;
/**
 * A copy with no success for this long is stale: the menu bar, the panel and Home say "Calendar
 * not updated since …" (docs/plans/M5-calendar.md, D1: the API runs on this Mac until M6).
 */
export const CALENDAR_STALE_AFTER_MS = HOUR_MS;
/**
 * The copy spans now - 36 h to now + 36 h. Main never decides what "today" is (the renderer does,
 * in the Mac's current zone), so the window is wide enough that today in any zone is inside it:
 * at 23:30 in Kolkata the 10:00 standup is 13.5 h back.
 */
export const CALENDAR_WINDOW_EACH_SIDE_MS = 36 * HOUR_MS;
/** The catch-up at launch reaches back at most this far: the API refuses a window over 7 days. */
export const CALENDAR_CATCH_UP_MAX_MS = 6 * DAY_MS;

/** What prompted a request, for the log. */
type RefreshTrigger = 'launch' | 'poll' | 'wake' | 'focus' | 'connect' | 'prompt' | 'stale_check';

/**
 * The events between the previous run's last tick and this launch: the calls Roger was not
 * running for. They feed the missed-prompt log (M5-T9a) and never the copy.
 */
export interface CalendarCatchUp extends CalendarWindow {
  events: CalendarEvent[];
}

interface CalendarSyncEvents extends Record<string, unknown> {
  state: CalendarSyncState;
  events: CalendarEvent[];
  'catch-up': CalendarCatchUp;
}

export interface CalendarSyncOptions {
  api: Pick<CalendarApiPort, 'listEvents'>;
  cache: SqliteCalendarCache;
  logger: Logger;
  clock?: () => Date;
}

/**
 * Keeps `calendar.sqlite`'s copy of the calendar fresh. The API calls Google live and keeps no
 * events (D1), so prompts come from this copy and still fire with the API down or the Mac offline.
 *
 * It asks the API at launch, every 5 min, on wake, on window focus (at most every 30 s), right
 * after a connect, and before a prompt when the copy is too old (`ensureFresh`). Requests are
 * single-flight. A failure keeps the last good list and backs off x2 from 1 min up to 30 min; a
 * `424` (Google refused the grant) stops polling until the next connect. The copy turns stale
 * 1 h after its last success.
 *
 * Connect and disconnect go through `connected` and `disconnected`, never straight to the cache
 * (its `recordConnected` and `recordDisconnected` say the same): they also stop the polling and
 * drop an answer still on its way, which would otherwise write a disconnected account's events
 * back into the copy.
 */
export class CalendarSync {
  private readonly notifier = new Emitter<CalendarSyncEvents>();
  private readonly clock: () => Date;
  private running = false;
  /** Bumped by connect, disconnect and stop: an answer that started before is dropped. */
  private generation = 0;
  private accountEmail: string | null = null;
  /** Google refused the grant (`424`): nothing asks the API until the next connect. */
  private halted = false;
  private failures = 0;
  private lastRequestAtMs: number | null = null;
  private pendingCatchUp: CalendarWindow | null = null;
  private inflight: { generation: number; done: Promise<void> } | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private staleTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: CalendarSyncOptions) {
    this.clock = options.clock ?? (() => new Date());
  }

  /**
   * Start syncing, if a calendar is connected (`connections_log`). `previousRunLastTickAt` is the
   * last heartbeat any earlier run wrote to `runs`, read before this run writes its own; null on a
   * first launch. A launch asks the API even when the last run ended on a `424`: the grant may
   * have been renewed since, by another Roger build on this Mac that shares the API.
   */
  start(launch: { previousRunLastTickAt: string | null }): void {
    if (this.running) return;
    this.running = true;
    this.accountEmail = this.options.cache.activeConnection()?.accountEmail ?? null;
    if (this.accountEmail === null) {
      this.options.logger.info('calendar not connected: nothing to sync until it is');
      return;
    }
    this.pendingCatchUp = catchUpWindow(launch.previousRunLastTickAt, this.nowMs());
    void this.refresh('launch');
  }

  /** Stop every timer and drop any answer still on its way. At quit, before the cache closes. */
  stop(): void {
    this.running = false;
    this.generation += 1;
    this.inflight = null;
    this.clearPollTimer();
    this.clearStaleTimer();
  }

  /**
   * The account connected (the API stored the grant). Logs the connect, clears a refused-grant
   * stop, and refreshes at once; resolves when that refresh has settled (it never rejects: a
   * failure is in `getState()`).
   */
  connected(accountEmail: string): Promise<void> {
    this.options.cache.recordConnected(accountEmail, this.nowIso());
    this.generation += 1;
    this.inflight = null;
    this.accountEmail = this.options.cache.activeConnection()?.accountEmail ?? null;
    this.halted = false;
    this.failures = 0;
    // Another account's copy was just dropped; the same account's copy is shown again as it is.
    this.notifyState();
    this.notifyEvents();
    if (!this.running) return Promise.resolve();
    return this.refresh('connect');
  }

  /** The calendar was disconnected (the API revoked it). Clears the copy; the logs stay. */
  disconnected(): void {
    this.options.cache.recordDisconnected(this.nowIso());
    this.generation += 1;
    this.inflight = null;
    this.accountEmail = null;
    this.halted = false;
    this.failures = 0;
    this.pendingCatchUp = null;
    this.clearPollTimer();
    this.clearStaleTimer();
    this.notifyState();
    this.notifyEvents();
  }

  /**
   * `powerMonitor` resume: the network may have changed and the copy may be hours old. A sync that
   * may not ask (a refused grant) checks the hour here instead. A timer counts only the time the
   * Mac was awake (libuv's clock stops in sleep: read from its source, not yet seen on a sleeping
   * Mac), so the stale timer is late by the whole sleep, and the menu bar, Home and the stale card
   * would wait up to an hour more before calling an 8-hour-old copy stale.
   */
  onWake(): void {
    if (this.canRequest()) void this.refresh('wake');
    else this.checkStale();
  }

  /** The main window gained focus: the user is looking, but at most one request per 30 s. */
  onWindowFocus(): void {
    if (!this.canRequest()) return;
    if (
      this.lastRequestAtMs !== null &&
      this.nowMs() - this.lastRequestAtMs < CALENDAR_FOCUS_THROTTLE_MS
    )
      return;
    void this.refresh('focus');
  }

  /**
   * Before showing a prompt: refresh when the last success is older than `maxAgeMs`, so a call
   * cancelled a minute ago gets no prompt. Resolves with whether the copy is that fresh now; never
   * rejects. The caller bounds the wait (the scheduler falls back to the copy after 5 s).
   */
  async ensureFresh(maxAgeMs: number): Promise<boolean> {
    if (this.isFresh(maxAgeMs)) return true;
    if (!this.canRequest()) return false;
    await this.refresh('prompt');
    return this.isFresh(maxAgeMs);
  }

  getState(): CalendarSyncState {
    return this.options.cache.getSyncState();
  }

  onStateChange(listener: (state: CalendarSyncState) => void): () => void {
    return this.subscribe('state', listener);
  }

  /** The copy changed: a new answer, or a connect or disconnect that cleared it. */
  onEventsChange(listener: (events: CalendarEvent[]) => void): () => void {
    return this.subscribe('events', listener);
  }

  /**
   * The launch catch-up arrived. It is emitted before the refresh that follows it writes the copy,
   * so a listener still reads the previous run's `first_seen_at` (missedReason's `api_stale`).
   * Subscribe before `start`.
   */
  onCatchUp(listener: (catchUp: CalendarCatchUp) => void): () => void {
    return this.subscribe('catch-up', listener);
  }

  private canRequest(): boolean {
    return this.running && this.accountEmail !== null && !this.halted;
  }

  private isFresh(maxAgeMs: number): boolean {
    const { lastSuccessAt } = this.options.cache.getSyncState();
    return lastSuccessAt !== null && this.nowMs() - parseInstant(lastSuccessAt) <= maxAgeMs;
  }

  /** One request at a time: a trigger that arrives while one runs shares it. */
  private refresh(trigger: RefreshTrigger): Promise<void> {
    if (this.inflight?.generation === this.generation) return this.inflight.done;
    const generation = this.generation;
    const done = this.attempt(generation, trigger).finally(() => {
      if (this.inflight?.done !== done) return;
      this.inflight = null;
      this.checkStale();
    });
    this.inflight = { generation, done };
    return done;
  }

  /**
   * The catch-up (while one is owed), then the refresh. Never rejects: each failure is logged,
   * recorded in `fetch_state` and retried, so a timer's `void` drops nothing.
   */
  private async attempt(generation: number, trigger: RefreshTrigger): Promise<void> {
    this.clearPollTimer();
    this.lastRequestAtMs = this.nowMs();
    try {
      if (this.pendingCatchUp !== null) {
        await this.catchUp(this.pendingCatchUp, generation);
        if (generation !== this.generation) return;
      }
      const page = await this.options.api.listEvents(syncWindow(this.nowMs()));
      if (generation !== this.generation) return;
      this.options.cache.replaceEvents(page.items, this.nowIso());
      if (this.failures > 0) {
        this.options.logger.info('calendar refresh recovered', {
          trigger,
          failures: this.failures,
        });
      }
      this.failures = 0;
      this.options.logger.debug('calendar refreshed', { trigger, events: page.items.length });
      this.schedulePoll(CALENDAR_POLL_INTERVAL_MS);
      this.notifyState();
      this.notifyEvents();
    } catch (error) {
      if (generation !== this.generation) {
        this.options.logger.debug('calendar answer dropped: the connection changed meanwhile', {
          trigger,
        });
        return;
      }
      this.recordFailure(error, trigger);
    }
  }

  /**
   * Fetch the window Roger was not running for. A `424` stops everything, as for a refresh; any
   * other failure is logged and the catch-up is owed again with the next request, because a call
   * it misses would leave no `missed` row and the streak would skip it without breaking.
   */
  private async catchUp(window: CalendarWindow, generation: number): Promise<void> {
    let page: CalendarEventsPage;
    try {
      page = await this.options.api.listEvents(window);
    } catch (error) {
      if (isReconnectRequired(error)) throw error;
      this.options.logger.warn('calendar catch-up failed; it is retried with the next refresh', {
        from: window.from,
        to: window.to,
        error: errorMessage(error),
      });
      return;
    }
    if (generation !== this.generation) return;
    this.pendingCatchUp = null;
    this.options.logger.info('calendar catch-up', {
      from: window.from,
      to: window.to,
      events: page.items.length,
    });
    this.notifier.emit('catch-up', { ...window, events: page.items });
  }

  private recordFailure(error: unknown, trigger: RefreshTrigger): void {
    const message = errorMessage(error);
    const at = this.nowIso();
    if (isReconnectRequired(error)) {
      this.halted = true;
      this.failures = 0;
      this.clearPollTimer();
      this.options.logger.warn('calendar needs reconnecting: polling stopped until it is', {
        trigger,
        error: message,
      });
      this.writeCache('mark the calendar for reconnecting', () => {
        this.options.cache.markReconnectRequired(message, at);
      });
      this.notifyState();
      return;
    }
    this.failures += 1;
    const delayMs = Math.min(
      CALENDAR_MAX_BACKOFF_MS,
      CALENDAR_FIRST_RETRY_MS * 2 ** (this.failures - 1),
    );
    // Retry first, then record: a cache that fails every call (closed at quit, a full disk) must
    // not end the loop the way it once ended the uploader's (TranscriptUploader.tick).
    this.schedulePoll(delayMs);
    this.options.logger.warn('calendar refresh failed, backing off', {
      trigger,
      failures: this.failures,
      delayMs,
      error: message,
      ...(error instanceof ApiError ? { status: error.status, code: error.code } : {}),
    });
    this.writeCache('record the calendar failure', () => {
      this.options.cache.recordFailure(message, at);
    });
    this.notifyState();
  }

  /**
   * Mark the copy stale once its last success (or, before any, the connect) is 1 h old. Past the
   * hour, a request decides first, and only a request that fails marks it: after a sleep or a
   * relaunch the hour passed while nothing could ask, and a mark that the next answer clears a
   * second later would put a "Calendar not updated" card up at every wake (one per stale spell,
   * M5-T9b). A refused grant asks nothing, so it marks at the hour (on a wake too: `onWake`).
   */
  private checkStale(): void {
    this.clearStaleTimer();
    if (!this.running || this.accountEmail === null) return;
    const state = this.options.cache.getSyncState();
    if (state.staleSince !== null) return;
    const since = state.lastSuccessAt ?? this.options.cache.activeConnection()?.connectedAt;
    if (since === undefined) return;
    const staleAtMs = parseInstant(since) + CALENDAR_STALE_AFTER_MS;
    const delayMs = staleAtMs - this.nowMs();
    if (delayMs > 0) {
      // Capped at the hour: a success stamped while the clock ran ahead (then set back) can be
      // weeks away, and setTimeout turns a wait over 24.8 days into 1 ms, which would re-arm this
      // every millisecond until the next success, and for good while a 424 halts requests.
      this.staleTimer = setTimeout(
        () => {
          this.staleTimer = null;
          this.checkStale();
        },
        Math.min(delayMs, CALENDAR_STALE_AFTER_MS),
      );
      return;
    }
    // A request on its way checks again when it settles (refresh's `finally`).
    if (this.inflight !== null) return;
    if (this.canRequest() && (this.lastRequestAtMs === null || this.lastRequestAtMs < staleAtMs)) {
      void this.refresh('stale_check');
      return;
    }
    const staleSince = new Date(staleAtMs).toISOString();
    this.writeCache('mark the calendar stale', () => {
      this.options.cache.markStale(staleSince);
    });
    this.options.logger.warn('calendar copy is stale', {
      lastSuccessAt: state.lastSuccessAt,
      staleSince,
    });
    this.notifyState();
  }

  private schedulePoll(delayMs: number): void {
    this.clearPollTimer();
    if (!this.canRequest()) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.refresh('poll');
    }, delayMs);
  }

  private clearPollTimer(): void {
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  private clearStaleTimer(): void {
    if (this.staleTimer !== null) clearTimeout(this.staleTimer);
    this.staleTimer = null;
  }

  /** A cache write on a failure path: its own failure is logged, never thrown into the loop. */
  private writeCache(what: string, write: () => void): void {
    try {
      write();
    } catch (error) {
      this.options.logger.error('calendar cache write failed', {
        what,
        error: errorMessage(error),
      });
    }
  }

  private notifyState(): void {
    let state: CalendarSyncState;
    try {
      state = this.options.cache.getSyncState();
    } catch (error) {
      this.options.logger.error('calendar sync state could not be read', {
        error: errorMessage(error),
      });
      return;
    }
    this.notifier.emit('state', state);
  }

  private notifyEvents(): void {
    let events: CalendarEvent[];
    try {
      events = this.options.cache.listEvents();
    } catch (error) {
      this.options.logger.error('calendar events could not be read', {
        error: errorMessage(error),
      });
      return;
    }
    this.notifier.emit('events', events);
  }

  /**
   * Each listener runs on its own: one that throws (a closed window's IPC, a full disk in the
   * prompt log) is logged and neither stops the others nor turns a good refresh into a failure.
   */
  private subscribe<K extends keyof CalendarSyncEvents>(
    event: K,
    listener: (payload: CalendarSyncEvents[K]) => void,
  ): () => void {
    return this.notifier.on(event, (payload) => {
      try {
        listener(payload);
      } catch (error) {
        this.options.logger.error('calendar sync listener failed', {
          event,
          error: errorMessage(error),
        });
      }
    });
  }

  private nowMs(): number {
    return this.clock().getTime();
  }

  private nowIso(): string {
    return this.clock().toISOString();
  }
}

/** now - 36 h to now + 36 h. */
function syncWindow(nowMs: number): CalendarWindow {
  return {
    from: new Date(nowMs - CALENDAR_WINDOW_EACH_SIDE_MS).toISOString(),
    to: new Date(nowMs + CALENDAR_WINDOW_EACH_SIDE_MS).toISOString(),
  };
}

/**
 * From the previous run's last tick to launch, at most 6 days. It starts 10 min before that tick:
 * Google returns events that end after the window's start, so a short call that started up to
 * 10 min before the run ended, still open for a prompt then, would otherwise never be logged.
 * Null on a first launch, or when the last tick is not before launch (the clock went back).
 */
function catchUpWindow(previousRunLastTickAt: string | null, nowMs: number): CalendarWindow | null {
  if (previousRunLastTickAt === null) return null;
  const fromMs = Math.max(
    parseInstant(previousRunLastTickAt) - PROMPT_OPEN_AFTER_START_MS,
    nowMs - CALENDAR_CATCH_UP_MAX_MS,
  );
  if (fromMs >= nowMs) return null;
  return { from: new Date(fromMs).toISOString(), to: new Date(nowMs).toISOString() };
}

function isReconnectRequired(error: unknown): boolean {
  return error instanceof ApiError && error.status === 424;
}
