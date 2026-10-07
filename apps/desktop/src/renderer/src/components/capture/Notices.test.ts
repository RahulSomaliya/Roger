import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CaptureNotice } from '../../../../shared/capture';
import { formatClockTime } from '../../app/labels';
import { Notices, noticesToShow } from './Notices';

const switched = (device: string, at: string): CaptureNotice => ({
  kind: 'device-switched',
  source: 'mic',
  at,
  message: `Switched to ${device}`,
});

const RESTARTED: CaptureNotice = {
  kind: 'helper-restarted',
  source: 'system',
  at: '2026-10-07T09:12:00.000Z',
  message: 'Roger restarted the call audio helper (once this recording); call audio is back.',
};

const RESUMED: CaptureNotice = {
  kind: 'resumed-after-crash',
  source: null,
  at: '2026-10-07T09:00:00.000Z',
  message: 'Roger restarted and kept taking notes',
};

const render = (notices: CaptureNotice[]): string =>
  renderToStaticMarkup(createElement(Notices, { notices }));

describe('noticesToShow', () => {
  it('keeps the latest of each kind and stream, newest first, counting the earlier ones', () => {
    const shown = noticesToShow([
      switched('AirPods Pro', '2026-10-07T09:05:00.000Z'),
      RESTARTED,
      switched('MacBook Pro Microphone', '2026-10-07T09:20:00.000Z'),
      switched('AirPods Pro', '2026-10-07T09:31:00.000Z'),
    ]);
    expect(shown.map(({ notice, times }) => [notice.message, times])).toEqual([
      ['Switched to AirPods Pro', 3],
      [RESTARTED.message, 1],
    ]);
  });

  it("leaves the crash resume to M2-T20b's notice, which carries its Stop button", () => {
    expect(noticesToShow([RESUMED])).toEqual([]);
  });
});

describe('Notices', () => {
  it('says what Roger recovered from and when, quietly', () => {
    const html = render([RESTARTED, switched('AirPods Pro', '2026-10-07T09:31:00.000Z')]);
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain('role="alert"');
    expect(html).toContain('Switched to AirPods Pro');
    expect(html).toContain(`at ${formatClockTime('2026-10-07T09:31:00.000Z')}`);
    expect(html).toContain(RESTARTED.message);
    // The device switch is newer, so it comes first.
    expect(html.indexOf('Switched to')).toBeLessThan(html.indexOf('call audio helper'));
  });

  it('counts a device that switched again and again, rather than listing every switch', () => {
    const html = render([
      switched('AirPods Pro', '2026-10-07T09:05:00.000Z'),
      switched('MacBook Pro Microphone', '2026-10-07T09:20:00.000Z'),
    ]);
    expect(html.match(/Switched to/g)).toHaveLength(1);
    expect(html).toContain('Switched to MacBook Pro Microphone');
    expect(html).toContain('2 times this recording');
  });

  it('shows nothing when Roger recovered from nothing', () => {
    expect(render([])).toBe('');
    expect(render([RESUMED])).toBe('');
  });
});
