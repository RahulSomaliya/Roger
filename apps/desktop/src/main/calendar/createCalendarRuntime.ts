import {
  toMeetingCalendarEvent,
  type CalendarAttendee,
  type CalendarEvent,
} from '../../shared/calendar';
import { isApiBlank, type StartCaptureRequest } from '../../shared/capture';
import { CalendarClient } from '../api/calendarClient';
import type { ApiConnection } from '../api/http';
import type { CaptureService, StartRequestEnricher } from '../capture/CaptureService';
import type { IpcMainLike } from '../ipc/trust';
import type { Logger } from '../logger';
import type { Navigation } from '../navigation';
import type { PreferencesStore } from '../preferences/PreferencesStore';
import {
  PromptService,
  revealWithoutFocus,
  type PromptCapture,
  type RevealableWindow,
} from '../prompt/PromptService';
import type { TranscriptStore } from '../store/TranscriptStore';
import { CalendarAccount } from './CalendarAccount';
import { registerCalendarIpc, type CalendarIpcWindow } from './calendarIpc';
import { registerCalendarPreferences } from './calendarPreferences';
import { CalendarSync } from './CalendarSync';
import type { NoticeClipboard } from './consentNotice';
import type { CalendarApiPort } from './ports';
import { PromptLog } from './PromptLog';
import {
  type AppSuspensionBlocker,
  ReminderScheduler,
  type ResumeEvents,
} from './ReminderScheduler';
import { oneClearMatch } from './reminderPolicy';
import type { SqliteCalendarCache } from './SqliteCalendarCache';

/**
 * How long the quit waits for the calendar's hook: a sign-in code already sent to the API is
 * redeemed and recorded first (CalendarAccount.stop), and that is one API round trip.
 */
export const CALENDAR_QUIT_TIMEOUT_MS = 5_000;

/** The main window as the calendar's three consumers use it; Electron's BrowserWindow fits. */
export type CalendarWindow = CalendarIpcWindow & RevealableWindow;

/** The parts of Electron the calendar uses, passed in so tests run with none of it. */
export interface CalendarElectronPorts {
  app: {
    on(event: 'browser-window-focus', listener: (event: unknown, window: object) => void): unknown;
  };
  /** `resume` only: the scheduler listens to it itself, and this file wires it to the sync. */
  powerMonitor: ResumeEvents;
  powerSaveBlocker: AppSuspensionBlocker;
  shell: { openExternal(url: string): Promise<void> };
  clipboard: NoticeClipboard;
}

export interface CalendarRuntimeDeps {
  /**
   * `calendar.sqlite`, opened by index.ts. The runtime's quit hook closes it, after everything
   * that reads it has stopped.
   */
  cache: SqliteCalendarCache;
  /** The Roger API, for `CalendarClient`. A test passes `api` instead. */
  apiConnection: ApiConnection;
  api?: CalendarApiPort;
  preferences: PreferencesStore;
  /** roger.sqlite: Home's "Open note" lookup. */
  store: Pick<TranscriptStore, 'findMeetingIdsByEventIds'>;
  /** CaptureService: the runtime sets its start-request enricher, once, and the prompts drive it. */
  capture: PromptCapture & Pick<CaptureService, 'setStartRequestEnricher'>;
  /** `app:navigate`, the const of `[slot M4-S1]`. */
  navigation: Pick<Navigation, 'navigate'>;
  ipcMain: IpcMainLike;
  getWindow: () => CalendarWindow | null;
  /** Show and focus the main window: what the app menu's `open` does, without its route. */
  openWindow: () => void;
  electron: CalendarElectronPorts;
  logger: Logger;
  clock?: () => Date;
}

export interface CalendarRuntime {
  account: CalendarAccount;
  sync: CalendarSync;
  scheduler: ReminderScheduler;
  /**
   * The prompt panel's brain. Nothing draws it from here: M5-T10's PromptWindow renders
   * `getState()` and `registerPromptIpc` carries its clicks, and neither exists in this slot.
   */
  prompts: PromptService;
  /** For the quit-hook list in index.ts: stops the calendar, then closes calendar.sqlite. */
  stop(): Promise<void>;
}

/**
 * The invite's attendees for a local meeting, from what M5-T5 stored on it
 * (`meetings.calendar_event_json`); none for a meeting no event was linked to. This is the
 * `attendees` getter of the `new NotesGenerator` call in index.ts: M4's template rule reads an
 * invitee outside the user's domain as a client call, and without it every meeting reads as having
 * no attendees.
 */
export function meetingAttendees(
  store: Pick<TranscriptStore, 'getMeeting'>,
): (meetingId: string) => readonly CalendarAttendee[] {
  return (meetingId) => store.getMeeting(meetingId)?.calendarEvent?.attendees ?? [];
}

