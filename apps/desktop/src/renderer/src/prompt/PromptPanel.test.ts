import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PromptPanel, type PromptPanelProps } from './PromptPanel';
import {
  PANEL_NOW,
  attendee,
  callDetectedCard,
  calendarCard,
  calendarEvent,
  panelState,
  staleCard,
} from './promptTesting';

/** renderToString puts <!-- --> between adjacent text pieces: strip it before matching text. */
const text = (html: string): string =>
  html
    .replace(/<!-- -->/g, '')
    .replace(/<[^>]+>/g, '\n')
    .replace(/\n+/g, '\n')
    .trim();

const render = (props: Partial<PromptPanelProps>): string =>
  renderToStaticMarkup(
    createElement(PromptPanel, {
      state: null,
      error: null,
      nowMs: PANEL_NOW,
      failures: {},
      copiedCardId: null,
      onAct: () => undefined,
      ...props,
    }),
  );

const buttons = (html: string): string[] =>
  [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((match) => text(match[1] ?? ''));

describe('PromptPanel: a calendar card', () => {
  const html = render({ state: panelState([calendarCard()]) });

  it('shows when it starts, the title, the time range and who is on it', () => {
    const lines = text(html);
    expect(lines).toContain('Starting in 1 min');
    expect(lines).toContain('Northwind renewal');
    expect(lines).toMatch(/\d{1,2}:\d{2}.*–.*\d{1,2}:\d{2}/);
    expect(lines).toContain('Jane and Ali');
  });

  it('offers Join and take notes, Take notes, Copy notice and Dismiss, in that order', () => {
    expect(buttons(html)).toEqual(['Join and take notes', 'Take notes', 'Copy notice', 'Dismiss']);
  });

  it('leaves Join out of a call with no video link, and out of one whose link is not allowlisted', () => {
    for (const videoLink of [null, 'https://evil.example/join']) {
      const card = calendarCard([calendarEvent({ videoLink })]);
      expect(buttons(render({ state: panelState([card]) }))).toEqual([
        'Take notes',
        'Copy notice',
        'Dismiss',
      ]);
    }
  });

  it('offers no Copy notice while the notice is off', () => {
    const state = panelState([calendarCard()], { noticeEnabled: false });
    expect(buttons(render({ state }))).toEqual(['Join and take notes', 'Take notes', 'Dismiss']);
  });

  it('says "Stop current note and start" while a note is starting or recording', () => {
    const state = panelState([calendarCard()], { recording: true });
    expect(buttons(render({ state }))).toEqual([
      'Stop current note and join',
      'Stop current note and start',
      'Copy notice',
      'Dismiss',
    ]);
  });

  it('says "Copied" on the card whose notice was just copied', () => {
    expect(
      buttons(render({ state: panelState([calendarCard()]), copiedCardId: 'prompt-1' })),
    ).toContain('Copied');
  });

  it('calls a title-less invite "Untitled meeting" and shows a long title whole for CSS to clamp', () => {
    expect(
      text(render({ state: panelState([calendarCard([calendarEvent({ title: '' })])]) })),
    ).toContain('Untitled meeting');
    const long = 'Quarterly business review and roadmap alignment with every regional lead '
      .repeat(3)
      .trim();
    expect(
      text(render({ state: panelState([calendarCard([calendarEvent({ title: long })])]) })),
    ).toContain(long);
  });

  it('has no attendee line for a call with nobody else, and a short one for forty', () => {
    const solo = calendarEvent({ attendees: [attendee('Rahul', true)] });
    expect(render({ state: panelState([calendarCard([solo])]) })).not.toContain('prompt-attendees');
    const forty = calendarEvent({
      attendees: Array.from({ length: 40 }, (_, index) => attendee(`Guest${index}`)),
    });
    expect(text(render({ state: panelState([calendarCard([forty])]) }))).toContain(
      'Guest0, Guest1 and 38 others',
    );
  });

  it('gives two calls on one card a start action each and one Dismiss', () => {
    const second = calendarEvent({ id: 'event-2', title: 'Design crit', videoLink: null });
    const state = panelState([calendarCard([calendarEvent(), second])]);
    const html = render({ state });
    expect(buttons(html)).toEqual([
      'Join and take notes',
      'Take notes',
      'Take notes',
      'Copy notice',
      'Dismiss',
    ]);
    expect(text(html)).toContain('Design crit');
  });

  it('shows why a start failed, and keeps the buttons', () => {
    const state = panelState([
      calendarCard([calendarEvent()], { error: 'Roger could not reach the microphone' }),
    ]);
    const html = render({ state });
    expect(html).toContain('role="alert"');
    expect(text(html)).toContain('Roger could not reach the microphone');
    expect(buttons(html)).toContain('Take notes');
  });
});

describe('PromptPanel: taking notes', () => {
  it('replaces the buttons with "Taking notes · Open Roger"', () => {
    const state = panelState([calendarCard([calendarEvent()], { phase: 'taking_notes' })]);
    const html = render({ state });
    expect(text(html)).toContain('Taking notes');
    expect(buttons(html)).toEqual(['Open Roger']);
  });

  it('does the same for a call-detected card', () => {
    const state = panelState([callDetectedCard({ phase: 'taking_notes' })]);
    expect(buttons(render({ state }))).toEqual(['Open Roger']);
  });
});

describe('PromptPanel: a call-detected card', () => {
  it('says which app is using the mic, with Take notes and Dismiss', () => {
    const html = render({ state: panelState([callDetectedCard()]) });
    expect(text(html)).toContain('Zoom is using the mic');
    expect(buttons(html)).toEqual(['Take notes', 'Dismiss']);
  });

  it('says "Stop current note and start" while recording', () => {
    const html = render({ state: panelState([callDetectedCard()], { recording: true }) });
    expect(buttons(html)).toEqual(['Stop current note and start', 'Dismiss']);
  });
});

describe('PromptPanel: the stale calendar card', () => {
  it('says since when, with Dismiss only', () => {
    const html = render({ state: panelState([staleCard()]) });
    expect(text(html)).toContain('Calendar not updated since');
    expect(buttons(html)).toEqual(['Dismiss']);
  });
});

describe('PromptPanel: the whole panel', () => {
  it('draws nothing for no cards, and nothing before the first state', () => {
    expect(render({ state: panelState([]) })).toBe('');
    expect(render({ state: null })).toBe('');
  });

  it('stacks cards in the order main sent them', () => {
    const state = panelState([callDetectedCard(), calendarCard(), staleCard()]);
    const lines = text(render({ state }));
    expect(lines.indexOf('Zoom is using the mic')).toBeLessThan(lines.indexOf('Northwind renewal'));
    expect(lines.indexOf('Northwind renewal')).toBeLessThan(lines.indexOf('Calendar not updated'));
  });

  it('shows why the state could not be read, as an alert', () => {
    const html = render({ error: 'Could not read the prompt panel: untrusted sender' });
    expect(html).toContain('role="alert"');
    expect(text(html)).toContain('untrusted sender');
  });

  it('shows a click main refused on its own card', () => {
    const state = panelState([calendarCard()]);
    const html = render({ state, failures: { 'prompt-1': 'calendar.sqlite is read-only' } });
    expect(text(html)).toContain('Roger could not do that: calendar.sqlite is read-only');
  });
});
