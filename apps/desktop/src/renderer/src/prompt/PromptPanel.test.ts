import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PromptPanel, type PromptPanelProps } from './PromptPanel';
import {
  PANEL_NOW,
  callDetectedCard,
  calendarCard,
  calendarEvent,
  panelState,
} from './promptTesting';

/** renderToString puts <!-- --> between adjacent text pieces, and escapes an apostrophe. */
const text = (html: string): string =>
  html
    .replace(/<!-- -->/g, '')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&#x27;/g, "'")
    .replace(/\n+/g, '\n')
    .trim();

const render = (props: Partial<PromptPanelProps>): string =>
  renderToStaticMarkup(
    createElement(PromptPanel, {
      state: null,
      readFailed: false,
      nowMs: PANEL_NOW,
      failed: new Set<string>(),
      leaving: new Set<string>(),
      onAct: () => undefined,
      onLeft: () => undefined,
      ...props,
    }),
  );

/** The buttons' names in document order: their text, or the aria-label of an icon-only one. */
const buttons = (html: string): string[] =>
  [...html.matchAll(/<button([^>]*)>(.*?)<\/button>/g)].map(
    ([, attributes = '', inner = '']) =>
      /aria-label="([^"]*)"/.exec(attributes)?.[1] ?? text(inner),
  );

/** The labels of the buttons that carry the accent fill. */
const primaries = (html: string): string[] =>
  [...html.matchAll(/<button[^>]*data-variant="primary"[^>]*>(.*?)<\/button>/g)].map((match) =>
    text(match[1] ?? ''),
  );

const START_NOTES = ['Join and start notes', 'Start notes'];

describe('PromptPanel: a calendar card', () => {
  const html = render({ state: panelState([calendarCard()]) });

  it("names Roger and the wait, then the title and the hours in Home's form, no guest line", () => {
    const lines = text(html);
    expect(lines).toContain('Roger \u00b7 Starting in 1 min');
    expect(lines).toContain('Northwind renewal');
    expect(lines).toMatch(/\d{1,2}:\d{2} (am|pm) to \d{1,2}:\d{2} (am|pm)/);
    expect(lines).not.toContain('\u2013');
    expect(lines).not.toContain('Jane');
  });

  it('offers Join and start notes, Start notes and an x named Dismiss, and nothing to copy', () => {
    expect(buttons(html)).toEqual(['Dismiss', ...START_NOTES]);
  });

  it('draws Dismiss as an icon button with a name and a tooltip, not as a word', () => {
    const dismiss = /<button[^>]*aria-label="Dismiss"[^>]*>(.*?)<\/button>/.exec(html);
    expect(dismiss?.[0]).toContain('title="Dismiss"');
    expect(dismiss?.[1]).toMatch(/^<svg/);
    expect(text(dismiss?.[1] ?? '')).toBe('');
  });

  it('has exactly one primary: Join with a link, Start notes without one', () => {
    expect(primaries(html)).toEqual(['Join and start notes']);
    for (const videoLink of [null, 'https://evil.example/join']) {
      const card = calendarCard([calendarEvent({ videoLink })]);
      const noLink = render({ state: panelState([card]) });
      expect(buttons(noLink)).toEqual(['Dismiss', 'Start notes']);
      expect(primaries(noLink)).toEqual(['Start notes']);
    }
  });

  it('keeps the labels while a note records and says once, under the buttons, what a start stops', () => {
    const state = panelState([calendarCard()], { recording: true, recordingTitle: 'Weekly sync' });
    const recording = render({ state });
    expect(buttons(recording)).toEqual(['Dismiss', ...START_NOTES]);
    expect(text(recording)).toContain('Stops notes on Weekly sync');
    expect(text(recording).match(/Stops notes/g)).toHaveLength(1);
    expect(recording.indexOf('Stops notes')).toBeGreaterThan(recording.lastIndexOf('Start notes'));
    expect(text(html)).not.toContain('Stops notes');
  });

  it('says it without a title while the recording has none yet', () => {
    const state = panelState([calendarCard()], { recording: true });
    expect(text(render({ state }))).toContain('Stops your current notes');
  });

  it('names a title-less invite as its meeting will be, and shows a long title whole for CSS to clamp', () => {
    const blank = text(
      render({ state: panelState([calendarCard([calendarEvent({ title: '' })])]) }),
    );
    expect(blank).toMatch(/Meeting at \d{1,2}:\d{2} (am|pm)/);
    expect(blank).not.toContain('Untitled');
    const long = 'Quarterly business review and roadmap alignment with every regional lead '
      .repeat(3)
      .trim();
    expect(
      text(render({ state: panelState([calendarCard([calendarEvent({ title: long })])]) })),
    ).toContain(long);
  });

  it('gives two calls on one card one overline, a start action each, one primary and one Dismiss', () => {
    const second = calendarEvent({ id: 'event-2', title: 'Design crit', videoLink: null });
    const state = panelState([calendarCard([calendarEvent(), second])]);
    const two = render({ state });
    expect(buttons(two)).toEqual(['Dismiss', ...START_NOTES, 'Start notes']);
    expect(text(two)).toContain('Design crit');
    expect(text(two).match(/Roger \u00b7/g)).toHaveLength(1);
    // The earliest call's start leads; the second call's is outlined, not a second fill.
    expect(primaries(two)).toEqual(['Join and start notes']);
    expect(two.match(/class="prompt-event"/g)).toHaveLength(2);
  });

  it('keeps one primary across stacked cards: only the first card leads', () => {
    const later = calendarEvent({ id: 'event-3', title: 'Design crit', videoLink: null });
    const state = panelState([
      calendarCard(),
      calendarCard([later], { id: 'prompt-4' }),
      callDetectedCard(),
    ]);
    expect(primaries(render({ state }))).toEqual(['Join and start notes']);
  });

  it("puts a failed start's reason before the buttons, as a problem line with an icon", () => {
    const state = panelState([
      calendarCard([calendarEvent()], {
        error: 'Roger could not start notes from here. Try again.',
      }),
    ]);
    const failed = render({ state });
    expect(failed).toMatch(/<p class="problem" role="alert"><svg/);
    expect(text(failed)).toContain('Roger could not start notes from here. Try again.');
    expect(failed.indexOf('class="problem"')).toBeLessThan(failed.indexOf('Start notes'));
    expect(failed.indexOf('class="problem"')).toBeGreaterThan(failed.indexOf(' to '));
    expect(buttons(failed)).toContain('Start notes');
  });

  it('puts the reason of a card of two calls under the overline, before both calls', () => {
    const second = calendarEvent({ id: 'event-2', title: 'Design crit', videoLink: null });
    const state = panelState([
      calendarCard([calendarEvent(), second], {
        error: 'Roger is still starting your last notes.',
      }),
    ]);
    const failed = render({ state });
    expect(failed.indexOf('class="problem"')).toBeLessThan(failed.indexOf('>Northwind renewal<'));
  });
});

