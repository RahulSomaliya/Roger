import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  promptKey,
  toMeetingCalendarEvent,
  type CalendarEvent,
  type CalendarSyncState,
  type CallApp,
  type PromptCard,
  type TimedCalendarEvent,
} from '../../shared/calendar';
import { CALENDAR_PREFERENCES, DEFAULT_NOTICE_TEXT } from '../../shared/calendarPrefs';
import {
  idleCaptureStatus,
  type CaptureStatus,
  type SourceStatus,
  type StartCaptureRequest,
  type SttStreamState,
  type UploadStatus,
} from '../../shared/capture';
import type { AppRoute } from '../../shared/ipc/app';
import type { PromptPanelState } from '../../shared/ipc/prompt';
import { APP_PREFERENCES } from '../../shared/preferences';
import type { AudioSource } from '../../shared/transcript';
import { createConsentNotice } from '../calendar/consentNotice';
import { NO_ACCOUNT, PromptLog, type PromptRow } from '../calendar/PromptLog';
import { PROMPT_OPEN_AFTER_START_MS } from '../calendar/reminderPolicy';
import { SqliteCalendarCache } from '../calendar/SqliteCalendarCache';
import type { CaptureService } from '../capture/CaptureService';
import { createLogger } from '../logger';
import { PreferencesStore, type PreferenceFiles } from '../preferences/PreferencesStore';
import {
  CALL_OFFER_QUIET_AFTER_ACTION_MS,
  PromptService,
  revealWithoutFocus,
  START_OUTCOME_WINDOW_MS,
  TAKING_NOTES_SHOWN_MS,
  type PromptCapture,
} from './PromptService';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;
const START = Date.parse('2026-10-06T08:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const ACCOUNT = 'rahul@linkt.ai';
const MEETING = '3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e';
const EARLIER_MEETING = '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';
const ZOOM: CallApp = { bundleId: 'us.zoom.xos', name: 'Zoom' };
const MIC_DENIED =
  'Microphone access is denied. Allow Roger under System Settings → Privacy & Security → Microphone.';

/** A call `minutes` after START, 30 min long: the user and Jane, with the Meet link Google added. */
function call(
  id: string,
  minutes: number,
  overrides: Partial<TimedCalendarEvent> = {},
): TimedCalendarEvent {
  return {
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
      {
        email: ACCOUNT,
        displayName: null,
        responseStatus: 'accepted',
        isSelf: true,
        isOrganizer: false,
      },
    ],
    attendeesOmitted: false,
    videoLink: 'https://meet.google.com/abc-defg-hij',
    videoLinkSource: 'conference',
    htmlLink: null,
    ...overrides,
  };
}

const UPLOAD: UploadStatus = {
  state: 'idle',
  pending: 0,
  rejected: 0,
  lastError: null,
  nextAttemptAt: null,
};

/** How a source looks in a recording status: audio arriving or not, and its stream's state. */
interface SourceShape {
  audio: boolean;
  stream: SttStreamState;
}

const LIVE: SourceShape = { audio: true, stream: 'open' };
const NO_AUDIO: SourceShape = { audio: false, stream: 'open' };

function sourceStatus(shape: SourceShape): SourceStatus {
  return shape.audio
    ? { health: 'active', chunks: 40, lastChunkAt: Date.now(), message: null }
    : { health: 'pending', chunks: 0, lastChunkAt: null, message: null };
}

/** CaptureService as the prompt service sees it, with its statuses played by the test. */
class FakeCapture implements PromptCapture {
  status: CaptureStatus = idleCaptureStatus(UPLOAD);
  /** Every call the service made, in order (openExternal is added by the harness). */
  readonly calls: string[] = [];
  readonly requests: StartCaptureRequest[] = [];
  pending: StartCaptureRequest | null = null;
  /** requestStart throws this, as CaptureService does for a field the window's start refuses. */
  refusal: string | null = null;
  private readonly listeners = new Set<(status: CaptureStatus) => void>();

  get phase(): CaptureStatus['phase'] {
    return this.status.phase;
  }

  getStatus(): CaptureStatus {
    return this.status;
  }

