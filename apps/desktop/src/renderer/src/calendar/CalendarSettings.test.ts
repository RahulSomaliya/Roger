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

describe('the Calendar section of Settings', () => {
  it('is a titled section', () => {
    const html = render();
    expect(html).toMatch(/<section[^>]*aria-labelledby="([^"]+)"/);
    expect(html).toContain('Calendar</h2>');
  });

  describe('the account', () => {
    it('shows the connected address with Disconnect', () => {
      const html = render();
      expect(html).toContain('Connected as <strong>you@example.com</strong>');
      expect(html).toContain('Disconnect</button>');
      expect(html).not.toContain('Reconnect');
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

    it('waits while a save is out', () => {
      expect(
        tag(
          render(calendarState(), settingsState({ saving: 'notice.text' })),
          /<select|class="calendar-select"/,
        ),
      ).toContain('disabled');
    });
  });

  describe('the notice', () => {
    it('shows the text and its buttons while the notice is on', () => {
      const html = render(calendarState(), settingsState({ noticeText: 'Recording this call.' }));
      expect(html).toContain('Recording this call.</textarea>');
      expect(html).toContain('Save notice</button>');
      expect(tag(html, /type="checkbox"[^>]*checked/)).toContain('checked');
    });

    it('hides the text with the notice off', () => {
      const html = render(calendarState(), settingsState({ noticeEnabled: false }));
      expect(html).not.toContain('<textarea');
      expect(html).not.toContain('Save notice');
    });

    it('has Save notice off until the text changes: the stored text is the draft', () => {
      expect(render()).toMatch(/<button[^>]*disabled=""[^>]*>Save notice<\/button>/);
    });

    it('limits the text to what the preference accepts, and can go back to the default', () => {
      const custom = render(calendarState(), settingsState({ noticeText: 'Mine' }));
      expect(custom).toContain('maxLength="1000"');
      expect(custom).toMatch(
        /<button type="button" class="btn" data-variant="secondary" data-size="sm">Use the default text</,
      );
      // The default text already in the box leaves nothing to reset.
      const stock = render(calendarState(), settingsState({ noticeText: DEFAULT_NOTICE_TEXT }));
      expect(stock).toMatch(/<button[^>]*disabled=""[^>]*>Use the default text</);
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
