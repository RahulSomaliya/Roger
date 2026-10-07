import { createElement, isValidElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { at, attendee, NOW_MS, plain, timedEvent } from './calendarTesting';
import { MeetingAction, NextMeetingCard, type TimedEntry } from './NextMeetingCard';
import { todayGroups } from './todayGroups';

function entryFor(
  event: ReturnType<typeof timedEvent>,
  links: ReadonlyMap<string, string> = new Map(),
  nowMs = NOW_MS,
): TimedEntry {
  const entry = todayGroups({ events: [event], links, nowMs }).timed[0];
  if (entry === undefined) throw new Error('the event is not on the test day');
  return entry;
}

const actions = () => ({ startBlocked: false, onStart: vi.fn(), onOpen: vi.fn() });

function card(entry: TimedEntry, nowMs = NOW_MS): string {
  return plain(
    renderToStaticMarkup(createElement(NextMeetingCard, { entry, nowMs, ...actions() })),
  );
}

describe('NextMeetingCard', () => {
  it('says "Now" with how long ago a meeting under way started', () => {
    const html = card(
      entryFor(timedEvent('a', at(10, 45), at(11, 30), { title: 'Design review' })),
    );
    expect(html).toContain('Now · Started 15 min ago');
    expect(html).toContain('Design review');
  });

  it('counts down to a meeting within the hour', () => {
    const html = card(entryFor(timedEvent('a', at(11, 20), at(12), { title: 'Sync' })));
    expect(html).toContain('Next · Starting in 20 min');
  });

  it('only says "Next" for a meeting further off than an hour: "in 190 min" helps nobody', () => {
    const html = card(entryFor(timedEvent('a', at(14, 10), at(15))));
    expect(html).toContain('>Next</p>');
    expect(html).not.toContain('Starting in');
  });

  it('names who else is on the call, and an untitled invite as such', () => {
    const html = card(
      entryFor(
        timedEvent('a', at(11, 20), at(12), {
          title: '  ',
          attendees: [
            attendee('You', { isSelf: true }),
            attendee('Jane Doe'),
            attendee('Ali Khan'),
          ],
        }),
      ),
    );
    expect(html).toContain('Untitled meeting');
    expect(html).toContain('Jane and Ali');
  });
});

describe('MeetingAction', () => {
  const event = timedEvent('a', at(11, 10), at(11, 40), { title: 'Soon' });

  function button(entry: TimedEntry, fields: Partial<ReturnType<typeof actions>> = {}) {
    const handlers = { ...actions(), ...fields };
    const element = MeetingAction({ entry, ...handlers });
    return { element, handlers };
  }

  function onClickOf(element: ReactElement | null): () => void {
    if (!isValidElement<{ onClick: () => void }>(element)) throw new Error('no button rendered');
    return element.props.onClick;
  }

  it('starts notes for the event itself when pressed', () => {
    const { element, handlers } = button(entryFor(event));
    onClickOf(element)();
    expect(handlers.onStart).toHaveBeenCalledWith(event);
    expect(handlers.onOpen).not.toHaveBeenCalled();
  });

  it('opens the meeting that has the event when pressed, and never offers a second Start for it', () => {
    const { element, handlers } = button(entryFor(event, new Map([['a', 'meeting-3']])));
    onClickOf(element)();
    expect(handlers.onOpen).toHaveBeenCalledWith('meeting-3');
    expect(handlers.onStart).not.toHaveBeenCalled();
  });

  it('shows no button before the Start notes window when there is no note', () => {
    const tenOClock = new Date(2026, 9, 6, 10).getTime(); // an hour before the 11:10 start
    expect(button(entryFor(event, new Map(), tenOClock), {}).element).toBeNull();
  });
});