describe('PromptPanel: taking notes', () => {
  it('replaces the card with one row: the dot, "Recording", the title, and Open Roger', () => {
    const state = panelState([calendarCard([calendarEvent()], { phase: 'taking_notes' })]);
    const html = render({ state });
    expect(text(html)).toMatch(/Recording\n\u00b7 Northwind renewal/);
    expect(buttons(html)).toEqual(['Open Roger']);
    expect(primaries(html)).toEqual([]);
    expect(text(html)).not.toContain('Roger \u00b7');
    expect(html).not.toContain('Dismiss');
  });

  it('names the call that started when a card held two', () => {
    const second = calendarEvent({ id: 'event-2', title: 'Design crit', videoLink: null });
    const state = panelState([
      calendarCard([calendarEvent(), second], { phase: 'taking_notes', startedEventId: 'event-2' }),
    ]);
    const lines = text(render({ state }));
    expect(lines).toContain('\u00b7 Design crit');
    expect(lines).not.toContain('Northwind');
  });

  it('does the same for a call-detected card', () => {
    const state = panelState([callDetectedCard({ phase: 'taking_notes' })]);
    const html = render({ state });
    expect(buttons(html)).toEqual(['Open Roger']);
    expect(text(html)).toContain('\u00b7 Call in Zoom');
  });
});

describe('PromptPanel: a call-detected card', () => {
  it('says "Roger \u00b7 Now" and "Call in Zoom", with Start notes as the primary and Dismiss', () => {
    const html = render({ state: panelState([callDetectedCard()]) });
    const lines = text(html);
    expect(lines).toContain('Roger \u00b7 Now');
    expect(lines).toContain('Call in Zoom');
    expect(lines).not.toContain('microphone');
    expect(buttons(html)).toEqual(['Dismiss', 'Start notes']);
    expect(primaries(html)).toEqual(['Start notes']);
  });

  it('keeps the label while recording and says what the start stops', () => {
    const state = panelState([callDetectedCard()], { recording: true, recordingTitle: 'Standup' });
    const html = render({ state });
    expect(buttons(html)).toEqual(['Dismiss', 'Start notes']);
    expect(text(html)).toContain('Stops notes on Standup');
  });
});

describe('PromptPanel: the whole panel', () => {
  it('draws nothing for no cards, and nothing before the first state', () => {
    expect(render({ state: panelState([]) })).toBe('');
    expect(render({ state: null })).toBe('');
  });

  it('stacks cards in the order main sent them: the newest first', () => {
    const state = panelState([callDetectedCard(), calendarCard()]);
    const lines = text(render({ state }));
    expect(lines.indexOf('Call in Zoom')).toBeLessThan(lines.indexOf('Northwind renewal'));
  });

  it('says plainly that it could not show the reminder, as an alert on a card of its own', () => {
    const html = render({ readFailed: true });
    expect(html).toContain('role="alert"');
    expect(html).toContain('class="prompt-card"');
    expect(text(html)).toBe('Roger could not show this reminder.');
  });

  it('says a refused click plainly, never with the text of what main threw', () => {
    const state = panelState([calendarCard()]);
    const html = render({ state, failed: new Set(['prompt-1']) });
    expect(text(html)).toContain('Roger could not do that. Try again.');
    expect(html).not.toContain('calendar.sqlite');
  });

  it('shows no text of a failure: nothing here can carry "xAI: rejected with HTTP 401"', () => {
    // The panel's inputs hold no thrown text any more: a flag for the read, ids for the clicks.
    const html = render({
      state: panelState([calendarCard()]),
      readFailed: true,
      failed: new Set(['prompt-1']),
    });
    expect(text(html)).not.toMatch(/HTTP|xAI|invoking remote method|sqlite/i);
  });

  it('keeps a leaving card drawn, marked, and out of reach of clicks and the keyboard', () => {
    const state = panelState([calendarCard()]);
    const html = render({ state, leaving: new Set(['prompt-1']) });
    expect(html).toMatch(/<section[^>]*data-leaving="true"/);
    expect(html).toMatch(/<section[^>]*inert=""/);
    expect(text(html)).toContain('Northwind renewal');
  });

  it('gives the lead (the one primary) to the first card that is not leaving', () => {
    const state = panelState([
      callDetectedCard({ id: 'gone' }),
      calendarCard([calendarEvent()], { id: 'stays' }),
    ]);
    const html = render({ state, leaving: new Set(['gone']) });
    expect(primaries(html)).toEqual(['Join and start notes']);
  });
});
