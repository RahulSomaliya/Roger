import {
  parseInstant,
  promptKey,
  type CalendarEvent,
  type PromptOffer,
  type TimedCalendarEvent,
} from '../../shared/calendar';
import type { ReminderLeadMinutes } from '../../shared/calendarPrefs';
import { errorMessage, type Logger } from '../logger';
import { TimeoutError, withTimeout } from '../util/time';
import type { CalendarCatchUp, CalendarSync } from './CalendarSync';
import type { PromptLog } from './PromptLog';
import {
  dueWindow,
  isDue,
  missedReason,
  PROMPT_OPEN_AFTER_START_MS,
  promptWorthiness,
  promptWorthyEvents,
  type PolicyRule,
} from './reminderPolicy';
import type { SqliteCalendarCache } from './SqliteCalendarCache';

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;

/** How often the scheduler reads the local copy. A wake ticks at once. */
export const REMINDER_TICK_MS = 10 * SECOND_MS;
/** Before a prompt shows, a copy whose last success is older than this is refreshed first... */
export const PROMPT_FRESH_WITHIN_MS = 2 * MINUTE_MS;
/** ...but the prompt waits at most this long for the answer, then shows from the copy. */
export const PROMPT_FRESH_WAIT_MS = 5 * SECOND_MS;
/** From this long before the next due prompt until it shows, App Nap is held off. */
export const PROMPT_BLOCKER_LEAD_MS = 2 * MINUTE_MS;
/**
 * A tick this long after the last heartbeat (or before it: the clock went back) starts a new
 * `runs` row even with no wake event: Roger did not tick in between, so it could not have shown a
 * prompt there. No shorter: every due window is at least this long (lead 0 to start + 10 min), so
 * a shorter gap (App Nap coalescing the timer) cannot hide a prompt, and splitting the run there
 * would turn a `policy` miss into `not_running`.
 */
export const RUN_SPLIT_GAP_MS = PROMPT_OPEN_AFTER_START_MS;

/**
 * The one prompt panel (PromptService, M5-T9b). `offer` must not reject: it handles its own
 * failures, and a throw here is logged and the key offered again at the next tick. PromptService
 * logs the shown row (`PromptLog.recordShown`) as the card goes up; that row is what keeps a key
 * from being offered again after a restart.
 */
export interface PromptOfferPort {
  offer(offer: PromptOffer): void;
}

/** Electron's `powerMonitor`, as far as the scheduler listens to it. */
export interface ResumeEvents {
  on(event: 'resume', listener: () => void): unknown;
  removeListener(event: 'resume', listener: () => void): unknown;
}

/** Electron's `powerSaveBlocker`, as far as the scheduler uses it. */
export interface AppSuspensionBlocker {
  start(type: 'prevent-app-suspension'): number;
  stop(id: number): unknown;
}

export interface ReminderSchedulerOptions {
  cache: Pick<
    SqliteCalendarCache,
    'activeConnection' | 'listConnections' | 'listEvents' | 'firstSeenAt'
  >;
  sync: Pick<CalendarSync, 'ensureFresh' | 'onCatchUp'>;
  log: PromptLog;
  prompts: PromptOfferPort;
  /** `calendar.reminderLeadMinutes`, read at every tick: a new setting applies at once. */
  leadMinutes: () => ReminderLeadMinutes;
  powerMonitor: ResumeEvents;
  powerSaveBlocker: AppSuspensionBlocker;
  logger: Logger;
  clock?: () => Date;
}

/** What `start` hands to `CalendarSync.start`: `sync.start(scheduler.start())`. */
export interface ReminderLaunch {
  /** The last heartbeat of any earlier run, read before this run wrote its own. */
  previousRunLastTickAt: string | null;
}

/**
 * Offers each calendar call to the prompt panel from start - lead (`calendar.reminderLeadMinutes`)
 * and logs, in `calendar.sqlite`, every call that got no prompt (docs/plans/M5-calendar.md, "When
 * the prompt shows" and "Prompt log").
 *
 * A 10 s tick reads the local copy, never the API: prompts fire with the API down or the Mac
 * offline, and a tick over a small list survives sleep, clock changes and zone changes with no
 * timer per meeting. Each tick:
 * 1. writes the run heartbeat (`runs`), opening a new row after a wake;
 * 2. logs `missed`, with its reason, for each prompt-worthy call whose window (to start + 10 min)
 *    has closed with no `prompts` row;
 * 3. offers the calls now due, after refreshing a copy older than 2 min (waiting at most 5 s), so
 *    a call cancelled a minute ago gets no prompt;
 * 4. holds `prevent-app-suspension` from 2 min before the next due prompt until it shows: with the
 *    window hidden, App Nap may coalesce this timer and turn a 1-minute lead into "Started 2 min
 *    ago".
 *
 * At launch it settles the rows the last run left open (`app_exit`), opens this run's row, and
 * logs the calls missed while Roger was not running: from the previous run's copy at the first
 * tick, and from the catch-up fetch (`CalendarSync.onCatchUp`) for the rest.
 */
