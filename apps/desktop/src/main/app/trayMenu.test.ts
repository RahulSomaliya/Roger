import { describe, expect, it } from 'vitest';
import type {
  AllDayCalendarEvent,
  CalendarConnection,
  CalendarSyncState,
  TimedCalendarEvent,
} from '../../shared/calendar';
import {
  buildTrayModel,
  createTrayFormat,
  type TrayInputs,
  type TrayMenuEntry,
  type TrayModel,
} from './trayMenu';

// Asia/Kolkata (UTC+5:30, no DST) and America/Los_Angeles: the same instants read differently.
const format = createTrayFormat('Asia/Kolkata');
const NOW = Date.parse('2026-10-06T09:00:00.000Z'); // 14:30 in Kolkata

const connection: CalendarConnection = {
  provider: 'google',
  accountEmail: 'you@example.com',
  status: 'active',
  connectedAt: '2026-10-06T03:00:00.000Z',
  expiresHint: null,
  lastError: null,
};
const freshSync: CalendarSyncState = {
  lastSuccessAt: '2026-10-06T08:55:00.000Z',
  lastError: null,
  staleSince: null,
  reconnectRequired: false,
};

function event(
  id: string,
  title: string,
  start: string,
  end: string,
  fields: Partial<TimedCalendarEvent> = {},
): TimedCalendarEvent {
  return {
    provider: 'google',
    id,
    icalUid: null,
    recurringEventId: null,
    title,
    status: 'confirmed',
    allDay: false,
    start,
    end,
    startDate: null,
    endDate: null,
    selfResponse: 'accepted',
    attendees: [],
    attendeesOmitted: false,
    videoLink: null,
    videoLinkSource: null,
    htmlLink: null,
    ...fields,
  };
}

function inputs(changes: Partial<TrayInputs> = {}): TrayInputs {
  return {
    recording: false,
    nowMs: NOW,
    events: [],
    connection,
    sync: freshSync,
    format,
    ...changes,
  };
}

const texts = (model: TrayModel): string[] =>
  model.entries.flatMap((entry: TrayMenuEntry) => (entry.kind === 'separator' ? [] : [entry.text]));
const actions = (model: TrayModel): string[] =>
  model.entries.flatMap((entry) => (entry.kind === 'action' ? [entry.action] : []));

