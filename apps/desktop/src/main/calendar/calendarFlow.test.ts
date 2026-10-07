import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarConnection, CalendarEvent, TimedCalendarEvent } from '../../shared/calendar';
import type { StartCaptureRequest } from '../../shared/capture';
import type { AppRoute } from '../../shared/ipc/app';
import { calendarChannels, type CalendarMeetingLink } from '../../shared/ipc/calendar';
import { APP_PREFERENCES } from '../../shared/preferences';
import type { AudioSource } from '../../shared/transcript';
import type { MeetingDto, SttTokenApi, UploadApi } from '../api/ApiClient';
import { CaptureService } from '../capture/CaptureService';
import type { SenderEvent } from '../ipc/trust';
import { createLogger } from '../logger';
import { PreferencesStore, type PreferenceFiles } from '../preferences/PreferencesStore';
import { InMemoryTranscriptStore } from '../store/InMemoryTranscriptStore';
import {
  SttEventEmitter,
  type OpenStreamOptions,
  type SpeechToText,
  type SttEventListener,
  type SttStream,
} from '../stt/SpeechToText';
import { sumUsage, type SttUsage } from '../stt/usage';
import { TranscriptUploader } from '../upload/TranscriptUploader';
import {
  createCalendarRuntime,
  type CalendarRuntime,
  type CalendarWindow,
} from './createCalendarRuntime';
import type { CalendarApiPort } from './ports';
import { SqliteCalendarCache } from './SqliteCalendarCache';

