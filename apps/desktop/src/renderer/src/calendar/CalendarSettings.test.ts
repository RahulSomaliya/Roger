import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_NOTICE_TEXT } from '../../../shared/calendarPrefs';
import { LOGIN_ITEMS_SETTINGS_PATH } from '../../../shared/ipc/loginItem';
import { CalendarSettingsSection, type CalendarSettingsActions } from './CalendarSettings';
import type { CalendarSettingsState } from './calendarSettingsStore';
import type { CalendarState } from './calendarStore';
import { calendarState, CONNECTION, NOW_MS, plain, settingsState } from './calendarTesting';

function actions(): CalendarSettingsActions {
  return {
    calendar: {
      connect: vi.fn(() => Promise.resolve()),
      disconnect: vi.fn(() => Promise.resolve()),
      reload: vi.fn(),
    },
    settings: { choose: vi.fn(() => Promise.resolve()), reload: vi.fn() },
  };
}

function render(
  calendar: CalendarState = calendarState(),
  settings: CalendarSettingsState = settingsState(),
): string {
  return plain(
    renderToStaticMarkup(
      createElement(CalendarSettingsSection, {
        calendar,
        settings,
        nowMs: NOW_MS,
        actions: actions(),
      }),
    ),
  );
}

/** The tag of the first input or select whose markup matches. */
function tag(html: string, pattern: RegExp): string {
  const found = new RegExp(`<(?:input|select|textarea|button)[^>]*${pattern.source}[^>]*>`).exec(
    html,
  );
  if (found === null) throw new Error(`no control matching ${pattern.source}`);
  return found[0];
}

/** How many accent-filled buttons the markup has: the view's one primary (docs/design.md). */
function primaries(html: string): number {
  return html.split('data-variant="primary"').length - 1;
}

