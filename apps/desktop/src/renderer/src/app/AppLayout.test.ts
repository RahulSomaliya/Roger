import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ThemeState } from '../theme/useTheme';
import { AppLayout } from './AppLayout';
import { HOME } from './router';
import type { Shell } from './ShellContext';

const theme = vi.hoisted(() => ({
  useTheme: vi.fn<() => ThemeState>(() => ({ preference: null, error: null })),
}));

vi.mock('../theme/useTheme', () => theme);

// Node has no window.roger for the real provider's capture view; the layout only reads the shell.
vi.mock('./ShellContext', () => ({ useShell: () => idleShell() }));

// The layout is checked without M5's calendar: its banner reads `window.roger` through a shared
// store, which Node lacks. What it shows is checked in the browser (e2e/m5-t13.qa.e2e.ts) and
// mounted in slots/m5-calendar.test.ts.
vi.mock('./slots/m5-calendar', () => ({ contributions: {} }));

function idleShell(): Shell {
  return {
    route: HOME,
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
  it('puts the theme preference on the page once, with useTheme', () => {
    renderToString(createElement(AppLayout));
    // Without the call nothing sets data-theme on <html>: Light or Dark in the preferences would
    // do nothing and the page would always follow macOS.
    expect(theme.useTheme).toHaveBeenCalledTimes(1);
  });

  it('shows why the theme preference could not be read above the page', () => {
    theme.useTheme.mockReturnValue({
      preference: null,
      error: 'Could not read the theme preference: prefs:get-all timed out',
    });
    const html = renderToString(createElement(AppLayout));
    expect(html).toMatch(
      /role="alert"[^>]*>Could not read the theme preference: prefs:get-all timed out</,
    );
  });
});