export class ReminderScheduler {
  private readonly clock: () => Date;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  /** A wake came: the next heartbeat opens a new `runs` row. */
  private woke = false;
  private lastBeatMs: number | null = null;
  /** A fresh check before a prompt is on its way; ticks meanwhile leave the offer to it. */
  private showing = false;
  private blockerId: number | null = null;
  /**
   * Keys offered in this run, for the account in `offeredFor`. PromptService's shown row stops a
   * second offer after a restart; this stops one within the run even if that row was never written
   * (the sweep then logs the call `missed` at the end of its window, which is the honest outcome).
   */
  private readonly offered = new Set<string>();
  private offeredFor: string | null = null;
  /**
   * The rule that last kept each cached call from prompting (a decline, a solo block). A call that
   * becomes prompt-worthy only after its window closed is logged `policy` with this as `detail`,
   * so the owner can tune reminderPolicy.ts from the log. In memory: it describes this run.
   */
  private readonly rulesSeen = new Map<string, PolicyRule>();
  private unsubscribeCatchUp: (() => void) | null = null;

  constructor(private readonly options: ReminderSchedulerOptions) {
    this.clock = options.clock ?? (() => new Date());
  }

  /**
   * Call at launch, before `CalendarSync.start`, and hand it the result:
   * `sync.start(scheduler.start())`. The previous run's last tick is read before this run's row is
   * written (the catch-up fetch starts from it), and the catch-up is only emitted to listeners
   * already subscribed. The first tick runs on the next turn of the event loop, after the sync's
   * launch refresh is on its way, so a prompt due at launch waits for that refresh (5 s at most)
   * instead of finding a sync that has not started and prompting from a copy hours old.
   *
   * Settles the previous run's open rows before PromptService can show anything this run.
   */
  start(): ReminderLaunch {
    if (this.running) throw new Error('the reminder scheduler is already running');
    const { log } = this.options;
    const previousRunLastTickAt = log.lastTickAt();
    const at = this.nowIso();
    const settled = log.settleAfterExit(at);
    if (settled.startFailed > 0 || settled.expired > 0) {
      this.options.logger.info('prompts left open by the last run settled', settled);
    }
    log.openRun(at);
    this.lastBeatMs = this.nowMs();
    this.running = true;
    this.options.powerMonitor.on('resume', this.onResume);
    this.unsubscribeCatchUp = this.options.sync.onCatchUp(this.onCatchUp);
    this.schedule(0);
    return { previousRunLastTickAt };
  }

  /** At quit, before the cache closes: no more ticks, the blocker released, a last heartbeat. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.clearTimer();
    this.options.powerMonitor.removeListener('resume', this.onResume);
    this.unsubscribeCatchUp?.();
    this.unsubscribeCatchUp = null;
    this.releaseBlocker();
    try {
      this.beat();
    } catch (error) {
      this.options.logger.error('last run heartbeat failed', { error: errorMessage(error) });
    }
  }

  /**
   * `powerMonitor` resume. The run that slept ends at its last heartbeat and this tick opens a new
   * row before it writes anything: a row is read as "Roger was running" from its start to its last
   * tick, so one that spanned the sleep would log a call due while the lid was shut as `policy`
   * (or `api_stale`) instead of `not_running`, and the owner would tune rules that never ran.
   * Timers count only awake time (the CLAUDE.md failure log), so the wake ticks now rather than
   * waiting out the old timer.
   */
  private readonly onResume = (): void => {
    if (!this.running) return;
    this.woke = true;
    this.clearTimer();
    this.tick();
  };

  private readonly onCatchUp = (catchUp: CalendarCatchUp): void => {
    if (!this.running) return;
    try {
      const account = this.options.cache.activeConnection()?.accountEmail ?? null;
      if (account === null) return;
      this.sweepMissed(account, catchUp.events, this.nowMs(), this.options.leadMinutes());
    } catch (error) {
      this.options.logger.error('missed prompts from the catch-up could not be logged', {
        from: catchUp.from,
        to: catchUp.to,
        error: errorMessage(error),
      });
    }
  };

