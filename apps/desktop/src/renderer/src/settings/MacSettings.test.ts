import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LOGIN_ITEMS_SETTINGS_PATH } from '../../../shared/ipc/loginItem';
import type { CalendarSettingsState } from '../calendar/calendarSettingsStore';
import { plain, settingsState } from '../calendar/calendarTesting';
import { MacSettingsSection } from './MacSettings';

function render(settings: CalendarSettingsState = settingsState()): string {
  return plain(
    renderToStaticMarkup(
      createElement(MacSettingsSection, {
        settings,
        actions: { choose: vi.fn(() => Promise.resolve()) },
        onOpenSetup: vi.fn(),
      }),
    ),
  );
}

describe('the Mac section of Settings', () => {
  it('is a titled section of label and control rows', () => {
    const html = render();
    expect(html).toMatch(/<section class="settings-section[^"]*"[^>]*aria-labelledby=/);
    expect(html).toContain('Mac</h2>');
    expect(html.match(/class="settings-row"/g)).toHaveLength(2);
  });

  it('offers Set up Roger as a secondary button: one more way in, not the page main action', () => {
    const html = render();
    expect(html).toContain('Check the microphone and call audio');
    expect(html).toMatch(/<button[^>]*data-variant="secondary"[^>]*>Open Set up Roger<\/button>/);
    expect(html).not.toContain('data-variant="primary"');
  });

  describe('open at login', () => {
    it('is a checkbox that is on for "on" and off for "off"', () => {
      const on = render(settingsState({ openAtLogin: 'on', loginItem: 'enabled' }));
      const off = render(settingsState({ openAtLogin: 'off' }));
      expect(on).toMatch(
        /<input type="checkbox" checked=""[^>]*\/><span[^>]*><span>Open Roger at login/,
      );
      expect(off).toMatch(/<input type="checkbox"[^>]*\/><span[^>]*><span>Open Roger at login/);
      expect(off).not.toMatch(/checked=""[^>]*\/><span[^>]*><span>Open Roger at login/);
    });

    it('says where to allow Roger when macOS waits for approval', () => {
      const html = render(settingsState({ openAtLogin: 'on', loginItem: 'requires-approval' }));
      expect(html).toContain(LOGIN_ITEMS_SETTINGS_PATH.replace('&', '&amp;'));
      expect(html).toContain('data-login-item="requires-approval"');
    });

    // The long helper is for the one case that needs it (redesign R6): macOS waiting on a click.
    it('says nothing under the switch when macOS has nothing to ask', () => {
      for (const loginItem of ['enabled', 'disabled', null] as const) {
        const html = render(settingsState({ openAtLogin: 'on', loginItem }));
        expect(html).not.toContain('data-login-item');
      }
    });

    it('is switched off, with what to do, in a copy that cannot register a login item', () => {
      const html = render(settingsState({ loginItem: 'unavailable' }));
      expect(html).toMatch(/<input type="checkbox"[^>]*disabled=""/);
      expect(html).toContain('Applications folder');
      expect(html).not.toMatch(/development|this copy/i);
    });

    it('says why macOS could not be asked', () => {
      expect(render(settingsState({ loginItemError: 'macOS did not answer' }))).toContain(
        'Roger could not ask macOS about it: macOS did not answer',
      );
    });

    it('shows a refused save', () => {
      expect(
        render(settingsState({ saveError: 'Roger could not save that setting: no' })),
      ).toContain('Roger could not save that setting: no');
    });
  });

  it('keeps the setup row while the settings are still loading, and shows no switch', () => {
    const html = render(settingsState({ status: 'loading' }));
    expect(html).toContain('Open Set up Roger');
    expect(html).not.toContain('type="checkbox"');
  });
});