  on(_event: 'status', listener: (status: CaptureStatus) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  stop(): Promise<CaptureStatus> {
    this.calls.push('stop');
    this.emit({ ...idleCaptureStatus(UPLOAD) });
    return Promise.resolve(this.status);
  }

  requestStart(request: StartCaptureRequest): void {
    this.calls.push('requestStart');
    if (this.refusal !== null) throw new Error(this.refusal);
    this.requests.push(request);
    this.pending = request;
  }

  takePendingStart(): StartCaptureRequest | null {
    this.calls.push('takePendingStart');
    const pending = this.pending;
    this.pending = null;
    return pending;
  }

  emit(change: Partial<CaptureStatus>): void {
    this.status = { ...this.status, ...change };
    for (const listener of [...this.listeners]) listener(this.status);
  }

  /** The window took the request and main's start began. */
  beginStart(): void {
    this.pending = null;
    this.emit({ phase: 'starting', meetingId: null, error: null });
  }

  record(meetingId: string, sources: Record<AudioSource, SourceShape>): void {
    this.emit({
      phase: 'recording',
      meetingId,
      title: 'A meeting',
      startedAt: iso(Date.now()),
      sources: { mic: sourceStatus(sources.mic), system: sourceStatus(sources.system) },
      streams: { mic: sources.mic.stream, system: sources.system.stream },
    });
  }
}

/** A preferences.json that lives in memory. */
function memoryFiles(): PreferenceFiles {
  const files = new Map<string, string>();
  return {
    readFileSync: (path) => {
      const text = files.get(path);
      if (text === undefined) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      }
      return text;
    },
    writeFileSync: (path, text) => {
      files.set(path, text);
    },
    renameSync: (from, to) => {
      const text = files.get(from);
      if (text === undefined) throw new Error(`ENOENT: ${from}`);
      files.set(to, text);
      files.delete(from);
    },
  };
}

/** The main window as the reveal port sees it, with Electron's two activating calls watched too. */
function fakeWindow(visible: boolean) {
  const calls: string[] = [];
  const window = {
    visible,
    isDestroyed: () => false,
    isVisible: () => window.visible,
    isMinimized: () => false,
    showInactive: () => {
      calls.push('showInactive');
      window.visible = true;
    },
    show: () => {
      calls.push('show');
    },
    focus: () => {
      calls.push('focus');
    },
  };
  return { window, calls };
}

interface HarnessOptions {
  connected?: boolean;
  events?: CalendarEvent[];
  windowVisible?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const cache = new SqliteCalendarCache(':memory:');
  if (options.connected !== false) cache.recordConnected(ACCOUNT, iso(START - DAY));
  cache.replaceEvents(options.events ?? [], iso(START));
  const log = new PromptLog(cache.database);
  const capture = new FakeCapture();
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    level: 'debug',
    format: 'json',
    sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });

  let syncState: CalendarSyncState = {
    lastSuccessAt: iso(START),
    lastError: null,
    staleSince: null,
    reconnectRequired: false,
  };
  const syncListeners = new Set<(state: CalendarSyncState) => void>();

  const preferences = new PreferencesStore({ path: '/prefs.json', logger, files: memoryFiles() });
  preferences.register(APP_PREFERENCES);
  preferences.register(CALENDAR_PREFERENCES);
  const copied: string[] = [];
  const notice = createConsentNotice({
    preferences,
    clipboard: {
      writeText: (text) => {
        copied.push(text);
      },
    },
    logger,
  });

  const routes: AppRoute[] = [];
  const main = fakeWindow(options.windowVisible ?? false);
  const opened: string[] = [];
  const openWindow = vi.fn();
  const service = new PromptService({
    cache,
    sync: {
      getState: () => syncState,
      onStateChange: (listener) => {
        syncListeners.add(listener);
        return () => {
          syncListeners.delete(listener);
        };
      },
    },
    log,
    capture,
    navigation: {
      navigate: (route) => {
        routes.push(route);
      },
    },
    revealWindow: revealWithoutFocus(() => main.window),
    openWindow,
    openExternal: (url) => {
      capture.calls.push('openExternal');
      opened.push(url);
      return Promise.resolve();
    },
    notice,
    logger,
  });
  const states: PromptPanelState[] = [];
  service.onChange((state) => states.push(state));
  service.start();

  const cards = (): PromptCard[] => service.getState().cards;
  const onlyCard = (): PromptCard => {
    const all = cards();
    expect(all).toHaveLength(1);
    const [card] = all;
    if (card === undefined) throw new Error('no card');
    return card;
  };
  return {
    cache,
    log,
    capture,
    service,
    preferences,
    copied,
    routes,
    main,
    opened,
    openWindow,
    states,
    lines,
    cards,
    onlyCard,
    row: (event: TimedCalendarEvent) => log.get(ACCOUNT, promptKey(event)),
    offerCalendar: (event: TimedCalendarEvent) => {
      service.offer({ source: 'calendar', eventKey: promptKey(event) });
    },
    offerCall: (app: CallApp = ZOOM) => {
      service.offer({ source: 'call_detected', app });
    },
    setEvents: (events: CalendarEvent[]) => {
      cache.replaceEvents(events, iso(Date.now()));
    },
    setSync: (state: Partial<CalendarSyncState>) => {
      syncState = { ...syncState, ...state };
      for (const listener of [...syncListeners]) listener(syncState);
    },
    /** The call-detected rows, oldest first. */
    callRows: (): PromptRow[] =>
      cache.database
        .prepare(`SELECT account_email, key FROM prompts WHERE source = 'call_detected'`)
        .all()
        .flatMap((row) => {
          const found = log.get(String(row.account_email), String(row.key));
          return found === null ? [] : [found];
        }),
    messages: () => lines.map((line) => line.message),
  };
}