  private tick(): void {
    this.timer = null;
    if (!this.running) return;
    // Next tick first: a tick that throws (a locked or full database) must not end the loop.
    this.schedule(REMINDER_TICK_MS);
    try {
      this.beat();
      this.review();
    } catch (error) {
      this.options.logger.error('reminder tick failed', { error: errorMessage(error) });
    }
  }

  /** The run heartbeat; a new `runs` row after a wake, a long silent gap, or a clock set back. */
  private beat(): void {
    const nowMs = this.nowMs();
    const last = this.lastBeatMs;
    const newStretch =
      this.woke || last === null || nowMs < last || nowMs - last >= RUN_SPLIT_GAP_MS;
    if (newStretch) {
      this.options.log.openRun(this.nowIso());
      this.options.logger.info('reminder run resumed', {
        lastTickAt: last === null ? null : new Date(last).toISOString(),
        wake: this.woke,
      });
    } else {
      this.options.log.heartbeat(this.nowIso());
    }
    this.woke = false;
    this.lastBeatMs = nowMs;
  }

  private review(): void {
    const account = this.options.cache.activeConnection()?.accountEmail ?? null;
    if (account === null) {
      this.releaseBlocker();
      this.rulesSeen.clear();
      return;
    }
    const nowMs = this.nowMs();
    const lead = this.options.leadMinutes();
    const events = this.options.cache.listEvents();
    this.noteRules(events);
    this.sweepMissed(account, events, nowMs, lead);
    const pending = this.pendingEvents(account, events, nowMs, lead);
    if (pending.some((event) => isDue(event, nowMs, lead))) this.showDue();
    this.holdBlocker(pending, nowMs, lead);
  }

  /** Remember why each cached call does not prompt, for a later `policy` miss; forget the rest. */
  private noteRules(events: readonly CalendarEvent[]): void {
    const cached = new Set<string>();
    for (const event of events) {
      if (event.allDay) continue;
      const key = promptKey(event);
      cached.add(key);
      const worthiness = promptWorthiness(event);
      if (!worthiness.worthy) this.rulesSeen.set(key, worthiness.rule);
    }
    for (const key of this.rulesSeen.keys()) if (!cached.has(key)) this.rulesSeen.delete(key);
  }

  /**
   * Log `missed` for each prompt-worthy call whose window has closed with no row. Never for a call
   * due before the account's first connect: Roger could not have prompted it, and the streak would
   * break on calls from before it began.
   */
  private sweepMissed(
    account: string,
    candidates: readonly CalendarEvent[],
    nowMs: number,
    lead: ReminderLeadMinutes,
  ): void {
    const closed = promptWorthyEvents(candidates).filter(
      (event) => dueWindow(event, lead).untilMs <= nowMs,
    );
    if (closed.length === 0) return;
    const logged = this.options.log.loggedKeys(account, closed.map(promptKey));
    const unlogged = closed.filter((event) => !logged.has(promptKey(event)));
    if (unlogged.length === 0) return;

    const connections = this.options.cache.listConnections(account).map((entry) => ({
      connectedAtMs: parseInstant(entry.connectedAt),
      disconnectedAtMs: entry.disconnectedAt === null ? null : parseInstant(entry.disconnectedAt),
    }));
    const firstConnectMs = connections[0]?.connectedAtMs;
    if (firstConnectMs === undefined) return;
    const earliestDueMs = Math.min(...unlogged.map((event) => dueWindow(event, lead).fromMs));
    const runs = this.options.log.runsSince(new Date(earliestDueMs).toISOString()).map((run) => ({
      startedAtMs: parseInstant(run.startedAt),
      lastTickAtMs: parseInstant(run.lastTickAt),
    }));

    for (const event of unlogged) {
      if (dueWindow(event, lead).fromMs < firstConnectMs) continue;
      const key = promptKey(event);
      const firstSeenAt = this.options.cache.firstSeenAt(key);
      const reason = missedReason({
        event,
        leadMinutes: lead,
        connections,
        runs,
        firstSeenAtMs: firstSeenAt === null ? null : parseInstant(firstSeenAt),
      });
      const detail = reason === 'policy' ? (this.rulesSeen.get(key) ?? null) : null;
      const written = this.options.log.recordMissed({
        accountEmail: account,
        event,
        reason,
        detail,
        at: new Date(nowMs).toISOString(),
      });
      if (written) this.options.logger.info('calendar prompt missed', { key, reason, detail });
    }
  }