describe('the menu bar menu', () => {
  it('always offers Open Roger and Quit Roger, last, with Quit after a separator', () => {
    for (const model of [
      buildTrayModel(inputs()),
      buildTrayModel(inputs({ connection: null, sync: null })),
      buildTrayModel(inputs({ recording: true })),
    ]) {
      expect(texts(model).slice(-2)).toEqual(['Open Roger', 'Quit Roger']);
      expect(model.entries.at(-2)).toEqual({ kind: 'separator' });
    }
  });

  it('offers Start notes now while idle and Stop note while recording, never both', () => {
    const idle = buildTrayModel(inputs());
    expect(texts(idle)).toContain('Start notes now');
    expect(texts(idle)).not.toContain('Stop note');
    expect(actions(idle)).toContain('start');

    const recording = buildTrayModel(inputs({ recording: true }));
    expect(texts(recording)).toContain('Stop note');
    expect(texts(recording)).not.toContain('Start notes now');
    expect(actions(recording)).toContain('stop');
  });

  it('says the next meeting and when it starts', () => {
    const model = buildTrayModel(
      inputs({
        events: [
          event('a', 'Acme renewal', '2026-10-06T10:00:00.000Z', '2026-10-06T10:30:00.000Z'),
        ],
      }),
    );
    expect(texts(model)[0]).toBe('Next: Acme renewal, 15:30');
  });

  it('names the day when the next meeting is not today', () => {
    const model = buildTrayModel(
      inputs({
        events: [event('a', 'Standup', '2026-10-07T04:00:00.000Z', '2026-10-07T04:15:00.000Z')],
      }),
    );
    expect(texts(model)[0]).toBe('Next: Standup, Wed 09:30');
  });

  it('puts a meeting that has started first, until it ends', () => {
    const running = event(
      'a',
      'Design review',
      '2026-10-06T08:30:00.000Z',
      '2026-10-06T09:30:00.000Z',
    );
    const later = event('b', 'Standup', '2026-10-06T10:00:00.000Z', '2026-10-06T10:15:00.000Z');
    expect(texts(buildTrayModel(inputs({ events: [later, running] })))[0]).toBe(
      'Now: Design review',
    );
    expect(
      texts(
        buildTrayModel(
          inputs({ events: [running, later], nowMs: Date.parse('2026-10-06T09:45:00.000Z') }),
        ),
      )[0],
    ).toBe('Next: Standup, 15:30');
  });

  it('skips declined meetings, all-day items and meetings that ended', () => {
    const declined = event(
      'a',
      'Declined',
      '2026-10-06T09:30:00.000Z',
      '2026-10-06T10:00:00.000Z',
      { selfResponse: 'declined' },
    );
    const over = event('b', 'Over', '2026-10-06T07:00:00.000Z', '2026-10-06T08:00:00.000Z');
    const allDay: AllDayCalendarEvent = {
      ...event('c', 'Holiday', '2026-10-06T00:00:00.000Z', '2026-10-07T00:00:00.000Z'),
      allDay: true,
      start: null,
      end: null,
      startDate: '2026-10-06',
      endDate: '2026-10-07',
    };
    const model = buildTrayModel(inputs({ events: [over, allDay, declined] }));
    expect(texts(model)[0]).toBe('No upcoming meetings');
  });

  it('says nothing of meetings when no calendar is connected', () => {
    const model = buildTrayModel(inputs({ connection: null, sync: null }));
    expect(texts(model)).toEqual(['Start notes now', 'Open Roger', 'Quit Roger']);
  });

  it('shortens a long title, and names an untitled one', () => {
    const long = 'Quarterly planning with every team lead and the whole finance group';
    const model = buildTrayModel(
      inputs({
        events: [event('a', long, '2026-10-06T10:00:00.000Z', '2026-10-06T11:00:00.000Z')],
      }),
    );
    expect(texts(model)[0]).toBe('Next: Quarterly planning with every team lead…, 15:30');
    const untitled = buildTrayModel(
      inputs({
        events: [event('a', '  ', '2026-10-06T10:00:00.000Z', '2026-10-06T11:00:00.000Z')],
      }),
    );
    expect(texts(untitled)[0]).toBe('Next: Untitled meeting, 15:30');
  });

  it('never puts attendees into the menu', () => {
    const attendee = {
      email: 'jane@example.com',
      displayName: 'Jane Cooper',
      responseStatus: 'accepted' as const,
      isSelf: false,
      isOrganizer: true,
    };
    const model = buildTrayModel(
      inputs({
        events: [
          event('a', 'Sync', '2026-10-06T10:00:00.000Z', '2026-10-06T11:00:00.000Z', {
            attendees: [attendee],
          }),
        ],
      }),
    );
    expect(JSON.stringify(model)).not.toContain('Jane');
    expect(JSON.stringify(model)).not.toContain('jane@');
  });

  it('says when the calendar was last updated, once it is stale', () => {
    const stale: CalendarSyncState = {
      lastSuccessAt: '2026-10-06T03:42:00.000Z',
      lastError: 'offline',
      staleSince: '2026-10-06T04:42:00.000Z',
      reconnectRequired: false,
    };
    const model = buildTrayModel(inputs({ sync: stale }));
    expect(texts(model)).toContain('Calendar not updated since 09:12');
    expect(model.icon).toBe('warning');
  });

  it('says nothing of a calendar that is not connected, whatever health is left over', () => {
    const stale = { ...freshSync, staleSince: '2026-10-06T04:42:00.000Z', reconnectRequired: true };
    const model = buildTrayModel(inputs({ connection: null, sync: stale }));
    expect(texts(model)).toEqual(['Start notes now', 'Open Roger', 'Quit Roger']);
    expect(model.icon).toBe('idle');
  });

  it('says it without a time when the copy never updated', () => {
    const model = buildTrayModel(
      inputs({
        sync: { ...freshSync, lastSuccessAt: null, staleSince: '2026-10-06T04:42:00.000Z' },
      }),
    );
    expect(texts(model)).toContain('Calendar not updated');
  });

  it('offers Reconnect when Google refused the grant', () => {
    const refused = buildTrayModel(
      inputs({
        connection: { ...connection, status: 'reconnect_required' },
        sync: { ...freshSync, reconnectRequired: true },
      }),
    );
    expect(texts(refused)).toContain('Reconnect Google Calendar');
    expect(actions(refused)).toContain('reconnect');
    expect(refused.icon).toBe('warning');
  });

  it('offers Reconnect with its date from a day before the grant expires, and not before', () => {
    const expiresHint = '2026-10-14T03:00:00.000Z'; // Wed 14 Oct in Kolkata at 08:30
    const withHint = { ...connection, expiresHint };
    const early = buildTrayModel(
      inputs({ connection: withHint, nowMs: Date.parse('2026-10-13T02:59:00.000Z') }),
    );
    expect(texts(early).some((text) => text.startsWith('Reconnect'))).toBe(false);
    expect(early.icon).toBe('idle');

    const due = buildTrayModel(
      inputs({ connection: withHint, nowMs: Date.parse('2026-10-13T03:00:00.000Z') }),
    );
    expect(texts(due)).toContain('Reconnect Google Calendar (before Wed 14 Oct)');
    expect(due.icon).toBe('warning');
  });

  it('drops the date once it has passed: the grant is as good as refused', () => {
    const model = buildTrayModel(
      inputs({ connection: { ...connection, expiresHint: '2026-10-05T03:00:00.000Z' } }),
    );
    expect(texts(model)).toContain('Reconnect Google Calendar');
  });

  it('never asks for a reconnect when no expiry is known', () => {
    expect(
      texts(buildTrayModel(inputs({ connection: { ...connection, expiresHint: null } }))).some(
        (text) => text.startsWith('Reconnect'),
      ),
    ).toBe(false);
  });

  it('names a day in the zone the Mac is in, not in UTC', () => {
    const la = createTrayFormat('America/Los_Angeles');
    const model = buildTrayModel(
      inputs({
        format: la,
        // 16:30 UTC is 09:30 in Los Angeles in October, and still the 6th there.
        events: [event('a', 'Call', '2026-10-06T16:30:00.000Z', '2026-10-06T17:00:00.000Z')],
      }),
    );
    expect(texts(model)[0]).toBe('Next: Call, 09:30');
  });
});

describe('the menu bar icon', () => {
  const refused = { ...connection, status: 'reconnect_required' as const };

  it('is idle when all is well', () => {
    expect(buildTrayModel(inputs()).icon).toBe('idle');
  });

  it('is recording while a note is being taken', () => {
    expect(buildTrayModel(inputs({ recording: true })).icon).toBe('recording');
  });

  it('keeps showing the recording through a calendar warning: it is the one that must not be missed', () => {
    const model = buildTrayModel(inputs({ recording: true, connection: refused }));
    expect(model.icon).toBe('recording');
    // The warning is still in the menu.
    expect(texts(model)).toContain('Reconnect Google Calendar');
  });

  it('is warning when the calendar needs attention', () => {
    expect(buildTrayModel(inputs({ connection: refused })).icon).toBe('warning');
  });

  it('has a tooltip that says what the icon says', () => {
    expect(buildTrayModel(inputs()).tooltip).toBe('Roger');
    expect(buildTrayModel(inputs({ recording: true })).tooltip).toBe('Roger: taking notes');
    expect(buildTrayModel(inputs({ connection: refused })).tooltip).toBe(
      'Roger: calendar needs attention',
    );
  });
});
