import { afterEach, describe, expect, it } from 'vitest';
import { meetingsChannels } from '../../shared/ipc/meetings';
import {
  MAX_MEETINGS_LIST_LIMIT,
  type MeetingSummary,
  type StoredMeeting,
} from '../../shared/meetings';
import type { TranscriptSegment } from '../../shared/transcript';
import type { IpcMainLike, SenderEvent, TrustedWindow } from '../ipc/trust';
import { createLogger } from '../logger';
import { SqliteTranscriptStore } from '../store/SqliteTranscriptStore';
import { registerMeetingsIpc } from './meetings-ipc';

const MAIN_PAGE = 7;
const PROMPT_PANEL = 9;

const MEETING = '0b6f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4';
const OTHER_MEETING = '1c7a2d3f-4e5b-4c6d-9e7f-8091a2b3c4d5';
const NOT_ON_THIS_MAC = '2d8b3e4a-5f6c-4d7e-8f90-91a2b3c4d5e6';

type Handler = (event: SenderEvent, payload: unknown) => unknown;

const stores: SqliteTranscriptStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

/** A lowercase UUID whose last group is `n`, so ids sort as their numbers do. */
function meetingId(n: number): string {
  return `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
}

function line(n: number, overrides: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    id: `seg-${n}`,
    meetingId: MEETING,
    source: 'mic',
    speaker: 'me',
    startMs: n * 1000,
    endMs: n * 1000 + 800,
    text: `line ${n}`,
    confidence: 0.9,
    words: null,
    createdAt: '2026-10-06T09:00:10.000Z',
    ...overrides,
  };
}

function harness() {
  const handlers = new Map<string, Handler>();
  const ipcMain: IpcMainLike = {
    handle: (channel, listener) => {
      handlers.set(channel, listener);
    },
    on: () => undefined,
  };
  const lines: string[] = [];
  const logger = createLogger({ level: 'debug', format: 'json', sink: (l) => lines.push(l) });
  const store = new SqliteTranscriptStore(':memory:');
  stores.push(store);
  const window: TrustedWindow = { webContents: { id: MAIN_PAGE } };
  registerMeetingsIpc({ ipcMain, store, getWindow: () => window, logger });

  /** Like ipcRenderer.invoke: a handler that throws rejects the page's promise. */
  const invoke = (channel: string, senderId: number, payload?: unknown): Promise<unknown> =>
    Promise.resolve().then(() => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`nothing registered on ${channel}`);
      return handler({ sender: { id: senderId } }, payload);
    });

  return {
    store,
    invoke,
    logged: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
    rawLog: () => lines.join('\n'),
  };
}

describe('the meetings IPC', () => {
  it('lists recent meetings newest first with a capped limit', async () => {
    const h = harness();
    // One more than a list may answer, created oldest first: meeting n starts n minutes in.
    for (let n = 0; n <= MAX_MEETINGS_LIST_LIMIT; n += 1) {
      const startedAt = new Date(Date.UTC(2026, 9, 6, 9, n)).toISOString();
      h.store.createMeeting({ id: meetingId(n), title: `Meeting ${n}`, startedAt });
    }
    h.store.markMeetingEnded(meetingId(99), '2026-10-06T10:45:00.000Z');
    h.store.setMeetingRemoteState(meetingId(99), 'ended');

    const two = await h.invoke(meetingsChannels.MeetingsList, MAIN_PAGE, { limit: 2 });
    // Summaries only: the upload state (remoteState) is main's business, never the page's.
    expect(two).toEqual<MeetingSummary[]>([
      {
        id: meetingId(100),
        title: 'Meeting 100',
        startedAt: '2026-10-06T10:40:00.000Z',
        endedAt: null,
      },
      {
        id: meetingId(99),
        title: 'Meeting 99',
        startedAt: '2026-10-06T10:39:00.000Z',
        endedAt: '2026-10-06T10:45:00.000Z',
      },
    ]);

    const capped = await h.invoke(meetingsChannels.MeetingsList, MAIN_PAGE, { limit: 1000 });
    expect(capped).toHaveLength(MAX_MEETINGS_LIST_LIMIT);
    expect((capped as MeetingSummary[]).map((m) => m.id)).toEqual(
      Array.from({ length: MAX_MEETINGS_LIST_LIMIT }, (_, i) =>
        meetingId(MAX_MEETINGS_LIST_LIMIT - i),
      ),
    );
    // Main logs no title: titles become calendar invite titles with M5.
    expect(h.rawLog()).not.toContain('Meeting 1');
  });

  it('refuses a list request whose limit is not a whole number from 1', async () => {
    const h = harness();
    h.store.createMeeting({ id: MEETING, title: 'T', startedAt: '2026-10-06T09:00:00.000Z' });
    for (const payload of [undefined, null, 30, { limit: 0 }, { limit: 2.5 }, { limit: '30' }]) {
      await expect(h.invoke(meetingsChannels.MeetingsList, MAIN_PAGE, payload)).rejects.toThrow(
        'meetings:list takes { limit: a whole number from 1 }',
      );
    }
    expect(h.logged()).toMatchObject(
      Array.from({ length: 6 }, () => ({
        level: 'warn',
        message: 'meetings read refused',
        channel: 'meetings:list',
      })),
    );
  });

  it('returns a meeting with its stored lines in order', async () => {
    const h = harness();
    h.store.createMeeting({
      id: MEETING,
      title: 'Pricing call',
      startedAt: '2026-10-06T09:00:00.000Z',
    });
    h.store.createMeeting({ id: OTHER_MEETING, title: 'T', startedAt: '2026-10-06T08:00:00.000Z' });
    // Stored out of order, as two streams write them; one line repeats call audio and is hidden.
    h.store.appendSegment(line(3));
    h.store.appendSegment(line(1, { id: 'sys-1', source: 'system', speaker: 'them' }));
    h.store.appendSegment(line(1));
    h.store.appendSegment(line(2, { id: 'echo-2' }));
    h.store.appendSegment(line(2, { id: 'sys-2', source: 'system', speaker: 'them' }));
    h.store.appendSegment(line(4, { meetingId: OTHER_MEETING }));
    expect(h.store.suppressSegment('echo-2', 'echo', 'sys-2')).toBe(true);
    h.store.markMeetingEnded(MEETING, '2026-10-06T09:30:00.000Z');

    await expect(
      h.invoke(meetingsChannels.MeetingsGet, MAIN_PAGE, { meetingId: MEETING }),
    ).resolves.toEqual({
      id: MEETING,
      title: 'Pricing call',
      startedAt: '2026-10-06T09:00:00.000Z',
      endedAt: '2026-10-06T09:30:00.000Z',
      attendees: [],
      segments: [
        line(1),
        line(1, { id: 'sys-1', source: 'system', speaker: 'them' }),
        line(2, { id: 'sys-2', source: 'system', speaker: 'them' }),
        line(3),
      ],
    });
    // Main logs neither the title nor a line: they are what people named and said.
    expect(h.rawLog()).not.toContain('Pricing call');
    expect(h.rawLog()).not.toContain('line ');
  });

  it('gives the page the invitees of the linked event, the address and who is the user only', async () => {
    const h = harness();
    h.store.createMeeting({
      id: MEETING,
      title: 'Northwind sync',
      startedAt: '2026-10-06T09:00:00.000Z',
      calendarEvent: {
        provider: 'fake',
        eventId: 'evt-1',
        icalUid: null,
        recurringEventId: null,
        scheduledStart: '2026-10-06T09:00:00.000Z',
        scheduledEnd: '2026-10-06T09:30:00.000Z',
        attendees: [
          {
            email: 'me@linkt.ai',
            displayName: 'Me Myself',
            responseStatus: 'accepted',
            isSelf: true,
            isOrganizer: true,
          },
          {
            email: 'sam@northwind.com',
            displayName: 'Sam Guest',
            responseStatus: 'needs_action',
            isSelf: false,
            isOrganizer: false,
          },
        ],
      },
    });
    const meeting = (await h.invoke(meetingsChannels.MeetingsGet, MAIN_PAGE, {
      meetingId: MEETING,
    })) as StoredMeeting;
    // Names and answers stay in main: the page asks for the template cue and nothing else.
    expect(meeting.attendees).toEqual([
      { email: 'me@linkt.ai', isSelf: true },
      { email: 'sam@northwind.com', isSelf: false },
    ]);
  });

  it('answers null for a meeting this Mac does not hold, or deleted at Stop', async () => {
    const h = harness();
    await expect(
      h.invoke(meetingsChannels.MeetingsGet, MAIN_PAGE, { meetingId: NOT_ON_THIS_MAC }),
    ).resolves.toBeNull();
    // Stop deletes a meeting in which nobody spoke (CaptureService, deleteMeetingIfEmpty).
    h.store.createMeeting({ id: MEETING, title: 'T', startedAt: '2026-10-06T09:00:00.000Z' });
    expect(h.store.deleteMeetingIfEmpty(MEETING)).toBe(true);
    await expect(
      h.invoke(meetingsChannels.MeetingsGet, MAIN_PAGE, { meetingId: MEETING }),
    ).resolves.toBeNull();
  });

  it('refuses bad ids', async () => {
    const h = harness();
    h.store.createMeeting({ id: MEETING, title: 'T', startedAt: '2026-10-06T09:00:00.000Z' });
    const bad = [
      undefined,
      MEETING, // the id itself, not { meetingId }
      { meetingId: MEETING.toUpperCase() }, // another spelling of a stored meeting
      { meetingId: ` ${MEETING}` },
      { meetingId: `../${MEETING}` },
      { meetingId: 'meeting/1' },
      { meetingId: 42 },
      { id: MEETING },
    ];
    for (const payload of bad) {
      await expect(h.invoke(meetingsChannels.MeetingsGet, MAIN_PAGE, payload)).rejects.toThrow(
        'meetings:get takes { meetingId: a lowercase meeting id }',
      );
    }
    // Logged without the payload: it is whatever the page sent.
    expect(h.logged()).toMatchObject(
      Array.from({ length: bad.length }, () => ({
        level: 'warn',
        message: 'meetings read refused',
        channel: 'meetings:get',
      })),
    );
    expect(h.rawLog()).not.toContain(MEETING);
  });

  it('answers only the main window, never the prompt panel', async () => {
    const h = harness();
    h.store.createMeeting({ id: MEETING, title: 'T', startedAt: '2026-10-06T09:00:00.000Z' });
    await expect(
      h.invoke(meetingsChannels.MeetingsList, PROMPT_PANEL, { limit: 30 }),
    ).rejects.toThrow('untrusted sender');
    await expect(
      h.invoke(meetingsChannels.MeetingsGet, PROMPT_PANEL, { meetingId: MEETING }),
    ).rejects.toThrow('untrusted sender');
  });

  it('rejects with the store failure and logs which read failed, never what it held', async () => {
    const h = harness();
    h.store.createMeeting({ id: MEETING, title: 'T', startedAt: '2026-10-06T09:00:00.000Z' });
    // A read after the quit hook closed the store, as a late page read meets it.
    h.store.close();
    stores.splice(0);

    await expect(
      h.invoke(meetingsChannels.MeetingsGet, MAIN_PAGE, { meetingId: MEETING }),
    ).rejects.toThrow('statement has been finalized');
    await expect(h.invoke(meetingsChannels.MeetingsList, MAIN_PAGE, { limit: 30 })).rejects.toThrow(
      'statement has been finalized',
    );
    expect(h.logged()).toMatchObject([
      {
        level: 'warn',
        message: 'meetings read failed',
        channel: 'meetings:get',
        meetingId: MEETING,
        error: 'statement has been finalized',
      },
      {
        level: 'warn',
        message: 'meetings read failed',
        channel: 'meetings:list',
        error: 'statement has been finalized',
      },
    ]);
  });
});
