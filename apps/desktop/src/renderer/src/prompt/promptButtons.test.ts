import { describe, expect, it } from 'vitest';
import { callDetectedButtons, eventButtons, footerButtons, openRogerButton } from './promptButtons';
import { callDetectedCard, calendarCard, calendarEvent } from './promptTesting';

const labels = (buttons: { label: string }[]): string[] => buttons.map((button) => button.label);

describe('eventButtons', () => {
  const event = calendarEvent({ id: 'event-9' });
  const card = calendarCard([event]);

  it('sends the event id with every start, so a card holding two calls starts the right one', () => {
    expect(eventButtons(card, event).map((button) => button.request)).toEqual([
      { cardId: 'prompt-1', action: 'join_and_take_notes', eventId: 'event-9' },
      { cardId: 'prompt-1', action: 'take_notes', eventId: 'event-9' },
    ]);
  });

  it('makes Join the one primary when there is a link, and Start notes a ghost beside it', () => {
    expect(eventButtons(card, event).map(({ label, variant }) => [label, variant])).toEqual([
      ['Join and start notes', 'primary'],
      ['Start notes', 'ghost'],
    ]);
  });

  it('makes Start notes the one primary when there is no link', () => {
    const noLink = calendarEvent({ videoLink: null });
    expect(
      eventButtons(calendarCard([noLink]), noLink).map(({ label, variant }) => [label, variant]),
    ).toEqual([['Start notes', 'primary']]);
  });

  it('offers Join only for a link main would open (parseJoinLink)', () => {
    for (const videoLink of [
      null,
      'https://evil.example/j/1',
      'http://meet.google.com/abc-defg-hij',
    ]) {
      const bad = calendarEvent({ videoLink });
      expect(labels(eventButtons(calendarCard([bad]), bad))).toEqual(['Start notes']);
    }
  });
});

describe('a start that does not lead the panel', () => {
  const event = calendarEvent();
  const card = calendarCard([event]);

  it('is secondary, never a second accent fill (one primary per view)', () => {
    expect(eventButtons(card, event, false).map(({ variant }) => variant)).toEqual([
      'secondary',
      'ghost',
    ]);
    const noLink = calendarEvent({ videoLink: null });
    expect(
      eventButtons(calendarCard([noLink]), noLink, false).map(({ variant }) => variant),
    ).toEqual(['secondary']);
    expect(callDetectedButtons(callDetectedCard(), false).map(({ variant }) => variant)).toEqual([
      'secondary',
    ]);
  });
});

describe('callDetectedButtons', () => {
  it('starts a note with no event id, as the one primary', () => {
    expect(callDetectedButtons(callDetectedCard())).toEqual([
      {
        label: 'Start notes',
        variant: 'primary',
        request: { cardId: 'prompt-2', action: 'take_notes' },
      },
    ]);
  });
});

describe('footerButtons', () => {
  it('is Dismiss, a ghost, on every card: there is no Copy notice any more', () => {
    for (const card of [calendarCard(), callDetectedCard()]) {
      expect(footerButtons(card)).toEqual([
        { label: 'Dismiss', variant: 'ghost', request: { cardId: card.id, action: 'dismiss' } },
      ]);
    }
  });
});

describe('openRogerButton', () => {
  it('asks main to bring Roger forward, the one action that may', () => {
    expect(openRogerButton(callDetectedCard({ phase: 'taking_notes' }))).toEqual({
      label: 'Open Roger',
      variant: 'ghost',
      request: { cardId: 'prompt-2', action: 'open_roger' },
    });
  });
});