type Harness = ReturnType<typeof harness>;

/** The card's id, for an action on it. */
function cardId(h: Harness): string {
  return h.onlyCard().id;
}

async function takeNotes(h: Harness, event: TimedCalendarEvent): Promise<void> {
  await h.service.act({ cardId: cardId(h), action: 'take_notes', eventId: event.id });
}

/** calendar.sqlite refuses every write to `event`'s row from now on (a full disk). Returns the fix. */
function failWrites(h: Harness, event: TimedCalendarEvent): () => void {
  const recordAction = h.log.recordAction.bind(h.log);
  const spy = vi.spyOn(h.log, 'recordAction').mockImplementation((entry) => {
    if (entry.key === promptKey(event)) throw new Error('database or disk is full');
    return recordAction(entry);
  });
  return () => {
    spy.mockRestore();
  };
}

describe('PromptService', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: START });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Checked by tsc, not at run time: index.ts hands CaptureService over as the port, unwrapped.
  it('takes CaptureService as its capture port', () => {
    expectTypeOf<CaptureService>().toExtend<PromptCapture>();
  });

  describe('calendar offers', () => {
    it('shows a card for the offered call and logs it shown', () => {
      const standup = call('standup', 1);
      const h = harness({ events: [standup] });
      h.offerCalendar(standup);

      expect(h.onlyCard()).toMatchObject({
        kind: 'calendar',
        phase: 'open',
        error: null,
        shownBy: 'calendar',
        events: [standup],
      });
      expect(h.row(standup)).toMatchObject({
        shownAt: iso(START),
        shownBy: 'calendar',
        action: null,
      });
      expect(h.states.at(-1)?.cards).toHaveLength(1);
    });

    it('puts calls starting within a minute on one card, each logged shown', () => {
      const first = call('first', 1);
      const second = call('second', 1.5);
      const later = call('later', 3);
      const h = harness({ events: [first, second, later] });
      h.offerCalendar(second);
      h.offerCalendar(first);
      h.offerCalendar(later);

      const [shared, own] = h.cards();
      expect(shared).toMatchObject({ kind: 'calendar', events: [first, second] });
      expect(own).toMatchObject({ kind: 'calendar', events: [later] });
      for (const event of [first, second, later]) expect(h.row(event)?.shownAt).toBe(iso(START));
    });

    it('keeps a throwing listener from the others and from the card', () => {
      const standup = call('standup', 1);
      const h = harness({ events: [standup] });
      h.service.onChange(() => {
        throw new Error('the panel is gone');
      });
      const seen: PromptPanelState[] = [];
      h.service.onChange((state) => seen.push(state));
      h.offerCalendar(standup);

      expect(seen.at(-1)?.cards).toHaveLength(1);
      expect(h.cards()).toHaveLength(1);
      const failure = h.lines.find((line) => line.message === 'prompt listener failed');
      expect(failure).toMatchObject({ event: 'change', error: 'the panel is gone' });
    });

    it('never shows a key twice, in this run or after a restart', () => {
      const standup = call('standup', 1);
      const h = harness({ events: [standup] });
      h.offerCalendar(standup);
      h.offerCalendar(standup);
      expect(h.cards()).toHaveLength(1);
    });

    it('never throws for an event that left the copy: it logs and shows nothing', () => {
      const h = harness({ events: [] });
      expect(() => {
        h.offerCalendar(call('gone', 1));
      }).not.toThrow();
      expect(h.cards()).toEqual([]);
      expect(h.messages()).toContain('calendar prompt not shown: the event is not in the copy');
    });

    it('expires at start + 10 min and logs it expired', async () => {
      const standup = call('standup', 1);
      const h = harness({ events: [standup] });
      h.offerCalendar(standup);

      const startMs = START + MINUTE;
      await vi.advanceTimersByTimeAsync(startMs + PROMPT_OPEN_AFTER_START_MS - 1 - Date.now());
      expect(h.cards()).toHaveLength(1);
      expect(h.row(standup)?.action).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(h.cards()).toEqual([]);
      expect(h.row(standup)).toMatchObject({ action: 'expired', decidedAt: iso(Date.now()) });
    });

    it('expires within 10 s of a wake when the window closed during a sleep', async () => {
      const standup = call('standup', 1);
      const h = harness({ events: [standup] });
      h.offerCalendar(standup);
      await vi.advanceTimersByTimeAsync(MINUTE);

      // The lid shut for 50 min: the clock moved on, and every timer kept its remaining wait.
      vi.setSystemTime(START + 51 * MINUTE);
      expect(h.cards()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(10 * SECOND);
      expect(h.cards()).toEqual([]);
      expect(h.row(standup)?.action).toBe('expired');
    });
  });

  describe('Take notes', () => {
    it('asks for a notification start with the title and the attendees', async () => {
      const standup = call('standup', 1);
      const h = harness({ events: [standup] });
      h.offerCalendar(standup);
      await takeNotes(h, standup);

      expect(h.capture.requests).toEqual([
        {
          source: 'notification',
          title: 'Call standup',
          calendarEvent: toMeetingCalendarEvent(standup),
        },
      ]);
      expect(h.row(standup)).toMatchObject({ action: 'starting', meetingId: null });
      expect(h.onlyCard()).toMatchObject({ phase: 'taking_notes', error: null });
    });

    it('logs started only once both sources deliver and both streams are open', async () => {
      const standup = call('standup', 1);
      const h = harness({ events: [standup] });
      h.offerCalendar(standup);
      await takeNotes(h, standup);

      h.capture.beginStart();
      h.capture.record(MEETING, { mic: LIVE, system: NO_AUDIO });
      expect(h.row(standup)?.action).toBe('starting');
      expect(h.routes).toEqual([`meeting/${MEETING}`]);

      h.capture.record(MEETING, { mic: LIVE, system: { audio: true, stream: 'connecting' } });
      expect(h.row(standup)?.action).toBe('starting');

      h.capture.record(MEETING, { mic: LIVE, system: LIVE });
      expect(h.row(standup)).toMatchObject({ action: 'started', meetingId: MEETING, reason: null });
      // The meeting opens once, not on every status.
      expect(h.routes).toEqual([`meeting/${MEETING}`]);
    });

    it('logs started_degraded with system when call audio never arrives in 20 s', async () => {
      const standup = call('standup', 1);
      const h = harness({ events: [standup] });
      h.offerCalendar(standup);
      await takeNotes(h, standup);
      h.capture.beginStart();
      h.capture.record(MEETING, { mic: LIVE, system: NO_AUDIO });

      await vi.advanceTimersByTimeAsync(START_OUTCOME_WINDOW_MS - 1);
      expect(h.row(standup)?.action).toBe('starting');
      await vi.advanceTimersByTimeAsync(1);
      expect(h.row(standup)).toMatchObject({
        action: 'started_degraded',
        reason: 'system',
        detail: 'system: no audio',
        meetingId: MEETING,
      });
    });

    it('logs start_failed and keeps the card when the microphone is denied', async () => {
      const standup = call('standup', 1);
      const h = harness({ events: [standup] });
      h.offerCalendar(standup);
      await takeNotes(h, standup);
      h.capture.beginStart();
      h.capture.emit({ phase: 'idle', error: MIC_DENIED });

      expect(h.row(standup)).toMatchObject({
        action: 'start_failed',
        reason: 'capture_failed',
        detail: MIC_DENIED,
      });
      expect(h.onlyCard()).toMatchObject({ phase: 'open', error: MIC_DENIED });

      // The card is there to try again.
      await takeNotes(h, standup);
      expect(h.row(standup)?.action).toBe('starting');
      expect(h.capture.requests).toHaveLength(2);
    });

    it('stops the note being recorded first, then asks for the start', async () => {
      const standup = call('standup', 1);
      const h = harness({ events: [standup] });
      h.capture.record(EARLIER_MEETING, { mic: LIVE, system: LIVE });
      h.offerCalendar(standup);
      expect(h.service.getState().recording).toBe(true);

      await takeNotes(h, standup);
      expect(h.capture.calls).toEqual(['stop', 'requestStart']);
      // The stopped note's statuses are not this start's: it is still starting.
      expect(h.row(standup)?.action).toBe('starting');
      expect(h.routes).toEqual([]);
    });

    it('shows "Taking notes" for 5 s; a failure after that brings the card back', async () => {
      const standup = call('standup', 1);
      const h = harness({ events: [standup] });
      h.offerCalendar(standup);
      await takeNotes(h, standup);

      await vi.advanceTimersByTimeAsync(TAKING_NOTES_SHOWN_MS);
      expect(h.cards()).toEqual([]);

      h.capture.beginStart();
      h.capture.emit({ phase: 'idle', error: MIC_DENIED });
      expect(h.onlyCard()).toMatchObject({ kind: 'calendar', phase: 'open', error: MIC_DENIED });
    });

    it('withdraws a request no window took in 20 s and logs start_failed', async () => {
      const standup = call('standup', 1);
      const h = harness({ events: [standup] });
      h.offerCalendar(standup);
      await takeNotes(h, standup);

      await vi.advanceTimersByTimeAsync(START_OUTCOME_WINDOW_MS);
      expect(h.capture.calls).toEqual(['requestStart', 'takePendingStart']);
      expect(h.capture.pending).toBeNull();
      expect(h.row(standup)).toMatchObject({ action: 'start_failed', reason: 'not_taken' });
      expect(h.onlyCard()).toMatchObject({ phase: 'open' });
      expect(h.onlyCard()).not.toMatchObject({ error: null });
    });

    it('opens the note of a start still starting at 20 s once it records, logging it once', async () => {
      const standup = call('standup', 1);
      const h = harness({ events: [standup] });
      h.offerCalendar(standup);
      await takeNotes(h, standup);
      // The window took the request; main's start waits on the first run's microphone dialog.
      h.capture.beginStart();

      await vi.advanceTimersByTimeAsync(START_OUTCOME_WINDOW_MS);
      expect(h.row(standup)).toMatchObject({
        action: 'start_failed',
        reason: 'not_started_in_time',
      });
      expect(h.cards()).toEqual([]);

      // The user clicks Allow at 25 s: the note records, and its page still opens, once.
      await vi.advanceTimersByTimeAsync(5 * SECOND);
      h.capture.record(MEETING, { mic: LIVE, system: NO_AUDIO });
      h.capture.record(MEETING, { mic: LIVE, system: LIVE });
      expect(h.routes).toEqual([`meeting/${MEETING}`]);
      // The 20 s bar decided the row, and start_failed stays final.
      expect(h.row(standup)).toMatchObject({
        action: 'start_failed',
        reason: 'not_started_in_time',
        meetingId: null,
      });
    });

    it('opens no page for a late start that ends unrecorded, nor for the next note', async () => {
      const standup = call('standup', 1);
      const h = harness({ events: [standup] });
      h.offerCalendar(standup);
      await takeNotes(h, standup);
      h.capture.beginStart();
      await vi.advanceTimersByTimeAsync(START_OUTCOME_WINDOW_MS);
      h.capture.emit({ phase: 'idle', error: MIC_DENIED });

      // A note started later from Home is not this prompt's.
      h.capture.beginStart();
      h.capture.record(MEETING, { mic: LIVE, system: LIVE });
      expect(h.routes).toEqual([]);
    });

    it('logs start_failed with the refusal when capture refuses the request', async () => {
      const standup = call('standup', 1);
      const h = harness({ events: [standup] });
      h.offerCalendar(standup);
      const refusal =
        'invalid start request: calendarEvent.attendees[0].email is over 2048 characters';
      h.capture.refusal = refusal;
      await takeNotes(h, standup);

      expect(h.row(standup)).toMatchObject({
        action: 'start_failed',
        reason: 'request_refused',
        detail: refusal,
      });
      expect(h.onlyCard()).toMatchObject({ phase: 'open', error: refusal });
    });

    it('on a card of two calls, starts the one clicked and lets the other expire', async () => {
      const first = call('first', 1);
      const second = call('second', 1.5);
      const h = harness({ events: [first, second] });
      h.offerCalendar(first);
      h.offerCalendar(second);
      await h.service.act({ cardId: cardId(h), action: 'take_notes', eventId: second.id });

      expect(h.capture.requests[0]?.calendarEvent?.eventId).toBe('second');
      await vi.advanceTimersByTimeAsync(TAKING_NOTES_SHOWN_MS);
      expect(h.cards()).toEqual([]);
      expect(h.row(first)).toMatchObject({ action: 'expired', reason: 'another_event_started' });
      expect(h.row(second)?.action).toBe('starting');
    });

    it('never calls show() or focus(); showInactive() only while the window is hidden', async () => {
      const standup = call('standup', 1);
      const hidden = harness({ events: [standup], windowVisible: false });
      hidden.offerCalendar(standup);
      await takeNotes(hidden, standup);
      expect(hidden.main.calls).toEqual(['showInactive']);

      const shown = harness({ events: [standup], windowVisible: true });
      shown.offerCalendar(standup);
      await shown.service.act({ cardId: cardId(shown), action: 'copy_notice' });
      await shown.service.act({
        cardId: cardId(shown),
        action: 'join_and_take_notes',
        eventId: standup.id,
      });
      expect(shown.main.calls).toEqual([]);

      const dismissed = harness({ events: [standup], windowVisible: false });
      dismissed.offerCalendar(standup);
      await dismissed.service.act({ cardId: cardId(dismissed), action: 'dismiss' });
      expect(dismissed.main.calls).toEqual([]);
    });

    it('opens Roger on request from a card taking notes', async () => {
      const standup = call('standup', 1);
      const h = harness({ events: [standup] });
      h.offerCalendar(standup);
      await takeNotes(h, standup);
      await h.service.act({ cardId: cardId(h), action: 'open_roger' });
      expect(h.openWindow).toHaveBeenCalledTimes(1);
      expect(h.cards()).toEqual([]);
      // The start goes on: its outcome is still logged.
      h.capture.beginStart();
      h.capture.record(MEETING, { mic: LIVE, system: LIVE });
      expect(h.row(standup)?.action).toBe('started');
    });
  });

  describe('Join and take notes', () => {
    it('opens the allowlisted link, then starts, and logs joined_and_started', async () => {
      const zoomCall = call('client', 1, {
        videoLink: 'https://zoom.us/j/1234567890',
        videoLinkSource: 'location',
      });
      const h = harness({ events: [zoomCall] });
      h.offerCalendar(zoomCall);
      await h.service.act({ cardId: cardId(h), action: 'join_and_take_notes', eventId: 'client' });

      expect(h.opened).toEqual(['https://zoom.us/j/1234567890']);
      expect(h.capture.calls).toEqual(['openExternal', 'requestStart']);
      h.capture.beginStart();
      h.capture.record(MEETING, { mic: LIVE, system: LIVE });
      expect(h.row(zoomCall)?.action).toBe('joined_and_started');
    });

    it('opens no link off the allowlist and starts nothing', async () => {
      const lookalike = call('lookalike', 1, {
        videoLink: 'https://meet.google.com.evil.io/abc-defg-hij',
        videoLinkSource: 'description',
      });
      const h = harness({ events: [lookalike] });
      h.offerCalendar(lookalike);
      await h.service.act({
        cardId: cardId(h),
        action: 'join_and_take_notes',
        eventId: 'lookalike',
      });

      expect(h.opened).toEqual([]);
      expect(h.capture.requests).toEqual([]);
      expect(h.row(lookalike)?.action).toBeNull();
      expect(h.onlyCard()).toMatchObject({ phase: 'open' });
      expect(h.onlyCard()).not.toMatchObject({ error: null });
    });
  });

  describe('the notice', () => {
    it('copies the current text and keeps the card', async () => {
      const standup = call('standup', 1);
      const h = harness({ events: [standup] });
      h.offerCalendar(standup);
      await h.service.act({ cardId: cardId(h), action: 'copy_notice' });
      h.preferences.set('notice.text', 'Roger is taking notes on this call.');
      await h.service.act({ cardId: cardId(h), action: 'copy_notice' });

      expect(h.copied).toEqual([DEFAULT_NOTICE_TEXT, 'Roger is taking notes on this call.']);
      expect(h.onlyCard()).toMatchObject({ phase: 'open' });
      expect(h.row(standup)?.action).toBeNull();
    });

    it('notice off: the panel offers no Copy notice and nothing is copied', async () => {
      const standup = call('standup', 1);
      const h = harness({ events: [standup] });
      h.offerCalendar(standup);
      expect(h.service.getState().noticeEnabled).toBe(true);

      h.preferences.set('notice.enabled', false);
      expect(h.states.at(-1)?.noticeEnabled).toBe(false);
      await h.service.act({ cardId: cardId(h), action: 'copy_notice' });
      expect(h.copied).toEqual([]);
    });
  });

  describe('Dismiss', () => {
    it('logs every event on the card dismissed and closes it', async () => {
      const first = call('first', 1);
      const second = call('second', 1.5);
      const h = harness({ events: [first, second] });
      h.offerCalendar(first);
      h.offerCalendar(second);
      await h.service.act({ cardId: cardId(h), action: 'dismiss' });

      expect(h.cards()).toEqual([]);
      expect(h.row(first)?.action).toBe('dismissed');
      expect(h.row(second)?.action).toBe('dismissed');
    });
  });

  describe('a stale calendar', () => {
    it('shows one card per stale spell', async () => {
      const h = harness();
      const spell = { staleSince: iso(START - MINUTE), lastSuccessAt: iso(START - 61 * MINUTE) };
      h.setSync(spell);
      expect(h.onlyCard()).toMatchObject({
        kind: 'stale_calendar',
        lastSuccessAt: iso(START - 61 * MINUTE),
      });
      h.setSync({ ...spell, lastError: 'connect ECONNREFUSED' });
      expect(h.cards()).toHaveLength(1);

      await h.service.act({ cardId: cardId(h), action: 'dismiss' });
      h.setSync({ ...spell, lastError: 'still down' });
      expect(h.cards()).toEqual([]);

      h.setSync({ staleSince: null, lastSuccessAt: iso(START) });
      expect(h.cards()).toEqual([]);
      h.setSync({ staleSince: iso(START + 60 * MINUTE), lastSuccessAt: iso(START) });
      expect(h.onlyCard()).toMatchObject({ kind: 'stale_calendar', lastSuccessAt: iso(START) });
    });

    it('takes the card down when the spell ends', () => {
      const h = harness();
      h.setSync({ staleSince: iso(START), lastSuccessAt: iso(START - 60 * MINUTE) });
      expect(h.cards()).toHaveLength(1);
      h.setSync({ staleSince: null, lastSuccessAt: iso(START) });
      expect(h.cards()).toEqual([]);
    });
  });

  describe('a deadline whose row cannot be written', () => {
    const failures = (h: Harness): number =>
      h.messages().filter((message) => message === 'prompt deadline could not be settled').length;

    it('retries its expiry every 10 s, never in a loop, and the next card expires on time', async () => {
      const first = call('first', 1);
      const later = call('later', 3.25);
      const h = harness({ events: [first, later] });
      h.offerCalendar(first);
      h.offerCalendar(later);
      const recover = failWrites(h, first);

      await vi.advanceTimersByTimeAsync(START + MINUTE + PROMPT_OPEN_AFTER_START_MS - Date.now());
      expect(failures(h)).toBe(1);
      await vi.advanceTimersByTimeAsync(10 * SECOND - 1);
      expect(failures(h)).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(failures(h)).toBe(2);

      // Off the 10 s retries, and after the failing card in the list.
      await vi.advanceTimersByTimeAsync(
        START + 3.25 * MINUTE + PROMPT_OPEN_AFTER_START_MS - Date.now(),
      );
      expect(h.row(later)?.action).toBe('expired');
      expect(h.onlyCard()).toMatchObject({ events: [first] });

      recover();
      await vi.advanceTimersByTimeAsync(10 * SECOND);
      expect(h.row(first)?.action).toBe('expired');
      expect(h.cards()).toEqual([]);
    });

    it('still decides a start at 20 s while another card fails to expire', async () => {
      const ended = call('ended', -9.9);
      const standup = call('standup', 1);
      const h = harness({ events: [ended, standup] });
      h.offerCalendar(ended);
      h.offerCalendar(standup);
      failWrites(h, ended);
      const card = h
        .cards()
        .find((shown) => shown.kind === 'calendar' && shown.events[0].id === standup.id);
      if (card === undefined) throw new Error('no standup card');
      await h.service.act({ cardId: card.id, action: 'take_notes', eventId: standup.id });

      await vi.advanceTimersByTimeAsync(START_OUTCOME_WINDOW_MS);
      expect(failures(h)).toBeGreaterThan(0);
      expect(h.row(standup)).toMatchObject({ action: 'start_failed', reason: 'not_taken' });
    });

    it('keeps a shared card taking notes until its other call is logged expired', async () => {
      const first = call('first', 1);
      const second = call('second', 1.5);
      const h = harness({ events: [first, second] });
      h.offerCalendar(first);
      h.offerCalendar(second);
      await h.service.act({ cardId: cardId(h), action: 'take_notes', eventId: second.id });
      const recover = failWrites(h, first);

      await vi.advanceTimersByTimeAsync(TAKING_NOTES_SHOWN_MS);
      expect(h.onlyCard()).toMatchObject({ phase: 'taking_notes' });
      recover();
      await vi.advanceTimersByTimeAsync(10 * SECOND);
      expect(h.cards()).toEqual([]);
      expect(h.row(first)).toMatchObject({ action: 'expired', reason: 'another_event_started' });
    });
  });

  describe('offer: the D5 rules for a detected call', () => {
    it('offer_call_detected_dropped_while_a_note_starts_or_records', () => {
      const h = harness();
      h.capture.beginStart();
      h.offerCall();
      h.capture.record(MEETING, { mic: LIVE, system: LIVE });
      h.offerCall();
      expect(h.cards()).toEqual([]);
      expect(h.callRows()).toEqual([]);
    });

    it('offer_call_detected_dropped_while_a_calendar_card_shows', () => {
      const standup = call('standup', 1);
      const h = harness({ events: [standup] });
      h.offerCalendar(standup);
      h.offerCall();
      expect(h.onlyCard()).toMatchObject({ kind: 'calendar', shownBy: 'calendar' });
      expect(h.callRows()).toEqual([]);
    });

    it('offer_call_detected_dropped_within_15_min_of_a_calendar_card_answered', async () => {
      const standup = call('standup', 1);
      const h = harness({ events: [standup] });
      h.offerCalendar(standup);
      await h.service.act({ cardId: cardId(h), action: 'dismiss' });

      await vi.advanceTimersByTimeAsync(CALL_OFFER_QUIET_AFTER_ACTION_MS - 1);
      h.offerCall();
      expect(h.cards()).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      h.offerCall();
      // The call is still running, but its prompt was answered: no second calendar card.
      expect(h.onlyCard()).toMatchObject({ kind: 'call_detected', app: ZOOM });
    });

    it('offer_call_detected_shows_the_one_running_event_and_a_click_is_a_notification', async () => {
      const running = call('sync', -5);
      const h = harness({ events: [running] });
      h.offerCall();

      expect(h.onlyCard()).toMatchObject({
        kind: 'calendar',
        shownBy: 'call_detected',
        events: [running],
      });
      expect(h.row(running)).toMatchObject({ shownBy: 'call_detected', source: 'calendar' });
      expect(h.callRows()).toEqual([]);

      await takeNotes(h, running);
      expect(h.capture.requests[0]).toMatchObject({ source: 'notification', title: 'Call sync' });
    });

    it('offer_call_detected_with_no_event_shows_a_call_card_that_starts_call_detected', async () => {
      const h = harness({ connected: false });
      h.offerCall();

      expect(h.onlyCard()).toMatchObject({ kind: 'call_detected', app: ZOOM, phase: 'open' });
      expect(h.callRows()).toMatchObject([
        { accountEmail: NO_ACCOUNT, source: 'call_detected', title: 'Zoom', action: null },
      ]);
      await h.service.act({ cardId: cardId(h), action: 'take_notes' });
      expect(h.capture.requests).toEqual([{ source: 'call_detected' }]);

      h.capture.beginStart();
      h.capture.record(MEETING, { mic: LIVE, system: LIVE });
      expect(h.callRows()).toMatchObject([{ action: 'started', meetingId: MEETING }]);
    });

    it('offer_call_detected_dropped_while_a_card_for_the_same_app_shows', async () => {
      const h = harness({ connected: false });
      h.offerCall();
      // The mic went back to Zoom after a switch to AirPods: the same call, offered again.
      await vi.advanceTimersByTimeAsync(MINUTE);
      h.offerCall();

      expect(h.onlyCard()).toMatchObject({ kind: 'call_detected', app: ZOOM });
      expect(h.callRows()).toHaveLength(1);
      expect(h.messages()).toContain('call offer dropped: a card for this app is up');
    });

    it('offer_two_overlapping_events_link_nothing', () => {
      const h = harness({ events: [call('a', -5), call('b', 2)] });
      h.offerCall();
      expect(h.onlyCard()).toMatchObject({ kind: 'call_detected' });
    });

    it('offer_calendar_card_replaces_a_call_detected_card', () => {
      const h = harness();
      h.offerCall();
      expect(h.onlyCard()).toMatchObject({ kind: 'call_detected' });

      const standup = call('standup', 1);
      h.setEvents([standup]);
      h.offerCalendar(standup);
      expect(h.onlyCard()).toMatchObject({ kind: 'calendar', events: [standup] });
      expect(h.callRows()).toMatchObject([{ action: 'expired', reason: 'replaced_by_calendar' }]);
    });

    it('tells call detection when the user dismisses a call card, for its cooldown', async () => {
      const h = harness();
      const dismissed: CallApp[] = [];
      h.service.onCallCardDismissed((app) => dismissed.push(app));
      h.offerCall();
      await h.service.act({ cardId: cardId(h), action: 'dismiss' });
      expect(dismissed).toEqual([ZOOM]);
      expect(h.callRows()).toMatchObject([{ action: 'dismissed' }]);
    });
  });
});

describe('revealWithoutFocus', () => {
  it.each([
    ['visible', { visible: true, minimized: false, destroyed: false }, []],
    ['minimized', { visible: false, minimized: true, destroyed: false }, []],
    ['destroyed', { visible: false, minimized: false, destroyed: true }, []],
    ['hidden', { visible: false, minimized: false, destroyed: false }, ['showInactive']],
  ])('a %s window: %j', (_name, state, expected) => {
    const calls: string[] = [];
    revealWithoutFocus(() => ({
      isDestroyed: () => state.destroyed,
      isVisible: () => state.visible,
      isMinimized: () => state.minimized,
      showInactive: () => {
        calls.push('showInactive');
      },
    }))();
    expect(calls).toEqual(expected);
  });

  it('does nothing while there is no window', () => {
    expect(() => {
      revealWithoutFocus(() => null)();
    }).not.toThrow();
  });
});