/**
 * The calendar end to end, on fakes and a fake clock (docs/plans/M5-calendar.md, "Tests"): the real
 * CaptureService, uploader, sync, cache, prompt log, scheduler and prompt service, wired by
 * createCalendarRuntime as index.ts wires them. Faked: Google (the API port), speech to text, the
 * window and Electron. The renderer's part of a start (`start-requested` -> `start`) is played by
 * `window.takeRequest`, which is what the real window does with takePendingStart.
 */

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const START = Date.parse('2026-10-06T08:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const ACCOUNT = 'rahul@linkt.ai';

const silent = createLogger({ level: 'error', format: 'json', sink: () => undefined });

/** A call `minutes` after START that is `length` minutes long: the user and one other person. */
function call(
  id: string,
  minutes: number,
  overrides: Partial<TimedCalendarEvent> & { guest?: string; length?: number } = {},
): TimedCalendarEvent {
  const { guest = 'jane@linkt.ai', length = 30, ...rest } = overrides;
  return {
    provider: 'fake',
    id,
    icalUid: `${id}@google.com`,
    recurringEventId: null,
    title: `Call ${id}`,
    status: 'confirmed',
    allDay: false,
    start: iso(START + minutes * MINUTE),
    end: iso(START + (minutes + length) * MINUTE),
    startDate: null,
    endDate: null,
    selfResponse: 'accepted',
    attendees: [
      {
        email: guest,
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
    ...rest,
  };
}

function memoryFiles(): PreferenceFiles {
  const files = new Map<string, string>();
  return {
    readFileSync: (path) => {
      const text = files.get(path);
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
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

/** Speech to text that opens both streams and says nothing until the test does. */
class QuietStt implements SpeechToText {
  readonly provider = 'scripted';
  readonly vendorName = 'Scripted';
  readonly streams = new Map<string, QuietStream>();
  /** Nothing is metered here: no billing is under test. */
  usage(): SttUsage {
    return sumUsage([]);
  }
  openStream(options: OpenStreamOptions): Promise<SttStream> {
    const stream = new QuietStream();
    this.streams.set(options.label, stream);
    return Promise.resolve(stream);
  }
}

class QuietStream implements SttStream {
  readonly emitter = new SttEventEmitter();
  send(): void {
    // Audio is not asserted on here.
  }
  close(): Promise<void> {
    this.emitter.emit({ type: 'closed', code: 1000, reason: null });
    return Promise.resolve();
  }
  on(listener: SttEventListener): () => void {
    return this.emitter.on(listener);
  }
}

function meetingDto(id: string): MeetingDto {
  return {
    id,
    workspace_id: 'w1',
    title: 'T',
    status: 'recording',
    started_at: iso(START),
    ended_at: null,
    segment_count: 0,
    start_source: 'manual',
    calendar_event: null,
    created_at: iso(START),
    updated_at: iso(START),
  };
}

interface Harness {
  runtime: CalendarRuntime;
  capture: CaptureService;
  store: InMemoryTranscriptStore;
  cache: SqliteCalendarCache;
  createMeeting: ReturnType<typeof vi.fn<UploadApi['createMeeting']>>;
  /** The routes main asked the page to open. */
  routes: AppRoute[];
  stt: QuietStt;
  /** Replace what Google answers; the next refresh (or a prompt's) shows it. */
  setEvents: (events: CalendarEvent[]) => void;
  /** Waits for the starts the window made from a request main handed it. */
  windowStarted: () => Promise<unknown>;
  /** `calendar:find-meetings`, asked as the main window's page. */
  findMeetings: (eventIds: string[]) => Promise<CalendarMeetingLink[]>;
  /** Run timers (and the fake clock) to `minutes` after START. */
  advanceTo: (minutes: number) => Promise<void>;
}

const MAIN_WINDOW_ID = 7;

function harness(initialEvents: CalendarEvent[]): Harness {
  let events = initialEvents;
  const cache = new SqliteCalendarCache(':memory:');
  // Connected a day ago, as a Mac that has run Roger before.
  cache.recordConnected(ACCOUNT, iso(START - 24 * 60 * MINUTE));
  const connection: CalendarConnection = {
    provider: 'fake',
    accountEmail: ACCOUNT,
    status: 'active',
    connectedAt: iso(START - 24 * 60 * MINUTE),
    expiresHint: null,
    lastError: null,
  };
  const api: CalendarApiPort = {
    createGoogleAuthorization: () => Promise.reject(new Error('no sign-in in this flow')),
    connectGoogle: () => Promise.reject(new Error('no sign-in in this flow')),
    getConnection: () => Promise.resolve(connection),
    disconnect: () => Promise.resolve(),
    listEvents: () => Promise.resolve({ items: events, fetchedAt: new Date().toISOString() }),
  };

  const store = new InMemoryTranscriptStore();
  const createMeeting = vi.fn<UploadApi['createMeeting']>((input) =>
    Promise.resolve(meetingDto(input.id)),
  );
  const uploadApi: UploadApi = {
    createMeeting,
    appendSegments: (_meetingId, segments) =>
      Promise.resolve({ accepted: segments.length, duplicates: 0 }),
    endMeeting: (meetingId) => Promise.resolve(meetingDto(meetingId)),
  };
  const tokenApi: SttTokenApi = {
    getSttToken: () =>
      Promise.resolve({
        provider: 'scripted',
        access_token: 'tok',
        expires_in: 30,
        stream: {
          model: 'm',
          language: 'en',
          sample_rate: 16000,
          encoding: 'linear16',
          price_per_hour_usd: 0.15,
          keyterms: [],
        },
      }),
  };
  const uploader = new TranscriptUploader({ store, api: uploadApi, logger: silent });
  const stt = new QuietStt();
  const capture = new CaptureService({
    store,
    api: tokenApi,
    uploader,
    createSpeechToText: () => stt,
    ensureMicrophoneAccess: () => Promise.resolve('granted'),
    logger: silent,
    sttProviderOverride: null,
    startupError: null,
  });

  const preferences = new PreferencesStore({
    path: '/preferences.json',
    logger: silent,
    files: memoryFiles(),
  });
  preferences.register(APP_PREFERENCES);
  const routes: AppRoute[] = [];
  const handlers = new Map<string, (event: SenderEvent, payload: unknown) => unknown>();
  const mainWindow: CalendarWindow = {
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false,
    showInactive: () => undefined,
    webContents: { id: MAIN_WINDOW_ID, send: () => undefined },
  };
  const powerMonitor = new EventEmitter();
  const runtime = createCalendarRuntime({
    cache,
    apiConnection: { baseUrl: 'http://api.invalid', token: 't' },
    api,
    preferences,
    store,
    capture,
    navigation: {
      navigate: (route) => {
        routes.push(route);
      },
    },
    ipcMain: {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
      on: () => undefined,
    },
    getWindow: () => mainWindow,
    openWindow: () => undefined,
    electron: {
      app: { on: () => undefined },
      powerMonitor,
      powerSaveBlocker: { start: () => 1, stop: () => undefined },
      shell: { openExternal: () => Promise.resolve() },
      clipboard: { writeText: () => undefined },
    },
    logger: silent,
  });

  // The renderer's part of a start: on `start-requested` the window takes the request and starts.
  const windowStarts: Promise<unknown>[] = [];
  capture.on('start-requested', () => {
    const request = capture.takePendingStart();
    if (request !== null) windowStarts.push(capture.start(request));
  });

  return {
    runtime,
    capture,
    store,
    cache,
    createMeeting,
    routes,
    stt,
    setEvents: (next) => {
      events = next;
    },
    windowStarted: () => Promise.all(windowStarts),
    findMeetings: async (eventIds) => {
      const handler = handlers.get(calendarChannels.CalendarFindMeetings);
      if (handler === undefined) throw new Error('calendar:find-meetings is not registered');
      return (await handler(
        { sender: { id: MAIN_WINDOW_ID } },
        { eventIds },
      )) as CalendarMeetingLink[];
    },
    advanceTo: async (minutes) => {
      await vi.advanceTimersByTimeAsync(START + minutes * MINUTE - Date.now());
    },
  };
}

/** A line the meeting keeps, so Stop uploads it instead of discarding an empty meeting. */
function say(h: Harness, source: AudioSource, text: string): void {
  h.stt.streams.get(source)?.emitter.emit({
    type: 'final',
    text,
    startMs: 0,
    endMs: 100,
    confidence: 1,
    words: [],
  });
}

describe('the calendar, end to end', () => {
  let live: Harness | null = null;

  beforeEach(() => {
    vi.useFakeTimers({ now: START });
  });
  afterEach(async () => {
    await live?.runtime.stop();
    live = null;
    vi.useRealTimers();
  });

  function start(events: CalendarEvent[]): Harness {
    live = harness(events);
    return live;
  }

  it('turns a call into a prompt, one click into a linked note, and the link into the upload', async () => {
    const standup = call('standup', 5, { title: 'Weekly standup' });
    const h = start([standup]);
    await h.advanceTo(2);
    expect(h.runtime.prompts.getState().cards).toEqual([]);

    // Lead 1 min: the card is up from 08:04.
    await h.advanceTo(4.5);
    const [card] = h.runtime.prompts.getState().cards;
    expect(card).toMatchObject({ kind: 'calendar', shownBy: 'calendar' });
    if (card === undefined) throw new Error('no card');

    await h.runtime.prompts.act({ cardId: card.id, action: 'take_notes' });
    await h.windowStarted();
    expect(h.capture.getStatus().phase).toBe('recording');

    const meetingId = h.capture.getStatus().meetingId;
    if (meetingId === null) throw new Error('capture is not recording');
    expect(h.store.getMeeting(meetingId)).toMatchObject({
      title: 'Weekly standup',
      startSource: 'notification',
      calendarEvent: { eventId: 'standup', provider: 'fake' },
    });
    // The page opens the note the click started.
    expect(h.routes).toEqual([`meeting/${meetingId}`]);

    say(h, 'system', 'Morning everyone');
    await h.capture.stop();
    expect(h.createMeeting).toHaveBeenCalledTimes(1);
    expect(h.createMeeting.mock.calls[0]?.[0]).toMatchObject({
      id: meetingId,
      title: 'Weekly standup',
      startSource: 'notification',
      calendarEvent: {
        eventId: 'standup',
        scheduledStart: iso(START + 5 * MINUTE),
        attendees: [
          { email: 'jane@linkt.ai', isSelf: false },
          { email: ACCOUNT, isSelf: true },
        ],
      },
    });

    // Home's "Open note" asks main which events already have a note.
    expect(await h.findMeetings(['standup', 'other'])).toEqual([{ eventId: 'standup', meetingId }]);
  });

  it('links a manual start to the one call that is running, and takes its title and attendees', async () => {
    const h = start([call('design-review', 0, { title: 'Design review' })]);
    await h.advanceTo(2);

    await h.capture.start({ source: 'tray' });

    const meetingId = h.capture.getStatus().meetingId;
    if (meetingId === null) throw new Error('capture is not recording');
    expect(h.store.getMeeting(meetingId)).toMatchObject({
      title: 'Design review',
      startSource: 'tray',
      calendarEvent: { eventId: 'design-review' },
    });
  });

  it('links nothing when two calls overlap or none is near, rather than the wrong one', async () => {
    const h = start([call('a', 0), call('b', 5)]);
    await h.advanceTo(6);
    await h.capture.start({ source: 'manual' });
    const first = h.capture.getStatus().meetingId;
    if (first === null) throw new Error('capture is not recording');
    expect(h.store.getMeeting(first)?.calendarEvent).toBeNull();
    await h.capture.stop();

    // Hours from the next call: nothing to link either.
    h.setEvents([call('later', 180)]);
    await h.advanceTo(10);
    await h.capture.start({ source: 'manual' });
    const second = h.capture.getStatus().meetingId;
    if (second === null) throw new Error('capture is not recording');
    expect(h.store.getMeeting(second)?.calendarEvent).toBeNull();
  });

  it("keeps the event a start request names, never the enricher's guess", async () => {
    // `running` is the one clear match for a bare start; the request names another call.
    const asked = call('asked', 120, { title: 'Asked for' });
    const running = call('running', 0, { title: 'Also running' });
    const h = start([asked, running]);
    await h.advanceTo(2);
    const request: StartCaptureRequest = {
      source: 'notification',
      title: asked.title,
      calendarEvent: {
        provider: 'fake',
        eventId: asked.id,
        icalUid: asked.icalUid,
        recurringEventId: null,
        scheduledStart: asked.start,
        scheduledEnd: asked.end,
        attendees: asked.attendees,
      },
    };
    await h.capture.start(request);
    const meetingId = h.capture.getStatus().meetingId;
    if (meetingId === null) throw new Error('capture is not recording');
    expect(h.store.getMeeting(meetingId)).toMatchObject({
      title: 'Asked for',
      calendarEvent: { eventId: 'asked' },
    });
  });
});
