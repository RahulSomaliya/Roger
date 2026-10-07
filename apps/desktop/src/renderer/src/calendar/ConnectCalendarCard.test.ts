import { createElement, isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ConnectCalendarCard } from './ConnectCalendarCard';

describe('ConnectCalendarCard', () => {
  const card = (fields: { connecting?: boolean; error?: string | null } = {}) =>
    renderToStaticMarkup(
      createElement(ConnectCalendarCard, {
        connecting: fields.connecting ?? false,
        error: fields.error ?? null,
        onConnect: vi.fn(),
      }),
    );

  it('is one secondary button and one helper line: what it gives, and that Roger opens at login', () => {
    const html = card();
    expect(html).toContain('>Connect Google Calendar</button>');
    expect(html).not.toContain('data-variant="primary"');
    expect(html).not.toContain('<h2');
    expect(html.match(/<p /g)).toHaveLength(1);
    expect(html).toContain('opens at login');
    expect(html).toContain('only reads your calendar');
  });

  it('says it waits for the browser instead, and keeps the button', () => {
    const html = card({ connecting: true });
    expect(html).toContain('Finish signing in in your browser. Roger waits up to 3 minutes.');
    expect(html).toContain('>Connect Google Calendar</button>');
    expect(html).not.toContain('only reads your calendar');
  });

  it('shows why the last connect failed as an alert problem line', () => {
    const html = card({ error: 'Tick the calendar box' });
    expect(html).toMatch(
      /class="problem" role="alert"><svg[^]*Roger could not connect Google Calendar: Tick the calendar box/,
    );
  });

  it('connects when the button is pressed', () => {
    const onConnect = vi.fn();
    const element = ConnectCalendarCard({ connecting: false, error: null, onConnect });
    // The section's first child holds the button, then the helper line.
    const row = isValidElement<{ children: unknown[] }>(element)
      ? (element.props.children[0] as { props: { children: unknown[] } })
      : null;
    const button = row?.props.children[0];
    expect(isValidElement<{ onClick: () => void }>(button)).toBe(true);
    (button as { props: { onClick: () => void } }).props.onClick();
    expect(onConnect).toHaveBeenCalledOnce();
  });
});
