import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  promptKey,
  type CalendarEvent,
  type PromptOffer,
  type TimedCalendarEvent,
} from '../../shared/calendar';
import type { ReminderLeadMinutes } from '../../shared/calendarPrefs';
import { createLogger } from '../logger';
import type { CalendarCatchUp, CalendarSync } from './CalendarSync';
import { PromptLog } from './PromptLog';
import {
  PROMPT_FRESH_WAIT_MS,
  PROMPT_FRESH_WITHIN_MS,
  REMINDER_TICK_MS,
  ReminderScheduler,
  type ReminderSchedulerOptions,
} from './ReminderScheduler';
import { SqliteCalendarCache } from './SqliteCalendarCache';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const START = Date.parse('2026-10-06T08:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const ACCOUNT = 'rahul@linkt.ai';

/** A call starting `minutes` after START: the user and Jane, with the Meet link Google added. */
function call(id: string, minutes: number, overrides: Partial<TimedCalendarEvent> = {}) {
  const event: TimedCalendarEvent = {
    provider: 'fake',
    id,
    icalUid: `${id}@google.com`,
    recurringEventId: null,
    title: `Call ${id}`,
    status: 'confirmed',
    allDay: false,
    start: iso(START + minutes * MINUTE),
    end: iso(START + (minutes + 30) * MINUTE),
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
  return event;
}

interface HarnessOptions {
  /** Ms of the account's connect; null for none. Default: a day before START. */
  connectedAt?: number | null;
  /** Reuse a calendar.sqlite (a restart). */
  cache?: SqliteCalendarCache;
  /** Whether the fake prompt service logs the shown row, as PromptService does. Default true. */
  logsShown?: boolean;
  ensureFresh?: CalendarSync['ensureFresh'];
}

function harness(options: HarnessOptions = {}) {
  const cache = options.cache ?? new SqliteCalendarCache(':memory:');
  const connectedAt = options.connectedAt === undefined ? START - 24 * HOUR : options.connectedAt;
  if (connectedAt !== null) cache.recordConnected(ACCOUNT, iso(connectedAt));
  const log = new PromptLog(cache.database);
  const offers: PromptOffer[] = [];
  const offer = vi.fn((promptOffer: PromptOffer) => {
    offers.push(promptOffer);
    if (promptOffer.source !== 'calendar' || options.logsShown === false) return;
    const event = cache
      .listEvents()
      .find(
        (candidate): candidate is TimedCalendarEvent =>
          !candidate.allDay && promptKey(candidate) === promptOffer.eventKey,
      );
    if (event === undefined) throw new Error(`offered ${promptOffer.eventKey}, not in the copy`);
    log.recordShown({ accountEmail: ACCOUNT, event, shownBy: 'calendar', at: iso(Date.now()) });
  });
  const catchUp = new EventEmitter();
  const ensureFresh = vi.fn<CalendarSync['ensureFresh']>(
    options.ensureFresh ?? (() => Promise.resolve(true)),
  );
  const powerMonitor = new EventEmitter();
  let nextBlockerId = 41;
  const blocker = {
    start: vi.fn((_type: 'prevent-app-suspension') => (nextBlockerId += 1)),
    stop: vi.fn((_id: number) => true),
  };
  let lead: ReminderLeadMinutes = 1;
  const lines: Record<string, unknown>[] = [];
  const schedulerOptions: ReminderSchedulerOptions = {
    cache,
    sync: {
      ensureFresh,
      onCatchUp: (listener: (event: CalendarCatchUp) => void) => {
        catchUp.on('catch-up', listener);
        return () => catchUp.off('catch-up', listener);
      },
    },
    log,
    prompts: { offer },
    leadMinutes: () => lead,
    powerMonitor,
    powerSaveBlocker: blocker,
    logger: createLogger({
      level: 'debug',
      format: 'json',
      sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    }),
  };
  const scheduler = new ReminderScheduler(schedulerOptions);
  return {
    cache,
    log,
    scheduler,
    offer,
    ensureFresh,
    powerMonitor,
    blocker,
    lines,
    /** The calendar keys offered so far, in order. */
    offeredKeys: () =>
      offers.flatMap((promptOffer) =>
        promptOffer.source === 'calendar' ? [promptOffer.eventKey] : [],
      ),
    setLead: (minutes: ReminderLeadMinutes) => {
      lead = minutes;
    },
    /** The copy as an answer from the API at this moment would leave it. */
    setEvents: (events: CalendarEvent[]) => {
      cache.replaceEvents(events, iso(Date.now()));
    },
    emitCatchUp: (events: CalendarEvent[]) => {
      catchUp.emit('catch-up', { from: iso(START - 6 * HOUR), to: iso(Date.now()), events });
    },
    runs: () => log.runsSince('2000-01-01T00:00:00Z'),
  };
}

/** Run timers to `minutes` after START (a whole number of ticks lands on each 10 s mark). */
async function advanceTo(minutes: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(START + minutes * MINUTE - Date.now());
}

describe('ReminderScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: START });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('offers a due call once: not again on the next tick, nor after a restart', async () => {
    const h = harness();
    const standup = call('standup', 5);
    h.setEvents([standup]);
    h.scheduler.start();

    await advanceTo(3);
    await vi.advanceTimersByTimeAsync(50 * SECOND);
    expect(h.offeredKeys()).toEqual([]);
    // Lead 1 min: due from 08:04.
    await advanceTo(4);
    expect(h.offeredKeys()).toEqual([promptKey(standup)]);
    await advanceTo(8);
    expect(h.offeredKeys()).toHaveLength(1);
    h.scheduler.stop();

    const again = harness({ cache: h.cache, connectedAt: null });
    again.scheduler.start();
    await advanceTo(10);
    expect(again.offeredKeys()).toEqual([]);
    again.scheduler.stop();
  });

  it('offers a call once per run even when nothing logged it', async () => {
    const h = harness({ logsShown: false });
    h.setEvents([call('standup', 5)]);
    h.scheduler.start();

    await advanceTo(9);

    expect(h.offeredKeys()).toHaveLength(1);
    h.scheduler.stop();
  });

  it('offers the calls due at one tick by their start, each as its own key', async () => {
    const h = harness();
    const later = call('later', 30);
    const first = call('first', 20);
    const second = call('second', 20, { start: iso(START + 20 * MINUTE + 30 * SECOND) });
    h.setEvents([later, second, first]);
    h.scheduler.start();
    await advanceTo(12);
    expect(h.offeredKeys()).toEqual([]);

    // The lead time is read at every tick: 10 min puts both 08:20 calls inside it at once.
    h.setLead(10);
    await vi.advanceTimersByTimeAsync(REMINDER_TICK_MS);
    expect(h.offeredKeys()).toEqual([promptKey(first), promptKey(second)]);
    await advanceTo(20);
    expect(h.offeredKeys()).toEqual([promptKey(first), promptKey(second), promptKey(later)]);
    h.scheduler.stop();
  });

  it('never prompts or logs an event the policy refuses', async () => {
    const h = harness();
    const focus = call('focus', 5, { attendees: [], selfResponse: 'organizer' });
    const declined = call('declined', 5, { selfResponse: 'declined' });
    h.setEvents([focus, declined]);
    h.scheduler.start();

    await advanceTo(30);

    expect(h.offeredKeys()).toEqual([]);
    expect(h.log.loggedKeys(ACCOUNT, [promptKey(focus), promptKey(declined)])).toEqual(new Set());
    h.scheduler.stop();
  });

  it('refreshes a stale copy before showing: a call cancelled meanwhile gets no prompt', async () => {
    const h = harness({
      ensureFresh: () => {
        // The answer no longer holds the call.
        h.setEvents([]);
        return Promise.resolve(true);
      },
    });
    h.setEvents([call('cancelled', 5)]);
    h.scheduler.start();

    await advanceTo(6);

    expect(h.ensureFresh).toHaveBeenCalledWith(PROMPT_FRESH_WITHIN_MS);
    expect(PROMPT_FRESH_WITHIN_MS).toBe(2 * MINUTE);
    expect(h.offeredKeys()).toEqual([]);
    h.scheduler.stop();
  });

  it('shows from the copy when the refresh takes over 5 s', async () => {
    const h = harness({ ensureFresh: () => new Promise<boolean>(() => undefined) });
    const standup = call('standup', 5);
    h.setEvents([standup]);
    h.scheduler.start();

    await advanceTo(4);
    await vi.advanceTimersByTimeAsync(PROMPT_FRESH_WAIT_MS - 100);
    expect(h.offeredKeys()).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);

    expect(PROMPT_FRESH_WAIT_MS).toBe(5 * SECOND);
    expect(h.offeredKeys()).toEqual([promptKey(standup)]);
    expect(h.lines).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: 'calendar refresh took over 5 s; prompting from the copy',
      }),
    );
    h.scheduler.stop();
  });

  it('asks once when a wake comes while the refresh before a prompt is on its way', async () => {
    const h = harness({ ensureFresh: () => new Promise<boolean>(() => undefined) });
    const standup = call('standup', 5);
    h.setEvents([standup]);
    h.scheduler.start();
    await advanceTo(4);

    h.powerMonitor.emit('resume');
    await vi.advanceTimersByTimeAsync(PROMPT_FRESH_WAIT_MS);

    expect(h.ensureFresh).toHaveBeenCalledTimes(1);
    expect(h.offeredKeys()).toEqual([promptKey(standup)]);
    h.scheduler.stop();
  });

  it('holds off App Nap from 2 min before the next due prompt until it shows', async () => {
    const h = harness();
    h.setEvents([call('standup', 10)]);
    h.scheduler.start();

    await advanceTo(6 + 50 / 60);
    expect(h.blocker.start).not.toHaveBeenCalled();
    // Due at 08:09 (lead 1 min); the blocker from 08:07.
    await advanceTo(7);
    expect(h.blocker.start).toHaveBeenCalledExactlyOnceWith('prevent-app-suspension');
    await advanceTo(8 + 50 / 60);
    expect(h.blocker.start).toHaveBeenCalledTimes(1);
    expect(h.blocker.stop).not.toHaveBeenCalled();

    await advanceTo(9);
    expect(h.offeredKeys()).toHaveLength(1);
    expect(h.blocker.stop).toHaveBeenCalledExactlyOnceWith(42);
    await advanceTo(30);
    expect(h.blocker.start).toHaveBeenCalledTimes(1);
    h.scheduler.stop();
  });

  it('lets go of the blocker when it stops', async () => {
    const h = harness();
    h.setEvents([call('standup', 2)]);
    h.scheduler.start();
    await advanceTo(0);
    expect(h.blocker.start).toHaveBeenCalledTimes(1);

    h.scheduler.stop();

    expect(h.blocker.stop).toHaveBeenCalledExactlyOnceWith(42);
  });

  it('logs a call missed while the Mac slept as not_running: a wake opens a new run first', async () => {
    const h = harness();
    const standup = call('standup', 30);
    h.setEvents([standup]);
    h.scheduler.start();
    await advanceTo(1);

    // Asleep from 08:01 to 10:00: timers keep their remaining wait, so only the wake ticks.
    vi.setSystemTime(START + 2 * HOUR);
    h.powerMonitor.emit('resume');

    expect(h.log.get(ACCOUNT, promptKey(standup))).toMatchObject({
      action: 'missed',
      reason: 'not_running',
      detail: null,
      decidedAt: iso(START + 2 * HOUR),
    });
    expect(h.runs()).toEqual([
      { startedAt: iso(START), lastTickAt: iso(START + MINUTE) },
      { startedAt: iso(START + 2 * HOUR), lastTickAt: iso(START + 2 * HOUR) },
    ]);
    expect(h.offeredKeys()).toEqual([]);
    h.scheduler.stop();
  });

  it('starts a new run at every wake, however short the sleep', async () => {
    const h = harness();
    h.scheduler.start();
    await advanceTo(1);

    vi.setSystemTime(START + 6 * MINUTE);
    h.powerMonitor.emit('resume');
    await advanceTo(7);

    expect(h.runs()).toEqual([
      { startedAt: iso(START), lastTickAt: iso(START + MINUTE) },
      { startedAt: iso(START + 6 * MINUTE), lastTickAt: iso(START + 7 * MINUTE) },
    ]);
    h.scheduler.stop();
  });

  it('splits the run at a sleep the wake event never reported', async () => {
    const h = harness();
    const standup = call('standup', 30);
    h.setEvents([standup]);
    h.scheduler.start();
    await advanceTo(1);

    vi.setSystemTime(START + 2 * HOUR);
    await vi.advanceTimersByTimeAsync(REMINDER_TICK_MS);

    expect(h.runs()).toHaveLength(2);
    expect(h.log.get(ACCOUNT, promptKey(standup))).toMatchObject({ reason: 'not_running' });
    h.scheduler.stop();
  });

  it('logs api_stale for a call that reached the copy after it was due', async () => {
    const h = harness();
    h.scheduler.start();
    await advanceTo(20);
    const late = call('late', 5);

    h.setEvents([late]);
    await vi.advanceTimersByTimeAsync(REMINDER_TICK_MS);

    expect(h.log.get(ACCOUNT, promptKey(late))).toMatchObject({
      action: 'missed',
      reason: 'api_stale',
    });
    expect(h.offeredKeys()).toEqual([]);
    h.scheduler.stop();
  });

  it('logs disconnected for a call while no calendar was connected', async () => {
    const h = harness({ connectedAt: START - 3 * HOUR });
    h.cache.recordDisconnected(iso(START - 2 * HOUR));
    h.cache.recordConnected(ACCOUNT, iso(START - HOUR));
    const meanwhile = call('meanwhile', -90);
    h.setEvents([meanwhile]);

    h.scheduler.start();
    await advanceTo(0);

    expect(h.log.get(ACCOUNT, promptKey(meanwhile))).toMatchObject({
      action: 'missed',
      reason: 'disconnected',
    });
    h.scheduler.stop();
  });

  it('logs policy, naming the rule, for a call accepted again only after its window', async () => {
    const h = harness();
    h.setEvents([call('review', 5, { selfResponse: 'declined' })]);
    h.scheduler.start();
    await advanceTo(16);

    const accepted = call('review', 5);
    h.setEvents([accepted]);
    await vi.advanceTimersByTimeAsync(REMINDER_TICK_MS);

    expect(h.log.get(ACCOUNT, promptKey(accepted))).toMatchObject({
      action: 'missed',
      reason: 'policy',
      detail: 'declined',
    });
    h.scheduler.stop();
  });

  it('logs policy with no rule for a call accepted again before its window, then never shown', async () => {
    // PromptService took the offer but never logged the card: the sweep logs the miss.
    const h = harness({ logsShown: false });
    h.setEvents([call('review', 5, { selfResponse: 'declined' })]);
    h.scheduler.start();
    await advanceTo(1);

    const accepted = call('review', 5);
    h.setEvents([accepted]);
    await advanceTo(16);

    expect(h.offeredKeys()).toEqual([promptKey(accepted)]);
    expect(h.log.get(ACCOUNT, promptKey(accepted))).toMatchObject({
      action: 'missed',
      reason: 'policy',
      detail: null,
    });
    h.scheduler.stop();
  });

  it('never logs a call due before the account first connected', async () => {
    const h = harness({ connectedAt: START - HOUR });
    const before = call('before', -2 * 60);
    h.setEvents([before]);

    h.scheduler.start();
    await advanceTo(1);

    expect(h.log.get(ACCOUNT, promptKey(before))).toBeNull();
    h.scheduler.stop();
  });

  it('at launch, logs the calls missed while Roger was not running, from the copy and the catch-up', async () => {
    const h = harness();
    const cached = call('cached', -3 * 60);
    h.setEvents([cached]);
    h.log.openRun(iso(START - 5 * HOUR));
    h.log.heartbeat(iso(START - 4 * HOUR));

    expect(h.scheduler.start()).toEqual({ previousRunLastTickAt: iso(START - 4 * HOUR) });
    await advanceTo(0);
    expect(h.log.get(ACCOUNT, promptKey(cached))).toMatchObject({
      action: 'missed',
      reason: 'not_running',
    });

    // Only the catch-up fetch saw this one: it was never in the copy.
    const uncached = call('uncached', -2 * 60);
    h.emitCatchUp([uncached, cached, call('open', 5)]);

    expect(h.log.get(ACCOUNT, promptKey(uncached))).toMatchObject({
      action: 'missed',
      reason: 'not_running',
    });
    // Still in its window: the tick offers it once it is due.
    expect(h.log.get(ACCOUNT, promptKey(call('open', 5)))).toBeNull();
    h.scheduler.stop();
  });

  it('logs the catch-up again at the next tick when its sweep fails', async () => {
    const h = harness();
    h.log.openRun(iso(START - 5 * HOUR));
    h.log.heartbeat(iso(START - 4 * HOUR));
    h.scheduler.start();
    await advanceTo(0);
    vi.spyOn(h.log, 'recordMissed').mockImplementationOnce(() => {
      throw new Error('database is locked');
    });

    // Only the catch-up saw it, and the next launch's catch-up starts after it.
    const uncached = call('uncached', -2 * 60);
    h.emitCatchUp([uncached]);
    expect(h.log.get(ACCOUNT, promptKey(uncached))).toBeNull();
    expect(h.lines).toContainEqual(
      expect.objectContaining({ level: 'error', error: 'database is locked' }),
    );

    await vi.advanceTimersByTimeAsync(REMINDER_TICK_MS);

    expect(h.log.get(ACCOUNT, promptKey(uncached))).toMatchObject({
      action: 'missed',
      reason: 'not_running',
    });
    h.scheduler.stop();
  });

  it('drops a catch-up still owed at a disconnect: its calls belong to no other account', async () => {
    const OTHER = 'other@example.com';
    const h = harness({ connectedAt: null });
    h.cache.recordConnected(OTHER, iso(START - 48 * HOUR));
    h.cache.recordConnected(ACCOUNT, iso(START - 24 * HOUR));
    h.log.openRun(iso(START - 5 * HOUR));
    h.log.heartbeat(iso(START - 4 * HOUR));
    h.scheduler.start();
    await advanceTo(0);
    vi.spyOn(h.log, 'recordMissed').mockImplementationOnce(() => {
      throw new Error('database is locked');
    });
    const uncached = call('uncached', -2 * 60);
    h.emitCatchUp([uncached]);

    h.cache.recordDisconnected(iso(Date.now()));
    await vi.advanceTimersByTimeAsync(REMINDER_TICK_MS);
    h.cache.recordConnected(OTHER, iso(Date.now()));
    await vi.advanceTimersByTimeAsync(REMINDER_TICK_MS);

    expect(h.log.get(OTHER, promptKey(uncached))).toBeNull();
    expect(h.log.get(ACCOUNT, promptKey(uncached))).toBeNull();
    h.scheduler.stop();
  });

  it('at launch, settles what the last run left before anything shows', () => {
    const h = harness();
    const crashed = call('crashed', -60);
    h.log.recordShown({
      accountEmail: ACCOUNT,
      event: crashed,
      shownBy: 'calendar',
      at: iso(START - HOUR),
    });
    h.log.recordAction({
      accountEmail: ACCOUNT,
      key: promptKey(crashed),
      action: 'starting',
      at: iso(START - HOUR),
    });
    const unanswered = call('unanswered', -30);
    h.log.recordShown({
      accountEmail: ACCOUNT,
      event: unanswered,
      shownBy: 'calendar',
      at: iso(START - 31 * MINUTE),
    });

    h.scheduler.start();

    expect(h.log.get(ACCOUNT, promptKey(crashed))).toMatchObject({
      action: 'start_failed',
      reason: 'app_exit',
    });
    expect(h.log.get(ACCOUNT, promptKey(unanswered))).toMatchObject({
      action: 'expired',
      reason: 'app_exit',
    });
    h.scheduler.stop();
  });

  it('keeps a heartbeat with no calendar connected, and offers nothing', async () => {
    const h = harness({ connectedAt: null });
    h.scheduler.start();

    await advanceTo(5);

    expect(h.runs()).toEqual([{ startedAt: iso(START), lastTickAt: iso(START + 5 * MINUTE) }]);
    expect(h.offer).not.toHaveBeenCalled();
    h.scheduler.stop();
  });

  it('offers again at the next tick when an offer fails', async () => {
    const h = harness();
    const standup = call('standup', 5);
    h.setEvents([standup]);
    h.offer.mockImplementationOnce(() => {
      throw new Error('the panel could not open');
    });
    h.scheduler.start();

    await advanceTo(4);
    await vi.advanceTimersByTimeAsync(REMINDER_TICK_MS);

    expect(h.offer).toHaveBeenCalledTimes(2);
    expect(h.lines).toContainEqual(
      expect.objectContaining({
        level: 'error',
        key: promptKey(standup),
        error: 'the panel could not open',
      }),
    );
    h.scheduler.stop();
  });

  it('keeps ticking after a tick fails', async () => {
    const h = harness();
    const standup = call('standup', 5);
    h.setEvents([standup]);
    const listEvents = vi.spyOn(h.cache, 'listEvents').mockImplementationOnce(() => {
      throw new Error('database is locked');
    });
    h.scheduler.start();

    await advanceTo(4);

    expect(listEvents).toHaveBeenCalled();
    expect(h.lines).toContainEqual(
      expect.objectContaining({ level: 'error', error: 'database is locked' }),
    );
    expect(h.offeredKeys()).toEqual([promptKey(standup)]);
    h.scheduler.stop();
  });

  it('stops ticking and writes a last heartbeat when it stops', async () => {
    const h = harness();
    h.setEvents([call('standup', 5)]);
    h.scheduler.start();
    await advanceTo(1);
    await vi.advanceTimersByTimeAsync(5 * SECOND);

    h.scheduler.stop();
    await advanceTo(10);

    expect(h.offer).not.toHaveBeenCalled();
    expect(h.runs()).toEqual([{ startedAt: iso(START), lastTickAt: iso(START + 65 * SECOND) }]);
    expect(h.powerMonitor.listenerCount('resume')).toBe(0);
  });
});
