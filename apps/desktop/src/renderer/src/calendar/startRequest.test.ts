import { describe, expect, it } from 'vitest';
import { MAX_MEETING_TITLE_LENGTH } from '../../../shared/capture';
import { toMeetingCalendarEvent, type TimedCalendarEvent } from '../../../shared/calendar';
import { startRequestForEvent } from './startRequest';

function event(fields: Partial<TimedCalendarEvent> = {}): TimedCalendarEvent {
  return {
    provider: 'google',
    id: 'evt-1',
    icalUid: 'evt-1@google.com',
    recurringEventId: null,
    title: 'Weekly sync',
    status: 'confirmed',
    selfResponse: 'accepted',
    attendees: [],
    attendeesOmitted: false,
    videoLink: null,
    videoLinkSource: null,
    htmlLink: null,
    allDay: false,
    start: '2026-10-06T09:00:00+05:30',
    end: '2026-10-06T09:30:00+05:30',
    startDate: null,
    endDate: null,
    ...fields,
  };
}

describe('startRequestForEvent', () => {
  it('starts from Home with the invite title and the event the note is for', () => {
    const request = startRequestForEvent(event());
    expect(request).toEqual({
      source: 'home',
      title: 'Weekly sync',
      calendarEvent: toMeetingCalendarEvent(event()),
    });
    // The event's offsets are written as UTC instants, as the API stores them.
    expect(request.calendarEvent?.scheduledStart).toBe('2026-10-06T03:30:00.000Z');
  });

  it('cuts a pasted agenda to the longest title the window may send, never mid-character', () => {
    // 600 emoji: a cut by UTF-16 units would split one in half.
    const request = startRequestForEvent(event({ title: '😀'.repeat(600) }));
    expect(Array.from(request.title ?? '')).toHaveLength(MAX_MEETING_TITLE_LENGTH);
    expect(request.title).toBe('😀'.repeat(MAX_MEETING_TITLE_LENGTH));
  });

  it('leaves the title out when the invite has none, so main names the meeting after its start', () => {
    for (const title of ['', '   ', '\u001c\u001d']) {
      expect('title' in startRequestForEvent(event({ title }))).toBe(false);
    }
  });
});