describe('the Calendar section of Settings', () => {
  it('is a titled section: space and a hairline, not a card', () => {
    const html = render();
    expect(html).toMatch(/<section[^>]*aria-labelledby="([^"]+)"/);
    expect(html).toContain('Calendar</h2>');
    expect(html).toMatch(/<section class="settings-section /);
    expect(html).not.toContain('class="card');
  });

  describe('the account', () => {
    it('shows the connected address with Disconnect', () => {
      const html = render();
      expect(html).toContain('Connected as <strong>you@example.com</strong>');
      expect(html).toContain('Disconnect</button>');
      expect(html).not.toContain('Reconnect');
    });

    // docs/design.md, the one primary: Connect while no calendar is connected, otherwise none.
    it('has no primary button once connected, and Disconnect is a ghost', () => {
      const html = render();
      expect(primaries(html)).toBe(0);
      expect(html).toMatch(/data-variant="ghost"[^>]*>Disconnect</);
    });

    it('has Connect as the one primary while none is connected', () => {
      const html = render(calendarState({ connection: null }));
      expect(primaries(html)).toBe(1);
      expect(html).toMatch(/data-variant="primary"[^>]*>Connect Google Calendar</);
    });

    it('shows a Disconnect that is busy, not disabled: full colour, aria-disabled, its words changed', () => {
      const html = render(calendarState({ disconnecting: true }));
      expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Disconnecting…</);
      expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Disconnecting…</);
    });

    it('offers Connect while none is connected', () => {
      const html = render(calendarState({ connection: null }));
      expect(html).toContain('No calendar connected.');
      expect(html).toContain('Connect Google Calendar</button>');
      expect(html).not.toContain('Disconnect');
    });

    it('offers Reconnect once Google refused the grant', () => {
      const html = render(
        calendarState({ connection: { ...CONNECTION, status: 'reconnect_required' } }),
      );
      expect(html).toContain('Reconnect Google Calendar</button>');
      // The refused grant is the one thing to do here, so it takes the one primary.
      expect(primaries(html)).toBe(1);
      expect(html).toMatch(/data-variant="primary"[^>]*>Reconnect Google Calendar</);
    });

    it('says Connect Google Calendar, not "Open Google again", while it waits for the browser', () => {
      const html = render(calendarState({ connection: null, connecting: true }));
      expect(html).toContain('Connect Google Calendar</button>');
      expect(html).not.toContain('Open Google again');
      expect(html).toContain('Finish signing in in your browser.');
    });

    it('says why a connect or a disconnect failed, and that a failed disconnect left it connected', () => {
      const html = render(
        calendarState({
          connectError: 'Tick the calendar box',
          disconnectError: 'Google did not answer',
        }),
      );
      expect(html).toContain('Roger could not connect Google Calendar: Tick the calendar box');
      expect(html).toContain(
        'Roger could not disconnect Google Calendar: Google did not answer. Your calendar is still connected.',
      );
    });

    it('draws a problem as an icon and a sentence: the alert role, no box, no red', () => {
      const html = render(calendarState({ connectError: 'Tick the calendar box' }));
      expect(html).toMatch(/<div class="problem" role="alert"><svg[^>]*aria-hidden="true"/);
      expect(html).not.toContain('class="error');
    });

    it('says it cannot read the connection, with Try again, instead of "no calendar connected"', () => {
      const html = render(calendarState({ connection: null, connectionStatus: 'failed' }));
      expect(html).toContain('Roger could not read the connection.');
      expect(html).toContain('Try again</button>');
      expect(html).not.toContain('Connect Google Calendar');
    });
  });

  describe('the reminder', () => {
    it('offers every lead time the preferences allow, with the stored one chosen', () => {
      const html = render(calendarState(), settingsState({ reminderLeadMinutes: 5 }));
      expect(html).toContain('When the meeting starts</option>');
      expect(html).toContain('1 minute before</option>');
      expect(html).toContain('10 minutes before</option>');
      expect(html).toMatch(/<option value="5" selected="">5 minutes before<\/option>/);
    });

    // The notice box saves on blur, and a blur comes before the click that caused it: a control
    // that went disabled while that save was out would swallow the click (the next switch, Use
    // the default text).
    it('never waits on a save: no control goes disabled, so no click is lost', () => {
      const html = render();
      expect(tag(html, /class="settings-input calendar-select"/)).not.toContain('disabled');
      expect(tag(html, /type="checkbox"/)).not.toContain('disabled');
    });
  });

  describe('the notice', () => {
    it('shows the text while the notice is on, with no Save button: it saves on blur', () => {
      const html = render(calendarState(), settingsState({ noticeText: 'Recording this call.' }));
      expect(html).toContain('Recording this call.</textarea>');
      expect(tag(html, /type="checkbox"[^>]*checked/)).toContain('checked');
      expect(html).not.toContain('Save notice');
    });

    it('describes only the Copy notice button the meeting page has', () => {
      const html = render();
      expect(html).toContain('The meeting page gets a Copy notice button');
      expect(html).not.toContain('The reminder and the meeting page');
    });

    it('hides the text with the notice off', () => {
      const html = render(calendarState(), settingsState({ noticeEnabled: false }));
      expect(html).not.toContain('<textarea');
      expect(html).not.toContain('Use the default text');
    });

    it('limits the text to what the preference accepts', () => {
      const html = render(calendarState(), settingsState({ noticeText: 'Mine' }));
      expect(html).toContain('maxLength="1000"');
    });

    it('offers the default text, as a ghost, only when the text differs from it', () => {
      const custom = render(calendarState(), settingsState({ noticeText: 'Mine' }));
      expect(custom).toMatch(
        /<button type="button" class="btn" data-variant="ghost" data-size="sm">Use the default text</,
      );
      // The default text already in the box leaves nothing to reset: the button is not there.
      const stock = render(calendarState(), settingsState({ noticeText: DEFAULT_NOTICE_TEXT }));
      expect(stock).not.toContain('Use the default text');
    });
  });

  describe('open at login', () => {
    it('is a checkbox that is on for "on" and off for "off"', () => {
      const on = render(
        calendarState(),
        settingsState({ openAtLogin: 'on', loginItem: 'enabled' }),
      );
      const off = render(calendarState(), settingsState({ openAtLogin: 'off' }));
      expect(on).toMatch(
        /<input type="checkbox" checked=""[^>]*\/><span[^>]*><span>Open Roger at login/,
      );
      expect(off).toMatch(/<input type="checkbox"[^>]*\/><span[^>]*><span>Open Roger at login/);
      expect(off).not.toMatch(/checked=""[^>]*\/><span[^>]*><span>Open Roger at login/);
    });

    it('says where to allow Roger when macOS waits for approval', () => {
      const html = render(
        calendarState(),
        settingsState({ openAtLogin: 'on', loginItem: 'requires-approval' }),
      );
      expect(html).toContain(LOGIN_ITEMS_SETTINGS_PATH.replace('&', '&amp;'));
      expect(html).toContain('data-login-item="requires-approval"');
    });

    // The long helper is for the one case that needs it (redesign R6): macOS waiting on a click.
    it('says nothing under the switch when macOS has nothing to ask', () => {
      for (const loginItem of ['enabled', 'disabled', null] as const) {
        const html = render(calendarState(), settingsState({ openAtLogin: 'on', loginItem }));
        expect(html).not.toContain('data-login-item');
        expect(html).not.toContain('Roger opens when you log in');
        expect(html).not.toContain('Roger opens only when you open it');
      }
    });

    it('is switched off, with the reason, in a build that never registers a login item', () => {
      const html = render(calendarState(), settingsState({ loginItem: 'unavailable' }));
      expect(html).toMatch(/<input type="checkbox"[^>]*disabled=""/);
      expect(html).toContain('Not available in this copy of Roger');
    });

    it('says why macOS could not be asked', () => {
      expect(
        render(calendarState(), settingsState({ loginItemError: 'macOS did not answer' })),
      ).toContain('Roger could not ask macOS about it: macOS did not answer');
    });
  });

  describe('when the settings are not there yet', () => {
    it('says it is loading, and shows no controls', () => {
      const html = render(calendarState(), settingsState({ status: 'loading' }));
      expect(html).toContain('Loading the calendar settings');
      expect(html).not.toContain('Remind me');
    });

    it('says why they could not be read, with Try again', () => {
      const html = render(
        calendarState(),
        settingsState({ status: 'failed', error: 'preferences.json is unreadable' }),
      );
      expect(html).toContain(
        'Roger could not read the calendar settings: preferences.json is unreadable',
      );
      expect(html).not.toContain('Remind me');
    });

    it('shows why a save failed', () => {
      expect(
        render(
          calendarState(),
          settingsState({ saveError: 'Roger could not save that setting: notice.text is blank' }),
        ),
      ).toContain('Roger could not save that setting: notice.text is blank');
    });
  });
});
