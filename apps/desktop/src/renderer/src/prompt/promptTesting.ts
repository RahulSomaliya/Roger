import type {
  CalendarAttendee,
  CalendarPromptCard,
  CallDetectedPromptCard,
  TimedCalendarEvent,
} from '../../../shared/calendar';
import type { PromptPanelState } from '../../../shared/ipc/prompt';

/**
 * Fixtures for the panel's tests and for T13's QA preview. Not imported by the page itself.
 * Times are fixed instants: the cards say how far off they are from `PANEL_NOW`.
 */

/** "Now" for these fixtures; a card starting at `EVENT_START` reads "Starting in 1 min". */
export const PANEL_NOW = Date.parse('2026-10-07T09:59:00.000Z');
export const EVENT_START = '2026-10-07T10:00:00.000Z';
const EVENT_END = '2026-10-07T10:30:00.000Z';

export const attendee = (name: string, isSelf = false): CalendarAttendee => ({
  email: `${name.toLowerCase()}@example.com`,
  displayName: name,
  responseStatus: 'accepted',
  isSelf,
  isOrganizer: false,
});

export function calendarEvent(overrides: Partial<TimedCalendarEvent> = {}): TimedCalendarEvent {
  return {
    provider: 'fake',
    id: 'event-1',
    icalUid: null,
    recurringEventId: null,
    title: 'Northwind renewal',
    status: 'confirmed',
    selfResponse: 'accepted',
    attendees: [attendee('Rahul', true), attendee('Jane'), attendee('Ali')],
    attendeesOmitted: false,
    videoLink: 'https://meet.google.com/abc-defg-hij',
    videoLinkSource: 'location',
    htmlLink: null,
    allDay: false,
    start: EVENT_START,
    end: EVENT_END,
    startDate: null,
    endDate: null,
    ...overrides,
  };
}

export function calendarCard(
  events: [TimedCalendarEvent, ...TimedCalendarEvent[]] = [calendarEvent()],
  overrides: Partial<CalendarPromptCard> = {},
): CalendarPromptCard {
  return {
    kind: 'calendar',
    id: 'prompt-1',
    phase: 'open',
    error: null,
    events,
    shownBy: 'calendar',
    startedEventId: null,
    ...overrides,
  };
}

export function callDetectedCard(
  overrides: Partial<CallDetectedPromptCard> = {},
): CallDetectedPromptCard {
  return {
    kind: 'call_detected',
    id: 'prompt-2',
    phase: 'open',
    error: null,
    app: { bundleId: 'us.zoom.xos', name: 'Zoom' },
    ...overrides,
  };
}

export function panelState(
  cards: PromptPanelState['cards'],
  overrides: Partial<PromptPanelState> = {},
): PromptPanelState {
  return { cards, recording: false, recordingTitle: null, ...overrides };
}
