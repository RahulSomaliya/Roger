import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CalendarNotice } from './calendarFormat';
import { CalendarStatusBannerView } from './CalendarStatusBanner';
import { plain } from './calendarTesting';

const stale: CalendarNotice = {
  kind: 'stale',
  text: 'Calendar not updated since 09:12',
  action: null,
};
const refused: CalendarNotice = {
  kind: 'reconnect-required',
  text: 'Google Calendar needs you to sign in again.',
  action: 'Reconnect Google Calendar',
};
const soon: CalendarNotice = {
  kind: 'reconnect-soon',
  text: 'Google will end Roger’s access to your calendar soon.',
  action: 'Reconnect before Wed 14 Oct',
};

function banner(
  notices: CalendarNotice[],
  fields: { connecting?: boolean; connectError?: string | null } = {},
): string {
  return plain(
    renderToStaticMarkup(
      createElement(CalendarStatusBannerView, {
        notices,
        connecting: fields.connecting ?? false,
        connectError: fields.connectError ?? null,
        onReconnect: vi.fn(),
      }),
    ),
  );
}

describe('CalendarStatusBanner', () => {
  it('renders nothing for a healthy calendar', () => {
    expect(banner([])).toBe('');
  });

  it('says the calendar is stale and since when, with no button: there is nothing to press', () => {
    const html = banner([stale]);
    expect(html).toContain('Calendar not updated since 09:12');
    expect(html).toContain('role="status"');
    expect(html).not.toContain('<button');
  });

  it('is an alert with a Reconnect button once Google refused the grant', () => {
    const html = banner([refused]);
    expect(html).toContain('role="alert"');
    expect(html).toContain('class="error calendar-banner"');
    expect(html).toContain('Reconnect Google Calendar</button>');
  });

  it('names the date on the reconnect button before the grant expires', () => {
    expect(banner([soon, stale])).toContain('Reconnect before Wed 14 Oct</button>');
  });

  it('says it waits for the browser, and shows why a reconnect failed', () => {
    const html = banner([refused], { connecting: true, connectError: 'Tick the calendar box' });
    expect(html).toContain('Open Google again</button>');
    expect(html).toContain('Roger could not reconnect Google Calendar: Tick the calendar box');
  });
});
