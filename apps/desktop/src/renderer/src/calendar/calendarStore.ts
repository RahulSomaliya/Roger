import type {
  CalendarConnection,
  CalendarEvent,
  CalendarSyncState,
} from '../../../shared/calendar';
import { MAX_CALENDAR_MEETINGS_LOOKUP, type CalendarApi } from '../../../shared/ipc/calendar';
import type { Unsubscribe } from '../../../shared/ipc/unsubscribe';
import { describeError } from '../app/describeError';
import { RetainedStore } from './retainedStore';

/**
 * What the window knows about the calendar, for Home's Today, the status banner and Settings
 * (`useCalendar`). Two sources answer (shared/ipc/calendar.ts): the connection comes from the
 * Roger API and can fail while the events and their health, which come from this Mac's copy,
 * still answer. They are read and shown separately, so a down API never blanks the day.
 */

export type ReadStatus = 'loading' | 'ready' | 'failed';

export interface CalendarState {
  /** The Google account as the API holds it; null when none is connected (or still unread). */
  connection: CalendarConnection | null;
  connectionStatus: ReadStatus;
  /** Why the connection could not be read (the API is down), or null. */
  connectionError: string | null;
  /** This Mac's copy: 36 hours back to 36 hours ahead. Home cuts the day (todayGroups). */
  events: CalendarEvent[];
  /** The copy's health; null until read. */
  sync: CalendarSyncState | null;
  /** The copy has been read once: an empty `events` then means an empty calendar. */
  loaded: boolean;
  /** Why the copy could not be read, or null. */
  copyError: string | null;
  /** Event id to the newest meeting started for it: Open note. */
  links: ReadonlyMap<string, string>;
  /** Why the last lookup failed, or null; `links` keeps the answer before it. */
  linksError: string | null;
  /** A sign-in is waiting on the browser (up to 3 minutes). */
  connecting: boolean;
  connectError: string | null;
  disconnecting: boolean;
  disconnectError: string | null;
  /** This window just connected a calendar for the first time: the line about opening at login. */
  justConnected: boolean;
}

type Part = 'connection' | 'events' | 'sync';

export class CalendarStore extends RetainedStore<CalendarState> {
  /** Bumped by every start and stop, so an answer to an earlier start is dropped. */
  private run = 0;
  /** What a change event set since the read began: newer than what the read will answer. */
  private readonly fresh = new Set<Part>();
  private linksRun = 0;
  private connectRun = 0;

  constructor(private readonly api: CalendarApi) {
    super({
      connection: null,
      connectionStatus: 'loading',
      connectionError: null,
      events: [],
      sync: null,
      loaded: false,
      copyError: null,
      links: new Map(),
      linksError: null,
      connecting: false,
      connectError: null,
      disconnecting: false,
      disconnectError: null,
      justConnected: false,
    });
  }

  protected start(): Unsubscribe {
    this.run += 1;
    const run = this.run;
    const stops = [
      this.api.onCalendarConnectionChanged((connection) => {
        if (run !== this.run) return;
        this.fresh.add('connection');
        this.update({ connection, connectionStatus: 'ready', connectionError: null });
      }),
      this.api.onCalendarEventsChanged((events) => {
        if (run !== this.run) return;
        this.fresh.add('events');
        this.update({ events, loaded: true });
      }),
      this.api.onCalendarSyncStateChanged((sync) => {
        if (run !== this.run) return;
        this.fresh.add('sync');
        this.update({ sync });
      }),
    ];
    this.read(run);
    return () => {
      // A newer start owns the store now; only its own stop may stop it.
      if (run !== this.run) return;
      this.run += 1;
      for (const stop of stops) stop();
    };
  }

  /** Reads again, after a failed read. */
  reload(): void {
    this.update({ connectionStatus: 'loading', connectionError: null, copyError: null });
    this.read(this.run);
  }

  /**
   * Looks up which of `eventIds` already have a local meeting (Open note). Ask again when the
   * events change and when the recording's meeting changes, so a note just started shows. Never
   * rejects: a failure shows in `linksError` and the links from before stay.
   */
  async refreshLinks(eventIds: readonly string[]): Promise<void> {
    this.linksRun += 1;
    const run = this.linksRun;
    if (eventIds.length === 0) {
      this.update({ links: new Map(), linksError: null });
      return;
    }
    try {
      // Main refuses a longer list outright; the copy holds three days of events, far fewer.
      const found = await this.api.findCalendarMeetings(
        eventIds.slice(0, MAX_CALENDAR_MEETINGS_LOOKUP),
      );
      if (run !== this.linksRun) return;
      this.update({
        links: new Map(found.map((link) => [link.eventId, link.meetingId])),
        linksError: null,
      });
    } catch (error) {
      if (run === this.linksRun) this.update({ linksError: describeError(error) });
    }
  }

  /**
   * Runs the Google sign-in in the browser. Never rejects: a refusal shows in `connectError`. A
   * second call cancels the first, which main then rejects; that rejection is shown to nobody.
   */
  async connect(): Promise<void> {
    this.connectRun += 1;
    const run = this.connectRun;
    const first = this.state.connection === null;
    this.update({ connecting: true, connectError: null });
    try {
      const connection = await this.api.connectCalendar();
      if (run !== this.connectRun) return;
      this.fresh.add('connection');
      this.update({
        connection,
        connectionStatus: 'ready',
        connectionError: null,
        connecting: false,
        // Only the first connect turns open at login on (main), so only it earns the line.
        justConnected: first,
      });
    } catch (error) {
      if (run === this.connectRun) {
        this.update({ connecting: false, connectError: describeError(error) });
      }
    }
  }

  /** Revokes the grant and clears the copy. Never rejects: a failure shows in `disconnectError`. */
  async disconnect(): Promise<void> {
    // Disconnect also cancels a sign-in still waiting on the browser, which main then rejects:
    // that rejection is no news to the user either.
    this.connectRun += 1;
    this.update({ disconnecting: true, disconnectError: null, connecting: false });
    try {
      await this.api.disconnectCalendar();
      this.fresh.add('connection');
      this.fresh.add('events');
      this.update({
        connection: null,
        events: [],
        links: new Map(),
        justConnected: false,
        connectError: null,
      });
    } catch (error) {
      this.update({ disconnectError: describeError(error) });
    } finally {
      this.update({ disconnecting: false });
    }
  }

  /** The user dismissed the line about opening at login, or acted on it. */
  dismissConnectedLine(): void {
    this.update({ justConnected: false });
  }

  private read(run: number): void {
    this.fresh.clear();
    this.api.getCalendarConnection().then(
      (connection) => {
        if (run !== this.run) return;
        this.update({
          connectionStatus: 'ready',
          connectionError: null,
          ...(this.fresh.has('connection') ? {} : { connection }),
        });
      },
      (error: unknown) => {
        if (run === this.run) {
          this.update({ connectionStatus: 'failed', connectionError: describeError(error) });
        }
      },
    );
    this.api.getCalendarEvents().then(
      (events) => {
        if (run !== this.run) return;
        this.update({ loaded: true, ...(this.fresh.has('events') ? {} : { events }) });
      },
      (error: unknown) => {
        if (run === this.run) this.update({ copyError: describeError(error) });
      },
    );
    this.api.getCalendarSyncState().then(
      (sync) => {
        if (run !== this.run) return;
        if (!this.fresh.has('sync')) this.update({ sync });
      },
      (error: unknown) => {
        if (run === this.run) this.update({ copyError: describeError(error) });
      },
    );
  }
}
