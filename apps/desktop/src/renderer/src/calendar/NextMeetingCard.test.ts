import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { at, NOW_MS, plain, timedEvent } from './calendarTesting';
import { NextMeetingCard } from './NextMeetingCard';
import { todayGroups, type TimedEntry } from './todayGroups';

function entryFor(event: ReturnType<typeof timedEvent>, nowMs = NOW_MS): TimedEntry {
  const entry = todayGroups({ events: [event], links: new Map(), nowMs }).timed[0];
  if (entry === undefined) throw new Error('the event is not on the test day');
  return entry;
}

function card(entry: TimedEntry, nowMs = NOW_MS): string {
  return plain(renderToStaticMarkup(createElement(NextMeetingCard, { entry, nowMs })));
}

describe('NextMeetingCard (the meeting Home’s Start notes is for)', () => {
  it('says "Now" with how long ago a meeting under way started, and its hours on a 12 hour clock', () => {
    const html = card(
      entryFor(timedEvent('a', at(10, 45), at(11, 30), { title: 'Design review' })),
    );
    expect(html).toContain('Now · Started 15 min ago');
    expect(html).toContain('<h1 class="home-hero-title">Design review</h1>');
    expect(html).toContain('10:45 am to 11:30 am');
  });

  it('counts down to a meeting about to start', () => {
    const html = card(entryFor(timedEvent('a', at(11, 8), at(12), { title: 'Sync' })));
    expect(html).toContain('Next · Starting in 8 min');
    expect(html).toContain('11:08 am to 12:00 pm');
  });

  it('names an untitled invite as its meeting will be named, and lists no guests: the hero is a title and hours', () => {
    const html = card(entryFor(timedEvent('a', at(11, 5), at(12), { title: '  ' })));
    expect(html).toMatch(/Meeting at \d{1,2}:\d{2} (am|pm)/);
    expect(html).not.toContain('Untitled');
    expect(html).not.toContain('<button');
  });
});
