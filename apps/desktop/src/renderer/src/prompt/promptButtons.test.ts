import { describe, expect, it } from 'vitest';
import { callDetectedButtons, eventButtons, footerButtons, openRogerButton } from './promptButtons';
import {
  callDetectedCard,
  calendarCard,
  calendarEvent,
  panelState,
  staleCard,
} from './promptTesting';

const labels = (buttons: { label: string }[]): string[] => buttons.map((button) => button.label);

describe('eventButtons', () => {
  const event = calendarEvent({ id: 'event-9' });
  const card = calendarCard([event]);

  it('sends the event id with every start, so a card holding two calls starts the right one', () => {
    expect(eventButtons(card, event, false).map((button) => button.request)).toEqual([
      { cardId: 'prompt-1', action: 'join_and_take_notes', eventId: 'event-9' },
      { cardId: 'prompt-1', action: 'take_notes', eventId: 'event-9' },
    ]);
  });

  it('makes Join the primary button when there is a link, else Take notes', () => {
    expect(eventButtons(card, event, false).map((button) => button.tone)).toEqual([
      'primary',
      'secondary',
    ]);
    const noLink = calendarEvent({ videoLink: null });
    expect(
      eventButtons(calendarCard([noLink]), noLink, false).map((button) => button.tone),
    ).toEqual(['primary']);
  });

  it('offers Join only for a link main would open (parseJoinLink)', () => {
    for (const videoLink of [
      null,
      'https://evil.example/j/1',
      'http://meet.google.com/abc-defg-hij',
    ]) {
      const bad = calendarEvent({ videoLink });
      expect(labels(eventButtons(calendarCard([bad]), bad, false))).toEqual(['Take notes']);
    }
  });

  it('words the starts for a recording in progress', () => {
    expect(labels(eventButtons(card, event, true))).toEqual([
      'Stop current note and join',
      'Stop current note and start',
    ]);
  });
});

describe('callDetectedButtons', () => {
  it('starts a note with no event id', () => {
    expect(callDetectedButtons(callDetectedCard(), false)).toEqual([
      {
        label: 'Take notes',
        tone: 'primary',
        request: { cardId: 'prompt-2', action: 'take_notes' },
      },
    ]);
    expect(labels(callDetectedButtons(callDetectedCard(), true))).toEqual([
      'Stop current note and start',
    ]);
  });
});

describe('footerButtons', () => {
  it('has Copy notice on a calendar card while the notice is on, and always Dismiss', () => {
    const on = footerButtons(calendarCard(), panelState([], { noticeEnabled: true }));
    expect(on.map((button) => button.request)).toEqual([
      { cardId: 'prompt-1', action: 'copy_notice' },
      { cardId: 'prompt-1', action: 'dismiss' },
    ]);
    expect(labels(footerButtons(calendarCard(), panelState([], { noticeEnabled: false })))).toEqual(
      ['Dismiss'],
    );
  });

  it('has only Dismiss on a call-detected card and the stale card', () => {
    const state = panelState([], { noticeEnabled: true });
    expect(labels(footerButtons(callDetectedCard(), state))).toEqual(['Dismiss']);
    expect(footerButtons(staleCard(), state).map((button) => button.request)).toEqual([
      { cardId: 'prompt-3', action: 'dismiss' },
    ]);
  });
});

describe('openRogerButton', () => {
  it('asks main to bring Roger forward, the one action that may', () => {
    expect(openRogerButton(callDetectedCard({ phase: 'taking_notes' })).request).toEqual({
      cardId: 'prompt-2',
      action: 'open_roger',
    });
  });
});
