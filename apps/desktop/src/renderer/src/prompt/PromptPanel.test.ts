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
      onAct: () => undefined,
      ...props,
    }),
  );

const buttons = (html: string): string[] =>
  [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((match) => text(match[1] ?? ''));

/** The labels of the buttons that carry the accent fill. */
const primaries = (html: string): string[] =>
  [...html.matchAll(/<button[^>]*data-variant="primary"[^>]*>(.*?)<\/button>/g)].map((match) =>
    text(match[1] ?? ''),
  );

describe('PromptPanel: a calendar card', () => {
  const html = render({ state: panelState([calendarCard()]) });

  it('shows when it starts, the title and the time range, and no guest line', () => {
    const lines = text(html);
    expect(lines).toContain('Starting in 1 min');
    expect(lines).toContain('Northwind renewal');
    expect(lines).toMatch(/\d{1,2}:\d{2}.*\u2013.*\d{1,2}:\d{2} (am|pm)/);
    expect(lines).not.toContain('Jane');
    expect(html).not.toContain('prompt-attendees');
  });

  it('offers Join and start notes, Start notes and Dismiss, and nothing to copy', () => {
    expect(buttons(html)).toEqual(['Join and start notes', 'Start notes', 'Dismiss']);
  });

  it('has exactly one primary: Join with a link, Start notes without one', () => {
    expect(primaries(html)).toEqual(['Join and start notes']);
    for (const videoLink of [null, 'https://evil.example/join']) {
      const card = calendarCard([calendarEvent({ videoLink })]);
      const noLink = render({ state: panelState([card]) });
      expect(buttons(noLink)).toEqual(['Start notes', 'Dismiss']);
      expect(primaries(noLink)).toEqual(['Start notes']);
    }
  });

  it('keeps the button labels while a note records and says once what the start stops', () => {
    const state = panelState([calendarCard()], { recording: true, recordingTitle: 'Weekly sync' });
    const recording = render({ state });
    expect(buttons(recording)).toEqual(['Join and start notes', 'Start notes', 'Dismiss']);
    expect(text(recording)).toContain('Stops notes on Weekly sync');
    expect(text(recording).match(/Stops notes/g)).toHaveLength(1);
    expect(text(html)).not.toContain('Stops notes');
  });

  it('says it without a title while the recording has none yet', () => {
    const state = panelState([calendarCard()], { recording: true });
    expect(text(render({ state }))).toContain('Stops your current notes');
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

  it('gives two calls on one card a start action each, one primary and one Dismiss', () => {
    const second = calendarEvent({ id: 'event-2', title: 'Design crit', videoLink: null });
    const state = panelState([calendarCard([calendarEvent(), second])]);
    const two = render({ state });
    expect(buttons(two)).toEqual(['Join and start notes', 'Start notes', 'Start notes', 'Dismiss']);
    expect(text(two)).toContain('Design crit');
    // The earliest call's start leads; the second call's is outlined, not a second fill.
    expect(primaries(two)).toEqual(['Join and start notes']);
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

  it('shows why a start failed as a problem line with an icon, and keeps the buttons', () => {
    const state = panelState([
      calendarCard([calendarEvent()], { error: 'Roger could not reach the microphone' }),
    ]);
    const failed = render({ state });
    expect(failed).toMatch(/<p class="problem" role="alert"><svg/);
    expect(text(failed)).toContain('Roger could not reach the microphone');
    expect(buttons(failed)).toContain('Start notes');
  });
});

describe('PromptPanel: taking notes', () => {
  it('replaces the buttons with "Recording" and Open Roger, no primary', () => {
    const state = panelState([calendarCard([calendarEvent()], { phase: 'taking_notes' })]);
    const html = render({ state });
    expect(text(html)).toContain('Recording');
    expect(buttons(html)).toEqual(['Open Roger']);
    expect(primaries(html)).toEqual([]);
  });

  it('does the same for a call-detected card', () => {
    const state = panelState([callDetectedCard({ phase: 'taking_notes' })]);
    expect(buttons(render({ state }))).toEqual(['Open Roger']);
  });
});

describe('PromptPanel: a call-detected card', () => {
  it('says which app is using the microphone, with Start notes as the primary and Dismiss', () => {
    const html = render({ state: panelState([callDetectedCard()]) });
    expect(text(html)).toContain('Zoom is using the microphone');
    expect(buttons(html)).toEqual(['Start notes', 'Dismiss']);
    expect(primaries(html)).toEqual(['Start notes']);
  });

  it('keeps the label while recording and says what the start stops', () => {
    const state = panelState([callDetectedCard()], { recording: true, recordingTitle: 'Standup' });
    const html = render({ state });
    expect(buttons(html)).toEqual(['Start notes', 'Dismiss']);
    expect(text(html)).toContain('Stops notes on Standup');
  });
});

describe('PromptPanel: the whole panel', () => {
  it('draws nothing for no cards, and nothing before the first state', () => {
    expect(render({ state: panelState([]) })).toBe('');
    expect(render({ state: null })).toBe('');
  });

  it('stacks cards in the order main sent them', () => {
    const state = panelState([callDetectedCard(), calendarCard()]);
    const lines = text(render({ state }));
    expect(lines.indexOf('Zoom is using the microphone')).toBeLessThan(
      lines.indexOf('Northwind renewal'),
    );
  });

  it('shows why the state could not be read, as an alert on a card of its own', () => {
    const html = render({ error: 'Could not read the prompt panel: untrusted sender' });
    expect(html).toContain('role="alert"');
    expect(html).toContain('class="prompt-card"');
    expect(text(html)).toContain('untrusted sender');
  });

  it('shows a click main refused on its own card', () => {
    const state = panelState([calendarCard()]);
    const html = render({ state, failures: { 'prompt-1': 'calendar.sqlite is read-only' } });
    expect(text(html)).toContain('Roger could not do that: calendar.sqlite is read-only');
  });
});