/**
 * Links a start that carried no event to the one call that is running or about to start (M5,
 * "Manual start near a meeting"): a start from Home, the menu bar or a detected call. `oneClearMatch`
 * returns nothing for two overlapping calls, so a start never links the wrong one.
 *
 * Pure and synchronous: CaptureService runs it on every start that makes a meeting, in the middle
 * of Start, and falls back to the request as it came if it throws. It reads this Mac's copy of the
 * calendar, never the API. A request that already names an event (a prompt's) is left alone, and
 * so is a title the user typed: the invite supplies only a missing one.
 */
export function createStartRequestEnricher(options: {
  events: () => readonly CalendarEvent[];
  clock: () => Date;
}): StartRequestEnricher {
  return (request): StartCaptureRequest => {
    if (request.calendarEvent !== undefined && request.calendarEvent !== null) return request;
    const match = oneClearMatch(options.events(), options.clock().getTime());
    if (match === null) return request;
    const linked: StartCaptureRequest = {
      ...request,
      calendarEvent: toMeetingCalendarEvent(match),
    };
    // An invite with no title leaves the request's: main then names the meeting after its start.
    if ((request.title === undefined || isApiBlank(request.title)) && !isApiBlank(match.title)) {
      linked.title = match.title;
    }
    return linked;
  };
}

/**
 * M5's calendar in main: the account, the synced copy, the reminder scheduler, the prompt
 * service, their IPC and the start-request enricher. index.ts calls it once, from
 * `[slot M5-T9c]`, after capture, navigation and the notes slot exist.
 *
 * Start order matters:
 * 1. `scheduler.start()` settles the last run's open prompt rows and reads the last heartbeat
 *    before this run writes its own;
 * 2. `prompts.start()` before the first sync result, so a stale state is seen;
 * 3. `sync.start(launch)` with that heartbeat, which sizes the catch-up fetch;
 * 4. `account.start()` last, since it may record a connection another build made.
 * The preferences are registered first: `PromptService.start` and the scheduler's lead read them,
 * and `PreferencesStore.get` throws "unknown preference" for a key nobody registered.
 *
 * Quit (`stop`): scheduler, prompts, the account's in-flight exchange, the sync, then the cache.
 * The account must be awaited before the sync stops and the cache closes: a connect still
 * recording itself would write to a closed file, and the next launch would have to repair the log.
 */
export function createCalendarRuntime(deps: CalendarRuntimeDeps): CalendarRuntime {
  const { cache, preferences, capture, electron, getWindow, logger } = deps;
  const clock = deps.clock ?? (() => new Date());
  registerCalendarPreferences(preferences);

  const api = deps.api ?? new CalendarClient(deps.apiConnection);
  const sync = new CalendarSync({
    api,
    cache,
    logger: logger.child({ component: 'calendar-sync' }),
    clock,
  });
  const account = new CalendarAccount({
    api,
    sync,
    cache,
    openExternal: (url) => electron.shell.openExternal(url),
    logger: logger.child({ component: 'calendar-account' }),
  });
  const log = new PromptLog(cache.database);
  const prompts = new PromptService({
    cache,
    log,
    capture,
    navigation: deps.navigation,
    revealWindow: revealWithoutFocus(getWindow),
    openWindow: deps.openWindow,
    openExternal: (url) => electron.shell.openExternal(url),
    logger: logger.child({ component: 'prompts' }),
    clock: () => clock().getTime(),
  });
  const scheduler = new ReminderScheduler({
    cache,
    sync,
    log,
    prompts,
    leadMinutes: () => preferences.get('calendar.reminderLeadMinutes'),
    powerMonitor: electron.powerMonitor,
    powerSaveBlocker: electron.powerSaveBlocker,
    logger: logger.child({ component: 'reminders' }),
    clock,
  });

  capture.setStartRequestEnricher(
    createStartRequestEnricher({ events: () => cache.listEvents(), clock }),
  );
  registerCalendarIpc({
    ipcMain: deps.ipcMain,
    account,
    sync,
    cache,
    findMeetingIdsByEventIds: (eventIds) => deps.store.findMeetingIdsByEventIds(eventIds),
    getWindow,
    logger: logger.child({ component: 'ipc' }),
  });

  // The window's `focus` is the app's `browser-window-focus`: the window is created after this
  // runs, and the prompt panel (never focusable) must not count as the user looking.
  electron.app.on('browser-window-focus', (_event, focused) => {
    if (focused === getWindow()) sync.onWindowFocus();
  });
  electron.powerMonitor.on('resume', () => {
    sync.onWake();
  });

  const launch = scheduler.start();
  prompts.start();
  sync.start(launch);
  void account.start();

  return {
    account,
    sync,
    scheduler,
    prompts,
    stop: async () => {
      scheduler.stop();
      prompts.stop();
      try {
        await account.stop();
      } finally {
        sync.stop();
        cache.close();
      }
    },
  };
}