  /** Prompt-worthy calls still to offer: window not closed, no row, not offered in this run. */
  private pendingEvents(
    account: string,
    events: readonly CalendarEvent[],
    nowMs: number,
    lead: ReminderLeadMinutes,
  ): TimedCalendarEvent[] {
    if (this.offeredFor !== account) {
      this.offered.clear();
      this.offeredFor = account;
    }
    const open = promptWorthyEvents(events).filter(
      (event) => nowMs < dueWindow(event, lead).untilMs,
    );
    const keys = new Set(open.map(promptKey));
    for (const key of this.offered) if (!keys.has(key)) this.offered.delete(key);
    const logged = this.options.log.loggedKeys(account, [...keys]);
    return open
      .filter((event) => !logged.has(promptKey(event)) && !this.offered.has(promptKey(event)))
      .sort((a, b) => parseInstant(a.start) - parseInstant(b.start));
  }

  /** Refresh a copy that may be out of date, then offer what is still due. One at a time. */
  private showDue(): void {
    if (this.showing) return;
    this.showing = true;
    void this.refreshThenOffer().finally(() => {
      this.showing = false;
    });
  }

  private async refreshThenOffer(): Promise<void> {
    try {
      await this.refreshCopy();
      if (!this.running) return;
      this.offerDue();
    } catch (error) {
      this.options.logger.error('calendar prompts could not be offered', {
        error: errorMessage(error),
      });
    }
  }

  /** Never throws for a slow or failed refresh: the copy is still the best answer there is. */
  private async refreshCopy(): Promise<void> {
    try {
      const fresh = await withTimeout(
        this.options.sync.ensureFresh(PROMPT_FRESH_WITHIN_MS),
        PROMPT_FRESH_WAIT_MS,
        'calendar refresh before a prompt',
      );
      if (!fresh) {
        this.options.logger.warn('calendar copy could not be refreshed; prompting from it');
      }
    } catch (error) {
      if (!(error instanceof TimeoutError)) throw error;
      this.options.logger.warn('calendar refresh took over 5 s; prompting from the copy', {
        error: errorMessage(error),
      });
    }
  }

  /** Offer each call due now, earliest first, re-read after the refresh. */
  private offerDue(): void {
    const account = this.options.cache.activeConnection()?.accountEmail ?? null;
    if (account === null) {
      this.releaseBlocker();
      return;
    }
    const nowMs = this.nowMs();
    const lead = this.options.leadMinutes();
    const events = this.options.cache.listEvents();
    const pending = this.pendingEvents(account, events, nowMs, lead);
    for (const event of pending) {
      if (!isDue(event, nowMs, lead)) continue;
      const key = promptKey(event);
      try {
        this.options.prompts.offer({ source: 'calendar', eventKey: key });
        this.offered.add(key);
        this.options.logger.info('calendar prompt offered', { key });
      } catch (error) {
        this.options.logger.error('calendar prompt offer failed; offered again at the next tick', {
          key,
          error: errorMessage(error),
        });
      }
    }
    this.holdBlocker(this.pendingEvents(account, events, nowMs, lead), nowMs, lead);
  }

  /** Hold the blocker while a call still to offer is due within 2 min (or due already). */
  private holdBlocker(
    pending: readonly TimedCalendarEvent[],
    nowMs: number,
    lead: ReminderLeadMinutes,
  ): void {
    const soon = pending.some(
      (event) => dueWindow(event, lead).fromMs - nowMs <= PROMPT_BLOCKER_LEAD_MS,
    );
    if (!soon) {
      this.releaseBlocker();
      return;
    }
    if (this.blockerId !== null) return;
    this.blockerId = this.options.powerSaveBlocker.start('prevent-app-suspension');
    this.options.logger.debug('app suspension blocked until the next prompt shows');
  }

  private releaseBlocker(): void {
    if (this.blockerId === null) return;
    const id = this.blockerId;
    this.blockerId = null;
    this.options.powerSaveBlocker.stop(id);
    this.options.logger.debug('app suspension allowed again');
  }

  private schedule(delayMs: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.tick();
    }, delayMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private nowMs(): number {
    return this.clock().getTime();
  }

  private nowIso(): string {
    return this.clock().toISOString();
  }
}
