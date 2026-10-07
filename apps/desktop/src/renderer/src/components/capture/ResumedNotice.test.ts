import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CaptureNotice } from '../../../../shared/capture';
import { formatClockTime } from '../../app/labels';
import { findResumeNotice, ResumedNotice } from './ResumedNotice';

const RESUMED: CaptureNotice = {
  kind: 'resumed-after-crash',
  source: null,
  at: '2026-10-07T09:00:00.000Z',
  message: 'Roger restarted and kept taking notes',
};
const SWITCHED: CaptureNotice = {
  kind: 'device-switched',
  source: 'mic',
  at: '2026-10-07T09:05:00.000Z',
  message: 'Switched to AirPods Pro',
};

describe('findResumeNotice', () => {
  it('finds the crash resume among the notices, and nothing otherwise', () => {
    expect(findResumeNotice([SWITCHED, RESUMED])).toBe(RESUMED);
    expect(findResumeNotice([SWITCHED])).toBeNull();
    expect(findResumeNotice(undefined)).toBeNull();
  });
});

describe('ResumedNotice', () => {
  const render = (busy = false): string =>
    renderToStaticMarkup(createElement(ResumedNotice, { notice: RESUMED, busy, onStop: vi.fn() }));

  it("says main's words and when, with a Stop button the resume promised (D7)", () => {
    const html = render();
    expect(html).toContain('Roger restarted and kept taking notes');
    expect(html).toContain(`at ${formatClockTime(RESUMED.at)}`);
    expect(html).toContain('>Stop recording<');
  });

  it('is a polite status, never an alert: Roger recovered, nothing is lost', () => {
    const html = render();
    expect(html).toContain('role="status"');
    expect(html).not.toContain('role="alert"');
  });

  it('disables Stop while a start or stop is under way', () => {
    expect(render(true)).toMatch(/<button[^>]*disabled=""/);
    expect(render(false)).not.toContain('disabled');
  });
});
