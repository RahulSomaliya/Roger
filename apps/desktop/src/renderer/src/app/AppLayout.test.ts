import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThemeState } from '../theme/useTheme';
import { AppLayout } from './AppLayout';
import { HOME, type Route } from './router';
import type { Shell } from './ShellContext';

const theme = vi.hoisted(() => ({
  useTheme: vi.fn<() => ThemeState>(() => ({ preference: null, error: null })),
}));
const fakes = vi.hoisted((): { route: Route } => ({ route: { name: 'home' } }));

vi.mock('../theme/useTheme', () => theme);

// Node has no window.roger for the real provider's capture view; the layout only reads the shell.
vi.mock('./ShellContext', () => ({ useShell: () => idleShell(fakes.route) }));

// The pages read `window.roger` (Home's calendar and list, Settings' preferences, Set up Roger's
// probes); their own tests cover them. The layout is only the header, the banner and the route.
vi.mock('./HomePage', () => ({ HomePage: () => null }));
vi.mock('./SettingsPage', () => ({ SettingsPage: () => null }));
vi.mock('./SetupRoute', () => ({ SetupRoute: () => null }));

// The layout is checked without M5's calendar: its banner reads `window.roger` through a shared
// store, which Node lacks. What it shows is checked in the browser (e2e/m5-t13.qa.e2e.ts) and
// mounted in slots/m5-calendar.test.ts.
vi.mock('./slots/m5-calendar', () => ({ contributions: {} }));

function idleShell(route: Route): Shell {
  return {
    route,
    navigate: vi.fn(),
    capture: {
      status: null,
      lastMeetingId: null,
      localError: null,
      busy: false,
      start: vi.fn(),
      stop: vi.fn(),
    },
    captureMeeting: null,
    startNewNote: vi.fn(),
    stopRecording: vi.fn(),
    actionError: null,
  };
}

describe('AppLayout', () => {
  beforeEach(() => {
    fakes.route = HOME;
  });

  it('puts the theme preference on the page once, with useTheme', () => {
    renderToString(createElement(AppLayout));
    // Without the call nothing sets data-theme on <html>: Light or Dark in the preferences would
    // do nothing and the page would always follow macOS.
    expect(theme.useTheme).toHaveBeenCalledTimes(1);
  });

  it('shows the slim header on Home and Settings: no sidebar', () => {
    for (const route of [HOME, { name: 'settings' } as const]) {
      fakes.route = route;
      const html = renderToString(createElement(AppLayout));
      expect(html).toContain('class="app-header"');
      expect(html).not.toContain('sidebar');
    }
  });

  it('leaves the header off the setup route, which fills the window', () => {
    fakes.route = { name: 'setup' };
    expect(renderToString(createElement(AppLayout))).not.toContain('app-header');
  });

  it('tells the shell which route it shows, so the meeting page gets its wider column', () => {
    fakes.route = { name: 'meeting', meetingId: '5c1d7a4e-2f3b-4c8a-9e61-0d2b7f4a9c13' };
    expect(renderToString(createElement(AppLayout))).toContain('data-route="meeting"');
  });
});
